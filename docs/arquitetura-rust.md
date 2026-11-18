# Arquitetura do motor em Rust (`engine/`)

Este documento explica **só as escolhas de design do código Rust** do Mosaico do Tempo — o que cada módulo faz, por que ele existe do jeito que existe, e algumas lições aprendidas no caminho. Para o app como um todo (web, deploy, configuração), veja o [`README.md`](../README.md) na raiz do repositório.

O código Rust deste projeto é escrito de forma deliberadamente simples — laços `for` e `Vec` em vez de cadeias longas de iteradores, poucas abstrações genéricas — para ficar legível por alguém que está começando em Rust. As escolhas abaixo são sobre *arquitetura*, não sobre estilo de sintaxe.

## 1. Por que Rust/WebAssembly, e só onde isso ajuda

O motor (`engine/`) cuida de exatamente duas coisas que se beneficiam de um código compilado e de acesso direto à GPU:

1. **A memória temporal** (`memory.rs`): decidir quais capturas antigas ainda devem aparecer, com que opacidade, e por quanto tempo. É matemática simples, mas chamada toda hora, e precisa ser testável de forma isolada (ver seção 10).
2. **A composição visual na GPU** (`renderer.rs` + shaders): desenhar o reflexo, os ecos e o acumulador de rastro usando `wgpu` (WebGPU/WebGL2). Isso só é possível em Rust/C++/outras linguagens com bindings de GPU de baixo nível — não existe equivalente direto em JavaScript puro com o mesmo controle.

Tudo o que **não** se beneficia disso fica em TypeScript, de propósito: captura de câmera (`getUserMedia`), gerenciamento de canvases, orquestração da experiência, o painel de desenvolvimento. Mover isso para Rust exigiria expor bindings `web-sys` para APIs que o navegador já oferece de forma direta ao JavaScript — trabalho extra sem benefício real. A divisão de responsabilidades é: **Rust decide "o quê" e "quanto"; TypeScript decide "quando" e "onde na tela".**

## 2. Mapa dos módulos

```text
engine/
├── build.rs           # embute o hash do commit git no binário (seção 9)
├── Cargo.toml
└── src/
    ├── lib.rs          # fronteira com o JavaScript (wasm-bindgen) — seção 3
    ├── memory.rs       # memória temporal discreta (duas camadas) — seção 4
    ├── effects.rs       # configuração dos efeitos visuais, sem GPU — seção 5
    ├── renderer.rs      # Renderer wgpu/WGSL — seção 6
    └── shaders/
        ├── echo.wgsl         # deslocamento lateral de um eco (posição)
        ├── displacement.wgsl # campo de deslocamento orgânico (a "ondulação")
        ├── dissolve.wgsl     # máscara de dissolução fragmentada
        └── composite.wgsl    # shader principal: junta tudo, por modo de desenho
```

## 3. `lib.rs` — a fronteira com o JavaScript

`lib.rs` expõe uma única classe, `Engine`, via `#[wasm_bindgen]`. Duas decisões aqui valem explicação:

**O padrão "cache de índices".** Em vez de devolver uma lista de estruturas complexas para o JavaScript (o que exigiria serializar/desserializar objetos toda hora, caro no limite Rust↔Wasm↔JS), `Engine::update(now)` recalcula a lista de registros ativos internamente e a guarda (`active_cache`). O JavaScript então pergunta, um de cada vez e por índice: "qual a opacidade do registro 0?" (`activeOpacity(0)`), "qual a largura do registro 1?" (`activeWidth(1)`), etc. Cada "getter" é uma chamada Wasm trivial (um `f32` ou `u32` de volta), sem nenhuma estrutura para converter.

**`pub(crate) fn active_record`** não tem `#[wasm_bindgen]` — só o próprio `renderer.rs` (no mesmo crate Rust) usa essa função, para ler um `RenderRecord` inteiro de uma vez em vez de chamar vários getters separados. Evita cópias desnecessárias quando quem está lendo já é Rust.

