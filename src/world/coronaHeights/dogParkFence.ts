// Corona Heights dog park fence: hand-built wood panel ring replacing the old
// chain-link run. Visuals are three InstancedMeshes (posts, caps, planks) plus
// a small closed gate leaf; colliders keep the old per-piece box discipline so
// gameplay tuned against the 1.44 m chain-link keeps working unchanged.
import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { WorldMap } from "../heightmap";
import { CORONA_DOG_GATE, CORONA_DOG_PARK, type CoronaXZ } from "./layout";

const GATE_TRIM = 1.1;
const PIECE_LENGTH = 4.5;
const POST_SIZE = 0.14;
const POST_HEIGHT = 1.5;
const POST_SINK = 0.06;
const CAP_SIZE = 0.2;
const CAP_HEIGHT = 0.05;
const GATE_POST_STRETCH = 1.16;
// Top plank centre 1.35 + half-height ≈ 1.45, matching the 1.44 m colliders.
const PLANK_LIFTS = [0.22, 0.6, 0.97, 1.35] as const;
const PLANK_HEIGHT = 0.2;
const PLANK_DEPTH = 0.045;
// Weathered cedar / honey / grey-brown, jittered per instance.
const PLANK_PALETTE = [0x8a5a36, 0xa87e48, 0x9a6b3e, 0x7c6a52] as const;
const POST_PALETTE = [0x6f4e33, 0x63513c] as const;

type FencePiece = { ax: number; az: number; bx: number; bz: number };

export type FenceSegment2D = { ax: number; az: number; bx: number; bz: number; nx: number; nz: number };

function fract(v: number) {
  return v - Math.floor(v);
}

