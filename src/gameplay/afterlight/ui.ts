/**
 * Compact quest HUD for the Buena Vista Afterlight experience. The tracker is
 * deliberately an authored objective cluster rather than a generic card: fogged
 * glass, a single brass edge, five echo glyphs and one fixed-width clock.
 *
 * Everything lives under #hud, so immersive mode and cinematic clean-plate
 * capture hide it through the app's existing HUD controls.
 */

import { interactKeyLabel } from "../../core/input";

export type AfterlightUIState = "idle" | "active" | "failed" | "complete";

export type AfterlightTrackerView = {
  state: AfterlightUIState;
  /** Either the gathered count (0..5) or an explicit per-echo mask. */
  collected: number | readonly boolean[];
  /** Null/undefined renders the stable `--:--` dormant clock. */
  remainingSeconds?: number | null;
  /** Omit to use the state's restrained default objective copy. */
  objective?: string;
};

export type AfterlightMilestoneTone = "brass" | "mist" | "danger";

export type AfterlightMilestoneOptions = {
  eyebrow?: string;
  detail?: string;
  tone?: AfterlightMilestoneTone;
  seconds?: number;
};

const ECHO_COUNT = 5;
const DEFAULT_OBJECTIVE: Record<AfterlightUIState, string> = {
  idle: "The grove is listening",
  active: "Gather the five wandering echoes",
  failed: "The last light slipped into the fog",
  complete: "The hill remembers your path"
};

