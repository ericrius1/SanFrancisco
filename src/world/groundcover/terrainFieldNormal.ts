/**
 * Late-bound bridge to the terrain clipmap's prefiltered world-space normal
 * field. Groundcover materials build after the clipmap exists (regions are
 * deferred behind boot), but groundcover cannot import the tile streamer
 * without a cycle — so the streamer registers the field factory here and
 * blade/ground materials pick it up at build time. Standalone contexts
 * (probes, portable garden demos) simply see null and keep their authored
 * normals.
 */

type FieldNormalFactory = (worldXZ: unknown) => unknown;

let factory: FieldNormalFactory | null = null;

export function registerTerrainFieldNormal(f: FieldNormalFactory): void {
  factory = f;
}

/** World-space terrain normal node at `worldXZ`, or null before registration. */
export function terrainFieldNormal(worldXZ: unknown): unknown | null {
  return factory ? factory(worldXZ) : null;
}
