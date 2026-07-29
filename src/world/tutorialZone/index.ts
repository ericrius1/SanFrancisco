/**
 * The flight school — the tutorial's physical campus on the Crissy Field
 * airfield.
 *
 * The old tutorial was a checklist that narrated over whatever the player
 * happened to be doing. This is the same curriculum with somewhere to do it:
 * bunting gates to walk through, a lane to sprint, a hurdle to clear, a cottage
 * with a door that actually opens, an oval to drive, a bowl to ride and six
 * rings climbing out over the bay.
 *
 * The zone never touches the tutorial UI. It watches the player's body — where
 * they are, how fast, how high — and publishes plain numbers (`gatesPassed`,
 * `lapFraction`, `ringsFlown`). ui/tutorial.ts reads those through its context.
 * That keeps the two independent: the field is a real place whether or not the
 * checklist is open, and the checklist still works if the field never loaded.
 */

import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { WorldMap } from "../heightmap";
import type { GameSite } from "../../gameplay/siteGate";
import {
  BOWL,
  COTTAGE,
  buildFlightRings,
  type FlightRing,
  HURDLE,
  SPRINT,
  STATION_ANCHORS,
  TRACK,
  TRACK_START,
  WALK_GATES,
  WALK_GATE_HALF_WIDTH,
  sampleZoneGrades,
  trackOffset,
  zoneGroundTop,
  zoneLocal,
  zoneWorldX,
  zoneWorldZ,
  type StationId,
  type ZoneGrades
} from "./layout";
import {
  TUTORIAL_ZONE_CENTER,
  TUTORIAL_ZONE_HALF_U,
  TUTORIAL_ZONE_HALF_V
} from "./meta";
import {
  buildBowlDecks,
  buildCottageFloor,
  buildGroundPaint,
  buildTrackDeck,
  createGroundMaterials
} from "./ground";
import { buildZoneProps, createPropMaterials, type ZoneBox } from "./props";

type ZonePlayer = { position: { x: number; y: number; z: number }; mode: string };
type Hud = { message(text: string, seconds?: number): void };

/** Everything the tutorial checklist is allowed to know about the field. */
export type TutorialZoneProgress = {
  /**
   * The field is loaded, awake and measuring this player right now.
   *
   * The checklist needs to tell "you have not done it yet" apart from "nobody
   * is watching" — they look identical in every counter below. This is the only
   * honest source for that: it follows the site gate's own awake flag, so it
   * cannot drift from the pads the way a radius guess in the UI would.
   */
  watching: boolean;
  /** Bunting gates walked through, in order (0…3). */
  gatesPassed: number;
  /** Metres covered inside the sprint lane at a genuine run. */
  sprintMeters: number;
  /** Cleared the hurdle in the air rather than walking round it. */
  hurdleCleared: boolean;
  /** Standing inside the cottage right now. */
  insideCottage: boolean;
  /** Has been inside the cottage at least once. */
  cottageVisited: boolean;
  /** Fraction of a full lap driven on the oval (0…1, keeps counting past 1). */
  lapFraction: number;
  /** Longest airtime off the bowl on the hoverboard, seconds. */
  bowlAir: number;
  /** Flight rings passed, in order (0…6). */
  ringsFlown: number;
  /**
   * Metres to the places a step can send you.
   *
   * A step that says "ollie out of the bowl" is unpassable if you are standing
   * at the oval 100 m away, and the bar sitting at zero cannot tell you that —
   * it looks identical to a trick you keep muffing. These let the checklist
   * walk you to the right end of the field first.
   */
  toStartLine: number;
  toBowl: number;
  toFirstRing: number;
};

// The leaf's local +x runs hinge → free edge, and a positive yaw carries that
// edge to −z, which is into the room. Negative would swing it out across the
// stoop and through whoever just opened it.
const DOOR_OPEN_ANGLE = 1.85;
const DOOR_SWING_RATE = 4.2; // rad/s
const SPRINT_SPEED = 5.6; // m/s — a run, not a walk
const AIR_CLEARANCE = 0.45; // metres off the surface that counts as airborne

