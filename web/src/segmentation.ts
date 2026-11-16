import type { RequestMessage, ResponseMessage } from "./workers/segmentation.worker.js";

/** A segmentation mask: one confidence value (0..1, "é uma pessoa?") por pixel. */
export interface SegmentationMask {
  width: number;
  height: number;
  data: Float32Array;
}

/**
 * Fala com o Web Worker que roda o MediaPipe (RF04). Esta classe não faz
 * nenhuma conta de visão computacional sozinha — ela só manda quadros
 * para o worker e guarda a máscara mais recente que ele devolveu.
 *
 * Importante: a segmentação é mais lenta que o loop de renderização, e
 * roda numa frequência própria. Por isso `getLatestMask()` pode devolver
 * `null` (ainda não chegou nenhuma máscara) ou uma máscara "velha" (de um
 * quadro um pouco anterior) — e isso é esperado, não um erro.
 */
export class SegmentationService {
  private worker: Worker;
  private ready = false;
  private busy = false;
  private nextRequestId = 0;
  private latestMask: SegmentationMask | null = null;

  constructor() {
    this.worker = new Worker(new URL("./workers/segmentation.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (event: MessageEvent<ResponseMessage>) => this.handleMessage(event.data);
    this.postToWorker({ type: "init" });
  }

  get isReady(): boolean {
    return this.ready;
  }

  getLatestMask(): SegmentationMask | null {
    return this.latestMask;
  }

  /**
   * Manda um novo quadro para o worker segmentar, mas só se o worker já
   * estiver livre (não processando um pedido anterior). Pode ser chamado
   * em todo quadro de renderização sem medo — na maioria das vezes não
   * faz nada, e é exatamente isso que faz a segmentação "não bloquear
   * continuamente a interface".
   */
  requestSegmentation(source: HTMLCanvasElement, timestampMs: number): void {
    if (!this.ready || this.busy) return;

    this.busy = true;
    const requestId = this.nextRequestId++;

    createImageBitmap(source)
      .then((bitmap) => {
        this.postToWorker({ type: "segment", requestId, bitmap, timestampMs }, [bitmap]);
      })
      .catch((err) => {
        console.warn("[mosaico] falha ao preparar quadro para segmentação:", err);
        this.busy = false;
      });
  }

  /** Libera o worker. Deve ser chamado quando a experiência termina (RF10). */
  dispose(): void {
    this.worker.terminate();
    this.latestMask = null;
    this.ready = false;
  }

  private handleMessage(message: ResponseMessage): void {
    if (message.type === "ready") {
      this.ready = true;
      return;
    }

    if (message.type === "mask") {
      this.latestMask = { width: message.width, height: message.height, data: message.data };
      this.busy = false;
      return;
    }

    // message.type === "error": registramos no console, mas não travamos
    // nada — o reflexo continua aparecendo normalmente, só sem o efeito
    // de silhueta nos vestígios até a próxima máscara chegar.
    console.warn("[mosaico] segmentação:", message.message);
    this.busy = false;
  }

  private postToWorker(message: RequestMessage, transfer: Transferable[] = []): void {
    this.worker.postMessage(message, transfer);
  }
}
