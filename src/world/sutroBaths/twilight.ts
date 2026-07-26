import { solarPosition, type SfCivilTime } from "../solar";
import { SUTRO_BATHS, sutroWorldToLocal } from "./layout";
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
 *  - `depth` is a smoothed 0..1 "how far inside am I": 1 deep in the hall,
 *    0 out on the road or the beach, with a wide feather so the handover
 *    happens while you walk down the gallery stair rather than snapping at a
 *    doorway.
 *  - The hour that produces the wanted light is SOLVED, not hard-coded: the
 *    pocket asks for a sun elevation (just above the horizon → six degrees
 *    below it) and bisects the evening for the civil hour that delivers it on
 *    today's date. So it reads the same in December as in June, which a fixed
 *    "20:15" never would.
 *  - That hour is handed to `sky.setTimeAuthority`, blended from the world's
 *    own clock by `depth` along the SHORT way round the 24-hour circle. Leaving
 *    releases the authority and the world's real time comes straight back — the
 *    pocket owns no stashed state that could leak a pinned sky.
 *
 * The same `depth` drives everything else that should notice the change: the
 * lamps, the water's night response, and the exterior thinning callback that
 * lets the compose layer stop paying for a city nobody inside can see.
 */

/** The subset of Sky this needs — structural so probes can stub a clock. */
export type SutroSkyClock = {
  readonly timeOfDay: number;
  readonly civilTime: SfCivilTime;
  readonly timeAuthority: number | null;
  setTimeAuthority(hours: number | null): void;
};

export type SutroTwilightOptions = {
  sky?: SutroSkyClock | null;
  /** Called when the pocket's depth crosses into/out of "deep inside". */
  onExteriorThinned?: (thinned: boolean) => void;
};

export type SutroTwilightState = {
  depth: number;
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

/** Depth at which the exterior is considered unobservable and gets thinned. */
const THIN_ON = 0.82;
const THIN_OFF = 0.55;

const HALL_HALF_WIDTH = SUTRO_BATHS.hallHalfWidth;
const HALL_HALF_LENGTH = SUTRO_BATHS.halfLength;
/** Metres of feather on each edge — a corridor's worth, not a doorway's. */
const FEATHER = 14;

function smooth01(value: number): number {
  const t = value < 0 ? 0 : value > 1 ? 1 : value;
  return t * t * (3 - 2 * t);
}

/** 1 well inside `half`, 0 beyond it, feathered over FEATHER metres. */
function axisInside(distance: number, half: number): number {
  return smooth01((half - Math.abs(distance)) / FEATHER);
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
function mixHours(from: number, to: number, t: number): number {
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

      const local = sutroWorldToLocal(player.x, player.z);
      const y = player.y ?? SUTRO_BATHS.deckY;
      // Vertically the pocket covers the basin floor up to a little above the
      // roof, so a swimmer at the bottom of the plunge and a visitor on the
      // upper gallery are both inside it.
      const height =
        smooth01((y - (SUTRO_BATHS.basinY - 6)) / 6) *
        smooth01((SUTRO_BATHS.roofApexY + 12 - y) / 10);
      const target = tuning.pocketEnabled
        ? axisInside(local.x, HALL_HALF_WIDTH) * axisInside(local.z, HALL_HALF_LENGTH) * height
        : 0;

      // Ease in a little slower than out: arriving should feel like the light
      // settling over you, leaving should not hold a sunset over the road.
      const rate = target > depth ? 0.55 : 0.85;
      depth += (target - depth) * Math.min(1, rampStep * rate * 3);
      if (depth < 0.002 && target === 0) depth = 0;

      if (!sky) return;

      if (depth <= 0) {
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
      }

      drift += step / Math.max(20, tuning.pocketDriftSeconds);
      // A cosine swing dwells at both ends, so the room holds a full sunset and
      // a full twilight rather than sliding through them at constant speed.
      const swing = 0.5 - 0.5 * Math.cos(drift * Math.PI * 2);
      pocketHour = mixHours(sunsetHour, twilightHour, swing);
      sky.setTimeAuthority(mixHours(worldHour, pocketHour, smooth01(depth)));

      setThinned(exteriorThinned ? depth > THIN_OFF : depth > THIN_ON);
    },
    release() {
      releaseAuthority();
      setThinned(false);
      depth = 0;
    },
    debugState() {
      return {
        depth,
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
