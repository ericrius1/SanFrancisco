import * as THREE from "three/webgpu";
import type { NatureSoundscape } from "../../audio/natureSoundscape";
import type { GameSite } from "../siteGate";
import { interactKeyLabel, type Input } from "../../core/input";
import type { Player } from "../../player/player";
import type { HUD } from "../../ui/hud";
import type { WorldMap } from "../../world/heightmap";
import { AfterlightAudio } from "./audio";
import {
  AFTERLIGHT_CENTER,
  AFTERLIGHT_TUNING,
  ECHO_LAYOUT,
  KEEPER_LAYOUT,
  type AfterlightPhase
} from "./layout";
import { AfterlightSiteVisuals } from "./site";
import { AfterlightSkyWhale } from "./skyWhale";
import { AfterlightUI } from "./ui";

type ReturnFlight = {
  from: THREE.Vector3;
  t: number;
  arrived: boolean;
};

export type AfterlightDebugState = {
  phase: AfterlightPhase;
  awake: boolean;
  cinematic: boolean;
  collected: boolean[];
  arrived: boolean[];
  remainingSeconds: number;
  completionTime: number;
  whaleActive: boolean;
  takeover: ReturnType<AfterlightSiteVisuals["takeoverDebugState"]>;
  audio: AfterlightAudio["debugState"];
};

const CINEMATIC_START = 2.15;
const CINEMATIC_COLLECT = [3.0, 3.72, 4.44, 5.16, 5.88] as const;
const CINEMATIC_RETURN_SECONDS = 0.86;
const CINEMATIC_COMPLETE = 6.74;
const CINEMATIC_WHALE = 7.15;

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function interactionDistance(x: number, z: number): number {
  const mara = KEEPER_LAYOUT[0];
  return Math.min(
    Math.hypot(x - AFTERLIGHT_CENTER.x, z - AFTERLIGHT_CENTER.z),
    Math.hypot(x - (AFTERLIGHT_CENTER.x + mara.x), z - (AFTERLIGHT_CENTER.z + mara.z))
  );
}

function keeperDistance(x: number, z: number): number {
  const mara = KEEPER_LAYOUT[0];
  return Math.hypot(x - (AFTERLIGHT_CENTER.x + mara.x), z - (AFTERLIGHT_CENTER.z + mara.z));
}

/**
 * A repeatable light-gathering quest and art performance at Buena Vista Park.
 * World state stays local to this class; main.ts only owns construction,
 * site-gating, the shared E interaction, and the per-frame call.
 */
export class AfterlightExperience {
  readonly root: THREE.Group;
  readonly ready: Promise<void>;

  #visuals: AfterlightSiteVisuals;
  #whale = new AfterlightSkyWhale();
  #ui = new AfterlightUI();
  #audio: AfterlightAudio;
  #phase: AfterlightPhase = "idle";
  #awake = false;
  #cinematic = false;
  #collected = ECHO_LAYOUT.map(() => false);
  #flights: ReturnFlight[] = ECHO_LAYOUT.map(() => ({ from: new THREE.Vector3(), t: 0, arrived: false }));
  #remaining: number = AFTERLIGHT_TUNING.questSeconds;
  #completionTime = 0;
  #temp = new THREE.Vector3();
  #target = new THREE.Vector3();
  #scene: THREE.Scene;
  #embodiedPlayer: Player | null = null;
  #disposed = false;

