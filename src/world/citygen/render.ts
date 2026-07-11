// Render host — turns generated MeshData into THREE meshes with the SF theme
// materials, and gives each building a seeded "painted lady" body colour so a
// block reads as a varied SF terrace, not clones. This is the bridge between the
// pure engine (core/) and a THREE scene; kept out of core/ so the engine stays
// portable. LOD/streaming/shadow-proxy integration is the streaming phase — this
// file is the direct "build these buildings now" path used by the demo + tests.
import * as THREE from "three/webgpu";
import { materialOpacity } from "three/tsl";
import { generate, type BuildingSpec } from "./index";
import { buildCityGenMaterials, makeWallMaterial, type WallKind } from "./theme/materials";
import { makeParallaxGlass, type ParallaxZone } from "./theme/parallaxWindow";
import { expandModuleInstances } from "./theme/moduleDefs";
import { rng } from "./core/rng";
import { mergePanels } from "./core/mesh";
import { buildInterior as buildInteriorParts } from "./interior/interior";
import type { ColliderBox, MeshData, ModuleInstance } from "./core/types";
import type { ModuleLayer } from "./render/moduleLayer";

// SF "painted lady" body colours — mid-saturated so the bright white trim reads
// as the classic Victorian contrast (bodies vary building-to-building).
// Per-archetype body palettes. Victorians are saturated painted ladies; other
// districts read as their real materials (stucco pastels, grey masonry, brick).
const PAINTED_LADY = [
  0x2e8577, 0xb05f28, 0x4666b8, 0x5f8a2e, 0xc06e26, 0x3f52a8,
  0xb03a52, 0xc79320, 0x1f7f92, 0x74459f, 0x3f8f4a, 0xc17c1e,
];
const PALETTES: Record<string, number[]> = {
  victorian: PAINTED_LADY,
  edwardian: [0xdcd8cc, 0xcdc6b4, 0xd8d0be, 0xc6cdc0, 0xd0c8b8, 0xbfc4c0], // pale Edwardian
  marina: [0xe6d8bc, 0xe0c9a6, 0xd9b48a, 0xe8d2b0, 0xcdd8c0, 0xe8cfc0, 0xefe2c2], // stucco pastels
  downtown: [0x9a9d9f, 0xb0a894, 0x8f9498, 0xa6a29a, 0x8a8d90, 0xa89f8c], // grey/tan masonry
  soma: [0x8f4a3a, 0x9c5540, 0x7a3f34, 0xa5634a, 0x86584a, 0x944e3c], // brick reds
  chinatown: [0xcabf9e, 0xc7b58a, 0xbfae86],
};

export interface CityGenMeshBundle {
  group: THREE.Group;
  buildings: number;
  triangles: number;
  dispose(): void;
}

/** seeded body colour for a building, keyed to its archetype's palette */
export function bodyColour(seed: number, archetype = "victorian"): number {
  const pal = PALETTES[archetype] ?? PAINTED_LADY;
  const r = rng(seed, 99);
  return pal[Math.floor(r() * pal.length) % pal.length];
}

export interface BuiltBuilding {
  group: THREE.Group;
  triangles: number;
  /** crossfade: o<1 → dithered (alphaHash) transparent at opacity o; o>=1 → opaque */
  setOpacity(o: number): void;
  dispose(): void;
}

// which parallax interior a building's windows show, by archetype
const ARCH_ZONE: Record<string, ParallaxZone> = {
  victorian: "residential", edwardian: "residential", marina: "residential",
  downtown: "commercial", chinatown: "commercial", soma: "loft",
};
// wall surface texture by archetype: wood clapboard on the painted ladies, brick
// on the SoMa/industrial stock, troweled stucco on the Marina, smooth on downtown.
const WALL_KIND: Record<string, WallKind> = {
  victorian: "clapboard", edwardian: "clapboard", marina: "stucco",
  downtown: "smooth", chinatown: "smooth", soma: "brick",
};
// one parallax glass per zone (cloned per building for the crossfade opacity)
const zoneGlassSrc = new Map<ParallaxZone, THREE.Material>();
function zoneGlass(archetype: string): THREE.Material {
  const zone = ARCH_ZONE[archetype] ?? "residential";
  let m = zoneGlassSrc.get(zone);
  if (!m) { m = makeParallaxGlass({ zone }); zoneGlassSrc.set(zone, m); }
  return m;
}

