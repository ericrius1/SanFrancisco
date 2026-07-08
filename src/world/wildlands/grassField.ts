// Wildlands grass — a modular blade-grass system for the open nature regions,
// SEPARATE from the botanical garden's grass (different tuning, its own group,
// independently toggleable) but sharing the ground-cover infra: the wind gust
// envelope and the player trample displacers.
//
// Cost is made independent of region size by growing grass only in a ring that
// FOLLOWS the player (re-sampled when they move past a step). Outside the
// wildlands regions the ring samples nothing, so it's free in the city. This is
// the same idea as the garden's near-detail ring, kept simple + standalone.

import * as THREE from "three/webgpu";
import {
  attribute,
  float,
  Fn,
  hash,
  instanceIndex,
  Loop,
  modelWorldMatrix,
  positionLocal,
  sin,
  time,
  vec3,
  vec4
} from "three/tsl";
import { windGustGlobal } from "../groundcover/wind";
import { DISPLACERS, MAX_DISPLACERS } from "../groundcover/displacers";
import { inBotanicalGarden, type GardenTerrain } from "../garden/layout";
import { wildRegionAt } from "./layout";

type N = any;

const RING_RADIUS = 60; // grass grows within this of the player
const RESAMPLE_STEP = 10; // re-scatter after the focus moves this far (m)
const SPACING = 1.0;
const WIND_DIR = new THREE.Vector3(0.85, 0, 0.53).normalize();

// deterministic hash → stable scatter as the ring slides over the world
function hash2(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell, fz = z / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ax = fx - ix, az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax), sz = az * az * (3 - 2 * az);
  const n00 = hash2(ix, iz, salt), n10 = hash2(ix + 1, iz, salt);
  const n01 = hash2(ix, iz + 1, salt), n11 = hash2(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

/** A tuft of curved blades. Vertex colour root(dark)→tip(light); aSway 0→1 up. */
function bladeClusterGeometry(): THREE.BufferGeometry {
  const blades = 5, segments = 3;
  const positions: number[] = [], colors: number[] = [], sway: number[] = [], indices: number[] = [];
  let base = 0;
  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI * 2 + (b % 2) * 0.5;
    const rootR = 0.12 * ((b * 4.7) % 1);
    const rootX = Math.cos(yaw + 1.3) * rootR, rootZ = Math.sin(yaw + 1.3) * rootR;
    const dirX = Math.cos(yaw), dirZ = Math.sin(yaw);
    const sideX = -dirZ, sideZ = dirX;
    const bend = 0.24 * (0.7 + 0.5 * ((b * 2.2) % 1));
    const width = 0.05 * (0.8 + 0.4 * ((b * 3.3) % 1));
    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const curve = 2 * (1 - t) * t * bend;
      const hw = width * (1 - t * 0.85) * 0.5;
      const cx = rootX + dirX * curve, cz = rootZ + dirZ * curve;
      positions.push(cx - sideX * hw, t, cz - sideZ * hw, cx + sideX * hw, t, cz + sideZ * hw);
      const shade = 0.5 + t * 0.5;
      colors.push(shade, shade, shade * 0.9, shade, shade, shade * 0.9);
      sway.push(t * t, t * t);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2, c = base + (i + 1) * 2;
      indices.push(a, a + 1, c, a + 1, c + 1, c);
    }
    // pointed tip
    const tip = base + (segments + 1) * 2;
    positions.push(rootX + dirX * bend, 1.04, rootZ + dirZ * bend);
    colors.push(1, 1, 0.9);
    sway.push(1);
    indices.push(base + segments * 2, base + segments * 2 + 1, tip);
    base = tip + 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  g.setAttribute("aSway", new THREE.Float32BufferAttribute(sway, 1));
  g.setIndex(indices);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

function grassMaterial(): THREE.Material {
  const mat = new THREE.MeshStandardNodeMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide });
  const sway: N = attribute("aSway", "float");
  const ph: N = (hash(instanceIndex) as N).mul(6.283);
  const windAmp: N = (windGustGlobal as N).mul(0.9).add(0.35);
  const bend: N = (sin(time.mul(1.0).add(ph)) as N).mul(0.6).add((sin(time.mul(2.3).add(ph.mul(1.7))) as N).mul(0.4));
  const cross: N = sin(time.mul(0.8).add(ph.mul(1.3)));

  // SHARED trample — same displacer field as the garden grass + wildflowers.
  const anchorWorld: N = (modelWorldMatrix as N).mul(vec4(0, 0, 0, 1)).xz;
  const crush: N = (Fn(() => {
    const c = (float(0) as N).toVar();
    Loop(MAX_DISPLACERS, ({ i }: { i: N }) => {
      const d = (DISPLACERS as N).element(i);
      const len = anchorWorld.sub(d.xy).length().max(1e-4);
      const infl = d.z.sub(len).div(d.z.max(1e-4)).clamp(0, 1);
      c.addAssign(infl.mul(infl).mul(d.w));
    });
    return c.min(1);
  }) as N)();
  const windDamp: N = float(1).sub(crush.mul(0.8));
  const amp = 0.14;
  const wind: N = vec3(bend.mul(amp).mul(WIND_DIR.x), float(0), cross.mul(amp).mul(WIND_DIR.z))
    .mul(sway.pow(1.8))
    .mul(windAmp)
    .mul(windDamp);
  const flatten: N = vec3(0, crush.mul(-0.55).mul(sway), 0); // pressed flat underfoot
  mat.positionNode = (positionLocal as N).add(wind).add(flatten);
  return mat;
}

