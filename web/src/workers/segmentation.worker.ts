// Este arquivo roda dentro de um Web Worker: uma "thread" separada do
// JavaScript principal da página. Fazemos isso porque a segmentação (ver
// RF04) usa um modelo de IA relativamente pesado, e rodar isso na thread
// principal deixaria a página travando (o "não bloquear continuamente a
// interface" do enunciado).
//
// A comunicação entre a página e o worker é só por mensagens
// (`postMessage`/`onmessage`), que é como workers conversam com o resto
// da aplicação.

import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

export type RequestMessage =
  | { type: "init" }
  | { type: "segment"; requestId: number; bitmap: ImageBitmap; timestampMs: number };

export type ResponseMessage =
  | { type: "ready" }
  | { type: "mask"; requestId: number; width: number; height: number; data: Float32Array }
  | { type: "error"; message: string };

let segmenter: ImageSegmenter | null = null;

self.onmessage = async (event: MessageEvent<RequestMessage>) => {
  const message = event.data;

  if (message.type === "init") {
    try {
      await setup();
      post({ type: "ready" });
    } catch (err) {
      post({ type: "error", message: `falha ao carregar o modelo de segmentação: ${String(err)}` });
    }
    return;
  }

  if (message.type === "segment") {
    handleSegmentRequest(message);
  }
};

async function setup(): Promise<void> {
  const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");

  segmenter = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: "/models/selfie_segmenter.tflite",
      delegate: "GPU",
    },
    runningMode: "VIDEO",
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
}

function handleSegmentRequest(message: { requestId: number; bitmap: ImageBitmap; timestampMs: number }): void {
  if (!segmenter) {
    // O modelo ainda não carregou (ou falhou ao carregar). Isso não deve
    // travar a experiência: quem está esperando a máscara vai apenas
    // continuar sem segmentação até ela chegar (RF04).
    message.bitmap.close();
    post({ type: "error", message: "o segmentador ainda não está pronto" });
    return;
  }

  try {
    segmenter.segmentForVideo(message.bitmap, message.timestampMs, (result) => {
      // O modelo selfie_segmenter.tflite tem uma ÚNICA categoria (confira
      // o labelmap embutido no próprio arquivo: ele é um .tflite com
      // metadados em zip, contendo um labels.txt com apenas a linha
      // "selfie"). Por isso `confidenceMasks` só tem um elemento, e ele
      // já é a confiança de "é pessoa" — não existe um índice separado
      // para "fundo". Não confundir com o modelo selfie_multiclass (6
      // categorias) ou com o modelo de segmentação de cabelo, que têm
      // mais de uma entrada em `confidenceMasks`.
      const mask = result.confidenceMasks?.[0];
      if (!mask) {
        post({ type: "error", message: "nenhuma máscara de confiança foi retornada" });
        return;
      }

      // `getAsFloat32Array` copia os dados para um array comum (não
      // depende mais da GPU), então podemos mandar essa cópia de volta
      // para a thread principal sem problema.
      const data = mask.getAsFloat32Array();
      post({ type: "mask", requestId: message.requestId, width: mask.width, height: mask.height, data }, [data.buffer]);

      result.close();
    });
  } catch (err) {
    post({ type: "error", message: `falha ao segmentar o quadro: ${String(err)}` });
  } finally {
    message.bitmap.close();
  }
}

function post(message: ResponseMessage, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}
