// Pure, merged landscape geometry. Keep the few surfaces that determine a
// building's identity from flight altitude; windows stay analytic, not modules.
import type { BuildingSpec } from "../core/types";
import { ensureCCW, streetEdgeIndex, triangulate } from "../core/footprint";
import { type FacadeEdge, type Vec3, pointOnWall } from "../core/facade";
import { roofVolumes } from "../core/roof";
import { bodyColour, STRUCTURE_HEX, STRUCTURE_EMISSIVE } from "../theme/palette";
import { specFor } from "../theme/archetypes";
import { cantedBay, corniceCrown, commercialBaseTop, isLargeCommercial } from "../theme/envelope";

export interface PrismArrays { pos: number[]; nor: number[]; uvs: number[]; col: number[]; vis: number[]; idx: number[]; }
export function emptyArrays(): PrismArrays { return { pos: [], nor: [], uvs: [], col: [], vis: [], idx: [] }; }
export interface PrismConform { grade: number; foot: number; }

// Integer U offset preserves the repeating window cells while carrying a facade
// profile in the existing UV attribute; even a 10 km facade fits this stride.
export const LOD_WINDOW_STYLE_STRIDE = 4096;
export const LOD_BASE_OFFSET = 200;
export const LOD_BASE_SCALE = 16;
function packLodVisibility(baseY: number, seed: number): number {
  const baseCode = Math.max(1, Math.min(65_534, Math.round((baseY + LOD_BASE_OFFSET) * LOD_BASE_SCALE) + 1));
  const stagger = ((((seed >>> 0) * 1664525 + 1013904223) >>> 0) + 0.5) / 4294967296;
  return baseCode + stagger;
}

type RGB = readonly [number, number, number, number];
const linearColours = new Map<string, RGB>();
/** THREE's default sRGB → linear conversion, without importing the renderer. */
function linRgb(hex: number, emissive = 0.3): RGB {
  const key = `${hex}:${emissive}`;
  let rgb = linearColours.get(key);
  if (!rgb) {
    const linear = (v: number) => v < 0.04045 ? v * 0.0773993808 : Math.pow(v * 0.9478672986 + 0.0521327014, 2.4);
    rgb = [linear(((hex >>> 16) & 255) / 255), linear(((hex >>> 8) & 255) / 255), linear((hex & 255) / 255), emissive];
    linearColours.set(key, rgb);
  }
  return rgb;
}

/** Append one footprint-faithful building, including the same large roof volumes
 * and bay/cornice envelope as its detailed counterpart. All surfaces share the
 * cell material and visibility range, so detail publication remains atomic. */
