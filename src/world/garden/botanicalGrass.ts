import * as THREE from "three/webgpu";
import {
  attribute,
  cameraViewMatrix,
  color,
  float,
  Fn,
  Loop,
  mix,
  modelWorldMatrix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionLocal,
  sin,
  time,
  uniform,
  vec2,
  vec3,
  vec4
} from "three/tsl";
import { windSpeed, windStrength } from "../../../vendor/SeedThree/src/core/wind.js";
import { windGustGlobal } from "./wind";
import {
  BOTANICAL_GARDEN_BOUNDS,
  GARDEN_SPECIES,
  gardenPathSignedDistance,
  gardenSurfaceHeight,
  inBotanicalGarden,
  meadowEllipse,
  type GardenTerrain,
  type GardenTree
} from "./layout";
import { DISPLACERS, MAX_DISPLACERS, setGroundDisplacers, type GroundDisplacer } from "../groundcover/displacers";
import { GRASS_TUNING } from "./grassTuning";

type GrassEntry = {
  x: number;
  y: number;
  z: number;
  yaw: number;
  height: number;
  spread: number;
  color: THREE.Color;
  windX: number;
  windZ: number;
};

export type BotanicalGrassStats = {
  baseLow: number;
  baseTall: number;
  detailLow: number;
  detailTall: number;
};

type GrassFocus = { x: number; z: number };

type GrassSampleOptions = {
  spacing: number;
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number };
  salt?: number;
  densityScale?: number;
  focus?: GrassFocus & { radius: number };
};

const TREE_BUCKET = 18;
const DETAIL_SALT = 1307;
const WIND_DIR = new THREE.Vector3(0.85, 0, 0.53).normalize();
const GRASS_FADE_BAND = uniform(0.16);
const GRASS_DENSITY_FOCUS = uniform(new THREE.Vector2(1e6, 1e6));
// Player/creature trample now lives in the SHARED ground-cover displacer field
// (../groundcover/displacers) so the wildlands grass + wildflowers bend to the
// same points. Re-exported here under the historical names so garden/index and
// main keep importing them from the grass module.
export const MAX_GRASS_DISPLACERS = MAX_DISPLACERS;
export type GrassDisplacer = GroundDisplacer;
export const setGrassDisplacers = setGroundDisplacers;
// TSL's d.ts narrows chained vector nodes too aggressively for vendored JS uniforms.
type TslNode = any;
const windSpeedNode = windSpeed as TslNode;
const windStrengthNode = windStrength as TslNode;

function hash(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell;
  const fz = z / cell;
  const ix = Math.floor(fx);
  const iz = Math.floor(fz);
  const ax = fx - ix;
  const az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax);
  const sz = az * az * (3 - 2 * az);
  const n00 = hash(ix, iz, salt);
  const n10 = hash(ix + 1, iz, salt);
  const n01 = hash(ix, iz + 1, salt);
  const n11 = hash(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}

function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / Math.max(1e-5, b - a)));
  return u * u * (3 - 2 * u);
}

function groundAt(map: GardenTerrain, x: number, z: number): number {
  return gardenSurfaceHeight(map, x, z);
}

function createTreeInfluence(trees: GardenTree[]) {
  const buckets = new Map<string, GardenTree[]>();
  const key = (ix: number, iz: number) => `${ix},${iz}`;
  for (const tree of trees) {
    const ix = Math.floor(tree.x / TREE_BUCKET);
    const iz = Math.floor(tree.z / TREE_BUCKET);
    const list = buckets.get(key(ix, iz));
    if (list) list.push(tree);
    else buckets.set(key(ix, iz), [tree]);
  }

  return (x: number, z: number) => {
    const ix = Math.floor(x / TREE_BUCKET);
    const iz = Math.floor(z / TREE_BUCKET);
    let shade = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = buckets.get(key(ix + dx, iz + dz));
        if (!list) continue;
        for (const tree of list) {
          const species = GARDEN_SPECIES[tree.species];
          const trunkClear = species.trunkR * tree.scale + GRASS_TUNING.values.treeClearance;
          const d = Math.hypot(x - tree.x, z - tree.z);
          if (d < trunkClear) return -1;
          shade = Math.max(shade, 1 - smoothstep(trunkClear, trunkClear + 4.5, d));
        }
      }
    }
    return shade;
  };
}

