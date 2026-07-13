import {
  SCOOTER_BODIES,
  SCOOTER_CARGO,
  SCOOTER_PAINT_COLORS,
  SCOOTER_SCREENS,
  SCOOTER_SEAT_COLORS,
  SCOOTER_SEATS,
  SCOOTER_TRIM_COLORS,
  normalizeScooterConfig,
  randomScooterConfig,
  scooterPaintHex,
  scooterSeatHex,
  scooterTrimHex,
  type ScooterConfig
} from "../vehicles/scooter";

type ColorKey = "paint" | "trim" | "upholstery";

const COLOR_ROWS = {
  paint: { palette: SCOOTER_PAINT_COLORS, hexKey: "paintHex", resolve: scooterPaintHex },
  trim: { palette: SCOOTER_TRIM_COLORS, hexKey: "trimHex", resolve: scooterTrimHex },
  upholstery: { palette: SCOOTER_SEAT_COLORS, hexKey: "upholsteryHex", resolve: scooterSeatHex }
} as const;

const toCss = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

/** Compact visual-only garage for the electric scooter. */
export class ScooterSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: ScooterConfig;
  #open = false;
  #onChange: (config: ScooterConfig) => void;
  #onOpen: () => void;

  constructor(initial: ScooterConfig, onChange: (config: ScooterConfig) => void, onOpen: () => void) {
    this.#config = normalizeScooterConfig(initial);
    this.#onChange = onChange;
    this.#onOpen = onOpen;
    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui scooter-ui";
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "avatar-toggle scooter-toggle";
    this.#toggle.title = "Electric scooter garage";
    this.#toggle.setAttribute("aria-label", "Open electric scooter garage");
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel scooter-panel";
    this.#root.append(this.#toggle, this.#panel);
    document.getElementById("hud")?.appendChild(this.#root);
    this.#render();
  }

  setOpen(open: boolean): void {
    this.#open = open;
    this.#root.classList.toggle("open", open);
    this.#toggle.setAttribute("aria-expanded", String(open));
    if (open) this.#onOpen();
  }

  setConfig(config: ScooterConfig): void {
    this.#config = normalizeScooterConfig(config);
    this.#render();
  }

  #set(next: Partial<ScooterConfig>): void {
    this.#config = normalizeScooterConfig({ ...this.#config, ...next });
    this.#render();
    this.#onChange({ ...this.#config });
  }

  #choice<K extends "body" | "seat" | "screen" | "cargo">(key: K, value: ScooterConfig[K], label: string): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "avatar-choice";
    button.textContent = label;
    button.classList.toggle("on", this.#config[key] === value);
    button.addEventListener("click", () => this.#set({ [key]: value } as Partial<ScooterConfig>));
    return button;
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

  #colorRow(key: ColorKey): HTMLElement {
    const spec = COLOR_ROWS[key];
    const buttons: HTMLElement[] = [];
    spec.palette.forEach((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "avatar-swatch";
      button.style.background = toCss(entry.color);
      button.title = entry.label;
      button.setAttribute("aria-label", `${key}: ${entry.label}`);
      button.classList.toggle("on", this.#config[key] === index && this.#config[spec.hexKey] === null);
      button.addEventListener("click", () => this.#set({ [key]: index, [spec.hexKey]: null } as Partial<ScooterConfig>));
      buttons.push(button);
    });
    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "scooter-color-input";
    picker.title = `Custom ${key}`;
    picker.setAttribute("aria-label", `Custom ${key} color`);
    picker.value = toCss(spec.resolve(this.#config));
    picker.addEventListener("change", () => this.#set({ [spec.hexKey]: Number.parseInt(picker.value.slice(1), 16) } as Partial<ScooterConfig>));
    buttons.push(picker);
    return this.#row(key === "upholstery" ? "seat color" : key, buttons);
  }

  #render(): void {
    const paint = toCss(scooterPaintHex(this.#config));
    const trim = toCss(scooterTrimHex(this.#config));
    this.#toggle.innerHTML = `<span class="scooter-ic-body" style="background:${paint}"></span><span class="scooter-ic-wheel scooter-ic-front" style="border-color:${trim}"></span><span class="scooter-ic-wheel scooter-ic-rear" style="border-color:${trim}"></span>`;
    this.#panel.replaceChildren();
    const header = document.createElement("div");
    header.className = "scooter-panel-head";
    header.innerHTML = `<strong>Electric scooter garage</strong><small>visual design · two-up seat</small>`;
    this.#panel.append(
      header,
      this.#row("body", SCOOTER_BODIES.map((v) => this.#choice("body", v.id, v.label))),
      this.#row("seat", SCOOTER_SEATS.map((v) => this.#choice("seat", v.id, v.label))),
      this.#row("screen", SCOOTER_SCREENS.map((v) => this.#choice("screen", v.id, v.label))),
      this.#row("cargo", SCOOTER_CARGO.map((v) => this.#choice("cargo", v.id, v.label))),
      this.#colorRow("paint"),
      this.#colorRow("trim"),
      this.#colorRow("upholstery")
    );
    const whitewalls = document.createElement("button");
    whitewalls.type = "button";
    whitewalls.className = "avatar-choice";
    whitewalls.textContent = this.#config.whitewalls ? "whitewalls on" : "blackwalls";
    whitewalls.classList.toggle("on", this.#config.whitewalls);
    whitewalls.addEventListener("click", () => this.#set({ whitewalls: !this.#config.whitewalls }));
    this.#panel.append(this.#row("wheels", [whitewalls]));
    const random = document.createElement("button");
    random.type = "button";
    random.className = "avatar-random";
    random.textContent = "surprise me";
    random.addEventListener("click", () => this.#set(randomScooterConfig()));
    this.#panel.append(random);
  }
}
