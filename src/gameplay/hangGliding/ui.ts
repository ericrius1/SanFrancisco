export type HangGlidingHudFrame = Readonly<{
  gate: number;
  gateCount: number;
  seconds: number;
  score: number;
  airspeed: number;
  altitude: number;
  verticalSpeed: number;
  lift: number;
  stalled: boolean;
}>;

export type HangGlidingResult = Readonly<{
  success: boolean;
  rank: "S" | "A" | "B" | "C";
  score: number;
  accuracy: number;
  touchdownSink: number;
  seconds: number;
  detail: string;
}>;

const STYLE = `
#hud .hg-objective,
#hud .hg-score,
#hud .hg-instruments,
#hud .hg-prompt,
#hud .hg-event,
#hud .hg-result {
  --hg-ink: #f8efd7;
  --hg-gold: #f2c45e;
  --hg-coral: #e65b46;
  --hg-teal: #79dac3;
  font-family: var(--font);
  color: var(--hg-ink);
  pointer-events: none;
  position: absolute;
  z-index: var(--z-hud-top);
  box-sizing: border-box;
}
#hud .hg-objective,
#hud .hg-score,
#hud .hg-instruments,
#hud .hg-prompt {
  background: linear-gradient(145deg, rgba(14, 28, 37, .92), rgba(28, 42, 47, .82));
  border: 1px solid rgba(242, 196, 94, .4);
  box-shadow: 0 12px 28px rgba(4, 11, 16, .28), inset 0 1px rgba(255,255,255,.08);
  backdrop-filter: blur(8px);
}
#hud .hg-objective {
  top: max(18px, env(safe-area-inset-top));
  left: max(18px, env(safe-area-inset-left));
  width: min(340px, calc(100vw - 36px));
  padding: 13px 15px 12px;
  border-radius: 4px 18px 4px 4px;
  transform: translateY(-12px);
  opacity: 0;
  transition: opacity .22s ease, transform .22s ease;
}
#hud .hg-objective.show { opacity: 1; transform: translateY(0); }
#hud .hg-kicker,
#hud .hg-score-label,
#hud .hg-instrument-label,
#hud .hg-result-kicker {
  color: var(--hg-gold);
  font-size: 11px;
  font-weight: 760;
  letter-spacing: .14em;
  line-height: 1;
  text-transform: uppercase;
}
#hud .hg-objective-row { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-top: 7px; }
#hud .hg-objective-copy { font-size: 20px; font-weight: 620; line-height: 1; white-space: nowrap; }
#hud .hg-time,
#hud .hg-score-value,
#hud .hg-instrument-value {
  font-variant-numeric: tabular-nums;
  font-feature-settings: "tnum";
}
#hud .hg-time { color: #fff7df; min-width: 58px; text-align: right; font-size: 18px; line-height: 1; }
#hud .hg-gates { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; margin-top: 11px; }
#hud .hg-gate { height: 4px; border-radius: 9px; background: rgba(255,255,255,.16); overflow: hidden; }
#hud .hg-gate::after { content: ""; display: block; width: 0; height: 100%; background: var(--hg-teal); box-shadow: 0 0 8px var(--hg-teal); transition: width .24s ease; }
#hud .hg-gate.hit::after { width: 100%; }
#hud .hg-gate.next { outline: 1px solid rgba(242,196,94,.9); outline-offset: 2px; }
#hud .hg-score {
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  min-width: 148px;
  padding: 11px 14px 10px;
  border-radius: 16px 4px 4px 4px;
  text-align: right;
  opacity: 0;
  transform: translateY(-12px);
  transition: opacity .22s ease, transform .22s ease;
}
#hud .hg-score.show { opacity: 1; transform: translateY(0); }
#hud .hg-score-value { color: #fff7df; font-size: 28px; font-weight: 700; line-height: 1; margin-top: 5px; min-width: 104px; }
#hud .hg-instruments {
  left: 50%;
  bottom: max(24px, calc(env(safe-area-inset-bottom) + 14px));
  transform: translate(-50%, 12px);
  display: grid;
  grid-template-columns: repeat(3, 92px);
  gap: 1px;
  padding: 8px;
  border-radius: 22px 22px 5px 5px;
  opacity: 0;
  transition: opacity .22s ease, transform .22s ease;
}
#hud .hg-instruments.show { opacity: 1; transform: translate(-50%, 0); }
#hud .hg-instrument { min-width: 0; padding: 4px 8px 5px; text-align: center; border-right: 1px solid rgba(255,255,255,.12); }
#hud .hg-instrument:last-child { border-right: 0; }
#hud .hg-instrument-value { display: block; margin-top: 5px; color: #fff8e8; font-size: 22px; font-weight: 690; line-height: 1; min-width: 64px; }
#hud .hg-instrument-unit { margin-left: 2px; color: rgba(248,239,215,.62); font-size: 9px; letter-spacing: .08em; text-transform: uppercase; }
#hud .hg-vario.rise { color: var(--hg-teal); }
#hud .hg-vario.sink { color: #ffc168; }
#hud .hg-prompt {
  left: 50%;
  bottom: max(126px, calc(env(safe-area-inset-bottom) + 112px));
  transform: translate(-50%, 8px);
  display: flex;
  align-items: center;
  gap: 9px;
  max-width: min(520px, calc(100vw - 28px));
  padding: 9px 13px 9px 10px;
  border-radius: 999px;
  opacity: 0;
  transition: opacity .18s ease, transform .18s ease;
}
#hud .hg-prompt.show { opacity: 1; transform: translate(-50%, 0); }
#hud .hg-key { display: grid; place-items: center; width: 30px; height: 30px; flex: 0 0 30px; color: #1d2a2f; background: var(--hg-gold); border-radius: 50%; font-size: 15px; font-weight: 800; }
#hud .hg-prompt-copy { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; font-weight: 610; }
#hud .hg-event {
  top: 26%;
  left: 50%;
  transform: translate(-50%, -8px) scale(.96);
  padding: 8px 18px;
  color: #fff8e3;
  background: rgba(20, 38, 43, .74);
  border-top: 1px solid rgba(242,196,94,.65);
  border-bottom: 1px solid rgba(242,196,94,.65);
  font-size: 18px;
  font-weight: 730;
  letter-spacing: .08em;
  text-align: center;
  text-transform: uppercase;
  opacity: 0;
}
#hud .hg-event.show { animation: hg-event 1.3s ease both; }
#hud .hg-event.danger { color: #fff0d1; border-color: var(--hg-coral); background: rgba(83,30,24,.78); }
@keyframes hg-event { 0% { opacity: 0; transform: translate(-50%,-8px) scale(.96); } 16%,72% { opacity: 1; transform: translate(-50%,0) scale(1); } 100% { opacity: 0; transform: translate(-50%,6px) scale(1); } }
#hud .hg-result {
  top: 50%;
  left: 50%;
  width: min(440px, calc(100vw - 32px));
  padding: 22px 24px 19px;
  transform: translate(-50%, -46%) scale(.96);
  color: var(--hg-ink);
  background: linear-gradient(150deg, rgba(17,32,40,.99), rgba(39,48,47,.985));
  border: 1px solid rgba(242,196,94,.58);
  border-radius: 5px 30px 5px 5px;
  box-shadow: 0 24px 80px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.1);
  opacity: 0;
  transition: opacity .28s ease, transform .28s cubic-bezier(.2,.8,.2,1);
}
#hud .hg-result.show { opacity: 1; transform: translate(-50%, -50%) scale(1); }
#hud .hg-result-head { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 20px; }
#hud .hg-result-title { margin-top: 8px; font-size: clamp(27px, 4vw, 38px); font-weight: 720; line-height: .98; }
#hud .hg-rank { display: grid; place-items: center; width: 76px; height: 76px; color: #1c2a2d; background: var(--hg-gold); border-radius: 50% 50% 50% 14%; font-size: 46px; font-weight: 800; line-height: 1; box-shadow: 0 0 28px rgba(242,196,94,.28); }
#hud .hg-result.fail .hg-rank { background: var(--hg-coral); color: #fff4df; }
#hud .hg-result-detail { margin-top: 11px; color: rgba(248,239,215,.78); font-size: 16px; line-height: 1.3; }
#hud .hg-result-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; margin-top: 17px; overflow: hidden; border: 1px solid rgba(255,255,255,.12); border-radius: 4px; }
#hud .hg-result-stat { padding: 9px 6px; text-align: center; background: rgba(255,255,255,.035); }
#hud .hg-result-stat b { display: block; font-size: 19px; font-variant-numeric: tabular-nums; }
#hud .hg-result-stat small { display: block; margin-top: 2px; color: rgba(248,239,215,.54); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
#hud .hg-result-retry { margin-top: 15px; color: var(--hg-gold); font-size: 13px; font-weight: 650; letter-spacing: .04em; text-align: center; }
#hud.hang-gliding-context .help,
#hud.hang-gliding-context .toolbar,
#hud.hang-gliding-context .audio,
#hud.hang-gliding-context .chat,
#hud.hang-gliding-context .minimap,
#hud.hang-gliding-context .place-history,
#hud.hang-gliding-context .avatar-ui,
#hud.hang-gliding-context .satchel,
#hud.hang-gliding-context .share-ui,
#hud.hang-gliding-context .tutorial-ui,
#hud.hang-gliding-context .tutorial-panel,
#hud.hang-gliding-context .links-ui,
#hud.hang-gliding-context .wake-city-ui,
#hud.hang-gliding-context .minigame-exit,
#hud.hang-gliding-context .player-locator,
#hud.hang-gliding-context .throw-meter { opacity: 0 !important; pointer-events: none !important; }
#hud.faded .hg-objective,
#hud.faded .hg-score,
#hud.faded .hg-instruments,
#hud.faded .hg-prompt,
#hud.faded .hg-event,
#hud.faded .hg-result { opacity: 0 !important; }
@media (max-width: 700px) {
  #hud .hg-objective { top: max(10px, env(safe-area-inset-top)); left: max(10px, env(safe-area-inset-left)); width: min(270px, calc(100vw - 106px)); padding: 10px 11px; }
  #hud .hg-objective-copy { font-size: 15px; }
  #hud .hg-kicker { font-size: 9px; }
  #hud .hg-time { min-width: 46px; font-size: 15px; }
  #hud .hg-score { top: max(10px, env(safe-area-inset-top)); right: max(10px, env(safe-area-inset-right)); min-width: 84px; padding: 9px 10px; }
  #hud .hg-score { width: 84px; }
  #hud .hg-score-label { font-size: 0; }
  #hud .hg-score-label::after { content: "score"; font-size: 9px; }
  #hud .hg-score-value { min-width: 0; font-size: 20px; }
  #hud .hg-instruments { grid-template-columns: repeat(3, minmax(68px, 82px)); bottom: max(12px, calc(env(safe-area-inset-bottom) + 8px)); }
  #hud .hg-instrument { padding-inline: 4px; }
  #hud .hg-instrument-value { min-width: 52px; font-size: 18px; }
  #hud .hg-instrument-label { font-size: 8px; }
  #hud .hg-prompt { bottom: max(92px, calc(env(safe-area-inset-bottom) + 84px)); }
  #hud .hg-result { padding: 18px 18px 16px; }
  #hud .hg-rank { width: 62px; height: 62px; font-size: 38px; }
}
@media (max-height: 520px) {
  #hud .hg-prompt { display: none; }
  #hud .hg-instruments { bottom: max(6px, env(safe-area-inset-bottom)); }
  #hud .hg-result { top: 53%; padding-block: 14px; }
  #hud .hg-result-detail { margin-top: 7px; }
  #hud .hg-result-stats { margin-top: 10px; }
}
@media (prefers-reduced-motion: reduce) {
  #hud .hg-objective, #hud .hg-score, #hud .hg-instruments, #hud .hg-prompt, #hud .hg-result { transition: none; }
  #hud .hg-event.show { animation-duration: .8s; }
}
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

export class HangGlidingUI {
  #objective = element("section", "hg-objective");
  #objectiveCopy = element("span", "hg-objective-copy");
  #time = element("span", "hg-time");
  #gateNodes: HTMLElement[] = [];
  #score = element("section", "hg-score");
  #scoreValue = element("div", "hg-score-value");
  #instruments = element("section", "hg-instruments");
  #speedValue!: HTMLElement;
  #altitudeValue!: HTMLElement;
  #varioValue!: HTMLElement;
  #prompt = element("div", "hg-prompt");
  #promptKey = element("span", "hg-key");
  #promptCopy = element("span", "hg-prompt-copy");
  #event = element("div", "hg-event");
  #result = element("section", "hg-result");
  #eventTimer: number | null = null;

  constructor() {
    const hud = document.querySelector<HTMLElement>("#hud");
    if (!hud) throw new Error("[hang-gliding-ui] #hud is unavailable");
    const style = document.createElement("style");
    style.dataset.hangGliding = "true";
    style.textContent = STYLE;
    document.head.append(style);

    const kicker = element("div", "hg-kicker");
    kicker.textContent = "Sutro Air Service · Skyline Glide";
    const row = element("div", "hg-objective-row");
    this.#objectiveCopy.textContent = "Thread gate 1 of 5";
    this.#time.textContent = "00:00";
    row.append(this.#objectiveCopy, this.#time);
    const gates = element("div", "hg-gates");
    for (let i = 0; i < 5; i++) {
      const gate = element("i", "hg-gate");
      this.#gateNodes.push(gate);
      gates.append(gate);
    }
    this.#objective.append(kicker, row, gates);

    const scoreLabel = element("div", "hg-score-label");
    scoreLabel.textContent = "Flight score";
    this.#scoreValue.textContent = "000000";
    this.#score.append(scoreLabel, this.#scoreValue);

    const instrument = (label: string, unit: string): HTMLElement => {
      const wrap = element("div", "hg-instrument");
      const name = element("span", "hg-instrument-label");
      name.textContent = label;
      const value = element("span", "hg-instrument-value");
      value.textContent = "000";
      const suffix = element("small", "hg-instrument-unit");
      suffix.textContent = unit;
      value.append(suffix);
      wrap.append(name, value);
      this.#instruments.append(wrap);
      return value;
    };
    this.#speedValue = instrument("Airspeed", "kt");
    this.#altitudeValue = instrument("Altitude", "m");
    this.#varioValue = instrument("Vario", "m/s");
    this.#varioValue.classList.add("hg-vario");

    this.#prompt.append(this.#promptKey, this.#promptCopy);
    this.#result.setAttribute("aria-live", "polite");
    hud.append(this.#objective, this.#score, this.#instruments, this.#prompt, this.#event, this.#result);
  }

  setPrompt(key: string | null, copy = ""): void {
    const show = Boolean(key && copy);
    this.#promptKey.textContent = key ?? "";
    this.#promptCopy.textContent = copy;
    this.#prompt.classList.toggle("show", show);
  }

  begin(): void {
    document.querySelector("#hud")?.classList.add("hang-gliding-context");
    this.#objective.classList.add("show");
    this.#score.classList.add("show");
    this.#instruments.classList.add("show");
    this.#result.classList.remove("show", "fail");
    this.#result.replaceChildren();
    this.setPrompt(null);
    this.update({
      gate: 0,
      gateCount: 5,
      seconds: 0,
      score: 0,
      airspeed: 22,
      altitude: 252,
      verticalSpeed: -0.8,
      lift: 0,
      stalled: false
    });
  }

  update(frame: HangGlidingHudFrame): void {
    this.#objectiveCopy.textContent = frame.gate < frame.gateCount
      ? `Thread gate ${frame.gate + 1} of ${frame.gateCount}`
      : "Settle onto the landing mark";
    const minutes = Math.floor(frame.seconds / 60);
    const seconds = Math.floor(frame.seconds % 60);
    this.#time.textContent = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    this.#scoreValue.textContent = Math.round(frame.score).toString().padStart(6, "0");
    this.#speedValue.firstChild!.textContent = Math.round(frame.airspeed * 1.94384).toString().padStart(3, "0");
    this.#altitudeValue.firstChild!.textContent = Math.round(frame.altitude).toString().padStart(3, "0");
    const vario = frame.verticalSpeed;
    this.#varioValue.firstChild!.textContent = `${vario >= 0 ? "+" : ""}${vario.toFixed(1)}`;
    this.#varioValue.classList.toggle("rise", vario > 0.25 || frame.lift > 1);
    this.#varioValue.classList.toggle("sink", vario < -2.4);
    for (let i = 0; i < this.#gateNodes.length; i++) {
      this.#gateNodes[i].classList.toggle("hit", i < frame.gate);
      this.#gateNodes[i].classList.toggle("next", i === frame.gate);
    }
    if (frame.stalled) this.showEvent("STALL · lower the nose", true, 0.72);
  }

  showEvent(copy: string, danger = false, seconds = 1.3): void {
    if (this.#eventTimer !== null) window.clearTimeout(this.#eventTimer);
    this.#event.textContent = copy;
    this.#event.classList.remove("show");
    this.#event.classList.toggle("danger", danger);
    void this.#event.offsetWidth;
    this.#event.classList.add("show");
    this.#eventTimer = window.setTimeout(() => {
      this.#eventTimer = null;
      this.#event.classList.remove("show");
    }, seconds * 1000);
  }

  finish(result: HangGlidingResult, key: string): void {
    this.#objective.classList.remove("show");
    this.#score.classList.remove("show");
    this.#instruments.classList.remove("show");
    this.setPrompt(null);
    this.#result.classList.toggle("fail", !result.success);
    const head = element("div", "hg-result-head");
    const copy = element("div", "hg-result-copy");
    const kicker = element("div", "hg-result-kicker");
    kicker.textContent = result.success ? "Flight evaluation" : "Course incomplete";
    const title = element("div", "hg-result-title");
    title.textContent = result.success ? "Skyline cleared" : "Back into the wind";
    copy.append(kicker, title);
    const rank = element("div", "hg-rank");
    rank.textContent = result.rank;
    head.append(copy, rank);
    const detail = element("div", "hg-result-detail");
    detail.textContent = result.detail;
    const stats = element("div", "hg-result-stats");
    for (const [value, label] of [
      [result.score.toString().padStart(6, "0"), "score"],
      [`${Math.round(result.accuracy)} m`, "target"],
      [`${result.touchdownSink.toFixed(1)} m/s`, "touchdown"]
    ]) {
      const stat = element("div", "hg-result-stat");
      const strong = document.createElement("b");
      strong.textContent = value;
      const small = document.createElement("small");
      small.textContent = label;
      stat.append(strong, small);
      stats.append(stat);
    }
    const retry = element("div", "hg-result-retry");
    retry.textContent = `${key} — fly the Skyline Glide again`;
    this.#result.replaceChildren(head, detail, stats, retry);
    this.#result.classList.add("show");
  }

  hide(): void {
    document.querySelector("#hud")?.classList.remove("hang-gliding-context");
    this.#objective.classList.remove("show");
    this.#score.classList.remove("show");
    this.#instruments.classList.remove("show");
    this.#result.classList.remove("show", "fail");
    this.setPrompt(null);
  }

  dispose(): void {
    this.hide();
    if (this.#eventTimer !== null) window.clearTimeout(this.#eventTimer);
    document.querySelector("style[data-hang-gliding]")?.remove();
    this.#objective.remove();
    this.#score.remove();
    this.#instruments.remove();
    this.#prompt.remove();
    this.#event.remove();
    this.#result.remove();
  }
}
