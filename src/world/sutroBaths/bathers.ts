import * as THREE from "three/webgpu";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseIdle, poseSwim, type Rig } from "../../player/rig";
import { SUTRO_BATHS, SUTRO_POOLS, sutroLocalToWorld, type SutroPoolSpec } from "./layout";
import { applyBathingCostume, type CostumeInfo } from "./bathingCostume";

/**
 * Ambient NPC bathers around the restored Sutro pools. A dozen procedural
 * figures — deck loafers, poolside sitters, swimmers doing a slow crawl, a
 * couple of waders at the edge and one poised to dive — each wearing a unique
 * early-1900s bathing costume from {@link applyBathingCostume}.
 *
 * PLACEMENT CONVENTION (read this before tweaking the table):
 *  - Positions are authored in POOL-LOCAL coordinates and converted with
 *    `sutroLocalToWorld`. `pool` names the rect they belong to (see SUTRO_POOLS);
 *    `lx`/`lz` are local metres, so a swimmer at the pool centre is roughly
 *    ((minX+maxX)/2, (minZ+maxZ)/2).
 *  - The rig origin sits at hip height, RIG_STAND_Y (0.92 m) above the feet, so
 *    a stander's group Y = surfaceY + RIG_STAND_Y to plant its feet on the deck.
 *  - `face` is an extra yaw (radians) added to the site yaw; face = 0 looks
 *    along local -Z (north). rotation.y = SUTRO_BATHS.yaw + face.
 *
 * Cheap by construction: rigs keep matrixWorldAutoUpdate off and only refresh
 * their matrices after posing; small boxes are shadow-dieted; nothing loads
 * media. The whole set is gated by index.ts (constructed under the baths root,
 * updated only while the site is awake).
 */

const RIG_STAND_Y = 0.92; // rig group origin (hips) above the feet
const CASTER_MIN_VOLUME = 1.5e-3;

type BatherPose = "idle" | "sit" | "swim" | "wade" | "dive";

type BatherSpec = {
  seed: string;
  pool: string; // SUTRO_POOLS id, or "deck" for a free deck position
  lx: number; // pool-local X (metres)
  lz: number; // pool-local Z (metres)
  face: number; // extra yaw over the site yaw
  pose: BatherPose;
  /** Swimmers: local-axis drift (metres/sec along +z) — clamped inside the rect. */
  drift?: number;
};

// A hand-placed cast spread across the warm baths and the great plunge. Local
// coordinates read against SUTRO_POOLS rects in layout.ts.
const BATHERS: readonly BatherSpec[] = [
  // ---- great salt-water plunge (id great-plunge, x[-31,-10] z[-55,29]) ----
  { seed: "sutro-swim-1", pool: "great-plunge", lx: -22, lz: -30, face: Math.PI, pose: "swim", drift: 0.9 },
  { seed: "sutro-swim-2", pool: "great-plunge", lx: -18, lz: 6, face: 0, pose: "swim", drift: -0.82 },
  { seed: "sutro-swim-3", pool: "great-plunge", lx: -25, lz: -8, face: Math.PI, pose: "swim", drift: 0.76 },
  { seed: "sutro-sit-1", pool: "great-plunge", lx: -32.2, lz: -20, face: -1.55, pose: "sit" }, // west coping, feet to water
  { seed: "sutro-dive-1", pool: "great-plunge", lx: -32.6, lz: 14, face: -1.4, pose: "dive" }, // west edge, poised
  { seed: "sutro-wade-1", pool: "great-plunge", lx: -12.5, lz: 22, face: 2.9, pose: "wade" }, // east shallow step

  // ---- warm graduated baths (east row, x[-4,19]) --------------------------
  { seed: "sutro-sit-2", pool: "bath-two", lx: 7.5, lz: -38.6, face: 0.05, pose: "sit" }, // north coping of bath II
  { seed: "sutro-swim-4", pool: "bath-three", lx: 8, lz: -14.5, face: Math.PI, pose: "swim", drift: 0.72 },
  { seed: "sutro-wade-2", pool: "bath-four", lx: -2.4, lz: 3.5, face: 1.5, pose: "wade" }, // west edge of hot bath IV
  { seed: "sutro-sit-3", pool: "bath-five", lx: 12, lz: 27.4, face: Math.PI, pose: "sit" }, // south coping of hot bath V

  // ---- deck loafers (feet on the deck, between pools) ---------------------
  { seed: "sutro-idle-1", pool: "deck", lx: -6.5, lz: -30, face: 1.5, pose: "idle" },
  { seed: "sutro-idle-2", pool: "deck", lx: 22, lz: -12, face: -1.6, pose: "idle" },
  { seed: "sutro-idle-3", pool: "deck", lx: -6.5, lz: 12, face: 1.5, pose: "idle" }
] as const;

