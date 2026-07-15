import type { PickleballEvent, PickleballSide } from "./types";

/**
 * Pickleball HUD (GolfUI pattern): DOM built once into #hud, class toggles,
 * pointer-events none throughout. Three pieces —
 *  - score chip, top center: big tabular score pair, a serving-side dot, and a
 *    rally counter that climbs during long exchanges;
 *  - event banner: SIDE OUT / POINT! / GAME POINT / GAME with a quick pop
 *    (Mario Sports energy on the shared glass recipe);
 *  - controls hint row while seated (keycap chips like hud.ts).
 * CSS is injected from here via a <style> element on the :root design tokens —
 * index.html stays untouched.
 */

export type PickleballBannerKind = "point" | "sideout" | "gamepoint" | "game" | "join" | "fault";

const BANNER_SECONDS: Record<PickleballBannerKind, number> = {
  point: 1.6,
  sideout: 1.8,
  gamepoint: 2.4,
  game: 4,
  join: 3.4,
  fault: 1.8
};

const FAULT_LABEL: Record<string, string> = {
  out: "OUT!",
  doubleBounce: "TWO BOUNCES",
  doubleHit: "DOUBLE HIT",
  serveBox: "SERVICE FAULT",
  twoBounceRule: "TWO-BOUNCE RULE",
  kitchenVolley: "KITCHEN VOLLEY!",
  stalled: "DEAD BALL"
};

const CSS = /* css */ `
#hud .pb-card {
  position: absolute;
  left: 50%;
  top: 14px;
  transform: translateX(-50%) translateY(-8px);
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 16px;
  border-radius: var(--r-md);
  background: var(--surface-strong);
  border: 1px solid var(--hairline-2);
  box-shadow: var(--shadow-sm), var(--edge-hi);
  opacity: 0;
  transition: opacity 0.25s var(--ease), transform 0.25s var(--ease);
  pointer-events: none;
  white-space: nowrap;
}
#hud .pb-card.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}
#hud .pb-card .pb-title {
  font: 700 11px var(--font);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-mut);
}
#hud .pb-card .pb-score {
  display: flex;
  align-items: center;
  gap: 8px;
  font: 800 22px var(--font);
  font-variant-numeric: tabular-nums;
  color: var(--text);
}
#hud .pb-card .pb-num {
  position: relative;
  min-width: 30px;
  text-align: center;
  padding: 0 2px 6px;
}
#hud .pb-card .pb-num.bump {
  animation: pbbump 0.36s var(--ease);
}
@keyframes pbbump {
  0% { transform: scale(1); }
  35% { transform: scale(1.35); color: var(--accent-strong); }
  100% { transform: scale(1); }
}
/* serving-side dot rides under the server's number */
#hud .pb-card .pb-num::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 6px;
  height: 6px;
  border-radius: var(--r-pill);
  transform: translateX(-50%) scale(0);
  background: var(--accent-strong);
  box-shadow: 0 0 8px var(--accent-glow);
  transition: transform 0.2s var(--ease);
}
#hud .pb-card .pb-num.serve::after {
  transform: translateX(-50%) scale(1);
}
#hud .pb-card .pb-dash {
  color: var(--text-mut);
  font-weight: 600;
  font-size: 16px;
}
#hud .pb-card .pb-rally {
  font: 650 11px var(--font);
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
  opacity: 0;
  transition: opacity 0.2s var(--ease);
}
#hud .pb-card .pb-rally.show { opacity: 1; }
#hud .pb-card .pb-rally.hot { color: var(--warn-strong); }

#hud .pb-banner {
  position: absolute;
  left: 50%;
  top: 21%;
  transform: translate(-50%, -50%) scale(0.6);
  padding: 8px 26px;
  border-radius: var(--r-pill);
  background: var(--surface-strong);
  border: 1px solid var(--accent-line);
  box-shadow: var(--shadow-sm), var(--edge-hi), 0 0 24px var(--accent-soft);
  font: 800 24px var(--font);
  letter-spacing: 0.06em;
  color: var(--accent-strong);
  opacity: 0;
  pointer-events: none;
  white-space: nowrap;
}
#hud .pb-banner.pop {
  animation: pbbanner var(--pb-banner-s, 1.8s) var(--ease);
}
#hud .pb-banner.kind-game { font-size: 30px; }
#hud .pb-banner.kind-gamepoint,
#hud .pb-banner.kind-fault { color: var(--warn-strong); border-color: rgba(242, 185, 111, 0.45); }
@keyframes pbbanner {
  0% { opacity: 0; transform: translate(-50%, -50%) scale(0.6); }
  9% { opacity: 1; transform: translate(-50%, -50%) scale(1.12); }
  16% { transform: translate(-50%, -50%) scale(1); }
  84% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -50%) scale(0.94); }
}

#hud .pb-hints {
  position: absolute;
  left: 50%;
  bottom: 24px;
  transform: translateX(-50%);
  display: flex;
  gap: 16px;
  padding: 6px 14px;
  border-radius: var(--r-md);
  background: var(--surface-strong);
  border: 1px solid var(--hairline-2);
  box-shadow: var(--shadow-sm), var(--edge-hi);
  opacity: 0;
  transition: opacity 0.25s var(--ease);
  pointer-events: none;
  white-space: nowrap;
}
#hud .pb-hints.show { opacity: 1; }
#hud .pb-hints .pb-hint {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font: 600 11px var(--font);
  color: var(--text-dim);
}
#hud .pb-hints .pb-k {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  padding: 2px 5px;
  border-radius: var(--r-xs);
  background: var(--surface-raised);
  border: 1px solid var(--hairline-strong);
  font: 700 10px var(--font-mono);
  color: var(--text-soft);
}
/* while seated, the ordinary travel toolbar/help are irrelevant and collide
   with the hint row — same tuck the golf swing context uses */
#hud.pb-context .toolbar,
#hud.pb-context .help {
  opacity: 0;
  pointer-events: none;
}
`;

