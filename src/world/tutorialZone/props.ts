/**
 * Every prop on the field, baked in WORLD space and merged into one mesh per
 * material — the archery range's recipe, for the same reason: a teaching field
 * has a lot of small objects on it, and a newcomer's first frame should not
 * cost sixty draw calls.
 *
 * The pieces that move (the cottage door, the windsock, the flight rings) stay
 * separate meshes, because they are the pieces the tutorial actually animates.
 */

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { enableLocalShadowLayer } from "../shadows/shadowLayers";
import {
  BOWL,
  BOWL_RAIL,
  COTTAGE,
  ENTRANCE,
  type FlightRing,
  HURDLE,
  SPRINT,
  TRACK,
  TRACK_CONE_ANGLES,
  TRACK_START,
  WALK_GATES,
  WALK_GATE_HALF_WIDTH,
  WINDSOCK,
  zoneGroundTop,
  zoneWorldX,
  zoneWorldZ,
  type ZoneGrades
} from "./layout";

type Ground = { groundTop(x: number, z: number): number };

/** Collider box in world space, as physics.createBox wants it. */
export type ZoneBox = { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number };

export function createPropMaterials() {
  return {
    wood: new THREE.MeshStandardMaterial({ color: 0x8a5f3c, roughness: 0.86, metalness: 0 }),
    woodPale: new THREE.MeshStandardMaterial({ color: 0xd8cbb0, roughness: 0.8, metalness: 0 }),
    canvas: new THREE.MeshStandardMaterial({ color: 0xd94f2b, roughness: 0.9, metalness: 0 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.42, metalness: 0.75 }),
    hay: new THREE.MeshStandardMaterial({ color: 0xc9ad63, roughness: 0.95, metalness: 0 }),
    cone: new THREE.MeshStandardMaterial({ color: 0xff6a1f, roughness: 0.72, metalness: 0 }),
    sock: new THREE.MeshStandardMaterial({
      color: 0xff7a2f,
      roughness: 0.92,
      metalness: 0,
      side: THREE.DoubleSide
    }),
    slate: new THREE.MeshStandardMaterial({ color: 0x2a3230, roughness: 0.85, metalness: 0 }),
    ring: new THREE.MeshStandardMaterial({
      color: 0x2fd4ff,
      emissive: new THREE.Color(0x1d6f8c),
      emissiveIntensity: 1.4,
      roughness: 0.35,
      metalness: 0.1
    }),
    ringDone: new THREE.MeshStandardMaterial({
      color: 0xffd166,
      emissive: new THREE.Color(0xb8791d),
      emissiveIntensity: 2.2,
      roughness: 0.3,
      metalness: 0.1
    })
  };
}

export type PropMaterials = ReturnType<typeof createPropMaterials>;

// Build-time scratch — this module runs once per site construction.
const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const P = new THREE.Vector3();
const S = new THREE.Vector3();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

type Bucket = Map<THREE.Material, THREE.BufferGeometry[]>;

function push(bucket: Bucket, material: THREE.Material, geometry: THREE.BufferGeometry) {
  const list = bucket.get(material);
  if (list) list.push(geometry);
  else bucket.set(material, [geometry]);
}

/** A world-space box, in local zone coordinates, resting `y` above ground. */
function boxAt(
  bucket: Bucket,
  material: THREE.Material,
  u: number,
  v: number,
  y: number,
  su: number,
  sy: number,
  sv: number,
  yaw = 0
) {
  const geometry = new THREE.BoxGeometry(su, sy, sv);
  P.set(zoneWorldX(u), y, zoneWorldZ(v));
  Q.setFromAxisAngle(Y_AXIS, yaw);
  S.set(1, 1, 1);
  M.compose(P, Q, S);
  geometry.applyMatrix4(M);
  push(bucket, material, geometry);
}

function cylinderAt(
  bucket: Bucket,
  material: THREE.Material,
  u: number,
  v: number,
  y: number,
  radius: number,
  height: number,
  segments = 10
) {
  const geometry = new THREE.CylinderGeometry(radius, radius, height, segments);
  geometry.translate(zoneWorldX(u), y, zoneWorldZ(v));
  push(bucket, material, geometry);
}

function mergeBucket(bucket: Bucket, name: string, casting: ReadonlySet<THREE.Material>): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const [material, geometries] of bucket) {
    const merged = mergeGeometries(geometries, false);
    for (const g of geometries) g.dispose();
    if (!merged) continue;
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = `${name}_${(material as THREE.Material & { color?: THREE.Color }).color?.getHexString() ?? "part"}`;
    mesh.receiveShadow = true;
    if (casting.has(material)) {
      mesh.castShadow = true;
      enableLocalShadowLayer(mesh);
    }
    out.push(mesh);
  }
  return out;
}