**`layer_kind_from_str`** só aceita `"intermediate"` e `"long"` — não existe mais uma camada "curta" no sentido de `LayerKind`, porque o rastro de movimento recente virou o acumulador contínuo da GPU (seção 6), estruturalmente diferente das duas camadas discretas.

## 4. `memory.rs` — a memória temporal discreta

Cada camada (`MemoryLayer`) é um buffer circular simples (`Vec<MemoryRecord>`, capado em `config.capacity`): quando enche, o registro mais antigo (índice 0, porque sempre inserimos no fim) é descartado para abrir espaço.

Duas decisões matemáticas centrais:

- **Expiração por timestamp, nunca por contagem de frames.** `MemoryLayer::expire(now_ms)` compara `now_ms - record.timestamp_ms` contra `max_age_ms`. Isso significa que a duração de uma memória é sempre a mesma, em segundos reais, independente do FPS do aparelho — testado explicitamente em `expiration_is_independent_of_sampling_rate` (passa timestamps bem irregulares e confirma que só o tempo importa).
- **`capacity × capture_interval_ms` precisa ficar perto de `max_age_ms`.** Esta é a relação mais importante do arquivo, documentada em comentário direto em `LayerConfig::intermediate_default`/`long_default`. Se a capacidade for pequena demais para o intervalo de captura, um registro é **expulso do buffer por falta de espaço** antes de a curva de fade (`compute_fade`) ter feito ele desbotar de verdade — ele desaparece de repente, em vez de suavemente. Isso já aconteceu de verdade neste projeto: ao reduzir só a `capacity` (para desenhar menos ecos por quadro, ver seção 6), sem reduzir também `capture_interval_ms` na mesma proporção, cada registro passou a ser expulso ainda bem visível. A correção foi recalibrar `capture_interval_ms`, não reverter a capacidade.

**O efeito de "reaparecimentos ocasionais"** (`reappearance_strength`/`reappearance_frequency`) multiplica a opacidade por uma onda senoidal elevada ao cubo (`wave * wave * wave`), em vez de deixá-la só cair. Elevar ao cubo faz os picos da onda ficarem mais curtos e discretos — o objetivo é que a camada "prolongada" pareça um vestígio que "insiste e recua", não um ruído aleatório desconectado do que foi capturado. O teste `reappearance_pulse_creates_brighter_and_dimmer_moments` confirma, por amostragem ao longo de um ciclo, que a opacidade realmente sobe em algum ponto (não é só um fade decrescente).

O deslocamento lateral (`drift_amount`) usa seno/cosseno de uma "semente" derivada do próprio `timestamp_ms` do registro — não é aleatório de verdade, é sempre o mesmo valor para o mesmo registro. Isso é intencional: o deslocamento fica estável quadro a quadro, em vez de tremer.

## 5. `effects.rs` — configuração sem GPU

Este arquivo guarda só números (`EffectConfig`): intensidade/frequência/velocidade/amplitude do deslocamento, fragmentação da dissolução, piso de deslocamento dos ecos, ritmo e opacidade do acumulador de rastro. Ele não sabe nada sobre `wgpu`, shaders ou texturas — de propósito. Isso mantém `renderer.rs` (que já é denso por natureza, ver seção 6) livre de lógica artística misturada com código de GPU, e permite que `trail_decay_factor` (a única função com lógica real deste arquivo) seja testada com `cargo test` nativo, sem precisar de um navegador — ver seção 10.

## 6. `renderer.rs` — o Renderer wgpu/WGSL

É o arquivo mais denso do motor, porque GPU em qualquer linguagem exige descrever cada detalhe explicitamente (formato de textura, como misturar cores, etc. — a GPU não adivinha nada). Três ideias centrais:

### O acumulador de rastro, em vez de fotos empilhadas

