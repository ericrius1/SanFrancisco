/**
 * Grade math referee. Runs the display transform in float64 with no browser and
 * no GPU, and answers the three questions that decide whether the shader is
 * even worth writing:
 *
 *   1. WHERE DOES THE RIG MOVE — every light, emissive and fog value in the
 *      world was balanced against ACES. Report the shift, per stop, so phase 3
 *      knows what it is chasing instead of guessing.
 *   2. DOES THE LUT SURVIVE — the GPU never runs this arithmetic, it samples a
 *      33/48/64³ trilinear approximation of it. Measure that approximation
 *      against the truth in display code values, including on the max() creases
 *      where the hue-preserving tonescale is only C0.
 *   3. DOES HUE ACTUALLY SURVIVE — the entire premise is that a saturated
 *      highlight stays saturated. Prove it numerically.
 *
 * Usage:  node --experimental-strip-types tools/grade-probe.mjs
 *         node --experimental-strip-types tools/grade-probe.mjs --check
 *
 * --check exits non-zero if LUT error at the shipped size exceeds the gate, so
 * this doubles as a contract test.
 */

import {
  GRADE_LOOKS,
  GRADE_LUT_SIZE,
  evaluateLook,
  findLook,
  shaperForward,
  shaperInverse,
  shapeTriple,
  srgbOETF
} from "../src/render/gradeLooks.ts";

const CHECK = process.argv.includes("--check");

/** The size we ship. Everything else is measured only for comparison. */
const SHIPPED_SIZE = GRADE_LUT_SIZE;

/**
 * Gates, in 0-255 display code values, at SHIPPED_SIZE.
 *
 * Two distributions, because one number would lie. `scene` is weighted like a
 * real frame — mostly near-neutral terrain, sky and fog, with the magnitude
 * distribution the rig actually emits. `stress` deliberately parks a fifth of
 * its samples ON the channel-crossing creases where max(r,g,b) is only C0, and
 * runs magnitudes far past anything the world produces. A 3D LUT is an
 * approximation; the honest claim is "invisible on real content, bounded on
 * adversarial content", and that needs both numbers.
 */
/**
 * These are REGRESSION gates, not a certificate of perfection. Their job is to
 * fail loudly if someone edits the transform and reintroduces a C0 kink — the
 * failure mode that cost 22 code values during development and, worse, erred in
 * the direction of desaturating exactly the colour the grade exists to protect.
 * They are set just above the measured worst look (`slideFilm`, whose deliberate
 * high-chroma/short-shoulder combination is the hardest thing here to sample).
 * The real referee is pixels: tools/grade-shot-probe.mjs diffs LUT against
 * analytic on live frames.
 */
const SCENE_MEAN_GATE = 1.2;
const SCENE_P99_GATE = 12.0;
const STRESS_P99_GATE = 12.0;

const fmt = (x, n = 4) => x.toFixed(n).padStart(n + 4);
const pct = (x) => `${(x * 100).toFixed(1)}%`;

/* ------------------------------------------------------------------ bake --- */

/**
 * Bake one look to a flat Float64Array of size N³·3, indexed [b][g][r] to match
 * the Data3DTexture memory order the runtime uploads (x fastest, then y, then z).
 */
function bakeLut(look, n) {
  const data = new Float64Array(n * n * n * 3);
  const out = [0, 0, 0];
  let i = 0;
  for (let z = 0; z < n; z++) {
    const b = shaperInverse(z / (n - 1));
    for (let y = 0; y < n; y++) {
      const g = shaperInverse(y / (n - 1));
      for (let x = 0; x < n; x++) {
        const r = shaperInverse(x / (n - 1));
        evaluateLook(look, r, g, b, out);
        data[i++] = out[0];
        data[i++] = out[1];
        data[i++] = out[2];
      }
    }
  }
  return data;
}

