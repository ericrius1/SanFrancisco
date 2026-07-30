/**
 * Authored Pacific swell at Ocean Beach. The city water stays intentionally
 * cheap, but this strip gets a directional, shoaling wave train that can be
 * sampled identically by water rendering, boats and the surf controller.
 *
 * Local frame: +X is east / shoreward, +Z is south / along the beach.
 */

export const OCEAN_BEACH_SURF = {
  minX: -6325,
  /**
   * Minimum WIDTH of the surf strip, measured from the live waterline rather
   * than from `minX`. The beach curves 460 m across its length, so one
   * straight offshore line gives the south end 600 m of authored ocean and the
   * north end 163 m — of which the mask's two 70 m feathers eat all but about
   * twenty. That is why the sea in front of the kite festival (z≈1650) read as
   * a flat sheet: there was barely room for one crest to exist, let alone
   * stand up and break. The bound is min(minX, shore − stripWidth), so this
   * only ever OPENS the narrow north end; every stretch that was already wider
   * than this keeps the exact offshore line it had.
   */
  stripWidth: 340,
  // Shoreward bound of the activity strip (sand side). The live waterline is
  // further west — see oceanBeachApproxShoreX / oceanBeachShoreline.
  maxX: -5720,
  minZ: 1280,
  maxZ: 4920,
  centerZ: 3100,
  entryX: -6070,
  entryZ: 3370,
  // Bigger, better-spaced sets for a Kelly-Slater-style peeling wall: crests sit
  // ~150 m apart (one clean wave at a time, not a busy ripple field) and stand
  // up head-high-plus on the shoreward face.
  spacing: 150,
  speed: 9.2,
  amplitude: 7.2,
  offshoreCrest: -6310,
  // Shoaling profile widths (metres): a broad offshore shoulder feeds a steep,
  // narrow shoreward face. Shared by the CPU sampler AND the GPU twin
  // (tslUtil.oceanBeachSurfField) — change here, both follow. Narrow face =
  // a steep, near-vertical wall that towers over a rider set in the pocket.
  shoulderWidth: 36,
  faceWidth: 7.5,

  // Parametric barrel shared by CPU contact/camera queries and the lazy TSL
  // roof shell. X is signed shoreward distance from the live crest. The roof
  // starts at the crown, arches over the pocket, then falls into the pitching
  // lip. Keeping this analytic is intentional: gameplay never reads GPU state.
  tubeSpan: 14,
  tubeLineOffset: 6.2,
  tubeLineHalfWidth: 2.5,
  tubeRoofControl1: 1.16,
  tubeRoofControl2: 0.94,
  tubeRoofEnd: 0.5,
  // Long, slowly peeling barrel sections. Entry Z begins inside a clean window;
  // riding down-line eventually reaches its shoulder and exit aperture.
  barrelPeriod: 820,
  barrelDrift: 0.024,

  // --- where a wave stops being a wall and starts being a crash -----------
  // A swell breaks when it runs out of water under it. There is no analytic
  // bathymetry here, so the break is authored as a LINE offshore of the
  // waterline — and, crucially, a line that WANDERS along the beach the way a
  // sandbar field does: shallow over the bars, where a crest stands up and
  // throws early, deep over the rip channels, where the same crest carries a
  // long way further in before it goes. That wander is the whole point. A
  // constant offset breaks the entire three-kilometre beach on the same
  // frame — one straight wall of foam switching on and off every sixteen
  // seconds — where the real thing peels in patches, and the ear hears those
  // patches as a continuous irregular surf instead of a metronome.
  /** Mean metres offshore of the waterline where crests begin to throw. */
  breakOffset: 118,
  /** Metres the bar/channel field moves that line either way. */
  breakBarAmp: 52,
  /**
   * Metres of crest travel from "standing up" to "fully thrown" — at 9.2 m/s,
   * about two seconds. Deliberately SHORT relative to the bar wander above:
   * a long ramp turns the whole visible crest into one uniform gradient, and
   * it is the ratio of these two numbers that decides whether neighbouring
   * stretches of the same wave can be in visibly different states.
   */
  breakThrow: 18,

  // --- the crash SILHOUETTE: how a crest changes shape through the break --
  // Foam paint alone never read as a crash because the height field kept its
  // symmetric Gaussian profile from horizon to sand. These shape the profile
  // through four stages of `over` = metres of crest travel past the break
  // line: stand up (−standRange…0), throw (0…breakThrow), collapse
  // (breakThrow…breakThrow+spentRange), spent roller after. Pure profile
  // shaping — spacing, speed, amplitude and the break line itself are
  // untouched, so shorebreak/audio timing cannot drift.
  /** Metres of approach over which the crest stands up and leans forward. */
  standRange: 40,
  /** Metres the peak shifts shoreward while standing up (forward lean). */
  standLean: 2.8,
  /** Fractional height gain at full stand — the visible "standing up". */
  standLift: 0.18,
  /** Fractional narrowing of the front face at full stand (steepening). */
  faceTighten: 0.38,
  /** EXTRA forward pitch through the throw window, metres. */
  throwLean: 2.6,
  /** Secondary crown lobe thrown ahead of the peak — the curling lip read.
   *  Fraction of the set amplitude; a heightfield cannot overhang, but a
   *  narrow lobe ahead of a forward-leaned peak breaks the silhouette
   *  forward, which is what a beach-level camera actually sees of a curl. */
  lipAmp: 0.26,
  /** Metres ahead of the (leaned) peak the lip lobe sits. */
  lipAhead: 4.6,
  /** Gaussian sigma of the lip lobe, metres. */
  lipWidth: 2.3,
  /** Metres of travel to ease from fully thrown to spent (~2.2 s at 9.2). */
  spentRange: 20,
  /** Metres added to the front face width once spent — a mushy round bore. */
  spentWiden: 6.0,
  /** Fraction of crest height lost once spent: whitewater reads as SPENT
   *  water, not a marching white wall at unchanged height. */
  collapseDrop: 0.45
} as const;