// ---- pooled building materials (the compile-churn fix) -----------------------
// SETTLED materials (opaque, post-fade) are SHARED city-wide: one wall material
// per (kind, body colour) — identical WGSL per kind since the colour is a uniform
// (see theme/materials.ts) — and the theme's shared id→material table for trim/
// roof/door/glass. FADE materials are per-building clones of those, created with
// alphaHash ON from birth so their pipeline variant exists before first render;
// a fade animates ONLY material.opacity (a uniform — no needsUpdate, no bundle
// re-record, no recompile). At the opaque settle the meshes swap to the shared
// settled materials (one bundle re-record) and the clones idle until dispose.
const settledWalls = new Map<string, THREE.Material>();
function settledWall(spec: BuildingSpec): THREE.Material {
  const kind = WALL_KIND[spec.archetype] ?? "smooth";
  const hex = bodyColour(spec.seed, spec.archetype);
  const key = `${kind}:${hex}`;
  let m = settledWalls.get(key);
  if (!m) { m = makeWallMaterial(hex, kind); settledWalls.set(key, m); }
  return m;
}
function fadeCloneOf(settled: THREE.Material): THREE.Material {
  // Fade clones must be NODE materials even when the settled source is a plain
  // MeshStandardMaterial (trim/roof/door/stoop). Our buildings render inside
  // STATIC BundleGroups, and three's NodeMaterialObserver.needsRefresh() skips
  // the per-frame uniform refresh for bundle objects whose material carries no
  // node (hasNode=false) — so a plain clone's animated `opacity` never reached
  // the GPU: those parts stayed at the record-time dither (~invisible) through
  // the whole fade, then popped at the settle re-record. An explicit
  // opacityNode (same value materialOpacity resolves to by default) flips
  // hasNode=true, which keeps the opacity uniform live while costing nothing
  // once the clone is returned to the pool.
  let f: THREE.Material & { alphaHash: boolean };
  if ((settled as { isNodeMaterial?: boolean }).isNodeMaterial) {
    f = settled.clone() as THREE.Material & { alphaHash: boolean };
  } else {
    const s = settled as THREE.MeshStandardMaterial;
    const nm = new THREE.MeshStandardNodeMaterial({
      color: s.color, roughness: s.roughness, metalness: s.metalness, side: s.side,
    });
    nm.envMapIntensity = s.envMapIntensity;
    nm.emissive = s.emissive.clone();
    nm.emissiveIntensity = s.emissiveIntensity;
    nm.opacityNode = materialOpacity;
    f = nm as THREE.Material & { alphaHash: boolean };
  }
  f.alphaHash = true; // dithered fade in the OPAQUE pass — no sorting, no blending
  f.opacity = 0.02;
  return f;
}

/** Pooled fade clones: a fading building BORROWS a dithered clone per settled
 *  material and returns it on settle/dispose. Without the pool every streamed
 *  building cloned fresh materials — a TSL node-graph build per clone, running
 *  for as long as the player roams. Pool size plateaus at the peak number of
 *  concurrently-fading (building × material) pairs; clones are never disposed. */
const fadeClonePool = new Map<THREE.Material, THREE.Material[]>();
function acquireFadeClone(settled: THREE.Material): THREE.Material {
  return fadeClonePool.get(settled)?.pop() ?? fadeCloneOf(settled);
}
function releaseFadeClone(settled: THREE.Material, clone: THREE.Material) {
  let free = fadeClonePool.get(settled);
  if (!free) fadeClonePool.set(settled, (free = []));
  clone.opacity = 0.02;
  free.push(clone);
}

/** Representative material set for boot warmup: one settled + one fade-clone per
 *  distinct pipeline (wall kinds, glass zones, one shared standard). Rendering a
 *  tiny hidden mesh per entry compiles every pipeline a streamed building will
 *  ever need — after that, builds and fades never compile at runtime. */