function poolById(id: string): SutroPoolSpec | undefined {
  return SUTRO_POOLS.find((p) => p.id === id);
}

/** Feet-surface height for a pose. Deck poses stand on the deck; sitters perch
 *  on the coping at deck level; swimmers float at the waterline; waders step
 *  down onto a submerged ledge. */
function surfaceForPose(pose: BatherPose): number {
  switch (pose) {
    case "swim":
      return SUTRO_BATHS.waterY + 0.3 - RIG_STAND_Y; // group Y ends near waterline
    case "sit":
      return SUTRO_BATHS.deckY - RIG_STAND_Y + 0.14; // hips ~ deck level
    case "wade":
      return SUTRO_BATHS.waterY - 0.48; // feet below the surface on a shallow ledge
    case "idle":
    case "dive":
    default:
      return SUTRO_BATHS.deckY;
  }
}

type Bather = {
  rig: Rig;
  costume: CostumeInfo;
  spec: BatherSpec;
  pool: SutroPoolSpec | null;
  group: THREE.Group; // === rig.group; positioned + yawed in world
  phase: number; // per-bather pose-time offset (desync)
  baseY: number; // resting group Y (bob rides on top)
  local: { x: number; z: number }; // live pool-local position (swimmers drift)
  drift: number; // live signed swim speed; flips at pool ends
};

// ---- manual poses the rig has no helper for ---------------------------------

/** Poolside sitter: perched on the coping, thighs forward, shins hanging, hands
 *  resting on the knees, a slow breathing sway. (No rig helper exists — set the
 *  joints directly, per handpanist.ts.) */
function poseSit(r: Rig, t: number) {
  const breathe = Math.sin(t * 1.3);
  r.hips.position.y = 0;
  r.hips.rotation.set(0.12, 0, 0);
  r.torso.rotation.set(0.06 + breathe * 0.02, Math.sin(t * 0.4) * 0.05, 0);
  r.head.rotation.set(0.08 + breathe * 0.015, Math.sin(t * 0.33) * 0.14, 0);
  r.legL.rotation.set(1.34, 0, 0.05);
  r.legR.rotation.set(1.3, 0, -0.05);
  r.shinL.rotation.set(-1.02, 0, 0);
  r.shinR.rotation.set(-0.98, 0, 0);
  // forearms down onto the knees
  r.armL.rotation.set(0.62 + breathe * 0.02, 0, 0.16);
  r.armR.rotation.set(0.62 - breathe * 0.02, 0, -0.16);
  r.foreL.rotation.set(0.7, 0, 0);
  r.foreR.rotation.set(0.7, 0, 0);
}

/** Wader: standing knee-deep, gently shifting weight, arms held a little out for
 *  balance against the water. */