export type ZoneProps = {
  /** Merged static geometry — add straight to the site root. */
  meshes: THREE.Mesh[];
  /** Solid boxes the player collides with (cottage shell + hurdle). */
  colliders: ZoneBox[];
  /** The swinging door leaf, its hinge pivot, and the opening it fills. */
  door: {
    pivot: THREE.Object3D;
    /** World-space box that seals the doorway while the door is shut. */
    closedBox: ZoneBox;
  };
  /** Windsock, so the wind can turn it. */
  windsock: THREE.Object3D;
  /** One mesh per flight ring, in course order. */
  rings: THREE.Mesh[];
};

export function buildZoneProps(
  map: Ground,
  grades: ZoneGrades,
  mats: PropMaterials,
  ringCourse: readonly FlightRing[]
): ZoneProps {
  const bucket: Bucket = new Map();
  const colliders: ZoneBox[] = [];
  const top = (u: number, v: number) =>
    zoneGroundTop(u, v, map.groundTop(zoneWorldX(u), zoneWorldZ(v)), grades);

  // -- entrance arch --------------------------------------------------------
  {
    const { u, v, width, height } = ENTRANCE;
    const g = top(u, v);
    for (const side of [-1, 1]) {
      boxAt(bucket, mats.wood, u, v + (side * width) / 2, g + height / 2, 0.42, height, 0.42);
    }
    boxAt(bucket, mats.wood, u, v, g + height - 0.3, 0.5, 0.6, width + 0.5);
    // Signboard hanging under the lintel: a painted panel in a pale frame.
    // Nothing prints text out here, so the panel has to read as paint — a dark
    // inset just looks like a hole cut in the sky.
    boxAt(bucket, mats.woodPale, u, v, g + height - 1.35, 0.16, 1.25, 5.4);
    boxAt(bucket, mats.canvas, u - 0.1, v, g + height - 1.35, 0.04, 0.92, 4.9);
  }

  // -- walk gates -----------------------------------------------------------
  for (const gate of WALK_GATES) {
    const g = top(gate.u, gate.v);
    for (const side of [-1, 1]) {
      cylinderAt(bucket, mats.wood, gate.u, gate.v + side * WALK_GATE_HALF_WIDTH, g + 1.45, 0.075, 2.9);
    }
    // A slim pennant strip, not a beam — a chunky crossbar at head height
    // reads as a table you have to duck under.
    boxAt(bucket, mats.canvas, gate.u, gate.v, g + 2.78, 0.05, 0.18, WALK_GATE_HALF_WIDTH * 2);
  }

  // -- windsock -------------------------------------------------------------
  const windsock = new THREE.Object3D();
  {
    const g = top(WINDSOCK.u, WINDSOCK.v);
    cylinderAt(bucket, mats.metal, WINDSOCK.u, WINDSOCK.v, g + WINDSOCK.height / 2, 0.12, WINDSOCK.height, 8);
    windsock.position.set(zoneWorldX(WINDSOCK.u), g + WINDSOCK.height - 0.35, zoneWorldZ(WINDSOCK.v));
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.62, 3.1, 12, 1, true), mats.sock);
    sock.name = "tutorial_windsock_sock";
    // Cone points +Y by default; lay it along +Z with the mouth at the mast.
    sock.rotation.x = Math.PI / 2;
    sock.position.set(0, 0, 1.55);
    sock.castShadow = false;
    windsock.add(sock);
  }

  // -- sprint lane + bollards ----------------------------------------------
  for (const u of [SPRINT.u0, SPRINT.u1]) {
    const g = top(u, SPRINT.v);
    for (const side of [-1, 1]) {
      cylinderAt(bucket, mats.woodPale, u, SPRINT.v + side * SPRINT.halfWidth, g + 0.55, 0.12, 1.1, 8);
      boxAt(bucket, mats.canvas, u, SPRINT.v + side * SPRINT.halfWidth, g + 1.16, 0.3, 0.14, 0.3);
    }
  }

  // -- hurdle ---------------------------------------------------------------
  {
    const g = top(HURDLE.u, HURDLE.v);
    for (const side of [-1, 1]) {
      boxAt(bucket, mats.hay, HURDLE.u, HURDLE.v + side * 1.7, g + HURDLE.height / 2, 1.1, HURDLE.height, 1.6);
    }
    boxAt(bucket, mats.wood, HURDLE.u, HURDLE.v, g + HURDLE.height + 0.06, 0.16, 0.12, HURDLE.halfWidth * 2);
    colliders.push({
      x: zoneWorldX(HURDLE.u),
      y: g + HURDLE.height / 2,
      z: zoneWorldZ(HURDLE.v),
      hx: 0.62,
      hy: HURDLE.height / 2,
      hz: HURDLE.halfWidth,
      yaw: 0
    });
  }

  // -- the cottage ----------------------------------------------------------
  const doorPivot = new THREE.Object3D();
  let closedBox: ZoneBox;
  {
    const floor = top(COTTAGE.u, COTTAGE.v);
    const h = COTTAGE.wallHeight;
    const halfU = COTTAGE.halfU;
    const halfV = COTTAGE.halfV;
    const t = COTTAGE.wall;
    const wallY = floor + h / 2;
    const addWall = (u: number, v: number, su: number, sv: number) => {
      boxAt(bucket, mats.woodPale, u, v, wallY, su, h, sv);
      colliders.push({
        x: zoneWorldX(u),
        y: wallY,
        z: zoneWorldZ(v),
        hx: su / 2,
        hy: h / 2,
        hz: sv / 2,
        yaw: 0
      });
    };
    // North, east and west walls are solid; the south wall is split around the
    // doorway, with a header above it.
    addWall(COTTAGE.u, COTTAGE.v - halfV, halfU * 2 + t * 2, t);
    addWall(COTTAGE.u - halfU, COTTAGE.v, t, halfV * 2);
    addWall(COTTAGE.u + halfU, COTTAGE.v, t, halfV * 2);
    const jamb = (halfU * 2 - COTTAGE.doorWidth) / 2;
    for (const side of [-1, 1]) {
      addWall(
        COTTAGE.u + side * (COTTAGE.doorWidth / 2 + jamb / 2),
        COTTAGE.v + halfV,
        jamb,
        t
      );
    }
    boxAt(
      bucket,
      mats.woodPale,
      COTTAGE.u,
      COTTAGE.v + halfV,
      floor + COTTAGE.doorHeight + (h - COTTAGE.doorHeight) / 2,
      COTTAGE.doorWidth,
      h - COTTAGE.doorHeight,
      t
    );
    colliders.push({
      x: zoneWorldX(COTTAGE.u),
      y: floor + COTTAGE.doorHeight + (h - COTTAGE.doorHeight) / 2,
      z: zoneWorldZ(COTTAGE.v + halfV),
      hx: COTTAGE.doorWidth / 2,
      hy: (h - COTTAGE.doorHeight) / 2,
      hz: t / 2,
      yaw: 0
    });
    // Gable roof: two slabs leaning on a ridge beam. Each slab spans ridge →
    // eave exactly once, and tilts so its OUTBOARD edge is the low one — get
    // either wrong and the roof opens upward like a book.
    const eave = floor + h;
    const ridge = 1.5;
    const run = halfV + 0.4;
    for (const side of [-1, 1]) {
      const slab = new THREE.BoxGeometry(halfU * 2 + 1.1, 0.16, Math.hypot(run, ridge));
      P.set(zoneWorldX(COTTAGE.u), eave + ridge / 2, zoneWorldZ(COTTAGE.v + (side * run) / 2));
      // Rotating +θ about X drops the slab's +z end, so the south slab (+1)
      // takes a positive angle and the north slab a negative one.
      Q.setFromAxisAngle(new THREE.Vector3(1, 0, 0), side * Math.atan2(ridge, run));
      S.set(1, 1, 1);
      M.compose(P, Q, S);
      slab.applyMatrix4(M);
      push(bucket, mats.wood, slab);
    }
    // Interior: a chalkboard on the back wall and a lamp over it.
    boxAt(bucket, mats.slate, COTTAGE.u, COTTAGE.v - halfV + 0.2, floor + 1.7, 3.2, 1.5, 0.08);
    boxAt(bucket, mats.wood, COTTAGE.u, COTTAGE.v - halfV + 0.24, floor + 0.92, 3.4, 0.1, 0.18);
    cylinderAt(bucket, mats.metal, COTTAGE.u, COTTAGE.v, floor + h - 0.28, 0.28, 0.16, 12);

    // The leaf: hinged on the west jamb, swinging inward.
    const hingeU = COTTAGE.doorU - COTTAGE.doorWidth / 2;
    doorPivot.position.set(zoneWorldX(hingeU), floor, zoneWorldZ(COTTAGE.v + halfV));
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(COTTAGE.doorWidth, COTTAGE.doorHeight, 0.09),
      mats.wood
    );
    leaf.name = "tutorial_cottage_door";
    // Local +x runs from the hinge to the free edge, so the pivot's yaw is the
    // swing angle directly.
    leaf.position.set(COTTAGE.doorWidth / 2, COTTAGE.doorHeight / 2, 0);
    leaf.castShadow = true;
    enableLocalShadowLayer(leaf);
    doorPivot.add(leaf);
    const handle = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), mats.metal);
    handle.position.set(COTTAGE.doorWidth - 0.18, COTTAGE.doorHeight / 2, 0.09);
    doorPivot.add(handle);

    closedBox = {
      x: zoneWorldX(COTTAGE.doorU),
      y: floor + COTTAGE.doorHeight / 2,
      z: zoneWorldZ(COTTAGE.v + halfV),
      hx: COTTAGE.doorWidth / 2,
      hy: COTTAGE.doorHeight / 2,
      hz: COTTAGE.wall / 2,
      yaw: 0
    };
  }

  // -- track furniture ------------------------------------------------------
  {
    // Cones down the inside line of the ribbon.
    for (const t of TRACK_CONE_ANGLES) {
      const nu = Math.cos(t) / TRACK.a;
      const nv = Math.sin(t) / TRACK.b;
      const n = Math.hypot(nu, nv) || 1;
      const inset = TRACK.halfWidth - 0.55;
      const u = TRACK.cu + Math.cos(t) * TRACK.a - (nu / n) * inset;
      const v = TRACK.cv + Math.sin(t) * TRACK.b - (nv / n) * inset;
      const g = top(u, v);
      const cone = new THREE.ConeGeometry(0.26, 0.62, 8);
      cone.translate(zoneWorldX(u), g + 0.31, zoneWorldZ(v));
      push(bucket, mats.cone, cone);
    }
    // Start/finish gantry over the line.
    const g = top(TRACK_START.u, TRACK_START.v);
    for (const side of [-1, 1]) {
      cylinderAt(
        bucket,
        mats.metal,
        TRACK_START.u,
        TRACK_START.v + side * (TRACK.halfWidth + 1),
        g + 2.6,
        0.11,
        5.2,
        8
      );
    }
    boxAt(bucket, mats.canvas, TRACK_START.u, TRACK_START.v, g + 4.9, 0.12, 1.05, (TRACK.halfWidth + 1) * 2);
  }

  // -- bowl coping + grind rail --------------------------------------------
  {
    const deck = top(BOWL.cu + BOWL.copingRadius + 1, BOWL.cv);
    const coping = new THREE.TorusGeometry(BOWL.copingRadius, 0.11, 8, 96);
    coping.rotateX(Math.PI / 2);
    coping.translate(zoneWorldX(BOWL.cu), deck, zoneWorldZ(BOWL.cv));
    push(bucket, mats.metal, coping);

    const railY = top(BOWL_RAIL.u0, BOWL_RAIL.v) + BOWL_RAIL.height;
    const length = BOWL_RAIL.u1 - BOWL_RAIL.u0;
    const bar = new THREE.CylinderGeometry(0.06, 0.06, length, 8);
    bar.rotateZ(Math.PI / 2);
    bar.translate(zoneWorldX((BOWL_RAIL.u0 + BOWL_RAIL.u1) / 2), railY, zoneWorldZ(BOWL_RAIL.v));
    push(bucket, mats.metal, bar);
    for (const u of [BOWL_RAIL.u0 + 1, BOWL_RAIL.u1 - 1]) {
      cylinderAt(bucket, mats.metal, u, BOWL_RAIL.v, railY - BOWL_RAIL.height / 2, 0.05, BOWL_RAIL.height, 6);
    }
  }

  const casting = new Set<THREE.Material>([mats.wood, mats.woodPale, mats.hay, mats.metal]);
  const meshes = mergeBucket(bucket, "tutorial_zone", casting);

  // -- flight rings ---------------------------------------------------------
  const rings = ringCourse.map((ring, index) => {
    // Tube scales with the hoop so a 6 m ring at 100 m still reads as a ring
    // and not a scratch on the sky — it is the thing you are aiming at.
    const geometry = new THREE.TorusGeometry(ring.radius, ring.radius * 0.035, 10, 48);
    // Standing upright, facing along the course (north), so you fly through it.
    const mesh = new THREE.Mesh(geometry, mats.ring);
    mesh.name = `tutorial_flight_ring_${index}`;
    mesh.position.set(zoneWorldX(ring.u), ring.y, zoneWorldZ(ring.v));
    return mesh;
  });

  return { meshes, colliders, door: { pivot: doorPivot, closedBox }, windsock, rings };
}
