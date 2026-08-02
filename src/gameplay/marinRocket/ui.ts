import type { RocketFlightTelemetry } from "../../vehicles/plane";

const STYLE = `
#hud .mr-panel, #hud .mr-prompt, #hud .mr-event {
  --mr-cyan: #7fe8ff;
  --mr-gold: #ffc862;
  position: absolute;
  z-index: var(--z-hud-top);
  box-sizing: border-box;
  color: #edfaff;
  font-family: var(--font);
  pointer-events: none;
}
#hud .mr-panel {
  top: max(18px, env(safe-area-inset-top));
  left: 50%;
  width: min(360px, calc(100vw - 36px));
  padding: 14px 16px 13px;
  border: 1px solid rgba(127,232,255,.42);
  border-radius: 5px 24px 5px 5px;
  background: linear-gradient(145deg, rgba(6,20,35,.94), rgba(18,41,54,.84));
  box-shadow: 0 16px 42px rgba(0,0,0,.34), inset 0 1px rgba(255,255,255,.09);
  backdrop-filter: blur(9px);
  opacity: 0;
  transform: translate(-50%,-12px);
  transition: opacity .2s ease, transform .2s ease;
}
#hud .mr-panel.show { opacity: 1; transform: translate(-50%,0); }
#hud .mr-kicker { color: var(--mr-gold); font-size: 10px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
#hud .mr-stage { margin-top: 6px; font-size: 21px; font-weight: 720; letter-spacing: .02em; text-transform: uppercase; }
#hud .mr-readouts { display: grid; grid-template-columns: repeat(3,1fr); gap: 1px; margin-top: 12px; border: 1px solid rgba(255,255,255,.12); border-radius: 4px; overflow: hidden; }
#hud .mr-readout { padding: 8px 7px; text-align: center; background: rgba(255,255,255,.035); }
#hud .mr-readout b { display: block; color: #fff; font-size: 19px; font-variant-numeric: tabular-nums; }
#hud .mr-readout small { display: block; margin-top: 2px; color: rgba(220,242,250,.58); font-size: 9px; letter-spacing: .1em; text-transform: uppercase; }
#hud .mr-throttle { height: 4px; margin-top: 11px; overflow: hidden; border-radius: 8px; background: rgba(255,255,255,.12); }
#hud .mr-throttle > i { display: block; height: 100%; width: 0; background: linear-gradient(90deg,var(--mr-cyan),var(--mr-gold)); box-shadow: 0 0 12px var(--mr-cyan); transition: width .08s linear; }
#hud .mr-controls { margin-top: 9px; color: rgba(231,247,252,.68); font-size: 11px; line-height: 1.35; }
#hud .mr-prompt {
  left: 50%; bottom: max(118px, calc(env(safe-area-inset-bottom) + 104px));
  display: flex; align-items: center; gap: 9px;
  max-width: min(560px, calc(100vw - 28px)); padding: 9px 14px 9px 10px;
  border: 1px solid rgba(127,232,255,.4); border-radius: 999px;
  background: rgba(6,22,36,.9); box-shadow: 0 10px 30px rgba(0,0,0,.3);
  transform: translate(-50%,8px); opacity: 0; transition: opacity .18s ease, transform .18s ease;
}
#hud .mr-prompt.show { opacity: 1; transform: translate(-50%,0); }
#hud .mr-key { display:grid;place-items:center;width:30px;height:30px;flex:0 0 30px;border-radius:50%;background:var(--mr-gold);color:#172535;font-size:14px;font-weight:850; }
#hud .mr-prompt-copy { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:15px;font-weight:630; }
#hud .mr-event { top: 25%; left: 50%; padding: 8px 20px; transform: translate(-50%,-8px); border-block: 1px solid var(--mr-cyan); background: rgba(5,24,39,.78); font-size: 18px; font-weight: 780; letter-spacing: .12em; text-transform: uppercase; opacity: 0; }
#hud .mr-event.show { animation: mr-event 1.65s ease both; }
@keyframes mr-event { 0%{opacity:0;transform:translate(-50%,-10px)} 14%,72%{opacity:1;transform:translate(-50%,0)} 100%{opacity:0;transform:translate(-50%,7px)} }
@media (max-width:680px) { #hud .mr-panel{width:min(330px,calc(100vw - 24px));top:12px}#hud .mr-controls{display:none} }
`;

