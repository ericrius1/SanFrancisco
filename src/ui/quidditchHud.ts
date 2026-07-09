import type { QuidditchTeam, QuidditchRole } from "../gameplay/quidditch";
import { ROLE_INFO } from "../gameplay/quidditch";

/**
 * The Quidditch broadcast overlay: a live scoreboard (Scarlet vs Azure, snitch
 * status, your role), a start/role modal, and the Quidditch-specific flight
 * tutorial. All DOM + CSS is injected here so index.html stays clean; main.ts
 * just calls the thin methods and wires onPickRole.
 */

const TEAM_LABEL: Record<QuidditchTeam, string> = { red: "Scarlet", blue: "Azure" };
const STYLE_ID = "quidditch-hud-styles";
const RULES_SEEN_KEY = "sf.quidditch.rules";

export type QuidditchStartMode = "play" | "tutorial";
export type QuidditchTutorialSample = {
  riding: boolean;
  role: QuidditchRole | null;
  x: number;
  y: number;
  z: number;
  speed: number;
};
type QuidditchTutorialEvent = "action" | "score" | "snitch";

const CSS = `
#hud .quid-board {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: none; flex-direction: column; align-items: center; gap: 6px;
  padding: 10px 16px 11px; border-radius: var(--r-lg);
  background: var(--surface-strong); backdrop-filter: blur(var(--blur-strong));
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow-md), var(--edge-hi);
  font-family: var(--font); color: var(--text);
  pointer-events: none; user-select: none; z-index: var(--z-panel);
}
#hud .quid-board.on { display: flex; animation: quidpop 0.4s ease; }
@keyframes quidpop { from { opacity: 0; transform: translate(-50%, -10px); } }
#hud .quid-title { font-size: 10px; letter-spacing: 2.4px; text-transform: uppercase; opacity: 0.62; }
#hud .quid-score { display: flex; align-items: center; gap: 14px; }
#hud .quid-team { display: flex; flex-direction: column; align-items: center; min-width: 74px; }
#hud .quid-team .nm { font-size: 11px; font-weight: 700; letter-spacing: 1px; text-transform: uppercase; }
#hud .quid-team .pts { font-size: 30px; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
#hud .quid-team.red .nm { color: #ff8a7a; }
#hud .quid-team.red .pts { color: #ff6a56; text-shadow: 0 0 14px rgba(255,80,60,0.35); }
#hud .quid-team.blue .nm { color: #8fbcff; }
#hud .quid-team.blue .pts { color: #62a0ff; text-shadow: 0 0 14px rgba(70,120,255,0.4); }
#hud .quid-team.flash .pts { animation: quidflash 0.7s ease; }
@keyframes quidflash { 0% { transform: scale(1); } 35% { transform: scale(1.5); filter: brightness(1.7); } 100% { transform: scale(1); } }
#hud .quid-vs { font-size: 12px; opacity: 0.5; font-weight: 600; }
#hud .quid-snitch { font-size: 10.5px; letter-spacing: 0.6px; opacity: 0.82; display: flex; align-items: center; gap: 6px; }
#hud .quid-snitch .dot { width: 8px; height: 8px; border-radius: 50%; background: #ffd54a; box-shadow: 0 0 8px #ffcf3f; animation: quidpulse 1.3s ease-in-out infinite; }
@keyframes quidpulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
#hud .quid-snitch.caught { opacity: 0.55; text-decoration: line-through; }
#hud .quid-snitch.caught .dot { animation: none; background: #7c8a94; box-shadow: none; }
#hud .quid-role { font-size: 10.5px; opacity: 0.9; }
#hud .quid-role b { color: var(--accent-strong); }

#hud .quid-modal {
  position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
  background: var(--scrim); backdrop-filter: blur(5px); z-index: var(--z-modal);
  font-family: var(--font); color: var(--text);
  pointer-events: auto;
}
#hud .quid-modal.on { display: flex; }
#hud .quid-card {
  width: min(560px, 92vw); max-height: 88vh; overflow-y: auto;
  background: linear-gradient(180deg, rgba(12,28,42,0.97), rgba(8,20,31,0.97)); border: 1px solid var(--hairline-2);
  border-radius: var(--r-xl); padding: 24px 26px 22px; box-shadow: var(--shadow-lg), var(--edge-hi);
  animation: quidcard 0.32s var(--ease);
}
@keyframes quidcard { from { opacity: 0; transform: translateY(14px) scale(0.98); } }
#hud .quid-card h2 { margin: 0 0 4px; font-size: 20px; letter-spacing: 0.5px; }
#hud .quid-card .sub { margin: 0 0 16px; font-size: 12.5px; opacity: 0.68; line-height: 1.5; }
#hud .quid-card .sub b { color: #ffd76a; }
#hud .quid-cols { display: flex; gap: 14px; }
#hud .quid-col { flex: 1; }
#hud .quid-col > .h { font-size: 11px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; margin-bottom: 8px; opacity: 0.9; }
#hud .quid-col.red > .h { color: #ff8a7a; }
#hud .quid-col.blue > .h { color: #8fbcff; }
#hud .quid-opt {
  display: block; width: 100%; text-align: left; cursor: pointer;
  background: var(--surface-raised); border: 1px solid var(--hairline);
  border-radius: var(--r-lg); padding: 9px 11px; margin-bottom: 8px; color: var(--text);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease), transform 0.1s var(--ease);
}
#hud .quid-opt:hover { background: var(--accent-soft); border-color: var(--accent); transform: translateY(-1px); }
#hud .quid-opt .r { font-size: 13px; font-weight: 700; }
#hud .quid-opt .b { font-size: 10.5px; opacity: 0.66; line-height: 1.4; margin-top: 2px; }
#hud .quid-opt:disabled { opacity: 0.32; cursor: default; }
#hud .quid-opt:disabled:hover { background: var(--surface-raised); border-color: var(--hairline); transform: none; }
#hud .quid-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
#hud .quid-btn {
  cursor: pointer; font: inherit; font-size: 12px; padding: 7px 15px; border-radius: var(--r-sm);
  background: var(--surface-raised); border: 1px solid var(--hairline-2); color: var(--text);
  transition: border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
#hud .quid-btn:hover { border-color: var(--accent); }
#hud .quid-btn.go { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong); font-weight: 700; }
#hud .quid-start-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 18px 0 14px; }
#hud .quid-start-option {
  min-height: 116px; cursor: pointer; text-align: left; color: var(--text);
  background: var(--surface-raised); border: 1px solid var(--hairline);
  border-radius: var(--r-lg); padding: 14px 14px 13px; transition: transform 0.12s var(--ease), border-color var(--dur) var(--ease), background var(--dur) var(--ease);
}
#hud .quid-start-option:hover { transform: translateY(-1px); border-color: #69cfff; background: rgba(70,160,255,0.13); }
#hud .quid-start-option .h { display: block; font-size: 14px; font-weight: 800; margin-bottom: 7px; }
#hud .quid-start-option .b { display: block; font-size: 12px; line-height: 1.42; opacity: 0.72; }
#hud .quid-start-option.primary { border-color: rgba(105,207,255,0.55); background: rgba(47,138,220,0.16); }
#hud .quid-rules-list { margin: 6px 0 16px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
#hud .quid-rules-list li { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.45; }
#hud .quid-rules-list .ic { font-size: 17px; line-height: 1.2; flex-shrink: 0; }
#hud .quid-rules-list b { color: var(--accent-strong); }

#hud .quid-tutorial {
  position: absolute; right: 18px; bottom: 92px; width: min(360px, calc(100vw - 32px));
  display: none; padding: 13px 14px 14px; z-index: var(--z-panel); pointer-events: none; user-select: none;
  color: var(--text); font-family: var(--font);
  background: var(--surface-strong); border: 1px solid var(--hairline-2);
  border-radius: var(--r-lg); box-shadow: var(--shadow-md), var(--edge-hi); backdrop-filter: blur(var(--blur-strong));
}
#hud .quid-tutorial.on { display: block; animation: quidcard 0.28s ease; }
#hud .quid-tutorial .top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 7px; }
#hud .quid-tutorial .kicker { font-size: 10px; letter-spacing: 1.6px; text-transform: uppercase; opacity: 0.58; }
#hud .quid-tutorial .step { font-size: 10.5px; opacity: 0.64; font-variant-numeric: tabular-nums; }
#hud .quid-tutorial .title { font-size: 14px; font-weight: 800; margin-bottom: 4px; }
#hud .quid-tutorial .text { font-size: 12px; line-height: 1.45; opacity: 0.78; min-height: 34px; }
#hud .quid-tutorial .keys { display: flex; flex-wrap: wrap; gap: 5px; min-height: 23px; margin: 9px 0 10px; }
#hud .quid-tutorial .key {
  min-width: 24px; height: 22px; padding: 0 7px; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--r-xs); background: var(--surface-raised); border: 1px solid var(--hairline-2);
  color: #bde8ff; font-size: 11px; font-weight: 700;
}
#hud .quid-tutorial .bar { height: 5px; overflow: hidden; border-radius: 999px; background: rgba(255,255,255,0.09); }
#hud .quid-tutorial .fill { width: 0%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #5cc8ff, #bdf5ff); transition: width 0.16s ease; }
@media (max-width: 720px) {
  #hud .quid-start-grid { grid-template-columns: 1fr; }
  #hud .quid-tutorial { left: 16px; right: 16px; bottom: 78px; width: auto; }
}
`;

