/** Lightweight first-approach/minimap metadata for the lazy creature ranch —
 *  the horse paddock + goat pen next door to Biscuit's puppy nursery on the
 *  Marina flats. All spots scan-verified flat land (groundTop, not bay floor). */
export const RANCH_CENTER = { x: -740, z: -1660 } as const;
export const RANCH_RADIUS = 95; // covers both pens below
export const RANCH_SITE_PADS = { activate: 130, deactivate: 190 } as const;

// Seaward of Marina Blvd — the road cuts the flats around z≈-1590..-1615, so
// both pens live in the clean shore band z≈-1630..-1690.
export const HORSE_PADDOCK = { x: -775, z: -1655, r: 26 } as const;
export const GOAT_PEN = { x: -705, z: -1675, r: 9 } as const;
