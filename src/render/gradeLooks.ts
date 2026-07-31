/**
 * The display rendering transform: scene-linear HDR in, display-referred sRGB
 * out. This module is the SINGLE SOURCE OF TRUTH for that transform and it is
 * deliberately dependency-free (no three, no TSL) so a plain Node probe can
 * import and exercise it — see tools/grade-probe.mjs.
 *
 * Nothing here runs on the GPU. The shader samples a 3D LUT that was baked from
 * `evaluateLook` (grade.ts), so this file's arithmetic IS the rendered image.
 * That indirection is the whole design:
 *
 *   · switching looks costs a texture upload, never a shader recompile — the
 *     eight cached post-FX variants stay valid across every grade change;
 *   · the per-pixel cost is one shaper + one trilinear fetch regardless of how
 *     baroque the grade gets, so looks are free to be as expensive as they like;
 *   · the transform is testable in Node, in float64, without a browser.
 *
 * ---------------------------------------------------------------------------
 * Why not ACESFilmic (what shipped before this module)
 * ---------------------------------------------------------------------------
 * Three's ACES is the Narkowicz/Hill fit applied PER CHANNEL through the AP1
 * matrices. Its signature failure is that saturated bright colour paths toward
 * white: the sun's surround at low elevation lands near linear (1.8, 1.1, 0.6)
 * and ACES renders it as a near-achromatic blob. A sunset sky is exactly the
 * content that fails hardest.
 *
 * The `sf` curve below instead tone maps a single scalar — the peak channel —
 * and re-applies the original chroma ratio, so hue and saturation survive the
 * shoulder intact. Genuine over-exposure still needs to bleach (a lamp filament
 * must read white, not saturated), so a controlled path-to-white is a separate,
 * explicit, per-look knob rather than an unavoidable property of the curve.
 *
 * Shadow contrast is NOT the tonescale's job here. A log-space contrast pivot
 * runs before it and owns the toe; the tonescale owns only the shoulder. Keeping
 * those separate is what makes the looks tunable by hand instead of by search.
 */

/** Photographic mid grey. The contrast pivot, and the anchor every look holds. */
export const GRADE_PIVOT = 0.18;

/**
 * Edge length of the baked 3D LUT. 48³ RGBA16F is 864 KB of VRAM, generated on
 * the CPU at boot in a few milliseconds — nothing is fetched, so the massive-app
 * loading policy has nothing to object to.
 *
 * Chosen by measurement, not by round numbers. 33³ costs 281 KB and is visibly
 * worse in the deep-shadow band; 64³ costs 2 MB and buys almost nothing over 48
 * because the residual error is a C0 crease in the transform, not a sampling
 * limit — resolution cannot fix a kink. See tools/grade-probe.mjs.
 */
export const GRADE_LUT_SIZE = 48;

/** Rec.709 luminance weights — the working space is Linear-sRGB throughout. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/**
 * The LUT shaper: scene-linear [0, SHAPER_MAX] → LUT coordinate [0, 1].
 *
 *   s = sqrt(min(x, MAX));   u = (s / (s + A)) · NORM
 *
 * A 3D LUT is only as good as the axis it samples on, and the axis has exactly
 * one job: make the baked transform close to LINEAR in shaped space, because
 * trilinear interpolation is all that sits between the samples.
 *
 * The `sqrt` is a gamma-2.0 encode. Below mid grey the whole transform behaves
 * like x^0.4167 (the sRGB OETF dominates), so in shaped space it becomes
 * u^0.833 — near enough to a straight line that interpolation error in the
 * shadows is a rounding detail. The Reinhard wrapper s/(s+A) then compresses
 * the highlights so the shoulder and the path-to-white ramp get real estate
 * instead of being crushed into the last two samples.
 *
 * BOUNDING THE TOP IS LOAD-BEARING, and it is the one thing an earlier draft of
 * this file got wrong. An unbounded shaper (u → 1 as x → ∞) sounds elegant and
 * is a disaster: the final cell then spans linear ~13 → ∞, and its eight
 * corners have completely unrelated channel RATIOS — one corner is a saturated
 * red at 4096, the next is neutral at 13. Trilinear interpolation across that
 * cell returns mush. Measured cost of that mistake: 22 code values of error on
 * ordinary bright sky, and highlights that came back DESATURATED — precisely
 * the failure this whole module exists to remove. Clamping to SHAPER_MAX keeps
 * the top cell narrow (≈49 → 64 linear) and the error inside it negligible.
 *
 * Both constants were chosen by sweep, not by taste — see
 * `node --experimental-strip-types tools/grade-probe.mjs --sweep`.
 */
export const SHAPER_A = 2.2;

/**
 * Top of the shaped range. This is NOT "the brightest value the scene emits" —
 * the guard in `shapeTriple` handles anything brighter exactly. It is the point
 * above which every `sf` look has provably stopped depending on magnitude, so
 * it has a hard FLOOR rather than a ceiling: it must clear the largest
 * per-look threshold, which is `reverie` at ≈15.9 linear (its sub-1 contrast
 * expands rather than compresses, so it saturates its path-to-white latest).
 * 28 clears that with margin while keeping the axis short enough to resolve.
 *
 * Caveat, deliberate: the per-channel curves — the legacy `aces` reference and
 * the two `agx` looks — never become scale-invariant, so the guard is an
 * approximation for them above 28 linear rather than an identity. Measured for
 * AgX: 21.9 CV at (200, 10, 10), 30.2 CV at (4000, 40, 40), and 0.0 at
 * (40, 38, 36). The trigger needs peak > 28 linear AND a wide channel spread at
 * once; the rig's brightest measured value is ~13, so nothing in the world
 * reaches it today — but an emissive authored later could, and that is the one
 * thing to check before blaming AgX for a magenta lamp.
 */