function createBladeClusterGeometry({
  blades,
  segments,
  width,
  radius,
  curvature
}: {
  blades: number;
  segments: number;
  width: number;
  radius: number;
  curvature: number;
}): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  let base = 0;

  for (let blade = 0; blade < blades; blade++) {
    const yaw = (blade / blades) * Math.PI * 2 + (blade % 2) * 0.41;
    const rootA = yaw + 1.37;
    const rootR = radius * (0.15 + 0.85 * ((blade * 4.79) % 1));
    const rootX = Math.cos(rootA) * rootR;
    const rootZ = Math.sin(rootA) * rootR;
    const dirX = Math.cos(yaw);
    const dirZ = Math.sin(yaw);
    const sideX = -dirZ;
    const sideZ = dirX;
    const bend = curvature * (0.7 + 0.45 * ((blade * 2.23) % 1));
    const bladeWidth = width * (0.75 + 0.42 * ((blade * 3.31) % 1));

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const curve = 2 * (1 - t) * t * bend;
      const halfW = bladeWidth * (1 - t * 0.88) * 0.5;
      const cx = rootX + dirX * curve;
      const cz = rootZ + dirZ * curve;
      positions.push(cx - sideX * halfW, t, cz - sideZ * halfW, cx + sideX * halfW, t, cz + sideZ * halfW);
      normals.push(0, 1, 0, 0, 1, 0);
      const rootShade = 0.56 + t * 0.44;
      const tipWarmth = 0.72 + t * 0.28;
      colors.push(rootShade, rootShade, tipWarmth, rootShade, rootShade, tipWarmth);
      uvs.push(0, t, 1, t);
    }

    for (let i = 0; i < segments; i++) {
      const a = base + i * 2;
      const c = base + (i + 1) * 2;
      indices.push(a, a + 1, c, a + 1, c + 1, c);
    }

    const tip = base + (segments + 1) * 2;
    positions.push(rootX, 1.03, rootZ);
    normals.push(0, 1, 0);
    colors.push(1, 1, 0.88);
    uvs.push(0.5, 1);
    const last = base + segments * 2;
    indices.push(last, last + 1, tip);
    base = tip + 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function grassSway(anchorWorldXZ: TslNode) {
  const t = time.mul(windSpeedNode);
  const phase = anchorWorldXZ.x.mul(0.35).add(anchorWorldXZ.y.mul(0.27)).mul(2.2);
  const sine = sin(t.mul(1.15).add(phase)).mul(0.72).add(sin(t.mul(2.63).add(phase.mul(1.9))).mul(0.28));
  const gustScale = 1 / 18;
  const scroll = vec2(WIND_DIR.x, WIND_DIR.z).mul(t.mul(1.4 * gustScale));
  const nUv = anchorWorldXZ.mul(gustScale).sub(scroll);
  const gust = mx_noise_float(nUv).add(mx_noise_float(nUv.mul(3.1).add(vec2(37.7, 17.3))).mul(0.4)).mul(1.25);
  // windGustGlobal is the shared CPU gust envelope that also drives the
  // procedural wind audio — swells you hear are swells you see.
  const gustEnvelope = (windGustGlobal as TslNode).mul(1.3).add(0.3);
  return mix(sine, gust, 0.55).mul(windStrengthNode.mul(0.34)).mul(gustEnvelope);
}

