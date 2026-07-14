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
  carKey,
  carPaintHex,
  carRimHex,
  carTrimHex,
  normalizeCarConfig,
  paintCarSurface,
  prepareCarSurface,
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
  #preview: HTMLCanvasElement;
  #surfacePreview = document.createElement("canvas");
  #config: CarConfig;
  #open = false;
  #assetSerial = 0;
  #onChange: (config: CarConfig) => void;
  #onOpen: () => void;

  constructor(initial: CarConfig, onChange: (config: CarConfig) => void, onOpen: () => void) {
    this.#config = normalizeCarConfig(initial);
    this.#onChange = onChange;
    this.#onOpen = onOpen;
    this.#surfacePreview.width = this.#surfacePreview.height = 512;
    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui car-ui";
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "avatar-toggle car-toggle";
    this.#toggle.title = "Open car atelier";
    this.#toggle.setAttribute("aria-label", "Open car atelier");
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel board-panel scooter-panel car-panel";
    this.#preview = document.createElement("canvas");
    this.#preview.className = "car-preview";
    this.#preview.width = 704;
    this.#preview.height = 260;
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
      this.#loadSelectedAssets();
    }
  }

  setConfig(config: CarConfig): void {
    this.#config = normalizeCarConfig(config);
    this.#render();
    if (this.#open) this.#loadSelectedAssets();
  }

  #set(next: Partial<CarConfig>): void {
    this.#config = normalizeCarConfig({ ...this.#config, ...next });
    this.#render();
    this.#onChange({ ...this.#config });
    if (this.#open) this.#loadSelectedAssets();
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
      this.#paintPreview();
    });
    input.addEventListener("change", () => this.#set({ [key]: Number(input.value) } as Partial<CarConfig>));
    wrap.append(input, ends, output);
    return wrap;
  }

  #loadSelectedAssets(): void {
    const serial = ++this.#assetSerial;
    const key = carKey(this.#config);
    void prepareCarSurface(this.#config).then(() => {
      if (serial !== this.#assetSerial || key !== carKey(this.#config)) return;
      this.#paintPreview();
    });
  }

  #paintPreview(): void {
    paintCarSurface(this.#surfacePreview, this.#config);
    const ctx = this.#preview.getContext("2d");
    if (!ctx) return;
    const width = this.#preview.width;
    const height = this.#preview.height;
    ctx.clearRect(0, 0, width, height);
    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "#080d13");
    bg.addColorStop(0.55, "#18232c");
    bg.addColorStop(1, "#2b1d1c");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "rgba(255,255,255,.045)";
    for (let x = 0; x < width; x += 44) ctx.fillRect(x, 0, 1, height);
    ctx.fillStyle = "rgba(255,255,255,.035)";
    ctx.fillRect(0, 211, width, 2);

    const wheelY = this.#config.form === "trail-box" ? 194 : 202;
    const wheelRadius = this.#config.form === "trail-box" ? 48 : 43;
    const wheelXs = this.#config.form === "mission-gt" ? [150, 556] : [160, 544];
    const rimColor = toCss(carRimHex(this.#config));
    for (const x of wheelXs) {
      ctx.fillStyle = "#070a0d";
      ctx.beginPath();
      ctx.arc(x, wheelY, wheelRadius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = rimColor;
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.arc(x, wheelY, wheelRadius * 0.68, 0, Math.PI * 2);
      ctx.stroke();
      const spokes = this.#config.wheel === "mesh-ten" ? 12 : this.#config.wheel === "rally-eight" ? 8 : 10;
      ctx.lineWidth = this.#config.wheel === "rally-eight" ? 5 : 3;
      for (let i = 0; i < spokes; i++) {
        const angle = (i / spokes) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(angle) * 7, wheelY + Math.sin(angle) * 7);
        ctx.lineTo(x + Math.cos(angle) * wheelRadius * 0.64, wheelY + Math.sin(angle) * wheelRadius * 0.64);
        ctx.stroke();
      }
      ctx.fillStyle = "#d75a3b";
      ctx.fillRect(x + 16, wheelY - 10, 7, 20);
    }

    const profiles: Record<CarConfig["form"], [number, number][]> = {
      "coast-coupe": [[87, 187], [94, 138], [184, 112], [250, 56], [377, 52], [481, 91], [616, 122], [624, 185]],
      "apex-wedge": [[80, 188], [93, 156], [267, 118], [321, 61], [440, 58], [556, 116], [626, 141], [632, 188]],
      "trail-box": [[72, 186], [84, 107], [174, 92], [207, 45], [480, 45], [558, 97], [628, 113], [636, 186]],
      "mission-gt": [[67, 188], [78, 141], [190, 111], [284, 61], [408, 51], [520, 86], [642, 133], [649, 188]]
    };
    ctx.save();
    ctx.beginPath();
    const profile = profiles[this.#config.form];
    ctx.moveTo(profile[0][0], profile[0][1]);
    for (let i = 1; i < profile.length; i++) ctx.lineTo(profile[i][0], profile[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(this.#surfacePreview, 58, 38, 610, 166);
    ctx.restore();
    ctx.strokeStyle = toCss(carTrimHex(this.#config));
    ctx.lineWidth = 7;
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(profile[0][0], profile[0][1]);
    for (let i = 1; i < profile.length; i++) ctx.lineTo(profile[i][0], profile[i][1]);
    ctx.stroke();
    ctx.fillStyle = "rgba(20,50,70,.88)";
    ctx.beginPath();
    if (this.#config.form === "trail-box") ctx.roundRect(212, 58, 260, 72, 10);
    else ctx.roundRect(269, 68, 175, 57, 22);
    ctx.fill();
    ctx.fillStyle = toCss(carInteriorHex(this.#config));
    ctx.fillRect(319, 120, 75, 24);
  }

  #render(): void {
    const paint = toCss(carPaintHex(this.#config));
    const trim = toCss(carTrimHex(this.#config));
    this.#toggle.innerHTML = `<span class="car-ic-body" style="background:${paint};border-color:${trim}"></span><span class="car-ic-wheel car-ic-front" style="border-color:${trim}"></span><span class="car-ic-wheel car-ic-rear" style="border-color:${trim}"></span>`;
    this.#panel.replaceChildren();
    const header = document.createElement("header");
    header.className = "board-panel-head scooter-panel-head car-panel-head";
    header.innerHTML = "<span>FOG CITY MOTORWORKS</span><small>form · finish · road</small>";
    const previewFrame = document.createElement("div");
    previewFrame.className = "car-preview-frame";
    previewFrame.appendChild(this.#preview);
    this.#panel.append(
      header,
      previewFrame,
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
    this.#paintPreview();
  }
}
