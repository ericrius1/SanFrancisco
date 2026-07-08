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

const STOREY = 3.4;
const WIN_SPACING = 2.4;

let sharedMat: THREE.MeshStandardNodeMaterial | null = null;

/** The one material every LOD building shares — per-vertex body colour with a
 *  darkened window grid (UV: u = metres along wall, v = world height) and a
 *  deterministic ~30% of windows lit warm. */
export function lodMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedMat) return sharedMat;
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  m.envMapIntensity = 5.5;
  const body = attribute("color", "vec3") as unknown as ReturnType<typeof color>;
  const isRoof = step(0.5, normalWorld.y.abs());
  const u = uv().x, v = uv().y;
  const inU = step(0.22, fract(u.div(WIN_SPACING))).mul(step(fract(u.div(WIN_SPACING)), 0.82));
  const inV = step(0.30, fract(v.div(STOREY))).mul(step(fract(v.div(STOREY)), 0.86));
  const winMask = inU.mul(inV).mul(float(1).sub(isRoof));
  m.colorNode = mix(body, color(new THREE.Color(0x1b1f27)), winMask);
  const cellId = tslFloor(u.div(WIN_SPACING)).add(tslFloor(v.div(STOREY)).mul(31.0));
  m.emissiveNode = winMask.mul(step(0.7, hash(cellId))).mul(color(new THREE.Color(0xffdca0))).mul(0.7);
  sharedMat = m;
  return m;
}

export interface PrismArrays { pos: number[]; nor: number[]; uvs: number[]; col: number[]; idx: number[]; }
export function emptyArrays(): PrismArrays { return { pos: [], nor: [], uvs: [], col: [], idx: [] }; }

function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

/** Append one building's prism (walls + roof cap) into shared arrays, world space. */
export function appendPrism(spec: BuildingSpec, out: PrismArrays): void {
  const poly = ensureCCW(spec.poly);
  const n = poly.length;
  const base = spec.base, top = spec.top;
  const [br, bg, bb] = hexToRgb(bodyColour(spec.seed, spec.archetype));
  const rr = br * 0.35 + 0.12, rg = bg * 0.35 + 0.12, rb = bb * 0.35 + 0.13; // dark roof tone
  const { pos, nor, uvs, col, idx } = out;
  let v0 = pos.length / 3;

  for (let e = 0; e < n; e++) {
    const [x0, z0] = poly[e];
    const [x1, z1] = poly[(e + 1) % n];
    const ex = x1 - x0, ez = z1 - z0;
    const len = Math.hypot(ex, ez) || 1e-3;
    const nx = ez / len, nz = -ex / len; // outward (CCW)
    const c: [number, number, number, number, number][] = [
      [x0, base, z0, 0, base], [x1, base, z1, len, base], [x1, top, z1, len, top], [x0, top, z0, 0, top],
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
