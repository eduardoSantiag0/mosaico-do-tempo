import initEngine, { Engine, engine_version } from "./wasm/mosaico_engine.js";
import { CameraController, CameraError } from "./camera.js";
import { UI } from "./ui.js";

const canvas = required<HTMLCanvasElement>("#stage");
const ctx = canvas.getContext("2d", { alpha: false });
if (!ctx) throw new Error("Canvas 2D não disponível.");

const ui = new UI();
const camera = new CameraController();
let engine: Engine;

// Memory captures are taken at a low, fixed resolution — never the full
// camera frame — to keep per-record cost small across up to ~120s of history.
const CAPTURE_MAX_DIM = 96;
const CAPTURE_INTERVAL_MS = 80;
const captureCanvas = document.createElement("canvas");
const captureCtx = captureCanvas.getContext("2d", { willReadFrequently: true })!;
const echoCanvas = document.createElement("canvas");
const echoCtx = echoCanvas.getContext("2d")!;
let lastCaptureMs = -Infinity;

let rafHandle = 0;
let running = false;

async function boot(): Promise<void> {
  await initEngine();
  engine = new Engine();
  console.info(`[mosaico] engine wasm v${engine_version()} carregado`);

  ui.onStart(() => void startExperience());
  ui.onRetry(() => void startExperience());
  ui.onExit(() => stopExperience());

  window.addEventListener("resize", resizeCanvas);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      pauseLoop();
    } else if (camera.isActive) {
      resumeLoop();
    }
  });

  resizeCanvas();
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
  resizeCanvas();
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
  drawEchoes(activeCount);
  drawCoverMirrored(camera.video, ctx!, canvas.width, canvas.height);

  rafHandle = requestAnimationFrame(renderFrame);
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

/** Paints every active memory record, oldest first, beneath the live reflection. */
function drawEchoes(activeCount: number): void {
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

    ctx!.save();
    ctx!.globalAlpha = engine.activeOpacity(i);
    ctx!.translate(offsetX, offsetY);
    ctx!.drawImage(echoCanvas, 0, 0, canvas.width, canvas.height);
    ctx!.restore();
  }
}

function resizeCanvas(): void {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);

  const captureAspect = canvas.width / canvas.height;
  if (captureAspect >= 1) {
    captureCanvas.width = CAPTURE_MAX_DIM;
    captureCanvas.height = Math.max(1, Math.round(CAPTURE_MAX_DIM / captureAspect));
  } else {
    captureCanvas.height = CAPTURE_MAX_DIM;
    captureCanvas.width = Math.max(1, Math.round(CAPTURE_MAX_DIM * captureAspect));
  }
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
