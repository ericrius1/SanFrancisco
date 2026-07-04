import type { QuidditchTeam, QuidditchRole } from "../gameplay/quidditch";
import { ROLE_INFO } from "../gameplay/quidditch";

/**
 * The Quidditch broadcast overlay: a live scoreboard (Scarlet vs Azure, snitch
 * status, your role), a role-picker modal for taking over an open position, and
 * a one-time rules card. All DOM + CSS is injected here so index.html stays
 * clean; main.ts just calls the thin methods and wires onPickRole.
 */

const TEAM_LABEL: Record<QuidditchTeam, string> = { red: "Scarlet", blue: "Azure" };
const STYLE_ID = "quidditch-hud-styles";
const RULES_SEEN_KEY = "sf.quidditch.rules";

const CSS = `
#hud .quid-board {
  position: absolute; top: 14px; left: 50%; transform: translateX(-50%);
  display: none; flex-direction: column; align-items: center; gap: 6px;
  padding: 10px 16px 11px; border-radius: 14px;
  background: rgba(8, 18, 30, 0.66); backdrop-filter: blur(7px);
  border: 1px solid rgba(190, 225, 240, 0.16);
  box-shadow: 0 6px 26px rgba(0,0,0,0.4);
  font-family: "Avenir Next", "Helvetica Neue", sans-serif; color: #eaf4f8;
  pointer-events: none; user-select: none; z-index: 6;
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
#hud .quid-role b { color: #9ef2df; }

#hud .quid-modal {
  position: fixed; inset: 0; display: none; align-items: center; justify-content: center;
  background: rgba(4, 10, 18, 0.62); backdrop-filter: blur(4px); z-index: 40;
  font-family: "Avenir Next", "Helvetica Neue", sans-serif; color: #eaf4f8;
}
#hud .quid-modal.on { display: flex; }
#hud .quid-card {
  width: min(560px, 92vw); max-height: 88vh; overflow-y: auto;
  background: rgba(10, 22, 34, 0.94); border: 1px solid rgba(190,225,240,0.18);
  border-radius: 18px; padding: 24px 26px 22px; box-shadow: 0 20px 60px rgba(0,0,0,0.55);
  animation: quidcard 0.32s ease;
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
  background: rgba(255,255,255,0.04); border: 1px solid rgba(190,225,240,0.14);
  border-radius: 11px; padding: 9px 11px; margin-bottom: 8px; color: #eaf4f8;
  transition: border-color 0.15s, background 0.15s, transform 0.1s;
}
#hud .quid-opt:hover { background: rgba(120,220,200,0.12); border-color: #6fd7c4; transform: translateY(-1px); }
#hud .quid-opt .r { font-size: 13px; font-weight: 700; }
#hud .quid-opt .b { font-size: 10.5px; opacity: 0.66; line-height: 1.4; margin-top: 2px; }
#hud .quid-opt:disabled { opacity: 0.32; cursor: default; }
#hud .quid-opt:disabled:hover { background: rgba(255,255,255,0.04); border-color: rgba(190,225,240,0.14); transform: none; }
#hud .quid-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 8px; }
#hud .quid-btn {
  cursor: pointer; font: inherit; font-size: 12px; padding: 7px 15px; border-radius: 9px;
  background: rgba(255,255,255,0.06); border: 1px solid rgba(190,225,240,0.2); color: #eaf4f8;
}
#hud .quid-btn:hover { border-color: #6fd7c4; }
#hud .quid-btn.go { background: rgba(120,220,200,0.16); border-color: #6fd7c4; color: #9ef2df; font-weight: 700; }
#hud .quid-rules-list { margin: 6px 0 16px; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 9px; }
#hud .quid-rules-list li { display: flex; gap: 10px; font-size: 12.5px; line-height: 1.45; }
#hud .quid-rules-list .ic { font-size: 17px; line-height: 1.2; flex-shrink: 0; }
#hud .quid-rules-list b { color: #9ef2df; }
`;

export class QuidditchHUD {
  onPickRole: (team: QuidditchTeam, role: QuidditchRole) => void = () => {};
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
  #flashTimers: Record<QuidditchTeam, number> = { red: 0, blue: 0 };

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
  }

  setActive(on: boolean) {
    this.#board.classList.toggle("on", on);
    if (!on) this.hideModal();
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

  /** Open the take-over picker. `open` = roles still available, per team. */
  showRoles(open: { team: QuidditchTeam; role: QuidditchRole; label: string }[]) {
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
      <h2>Pick your position</h2>
      <p class="sub">Take over any open broom. The AI keeps playing the rest.</p>
      <div class="quid-cols">${byTeam("red")}${byTeam("blue")}</div>
      <div class="quid-actions"><button class="quid-btn" data-close>Never mind</button></div>`;
    this.#card.querySelectorAll<HTMLButtonElement>(".quid-opt").forEach((btn) => {
      if (btn.disabled) return;
      btn.addEventListener("click", () => {
        const team = btn.dataset.team as QuidditchTeam;
        const role = btn.dataset.role as QuidditchRole;
        this.hideModal();
        this.onPickRole(team, role);
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

  update(dt: number) {
    for (const team of ["red", "blue"] as QuidditchTeam[]) {
      if (this.#flashTimers[team] > 0) {
        this.#flashTimers[team] -= dt;
        if (this.#flashTimers[team] <= 0) {
          (team === "red" ? this.#redTeam : this.#blueTeam).classList.remove("flash");
        }
      }
    }
  }
}