const STYLE = `
#hud .afterlight-tracker,
#hud .afterlight-prompt,
#hud .afterlight-banner {
  --al-brass: #d5b06a;
  --al-brass-hi: #f0d59a;
  --al-brass-soft: rgba(213, 176, 106, 0.24);
  --al-fog: rgba(199, 222, 219, 0.72);
  --al-ink: rgba(6, 16, 21, 0.82);
  box-sizing: border-box;
  pointer-events: none;
  user-select: none;
}

#hud .afterlight-tracker {
  --al-state: var(--al-brass);
  position: absolute;
  z-index: var(--z-hud-top);
  top: max(12px, env(safe-area-inset-top));
  left: 50%;
  width: min(384px, calc(100vw - 32px - env(safe-area-inset-left) - env(safe-area-inset-right)));
  min-height: 76px;
  padding: 10px 13px 9px;
  overflow: hidden;
  border: 1px solid rgba(213, 176, 106, 0.22);
  border-radius: 4px 12px 4px 12px;
  background:
    radial-gradient(140% 130% at 0% 0%, rgba(205, 226, 222, 0.13), transparent 52%),
    linear-gradient(112deg, #071319, #0c1b20);
  box-shadow:
    0 10px 28px rgba(0, 5, 9, 0.3),
    inset 0 1px 0 rgba(255, 244, 214, 0.045);
  opacity: 0;
  transform: translateX(-50%) translateY(-8px);
  transition: opacity 0.24s var(--ease), transform 0.3s var(--ease), border-color 0.3s var(--ease);
}

#hud .afterlight-tracker::before {
  content: "";
  position: absolute;
  top: -1px;
  left: 38px;
  right: 38px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--al-state), transparent);
  box-shadow: 0 0 11px color-mix(in srgb, var(--al-state) 48%, transparent);
}

#hud .afterlight-tracker::after {
  content: "";
  position: absolute;
  z-index: -1;
  width: 170px;
  height: 90px;
  right: -62px;
  bottom: -50px;
  border-radius: 50%;
  background: rgba(190, 215, 211, 0.055);
  filter: blur(14px);
}

#hud .afterlight-tracker.awake {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

#hud .afterlight-tracker[data-state="idle"] {
  --al-state: rgba(194, 214, 211, 0.62);
}

#hud .afterlight-tracker[data-state="active"] {
  --al-state: var(--al-brass-hi);
  border-color: rgba(213, 176, 106, 0.34);
}

#hud .afterlight-tracker[data-state="failed"] {
  --al-state: #d38170;
  border-color: rgba(211, 129, 112, 0.34);
}

#hud .afterlight-tracker[data-state="complete"] {
  --al-state: #f2d58e;
  border-color: rgba(242, 213, 142, 0.45);
  box-shadow:
    0 12px 34px rgba(0, 5, 9, 0.34),
    0 0 24px rgba(213, 176, 106, 0.09),
    inset 0 1px 0 rgba(255, 244, 214, 0.08);
}

#hud .afterlight-head {
  display: grid;
  grid-template-columns: 29px minmax(0, 1fr) 58px;
  align-items: center;
  gap: 9px;
}

#hud .afterlight-sigil {
  position: relative;
  width: 25px;
  height: 25px;
  transform: rotate(45deg);
  border: 1px solid var(--al-brass-soft);
  border-radius: 3px 8px 3px 8px;
  box-shadow: inset 0 0 11px rgba(213, 176, 106, 0.08);
}

#hud .afterlight-sigil::before {
  content: "";
  position: absolute;
  width: 10px;
  height: 10px;
  left: 6px;
  top: 6px;
  border: 1px solid var(--al-state);
  border-radius: 50%;
  box-shadow: -3px 2px 0 var(--al-ink);
}

#hud .afterlight-sigil::after {
  content: "";
  position: absolute;
  width: 3px;
  height: 3px;
  right: 4px;
  top: 4px;
  border-radius: 50%;
  background: var(--al-state);
  box-shadow: 0 0 7px var(--al-state);
}

#hud .afterlight-copy {
  min-width: 0;
}

#hud .afterlight-kicker {
  display: block;
  margin-bottom: 2px;
  color: var(--al-state);
  font: 750 9px/1 var(--font);
  letter-spacing: 0.2em;
  text-transform: uppercase;
}

#hud .afterlight-objective {
  display: -webkit-box;
  overflow: hidden;
  color: rgba(236, 245, 244, 0.93);
  font: 620 12.5px/1.25 var(--font);
  text-wrap: balance;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

#hud .afterlight-clock {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 5.25ch;
  min-height: 27px;
  justify-self: end;
  border-left: 1px solid rgba(213, 176, 106, 0.2);
  color: var(--al-state);
  font: 700 13px/1 var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.03em;
  text-shadow: 0 0 10px color-mix(in srgb, var(--al-state) 30%, transparent);
}

#hud .afterlight-clock.dormant {
  color: rgba(194, 214, 211, 0.4);
  text-shadow: none;
}

#hud .afterlight-progress {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 34px;
  align-items: center;
  gap: 10px;
  margin: 9px 1px 0 38px;
}

#hud .afterlight-echoes {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
}

#hud .afterlight-echoes::before {
  content: "";
  position: absolute;
  left: 8px;
  right: 8px;
  top: 50%;
  height: 1px;
  background: linear-gradient(90deg, rgba(213, 176, 106, 0.08), rgba(213, 176, 106, 0.32), rgba(213, 176, 106, 0.08));
}

#hud .afterlight-echo {
  position: relative;
  z-index: 1;
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  background: #0b1a20;
}

#hud .afterlight-echo::before {
  content: "";
  width: 8px;
  height: 8px;
  transform: rotate(45deg);
  border: 1px solid rgba(202, 220, 216, 0.34);
  border-radius: 1px 3px 1px 3px;
  background: rgba(194, 214, 211, 0.035);
  transition: background 0.22s var(--ease), border-color 0.22s var(--ease), box-shadow 0.22s var(--ease), transform 0.22s var(--ease);
}

#hud .afterlight-echo::after {
  content: "";
  position: absolute;
  width: 2px;
  height: 2px;
  border-radius: 50%;
  background: rgba(224, 237, 234, 0.38);
  transition: background 0.22s var(--ease), box-shadow 0.22s var(--ease);
}

#hud .afterlight-echo.collected::before {
  transform: rotate(45deg) scale(1.08);
  border-color: var(--al-brass-hi);
  background: rgba(213, 176, 106, 0.26);
  box-shadow: 0 0 9px rgba(240, 213, 154, 0.42);
}

#hud .afterlight-echo.collected::after {
  background: #fff3c7;
  box-shadow: 0 0 7px #f0d59a;
}

#hud .afterlight-tracker[data-state="active"] .afterlight-echo.next::before {
  border-color: rgba(240, 213, 154, 0.72);
  animation: afterlight-next 1.8s ease-in-out infinite;
}

#hud .afterlight-count {
  color: rgba(216, 231, 228, 0.66);
  font: 650 10px/1 var(--font-mono);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.06em;
  text-align: right;
}

#hud .afterlight-prompt {
  position: absolute;
  z-index: var(--z-hud-top);
  left: 50%;
  bottom: max(108px, calc(env(safe-area-inset-bottom) + 88px));
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  max-width: min(460px, calc(100vw - 28px));
  min-height: 44px;
  padding: 8px 18px 8px 8px;
  border: 1px solid rgba(132, 244, 255, 0.6);
  border-radius: 5px 12px 5px 12px;
  background:
    radial-gradient(120% 180% at 20% 0%, rgba(190, 216, 211, 0.11), transparent 62%),
    #050f18;
  box-shadow: 0 10px 32px rgba(0, 5, 9, 0.5), 0 0 22px rgba(92, 232, 240, 0.14), inset 0 1px 0 rgba(255, 244, 214, 0.08);
  opacity: 0;
  transform: translate(-50%, 7px);
  transition: opacity 0.2s var(--ease), transform 0.24s var(--ease);
}

#hud .afterlight-prompt.show {
  opacity: 1;
  transform: translate(-50%, 0);
}

#hud .afterlight-key {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  padding: 0 7px;
  border: 1px solid rgba(240, 213, 154, 0.48);
  border-radius: 3px 7px 3px 7px;
  color: var(--al-brass-hi);
  background: rgba(213, 176, 106, 0.1);
  box-shadow: inset 0 -1px 0 rgba(0, 0, 0, 0.28), 0 0 8px rgba(213, 176, 106, 0.08);
  font: 800 13px/1 var(--font-mono);
  flex: 0 0 auto;
}

#hud .afterlight-prompt-copy {
  min-width: 0;
  color: rgba(235, 244, 242, 0.92);
  font: 700 14px/1.25 var(--font);
  letter-spacing: 0.015em;
  text-align: center;
  text-wrap: balance;
}

#hud .afterlight-banner {
  --al-banner: var(--al-brass-hi);
  position: absolute;
  z-index: var(--z-hud-top);
  top: max(112px, calc(env(safe-area-inset-top) + 98px));
  left: 50%;
  width: min(470px, calc(100vw - 36px));
  padding: 9px 52px 10px;
  color: var(--text);
  text-align: center;
  opacity: 0;
  transform: translateX(-50%) translateY(-7px) scale(0.98);
  transition: opacity 0.2s var(--ease), transform 0.28s var(--ease);
}

#hud .afterlight-banner::before,
#hud .afterlight-banner::after {
  content: "";
  position: absolute;
  top: 50%;
  width: 40px;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--al-banner));
  box-shadow: 0 0 8px color-mix(in srgb, var(--al-banner) 35%, transparent);
}

#hud .afterlight-banner::before {
  left: 0;
}

#hud .afterlight-banner::after {
  right: 0;
  transform: rotate(180deg);
}

#hud .afterlight-banner.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0) scale(1);
}

#hud .afterlight-banner[data-tone="mist"] {
  --al-banner: #c8dfdc;
}

#hud .afterlight-banner[data-tone="danger"] {
  --al-banner: #e39580;
}

#hud .afterlight-banner-kicker {
  display: block;
  margin-bottom: 3px;
  color: var(--al-banner);
  font: 750 9px/1 var(--font);
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

#hud .afterlight-banner-title {
  display: block;
  color: rgba(247, 248, 239, 0.98);
  font: 720 18px/1.12 var(--font);
  text-shadow: 0 1px 6px rgba(0, 5, 9, 0.82), 0 0 15px color-mix(in srgb, var(--al-banner) 20%, transparent);
  text-wrap: balance;
}

#hud .afterlight-banner-detail {
  display: block;
  margin-top: 3px;
  color: rgba(218, 233, 230, 0.74);
  font: 560 11px/1.25 var(--font);
  text-wrap: balance;
}

#hud .afterlight-banner-detail:empty {
  display: none;
}

#hud.faded .afterlight-tracker,
#hud.faded .afterlight-prompt,
#hud.faded .afterlight-banner {
  opacity: 0 !important;
}

@keyframes afterlight-next {
  0%, 100% { box-shadow: 0 0 0 rgba(240, 213, 154, 0); }
  50% { box-shadow: 0 0 10px rgba(240, 213, 154, 0.34); }
}

@media (max-width: 520px) {
  #hud .afterlight-tracker {
    top: max(8px, env(safe-area-inset-top));
    width: calc(100vw - 20px - env(safe-area-inset-left) - env(safe-area-inset-right));
    min-height: 70px;
    padding: 8px 10px 8px;
  }
  #hud .afterlight-head {
    grid-template-columns: 27px minmax(0, 1fr) 55px;
    gap: 7px;
  }
  #hud .afterlight-sigil {
    width: 23px;
    height: 23px;
  }
  #hud .afterlight-sigil::before {
    left: 5px;
    top: 5px;
  }
  #hud .afterlight-objective {
    font-size: 11.5px;
  }
  #hud .afterlight-progress {
    margin: 7px 0 0 34px;
  }
  #hud .afterlight-banner {
    /* The compact app HUD already occupies both upper corners. Tracker and
       dialogue carry the same information without a third overlapping layer. */
    display: none;
  }
  #hud .afterlight-prompt {
    left: auto;
    right: max(8px, env(safe-area-inset-right));
    bottom: max(110px, calc(env(safe-area-inset-bottom) + 96px));
    width: min(224px, calc(100vw - 20px - env(safe-area-inset-left) - env(safe-area-inset-right)));
    max-width: none;
    transform: translateY(7px);
  }
  #hud .afterlight-prompt.show {
    transform: translateY(0);
  }
  #hud .afterlight-prompt-copy {
    font-size: 11px;
  }
}

@media (max-height: 520px) {
  #hud .afterlight-tracker {
    top: max(6px, env(safe-area-inset-top));
    min-height: 66px;
    padding-block: 7px;
  }
  #hud .afterlight-progress {
    margin-top: 6px;
  }
  #hud .afterlight-banner {
    top: max(82px, calc(env(safe-area-inset-top) + 76px));
  }
  #hud .afterlight-prompt {
    bottom: max(78px, calc(env(safe-area-inset-bottom) + 68px));
  }
}
`;

