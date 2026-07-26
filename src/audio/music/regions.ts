// Lo-fi music regions — pure data + blend math, Node-safe (no WebAudio).
//
// The whole map gets a base city profile; named regions pull the score toward
// their own key, mode, pacing, palette and groove as the listener crosses their
// fade band. Bounds are imported from whatever module already owns the place so
// the music can never drift away from the geometry it is scoring.
//
// Regions sit on *layers* (`priority`). A layer masks everything below it in
// proportion to its own influence, so a cathedral interior replaces the street
// it stands on rather than averaging with it, and the Japanese Tea Garden is
// not a 50/50 smear of Golden Gate Park. Same-layer neighbours blend normally —
// that is how a district border should sound.
//
// Quiet zones are small circles around the world's diegetic performers — the
// busker trio, the Fort Mason ensemble, the beach pianist, the Wave Organ —
// where the ambient score bows out so live music owns the stage.

import { NATURE_REGIONS, distanceToRect, smoothstep, type Rect } from "../regions";
import { FORT_MASON_ENSEMBLE_CENTER } from "../../gameplay/fortMasonEnsemble/meta";
import { BEACH_PIANIST_CENTER } from "../../world/beachPianist/meta";
import { WAVE_ORGAN_CENTER } from "../../world/waveOrgan/meta";
import { BUENA_VISTA_REGION } from "../../world/buenaVista";
import { BOTANICAL_GARDEN_BOUNDS } from "../../world/garden/layout";
import { TEA_GARDEN_BOUNDS } from "../../world/japaneseTeaGarden/layout";
import { OCEAN_BEACH_SURF } from "../../world/oceanBeachWaves";
import { MD_CENTER } from "../../world/missionDolores/layout";
import { WILD_REGIONS } from "../../world/wildlands/regions";
import type { ModeName, VoicingStyle } from "./theory";
import type { GrooveKitId } from "./groove";
import type {
  BassMix,
  BassVoiceId,
  KeysMix,
  KeysVoiceId,
  PadMix,
  PadVoiceId,
  SparkleMix,
  SparkleVoiceId
} from "./voiceTypes";

export type MusicProfile = {
  /** key root pitch class (0 = C). Not blended — the dominant region owns it. */
  root: number;
  dayMode: ModeName;
  nightMode: ModeName;
  /** seconds per chord at midday; night stretches this. */
  chordSeconds: number;
  /** 0..1 density of the high melodic pings. */
  sparkle: number;
  /** 0..1 vinyl pops/hiss under the music. */
  crackle: number;
  /** 0..1 how dark the master lowpass sits. */
  warmth: number;
  /** 0..1 reverb send. */
  reverb: number;
  /** 0..1 layer gains. */
  pad: number;
  keys: number;
  bass: number;
  /** 0..1 procedural percussion level. */
  groove: number;
  /** 0..1 baked tape-dust texture bed. */
  dust: number;
  /** groove tempo in BPM and its swing (0 = straight, 1 = hard triplet). */
  bpm: number;
  swing: number;
  /** 0..1 how often the harmony actually resolves instead of drifting. */
  cadence: number;
  /** 0..1 bass movement — 0 is root pedal, 1 is a walking line. */
  motion: number;
  /** instrument palettes; weights are relative pick odds, blended across regions. */
  keysMix: KeysMix;
  padMix: PadMix;
  bassMix: BassMix;
  sparkleMix: SparkleMix;
  /** how chords are spaced in the voicing. */
  voicing: VoicingStyle;
  /** which procedural drum kit plays here. */
  kit: GrooveKitId;
};

export type MusicRegionSpec = {
  id: string;
  label: string;
  bounds: Rect;
  /** metres of smoothstep falloff outside the bounds. */
  fade: number;
  /**
   * Which layer of the map this is. A region is masked by every region on a
   * strictly higher layer that covers it, so nested places win outright instead
   * of averaging with their container:
   *   0 city district · 1 park / shore / wildland · 2 landmark · 3 interior.
   */
  priority: number;
  profile: MusicProfile;
};

/** Everywhere the named regions aren't: classic city lo-fi in D — the same
 *  tonal home as the busker songbook, so drifting past live players never
 *  lands a key clash. Deliberately unremarkable; it is the paper, not the
 *  drawing. Every named region below exists to be more specific than this. */
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
  keys: 1,
  bass: 0.6,
  groove: 0.6,
  dust: 0.55,
  bpm: 84,
  swing: 0.5,
  cadence: 0.42,
  motion: 0.45,
  keysMix: { rhodes: 3, felt: 1.5, vibes: 1 },
  padMix: { drift: 2, choir: 1 },
  bassMix: { round: 2, upright: 1.5, tape: 1 },
  sparkleMix: { musicBox: 2, glassBell: 1, kalimba: 0.6 },
  voicing: "thirds",
  kit: "lofiSwing"
};

/* ------------------------------------------------------------------ bounds */

const natureBounds = (id: string): Rect => {
  const r = NATURE_REGIONS.find((n) => n.id === id);
  if (!r) throw new Error(`[music] missing nature region "${id}"`);
  return r.bounds;
};

const wildBounds = (id: string): Rect => {
  const r = WILD_REGIONS.find((w) => w.id === id);
  if (!r) throw new Error(`[music] missing wild region "${id}"`);
  return { minX: r.minX, maxX: r.maxX, minZ: r.minZ, maxZ: r.maxZ };
};

/** Copy just the rect fields off a richer authored constant. */
const rect = (b: { minX: number; maxX: number; minZ: number; maxZ: number }): Rect => ({
  minX: b.minX,
  maxX: b.maxX,
  minZ: b.minZ,
  maxZ: b.maxZ
});

/** A modest footprint around a point landmark. */
const around = (c: { x: number; z: number }, halfX: number, halfZ = halfX): Rect => ({
  minX: c.x - halfX,
  maxX: c.x + halfX,
  minZ: c.z - halfZ,
  maxZ: c.z + halfZ
});

// Two landmark anchors are inlined rather than imported: world/heightmap.ts
// (PALACE_LAGOON) and world/sutroTower.ts (SUTRO_TOWER_ANCHOR) both import
// three/webgpu, and this module has to stay pure data for the headless probe
// and out of the audio chunk's dependency graph. Values mirror those constants.
const PALACE_LAGOON_CENTER = { x: -300, z: -1426 }; // heightmap.ts PALACE_LAGOON
const SUTRO_TOWER_CENTER = { x: -782, z: 3846 }; // sutroTower.ts SUTRO_TOWER_ANCHOR

/* ----------------------------------------------------------------- regions */

