export type HyperwebReadout = {
  nodes: number;
  links: number;
  anchors: number;
  fixedStep: number;
  iterations: number;
  strain: number;
  ripple: number;
  energy: number;
};

const STYLE = `
#hud .afterlight-lattice-hud {
  --lattice-cyan: #8ffcff;
  --lattice-mint: #a7ffcf;
  --lattice-gold: #ffd98f;
  --lattice-rose: #ff9ddb;
  position: fixed;
  z-index: 20;
  top: 50%;
  right: max(18px, env(safe-area-inset-right));
  width: min(292px, calc(100vw - 36px));
  padding: 14px 15px 12px;
  box-sizing: border-box;
  color: #eaffff;
  background:
    linear-gradient(112deg, rgba(6, 14, 28, .9), rgba(10, 20, 38, .69)),
    repeating-linear-gradient(90deg, transparent 0 11px, rgba(130, 241, 255, .025) 11px 12px);
  border: 1px solid rgba(143, 252, 255, .38);
  border-radius: 3px 17px 3px 17px;
  box-shadow:
    0 18px 60px rgba(0, 0, 0, .4),
    inset 0 0 28px rgba(92, 195, 255, .08),
    0 0 28px rgba(77, 221, 255, .08);
  backdrop-filter: blur(12px) saturate(1.2);
  pointer-events: none;
  opacity: 0;
  transform: translate3d(22px, -50%, 0) scale(.97);
  transform-origin: right center;
  transition: opacity .26s ease, transform .36s cubic-bezier(.2,.8,.2,1);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}
#hud .afterlight-lattice-hud::before,
#hud .afterlight-lattice-hud::after {
  content: "";
  position: absolute;
  pointer-events: none;
}
#hud .afterlight-lattice-hud::before {
  inset: 7px;
  border-top: 1px solid rgba(255, 217, 143, .22);
  border-bottom: 1px solid rgba(143, 252, 255, .13);
}
#hud .afterlight-lattice-hud::after {
  width: 46px;
  height: 2px;
  top: -1px;
  right: 18px;
  background: var(--lattice-gold);
  box-shadow: 0 0 12px var(--lattice-gold);
}
#hud .afterlight-lattice-hud.show {
  opacity: 1;
  transform: translate3d(0, -50%, 0) scale(1);
}
#hud .lattice-head {
  position: relative;
  display: grid;
  grid-template-columns: 38px 1fr auto;
  align-items: center;
  gap: 9px;
  min-height: 38px;
}
#hud .lattice-sigil {
  position: relative;
  width: 30px;
  height: 30px;
  border: 1px solid rgba(143, 252, 255, .72);
  border-radius: 50%;
  box-shadow: inset 0 0 12px rgba(143, 252, 255, .16), 0 0 15px rgba(143, 252, 255, .16);
}
#hud .lattice-sigil::before,
#hud .lattice-sigil::after {
  content: "";
  position: absolute;
  inset: 5px;
  border: 1px solid rgba(255, 217, 143, .72);
  transform: rotate(45deg);
}
#hud .lattice-sigil::after {
  inset: 11px;
  border-radius: 50%;
  border: 0;
  background: var(--lattice-cyan);
  box-shadow: 0 0 11px var(--lattice-cyan);
  animation: lattice-heart 1.4s ease-in-out infinite;
}
#hud .lattice-title {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}
#hud .lattice-title span {
  color: var(--lattice-gold);
  font-size: 8px;
  letter-spacing: .24em;
  text-transform: uppercase;
}
#hud .lattice-title strong {
  overflow: hidden;
  color: #f1ffff;
  font-family: inherit;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: .1em;
  line-height: 1.05;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#hud .lattice-live {
  padding: 4px 6px;
  color: var(--lattice-mint);
  border: 1px solid rgba(167, 255, 207, .28);
  font-size: 8px;
  letter-spacing: .13em;
  text-transform: uppercase;
}
#hud .lattice-live::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 5px;
  border-radius: 50%;
  background: currentColor;
  box-shadow: 0 0 8px currentColor;
}
#hud .lattice-scope {
  position: relative;
  height: 38px;
  margin: 10px 0 8px;
  overflow: hidden;
  border-top: 1px solid rgba(143, 252, 255, .12);
  border-bottom: 1px solid rgba(143, 252, 255, .12);
  background:
    linear-gradient(90deg, transparent, rgba(143,252,255,.08), transparent),
    repeating-linear-gradient(90deg, rgba(143,252,255,.08) 0 1px, transparent 1px 19px);
}
#hud .lattice-scope::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 32%;
  background: linear-gradient(90deg, transparent, rgba(155, 248, 255, .26), transparent);
  animation: lattice-scan 2.6s linear infinite;
}
#hud .lattice-wave {
  position: absolute;
  inset: 50% 0 auto;
  height: 1px;
  background: var(--lattice-cyan);
  box-shadow: 0 0 9px rgba(143, 252, 255, .8);
}
#hud .lattice-wave::before {
  content: "";
  position: absolute;
  left: 9%;
  top: -8px;
  width: 82%;
  height: 16px;
  opacity: .78;
  background: linear-gradient(135deg,
    transparent 0 8%, var(--lattice-cyan) 8% 9%, transparent 9% 18%,
    var(--lattice-rose) 18% 19%, transparent 19% 33%, var(--lattice-cyan) 33% 34%,
    transparent 34% 61%, var(--lattice-gold) 61% 62%, transparent 62% 78%,
    var(--lattice-cyan) 78% 79%, transparent 79%);
}
#hud .lattice-equation {
  color: rgba(218, 252, 255, .63);
  font-size: 9px;
  letter-spacing: .12em;
  text-align: center;
  text-transform: uppercase;
}
#hud .lattice-telemetry {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  margin: 10px 0;
}
#hud .lattice-datum {
  display: flex;
  min-width: 0;
  flex-direction: column;
  padding: 7px 7px 6px;
  border-left: 1px solid rgba(143, 252, 255, .16);
  background: rgba(108, 220, 255, .035);
}
#hud .lattice-datum span {
  overflow: hidden;
  color: rgba(205, 241, 244, .52);
  font-size: 7px;
  letter-spacing: .12em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}
#hud .lattice-datum strong {
  margin-top: 2px;
  color: #eaffff;
  font-size: 15px;
  font-weight: 500;
  letter-spacing: .07em;
}
#hud .lattice-meter {
  display: grid;
  grid-template-columns: 52px 1fr 38px;
  align-items: center;
  gap: 8px;
  min-height: 20px;
  color: rgba(213, 247, 249, .64);
  font-size: 8px;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#hud .lattice-track {
  position: relative;
  height: 3px;
  overflow: hidden;
  background: rgba(166, 231, 238, .12);
}
#hud .lattice-track i {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, var(--lattice-cyan), var(--lattice-rose));
  box-shadow: 0 0 8px var(--lattice-cyan);
  transform: scaleX(0);
  transform-origin: left;
  transition: transform .12s linear;
}
#hud .lattice-meter.ripple .lattice-track i {
  background: linear-gradient(90deg, var(--lattice-mint), var(--lattice-gold));
}
#hud .lattice-meter output {
  color: #eaffff;
  text-align: right;
}
#hud .lattice-legend {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(143, 252, 255, .12);
  color: rgba(215, 244, 247, .58);
  font-size: 7px;
  letter-spacing: .08em;
  text-transform: uppercase;
}
#hud .lattice-legend span::before {
  content: "";
  display: inline-block;
  width: 5px;
  height: 5px;
  margin-right: 5px;
  border-radius: 50%;
  background: var(--legend-color);
  box-shadow: 0 0 7px var(--legend-color);
}
#hud .lattice-footer {
  margin-top: 9px;
  color: rgba(221, 251, 255, .45);
  font-size: 8px;
  letter-spacing: .08em;
  text-align: center;
}
#hud.faded .afterlight-lattice-hud { opacity: 0 !important; }
@keyframes lattice-heart { 50% { transform: scale(1.7); opacity: .72; } }
@keyframes lattice-scan { from { transform: translateX(-110%); } to { transform: translateX(310%); } }
@media (max-width: 760px) {
  #hud .afterlight-lattice-hud {
    top: auto;
    right: max(12px, env(safe-area-inset-right));
    bottom: calc(184px + env(safe-area-inset-bottom));
    width: min(270px, calc(100vw - 24px));
    padding: 11px 12px 10px;
    transform: translate3d(18px, 12px, 0) scale(.96);
  }
  #hud .afterlight-lattice-hud.show { transform: none; }
  #hud .lattice-scope { height: 28px; margin: 7px 0 6px; }
  #hud .lattice-footer { display: none; }
}
@media (max-height: 650px) and (min-width: 761px) {
  #hud .lattice-scope { display: none; }
  #hud .afterlight-lattice-hud { padding-top: 10px; padding-bottom: 9px; }
}
@media (prefers-reduced-motion: reduce) {
  #hud .afterlight-lattice-hud,
  #hud .lattice-sigil::after,
  #hud .lattice-scope::before { animation: none; transition: none; }
}
`;

