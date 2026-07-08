// Cheap building LOD geometry — a low-poly extruded prism (coloured body + roof
// cap) with a procedural window grid + a few lit windows. The body colour rides
// in a per-vertex `color` attribute so a WHOLE TILE of buildings shares ONE mesh
// + ONE material (see chunkLod.ts) — the far city is a couple dozen draw calls,
// not thousands. `appendPrism` is the shared primitive; buildBuildingLOD wraps it
// for a single building.
import * as THREE from "three/webgpu";
import {
  attribute, normalWorld, uv, float, color, mix, step, fract, floor as tslFloor, hash,
} from "three/tsl";
import type { BuildingSpec } from "../core/types";
import { ensureCCW, triangulate } from "../core/footprint";
import { bodyColour } from "../render";
import { specFor } from "../theme/archetypes";

// Target window spacing; the actual grid is SNAPPED per wall (integer columns,
// integer storeys) in appendPrism, so the shader receives UVs already in "cell"
// units (1 unit = 1 window) and just reads fract()/floor() — no divide, and no
// half-window is ever clipped at a wall's top or trailing edge.
const WIN_SPACING = 2.4;   // ~metres between window centres (column target)
const BODY_EMISSIVE = 0.3; // self-lit body tint — MATCHES makeWallMaterial (theme/materials.ts)

let sharedMat: THREE.MeshStandardNodeMaterial | null = null;

/** The one material every LOD building shares — per-vertex body colour with a
 *  darkened window grid + a deterministic ~30% of windows lit warm. Carries the
 *  SAME faint self-lit body tint as the near mesh's wall material so the far
 *  building reads as the same colour, not a dark olive silhouette. */
export function lodMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedMat) return sharedMat;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  m.envMapIntensity = 5.5;
  const body = attribute("color", "vec3") as unknown as ReturnType<typeof color>;
  const isRoof = step(0.5, normalWorld.y.abs());
  const u = uv().x, v = uv().y;              // already in window-cell units
  const cu = fract(u), cv = fract(v);
  const inU = step(0.22, cu).mul(step(cu, 0.82));
  const inV = step(0.30, cv).mul(step(cv, 0.86));
  const winMask = inU.mul(inV).mul(float(1).sub(isRoof));
  m.colorNode = mix(body, color(new THREE.Color(0x1b1f27)), winMask);
  const cellId = tslFloor(u).add(tslFloor(v).mul(31.0));
  const litWin = winMask.mul(step(0.7, hash(cellId))).mul(color(new THREE.Color(0xffdca0))).mul(0.7);
  // faint self-lit body tint on the SOLID wall only (not the glass) so shaded
  // façades don't read near-black — the near mesh's wall material does the same.
  const bodyTint = body.mul(BODY_EMISSIVE).mul(float(1).sub(winMask));
  m.emissiveNode = bodyTint.add(litWin);
  sharedMat = m;
  return m;
}

export interface PrismArrays { pos: number[]; nor: number[]; uvs: number[]; col: number[]; idx: number[]; }
export function emptyArrays(): PrismArrays { return { pos: [], nor: [], uvs: [], col: [], idx: [] }; }

/** sRGB hex → LINEAR rgb (THREE colour management) so the LOD's per-vertex body
 *  colour matches the near mesh, whose MeshStandardMaterial decodes the same hex
 *  to linear. Feeding raw sRGB bytes as albedo (the old path) pushed the far
 *  colour brighter/greyer than its detail twin. */
function linRgb(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Append one building's prism (walls + roof cap) into shared arrays, world space.
 *  Window UVs are emitted in CELL units, SNAPPED to an integer column/storey count
 *  per wall, so the grid fits base→top and edge→edge with no clipped half-window
 *  (the "cut-off top row" artefact). Storey count uses the archetype floor height,
 *  so the far grid lines up with the near mesh's real floors. */
export function appendPrism(spec: BuildingSpec, out: PrismArrays): void {
  const poly = ensureCCW(spec.poly);
  const n = poly.length;
  const base = spec.base, top = spec.top;
  const [br, bg, bb] = linRgb(bodyColour(spec.seed, spec.archetype));
  const rr = br * 0.35 + 0.04, rg = bg * 0.35 + 0.04, rb = bb * 0.35 + 0.045; // dark roof tone
  const floorH = specFor(spec.archetype).floorH;
  const nFloors = Math.max(1, Math.round((top - base) / floorH)); // == massing floors
  const { pos, nor, uvs, col, idx } = out;
  let v0 = pos.length / 3;

  for (let e = 0; e < n; e++) {
    const [x0, z0] = poly[e];
    const [x1, z1] = poly[(e + 1) % n];
    const ex = x1 - x0, ez = z1 - z0;
    const len = Math.hypot(ex, ez) || 1e-3;
    const nx = ez / len, nz = -ex / len; // outward (CCW)
    const nCols = Math.max(1, Math.round(len / WIN_SPACING)); // snap → whole windows
    const c: [number, number, number, number, number][] = [
      [x0, base, z0, 0, 0], [x1, base, z1, nCols, 0], [x1, top, z1, nCols, nFloors], [x0, top, z0, 0, nFloors],
    ];
    for (const [px, py, pz, uu, vv] of c) { pos.push(px, py, pz); nor.push(nx, 0, nz); uvs.push(uu, vv); col.push(br, bg, bb); }
    idx.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    v0 += 4;
  }
  const tris = triangulate(poly);
  const roofStart = pos.length / 3;
  for (const [px, pz] of poly) { pos.push(px, top, pz); nor.push(0, 1, 0); uvs.push(0, 0); col.push(rr, rg, rb); }
  for (let t = 0; t + 2 < tris.length; t += 3) idx.push(roofStart + tris[t], roofStart + tris[t + 1], roofStart + tris[t + 2]);
}

/** Build a THREE geometry from accumulated arrays sharing the LOD material. */
export function geometryFrom(a: PrismArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(a.pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(a.nor), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(a.uvs), 2));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(a.col), 3));
  g.setIndex(a.idx.length > 65535 ? new THREE.BufferAttribute(new Uint32Array(a.idx), 1) : a.idx);
  g.computeBoundingSphere();
  return g;
}

export interface BuiltLOD { mesh: THREE.Mesh; triangles: number; dispose(): void; }

/** Single-building LOD mesh (used for spot checks / the demo). */
export function buildBuildingLOD(spec: BuildingSpec): BuiltLOD {
  const a = emptyArrays();
  appendPrism(spec, a);
  const g = geometryFrom(a);
  const mesh = new THREE.Mesh(g, lodMaterial());
  mesh.name = "cityGenLOD";
  mesh.castShadow = false; mesh.receiveShadow = true; mesh.frustumCulled = true;
  return { mesh, triangles: a.idx.length / 3, dispose() { g.dispose(); } };
}
