import initEngine, { Engine, Renderer, engine_version } from "./wasm/mosaico_engine.js";
import { CameraController, CameraError } from "./camera.js";
import { SegmentationService } from "./segmentation.js";
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

type RenderMode = "gpu" | "canvas2d";
let renderMode: RenderMode = "gpu";
let gpuRenderer: Renderer | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let consecutiveGpuFailures = 0;
const MAX_CONSECUTIVE_GPU_FAILURES = 5;

// Estes três offscreen canvases guardam, respectivamente: o quadro
// reduzido usado para a memória temporal, o quadro (um pouco maior) usado
// para o reflexo atual, e o quadro usado como entrada da segmentação.
// Seus tamanhos são recalculados por `resizeCanvas()` a partir de
// `config.capture`, ajustado pelo nível de qualidade atual (ver
// performance.ts).
const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true })!;
const liveCanvas = document.createElement("canvas");
const liveCtx = liveCanvas.getContext("2d", { willReadFrequently: true })!;
const segInputCanvas = document.createElement("canvas");
const segInputCtx = segInputCanvas.getContext("2d", { willReadFrequently: true })!;
const echoCanvas = document.createElement("canvas");
const echoCtx = echoCanvas.getContext("2d")!;

let lastCaptureMs = -Infinity;
let lastSegmentationRequestMs = -Infinity;
let effectiveMemoryIntervalMs = 80;
let effectiveSegmentationIntervalMs = 200;

let rafHandle = 0;
let running = false;

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
  if (!config.devPanel.enabled) return;

  debugPanel = new DebugPanel(ui.debugPanel, currentEffects, (effects) => {
    currentEffects = effects;
    applyEffectsToRenderer(currentEffects);
  });

  // O painel fica escondido por padrão mesmo quando habilitado; a tecla
  // "d" alterna sua visibilidade (RF09: "pode ser habilitado durante o
  // desenvolvimento").
  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() !== "d") return;
    const nowHidden = ui.debugPanel.classList.contains("hidden");
    ui.setDebugVisible(nowHidden);
  });
}

/** Aplica os parâmetros de RF06/RF07/RF08 ao renderer (sem efeito no fallback Canvas 2D). */
function applyEffectsToRenderer(effects: EffectsConfig): void {
  if (!gpuRenderer) return;
  gpuRenderer.configureEffects(
    effects.underwaterIntensity,
    effects.underwaterFrequency,
    effects.underwaterSpeed,
    effects.underwaterAmplitude,
    effects.dissolveFragmentation,
  );
  gpuRenderer.setAdditiveEchoes(effects.additiveEchoes);
}

/** Repassa a configuração de cada camada de memória (RF03) para o motor em Rust. */
function applyMemoryLayerConfig(layer: MemoryLayerConfig, name: "short" | "intermediate" | "long", capacityScale: number): void {
  const capacity = Math.max(4, Math.round(layer.capacity * capacityScale));
  engine.configureLayer(name, capacity, layer.captureIntervalMs, layer.maxAgeMs, layer.baseWeight, layer.fadePower, layer.driftAmount);
}

/**
 * Aplica um nível de qualidade (seção 9: "degradação progressiva"),
 * recalculando resoluções de captura, frequência da segmentação e
 * capacidade das camadas de memória a partir dos valores "base" de
 * `config/effects.json`, multiplicados pelos fatores de `QUALITY_SCALE`.
 */
