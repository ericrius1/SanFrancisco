// Grow-once native tree prototype cache shared by every park and island.
// Recipes compile in a worker; the main thread only wraps the transferred arrays
// in shared Three geometries. Materials/textures remain a separate lazy layer.

import {
  createNativeTreeArchetype,
  type NativeTreeArchetype,
  type NativeTreeControls,
  type NativeTreeSpecies
} from "../vegetation/nativeTreeRecipes";
import { createNativeTreeGeometryPrototype, type NativeTreeGeometryPrototype } from "./nativeGeometry";
import { compileTreeAsync } from "./treeCompileClient";

export type NativeTreeDesignSpec = {
  species: NativeTreeSpecies;
  seed: number;
  controls?: NativeTreeControls;
  /** Sink the trunk base this far (multiplied by slot scale) into the ground. */
  sink: number;
  /** False keeps this design in landscape LOD at every distance. */
  nearDetail?: boolean;
};

export type GrownTemplate = {
  design: NativeTreeDesignSpec;
  archetype: NativeTreeArchetype;
  geometry: NativeTreeGeometryPrototype;
  release(): void;
};

type TemplateCore = Omit<GrownTemplate, "design" | "release">;
type CacheEntry = {
  key: string;
  promise: Promise<TemplateCore>;
  refs: number;
  touched: number;
  disposed: boolean;
};

const CACHE_LIMIT = 48;
let clock = 0;
const cache = new Map<string, CacheEntry>();

function designKey(design: NativeTreeDesignSpec): string {
  return `${design.species}:${design.seed}:${JSON.stringify(design.controls ?? {})}`;
}

function disposeEntry(entry: CacheEntry): void {
  if (entry.disposed) return;
  entry.disposed = true;
  void entry.promise.then((template) => template.geometry.dispose(), () => undefined);
}

function trimCache(limit = CACHE_LIMIT): void {
  while (cache.size > limit) {
    let oldest: CacheEntry | null = null;
    for (const entry of cache.values()) {
      if (entry.refs !== 0 || entry.disposed) continue;
      if (!oldest || entry.touched < oldest.touched) oldest = entry;
    }
    if (!oldest) return;
    cache.delete(oldest.key);
    disposeEntry(oldest);
  }
}

export async function growTemplate(design: NativeTreeDesignSpec): Promise<GrownTemplate> {
  const key = designKey(design);
  let entry = cache.get(key);
  if (!entry) {
    trimCache(CACHE_LIMIT - 1);
    entry = {
      key,
      refs: 0,
      touched: ++clock,
      disposed: false,
      promise: Promise.resolve(null as unknown as TemplateCore)
    };
    entry.promise = (async () => {
      const archetype = createNativeTreeArchetype(design.species, design.controls);
      const compiled = await compileTreeAsync(archetype.recipe, design.seed);
      return { archetype, geometry: createNativeTreeGeometryPrototype(compiled) };
    })();
    cache.set(key, entry);
    entry.promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
  }

  entry.refs++;
  entry.touched = ++clock;
  let core: TemplateCore;
  try {
    core = await entry.promise;
  } catch (error) {
    entry.refs = Math.max(0, entry.refs - 1);
    throw error;
  }
  let released = false;
  return {
    design,
    ...core,
    release() {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      entry.touched = ++clock;
      trimCache();
    }
  };
}

export function nativeTreeTemplateCacheStats(): Readonly<{ entries: number; activeLeases: number }> {
  let activeLeases = 0;
  for (const entry of cache.values()) activeLeases += entry.refs;
  return Object.freeze({ entries: cache.size, activeLeases });
}
