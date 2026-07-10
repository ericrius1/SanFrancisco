import type { Club } from "./ball";

/**
 * Golf HUD: a scorecard chip pinned top-center while a round is live, a club
 * rail + radial force meter that appear only in the swing context. Pure DOM
 * inside #hud (pointer-events stay off — clubs are keyboard-picked), styled on
 * the shared glass tokens like the satchel/toolbar.
 */

const STANDING: [number, string][] = [
  [-3, "Albatross"],
  [-2, "Eagle 🦅"],
  [-1, "Birdie 🐦"],
  [0, "Par"],
  [1, "Bogey"],
  [2, "Double Bogey"]
];

export function standingLabel(strokes: number, par: number): string {
  if (strokes === 1) return "Hole-in-one!! ⛳🎉";
  const d = strokes - par;
  const hit = STANDING.find(([n]) => n === d);
  return hit ? hit[1] : `+${d}`;
}

export function totalLabel(delta: number): string {
  return delta === 0 ? "E" : delta > 0 ? `+${delta}` : `${delta}`;
}

export class GolfUI {
  #root: HTMLElement;
  #hole: HTMLElement;
  #score: HTMLElement;
  #swing: HTMLElement;
  #clubs: HTMLElement;
  #meter: HTMLElement;
  #fill: HTMLElement;
  #club: HTMLElement;
  #carry: HTMLElement;
  #chips: HTMLElement[] = [];

  constructor() {
    const hud = document.querySelector("#hud")!;

    this.#root = document.createElement("div");
    this.#root.className = "golf-card";
    this.#hole = document.createElement("div");
    this.#hole.className = "gc-hole";
    this.#score = document.createElement("div");
    this.#score.className = "gc-score";
    this.#root.append(this.#hole, this.#score);
    hud.appendChild(this.#root);

    this.#swing = document.createElement("div");
    this.#swing.className = "golf-swing";
    this.#clubs = document.createElement("div");
    this.#clubs.className = "golf-clubs";
    this.#meter = document.createElement("div");
    this.#meter.className = "golf-meter";
    this.#fill = document.createElement("div");
    this.#fill.className = "gm-ring";
    const inner = document.createElement("div");
    inner.className = "gm-inner";
    this.#club = document.createElement("div");
    this.#club.className = "gm-club";
    this.#carry = document.createElement("div");
    this.#carry.className = "gm-carry";
    inner.append(this.#club, this.#carry);
    this.#meter.append(this.#fill, inner);
    this.#swing.append(this.#clubs, this.#meter);
    hud.appendChild(this.#swing);
  }

  /** Round card (hole + running score). */
  setVisible(on: boolean) {
    this.#root.classList.toggle("show", on);
    if (!on) this.showSwing(false);
  }

  setHole(ref: number, par: number, len: number) {
    this.#hole.textContent = `⛳ Hole ${ref} · Par ${par} · ${len}m`;
  }

  setScore(strokes: number, totalDelta: number, holesDone: number) {
    this.#score.textContent = `Stroke ${strokes + 1} · Round ${totalLabel(totalDelta)} thru ${holesDone}`;
  }

  /** Swing context (near your ball): club rail + force meter. */
  showSwing(on: boolean) {
    this.#swing.classList.toggle("show", on);
  }

  setClubs(clubs: Club[], active: number) {
    if (!this.#chips.length) {
      clubs.forEach((c, i) => {
        const chip = document.createElement("span");
        chip.className = "gclub";
        chip.innerHTML = `<b>${i + 1}</b>${c.short}`;
        this.#clubs.appendChild(chip);
        this.#chips.push(chip);
      });
    }
    this.#chips.forEach((chip, i) => chip.classList.toggle("on", i === active));
    const c = clubs[active];
    this.#club.textContent = c.short;
    this.#carry.textContent = c.id === "putter" ? "roll" : `${c.carry}m`;
  }

  /** Force meter: charge 0..1 (ping-pong handled by caller), est carry meters. */
  setCharge(t: number, carry: number, charging: boolean) {
    const pct = Math.round(t * 100);
    this.#fill.style.background = `conic-gradient(var(--accent-strong) ${pct * 3.6}deg, var(--accent-soft) ${pct * 3.6}deg)`;
    this.#meter.classList.toggle("charging", charging);
    if (charging) this.#carry.textContent = `${Math.round(carry)}m`;
  }
}