export const MUSIC_REGIONS: MusicRegionSpec[] = [
  {
    // Marin headlands — golden hills and cold ocean, no human music for miles.
    // Pads only, no pulse: the slowest harmony in the world outside the church.
    id: "marin",
    label: "Marin Headlands",
    bounds: natureBounds("marin"),
    fade: 220,
    priority: 1,
    profile: {
      root: 0, // C
      dayMode: "lydian",
      nightMode: "aeolian",
      chordSeconds: 16,
      sparkle: 0.35,
      crackle: 0.1,
      warmth: 0.34,
      reverb: 0.9,
      pad: 1,
      keys: 0.45,
      bass: 0.5,
      groove: 0,
      dust: 0.45,
      bpm: 52,
      swing: 0,
      cadence: 0.3,
      motion: 0.22,
      keysMix: { celeste: 2.5, vibes: 1.5, felt: 1 },
      padMix: { glass: 3, breath: 3, bow: 2, drift: 1.5 },
      bassMix: { sub: 3, round: 2 },
      sparkleMix: { harp: 4, glassBell: 2.5 },
      voicing: "quartal",
      kit: "none"
    }
  },
  {
    // The bridge — suspended, vast, and always moving. Bowed strings over a sub
    // pedal in stacked fourths; the only percussion is a half-time thud, an
    // expansion joint under a car. Holds the city's home key at cathedral scale,
    // so arriving from Marin (C) or the Presidio (E) reads as a homecoming.
    id: "goldengate",
    label: "Golden Gate Bridge",
    bounds: { minX: -3250, maxX: -2750, minZ: -5200, maxZ: -1400 },
    fade: 130,
    priority: 2,
    profile: {
      root: 2, // D
      dayMode: "lydian",
      nightMode: "aeolian",
      chordSeconds: 16,
      sparkle: 0.25,
      crackle: 0.1,
      warmth: 0.5,
      reverb: 0.92,
      pad: 1,
      keys: 0.4,
      bass: 0.8,
      groove: 0.06,
      dust: 0.35,
      bpm: 54,
      swing: 0,
      cadence: 0.35,
      motion: 0.3,
      keysMix: { celeste: 2, felt: 1.5, vibes: 1 },
      padMix: { bow: 4, glass: 2, breath: 2, choir: 1 },
      bassMix: { sub: 5, round: 1 },
      sparkleMix: { harp: 3, glassBell: 2 },
      voicing: "quartal",
      kit: "halfTime"
    }
  },
  {
    // Alcatraz — the Wharf's key gone cold. Same F, but aeolian by day and
    // harmonic minor by night, felt piano alone in cluster voicing, a dry-ish
    // concrete room instead of an ocean, and effectively no sparkle at all.
    // Fades from far out: you hear it across the water before you land.
    id: "alcatraz",
    label: "Alcatraz",
    bounds: { minX: 1750, maxX: 1950, minZ: -4160, maxZ: -3960 },
    fade: 160,
    priority: 2,
    profile: {
      root: 5, // F
      dayMode: "aeolian",
      nightMode: "harmonicMinor",
      chordSeconds: 15,
      sparkle: 0.05,
      crackle: 0.3,
      warmth: 0.6,
      reverb: 0.42,
      pad: 0.85,
      keys: 0.7,
      bass: 0.5,
      groove: 0,
      dust: 0.5,
      bpm: 50,
      swing: 0,
      cadence: 0.4,
      motion: 0.12,
      keysMix: { felt: 5, celeste: 1 },
      padMix: { bow: 2.5, drift: 2, choir: 1 },
      bassMix: { sub: 3, tape: 1.5 },
      sparkleMix: { drop: 2, musicBox: 1 },
      voicing: "cluster",
      kit: "none"
    }
  },
  {
    // Presidio — settled forest calm on an old army post: plain major thinning
    // to aeolian at dusk, brushed kit kept low, cypress-and-fog reverb.
    id: "presidio",
    label: "Presidio",
    bounds: natureBounds("presidio"),
    fade: 170,
    priority: 1,
    profile: {
      root: 4, // E
      dayMode: "ionian",
      nightMode: "aeolian",
      chordSeconds: 12,
      sparkle: 0.5,
      crackle: 0.22,
      warmth: 0.5,
      reverb: 0.66,
      pad: 0.85,
      keys: 0.7,
      bass: 0.5,
      groove: 0.3,
      dust: 0.45,
      bpm: 74,
      swing: 0.35,
      cadence: 0.45,
      motion: 0.35,
      keysMix: { felt: 2.5, vibes: 2, celeste: 1.5, nylon: 1 },
      padMix: { bow: 2.5, breath: 2, drift: 2, choir: 1 },
      bassMix: { round: 2.5, upright: 2, sub: 1.5 },
      sparkleMix: { harp: 2, musicBox: 2, glassBell: 1.5 },
      voicing: "open",
      kit: "brush"
    }
  },
  {
    // Marshall's / Baker Beach — the wild strip of dark sand under the Presidio
    // bluffs with the bridge filling the whole sky. Without this the shore below
    // the span played generic city lo-fi in D, which is the one place in the
    // world where that reads as a bug.
    //
    // Keyed to the bridge above it (D) so walking down off the headland never
    // modulates, but a third lower in feel: dorian instead of lydian, felt and
    // breath instead of celeste and bow. The beach pianist's quiet zone sits
    // inside this rect — the score is what you hear approaching them, so it is
    // deliberately spare and already in their key.
    id: "bakerbeach",
    label: "Marshall's Beach",
    bounds: {
      minX: BEACH_PIANIST_CENTER.x - 280,
      maxX: BEACH_PIANIST_CENTER.x + 240,
      minZ: BEACH_PIANIST_CENTER.z - 560,
      maxZ: BEACH_PIANIST_CENTER.z + 300
    },
    fade: 150,
    priority: 1,
    profile: {
      root: 2, // D
      dayMode: "dorian",
      nightMode: "aeolian",
      chordSeconds: 14,
      sparkle: 0.28,
      crackle: 0.18,
      warmth: 0.58,
      reverb: 0.9,
      pad: 0.95,
      keys: 0.55,
      bass: 0.5,
      groove: 0,
      dust: 0.55,
      bpm: 56,
      swing: 0,
      cadence: 0.3,
      motion: 0.18,
      keysMix: { felt: 3, celeste: 1.5, nylon: 1 },
      padMix: { breath: 3, bow: 2, glass: 1.5, drift: 1 },
      bassMix: { sub: 3, tape: 1.5, round: 1 },
      sparkleMix: { harp: 3, glassBell: 1.5, musicBox: 1 },
      voicing: "quartal",
      kit: "none"
    }
  },
  {
    // Palace of Fine Arts — a Roman ruin folly around a swan lagoon. Lydian by
    // day for the rotunda in sun, aeolian at night for the weeping friezes.
    // Harp-led, bowed, no percussion; the colonnade is genuinely enormous.
    // A whole step under the Marina's C, so entering settles rather than lifts.
    id: "palace",
    label: "Palace of Fine Arts",
    bounds: around(PALACE_LAGOON_CENTER, 110, 130),
    fade: 90,
    priority: 2,
    profile: {
      root: 10, // Bb
      dayMode: "lydian",
      nightMode: "aeolian",
      chordSeconds: 14,
      sparkle: 0.45,
      crackle: 0.15,
      warmth: 0.42,
      reverb: 0.88,
      pad: 1,
      keys: 0.6,
      bass: 0.45,
      groove: 0,
      dust: 0.28,
      bpm: 62,
      swing: 0.1,
      cadence: 0.55,
      motion: 0.2,
      keysMix: { celeste: 3, felt: 2, vibes: 1 },
      padMix: { bow: 3, choir: 2.5, glass: 1.5 },
      bassMix: { sub: 2, round: 2 },
      sparkleMix: { harp: 4, glassBell: 2 },
      voicing: "open",
      kit: "none"
    }
  },
  {
    // The Marina — flat, bright, wind off the bay, nobody complicated. Lydian
    // vibes and breath pad over a soft round bass; the most uncomplicated major
    // sound in the city, and the least crackle outside Pacific Heights.
    id: "marina",
    label: "The Marina",
    bounds: { minX: -900, maxX: 1200, minZ: -2300, maxZ: -1100 },
    fade: 70,
    priority: 0,
    profile: {
      root: 0, // C
      dayMode: "lydian",
      nightMode: "dorian",
      chordSeconds: 9.5,
      sparkle: 0.55,
      crackle: 0.35,
      warmth: 0.36,
      reverb: 0.55,
      pad: 0.7,
      keys: 0.85,
      bass: 0.6,
      groove: 0.4,
      dust: 0.38,
      bpm: 86,
      swing: 0.35,
      cadence: 0.55,
      motion: 0.5,
      keysMix: { vibes: 3, rhodes: 2, celeste: 1.5 },
      padMix: { breath: 2, drift: 2, glass: 1.5 },
      bassMix: { round: 3, upright: 2 },
      sparkleMix: { glassBell: 2, musicBox: 1.5, harp: 1.5 },
      voicing: "open",
      kit: "brush"
    }
  },
  {
    // Pacific Heights — mansions, hedges, nobody on the sidewalk. Silky Db,
    // felt piano and bowed strings, barely any groove, and the cleanest signal
    // on the map: money does not crackle.
    id: "pacheights",
    label: "Pacific Heights",
    bounds: { minX: -200, maxX: 1400, minZ: -1100, maxZ: 300 },
    fade: 65,
    priority: 0,
    profile: {
      root: 1, // Db
      dayMode: "ionian",
      nightMode: "aeolian",
      chordSeconds: 12,
      sparkle: 0.4,
      crackle: 0.3,
      warmth: 0.42,
      reverb: 0.6,
      pad: 0.8,
      keys: 0.85,
      bass: 0.5,
      groove: 0.2,
      dust: 0.32,
      bpm: 70,
      swing: 0.3,
      cadence: 0.6,
      motion: 0.35,
      keysMix: { felt: 3, vibes: 2, celeste: 2 },
      padMix: { bow: 3, choir: 1.5, drift: 1.5 },
      bassMix: { round: 3, sub: 1.5, upright: 1 },
      sparkleMix: { glassBell: 2, harp: 2, musicBox: 1 },
      voicing: "thirds",
      kit: "brush"
    }
  },
  {
    // North Beach — the warmest nocturnal room in the city. Nylon guitar and
    // upright over a properly swung kit, close thirds, and the heaviest crackle
    // outside SoMa: this is a record playing in a café, not a score.
    // Listed ahead of the Wharf on purpose: their rects overlap for 400 m along
    // Bay/Chestnut, and same-layer ties go to the earlier entry. That band is
    // North Beach; the Wharf keeps the piers, where nothing contests it.
    id: "northbeach",
    label: "North Beach",
    bounds: { minX: 2600, maxX: 3400, minZ: -1900, maxZ: -900 },
    fade: 50,
    priority: 0,
    profile: {
      root: 10, // Bb
      dayMode: "ionian",
      nightMode: "dorian",
      chordSeconds: 8.5,
      sparkle: 0.4,
      crackle: 0.85,
      warmth: 0.66,
      reverb: 0.4,
      pad: 0.45,
      keys: 1,
      bass: 0.75,
      groove: 0.6,
      dust: 0.62,
      bpm: 84,
      swing: 0.62,
      cadence: 0.68,
      motion: 0.62,
      keysMix: { nylon: 4, rhodes: 2, vibes: 1 },
      padMix: { choir: 1.5, drift: 1, organ: 0.6 },
      bassMix: { upright: 4, tape: 1 },
      sparkleMix: { musicBox: 2, kalimba: 1 },
      voicing: "thirds",
      kit: "lofiSwing"
    }
  },
  {
    // Fisherman's Wharf — sea lions, chowder, and an organ grinder. The reed
    // organ is the accordion; mixolydian keeps it jaunty, a brush shuffle keeps
    // it walking, and the pier sheds give it a wet slap.
    id: "wharf",
    label: "Fisherman's Wharf",
    bounds: { minX: 1700, maxX: 3000, minZ: -2400, maxZ: -1500 },
    fade: 60,
    priority: 0,
    profile: {
      root: 5, // F
      dayMode: "mixolydian",
      nightMode: "dorian",
      chordSeconds: 9,
      sparkle: 0.45,
      crackle: 0.6,
      warmth: 0.55,
      reverb: 0.55,
      pad: 0.6,
      keys: 0.9,
      bass: 0.65,
      groove: 0.45,
      dust: 0.5,
      bpm: 90,
      swing: 0.5,
      cadence: 0.6,
      motion: 0.5,
      keysMix: { reed: 3, nylon: 2, vibes: 1 },
      padMix: { drift: 1.5, choir: 1, breath: 1 },
      bassMix: { upright: 3, round: 1.5, tape: 1 },
      sparkleMix: { musicBox: 2, glassBell: 1.5 },
      voicing: "thirds",
      kit: "brush"
    }
  },
  {
    // Chinatown — dense low-rise, a narrow strip of sky, balconies and lanterns.
    // Koto and marimba over open voicings so the pentatonic reads clearly; the
    // highest kalimba sparkle in the city, and a short alley reverb, not a hall.
    id: "chinatown",
    label: "Chinatown",
    bounds: { minX: 2900, maxX: 3600, minZ: -1000, maxZ: -100 },
    fade: 45,
    priority: 0,
    profile: {
      root: 4, // E
      dayMode: "mixolydian",
      nightMode: "dorian",
      chordSeconds: 8,
      sparkle: 0.78,
      crackle: 0.55,
      warmth: 0.5,
      reverb: 0.4,
      pad: 0.45,
      keys: 1,
      bass: 0.6,
      groove: 0.5,
      dust: 0.5,
      bpm: 92,
      swing: 0.3,
      cadence: 0.45,
      motion: 0.35,
      keysMix: { koto: 4, marimba: 3, vibes: 1 },
      padMix: { drift: 1.5, choir: 1, breath: 1 },
      bassMix: { round: 2, upright: 2, tape: 1 },
      sparkleMix: { kalimba: 3, musicBox: 2, drop: 1 },
      voicing: "open",
      kit: "lofiSwing"
    }
  },
  {
    // Nob Hill — old money above the fog line: cable cars, marble lobbies,
    // hotel bars. Stately Eb, felt piano and vibes, a groove so light it is
    // more manners than rhythm. Shares its key with the cathedral on top of it.
    id: "nobhill",
    label: "Nob Hill",
    bounds: { minX: 2100, maxX: 3000, minZ: -1400, maxZ: 100 },
    fade: 55,
    priority: 0,
    profile: {
      root: 3, // Eb
      dayMode: "ionian",
      nightMode: "aeolian",
      chordSeconds: 12,
      sparkle: 0.35,
      crackle: 0.35,
      warmth: 0.5,
      reverb: 0.68,
      pad: 0.8,
      keys: 0.8,
      bass: 0.55,
      groove: 0.25,
      dust: 0.4,
      bpm: 76,
      swing: 0.35,
      cadence: 0.66,
      motion: 0.4,
      keysMix: { felt: 3, vibes: 2, celeste: 1 },
      padMix: { bow: 2.5, choir: 2, organ: 1 },
      bassMix: { upright: 2, round: 2, sub: 1 },
      sparkleMix: { glassBell: 2, musicBox: 1.5, harp: 1 },
      voicing: "thirds",
      kit: "brush"
    }
  },
  {
    // Grace Cathedral, interior — the most reverberant place in the world and
    // the only one with no percussion at any hour. Organ over a sub pedal in
    // open fifths, 18 s a chord, high cadence (liturgical music resolves), and
    // almost no crackle: this is a room, not a record. Keeps Nob Hill's Eb so
    // the doors change the space and the mode, never the key — lydian daylight
    // through the glass, harmonic minor after dark. Tight fade: it must not
    // leak onto the sidewalk.
    id: "gracecathedral",
    label: "Grace Cathedral",
    bounds: around({ x: 2687.5, z: -205.2 }, 54.5, 27),
    fade: 18,
    priority: 3,
    profile: {
      root: 3, // Eb
      dayMode: "lydian",
      nightMode: "harmonicMinor",
      chordSeconds: 18,
      sparkle: 0.12,
      crackle: 0.06,
      warmth: 0.62,
      reverb: 1,
      pad: 1,
      keys: 0.45,
      bass: 0.5,
      groove: 0,
      dust: 0.1,
      bpm: 48,
      swing: 0,
      cadence: 0.85,
      motion: 0.12,
      keysMix: { celeste: 2, felt: 1 },
      padMix: { organ: 5, choir: 2.5, bow: 1 },
      bassMix: { sub: 3, round: 1 },
      sparkleMix: { glassBell: 3, harp: 2 },
      voicing: "open",
      kit: "none"
    }
  },
  {
    // Financial District — vertical, brisk, weekday-formal. Tight metro kit at
    // 106, shell voicings, rhodes and vibes over a walking upright, and the
    // driest, least sparkling profile downtown: glass, carpet, no daylight at
    // street level. Plain C: this place has no interest in being colourful.
    id: "fidi",
    label: "Financial District",
    bounds: { minX: 3200, maxX: 4600, minZ: -900, maxZ: 900 },
    fade: 55,
    priority: 0,
    profile: {
      root: 0, // C
      dayMode: "ionian",
      nightMode: "dorian",
      chordSeconds: 6.5,
      sparkle: 0.15,
      crackle: 0.4,
      warmth: 0.3,
      reverb: 0.22,
      pad: 0.35,
      keys: 1,
      bass: 0.85,
      groove: 0.75,
      dust: 0.3,
      bpm: 106,
      swing: 0.22,
      cadence: 0.72,
      motion: 0.85,
      keysMix: { rhodes: 3, vibes: 2 },
      padMix: { drift: 2, bow: 1 },
      bassMix: { upright: 4, round: 1 },
      sparkleMix: { drop: 2, glassBell: 1 },
      voicing: "shell",
      kit: "metro"
    }
  },
  {
    // Embarcadero — the waterfront promenade: open sky, ferries, palms, and a
    // long arcade to bounce off. Keeps walking at a brushed 88 in open voicing;
    // the same downtown ensemble as FiDi with the roof taken off.
    id: "embarcadero",
    label: "Embarcadero",
    bounds: { minX: 3900, maxX: 5200, minZ: -2400, maxZ: 900 },
    fade: 65,
    priority: 0,
    profile: {
      root: 9, // A
      dayMode: "mixolydian",
      nightMode: "dorian",
      chordSeconds: 9,
      sparkle: 0.42,
      crackle: 0.4,
      warmth: 0.42,
      reverb: 0.62,
      pad: 0.62,
      keys: 0.85,
      bass: 0.7,
      groove: 0.5,
      dust: 0.42,
      bpm: 88,
      swing: 0.4,
      cadence: 0.5,
      motion: 0.6,
      keysMix: { rhodes: 3, vibes: 2, celeste: 1 },
      padMix: { drift: 2, breath: 1.5, glass: 1 },
      bassMix: { upright: 3, round: 2 },
      sparkleMix: { glassBell: 2, musicBox: 1, harp: 1 },
      voicing: "open",
      kit: "brush"
    }
  },
  {
    // SoMa — brick warehouse flatland. Boom-bap on a tape bass, felt piano in
    // clusters, the heaviest crackle and dust anywhere, almost no sparkle. Sits
    // a tritone off the Financial District two blocks north on purpose: crossing
    // Market should feel like changing cities.
    id: "soma",
    label: "SoMa",
    bounds: { minX: 2600, maxX: 4600, minZ: 700, maxZ: 2200 },
    fade: 70,
    priority: 0,
    profile: {
      root: 6, // F#
      dayMode: "dorian",
      nightMode: "aeolian",
      chordSeconds: 8,
      sparkle: 0.12,
      crackle: 0.95,
      warmth: 0.68,
      reverb: 0.35,
      pad: 0.5,
      keys: 0.95,
      bass: 0.9,
      groove: 0.85,
      dust: 0.8,
      bpm: 78,
      swing: 0.18,
      cadence: 0.3,
      motion: 0.45,
      keysMix: { felt: 4, rhodes: 2 },
      padMix: { drift: 2, choir: 1, bow: 1 },
      bassMix: { tape: 4, sub: 2, round: 1 },
      sparkleMix: { drop: 2, musicBox: 1 },
      voicing: "cluster",
      kit: "boom"
    }
  },
  {
    // Potrero Hill — the sunny side, and the only neighbourhood the fog gives
    // up on. Gets the brightest mode on the map (B lydian) and a lofi shuffle;
    // industry below, quiet steep streets above.
    id: "potrero",
    label: "Potrero Hill",
    bounds: { minX: 3200, maxX: 5200, minZ: 2600, maxZ: 4400 },
    fade: 80,
    priority: 0,
    profile: {
      root: 11, // B
      dayMode: "lydian",
      nightMode: "dorian",
      chordSeconds: 10,
      sparkle: 0.5,
      crackle: 0.5,
      warmth: 0.4,
      reverb: 0.5,
      pad: 0.6,
      keys: 0.9,
      bass: 0.7,
      groove: 0.5,
      dust: 0.45,
      bpm: 84,
      swing: 0.4,
      cadence: 0.5,
      motion: 0.5,
      keysMix: { rhodes: 3, vibes: 2, nylon: 1 },
      padMix: { drift: 2, glass: 1.5, choir: 1 },
      bassMix: { upright: 3, round: 2, tape: 1 },
      sparkleMix: { musicBox: 2, glassBell: 1.5, kalimba: 1 },
      voicing: "thirds",
      kit: "lofiSwing"
    }
  },
  {
    // Civic Center — beaux-arts grandeur with nobody in it. A dome, an opera
    // house, and a very large empty plaza: organ and bowed pad in open voicing,
    // a long stone slap, and a half-time pulse that mostly isn't there.
    id: "civiccenter",
    label: "Civic Center",
    bounds: { minX: 1500, maxX: 2600, minZ: 900, maxZ: 1900 },
    fade: 60,
    priority: 0,
    profile: {
      root: 8, // Ab
      dayMode: "ionian",
      nightMode: "aeolian",
      chordSeconds: 12,
      sparkle: 0.28,
      crackle: 0.5,
      warmth: 0.5,
      reverb: 0.75,
      pad: 0.85,
      keys: 0.7,
      bass: 0.5,
      groove: 0.22,
      dust: 0.55,
      bpm: 72,
      swing: 0.25,
      cadence: 0.62,
      motion: 0.3,
      keysMix: { felt: 3, celeste: 1.5, vibes: 1 },
      padMix: { organ: 2, bow: 2, choir: 2 },
      bassMix: { sub: 2, round: 2, upright: 1 },
      sparkleMix: { glassBell: 2, musicBox: 1, harp: 1 },
      voicing: "open",
      kit: "halfTime"
    }
  },
  {
    // The Mission — the warmest, most saturated place in the world. Latin kit,
    // nylon guitar, E mixolydian in the sun and E phrygian after dark, and the
    // highest cadence anywhere outside the church: this is music coming out of
    // a doorway, and it actually resolves.
    id: "mission",
    label: "The Mission",
    bounds: { minX: 1000, maxX: 2600, minZ: 2400, maxZ: 4400 },
    fade: 80,
    priority: 0,
    profile: {
      root: 4, // E
      dayMode: "mixolydian",
      nightMode: "phrygian",
      chordSeconds: 8.5,
      sparkle: 0.45,
      crackle: 0.6,
      warmth: 0.72,
      reverb: 0.4,
      pad: 0.5,
      keys: 1,
      bass: 0.85,
      groove: 0.8,
      dust: 0.55,
      bpm: 96,
      swing: 0.12,
      cadence: 0.85,
      motion: 0.65,
      keysMix: { nylon: 5, marimba: 2, rhodes: 1.5 },
      padMix: { choir: 1.5, drift: 1, organ: 1 },
      bassMix: { upright: 3, round: 2, tape: 1 },
      sparkleMix: { kalimba: 2, musicBox: 1.5, drop: 1 },
      voicing: "thirds",
      kit: "latin"
    }
  },
  {
    // Mission Dolores — the oldest building in the city, and the neighbourhood's
    // own name. Keeps the Mission's E and takes everything else away: phrygian
    // by day, harmonic minor by night, nylon and choir in a cool adobe box, no
    // kit, a bass that does not move. A burial ground with a painted ceiling.
    id: "missiondolores",
    label: "Mission Dolores",
    bounds: around(MD_CENTER, 90),
    fade: 60,
    priority: 2,
    profile: {
      root: 4, // E
      dayMode: "phrygian",
      nightMode: "harmonicMinor",
      chordSeconds: 15,
      sparkle: 0.16,
      crackle: 0.25,
      warmth: 0.7,
      reverb: 0.82,
      pad: 0.9,
      keys: 0.6,
      bass: 0.5,
      groove: 0,
      dust: 0.3,
      bpm: 56,
      swing: 0,
      cadence: 0.8,
      motion: 0.15,
      keysMix: { nylon: 3, felt: 2, celeste: 1 },
      padMix: { choir: 3, organ: 2, bow: 1.5 },
      bassMix: { sub: 2, round: 2 },
      sparkleMix: { musicBox: 2, harp: 2 },
      voicing: "open",
      kit: "none"
    }
  },
  {
    // The Castro — the one place that refuses to go minor after dark. Ionian by
    // day, mixolydian at night; theatre organ under bright rhodes and celeste,
    // a 100 bpm shuffle. Nothing here gets sadder when the sun goes down.
    id: "castro",
    label: "The Castro",
    bounds: { minX: 300, maxX: 1400, minZ: 2900, maxZ: 4700 },
    fade: 65,
    priority: 0,
    profile: {
      root: 7, // G
      dayMode: "ionian",
      nightMode: "mixolydian",
      chordSeconds: 8,
      sparkle: 0.6,
      crackle: 0.55,
      warmth: 0.5,
      reverb: 0.5,
      pad: 0.6,
      keys: 0.95,
      bass: 0.75,
      groove: 0.7,
      dust: 0.45,
      bpm: 100,
      swing: 0.3,
      cadence: 0.75,
      motion: 0.6,
      keysMix: { rhodes: 3, vibes: 2, celeste: 1.5 },
      padMix: { organ: 2.5, choir: 1.5, drift: 1 },
      bassMix: { round: 3, upright: 2 },
      sparkleMix: { glassBell: 2, musicBox: 1.5, kalimba: 1 },
      voicing: "thirds",
      kit: "lofiSwing"
    }
  },
  {
    // Corona Heights — bare chaparral over the Castro; mixolydian lift, quicker
    // harmonic breeze, brushed and airy. Stays in D on purpose: the busker trio
    // plays this hilltop, and their songbook is the city's home key.
    id: "corona",
    label: "Corona Heights",
    bounds: natureBounds("corona"),
    fade: 110,
    priority: 1,
    profile: {
      root: 2, // D
      dayMode: "mixolydian",
      nightMode: "dorian",
      chordSeconds: 9,
      sparkle: 0.6,
      crackle: 0.32,
      warmth: 0.44,
      reverb: 0.66,
      pad: 0.65,
      keys: 0.8,
      bass: 0.5,
      groove: 0.32,
      dust: 0.42,
      bpm: 84,
      swing: 0.4,
      cadence: 0.5,
      motion: 0.45,
      keysMix: { vibes: 2.5, rhodes: 2, celeste: 1.5, nylon: 1 },
      padMix: { drift: 2, glass: 2, breath: 1.5 },
      bassMix: { round: 2.5, upright: 2 },
      sparkleMix: { musicBox: 2, glassBell: 2, kalimba: 1 },
      voicing: "open",
      kit: "brush"
    }
  },
  {
    // Buena Vista Park — the oldest park in the city and the dampest: a closed
    // canopy over a steep crown, benches built from broken gravestones. Dorian
    // even at noon, no kit at all, and a reverb the trees have no business
    // having. The one green place that is never cheerful.
    id: "buenavista",
    label: "Buena Vista Park",
    bounds: rect(BUENA_VISTA_REGION),
    fade: 90,
    priority: 1,
    profile: {
      root: 11, // B
      dayMode: "dorian",
      nightMode: "aeolian",
      chordSeconds: 13,
      sparkle: 0.42,
      crackle: 0.25,
      warmth: 0.62,
      reverb: 0.72,
      pad: 0.9,
      keys: 0.6,
      bass: 0.5,
      groove: 0,
      dust: 0.5,
      bpm: 66,
      swing: 0.3,
      cadence: 0.35,
      motion: 0.25,
      keysMix: { felt: 2.5, celeste: 2, vibes: 1.5 },
      padMix: { breath: 2.5, bow: 2, drift: 2, choir: 1.5 },
      bassMix: { round: 2.5, sub: 2 },
      sparkleMix: { harp: 2.5, musicBox: 1.5, glassBell: 1.5 },
      voicing: "open",
      kit: "none"
    }
  },
  {
    // Haight-Ashbury — the most modal place in the city and the one that least
    // wants to resolve. A mixolydian drone: harmonium and bent koto over a root
    // pedal, stacked fourths so nothing pulls anywhere, 13 s a chord, half-time
    // haze. Cadence 0.18 is the lowest in the world and that is the whole point.
    id: "haight",
    label: "Haight-Ashbury",
    bounds: { minX: -800, maxX: 1200, minZ: 1200, maxZ: 2600 },
    fade: 70,
    priority: 0,
    profile: {
      root: 9, // A
      dayMode: "mixolydian",
      nightMode: "dorian",
      chordSeconds: 13,
      sparkle: 0.55,
      crackle: 0.7,
      warmth: 0.58,
      reverb: 0.6,
      pad: 0.8,
      keys: 0.85,
      bass: 0.6,
      groove: 0.4,
      dust: 0.6,
      bpm: 76,
      swing: 0.45,
      cadence: 0.18,
      motion: 0.15,
      keysMix: { reed: 3, koto: 2, rhodes: 1.5, nylon: 1 },
      padMix: { drift: 2.5, choir: 1.5, glass: 1.5 },
      bassMix: { round: 3, sub: 2, tape: 1 },
      sparkleMix: { kalimba: 2, glassBell: 1.5, musicBox: 1 },
      voicing: "quartal",
      kit: "halfTime"
    }
  },
  {
    // Twin Peaks — wind-scoured saddle with the whole city underneath it and
    // the fog pouring over. Ab lydian for the view, aeolian for the cold; huge
    // reverb, quartal spacing, and a half-time pulse at 0.08 that is the city
    // heard from very far away.
    id: "twinpeaks",
    label: "Twin Peaks",
    bounds: wildBounds("twinpeaks"),
    fade: 140,
    priority: 1,
    profile: {
      root: 8, // Ab
      dayMode: "lydian",
      nightMode: "aeolian",
      chordSeconds: 14,
      sparkle: 0.35,
      crackle: 0.2,
      warmth: 0.4,
      reverb: 0.85,
      pad: 1,
      keys: 0.5,
      bass: 0.55,
      groove: 0.08,
      dust: 0.5,
      bpm: 58,
      swing: 0,
      cadence: 0.3,
      motion: 0.25,
      keysMix: { celeste: 2.5, felt: 1.5, vibes: 1 },
      padMix: { breath: 3, glass: 2.5, bow: 2, drift: 1.5 },
      bassMix: { sub: 3, round: 1.5 },
      sparkleMix: { harp: 3, glassBell: 2 },
      voicing: "quartal",
      kit: "halfTime"
    }
  },
  {
    // Sutro Tower — the strangest sound in the world, and the only drone with a
    // clock in it. Glass shimmer and drawbar organ hold a carrier tone over a
    // sub pedal that barely moves (motion 0.08); a metro kit ticks at 0.1 like
    // a transmitter. Lydian #4 by day, phrygian b2 under the red lights at
    // night, cadence 0.2 — a carrier wave does not resolve.
    id: "sutrotower",
    label: "Sutro Tower",
    bounds: around(SUTRO_TOWER_CENTER, 90),
    fade: 70,
    priority: 2,
    profile: {
      root: 6, // F#
      dayMode: "lydian",
      nightMode: "phrygian",
      chordSeconds: 11,
      sparkle: 0.5,
      crackle: 0.35,
      warmth: 0.3,
      reverb: 0.7,
      pad: 1,
      keys: 0.5,
      bass: 0.75,
      groove: 0.1,
      dust: 0.35,
      bpm: 66,
      swing: 0,
      cadence: 0.2,
      motion: 0.08,
      keysMix: { vibes: 3, celeste: 2, koto: 1 },
      padMix: { glass: 4, organ: 2, bow: 1.5 },
      bassMix: { sub: 4, tape: 1 },
      sparkleMix: { drop: 2.5, glassBell: 2, kalimba: 1 },
      voicing: "quartal",
      kit: "metro"
    }
  },
  {
    // Golden Gate Park — brighter and playful: lydian sparkle over vibes and
    // marimba on a brushed kit. The city's green centre, and the widest region
    // on the map, so it holds the key across a long walk.
    id: "ggpark",
    label: "Golden Gate Park",
    bounds: natureBounds("ggpark"),
    fade: 170,
    priority: 1,
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
      keys: 0.9,
      bass: 0.5,
      groove: 0.45,
      dust: 0.4,
      bpm: 88,
      swing: 0.45,
      cadence: 0.5,
      motion: 0.45,
      keysMix: { vibes: 3, rhodes: 2.5, marimba: 1.5, celeste: 1 },
      padMix: { drift: 2.5, glass: 1.5, choir: 1.5, breath: 1 },
      bassMix: { upright: 3, round: 2 },
      sparkleMix: { musicBox: 2.5, kalimba: 2, glassBell: 1.5 },
      voicing: "open",
      kit: "brush"
    }
  },
  {
    // Botanical Garden — cultivated, protected, luminous. A fourth above the
    // park it sits in, celeste-led, the highest sparkle on the map. The only
    // region besides the Castro that stays major after dark: a walled garden
    // does not get frightening at night.
    id: "botanical",
    label: "Botanical Garden",
    bounds: rect(BOTANICAL_GARDEN_BOUNDS),
    fade: 70,
    priority: 2,
    profile: {
      root: 0, // C
      dayMode: "lydian",
      nightMode: "ionian",
      chordSeconds: 12,
      sparkle: 0.85,
      crackle: 0.18,
      warmth: 0.34,
      reverb: 0.55,
      pad: 0.75,
      keys: 0.85,
      bass: 0.45,
      groove: 0.14,
      dust: 0.28,
      bpm: 70,
      swing: 0.3,
      cadence: 0.6,
      motion: 0.3,
      keysMix: { celeste: 3, vibes: 2.5, marimba: 1.5, felt: 1 },
      padMix: { glass: 2.5, breath: 2, drift: 1.5, choir: 1 },
      bassMix: { round: 3, sub: 1.5, upright: 1 },
      sparkleMix: { musicBox: 2.5, kalimba: 2.5, glassBell: 2, harp: 1.5 },
      voicing: "open",
      kit: "brush"
    }
  },
  {
    // Japanese Tea Garden — koto and breath pad, 16 s a chord, no kit, almost
    // nothing else. The modes are chosen for the pentatonic the sparkles draw
    // from: dorian yields the yō scale for daylight, phrygian yields kumoi —
    // the melancholy evening scale — after dark.
    id: "teagarden",
    label: "Japanese Tea Garden",
    bounds: rect(TEA_GARDEN_BOUNDS),
    fade: 55,
    priority: 3,
    profile: {
      root: 9, // A
      dayMode: "dorian",
      nightMode: "phrygian",
      chordSeconds: 16,
      sparkle: 0.3,
      crackle: 0.12,
      warmth: 0.5,
      reverb: 0.6,
      pad: 0.8,
      keys: 0.75,
      bass: 0.4,
      groove: 0,
      dust: 0.25,
      bpm: 60,
      swing: 0,
      cadence: 0.3,
      motion: 0.1,
      keysMix: { koto: 5, celeste: 1.5, marimba: 1 },
      padMix: { breath: 4, drift: 1.5, glass: 1 },
      bassMix: { sub: 2.5, round: 1.5 },
      sparkleMix: { kalimba: 2, harp: 2, musicBox: 1 },
      voicing: "open",
      kit: "none"
    }
  },
  {
    // The Richmond — fog-swallowed avenue grid. Slow, hypnotic, quartal so
    // nothing pulls; drift and breath pads under a muted felt piano, with one
    // cold plucked koto for Clement Street. A half-time pulse keeps a faint
    // heartbeat the Sunset does not get.
    id: "richmond",
    label: "The Richmond",
    bounds: { minX: -6000, maxX: -1200, minZ: 300, maxZ: 1800 },
    fade: 90,
    priority: 0,
    profile: {
      root: 3, // Eb
      dayMode: "dorian",
      nightMode: "aeolian",
      chordSeconds: 15,
      sparkle: 0.2,
      crackle: 0.55,
      warmth: 0.78,
      reverb: 0.7,
      pad: 0.95,
      keys: 0.6,
      bass: 0.55,
      groove: 0.18,
      dust: 0.85,
      bpm: 58,
      swing: 0.2,
      cadence: 0.22,
      motion: 0.18,
      keysMix: { felt: 3, koto: 1.5, vibes: 1 },
      padMix: { breath: 3, drift: 3, choir: 1 },
      bassMix: { sub: 3, tape: 2, round: 1 },
      sparkleMix: { harp: 2, musicBox: 1, glassBell: 1 },
      voicing: "quartal",
      kit: "halfTime"
    }
  },
  {
    // The Sunset — the same grid, further out, more of it, less of anything
    // else. The darkest lowpass and the most tape dust on the map, no kit at
    // all, and the only region in the world whose mode does not change between
    // day and night. Out here the fog never lifts.
    id: "sunset",
    label: "The Sunset",
    bounds: { minX: -6100, maxX: -1200, minZ: 2600, maxZ: 4900 },
    fade: 90,
    priority: 0,
    profile: {
      root: 1, // Db
      dayMode: "aeolian",
      nightMode: "aeolian",
      chordSeconds: 17,
      sparkle: 0.14,
      crackle: 0.5,
      warmth: 0.85,
      reverb: 0.72,
      pad: 1,
      keys: 0.5,
      bass: 0.55,
      groove: 0,
      dust: 0.92,
      bpm: 56,
      swing: 0.15,
      cadence: 0.15,
      motion: 0.1,
      keysMix: { felt: 3, reed: 1.5 },
      padMix: { drift: 3, breath: 3, glass: 1 },
      bassMix: { sub: 3, tape: 2 },
      sparkleMix: { harp: 2, glassBell: 1 },
      voicing: "quartal",
      kit: "none"
    }
  },
  {
    // Lands End — fog-minor over the Pacific: sparse, distant, the widest
    // reverb in the outdoors. No kit, quartal spacing, harp above a sub pedal.
    id: "landsEnd",
    label: "Lands End",
    bounds: natureBounds("landsEnd"),
    fade: 170,
    priority: 1,
    profile: {
      root: 9, // A
      dayMode: "dorian",
      nightMode: "aeolian",
      chordSeconds: 15,
      sparkle: 0.3,
      crackle: 0.16,
      warmth: 0.6,
      reverb: 0.96,
      pad: 0.95,
      keys: 0.5,
      bass: 0.45,
      groove: 0,
      dust: 0.6,
      bpm: 54,
      swing: 0,
      cadence: 0.25,
      motion: 0.2,
      keysMix: { felt: 2.5, celeste: 2, koto: 1 },
      padMix: { breath: 3, glass: 2.5, bow: 2, drift: 1.5 },
      bassMix: { sub: 3, tape: 1.5, round: 1 },
      sparkleMix: { harp: 3.5, glassBell: 2, drop: 0.8 },
      voicing: "quartal",
      kit: "none"
    }
  },
  {
    // Ocean Beach — four kilometres of grey Pacific. Drops a fifth from the
    // headland it continues (A → D), the smoothest possible move on a walk that
    // never leaves the sand. Sub-heavy under a breath pad, second-highest dust
    // on the map, nothing resolving.
    //
    // The one coastal region that is not silent: a surf kit at 0.12 is the set
    // rolling in, not a beat. Lands End is a cliff you stand on and Ocean Beach
    // is a swell you stand in — without that they are the same slow quartal
    // wash for eight kilometres. Celeste-led here against Lands End's dry felt,
    // for the same reason.
    id: "oceanbeach",
    label: "Ocean Beach",
    bounds: rect(OCEAN_BEACH_SURF),
    fade: 130,
    priority: 1,
    profile: {
      root: 2, // D
      dayMode: "dorian",
      nightMode: "aeolian",
      chordSeconds: 15,
      sparkle: 0.28,
      crackle: 0.2,
      warmth: 0.66,
      reverb: 0.9,
      pad: 1,
      keys: 0.45,
      bass: 0.6,
      groove: 0.12,
      dust: 0.7,
      bpm: 56,
      swing: 0,
      cadence: 0.22,
      motion: 0.18,
      keysMix: { celeste: 3, felt: 1.5, koto: 1 },
      padMix: { breath: 3.5, drift: 2.5, glass: 2, bow: 1 },
      bassMix: { sub: 4, tape: 1.5 },
      sparkleMix: { harp: 3, glassBell: 2 },
      voicing: "quartal",
      kit: "surf"
    }
  }
];

