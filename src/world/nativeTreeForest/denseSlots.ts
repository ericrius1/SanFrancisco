/** A live allocation whose slot indices track dense-set compaction. */
export type DenseSlotToken = Readonly<{
  indices: Uint32Array;
}>;

/** Owns a dense prefix of reusable slots and compacts survivors on release. */
export type DenseSlotAllocator = Readonly<{
  allocate(count: number): DenseSlotToken | null;
  release(token: DenseSlotToken, onMove?: (from: number, to: number) => void): boolean;
  readonly used: number;
  readonly remaining: number;
}>;

/** Creates an allocator with slots in the range [0, capacity). */
export function createDenseSlotAllocator(capacity: number): DenseSlotAllocator {
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new RangeError("Dense slot capacity must be a positive integer");
  }

  const owners: Array<DenseSlotToken | undefined> = new Array(capacity);
  const localIndices = new Uint32Array(capacity);
  const live = new Set<DenseSlotToken>();
  let size = 0;

  return {
    allocate(count: number): DenseSlotToken | null {
      if (!Number.isInteger(count) || count < 0) {
        throw new RangeError("Dense slot allocation count must be a non-negative integer");
      }
      if (count > capacity - size) return null;
      const token = { indices: new Uint32Array(count) } as DenseSlotToken;
      for (let local = 0; local < count; local++) {
        const slot = size + local;
        token.indices[local] = slot;
        owners[slot] = token;
        localIndices[slot] = local;
      }
      size += count;
      live.add(token);
      return token;
    },

    release(token: DenseSlotToken, onMove = () => undefined): boolean {
      if (!live.delete(token)) return false;
      // Process each local slot once. A swap may update a later local index,
      // including one belonging to this same allocation.
      for (let local = 0; local < token.indices.length; local++) {
        const slot = token.indices[local];
        const finalSlot = size - 1;
        if (slot !== finalSlot) {
          const moved = owners[finalSlot];
          const movedLocal = localIndices[finalSlot];
          if (moved === undefined) throw new Error("Dense slot allocator internal hole");
          owners[slot] = moved;
          localIndices[slot] = movedLocal;
          moved.indices[movedLocal] = slot;
          onMove(finalSlot, slot);
        }
        owners[finalSlot] = undefined;
        size = finalSlot;
      }
      return true;
    },

    get used(): number {
      return size;
    },

    get remaining(): number {
      return capacity - size;
    }
  };
}
