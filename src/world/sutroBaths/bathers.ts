import * as THREE from "three/webgpu";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseSwim, setHandPose, HAND_CUP, HAND_RELAXED, type Rig } from "../../player/rig";
import { bakeRigToSkinnedMesh, type BakedRig } from "../../player/rigBake";
import { SUTRO_BATHS, SUTRO_POOLS, sutroLocalToWorld, type SutroPoolSpec } from "./layout";
import { applyBathingCostume, type CostumeInfo } from "./bathingCostume";
import { SEATS } from "./parlour";

/**
 * The people of the restored Sutro Baths: two dozen ambient bathers who have
 * nowhere to be. Nobody here is exercising. They are sitting with their feet in
 * the water, sprawled in a steamer chair, floating on their back in the hot
 * bath, or leaning on a table talking to a friend while the tea goes cold.
 *
 * PLACEMENT CONVENTION (read this before tweaking the table):
 *  - Positions are authored in POOL-LOCAL coordinates and converted with
 *    `sutroLocalToWorld`. `pool` names the rect they belong to (see SUTRO_POOLS),
 *    "deck" for a free deck position, or "seat:<id>" to sit in a real piece of
 *    parlour furniture — that form takes its position, facing and hip height
 *    straight from parlour.ts, so a chair can never drift out from under someone.
 *  - The rig origin sits at hip height, RIG_STAND_Y (0.92 m) above the feet, so
 *    a stander's group Y = surfaceY + RIG_STAND_Y to plant its feet on the deck.
 *  - `face` is an extra yaw (radians) added to the site yaw; face = 0 looks
 *    along local -Z (north). rotation.y = SUTRO_BATHS.yaw + face.
 *
 * CONVERSATIONS: bathers sharing a `talk` group id take turns. The speaker
 * gestures and rocks a little; everyone else in the group turns their head
 * toward whoever is speaking and nods now and then. Turns hand over on a slow,
 * per-group clock, so a hall of two dozen people never falls into lockstep.
 *
 * COST: each bather is built as a classic rig (the only build the costume system
 * can dress), then FROZEN into one rigidly-skinned mesh by `bakeRigToSkinnedMesh`
 * — same silhouette, same joints, same poses, one draw call instead of ~43. The
 * whole cast draws for less than half of what a dozen unbaked bathers used to.
 * Nothing loads media; the set is gated by index.ts (constructed under the baths
 * root, updated only while the site is awake).
 */

const RIG_STAND_Y = 0.92; // rig group origin (hips) above the feet
/** Coping stone above the deck, measured off the built floor (5.82 vs 5.62). */
const COPING_RISE = 0.2;
/** Everything here moves at three-quarters speed. It is that kind of afternoon. */
const RELAX = 0.75;

type BatherPose =
  | "sitEdge"
  | "sitCross"
  | "sitChair"
  | "sitBench"
  | "standChat"
  | "leanRail"
  | "wade"
  | "wadeChat"
  | "crawl"
  | "breast"
  | "backFloat"
  | "sunbathe";

type BatherSpec = {
  seed: string;
  /** SUTRO_POOLS id, "deck", or "seat:<parlour seat id>". */
  pool: string;
  lx?: number; // pool-local X (metres); taken from the seat when seated
  lz?: number; // pool-local Z (metres)
  face?: number; // extra yaw over the site yaw
  pose: BatherPose;
  /** Swimmers: local-axis drift (metres/sec along +z) — clamped inside the rect. */
  drift?: number;
  /** Conversation group id; everyone sharing one takes turns talking. */
  talk?: string;
  /** Holding a teacup in the right hand (baked in, so it costs nothing). */
  tea?: boolean;
};

