/** Sparse authored-chunk lookup for the NativeTreeForest residency ring. */
export type ResidencyDescriptor = Readonly<{
  key: string;
  cx: number;
  cz: number;
  horizontalRadius: number;
}>;

export type ResidencyCandidate<T extends ResidencyDescriptor> = Readonly<{
  descriptor: T;
  distance: number;
}>;

export type ResidencyQuery<T extends ResidencyDescriptor> = Readonly<{
  candidates: readonly ResidencyCandidate<T>[];
  /** Sparse-map probes, including empty authored cells. */
  lookups: number;
  /** Descriptors whose exact edge distance was evaluated. */
  examined: number;
}>;

type Entry<T> = Readonly<{ descriptor: T; order: number }>;

function defaultCellForKey(key: string): readonly [number, number] {
  const [x, z, ...rest] = key.split(",");
  const cellX = Number(x);
  const cellZ = Number(z);
  if (rest.length || !Number.isInteger(cellX) || !Number.isInteger(cellZ)) {
    throw new RangeError(`Native tree residency key must be integer 'x,z': ${key}`);
  }
  return [cellX, cellZ];
}

/**
 * Indexes descriptors by their authored chunk key. Query bounds account for
 * measured descriptor-center offsets and crown radii, then retain the runtime's
 * exact edge-distance test. This avoids a world-wide descriptor scan.
 */
export class NativeTreeResidencyIndex<T extends ResidencyDescriptor> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly chunkSize: number;
  private readonly cellForKey: (key: string) => readonly [number, number];
  private minOffsetX = Infinity;
  private maxOffsetX = -Infinity;
  private minOffsetZ = Infinity;
  private maxOffsetZ = -Infinity;
  private maxRadius = 0;
  private nextOrder = 0;

  constructor(chunkSize: number, cellForKey: (key: string) => readonly [number, number] = defaultCellForKey) {
    if (!Number.isFinite(chunkSize) || chunkSize <= 0) {
      throw new RangeError("Native tree residency chunkSize must be positive");
    }
    this.chunkSize = chunkSize;
    this.cellForKey = cellForKey;
  }

  add(descriptor: T): void {
    if (this.entries.has(descriptor.key)) {
      throw new Error(`Duplicate native tree residency key: ${descriptor.key}`);
    }
    const [cellX, cellZ] = this.cellForKey(descriptor.key);
    const values = [descriptor.cx, descriptor.cz, descriptor.horizontalRadius];
    if (!values.every(Number.isFinite) || descriptor.horizontalRadius < 0) {
      throw new RangeError(`Invalid native tree residency descriptor: ${descriptor.key}`);
    }
    const offsetX = descriptor.cx - cellX * this.chunkSize;
    const offsetZ = descriptor.cz - cellZ * this.chunkSize;
    this.minOffsetX = Math.min(this.minOffsetX, offsetX);
    this.maxOffsetX = Math.max(this.maxOffsetX, offsetX);
    this.minOffsetZ = Math.min(this.minOffsetZ, offsetZ);
    this.maxOffsetZ = Math.max(this.maxOffsetZ, offsetZ);
    this.maxRadius = Math.max(this.maxRadius, descriptor.horizontalRadius);
    this.entries.set(descriptor.key, { descriptor, order: this.nextOrder++ });
  }

  clear(): void {
    this.entries.clear();
    this.minOffsetX = Infinity;
    this.maxOffsetX = -Infinity;
    this.minOffsetZ = Infinity;
    this.maxOffsetZ = -Infinity;
    this.maxRadius = 0;
    this.nextOrder = 0;
  }

  collect(x: number, z: number, distance: number): ResidencyQuery<T> {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(distance) || distance < 0) {
      throw new RangeError("Native tree residency query must be finite with a non-negative distance");
    }
    if (this.entries.size === 0) return { candidates: [], lookups: 0, examined: 0 };

    const reach = distance + this.maxRadius;
    // A descriptor center can sit anywhere relative to its source cell (large
    // crowns can move a chunk sphere well outside it), so derive bounds from the
    // observed extrema rather than assuming a one-cell padding.
    const minCellX = Math.floor((x - reach - this.maxOffsetX) / this.chunkSize) - 1;
    const maxCellX = Math.floor((x + reach - this.minOffsetX) / this.chunkSize) + 1;
    const minCellZ = Math.floor((z - reach - this.maxOffsetZ) / this.chunkSize) - 1;
    const maxCellZ = Math.floor((z + reach - this.minOffsetZ) / this.chunkSize) + 1;
    const matches: Array<ResidencyCandidate<T> & { order: number }> = [];
    let lookups = 0;
    let examined = 0;
    for (let cellZ = minCellZ; cellZ <= maxCellZ; cellZ++) {
      for (let cellX = minCellX; cellX <= maxCellX; cellX++) {
        lookups++;
        const entry = this.entries.get(`${cellX},${cellZ}`);
        if (!entry) continue;
        examined++;
        const edgeDistance = Math.max(0, Math.hypot(entry.descriptor.cx - x, entry.descriptor.cz - z) - entry.descriptor.horizontalRadius);
        if (edgeDistance < distance) matches.push({ descriptor: entry.descriptor, distance: edgeDistance, order: entry.order });
      }
    }
    matches.sort((a, b) => a.distance - b.distance || a.order - b.order);
    return {
      candidates: matches.map(({ descriptor, distance: edgeDistance }) => ({ descriptor, distance: edgeDistance })),
      lookups,
      examined
    };
  }
}