const TAU = Math.PI * 2;

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v));
}

function smooth01(v: number) {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
}

/**
 * Approximate dry-sand waterline X along Ocean Beach (no map required).
 * Fit from baked surface.bin so CPU/GPU masks stay aligned without isWater.
 * Positive error = a few metres onto sand; the feather below eats that.
 */
export function oceanBeachApproxShoreX(z: number): number {
  return -6323 + 0.08504 * z + 0.00000743 * z * z;
}

/** Dry-sand pad just east of the live waterline at this Z. */
export type OceanBeachShoreline = { x: number; z: number; waterX: number };

/**
 * Walk shoreward from the break until `isWater` flips false. Spawn/exit use this
 * so the player stands on the actual edge, not 50–150 m inland of the surf mask.
 */
export function oceanBeachShoreline(
  map: { isWater(x: number, z: number): boolean },
  z: number,
  pad = 4
): OceanBeachShoreline {
  const b = OCEAN_BEACH_SURF;
  const zz = Math.min(b.maxZ - 30, Math.max(b.minZ + 30, z));
  const startX = Math.min(oceanBeachApproxShoreX(zz) - 80, b.entryX);
  let waterX = startX;
  for (let x = startX; x < b.maxX + 220; x += 2) {
    if (map.isWater(x, zz)) waterX = x;
    else {
      return { x: x + pad, z: zz, waterX };
    }
  }
  return { x: oceanBeachApproxShoreX(zz) + pad, z: zz, waterX };
}

/** Offshore bound of the authored strip at this Z — see `stripWidth`. */
export function oceanBeachOffshoreX(z: number): number {
  const b = OCEAN_BEACH_SURF;
  return Math.min(b.minX, oceanBeachApproxShoreX(z) - b.stripWidth);
}

/** 0 outside Ocean Beach, feathered across the authored surf strip. */
export function oceanBeachMask(x: number, z: number): number {
  const b = OCEAN_BEACH_SURF;
  const shore = Math.min(b.maxX, oceanBeachApproxShoreX(z));
  const xIn = smooth01((x - oceanBeachOffshoreX(z)) / 70) * smooth01((shore - x) / 70);
  const zIn = smooth01((z - b.minZ) / 180) * smooth01((b.maxZ - z) / 180);
  return xIn * zIn;
}

/** Shoreward-moving crest base. Use adjacent integer slots for the full train. */
export function oceanBeachCrestBase(time: number): number {
  const b = OCEAN_BEACH_SURF;
  const travel = ((time * b.speed) % b.spacing + b.spacing) % b.spacing;
  return b.offshoreCrest + travel;
}

/** Sandbar/peel variation bends each crest instead of drawing a ruler-straight wall. */
export function oceanBeachCrestX(slot: number, z: number, time: number): number {
  const b = OCEAN_BEACH_SURF;
  // Slot-independent so the whole train remains periodic and the WebGPU
  // heightfield can reproduce the same nearest-crest distance cheaply.
  const peel = Math.sin(z * 0.0052 + time * 0.18) * 13;
  const shoulder = Math.sin(z * 0.0017 - time * 0.09) * 6;
  return oceanBeachCrestBase(time) + slot * b.spacing + peel + shoulder;
}

