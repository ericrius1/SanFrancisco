import type { PlayerCtx } from '../../player/types';

/** Pure destination preview, shared by navigation's cover and controller entry. */
export function yachtEntry(ctx: Pick<PlayerCtx, 'map' | 'position'>): { x: number; z: number } {
  const open = (x: number, z: number) => {
    for (let i = -1; i < 8; i++) {
      const a = i * Math.PI / 4;
      const px = x + (i < 0 ? 0 : Math.cos(a) * 44);
      const pz = z + (i < 0 ? 0 : Math.sin(a) * 44);
      if (!ctx.map.isWater(px,pz) || ctx.map.groundHeight(px,pz) >= -3 || ctx.map.bridgeDeck(px,pz) !== -Infinity) return false;
    }
    return true;
  };
  if (open(ctx.position.x, ctx.position.z)) return { x: ctx.position.x, z: ctx.position.z };
  for (let radius = 50; radius <= 3000; radius += 50) {
    for (let angle = 0; angle < Math.PI * 2; angle += Math.PI / 8) {
      const x = ctx.position.x + Math.cos(angle) * radius;
      const z = ctx.position.z + Math.sin(angle) * radius;
      if (open(x,z)) return { x,z };
    }
  }
  throw new Error('The Elsewhere needs deep open water. Try selecting it from the bay.');
}
