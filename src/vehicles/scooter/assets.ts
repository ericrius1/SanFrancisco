import {
  SCOOTER_DECALS,
  SCOOTER_SURFACES,
  normalizeScooterConfig,
  type ScooterConfig,
  type ScooterDecal,
  type ScooterSurface
} from "./config";

type AssetRecord = {
  image: HTMLImageElement | null;
  promise: Promise<HTMLImageElement | null>;
};

// Five bounded, player-selectable images. Merely importing or constructing a
// scooter never touches this cache; requestImage only runs after first use.
const cache = new Map<string, AssetRecord>();

export function scooterSurfaceAsset(id: ScooterSurface) {
  return SCOOTER_SURFACES.find((entry) => entry.id === id) ?? SCOOTER_SURFACES[0];
}

export function scooterDecalAsset(id: ScooterDecal) {
  return SCOOTER_DECALS.find((entry) => entry.id === id) ?? SCOOTER_DECALS[0];
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

export function cachedScooterImage(url: string | null): HTMLImageElement | null {
  return url ? (cache.get(url)?.image ?? null) : null;
}

export function loadScooterImage(url: string | null): Promise<HTMLImageElement | null> {
  return url ? requestImage(url).promise : Promise.resolve(null);
}

/** Load exactly the selected paint and selected decal, never their catalogs. */
export async function prepareScooterAssets(raw: ScooterConfig): Promise<void> {
  const config = normalizeScooterConfig(raw);
  const surface = scooterSurfaceAsset(config.surface);
  const decal = scooterDecalAsset(config.decal);
  await Promise.all([loadScooterImage(surface.url), loadScooterImage(decal.url)]);
}

export function scooterAssetsReady(raw: ScooterConfig): boolean {
  const config = normalizeScooterConfig(raw);
  const surface = scooterSurfaceAsset(config.surface);
  const decal = scooterDecalAsset(config.decal);
  return (!surface.url || Boolean(cachedScooterImage(surface.url))) &&
    (!decal.url || Boolean(cachedScooterImage(decal.url)));
}
