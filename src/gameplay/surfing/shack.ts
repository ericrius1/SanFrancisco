/**
 * Placeholder Ocean Beach surf shack: a simple open-front shed with three
 * racked boards. Walk up, press E on a board, and the caller starts surfing.
 */
import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { formatInteractPrompt } from "../../core/input";
import type { Player } from "../../player/player";
import type { HUD } from "../../ui/hud";
import {
  buildSurfboardMesh,
  normalizeSurfboardConfig,
  type SurfboardConfig,
  type SurfboardShape
} from "../../vehicles/surf";
import { enableLocalShadowLayer } from "../../world/shadows/shadowLayers";
import {
  OCEAN_BEACH_SURF,
  oceanBeachApproxShoreX,
  oceanBeachShoreline
} from "../../world/oceanBeachWaves";

type Ground = {
  groundTop(x: number, z: number): number;
  isWater(x: number, z: number): boolean;
};

/** Metres east of the live shoreline to the shack building centre. */
export const SURF_SHACK_INLAND = 20;
/** Metres east of the shoreline for the spawn / exit apron (facing the boards). */
export const SURF_SHACK_APRON_INLAND = 17;
/** Reach to grab a racked board. */
export const SURF_BOARD_REACH = 2.6;

const MAT = {
  wood: new THREE.MeshLambertMaterial({ color: 0x6b4a2f }),
  woodLight: new THREE.MeshLambertMaterial({ color: 0x8a6b45 }),
  roof: new THREE.MeshLambertMaterial({ color: 0x5a4030 }),
  sand: new THREE.MeshLambertMaterial({ color: 0xc4a574 })
};
const CASTING = new Set<THREE.Material>([MAT.wood, MAT.woodLight, MAT.roof]);

const BOARD_PRESETS: { shape: SurfboardShape; label: string; config: Partial<SurfboardConfig> }[] = [
  {
    shape: "fish",
    label: "fish",
    config: {
      shape: "fish",
      base: 2,
      rail: 5,
      accent: 4,
      surface: "sunset-caustics",
      decal: "none"
    }
  },
  {
    shape: "shortboard",
    label: "shortboard",
    config: {
      shape: "shortboard",
      base: 1,
      rail: 0,
      accent: 2,
      surface: "kelp-ribbons",
      decal: "none"
    }
  },
  {
    shape: "longboard",
    label: "longboard",
    config: {
      shape: "longboard",
      base: 0,
      rail: 1,
      accent: 3,
      surface: "pacific-postcard",
      decal: "none"
    }
  }
];

export type SurfShackPose = { x: number; z: number; heading: number };

/** Approx apron pose without a live map (spawn registry). */
export function oceanBeachSurfShackApproxPose(): SurfShackPose {
  const z = OCEAN_BEACH_SURF.entryZ;
  return {
    x: oceanBeachApproxShoreX(z) + SURF_SHACK_APRON_INLAND,
    z,
    heading: -Math.PI / 2 // east, toward the open shack front
  };
}

/** Live shoreline-refined apron pose (boot, landmark, surf exit). */
export function oceanBeachSurfShackPose(map: { isWater(x: number, z: number): boolean }): SurfShackPose {
  const shore = oceanBeachShoreline(map, OCEAN_BEACH_SURF.entryZ, 3);
  return {
    x: shore.x + (SURF_SHACK_APRON_INLAND - 3),
    z: shore.z,
    heading: -Math.PI / 2
  };
}

type BoardSlot = {
  config: SurfboardConfig;
  label: string;
  x: number;
  z: number;
  mesh: THREE.Group;
};

export type SurfShack = {
  group: THREE.Group;
  pose: SurfShackPose;
  tryInteract: (
    player: Player,
    hud: HUD,
    startSurf: (config: SurfboardConfig) => void
  ) => boolean;
  nearbyPrompt: (x: number, z: number, device?: "kb" | "pad") => string | null;
  dispose: () => void;
};