/* ------------------------------------------------------------- quiet zones */

export type QuietZone = { x: number; z: number; r: number; fade: number; label: string };

// Unchanged: none of the new regions needs a quiet zone moved. Two are worth
// noting. The busker trio sits inside Corona Heights, which is why that region
// keeps the city's D — the ambient key and the songbook agree even as the duck
// opens and closes. The beach pianist sits at Marshall's Beach below the
// Presidio bluffs, outside every region: the score there is the plain city bed,
// and the duck silences it well before the piano is audible either way.
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

/* -------------------------------------------------------------------- blend */

const NUMERIC_KEYS = [
  "chordSeconds",
  "sparkle",
  "crackle",
  "warmth",
  "reverb",
  "pad",
  "keys",
  "bass",
  "groove",
  "dust",
  "bpm",
  "swing",
  "cadence",
  "motion"
] as const;

/** Any numeric field of a profile that `NUMERIC_KEYS` forgot — a field left out
 *  of that list silently never blends, so this must stay `never`. `root` is
 *  excluded by design: the dominant region owns it outright. */
export type UnblendedNumericField = Exclude<
  { [K in keyof MusicProfile]-?: MusicProfile[K] extends number ? K : never }[keyof MusicProfile],
  (typeof NUMERIC_KEYS)[number] | "root"
