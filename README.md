# Mosaico do Tempo — Presenças que Permanecem

Instalação artística interativa: o visitante acessa pelo navegador do celular, autoriza a câmera frontal, e vê seu reflexo sendo atravessado por versões anteriores de si mesmo — rastros de movimento que se sobrepõem, se distorcem e se dissolvem com o tempo.

Referências conceituais: Henri Bergson (duração e memória), Andrei Tarkovsky (tempo e composição), Jacques Derrida (vestígio e ausência), *Deep Walls*.

## Visão geral da arquitetura

```text
mosaico-do-tempo/
├── config/effects.json      # parâmetros artísticos (fonte da verdade)
├── engine/                  # motor em Rust, compilado para WebAssembly
│   ├── build.rs             # embute o hash do commit git (MOSAICO_BUILD_ID) no binário
│   ├── src/memory.rs        # TemporalMemory: camadas intermediária e prolongada (buffers circulares)
│   ├── src/effects.rs       # parâmetros dos efeitos visuais (sem GPU)
│   ├── src/renderer.rs      # Renderer wgpu/WGSL — acumulador de rastro + campo de deslocamento
│   ├── src/shaders/*.wgsl   # echo, displacement, dissolve, composite
│   └── tests/               # validação offline dos shaders (naga)
└── web/                     # app Vite/TypeScript
    ├── src/camera.ts        # CameraController
    ├── src/segmentation.ts  # fala com o Web Worker do MediaPipe
    ├── src/workers/         # segmentation.worker.ts (roda fora da thread principal)
    ├── src/performance.ts   # PerformanceManager (FPS, qualidade adaptativa)
    ├── src/debugPanel.ts    # painel de desenvolvimento (tecla "d")
    ├── src/config.ts        # carrega config/effects.json em runtime
    └── src/main.ts          # orquestra tudo
```

## Refatoração artística e técnica (v2)

A versão inicial desenhava a memória curta como dezenas de fotografias semitransparentes empilhadas, e o reflexo atual era totalmente estático (nunca influenciado pelo passado). Uma segunda rodada de trabalho, guiada por um briefing artístico mais detalhado, mudou isso:

| Antes | Agora |
|---|---|
| Memória curta: até ~48 registros discretos (fotos) desenhados em sequência, cada um com sua própria opacidade. | Memória curta: **um acumulador contínuo na GPU** (duas texturas em "ping-pong"): o conteúdo antigo desbota exponencialmente (`exp(-decayPerSecond·dt)`) e a captura nova é somada por cima a cada quadro. Visualmente, um rastro orgânico que persiste e desbota, em vez de uma pilha de fotos. |
| Três camadas de memória (curta/intermediária/prolongada), todas com o mesmo tipo de fade. | Duas camadas discretas (intermediária/prolongada — a curta passou a ser o acumulador acima), com curvas de fade distintas; a prolongada ganhou um efeito de **"reaparecimentos ocasionais"** (a opacidade pulsa em vez de só cair), para parecer um vestígio que "aparece e desaparece", não uma foto que só desbota. |
| O reflexo atual era desenhado sem nenhuma influência das memórias passadas. | **Campo de deslocamento temporal**: o canal alfa do acumulador de rastro (onde houve presença recente) é usado para deformar localmente a amostragem do reflexo atual — o passado interfere sutilmente no presente, sem cobrir a imagem com nada visível. |
| Distorção "underwater": duas ondas de seno simples, uniformes pela tela inteira. | `displacement.wgsl`: um campo com quatro ondas de frequências/fases desencontradas (`organic_field`), para não parecer um "filtro de água" genérico e repetitivo. A mesma função é reusada pelos ecos (intensidade ligada à idade) e pelo reflexo (intensidade ligada à presença recente no acumulador). |
| Vestígios ficavam coloridos a vida inteira, só ficando transparentes. | Os ecos passam a tons de cinza progressivamente (RF visual "fantasmagórico"), usando `age_ratio·2` para já ficarem bem dessaturados na metade da vida, enquanto ainda estão visíveis — não só perto do fim, quando já são quase invisíveis. |