/** Signed X distance to the nearest crest: negative offshore, positive shoreward. */
export function nearestOceanBeachCrest(x: number, z: number, time: number) {
  const b = OCEAN_BEACH_SURF;
  const approx = Math.round((x - oceanBeachCrestBase(time)) / b.spacing);
  let slot = approx;
  let crestX = oceanBeachCrestX(slot, z, time);
  let distance = x - crestX;
  for (let i = approx - 1; i <= approx + 1; i++) {
    const cx = oceanBeachCrestX(i, z, time);
    const d = x - cx;
    if (Math.abs(d) < Math.abs(distance)) {
      slot = i;
      crestX = cx;
      distance = d;
    }
  }
  return { slot, crestX, distance };
}

/**
 * Along-beach bar/channel field, −1 (deep channel) … +1 (shallow bar). Shared
 * by the CPU break line and its GPU twin (tslUtil.oceanBeachBreakXNode) — two
 * incommensurate wavelengths, ~1.8 km and ~640 m, over a 3.6 km beach, so the
 * pattern never repeats inside one view. The slow time term is bar migration:
 * a few metres a minute, invisible in a clip, but it stops the same stretch of
 * sand from being the one that always closes out.
 */
function breakBarField(z: number, time: number): number {
  return (
    Math.sin(z * 0.0034 - time * 0.006) * 0.46 +
    Math.sin(z * 0.0098 + 1.7) * 0.28 +
    // A third, much shorter rhythm — ~240 m, so most of one cycle fits inside a
    // single shot. This is what breaks a crest in SECTIONS: nine metres of
    // break-line wander against a thirty-metre throw means one stretch of the
    // same wave is already whitewater while the stretch beside it is still a
    // green wall. Without it the crest goes off along its whole visible length
    // at once, which no beach has ever done.
    Math.sin(z * 0.026 + 0.9) * 0.26
  );
}

/** World X where crests at this point on the beach start to throw. */
export function oceanBeachBreakX(z: number, time: number): number {
  const b = OCEAN_BEACH_SURF;
  return (
    oceanBeachApproxShoreX(z) - b.breakOffset - breakBarField(z, time) * b.breakBarAmp
  );
}

/**
 * 0 while a crest is still a smooth green wall, 1 once it has thrown and is
 * whitewater. Takes the CREST's position, not the sample point's: a wave
 * breaks as a whole, so every pixel on one crest has to agree about whether it
 * has gone yet — which is also what lets the audio ask the same question.
 */
export function oceanBeachBreakPhase(crestX: number, z: number, time: number): number {
  return smooth01((crestX - oceanBeachBreakX(z, time)) / OCEAN_BEACH_SURF.breakThrow);
}

/**
 * Break-shape state for the crest at `crestX`: everything the crash
 * silhouette needs, derived from ONE scalar — metres of crest travel past
 * the break line. Like breakPhase it takes the CREST's position, so every
 * sample on one wave agrees about its stage.
 *
 * CPU/GPU twin parity map (change BOTH or the picture desyncs from
 * audio/shorebreak/physics). GPU = tslUtil.oceanBeachSurfField:
 *
 *   term      CPU (here)                                GPU twin
 *   over      crestX − oceanBeachBreakX                 x.sub(d).sub(oceanBeachBreakXNode)
 *   breaking  smooth01(over / breakThrow)               smoothstep(0, breakThrow, over)
 *   spent     smooth01((over − breakThrow)/spentRange)  smoothstep(breakThrow, breakThrow+spentRange, over)
 *   throwEnv  breaking · (1 − spent)                    breaking.mul(spent.oneMinus())
 *   peakShape smooth01((over+standRange)/standRange)    smoothstep(−standRange, 0, over)
 *               · (1 − spent)                             .mul(spent.oneMinus())
 *   lean      peakShape·standLean + throwEnv·throwLean  same, .mul/.add
 */
export function oceanBeachBreakShape(crestX: number, z: number, time: number) {
  const b = OCEAN_BEACH_SURF;
  const over = crestX - oceanBeachBreakX(z, time);
  const breaking = smooth01(over / b.breakThrow);
  const spent = smooth01((over - b.breakThrow) / b.spentRange);
  const throwEnv = breaking * (1 - spent);
  const peakShape = smooth01((over + b.standRange) / b.standRange) * (1 - spent);
  const lean = peakShape * b.standLean + throwEnv * b.throwLean;
  return { over, breaking, spent, throwEnv, peakShape, lean };
}

