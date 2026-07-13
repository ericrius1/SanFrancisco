import * as THREE from "three/webgpu";
import { requireRenderer } from "../../app/rendererRegistry";

const MANIFEST_URL = "/native-foliage/manifest.json";
const MATERIAL_CACHE_LIMIT = 16;
const TEXTURE_CACHE_LIMIT = 64;
const KTX2_WORKER_LIMIT = 2;
const MAX_ANISOTROPY = 8;
const BASIS_TRANSCODER_PATH = "/native-foliage/basis-r185/";

export type NativeTreeLeafStyle = Readonly<{
  alphaCutoff: number;
  translucency: number;
  twoSided: boolean;
}>;

export type NativeTreeMaterialAssets = Readonly<{
  /** Canonical manifest key (normally the native species id). */
  id: string;
  /** Requested key before native alias resolution. */
  requestedId: string;
  leafStyle: NativeTreeLeafStyle;
  leafColor: THREE.Texture;
  leafSurface: THREE.Texture;
  barkColor: THREE.Texture;
  barkSurface: THREE.Texture;
  /** True when any missing asset was replaced with a deterministic 1x1 map. */
  fallback: boolean;
  errors: readonly string[];
}>;

export type NativeTreeMaterialSetOptions = Readonly<{
  /** Optional manifest leaf color variant such as `autumn` or `blossom`. */
  leafColorVariant?: string;
  /** Silhouette stays procedural/network-free; full loads the four KTX2 maps. */
  detail?: "silhouette" | "full";
}>;

type ManifestTexture = {
  uri: string;
  colorSpace?: "srgb" | "linear";
};

type ManifestMaterialSet = {
  leafStyle: NativeTreeLeafStyle;
  textures: {
    leaf: {
      color: ManifestTexture;
      surface: ManifestTexture;
      colorVariants?: Record<string, ManifestTexture>;
    };
    bark: {
      color: ManifestTexture;
      surface: ManifestTexture;
    };
  };
};

type NativeFoliageManifest = {
  schemaVersion: number;
  aliases?: {
    native?: Record<string, string>;
  };
  materialSets: Record<string, ManifestMaterialSet>;
};

type TextureRole = "leaf-color" | "leaf-surface" | "bark-color" | "bark-surface";

type TextureLease = {
  texture: Promise<THREE.Texture>;
  release(): void;
};

type TextureCacheEntry = {
  uri: string;
  role: TextureRole;
  promise: Promise<THREE.Texture>;
  refs: number;
  touched: number;
  cached: boolean;
  released: boolean;
};

type MaterialCacheEntry = {
  key: string;
  refs: number;
  touched: number;
  cached: boolean;
  released: boolean;
  promise: Promise<NativeTreeMaterialAssets>;
  textureLeases: TextureLease[];
};

const DEFAULT_LEAF_STYLE: NativeTreeLeafStyle = Object.freeze({
  alphaCutoff: 0.42,
  translucency: 0.58,
  twoSided: true
});

// These are deliberately only safety aliases. Runtime callers should pass the
// species id so each tree keeps its own art-directed material set.
const FAMILY_FALLBACKS: Readonly<Record<string, string>> = Object.freeze({
  "conifer-needle": "coast-redwood",
  broadleaf: "coast-live-oak",
  "fan-leaf": "ginkgo",
  blossom: "flowering-cherry",
  "palm-frond": "chilean-palm"
});

