import {
  SCOOTER_BODIES,
  SCOOTER_CARGO,
  SCOOTER_DECALS,
  SCOOTER_PAINT_COLORS,
  SCOOTER_SCREENS,
  SCOOTER_SEAT_COLORS,
  SCOOTER_SEATS,
  SCOOTER_SURFACES,
  SCOOTER_TRIM_COLORS,
  SCOOTER_WHEELS,
  normalizeScooterConfig,
  paintScooterSurface,
  prepareScooterSurface,
  randomScooterConfig,
  scooterKey,
  scooterPaintHex,
  scooterSeatHex,
  scooterTrimHex,
  type ScooterConfig
} from "../vehicles/scooter";

type ColorKey = "paint" | "trim" | "upholstery";
type ChoiceKey = "body" | "seat" | "screen" | "cargo" | "wheel" | "surface" | "decal";
type PadKind = "form" | "graphic";
type PadKey = "stance" | "bodyVolume" | "decalScale" | "decalPosition";
type SliderKey = "rimGlow" | "screenTint";

const COLOR_ROWS = {
  paint: { palette: SCOOTER_PAINT_COLORS, hexKey: "paintHex", resolve: scooterPaintHex },
  trim: { palette: SCOOTER_TRIM_COLORS, hexKey: "trimHex", resolve: scooterTrimHex },
  upholstery: { palette: SCOOTER_SEAT_COLORS, hexKey: "upholsteryHex", resolve: scooterSeatHex }
} as const;

const toCss = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;
const clamp = (value: number) => Math.max(0, Math.min(100, value));