export function warmupMaterials(mats: Record<string, THREE.Material>): THREE.Material[] {
  const out: THREE.Material[] = [];
  const kinds: [WallKind, string][] = [["clapboard", "victorian"], ["brick", "soma"], ["stucco", "marina"], ["smooth", "downtown"]];
  for (const [kind, arch] of kinds) {
    const w = makeWallMaterial(bodyColour(1, arch), kind);
    out.push(w, fadeCloneOf(w));
  }
  for (const zone of ["residential", "commercial", "loft"] as ParallaxZone[]) {
    const g = zoneGlass(zone === "residential" ? "victorian" : zone === "commercial" ? "downtown" : "soma");
    out.push(g, fadeCloneOf(g));
  }
  const std = mats["trim.victorian"] ?? mats["base.stoop"];
  if (std) out.push(std, fadeCloneOf(std));
  return out;
}

/** Assemble ONE building's THREE meshes from already-generated MeshData (the
 *  expensive generate() may have run on a worker). Used by the streaming ring.
 *
 *  `gen.instances` (kit-of-parts windows) go to the instanced module layer when
 *  one is supplied — the per-building bundle then only carries walls/roof/trim
 *  boxes/doors. Without a layer they're expanded back into baked meshes. */
export function assembleBuilding(
  spec: BuildingSpec,
  gen: { meshes: MeshData[]; instances?: ModuleInstance[]; matTable?: string[] },
  mats: Record<string, THREE.Material>,
  moduleLayer?: ModuleLayer | null,
): BuiltBuilding {
  let meshes = gen.meshes;
  const instances = gen.instances ?? [];
  const matTable = gen.matTable ?? [];
  if (instances.length && !moduleLayer) {
    meshes = meshes.concat(mergePanels(expandModuleInstances(instances, matTable)));
  }
  return assembleBuildingMeshes(spec, meshes, mats, moduleLayer && instances.length ? { moduleLayer, instances, matTable } : null);
}

