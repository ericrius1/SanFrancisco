import {
  SURFBOARD_COLORS,
  SURFBOARD_DECALS,
  SURFBOARD_SHAPES,
  SURFBOARD_SURFACES,
  normalizeSurfboardConfig,
  paintSurfboardSurface,
  prepareSurfboardSurface,
  randomSurfboardConfig,
  surfboardAccentHex,
  surfboardBaseHex,
  surfboardKey,
  surfboardRailHex,
  surfboardSurfacePaintKey,
  type SurfboardConfig
} from "../vehicles/surf";

type ColorRow = "base" | "rail" | "accent";
type PadKind = "texture" | "offset" | "motion" | "decal" | "decal-position";
type PadKey =
  | "textureZoom"
  | "textureRotation"
  | "textureOffsetX"
  | "textureOffsetY"
  | "surfaceMotion"
  | "surfaceShimmer"
  | "decalScale"
  | "decalRotation"
  | "decalX"
  | "decalY";

const COLOR_ROWS = {
  base: { indexKey: "base", hexKey: "baseHex", resolve: surfboardBaseHex },
  rail: { indexKey: "rail", hexKey: "railHex", resolve: surfboardRailHex },
  accent: { indexKey: "accent", hexKey: "accentHex", resolve: surfboardAccentHex }
} as const;

const css = (hex: number) => `#${hex.toString(16).padStart(6, "0")}`;

/**
 * A visual-only surfboard shaping room. Pads preview at animation-frame cadence
 * and commit once on release, keeping storage/network updates quiet.
 */