A "memória curta" (rastro de movimento recente) não é uma lista de capturas discretas — é **uma textura só**, atualizada a cada quadro por `update_trail_accumulator`, num esquema de **ping-pong** entre duas texturas (`trail_front`/`trail_back`): o conteúdo antigo é desbotado (multiplicado por um fator de decaimento exponencial, `trail_decay_factor` de `effects.rs`) e desenhado na textura "back"; a captura nova é somada por cima; as duas texturas trocam de papel (`std::mem::swap`) para o próximo quadro. Isso é tanto mais orgânico visualmente (um rastro que persiste e desbota continuamente, em vez de uma pilha de fotos semitransparentes) quanto mais barato para a GPU (duas passagens de desenho fixas por quadro, em vez de uma por registro guardado).

Esse mesmo canal alfa da textura é reaproveitado como "campo de presença": o shader principal lê, no reflexo atual, o quanto de presença recente existe em cada ponto da tela, para deformar a amostragem só ali — "o passado deforma o presente" sem precisar desenhar nada visível por cima.

### `DrawUniforms` e o contrato com o WGSL

```rust
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct DrawUniforms { /* só campos f32 */ }
```

Essa struct precisa corresponder **campo a campo, na mesma ordem**, à struct `DrawUniforms` declarada em `composite.wgsl`. Não existe verificação do compilador entre as duas linguagens — `#[repr(C)]` só garante que o layout de memória do lado Rust é previsível; `bytemuck::Pod`/`Zeroable` permitem tratar a struct como bytes crus para mandar à GPU (`bytemuck::cast_slice`). Se os dois lados saírem de sincronia (um campo novo só de um lado, ou em ordem diferente), o resultado é um bug silencioso — a GPU lê os bytes certos, mas na posição errada, sem erro de compilação nenhum. Por isso, toda vez que um campo é adicionado a um dos dois lados (como `echo_displacement_floor` recentemente), ele precisa ser adicionado no outro, na mesma posição.

### `draw_quad` e a cor de limpeza (uma lição real sobre blend)

`draw_quad` desenha um retângulo cobrindo o alvo todo, com uma textura e um modo de mistura (`pipeline_alpha` ou `pipeline_additive`). Um bug real já aconteceu aqui, vale registrar como estudo de caso: existia só **uma** cor de limpeza (`CLEAR_COLOR`, opaca — pensada para a tela final, que não tem nada "atrás" dela). Essa mesma cor era reaproveitada para limpar `trail_back`, uma textura **intermediária** cujo canal alfa tem significado próprio (presença recente). A fórmula de mistura de alfa do `wgpu` (`BlendState::ALPHA_BLENDING`, componente alfa `OVER`) é `resultado = src.a + dst.a × (1 − src.a)` — com `dst.a` já em 1.0 (por causa da limpeza errada), o resultado dava sempre 1.0, **qualquer que fosse o conteúdo real**. O acumulador de rastro ficava com o canal alfa travado em "presença em toda a tela", sempre.

A correção: duas constantes de cor de limpeza, não uma — `CLEAR_COLOR` (opaca, só para o framebuffer final) e `CLEAR_COLOR_TRANSPARENT` (alfa 0.0, para texturas intermediárias) — e `draw_quad` passou a receber `Option<wgpu::Color>` em vez de um booleano, para que quem chama escolha explicitamente a cor certa para o alvo específico. A lição geral: **"limpar para uma cor de fundo" não é uma operação neutra quando o alvo não é a tela final** — o significado do canal alfa de cada textura intermediária precisa ser respeitado na hora de zerá-la.

Nenhum teste automatizado cobria esse bug: `renderer.rs` só compila para `wasm32` (fora do alcance do `cargo test` nativo — ver seção 10), e a validação de WGSL (`naga`) só confere sintaxe/tipos, não configuração de blend, que é Rust puro do lado da CPU.

## 6.1. O rastro "profundo" e a distorção de Solaris

O rastro descrito na seção 6 (uma textura só, em ping-pong) resolve "um vestígio que persiste e desbota continuamente" — mas desbotar continuamente, não importa quão lento, sempre tende a zero. Um pedido de direção artística posterior foi: o rastro não deveria se apagar de verdade, deveria oscilar — desaparecer e voltar, "tal qual o passado" — e a distorção do rastro deveria ficar pesada e viscosa, "como o mar de Solaris" (Tarkovsky).