function assembleBuildingMeshes(
  spec: BuildingSpec,
  meshes: MeshData[],
  mats: Record<string, THREE.Material>,
  modules: { moduleLayer: ModuleLayer; instances: ModuleInstance[]; matTable: string[] } | null,
): BuiltBuilding {
  const settledOf = (id: string): THREE.Material => {
    if (id.startsWith("wall.")) return settledWall(spec);
    if (id === "glass") return zoneGlass(spec.archetype);
    return mats[id] ?? settledWall(spec);
  };
  // Each faded-in detail building draws as ONE WebGPU render bundle — a downtown
  // block can hold dozens of detail buildings, ~9 per-panel draws each, so
  // collapsing every settled building to a cached command buffer takes those
  // hundreds of draws off the per-frame encode (main AND shadow passes). Same
  // pattern as the baked tiles (world/tiles.ts): a real bundle for its whole life
  // (never toggling isBundleGroup — that flip mid-session corrupts the shadow
  // pass's bundle state). The bundle re-records exactly TWICE per fade direction:
  // once when meshes swap onto their fade clones, once when they settle back onto
  // the shared opaque materials — the fade frames in between write one opacity
  // uniform per material and re-record nothing.
  const group = new THREE.BundleGroup();
  group.name = "cityGenBuilding";
  const geoms: THREE.BufferGeometry[] = [];
  const parts: { mesh: THREE.Mesh; settled: THREE.Material }[] = [];
  // settled → clone this building is currently borrowing from the pool
  let borrowed: Map<THREE.Material, THREE.Material> | null = new Map();
  let triangles = 0;
  for (const md of meshes) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(md.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(md.indices, 1));
    g.computeBoundingSphere();
    geoms.push(g);
    triangles += md.indices.length / 3;
    const settled = settledOf(md.materialId);
    let fade = borrowed.get(settled);
    if (!fade) { fade = acquireFadeClone(settled); borrowed.set(settled, fade); }
    const mesh = new THREE.Mesh(g, fade); // born fading (ring fades every build in)
    mesh.name = md.materialId; // lets probes tell a wall/base panel from door/glass
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // a bundle records each child's draw once, so per-child frustum culling would
    // freeze whatever the record-time camera saw — children draw unconditionally,
    // the whole (near-player) building is distance-managed by the streaming ring.
    mesh.frustumCulled = false;
    group.add(mesh);
    parts.push({ mesh, settled });
  }
  // Sit the detail mesh a hair PROUD of its chunk-LOD prism (same footprint) so it
  // wins the depth test everywhere they overlap — no z-fighting. Geometric (the
  // app is reversed-z, where the codebase separates coincident surfaces spatially
  // rather than with polygonOffset). Scale ~0.6% about the base centroid; colliders
  // stay at the true footprint, so collision is unchanged.
  {
    let cx = 0, cz = 0; for (const [px, pz] of spec.poly) { cx += px; cz += pz; }
    cx /= spec.poly.length; cz /= spec.poly.length;
    const s = 1.006, sy = 1.004, b = spec.base;
    // + a deterministic ±3 cm XZ nudge (as facade.ts does) so two adjacent
    // rowhouses that share a coplanar party wall don't z-fight against each other.
    const rnd = rng(spec.seed, 71);
    const nx = (rnd() - 0.5) * 0.06, nz = (rnd() - 0.5) * 0.06;
    group.matrixAutoUpdate = false;
    group.matrix
      .makeTranslation(cx + nx, b, cz + nz)
      .multiply(new THREE.Matrix4().makeScale(s, sy, s))
      .multiply(new THREE.Matrix4().makeTranslation(-cx, -b, -cz));
    group.matrixWorldNeedsUpdate = true;
  }
  // kit-of-parts windows → the instanced module layer, under the SAME proud
  // transform as the bundle (or the panes would sink into the scaled walls).
  // Its fade slot is driven from setOpacity below, so windows dither in step
  // with the building's clone-fade parts.
  const moduleHandle = modules
    ? modules.moduleLayer.addBuilding(modules.instances, modules.matTable, {
        matrix: group.matrix,
        zone: ARCH_ZONE[spec.archetype] ?? "residential",
        seed: spec.seed,
      })
    : null;
  // slot texture exhausted → fall back to baked expansion so windows still draw
  if (modules && !moduleHandle) {
    const expanded = mergePanels(expandModuleInstances(modules.instances, modules.matTable));
    for (const md of expanded) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(md.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(md.indices, 1));
      g.computeBoundingSphere();
      geoms.push(g);
      triangles += md.indices.length / 3;
      const settled = settledOf(md.materialId);
      let fade = borrowed!.get(settled);
      if (!fade) { fade = acquireFadeClone(settled); borrowed!.set(settled, fade); }
      const mesh = new THREE.Mesh(g, fade);
      mesh.name = md.materialId;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.frustumCulled = false;
      group.add(mesh);
      parts.push({ mesh, settled });
    }
  }
  let onFadeMats = true; // meshes start on their borrowed fade clones
  const returnClones = () => {
    if (!borrowed) return;
    for (const [settled, clone] of borrowed) releaseFadeClone(settled, clone);
    borrowed = null;
  };
  return {
    group, triangles,
    setOpacity(o: number) {
      moduleHandle?.setFade(o); // instanced windows dither in step (one texel write)
      const fading = o < 0.999;
      if (fading !== onFadeMats) {
        // crossing the settle boundary (either direction) swaps material pointers
        // — the ONLY re-record a fade ever causes
        if (fading && !borrowed) {
          borrowed = new Map();
          for (const p of parts) {
            let f = borrowed.get(p.settled);
            if (!f) { f = acquireFadeClone(p.settled); borrowed.set(p.settled, f); }
          }
        }
        for (const p of parts) p.mesh.material = fading ? borrowed!.get(p.settled)! : p.settled;
        onFadeMats = fading;
        if (!fading) returnClones(); // settled: clones go back to the pool
        group.needsUpdate = true;
      }
      if (fading && borrowed) {
        const oo = Math.max(0.02, o);
        for (const f of borrowed.values()) f.opacity = oo; // uniform write only
      }
    },
    dispose() {
      moduleHandle?.free();
      for (const g of geoms) g.dispose();
      returnClones(); // pooled clones outlive the building — never disposed
      group.clear();
    },
  };
}

