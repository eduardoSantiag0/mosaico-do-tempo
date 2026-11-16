import initEngine, { Engine, Renderer, engine_version } from "./wasm/mosaico_engine.js";
import { CameraController, CameraError } from "./camera.js";
import { UI } from "./ui.js";

const canvas = required<HTMLCanvasElement>("#stage");

const ui = new UI();
const camera = new CameraController();
let engine: Engine;

// Se o navegador não tiver WebGPU nem WebGL2 suficiente, caímos de volta
// para um desenho mais simples em Canvas 2D (RF: "fallback funcional para
// navegadores incompatíveis"). Só um dos dois modos é usado por vez,
// porque um <canvas> só pode ter um tipo de contexto de desenho.
type RenderMode = "gpu" | "canvas2d";
let renderMode: RenderMode = "gpu";
let gpuRenderer: Renderer | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;

// Memory captures are taken at a low, fixed resolution — never the full
// camera frame — to keep per-record cost small across up to ~120s of history.
const CAPTURE_MAX_DIM = 96;
const CAPTURE_INTERVAL_MS = 80;
const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true })!;
const echoCanvas = document.createElement("canvas");
const echoCtx = echoCanvas.getContext("2d")!;
let lastCaptureMs = -Infinity;

// The live reflection is captured at a higher resolution than memory
// echoes (for sharpness), but still capped well below the full device
// resolution to keep the CPU readback (getImageData) affordable every frame.
const LIVE_MAX_DIM = 640;
const liveCanvas = document.createElement("canvas");
const liveCtx = liveCanvas.getContext("2d", { willReadFrequently: true })!;

let rafHandle = 0;
let running = false;

async function boot(): Promise<void> {
  await initEngine();
  engine = new Engine();
  console.info(`[mosaico] engine wasm v${engine_version()} carregado`);

  resizeCanvas();
  await initRenderer();

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
    ctx2d = canvas.getContext("2d", { alpha: false });
    renderMode = "canvas2d";
  }
}

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
}

function stopExperience(): void {
  pauseLoop();
  camera.stop();
  engine.reset();
  lastCaptureMs = -Infinity;
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

  if (now - lastCaptureMs >= CAPTURE_INTERVAL_MS) {
    captureIntoMemory(now);
    lastCaptureMs = now;
  }

  const activeCount = engine.update(now);

  try {
    if (renderMode === "gpu" && gpuRenderer) {
      renderWithGpu(activeCount, now);
    } else if (ctx2d) {
      renderWithCanvas2d(activeCount);
    }
  } catch (err) {
    // Um erro isolado de um quadro não deve travar a experiência: o
    // reflexo precisa continuar aparecendo nos próximos quadros.
    console.error("[mosaico] erro ao desenhar o quadro:", err);
  }

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
  drawEchoesCanvas2d(activeCount);
  drawCoverMirrored(camera.video, ctx2d, canvas.width, canvas.height);
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
  const bytes = new Uint8Array(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
  engine.insertFrame(nowMs, frame.width, frame.height, 1.0, bytes);
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

  const captureSize = downscaledSize(aspect, CAPTURE_MAX_DIM);
  captureCanvas.width = captureSize.width;
  captureCanvas.height = captureSize.height;

  const liveSize = downscaledSize(aspect, LIVE_MAX_DIM);
  liveCanvas.width = liveSize.width;
  liveCanvas.height = liveSize.height;
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
