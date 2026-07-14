import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const PCM_MAX = 32_767;
const TARGET_PEAK = 0.92;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const PRODUCTION_DURATIONS = Object.freeze({
  afterlight: 15,
  hoverboard: 15,
  "dog-park": 11,
  "palace-reverie": 15,
  landsend: 15,
  "roqn-open-road": 30,
  "surf-aerial": 7,
  ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [
    `twitter-summer-${String(index + 1).padStart(2, "0")}`,
    7.5
  ]))
});

/**
 * Picture-locked audio beats. Keeping this next to the synthesis plan makes it
 * straightforward to retime both score and sound design when a shot changes.
 */
export const CINEMATIC_AUDIO_PLANS = Object.freeze({
  afterlight: Object.freeze([
    { time: 3, id: "echo-1", description: "first echo begins its return" },
    { time: 3.72, id: "echo-2", description: "second echo begins its return" },
    { time: 4.44, id: "echo-3", description: "third echo begins its return" },
    { time: 5.16, id: "echo-4", description: "fourth echo begins its return" },
    { time: 5.88, id: "echo-5", description: "final echo begins its return" },
    { time: 6.74, id: "loom", description: "the restored loom blooms" },
    { time: 7.15, id: "whale", description: "the sky whale rises" }
  ]),
  hoverboard: Object.freeze([
    { time: 2.4, id: "shape", description: "shape customization click" },
    { time: 4.8, id: "surface", description: "surface/material shimmer" },
    { time: 7.1, id: "propulsion", description: "wisp-to-comet propulsion morph" },
    { time: 9.4, id: "thrust", description: "propulsion confirmation and thrust ignition" },
    { time: 10, id: "boost", description: "ride boost" },
    { time: 12.35, id: "ollie", description: "ollie lift" },
    { time: 13.5, id: "resolve", description: "wide flying resolve" }
  ]),
  "dog-park": Object.freeze([
    { time: 2.2, id: "windup", description: "throw windup" },
    { time: 3.35, id: "throw", description: "ball release" },
    { time: 4.16, id: "bounce-1", description: "first ball bounce" },
    { time: 4.83, id: "bounce-2", description: "second ball bounce" },
    { time: 4.5, id: "chase", description: "dog chase begins" },
    { time: 9.3, id: "resolve", description: "sunset wide resolve" }
  ]),
  "palace-reverie": Object.freeze([
    { time: 0.4, id: "arrive", description: "soft shore presence" },
    { time: 4.2, id: "lamp-a", description: "first lamps awaken" },
    { time: 8.0, id: "lamp-b", description: "colonnade warms" },
    { time: 11.2, id: "bloom", description: "rotunda aurora bloom" },
    { time: 13.6, id: "resolve", description: "blue-hour hold" }
  ]),
  landsend: Object.freeze([
    { time: 0, id: "arrival", description: "marine drone + surf wash establishes" },
    { time: 2.6, id: "walk", description: "the light-wave begins threading inward" },
    { time: 7, id: "awaken", description: "the spiral comes fully alight" },
    { time: 10.7, id: "release", description: "gold flood + sea-lanterns lift off" },
    { time: 13.2, id: "resolve", description: "lanterns drift out over the Pacific" }
  ]),
  "roqn-open-road": Object.freeze([
    { time: 0, id: "garden", description: "Botanical Garden dawn flight" },
    { time: 6, id: "car", description: "Embarcadero street run" },
    { time: 12, id: "palace", description: "Palace lagoon drone reveal" },
    { time: 18, id: "golden-gate", description: "Golden Gate bird pass" },
    { time: 24, id: "speedboat", description: "Bay Bridge speedboat run" },
    { time: 25.25, id: "shell-one", description: "first bay shell" },
    { time: 27.8, id: "burst", description: "Bay Lights firework bloom" },
    { time: 29.3, id: "resolve", description: "open-water resolve" }
  ]),
  "surf-aerial": Object.freeze([
    { time: 0, id: "face", description: "rail sets into the emerald face" },
    { time: 2.15, id: "takeoff", description: "lip releases the board" },
    { time: 3.1, id: "rotation", description: "aerial rotation reaches its apex" },
    { time: 4.05, id: "landing", description: "rails reconnect with the wave" },
    { time: 6.35, id: "resolve", description: "down-face carve resolves" }
  ]),
  ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => {
    const shot = index + 1;
    return [`twitter-summer-${String(shot).padStart(2, "0")}`, Object.freeze([
      { time: 0, id: "arrive", description: `summer movement ${shot} arrives` },
      { time: 3.25, id: "lift", description: `summer movement ${shot} camera/action lift` },
      { time: 6.55, id: "handoff", description: `summer movement ${shot} transition handoff` }
    ])];
  }))
});

const DEFAULT_DOG_PARK_BEDS = Object.freeze([
  { path: "public/audio/nature/wind-grass.mp3", volume: 0.055, offset: 11.7 },
  { path: "public/audio/nature/forest-birds.mp3", volume: 0.035, offset: 17.3 }
]);

const DEFAULT_PALACE_BEDS = Object.freeze([
  { path: "public/audio/nature/wind-grass.mp3", volume: 0.04, offset: 8.2 },
  { path: "public/audio/nature/night-crickets.mp3", volume: 0.045, offset: 2.1 },
  { path: "public/audio/nature/wind-tree.mp3", volume: 0.03, offset: 14.5 }
]);

/**
 * Render the score and sound design for one cinematic production.
 *
 * @param {{
 *   id: 'afterlight'|'hoverboard'|'dog-park'|'roqn-open-road'|`twitter-summer-${string}`,
 *   duration?: number,
 *   fps?: number,
 *   seed?: number,
 *   audio?: { beds?: Array<{path: string, volume?: number, offset?: number}> }
 * }} production
 * @param {string} outputPath destination PCM WAV path
 * @returns {Promise<{
 *   file: string, id: string, duration: number, sampleRate: number,
 *   channels: number, frames: number, bytes: number, seed: number,
 *   peak: number, peakDb: number, rmsDb: number,
 *   cues: ReadonlyArray<{time:number,id:string,description:string}>,
 *   beds: Array<{path:string,volume:number,mixed:boolean,reason?:string}>
 * }>}
 */