>;
type BlendCoverage = [UnblendedNumericField] extends [never] ? true : never;
/** Compile error here means a numeric field is missing from NUMERIC_KEYS. */
export const NUMERIC_KEYS_COVER_PROFILE: BlendCoverage = true;

// Flattened lookup: index 0 is the city bed, index i+1 is MUSIC_REGIONS[i].
const PROFILES: readonly MusicProfile[] = [
  CITY_MUSIC_PROFILE,
  ...MUSIC_REGIONS.map((r) => r.profile)
];
const KEYS_MIXES: readonly KeysMix[] = PROFILES.map((p) => p.keysMix);
const PAD_MIXES: readonly PadMix[] = PROFILES.map((p) => p.padMix);
const BASS_MIXES: readonly BassMix[] = PROFILES.map((p) => p.bassMix);
const SPARKLE_MIXES: readonly SparkleMix[] = PROFILES.map((p) => p.sparkleMix);

const MAX_PRIORITY = MUSIC_REGIONS.reduce((m, r) => Math.max(m, r.priority), 0);

/** Below this the strongest region is just something you are walking past. */
const DOMINANT_FLOOR = 0.22;

const clamp01 = (v: number): number => (v > 1 ? 1 : v > 0 ? v : 0);

/**
 * Influence-weighted union of instrument palettes.
 *
 * Each region's map is normalised to sum 1 *before* it is weighted, so a region
 * that happens to write bigger numbers can't shout down its neighbours — the
 * weights are relative pick odds, not gains. The result is renormalised so the
 * blended palette is always a probability distribution.
 */
