import {
  BOARD_DECK_COLORS,
  BOARD_FINS,
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

type PadKind = "surface" | "sound";
type PadKey = "surfaceScale" | "surfaceWarp" | "soundTone" | "soundMotion";

/**
 * The hoverboard garage is a tiny instrument, not just a preset list. Two XY
 * pads preview the procedural deck skin and live synth macros while held, then
 * commit once on release so persistence, mesh rebuilds, and net sync stay calm.
 */
export class BoardSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: BoardConfig;
  #onChange: (config: BoardConfig) => void;
  #onPreview: (config: BoardConfig, kind: PadKind) => void;
  #onSoundEdit: () => void;
  #onOpen: () => void;
  #open = false;
  #soundCanvas: HTMLCanvasElement | null = null;
  #waveFrame = 0;

  constructor(
    initial: BoardConfig,
    onChange: (config: BoardConfig) => void,
    onPreview: (config: BoardConfig, kind: PadKind) => void,
    onSoundEdit: () => void,
    onOpen: () => void
  ) {
    this.#config = normalizeBoardConfig(initial);
    this.#onChange = onChange;
    this.#onPreview = onPreview;
    this.#onSoundEdit = onSoundEdit;
    this.#onOpen = onOpen;

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
      this.#animateSoundPad();
    } else if (this.#waveFrame) {
      cancelAnimationFrame(this.#waveFrame);
      this.#waveFrame = 0;
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
    kind: PadKind,
    title: string,
    subtitle: string,
    xKey: PadKey,
    yKey: PadKey,
    xLabels: [string, string],
    yLabels: [string, string]
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
    head.append(heading, readout);

    const pad = document.createElement("div");
    pad.className = "board-xy-pad";
    pad.tabIndex = 0;
    pad.setAttribute("role", "group");
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

    if (kind === "sound") this.#soundCanvas = canvas;

    const draw = () => {
      const x = this.#config[xKey];
      const y = this.#config[yKey];
      puck.style.left = `${x}%`;
      puck.style.top = `${100 - y}%`;
      readout.value = `${x.toString().padStart(2, "0")} · ${y.toString().padStart(2, "0")}`;
      pad.setAttribute("aria-valuetext", `${xLabels[0]} ${100 - x}%, ${xLabels[1]} ${x}%; ${yLabels[0]} ${100 - y}%, ${yLabels[1]} ${y}%`);
      if (kind === "surface") paintBoardSurface(canvas, this.#config);
    };

    const apply = (x: number, y: number, preview = true) => {
      this.#config = normalizeBoardConfig({
        ...this.#config,
        [xKey]: Math.round(Math.max(0, Math.min(100, x))),
        [yKey]: Math.round(Math.max(0, Math.min(100, y)))
      });
      draw();
      if (preview) this.#onPreview({ ...this.#config }, kind);
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
      if (kind === "sound") this.#onSoundEdit();
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
      if (kind === "sound") this.#onSoundEdit();
      apply(x, y);
      this.#onChange({ ...this.#config });
    });

    draw();
    return lab;
  }

  #animateSoundPad() {
    if (!this.#open || this.#waveFrame) return;
    const animate = (time: number) => {
      this.#waveFrame = 0;
      const canvas = this.#soundCanvas;
      if (!this.#open || !canvas?.isConnected) return;
      const ctx = canvas.getContext("2d");
      if (ctx) {
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
      this.#waveFrame = requestAnimationFrame(animate);
    };
    this.#waveFrame = requestAnimationFrame(animate);
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
    this.#soundCanvas = null;
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
      "grain × turbulence",
      "surfaceScale",
      "surfaceWarp",
      ["macro", "micro"],
      ["calm", "wild"]
    );
    const reroll = document.createElement("button");
    reroll.type = "button";
    reroll.className = "board-lab-reroll";
    reroll.textContent = "↻ new field";
    reroll.title = "Reroll the texture field";
    reroll.addEventListener("click", () => this.#set({ surfaceSeed: Math.floor(Math.random() * 65536) }));
    surfaceLab.appendChild(reroll);
    labs.append(
      surfaceLab,
      this.#xyLab(
        "sound",
        "VOICE / 02",
        "tone × LFO motion",
        "soundTone",
        "soundMotion",
        ["warm", "glass"],
        ["still", "flutter"]
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
    if (this.#open) this.#animateSoundPad();
  }
}