let sharedStyle: HTMLStyleElement | null = null;
let styleUsers = 0;

function retainStyle(): () => void {
  styleUsers++;
  if (!sharedStyle) {
    sharedStyle = document.createElement("style");
    sharedStyle.dataset.afterlightUi = "";
    sharedStyle.textContent = STYLE;
    document.head.appendChild(sharedStyle);
  }
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    styleUsers = Math.max(0, styleUsers - 1);
    if (styleUsers === 0) {
      sharedStyle?.remove();
      sharedStyle = null;
    }
  };
}

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(ECHO_COUNT, Math.max(0, Math.floor(value)));
}

function formatCountdown(seconds: number | null | undefined): { text: string; label: string } {
  if (seconds == null || !Number.isFinite(seconds)) {
    return { text: "--:--", label: "No countdown running" };
  }
  const whole = Math.min(99 * 60 + 59, Math.max(0, Math.ceil(seconds)));
  const minutes = Math.floor(whole / 60);
  const remainder = whole % 60;
  return {
    text: `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`,
    label: `${minutes} minutes ${remainder} seconds remaining`
  };
}

export class AfterlightUI {
  #tracker: HTMLElement;
  #objective: HTMLElement;
  #clock: HTMLTimeElement;
  #progress: HTMLElement;
  #echoes: HTMLElement[] = [];
  #count: HTMLElement;
  #prompt: HTMLElement;
  #promptKey: HTMLElement;
  #promptCopy: HTMLElement;
  #banner: HTMLElement;
  #bannerKicker: HTMLElement;
  #bannerTitle: HTMLElement;
  #bannerDetail: HTMLElement;
  #releaseStyle: () => void;
  #state: AfterlightUIState = "idle";
  #awake = false;
  #promptText: string | null = null;
  #milestoneRemaining = 0;
  #countdownText = "";
  #disposed = false;