function blendVoiceMix<Id extends string>(
  mixes: readonly Partial<Record<Id, number>>[],
  weights: readonly number[]
): Partial<Record<Id, number>> {
  const acc = new Map<string, number>();
  let total = 0;
  for (let i = 0; i < mixes.length; i++) {
    const w = weights[i];
    if (!(w > 0)) continue;
    const mix = mixes[i];
    let sum = 0;
    for (const key in mix) sum += mix[key as Id] ?? 0;
    if (!(sum > 0)) continue;
    for (const key in mix) {
      const share = ((mix[key as Id] ?? 0) / sum) * w;
      if (!(share > 0)) continue;
      acc.set(key, (acc.get(key) ?? 0) + share);
      total += share;
    }
  }
  const out: Record<string, number> = {};
  if (!(total > 0)) return out as Partial<Record<Id, number>>;
  for (const [key, v] of acc) out[key] = v / total;
  return out as Partial<Record<Id, number>>;
}

export type BlendedMusic = {
  /** numeric texture fields blended across city + regions by influence. */
  profile: MusicProfile;
  /** the region that owns key/mode/voicing/kit right now (null = city). */
  dominant: MusicRegionSpec | null;
  /** the dominant's weight after layer masking, 0..1. */
  dominantInf: number;
};

/**
 * Influence-weighted blend of the numeric texture and the instrument palettes;
 * key, mode, voicing and kit are discrete and go to the dominant region (the
 * director applies hysteresis before switching).
 *
 * Two things this has to get right that the five-far-apart-rectangles version
 * did not:
 *
 * 1. Weights are *normalised by the actual total*, never by `1 - sum`. With ~30
 *    regions whose fade bands overlap, a sum above 1 used to clamp the city bed
 *    to zero while every neighbour still counted at full strength — the blend
 *    both lost its base and double-counted. The city's share is now the odds
 *    that none of the named places covers you, Π(1 - inf), which is exactly the
 *    old `1 - inf` for a single region and can never go negative.
 *
 * 2. Nested regions *replace* rather than average. A region is masked by the
 *    product of (1 - inf) over every strictly higher layer, so standing in
 *    Grace Cathedral gives the cathedral 100% and Nob Hill 0% instead of a
 *    50/50 smear that would put a drum kit in the nave.
 *
 * Dominance is then relative, not a fixed cutoff: the strongest masked weight
 * owns the key if it at least matches the city's own share and clears a small
 * floor. In open ground that reduces to the old behaviour (a lone region at 0.3
 * loses to a 0.7 city, at 0.5 it wins); in a crowded district, where four
 * overlapping regions leave the city at 0.24, a 0.3 region correctly takes the
 * key instead of losing to a bed that is barely there.
 */