function createGrassMaterial(): THREE.Material {
  const mat = new THREE.MeshSSSNodeMaterial();
  mat.side = THREE.DoubleSide;
  mat.roughness = 0.94;
  mat.metalness = 0;

  const tint = attribute("aGrassColor", "vec4") as TslNode;
  const wind = attribute("aGrassWind", "vec4") as TslNode;
  const bladeT = positionGeometry.y.clamp(0, 1);
  const rootAo = bladeT.mul(0.42).add(0.58);
  const grassRoot = color(0x1f4f1c);
  const grassTip = color(0x8cbd45);
  mat.colorNode = mix(grassRoot, grassTip, bladeT.pow(0.82)).mul(tint.xyz).mul(rootAo);

  const fadeRadius = tint.w.max(1);
  const dist = wind.zw.sub(GRASS_DENSITY_FOCUS).length();
  const fade = fadeRadius.sub(dist).div(fadeRadius.mul(GRASS_FADE_BAND).max(1)).clamp(0, 1);
  const scaled = positionLocal.mul(fade);
  const anchorWorld = modelWorldMatrix.mul(vec4(wind.z, 0, wind.w, 1)).xz;

  // Trample: accumulate world-space push away from each displacer plus a
  // "crush" factor that flattens blades and damps their wind response.
  const info = attribute("aGrassInfo", "vec4") as TslNode; // cosYaw, sinYaw, spread, height
  // Loop/toVar/addAssign need an active TSL stack: at module scope the loop
  // node is orphaned and silently compiles to nothing, so build the trample
  // accumulator inside an immediately-invoked Fn (xy = push, z = crush).
  const trampleAccum = (Fn(() => {
    const push = vec2(0).toVar();
    const crush = float(0).toVar();
    Loop(MAX_DISPLACERS, ({ i }: { i: TslNode }) => {
      const d = (DISPLACERS as TslNode).element(i);
      const delta = anchorWorld.sub(d.xy);
      const len = delta.length().max(1e-4);
      const infl = d.z.sub(len).div(d.z.max(1e-4)).clamp(0, 1);
      const s = infl.mul(infl).mul(d.w);
      push.addAssign(delta.div(len).mul(s));
      crush.addAssign(s);
    });
    return vec3(push, crush);
  }) as TslNode)();
  const push = trampleAccum.xy;
  const crush = trampleAccum.z;
  const crushed = crush.min(1);
  const pushLen = push.length();
  const pushXZ = push.mul(pushLen.min(1).div(pushLen.max(1e-4))).mul(0.85);
  // Instanced pipeline note (vendor wind.js): positionNode offsets get the
  // instance rotation/scale applied AFTER this runs, so map the world offset
  // back into the instance frame — R(-yaw) and divide by the XZ/Y scales.
  const trampleT: TslNode = bladeT.pow(1.35).mul(fade);
  const worldX: TslNode = pushXZ.x.mul(trampleT);
  const worldZ: TslNode = pushXZ.y.mul(trampleT);
  const trampleLocalX: TslNode = info.x.mul(worldX).sub(info.y.mul(worldZ)).div(info.z.max(1e-4));
  const trampleLocalY: TslNode = (crushed as TslNode).mul(-0.42).mul(trampleT).div(info.w.max(1e-4));
  const trampleLocalZ: TslNode = info.y.mul(worldX).add(info.x.mul(worldZ)).div(info.z.max(1e-4));
  // Hard cap: no attribute/uniform garbage may ever fling a blade off-world.
  const localTrample = vec3(trampleLocalX, trampleLocalY, trampleLocalZ).clamp(-4, 4);

  const windDamp = float(1).sub(crushed.mul(0.75));
  const bend = vec3(wind.x, 0, wind.y).mul(grassSway(anchorWorld)).mul(bladeT.pow(2.05).mul(fade)).mul(windDamp);
  mat.positionNode = scaled.add(bend).add(localTrample);

  mat.normalNode = normalize(cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz);
  mat.thicknessColorNode = tint.y.mul(bladeT.mul(0.72).add(0.28)).mul(uniform(new THREE.Color(0.42, 0.68, 0.24)));
  mat.thicknessDistortionNode = uniform(0.38);
  mat.thicknessAmbientNode = uniform(0.08);
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(5.0);
  mat.thicknessScaleNode = uniform(2.35);
  return mat;
}

