// CityGen build worker — runs the expensive, PURE grammar generation off the
// main thread. One request = one building: massing + façade decoration +
// panel merge (core/), producing MeshData typed arrays that transfer back
// zero-copy. The main thread (stream/ring.ts) only assembles THREE objects
// from the arrays — the ~30-100 ms-per-building generate() cost that used to
// land in a driving frame lands here instead.
//
// PURITY CONTRACT: this module's import graph must stay THREE-free (core/ +
// theme grammar only — the "no THREE-in-core" rule in ../index.ts). Materials
// and scene assembly live on the main thread.
import { generate } from "../index";
import type { BuildingSpec } from "../core/types";

interface BuildRequest {
  id: number;
  spec: BuildingSpec;
}

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, spec } = e.data;
  const { meshes, instances, matTable } = generate(spec);
  const transfer: ArrayBuffer[] = [];
  for (const m of meshes) {
    transfer.push(m.positions.buffer as ArrayBuffer, m.normals.buffer as ArrayBuffer, m.uvs.buffer as ArrayBuffer, m.indices.buffer as ArrayBuffer);
  }
  // window instances are a few dozen tiny records — plain structured clone
  (self as unknown as { postMessage(msg: unknown, transfer: ArrayBuffer[]): void }).postMessage({ id, meshes, instances, matTable }, transfer);
};