let clock = 0;
let manifestPromise: Promise<NativeFoliageManifest> | null = null;
let loaderPromise: Promise<import("three/addons/loaders/KTX2Loader.js").KTX2Loader> | null = null;
let rendererAnisotropy = 1;
const warned = new Set<string>();
const textureCache = new Map<string, TextureCacheEntry>();
const materialCache = new Map<string, MaterialCacheEntry>();
const assetOwners = new WeakMap<NativeTreeMaterialAssets, MaterialCacheEntry>();

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[native foliage] ${message}`);
}

function createFallbackTexture(role: TextureRole): THREE.DataTexture {
  const pixels = role === "leaf-color"
    ? [255, 255, 255, 255]
    : role === "bark-color"
      ? [214, 203, 188, 255]
      : role === "leaf-surface"
        ? [128, 128, 204, 158]
        : [128, 128, 224, 255];
  const texture = new THREE.DataTexture(new Uint8Array(pixels), 1, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  configureTexture(texture, role);
  texture.name = `native-tree-fallback:${role}`;
  return texture;
}

const fallbackTextures: Record<TextureRole, THREE.Texture> = {
  "leaf-color": createFallbackTexture("leaf-color"),
  "leaf-surface": createFallbackTexture("leaf-surface"),
  "bark-color": createFallbackTexture("bark-color"),
  "bark-surface": createFallbackTexture("bark-surface")
};

function configureTexture(texture: THREE.Texture, role: TextureRole): THREE.Texture {
  const colorTexture = role.endsWith("color");
  const barkTexture = role.startsWith("bark");
  texture.colorSpace = colorTexture ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  texture.wrapS = barkTexture ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.wrapT = barkTexture ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  texture.repeat.set(1, 1);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.anisotropy = Math.max(1, Math.min(MAX_ANISOTROPY, rendererAnisotropy));
  texture.needsUpdate = true;
  return texture;
}

async function getKtx2Loader(): Promise<import("three/addons/loaders/KTX2Loader.js").KTX2Loader> {
  if (!loaderPromise) {
    // This function is never evaluated at module import. The renderer registry
    // is consulted only when a forest asks for its first native material set.
    const renderer = requireRenderer();
    rendererAnisotropy = Math.max(1, renderer.getMaxAnisotropy());
    loaderPromise = import("three/addons/loaders/KTX2Loader.js").then(({ KTX2Loader }) => {
      const loader = new KTX2Loader();
      // Pin the worker runtime to the matching Three release. Relying on the
      // lazy module URL makes Vite dev resolve this into an HTML fallback.
      loader.setTranscoderPath(BASIS_TRANSCODER_PATH);
      loader.setWorkerLimit(KTX2_WORKER_LIMIT);
      loader.detectSupport(renderer);
      return loader;
    });
  }
  return loaderPromise;
}

async function getManifest(): Promise<NativeFoliageManifest> {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { credentials: "same-origin" }).then(async (response) => {
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const manifest = await response.json() as NativeFoliageManifest;
      if (manifest.schemaVersion !== 1 || !manifest.materialSets) {
        throw new Error(`unsupported manifest schema ${String(manifest.schemaVersion)}`);
      }
      return manifest;
    });
  }
  return manifestPromise;
}

function evictOneUnusedTexture(): boolean {
  let oldest: TextureCacheEntry | null = null;
  for (const entry of textureCache.values()) {
    if (entry.refs !== 0 || entry.released) continue;
    if (!oldest || entry.touched < oldest.touched) oldest = entry;
  }
  if (!oldest) return false;
  textureCache.delete(oldest.uri);
  oldest.released = true;
  void oldest.promise.then((texture) => {
    if (!Object.values(fallbackTextures).includes(texture)) texture.dispose();
  });
  return true;
}

function acquireTexture(uri: string, role: TextureRole, errors: string[]): TextureLease {
  const existing = textureCache.get(uri);
  if (existing) {
    existing.refs++;
    existing.touched = ++clock;
    return textureLease(existing);
  }

  while (textureCache.size >= TEXTURE_CACHE_LIMIT && evictOneUnusedTexture()) {
    // Continue only if stale duplicate/variant maps filled more than one slot.
  }

  const cached = textureCache.size < TEXTURE_CACHE_LIMIT;
  const entry: TextureCacheEntry = {
    uri,
    role,
    refs: 1,
    touched: ++clock,
    cached,
    released: false,
    promise: getKtx2Loader()
      .then((loader) => loader.loadAsync(uri))
      .then((texture) => configureTexture(texture, role))
      .catch((error: unknown) => {
        const detail = `${uri}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(detail);
        warnOnce(uri, `using ${role} fallback after KTX2 load failed (${detail})`);
        return fallbackTextures[role];
      })
  };
  if (cached) textureCache.set(uri, entry);
  return textureLease(entry);
}

function textureLease(entry: TextureCacheEntry): TextureLease {
  let released = false;
  return {
    texture: entry.promise,
    release(): void {
      if (released) return;
      released = true;
      entry.refs = Math.max(0, entry.refs - 1);
      entry.touched = ++clock;
      if (!entry.cached && entry.refs === 0 && !entry.released) {
        entry.released = true;
        void entry.promise.then((texture) => {
          if (!Object.values(fallbackTextures).includes(texture)) texture.dispose();
        });
      }
    }
  };
}