export class QuidditchHUD {
  onPickRole: (team: QuidditchTeam, role: QuidditchRole, mode: QuidditchStartMode) => void = () => {};
  onCloseModal: () => void = () => {};

  #board: HTMLElement;
  #redPts: HTMLElement;
  #bluePts: HTMLElement;
  #redTeam: HTMLElement;
  #blueTeam: HTMLElement;
  #snitchEl: HTMLElement;
  #roleEl: HTMLElement;
  #modal: HTMLElement;
  #card: HTMLElement;
  #tutorialEl: HTMLElement;
  #tutorialStepEl: HTMLElement;
  #tutorialTitleEl: HTMLElement;
  #tutorialTextEl: HTMLElement;
  #tutorialKeysEl: HTMLElement;
  #tutorialFillEl: HTMLElement;
  #flashTimers: Record<QuidditchTeam, number> = { red: 0, blue: 0 };
  #tutorialOn = false;
  #tutorialStep = 0;
  #tutorialTravel = 0;
  #tutorialTimer = 0;
  #tutorialBaseY = 0;
  #tutorialAltDelta = 0;
  #tutorialLast: { x: number; z: number } | null = null;
  #tutorialRole: QuidditchRole | null = null;
  #tutorialRoleLabel = "";
  #tutorialEvents = new Set<QuidditchTutorialEvent>();