function applyQualityLevel(level: QualityLevel): void {
  const scale = QUALITY_SCALE[level];

  effectiveMemoryIntervalMs = config.capture.memoryIntervalMs;
  effectiveSegmentationIntervalMs = Math.round(config.capture.segmentationIntervalMs * scale.segmentationInterval);

  resizeCanvas();

  applyMemoryLayerConfig(config.memory.short, "short", scale.capacity);
  applyMemoryLayerConfig(config.memory.intermediate, "intermediate", scale.capacity);
  applyMemoryLayerConfig(config.memory.long, "long", scale.capacity);

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
  performanceManager.reset();
  lastCaptureMs = -Infinity;
  lastSegmentationRequestMs = -Infinity;
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
  performanceManager.recordFrame(now);

  if (now - lastCaptureMs >= effectiveMemoryIntervalMs) {
    captureIntoMemory(now);
    lastCaptureMs = now;
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
      renderWithCanvas2d(activeCount);
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

  rafHandle = requestAnimationFrame(renderFrame);
}

/** Caminho principal: desenha tudo na GPU (WebGPU/WebGL2) através do Renderer em Rust. */
function renderWithGpu(_activeCount: number, nowMs: number): void {
  const { video } = camera;
  if (video.videoWidth === 0 || !gpuRenderer) return;

  drawCoverMirrored(video, liveCtx, liveCanvas.width, liveCanvas.height);
  const liveFrame = liveCtx.getImageData(0, 0, liveCanvas.width, liveCanvas.height);
  const liveBytes = new Uint8Array(liveFrame.data.buffer, liveFrame.data.byteOffset, liveFrame.data.byteLength);

  gpuRenderer.render(engine, nowMs, liveCanvas.width, liveCanvas.height, liveBytes);
}

/** Caminho alternativo (sem WebGPU/WebGL2 suficiente): tudo desenhado em Canvas 2D na CPU. */
function renderWithCanvas2d(activeCount: number): void {
  if (!ctx2d) return;
  // O reflexo atual é a base (preenche a tela inteira, sem transparência);
  // os ecos são desenhados DEPOIS, por cima, com opacidade parcial. Na
  // ordem contrária, o reflexo cobriria os ecos por completo.
  drawCoverMirrored(camera.video, ctx2d, canvas.width, canvas.height);
  drawEchoesCanvas2d(activeCount);
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

  const targetAspect = targetW / targetH;
  const sourceAspect = sourceW / sourceH;

  let sx: number, sy: number, sw: number, sh: number;
  if (sourceAspect > targetAspect) {
    sh = sourceH;
    sw = sh * targetAspect;
    sx = (sourceW - sw) / 2;
    sy = 0;
  } else {
    sw = sourceW;
    sh = sw / targetAspect;
    sx = 0;
    sy = (sourceH - sh) / 2;
  }

  target.save();
  target.translate(targetW, 0);
  target.scale(-1, 1);
  target.drawImage(source, sx, sy, sw, sh, 0, 0, targetW, targetH);
  target.restore();
}

/** Downsamples the current (already-mirrored) frame and stores it in the engine. */
function captureIntoMemory(nowMs: number): void {
  const { video } = camera;
  if (video.videoWidth === 0) return;

  drawCoverMirrored(video, captureCtx, captureCanvas.width, captureCanvas.height);
  const frame = captureCtx.getImageData(0, 0, captureCanvas.width, captureCanvas.height);

  // Só os vestígios no passado (a memória) devem mostrar apenas a
  // silhueta da pessoa (RF04); o reflexo atual continua mostrando tudo,
  // como um espelho de verdade.
  applySegmentationToAlpha(frame.data, frame.width, frame.height);

  const bytes = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  engine.insertFrame(nowMs, frame.width, frame.height, 1.0, bytes);
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
 * recente (0.0 = fundo, 1.0 = pessoa). Se ainda não houver nenhuma
 * máscara disponível (modelo carregando, por exemplo), não faz nada — a
 * imagem continua com alfa cheio, exatamente como antes da Etapa 4
 * (RF04: a aplicação deve continuar funcionando mesmo sem segmentação).
 */
function applySegmentationToAlpha(pixels: Uint8ClampedArray, width: number, height: number): void {
  const mask = segmentation.getLatestMask();
  if (!mask) return;

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

    const offsetX = engine.activeOffsetX(i) * canvas.width;
    const offsetY = engine.activeOffsetY(i) * canvas.height;

    ctx2d.save();
    ctx2d.globalAlpha = engine.activeOpacity(i);
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

  const liveSize = downscaledSize(aspect, Math.max(64, Math.round(config.capture.liveMaxDim * scale)));
  liveCanvas.width = liveSize.width;
  liveCanvas.height = liveSize.height;

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