  constructor(map: WorldMap, scene: THREE.Scene, nature: NatureSoundscape) {
    this.#scene = scene;
    this.#visuals = new AfterlightSiteVisuals(map);
    this.root = this.#visuals.root;
    this.root.add(this.#whale.root);
    this.#audio = new AfterlightAudio(nature, {
      x: AFTERLIGHT_CENTER.x,
      y: this.#visuals.centerY + 2.2,
      z: AFTERLIGHT_CENTER.z
    });
    this.#resetWorld(false);
    this.ready = Promise.resolve();
  }

  get phase(): AfterlightPhase {
    return this.#phase;
  }

  get capturesInteraction(): boolean {
    return this.#phase === "active" || this.#visuals.controlsCaptured;
  }

  get controlsCaptured(): boolean {
    return this.#visuals.controlsCaptured;
  }

  siteHooks(): GameSite {
    return {
      id: "afterlight",
      contains: (x, z, pad) => {
        const rx = 66 + pad;
        const rz = 50 + pad;
        const dx = (x - AFTERLIGHT_CENTER.x) / rx;
        const dz = (z - AFTERLIGHT_CENTER.z) / rz;
        return dx * dx + dz * dz <= 1;
      },
      activatePad: AFTERLIGHT_TUNING.activatePad,
      deactivatePad: AFTERLIGHT_TUNING.deactivatePad,
      keepAwake: () =>
        this.#phase === "active" ||
        this.#cinematic ||
        (this.#phase === "complete" && this.#completionTime < AFTERLIGHT_TUNING.whaleDuration),
      setAwake: (on) => this.setAwake(on)
    };
  }

  setAwake(on: boolean): void {
    if (this.#disposed || this.#awake === on) return;
    this.#awake = on;
    if (on) {
      if (this.root.parent !== this.#scene) this.#scene.add(this.root);
    }
    this.#visuals.setAwake(on);
    if (!on) {
      this.#releaseTakeover();
      this.#visuals.setInteractionFocus(-1, interactKeyLabel());
      this.root.removeFromParent();
    }
    if (on && !this.#cinematic) this.#visuals.setLabelsVisible(true);
    this.#ui.setAwake(on && !this.#cinematic);
    this.#audio.setAwake(on && !this.#cinematic);
    if (!on) this.#ui.setPrompt(null);
  }

  /**
   * Expose every normally hidden state for one covered renderer warmup. The
   * returned closure restores authored visibility and detaches an asleep site.
   */
  prepareWarmup(): () => void {
    if (this.#disposed) return () => {};
    const visibility: Array<{ object: THREE.Object3D; visible: boolean; frustumCulled: boolean }> = [];
    this.root.traverse((object) => {
      visibility.push({ object, visible: object.visible, frustumCulled: object.frustumCulled });
      object.visible = true;
      object.frustumCulled = false;
    });
    if (this.root.parent !== this.#scene) this.#scene.add(this.root);
    let restored = false;
    return () => {
      if (restored) return;
      restored = true;
      for (const entry of visibility) {
        entry.object.visible = entry.visible;
        entry.object.frustumCulled = entry.frustumCulled;
      }
      if (this.#awake) {
        if (this.root.parent !== this.#scene) this.#scene.add(this.root);
        this.root.visible = true;
      } else {
        this.root.removeFromParent();
      }
    };
  }

  /** Shared E-chain hook. Returns true only when the loom actually owns E. */
  tryInteract(player: Player, hud: HUD): boolean {
    if (!this.#awake || player.mode !== "walk" || player.riding) return false;
    if (this.#visuals.controlsCaptured) {
      this.#releaseTakeover(player);
      this.#ui.setPrompt(null);
      hud.message("You let the strand go. The web keeps your last ripple.", 2.4);
      return true;
    }

    const participant = this.#visuals.nearestCelebrant(player.position.x, player.position.z);
    if (
      participant >= 0 &&
      this.#visuals.celebrantDistance(participant, player.position.x, player.position.z) <
        keeperDistance(player.position.x, player.position.z)
    ) {
      const release = interactKeyLabel();
      if (!this.#visuals.beginTakeover(participant, player.avatarTraits, release)) return false;
      this.#embodiedPlayer = player;
      player.setExternalEmbodimentHidden(true);
      hud.message(
        `You're shaping the web · trackpad moves both hands · Shift/click isolates one · controller sticks split hands · ${release} releases`,
        5.2
      );
      this.#ui.showMilestone("YOUR HANDS ENTER THE CIRCUIT", {
        eyebrow: "Collective sculpture",
        detail: "Every movement travels through the ring",
        tone: "mist",
        seconds: 2.4
      });
      return true;
    }

    const distance = interactionDistance(player.position.x, player.position.z);
    if (distance > AFTERLIGHT_TUNING.interactRadius) return false;

    if (this.#phase === "active") {
      hud.message("Mara: The five lights are wandering the clearing — listen for them.", 3.2);
      return true;
    }
    if (
      this.#phase === "complete" &&
      this.#completionTime < AFTERLIGHT_TUNING.completionHoldSeconds
    ) {
      hud.message("Sol: Wait — let the old singer finish this turn.", 2.2);
      return true;
    }
    const replay = this.#phase === "failed" || this.#phase === "complete";
    this.#begin(replay, hud);
    return true;
  }

  /** Called before the player fixed-step so claimed controls cannot move the body. */
  captureInput(input: Input, dt: number, player: Player): boolean {
    if (!this.#visuals.controlsCaptured) return false;
    if (!this.#awake || player.mode !== "walk" || player.riding) {
      this.#releaseTakeover(player);
      this.#ui.setPrompt(null);
      return false;
    }
    player.velocity.x = 0;
    player.velocity.z = 0;
    this.#visuals.driveTakeover(input, dt);
    return true;
  }

  update(dt: number, elapsed: number, player: Player, hud: HUD): void {
    if (this.#disposed || !this.#awake || this.#cinematic) return;
    const step = Math.min(Math.max(0, dt), 0.1);
    this.#audio.update();
    this.#ui.update(step);
    let completionEffect = 0;

    if (this.#phase === "active") {
      if (!this.#collected.every(Boolean)) {
        this.#remaining = Math.max(0, this.#remaining - step);
      }
      this.#collectNearby(player, hud);
      this.#updateFlights(step, hud);
      const allGathered = this.#collected.every(Boolean);
      if (this.#phase === "active" && this.#remaining <= 0 && !allGathered) this.#fail(hud);
      if (this.#phase === "active") this.#ui.setCountdown(this.#remaining);
    } else if (this.#phase === "complete") {
      this.#completionTime = Math.min(AFTERLIGHT_TUNING.whaleDuration, this.#completionTime + step);
      const reveal = smooth01(this.#completionTime / 3.4);
      const fade = smooth01(
        (AFTERLIGHT_TUNING.whaleDuration - this.#completionTime) /
          AFTERLIGHT_TUNING.whaleFadeSeconds
      );
      completionEffect = reveal * fade;
      this.#visuals.setCompletion(completionEffect);
      this.#whale.setFade(fade);
      if (this.#completionTime < AFTERLIGHT_TUNING.whaleDuration) this.#whale.update(step);
      else this.#whale.reset();
    }

    this.#visuals.update(step, elapsed, completionEffect);
    this.#updatePrompt(player);
  }

  /** Capture helper: resets to a deterministic, UI-free authored timeline. */
  resetForCinematic(_seed = 1): void {
    this.#releaseTakeover();
    this.#cinematic = true;
    this.#awake = true;
    if (this.root.parent !== this.#scene) this.#scene.add(this.root);
    this.#visuals.setAwake(true);
    this.#visuals.setLabelsVisible(false);
    this.#ui.setAwake(false);
    this.#audio.setAwake(false);
    this.#phase = "idle";
    this.#resetWorld(false);
  }

  /** Pure visual staging for fixed-frame WebCodecs renders. */
  setCinematicTime(timeSeconds: number, dt: number): void {
    if (this.#disposed) return;
    if (!this.#cinematic) this.resetForCinematic();
    const t = Math.max(0, timeSeconds);
    const active = t >= CINEMATIC_START;
    let arrivedCount = 0;
    for (let i = 0; i < this.#visuals.echoes.length; i++) {
      const echo = this.#visuals.echoes[i];
      const start = CINEMATIC_COLLECT[i];
      if (!active || t < start) {
        echo.root.position.copy(echo.home);
        echo.root.visible = active;
        echo.glow.value = active ? 1 : 0;
        this.#visuals.setPetalActivation(i, 0);
        continue;
      }
      const flight = THREE.MathUtils.clamp((t - start) / CINEMATIC_RETURN_SECONDS, 0, 1);
      if (flight < 1) {
        this.#visuals.petalTarget(i, this.#target);
        this.#temp.copy(echo.home).lerp(this.#target, smooth01(flight));
        this.#temp.y += Math.sin(flight * Math.PI) * (4.4 + i * 0.22);
        echo.root.position.copy(this.#temp);
        echo.root.visible = true;
        echo.glow.value = 1 - flight * 0.28;
      } else {
        echo.root.visible = false;
        arrivedCount++;
      }
      this.#visuals.setPetalActivation(i, smooth01(flight));
    }
    this.#visuals.setLoomCharge(arrivedCount / ECHO_LAYOUT.length);
    const completion = smooth01((t - CINEMATIC_COMPLETE) / 1.65);
    this.#visuals.setCompletion(completion);
    this.#visuals.update(Math.max(0, Math.min(dt, 0.1)), t, completion);
    if (t >= CINEMATIC_WHALE) {
      this.#whale.setFade(1);
      this.#whale.setCinematicTime(t - CINEMATIC_WHALE, dt);
    }
    else this.#whale.reset();
    this.#phase = t >= CINEMATIC_COMPLETE ? "complete" : active ? "active" : "idle";
  }

  /** Probe helper: skip the scavenger pass and inspect the finale in live play. */
  debugComplete(hud?: HUD): void {
    if (!this.#awake) this.setAwake(true);
    for (let i = 0; i < this.#collected.length; i++) {
      this.#collected[i] = true;
      this.#flights[i].arrived = true;
      this.#visuals.echoes[i].root.visible = false;
      this.#visuals.setPetalActivation(i, 1);
    }
    this.#visuals.setLoomCharge(1);
    this.#complete(hud);
  }

  debugState(): AfterlightDebugState {
    return {
      phase: this.#phase,
      awake: this.#awake,
      cinematic: this.#cinematic,
      collected: [...this.#collected],
      arrived: this.#flights.map((flight) => flight.arrived),
      remainingSeconds: this.#remaining,
      completionTime: this.#completionTime,
      whaleActive: this.#whale.active,
      takeover: this.#visuals.takeoverDebugState(),
      audio: this.#audio.debugState
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#releaseTakeover();
    this.#audio.dispose();
    this.#ui.dispose();
    this.#whale.dispose();
    this.#visuals.dispose();
  }

  #begin(replay: boolean, hud: HUD): void {
    this.#cinematic = false;
    this.#visuals.setLabelsVisible(true);
    this.#phase = "active";
    this.#remaining = AFTERLIGHT_TUNING.questSeconds;
    this.#completionTime = 0;
    this.#resetWorld(true);
    this.#audio.setAwake(true);
    if (replay) this.#audio.replay();
    else this.#audio.begin();
    this.#ui.setTracker({
      state: "active",
      collected: this.#collected,
      remainingSeconds: this.#remaining,
      objective: "Gather the five wandering echoes"
    });
    this.#ui.setPrompt(null);
    this.#ui.showMilestone("THE WIND WINDOW IS OPEN", {
      eyebrow: "Mara's request",
      detail: "Five lights are hiding along the summit clearing",
      tone: "mist",
      seconds: 2.8
    });
    hud.message("Mara: Five afterlights slipped into the grove. Bring them home before the fog closes.", 5);
  }

  #collectNearby(player: Player, hud: HUD): void {
    if (player.mode !== "walk" || player.riding) return;
    for (let i = 0; i < this.#visuals.echoes.length; i++) {
      if (this.#collected[i]) continue;
      const echo = this.#visuals.echoes[i];
      const worldX = AFTERLIGHT_CENTER.x + echo.root.position.x;
      const worldZ = AFTERLIGHT_CENTER.z + echo.root.position.z;
      const distance = Math.hypot(player.position.x - worldX, player.position.z - worldZ);
      const worldY = this.#visuals.centerY + echo.root.position.y;
      const verticalDistance = Math.abs(player.position.y - worldY);
      if (distance > AFTERLIGHT_TUNING.collectRadius || verticalDistance > 3.8) continue;
      this.#collected[i] = true;
      const flight = this.#flights[i];
      flight.from.copy(echo.root.position);
      flight.t = 0;
      flight.arrived = false;
      this.#audio.collect(i, worldX, worldY, worldZ);
      this.#ui.setProgress(this.#collected);
      this.#ui.showMilestone(`ECHO ${this.#collected.filter(Boolean).length} OF ${ECHO_LAYOUT.length}`, {
        detail: ECHO_LAYOUT[i].note,
        tone: "brass",
        seconds: 1.65
      });
      hud.message(ECHO_LAYOUT[i].note, 1.6);
    }
  }

  #updateFlights(dt: number, hud: HUD): void {
    let arrived = 0;
    for (let i = 0; i < this.#visuals.echoes.length; i++) {
      const echo = this.#visuals.echoes[i];
      const flight = this.#flights[i];
      if (!this.#collected[i]) {
        this.#visuals.setPetalActivation(i, 0);
        continue;
      }
      if (flight.arrived) {
        arrived++;
        this.#visuals.setPetalActivation(i, 1);
        continue;
      }
      flight.t = Math.min(1, flight.t + dt / AFTERLIGHT_TUNING.echoReturnSeconds);
      const eased = smooth01(flight.t);
      this.#visuals.petalTarget(i, this.#target);
      this.#temp.copy(flight.from).lerp(this.#target, eased);
      this.#temp.y += Math.sin(flight.t * Math.PI) * (4.8 + i * 0.24);
      echo.root.position.copy(this.#temp);
      echo.glow.value = 1 - flight.t * 0.25;
      this.#visuals.setPetalActivation(i, eased);
      if (flight.t < 1) continue;
      flight.arrived = true;
      echo.root.visible = false;
      arrived++;
    }
    this.#visuals.setLoomCharge(arrived / ECHO_LAYOUT.length);
    if (arrived === ECHO_LAYOUT.length) this.#complete(hud);
  }

  #complete(hud?: HUD): void {
    if (this.#phase === "complete") return;
    this.#phase = "complete";
    this.#completionTime = 0;
    this.#remaining = 0;
    this.#visuals.setCompletion(0);
    this.#whale.activate();
    this.#audio.complete();
    this.#ui.setTracker({
      state: "complete",
      collected: ECHO_LAYOUT.length,
      remainingSeconds: null,
      objective: "The old singer heard the hill"
    });
    this.#ui.setPrompt(null);
    this.#ui.showMilestone("THE GROVE REMEMBERS", {
      eyebrow: "Afterlight restored",
      detail: "Sol: Look up.",
      tone: "brass",
      seconds: 4.2
    });
    hud?.message("Sol: There — the old singer heard us. Look up.", 4.8);
  }

  #fail(hud: HUD): void {
    this.#phase = "failed";
    this.#audio.fail();
    this.#whale.reset();
    this.#resetWorld(false);
    this.#ui.setTracker({
      state: "failed",
      collected: 0,
      remainingSeconds: null,
      objective: "The last light slipped into the fog"
    });
    this.#ui.showMilestone("THE FOG CLOSED", {
      eyebrow: "The tune scattered",
      detail: "Return to the loom and try again",
      tone: "danger",
      seconds: 3
    });
    hud.message("Mara: The wind turned. Touch the loom and we'll begin again.", 4);
  }

  #resetWorld(showEchoes: boolean): void {
    for (let i = 0; i < this.#collected.length; i++) {
      this.#collected[i] = false;
      const flight = this.#flights[i];
      flight.t = 0;
      flight.arrived = false;
      flight.from.copy(this.#visuals.echoes[i].home);
      this.#visuals.setPetalActivation(i, 0);
    }
    this.#visuals.resetEchoes(showEchoes);
    this.#visuals.setLoomCharge(0);
    this.#visuals.setCompletion(0);
    this.#whale.reset();
    this.#ui.setProgress(0);
  }

  #updatePrompt(player: Player): void {
    const key = interactKeyLabel();
    if (player.mode !== "walk" || player.riding) {
      this.#ui.setPrompt(null);
      this.#visuals.setInteractionFocus(-1, key);
      return;
    }
    if (this.#visuals.controlsCaptured) {
      this.#visuals.setInteractionFocus(this.#visuals.controlledCelebrant, key, true);
      this.#ui.setPrompt("release control · your avatar is shaping the web", key);
      return;
    }
    const participant = this.#visuals.nearestCelebrant(player.position.x, player.position.z);
    if (
      participant >= 0 &&
      this.#visuals.celebrantDistance(participant, player.position.x, player.position.z) <
        keeperDistance(player.position.x, player.position.z)
    ) {
      this.#visuals.setInteractionFocus(participant, key);
      this.#ui.setPrompt("take over this participant", key);
      return;
    }
    this.#visuals.setInteractionFocus(-1, key);
    const distance = interactionDistance(player.position.x, player.position.z);
    if (distance > AFTERLIGHT_TUNING.interactRadius || this.#phase === "active") {
      this.#ui.setPrompt(null);
      return;
    }
    if (this.#phase === "idle") this.#ui.setPrompt("ask Mara about the quiet sky");
    else if (this.#phase === "failed") this.#ui.setPrompt("try the song again");
    else if (this.#completionTime >= AFTERLIGHT_TUNING.completionHoldSeconds) this.#ui.setPrompt("call the singer again");
    else this.#ui.setPrompt(null);
  }

  #releaseTakeover(player: Player | null = this.#embodiedPlayer): void {
    this.#visuals.endTakeover();
    (player ?? this.#embodiedPlayer)?.setExternalEmbodimentHidden(false);
    this.#embodiedPlayer = null;
  }
}