export const SHAPER_MAX = 28;

/**
 * Normalises the curve so u(SHAPER_MAX) is exactly 1 and the axis is fully
 * used. Without it the top of the LUT is dead range.
 */
export const SHAPER_NORM = (Math.sqrt(SHAPER_MAX) + SHAPER_A) / Math.sqrt(SHAPER_MAX);

/**
 * scene-linear → LUT axis coordinate. Mirrored exactly in TSL by
 * `shaperForwardNode` (grade.ts); the two must not drift.
 */
export function shaperForward(x: number): number {
  const c = x > 0 ? (x < SHAPER_MAX ? x : SHAPER_MAX) : 0;
  const s = Math.sqrt(c);
  const u = (s / (s + SHAPER_A)) * SHAPER_NORM;
  return u > 1 ? 1 : u;
}

/** LUT axis coordinate → scene-linear. Bake-side only; the GPU never needs it. */
export function shaperInverse(u: number): number {
  const t = u / SHAPER_NORM;
  if (t >= 1) return SHAPER_MAX;
  const s = (SHAPER_A * t) / (1 - t);
  const x = s * s;
  return x > SHAPER_MAX ? SHAPER_MAX : x;
}

/**
 * Scene-linear triple → LUT coordinates, WITH the over-range guard. Mirrored
 * exactly in TSL; this function and its shader twin are the LUT's whole API.
 *
 * The guard is why the LUT is exact for arbitrarily bright input despite
 * covering only [0, SHAPER_MAX]. Clamping each channel independently would be
 * the obvious move and it is wrong: it changes the channel RATIOS, and above
 * the shoulder the ratios are the entire signal. A (200, 10, 10) emissive
 * clamped per channel becomes (48, 10, 10) — a completely different colour.
 *
 * Scaling the whole triple instead is not an approximation but an identity.
 * Above the point where the tonescale has clamped (tm = 1) and the path-to-
 * white has saturated, every remaining operation is scale-invariant: white
 * balance and saturation-by-ratio are homogeneous, the contrast pow turns a
 * factor s into a factor s^k on every channel alike, and the output depends
 * only on c/peak. So f(s·c) === f(c) exactly, and SHAPER_MAX sits far above
 * where that kicks in (≈7.4 linear for the house look). Verified by
 * measurement: the probe reports identical error stressing samples to linear
 * 120 and to linear 4000.
 */
export function shapeTriple(
  r: number,
  g: number,
  b: number,
  out: [number, number, number] = [0, 0, 0]
): [number, number, number] {
  const peak = r > g ? (r > b ? r : b) : g > b ? g : b;
  const s = peak > SHAPER_MAX ? SHAPER_MAX / peak : 1;
  out[0] = shaperForward(r * s);
  out[1] = shaperForward(g * s);
  out[2] = shaperForward(b * s);
  return out;
}

/**
 * One look. Every field is an artistic control; none of them are calibration.
 * The rig's calibration (sun/sky/emissive intensities, the exposure anchor)
 * lives in config.ts and sky.ts and is deliberately NOT duplicated here — a
 * look must be swappable without re-lighting the world.
 */
export type GradeLook = {
  readonly id: string;
  readonly label: string;
  /** One line for the "/" panel and for anyone reading a diff. */
  readonly note: string;
  /**
   * `sf` runs the hue-preserving chain below.
   *
   * `aces` runs three's stock ACESFilmic verbatim and ignores every other field
   * — it exists so the look that shipped before this module stays one dropdown
   * click away, which is the only honest way to judge a grade change.
   *
   * `agx` runs three's AgX verbatim (log window → CDL → sigmoid → outset),
   * honouring `whiteBalance`, `offsetStops`, `saturation`, `agx`, `lift` and
   * `tint`, and ignoring `contrast`, `white` and `pathToWhite` — the sigmoid and
   * the log window already own those. See `agxEvaluate`.
   */
  readonly curve: "sf" | "aces" | "agx";
  /** Linear per-channel gain, applied first. Luminance-normalised on load. */
  readonly whiteBalance: readonly [number, number, number];
  /** Log-space slope about GRADE_PIVOT. >1 deepens the toe and opens highlights. */
  readonly contrast: number;
  /**
   * Trim in stops, folded into the same expression as `contrast`.
   *
   * This is the EXPOSURE ANCHOR, and every `sf` look is solved so that a sunlit
   * 18% grey card lands at the same place the legacy ACES curve put it
   * (display-linear 0.1855, measured on the "/" chart at Ocean Beach, noon).
   * Switching looks therefore changes character — contrast, chroma, tint — and
   * not brightness, which is the only way a look selector is usable: otherwise
   * every comparison is confounded by one option simply being brighter.
   *
   * It is also why the fix for the new curve's −0.30 stop midtone lives HERE
   * rather than in sky.ts's sunDay/hemiDay. Those set actual scene radiance, and
   * scene-linear values are load-bearing elsewhere — the bloom threshold of 2.2
   * is measured in that space. A display-side shift gets a display-side
   * correction; the lighting rig is left exactly as it was.
   *
   * Re-solve with tools/grade-probe.mjs if the tonescale or contrast changes.
   */
  readonly offsetStops: number;
  /** Linear saturation, BEFORE the tonescale so film-like compression applies. */
  readonly saturation: number;
  /** The scene-linear value that lands on display white. Sets shoulder length. */
  readonly white: number;
  /**
   * Path-to-white as [start, end, strength] over the PEAK channel. This is the
   * single most load-bearing control in the file: it decides whether the sky
   * around the sun stays orange or bleaches. ACES behaves as though strength
   * were pinned near 1 with a start barely above mid grey.
   */
  readonly pathToWhite: readonly [number, number, number];
  /** Split tone, applied post-tonescale. Luminance-normalised so they only rotate hue. */
  readonly shadowTint: readonly [number, number, number];
  readonly highlightTint: readonly [number, number, number];
  /** How much of the split tone to apply, 0..1. */
  readonly tint: number;
  /** Black lift, for faded looks. 0 = true blacks. */
  readonly lift: number;
  /** `curve: "agx"` only. Omitted means AGX_NEUTRAL, i.e. plain AgX. */
  readonly agx?: AgxLook;
};

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

