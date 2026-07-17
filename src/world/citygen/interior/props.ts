// Deterministic low-poly room dressing.  Furniture is authored in real metres,
// anchored to walls or side zones, and admitted through one occupied-footprint
// test.  Circulation rectangles arrive from rooms.ts before placement, so a prop
// can never turn a valid room graph back into an obstacle course.
import type { ColliderBox } from "../core/types";
import { PanelBuilder, type Vec3 } from "../core/facade";
import { rng as seededRng, type Rng } from "../core/rng";
import {
  EYE, addBox, containsRect, expand, inset, overlaps, rectAround,
  type Rect, rectW, rectD, rectCX, rectCZ,
} from "./common";
import type { InteriorStyle } from "./style";
import { emitProceduralLamp, PROCEDURAL_LAMP_TUNING } from "./lamp";

export type Role = "parlor" | "dining" | "kitchen" | "hall" | "bedroom" | "bath" | "retail" | "office" | "loft" | "stair";

const ART_MATS = ["int.art1", "int.art2", "int.art3", "int.art4"];
type Side = "north" | "south" | "west" | "east";

export interface PlacedProp {
  kind: string;
  foot: Rect;
  collider: boolean;
}

/** A spot on a wall to hang a picture: a point + the inward-facing normal. */
export interface ArtSpot { x: number; z: number; normal: Vec3; }

/** Arrival-axis hint for the ground-floor room that owns the front door. */
export interface EntryFocus {
  /** A point already 1.55 m inside the threshold. */
  point: readonly [number, number];
  /** Unit direction from the door into the home, in the planner's local frame. */
  inward: readonly [number, number];
}

function shuffled<T>(items: T[], r: Rng): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/** Multi-layer geometric placeholder art: frame, colour field and 2–3 accents. */
export function hangArt(out: PanelBuilder, spot: ArtSpot, r: Rng, floorY: number, scale = 1): void {
  const mats = shuffled([...ART_MATS], r);
  const hw = Math.min(0.78, (0.30 + r() * 0.18) * scale);
  const hh = Math.min(0.62, (0.24 + r() * 0.15) * scale);
  const y = floorY + EYE + (r() - 0.5) * 0.12;
  const n = spot.normal;
  const along: Vec3 = [-n[2], 0, n[0]];
  const up: Vec3 = [0, 1, 0];
  const center = (a: number, u: number, proud: number): Vec3 => [
    spot.x + along[0] * a + n[0] * proud,
    y + u,
    spot.z + along[2] * a + n[2] * proud,
  ];
  out.box("int.frame", center(0, 0, 0.035), [hw + 0.055, hh + 0.055, 0.025], along, up, n, false);
  out.box(mats[0], center(0, 0, 0.067), [hw, hh, 0.008], along, up, n, false);
  // Horizon + sun / abstract blocks give the placeholder a composed image rather
  // than one flat colour. All are visual-only and sit millimetres apart.
  out.box(mats[1], center(0, -hh * 0.22, 0.078), [hw * 0.88, hh * 0.18, 0.006], along, up, n, false);
  out.box(mats[2], center(hw * (r() < 0.5 ? -0.38 : 0.38), hh * 0.28, 0.082), [hw * 0.16, hh * 0.16, 0.006], along, up, n, false);
  if (scale > 1.15) out.box(mats[3], center(-hw * 0.2, hh * 0.02, 0.084), [hw * 0.32, hh * 0.08, 0.006], along, up, n, false);
}

interface WallPlace {
  side: Side;
  axis: "x" | "z";
  cx: number; cz: number;
  length: number; depth: number;
  foot: Rect;
  /** unit vector from the wall into the room. */
  inward: readonly [number, number];
}