  constructor() {
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const hud = document.getElementById("hud")!;

    this.#board = document.createElement("div");
    this.#board.className = "quid-board";
    this.#board.innerHTML = `
      <div class="quid-title">⚡ Quidditch ⚡</div>
      <div class="quid-score">
        <div class="quid-team red"><span class="nm">Scarlet</span><span class="pts" data-red>0</span></div>
        <div class="quid-vs">—</div>
        <div class="quid-team blue"><span class="nm">Azure</span><span class="pts" data-blue>0</span></div>
      </div>
      <div class="quid-snitch"><span class="dot"></span><span data-snitch>Snitch loose · +150 &amp; wins</span></div>
      <div class="quid-role" data-role></div>`;
    hud.appendChild(this.#board);
    this.#redPts = this.#board.querySelector("[data-red]")!;
    this.#bluePts = this.#board.querySelector("[data-blue]")!;
    this.#redTeam = this.#board.querySelector(".quid-team.red")!;
    this.#blueTeam = this.#board.querySelector(".quid-team.blue")!;
    this.#snitchEl = this.#board.querySelector("[data-snitch]")!;
    this.#roleEl = this.#board.querySelector("[data-role]")!;

    this.#modal = document.createElement("div");
    this.#modal.className = "quid-modal";
    this.#card = document.createElement("div");
    this.#card.className = "quid-card";
    this.#modal.appendChild(this.#card);
    this.#modal.addEventListener("click", (e) => {
      if (e.target === this.#modal) this.hideModal();
    });
    hud.appendChild(this.#modal);

    this.#tutorialEl = document.createElement("div");
    this.#tutorialEl.className = "quid-tutorial";
    this.#tutorialEl.innerHTML = `
      <div class="top"><span class="kicker">Flight tutorial</span><span class="step" data-step></span></div>
      <div class="title" data-title></div>
      <div class="text" data-text></div>
      <div class="keys" data-keys></div>
      <div class="bar"><div class="fill" data-fill></div></div>`;
    hud.appendChild(this.#tutorialEl);
    this.#tutorialStepEl = this.#tutorialEl.querySelector("[data-step]")!;
    this.#tutorialTitleEl = this.#tutorialEl.querySelector("[data-title]")!;
    this.#tutorialTextEl = this.#tutorialEl.querySelector("[data-text]")!;
    this.#tutorialKeysEl = this.#tutorialEl.querySelector("[data-keys]")!;
    this.#tutorialFillEl = this.#tutorialEl.querySelector("[data-fill]")!;
  }

  setActive(on: boolean) {
    this.#board.classList.toggle("on", on);
    if (!on) {
      this.hideModal();
      this.stopTutorial();
    }
  }

  setScores(red: number, blue: number) {
    this.#redPts.textContent = String(red);
    this.#bluePts.textContent = String(blue);
  }

  flashGoal(team: QuidditchTeam) {
    const el = team === "red" ? this.#redTeam : this.#blueTeam;
    el.classList.remove("flash");
    void el.offsetWidth;
    el.classList.add("flash");
    this.#flashTimers[team] = 0.7;
  }

  setSnitch(caught: boolean, byTeam?: QuidditchTeam) {
    this.#snitchEl.parentElement!.classList.toggle("caught", caught);
    this.#snitchEl.innerHTML = caught
      ? `Snitch caught${byTeam ? ` by ${TEAM_LABEL[byTeam]}` : ""}`
      : `Snitch loose · +150 &amp; wins`;
  }

  setRole(label: string | null) {
    this.#roleEl.innerHTML = label ? `You are the <b>${label}</b> · E to dismount` : "";
  }

  showStart(open: { team: QuidditchTeam; role: QuidditchRole; label: string }[]) {
    if (document.pointerLockElement) document.exitPointerLock();
    this.#card.innerHTML = `
      <h2>Start Quidditch</h2>
      <p class="sub">Choose an interactive flight warmup or jump straight into a live match.</p>
      <div class="quid-start-grid">
        <button class="quid-start-option primary" data-start="tutorial">
          <span class="h">Tutorial</span>
          <span class="b">Mount a broom, fly out, change altitude, and use your role action before the match carries on.</span>
        </button>
        <button class="quid-start-option" data-start="play">
          <span class="h">Play match</span>
          <span class="b">Pick a role and start the match immediately with the AI filling every other broom.</span>
        </button>
      </div>
      <div class="quid-actions"><button class="quid-btn" data-close>Never mind</button></div>`;
    this.#card.querySelectorAll<HTMLButtonElement>("[data-start]").forEach((btn) => {
      btn.addEventListener("click", () => this.showRoles(open, btn.dataset.start as QuidditchStartMode));
    });
    this.#card.querySelector("[data-close]")!.addEventListener("click", () => this.hideModal());
    this.#modal.classList.add("on");
  }

  /** Open the take-over picker. `open` = roles still available, per team. */
  showRoles(open: { team: QuidditchTeam; role: QuidditchRole; label: string }[], mode: QuidditchStartMode = "play") {
    if (document.pointerLockElement) document.exitPointerLock();
    const byTeam = (team: QuidditchTeam) => {
      const rows = (["Chaser", "Beater", "Keeper", "Seeker"] as QuidditchRole[])
        .map((role) => {
          const avail = open.some((o) => o.team === team && o.role === role);
          const info = ROLE_INFO[role];
          return `<button class="quid-opt" data-team="${team}" data-role="${role}"${avail ? "" : " disabled"}>
            <div class="r">${role}${info.count > 1 ? ` <span style="opacity:.5;font-weight:400">×${info.count}</span>` : ""}</div>
            <div class="b">${info.blurb}</div></button>`;
        })
        .join("");
      return `<div class="quid-col ${team}"><div class="h">${TEAM_LABEL[team]}</div>${rows}</div>`;
    };
    this.#card.innerHTML = `
      <h2>${mode === "tutorial" ? "Pick a tutorial role" : "Pick your position"}</h2>
      <p class="sub">Take over any open broom. The AI flies the rest.</p>
      <div class="quid-cols">${byTeam("red")}${byTeam("blue")}</div>
      <div class="quid-actions"><button class="quid-btn" data-close>Never mind</button></div>`;
    this.#card.querySelectorAll<HTMLButtonElement>(".quid-opt").forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", () => {
        const team = btn.dataset.team as QuidditchTeam;
        const role = btn.dataset.role as QuidditchRole;
        this.hideModal();
        this.onPickRole(team, role, mode);
      });
    });
    this.#card.querySelector("[data-close]")!.addEventListener("click", () => this.hideModal());
    this.#modal.classList.add("on");
  }

  /** The one-time (per browser) rules briefing. */
  showRules(force = false) {
    if (!force && localStorage.getItem(RULES_SEEN_KEY)) return false;
    localStorage.setItem(RULES_SEEN_KEY, "1");
    if (document.pointerLockElement) document.exitPointerLock();
    this.#card.innerHTML = `
      <h2>⚡ Welcome to Quidditch</h2>
      <p class="sub">Two teams of seven fly brooms over Golden Gate Park. Here's the game in <b>30 seconds</b>:</p>
      <ul class="quid-rules-list">
        <li><span class="ic">🔴</span><span><b>Chasers</b> hurl the red <b>Quaffle</b> through an enemy hoop — <b>10 points</b> a goal. Left-click to throw.</span></li>
        <li><span class="ic">🧤</span><span><b>Keeper</b> guards the three hoops at their end.</span></li>
        <li><span class="ic">⚫</span><span><b>Beaters</b> bat the two black <b>Bludgers</b> into rival riders to knock them off course. Click to swing.</span></li>
        <li><span class="ic">✨</span><span><b>Seeker</b> chases the tiny golden <b>Snitch</b>. Catching it scores <b>150</b> and <b>ends the match</b> — whoever leads then wins.</span></li>
        <li><span class="ic">🧹</span><span>Step into the glowing circle and press <b>E</b> to pick a position and fly. <b>E</b> again to hop off.</span></li>
      </ul>
      <div class="quid-actions"><button class="quid-btn go" data-close>Let's fly ⚡</button></div>`;
    this.#card.querySelector("[data-close]")!.addEventListener("click", () => this.hideModal());
    this.#modal.classList.add("on");
    return true;
  }