const smoothstep = (a: number, b: number, x: number) => {
  if (b === a) return x < a ? 0 : 1;
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

const luma = (r: number, g: number, b: number) => r * LUMA_R + g * LUMA_G + b * LUMA_B;

/**
 * Width of the smooth knee where the tonescale meets display white, in output
 * units. Small enough to be invisible, wide enough to span a fraction of a LUT
 * cell — which is the entire point of it existing.
 */
const WHITE_KNEE = 0.035;

/**
 * C∞ soft minimum. Used only to join the tonescale to its 1.0 ceiling.
 *
 * `min(tm, 1)` looks harmless and is the single largest remaining source of LUT
 * error: extended Reinhard reaches 1 at W with a POSITIVE slope, so clamping
 * puts a corner at exactly the brightness where highlights live. Because the
 * peak channel's tonescale multiplies all three channels, that corner is not
 * confined to near-white — it propagates into the chroma of every saturated
 * highlight. It hurt `slideFilm` worst, which is the look with the shortest
 * white point and therefore the one that meets the corner soonest.
 *
 * The log-sum-exp form converges to min() to within 1e-14 a few knees out, so
 * genuine over-range still resolves to pure white; it only rounds the join.
 */
function softMinOne(a: number, k: number): number {
  // exp(-1/k) underflows for the small k used here, so factor the smaller term
  // out rather than trusting the naive expression.
  const m = a < 1 ? a : 1;
  return m - k * Math.log(1 + Math.exp(-Math.abs(a - 1) / k));
}

/**
 * Rescale a tint so its luminance is exactly 1. A tint is a hue rotation, not
 * an exposure change — without this, saturating a look's tints would silently
 * darken or brighten the whole image and every other control would be chasing it.
 */
function normaliseTint(t: readonly [number, number, number]): [number, number, number] {
  const l = luma(t[0], t[1], t[2]);
  if (!(l > 0)) return [1, 1, 1];
  return [t[0] / l, t[1] / l, t[2] / l];
}

/* ------------------------------------------------------------------ ACES ---
 * Three's ACESFilmic, transcribed from
 * node_modules/three/src/nodes/display/ToneMappingFunctions.js.
 *
 * The matrices are written ROW-major here because that is what they are in the
 * TSL source too: TSL's `mat3(…nine scalars)` is not a WGSL column-major
 * constructor — ConvertType routes an all-scalar call through `new Matrix3(…)`,
 * whose `set()` takes rows. Verified in r185 before transcribing; get this
 * backwards and the "reference" look silently stops being the reference.
 */
const ACES_IN = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777]
] as const;

const ACES_OUT = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602]
] as const;

const mul3 = (m: readonly (readonly number[])[], r: number, g: number, b: number) =>
  [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b
  ] as [number, number, number];

const rrtOdtFit = (x: number) => {
  const a = x * (x + 0.0245786) - 0.000090537;
  const b = x * (x * 0.983729 + 0.432951) + 0.238081;
  return a / b;
};

function acesFilmic(rgb: [number, number, number]): [number, number, number] {
  // Three divides by 0.6 as part of the fit; exposure is already folded in by
  // the caller, exactly as renderOutput folded toneMappingExposure in before.
  const s = 1 / 0.6;
  const [ar, ag, ab] = mul3(ACES_IN, rgb[0] * s, rgb[1] * s, rgb[2] * s);
  const [br, bg, bb] = mul3(ACES_OUT, rrtOdtFit(ar), rrtOdtFit(ag), rrtOdtFit(ab));
  return [clamp01(br), clamp01(bg), clamp01(bb)];
}

