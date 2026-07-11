import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseIdle, type Rig } from "../../player/rig";
import type { WorldMap } from "../heightmap";
import { dogParkFenceSegments, makeDogParkFence, type FenceSegment2D } from "./dogParkFence";
import {
  CORONA_DOG_GATE,
  CORONA_DOG_PARK,
  CORONA_HEIGHTS_SUMMIT,
  CORONA_TRAILS,
  type CoronaTrail,
  type CoronaXZ
} from "./layout";
import { makeSummitCrags, summitKeepOut, summitPlatformLift } from "./summitCrags";

const DETAIL_RANGE = 1450;
const ACTIVITY_RANGE = 420;
const HILL_RX = 118;
const HILL_RZ = 126;
const HILL_STEP = 4;
const DOG_SURFACE_LIFT = 0.04;
const DOG_QUERY_LIFT = 0.14;
const CORONA_GROUND_LIFT = 0.38;
const DOG_ACCEL = 10;
const DOG_ARRIVE = 2.5; // arrival slow-down radius so dogs ease in instead of teleport-stopping
const OWNER_CLEARANCE = 0.85; // dogs never crowd inside this ring around a human
const BALL_R = 0.16;
const FENCE_PAD = 0.1; // fence rail half-thickness for ball rebounds
const THROW_RELEASE = 0.3; // seconds into the throw animation when the prop leaves the hand
const THROW_ANIM_LEN = 0.85;
const preparedMaps = new WeakSet<WorldMap>();

type TrailSample = { x: number; z: number; tx: number; tz: number };
type OwnerAction = "watch" | "ball" | "frisbee";
type FetchStage = "wait" | "react" | "chase" | "return";

type ParkOwner = {
  action: OwnerAction;
  rig: Rig;
  x: number;
  z: number;
  facing: number;
  seed: number;
  // layered pose state — smoothed every frame, never snapped
  yaw: number;
  headYaw: number;
  headPitch: number;
  torsoYaw: number;
  cheer: number;
  cheerTimer: number;
  greet: number;
  greetTimer: number;
  throwAnim: number; // seconds since windup start; >= THROW_ANIM_LEN means idle
};

type WanderState = {
  mode: "roam" | "sniff" | "chase";
  tx: number;
  tz: number;
  timer: number;
  dur: number;
};

type DogStyle = {
  name: string;
  coat: number;
  accent: number;
  collar: number;
  scale: number;
  longBody?: boolean;
  floppy?: boolean;
};

type ParkDog = {
  style: DogStyle;
  group: THREE.Group;
  legs: THREE.Group[];
  head: THREE.Group;
  tail: THREE.Group;
  x: number;
  z: number;
  heading: number;
  stride: number;
  speed: number;
};

export type CoronaHeightsStats = {
  dogs: number;
  owners: number;
  summit: typeof CORONA_HEIGHTS_SUMMIT;
};

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

function fract(v: number) {
  return v - Math.floor(v);
}

function hash2(x: number, z: number, salt = 0) {
  return fract(Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453123);
}

function valueNoise(x: number, z: number, cell: number, salt: number) {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const ax = smooth01(fx - ix);
  const az = smooth01(fz - iz);
  const a = lerp(hash2(ix, iz, salt), hash2(ix + 1, iz, salt), ax);
  const b = lerp(hash2(ix, iz + 1, salt), hash2(ix + 1, iz + 1, salt), ax);
  return lerp(a, b, az);
}

/**
 * The shipped Corona Heights lawn is a constrained-Delaunay overlay while
 * WorldMap queries are bilinear. On the hill's sharp folds those two surfaces
 * can differ by almost 30 cm, enough for either the lawn or the player to poke
 * through an authored detail skin. Raise the query carpet beneath the authored
 * hill, then feather it outside the visible skin. This is deliberately called
 * immediately after WorldMap.load(), before physics and world props are built.
 */
export function prepareCoronaHeightsGround(map: WorldMap) {
  if (preparedMaps.has(map)) return;
  preparedMaps.add(map);
  const { cellSize, width, height, minX, minZ } = map.meta.grid;
  const cx = CORONA_HEIGHTS_SUMMIT.x;
  const cz = CORONA_HEIGHTS_SUMMIT.z + 8;
  const minGX = Math.max(0, Math.floor((cx - HILL_RX * 1.12 - minX) / cellSize));
  const maxGX = Math.min(width - 1, Math.ceil((cx + HILL_RX * 1.12 - minX) / cellSize));
  const minGZ = Math.max(0, Math.floor((cz - HILL_RZ * 1.12 - minZ) / cellSize));
  const maxGZ = Math.min(height - 1, Math.ceil((cz + HILL_RZ * 1.12 - minZ) / cellSize));
  for (let gz = minGZ; gz <= maxGZ; gz++) {
    const z = minZ + gz * cellSize;
    for (let gx = minGX; gx <= maxGX; gx++) {
      const x = minX + gx * cellSize;
      const q = ((x - cx) / HILL_RX) ** 2 + ((z - cz) / HILL_RZ) ** 2;
      if (q >= 1.12) continue;
      const feather = 1 - smooth01((q - 0.9) / 0.22);
      map.groundTops[gz * width + gx] +=
        CORONA_GROUND_LIFT * feather + (pointInPolygon(x, z, CORONA_DOG_PARK) ? DOG_QUERY_LIFT : 0);
    }
  }
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

function pointSegmentDistance(x: number, z: number, a: CoronaXZ, b: CoronaXZ) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const ll = dx * dx + dz * dz;
  const t = ll > 1e-6 ? clamp01(((x - a[0]) * dx + (z - a[1]) * dz) / ll) : 0;
  return Math.hypot(x - (a[0] + dx * t), z - (a[1] + dz * t));
}

function distanceToTrails(x: number, z: number) {
  let best = Infinity;
  for (const trail of CORONA_TRAILS) {
    for (let i = 0; i < trail.points.length - 1; i++) {
      best = Math.min(best, pointSegmentDistance(x, z, trail.points[i], trail.points[i + 1]));
    }
  }
  return best;
}

