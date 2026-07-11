import * as THREE from "three/webgpu";
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
import { MAX_DISPLACERS, setGroundDisplacers, type GroundDisplacer } from "../groundcover/displacers";
// The blade geometry + SSS material + instance-write all come from the shared
// ground-cover grass primitive now — the garden keeps only its own SAMPLING
// (footprint base layer + near-detail ring, tree clearance, paths, meadow).
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  writeGrassMesh,
  GRASS_DENSITY_FOCUS,
  WIND_DIR,
  type GrassEntry
} from "../groundcover/bladeGrass";
import { GRASS_TUNING } from "./grassTuning";

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
// Player/creature trample now lives in the SHARED ground-cover displacer field
// (../groundcover/displacers) so the wildlands grass + wildflowers bend to the
// same points. Re-exported here under the historical names so garden/index and
// main keep importing them from the grass module.
export const MAX_GRASS_DISPLACERS = MAX_DISPLACERS;
export type GrassDisplacer = GroundDisplacer;
export const setGrassDisplacers = setGroundDisplacers;

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
        // Radial density taper (code, not a knob): the detail ring's job is
        // eye-level density right around the player — full density to ~25% of
        // the radius, easing to ~24% by ~78% where foreshortening + the base
        // layer carry the read. Cuts the ring's instance count ~2.7× with no
        // visible thinning at the feet.
        focusWeight *= 1 - 0.76 * smoothstep(options.focus.radius * 0.25, options.focus.radius * 0.78, d);
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


export class BotanicalGrassController extends THREE.Group {
  readonly stats: BotanicalGrassStats = { baseLow: 0, baseTall: 0, detailLow: 0, detailTall: 0 };

  #map: GardenTerrain;
  #trees: GardenTree[];
  #material = createGrassMaterial();
  // Both tiers use the lean 4/5-blade clusters — the old 5/6 near ring spent
  // ~25% more vertex work on overlapping silhouettes that read identically at
  // eye level, and meadow probes were triangle-bound (~4M garden tris).
  #lowGeometryFar = createBladeClusterGeometry({ blades: 4, segments: 3, width: 0.085, radius: 0.34, curvature: 0.22 });
  #tallGeometryFar = createBladeClusterGeometry({ blades: 5, segments: 4, width: 0.095, radius: 0.45, curvature: 0.36 });
  #lowGeometryNear = createBladeClusterGeometry({ blades: 4, segments: 3, width: 0.09, radius: 0.37, curvature: 0.24 });
  #tallGeometryNear = createBladeClusterGeometry({ blades: 5, segments: 4, width: 0.105, radius: 0.48, curvature: 0.4 });
  // Hard live-instance caps (~1.2M tris at ~28 tris/cluster). Density knobs can
  // request more; updateFocus scales draw ranges down so GG Park never blows the
  // frame budget even if a slider is cranked.
  static readonly #MAX_LIVE_BASE = 28_000;
  static readonly #MAX_LIVE_DETAIL = 12_000;
  #baseGroup = new THREE.Group();
  #detailGroup = new THREE.Group();
  #baseChunks: { mesh: THREE.InstancedMesh; cx: number; cz: number; full: number }[] = [];
  #detailLow: THREE.InstancedMesh | null = null;
  #detailTall: THREE.InstancedMesh | null = null;
  #focus: GrassFocus | null = null;
  #lastDetailFocus: GrassFocus | null = null;
  // focus speed estimate (m/s) — at vehicle/flight speed the near-detail ring is
  // unresolvable AND its full-ring resample every nearRebuildStep was a measured
  // 100-180 ms hitch crossing GG Park; fast movers skip it (base grass persists)
  #lastFocusAt = 0;
  #lastFocusX = 0;
  #lastFocusZ = 0;
  #focusSpeed = 0;

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
    // Drop the detail pool so geometry changes are picked up.
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

