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
  /** Shot length. Defaults to the festival's ten; the ring set runs seven. */
  seconds?: number;
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
    // Early afternoon, and the hour is doing real work. This angle exists for
    // the shadows, and the world's hero shadow cascade only covers 32 m around
    // the player. A kite thirty metres up throws its shadow height/tan(sun)
    // downsun — 31 m at a 44-degree sun, right off the edge of that box, which
    // is why the first cut of this shot had none. At 58 degrees it lands 19 m
    // out and falls on sand the cascade actually reaches.
    hour: 14.35,
    exposure: 0.9,
    mist: 0.3,
    shafts: 0.45,
    subject: 0,
    // A high oblique rather than a plan view: fifty metres up and forty back is
    // about a fifty-degree look-down, which puts the kites BELOW the lens with
    // their shadows on the sand under them and still keeps the waterline in
    // frame. Straight down was legible as a map and not much else.
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(78, 62, drift))
        .addScaledVector(along, mix(-34, 30, drift));
      eye.y = live.ground(eye.x, eye.z) + mix(62, 50, drift);
      // Aim at the sand, not at the kites: the shadows are the subject, and the
      // kites fall into the upper half of frame on their way to it.
      target.copy(live.flock).addScaledVector(along, mix(-8, 7, drift));
      target.y = live.ground(target.x, target.z) + 1.5;
      return mix(30, 36, drift);
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
        .addScaledVector(live.sun, -mix(70, 94, fall))
        .addScaledVector(along, mix(26, 4, fall));
      const base = live.ground(eye.x, eye.z);
      // Start level with the kite, not above it. A crane that begins higher
      // than its own target spends its first seconds pointing down at open
      // water — which is exactly what the first preview did.
      eye.y = base + mix(40, 4.5, fall);
      target.copy(live.kite);
      target.y = mix(live.kite.y + 5, base + 8 + (live.kite.y - base) * 0.36, fall);
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

/**
 * Five that live entirely in the last hour of light, because the first ten
 * bunched up around one: eight of them sit between 19.4 and 20.15, all of it
 * before the sun is even down, and they read as the same evening filmed ten
 * ways.
 *
 * The clock these are cut against, measured off the world's own solar path for
 * the shoot date rather than guessed: the sun crosses the horizon at 20.33.
 * The golden-hour air — the mist and the shafts, this whole feature's light —
 * holds full until about 20.55, is down to two-thirds by 20.78, a fifth by
 * 20.95, and is gone at 21.10. That number is the hinge. Past it there are no
 * shafts to ask for, so a shot there has to be built out of silhouette and the
 * sky's own gradient instead, and the two that go there are written that way.
 *
 * So: sun ON the water, sun just under, civil twilight, the end of civil
 * twilight, and nautical dark. Exposure opens as the sky closes.
 */
