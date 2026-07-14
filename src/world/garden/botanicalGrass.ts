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
import { inJapaneseTeaGarden } from "../japaneseTeaGarden/layout";
// The blade geometry + SSS material + instance-write all come from the shared
// ground-cover grass primitive now — the garden keeps only its own SAMPLING
// (footprint base layer + near-detail ring, tree clearance, paths, meadow).
import {
  createBladeClusterGeometry,
  createGrassMaterial,
  createGrassMesh,
  grassMeshCount,
  setGrassMeshBounds,
  setGrassMeshCount,
  writeGrassMesh,
  type GrassEntry,
  type GrassMaterialState,
  type GrassMesh
} from "../groundcover/bladeGrass";
import { fitGroundY } from "../groundcover/grounding";
import { BOTANICAL_GRASS_TUNING } from "./grassTuning";

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
  treeInfluenceAt?: (x: number, z: number) => number;
};

type DetailLod = "near" | "mid" | "far";

type DetailTile = {
  tx: number;
  tz: number;
  low: GrassEntry[];
  tall: GrassEntry[];
  lod: DetailLod;
  mesh: GrassMesh | null;
  targetLow: number;
  targetTall: number;
  targetLive: number;
  liveLow: number;
  liveTall: number;
  live: number;
};

const TREE_BUCKET = 18;
const DETAIL_SALT = 1307;
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
          const trunkClear = species.trunkR * tree.scale + BOTANICAL_GRASS_TUNING.values.treeClearance;
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
  const values = BOTANICAL_GRASS_TUNING.values;
  // Detail streaming samples one tile at a time. Reuse the controller's tree
  // index instead of rebuilding and string-allocating the whole bucket map for
  // every entering tile.
  const treeInfluenceAt = options.treeInfluenceAt ?? createTreeInfluence(trees);
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
  const sampleGround = (x: number, z: number) => gardenSurfaceHeight(map, x, z);

  if (minX > maxX || minZ > maxZ) return { low, tall };

  for (let gx = gx0; gx <= gx1; gx++) {
    const x = b.minX + gx * spacing;
    for (let gz = gz0; gz <= gz1; gz++) {
      const z = b.minZ + gz * spacing;
      const px = x + (hash(gx, gz, 11 + salt) - 0.5) * spacing * 0.85;
      const pz = z + (hash(gx, gz, 17 + salt) - 0.5) * spacing * 0.85;
      // Stable half-open ownership keeps jittered samples from appearing in
      // both neighbouring streamed tiles.
      if (options.bounds && (px < minX || px >= maxX || pz < minZ || pz >= maxZ)) continue;
      if (
        !inBotanicalGarden(px, pz) ||
        inJapaneseTeaGarden(px, pz, 4) ||
        map.surfaceType(px, pz) !== 1 ||
        map.isWater(px, pz)
      ) continue;

      const pathDistance = gardenPathSignedDistance(px, pz);
      if (pathDistance < values.pathMargin) continue;

      const treeShade = treeInfluenceAt(px, pz);
      if (treeShade < 0) continue;

      const patch = valueNoise(px, pz, 31, 701);
      const meadow = meadowEllipse(px, pz);
      const inMeadow = meadow < 1.04;
      let keep = inMeadow ? values.meadowKeep : values.collectionKeep;
      // Coverage is spatially even. Noise changes colour, height and tall share
      // below instead of deleting broad low-noise patches from the lawn.
      if (pathDistance < values.pathMargin + values.pathFeather) keep *= values.pathEdgeKeep;
      if (treeShade > 0) keep *= 0.95;
      keep *= densityScale;
      if (hash(gx, gz, 23 + salt) > Math.min(1, keep)) continue;

      const lowNoise = valueNoise(px, pz, 17, 907);
      const foot = 0.45 + lowNoise * 0.45;
      const y = fitGroundY(sampleGround, px, pz, foot, values.slopeCull, -values.groundSink);
      if (y === null) continue;

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
      const vigour = 0.88 + patch * 0.24;
      const height = heightBase * vigour * values.heightScale * (treeShade > 0 ? 0.82 : 1);
      const spread = (isTall ? 1.05 : 0.84) * (0.84 + hash(gx, gz, 43 + salt) * 0.34) * (0.96 + vigour * 0.04);
      const yaw = hash(gx, gz, 47 + salt) * Math.PI * 2;
      const windAmp = (0.74 + height * 0.34) * (isTall ? 1.08 : 1);
      const entry = {
        x: px,
        y,
        z: pz,
        yaw,
        height,
        spread,
        color: dummyColor.clone(),
        windAmp
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
  #treeInfluenceAt: (x: number, z: number) => number;
  // The static base is deliberately cheap: wide 1/2-segment clusters provide a
  // continuous distant carpet with one-sine wind and no 12-slot interaction
  // loop. Detail tiles graduate to full geometry + all displacers at the feet.
  #baseMaterialState = createGrassMaterial({ wind: "lite", interactionSlots: 0 });
  #detailMaterials: Record<DetailLod, GrassMaterialState> = {
    near: createGrassMaterial({ wind: "full", interactionSlots: 12 }),
    mid: createGrassMaterial({ wind: "lite", interactionSlots: 4 }),
    far: createGrassMaterial({ wind: "lite", interactionSlots: 0 })
  };
  #lowGeometryFar = createBladeClusterGeometry({ blades: 3, segments: 1, width: 0.14, radius: 0.53, curvature: 0.2 });
  #tallGeometryFar = createBladeClusterGeometry({ blades: 3, segments: 2, width: 0.14, radius: 0.58, curvature: 0.3 });
  #detailGeometry: Record<DetailLod, THREE.BufferGeometry> = {
    near: createBladeClusterGeometry({ blades: 5, segments: 3, width: 0.088, radius: 0.38, curvature: 0.27 }),
    mid: createBladeClusterGeometry({ blades: 4, segments: 2, width: 0.115, radius: 0.46, curvature: 0.25 }),
    far: createBladeClusterGeometry({ blades: 3, segments: 1, width: 0.16, radius: 0.6, curvature: 0.2 })
  };
  static readonly #MAX_LIVE_BASE = 36_000;
  static readonly #MAX_LIVE_DETAIL = 16_000;
  #baseGroup = new THREE.Group();
  #detailGroup = new THREE.Group();
  #baseChunks: { mesh: GrassMesh; cx: number; cz: number; full: number }[] = [];
  #detailTiles = new Map<string, DetailTile>();
  #focus: GrassFocus | null = null;
  #detailSyncX = Number.NaN;
  #detailSyncZ = Number.NaN;
  // focus speed estimate (m/s) — at vehicle/flight speed the near-detail ring is
  // unresolvable AND its full-ring resample every nearRebuildStep was a measured
  // 100-180 ms hitch crossing GG Park; fast movers skip it (base grass persists)
  #lastFocusAt = 0;
  #lastFocusX = 0;
  #lastFocusZ = 0;
  #focusSpeed = 0;
  #disposed = false;

  constructor(map: GardenTerrain, trees: GardenTree[]) {
    super();
    this.name = "sfbg_procedural_grass";
    this.#map = map;
    this.#trees = trees;
    this.#treeInfluenceAt = createTreeInfluence(trees);
    this.#baseGroup.name = "sfbg_procedural_grass_base";
    this.#detailGroup.name = "sfbg_procedural_grass_near_detail";
    this.add(this.#baseGroup, this.#detailGroup);
    this.rebuild();
  }

  rebuild() {
    this.#clearGroup(this.#baseGroup);
    this.#baseChunks.length = 0;
    const values = BOTANICAL_GRASS_TUNING.values;
    const base = sampleGrassEntries(this.#map, this.#trees, {
      spacing: values.spacing,
      treeInfluenceAt: this.#treeInfluenceAt
    });
    const baseFade = Math.max(80, Number(values.baseViewDistance));
    if (values.showLow) this.#buildBaseChunks("low", base.low, this.#lowGeometryFar, baseFade);
    if (values.showTall) this.#buildBaseChunks("tall", base.tall, this.#tallGeometryFar, baseFade);
    this.stats.baseLow = values.showLow ? base.low.length : 0;
    this.stats.baseTall = values.showTall ? base.tall.length : 0;
    // Drop streamed detail tiles so spacing/geometry tuning is regenerated from
    // deterministic world cells on the next focus update.
    this.#clearDetailTiles();
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
      setGrassMeshCount(chunk.mesh, 0);
    }
    this.#clearDetailTiles();
    this.stats.detailLow = 0;
    this.stats.detailTall = 0;
    this.#syncStats();
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearDetailTiles();
    this.#clearGroup(this.#baseGroup);
    this.#lowGeometryFar.dispose();
    this.#tallGeometryFar.dispose();
    this.#detailGeometry.near.dispose();
    this.#detailGeometry.mid.dispose();
    this.#detailGeometry.far.dispose();
    this.#baseMaterialState.material.dispose();
    this.#detailMaterials.near.material.dispose();
    this.#detailMaterials.mid.material.dispose();
    this.#detailMaterials.far.material.dispose();
    this.removeFromParent();
    this.clear();
  }

  updateFocus(focus: GrassFocus, force = false) {
    const values = BOTANICAL_GRASS_TUNING.values;
    if (this.#focus) {
      this.#focus.x = focus.x;
      this.#focus.z = focus.z;
    } else {
      this.#focus = { x: focus.x, z: focus.z };
    }
    this.#baseMaterialState.focus.set(focus.x, focus.z);
    this.#detailMaterials.near.focus.set(focus.x, focus.z);
    this.#detailMaterials.mid.focus.set(focus.x, focus.z);
    this.#detailMaterials.far.focus.set(focus.x, focus.z);

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
        setGrassMeshCount(chunk.mesh, n);
        liveBase += n;
      } else {
        setGrassMeshCount(chunk.mesh, 0);
      }
    }
    // Hard budget: scale every visible chunk's count down if the park still
    // overshoots (density knobs / large meadow).
    if (liveBase > BotanicalGrassController.#MAX_LIVE_BASE) {
      const scale = BotanicalGrassController.#MAX_LIVE_BASE / liveBase;
      for (const chunk of this.#baseChunks) {
        if (!chunk.mesh.visible) continue;
        setGrassMeshCount(chunk.mesh, Math.max(1, Math.round(grassMeshCount(chunk.mesh) * scale)));
      }
    }
    // fast movers (car boost / plane / bird) skip the near-detail ring exactly
    // like being outside the garden: clumps are unresolvable at that speed and
    // the resample was the hitch. Rebuilds once you slow back under ~18 m/s.
    const tooFast = this.#focusSpeed > 18 && !force;
    if (tooFast || values.nearRadius <= 0 || values.nearDensity <= 0 || !inBotanicalGarden(focus.x, focus.z, values.nearRadius)) {
      if (this.#detailTiles.size > 0) {
        this.#clearDetailTiles();
        this.stats.detailLow = 0;
        this.stats.detailTall = 0;
        this.#syncStats();
      }
      return;
    }
    this.#syncDetailTiles(focus, force);
  }

  // Base grass is split into ~48 m tiles so regular frustum culling can drop
  // everything behind the camera. Instance positions are authored in the
  // mesh's local/world-aligned space, so the bound is set once on that mesh —
  // it is not a world sphere on InstancedMesh geometry that gets transformed a
  // second time (the old botanical culling bug).
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
        this.#baseMaterialState.material,
        false
      );
      writeGrassMesh(mesh, list, fadeRadius);
      let minX = Infinity;
      let maxX = -Infinity;
      let minZ = Infinity;
      let maxZ = -Infinity;
      for (const e of list) {
        if (e.x < minX) minX = e.x;
        if (e.x > maxX) maxX = e.x;
        if (e.z < minZ) minZ = e.z;
        if (e.z > maxZ) maxZ = e.z;
      }
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;
      setGrassMeshBounds(mesh, list, 3);
      mesh.frustumCulled = true;
      this.#baseGroup.add(mesh);
      this.#baseChunks.push({ mesh, cx, cz, full: list.length });
    }
  }

  #detailTileSize(): number {
    // The old rebuild-step knob now controls stable tile granularity. Crossing
    // one tile streams an entering strip; it never causes a whole-ring upload.
    return THREE.MathUtils.clamp(Math.round(Number(BOTANICAL_GRASS_TUNING.values.nearRebuildStep) * 1.4), 12, 20);
  }

  #detailLod(tx: number, tz: number, tileSize: number, focus: GrassFocus, radius: number): DetailLod {
    const minX = tx * tileSize;
    const minZ = tz * tileSize;
    const dx = Math.max(minX - focus.x, 0, focus.x - (minX + tileSize));
    const dz = Math.max(minZ - focus.z, 0, focus.z - (minZ + tileSize));
    const stagger = (hash(tx, tz, 409) - 0.5) * Math.min(5, radius * 0.1);
    const d = Math.max(0, Math.hypot(dx, dz) + stagger);
    if (d < radius * 0.34) return "near";
    if (d < radius * 0.68) return "mid";
    return "far";
  }

  #entryRank(entry: GrassEntry): number {
    return hash(Math.round(entry.x * 100), Math.round(entry.z * 100), 431 + Math.round(entry.yaw * 10));
  }

  #removeDetailMesh(tile: DetailTile) {
    if (!tile.mesh) return;
    this.#detailGroup.remove(tile.mesh);
    tile.mesh.geometry.dispose();
    tile.mesh = null;
    tile.live = tile.liveLow = tile.liveTall = 0;
  }

  #applyDetailLod(tile: DetailTile, lod: DetailLod, radius: number) {
    if (tile.mesh && tile.lod === lod) {
      setGrassMeshCount(tile.mesh, tile.targetLive);
      tile.live = tile.targetLive;
      tile.liveLow = tile.targetLow;
      tile.liveTall = tile.targetTall;
      return;
    }
    this.#removeDetailMesh(tile);
    tile.lod = lod;
    const density = lod === "near" ? 1 : lod === "mid" ? 0.62 : 0.3;
    const values = BOTANICAL_GRASS_TUNING.values;
    const lowCount = values.showLow ? Math.round(tile.low.length * density) : 0;
    const tallCount = values.showTall ? Math.round(tile.tall.length * density) : 0;
    const selected = tile.low.slice(0, lowCount).concat(tile.tall.slice(0, tallCount));
    // A hash-ordered merged buffer makes every global-budget prefix spatially
    // uniform and preserves both height classes across a tile.
    selected.sort((a, b) => this.#entryRank(a) - this.#entryRank(b));
    tile.targetLow = lowCount;
    tile.targetTall = tallCount;
    tile.targetLive = selected.length;
    tile.liveLow = lowCount;
    tile.liveTall = tallCount;
    tile.live = selected.length;
    if (selected.length === 0) return;

    const all = tile.low.concat(tile.tall);
    const mesh = createGrassMesh(
      `sfbg_detail_${tile.tx}_${tile.tz}_${lod}`,
      all.length,
      this.#detailGeometry[lod],
      this.#detailMaterials[lod].material,
      false
    );
    writeGrassMesh(mesh, selected, Math.max(1, radius));
    setGrassMeshBounds(mesh, all, 2.5);
    mesh.frustumCulled = true;
    this.#detailGroup.add(mesh);
    tile.mesh = mesh;
  }

  #syncDetailTiles(focus: GrassFocus, force: boolean) {
    const values = BOTANICAL_GRASS_TUNING.values;
    const radius = Math.max(1, Number(values.nearRadius));
    const tileSize = this.#detailTileSize();
    const focusTileX = Math.floor(focus.x / tileSize);
    const focusTileZ = Math.floor(focus.z / tileSize);
    const streamStep = Math.max(3, Math.min(6, tileSize * 0.4));
    if (
      !force &&
      Number.isFinite(this.#detailSyncX) &&
      Math.hypot(focus.x - this.#detailSyncX, focus.z - this.#detailSyncZ) < streamStep
    ) return;
    this.#detailSyncX = focus.x;
    this.#detailSyncZ = focus.z;

    const streamRadius = radius + streamStep + 2;
    const tileReach = Math.ceil(streamRadius / tileSize) + 1;
    const desired = new Set<string>();
    for (let tx = focusTileX - tileReach; tx <= focusTileX + tileReach; tx++) {
      for (let tz = focusTileZ - tileReach; tz <= focusTileZ + tileReach; tz++) {
        const minX = tx * tileSize;
        const minZ = tz * tileSize;
        const dx = Math.max(minX - focus.x, 0, focus.x - (minX + tileSize));
        const dz = Math.max(minZ - focus.z, 0, focus.z - (minZ + tileSize));
        if (Math.hypot(dx, dz) > streamRadius) continue;
        const key = `${tx},${tz}`;
        desired.add(key);
        let tile = this.#detailTiles.get(key);
        if (!tile) {
          const detail = sampleGrassEntries(this.#map, this.#trees, {
            spacing: values.nearSpacing,
            bounds: {
              minX: tx * tileSize,
              maxX: (tx + 1) * tileSize,
              minZ: tz * tileSize,
              maxZ: (tz + 1) * tileSize
            },
            salt: DETAIL_SALT,
            densityScale: values.nearDensity,
            treeInfluenceAt: this.#treeInfluenceAt
          });
          detail.low.sort((a, b) => this.#entryRank(a) - this.#entryRank(b));
          detail.tall.sort((a, b) => this.#entryRank(a) - this.#entryRank(b));
          tile = {
            tx,
            tz,
            low: detail.low,
            tall: detail.tall,
            lod: "far",
            mesh: null,
            targetLow: 0,
            targetTall: 0,
            targetLive: 0,
            liveLow: 0,
            liveTall: 0,
            live: 0
          };
          this.#detailTiles.set(key, tile);
        }
        this.#applyDetailLod(tile, this.#detailLod(tx, tz, tileSize, focus, radius), radius);
      }
    }

    for (const [key, tile] of this.#detailTiles) {
      if (desired.has(key)) continue;
      this.#removeDetailMesh(tile);
      this.#detailTiles.delete(key);
    }

    let live = 0;
    for (const tile of this.#detailTiles.values()) live += tile.live;
    if (live > BotanicalGrassController.#MAX_LIVE_DETAIL) {
      const scale = BotanicalGrassController.#MAX_LIVE_DETAIL / live;
      for (const tile of this.#detailTiles.values()) {
        if (!tile.mesh) continue;
        tile.live = Math.max(1, Math.round(tile.targetLive * scale));
        tile.liveLow = Math.round(tile.targetLow * scale);
        tile.liveTall = Math.round(tile.targetTall * scale);
        setGrassMeshCount(tile.mesh, tile.live);
      }
    }

    this.stats.detailLow = 0;
    this.stats.detailTall = 0;
    for (const tile of this.#detailTiles.values()) {
      this.stats.detailLow += tile.liveLow;
      this.stats.detailTall += tile.liveTall;
    }
    this.#syncStats();
  }

  #clearDetailTiles() {
    for (const tile of this.#detailTiles.values()) this.#removeDetailMesh(tile);
    this.#detailTiles.clear();
    this.#detailSyncX = Number.NaN;
    this.#detailSyncZ = Number.NaN;
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
