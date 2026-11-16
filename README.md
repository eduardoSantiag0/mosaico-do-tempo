# Mosaico do Tempo — Presenças que Permanecem

Instalação artística interativa: o visitante acessa pelo navegador do celular, autoriza a câmera frontal, e vê seu reflexo sendo atravessado por versões anteriores de si mesmo — rastros de movimento que se sobrepõem, se distorcem e se dissolvem com o tempo.

Referências conceituais: Henri Bergson (duração e memória), Andrei Tarkovsky (tempo e composição), Jacques Derrida (vestígio e ausência), *Deep Walls*.

## Visão geral da arquitetura

```text
mosaico-do-tempo/
├── config/effects.json      # parâmetros artísticos (fonte da verdade)
├── engine/                  # motor em Rust, compilado para WebAssembly
│   ├── src/memory.rs        # TemporalMemory: 3 camadas de buffers circulares
│   ├── src/effects.rs       # parâmetros dos efeitos visuais (sem GPU)
│   ├── src/renderer.rs      # Renderer wgpu/WGSL (também faz o papel de "Compositor")
│   ├── src/shaders/*.wgsl   # echo, underwater, dissolve, composite
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

### Adaptações em relação à estrutura sugerida (e por quê)

- **`config/effects.json` é copiado para `web/public/config/` antes de rodar/buildar** (script `web/scripts/sync-config.mjs`). O app é 100% estático e lê a configuração via `fetch()` em runtime; só arquivos dentro de `web/public/` podem ser servidos assim. Mantemos um único arquivo editável (`config/effects.json`) para não haver duas cópias divergentes.
- **WGSL não tem `#include`.** `renderer.rs` concatena `echo.wgsl` + `underwater.wgsl` + `dissolve.wgsl` + `composite.wgsl` num texto só antes de mandar para a GPU, para que cada arquivo possa focar numa responsabilidade (como pedido na seção 7) sem duplicar código.
- **O "Compositor" descrito no enunciado está implementado como parte do `Renderer`** (`renderer.rs`): ele decide a ordem de desenho (memória mais antiga → mais nova → reflexo atual) e aplica os parâmetros de `effects.rs`. Não criamos um struct `Compositor` separado porque, neste estágio, ele não teria lógica própria além de chamar o Renderer — seria uma indireção sem benefício real.

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

Edite `config/effects.json` e rode `npm run dev`/`npm run build` de novo (ou `npm run config:sync` isoladamente). Campos:

- `memory.{short,intermediate,long}`: duração (`maxAgeMs`), ritmo de captura (`captureIntervalMs`), quantos registros guardar (`capacity`), opacidade máxima (`baseWeight`), curva do fade (`fadePower`) e deslocamento (`driftAmount`) de cada camada de memória temporal (RF03).
- `effects`: intensidade/frequência/velocidade/amplitude da distorção "underwater" (RF06), fragmentação da dissolução (RF07) e se os ecos usam mistura aditiva (RF08).
- `capture`: resoluções e frequências de captura (memória, reflexo atual, segmentação) — são os valores de **qualidade "alta"**; em qualidade mais baixa, `web/src/performance.ts` os multiplica por um fator menor automaticamente.
- `devPanel.enabled`: coloque `false` na versão de exposição para remover completamente o painel de desenvolvimento (RF09). Enquanto habilitado, a tecla **"d"** mostra/esconde o painel.

## Testes implementados e resultados

- **`cargo test` (`engine/`)** — 11 testes, todos passando:
  - `memory.rs`: inserção respeitando o intervalo de captura, expiração por timestamp (independente de FPS), limite de capacidade (buffer circular), fade de opacidade, reset de sessão, ordenação dos registros ativos.
  - `lib.rs`: ciclo completo `insertFrame` → `update` → leitura dos registros ativos.
  - `tests/wgsl_shaders_validate.rs`: valida a sintaxe e os tipos dos quatro arquivos `.wgsl` usando `naga` (o mesmo validador que o `wgpu` usa por baixo dos panos) — sem precisar de um navegador.
- **Smoke tests manuais do servidor de desenvolvimento**: todas as rotas (`index.html`, módulos TypeScript, o pacote Wasm, o worker de segmentação, o modelo `.tflite`, o runtime Wasm do MediaPipe, `config/effects.json`) foram verificadas retornando HTTP 200.
- **`npm run build`**: build de produção completo (TypeScript com `strict` habilitado + `vite build`) roda sem erros.