// A hall's worth of people with nothing to prove. Local coordinates read
// against the SUTRO_POOLS rects in layout.ts and the SEATS table in parlour.ts.
const BATHERS: readonly BatherSpec[] = [
  // ---- west ocean gallery: tea, talk and the long view out the windows ----
  { seed: "sutro-tea-1", pool: "seat:west-a-1", pose: "sitChair", talk: "west-tea-a", tea: true },
  { seed: "sutro-tea-2", pool: "seat:west-a-2", pose: "sitChair", talk: "west-tea-a" },
  { seed: "sutro-tea-3", pool: "seat:west-b-1", pose: "sitChair", talk: "west-tea-b", tea: true },
  { seed: "sutro-tea-4", pool: "seat:west-b-2", pose: "sitChair", talk: "west-tea-b", tea: true },
  { seed: "sutro-tea-5", pool: "seat:west-b-3", pose: "sitChair", talk: "west-tea-b" },
  { seed: "sutro-tea-6", pool: "seat:west-c-1", pose: "sitChair", tea: true },
  { seed: "sutro-lounge-1", pool: "seat:window-north-1", pose: "sitBench", talk: "window-north" },
  { seed: "sutro-lounge-2", pool: "seat:window-north-2", pose: "sitBench", talk: "window-north", tea: true },
  { seed: "sutro-lounge-3", pool: "seat:window-south-1", pose: "sitBench", talk: "window-south", tea: true },
  { seed: "sutro-lounge-4", pool: "seat:window-south-2", pose: "sitBench", talk: "window-south" },
  { seed: "sutro-window-1", pool: "seat:window-bench-1", pose: "sitBench", talk: "window-bench" },
  { seed: "sutro-window-2", pool: "seat:window-bench-2", pose: "sitBench", talk: "window-bench", tea: true },
  { seed: "sutro-rail-1", pool: "deck", lx: -33.4, lz: -46, face: -1.55, pose: "leanRail" },
  { seed: "sutro-rail-2", pool: "deck", lx: -33.4, lz: 46, face: -1.55, pose: "leanRail" },

  // ---- east gallery and the south promenade: the other tea rooms ---------
  { seed: "sutro-tea-7", pool: "seat:east-a-1", pose: "sitChair", talk: "east-tea-a", tea: true },
  { seed: "sutro-tea-8", pool: "seat:east-a-2", pose: "sitChair", talk: "east-tea-a" },
  { seed: "sutro-chat-4", pool: "seat:east-b-1", pose: "sitChair", talk: "east-tea-b", tea: true },
  { seed: "sutro-chat-5", pool: "seat:east-b-2", pose: "sitChair", talk: "east-tea-b" },
  { seed: "sutro-tea-12", pool: "seat:east-b-3", pose: "sitChair", talk: "east-tea-b", tea: true },
  { seed: "sutro-tea-9", pool: "seat:east-c-1", pose: "sitChair", tea: true },
  { seed: "sutro-south-1", pool: "seat:south-1", pose: "sitChair", talk: "south-table" },
  { seed: "sutro-south-2", pool: "seat:south-2", pose: "sitChair", talk: "south-table", tea: true },
  { seed: "sutro-south-3", pool: "seat:south-3", pose: "sitChair", talk: "south-table" },

  // ---- great salt-water plunge, long leg (x[-31,-10] z[-55,22]) ----------
  { seed: "sutro-swim-1", pool: "great-plunge", lx: -22, lz: -30, face: Math.PI, pose: "crawl", drift: 0.62 },
  { seed: "sutro-swim-2", pool: "great-plunge", lx: -18, lz: 6, face: 0, pose: "breast", drift: -0.44 },
  { seed: "sutro-swim-3", pool: "great-plunge", lx: -26, lz: -8, face: Math.PI, pose: "backFloat", drift: 0.14 },
  // Coping perches take their lx/lz from MAIN's convention — 0.1..0.3 m outside
  // the pool edge, so the hips land on the coping stone the surfaceForPose above
  // raises them onto, and facing the water rather than away from it — applied to
  // the rebuilt rectangles.
  { seed: "sutro-sit-1", pool: "great-plunge", lx: -31.1, lz: -25.4, face: -1.5, pose: "sitEdge", talk: "plunge-edge" },
  { seed: "sutro-sit-2", pool: "great-plunge", lx: -31.1, lz: -23.2, face: -1.9, pose: "sitEdge", talk: "plunge-edge" },
  { seed: "sutro-sit-3", pool: "great-plunge", lx: -9.7, lz: 14, face: 1.55, pose: "sitEdge" },
  { seed: "sutro-wade-1", pool: "great-plunge", lx: -12.5, lz: 16, face: 2.6, pose: "wade" },

  // ---- the plunge's south court (x[-31,19] z[22,44]) ---------------------
  // The water a visitor lands in front of, so it is never empty.
  { seed: "sutro-swim-5", pool: "great-plunge-court", lx: -6, lz: 33, face: Math.PI, pose: "crawl", drift: 0.5 },
  { seed: "sutro-swim-6", pool: "great-plunge-court", lx: 9, lz: 37, face: 0, pose: "backFloat", drift: -0.2 },
  { seed: "sutro-sit-6", pool: "great-plunge-court", lx: 2, lz: 44.2, face: 0.15, pose: "sitEdge", talk: "court-edge" },
  { seed: "sutro-sit-7", pool: "great-plunge-court", lx: 4.2, lz: 44.2, face: -0.4, pose: "sitEdge", talk: "court-edge" },

  // ---- warm graduated baths (east stack, x[-4,19]) -----------------------
  { seed: "sutro-swim-4", pool: "bath-three", lx: 8, lz: -26, face: Math.PI, pose: "breast", drift: 0.4 },
  { seed: "sutro-hot-1", pool: "bath-four", lx: 3.5, lz: -14.6, face: 1.1, pose: "wadeChat", talk: "hot-bath" },
  { seed: "sutro-hot-2", pool: "bath-four", lx: 5.9, lz: -13.7, face: -1.9, pose: "wadeChat", talk: "hot-bath" },
  { seed: "sutro-hot-3", pool: "bath-five", lx: 11, lz: -2, face: Math.PI, pose: "backFloat" },
  { seed: "sutro-sit-4", pool: "bath-two", lx: 7.5, lz: -43, face: Math.PI, pose: "sitEdge" },
  { seed: "sutro-sit-5", pool: "bath-five", lx: 14, lz: 2.6, face: 0, pose: "sitEdge" },
  { seed: "sutro-cross-1", pool: "deck", lx: -6.6, lz: -6, face: 1.4, pose: "sitCross", talk: "deck-mid" },
  { seed: "sutro-cross-2", pool: "deck", lx: -6.6, lz: -3.6, face: 1.9, pose: "sitCross", talk: "deck-mid" },
  { seed: "sutro-sun-1", pool: "deck", lx: -8.4, lz: -36, face: 1.5, pose: "sunbathe" },
  { seed: "sutro-sun-2", pool: "deck", lx: 20.8, lz: -12, face: -1.5, pose: "sunbathe" },
  // The cross promenade between the tank stack and the court — the crowded red
  // deck of the period print.
  { seed: "sutro-prom-1", pool: "deck", lx: 3.4, lz: 18.6, face: -1.5, pose: "standChat", talk: "promenade" },
  { seed: "sutro-prom-2", pool: "deck", lx: 5.2, lz: 19.4, face: -2.1, pose: "standChat", talk: "promenade" },
  { seed: "sutro-prom-3", pool: "deck", lx: 12.6, lz: 17.6, face: 0.2, pose: "leanRail" },

  // ---- deck talkers ------------------------------------------------------
  { seed: "sutro-chat-1", pool: "deck", lx: -6.9, lz: -47, face: 1.35, pose: "standChat", talk: "north-deck" },
  { seed: "sutro-chat-2", pool: "deck", lx: -6.9, lz: -45.2, face: 1.95, pose: "standChat", talk: "north-deck" },
  { seed: "sutro-chat-3", pool: "deck", lx: -5.4, lz: -46.1, face: -1.6, pose: "standChat", talk: "north-deck" },
  // Clear of the east coping candle stands at lx 20.6.
  { seed: "sutro-tea-10", pool: "deck", lx: 22.9, lz: 19.4, face: -1.5, pose: "standChat", talk: "east-deck" },
  { seed: "sutro-tea-11", pool: "deck", lx: 22.9, lz: 21.3, face: -1.9, pose: "standChat", talk: "east-deck" }
] as const;

