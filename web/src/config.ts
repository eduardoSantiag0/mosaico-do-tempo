// Carrega os parâmetros artísticos de `config/effects.json`. A ideia é
// que esses números possam mudar sem precisar editar o código — nem o
// TypeScript, nem os shaders em Rust.

export interface MemoryLayerConfig {
  captureIntervalMs: number;
  maxAgeMs: number;
  capacity: number;
  baseWeight: number;
  fadePower: number;
  driftAmount: number;
  /// 0.0 desliga o efeito de "reaparecimentos ocasionais" (fade liso).
  reappearanceStrength: number;
  reappearanceFrequency: number;
}

/** Cadência/resolução (só do lado do JavaScript) com que alimentamos o acumulador de rastro na GPU. */
export interface TrailCaptureConfig {
  captureMaxDim: number;
  captureIntervalMs: number;
}

export interface EffectsConfig {
  displacementIntensity: number;
  displacementFrequency: number;
  displacementSpeed: number;
  displacementAmplitude: number;
  dissolveFragmentation: number;
  /** Força mínima do deslocamento aplicado a um eco, mesmo recém-nascido (0 = idade controla tudo). */
  echoDisplacementFloor: number;
  additiveEchoes: boolean;
  /** O quanto o acumulador de rastro "esquece" por segundo. */
  trailDecayPerSecond: number;
  /** Opacidade com que cada captura nova é somada ao acumulador de rastro. */
  trailCaptureOpacity: number;
  /** Taxa de esquecimento da camada PROFUNDA do rastro ("mar de Solaris") — bem menor que trailDecayPerSecond. */
  trailDeepDecayPerSecond: number;
  /** Opacidade com que cada captura nova é somada à camada profunda. */
  trailDeepCaptureOpacity: number;
  /** Opacidade mínima ABSOLUTA que um ponto mantém para sempre, depois de receber presença uma vez — é isso que faz a camada nunca desaparecer de verdade. */
  trailDeepFloorAbsolute: number;
  /** Fração mínima (relativa ao valor atual, já com o piso acima) que a oscilação desce até, antes de voltar a subir. */
  trailDeepFloorRatio: number;
  /** Período (segundos) de um ciclo completo de "esmaecer e voltar" da camada profunda. */
  trailOscillationPeriodSeconds: number;
  /** Frequência espacial da distorção dedicada ao rastro (mais baixa que a do reflexo/ecos). */
  trailDisplacementFrequency: number;
  /** Velocidade da distorção dedicada ao rastro (mais lenta que a do reflexo/ecos). */
  trailDisplacementSpeed: number;
  /** Amplitude da distorção dedicada ao rastro (maior que a do reflexo/ecos). */
  trailDisplacementAmplitude: number;
}

export interface CaptureConfig {
  memoryMaxDim: number;
  memoryIntervalMs: number;
  liveMaxDim: number;
  segmentationMaxDim: number;
  segmentationIntervalMs: number;
}

export interface AppConfig {
  memory: {
    intermediate: MemoryLayerConfig;
    long: MemoryLayerConfig;
  };
  trail: TrailCaptureConfig;
  effects: EffectsConfig;
  capture: CaptureConfig;
  devPanel: { enabled: boolean };
}

/**
 * Valores usados se `config/effects.json` não puder ser carregado (por
 * exemplo, numa rede muito instável). A aplicação nunca deve travar só
 * porque a configuração não chegou — ela continua funcionando com estes
 * valores padrão.
 */
const FALLBACK_CONFIG: AppConfig = {
  memory: {
    intermediate: {
      captureIntervalMs: 1857,
      maxAgeMs: 26000,
      capacity: 14,
      baseWeight: 0.42,
      fadePower: 1.4,
      driftAmount: 0.025,
      reappearanceStrength: 0.0,
      reappearanceFrequency: 0.0,
    },
    long: {
      captureIntervalMs: 13750,
      maxAgeMs: 110000,
      capacity: 8,
      baseWeight: 0.2,
      fadePower: 2.0,
      driftAmount: 0.05,
      reappearanceStrength: 0.65,
      reappearanceFrequency: 0.0003926991,
    },
  },
  trail: {
    captureMaxDim: 192,
    captureIntervalMs: 90,
  },
  effects: {
    displacementIntensity: 0.4,
    displacementFrequency: 2.0,
    displacementSpeed: 0.45,
    displacementAmplitude: 0.018,
    dissolveFragmentation: 0.55,
    echoDisplacementFloor: 0.45,
    additiveEchoes: false,
    trailDecayPerSecond: 0.4,
    trailCaptureOpacity: 0.4,
    trailDeepDecayPerSecond: 0.006,
    trailDeepCaptureOpacity: 0.18,
    trailDeepFloorAbsolute: 0.12,
    trailDeepFloorRatio: 0.35,
    trailOscillationPeriodSeconds: 30.0,
    trailDisplacementFrequency: 0.7,
    trailDisplacementSpeed: 0.12,
    trailDisplacementAmplitude: 0.045,
  },
  capture: {
    memoryMaxDim: 160,
    memoryIntervalMs: 500,
    liveMaxDim: 1280,
    segmentationMaxDim: 256,
    segmentationIntervalMs: 200,
  },
  devPanel: { enabled: true },
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch("/config/effects.json");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const loaded = (await response.json()) as AppConfig;
    return loaded;
  } catch (err) {
    console.warn("[mosaico] não foi possível carregar config/effects.json, usando valores padrão:", err);
    return FALLBACK_CONFIG;
  }
}