export async function renderCinematicAudio(production, outputPath) {
  if (!production || typeof production !== "object") {
    throw new TypeError("renderCinematicAudio requires a production object");
  }
  if (!outputPath || typeof outputPath !== "string") {
    throw new TypeError("renderCinematicAudio requires an output WAV path");
  }

  const id = production.id;
  const expectedDuration = PRODUCTION_DURATIONS[id];
  if (!expectedDuration) {
    throw new RangeError(`Unsupported cinematic audio production id: ${String(id)}`);
  }

  const requestedDuration = production.duration ?? expectedDuration;
  if (!Number.isFinite(requestedDuration) || Math.abs(requestedDuration - expectedDuration) > 1e-6) {
    throw new RangeError(`${id} audio is picture-locked to exactly ${expectedDuration} seconds`);
  }

  const seed = normalizeSeed(production.seed, hash32(`eidoverse:${id}:audio:v1`));
  const mix = createMix(expectedDuration, seed);
  const beds = [];

  if (id === "afterlight") {
    scoreAfterlight(mix);
  } else if (id === "hoverboard") {
    scoreHoverboard(mix);
  } else if (id === "palace-reverie") {
    scorePalaceReverie(mix);
    const bedPlan = Array.isArray(production.audio?.beds)
      ? production.audio.beds
      : DEFAULT_PALACE_BEDS;
    for (let i = 0; i < bedPlan.length; i += 1) {
      beds.push(mixNatureBed(mix, bedPlan[i], i));
    }
  } else if (id === "landsend") {
    scoreLandsEnd(mix);
  } else if (id === "dog-park") {
    scoreDogPark(mix);
    const bedPlan = Array.isArray(production.audio?.beds)
      ? production.audio.beds
      : DEFAULT_DOG_PARK_BEDS;
    for (let i = 0; i < bedPlan.length; i += 1) {
      beds.push(mixNatureBed(mix, bedPlan[i], i));
    }
  } else if (id === "roqn-open-road") {
    scoreRoqnOpenRoad(mix);
  } else if (id === "surf-aerial") {
    scoreSurfAerial(mix);
  } else {
    scoreTwitterSummerShot(mix, Number(id.slice(-2)));
  }

  const levels = masterAndLimit(mix, id === "dog-park" ? 2 : id === "roqn-open-road" ? 1.65 : id.startsWith("twitter-summer-") ? 1.55 : id === "afterlight" ? 1.45 : 1.35);
  const absoluteOutput = path.resolve(outputPath);
  const wav = encodePcm16Wav(mix.left, mix.right, SAMPLE_RATE);
  await atomicWrite(absoluteOutput, wav);

  return {
    file: absoluteOutput,
    id,
    duration: expectedDuration,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    frames: mix.frames,
    bytes: wav.byteLength,
    seed,
    peak: levels.peak,
    peakDb: levels.peakDb,
    rmsDb: levels.rmsDb,
    cues: CINEMATIC_AUDIO_PLANS[id],
    beds
  };
}

function scoreSurfAerial(mix) {
  addPad(mix, {
    start: 0,
    duration: 7,
    notes: [45, 52, 57, 61, 66, 73],
    gain: 0.05,
    pan: 0,
    brightness: 0.58
  });
  addAir(mix, { start: 0, duration: 7, gain: 0.026, panDrift: 0.72 });
  addFoley(mix, { start: 0.05, duration: 6.9, gain: 0.023, pan: 0, character: "board" });
  addPropulsion(mix, { start: 0.12, duration: 2.25, fromHz: 58, toHz: 118, gain: 0.045 });
  addWhoosh(mix, {
    start: 1.78,
    duration: 2.25,
    gain: 0.105,
    panFrom: -0.65,
    panTo: 0.72,
    direction: "out"
  });
  addSub(mix, { start: 2.04, duration: 0.66, fromHz: 64, toHz: 39, gain: 0.09 });
  addChime(mix, { start: 2.72, midi: 81, duration: 1.55, gain: 0.055, pan: 0.34 });
  addWhoosh(mix, {
    start: 3.25,
    duration: 1.18,
    gain: 0.08,
    panFrom: 0.52,
    panTo: -0.28,
    direction: "in"
  });
  addSoftThump(mix, { start: 4.0, gain: 0.13, pan: -0.05, pitchHz: 92 });
  addChime(mix, { start: 4.08, midi: 76, duration: 1.5, gain: 0.045, pan: -0.24 });
  addWhoosh(mix, {
    start: 5.15,
    duration: 1.7,
    gain: 0.05,
    panFrom: -0.25,
    panTo: 0.45,
    direction: "out"
  });
}

/**
 * A reusable "dandelion portal" transition: air folds inward, a soft harmonic
 * crosses the stereo field, then a handful of seed-like sparkles bloom out.
 */
export async function renderTransitionAudio(options = {}, outputPath) {
  if (!outputPath || typeof outputPath !== "string") {
    throw new TypeError("renderTransitionAudio requires an output WAV path");
  }
  const duration = Number(options.duration ?? 1.6);
  if (!Number.isFinite(duration) || duration < 0.5 || duration > 6) {
    throw new RangeError("transition audio duration must be between 0.5 and 6 seconds");
  }

  const seed = normalizeSeed(options.seed, hash32("eidoverse:dandelion-portal:audio:v1"));
  const mix = createMix(duration, seed);
  const middle = duration * 0.5;

  addWhoosh(mix, {
    start: 0.02,
    duration: Math.max(0.3, duration * 0.76),
    gain: 0.16,
    panFrom: -0.78,
    panTo: 0.72,
    direction: "in"
  });
  addSub(mix, { start: middle - 0.19, duration: 0.72, fromHz: 72, toHz: 43, gain: 0.11 });
  addChime(mix, { start: middle - 0.08, midi: 74, duration: 1.25, gain: 0.13, pan: 0 });

  const sparkleNotes = [81, 86, 88, 93, 98];
  for (let i = 0; i < sparkleNotes.length; i += 1) {
    const spread = (i / Math.max(1, sparkleNotes.length - 1) - 0.5) * Math.min(0.8, duration * 0.38);
    addChime(mix, {
      start: middle + spread + mix.rng.range(-0.035, 0.035),
      midi: sparkleNotes[i],
      duration: Math.min(0.95, duration - middle - spread),
      gain: 0.055,
      pan: mix.rng.range(-0.82, 0.82)
    });
  }

  const levels = masterAndLimit(mix, 1.2);
  const absoluteOutput = path.resolve(outputPath);
  const wav = encodePcm16Wav(mix.left, mix.right, SAMPLE_RATE);
  await atomicWrite(absoluteOutput, wav);
  return {
    file: absoluteOutput,
    id: "dandelion-portal-transition",
    duration,
    sampleRate: SAMPLE_RATE,
    channels: CHANNELS,
    frames: mix.frames,
    bytes: wav.byteLength,
    seed,
    peak: levels.peak,
    peakDb: levels.peakDb,
    rmsDb: levels.rmsDb,
    beds: []
  };
}

