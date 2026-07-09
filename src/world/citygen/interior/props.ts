// Room dressing: zone-appropriate furniture, warm emissive lamps, and framed
// placeholder art. All boxes (collider parity is free) except the pictures,
// which are frame-box + inset art-quad so a real painting can be swapped in
// later. Everything is deterministic from the caller's Rng and stays inside the
// room, clear of the stair footprint.
import type { ColliderBox } from "../core/types";
import { PanelBuilder, type Vec3 } from "../core/facade";
import type { Rng } from "../core/rng";
import { addBox, EYE, WALL_H, type Rect, rectW, rectD, rectCX, rectCZ, overlaps, inset } from "./common";

/** the room's job — drives which furniture goes in. */
export type Role = "parlor" | "kitchen" | "hall" | "bedroom" | "bath" | "retail" | "office" | "loft" | "stair";

const ART_MATS = ["int.art1", "int.art2", "int.art3", "int.art4"];

/** A spot on a wall to hang a picture: a point + the inward-facing normal. */
export interface ArtSpot { x: number; z: number; normal: Vec3; }

/**
 * Hang one framed placeholder picture at eye height: an int.frame box proud of
 * the wall with an int.artN quad inset as the picture. Swap the quad's material
 * for a real painting later — geometry is intentionally trivial. No collider.
 */
export function hangArt(out: PanelBuilder, spot: ArtSpot, r: Rng): void {
  const art = ART_MATS[Math.floor(r() * ART_MATS.length) % ART_MATS.length];
  const hw = 0.32 + r() * 0.22;         // frame half-width
  const hh = 0.26 + r() * 0.2;          // frame half-height
  const y = EYE + (r() - 0.5) * 0.12;
  const n = spot.normal;
  const along: Vec3 = [-n[2], 0, n[0]]; // horizontal wall tangent (n = up × along)
  // frame: a thin oriented slab, back flush to the wall, front ~0.06 m proud
  out.box("int.frame", [spot.x + n[0] * 0.03, y, spot.z + n[2] * 0.03],
    [hw + 0.05, hh + 0.05, 0.03], along, [0, 1, 0], n, false);
  // picture: a quad just proud of the frame face, wound to face into the room
  const px = spot.x + n[0] * 0.065, pz = spot.z + n[2] * 0.065;
  const corner = (sa: number, su: number): Vec3 => [px + along[0] * sa * hw, y + su * hh, pz + along[2] * sa * hw];
  out.quad(art, corner(-1, -1), corner(-1, 1), corner(1, 1), corner(1, -1), n);
}

/** pick 1..max distinct cell walls and hang art on each, facing inward. */
function hangRoomArt(out: PanelBuilder, cell: Rect, max: number, r: Rng): void {
  const cx = rectCX(cell), cz = rectCZ(cell);
  const walls: ArtSpot[] = [
    { x: cell.x0 + 0.05, z: cz + (r() - 0.5) * rectD(cell) * 0.5, normal: [1, 0, 0] },
    { x: cell.x1 - 0.05, z: cz + (r() - 0.5) * rectD(cell) * 0.5, normal: [-1, 0, 0] },
    { x: cx + (r() - 0.5) * rectW(cell) * 0.5, z: cell.z0 + 0.05, normal: [0, 0, 1] },
    { x: cx + (r() - 0.5) * rectW(cell) * 0.5, z: cell.z1 - 0.05, normal: [0, 0, -1] },
  ];
  // shuffle deterministically, take up to `max`
  for (let i = walls.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [walls[i], walls[j]] = [walls[j], walls[i]]; }
  const n = 1 + Math.floor(r() * max);
  for (let i = 0; i < n && i < walls.length; i++) hangArt(out, walls[i], r);
}

/**
 * Furnish one room. `stair`, when set, is a keep-clear footprint (pieces that
 * would overlap it are dropped). Adds a ceiling lamp so the room always reads.
 */
