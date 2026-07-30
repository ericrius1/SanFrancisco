import type { TrickBook } from "../vehicles/skate";
import "./skateHud.css";

export type SkateHudState = {
  book: TrickBook | null;
  /** True while a grind or manual is being balanced. */
  balancing: boolean;
  /** Signed balance meter, ±1 = gone. */
  balance: number;
  /** Tutorial line, or "" when the coach has nothing to say. */
  coach?: string;
  /** Steps cleared / steps total, for the pip row. */
  coachStep?: number;
  coachTotal?: number;
  /** True while the coach is congratulating rather than instructing. */
  coachCheer?: boolean;
};

const fmt = (n: number) => Math.round(n).toLocaleString("en-US");

/**
 * The combo meter.
 *
 * It only exists while the player is on a skateboard, and it only says three
 * things: what the open chain is worth, what it is made of, and — while you're
 * on a rail — how close the balance meter is to throwing you off. Everything
 * writes through cached nodes with string guards, because this updates every
 * rendered frame and the HUD is not where frame budget should go.
 */
export class SkateHUD {
  #root: HTMLElement;
  #scoreN: HTMLElement;
  #best: HTMLElement;
  #combo: HTMLElement;
  #chain: HTMLElement;
  #pts: HTMLElement;
  #mult: HTMLElement;
  #banner: HTMLElement;
  #verdict: HTMLElement;
  #detail: HTMLElement;
  #balance: HTMLElement;
  #pip: HTMLElement;
  #coach: HTMLElement;
  #coachSay: HTMLElement;
  #coachPips: HTMLElement;
  #lastCoach = "";
  #lastPips = -1;

  #lastScore = -1;
  #lastBest = -1;
  #lastChain = "";
  #lastPts = "";
  #lastMult = "";
  #lastDetail = "";
  #visible = false;

  constructor(host: HTMLElement = document.getElementById("hud")!) {
    this.#root = document.createElement("div");
    this.#root.className = "skate-ui";
    this.#root.innerHTML = `
      <div class="coach"><span class="pips"></span><span class="say"></span></div>
      <div class="banner"><span class="verdict"></span><span class="detail"></span></div>
      <div class="combo"><span class="chain"></span><span class="pts"></span><span class="mult"></span></div>
      <div class="balance"><span class="label">balance</span><span class="bar"><span class="pip"></span></span></div>
      <div class="score"><span class="n">0</span><span class="best">best 0</span></div>`;
    host.appendChild(this.#root);
    const q = <T extends HTMLElement>(sel: string) => this.#root.querySelector(sel) as T;
    this.#scoreN = q(".score .n");
    this.#best = q(".score .best");
    this.#combo = q(".combo");
    this.#chain = q(".combo .chain");
    this.#pts = q(".combo .pts");
    this.#mult = q(".combo .mult");
    this.#banner = q(".banner");
    this.#verdict = q(".banner .verdict");
    this.#detail = q(".banner .detail");
    this.#balance = q(".balance");
    this.#pip = q(".balance .pip");
    this.#coach = q(".coach");
    this.#coachSay = q(".coach .say");
    this.#coachPips = q(".coach .pips");
  }

  update(state: SkateHudState) {
    // The coach outlives the combo panel: it can be talking before the player
    // has scored anything at all.
    const say = state.coach ?? "";
    if (say !== this.#lastCoach) {
      this.#lastCoach = say;
      this.#coachSay.textContent = say;
      this.#coach.classList.toggle("on", say.length > 0);
    }
    this.#coach.classList.toggle("cheer", !!state.coachCheer);
    const stepped = state.coachStep ?? -1;
    if (say && stepped !== this.#lastPips) {
      this.#lastPips = stepped;
      const total = state.coachTotal ?? 0;
      let pips = "";
      for (let i = 0; i < total; i++) pips += i < stepped ? "●" : "○";
      this.#coachPips.textContent = pips;
    }

    const book = state.book;
    const show = !!book;
    if (show !== this.#visible) {
      this.#visible = show;
      this.#root.classList.toggle("on", show);
    }
    if (!book) return;

    if (book.score !== this.#lastScore) {
      this.#lastScore = book.score;
      this.#scoreN.textContent = fmt(book.score);
    }
    if (book.best !== this.#lastBest) {
      this.#lastBest = book.best;
      this.#best.textContent = `best ${fmt(book.best)}`;
    }

    const active = book.active;
    this.#combo.classList.toggle("on", active);
    if (active) {
      let chain = "";
      for (const link of book.combo) {
        if (chain) chain += " + ";
        chain += link.count > 1 ? `${link.name} ×${link.count}` : link.name;
      }
      if (chain !== this.#lastChain) {
        this.#lastChain = chain;
        this.#chain.textContent = chain;
      }
      const pts = fmt(book.pendingTotal);
      if (pts !== this.#lastPts) {
        this.#lastPts = pts;
        this.#pts.textContent = pts;
      }
      const mult = `×${book.multiplier}`;
      if (mult !== this.#lastMult) {
        this.#lastMult = mult;
        this.#mult.textContent = mult;
      }
      // A chain that hasn't gained in a second is about to be a landing.
      this.#combo.classList.toggle("cooling", book.idle > 1);
    }

    const banner = book.banner;
    const bannerOn = banner.life > 0;
    this.#banner.classList.toggle("on", bannerOn);
    if (bannerOn) {
      this.#banner.classList.toggle("bailed", banner.bailed);
      const verdict = banner.bailed
        ? "Bailed"
        : banner.points >= 5000
          ? "SICK!"
          : banner.points >= 1500
            ? "Nice!"
            : "Landed";
      if (this.#verdict.textContent !== verdict) this.#verdict.textContent = verdict;
      const detail = banner.bailed ? banner.text : `${banner.text} — ${fmt(banner.points)}`;
      if (detail !== this.#lastDetail) {
        this.#lastDetail = detail;
        this.#detail.textContent = detail;
      }
    }

    this.#balance.classList.toggle("on", state.balancing);
    if (state.balancing) {
      const b = Math.max(-1, Math.min(1, state.balance));
      this.#pip.style.left = `${50 + b * 50}%`;
      this.#balance.classList.toggle("hot", Math.abs(b) > 0.62);
    }
  }

  dispose() {
    this.#root.remove();
  }
}