export class TutorialZone {
  readonly root = new THREE.Group();

  #map: WorldMap;
  #physics: Physics;
  #grades: ZoneGrades;
  /** The ring course, laid out against the real waterline at construction. */
  #course: FlightRing[];
  #overlay: (x: number, z: number, base: number) => number;
  #groundMats = createGroundMaterials();
  #propMats = createPropMaterials();
  #bodies: number[] = [];
  #doorBody: number | null = null;
  #doorBox: ZoneBox;
  #doorPivot: THREE.Object3D;
  #doorOpen = false;
  #doorAngle = 0;
  #windsock: THREE.Object3D;
  #rings: THREE.Mesh[];
  #awake = true;
  #disposed = false;

  // progress
  #gates = 0;
  #sprint = 0;
  #hurdle = false;
  #inside = false;
  #visited = false;
  #lapSigned = 0;
  #lapAngle: number | null = null;
  #air = 0;
  #airRun = 0;
  #airHinted = false;
  #ringIndex = 0;
  #prev: { x: number; y: number; z: number } | null = null;

  constructor(map: WorldMap, physics: Physics, scene: THREE.Scene) {
    this.#map = map;
    this.#physics = physics;
    this.root.name = "tutorial_zone";

    // Datums first: they must read the ground as it is BEFORE this site's own
    // overlay exists, or every surface would stack on the last one's lift. The
    // ring course is resolved here for the same reason — it hunts the waterline
    // by sampling ground, and the overlay would answer for the field itself.
    this.#grades = sampleZoneGrades(map);
    this.#course = buildFlightRings(map);

    for (const mesh of [
      buildTrackDeck(map, this.#grades, this.#groundMats),
      ...buildBowlDecks(map, this.#grades, this.#groundMats),
      buildCottageFloor(map, this.#grades, this.#groundMats),
      buildGroundPaint(map, this.#grades, this.#groundMats)
    ]) {
      this.root.add(mesh);
    }

    const props = buildZoneProps(map, this.#grades, this.#propMats, this.#course);
    for (const mesh of props.meshes) this.root.add(mesh);
    for (const ring of props.rings) this.root.add(ring);
    this.root.add(props.windsock);
    this.root.add(props.door.pivot);
    this.#doorPivot = props.door.pivot;
    this.#doorBox = props.door.closedBox;
    this.#windsock = props.windsock;
    this.#rings = props.rings;

    // The authored surfaces go live only once their meshes exist, so a frame
    // can never sample raised ground that has nothing drawn on it.
    const grades = this.#grades;
    this.#overlay = (x, z, base) => {
      const u = x - TUTORIAL_ZONE_CENTER.x;
      const v = z - TUTORIAL_ZONE_CENTER.z;
      if (Math.abs(u) > TUTORIAL_ZONE_HALF_U || Math.abs(v) > TUTORIAL_ZONE_HALF_V) return base;
      return zoneGroundTop(u, v, base, grades);
    };
    map.setGroundTopOverlay(this.#overlay);

    for (const box of props.colliders) this.#addBody(box);
    this.#closeDoor(true);

    scene.add(this.root);
  }

  // -- physics --------------------------------------------------------------

  #addBody(box: ZoneBox): number {
    const body = this.#physics.world.createBox({
      type: BodyType.Static,
      position: [box.x, box.y, box.z],
      halfExtents: [box.hx, box.hy, box.hz],
      friction: 0.7
    });
    const quat: [number, number, number, number] = [0, Math.sin(box.yaw / 2), 0, Math.cos(box.yaw / 2)];
    this.#physics.world.setBodyTransform(body, [box.x, box.y, box.z], quat);
    this.#physics.addQuerySolid(body, box);
    this.#bodies.push(body);
    return body;
  }

  #removeBody(handle: number) {
    this.#physics.removeQuerySolid(handle);
    this.#physics.world.destroyBody(handle);
    const i = this.#bodies.indexOf(handle);
    if (i >= 0) this.#bodies.splice(i, 1);
  }

  // -- the door -------------------------------------------------------------

  #closeDoor(immediate = false) {
    this.#doorOpen = false;
    if (this.#doorBody === null) this.#doorBody = this.#addBody(this.#doorBox);
    if (immediate) {
      this.#doorAngle = 0;
      this.#doorPivot.rotation.y = 0;
    }
  }

  #openDoor() {
    this.#doorOpen = true;
    // The solid leaf leaves the world the moment it starts swinging: a player
    // who presses E and walks should never be stopped by a door they opened.
    if (this.#doorBody !== null) {
      this.#removeBody(this.#doorBody);
      this.#doorBody = null;
    }
  }

