/** Deck-local navigation shares Blender's authored meter coordinates. */
export type DeckPoint = { x: number; y: number; z: number };
export const DECKS = [
  { y: 3.3, halfWidth: 9.2, minZ: -36, maxZ: 34 },
  { y: 7.3, halfWidth: 7.3, minZ: -13, maxZ: 27 },
  { y: 11.3, halfWidth: 6.0, minZ: -10, maxZ: 24 }
];
export const STAIRS = [
  { x: 8.5, z: 5, lower: 0 }, { x: -6, z: 0, lower: 1 }
];
/** Axis-separated motion slides along furnishings/walls instead of passing through. */
export function navigable(x: number, z: number, deck: number, secret: boolean): boolean {
  const d = DECKS[deck];
  if (Math.abs(x) > d.halfWidth || z < d.minZ || z > d.maxZ) return false;
  if (deck === 0) {
    if (z < -24 && Math.abs(x) > Math.max(1, (z + 40) * .55)) return false;
    if (z > -13.5 && z < 11.5 && Math.abs(Math.abs(x) - 6.8) < .48) return false;
    if (Math.abs(z + 13) < .5 && (Math.abs(x) > .68 || !secret)) return false;
    if (z < -13.5 && z > -24.5 && Math.abs(Math.abs(x) - 4.5) < .45) return false;
    if (Math.abs(z + 24) < .5 && Math.abs(x) < 4.8) return false;
    for (const wall of [-5, 3]) if (Math.abs(z - wall) < .5 && Math.abs(x) > 1.4 && Math.abs(x) < 6.9) return false;
    for (const [fx, fz, w, l] of [[-4,-9,3.4,1.8],[4,-9,3.4,1.8],[-4,-1,3.4,1.8],[4,7,3.4,1.8],[-4,7,3.9,4.3],[4,-.7,2.7,4.5],[-4.5,-11,3,2], [0,-20,4.8,2.4],[0,-16,3.5,1.8]]) {
      if (Math.abs(x-fx)<w/2 && Math.abs(z-fz)<l/2) return false;
    }
  }
  if (deck === 1) {
    if (z < -1 && Math.abs(Math.abs(x)-4.8) < .45) return false;
    if (z < -10 && Math.abs(x) < 3) return false;
    if (Math.abs(z+4) < 1 && Math.abs(Math.abs(x)-3)<1.8) return false;
  }
  if (deck === 2 && Math.abs(x) < 3.6 && z > 2 && z < 12) return false;
  if (deck === 2 && Math.abs(z-1)<1 && Math.abs(Math.abs(x)-3.6)<1.8) return false;
  return true;
}
export function moveOnDeck(p: DeckPoint, dx: number, dz: number, deck: number, secret: boolean) {
  if (navigable(p.x+dx,p.z,deck,secret)) p.x+=dx;
  if (navigable(p.x,p.z+dz,deck,secret)) p.z+=dz;
}
