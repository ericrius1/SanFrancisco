import * as THREE from "three/webgpu";
import type { WorldMap } from "../world/heightmap";
import type { Player } from "../player/player";
import type { Physics } from "../core/physics";
import type { ChaseCamera } from "../core/camera";
import {
  BRIDGE_SHOT_SECONDS,
  BRIDGE_FIRE_AT,
  bridgePath,
  bridgeTruckPos,
  applyBridgeCamera,
  pinBridgeTruck,
  type BridgePath
} from "./bridgeShot";

export type BridgeShowDeps = {
  map: WorldMap;
  player: Player;
  physics: Physics;
  chase: ChaseCamera;
  hud: { message: (text: string, seconds?: number) => void };
  effectsLevel: () => number;
  /** Fire the player truck's whole rocket battery down `fwd`. */
  fireGuns: (fwd: THREE.Vector3) => void;
  /** Install/clear the cinematic hook that owns truck pose + camera each frame. */
  setCine: (fn: ((dt: number) => void) | null) => void;
  /** Twilight + exposure + stylized post-fx for the shot. */
  configureEnv: () => void;
  /** Undo the post-fx stylization once the show ends (keeps twilight). */
  restoreEnv: () => void;
  musicUrl: string;
};

/**
 * The Golden Gate "Freedom Truck" hero shot, made live. One keypress (`]`) drops
 * you onto the main span in the truck and rolls the EXACT rendered shot in real
 * time — same drive, same camera orbit (you don't steer it), same rocket barrage
 * — with "rockin" from the top. Input stays live throughout, so you can spawn
 * planes, paint, whatever over the top; the shot itself never leaves its rails.
 * Press `]` again to restart it; press E (hop out) to drop out early.
 */
export class BridgeShow {
  #deps: BridgeShowDeps;
  #path: BridgePath;
  #active = false;
  #t = 0;
  #fired = false;
  #audio: HTMLAudioElement | null = null;
  #truckPos = new THREE.Vector3();
  #camPos = new THREE.Vector3();
  #look = new THREE.Vector3();

  constructor(deps: BridgeShowDeps) {
    this.#deps = deps;
    this.#path = bridgePath(deps.map);
  }

  get active(): boolean {
    return this.#active;
  }

  /** `]` — teleport onto the span in the truck and (re)start the exact shot at T=0. */
  trigger() {
    const { start, rideH, heading } = this.#path;
    let deck = this.#deps.map.bridgeDeck(start.x, start.z);
    if (!Number.isFinite(deck)) deck = 66;
    this.#deps.player.position.set(start.x, deck + rideH, start.z);
    this.#deps.player.heading = heading + Math.PI; // storage convention is facing+π
    if (this.#deps.player.mode !== "truck") this.#deps.player.trySwitch("truck");
    // snap truck + camera to frame 0 so there's no one-frame chase-cam pop
    bridgeTruckPos(0, this.#path, this.#deps.map, this.#truckPos);
    pinBridgeTruck(this.#deps.player, this.#deps.physics, this.#truckPos, this.#path);
    applyBridgeCamera(0, this.#path, this.#truckPos, this.#deps.chase.camera, this.#camPos, this.#look);
    this.#start();
  }

  #start() {
    this.#fadeMusic(); // silence any prior run before layering a new one
    this.#active = true;
    this.#t = 0;
    this.#fired = false;
    this.#deps.configureEnv();
    try {
      const a = new Audio(this.#deps.musicUrl);
      a.volume = Math.max(0, Math.min(1, this.#deps.effectsLevel()));
      a.currentTime = 0;
      void a.play().catch(() => {});
      this.#audio = a;
    } catch {
      this.#audio = null;
    }
    this.#deps.setCine((dt) => this.#tick(dt));
    this.#deps.hud.message("🎸 Golden Gate show rolling — ] restarts, E hops out", 3.5);
  }

  #tick(dt: number) {
    // bail if the player hopped out of the truck to go do something else
    if (this.#deps.player.mode !== "truck") {
      this.stop();
      return;
    }
    this.#t += dt;
    const T = this.#t;
    bridgeTruckPos(T, this.#path, this.#deps.map, this.#truckPos);
    pinBridgeTruck(this.#deps.player, this.#deps.physics, this.#truckPos, this.#path);
    applyBridgeCamera(T, this.#path, this.#truckPos, this.#deps.chase.camera, this.#camPos, this.#look);
    if (!this.#fired && T >= BRIDGE_FIRE_AT) {
      this.#fired = true;
      this.#deps.fireGuns(this.#path.dir.clone());
    }
    if (T >= BRIDGE_SHOT_SECONDS) this.stop();
  }

  stop() {
    if (!this.#active) return;
    this.#active = false;
    this.#deps.setCine(null); // hand the camera back to the chase cam
    this.#fadeMusic();
    this.#deps.restoreEnv();
    this.#deps.hud.message("That's a wrap — drive on, or ] to run it again", 3.5);
  }

  #fadeMusic() {
    const a = this.#audio;
    this.#audio = null;
    if (!a) return;
    const id = setInterval(() => {
      a.volume = Math.max(0, a.volume - 0.08);
      if (a.volume <= 0.001) {
        a.pause();
        clearInterval(id);
      }
    }, 60);
  }
}