function sampleGrassEntries(map: GardenTerrain, trees: GardenTree[], options: GrassSampleOptions) {
  const values = GRASS_TUNING.values;
  const treeInfluenceAt = createTreeInfluence(trees);
  const low: GrassEntry[] = [];
  const tall: GrassEntry[] = [];
  const b = BOTANICAL_GARDEN_BOUNDS;
  const dummyColor = new THREE.Color();
  const spacing = Math.max(0.1, options.spacing);
  const salt = options.salt ?? 0;
  const densityScale = options.densityScale ?? 1;
  const minX = Math.max(b.minX, options.bounds?.minX ?? b.minX);
  const maxX = Math.min(b.maxX, options.bounds?.maxX ?? b.maxX);
  const minZ = Math.max(b.minZ, options.bounds?.minZ ?? b.minZ);
  const maxZ = Math.min(b.maxZ, options.bounds?.maxZ ?? b.maxZ);
  const gx0 = Math.floor((minX - b.minX) / spacing);
  const gx1 = Math.ceil((maxX - b.minX) / spacing);
  const gz0 = Math.floor((minZ - b.minZ) / spacing);
  const gz1 = Math.ceil((maxZ - b.minZ) / spacing);

  if (minX > maxX || minZ > maxZ) return { low, tall };

  for (let gx = gx0; gx <= gx1; gx++) {
    const x = b.minX + gx * spacing;
    for (let gz = gz0; gz <= gz1; gz++) {
      const z = b.minZ + gz * spacing;
      const px = x + (hash(gx, gz, 11 + salt) - 0.5) * spacing * 0.85;
      const pz = z + (hash(gx, gz, 17 + salt) - 0.5) * spacing * 0.85;
      if (!inBotanicalGarden(px, pz) || map.surfaceType(px, pz) !== 1 || map.isWater(px, pz)) continue;

      let focusWeight = 1;
      if (options.focus) {
        const d = Math.hypot(px - options.focus.x, pz - options.focus.z);
        if (d > options.focus.radius) continue;
        focusWeight = 1 - smoothstep(options.focus.radius * 0.58, options.focus.radius, d);
        if (focusWeight <= 0.02) continue;
      }

      const pathDistance = gardenPathSignedDistance(px, pz);
      if (pathDistance < values.pathMargin) continue;

      const treeShade = treeInfluenceAt(px, pz);
      if (treeShade < 0) continue;

      const patch = valueNoise(px, pz, 31, 701);
      const meadow = meadowEllipse(px, pz);
      const inMeadow = meadow < 1.04;
      let keep = inMeadow ? values.meadowKeep : values.collectionKeep;
      keep *= 0.72 + 0.48 * smoothstep(0.22, 0.8, patch);
      if (pathDistance < values.pathMargin + values.pathFeather) keep *= values.pathEdgeKeep;
      if (treeShade > 0) keep *= 0.9;
      keep *= densityScale * focusWeight;
      if (hash(gx, gz, 23 + salt) > Math.min(1, keep)) continue;

      const lowNoise = valueNoise(px, pz, 17, 907);
      const foot = 0.45 + lowNoise * 0.45;
      const h0 = groundAt(map, px, pz);
      const h1 = groundAt(map, px - foot, pz);
      const h2 = groundAt(map, px + foot, pz);
      const h3 = groundAt(map, px, pz - foot);
      const h4 = groundAt(map, px, pz + foot);
      const hMin = Math.min(h0, h1, h2, h3, h4);
      // NaN from a bad surface sample must never bake into a matrix — NaN
      // survives min/max and the slope test below (NaN > x is false).
      if (!Number.isFinite(hMin)) continue;
      if (Math.max(h0, h1, h2, h3, h4) - hMin > values.slopeCull) continue;

      const nearPath = 1 - smoothstep(values.pathMargin, values.pathMargin + values.pathFeather, pathDistance);
      const dry = Math.min(1, nearPath * 0.42 + (1 - patch) * 0.18);
      const brightness = values.brightness * (0.86 + hash(gx, gz, 29 + salt) * 0.26);
      dummyColor.setRGB(
        brightness * (0.62 + dry * 0.25) * (1 - values.greenBias * 0.2),
        brightness * (0.9 - dry * 0.15),
        brightness * (0.42 - dry * 0.08) * (1 - values.greenBias * 0.45)
      );

      const isTall = !inMeadow && hash(gx, gz, 31 + salt) < values.tallShare * (0.75 + treeShade * 0.5);
      const heightBase = isTall ? 0.9 + hash(gx, gz, 37 + salt) * 0.7 : 0.44 + hash(gx, gz, 41 + salt) * 0.38;
      const height = heightBase * values.heightScale * (treeShade > 0 ? 0.82 : 1);
      const spread = (isTall ? 1.05 : 0.82) * (0.82 + hash(gx, gz, 43 + salt) * 0.36);
      const yaw = hash(gx, gz, 47 + salt) * Math.PI * 2;
      const cosY = Math.cos(yaw);
      const sinY = Math.sin(yaw);
      const windAmp = (0.74 + height * 0.34) * (isTall ? 1.08 : 1);
      const entry = {
        x: px,
        y: hMin - values.groundSink,
        z: pz,
        yaw,
        height,
        spread,
        color: dummyColor.clone(),
        windX: ((cosY * WIND_DIR.x - sinY * WIND_DIR.z) / spread) * windAmp,
        windZ: ((sinY * WIND_DIR.x + cosY * WIND_DIR.z) / spread) * windAmp
      };
      if (isTall) tall.push(entry);
      else low.push(entry);
    }
  }

  return { low, tall };
}