function resolveSetId(manifest: NativeFoliageManifest, requestedId: string): string {
  const familyFallback = FAMILY_FALLBACKS[requestedId];
  return manifest.aliases?.native?.[requestedId]
    ?? familyFallback
    ?? requestedId;
}

async function createMaterialAssets(
  requestedId: string,
  options: NativeTreeMaterialSetOptions,
  owner: MaterialCacheEntry
): Promise<NativeTreeMaterialAssets> {
  const errors: string[] = [];
  if (options.detail === "silhouette") {
    // Landscape/horizon materials use the compiler's opaque leaf geometry and
    // recipe palette. They need neither the manifest nor a transcoder worker;
    // close tiers replace this pack with the full species KTX2 set on demand.
    return Object.freeze({
      id: requestedId,
      requestedId,
      leafStyle: DEFAULT_LEAF_STYLE,
      leafColor: fallbackTextures["leaf-color"],
      leafSurface: fallbackTextures["leaf-surface"],
      barkColor: fallbackTextures["bark-color"],
      barkSurface: fallbackTextures["bark-surface"],
      fallback: false,
      errors: Object.freeze([])
    });
  }
  let manifest: NativeFoliageManifest;
  try {
    // Begin loader feature detection and the one manifest request in parallel.
    // Neither starts until this first-use function is called.
    const [, loadedManifest] = await Promise.all([getKtx2Loader(), getManifest()]);
    manifest = loadedManifest;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    errors.push(`${MANIFEST_URL}: ${detail}`);
    warnOnce(MANIFEST_URL, `using procedural tree materials because the native manifest could not load (${detail})`);
    return fallbackAssets(requestedId, errors);
  }

  const id = resolveSetId(manifest, requestedId);
  const set = manifest.materialSets[id];
  if (!set) {
    const detail = `material set \"${requestedId}\" resolved to missing key \"${id}\"`;
    errors.push(detail);
    warnOnce(`set:${requestedId}`, `${detail}; using procedural tree materials`);
    return fallbackAssets(requestedId, errors, id);
  }

  const leafColorEntry = options.leafColorVariant
    ? set.textures.leaf.colorVariants?.[options.leafColorVariant] ?? set.textures.leaf.color
    : set.textures.leaf.color;
  if (options.leafColorVariant && !set.textures.leaf.colorVariants?.[options.leafColorVariant]) {
    const detail = `leaf variant \"${options.leafColorVariant}\" is not present in ${id}`;
    errors.push(detail);
    warnOnce(`variant:${id}:${options.leafColorVariant}`, `${detail}; using the default leaf color`);
  }

  const requests: readonly [ManifestTexture, TextureRole][] = [
    [leafColorEntry, "leaf-color"],
    [set.textures.leaf.surface, "leaf-surface"],
    [set.textures.bark.color, "bark-color"],
    [set.textures.bark.surface, "bark-surface"]
  ];
  owner.textureLeases = requests.map(([entry, role]) => acquireTexture(entry.uri, role, errors));
  const loadedTextures = await Promise.all(
    owner.textureLeases.map((lease) => lease.texture)
  );
  let leafColor = fallbackTextures["leaf-color"];
  let leafSurface = fallbackTextures["leaf-surface"];
  let barkColor = fallbackTextures["bark-color"];
  let barkSurface = fallbackTextures["bark-surface"];
  for (let index = 0; index < requests.length; index++) {
    const role = requests[index][1];
    const loaded = loadedTextures[index];
    if (role === "leaf-color") leafColor = loaded;
    else if (role === "leaf-surface") leafSurface = loaded;
    else if (role === "bark-color") barkColor = loaded;
    else barkSurface = loaded;
  }

  return Object.freeze({
    id,
    requestedId,
    leafStyle: set.leafStyle,
    leafColor,
    leafSurface,
    barkColor,
    barkSurface,
    fallback: errors.some((message) => message.includes(".ktx2")),
    errors: Object.freeze(errors.slice())
  });
}

function fallbackAssets(requestedId: string, errors: string[], resolvedId = requestedId): NativeTreeMaterialAssets {
  return Object.freeze({
    id: resolvedId,
    requestedId,
    leafStyle: DEFAULT_LEAF_STYLE,
    leafColor: fallbackTextures["leaf-color"],
    leafSurface: fallbackTextures["leaf-surface"],
    barkColor: fallbackTextures["bark-color"],
    barkSurface: fallbackTextures["bark-surface"],
    fallback: true,
    errors: Object.freeze(errors.slice())
  });
}