function hash2(x: number, z: number, salt = 0) {
  return fract(Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453123);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function pointInPolygon(x: number, z: number, polygon: readonly CoronaXZ[]) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, zi] = polygon[i];
    const [xj, zj] = polygon[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

function trimSegment(a: CoronaXZ, b: CoronaXZ, trimA: number, trimB: number): FencePiece | null {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const length = Math.hypot(dx, dz);
  if (length <= trimA + trimB + 0.1) return null;
  const ux = dx / length;
  const uz = dz / length;
  return { ax: a[0] + ux * trimA, az: a[1] + uz * trimA, bx: b[0] - ux * trimB, bz: b[1] - uz * trimB };
}

/** Fence run around the polygon with a GATE_TRIM opening either side of the
 * signed gate corner, subdivided into ~PIECE_LENGTH panels. Each piece boundary
 * carries a post; the first piece's start and last piece's end flank the gate. */
function fencePieces() {
  const pieces: FencePiece[] = [];
  for (let i = 0; i < CORONA_DOG_PARK.length; i++) {
    const a = CORONA_DOG_PARK[i];
    const b = CORONA_DOG_PARK[(i + 1) % CORONA_DOG_PARK.length];
    const edge = trimSegment(a, b, i === 0 ? GATE_TRIM : 0, i === CORONA_DOG_PARK.length - 1 ? GATE_TRIM : 0);
    if (!edge) continue;
    const length = Math.hypot(edge.bx - edge.ax, edge.bz - edge.az);
    const count = Math.max(1, Math.ceil(length / PIECE_LENGTH));
    for (let k = 0; k < count; k++) {
      const t0 = k / count;
      const t1 = (k + 1) / count;
      pieces.push({
        ax: lerp(edge.ax, edge.bx, t0),
        az: lerp(edge.az, edge.bz, t0),
        bx: lerp(edge.ax, edge.bx, t1),
        bz: lerp(edge.az, edge.bz, t1)
      });
    }
  }
  return pieces;
}

/** The closed gate leaf's chord across the corner bay: from the closing edge's
 * trimmed end to the first edge's trimmed start, both GATE_TRIM out from
 * CORONA_DOG_GATE. */
function gateChord(): FencePiece {
  const [gx, gz] = CORONA_DOG_GATE;
  const [fx, fz] = CORONA_DOG_PARK[1];
  const [lx, lz] = CORONA_DOG_PARK[CORONA_DOG_PARK.length - 1];
  const fl = Math.hypot(fx - gx, fz - gz);
  const ll = Math.hypot(lx - gx, lz - gz);
  return {
    ax: gx + ((lx - gx) / ll) * GATE_TRIM,
    az: gz + ((lz - gz) / ll) * GATE_TRIM,
    bx: gx + ((fx - gx) / fl) * GATE_TRIM,
    bz: gz + ((fz - gz) / fl) * GATE_TRIM
  };
}

type FenceFrame = {
  x: number;
  y: number;
  z: number;
  y0: number;
  y1: number;
  length: number;
  quat: readonly [number, number, number, number];
};

// makeBasis quaternion is the one orientation recipe box3d agrees with three on
// (hand-rolled yaw quats mirror rotated boxes in this engine) — keep it.
function fenceFrame(map: WorldMap, piece: FencePiece): FenceFrame {
  const dx = piece.bx - piece.ax;
  const dz = piece.bz - piece.az;
  const y0 = map.groundTop(piece.ax, piece.az);
  const y1 = map.groundTop(piece.bx, piece.bz);
  const xAxis = new THREE.Vector3(dx, y1 - y0, dz).normalize();
  const zAxis = new THREE.Vector3(-dz, 0, dx).normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  const rotation = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  const q = new THREE.Quaternion().setFromRotationMatrix(rotation);
  return {
    x: (piece.ax + piece.bx) / 2,
    y: (y0 + y1) / 2,
    z: (piece.az + piece.bz) / 2,
    y0,
    y1,
    length: Math.hypot(dx, y1 - y0, dz),
    quat: [q.x, q.y, q.z, q.w]
  };
}

function registerFenceCollider(physics: Physics, frame: FenceFrame) {
  const { x, z, length, quat } = frame;
  const y = frame.y + 0.72;
  const body = physics.world.createBox({
    type: BodyType.Static,
    position: [x, y, z],
    halfExtents: [length / 2, 0.72, 0.09],
    friction: 0.7
  });
  physics.world.setBodyTransform(body, [x, y, z], quat);
  physics.addQuerySolid(body, { x, y, z, hx: length / 2, hy: 0.72, hz: 0.09, quat });
}

/**
 * Full sealed dog-run ring in 2D for the ball sim: every polygon edge including
 * the closing one, untrimmed — the decorative-closed gate counts as solid.
 * Normals point into the park; the polygon's winding isn't asserted anywhere,
 * so each normal is probed against the interior rather than assumed.
 */
export function dogParkFenceSegments(): FenceSegment2D[] {
  const segments: FenceSegment2D[] = [];
  for (let i = 0; i < CORONA_DOG_PARK.length; i++) {
    const a = CORONA_DOG_PARK[i];
    const b = CORONA_DOG_PARK[(i + 1) % CORONA_DOG_PARK.length];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    let nx = -dz / length;
    let nz = dx / length;
    const mx = (a[0] + b[0]) / 2;
    const mz = (a[1] + b[1]) / 2;
    if (!pointInPolygon(mx + nx * 0.2, mz + nz * 0.2, CORONA_DOG_PARK)) {
      nx = -nx;
      nz = -nz;
    }
    segments.push({ ax: a[0], az: a[1], bx: b[0], bz: b[1], nx, nz });
  }
  return segments;
}

/** Cross-braced Z-frame leaf built in the gate chord's local frame: vertical
 * boards, two ledges, one diagonal. Parent applies the frame transform. */
function makeGateLeaf(length: number, material: THREE.MeshStandardMaterial) {
  const gate = new THREE.Group();
  gate.name = "corona_dog_park_fence_gate";
  const span = length - 0.18;
  const boardCount = Math.max(3, Math.round(span / 0.3));
  const boardWidth = (span - 0.03 * (boardCount - 1)) / boardCount;
  const addBox = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    gate.add(mesh);
    return mesh;
  };
  for (let i = 0; i < boardCount; i++) {
    const x = -span / 2 + boardWidth / 2 + i * (boardWidth + 0.03);
    addBox(boardWidth, 1.48, 0.04, x, 0.82 + (hash2(i, 7, 61) - 0.5) * 0.03, 0);
  }
  addBox(span, 0.13, 0.04, 0, 0.34, 0.045);
  addBox(span, 0.13, 0.04, 0, 1.26, 0.045);
  const brace = addBox(Math.hypot(span - 0.1, 0.92) - 0.12, 0.12, 0.04, 0, 0.8, 0.045);
  brace.rotation.z = Math.atan2(0.92, span - 0.1);
  return gate;
}

/**
 * Builds the wood fence visuals AND registers every physics collider (panels
 * plus the closed gate) so the returned group is purely decorative to callers.
 */
