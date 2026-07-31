const DEFAULTS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 60,
  frameFormat: "png",
  jpegQuality: 95,
  crf: 15,
  fastBitrate: 24_000_000,
  take: "master",
  settleFrames: 48,
  settleGapMs: 35
});

const DEFINITIONS = Object.freeze({
  afterlight: Object.freeze({
    id: "afterlight",
    demo: "afterlight",
    title: "Afterlight at Buena Vista",
    duration: 15,
    seed: 0x41_46_54_52,
    posterAt: 12.4,
    stillTimes: Object.freeze([0.35, 1.5, 2.2, 3.05, 4.5, 5.9, 6.78, 7.35, 8.55, 10.3, 12.4, 14.55]),
    audio: Object.freeze({
      profile: "afterlight",
      description: "A quiet loom, five returning echoes, and the breath of a whale above the canopy."
    })
  }),
  hoverboard: Object.freeze({
    id: "hoverboard",
    demo: "hoverboard",
    title: "Hoverboard Customization",
    duration: 15,
    seed: 0x48_4f_56_52,
    posterAt: 8.4,
    stillTimes: Object.freeze([0.35, 1.8, 3.45, 5.4, 7.15, 9.25, 10.8, 12.35, 13.7, 14.65]),
    audio: Object.freeze({
      profile: "hoverboard",
      description: "Airy workshop UI, propulsion transformations, and a warm launch payoff."
    })
  }),
  "dog-park": Object.freeze({
    id: "dog-park",
    demo: "dog-park",
    title: "Sunset Fetch at Corona Heights",
    duration: 11,
    seed: 0x44_4f_47_53,
    posterAt: 7.1,
    stillTimes: Object.freeze([0.3, 1.45, 2.7, 4.05, 5.35, 6.65, 7.9, 9.1, 10.45]),
    audio: Object.freeze({
      profile: "dog-park",
      description: "Golden-hour park ambience, a playful throw, paws, panting, and soft city air."
    })
  }),
  "palace-reverie": Object.freeze({
    id: "palace-reverie",
    demo: "palace-reverie",
    title: "Palace Reverie · Blue Hour",
    duration: 15,
    seed: 0x50_46_41_52,
    posterAt: 14.0,
    stillTimes: Object.freeze([0.6, 2.2, 4.4, 5.9, 8.4, 10.2, 11.8, 13.0, 14.0, 14.7]),
    audio: Object.freeze({
      profile: "palace-reverie",
      description:
        "Blue-hour pads, lagoon hush, staggered lamp chimes, and a bloom swell when the palace remembers."
    })
  }),
  landsend: Object.freeze({
    id: "landsend",
    demo: "landsend",
    title: "The Lands End Labyrinth",
    duration: 15,
    seed: 0x4c_41_4e_44,
    posterAt: 12.4,
    stillTimes: Object.freeze([0.4, 2.2, 3.8, 5.6, 7.2, 8.9, 10.9, 12.4, 13.8, 14.7]),
    audio: Object.freeze({
      profile: "landsend",
      description: "Marine drone and surf, glassy chimes as the spiral lights, a warm bloom as the lanterns rise."
    })
  }),
  "roqn-open-road": Object.freeze({
    id: "roqn-open-road",
    demo: "roqn-open-road",
    title: "Open Road, Open Sky",
    duration: 30,
    seed: 0x4f_50_45_4e,
    posterAt: 28.4,
    stillTimes: Object.freeze([0.4, 1.8, 3.4, 5.2, 6.4, 8.1, 9.5, 11.4, 12.4, 14.2, 15.5, 17.3, 18.4, 20.1, 21.5, 23.3, 24.5, 26.2, 27.7, 29.4]),
    audio: Object.freeze({
      profile: "roqn-open-road",
      description: "An airy travel score moving from garden wings to city streets, bridge wind, speedboat wake, and a bay-light finale."
    })
  }),
  "surf-aerial": Object.freeze({
    id: "surf-aerial",
    demo: "surf-aerial",
    title: "Ocean Beach Aerial",
    duration: 10,
    seed: 0x53_55_52_46,
    posterAt: 3.6,
    stillTimes: Object.freeze([0.3, 1.35, 2.2, 2.8, 3.35, 4.05, 4.8, 5.8, 6.9, 8.0, 9.0, 9.7]),
    audio: Object.freeze({
      profile: "surf-aerial",
      description: "Pacific rush, lip takeoff, one airy rotation, and a clean rail landing."
    })
  }),
  "phoenix-palace-flyby": Object.freeze({
    id: "phoenix-palace-flyby",
    demo: "phoenix-palace-flyby",
    title: "Phoenix over the Palace",
    duration: 5,
    seed: 0x50_48_58_46,
    posterAt: 2.75,
    stillTimes: Object.freeze([0.2, 0.95, 1.75, 2.45, 2.85, 3.25, 4.15, 4.8]),
    audio: Object.freeze({
      profile: "phoenix-palace-flyby",
      description: "Sunset air, powerful wingbeats, an axial roll whoosh, and a warm Palace resolve."
    })
  }),
  ...Object.fromEntries([
    [1, "Ocean Beach Sunrise Surf"],
    [2, "Golden Gate Scooter Ribbon"],
    [3, "Presidio Phoenix Canopy"],
    [4, "Palace Drone Orbit"],
    [5, "Embarcadero Sports-Car Chase"],
    [6, "Botanical Hoverboard Bloom"],
    [7, "Bay Bridge Speedboat Blue Hour"],
    [8, "Downtown Drone Constellation"]
  ].map(([index, title]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `twitter-summer-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 7.5,
      seed: (0x54_57_00_00 + index * 0x101) >>> 0,
      posterAt: 5.8,
      stillTimes: Object.freeze([0.25, 1.35, 2.65, 3.85, 5.05, 6.25, 7.2]),
      audio: Object.freeze({
        profile: "twitter-summer",
        index,
        description: `Movement ${index} of the continuous summer-city score.`
      })
    })];
  })),
  ...Object.fromEntries([
    [1, "Ocean Beach Kites · The Whole Beach"],
    [2, "Ocean Beach Kites · Two Sunwheels"],
    [3, "Ocean Beach Kites · The Centipede"],
    [4, "Ocean Beach Kites · Running the Sand"],
    [5, "Ocean Beach Kites · Blue Hour"],
    [6, "Ocean Beach Kites · From Above"],
    [7, "Ocean Beach Kites · Full Rays"],
    [8, "Ocean Beach Kites · Clear Dusk"],
    [9, "Ocean Beach Kites · The Descent"],
    [10, "Ocean Beach Kites · Around the Pair"],
    [11, "Ocean Beach Kites · Sun on the Water"],
    [12, "Ocean Beach Kites · The Last Shafts"],
    [13, "Ocean Beach Kites · Civil Twilight"],
    [14, "Ocean Beach Kites · After the Light"],
    [15, "Ocean Beach Kites · Nautical"],
    [16, "Ocean Beach Kites · The Line"],
    [17, "Ocean Beach Kites · Two on the Sand"],
    [18, "Ocean Beach Kites · Night Flyers"]
  ].map(([index, title]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `ocean-beach-kite-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 10,
      seed: (0x4b_49_54_00 + index * 0x101) >>> 0,
      posterAt: 6.4,
      stillTimes: Object.freeze([0.3, 1.6, 3.1, 4.6, 6.1, 7.6, 9.2]),
      audio: Object.freeze({
        profile: "ocean-beach-kite",
        index,
        description: `Sunset onshore wind, surf wash and kite fabric — look ${index} of eighteen.`
      })
    })];
  })),
  // The eclipse set: seven seconds each, the sun held inside the sunwheel's hub.
  ...Object.fromEntries([
    [1, "Ocean Beach Kites · The Eye"],
    [2, "Ocean Beach Kites · Through the Wheel"],
    [3, "Ocean Beach Kites · Star Axis"],
    [4, "Ocean Beach Kites · Into Line"],
    [5, "Ocean Beach Kites · Last Ring"]
  ].map(([index, title]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `ocean-beach-kite-ring-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 7,
      seed: (0x52_49_4e_00 + index * 0x101) >>> 0,
      posterAt: 4.6,
      stillTimes: Object.freeze([0.3, 1.4, 2.6, 3.8, 5, 6.2, 6.8]),
      audio: Object.freeze({
        profile: "ocean-beach-kite-ring",
        index,
        description: `The sun held inside the sunwheel — eclipse look ${index} of five.`
      })
    })];
  })),
  // The dusk set: seven seconds each, mostly past sunset, and the five that
  // move the camera rather than the clock.
  ...Object.fromEntries([
    [1, "Ocean Beach Kites · Down the Line"],
    [2, "Ocean Beach Kites · Level with the Flock"],
    [3, "Ocean Beach Kites · Over the Shoulder"],
    [4, "Ocean Beach Kites · The Long Band"],
    [5, "Ocean Beach Kites · Under the Wing"]
  ].map(([index, title]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `ocean-beach-kite-dusk-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 7,
      seed: (0x44_53_4b_00 + index * 0x101) >>> 0,
      posterAt: 4.4,
      stillTimes: Object.freeze([0.3, 1.4, 2.6, 3.8, 5, 6.2, 6.8]),
      audio: Object.freeze({
        profile: "ocean-beach-kite-dusk",
        index,
        description: `Late sunset into twilight — dusk look ${index} of five.`
      })
    })];
  })),
  // The twenty-second surf films. Longer than anything else in the kite
  // family because the thing they are about has a sixteen-second period: a ten
  // second clip of Ocean Beach catches one wave, and the point of these is a
  // set arriving, breaking and washing out while the festival flies over it.
  ...Object.fromEntries([
    [1, "Ocean Beach Surf · The Set", "A crane off the break: wave height to fifteen metres while a set goes off under the whole festival."],
    [2, "Ocean Beach Surf · The Waterline", "Head height at the water's edge, tracking the beach as flyer after flyer crosses the sun."],
    [3, "Ocean Beach Surf · The Gulls", "The waterline again with the disc still on the water, tracking back as gulls work the air over the break."],
    [4, "Ocean Beach Surf · The Prism", "A low crane over the dry sand as the prism kite splits the last of the sun and lays a spectrum on the beach."]
  ].map(([index, title, description]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `ocean-beach-surf-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 20,
      seed: (0x53_52_46_00 + index * 0x101) >>> 0,
      posterAt: 13.2,
      stillTimes: Object.freeze([0.3, 2.4, 4.8, 7.2, 9.6, 12, 14.4, 16.8, 19.2]),
      audio: Object.freeze({
        profile: "ocean-beach-surf",
        index,
        description
      })
    })];
  })),
  // The prism set: the one kite that disperses rather than occludes, all four
  // cut for the half hour either side of the sun touching the water. Stills are
  // spread evenly because the move is continuous throughout — there is no
  // single event to weight them toward.
  //
  // 01/02 run fifteen seconds and carry a score. 03/04 run twenty and carry no
  // score at all: wind, the sets coming in, and the sail. Those two are the
  // only productions here with an empty cue plan, which is deliberate — there
  // is nothing for a cue to be locked to when nothing is being played.
  ...Object.fromEntries([
    [1, "Ocean Beach Kites · The Prism"],
    [2, "Ocean Beach Kites · Where It Lands"],
    [3, "Ocean Beach Kites · What Lands on the Sand"],
    [4, "Ocean Beach Kites · Opening the Fan"]
  ].map(([index, title]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `ocean-beach-kite-prism-${suffix}`;
    const scored = index <= 2;
    const duration = scored ? 15 : 20;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration,
      seed: (0x50_52_4d_00 + index * 0x101) >>> 0,
      posterAt: scored ? 9.8 : 13.6,
      stillTimes: Object.freeze(
        scored
          ? [0.3, 2.1, 4, 5.9, 7.8, 9.7, 11.6, 13.4, 14.7]
          : [0.3, 2.6, 5.2, 7.8, 10.4, 13, 15.6, 18.2, 19.7]
      ),
      audio: Object.freeze({
        profile: scored ? "ocean-beach-kite-prism" : "ocean-beach-kite-prism-wind",
        index,
        // The real wind recording under the synthesized surf. Two takes of the
        // same file at different offsets and pans, because one is audibly one.
        beds: scored
          ? undefined
          : Object.freeze([
              Object.freeze({ path: "public/audio/nature/wind-grass.mp3", volume: 0.13, offset: 6.4 + index * 5.5 }),
              Object.freeze({ path: "public/audio/nature/wind-tree.mp3", volume: 0.075, offset: 19.2 + index * 3.1 })
            ]),
        description: scored
          ? `Sunset wind and surf under a dispersed spectrum — prism look ${index} of four.`
          : `No score: onshore wind, breaking sets and ripstop only — prism look ${index} of four.`
      })
    })];
  })),
  // The deep-sunset set: five twenty-second films built around three things at
  // once — the prism kite as the hero of the flock, its spectrum lying soft on
  // the sand, and the surf actually breaking on camera. These are the first
  // productions with a PINNED sea clock (see setSeaTimePin): each film bakes a
  // T0 chosen by tools/cinematic/surfSchedule.mjs so a set goes off early in
  // the take and a bigger one goes off late, and the soundtrack's crash stems
  // are placed at those exact seconds rather than at plausible ones.
  ...Object.fromEntries([
    [1, "Ocean Beach Sunset · The Court", "The flock gathered loosely around the prism, its spectrum breathing on the sand between them."],
    [2, "Ocean Beach Sunset · Where It Dances", "Head height on the wet sand, the rainbow lying across the beach and moving like water."],
    [3, "Ocean Beach Sunset · The Set Goes Off", "At wave height as a set stands up, throws and walks in under the whole festival."],
    [4, "Ocean Beach Sunset · The Long Band", "Telephoto compression: kites, stacked breakers and the last band of light in one plane."],
    [5, "Ocean Beach Sunset · Afterglow", "Under the flock as the light goes, the last set heard more than seen."]
  ].map(([index, title, description]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `ocean-beach-sunset-${suffix}`;
    // The Court runs thirty-five seconds — the hero film earned the longer
    // cut, and then five more so its closing crash finishes on camera. Its
    // stills hit the solved beats: set one at ~6.8, the swash sheet wetting
    // the sand through the rainbow lull, the climax at 26–27.2, and the
    // whitewater rolling in through the aftermath.
    const hero = index === 1;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: hero ? 35 : 20,
      seed: (0x53_4e_53_00 + index * 0x101) >>> 0,
      posterAt: hero ? 28.4 : 16.6,
      stillTimes: Object.freeze(
        hero
          ? [0.3, 6.8, 12, 18.8, 24, 27, 28.6, 31, 33.6]
          : [0.3, 2.4, 4.8, 7.2, 9.6, 12, 14.4, 16.9, 19.2]
      ),
      audio: Object.freeze({
        profile: "ocean-beach-sunset",
        index,
        description
      })
    })];
  })),
  // The two travelling shots: kite festival to Sutro Baths in one unbroken move.
  // Fifteen seconds each, and the stills are weighted toward the back half
  // because that is where the shot changes — the beach run is one continuous
  // idea, the crossing and the hall interior are four.
  ...Object.fromEntries([
    [1, "Ocean Beach Kites · Over the Headland"],
    [2, "Ocean Beach Kites · In From the Sea"]
  ].map(([index, title]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `kite-to-sutro-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 15,
      seed: (0x46_4c_59_00 + index * 0x101) >>> 0,
      posterAt: 12.6,
      stillTimes: Object.freeze([0.3, 2.2, 4.6, 7.4, 9.6, 11.2, 12.4, 13.4, 14.6]),
      audio: Object.freeze({
        profile: "kite-to-sutro",
        index,
        description: `Onshore wind and surf carried into the bath hall — flight ${index} of two.`
      })
    })];
  })),
  // Five seconds each, inside the restored hall, at a standing person's eye
  // height. No avatar, no camera move to speak of — one held look per moment.
  ...Object.fromEntries([
    [1, "Sutro Baths · Still Water", "Someone floating in the great plunge, watched from the coping."],
    [2, "Sutro Baths · The Long View", "Two on the window bench, the Pacific going down in front of them."],
    [3, "Sutro Baths · Tea in the Windows", "Three at tea in the ocean gallery, lamp lit, sunset behind."],
    [4, "Sutro Baths · The Hot Bath", "Two talking chest-deep in the hot bath, steam off the water."],
    [5, "Sutro Baths · The Plunge Edge", "Two sitting with their feet in the plunge, candles down the coping."]
  ].map(([index, title, description]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `sutro-moment-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 5,
      seed: (0x53_55_54_00 + index * 0x101) >>> 0,
      posterAt: 3.2,
      stillTimes: Object.freeze([0.2, 1.2, 2.5, 3.8, 4.8]),
      audio: Object.freeze({
        profile: "sutro-moment",
        index,
        description
      })
    })];
  })),
  // The two wide ones: ten seconds apiece, the room itself as the subject.
  ...Object.fromEntries([
    [1, "Sutro Baths · The Hall", "The length of the room from the north end, pools running away under the glass."],
    [2, "Sutro Baths · The Ocean Window", "Down the west gallery, colonnade one side and the whole Pacific the other."]
  ].map(([index, title, description]) => {
    const suffix = String(index).padStart(2, "0");
    const id = `sutro-vista-${suffix}`;
    return [id, Object.freeze({
      id,
      demo: id,
      title,
      duration: 10,
      seed: (0x56_49_53_00 + index * 0x101) >>> 0,
      posterAt: 6.4,
      stillTimes: Object.freeze([0.3, 2.2, 4.4, 6.6, 8.8, 9.7]),
      audio: Object.freeze({
        profile: "sutro-vista",
        index,
        description
      })
    })];
  }))
});

function envNumber(env, key, fallback) {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number (received ${JSON.stringify(raw)})`);
  return value;
}

function positiveInt(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer (received ${value})`);
  return value;
}

function nonNegativeInt(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer (received ${value})`);
  return value;
}

