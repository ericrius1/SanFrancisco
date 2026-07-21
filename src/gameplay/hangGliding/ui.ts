import {
  DEFAULT_HANG_GLIDER_STYLE,
  HANG_GLIDER_FRAMES,
  HANG_GLIDER_PALETTES,
  HANG_GLIDER_SLIDERS,
  normalizeHangGliderStyle,
  type HangGliderStyle,
  type HangGliderSliderKey
} from "./style";

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
#hud .hg-customizer {
  --hg-ink: #f8efd7;
  --hg-gold: #f2c45e;
  --hg-coral: #e65b46;
  --hg-teal: #79dac3;
  --hg-panel: rgba(11, 28, 36, .96);
  position: absolute;
  top: max(82px, calc(env(safe-area-inset-top) + 70px));
  right: max(18px, env(safe-area-inset-right));
  z-index: var(--z-hud-raised);
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  color: var(--hg-ink);
  font-family: var(--font);
  pointer-events: none;
  opacity: 0;
  transform: translateX(12px);
  transition: opacity .2s ease, transform .2s ease;
}
#hud .hg-customizer.show { pointer-events: auto; opacity: 1; transform: translateX(0); }
#hud .hg-customizer-toggle {
  position: relative;
  display: grid;
  place-items: center;
  width: 50px;
  height: 50px;
  padding: 0;
  color: #eaf9f1;
  cursor: pointer;
  border: 1px solid rgba(121,218,195,.45);
  border-radius: 18px 5px 18px 18px;
  background: linear-gradient(145deg, rgba(16,48,54,.97), rgba(11,27,37,.94));
  box-shadow: 0 12px 28px rgba(2,9,15,.32), inset 0 1px rgba(255,255,255,.1);
  transition: transform .15s ease, border-color .15s ease, background .15s ease;
}
#hud .hg-customizer-toggle:hover,
#hud .hg-customizer.open .hg-customizer-toggle {
  transform: translateY(-1px);
  border-color: var(--hg-gold);
  background: linear-gradient(145deg, rgba(32,67,64,.98), rgba(13,32,41,.96));
}
#hud .hg-customizer button:focus-visible,
#hud .hg-customizer input:focus-visible { outline: 2px solid var(--hg-gold); outline-offset: 2px; }
#hud .hg-customizer button:active { transform: translateY(1px) scale(.98); }
#hud .hg-customizer-toggle svg { width: 35px; height: 27px; overflow: visible; filter: drop-shadow(0 3px 4px rgba(0,0,0,.38)); }
#hud .hg-customizer-key {
  position: absolute;
  right: -4px;
  bottom: -4px;
  display: grid;
  place-items: center;
  width: 19px;
  height: 19px;
  color: #1b2a2e;
  background: var(--hg-gold);
  border-radius: 50%;
  font: 800 10px/1 var(--font);
  box-shadow: 0 2px 7px rgba(0,0,0,.28);
}
#hud .hg-customizer-panel {
  display: none;
  box-sizing: border-box;
  width: min(366px, calc(100vw - 28px));
  max-height: calc(100dvh - 154px);
  overflow: auto;
  overscroll-behavior: contain;
  padding: 13px;
  border: 1px solid rgba(121,218,195,.3);
  border-radius: 20px 5px 20px 20px;
  background:
    radial-gradient(circle at 96% 2%, rgba(242,196,94,.11), transparent 35%),
    linear-gradient(150deg, rgba(16,42,49,.97), var(--hg-panel));
  box-shadow: 0 22px 58px rgba(2,8,13,.52), inset 0 1px rgba(255,255,255,.08);
  scrollbar-gutter: stable;
  touch-action: pan-y;
}
#hud .hg-customizer.open .hg-customizer-panel { display: grid; gap: 10px; animation: hg-customizer-in .18s ease both; }
@keyframes hg-customizer-in { from { opacity: 0; transform: translateY(-6px) scale(.98); } }
#hud .hg-customizer-head { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 12px; padding: 1px 1px 8px; border-bottom: 1px solid rgba(255,255,255,.11); }
#hud .hg-customizer-title { color: #f8efd7; font-size: 17px; font-weight: 720; line-height: 1; }
#hud .hg-customizer-subtitle { margin-top: 4px; color: rgba(248,239,215,.54); font-size: 9px; font-weight: 680; letter-spacing: .1em; text-transform: uppercase; }
#hud .hg-customizer-live { display: flex; align-items: center; gap: 5px; color: var(--hg-teal); font-size: 9px; font-weight: 760; letter-spacing: .09em; text-transform: uppercase; }
#hud .hg-customizer-live::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--hg-teal); box-shadow: 0 0 9px var(--hg-teal); animation: hg-live 1.5s ease-in-out infinite; }
@keyframes hg-live { 50% { opacity: .42; } }
#hud .hg-customizer-section { display: grid; gap: 6px; }
#hud .hg-customizer-label { color: rgba(248,239,215,.62); font-size: 9px; font-weight: 760; letter-spacing: .12em; text-transform: uppercase; }
#hud .hg-customizer-palettes { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; }
#hud .hg-palette-choice {
  position: relative;
  min-width: 0;
  min-height: 44px;
  padding: 25px 4px 4px;
  overflow: hidden;
  color: rgba(255,255,255,.8);
  cursor: pointer;
  border: 1px solid rgba(255,255,255,.15);
  border-radius: 9px;
  font: 700 9px/1 var(--font);
  text-shadow: 0 1px 4px rgba(0,0,0,.72);
  box-shadow: inset 0 -18px 18px rgba(0,0,0,.28);
}
#hud .hg-palette-choice.on { outline: 2px solid var(--hg-gold); outline-offset: 1px; color: white; }
#hud .hg-customizer-frames { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
#hud .hg-frame-choice {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 44px;
  color: rgba(248,239,215,.72);
  cursor: pointer;
  border: 1px solid rgba(255,255,255,.13);
  border-radius: 8px;
  background: rgba(4,13,18,.38);
  font: 680 10px/1 var(--font);
}
#hud .hg-frame-choice::before { content: ""; width: 13px; height: 13px; border: 1px solid rgba(255,255,255,.28); border-radius: 50%; background: var(--hg-frame-color); box-shadow: inset 0 1px rgba(255,255,255,.24); }
#hud .hg-frame-choice.on { color: #fff7df; border-color: var(--hg-teal); background: rgba(58,119,108,.16); }
#hud .hg-customizer-sliders { display: grid; gap: 4px; }
#hud .hg-slider-row { display: grid; grid-template-columns: 52px minmax(0,1fr) 38px; align-items: center; gap: 8px; min-height: 34px; }
#hud .hg-slider-copy { min-width: 0; }
#hud .hg-slider-name { display: block; color: #f8efd7; font-size: 11px; font-weight: 680; }
#hud .hg-slider-hint { display: block; margin-top: 1px; overflow: hidden; color: rgba(248,239,215,.42); font-size: 7px; letter-spacing: .02em; white-space: nowrap; text-overflow: ellipsis; }
#hud .hg-slider-row input[type="range"] { width: 100%; min-height: 26px; margin: 0; cursor: ew-resize; accent-color: var(--hg-teal); }
#hud .hg-slider-row output { color: var(--hg-gold); font: 700 10px/1 var(--font-mono, monospace); text-align: right; font-variant-numeric: tabular-nums; }
#hud .hg-customizer-reset { min-height: 44px; color: rgba(248,239,215,.62); cursor: pointer; border: 1px solid rgba(255,255,255,.11); border-radius: 8px; background: rgba(4,13,18,.34); font: 680 10px/1 var(--font); letter-spacing: .04em; }
#hud .hg-customizer-reset:hover { color: #fff7df; border-color: rgba(242,196,94,.45); }
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
#hud.faded .hg-result,
#hud.faded .hg-customizer { opacity: 0 !important; pointer-events: none !important; }
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
  #hud .hg-customizer { top: max(70px, calc(env(safe-area-inset-top) + 62px)); right: max(10px, env(safe-area-inset-right)); }
  #hud .hg-customizer-panel { width: min(354px, calc(100vw - 20px)); max-height: calc(100dvh - 136px); padding: 11px; }
}
@media (max-height: 520px) {
  #hud .hg-prompt { display: none; }
  #hud .hg-instruments { bottom: max(6px, env(safe-area-inset-bottom)); }
  #hud .hg-result { top: 53%; padding-block: 14px; }
  #hud .hg-result-detail { margin-top: 7px; }
  #hud .hg-result-stats { margin-top: 10px; }
  #hud .hg-customizer { top: max(62px, calc(env(safe-area-inset-top) + 54px)); }
  #hud .hg-customizer-panel { max-height: calc(100dvh - 120px); }
}
@media (prefers-reduced-motion: reduce) {
  #hud .hg-objective, #hud .hg-score, #hud .hg-instruments, #hud .hg-prompt, #hud .hg-result, #hud .hg-customizer { transition: none; }
  #hud .hg-event.show { animation-duration: .8s; }
  #hud .hg-customizer-live::before { animation: none; }
}
`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

const cssColor = (value: number): string => `#${value.toString(16).padStart(6, "0")}`;

