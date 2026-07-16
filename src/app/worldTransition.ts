const STYLE_ID = "sf-world-transition-style";

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .sf-world-transition {
      position: fixed;
      inset: 0;
      z-index: 1000000;
      display: grid;
      place-items: center;
      pointer-events: none;
      opacity: 0;
      visibility: hidden;
      background:
        radial-gradient(90% 70% at 50% 46%, rgba(31, 67, 91, .38), rgba(7, 16, 27, 0) 65%),
        linear-gradient(180deg, #13283a 0%, #09131e 100%);
      color: rgba(239, 247, 251, .88);
      font: 700 12px/1.3 var(--font, "Newsreader", Georgia, serif);
      letter-spacing: .16em;
      text-transform: uppercase;
      transition: opacity 160ms ease, visibility 160ms step-end;
    }
    .sf-world-transition[data-on="true"] {
      pointer-events: auto;
      opacity: 1;
      visibility: visible;
      transition: none;
    }
    .sf-world-transition__status {
      display: flex;
      align-items: center;
      gap: 10px;
      transform: translateY(18vh);
      text-shadow: 0 2px 12px rgba(0, 0, 0, .55);
    }
    .sf-world-transition__dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #b9e6ee;
      box-shadow: 0 0 12px rgba(137, 220, 234, .9);
      animation: sf-arrival-pulse 850ms ease-in-out infinite alternate;
    }
    @keyframes sf-arrival-pulse { to { opacity: .35; transform: scale(.7); } }
    @media (prefers-reduced-motion: reduce) {
      .sf-world-transition { transition-duration: 1ms !important; }
      .sf-world-transition__dot { animation: none; }
    }
  `;
  document.head.append(style);
}

const nextPaint = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const afterPaint = () => new Promise<void>((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
);

/** Lightweight composited cover for atomic world relocations. No backdrop blur or canvas readback. */
export class WorldTransitionView {
  readonly element: HTMLElement;
  #label: HTMLElement;
  #generation = 0;

  constructor() {
    ensureStyle();
    const root = document.createElement("div");
    root.className = "sf-world-transition";
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.setAttribute("aria-hidden", "true");
    const status = document.createElement("div");
    status.className = "sf-world-transition__status";
    const dot = document.createElement("span");
    dot.className = "sf-world-transition__dot";
    dot.setAttribute("aria-hidden", "true");
    this.#label = document.createElement("span");
    status.append(dot, this.#label);
    root.append(status);
    document.body.append(root);
    this.element = root;
  }

  async show(generation: number, destination?: string): Promise<void> {
    this.#generation = generation;
    this.#label.textContent = destination ? `Traveling to ${destination}` : "Traveling";
    this.element.setAttribute("aria-hidden", "false");
    this.element.dataset.on = "true";
    // rAF callbacks run before paint. Two frames guarantee one fully opaque DOM
    // composition before any caller hides origin scenery or commits the jump.
    await afterPaint();
  }

  setStage(generation: number, label: string): void {
    if (generation !== this.#generation) return;
    this.#label.textContent = label;
  }

  async hide(generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    delete this.element.dataset.on;
    await new Promise<void>((resolve) => setTimeout(resolve, 180));
    if (generation === this.#generation) this.element.setAttribute("aria-hidden", "true");
  }

  dispose(): void {
    this.#generation++;
    this.element.remove();
  }
}

export const nextWorldFrame = nextPaint;
