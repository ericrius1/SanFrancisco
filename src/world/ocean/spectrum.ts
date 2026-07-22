/**
 * Oceanographic wave spectrum for the FFT detail cascades (CPU side).
 *
 * Generates the time-zero complex spectrum h0(k) per cascade from a JONSWAP
 * wind-sea spectrum with cos-power directional spreading, band-limited so each
 * wavelength lives in exactly one cascade and everything longer than
 * HERO_MAX_WAVELENGTH stays owned by the analytic hero band (the CPU/GPU swell
 * twin that boats and boards physically ride — see heightmap.waterHeight()).
 * The FFT cascades are VISUAL-ONLY detail on top of that contract.
 *
 * Deterministic: a fixed-seed PRNG so every session (and the CPU hero band, if
 * it ever wants to mirror components) sees the same ocean.
 */

export interface CascadeSpec {
  /** World-space tile size in metres. Chosen mutually irrational-ish so the
   *  three tiles never phase-align into visible moiré/repetition. */
  patchSize: number;
  /** Band limits as wavelengths (m); energy outside [minWavelength, maxWavelength) is zeroed. */
  maxWavelength: number;
  minWavelength: number;
  /** Horizontal (choppy) displacement multiplier for this band. */
  choppiness: number;
  /** How much this band's Jacobian folding contributes to foam. The finest
   *  band folds constantly at texel scale — it must not paint foam alone. */
  foamWeight: number;
}

export interface OceanSpectrumConfig {
  /** Texture resolution per cascade (power of two). */
  size: number;
  /** Wind speed at 10 m (m/s) — drives JONSWAP peak + energy. */
  windSpeed: number;
  /** Direction the wind blows TOWARD, radians in world XZ (0 = +x). */
  windDirection: number;
  /** Fetch in metres (how far the wind has blown over open water). */
  fetch: number;
  /** cos^(2s) directional concentration exponent s. */
  directionality: number;
  /** 0..1 blend toward fully isotropic spread (keeps some cross-sea). */
  isotropicMix: number;
  /** Energy multiplier for waves travelling against the wind. */
  opposingDamp: number;
  /** Global visual amplitude scale applied at generation. The detail bands
   *  only carry the JONSWAP tail (the ~108 m peak is the hero band's domain),
   *  so this runs hot to keep open water lively without touching physics. */
  amplitude: number;
  seed: number;
  cascades: CascadeSpec[];
  /** Lab-only: replace every spectrum with a single travelling wave at bin
   *  (N/2+cyclesX, N/2+cyclesZ) — a numeric FFT correctness probe (expect
   *  exactly `cyclesX` wave periods across each patch). */
  debugDelta?: { cyclesX: number; cyclesZ: number; amplitude: number };
}

/** Longest wavelength the FFT bands may carry; everything above is the analytic
 *  hero band's domain (physics-visible swell). Keep in sync with the comment in
 *  tslUtil.ts if the hero band ever changes character. */
export const HERO_MAX_WAVELENGTH = 42;

export const DEFAULT_OCEAN_SPECTRUM: OceanSpectrumConfig = {
  size: 256,
  windSpeed: 9.2,
  // SF: prevailing westerly pushes sea toward the city (+x is east in world
  // space — Ocean Beach sits at x≈−6300 and the bay east of it).
  windDirection: 0.22,
  fetch: 260_000,
  directionality: 5,
  isotropicMix: 0.18,
  opposingDamp: 0.08,
  amplitude: 1.4,
  seed: 1337,
  cascades: [
    { patchSize: 210.7, maxWavelength: HERO_MAX_WAVELENGTH, minWavelength: 9.7, choppiness: 0.8, foamWeight: 1 },
    { patchSize: 51.37, maxWavelength: 9.7, minWavelength: 2.31, choppiness: 0.88, foamWeight: 0.55 },
    { patchSize: 12.129, maxWavelength: 2.31, minWavelength: 0.55, choppiness: 0.92, foamWeight: 0.18 }
  ]
};

export interface CascadeSpectrum {
  spec: CascadeSpec;
  /** Packed vec4 per bin: (h0(k).re, h0(k).im, conj(h0(−k)).re, conj(h0(−k)).im). */
  h0: Float32Array;
  /** Σ k²·E[|h|²] — analytic slope variance of the band, feeds the
   *  distance-roughness (LEADR-lite) ramp when this band's texels fall below
   *  pixel footprint. */
  slopeVariance: number;
  /** Σ E[|h|²] — height variance (metres², for debug/bounds). */
  heightVariance: number;
}

const G = 9.81;

/** mulberry32 — tiny deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** JONSWAP frequency spectrum S(ω) for wind speed U and fetch F. */
function jonswap(omega: number, U: number, F: number): number {
  if (omega <= 0) return 0;
  const alpha = 0.076 * Math.pow((U * U) / (F * G), 0.22);
  const omegaP = 22 * Math.pow((G * G) / (U * F), 1 / 3);
  const sigma = omega <= omegaP ? 0.07 : 0.09;
  const r = Math.exp(-((omega - omegaP) ** 2) / (2 * sigma * sigma * omegaP * omegaP));
  const gamma = 3.3;
  return (
    ((alpha * G * G) / omega ** 5) *
    Math.exp(-1.25 * (omegaP / omega) ** 4) *
    Math.pow(gamma, r)
  );
}

