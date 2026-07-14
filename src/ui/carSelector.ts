import {
  CAR_DECALS,
  CAR_FORMS,
  CAR_INTERIOR_COLORS,
  CAR_PAINT_COLORS,
  CAR_RIM_COLORS,
  CAR_SURFACES,
  CAR_TRIM_COLORS,
  CAR_WHEELS,
  carInteriorHex,
  carPaintHex,
  carRimHex,
  carTrimHex,
  normalizeCarConfig,
  randomCarConfig,
  type CarConfig
} from "../vehicles/car";

type ChoiceKey = "form" | "surface" | "decal" | "wheel";
type ColorKey = "paint" | "trim" | "interior" | "rim";
type SliderKey = "surfaceScale" | "decalScale" | "decalPosition" | "clearcoat";

const COLOR_ROWS = {
  paint: { palette: CAR_PAINT_COLORS, hexKey: "paintHex", resolve: carPaintHex },
  trim: { palette: CAR_TRIM_COLORS, hexKey: "trimHex", resolve: carTrimHex },
  interior: { palette: CAR_INTERIOR_COLORS, hexKey: "interiorHex", resolve: carInteriorHex },
  rim: { palette: CAR_RIM_COLORS, hexKey: "rimHex", resolve: carRimHex }
} as const;

const toCss = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

/** Lazy-loaded player-facing garage for the stock car. */
export class CarSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: CarConfig;
  #open = false;
  #onChange: (config: CarConfig) => void;
  #onPreview: (config: CarConfig) => void;
  #onOpen: () => void;

  constructor(
    initial: CarConfig,
    onChange: (config: CarConfig) => void,
    onPreview: (config: CarConfig) => void,
    onOpen: () => void
  ) {
    this.#config = normalizeCarConfig(initial);
    this.#onChange = onChange;
    this.#onPreview = onPreview;
    this.#onOpen = onOpen;
    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui car-ui";
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "avatar-toggle car-toggle";
    this.#toggle.title = "Open car atelier";
    this.#toggle.setAttribute("aria-label", "Open car atelier");
    this.#toggle.innerHTML = '<img class="customizer-icon" src="/ui/customizer-icons/car.webp" alt="" draggable="false">';
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel board-panel scooter-panel car-panel";
    this.#root.append(this.#toggle, this.#panel);
    document.getElementById("hud")?.appendChild(this.#root);
    this.#render();
  }

  setOpen(open: boolean): void {
    this.#open = open;
    this.#root.classList.toggle("open", open);
    this.#toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      this.#onOpen();
    }
  }

  /** Drive-mode slot only — hide when another (or no) customizer owns the HUD. */
  setVisible(visible: boolean): void {
    this.#root.hidden = !visible;
    if (!visible && this.#open) this.setOpen(false);
  }

  setConfig(config: CarConfig): void {
    this.#config = normalizeCarConfig(config);
    this.#render();
  }

  #set(next: Partial<CarConfig>): void {
    this.#config = normalizeCarConfig({ ...this.#config, ...next });
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

  #choice<K extends ChoiceKey>(key: K, value: CarConfig[K], label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "avatar-choice";
    button.textContent = label;
    button.classList.toggle("on", this.#config[key] === value);
    button.addEventListener("click", () => this.#set({ [key]: value } as Partial<CarConfig>));
    return button;
  }

  #formChoice(entry: (typeof CAR_FORMS)[number]): HTMLButtonElement {
    const button = this.#choice("form", entry.id, entry.label);
    button.classList.add("car-form-choice");
    button.replaceChildren();
    const label = document.createElement("span");
    label.textContent = entry.label;
    const note = document.createElement("small");
    note.textContent = entry.note;
    button.append(label, note);
    return button;
  }

  #colorRow(key: ColorKey): HTMLElement {
    const spec = COLOR_ROWS[key];
    const controls: HTMLElement[] = [];
    spec.palette.forEach((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "avatar-swatch";
      button.style.background = toCss(entry.color);
      button.title = entry.label;
      button.setAttribute("aria-label", `${key}: ${entry.label}`);
      button.classList.toggle("on", this.#config[key] === index && this.#config[spec.hexKey] === null);
      button.addEventListener("click", () => this.#set({ [key]: index, [spec.hexKey]: null } as Partial<CarConfig>));
      controls.push(button);
    });
    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "scooter-color-input";
    picker.value = toCss(spec.resolve(this.#config));
    picker.title = `Custom ${key}`;
    picker.setAttribute("aria-label", `Custom ${key} color`);
    picker.addEventListener("input", () => {
      this.#config = normalizeCarConfig({ ...this.#config, [spec.hexKey]: Number.parseInt(picker.value.slice(1), 16) });
      this.#onPreview({ ...this.#config });
    });
    picker.addEventListener("change", () => this.#set({ [spec.hexKey]: Number.parseInt(picker.value.slice(1), 16) } as Partial<CarConfig>));
    controls.push(picker);
    return this.#row(key, controls);
  }

  #slider(key: SliderKey, label: string, low: string, high: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "scooter-slider car-slider";
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.value = String(this.#config[key]);
    input.setAttribute("aria-label", label);
    const ends = document.createElement("span");
    ends.className = "scooter-slider-ends";
    const lowLabel = document.createElement("span");
    lowLabel.textContent = low;
    const highLabel = document.createElement("span");
    highLabel.textContent = high;
    ends.append(lowLabel, highLabel);
    const output = document.createElement("output");
    output.value = String(this.#config[key]).padStart(2, "0");
    input.addEventListener("input", () => {
      this.#config = normalizeCarConfig({ ...this.#config, [key]: Number(input.value) });
      output.value = input.value.padStart(2, "0");
      this.#onPreview({ ...this.#config });
    });
    input.addEventListener("change", () => this.#set({ [key]: Number(input.value) } as Partial<CarConfig>));
    wrap.append(input, ends, output);
    return wrap;
  }

  #render(): void {
    this.#panel.replaceChildren();
    const header = document.createElement("header");
    header.className = "board-panel-head scooter-panel-head car-panel-head";
    header.innerHTML = "<span>FOG CITY MOTORWORKS</span><small>form · finish · road</small>";
    this.#panel.append(
      header,
      this.#row("form", CAR_FORMS.map((entry) => this.#formChoice(entry))),
      this.#row("finish", CAR_SURFACES.map((entry) => this.#choice("surface", entry.id, entry.label))),
      this.#row("decal", CAR_DECALS.map((entry) => this.#choice("decal", entry.id, entry.label))),
      this.#row("spokes", CAR_WHEELS.map((entry) => this.#choice("wheel", entry.id, entry.label))),
      this.#colorRow("paint"),
      this.#colorRow("trim"),
      this.#colorRow("interior"),
      this.#colorRow("rim")
    );
    const sliders = document.createElement("div");
    sliders.className = "car-slider-grid";
    sliders.append(
      this.#slider("surfaceScale", "Finish scale", "fine", "broad"),
      this.#slider("decalScale", "Decal scale", "badge", "hero"),
      this.#slider("decalPosition", "Decal position", "nose", "tail"),
      this.#slider("clearcoat", "Clearcoat", "satin", "wet")
    );
    this.#panel.append(sliders);
    const random = document.createElement("button");
    random.type = "button";
    random.className = "avatar-random";
    random.textContent = "build me one";
    random.addEventListener("click", () => this.#set(randomCarConfig()));
    this.#panel.append(random);
  }
}