function scoreLandsEnd(mix) {
  // A deep, patient marine drone (D aeolian) under an endless surf/wind wash;
  // glassy chimes ring as the light-wave winds inward, then a warm chord and a
  // spray of high bells bloom as the sea-lanterns lift off.
  addPad(mix, { start: 0, duration: 11.6, notes: [38, 45, 50, 57], gain: 0.05, pan: -0.05, brightness: 0.2 });
  addPad(mix, { start: 8.4, duration: 6.6, notes: [43, 50, 55, 62, 67], gain: 0.062, pan: 0.05, brightness: 0.52 });
  addAir(mix, { start: 0, duration: 15, gain: 0.032, panDrift: 0.6 });

  // distant foghorn swells
  addSub(mix, { start: 1.1, duration: 2.5, fromHz: 70, toHz: 57, gain: 0.08 });
  addSub(mix, { start: 6.0, duration: 2.6, fromHz: 66, toHz: 53, gain: 0.075 });

  // the walk-in: sparse glassy chimes climbing as the spiral lights
  const walkNotes = [69, 72, 76, 79, 81];
  for (let i = 0; i < walkNotes.length; i += 1) {
    addChime(mix, {
      start: 3.3 + i * 1.5,
      midi: walkNotes[i],
      duration: 1.7,
      gain: 0.05,
      pan: mix.rng.range(-0.5, 0.5)
    });
  }

  // the release: an upward swell + a rising spray of bells (lanterns climbing)
  addWhoosh(mix, { start: 10.45, duration: 2.3, gain: 0.075, panFrom: -0.45, panTo: 0.55, direction: "out" });
  addSub(mix, { start: 10.55, duration: 1.5, fromHz: 58, toHz: 92, gain: 0.06 });
  const bloom = [76, 81, 84, 88, 91, 96];
  for (let i = 0; i < bloom.length; i += 1) {
    addChime(mix, {
      start: 10.85 + i * 0.19 + mix.rng.range(-0.03, 0.03),
      midi: bloom[i],
      duration: 2.1,
      gain: 0.046,
      pan: mix.rng.range(-0.85, 0.85)
    });
  }
}

function scoreTwitterSummerShot(mix, shot) {
  const chords = [
    [45, 52, 57, 61, 64],
    [47, 54, 59, 62, 66],
    [48, 55, 60, 64, 69],
    [50, 57, 62, 66, 71],
    [52, 59, 64, 67, 71],
    [53, 60, 65, 69, 74],
    [50, 57, 62, 66, 71],
    [45, 52, 57, 61, 66, 73]
  ];
  const notes = chords[Math.max(0, Math.min(chords.length - 1, shot - 1))];
  addPad(mix, { start: 0, duration: 7.5, notes, gain: 0.052, pan: (shot % 2 ? -1 : 1) * 0.045, brightness: 0.36 + shot * 0.035 });
  addAir(mix, { start: 0, duration: 7.5, gain: 0.014, panDrift: 0.35 + shot * 0.045 });
  addChime(mix, { start: 0.42, midi: 72 + shot, duration: 1.5, gain: 0.045, pan: -0.28 });
  addChime(mix, { start: 3.18, midi: 79 + (shot % 5), duration: 1.75, gain: 0.052, pan: 0.3 });
  addChime(mix, { start: 6.32, midi: 84 + (shot % 4), duration: 1.1, gain: 0.04, pan: shot % 2 ? 0.42 : -0.42 });
  addWhoosh(mix, { start: 0.08, duration: 1.25, gain: 0.052, panFrom: -0.55, panTo: 0.25, direction: "out" });
  addWhoosh(mix, { start: 3.0, duration: 1.4, gain: 0.065, panFrom: shot % 2 ? 0.6 : -0.6, panTo: shot % 2 ? -0.5 : 0.5, direction: "in" });
  addWhoosh(mix, { start: 6.15, duration: 1.28, gain: 0.058, panFrom: -0.18, panTo: 0.58, direction: "out" });

  if ([1, 5, 7].includes(shot)) {
    addPropulsion(mix, { start: 0.35, duration: 7.0, fromHz: 55 + shot * 2, toHz: 104 + shot * 3, gain: 0.058 });
    addSub(mix, { start: 3.32, duration: 0.72, fromHz: 54, toHz: 38, gain: 0.075 });
  } else if ([2, 6].includes(shot)) {
    addFoley(mix, { start: 0.2, duration: 7.05, gain: 0.026, pan: 0, character: "board" });
    addPropulsion(mix, { start: 0.4, duration: 6.8, fromHz: 78, toHz: 132, gain: 0.046 });
  } else if (shot === 3) {
    addFoley(mix, { start: 0.15, duration: 7.1, gain: 0.023, pan: -0.08, character: "grass" });
  } else if (shot === 8) {
    addSub(mix, { start: 5.95, duration: 1.25, fromHz: 48, toHz: 33, gain: 0.095 });
  }
}

