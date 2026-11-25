import initEngine, { Engine, Renderer, engine_version } from "./wasm/mosaico_engine.js";
import { CameraController, CameraError } from "./camera.js";
import { SegmentationService, type SegmentationMask } from "./segmentation.js";
import { UI } from "./ui.js";
import { loadConfig, type AppConfig, type EffectsConfig, type MemoryLayerConfig } from "./config.js";
import { DebugPanel } from "./debugPanel.js";
import { PerformanceManager, QUALITY_SCALE, type QualityLevel } from "./performance.js";

// `canvas` é o elemento que a câmera é desenhada em cima. Começamos com
// `#stage` (onde tentamos WebGPU/WebGL2); se a GPU falhar — seja na
// inicialização, seja repetidamente durante os quadros — trocamos para
// `#stage-fallback`, um <canvas> totalmente separado, nunca tocado pela
// GPU. Isso é necessário porque, uma vez que um <canvas> consegue criar
// um contexto WebGPU/WebGL2 com sucesso, o navegador não deixa mais
// pedir um contexto 2D nele — só um novo elemento resolve isso (RF:
// "fallback funcional para navegadores incompatíveis").
let canvas = required<HTMLCanvasElement>("#stage");
const stageFallbackCanvas = required<HTMLCanvasElement>("#stage-fallback");

const ui = new UI();
const camera = new CameraController();
const segmentation = new SegmentationService();
const performanceManager = new PerformanceManager();
let engine: Engine;
let config: AppConfig;
let currentEffects: EffectsConfig;
let debugPanel: DebugPanel | null = null;

// `?debug=true` liga o modo de diagnóstico visual: mostra o painel
// automaticamente (sem precisar da tecla "d") e acrescenta a seção de
// diagnóstico (máscara de segmentação, contagem de memórias, eco
// forçado, distorção forçada, backend/versão). Funciona também no
// celular, onde não há teclado para apertar "d".
const diagnosticsEnabled = new URLSearchParams(window.location.search).get("debug") === "true";
let debugForceMagenta = false;
let debugForceDistortion = false;

type RenderMode = "gpu" | "canvas2d";
let renderMode: RenderMode = "gpu";
let gpuRenderer: Renderer | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let consecutiveGpuFailures = 0;
const MAX_CONSECUTIVE_GPU_FAILURES = 5;

// Estes offscreen canvases guardam, respectivamente: o quadro reduzido
// usado pela memória intermediária/prolongada, o quadro usado para
// alimentar o acumulador de rastro (memória curta, na GPU), o quadro
// (maior) usado para o reflexo atual, e o quadro usado como entrada da
// segmentação. Seus tamanhos são recalculados por `resizeCanvas()` a
// partir de `config.capture`/`config.trail`, ajustado pelo nível de
// qualidade atual (ver performance.ts).
const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true })!;
const trailCaptureCanvas = document.createElement("canvas");
const trailCaptureCtx = trailCaptureCanvas.getContext("2d", { willReadFrequently: true })!;
const liveCanvas = document.createElement("canvas");
const liveCtx = liveCanvas.getContext("2d", { willReadFrequently: true })!;
const segInputCanvas = document.createElement("canvas");
const segInputCtx = segInputCanvas.getContext("2d", { willReadFrequently: true })!;
const echoCanvas = document.createElement("canvas");
const echoCtx = echoCanvas.getContext("2d")!;

// Usados só pelo fallback em Canvas 2D: um acumulador de rastro próprio
// (o mesmo princípio do acumulador na GPU — "ping-pong" entre duas
// telas, desbotando a antiga e somando a captura nova), já que ali não
// existe o Renderer em Rust para fazer isso.
let trailAccumFront = document.createElement("canvas");
let trailAccumFrontCtx = trailAccumFront.getContext("2d")!;
let trailAccumBack = document.createElement("canvas");
let trailAccumBackCtx = trailAccumBack.getContext("2d")!;
let lastTrailUpdateMs: number | null = null;
/** O `lastTrailCaptureMs` já somado ao acumulador do fallback Canvas 2D — evita somar a mesma captura mais de uma vez. */
let lastAppliedTrailCaptureMs: number | null = null;

const ECHO_CLIP_FRAME_COUNT = 7;
let pendingEchoClip: {
  width: number;
  height: number;
  masked: boolean;
  frameCount: number;
  pixels: Uint8Array;
} | null = null;
let lastCaptureMs = -Infinity;
let lastTrailCaptureMs = -Infinity;
let firstCameraFrameMs: number | null = null;
let lastSegmentationRequestMs = -Infinity;
let effectiveMemoryIntervalMs = 125;
let effectiveTrailIntervalMs = 90;
let effectiveSegmentationIntervalMs = 200;