A resposta técnica foi adicionar uma **segunda camada**, não só ajustar os números da primeira: a camada recente (seção 6) continua existindo exatamente como estava, e uma nova camada **profunda** (`trail_deep_front`/`trail_deep_back`, mesmo esquema de ping-pong) é alimentada pela mesma captura, mas com uma taxa de decaimento muito menor (`trail_deep_decay_per_second`, meia-vida de minutos, não segundos).

Uma primeira versão disso aplicava só um piso *multiplicativo*, na hora de desenhar, relativo ao próprio valor já decaído do acumulador. Isso não funcionava de verdade: qualquer decaimento puramente exponencial, por mais lento que seja, tende matematicamente a zero — "mais devagar" não é "indeterminadamente". A correção foi mover o piso para dentro do próprio passo de decaimento (`DRAW_MODE_DEEP_DECAY`, modo de desenho 5 em `composite.wgsl`): depois de calcular o valor decaído deste quadro, se o pixel já tinha alguma opacidade antes (`color.a > 0.0` — ou seja, já foi tocado por alguma presença alguma vez), o resultado é travado num mínimo absoluto, `trail_deep_floor_absolute`, em vez de deixar continuar encolhendo. Um pixel que nunca recebeu presença permanece exatamente em zero (a textura começa limpa e transparente, e `0.0 > 0.0` é falso, então o piso nunca "nasce" sozinho em lugar nenhum) — só quem já foi tocado fica, para sempre, com uma presença residual nunca menor que o piso.

Por cima desse piso absoluto (que nunca muda), a opacidade ainda oscila: o shader multiplica o valor já-com-piso por uma onda lenta (`solaris_swell`, `displacement.wgsl`, controlada por `trail_deep_floor_ratio`/`trail_oscillation_period_seconds`) — por isso a camada "aparece e desaparece" (entre uma fração do piso e o valor cheio) em vez de ficar estática. A fase dessa onda varia por posição na tela (um hash simples de `uv`), para que regiões diferentes não pulsem juntas — um "respirar" sincronizado em toda a tela leria como um flash de câmera, não como um mar.

Por que duas camadas e não só mudar os parâmetros da camada existente? Porque "nunca zera, mas oscila" e "desbota rápido quando há movimento novo" são comportamentos incompatíveis numa única textura com um único decaimento: se o pixel já decaiu a zero (como a camada recente precisa fazer, para reagir ao movimento de agora), não há mais nenhuma cor ali para "revelar de novo" depois. A camada profunda existe justamente para guardar o que a recente já descartou.

A distorção do rastro também passou a ser dedicada: `solaris_field` (em vez do `organic_field` compartilhado com o reflexo/ecos) usa frequência espacial mais baixa, velocidade mais lenta e amplitude maior — e um termo "pesado" dominante, um **produto** de seno por cosseno (não uma soma), que é o que dá a leitura "não segue a física comum da água", em vez de só "água lenta". Duas "bolhas" (`solaris_bubble`) derivam lentamente pela tela e, em janelas breves e dessincronizadas entre si, empurram os pixels perto de si para fora — a parte mais citável de Solaris: pensamento/memória ganhando forma física por um instante, antes de se desfazer de novo. Nenhuma dessas mudanças toca `organic_field` nem os modos de desenho 0/1 (ecos, reflexo vivo) — a legibilidade do presente continua protegida.

Um truque de implementação vale registrar: o binding de textura que o modo 1 usa para ler o campo de deslocamento (`displacement_texture`, binding 3) é **reaproveitado** pelo modo 3 para carregar a textura da camada profunda — como cada modo só lê os bindings que realmente usa, isso evita ter que declarar um binding/layout de bind group inteiramente novo só para um segundo modo de desenho.

## 7. Os shaders WGSL