function scoreRoqnOpenRoad(mix) {
  addPad(mix, { start: 0, duration: 12.3, notes: [48, 55, 60, 64, 69], gain: 0.044, pan: -0.08, brightness: 0.38 });
  addPad(mix, { start: 11.5, duration: 12.8, notes: [50, 57, 62, 66, 71], gain: 0.049, pan: 0.08, brightness: 0.5 });
  addPad(mix, { start: 23.4, duration: 6.6, notes: [45, 52, 57, 61, 66, 73], gain: 0.064, pan: 0, brightness: 0.65 });
  addAir(mix, { start: 0, duration: 30, gain: 0.016, panDrift: 0.72 });

  const notes = [76, 81, 83, 88, 79, 86, 90, 83, 88, 93];
  const times = [0.6, 3.25, 5.1, 7.1, 10.1, 12.35, 15.25, 18.35, 21.15, 24.15];
  for (let i = 0; i < notes.length; i += 1) {
    addChime(mix, { start: times[i], midi: notes[i], duration: 1.55, gain: 0.046, pan: Math.sin(i * 1.3) * 0.55 });
  }

  addWhoosh(mix, { start: 0.08, duration: 1.5, gain: 0.055, panFrom: -0.6, panTo: 0.35, direction: "out" });
  addFoley(mix, { start: 0.2, duration: 5.6, gain: 0.024, pan: -0.08, character: "grass" });
  addWhoosh(mix, { start: 3.1, duration: 1.25, gain: 0.075, panFrom: 0.55, panTo: -0.45, direction: "in" });
  addSub(mix, { start: 4.5, duration: 0.9, fromHz: 52, toHz: 39, gain: 0.065 });

  addClick(mix, { start: 5.98, gain: 0.14, pan: -0.2, toneHz: 760 });
  addPropulsion(mix, { start: 6.02, duration: 5.85, fromHz: 72, toHz: 138, gain: 0.068 });
  addFoley(mix, { start: 6.05, duration: 5.8, gain: 0.026, pan: 0.05, character: "board" });
  addWhoosh(mix, { start: 8.65, duration: 1.25, gain: 0.06, panFrom: -0.5, panTo: 0.62, direction: "out" });

  addWhoosh(mix, { start: 11.72, duration: 1.1, gain: 0.048, panFrom: 0.4, panTo: -0.35, direction: "in" });
  addChime(mix, { start: 12.1, midi: 74, duration: 2.4, gain: 0.062, pan: -0.2 });
  addChime(mix, { start: 15.05, midi: 81, duration: 2.25, gain: 0.058, pan: 0.28 });

  addSub(mix, { start: 17.72, duration: 0.9, fromHz: 46, toHz: 58, gain: 0.08 });
  addWhoosh(mix, { start: 18, duration: 5.8, gain: 0.068, panFrom: -0.7, panTo: 0.72, direction: "out" });
  addFoley(mix, { start: 18.15, duration: 5.45, gain: 0.02, pan: 0, character: "grass" });
  addWhoosh(mix, { start: 21.25, duration: 1.15, gain: 0.085, panFrom: 0.65, panTo: -0.65, direction: "in" });

  addSub(mix, { start: 23.78, duration: 0.82, fromHz: 44, toHz: 67, gain: 0.105 });
  addPropulsion(mix, { start: 24, duration: 6, fromHz: 54, toHz: 98, gain: 0.075 });
  addWhoosh(mix, { start: 24.05, duration: 5.75, gain: 0.045, panFrom: -0.25, panTo: 0.32, direction: "out" });
  for (const [start, pan, midi] of [[26.6, -0.35, 86], [27.65, 0.38, 90], [28.55, -0.18, 93], [29.15, 0.22, 97]]) {
    addSub(mix, { start: start - 0.08, duration: Math.min(0.75, 30 - start + 0.08), fromHz: 58, toHz: 35, gain: 0.08 });
    addChime(mix, { start, midi, duration: Math.min(1.4, 30 - start), gain: 0.065, pan });
  }
}

function scoreHoverboard(mix) {
  // A restrained lydian bed leaves plenty of headroom for visual-detail SFX.
  addPad(mix, {
    start: 0,
    duration: 8.8,
    notes: [50, 57, 61, 66],
    gain: 0.052,
    pan: -0.08,
    brightness: 0.34
  });
  addPad(mix, {
    start: 8.55,
    duration: 6.45,
    notes: [45, 52, 57, 62, 66],
    gain: 0.063,
    pan: 0.06,
    brightness: 0.48
  });
  addAir(mix, { start: 0, duration: 15, gain: 0.018, panDrift: 0.45 });

  // 2.4s — shape: tactile click followed by one clean confirmation tone.
  addClick(mix, { start: 2.39, gain: 0.17, pan: -0.16, toneHz: 760 });
  addChime(mix, { start: 2.43, midi: 81, duration: 1.12, gain: 0.09, pan: -0.1 });

  // 4.8s — surface: a wider brushed shimmer, distinct from the shape click.
  addClick(mix, { start: 4.79, gain: 0.145, pan: 0.2, toneHz: 920 });
  addWhoosh(mix, {
    start: 4.7,
    duration: 0.82,
    gain: 0.058,
    panFrom: -0.22,
    panTo: 0.42,
    direction: "out"
  });
  addChime(mix, { start: 4.86, midi: 85, duration: 1.35, gain: 0.074, pan: 0.32 });

  // 7.1s — propulsion morph: wispy intake contracts into a comet-like core.
  addClick(mix, { start: 7.08, gain: 0.15, pan: 0, toneHz: 660 });
  addWhoosh(mix, {
    start: 6.98,
    duration: 2.36,
    gain: 0.12,
    panFrom: 0.58,
    panTo: -0.12,
    direction: "in"
  });
  addPropulsion(mix, { start: 7.14, duration: 2.28, fromHz: 82, toHz: 148, gain: 0.095 });
  addChime(mix, { start: 7.17, midi: 78, duration: 1.48, gain: 0.072, pan: -0.28 });

  // 9.4s ignition, 10s boost, 12.35s ollie, then the camera can breathe.
  addSub(mix, { start: 9.34, duration: 1.04, fromHz: 73, toHz: 42, gain: 0.19 });
  addPropulsion(mix, { start: 9.38, duration: 5.28, fromHz: 118, toHz: 174, gain: 0.105 });
  addWhoosh(mix, {
    start: 9.43,
    duration: 1.15,
    gain: 0.105,
    panFrom: -0.08,
    panTo: 0.18,
    direction: "out"
  });
  addWhoosh(mix, {
    start: 9.93,
    duration: 2.08,
    gain: 0.15,
    panFrom: -0.34,
    panTo: 0.62,
    direction: "out"
  });
  addSub(mix, { start: 9.97, duration: 0.82, fromHz: 62, toHz: 39, gain: 0.16 });
  addFoley(mix, { start: 10.74, duration: 1.12, gain: 0.045, pan: -0.28, character: "board" });

  addWhoosh(mix, {
    start: 12.21,
    duration: 1.46,
    gain: 0.12,
    panFrom: 0.35,
    panTo: -0.25,
    direction: "in"
  });
  addSub(mix, { start: 12.36, duration: 0.66, fromHz: 58, toHz: 45, gain: 0.12 });
  addChime(mix, { start: 12.41, midi: 88, duration: 1.62, gain: 0.068, pan: 0.12 });
  addChime(mix, { start: 13.54, midi: 81, duration: 1.3, gain: 0.052, pan: -0.38 });
  addChime(mix, { start: 13.69, midi: 86, duration: 1.2, gain: 0.048, pan: 0.4 });
}