  /** Zero every draw range and hide base chunks. Called when the whole garden is
   *  distance-gated out so a stale mesh.visible / count can't leak tris into
   *  Corona Heights / downtown frames. */
  park() {
    for (const chunk of this.#baseChunks) {
      chunk.mesh.visible = false;
      chunk.mesh.count = 0;
    }
    if (this.#detailLow) this.#detailLow.count = 0;
    if (this.#detailTall) this.#detailTall.count = 0;
    this.stats.detailLow = 0;
    this.stats.detailTall = 0;
    this.#lastDetailFocus = null;
    this.#syncStats();
  }

  updateFocus(focus: GrassFocus, force = false) {
    const values = GRASS_TUNING.values;
    this.#focus = { x: focus.x, z: focus.z };
    GRASS_DENSITY_FOCUS.value.set(focus.x, focus.z);

    // smoothed focus speed (m/s) from successive calls; long gaps reset
    {
      const now = performance.now();
      const dtms = now - this.#lastFocusAt;
      if (dtms > 0 && dtms < 500) {
        const v = (Math.hypot(focus.x - this.#lastFocusX, focus.z - this.#lastFocusZ) / dtms) * 1000;
        this.#focusSpeed += 0.25 * (v - this.#focusSpeed);
      } else {
        this.#focusSpeed = 0;
      }
      this.#lastFocusAt = now;
      this.#lastFocusX = focus.x;
      this.#lastFocusZ = focus.z;
    }

    // Distance-cull whole base chunks (the shader fade collapses blades near
    // the view distance anyway, so hidden chunks were already invisible).
    // Visible chunks additionally GRADE their instance count by distance:
    // each chunk's entries were hash-shuffled at build, so drawing a count
    // prefix is a spatially uniform thinning — full density near the player,
    // sparse past ~120 m where clumps are a few pixels tall. mesh.count is a
    // free draw-range knob (no buffer uploads).
    const chunkCutoff = Math.max(80, Number(values.baseViewDistance)) + 24;
    let liveBase = 0;
    for (const chunk of this.#baseChunks) {
      const d = Math.hypot(chunk.cx - focus.x, chunk.cz - focus.z);
      chunk.mesh.visible = d < chunkCutoff;
      if (chunk.mesh.visible) {
        // near: under the detail ring the base is outnumbered — thin it
        // far: past ~120 m clumps are a few pixels tall — keep ~25%
        const nearUnderlap = 1 - 0.4 * (1 - smoothstep(24, 48, d));
        const farThin = 1 - 0.75 * smoothstep(80, 130, d);
        const n = Math.max(1, Math.round(chunk.full * nearUnderlap * farThin));
        chunk.mesh.count = n;
        liveBase += n;
      } else {
        chunk.mesh.count = 0;
      }
    }
    // Hard budget: scale every visible chunk's count down if the park still
    // overshoots (density knobs / large meadow).
    if (liveBase > BotanicalGrassController.#MAX_LIVE_BASE) {
      const scale = BotanicalGrassController.#MAX_LIVE_BASE / liveBase;
      for (const chunk of this.#baseChunks) {
        if (!chunk.mesh.visible) continue;
        chunk.mesh.count = Math.max(1, Math.round(chunk.mesh.count * scale));
      }
    }
    // fast movers (car boost / plane / bird) skip the near-detail ring exactly
    // like being outside the garden: clumps are unresolvable at that speed and
    // the resample was the hitch. Rebuilds once you slow back under ~18 m/s.
    const tooFast = this.#focusSpeed > 18 && !force;
    if (tooFast || values.nearRadius <= 0 || values.nearDensity <= 0 || !inBotanicalGarden(focus.x, focus.z, values.nearRadius)) {
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
    // Cap detail samples before upload so a density crank can't explode the ring.
    const maxDetail = BotanicalGrassController.#MAX_LIVE_DETAIL;
    let lowEntries = values.showLow ? detail.low : [];
    let tallEntries = values.showTall ? detail.tall : [];
    const detailTotal = lowEntries.length + tallEntries.length;
    if (detailTotal > maxDetail) {
      const keep = maxDetail / detailTotal;
      lowEntries = lowEntries.slice(0, Math.max(0, Math.round(lowEntries.length * keep)));
      tallEntries = tallEntries.slice(0, Math.max(0, Math.round(tallEntries.length * keep)));
    }
    const fadeRadius = Math.max(1, r);
    this.#detailLow = this.#writeDetailTier(
      this.#detailLow,
      "sfbg_near_low_grass_clumps",
      this.#lowGeometryNear,
      lowEntries,
      fadeRadius
    );
    this.#detailTall = this.#writeDetailTier(
      this.#detailTall,
      "sfbg_near_tall_grass_clumps",
      this.#tallGeometryNear,
      tallEntries,
      fadeRadius
    );
    this.stats.detailLow = lowEntries.length;
    this.stats.detailTall = tallEntries.length;
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
      // Hash-shuffle so any count-prefix of the instance buffer is a spatially
      // uniform subset of the chunk — updateFocus thins far chunks by count.
      list.sort((a, b) => {
        const ha = Math.abs(Math.sin(a.x * 12.9898 + a.z * 78.233) * 43758.5453) % 1;
        const hb = Math.abs(Math.sin(b.x * 12.9898 + b.z * 78.233) * 43758.5453) % 1;
        return ha - hb;
      });
      const mesh = createGrassMesh(
        `sfbg_base_${tier}_grass_${key}`,
        list.length,
        geometry,
        this.#material,
        false
      );
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
      this.#baseChunks.push({ mesh, cx, cz, full: list.length });
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
      mesh = createGrassMesh(
        name,
        Math.ceil(entries.length * 1.3) + 64,
        geometry,
        this.#material,
        false
      );
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
