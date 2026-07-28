import * as THREE from "three/webgpu";
import { waterHeight } from "../../world/heightmap";

/**
 * Four-probe hull buoyancy — the piece that makes a boat *ride* the bay instead
 * of being dragged along a lagging height spring.
 *
 * The bay runs a real sea: the analytic hero band is Hs ≈ 3.4 m with 19–42 m
 * wavelengths, faces up to ~27° and a surface that moves 4 m/s vertically. The
 * old model tracked `waterHeight + 0.15` with a first-order spring (τ ≈ 0.24 s).
 * At planing speed the *encounter* period drops under a second, so the tracker
 * attenuated to a third of the wave height and lagged ~70° out of phase — the
 * hull spent a fifth of its time with the whole deck under the surface and
 * another fifth yanked clear of the water with no gravity to bring it back.
 *
 * Instead we sample the surface under four keel-plane probes (bow, stern, port,
 * starboard), turn each probe's submerged depth into buoyant acceleration, and
 * let the controller integrate. Consequences fall out for free:
 *
 *  - Following the swell is the *equilibrium*, not a chase: at the resting
 *    waterline mean submersion is 1 and buoyancy exactly cancels gravity.
 *  - Heave damping works on velocity RELATIVE to the surface (∂η/∂t), so the
 *    hull is not fighting the water it is riding.
 *  - Launch off a crest and every probe leaves the water: buoyancy goes to 0
 *    and the boat is on a plain ballistic arc until it lands. No special case.
 *  - Bury the bow and submersion climbs past 1 into the reserve-buoyancy ramp,
 *    which is deliberately steeper than the hull's own — a swamped boat corks
 *    back up at ~1 g instead of sinking.
 *  - The probe spread is the hull's real footprint, so the fitted plane IS the
 *    trim a rigid hull takes on that piece of water: pitch up the face, roll in
 *    a beam sea.
 */

export interface HullSpec {
  /** Bow/stern from the mesh origin (m). */
  halfLength: number;
  /** Rail from the mesh origin (m). */
  halfBeam: number;
  /** Keel below the mesh origin (m). */
  draft: number;
  /** Deck lip above the mesh origin (m) — reserve buoyancy runs out here. */
  freeboard: number;
  /** Mesh origin above the still waterline at rest (m). */
  rideHeight: number;
}

/** Day-sailer: 5.9 m canoe body, high bulwarks, deep-ish forefoot. */
export const SAILBOAT_HULL: HullSpec = {
  halfLength: 2.95,
  halfBeam: 1.12,
  draft: 0.57,
  freeboard: 0.66,
  rideHeight: 0.15
};

/** Runabout: shorter, beamier, and a low open cockpit — far less reserve. */
export const SPEEDBOAT_HULL: HullSpec = {
  halfLength: 2.8,
  halfBeam: 0.98,
  draft: 0.56,
  freeboard: 0.34,
  rideHeight: 0.15
};

export interface HullFloat {
  /** Mean submersion: 1 = resting waterline, 0 = every probe clear of the water. */
  sub: number;
  /** Submersion under the transom — prop, rudder and skeg authority. */
  sternSub: number;
  /** Submersion under the forefoot — bow-burying / spray. */
  bowSub: number;
  /** Vertical acceleration (m/s²), gravity already included. */
  accelY: number;
  /** Surface normal fitted through the hull footprint (world, unit). */
  normal: THREE.Vector3;
  /** ∂η/∂t under the hull centre (m/s) — how fast the sea itself is rising. */
  surfaceRate: number;
  /** Downhill gravity along the wave face (world XZ, m/s²). */
  surgeX: number;
  surgeZ: number;
}

export function makeHullFloat(): HullFloat {
  return {
    sub: 1,
    sternSub: 1,
    bowSub: 1,
    accelY: 0,
    normal: new THREE.Vector3(0, 1, 0),
    surfaceRate: 0,
    surgeX: 0,
    surgeZ: 0
  };
}

const G = 9.81;

/**
 * Extra stiffness above the resting waterline, where the topsides flare. A
 * hull carries far more reserve buoyancy per metre than its underwater body,
 * which is what turns a green-water burial back into a boat.
 */
const RESERVE_GAIN = 1.2;
/**
 * Ceiling on a probe's submersion (in weights of buoyancy). A dry sealed hull
 * fully under really does carry many times its own weight, but an uncapped
 * ramp fires the boat out of the sea like a beach ball, so the reserve stops
 * at "corks back up at 4 g".
 */
const MAX_SUB = 5;
/**
 * Quadratic heave drag (per m/s of relative vertical speed). Linear damping is
 * calibrated for nodding along on her lines; a hull that lands off a crest at
 * 4 m/s would punch a metre and a half clean through the surface under it, and
 * a boat with water closing over the deck is exactly the thing this model
 * exists to stop. Slamming is a v² business, and a real hull entering at
 * 4 m/s is stopped inside half a metre — that is this term.
 */
const SLAM_DRAG = 1.5;
/** Ceiling on damping acceleration (m/s²) — a slam brakes hard, not infinitely. */
const MAX_DAMP = 40;
/** Half-window for the ∂η/∂t central difference (s). */
const RATE_DT = 0.05;

const V = {
  probe: new THREE.Vector3(),
  fwd: new THREE.Vector3(),
  right: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0)
};

/**
 * Depth (m) under one probe → its share of the hull's buoyancy, in weights
 * (1 = floating on her lines).
 *
 * The curve below the waterline is quadratic, not linear, because these are
 * V-sections: displaced volume grows with the square of immersion. That is not
 * cosmetic — it doubles the restoring stiffness at the waterline to
 * 2·G/restDepth ≈ 48 s⁻², i.e. a ~0.9 s natural heave period, which is what
 * `ρgA_wp/m` actually works out to for a boat this size. A linear ramp gives
 * 1.3 s, and a hull that slow can no longer keep up with its own encounter
 * frequency at planing speed: it plows straight through the crests instead of
 * lifting over them.
 */
