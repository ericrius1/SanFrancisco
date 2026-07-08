// Render host — turns generated MeshData into THREE meshes with the SF theme
// materials, and gives each building a seeded "painted lady" body colour so a
// block reads as a varied SF terrace, not clones. This is the bridge between the
// pure engine (core/) and a THREE scene; kept out of core/ so the engine stays
// portable. LOD/streaming/shadow-proxy integration is the streaming phase — this
// file is the direct "build these buildings now" path used by the demo + tests.
import * as THREE from "three/webgpu";
import { generate, type BuildingSpec } from "./index";
import { buildCityGenMaterials, makeWallMaterial } from "./theme/materials";
import { rng } from "./core/rng";

// SF "painted lady" body colours — mid-saturated so the bright white trim reads
// as the classic Victorian contrast (bodies vary building-to-building).
// saturated SF painted-lady bodies — paired with a strong self-lit emissive so
// the colour survives the engine's bright exposure + ACES instead of washing grey
const PAINTED_LADY = [
  0x2e8577, // teal green
  0xb05f28, // terracotta
  0x4666b8, // periwinkle blue
  0x5f8a2e, // olive green
  0xc06e26, // pumpkin
  0x3f52a8, // cornflower
  0xb03a52, // rose
  0xc79320, // gold
  0x1f7f92, // teal
  0x74459f, // violet
  0x3f8f4a, // sage green
  0xc17c1e, // mustard
];

export interface CityGenMeshBundle {
  group: THREE.Group;
  buildings: number;
  triangles: number;
  dispose(): void;
}

/** seeded painted-lady body colour for a building */
export function bodyColour(seed: number): number {
  const r = rng(seed, 99);
  return PAINTED_LADY[Math.floor(r() * PAINTED_LADY.length) % PAINTED_LADY.length];
}

/** Build ONE building's meshes into a fresh group (used by the streaming ring). */
export function buildBuilding(
  spec: BuildingSpec,
  mats: Record<string, THREE.Material>,
): { group: THREE.Group; triangles: number; dispose(): void } {
  const { meshes } = generate(spec);
  const wallMat = makeWallMaterial(bodyColour(spec.seed));
  const group = new THREE.Group();
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
    const mat = md.materialId.startsWith("wall.") ? wallMat : (mats[md.materialId] ?? wallMat);
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    group.add(mesh);
  }
  return {
    group, triangles,
    dispose() { for (const g of geoms) g.dispose(); wallMat.dispose(); group.clear(); },
  };
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
    const wallMat = makeWallMaterial(body);
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