function poolById(id: string): SutroPoolSpec | undefined {
  return SUTRO_POOLS.find((p) => p.id === id);
}

/** Feet-surface height for a pose. Deck poses stand on the deck; edge sitters
 *  perch on the coping at deck level; swimmers ride the waterline with the body
 *  properly IN the water; waders step down onto a submerged ledge. */
function surfaceForPose(pose: BatherPose): number {
  switch (pose) {
    case "crawl":
    case "breast":
      // Prone strokes ride IN the water: the back breaks the surface, the rest
      // of the body is under it. (The old cast floated a hand's width proud of
      // the waterline and read as bodies skating across the top.)
      return SUTRO_BATHS.waterY - 0.08 - RIG_STAND_Y;
    case "backFloat":
      return SUTRO_BATHS.waterY - 0.05 - RIG_STAND_Y;
    case "sitEdge":
      // On the COPING, which is not the deck. Raycasting the built floor at the
      // plunge's west rim gives 5.82 for the walkable stone against a deckY of
      // 5.62, so seating these hips off deckY buried everyone 0.2 m inside the
      // ledge — which is exactly what it looked like. groundTop cannot tell you
      // this: the authored region declares flat ownership at 2.07, so every
      // sample inside the hall returns 2.07 no matter what is built there.
      return SUTRO_BATHS.deckY + COPING_RISE - RIG_STAND_Y + 0.14;
    case "sitCross":
      return SUTRO_BATHS.deckY - RIG_STAND_Y + 0.3;
    case "sunbathe":
      return SUTRO_BATHS.deckY - RIG_STAND_Y + 0.24;
    case "wade":
      return SUTRO_BATHS.waterY - 0.48; // feet below the surface on a shallow ledge
    case "wadeChat":
      // Water at mid-chest, which is what this line has always claimed and has
      // never done. These rigs are almost exactly 2 m tall (measured: hot-2's
      // bounds run 3.809..5.804), so sinking them 1.37 m left 69% of the body
      // under a surface that hides everything below it — on a close lens the
      // pair read as two heads sitting on trays. 1.05 leaves a little under half
      // the body proud, which is chest-deep.
      return SUTRO_BATHS.waterY - 1.05;
    case "sitChair":
    case "sitBench":
      // Seated bathers normally take their height from a parlour seat; this is
      // the fallback for a seated pose authored on bare deck.
      return SUTRO_BATHS.deckY - RIG_STAND_Y + 0.58
    default:
      return SUTRO_BATHS.deckY;
  }
}

type TalkGroup = {
  id: string;
  members: Bather[];
  speaker: number;
  timer: number;
  /** Rough centre of the huddle, world space — listeners look here by default. */
  center: THREE.Vector3;
};

type Bather = {
  rig: Rig;
  baked: BakedRig;
  costume: CostumeInfo;
  spec: BatherSpec;
  pool: SutroPoolSpec | null;
  group: THREE.Group; // === rig.group; positioned + yawed in world
  phase: number; // per-bather pose-time offset (desync)
  /** Per-bather energy 0.85..1.15 so no two people breathe in time. */
  tempo: number;
  baseY: number; // resting group Y (bob rides on top)
  baseYaw: number;
  local: { x: number; z: number }; // live pool-local position (swimmers drift)
  drift: number; // live signed swim speed; flips at pool ends
  talk: TalkGroup | null;
  /** 0..1 how much this bather is currently the one talking. */
  speaking: number;
  /** Extra head yaw/pitch applied after the pose, smoothed. */
  gazeYaw: number;
  gazePitch: number;
};

// ---- poses ------------------------------------------------------------------
// The rig has no helper for any of these; joints are set directly (per
// handpanist.ts). Positive X pitches a joint toward the face side (-Z).

/** Perched on the coping with the shins hanging into the water, hands planted
 *  on the stone behind the hips, a slow idle kick. */