function sampleTrail(points: readonly CoronaXZ[], spacing = 2.4): TrailSample[] {
  const positions: { x: number; z: number }[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const length = Math.hypot(dx, dz);
    const count = Math.max(1, Math.ceil(length / spacing));
    for (let k = 0; k < count; k++) {
      const t = k / count;
      positions.push({ x: a[0] + dx * t, z: a[1] + dz * t });
    }
  }
  const last = points[points.length - 1];
  positions.push({ x: last[0], z: last[1] });
  return positions.map((p, i) => {
    const prev = positions[Math.max(0, i - 1)];
    const next = positions[Math.min(positions.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dz = next.z - prev.z;
    const inv = 1 / (Math.hypot(dx, dz) || 1);
    return { ...p, tx: dx * inv, tz: dz * inv };
  });
}

function makeHillSkin(map: WorldMap) {
  const cx = CORONA_HEIGHTS_SUMMIT.x;
  const cz = CORONA_HEIGHTS_SUMMIT.z + 8;
  const nx = Math.ceil((HILL_RX * 2) / HILL_STEP) + 1;
  const nz = Math.ceil((HILL_RZ * 2) / HILL_STEP) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const inside = new Uint8Array(nx * nz);
  const normal = new THREE.Vector3();
  const green = new THREE.Color(0x4f6d3d);
  const dry = new THREE.Color(0x8b833f);
  const ochre = new THREE.Color(0xa06d38);
  const chert = new THREE.Color(0x84443b);
  const darkChert = new THREE.Color(0x512d2d);
  const color = new THREE.Color();

  for (let gz = 0; gz < nz; gz++) {
    const z = cz - HILL_RZ + gz * HILL_STEP;
    for (let gx = 0; gx < nx; gx++) {
      const x = cx - HILL_RX + gx * HILL_STEP;
      const i = gz * nx + gx;
      const q = ((x - cx) / HILL_RX) ** 2 + ((z - cz) / HILL_RZ) ** 2;
      const edge = 1.08 + (hash2(gx, gz, 9) - 0.5) * 0.035;
      inside[i] = q < edge && !pointInPolygon(x, z, CORONA_DOG_PARK) ? 1 : 0;
      // 0.13: proud of the baked park lawn's CDT drape (which can exceed the
      // bilinear query by 20+ cm on folds) while staying under the trail ribbons.
      const y = map.groundTop(x, z) + 0.13;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;

      map.normal(x, z, normal, 4);
      const slope = 1 - normal.y;
      const ridge = clamp01((y - 124) / 27);
      const grain = valueNoise(x, z, 21, 21);
      const band = valueNoise(x + z * 0.22, z - x * 0.16, 37, 23);
      let rock = clamp01((slope - 0.035) / 0.2) * (0.32 + ridge * 0.78);
      rock = clamp01(rock + clamp01((y - 140) / 11) * 0.38) * (0.48 + grain * 0.52);
      const edgeBlend = smooth01((q - 0.7) / 0.36);
      color.copy(green).lerp(dry, 0.6 + ridge * 0.24).lerp(ochre, rock * 0.28);
      color.lerp(grain > 0.32 ? chert : darkChert, rock * (0.58 + band * 0.32));
      color.lerp(green, edgeBlend * 0.88);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }

  const indices: number[] = [];
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (inside[a] && inside[b] && inside[c]) indices.push(a, c, b);
      if (inside[b] && inside[c] && inside[d]) indices.push(b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.98,
    metalness: 0,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "corona_heights_hill_skin";
  mesh.receiveShadow = true;
  return mesh;
}

/** The old quarry/slickenside beside Peixotto Playground is the hill's other
 * defining face. The base bake paints every park cell green, so a dedicated
 * terrain-conforming skin restores its pale polished stone and rusty chert
 * seams without changing the collision heightfield underneath. */
function makeQuarryFace(map: WorldMap) {
  const cx = 578;
  const cz = 2725;
  const rx = 66;
  const rz = 92;
  const step = 4;
  const nx = Math.ceil((rx * 2) / step) + 1;
  const nz = Math.ceil((rz * 2) / step) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  const inside = new Uint8Array(nx * nz);
  const normal = new THREE.Vector3();
  const pale = new THREE.Color(0xb8aa9a);
  const pink = new THREE.Color(0xa57e73);
  const rust = new THREE.Color(0x87483b);
  const shadow = new THREE.Color(0x57403c);
  const edgeGreen = new THREE.Color(0x526d3e);
  const color = new THREE.Color();
  for (let gz = 0; gz < nz; gz++) {
    const z = cz - rz + gz * step;
    for (let gx = 0; gx < nx; gx++) {
      const x = cx - rx + gx * step;
      const i = gz * nx + gx;
      const q = ((x - cx) / rx) ** 2 + ((z - cz) / rz) ** 2;
      map.normal(x, z, normal, 4);
      const slope = 1 - normal.y;
      inside[i] = q < 1 && slope > 0.018 ? 1 : 0;
      positions[i * 3] = x;
      positions[i * 3 + 1] = map.groundTop(x, z) + 0.11;
      positions[i * 3 + 2] = z;
      const grain = valueNoise(x, z, 15, 149);
      const seam = valueNoise(x + z * 0.35, z - x * 0.12, 24, 151);
      const shadowing = clamp01((slope - 0.08) / 0.24);
      const edge = smooth01((q - 0.7) / 0.27);
      color.copy(pale).lerp(pink, 0.2 + seam * 0.24 + grain * 0.12).lerp(rust, seam * shadowing * 0.62);
      color.lerp(shadow, shadowing * (1 - seam) * 0.32).lerp(edgeGreen, edge * 0.86);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
  }
  const indices: number[] = [];
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      if (inside[a] && inside[b] && inside[c]) indices.push(a, c, b);
      if (inside[b] && inside[c] && inside[d]) indices.push(b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.94,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1
    })
  );
  mesh.name = "corona_heights_quarry_slickenside";
  mesh.receiveShadow = true;
  return mesh;
}

function makeTrailRibbon(map: WorldMap, trail: CoronaTrail, material: THREE.Material) {
  const samples = sampleTrail(trail.points);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const half = trail.width / 2;
  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    const nx = -p.tz;
    const nz = p.tx;
    for (const side of [-1, 1]) {
      const x = p.x + nx * half * side;
      const z = p.z + nz * half * side;
      // Where a trail crosses the raised summit platform it must ride on top
      // of that dirt skin, not drown beneath it.
      const lift = summitPlatformLift(x, z);
      positions.push(x, map.groundTop(x, z) + 0.165 + Math.max(0, lift + 0.08 - 0.165), z);
      const shade = 0.86 + hash2(i, side, trail.name.length) * 0.18;
      colors.push(shade, shade, shade);
    }
    if (i < samples.length - 1) {
      const a = i * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `corona_trail_${trail.name.toLowerCase().replaceAll(" ", "_")}`;
  mesh.receiveShadow = true;
  return mesh;
}

function makeStepTies(map: WorldMap, trail: CoronaTrail, material: THREE.Material) {
  const samples = sampleTrail(trail.points, 1.5);
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, samples.length);
  mesh.name = `corona_steps_${trail.name.toLowerCase().replaceAll(" ", "_")}`;
  const dummy = new THREE.Object3D();
  samples.forEach((p, i) => {
    const nx = -p.tz;
    const nz = p.tx;
    const tieLift = summitPlatformLift(p.x, p.z);
    dummy.position.set(p.x, map.groundTop(p.x, p.z) + 0.19 + Math.max(0, tieLift + 0.1 - 0.19), p.z);
    dummy.rotation.set(0, Math.atan2(-nz, nx), 0);
    dummy.scale.set(trail.width + 0.25, 0.16, 0.24);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
  });
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeTrails(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_heights_trails";
  const dirt = new THREE.MeshStandardMaterial({ color: 0xaa8b61, vertexColors: true, roughness: 1 });
  const compacted = new THREE.MeshStandardMaterial({ color: 0x88755e, vertexColors: true, roughness: 1 });
  const tie = new THREE.MeshStandardMaterial({ color: 0x5d4934, roughness: 0.98 });
  for (const trail of CORONA_TRAILS) {
    group.add(makeTrailRibbon(map, trail, trail.surface === "dirt" ? dirt : compacted));
    if (trail.surface === "steps") group.add(makeStepTies(map, trail, tie));
  }
  return group;
}

function makeRockField(map: WorldMap, physics: Physics) {
  const geometry = new THREE.DodecahedronGeometry(1, 0);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0 });
  const capacity = 118;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = "corona_heights_chert_outcrops";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const normal = new THREE.Vector3();
  let count = 0;
  for (let i = 0; i < 720 && count < capacity; i++) {
    const a = hash2(i, 3, 11) * Math.PI * 2;
    const r = Math.sqrt(hash2(i, 7, 17));
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    const y = map.groundTop(x, z);
    map.normal(x, z, normal, 4);
    const steep = 1 - normal.y;
    if (y < 126 || (steep < 0.065 && y < 139) || hash2(i, 19, 23) < 0.38) continue;
    if (distanceToTrails(x, z) < 2.8 || pointInPolygon(x, z, CORONA_DOG_PARK)) continue;
    // The authored summit crags own the peak; keep the generic rocks downslope.
    if (summitKeepOut(x, z, 3)) continue;
    const size = 0.65 + hash2(i, 29, 31) * 1.8 + steep * 3.5;
    const sx = size * (1.15 + hash2(i, 47));
    const sy = size * (0.5 + steep * 1.5);
    const sz = size * (0.8 + hash2(i, 53));
    const yaw = hash2(i, 41) * Math.PI * 2;
    dummy.position.set(x, y - size * 0.34, z);
    dummy.rotation.set(hash2(i, 37) * 0.8, yaw, hash2(i, 43) * 0.55);
    dummy.scale.set(sx, sy, sz);
    dummy.updateMatrix();
    mesh.setMatrixAt(count, dummy.matrix);
    color.setHex(hash2(i, 59) > 0.28 ? 0x87463d : 0x593235).offsetHSL((hash2(i, 61) - 0.5) * 0.035, 0, (hash2(i, 67) - 0.5) * 0.12);
    mesh.setColorAt(count, color);
    // Tiny fragments remain decorative, but the big chert blocks are real
    // obstacles for walkers, vehicles, paint rays and grab tools.
    if (size > 1.4) {
      const visibleHeight = Math.max(0.36, sy - size * 0.34);
      const cy = y + visibleHeight * 0.46;
      const hx = sx * 0.84;
      const hy = visibleHeight * 0.46;
      const hz = sz * 0.84;
      const body = physics.world.createBox({
        type: BodyType.Static,
        position: [x, cy, z],
        halfExtents: [hx, hy, hz],
        friction: 0.82
      });
      physics.world.setBodyTransform(body, [x, cy, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
      physics.addQuerySolid(body, { x, y: cy, z, hx, hy, hz, yaw });
    }
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeTuftGeometry() {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  for (let q = 0; q < 3; q++) {
    const a = (q / 3) * Math.PI;
    const dx = Math.cos(a) * 0.5;
    const dz = Math.sin(a) * 0.5;
    const base = q * 5;
    positions.push(-dx, 0, -dz, dx, 0, dz, dx * 0.55, 0.72, dz * 0.55, 0, 1.05, 0, -dx * 0.55, 0.72, -dz * 0.55);
    for (let i = 0; i < 5; i++) normals.push(0, 1, 0);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 4, base + 4, base + 2, base + 3);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function makeHillGrass(map: WorldMap) {
  const geometry = makeTuftGeometry();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98, side: THREE.DoubleSide });
  const capacity = 960;
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = "corona_heights_grass_tufts";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  const normal = new THREE.Vector3();
  let count = 0;
  for (let gz = -49; gz <= 49 && count < capacity; gz++) {
    for (let gx = -46; gx <= 46 && count < capacity; gx++) {
      const x = CORONA_HEIGHTS_SUMMIT.x + gx * 2.55 + (hash2(gx, gz, 3) - 0.5) * 2.1;
      const z = CORONA_HEIGHTS_SUMMIT.z + 8 + gz * 2.55 + (hash2(gx, gz, 5) - 0.5) * 2.1;
      const q = ((x - CORONA_HEIGHTS_SUMMIT.x) / HILL_RX) ** 2 + ((z - CORONA_HEIGHTS_SUMMIT.z - 8) / HILL_RZ) ** 2;
      if (q > 0.94 || hash2(gx, gz, 7) > 0.22) continue;
      if (pointInPolygon(x, z, CORONA_DOG_PARK) || distanceToTrails(x, z) < 2.7) continue;
      if (summitKeepOut(x, z, 1)) continue;
      const y = map.groundTop(x, z);
      map.normal(x, z, normal, 2);
      if (normal.y < 0.86 || (y > 140 && hash2(gx, gz, 11) > 0.48)) continue;
      const s = 0.45 + hash2(gx, gz, 13) * 0.9;
      dummy.position.set(x, y + 0.045, z);
      dummy.rotation.set(0, hash2(gx, gz, 17) * Math.PI * 2, 0);
      dummy.scale.set(s * (0.72 + hash2(gx, gz, 19) * 0.5), s, s * (0.72 + hash2(gx, gz, 23) * 0.5));
      dummy.updateMatrix();
      mesh.setMatrixAt(count, dummy.matrix);
      color.setHex(hash2(gx, gz, 29) > 0.45 ? 0x7c7d34 : 0x536f35).offsetHSL((hash2(gx, gz, 31) - 0.5) * 0.05, 0, (hash2(gx, gz, 37) - 0.5) * 0.12);
      mesh.setColorAt(count, color);
      count++;
    }
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function makeWildflowers(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_heights_wildflowers";
  const capacity = 220;
  const stems = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(0.025, 0.035, 1, 5),
    new THREE.MeshStandardMaterial({ color: 0x45642d, roughness: 1 }),
    capacity
  );
  const blooms = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }),
    capacity
  );
  stems.name = "corona_flower_stems";
  blooms.name = "corona_flower_blooms";
  const stemDummy = new THREE.Object3D();
  const bloomDummy = new THREE.Object3D();
  const bloomColor = new THREE.Color();
  const palettes = [0xf0a134, 0xd9652f, 0x7c6ec8, 0xf2d457];
  let count = 0;
  for (let i = 0; i < 1800 && count < capacity; i++) {
    const a = hash2(i, 1, 71) * Math.PI * 2;
    const r = Math.sqrt(hash2(i, 2, 73));
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    if (hash2(i, 3, 79) > 0.18 || pointInPolygon(x, z, CORONA_DOG_PARK) || distanceToTrails(x, z) < 3.2) continue;
    const y = map.groundTop(x, z);
    if (y > 145 || summitKeepOut(x, z, 1.5)) continue;
    const h = 0.28 + hash2(i, 5, 83) * 0.55;
    stemDummy.position.set(x, y + h / 2 + 0.04, z);
    stemDummy.scale.set(1, h, 1);
    stemDummy.updateMatrix();
    stems.setMatrixAt(count, stemDummy.matrix);
    bloomDummy.position.set(x, y + h + 0.05, z);
    bloomDummy.rotation.set(hash2(i, 7) * 0.4, hash2(i, 11) * Math.PI * 2, 0);
    bloomDummy.scale.setScalar(0.075 + hash2(i, 13) * 0.07);
    bloomDummy.updateMatrix();
    blooms.setMatrixAt(count, bloomDummy.matrix);
    bloomColor.setHex(palettes[Math.floor(hash2(i, 17) * palettes.length) % palettes.length]);
    blooms.setColorAt(count, bloomColor);
    count++;
  }
  stems.count = blooms.count = count;
  stems.instanceMatrix.needsUpdate = true;
  blooms.instanceMatrix.needsUpdate = true;
  if (blooms.instanceColor) blooms.instanceColor.needsUpdate = true;
  stems.frustumCulled = blooms.frustumCulled = false;
  group.add(stems, blooms);
  return group;
}

function makeShrubsAndTrees(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_heights_shrubs_and_trees";
  const shrubCapacity = 72;
  const shrubs = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.98 }),
    shrubCapacity
  );
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let shrubsCount = 0;
  for (let i = 0; i < 420 && shrubsCount < shrubCapacity; i++) {
    const a = hash2(i, 2, 91) * Math.PI * 2;
    const r = 0.72 + hash2(i, 3, 97) * 0.28;
    const x = CORONA_HEIGHTS_SUMMIT.x + Math.cos(a) * HILL_RX * r;
    const z = CORONA_HEIGHTS_SUMMIT.z + 8 + Math.sin(a) * HILL_RZ * r;
    if (hash2(i, 5, 101) > 0.27 || distanceToTrails(x, z) < 3 || pointInPolygon(x, z, CORONA_DOG_PARK)) continue;
    const s = 0.7 + hash2(i, 7, 103) * 1.35;
    dummy.position.set(x, map.groundTop(x, z) + s * 0.4, z);
    dummy.rotation.set(0, hash2(i, 11) * Math.PI * 2, 0);
    dummy.scale.set(s * 1.25, s * 0.7, s);
    dummy.updateMatrix();
    shrubs.setMatrixAt(shrubsCount, dummy.matrix);
    color.setHex(hash2(i, 13) > 0.3 ? 0x3f5e32 : 0x6b6a34).offsetHSL(0, 0, (hash2(i, 17) - 0.5) * 0.1);
    shrubs.setColorAt(shrubsCount, color);
    shrubsCount++;
  }
  shrubs.count = shrubsCount;
  shrubs.instanceMatrix.needsUpdate = true;
  if (shrubs.instanceColor) shrubs.instanceColor.needsUpdate = true;
  shrubs.castShadow = true;
  shrubs.receiveShadow = true;
  shrubs.frustumCulled = false;

  const treeSpots: readonly [number, number, number, number][] = [
    [331, 2675, 5.4, 0.62],
    [346, 2673, 6.6, 0.72],
    [365, 2670, 7.1, 0.78],
    [384, 2668, 6.2, 0.68],
    [404, 2668, 7.6, 0.82],
    [424, 2674, 5.8, 0.66],
    [462, 2719, 5.1, 0.58],
    [490, 2738, 6.4, 0.7],
    [505, 2774, 5.3, 0.62]
  ];
  const trunks = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(1, 1, 1, 7),
    new THREE.MeshStandardMaterial({ color: 0x5b4632, roughness: 1 }),
    treeSpots.length
  );
  const crowns = new THREE.InstancedMesh(
    new THREE.IcosahedronGeometry(1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.96 }),
    treeSpots.length
  );
  treeSpots.forEach(([x, z, h, spread], i) => {
    const y = map.groundTop(x, z);
    dummy.position.set(x, y + h * 0.43, z);
    dummy.rotation.set(0, hash2(i, 3, 107) * Math.PI * 2, 0);
    dummy.scale.set(spread * 0.28, h * 0.86, spread * 0.28);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    dummy.position.set(x + spread * 0.55, y + h * 0.82, z);
    dummy.rotation.set(0, hash2(i, 5, 109) * Math.PI * 2, 0.08);
    dummy.scale.set(spread * 3.2, h * 0.48, spread * 2.2);
    dummy.updateMatrix();
    crowns.setMatrixAt(i, dummy.matrix);
    color.setHex(i % 3 === 0 ? 0x4b603a : 0x596b3c).offsetHSL(0, 0, (hash2(i, 7) - 0.5) * 0.08);
    crowns.setColorAt(i, color);
  });
  for (const mesh of [trunks, crowns]) {
    mesh.instanceMatrix.needsUpdate = true;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
  }
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
  group.add(shrubs, trunks, crowns);
  return group;
}

