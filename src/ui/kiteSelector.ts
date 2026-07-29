import {
  KITE_COLORWAYS,
  KITE_SAILS,
  normalizeKiteConfig,
  randomKiteConfig,
  type KiteConfig
} from "../world/oceanBeachKite/kiteConfig";

type SliderKey = "line" | "tail";

const toCss = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

/**
 * The kite atelier: which sail you fly off your own hand at Ocean Beach, how it
 * is dyed, how much line is out and how long a tail you tie on.
 *
 * Unlike the vehicle ateliers there is no preview widget in the panel, because
 * the preview is a real kite fifty metres up behind it — every control here is
 * a live edit on the thing you are already looking at. The sliders therefore
 * drive the kite on `input` (letting line out should feel like letting line
 * out) but only commit — and only persist — on `change`, so one drag is one
 * saved kite rather than a hundred.
 */
export class KiteSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: KiteConfig;
  #open = false;
  #visible = false;
  #onChange: (config: KiteConfig) => void;
  #onPreview: (config: KiteConfig) => void;
  #onOpen: () => void;

  constructor(
    initial: KiteConfig,
    onChange: (config: KiteConfig) => void,
    onPreview: (config: KiteConfig) => void,
    onOpen: () => void
  ) {
    this.#config = normalizeKiteConfig(initial);
    this.#onChange = onChange;
    this.#onPreview = onPreview;
    this.#onOpen = onOpen;

    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui kite-ui";
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "avatar-toggle kite-toggle";
    this.#toggle.title = "Kite atelier";
    this.#toggle.setAttribute("aria-label", "Open kite atelier");
    this.#toggle.innerHTML =
      '<img class="customizer-icon" src="/ui/customizer-icons/kite.svg" alt="" draggable="false">';
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel board-panel kite-panel";
    this.#root.append(this.#toggle, this.#panel);
    document.getElementById("hud")?.appendChild(this.#root);
    this.#render();
  }

  setOpen(open: boolean): void {
    if (open && !this.#visible) return;
    this.#open = open;
    this.#root.classList.toggle("open", open);
    this.#toggle.setAttribute("aria-expanded", String(open));
    if (open) this.#onOpen();
  }

  /** Beach-only slot — hide when another (or no) customizer owns the HUD. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#root.hidden = !visible;
    if (!visible && this.#open) this.setOpen(false);
  }

  setConfig(config: KiteConfig): void {
    this.#config = normalizeKiteConfig(config);
    this.#render();
  }

  #set(next: Partial<KiteConfig>): void {
    this.#config = normalizeKiteConfig({ ...this.#config, ...next });
    this.#render();
    this.#onChange({ ...this.#config });
  }

  #row(label: string, controls: HTMLElement[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "avatar-row";
    const name = document.createElement("div");
    name.className = "avatar-label";
    name.textContent = label;
    const body = document.createElement("div");
    body.className = "avatar-controls";
    body.append(...controls);
    row.append(name, body);
    return row;
  }

  #sailRow(): HTMLElement {
    const buttons = KITE_SAILS.map((sail) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "avatar-choice";
      button.textContent = sail.label;
      button.title = sail.note;
      button.classList.toggle("on", this.#config.design === sail.id);
      button.addEventListener("click", () => this.#set({ design: sail.id }));
      return button;
    });
    return this.#row("sail", buttons);
  }

  #dyeRow(): HTMLElement {
    const buttons = KITE_COLORWAYS.map((colorway) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "avatar-swatch kite-swatch";
      // Two stops, split on the diagonal: a kite's dye is a cloth colour and a
      // glow colour, and one flat square would hide half of every choice.
      button.style.background =
        `linear-gradient(135deg, ${toCss(colorway.chip[0])} 0 48%, ${toCss(colorway.chip[1])} 52% 100%)`;
      button.title = colorway.label;
      button.setAttribute("aria-label", `Dye: ${colorway.label}`);
      button.classList.toggle("on", this.#config.colorway === colorway.id);
      button.addEventListener("click", () => this.#set({ colorway: colorway.id }));
      return button;
    });
    return this.#row("dye", buttons);
  }

  #slider(key: SliderKey, label: string, low: string, high: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "scooter-slider kite-slider";
    const ends = document.createElement("span");
    ends.className = "scooter-slider-ends";
    const lowEnd = document.createElement("span");
    lowEnd.textContent = low;
    const highEnd = document.createElement("span");
    highEnd.textContent = high;
    ends.append(lowEnd, highEnd);
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.value = String(this.#config[key]);
    input.setAttribute("aria-label", label);
    const output = document.createElement("output");
    output.value = input.value;
    // Live on drag, committed once on release. The runtime rate-limits the
    // reel, so a sweep of the slider pays line out at a kite's pace rather than
    // teleporting the sail.
    input.addEventListener("input", () => {
      const value = Number(input.value);
      output.value = String(value).padStart(2, "0");
      this.#config = normalizeKiteConfig({ ...this.#config, [key]: value });
      this.#onPreview({ ...this.#config });
    });
    // No #render() here: rebuilding the panel mid-interaction would replace the
    // very input the pointer is on.
    input.addEventListener("change", () => {
      this.#config = normalizeKiteConfig({ ...this.#config, [key]: Number(input.value) });
      this.#onChange({ ...this.#config });
    });
    wrap.append(input, ends, output);
    return wrap;
  }

  #flyRow(): HTMLElement {
    const fly = document.createElement("button");
    fly.type = "button";
    fly.className = "avatar-choice kite-fly";
    fly.textContent = this.#config.flying ? "pack it away" : "fly it";
    fly.classList.toggle("on", this.#config.flying);
    fly.addEventListener("click", () => this.#set({ flying: !this.#config.flying }));

    const roll = document.createElement("button");
    roll.type = "button";
    roll.className = "avatar-choice";
    roll.textContent = "random";
    roll.title = "Roll a whole kite";
    roll.addEventListener("click", () => this.#set(randomKiteConfig(this.#config.flying)));

    return this.#row("kite", [fly, roll]);
  }

  #render(): void {
    this.#panel.replaceChildren();

    const head = document.createElement("div");
    head.className = "board-panel-head";
    const title = document.createElement("span");
    title.textContent = "KITE ATELIER";
    const sub = document.createElement("small");
    sub.textContent = "sail it · dye it · fly it";
    head.append(title, sub);

    const sail = KITE_SAILS.find((entry) => entry.id === this.#config.design) ?? KITE_SAILS[0];
    const note = document.createElement("div");
    note.className = "kite-note";
    note.textContent = sail.note;

    this.#panel.append(
      head,
      this.#sailRow(),
      note,
      this.#dyeRow(),
      this.#row("line", [this.#slider("line", "Line out", "held close", "way out")]),
      this.#row("tail", [this.#slider("tail", "Tail length", "stub", "streamer")]),
      this.#flyRow()
    );
  }
}
