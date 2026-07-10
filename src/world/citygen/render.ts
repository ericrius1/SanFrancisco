// Render host — turns generated MeshData into THREE meshes with the SF theme
// materials, and gives each building a seeded "painted lady" body colour so a
// block reads as a varied SF terrace, not clones. This is the bridge between the
// pure engine (core/) and a THREE scene; kept out of core/ so the engine stays
// portable. LOD/streaming/shadow-proxy integration is the streaming phase — this
// file is the direct "build these buildings now" path used by the demo + tests.
import * as THREE from "three/webgpu";
import { generate, type BuildingSpec } from "./index";
import { buildCityGenMaterials, makeWallMaterial, type WallKind } from "./theme/materials";
import { makeParallaxGlass, type ParallaxZone } from "./theme/parallaxWindow";
import { rng } from "./core/rng";
import { mergePanels } from "./core/mesh";
import { buildInterior as buildInteriorParts } from "./interior/interior";
import type { ColliderBox } from "./core/types";

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

/** Build ONE building's meshes into a fresh group (used by the streaming ring).
 *  Materials are PER-BUILDING (cloned) so the ring can crossfade this building in
 *  without touching its neighbours. */
export function buildBuilding(spec: BuildingSpec, mats: Record<string, THREE.Material>): BuiltBuilding {
  const { meshes } = generate(spec);
  const wallMat = makeWallMaterial(bodyColour(spec.seed, spec.archetype), WALL_KIND[spec.archetype] ?? "smooth");
  const local = new Map<string, THREE.Material>();     // per-building material clones
  const getMat = (id: string): THREE.Material => {
    if (id.startsWith("wall.")) return wallMat;
    let m = local.get(id);
    if (!m) {
      const src = id === "glass" ? zoneGlass(spec.archetype) : (mats[id] ?? wallMat);
      m = src.clone();
      local.set(id, m);
    }
    return m;
  };
  // Each faded-in detail building draws as ONE WebGPU render bundle — a downtown
  // block can hold dozens of detail buildings, ~9 per-panel draws each, so
  // collapsing every settled building to a cached command buffer takes those
  // hundreds of draws off the per-frame encode (main AND shadow passes). Same
  // pattern as the baked tiles (world/tiles.ts): a real bundle for its whole life
  // (never toggling isBundleGroup — that flip mid-session corrupts the shadow
  // pass's bundle state), re-recorded via needsUpdate whenever its meshes/materials
  // change. The only such change is the crossfade (setOpacity mutates the
  // transparent/alphaHash pipeline + opacity each frame): needsUpdate fires per
  // fade frame — cheap, few fade at once — then the building is static and free.
  const group = new THREE.BundleGroup();
  group.name = "cityGenBuilding";
  const geoms: THREE.BufferGeometry[] = [];
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
    const mesh = new THREE.Mesh(g, getMat(md.materialId));
    mesh.name = md.materialId; // lets probes tell a wall/base panel from door/glass
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // a bundle records each child's draw once, so per-child frustum culling would
    // freeze whatever the record-time camera saw — children draw unconditionally,
    // the whole (near-player) building is distance-managed by the streaming ring.
    mesh.frustumCulled = false;
    group.add(mesh);
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
  const allMats = [wallMat, ...local.values()];
  return {
    group, triangles,
    setOpacity(o: number) {
      const fading = o < 0.999;
      for (const m of allMats) {
        const mm = m as THREE.Material & { alphaHash?: boolean; opacity: number };
        mm.transparent = fading;
        mm.alphaHash = fading;       // dithered fade → no transparency sorting
        mm.opacity = fading ? Math.max(0.02, o) : 1;
        mm.needsUpdate = true;
      }
      // materials' pipeline (transparent/alphaHash) + version changed → re-record
      // the bundle. Fires each fade frame (cheap) and once at the opaque settle
      // (setOpacity(1), the last call); the building is static and free afterward.
      group.needsUpdate = true;
    },
    dispose() { for (const g of geoms) g.dispose(); for (const m of allMats) m.dispose(); group.clear(); },
  };
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
    const { meshes } = generate(spec);
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
