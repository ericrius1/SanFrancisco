import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { SUN_STATE } from "../../world/sky";
import { OCEAN_KITE_TUNING } from "../../world/oceanBeachKite/tuning";
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
  /**
   * Per-shot weather. The encounter reads OCEAN_KITE_TUNING every frame, so a
   * look can thin the marine layer out or lean on the shafts without touching
   * anyone else's. This is what stops five clips of the same beach at the same
   * hour from being five of the same clip.
   */
  mist?: number;
  shafts?: number;
  /** Which flyer this shot is about; 0 is the diamond soloist. */
  subject: number;
  /**
   * The subject's troupe partner, if this shot is about the two of them. A
   * mirrored pair carves opposite arcs, so it diverges as hard as it converges
   * — framing on one of the two loses the other for half the take. `pair` is
   * the midpoint of both kites and is what such a shot should hold.
   */
  companion?: number;
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
      /** Midpoint of subject and companion; equals `kite` when there is none. */
      pair: THREE.Vector3;
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
    companion: 2,
    // The mirrored pair, framed on the point between them so both rotors stay
    // in shot through the whole divergence.
    frame: ({ u }, live, eye, target) => {
      const push = smoothstep(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.pair)
        .addScaledVector(live.sun, -mix(84, 70, push))
        .addScaledVector(along, mix(20, 7, push));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(5, 8.5, push);
      target.copy(live.pair).addScaledVector(along, mix(-3, 2, push));
      // Anchored mostly to the waterline rather than to the kites. A lens
      // chasing kites that swing twenty metres either way walks the horizon
      // straight out of frame; holding the sea in shot and letting them move
      // within it is the composition that survives a whole take.
      target.y = base + 7 + (live.pair.y - base) * 0.34;
      return mix(40, 48, push);
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
        .addScaledVector(live.sun, -mix(84, 70, drift))
        .addScaledVector(along, mix(-13, 10, drift));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(5.5, 9, drift);
      target.copy(live.kite);
      // Fifteen metres of kite at thirty-five metres up, and a sun on the
      // waterline: holding both wants about forty metres of vertical coverage,
      // which is a wide lens from close in rather than a long one from far out.
      // Closer also makes the dragon big enough to be the subject it is.
      target.y = base + 6 + (live.kite.y - base) * 0.44;
      return mix(40, 46, drift);
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

/**
 * Five more looks, deliberately unlike the first five. Where those all stood
 * back at eye level in heavy marine layer, these move the camera — an overhead
 * that exists to show the shadows, a crane that falls through the flock, an
 * orbit around a mirrored pair — and each one dials its own fog and shafts.
 */
const EXTRA_FRAMINGS: readonly Framing[] = [
  {
    id: "06",
    title: "Ocean Beach Kites · From Above",
    // Mid-afternoon on purpose. The whole point of this angle is the shadows,
    // and a sun on the water throws them a hundred metres out to sea; a sun
    // thirty degrees up lays them on the sand right beside their kites.
    hour: 16.55,
    exposure: 0.9,
    mist: 0.3,
    shafts: 0.45,
    subject: 0,
    // Looking down the whole beach from seventy metres, drifting sideways so
    // the kites and their shadows separate in parallax.
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, mix(26, -18, drift))
        .addScaledVector(along, mix(-34, 30, drift));
      eye.y = live.ground(eye.x, eye.z) + mix(74, 62, drift);
      target.copy(live.flock).addScaledVector(along, mix(-10, 8, drift));
      target.y = live.ground(target.x, target.z) + 6;
      return mix(34, 40, drift);
    }
  },
  {
    id: "07",
    title: "Ocean Beach Kites · Full Rays",
    hour: 19.72,
    exposure: 0.92,
    // Thick air and the shafts pushed hard: the one clip that is about the
    // light itself rather than about any particular kite.
    mist: 1.25,
    shafts: 1.7,
    subject: 6,
    // Down on the sand, tracking sideways so kite after kite crosses the sun.
    frame: ({ u }, live, eye, target) => {
      const track = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(96, 88, track))
        .addScaledVector(along, mix(-44, 40, track));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.75;
      target.copy(live.flock).addScaledVector(along, mix(-14, 12, track));
      target.y = base + 9 + (live.flock.y - base) * 0.36;
      return mix(50, 44, track);
    }
  },
  {
    id: "08",
    title: "Ocean Beach Kites · Clear Dusk",
    hour: 20.52,
    exposure: 0.86,
    // Almost no fog. After the earlier looks buried everything in marine layer,
    // this one wants hard clean silhouettes on a bare gradient.
    mist: 0.18,
    shafts: 0.35,
    subject: 3,
    // A slow push in on the lantern, the only move in the shot.
    frame: ({ u }, live, eye, target) => {
      const push = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.kite)
        .addScaledVector(live.sun, -mix(96, 62, push))
        .addScaledVector(along, mix(16, 11, push));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(7, 5.5, push);
      target.copy(live.kite);
      target.y = base + 7 + (live.kite.y - base) * 0.4;
      return mix(44, 58, push);
    }
  },
  {
    id: "09",
    title: "Ocean Beach Kites · The Descent",
    hour: 19.58,
    exposure: 0.94,
    mist: 0.65,
    shafts: 1.15,
    subject: 6,
    // A crane fall: sixty metres down to head height over the ten seconds,
    // arriving under the centipede as it comes through its window.
    frame: ({ u }, live, eye, target) => {
      const fall = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.kite)
        .addScaledVector(live.sun, -mix(64, 92, fall))
        .addScaledVector(along, mix(30, 4, fall));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(62, 4.5, fall);
      target.copy(live.kite);
      // The look-at falls with the eye, so the horizon rises into frame instead
      // of the kite sliding out of the top.
      target.y = mix(live.kite.y, base + 8 + (live.kite.y - base) * 0.36, fall);
      return mix(38, 50, fall);
    }
  },
  {
    id: "10",
    title: "Ocean Beach Kites · Around the Pair",
    hour: 19.98,
    exposure: 0.96,
    mist: 0.5,
    shafts: 1.35,
    subject: 1,
    companion: 2,
    // A quarter orbit around the mirrored sunwheels, so their crossing arcs
    // sweep across the sun rather than sitting beside it.
    frame: ({ u }, live, eye, target) => {
      const swing = easeInOutCubic(u);
      // Rotate the stand-off direction around the pair instead of sliding it.
      const angle = mix(-0.62, 0.5, swing);
      const away = new THREE.Vector3(
        -live.sun.x * Math.cos(angle) + live.sun.z * Math.sin(angle),
        0,
        -live.sun.z * Math.cos(angle) - live.sun.x * Math.sin(angle)
      ).normalize();
      eye.copy(live.pair).addScaledVector(away, mix(86, 74, swing));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(6, 12, swing);
      target.copy(live.pair);
      target.y = base + 8 + (live.pair.y - base) * 0.32;
      return mix(44, 52, swing);
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
      if (framing.mist !== undefined) OCEAN_KITE_TUNING.values.mistDensity = framing.mist;
      if (framing.shafts !== undefined) OCEAN_KITE_TUNING.values.shaftStrength = framing.shafts;
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
      const pair = new THREE.Vector3();
      const sun = new THREE.Vector3(-0.9, 0.1, -0.3).normalize();
      const ground = (x: number, z: number) => map.groundTop(x, z);

      const readFlock = () => {
        const state = win.__sf?.oceanBeachKite?.debugState();
        if (!state || !state.flyers.length) return false;
        const subject = state.flyers[Math.min(framing.subject, state.flyers.length - 1)];
        kite.set(subject.kite[0], subject.kite[1], subject.kite[2]);
        runner.set(subject.runner[0], subject.runner[1], subject.runner[2]);
        pair.copy(kite);
        if (framing.companion !== undefined) {
          const partner = state.flyers[framing.companion];
          if (partner) {
            pair.x = (kite.x + partner.kite[0]) * 0.5;
            pair.y = (kite.y + partner.kite[1]) * 0.5;
            pair.z = (kite.z + partner.kite[2]) * 0.5;
          }
        }
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
              const focal = framing.frame(sample, { kite, runner, pair, flock, sun, ground }, eye, target);
              setPose(out, eye, target, focal);
            }
          }
        ]
      });
    }
  };
}

export const kiteFestivalDemos: readonly Demo[] = [...FRAMINGS, ...EXTRA_FRAMINGS].map(buildDemo);
export const KITE_FESTIVAL_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  [...FRAMINGS, ...EXTRA_FRAMINGS].map((framing) => [`ocean-beach-kite-${framing.id}`, framing.title])
);