function createGrassMesh(
  name: string,
  capacity: number,
  geometry: THREE.BufferGeometry,
  material: THREE.Material
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry.clone(), material, capacity);
  mesh.name = name;
  mesh.castShadow = Boolean(GRASS_TUNING.values.castShadows);
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;

  // StaticDrawUsage on purpose: r185 re-uploads DynamicDrawUsage buffers every
  // frame regardless of version; static + needsUpdate uploads only on rewrite.
  const matrixAttr = new THREE.StorageInstancedBufferAttribute(capacity, 16);
  matrixAttr.setUsage(THREE.StaticDrawUsage);
  mesh.instanceMatrix = matrixAttr;
  const colorAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  colorAttr.setUsage(THREE.StaticDrawUsage);
  const windAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  windAttr.setUsage(THREE.StaticDrawUsage);
  const infoAttr = new THREE.StorageInstancedBufferAttribute(capacity, 4);
  infoAttr.setUsage(THREE.StaticDrawUsage);
  mesh.geometry.setAttribute("aGrassColor", colorAttr);
  mesh.geometry.setAttribute("aGrassWind", windAttr);
  mesh.geometry.setAttribute("aGrassInfo", infoAttr);
  mesh.count = 0;
  return mesh;
}

const grassWriteDummy = new THREE.Object3D();

function writeGrassMesh(mesh: THREE.InstancedMesh, entries: GrassEntry[], fadeRadius: number) {
  const matrices = mesh.instanceMatrix.array as Float32Array;
  const colorAttr = mesh.geometry.getAttribute("aGrassColor") as THREE.StorageInstancedBufferAttribute;
  const windAttr = mesh.geometry.getAttribute("aGrassWind") as THREE.StorageInstancedBufferAttribute;
  const infoAttr = mesh.geometry.getAttribute("aGrassInfo") as THREE.StorageInstancedBufferAttribute;
  const colors = colorAttr.array as Float32Array;
  const winds = windAttr.array as Float32Array;
  const infos = infoAttr.array as Float32Array;
  const dummy = grassWriteDummy;
  entries.forEach((entry, i) => {
    dummy.position.set(entry.x, entry.y, entry.z);
    dummy.rotation.set(0, entry.yaw, 0);
    dummy.scale.set(entry.spread, entry.height, entry.spread);
    dummy.updateMatrix();
    dummy.matrix.toArray(matrices, i * 16);
    const ci = i * 4;
    colors[ci] = entry.color.r;
    colors[ci + 1] = entry.color.g;
    colors[ci + 2] = entry.color.b;
    colors[ci + 3] = fadeRadius;
    winds[ci] = entry.windX;
    winds[ci + 1] = entry.windZ;
    winds[ci + 2] = entry.x;
    winds[ci + 3] = entry.z;
    infos[ci] = Math.cos(entry.yaw);
    infos[ci + 1] = Math.sin(entry.yaw);
    infos[ci + 2] = entry.spread;
    infos[ci + 3] = entry.height;
  });
  // Zero any slots the previous (larger) write left behind. The draw call is
  // capped at mesh.count, but a zero matrix keeps stale slots degenerate even
  // if some pass ever samples past the count — ghost tufts hovering at the
  // heights of an area you already left are exactly how that bug looks.
  const lastCount = (mesh.userData.grassLastCount as number) ?? 0;
  if (lastCount > entries.length) {
    matrices.fill(0, entries.length * 16, lastCount * 16);
    colors.fill(0, entries.length * 4, lastCount * 4);
    winds.fill(0, entries.length * 4, lastCount * 4);
    infos.fill(0, entries.length * 4, lastCount * 4);
  }
  mesh.userData.grassLastCount = entries.length;
  mesh.count = entries.length;
  mesh.instanceMatrix.needsUpdate = true;
  colorAttr.needsUpdate = true;
  windAttr.needsUpdate = true;
  infoAttr.needsUpdate = true;
}

