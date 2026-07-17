import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { waterHeight } from "../world/heightmap";
import type { PlayerCtx } from "../player/types";

/** Typical tall park/street canopy (m). Plane/phoenix launches clear ~2× this. */
export const TYPICAL_TREE_HEIGHT = 28;

/**
 * Collapse many small static child meshes into ONE vertex-colored
 * BufferGeometry, turning ~30 near-field draws into one. For each part we bake
 * its LOCAL transform (its `.matrix` — i.e. its pose in the destination group's
 * frame) into positions + normals, then write per-vertex colour attributes from
 * `paint(mesh)` (a `color` for the diffuse, optionally an `emissive`, etc.).
 *
 * Contract:
 * - Every part must be rigid (no non-uniform scale) and expressed in the SAME
 *   destination frame — pass meshes whose `.matrix` reads in the space of the
 *   group the merged mesh will be added to.
 * - All parts in one call must yield the SAME attribute keys from `paint`, so
 *   the merge sees one consistent attribute set.
 * - Each part's original per-part normals are TRANSFORMED (not recomputed), so
 *   flat boxes stay faceted and round spars stay smooth. Geometries are
 *   expanded to non-indexed so an ExtrudeGeometry hull can merge with indexed
 *   Box/Cylinder parts.
 *
 * Input geometries are cloned; the caller still owns (and should dispose) the
 * originals. Nothing shared is disposed here.
 */
export function mergeVertexColoredParts(
  parts: readonly THREE.Mesh[],
  paint: (mesh: THREE.Mesh) => Record<string, THREE.Color>
): THREE.BufferGeometry | null {
  const baked: THREE.BufferGeometry[] = [];
  for (const mesh of parts) {
    mesh.updateMatrix();
    const posed = mesh.geometry.clone();
    posed.applyMatrix4(mesh.matrix);
    // Non-indexed so heterogeneous primitives (extrude/box/cylinder) merge and
    // each keeps its own faceting; applyMatrix4 already fixed the normals.
    const geo = posed.index ? posed.toNonIndexed() : posed;
    if (geo !== posed) posed.dispose();
    for (const name of Object.keys(geo.attributes)) {
      if (name !== "position" && name !== "normal") geo.deleteAttribute(name);
    }
    if (!geo.getAttribute("normal")) geo.computeVertexNormals();
    const count = geo.getAttribute("position").count;
    for (const [name, color] of Object.entries(paint(mesh))) {
      const arr = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        arr[i * 3] = color.r;
        arr[i * 3 + 1] = color.g;
        arr[i * 3 + 2] = color.b;
      }
      geo.setAttribute(name, new THREE.Float32BufferAttribute(arr, 3));
    }
    baked.push(geo);
  }
  const merged = mergeGeometries(baked, false);
  for (const g of baked) g.dispose();
  return merged;
}

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

/**
 * Minimum underbody gap (m) between the physics box bottom and the ride
 * surface. Carpet slab lips, terrain-patch seams, and low authored props sit
 * in this band — a scooter with ~2 cm clearance snags them while a car with
 * ~39 cm clears. Shrink vertical half-extent only; never raise rideHeight
 * (that would float the visual mesh).
 */
export const MIN_DRIVE_GROUND_CLEARANCE = 0.18;

/** `rideHeight - halfExtents[1]` — how far the box bottom sits above the road. */
export function driveGroundClearance(
  rideHeight: number,
  halfExtents: readonly [number, number, number]
): number {
  return rideHeight - halfExtents[1];
}

/**
 * Clamp authored chassis half-extents so ground driveables keep
 * {@link MIN_DRIVE_GROUND_CLEARANCE}. Returns a new tuple when `hy` must shrink.
 */
export function driveHalfExtentsWithClearance(
  rideHeight: number,
  halfExtents: readonly [number, number, number]
): [number, number, number] {
  const maxHy = Math.max(0.08, rideHeight - MIN_DRIVE_GROUND_CLEARANCE);
  if (halfExtents[1] <= maxHy) return [halfExtents[0], halfExtents[1], halfExtents[2]];
  return [halfExtents[0], maxHy, halfExtents[2]];
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
