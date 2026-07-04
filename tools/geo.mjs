// Shared geodesy for the SF pipeline. Local frame: meters, origin at bbox
// center, +X east, +Z south (so north is -Z, matching three.js forward).
export const BBOX = {
  south: 37.745,
  north: 37.87,
  west: -122.525,
  east: -122.355
};

// Pinned (not bbox-derived) so hand-placed coordinates stay stable.
export const ORIGIN = {
  lat: 37.79,
  lon: -122.444
};

export const M_PER_DEG_LAT = 110574;
export const M_PER_DEG_LON = 111320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

export function lonLatToLocal(lon, lat) {
  return [(lon - ORIGIN.lon) * M_PER_DEG_LON, (ORIGIN.lat - lat) * M_PER_DEG_LAT];
}

export function localToLonLat(x, z) {
  return [ORIGIN.lon + x / M_PER_DEG_LON, ORIGIN.lat - z / M_PER_DEG_LAT];
}

// Heightmap grid: regular local-meter grid covering the bbox with margin.
export const GRID = {
  cellSize: 8,
  width: 1888,
  height: 1736,
  minX: -7168,
  minZ: -8896
};

// Web mercator tile helpers (slippy scheme).
export function lonToTileX(lon, z) {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat, z) {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
}

export function tileYToLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

export function tileXToLon(x, z) {
  return (x / 2 ** z) * 360 - 180;
}
