// Cheap building LOD geometry — a low-poly extruded prism (coloured body + roof
// cap) with a procedural window grid + a few lit windows. The body colour rides
// in a per-vertex `color` attribute so a WHOLE TILE of buildings shares ONE mesh
// + ONE material (see chunkLod.ts) — the far city is a couple dozen draw calls,
// not thousands. `appendPrism` is the shared primitive; buildBuildingLOD wraps it
// for a single building.
import * as THREE from "three/webgpu";
import {
  attribute, normalWorld, positionGeometry, uv, float, color, mix, step, fract,
  floor as tslFloor, hash, uniform, vec3,
} from "three/tsl";
import type { BuildingSpec } from "../core/types";
import { EXPOSURE_REBASE } from "../../../config";
import { WINDOW_GLOW_W } from "../../facade";
import { ensureCCW, triangulate } from "../core/footprint";
import { bodyColour } from "../render";
import { specFor } from "../theme/archetypes";
import { cameraCutawayMask } from "../../../render/cameraCutaway";
import { applyBirthFade, buildingGrowAmount } from "../../../render/materialize";
import {
  materialDisposeListenerCount,
  registerSharedMaterialLeakCounter,
} from "../../../render/renderObjectRegistry";

// Target window spacing; the actual grid is SNAPPED per wall (integer columns,
// integer storeys) in appendPrism, so the shader receives UVs already in "cell"
// units (1 unit = 1 window) and just reads fract()/floor() — no divide, and no
// half-window is ever clipped at a wall's top or trailing edge.
const WIN_SPACING = 2.4;   // ~metres between window centres (column target)
// self-lit body tint — MATCHES makeWallMaterial (theme/materials.ts), both
// carrying the exposure re-anchor factor (config.EXPOSURE_REBASE)
const BODY_EMISSIVE = 0.3 * EXPOSURE_REBASE;