function polygonSurface(map: WorldMap, polygon: readonly CoronaXZ[]) {
  const minX = Math.floor(Math.min(...polygon.map((p) => p[0]))) - 1;
  const maxX = Math.ceil(Math.max(...polygon.map((p) => p[0]))) + 1;
  const minZ = Math.floor(Math.min(...polygon.map((p) => p[1]))) - 1;
  const maxZ = Math.ceil(Math.max(...polygon.map((p) => p[1]))) + 1;
  const step = 0.8;
  const nx = Math.ceil((maxX - minX) / step) + 1;
  const nz = Math.ceil((maxZ - minZ) / step) + 1;
  const positions = new Float32Array(nx * nz * 3);
  const colors = new Float32Array(nx * nz * 3);
  for (let gz = 0; gz < nz; gz++) {
    const z = minZ + gz * step;
    for (let gx = 0; gx < nx; gx++) {
      const x = minX + gx * step;
      const i = gz * nx + gx;
      positions[i * 3] = x;
      positions[i * 3 + 1] = map.groundTop(x, z) + DOG_SURFACE_LIFT;
      positions[i * 3 + 2] = z;
      const shade = 0.84 + valueNoise(x, z, 8, 113) * 0.18;
      colors[i * 3] = shade;
      colors[i * 3 + 1] = shade * 0.97;
      colors[i * 3 + 2] = shade * 0.9;
    }
  }
  const indices: number[] = [];
  for (let gz = 0; gz < nz - 1; gz++) {
    for (let gx = 0; gx < nx - 1; gx++) {
      const a = gz * nx + gx;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      const centerX = minX + (gx + 0.5) * step;
      const centerZ = minZ + (gz + 0.5) * step;
      if (pointInPolygon(centerX, centerZ, polygon)) indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const material = new THREE.MeshStandardMaterial({ color: 0x8a603d, vertexColors: true, roughness: 1 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "corona_dog_park_woodchip_surface";
  mesh.receiveShadow = true;
  return mesh;
}

function makeWoodchips(map: WorldMap) {
  const capacity = 340;
  const mesh = new THREE.InstancedMesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 }),
    capacity
  );
  mesh.name = "corona_dog_park_woodchips";
  const dummy = new THREE.Object3D();
  const color = new THREE.Color();
  let count = 0;
  for (let i = 0; i < 1800 && count < capacity; i++) {
    const x = 325 + hash2(i, 3, 127) * 88;
    const z = 2677 + hash2(i, 5, 131) * 55;
    if (!pointInPolygon(x, z, CORONA_DOG_PARK)) continue;
    const length = 0.14 + hash2(i, 7, 137) * 0.34;
    dummy.position.set(x, map.groundTop(x, z) + DOG_SURFACE_LIFT + 0.04, z);
    dummy.rotation.set(0, hash2(i, 11, 139) * Math.PI * 2, (hash2(i, 13) - 0.5) * 0.2);
    dummy.scale.set(length, 0.025, 0.055 + hash2(i, 17) * 0.045);
    dummy.updateMatrix();
    mesh.setMatrixAt(count, dummy.matrix);
    color.setHex(hash2(i, 19) > 0.45 ? 0x6f492c : 0xa57a50).offsetHSL(0, 0, (hash2(i, 23) - 0.5) * 0.12);
    mesh.setColorAt(count, color);
    count++;
  }
  mesh.count = count;
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

function addBox(
  parent: THREE.Object3D,
  material: THREE.Material,
  size: readonly [number, number, number],
  position: readonly [number, number, number]
) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size[0], size[1], size[2]), material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeBench(map: WorldMap, x: number, z: number, yaw: number, lift = 0) {
  const group = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: 0x745139, roughness: 0.94 });
  const iron = new THREE.MeshStandardMaterial({ color: 0x26312d, metalness: 0.42, roughness: 0.6 });
  addBox(group, wood, [2.35, 0.14, 0.55], [0, 0.72, 0]);
  addBox(group, wood, [2.35, 0.16, 0.18], [0, 1.12, 0.25]);
  addBox(group, wood, [2.35, 0.16, 0.18], [0, 1.42, 0.3]);
  for (const bx of [-0.82, 0.82]) {
    addBox(group, iron, [0.12, 0.72, 0.12], [bx, 0.36, -0.05]);
    addBox(group, iron, [0.12, 0.8, 0.12], [bx, 0.76, 0.28]).rotation.x = -0.12;
  }
  group.position.set(x, map.groundTop(x, z) + lift, z);
  group.rotation.y = yaw;
  return group;
}