**Por que essas escolhas:** o critério orientador foi "o passado deve deformar o presente, sem destruir sua legibilidade" — por isso o campo de deslocamento usa o próprio acumulador de rastro (que já é local e ligado a movimento real) como fonte de intensidade, em vez de uma distorção uniforme na tela inteira; e por isso os "reaparecimentos" da memória prolongada usam um pulso suave (onda elevada ao cubo), não um ruído aleatório desconectado do que foi realmente capturado.

### Adaptações em relação à estrutura sugerida (e por quê)

- **`config/effects.json` é copiado para `web/public/config/` antes de rodar/buildar** (script `web/scripts/sync-config.mjs`). O app é 100% estático e lê a configuração via `fetch()` em runtime; só arquivos dentro de `web/public/` podem ser servidos assim. Mantemos um único arquivo editável (`config/effects.json`) para não haver duas cópias divergentes.
- **WGSL não tem `#include`.** `renderer.rs` concatena `echo.wgsl` + `displacement.wgsl` + `dissolve.wgsl` + `composite.wgsl` num texto só antes de mandar para a GPU, para que cada arquivo possa focar numa responsabilidade sem duplicar código.
- **O "Compositor" está implementado como parte do `Renderer`** (`renderer.rs`): ele decide a ordem de desenho (reflexo atual → ecos → rastro) e aplica os parâmetros de `effects.rs`. Não criamos um struct `Compositor` separado porque, neste estágio, ele não teria lógica própria além de chamar o Renderer.
- **A memória curta não é um `MemoryLayer` em Rust.** Ela é um acumulador contínuo (duas texturas em "ping-pong") que vive inteiramente na GPU, dentro do `Renderer`. Isso é intencional: um rastro de movimento fica mais orgânico sendo "desenhado e desbotando" continuamente do que sendo um monte de capturas discretas se sobrepondo, e também é mais barato (duas passagens de desenho fixas por quadro, em vez de uma por registro).

## Auditoria do pipeline e modo de diagnóstico (v3)

Depois da v2, veio um relato de que "os efeitos continuam imperceptíveis — parece uma câmera comum". Em vez de alterar números às cegas de novo, esta rodada teve dois focos: **auditar cada etapa do pipeline com evidência concreta** e **construir ferramentas de diagnóstico** para que qualquer pessoa (não só quem lê o código) consiga ver exatamente onde um efeito para de funcionar.

### Causas-raiz investigadas

| # | Hipótese levantada | Veredito | Evidência |
|---|---|---|---|
| A | `confidenceMasks?.[0]` pega a máscara do **fundo**, não da pessoa; deveria ser `[1]`. | **Falsa**, de novo — já tinha sido verificada e refutada na rodada anterior, mas a sugestão voltou a aparecer. | O arquivo `web/public/models/selfie_segmenter.tflite` é, ele mesmo, um `.tflite` com metadados em zip. `unzip -l` mostra **um único arquivo**, `labels.txt`, com **uma única linha**: `selfie`. Não existe uma segunda categoria "fundo" nesse modelo — `confidenceMasks` só tem um elemento, e ele já É a confiança de "é pessoa". Em vez de só reafirmar isso, construímos a **Visualização 1** do modo de diagnóstico (abaixo) para qualquer pessoa confirmar isso ao vivo, no próprio celular. |
| B | O reflexo atual (`is_live`) nunca era distorcido pelas memórias. | **Verdadeira na v1**, já corrigida na v2 (campo de deslocamento temporal lendo o acumulador de rastro). Permanecia uma dúvida legítima: será que essa correção está realmente publicada e funcionando? | Resolvida por duas frentes: (1) o `?debug=true` agora tem um botão de "distorção forçada" que prova o mecanismo isoladamente da pergunta "o acumulador está recebendo movimento de verdade?"; (2) a verificação de frescor do WASM (abaixo) garante que o `.wasm` publicado corresponde ao código-fonte atual. |
| C | O sistema guardava fotografias individuais em vez de acumulação temporal de verdade. | **Verdadeira na v1**, corrigida na v2 (acumulador de rastro em GPU com ping-pong + decaimento exponencial). | Testes automatizados (`effects::tests::decay_factor_*`) comprovam a matemática do decaimento; a **Visualização 2** do modo de diagnóstico mostra os registros realmente guardados nas camadas discretas, em tempo real. |
| D | O fallback em Canvas 2D não reproduzia os efeitos essenciais. | **Parcialmente verdadeira.** O fallback agora tem seu próprio acumulador de rastro (em Canvas 2D) e tons de cinza progressivos nos ecos, mas **não** reproduz o campo de deslocamento no reflexo atual (Canvas 2D não faz amostragem de textura por shader) — em vez disso, ganhou uma distorção forçada por "faixas onduladas" só para o modo de diagnóstico provar que uma distorção espacial É possível nesse caminho. | Ver `web/src/main.ts`, funções `updateAndDrawTrailCanvas2d` e `drawCoverMirroredWithForcedDistortion`. |
| E | O deploy pode estar servindo um `.wasm` desatualizado. | **Risco real, agora mitigado.** | `engine_version()` passou a incluir o hash do commit git (`build.rs` embute `MOSAICO_BUILD_ID`), visível na **Visualização 5**. Além disso, `web/scripts/check-wasm-freshness.mjs` roda antes de todo build na Vercel e **falha o build** se o hash do `.wasm` publicado não corresponder ao hash do código-fonte atual de `engine/` (ver seção "Correções de acumulação e robustez" abaixo — a verificação evoluiu de comparar datas de commit para comparar o conteúdo de verdade). |

