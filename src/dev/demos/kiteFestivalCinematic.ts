import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { SUN_DIR } from "../../world/sky";
import type { OceanBeachKiteEncounter } from "../../world/oceanBeachKite";
import type { Demo } from "../demo";
import { cleanPlate, freezeAndBuryPlayer } from "./shared";

export const KITE_FESTIVAL_SECONDS = 10;

/**
 * Five ten-second looks at the Ocean Beach kite festival, walked from the sun
 * still off the water down into blue hour.
 *
 * Every shot is the same live encounter — seven flyers, five designs, two
 * mirrored troupes — filmed from a different place at a different minute. The
 * camera is the only authored thing: the kites are wherever their wind window
 * has carried them by that frame, which is why each shot tracks a live kite
 * position rather than a keyframed point in space. Determinism comes from the
 * capture harness replaying the whole simulation from frame zero at a fixed
 * step, so "wherever they are" is the same wherever every time.
 */

type Framing = {
  id: string;
  title: string;
  /** SF wall-clock hour. 19.4 is sun-on-water; 20.75 is past sunset. */
  hour: number;
  exposure: number;
  /** Which flyer this shot is about; 0 is the diamond soloist. */
  subject: number;
  /**
   * Places the eye and the look-at each frame. `kite` and `runner` are the
   * subject's live positions, `flock` the mean kite. `sun` is the world
   * direction toward the sun, so a shot can put itself on the dark side of a
   * kite without hard-coding an azimuth that drifts with the hour.
   */
  frame(
    sample: { u: number; localTime: number },
    live: {
      kite: THREE.Vector3;
      runner: THREE.Vector3;
      flock: THREE.Vector3;
      sun: THREE.Vector3;
      ground: (x: number, z: number) => number;
    },
    eye: THREE.Vector3,
    target: THREE.Vector3
  ): number;
};

/**
 * Distance is the whole craft here. The sun sits about four degrees above the
 * water at these hours while the kites fly at thirty-plus metres, so a camera
 * parked close to a kite is looking steeply UP at it and the sun is nowhere in
 * frame — no glow, no shafts, no beach. Standing a hundred metres off flattens
 * the angle until kite and sun share the frame, which is the only geometry in
 * which any of this feature's light exists. Every shot below is framed from
 * that distance and reaches for a longer lens instead of a shorter throw.
 */
const FRAMINGS: readonly Framing[] = [
  {
    id: "01",
    title: "Ocean Beach Kites · The Whole Beach",
    hour: 19.42,
    exposure: 1,
    subject: 0,
    // Establishing. A slow lateral drift across the whole line of flyers, far
    // enough back that all seven and the sun are in one frame.
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(158, 132, drift))
        .addScaledVector(along, mix(-40, 30, drift));
      eye.y = live.ground(eye.x, eye.z) + mix(4.2, 7.4, drift);
      target.copy(live.flock).addScaledVector(along, mix(-6, 10, drift));
      target.y = live.flock.y * mix(0.66, 0.78, drift);
      return mix(30, 38, drift);
    }
  },
  {
    id: "02",
    title: "Ocean Beach Kites · Two Sunwheels",
    hour: 19.63,
    exposure: 1.04,
    subject: 1,
    // The mirrored pair, on a long lens so the two rotors compress against the
    // sun and their opposite arcs read as one gesture.
    frame: ({ u }, live, eye, target) => {
      const push = smoothstep(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.kite)
        .addScaledVector(live.sun, -mix(104, 88, push))
        .addScaledVector(along, mix(26, 10, push));
      eye.y = live.ground(eye.x, eye.z) + mix(3.1, 6.6, push);
      target.copy(live.kite).addScaledVector(along, mix(-4, 2, push));
      target.y = live.kite.y * mix(0.72, 0.84, push);
      return mix(52, 72, push);
    }
  },
  {
    id: "03",
    title: "Ocean Beach Kites · The Centipede",
    hour: 19.86,
    exposure: 1.06,
    subject: 6,
    // The dragon strung across the sun on the longest lens of the five, drifting
    // just enough that its rings pass through the disc one after another.
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.kite)
        .addScaledVector(live.sun, -mix(122, 106, drift))
        .addScaledVector(along, mix(-20, 16, drift));
      eye.y = live.ground(eye.x, eye.z) + mix(3.4, 7.8, drift);
      target.copy(live.kite);
      target.y = live.kite.y * mix(0.7, 0.82, drift);
      return mix(58, 78, drift);
    }
  },
  {
    id: "04",
    title: "Ocean Beach Kites · Running the Sand",
    hour: 20.12,
    exposure: 1.1,
    subject: 4,
    // Down on the sand with the sled pair. The only shot that stays close, and
    // it can afford to: at eye level looking up the beach the sun is dead ahead,
    // so the runners are silhouettes and their kites climb out of the top of
    // frame rather than needing to fit in it.
    frame: ({ u }, live, eye, target) => {
      const swing = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.runner)
        .addScaledVector(live.sun, -mix(34, 24, swing))
        .addScaledVector(along, mix(17, -13, swing));
      eye.y = live.ground(eye.x, eye.z) + 1.66;
      target.copy(live.runner).lerp(live.kite, mix(0.16, 0.4, swing));
      return mix(36, 46, swing);
    }
  },
  {
    id: "05",
    title: "Ocean Beach Kites · Blue Hour",
    hour: 20.62,
    exposure: 1.18,
    subject: 0,
    // Past sunset. The kites are shapes now rather than colours, so the shot
    // widens off them and lets the beach go quiet.
    frame: ({ u }, live, eye, target) => {
      const settle = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(118, 148, settle))
        .addScaledVector(along, mix(12, 34, settle));
      eye.y = live.ground(eye.x, eye.z) + mix(5.2, 10.5, settle);
      target.copy(live.flock).addScaledVector(along, mix(2, -6, settle));
      target.y = live.flock.y * mix(0.74, 0.62, settle);
      return mix(44, 32, settle);
    }
  }
];