/** Build ONE building's meshes into a fresh group (synchronous path: generate()
 *  runs here on the main thread — the streaming ring prefers the worker +
 *  assembleBuilding; demos/tests and the no-worker fallback use this). */
export function buildBuilding(spec: BuildingSpec, mats: Record<string, THREE.Material>, moduleLayer?: ModuleLayer | null): BuiltBuilding {
  const gen = generate(spec);
  return assembleBuilding(spec, gen, mats, moduleLayer);
}

/** Build a building's INTERIOR meshes + colliders (lazy: only when entered).
 *  Emissive-lit, no shadow casting; shares the interior materials. */
export function buildInterior(
  spec: BuildingSpec,
  mats: Record<string, THREE.Material>,
): { group: THREE.Group; colliders: ColliderBox[]; dispose(): void } {
  // interior furnishing matches the parallax-window zone (home/shop/loft). Its
  // ground floor sits at the terrain GRADE (where you actually walk in the door),
  // not the low baked base — otherwise on a hill the floor buries below the entry.
  const gradeBase = (spec as { grade?: number }).grade ?? spec.base;
  const ispec = gradeBase !== spec.base ? { ...spec, base: gradeBase } : spec;
  const { panels, colliders } = buildInteriorParts(ispec, ARCH_ZONE[spec.archetype] ?? "residential");
  const merged = mergePanels(panels);
  const group = new THREE.Group();
  group.name = "cityGenInterior";
  const geoms: THREE.BufferGeometry[] = [];
  for (const md of merged) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
    g.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(md.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(md.indices, 1));
    g.computeBoundingSphere();
    geoms.push(g);
    const mesh = new THREE.Mesh(g, mats[md.materialId] ?? mats["int.wood"]);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  }
  return { group, colliders, dispose() { for (const g of geoms) g.dispose(); group.clear(); } };
}

/** Build a THREE.Group of finished buildings from specs (no streaming/LOD). */
export function buildCityGenGroup(
  specs: BuildingSpec[],
  opts: { materials?: Record<string, THREE.Material>; castShadow?: boolean } = {},
): CityGenMeshBundle {
  const mats = opts.materials ?? buildCityGenMaterials();
  const cast = opts.castShadow ?? true;
  const group = new THREE.Group();
  group.name = "cityGen";
  const perBuildingWall = new Map<number, THREE.Material>(); // one wall material per building
  const disposables: THREE.BufferGeometry[] = [];
  let triangles = 0;

  for (const spec of specs) {
    const { meshes } = generate(spec, false, { expandModules: true }); // demo path: bake windows
    // seeded painted-lady body colour → its own clapboard wall material
    const r = rng(spec.seed, 99);
    const body = PAINTED_LADY[Math.floor(r() * PAINTED_LADY.length) % PAINTED_LADY.length];
    const wallMat = makeWallMaterial(body, WALL_KIND[spec.archetype] ?? "smooth");
    perBuildingWall.set(spec.id, wallMat);

    for (const md of meshes) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(md.positions, 3));
      g.setAttribute("normal", new THREE.BufferAttribute(md.normals, 3));
      g.setAttribute("uv", new THREE.BufferAttribute(md.uvs, 2));
      g.setIndex(new THREE.BufferAttribute(md.indices, 1));
      g.computeBoundingSphere();
      disposables.push(g);
      triangles += md.indices.length / 3;

      const mat = md.materialId.startsWith("wall.") ? wallMat : (mats[md.materialId] ?? wallMat);
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.name = "cityGenBuilding";
      group.add(mesh);
    }
  }

  return {
    group,
    buildings: specs.length,
    triangles,
    dispose() {
      for (const g of disposables) g.dispose();
      for (const m of perBuildingWall.values()) m.dispose();
      group.clear();
    },
  };
}
