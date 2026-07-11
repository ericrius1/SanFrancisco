import {
  BOARD_DECK_COLORS,
  BOARD_FINS,
  BOARD_FX,
  BOARD_GLOW_COLORS,
  BOARD_HUMS,
  BOARD_PITCHES,
  BOARD_SHAPES,
  BOARD_SURFACES,
  boardDeckHex,
  boardGlowHex,
  boardPlumeHex,
  boardTrimHex,
  normalizeBoardConfig,
  randomBoardConfig,
  type BoardConfig
} from "../vehicles/board/config";
import { paintBoardSurface } from "../vehicles/board/surfaceTexture";

type PreviewKind = "surface" | "sound";
type LabKind = "surface" | "motion" | "plume" | "sound" | "thrust";
type PadKey =
  | "surfaceScale"
  | "surfaceWarp"
  | "surfaceFlow"
  | "surfaceFx"
  | "plumeReach"
  | "plumeShimmer"
  | "soundTone"
  | "soundMotion"
  | "soundThrust"
  | "soundAir";

const isAudioLab = (kind: LabKind) => kind === "sound" || kind === "thrust";

// Every paintable slot: which palette index it rides, which custom-hex field
// overrides it, and which palette its swatch row draws from. The rainbow
// swatch + inline picker are generic over this table.
const COLOR_ROWS = {
  deck: { indexKey: "deck", hexKey: "deckHex", palette: BOARD_DECK_COLORS, resolve: boardDeckHex },
  trim: { indexKey: "trim", hexKey: "trimHex", palette: BOARD_DECK_COLORS, resolve: boardTrimHex },
  glow: { indexKey: "glow", hexKey: "glowHex", palette: BOARD_GLOW_COLORS, resolve: boardGlowHex },
  plume: { indexKey: "plumeGlow", hexKey: "plumeHex", palette: BOARD_GLOW_COLORS, resolve: boardPlumeHex }
} as const;
type ColorRow = keyof typeof COLOR_ROWS;

// The inline picker's fixed color space: x sweeps hue, y sweeps lightness
// between these rails, saturation stays put — every reachable color is usable.
const PICKER_SAT = 0.85;
const PICKER_LIGHT_TOP = 0.92;
const PICKER_LIGHT_BOTTOM = 0.18;

const hexString = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

function hslChannel(p: number, q: number, t: number) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToHex(h: number, s: number, l: number): number {
  const hue = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hslChannel(p, q, hue + 1 / 3) * 255);
  const g = Math.round(hslChannel(p, q, hue) * 255);
  const b = Math.round(hslChannel(p, q, hue - 1 / 3) * 255);
  return (r << 16) | (g << 8) | b;
}