const KEY_HINTS: [string[], string][] = [
  [["W", "A", "S", "D"], "Move"],
  [["Space"], "Swing"],
  [["Shift"], "Sprint"],
  [["E"], "Leave game"]
];
const PAD_HINTS: [string[], string][] = [
  [["L-stick"], "Move"],
  [["A"], "Swing"],
  [["LT"], "Sprint"],
  [["Y"], "Leave game"]
];

export class PickleballUI {
  #card: HTMLElement;
  #near: HTMLElement;
  #far: HTMLElement;
  #rally: HTMLElement;
  #banner: HTMLElement;
  #hints: HTMLElement;
  #hintsPad = false;
  #score: [number, number] = [-1, -1];
  #bannerTimer: ReturnType<typeof setTimeout> | null = null;
  #gamePointTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const hud = document.querySelector("#hud")!;
    if (!document.getElementById("pickleball-ui-css")) {
      const style = document.createElement("style");
      style.id = "pickleball-ui-css";
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    this.#card = document.createElement("div");
    this.#card.className = "pb-card";
    const title = document.createElement("span");
    title.className = "pb-title";
    title.textContent = "Pickleball";
    const score = document.createElement("span");
    score.className = "pb-score";
    this.#near = document.createElement("span");
    this.#near.className = "pb-num";
    this.#near.textContent = "0";
    const dash = document.createElement("span");
    dash.className = "pb-dash";
    dash.textContent = "–";
    this.#far = document.createElement("span");
    this.#far.className = "pb-num";
    this.#far.textContent = "0";
    score.append(this.#near, dash, this.#far);
    this.#rally = document.createElement("span");
    this.#rally.className = "pb-rally";
    this.#card.append(title, score, this.#rally);
    hud.appendChild(this.#card);

    this.#banner = document.createElement("div");
    this.#banner.className = "pb-banner";
    hud.appendChild(this.#banner);

    this.#hints = document.createElement("div");
    this.#hints.className = "pb-hints";
    this.#buildHints(false);
    hud.appendChild(this.#hints);
  }

  /** Scoreboard chip near a live court (seated or spectating). */
  setVisible(on: boolean): void {
    this.#card.classList.toggle("show", on);
    if (!on) this.setSeated(false);
  }

  /** Per-frame: score pair, serving-side dot, rally counter. */
  setScore(score: readonly [number, number], server: PickleballSide, rally: number): void {
    if (score[0] !== this.#score[0]) this.#setNum(this.#near, score[0]);
    if (score[1] !== this.#score[1]) this.#setNum(this.#far, score[1]);
    this.#score[0] = score[0];
    this.#score[1] = score[1];
    this.#near.classList.toggle("serve", server === 0);
    this.#far.classList.toggle("serve", server === 1);
    this.#rally.classList.toggle("show", rally >= 3);
    this.#rally.classList.toggle("hot", rally >= 8);
    if (rally >= 3) this.#rally.textContent = `rally ×${rally}`;
  }

  /** Pop a big center banner ("SIDE OUT", "GAME POINT", …). */
  banner(kind: PickleballBannerKind, text: string): void {
    this.#banner.textContent = text;
    this.#banner.className = `pb-banner kind-${kind}`;
    this.#banner.style.setProperty("--pb-banner-s", `${BANNER_SECONDS[kind]}s`);
    // restart the pop animation even when a banner is already mid-flight
    void this.#banner.offsetWidth;
    this.#banner.classList.add("pop");
    if (this.#bannerTimer) clearTimeout(this.#bannerTimer);
    this.#bannerTimer = setTimeout(() => this.#banner.classList.remove("pop"), BANNER_SECONDS[kind] * 1000 + 60);
  }

  /** Controls hint row while controlling an athlete. */
  setSeated(on: boolean, isPad = false): void {
    if (on && isPad !== this.#hintsPad) this.#buildHints(isPad);
    this.#hints.classList.toggle("show", on);
    document.querySelector("#hud")?.classList.toggle("pb-context", on);
  }

  /** One-line event mapping so the caller's onEvent stays drop-in. `localSide`
   *  personalizes the copy when the player is seated. */
  applyEvent(event: PickleballEvent, localSide: PickleballSide | null = null): void {
    if (event.kind === "point") {
      if (this.#gamePointTimer) {
        clearTimeout(this.#gamePointTimer);
        this.#gamePointTimer = null;
      }
      const label = event.winner === localSide ? "YOUR POINT!" : event.loser === localSide ? FAULT_LABEL[event.reason] ?? "POINT" : null;
      if (event.scoringSide === null) {
        this.banner("sideout", "SIDE OUT");
      } else if (label && event.loser === localSide) {
        this.banner("fault", label);
      } else {
        this.banner("point", label ?? `POINT — ${event.winner === 0 ? "NEAR" : "FAR"} SIDE`);
      }
      // game point next rally? side-out scoring: only the server can score
      const lead = event.score[event.winner] - event.score[event.loser];
      if (event.score[event.winner] >= 10 && lead >= 1) {
        this.#gamePointTimer = setTimeout(() => {
          this.#gamePointTimer = null;
          this.banner("gamepoint", "GAME POINT");
        }, 1200);
      }
    } else if (event.kind === "game") {
      if (this.#gamePointTimer) {
        clearTimeout(this.#gamePointTimer);
        this.#gamePointTimer = null;
      }
      const who = event.winner === localSide ? "YOU WIN!" : `${event.winner === 0 ? "NEAR" : "FAR"} SIDE WINS`;
      this.banner("game", `GAME — ${who} ${event.score[0]}–${event.score[1]}`);
    }
  }

  dispose(): void {
    if (this.#bannerTimer) clearTimeout(this.#bannerTimer);
    if (this.#gamePointTimer) clearTimeout(this.#gamePointTimer);
    this.setSeated(false);
    this.#card.remove();
    this.#banner.remove();
    this.#hints.remove();
  }

  #setNum(el: HTMLElement, value: number): void {
    el.textContent = String(value);
    el.classList.remove("bump");
    void el.offsetWidth;
    el.classList.add("bump");
  }

  #buildHints(isPad: boolean): void {
    this.#hintsPad = isPad;
    this.#hints.textContent = "";
    for (const [keys, label] of isPad ? PAD_HINTS : KEY_HINTS) {
      const hint = document.createElement("span");
      hint.className = "pb-hint";
      for (const key of keys) {
        const cap = document.createElement("span");
        cap.className = "pb-k";
        cap.textContent = key;
        hint.appendChild(cap);
      }
      hint.appendChild(document.createTextNode(label));
      this.#hints.appendChild(hint);
    }
  }
}
