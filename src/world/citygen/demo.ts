// CityGen demo — spawns a short terrace of generated buildings at a chosen spot,
// on the real ground, for in-app visual verification (headless WebGPU capture)
// and quick eyeballing. NOT part of normal play: main.ts exposes it on __sf and
// the probe calls spawn(); nothing renders until then.
import * as THREE from "three/webgpu";
import { buildCityGenGroup, type CityGenMeshBundle } from "./render";
import { buildCityGenMaterials } from "./theme/materials";
import type { BuildingSpec } from "./core/types";

interface Ctx {
  scene: THREE.Object3D;
  map: { groundHeight(x: number, z: number): number };
}

export interface CityGenDemo {
  spawn(opts?: { x?: number; z?: number; count?: number; archetype?: string }): { center: [number, number]; buildings: number; triangles: number };
  clear(): void;
}

export function createCityGenDemo(ctx: Ctx): CityGenDemo {
  const materials = buildCityGenMaterials();
  let bundle: CityGenMeshBundle | null = null;
  let group: THREE.Group | null = null;

  const clear = () => {
    if (group) ctx.scene.remove(group);
    bundle?.dispose();
    bundle = null; group = null;
  };

  return {
    spawn(opts = {}) {
      clear();
      const cx = opts.x ?? 200, cz = opts.z ?? -1800;
      const count = opts.count ?? 6;
      const archetype = opts.archetype ?? "victorian";
      const specs: BuildingSpec[] = [];
      // A terrace of narrow-front rowhouses running along +z (party walls touching),
      // with the FRONT façade facing WEST (−x) so a low afternoon sun rakes across
      // the bays and cornices. Front width runs along z (the longer edge → the
      // street face); depth runs along x.
      const mix = ["victorian", "marina", "downtown", "soma", "edwardian"];
      let z = cz;
      for (let k = 0; k < count; k++) {
        const arche = archetype === "mix" ? mix[k % mix.length] : archetype;
        const w = 7.6 + ((k * 37) % 5) * 0.5;      // fronts (along z)
        const depth = 6.6;                          // shallower (along x)
        const floors = 3 + (k % 2);                 // 3–4 storeys
        const floorH = 3.4;
        const base = ctx.map.groundHeight(cx + depth / 2, z + w / 2);
        const top = base + floors * floorH;
        // wound so the WEST edge ([cx,z]→[cx,z+w]) is the longest → the street face
        const poly: [number, number][] = [[cx, z], [cx, z + w], [cx + depth, z + w], [cx + depth, z]];
        specs.push({ i: k, id: 900000 + k, poly, base, top, archetype: arche, seed: (k * 2654435761) >>> 0 });
        z += w + 0.06;
      }
      bundle = buildCityGenGroup(specs, { materials, castShadow: true });
      group = bundle.group;
      ctx.scene.add(group);
      return { center: [cx, cz + (z - cz) / 2], buildings: bundle.buildings, triangles: bundle.triangles };
    },
    clear,
  };
}
