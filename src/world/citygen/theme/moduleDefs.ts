// Kit-of-parts module templates + their AFFINE geometry extraction.
//
// A module (faceWindow / shaftWindow) is authored ONCE in a local frame —
// origin at its bottom-left on the wall plane, +X along the wall, +Y up,
// outward at LOCAL −Z (a +Y rotation mapping +X onto a CCW wall's `along`
// maps −Z onto its outward normal `(az, −ax)`; see core/types.ModuleInstance).
//
// Every vertex of these templates is an AFFINE function of the module's (w, h):
//     P(w, h) = c0 + cW·w + cH·h
// because the emitters compose constant cross-sections (frame 0.05 m, muntin
// 0.012 m, sill/crown depths…) with spans that scale linearly. We therefore
// evaluate the baked builder at three (w, h) samples, solve the coefficients
// per vertex, and VERIFY the solution against a fourth sample — any future
// non-affine edit to a window emitter fails loudly here rather than rendering
// subtly wrong instanced geometry.
//
// The render layer (render/moduleLayer.ts) uploads (c0, cW, cH) as vertex
// attributes and evaluates them per instance in the vertex stage; expansion
// back to baked panels (expandModuleInstances) serves legacy demo paths and
// any host without the instanced layer. Pure — no THREE.
import { PanelBuilder, type Vec3 } from "../core/facade";
import {
  MODULE_FACE_WINDOW, MODULE_FACE_WINDOW_ARCHED, MODULE_SHAFT_WINDOW, MODULE_KIND_COUNT,
  type ModuleInstance, type Panel,
} from "../core/types";
import { bakedFaceWindow } from "./facadeKit";
import { bakedShaftWindow } from "./largeCommercial";

/** placeholder material ids inside templates — resolved per instance */
export const BUCKET_TRIM = "__mod.trim";
export const BUCKET_GLASS = "__mod.glass";

const TEMPLATE_MATS = { frame: BUCKET_TRIM, glass: BUCKET_GLASS, trim: BUCKET_TRIM };

/** run one module's baked builder in the local frame at (w, h) */
function buildLocal(kind: number, w: number, h: number): Panel[] {
  const out = new PanelBuilder();
  out.instancing = false; // templates always take the baked path
  const a: Vec3 = [0, 0, 0], b: Vec3 = [w, 0, 0], n: Vec3 = [0, 0, -1];
  // NOTE: local +X with outward −Z matches the instance basis (see header).
  // The builders only use `n` directly (no basis-consistency requirement).
  if (kind === MODULE_FACE_WINDOW) bakedFaceWindow(out, a, b, 0, h, n, TEMPLATE_MATS, false);
  else if (kind === MODULE_FACE_WINDOW_ARCHED) bakedFaceWindow(out, a, b, 0, h, n, TEMPLATE_MATS, true);
  else if (kind === MODULE_SHAFT_WINDOW) bakedShaftWindow(out, a, b, 0, h, n, TEMPLATE_MATS);
  else throw new Error(`unknown module kind ${kind}`);
  return out.panels();
}

/** one material bucket of an extracted module: affine position coefficients +
 *  (constant) normals + indices. UVs are omitted — the module materials are
 *  untextured (plain trim colour / procedural glass). */
export interface ModuleBucket {
  bucket: string; // BUCKET_TRIM | BUCKET_GLASS
  c0: Float32Array; cW: Float32Array; cH: Float32Array; // vec3 per vertex
  normals: Float32Array;
  indices: Uint32Array;
}

const cache: (ModuleBucket[] | null)[] = new Array(MODULE_KIND_COUNT).fill(null);

/** extract (and cache) the affine buckets for a module kind */
export function moduleBuckets(kind: number): ModuleBucket[] {
  const hit = cache[kind];
  if (hit) return hit;
  // sample sizes inside every emitter's validity region (no early-outs, and
  // clear of any conditional clamps)
  const [w0, h0] = [1.0, 1.0], [w1, h1] = [2.0, 2.0];
  const P00 = buildLocal(kind, w0, h0);
  const P10 = buildLocal(kind, w1, h0);
  const P01 = buildLocal(kind, w0, h1);
  const P11 = buildLocal(kind, 1.6, 2.4); // verification sample
  const out: ModuleBucket[] = [];
  for (let pi = 0; pi < P00.length; pi++) {
    const p00 = P00[pi], p10 = P10[pi], p01 = P01[pi], p11 = P11[pi];
    const nV = p00.positions.length / 3;
    if (p10.positions.length !== nV * 3 || p01.positions.length !== nV * 3 || p11.positions.length !== nV * 3 ||
        p10.materialId !== p00.materialId || p01.materialId !== p00.materialId) {
      throw new Error(`module ${kind}: template emits size-dependent topology — not instanceable`);
    }
    const c0 = new Float32Array(nV * 3), cW = new Float32Array(nV * 3), cH = new Float32Array(nV * 3);
    for (let i = 0; i < nV * 3; i++) {
      const dw = (p10.positions[i] - p00.positions[i]) / (w1 - w0);
      const dh = (p01.positions[i] - p00.positions[i]) / (h1 - h0);
      const base = p00.positions[i] - dw * w0 - dh * h0;
      c0[i] = base; cW[i] = dw; cH[i] = dh;
      // verify affine-ness at the independent 4th sample
      const predicted = base + dw * 1.6 + dh * 2.4;
      if (Math.abs(predicted - p11.positions[i]) > 1e-4) {
        throw new Error(`module ${kind} bucket ${p00.materialId}: vertex ${Math.floor(i / 3)} is not affine in (w,h) — Δ=${Math.abs(predicted - p11.positions[i]).toFixed(5)}`);
      }
      // normals must be size-invariant (pure rotation basis in the shader)
      if (Math.abs(p11.normals[i] - p00.normals[i]) > 1e-5) {
        throw new Error(`module ${kind} bucket ${p00.materialId}: normal varies with size`);
      }
    }
    out.push({
      bucket: p00.materialId,
      c0, cW, cH,
      normals: Float32Array.from(p00.normals),
      indices: Uint32Array.from(p00.indices),
    });
  }
  cache[kind] = out;
  return out;
}

/** Expand module instances back into baked world-space panels (legacy demo /
 *  no-layer fallback). Re-runs the real emitters per instance, so the output is
 *  bit-identical to the pre-kit baked geometry. */
export function expandModuleInstances(instances: readonly ModuleInstance[], matTable: readonly string[]): Panel[] {
  const out = new PanelBuilder();
  out.instancing = false;
  for (const inst of instances) {
    const a: Vec3 = [inst.ox, 0, inst.oz];
    const b: Vec3 = [inst.ox + inst.ax * inst.w, 0, inst.oz + inst.az * inst.w];
    const n: Vec3 = [inst.az, 0, -inst.ax];
    const m = { frame: matTable[inst.trim], glass: matTable[inst.glass], trim: matTable[inst.trim] };
    if (inst.module === MODULE_SHAFT_WINDOW) bakedShaftWindow(out, a, b, inst.oy, inst.oy + inst.h, n, m);
    else bakedFaceWindow(out, a, b, inst.oy, inst.oy + inst.h, n, m, inst.module === MODULE_FACE_WINDOW_ARCHED);
  }
  return out.panels();
}