function evictOneUnusedMaterial(): boolean {
  let oldest: MaterialCacheEntry | null = null;
  for (const entry of materialCache.values()) {
    if (entry.refs !== 0 || entry.released) continue;
    if (!oldest || entry.touched < oldest.touched) oldest = entry;
  }
  if (!oldest) return false;
  materialCache.delete(oldest.key);
  disposeMaterialEntry(oldest);
  return true;
}

function disposeMaterialEntry(entry: MaterialCacheEntry): void {
  if (entry.released) return;
  entry.released = true;
  for (const lease of entry.textureLeases) lease.release();
  entry.textureLeases.length = 0;
}

/**
 * Acquires one species/material pack. Calls are promise-deduplicated; callers
 * must pair each successful call with `releaseNativeTreeMaterialSet(assets)`.
 * The bounded cache retains recently released packs for fast nearby re-entry.
 */
export async function loadNativeTreeMaterialSet(
  requestedId: string,
  options: NativeTreeMaterialSetOptions = {}
): Promise<NativeTreeMaterialAssets> {
  const silhouetteOnly = options.detail === "silhouette";
  // Kick renderer feature detection immediately for a real texture request.
  // The geometric silhouette tier intentionally stays network-free.
  if (!silhouetteOnly) void getKtx2Loader().catch(() => undefined);
  let cacheId = requestedId;
  if (!silhouetteOnly) {
    try {
      // Canonicalizing before the cache lookup makes native aliases share the
      // same material-set promise, not just the same texture promises.
      cacheId = resolveSetId(await getManifest(), requestedId);
    } catch {
      // createMaterialAssets records the actionable error and returns fallbacks.
    }
  }
  const key = `${MANIFEST_URL}#${cacheId}:${options.leafColorVariant ?? "default"}:${options.detail ?? "full"}`;
  const existing = materialCache.get(key);
  if (existing) {
    existing.refs++;
    existing.touched = ++clock;
    return existing.promise;
  }

  while (materialCache.size >= MATERIAL_CACHE_LIMIT && evictOneUnusedMaterial()) {
    // Evict enough inactive packs to keep the retained session cache bounded.
  }
  const cached = materialCache.size < MATERIAL_CACHE_LIMIT;
  const entry = {
    key,
    refs: 1,
    touched: ++clock,
    cached,
    released: false,
    promise: Promise.resolve(null as unknown as NativeTreeMaterialAssets),
    textureLeases: []
  } satisfies MaterialCacheEntry;
  entry.promise = createMaterialAssets(requestedId, options, entry).then((assets) => {
    assetOwners.set(assets, entry);
    return assets;
  });
  if (cached) materialCache.set(key, entry);
  return entry.promise;
}

export function releaseNativeTreeMaterialSet(assets: NativeTreeMaterialAssets): void {
  const entry = assetOwners.get(assets);
  if (!entry || entry.released) return;
  entry.refs = Math.max(0, entry.refs - 1);
  entry.touched = ++clock;
  if (!entry.cached && entry.refs === 0) disposeMaterialEntry(entry);
}

/** App/HMR teardown hook. Do not call while live forests still own packs. */
export async function clearNativeTreeAssetCache(): Promise<void> {
  const entries = [...materialCache.values()];
  materialCache.clear();
  await Promise.all(entries.map((entry) => entry.promise));
  for (const entry of entries) disposeMaterialEntry(entry);

  const textures = [...textureCache.values()];
  textureCache.clear();
  await Promise.all(textures.map(async (entry) => {
    entry.released = true;
    const texture = await entry.promise;
    if (!Object.values(fallbackTextures).includes(texture)) texture.dispose();
  }));

  if (loaderPromise) (await loaderPromise).dispose();
  loaderPromise = null;
  manifestPromise = null;
  warned.clear();
}

export function nativeTreeAssetCacheStats(): Readonly<{
  materialSets: number;
  textures: number;
  activeMaterialLeases: number;
}> {
  let activeMaterialLeases = 0;
  for (const entry of materialCache.values()) activeMaterialLeases += entry.refs;
  return Object.freeze({
    materialSets: materialCache.size,
    textures: textureCache.size,
    activeMaterialLeases
  });
}
