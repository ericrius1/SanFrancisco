/**
 * Archery HUD, GolfUI pattern: pure DOM inside #hud (pointer-events off),
 * styled on the shared glass tokens. Since archery landed after index.html's
 * stylesheet froze, its CSS is injected from here via a <style> element —
 * everything keys off the same :root tokens.
 *
 * Pieces: a draw-strength ring (conic gradient, centre = distance to the lane
 * target), an end scorecard chip (6 arrow pips that fill with ring colors +
 * running total), a score toast ("GOLD! +10"), and a controls hint row.
 */

const RING_CSS = ["#f5c542", "#e0472e", "#2e6fd8", "#3a3f47", "#eeeae0"] as const;
const MISS_CSS = "rgba(233, 244, 250, 0.22)";

export function ringColorCss(score: number): string {
  if (score >= 10) return RING_CSS[0];
  if (score >= 8) return RING_CSS[1];
  if (score >= 6) return RING_CSS[2];
  if (score >= 4) return RING_CSS[3];
  if (score >= 2) return RING_CSS[4];
  return MISS_CSS;
}

const STYLE = `
#hud .archery-card {
  position: absolute;
  left: 50%;
  top: 14px;
  transform: translateX(-50%) translateY(-8px);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 7px 14px;
  border-radius: var(--r-md);
  background: var(--surface-strong);
  border: 1px solid var(--hairline-2);
  box-shadow: var(--shadow-sm), var(--edge-hi);
  opacity: 0;
  transition: opacity 0.25s var(--ease), transform 0.25s var(--ease);
  pointer-events: none;
  white-space: nowrap;
}
#hud .archery-card.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
#hud .archery-card .ac-title {
  font: 700 14px var(--font);
  color: var(--accent-strong);
  letter-spacing: 0.02em;
}
#hud .archery-card .ac-pips {
  display: flex;
  gap: 5px;
}
#hud .archery-card .ac-pip {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--hairline-2);
  background: transparent;
  transition: background 0.2s var(--ease), transform 0.2s var(--ease);
}
#hud .archery-card .ac-pip.hit {
  transform: scale(1.12);
}
#hud .archery-card .ac-score {
  font: 600 13px var(--font);
  color: rgba(233, 244, 250, 0.92);
  font-variant-numeric: tabular-nums;
}
#hud .archery-draw {
  position: absolute;
  left: 50%;
  bottom: 86px;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  opacity: 0;
  transition: opacity 0.2s var(--ease);
  pointer-events: none;
}
#hud .archery-draw.show {
  opacity: 1;
}
#hud .archery-meter {
  position: relative;
  width: 92px;
  height: 92px;
}
#hud .archery-meter .am-ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(var(--accent-soft) 0deg, var(--accent-soft) 0deg);
  -webkit-mask: radial-gradient(closest-side, transparent 68%, #000 70%);
  mask: radial-gradient(closest-side, transparent 68%, #000 70%);
}
#hud .archery-meter .am-inner {
  position: absolute;
  inset: 13px;
  border-radius: 50%;
  background: var(--surface-strong);
  border: 1px solid var(--hairline-2);
  box-shadow: var(--shadow-sm), var(--edge-hi);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
}
#hud .archery-meter .am-dist {
  font: 800 17px var(--font);
  color: var(--accent-strong);
  font-variant-numeric: tabular-nums;
}
#hud .archery-meter .am-sub {
  font: 600 10px var(--font);
  color: rgba(233, 244, 250, 0.75);
  letter-spacing: 0.04em;
}
#hud .archery-meter.full .am-inner {
  border-color: #f5c542;
  box-shadow: 0 0 14px rgba(245, 197, 66, 0.4), var(--edge-hi);
}
#hud .archery-hint {
  display: flex;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--r-sm);
  background: var(--surface);
  border: 1px solid var(--hairline);
  font: 600 11px var(--font);
  color: rgba(233, 244, 250, 0.8);
}
#hud .archery-toast {
  position: absolute;
  left: 50%;
  top: 30%;
  transform: translate(-50%, -50%) scale(0.85);
  padding: 10px 26px;
  border-radius: var(--r-md);
  background: var(--surface-strong);
  border: 1px solid var(--hairline-2);
  box-shadow: var(--shadow-sm), var(--edge-hi);
  font: 800 26px var(--font);
  letter-spacing: 0.03em;
  opacity: 0;
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
  pointer-events: none;
  white-space: nowrap;
}
#hud .archery-toast.show {
  opacity: 1;
  transform: translate(-50%, -50%) scale(1);
}
#hud .archery-prompt {
  position: absolute;
  left: 50%;
  bottom: 128px;
  transform: translateX(-50%) translateY(8px);
  padding: 9px 15px;
  border-radius: var(--r-md);
  color: rgba(242, 249, 252, 0.96);
  background: #091622;
  border: 1px solid var(--hairline-2);
  box-shadow: var(--shadow-sm), var(--edge-hi);
  font: 700 14px var(--font);
  letter-spacing: 0.01em;
  opacity: 0;
  transition: opacity 0.18s var(--ease), transform 0.18s var(--ease);
  pointer-events: none;
  white-space: nowrap;
}
#hud .archery-prompt.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
#hud .archery-reticle {
  --archery-scale: 1;
  position: absolute;
  left: 50%;
  top: 50%;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -50%);
  border: 2px solid rgba(248, 252, 255, 0.9);
  border-radius: 50%;
  box-shadow: 0 0 0 1px rgba(7, 16, 24, 0.72), 0 0 12px rgba(97, 210, 255, 0.45);
  opacity: 0;
  transition: opacity 0.18s var(--ease), scale 0.12s var(--ease);
  pointer-events: none;
}
#hud .archery-reticle::before,
#hud .archery-reticle::after {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  background: rgba(248, 252, 255, 0.95);
  box-shadow: 0 0 3px rgba(7, 16, 24, 0.9);
  transform: translate(-50%, -50%);
}
#hud .archery-reticle::before { width: 6px; height: 2px; }
#hud .archery-reticle::after { width: 2px; height: 6px; }
#hud .archery-reticle.show { opacity: 1; }
#hud .archery-reticle.drawing {
  border-color: #f5c542;
  scale: var(--archery-scale);
}
`;

