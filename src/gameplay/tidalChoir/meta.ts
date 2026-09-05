/** Boot-safe map/streaming metadata. The installation imports no media. */
export const TIDAL_CHOIR_CENTER = { x: -4245, z: -5385 } as const;
export const TIDAL_CHOIR_LABEL = "Tidal Choir · Marin";
export const TIDAL_CHOIR_RADIUS = 9;
export const TIDAL_CHOIR_NOTES = [48, 55, 60, 64, 67, 72] as const;

export function choirPad(index: number): { x: number; z: number } {
  const angle = index * Math.PI / 3;
  return { x: Math.sin(angle) * TIDAL_CHOIR_RADIUS, z: Math.cos(angle) * TIDAL_CHOIR_RADIUS };
}

/** Each participant can occupy one pad. Overlapping players never double gain. */
export function choirPadAt(x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -1;
  for (let i = 0; i < 6; i++) {
    const pad = choirPad(i);
    if ((x - pad.x) ** 2 + (z - pad.z) ** 2 <= 2.2 ** 2) return i;
  }
  return -1;
}