function scoreAfterlight(mix) {
  // Two quiet harmonic fields crossfade as the grove moves from an intimate
  // human ritual into the open sky. The restrained mix leaves the luminous
  // motion room to carry the film while remaining precisely picture-locked.
  addPad(mix, {
    start: 0,
    duration: 8.2,
    notes: [45, 52, 57, 62],
    gain: 0.04,
    pan: -0.08,
    brightness: 0.2
  });
  addPad(mix, {
    start: 6.55,
    duration: 8.45,
    notes: [50, 57, 62, 66],
    gain: 0.052,
    pan: 0.08,
    brightness: 0.34
  });
  addAir(mix, { start: 0, duration: 15, gain: 0.012, panDrift: 0.42 });

  const returns = [
    [3, 74, -0.58],
    [3.72, 78, -0.24],
    [4.44, 81, 0.08],
    [5.16, 85, 0.35],
    [5.88, 88, 0.58]
  ];
  for (const [start, midi, pan] of returns) {
    addChime(mix, { start, midi, duration: 1.42, gain: 0.058, pan });
  }

  addWhoosh(mix, {
    start: 6.52,
    duration: 1.82,
    gain: 0.082,
    panFrom: 0.52,
    panTo: -0.36,
    direction: "in"
  });
  addSub(mix, { start: 6.66, duration: 1.16, fromHz: 58, toHz: 39, gain: 0.13 });
  addChime(mix, { start: 6.76, midi: 76, duration: 2.2, gain: 0.075, pan: 0 });

  addWhoosh(mix, {
    start: 7.06,
    duration: 3.3,
    gain: 0.112,
    panFrom: -0.42,
    panTo: 0.62,
    direction: "out"
  });
  addSub(mix, { start: 7.14, duration: 1.46, fromHz: 49, toHz: 33, gain: 0.16 });
  addChime(mix, { start: 9.38, midi: 69, duration: 2.6, gain: 0.052, pan: -0.22 });
  addChime(mix, { start: 11.7, midi: 81, duration: 2.2, gain: 0.046, pan: 0.34 });
  addChime(mix, { start: 13.45, midi: 86, duration: 1.5, gain: 0.04, pan: -0.12 });
}

function scoreDogPark(mix) {
  // Sunset harmony: warm, slow and deliberately quieter than the park bed.
  addPad(mix, {
    start: 0,
    duration: 11,
    notes: [48, 55, 59, 64],
    gain: 0.055,
    pan: -0.05,
    brightness: 0.27
  });
  addPad(mix, {
    start: 8.75,
    duration: 2.25,
    notes: [53, 57, 60, 67],
    gain: 0.044,
    pan: 0.08,
    brightness: 0.31
  });
  addAir(mix, { start: 0, duration: 11, gain: 0.012, panDrift: 0.25 });

  // Windup and release are readable, but soft enough to feel observed rather
  // than game-UI sweetened.
  addFoley(mix, { start: 2.18, duration: 1.18, gain: 0.07, pan: -0.18, character: "cloth" });
  addWhoosh(mix, {
    start: 2.96,
    duration: 1.16,
    gain: 0.12,
    panFrom: -0.34,
    panTo: 0.58,
    direction: "out"
  });
  addClick(mix, { start: 3.35, gain: 0.065, pan: -0.08, toneHz: 310 });

  addBallBounce(mix, { start: 4.16, gain: 0.17, pan: 0.44, pitchHz: 142 });
  addBallBounce(mix, { start: 4.83, gain: 0.105, pan: 0.12, pitchHz: 157 });
  addBallBounce(mix, { start: 5.18, gain: 0.06, pan: -0.14, pitchHz: 169 });

  // Paw patter is randomized but seeded. Three clustered passages mirror the
  // chase arc without turning every footfall into a metronome.
  addPawPatter(mix, { start: 4.47, duration: 1.45, gain: 0.085, panFrom: -0.25, panTo: 0.46 });
  addPawPatter(mix, { start: 6.08, duration: 1.52, gain: 0.075, panFrom: 0.4, panTo: -0.18 });
  addPawPatter(mix, { start: 7.82, duration: 1.34, gain: 0.064, panFrom: -0.04, panTo: 0.28 });
  addFoley(mix, { start: 6.72, duration: 1.05, gain: 0.048, pan: 0.35, character: "grass" });
  addFoley(mix, { start: 8.32, duration: 0.92, gain: 0.045, pan: -0.08, character: "grass" });

  addChime(mix, { start: 5.34, midi: 79, duration: 1.52, gain: 0.045, pan: 0.38 });
  addChime(mix, { start: 7.02, midi: 83, duration: 1.55, gain: 0.042, pan: -0.27 });
  addChime(mix, { start: 9.31, midi: 76, duration: 1.6, gain: 0.055, pan: -0.2 });
  addChime(mix, { start: 9.48, midi: 81, duration: 1.45, gain: 0.049, pan: 0.28 });
}

function scorePalaceReverie(mix) {
  // Blue-hour wash: slow pads, soft lamp chimes, a bloom swell at 11.2s.
  addPad(mix, {
    start: 0,
    duration: 15,
    notes: [45, 52, 57, 64],
    gain: 0.052,
    pan: -0.04,
    brightness: 0.24
  });
  addPad(mix, {
    start: 3.4,
    duration: 5.2,
    notes: [48, 55, 60],
    gain: 0.028,
    pan: 0.08,
    brightness: 0.2
  });
  addPad(mix, {
    start: 7.5,
    duration: 7.5,
    notes: [50, 57, 60, 69],
    gain: 0.045,
    pan: 0.06,
    brightness: 0.3
  });
  addAir(mix, { start: 0, duration: 15, gain: 0.016, panDrift: 0.36 });
  addAir(mix, { start: 10.8, duration: 4.2, gain: 0.012, panDrift: 0.5 });

  // Shore arrival breath
  addChime(mix, { start: 0.55, midi: 76, duration: 2.0, gain: 0.032, pan: -0.18 });
  addWhoosh(mix, {
    start: 3.35,
    duration: 1.2,
    gain: 0.055,
    panFrom: 0.35,
    panTo: -0.2,
    direction: "out"
  });

  // Lamp awaken chimes — staggered with visual cues
  addChime(mix, { start: 4.2, midi: 81, duration: 1.8, gain: 0.052, pan: -0.3 });
  addChime(mix, { start: 4.45, midi: 88, duration: 1.5, gain: 0.038, pan: 0.25 });
  addChime(mix, { start: 6.1, midi: 79, duration: 1.4, gain: 0.036, pan: 0.12 });
  addChime(mix, { start: 8.0, midi: 76, duration: 1.7, gain: 0.05, pan: 0.2 });
  addChime(mix, { start: 8.22, midi: 83, duration: 1.6, gain: 0.042, pan: -0.22 });
  addChime(mix, { start: 9.6, midi: 85, duration: 1.5, gain: 0.038, pan: -0.08 });
  addChime(mix, { start: 10.85, midi: 79, duration: 1.3, gain: 0.04, pan: 0.15 });

  addWhoosh(mix, {
    start: 10.85,
    duration: 1.7,
    gain: 0.11,
    panFrom: -0.45,
    panTo: 0.45,
    direction: "out"
  });
  addPad(mix, {
    start: 11.15,
    duration: 3.85,
    notes: [52, 57, 64, 69, 76],
    gain: 0.078,
    pan: 0,
    brightness: 0.42
  });
  addPad(mix, {
    start: 12.6,
    duration: 2.4,
    notes: [60, 67, 72],
    gain: 0.035,
    pan: 0.04,
    brightness: 0.3
  });
  addChime(mix, { start: 11.3, midi: 88, duration: 2.3, gain: 0.06, pan: -0.15 });
  addChime(mix, { start: 11.5, midi: 93, duration: 2.1, gain: 0.05, pan: 0.2 });
  addChime(mix, { start: 12.15, midi: 95, duration: 1.8, gain: 0.034, pan: 0.05 });
  addChime(mix, { start: 13.4, midi: 81, duration: 1.6, gain: 0.044, pan: 0.05 });
  addChime(mix, { start: 14.15, midi: 76, duration: 1.0, gain: 0.03, pan: -0.1 });
  addChime(mix, { start: 14.45, midi: 69, duration: 0.7, gain: 0.022, pan: 0.08 });
}