export class SurfboardSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: SurfboardConfig;
  #onChange: (config: SurfboardConfig) => void;
  #onPreview: (config: SurfboardConfig) => void;
  #onOpen: () => void;
  #open = false;
  #visible = false;
  #previewCanvases = new Map<PadKind, HTMLCanvasElement>();
  #surfaceSource = document.createElement("canvas");
  #previewFrame = 0;
  #assetSerial = 0;
  #sourcePaintKey = "";

  constructor(
    initial: SurfboardConfig,
    onChange: (config: SurfboardConfig) => void,
    onPreview: (config: SurfboardConfig) => void,
    onOpen: () => void
  ) {
    this.#config = normalizeSurfboardConfig(initial);
    this.#onChange = onChange;
    this.#onPreview = onPreview;
    this.#onOpen = onOpen;
    this.#surfaceSource.width = 256;
    this.#surfaceSource.height = 512;

    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui board-ui surfboard-ui";
    this.#toggle = document.createElement("button");
    this.#toggle.type = "button";
    this.#toggle.className = "avatar-toggle board-toggle surfboard-toggle";
    this.#toggle.title = "Surfboard shaping room";
    this.#toggle.setAttribute("aria-label", "Open surfboard shaping room");
    this.#toggle.innerHTML = '<img class="customizer-icon" src="/ui/customizer-icons/surfboard.webp" alt="" draggable="false">';
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));

    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel board-panel surfboard-panel";
    this.#root.append(this.#toggle, this.#panel);
    document.getElementById("hud")?.appendChild(this.#root);
    this.#render();
  }

  setOpen(open: boolean): void {
    if (open && !this.#visible) return;
    this.#open = open;
    this.#root.classList.toggle("open", open);
    this.#toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      this.#onOpen();
      this.#loadSelectedAssets();
      this.#startPreviewLoop();
    } else if (this.#previewFrame) {
      cancelAnimationFrame(this.#previewFrame);
      this.#previewFrame = 0;
    }
  }

  /** The shaping room belongs exclusively to the surf activity context. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.#root.hidden = !visible;
    if (!visible && this.#open) this.setOpen(false);
  }

  setConfig(config: SurfboardConfig): void {
    this.#config = normalizeSurfboardConfig(config);
    this.#render();
  }

  #commit(next: Partial<SurfboardConfig>): void {
    this.#config = normalizeSurfboardConfig({ ...this.#config, ...next });
    this.#render();
    this.#onChange({ ...this.#config });
    if (this.#open) this.#loadSelectedAssets();
  }

  #choice<K extends "shape" | "surface" | "decal">(
    key: K,
    value: SurfboardConfig[K],
    label: string,
    title?: string
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "avatar-choice";
    button.textContent = label;
    if (title) button.title = title;
    button.classList.toggle("on", this.#config[key] === value);
    button.addEventListener("click", () => this.#commit({ [key]: value } as Partial<SurfboardConfig>));
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

  #colorRow(row: ColorRow): HTMLElement {
    const spec = COLOR_ROWS[row];
    const buttons: HTMLElement[] = SURFBOARD_COLORS.map((entry, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "avatar-swatch";
      button.style.background = css(entry.color);
      button.title = entry.label;
      button.setAttribute("aria-label", `${row}: ${entry.label}`);
      button.classList.toggle("on", this.#config[spec.indexKey] === index && this.#config[spec.hexKey] === null);
      button.addEventListener("click", () =>
        this.#commit({ [spec.indexKey]: index, [spec.hexKey]: null } as Partial<SurfboardConfig>)
      );
      return button;
    });

    const picker = document.createElement("input");
    picker.type = "color";
    picker.className = "scooter-color-input surfboard-color-input";
    picker.title = `Custom ${row}`;
    picker.setAttribute("aria-label", `Custom ${row} color`);
    picker.value = css(spec.resolve(this.#config));
    picker.addEventListener("input", () => {
      this.#config = normalizeSurfboardConfig({
        ...this.#config,
        [spec.hexKey]: Number.parseInt(picker.value.slice(1), 16)
      });
      this.#paintVisualPreviews();
      this.#onPreview({ ...this.#config });
    });
    picker.addEventListener("change", () =>
      this.#commit({ [spec.hexKey]: Number.parseInt(picker.value.slice(1), 16) } as Partial<SurfboardConfig>)
    );
    buttons.push(picker);
    return this.#row(row, buttons);
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
    lab.className = `board-lab board-lab-${kind} surfboard-lab`;
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
    pad.setAttribute(
      "aria-label",
      `${title}: horizontal ${xLabels[0]} to ${xLabels[1]}, vertical ${yLabels[0]} to ${yLabels[1]}`
    );
    const canvas = document.createElement("canvas");
    canvas.className = "board-xy-canvas";
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
      pad.setAttribute(
        "aria-valuetext",
        `${xLabels[0]} ${100 - x}%, ${xLabels[1]} ${x}%; ${yLabels[0]} ${100 - y}%, ${yLabels[1]} ${y}%`
      );
    };

    const apply = (x: number, y: number) => {
      this.#config = normalizeSurfboardConfig({
        ...this.#config,
        [xKey]: Math.round(THREE_CLAMP(x)),
        [yKey]: Math.round(THREE_CLAMP(y))
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

  #paintVisualPreviews(time = performance.now()): void {
    const paintKey = surfboardSurfacePaintKey(this.#config);
    if (paintKey !== this.#sourcePaintKey) {
      paintSurfboardSurface(this.#surfaceSource, this.#config);
      this.#sourcePaintKey = paintKey;
    }
    for (const [kind, canvas] of this.#previewCanvases) {
      const ctx = canvas.getContext("2d");
      if (!ctx) continue;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const motion = kind === "motion" ? this.#config.surfaceMotion / 100 : 0;
      const drift = Math.sin(time * 0.00035) * canvas.width * 0.045 * motion;
      ctx.drawImage(this.#surfaceSource, drift - 4, -4, canvas.width + 8, canvas.height + 8);
      if (kind === "motion") {
        const shimmer = this.#config.surfaceShimmer / 100;
        const glow = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
        const p = ((time * 0.00008) % 1) * 1.4 - 0.2;
        // The animated highlight intentionally travels beyond both edges, but
        // CanvasGradient rejects even a tiny out-of-range stop. Clamp every
        // stop (not only the centre) so long-open shaping rooms stay exception-free.
        const stop = (value: number) => Math.max(0, Math.min(1, value));
        glow.addColorStop(stop(p - 0.18), "rgba(255,255,255,0)");
        glow.addColorStop(stop(p), `rgba(255,255,255,${0.08 + shimmer * 0.28})`);
        glow.addColorStop(stop(p + 0.18), "rgba(255,255,255,0)");
        ctx.fillStyle = glow;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
  }

  #loadSelectedAssets(): void {
    const serial = ++this.#assetSerial;
    const key = surfboardKey(this.#config);
    void prepareSurfboardSurface(this.#config).then(() => {
      if (serial !== this.#assetSerial || key !== surfboardKey(this.#config)) return;
      // The selected PNG may have arrived without any config value changing.
      this.#sourcePaintKey = "";
      this.#paintVisualPreviews();
      this.#onPreview({ ...this.#config });
    });
  }

  #startPreviewLoop(): void {
    if (!this.#open || this.#previewFrame) return;
    const animate = (time: number) => {
      this.#previewFrame = 0;
      if (!this.#open) return;
      this.#paintVisualPreviews(time);
      this.#previewFrame = requestAnimationFrame(animate);
    };
    this.#previewFrame = requestAnimationFrame(animate);
  }

  #render(): void {
    this.#panel.replaceChildren();
    this.#previewCanvases.clear();

    const header = document.createElement("header");
    header.className = "board-panel-head";
    header.innerHTML = `<span>SURF SHAPING ROOM</span><small>shape · art · flow</small>`;
    this.#panel.append(
      header,
      this.#row(
        "shape",
        SURFBOARD_SHAPES.map((entry) => this.#choice("shape", entry.id, entry.label, entry.note))
      ),
      this.#colorRow("base"),
      this.#colorRow("rail"),
      this.#colorRow("accent"),
      this.#row(
        "art",
        SURFBOARD_SURFACES.map((entry) => this.#choice("surface", entry.id, entry.label, entry.kind))
      ),
      this.#row(
        "decal",
        SURFBOARD_DECALS.map((entry) => this.#choice("decal", entry.id, entry.label))
      )
    );

    const labs = document.createElement("div");
    labs.className = "board-labs surfboard-labs";
    labs.append(
      this.#pad("texture", "ART / 01", "zoom × rotation", "textureZoom", "textureRotation", ["wide", "close"], ["left", "right"]),
      this.#pad("offset", "POSITION / 02", "horizontal × vertical", "textureOffsetX", "textureOffsetY", ["west", "east"], ["tail", "nose"]),
      this.#pad("motion", "FLOW / 03", "drift × shimmer", "surfaceMotion", "surfaceShimmer", ["still", "drift"], ["matte", "pearl"]),
      this.#pad("decal", "DECAL / 04", "scale × rotation", "decalScale", "decalRotation", ["tiny", "hero"], ["left", "right"]),
      this.#pad("decal-position", "PLACE / 05", "horizontal × vertical", "decalX", "decalY", ["left", "right"], ["tail", "nose"])
    );
    this.#panel.append(labs);

    const random = document.createElement("button");
    random.type = "button";
    random.className = "avatar-random";
    random.textContent = "surprise me";
    random.addEventListener("click", () => this.#commit(randomSurfboardConfig()));
    this.#panel.append(random);

    this.#paintVisualPreviews();
    if (this.#open) this.#startPreviewLoop();
  }
}

function THREE_CLAMP(value: number): number {
  return Math.max(0, Math.min(100, value));
}
