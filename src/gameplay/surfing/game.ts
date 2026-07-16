import type { PlayerMode } from "../../player/types";
import type { SurfTelemetry } from "../../vehicles/surf";
import type { VehicleAudio } from "../../fx/vehicleAudio";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
type SurfStatusTone = "" | "good" | "air" | "bad" | "flow" | "tube";

/** Score/combo bridge for the surf controller. Simulation stays in the vehicle;
 * this class owns rewards, feedback, HUD pulses and audio events. */
export class SurfExperience {
  readonly root: HTMLElement;
  readonly transition: HTMLElement;
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
  #assistSerial = 0;
  #waveSerial = 0;
  #flowSerial = 0;
  #flowDuration = 1;
  #launchSerial = 0;
  #tubeSerial = 0;
  #cutbackSerial = 0;
  #spitSerial = 0;
  #active = false;
  #audio: VehicleAudio;

  constructor(audio: VehicleAudio) {
    this.#audio = audio;
    this.transition = document.createElement("div");
    this.transition.className = "surf-wave-transition";
    this.transition.setAttribute("aria-hidden", "true");
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
      <div class="surf-controls">A/D CARVE — WAVE SIDE CLIMBS · BEACH SIDE SPEEDS · 2-TAP = CUTBACK · SPACE JUMP · E EXIT</div>`;
    this.#scoreEl = this.root.querySelector("[data-surf-score]")!;
    this.#comboEl = this.root.querySelector("[data-surf-combo]")!;
    this.#statusEl = this.root.querySelector("[data-surf-status]")!;
    this.#meterEl = this.root.querySelector("[data-surf-meter]")!;
    this.#launchEl = this.root.querySelector("[data-surf-launch]")!;
    document.getElementById("hud")!.append(this.transition, this.root);
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
        // Surf runtime/HUD creation may happen after the controller has already
        // entered a barrel. Seed the serials on activation so joining or
        // resetting never pays a stale reward.
        this.#tubeSerial = surf.tubeSerial;
        this.#cutbackSerial = surf.cutbackSerial;
        this.#spitSerial = surf.spitSerial;
        this.#status("ALREADY RIDING", "good");
        this.root.classList.add("pulse");
      } else {
        this.transition.classList.remove("on");
        this.root.classList.remove("tube-active");
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
        // Named trick from the landed rotation: spins in 180s, W/S flips, grab.
        const spinDeg = Math.round(Math.abs(surf.landedSpin) / Math.PI) * 180;
        const flips = Math.round(Math.abs(surf.landedFlip) / (Math.PI * 2));
        const grabbed = surf.landedGrab > 0.35;
        const parts: string[] = [];
        if (flips > 0) {
          parts.push(
            `${flips > 1 ? `${flips}x ` : ""}${surf.landedFlip < 0 ? "FRONTFLIP" : "BACKFLIP"}`
          );
        }
        if (spinDeg >= 180) parts.push(`${spinDeg}`);
        if (grabbed) parts.push("GRAB");
        const label = parts.length
          ? parts.join(" + ")
          : surf.landedAirTime > 0.85
            ? "BIG AIR"
            : "CLEAN LANDING";
        const points = Math.round(
          (180 +
            surf.landedAirTime * 420 +
            spinDeg * 1.3 +
            flips * 420 +
            (grabbed ? 160 : 0)) *
            (0.55 + surf.landingQuality * 0.45)
        );
        this.#award(points, label, "landing");
      }
    }
    if (surf.cutbackSerial !== this.#cutbackSerial) {
      this.#cutbackSerial = surf.cutbackSerial;
      this.#award(Math.round(140 + surf.speed * 6), "ROUNDHOUSE", "carve");
    }
    if (surf.spitSerial !== this.#spitSerial) {
      this.#spitSerial = surf.spitSerial;
      this.#award(Math.round(260 + surf.speed * 8), "SPIT OUT", "landing", "tube");
    }
    // Barrel depth is a live ticker, not just a one-shot bonus: the deeper you
    // sit, the faster it pays.
    if (surf.tubeState === "inside") {
      this.#score += dt * (40 + surf.tubeDepth * 160) * this.#combo;
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
    if (surf.tubeSerial < this.#tubeSerial) {
      // Controller reset while the activity remains mounted.
      this.#tubeSerial = surf.tubeSerial;
    } else if (surf.tubeSerial > this.#tubeSerial) {
      this.#tubeSerial = surf.tubeSerial;
      const points = Math.round(650 + surf.speed * 9 + surf.tubeCoverage * 150);
      this.#award(points, "TUBE RIDE", "carve", "tube");
    }
    if (surf.waveSerial !== this.#waveSerial) {
      this.#waveSerial = surf.waveSerial;
      this.#status("NEXT CLEAN WAVE", "good");
      this.#eventTimer = 1.0;
      this.#audio.surfEvent("carve", 0.55);
      // The endless arcade line projects onto the next incoming crest. A quick
      // whitewater wash turns that otherwise large ocean-space cut into an
      // intentional "next wave" transition while preserving the same framing.
      this.transition.classList.remove("on");
      void this.transition.offsetWidth;
      this.transition.classList.add("on");
    } else if (surf.assistSerial !== this.#assistSerial) {
      this.#assistSerial = surf.assistSerial;
      this.#status("AUTO SAVE", "good");
      this.#eventTimer = 0.75;
    } else if (this.#eventTimer > 0) {
      // Hold trick/landing copy long enough to read before live wave status resumes.
    } else if (surf.tubeState === "inside") {
      this.#status(`BARREL  ${surf.tubeDwell.toFixed(1)}s`, "tube");
    } else if (surf.tubeState === "entering") {
      this.#status("HOLD THE POCKET", "tube");
    } else if (surf.tubeState === "exiting") {
      this.#status("DRIVE THROUGH THE EXIT", "tube");
    } else if (surf.tubeCoverage > 0.18 && surf.tubeClearance > 0 && surf.tubeDepth < 0.5) {
      this.#status("CARVE UP INTO THE TUBE", "tube");
    } else if (surf.tubeCoverage > 0.18 && surf.tubeClearance > 0) {
      this.#status("RIDE THE POCKET — BARREL", "tube");
    } else if (surf.barrelAhead > 0.4) {
      this.#status("BARREL AHEAD — HOLD THE POCKET", "tube");
    } else if (surf.flowActive) {
      this.#status(`FLOW  ${surf.riderMotionRate.toFixed(2)}×`, "flow");
    } else if (surf.airborne) {
      this.#status(`AIR ${surf.airTime.toFixed(1)}s`, "air");
    } else if (surf.flowReady) {
      this.#status("X — FLOW READY", "flow");
    } else if (surf.autoLaunchCharge > 0.08) {
      this.#status(`LIP ENERGY ${Math.round(surf.autoLaunchCharge * 100)}%`, "air");
    } else if (surf.stalling) {
      this.#status("CARVE TOWARD THE BEACH FOR SPEED", "");
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
    this.root.classList.toggle(
      "tube-active",
      surf.tubeState === "entering" || surf.tubeState === "inside" || surf.tubeState === "exiting"
    );
    this.root.classList.remove("pulse");
  }

  #award(
    points: number,
    label: string,
    sound: "carve" | "landing",
    tone: SurfStatusTone = "good"
  ) {
    this.#score += points * this.#combo;
    this.#combo = Math.min(8, this.#combo + 1);
    this.#comboTimer = 4.2;
    this.#turnCooldown = 0.38;
    this.#eventTimer = 1.15;
    this.#status(`${label}  +${points * (this.#combo - 1)}`, tone);
    this.#audio.surfEvent(sound, Math.min(1, points / 600));
    this.root.classList.remove("pulse");
    void this.root.offsetWidth;
    this.root.classList.add("pulse");
  }

  #status(text: string, tone: SurfStatusTone) {
    this.#statusEl.textContent = text;
    this.#statusEl.dataset.tone = tone;
  }
}