let rafHandle = 0;
let running = false;

// Travamos o desenho em 60fps mesmo que `requestAnimationFrame` chame
// mais rápido que isso (celulares com tela de 90Hz/120Hz chamariam a
// cada ~11ms ou ~8ms). Sem o limite, nesses aparelhos desenhamos quadros
// demais: cada quadro já custa vários `queue.submit()` (um por eco ativo
// — ver `Renderer::lastFrameSubmitCount` no painel `?debug=true`), então
// desenhar 90-120x/s em vez de 60x/s pode sobrecarregar a GPU/driver e
// aparecer como instabilidade/flicker, sem ganhar fluidez perceptível
// (olho humano não distingue isso). Em telas de 60Hz isto não muda nada
// (o limite nunca chega a ser atingido).
const TARGET_FRAME_INTERVAL_MS = 1000 / 60;
let lastFrameRenderMs = -Infinity;

async function boot(): Promise<void> {
  config = await loadConfig();
  currentEffects = { ...config.effects };

  await initEngine();
  engine = new Engine();
  console.info(`[mosaico] engine wasm v${engine_version()} carregado`);

  applyQualityLevel(performanceManager.qualityLevel);
  performanceManager.onQualityChange((level) => applyQualityLevel(level));

  await initRenderer();
  applyEffectsToRenderer(currentEffects);

  setupDebugPanel();

  ui.onStart(() => void startExperience());
  ui.onRetry(() => void startExperience());
  ui.onExit(() => stopExperience());
  ui.onPhilosophyOpen(() => ui.setPhilosophyVisible(true));
  ui.onPhilosophyClose(() => ui.setPhilosophyVisible(false));

  window.addEventListener("resize", () => {
    resizeCanvas();
    if (renderMode === "gpu") gpuRenderer?.resize(canvas.width, canvas.height);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pauseLoop();
    } else if (camera.isActive) {
      resumeLoop();
    }
  });
}

/** Tries to set up the WebGPU/WebGL2 renderer; falls back to Canvas 2D if unavailable. */
async function initRenderer(): Promise<void> {
  try {
    gpuRenderer = await Renderer.create(canvas, canvas.width, canvas.height);
    renderMode = "gpu";
    console.info("[mosaico] renderização via WebGPU/WebGL2");
  } catch (err) {
    console.warn("[mosaico] WebGPU/WebGL2 indisponível, usando fallback em Canvas 2D:", err);
    switchToCanvas2dFallback();
  }
}

/**
 * Troca para o <canvas> de fallback e usa um contexto 2D nele. Pode ser
 * chamado tanto na inicialização (WebGPU/WebGL2 nunca funcionou) quanto
 * depois, se o caminho GPU começar a falhar repetidamente nos quadros.
 */
function switchToCanvas2dFallback(): void {
  if (renderMode === "canvas2d") return; // já estamos no fallback

  canvas.classList.add("hidden");
  stageFallbackCanvas.classList.remove("hidden");
  canvas = stageFallbackCanvas;
  ctx2d = canvas.getContext("2d", { alpha: false });
  gpuRenderer = null;
  renderMode = "canvas2d";
  resizeCanvas();
}

function setupDebugPanel(): void {
  if (!config.devPanel.enabled && !diagnosticsEnabled) return;

  debugPanel = new DebugPanel(
    ui.debugPanel,
    currentEffects,
    diagnosticsEnabled,
    (effects) => {
      currentEffects = effects;
      applyEffectsToRenderer(currentEffects);
    },
    (forceMagenta, forceDistortion) => {
      debugForceMagenta = forceMagenta;
      debugForceDistortion = forceDistortion;
      gpuRenderer?.setDebugFlags(forceMagenta, forceDistortion);
    },
  );

  // Importante: NÃO mostramos o painel aqui, mesmo com `?debug=true`.
  // O painel fica sobre uma faixa grande na parte de baixo da tela
  // (bottom + até 40vh de altura, com z-index acima do resto) — se ele
  // já aparecesse na tela inicial, cobriria o botão "Iniciar
  // experiência" e o visitante nunca conseguiria tocar nele. Em vez
  // disso, só mostramos o painel depois que a experiência já começou
  // (ver `startExperience`), quando esse espaço não tem mais nenhum
  // botão por baixo. Fora do modo de diagnóstico, continua escondido
  // por padrão, e a tecla "d" alterna.
  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "d") return;
    const nowHidden = ui.debugPanel.classList.contains("hidden");
    ui.setDebugVisible(nowHidden);
  });
}

