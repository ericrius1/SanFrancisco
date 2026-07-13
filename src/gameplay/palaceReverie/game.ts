import * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";
import type { GameSite } from "../siteGate";
import {
  inReverieFootprint,
  LAMP_LAYOUT,
  REVERIE_CENTER,
  REVERIE_TUNING,
  type ReveriePhase
} from "./layout";
import { LagoonLanterns } from "./lagoonLanterns";
import { MemoryLamps } from "./memoryLamps";
import { ReverieFireflies } from "./fireflies";
import { ReverieNpcs } from "./npcs";
import { CompletionBloom } from "./bloom";
import { ReverieProps } from "./props";
import { LagoonMist } from "./mist";
import { LampThreads } from "./threads";
import { GuidePath } from "./guidePath";
import { LagoonSkiff } from "./skiff";
import { CompletionPetals } from "./petals";

export type ReverieHud = {
  message: (text: string, seconds?: number) => void;
};

/**
 * Palace Reverie — site-gated blue-hour art quest at the Palace of Fine Arts.
 * Walk the peristyle, awaken five memory lamps with E, talk to Inez & Rook,
 * and watch the lagoon bloom when the gallery remembers how to glow.
 */
export class PalaceReverieGame {
  readonly root = new THREE.Group();
  readonly center = REVERIE_CENTER;

  #lanterns: LagoonLanterns;
  #lamps: MemoryLamps;
  #fireflies: ReverieFireflies;
  #npcs: ReverieNpcs;
  #bloom: CompletionBloom;
  #props: ReverieProps;
  #mist: LagoonMist;
  #threads: LampThreads;
  #guide: GuidePath;
  #skiff: LagoonSkiff;
  #petals: CompletionPetals;
  #awake = false;
  #phase: ReveriePhase = "idle";
  #completeHold = 0;

  constructor(map: WorldMap, scene: THREE.Scene) {
    this.root.name = "palace-reverie";
    this.root.visible = false;

    this.#lanterns = new LagoonLanterns(map);
    this.#lamps = new MemoryLamps(map);
    this.#fireflies = new ReverieFireflies();
    this.#npcs = new ReverieNpcs(map);
    this.#bloom = new CompletionBloom();
    this.#props = new ReverieProps(map);
    this.#mist = new LagoonMist();
    this.#threads = new LampThreads();
    this.#guide = new GuidePath(map);
    this.#skiff = new LagoonSkiff();
    this.#petals = new CompletionPetals();

    this.root.add(
      this.#lanterns.group,
      this.#lamps.group,
      this.#fireflies.group,
      this.#npcs.group,
      this.#bloom.group,
      this.#props.group,
      this.#mist.group,
      this.#threads.group,
      this.#guide.group,
      this.#skiff.group,
      this.#petals.group
    );
    scene.add(this.root);
  }

  get phase(): ReveriePhase {
    return this.#phase;
  }

  get litCount(): number {
    return this.#lamps.litCount();
  }

  get totalLamps(): number {
    return LAMP_LAYOUT.length;
  }

  get progress(): number {
    return this.litCount / Math.max(1, this.totalLamps);
  }

  /** Expose for cinematics. */
  get lamps() {
    return this.#lamps;
  }
  get npcs() {
    return this.#npcs;
  }
  get bloom() {
    return this.#bloom;
  }

  siteHooks(): GameSite {
    return {
      id: "palace-reverie",
      contains: (x, z, pad) => inReverieFootprint(x, z, pad),
      activatePad: REVERIE_TUNING.activatePad,
      deactivatePad: REVERIE_TUNING.deactivatePad,
      keepAwake: () => this.#phase === "active" || this.#phase === "complete",
      setAwake: (on) => this.#setAwake(on)
    };
  }

  #setAwake(on: boolean) {
    if (this.#awake === on) return;
    this.#awake = on;
    this.root.visible = on;
    if (on && this.#phase === "idle") {
      this.#phase = "active";
      this.#welcomePending = true;
    }
  }

  #welcomePending = false;