export function furnish(
  out: PanelBuilder, cols: ColliderBox[], stair: Rect | null,
  role: Role, cell: Rect, floorY: number, r: Rng,
): void {
  const inner = inset(cell, 0.28);
  const cx = rectCX(inner), cz = rectCZ(inner);
  const w = rectW(inner), d = rectD(inner);

  /** place a solid box, skipping it if it would sit in the stairwell. */
  const put = (mat: string, px: number, py: number, pz: number, hx: number, hy: number, hz: number, collide = true): void => {
    const foot: Rect = { x0: px - hx, x1: px + hx, z0: pz - hz, z1: pz + hz };
    if (stair && overlaps(foot, stair)) return;
    addBox(out, collide ? cols : null, mat, px, py, pz, hx, hy, hz);
  };
  /** thin floor rug (no collider). */
  const rug = (px: number, pz: number, hx: number, hz: number): void => put("int.rug", px, floorY + 0.02, pz, hx, 0.02, hz, false);
  /** warm ceiling lamp — the room's key light. */
  const lampY = floorY + Math.min(WALL_H - 0.2, 2.7);
  const ceilingLamp = (): void => put("int.glow", cx, lampY, cz, Math.min(0.5, w * 0.28), 0.05, Math.min(0.5, d * 0.28), false);
  /** extra lamps so a big open floor reads across its whole area. */
  const fillLamps = (): void => {
    if (w < 5 && d < 5) return;
    for (const sx of [-1, 1]) for (const sz of [-1, 1])
      put("int.glow", cx + sx * w * 0.3, lampY, cz + sz * d * 0.3, 0.35, 0.05, 0.35, false);
  };
  /** a small warm table/standing lamp. */
  const accent = (px: number, pz: number): void => put("int.glow", px, floorY + 0.62, pz, 0.09, 0.14, 0.09, false);

  ceilingLamp();

  switch (role) {
    case "parlor": {
      rug(cx, cz, w * 0.34, d * 0.3);
      put("int.sofa", cx, floorY + 0.36, cz + d * 0.28, w * 0.34, 0.36, 0.32);       // sofa
      put("int.wood", cx, floorY + 0.24, cz - d * 0.02, w * 0.22, 0.24, 0.28);       // coffee table
      put("int.wood", cx - w * 0.36, floorY + 0.55, cz - d * 0.3, 0.16, 0.55, d * 0.2); // shelf
      accent(cx + w * 0.36, cz - d * 0.32);
      hangRoomArt(out, cell, 3, r);
      break;
    }
    case "kitchen": {
      put("int.counter", cx, floorY + 0.46, cz + d * 0.34, w * 0.4, 0.46, 0.3);      // counter run
      put("int.wood", cx - w * 0.34, floorY + 0.5, cz - d * 0.1, 0.22, 0.5, d * 0.28); // cabinets
      put("int.metal", cx + w * 0.28, floorY + 0.45, cz - d * 0.28, 0.32, 0.45, 0.32); // appliance
      hangRoomArt(out, cell, 1, r);
      break;
    }
    case "hall": {
      put("int.wood", cx, floorY + 0.38, cz, w * 0.24, 0.38, d * 0.28);              // table
      for (const s of [-1, 1]) put("int.wood", cx + s * w * 0.32, floorY + 0.28, cz, 0.14, 0.28, 0.14); // chairs
      hangRoomArt(out, cell, 2, r);
      break;
    }
    case "bedroom": {
      rug(cx, cz + d * 0.05, w * 0.32, d * 0.3);
      put("int.wood", cx, floorY + 0.3, cz + d * 0.18, w * 0.34, 0.3, d * 0.3);      // bed
      put("int.wood", cx - w * 0.4, floorY + 0.28, cz - d * 0.3, 0.16, 0.28, 0.16);  // nightstand
      accent(cx - w * 0.4, cz - d * 0.3);
      put("int.wood", cx + w * 0.36, floorY + 0.6, cz - d * 0.28, 0.18, 0.6, d * 0.18); // wardrobe
      hangRoomArt(out, cell, 2, r);
      break;
    }
    case "bath": {
      put("int.counter", cx, floorY + 0.44, cz + d * 0.3, w * 0.34, 0.44, 0.26);     // vanity
      put("int.metal", cx - w * 0.28, floorY + 0.3, cz - d * 0.28, 0.28, 0.3, 0.3);  // tub/fixture
      hangRoomArt(out, cell, 1, r);
      break;
    }
    case "retail": {
      put("int.counter", cx, floorY + 0.5, cz + d * 0.36, w * 0.4, 0.5, 0.3);        // service counter
      for (const s of [-1, 0, 1]) put("int.wood", cx + s * w * 0.3, floorY + 0.8, cz - d * 0.12, 0.16, 0.8, d * 0.26); // shelving rows
      accent(cx, cz + d * 0.36);
      fillLamps();
      hangRoomArt(out, cell, 3, r);
      break;
    }
    case "office": {
      for (const s of [-1, 1]) put("int.wood", cx + s * w * 0.26, floorY + 0.38, cz + d * 0.15, w * 0.18, 0.38, 0.34); // desks
      put("int.metal", cx + w * 0.34, floorY + 0.6, cz - d * 0.3, 0.16, 0.6, d * 0.22); // filing/shelf
      hangRoomArt(out, cell, 2, r);
      break;
    }
    case "loft": {
      // open plan: sparse industrial props scattered from the seed
      put("int.wood", cx + (r() - 0.5) * w * 0.4, floorY + 0.4, cz + (r() - 0.5) * d * 0.4, 0.6, 0.4, 0.5); // work table
      put("int.metal", cx - w * 0.3, floorY + 0.45, cz + d * 0.3, 0.4, 0.45, 0.4);   // crate
      put("int.metal", cx - w * 0.3, floorY + 1.15, cz + d * 0.3, 0.34, 0.28, 0.34); // stacked crate
      put("int.metal", cx + w * 0.34, floorY + 0.9, cz - d * 0.3, 0.16, 0.9, d * 0.24); // shelf unit
      fillLamps();
      hangRoomArt(out, cell, 1, r);
      break;
    }
    case "stair": {
      // keep the floor clear for circulation — just a picture on a wall
      hangRoomArt(out, cell, 1, r);
      break;
    }
  }
}