const LATE_FRAMINGS: readonly Framing[] = [
  {
    id: "11",
    title: "Ocean Beach Kites · Sun on the Water",
    // Elevation zero, to the minute: the disc is sitting on the sea rather than
    // above it or gone. It is a narrow window — twelve minutes either side and
    // this is just another low-sun shot — so it gets the longest lens in the set
    // and stands far enough back to keep the whole disc under the kites.
    hour: 20.33,
    exposure: 0.88,
    mist: 0.85,
    shafts: 1.5,
    subject: 0,
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(132, 118, drift))
        .addScaledVector(along, mix(20, -16, drift));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(3.2, 4.4, drift);
      // Low target: the disc on the waterline is the subject and the kites cross
      // in front of it, so hold the horizon rather than the flock.
      target.copy(live.flock).addScaledVector(along, mix(6, -6, drift));
      target.y = base + 6 + (live.flock.y - base) * 0.22;
      return mix(62, 72, drift);
    }
  },
  {
    id: "12",
    title: "Ocean Beach Kites · The Last Shafts",
    // Eighteen minutes under. Golden air is still near full but the sun itself
    // is below the water, which is the one geometry where the shafts read as
    // shafts — they come up off the horizon rather than down through the kites.
    hour: 20.62,
    exposure: 0.9,
    // Mist at 0.7, not the 1.35 this started on. Past sunset there is no disc
    // left to punch through the marine layer — only afterglow — so heavy fog
    // stops reading as fog and starts reading as a flat brown wash with the
    // kites lost in it. Thin air and strong shafts is the combination that
    // still has contrast at this hour.
    mist: 0.7,
    shafts: 1.85,
    subject: 4,
    companion: 5,
    // A slow rise: sand level up to twice head height, so the fans open out of
    // the dune line as the camera clears it. The sled pair leads — the only
    // shot in the production that frames those two as a pair.
    frame: ({ u }, live, eye, target) => {
      const rise = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.pair)
        .addScaledVector(live.sun, -mix(118, 104, rise))
        .addScaledVector(along, mix(-30, -14, rise));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(1.8, 9, rise);
      target.copy(live.pair).addScaledVector(along, mix(-8, 2, rise));
      target.y = base + mix(7, 10, rise) + (live.pair.y - base) * 0.3;
      return mix(46, 54, rise);
    }
  },
  {
    id: "13",
    title: "Ocean Beach Kites · Civil Twilight",
    // Six degrees under — the textbook definition, and the sky's best minute:
    // a hot orange band on the water under a blue that is already deep. Fog
    // pulled right back so that band stays a band instead of a wash.
    hour: 20.88,
    exposure: 0.95,
    // 0.18, and the camera comes in to ~70 m below, because the first render of
    // this was a grey wash: at this hour the world's own aerial perspective is
    // already doing the work of fog, and a hundred metres of it over water left
    // the kites at almost no contrast against the sky. The marine layer this
    // shot wants is thinner than the distance it is shot from.
    mist: 0.18,
    shafts: 0.65,
    subject: 6,
    // High and falling, looking down the beach: the kites stack against the
    // bright horizon strip while the sand goes to shadow.
    //
    // Anchored to the FLOCK, not to one kite. Standing off a single kite along
    // -sun is only inland if that kite happens to be inland, and the centipede
    // is the southmost of the seven — the first cut of this put the camera out
    // over open ocean, framed a stretch of empty water with the kites off the
    // top of frame, and tripped a depth read/write hazard in the water passes
    // for its trouble (1106 validation errors in ten seconds; every other shot
    // in this set logged none). The flock mean sits over the beach by
    // construction, which is why every wide shot here uses it.
    frame: ({ u }, live, eye, target) => {
      const fall = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(82, 66, fall))
        .addScaledVector(along, mix(24, 8, fall));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(20, 9, fall);
      target.copy(live.flock).addScaledVector(along, mix(4, -4, fall));
      target.y = base + 9 + (live.flock.y - base) * 0.34;
      return mix(46, 56, fall);
    }
  },
  {
    id: "14",
    title: "Ocean Beach Kites · After the Light",
    // 21.10: golden hits zero here. No shafts exist to ask for at this hour, so
    // asking for them would only prove the gate works. This one is built out of
    // what is left — seven black kites on a blue gradient — and the camera
    // orbits so their outlines change against it rather than sitting still.
    hour: 21.1,
    exposure: 1.04,
    mist: 0.42,
    shafts: 0,
    subject: 1,
    companion: 2,
    frame: ({ u }, live, eye, target) => {
      const swing = easeInOutCubic(u);
      const angle = mix(0.44, -0.36, swing);
      const away = new THREE.Vector3(
        -live.sun.x * Math.cos(angle) + live.sun.z * Math.sin(angle),
        0,
        -live.sun.z * Math.cos(angle) - live.sun.x * Math.sin(angle)
      ).normalize();
      eye.copy(live.pair).addScaledVector(away, mix(92, 80, swing));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + mix(4.5, 9, swing);
      target.copy(live.pair);
      // Sit the pair high in frame against the brightest part of the gradient;
      // the sand below has nothing left to show.
      target.y = base + 11 + (live.pair.y - base) * 0.42;
      return mix(48, 58, swing);
    }
  },
  {
    id: "15",
    title: "Ocean Beach Kites · Nautical",
    // Eleven and a half degrees under, the darkest this set goes. Everything is
    // silhouette and the last cold band over the sea. Widest lens of the fifteen
    // and the lowest eye in the whole production: from the sand the kites sit
    // against sky, and sky is the only thing still carrying light.
    hour: 21.45,
    exposure: 1.12,
    mist: 0.55,
    shafts: 0,
    subject: 3,
    frame: ({ u }, live, eye, target) => {
      const track = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(76, 68, track))
        .addScaledVector(along, mix(-26, 22, track));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.5;
      target.copy(live.flock).addScaledVector(along, mix(-6, 6, track));
      target.y = base + 12 + (live.flock.y - base) * 0.34;
      return mix(34, 38, track);
    }
  }
];

