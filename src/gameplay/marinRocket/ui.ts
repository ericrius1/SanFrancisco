import type { RocketFlightTelemetry } from "../../vehicles/plane";
import type { CelestialNavigation } from "./solarSystem";
import { formatMissionTime } from "./route";

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
  width: min(430px, calc(100vw - 36px));
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
#hud .mr-nav { margin-top: 11px; padding-top: 10px; border-top: 1px solid rgba(127,232,255,.2); }
#hud .mr-target { display:flex;align-items:baseline;gap:8px; }
#hud .mr-target small { color:rgba(220,242,250,.55);font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase; }
#hud .mr-target b { color:var(--mr-gold);font-size:17px;letter-spacing:.04em;text-transform:uppercase; }
#hud .mr-target em { margin-left:auto;color:rgba(231,247,252,.72);font-size:10px;font-style:normal;font-variant-numeric:tabular-nums; }
#hud .mr-target-meta { display:flex;justify-content:space-between;margin-top:3px;color:rgba(231,247,252,.67);font-size:11px;font-variant-numeric:tabular-nums; }
#hud .mr-route { display:grid;grid-template-columns:repeat(5,1fr);gap:3px;margin-top:9px; }
#hud .mr-route-stop { padding:4px 2px;border:1px solid rgba(255,255,255,.1);border-radius:3px;color:rgba(219,237,245,.38);font-size:8px;font-weight:750;letter-spacing:.04em;text-align:center;text-transform:uppercase; }
#hud .mr-route-stop.home,#hud .mr-route-stop.visited { border-color:rgba(127,232,255,.32);color:rgba(170,240,255,.72);background:rgba(74,204,236,.08); }
#hud .mr-route-stop.target { border-color:rgba(255,200,98,.7);color:#ffe3a5;background:rgba(255,190,70,.12);box-shadow:0 0 12px rgba(255,190,70,.12); }
#hud .mr-marker { position:absolute;z-index:var(--z-hud-top);display:flex;align-items:center;gap:7px;max-width:170px;padding:5px 9px;border:1px solid rgba(127,232,255,.72);border-radius:999px;background:rgba(4,20,34,.82);color:#e8fbff;font-family:var(--font);font-size:11px;font-weight:760;letter-spacing:.04em;pointer-events:none;opacity:0;transform:translate(-50%,-50%);transition:opacity .12s ease; }
#hud .mr-marker.show { opacity:1; }
#hud .mr-marker.offscreen { border-color:rgba(255,200,98,.78); }
#hud .mr-marker-arrow { display:inline-block;color:var(--mr-gold);font-size:15px;line-height:1;transform:rotate(0rad); }
#hud .mr-marker-copy { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
#hud .mr-world-label-layer { position:absolute;inset:0;z-index:var(--z-hud-top);overflow:hidden;pointer-events:none; }
#hud .mr-world-label { position:absolute;display:flex;align-items:baseline;gap:5px;padding:4px 7px;border:1px solid rgba(127,232,255,.38);border-radius:4px;background:rgba(3,17,30,.74);color:#dff8ff;font-family:var(--font);font-size:10px;letter-spacing:.04em;opacity:0;transform:translate(-50%,-50%);white-space:nowrap; }
#hud .mr-world-label.show { opacity:.86; }
#hud .mr-world-label.visited { border-color:rgba(127,232,255,.2);color:rgba(206,242,250,.62); }
#hud .mr-world-label small { color:rgba(215,239,247,.56);font-size:8px;font-variant-numeric:tabular-nums; }
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
#hud .mr-event { top: max(320px,33%); left: 50%; padding: 8px 20px; transform: translate(-50%,-8px); border-block: 1px solid var(--mr-cyan); background: rgba(5,24,39,.78); font-size: 18px; font-weight: 780; letter-spacing: .12em; text-transform: uppercase; opacity: 0; }
#hud .mr-event.show { animation: mr-event 1.65s ease both; }
#hud .mr-event.show + .mr-marker { opacity:0; }
@keyframes mr-event { 0%{opacity:0;transform:translate(-50%,-10px)} 14%,72%{opacity:1;transform:translate(-50%,0)} 100%{opacity:0;transform:translate(-50%,7px)} }
@media (max-width:680px) { #hud .mr-panel{width:min(350px,calc(100vw - 24px));top:12px}#hud .mr-controls{display:none}#hud .mr-route-stop{font-size:7px} }
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
  #target: HTMLElement;
  #targetPlan: HTMLElement;
  #targetDistance: HTMLElement;
  #clock: HTMLElement;
  #route: HTMLElement;
  #routeItems = new Map<string, HTMLElement>();
  #marker: HTMLElement;
  #markerArrow: HTMLElement;
  #markerCopy: HTMLElement;
  #worldLabels: HTMLElement;
  #worldLabelItems = new Map<string, { root: HTMLElement; distance: HTMLElement }>();
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
      <div class="mr-nav">
        <div class="mr-target"><small>nav target</small><b data-mr="target">Moon</b><em data-mr="plan">Q next · R previous</em></div>
        <div class="mr-target-meta"><span data-mr="distance">locating…</span><span data-mr="clock">flight 0:00</span></div>
        <div class="mr-route" aria-label="solar tour itinerary"></div>
      </div>
      <div class="mr-controls">Q/R selects any world · Follow its locator · W base drive · Shift 15× boost · Mouse aims · A/D banks · E returns to Marin</div>`;
    this.#stage = this.#panel.querySelector(".mr-stage")!;
    this.#altitude = this.#panel.querySelector('[data-mr="alt"]')!;
    this.#speed = this.#panel.querySelector('[data-mr="speed"]')!;
    this.#vertical = this.#panel.querySelector('[data-mr="vertical"]')!;
    this.#throttle = this.#panel.querySelector(".mr-throttle > i")!;
    this.#target = this.#panel.querySelector('[data-mr="target"]')!;
    this.#targetPlan = this.#panel.querySelector('[data-mr="plan"]')!;
    this.#targetDistance = this.#panel.querySelector('[data-mr="distance"]')!;
    this.#clock = this.#panel.querySelector('[data-mr="clock"]')!;
    this.#route = this.#panel.querySelector(".mr-route")!;
    this.#prompt = document.createElement("div");
    this.#prompt.className = "mr-prompt";
    this.#prompt.innerHTML = `<span class="mr-key"></span><span class="mr-prompt-copy"></span>`;
    this.#promptKey = this.#prompt.querySelector(".mr-key")!;
    this.#promptCopy = this.#prompt.querySelector(".mr-prompt-copy")!;
    this.#event = document.createElement("div");
    this.#event.className = "mr-event";
    this.#marker = document.createElement("div");
    this.#marker.className = "mr-marker";
    this.#marker.innerHTML = `<span class="mr-marker-arrow">↑</span><span class="mr-marker-copy"></span>`;
    this.#markerArrow = this.#marker.querySelector(".mr-marker-arrow")!;
    this.#markerCopy = this.#marker.querySelector(".mr-marker-copy")!;
    this.#worldLabels = document.createElement("div");
    this.#worldLabels.className = "mr-world-label-layer";
    hud.append(this.#panel, this.#prompt, this.#worldLabels, this.#event, this.#marker);
  }

  begin(): void {
    this.#panel.classList.add("show");
  }

  update(
    telemetry: Readonly<RocketFlightTelemetry>,
    navigation: Readonly<CelestialNavigation> | null
  ): void {
    this.#stage.textContent = STAGE_LABEL[telemetry.stage];
    this.#altitude.textContent = (telemetry.altitude / 1_000).toFixed(1);
    this.#speed.textContent = Math.round(telemetry.speed).toLocaleString();
    this.#vertical.textContent = `${telemetry.verticalSpeed >= 0 ? "+" : ""}${Math.round(telemetry.verticalSpeed)}`;
    this.#throttle.style.width = `${Math.round(telemetry.throttle * 100)}%`;
    if (!navigation) {
      this.#marker.classList.remove("show");
      this.#hideWorldLabels();
      return;
    }
    this.#target.textContent = navigation.targetLabel;
    this.#clock.textContent = `flight ${formatMissionTime(navigation.elapsedSeconds)}`;
    this.#targetPlan.textContent = navigation.complete
      ? "all visited · Q/R select"
      : "Q next · R previous";
    this.#targetDistance.textContent = `${formatDistance(navigation.targetDistance)} to target`;
    this.#markerCopy.textContent = `${navigation.targetLabel} · ${formatDistance(navigation.targetDistance)}`;
    let markerX = (navigation.markerX * 0.5 + 0.5) * innerWidth;
    let markerY = (-navigation.markerY * 0.5 + 0.5) * innerHeight;
    const panelRect = this.#panel.getBoundingClientRect();
    const markerHalfWidth = 88;
    const overlapsPanel =
      markerX + markerHalfWidth > panelRect.left &&
      markerX - markerHalfWidth < panelRect.right &&
      markerY + 20 > panelRect.top &&
      markerY - 20 < panelRect.bottom;
    if (overlapsPanel) {
      if (panelRect.right + markerHalfWidth + 14 < innerWidth) {
        markerX = panelRect.right + markerHalfWidth + 14;
      } else if (panelRect.left - markerHalfWidth - 14 > 0) {
        markerX = panelRect.left - markerHalfWidth - 14;
      } else {
        markerY = panelRect.bottom + 28;
      }
    }
    markerX = Math.min(innerWidth - markerHalfWidth - 8, Math.max(markerHalfWidth + 8, markerX));
    markerY = Math.min(innerHeight - 24, Math.max(24, markerY));
    this.#marker.style.left = `${markerX}px`;
    this.#marker.style.top = `${markerY}px`;
    this.#markerArrow.style.transform = navigation.markerOnScreen
      ? "rotate(0rad)"
      : `rotate(${navigation.markerAngle}rad)`;
    this.#marker.classList.toggle("offscreen", !navigation.markerOnScreen);
    this.#marker.classList.add("show");
    this.#updateWorldLabels(navigation, panelRect);
    if (this.#routeItems.size === 0) {
      const items = navigation.route.map((stop) => {
        const item = document.createElement("span");
        item.textContent = stop.label;
        this.#routeItems.set(stop.id, item);
        return item;
      });
      this.#route.replaceChildren(...items);
    }
    for (const stop of navigation.route) {
      const item = this.#routeItems.get(stop.id)!;
      item.className = `mr-route-stop ${stop.state}`;
      item.title = `${stop.label} · ${stop.plannedTime}`;
    }
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
    this.#marker.classList.remove("show");
    void this.#event.offsetWidth;
    this.#event.classList.add("show");
  }

  hideFlight(): void {
    this.#panel.classList.remove("show");
    this.#event.classList.remove("show");
    this.#marker.classList.remove("show");
    this.#hideWorldLabels();
  }

  dispose(): void {
    this.#panel.remove();
    this.#prompt.remove();
    this.#event.remove();
    this.#marker.remove();
    this.#worldLabels.remove();
    this.#style.remove();
  }

  #updateWorldLabels(
    navigation: Readonly<CelestialNavigation>,
    panelRect: DOMRect
  ): void {
    if (this.#worldLabelItems.size === 0) {
      for (const marker of navigation.bodyMarkers) {
        const root = document.createElement("span");
        root.className = "mr-world-label";
        const name = document.createElement("b");
        name.textContent = marker.label;
        const distance = document.createElement("small");
        root.append(name, distance);
        this.#worldLabels.append(root);
        this.#worldLabelItems.set(marker.id, { root, distance });
      }
    }

    for (const marker of navigation.bodyMarkers) {
      const item = this.#worldLabelItems.get(marker.id)!;
      const x = (marker.x * 0.5 + 0.5) * innerWidth;
      const y = (-marker.y * 0.5 + 0.5) * innerHeight;
      const overlapsPanel =
        x > panelRect.left - 64 && x < panelRect.right + 64 &&
        y > panelRect.top - 16 && y < panelRect.bottom + 16;
      const show = navigation.overlaysVisible && marker.onScreen && !marker.selected && !overlapsPanel;
      item.root.classList.toggle("show", show);
      item.root.classList.toggle("visited", marker.visited);
      if (!show) continue;
      item.distance.textContent = formatDistance(marker.distance);
      item.root.style.left = `${x}px`;
      item.root.style.top = `${y}px`;
    }
  }

  #hideWorldLabels(): void {
    for (const item of this.#worldLabelItems.values()) item.root.classList.remove("show");
  }
}

function formatDistance(metres: number): string {
  if (metres < 1_000) return `${Math.max(0, Math.round(metres))} m`;
  return `${Math.max(0, Math.round(metres / 1_000)).toLocaleString()} km`;
}
