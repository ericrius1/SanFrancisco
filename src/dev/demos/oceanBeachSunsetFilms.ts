import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { SUN_STATE } from "../../world/sky";
import { OCEAN_KITE_TUNING } from "../../world/oceanBeachKite/tuning";
import { oceanBeachApproxShoreX, oceanBeachBreakX } from "../../world/oceanBeachWaves";
import type { OceanBeachKiteEncounter } from "../../world/oceanBeachKite";
import type { Demo } from "../demo";
import { cleanPlate, freezeAndBuryPlayer } from "./shared";

/**
 * Five twenty-second films of the deep-sunset festival, built around three
 * things at once: the prism kite as the hero of a flock gathered loosely
 * around it, its spectrum lying soft on the sand, and the surf actually
 * breaking on camera — seen AND heard.
 *
 * These are the first productions with a PINNED sea clock. The live sea rides
 * `ctx.state.elapsed`, which carries boot wall-clock, so every capture run
 * lands on a different wave phase and no film could promise a crash at a
 * chosen second. Each film here writes `t0 + shotTime` through
 * `ctx.setSeaTimePin` every frame, which makes the whole surf stack — water
 * displacement, shorebreak sheet, spray, wave audio — phase-deterministic per
 * production. The t0 values are not arbitrary: tools/cinematic/surfSchedule.mjs
 * searched them so a set goes off early in the take and a bigger one goes off
 * late, in the stretch of beach each camera actually frames. The soundtrack
 * places its crash stems at those same seconds, so for the first time the
 * films' sound and picture agree about the sea.
 *
 * The set's beat structure, per the solver (schedules in each film below):
 * a set breaks along ~200 m of beach inside two or three seconds, then a
 * ~12.5 s lull, then the next set — and a set's swash arrives at the sand
 * about thirteen seconds after it broke, which lets film 02 time a swash
 * sheet to arrive exactly as its second set throws.
 */

export const SUNSET_FILM_SECONDS = 20;

/** Encounter frames run before the shot arms — see the surf films' preroll. */
const PREROLL_FRAMES = 600;

/**
 * Gathered films need a longer preroll: setLaneGather retargets the lane
 * centers and the runners WALK there (up to ~100 m at ~4.8 m/s), so thirty
 * simulated seconds puts every flyer on station before frame zero.
 */
const GATHER_PREROLL_FRAMES = 1800;

/** Metres the lens is kept INLAND of the most inland hand. See surf films. */
const HAND_MARGIN = 18;

type Live = {
  kite: THREE.Vector3;
  runner: THREE.Vector3;
  flock: THREE.Vector3;
  sun: THREE.Vector3;
  ground: (x: number, z: number) => number;
  breakX: (z: number) => number;
  shoreX: (z: number) => number;
  inlandHandX: number;
};

type Film = {
  id: string;
  title: string;
  hour: number;
  exposure: number;
  mist: number;
  shafts: number;
  subject: number;
  /**
   * Sea-clock pin. Shot time S renders the analytic wave train at t0 + S,
   * every run, exactly. Chosen by tools/cinematic/surfSchedule.mjs against
   * the sections this film frames.
   */
  t0: number;
  /**
   * How far the flock walks in from its default 179 m line toward a loose
   * court around the prism (0 = the everyday line, 1 = gathered). Applied
   * before the preroll, so the runners cover the distance before frame zero.
   */
  gather: number;
  frame(
    sample: { u: number; localTime: number },
    live: Live,
    eye: THREE.Vector3,
    target: THREE.Vector3
  ): number;
  /** Streaming-focus override; defaults to water abreast of the subject. */
  focus?(sample: { u: number }, live: Live, out: THREE.Vector3): void;
};