const STAGE_LABEL: Record<RocketFlightTelemetry["stage"], string> = {
  launch: "Powered ascent",
  stratosphere: "Stratosphere",
  edge: "Edge of space",
  orbit: "Low orbit",
  "deep-space": "Deep space"
};

export class MarinRocketUI {
  #style: HTMLStyleElement;
  #panel: HTMLElement;
  #stage: HTMLElement;
  #altitude: HTMLElement;
  #speed: HTMLElement;
  #vertical: HTMLElement;
  #throttle: HTMLElement;
  #prompt: HTMLElement;
  #promptKey: HTMLElement;
  #promptCopy: HTMLElement;
  #event: HTMLElement;

  constructor() {
    this.#style = document.createElement("style");
    this.#style.dataset.marinRocket = "true";
    this.#style.textContent = STYLE;
    document.head.appendChild(this.#style);
    const hud = document.getElementById("hud")!;
    this.#panel = document.createElement("div");
    this.#panel.className = "mr-panel";
    this.#panel.innerHTML = `
      <div class="mr-kicker">Marin Orbital · Starjet telemetry</div>
      <div class="mr-stage">Powered ascent</div>
      <div class="mr-readouts">
        <div class="mr-readout"><b data-mr="alt">0.0</b><small>altitude km</small></div>
        <div class="mr-readout"><b data-mr="speed">0</b><small>speed m/s</small></div>
        <div class="mr-readout"><b data-mr="vertical">+0</b><small>vertical m/s</small></div>
      </div>
      <div class="mr-throttle"><i></i></div>
      <div class="mr-controls">Mouse aims the nose · A/D banks · W/S sets thrust · Shift engages the main drive · E returns to Marin</div>`;
    this.#stage = this.#panel.querySelector(".mr-stage")!;
    this.#altitude = this.#panel.querySelector('[data-mr="alt"]')!;
    this.#speed = this.#panel.querySelector('[data-mr="speed"]')!;
    this.#vertical = this.#panel.querySelector('[data-mr="vertical"]')!;
    this.#throttle = this.#panel.querySelector(".mr-throttle > i")!;
    this.#prompt = document.createElement("div");
    this.#prompt.className = "mr-prompt";
    this.#prompt.innerHTML = `<span class="mr-key"></span><span class="mr-prompt-copy"></span>`;
    this.#promptKey = this.#prompt.querySelector(".mr-key")!;
    this.#promptCopy = this.#prompt.querySelector(".mr-prompt-copy")!;
    this.#event = document.createElement("div");
    this.#event.className = "mr-event";
    hud.append(this.#panel, this.#prompt, this.#event);
  }

  begin(): void {
    this.#panel.classList.add("show");
  }

  update(telemetry: Readonly<RocketFlightTelemetry>): void {
    this.#stage.textContent = STAGE_LABEL[telemetry.stage];
    this.#altitude.textContent = (telemetry.altitude / 1_000).toFixed(1);
    this.#speed.textContent = Math.round(telemetry.speed).toLocaleString();
    this.#vertical.textContent = `${telemetry.verticalSpeed >= 0 ? "+" : ""}${Math.round(telemetry.verticalSpeed)}`;
    this.#throttle.style.width = `${Math.round(telemetry.throttle * 100)}%`;
  }

  setPrompt(key: string | null, copy = ""): void {
    this.#prompt.classList.toggle("show", !!key);
    if (!key) return;
    this.#promptKey.textContent = key;
    this.#promptCopy.textContent = copy;
  }

  showEvent(copy: string): void {
    this.#event.textContent = copy;
    this.#event.classList.remove("show");
    void this.#event.offsetWidth;
    this.#event.classList.add("show");
  }

  hideFlight(): void {
    this.#panel.classList.remove("show");
    this.#event.classList.remove("show");
  }

  dispose(): void {
    this.#panel.remove();
    this.#prompt.remove();
    this.#event.remove();
    this.#style.remove();
  }
}
