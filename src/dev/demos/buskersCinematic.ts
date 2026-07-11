import * as THREE from "three/webgpu";
import type { Demo, DemoContext } from "../demo";
import { cleanPlate, freezeAndBuryPlayer, monotoneCurve, repin, smoothstep, type CineWindow } from "./shared";

/**
 * "buskers" — a 30-second single-take orbit of the busker trio on the Corona
 * Heights summit while game time races 5:00 pm → 10:15 pm.
 *
 * The musicians play at NORMAL speed (their transport advances on real frame
 * dt via buskers.update); ONLY the time-of-day is accelerated. Everything the
 * camera + sky do is a pure function of virtual time T = window.__cineT ∈
 * [0,30], installed through ctx.setCine, so the deterministic frame capture is
 * glassy-smooth (the ggboat pattern).
 *
 * The camera starts behind the trio looking over their shoulders at downtown,
 * dollies in to their faces by T=14 (dusk, ~7:50 pm), drifts a touch past the
 * front through the 8:05 pm sunset beat, then pulls back + rises all the way
 * around to a wide over-the-shoulders finish with the moon over the city.
 */

export const SHOT_SECONDS = 30;

// Summit platform centre — must match createBuskerTrio() in main.ts so the
// buried player's tile-streaming XZ stays on the trio.
const ANCHOR_X = 412;
const ANCHOR_Z = 2760;

// Camera azimuth (radians) directly behind the trio, matching the deck yaw
// (they face ESE ≈ (+0.989,0,+0.150)); camPos = anchor + (sin·R, H, cos·R), so
// this puts the lens on the far side, looking over their shoulders at downtown.
const AZ_BEHIND = -1.721;
// Orbit spin direction: -1 sweeps the opposite way around from take 1 (which
// used +1). az = AZ_BEHIND + ORBIT_DIR·π·u.
const ORBIT_DIR = -1;

// 5:00 pm start; 7:50 pm as the camera reaches the front; 8:05 pm sunset beat;
// 10:15 pm end.
const timeOfDayCurve = monotoneCurve([
  [0, 17.0],
  [14, 19.833],
  [16, 20.083],
  [30, 22.25]
]);

// Orbit radius (m) and camera height above the anchor (m). Both dip toward the
// close front pass at T=14, then open out for the wide pull-back finish.
const radiusCurve = monotoneCurve([
  [0, 8.5],
  [1, 8.5],
  [14, 4.6],
  [17, 5.0],
  [30, 11.5]
]);
const heightCurve = monotoneCurve([
  [0, 2.8],
  [1, 2.8],
  [14, 1.4],
  [17, 1.5],
  [30, 4.8]
]);

/**
 * u(T): the orbit sweep, 0 → 2 (az = AZ_BEHIND + π·u, i.e. a full 360°). Each
 * leg uses smoothstep easing so the camera velocity is zero at every keyframe —
 * it arrives at the front (u=1, T=14) dead-on and holds, drifts a touch past
 * (u=1.12) through the sunset beat, then eases all the way back around to behind
 * (u=2). ORBIT_DIR sets which way the sweep goes; either way the anchor keeps
 * the city behind the trio mid-orbit.
 */
function orbitU(T: number): number {
  if (T <= 1) return 0; // static behind-hold while the trio rests
  if (T <= 14) return smoothstep((T - 1) / 13); // 0 → 1, dolly to the front
  if (T <= 17) return 1 + 0.12 * smoothstep((T - 14) / 3); // 1 → 1.12, drift past
  return 1.12 + 0.88 * smoothstep((T - 17) / 13); // 1.12 → 2, back around behind
}

export const buskersCinematic: Demo = {
  name: "buskers",
  run(ctx: DemoContext) {
    const { camera, sky, hud } = ctx;
    const buskers = ctx.buskers;
    if (!buskers) {
      console.warn("[demo:buskers] no busker trio on the context; nothing to shoot.");
      return;
    }
    const win = window as CineWindow;
    const q = new URLSearchParams(location.search);
    const manual = q.has("manual");
    const hold = q.has("hold");

    // --- clean plate + freeze the world clock ------------------------------
    cleanPlate(hud);
    if (sky) sky.cycleEnabled = false;
    // Do NOT touch exposure or postfx for this first take — defaults; we tune
    // after review.

    const buried = freezeAndBuryPlayer(ctx, ANCHOR_X, ANCHOR_Z);

    // The transport free-runs from boot, so park the trio silent + resting until
    // the timeline actually goes live (below). The real downbeat cue then lands
    // at T=1 (cueShow(1.0)), fired exactly once.
    buskers.cueShow(9999);
    let cued = false;
    const goLive = () => {
      if (cued) return;
      cued = true;
      buskers.cueShow(1.0); // 1s of rest, then the downbeat at T=1
    };

    // --- the pure-function shot -------------------------------------------
    const anchor = new THREE.Vector3();
    const step = (Traw: number) => {
      const T = Math.min(SHOT_SECONDS, Math.max(0, Traw));

      // accelerated clock (only the sky moves fast; the band plays real-time)
      if (sky) sky.setTimeOfDay(Math.min(24, Math.max(0, timeOfDayCurve(T))));

      // orbit anchor ≈ chest/head height at the handpanist's seat (seatWorld is
      // already +0.55 above the seat; +0.55 more lands between chest and head)
      buskers.seatWorld("handpan", anchor);
      anchor.y += 0.55;

      const az = AZ_BEHIND + ORBIT_DIR * Math.PI * orbitU(T);
      const R = radiusCurve(T);
      const H = heightCurve(T);
      camera.position.set(anchor.x + Math.sin(az) * R, anchor.y + H, anchor.z + Math.cos(az) * R);
      camera.up.set(0, 1, 0);
      camera.lookAt(anchor);

      repin(buried, ctx); // keep the (still-stepping) buried body from drifting
    };

    // --- arm + drive modes -------------------------------------------------
    let started = false; // realtime timeline running (auto-advance __cineT)
    win.__cineT = 0;
    step(0);
    win.__sfReelArmed = true;
    win.__sfReelDone = false;

    ctx.setCine((dt: number) => {
      if (!manual && started) win.__cineT = Math.min(SHOT_SECONDS, (win.__cineT ?? 0) + dt);
      step(win.__cineT ?? 0);
      if ((win.__cineT ?? 0) >= SHOT_SECONDS) win.__sfReelDone = true;
    });

    if (manual) {
      // Deterministic capture: __sfReelStep(sec) sets virtual time; nothing
      // auto-advances. The first step is when the timeline goes live.
      win.__sfReelStep = (sec: number) => {
        goLive();
        win.__cineT = Math.min(SHOT_SECONDS, Math.max(0, sec));
      };
    } else if (hold) {
      // Realtime, armed + waiting: the render tool calls __sfStartShot to begin.
      win.__sfStartShot = () => {
        win.__cineT = 0;
        started = true;
        goLive();
      };
    } else {
      // Bare /?demo=buskers — start immediately for eyeballing in a browser.
      win.__cineT = 0;
      started = true;
      goLive();
    }
  }
};