/**
 * Build the packed h0 spectrum + analytic variances for every cascade.
 * ~256²×3 bins ≈ 200k iterations of plain math — a few ms, run once (or on a
 * budget slice) at ocean construction.
 */
export function buildCascadeSpectra(config: OceanSpectrumConfig): CascadeSpectrum[] {
  const N = config.size;
  const rand = mulberry32(config.seed);

  // Box–Muller pairs, deterministic across cascades in generation order.
  const gaussian = (): number => {
    const u1 = Math.max(rand(), 1e-9);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };

  // Normalize the directional model numerically so total energy is independent
  // of the directionality/isotropicMix knobs.
  const dirSamples = 256;
  let dirNorm = 0;
  for (let i = 0; i < dirSamples; i++) {
    const th = (i / dirSamples) * 2 * Math.PI - Math.PI;
    dirNorm += directionalWeight(th, config);
  }
  dirNorm *= (2 * Math.PI) / dirSamples;

  return config.cascades.map((spec) => {
    const L = spec.patchSize;
    const dk = (2 * Math.PI) / L;
    const kMin = (2 * Math.PI) / spec.maxWavelength;
    const kMax = (2 * Math.PI) / spec.minWavelength;
    // Soft band edges (≈8% feather) so adjacent cascades cross-fade in k-space
    // instead of butting hard cutoffs (hard edges ring as faint banding).
    const kMinLo = kMin * 0.96;
    const kMinHi = kMin * 1.04;
    const kMaxLo = kMax * 0.96;
    const kMaxHi = kMax * 1.04;

    // First pass: raw amplitudes (needed to pair ±k afterwards).
    const amps = new Float32Array(N * N * 2); // (re, im) of h0(k)
    let slopeVariance = 0;
    let heightVariance = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const kx = (i - N / 2) * dk;
        const kz = (j - N / 2) * dk;
        const k = Math.hypot(kx, kz);
        const idx = (j * N + i) * 2;
        // Every bin consumes its Gaussian pair even when masked, so band edits
        // never reshuffle the phases of every other wave (stable look while
        // tuning).
        const gr = gaussian();
        const gi = gaussian();
        if (k < 1e-6) continue;
        const band =
          smooth01((k - kMinLo) / (kMinHi - kMinLo)) *
          (1 - smooth01((k - kMaxLo) / (kMaxHi - kMaxLo)));
        if (band <= 0) continue;
        const omega = Math.sqrt(G * k);
        const dOmegaDk = G / (2 * omega);
        const theta = Math.atan2(kz, kx);
        const spread = directionalWeight(theta, config) / dirNorm;
        // 2D wavenumber spectrum from the 1D frequency spectrum.
        const S2 = ((jonswap(omega, config.windSpeed, config.fetch) * spread * dOmegaDk) / k) * band;
        const amp = Math.sqrt(2 * S2 * dk * dk) * config.amplitude;
        const re = (amp / Math.SQRT2) * gr;
        const im = (amp / Math.SQRT2) * gi;
        amps[idx] = re;
        amps[idx + 1] = im;
        const e = re * re + im * im;
        heightVariance += e;
        slopeVariance += e * k * k;
      }
    }

    if (config.debugDelta) {
      amps.fill(0);
      const { cyclesX, cyclesZ, amplitude } = config.debugDelta;
      const bi = N / 2 + cyclesX;
      const bj = N / 2 + cyclesZ;
      amps[(bj * N + bi) * 2] = amplitude;
      slopeVariance = 0;
      heightVariance = amplitude * amplitude;
    }

    // Second pass: pack with the mirrored conjugate partner for the evolve
    // kernel — h(k,t) = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt}.
    const h0 = new Float32Array(N * N * 4);
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const idx = j * N + i;
        const mi = (N - i) % N;
        const mj = (N - j) % N;
        const midx = mj * N + mi;
        h0[idx * 4] = amps[idx * 2];
        h0[idx * 4 + 1] = amps[idx * 2 + 1];
        h0[idx * 4 + 2] = amps[midx * 2];
        h0[idx * 4 + 3] = -amps[midx * 2 + 1];
      }
    }

    return { spec, h0, slopeVariance, heightVariance };
  });
}

function directionalWeight(theta: number, config: OceanSpectrumConfig): number {
  let d = theta - config.windDirection;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  const c = Math.abs(Math.cos(d / 2));
  let w = Math.pow(c, 2 * config.directionality);
  // Waves running against the wind carry a sliver of energy, not half.
  if (Math.abs(d) > Math.PI / 2) w *= config.opposingDamp;
  return w * (1 - config.isotropicMix) + config.isotropicMix / (2 * Math.PI);
}

function smooth01(x: number): number {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
}