/**
 * Five seven-second looks that live in the last hour of light, and the first
 * five in this production whose point of difference is the CAMERA rather than
 * the clock. The twenty before them are, with two exceptions, the same rig: an
 * eye standing on the sand a hundred metres downsun of the flock, at head
 * height, looking back up at the kites. That geometry is correct — it is the
 * only one in which kite and sun share a frame — and it has been shot twenty
 * ways.
 *
 * So each of these breaks it somewhere specific and pays for it:
 *
 *   dusk-01  travels, where every other shot stands still or crawls
 *   dusk-02  puts the eye AT kite altitude and looks level, not up
 *   dusk-03  stands two body-lengths from a flyer instead of a hundred metres
 *   dusk-04  compresses the whole beach onto the longest lens here
 *   dusk-05  looks UP, which the distance rule exists to avoid
 *
 * Seven seconds each, and mostly past sunset: one at 20.02 with the disc still
 * on the water and full shafts, then 20.44, 20.66, 20.94 and 21.16 — sunset is
 * 20.33, civil twilight ends around 20.88, and the golden air this feature runs
 * on is gone by 21.10. Only the first of the five has a sun to point at.
 */
const DUSK_FRAMINGS: readonly Framing[] = [
  {
    id: "dusk-01",
    title: "Ocean Beach Kites · Down the Line",
    // Nineteen minutes to sunset: the disc is still above the water and golden
    // is at full, which is what a travelling shot wants. Move the camera at
    // 21.16 and there is nothing for the parallax to move against.
    hour: 20.02,
    seconds: 7,
    exposure: 0.92,
    mist: 0.95,
    shafts: 1.6,
    subject: 0,
    // Forty-eight metres of lateral dolly at walking-eye height, down the
    // inland side of the line of flyers. Every other look in this production is
    // a camera that drifts; this one goes somewhere, and the near runners sweep
    // past against the fixed sun while the far ones barely move — the only shot
    // here with real parallax in it.
    //
    // A hundred metres back, which the first cut got wrong at sixty. Distance
    // is what sets the kites' elevation, and elevation is what decides whether
    // the waterline survives: at sixty metres they sit twenty-six degrees up,
    // the lens has to tilt to hold them, and the horizon leaves the bottom of
    // frame with the beach and the flyers going with it. At a hundred they are
    // fifteen degrees up, the tilt halves, and sand, surf, sun and seven kites
    // are one picture. The flyers are small on purpose.
    frame: ({ u }, live, eye, target) => {
      const run = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(104, 92, run))
        .addScaledVector(along, mix(-26, 22, run));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.7;
      // The look leads the move at the top of the shot and gives that lead away
      // to the sun by the end, so the dolly arrives somewhere instead of merely
      // passing through. Target is built off the EYE, not off the flock: a
      // travelling shot that keeps aiming at the same point is a pan, and pans
      // cancel the parallax the move exists for.
      //
      // The lead is bounded by the lens rather than chosen: twenty metres of it
      // at fifty-two out is twenty-one degrees off the sun, and a 32 mm frame
      // is twenty-nine degrees wide either side. Push the lead further and the
      // shot spends its first seconds with the sun outside the picture, which
      // is what the first cut did.
      target.copy(eye)
        .addScaledVector(along, mix(20, 5, run))
        .addScaledVector(live.sun, mix(52, 62, run));
      target.y = base + mix(9, 10.5, run);
      return mix(32, 40, run);
    }
  },
  {
    id: "dusk-02",
    title: "Ocean Beach Kites · Level with the Flock",
    // Seven minutes past sunset, golden still full: the sky has its colour and
    // the sea has a band, and from up here both are horizon rather than ceiling.
    hour: 20.44,
    // Stopped down, and thinner air than the sand-level looks run, for the same
    // reason dusk-04 is: a hundred metres of marine layer between an airborne
    // camera and the flock is a hundred metres more than a camera standing
    // under them looks through, and metered like one of those the whole frame
    // came back a flat peach wash with the kites barely on it.
    exposure: 0.8,
    seconds: 7,
    mist: 0.35,
    // Shafts pulled back too, which is the opposite of what a backlit shot
    // normally wants. Pointed straight into the glow from an airborne camera
    // the fans bloom over the cloth instead of behind it, and the kites lose
    // the edge that makes them kites. 1.15 keeps the rays and gives the shapes
    // back.
    shafts: 1.15,
    subject: 0,
    // The eye goes up to the kites instead of looking up at them — twenty-odd
    // metres of air under it, a hundred metres back, trucking sideways.
    //
    // It sits deliberately a few metres BELOW the flock. Level with them and
    // the kites land on the horizon line and read as smudges on the sea; four
    // metres under and they lift clear of it, sky behind, with the waterline
    // and the wet sand stacked underneath.
    //
    // And the lens tilts UP from there, by about four degrees, which is not a
    // taste decision. Aimed below its own eye this shot fills the lower half of
    // frame with open water at a shallow grazing angle, and that is the view
    // that trips the depth read/write hazard in the water passes — the same one
    // shot 13 hit. Every command buffer for the whole take was rejected: 868
    // validation errors, seven identical frames, a clip of the boot image. Four
    // degrees up puts the waterline in the bottom third with the kites just
    // over centre, and the pass is quiet.
    frame: ({ u }, live, eye, target) => {
      const truck = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(102, 92, truck))
        .addScaledVector(along, mix(20, -16, truck));
      // Floored well clear of the sand: the flock's own altitude swings by ten
      // metres as the figures run, and without this a low pass would put the
      // camera in the dunes rather than in the air.
      eye.y = Math.max(live.ground(eye.x, eye.z) + 9, live.flock.y - mix(5, 9, truck));
      target.copy(live.flock).addScaledVector(along, mix(-5, 4, truck));
      target.y = live.flock.y + mix(2.5, -3, truck);
      return mix(52, 44, truck);
    }
  },
  {
    id: "dusk-03",
    title: "Ocean Beach Kites · Over the Shoulder",
    // Twenty minutes under. No disc left, but the band behind the flyer is at
    // its hottest and the shafts still rake along the sand toward the camera.
    hour: 20.66,
    exposure: 0.94,
    seconds: 7,
    // Thin air and hard shafts — the same combination shot 12 arrived at, and
    // for the same reason: past sunset there is no disc left to punch through a
    // heavy marine layer, so thick fog reads as a flat wash instead of as fog.
    mist: 0.55,
    shafts: 1.8,
    subject: 4,
    // Five metres behind a sled flyer's shoulder, pushing in to under three.
    // The one shot in the production with a person in the near field: they are
    // most of the frame, black, with the line leaving out of the top corner and
    // the rest of the beach small and backlit past them.
    //
    // Being this close is normally what breaks these shots — a camera beside a
    // flyer is looking steeply up at a kite with the sun nowhere in shot. Here
    // the kite is MEANT to be out of frame. The subject is the silhouette, and
    // the sun's own line-of-sight sits just past their shoulder, which is
    // exactly what the distance rule is protecting everywhere else.
    frame: ({ u }, live, eye, target) => {
      const push = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.runner)
        .addScaledVector(live.sun, -mix(6.8, 4.8, push))
        .addScaledVector(along, mix(1.7, -1, push));
      eye.y = live.ground(eye.x, eye.z) + 1.55;
      // Aim at the chest, rising to the head as the lens gets longer — so the
      // push walks their feet out of the bottom of frame rather than shrinking
      // them in it.
      //
      // Measured off the SAND under them, not off `runner.y`. runnerPosition is
      // the rig's root and the root sits at about hip height, so aiming a
      // "head height" 1.5 m above it aims 0.65 m over the actual head. From a
      // hundred metres that is nothing and shot 04 ignores it; from five it is
      // seven degrees, and the first master of this spent its last two seconds
      // on an empty sky with the top of a head along the bottom edge.
      target.copy(live.runner);
      target.y = live.ground(live.runner.x, live.runner.z) + mix(1.2, 1.5, push);
      return mix(38, 50, push);
    }
  },
  {
    id: "dusk-04",
    title: "Ocean Beach Kites · The Long Band",
    // Civil twilight, near its end. The sky is a narrow hot strip over the water
    // under deep blue, and a long lens is the instrument that strip wants.
    hour: 20.94,
    // 0.86, well under the 0.95–1.12 the other post-sunset looks run. Those all
    // stand sixty to a hundred metres out; this one is at a hundred and sixty
    // through a telephoto, and that much air is itself a brightening, low-
    // contrast filter. Metered like them the frame came back a pale wash with
    // grey kites in it. Stopping down is what turns the band back into a band
    // and the kites back into silhouettes.
    exposure: 0.86,
    seconds: 7,
    // 0.12, following shot 13's lesson to its end: from this far out at this
    // hour the world's own aerial perspective is already more haze than the
    // frame can carry, and any marine layer on top of it is pure contrast loss.
    mist: 0.12,
    shafts: 0.55,
    subject: 6,
    // The longest lens outside the eclipse set: 62→74 mm, which compresses the
    // dune line, the surf, the band and seven kites into four flat stacked
    // strips with no depth left in them at all. The opposite instrument to
    // dusk-03's, on the same beach.
    //
    // It started at 80→94 and had to come back. A telephoto here is threading
    // the horizon and the kites through one frame, and the gap between them
    // grows every time the flock climbs: at 94 mm the window was under a degree
    // wide and any gust that lifted the kites pushed the waterline off the
    // bottom, leaving a whole second of bare sky. Ten millimetres of lens is
    // worth far less than the four degrees of margin they buy.
    //
    // A hundred and ten metres, not the hundred and sixty this started on.
    // Compression is the lens's job, not the tripod's, and every extra metre at
    // this hour is bought with contrast: at a hundred and sixty the frame came
    // back the same grey-peach wash shot 13 got, and stopping down could darken
    // it but not put the difference between kite and sky back. Shot 13 solved
    // this by walking in and so does this.
    //
    // The tilt is solved rather than dialled — a telephoto that holds the kites
    // loses the horizon and vice versa, so the aim rides a fixed fraction of
    // the live flock height and stays between the two as the lens closes in.
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.flock)
        .addScaledVector(live.sun, -mix(114, 102, drift))
        .addScaledVector(along, mix(-14, 12, drift));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 2.6;
      target.copy(live.flock).addScaledVector(along, mix(-4, 3, drift));
      // The aim tracks an eighth of the live flock height, so a gust that lifts
      // the kites lifts the frame with them — enough to keep them off the top
      // edge, gentle enough that the waterline never leaves the bottom.
      target.y = base + mix(11.7, 12.4, drift) + (live.flock.y - base) * 0.12;
      return mix(62, 74, drift);
    }
  },
  {
    id: "dusk-05",
    title: "Ocean Beach Kites · Under the Wing",
    // 21.16 — six minutes past the end of golden hour. There are no shafts to
    // ask for and no disc to stand downsun of, which is precisely what unlocks
    // this angle: the distance rule exists to keep the sun in frame, and once
    // there is no sun the rule has nothing left to protect.
    hour: 21.16,
    exposure: 1.06,
    mist: 0.45,
    seconds: 7,
    shafts: 0,
    subject: 0,
    // So: fifty metres out instead of a hundred, and the only shot here that
    // looks UP. Seven black kites fill the top two-thirds of a wide frame with
    // the last cold band pinned along the very bottom edge, and the camera
    // walks a forty-degree arc around the flock so their outlines cross and
    // separate against the gradient rather than sitting still on it.
    //
    // Fifty and not thirty, because everything here aims at the MEAN kite and
    // seven of them are strung eighty metres along the sand. At thirty that
    // spread is a hundred degrees wide — wider than any lens — and the shot
    // spends half its length framing empty sky between two kites at opposite
    // edges. Fifty brings the spread inside a 30 mm frame and only costs four
    // degrees of the elevation this angle exists for.
    frame: ({ u }, live, eye, target) => {
      const swing = easeInOutCubic(u);
      const angle = mix(-0.34, 0.3, swing);
      const away = new THREE.Vector3(
        -live.sun.x * Math.cos(angle) + live.sun.z * Math.sin(angle),
        0,
        -live.sun.z * Math.cos(angle) - live.sun.x * Math.sin(angle)
      ).normalize();
      eye.copy(live.flock).addScaledVector(away, mix(52, 44, swing));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.6;
      target.copy(live.flock);
      // Aimed well under the kites, not at them: at this range aiming AT the
      // flock is thirty degrees of tilt and the horizon falls off the bottom
      // with the last light in the picture going with it.
      target.y = base + mix(19, 17, swing);
      return mix(30, 26, swing);
    }
  }
];