  /** True when this press was the cottage door's. */
  tryInteract(player: ZonePlayer, hud: Hud): boolean {
    if (!this.#awake || player.mode !== "walk") return false;
    const dx = player.position.x - this.#doorBox.x;
    const dz = player.position.z - this.#doorBox.z;
    if (dx * dx + dz * dz > 3.1 * 3.1) return false;
    if (this.#doorOpen) {
      this.#closeDoor();
      hud.message("Door shut — E opens it again", 2);
    } else {
      this.#openDoor();
      hud.message("Open — step inside", 2.4);
    }
    return true;
  }

  // -- site gate ------------------------------------------------------------

  siteHooks(): GameSite {
    // The pads have to cover the ring course, not just the field. The last hoop
    // is over half a kilometre out over the bay, and a pad that stopped at the
    // lawn would put the site to sleep — freezing ring progress and flipping
    // `watching` off — halfway through the flight it is measuring. Derived from
    // the course so the two cannot drift apart.
    const reach = this.#course.reduce(
      (far, ring) => Math.max(far, Math.hypot(ring.u, ring.v)),
      0
    );
    const activatePad = Math.max(260, reach - Math.min(TUTORIAL_ZONE_HALF_U, TUTORIAL_ZONE_HALF_V) + 120);
    return {
      id: "tutorial-zone",
      contains: (x, z, pad) =>
        Math.abs(x - TUTORIAL_ZONE_CENTER.x) <= TUTORIAL_ZONE_HALF_U + pad &&
        Math.abs(z - TUTORIAL_ZONE_CENTER.z) <= TUTORIAL_ZONE_HALF_V + pad,
      activatePad,
      deactivatePad: activatePad + 90,
      setAwake: (on) => {
        this.#awake = on;
        this.root.visible = on;
      }
    };
  }

  // -- per-frame ------------------------------------------------------------

