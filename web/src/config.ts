// Carrega os parâmetros artísticos de `config/effects.json` (ver seção 8
// do enunciado). A ideia é que esses números possam mudar sem precisar
// editar o código — nem o TypeScript, nem os shaders em Rust.

export interface MemoryLayerConfig {
  captureIntervalMs: number;
  maxAgeMs: number;
  capacity: number;
  baseWeight: number;
  fadePower: number;
  driftAmount: number;
}

export interface EffectsConfig {
  underwaterIntensity: number;
  underwaterFrequency: number;
  underwaterSpeed: number;
  underwaterAmplitude: number;
  dissolveFragmentation: number;
  additiveEchoes: boolean;
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
    short: MemoryLayerConfig;
    intermediate: MemoryLayerConfig;
    long: MemoryLayerConfig;
  };
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
    short: { captureIntervalMs: 80, maxAgeMs: 5000, capacity: 48, baseWeight: 0.9, fadePower: 1.0, driftAmount: 0.0 },
    intermediate: { captureIntervalMs: 600, maxAgeMs: 30000, capacity: 50, baseWeight: 0.55, fadePower: 1.4, driftAmount: 0.03 },
    long: { captureIntervalMs: 4000, maxAgeMs: 120000, capacity: 30, baseWeight: 0.3, fadePower: 2.4, driftAmount: 0.06 },
  },
  effects: {
    underwaterIntensity: 0.35,
    underwaterFrequency: 2.2,
    underwaterSpeed: 0.6,
    underwaterAmplitude: 0.015,
    dissolveFragmentation: 0.6,
    additiveEchoes: false,
  },
  capture: {
    memoryMaxDim: 96,
    memoryIntervalMs: 80,
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
