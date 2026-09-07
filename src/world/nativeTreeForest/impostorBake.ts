// Worker-only orthographic capture of the real compiler mesh. No renderer,
// network assets, sun direction or species-specific surrogate geometry is baked.
import type { CompiledTreeLod, CompiledTreeMesh, CompiledTreePrototype } from "../treeCompiler/types";

export const TREE_IMPOSTOR_YAWS = 16;
export const TREE_IMPOSTOR_ELEVATIONS = 7;
export const TREE_IMPOSTOR_TILE = 48;
export const TREE_IMPOSTOR_HULL_PLANES = 12;
const SUPERSAMPLE = 2;
export const TREE_IMPOSTOR_PADDING = 2;
const PADDING = TREE_IMPOSTOR_PADDING;

export type CompiledTreeImpostor = {
  width: number;
  height: number;
  /** RG = octahedral normal; B = foliage bit + 7-bit palette; A = coverage. */
  color: Uint8Array;
  /** Conservative silhouette support planes per elevation, enclosing all yaws. */
  hulls: Float32Array;
  foliageOpening: number;
  center: readonly [number, number, number];
  /** Horizontal diameter and vertical extent, before capture padding. */
  size: readonly [number, number];
};
export type CompiledImpostorTree = CompiledTreePrototype & { impostor: CompiledTreeImpostor };

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));
const byte = (x: number): number => Math.round(clamp01(x) * 255);

