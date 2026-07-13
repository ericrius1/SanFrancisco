import {
  SURFBOARD_DECALS,
  SURFBOARD_SURFACES,
  normalizeSurfboardConfig,
  type SurfboardConfig,
  type SurfboardDecal,
  type SurfboardSurface
} from "./config";

type AssetRecord = {
  image: HTMLImageElement | null;
  promise: Promise<HTMLImageElement | null>;
};

const cache = new Map<string, AssetRecord>();

export function surfboardSurfaceAsset(id: SurfboardSurface) {
  return SURFBOARD_SURFACES.find((entry) => entry.id === id) ?? SURFBOARD_SURFACES[0];
}

export function surfboardDecalAsset(id: SurfboardDecal) {
  return SURFBOARD_DECALS.find((entry) => entry.id === id) ?? SURFBOARD_DECALS[0];
}

function requestImage(url: string): AssetRecord {
  const cached = cache.get(url);
  if (cached) return cached;

  const record: AssetRecord = {
    image: null,
    promise: Promise.resolve(null)
  };
  record.promise = new Promise<HTMLImageElement | null>((resolve) => {
    if (typeof Image === "undefined") {
      resolve(null);
      return;
    }
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      record.image = image;
      resolve(image);
    };
    // Missing optional art should leave the authored fallback visible, not turn
    // boot or a remote player's embodiment into an unhandled rejection.
    image.onerror = () => resolve(null);
    image.src = url;
  });
  cache.set(url, record);
  return record;
}

export function cachedSurfboardImage(url: string | null): HTMLImageElement | null {
  if (!url) return null;
  return cache.get(url)?.image ?? null;
}

export function loadSurfboardImage(url: string | null): Promise<HTMLImageElement | null> {
  return url ? requestImage(url).promise : Promise.resolve(null);
}

/** Load only the two files the current board needs. Nothing here is boot-wide. */
export async function prepareSurfboardAssets(config: SurfboardConfig): Promise<void> {
  const value = normalizeSurfboardConfig(config);
  const surface = surfboardSurfaceAsset(value.surface);
  const decal = surfboardDecalAsset(value.decal);
  await Promise.all([loadSurfboardImage(surface.url), loadSurfboardImage(decal.url)]);
}

/** Explicit public name used by surf-mode/customizer activation paths. */
export const loadSelectedSurfboardAssets = prepareSurfboardAssets;

export function surfboardAssetsReady(config: SurfboardConfig): boolean {
  const value = normalizeSurfboardConfig(config);
  const surface = surfboardSurfaceAsset(value.surface);
  const decal = surfboardDecalAsset(value.decal);
  return Boolean(cachedSurfboardImage(surface.url)) && (!decal.url || Boolean(cachedSurfboardImage(decal.url)));
}