function waveAmplitude(z: number, time: number, slot: number) {
  const b = OCEAN_BEACH_SURF;
  const setPulse = 0.82 + Math.sin(time * 0.13 + slot * 2.2) * 0.13;
  const sandbar = 0.88 + Math.sin(z * 0.0041 + time * 0.1) * 0.12;
  return b.amplitude * setPulse * sandbar;
}

/** 0..1 long-section envelope for the overhanging barrel roof. */
export function oceanBeachBarrelEnvelope(z: number, time: number): number {
  const b = OCEAN_BEACH_SURF;
  const phase = Math.cos(((z - b.entryZ) / b.barrelPeriod) * TAU - time * b.barrelDrift);
  return smooth01((phase - 0.05) / 0.55);
}

/** Cubic crown-to-lip roof height as a fraction of the live set amplitude. */
export function oceanBeachTubeRoofFraction(crestDistance: number): number {
  const b = OCEAN_BEACH_SURF;
  const u = clamp01(crestDistance / b.tubeSpan);
  const v = 1 - u;
  return (
    v * v * v +
    3 * v * v * u * b.tubeRoofControl1 +
    3 * v * u * u * b.tubeRoofControl2 +
    u * u * u * b.tubeRoofEnd
  );
}

/** Smooth signed-depth proxy: 1 on the authored tube line, 0 outside it. */
function tubeLineDepth(crestDistance: number): number {
  const b = OCEAN_BEACH_SURF;
  const lineDistance = Math.abs(crestDistance - b.tubeLineOffset);
  const t = clamp01((lineDistance - 0.35) / Math.max(0.01, b.tubeLineHalfWidth - 0.35));
  return 1 - smooth01(t);
}

/**
 * Height contribution from the breaking swell (zero outside Ocean Beach).
 * The offshore shoulder is broad and the shoreward face is narrow: a cheap
 * shoaling profile with the steep face surfers need for speed.
 *
 * The profile is SHAPED by the crest's break stage (oceanBeachBreakShape):
 * it stands up and leans shoreward on approach, throws a narrow lip lobe
 * ahead of the peak through the ~2 s pitch, then collapses to a lower,
 * rounder spent roller. Height-field parity map (GPU twin =
 * tslUtil.oceanBeachSurfField; shape terms in oceanBeachBreakShape's table):
 *
 *   term     CPU (here)                              GPU twin
 *   prox     1 − smooth01((|d|−30)/25)               smoothstep(30, 55, d.abs()).oneMinus()
 *   peakShape/throwEnv/spent/lean — the crest-level shape terms, ×prox
 *   ds       d − lean                                d.sub(lean)
 *   frontW   faceWidth·(1−faceTighten·peakShape)     float(faceWidth).mul(...oneMinus())
 *              + spent·spentWiden                      .add(spent.mul(spentWiden))
 *   width    ds<0 ? shoulderWidth : frontW           mix(shoulder, frontW, step(0, ds))
 *   ridge    exp(−½(ds/width)²)·(1+standLift·peakShape)   same, .mul(...add(1))
 *   lipLobe  exp(−½((ds−lipAhead)/lipWidth)²)·lipAmp·throwEnv   same
 *   collapse 1 − collapseDrop·spent                  spent.mul(collapseDrop).oneMinus()
 *   trough   exp(−½((d−22)/11)²)·0.24 (unshifted)    same
 *   height   ((ridge+lipLobe)·collapse − trough)·a·mask   same
 *
 * `prox` windows the WHOLE deformation to the crest's own neighbourhood:
 * exactly 1 within 30 m of the crest, exactly 0 past 55 m. Without it the
 * nearest-crest reassignment at mid-trough (±75 m) joins two crests in
 * DIFFERENT break stages and their unequal collapse/lean tails meet as a
 * visible step in open water.
 */
export function oceanBeachWaveHeight(x: number, z: number, time: number): number {
  const mask = oceanBeachMask(x, z);
  if (mask <= 0.0001) return 0;
  const b = OCEAN_BEACH_SURF;
  const { slot, crestX, distance: d } = nearestOceanBeachCrest(x, z, time);
  const a = waveAmplitude(z, time, slot);
  const shape = oceanBeachBreakShape(crestX, z, time);
  const prox = 1 - smooth01((Math.abs(d) - 30) / 25);
  const peakShape = shape.peakShape * prox;
  const throwEnv = shape.throwEnv * prox;
  const spent = shape.spent * prox;
  const ds = d - shape.lean * prox;
  const frontW = b.faceWidth * (1 - b.faceTighten * peakShape) + spent * b.spentWiden;
  const width = ds < 0 ? b.shoulderWidth : frontW;
  const ridge = Math.exp(-0.5 * (ds / width) ** 2) * (1 + b.standLift * peakShape);
  const lipLobe = Math.exp(-0.5 * ((ds - b.lipAhead) / b.lipWidth) ** 2) * b.lipAmp * throwEnv;
  const collapse = 1 - b.collapseDrop * spent;
  const trough = Math.exp(-0.5 * ((d - 22) / 11) ** 2) * 0.24;
  return ((ridge + lipLobe) * collapse - trough) * a * mask;
}