/**
 * Puts the eye on the line that runs from the sun, through the kite, to the
 * camera — so the sun's disc lands dead centre of the hole the kite is carrying.
 *
 * The sun is effectively at infinity, so if `eye = kite - sun * D` then the
 * direction eye→kite and the direction eye→sun are the SAME vector, for any D
 * and wherever the kite has drifted to. The alignment is exact by construction:
 * there is no tracking error to tune and no drift to chase, which matters
 * because the sunwheel's eye is about two metres across and subtends barely a
 * degree at these distances — a degree of aim error and the sun is behind the
 * cloth instead of inside the ring.
 *
 * What is NOT free is where that leaves the camera. The ray descends at the
 * sun's own elevation, so D sets the eye's height: `eye.y = kite.y - D*sun.y`.
 * Ask for a height and this solves for the D that delivers it (twice, since the
 * ground under the camera is not known until the camera has a position); ask
 * for a distance and the height is whatever the geometry gives. A shallow sun
 * wants a very long throw for a low eye, so D is clamped and a late shot simply
 * ends up in the air — which is the honest answer, and reads as an aerial.
 */
function alignThroughKite(
  kite: THREE.Vector3,
  sun: THREE.Vector3,
  ground: (x: number, z: number) => number,
  eye: THREE.Vector3,
  want: { height: number; distance?: undefined } | { distance: number; height?: undefined },
  minDistance = 38,
  maxDistance = 195
): number {
  const rise = Math.max(sun.y, 0.035);
  // The clearance floor is enforced by SHORTENING the throw, never by lifting
  // the eye: raising `eye.y` off the ray is exactly the thing that breaks the
  // eclipse. Since `eye.y = kite.y - D*rise`, a smaller D is a higher camera,
  // so there is always a D that clears the sand and still holds the alignment.
  // Without this a long throw walks the camera inland into the dunes, where it
  // renders a garbage frame and trips a depth read/write hazard in the water
  // passes — which is how the first cut of "Star Axis" came back as a shot of
  // bare sand with 388 validation errors behind it.
  const clearing = (distance: number) => {
    let d = THREE.MathUtils.clamp(distance, minDistance, maxDistance);
    for (let pass = 0; pass < 3; pass++) {
      eye.copy(kite).addScaledVector(sun, -d);
      const floor = ground(eye.x, eye.z) + CLEARANCE;
      if (eye.y >= floor) break;
      d = THREE.MathUtils.clamp((kite.y - floor) / rise, minDistance, d);
    }
    eye.copy(kite).addScaledVector(sun, -d);
    return d;
  };
  if (want.distance !== undefined) return clearing(want.distance);
  let base = ground(kite.x, kite.z);
  let distance = minDistance;
  for (let pass = 0; pass < 2; pass++) {
    distance = THREE.MathUtils.clamp((kite.y - (base + want.height)) / rise, minDistance, maxDistance);
    eye.copy(kite).addScaledVector(sun, -distance);
    base = ground(eye.x, eye.z);
  }
  return clearing(distance);
}