function signTexture(title: string, subtitle: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 384;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#173b31";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#e6dfc9";
  ctx.lineWidth = 18;
  ctx.strokeRect(22, 22, canvas.width - 44, canvas.height - 44);
  ctx.fillStyle = "#f4edda";
  ctx.textAlign = "center";
  ctx.font = "700 70px system-ui, sans-serif";
  ctx.fillText(title, canvas.width / 2, 150);
  ctx.font = "600 48px system-ui, sans-serif";
  ctx.fillText(subtitle, canvas.width / 2, 235);
  ctx.font = "500 28px system-ui, sans-serif";
  ctx.fillText("OFF-LEASH · 5 AM–MIDNIGHT", canvas.width / 2, 305);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeDogParkSign(map: WorldMap) {
  const group = new THREE.Group();
  group.name = "corona_dog_park_sign";
  const post = new THREE.MeshStandardMaterial({ color: 0x4f493d, roughness: 0.95 });
  const board = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.35, 0.12), new THREE.MeshStandardMaterial({ color: 0x173b31, roughness: 0.82 }));
  const face = new THREE.Mesh(
    new THREE.PlaneGeometry(2.58, 1.23),
    new THREE.MeshBasicMaterial({ map: signTexture("CORONA HEIGHTS", "DOG PLAY AREA") })
  );
  addBox(group, post, [0.14, 2.2, 0.14], [-0.9, 1.1, 0]);
  addBox(group, post, [0.14, 2.2, 0.14], [0.9, 1.1, 0]);
  board.position.y = 1.65;
  board.castShadow = true;
  face.position.set(0, 1.65, -0.066);
  face.rotation.y = Math.PI;
  group.add(board, face);
  group.position.set(
    CORONA_DOG_GATE[0] - 0.8,
    map.groundTop(CORONA_DOG_GATE[0] - 0.8, CORONA_DOG_GATE[1] + 0.4) + DOG_SURFACE_LIFT,
    CORONA_DOG_GATE[1] + 0.4
  );
  group.rotation.y = -0.95;
  return group;
}

function makeDogPark(map: WorldMap, physics: Physics) {
  const group = new THREE.Group();
  group.name = "corona_heights_dog_park";
  group.add(polygonSurface(map, CORONA_DOG_PARK));
  group.add(makeWoodchips(map));
  group.add(makeDogParkFence(map, physics));
  group.add(makeDogParkSign(map));
  group.add(makeBench(map, 350.1, 2703.4, -0.68, DOG_SURFACE_LIFT));
  group.add(makeBench(map, 353.1, 2720.6, -1.02, DOG_SURFACE_LIFT));
  const bin = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.38, 0.9, 10),
    new THREE.MeshStandardMaterial({ color: 0x34443d, metalness: 0.35, roughness: 0.62 })
  );
  bin.position.set(331, map.groundTop(331, 2723) + DOG_SURFACE_LIFT + 0.45, 2723);
  bin.castShadow = true;
  group.add(bin);
  const fountainMat = new THREE.MeshStandardMaterial({ color: 0x65716b, metalness: 0.66, roughness: 0.42 });
  const fountain = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.28, 0.92, 10), fountainMat);
  fountain.position.set(328.1, map.groundTop(328.1, 2730.2) + DOG_SURFACE_LIFT + 0.46, 2730.2);
  fountain.castShadow = true;
  const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.28, 0.1, 14), fountainMat);
  bowl.position.set(331.4, map.groundTop(331.4, 2722.2) + DOG_SURFACE_LIFT + 0.09, 2722.2);
  bowl.castShadow = true;
  group.add(fountain, bowl);
  return group;
}

function dogMesh(parent: THREE.Object3D, geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, z: number) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function makeDog(style: DogStyle): ParkDog {
  const group = new THREE.Group();
  group.name = `corona_dog_${style.name}`;
  group.scale.setScalar(style.scale);
  const coat = new THREE.MeshLambertMaterial({ color: style.coat });
  const accent = new THREE.MeshLambertMaterial({ color: style.accent });
  const dark = new THREE.MeshLambertMaterial({ color: 0x171512 });
  const collar = new THREE.MeshStandardMaterial({ color: style.collar, roughness: 0.55, metalness: 0.25 });
  const body = dogMesh(group, new THREE.SphereGeometry(1, 11, 8), coat, 0, 0.72, 0);
  body.scale.set(0.38, 0.34, style.longBody ? 0.82 : 0.69);
  const chest = dogMesh(group, new THREE.SphereGeometry(1, 9, 7), accent, 0, 0.75, -0.42);
  chest.scale.set(0.31, 0.38, 0.3);
  const head = new THREE.Group();
  head.position.set(0, 0.93, -0.65);
  group.add(head);
  const skull = dogMesh(head, new THREE.SphereGeometry(1, 10, 8), coat, 0, 0, 0);
  skull.scale.set(0.32, 0.3, 0.32);
  const muzzle = dogMesh(head, new THREE.SphereGeometry(1, 8, 6), accent, 0, -0.08, -0.3);
  muzzle.scale.set(0.22, 0.16, 0.28);
  const nose = dogMesh(head, new THREE.SphereGeometry(1, 7, 5), dark, 0, -0.04, -0.53);
  nose.scale.set(0.1, 0.08, 0.08);
  for (const side of [-1, 1]) {
    const eye = dogMesh(head, new THREE.SphereGeometry(1, 6, 4), dark, side * 0.13, 0.08, -0.27);
    eye.scale.setScalar(0.045);
    const ear = dogMesh(head, new THREE.ConeGeometry(style.floppy ? 0.15 : 0.12, style.floppy ? 0.34 : 0.29, 5), coat, side * 0.23, 0.2, -0.02);
    ear.rotation.z = side * (style.floppy ? 1.05 : 0.2);
    ear.rotation.x = style.floppy ? -0.2 : Math.PI;
  }
  const collarMesh = dogMesh(head, new THREE.TorusGeometry(0.25, 0.035, 6, 14), collar, 0, -0.16, 0.11);
  collarMesh.rotation.x = Math.PI / 2;

  const legs: THREE.Group[] = [];
  for (const x of [-0.22, 0.22]) {
    for (const z of [-0.38, 0.4]) {
      const leg = new THREE.Group();
      leg.position.set(x, 0.61, z);
      const limb = dogMesh(leg, new THREE.BoxGeometry(0.13, 0.5, 0.14), z < 0 ? accent : coat, 0, -0.25, 0);
      limb.rotation.z = x * 0.04;
      const paw = dogMesh(leg, new THREE.BoxGeometry(0.16, 0.1, 0.23), accent, 0, -0.5, -0.04);
      paw.position.z = -0.05;
      group.add(leg);
      legs.push(leg);
    }
  }
  const tail = new THREE.Group();
  tail.position.set(0, 0.8, 0.63);
  const tailMesh = dogMesh(tail, new THREE.CylinderGeometry(0.055, 0.1, 0.62, 7), coat, 0, 0.27, 0);
  tailMesh.rotation.z = 0.08;
  tail.rotation.x = 0.9;
  group.add(tail);
  return { style, group, legs, head, tail, x: 370, z: 2702, heading: 0, stride: 0, speed: 0 };
}