  get modalOpen() {
    return this.#modal.classList.contains("on");
  }

  hideModal() {
    if (!this.#modal.classList.contains("on")) return;
    this.#modal.classList.remove("on");
    this.onCloseModal();
  }

  startTutorial(roleLabel: string, role: QuidditchRole) {
    this.#tutorialOn = true;
    this.#tutorialStep = 0;
    this.#tutorialRole = role;
    this.#tutorialRoleLabel = roleLabel;
    this.#tutorialEvents.clear();
    this.#resetTutorialScratch();
    this.#tutorialEl.classList.add("on");
    this.#renderTutorial("Fly out", `Leave the blue start circle as the ${roleLabel}.`, ["W", "Mouse", "Shift"], 0);
  }

  stopTutorial() {
    this.#tutorialOn = false;
    this.#tutorialEl.classList.remove("on");
  }

  noteTutorial(event: QuidditchTutorialEvent) {
    if (this.#tutorialOn) this.#tutorialEvents.add(event);
  }

  update(dt: number, sample?: QuidditchTutorialSample) {
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      if (this.#flashTimers[team] > 0) {
        this.#flashTimers[team] -= dt;
        if (this.#flashTimers[team] <= 0) {
          (team === "red" ? this.#redTeam : this.#blueTeam).classList.remove("flash");
        }
      }
    }
    if (sample) this.#updateTutorial(dt, sample);
  }

  #resetTutorialScratch(sample?: QuidditchTutorialSample) {
    this.#tutorialTravel = 0;
    this.#tutorialTimer = 0;
    this.#tutorialBaseY = sample?.y ?? 0;
    this.#tutorialAltDelta = 0;
    this.#tutorialLast = sample ? { x: sample.x, z: sample.z } : null;
  }

  #advanceTutorial(sample: QuidditchTutorialSample) {
    this.#tutorialStep++;
    this.#tutorialEvents.clear();
    this.#resetTutorialScratch(sample);
  }