/** Aplica os parâmetros do campo de deslocamento temporal e da dissolução (sem efeito no fallback Canvas 2D). */
function applyEffectsToRenderer(effects: EffectsConfig): void {
  if (!gpuRenderer) return;
  gpuRenderer.configureEffects(
    effects.displacementIntensity,
    effects.displacementFrequency,
    effects.displacementSpeed,
    effects.displacementAmplitude,
    effects.dissolveFragmentation,
    effects.echoDisplacementFloor,
    effects.trailDecayPerSecond,
    effects.trailCaptureOpacity,
    effects.trailDeepDecayPerSecond,
    effects.trailDeepCaptureOpacity,
    effects.trailDeepFloorAbsolute,
    effects.trailDeepFloorRatio,
    effects.trailOscillationPeriodSeconds,
    effects.trailDisplacementFrequency,
    effects.trailDisplacementSpeed,
    effects.trailDisplacementAmplitude,
  );
  gpuRenderer.setAdditiveEchoes(effects.additiveEchoes);
}

/** Repassa a configuração de uma camada de memória discreta para o motor em Rust. */
function applyMemoryLayerConfig(layer: MemoryLayerConfig, name: "intermediate" | "long", capacityScale: number): void {
  const capacity = Math.max(4, Math.round(layer.capacity * capacityScale));
  engine.configureLayer(
    name,
    capacity,
    layer.captureIntervalMs,
    layer.maxAgeMs,
    layer.baseWeight,
    layer.fadePower,
    layer.driftAmount,
    layer.reappearanceStrength,
    layer.reappearanceFrequency,
  );
}

/**
 * Aplica um nível de qualidade ("degradação progressiva"), recalculando
 * resoluções de captura, frequência da segmentação e capacidade das
 * camadas de memória a partir dos valores "base" de
 * `config/effects.json`, multiplicados pelos fatores de `QUALITY_SCALE`.
 */
function applyQualityLevel(level: QualityLevel): void {
  const scale = QUALITY_SCALE[level];

  effectiveMemoryIntervalMs = config.capture.memoryIntervalMs;
  effectiveTrailIntervalMs = config.trail.captureIntervalMs;
  effectiveSegmentationIntervalMs = Math.round(config.capture.segmentationIntervalMs * scale.segmentationInterval);

  resizeCanvas();

  applyMemoryLayerConfig(config.memory.intermediate, "intermediate", scale.capacity);
  applyMemoryLayerConfig(config.memory.long, "long", 1);

  if (level !== "high") {
    console.info(`[mosaico] qualidade reduzida para "${level}" (FPS baixo detectado)`);
  }
}

// Quanto tempo esperar, depois de iniciar a câmera, antes de considerar
// que algo deu errado se nenhum quadro de vídeo chegou a tocar de
// verdade. Sem isso, um problema silencioso (por exemplo, o navegador
// bloqueando `video.play()`) deixaria a tela preta para sempre, sem
// nenhuma explicação para o visitante.
const PLAYBACK_WATCHDOG_MS = 4000;
let playbackWatchdogHandle = 0;

async function startExperience(): Promise<void> {
  try {
    await camera.start();
  } catch (err) {
    const camErr = err instanceof CameraError ? err : new CameraError("unknown", String(err));
    ui.showError(errorTitleFor(camErr), camErr.message);
    return;
  }

  ui.showScreen("experience");
  resumeLoop();

  

  // Só agora é seguro mostrar o painel de diagnóstico (`?debug=true`):
  // na tela inicial, ele ficaria sobre o botão "Iniciar experiência" e
  // bloquearia o clique (ver comentário em `setupDebugPanel`).
  if (diagnosticsEnabled) {
    ui.setDebugVisible(true);
  }

  playbackWatchdogHandle = window.setTimeout(() => {
    const { video } = camera;
    const isActuallyPlaying = video.readyState >= video.HAVE_CURRENT_DATA && video.currentTime > 0;
    if (camera.isActive && !isActuallyPlaying) {
      console.error("[mosaico] a câmera foi autorizada, mas nenhum quadro de vídeo chegou a tempo");
      stopExperience();
      ui.showError(
        "Não foi possível exibir a câmera",
        "A câmera foi autorizada, mas a imagem não chegou a aparecer. Tente novamente, recarregue a página ou use outro navegador.",
      );
    }
  }, PLAYBACK_WATCHDOG_MS);
}

