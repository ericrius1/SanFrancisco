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
 * Caveat, deliberate: the legacy `aces` look is per-channel and never becomes
 * scale-invariant, so the guard is approximate for it above 28 linear. That
 * region is display-white in every channel, the look exists only as an A/B
 * reference, and no measured scene value reaches it.
 */
export const SHAPER_MAX = 28;

/**
 * Normalises the curve so u(SHAPER_MAX) is exactly 1 and the axis is fully
 * used. Without it the top of the LUT is dead range.
 */
const SHAPER_NORM = (Math.sqrt(SHAPER_MAX) + SHAPER_A) / Math.sqrt(SHAPER_MAX);

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
   * `sf` runs the hue-preserving chain below. `aces` runs three's stock
   * ACESFilmic verbatim and ignores every other field — it exists so the look
   * that shipped before this module stays one dropdown click away, which is the
   * only honest way to judge a grade change.
   */
  readonly curve: "sf" | "aces";
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

/* --------------------------------------------------------------- transfer ---
 * three's sRGB OETF, constants included (0.41666, not 1/2.4 — matching the
 * shipped shader matters more than matching the spec, since this replaces it).
 */
export function srgbOETF(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : Math.pow(x, 0.41666) * 1.055 - 0.055;
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

  r = clamp01(rr * tm);
  g = clamp01(rg * tm);
  b = clamp01(rb * tm);

  // ---- black lift, then split tone, in that order: lifting first means a
  // tinted shadow actually colours the milky blacks a faded look asks for.
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

/* ------------------------------------------------------------------ looks ---
 * Six entries. `goldenState` is the default and the reason this module exists;
 * `aces` is the control. The four between are genuine alternates, not presets
 * of the default — each one changes what the world is ABOUT, which is the point
 * of putting them in the panel rather than hard-coding one grade.
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
    note: "the house grade — saturated dusk, cool shadows, highlights that keep their hue",
    curve: "sf",
    whiteBalance: [1.015, 1.0, 0.975],
    // 1.18 is where the horizon reads as a silhouette against the water instead
    // of a grey shape. Past ~1.3 the fog banks start clipping to black.
    contrast: 1.18,
    // Solved, not chosen — see the exposure-anchor note on GradeLook.offsetStops.
    offsetStops: 0.519,
    saturation: 1.2,
    white: 6.0,
    // The sun disc (peak ≳ 8) still bleaches to white. The sky wedge around it
    // (peak ≈ 1.3–3) does not — that gap is the entire look.
    pathToWhite: [3.2, 16.0, 0.62],
    shadowTint: [0.93, 0.985, 1.1],
    highlightTint: [1.06, 1.0, 0.9],
    tint: 0.34,
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