function createMix(duration, seed) {
  const frames = Math.round(duration * SAMPLE_RATE);
  return {
    duration,
    frames,
    left: new Float32Array(frames),
    right: new Float32Array(frames),
    rng: createRng(seed)
  };
}

function addPad(mix, options) {
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + options.duration);
  const attack = Math.min(1.25, options.duration * 0.24);
  const release = Math.min(1.65, options.duration * 0.3);
  const brightness = clamp(options.brightness ?? 0.35, 0, 1);

  for (let noteIndex = 0; noteIndex < options.notes.length; noteIndex += 1) {
    const frequency = midiToHz(options.notes[noteIndex]);
    const voicePan = clamp((options.pan ?? 0) + (noteIndex - (options.notes.length - 1) / 2) * 0.18, -0.82, 0.82);
    const [panL, panR] = panGains(voicePan);
    let phase = mix.rng.range(0, Math.PI * 2);
    let detunedPhase = phase * 1.17;
    const driftPhase = mix.rng.range(0, Math.PI * 2);
    const detune = mix.rng.range(0.996, 1.004);
    const voiceGain = options.gain / Math.sqrt(options.notes.length);

    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const local = (frame - startFrame) / SAMPLE_RATE;
      const envelope = cosineEnvelope(local, options.duration, attack, release);
      const drift = 1 + 0.003 * Math.sin(local * 0.47 + driftPhase);
      phase += Math.PI * 2 * frequency * drift / SAMPLE_RATE;
      detunedPhase += Math.PI * 2 * frequency * detune * drift / SAMPLE_RATE;
      const tone =
        Math.sin(phase) * 0.72 +
        Math.sin(detunedPhase) * 0.2 +
        Math.sin(phase * 2.002 + driftPhase * 0.41) * (0.035 + brightness * 0.055) +
        Math.sin(phase * 3.003 + driftPhase * 1.73) * brightness * 0.018;
      const movement = 0.83 + 0.17 * Math.sin(local * 0.73 + driftPhase);
      const sample = tone * envelope * movement * voiceGain;
      mix.left[frame] += sample * panL;
      mix.right[frame] += sample * panR;
    }
  }
}

function addChime(mix, options) {
  const duration = Math.max(0.04, Math.min(options.duration, mix.duration - options.start));
  if (duration <= 0) return;
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + duration);
  const frequency = midiToHz(options.midi);
  const [panL, panR] = panGains(options.pan ?? 0);
  const partials = [1, 2.008, 3.982, 6.09];
  const partialGains = [1, 0.31, 0.12, 0.045];
  const phases = partials.map(() => mix.rng.range(0, Math.PI * 2));

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const attack = smoothstep(0, 0.008, local);
    let tone = 0;
    for (let p = 0; p < partials.length; p += 1) {
      const decay = Math.exp(-local * (2.15 + p * 1.42));
      tone += Math.sin(Math.PI * 2 * frequency * partials[p] * local + phases[p]) * partialGains[p] * decay;
    }
    const shimmerPan = Math.sin(local * 3.1) * 0.06;
    const sample = tone * attack * options.gain;
    mix.left[frame] += sample * (panL - shimmerPan);
    mix.right[frame] += sample * (panR + shimmerPan);
  }
}

function addClick(mix, options) {
  const duration = 0.135;
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + duration);
  const [panL, panR] = panGains(options.pan ?? 0);
  let low = 0;
  let previousLow = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const noise = mix.rng.signed();
    low += (noise - low) * 0.24;
    const high = low - previousLow;
    previousLow = low;
    const transient = Math.exp(-local * 95) * high * 1.8;
    const body = Math.sin(Math.PI * 2 * options.toneHz * local) * Math.exp(-local * 31) * 0.48;
    const sample = (transient + body) * options.gain;
    mix.left[frame] += sample * panL;
    mix.right[frame] += sample * panR;
  }
}

function addWhoosh(mix, options) {
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + options.duration);
  let fast = 0;
  let slow = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const progress = clamp01(local / options.duration);
    const shaped = options.direction === "in"
      ? Math.pow(Math.sin(Math.PI * progress), 1.25) * (0.55 + progress * 0.45)
      : Math.pow(Math.sin(Math.PI * progress), 1.18) * (1 - progress * 0.24);
    const sweep = options.direction === "in" ? progress : 1 - progress;
    const noise = mix.rng.signed();
    const fastAlpha = 0.035 + sweep * 0.19;
    const slowAlpha = 0.006 + sweep * 0.045;
    fast += (noise - fast) * fastAlpha;
    slow += (noise - slow) * slowAlpha;
    const airyBand = (fast - slow) * 2.05;
    const pan = lerp(options.panFrom ?? 0, options.panTo ?? 0, smoothstep(0, 1, progress));
    const [panL, panR] = panGains(pan);
    const sample = airyBand * shaped * options.gain;
    mix.left[frame] += sample * panL;
    mix.right[frame] += sample * panR;
  }
}

