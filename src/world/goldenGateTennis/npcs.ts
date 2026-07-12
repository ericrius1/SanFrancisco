import * as THREE from "three/webgpu";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseIdle, poseWalk, setRigClasp, type Rig } from "../../player/rig";
import {
  CLUBHOUSE_DOOR_EAST,
  CLUBHOUSE_FRAME,
  clubhouseToWorld
} from "./clubhouse";

/**
 * Clubhouse life: a receptionist parked behind the desk plus a handful of
 * members milling between the lobby, the pro shop, the benches and the court
 * gate outside — the busker gating pattern (small anim radius, hysteresis
 * show/hide, matrices frozen while asleep) so all of it costs one hypot when
 * the player is elsewhere in the park.
 *
 * Deterministic seeds -> stable outfits across sessions. At night the crowd
 * thins to the receptionist and one straggler (daylight provider optional;
 * defaults to always-day).
 */

const ANIM_RADIUS = 60; // animate inside this
const SHOW_RADIUS = 75; // wake hysteresis
const HIDE_RADIUS = 90;
const RIG_HIP_HEIGHT = 0.93; // rig group origin over the feet (remotes.ts convention)
const WALK_SPEED = 1.12; // unhurried, post-match
const STRIDE_RATE = 5.0; // stride phase per second at walk speed

// Waypoints in the clubhouse local frame (+u east toward the courts, +v south
// along the bar). `y` is filled at build time: floor inside, terrain outside.
// The routes were chosen against the furniture colliders in clubhouse.ts —
// legs between them stay in the open corridor (u roughly 1..3) or outside.
type WaypointSpec = {
  u: number;
  v: number;
  outside?: boolean;
  /** local facing direction to settle into on arrival */
  face?: readonly [number, number];
  /** index of the waypoint a chatter at this spot turns toward */
  chatWith?: number;
};

const WAYPOINTS: readonly WaypointSpec[] = [
  { u: 2.3, v: -11.0 }, // 0 lobby
  { u: 0.9, v: -13.6, face: [-1, 0] }, // 1 reception counter (face the desk)
  { u: -2.4, v: -3.0, face: [-1, 0] }, // 2 trophy case
  { u: 2.5, v: 3.0, face: [-1, 0] }, // 3 bench A
  { u: 2.5, v: 9.6, face: [-1, 0] }, // 4 bench B
  { u: 1.6, v: 15.3, chatWith: 6 }, // 5 chat spot (pairs with 6)
  { u: 1.6, v: 17.1, chatWith: 5 }, // 6 chat spot (pairs with 5)
  { u: -2.2, v: 21.5, face: [-1, 0] }, // 7 pro shop browse
  { u: 1.5, v: -22.0 }, // 8 quiet north nook
  { u: 3.1, v: CLUBHOUSE_DOOR_EAST.v }, // 9 court door, inside
  { u: 5.8, v: CLUBHOUSE_DOOR_EAST.v, outside: true }, // 10 court door, outside
  { u: 7.3, v: -7.6, outside: true }, // 11 clubhouse-court-link path
  { u: 8.2, v: -18.5, outside: true } // 12 fence line by court 10
] as const;
const DOOR_IN = 9;
const DOOR_OUT = 10;

type Waypoint = WaypointSpec & { y: number };

type MillingNpc = {
  rig: Rig;
  seed: string;
  rand: () => number;
  state: "idle" | "walk";
  timer: number;
  at: number; // waypoint index while idle
  path: Waypoint[];
  seg: number;
  segT: number;
  u: number;
  v: number;
  y: number;
  yaw: number;
  stride: number;
  idlePhase: number;
  /** hidden after dark */
  nightOff: boolean;
};

export type ClubhouseNpcOptions = {
  /** Interior walking surface (world y) from the clubhouse build. */
  floorTop: number;
  /** Post-overlay ground sampler for the outdoor waypoints. */
  groundTop: (x: number, z: number) => number;
  /** Day/night provider; omitted = always day (full crowd). */
  daylight?: () => boolean;
};

function mulberry(seedString: string): () => number {
  let s = 0;
  for (let i = 0; i < seedString.length; i++) s = (Math.imul(s, 31) + seedString.charCodeAt(i)) | 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) | 0;
    return ((s >>> 9) & 0x7fffff) / 0x800000;
  };
}

function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Rig faces local -Z; yaw that walks/looks along local direction (du, dv). */
function facingYaw(du: number, dv: number): number {
  return Math.atan2(-du, -dv);
}

/** Hand-me-down racket prop for a couple of the members: box handle +
 * flattened torus head, clasped in the right mitt. Poses never touch hand
 * children, so it rides every gait for free. */