function poseSitEdge(r: Rig, t: number) {
  const breathe = Math.sin(t * 1.1);
  const kick = Math.sin(t * 0.72);
  r.hips.position.y = 0;
  r.hips.rotation.set(0.1, 0, 0);
  r.torso.rotation.set(-0.04 + breathe * 0.02, Math.sin(t * 0.31) * 0.06, 0);
  r.head.rotation.set(0.06 + breathe * 0.015, Math.sin(t * 0.27) * 0.16, 0);
  r.legL.rotation.set(1.32, 0, 0.05);
  r.legR.rotation.set(1.3, 0, -0.05);
  r.shinL.rotation.set(-0.94 + kick * 0.22, 0, 0);
  r.shinR.rotation.set(-0.98 - kick * 0.2, 0, 0);
  // arms back, palms on the coping — the classic poolside slouch
  r.armL.rotation.set(-0.62, 0, 0.3);
  r.armR.rotation.set(-0.62, 0, -0.3);
  r.foreL.rotation.set(0.22, 0, 0);
  r.foreR.rotation.set(0.22, 0, 0);
}

/** Cross-legged on a towel, hands loose on the knees. */
function poseSitCross(r: Rig, t: number) {
  const breathe = Math.sin(t * 1.05);
  r.hips.position.y = 0;
  r.hips.rotation.set(0.06, 0, 0);
  r.torso.rotation.set(0.08 + breathe * 0.025, Math.sin(t * 0.26) * 0.08, 0);
  r.head.rotation.set(0.04 + breathe * 0.02, Math.sin(t * 0.34) * 0.18, 0);
  r.legL.rotation.set(1.24, 0.62, 0.52);
  r.legR.rotation.set(1.24, -0.62, -0.52);
  r.shinL.rotation.set(-2.05, 0, 0);
  r.shinR.rotation.set(-2.05, 0, 0);
  r.armL.rotation.set(0.5 + breathe * 0.02, 0, 0.5);
  r.armR.rotation.set(0.5 - breathe * 0.02, 0, -0.5);
  r.foreL.rotation.set(0.72, 0, 0);
  r.foreR.rotation.set(0.72, 0, 0);
}

/** On a chair at a tea table: thighs forward, shins down, one elbow drifting
 *  onto the table between sips. */
function poseSitChair(r: Rig, t: number, tea: number) {
  const breathe = Math.sin(t * 1.15);
  const sip = tea > 0 ? Math.max(0, Math.sin(t * 0.31)) ** 3 : 0;
  r.hips.position.y = 0;
  r.hips.rotation.set(0.02, 0, 0);
  r.torso.rotation.set(0.1 + breathe * 0.02, Math.sin(t * 0.29) * 0.07, 0);
  r.head.rotation.set(0.03 + breathe * 0.015 - sip * 0.18, Math.sin(t * 0.23) * 0.12, 0);
  r.legL.rotation.set(1.46, 0.07, 0.07);
  r.legR.rotation.set(1.42, -0.09, -0.07);
  r.shinL.rotation.set(-1.42, 0, 0);
  r.shinR.rotation.set(-1.3, 0, 0);
  // left forearm rests forward on the table; right hand lifts the cup
  r.armL.rotation.set(0.72, 0, 0.2);
  r.foreL.rotation.set(0.95, 0, 0);
  r.armR.rotation.set(0.5 + sip * 0.34, 0, -0.18);
  r.foreR.rotation.set(0.9 + sip * 0.95, 0, 0);
}

/** On a bench with nothing to lean on: knees together, hands resting in the lap
 *  or holding a cup, spine easy against the back rail. */
function poseSitBench(r: Rig, t: number, tea: number) {
  const breathe = Math.sin(t * 1.1);
  const sip = tea > 0 ? Math.max(0, Math.sin(t * 0.29)) ** 3 : 0;
  r.hips.position.y = 0;
  r.hips.rotation.set(-0.06, 0, 0);
  r.torso.rotation.set(0.06 + breathe * 0.02, Math.sin(t * 0.24) * 0.06, 0);
  r.head.rotation.set(0.02 + breathe * 0.015 - sip * 0.16, Math.sin(t * 0.2) * 0.13, 0);
  r.legL.rotation.set(1.5, 0.04, 0.05);
  r.legR.rotation.set(1.48, -0.05, -0.05);
  r.shinL.rotation.set(-1.46, 0, 0);
  r.shinR.rotation.set(-1.44, 0, 0);
  r.armL.rotation.set(0.42 + breathe * 0.02, 0, 0.3);
  r.foreL.rotation.set(1.15, 0, -0.2);
  r.armR.rotation.set(0.4 + sip * 0.4, 0, -0.3);
  r.foreR.rotation.set(1.12 + sip * 0.85, 0, 0.2);
}

/** Lying back on a towel, propped on both elbows, face to the low sun. */
function poseSunbathe(r: Rig, t: number) {
  const breathe = Math.sin(t * 0.8);
  r.hips.position.y = 0;
  r.hips.rotation.set(-0.95, 0, 0);
  r.torso.rotation.set(0.22 + breathe * 0.02, 0, 0);
  r.head.rotation.set(0.32, Math.sin(t * 0.21) * 0.14, 0);
  r.legL.rotation.set(0.92, 0.12, 0.06);
  r.legR.rotation.set(1.06, -0.2, -0.06);
  r.shinL.rotation.set(-0.18, 0, 0);
  r.shinR.rotation.set(-0.66, 0, 0);
  r.armL.rotation.set(-0.55, 0, 0.52);
  r.armR.rotation.set(-0.55, 0, -0.52);
  r.foreL.rotation.set(1.05, 0, 0);
  r.foreR.rotation.set(1.05, 0, 0);
}