function poseWade(r: Rig, t: number) {
  const sway = Math.sin(t * 0.9);
  r.hips.position.y = 0;
  r.hips.rotation.set(0.02, sway * 0.03, sway * 0.02);
  r.torso.rotation.set(0.05, sway * 0.04, -sway * 0.03);
  r.head.rotation.set(0.04, Math.sin(t * 0.5) * 0.12, 0);
  r.legL.rotation.set(0.06, 0, 0.03);
  r.legR.rotation.set(-0.04, 0, -0.03);
  r.shinL.rotation.set(-0.08, 0, 0);
  r.shinR.rotation.set(-0.05, 0, 0);
  r.armL.rotation.set(0.15, 0, 0.34 + sway * 0.04);
  r.armR.rotation.set(0.15, 0, -0.34 - sway * 0.04);
  r.foreL.rotation.set(0.55, 0, 0);
  r.foreR.rotation.set(0.55, 0, 0);
}

/** Diver poised at the pool edge: crouched forward, arms swept up overhead,
 *  small anticipatory rock. */
function poseDive(r: Rig, t: number) {
  const rock = Math.sin(t * 1.1) * 0.05;
  r.hips.position.y = -0.05;
  r.hips.rotation.set(0.22 + rock, 0, 0);
  r.torso.rotation.set(0.42, 0, 0);
  r.head.rotation.set(-0.5, 0, 0); // eyes on the water
  r.legL.rotation.set(0.3, 0, 0.05);
  r.legR.rotation.set(0.3, 0, -0.05);
  r.shinL.rotation.set(-0.6, 0, 0);
  r.shinR.rotation.set(-0.6, 0, 0);
  // arms overhead, hands together to point the dive
  r.armL.rotation.set(-2.7 + rock * 0.3, 0, 0.14);
  r.armR.rotation.set(-2.7 + rock * 0.3, 0, -0.14);
  r.foreL.rotation.set(0.1, 0, 0);
  r.foreR.rotation.set(0.1, 0, 0);
}

function applyPose(b: Bather, poseT: number) {
  switch (b.spec.pose) {
    case "swim":
      // A little over two pose cycles per authored second reads as an active
      // crawl at game-camera distance instead of a nearly frozen float.
      poseSwim(b.rig, poseT * 2.15);
      break;
    case "sit":
      poseSit(b.rig, poseT);
      break;
    case "wade":
      poseWade(b.rig, poseT);
      break;
    case "dive":
      poseDive(b.rig, poseT);
      break;
    case "idle":
    default:
      poseIdle(b.rig, poseT);
      break;
  }
}

/** Size-based caster diet: only chunky parts shadow-cast (matches buskers). */
function applyShadowDiet(root: THREE.Object3D) {
  const size = new THREE.Vector3();
  const scale = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    geo.boundingBox!.getSize(size);
    mesh.getWorldScale(scale);
    const volume = Math.abs(size.x * scale.x) * Math.abs(size.y * scale.y) * Math.abs(size.z * scale.z);
    if (volume < CASTER_MIN_VOLUME) mesh.castShadow = false;
  });
}

export type SutroBathers = {
  group: THREE.Group;
  update(dt: number, time: number, player?: THREE.Object3D): void;
  visitSwimmers(visitor: (x: number, z: number, vx: number, vz: number) => void): void;
  dispose(): void;
};

