import * as THREE from "three/webgpu";
import { armCinematic, easeInOutCubic, mix, setPose, smoothstep } from "../../cinematic";
import { SUN_STATE } from "../../world/sky";
import { OCEAN_KITE_TUNING } from "../../world/oceanBeachKite/tuning";
import { oceanBeachApproxShoreX, oceanBeachBreakX } from "../../world/oceanBeachWaves";
import type { OceanBeachKiteEncounter } from "../../world/oceanBeachKite";
import type { Demo } from "../demo";
import { cleanPlate, freezeAndBuryPlayer } from "./shared";

/**
 * Two twenty-second films of the kite festival with the surf as the second
 * subject, both shot in the last half hour of light.
 *
 * The kite productions that came before these are ten-second looks framed on
 * the sky: the camera stands back on a long lens so a kite and a low sun share
 * a frame, and the sea is a pale strip along the bottom edge. These are built
 * the other way round. The composition is fixed by the light — to see the sun
 * come THROUGH the cloth you have to stand on the anti-sun side and look west,
 * which on a west-facing beach puts the breaking surf exactly between the
 * flyers and the sun — so both films aim to have a wave going off in the
 * middle of the frame with the kites strung above it.
 *
 * Two shots, two ideas about the same evening:
 *
 *   surf-01  the crane. Opens at wave height on the wet sand with a set
 *            breaking across the whole frame, then rises twenty seconds to
 *            fifteen metres and widens, until the beach, the line of flyers
 *            and three more sets stacked out to the horizon are all in shot.
 *            The disc is on the water for the whole take.
 *
 *   surf-02  the waterline. Never leaves head height, tracks laterally along
 *            the beach on a tighter lens so flyer after flyer walks across the
 *            sun, with the shorebreak running under the whole thing. Eleven
 *            minutes later, thinner air, harder silhouettes.
 *
 * Both track live kite positions rather than keyframed points — the flock is
 * wherever its wind window has carried it by that frame, and determinism comes
 * from the capture harness replaying from frame zero at a fixed step.
 */

export const SURF_FILM_SECONDS = 20;

/** Encounter frames run before the shot arms — see `preroll` below. */
const PREROLL_FRAMES = 600;

type Live = {
  kite: THREE.Vector3;
  runner: THREE.Vector3;
  flock: THREE.Vector3;
  sun: THREE.Vector3;
  ground: (x: number, z: number) => number;
  /** World X of the break line at this Z, right now — see oceanBeachBreakX. */
  breakX: (z: number) => number;
  /** World X of the waterline at this Z. */
  shoreX: (z: number) => number;
};

type Film = {
  id: string;
  title: string;
  hour: number;
  exposure: number;
  mist: number;
  shafts: number;
  subject: number;
  frame(
    sample: { u: number; localTime: number },
    live: Live,
    eye: THREE.Vector3,
    target: THREE.Vector3
  ): number;
  /**
   * Where the world's streaming focus should sit this frame — see the note on
   * `steerFocus` below. Defaults to a point offshore of the flock.
   */
  focus?(sample: { u: number }, live: Live, out: THREE.Vector3): void;
};