export function makeDogParkFence(map: WorldMap, physics: Physics): THREE.Group {
  const group = new THREE.Group();
  group.name = "corona_dog_park_fence";
  const pieces = fencePieces();
  const wood = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  const postCount = pieces.length + 1;
  const posts = new THREE.InstancedMesh(new THREE.BoxGeometry(POST_SIZE, POST_HEIGHT, POST_SIZE), wood, postCount);
  const caps = new THREE.InstancedMesh(new THREE.BoxGeometry(CAP_SIZE, CAP_HEIGHT, CAP_SIZE), wood, postCount);
  const planks = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), wood, pieces.length * PLANK_LIFTS.length);
  posts.name = "corona_dog_park_fence_posts";
  caps.name = "corona_dog_park_fence_caps";
  planks.name = "corona_dog_park_fence_planks";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const frameQuat = new THREE.Quaternion();
  const jitterQuat = new THREE.Quaternion();
  const jitterEuler = new THREE.Euler();

  const postPoints = pieces.map((p) => ({ x: p.ax, z: p.az, dx: p.bx - p.ax, dz: p.bz - p.az }));
  const final = pieces[pieces.length - 1];
  postPoints.push({ x: final.bx, z: final.bz, dx: final.bx - final.ax, dz: final.bz - final.az });
  postPoints.forEach((p, i) => {
    const gatePost = i === 0 || i === postPoints.length - 1;
    const stretch = gatePost ? GATE_POST_STRETCH : 0.97 + hash2(p.x, p.z, 3) * 0.06;
    const top = map.groundTop(p.x, p.z) - POST_SINK + POST_HEIGHT * stretch;
    dummy.position.set(p.x, top - (POST_HEIGHT * stretch) / 2, p.z);
    dummy.rotation.set(
      (hash2(p.x, p.z, 5) - 0.5) * 0.02,
      Math.atan2(-p.dz, p.dx) + (hash2(p.x, p.z, 7) - 0.5) * 0.08,
      (hash2(p.x, p.z, 11) - 0.5) * 0.02
    );
    dummy.scale.set(gatePost ? 1.12 : 1, stretch, gatePost ? 1.12 : 1);
    dummy.updateMatrix();
    posts.setMatrixAt(i, dummy.matrix);
    color.setHex(POST_PALETTE[hash2(p.x, p.z, 13) > 0.5 ? 0 : 1]);
    color.offsetHSL(0, (hash2(p.x, p.z, 17) - 0.5) * 0.06, (hash2(p.x, p.z, 19) - 0.5) * 0.07);
    posts.setColorAt(i, color);
    caps.setColorAt(i, color.offsetHSL(0, 0, -0.03));
    dummy.position.y = top + CAP_HEIGHT / 2;
    dummy.scale.y = 1;
    dummy.updateMatrix();
    caps.setMatrixAt(i, dummy.matrix);
  });

  let plankIndex = 0;
  for (const piece of pieces) {
    const frame = fenceFrame(map, piece);
    frameQuat.set(frame.quat[0], frame.quat[1], frame.quat[2], frame.quat[3]);
    for (const lift of PLANK_LIFTS) {
      const sx = piece.ax + lift * 31;
      const sz = piece.az + lift * 17;
      // Hand-nailed charm: a hair of roll/skew and a wobbly centreline, all
      // small enough that the planks stay visually inside the 0.09 collider.
      jitterEuler.set((hash2(sx, sz, 23) - 0.5) * 0.06, 0, (hash2(sx, sz, 29) - 0.5) * 0.024);
      jitterQuat.setFromEuler(jitterEuler);
      dummy.position.set(frame.x, frame.y + lift + (hash2(sx, sz, 31) - 0.5) * 0.03, frame.z);
      dummy.quaternion.copy(frameQuat).multiply(jitterQuat);
      dummy.scale.set(frame.length + 0.04, PLANK_HEIGHT * (0.92 + hash2(sx, sz, 37) * 0.14), PLANK_DEPTH);
      dummy.updateMatrix();
      planks.setMatrixAt(plankIndex, dummy.matrix);
      color.setHex(PLANK_PALETTE[Math.min(PLANK_PALETTE.length - 1, (hash2(sx, sz, 41) * PLANK_PALETTE.length) | 0)]);
      color.offsetHSL((hash2(sx, sz, 43) - 0.5) * 0.016, (hash2(sx, sz, 47) - 0.5) * 0.08, (hash2(sx, sz, 53) - 0.5) * 0.08);
      planks.setColorAt(plankIndex, color);
      plankIndex++;
    }
    registerFenceCollider(physics, frame);
  }

  for (const mesh of [posts, caps, planks]) {
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  }

  const chord = gateChord();
  const gateFrame = fenceFrame(map, chord);
  const gateWood = new THREE.MeshStandardMaterial({ color: 0x96693c, roughness: 0.9 });
  const gate = makeGateLeaf(gateFrame.length, gateWood);
  gate.position.set(gateFrame.x, gateFrame.y, gateFrame.z);
  gate.quaternion.set(gateFrame.quat[0], gateFrame.quat[1], gateFrame.quat[2], gateFrame.quat[3]);
  group.add(posts, caps, planks, gate);
  registerFenceCollider(physics, gateFrame);
  return group;
}