  update(dt: number, elapsed: number, player: ZonePlayer, hud: Hud | null): void {
    if (this.#disposed || !this.#awake) return;

    // Door swing, always — a door left mid-swing when you walk away should not
    // be frozen there when you come back.
    const target = this.#doorOpen ? DOOR_OPEN_ANGLE : 0;
    if (this.#doorAngle !== target) {
      const step = DOOR_SWING_RATE * dt;
      this.#doorAngle += Math.max(-step, Math.min(step, target - this.#doorAngle));
      if (Math.abs(target - this.#doorAngle) < 0.01) this.#doorAngle = target;
      this.#doorPivot.rotation.y = this.#doorAngle;
    }

    // Windsock: the field's one piece of ambient motion, and the thing the
    // "look around" beat gives you to find.
    this.#windsock.rotation.y = Math.sin(elapsed * 0.21) * 0.6 - 0.4;
    this.#windsock.rotation.x = Math.sin(elapsed * 1.7) * 0.05;

    // Next ring breathes so the course reads as a sequence, not a sculpture.
    const next = this.#rings[this.#ringIndex];
    if (next) next.scale.setScalar(1 + Math.sin(elapsed * 2.4) * 0.04);

    this.#trackProgress(dt, player, hud);
  }

  #trackProgress(dt: number, player: ZonePlayer, hud: Hud | null): void {
    const p = player.position;
    const prev = this.#prev;
    this.#prev = { x: p.x, y: p.y, z: p.z };
    if (!prev || dt <= 0) return;

    const { u, v } = zoneLocal(p.x, p.z);
    const pu = prev.x - TUTORIAL_ZONE_CENTER.x;
    const moved = Math.hypot(p.x - prev.x, p.z - prev.z);
    if (moved > 25) return; // a teleport, not a stride
    const speed = moved / dt;
    const walking = player.mode === "walk";
    const ground = this.#map.groundTop(p.x, p.z);

    // Walk gates: crossing the gate's plane inside its posts, in course order.
    if (walking && this.#gates < WALK_GATES.length) {
      const gate = WALK_GATES[this.#gates];
      const crossed = (pu - gate.u) * (u - gate.u) <= 0 && pu !== u;
      if (crossed && Math.abs(v - gate.v) <= WALK_GATE_HALF_WIDTH) {
        this.#gates++;
        hud?.message(
          this.#gates === WALK_GATES.length ? "All three — the lane is next" : `Gate ${this.#gates} of ${WALK_GATES.length}`,
          1.6
        );
      }
    }

    // Sprint lane: distance at a real running pace, between the bollards.
    if (
      walking &&
      speed >= SPRINT_SPEED &&
      u >= SPRINT.u0 - 1 &&
      u <= SPRINT.u1 + 1 &&
      Math.abs(v - SPRINT.v) <= SPRINT.halfWidth + 1
    ) {
      this.#sprint += moved;
    }

    // Hurdle: over the bar, off the ground.
    if (!this.#hurdle && walking) {
      const crossed = (pu - HURDLE.u) * (u - HURDLE.u) <= 0 && pu !== u;
      if (crossed && Math.abs(v - HURDLE.v) <= HURDLE.halfWidth && p.y - ground > HURDLE.height * 0.5) {
        this.#hurdle = true;
        hud?.message("Cleared it", 1.6);
      }
    }

    // Cottage interior.
    const inside =
      Math.abs(u - COTTAGE.u) < COTTAGE.halfU - 0.1 && Math.abs(v - COTTAGE.v) < COTTAGE.halfV - 0.1;
    if (inside && !this.#inside) {
      this.#visited = true;
      hud?.message("You're inside. Every front door in the city works exactly like this one.", 4);
    }
    this.#inside = inside;

    // Lap: accumulate signed angle around the oval while actually on the ribbon.
    if (player.mode === "drive" && Math.abs(trackOffset(u, v)) <= TRACK.halfWidth + 3.5) {
      const angle = Math.atan2(v - TRACK.cv, u - TRACK.cu);
      if (this.#lapAngle !== null) {
        let delta = angle - this.#lapAngle;
        if (delta > Math.PI) delta -= Math.PI * 2;
        if (delta < -Math.PI) delta += Math.PI * 2;
        // Either way round counts — a newcomer who leaves the line the other
        // way is still driving a lap, and an oval has no wrong end. The sum is
        // signed and reported as its magnitude, so a lap still has to be a real
        // circuit in one direction: doubling back unwinds progress rather than
        // banking it, and jitter at a standstill nets out to nothing.
        if (Math.abs(delta) < 0.6) this.#lapSigned += delta / (Math.PI * 2);
      }
      this.#lapAngle = angle;
    } else {
      this.#lapAngle = null;
    }

    // Bowl air, on the board: track the current flight, keep the best.
    if (player.mode === "board" && Math.hypot(u - BOWL.cu, v - BOWL.cv) <= BOWL.bermRadius) {
      if (p.y - ground > AIR_CLEARANCE) {
        this.#airRun += dt;
        this.#air = Math.max(this.#air, this.#airRun);
        // Getting a little air and seeing nothing happen reads as "this is
        // broken". Say it landed, once, so the bar's job is legible.
        if (!this.#airHinted && this.#air > 0.12) {
          this.#airHinted = true;
          hud?.message("That's air — carry more speed up the wall and hold it", 3);
        }
      } else {
        this.#airRun = 0;
      }
    } else {
      this.#airRun = 0;
    }

    // Flight rings, in order. Tested against the whole step, not the frame's
    // end point: a phoenix at full dive covers metres per frame and would fly
    // clean through a point test.
    const ring = this.#course[this.#ringIndex];
    if (ring) {
      const mesh = this.#rings[this.#ringIndex];
      const cx = zoneWorldX(ring.u);
      const cy = ring.y;
      const cz = zoneWorldZ(ring.v);
      const sx = p.x - prev.x;
      const sy = p.y - prev.y;
      const sz = p.z - prev.z;
      const lenSq = sx * sx + sy * sy + sz * sz;
      const t =
        lenSq > 0
          ? Math.max(0, Math.min(1, ((cx - prev.x) * sx + (cy - prev.y) * sy + (cz - prev.z) * sz) / lenSq))
          : 0;
      const near = Math.hypot(prev.x + sx * t - cx, prev.y + sy * t - cy, prev.z + sz * t - cz);
      if (near <= ring.radius) {
        if (mesh) {
          mesh.material = this.#propMats.ringDone;
          mesh.scale.setScalar(1);
        }
        this.#ringIndex++;
        hud?.message(
          this.#ringIndex === this.#course.length
            ? "Every ring — the city is yours"
            : `Ring ${this.#ringIndex} of ${this.#course.length}`,
          1.6
        );
      }
    }
  }

  /** Prompt at the cottage door, re-issued while you stand there on foot. */
  updatePrompt(player: ZonePlayer, hud: Hud): void {
    if (!this.#awake || this.#doorOpen || player.mode !== "walk") return;
    const dx = player.position.x - this.#doorBox.x;
    const dz = player.position.z - this.#doorBox.z;
    if (dx * dx + dz * dz > 3.1 * 3.1) return;
    hud.message("E — open the door", 0.2);
  }

  // -- readouts -------------------------------------------------------------

  /** Ground-plane metres from the last known player position to a local point. */
  #distanceTo(u: number, v: number): number {
    const p = this.#prev;
    if (!p) return Infinity;
    return Math.hypot(p.x - zoneWorldX(u), p.z - zoneWorldZ(v));
  }

  get progress(): TutorialZoneProgress {
    const firstRing = this.#course[0];
    return {
      watching: this.#awake && !this.#disposed,
      gatesPassed: this.#gates,
      sprintMeters: this.#sprint,
      hurdleCleared: this.#hurdle,
      insideCottage: this.#inside,
      cottageVisited: this.#visited,
      lapFraction: Math.abs(this.#lapSigned),
      bowlAir: this.#air,
      ringsFlown: this.#ringIndex,
      toStartLine: this.#distanceTo(TRACK_START.u, TRACK_START.v),
      toBowl: this.#distanceTo(BOWL.cu, BOWL.cv),
      toFirstRing: this.#distanceTo(firstRing.u, firstRing.v)
    };
  }

  /** World position of a station, for the checklist's "head to…" hints. */
  station(id: StationId): { x: number; z: number } {
    const anchor = STATION_ANCHORS[id];
    return { x: zoneWorldX(anchor.u), z: zoneWorldZ(anchor.v) };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#map.clearGroundTopOverlay(this.#overlay);
    for (const handle of [...this.#bodies]) this.#removeBody(handle);
    this.#doorBody = null;
    this.root.removeFromParent();
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry.dispose();
    });
    for (const material of [...Object.values(this.#groundMats), ...Object.values(this.#propMats)]) {
      material.dispose();
    }
  }
}

export function createTutorialZone(map: WorldMap, physics: Physics, scene: THREE.Scene): TutorialZone {
  return new TutorialZone(map, physics, scene);
}

export { TUTORIAL_ZONE_ARRIVAL, TUTORIAL_ZONE_CENTER } from "./meta";