/** Metres of air the eclipse camera keeps under itself. */
const CLEARANCE = 2.2;

/**
 * Five seven-second shots built on one idea: stand where the sunwheel eclipses
 * the sun, so the disc sits inside the wheel's open hub like a lens.
 *
 * They are shorter than the festival's ten because the image is a single held
 * event rather than a scene to read — seven seconds is long enough to arrive,
 * hold, and leave, and ten spends the last three on nothing.
 *
 * Two of them keep the rest of the flock in frame around the ring, two isolate
 * it against bare sky, and one starts off the axis and slides onto it so the
 * sun visibly walks into the hub. Hours run 19.3 to 20.42, which also moves the
 * camera: a high sun puts the eye on the sand at the far end of a long throw, a
 * sinking one lifts it into the air, and both are the same construction.
 */
const RING_FRAMINGS: readonly Framing[] = [
  {
    id: "ring-01",
    title: "Ocean Beach Kites · The Eye",
    // Sun still ten degrees up, which is what buys a camera down on the sand:
    // the solve wants ~140 m of throw to drop the eye to head height, and a long
    // lens turns that distance back into a big ring.
    hour: 19.3,
    seconds: 7,
    exposure: 0.9,
    mist: 0.8,
    shafts: 1.45,
    subject: 1,
    frame: ({ u }, live, eye, target) => {
      const push = easeInOutCubic(u);
      alignThroughKite(live.kite, live.sun, live.ground, eye, { height: mix(2.4, 3.1, push) });
      target.copy(live.kite);
      return mix(58, 88, push);
    }
  },
  {
    id: "ring-02",
    title: "Ocean Beach Kites · Through the Wheel",
    // The same eclipse, but wide enough that the other six are in the picture
    // around it — the ring is the subject and the festival is the context.
    hour: 19.75,
    seconds: 7,
    exposure: 0.94,
    mist: 1.0,
    shafts: 1.6,
    subject: 2,
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      alignThroughKite(live.kite, live.sun, live.ground, eye, { height: mix(5.5, 8.5, drift) });
      // Aiming off the kite does NOT break the eclipse — that lives in where the
      // eye stands, not where it points — so the target can slide the ring
      // around the frame while the sun stays locked inside it.
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      target.copy(live.kite).addScaledVector(along, mix(-7, 6, drift));
      target.y = live.kite.y - mix(5, 9, drift);
      return mix(40, 47, drift);
    }
  },
  {
    id: "ring-03",
    title: "Ocean Beach Kites · Star Axis",
    // The tunnel shot: a dolly straight down the sun-kite axis, 170 m in to 52.
    // Nothing rotates and nothing pans — the ring simply grows until it is the
    // frame, with the sun sitting still at its centre the whole way in. The eye
    // climbs on its own as the throw shortens, because the axis is tilted.
    hour: 20.05,
    seconds: 7,
    exposure: 0.92,
    mist: 0.9,
    shafts: 1.9,
    subject: 1,
    frame: ({ u }, live, eye, target) => {
      const run = easeInOutCubic(u);
      alignThroughKite(live.kite, live.sun, live.ground, eye, { distance: mix(170, 52, run) });
      target.copy(live.kite);
      return mix(46, 74, run);
    }
  },
  {
    id: "ring-04",
    title: "Ocean Beach Kites · Into Line",
    // Starts a good forty metres off the axis, with the sun beside the wheel
    // rather than in it, and slides onto the line over the first two-thirds —
    // so the disc visibly walks across the cloth and drops into the hub, then
    // holds there. The offset eases to exactly zero; the last third is locked.
    hour: 19.55,
    seconds: 7,
    exposure: 0.92,
    mist: 1.1,
    shafts: 1.7,
    subject: 1,
    frame: ({ u }, live, eye, target) => {
      const slide = easeInOutCubic(Math.min(1, u / 0.66));
      alignThroughKite(live.kite, live.sun, live.ground, eye, { height: 4.2 });
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.addScaledVector(along, mix(42, 0, slide));
      target.copy(live.kite);
      return mix(52, 68, slide);
    }
  },
  {
    id: "ring-05",
    title: "Ocean Beach Kites · Last Ring",
    // Six minutes past sunset. The sun is a degree and a half under, so the
    // solve cannot get the eye anywhere near the sand and clamps out long — the
    // camera ends up twenty-odd metres up, looking level down the axis with the
    // whole beach small underneath. The disc in the hub is deep orange by now.
    hour: 20.42,
    seconds: 7,
    exposure: 0.98,
    mist: 0.6,
    shafts: 1.25,
    subject: 2,
    frame: ({ u }, live, eye, target) => {
      const settle = easeInOutCubic(u);
      alignThroughKite(live.kite, live.sun, live.ground, eye, { distance: mix(120, 88, settle) });
      target.copy(live.kite);
      target.y = live.kite.y - mix(2, 6, settle);
      return mix(50, 62, settle);
    }
  }
];

