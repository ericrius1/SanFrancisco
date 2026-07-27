import type { Rig } from "./rig";
import { HAND_FIST, HAND_OPEN, HAND_POINT, HAND_RELAXED, setHandPose, type HandPose } from "./rig";

/**
 * Emotes: the things a player does when they are NOT going anywhere — waving
 * hello, dancing, clapping, taking a bow. Pure animation, no simulation: the
 * capsule never moves, so an emote can never push anyone through a wall or off
 * a cliff, and a remote viewer replaying one is only moving joint rotations.
 *
 * Same sign conventions as rig.ts (limbs hang along -Y, front is local -Z,
 * rotation.x > 0 swings a limb forward, +Z swings armL outboard). Each pose
 * function describes a STEADY STATE plus whatever oscillation the gesture
 * needs — the entrance and exit are the runner's job, not the pose's. That is
 * what lets a bow "descend" (a 0.5 s blend from idle into the bent-over pose)
 * without every pose re-implementing its own envelope.
 *
 * Poses are layered on top of whichever base pose already ran this frame
 * (poseIdle/poseWalk/…): {@link EmoteRunner.apply} snapshots the base, writes
 * the emote absolutely, then lerps between them by the blend weight. Nothing
 * here allocates.
 */

export type EmoteId = "wave" | "dance" | "clap" | "cheer" | "bow" | "point" | "flex" | "sit";

export type EmoteDef = {
  id: EmoteId;
  /** Wheel label. */
  label: string;
  /** Wheel glyph. */
  icon: string;
  /** Seconds a one-shot runs, start to finish (fades included). Loops repeat
   *  until released; the value is their natural cycle, for reference only. */
  duration: number;
  loop: boolean;
  /** Blend in / out seconds. For a gesture with a real approach (bow, sit)
   *  this IS the approach — keep it long enough to read as movement. */
  fadeIn: number;
  fadeOut: number;
  /** Mitt shapes held for the emote's lifetime (see rig.ts HAND_*). */
  handL?: number | HandPose;
  handR?: number | HandPose;
  /** `t` is seconds since the emote started. */
  pose: (r: Rig, t: number) => void;
};

