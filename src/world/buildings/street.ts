// Deterministic street test: ~20 generated buildings in two facing rows with a
// drivable gap between. Layout is a pure function of the base seed — same seed,
// same street. Each building goes through createGeneratedBuilding, so exteriors
// land in the global BatchedMesh pools and interiors keep their lazy 40 m/80 m
// build/dispose gates.
import type * as THREE from "three/webgpu";
import {
  createGeneratedBuilding,
  buildingPoolStats,
  type GeneratedBuilding,
  BUILDING_SCALE,
} from "./index";

// mulberry32 — deterministic layout stream
function rng(seed: number): () => number {
  let a = (seed | 0) + 0x6d2b79f5;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface StreetOpts {
  center: { x: number; z: number };
  baseSeed: number;
  count?: number;       // total buildings (split across the two rows)
  streetHalf?: number;  // half-width of the drivable gap, metres
}

export interface GeneratedStreet {
  list: GeneratedBuilding[];
  /** per-building pool-add wall time in ms (generation + batch append), for the
   *  future streaming ring */
  addMs: number[];
  update(playerPos: THREE.Vector3, dt: number): void;
  dispose(): void;
  /** global pool stats + per-building instance counts, for probes/debug */
  stats(): {
    pools: ReturnType<typeof buildingPoolStats>;
    buildings: number;
    exteriorInstances: number;
    interiorsBuilt: number;
  };
}

export async function createGeneratedStreet(
  opts: StreetOpts,
  ctx: {
    scene: THREE.Object3D;
    physics: { world: any };
    map: { groundHeight(x: number, z: number): number };
  }
): Promise<GeneratedStreet> {
  const count = opts.count ?? 20;
  const streetHalf = opts.streetHalf ?? 8;
  const rand = rng(opts.baseSeed);

  // Two rows along +x facing each other across the street (local -z = storefront):
  // north row fronts face +z (yaw π), south row fronts face -z (yaw 0).
  const perRow = Math.ceil(count / 2);
  interface Slot {
    x: number; z: number; yaw: number; seed: number;
    params: { floor: number; length: number; width: number };
  }
  const slots: Slot[] = [];
  for (let row = 0; row < 2; row++) {
    const n = row === 0 ? perRow : count - perRow;
    let cursor = 0;
    const plans: Slot[] = [];
    for (let i = 0; i < n; i++) {
      const floor = 3 + Math.floor(rand() * 6);          // 3..8
      const length = 4 + Math.floor(rand() * 5);         // 4..8
      const width = 3 + Math.floor(rand() * 3);          // 3..5
      const halfX = (length * BUILDING_SCALE) / 2;
      const halfZ = (width * BUILDING_SCALE) / 2;
      const gap = 2 + rand() * 3;
      const x = cursor + halfX;
      cursor += halfX * 2 + gap;
      const zOff = streetHalf + halfZ + rand() * 1.5;
      const z = row === 0 ? opts.center.z - zOff : opts.center.z + zOff;
      const yaw = (row === 0 ? Math.PI : 0) + (rand() - 0.5) * 0.06;
      plans.push({ x, z, yaw, seed: opts.baseSeed * 100 + row * 50 + i, params: { floor, length, width } });
    }
    // centre the row on opts.center.x
    const rowLen = cursor;
    for (const p of plans) { p.x += opts.center.x - rowLen / 2; slots.push(p); }
  }

  const list: GeneratedBuilding[] = [];
  const addMs: number[] = [];
  for (const s of slots) {
    const y = ctx.map.groundHeight(s.x, s.z);
    const t0 = performance.now();
    const b = await createGeneratedBuilding(
      { position: { x: s.x, y, z: s.z }, yawRad: s.yaw, params: s.params, seed: s.seed },
      ctx
    );
    addMs.push(performance.now() - t0);
    list.push(b);
  }

  return {
    list,
    addMs,
    update(playerPos, dt) {
      for (const b of list) b.update(playerPos, dt);
    },
    dispose() {
      for (const b of list) b.dispose();
      list.length = 0;
    },
    stats() {
      let exteriorInstances = 0, interiorsBuilt = 0;
      for (const b of list) {
        exteriorInstances += b.stats.exteriorInstances;
        if (b.stats.interiorBuilt) interiorsBuilt++;
      }
      return { pools: buildingPoolStats(), buildings: list.length, exteriorInstances, interiorsBuilt };
    },
  };
}