## Correções de acumulação e robustez (v4)

Uma nova rodada de revisão encontrou quatro problemas concretos, todos confirmados por leitura direta do código (não por suposição) antes de qualquer correção:

- **[Alta prioridade] O acumulador de rastro somava a mesma captura várias vezes.** `captureTrailFrame()` só tira uma foto nova a cada ~90ms, mas `update_trail_accumulator()` rodava a cada quadro de renderização (até 60×/s) e sempre desenhava a captura atual por cima do acumulador com opacidade 0.8 — ou seja, a MESMA imagem era somada de 5 a 6 vezes seguidas antes da próxima captura real chegar. Como a mistura por transparência não é idempotente, isso fazia o canal alfa do acumulador saturar perto de 100% em poucos quadros: o "rastro" virava uma cópia quase sólida da pessoa atual, em vez de um vestígio que desbota — exatamente a explicação mais plausível para "os efeitos não aparecem" (o rastro fica parecido demais com o reflexo). **Corrigido** em `renderer.rs::update_trail_accumulator`: agora o Rust recebe o timestamp de quando a captura foi tirada (não de quando o quadro está sendo desenhado) e só soma a captura ao acumulador quando esse timestamp for diferente do último já aplicado. O mesmo bug existia (e foi corrigido) no fallback em Canvas 2D (`updateAndDrawTrailCanvas2d`).
- **Segmentação sem fallback de CPU.** `ImageSegmenter` só tentava o delegado `"GPU"`; em aparelhos sem esse delegado disponível, a segmentação nunca inicializava, e as capturas de memória/rastro ficavam com o cenário inteiro (sem a máscara da pessoa) para sempre, não só durante o carregamento. **Corrigido**: se a inicialização com `"GPU"` falhar, `segmentation.worker.ts` tenta de novo com `"CPU"` antes de desistir.
- **O acumulador de rastro na GPU nunca era zerado ao encerrar a sessão.** `stopExperience()` já limpava a memória do motor (`engine.reset()`) e os buffers do fallback em Canvas 2D, mas não tinha uma chamada equivalente para o `Renderer`. Como o decaimento é rápido (meia-vida < 1s com os valores padrão), isso provavelmente nunca seria percebido na prática — mas, estritamente, o estado persistia entre sessões. **Corrigido**: novo método `Renderer::reset()`, chamado em `stopExperience()`.
- **A verificação de frescor do WASM comparava datas de commit, não conteúdo.** Funcionava, mas tinha uma lacuna teórica em ambientes com histórico de git incompleto (clone superficial). **Corrigido**: `check-wasm-freshness.mjs` agora compara um hash sha256 do conteúdo real de `engine/` contra um hash salvo junto do `.wasm` no momento em que ele foi compilado (`write-wasm-source-hash.mjs`, parte de `npm run wasm:build`) — funciona independentemente da profundidade do histórico do git.