/** Standing in a huddle. `speak` 0..1 raises the gesture amplitude so the
 *  person with the floor is the one whose hands are moving. */
function poseStandChat(r: Rig, t: number, speak: number) {
  const sway = Math.sin(t * 0.62);
  const shift = Math.sin(t * 0.41);
  const gesture = Math.sin(t * 2.35) * speak;
  const gesture2 = Math.sin(t * 1.71 + 1.1) * speak;
  r.hips.position.y = -0.02 + shift * 0.012;
  // weight on one hip: roll the pelvis and let the spine counter it
  r.hips.rotation.set(0.02, shift * 0.05, shift * 0.06);
  r.torso.rotation.set(0.03, shift * 0.07, -shift * 0.05);
  r.head.rotation.set(0.02 + gesture * 0.03, sway * 0.08, -shift * 0.03);
  r.legL.rotation.set(0.04, 0, 0.03 + shift * 0.02);
  r.legR.rotation.set(-0.1, 0.12, -0.05);
  r.shinL.rotation.set(-0.06, 0, 0);
  r.shinR.rotation.set(-0.2, 0, 0);
  // resting: one hand on the hip, one arm loose. speaking: both come up.
  r.armL.rotation.set(0.28 + gesture * 0.42, 0, 0.44 - speak * 0.16);
  r.armR.rotation.set(-0.12 + gesture2 * 0.3, 0, -0.5);
  r.foreL.rotation.set(1.05 + gesture * 0.5, 0, 0);
  r.foreR.rotation.set(1.5 - speak * 0.35, 0, 0);
}

/** Forearms folded on the gallery rail, one heel lifted, watching the water. */
function poseLeanRail(r: Rig, t: number) {
  const breathe = Math.sin(t * 0.95);
  r.hips.position.y = -0.05;
  r.hips.rotation.set(0.12, 0, 0);
  r.torso.rotation.set(0.24 + breathe * 0.02, Math.sin(t * 0.22) * 0.05, 0);
  r.head.rotation.set(-0.12, Math.sin(t * 0.28) * 0.2, 0);
  r.legL.rotation.set(-0.14, 0, 0.04);
  r.legR.rotation.set(0.22, 0.1, -0.05);
  r.shinL.rotation.set(-0.04, 0, 0);
  r.shinR.rotation.set(-0.62, 0, 0);
  r.armL.rotation.set(0.86, 0, 0.24);
  r.armR.rotation.set(0.86, 0, -0.24);
  r.foreL.rotation.set(1.15, 0, -0.5);
  r.foreR.rotation.set(1.15, 0, 0.5);
}

/** Standing in the shallows, arms trailing on the surface. */
function poseWade(r: Rig, t: number, chest: number, speak: number) {
  const sway = Math.sin(t * 0.7);
  const gesture = Math.sin(t * 2.1) * speak;
  r.hips.position.y = 0;
  r.hips.rotation.set(0.02, sway * 0.04, sway * 0.02);
  r.torso.rotation.set(0.04, sway * 0.05, -sway * 0.03);
  r.head.rotation.set(0.03 + gesture * 0.04, Math.sin(t * 0.44) * 0.14, 0);
  r.legL.rotation.set(0.06, 0, 0.03);
  r.legR.rotation.set(-0.05, 0, -0.03);
  r.shinL.rotation.set(-0.08, 0, 0);
  r.shinR.rotation.set(-0.05, 0, 0);
  // chest-deep: the arms float out level with the surface
  const lift = 1.32 * chest;
  r.armL.rotation.set(0.12 - lift * 0.1 + gesture * 0.3, 0, 0.3 + lift * 0.5 + sway * 0.05);
  r.armR.rotation.set(0.12 - lift * 0.1 - gesture * 0.24, 0, -0.3 - lift * 0.5 - sway * 0.05);
  r.foreL.rotation.set(0.5 + lift * 0.35, 0, 0);
  r.foreR.rotation.set(0.5 + lift * 0.35, 0, 0);
}

/** An unhurried breaststroke: symmetric sweep, glide, frog kick. */
function poseBreast(r: Rig, t: number) {
  const cycle = t % (Math.PI * 2);
  const pull = Math.sin(cycle);
  const glide = Math.max(0, Math.cos(cycle));
  r.hips.position.y = 0;
  r.hips.rotation.set(-1.42 + pull * 0.06, 0, 0);
  r.torso.rotation.set(0.16 + Math.max(0, pull) * 0.16, 0, 0);
  r.head.rotation.set(0.76 + Math.max(0, pull) * 0.2, 0, 0); // face up on the pull
  r.armL.rotation.set(-1.5 - glide * 0.9, 0, 0.42 + Math.max(0, pull) * 0.6);
  r.armR.rotation.set(-1.5 - glide * 0.9, 0, -0.42 - Math.max(0, pull) * 0.6);
  r.foreL.rotation.set(0.35 + Math.max(0, pull) * 0.7, 0, 0);
  r.foreR.rotation.set(0.35 + Math.max(0, pull) * 0.7, 0, 0);
  const frog = Math.max(0, Math.sin(cycle - 1.0));
  r.legL.rotation.set(0.06 + frog * 0.2, frog * 0.42, 0);
  r.legR.rotation.set(0.06 + frog * 0.2, -frog * 0.42, 0);
  r.shinL.rotation.set(-0.18 - frog * 1.25, 0, 0);
  r.shinR.rotation.set(-0.18 - frog * 1.25, 0, 0);
}

