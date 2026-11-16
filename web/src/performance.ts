// Fica de olho no FPS (quadros por segundo) e decide quando a aplicação
// deve "baixar a qualidade" para continuar funcionando bem em um celular
// mais fraco (seção 9 do enunciado: "degradação progressiva de
// qualidade").
//
// A ideia é simples: guardamos quanto tempo cada quadro demorou, tiramos
// uma média, e se essa média estiver baixa demais por tempo suficiente,
// avisamos quem estiver "escutando" (`onQualityChange`) para que reduza
// a resolução, a frequência da segmentação, etc.

export type QualityLevel = "high" | "medium" | "low";

type QualityChangeListener = (level: QualityLevel) => void;

const WINDOW_SIZE = 90; // quantos quadros guardamos para calcular a média
const DOWNGRADE_COOLDOWN_MS = 8000; // espera pelo menos isso antes de baixar de novo
const HIGH_TO_MEDIUM_FPS = 20;
const MEDIUM_TO_LOW_FPS = 12;

export class PerformanceManager {
  private frameDurationsMs: number[] = [];
  private lastFrameTimeMs: number | null = null;
  private level: QualityLevel = "high";
  private lastDowngradeMs = -Infinity;
  private listeners: QualityChangeListener[] = [];

  get qualityLevel(): QualityLevel {
    return this.level;
  }

  /** Quadros por segundo, com base na média das últimas amostras. 0 se ainda não há dados. */
  get fps(): number {
    if (this.frameDurationsMs.length === 0) return 0;

    let total = 0;
    for (const duration of this.frameDurationsMs) {
      total += duration;
    }
    const average = total / this.frameDurationsMs.length;
    return average > 0 ? 1000 / average : 0;
  }

  onQualityChange(listener: QualityChangeListener): void {
    this.listeners.push(listener);
  }

  /** Deve ser chamado uma vez por quadro, com `performance.now()`. */
  recordFrame(nowMs: number): void {
    if (this.lastFrameTimeMs !== null) {
      const durationMs = nowMs - this.lastFrameTimeMs;
      this.frameDurationsMs.push(durationMs);
      if (this.frameDurationsMs.length > WINDOW_SIZE) {
        this.frameDurationsMs.shift();
      }
    }
    this.lastFrameTimeMs = nowMs;

    this.maybeDowngrade(nowMs);
  }

  /** Limpa as amostras (chamado ao reiniciar a sessão). */
  reset(): void {
    this.frameDurationsMs = [];
    this.lastFrameTimeMs = null;
  }

  private maybeDowngrade(nowMs: number): void {
    if (this.level === "low") return; // já está no mínimo, não tem para onde cair
    if (this.frameDurationsMs.length < WINDOW_SIZE) return; // ainda não temos amostras suficientes
    if (nowMs - this.lastDowngradeMs < DOWNGRADE_COOLDOWN_MS) return; // evita ficar trocando de qualidade toda hora

    const currentFps = this.fps;
    const shouldDowngradeFromHigh = this.level === "high" && currentFps < HIGH_TO_MEDIUM_FPS;
    const shouldDowngradeFromMedium = this.level === "medium" && currentFps < MEDIUM_TO_LOW_FPS;

    if (!shouldDowngradeFromHigh && !shouldDowngradeFromMedium) return;

    this.level = this.level === "high" ? "medium" : "low";
    this.lastDowngradeMs = nowMs;
    this.frameDurationsMs = []; // reavalia do zero no novo nível de qualidade

    for (const listener of this.listeners) {
      listener(this.level);
    }
  }
}

/**
 * Fatores de escala aplicados aos valores de `config/effects.json` em
 * cada nível de qualidade. 1.0 significa "sem mudança".
 */
export const QUALITY_SCALE: Record<QualityLevel, { resolution: number; capacity: number; segmentationInterval: number }> = {
  high: { resolution: 1.0, capacity: 1.0, segmentationInterval: 1.0 },
  medium: { resolution: 0.7, capacity: 0.7, segmentationInterval: 1.5 },
  low: { resolution: 0.45, capacity: 0.4, segmentationInterval: 2.5 },
};
