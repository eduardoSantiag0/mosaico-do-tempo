import type { EffectsConfig } from "./config.js";

export interface DebugStats {
  fps: number;
  totalMemoryBytes: number;
  activeRecordCount: number;
  renderMode: string;
  qualityLevel: string;
}

/** Contagem de registros ativos por camada, para a visualização de memória temporal. */
export interface LayerCounts {
  intermediate: number;
  long: number;
}

export interface DiagnosticsInfo {
  backendName: string;
  buildId: string;
  liveWidth: number;
  liveHeight: number;
  layerCounts: LayerCounts;
  segmentationReady: boolean;
  /** `queue.submit()` por quadro no caminho GPU; `null` no fallback Canvas2D (não existe lá). */
  submitCount: number | null;
}

/**
 * Painel de depuração: mostra diagnóstico de desempenho e deixa ajustar
 * os parâmetros dos efeitos em tempo real. Só deve existir durante o
 * desenvolvimento — na versão de exposição, `config.devPanel.enabled`
 * deve ser `false` (ver `config/effects.json`).
 *
 * Quando a URL tem `?debug=true`, uma seção extra de DIAGNÓSTICO aparece
 * (máscara de segmentação, contagem de memórias, eco forçado em magenta,
 * distorção forçada, backend/versão) — pensada para descobrir rapidamente
 * em qual etapa do pipeline um efeito parou de funcionar, em vez de só
 * confiar que "deveria estar funcionando" porque o código não lançou erro.
 */
export class DebugPanel {
  private container: HTMLElement;
  private effects: EffectsConfig;
  private diagnosticsEnabled: boolean;
  private onEffectsChange: (effects: EffectsConfig) => void;
  private onDebugFlagsChange: (forceMagenta: boolean, forceDistortion: boolean) => void;

  private statsEl: HTMLElement;
  private diagnosticsEl: HTMLElement | null = null;
  maskPreviewCanvas: HTMLCanvasElement | null = null;

  constructor(
    container: HTMLElement,
    initialEffects: EffectsConfig,
    diagnosticsEnabled: boolean,
    onEffectsChange: (effects: EffectsConfig) => void,
    onDebugFlagsChange: (forceMagenta: boolean, forceDistortion: boolean) => void,
  ) {
    this.container = container;
    this.effects = { ...initialEffects };
    this.diagnosticsEnabled = diagnosticsEnabled;
    this.onEffectsChange = onEffectsChange;
    this.onDebugFlagsChange = onDebugFlagsChange;
    this.statsEl = document.createElement("div");
    this.render();
  }

  updateStats(stats: DebugStats): void {
    const memoryKb = Math.round(stats.totalMemoryBytes / 1024);
    this.statsEl.textContent =
      `FPS ${stats.fps.toFixed(1)} · memória ${memoryKb}KB · ` +
      `ativos ${stats.activeRecordCount} · render ${stats.renderMode} · qualidade ${stats.qualityLevel}`;
  }

  /** Só tem efeito quando `diagnosticsEnabled` (`?debug=true`). */
  updateDiagnostics(info: DiagnosticsInfo): void {
    if (!this.diagnosticsEl) return;
    this.diagnosticsEl.textContent =
      `backend: ${info.backendName} · build: ${info.buildId} · ` +
      `reflexo: ${info.liveWidth}×${info.liveHeight} · ` +
      `memória intermediária: ${info.layerCounts.intermediate} · memória prolongada: ${info.layerCounts.long} · ` +
      `segmentação: ${info.segmentationReady ? "pronta" : "carregando..."} · ` +
      `submits/quadro: ${info.submitCount ?? "n/a (canvas2d)"}`;
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
    this.addSlider("Eco: deslocamento mínimo (líquido)", 0, 1, 0.01, this.effects.echoDisplacementFloor, (v) => {
      this.effects.echoDisplacementFloor = v;
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
    this.addSlider("Rastro profundo: decaimento/s", 0, 0.05, 0.001, this.effects.trailDeepDecayPerSecond, (v) => {
      this.effects.trailDeepDecayPerSecond = v;
      this.emit();
    });
    this.addSlider("Rastro profundo: opacidade da captura", 0, 1, 0.01, this.effects.trailDeepCaptureOpacity, (v) => {
      this.effects.trailDeepCaptureOpacity = v;
      this.emit();
    });
    this.addSlider("Rastro profundo: piso (nunca apaga)", 0, 1, 0.01, this.effects.trailDeepFloorRatio, (v) => {
      this.effects.trailDeepFloorRatio = v;
      this.emit();
    });
    this.addSlider("Rastro profundo: período da oscilação (s)", 2, 120, 1, this.effects.trailOscillationPeriodSeconds, (v) => {
      this.effects.trailOscillationPeriodSeconds = v;
      this.emit();
    });
    this.addSlider("Rastro (Solaris): frequência", 0, 3, 0.05, this.effects.trailDisplacementFrequency, (v) => {
      this.effects.trailDisplacementFrequency = v;
      this.emit();
    });
    this.addSlider("Rastro (Solaris): velocidade", 0, 1, 0.01, this.effects.trailDisplacementSpeed, (v) => {
      this.effects.trailDisplacementSpeed = v;
      this.emit();
    });
    this.addSlider("Rastro (Solaris): amplitude", 0, 0.2, 0.001, this.effects.trailDisplacementAmplitude, (v) => {
      this.effects.trailDisplacementAmplitude = v;
      this.emit();
    });
    this.addCheckbox("Mistura aditiva nos ecos", this.effects.additiveEchoes, (v) => {
      this.effects.additiveEchoes = v;
      this.emit();
    });

    if (this.diagnosticsEnabled) {
      this.renderDiagnostics();
    }
  }

  /** Seção extra, só visível com `?debug=true` (ver seção 3 do briefing de diagnóstico). */
  private renderDiagnostics(): void {
    const heading = document.createElement("div");
    heading.textContent = "— diagnóstico (?debug=true) —";
    heading.style.marginTop = "8px";
    heading.style.opacity = "0.7";
    this.container.appendChild(heading);

    this.diagnosticsEl = document.createElement("div");
    this.container.appendChild(this.diagnosticsEl);

    const maskLabel = document.createElement("div");
    maskLabel.textContent = "Máscara de segmentação (branco = pessoa, preto = fundo):";
    this.container.appendChild(maskLabel);

    this.maskPreviewCanvas = document.createElement("canvas");
    this.maskPreviewCanvas.style.width = "120px";
    this.maskPreviewCanvas.style.height = "160px";
    this.maskPreviewCanvas.style.border = "1px solid rgba(255,255,255,0.3)";
    this.maskPreviewCanvas.style.imageRendering = "pixelated";
    this.container.appendChild(this.maskPreviewCanvas);

    let forceMagenta = false;
    let forceDistortion = false;
    const emitDebugFlags = () => this.onDebugFlagsChange(forceMagenta, forceDistortion);

    this.addCheckbox("Eco forçado (magenta) — prova que os registros chegam ao renderizador", false, (v) => {
      forceMagenta = v;
      emitDebugFlags();
    });
    this.addCheckbox("Distorção forçada — prova que o mecanismo de deslocamento funciona", false, (v) => {
      forceDistortion = v;
      emitDebugFlags();
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