/* -------------------------------------------------------------------- AgX ---
 * Transcribed from `agxToneMapping` in
 * node_modules/three/src/nodes/display/ToneMappingFunctions.js:165-193.
 *
 * AgX is a CURVE, not a set of parameter values. Its defining operations — a
 * log2 encode over a fixed 16.5-stop window, a per-channel sigmoid, two 3×3
 * rotations and a Rec.2020 round trip — have no counterpart in the
 * whiteBalance/contrast/saturation/white/pathToWhite vocabulary above, which is
 * why it is a `curve` branch and not another look entry on `sf`.
 *
 * MATRIX ORIENTATION IS THE ONE THING THAT SILENTLY RUINS THIS. `mul3` here is
 * ROW-major (see the ACES note above). Three writes these as
 * `mat3(vec3, vec3, vec3)`, and a vector-argument mat3 constructor takes
 * COLUMNS — unlike the all-scalar form, which routes through Matrix3.set() and
 * takes rows. So every array below is the TRANSPOSE of what that file shows.
 *
 * The invariant that catches a transpose on sight: EVERY ROW OF ALL FOUR
 * MATRICES SUMS TO 1.0, because all four preserve white. Measured here:
 * 1.000000 / 0.999900 / 1.000000 for the sRGB→2020 rotation (the published
 * constants are 4-decimal rounded), 1.0 to float64 precision for both AgX
 * matrices. `agxWhitePreservationError()` below re-checks it in one call so a
 * probe can assert on it — a missing or transposed AGX_OUTSET moves mid grey by
 * 0.0 CV and shows up ONLY as chroma loss (16.5% → 13.2% on the sun surround),
 * i.e. it looks entirely reasonable and passes every eyeball A/B.
 */
const LINEAR_SRGB_TO_LINEAR_REC2020 = [
  [0.6274, 0.3293, 0.0433],
  [0.0691, 0.9195, 0.0113],
  [0.0164, 0.088, 0.8956]
] as const;

const LINEAR_REC2020_TO_LINEAR_SRGB = [
  [1.6605, -0.5876, -0.0728],
  [-0.1246, 1.1329, -0.0083],
  [-0.0182, -0.1006, 1.1187]
] as const;

const AGX_INSET = [
  [0.856627153315983, 0.0951212405381588, 0.0482516061458583],
  [0.137318972929847, 0.761241990602591, 0.101439036467562],
  [0.11189821299995, 0.0767994186031903, 0.811302368396859]
] as const;

const AGX_OUTSET = [
  [1.1271005818144368, -0.11060664309660323, -0.016493938717834573],
  [-0.1413297634984383, 1.157823702216272, -0.016493938717834257],
  [-0.14132976349843826, -0.11060664309660294, 1.2519364065950405]
] as const;

/**
 * Largest deviation from 1.0 across the twelve row sums of the four AgX
 * matrices. Exported so `tools/grade-probe.mjs` can assert the transposes
 * numerically instead of by inspection; anything above ~1e-4 means a matrix was
 * pasted in column order.
 */
export function agxWhitePreservationError(): number {
  let worst = 0;
  for (const m of [
    LINEAR_SRGB_TO_LINEAR_REC2020,
    LINEAR_REC2020_TO_LINEAR_SRGB,
    AGX_INSET,
    AGX_OUTSET
  ]) {
    for (const row of m) {
      const e = Math.abs(row[0] + row[1] + row[2] - 1);
      if (e > worst) worst = e;
    }
  }
  return worst;
}

/**
 * The 6th-order polynomial fit of AgX's contrast sigmoid, from
 * `agxDefaultContrastApprox` (ToneMappingFunctions.js:147-156). Input and
 * output are the normalised log range, 0..1.
 *
 * Kept as the fit rather than the true sigmoid on purpose: matching three's node
 * EXACTLY is the whole reason to ship AgX rather than roll a lookalike, and the
 * `aces` entry above sets the precedent that a reference look is transcribed,
 * never improved.
 */
function agxContrastSigmoid(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return (
    15.5 * x4 * x2 -
    40.14 * x4 * x +
    31.96 * x4 -
    6.868 * x2 * x +
    0.4298 * x2 +
    0.1191 * x -
    0.00232
  );
}

/**
 * The ASC CDL AgX applies in LOG space, between the normalised encode and the
 * sigmoid — Blender's "look" stage. `agxPunch` is Blender's Punchy verbatim
 * (slope 1, offset 0, power 1.35, saturation 1.4).
 *
 * Saturation is NOT `GradeLook.saturation`'s ratio form: it is the affine
 * `luma + sat·(v − luma)` of the reference, and it is safe here where it was not
 * safe in the `sf` chain, because a log-encoded value is already clamped to
 * [0,1] and the sigmoid that follows is defined on the whole real line. There is
 * no max(x, 0) kink for the LUT to interpolate across.
 *
 * `luma` is sampled BEFORE the CDL, matching the reference implementation. That
 * is load-bearing on neutrals: with power ≠ 1 the pivot is the pre-power
 * luminance, so `saturation` measurably moves mid grey even on a grey card —
 * which is exactly why the two looks' exposure anchors had to be solved with
 * their own saturation in place rather than shared.
 */
export type AgxLook = {
  /** Per-channel log-space gain. */
  readonly slope: readonly [number, number, number];
  /** Log-space offset, applied after slope. */
  readonly offset: number;
  /** Per-channel log-space power. >1 is "punchier". */
  readonly power: readonly [number, number, number];
  /** Bottom of the log window, in log2(linear). three's default: −12.47393. */
  readonly minEv: number;
  /** Top of the log window, in log2(linear). three's default: 4.026069. */
  readonly maxEv: number;
};