/**
 * Three that are about the FLYERS, not only the kites.
 *
 * Everything before these stood a hundred metres back on a long lens, because
 * that is the geometry in which a kite and a low sun share a frame. It works,
 * and it also renders the people who are flying them as twelve-pixel specks —
 * the beach reads as unmanned kites. These trade some of that reach for a
 * camera at head height, forty-odd metres out, on a wide lens.
 *
 * The arithmetic that sets the numbers below: a runner is ~1.8 m and a kite
 * flies ~30 m up. At 45 m on a 28 mm lens the vertical field is about 46°, so
 * the runner covers a tenth of frame height — legible as a person, with a
 * recognisable gait — while a target placed ~12 m up leaves the kite about 22°
 * above centre, just inside the top. Aim at the kite instead and the runner
 * drops off the bottom; aim at the runner and the kite leaves the top. The
 * target has to sit between them, nearer the ground.
 *
 * Sunset, twilight, night — and the last one is shot into the water on purpose,
 * because after dark the only thing still carrying light is the sea, and a
 * flyer standing against sand is simply gone.
 */
const FLYER_FRAMINGS: readonly Framing[] = [
  {
    id: "16",
    title: "Ocean Beach Kites · The Line",
    // Sun a few minutes off the water: still a disc, still throwing shafts, and
    // low enough to rake along the beach and light the runners from the side.
    hour: 20.2,
    exposure: 0.95,
    mist: 0.75,
    shafts: 1.35,
    subject: 0,
    frame: ({ u }, live, eye, target) => {
      const drift = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      // Stood off the RUNNER, not the flock. Standing off the flock measures the
      // distance to the KITES, and the people holding them are another forty
      // metres downwind again — which is how the first cut put them at the very
      // bottom edge, half of one of them outside the frame. Forty metres from
      // the person is forty metres from the person.
      eye.copy(live.runner)
        .addScaledVector(live.sun, -mix(44, 37, drift))
        .addScaledVector(along, mix(-26, 22, drift));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.9;
      target.copy(live.runner).addScaledVector(along, mix(-9, 7, drift));
      // 10 m of look-up is the compromise the geometry allows: lower and the
      // kites leave the top, higher and the sand goes with the flyers on it.
      target.y = base + 10;
      return mix(27, 30, drift);
    }
  },
  {
    id: "17",
    title: "Ocean Beach Kites · Two on the Sand",
    // Civil twilight. The sun is under, so nobody is lit from the front any
    // more — the flyers read as silhouettes against a bright band of water,
    // which is exactly why the camera sits low and shoots seaward.
    hour: 20.95,
    exposure: 1.0,
    mist: 0.34,
    shafts: 0.45,
    subject: 4,
    companion: 5,
    frame: ({ u }, live, eye, target) => {
      const push = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      // Anchored to the RUNNER, not the kite: this shot is about the two of
      // them working the sled pair, and the kites can look after themselves in
      // the upper half of the frame.
      eye.copy(live.runner)
        .addScaledVector(live.sun, -mix(34, 27, push))
        .addScaledVector(along, mix(15, 7, push));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.7;
      target.copy(live.runner).addScaledVector(along, mix(3, -2, push));
      target.y = base + mix(7, 8.5, push);
      return mix(30, 34, push);
    }
  },
  {
    id: "18",
    title: "Ocean Beach Kites · Night Flyers",
    // Twenty past nine and properly dark: sixteen degrees under, moonlit, stars
    // out. No shafts exist at this hour and asking for them would only prove
    // the golden-hour gate works, so this is built from silhouette against the
    // water sheen. Exposure opens further than anything else in the production.
    hour: 21.9,
    exposure: 1.24,
    mist: 0.45,
    shafts: 0,
    subject: 6,
    frame: ({ u }, live, eye, target) => {
      const settle = easeInOutCubic(u);
      const along = new THREE.Vector3(-live.sun.z, 0, live.sun.x).normalize();
      eye.copy(live.runner)
        .addScaledVector(live.sun, -mix(44, 38, settle))
        .addScaledVector(along, mix(-18, 12, settle));
      const base = live.ground(eye.x, eye.z);
      eye.y = base + 1.6;
      target.copy(live.runner).addScaledVector(along, mix(-4, 4, settle));
      // A touch higher than the twilight look: after dark the sky still holds a
      // gradient and the sand holds nothing, so give the sky more of the frame.
      target.y = base + mix(9, 11, settle);
      return mix(29, 33, settle);
    }
  }
];