/** The electric scooter atelier: preset parts plus two tactile 2D design pads. */
export class ScooterSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: ScooterConfig;
  #open = false;
  #onChange: (config: ScooterConfig) => void;
  #onPreview: (config: ScooterConfig) => void;
  #onOpen: () => void;
  #previewCanvases = new Map<PadKind, HTMLCanvasElement>();
  #assetSerial = 0;

  constructor(
    initial: ScooterConfig,
    onChange: (config: ScooterConfig) => void,
    onPreview: (config: ScooterConfig) => void,
    onOpen: () => void
  ) {
    this.#config = normalizeScooterConfig(initial);
    this.#onChange = onChange;
    this.#onPreview = onPreview;
    this.#onOpen = onOpen;
    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui scooter-ui";
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "avatar-toggle scooter-toggle";
    this.#toggle.title = "Electric scooter atelier";
    this.#toggle.setAttribute("aria-label", "Open electric scooter atelier");
    this.#toggle.innerHTML = '<img class="customizer-icon" src="/ui/customizer-icons/scooter.webp" alt="" draggable="false">';
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel board-panel scooter-panel";
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

  /** Scooter-mode slot only — hide when another (or no) customizer owns the HUD. */
  setVisible(visible: boolean): void {
    this.#root.hidden = !visible;
    if (!visible && this.#open) this.setOpen(false);
  }

  setConfig(config: ScooterConfig): void {
    this.#config = normalizeScooterConfig(config);
    this.#render();
    if (this.#open) this.#loadSelectedAssets();
  }

  #set(next: Partial<ScooterConfig>): void {
    this.#config = normalizeScooterConfig({ ...this.#config, ...next });
    this.#render();
    this.#onChange({ ...this.#config });
    if (this.#open) this.#loadSelectedAssets();
  }

  #choice<K extends ChoiceKey>(key: K, value: ScooterConfig[K], label: string): HTMLButtonElement {
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

  #slider(key: SliderKey, label: string, low: string, high: string): HTMLElement {
    const wrap = document.createElement("label");
    wrap.className = "scooter-slider";
    const ends = document.createElement("span");
    ends.className = "scooter-slider-ends";
    ends.innerHTML = `<span>${low}</span><span>${high}</span>`;
    const input = document.createElement("input");
    input.type = "range";
    input.min = "0";
    input.max = "100";
    input.step = "1";
    input.value = String(this.#config[key]);
    input.setAttribute("aria-label", label);
    const output = document.createElement("output");
    output.value = input.value;
    const preview = () => {
      const value = Number(input.value);
      output.value = String(value).padStart(2, "0");
      this.#config = normalizeScooterConfig({ ...this.#config, [key]: value });
      this.#onPreview({ ...this.#config });
    };
    input.addEventListener("input", preview);
    input.addEventListener("change", () => this.#set({ [key]: Number(input.value) } as Partial<ScooterConfig>));
    wrap.append(input, ends, output);
    return wrap;
  }

  #pad(
    kind: PadKind,
    title: string,
    subtitle: string,
    xKey: PadKey,
    yKey: PadKey,
    xLabels: [string, string],
    yLabels: [string, string]
  ): HTMLElement {
    const lab = document.createElement("section");
    lab.className = `board-lab scooter-lab scooter-lab-${kind}`;
    const head = document.createElement("div");
    head.className = "board-lab-head";
    const heading = document.createElement("div");
    const name = document.createElement("div");
    name.className = "board-lab-name";
    name.textContent = title;
    const sub = document.createElement("div");
    sub.className = "board-lab-sub";
    sub.textContent = subtitle;
    heading.append(name, sub);
    const readout = document.createElement("output");
    readout.className = "board-lab-readout";
    head.append(heading, readout);

    const pad = document.createElement("div");
    pad.className = "board-xy-pad";
    pad.tabIndex = 0;
    pad.setAttribute("role", "group");
    pad.setAttribute("aria-roledescription", "two-dimensional control");
    pad.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown");
    pad.setAttribute("aria-label", `${title}: horizontal ${xLabels[0]} to ${xLabels[1]}, vertical ${yLabels[0]} to ${yLabels[1]}`);
    const canvas = document.createElement("canvas");
    canvas.className = "board-xy-canvas scooter-xy-canvas";
    canvas.width = 256;
    canvas.height = 160;
    const grid = document.createElement("span");
    grid.className = "board-xy-grid";
    const puck = document.createElement("span");
    puck.className = "board-xy-puck";
    const labels = [
      ["board-axis board-axis-x0", xLabels[0]],
      ["board-axis board-axis-x1", xLabels[1]],
      ["board-axis board-axis-y0", yLabels[0]],
      ["board-axis board-axis-y1", yLabels[1]]
    ] as const;
    const axes = labels.map(([className, text]) => {
      const axis = document.createElement("span");
      axis.className = className;
      axis.textContent = text;
      return axis;
    });
    pad.append(canvas, grid, puck, ...axes);
    lab.append(head, pad);
    this.#previewCanvases.set(kind, canvas);

    const draw = () => {
      const x = this.#config[xKey];
      const y = this.#config[yKey];
      puck.style.left = `${x}%`;
      puck.style.top = `${100 - y}%`;
      readout.value = `${x.toString().padStart(2, "0")} · ${y.toString().padStart(2, "0")}`;
      pad.setAttribute("aria-valuetext", `${xLabels[0]} ${100 - x}%, ${xLabels[1]} ${x}%; ${yLabels[0]} ${100 - y}%, ${yLabels[1]} ${y}%`);
    };
    const apply = (x: number, y: number) => {
      this.#config = normalizeScooterConfig({
        ...this.#config,
        [xKey]: Math.round(clamp(x)),
        [yKey]: Math.round(clamp(y))
      });
      draw();
      this.#paintVisualPreviews();
      this.#onPreview({ ...this.#config });
    };
    const point = (event: PointerEvent) => {
      const bounds = pad.getBoundingClientRect();
      return {
        x: ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * 100,
        y: (1 - (event.clientY - bounds.top) / Math.max(1, bounds.height)) * 100
      };
    };

    let pointer = -1;
    let pending: { x: number; y: number } | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!pending) return;
      const value = pending;
      pending = null;
      apply(value.x, value.y);
    };
    const queue = (value: { x: number; y: number }) => {
      pending = value;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const finish = (event: PointerEvent, useEvent: boolean) => {
      if (event.pointerId !== pointer) return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const value = useEvent ? point(event) : pending;
      pending = null;
      if (value) apply(value.x, value.y);
      pointer = -1;
      pad.classList.remove("dragging");
      if (pad.hasPointerCapture(event.pointerId)) pad.releasePointerCapture(event.pointerId);
      this.#render();
      this.#onChange({ ...this.#config });
    };
    pad.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      pointer = event.pointerId;
      pad.setPointerCapture(pointer);
      pad.classList.add("dragging");
      queue(point(event));
    });
    pad.addEventListener("pointermove", (event) => {
      if (event.pointerId === pointer) queue(point(event));
    });
    pad.addEventListener("pointerup", (event) => finish(event, true));
    pad.addEventListener("pointercancel", (event) => finish(event, false));
    pad.addEventListener("lostpointercapture", (event) => finish(event, false));
    pad.addEventListener("keydown", (event) => {
      const step = event.shiftKey ? 10 : 2;
      let x = this.#config[xKey];
      let y = this.#config[yKey];
      if (event.key === "ArrowLeft") x -= step;
      else if (event.key === "ArrowRight") x += step;
      else if (event.key === "ArrowDown") y -= step;
      else if (event.key === "ArrowUp") y += step;
      else return;
      event.preventDefault();
      event.stopPropagation();
      apply(x, y);
      this.#render();
      this.#onChange({ ...this.#config });
    });
    draw();
    return lab;
  }

  #paintVisualPreviews(): void {
    const graphic = this.#previewCanvases.get("graphic");
    if (graphic) paintScooterSurface(graphic, this.#config);
    const form = this.#previewCanvases.get("form");
    const ctx = form?.getContext("2d");
    if (!form || !ctx) return;
    const paint = toCss(scooterPaintHex(this.#config));
    const trim = toCss(scooterTrimHex(this.#config));
    const volume = this.#config.bodyVolume / 100;
    const stance = this.#config.stance / 100;
    ctx.clearRect(0, 0, form.width, form.height);
    const bg = ctx.createLinearGradient(0, 0, form.width, form.height);
    bg.addColorStop(0, "#08131c");
    bg.addColorStop(1, "#1a2730");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, form.width, form.height);
    const wheelY = 125;
    for (const x of [55, 202]) {
      ctx.fillStyle = "#080d11";
      ctx.beginPath();
      ctx.arc(x, wheelY, 27, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = trim;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(x, wheelY, 16, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 8; i++) {
        ctx.beginPath();
        ctx.moveTo(x, wheelY);
        ctx.lineTo(x + Math.cos((i / 8) * Math.PI * 2) * 15, wheelY + Math.sin((i / 8) * Math.PI * 2) * 15);
        ctx.stroke();
      }
    }
    ctx.fillStyle = paint;
    ctx.beginPath();
    ctx.roundRect(102 - volume * 11, 73 - volume * 6, 94 + volume * 23, 48 + volume * 12, 18);
    ctx.fill();
    ctx.beginPath();
    ctx.roundRect(48 - volume * 4, 42 - stance * 15, 50 + volume * 8, 82 + stance * 18, 18);
    ctx.fill();
    ctx.fillRect(70, 105, 74, 14);
    ctx.strokeStyle = trim;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(57, 124);
    ctx.lineTo(72, 41 - stance * 10);
    ctx.lineTo(103, 35 - stance * 10);
    ctx.stroke();
    ctx.fillStyle = toCss(scooterSeatHex(this.#config));
    ctx.beginPath();
    ctx.roundRect(101, 61 - stance * 6, 92, 19, 9);
    ctx.fill();
  }

  #loadSelectedAssets(): void {
    const serial = ++this.#assetSerial;
    const key = scooterKey(this.#config);
    void prepareScooterSurface(this.#config).then(() => {
      if (serial !== this.#assetSerial || key !== scooterKey(this.#config)) return;
      this.#paintVisualPreviews();
      this.#onPreview({ ...this.#config });
    });
  }

  #render(): void {
    this.#panel.replaceChildren();
    this.#previewCanvases.clear();
    const header = document.createElement("header");
    header.className = "board-panel-head scooter-panel-head";
    header.innerHTML = `<span>VOLTAGE ATELIER</span><small>shape · lacquer · ride</small>`;
    this.#panel.append(
      header,
      this.#row("body", SCOOTER_BODIES.map((v) => this.#choice("body", v.id, v.label))),
      this.#row("seat", SCOOTER_SEATS.map((v) => this.#choice("seat", v.id, v.label))),
      this.#row("screen", SCOOTER_SCREENS.map((v) => this.#choice("screen", v.id, v.label))),
      this.#row("cargo", SCOOTER_CARGO.map((v) => this.#choice("cargo", v.id, v.label))),
      this.#row("lacquer", SCOOTER_SURFACES.map((v) => this.#choice("surface", v.id, v.label))),
      this.#row("decal", SCOOTER_DECALS.map((v) => this.#choice("decal", v.id, v.label))),
      this.#colorRow("paint"),
      this.#colorRow("trim"),
      this.#colorRow("upholstery")
    );

    const whitewalls = document.createElement("button");
    whitewalls.type = "button";
    whitewalls.className = "avatar-choice";
    whitewalls.textContent = this.#config.whitewalls ? "whitewalls" : "blackwalls";
    whitewalls.classList.toggle("on", this.#config.whitewalls);
    whitewalls.addEventListener("click", () => this.#set({ whitewalls: !this.#config.whitewalls }));
    this.#panel.append(this.#row("wheels", [
      ...SCOOTER_WHEELS.map((v) => this.#choice("wheel", v.id, v.label)),
      whitewalls
    ]));

    const labs = document.createElement("div");
    labs.className = "board-labs scooter-labs";
    labs.append(
      this.#pad("form", "FORM / 01", "volume × stance", "bodyVolume", "stance", ["slim", "full"], ["low", "tall"]),
      this.#pad("graphic", "GRAPHIC / 02", "scale × placement", "decalScale", "decalPosition", ["badge", "hero"], ["tail", "nose"])
    );
    this.#panel.append(labs);

    this.#panel.append(
      this.#row("energy", [
        this.#slider("rimGlow", "Rim glow", "quiet", "neon"),
        this.#slider("screenTint", "Screen tint", "clear", "smoked")
      ])
    );

    const random = document.createElement("button");
    random.type = "button";
    random.className = "avatar-random";
    random.textContent = "surprise me";
    random.addEventListener("click", () => this.#set(randomScooterConfig()));
    this.#panel.append(random);
    this.#paintVisualPreviews();
  }
}