export function createSutroBathers(_opts: Record<string, never> = {}): SutroBathers {
  const group = new THREE.Group();
  group.name = "sutroBaths.bathers";

  const bathers: Bather[] = [];

  for (const spec of BATHERS) {
    const pool = spec.pool === "deck" ? null : poolById(spec.pool) ?? null;
    const rig = buildRig(avatarFromSeed(spec.seed));
    const costume = applyBathingCostume(rig, spec.seed);

    const world = sutroLocalToWorld(spec.lx, spec.lz);
    const baseY = surfaceForPose(spec.pose) + RIG_STAND_Y;
    rig.group.position.set(world.x, baseY, world.z);
    rig.group.rotation.y = SUTRO_BATHS.yaw + spec.face;

    // settle into a frame-0 pose so nothing pops before the first update
    const phase = (Math.abs(hashPhase(spec.seed)) % 1000) / 1000 * Math.PI * 2;
    const b: Bather = {
      rig,
      costume,
      spec,
      pool,
      group: rig.group,
      phase,
      baseY,
      local: { x: spec.lx, z: spec.lz },
      drift: spec.drift ?? 0
    };
    applyPose(b, phase);

    applyShadowDiet(rig.group);
    rig.group.matrixWorldAutoUpdate = false;
    rig.group.updateMatrixWorld(true);
    group.add(rig.group);
    bathers.push(b);
  }

  // scratch for the optional head-turn toward the player (alloc-free updates)
  const playerWorld = new THREE.Vector3();

  function update(dt: number, time: number, player?: THREE.Object3D) {
    if (player) player.getWorldPosition(playerWorld);
    let nearest: Bather | null = null;
    let nearestD = 14 * 14; // only the closest, and only if within ~14 m

    for (const b of bathers) {
      const poseT = time + b.phase;

      // swimmers drift along the pool's local +z and gently bob with the water
      if (b.spec.pose === "swim" && b.pool) {
        if (b.drift) {
          let z = b.local.z + b.drift * dt;
          const margin = 3.5;
          // bounce off the pool ends so they never leave the rect
          if (z > b.pool.maxZ - margin || z < b.pool.minZ + margin) {
            b.drift = -b.drift;
            z = Math.max(b.pool.minZ + margin, Math.min(b.pool.maxZ - margin, z));
          }
          b.local.z = z;
          const w = sutroLocalToWorld(b.local.x, b.local.z);
          b.group.position.x = w.x;
          b.group.position.z = w.z;
          b.group.rotation.y = SUTRO_BATHS.yaw + (b.drift >= 0 ? Math.PI : 0);
        }
        b.group.position.y = b.baseY + Math.sin(poseT * 0.8) * 0.05;
      }

      applyPose(b, poseT);

      if (player) {
        const dx = b.group.position.x - playerWorld.x;
        const dz = b.group.position.z - playerWorld.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearestD) {
          nearestD = d2;
          nearest = b;
        }
      }

      // refresh matrices for this frame (auto-update stays off otherwise)
      b.group.updateMatrixWorld(true);
    }

    // let the closest bather glance at the player
    if (nearest && player) {
      const dx = playerWorld.x - nearest.group.position.x;
      const dz = playerWorld.z - nearest.group.position.z;
      const wantYaw = Math.atan2(dx, dz) - nearest.group.rotation.y;
      const clamped = Math.max(-0.7, Math.min(0.7, Math.atan2(Math.sin(wantYaw), Math.cos(wantYaw))));
      nearest.rig.head.rotation.y += clamped * 0.5;
      nearest.group.updateMatrixWorld(true);
    }
  }

  function dispose() {
    // NOTE: rig box geometries come from a module-level cache shared by every
    // rig (rig.ts boxGeo) — we must NOT dispose them here. The costume owns and
    // frees its own (uncached) geometries + materials via costume.dispose(). We
    // only free the rig's per-rig MeshLambert material slots.
    const mats = new Set<THREE.Material>();
    for (const b of bathers) {
      b.costume.dispose();
      b.group.removeFromParent();
      b.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const m = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) m.forEach((mm) => mats.add(mm));
        else if (m) mats.add(m);
      });
    }
    for (const m of mats) m.dispose();
    bathers.length = 0;
    group.removeFromParent();
  }

  function visitSwimmers(visitor: (x: number, z: number, vx: number, vz: number) => void) {
    const s = Math.sin(SUTRO_BATHS.yaw);
    const c = Math.cos(SUTRO_BATHS.yaw);
    for (const b of bathers) {
      if (b.spec.pose !== "swim" || !b.pool || !b.drift) continue;
      visitor(b.group.position.x, b.group.position.z, s * b.drift, c * b.drift);
    }
  }

  return { group, update, visitSwimmers, dispose };
}

/** Small stable hash for deriving a phase offset from a seed string. */
function hashPhase(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}