let style: HTMLStyleElement | null = null;
let users = 0;

function retainStyle(): () => void {
  users++;
  if (!style) {
    style = document.createElement("style");
    style.dataset.afterlightLatticeHud = "";
    style.textContent = STYLE;
    document.head.appendChild(style);
  }
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    users = Math.max(0, users - 1);
    if (users === 0) {
      style?.remove();
      style = null;
    }
  };
}

function datum(label: string): { root: HTMLElement; value: HTMLElement } {
  const root = document.createElement("div");
  root.className = "lattice-datum";
  const caption = document.createElement("span");
  caption.textContent = label;
  const value = document.createElement("strong");
  root.append(caption, value);
  return { root, value };
}

function meter(label: string, className = ""): {
  root: HTMLElement;
  fill: HTMLElement;
  value: HTMLOutputElement;
} {
  const root = document.createElement("div");
  root.className = `lattice-meter ${className}`.trim();
  const caption = document.createElement("span");
  caption.textContent = label;
  const track = document.createElement("span");
  track.className = "lattice-track";
  const fill = document.createElement("i");
  track.appendChild(fill);
  const value = document.createElement("output");
  root.append(caption, track, value);
  return { root, fill, value };
}

export class HyperwebDiagnosticsHud {
  #root: HTMLElement;
  #nodes: HTMLElement;
  #links: HTMLElement;
  #anchors: HTMLElement;
  #equation: HTMLElement;
  #strainFill: HTMLElement;
  #strainValue: HTMLOutputElement;
  #rippleFill: HTMLElement;
  #rippleValue: HTMLOutputElement;
  #footer: HTMLElement;
  #releaseStyle: () => void;
  #active = false;
  #awake = false;

