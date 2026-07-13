import type { PlayerMode } from "../../player/types";
import type { SurfTelemetry } from "../../vehicles/surf";
import type { VehicleAudio } from "../../fx/vehicleAudio";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Score/combo bridge for the surf controller. Simulation stays in the vehicle;
 * this class owns rewards, feedback, HUD pulses and audio events. */
export class SurfExperience {
  readonly root: HTMLElement;
  #scoreEl: HTMLElement;
  #comboEl: HTMLElement;
  #statusEl: HTMLElement;
  #meterEl: HTMLElement;
  #launchEl: HTMLElement;
  #score = 0;
  #combo = 1;
  #comboTimer = 0;
  #lastLeanSign = 0;
  #turnCooldown = 0;
  #eventTimer = 0;
  #landingSerial = 0;
  #wipeoutSerial = 0;
  #flowSerial = 0;
  #flowDuration = 1;
  #launchSerial = 0;
  #active = false;
  #audio: VehicleAudio;

  constructor(audio: VehicleAudio) {
    this.#audio = audio;
    this.root = document.createElement("section");
    this.root.className = "surf-hud";
    this.root.setAttribute("aria-label", "Ocean Beach surf score");
    this.root.innerHTML = `
      <div class="surf-title"><span>OCEAN BEACH</span><small>FIND YOUR FLOW</small></div>
      <div class="surf-score"><span data-surf-score>0</span><small>POINTS</small></div>
      <div class="surf-combo" data-surf-combo>x1</div>
      <div class="surf-status" data-surf-status>DROP IN</div>
      <div class="surf-meter surf-flow-meter"><span>FLOW</span><i data-surf-meter></i><b>X</b></div>
      <div class="surf-meter surf-launch-meter"><span>LIP</span><i data-surf-launch></i><b>AUTO</b></div>
      <div class="surf-controls">W pump · S stall · A/D choose your line · X flow</div>`;
    this.#scoreEl = this.root.querySelector("[data-surf-score]")!;
    this.#comboEl = this.root.querySelector("[data-surf-combo]")!;
    this.#statusEl = this.root.querySelector("[data-surf-status]")!;
    this.#meterEl = this.root.querySelector("[data-surf-meter]")!;
    this.#launchEl = this.root.querySelector("[data-surf-launch]")!;
    document.getElementById("hud")!.appendChild(this.root);
  }

