import type { PlayerCtx } from "../player/types";

/** Nearest dry ground, scanning outward in rings from the player. */
export function findLand(ctx: PlayerCtx): { x: number; z: number } | null {
  for (let r = 10; r <= 300; r += 20) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = ctx.position.x + Math.cos(a) * r;
      const z = ctx.position.z + Math.sin(a) * r;
      if (ctx.map.bridgeDeck(x, z) > -Infinity || !ctx.map.isWater(x, z)) return { x, z };
    }
  }
  return null;
}

/** Entry for ground modes (walk, drive): hop to shore if over water, else
 * make sure there's clearance above the local ground. */
export function enterOnLand(ctx: PlayerCtx) {
  const onBridge = ctx.map.bridgeDeck(ctx.position.x, ctx.position.z) > -Infinity;
  if (!onBridge && ctx.map.isWater(ctx.position.x, ctx.position.z)) {
    const spot = findLand(ctx);
    if (spot) ctx.position.set(spot.x, ctx.map.effectiveGround(spot.x, spot.z) + 1.2, spot.z);
  } else {
    ctx.position.y = Math.max(ctx.position.y, ctx.map.effectiveGround(ctx.position.x, ctx.position.z) + 1.2);
  }
}