type KiteWindow = Window & typeof globalThis & { __sf?: { oceanBeachKite?: OceanBeachKiteEncounter } };

function buildDemo(framing: Framing): Demo {
  const name = `ocean-beach-kite-${framing.id}`;
  const seconds = framing.seconds ?? KITE_FESTIVAL_SECONDS;
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
      // Single-sampled, and `multisample: false` on the demo is what actually
      // buys it — several of this scene's passes SAMPLE scene depth, and a
      // multisampled depth attachment is not bindable as an ordinary texture in
      // WebGPU. Leave MSAA on and the renderer throws "Sample count (4) of
      // [Texture depth] doesn't match expectation", every command buffer that
      // frame is rejected, and the clip records ten seconds of cleared canvas.
      // Asking here as well is belt and braces: by the time `run()` executes,
      // warmup has already allocated the targets, so this call alone cannot
      // undo a multisampled depth buffer. That is exactly how this regressed —
      // it held while the depth consumers stayed quiet and broke the moment the
      // ocean rewrite added one that is always live.
      // contactShadows: false for the same family of reason. The complement's
      // quad SAMPLES the beauty pass's depth attachment, and CityGen warms a
      // second scene-pass render context through prepareSceneOwner while a
      // capture is stepping frames. In that second context the depth is both
      // the attachment and a binding, WebGPU rejects the command buffer, and
      // the shot records clear colour — measured at ~70% of ten-second takes on
      // one framing, with every failing run showing two `rt=output` contexts
      // against the same "depth" texture and every clean one showing a single
      // one. Driving the complement outside the pass (contactShadows.renderNow)
      // roughly halves that; switching it off for the capture is what makes it
      // zero. These are wide exteriors — kites thirty metres up, camera seventy
      // to a hundred and forty back — and a close-contact darkening term
      // contributes nothing at that range.
      ctx.setPostFx({ sceneSamples: 0, contactShadows: false, ink: false, dream: false, retro: false });
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
      // Burying the body drops player.renderPosition 300 m under the sand — and
      // that vector is the third argument to sky.update(), which is what the
      // hero shadow cascade centres its 32 m box on. Left alone it parks the
      // entire shadow domain below the seabed and NOTHING on this beach casts a
      // shadow, in any shot, at any hour. Put the reported position back on the
      // sand; the mesh stays buried because freezeAndBuryPlayer has already
      // made syncMesh a no-op, so nothing ever walks it back up.
      ctx.player.renderPosition.set(site.x, map.groundTop(site.x, site.z), site.z);

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
        duration: seconds,
        shots: [
          {
            id: framing.id,
            start: 0,
            end: seconds,
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

const ALL_FRAMINGS = [
  ...FRAMINGS,
  ...EXTRA_FRAMINGS,
  ...LATE_FRAMINGS,
  ...FLYER_FRAMINGS,
  ...RING_FRAMINGS,
  ...DUSK_FRAMINGS
];

export const kiteFestivalDemos: readonly Demo[] = ALL_FRAMINGS.map(buildDemo);
export const KITE_FESTIVAL_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  ALL_FRAMINGS.map((framing) => [`ocean-beach-kite-${framing.id}`, framing.title])
);