function buildRacketProp(material: THREE.Material): THREE.Group {
  const group = new THREE.Group();
  group.name = "npc-racket";
  const handle = new THREE.Mesh(new THREE.BoxGeometry(0.032, 0.3, 0.032), material);
  handle.position.y = -0.12;
  handle.castShadow = false;
  const head = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.016, 6, 14), material);
  head.scale.set(1, 1.3, 1);
  head.rotation.y = Math.PI / 2;
  head.position.y = -0.4;
  head.castShadow = false;
  group.add(handle, head);
  group.rotation.x = -0.35; // hangs down-forward from the relaxed arm
  return group;
}

export class ClubhouseNpcs {
  readonly group = new THREE.Group();

  #receptionist: Rig;
  #members: MillingNpc[] = [];
  #waypoints: Waypoint[];
  #occupied = new Set<number>();
  #daylight?: () => boolean;
  #day = true;
  #dayTimer = 0;
  #racketMat = new THREE.MeshStandardMaterial({ color: 0x33373d, roughness: 0.55, metalness: 0.3 });

  constructor(options: ClubhouseNpcOptions) {
    this.group.name = "goldman_clubhouse_npcs";
    this.#daylight = options.daylight;

    // NPC positions live in the clubhouse local frame; y stays world-absolute
    // because the frame only yaws about Y.
    this.group.position.set(CLUBHOUSE_FRAME.cx, 0, CLUBHOUSE_FRAME.cz);
    this.group.rotation.y = CLUBHOUSE_FRAME.yaw;

    this.#waypoints = WAYPOINTS.map((spec) => {
      if (!spec.outside) return { ...spec, y: options.floorTop };
      const p = clubhouseToWorld(spec.u, spec.v);
      return { ...spec, y: options.groundTop(p.x, p.z) };
    });

    // Receptionist: parked behind the desk, facing the court entry all day.
    this.#receptionist = buildRig(avatarFromSeed("goldman-clubhouse-reception"));
    this.#receptionist.group.position.set(-1.75, options.floorTop + RIG_HIP_HEIGHT, -13.5);
    this.#receptionist.group.rotation.y = facingYaw(1, -0.12);
    this.group.add(this.#receptionist.group);

    // Members milling pre/post game. Fixed seeds = stable outfits; staggered
    // start waypoints so the room reads occupied from the first frame.
    const starts = [3, 5, 6, 11];
    for (let i = 0; i < 4; i++) {
      const seed = `goldman-clubhouse-member-${i + 1}`;
      const rig = buildRig(avatarFromSeed(seed));
      const rand = mulberry(seed);
      const wp = this.#waypoints[starts[i]];
      const npc: MillingNpc = {
        rig,
        seed,
        rand,
        state: "idle",
        timer: 2 + rand() * 6,
        at: starts[i],
        path: [],
        seg: 0,
        segT: 0,
        u: wp.u,
        v: wp.v,
        y: wp.y,
        yaw: this.#arrivalYaw(wp, rand),
        stride: rand() * Math.PI * 2,
        idlePhase: rand() * 10,
        nightOff: i > 0 // after dark only member-1 lingers
      };
      this.#occupied.add(starts[i]);
      rig.group.position.set(npc.u, npc.y + RIG_HIP_HEIGHT, npc.v);
      rig.group.rotation.y = npc.yaw;
      this.group.add(rig.group);
      if (i % 2 === 0) {
        // two of them carry rackets — clearly pre/post game, not staff
        rig.handR.add(buildRacketProp(this.#racketMat));
        setRigClasp(rig, "R", 1);
      }
      this.#members.push(npc);
    }
  }

  /** Per-frame driver. ZERO work when the player is far: one square distance
   * and out. Matrices refresh manually — the site root is frozen out of the
   * scene's matrix pass. */
  update(dt: number, elapsed: number, px: number, pz: number) {
    const dx = px - CLUBHOUSE_FRAME.cx;
    const dz = pz - CLUBHOUSE_FRAME.cz;
    const d2 = dx * dx + dz * dz;
    if (this.group.visible) {
      if (d2 > HIDE_RADIUS * HIDE_RADIUS) {
        this.group.visible = false;
        return;
      }
    } else if (d2 < SHOW_RADIUS * SHOW_RADIUS) {
      this.group.visible = true;
    } else {
      return;
    }
    if (d2 > ANIM_RADIUS * ANIM_RADIUS) return; // visible but frozen mid-pose

    dt = Math.min(dt, 0.1);

    // day/night census, rechecked on a slow timer
    this.#dayTimer -= dt;
    if (this.#dayTimer <= 0) {
      this.#dayTimer = 2;
      const day = this.#daylight ? this.#daylight() : true;
      if (day !== this.#day) {
        this.#day = day;
        for (const npc of this.#members) {
          if (npc.nightOff) npc.rig.group.visible = day;
        }
      }
    }

    poseIdle(this.#receptionist, elapsed);
    for (const npc of this.#members) {
      if (!npc.rig.group.visible) continue;
      this.#updateMember(npc, dt, elapsed);
    }

    // parent site group has matrixWorldAutoUpdate=false, so force our subtree
    this.group.updateMatrixWorld(true);
  }

  dispose() {
    // Rig geometries come from rig.ts's shared cache (the player uses the same
    // boxes) — dispose materials only, and detach before the site's traverse.
    this.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) material.dispose();
    });
    this.group.removeFromParent();
  }

  #arrivalYaw(wp: Waypoint, rand: () => number): number {
    if (wp.chatWith !== undefined) {
      const other = WAYPOINTS[wp.chatWith];
      return facingYaw(other.u - wp.u, other.v - wp.v);
    }
    if (wp.face) return facingYaw(wp.face[0], wp.face[1]);
    return rand() * Math.PI * 2;
  }

  #updateMember(npc: MillingNpc, dt: number, elapsed: number) {
    if (npc.state === "idle") {
      poseIdle(npc.rig, elapsed + npc.idlePhase);
      npc.timer -= dt;
      if (npc.timer > 0) return;
      const dest = this.#pickDestination(npc);
      if (dest < 0) {
        npc.timer = 2 + npc.rand() * 3;
        return;
      }
      this.#occupied.delete(npc.at);
      this.#occupied.add(dest);
      npc.path = this.#route(npc.at, dest);
      npc.at = dest;
      npc.seg = 0;
      npc.segT = 0;
      npc.state = "walk";
      return;
    }

    // walk the current leg
    const from = npc.path[npc.seg];
    const to = npc.path[npc.seg + 1];
    const du = to.u - from.u;
    const dv = to.v - from.v;
    const length = Math.hypot(du, dv) || 1e-4;
    npc.segT = Math.min(1, npc.segT + (dt * WALK_SPEED) / length);
    npc.u = from.u + du * npc.segT;
    npc.v = from.v + dv * npc.segT;
    npc.y = from.y + (to.y - from.y) * npc.segT;
    const targetYaw = facingYaw(du, dv);
    npc.yaw += wrapAngle(targetYaw - npc.yaw) * Math.min(1, dt * 9);
    npc.stride += dt * STRIDE_RATE;
    poseWalk(npc.rig, npc.stride, 0);

    if (npc.segT >= 1) {
      if (npc.seg + 1 < npc.path.length - 1) {
        npc.seg++;
        npc.segT = 0;
      } else {
        const wp = this.#waypoints[npc.at];
        npc.state = "idle";
        // chat pairs linger; solo stops are shorter
        npc.timer = wp.chatWith !== undefined ? 9 + npc.rand() * 8 : 4 + npc.rand() * 6;
        npc.yaw = this.#arrivalYaw(wp, npc.rand);
      }
    }

    npc.rig.group.position.set(npc.u, npc.y + RIG_HIP_HEIGHT, npc.v);
    npc.rig.group.rotation.y = npc.yaw;
  }

  #pickDestination(npc: MillingNpc): number {
    for (let attempt = 0; attempt < 6; attempt++) {
      const preferOutside = npc.rand() < 0.28;
      const index = Math.floor(npc.rand() * this.#waypoints.length) % this.#waypoints.length;
      const wp = this.#waypoints[index];
      if (index === npc.at || index === DOOR_IN || index === DOOR_OUT) continue;
      if (this.#occupied.has(index)) continue;
      if (!!wp.outside !== preferOutside && attempt < 3) continue;
      // a chat spot is only worth walking to when the partner spot is manned
      if (wp.chatWith !== undefined && !this.#occupied.has(wp.chatWith) && npc.rand() < 0.6) continue;
      return index;
    }
    return -1;
  }

  /** Straight legs, except inside<->outside always threads the court door. */
  #route(fromIdx: number, toIdx: number): Waypoint[] {
    const from = this.#waypoints[fromIdx];
    const to = this.#waypoints[toIdx];
    const start = { ...from };
    if (!!from.outside === !!to.outside) return [start, to];
    const door = from.outside
      ? [this.#waypoints[DOOR_OUT], this.#waypoints[DOOR_IN]]
      : [this.#waypoints[DOOR_IN], this.#waypoints[DOOR_OUT]];
    return [start, ...door, to];
  }
}

export function createClubhouseNpcs(options: ClubhouseNpcOptions): ClubhouseNpcs {
  return new ClubhouseNpcs(options);
}
