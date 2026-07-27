import { solarPosition, type SfCivilTime } from "../solar";
import { SUTRO_BATHS, sutroHallWallInset } from "./layout";
import { SUTRO_BATHS_TUNING } from "./tuning";

/**
 * The out-of-time pocket.
 *
 * Step inside the restored hall and the clock stops mattering. However bright
 * the afternoon was on the road above, the glass roof fills with a long low
 * sunset that never quite finishes: the light drifts down into civil twilight,
 * hangs there, and comes back up again on a slow cycle, over and over, while
 * the lamps hold the room together. That is the whole idea of the place — a
 * warm evening you can walk into whenever you like.
 *
 * HOW IT WORKS
 *
 * Two separate signals, because they answer two different questions.
 *
 *  - `depth` is a smoothed 0..1 "am I in the building": 1 ANYWHERE under the
 *    roof, 0 out on the road or the beach, feathered over the few metres just
 *    outside the wall. It drives everything that is genuinely a property of the
 *    ROOM — the lamps coming up, the water's night response, the interior
 *    grade. Those are applied to the whole hall at once, so the feather has to
 *    live on the approach: a blend that sagged towards the walls dimmed every
 *    lamp in the building whenever the visitor wandered over to the glass.
 *
 *  - `skyBlend` is a 0..1 crossfade for the SKY, and it deliberately does NOT
 *    follow position. Driving the hour off `depth` was the original design and
 *    it was wrong in a way you feel immediately: the hour became a function of
 *    where you stood, so walking a few metres in and out dragged the sun and
 *    moon back and forth across the sky at walking pace. Instead the pocket
 *    LATCHES inside/outside with wide hysteresis, and `skyBlend` ramps toward
 *    that latch on the WALL CLOCK over a fixed number of seconds. Once the latch
 *    is set, walking around inside cannot move the hour at all — and a visitor
 *    who arrives already inside (a teleport straight onto the deck) gets the
 *    evening immediately, with no sweep at all.
 *
 *    The latch itself is measured in METRES from the hall wall, never on
 *    `depth`. Reading `depth` was the same mistake one layer down: the feather
 *    has already collapsed a few metres INSIDE the wall (sooner in a corner,
 *    where two feathers multiply), so the hour snapped back to the real
 *    afternoon while the visitor was still walking the deck.
 *
 *  - The hour that produces the wanted light is SOLVED, not hard-coded: the
 *    pocket asks for a sun elevation (just above the horizon → a few degrees
 *    below it) and bisects the evening for the civil hour that delivers it on
 *    today's date. So it reads the same in December as in June, which a fixed
 *    "20:15" never would.
 *  - That hour is handed to `sky.setTimeAuthority`, crossfaded from the world's
 *    own clock along the SHORT way round the 24-hour circle. Leaving releases
 *    the authority and the world's real time comes straight back — the pocket
 *    owns no stashed state that could leak a pinned sky. The remembered world
 *    hour ticks forward on the wall clock while the pocket holds the sky, so the
 *    handback lands on the time it actually is outside rather than the time it
 *    was when the visitor walked in.
 */

/** The subset of Sky this needs — structural so probes can stub a clock. */
export type SutroSkyClock = {
  readonly timeOfDay: number;
  readonly civilTime: SfCivilTime;
  readonly timeAuthority: number | null;
  setTimeAuthority(hours: number | null): void;
  /**
   * The dome's own radiance in a world direction, point features excluded.
   *
   * Not a clock duty, but it is the same Sky object, and the pools borrow it so
   * their mirror is the sky rather than a second hand-authored gradient that
   * would drift away from it across the pocket's sunset-to-twilight swing.
   * Optional because probes stub this type with a bare clock.
   */
  envRadiance?(dir: unknown, level: unknown): unknown;
};

export type SutroTwilightOptions = {
  sky?: SutroSkyClock | null;
  /** Called when the pocket's depth crosses into/out of "deep inside". */
  onExteriorThinned?: (thinned: boolean) => void;
};