function ownerFacing(x: number, z: number, tx: number, tz: number) {
  return Math.atan2(-(tx - x), -(tz - z));
}

function makeOwner(map: WorldMap, action: OwnerAction, x: number, z: number, tx: number, tz: number, seed: string) {
  const rig = buildRig(avatarFromSeed(seed));
  rig.group.name = `corona_owner_${action}`;
  rig.group.scale.setScalar(1.04);
  const facing = ownerFacing(x, z, tx, tz);
  rig.group.position.set(x, map.groundTop(x, z) + DOG_SURFACE_LIFT + 0.93, z);
  rig.group.rotation.y = facing;
  return {
    action,
    rig,
    x,
    z,
    facing,
    seed: hash2(x, z, 77),
    yaw: facing,
    headYaw: 0,
    headPitch: 0,
    torsoYaw: 0,
    cheer: 0,
    cheerTimer: 0,
    greet: 0,
    greetTimer: 0,
    throwAnim: THROW_ANIM_LEN
  } satisfies ParkOwner;
}

function throwWindup(p: number) {
  return smooth01(p / 0.22) * (1 - smooth01((p - 0.26) / 0.09));
}

/** Layered procedural pose: poseIdle base, then weight shift, dog tracking,
 * cheer/greet cross-fades and the throw arm — all exponentially smoothed so
 * nothing snaps and nothing repeats on a visible loop. */
function ownerPose(map: WorldMap, owner: ParkOwner, dog: ParkDog, elapsed: number, dt: number) {
  const rig = owner.rig;
  const t = elapsed + owner.seed * 21.7;
  poseIdle(rig, t);
  const sway = Math.sin(t * 0.33);
  rig.hips.position.x = sway * 0.03;
  rig.hips.rotation.z = sway * 0.035;
  rig.torso.rotation.z -= sway * 0.02;

  // head leads toward the dog, torso follows a little, feet turn last
  const desired = Math.atan2(-(dog.x - owner.x), -(dog.z - owner.z));
  let delta = Math.atan2(Math.sin(desired - owner.yaw), Math.cos(desired - owner.yaw));
  const excess = Math.max(0, Math.abs(delta) - 0.72);
  if (excess > 1e-4) {
    owner.yaw += Math.sign(delta) * excess * (1 - Math.exp(-dt * 1.8));
    delta = Math.atan2(Math.sin(desired - owner.yaw), Math.cos(desired - owner.yaw));
  }
  const lookAround = owner.action === "watch" ? Math.sin(t * 0.17) * Math.sin(t * 0.043) * 0.5 : 0;
  const dist = Math.hypot(dog.x - owner.x, dog.z - owner.z);
  const ease = 1 - Math.exp(-dt * 5);
  owner.headYaw += (THREE.MathUtils.clamp(delta + lookAround, -0.9, 0.9) - owner.headYaw) * ease;
  owner.headPitch += (THREE.MathUtils.clamp(0.9 / Math.max(dist, 1.2), 0, 0.42) - owner.headPitch) * ease;
  owner.torsoYaw += (THREE.MathUtils.clamp(delta * 0.35, -0.25, 0.25) - owner.torsoYaw) * ease;
  rig.head.rotation.y += owner.headYaw;
  rig.head.rotation.x += owner.headPitch;
  rig.torso.rotation.y += owner.torsoYaw;

  owner.cheerTimer = Math.max(0, owner.cheerTimer - dt);
  owner.greetTimer = Math.max(0, owner.greetTimer - dt);
  if (dog.speed > 4.6 && owner.cheerTimer <= 0 && owner.greetTimer <= 0 && Math.random() < dt * 0.5) {
    owner.cheerTimer = 1.4 + Math.random() * 1.2;
  }
  const blend = 1 - Math.exp(-dt * 6);
  owner.cheer += ((owner.cheerTimer > 0 ? 1 : 0) - owner.cheer) * blend;
  owner.greet += ((owner.greetTimer > 0 ? 1 : 0) - owner.greet) * blend;
  if (owner.cheer > 1e-3) {
    rig.armL.rotation.z += 2.35 * owner.cheer;
    rig.foreL.rotation.x += (0.35 + Math.sin(t * 9) * 0.3) * owner.cheer;
    rig.hips.position.y += Math.abs(Math.sin(t * 6.5)) * 0.05 * owner.cheer;
  }
  if (owner.greet > 1e-3) {
    rig.torso.rotation.x += 0.42 * owner.greet;
    rig.head.rotation.x += 0.2 * owner.greet;
    rig.armR.rotation.x += 0.6 * owner.greet;
  }

  if (owner.throwAnim < THROW_ANIM_LEN) {
    owner.throwAnim += dt;
    const p = owner.throwAnim;
    const windup = throwWindup(p);
    const release = smooth01((p - 0.26) / 0.08) * (1 - smooth01((p - 0.5) / 0.3));
    rig.armR.rotation.x += -0.95 * windup + 1.55 * release;
    rig.foreR.rotation.x += 0.75 * windup - 0.3 * release;
    rig.torso.rotation.y += 0.32 * windup - 0.4 * release;
    rig.head.rotation.y -= 0.15 * release;
  }

  rig.group.position.set(owner.x, map.groundTop(owner.x, owner.z) + DOG_SURFACE_LIFT + 0.93, owner.z);
  rig.group.rotation.y = owner.yaw;
}

function dogSprint(style: DogStyle) {
  // big dogs top out ~7.3 m/s, corgis ~4.9 — small dogs are no longer the fastest
  return 4.7 + (style.scale - 0.8) * 8;
}

function dogTrot(style: DogStyle) {
  return 2.1 + (style.scale - 0.8) * 1.6;
}

function keepClearOfOwners(dog: ParkDog, owners: ParkOwner[]) {
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    const dx = dog.x - owner.x;
    const dz = dog.z - owner.z;
    const d = Math.hypot(dx, dz);
    if (d < OWNER_CLEARANCE && d > 1e-4) {
      const push = (OWNER_CLEARANCE - d) / d;
      dog.x += dx * push;
      dog.z += dz * push;
    }
  }
}

function dogGaitPose(map: WorldMap, dog: ParkDog, advance: number) {
  dog.stride += advance * (3.4 / dog.style.scale);
  dog.group.position.set(dog.x, map.groundTop(dog.x, dog.z) + DOG_SURFACE_LIFT + 0.04, dog.z);
  dog.group.rotation.y = dog.heading;
  dog.group.position.y += Math.abs(Math.sin(dog.stride * 0.5)) * Math.min(0.09, dog.speed * 0.016) * dog.style.scale;
  const swing = Math.sin(dog.stride) * Math.min(0.9, dog.speed * 0.19);
  dog.legs[0].rotation.x = swing;
  dog.legs[1].rotation.x = -swing;
  dog.legs[2].rotation.x = -swing;
  dog.legs[3].rotation.x = swing;
  dog.head.rotation.x = -0.05 + Math.sin(dog.stride * 2) * Math.min(0.08, dog.speed * 0.014);
  dog.tail.rotation.y = Math.sin(dog.stride * 0.72) * 0.72;
  dog.tail.rotation.x = 0.82 + Math.sin(dog.stride * 0.31) * 0.12;
}

/** Steer-and-integrate locomotion: speed accelerates toward the gait, eases
 * off inside DOG_ARRIVE, and heading obeys a turn-rate limit so a sprinting
 * dog carves an arc instead of rotating in place. */
function moveDog(map: WorldMap, dog: ParkDog, tx: number, tz: number, gait: number, owners: ParkOwner[], dt: number) {
  const step = Math.min(dt, 1 / 30);
  const dx = tx - dog.x;
  const dz = tz - dog.z;
  const d = Math.hypot(dx, dz);
  let desired = d < 0.08 ? 0 : Math.min(gait, gait * (d / DOG_ARRIVE));
  if (d > 0.08) {
    const targetHeading = Math.atan2(-dx, -dz);
    const turn = Math.atan2(Math.sin(targetHeading - dog.heading), Math.cos(targetHeading - dog.heading));
    const maxTurn = lerp(5, 1.9, clamp01(dog.speed / 7)) * step;
    dog.heading += THREE.MathUtils.clamp(turn, -maxTurn, maxTurn);
    // pointed the wrong way: slow to a tight pivot rather than overrun
    if (Math.abs(turn) > 1.2) desired = Math.min(desired, 1.4);
  }
  dog.speed += THREE.MathUtils.clamp(desired - dog.speed, -12 * step, DOG_ACCEL * step);
  const advance = dog.speed * step;
  dog.x -= Math.sin(dog.heading) * advance;
  dog.z -= Math.cos(dog.heading) * advance;
  keepClearOfOwners(dog, owners);
  dogGaitPose(map, dog, advance);
}