### O que não foi testado (sem acesso a navegador/dispositivo neste ambiente)

Este ambiente de desenvolvimento não tem um navegador real nem um celular conectado — só o terminal. Por isso, o que depende de rodar de fato dentro de um navegador **não foi verificado visualmente** e precisa de validação manual antes da exposição:

- Permissão de câmera concedida/negada, câmera indisponível.
- A imagem do WebGPU/WebGL2 realmente aparecendo na tela (a lógica foi conferida com cuidado contra a documentação/código-fonte do `wgpu` e com um teste de validação de shader, mas o resultado visual final não foi visto).
- O fallback em Canvas 2D sendo de fato acionado quando WebGPU/WebGL2 não está disponível.
- Qualidade/alinhamento da máscara de segmentação do MediaPipe sobre os registros de memória.
- Mudança de orientação do celular, app em segundo plano, perda/recuperação do contexto gráfico.
- Desempenho real (FPS) em aparelhos Android/iOS — os limiares de `performance.ts` são estimativas iniciais.

## Limitações conhecidas

- **Tamanho do download inicial**: o runtime Wasm do MediaPipe (~14MB) é o maior item; some ao Wasm do motor (~2MB). Em uma instalação com Wi-Fi local isso tende a ser aceitável, mas é pesado para redes de celular lentas. Fica em cache do navegador após a primeira visita.
- **Leitura de pixels por CPU**: tanto o reflexo atual quanto a memória usam `getImageData` (CPU) para levar os pixels até a GPU, em vez de `copyExternalImageToTexture` (que evitaria essa cópia no caminho WebGPU). Trocamos simplicidade/um único caminho de código por um pouco de desempenho; é o primeiro lugar a otimizar se o FPS real for baixo.
- **Um `queue.submit` por quad desenhado**: o Renderer cria um buffer de uniforms e um bind group novos para cada eco desenhado, em vez de um atlas de texturas ou uniforms com offset dinâmico. Mais simples de entender, mas tem um teto de desempenho com muitas centenas de registros ativos ao mesmo tempo.
- **Cores não passam por nenhuma conversão sRGB**: os bytes vêm direto do Canvas 2D do navegador. Deve estar visualmente correto na maioria dos casos, mas não houve verificação em tela real.
- **Degradação de qualidade é só de mão única**: uma vez que o `PerformanceManager` reduz a qualidade, ela não volta a subir automaticamente na mesma sessão.
- **Paleta de cores** (mencionada na seção 8 do enunciado) ainda não tem um controle próprio — os efeitos atuais (distorção, dissolução, mistura aditiva) cobrem RF06/RF07/RF08, mas não há, por exemplo, uma função de tingimento de cor configurável.

## Publicação na Vercel

O app é estático (`web/dist/`) e não precisa de backend. Como o ambiente de build da Vercel não tem Rust instalado, o WebAssembly já compilado fica versionado em `web/src/wasm/` — o build na Vercel só roda `tsc` + `vite build` (ver `web/vercel.json`).

1. Crie um projeto na Vercel a partir deste repositório.
2. Em **Settings → General → Root Directory**, defina `web`.
3. A Vercel deve detectar o framework (Vite) e usar `web/vercel.json` automaticamente (`buildCommand`/`outputDirectory`). Nenhuma variável de ambiente é necessária.
4. Depois do primeiro deploy, toda alteração no motor Rust precisa ser recompilada **localmente** (`npm run wasm:build` dentro de `web/`) e commitada antes do próximo deploy — a Vercel não recompila o Rust.
5. A Vercel fornece HTTPS automaticamente, necessário para `getUserMedia` (câmera) fora de `localhost`.

### Acesso por QR Code

Depois do deploy, gere um QR Code para a URL pública (`https://seu-projeto.vercel.app`) com qualquer gerador de QR Code e exiba-o no espaço da instalação. Não é necessário nenhum recurso adicional no app para isso.

## Requisitos de navegador

- Navegador com suporte a `getUserMedia` (câmera), ES2022 e Web Workers com módulos ES.
- WebGPU (preferencial) ou WebGL2 (fallback automático) — se nenhum dos dois estiver disponível, o app cai para um caminho simplificado em Canvas 2D (sem distorção/dissolução via shader, mas com rastros e fade funcionando).
- Conexão HTTPS (ou `localhost`) — exigência do navegador para liberar a câmera.