export type SutroTwilightState = {
  depth: number;
  /** Wall-clock sky crossfade. Never a function of where the visitor stands. */
  skyBlend: number;
  /** The latch `skyBlend` is ramping toward. */
  inside: boolean;
  hour: number;
  sunsetHour: number;
  twilightHour: number;
  lampGlow: number;
  exteriorThinned: boolean;
  authorityHeld: boolean;
};

export type SutroTwilight = {
  /** 0 outside → 1 deep inside the hall. */
  readonly depth: number;
  /** 0 lamps dark → 1 lamps carrying the room. */
  readonly lampGlow: number;
  update(dt: number, player: { x: number; y?: number; z: number }): void;
  /** Hand the world clock back at once (site sleep, dispose, perf suppression). */
  release(): void;
  debugState(): SutroTwilightState;
};

/** Sun elevations (degrees) the drift swings between. */
const SUNSET_ELEVATION = 4.6; // late gold: the hall floor still catches the sun
const TWILIGHT_ELEVATION = -2.6; // dusk: violet overhead, the horizon still burning

/**
 * Metres inside the wall at which the exterior is considered unobservable and
 * gets thinned, and at which it comes back.
 *
 * Its own geometric test rather than a `depth` threshold, because thinning
 * answers a different question from the room's light: not "is the hall at
 * evening" but "can anyone still see the city from where this visitor stands".
 * Deep in the hall, no; a few metres inside the portal, very much yes.
 */
const THIN_ON_INSET = 12;
const THIN_OFF_INSET = 8;

/**
 * Hysteresis band for the inside/outside LATCH that owns the sky, in METRES
 * from the hall's wall plane (positive inside, negative outside).
 *
 * These used to be thresholds on `depth`, and that was the bug: `depth` is a
 * feathered blend that has already fallen to a sixth of its value several
 * metres INSIDE the wall — sooner still in a corner, where the two axis
 * feathers multiply. So the sky handed the hour back while the visitor was
 * still on the deck, and walking near the north end or down the outer edge of
 * the spiral snapped the time back to the middle of the afternoon.
 *
 * Measured against the wall instead, the rule reads the way the place does:
 * the evening takes over just inside the building, and it does not let go until
 * the visitor is a good four metres clear of it — past the doorway, out onto
 * the promenade. The band between them is still several metres of walking, so a
 * pause in the threshold or a capsule jittering on a tread cannot flip it.
 */
const LATCH_IN_INSET = 1.5;
const LATCH_OUT_INSET = -4.5;

/**
 * Seconds the sky crossfade takes, per direction. Wall-clock, fixed, and
 * independent of gait: this is the ONLY thing that sets how fast the sun can
 * move during a handover. Slower going in (the evening settles over you) than
 * coming out (the road should not keep a sunset for long).
 */
const SKY_FADE_IN_SECONDS = 7;
const SKY_FADE_OUT_SECONDS = 4.5;

/**
 * Metres of `depth` feather, and it sits entirely OUTSIDE the wall: depth is a
 * flat 1 anywhere in the building and fades to 0 over the few metres beyond it.
 *
 * It used to feather inward over 14 m from each wall, multiplied across both
 * axes — so `depth` read 0.09 standing by the east glass and near zero in a
 * corner. Everything depth drives (the lamps, the water's night response, the
 * interior grade) is a property of the WHOLE hall applied to the whole hall at
 * once, so that meant walking over to the windows dimmed every lamp in the
 * building. Inside is inside; the gradient belongs on the way in.
 */
const DEPTH_FADE_METRES = 6;

function smooth01(value: number): number {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}

/**
 * Civil hour on `civil`'s date whose sun elevation is `targetDeg`, taken on the
 * EVENING branch where elevation falls monotonically from solar noon to
 * midnight. Bisection on a monotone interval: 30 halvings resolve the hour to
 * well under a second, and this runs once per day, not per frame.
 */