function stopExperience(): void {
  clearTimeout(playbackWatchdogHandle);
  pauseLoop();
  camera.stop();
  engine.reset();
  gpuRenderer?.reset(); // esvazia o acumulador de rastro na GPU, para a próxima sessão não começar com vestígios da anterior
  performanceManager.reset();
  lastCaptureMs = -Infinity;
  pendingEchoClip = null;
  lastTrailCaptureMs = -Infinity;
  firstCameraFrameMs = null;
  lastSegmentationRequestMs = -Infinity;
  lastTrailUpdateMs = null;
  lastAppliedTrailCaptureMs = null;
  trailAccumFrontCtx.clearRect(0, 0, trailAccumFront.width, trailAccumFront.height);
  trailAccumBackCtx.clearRect(0, 0, trailAccumBack.width, trailAccumBack.height);
  // Esconde o painel de diagnóstico de novo: na tela inicial ele
  // cobriria o botão "Iniciar experiência" (ver `startExperience`).
  if (diagnosticsEnabled) {
    ui.setDebugVisible(false);
  }
  ui.showScreen("intro");
}

function resumeLoop(): void {
  if (running) return;
  running = true;
  rafHandle = requestAnimationFrame(renderFrame);
}

function pauseLoop(): void {
  running = false;
  cancelAnimationFrame(rafHandle);
}

function renderFrame(): void {
  if (!running) return;
  const now = performance.now();

  // Limitador de 60fps: se o navegador chamou este quadro antes da hora
  // (tela de alta taxa de atualização), só reagenda e sai, sem fazer
  // nenhum trabalho de captura/desenho. Ver comentário de
  // `TARGET_FRAME_INTERVAL_MS` acima.
  if (now - lastFrameRenderMs < TARGET_FRAME_INTERVAL_MS) {
    rafHandle = requestAnimationFrame(renderFrame);
    return;
  }
  lastFrameRenderMs = now;

  performanceManager.recordFrame(now);

  const mask = segmentation.getLatestMask();
  const cameraHasFrame = camera.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  if (cameraHasFrame) firstCameraFrameMs ??= now;
  const canCaptureEcho = mask || (firstCameraFrameMs !== null && now - firstCameraFrameMs >= 1500);
  if (cameraHasFrame && canCaptureEcho && now - lastCaptureMs >= effectiveMemoryIntervalMs) {
    captureIntoMemory(now, mask);
    lastCaptureMs = now;
  }

  if (mask && now - lastTrailCaptureMs >= effectiveTrailIntervalMs) {
    captureTrailFrame(mask);
    lastTrailCaptureMs = now;
  }

  if (now - lastSegmentationRequestMs >= effectiveSegmentationIntervalMs) {
    requestSegmentation(now);
    lastSegmentationRequestMs = now;
  }

  const activeCount = engine.update(now);

  try {
    if (renderMode === "gpu" && gpuRenderer) {
      renderWithGpu(activeCount, now);
      consecutiveGpuFailures = 0;
    } else if (ctx2d) {
      renderWithCanvas2d(activeCount, now);
    }
  } catch (err) {
    // Um erro isolado de um quadro não deve travar a experiência: o
    // reflexo precisa continuar aparecendo nos próximos quadros. Mas se
    // o caminho GPU falhar muitas vezes seguidas, algo está
    // estruturalmente errado (não é só um problema de um quadro) — nesse
    // caso, trocamos para o fallback em Canvas 2D em vez de continuar
    // mostrando a tela preta.
    console.error("[mosaico] erro ao desenhar o quadro:", err);
    if (renderMode === "gpu") {
      consecutiveGpuFailures++;
      if (consecutiveGpuFailures >= MAX_CONSECUTIVE_GPU_FAILURES) {
        console.error(`[mosaico] GPU falhou ${consecutiveGpuFailures} quadros seguidos, trocando para fallback em Canvas 2D`);
        switchToCanvas2dFallback();
      }
    }
  }

  debugPanel?.updateStats({
    fps: performanceManager.fps,
    totalMemoryBytes: engine.totalBytes(),
    activeRecordCount: activeCount,
    renderMode,
    qualityLevel: performanceManager.qualityLevel,
  });

  if (diagnosticsEnabled) {
    updateDiagnosticsPanel(activeCount);
  }

  rafHandle = requestAnimationFrame(renderFrame);
}

