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