/** Plain AgX: the CDL is a bit-exact identity and is skipped entirely. */
export const AGX_NEUTRAL: AgxLook = {
  slope: [1, 1, 1],
  offset: 0,
  power: [1, 1, 1],
  minEv: -12.47393,
  maxEv: 4.026069
};

const agxIsNeutralCdl = (a: AgxLook, saturation: number) =>
  saturation === 1 &&
  a.offset === 0 &&
  a.slope[0] === 1 &&
  a.slope[1] === 1 &&
  a.slope[2] === 1 &&
  a.power[0] === 1 &&
  a.power[1] === 1 &&
  a.power[2] === 1;

/**
 * scene-linear (exposure already applied) → display-LINEAR 0..1. The caller
 * still owes lift, split tone and the OETF — `finishDisplay` does all three, so
 * AgX inherits them for free rather than growing its own copies.
 *
 * Deliberately ignores `contrast`, `white` and `pathToWhite`: the sigmoid owns
 * the toe AND the shoulder here, and the log window owns the path to white.
 * Duplicating them would give two controls that fight over the same slope.
 * `whiteBalance` and `offsetStops` DO apply — they are scene-referred and
 * commute with the transform.
 */
function agxEvaluate(
  look: GradeLook,
  rIn: number,
  gIn: number,
  bIn: number
): [number, number, number] {
  const a = look.agx ?? AGX_NEUTRAL;
  const wb = look.whiteBalance;
  // No contrast pow: with k = 1 the sf expression collapses to exactly this.
  const e = Math.pow(2, look.offsetStops);
  let c = mul3(
    LINEAR_SRGB_TO_LINEAR_REC2020,
    Math.max(rIn, 0) * wb[0] * e,
    Math.max(gIn, 0) * wb[1] * e,
    Math.max(bIn, 0) * wb[2] * e
  );
  c = mul3(AGX_INSET, c[0], c[1], c[2]);

  // 1e-10 rather than 0 so log2 stays finite. Below the window everything
  // clamps to 0 anyway; this only keeps the arithmetic defined.
  const span = a.maxEv - a.minEv;
  c[0] = clamp01((Math.log2(Math.max(c[0], 1e-10)) - a.minEv) / span);
  c[1] = clamp01((Math.log2(Math.max(c[1], 1e-10)) - a.minEv) / span);
  c[2] = clamp01((Math.log2(Math.max(c[2], 1e-10)) - a.minEv) / span);

  if (!agxIsNeutralCdl(a, look.saturation)) {
    const l = luma(c[0], c[1], c[2]);
    const sat = look.saturation;
    for (let i = 0; i < 3; i++) {
      const v = Math.pow(Math.max(c[i] * a.slope[i] + a.offset, 0), a.power[i]);
      c[i] = l + sat * (v - l);
    }
  }

  c[0] = agxContrastSigmoid(c[0]);
  c[1] = agxContrastSigmoid(c[1]);
  c[2] = agxContrastSigmoid(c[2]);

  c = mul3(AGX_OUTSET, c[0], c[1], c[2]);
  // 2.2, not the sRGB EOTF: three's node uses a pure power here and the two
  // differ by ~1 CV in the deep shadows. Transcription over correction.
  c[0] = Math.pow(Math.max(c[0], 0), 2.2);
  c[1] = Math.pow(Math.max(c[1], 0), 2.2);
  c[2] = Math.pow(Math.max(c[2], 0), 2.2);
  c = mul3(LINEAR_REC2020_TO_LINEAR_SRGB, c[0], c[1], c[2]);
  return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])];
}

/* --------------------------------------------------------------- transfer ---
 * three's sRGB OETF, constants included (0.41666, not 1/2.4 — matching the
 * shipped shader matters more than matching the spec, since this replaces it).
 */
export function srgbOETF(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : Math.pow(x, 0.41666) * 1.055 - 0.055;
}

/**
 * The shared display tail: black lift, then split tone, then the OETF. Every
 * curve ends here, which is what lets AgX inherit `lift` and `tint` without
 * knowing they exist.
 *
 * Lift before tint, in that order, is not incidental: lifting first is what
 * makes a tinted shadow actually colour the milky blacks a faded look asks for.
 *
 * Input is display-LINEAR and already clamped to 0..1.
 */
function finishDisplay(
  look: GradeLook,
  rIn: number,
  gIn: number,
  bIn: number,
  out: [number, number, number]
): [number, number, number] {
  let r = rIn;
  let g = gIn;
  let b = bIn;

  const lift = look.lift;
  if (lift > 0) {
    r = r * (1 - lift) + lift;
    g = g * (1 - lift) + lift;
    b = b * (1 - lift) + lift;
  }

  const tintAmount = look.tint;
  if (tintAmount > 0) {
    const l = luma(r, g, b);
    const t = smoothstep(0, 1, l);
    const sh = look.shadowTint;
    const hi = look.highlightTint;
    const tr = sh[0] + (hi[0] - sh[0]) * t;
    const tg = sh[1] + (hi[1] - sh[1]) * t;
    const tb = sh[2] + (hi[2] - sh[2]) * t;
    r = clamp01(r + (r * tr - r) * tintAmount);
    g = clamp01(g + (g * tg - g) * tintAmount);
    b = clamp01(b + (b * tb - b) * tintAmount);
  }

  out[0] = srgbOETF(r);
  out[1] = srgbOETF(g);
  out[2] = srgbOETF(b);
  return out;
}