export type HangGlidingUIOptions = Readonly<{
  style: HangGliderStyle;
  onStyleChange: (style: HangGliderStyle) => void;
  onCustomizerOpen: () => void;
}>;

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
  #customizer = element("section", "hg-customizer");
  #customizerToggle = element("button", "hg-customizer-toggle");
  #customizerPanel = element("div", "hg-customizer-panel");
  #paletteButtons = new Map<string, HTMLButtonElement>();
  #frameButtons = new Map<string, HTMLButtonElement>();
  #sliderInputs = new Map<HangGliderSliderKey, HTMLInputElement>();
  #sliderOutputs = new Map<HangGliderSliderKey, HTMLOutputElement>();
  #style: HangGliderStyle;
  #onStyleChange: (style: HangGliderStyle) => void;
  #onCustomizerOpen: () => void;
  #customizerOpen = false;
  #eventTimer: number | null = null;

  constructor(options: HangGlidingUIOptions) {
    this.#style = normalizeHangGliderStyle(options.style);
    this.#onStyleChange = options.onStyleChange;
    this.#onCustomizerOpen = options.onCustomizerOpen;
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
    this.#buildCustomizer();
    hud.append(
      this.#objective,
      this.#score,
      this.#instruments,
      this.#prompt,
      this.#event,
      this.#result,
      this.#customizer
    );
  }

  #buildCustomizer(): void {
    this.#customizer.setAttribute("aria-label", "Skyline wing atelier");
    this.#customizerToggle.type = "button";
    this.#customizerToggle.title = "Open the in-flight wing atelier (K)";
    this.#customizerToggle.setAttribute("aria-label", "Open the in-flight wing atelier");
    this.#customizerToggle.setAttribute("aria-expanded", "false");
    this.#customizerToggle.innerHTML = `
      <svg viewBox="0 0 64 42" aria-hidden="true">
        <path d="M3 28 Q16 8 32 7 Q48 8 61 28 Q48 21 32 20 Q16 21 3 28Z" fill="rgba(121,218,195,.34)" stroke="currentColor" stroke-width="2"/>
        <path d="M7 28 Q20 17 32 20 Q44 17 57 28" fill="none" stroke="#f2c45e" stroke-width="2"/>
        <path d="M32 8V34M21 18L32 34L43 18" fill="none" stroke="currentColor" stroke-width="1.6" opacity=".8"/>
      </svg>
      <span class="hg-customizer-key">K</span>
    `;
    this.#customizerToggle.addEventListener("click", () => this.toggleCustomizer());

    const head = element("div", "hg-customizer-head");
    const heading = document.createElement("div");
    const title = element("div", "hg-customizer-title");
    title.textContent = "Skyline wing atelier";
    const subtitle = element("div", "hg-customizer-subtitle");
    subtitle.textContent = "Sail shaping · live flight preview";
    heading.append(title, subtitle);
    const live = element("span", "hg-customizer-live");
    live.textContent = "in wind";
    head.append(heading, live);

    const paletteSection = element("section", "hg-customizer-section");
    const paletteLabel = element("div", "hg-customizer-label");
    paletteLabel.textContent = "Canopy dye";
    const palettes = element("div", "hg-customizer-palettes");
    for (const palette of HANG_GLIDER_PALETTES) {
      const button = element("button", "hg-palette-choice");
      button.type = "button";
      button.textContent = palette.label;
      button.title = `${palette.label} canopy dye`;
      button.setAttribute("aria-label", `${palette.label} canopy dye`);
      button.style.background = `linear-gradient(135deg, ${palette.colors.map(cssColor).join(", ")})`;
      button.addEventListener("click", () => this.#commit({ palette: palette.id }));
      this.#paletteButtons.set(palette.id, button);
      palettes.append(button);
    }
    paletteSection.append(paletteLabel, palettes);

    const frameSection = element("section", "hg-customizer-section");
    const frameLabel = element("div", "hg-customizer-label");
    frameLabel.textContent = "Airframe finish";
    const frames = element("div", "hg-customizer-frames");
    for (const finish of HANG_GLIDER_FRAMES) {
      const button = element("button", "hg-frame-choice");
      button.type = "button";
      button.textContent = finish.label;
      button.style.setProperty("--hg-frame-color", cssColor(finish.color));
      button.addEventListener("click", () => this.#commit({ frame: finish.id }));
      this.#frameButtons.set(finish.id, button);
      frames.append(button);
    }
    frameSection.append(frameLabel, frames);

    const shapeSection = element("section", "hg-customizer-section");
    const shapeLabel = element("div", "hg-customizer-label");
    shapeLabel.textContent = "Wind shape";
    const sliders = element("div", "hg-customizer-sliders");
    for (const spec of HANG_GLIDER_SLIDERS) {
      const row = element("label", "hg-slider-row");
      const copy = element("span", "hg-slider-copy");
      const name = element("span", "hg-slider-name");
      name.textContent = spec.label;
      const hint = element("span", "hg-slider-hint");
      hint.textContent = spec.hint;
      copy.append(name, hint);
      const input = document.createElement("input");
      input.type = "range";
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.setAttribute("aria-label", `${spec.label}: ${spec.hint}`);
      const output = document.createElement("output");
      input.addEventListener("input", () => this.#commit({ [spec.key]: Number(input.value) }));
      this.#sliderInputs.set(spec.key, input);
      this.#sliderOutputs.set(spec.key, output);
      row.append(copy, input, output);
      sliders.append(row);
    }
    shapeSection.append(shapeLabel, sliders);

    const reset = element("button", "hg-customizer-reset");
    reset.type = "button";
    reset.textContent = "Reset the sail to Skyline trim";
    reset.addEventListener("click", () => this.#commit(DEFAULT_HANG_GLIDER_STYLE));

    this.#customizerPanel.append(head, paletteSection, frameSection, shapeSection, reset);
    this.#customizer.append(this.#customizerToggle, this.#customizerPanel);
    this.#syncCustomizerControls();
  }

  #commit(next: Partial<HangGliderStyle>): void {
    this.#style = normalizeHangGliderStyle({ ...this.#style, ...next });
    this.#syncCustomizerControls();
    this.#onStyleChange(this.#style);
  }

  #syncCustomizerControls(): void {
    for (const [id, button] of this.#paletteButtons) button.classList.toggle("on", id === this.#style.palette);
    for (const [id, button] of this.#frameButtons) button.classList.toggle("on", id === this.#style.frame);
    for (const spec of HANG_GLIDER_SLIDERS) {
      const value = this.#style[spec.key];
      const input = this.#sliderInputs.get(spec.key);
      const output = this.#sliderOutputs.get(spec.key);
      if (input) input.value = value.toFixed(2);
      if (output) output.textContent = `${Math.round(value * 100)}%`;
    }
  }

  toggleCustomizer(open = !this.#customizerOpen): void {
    this.#customizerOpen = open;
    this.#customizer.classList.toggle("open", open);
    this.#customizerToggle.setAttribute("aria-expanded", String(open));
    this.#customizerToggle.setAttribute(
      "aria-label",
      open ? "Close the in-flight wing atelier" : "Open the in-flight wing atelier"
    );
    if (open) this.#onCustomizerOpen();
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
    this.#customizer.classList.add("show");
    this.toggleCustomizer(false);
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
    this.#customizer.classList.remove("show");
    this.toggleCustomizer(false);
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
    this.#customizer.classList.remove("show");
    this.toggleCustomizer(false);
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
    this.#customizer.remove();
  }
}