  get debugState() {
    return {
      active: this.#active,
      score: Math.floor(this.#score),
      combo: this.#combo,
      comboTimer: this.#comboTimer,
      status: this.#statusEl.textContent ?? ""
    };
  }

  update(dt: number, mode: PlayerMode, surf: SurfTelemetry) {
    const active = mode === "surf";
    if (active !== this.#active) {
      this.#active = active;
      this.root.classList.toggle("on", active);
      if (active) {
        this.#status("PADDLE IN", "good");
        this.root.classList.add("pulse");
      }
    }
    if (!active) return;

    this.#turnCooldown = Math.max(0, this.#turnCooldown - dt);
    this.#eventTimer = Math.max(0, this.#eventTimer - dt);
    this.#comboTimer = Math.max(0, this.#comboTimer - dt);
    if (this.#comboTimer <= 0 && this.#combo > 1) this.#combo = 1;

    this.#score += dt * surf.speed * (0.35 + surf.face * 1.75) * this.#combo;
    const sign = Math.abs(surf.lean) > 0.3 ? Math.sign(surf.lean) : 0;
    if (
      surf.grounded &&
      surf.face > 0.28 &&
      sign !== 0 &&
      sign !== this.#lastLeanSign &&
      this.#turnCooldown <= 0
    ) {
      const points = Math.round(95 + surf.speed * 8 + surf.face * 120);
      this.#award(points, surf.lip > 0.5 ? "LIP SNAP" : "CARVE", "carve");
      this.#lastLeanSign = sign;
      this.#turnCooldown = 0.42;
    } else if (sign !== 0) {
      this.#lastLeanSign = sign;
    }

    if (surf.landingSerial !== this.#landingSerial) {
      this.#landingSerial = surf.landingSerial;
      if (surf.landedAirTime > 0.24) {
        const points = Math.round(180 + surf.landedAirTime * 420);
        this.#award(points, surf.landedAirTime > 0.85 ? "BIG AIR" : "CLEAN LANDING", "landing");
      }
    }
    if (surf.flowSerial !== this.#flowSerial) {
      this.#flowSerial = surf.flowSerial;
      this.#flowDuration = Math.max(0.001, surf.flowTimeRemaining);
      this.#status("FLOW STATE", "flow");
      this.#eventTimer = 1.1;
      this.#audio.surfEvent("flow", 1);
      this.root.classList.remove("flow-on");
      void this.root.offsetWidth;
      this.root.classList.add("flow-on");
    }
    if (surf.launchSerial !== this.#launchSerial) {
      this.#launchSerial = surf.launchSerial;
      this.#status("LIFT OFF", "air");
      this.#eventTimer = 0.8;
    }
    if (surf.wipeoutSerial !== this.#wipeoutSerial) {
      this.#wipeoutSerial = surf.wipeoutSerial;
      this.#combo = Math.max(1, this.#combo - 1);
      this.#status("SURFACE SAVE", "good");
      this.#eventTimer = 0.9;
      this.#audio.surfEvent("wipeout", 0.35);
    } else if (this.#eventTimer > 0) {
      // Hold trick/landing copy long enough to read before live wave status resumes.
    } else if (surf.flowActive) {
      this.#status(`FLOW  ${surf.riderMotionRate.toFixed(2)}×`, "flow");
    } else if (surf.airborne) {
      this.#status(`AIR ${surf.airTime.toFixed(1)}s`, "air");
    } else if (surf.flowReady) {
      this.#status("X — ENTER FLOW", "flow");
    } else if (surf.autoLaunchCharge > 0.08) {
      this.#status(`LIP ENERGY ${Math.round(surf.autoLaunchCharge * 100)}%`, "air");
    } else if (surf.stalling) {
      this.#status("STALLING — PUMP W", "");
    } else if (surf.lip > 0.56) {
      this.#status("ON THE LIP", "air");
    } else if (surf.face > 0.34) {
      this.#status("IN THE POCKET", "good");
    } else {
      this.#status("FIND THE FACE", "");
    }

    this.#scoreEl.textContent = Math.floor(this.#score).toLocaleString();
    this.#comboEl.textContent = `x${this.#combo}`;
    this.#comboEl.classList.toggle("hot", this.#combo > 1);
    const flowFill = surf.flowActive
      ? clamp01(surf.flowTimeRemaining / this.#flowDuration)
      : surf.flow;
    this.#meterEl.style.transform = `scaleX(${clamp01(flowFill)})`;
    this.#launchEl.style.transform = `scaleX(${clamp01(surf.autoLaunchCharge)})`;
    this.root.classList.toggle("flow-ready", surf.flowReady && !surf.flowActive);
    this.root.classList.toggle("flow-active", surf.flowActive);
    this.root.classList.remove("pulse");
  }

  #award(points: number, label: string, sound: "carve" | "landing") {
    this.#score += points * this.#combo;
    this.#combo = Math.min(8, this.#combo + 1);
    this.#comboTimer = 4.2;
    this.#turnCooldown = 0.38;
    this.#eventTimer = 1.15;
    this.#status(`${label}  +${points * (this.#combo - 1)}`, "good");
    this.#audio.surfEvent(sound, Math.min(1, points / 600));
    this.root.classList.remove("pulse");
    void this.root.offsetWidth;
    this.root.classList.add("pulse");
  }

  #status(text: string, tone: "" | "good" | "air" | "bad" | "flow") {
    this.#statusEl.textContent = text;
    this.#statusEl.dataset.tone = tone;
  }
}