export class BotanicalGrassController extends THREE.Group {
  readonly stats: BotanicalGrassStats = { baseLow: 0, baseTall: 0, detailLow: 0, detailTall: 0 };

  #map: GardenTerrain;
  #trees: GardenTree[];
  #material = createGrassMaterial();
  // Far field keeps the lean 4/5-blade clusters (it's mostly sub-pixel);
  // the near-detail ring gets the rich 6/8-blade clusters.
  #lowGeometryFar = createBladeClusterGeometry({ blades: 4, segments: 3, width: 0.085, radius: 0.34, curvature: 0.22 });
  #tallGeometryFar = createBladeClusterGeometry({ blades: 5, segments: 4, width: 0.095, radius: 0.45, curvature: 0.36 });
  #lowGeometryNear = createBladeClusterGeometry({ blades: 6, segments: 3, width: 0.085, radius: 0.37, curvature: 0.24 });
  #tallGeometryNear = createBladeClusterGeometry({ blades: 8, segments: 4, width: 0.095, radius: 0.48, curvature: 0.4 });
  #baseGroup = new THREE.Group();
  #detailGroup = new THREE.Group();
  #baseChunks: { mesh: THREE.InstancedMesh; cx: number; cz: number }[] = [];
  #detailLow: THREE.InstancedMesh | null = null;
  #detailTall: THREE.InstancedMesh | null = null;
  #focus: GrassFocus | null = null;
  #lastDetailFocus: GrassFocus | null = null;

