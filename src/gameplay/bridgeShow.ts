import * as THREE from "three/webgpu";
import type { WorldMap } from "../world/heightmap";
import type { Player } from "../player/player";
import type { Physics } from "../core/physics";
import type { ChaseCamera } from "../core/camera";
import type { LauncherRig } from "./launchers";
import { buildTruckMesh } from "../vehicles/truck";
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
  scene: THREE.Scene;
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

const BOARD_RADIUS = 6.5;
const RESPAWN_DISTANCE = 60; // re-park once the player has driven this far off

function disposeTruck(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) for (const x of mat) x.dispose();
    else mat?.dispose();
  });
}

/**
 * The Golden Gate hero shot as a live, in-game experience. A Freedom Truck sits
 * parked mid-span (its guitarist jamming) right where the map teleports you to
 * the bridge; walk up and press E and the on-rails cinematic runs in real time —
 * the same drive + camera orbit + rocket barrage as the rendered reel — while
 * "rockin" plays from the top. Input stays live throughout, so you can spawn
 * planes, effects, whatever over the top; the shot itself stays on its rails.
 */
export class BridgeShow {
  #deps: BridgeShowDeps;
  #path: BridgePath;
  #parked: { mesh: THREE.Group; rig?: LauncherRig } | null = null;
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
    this.#spawnParked();
  }

  get active(): boolean {
    return this.#active;
  }

  /** Where the parked truck waits (also the map's Golden Gate teleport point). */
  get parkPos(): THREE.Vector3 {
    return this.#path.start;
  }

  /** True while a boardable parked truck is sitting at the span, no show running. */
  nearParked(x: number, z: number, radius = BOARD_RADIUS): boolean {
    if (!this.#parked || this.#active) return false;
    return Math.hypot(this.#path.start.x - x, this.#path.start.z - z) <= radius;
  }

  #spawnParked() {
    const mesh = buildTruckMesh();
    const { start, rideH, yawQ } = this.#path;
    let deck = this.#deps.map.bridgeDeck(start.x, start.z);
    if (!Number.isFinite(deck)) deck = 66;
    mesh.position.set(start.x, deck + rideH, start.z);
    mesh.quaternion.copy(yawQ);
    this.#deps.scene.add(mesh);
    this.#parked = { mesh, rig: mesh.userData.launcherRig as LauncherRig | undefined };
  }

  #removeParked() {
    if (!this.#parked) return;
    this.#parked.mesh.removeFromParent();
    disposeTruck(this.#parked.mesh);
    this.#parked = null;
  }

  /** On-foot E near the parked truck: board it and roll the show. */
  board(): boolean {
    if (!this.#parked || this.#active) return false;
    this.#removeParked();
    const { start, rideH, heading, map } = { ...this.#path, map: this.#deps.map };
    let deck = map.bridgeDeck(start.x, start.z);
    if (!Number.isFinite(deck)) deck = 66;
    this.#deps.player.position.set(start.x, deck + rideH, start.z);
    this.#deps.player.heading = heading + Math.PI; // storage convention is facing+π
    this.#deps.player.trySwitch("truck");
    this.#start();
    return true;
  }

  #start() {
    this.#active = true;
    this.#t = 0;
    this.#fired = false;
    this.#deps.configureEnv();
    // music from the top, at the HUD effects volume
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
    this.#deps.hud.message("🎸 Freedom Truck rolling — the show is live", 3.5);
  }

  #tick(dt: number) {
    // bail if the player jumped out of the truck (they chose to do something else)
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
    this.#deps.hud.message("That's a wrap — drive on, or teleport back to run it again", 3.5);
  }

  #fadeMusic() {
    const a = this.#audio;
    this.#audio = null;
    if (!a) return;
    const step = () => {
      a.volume = Math.max(0, a.volume - 0.08);
      if (a.volume <= 0.001) {
        a.pause();
        clearInterval(id);
      }
    };
    const id = setInterval(step, 60);
  }

  /** Per-frame housekeeping: keep the parked truck alive + re-park after a run. */
  update(dt: number) {
    if (this.#parked) {
      this.#parked.rig?.update(dt); // the waiting guitarist keeps jamming
      return;
    }
    if (this.#active) return;
    // re-park once the player has left, so a return trip always finds it ready
    const p = this.#deps.player.position;
    const far = Math.hypot(this.#path.start.x - p.x, this.#path.start.z - p.z) > RESPAWN_DISTANCE;
    if (this.#deps.player.mode !== "truck" || far) this.#spawnParked();
  }
}