/** Atlas frames run left-to-right by yaw and bottom-to-top by elevation. */
export function bakeTreeImpostor(lod: CompiledTreeLod): CompiledTreeImpostor {
  const tile = TREE_IMPOSTOR_TILE;
  const resolution = tile * SUPERSAMPLE;
  const width = tile * TREE_IMPOSTOR_YAWS;
  const height = tile * TREE_IMPOSTOR_ELEVATIONS;
  const color = new Uint8Array(width * height * 4);
  const normal = new Uint8Array(width * height * 4);
  const b = lod.bounds;
  const center = b.min.map((x, i) => (x + b.max[i]) * 0.5) as [number, number, number];
  // Actual vertex radius, not the AABB diagonal: a slender redwood should not
  // spend most of its quad rasterizing empty pixels.
  let radius = 0;
  for (const mesh of [lod.branch, lod.foliage]) {
    for (let i = 0; i < mesh.vertices.length; i += mesh.vertexStrideFloats) {
      radius = Math.max(radius, Math.hypot(mesh.vertices[i] - center[0], mesh.vertices[i + 2] - center[2]));
    }
  }
  const diameter = Math.max(radius * 2, 0.01);
  const treeHeight = Math.max(b.max[1] - b.min[1], 0.01);
  const foliage = lod.foliage.bounds;
  const crownCenter = foliage.min.map((x, i) => (x + foliage.max[i]) * 0.5);
  const crownRadii = foliage.min.map((x, i) => Math.max(0.01, (foliage.max[i] - x) * 0.5));
  const depth = new Float32Array(resolution * resolution);
  const pixels = new Float32Array(resolution * resolution * 6);
  const area = (tile - PADDING * 2) * SUPERSAMPLE;
  const pad = PADDING * SUPERSAMPLE;

  for (let elevation = 0; elevation < TREE_IMPOSTOR_ELEVATIONS; elevation++) {
    const pitch = elevation / (TREE_IMPOSTOR_ELEVATIONS - 1) * Math.PI * 0.5;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const projectedHeight = treeHeight * cp + diameter * sp;
    for (let yaw = 0; yaw < TREE_IMPOSTOR_YAWS; yaw++) {
      const angle = yaw / TREE_IMPOSTOR_YAWS * Math.PI * 2;
      const sy = Math.sin(angle), cy = Math.cos(angle);
      depth.fill(-Infinity);
      pixels.fill(0);
      const rasterize = (mesh: CompiledTreeMesh, isFoliage: boolean): void => {
        const stride = mesh.vertexStrideFloats;
        const materialOffset = mesh.attributes.find((a) => a.semantic === "material")?.offsetFloats ?? 0;
        const windOffset = mesh.attributes.find((a) => a.semantic === "wind")?.offsetFloats ?? 0;
        const anchorOffset = mesh.attributes.find((a) => a.semantic === "anchor")?.offsetFloats ?? 0;
        // xyz screen/depth; normal xyz; palette and ambient opening.
        const vertexCount = mesh.vertices.length / stride;
        const projected = new Float32Array(vertexCount * 8);
        for (let i = 0; i < vertexCount; i++) {
          const s = i * stride, p = i * 8;
          const x = mesh.vertices[s] - center[0];
          const y = mesh.vertices[s + 1] - center[1];
          const z = mesh.vertices[s + 2] - center[2];
          projected[p] = (x * cy - z * sy) / diameter * area + area * 0.5 + pad;
          projected[p + 1] = (-x * sy * sp + y * cp - z * cy * sp) / projectedHeight * area + area * 0.5 + pad;
          projected[p + 2] = x * sy * cp + y * sp + z * cy * cp;
          let nx = mesh.vertices[s + 3], ny = mesh.vertices[s + 4], nz = mesh.vertices[s + 5];
          if (isFoliage) {
            let dx = (mesh.vertices[s + anchorOffset] - crownCenter[0]) / (crownRadii[0] ** 2);
            let dy = (mesh.vertices[s + anchorOffset + 1] - crownCenter[1]) / (crownRadii[1] ** 2);
            let dz = (mesh.vertices[s + anchorOffset + 2] - crownCenter[2]) / (crownRadii[2] ** 2);
            const dl = Math.hypot(dx, dy, dz) || 1;
            dx /= dl; dy = dy / dl + 0.35; dz /= dl;
            const domeLength = Math.hypot(dx, dy, dz) || 1;
            nx = nx * 0.28 + dx / domeLength * 0.72;
            ny = ny * 0.28 + dy / domeLength * 0.72;
            nz = nz * 0.28 + dz / domeLength * 0.72;
          }
          const nl = Math.hypot(nx, ny, nz) || 1;
          projected[p + 3] = nx / nl;
          projected[p + 4] = ny / nl;
          projected[p + 5] = nz / nl;
          projected[p + 6] = isFoliage ? mesh.vertices[s + materialOffset]
            : clamp01(mesh.vertices[s + windOffset + 3] * 0.44 + mesh.vertices[s + windOffset + 2] * 0.16);
          projected[p + 7] = isFoliage ? clamp01(mesh.vertices[s + materialOffset + 1]) * 0.3 + 0.7 : 1;
        }
        for (let t = 0; t < mesh.indices.length; t += 3) {
          const a = mesh.indices[t] * 8, b = mesh.indices[t + 1] * 8, c = mesh.indices[t + 2] * 8;
          const ax = projected[a], ay = projected[a + 1], bx = projected[b], by = projected[b + 1], cx = projected[c], cy = projected[c + 1];
          const denominator = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
          if (Math.abs(denominator) < 1e-8) continue;
          const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
          const maxX = Math.min(resolution - 1, Math.ceil(Math.max(ax, bx, cx)));
          const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
          const maxY = Math.min(resolution - 1, Math.ceil(Math.max(ay, by, cy)));
          for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
            const wa = ((by - cy) * (x + 0.5 - cx) + (cx - bx) * (y + 0.5 - cy)) / denominator;
            const wb = ((cy - ay) * (x + 0.5 - cx) + (ax - cx) * (y + 0.5 - cy)) / denominator;
            const wc = 1 - wa - wb;
            if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
            const offset = y * resolution + x;
            const z = projected[a + 2] * wa + projected[b + 2] * wb + projected[c + 2] * wc;
            if (z <= depth[offset]) continue;
            depth[offset] = z;
            const p = offset * 6;
            pixels[p] = isFoliage ? 1 : 0;
            pixels[p + 1] = projected[a + 6] * wa + projected[b + 6] * wb + projected[c + 6] * wc;
            pixels[p + 2] = projected[a + 7] * wa + projected[b + 7] * wb + projected[c + 7] * wc;
            for (let n = 0; n < 3; n++) pixels[p + 3 + n] = projected[a + 3 + n] * wa + projected[b + 3 + n] * wb + projected[c + 3 + n] * wc;
          }
        }
      };
      rasterize(lod.branch, false);
      rasterize(lod.foliage, true);
      for (let y = 0; y < tile; y++) for (let x = 0; x < tile; x++) {
        const sums = [0, 0, 0, 0, 0, 0];
        let coverage = 0;
        for (let dy = 0; dy < SUPERSAMPLE; dy++) for (let dx = 0; dx < SUPERSAMPLE; dx++) {
          const s = (y * SUPERSAMPLE + dy) * resolution + x * SUPERSAMPLE + dx;
          if (!Number.isFinite(depth[s])) continue;
          coverage++;
          for (let n = 0; n < 6; n++) sums[n] += pixels[s * 6 + n];
        }
        if (!coverage) continue;
        const out = ((elevation * tile + y) * width + yaw * tile + x) * 4;
        for (let n = 0; n < 3; n++) color[out + n] = byte(sums[n] / coverage);
        color[out + 3] = byte(coverage / (SUPERSAMPLE * SUPERSAMPLE));
        const nl = Math.hypot(sums[3], sums[4], sums[5]) || 1;
        for (let n = 0; n < 3; n++) normal[out + n] = byte(sums[n + 3] / nl * 0.5 + 0.5);
        normal[out + 3] = 255;
      }
    }
  }
  // Dilate attributes (never coverage) into transparent texels. Bilinear reads
  // at the silhouette then retain the leaf's colour and a unit lighting normal.
  for (let pass = 0; pass < 2; pass++) {
    const old = normal.slice();
    for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
      const i = (y * width + x) * 4;
      if (old[i + 3]) continue;
      for (const neighbor of [i - 4, i + 4, i - width * 4, i + width * 4]) {
        if (!old[neighbor + 3]) continue;
        color.set(color.subarray(neighbor, neighbor + 3), i);
        normal.set(old.subarray(neighbor, neighbor + 4), i);
        break;
      }
    }
  }
  const packed = new Uint8Array(color.length);
  const hulls = new Float32Array(TREE_IMPOSTOR_ELEVATIONS * TREE_IMPOSTOR_HULL_PLANES);
  hulls.fill(-Infinity);
  let openingSum = 0, openingWeight = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (normal[i + 3]) {
      let nx = normal[i] / 255 * 2 - 1, ny = normal[i + 1] / 255 * 2 - 1;
      const nz = normal[i + 2] / 255 * 2 - 1;
      const scale = Math.abs(nx) + Math.abs(ny) + Math.abs(nz) || 1;
      nx /= scale; ny /= scale;
      const ox = nz >= 0 ? nx : (1 - Math.abs(ny)) * (nx >= 0 ? 1 : -1);
      const oy = nz >= 0 ? ny : (1 - Math.abs(nx)) * (ny >= 0 ? 1 : -1);
      packed[i] = byte(ox * 0.5 + 0.5);
      packed[i + 1] = byte(oy * 0.5 + 0.5);
      packed[i + 2] = (color[i] >= 128 ? 128 : 0) + Math.round(color[i + 1] / 255 * 127);
    }
    const coverage = color[i + 3];
    packed[i + 3] = coverage;
    if (!coverage) continue;
    if (color[i] >= 128) {
      openingSum += color[i + 2] / 255 * coverage;
      openingWeight += coverage;
    }
    const row = Math.floor(y / tile);
    const hx = ((x % tile) + 0.5) / tile - 0.5;
    const hy = ((y % tile) + 0.5) / tile - 0.5;
    for (let plane = 0; plane < TREE_IMPOSTOR_HULL_PLANES; plane++) {
      const angle = plane / TREE_IMPOSTOR_HULL_PLANES * Math.PI * 2;
      // A full extra texel includes bilinear coverage around the outer samples.
      const support = hx * Math.cos(angle) + hy * Math.sin(angle) + 1 / tile;
      const target = row * TREE_IMPOSTOR_HULL_PLANES + plane;
      hulls[target] = Math.max(hulls[target], support);
    }
  }
  for (let i = 0; i < hulls.length; i++) if (!Number.isFinite(hulls[i])) hulls[i] = 0.5;
  return { width, height, color: packed, hulls, foliageOpening: openingSum / (openingWeight || 1), center, size: [diameter, treeHeight] };
}