/** On their back, ears under, doing absolutely nothing. */
function poseBackFloat(r: Rig, t: number) {
  const drift = Math.sin(t * 0.42);
  r.hips.position.y = 0;
  // +X lays the body face-up (the mirror of the prone stroke pitch)
  r.hips.rotation.set(1.46, 0, drift * 0.06);
  r.torso.rotation.set(-0.1, 0, 0);
  r.head.rotation.set(-0.34, drift * 0.14, 0); // chin up out of the water
  r.legL.rotation.set(-0.06 + drift * 0.05, 0, 0.06);
  r.legR.rotation.set(-0.06 - drift * 0.05, 0, -0.06);
  r.shinL.rotation.set(-0.08, 0, 0);
  r.shinR.rotation.set(-0.08, 0, 0);
  r.armL.rotation.set(-0.2, 0, 1.05 + drift * 0.08); // arms out on the surface
  r.armR.rotation.set(-0.2, 0, -1.05 - drift * 0.08);
  r.foreL.rotation.set(0.18, 0, 0);
  r.foreR.rotation.set(0.18, 0, 0);
}

function applyPose(rig: Rig, spec: BatherSpec, poseT: number, speaking: number) {
  switch (spec.pose) {
    case "crawl":
      // A slow, easy crawl — this is a swim, not a race.
      poseSwim(rig, poseT * 1.35);
      break;
    case "breast":
      poseBreast(rig, poseT * 0.72);
      break;
    case "backFloat":
      poseBackFloat(rig, poseT);
      break;
    case "sitEdge":
      poseSitEdge(rig, poseT);
      break;
    case "sitCross":
      poseSitCross(rig, poseT);
      break;
    case "sitChair":
      poseSitChair(rig, poseT, spec.tea ? 1 : 0);
      break;
    case "sitBench":
      poseSitBench(rig, poseT, spec.tea ? 1 : 0);
      break;
    case "sunbathe":
      poseSunbathe(rig, poseT);
      break;
    case "leanRail":
      poseLeanRail(rig, poseT);
      break;
    case "wade":
      poseWade(rig, poseT, 0, 0);
      break;
    case "wadeChat":
      poseWade(rig, poseT, 1, speaking);
      break;
    case "standChat":
    default:
      poseStandChat(rig, poseT, speaking);
      break;
  }
}

/** A teacup, rigidly parented to the right hand before the bake so it costs no
 *  extra draw call and still rides every sip. */
function attachTeacup(rig: Rig): { geometry: THREE.BufferGeometry; material: THREE.Material } {
  const geometry = new THREE.CylinderGeometry(0.035, 0.028, 0.05, 8);
  const material = new THREE.MeshLambertMaterial({ color: 0xf4efe2 });
  const cup = new THREE.Mesh(geometry, material);
  cup.position.set(0, -0.04, -0.05);
  cup.castShadow = false;
  rig.handR.add(cup);
  return { geometry, material };
}

export type SutroBathers = {
  group: THREE.Group;
  update(dt: number, time: number, player?: THREE.Object3D): void;
  /** 0 = daylight hall, 1 = deep twilight: people keep catching the lamps. */
  setTwilight(depth: number): void;
  /**
   * Build the rest of the cast a few at a time, yielding through `pace()`.
   *
   * Dressing and baking a bather is ~9 ms of CPU, so constructing all of them in
   * the constructor was a third of a second of frozen frames landing exactly as
   * a visitor arrived. The constructor builds ONE (which is what the covered
   * pipeline warm needs — every bather shares one material signature) and the
   * hall fills in over the following second instead.
   */
  hydrate(pace: () => Promise<void>): Promise<void>;
  /**
   * Reveal up to `count` not-yet-shown bathers. Returns true while more remain.
   *
   * Each bather is its own skinned mesh with its own material instance, so the
   * frame that first draws all of them pays 38 render-list/bind-group builds at
   * once. Handing them out a few per frame keeps that off any single frame.
   */
  revealSome(count: number): boolean;
  readonly stats: { bathers: number; talkGroups: number; draws: number; triangles: number };
  dispose(): void;
};

/** CPU budget per hydration slice; one bather is ~9 ms, so this is 1-2 people. */
const HYDRATE_SLICE_MS = 7;