function safeTake(value) {
  const take = String(value ?? DEFAULTS.take).trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(take)) {
    throw new Error(`take must use only letters, digits, dot, underscore, and dash (received ${JSON.stringify(take)})`);
  }
  return take;
}

function frameFormat(value) {
  const normalized = String(value).toLowerCase();
  if (normalized === "jpeg") return "jpg";
  if (normalized !== "jpg" && normalized !== "png") {
    throw new Error(`frame format must be "jpg" or "png" (received ${JSON.stringify(value)})`);
  }
  return normalized;
}

/**
 * Resolve the one current cinematic settings schema. Environment overrides:
 *
 *   SF_CINE_WIDTH, SF_CINE_HEIGHT, SF_CINE_FPS
 *   SF_CINE_FORMAT=png|jpg, SF_CINE_JPEG_QUALITY, SF_CINE_CRF=14..16
 *   SF_CINE_TAKE, SF_CINE_SEED, SF_CINE_FAST_BITRATE
 *   SF_CINE_SETTLE_FRAMES, SF_CINE_SETTLE_GAP_MS
 */
export function resolveProduction(id, { env = process.env, overrides = {} } = {}) {
  const definition = DEFINITIONS[id];
  if (!definition) throw new Error(`unknown cinematic ${JSON.stringify(id)}; choose ${productionIds().join(", ")}`);

  const width = positiveInt(
    Number(overrides.width ?? envNumber(env, "SF_CINE_WIDTH", DEFAULTS.width)),
    "width"
  );
  const height = positiveInt(
    Number(overrides.height ?? envNumber(env, "SF_CINE_HEIGHT", DEFAULTS.height)),
    "height"
  );
  if (width % 2 || height % 2) {
    throw new Error(`H.264 yuv420p output requires even dimensions (received ${width}x${height})`);
  }
  const fps = positiveInt(Number(overrides.fps ?? envNumber(env, "SF_CINE_FPS", DEFAULTS.fps)), "fps");
  const format = frameFormat(overrides.frameFormat ?? env.SF_CINE_FORMAT ?? DEFAULTS.frameFormat);
  const jpegQuality = positiveInt(
    Number(overrides.jpegQuality ?? envNumber(env, "SF_CINE_JPEG_QUALITY", DEFAULTS.jpegQuality)),
    "JPEG quality"
  );
  if (jpegQuality > 100) throw new Error(`JPEG quality must be in 1..100 (received ${jpegQuality})`);

  const crf = positiveInt(Number(overrides.crf ?? envNumber(env, "SF_CINE_CRF", DEFAULTS.crf)), "CRF");
  if (crf < 14 || crf > 16) throw new Error(`cinematic H.264 CRF must be in 14..16 (received ${crf})`);
  const fastBitrate = positiveInt(
    Number(overrides.fastBitrate ?? envNumber(env, "SF_CINE_FAST_BITRATE", DEFAULTS.fastBitrate)),
    "fast bitrate"
  );
  if (fastBitrate < 1_000_000 || fastBitrate > 100_000_000) {
    throw new Error(`fast bitrate must be in 1000000..100000000 (received ${fastBitrate})`);
  }

  const duration = Number(overrides.duration ?? definition.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`duration must be positive (received ${duration})`);
  const exactFrames = duration * fps;
  if (Math.abs(exactFrames - Math.round(exactFrames)) > 1e-9) {
    throw new Error(`duration × fps must produce an exact frame count (received ${duration} × ${fps})`);
  }

  const seedRaw = Number(overrides.seed ?? envNumber(env, "SF_CINE_SEED", definition.seed));
  if (!Number.isInteger(seedRaw)) throw new Error(`seed must be an integer (received ${seedRaw})`);
  const seed = seedRaw >>> 0;
  const settleFrames = nonNegativeInt(
    Number(overrides.settleFrames ?? envNumber(env, "SF_CINE_SETTLE_FRAMES", DEFAULTS.settleFrames)),
    "settle frames"
  );
  const settleGapMs = nonNegativeInt(
    Number(overrides.settleGapMs ?? envNumber(env, "SF_CINE_SETTLE_GAP_MS", DEFAULTS.settleGapMs)),
    "settle gap"
  );

  return Object.freeze({
    ...definition,
    width,
    height,
    fps,
    duration,
    totalFrames: Math.round(exactFrames),
    dt: 1 / fps,
    frameFormat: format,
    jpegQuality,
    crf,
    fastBitrate,
    take: safeTake(overrides.take ?? env.SF_CINE_TAKE ?? DEFAULTS.take),
    seed,
    settleFrames,
    settleGapMs,
    stillTimes: Object.freeze([...definition.stillTimes])
  });
}

export function productionIds() {
  return Object.keys(DEFINITIONS);
}

export function productionDefinitions() {
  return DEFINITIONS;
}

export { DEFAULTS as CINEMATIC_DEFAULTS, DEFINITIONS as PRODUCTIONS };