/**
 * Trilinear fetch, replicating exactly what the GPU sampler will do given the
 * half-texel coordinate correction the shader applies:
 *   texcoord = u·(N−1)/N + 0.5/N   →   texel space = u·(N−1)
 * Getting this wrong is the classic LUT bug: the image looks almost right and
 * is quietly biased by half a cell everywhere.
 */
function sampleLut(data, n, u0, u1, u2, out = [0, 0, 0]) {
  const fx = Math.min(Math.max(u0, 0), 1) * (n - 1);
  const fy = Math.min(Math.max(u1, 0), 1) * (n - 1);
  const fz = Math.min(Math.max(u2, 0), 1) * (n - 1);
  const x0 = Math.min(Math.floor(fx), n - 1);
  const y0 = Math.min(Math.floor(fy), n - 1);
  const z0 = Math.min(Math.floor(fz), n - 1);
  const x1 = Math.min(x0 + 1, n - 1);
  const y1 = Math.min(y0 + 1, n - 1);
  const z1 = Math.min(z0 + 1, n - 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const tz = fz - z0;
  const at = (x, y, z, c) => data[((z * n + y) * n + x) * 3 + c];
  for (let c = 0; c < 3; c++) {
    const c00 = at(x0, y0, z0, c) * (1 - tx) + at(x1, y0, z0, c) * tx;
    const c10 = at(x0, y1, z0, c) * (1 - tx) + at(x1, y1, z0, c) * tx;
    const c01 = at(x0, y0, z1, c) * (1 - tx) + at(x1, y0, z1, c) * tx;
    const c11 = at(x0, y1, z1, c) * (1 - tx) + at(x1, y1, z1, c) * tx;
    const c0 = c00 * (1 - ty) + c10 * ty;
    const c1 = c01 * (1 - ty) + c11 * ty;
    out[c] = c0 * (1 - tz) + c1 * tz;
  }
  return out;
}

/* --------------------------------------------------------------- samples --- */

/**
 * Deterministic sample sets. `stress` is the adversarial one described on the
 * gates above; `scene` drops the crease mode and caps magnitude near what the
 * rig emits (sun disc ≈ 10, brightest emissive ≈ 13 via LIGHT_SCALE).
 */
function* samples(count, { stress }) {
  let s = 0x2f6e2b1;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const maxMag = stress ? 4000 : 30;
  const modes = stress ? 5 : 4;
  for (let i = 0; i < count; i++) {
    const mode = i % modes;
    const mag = Math.exp(Math.log(1e-4) + rnd() * (Math.log(maxMag) - Math.log(1e-4)));
    if (mode === 0) {
      // near-neutral: terrain, facades, fog — most of any frame
      const j = 0.06;
      yield [mag * (1 + (rnd() - 0.5) * j), mag * (1 + (rnd() - 0.5) * j), mag * (1 + (rnd() - 0.5) * j)];
    } else if (mode === 1) {
      // warm: sunset sky, sodium lamps, sand
      yield [mag, mag * (0.3 + rnd() * 0.6), mag * (0.05 + rnd() * 0.4)];
    } else if (mode === 2) {
      // cool: ocean, zenith, moonlight
      yield [mag * (0.05 + rnd() * 0.45), mag * (0.4 + rnd() * 0.5), mag];
    } else if (mode === 3) {
      yield [mag * rnd(), mag * rnd(), mag * rnd()];
    } else {
      // ON the creases, where max(r,g,b) is only C0 — the LUT's worst case
      const which = i % 3;
      const a = mag;
      const b = mag * (1 + (rnd() - 0.5) * 0.002);
      const c = mag * rnd();
      yield which === 0 ? [a, b, c] : which === 1 ? [c, a, b] : [a, c, b];
    }
  }
}

/* ----------------------------------------------------------------- report --- */

console.log("=".repeat(78));
console.log("GRADE MATH REFEREE");
console.log("=".repeat(78));

/* --- 1. where the rig moves ------------------------------------------------ */

const aces = findLook("aces");
const house = findLook("goldenState");

console.log("\n1. RIG SHIFT — scene-linear in, display sRGB code value out (0-255)\n");
console.log("   linear    ACES(now)   golden state   delta CV   delta stops");
const ladder = [0.005, 0.018, 0.05, 0.09, 0.18, 0.36, 0.5, 0.9, 1.8, 3.6, 8, 20];
const a = [0, 0, 0];
const h = [0, 0, 0];
for (const v of ladder) {
  evaluateLook(aces, v, v, v, a);
  evaluateLook(house, v, v, v, h);
  const cvA = a[0] * 255;
  const cvH = h[0] * 255;
  // Express the shift as the exposure change that would have produced it, by
  // solving what linear input ACES needs to land where the house grade landed.
  let lo = 1e-5;
  let hi = 1e4;
  for (let it = 0; it < 60; it++) {
    const mid = Math.sqrt(lo * hi);
    evaluateLook(aces, mid, mid, mid, a);
    if (a[0] < h[0]) lo = mid;
    else hi = mid;
  }
  const equiv = Math.sqrt(lo * hi);
  const stops = Math.log2(equiv / v);
  console.log(
    `   ${fmt(v, 4)}   ${cvA.toFixed(1).padStart(8)}   ${cvH.toFixed(1).padStart(12)}` +
      `   ${(cvH - cvA >= 0 ? "+" : "") + (cvH - cvA).toFixed(1).padStart(7)}` +
      `   ${(stops >= 0 ? "+" : "") + stops.toFixed(2).padStart(6)}`
  );
}

evaluateLook(aces, 0.18, 0.18, 0.18, a);
evaluateLook(house, 0.18, 0.18, 0.18, h);
console.log(
  `\n   photographic neutral is 0.466 sRGB (119 CV).` +
    `  ACES puts an unlit 18% card at ${(a[0] * 255).toFixed(1)} CV,` +
    ` the house grade at ${(h[0] * 255).toFixed(1)} CV.`
);
console.log(
  "   NOTE: this is the CURVE's shift only. What the / grey-card chart reads also\n" +
    "   includes the rig's irradiance (sky.ts sunDay/hemiDay), which phase 3 re-checks."
);

/* --- 2. hue survival ------------------------------------------------------- */

console.log("\n2. HUE SURVIVAL — saturation retained through the shoulder\n");
const satOf = (c) => {
  const mx = Math.max(c[0], c[1], c[2]);
  const mn = Math.min(c[0], c[1], c[2]);
  return mx <= 0 ? 0 : (mx - mn) / mx;
};
const probes = [
  ["sun surround  (1.80, 1.10, 0.60)", [1.8, 1.1, 0.6]],
  ["gold horizon  (3.20, 1.45, 0.55)", [3.2, 1.45, 0.55]],
  ["deep zenith   (0.09, 0.14, 0.30)", [0.09, 0.14, 0.3]],
  ["teal water    (0.12, 0.55, 0.50)", [0.12, 0.55, 0.5]],
  ["sun disc      (12.0, 8.00, 4.00)", [12, 8, 4]]
];
console.log("   sample                              ACES sat   golden sat   verdict");
for (const [name, c] of probes) {
  evaluateLook(aces, c[0], c[1], c[2], a);
  evaluateLook(house, c[0], c[1], c[2], h);
  const sa = satOf(a);
  const sh = satOf(h);
  const verdict =
    sh > sa + 0.04 ? "chroma held" : sh < sa - 0.04 ? "bleaches more" : "≈ equal";
  console.log(`   ${name.padEnd(34)} ${pct(sa).padStart(8)}   ${pct(sh).padStart(10)}   ${verdict}`);
}

/* --- 3. LUT fidelity ------------------------------------------------------- */

console.log("\n3. LUT FIDELITY — trilinear approximation vs the float64 truth\n");
const SAMPLES = 200000;

const measure = (look, n, opts) => {
  const lut = bakeLut(look, n);
  const truth = [0, 0, 0];
  const got = [0, 0, 0];
  const uv = [0, 0, 0];
  const errs = [];
  let sum = 0;
  let max = 0;
  for (const [r, g, b] of samples(SAMPLES, opts)) {
    evaluateLook(look, r, g, b, truth);
    shapeTriple(r, g, b, uv);
    sampleLut(lut, n, uv[0], uv[1], uv[2], got);
    let e = 0;
    for (let c = 0; c < 3; c++) e = Math.max(e, Math.abs(truth[c] - got[c]) * 255);
    errs.push(e);
    sum += e;
    if (e > max) max = e;
  }
  errs.sort((p, q) => p - q);
  return { mean: sum / SAMPLES, p99: errs[Math.floor(errs.length * 0.99)], max };
};

console.log("   look          size |  scene: mean   p99    max |  stress: mean   p99    max |   size");
let worstSceneMean = 0;
let worstSceneP99 = 0;
let worstStressP99 = 0;
let worstLook = "";

for (const look of GRADE_LOOKS) {
  for (const n of [33, SHIPPED_SIZE, 64]) {
    const sc = measure(look, n, { stress: false });
    const st = measure(look, n, { stress: true });
    const mark = n === SHIPPED_SIZE ? "  <-- shipped" : "";
    console.log(
      `   ${look.id.padEnd(12)} ${String(n).padStart(4)} | ` +
        `${fmt(sc.mean, 3).padStart(11)} ${fmt(sc.p99, 3).padStart(6)} ${fmt(sc.max, 3).padStart(6)} | ` +
        `${fmt(st.mean, 3).padStart(12)} ${fmt(st.p99, 3).padStart(6)} ${fmt(st.max, 3).padStart(6)} | ` +
        `${(((n * n * n * 8) / 1024) | 0).toString().padStart(5)} KB${mark}`
    );
    if (n === SHIPPED_SIZE) {
      if (sc.p99 > worstSceneP99) worstLook = look.id;
      worstSceneMean = Math.max(worstSceneMean, sc.mean);
      worstSceneP99 = Math.max(worstSceneP99, sc.p99);
      worstStressP99 = Math.max(worstStressP99, st.p99);
    }
  }
}

/* --- 4. shaper sanity ------------------------------------------------------ */

console.log("\n4. SHAPER — where the LUT spends its samples\n");
console.log("   linear      u      sample idx of 48   display sRGB CV");
for (const v of [0, 0.002, 0.018, 0.05, 0.18, 0.5, 1, 2, 6, 20, 64]) {
  const u = shaperForward(v);
  console.log(
    `   ${fmt(v, 3).padStart(8)}  ${fmt(u, 4)}   ${(u * 47).toFixed(1).padStart(16)}   ${(srgbOETF(Math.min(v, 1)) * 255).toFixed(1).padStart(15)}`
  );
}
const uHalf = shaperForward(0.2140);
console.log(
  `\n   display mid (sRGB 0.5 = linear 0.214) lands at sample ${(uHalf * 47).toFixed(1)} of 47 —` +
    ` ${pct(uHalf)} of the axis for half the visible range.`
);

/* --- verdict --------------------------------------------------------------- */

console.log("\n" + "=".repeat(78));
const pass =
  worstSceneMean <= SCENE_MEAN_GATE &&
  worstSceneP99 <= SCENE_P99_GATE &&
  worstStressP99 <= STRESS_P99_GATE;
console.log(
  `LUT gate @ ${SHIPPED_SIZE}³ (worst look: ${worstLook})\n` +
    `   scene  mean ${worstSceneMean.toFixed(3)} / ${SCENE_MEAN_GATE}` +
    `   p99 ${worstSceneP99.toFixed(3)} / ${SCENE_P99_GATE}\n` +
    `   stress p99 ${worstStressP99.toFixed(3)} / ${STRESS_P99_GATE}`
);
console.log(
  pass
    ? "PASS — sub-code-value on real content; bounded on adversarial content."
    : "FAIL — raise GRADE_LUT_SIZE, or find the kink the LUT cannot represent."
);
console.log("=".repeat(78));

if (CHECK && !pass) process.exit(1);