/**
 * Preenche a seção de diagnóstico do painel (visualizações 2 e 5 do
 * briefing de diagnóstico): backend/versão, contagem de memórias por
 * camada, e uma prévia visual da máscara de segmentação mais recente.
 */
function updateDiagnosticsPanel(activeCount: number): void {
  if (!debugPanel) return;

  let intermediateCount = 0;
  let longCount = 0;
  for (let i = 0; i < activeCount; i++) {
    if (engine.activeLayer(i) === "intermediate") intermediateCount++;
    else if (engine.activeLayer(i) === "long") longCount++;
  }

  debugPanel.updateDiagnostics({
    backendName: renderMode === "gpu" ? gpuRenderer?.backendName() ?? "desconhecido" : "canvas2d",
    buildId: engine_version(),
    liveWidth: liveCanvas.width,
    liveHeight: liveCanvas.height,
    layerCounts: { intermediate: intermediateCount, long: longCount },
    segmentationReady: segmentation.isReady,
    submitCount: renderMode === "gpu" ? gpuRenderer?.lastFrameSubmitCount() ?? null : null,
  });

  drawMaskPreview();
}

/** Visualização 1 do briefing de diagnóstico: desenha a máscara de segmentação bruta (branco = pessoa). */
function drawMaskPreview(): void {
  const previewCanvas = debugPanel?.maskPreviewCanvas;
  if (!previewCanvas) return;

  const mask = segmentation.getLatestMask();
  if (!mask) return;

  previewCanvas.width = mask.width;
  previewCanvas.height = mask.height;
  const previewCtx = previewCanvas.getContext("2d");
  if (!previewCtx) return;

  const rgba = new Uint8ClampedArray(mask.width * mask.height * 4);
  for (let i = 0; i < mask.data.length; i++) {
    const value = Math.round(mask.data[i] * 255);
    rgba[i * 4] = value;
    rgba[i * 4 + 1] = value;
    rgba[i * 4 + 2] = value;
    rgba[i * 4 + 3] = 255;
  }
  previewCtx.putImageData(new ImageData(rgba, mask.width, mask.height), 0, 0);
}

/** Caminho principal: desenha tudo na GPU (WebGPU/WebGL2) através do Renderer em Rust. */
function renderWithGpu(_activeCount: number, nowMs: number): void {
  const { video } = camera;
  if (video.videoWidth === 0 || !gpuRenderer) return;

  drawCoverMirrored(video, liveCtx, liveCanvas.width, liveCanvas.height);
  const liveFrame = liveCtx.getImageData(0, 0, liveCanvas.width, liveCanvas.height);
  const liveBytes = new Uint8Array(liveFrame.data.buffer, liveFrame.data.byteOffset, liveFrame.data.byteLength);

  const trailFrame = trailCaptureCtx.getImageData(0, 0, trailCaptureCanvas.width, trailCaptureCanvas.height);
  const trailBytes = new Uint8Array(trailFrame.data.buffer, trailFrame.data.byteOffset, trailFrame.data.byteLength);

  gpuRenderer.render(
    engine,
    nowMs,
    liveCanvas.width,
    liveCanvas.height,
    liveBytes,
    trailCaptureCanvas.width,
    trailCaptureCanvas.height,
    trailBytes,
    // Identifica QUANDO a captura foi tirada (não quando este quadro
    // está sendo desenhado) — é assim que o Rust sabe se já viu essa
    // captura antes e evita somá-la ao acumulador mais de uma vez
    // enquanto nenhuma nova chega (ver update_trail_accumulator).
    lastTrailCaptureMs,
  );
}

/** Caminho alternativo (sem WebGPU/WebGL2 suficiente): tudo desenhado em Canvas 2D na CPU. */
function renderWithCanvas2d(activeCount: number, nowMs: number): void {
  if (!ctx2d) return;
  // O reflexo atual é a base (preenche a tela inteira, sem transparência);
  // os ecos e o rastro são desenhados DEPOIS, por cima, com opacidade
  // parcial. Na ordem contrária, o reflexo cobriria tudo por completo.
  if (debugForceDistortion) {
    drawCoverMirroredWithForcedDistortion(camera.video, ctx2d, canvas.width, canvas.height, nowMs / 1000);
  } else {
    drawCoverMirrored(camera.video, ctx2d, canvas.width, canvas.height);
  }
  drawEchoesCanvas2d(activeCount);
  updateAndDrawTrailCanvas2d(nowMs);
}

