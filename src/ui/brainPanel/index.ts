import type { BrainNet, InspectableBrain } from "./types";

/**
 * BrainPanel — the click-to-inspect neural-net overlay.
 *
 * When the player aims the crosshair at any NN entity's floating lattice and
 * clicks (see main.ts pick), the world freezes and this DOM panel opens on top,
 * drawing that entity's policy as a big LABELLED 2D lattice — the same flat
 * style as the in-world overlay, just legible: named inputs on the left with a
 * slider each, named outputs on the right as bars, the network canvas between.
 *
 * It is a hands-on "what is this brain computing" tool: dragging an input slider
 * runs an offline what-if forward pass (never touches the live entity, which is
 * paused anyway) and the lattice + outputs recolour live. Click any node to read
 * its activation, bias, and top incoming weights with the source nodes named.
 *
 * The panel owns no per-frame work: once open it only reacts to DOM events. main
 * .ts freezes the sim while `isOpen`, so the network the player pokes at is the
 * exact one that was driving the entity a moment ago.
 */

// warm orange (positive) ↔ cool cyan (negative) — matches brainOverlay.ts #tint
const POS: [number, number, number] = [1.0, 0.52, 0.16];
const NEG: [number, number, number] = [0.18, 0.78, 1.0];
const BG = "#0a141f"; // deep navy canvas so the warm/cool node tints glow
const TOP_WEIGHTS = 6; // incoming weights listed in the node detail