/**
 * Evaluate a look. Input is scene-linear with exposure ALREADY applied (the
 * shader multiplies before shaping, so the LUT never has to know about the
 * exposure slider). Output is display-referred sRGB in 0..1.
 *
 * Written against a scratch triple rather than allocating: the bake calls this
 * ~110k times per look and the probe calls it millions of times.
 */
export function evaluateLook(
  look: GradeLook,
  rIn: number,
  gIn: number,
  bIn: number,
  out: [number, number, number] = [0, 0, 0]
): [number, number, number] {
  if (look.curve === "aces") {
    const a = acesFilmic([Math.max(rIn, 0), Math.max(gIn, 0), Math.max(bIn, 0)]);
    out[0] = srgbOETF(a[0]);
    out[1] = srgbOETF(a[1]);
    out[2] = srgbOETF(a[2]);
    return out;
  }

  if (look.curve === "agx") {
    const a = agxEvaluate(look, rIn, gIn, bIn);
    return finishDisplay(look, a[0], a[1], a[2], out);
  }

  const wb = look.whiteBalance;
  let r = Math.max(rIn, 0) * wb[0];
  let g = Math.max(gIn, 0) * wb[1];
  let b = Math.max(bIn, 0) * wb[2];

  // ---- log-space contrast about mid grey. Owns the toe, and therefore the
  // blacks. Written as the closed form of log2 → slope+offset → exp2, which is
  // the same three pows the shader would pay for the log round trip anyway.
  const gain = GRADE_PIVOT * Math.pow(2, look.offsetStops);
  const k = look.contrast;
  r = gain * Math.pow(r / GRADE_PIVOT, k);
  g = gain * Math.pow(g / GRADE_PIVOT, k);
  b = gain * Math.pow(b / GRADE_PIVOT, k);

  // ---- saturation while still scene-referred, so pushing chroma feeds the
  // shoulder rather than fighting it.
  //
  // This is a RATIO saturation — c' = l·(c/l)^sat — not the textbook affine
  // mix(l, c, sat), and that choice is forced by the LUT rather than by taste.
  // Affine saturation drives a channel NEGATIVE on ordinary saturated dusk
  // colour (a 1.00/0.81/0.18 orange at sat 1.2 sends blue to −0.034), and the
  // max(x, 0) that has to follow is a C0 kink sitting in the middle of the
  // domain. A trilinear LUT cannot represent a kink: measured error across it
  // was 16 code values, and — the part that actually matters — it erred by
  // ADDING blue back, i.e. by desaturating the exact colour this module exists
  // to keep saturated.
  //
  // The ratio form is unconditionally positive, maps 0 → 0, fixes neutrals
  // exactly, and is smooth for sat > 1. It costs three pow() — which is free,
  // because nothing here runs per pixel. The GPU samples the bake.
  const sat = look.saturation;
  if (sat !== 1) {
    const l = luma(r, g, b);
    if (l > 0) {
      r = l * Math.pow(r / l, sat);
      g = l * Math.pow(g / l, sat);
      b = l * Math.pow(b / l, sat);
    }
  }

  // ---- hue-preserving tonescale. Extended Reinhard on the peak channel:
  //   f(x) = x·(1 + x/W²) / (1 + x)
  // f(0)=0, f'(0)=1 (linear at black, because contrast already shaped the toe),
  // f(W)=1 exactly. One divide, and no piecewise branch to interpolate across.
  const peak = r > g ? (r > b ? r : b) : g > b ? g : b;
  const w = look.white;
  const tm = softMinOne((peak * (1 + peak / (w * w))) / (1 + peak), WHITE_KNEE);

  // Chroma survives untouched: the ratio's peak component is 1 by construction,
  // so the output's peak is exactly `tm` no matter how saturated the input was.
  //
  // peak === 0 must fall through rather than early-out. A look with `lift` has
  // a non-zero limit at the origin, so returning black here put a discontinuity
  // at (0,0,0) — the LUT's first sample said 0 while every neighbour said 67,
  // and `reverie` bled 37 code values of error across the whole near-black
  // cell. Zeroing the reciprocal keeps the ratio finite and lets lift and tint
  // apply exactly as they do everywhere else.
  const inv = peak > 0 ? 1 / peak : 0;
  let rr = r * inv;
  let rg = g * inv;
  let rb = b * inv;

  // ...except where we explicitly ask for bleach. Keyed off the PEAK, not
  // luminance: a saturated highlight and a white one at the same peak should
  // desaturate together, otherwise the sun disc stays orange while the cloud
  // beside it goes white.
  const ptw = look.pathToWhite;
  const bleach = smoothstep(ptw[0], ptw[1], peak) * ptw[2];
  if (bleach > 0) {
    rr += (1 - rr) * bleach;
    rg += (1 - rg) * bleach;
    rb += (1 - rb) * bleach;
  }

  return finishDisplay(look, clamp01(rr * tm), clamp01(rg * tm), clamp01(rb * tm), out);
}