type KiteWindow = Window & typeof globalThis & { __sf?: { oceanBeachKite?: OceanBeachKiteEncounter } };

function buildDemo(framing: Framing): Demo {
  const name = `ocean-beach-kite-${framing.id}`;
  return {
    name,
    run(ctx) {
      const { map, sky } = ctx;
      if (!map || !sky) {
        console.warn(`[demo:${name}] map or sky unavailable`);
        return;
      }

      cleanPlate(ctx.hud);
      sky.cycleEnabled = false;
      sky.setTimeOfDay(framing.hour);
      ctx.setExposure(framing.exposure);
      ctx.setPostFx({ ink: false, dream: false, retro: false });
      ctx.input.suspended = true;

      // The encounter wakes on the PLAYER's distance to the site, not the
      // camera's, and its god-ray request is gated the same way. Park the body
      // at the site — buried, so it is never in shot — and the whole flock
      // stays awake and lit wherever the camera goes.
      const win = window as KiteWindow;
      const site = (window as unknown as { __sf?: { oceanKiteSite?: { x: number; z: number } } })
        .__sf?.oceanKiteSite ?? { x: -6164, z: 1650 };
      freezeAndBuryPlayer(ctx, site.x, site.z);

      const eye = new THREE.Vector3();
      const target = new THREE.Vector3();
      const kite = new THREE.Vector3();
      const runner = new THREE.Vector3();
      const flock = new THREE.Vector3();
      const sun = new THREE.Vector3(-0.9, 0.1, -0.3).normalize();
      const ground = (x: number, z: number) => map.groundTop(x, z);

      const readFlock = () => {
        const state = win.__sf?.oceanBeachKite?.debugState();
        if (!state || !state.flyers.length) return false;
        const subject = state.flyers[Math.min(framing.subject, state.flyers.length - 1)];
        kite.set(subject.kite[0], subject.kite[1], subject.kite[2]);
        runner.set(subject.runner[0], subject.runner[1], subject.runner[2]);
        flock.set(0, 0, 0);
        for (const flyer of state.flyers) flock.x += flyer.kite[0];
        for (const flyer of state.flyers) flock.y += flyer.kite[1];
        for (const flyer of state.flyers) flock.z += flyer.kite[2];
        flock.multiplyScalar(1 / state.flyers.length);
        return true;
      };
      armCinematic(ctx, {
        name,
        duration: KITE_FESTIVAL_SECONDS,
        shots: [
          {
            id: framing.id,
            start: 0,
            end: KITE_FESTIVAL_SECONDS,
            safety: { floorClearance: 1.1 },
            camera: (sample, out) => {
              // Read the live solar direction rather than assume an azimuth, so
              // every shot stays on the dark side of its subject at any hour.
              sun.copy(SUN_DIR);

              if (!readFlock()) {
                // Before the encounter resolves, hold a wide plate on the site
                // so frame zero is never a camera at the world origin.
                eye.set(site.x + 60, ground(site.x + 60, site.z) + 8, site.z);
                target.set(site.x, ground(site.x, site.z) + 18, site.z);
                setPose(out, eye, target, 40);
                return;
              }
              const focal = framing.frame(sample, { kite, runner, flock, sun, ground }, eye, target);
              setPose(out, eye, target, focal);
            }
          }
        ]
      });
    }
  };
}

export const kiteFestivalDemos: readonly Demo[] = FRAMINGS.map(buildDemo);
export const KITE_FESTIVAL_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  FRAMINGS.map((framing) => [`ocean-beach-kite-${framing.id}`, framing.title])
);