/**
 * Versão em Canvas 2D do acumulador de rastro (mesma ideia do
 * ping-pong na GPU, veja `renderer.rs`): desbota o conteúdo antigo e
 * soma a captura nova, depois desenha o resultado por cima do reflexo.
 */
function updateAndDrawTrailCanvas2d(nowMs: number): void {
  if (!ctx2d) return;

  const dtSeconds = lastTrailUpdateMs === null ? 0 : Math.max(0, (nowMs - lastTrailUpdateMs) / 1000);
  lastTrailUpdateMs = nowMs;
  const decayFactor = Math.exp(-currentEffects.trailDecayPerSecond * dtSeconds);

  trailAccumBackCtx.clearRect(0, 0, trailAccumBack.width, trailAccumBack.height);
  trailAccumBackCtx.globalAlpha = decayFactor;
  trailAccumBackCtx.drawImage(trailAccumFront, 0, 0, trailAccumBack.width, trailAccumBack.height);

  // Só soma a captura quando ela é realmente nova (mesmo raciocínio do
  // caminho GPU, em renderer.rs::update_trail_accumulator). Esta função
  // roda a cada quadro, mas uma captura nova só chega a cada
  // `effectiveTrailIntervalMs` — sem essa checagem, a mesma imagem seria
  // somada várias vezes seguidas e o rastro ficaria opaco rápido demais.
  if (Number.isFinite(lastTrailCaptureMs) && lastAppliedTrailCaptureMs !== lastTrailCaptureMs) {
    trailAccumBackCtx.globalAlpha = currentEffects.trailCaptureOpacity;
    trailAccumBackCtx.drawImage(trailCaptureCanvas, 0, 0, trailAccumBack.width, trailAccumBack.height);
    lastAppliedTrailCaptureMs = lastTrailCaptureMs;
  }
  trailAccumBackCtx.globalAlpha = 1;

  // Troca os papéis: o que acabamos de construir passa a ser o "front".
  [trailAccumFront, trailAccumBack] = [trailAccumBack, trailAccumFront];
  [trailAccumFrontCtx, trailAccumBackCtx] = [trailAccumBackCtx, trailAccumFrontCtx];

  ctx2d.save();
  ctx2d.filter = "blur(1.5px)"; // um pouco de suavidade orgânica, já que não há distorção por shader aqui
  ctx2d.drawImage(trailAccumFront, 0, 0, canvas.width, canvas.height);
  ctx2d.restore();
}

/** Computes the "cover" crop rectangle (like CSS `cover`) of a source inside a target of a different aspect ratio. */
function computeCoverRect(sourceW: number, sourceH: number, targetW: number, targetH: number): { sx: number; sy: number; sw: number; sh: number } {
  const targetAspect = targetW / targetH;
  const sourceAspect = sourceW / sourceH;

  if (sourceAspect > targetAspect) {
    const sh = sourceH;
    const sw = sh * targetAspect;
    return { sx: (sourceW - sw) / 2, sy: 0, sw, sh };
  }
  const sw = sourceW;
  const sh = sw / targetAspect;
  return { sx: 0, sy: (sourceH - sh) / 2, sw, sh };
}

/**
 * Draws a source frame mirrored horizontally, covering the target without
 * distorting the subject (crop-to-fill, like CSS `cover`).
 */
function drawCoverMirrored(
  source: HTMLVideoElement,
  target: CanvasRenderingContext2D,
  targetW: number,
  targetH: number,
): void {
  const sourceW = source.videoWidth;
  const sourceH = source.videoHeight;
  if (!sourceW || !targetW || !targetH) return;

  const { sx, sy, sw, sh } = computeCoverRect(sourceW, sourceH, targetW, targetH);

  target.save();
  target.translate(targetW, 0);
  target.scale(-1, 1);
  target.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);
  target.restore();
}

/**
 * Diagnóstico ("distorção forçada" no Canvas 2D): a mesma imagem
 * espelhada de `drawCoverMirrored`, mas cortada em faixas horizontais,
 * cada uma deslocada lateralmente por uma onda de seno — uma distorção
 * espacial grosseira, mas claramente visível, sem precisar de shader.
 * Só prova que "é possível deformar a imagem"; não é a estética final.
 */