function set(g: { rotation: { set(x: number, y: number, z: number): void } }, x: number, y: number, z: number) {
  g.rotation.set(x, y, z);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Smoothstep so a blend leaves and arrives at rest instead of kinking. */
const ease = (k: number) => k * k * (3 - 2 * k);
/** Positive half of a sine — one limb's turn in an alternating gesture. */
const half = (v: number) => (v > 0 ? v : 0);

/* ------------------------------------------------------------------ poses */

/**
 * Wave. One arm up and out, forearm sweeping in the frontal plane, weight
 * cocked onto the opposite hip so the whole body reads as "hello" rather than
 * a mannequin with one moving part.
 */
function poseWave(r: Rig, t: number) {
  const sway = Math.sin(t * 2.2);
  const flap = Math.sin(t * 8.6);
  r.hips.position.y = -0.01 + sway * 0.008;
  set(r.hips, 0.02, -0.05, 0.06);
  set(r.torso, 0.02 + sway * 0.015, -0.14, -0.07);
  set(r.head, 0.03, -0.2, 0.1); // turned toward whoever the wave is for
  set(r.legL, 0.05, 0, 0.03);
  set(r.legR, -0.05, 0, -0.03);
  set(r.shinL, -0.06, 0, 0);
  set(r.shinR, -0.07, 0, 0);
  // raised arm: shoulder abducts up/out, elbow holds ~90°, forearm does the wave
  set(r.armL, -0.14, 0, 2.32);
  set(r.foreL, 0.24, 0, 0.28 + flap * 0.44);
  set(r.armR, sway * 0.05, 0, -0.14);
  set(r.foreR, 0.2, 0, 0);
}

/**
 * Dance: raise-the-roof at ~120 bpm. Upper arms held out at shoulder height
 * with the forearms vertical, both pushing up on the beat, over a hip sway,
 * counter-rotating shoulders, a head bob and a knee bounce.
 *
 * BOTH arms stay engaged the whole cycle on purpose. An alternating version
 * (one arm up, one arm down) spends half of every cycle with the arms low, and
 * a still frame of that is indistinguishable from standing around — which is
 * exactly what a friend twenty metres away sees.
 *
 * The knees bend by the amount the hips drop (0.34 rad ≈ 0.045 m of leg), so
 * the bounce happens without driving both shoes through the pavement twice a
 * second.
 */
function poseDance(r: Rig, t: number) {
  const b = t * 6.3;
  const s = Math.sin(b);
  const push = 0.5 - 0.5 * Math.cos(b * 2); // 0..1, the beat: 1 = arms up, tall
  const sink = 1 - push;
  const crouch = sink * 0.34;
  const stepL = half(-s);
  const stepR = half(s);
  r.hips.position.y = -0.045 * sink;
  set(r.hips, 0.05, s * 0.34, -s * 0.2);
  set(r.torso, -0.08 - sink * 0.06, -s * 0.3, s * 0.14);
  set(r.head, 0.08 + sink * 0.14, -s * 0.34, s * 0.08);
  set(r.legL, crouch + stepL * 0.4, 0, 0.1);
  set(r.legR, crouch + stepR * 0.4, 0, -0.1);
  set(r.shinL, -crouch - stepL * 0.8, 0, 0);
  set(r.shinR, -crouch - stepR * 0.8, 0, 0);
  set(r.armL, -0.25, 0, 1.5 + push * 0.7 + s * 0.16);
  set(r.armR, -0.25, 0, -(1.5 + push * 0.7 - s * 0.16));
  set(r.foreL, 0.16, 0, 0.8 - push * 0.6);
  set(r.foreR, 0.16, 0, -(0.8 - push * 0.6));
}

/**
 * Applause. Shoulders adduct so the mitts meet in front of the STERNUM, and the
 * body gives a little on each impact — a clap with a still torso reads as a
 * wind-up toy.
 *
 * The shoulder angle is the whole trick. Flexing it much past 0.85 folds the
 * forearm up in front of the face instead (solved against the real chain:
 * shoulder 0.85 / -0.45 with elbow 0.42 lands the mitt at chest height, a hand's
 * width in front of the chest).
 */
function poseClap(r: Rig, t: number) {
  const beat = t * 14.5;
  const c = 0.5 + 0.5 * Math.sin(beat); // 1 = hands together
  const impact = half(Math.sin(beat)) ** 3;
  r.hips.position.y = -0.012 * impact;
  set(r.hips, 0.02, 0, 0);
  set(r.torso, 0.1 + impact * 0.05, 0, 0);
  set(r.head, 0.05 + impact * 0.07, 0, 0);
  set(r.legL, 0.04, 0, 0.04);
  set(r.legR, -0.04, 0, -0.04);
  set(r.shinL, -0.08, 0, 0);
  set(r.shinR, -0.08, 0, 0);
  const close = 0.18 + c * 0.27;
  set(r.armL, 0.85, 0, -close);
  set(r.armR, 0.85, 0, close);
  set(r.foreL, 0.42 + c * 0.06, 0, -c * 0.1);
  set(r.foreR, 0.42 + c * 0.06, 0, c * 0.1);
}

/** Both arms punched up, chin up, hopping on the spot. Feet leaving the ground
 *  is the point — the capsule stays exactly where it was. */
function poseCheer(r: Rig, t: number) {
  const pump = Math.sin(t * 9.2);
  const hop = half(Math.sin(t * 4.6));
  r.hips.position.y = hop * 0.1;
  set(r.hips, -0.06, 0, 0);
  set(r.torso, -0.15, 0, 0);
  set(r.head, -0.24, 0, 0);
  set(r.legL, -0.06 - hop * 0.24, 0, 0.07);
  set(r.legR, -0.06 - hop * 0.24, 0, -0.07);
  set(r.shinL, -0.1 - hop * 0.55, 0, 0);
  set(r.shinR, -0.1 - hop * 0.55, 0, 0);
  set(r.armL, -0.12 - pump * 0.14, 0, 2.7 + pump * 0.22);
  set(r.armR, -0.12 - pump * 0.14, 0, -(2.7 + pump * 0.22));
  set(r.foreL, 0.06, 0, 0.2);
  set(r.foreR, 0.06, 0, -0.2);
}

/** A courtly bow: hinge at the waist, one arm sweeping across the middle, the
 *  other trailing back. The 0.5 s fade IS the descent. */
function poseBow(r: Rig, t: number) {
  const settle = Math.sin(t * 1.9) * 0.02; // breath at the bottom
  r.hips.position.y = -0.06;
  set(r.hips, 0.24, 0, 0);
  set(r.torso, 0.92 + settle, 0, 0);
  set(r.head, -0.34, 0, 0); // eyes still up — a bow, not a stumble
  set(r.legL, -0.14, 0, 0.05);
  set(r.legR, -0.14, 0, -0.05);
  set(r.shinL, -0.16, 0, 0);
  set(r.shinR, -0.16, 0, 0);
  set(r.armL, 0.82, 0, -0.5);
  set(r.foreL, 1.35, 0, -0.4);
  set(r.armR, -0.6, 0, -0.52);
  set(r.foreR, 0.22, 0, 0);
}

/**
 * Point, with a couple of emphatic jabs and the head following the finger so it
 * reads as "over there" rather than a limb sticking out.
 *
 * Aimed forward AND outboard rather than dead ahead: an arm pointing straight
 * down the view axis is a foreshortened stub from the one angle that matters
 * most — the person being pointed at.
 */
function posePoint(r: Rig, t: number) {
  const jab = half(Math.sin(t * 5.4));
  r.hips.position.y = -0.01;
  set(r.hips, 0, 0.05, 0);
  set(r.torso, 0.04, 0.16, -0.06);
  set(r.head, 0.02, 0.12, 0);
  set(r.legL, 0.04, 0, 0.03);
  set(r.legR, -0.04, 0, -0.03);
  set(r.shinL, -0.06, 0, 0);
  set(r.shinR, -0.06, 0, 0);
  set(r.armL, 1.34 + jab * 0.14, 0, 0.3);
  set(r.foreL, 0.12 - jab * 0.1, 0, 0.05);
  set(r.armR, 0.05, 0, -0.12);
  set(r.foreR, 0.24, 0, 0);
}

/** Double biceps. Upper arms out to the sides, forearms folded UP — on this
 *  rig that is a +Z hinge on the forearm, because a shoulder rotated purely
 *  about Z leaves the elbow's Z axis pointing the same way it always did. */
function poseFlex(r: Rig, t: number) {
  const pulse = 0.5 + 0.5 * Math.sin(t * 4.6);
  const shift = Math.sin(t * 1.4);
  r.hips.position.y = -0.035 - pulse * 0.012;
  set(r.hips, 0.03, shift * 0.08, 0);
  set(r.torso, -0.06, shift * 0.14, 0);
  set(r.head, -0.03, shift * 0.22, 0);
  set(r.legL, 0.02, 0, 0.17);
  set(r.legR, -0.02, 0, -0.17);
  set(r.shinL, -0.09, 0, 0);
  set(r.shinR, -0.09, 0, 0);
  set(r.armL, -0.16, 0, 1.4 + pulse * 0.1);
  set(r.foreL, 0.06, 0, 1.72 + pulse * 0.16);
  set(r.armR, -0.16, 0, -(1.4 + pulse * 0.1));
  set(r.foreR, 0.06, 0, -(1.72 + pulse * 0.16));
}

/**
 * Sit cross-legged.
 *
 * The thigh yaw (rotation.y) does not move the thigh itself — it spins the limb
 * about its own axis, which swings the KNEE's bend plane, and THAT is what
 * folds the shins across each other instead of straight back. The thighs go
 * nearly horizontal so the shins fold across at ankle height rather than
 * hanging down, which is what sets the hip drop: -0.60 puts the folded shins
 * exactly on the ground and the pelvis ~0.2 m above it. A lower pelvis buries
 * the shins (the first pass sat 0.3 m underground).
 *
 * The two legs use slightly different thigh angles so the crossed shins pass
 * one in front of the other rather than fighting for the same space.
 *
 * The capsule does not move for any of this, so a sit is safe anywhere the
 * player could stand.
 */
function poseSit(r: Rig, t: number) {
  const breathe = Math.sin(t * 1.5);
  r.hips.position.y = -0.6;
  set(r.hips, 0.14, 0, 0);
  set(r.torso, -0.1 + breathe * 0.02, 0, 0);
  set(r.head, 0.05 + breathe * 0.015, Math.sin(t * 0.29) * 0.18, 0);
  set(r.legL, 1.42, -1.05, 0);
  set(r.legR, 1.5, 1.22, 0);
  set(r.shinL, -1.52, 0, 0);
  set(r.shinR, -1.58, 0, 0);
  // hands resting in the lap
  set(r.armL, 0.55, 0, 0.24);
  set(r.foreL, 0.95, 0, -0.3);
  set(r.armR, 0.55, 0, -0.24);
  set(r.foreR, 0.95, 0, 0.3);
}

/* ---------------------------------------------------------------- catalog */

/**
 * Wire order — the index into this array is what goes over the socket, so this
 * is APPEND-ONLY. Reordering it would make one client's wave another's dance.
 */
export const EMOTES: readonly EmoteDef[] = [
  {
    id: "wave",
    label: "wave",
    icon: "👋",
    duration: 2.8,
    loop: false,
    fadeIn: 0.22,
    fadeOut: 0.3,
    handL: HAND_OPEN,
    handR: HAND_RELAXED,
    pose: poseWave
  },
  {
    id: "dance",
    label: "dance",
    icon: "🕺",
    duration: 1.0,
    loop: true,
    fadeIn: 0.28,
    fadeOut: 0.3,
    handL: HAND_RELAXED,
    handR: HAND_RELAXED,
    pose: poseDance
  },
  {
    id: "clap",
    label: "clap",
    icon: "👏",
    duration: 2.6,
    loop: false,
    fadeIn: 0.18,
    fadeOut: 0.24,
    handL: HAND_OPEN,
    handR: HAND_OPEN,
    pose: poseClap
  },
  {
    id: "cheer",
    label: "cheer",
    icon: "🙌",
    duration: 2.4,
    loop: false,
    fadeIn: 0.2,
    fadeOut: 0.28,
    handL: HAND_OPEN,
    handR: HAND_OPEN,
    pose: poseCheer
  },
  {
    id: "bow",
    label: "bow",
    icon: "🙇",
    duration: 2.6,
    loop: false,
    fadeIn: 0.5,
    fadeOut: 0.6,
    handL: HAND_RELAXED,
    handR: HAND_RELAXED,
    pose: poseBow
  },
  {
    id: "point",
    label: "point",
    icon: "👉",
    duration: 2.2,
    loop: false,
    fadeIn: 0.22,
    fadeOut: 0.28,
    handL: HAND_POINT,
    handR: HAND_RELAXED,
    pose: posePoint
  },
  {
    id: "flex",
    label: "flex",
    icon: "💪",
    duration: 3.0,
    loop: false,
    fadeIn: 0.32,
    fadeOut: 0.36,
    handL: HAND_FIST,
    handR: HAND_FIST,
    pose: poseFlex
  },
  {
    id: "sit",
    label: "sit",
    icon: "🧘",
    duration: 2.0,
    loop: true,
    fadeIn: 0.5,
    fadeOut: 0.45,
    handL: HAND_RELAXED,
    handR: HAND_RELAXED,
    pose: poseSit
  }
];

/** Socket order (see {@link EMOTES}). */
export const EMOTE_IDS: readonly EmoteId[] = EMOTES.map((e) => e.id);

export function emoteByIndex(index: number): EmoteDef | null {
  return Number.isInteger(index) && index >= 0 && index < EMOTES.length ? EMOTES[index] : null;
}

export function emoteIndex(id: EmoteId): number {
  return EMOTE_IDS.indexOf(id);
}

export function emoteById(id: EmoteId): EmoteDef | null {
  return EMOTES.find((e) => e.id === id) ?? null;
}

/* ----------------------------------------------------------------- runner */

/** Joints an emote may write. Every base pose function sets all of these
 *  absolutely each frame, which is what makes the snapshot a true "what the
 *  body would be doing otherwise" — blending against a value that was itself
 *  the previous blend's output would never converge. Wrists and mitts are
 *  deliberately NOT here (see the hand handling in `apply`). */
const BLEND_JOINTS = [
  "hips",
  "torso",
  "head",
  "armL",
  "armR",
  "foreL",
  "foreR",
  "legL",
  "legR",
  "shinL",
  "shinR"
] as const;

const HIPS_Y = BLEND_JOINTS.length * 3;

/**
 * One avatar's emote playback — the local player and every remote share it, so
 * a dance looks identical on the dancer's screen and everyone else's.
 *
 * Call {@link apply} once per rendered frame AFTER the base pose has been
 * written. It advances the clock, blends the emote over that base, and retires
 * itself when a one-shot runs out or a released loop has faded.
 */
export class EmoteRunner {
  #def: EmoteDef | null = null;
  #t = 0;
  /** Seconds into the emote at which release() was called (null = still held). */
  #releaseAt: number | null = null;
  #base = new Float32Array(HIPS_Y + 1);

  /** The emote on screen right now, including one that is fading out. */
  get id(): EmoteId | null {
    return this.#def?.id ?? null;
  }

  /** Running and not yet released — what "am I still emoting?" means. */
  get playing(): boolean {
    return this.#def !== null && this.#releaseAt === null;
  }

  /** Still contributing to the pose (covers the fade-out tail). */
  get active(): boolean {
    return this.#def !== null;
  }

  /** Start, or restart if the same emote is already running. */
  play(id: EmoteId): void {
    const def = emoteById(id);
    if (!def) return;
    this.#def = def;
    this.#t = 0;
    this.#releaseAt = null;
  }

  /** Let it finish gracefully: the pose fades back into whatever the body is
   *  doing instead. Idempotent. */
  release(): void {
    if (this.#def && this.#releaseAt === null) this.#releaseAt = this.#t;
  }

  /** Drop it this instant — for when something else needs the body NOW (a
   *  swing, a mode change, hitting the water). Restores neutral mitts. */
  cancel(rig?: Rig): void {
    if (!this.#def) return;
    this.#def = null;
    this.#releaseAt = null;
    this.#t = 0;
    if (rig) restoreHands(rig);
  }

  /** Advance and write. Must run AFTER the frame's base pose. */
  apply(rig: Rig, dt: number): void {
    const def = this.#def;
    if (!def) return;
    this.#t += dt;
    const ended =
      this.#releaseAt !== null
        ? this.#t >= this.#releaseAt + def.fadeOut
        : !def.loop && this.#t >= def.duration;
    if (ended) {
      this.cancel(rig);
      return;
    }
    const w = this.#weight(def);
    if (w <= 0) return;

    const base = this.#base;
    for (let i = 0; i < BLEND_JOINTS.length; i++) {
      const rot = rig[BLEND_JOINTS[i]].rotation;
      base[i * 3] = rot.x;
      base[i * 3 + 1] = rot.y;
      base[i * 3 + 2] = rot.z;
    }
    base[HIPS_Y] = rig.hips.position.y;

    def.pose(rig, this.#t);

    for (let i = 0; i < BLEND_JOINTS.length; i++) {
      const rot = rig[BLEND_JOINTS[i]].rotation;
      rot.set(
        base[i * 3] + (rot.x - base[i * 3]) * w,
        base[i * 3 + 1] + (rot.y - base[i * 3 + 1]) * w,
        base[i * 3 + 2] + (rot.z - base[i * 3 + 2]) * w
      );
    }
    rig.hips.position.y = base[HIPS_Y] + (rig.hips.position.y - base[HIPS_Y]) * w;

    // Mitts are set outright rather than blended. Their rotations are NOT
    // rewritten by the base poses (poses never touch hand children), so a
    // blended value would feed back into its own snapshot and freeze mid-curl.
    // A finger curl swapping over one frame is invisible at this scale.
    setHandPose(rig, "L", def.handL ?? HAND_RELAXED);
    setHandPose(rig, "R", def.handR ?? HAND_RELAXED);
  }

  #weight(def: EmoteDef): number {
    const rise = def.fadeIn <= 0 ? 1 : clamp01(this.#t / def.fadeIn);
    let fall = 1;
    if (this.#releaseAt !== null) {
      fall = def.fadeOut <= 0 ? 0 : 1 - clamp01((this.#t - this.#releaseAt) / def.fadeOut);
    } else if (!def.loop) {
      fall = def.fadeOut <= 0 ? 1 : clamp01((def.duration - this.#t) / def.fadeOut);
    }
    return ease(Math.min(rise, fall));
  }
}

/** Neutral open mitts — what an un-posed rig looks like, and what the local
 *  player's per-frame hand state falls back to. */
function restoreHands(rig: Rig): void {
  setHandPose(rig, "L", 0);
  setHandPose(rig, "R", 0);
}
