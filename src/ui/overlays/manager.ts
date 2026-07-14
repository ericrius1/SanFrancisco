/**
 * Debug overlay manager — gathers physics / raycast / context-sensitive site
 * overlays into WebGPU line buffers. Toggles live in OVERLAY_TUNING ("/" → overlays).
 *
 * Colours (physics · buildings / walls):
 *   red    = baked building body (visual tile stream)
 *   orange = baked building body (citywide index)
 *   green  = CityGen walk-in wall / roof
 *   blue   = CityGen interior
 *   yellow = ground carpet slabs
 *   magenta = player dynamic body
 *   cyan   = interaction raycast
 *   teal   = tea garden water spatial grid / feature seams
 */
import type * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { Player } from "../../player/player";
import { WALK_CAPSULE_HALF_HEIGHT, WALK_CAPSULE_RADIUS } from "../../player/walk";
import { driveHalfExtentsWithClearance } from "../../vehicles/shared";
import {
  teaGardenWaterDistance,
  teaGardenWaterSpatialLayout
} from "../../world/japaneseTeaGarden/layout";
import { anyOverlayActive, OVERLAY_TUNING } from "./tuning";
import {
  LineOverlay,
  type DebugBox,
  type DebugMesh,
  type DebugPolyline
} from "./lineOverlay";

export type OverlaySyncContext = {
  physics: Physics;
  player: Player;
  /** CityGen ring debugColliders, if the ring is live. */
  citygenDebug?: (
    walls: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }[],
    interiors: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }[],
    roofs: { x: number; y: number; z: number; vertices: number[]; indices: number[] }[]
  ) => void;
  /** Latest interaction ray (origin → hit or miss float). */
  ray?: {
    origin: { x: number; y: number; z: number };
    hit: { x: number; y: number; z: number } | null;
    dir: { x: number; y: number; z: number };
    maxDist: number;
  };
  /** Sample ground/water surface Y for grid overlay lines. */
  sampleY?: (x: number, z: number) => number;
};

export type OverlayContextFlags = {
  teaGardenWater: boolean;
};

const TEA_GARDEN_WATER_NEAR_M = 90;
const CARPET_RADIUS_M = 48;
const GRID_STRIDE = 8;

export class DebugOverlays {
  #physics: LineOverlay;
  #carpet: LineOverlay;
  #player: LineOverlay;
  #ray: LineOverlay;
  #water: LineOverlay;