/* ------------------------------------------------------------------ looks ---
 * Eight entries. `goldenState` is the default and the reason this module exists;
 * `aces` and the two `agx` entries are controls. The four between are genuine
 * alternates, not presets of the default — each one changes what the world is
 * ABOUT, which is the point of putting them in the panel rather than
 * hard-coding one grade.
 *
 * WHY `goldenState` KEEPS THE DEFAULT even though AgX is the better-behaved
 * curve: measured chroma retention on the sun surround is ~16.5% for AgX against
 * goldenState's 50.5%, and 4.5% against 16.0% on the sun disc. AgX beats ACES
 * everywhere warm — it halves the +16° hue twist on the gold horizon to +8° —
 * but shipping it as the default would partially reinstate the exact failure the
 * header records as the reason ACES was dropped: a sunset sky bleaching toward
 * white. It ships as a look, not as the look.
 */

function look(l: GradeLook): GradeLook {
  return {
    ...l,
    shadowTint: normaliseTint(l.shadowTint),
    highlightTint: normaliseTint(l.highlightTint),
    whiteBalance: normaliseTint(l.whiteBalance)
  };
}

export const GRADE_LOOKS: readonly GradeLook[] = [
  look({
    id: "goldenState",
    label: "golden state",
    note: "the house grade — the cinema look's character, calibrated to hold neutrals through daylight",
    curve: "sf",
    /**
     * NEUTRAL, and that is the one place this look deliberately parts from
     * `pacificSunset` (the films' grade).
     *
     * The cinema look leans its whole white balance cool (blue 1.075) because
     * a film shoots one hour and can spend a global cast on it. The live world
     * runs the whole clock, and that cast puts a +23 code-value blue split on
     * a NEUTRAL grey card — white stucco reads blue at noon.
     *
     * Measured before changing it: the dusk teal-orange separation this look
     * exists for comes almost entirely from the tints and saturation below,
     * not from white balance. Neutralising it moves dusk sea from a 110 to a
     * 100 blue-minus-red spread — still well above the 84 this look shipped
     * with before the film pass — and leaves the warm band identical (−148).
     * So the cast bought ~9% more dusk teal at the price of every daylight
     * neutral in the city, and this is the trade taken the other way.
     */
    whiteBalance: [1, 1, 1],
    // The film pass's contrast, adopted wholesale: 1.18 read faded, 1.24 was
    // the interim, and 1.32 is where the horizon silhouettes go properly dark
    // without the fog banks clipping. The 0.18 pivot means this deepens the
    // toe and opens the highlights without moving mid-grey, so the exposure
    // anchor below stays solved.
    contrast: 1.32,
    // Solved, not chosen — see the exposure-anchor note on GradeLook.offsetStops.
    offsetStops: 0.519,
    // Ratio saturation, so the extra chroma feeds the shoulder and compresses
    // film-like rather than clipping. This is what keeps dusk water emerald
    // instead of letting the salmon sky reflection wash it grey.
    saturation: 1.42,
    white: 5.5,
    // Later and gentler than the old [3.2, 16, 0.62]: the sky around the disc
    // holds its colour further up the range, so the bleached ball stays
    // compact instead of dilating across a quarter of the sky. The disc itself
    // (peak ≳ 8) still goes white.
    pathToWhite: [3.4, 14.0, 0.5],
    // The teal-orange split the look lives on, and — with white balance now
    // neutral — the only thing producing it. Both are luminance-normalised
    // (hue rotation only) and applied on a luma split, so they colour the
    // sea's shadows and the band's highlights while leaving mid neutrals
    // alone. That property is exactly why they can be this strong.
    shadowTint: [0.82, 1.0, 1.2],
    highlightTint: [1.13, 1.0, 0.8],
    tint: 0.52,
    lift: 0
  }),
  look({
    id: "pacificSunset",
    label: "pacific sunset",
    note: "the cinema grade — emerald sea against an amber band, deep silhouettes, a compact bright disc",
    curve: "sf",
    // The load-bearing control of this look. The sunset sky model paints the
    // whole hemisphere warm, and a split tone cannot cool a mid-luminance
    // zenith — so the COOL comes from white balance across the board, and
    // the warm band comes back through the highlight tint and path-to-white.
    // Teal-orange the honest way round.
    whiteBalance: [0.955, 1.0, 1.075],
    // Past goldenState's 1.24 on purpose: films can spend contrast the live
    // game cannot, because a shot chooses what falls into its toe.
    contrast: 1.32,
    // Same pivot anchor as the house look — mid-grey is untouched by
    // contrast/saturation/tints, so the solved offset carries over.
    offsetStops: 0.519,
    saturation: 1.42,
    white: 5.5,
    // A LATER path-to-white than the house look: the sky around the disc
    // holds its color further up the brightness range, so the bleached ball
    // stays compact instead of dilating across a quarter of the sky.
    pathToWhite: [3.4, 14.0, 0.5],
    // The reference frame's whole identity is this split: deep teal in the
    // sea's shadows, amber in the band.
    shadowTint: [0.82, 1.0, 1.2],
    highlightTint: [1.13, 1.0, 0.8],
    tint: 0.52,
    lift: 0
  }),
  look({
    id: "clearEye",
    label: "clear eye",
    note: "hue-preserving, no look transform — the honest render, and the calibration reference",
    curve: "sf",
    whiteBalance: [1, 1, 1],
    contrast: 1.0,
    offsetStops: 0.485,
    saturation: 1.0,
    white: 6.0,
    pathToWhite: [2.0, 12.0, 0.75],
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    tint: 0,
    lift: 0
  }),
  look({
    id: "slideFilm",
    label: "slide film",
    note: "reversal-stock punch — deep blues, hot chroma, a short shoulder that clips proudly",
    curve: "sf",
    whiteBalance: [1.0, 1.0, 1.02],
    contrast: 1.34,
    offsetStops: 0.535,
    saturation: 1.42,
    // A short white point is what makes slide film slide film: highlights run
    // out of headroom early instead of rolling gently forever.
    white: 4.0,
    pathToWhite: [4.0, 18.0, 0.4],
    shadowTint: [0.9, 0.97, 1.16],
    highlightTint: [1.05, 1.0, 0.93],
    tint: 0.42,
    lift: 0
  }),
  look({
    id: "silver",
    label: "silver",
    note: "bleach bypass — chroma pulled out, contrast pushed in; built for fog days",
    curve: "sf",
    whiteBalance: [1, 1, 1],
    contrast: 1.45,
    offsetStops: 0.56,
    saturation: 0.42,
    white: 8.0,
    pathToWhite: [3.0, 14.0, 0.8],
    shadowTint: [0.95, 0.99, 1.06],
    highlightTint: [1.02, 1.0, 0.98],
    tint: 0.3,
    lift: 0
  }),
  look({
    id: "reverie",
    label: "reverie",
    note: "faded pastel — milky lifted blacks, soft contrast, warm air",
    curve: "sf",
    whiteBalance: [1.03, 1.0, 0.97],
    contrast: 0.9,
    offsetStops: -0.027,
    saturation: 1.12,
    white: 7.0,
    pathToWhite: [2.4, 11.0, 0.66],
    shadowTint: [1.05, 0.99, 1.02],
    highlightTint: [1.04, 1.0, 0.94],
    tint: 0.45,
    // The one look with a real lift. Blacks stop at ~7% and the whole world
    // reads like a memory of itself.
    lift: 0.055
  }),
  look({
    id: "agx",
    label: "AgX",
    note: "three's AgX verbatim — the gentlest shoulder here, and the least chroma through it",
    curve: "agx",
    whiteBalance: [1, 1, 1],
    // Ignored by the agx curve; the sigmoid owns contrast and the log window
    // owns the path to white. Left at the neutral values so a diff reads clean.
    contrast: 1,
    // SOLVED, not chosen. Bisected so linear 0.18 lands at display-linear
    // 0.206785 — exactly where goldenState's peak channel lands it. That is the
    // "switching looks changes character, not brightness" contract; without it
    // every A/B is confounded by one option simply being brighter.
    offsetStops: -0.066,
    // The AgX CDL's affine saturation. 1.0 = plain AgX, and the neutral-CDL fast
    // path in agxEvaluate then makes this bit-identical to three's node.
    saturation: 1.0,
    white: 1,
    pathToWhite: [0, 1, 0],
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    tint: 0,
    lift: 0
  }),
  look({
    id: "agxPunch",
    label: "AgX punch",
    note: "AgX with Blender's Punchy CDL — same shoulder, steeper mids, more chroma",
    curve: "agx",
    whiteBalance: [1, 1, 1],
    contrast: 1,
    // SOLVED against the same anchor, and it has to be solved SEPARATELY rather
    // than shared with `agx`: the CDL takes its saturation pivot from the
    // pre-power luminance, so `saturation` moves mid grey even on a grey card
    // once `power` ≠ 1. +1.77 stops is what power 1.35 costs at the pivot.
    //
    // The price, stated so nobody rediscovers it as a bug: pushing the scene
    // 3.4× before a FIXED log window spends 1.77 stops of highlight headroom, so
    // this look hard-clips at ~4.8 scene-linear where plain `agx` clips at ~17.
    // Measured on the neutral ramp that is less dramatic than it sounds —
    // goldenState is already at 0.993 by linear 4 — but above 4.8 AgX punch
    // carries no information at all, so judge it on the sun disc before
    // promoting it anywhere.
    offsetStops: 1.771313,
    saturation: 1.4,
    white: 1,
    pathToWhite: [0, 1, 0],
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    tint: 0,
    lift: 0,
    // Blender's "Punchy" look, verbatim.
    agx: { slope: [1, 1, 1], offset: 0, power: [1.35, 1.35, 1.35], minEv: -12.47393, maxEv: 4.026069 }
  }),
  look({
    id: "aces",
    label: "ACES (legacy)",
    note: "the curve that shipped before the grade landed — kept as the A/B reference",
    curve: "aces",
    whiteBalance: [1, 1, 1],
    contrast: 1,
    offsetStops: 0,
    saturation: 1,
    white: 1,
    pathToWhite: [0, 1, 0],
    shadowTint: [1, 1, 1],
    highlightTint: [1, 1, 1],
    tint: 0,
    lift: 0
  })
];

export const DEFAULT_GRADE_ID = "goldenState";

export function findLook(id: string): GradeLook {
  return GRADE_LOOKS.find((l) => l.id === id) ?? GRADE_LOOKS[0];
}

/** `{ label: id }`, the shape tweakpane's `options` wants. */
export function gradeOptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of GRADE_LOOKS) out[l.label] = l.id;
  return out;
}