  /** One-shot welcome the main loop can surface when the site first wakes. */
  takeWelcome(): string | null {
    if (!this.#welcomePending) return null;
    this.#welcomePending = false;
    return "Palace Reverie — blue hour on the lagoon. Follow the shore lights to Inez, then wake each peristyle lamp with E.";
  }

  tryInteract(
    player: { position: { x: number; z: number }; mode: string },
    hud: ReverieHud
  ): boolean {
    if (!this.#awake || player.mode !== "walk") return false;
    const { x, z } = player.position;

    const lamp = this.#lamps.tryAwaken(x, z);
    if (lamp) {
      this.#syncProgress();
      if (this.litCount >= this.totalLamps && this.#phase !== "complete") {
        this.#phase = "complete";
        this.#bloom.setComplete(true);
        this.#petals.setComplete(true);
        this.#completeHold = REVERIE_TUNING.completionHoldSeconds;
        hud.message("The Palace of Fine Arts remembers — blue hour is yours. Wander the colonnade as long as you like.", 7.2);
      } else {
        hud.message(`${lamp.whisper} · ${this.litCount}/${this.totalLamps}`, 3.2);
      }
      return true;
    }

    const line = this.#npcs.talk(x, z, this.litCount, this.totalLamps, this.#phase === "complete");
    if (line) {
      hud.message(line, 4.2);
      return true;
    }
    return false;
  }

  /** Near-prompt for the main loop (non-blocking HUD nudge). */
  nearbyPrompt(x: number, z: number): string | null {
    if (!this.#awake) return null;
    if (this.#phase === "complete") {
      const npc = this.#npcs.nearest(x, z, REVERIE_TUNING.promptRadius);
      if (npc) return `E — listen to ${npc.name}`;
      return null;
    }
    const lamp = this.#lamps.nearestUnlit(x, z, REVERIE_TUNING.promptRadius);
    if (lamp) {
      const n = this.litCount;
      if (n === 0) return "E — awaken the first memory lamp";
      if (n === this.totalLamps - 1) return "E — awaken the last lamp";
      return `E — awaken lamp (${n}/${this.totalLamps})`;
    }
    return this.#npcs.promptLine(x, z, this.litCount, this.totalLamps, false);
  }

  #syncProgress() {
    const p = this.progress;
    this.#lanterns.setProgress(p);
    this.#fireflies.setProgress(p);
    this.#mist.setProgress(p);
    this.#guide.setProgress(p);
    this.#skiff.setProgress(p);
    this.#props.setProgress(p);
  }

  /** Cinematic / demo: jump to a progress state. */
  setCinematicProgress(lit: number, complete = false) {
    this.#setAwake(true);
    this.#lamps.forceLit(lit);
    this.#phase = complete ? "complete" : lit > 0 ? "active" : "idle";
    this.#bloom.snap(complete ? 1 : lit / this.totalLamps * (lit >= this.totalLamps ? 0.55 : 0.28));
    this.#bloom.setComplete(complete);
    this.#petals.snap(complete ? 1 : lit >= this.totalLamps ? 0.25 : 0);
    this.#petals.setComplete(complete);
    this.#syncProgress();
  }

  update(dt: number, timeSec: number, playerPos?: { x: number; z: number }, _hud?: ReverieHud) {
    if (!this.#awake) return;

    this.#lamps.update(dt, timeSec);
    if (playerPos) this.#lamps.setInvite(playerPos.x, playerPos.z, timeSec);
    this.#lanterns.update(dt, timeSec);
    this.#fireflies.update(dt, timeSec);
    this.#npcs.update(dt, playerPos?.x, playerPos?.z);
    this.#bloom.update(dt, timeSec);
    this.#mist.update(dt, timeSec);
    this.#threads.update(this.#lamps.lamps, timeSec);
    this.#guide.update(dt, timeSec);
    this.#skiff.update(dt, timeSec);
    this.#petals.update(dt, timeSec);
    this.#props.update(dt, timeSec);

    if (this.#completeHold > 0) this.#completeHold -= dt;
  }

  dispose() {
    this.#lanterns.dispose();
    this.#lamps.dispose();
    this.#fireflies.dispose();
    this.#bloom.dispose();
    this.#mist.dispose();
    this.#threads.dispose();
    this.#guide.dispose();
    this.#skiff.dispose();
    this.#petals.dispose();
    this.#props.dispose();
    this.root.removeFromParent();
  }
}

export function createPalaceReverie(map: WorldMap, scene: THREE.Scene): PalaceReverieGame {
  return new PalaceReverieGame(map, scene);
}
