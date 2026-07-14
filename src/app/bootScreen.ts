import { pickName } from "../net/net";

export type StartOptions = { lock?: boolean };
export type StartHandler = (typedName: string, opts?: StartOptions) => void;

/**
 * Owns the pre-game DOM and its event listeners. The game boot process only
 * reports progress and installs a start handler; it no longer reaches into a
 * half-dozen loading-screen elements spread through main.ts.
 */
export class BootScreen {
  readonly app = document.getElementById("app")!;
  readonly loading = document.getElementById("loading")!;
  readonly nameInput = document.querySelector<HTMLInputElement>("[data-name-input]")!;
  /** Saved custom name when present; otherwise a fresh fun suggestion. */
  readonly suggestedName = pickName();

  #loadingLabel = document.querySelector<HTMLElement>("[data-loading-label]")!;
  #loadingBar = document.querySelector<HTMLElement>("[data-loading-bar]")!;
  #startForm = document.querySelector<HTMLFormElement>("[data-start-form]")!;
  #startButton = this.#startForm.querySelector<HTMLButtonElement>("button")!;
  #ready = false;
  #start: StartHandler | null = null;

  constructor() {
    this.nameInput.value = this.suggestedName;
    this.#startButton.disabled = true;
    requestAnimationFrame(() => this.focusNameInput());

    this.#startForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#submit();
    });

    window.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.repeat || this.loading.classList.contains("done")) return;
      // A shared ?read= link opens the reading panel over the start screen; Enter
      // there belongs to the reading, not to entering the world.
      if (document.body.classList.contains("reading")) return;
      const target = event.target;
      if (target === this.#startButton) return; // native click/submit handles this
      if (target instanceof HTMLTextAreaElement) return;
      if (target instanceof HTMLInputElement && target !== this.nameInput) return;
      event.preventDefault();
      this.#submit();
    });
  }

  setStartHandler(handler: StartHandler): void {
    this.#start = handler;
  }

  /** Starts through code (deep links / local auto-enter), independent of button readiness. */
  startNow(name: string, opts?: StartOptions): boolean {
    if (!this.#start) return false;
    this.#start(name, opts);
    return true;
  }

  focusNameInput(): void {
    this.nameInput.focus({ preventScroll: true });
    this.nameInput.select();
  }

  progress(percent: number, label: string): void {
    this.#loadingBar.style.width = `${percent}%`;
    this.#loadingLabel.textContent = label;
  }

  markReady(): void {
    this.#ready = true;
    this.#startButton.disabled = false;
    this.loading.classList.add("ready");
  }

  fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.#loadingLabel.textContent = `boot failed: ${message} — click to reload`;
    this.#loadingBar.style.width = "100%";
    this.#loadingBar.style.background = "#c0392b";
    this.loading.style.cursor = "pointer";
    this.loading.addEventListener("click", () => location.reload(), { once: true });
  }

  #submit(): void {
    if (!this.#ready || !this.#start || this.#startButton.disabled) {
      this.focusNameInput();
      return;
    }
    this.#start(this.nameInput.value.trim());
  }
}