function submersion(depth: number, restDepth: number): number {
  if (depth <= 0) return 0;
  const s = depth / restDepth;
  if (s <= 1) return s * s;
  return Math.min(MAX_SUB, 1 + (s - 1) * 2 * RESERVE_GAIN);
}

/**
 * Sample the sea under one hull pose and fill `out`. Six `waterHeight` calls —
 * four probes plus a forward/backward pair for the surface rate — which is what
 * the single-point spring already cost (its own probe, a look-ahead, a time
 * step and four for the normal).
 *
 * `vy` is the body's current vertical velocity; `heaveDamp` is the linear
 * damping coefficient (≈ 2ζω — with ω ≈ 6.9 rad/s for these hulls, 6–7 puts
 * them around ζ ≈ 0.5, damped but still lively).
 */
export function sampleHullFloat(
  hull: HullSpec,
  pos: THREE.Vector3,
  quat: THREE.Quaternion,
  vy: number,
  t: number,
  heaveDamp: number,
  out: HullFloat
): void {
  const restDepth = hull.draft - hull.rideHeight;
  const fwd = V.fwd.set(0, 0, -1).applyQuaternion(quat);
  const right = V.right.set(1, 0, 0).applyQuaternion(quat);
  // Keel-plane offset of the probe ring, rotated with the hull so a rolled boat
  // genuinely buries the low rail.
  const keel = V.probe.set(0, -hull.draft, 0).applyQuaternion(quat);
  const keelX = keel.x;
  const keelY = keel.y;
  const keelZ = keel.z;

  const hl = hull.halfLength;
  const hb = hull.halfBeam;
  const baseX = pos.x + keelX;
  const baseY = pos.y + keelY;
  const baseZ = pos.z + keelZ;
  // Sea surface over each probe, and the probe's own world Y. Their difference
  // is that probe's immersion; the surface heights themselves fit the wave.
  const yBow = baseY + fwd.y * hl;
  const hBow = waterHeight(baseX + fwd.x * hl, baseZ + fwd.z * hl, t);
  const yStern = baseY - fwd.y * hl;
  const hStern = waterHeight(baseX - fwd.x * hl, baseZ - fwd.z * hl, t);
  const yStbd = baseY + right.y * hb;
  const hStbd = waterHeight(baseX + right.x * hb, baseZ + right.z * hb, t);
  const yPort = baseY - right.y * hb;
  const hPort = waterHeight(baseX - right.x * hb, baseZ - right.z * hb, t);

  const sBow = submersion(hBow - yBow, restDepth);
  const sStern = submersion(hStern - yStern, restDepth);
  const sStbd = submersion(hStbd - yStbd, restDepth);
  const sPort = submersion(hPort - yPort, restDepth);
  const sub = (sBow + sStern + sStbd + sPort) * 0.25;

  // Wave plane through the hull footprint — in WORLD space, from the surface
  // heights themselves. Differencing the probe *depths* instead would measure
  // the wave relative to the hull, which is a different (and much smaller)
  // thing: once the attitude controller has the boat lying along the wave, that
  // residual is ~0, and reading the sea's slope off it would say the water is
  // flat at the bottom of a 27° face.
  const fh = Math.hypot(fwd.x, fwd.z) || 1;
  const rh = Math.hypot(right.x, right.z) || 1;
  const slopeFwd = (hBow - hStern) / (2 * hl * fh);
  const slopeRight = (hStbd - hPort) / (2 * hb * rh);
  const n = out.normal.set(
    (-slopeFwd * fwd.x) / fh + (-slopeRight * right.x) / rh,
    1,
    (-slopeFwd * fwd.z) / fh + (-slopeRight * right.z) / rh
  );
  n.normalize();

  // Surface vertical velocity under the hull. Damping is measured against THIS,
  // not against zero: a hull rising with its wave feels no heave damping at all.
  const rate =
    (waterHeight(pos.x, pos.z, t + RATE_DT) - waterHeight(pos.x, pos.z, t - RATE_DT)) / (2 * RATE_DT);

  out.sub = sub;
  out.sternSub = sStern;
  out.bowSub = sBow;
  out.surfaceRate = rate;
  // buoyancy (G·sub) − gravity (G) − heave damping, all in m/s². Damping is
  // linear + quadratic against the sea's OWN vertical motion, and scales with
  // how much hull is in the water, so a boat dropping onto a wave is braked
  // far harder than one nodding on her lines.
  const rel = vy - rate;
  const wetArea = Math.min(sub, 1); // wetted area saturates at the waterline
  // Slamming is a surface event — it is the hull's added mass changing as it
  // crosses the interface, not steady drag. Fading it out by the time the boat
  // is fully under matters: left on, it gives a swamped hull a ~2.5 m/s
  // terminal rise, so a crest that closes over the deck keeps it for a second
  // and a half. Off, she corks straight back out.
  const slam = wetArea * THREE.MathUtils.clamp(2 - sub, 0, 1);
  const damp = (heaveDamp * wetArea + SLAM_DRAG * Math.abs(rel) * slam) * rel;
  out.accelY = G * (sub - 1) - THREE.MathUtils.clamp(damp, -MAX_DAMP, MAX_DAMP);
  // Gravity resolved along the wave face: run down the front, grind up the back.
  out.surgeX = G * n.y * n.x * wetArea;
  out.surgeZ = G * n.y * n.z * wetArea;
}
