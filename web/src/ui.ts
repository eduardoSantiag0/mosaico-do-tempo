export type Screen = "intro" | "error" | "experience";

export class UI {
  private introScreen = required<HTMLElement>("#intro-screen");
  private errorScreen = required<HTMLElement>("#error-screen");
  private errorTitle = required<HTMLElement>("#error-title");
  private errorMessage = required<HTMLElement>("#error-message");
  private exitButton = required<HTMLButtonElement>("#exit-button");
  private startButton = required<HTMLButtonElement>("#start-button");
  private retryButton = required<HTMLButtonElement>("#retry-button");
  private philosophyScreen = required<HTMLElement>("#philosophy-screen");
  private philosophyButton = required<HTMLButtonElement>("#philosophy-button");
  private philosophyCloseButton = required<HTMLButtonElement>("#philosophy-close-button");
  debugPanel = required<HTMLElement>("#debug-panel");

  onStart(handler: () => void): void {
    this.startButton.addEventListener("click", handler, { once: false });
  }

  onRetry(handler: () => void): void {
    this.retryButton.addEventListener("click", handler);
  }

  onExit(handler: () => void): void {
    this.exitButton.addEventListener("click", handler);
  }

  /** Botão "Filosofia por trás", só visível na tela inicial. */
  onPhilosophyOpen(handler: () => void): void {
    this.philosophyButton.addEventListener("click", handler);
  }

  onPhilosophyClose(handler: () => void): void {
    this.philosophyCloseButton.addEventListener("click", handler);
  }

  setPhilosophyVisible(visible: boolean): void {
    this.philosophyScreen.classList.toggle("hidden", !visible);
  }

  showScreen(screen: Screen): void {
    this.introScreen.classList.toggle("hidden", screen !== "intro");
    this.errorScreen.classList.toggle("hidden", screen !== "error");
    this.exitButton.classList.toggle("hidden", screen !== "experience");
  }

  showError(title: string, message: string): void {
    this.errorTitle.textContent = title;
    this.errorMessage.textContent = message;
    this.showScreen("error");
  }

  setDebugVisible(visible: boolean): void {
    this.debugPanel.classList.toggle("hidden", !visible);
  }
}

function required<T extends Element>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`Elemento obrigatório ausente: ${selector}`);
  return el;
}