// `lodVisibility` already costs one float per vertex. Pack the building's base
// height + a stable stagger seed into that same channel so the arrival growth
// adds zero vertex attributes/bandwidth: 0 = selectively hidden, otherwise
// floor(value) encodes base Y and fract(value) supplies the stagger key.
const LOD_BASE_OFFSET = 200;
const LOD_BASE_SCALE = 16; // 6.25 cm base precision
const LOD_BIRTH_UNSET = -1e9;
const packLodVisibility = (baseY: number, seed: number): number => {
  const baseCode = Math.max(
    1,
    Math.min(65_534, Math.round((baseY + LOD_BASE_OFFSET) * LOD_BASE_SCALE) + 1)
  );
  const stagger = ((((seed >>> 0) * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return baseCode + stagger;
};

let sharedMat: THREE.MeshStandardNodeMaterial | null = null;

// M9 leak metric: retired chunk cells must not accumulate in this shared
// material's dispose-listener array (chunkLod dispose releases them).
registerSharedMaterialLeakCounter("cityGenChunkLodBeauty", () =>
  materialDisposeListenerCount(sharedMat)
);

/** The one material every LOD building shares — per-vertex body colour with a
 *  darkened window grid + a deterministic ~30% of windows lit warm. Carries the
 *  SAME faint self-lit body tint as the near mesh's wall material so the far
 *  building reads as the same colour, not a dark olive silhouette. */
export function lodMaterial(): THREE.MeshStandardNodeMaterial {
  if (sharedMat) return sharedMat;
  // This is an exterior shell. Keeping it front-sided prevents its gray roof
  // caps from reading as a second, primitive city when the camera clips below
  // the world or enters a detailed building drawn just outside this LOD prism.
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.FrontSide });
  m.envMapIntensity = 5.5;
  // A merged chunk remains one draw call, but detailed buildings must be able to
  // punch their own prism away—otherwise its solid wall sits directly behind an
  // operable doorway. Per-vertex visibility + alpha test gives the streamer that
  // selective discard without rebuilding indices or splitting the chunk.
  m.alphaTest = 0.5;
  m.maskNode = cameraCutawayMask();
  const packedVisibility = attribute("lodVisibility", "float") as unknown as any;
  const birth = uniform(LOD_BIRTH_UNSET).onObjectUpdate(({ object }) =>
    (object?.userData.materializeBirthTime as number | undefined) ?? LOD_BIRTH_UNSET
  ) as unknown as any;
  const baseY = (tslFloor as any)(packedVisibility)
    .sub(1)
    .div(LOD_BASE_SCALE)
    .sub(LOD_BASE_OFFSET);
  const grow = buildingGrowAmount(birth, (fract as any)(packedVisibility));
  const p = positionGeometry as unknown as any;
  m.positionNode = (vec3 as any)(
    p.x,
    baseY.add(p.y.sub(baseY).mul(grow)),
    p.z
  );
  m.opacityNode = (step as any)(0.5, packedVisibility);
  const body = attribute("color", "vec3") as unknown as ReturnType<typeof color>;
  const isRoof = step(0.5, normalWorld.y.abs());
  const u = uv().x, v = uv().y;              // already in window-cell units
  const cu = fract(u), cv = fract(v);
  const inU = step(0.22, cu).mul(step(cu, 0.82));
  const inV = step(0.30, cv).mul(step(cv, 0.86));
  const winMask = inU.mul(inV).mul(float(1).sub(isRoof));
  m.colorNode = mix(body, color(new THREE.Color(0x1b1f27)), winMask);
  const cellId = tslFloor(u).add(tslFloor(v).mul(31.0));
  // lit windows gate on the sky's twilight weight, same as the near facades
  const litWin = winMask.mul(step(0.7, hash(cellId))).mul(color(new THREE.Color(0xffdca0))).mul(0.7 * EXPOSURE_REBASE).mul(WINDOW_GLOW_W);
  // faint self-lit body tint on the SOLID wall only (not the glass) so shaded
  // façades don't read near-black — the near mesh's wall material does the same.
  const bodyTint = body.mul(BODY_EMISSIVE).mul(float(1).sub(winMask));
  m.emissiveNode = bodyTint.add(litWin);
  // M5/M6: every chunk shares this exact material. `birth` is object-scoped,
  // so a cell re-shown after a far-arrival gate can fade/grow without per-cell
  // material clones; ordinary post-reveal CityGen publication leaves the
  // sentinel untouched and remains an atomic refinement of the baked city.
  applyBirthFade(m, { birth });
  sharedMat = m;
  return m;
}

export interface PrismArrays { pos: number[]; nor: number[]; uvs: number[]; col: number[]; vis: number[]; idx: number[]; }
export function emptyArrays(): PrismArrays { return { pos: [], nor: [], uvs: [], col: [], vis: [], idx: [] }; }

/** sRGB hex → LINEAR rgb (THREE colour management) so the LOD's per-vertex body
 *  colour matches the near mesh, whose MeshStandardMaterial decodes the same hex
 *  to linear. Feeding raw sRGB bytes as albedo (the old path) pushed the far
 *  colour brighter/greyer than its detail twin. */
function linRgb(hex: number): [number, number, number] {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
}

/** Optional terrain-conform override for a merged chunk building: the windowed
 *  wall + roof are emitted from `grade` (highest ground) up, and a plain
 *  foundation skirt fills `foot` (lowest ground) → `grade`. Supplied by
 *  buildChunkLOD when it was given a live ground sampler; see render/foundation.ts.
 *  When omitted, appendPrism falls back to `spec.grade`/`spec.base` exactly as before. */
export interface PrismConform { grade: number; foot: number; }

/** Append one building's prism (walls + roof cap) into shared arrays, world space.
 *  Window UVs are emitted in CELL units, SNAPPED to an integer column/storey count
 *  per wall, so the grid fits base→top and edge→edge with no clipped half-window
 *  (the "cut-off top row" artefact). Storey count uses the archetype floor height,
 *  so the far grid lines up with the near mesh's real floors. */
export function appendPrism(spec: BuildingSpec, out: PrismArrays, conform?: PrismConform): void {
  const poly = ensureCCW(spec.poly);
  const n = poly.length;
  const base = spec.base, top = spec.top;
  // grade = highest ground under the footprint (matches core/massing). Windows are
  // laid grade→top; foot→grade is a solid skirt so a sloped lot doesn't show a
  // half-buried bottom row even at LOD range. `foot` is where the wall meets the
  // ground: the baked lowest `base` for the legacy path, or the live-sampled
  // lowest ground when a `conform` override was computed from live terrain (so the
  // far chunk building neither buries its uphill windows nor floats downhill).
  const foot = conform ? conform.foot : base;
  const grade = conform
    ? Math.min(Math.max(conform.grade, foot), top - 1.5)
    : Math.min(Math.max(spec.grade ?? base, base), top - 1.5);
  const lodVisibility = packLodVisibility(foot, spec.seed);
  const [br, bg, bb] = linRgb(bodyColour(spec.seed, spec.archetype));
  // tar-and-gravel grey roof (reads from the air/hills, not black) with a faint
  // body tint so a block still varies. Rides the vertex colour → also self-lit
  // via the material's bodyTint, so it stays visible in low ambient.
  const rr = 0.28 + br * 0.10, rg = 0.27 + bg * 0.10, rb = 0.25 + bb * 0.10;
  const floorH = specFor(spec.archetype).floorH;
  const winFloors = Math.max(1, Math.round((top - grade) / floorH)); // storeys above grade
  const { pos, nor, uvs, col, vis, idx } = out;
  let v0 = pos.length / 3;
  const pushQuad = (x0: number, z0: number, y0: number, x1: number, z1: number, y1: number, nx: number, nz: number, u1: number, v1: number): void => {
    const c: [number, number, number, number, number][] = [
      [x0, y0, z0, 0, 0], [x1, y0, z1, u1, 0], [x1, y1, z1, u1, v1], [x0, y1, z0, 0, v1],
    ];
    for (const [px, py, pz, uu, vv] of c) { pos.push(px, py, pz); nor.push(nx, 0, nz); uvs.push(uu, vv); col.push(br, bg, bb); vis.push(lodVisibility); }
    // Outward winding must agree with (nx, nz). The previous inward order only
    // worked because the LOD material rendered both sides, exposing its interior.
    idx.push(v0, v0 + 2, v0 + 1, v0, v0 + 3, v0 + 2);
    v0 += 4;
  };

  for (let e = 0; e < n; e++) {
    const [x0, z0] = poly[e];
    const [x1, z1] = poly[(e + 1) % n];
    const ex = x1 - x0, ez = z1 - z0;
    const len = Math.hypot(ex, ez) || 1e-3;
    const nx = ez / len, nz = -ex / len; // outward (CCW)
    const nCols = Math.max(1, Math.round(len / WIN_SPACING)); // snap → whole windows
    // solid skirt below grade (v held at 0 → the shader draws no window band):
    // foundation from the lowest ground `foot` up to `grade`, so the far building
    // fills a sloped lot instead of floating on the downhill side.
    if (grade > foot + 0.05) pushQuad(x0, z0, foot, x1, z1, grade, nx, nz, nCols, 0);
    // windowed wall from grade up to the roof
    pushQuad(x0, z0, grade, x1, z1, top, nx, nz, nCols, winFloors);
  }
  const tris = triangulate(poly);
  const roofStart = pos.length / 3;
  for (const [px, pz] of poly) { pos.push(px, top, pz); nor.push(0, 1, 0); uvs.push(0, 0); col.push(rr, rg, rb); vis.push(lodVisibility); }
  // Footprints are CCW in XZ, which is downward-facing in Three's X/Y/Z basis;
  // reverse each cap triangle so its geometric front faces +Y like its normal.
  for (let t = 0; t + 2 < tris.length; t += 3) idx.push(roofStart + tris[t], roofStart + tris[t + 2], roofStart + tris[t + 1]);
}

/** Build a THREE geometry from accumulated arrays sharing the LOD material. */
export function geometryFrom(a: PrismArrays): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(a.pos), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(a.nor), 3));
  g.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(a.uvs), 2));
  g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(a.col), 3));
  g.setAttribute("lodVisibility", new THREE.BufferAttribute(new Float32Array(a.vis), 1));
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