### Modo de diagnóstico visual (`?debug=true`)

Acesse `https://seu-dominio.vercel.app/?debug=true` (funciona no celular — não depende de teclado). O painel de depuração abre automaticamente, com uma seção extra:

1. **Máscara de segmentação** — uma prévia em preto e branco da máscara bruta do MediaPipe (branco = pessoa, preto = fundo), atualizada em tempo real. Se a pessoa aparecer preta e o fundo branco, *isso* seria evidência de uma inversão real — o que nunca foi observado nas verificações estáticas feitas aqui (ver causa A).
2. **Memória temporal** — contagem de registros ativos nas camadas intermediária e prolongada, atualizada a cada quadro.
3. **Eco forçado (magenta)** — checkbox que faz todo eco e o rastro aparecerem em magenta sólido, com opacidade máxima, ignorando o fade normal. Se nenhuma silhueta magenta aparecer ao se mover, o problema está em algum ponto *antes* da renderização (captura, segmentação ou armazenamento) — não no shader.
4. **Distorção forçada** — checkbox que faz o reflexo atual sofrer uma distorção sempre ligada e bem mais intensa que o normal (6× a amplitude configurada), independente de qualquer movimento real. Prova que o mecanismo de deslocamento funciona, isolado da pergunta "o acumulador está recebendo movimento de verdade?".
5. **Backend e versão** — mostra o backend gráfico realmente inicializado (`webgpu`, `gl` ou `canvas2d` — nunca "anunciado" sem sucesso: o nome só é lido depois que o adaptador foi de fato obtido), e o identificador de build (`engine_version()`, que agora inclui o hash do commit git).

As duas flags de diagnóstico (magenta/distorção) funcionam nos dois caminhos de renderização (GPU e fallback Canvas 2D).

### O que ficou comprovado por teste automatizado, e o que não

**Comprovado por `cargo test` (15 testes) e pela validação offline do shader (`naga`):**
- A segmentação usa o índice correto para este modelo (evidência estática no arquivo `.tflite`, não um teste automatizado, mas verificável por qualquer pessoa com `unzip`).
- O decaimento do acumulador de rastro é matematicamente independente do FPS (`decay_factor_is_independent_of_frame_rate`).
- O efeito de "reaparecimentos" da memória prolongada realmente faz a opacidade subir e descer, não só cair (`reappearance_pulse_creates_brighter_and_dimmer_moments`).
- O shader principal (4 modos de desenho, incluindo os 2 modos de diagnóstico) é WGSL válido segundo o mesmo validador que o `wgpu` usa.

**Não comprovado — requer o modo de diagnóstico num navegador real, o que este ambiente não tem:**
- Se a silhueta magenta realmente aparece ao mover o corpo (Teste/Critério obrigatório da seção 10).
- Se a distorção forçada realmente deforma a imagem visivelmente.
- Se a máscara de segmentação, vista na Visualização 1, está de fato alinhada com a pessoa (e não invertida ou desalinhada por algum motivo não previsto na análise estática).
- A intensidade artística final percebida num celular real — todos os valores em `config/effects.json` são estimativas iniciais.

## Revisão por agentes especializados (v5)

Depois da redução de capacidade (v4), duas revisões independentes foram feitas por subagentes do Claude Code com personas dedicadas (`.claude/agents/artist.md` e `.claude/agents/code-reviewer.md` — reusáveis em sessões futuras):

- **`code-reviewer`** confirmou `cargo test`/`cargo check`/`tsc` passando, achou uma inconsistência de documentação (este README dizia que o acumulador de rastro não era zerado ao fim da sessão — já tinha sido corrigido num commit anterior, só o texto ficou desatualizado) e uma inconsistência entre os defaults hardcoded em `memory.rs` e os valores reais de `config/effects.json`.
- **`artist`** achou algo mais importante: a redução de capacidade (v4) quebrou a relação `capacity × captureIntervalMs ≈ maxAgeMs`, que antes era calibrada com cuidado (40×650≈26000; 22×4500≈99000, ambos próximos do `maxAgeMs` de cada camada). Reduzir só a `capacity` fez os registros serem **expulsos do buffer circular ainda bem visíveis** (~23% de opacidade na camada intermediária, ~9% na longa) em vez de desbotarem até quase zero como a curva de fade prevê — e, mais grave artisticamente, encolheu a duração *real* da memória prolongada de ~110s para só ~36s, diluindo a camada que devia representar a "duração longa" (Bergson/Tarkovsky).