export function createSurfShack(map: Ground): SurfShack {
  const shore = oceanBeachShoreline(map, OCEAN_BEACH_SURF.entryZ, 3);
  const apronX = shore.x + (SURF_SHACK_APRON_INLAND - 3);
  const shackX = shore.x + (SURF_SHACK_INLAND - 3);
  const z = shore.z;
  const groundY = map.groundTop(shackX, z);
  const pose: SurfShackPose = { x: apronX, z, heading: -Math.PI / 2 };

  const group = new THREE.Group();
  group.name = "ocean-beach-surf-shack";

  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const putE = (
    mat: THREE.Material,
    geo: THREE.BufferGeometry,
    x: number,
    y: number,
    zz: number,
    rx = 0,
    ry = 0,
    rz = 0
  ) => {
    geo.rotateX(rx);
    geo.rotateY(ry);
    geo.rotateZ(rz);
    geo.translate(x, y, zz);
    const list = buckets.get(mat);
    if (list) list.push(geo);
    else buckets.set(mat, [geo]);
  };

  // Open-front shed facing west (ocean). Player approaches from the apron.
  const wallY = groundY + 1.35;
  putE(MAT.wood, new THREE.BoxGeometry(0.12, 2.7, 4.2), shackX + 1.6, wallY, z); // back
  putE(MAT.wood, new THREE.BoxGeometry(3.4, 2.7, 0.12), shackX, wallY, z - 2.1); // south
  putE(MAT.wood, new THREE.BoxGeometry(3.4, 2.7, 0.12), shackX, wallY, z + 2.1); // north
  // Short side posts frame the open west face
  putE(MAT.woodLight, new THREE.BoxGeometry(0.14, 2.7, 0.14), shackX - 1.55, wallY, z - 2.0);
  putE(MAT.woodLight, new THREE.BoxGeometry(0.14, 2.7, 0.14), shackX - 1.55, wallY, z + 2.0);
  // Roof slab + slight overhang toward the ocean
  putE(MAT.roof, new THREE.BoxGeometry(4.0, 0.12, 4.6), shackX - 0.15, groundY + 2.78, z, 0, 0, -0.08);
  // Deck planks
  putE(MAT.woodLight, new THREE.BoxGeometry(3.6, 0.08, 4.0), shackX, groundY + 0.04, z);
  // Sand apron marker
  putE(MAT.sand, new THREE.BoxGeometry(2.4, 0.03, 3.2), apronX + 0.4, map.groundTop(apronX, z) + 0.015, z);

  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = CASTING.has(mat);
    if (mesh.castShadow) enableLocalShadowLayer(mesh);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // Lean-to rack rail just inside the open front
  const rackX = shackX - 1.35;
  const rackY = groundY + 0.15;
  const rail = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.08, 3.4),
    MAT.woodLight
  );
  rail.position.set(rackX, rackY + 0.95, z);
  rail.castShadow = true;
  enableLocalShadowLayer(rail);
  group.add(rail);

  const boardSlots: BoardSlot[] = [];
  for (const [i, preset] of BOARD_PRESETS.entries()) {
    const config = normalizeSurfboardConfig(preset.config);
    const mesh = buildSurfboardMesh(config);
    const slotZ = z + (i - 1) * 1.05;
    // Nose up, deck facing west (ocean) so the apron approach reads the graphic.
    mesh.rotation.order = "YXZ";
    mesh.rotation.set(-Math.PI / 2, Math.PI / 2, 0.12);
    mesh.position.set(rackX + 0.08, rackY + 1.15, slotZ);
    group.add(mesh);
    boardSlots.push({ config, label: preset.label, x: rackX, z: slotZ, mesh });
  }

  const nearestBoard = (x: number, zz: number): BoardSlot | null => {
    let best: BoardSlot | null = null;
    let bestD = SURF_BOARD_REACH;
    for (const slot of boardSlots) {
      const d = Math.hypot(x - slot.x, zz - slot.z);
      if (d < bestD) {
        bestD = d;
        best = slot;
      }
    }
    return best;
  };

  return {
    group,
    pose,
    tryInteract(player, hud, startSurf) {
      if (player.mode !== "walk") return false;
      const p = player.renderPosition;
      const slot = nearestBoard(p.x, p.z);
      if (!slot) return false;
      startSurf(slot.config);
      hud.message(
        `Grabbed the ${slot.label} — A/D carve: beach side = speed, wave side = climb · Space jumps · E exits`,
        4
      );
      return true;
    },
    nearbyPrompt(x, zz, device = "kb") {
      const slot = nearestBoard(x, zz);
      if (!slot) return null;
      return formatInteractPrompt(`grab the ${slot.label}`, device);
    },
    dispose() {
      group.removeFromParent();
      for (const slot of boardSlots) {
        (slot.mesh.userData.dispose as (() => void) | undefined)?.();
      }
      group.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
      });
    }
  };
}
