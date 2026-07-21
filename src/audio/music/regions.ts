// Lo-fi music regions — pure data + blend math, Node-safe (no WebAudio).
//
// The whole map gets a base city profile; named regions (bounds reused from the
// nature-audio regions so they can never drift) pull the score toward their own
// key, mode, pacing and texture as the listener crosses their fade band. Quiet
// zones are small circles around the world's diegetic performers — the busker
// trio, the Fort Mason ensemble, the beach pianist, the Wave Organ — where the
// ambient score bows out so live music owns the stage.

import { NATURE_REGIONS, distanceToRect, smoothstep, type Rect } from "../regions";
import { FORT_MASON_ENSEMBLE_CENTER } from "../../gameplay/fortMasonEnsemble/meta";
import { BEACH_PIANIST_CENTER } from "../../world/beachPianist/meta";
import { WAVE_ORGAN_CENTER } from "../../world/waveOrgan/meta";
import type { ModeName } from "./theory";

export type MusicProfile = {
  /** key root pitch class (0 = C). Not blended — the dominant region owns it. */
  root: number;
  dayMode: ModeName;
  nightMode: ModeName;
  /** seconds per chord at midday; night stretches this by up to ~1.5×. */
  chordSeconds: number;
  /** 0..1 — density of the high melodic pings. */
  sparkle: number;
  /** 0..1 — vinyl pops/hiss under the music. */
  crackle: number;
  /** 0..1 — how dark the master lowpass sits. */
  warmth: number;
  /** 0..1 — reverb send. */
  reverb: number;
  /** 0..1 layer gains. */
  pad: number;
  epiano: number;
  bass: number;
};

export type MusicRegionSpec = {
  id: string;
  label: string;
  bounds: Rect;
  /** metres of smoothstep falloff outside the bounds. */
  fade: number;
  profile: MusicProfile;
};

/** Everywhere the named regions aren't: classic city lo-fi in D — the same
 *  tonal home as the busker songbook, so drifting past live players never
 *  lands a key clash. */
export const CITY_MUSIC_PROFILE: MusicProfile = {
  root: 2, // D
  dayMode: "ionian",
  nightMode: "dorian",
  chordSeconds: 9,
  sparkle: 0.45,
  crackle: 0.8,
  warmth: 0.55,
  reverb: 0.45,
  pad: 0.55,
  epiano: 1,
  bass: 0.6
};

const natureBounds = (id: string): Rect => {
  const r = NATURE_REGIONS.find((n) => n.id === id);
  if (!r) throw new Error(`[music] missing nature region "${id}"`);
  return r.bounds;
};

export const MUSIC_REGIONS: MusicRegionSpec[] = [
  {
    // Golden Gate Park — brighter, playful: lydian sparkle over soft keys.
    id: "ggpark",
    label: "Golden Gate Park",
    bounds: natureBounds("ggpark"),
    fade: 170,
    profile: {
      root: 7, // G
      dayMode: "lydian",
      nightMode: "dorian",
      chordSeconds: 10,
      sparkle: 0.75,
      crackle: 0.3,
      warmth: 0.4,
      reverb: 0.6,
      pad: 0.7,
      epiano: 0.9,
      bass: 0.5
    }
  },
  {
    // Presidio — settled forest calm; plain major thinning to aeolian dusk.
    id: "presidio",
    label: "Presidio",
    bounds: natureBounds("presidio"),
    fade: 170,
    profile: {
      root: 4, // E
      dayMode: "ionian",
      nightMode: "aeolian",
      chordSeconds: 11,
      sparkle: 0.55,
      crackle: 0.25,
      warmth: 0.45,
      reverb: 0.6,
      pad: 0.8,
      epiano: 0.75,
      bass: 0.5
    }
  },
  {
    // Marin redwoods — cathedral drones: pads lead, keys recede, huge space.
    id: "marin",
    label: "Marin Headlands",
    bounds: natureBounds("marin"),
    fade: 220,
    profile: {
      root: 0, // C
      dayMode: "lydian",
      nightMode: "aeolian",
      chordSeconds: 13,
      sparkle: 0.4,
      crackle: 0.15,
      warmth: 0.35,
      reverb: 0.85,
      pad: 1,
      epiano: 0.5,
      bass: 0.45
    }
  },
  {
    // Lands End — fog-minor over the Pacific; sparse, distant, wide reverb.
    id: "landsEnd",
    label: "Lands End",
    bounds: natureBounds("landsEnd"),
    fade: 170,
    profile: {
      root: 9, // A
      dayMode: "dorian",
      nightMode: "aeolian",
      chordSeconds: 13,
      sparkle: 0.3,
      crackle: 0.2,
      warmth: 0.6,
      reverb: 0.95,
      pad: 0.9,
      epiano: 0.55,
      bass: 0.4
    }
  },
  {
    // Corona Heights — airy hilltop; mixolydian lift, quicker harmonic breeze.
    id: "corona",
    label: "Corona Heights",
    bounds: natureBounds("corona"),
    fade: 110,
    profile: {
      root: 2, // D
      dayMode: "mixolydian",
      nightMode: "dorian",
      chordSeconds: 9,
      sparkle: 0.6,
      crackle: 0.35,
      warmth: 0.45,
      reverb: 0.6,
      pad: 0.6,
      epiano: 0.8,
      bass: 0.5
    }
  }
];