**Correção**: em vez de restaurar a capacidade antiga (o que traria de volta o custo de GPU), ajustamos `captureIntervalMs` para restaurar a proporção — `intermediate`: 650→1857ms (14×1857≈26000); `long`: 4500→13750ms (8×13750=110000). Isso preserva a duração artística original E o ganho de performance (menos ecos simultâneos), só reduzindo a densidade temporal das capturas. Os defaults em `memory.rs` foram atualizados para não ficarem desalinhados de novo, com um comentário explicando essa relação.

## Ajuste de fluidez e opacidade do rastro (v6)

Depois de testar no painel de debug, o valor de `effects.trailCaptureOpacity` validado e promovido a padrão foi **0.4** (era 0.8) — rastro mais sutil, "vestígio" em vez de cópia quase opaca.

Também foi adicionado um **limitador de 60fps** no loop principal (`web/src/main.ts::renderFrame`, constante `TARGET_FRAME_INTERVAL_MS`): se `requestAnimationFrame` chamar antes de ~16,67ms terem passado desde o último quadro desenhado (acontece em celulares com tela de 90Hz/120Hz), o quadro é pulado sem fazer nenhum trabalho de captura/desenho, em vez de desenhar mais rápido que 60fps. Isso não muda nada em telas de 60Hz, mas em telas mais rápidas reduz o número total de `queue.submit()` por segundo — o mesmo gargalo identificado na seção anterior — sem perda perceptível de fluidez (o olho humano não distingue 60 de 90-120fps numa imagem como essa).

## Requisitos para desenvolver