export function createSutroBathers(_opts: Record<string, never> = {}): SutroBathers {
  const group = new THREE.Group();
  group.name = "sutroBaths.bathers";

  const bathers: Bather[] = [];
  const talkGroups = new Map<string, TalkGroup>();
  const ownedGeometries: THREE.BufferGeometry[] = [];
  const ownedMaterials: THREE.Material[] = [];
  let triangles = 0;

  const seatById = new Map(SEATS.map((seat) => [seat.id, seat]));
  // Declared here, not beside setTwilight: build() applies the current lift to
  // every bather it hydrates, including the first one built in this constructor.
  let twilightLift = 0;

  const build = (spec: BatherSpec): void => {
    const seat = spec.pool.startsWith("seat:") ? seatById.get(spec.pool.slice(5)) : undefined;
    if (spec.pool.startsWith("seat:") && !seat) {
      console.warn(`[sutro-baths] bather ${spec.seed} references unknown seat ${spec.pool}`);
      return;
    }
    const pool = seat || spec.pool === "deck" ? null : (poolById(spec.pool) ?? null);
    const lx = seat?.lx ?? spec.lx ?? 0;
    const lz = seat?.lz ?? spec.lz ?? 0;
    const face = seat?.face ?? spec.face ?? 0;

    const traits = avatarFromSeed(spec.seed);
    const rig = buildRig(traits, { merged: false }); // costume does per-part surgery
    // Hand the costume the hairstyle the rig was built with: a bather who rolls
    // no bathing cap keeps their own hair, and the rig cannot say which of the
    // five styles that is once they are all hidden.
    const costume = applyBathingCostume(rig, spec.seed, { hair: traits.hair });
    if (spec.tea) {
      const cup = attachTeacup(rig);
      ownedGeometries.push(cup.geometry);
      ownedMaterials.push(cup.material);
    }
    // Hands are frozen by the bake, so choose their shape once: a cup grip for
    // the tea drinkers, a soft open hand for everyone else.
    setHandPose(rig, "R", spec.tea ? HAND_CUP : HAND_RELAXED);
    setHandPose(rig, "L", HAND_RELAXED);

    const world = sutroLocalToWorld(lx, lz);
    // Seated hips come straight from the furniture (parlour.ts owns hipY), so a
    // chair and its occupant cannot disagree about where the seat is.
    const baseY = seat
      ? SUTRO_BATHS.deckY + seat.hipY
      : surfaceForPose(spec.pose) + RIG_STAND_Y;
    const baseYaw = SUTRO_BATHS.yaw + face;
    rig.group.position.set(world.x, baseY, world.z);
    rig.group.rotation.y = baseYaw;

    const phase = ((Math.abs(hashPhase(spec.seed)) % 1000) / 1000) * Math.PI * 2;
    // Settle into a frame-0 pose so the bind capture is a real pose, not a
    // T-stance, and nothing pops before the first update.
    applyPose(rig, spec, phase, 0);
    rig.group.updateMatrixWorld(true);
    const baked = bakeRigToSkinnedMesh(rig, { name: `sutro_bather_${spec.seed}` });
    triangles += baked.stats.triangles;

    const b: Bather = {
      rig,
      baked,
      costume,
      spec,
      pool,
      group: rig.group,
      phase,
      tempo: 0.85 + ((Math.abs(hashPhase(`${spec.seed}-tempo`)) % 300) / 1000),
      baseY,
      baseYaw,
      local: { x: lx, z: lz },
      drift: spec.drift ?? 0,
      talk: null,
      speaking: 0,
      gazeYaw: 0,
      gazePitch: 0
    };
    rig.group.matrixWorldAutoUpdate = false;
    rig.group.updateMatrixWorld(true);
    // Hidden until revealSome() hands it out; the site stages the reveal.
    rig.group.visible = false;
    group.add(rig.group);
    bathers.push(b);
    unrevealed.push(b);

    if (spec.talk) {
      let talk = talkGroups.get(spec.talk);
      if (!talk) {
        talk = { id: spec.talk, members: [], speaker: 0, timer: 0, center: new THREE.Vector3() };
        talkGroups.set(spec.talk, talk);
      }
      talk.members.push(b);
      b.talk = talk;
    }
    stats.bathers = bathers.length;
    stats.draws = bathers.length;
    stats.talkGroups = talkGroups.size;
    stats.triangles = triangles;
    if (twilightLift > 0) baked.setAmbientLift(twilightLift);
  };

  const stats = { bathers: 0, talkGroups: 0, draws: 0, triangles: 0 };
  const unrevealed: Bather[] = [];
  let disposed = false;

  // One bather up front: the covered warm needs the shared material to exist,
  // and a hall that is briefly one-person is better than a frozen frame.
  const pending = BATHERS.slice();
  const first = pending.shift();
  if (first) build(first);

  /** Seed each conversation at a different point in its turn so the hall does
   *  not hand the floor over in unison. */
  const seedConversations = () => {
    let groupIndex = 0;
    for (const talk of talkGroups.values()) {
      talk.timer = (groupIndex * 1.7) % 5;
      talk.speaker = groupIndex % Math.max(1, talk.members.length);
      talk.center.set(0, 0, 0);
      for (const member of talk.members) talk.center.add(member.group.position);
      talk.center.divideScalar(Math.max(1, talk.members.length));
      groupIndex++;
    }
  };
  seedConversations();

  // scratch for the head-turn toward the player (alloc-free updates)
  const playerWorld = new THREE.Vector3();
  const gazeTarget = new THREE.Vector3();

  /** Shortest signed angle from `from` to `to`. */
  const angleDelta = (from: number, to: number): number =>
    Math.atan2(Math.sin(to - from), Math.cos(to - from));

  function update(dt: number, time: number, player?: THREE.Object3D) {
    const step = Math.min(0.1, Math.max(0, dt));
    if (player) player.getWorldPosition(playerWorld);

    // ---- conversation turn-taking -----------------------------------------
    for (const talk of talkGroups.values()) {
      talk.timer -= step;
      if (talk.timer <= 0) {
        // 4–8 s per turn, and never the same person twice in a row.
        talk.timer = 4 + ((talk.speaker * 2.7 + talk.members.length) % 4);
        // Plain round-robin: every turn changes hands, and in a trio the third
        // person is not quietly skipped for the length of the afternoon.
        talk.speaker = (talk.speaker + 1) % talk.members.length;
      }
      for (let i = 0; i < talk.members.length; i++) {
        const member = talk.members[i];
        const want = i === talk.speaker ? 1 : 0;
        member.speaking += (want - member.speaking) * Math.min(1, step * 3.2);
      }
    }

    // Resolve who gets to look at the visitor BEFORE posing, so each bather
    // takes exactly one gaze decision (an aim applied and then partly undone
    // reads as a twitch).
    let nearest: Bather | null = null;
    if (player) {
      let nearestD = 11 * 11; // only the closest, and only within ~11 m
      for (const b of bathers) {
        const dx = b.group.position.x - playerWorld.x;
        const dz = b.group.position.z - playerWorld.z;
        const d2 = dx * dx + dz * dz;
        if (d2 < nearestD) {
          nearestD = d2;
          nearest = b;
        }
      }
    }

    for (const b of bathers) {
      const poseT = time * RELAX * b.tempo + b.phase;

      // swimmers drift along the pool's local +z and ride the surface
      if (b.pool && (b.spec.pose === "crawl" || b.spec.pose === "breast" || b.spec.pose === "backFloat")) {
        if (b.drift) {
          let z = b.local.z + b.drift * step;
          const margin = 3.5;
          if (z > b.pool.maxZ - margin || z < b.pool.minZ + margin) {
            b.drift = -b.drift;
            z = Math.max(b.pool.minZ + margin, Math.min(b.pool.maxZ - margin, z));
          }
          b.local.z = z;
          const w = sutroLocalToWorld(b.local.x, b.local.z);
          b.group.position.x = w.x;
          b.group.position.z = w.z;
          b.baseYaw = SUTRO_BATHS.yaw + (b.drift >= 0 ? Math.PI : 0);
          b.group.rotation.y = b.baseYaw;
        }
        b.group.position.y = b.baseY + Math.sin(poseT * 0.6) * 0.045;
      }

      applyPose(b.rig, b.spec, poseT, b.speaking);

      // ---- gaze: the nearest bather glances up at the visitor; everyone else
      // in a conversation looks at whoever currently has the floor. Layered on
      // top of the pose's own head motion so a listener still breathes.
      let aim: THREE.Vector3 | null = null;
      let limit = 0.85;
      if (b === nearest) {
        aim = playerWorld;
        limit = 0.7;
      } else if (b.talk && b.talk.members.length > 1 && b.speaking < 0.5) {
        const speaker = b.talk.members[b.talk.speaker];
        if (speaker !== b) aim = speaker.group.position;
      }
      let wantYaw = 0;
      let wantPitch = 0;
      if (aim) {
        gazeTarget.copy(aim);
        const dx = gazeTarget.x - b.group.position.x;
        const dz = gazeTarget.z - b.group.position.z;
        wantYaw = clampAngle(angleDelta(b.group.rotation.y, Math.atan2(dx, dz)), limit);
        wantPitch = THREE.MathUtils.clamp((gazeTarget.y - b.group.position.y) * 0.35, -0.25, 0.25);
      }

      b.gazeYaw += (wantYaw - b.gazeYaw) * Math.min(1, step * 2.6);
      b.gazePitch += (wantPitch - b.gazePitch) * Math.min(1, step * 2.6);
      b.rig.head.rotation.y += b.gazeYaw;
      b.rig.head.rotation.x += b.gazePitch;

      b.group.updateMatrixWorld(true);
    }
  }

  function dispose() {
    disposed = true;
    pending.length = 0;
    unrevealed.length = 0;
    // NOTE: rig box geometries come from a module-level cache shared by every
    // rig (rig.ts boxGeo) — we must NOT dispose them here. The costume owns and
    // frees its own (uncached) geometries + materials via costume.dispose(); the
    // bake owns the one skinned mesh it built. We only free the rig's per-rig
    // MeshLambert material slots, reached through the meshes the bake detached.
    const mats = new Set<THREE.Material>();
    for (const b of bathers) {
      for (const mesh of b.baked.detached) {
        const m = mesh.material as THREE.Material | THREE.Material[];
        if (Array.isArray(m)) m.forEach((mm) => mats.add(mm));
        else if (m) mats.add(m);
      }
      b.baked.dispose();
      b.costume.dispose();
      b.group.removeFromParent();
    }
    for (const geometry of ownedGeometries) geometry.dispose();
    for (const material of ownedMaterials) material.dispose();
    for (const m of mats) m.dispose();
    bathers.length = 0;
    talkGroups.clear();
    group.removeFromParent();
  }

  async function hydrate(pace: () => Promise<void>): Promise<void> {
    while (pending.length > 0 && !disposed) {
      const sliceStartedAt = performance.now();
      while (pending.length > 0 && performance.now() - sliceStartedAt < HYDRATE_SLICE_MS) {
        build(pending.shift()!);
      }
      await pace();
    }
    if (!disposed) seedConversations();
  }

  function revealSome(count: number): boolean {
    for (let i = 0; i < count && unrevealed.length > 0; i++) {
      unrevealed.shift()!.group.visible = true;
    }
    return unrevealed.length > 0 || pending.length > 0;
  }

  function setTwilight(depth: number) {
    const lift = (depth < 0 ? 0 : depth > 1 ? 1 : depth) * 0.34;
    if (Math.abs(lift - twilightLift) < 1e-3) return;
    twilightLift = lift;
    for (const b of bathers) b.baked.setAmbientLift(lift);
  }

  return { group, update, setTwilight, hydrate, revealSome, stats, dispose };
}

function clampAngle(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
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