  #boxes: DebugBox[] = [];
  #meshes: DebugMesh[] = [];
  #polylines: DebugPolyline[] = [];
  #dbgBaked: {
    x: number;
    y: number;
    z: number;
    hx: number;
    hy: number;
    hz: number;
    yaw: number;
    index: boolean;
  }[] = [];
  #dbgWalls: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number }[] =
    [];
  #dbgInteriors: {
    x: number;
    y: number;
    z: number;
    hx: number;
    hy: number;
    hz: number;
    yaw: number;
  }[] = [];
  #dbgRoofs: {
    x: number;
    y: number;
    z: number;
    vertices: number[];
    indices: number[];
  }[] = [];
  #dbgCarpet: {
    x: number;
    y: number;
    z: number;
    hx: number;
    hy: number;
    hz: number;
    quat: [number, number, number, number];
    kind: "cell" | "sub" | "sub2";
  }[] = [];

  #context: OverlayContextFlags = { teaGardenWater: false };
  #waterLayout = teaGardenWaterSpatialLayout();

  constructor(scene: THREE.Object3D) {
    this.#physics = new LineOverlay(scene, "overlay_physics_colliders");
    this.#carpet = new LineOverlay(scene, "overlay_physics_carpet");
    this.#player = new LineOverlay(scene, "overlay_player_body");
    this.#ray = new LineOverlay(scene, "overlay_raycast");
    this.#water = new LineOverlay(scene, "overlay_tea_garden_water_grid");
  }

  get context(): Readonly<OverlayContextFlags> {
    return this.#context;
  }

  /** Update proximity; returns true when flags changed (pane should re-filter). */
  updateContext(playerX: number, playerZ: number): boolean {
    const teaGardenWater =
      teaGardenWaterDistance(playerX, playerZ) <= TEA_GARDEN_WATER_NEAR_M;
    const changed = teaGardenWater !== this.#context.teaGardenWater;
    this.#context = { teaGardenWater };
    return changed;
  }

  sync(ctx: OverlaySyncContext): void {
    const v = OVERLAY_TUNING.values;
    if (!anyOverlayActive()) {
      this.#physics.setVisible(false);
      this.#carpet.setVisible(false);
      this.#player.setVisible(false);
      this.#ray.setVisible(false);
      this.#water.setVisible(false);
      return;
    }

    const wantPhysics = Boolean(v.physicsColliders);
    this.#physics.setVisible(wantPhysics);
    if (wantPhysics) {
      this.#boxes.length = 0;
      this.#meshes.length = 0;
      ctx.physics.debugBuildingBodies(this.#dbgBaked);
      for (const b of this.#dbgBaked) {
        this.#boxes.push({
          ...b,
          r: 1,
          g: b.index ? 0.55 : 0.12,
          b: 0.12
        });
      }
      if (ctx.citygenDebug) {
        ctx.citygenDebug(this.#dbgWalls, this.#dbgInteriors, this.#dbgRoofs);
        for (const c of this.#dbgWalls) {
          this.#boxes.push({ ...c, r: 0.15, g: 1, b: 0.3 });
        }
        for (const c of this.#dbgInteriors) {
          this.#boxes.push({ ...c, r: 0.25, g: 0.55, b: 1 });
        }
        for (const c of this.#dbgRoofs) {
          this.#meshes.push({ ...c, r: 0.15, g: 1, b: 0.3 });
        }
      }
      this.#physics.sync(this.#boxes, this.#meshes);
    }

    const wantCarpet = Boolean(v.physicsCarpet);
    this.#carpet.setVisible(wantCarpet);
    if (wantCarpet) {
      this.#boxes.length = 0;
      ctx.physics.debugCarpet(
        this.#dbgCarpet,
        ctx.player.position.x,
        ctx.player.position.z,
        CARPET_RADIUS_M
      );
      for (const c of this.#dbgCarpet) {
        const tint =
          c.kind === "cell"
            ? { r: 1, g: 0.92, b: 0.2 }
            : c.kind === "sub"
              ? { r: 1, g: 0.7, b: 0.15 }
              : { r: 1, g: 0.85, b: 0.55 };
        this.#boxes.push({
          x: c.x,
          y: c.y,
          z: c.z,
          hx: c.hx,
          hy: c.hy,
          hz: c.hz,
          quat: c.quat,
          ...tint
        });
      }
      this.#carpet.sync(this.#boxes);
    }

    const wantPlayer = Boolean(v.playerBody);
    this.#player.setVisible(wantPlayer);
    if (wantPlayer && ctx.player.body) {
      this.#boxes.length = 0;
      const t = ctx.physics.world.getBodyTransform(ctx.player.body);
      const [hx, hy, hz] = playerBodyHalfExtents(ctx.player);
      const yaw = yawFromQuat(t.rotation);
      this.#boxes.push({
        x: t.position[0],
        y: t.position[1],
        z: t.position[2],
        hx,
        hy,
        hz,
        yaw,
        r: 1,
        g: 0.2,
        b: 1
      });
      this.#player.sync(this.#boxes);
    } else if (wantPlayer) {
      this.#player.clear();
    }

    const wantRay = Boolean(v.raycast);
    this.#ray.setVisible(wantRay);
    if (wantRay && ctx.ray) {
      this.#polylines.length = 0;
      this.#boxes.length = 0;
      const { origin, hit, dir, maxDist } = ctx.ray;
      const end = hit ?? {
        x: origin.x + dir.x * maxDist,
        y: origin.y + dir.y * maxDist,
        z: origin.z + dir.z * maxDist
      };
      this.#polylines.push({
        points: [origin.x, origin.y, origin.z, end.x, end.y, end.z],
        r: 0.15,
        g: 0.95,
        b: 1
      });
      if (hit) {
        this.#boxes.push({
          x: hit.x,
          y: hit.y,
          z: hit.z,
          hx: 0.08,
          hy: 0.08,
          hz: 0.08,
          yaw: 0,
          r: 0.2,
          g: 1,
          b: 1
        });
      }
      this.#ray.sync(this.#boxes, [], this.#polylines);
    } else if (wantRay) {
      this.#ray.clear();
    }

    const wantWater = Boolean(v.teaGardenWaterGrid) && this.#context.teaGardenWater;
    this.#water.setVisible(wantWater);
    if (wantWater) {
      this.#polylines.length = 0;
      buildWaterGridPolylines(
        this.#waterLayout,
        this.#polylines,
        ctx.sampleY ?? (() => ctx.player.position.y)
      );
      this.#water.sync([], [], this.#polylines);
    }
  }

  dispose(): void {
    this.#physics.dispose();
    this.#carpet.dispose();
    this.#player.dispose();
    this.#ray.dispose();
    this.#water.dispose();
  }
}

