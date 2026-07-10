import {
  BOARD_DECK_COLORS,
  BOARD_FINS,
  BOARD_FX,
  BOARD_GLOW_COLORS,
  BOARD_HUMS,
  BOARD_PITCHES,
  BOARD_SHAPES,
  BOARD_SURFACES,
  normalizeBoardConfig,
  randomBoardConfig,
  type BoardConfig
} from "../vehicles/board/config";
import { paintBoardSurface } from "../vehicles/board/surfaceTexture";

type PreviewKind = "surface" | "sound";
type LabKind = "surface" | "motion" | "sound" | "thrust";
type PadKey =
  | "surfaceScale"
  | "surfaceWarp"
  | "surfaceFlow"
  | "surfaceFx"
  | "soundTone"
  | "soundMotion"
  | "soundThrust"
  | "soundAir";

const isAudioLab = (kind: LabKind) => kind === "sound" || kind === "thrust";

/**
 * The hoverboard garage is a tiny instrument, not just a preset list. Two
 * visual pads shape the deck + its motion, and two audio pads shape the voice
 * + thrust. Moves preview while held, then commit once on release so
 * persistence, mesh rebuilds, and net sync stay calm.
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

  #swatch(key: "deck" | "trim" | "glow", index: number, color: number, label: string) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-swatch";
    b.title = label;
    b.setAttribute("aria-label", `${key}: ${label}`);
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    b.style.background = hex;
    if (key === "glow") b.style.boxShadow = `0 0 8px ${hex}, inset 0 -4px 0 rgba(0, 0, 0, 0.14)`;
    b.classList.toggle("on", this.#config[key] === index);
    b.addEventListener("click", () => this.#set({ [key]: index } as Partial<BoardConfig>));
    return b;
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
    const tools = head.querySelector<HTMLElement>(".board-lab-tools")!;
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
    tools.appendChild(toggle);
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
      // glitch: shear whole bands of the finished frame sideways (self-copy)
      const tick = Math.floor(time * (0.0016 + flow * 0.006));
      const bands = 6;
      const bh = Math.ceil(h / bands);
      for (let band = 0; band < bands; band++) {
        const jolt = Math.abs(Math.sin(band * 127.1 + tick * 311.7)) % 1;
        if (jolt < 0.42) continue;
        const dx = Math.round((jolt - 0.7) * fx * w * 0.5);
        if (!dx) continue;
        const sy = band * bh;
        ctx.drawImage(canvas, 0, sy, w, bh, dx, sy, w, bh);
        ctx.fillStyle = `rgba(121,255,220,${fx * 0.2 * jolt})`;
        ctx.fillRect(dx > 0 ? 0 : w + dx, sy, Math.abs(dx), 1.5);
      }
      // continuous CRT sweep so the pad reads live even between band re-deals
      const scanY = (time * (0.02 + flow * 0.1)) % h;
      ctx.fillStyle = `rgba(121,255,220,${fx * 0.16})`;
      ctx.fillRect(0, scanY, w, 1.5);
    }
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
      this.#drawVoicePreview(time);
      this.#drawThrustPreview(time);
      this.#previewFrame = requestAnimationFrame(animate);
    };
    this.#previewFrame = requestAnimationFrame(animate);
  }

  #render() {
    const deck = BOARD_DECK_COLORS[this.#config.deck].color;
    const glow = BOARD_GLOW_COLORS[this.#config.glow].color;
    const deckHex = `#${deck.toString(16).padStart(6, "0")}`;
    const glowHex = `#${glow.toString(16).padStart(6, "0")}`;
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
      this.#row(
        "deck",
        BOARD_DECK_COLORS.map((c, i) => this.#swatch("deck", i, c.color, c.label))
      ),
      this.#row(
        "ink",
        BOARD_DECK_COLORS.map((c, i) => this.#swatch("trim", i, c.color, c.label))
      ),
      this.#row(
        "glow",
        BOARD_GLOW_COLORS.map((c, i) => this.#swatch("glow", i, c.color, c.label))
      ),
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
      )
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
    this.#drawVoicePreview(now);
    this.#drawThrustPreview(now);
    if (this.#open) this.#startPreviewLoop();
  }
}
