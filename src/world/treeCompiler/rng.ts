const UINT32_SCALE = 1 / 0x1_0000_0000;

export type TreeRng = {
  next(): number;
  range(min: number, max: number): number;
  integer(min: number, max: number): number;
  fork(salt: number): TreeRng;
};

function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function hash32(seed: number, salt: number): number {
  return mix32((seed >>> 0) ^ Math.imul((salt + 1) >>> 0, 0x9e3779b1));
}

export function randomUnit(seed: number, salt: number): number {
  return hash32(seed, salt) * UINT32_SCALE;
}

export function createTreeRng(seed: number): TreeRng {
  const rootSeed = mix32(seed);
  let state = rootSeed;

  const api: TreeRng = {
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) * UINT32_SCALE;
    },
    range(min, max) {
      return min + (max - min) * api.next();
    },
    integer(min, max) {
      return min + Math.floor(api.next() * (max - min + 1));
    },
    fork(salt) {
      return createTreeRng(hash32(rootSeed, salt));
    }
  };

  return api;
}

export function hashQuantizedNumbers(values: Iterable<number>, precision = 10_000): string {
  let hash = 0x811c9dc5;
  for (const value of values) {
    const quantized = Math.round(value * precision) | 0;
    hash ^= quantized & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (quantized >>> 8) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (quantized >>> 16) & 0xff;
    hash = Math.imul(hash, 0x01000193);
    hash ^= (quantized >>> 24) & 0xff;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