  #updateTutorial(dt: number, sample: QuidditchTutorialSample) {
    if (!this.#tutorialOn) return;
    if (!sample.riding) {
      this.#renderTutorial("Tutorial paused", "Rejoin from the blue start circle to continue.", ["E"], 0);
      this.#resetTutorialScratch(sample);
      return;
    }
    if (!this.#tutorialLast) this.#resetTutorialScratch(sample);
    const last = this.#tutorialLast;
    if (last) {
      const d = Math.hypot(sample.x - last.x, sample.z - last.z);
      if (d < 30) this.#tutorialTravel += d;
      last.x = sample.x;
      last.z = sample.z;
    }

    if (this.#tutorialStep === 0) {
      const progress = Math.min(1, this.#tutorialTravel / 35);
      this.#renderTutorial("Fly out", `Leave the blue start circle as the ${this.#tutorialRoleLabel}.`, ["W", "Mouse", "Shift"], progress);
      if (progress >= 1) this.#advanceTutorial(sample);
      return;
    }

    if (this.#tutorialStep === 1) {
      this.#tutorialAltDelta = Math.max(this.#tutorialAltDelta, Math.abs(sample.y - this.#tutorialBaseY));
      const progress = Math.min(1, this.#tutorialAltDelta / 8);
      this.#renderTutorial("Change altitude", "Use vertical control and camera angle to climb or dive through open air.", ["Q", "U", "W"], progress);
      if (progress >= 1) this.#advanceTutorial(sample);
      return;
    }

    if (this.#tutorialStep === 2) {
      const role = this.#tutorialRole ?? sample.role;
      const text = role === "Beater"
        ? "Left-click near a Bludger to swing your bat."
        : "Left-click across the pitch to throw a practice Quaffle.";
      const progress = this.#tutorialEvents.has("action") ? 1 : 0;
      this.#renderTutorial("Use your action", text, ["Click"], progress);
      if (progress >= 1) this.#advanceTutorial(sample);
      return;
    }

    if (this.#tutorialStep === 3) {
      this.#tutorialTimer += dt;
      const progress = this.#tutorialEvents.has("score") || this.#tutorialEvents.has("snitch")
        ? 1
        : Math.min(1, this.#tutorialTimer / 10);
      this.#renderTutorial("Stay with play", "Keep flying with the match. Scores now trigger fireworks at the hoops.", ["W", "A", "S", "D"], progress);
      if (progress >= 1) this.#advanceTutorial(sample);
      return;
    }

    this.#tutorialTimer += dt;
    this.#renderTutorial("Tutorial complete", "Play on. Use E to dismount when you are done.", ["E"], 1);
    if (this.#tutorialTimer > 2.4) this.stopTutorial();
  }

  #renderTutorial(title: string, text: string, keys: string[], progress: number) {
    this.#tutorialStepEl.textContent = this.#tutorialStep < 4 ? `${this.#tutorialStep + 1}/4` : "";
    this.#tutorialTitleEl.textContent = title;
    this.#tutorialTextEl.textContent = text;
    this.#tutorialKeysEl.innerHTML = keys.map((key) => `<span class="key">${key}</span>`).join("");
    this.#tutorialFillEl.style.width = `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
  }
}