export type QuietZone = { x: number; z: number; r: number; fade: number; label: string };

export const MUSIC_QUIET_ZONES: QuietZone[] = [
  { ...FORT_MASON_ENSEMBLE_CENTER, r: 48, fade: 42, label: "fort-mason bandstand" },
  { ...BEACH_PIANIST_CENTER, r: 72, fade: 55, label: "beach pianist" },
  { ...WAVE_ORGAN_CENTER, r: 42, fade: 38, label: "wave organ" },
  // busker trio placement (app/systems/buskers.ts seats the act here)
  { x: 412, z: 2760, r: 44, fade: 38, label: "corona buskers" }
];

/** How present a music region is at (x,z): 1 inside, → 0 by `fade` metres out. */
export function musicRegionInfluence(spec: MusicRegionSpec, x: number, z: number): number {
  const d = distanceToRect(x, z, spec.bounds);
  if (d >= spec.fade) return 0;
  return smoothstep(spec.fade, 0, d);
}

/** 1 in the open world, → 0 approaching a live performer. */
export function quietZoneDuck(x: number, z: number): number {
  let duck = 1;
  for (const zone of MUSIC_QUIET_ZONES) {
    const d = Math.hypot(x - zone.x, z - zone.z);
    duck = Math.min(duck, smoothstep(zone.r, zone.r + zone.fade, d));
  }
  return duck;
}

const NUMERIC_KEYS = [
  "chordSeconds",
  "sparkle",
  "crackle",
  "warmth",
  "reverb",
  "pad",
  "epiano",
  "bass"
] as const;

export type BlendedMusic = {
  /** numeric texture fields blended across city + regions by influence. */
  profile: MusicProfile;
  /** the region that owns key/mode right now (null = city). */
  dominant: MusicRegionSpec | null;
  dominantInf: number;
};

/** Influence-weighted blend of the numeric texture; key/mode ownership goes to
 *  the strongest region (the director applies hysteresis before switching). */
export function blendMusic(inf: ArrayLike<number>): BlendedMusic {
  let sum = 0;
  let dominant: MusicRegionSpec | null = null;
  let dominantInf = 0;
  for (let i = 0; i < MUSIC_REGIONS.length; i++) {
    sum += inf[i];
    if (inf[i] > dominantInf) {
      dominantInf = inf[i];
      dominant = MUSIC_REGIONS[i];
    }
  }
  const cityW = Math.max(0, 1 - sum);
  const total = cityW + sum;
  const owner = dominant && dominantInf > 0.45 ? dominant.profile : CITY_MUSIC_PROFILE;
  const profile: MusicProfile = { ...owner };
  for (const key of NUMERIC_KEYS) {
    let acc = cityW * CITY_MUSIC_PROFILE[key];
    for (let i = 0; i < MUSIC_REGIONS.length; i++) {
      acc += inf[i] * MUSIC_REGIONS[i].profile[key];
    }
    profile[key] = acc / total;
  }
  return { profile, dominant: dominantInf > 0.45 ? dominant : null, dominantInf };
}
