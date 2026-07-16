/**
 * Shared-edge near-field terrain collider.
 *
 * The rendered terrain and WorldMap queries are height surfaces, while the old
 * stepped world represented ordinary ground as hundreds of overlapping tilted
 * boxes. Those boxes have vertical sides and independent corners, so a vehicle
 * can catch on geometry that does not exist in the height surface. This module
 * samples the canonical groundTop query onto one indexed triangle mesh instead.
 *
 * It is deliberately pure: probes can verify topology and coverage without a
 * DOM, Three.js, or Box3D. Physics owns the mesh-body lifecycle and retains the
 * box carpet only where this patch reports a hole or cannot cover a cell.
 */

export interface TerrainHeightSurface {
  groundTop(x: number, z: number): number;
}

export interface TerrainCollisionPatch {
  centerX: number;
  centerZ: number;
  halfSize: number;
  step: number;
  cells: number;
  vertices: Float32Array;
  indices: Uint32Array;
  /** One byte per `step` quad: 1 means the triangle surface intentionally stops. */
  holes: Uint8Array;
  holeCount: number;
  minY: number;
  maxY: number;
}

export interface TerrainCollisionPatchOptions {
  halfSize?: number;
  step?: number;
  /** Maximum rise over one grid edge before a quad is left to the box fallback. */
  maxEdgeRise?: number;
}

// 240 m square: the player stays within 48 m of the anchor centre, leaving
// ≥72 m of mesh beyond them before the boundary; past that the pooled box
// carpet takes over (it samples the same live CR queries). Kept this small
// because the box3d mesh cook is synchronous — at 4 m sampling this size costs
// ~4 ms per 96 m recenter; doubling the width would quadruple that spike.
export const TERRAIN_PATCH_HALF_SIZE = 120;
// The rendered ground is a Catmull-Rom reconstruction of the 8 m DEM lattice
// (terrainClipmap/WorldMap #sampleGrid), which curves BETWEEN lattice nodes.
// Sampling the patch at the lattice spacing would linearly bridge those curves
// (i.e. reproduce the retired bilinear surface, meters off in steep gullies) —
// half-lattice sampling keeps the collision surface within centimetres of the
// visible one on ordinary terrain.
export const TERRAIN_PATCH_STEP = 4;
export const TERRAIN_PATCH_SNAP = 96;
// A >45° rise at patch spacing is a cliff, seawall, bridge transition, or
// authored step rather than ordinary driveable terrain. Keep the established
// small-slab fallback there instead of manufacturing a triangle ramp across it.
export const TERRAIN_PATCH_MAX_EDGE_RISE = TERRAIN_PATCH_STEP;

export function terrainPatchAnchor(value: number, snap = TERRAIN_PATCH_SNAP): number {
  return Math.round(value / snap) * snap;
}

/** Build one local-space, upward-wound indexed triangle surface. */
export function buildTerrainCollisionPatch(
  surface: TerrainHeightSurface,
  centerX: number,
  centerZ: number,
  options: TerrainCollisionPatchOptions = {}
): TerrainCollisionPatch {
  const halfSize = options.halfSize ?? TERRAIN_PATCH_HALF_SIZE;
  const step = options.step ?? TERRAIN_PATCH_STEP;
  const maxEdgeRise = options.maxEdgeRise ?? TERRAIN_PATCH_MAX_EDGE_RISE;
  if (!(halfSize > 0) || !(step > 0) || !Number.isFinite(maxEdgeRise)) {
    throw new Error("terrain patch dimensions must be finite and positive");
  }
  const cells = Math.round((halfSize * 2) / step);
  if (cells < 1 || Math.abs(cells * step - halfSize * 2) > 1e-6) {
    throw new Error("terrain patch diameter must be an integer multiple of its step");
  }

  const row = cells + 1;
  const vertices = new Float32Array(row * row * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let gz = 0; gz <= cells; gz++) {
    const lz = -halfSize + gz * step;
    for (let gx = 0; gx <= cells; gx++) {
      const lx = -halfSize + gx * step;
      const y = surface.groundTop(centerX + lx, centerZ + lz);
      if (!Number.isFinite(y)) {
        throw new Error(`terrain patch sampled a non-finite height at ${centerX + lx}, ${centerZ + lz}`);
      }
      const i = (gz * row + gx) * 3;
      vertices[i] = lx;
      vertices[i + 1] = y;
      vertices[i + 2] = lz;
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  const holes = new Uint8Array(cells * cells);
  // Allocate the upper bound, then return the populated prefix without copying.
  const allIndices = new Uint32Array(cells * cells * 6);
  let indexCount = 0;
  let holeCount = 0;
  for (let gz = 0; gz < cells; gz++) {
    for (let gx = 0; gx < cells; gx++) {
      const a = gz * row + gx;
      const b = (gz + 1) * row + gx;
      const c = (gz + 1) * row + gx + 1;
      const d = gz * row + gx + 1;
      const ha = vertices[a * 3 + 1];
      const hb = vertices[b * 3 + 1];
      const hc = vertices[c * 3 + 1];
      const hd = vertices[d * 3 + 1];
      const unsafe =
        Math.abs(ha - hb) > maxEdgeRise ||
        Math.abs(hb - hc) > maxEdgeRise ||
        Math.abs(hc - hd) > maxEdgeRise ||
        Math.abs(hd - ha) > maxEdgeRise;
      if (unsafe) {
        holes[gz * cells + gx] = 1;
        holeCount++;
        continue;
      }
      // a→b→c and a→c→d both wind upward in the app's +X/+Y/+Z frame.
      allIndices[indexCount++] = a;
      allIndices[indexCount++] = b;
      allIndices[indexCount++] = c;
      allIndices[indexCount++] = a;
      allIndices[indexCount++] = c;
      allIndices[indexCount++] = d;
    }
  }

  return {
    centerX,
    centerZ,
    halfSize,
    step,
    cells,
    vertices,
    indices: allIndices.subarray(0, indexCount),
    holes,
    holeCount,
    minY,
    maxY
  };
}

/** True only when the complete square footprint is backed by safe patch quads. */
export function terrainPatchCovers(
  patch: TerrainCollisionPatch,
  x: number,
  z: number,
  halfExtent: number
): boolean {
  const minX = x - halfExtent - patch.centerX;
  const maxX = x + halfExtent - patch.centerX;
  const minZ = z - halfExtent - patch.centerZ;
  const maxZ = z + halfExtent - patch.centerZ;
  const eps = 1e-6;
  if (
    minX < -patch.halfSize - eps ||
    maxX > patch.halfSize + eps ||
    minZ < -patch.halfSize - eps ||
    maxZ > patch.halfSize + eps
  ) {
    return false;
  }

  const qx0 = Math.max(0, Math.floor((minX + patch.halfSize) / patch.step));
  const qx1 = Math.min(
    patch.cells - 1,
    Math.ceil((maxX + patch.halfSize) / patch.step) - 1
  );
  const qz0 = Math.max(0, Math.floor((minZ + patch.halfSize) / patch.step));
  const qz1 = Math.min(
    patch.cells - 1,
    Math.ceil((maxZ + patch.halfSize) / patch.step) - 1
  );
  for (let qz = qz0; qz <= qz1; qz++) {
    for (let qx = qx0; qx <= qx1; qx++) {
      if (patch.holes[qz * patch.cells + qx]) return false;
    }
  }
  return true;
}