/** Waiting-for-the-throw idle: face the point of interest, wag hard, and every
 * few seconds give a little anticipatory hop — anticipation reads as life. */
function dogWait(map: WorldMap, dog: ParkDog, faceX: number, faceZ: number, owners: ParkOwner[], elapsed: number, dt: number) {
  const step = Math.min(dt, 1 / 30);
  dog.speed = Math.max(0, dog.speed - 12 * step);
  const advance = dog.speed * step;
  if (advance > 0) {
    dog.x -= Math.sin(dog.heading) * advance;
    dog.z -= Math.cos(dog.heading) * advance;
  }
  const desired = Math.atan2(-(faceX - dog.x), -(faceZ - dog.z));
  const turn = Math.atan2(Math.sin(desired - dog.heading), Math.cos(desired - dog.heading));
  dog.heading += THREE.MathUtils.clamp(turn, -3.4 * step, 3.4 * step);
  keepClearOfOwners(dog, owners);
  dogGaitPose(map, dog, advance);
  const seed = dog.style.coat % 97;
  const hopCycle = fract(elapsed * 0.31 + seed * 0.13);
  const hop = hopCycle < 0.1 ? Math.sin((hopCycle / 0.1) * Math.PI) : 0;
  dog.group.position.y += hop * 0.13 * dog.style.scale;
  dog.legs[0].rotation.x = dog.legs[2].rotation.x = hop * 0.5;
  dog.legs[1].rotation.x = dog.legs[3].rotation.x = -hop * 0.4;
  dog.head.rotation.x = 0.22 + hop * 0.15; // gaze up at the human
  dog.tail.rotation.y = Math.sin(elapsed * 11 + seed) * 0.95;
  dog.tail.rotation.x = 0.6;
}

function throwTargetClear(x: number, z: number) {
  return (
    pointInPolygon(x, z, CORONA_DOG_PARK) &&
    pointInPolygon(x + 2.2, z, CORONA_DOG_PARK) &&
    pointInPolygon(x - 2.2, z, CORONA_DOG_PARK) &&
    pointInPolygon(x, z + 2.2, CORONA_DOG_PARK) &&
    pointInPolygon(x, z - 2.2, CORONA_DOG_PARK)
  );
}

function dogMouth(dog: ParkDog, out: THREE.Vector3) {
  const scale = dog.style.scale;
  out.set(
    dog.x - Math.sin(dog.heading) * 0.84 * scale,
    dog.group.position.y + 0.82 * scale,
    dog.z - Math.cos(dog.heading) * 0.84 * scale
  );
  return out;
}

export class CoronaHeightsPark {
  readonly group = new THREE.Group();
  readonly activity = new THREE.Group();
  readonly foliage = new THREE.Group();
  readonly dogs: ParkDog[];
  readonly owners: ParkOwner[];
  readonly stats: CoronaHeightsStats;
  readonly summit = CORONA_HEIGHTS_SUMMIT;

  /** Elapsed-time stamp of the latest ball/frisbee release (audio hook). */
  lastThrowAt = -Infinity;

  #map: WorldMap;
  #ball: THREE.Mesh;
  #frisbee: THREE.Mesh;
  #mouth = new THREE.Vector3();
  #propTarget = new THREE.Vector3();
  #spinAxis = new THREE.Vector3();
  #segs: FenceSegment2D[];
  #segTop: Float64Array;
  #fenceTopMax = -Infinity;
  #wander: WanderState[];
  #throwX = 0;
  #throwZ = 0;
  // ball: held-by-owner → windup → free flight/bounce/roll → carried back
  #ballPhase: "held" | "windup" | "free" | "carried" = "held";
  #ballTimer = 2.2;
  #ballVX = 0;
  #ballVY = 0;
  #ballVZ = 0;
  #ballGrounded = false;
  #ballFetch: FetchStage = "wait";
  #ballReact = 0;
  // frisbee keeps a scripted glide (frisbees don't roll) with the same fetch treatment
  #friPhase: "held" | "windup" | "glide" | "settle" | "rest" | "carried" = "held";
  #friTimer = 4.2;
  #friDur = 1.6;
  #friLift = 3;
  #friCurve = 0;
  #friSpin = 0;
  #friFromX = 0;
  #friFromY = 0;
  #friFromZ = 0;
  #friToX = 0;
  #friToY = 0;
  #friToZ = 0;
  #friPerpX = 0;
  #friPerpZ = 0;
  #friFetch: FetchStage = "wait";
  #friReact = 0;