- [Rust](https://rustup.rs/) estável + target `wasm32-unknown-unknown` (`rustup target add wasm32-unknown-unknown`)
- [`wasm-pack`](https://rustwasm.github.io/wasm-pack/) (`cargo install wasm-pack`)
- Node.js 20+ e npm

## Comandos

```bash
cd web
npm install

# desenvolvimento (recompila o Rust→Wasm e sincroniza a config automaticamente)
npm run dev          # http://localhost:5173
npm run dev:host     # expõe na rede local (necessário para testar no celular — ver nota sobre HTTPS abaixo)

# build de produção
npm run build        # gera web/dist/

# só recompilar o motor Rust→Wasm manualmente
npm run wasm:build
```

Testes do motor em Rust (buffers circulares, expiração por timestamp, fade, validação dos shaders WGSL):

```bash
cd engine
cargo test
```

## Configuração dos efeitos

Edite `config/effects.json` e rode `npm run dev`/`npm run build` de novo (ou `npm run config:sync` isoladamente; com o app já rodando, o painel de desenvolvimento — tecla **"d"** — ajusta a maior parte desses valores em tempo real, sem precisar editar o arquivo). Campos:

- `memory.{intermediate,long}`: duração (`maxAgeMs`), ritmo de captura (`captureIntervalMs`), quantos registros guardar (`capacity`), opacidade máxima (`baseWeight`), curva do fade (`fadePower`), deslocamento lateral (`driftAmount`) e o efeito de "reaparecimentos ocasionais" (`reappearanceStrength`, 0 a 1; `reappearanceFrequency`, radianos por milissegundo — use `reappearanceStrength: 0` para um fade liso, sem pulsar).
- `trail`: `captureMaxDim`/`captureIntervalMs` — resolução e frequência com que a câmera alimenta o acumulador de rastro (memória curta). Independente da memória discreta, porque o rastro precisa de atualizações bem mais frequentes para acompanhar o movimento de perto.
- `effects`: intensidade/frequência/velocidade/amplitude do campo de deslocamento temporal (`displacement*`, usado tanto nos ecos quanto — com a intensidade vinda da presença no acumulador — no reflexo atual), fragmentação da dissolução (`dissolveFragmentation`), se os ecos usam mistura aditiva (`additiveEchoes`), e o ritmo/opacidade do acumulador de rastro (`trailDecayPerSecond`, `trailCaptureOpacity`).
- `capture`: resoluções e frequências de captura (memória discreta, reflexo atual, segmentação) — são os valores de **qualidade "alta"**; em qualidade mais baixa, `web/src/performance.ts` os multiplica por um fator menor automaticamente (isso também afeta `trail.captureMaxDim`).
- `devPanel.enabled`: coloque `false` na versão de exposição para remover completamente o painel de desenvolvimento. Enquanto habilitado, a tecla **"d"** mostra/esconde o painel.

## Testes implementados e resultados

- **`cargo test` (`engine/`)** — 15 testes, todos passando:
  - `memory.rs`: inserção respeitando o intervalo de captura, expiração por timestamp (independente de FPS), limite de capacidade (buffer circular), fade de opacidade, reset de sessão, ordenação dos registros ativos, e o efeito de "reaparecimentos" (confirma que a opacidade sobe e desce, não só cai).
  - `effects.rs`: a matemática do decaimento do acumulador de rastro — chega a 1.0 sem tempo passado, diminui com o tempo, e é independente do tamanho dos passos (FPS).
  - `lib.rs`: ciclo completo `insertFrame` → `update` → leitura dos registros ativos.
  - `tests/wgsl_shaders_validate.rs`: valida a sintaxe e os tipos dos arquivos `.wgsl` (incluindo os bindings de textura/buffer e os cinco `draw_mode` do shader principal, com os dois modos de diagnóstico) usando `naga` (o mesmo validador que o `wgpu` usa por baixo dos panos) — sem precisar de um navegador.
- **Smoke tests manuais do servidor de desenvolvimento**: todas as rotas (`index.html`, módulos TypeScript, o pacote Wasm, o worker de segmentação, o modelo `.tflite`, o runtime Wasm do MediaPipe, `config/effects.json`) foram verificadas retornando HTTP 200.
- **`npm run build`**: build de produção completo (TypeScript com `strict` habilitado + `vite build`) roda sem erros.

### O que não foi testado (sem acesso a navegador/dispositivo neste ambiente)

Este ambiente de desenvolvimento não tem um navegador real nem um celular conectado — só o terminal. Por isso, o que depende de rodar de fato dentro de um navegador **não foi verificado visualmente** e precisa de validação manual antes da exposição:

- Permissão de câmera concedida/negada, câmera indisponível.
- A imagem do WebGPU/WebGL2 realmente aparecendo na tela (a lógica foi conferida com cuidado contra a documentação/código-fonte do `wgpu` e com um teste de validação de shader, mas o resultado visual final não foi visto).
- **O resultado visual do acumulador de rastro e do campo de deslocamento temporal** (seções 4.1 e 5 do briefing artístico): a lógica foi implementada e revisada com cuidado (incluindo os cenários A–F descritos na seção 10), mas nenhum dos seis cenários foi observado de fato num navegador. Isso inclui a correção da v4 (acumulador somando a mesma captura várias vezes) — o raciocínio e a matemática foram verificados, mas o resultado visual final (um rastro que desbota suavemente, em vez de uma cópia quase sólida) ainda não foi visto numa tela real. Também não há garantia de que a intensidade/velocidade padrão do deslocamento "sinta-se" certa artisticamente — são valores iniciais, pensados para serem ajustados ao vivo pelo painel de desenvolvimento.
- O fallback em Canvas 2D sendo de fato acionado quando WebGPU/WebGL2 não está disponível, e se o acumulador de rastro em Canvas 2D (implementado de forma simplificada, sem o campo de deslocamento no reflexo) produz um resultado visualmente aceitável.
- Qualidade/alinhamento da máscara de segmentação do MediaPipe sobre os registros de memória e sobre a captura do rastro.
- Mudança de orientação do celular, app em segundo plano, perda/recuperação do contexto gráfico.
- Desempenho real (FPS) em aparelhos Android/iOS — os limiares de `performance.ts` são estimativas iniciais, e o acumulador de rastro ainda lê pixels de volta da CPU (`getImageData`) a cada atualização, o que pode custar mais do que o esperado em aparelhos modestos.

## Limitações conhecidas

- **Tamanho do download inicial**: o runtime Wasm do MediaPipe (~14MB) é o maior item; some ao Wasm do motor (~2MB). Em uma instalação com Wi-Fi local isso tende a ser aceitável, mas é pesado para redes de celular lentas. Fica em cache do navegador após a primeira visita.
- **Leitura de pixels por CPU**: tanto o reflexo atual quanto a memória usam `getImageData` (CPU) para levar os pixels até a GPU, em vez de `copyExternalImageToTexture` (que evitaria essa cópia no caminho WebGPU). Trocamos simplicidade/um único caminho de código por um pouco de desempenho; é o primeiro lugar a otimizar se o FPS real for baixo.
- **Um `queue.submit` por quad desenhado**: o Renderer cria um buffer de uniforms e um bind group novos para cada eco desenhado, em vez de um atlas de texturas ou uniforms com offset dinâmico. Mais simples de entender, mas tem um teto de desempenho com muitas centenas de registros ativos ao mesmo tempo.
- **Cores não passam por nenhuma conversão sRGB**: os bytes vêm direto do Canvas 2D do navegador. Deve estar visualmente correto na maioria dos casos, mas não houve verificação em tela real.
- **Degradação de qualidade é só de mão única**: uma vez que o `PerformanceManager` reduz a qualidade, ela não volta a subir automaticamente na mesma sessão.
- **Paleta de cores** ainda não tem um controle próprio — os efeitos atuais (deslocamento, dissolução, mistura aditiva) não incluem, por exemplo, uma função de tingimento de cor configurável.
- ~~O acumulador de rastro (GPU) não é zerado quando a experiência termina.~~ Corrigido: `Renderer::reset()` (chamado em `stopExperience()`) já esvazia o acumulador de rastro, igual a `engine.reset()` faz com a memória discreta.

## Publicação na Vercel

O app é estático (`web/dist/`) e não precisa de backend. Como o ambiente de build da Vercel não tem Rust instalado, o WebAssembly já compilado fica versionado em `web/src/wasm/` — o build na Vercel só roda `tsc` + `vite build` (ver `web/vercel.json`).

1. Crie um projeto na Vercel a partir deste repositório.
2. Em **Settings → General → Root Directory**, defina `web`.
3. A Vercel deve detectar o framework (Vite) e usar `web/vercel.json` automaticamente (`buildCommand`/`outputDirectory`). Nenhuma variável de ambiente é necessária.
4. Depois do primeiro deploy, toda alteração no motor Rust precisa ser recompilada **localmente** (`npm run wasm:build` dentro de `web/`) e commitada antes do próximo deploy — a Vercel não recompila o Rust. Se isso for esquecido, `web/scripts/check-wasm-freshness.mjs` (já incluído em `buildCommand`) **falha o build** em vez de publicar silenciosamente um motor desatualizado.
5. A Vercel fornece HTTPS automaticamente, necessário para `getUserMedia` (câmera) fora de `localhost`.
6. Para confirmar que o deploy está servindo o código esperado, acesse `/?debug=true` e confira o campo "build" no painel de diagnóstico — ele mostra o hash do commit git de onde o `.wasm` publicado foi compilado.

### Acesso por QR Code

Depois do deploy, gere um QR Code para a URL pública (`https://seu-projeto.vercel.app`) com qualquer gerador de QR Code e exiba-o no espaço da instalação. Não é necessário nenhum recurso adicional no app para isso.

## Requisitos de navegador

- Navegador com suporte a `getUserMedia` (câmera), ES2022 e Web Workers com módulos ES.
- WebGPU (preferencial) ou WebGL2 (fallback automático) — se nenhum dos dois estiver disponível, o app cai para um caminho simplificado em Canvas 2D (sem distorção/dissolução via shader, mas com rastros e fade funcionando).
- Conexão HTTPS (ou `localhost`) — exigência do navegador para liberar a câmera.