function wallPlaces(cell: Rect, length: number, depth: number): WallPlace[] {
  const cx = rectCX(cell), cz = rectCZ(cell);
  const alongX = Math.min(length, rectW(cell) - 0.18);
  const alongZ = Math.min(length, rectD(cell) - 0.18);
  const out: WallPlace[] = [];
  // Try several realistic bays along each wall. The old centre-only candidates
  // repeatedly landed on a window or circulation strip, leaving large lofts
  // empty even though metres of clear perimeter remained.
  const offsets = [0, -0.75, -0.25, 0.25, 0.75];
  const maxX = Math.max(0, rectW(cell) / 2 - alongX / 2 - 0.09);
  const maxZ = Math.max(0, rectD(cell) / 2 - alongZ / 2 - 0.09);
  for (const f of offsets) {
    const px = cx + f * maxX;
    out.push({ side: "north", axis: "x", cx: px, cz: cell.z0 + depth / 2, length: alongX, depth,
      foot: rectAround(px, cell.z0 + depth / 2, alongX, depth), inward: [0, 1] });
    out.push({ side: "south", axis: "x", cx: px, cz: cell.z1 - depth / 2, length: alongX, depth,
      foot: rectAround(px, cell.z1 - depth / 2, alongX, depth), inward: [0, -1] });
    const pz = cz + f * maxZ;
    out.push({ side: "west", axis: "z", cx: cell.x0 + depth / 2, cz: pz, length: alongZ, depth,
      foot: rectAround(cell.x0 + depth / 2, pz, depth, alongZ), inward: [1, 0] });
    out.push({ side: "east", axis: "z", cx: cell.x1 - depth / 2, cz: pz, length: alongZ, depth,
      foot: rectAround(cell.x1 - depth / 2, pz, depth, alongZ), inward: [-1, 0] });
  }
  return out;
}

/**
 * Furnish one room and return its admitted footprints for diagnostics/tests.
 * `keepouts` contains every circulation strip and portal/stair approach touching
 * this room. `stair` is a second defensive exclusion around the physical flight.
 */