export type WildGrass = {
  group: THREE.Group;
  update(focus: { x: number; z: number }): void;
  stats: { count: number };
};

export function createWildGrass(map: GardenTerrain): WildGrass {
  const group = new THREE.Group();
  group.name = "wildlands_grass";
  const geometry = bladeClusterGeometry();
  const material = grassMaterial();

  // one pooled InstancedMesh, matrices/colours rewritten in place as the ring
  // slides. Cap sized for a full dense ring.
  const cap = Math.ceil(Math.pow((RING_RADIUS * 2) / SPACING, 2) * 0.6) + 256;
  const mesh = new THREE.InstancedMesh(geometry, material, cap);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false; // the ring is always around the camera
  mesh.count = 0;
  group.add(mesh);

  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  const last = { x: 1e9, z: 1e9 };

  function plantable(x: number, z: number): boolean {
    const r = wildRegionAt(x, z);
    if (!r) return false;
    if (inBotanicalGarden(x, z, 6)) return false; // garden grows its own grass
    if (map.isWater(x, z)) return false;
    return r.plantClasses.includes(map.surfaceType(x, z));
  }

  function resample(fx: number, fz: number) {
    let n = 0;
    const r2 = RING_RADIUS * RING_RADIUS;
    const gx0 = Math.floor((fx - RING_RADIUS) / SPACING);
    const gx1 = Math.ceil((fx + RING_RADIUS) / SPACING);
    const gz0 = Math.floor((fz - RING_RADIUS) / SPACING);
    const gz1 = Math.ceil((fz + RING_RADIUS) / SPACING);
    for (let gx = gx0; gx <= gx1 && n < cap; gx++) {
      for (let gz = gz0; gz <= gz1 && n < cap; gz++) {
        const px = gx * SPACING + (hash2(gx, gz, 11) - 0.5) * SPACING * 0.9;
        const pz = gz * SPACING + (hash2(gx, gz, 17) - 0.5) * SPACING * 0.9;
        const dx = px - fx, dz = pz - fz;
        if (dx * dx + dz * dz > r2) continue;
        // density noise → clumps + clearings, not an even carpet
        const patch = valueNoise(px, pz, 26, 701);
        if (hash2(gx, gz, 23) > 0.44 + patch * 0.5) continue;
        if (!plantable(px, pz)) continue;
        const y = map.groundHeight(px, pz);
        const h = 0.42 + hash2(gx, gz, 31) * 0.55;
        const spread = 0.72 + hash2(gx, gz, 37) * 0.4;
        dummy.position.set(px, y - 0.05, pz);
        dummy.rotation.set(0, hash2(gx, gz, 41) * Math.PI * 2, 0);
        dummy.scale.set(spread, h, spread);
        dummy.updateMatrix();
        mesh.setMatrixAt(n, dummy.matrix);
        // deep meadow greens, tuft-to-tuft variation (dry-tan spars where patch low)
        const shade = 0.72 + hash2(gx, gz, 43) * 0.4;
        const dry = (1 - patch) * 0.18;
        col.setRGB((0.2 + dry) * shade, (0.42 - dry * 0.4) * shade, 0.14 * shade);
        mesh.setColorAt(n, col);
        n++;
      }
    }
    mesh.count = n;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  return {
    group,
    update(focus) {
      const dx = focus.x - last.x, dz = focus.z - last.z;
      if (dx * dx + dz * dz < RESAMPLE_STEP * RESAMPLE_STEP) return;
      last.x = focus.x;
      last.z = focus.z;
      resample(focus.x, focus.z);
    },
    stats: { count: 0 }
  };
}