let styleInjected = false;
function ensureStyle() {
  if (styleInjected) return;
  styleInjected = true;
  const el = document.createElement("style");
  el.textContent = STYLE;
  document.head.appendChild(el);
}

const ARROWS_PER_END = 6;

export class ArcheryUI {
  #card: HTMLElement;
  #pips: HTMLElement[] = [];
  #score: HTMLElement;
  #draw: HTMLElement;
  #ring: HTMLElement;
  #meter: HTMLElement;
  #dist: HTMLElement;
  #sub: HTMLElement;
  #hint: HTMLElement;
  #toast: HTMLElement;
  #prompt: HTMLElement;
  #reticle: HTMLElement;
  #toastUntil = 0;

  constructor() {
    ensureStyle();
    const hud = document.querySelector("#hud")!;

    this.#card = document.createElement("div");
    this.#card.className = "archery-card";
    const title = document.createElement("div");
    title.className = "ac-title";
    title.textContent = "🏹 Archery";
    const pipRow = document.createElement("div");
    pipRow.className = "ac-pips";
    for (let i = 0; i < ARROWS_PER_END; i++) {
      const pip = document.createElement("span");
      pip.className = "ac-pip";
      pipRow.appendChild(pip);
      this.#pips.push(pip);
    }
    this.#score = document.createElement("div");
    this.#score.className = "ac-score";
    this.#card.append(title, pipRow, this.#score);
    hud.appendChild(this.#card);

    this.#draw = document.createElement("div");
    this.#draw.className = "archery-draw";
    this.#meter = document.createElement("div");
    this.#meter.className = "archery-meter";
    this.#ring = document.createElement("div");
    this.#ring.className = "am-ring";
    const inner = document.createElement("div");
    inner.className = "am-inner";
    this.#dist = document.createElement("div");
    this.#dist.className = "am-dist";
    this.#sub = document.createElement("div");
    this.#sub.className = "am-sub";
    this.#sub.textContent = "TO TARGET";
    inner.append(this.#dist, this.#sub);
    this.#meter.append(this.#ring, inner);
    this.#hint = document.createElement("div");
    this.#hint.className = "archery-hint";
    this.#hint.textContent = "Hold click — draw · release — loose · E — put the bow back";
    this.#draw.append(this.#meter, this.#hint);
    hud.appendChild(this.#draw);

    this.#toast = document.createElement("div");
    this.#toast.className = "archery-toast";
    hud.appendChild(this.#toast);

    this.#prompt = document.createElement("div");
    this.#prompt.className = "archery-prompt";
    hud.appendChild(this.#prompt);

    this.#reticle = document.createElement("div");
    this.#reticle.className = "archery-reticle";
    hud.appendChild(this.#reticle);
  }

  /** Scorecard chip (holding a bow). */
  setVisible(on: boolean) {
    this.#card.classList.toggle("show", on);
    this.#reticle.classList.toggle("show", on);
    if (!on) {
      this.showDraw(false);
      this.#toast.classList.remove("show");
      this.setReticleCharge(0, false);
    }
  }

  /** Persistent interaction prompt; unlike HUD toasts it stays until leaving. */
  setPrompt(text: string | null) {
    if (text) this.#prompt.textContent = text;
    this.#prompt.classList.toggle("show", !!text);
  }

  setReticleCharge(charge: number, drawing: boolean) {
    const t = Math.min(1, Math.max(0, charge));
    this.#reticle.style.setProperty("--archery-scale", String(1 - t * 0.18));
    this.#reticle.classList.toggle("drawing", drawing);
  }

  /** Fill pips with the end's per-arrow scores (-1 = not yet shot, 0 = miss). */
  setEnd(scores: readonly number[], endTotal: number, grandTotal: number) {
    this.#pips.forEach((pip, i) => {
      const s = scores[i];
      const shot = s !== undefined && s >= 0;
      pip.classList.toggle("hit", shot);
      pip.style.background = shot ? ringColorCss(s) : "transparent";
    });
    const shotCount = scores.filter((s) => s >= 0).length;
    this.#score.textContent = `End ${shotCount}/${ARROWS_PER_END} · ${endTotal} pts · Total ${grandTotal}`;
  }

  /** Draw meter + controls hint (at the shooting line). */
  showDraw(on: boolean) {
    this.#draw.classList.toggle("show", on);
  }

  /** Charge ring 0..1, distance readout to the lane target. */
  setDraw(t: number, distance: number) {
    const deg = Math.round(t * 360);
    const hot = t >= 1 ? "#f5c542" : "var(--accent-strong)";
    this.#ring.style.background = `conic-gradient(${hot} ${deg}deg, var(--accent-soft) ${deg}deg)`;
    this.#meter.classList.toggle("full", t >= 1);
    this.#dist.textContent = `${Math.round(distance)}m`;
  }

  /** Big centre banner: "GOLD! +10" / end summaries. */
  toast(text: string, color = "var(--accent-strong)", seconds = 1.6) {
    this.#toast.textContent = text;
    this.#toast.style.color = color;
    this.#toast.classList.add("show");
    this.#toastUntil = performance.now() + seconds * 1000;
  }

  /** Per-frame housekeeping (toast expiry). */
  update() {
    if (this.#toastUntil > 0 && performance.now() >= this.#toastUntil) {
      this.#toastUntil = 0;
      this.#toast.classList.remove("show");
    }
  }
}