function drawCoverMirroredWithForcedDistortion(
  source: HTMLVideoElement,
  target: CanvasRenderingContext2D,
  targetW: number,
  targetH: number,
  timeSeconds: number,
): void {
  const sourceW = source.videoWidth;
  const sourceH = source.videoHeight;
  if (!sourceW || !targetW || !targetH) return;

  const { sx, sy, sw, sh } = computeCoverRect(sourceW, sourceH, targetW, targetH);

  const stripCount = 24;
  const stripHeight = Math.ceil(targetH / stripCount);
  const maxOffsetPx = targetW * 0.06;

  target.save();
  target.translate(targetW, 0);
  target.scale(-1, 1);
  for (let strip = 0; strip < stripCount; strip++) {
    const destY = strip * stripHeight;
    const offsetX = Math.sin(timeSeconds * 2.2 + strip * 0.5) * maxOffsetPx;

    const srcY = sy + (strip * stripHeight * sh) / targetH;
    const srcStripHeight = (stripHeight * sh) / targetH;

    target.drawImage(source, sx, srcY, sw, srcStripHeight, offsetX, destY, targetW, stripHeight + 1);
  }
  target.restore();
}

/** Captura um quadro reduzido e envia o clipe à memória quando estiver completo. */
function captureIntoMemory(nowMs: number, mask: SegmentationMask | null): void {
  const { video } = camera;
  if (video.videoWidth === 0) return;

  drawCoverMirrored(video, captureCtx, captureCanvas.width, captureCanvas.height);
  const frame = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);

  // Só os vestígios no passado (a memória) devem mostrar apenas a
  // silhueta da pessoa (RF04); o reflexo atual continua mostrando tudo,
  // como um espelho de verdade.
  if (mask) applySegmentationToAlpha(frame.data, frame.width, frame.height, mask);

  const masked = mask !== null;
  if (
    pendingEchoClip === null ||
    pendingEchoClip.width !== frame.width ||
    pendingEchoClip.height !== frame.height ||
    pendingEchoClip.masked !== masked ||
    nowMs - lastCaptureMs > effectiveMemoryIntervalMs * 2.5
  ) {
    pendingEchoClip = {
      width: frame.width,
      height: frame.height,
      masked,
      frameCount: 0,
      pixels: new Uint8Array(frame.data.length * ECHO_CLIP_FRAME_COUNT),
    };
  }
  const clip = pendingEchoClip;
  clip.pixels.set(frame.data, clip.frameCount * frame.data.length);
  clip.frameCount++;
  if (clip.frameCount < ECHO_CLIP_FRAME_COUNT) return;

  // Sem segmentação, um eco mais translúcido evita encobrir o reflexo com o fundo antigo.
  engine.insertClip(nowMs, clip.width, clip.height, masked ? 1.0 : 0.35, effectiveMemoryIntervalMs, clip.pixels);
  pendingEchoClip = null;
}

/**
 * Captura um quadro reduzido (já com a máscara de segmentação aplicada)
 * para alimentar o acumulador de rastro de movimento recente — a
 * "memória curta" (ver `renderer.rs`). Roda numa frequência bem maior
 * que `captureIntoMemory`, para o rastro acompanhar o movimento de
 * perto.
 */
function captureTrailFrame(mask: SegmentationMask): void {
  const { video } = camera;
  if (video.videoWidth === 0) return;

  drawCoverMirrored(video, trailCaptureCtx, trailCaptureCanvas.width, trailCaptureCanvas.height);
  const frame = trailCaptureCtx.getImageData(0, 0, trailCaptureCanvas.width, trailCaptureCanvas.height);
  applySegmentationToAlpha(frame.data, frame.width, frame.height, mask);
  trailCaptureCtx.putImageData(frame, 0, 0);
}

/**
 * Sends the current (already-mirrored) frame to the segmentation worker,
 * at its own, slower pace. The result only arrives later, asynchronously
 * — this function never waits for it.
 */
function requestSegmentation(nowMs: number): void {
  const { video } = camera;
  if (video.videoWidth === 0) return;

  drawCoverMirrored(video, segInputCtx, segInputCanvas.width, segInputCanvas.height);
  segmentation.requestSegmentation(segInputCanvas, nowMs);
}

/**
 * Multiplica o canal alfa de `pixels` pela máscara de segmentação mais
 * recente (0.0 = fundo, 1.0 = pessoa).
 */
function applySegmentationToAlpha(pixels: Uint8ClampedArray, width: number, height: number, mask: SegmentationMask): void {
  for (let y = 0; y < height; y++) {
    const maskY = Math.min(mask.height - 1, Math.floor((y / height) * mask.height));
    for (let x = 0; x < width; x++) {
      const maskX = Math.min(mask.width - 1, Math.floor((x / width) * mask.width));
      const confidence = mask.data[maskY * mask.width + maskX];

      const pixelIndex = (y * width + x) * 4 + 3; // canal alfa (R,G,B,A)
      pixels[pixelIndex] = Math.round(pixels[pixelIndex] * confidence);
    }
  }
}