export function solveEveningHour(civil: SfCivilTime, targetDeg: number): number {
  const elevationAt = (hour: number): number =>
    solarPosition({ ...civil, hour }).elevation;
  let low = 12; // at or after solar noon: the sun only goes down from here
  let high = 23.99;
  const lowElevation = elevationAt(low);
  const highElevation = elevationAt(high);
  // A polar-style day where the target never occurs: clamp to the nearer end
  // rather than returning a bisection artefact.
  if (lowElevation <= targetDeg) return low;
  if (highElevation >= targetDeg) return high;
  for (let i = 0; i < 30; i++) {
    const mid = (low + high) * 0.5;
    if (elevationAt(mid) > targetDeg) low = mid;
    else high = mid;
  }
  return (low + high) * 0.5;
}

/** Shortest-path interpolation on the 24-hour circle. */
export function mixHours(from: number, to: number, t: number): number {
  let delta = to - from;
  while (delta > 12) delta -= 24;
  while (delta < -12) delta += 24;
  const value = from + delta * t;
  return ((value % 24) + 24) % 24;
}

export function createSutroTwilight(options: SutroTwilightOptions = {}): SutroTwilight {
  const sky = options.sky ?? null;

  let depth = 0;
  let drift = 0; // phase of the sunset↔twilight swing
  let lastRampMs = performance.now();
  let sunsetHour = 20.2;
  let twilightHour = 20.9;
  let solvedDay = -1;
  let worldHour = 12;
  let exteriorThinned = false;
  let authorityHeld = false;
  let pocketHour = sunsetHour;
  /** The latch: what the sky is fading TOWARD. Flipped only by the hysteresis. */
  let inside = false;
  /** The wall-clock crossfade itself. */
  let skyBlend = 0;
  /**
   * True until the first update of a visit. The first sample must SNAP rather
   * than fade: a visitor who teleports onto the deck is already inside, and
   * fading in from the outdoor hour would sweep the sun across the sky for the
   * first seven seconds of their arrival — the exact artefact this file exists
   * to remove.
   */
  let needsSnap = true;

  const solveFor = (civil: SfCivilTime) => {
    const dayKey = civil.year * 10000 + civil.month * 100 + civil.day;
    if (dayKey === solvedDay) return;
    solvedDay = dayKey;
    sunsetHour = solveEveningHour(civil, SUNSET_ELEVATION);
    twilightHour = solveEveningHour(civil, TWILIGHT_ELEVATION);
  };

  const releaseAuthority = () => {
    if (!authorityHeld) return;
    authorityHeld = false;
    sky?.setTimeAuthority(null);
  };

  const setThinned = (next: boolean) => {
    if (exteriorThinned === next) return;
    exteriorThinned = next;
    options.onExteriorThinned?.(next);
  };

  return {
    get depth() {
      return depth;
    },
    get lampGlow() {
      return depth;
    },
    update(dt, player) {
      // The depth ramp runs on the WALL clock, not the world clock: the
      // "freeze the world, keep walking" mode drives this site with dt = 0 to
      // hold its bathers and water still, and a visitor who walks in under that
      // freeze must still see the light come up around them. The sunset↔twilight
      // drift below deliberately keeps the authored dt, so a frozen world does
      // hold its exact light for a capture.
      const nowMs = performance.now();
      const rampStep = Math.min(0.25, Math.max(0, (nowMs - lastRampMs) / 1000));
      lastRampMs = nowMs;
      const step = Math.min(0.1, Math.max(0, dt));
      const tuning = SUTRO_BATHS_TUNING.values;

      const y = player.y ?? SUTRO_BATHS.deckY;
      // Metres from the nearest wall: positive on the deck, negative out on the
      // promenade or the beach. The latch below reads this directly.
      const wallInset = sutroHallWallInset(player.x, player.z);
      // Vertically the pocket covers the basin floor up to a little above the
      // roof, so a swimmer at the bottom of the plunge and a visitor on the
      // upper gallery are both inside it.
      const height =
        smooth01((y - (SUTRO_BATHS.basinY - 6)) / 6) *
        smooth01((SUTRO_BATHS.roofApexY + 12 - y) / 10);
      // `depth` stays a feathered blend, because the things it drives — lamps,
      // the interior grade, the water's night response — genuinely want to come
      // up gradually as the visitor walks in. That gradient now lives on the
      // approach rather than inside the room: full anywhere under the roof,
      // fading out over the last few metres of the promenade.
      const target = tuning.pocketEnabled
        ? smooth01((wallInset + DEPTH_FADE_METRES) / DEPTH_FADE_METRES) * height
        : 0;

      // Ease in a little slower than out: arriving should feel like the light
      // settling over you, leaving should not hold a sunset over the road.
      const rate = target > depth ? 0.55 : 0.85;
      depth += (target - depth) * Math.min(1, rampStep * rate * 3);
      if (depth < 0.002 && target === 0) depth = 0;

      // The LATCH. Position is allowed to say "inside" or "outside" and nothing
      // more; it never says "42% of the way to evening". It reads metres from
      // the wall, never `depth`, so no amount of walking about INSIDE the hall
      // can release the hour — only actually leaving the building does.
      // Vertical containment is a hard gate on top: someone flying over the
      // roof is outside however deep into the plan they are.
      const latchInset = height > 0.5 ? wallInset : LATCH_OUT_INSET - 1;
      if (!tuning.pocketEnabled) inside = false;
      else if (inside ? latchInset < LATCH_OUT_INSET : latchInset > LATCH_IN_INSET) inside = !inside;

      // First sample of a visit: adopt the latch outright. Arriving inside must
      // look like the hall has always been at evening, not like a time-lapse.
      if (needsSnap) {
        needsSnap = false;
        skyBlend = inside ? 1 : 0;
      } else {
        const seconds = inside ? SKY_FADE_IN_SECONDS : SKY_FADE_OUT_SECONDS;
        const towards = inside ? 1 : 0;
        // Constant rate, wall clock. The sun's speed during a handover is this
        // and nothing else.
        skyBlend += Math.sign(towards - skyBlend) * Math.min(Math.abs(towards - skyBlend), rampStep / seconds);
      }

      if (!sky) return;

      // Fully outside AND fully faded out: hand the clock straight back.
      if (!inside && skyBlend <= 0) {
        releaseAuthority();
        worldHour = sky.timeOfDay;
        setThinned(false);
        return;
      }

      solveFor(sky.civilTime);
      if (!authorityHeld) {
        // Capture the hour the world was actually at, once, on the way in.
        worldHour = sky.timeOfDay;
        authorityHeld = true;
      } else {
        // Keep the remembered outdoor hour ticking on the real clock while the
        // pocket holds the sky, so the handback lands on the time it actually is
        // out there — not the time it was when the visitor came in.
        worldHour = (worldHour + rampStep / 3600) % 24;
      }

      drift += step / Math.max(20, tuning.pocketDriftSeconds);
      // A cosine swing dwells at both ends, so the room holds a full sunset and
      // a full twilight rather than sliding through them at constant speed.
      const swing = 0.5 - 0.5 * Math.cos(drift * Math.PI * 2);
      pocketHour = mixHours(sunsetHour, twilightHour, swing);
      sky.setTimeAuthority(mixHours(worldHour, pocketHour, smooth01(skyBlend)));

      setThinned(latchInset > (exteriorThinned ? THIN_OFF_INSET : THIN_ON_INSET));
    },
    release() {
      releaseAuthority();
      setThinned(false);
      depth = 0;
      inside = false;
      skyBlend = 0;
      // The next visit is a fresh arrival, and must snap rather than sweep.
      needsSnap = true;
    },
    debugState() {
      return {
        depth,
        skyBlend,
        inside,
        hour: pocketHour,
        sunsetHour,
        twilightHour,
        lampGlow: depth,
        exteriorThinned,
        authorityHeld
      };
    }
  };
}
