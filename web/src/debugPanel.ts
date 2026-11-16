import type { EffectsConfig } from "./config.js";

export interface DebugStats {
  fps: number;
  totalMemoryBytes: number;
  activeRecordCount: number;
  renderMode: string;
  qualityLevel: string;
}

/**
 * Painel de depuração (RF09/seção 8): mostra diagnóstico de desempenho e
 * deixa ajustar os parâmetros dos efeitos em tempo real. Só deve existir
 * durante o desenvolvimento — na versão de exposição, `config.devPanel.enabled`
 * deve ser `false` (ver `config/effects.json`).
 */
export class DebugPanel {
  private container: HTMLElement;
  private effects: EffectsConfig;
  private onEffectsChange: (effects: EffectsConfig) => void;
  private statsEl: HTMLElement;

  constructor(container: HTMLElement, initialEffects: EffectsConfig, onEffectsChange: (effects: EffectsConfig) => void) {
    this.container = container;
    this.effects = { ...initialEffects };
    this.onEffectsChange = onEffectsChange;
    this.statsEl = document.createElement("div");
    this.render();
  }

  updateStats(stats: DebugStats): void {
    const memoryKb = Math.round(stats.totalMemoryBytes / 1024);
    this.statsEl.textContent =
      `FPS ${stats.fps.toFixed(1)} · memória ${memoryKb}KB · ` +
      `ativos ${stats.activeRecordCount} · render ${stats.renderMode} · qualidade ${stats.qualityLevel}`;
  }

  private render(): void {
    this.container.innerHTML = "";
    this.container.appendChild(this.statsEl);

    this.addSlider("Deslocamento: intensidade", 0, 1, 0.01, this.effects.displacementIntensity, (v) => {
      this.effects.displacementIntensity = v;
      this.emit();
    });
    this.addSlider("Deslocamento: frequência", 0, 8, 0.1, this.effects.displacementFrequency, (v) => {
      this.effects.displacementFrequency = v;
      this.emit();
    });
    this.addSlider("Deslocamento: velocidade", 0, 3, 0.05, this.effects.displacementSpeed, (v) => {
      this.effects.displacementSpeed = v;
      this.emit();
    });
    this.addSlider("Deslocamento: amplitude", 0, 0.08, 0.001, this.effects.displacementAmplitude, (v) => {
      this.effects.displacementAmplitude = v;
      this.emit();
    });
    this.addSlider("Dissolução: fragmentação", 0, 1, 0.01, this.effects.dissolveFragmentation, (v) => {
      this.effects.dissolveFragmentation = v;
      this.emit();
    });
    this.addSlider("Rastro: decaimento/s", 0, 4, 0.05, this.effects.trailDecayPerSecond, (v) => {
      this.effects.trailDecayPerSecond = v;
      this.emit();
    });
    this.addSlider("Rastro: opacidade da captura", 0, 1, 0.01, this.effects.trailCaptureOpacity, (v) => {
      this.effects.trailCaptureOpacity = v;
      this.emit();
    });
    this.addCheckbox("Mistura aditiva nos ecos", this.effects.additiveEchoes, (v) => {
      this.effects.additiveEchoes = v;
      this.emit();
    });
  }

  private emit(): void {
    this.onEffectsChange(this.effects);
  }

  private addSlider(labelText: string, min: number, max: number, step: number, value: number, onChange: (value: number) => void): void {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = `${labelText}: ${value.toFixed(3)}`;

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.addEventListener("input", () => {
      const newValue = Number(input.value);
      span.textContent = `${labelText}: ${newValue.toFixed(3)}`;
      onChange(newValue);
    });

    label.appendChild(span);
    label.appendChild(input);
    this.container.appendChild(label);
  }

  private addCheckbox(labelText: string, checked: boolean, onChange: (checked: boolean) => void): void {
    const label = document.createElement("label");
    const span = document.createElement("span");
    span.textContent = labelText;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.addEventListener("change", () => onChange(input.checked));

    label.appendChild(span);
    label.appendChild(input);
    this.container.appendChild(label);
  }
}
