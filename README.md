# Mosaico do Tempo — Presenças que Permanecem

Instalação artística interativa: o visitante acessa pelo navegador do celular, autoriza a câmera frontal, e vê seu reflexo sendo atravessado por versões anteriores de si mesmo — rastros de movimento que se sobrepõem, se distorcem e se dissolvem com o tempo.

Referências conceituais: Henri Bergson (duração e memória), Andrei Tarkovsky (tempo e composição, incluindo o mar de *Solaris*), Jacques Derrida (vestígio e ausência), *Deep Walls*. Essas referências também aparecem resumidas no próprio app, no botão "Filosofia por trás" da tela inicial.

## Arquitetura

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
    ├── src/ui.ts            # telas (intro, erro, filosofia, experiência)
    ├── src/config.ts        # carrega config/effects.json em runtime
    └── src/main.ts          # orquestra tudo
```

## Documentação adicional

- **[`docs/arquitetura-rust.md`](docs/arquitetura-rust.md)** — as escolhas de design do motor em Rust (`engine/`): por que cada módulo existe, como a memória temporal e o acumulador de rastro funcionam, e lições aprendidas (incluindo um bug real de composição de alfa no `wgpu`).
- **`.claude/agents/artist.md`** e **`.claude/agents/code-reviewer.md`** — dois subagentes do Claude Code, reusáveis em sessões futuras, para auditar fidelidade artística e revisar o código tecnicamente.

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

- `memory.{intermediate,long}`: duração (`maxAgeMs`), ritmo de captura (`captureIntervalMs`), quantos registros guardar (`capacity`), opacidade máxima (`baseWeight`), curva do fade (`fadePower`), deslocamento lateral (`driftAmount`) e o efeito de "reaparecimentos ocasionais" (`reappearanceStrength`, 0 a 1; `reappearanceFrequency`, radianos por milissegundo). **Importante:** `capacity × captureIntervalMs` deve ficar perto de `maxAgeMs`, senão um registro é expulso do buffer circular antes de a curva de fade terminar de desbotá-lo (ver `docs/arquitetura-rust.md`).
- `trail`: `captureMaxDim`/`captureIntervalMs` — resolução e frequência com que a câmera alimenta o acumulador de rastro (memória curta).
- `effects`: `displacement*` (intensidade/frequência/velocidade/amplitude do campo de deslocamento, usado nos ecos e no reflexo atual), `echoDisplacementFloor` (força mínima do deslocamento num eco recém-nascido — a "textura líquida"), `dissolveFragmentation`, `additiveEchoes`, `trailDecayPerSecond`/`trailCaptureOpacity` (ritmo e opacidade da camada RECENTE do rastro). Além disso, a camada PROFUNDA do rastro — que nunca desaparece de verdade, só oscila — tem seus próprios campos: `trailDeepDecayPerSecond`/`trailDeepCaptureOpacity` (bem menores que os da camada recente), `trailDeepFloorAbsolute` (opacidade mínima que um ponto já tocado mantém para sempre — o que faz a camada nunca desaparecer de verdade), `trailDeepFloorRatio` (piso só da oscilação, relativo ao valor já com o piso absoluto) e `trailOscillationPeriodSeconds`; e a distorção dedicada ao rastro ("mar de Solaris", mais pesada e lenta que a do reflexo/ecos) usa `trailDisplacementFrequency`/`Speed`/`Amplitude`. Detalhes em `docs/arquitetura-rust.md`.
- `capture`: resoluções e frequências de captura (memória discreta, reflexo atual, segmentação) — valores de qualidade "alta"; `web/src/performance.ts` os reduz automaticamente em qualidade mais baixa.
- `devPanel.enabled`: `false` na versão de exposição remove o painel de desenvolvimento.

## Testes implementados

- `cargo test` (`engine/`) — 15 testes: buffers circulares, expiração por timestamp (independente de FPS), fade/reaparecimento, decaimento do acumulador de rastro, e validação WGSL offline via `naga`.
- `npx tsc -b` (`web/`) com `strict` habilitado, e `npm run build` completo — sem erros.

## Limitações conhecidas

Este ambiente de desenvolvimento não tem navegador/celular real — só o terminal. O que depende de execução visual num navegador foi implementado e revisado com cuidado, mas **não foi confirmado visualmente**:

- O resultado visual final do acumulador de rastro, do campo de deslocamento e da textura líquida dos ecos, num celular real.
- Permissão de câmera negada/indisponível, mudança de orientação, app em segundo plano.
- Alinhamento da máscara de segmentação do MediaPipe sobre a pessoa.
- FPS real em Android/iOS (o acumulador de rastro ainda lê pixels via `getImageData`, CPU).
- O fallback em Canvas 2D sendo de fato acionado (sem WebGPU/WebGL2) — funciona, mas não reproduz o campo de deslocamento no reflexo atual.

Outras limitações conhecidas, independentes de verificação visual:

- **Download inicial pesado** (~16MB, runtime do MediaPipe + motor) — fica em cache do navegador após a primeira visita.
- **Um `queue.submit` por quad desenhado** no Renderer (sem atlas de texturas/instancing) — teto de desempenho com muitas centenas de registros ativos; já mitigado reduzindo capacidade das camadas de memória.
- **Degradação de qualidade é só de mão única** — uma vez reduzida pelo `PerformanceManager`, não volta a subir na mesma sessão.
- **Sem paleta de cores configurável** — os efeitos atuais não incluem um tingimento de cor.

## Publicação na Vercel

O app é estático (`web/dist/`) e não precisa de backend. Como o ambiente de build da Vercel não tem Rust instalado, o WebAssembly já compilado fica versionado em `web/src/wasm/` — o build na Vercel só roda `tsc` + `vite build` (ver `web/vercel.json`).

1. Crie um projeto na Vercel a partir deste repositório.
2. Em **Settings → General → Root Directory**, defina `web`.
3. A Vercel deve detectar o framework (Vite) e usar `web/vercel.json` automaticamente. Nenhuma variável de ambiente é necessária.
4. Depois do primeiro deploy, toda alteração no motor Rust precisa ser recompilada **localmente** (`npm run wasm:build` dentro de `web/`) e commitada antes do próximo deploy — a Vercel não recompila o Rust. Se isso for esquecido, `web/scripts/check-wasm-freshness.mjs` (já incluído em `buildCommand`) **falha o build** em vez de publicar silenciosamente um motor desatualizado.
5. A Vercel fornece HTTPS automaticamente, necessário para `getUserMedia` (câmera) fora de `localhost`.
6. Para confirmar que o deploy está servindo o código esperado, acesse `/?debug=true` e confira o campo "build" no painel de diagnóstico — ele mostra o hash do commit git de onde o `.wasm` publicado foi compilado.

### Acesso por QR Code

Depois do deploy, gere um QR Code para a URL pública (`https://seu-projeto.vercel.app`) com qualquer gerador de QR Code e exiba-o no espaço da instalação.

## Requisitos de navegador

- Navegador com suporte a `getUserMedia` (câmera), ES2022 e Web Workers com módulos ES.
- WebGPU (preferencial) ou WebGL2 (fallback automático) — se nenhum dos dois estiver disponível, o app cai para um caminho simplificado em Canvas 2D (sem distorção/dissolução via shader, mas com rastros e fade funcionando).
- Conexão HTTPS (ou `localhost`) — exigência do navegador para liberar a câmera.