  constructor(hud: HTMLElement | null = document.getElementById("hud")) {
    if (!hud) throw new Error("[afterlight-lattice] #hud is unavailable");
    this.#releaseStyle = retainStyle();
    this.#root = document.createElement("section");
    this.#root.className = "afterlight-lattice-hud";
    this.#root.setAttribute("aria-label", "Hyperweb Verlet diagnostics");
    this.#root.setAttribute("aria-hidden", "true");

    const head = document.createElement("div");
    head.className = "lattice-head";
    const sigil = document.createElement("span");
    sigil.className = "lattice-sigil";
    sigil.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.className = "lattice-title";
    const kicker = document.createElement("span");
    kicker.textContent = "Hyperweb / live topology";
    const strong = document.createElement("strong");
    strong.textContent = "LATTICE VISION";
    title.append(kicker, strong);
    const live = document.createElement("span");
    live.className = "lattice-live";
    live.textContent = "live";
    head.append(sigil, title, live);

    const scope = document.createElement("div");
    scope.className = "lattice-scope";
    scope.setAttribute("aria-hidden", "true");
    const wave = document.createElement("i");
    wave.className = "lattice-wave";
    scope.appendChild(wave);

    this.#equation = document.createElement("div");
    this.#equation.className = "lattice-equation";

    const telemetry = document.createElement("div");
    telemetry.className = "lattice-telemetry";
    const nodes = datum("free + pinned");
    const links = datum("constraints");
    const anchors = datum("hand anchors");
    this.#nodes = nodes.value;
    this.#links = links.value;
    this.#anchors = anchors.value;
    telemetry.append(nodes.root, links.root, anchors.root);

    const strain = meter("strain");
    this.#strainFill = strain.fill;
    this.#strainValue = strain.value;
    const ripple = meter("signal", "ripple");
    this.#rippleFill = ripple.fill;
    this.#rippleValue = ripple.value;

    const legend = document.createElement("div");
    legend.className = "lattice-legend";
    for (const [label, color] of [["free node", "#8ffcff"], ["pinned", "#ffd98f"], ["tension", "#ff9ddb"]]) {
      const item = document.createElement("span");
      item.textContent = label;
      item.style.setProperty("--legend-color", color);
      legend.appendChild(item);
    }

    this.#footer = document.createElement("div");
    this.#footer.className = "lattice-footer";
    this.#footer.textContent = "Return to the core · E folds the view";
    this.#root.append(head, scope, this.#equation, telemetry, strain.root, ripple.root, legend, this.#footer);
    hud.appendChild(this.#root);
  }

  setAwake(on: boolean): void {
    this.#awake = on;
    this.#sync();
  }

  setActive(on: boolean): void {
    this.#active = on;
    if (on) {
      document.querySelector<HTMLButtonElement>("#hud .help:not(.collapsed) .help-toggle")?.click();
    }
    this.#sync();
  }

  setInteractionKey(key: string): void {
    this.#footer.textContent = `Return to the core · ${key} folds the view`;
  }

  update(readout: HyperwebReadout): void {
    if (!this.#active) return;
    this.#nodes.textContent = String(readout.nodes).padStart(4, "0");
    this.#links.textContent = String(readout.links).padStart(4, "0");
    this.#anchors.textContent = String(readout.anchors).padStart(2, "0");
    this.#equation.textContent = `VERLET · ${Math.round(1 / readout.fixedStep)} HZ · ${readout.iterations} RELAX · ${(readout.energy * 100).toFixed(0)}% ENERGY`;
    const strain = Math.min(1, Math.max(0, readout.strain * 18));
    const ripple = Math.min(1, Math.max(0, readout.ripple / 1.4));
    this.#strainFill.style.transform = `scaleX(${strain.toFixed(3)})`;
    this.#rippleFill.style.transform = `scaleX(${ripple.toFixed(3)})`;
    this.#strainValue.value = readout.strain.toFixed(3);
    this.#rippleValue.value = readout.ripple.toFixed(2);
  }

  dispose(): void {
    this.#root.remove();
    this.#releaseStyle();
  }

  #sync(): void {
    const shown = this.#active && this.#awake;
    this.#root.classList.toggle("show", shown);
    this.#root.setAttribute("aria-hidden", String(!shown));
  }
}
