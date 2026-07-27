import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { SUN_STATE } from "../../world/sky";
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
/**
 * Two rules hold these five together.
 *
 * Distance, because the sun sits a few degrees above the water while the kites
 * fly at thirty-plus metres: a camera parked close is looking steeply up at a
 * kite with the sun nowhere in frame, and this feature's light only exists
 * where kite and sun share one. Standing back and reaching for a longer lens
 * is what buys that.
 *
 * And a target between the two, because aiming at a kite puts the horizon off
 * the bottom of the frame and fills it with empty sky. Every shot below looks
 * at a point part-way down from its subject toward the water, so the beach, the
 * flyers and the sun stay in shot underneath the kites.
 */
const FRAMINGS: readonly Framing[] = [
  {
    id: "01",
    title: "Ocean Beach Kites · The Whole Beach",
    hour: 19.46,
    exposure: 0.94,
    subject: 0,
    // Establishing: a slow lateral drift across the line of flyers, far enough
    // back that all seven, the runners and the sun are in one frame.
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(150, 126, drift))
        .addScaledVector(along, mix(-38, 28, drift));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(5.5, 8.5, drift);
      target.copy(live.flock).addScaledVector(along, mix(-6, 9, drift));
      target.y = mix(base + 5, live.flock.y, 0.42);
      return mix(34, 42, drift);
    }
  },
  {
    id: "02",
    title: "Ocean Beach Kites · Two Sunwheels",
    hour: 19.66,
    exposure: 0.96,
    subject: 1,
    // The mirrored pair on a long lens, so the two rotors compress against the
    // sun and their opposite arcs read as one gesture.
    frame: ({ u }, live, eye, target) => {
      const push = smoothstep(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.kite)
        .addScaledVector(live.sun, -mix(88, 74, push))
        .addScaledVector(along, mix(22, 8, push));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(5, 8.5, push);
      target.copy(live.kite).addScaledVector(along, mix(-3, 2, push));
      // Anchored mostly to the waterline rather than to the kite. A tight lens
      // chasing a kite that swings twenty metres either way walks the horizon
      // straight out of frame; holding the sea in shot and letting the kite
      // move within it is the composition that survives the whole take.
      target.y = base + 7 + (live.kite.y - base) * 0.3;
      return mix(46, 58, push);
    }
  },
  {
    id: "03",
    title: "Ocean Beach Kites · The Centipede",
    hour: 19.9,
    exposure: 0.98,
    subject: 6,
    // The dragon strung across the sun on the longest lens of the five,
    // drifting just enough that its rings cross the disc one after another.
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.kite)
        .addScaledVector(live.sun, -mix(104, 88, drift))
        .addScaledVector(along, mix(-15, 11, drift));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(5.5, 10, drift);
      target.copy(live.kite);
      // Same horizon anchor as the sunwheels, but a touch higher: the dragon is
      // fifteen metres of kite and needs the room above the waterline.
      target.y = base + 9 + (live.kite.y - base) * 0.34;
      return mix(50, 62, drift);
    }
  },
  {
    id: "04",
    title: "Ocean Beach Kites · Running the Sand",
    hour: 20.14,
    exposure: 1.02,
    subject: 4,
    // The only shot that stays close, and it can afford to: at eye level up the
    // beach the sun is dead ahead, so the runners are silhouettes and their
    // kites climb out of frame rather than needing to fit in it.
    frame: ({ u }, live, eye, target) => {
      const swing = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.runner)
        .addScaledVector(live.sun, -mix(38, 27, swing))
        .addScaledVector(along, mix(15, -12, swing));
      eye.y = live.ground(eye.x, eye.z) + 1.7;
      target.copy(live.runner);
      target.y = mix(live.runner.y + 0.6, live.kite.y, mix(0.18, 0.34, swing));
      return mix(40, 50, swing);
    }
  },
  {
    id: "05",
    title: "Ocean Beach Kites · Blue Hour",
    hour: 20.78,
    exposure: 0.9,
    subject: 0,
    // Four degrees under. The sun is gone, the sky has turned, and the kites
    // are shapes rather than colours — the golden-hour air is most of the way
    // faded out by this hour, which is the point: this is what the beach looks
    // like after the show.
    frame: ({ u }, live, eye, target) => {
      const settle = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(96, 118, settle))
        .addScaledVector(along, mix(8, 26, settle));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(6.5, 11, settle);
      target.copy(live.flock).addScaledVector(along, mix(2, -5, settle));
      target.y = base + 8 + (live.flock.y - base) * 0.3;
      return mix(42, 52, settle);
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
              // SUN_STATE.toSun, not SUN_DIR: the latter hands over to the
              // anti-solar direction once the sun is down, which past sunset
              // would mirror every camera to the wrong side of the beach — the
              // blue-hour shot flew into the sea before this was caught.
              sun.copy(SUN_STATE.toSun);
              sun.y = Math.max(sun.y, 0.02);
              sun.normalize();

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