const FILMS: readonly Film[] = [
  {
    id: "01",
    title: "Ocean Beach Sunset · The Court",
    // 20.18: nine minutes before sunset, golden air at full strength — the
    // prism needs a disc worth dispersing, and the gathered flock needs its
    // warm shafts to read as a court rather than a row of silhouettes.
    hour: 20.18,
    exposure: 0.93,
    // Enough marine layer for the shafts and the fan to hang in, not enough
    // to grey out the set that closes the film.
    mist: 0.68,
    shafts: 1.7,
    subject: 7,
    // Schedule at t0=620.3: one straggler mid-throw as the fade completes
    // (1.5 s, z1800), a long lull that belongs to the rainbow, then the whole
    // framed beach goes off at 17.0–19.4 s (6.7–6.8 m at z1680–1800) as the
    // climax. Swash from the straggler crosses the sand at ~14 s.
    t0: 620.3,
    gather: 1,
    /**
     * The hero shot. A low crane behind the court's open side, pushing in and
     * descending toward the prism runner: the spectrum lies on the sand in
     * the lower third between the lens and the sail, the gathered kites frame
     * the prism from both sides in depth, and the climax set breaks across
     * the whole background. Aim rides between the smear and the sail so both
     * stay in frame the entire take.
     */
    frame: ({ u }, live, eye, target) => {
      const push = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      const anchor = live.runner;
      eye.copy(anchor)
        .addScaledVector(live.sun, -mix(98, 74, push))
        .addScaledVector(along, mix(-14, 6, push));
      const base = live.ground(eye.x, eye.z);
      // 6.8 m down to 4.6: high enough to see the sand the spectrum lies on,
      // descending so the rainbow rises through the frame as the set arrives.
      eye.y = base + mix(6.8, 4.6, push);
      target.copy(anchor).addScaledVector(along, mix(2, 6, push));
      // From the smear (sand + 6) up toward the sail as the crane drops —
      // the kites walk down into frame while the rainbow grows.
      target.y = base + mix(6, 10.5, push);
      return mix(42, 52, push);
    },
    focus: (_sample, live, out) => {
      const z = live.runner.z - 10;
      out.set(live.shoreX(z) - 70, 0, z);
    }
  },
  {
    id: "02",
    title: "Ocean Beach Sunset · Where It Dances",
    // 20.30: the disc touching the water. Full golden air — this film IS the
    // spectrum on the sand, and the smear needs the beam at full strength.
    hour: 20.30,
    exposure: 0.97,
    mist: 0.6,
    shafts: 1.9,
    subject: 7,
    // Schedule at t0=183.05: a set sweeps the framed beach at 4.1–5.7 s
    // (5.0–5.3 m), its swash sheet arrives at 16.9–18.5 s EXACTLY as the
    // bigger second set throws at 17.5–19.9 s (6.5 m). The near field gets
    // wet sand while the background goes off.
    t0: 183.05,
    gather: 0.65,
    /**
     * Head height on the sand, tracking north along the beach past the smear.
     * The rainbow owns the lower half of the frame in the near field —
     * dancing on the sand a dozen metres inland of the prism's runner — with
     * the sail above it, the surf behind it, and the waterline held in the
     * middle third. The track is what makes the light move: sixty metres of
     * lateral travel walks the smear's bands across the lens while the
     * kite's bank swings the whole spectrum along the sand.
     */
    frame: ({ u }, live, eye, target) => {
      const track = smoothstep(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      const anchor = live.runner;
      eye.copy(anchor)
        .addScaledVector(live.sun, -18)
        .addScaledVector(along, mix(-34, 26, track));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.7;
      // Aim at the sand the light lies on — just inland of the runner, where
      // the beam lands — not at the kite. The sail crosses the top of frame
      // on its own as the track brings it round.
      target.copy(anchor).addScaledVector(live.sun, -4).addScaledVector(along, mix(2, 6, track));
      target.y = base + mix(2.4, 3.2, track);
      return 30;
    },
    focus: ({ u }, live, out) => {
      const z = live.runner.z - mix(15, 45, smoothstep(u));
      out.set(live.shoreX(z) - 70, 0, z);
    }
  },
  {
    id: "03",
    title: "Ocean Beach Sunset · The Set Goes Off",
    // 20.26: six minutes of disc left, shafts at full. The surf film of the
    // five — it opens INSIDE the break at wave height.
    hour: 20.26,
    exposure: 0.95,
    mist: 0.55,
    shafts: 1.85,
    subject: 7,
    // Schedule at t0=187.15: crests throw at 0.9–2.6 s right in front of the
    // opening camera (the fade completes into a wave mid-throw), then the big
    // set at 13.4–16.0 s (6.6–6.8 m) breaks across the whole frame while the
    // crane is at height. Swash from the opener crosses at ~13–15 s.
    t0: 187.15,
    gather: 0.5,
    /**
     * The crane, rebuilt from surf-01 with the break as the anchor: opens at
     * wave height so the first set reads as a WALL, rises to eleven metres
     * and pulls back as the big set goes off, ending with the gathered
     * festival strung above the whitewater. Anchored to the break line, not
     * the flock — the film is about the wave.
     */
    frame: ({ u }, live, eye, target) => {
      const rise = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      const z = live.runner.z - 30;
      const hold = new THREE.Vector3(mix(live.breakX(z), live.shoreX(z), 0.3), 0, z);
      eye.copy(hold)
        .addScaledVector(live.sun, -mix(70, 130, rise))
        .addScaledVector(along, mix(-10, 18, rise));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(1.5, 11, rise);
      target.copy(hold).addScaledVector(along, mix(-4, 10, rise));
      // Water first, festival later: the aim walks up from the face of the
      // break to a point under the gathered flock.
      target.y = base + mix(2.4, 8.5, rise) + (live.flock.y - base) * mix(0.05, 0.3, rise);
      return mix(34, 29, rise);
    }
  },
  {
    id: "04",
    title: "Ocean Beach Sunset · The Long Band",
    // 20.62: two-thirds of the golden air left, the band at its hottest. The
    // thin mist is the telephoto rule — air is fog at this range.
    hour: 20.62,
    exposure: 0.88,
    mist: 0.14,
    shafts: 0.8,
    subject: 7,
    // Schedule at t0=185.9: stacked action for a compressed frame — crests at
    // 1.2–3.6 s across z1560–1800, then the second set walking through the
    // whole field at 13.4–17.7 s (6.4–6.8 m). There is something breaking in
    // frame for more than half the film, which is what a 70 mm frame full of
    // sea needs.
    t0: 185.9,
    gather: 0.35,
    /**
     * dusk-04's validated compression grammar, twenty seconds long: the lens
     * stays 62–74 mm, the eye keeps the measured 100 m throw, and the aim
     * rides an eighth of live flock height so gusts move frame and kites
     * together. The gathered-but-still-line flock stacks against the
     * breakers and the band.
     */
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(112, 104, drift))
        .addScaledVector(along, mix(-16, 14, drift));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 2.8;
      target.copy(live.flock).addScaledVector(along, mix(-4, 3, drift));
      target.y = base + mix(11.6, 12.2, drift) + (live.flock.y - base) * 0.14;
      return mix(66, 72, drift);
    }
  },
  {
    id: "05",
    title: "Ocean Beach Sunset · Afterglow",
    // 20.88: past the sun, a fifth of the golden air left — enough for a
    // whisper of spectrum on the sand while the sky does the work. The set
    // that closes the film is mostly SOUND: a roar off the south edge of
    // frame with the twilight foam catching what light the band still throws.
    hour: 20.88,
    exposure: 1.05,
    mist: 0.4,
    shafts: 0.35,
    subject: 7,
    // Schedule at t0=622.35: a lull for the first fourteen seconds — this is
    // the contemplative one — then one huge set at 15.0–17.4 s (6.8 m at
    // z1650–1760).
    t0: 622.35,
    gather: 0.8,
    /**
     * The finale, in dusk-05's up-look grammar: a quarter-arc under the
     * gathered flock with the prism nearest the lens, aimed well under the
     * kites so the silhouettes ride the band and the last cold light stays
     * pinned along the bottom edge. The lens widens as the arc goes — the
     * film's last seconds hold the whole court overhead.
     */
    frame: ({ u }, live, eye, target) => {
      const arc = easeInOutCubic(u);
      const away = new THREE.Vector3().copy(live.sun).multiplyScalar(-1);
      const spin = mix(-0.32, 0.28, arc);
      const cos = Math.cos(spin);
      const sin = Math.sin(spin);
      const ax = away.x * cos - away.z * sin;
      const az = away.x * sin + away.z * cos;
      away.set(ax, 0, az).normalize();
      // Centered between the flock mean and the prism, biased to the prism:
      // the arc keeps the hero nearest the lens the whole way round.
      const center = new THREE.Vector3().copy(live.flock).lerp(live.kite, 0.55);
      eye.copy(center).addScaledVector(away, mix(50, 43, arc));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.6;
      target.copy(center);
      target.y = base + mix(18.5, 16.5, arc);
      return mix(30, 26, arc);
    }
  }
];