export function furnish(
  out: PanelBuilder, cols: ColliderBox[], stair: Rect | null,
  role: Role, cell: Rect, floorY: number, roomHeight: number, r: Rng,
  keepouts: readonly Rect[], style: InteriorStyle, entryFocus: EntryFocus | null = null,
  artKeepouts: readonly Rect[] = [],
): PlacedProp[] {
  const inner = inset(cell, 0.30);
  const cx = rectCX(inner), cz = rectCZ(inner);
  const w = rectW(inner), d = rectD(inner);
  const roomArea = w * d;
  const clampX = (x: number) => Math.min(inner.x1 - 0.08, Math.max(inner.x0 + 0.08, x));
  const clampZ = (z: number) => Math.min(inner.z1 - 0.08, Math.max(inner.z0 + 0.08, z));
  // Compose the first room around what a player sees after walking in. The
  // 2.9 m look-ahead lands beyond the immediate threshold but well before the
  // old whole-floor centre in a deep SF lot. Solid props still go through the
  // same circulation admission test, so this is presentation—not an obstacle.
  const focus = entryFocus ? {
    x: clampX(entryFocus.point[0] + entryFocus.inward[0] * 2.9),
    z: clampZ(entryFocus.point[1] + entryFocus.inward[1] * 2.9),
  } : null;
  const occupied: PlacedProp[] = [];
  const blocked = [...keepouts, ...(stair ? [expand(stair, 0.12)] : [])];

  const visual = (mat: string, px: number, py: number, pz: number, hx: number, hy: number, hz: number) =>
    addBox(out, null, mat, px, py, pz, hx, hy, hz);
  const dims = (p: WallPlace, alongHalf: number, depthHalf: number): readonly [number, number] =>
    p.axis === "x" ? [alongHalf, depthHalf] : [depthHalf, alongHalf];
  const offset = (p: WallPlace, inward: number, along = 0): readonly [number, number] => {
    const tx = p.axis === "x" ? along : 0;
    const tz = p.axis === "z" ? along : 0;
    return [p.cx + p.inward[0] * inward + tx, p.cz + p.inward[1] * inward + tz];
  };
  const proxy = (foot: Rect, height: number) => cols.push({
    x: rectCX(foot), y: floorY + height / 2, z: rectCZ(foot),
    hx: rectW(foot) / 2, hy: height / 2, hz: rectD(foot) / 2, yaw: 0,
  });
  const clear = (foot: Rect, gap = 0.10): boolean => {
    if (!containsRect(inner, foot)) return false;
    if (blocked.some((b) => overlaps(foot, b))) return false;
    const padded = expand(foot, gap);
    return !occupied.some((p) => overlaps(padded, expand(p.foot, gap)));
  };
  const admit = (kind: string, foot: Rect, collider: boolean, emit: () => void, height = 0.75, gap = 0.10): boolean => {
    if (!clear(foot, gap)) return false;
    emit();
    if (collider) proxy(foot, height);
    occupied.push({ kind, foot, collider });
    return true;
  };
  const placeWall = (
    kind: string, length: number, depth: number, collider: boolean,
    emit: (p: WallPlace) => void, height = 0.75, gap = 0.10,
  ): WallPlace | null => {
    const candidates = shuffled(wallPlaces(inner, length, depth), r);
    // Long pieces read best on the long wall. In an entry room, prefer the bays
    // around the arrival focal zone rather than a random far end of the lot.
    candidates.sort((a, b) => {
      const lengthBias = (b.length - a.length) * 3;
      if (!focus) return lengthBias;
      const da = Math.hypot(a.cx - focus.x, a.cz - focus.z);
      const db = Math.hypot(b.cx - focus.x, b.cz - focus.z);
      return da - db + lengthBias;
    });
    for (const p of candidates) if (admit(kind, p.foot, collider, () => emit(p), height, gap)) return p;
    return null;
  };
  const placeFree = (
    kind: string, fw: number, fd: number, collider: boolean,
    emit: (px: number, pz: number) => void, height = 0.75, gap = 0.10,
  ): Rect | null => {
    const ox = Math.max(0, w / 2 - fw / 2 - 0.12) * 0.58;
    const oz = Math.max(0, d / 2 - fd / 2 - 0.12) * 0.58;
    const basePts = [
      [cx - ox, cz - oz], [cx + ox, cz - oz], [cx - ox, cz + oz], [cx + ox, cz + oz],
      [cx - ox, cz], [cx + ox, cz], [cx, cz - oz], [cx, cz + oz],
    ] as [number, number][];
    const pts = focus && entryFocus ? (() => {
      const tx = -entryFocus.inward[1], tz = entryFocus.inward[0];
      const side = Math.max(1.05, (Math.abs(tx) * fw + Math.abs(tz) * fd) / 2 + 0.78);
      const ahead = Math.max(0.6, (Math.abs(entryFocus.inward[0]) * fw + Math.abs(entryFocus.inward[1]) * fd) * 0.45);
      const focal: [number, number][] = [];
      for (const s of [-1, 1]) {
        focal.push(
          [clampX(focus.x + tx * side * s), clampZ(focus.z + tz * side * s)],
          [clampX(focus.x + tx * side * s + entryFocus.inward[0] * ahead), clampZ(focus.z + tz * side * s + entryFocus.inward[1] * ahead)],
        );
      }
      return [...shuffled(focal, r), ...shuffled(basePts, r)];
    })() : shuffled(basePts, r);
    for (const [px, pz] of pts) {
      const foot = rectAround(px, pz, fw, fd);
      if (admit(kind, foot, collider, () => emit(px, pz), height, gap)) return foot;
    }
    return null;
  };

  const rugMaxW = role === "loft" ? 4.2 : style.tier === 2 ? 3.5 : 3.0;
  const rugMaxD = role === "loft" ? 2.8 : style.tier === 2 ? 2.4 : 2.05;
  const rug = (px = focus?.x ?? cx, pz = focus?.z ?? cz, rw = Math.min(rugMaxW, w * 0.55), rd = Math.min(rugMaxD, d * 0.45)) =>
    visual("int.rug", px, floorY + 0.018, pz, rw / 2, 0.018, rd / 2);

  const sofa = () => {
    const len = Math.min(2.25, Math.max(1.55, Math.max(w, d) * 0.34));
    return placeWall("sofa", len, 0.82, true, (p) => {
      let [hx, hz] = dims(p, p.length / 2, p.depth / 2);
      visual(style.fabric, p.cx, floorY + 0.26, p.cz, hx, 0.24, hz);
      const [bx, bz] = offset(p, -p.depth / 2 + 0.11);
      [hx, hz] = dims(p, p.length / 2, 0.11);
      visual(style.fabric, bx, floorY + 0.63, bz, hx, 0.37, hz);
      for (const s of [-1, 1]) {
        const [ax, az] = offset(p, 0, s * (p.length / 2 - 0.10));
        [hx, hz] = dims(p, 0.10, p.depth * 0.43);
        visual(style.fabric, ax, floorY + 0.42, az, hx, 0.25, hz);
      }
      const cushions = p.length > 1.95 ? 3 : 2;
      for (let i = 0; i < cushions; i++) {
        const a = ((i + 0.5) / cushions - 0.5) * p.length * 0.78;
        const [qx, qz] = offset(p, 0.10, a);
        [hx, hz] = dims(p, p.length * 0.32 / cushions, 0.25);
        visual(i % 2 ? "int.linen" : style.fabric, qx, floorY + 0.53, qz, hx, 0.11, hz);
      }
    }, 0.86, 0.14);
  };

  const bookcase = () => placeWall("bookcase", Math.min(1.55, Math.max(1.0, Math.max(w, d) * 0.23)), 0.34, true, (p) => {
    let [hx, hz] = dims(p, p.length / 2, p.depth / 2);
    visual("int.wood", p.cx, floorY + 0.9, p.cz, hx, 0.9, hz);
    // inset shelves + colourful book runs sit just inside the room face.
    for (let shelf = 0; shelf < 3; shelf++) {
      const [sx, sz] = offset(p, p.depth / 2 + 0.012);
      [hx, hz] = dims(p, p.length * 0.43, 0.025);
      visual("int.brass", sx, floorY + 0.34 + shelf * 0.46, sz, hx, 0.025, hz);
      for (let k = 0; k < 5; k++) {
        const a = (k - 2) * p.length * 0.145;
        const [qx, qz] = offset(p, p.depth / 2 + 0.045, a);
        [hx, hz] = dims(p, p.length * 0.055, 0.035);
        visual(k % 2 ? "int.book" : ART_MATS[(k + shelf) % ART_MATS.length], qx, floorY + 0.21 + shelf * 0.46, qz, hx, 0.14, hz);
      }
    }
  }, 1.8, 0.12);

  const consoleTable = (kind = "console") => placeWall(kind, 1.15, 0.38, true, (p) => {
    let [hx, hz] = dims(p, p.length / 2, p.depth / 2);
    visual("int.wood", p.cx, floorY + 0.65, p.cz, hx, 0.08, hz);
    for (const s of [-1, 1]) {
      const [lx, lz] = offset(p, 0, s * (p.length / 2 - 0.08));
      [hx, hz] = dims(p, 0.055, p.depth * 0.38);
      visual("int.wood", lx, floorY + 0.31, lz, hx, 0.31, hz);
    }
  }, 0.73, 0.11);

  const counter = (kind = "counter", length = 2.2, mat = "int.counter") => placeWall(kind, Math.min(length, Math.max(w, d) - 0.3), 0.62, true, (p) => {
    let [hx, hz] = dims(p, p.length / 2, p.depth / 2);
    visual(mat, p.cx, floorY + 0.43, p.cz, hx, 0.43, hz);
    const [tx, tz] = offset(p, 0.02);
    [hx, hz] = dims(p, p.length / 2 + 0.04, p.depth / 2 + 0.04);
    visual(style.tier === 2 ? "int.brass" : "int.wood", tx, floorY + 0.89, tz, hx, 0.035, hz);
  }, 0.93, 0.14);

  const bed = () => placeWall("bed", Math.min(1.65, Math.max(1.28, Math.min(w, d) * 0.34)), 2.05, true, (p) => {
    let [hx, hz] = dims(p, p.length / 2, p.depth / 2);
    visual("int.wood", p.cx, floorY + 0.23, p.cz, hx, 0.23, hz);
    const [mx, mz] = offset(p, 0.06);
    [hx, hz] = dims(p, p.length / 2 - 0.06, p.depth / 2 - 0.08);
    visual("int.linen", mx, floorY + 0.47, mz, hx, 0.18, hz);
    const [headX, headZ] = offset(p, -p.depth / 2 + 0.09);
    [hx, hz] = dims(p, p.length / 2, 0.09);
    visual("int.wood", headX, floorY + 0.72, headZ, hx, 0.5, hz);
    for (const s of [-1, 1]) {
      const [px, pz] = offset(p, -p.depth * 0.25, s * p.length * 0.22);
      [hx, hz] = dims(p, p.length * 0.18, 0.26);
      visual("int.linen", px, floorY + 0.69, pz, hx, 0.10, hz);
    }
  }, 0.72, 0.14);

  const diningSet = (office = false) => {
    const tw = office ? 1.25 : style.tier === 2 ? 1.7 : 1.45;
    const td = office ? 0.7 : 0.82;
    const fw = tw + (office ? 0.15 : 0.8), fd = td + (office ? 0.55 : 0.8);
    return placeFree(office ? "desk" : "dining", fw, fd, true, (px, pz) => {
      visual("int.wood", px, floorY + 0.72, pz, tw / 2, 0.07, td / 2);
      for (const sx of [-1, 1]) for (const sz of [-1, 1])
        visual("int.wood", px + sx * (tw / 2 - 0.08), floorY + 0.35, pz + sz * (td / 2 - 0.08), 0.055, 0.35, 0.055);
      const chairs = office ? [[0, td / 2 + 0.3]] : [[-tw * 0.28, td / 2 + 0.28], [tw * 0.28, td / 2 + 0.28], [-tw * 0.28, -td / 2 - 0.28], [tw * 0.28, -td / 2 - 0.28]];
      for (const [dx, dz] of chairs) {
        visual(style.fabric, px + dx, floorY + 0.35, pz + dz, 0.20, 0.07, 0.20);
        visual(style.fabric, px + dx, floorY + 0.62, pz + dz + Math.sign(dz || 1) * 0.17, 0.20, 0.28, 0.055);
      }
    }, 0.79, 0.14);
  };

  const lowTable = () => placeFree("coffee-table", 1.05, 0.58, true, (px, pz) => {
    visual("int.wood", px, floorY + 0.32, pz, 0.525, 0.07, 0.29);
    for (const sx of [-1, 1]) for (const sz of [-1, 1])
      visual("int.brass", px + sx * 0.43, floorY + 0.16, pz + sz * 0.21, 0.035, 0.16, 0.035);
  }, 0.39, 0.13);

  const bathFixture = () => placeWall("bath-fixture", 1.45, 0.76, true, (p) => {
    let [hx, hz] = dims(p, p.length / 2, p.depth / 2);
    visual("int.ceramic", p.cx, floorY + 0.28, p.cz, hx, 0.28, hz);
    const [ix, iz] = offset(p, 0.05);
    [hx, hz] = dims(p, p.length / 2 - 0.12, p.depth / 2 - 0.12);
    visual("int.wall.cool", ix, floorY + 0.48, iz, hx, 0.08, hz);
  }, 0.56, 0.14);

  const plant = () => {
    const corners = [
      [inner.x0 + 0.28, inner.z0 + 0.28], [inner.x1 - 0.28, inner.z0 + 0.28],
      [inner.x0 + 0.28, inner.z1 - 0.28], [inner.x1 - 0.28, inner.z1 - 0.28],
    ] as [number, number][];
    const focal = focus && entryFocus ? (() => {
      const tx = -entryFocus.inward[1], tz = entryFocus.inward[0];
      return [-1, 1].map((s) => [clampX(focus.x + tx * s * 1.45), clampZ(focus.z + tz * s * 1.45)] as [number, number]);
    })() : [];
    const pts = [...shuffled(focal, r), ...shuffled(corners, r)];
    for (const [px, pz] of pts) {
      const foot = rectAround(px, pz, 0.42, 0.42);
      if (!admit("plant", foot, false, () => {
        visual("int.ceramic", px, floorY + 0.18, pz, 0.17, 0.18, 0.17);
        visual("int.plant", px, floorY + 0.48, pz, 0.08, 0.28, 0.08);
        for (const [dx, dz, yy] of [[-0.15, 0, 0.62], [0.15, 0.02, 0.72], [0, -0.14, 0.82], [0.03, 0.14, 0.9]] as const)
          visual("int.plant", px + dx, floorY + yy, pz + dz, 0.16, 0.055, 0.10);
      }, 0, 0.08)) continue;
      break;
    }
  };

  const ceilingLight = () => {
    // Anchor to the actual ceiling rather than the legacy 2.7 m partition cap.
    // This keeps fixtures attached across the archetypes' 3.2–4.2 m storeys.
    const yTop = floorY + roomHeight - 0.14;
    const lightX = focus?.x ?? cx, lightZ = focus?.z ?? cz;
    // Residential parlors, dining rooms, and halls can carry the layered-ribbon
    // fixture. Draw its coverage roll + seed from the room stream exactly once,
    // then generate through an isolated stream. Lamp tuning can therefore change
    // topology without perturbing any furniture, art, or collider that follows.
    const proceduralEligible = style.chandelier
      && ["parlor", "dining", "hall"].includes(role)
      && Math.min(w, d) > 3.05;
    const lampRoll = proceduralEligible ? r() : 1;
    const lampSeed = proceduralEligible ? Math.floor(r() * 0x100000000) : 0;
    const procedural = proceduralEligible
      && PROCEDURAL_LAMP_TUNING.values.enabled
      && lampRoll < PROCEDURAL_LAMP_TUNING.values.coverage;
    if (procedural && emitProceduralLamp(out, {
      x: lightX,
      z: lightZ,
      ceilingY: yTop,
      roomWidth: w,
      roomDepth: d,
      rng: seededRng(lampSeed, 0x1a4d),
    })) return;
    const chandelier = style.chandelier && ["parlor", "dining", "hall", "retail"].includes(role) && Math.min(w, d) > 3.4;
    visual("int.brass", lightX, yTop, lightZ, 0.13, 0.035, 0.13); // canopy
    if (chandelier) {
      visual("int.brass", lightX, yTop - 0.30, lightZ, 0.035, 0.30, 0.035);
      visual("int.brass", lightX, yTop - 0.57, lightZ, 0.12, 0.07, 0.12);
      const arms = style.tier === 2 ? 6 : 4;
      const radius = 0.58;
      for (let i = 0; i < arms; i++) {
        const a = (i / arms) * Math.PI * 2;
        const ux = Math.cos(a), uz = Math.sin(a);
        const along: Vec3 = [ux, 0, uz], normal: Vec3 = [-uz, 0, ux];
        out.box("int.brass", [lightX + ux * radius / 2, yTop - 0.56, lightZ + uz * radius / 2], [radius / 2, 0.025, 0.025], along, [0, 1, 0], normal, false);
        visual("int.glow", lightX + ux * radius, yTop - 0.46, lightZ + uz * radius, 0.09, 0.13, 0.09);
      }
    } else {
      const drop = style.family === "industrial" ? 0.58 : style.tier === 0 ? 0.25 : 0.4;
      visual(style.family === "industrial" ? "int.metal" : "int.brass", lightX, yTop - drop / 2, lightZ, 0.025, drop / 2, 0.025);
      const shadeY = yTop - drop - 0.08;
      const shade = style.tier === 0 ? 0.16 : 0.22;
      visual("int.glow", lightX, shadeY + 0.07, lightZ, shade * 0.58, 0.045, shade * 0.58);
      visual("int.glow", lightX, shadeY, lightZ, shade, 0.055, shade);
      visual("int.brass", lightX, shadeY - 0.075, lightZ, shade * 0.48, 0.025, shade * 0.48);
    }
  };

  ceilingLight();
  if (["parlor", "dining", "bedroom", "office", "loft", "retail", "hall"].includes(role)) rug();
  // A large open loft needs more than the same single rug budget as a compact
  // bedroom. Keep a second zone deeper in the plan, away from the arrival rug.
  if (role === "loft" && roomArea > 150 && (!focus || Math.hypot(cx - focus.x, cz - focus.z) > 2.2))
    rug(cx, cz, Math.min(4.6, w * 0.48), Math.min(3.0, d * 0.38));

  switch (role) {
    case "parlor": sofa(); lowTable(); bookcase(); if (style.tier >= 1) plant(); break;
    case "dining": diningSet(); consoleTable(); if (style.tier >= 1) plant(); break;
    case "kitchen": counter("kitchen-counter", 2.45); consoleTable("pantry"); if (style.tier >= 1) plant(); break;
    case "hall": consoleTable(); if (style.tier >= 1) bookcase(); plant(); break;
    case "bedroom": bed(); consoleTable("nightstand"); if (style.tier >= 1) plant(); break;
    case "bath": counter("vanity", 1.25, "int.ceramic"); bathFixture(); break;
    case "retail": counter("service-counter", 2.6); bookcase(); bookcase(); if (style.tier >= 1) plant(); break;
    case "office": diningSet(true); bookcase(); if (style.tier >= 1) plant(); break;
    case "loft":
      diningSet(true); sofa(); lowTable(); bookcase(); plant();
      if (roomArea > 105) { sofa(); bookcase(); consoleTable("studio-table"); plant(); }
      if (roomArea > 210) { diningSet(); bookcase(); plant(); }
      break;
    case "stair": consoleTable(); if (style.tier >= 1) plant(); break;
  }

  // Art is selected after furniture. A dedicated wall-opening list rejects
  // windows/doors/portals without treating the walkable floor below as blank wall.
  const artCount = (style.tier === 2 ? 3 : style.tier === 1 ? 2 : 1)
    + (role === "loft" && roomArea > 180 ? 2 : role === "loft" && roomArea > 100 ? 1 : 0);
  const artWidth = Math.min(1.45, 0.78 * style.artScale);
  const candidates: { spot: ArtSpot; foot: Rect }[] = [];
  for (const t of [0.15, 0.3, 0.45, 0.6, 0.75, 0.9]) {
    const ax = cell.x0 + rectW(cell) * t, az = cell.z0 + rectD(cell) * t;
    candidates.push(
      { spot: { x: cell.x0 + 0.055, z: az, normal: [1, 0, 0] }, foot: rectAround(cell.x0 + 0.08, az, 0.16, artWidth) },
      { spot: { x: cell.x1 - 0.055, z: az, normal: [-1, 0, 0] }, foot: rectAround(cell.x1 - 0.08, az, 0.16, artWidth) },
      { spot: { x: ax, z: cell.z0 + 0.055, normal: [0, 0, 1] }, foot: rectAround(ax, cell.z0 + 0.08, artWidth, 0.16) },
      { spot: { x: ax, z: cell.z1 - 0.055, normal: [0, 0, -1] }, foot: rectAround(ax, cell.z1 - 0.08, artWidth, 0.16) },
    );
  }
  let hung = 0;
  const orderedArt = shuffled(candidates, r);
  if (focus && entryFocus) {
    // Rank pictures by the actual arrival cone, not merely proximity. A nearby
    // side-wall picture can be 80° off camera while a slightly farther one is a
    // perfect focal piece. Also prefer a face whose normal points back toward
    // the entrant, so the coloured field—not its paper-thin edge—is what reads.
    const viewScore = (c: { spot: ArtSpot }) => {
      const vx = c.spot.x - entryFocus.point[0], vz = c.spot.z - entryFocus.point[1];
      const forward = vx * entryFocus.inward[0] + vz * entryFocus.inward[1];
      const lateral = Math.abs(vx * -entryFocus.inward[1] + vz * entryFocus.inward[0]);
      const angle = Math.atan2(lateral, Math.max(0.05, forward));
      const toEyeX = entryFocus.point[0] - c.spot.x, toEyeZ = entryFocus.point[1] - c.spot.z;
      const face = c.spot.normal[0] * toEyeX + c.spot.normal[2] * toEyeZ;
      return (forward <= 0.35 ? 100 : 0) + (face <= 0.05 ? 20 : 0) + angle * 12 + Math.hypot(vx, vz) * 0.025;
    };
    orderedArt.sort((a, b) => viewScore(a) - viewScore(b));
  }
  for (const c of orderedArt) {
    // Pictures have no collider, so a floor circulation strip should not veto
    // them. Only real wall openings—windows, portals and the front door—belong
    // in this separate blocker list.
    if (hung >= artCount || artKeepouts.some((b) => overlaps(c.foot, b))) continue;
    hangArt(out, c.spot, r, floorY, style.artScale);
    hung++;
  }
  return occupied;
}