function addSub(mix, options) {
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + options.duration);
  let phase = mix.rng.range(0, Math.PI * 2);

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const progress = clamp01(local / options.duration);
    const frequency = lerp(options.fromHz, options.toHz, smoothstep(0, 1, progress));
    phase += Math.PI * 2 * frequency / SAMPLE_RATE;
    const envelope = Math.pow(Math.sin(Math.PI * progress), 0.72);
    const sample = (Math.sin(phase) + Math.sin(phase * 2) * 0.08) * envelope * options.gain;
    mix.left[frame] += sample * 0.707;
    mix.right[frame] += sample * 0.707;
  }
}

function addPropulsion(mix, options) {
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + options.duration);
  let phase = mix.rng.range(0, Math.PI * 2);
  let noiseLow = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const progress = clamp01(local / options.duration);
    const frequency = lerp(options.fromHz, options.toHz, smoothstep(0, 1, progress));
    phase += Math.PI * 2 * frequency / SAMPLE_RATE;
    noiseLow += (mix.rng.signed() - noiseLow) * (0.025 + progress * 0.025);
    const envelope = cosineEnvelope(local, options.duration, 0.12, 0.36);
    const pulse = 0.84 + 0.16 * Math.sin(local * Math.PI * 2 * (5.1 + progress * 2.2));
    const tonal = Math.sin(phase) * 0.52 + Math.sin(phase * 2.01) * 0.2 + Math.sin(phase * 3.98) * 0.06;
    const sample = (tonal + noiseLow * 0.55) * envelope * pulse * options.gain;
    const width = Math.sin(local * 2.7) * 0.12;
    mix.left[frame] += sample * (0.7 - width);
    mix.right[frame] += sample * (0.7 + width);
  }
}

function addFoley(mix, options) {
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + options.duration);
  const [panL, panR] = panGains(options.pan ?? 0);
  const rate = options.character === "grass" ? 19 : options.character === "board" ? 8.5 : 5.8;
  const color = options.character === "grass" ? 0.17 : options.character === "board" ? 0.055 : 0.09;
  let low = 0;
  let slower = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const progress = clamp01(local / options.duration);
    const noise = mix.rng.signed();
    low += (noise - low) * color;
    slower += (noise - slower) * color * 0.16;
    const texture = options.character === "board" ? slower : low - slower;
    const gesture = 0.34 + 0.66 * Math.pow(0.5 + 0.5 * Math.sin(local * Math.PI * 2 * rate + 0.7), 2.3);
    const envelope = Math.pow(Math.sin(Math.PI * progress), 0.8);
    const sample = texture * gesture * envelope * options.gain;
    mix.left[frame] += sample * panL;
    mix.right[frame] += sample * panR;
  }
}

function addBallBounce(mix, options) {
  const duration = 0.28;
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + duration);
  const [panL, panR] = panGains(options.pan ?? 0);
  let phase = 0;
  let low = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const frequency = options.pitchHz * (1 + Math.exp(-local * 22) * 0.7);
    phase += Math.PI * 2 * frequency / SAMPLE_RATE;
    low += (mix.rng.signed() - low) * 0.08;
    const rubber = Math.sin(phase) * Math.exp(-local * 17);
    const contact = low * Math.exp(-local * 82) * 0.85;
    const sample = (rubber + contact) * options.gain;
    mix.left[frame] += sample * panL;
    mix.right[frame] += sample * panR;
  }
}

function addPawPatter(mix, options) {
  let time = options.start;
  const end = options.start + options.duration;
  let step = 0;
  while (time < end) {
    const progress = clamp01((time - options.start) / options.duration);
    const pan = lerp(options.panFrom, options.panTo, progress) + mix.rng.range(-0.1, 0.1);
    addSoftThump(mix, {
      start: time,
      gain: options.gain * mix.rng.range(0.7, 1),
      pan,
      pitchHz: mix.rng.range(92, 138)
    });
    step += 1;
    time += mix.rng.range(0.115, 0.17) + (step % 4 === 0 ? 0.045 : 0);
  }
}

function addSoftThump(mix, options) {
  const duration = 0.105;
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + duration);
  const [panL, panR] = panGains(options.pan ?? 0);
  let phase = 0;
  let low = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    phase += Math.PI * 2 * options.pitchHz / SAMPLE_RATE;
    low += (mix.rng.signed() - low) * 0.05;
    const sample = (Math.sin(phase) * 0.55 + low * 0.7) * Math.exp(-local * 42) * options.gain;
    mix.left[frame] += sample * panL;
    mix.right[frame] += sample * panR;
  }
}

function addAir(mix, options) {
  const startFrame = frameAt(mix, options.start);
  const endFrame = frameAt(mix, options.start + options.duration);
  let fastL = 0;
  let slowL = 0;
  let fastR = 0;
  let slowR = 0;

  for (let frame = startFrame; frame < endFrame; frame += 1) {
    const local = (frame - startFrame) / SAMPLE_RATE;
    const progress = clamp01(local / options.duration);
    const envelope = cosineEnvelope(local, options.duration, 0.75, 0.75);
    const gust = 0.62 + 0.38 * Math.pow(0.5 + 0.5 * Math.sin(local * 0.91 + 1.4), 2);
    fastL += (mix.rng.signed() - fastL) * 0.035;
    slowL += (fastL - slowL) * 0.004;
    fastR += (mix.rng.signed() - fastR) * 0.035;
    slowR += (fastR - slowR) * 0.004;
    const drift = Math.sin(progress * Math.PI * 2) * (options.panDrift ?? 0);
    mix.left[frame] += (fastL - slowL) * envelope * gust * options.gain * (1 - drift * 0.2);
    mix.right[frame] += (fastR - slowR) * envelope * gust * options.gain * (1 + drift * 0.2);
  }
}

function mixNatureBed(mix, bed, index) {
  const requestedPath = typeof bed?.path === "string" ? bed.path : "";
  const volume = clamp(Number.isFinite(bed?.volume) ? Number(bed.volume) : 0.04, 0, 0.35);
  const resolvedPath = resolveBedPath(requestedPath);
  const report = { path: resolvedPath ?? requestedPath, volume, mixed: false };

  if (!resolvedPath) {
    report.reason = "file not found";
    return report;
  }

  const offset = Number.isFinite(bed?.offset) ? Math.max(0, Number(bed.offset)) : 7.5 + index * 8.25;
  const decoded = decodeBedWithFfmpeg(resolvedPath, mix.duration, offset);
  if (!decoded.samples) {
    report.reason = decoded.reason;
    return report;
  }

  const sampleFrames = Math.min(mix.frames, Math.floor(decoded.samples.length / 2));
  for (let frame = 0; frame < sampleFrames; frame += 1) {
    const time = frame / SAMPLE_RATE;
    const fade = cosineEnvelope(time, mix.duration, 0.65, 0.8);
    const bedL = decoded.samples[frame * 2] || 0;
    const bedR = decoded.samples[frame * 2 + 1] || 0;
    mix.left[frame] += bedL * fade * volume;
    mix.right[frame] += bedR * fade * volume;
  }
  report.mixed = true;
  return report;
}

