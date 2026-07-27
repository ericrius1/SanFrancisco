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
    // silhouette and the last cold band over the sea. Widest lens and the lowest
    // eye in the whole production: from the sand the kites sit against sky, and
    // sky is the only thing still carrying light.
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

type KiteWindow = Window & typeof globalThis & { __sf?: { oceanBeachKite?: OceanBeachKiteEncounter } };

function buildDemo(framing: Framing): Demo {
  const name = `ocean-beach-kite-${framing.id}`;
  const seconds = framing.seconds ?? KITE_FESTIVAL_SECONDS;
  return {
    name,
    // Depth-sampling passes: see the note in run(). Read before warmup.
    multisample: false,
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
      ctx.setPostFx({ sceneSamples: 0, ink: false, dream: false, retro: false });
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

const ALL_FRAMINGS = [...FRAMINGS, ...EXTRA_FRAMINGS, ...LATE_FRAMINGS, ...RING_FRAMINGS];

export const kiteFestivalDemos: readonly Demo[] = ALL_FRAMINGS.map(buildDemo);
export const KITE_FESTIVAL_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  ALL_FRAMINGS.map((framing) => [`ocean-beach-kite-${framing.id}`, framing.title])
);