WGSL não tem `#include`. `renderer.rs` concatena os quatro arquivos (`echo.wgsl` + `displacement.wgsl` + `dissolve.wgsl` + `composite.wgsl`) num texto só, via `include_str!`, antes de mandar para a GPU — assim cada arquivo foca numa responsabilidade (deslocamento de posição, campo de distorção orgânico, máscara de dissolução, composição final) sem duplicar código entre eles.

`composite.wgsl` usa um único `fs_main` ramificado por `draw.draw_mode` (0 = eco, 1 = reflexo atual, 2 = passagem interna "lisa" do acumulador, 3 = o próprio rastro, 4 = diagnóstico) em vez de shaders separados por modo — a GPU já paga o custo de um `if` por fragmento de qualquer forma, e manter tudo num arquivo deixa as diferenças entre os modos (quem recebe dissolução, quem fica em tons de cinza, quem lê o campo de deslocamento) visíveis lado a lado.

## 8. `build.rs` — o identificador de build

Roda `git rev-parse --short HEAD` em tempo de compilação e expõe o resultado como `env!("MOSAICO_BUILD_ID")`, usado por `engine_version()` em `lib.rs`. Existe porque a Vercel não recompila o Rust (o `.wasm` já compilado é commitado) — sem isso, não haveria como confirmar, só olhando o app rodando, se o motor publicado corresponde ao código-fonte mais recente. Se o `git rev-parse` falhar por qualquer motivo, cai para a string `"desconhecido"` em vez de travar a build.

## 9. Testes: o que `cargo test` cobre, e por que não cobre tudo

`cargo test` roda como um **programa nativo** (do sistema operacional atual), não como WebAssembly. Isso tem uma consequência direta: `renderer.rs` é `#[cfg(target_arch = "wasm32")]` em `lib.rs` — ele nem é compilado quando se roda `cargo test` normalmente, porque usa tipos (`wgpu::Surface` a partir de um `HtmlCanvasElement`, por exemplo) que só existem de verdade dentro de um navegador. Por isso:

- **O que é testável nativamente e tem teste**: toda a matemática de `memory.rs` (buffer circular, expiração por timestamp, fade, reaparecimento) e `effects.rs` (`trail_decay_factor`) — 14 testes, mais um 15º que valida a sintaxe/tipos dos arquivos `.wgsl` com `naga` (o mesmo validador que o `wgpu` usa por baixo, mas sem precisar de uma GPU real).
- **O que não é testável nativamente, e por quê**: qualquer coisa dentro de `renderer.rs` — a configuração de blend, a ordem de composição, o ping-pong de texturas. É exatamente esse ponto cego que deixou passar o bug da seção 6 por várias rodadas de revisão. A mitigação prática adotada aqui foi extrair a matemática pura (como `trail_decay_factor`) para fora de `renderer.rs`, para `effects.rs`, sempre que possível — não porque o `Renderer` em si seja testável, mas porque assim pelo menos a lógica que ele *usa* é.

## 10. Onde ajustar o quê

- Números artísticos (intensidades, durações, opacidades): `config/effects.json` — nunca direto nos `_default()` de `memory.rs`/`effects.rs`, que só existem como um fallback documentado (ver o comentário em `LayerConfig::intermediate_default`).
- Novo parâmetro de efeito: precisa ser adicionado em **quatro** lugares, na mesma ordem relativa — `config/effects.json`, `EffectConfig` (`effects.rs`), `DrawUniforms` + `make_uniforms` + `configure_effects` (`renderer.rs`), e a struct `DrawUniforms` em `composite.wgsl` — mais `web/src/config.ts` e a chamada em `web/src/main.ts::applyEffectsToRenderer` do lado TypeScript.
- Nova camada de memória discreta: não é tão simples quanto parece — exigiria um novo variante de `LayerKind`, mais todo o fiação em `lib.rs`/`main.ts`. As duas camadas atuais (mais o acumulador de rastro) foram suficientes até agora; não crie uma terceira sem um motivo artístico concreto.