/** Just enough of the inverse to place the picker crosshair on a saved hex. */
function hexToHueLight(hex: number): { hue: number; light: number } {
  const r = ((hex >> 16) & 255) / 255;
  const g = ((hex >> 8) & 255) / 255;
  const b = (hex & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const d = max - min;
  let hue = 0;
  if (d > 0) {
    if (max === r) hue = ((g - b) / d) % 6;
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, light };
}

/**
 * The hoverboard garage is a tiny instrument, not just a preset list. Three
 * visual pads shape the deck, its motion, and the thruster plume; two audio
 * pads shape the voice + thrust. Every paintable slot also takes a fully
 * custom color via an inline hue×lightness picker. Moves preview while held,
 * then commit once on release so persistence, mesh rebuilds, and net sync
 * stay calm.
 */
export class BoardSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: BoardConfig;
  #onChange: (config: BoardConfig) => void;
  #onPreview: (config: BoardConfig, kind: PreviewKind) => void;
  #onSoundEdit: () => void;
  #onOpen: () => void;
  #open = false;
  #previewCanvases = new Map<LabKind, HTMLCanvasElement>();
  #surfaceSource = document.createElement("canvas");
  #previewFrame = 0;
  #fxOpen = false; // effect drawer survives re-renders (chip clicks rebuild the panel)
  #pickerOpen: ColorRow | null = null; // one custom-color picker at a time; survives re-renders

  constructor(
    initial: BoardConfig,
    onChange: (config: BoardConfig) => void,
    onPreview: (config: BoardConfig, kind: PreviewKind) => void,
    onSoundEdit: () => void,
    onOpen: () => void
  ) {
    this.#config = normalizeBoardConfig(initial);
    this.#onChange = onChange;
    this.#onPreview = onPreview;
    this.#onSoundEdit = onSoundEdit;
    this.#onOpen = onOpen;
    this.#surfaceSource.width = 256;
    this.#surfaceSource.height = 160;

    const hud = document.getElementById("hud")!;
    this.#root = document.createElement("div");
    this.#root.className = "avatar-ui board-ui";

    this.#toggle = document.createElement("button");
    this.#toggle.className = "avatar-toggle board-toggle";
    this.#toggle.type = "button";
    this.#toggle.title = "Hoverboard lab";
    this.#toggle.setAttribute("aria-label", "Open hoverboard lab");
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#root.appendChild(this.#toggle);

    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel board-panel";
    this.#root.appendChild(this.#panel);

    hud.appendChild(this.#root);
    this.#render();
  }

  setOpen(open: boolean) {
    this.#open = open;
    this.#root.classList.toggle("open", open);
    this.#toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      this.#onOpen();
      this.#startPreviewLoop();
    } else if (this.#previewFrame) {
      cancelAnimationFrame(this.#previewFrame);
      this.#previewFrame = 0;
    }
  }

  /** Reflect an externally-assigned board without firing edits. */
  setConfig(config: BoardConfig) {
    this.#config = normalizeBoardConfig(config);
    this.#render();
  }

  #set(next: Partial<BoardConfig>, sound = false) {
    this.#config = normalizeBoardConfig({ ...this.#config, ...next });
    this.#render();
    this.#onChange({ ...this.#config });
    if (sound) this.#onSoundEdit();
  }

  #button<K extends "shape" | "fin" | "surface" | "hum">(
    key: K,
    id: BoardConfig[K],
    label: string,
    sound = false
  ) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-choice";
    b.textContent = label;
    b.classList.toggle("on", this.#config[key] === id);
    b.addEventListener("click", () => this.#set({ [key]: id } as Partial<BoardConfig>, sound));
    return b;
  }

  #swatch(row: ColorRow, index: number, color: number, label: string) {
    const { indexKey, hexKey } = COLOR_ROWS[row];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-swatch";
    b.title = label;
    b.setAttribute("aria-label", `${row}: ${label}`);
    const hex = hexString(color);
    b.style.background = hex;
    if (row === "glow" || row === "plume") b.style.boxShadow = `0 0 8px ${hex}, inset 0 -4px 0 rgba(0, 0, 0, 0.14)`;
    b.classList.toggle("on", this.#config[indexKey] === index && this.#config[hexKey] === null);
    // a palette pick always clears the custom paint — the swatch wins again
    b.addEventListener("click", () => this.#set({ [indexKey]: index, [hexKey]: null } as Partial<BoardConfig>));
    return b;
  }

  /** The 9th swatch on every color row: rainbow chip that slides the inline
   *  hue×lightness picker open under the row. Lit while custom paint is live. */
  #customSwatch(row: ColorRow) {
    const { hexKey } = COLOR_ROWS[row];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-swatch board-swatch-custom";
    b.title = "custom color";
    b.setAttribute("aria-label", `${row}: custom color`);
    b.classList.toggle("on", this.#config[hexKey] !== null);
    b.setAttribute("aria-expanded", String(this.#pickerOpen === row));
    b.addEventListener("click", () => {
      this.#pickerOpen = this.#pickerOpen === row ? null : row;
      this.#render(); // no config edit — the field survives the rebuild
    });
    return b;
  }

  /** Inline hue×lightness canvas picker. Drags preview live like the XY pads;
   *  release commits through #set so persistence/net see one edit. */
  #colorPicker(row: ColorRow) {
    const { hexKey, resolve } = COLOR_ROWS[row];
    const drawer = document.createElement("div");
    drawer.className = `board-color-picker board-color-picker-${row}`;
    const open = this.#pickerOpen === row;
    drawer.classList.toggle("picker-open", open);

    const canvas = document.createElement("canvas");
    canvas.className = "board-picker-canvas";
    canvas.width = 240;
    canvas.height = 90;
    const readout = document.createElement("output");
    readout.className = "board-picker-hex";
    drawer.append(canvas, readout);
    if (!open) return drawer; // painted lazily: closed drawers stay blank

    const ctx = canvas.getContext("2d")!;
    const w = canvas.width;
    const h = canvas.height;
    // paint the field once per open; crosshair redraws restore from this
    const base = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      const light = PICKER_LIGHT_TOP - (y / (h - 1)) * (PICKER_LIGHT_TOP - PICKER_LIGHT_BOTTOM);
      for (let x = 0; x < w; x++) {
        const hex = hslToHex((x / (w - 1)) * 360, PICKER_SAT, light);
        const i = (y * w + x) * 4;
        base.data[i] = (hex >> 16) & 255;
        base.data[i + 1] = (hex >> 8) & 255;
        base.data[i + 2] = hex & 255;
        base.data[i + 3] = 255;
      }
    }

    const draw = (hex: number | null) => {
      ctx.putImageData(base, 0, 0);
      readout.value = hexString(hex ?? resolve(this.#config));
      if (hex === null) return; // no custom paint yet — field only, no crosshair
      const { hue, light } = hexToHueLight(hex);
      const cx = (hue / 360) * (w - 1);
      const clamped = Math.max(PICKER_LIGHT_BOTTOM, Math.min(PICKER_LIGHT_TOP, light));
      const cy = ((PICKER_LIGHT_TOP - clamped) / (PICKER_LIGHT_TOP - PICKER_LIGHT_BOTTOM)) * (h - 1);
      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(6, 16, 22, 0.9)";
      ctx.lineWidth = 3.4;
      ctx.stroke();
      ctx.strokeStyle = "#f4fffb";
      ctx.lineWidth = 1.7;
      ctx.stroke();
    };

    const pick = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      const u = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
      const v = Math.max(0, Math.min(1, (e.clientY - r.top) / Math.max(1, r.height)));
      return hslToHex(u * 360, PICKER_SAT, PICKER_LIGHT_TOP - v * (PICKER_LIGHT_TOP - PICKER_LIGHT_BOTTOM));
    };

    let pointer = -1;
    let held: number | null = null;
    canvas.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pointer = e.pointerId;
      canvas.setPointerCapture(e.pointerId);
      held = pick(e);
      draw(held);
      this.#onPreview({ ...this.#config, [hexKey]: held }, "surface");
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pointer) return;
      held = pick(e);
      draw(held);
      this.#onPreview({ ...this.#config, [hexKey]: held }, "surface");
    });
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      pointer = -1;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (held !== null) this.#set({ [hexKey]: held } as Partial<BoardConfig>);
      held = null;
    };
    canvas.addEventListener("pointerup", finish);
    canvas.addEventListener("pointercancel", finish);

    draw(this.#config[hexKey]);
    return drawer;
  }

  #row(label: string, children: HTMLElement[]) {
    const row = document.createElement("div");
    row.className = "avatar-row";
    const name = document.createElement("div");
    name.className = "avatar-label";
    name.textContent = label;
    const controls = document.createElement("div");
    controls.className = "avatar-controls";
    for (const child of children) controls.appendChild(child);
    row.append(name, controls);
    return row;
  }

  #xyLab(
    kind: LabKind,
    title: string,
    subtitle: string,
    xKey: PadKey,
    yKey: PadKey,
    xLabels: [string, string],
    yLabels: [string, string],
    action?: { label: string; title: string; run: () => void }
  ) {
    const lab = document.createElement("section");
    lab.className = `board-lab board-lab-${kind}`;

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
    const tools = document.createElement("div");
    tools.className = "board-lab-tools";
    tools.appendChild(readout);
    if (action) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "board-lab-reroll";
      button.textContent = action.label;
      button.title = action.title;
      button.setAttribute("aria-label", action.title);
      button.addEventListener("click", action.run);
      tools.appendChild(button);
    }
    head.append(heading, tools);

    const pad = document.createElement("div");
    pad.className = "board-xy-pad";
    pad.tabIndex = 0;
    pad.setAttribute("role", "group");
    pad.setAttribute("aria-roledescription", "two-dimensional control");
    pad.setAttribute("aria-keyshortcuts", "ArrowLeft ArrowRight ArrowUp ArrowDown");
    pad.setAttribute("aria-label", `${title}: horizontal ${xLabels[0]} to ${xLabels[1]}, vertical ${yLabels[0]} to ${yLabels[1]}`);
    const canvas = document.createElement("canvas");
    canvas.className = "board-xy-canvas";
    canvas.width = 256;
    canvas.height = 160;
    const grid = document.createElement("span");
    grid.className = "board-xy-grid";
    const puck = document.createElement("span");
    puck.className = "board-xy-puck";
    const x0 = document.createElement("span");
    x0.className = "board-axis board-axis-x0";
    x0.textContent = xLabels[0];
    const x1 = document.createElement("span");
    x1.className = "board-axis board-axis-x1";
    x1.textContent = xLabels[1];
    const y0 = document.createElement("span");
    y0.className = "board-axis board-axis-y0";
    y0.textContent = yLabels[0];
    const y1 = document.createElement("span");
    y1.className = "board-axis board-axis-y1";
    y1.textContent = yLabels[1];
    pad.append(canvas, grid, puck, x0, x1, y0, y1);
    lab.append(head, pad);

    this.#previewCanvases.set(kind, canvas);

    const draw = () => {
      const x = this.#config[xKey];
      const y = this.#config[yKey];
      puck.style.left = `${x}%`;
      puck.style.top = `${100 - y}%`;
      readout.value = `${x.toString().padStart(2, "0")} · ${y.toString().padStart(2, "0")}`;
      const valueText = `${xLabels[0]} ${100 - x}%, ${xLabels[1]} ${x}%; ${yLabels[0]} ${100 - y}%, ${yLabels[1]} ${y}%`;
      readout.setAttribute("aria-label", `${title}: ${valueText}`);
      pad.setAttribute("aria-valuetext", valueText);
    };

    const apply = (x: number, y: number, preview = true) => {
      this.#config = normalizeBoardConfig({
        ...this.#config,
        [xKey]: Math.round(Math.max(0, Math.min(100, x))),
        [yKey]: Math.round(Math.max(0, Math.min(100, y)))
      });
      draw();
      if (kind === "surface") this.#paintVisualPreviews();
      else if (kind === "motion") this.#drawMotionPreview(performance.now());
      else if (kind === "plume") this.#drawPlumePreview(performance.now());
      if (preview) this.#onPreview({ ...this.#config }, isAudioLab(kind) ? "sound" : "surface");
    };

    const point = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      return {
        x: ((e.clientX - r.left) / Math.max(1, r.width)) * 100,
        y: (1 - (e.clientY - r.top) / Math.max(1, r.height)) * 100
      };
    };

    let pointer = -1;
    let pending: { x: number; y: number } | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      if (!pending) return;
      const next = pending;
      pending = null;
      apply(next.x, next.y);
    };
    const queue = (p: { x: number; y: number }) => {
      pending = p;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const finish = (e: PointerEvent, useEventPoint: boolean) => {
      if (e.pointerId !== pointer) return;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      const last = pending;
      pending = null;
      if (useEventPoint) {
        const p = point(e);
        apply(p.x, p.y);
      } else if (last) {
        apply(last.x, last.y);
      }
      pointer = -1;
      pad.classList.remove("dragging");
      if (pad.hasPointerCapture(e.pointerId)) pad.releasePointerCapture(e.pointerId);
      this.#onChange({ ...this.#config });
    };
    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      pointer = e.pointerId;
      pad.setPointerCapture(e.pointerId);
      pad.classList.add("dragging");
      if (isAudioLab(kind)) this.#onSoundEdit();
      queue(point(e));
    });
    pad.addEventListener("pointermove", (e) => {
      if (e.pointerId === pointer) queue(point(e));
    });
    pad.addEventListener("pointerup", (e) => finish(e, true));
    pad.addEventListener("pointercancel", (e) => finish(e, false));
    pad.addEventListener("lostpointercapture", (e) => finish(e, false));

    pad.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 10 : 2;
      let x = this.#config[xKey];
      let y = this.#config[yKey];
      if (e.key === "ArrowLeft") x -= step;
      else if (e.key === "ArrowRight") x += step;
      else if (e.key === "ArrowDown") y -= step;
      else if (e.key === "ArrowUp") y += step;
      else return;
      e.preventDefault();
      e.stopPropagation();
      if (isAudioLab(kind)) this.#onSoundEdit();
      apply(x, y);
      this.#onChange({ ...this.#config });
    });

    draw();
    return lab;
  }

  /** Effect picker that slides out of the MOTION lab when its header (or the
   *  effect button) is clicked. Chip clicks commit like any other edit. */
  #attachFxDrawer(lab: HTMLElement) {
    const head = lab.querySelector<HTMLElement>(".board-lab-head")!;
    // the toggle lives on the subtitle line — the header line has no room left
    // beside the readout without wrapping the lab title
    const sub = head.querySelector<HTMLElement>(".board-lab-sub")!;
    const current = BOARD_FX.find((f) => f.id === this.#config.surfaceFxKind) ?? BOARD_FX[0];

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "board-fx-toggle";
    toggle.textContent = `${current.label} ▾`;
    toggle.title = "Choose the deck effect";
    const setOpen = (open: boolean) => {
      this.#fxOpen = open;
      lab.classList.toggle("fx-open", open);
      toggle.setAttribute("aria-expanded", String(open));
    };
    toggle.addEventListener("click", () => setOpen(!this.#fxOpen));
    sub.appendChild(toggle);
    head.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) return; // the button handles itself
      setOpen(!this.#fxOpen);
    });

    const drawer = document.createElement("div");
    drawer.className = "board-fx-drawer";
    const chips = document.createElement("div");
    chips.className = "board-fx-chips";
    for (const f of BOARD_FX) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "avatar-choice";
      chip.textContent = f.label;
      chip.classList.toggle("on", this.#config.surfaceFxKind === f.id);
      chip.addEventListener("click", () => this.#set({ surfaceFxKind: f.id }));
      chips.appendChild(chip);
    }
    drawer.appendChild(chips);
    lab.appendChild(drawer);
    setOpen(this.#fxOpen);
  }

  #paintVisualPreviews() {
    paintBoardSurface(this.#surfaceSource, this.#config);
    const deck = this.#previewCanvases.get("surface");
    const ctx = deck?.getContext("2d");
    if (deck && ctx) {
      ctx.clearRect(0, 0, deck.width, deck.height);
      ctx.drawImage(this.#surfaceSource, 0, 0, deck.width, deck.height);
    }
    this.#drawMotionPreview(performance.now());
  }

  /** Flow streams the artwork; the chosen effect overlays its own signature.
   *  These are cheap 2D sketches of the real shader — the live board next to
   *  the panel is the true preview. */
  #drawMotionPreview(time: number) {
    const canvas = this.#previewCanvases.get("motion");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const flow = this.#config.surfaceFlow / 100;
    const fx = this.#config.surfaceFx / 100;
    const kind = this.#config.surfaceFxKind;
    // flow reads at a glance: still pad when 0, artwork visibly streaming when up
    const drift = (time * (0.01 + flow * 0.16)) % w;

    ctx.fillStyle = "#07131d";
    ctx.fillRect(0, 0, w, h);
    ctx.save();
    ctx.translate(w * 0.5, h * 0.5 + Math.sin(time * 0.0017) * flow * 3.2);
    const swirl = kind === "vortex" ? Math.sin(time * (0.0005 + flow * 0.0016)) * fx * 0.4 : 0;
    const pulse = kind === "ripple" ? 1 + Math.sin(time * (0.0015 + flow * 0.005)) * fx * 0.05 : 1;
    ctx.rotate(Math.sin(time * 0.0011) * flow * 0.05 + swirl);
    ctx.scale(pulse, pulse);
    ctx.translate(-w * 0.5, -h * 0.5);
    for (let x = -w - drift; x < w * 2; x += w) {
      ctx.drawImage(this.#surfaceSource, x, 0, w, h);
    }
    ctx.restore();

    if (fx < 0.01) return;
    if (kind === "vortex") {
      // spiral arms winding tighter as strength rises
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.translate(w * 0.5, h * 0.5);
      ctx.strokeStyle = `rgba(121,255,220,${0.12 + fx * 0.42})`;
      ctx.lineWidth = 1.4 + fx * 1.6;
      const spin = time * (0.0005 + flow * 0.0024);
      for (let arm = 0; arm < 3; arm++) {
        ctx.beginPath();
        for (let i = 0; i <= 26; i++) {
          const u = i / 26;
          const a = spin + arm * ((Math.PI * 2) / 3) + u * Math.PI * (0.7 + fx * 1.5);
          const r = 5 + u * h * 0.52;
          const px = Math.cos(a) * r * 1.35;
          const py = Math.sin(a) * r * 0.85;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      ctx.restore();
    } else if (kind === "ripple") {
      // shockwave rings racing outward from the deck centre
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      for (let k = 0; k < 3; k++) {
        const cycle = (time * (0.0003 + flow * 0.0011) + k / 3) % 1;
        ctx.strokeStyle = `rgba(121,255,220,${(1 - cycle) * fx * 0.6})`;
        ctx.lineWidth = 1.5 + fx * 2 * (1 - cycle);
        ctx.beginPath();
        ctx.ellipse(w * 0.5, h * 0.5, (0.04 + cycle * 0.5) * w, (0.05 + cycle * 0.52) * h, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // kaleido: mirrored petals fold the frame into a spinning mandala
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      ctx.translate(w * 0.5, h * 0.5);
      ctx.rotate(time * (0.0004 + flow * 0.0016));
      const petals = 8;
      const reach = Math.min(w, h) * (0.18 + fx * 0.34);
      ctx.strokeStyle = `rgba(121,255,220,${0.14 + fx * 0.5})`;
      ctx.lineWidth = 1 + fx * 1.4;
      for (let i = 0; i < petals; i++) {
        const a = (i / petals) * Math.PI * 2;
        const tip = [Math.cos(a) * reach, Math.sin(a) * reach];
        const bend = 0.34;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.quadraticCurveTo(Math.cos(a - bend) * reach * 0.7, Math.sin(a - bend) * reach * 0.7, tip[0], tip[1]);
        ctx.quadraticCurveTo(Math.cos(a + bend) * reach * 0.7, Math.sin(a + bend) * reach * 0.7, 0, 0);
        ctx.stroke();
      }
      // bright core where every mirror seam meets
      ctx.fillStyle = `rgba(121,255,220,${fx * 0.3})`;
      ctx.beginPath();
      ctx.arc(0, 0, 2 + fx * 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /** Thruster energy sketch: four pods — two hover columns + two aft push
   *  streams. Reach sets length, shimmer how hard they fizz, sparks add motes.
   *  Always animated — even a calm wisp must drift so the pad reads live. */
  #drawPlumePreview(time: number) {
    const canvas = this.#previewCanvases.get("plume");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const reach = this.#config.plumeReach / 100;
    const shimmer = this.#config.plumeShimmer / 100;
    const tint = boardPlumeHex(this.#config);
    const r = (tint >> 16) & 255;
    const g = (tint >> 8) & 255;
    const b = tint & 255;

    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, "#050f18");
    bg.addColorStop(1, "#0b1e28");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    // hover pair (up) + thrust pair (aft / to the right)
    const streams: { x: number; y: number; ang: number; seed: number }[] = [
      { x: w * 0.28, y: h * 0.82, ang: -Math.PI / 2, seed: 0 },
      { x: w * 0.48, y: h * 0.82, ang: -Math.PI / 2, seed: 1 },
      { x: w * 0.62, y: h * 0.38, ang: 0, seed: 2 },
      { x: w * 0.62, y: h * 0.62, ang: 0, seed: 3 }
    ];
    const len = Math.min(w, h) * (0.14 + reach * 0.55);
    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (const stream of streams) {
      const px = stream.x;
      const baseY = stream.y;
      const cosA = Math.cos(stream.ang);
      const sinA = Math.sin(stream.ang);
      // pod nub + hot core glow
      ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
      ctx.beginPath();
      ctx.ellipse(px, baseY, 8, 3, stream.ang, 0, Math.PI * 2);
      ctx.fill();
      const midX = px + cosA * len * 0.4;
      const midY = baseY + sinA * len * 0.4;
      ctx.fillStyle = `rgba(${r},${g},${b},${0.1 + reach * 0.1})`;
      ctx.beginPath();
      ctx.ellipse(midX, midY, 9 + shimmer * 4, len * 0.55 + 3, stream.ang, 0, Math.PI * 2);
      ctx.fill();
      for (let s = 0; s < 4; s++) {
        const seed = stream.seed * 4 + s;
        const sway = 1.5 + shimmer * 7.5;
        const speed = 0.0016 + shimmer * 0.0042;
        const breathe = 0.6 + 0.4 * Math.abs(Math.sin(seed * 2.3 + time * 0.0009));
        ctx.strokeStyle = `rgba(${r},${g},${b},${0.16 + 0.5 / (1 + s)})`;
        ctx.lineWidth = s === 0 ? 2.6 : 1.3;
        ctx.beginPath();
        for (let i = 0; i <= 18; i++) {
          const u = i / 18;
          const along = 2 + u * len * breathe;
          const wob =
            Math.sin(u * (3 + shimmer * 9) + time * speed * (1 + seed * 0.13) + seed * 5.1) * sway * u +
            Math.sin(time * 0.0011 + seed) * 1.3 * u;
          const side = (s - 1.5) * (1.4 + shimmer * 2.2) * u + wob;
          const x = px + cosA * along - sinA * side;
          const y = baseY + sinA * along + cosA * side;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      if (this.#config.plumeSparks) {
        for (let i = 0; i < 5; i++) {
          const cycle = (time * (0.00022 + shimmer * 0.0005) + i / 5 + stream.seed * 0.25) % 1;
          const along = 4 + cycle * len;
          const side = Math.sin(cycle * Math.PI * (2 + shimmer * 6) + i * 2.7 + stream.seed) * (3 + shimmer * 8);
          const x = px + cosA * along - sinA * side;
          const y = baseY + sinA * along + cosA * side;
          ctx.fillStyle = `rgba(255,255,255,${(1 - cycle) * 0.65})`;
          ctx.beginPath();
          ctx.arc(x, y, 1 + (1 - cycle) * 1.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  #drawVoicePreview(time: number) {
    const canvas = this.#previewCanvases.get("sound");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const tone = this.#config.soundTone / 100;
    const motion = this.#config.soundMotion / 100;
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#091724");
    bg.addColorStop(1, "#153a3d");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
    const phase = time * (0.00035 + motion * 0.0024);
    for (let band = 0; band < 3; band++) {
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const u = x / w;
        const wave = Math.sin(u * Math.PI * (2.4 + tone * 5 + band) + phase * (band + 1));
        const shimmer = Math.sin(u * Math.PI * 13 - phase * 1.7) * motion * 0.18;
        const y = h * (0.28 + band * 0.23) + (wave + shimmer) * (9 + motion * 12);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = band === 1 ? "rgba(106,255,218,.78)" : "rgba(113,203,255,.38)";
      ctx.lineWidth = band === 1 ? 2.4 : 1.4;
      ctx.stroke();
    }
  }

  #drawThrustPreview(time: number) {
    const canvas = this.#previewCanvases.get("thrust");
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = canvas.width;
    const h = canvas.height;
    const thrust = this.#config.soundThrust / 100;
    const air = this.#config.soundAir / 100;
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, "#071722");
    bg.addColorStop(0.62, "#0d2932");
    bg.addColorStop(1, "#17423f");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    const speed = 0.018 + thrust * 0.075;
    for (let band = 0; band < 7; band++) {
      const baseY = h * (0.17 + band * 0.11);
      const phase = time * speed + band * 37;
      ctx.beginPath();
      for (let x = -12; x <= w + 12; x += 4) {
        const u = x / w;
        const flutter = Math.sin(u * Math.PI * (2.2 + band * 0.24) - phase * 0.035) * (2 + air * 10);
        const wake = Math.sin(u * Math.PI * 10 + phase * 0.08) * air * 2.5;
        const y = baseY + flutter + wake;
        if (x === -12) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = band === 3
        ? `rgba(116,255,216,${0.58 + thrust * 0.28})`
        : `rgba(112,206,255,${0.13 + air * 0.16})`;
      ctx.lineWidth = band === 3 ? 2.5 + thrust * 1.2 : 1 + air;
      ctx.stroke();
    }

    ctx.save();
    ctx.globalCompositeOperation = "screen";
    for (let i = 0; i < 10; i++) {
      const x = ((i * 31 + time * (0.018 + thrust * 0.065)) % (w + 30)) - 15;
      const y = h * (0.2 + ((i * 47) % 61) / 100) + Math.sin(time * 0.002 + i) * air * 7;
      const radius = 0.8 + air * 1.7;
      ctx.fillStyle = `rgba(151,255,231,${0.12 + air * 0.35})`;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  #startPreviewLoop() {
    if (!this.#open || this.#previewFrame) return;
    const animate = (time: number) => {
      this.#previewFrame = 0;
      if (!this.#open) return;
      this.#drawMotionPreview(time);
      this.#drawPlumePreview(time);
      this.#drawVoicePreview(time);
      this.#drawThrustPreview(time);
      this.#previewFrame = requestAnimationFrame(animate);
    };
    this.#previewFrame = requestAnimationFrame(animate);
  }

  /** One color row (8 palette swatches + rainbow custom) with its slide-open
   *  picker parked directly underneath. */
  #colorRow(label: string, row: ColorRow): HTMLElement[] {
    const { palette } = COLOR_ROWS[row];
    return [
      this.#row(label, [
        ...palette.map((c, i) => this.#swatch(row, i, c.color, c.label)),
        this.#customSwatch(row)
      ]),
      this.#colorPicker(row)
    ];
  }

  /** PLUME / 05: the thruster-energy lab. Full-width — the XY pad rides the
   *  left, sparks toggle + plume color swatches stack on the right, and the
   *  custom picker slides open across the bottom. */
  #plumeLab() {
    const lab = this.#xyLab(
      "plume",
      "PLUME / 05",
      "reach × shimmer",
      "plumeReach",
      "plumeShimmer",
      ["wisp", "beam"],
      ["calm", "fizz"]
    );

    // re-park the pad beside a controls column instead of under the head
    const pad = lab.querySelector<HTMLElement>(".board-xy-pad")!;
    const body = document.createElement("div");
    body.className = "board-plume-body";
    const side = document.createElement("div");
    side.className = "board-plume-side";

    const sparks = document.createElement("button");
    sparks.type = "button";
    sparks.className = "avatar-choice board-plume-sparks";
    sparks.textContent = "sparks";
    sparks.title = "Orbiting spark motes under the pods";
    sparks.classList.toggle("on", this.#config.plumeSparks);
    sparks.addEventListener("click", () => this.#set({ plumeSparks: !this.#config.plumeSparks }));

    const swatches = document.createElement("div");
    swatches.className = "board-plume-swatches";
    for (let i = 0; i < BOARD_GLOW_COLORS.length; i++) {
      swatches.appendChild(this.#swatch("plume", i, BOARD_GLOW_COLORS[i].color, BOARD_GLOW_COLORS[i].label));
    }
    swatches.appendChild(this.#customSwatch("plume"));

    side.append(sparks, swatches);
    body.append(pad, side);
    lab.append(body, this.#colorPicker("plume"));
    return lab;
  }

  #render() {
    const deckHex = hexString(boardDeckHex(this.#config));
    const glowHex = hexString(boardGlowHex(this.#config));
    this.#toggle.innerHTML =
      `<span class="board-ic-deck" style="background:${deckHex}"></span>` +
      `<span class="board-ic-rail" style="background:${glowHex};box-shadow:0 0 7px ${glowHex}"></span>`;

    this.#panel.innerHTML = "";
    this.#previewCanvases.clear();
    const header = document.createElement("header");
    header.className = "board-panel-head";
    header.innerHTML = `<span>BOARD LAB</span><small>shape it · skin it · voice it</small>`;
    this.#panel.append(
      header,
      this.#row(
        "shape",
        BOARD_SHAPES.map((s) => this.#button("shape", s.id, s.label))
      ),
      ...this.#colorRow("deck", "deck"),
      ...this.#colorRow("ink", "trim"),
      ...this.#colorRow("glow", "glow"),
      this.#row(
        "fins",
        BOARD_FINS.map((f) => this.#button("fin", f.id, f.label))
      ),
      this.#row(
        "texture",
        BOARD_SURFACES.map((s) => this.#button("surface", s.id, s.label))
      )
    );

    const labs = document.createElement("div");
    labs.className = "board-labs";
    const surfaceLab = this.#xyLab(
      "surface",
      "DECK / 01",
      "scale × warp",
      "surfaceScale",
      "surfaceWarp",
      ["broad", "fine"],
      ["smooth", "wild"],
      {
        label: "↻",
        title: "Reroll the texture field",
        run: () => this.#set({ surfaceSeed: Math.floor(Math.random() * 65536) })
      }
    );
    const motionLab = this.#xyLab(
      "motion",
      "MOTION / 02",
      "flow × effect",
      "surfaceFlow",
      "surfaceFx",
      ["still", "flow"],
      ["clean", "warped"]
    );
    this.#attachFxDrawer(motionLab);
    labs.append(
      surfaceLab,
      motionLab,
      this.#xyLab(
        "sound",
        "VOICE / 03",
        "tone × LFO",
        "soundTone",
        "soundMotion",
        ["warm", "glass"],
        ["still", "flutter"]
      ),
      this.#xyLab(
        "thrust",
        "THRUST / 04",
        "thrust × air",
        "soundThrust",
        "soundAir",
        ["glide", "punch"],
        ["pure", "airy"]
      ),
      this.#plumeLab()
    );
    this.#panel.append(labs);

    this.#panel.append(
      this.#row(
        "wave",
        BOARD_HUMS.map((h) => this.#button("hum", h.id, h.label, true))
      ),
      this.#row(
        "note",
        BOARD_PITCHES.map((p, i) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "avatar-choice";
          b.textContent = `♪ ${p.label}`;
          b.classList.toggle("on", this.#config.pitch === i);
          b.addEventListener("click", () => this.#set({ pitch: i }, true));
          return b;
        })
      )
    );

    const random = document.createElement("button");
    random.type = "button";
    random.className = "avatar-random";
    random.textContent = "surprise me";
    random.addEventListener("click", () => this.#set(randomBoardConfig(), true));
    this.#panel.appendChild(random);
    this.#paintVisualPreviews();
    const now = performance.now();
    this.#drawPlumePreview(now);
    this.#drawVoicePreview(now);
    this.#drawThrustPreview(now);
    if (this.#open) this.#startPreviewLoop();
  }
}
