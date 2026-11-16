export type CameraErrorKind = "permission-denied" | "not-found" | "insecure-context" | "unsupported" | "unknown";

export class CameraError extends Error {
  kind: CameraErrorKind;
  constructor(kind: CameraErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Owns the front-camera video stream. Does not touch the DOM beyond the
 * hidden <video> element it creates to decode frames.
 */
export class CameraController {
  readonly video: HTMLVideoElement;
  private stream: MediaStream | null = null;

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
    this.video.autoplay = true;
  }

  get isActive(): boolean {
    return this.stream !== null;
  }

  get width(): number {
    return this.video.videoWidth;
  }

  get height(): number {
    return this.video.videoHeight;
  }

  async start(): Promise<void> {
    if (!window.isSecureContext) {
      throw new CameraError(
        "insecure-context",
        "A câmera só pode ser usada em uma conexão segura (HTTPS).",
      );
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new CameraError(
        "unsupported",
        "Este navegador não oferece suporte à captura de câmera.",
      );
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
        audio: false,
      });
    } catch (err) {
      throw this.toCameraError(err);
    }

    this.video.srcObject = this.stream;
    try {
      await this.video.play();
    } catch (err) {
      // Alguns navegadores bloqueiam o autoplay até um gesto do usuário;
      // o clique no botão "Iniciar" já deveria contar como esse gesto,
      // mas registramos o erro para facilitar o diagnóstico caso não
      // conte em algum navegador específico.
      console.warn("[mosaico] video.play() falhou:", err);
    }

    await this.waitForDimensions();
  }

  stop(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  private waitForDimensions(): Promise<void> {
    if (this.video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.video.addEventListener(
        "loadedmetadata",
        () => resolve(),
        { once: true },
      );
    });
  }

  private toCameraError(err: unknown): CameraError {
    if (err instanceof DOMException) {
      if (err.name === "NotAllowedError" || err.name === "SecurityError") {
        return new CameraError("permission-denied", "Permissão de câmera negada.");
      }
      if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
        return new CameraError("not-found", "Nenhuma câmera frontal foi encontrada.");
      }
    }
    return new CameraError("unknown", String(err));
  }
}