type KiteWindow = Window &
  typeof globalThis & {
    __sf?: {
      oceanBeachKite?: OceanBeachKiteEncounter;
      ensureOceanBeachKite?: () => Promise<void>;
      oceanKiteSite?: { x: number; z: number };
      materialize?: { reveal?: () => void };
    };
  };

function buildFilm(film: Film): Demo {
  const name = `ocean-beach-sunset-${film.id}`;
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
      sky.setTimeOfDay(film.hour);
      ctx.setExposure(film.exposure);
      // Same capture rules as every kite production: MSAA and contact shadows
      // both bind scene depth in ways WebGPU rejects mid-capture.
      ctx.setPostFx({ sceneSamples: 0, contactShadows: false, ink: false, dream: false, retro: false });
      OCEAN_KITE_TUNING.values.mistDensity = film.mist;
      OCEAN_KITE_TUNING.values.shaftStrength = film.shafts;
      ctx.input.suspended = true;

      const win = window as KiteWindow;
      const site = win.__sf?.oceanKiteSite ?? { x: -6148, z: 1650 };
      win.__sf?.materialize?.reveal?.();
      freezeAndBuryPlayer(ctx, site.x, site.z);
      ctx.player.renderPosition.set(site.x, map.groundTop(site.x, site.z), site.z);

      const eye = new THREE.Vector3();
      const target = new THREE.Vector3();
      const focus = new THREE.Vector3();
      const kite = new THREE.Vector3();
      const runner = new THREE.Vector3();
      const flock = new THREE.Vector3();
      const sun = new THREE.Vector3(-0.9, 0.1, -0.3).normalize();
      const ground = (x: number, z: number) => Math.max(map.groundTop(x, z), 0);
      const shoreX = (z: number) => oceanBeachApproxShoreX(z);
      // The pinned sea clock. Everything in the Live bundle that asks about
      // the sea must ask at the SAME time the water is displaced with.
      let clock = film.t0;
      const breakX = (z: number) => oceanBeachBreakX(z, clock);

      let inlandHandX = site.x;

      const readFlock = () => {
        const state = win.__sf?.oceanBeachKite?.debugState();
        if (!state || !state.flyers.length) {
          const groundY = ground(site.x, site.z);
          runner.set(site.x, groundY, site.z);
          kite.set(site.x - 40, groundY + 30, site.z);
          flock.copy(kite);
          inlandHandX = site.x;
          return true;
        }
        inlandHandX = -Infinity;
        for (const flyer of state.flyers) {
          inlandHandX = Math.max(inlandHandX, flyer.runner[0]);
        }
        const subject = state.flyers[Math.min(film.subject, state.flyers.length - 1)];
        kite.set(subject.kite[0], subject.kite[1], subject.kite[2]);
        runner.set(subject.runner[0], subject.runner[1], subject.runner[2]);
        flock.set(0, 0, 0);
        for (const flyer of state.flyers) {
          flock.x += flyer.kite[0];
          flock.y += flyer.kite[1];
          flock.z += flyer.kite[2];
        }
        flock.multiplyScalar(1 / state.flyers.length);
        return true;
      };

      const arm = () => armCinematic(ctx, {
        name,
        duration: SUNSET_FILM_SECONDS,
        // 1.7 s fade covers the zero-dt settle (ocean cascades resolve by
        // ~2 s); see the surf films for the measurement.
        frame: (time) => {
          // Pin the sea before anything samples it this frame: the cine hook
          // runs earlier in the tick than the water/shorebreak/spray/audio
          // updates, so the whole surf stack renders t0 + shot time.
          ctx.setSeaTimePin?.(film.t0 + time);
          clock = film.t0 + time;
          const up = Math.min(1, Math.max(0, time / 1.7));
          const down = Math.min(1, Math.max(0, (SUNSET_FILM_SECONDS - time) / 0.5));
          const ramp = up * up * (3 - 2 * up) * (down * down * (3 - 2 * down));
          ctx.setExposure(film.exposure * ramp);
        },
        shots: [
          {
            id: film.id,
            start: 0,
            end: SUNSET_FILM_SECONDS,
            safety: { floorClearance: 1.1 },
            camera: (sample, out) => {
              sun.copy(SUN_STATE.toSun);
              sun.y = Math.max(sun.y, 0.02);
              sun.normalize();
              readFlock();
              const live: Live = {
                kite,
                runner,
                flock,
                sun,
                ground,
                breakX,
                shoreX,
                inlandHandX
              };
              const focal = film.frame(sample, live, eye, target);
              eye.x = Math.max(eye.x, inlandHandX + HAND_MARGIN);
              setPose(out, eye, target, focal);

              // Steer the world's streaming focus onto the water the lens is
              // actually on — the displaced near patch follows renderPosition,
              // and beyond it the sea is a mirror (see the surf films).
              if (film.focus) film.focus(sample, live, focus);
              else focus.set(shoreX(runner.z) - 70, 0, runner.z);
              ctx.player.renderPosition.set(focus.x, map.groundTop(focus.x, focus.z), focus.z);
            }
          }
        ]
      });

      const preroll = () => {
        const encounter = win.__sf?.oceanBeachKite;
        if (encounter) {
          // Gather the flock into its loose court around the prism BEFORE the
          // preroll, so the runners walk the distance during these ten
          // simulated seconds and the formation is settled by frame zero.
          encounter.setLaneGather?.(film.gather);
          const frames = film.gather > 0 ? GATHER_PREROLL_FRAMES : PREROLL_FRAMES;
          const view = new THREE.Vector3(site.x + 60, map.groundTop(site.x, site.z) + 8, site.z);
          for (let i = 0; i < frames; i++) {
            encounter.update(1 / 60, i / 60, site, 0.5, view);
          }
        }
        arm();
      };

      const flockReady = win.__sf?.ensureOceanBeachKite?.();
      if (flockReady) void flockReady.then(preroll).catch(arm);
      else preroll();
    }
  };
}

export const oceanBeachSunsetFilms: readonly Demo[] = FILMS.map(buildFilm);
export const SUNSET_FILM_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  FILMS.map((film) => [`ocean-beach-sunset-${film.id}`, film.title])
);