function decodeBedWithFfmpeg(inputPath, duration, offset) {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel", "error",
      "-stream_loop", "-1",
      "-i", inputPath,
      "-ss", offset.toFixed(3),
      "-t", duration.toFixed(6),
      "-vn",
      "-ac", String(CHANNELS),
      "-ar", String(SAMPLE_RATE),
      "-f", "f32le",
      "pipe:1"
    ],
    {
      encoding: null,
      maxBuffer: Math.ceil(duration * SAMPLE_RATE * CHANNELS * 4 + 1_048_576)
    }
  );

  if (result.error) {
    return { samples: null, reason: `ffmpeg unavailable: ${result.error.message}` };
  }
  if (result.status !== 0 || !result.stdout?.length) {
    const detail = result.stderr?.toString("utf8").trim();
    return { samples: null, reason: detail ? `ffmpeg decode failed: ${detail}` : "ffmpeg decode failed" };
  }
  const byteLength = result.stdout.byteLength - (result.stdout.byteLength % 4);
  const exactBytes = result.stdout.buffer.slice(
    result.stdout.byteOffset,
    result.stdout.byteOffset + byteLength
  );
  return { samples: new Float32Array(exactBytes) };
}

function resolveBedPath(input) {
  if (!input) return null;
  const candidates = path.isAbsolute(input)
    ? [input]
    : [path.resolve(process.cwd(), input), path.resolve(PROJECT_ROOT, input)];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function masterAndLimit(mix, makeupGain = 1) {
  // Remove tiny DC offsets introduced by filtered noise before dynamics.
  highPassDc(mix.left);
  highPassDc(mix.right);

  // A mild saturating bus rounds stacked transients. A final scalar limiter is
  // intentionally transparent and guarantees ample AAC/video-encode headroom.
  const drive = 1.18;
  const driveNorm = Math.tanh(drive);
  let peak = 0;
  for (let frame = 0; frame < mix.frames; frame += 1) {
    const edgeFade = edgeEnvelope(frame / SAMPLE_RATE, mix.duration);
    const left = Math.tanh(mix.left[frame] * drive) / driveNorm * edgeFade * makeupGain;
    const right = Math.tanh(mix.right[frame] * drive) / driveNorm * edgeFade * makeupGain;
    mix.left[frame] = left;
    mix.right[frame] = right;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }

  const limiterGain = peak > TARGET_PEAK ? TARGET_PEAK / peak : 1;
  let sumSquares = 0;
  peak = 0;
  for (let frame = 0; frame < mix.frames; frame += 1) {
    const left = mix.left[frame] * limiterGain;
    const right = mix.right[frame] * limiterGain;
    mix.left[frame] = left;
    mix.right[frame] = right;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
    sumSquares += left * left + right * right;
  }

  const rms = Math.sqrt(sumSquares / (mix.frames * CHANNELS));
  return {
    peak: round(peak, 6),
    peakDb: round(linearToDb(peak), 2),
    rmsDb: round(linearToDb(rms), 2)
  };
}

function highPassDc(channel) {
  let previousInput = 0;
  let previousOutput = 0;
  // ~3.8 Hz at 48 kHz: enough to remove DC without thinning intentional sub.
  const coefficient = 0.9995;
  for (let i = 0; i < channel.length; i += 1) {
    const input = channel[i];
    const output = input - previousInput + coefficient * previousOutput;
    channel[i] = output;
    previousInput = input;
    previousOutput = output;
  }
}

function edgeEnvelope(time, duration) {
  const fadeIn = smoothstep(0, Math.min(0.055, duration * 0.1), time);
  const fadeOut = 1 - smoothstep(Math.max(0, duration - 0.09), duration, time);
  return fadeIn * fadeOut;
}

function encodePcm16Wav(left, right, sampleRate) {
  const frames = Math.min(left.length, right.length);
  const bytesPerSample = 2;
  const blockAlign = CHANNELS * bytesPerSample;
  const dataBytes = frames * blockAlign;
  const wav = Buffer.allocUnsafe(44 + dataBytes);

  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(CHANNELS, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * blockAlign, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bytesPerSample * 8, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    wav.writeInt16LE(floatToPcm16(left[frame]), offset);
    wav.writeInt16LE(floatToPcm16(right[frame]), offset + 2);
    offset += blockAlign;
  }
  return wav;
}

async function atomicWrite(outputPath, data) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.tmp-${process.pid}`;
  await writeFile(temporary, data);
  await rename(temporary, outputPath);
}

function floatToPcm16(value) {
  const clamped = clamp(value, -1, 1);
  return clamped < 0 ? Math.round(clamped * 32_768) : Math.round(clamped * PCM_MAX);
}

function frameAt(mix, seconds) {
  return clamp(Math.round(seconds * SAMPLE_RATE), 0, mix.frames);
}

function cosineEnvelope(time, duration, attack, release) {
  const attackGain = attack > 0 ? 0.5 - 0.5 * Math.cos(Math.PI * clamp01(time / attack)) : 1;
  const remaining = duration - time;
  const releaseGain = release > 0 ? 0.5 - 0.5 * Math.cos(Math.PI * clamp01(remaining / release)) : 1;
  return attackGain * releaseGain;
}

function panGains(pan) {
  const normalized = (clamp(pan, -1, 1) + 1) * Math.PI * 0.25;
  return [Math.cos(normalized), Math.sin(normalized)];
}

function midiToHz(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value < edge0 ? 0 : 1;
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function linearToDb(value) {
  return value > 0 ? 20 * Math.log10(value) : -Infinity;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function normalizeSeed(seed, fallback) {
  if (typeof seed !== "number" || !Number.isFinite(seed)) return fallback >>> 0;
  return Math.trunc(seed) >>> 0;
}

function hash32(text) {
  let hash = 2_166_136_261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function createRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    signed: () => next() * 2 - 1,
    range: (min, max) => min + (max - min) * next()
  };
}