/** Paints every active memory record, oldest first, beneath the live reflection (fallback path only). */
function drawEchoesCanvas2d(activeCount: number): void {
  if (!ctx2d) return;
  for (let i = 0; i < activeCount; i++) {
    const w = engine.activeWidth(i);
    const h = engine.activeHeight(i);
    if (w === 0 || h === 0) continue;

    const pixels = engine.activePixels(i);
    const imageData = new ImageData(new Uint8ClampedArray(pixels), w, h);
    echoCanvas.width = w;
    echoCanvas.height = h;
    echoCtx.putImageData(imageData, 0, 0);

    if (debugForceMagenta) {
      // Diagnóstico: tinge a silhueta (preserva só o formato, via o
      // canal alfa que já veio da segmentação) de magenta sólido, para
      // provar que o eco chegou até aqui.
      echoCtx.save();
      echoCtx.globalCompositeOperation = "source-in";
      echoCtx.fillStyle = "magenta";
      echoCtx.fillRect(0, 0, w, h);
      echoCtx.restore();
    }

    const offsetX = engine.activeOffsetX(i) * canvas.width;
    const offsetY = engine.activeOffsetY(i) * canvas.height;

    // Os ecos vão perdendo a cor conforme envelhecem (mesmo efeito do
    // caminho GPU, feito em WGSL) — dá um ar mais "fantasmagórico" aos
    // vestígios em vez de parecerem só uma cópia atrasada e colorida.
    // Multiplicamos por 2 para já ficarem bem cinza na metade da vida,
    // enquanto ainda estão visíveis (perto do fim, a opacidade já caiu
    // perto de zero e o cinza não seria notado).
    const ageRatioPercent = Math.min(100, Math.round(engine.activeAgeRatio(i) * 200));

    ctx2d.save();
    // No modo de diagnóstico (eco forçado), ignoramos o fade normal e o
    // cinza (que lavaria a cor magenta) para a silhueta ficar sempre
    // bem visível.
    ctx2d.globalAlpha = debugForceMagenta ? 1 : engine.activeOpacity(i);
    ctx2d.filter = debugForceMagenta ? "none" : `grayscale(${ageRatioPercent}%)`;
    ctx2d.translate(offsetX, offsetY);
    ctx2d.drawImage(echoCanvas, 0, 0, canvas.width, canvas.height);
    ctx2d.restore();
  }
}

/** Computes a downscaled width/height that preserves `aspect`, capped at `maxDim` on the long edge. */
function downscaledSize(aspect: number, maxDim: number): { width: number; height: number } {
  if (aspect >= 1) {
    return { width: maxDim, height: Math.max(1, Math.round(maxDim / aspect)) };
  }
  return { width: Math.max(1, Math.round(maxDim * aspect)), height: maxDim };
}

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const aspect = canvas.width / canvas.height;
  const scale = QUALITY_SCALE[performanceManager.qualityLevel].resolution;

  const captureSize = downscaledSize(aspect, Math.max(16, Math.round(config.capture.memoryMaxDim * scale)));
  captureCanvas.width = captureSize.width;
  captureCanvas.height = captureSize.height;

  const trailSize = downscaledSize(aspect, Math.max(16, Math.round(config.trail.captureMaxDim * scale)));
  trailCaptureCanvas.width = trailSize.width;
  trailCaptureCanvas.height = trailSize.height;
  trailAccumFront.width = trailSize.width;
  trailAccumFront.height = trailSize.height;
  trailAccumBack.width = trailSize.width;
  trailAccumBack.height = trailSize.height;

  liveCanvas.width = canvas.width;
  liveCanvas.height = canvas.height;

  const segSize = downscaledSize(aspect, Math.max(32, Math.round(config.capture.segmentationMaxDim * scale)));
  segInputCanvas.width = segSize.width;
  segInputCanvas.height = segSize.height;
}

function errorTitleFor(err: CameraError): string {
  switch (err.kind) {
    case "permission-denied":
      return "Permissão de câmera negada";
    case "not-found":
      return "Câmera não encontrada";
    case "insecure-context":
      return "Conexão não segura";
    case "unsupported":
      return "Navegador incompatível";
    default:
      return "Não foi possível acessar a câmera";
  }
}

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Elemento obrigatório ausente: ${selector}`);
  return el;
}

boot().catch((err) => {
  console.error("[mosaico] falha na inicialização", err);
});