  constructor(map: GardenTerrain, trees: GardenTree[]) {
    super();
    this.name = "sfbg_procedural_grass";
    this.#map = map;
    this.#trees = trees;
    this.#baseGroup.name = "sfbg_procedural_grass_base";
    this.#detailGroup.name = "sfbg_procedural_grass_near_detail";
    this.add(this.#baseGroup, this.#detailGroup);
    this.rebuild();
  }

  rebuild() {
    this.#clearGroup(this.#baseGroup);
    this.#baseChunks.length = 0;
    const values = GRASS_TUNING.values;
    const base = sampleGrassEntries(this.#map, this.#trees, { spacing: values.spacing });
    const baseFade = Math.max(80, Number(values.baseViewDistance));
    if (values.showLow) this.#buildBaseChunks("low", base.low, this.#lowGeometryFar, baseFade);
    if (values.showTall) this.#buildBaseChunks("tall", base.tall, this.#tallGeometryFar, baseFade);
    this.stats.baseLow = values.showLow ? base.low.length : 0;
    this.stats.baseTall = values.showTall ? base.tall.length : 0;
    // Drop the detail pool so castShadow/geometry changes are picked up.
    this.#clearGroup(this.#detailGroup);
    this.#detailLow = null;
    this.#detailTall = null;
    this.#lastDetailFocus = null;
    if (this.#focus) this.updateFocus(this.#focus, true);
    else {
      this.stats.detailLow = 0;
      this.stats.detailTall = 0;
      this.#syncStats();
    }
  }

  updateFocus(focus: GrassFocus, force = false) {
    const values = GRASS_TUNING.values;
    this.#focus = { x: focus.x, z: focus.z };
    GRASS_DENSITY_FOCUS.value.set(focus.x, focus.z);

    // Distance-cull whole base chunks (the shader fade collapses blades near
    // the view distance anyway, so hidden chunks were already invisible).
    const chunkCutoff = Math.max(80, Number(values.baseViewDistance)) + 34;
    for (const chunk of this.#baseChunks) {
      chunk.mesh.visible = Math.hypot(chunk.cx - focus.x, chunk.cz - focus.z) < chunkCutoff;
    }
    if (values.nearRadius <= 0 || values.nearDensity <= 0 || !inBotanicalGarden(focus.x, focus.z, values.nearRadius)) {
      if (this.stats.detailLow || this.stats.detailTall) {
        if (this.#detailLow) this.#detailLow.count = 0;
        if (this.#detailTall) this.#detailTall.count = 0;
        this.stats.detailLow = 0;
        this.stats.detailTall = 0;
        this.#syncStats();
      }
      this.#lastDetailFocus = null;
      return;
    }

    if (!force && this.#lastDetailFocus) {
      const moved = Math.hypot(focus.x - this.#lastDetailFocus.x, focus.z - this.#lastDetailFocus.z);
      if (moved < values.nearRebuildStep) return;
    }

    const r = values.nearRadius;
    const detail = sampleGrassEntries(this.#map, this.#trees, {
      spacing: values.nearSpacing,
      bounds: { minX: focus.x - r, maxX: focus.x + r, minZ: focus.z - r, maxZ: focus.z + r },
      salt: DETAIL_SALT,
      densityScale: values.nearDensity,
      focus: { x: focus.x, z: focus.z, radius: r }
    });
    const fadeRadius = Math.max(1, r);
    this.#detailLow = this.#writeDetailTier(
      this.#detailLow,
      "sfbg_near_low_grass_clumps",
      this.#lowGeometryNear,
      values.showLow ? detail.low : [],
      fadeRadius
    );
    this.#detailTall = this.#writeDetailTier(
      this.#detailTall,
      "sfbg_near_tall_grass_clumps",
      this.#tallGeometryNear,
      values.showTall ? detail.tall : [],
      fadeRadius
    );
    this.stats.detailLow = values.showLow ? detail.low.length : 0;
    this.stats.detailTall = values.showTall ? detail.tall.length : 0;
    this.#lastDetailFocus = { x: focus.x, z: focus.z };
    this.#syncStats();
  }

  // Base grass is split into ~48 m tiles so the regular frustum culling can
  // drop everything behind the camera, and updateFocus distance-culls tiles
  // past the base view distance. One InstancedMesh per tile.
  #buildBaseChunks(tier: string, entries: GrassEntry[], geometry: THREE.BufferGeometry, fadeRadius: number) {
    const CHUNK = 48;
    const chunks = new Map<string, GrassEntry[]>();
    for (const entry of entries) {
      const key = `${Math.floor(entry.x / CHUNK)},${Math.floor(entry.z / CHUNK)}`;
      const list = chunks.get(key);
      if (list) list.push(entry);
      else chunks.set(key, [entry]);
    }
    for (const [key, list] of chunks) {
      const mesh = createGrassMesh(`sfbg_base_${tier}_grass_${key}`, list.length, geometry, this.#material);
      writeGrassMesh(mesh, list, fadeRadius);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const e of list) {
        if (e.x < minX) minX = e.x;
        if (e.x > maxX) maxX = e.x;
        if (e.y < minY) minY = e.y;
        if (e.y > maxY) maxY = e.y;
        if (e.z < minZ) minZ = e.z;
        if (e.z > maxZ) maxZ = e.z;
      }
      const cx = (minX + maxX) / 2;
      const cy = (minY + maxY) / 2;
      const cz = (minZ + maxZ) / 2;
      const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 3;
      mesh.geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(cx, cy, cz), radius);
      mesh.frustumCulled = true;
      this.#baseGroup.add(mesh);
      this.#baseChunks.push({ mesh, cx, cz });
    }
  }

  // Pooled detail meshes: rewrite instance buffers in place while walking and
  // only reallocate when the sample outgrows capacity — no per-step mesh
  // creation, no pipeline churn.
  #writeDetailTier(
    mesh: THREE.InstancedMesh | null,
    name: string,
    geometry: THREE.BufferGeometry,
    entries: GrassEntry[],
    fadeRadius: number
  ): THREE.InstancedMesh | null {
    if (entries.length === 0) {
      if (mesh) mesh.count = 0;
      return mesh;
    }
    const capacity = mesh ? (mesh.instanceMatrix.array as Float32Array).length / 16 : 0;
    if (!mesh || capacity < entries.length) {
      if (mesh) {
        this.#detailGroup.remove(mesh);
        mesh.geometry.dispose();
      }
      mesh = createGrassMesh(name, Math.ceil(entries.length * 1.3) + 64, geometry, this.#material);
      this.#detailGroup.add(mesh);
    }
    writeGrassMesh(mesh, entries, fadeRadius);
    return mesh;
  }

  #clearGroup(group: THREE.Group) {
    while (group.children.length) {
      const child = group.children[group.children.length - 1];
      group.remove(child);
      if (child instanceof THREE.Mesh) child.geometry.dispose();
    }
  }

  #syncStats() {
    this.userData.grassStats = { ...this.stats };
  }
}

export function buildBotanicalGrass(map: GardenTerrain, trees: GardenTree[]): BotanicalGrassController {
  return new BotanicalGrassController(map, trees);
}
