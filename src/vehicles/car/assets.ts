import {
  CAR_DECALS,
  CAR_SURFACES,
  normalizeCarConfig,
  type CarConfig,
  type CarDecal,
  type CarSurface
} from "./config";

type AssetRecord = {
  image: HTMLImageElement | null;
  promise: Promise<HTMLImageElement | null>;
};

// Bounded selected-only cache. Importing the car, hydrating a saved config, or
// constructing a remote fallback never starts a request.
const cache = new Map<string, AssetRecord>();

export function carSurfaceAsset(id: CarSurface) {
  return CAR_SURFACES.find((entry) => entry.id === id) ?? CAR_SURFACES[0];
}

export function carDecalAsset(id: CarDecal) {
  return CAR_DECALS.find((entry) => entry.id === id) ?? CAR_DECALS[0];
}

function requestImage(url: string): AssetRecord {
  const cached = cache.get(url);
  if (cached) return cached;
  const record: AssetRecord = { image: null, promise: Promise.resolve(null) };
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
    image.onerror = () => resolve(null);
    image.src = url;
  });
  cache.set(url, record);
  return record;
}

export function cachedCarImage(url: string | null): HTMLImageElement | null {
  return url ? cache.get(url)?.image ?? null : null;
}

export function loadCarImage(url: string | null): Promise<HTMLImageElement | null> {
  return url ? requestImage(url).promise : Promise.resolve(null);
}

/** Loads exactly the selected finish and decal. Catalog entries remain cold. */
export async function prepareCarAssets(raw: CarConfig): Promise<void> {
  const config = normalizeCarConfig(raw);
  await Promise.all([
    loadCarImage(carSurfaceAsset(config.surface).url),
    loadCarImage(carDecalAsset(config.decal).url)
  ]);
}

export function carAssetsReady(raw: CarConfig): boolean {
  const config = normalizeCarConfig(raw);
  const surface = carSurfaceAsset(config.surface);
  const decal = carDecalAsset(config.decal);
  return (!surface.url || Boolean(cachedCarImage(surface.url))) &&
    (!decal.url || Boolean(cachedCarImage(decal.url)));
}