export function appendPrism(spec: BuildingSpec, out: PrismArrays, conform?: PrismConform): void {
  const poly = ensureCCW(spec.poly);
  if (poly.length < 3) return;
  const { base, top } = spec;
  const foot = conform ? conform.foot : Math.min(spec.foot ?? base, base);
  const grade = conform
    ? Math.min(Math.max(conform.grade, foot), top - 1.5)
    : Math.min(Math.max(spec.grade ?? base, base), top - 1.5);
  const visibility = packLodVisibility(foot, spec.seed);
  const arch = specFor(spec.archetype);
  const body = linRgb(bodyColour(spec.seed, spec.archetype));
  const tint = (materialId: string): RGB => materialId.startsWith("wall.")
    ? body : linRgb(STRUCTURE_HEX[materialId] ?? bodyColour(spec.seed, spec.archetype), STRUCTURE_EMISSIVE[materialId] ?? 0.22);
  const roof = tint(arch.roofMaterial);
  const floors = Math.max(1, Math.round((top - grade) / arch.floorH));
  const floorH = (top - grade) / floors;
  const groundTop = grade + floorH;
  const street = streetEdgeIndex(poly, spec.streetEdge);
  const { pos, nor, uvs, col, vis, idx } = out;
  let windowProfile = 0;

  // Derive winding from the actual surface normal. The theme's box primitive
  // uses mixed frame handedness; the merged tier is front-sided throughout.
  const quad = (corners: readonly Vec3[], normal: Vec3, colour: RGB, uvRect: readonly [number, number, number, number] = [0, 0, 0, 0]) => {
    const start = pos.length / 3;
    let [u0, v0, u1, v1] = uvRect;
    // Plain surfaces don't need window UVs. Pack their authoring emissive tint
    // into negative U, retaining the existing vertex layout and one material.
    if (u0 === 0 && u1 === 0 && v0 === 0 && v1 === 0) u0 = u1 = -1 - colour[3];
    else { u0 += windowProfile * LOD_WINDOW_STYLE_STRIDE; u1 += windowProfile * LOD_WINDOW_STYLE_STRIDE; }
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      pos.push(p[0], p[1], p[2]); nor.push(normal[0], normal[1], normal[2]);
      col.push(colour[0], colour[1], colour[2]); vis.push(visibility);
      uvs.push(i === 0 || i === 3 ? u0 : u1, i < 2 ? v0 : v1);
    }
    const a = corners[0], b = corners[1], c = corners[2];
    const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
    const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
    const dot = (aby * acz - abz * acy) * normal[0]
      + (abz * acx - abx * acz) * normal[1]
      + (abx * acy - aby * acx) * normal[2];
    if (dot >= 0) idx.push(start, start + 1, start + 2, start, start + 2, start + 3);
    else idx.push(start, start + 2, start + 1, start, start + 3, start + 2);
  };
  const wall = (a: Vec3, b: Vec3, y0: number, y1: number, colour: RGB, windowUV: readonly [number, number, number, number] = [0, 0, 0, 0]) => {
    if (y1 <= y0 + 0.001) return;
    const length = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (length < 0.001) return;
    const n: Vec3 = [(b[2] - a[2]) / length, 0, (a[0] - b[0]) / length];
    quad([[a[0], y0, a[2]], [b[0], y0, b[2]], [b[0], y1, b[2]], [a[0], y1, a[2]]], n, colour, windowUV);
  };
  const box = (center: Vec3, half: Vec3, along: Vec3, normal: Vec3, colour: RGB, bottom = false) => {
    const at = (a: number, y: number, n: number): Vec3 => [center[0] + along[0] * a + normal[0] * n, center[1] + y, center[2] + along[2] * a + normal[2] * n];
    const [x, y, z] = half;
    const lf = at(-x, -y, z), rf = at(x, -y, z), rt = at(x, y, z), lt = at(-x, y, z);
    const lb = at(-x, -y, -z), rb = at(x, -y, -z), rbt = at(x, y, -z), lbt = at(-x, y, -z);
    quad([lf, rf, rt, lt], normal, colour);
    quad([lt, rt, rbt, lbt], [0, 1, 0], colour);
    if (bottom) quad([lb, rb, rf, lf], [0, -1, 0], colour);
    quad([lf, lt, lbt, lb], [-along[0], 0, -along[2]], colour);
    quad([rf, rb, rbt, rt], along, colour);
    quad([rb, lb, lbt, rbt], [-normal[0], 0, -normal[2]], colour);
  };

  for (let i = 0; i < poly.length; i++) {
    const p0 = poly[i], p1 = poly[(i + 1) % poly.length];
    const dx = p1[0] - p0[0], dz = p1[1] - p0[1], length = Math.hypot(dx, dz);
    if (length < 0.2) continue;
    const edge: FacadeEdge = {
      p0, p1, base, top, grade, floors, arch, length, along: [dx / length, dz / length],
      normal: [dz / length, -dx / length], isStreet: i === street, doorAllowed: spec.doorAllowed,
    };
    const a = pointOnWall(edge, 0, 0), b = pointOnWall(edge, 1, 0);
    const house = spec.archetype === "victorian" || spec.archetype === "edwardian";
    const large = spec.archetype === "downtown" && isLargeCommercial(edge);
    windowProfile = large ? 1 : spec.archetype === "downtown" ? 2 : spec.archetype === "soma" ? 3 : 0;
    const spacing = house ? 3.4 : spec.archetype === "marina" ? 3.0 : spec.archetype === "soma" || large ? 3.8 : 2.9;
    const cols = Math.max(1, Math.round(length / spacing));
    const baseColour = house || spec.archetype === "downtown" ? tint(large ? "lc.stone" : "base.stoop") : body;
    const baseTop = large ? commercialBaseTop(edge) : groundTop;
    const storefront = large || (edge.isStreet && ["downtown", "soma", "marina"].includes(spec.archetype));
    // Retain street glazing even for one-storey shops, while the downhill
    // foundation and residential party-wall ground bands stay solid.
    if (storefront) {
      wall(a, b, foot, grade, baseColour);
      wall(a, b, grade, baseTop, baseColour, [0, 0, Math.max(1, Math.round(length / (large ? 3.8 : 3.6))), 1]);
    } else wall(a, b, foot, baseTop, baseColour);
    const hasBay = house && edge.isStreet && (arch.bayProjection ?? 0) > 0 && floors > 1;
    if (hasBay) {
      const { wallL, frontL, frontR, wallR } = cantedBay(edge);
      // One flanking window on each side, matching the near grammar's .06–.24
      // and .76–.94 spans. Bay panes span their whole face, as in faceWindow().
      wall(a, wallL, groundTop, top, body, [0.0666667, 1, 0.9333333, floors]);
      wall(wallR, b, groundTop, top, body, [0.0666667, 1, 0.9333333, floors]);
      wall(wallL, wallR, groundTop, top, body);
      quad([[wallL[0], groundTop, wallL[2]], [frontL[0], groundTop, frontL[2]], [frontR[0], groundTop, frontR[2]], [wallR[0], groundTop, wallR[2]]], [0, -1, 0], body);
      const faces: [Vec3, Vec3][] = [[wallL, frontL], [frontL, frontR], [frontR, wallR]];
      for (const [p, q] of faces) wall(p, q, groundTop, top, body, [0.22, 1, 0.78, floors]);
      quad([[wallL[0], top, wallL[2]], [frontL[0], top, frontL[2]], [frontR[0], top, frontR[2]], [wallR[0], top, wallR[2]]], [0, 1, 0], tint(arch.trimMaterial ?? arch.wallMaterial));
    } else {
      // Chinatown currently has no authored window grammar; don't invent a grid
      // that disappears when the detailed owner replaces it.
      const firstRow = large ? Math.ceil((baseTop - grade - 0.01) / floorH) : 1;
      const windowBase = grade + firstRow * floorH;
      wall(a, b, baseTop, windowBase, body);
      wall(a, b, windowBase, top, body, spec.archetype === "chinatown" ? [0, 0, 0, 0] : [0, firstRow, cols, floors]);
    }

    let projection = 0, parapet = false, trim = arch.trimMaterial ?? "trim.edwardian";
    if (house) projection = (arch.cornice ?? 0.4) + 0.15;
    else if (spec.archetype === "marina") { projection = (arch.cornice ?? 0.3) + 0.18; trim = "roof.tileCornice"; }
    else if (spec.archetype === "soma") { projection = (arch.cornice ?? 0.2) + 0.12; parapet = true; trim = arch.wallMaterial; }
    else if (spec.archetype === "downtown") { projection = (arch.cornice ?? 0.25) + (large ? 0.35 : 0.1); parapet = !large; if (large) trim = "roof.parapet"; }
    if (projection > 0) {
      const crown = corniceCrown(edge, projection, parapet);
      const along: Vec3 = [edge.along[0], 0, edge.along[1]], normal: Vec3 = [edge.normal[0], 0, edge.normal[1]];
      // Roof-facing backs and corners remain closed: they are visible from the
      // flying camera, especially the large-commercial parapet above the cap.
      box(crown.center, crown.half, along, normal, tint(trim), true);
      if (large) {
        const center: Vec3 = [(p0[0] + p1[0]) / 2 + normal[0] * 0.06, top + 0.6, (p0[1] + p1[1]) / 2 + normal[2] * 0.06];
        box(center, [length / 2 + 0.06, 0.28, 0.16], along, normal, tint(trim), true);
        // Raised center step is a distinct silhouette, so retain its end faces.
        box([center[0], top + 1.1, center[2]], [Math.max(1.2, length * 0.18), 0.34, 0.18], along, normal, tint(trim));
      }
    }
  }

  const roofStart = pos.length / 3;
  for (const [x, z] of poly) { pos.push(x, top, z); nor.push(0, 1, 0); uvs.push(-1 - roof[3], 0); col.push(roof[0], roof[1], roof[2]); vis.push(visibility); }
  const triangles = triangulate(poly);
  for (let i = 0; i < triangles.length; i += 3) idx.push(roofStart + triangles[i], roofStart + triangles[i + 2], roofStart + triangles[i + 1]);
  if (arch.roofType === "flat") {
    for (const volume of roofVolumes(poly, top, spec.seed, arch)) {
      // Keep the stairwell and water-tank silhouette. Submetre vents are the
      // detailed tier's responsibility (and consume the same deterministic RNG).
      if (Math.max(volume.half[0], volume.half[2]) < 0.6) continue;
      box(volume.center, volume.half, [1, 0, 0], [0, 0, 1], tint(volume.materialId), !volume.skipBottom);
    }
  }
}