const FILMS: readonly Film[] = [
  {
    id: "01",
    title: "Ocean Beach Surf · The Set",
    // 20.28: four minutes before the disc touches the water, and it stays on
    // it for the whole twenty seconds. Golden-hour air is still at full
    // strength here (it does not begin to fade until 20.55), so the shafts are
    // as strong as they get while the sun is still a disc to throw them.
    hour: 20.28,
    exposure: 0.95,
    // Enough marine layer to carry shafts, not enough to grey the surf out.
    // At 0.9 the sea a hundred and fifty metres out was the same value as the
    // sky above it and a breaking wave had nothing to be legible against.
    mist: 0.55,
    shafts: 1.85,
    subject: 0,
    frame: ({ u }, live, eye, target) => {
      const rise = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      // Anchored to the BREAK, not the flock. This film is about a wave going
      // off, and the break line wanders up to fifty metres either way along
      // the beach — a camera stood off the kites frames whatever water happens
      // to be under them, which for half the takes was the flat inside.
      const z = live.flock.z;
      const hold = new THREE.Vector3(mix(live.breakX(z), live.shoreX(z), 0.35), 0, z);
      eye.copy(hold)
        .addScaledVector(live.sun, -mix(96, 150, rise))
        .addScaledVector(along, mix(-16, 26, rise));
      const base = live.ground(eye.x, eye.z);
      // 1.4 m to 15 m. Starting at wave height is the point: for the first few
      // seconds the lens is BELOW the crest of anything that stands up out
      // there, so a set reads as a wall rather than as a line on a plan view.
      eye.y = base + mix(1.4, 15, rise);
      target.copy(hold).addScaledVector(along, mix(-4, 12, rise));
      // The aim walks up with the crane, from the water itself to a point
      // under the flock — so the film opens on surf and ends on the festival
      // without either ever leaving the frame entirely.
      target.y = base + mix(2.6, 9.5, rise) + (live.flock.y - base) * mix(0.06, 0.3, rise);
      return mix(38, 30, rise);
    }
  },
  {
    id: "02",
    title: "Ocean Beach Surf · The Waterline",
    // 20.46: eight minutes past sunset. No disc left, but the sky is at its
    // hottest and the golden-hour air still holds, so the shafts survive while
    // everything on the sand has gone to silhouette.
    hour: 20.46,
    exposure: 1.0,
    // Thinner than the crane's: this one wants a legible lip on the wave and
    // hard edges on the flyers, and heavy marine layer eats both first.
    mist: 0.5,
    shafts: 1.7,
    subject: 4,
    // Same axis as the crane — anti-sun side, looking west — because that is
    // the ONLY axis on which sun, kites and surf share a frame here, and
    // several attempts to find another proved it. Kites fly over the sand and
    // the break is a hundred-odd metres offshore, so any camera that holds
    // both is standing well inland of the flyers looking seaward; shooting up
    // the beach instead loses the kites off one edge and the sun off the
    // other, and the north end of the strip runs out of surf inside 400 m.
    //
    // Everything else about it is the opposite of the crane. It never leaves
    // head height, it tracks sideways instead of rising, it is on a wide lens
    // instead of a normal one, and it is eleven minutes later into a thinner
    // sky. A crane makes a beach look big; this makes it look like somewhere
    // you are standing.
    frame: ({ u }, live, eye, target) => {
      const track = smoothstep(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      const z = live.flock.z;
      const hold = new THREE.Vector3(mix(live.breakX(z), live.shoreX(z), 0.5), 0, z);
      eye.copy(hold)
        // Closes forty metres on the water as it tracks. The near sand is the
        // one thing a standing-height beach shot cannot get rid of, and every
        // metre closer to the waterline is a metre less of it.
        .addScaledVector(live.sun, -mix(168, 128, track))
        // Eighty metres of beach over twenty seconds: enough that flyer after
        // flyer walks through the sun rather than one being parked in it.
        .addScaledVector(along, mix(-46, 36, track));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(1.6, 2.7, track);
      target.copy(hold).addScaledVector(along, mix(-15, 13, track));
      // Aimed well above the horizon, which is what keeps the eighty metres of
      // dark sand between the lens and the water down in the bottom third
      // instead of owning half the frame — the cost of shooting a beach from
      // standing height. It also lifts the kites off the top edge.
      target.y = base + mix(12, 13.5, track);
      return mix(28, 25, track);
    }
  },
  {
    id: "03",
    title: "Ocean Beach Surf · The Gulls",
    // The waterline again, four minutes earlier — the disc is still on the
    // water, so this one has a sun in it where the later cut has only a glow.
    hour: 20.31,
    exposure: 0.97,
    // A touch thicker than 02. This is the shaft-heavy one of the pair, and
    // the birds read better against a slightly softer sky than against a hard
    // gradient.
    mist: 0.68,
    shafts: 1.9,
    subject: 1,
    // Same grammar as 02 and deliberately so, but not the same shot: it tracks
    // the other way down the beach, pulls BACK rather than closing in, and
    // sits a little lower and wider. Where 02 walks toward the water as the
    // light goes, this one lets the beach open out around the flyers with the
    // gulls working the air over the break.
    frame: ({ u }, live, eye, target) => {
      const track = smoothstep(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      const z = live.flock.z;
      const hold = new THREE.Vector3(mix(live.breakX(z), live.shoreX(z), 0.46), 0, z);
      eye.copy(hold)
        .addScaledVector(live.sun, -mix(132, 176, track))
        .addScaledVector(along, mix(42, -40, track));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(2.4, 1.5, track);
      target.copy(hold).addScaledVector(along, mix(14, -12, track));
      target.y = base + mix(13, 11.5, track);
      return mix(26, 29, track);
    }
  }
];

type KiteWindow = Window &
  typeof globalThis & {
    __sf?: {
      oceanBeachKite?: OceanBeachKiteEncounter;
      ensureOceanBeachKite?: () => Promise<void>;
      oceanKiteSite?: { x: number; z: number };
    };
  };

function buildFilm(film: Film): Demo {
  const name = `ocean-beach-surf-${film.id}`;
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
      // Same capture settings as the kite productions, and for the same
      // reasons: several passes in this scene SAMPLE scene depth, and a
      // multisampled depth attachment is not bindable as a texture in WebGPU,
      // so leaving MSAA on records twenty seconds of cleared canvas. Contact
      // shadows go for the matching reason (its quad samples the beauty pass's
      // own depth) and contribute nothing at these ranges anyway.
      ctx.setPostFx({ sceneSamples: 0, contactShadows: false, ink: false, dream: false, retro: false });
      OCEAN_KITE_TUNING.values.mistDensity = film.mist;
      OCEAN_KITE_TUNING.values.shaftStrength = film.shafts;
      ctx.input.suspended = true;

      const win = window as KiteWindow;
      const site = win.__sf?.oceanKiteSite ?? { x: -6148, z: 1650 };
      freezeAndBuryPlayer(ctx, site.x, site.z);
      // Burying drops renderPosition 300 m under the sand, and that vector is
      // what the hero shadow cascade centres its box on — left alone, nothing
      // on this beach casts a shadow in any frame. Put the reported position
      // back on the sand; the mesh stays buried because syncMesh is already
      // a no-op by this point.
      ctx.player.renderPosition.set(site.x, map.groundTop(site.x, site.z), site.z);

      const eye = new THREE.Vector3();
      const target = new THREE.Vector3();
      const focus = new THREE.Vector3();
      const kite = new THREE.Vector3();
      const runner = new THREE.Vector3();
      const flock = new THREE.Vector3();
      const sun = new THREE.Vector3(-0.9, 0.1, -0.3).normalize();
      // Floored at sea level on purpose. Both films place the lens by height
      // above the ground under it, and both reach out over the water — where
      // `groundTop` is the SEABED, ten metres down. Un-floored, "1.4 m above
      // the ground" put the camera under the surf.
      const ground = (x: number, z: number) => Math.max(map.groundTop(x, z), 0);
      const shoreX = (z: number) => oceanBeachApproxShoreX(z);
      let clock = 0;
      const breakX = (z: number) => oceanBeachBreakX(z, clock);

      const readFlock = () => {
        const state = win.__sf?.oceanBeachKite?.debugState();
        if (!state || !state.flyers.length) {
          // The encounter resolves a little way into the replay, and the first
          // frames are still real frames of the film. Stand in a plausible
          // flock at the site so those frames get the shot's OWN framing —
          // right place, right lens, right horizon — instead of a fixed plate
          // that put the lens on the seabed and the sun off the edge.
          const groundY = ground(site.x, site.z);
          runner.set(site.x, groundY, site.z);
          kite.set(site.x - 40, groundY + 30, site.z);
          flock.copy(kite);
          return true;
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
        duration: SURF_FILM_SECONDS,
        shots: [
          {
            id: film.id,
            start: 0,
            end: SURF_FILM_SECONDS,
            safety: { floorClearance: 1.1 },
            camera: (sample, out) => {
              // SUN_STATE.toSun, not SUN_DIR: the latter hands over to the
              // anti-solar direction once the sun is down, and both of these
              // films are shot after or within minutes of sunset — reading
              // SUN_DIR would mirror the camera to the wrong side of the beach
              // and fly it into the sea.
              sun.copy(SUN_STATE.toSun);
              sun.y = Math.max(sun.y, 0.02);
              sun.normalize();
              clock = sample.localTime;
              readFlock();
              const live = { kite, runner, flock, sun, ground, breakX, shoreX };
              const focal = film.frame(sample, live, eye, target);
              setPose(out, eye, target, focal);

              // Steer the world's streaming focus, every frame.
              //
              // The authored swell only exists on the DISPLACED near water
              // patch, which is a ~210 m disc centred on the player — beyond
              // it the flat far sheet takes over and emits no surf channels at
              // all. A cinematic parks the player at the site and flies the
              // camera somewhere else, so a shot that looks at water two
              // hundred metres from the site is looking at a mirror: this is
              // exactly why the first cut of the waterline film had a
              // dead-calm sea in every frame while the crane, aimed at water
              // right in front of the site, had a set breaking in all of them.
              // The focus also carries the shorebreak sheet and the spray
              // field, so pointing it at the water the lens is actually on
              // brings all three.
              if (film.focus) film.focus(sample, live, focus);
              else focus.set(shoreX(flock.z) - 70, 0, flock.z);
              ctx.player.renderPosition.set(focus.x, map.groundTop(focus.x, focus.z), focus.z);
            }
          }
        ]
      });

      // Load the flock BEFORE arming, and let the harness wait on it.
      //
      // The encounter normally wakes off a per-frame proximity test, which is
      // right for a player walking up the beach and wrong for a capture: a
      // manual replay steps frames as fast as the GPU will take them, so
      // whether a dynamic import has resolved by frame N is a race against the
      // wall clock. It was a real one — two consecutive probe runs of the same
      // film came back, one with kites in every frame and one with none at
      // all. The harness polls `__sfReelArmed`, so deferring the arm until the
      // flock exists turns that race into a wait, and frame zero of the film
      // becomes the first frame that has anything to film.
      /**
       * Run the flock forward before frame one, so nothing is still taking off
       * when the film starts.
       *
       * Lane 0 — the diamond soloist — is the encounter's arrival beat: it is
       * the one flyer that starts on the sand and launches, which is exactly
       * right for a player walking up and completely wrong for a camera that
       * is already there. Measured on the first cut: it needed six seconds to
       * climb out, and for the first three of them it hung at 4-6 m, 140 m
       * down the beach, at a tenth of a degree above the lens horizon — which
       * puts it in the strip of sea between the surf and the sky and makes it
       * read as a kite floating in the water. Thirteen per cent of the film.
       *
       * Ten seconds of pre-roll at the capture step clears the launch and the
       * first figure change with room to spare. It costs 600 encounter updates
       * once, before the harness has asked for a frame.
       */
      const preroll = () => {
        const encounter = win.__sf?.oceanBeachKite;
        if (encounter) {
          const view = new THREE.Vector3(site.x + 60, map.groundTop(site.x, site.z) + 8, site.z);
          for (let i = 0; i < PREROLL_FRAMES; i++) {
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

export const oceanBeachSurfFilms: readonly Demo[] = FILMS.map(buildFilm);
export const SURF_FILM_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  FILMS.map((film) => [`ocean-beach-surf-${film.id}`, film.title])
);