export type OceanBeachWaveSample = {
  height: number;
  slopeX: number;
  slopeZ: number;
  face: number;
  lip: number;
  crestDistance: number;
  crestX: number;
  slot: number;
  mask: number;
  amplitude: number;
  /** Roof-section availability at this along-beach location. */
  barrel: number;
  /** 0..1 position inside the surfable tube line. */
  tubeDepth: number;
  /** Absolute analytic roof height (sea-level frame; base chop is sub-metre). */
  tubeRoofY: number;
  /** 0 green wall … 1 thrown whitewater, for THIS sample's own crest. */
  breaking: number;
  /** Metres the peak has leaned shoreward of crestX (oceanBeachBreakShape). */
  lean: number;
};

/**
 * Analytic sample for surf physics, camera and diagnostics. A locked slot keeps
 * every semantic region attached to the crest the controller already owns.
 */
export function sampleOceanBeachWave(
  x: number,
  z: number,
  time: number,
  lockedSlot?: number
): OceanBeachWaveSample {
  const mask = oceanBeachMask(x, z);
  const nearest = nearestOceanBeachCrest(x, z, time);
  const slot = lockedSlot ?? nearest.slot;
  const crestX = lockedSlot === undefined ? nearest.crestX : oceanBeachCrestX(slot, z, time);
  const crestDistance = x - crestX;
  const eps = 0.65;
  const epsZ = 1.2;
  const height = oceanBeachWaveHeight(x, z, time);
  const slopeX =
    (oceanBeachWaveHeight(x + eps, z, time) - oceanBeachWaveHeight(x - eps, z, time)) /
    (2 * eps);
  const slopeZ =
    (oceanBeachWaveHeight(x, z + epsZ, time) - oceanBeachWaveHeight(x, z - epsZ, time)) /
    (2 * epsZ);
  const amplitude = waveAmplitude(z, time, slot);
  // These gameplay channels deliberately match oceanBeachSurfField()'s visible
  // green wall and white lip. A wider invisible scoring band made the board
  // report "on the lip" while the rendered crest was several metres away.
  // The bands ride the LEANED peak (crestDistance − lean), because that is
  // where the rendered wall/crown now sit through the break. Unwindowed lean
  // is exact here: the GPU twin windows lean by prox, but prox ≡ 1 within
  // 30 m of the crest and both bands are dead beyond ~15 m.
  const shape = oceanBeachBreakShape(crestX, z, time);
  const ds = crestDistance - shape.lean;
  const face = mask * Math.exp(-0.5 * ((ds - 4) / 5.5) ** 2);
  const lip = mask * Math.exp(-0.5 * ((ds - 1) / 2.6) ** 2);
  const barrel = mask * oceanBeachBarrelEnvelope(z, time);
  const tubeDepth = barrel * tubeLineDepth(crestDistance);
  const tubeRoofY = amplitude * mask * oceanBeachTubeRoofFraction(crestDistance);
  return {
    height,
    slopeX,
    slopeZ,
    face,
    lip,
    crestDistance,
    crestX,
    slot,
    mask,
    amplitude,
    barrel,
    tubeDepth,
    tubeRoofY,
    breaking: shape.breaking,
    lean: shape.lean
  };
}

/** True when the player is close enough to the waterline to start surfing / carry a board. */
export function nearOceanBeachShore(
  x: number,
  z: number,
  opts: { shorePad?: number; inlandPad?: number; zPad?: number } = {}
): boolean {
  const b = OCEAN_BEACH_SURF;
  const shorePad = opts.shorePad ?? 90;
  const inlandPad = opts.inlandPad ?? 55;
  const zPad = opts.zPad ?? 80;
  if (z < b.minZ - zPad || z > b.maxZ + zPad) return false;
  const shore = oceanBeachApproxShoreX(z);
  return x > shore - shorePad && x < shore + inlandPad;
}

/** A deterministic little break-up used by spray/foam without allocating RNG state. */
export function oceanBeachFoamNoise(z: number, time: number, seed: number): number {
  return 0.5 + 0.5 * Math.sin(z * 0.071 + time * (1.7 + seed * 0.03) + seed * TAU * 0.618);
}