  constructor(hud: HTMLElement | null = document.getElementById("hud")) {
    if (!hud) throw new Error("[afterlight-ui] #hud is unavailable");
    this.#releaseStyle = retainStyle();

    this.#tracker = document.createElement("section");
    this.#tracker.className = "afterlight-tracker";
    this.#tracker.dataset.state = this.#state;
    this.#tracker.setAttribute("aria-label", "Afterlight quest tracker");
    this.#tracker.setAttribute("aria-hidden", "true");

    const head = document.createElement("div");
    head.className = "afterlight-head";
    const sigil = document.createElement("span");
    sigil.className = "afterlight-sigil";
    sigil.setAttribute("aria-hidden", "true");
    const copy = document.createElement("div");
    copy.className = "afterlight-copy";
    const kicker = document.createElement("span");
    kicker.className = "afterlight-kicker";
    kicker.textContent = "Afterlight";
    this.#objective = document.createElement("span");
    this.#objective.className = "afterlight-objective";
    this.#objective.textContent = DEFAULT_OBJECTIVE.idle;
    copy.append(kicker, this.#objective);
    this.#clock = document.createElement("time");
    this.#clock.className = "afterlight-clock dormant";
    this.#clock.textContent = "--:--";
    this.#clock.setAttribute("aria-label", "No countdown running");
    head.append(sigil, copy, this.#clock);

    const progressRow = document.createElement("div");
    progressRow.className = "afterlight-progress";
    this.#progress = document.createElement("div");
    this.#progress.className = "afterlight-echoes";
    this.#progress.setAttribute("role", "progressbar");
    this.#progress.setAttribute("aria-label", "Wandering echoes gathered");
    this.#progress.setAttribute("aria-valuemin", "0");
    this.#progress.setAttribute("aria-valuemax", String(ECHO_COUNT));
    for (let i = 0; i < ECHO_COUNT; i++) {
      const echo = document.createElement("span");
      echo.className = "afterlight-echo";
      echo.setAttribute("aria-hidden", "true");
      this.#progress.appendChild(echo);
      this.#echoes.push(echo);
    }
    this.#count = document.createElement("span");
    this.#count.className = "afterlight-count";
    progressRow.append(this.#progress, this.#count);
    this.#tracker.append(head, progressRow);

    this.#prompt = document.createElement("div");
    this.#prompt.className = "afterlight-prompt";
    this.#prompt.setAttribute("role", "status");
    this.#prompt.setAttribute("aria-live", "polite");
    this.#prompt.setAttribute("aria-hidden", "true");
    this.#promptKey = document.createElement("span");
    this.#promptKey.className = "afterlight-key";
    this.#promptKey.textContent = "E";
    this.#promptCopy = document.createElement("span");
    this.#promptCopy.className = "afterlight-prompt-copy";
    this.#prompt.append(this.#promptKey, this.#promptCopy);

    this.#banner = document.createElement("div");
    this.#banner.className = "afterlight-banner";
    this.#banner.dataset.tone = "brass";
    this.#banner.setAttribute("role", "status");
    this.#banner.setAttribute("aria-live", "polite");
    this.#banner.setAttribute("aria-hidden", "true");
    this.#bannerKicker = document.createElement("span");
    this.#bannerKicker.className = "afterlight-banner-kicker";
    this.#bannerTitle = document.createElement("strong");
    this.#bannerTitle.className = "afterlight-banner-title";
    this.#bannerDetail = document.createElement("span");
    this.#bannerDetail.className = "afterlight-banner-detail";
    this.#banner.append(this.#bannerKicker, this.#bannerTitle, this.#bannerDetail);

    hud.append(this.#tracker, this.#prompt, this.#banner);
    this.setProgress(0);
  }

  /** Site-gate follower. State/progress stay intact while the HUD is asleep. */
  setAwake(on: boolean): void {
    if (this.#disposed || this.#awake === on) return;
    this.#awake = on;
    this.#tracker.classList.toggle("awake", on);
    this.#tracker.setAttribute("aria-hidden", String(!on));
    if (!on) {
      this.#milestoneRemaining = 0;
      this.#banner.classList.remove("show");
      this.#banner.setAttribute("aria-hidden", "true");
    }
    this.#syncPrompt();
  }

  /** Persistent proximity prompt. Pass null to dismiss it. */
  setPrompt(text: string | null, key = interactKeyLabel()): void {
    if (this.#disposed) return;
    this.#promptText = text?.trim() || null;
    this.#promptKey.textContent = key;
    if (this.#promptText) this.#promptCopy.textContent = this.#promptText;
    this.#syncPrompt();
  }

  /** Atomic state push for the normal Experience update path. */
  setTracker(view: AfterlightTrackerView): void {
    this.setState(view.state, view.objective);
    this.setProgress(view.collected);
    this.setCountdown(view.remainingSeconds ?? null);
  }

  setState(state: AfterlightUIState, objective?: string): void {
    if (this.#disposed) return;
    this.#state = state;
    this.#tracker.dataset.state = state;
    this.#objective.textContent = objective?.trim() || DEFAULT_OBJECTIVE[state];
    this.#syncNextEcho();
  }

  /** Update all five glyphs from a count or an explicit gathered mask. */
  setProgress(collected: number | readonly boolean[]): void {
    if (this.#disposed) return;
    const flags = Array.isArray(collected)
      ? Array.from({ length: ECHO_COUNT }, (_, i) => Boolean(collected[i]))
      : Array.from({ length: ECHO_COUNT }, (_, i) => i < clampCount(collected as number));
    let count = 0;
    this.#echoes.forEach((echo, i) => {
      const on = flags[i];
      if (on) count++;
      echo.classList.toggle("collected", on);
    });
    this.#count.textContent = `${count}/${ECHO_COUNT}`;
    this.#progress.setAttribute("aria-valuenow", String(count));
    this.#progress.setAttribute("aria-valuetext", `${count} of ${ECHO_COUNT} echoes gathered`);
    this.#syncNextEcho();
  }

  /** Fixed-width MM:SS. Null renders --:-- without moving the layout. */
  setCountdown(remainingSeconds: number | null): void {
    if (this.#disposed) return;
    const formatted = formatCountdown(remainingSeconds);
    if (formatted.text !== this.#countdownText) {
      this.#countdownText = formatted.text;
      this.#clock.textContent = formatted.text;
      this.#clock.setAttribute("aria-label", formatted.label);
    }
    this.#clock.classList.toggle("dormant", remainingSeconds == null || !Number.isFinite(remainingSeconds));
  }

  /** Transient feedback banner. Expiry is driven by update(dt), not wall time. */
  showMilestone(title: string, options: AfterlightMilestoneOptions = {}): void {
    if (this.#disposed || !title.trim()) return;
    this.#bannerKicker.textContent = options.eyebrow?.trim() || "Afterlight";
    this.#bannerTitle.textContent = title;
    this.#bannerDetail.textContent = options.detail?.trim() || "";
    this.#banner.dataset.tone = options.tone ?? "brass";
    this.#milestoneRemaining = Math.max(0.1, options.seconds ?? 1.8);
    // Restart the rare event transition if a second echo lands before the first
    // banner has fully left. This layout read happens only on milestone events.
    this.#banner.classList.remove("show");
    void this.#banner.offsetWidth;
    this.#banner.classList.toggle("show", this.#awake);
    this.#banner.setAttribute("aria-hidden", String(!this.#awake));
  }

  /** Per-frame deterministic housekeeping for milestone expiry. */
  update(dt: number): void {
    if (this.#disposed || this.#milestoneRemaining <= 0) return;
    this.#milestoneRemaining -= Number.isFinite(dt) ? Math.max(0, dt) : 0;
    if (this.#milestoneRemaining <= 0) {
      this.#milestoneRemaining = 0;
      this.#banner.classList.remove("show");
      this.#banner.setAttribute("aria-hidden", "true");
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tracker.remove();
    this.#prompt.remove();
    this.#banner.remove();
    this.#releaseStyle();
  }

  #syncPrompt(): void {
    const shown = this.#awake && this.#promptText !== null;
    this.#prompt.classList.toggle("show", shown);
    this.#prompt.setAttribute("aria-hidden", String(!shown));
  }

  #syncNextEcho(): void {
    let assigned = false;
    for (const echo of this.#echoes) {
      const next = this.#state === "active" && !assigned && !echo.classList.contains("collected");
      echo.classList.toggle("next", next);
      if (next) assigned = true;
    }
  }
}