export function blendMusic(inf: ArrayLike<number>): BlendedMusic {
  const n = MUSIC_REGIONS.length;

  // Pass 1: raw influence → the city's share, and each layer's own product.
  let cityW = 1;
  const layerProduct = new Array<number>(MAX_PRIORITY + 1).fill(1);
  const raw = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = clamp01(inf[i] ?? 0);
    raw[i] = v;
    if (v <= 0) continue;
    cityW *= 1 - v;
    layerProduct[MUSIC_REGIONS[i].priority] *= 1 - v;
  }

  // Pass 2: mask[p] is how much of the map a region on layer p can still see
  // once every layer above it has taken its cut.
  const mask = new Array<number>(MAX_PRIORITY + 1).fill(1);
  for (let p = MAX_PRIORITY - 1; p >= 0; p--) mask[p] = mask[p + 1] * layerProduct[p + 1];

  // Pass 3: masked weights, flattened with the city at index 0.
  const weights = new Array<number>(n + 1);
  weights[0] = cityW;
  let total = cityW;
  let dominant: MusicRegionSpec | null = null;
  let dominantInf = 0;
  for (let i = 0; i < n; i++) {
    const spec = MUSIC_REGIONS[i];
    const w = raw[i] * mask[spec.priority];
    weights[i + 1] = w;
    total += w;
    if (w > dominantInf) {
      dominantInf = w;
      dominant = spec;
    }
  }

  const owns = dominant !== null && dominantInf >= DOMINANT_FLOOR && dominantInf >= cityW;
  const owner = owns && dominant ? dominant.profile : CITY_MUSIC_PROFILE;
  const profile: MusicProfile = { ...owner };

  const denom = total > 0 ? total : 1;
  for (const key of NUMERIC_KEYS) {
    let acc = 0;
    for (let i = 0; i < PROFILES.length; i++) acc += weights[i] * PROFILES[i][key];
    profile[key] = acc / denom;
  }

  profile.keysMix = blendVoiceMix<KeysVoiceId>(KEYS_MIXES, weights);
  profile.padMix = blendVoiceMix<PadVoiceId>(PAD_MIXES, weights);
  profile.bassMix = blendVoiceMix<BassVoiceId>(BASS_MIXES, weights);
  profile.sparkleMix = blendVoiceMix<SparkleVoiceId>(SPARKLE_MIXES, weights);

  return { profile, dominant: owns ? dominant : null, dominantInf };
}
