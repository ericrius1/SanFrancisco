import * as THREE from "three/webgpu";

/**
 * A kite does not chase a point in the sky — it lives on a sphere around the
 * flyer's hand, and everything that makes one beautiful to watch happens in two
 * angles on that sphere: `swing` across the wind and `elevation` above the
 * horizon.
 *
 * Modelling those two directly (rather than lerping a world-space target) is
 * what produces the real behaviour for free: the kite is most powerful straight
 * downwind and goes soft toward the edges of the window, so a swing out to the
 * side costs height and the return through the middle trades it back as a
 * climb. Run a circle on the sand and the pendulum this drives writes the
 * figure eight by itself.
 */
export type WindWindowState = {
  /** Radians across the wind axis; 0 is straight downwind of the flyer. */
  swing: number;
  swingVel: number;
  /** Radians above the horizon along the current swing bearing. */
  elevation: number;
  elevationVel: number;
  /** 0..~1.4 — how hard the cloth is loaded right now. */
  power: number;
  /** 0..1 flight energy; drives altitude, tail deployment and cloth billow. */
  energy: number;
  /** Roll to apply to the cloth, radians. A kite banks into its own swing. */
  bank: number;
};

export type WindWindowCommand = {
  dt: number;
  elapsed: number;
  /** Tuned wind strength, already gust-modulated by the caller. */
  wind: number;
  gust: number;
  /** Deliberate steering from the current figure, -1..1. */
  steer: number;
  /** Flyer's ground speed across the wind axis, m/s (signed). */
  pilotLateral: number;
  /** Flyer's ground speed into the wind, m/s (signed; positive = upwind). */
  pilotUpwind: number;
  /** 0..1 envelope of a two-handed haul on the line. */
  tug: number;
  /** OCEAN_KITE_TUNING lift. */
  lift: number;
  /** OCEAN_KITE_TUNING drag. */
  drag: number;
  /** 0..1 ramp that holds the kite down through the arrival launch. */
  launchGate: number;
  /**
   * Radians the elevation TARGET may never dip under (default 0 = off).
   *
   * The authored beach flock sets this. Left free, a figure at the window's
   * edge lets elevation sag toward MIN_ELEVATION, and from the shots this
   * beach is filmed in — a lens at head height a hundred-plus metres back —
   * a kite that low projects into the strip of sea between the surf and the
   * sky and reads as floating in the water, however far inland it really is.
   * A floor on the TARGET (not the state) keeps the spring, the overshoot
   * and the swoop; the kite just performs its window a storey higher.
   */
  elevationFloor?: number;
};

const MAX_ELEVATION = 1.31; // ~75°, just shy of overhead
const MIN_ELEVATION = 0.05;
const MAX_SWING = 1.22; // ~70° off the wind axis; past that a kite falls out

export function createWindWindow(): {
  state: WindWindowState;
  update(command: WindWindowCommand): void;
} {
  const state: WindWindowState = {
    swing: 0,
    swingVel: 0,
    elevation: 0.16,
    elevationVel: 0,
    power: 0,
    energy: 0.04,
    bank: 0
  };

  return {
    state,
    update(c) {
      const dt = c.dt;

      // Apparent wind: what the cloth actually feels. Running upwind adds to
      // it, drifting downwind bleeds it away, and a haul on the line spikes it.
      const apparent = Math.max(
        0.05,
        c.wind + c.pilotUpwind * 0.19 + c.tug * 0.62 + c.gust * 0.18
      );

      // Power collapses toward the edges of the window. This one term is what
      // makes a side swing cost altitude and the centre pass give it back.
      const edge = Math.cos(THREE.MathUtils.clamp(state.swing, -MAX_SWING, MAX_SWING));
      state.power = apparent * (0.3 + 0.7 * edge * edge);

      const energyTarget =
        THREE.MathUtils.clamp(0.34 + state.power * 0.44, 0.03, 1) * c.launchGate;
      state.energy += (energyTarget - state.energy) * (1 - Math.exp(-dt * (1.5 + c.lift * 1.7)));

      // Elevation is a spring, not a lerp: the kite overshoots a climb and
      // settles back down through it, which is the swoop.
      const elevationTarget = THREE.MathUtils.clamp(
        Math.max(
          MAX_ELEVATION * state.energy * c.lift * (0.62 + 0.38 * edge),
          c.elevationFloor ?? 0
        ),
        MIN_ELEVATION,
        MAX_ELEVATION
      );
      const stiffness = 2.1 + c.lift * 2.6;
      state.elevationVel += (elevationTarget - state.elevation) * stiffness * dt;
      state.elevationVel *= Math.exp(-(1.6 + c.drag * 2.2) * dt);
      state.elevation += state.elevationVel * dt;
      if (state.elevation < MIN_ELEVATION) {
        state.elevation = MIN_ELEVATION;
        state.elevationVel = Math.max(0, state.elevationVel);
      } else if (state.elevation > MAX_ELEVATION) {
        state.elevation = MAX_ELEVATION;
        state.elevationVel = Math.min(0, state.elevationVel);
      }

      // Swing is a driven, damped pendulum. The flyer's crosswind motion drags
      // the anchor out from under the kite, deliberate steering leans on it,
      // and a slow breath keeps a parked kite from ever sitting perfectly dead.
      const breath =
        Math.sin(c.elapsed * 0.41) * 0.12 + Math.sin(c.elapsed * 0.97 + 1.7) * 0.06;
      const drive =
        -c.pilotLateral * 0.085 + c.steer * 0.85 + breath * (0.4 + c.gust * 0.9);
      // The restoring pull scales with power, so a soft kite at the window edge
      // hangs there a beat before it swings back.
      const restore = Math.sin(state.swing) * (1.35 + state.power * 1.15);
      const damping = 1.05 + c.drag * 1.5;
      state.swingVel += (drive - restore - state.swingVel * damping) * dt;
      state.swing += state.swingVel * dt;
      if (state.swing > MAX_SWING) {
        state.swing = MAX_SWING;
        state.swingVel = Math.min(0, state.swingVel);
      } else if (state.swing < -MAX_SWING) {
        state.swing = -MAX_SWING;
        state.swingVel = Math.max(0, state.swingVel);
      }

      // Bank into the turn, plus a standing lean when parked off to one side.
      const bankTarget = THREE.MathUtils.clamp(
        state.swingVel * 0.52 + state.swing * 0.26,
        -0.78,
        0.78
      );
      state.bank += (bankTarget - state.bank) * (1 - Math.exp(-dt * 6));
    }
  };
}
