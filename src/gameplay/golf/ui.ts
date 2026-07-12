import type { Club } from "./ball";
import { SWEET_SPOT } from "./tuning";

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

export type GolfPeerScore = { name: string; hole: number; strokes: number; total: number };
export type GolfHoleScore = { hole: number; par: number; strokes: number };

export class GolfUI {
  #root: HTMLElement;
  #hole: HTMLElement;
  #score: HTMLElement;
  #peers: HTMLElement;
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
    this.#peers = document.createElement("div");
    this.#peers.className = "gc-peers";
    this.#root.append(this.#hole, this.#score, this.#peers);
    hud.appendChild(this.#root);

    this.#swing = document.createElement("div");
    this.#swing.className = "golf-swing";
    this.#clubs = document.createElement("div");
    this.#clubs.className = "golf-clubs";
    this.#meter = document.createElement("div");
    this.#meter.className = "golf-meter";
    this.#fill = document.createElement("div");
    this.#fill.className = "gm-ring";
    // sweet-spot band: a golden arc over the top of the ring (92–100%);
    // releasing inside it is a pure strike (game.ts SWEET_SPOT)
    const sweet = document.createElement("div");
    sweet.className = "gm-sweet";
    sweet.style.background = `conic-gradient(transparent ${SWEET_SPOT * 360}deg, #ffd76a ${SWEET_SPOT * 360}deg, #ffe9ad 360deg)`;
    const inner = document.createElement("div");
    inner.className = "gm-inner";
    this.#club = document.createElement("div");
    this.#club.className = "gm-club";
    this.#carry = document.createElement("div");
    this.#carry.className = "gm-carry";
    inner.append(this.#club, this.#carry);
    this.#meter.append(this.#fill, sweet, inner);
    this.#swing.append(this.#clubs, this.#meter);
    hud.appendChild(this.#swing);

    // sweet-spot styling rides in from TS (index.html owns the base golf CSS
    // and must not be edited; tokens still come from :root)
    const style = document.createElement("style");
    style.textContent = `
      #hud .golf-meter .gm-sweet {
        position: absolute;
        inset: 0;
        border-radius: 50%;
        -webkit-mask: radial-gradient(closest-side, transparent 74%, #000 76%);
        mask: radial-gradient(closest-side, transparent 74%, #000 76%);
        opacity: 0;
        transition: opacity 0.15s var(--ease);
      }
      #hud .golf-meter.charging .gm-sweet { opacity: 0.9; }
      #hud .golf-meter.sweet .gm-ring { filter: brightness(1.35) saturate(1.15); }
      #hud .golf-meter.sweet .gm-club { color: #ffd76a; }
      @keyframes gm-perfect-pop {
        0% { transform: scale(1); }
        35% { transform: scale(1.14); }
        100% { transform: scale(1); }
      }
      #hud .golf-meter.perfect { animation: gm-perfect-pop 0.38s var(--ease); }
      #hud .golf-meter.perfect .gm-ring { filter: brightness(1.7) saturate(1.3); }
      #hud .golf-meter.perfect .gm-sweet { opacity: 1; }
    `;
    document.head.appendChild(style);
  }

  /** Round card (hole + running score). */
  setVisible(on: boolean) {
    this.#root.classList.toggle("show", on);
    if (!on) this.showSwing(false);
  }

  setHole(ref: number, par: number, len: number, blackYards?: number) {
    this.#root.title = "";
    this.#hole.textContent = `⛳ Hole ${ref} · Par ${par} · ${len}m${blackYards ? ` · ${blackYards}yd black` : ""}`;
  }

  setScore(strokes: number, totalDelta: number, holesDone: number) {
    this.#score.textContent = `${strokes} shot${strokes === 1 ? "" : "s"} · Round ${totalLabel(totalDelta)} thru ${holesDone}`;
  }

  setComplete(totalDelta: number, scores: GolfHoleScore[]) {
    this.#hole.textContent = "⛳ Round complete";
    this.#score.textContent = `${totalLabel(totalDelta)} · ${scores.length} holes`;
    this.#root.title = scores
      .map((s) => `Hole ${s.hole}: ${s.strokes} (${standingLabel(s.strokes, s.par)})`)
      .join(" · ");
    this.setVisible(true);
    this.showSwing(false);
  }

  setPeers(peers: GolfPeerScore[]) {
    const ordered = [...peers].sort((a, b) => a.total - b.total || a.name.localeCompare(b.name));
    this.#peers.textContent = ordered
      .slice(0, 4)
      .map((p) => `${p.name} H${p.hole} ${totalLabel(p.total)}`)
      .join("  ·  ");
    this.#peers.title = ordered
      .map((p) => `${p.name}: hole ${p.hole}, ${p.strokes} shots, ${totalLabel(p.total)} total`)
      .join("\n");
    this.#peers.classList.toggle("show", ordered.length > 0);
  }

  /** Swing context (near your ball): club rail + force meter. */
  showSwing(on: boolean) {
    this.#swing.classList.toggle("show", on);
    document.querySelector("#hud")?.classList.toggle("golf-context", on);
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

  /** Force meter: monotonic charge 0..1, estimated carry metres. */
  setCharge(t: number, carry: number, charging: boolean) {
    const pct = Math.round(t * 100);
    this.#fill.style.background = `conic-gradient(var(--accent-strong) ${pct * 3.6}deg, var(--accent-soft) ${pct * 3.6}deg)`;
    this.#meter.classList.toggle("charging", charging);
    this.#meter.classList.toggle("sweet", charging && t >= SWEET_SPOT);
    if (charging) this.#carry.textContent = `${Math.round(carry)}m`;
  }

  /** Released inside the sweet band: a quick golden pop on the meter. */
  flashPerfect() {
    this.#meter.classList.remove("perfect");
    void this.#meter.offsetWidth; // restart the animation
    this.#meter.classList.add("perfect");
    window.setTimeout(() => this.#meter.classList.remove("perfect"), 450);
  }
}