function playerBodyHalfExtents(player: Player): [number, number, number] {
  if (player.mode === "walk") {
    return [
      WALK_CAPSULE_RADIUS,
      WALK_CAPSULE_HALF_HEIGHT + WALK_CAPSULE_RADIUS,
      WALK_CAPSULE_RADIUS
    ];
  }
  return driveHalfExtentsWithClearance(player.driveSpec.rideHeight, player.driveSpec.halfExtents);
}

function yawFromQuat(q: readonly [number, number, number, number]): number {
  const siny = 2 * (q[3] * q[1] + q[0] * q[2]);
  const cosy = 1 - 2 * (q[1] * q[1] + q[0] * q[0]);
  return Math.atan2(siny, cosy);
}

type WaterLayout = ReturnType<typeof teaGardenWaterSpatialLayout>;

function buildWaterGridPolylines(
  layout: WaterLayout,
  out: DebugPolyline[],
  sampleY: (x: number, z: number) => number
): void {
  const { minX, maxX, minZ, maxZ, gridWidth, gridHeight, cellSizeX, cellSizeZ, outlines } =
    layout;
  const lift = 0.12;
  const yAt = (x: number, z: number) => sampleY(x, z) + lift;

  const y00 = yAt(minX, minZ);
  const y10 = yAt(maxX, minZ);
  const y11 = yAt(maxX, maxZ);
  const y01 = yAt(minX, maxZ);
  out.push({
    points: [
      minX, y00, minZ,
      maxX, y10, minZ,
      maxX, y11, maxZ,
      minX, y01, maxZ,
      minX, y00, minZ
    ],
    r: 0.2,
    g: 0.95,
    b: 0.85
  });

  for (let gx = 0; gx < gridWidth; gx += GRID_STRIDE) {
    const x = minX + gx * cellSizeX;
    const pts: number[] = [];
    for (let gz = 0; gz < gridHeight; gz += GRID_STRIDE) {
      const z = minZ + gz * cellSizeZ;
      pts.push(x, yAt(x, z), z);
    }
    if (pts.length >= 6) out.push({ points: pts, r: 0.15, g: 0.7, b: 0.75 });
  }
  for (let gz = 0; gz < gridHeight; gz += GRID_STRIDE) {
    const z = minZ + gz * cellSizeZ;
    const pts: number[] = [];
    for (let gx = 0; gx < gridWidth; gx += GRID_STRIDE) {
      const x = minX + gx * cellSizeX;
      pts.push(x, yAt(x, z), z);
    }
    if (pts.length >= 6) out.push({ points: pts, r: 0.15, g: 0.7, b: 0.75 });
  }

  for (const outline of outlines) {
    if (outline.length < 2) continue;
    const pts: number[] = [];
    for (const [x, z] of outline) pts.push(x, yAt(x, z), z);
    const [fx, fz] = outline[0];
    pts.push(fx, yAt(fx, fz), fz);
    out.push({ points: pts, r: 0.35, g: 1, b: 0.55 });
  }
}