/** activation (or edge product) → 0..255 rgb glow, mirroring the in-world overlay. */
function tint(act: number, gain: number): [number, number, number] {
  const a = act < -1 ? -1 : act > 1 ? 1 : act;
  const t = Math.abs(a);
  const base = a >= 0 ? POS : NEG;
  const heat = (0.32 + t * t * 1.7) * gain;
  const white = t > 0.7 ? (t - 0.7) * 1.4 : 0;
  const r = (base[0] * (1 - white) + white) * heat;
  const g = (base[1] * (1 - white) + white) * heat;
  const b = (base[2] * (1 - white) + white) * heat;
  return [Math.min(255, r * 255), Math.min(255, g * 255), Math.min(255, b * 255)];
}
const rgb = (c: [number, number, number]) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;
const rgba = (c: [number, number, number], a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

type NodeHit = { x: number; y: number; layer: number; idx: number };

const PANEL_CSS =
  "position:fixed; inset:0; z-index:var(--z-modal); display:none; align-items:center; justify-content:center;" +
  "background:var(--scrim); backdrop-filter:blur(5px); font-family:var(--font); color:var(--text);";
const CARD_CSS =
  "width:min(1040px,94vw); max-height:92vh; display:flex; flex-direction:column; gap:10px;" +
  "background:linear-gradient(180deg,rgba(12,28,42,0.97),rgba(8,20,31,0.97)); border:1px solid var(--hairline-2); border-radius:var(--r-xl);" +
  "padding:16px 18px; box-shadow:var(--shadow-lg),var(--edge-hi); backdrop-filter:blur(var(--blur));";
const COL_CSS = "flex:0 0 210px; overflow-y:auto; max-height:56vh; display:flex; flex-direction:column; gap:7px;";
const BTN_CSS =
  "background:var(--surface-raised); border:1px solid var(--hairline-2); color:var(--text);" +
  "border-radius:var(--r-sm); padding:6px 12px; cursor:pointer; font-size:13px; font-family:var(--font);";
const HEAD_CSS =
  "font-size:12px; letter-spacing:0.08em; text-transform:uppercase; color:var(--text-mut); opacity:0.85; margin-bottom:2px;";

export class BrainPanel {
  #root: HTMLDivElement;
  #title: HTMLDivElement;
  #inputsCol: HTMLDivElement;
  #outputsCol: HTMLDivElement;
  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #detail: HTMLDivElement;

  #onRelease: () => void; // free the pointer (called on open)
  #onRelock: () => void; // re-lock the pointer (called on close)

  #brain: InspectableBrain | null = null;
  #editObs = new Float32Array(0); // what-if input vector the sliders write into
  #sliders: HTMLInputElement[] = [];
  #outBars: { fill: HTMLDivElement; val: HTMLSpanElement }[] = [];
  #nodePos: NodeHit[] = []; // node coords in the draw basis (#drawW × #drawH)
  #selected: { layer: number; idx: number } | null = null;
  #cssW = 560;
  #drawW = 560; // canvas basis the current #nodePos were laid out in
  #drawH = 380;

  #keyHandler = (e: KeyboardEvent): void => {
    if (!this.isOpen) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      this.close();
    }
  };

  // Redraw when the responsive canvas changes size, so #nodePos stays in step
  // with what's on screen (the layout settles a frame or two after open()).
  #resizeHandler = (): void => {
    if (this.isOpen) this.#draw();
  };

  constructor(onRelease: () => void, onRelock: () => void) {
    this.#onRelease = onRelease;
    this.#onRelock = onRelock;

    const root = document.createElement("div");
    root.style.cssText = PANEL_CSS;
    const card = document.createElement("div");
    card.style.cssText = CARD_CSS;
    root.appendChild(card);

    // header row: title + close
    const header = document.createElement("div");
    header.style.cssText = "display:flex; align-items:center; justify-content:space-between; gap:12px;";
    this.#title = document.createElement("div");
    this.#title.style.cssText = "font-size:16px; font-weight:600;";
    const close = document.createElement("button");
    close.textContent = "✕";
    close.style.cssText = BTN_CSS + "font-size:15px; line-height:1; padding:6px 10px;";
    close.addEventListener("click", () => this.close());
    header.append(this.#title, close);

    // body row: inputs | canvas | outputs
    const body = document.createElement("div");
    body.style.cssText = "display:flex; gap:14px; align-items:stretch;";

    const inputsWrap = document.createElement("div");
    inputsWrap.style.cssText = COL_CSS;
    const inHead = document.createElement("div");
    inHead.style.cssText = HEAD_CSS;
    inHead.textContent = "Inputs (drag to explore)";
    this.#inputsCol = document.createElement("div");
    this.#inputsCol.style.cssText = "display:flex; flex-direction:column; gap:7px;";
    inputsWrap.append(inHead, this.#inputsCol);

    const canvasWrap = document.createElement("div");
    canvasWrap.style.cssText = "flex:1 1 auto; display:flex; flex-direction:column; min-width:0;";
    this.#canvas = document.createElement("canvas");
    this.#canvas.style.cssText = "width:100%; height:auto; border-radius:10px; background:" + BG + "; cursor:crosshair;";
    this.#canvas.addEventListener("click", (e) => this.#onCanvasClick(e));
    canvasWrap.appendChild(this.#canvas);
    const ctx = this.#canvas.getContext("2d");
    if (!ctx) throw new Error("BrainPanel: 2D canvas unavailable");
    this.#ctx = ctx;

    const outputsWrap = document.createElement("div");
    outputsWrap.style.cssText = COL_CSS.replace("210px", "180px");
    const outHead = document.createElement("div");
    outHead.style.cssText = HEAD_CSS;
    outHead.textContent = "Outputs (actions)";
    this.#outputsCol = document.createElement("div");
    this.#outputsCol.style.cssText = "display:flex; flex-direction:column; gap:9px;";
    outputsWrap.append(outHead, this.#outputsCol);

    body.append(inputsWrap, canvasWrap, outputsWrap);

    // detail + footer
    this.#detail = document.createElement("div");
    this.#detail.style.cssText =
      "font-size:12.5px; line-height:1.5; min-height:44px; background:var(--surface-sunken); border:1px solid var(--hairline);" +
      "border-radius:var(--r-sm); padding:8px 10px; white-space:pre-wrap; font-variant-numeric:tabular-nums;";

    const footer = document.createElement("div");
    footer.style.cssText = "display:flex; gap:10px; align-items:center;";
    const reset = document.createElement("button");
    reset.textContent = "Reset to live";
    reset.style.cssText = BTN_CSS;
    reset.addEventListener("click", () => this.#resetToLive());
    const hint = document.createElement("div");
    hint.style.cssText = "font-size:12px; opacity:0.55;";
    hint.textContent = "Click a node for its bias & top incoming weights · Esc to close";
    footer.append(reset, hint);

    card.append(header, body, this.#detail, footer);
    document.body.appendChild(root);
    this.#root = root;
  }

  get isOpen(): boolean {
    return this.#brain !== null;
  }

  /** Open the inspector on `brain`, freeing the pointer and (via main.ts) freezing the world. */
  open(brain: InspectableBrain): void {
    this.#brain = brain;
    this.#selected = null;
    this.#title.textContent = brain.label;
    this.#editObs = Float32Array.from(brain.liveObs());
    this.#buildInputs();
    this.#buildOutputs();
    this.#detail.textContent = "Click a node to inspect its weights.";
    this.#root.style.display = "flex";
    this.#recompute();
    // the flex layout settles a frame after display flips — redraw at the final
    // canvas size so node hit-boxes line up with what's rendered
    requestAnimationFrame(() => {
      if (this.isOpen) this.#draw();
    });
    document.addEventListener("keydown", this.#keyHandler, true);
    window.addEventListener("resize", this.#resizeHandler);
    this.#onRelease();
  }

  close(): void {
    if (!this.isOpen) return;
    this.#brain = null;
    this.#root.style.display = "none";
    document.removeEventListener("keydown", this.#keyHandler, true);
    window.removeEventListener("resize", this.#resizeHandler);
    this.#onRelock();
  }

  // ---- input / output columns (rebuilt per entity) -------------------------

  #buildInputs(): void {
    const b = this.#brain!;
    const n = b.net.sizes[0];
    const labels = b.inputLabels ?? [];
    this.#inputsCol.replaceChildren();
    this.#sliders = [];
    for (let i = 0; i < n; i++) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; flex-direction:column; gap:2px;";
      const top = document.createElement("div");
      top.style.cssText = "display:flex; justify-content:space-between; font-size:11.5px;";
      const name = document.createElement("span");
      name.textContent = labels[i] ?? `in[${i}]`;
      name.style.opacity = "0.85";
      const val = document.createElement("span");
      val.style.cssText = "opacity:0.6; font-variant-numeric:tabular-nums;";
      val.textContent = this.#editObs[i].toFixed(2);
      top.append(name, val);
      const slider = document.createElement("input");
      slider.type = "range";
      slider.min = "-1";
      slider.max = "1";
      slider.step = "0.01";
      slider.value = String(this.#editObs[i]);
      slider.style.cssText = "width:100%; accent-color:var(--accent);";
      slider.addEventListener("input", () => {
        this.#editObs[i] = parseFloat(slider.value);
        val.textContent = this.#editObs[i].toFixed(2);
        this.#recompute();
      });
      row.append(top, slider);
      this.#inputsCol.appendChild(row);
      this.#sliders.push(slider);
    }
  }

  #buildOutputs(): void {
    const b = this.#brain!;
    const n = b.net.sizes[b.net.sizes.length - 1];
    const labels = b.outputLabels ?? [];
    this.#outputsCol.replaceChildren();
    this.#outBars = [];
    for (let j = 0; j < n; j++) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex; flex-direction:column; gap:3px;";
      const top = document.createElement("div");
      top.style.cssText = "display:flex; justify-content:space-between; font-size:11.5px;";
      const name = document.createElement("span");
      name.textContent = labels[j] ?? `out[${j}]`;
      name.style.opacity = "0.85";
      const val = document.createElement("span");
      val.style.cssText = "opacity:0.7; font-variant-numeric:tabular-nums;";
      // bar: centre line at 0, fill grows left (neg) / right (pos)
      const track = document.createElement("div");
      track.style.cssText =
        "position:relative; height:12px; border-radius:6px; background:var(--surface-sunken);" +
        "border:1px solid var(--hairline); overflow:hidden;";
      const fill = document.createElement("div");
      fill.style.cssText = "position:absolute; top:0; bottom:0; left:50%; width:0;";
      track.appendChild(fill);
      top.append(name, val);
      row.append(top, track);
      this.#outputsCol.appendChild(row);
      this.#outBars.push({ fill, val });
    }
  }

  // ---- what-if forward + redraw --------------------------------------------

  #recompute(): void {
    const b = this.#brain;
    if (!b) return;
    b.net.forward(this.#editObs); // refreshes net.layerOut for the edited inputs
    this.#draw();
    this.#updateOutputs();
    if (this.#selected) this.#showDetail(this.#selected.layer, this.#selected.idx);
  }

  /** activation of node (layer, idx): layer 0 = edited obs, else net.layerOut[layer-1]. */
  #act(layer: number, idx: number): number {
    if (layer === 0) return this.#editObs[idx] ?? 0;
    const out = this.#brain!.net.layerOut[layer - 1];
    return out ? out[idx] : 0;
  }

  #updateOutputs(): void {
    const b = this.#brain!;
    const last = b.net.sizes.length - 1;
    for (let j = 0; j < this.#outBars.length; j++) {
      const v = this.#act(last, j);
      const bar = this.#outBars[j];
      const mag = Math.min(1, Math.abs(v));
      bar.fill.style.width = mag * 50 + "%";
      bar.fill.style.left = v >= 0 ? "50%" : 50 - mag * 50 + "%";
      bar.fill.style.background = rgb(tint(v, 1.0));
      bar.val.textContent = v.toFixed(3);
    }
  }

  #draw(): void {
    const b = this.#brain!;
    const sizes = b.net.sizes;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    // size the backing store to the CSS box the browser laid out
    const cssW = this.#canvas.clientWidth || this.#cssW;
    const cssH = Math.max(300, Math.round(cssW * 0.66));
    this.#cssW = cssW;
    this.#drawW = cssW; // basis the node coords below are laid out in
    this.#drawH = cssH;
    this.#canvas.style.height = cssH + "px";
    this.#canvas.width = Math.round(cssW * dpr);
    this.#canvas.height = Math.round(cssH * dpr);
    const ctx = this.#ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, cssW, cssH);

    const L = sizes.length;
    const padX = 92; // room for input/output labels
    const padY = 26;
    const usableW = Math.max(1, cssW - padX * 2);
    const usableH = Math.max(1, cssH - padY * 2);
    const layerX = (l: number) => padX + (L === 1 ? usableW / 2 : (l / (L - 1)) * usableW);
    const nodeY = (l: number, i: number) => {
      const n = sizes[l];
      return n <= 1 ? cssH / 2 : padY + (i / (n - 1)) * usableH;
    };

    // edges under nodes: brightness ∝ src·dst (signed), like the in-world overlay
    for (let l = 0; l + 1 < L; l++) {
      const x0 = layerX(l);
      const x1 = layerX(l + 1);
      for (let a = 0; a < sizes[l]; a++) {
        const ay = nodeY(l, a);
        const av = this.#act(l, a);
        for (let c = 0; c < sizes[l + 1]; c++) {
          const prod = av * this.#act(l + 1, c);
          const t = Math.min(1, Math.abs(prod));
          if (t < 0.02) continue; // skip near-dead edges to keep it legible
          ctx.strokeStyle = rgba(tint(prod, 0.9), 0.12 + t * 0.55);
          ctx.lineWidth = 0.4 + t * 1.4;
          ctx.beginPath();
          ctx.moveTo(x0, ay);
          ctx.lineTo(x1, nodeY(l + 1, c));
          ctx.stroke();
        }
      }
    }

    // nodes + their screen coords for hit-testing
    this.#nodePos = [];
    ctx.textBaseline = "middle";
    ctx.font = "11px 'InterVariable', system-ui, sans-serif";
    for (let l = 0; l < L; l++) {
      const x = layerX(l);
      const isIn = l === 0;
      const isOut = l === L - 1;
      const r = isIn || isOut ? 6 : 5;
      for (let i = 0; i < sizes[l]; i++) {
        const y = nodeY(l, i);
        const v = this.#act(l, i);
        const col = tint(v, 1.2);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = rgb(col);
        ctx.shadowColor = rgba(col, 0.9);
        ctx.shadowBlur = 8 + Math.min(1, Math.abs(v)) * 10;
        ctx.fill();
        ctx.shadowBlur = 0;
        // selection ring
        if (this.#selected && this.#selected.layer === l && this.#selected.idx === i) {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(x, y, r + 3, 0, Math.PI * 2);
          ctx.stroke();
        }
        this.#nodePos.push({ x, y, layer: l, idx: i });
      }
    }

    // layer captions
    ctx.fillStyle = "rgba(223,231,242,0.45)";
    ctx.textAlign = "center";
    for (let l = 0; l < L; l++) {
      const cap = l === 0 ? "input" : l === L - 1 ? "output" : `hidden ${l}`;
      ctx.fillText(cap, layerX(l), cssH - 8);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  #onCanvasClick(e: MouseEvent): void {
    if (!this.isOpen) return;
    const rect = this.#canvas.getBoundingClientRect();
    // map pointer → the basis #nodePos live in (canvas may be CSS-scaled)
    const x = ((e.clientX - rect.left) * this.#drawW) / (rect.width || this.#drawW);
    const y = ((e.clientY - rect.top) * this.#drawH) / (rect.height || this.#drawH);
    let best: NodeHit | null = null;
    let bestD = 14 * 14; // px pick radius²
    for (const p of this.#nodePos) {
      const d = (p.x - x) * (p.x - x) + (p.y - y) * (p.y - y);
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    if (!best) return;
    this.#selected = { layer: best.layer, idx: best.idx };
    this.#showDetail(best.layer, best.idx);
    this.#draw(); // redraw for the selection ring
  }

  // ---- node detail: bias + top incoming weights ----------------------------

  #showDetail(layer: number, idx: number): void {
    const b = this.#brain!;
    const sizes = b.net.sizes;
    const act = this.#act(layer, idx);
    const nameFor = (l: number, i: number): string => {
      if (l === 0) return b.inputLabels?.[i] ?? `in[${i}]`;
      if (l === sizes.length - 1) return b.outputLabels?.[i] ?? `out[${i}]`;
      return `h${l}[${i}]`;
    };
    const head = `${nameFor(layer, idx)}   activation ${act.toFixed(3)}`;
    if (layer === 0) {
      this.#detail.textContent = `${head}\ninput node — drag its slider to see the effect ripple through.`;
      return;
    }
    const inc = incoming(b.net, layer, idx);
    const ranked = Array.from(inc.weights)
      .map((w, i) => ({ i, w, contrib: w * this.#act(layer - 1, i) }))
      .sort((a, c) => Math.abs(c.contrib) - Math.abs(a.contrib))
      .slice(0, TOP_WEIGHTS);
    const lines = ranked.map((r) => {
      const nm = nameFor(layer - 1, r.i).padEnd(14);
      return `  ${nm} w ${r.w >= 0 ? " " : ""}${r.w.toFixed(3)}   ×act ${r.contrib >= 0 ? " " : ""}${r.contrib.toFixed(3)}`;
    });
    this.#detail.textContent =
      `${head}   bias ${inc.bias.toFixed(3)}\n` + `top incoming (weight × source activation):\n` + lines.join("\n");
  }

  #resetToLive(): void {
    const b = this.#brain;
    if (!b) return;
    this.#editObs = Float32Array.from(b.liveObs());
    for (let i = 0; i < this.#sliders.length; i++) {
      this.#sliders[i].value = String(this.#editObs[i]);
      this.#sliders[i].dispatchEvent(new Event("input")); // refresh the readout label
    }
    this.#recompute();
  }
}

/**
 * Incoming weights + bias for node (layer, idx), read from the flat param vector.
 * Layout per weight-layer l: W (sizes[l+1]*sizes[l], row-major) then B (sizes[l+1]).
 * `layer` is a sizes-index ≥ 1; its producing weight-layer is `layer - 1`.
 */
function incoming(net: BrainNet, layer: number, idx: number): { bias: number; weights: Float32Array } {
  const sizes = net.sizes;
  const wl = layer - 1;
  const params = net.getParams();
  let off = 0;
  for (let l = 0; l < wl; l++) off += sizes[l + 1] * sizes[l] + sizes[l + 1];
  const inN = sizes[wl];
  const outN = sizes[wl + 1];
  const weights = new Float32Array(inN);
  const row = idx * inN;
  for (let i = 0; i < inN; i++) weights[i] = params[off + row + i];
  const bias = params[off + outN * inN + idx];
  return { bias, weights };
}
