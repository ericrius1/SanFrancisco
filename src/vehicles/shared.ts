import type * as THREE from "three/webgpu";
import { waterHeight } from "../world/heightmap";
import type { PlayerCtx } from "../player/types";

/** Typical tall park/street canopy (m). Plane/phoenix launches clear ~2× this. */
export const TYPICAL_TREE_HEIGHT = 28;

/**
 * Arcade driveables sit on a scripted ride spring (`ground + rideHeight`), not
 * tire solvers. `rideHeight` must equal `-contactY`: the mesh-local Y of the
 * intended ground contact (wheel bottoms / feet), with mesh origin at the
 * chassis centre. Prefer an authored `userData.contactY` over full AABB so
 * cargo, mirrors, and antennas cannot poison seating.
 */
export function rideHeightFromContact(contactY: number): number {
  return -contactY;
}

/** Read authored mesh contact, or fall back to an explicit contact Y. */
export function rideHeightFromMesh(
  mesh: THREE.Object3D | null | undefined,
  fallbackContactY: number
): number {
  const authored = mesh?.userData?.contactY;
  const contactY = typeof authored === "number" && Number.isFinite(authored) ? authored : fallbackContactY;
  return rideHeightFromContact(contactY);
}

/** Hull hard-beaches above this ground height (matches BoatController). */
const BOAT_NAV_DEPTH = -1.0;

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

/** Open water deep enough to float — not under a bridge, not shallows/beach.
 * Rings go far enough that inland mode switches still reach the bay. */
export function findWater(ctx: PlayerCtx): { x: number; z: number } | null {
  const step = (r: number) => (r < 200 ? 20 : r < 800 ? 50 : 100);
  for (let r = 20; r <= 3000; r += step(r)) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = ctx.position.x + Math.cos(a) * r;
      const z = ctx.position.z + Math.sin(a) * r;
      if (ctx.map.bridgeDeck(x, z) > -Infinity) continue;
      if (!ctx.map.isWater(x, z)) continue;
      if (ctx.map.groundHeight(x, z) > BOAT_NAV_DEPTH) continue;
      return { x, z };
    }
  }
  // last resort: any non-bridge water cell (may be shallow)
  for (let r = 20; r <= 3000; r += step(r)) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = ctx.position.x + Math.cos(a) * r;
      const z = ctx.position.z + Math.sin(a) * r;
      if (ctx.map.bridgeDeck(x, z) > -Infinity) continue;
      if (ctx.map.isWater(x, z)) return { x, z };
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

/** Entry for boat modes: stay if already on navigable water, else hop to the
 * nearest open-water cell so a downtown switch doesn't beach the hull. */
export function enterOnWater(ctx: PlayerCtx) {
  const px = ctx.position.x;
  const pz = ctx.position.z;
  const openHere =
    ctx.map.isWater(px, pz) &&
    ctx.map.bridgeDeck(px, pz) === -Infinity &&
    ctx.map.groundHeight(px, pz) <= BOAT_NAV_DEPTH;
  if (openHere) {
    ctx.position.y = waterHeight(px, pz, ctx.time) + 0.5;
    return;
  }
  const spot = findWater(ctx);
  if (spot) {
    ctx.position.set(spot.x, waterHeight(spot.x, spot.z, ctx.time) + 0.5, spot.z);
    return;
  }
  ctx.position.y = Math.max(ctx.position.y, ctx.map.effectiveGround(px, pz) + 0.8);
}