  constructor(map: WorldMap, physics: Physics) {
    this.#map = map;
    this.group.name = "corona_heights_park";
    this.activity.name = "corona_heights_dog_activity";
    this.foliage.name = "corona_heights_foliage";

    this.group.add(makeHillSkin(map));
    this.group.add(makeQuarryFace(map));
    this.group.add(makeTrails(map));
    this.group.add(makeRockField(map, physics));
    this.group.add(makeSummitCrags(map, physics));
    this.foliage.add(makeHillGrass(map), makeWildflowers(map), makeShrubsAndTrees(map));
    this.group.add(this.foliage);
    this.group.add(makeDogPark(map, physics));
    this.group.add(makeBench(map, 430, 2751, Math.PI * 0.44));

    this.dogs = [
      makeDog({ name: "golden", coat: 0xb97835, accent: 0xe4bb72, collar: 0x2f86b6, scale: 1.12, floppy: true }),
      makeDog({ name: "border_collie", coat: 0x24201d, accent: 0xf0e8db, collar: 0xd84f43, scale: 1.0, longBody: true }),
      makeDog({ name: "terrier", coat: 0xb7a58d, accent: 0xeee1ce, collar: 0x48a96b, scale: 0.78 }),
      makeDog({ name: "corgi", coat: 0xb96429, accent: 0xf2e3cc, collar: 0x7f5ac9, scale: 0.82, longBody: true })
    ];
    const initial: readonly CoronaXZ[] = [[350, 2715], [394, 2698], [366, 2696], [380, 2707]];
    this.dogs.forEach((dog, i) => {
      dog.x = initial[i][0];
      dog.z = initial[i][1];
      dog.group.position.set(dog.x, map.groundTop(dog.x, dog.z) + DOG_SURFACE_LIFT + 0.04, dog.z);
      this.activity.add(dog.group);
    });

    this.owners = [
      makeOwner(map, "ball", 342, 2717, 366, 2708, "corona-ball-owner"),
      makeOwner(map, "frisbee", 399, 2687, 378, 2700, "corona-frisbee-owner"),
      makeOwner(map, "watch", 372, 2711, 372, 2700, "corona-watching-owner")
    ];
    for (const owner of this.owners) this.activity.add(owner.rig.group);

    this.#ball = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0xb9ef31, roughness: 0.62 })
    );
    this.#ball.name = "corona_tennis_ball";
    this.#ball.castShadow = true;
    this.#frisbee = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 0.055, 20),
      new THREE.MeshStandardMaterial({ color: 0xff654a, roughness: 0.68 })
    );
    this.#frisbee.name = "corona_frisbee";
    this.#frisbee.castShadow = true;
    this.activity.add(this.#ball, this.#frisbee);
    this.group.add(this.activity);

    this.#segs = dogParkFenceSegments();
    this.#segTop = new Float64Array(this.#segs.length);
    for (let i = 0; i < this.#segs.length; i++) {
      const seg = this.#segs[i];
      const top = Math.max(map.groundTop(seg.ax, seg.az), map.groundTop(seg.bx, seg.bz)) + 1.55;
      this.#segTop[i] = top;
      this.#fenceTopMax = Math.max(this.#fenceTopMax, top);
    }
    this.#wander = [
      { mode: "roam", tx: 366, tz: 2699, timer: 0, dur: 1 },
      { mode: "roam", tx: 384, tz: 2696, timer: 0, dur: 1 }
    ];
    this.stats = { dogs: this.dogs.length, owners: this.owners.length, summit: CORONA_HEIGHTS_SUMMIT };
  }

  setFoliageVisible(visible: boolean) {
    this.foliage.visible = visible;
  }

  update(dt: number, elapsed: number, viewPos: { x: number; z: number }) {
    const distance = Math.hypot(viewPos.x - CORONA_HEIGHTS_SUMMIT.x, viewPos.z - CORONA_HEIGHTS_SUMMIT.z);
    this.group.visible = distance < DETAIL_RANGE;
    if (!this.group.visible) return;
    this.activity.visible = distance < ACTIVITY_RANGE;
    if (!this.activity.visible) return;

    this.#updateBallFetch(dt, elapsed);
    this.#updateFrisbeeFetch(dt, elapsed);
    this.#updateWander(this.#wander[0], this.dogs[2], this.dogs[3], dt, elapsed);
    this.#updateWander(this.#wander[1], this.dogs[3], this.dogs[2], dt, elapsed);

    // owners pose after the dogs move so gaze tracking uses fresh positions
    ownerPose(this.#map, this.owners[0], this.dogs[0], elapsed, dt);
    ownerPose(this.#map, this.owners[1], this.dogs[1], elapsed, dt);
    const watcher = this.owners[2];
    let watched = this.dogs[0];
    let best = Infinity;
    for (let i = 0; i < this.dogs.length; i++) {
      const dog = this.dogs[i];
      const d = (dog.x - watcher.x) ** 2 + (dog.z - watcher.z) ** 2;
      if (d < best) {
        best = d;
        watched = dog;
      }
    }
    ownerPose(this.#map, watcher, watched, elapsed, dt);
  }

  #handPos(owner: ParkOwner, windup: number, out: THREE.Vector3) {
    const lx = 0.35;
    const ly = 1.22 + 0.42 * windup;
    const lz = -0.22 + 0.62 * windup;
    const sin = Math.sin(owner.yaw);
    const cos = Math.cos(owner.yaw);
    out.set(
      owner.x + lx * cos + lz * sin,
      this.#map.groundTop(owner.x, owner.z) + DOG_SURFACE_LIFT + ly,
      owner.z - lx * sin + lz * cos
    );
    return out;
  }

  /** Rejection-sample a landing point whose 2.2 m surroundings stay inside the
   * park polygon, biased toward the interior; falls back to the centre. */
  #pickThrowTarget(owner: ParkOwner, minDist: number, maxDist: number) {
    const baseA = Math.atan2(371 - owner.x, 2702 - owner.z);
    for (let i = 0; i < 16; i++) {
      const a = baseA + (Math.random() - 0.5) * 1.1;
      const dist = minDist + Math.random() * (maxDist - minDist);
      const x = owner.x + Math.sin(a) * dist;
      const z = owner.z + Math.cos(a) * dist;
      if (throwTargetClear(x, z)) {
        this.#throwX = x;
        this.#throwZ = z;
        return;
      }
    }
    this.#throwX = 371;
    this.#throwZ = 2702;
  }

  #fenceClearance(x: number, z: number) {
    let best = Infinity;
    for (let i = 0; i < this.#segs.length; i++) {
      const seg = this.#segs[i];
      const ex = seg.bx - seg.ax;
      const ez = seg.bz - seg.az;
      const t = clamp01(((x - seg.ax) * ex + (z - seg.az) * ez) / (ex * ex + ez * ez));
      best = Math.min(best, Math.hypot(x - (seg.ax + ex * t), z - (seg.az + ez * t)));
    }
    return best;
  }

  #updateBallFetch(dt: number, elapsed: number) {
    const owner = this.owners[0];
    const dog = this.dogs[0];
    const ball = this.#ball;
    if (this.#ballPhase === "held" || this.#ballPhase === "windup") {
      const w = this.#ballPhase === "windup" ? throwWindup(Math.min(owner.throwAnim, THROW_RELEASE)) : 0;
      ball.position.copy(this.#handPos(owner, w, this.#propTarget));
      if (this.#ballPhase === "held") {
        this.#ballTimer -= dt;
        if (this.#ballTimer <= 0 && this.#ballFetch === "wait") {
          this.#ballPhase = "windup";
          owner.throwAnim = 0;
        }
      } else if (owner.throwAnim >= THROW_RELEASE) {
        this.#launchBall(owner, elapsed);
      }
    } else if (this.#ballPhase === "free") {
      this.#stepBall(dt);
    } else {
      ball.position.copy(dogMouth(dog, this.#mouth));
    }

    switch (this.#ballFetch) {
      case "wait":
        dogWait(this.#map, dog, owner.x, owner.z, this.owners, elapsed, dt);
        break;
      case "react":
        this.#ballReact -= dt;
        dogWait(this.#map, dog, ball.position.x, ball.position.z, this.owners, elapsed, dt);
        if (this.#ballReact <= 0) this.#ballFetch = "chase";
        break;
      case "chase": {
        moveDog(this.#map, dog, ball.position.x, ball.position.z, dogSprint(dog.style), this.owners, dt);
        const d = Math.hypot(ball.position.x - dog.x, ball.position.z - dog.z);
        const ballSpeed = Math.hypot(this.#ballVX, this.#ballVZ);
        // the wide-radius fallback covers a ball resting inside an owner's clearance ring
        const pickup =
          this.#ballGrounded && ((ballSpeed < 2.4 && d < 0.55) || (ballSpeed < 0.05 && d < 1));
        if (this.#ballPhase === "free" && pickup) {
          this.#ballPhase = "carried";
          this.#ballFetch = "return";
        }
        break;
      }
      case "return": {
        const dx = dog.x - owner.x;
        const dz = dog.z - owner.z;
        const d = Math.hypot(dx, dz) || 1;
        // stop short on the dog's side of the owner rather than running them over
        moveDog(this.#map, dog, owner.x + (dx / d) * 1.1, owner.z + (dz / d) * 1.1, dogSprint(dog.style) * 0.55, this.owners, dt);
        if (d < 1.45 && dog.speed < 0.9) {
          this.#ballPhase = "held";
          this.#ballTimer = 1.5 + Math.random() * 1.5;
          this.#ballFetch = "wait";
          owner.greetTimer = 1.1;
        }
        break;
      }
    }
  }

  #launchBall(owner: ParkOwner, elapsed: number) {
    const ball = this.#ball;
    this.#pickThrowTarget(owner, 9, 22);
    const flight = 1 + Math.random() * 0.4;
    const ty = this.#map.groundTop(this.#throwX, this.#throwZ) + DOG_SURFACE_LIFT + BALL_R;
    this.#ballVX = (this.#throwX - ball.position.x) / flight;
    this.#ballVZ = (this.#throwZ - ball.position.z) / flight;
    this.#ballVY = (ty - ball.position.y) / flight + 4.9 * flight;
    this.#ballGrounded = false;
    this.#ballPhase = "free";
    this.#ballFetch = "react";
    this.#ballReact = 0.2 + Math.random() * 0.2; // dogs read the throw first
    this.lastThrowAt = elapsed;
  }

  /** Ballistic flight, restitution bounces, then woodchip rolling with terrain
   * downhill drift. Substepped so a frame hitch can't tunnel through the fence:
   * 1/90 keeps the fastest throw (≤22 m/s) under one ball radius per step. */
  #stepBall(dt: number) {
    const ball = this.#ball;
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-5) {
      const h = Math.min(remaining, 1 / 90);
      remaining -= h;
      const px = ball.position.x;
      const pz = ball.position.z;
      if (!this.#ballGrounded) {
        this.#ballVY -= 9.8 * h;
        ball.position.x += this.#ballVX * h;
        ball.position.y += this.#ballVY * h;
        ball.position.z += this.#ballVZ * h;
        const gy = this.#map.groundTop(ball.position.x, ball.position.z) + DOG_SURFACE_LIFT + BALL_R;
        if (ball.position.y <= gy && this.#ballVY < 0) {
          ball.position.y = gy;
          this.#ballVY = -this.#ballVY * 0.55;
          this.#ballVX *= 0.85;
          this.#ballVZ *= 0.85;
          if (this.#ballVY < 1.5) {
            this.#ballVY = 0;
            this.#ballGrounded = true;
          }
        }
      } else {
        const speed = Math.hypot(this.#ballVX, this.#ballVZ);
        if (speed > 1e-4) {
          const k = Math.max(0, speed - 1.6 * h) / speed; // woodchip friction
          this.#ballVX *= k;
          this.#ballVZ *= k;
        }
        const gx =
          (this.#map.groundTop(ball.position.x + 0.6, ball.position.z) -
            this.#map.groundTop(ball.position.x - 0.6, ball.position.z)) /
          1.2;
        const gz =
          (this.#map.groundTop(ball.position.x, ball.position.z + 0.6) -
            this.#map.groundTop(ball.position.x, ball.position.z - 0.6)) /
          1.2;
        this.#ballVX -= 4.9 * gx * h;
        this.#ballVZ -= 4.9 * gz * h;
        ball.position.x += this.#ballVX * h;
        ball.position.z += this.#ballVZ * h;
        ball.position.y = this.#map.groundTop(ball.position.x, ball.position.z) + DOG_SURFACE_LIFT + BALL_R;
      }
      this.#collideBallFence();
      const dx = ball.position.x - px;
      const dz = ball.position.z - pz;
      const travelled = Math.hypot(dx, dz);
      if (travelled > 1e-6) {
        // visible roll: spin about the axis perpendicular to travel
        this.#spinAxis.set(-dz / travelled, 0, dx / travelled);
        ball.rotateOnWorldAxis(this.#spinAxis, (travelled / BALL_R) * (this.#ballGrounded ? 1 : 0.35));
      }
    }
  }

  #collideBallFence() {
    const ball = this.#ball;
    if (ball.position.y > this.#fenceTopMax) return;
    const rad = BALL_R + FENCE_PAD;
    // two sequential passes settle corner hits without a solver
    for (let iter = 0; iter < 2; iter++) {
      let hit = false;
      for (let i = 0; i < this.#segs.length; i++) {
        if (ball.position.y > this.#segTop[i]) continue;
        const seg = this.#segs[i];
        const ex = seg.bx - seg.ax;
        const ez = seg.bz - seg.az;
        const t = clamp01(((ball.position.x - seg.ax) * ex + (ball.position.z - seg.az) * ez) / (ex * ex + ez * ez));
        const cx = seg.ax + ex * t;
        const cz = seg.az + ez * t;
        let nx = ball.position.x - cx;
        let nz = ball.position.z - cz;
        const d = Math.hypot(nx, nz);
        if (d >= rad) continue;
        if (d > 1e-4 && nx * seg.nx + nz * seg.nz > 0) {
          nx /= d;
          nz /= d;
        } else {
          // tunnelled past the line: recover along the inward normal
          nx = seg.nx;
          nz = seg.nz;
        }
        ball.position.x = cx + nx * rad;
        ball.position.z = cz + nz * rad;
        const vn = this.#ballVX * nx + this.#ballVZ * nz;
        if (vn < 0) {
          this.#ballVX -= 1.6 * vn * nx;
          this.#ballVZ -= 1.6 * vn * nz;
        }
        hit = true;
      }
      if (!hit) break;
    }
  }

  #updateFrisbeeFetch(dt: number, elapsed: number) {
    const owner = this.owners[1];
    const dog = this.dogs[1];
    const f = this.#frisbee;
    switch (this.#friPhase) {
      case "held":
      case "windup": {
        const w = this.#friPhase === "windup" ? throwWindup(Math.min(owner.throwAnim, THROW_RELEASE)) : 0;
        f.position.copy(this.#handPos(owner, w, this.#propTarget));
        f.rotation.set(0.35 + w * 0.3, owner.yaw, 0.3);
        if (this.#friPhase === "held") {
          this.#friTimer -= dt;
          if (this.#friTimer <= 0 && this.#friFetch === "wait") {
            this.#friPhase = "windup";
            owner.throwAnim = 0;
          }
        } else if (owner.throwAnim >= THROW_RELEASE) {
          this.#launchFrisbee(owner, elapsed);
        }
        break;
      }
      case "glide": {
        this.#friTimer += dt;
        const s = Math.min(1, this.#friTimer / this.#friDur);
        const bow = Math.sin(Math.PI * s);
        f.position.set(
          lerp(this.#friFromX, this.#friToX, s) + this.#friPerpX * this.#friCurve * bow,
          lerp(this.#friFromY, this.#friToY, s) + bow * this.#friLift,
          lerp(this.#friFromZ, this.#friToZ, s) + this.#friPerpZ * this.#friCurve * bow
        );
        this.#friSpin += dt * 14;
        f.rotation.set(0.22 * (1 - s * 0.5), this.#friSpin, this.#friCurve * 0.12 * bow);
        if (s >= 1) {
          this.#friPhase = "settle";
          this.#friTimer = 0;
        }
        break;
      }
      case "settle": {
        // wobble-settle: rock and ring down instead of a hard stop
        this.#friTimer += dt;
        const p = Math.min(1, this.#friTimer / 0.55);
        const decay = (1 - p) * (1 - p);
        this.#friSpin += dt * 14 * decay;
        f.position.set(this.#friToX, this.#friToY + Math.abs(Math.sin(p * 9)) * 0.1 * decay, this.#friToZ);
        f.rotation.set(0.12 * decay + 0.02, this.#friSpin, Math.sin(p * 22) * 0.35 * decay);
        if (p >= 1) this.#friPhase = "rest";
        break;
      }
      case "rest":
        f.position.set(this.#friToX, this.#friToY, this.#friToZ);
        f.rotation.set(0.02, this.#friSpin, 0);
        break;
      case "carried":
        f.position.copy(dogMouth(dog, this.#mouth));
        f.rotation.set(0.5, dog.heading, 0);
        break;
    }

    switch (this.#friFetch) {
      case "wait":
        dogWait(this.#map, dog, owner.x, owner.z, this.owners, elapsed, dt);
        break;
      case "react":
        this.#friReact -= dt;
        dogWait(this.#map, dog, f.position.x, f.position.z, this.owners, elapsed, dt);
        if (this.#friReact <= 0) this.#friFetch = "chase";
        break;
      case "chase": {
        moveDog(this.#map, dog, f.position.x, f.position.z, dogSprint(dog.style), this.owners, dt);
        const d = Math.hypot(f.position.x - dog.x, f.position.z - dog.z);
        const catchable =
          this.#friPhase === "rest" ||
          this.#friPhase === "settle" ||
          (this.#friPhase === "glide" && f.position.y - this.#map.groundTop(dog.x, dog.z) < 1.2);
        if (catchable && (d < 0.7 || (this.#friPhase === "rest" && d < 1))) {
          this.#friPhase = "carried";
          this.#friFetch = "return";
        }
        break;
      }
      case "return": {
        const dx = dog.x - owner.x;
        const dz = dog.z - owner.z;
        const d = Math.hypot(dx, dz) || 1;
        moveDog(this.#map, dog, owner.x + (dx / d) * 1.1, owner.z + (dz / d) * 1.1, dogSprint(dog.style) * 0.55, this.owners, dt);
        if (d < 1.45 && dog.speed < 0.9) {
          this.#friPhase = "held";
          this.#friTimer = 2.5 + Math.random() * 1.8;
          this.#friFetch = "wait";
          owner.greetTimer = 1.1;
        }
        break;
      }
    }
  }

  #launchFrisbee(owner: ParkOwner, elapsed: number) {
    const f = this.#frisbee;
    this.#pickThrowTarget(owner, 9, 20);
    this.#friFromX = f.position.x;
    this.#friFromY = f.position.y;
    this.#friFromZ = f.position.z;
    this.#friToX = this.#throwX;
    this.#friToZ = this.#throwZ;
    this.#friToY = this.#map.groundTop(this.#throwX, this.#throwZ) + DOG_SURFACE_LIFT + 0.06;
    const dirX = this.#friToX - this.#friFromX;
    const dirZ = this.#friToZ - this.#friFromZ;
    const inv = 1 / (Math.hypot(dirX, dirZ) || 1);
    this.#friPerpX = -dirZ * inv;
    this.#friPerpZ = dirX * inv;
    this.#friDur = 1.3 + Math.random() * 0.6;
    this.#friLift = 2.2 + Math.random() * 1.4;
    this.#friCurve = (Math.random() - 0.5) * 7;
    this.#friPhase = "glide";
    this.#friTimer = 0;
    this.#friFetch = "react";
    this.#friReact = 0.25 + Math.random() * 0.15;
    this.lastThrowAt = elapsed;
  }

  #updateWander(state: WanderState, dog: ParkDog, other: ParkDog, dt: number, elapsed: number) {
    switch (state.mode) {
      case "roam":
        moveDog(this.#map, dog, state.tx, state.tz, dogTrot(dog.style), this.owners, dt);
        if (Math.hypot(state.tx - dog.x, state.tz - dog.z) < 0.7) {
          state.mode = "sniff";
          state.dur = 1 + Math.random() * 3;
          state.timer = state.dur;
        }
        break;
      case "sniff": {
        moveDog(this.#map, dog, dog.x, dog.z, 0, this.owners, dt);
        const p = 1 - state.timer / state.dur;
        const dip = smooth01(p * 5) * (1 - smooth01((p - 0.82) / 0.18));
        dog.head.rotation.x = -0.62 * dip + Math.sin(elapsed * 7) * 0.06 * dip;
        dog.tail.rotation.y = Math.sin(elapsed * 2.1) * 0.3;
        state.timer -= dt;
        if (state.timer <= 0) {
          if (Math.random() < 0.3) {
            state.mode = "chase";
            state.timer = 2.2 + Math.random() * 1.8;
          } else {
            this.#pickWanderPoint(state, dog);
            state.mode = "roam";
          }
        }
        break;
      }
      case "chase": {
        // play burst: run at the other wander dog, break off once caught
        const dx = dog.x - other.x;
        const dz = dog.z - other.z;
        const d = Math.hypot(dx, dz) || 1;
        moveDog(
          this.#map,
          dog,
          other.x + (dx / d) * 0.9,
          other.z + (dz / d) * 0.9,
          Math.min(3.9, dogSprint(dog.style) * 0.85),
          this.owners,
          dt
        );
        state.timer -= dt;
        if (state.timer <= 0 || d < 1.1) {
          this.#pickWanderPoint(state, dog);
          state.mode = "roam";
        }
        break;
      }
    }
  }

  #pickWanderPoint(state: WanderState, dog: ParkDog) {
    for (let i = 0; i < 12; i++) {
      const x = 326 + Math.random() * 85;
      const z = 2679 + Math.random() * 52;
      if (!pointInPolygon(x, z, CORONA_DOG_PARK)) continue;
      if (this.#fenceClearance(x, z) < 1.5) continue;
      if (Math.hypot(x - dog.x, z - dog.z) < 3) continue;
      state.tx = x;
      state.tz = z;
      return;
    }
    state.tx = 371;
    state.tz = 2702;
  }
}
