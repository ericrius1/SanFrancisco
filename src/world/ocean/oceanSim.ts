import * as THREE from "three/webgpu";
import {
  Fn,
  cos,
  float,
  instancedArray,
  instanceIndex,
  ivec2,
  localId,
  max,
  saturate,
  sin,
  sqrt,
  texture,
  uint,
  uniform,
  vec2,
  vec4,
  workgroupArray,
  workgroupBarrier,
  workgroupId,
  textureStore
} from "three/tsl";
import {
  buildCascadeSpectra,
  DEFAULT_OCEAN_SPECTRUM,
  type CascadeSpec,
  type OceanSpectrumConfig
} from "./spectrum";
import { setHeroWaves, type HeroStripGate } from "./heroWaves";
import { OCEAN_BEACH_SURF } from "../oceanBeachWaves";

/** Ocean Beach strip gate: the spectral physics band yields to the authored
 *  surf train inside it. CPU (heroWaves) and GPU (water.ts vertex) both apply
 *  this exact rectangle+feather — keep them identical. */
export const HERO_STRIP_GATE: HeroStripGate = {
  minX: OCEAN_BEACH_SURF.minX,
  maxX: OCEAN_BEACH_SURF.maxX,
  minZ: OCEAN_BEACH_SURF.minZ,
  maxZ: OCEAN_BEACH_SURF.maxZ,
  feather: 60
};

/**
 * GPU spectral ocean: 3 FFT cascades of wind-sea detail simulated in compute
 * and delivered as small repeat-wrapped textures the bay material samples.
 *
 *   evolve   — time-propagate the packed h0 spectrum (dispersion ω=√(gk)) and
 *              derive all 8 real fields (displacement xyz, slopes, Jacobian
 *              terms) as 4 complex signals Hermitian-packed into 2 vec4
 *              storage buffers.
 *   fftH/V   — inverse 2D FFT: Stockham radix-2, one workgroup per row, all 8
 *              butterfly stages in workgroup shared memory (2 dispatches per
 *              buffer, no global ping-pong, in-place per pass).
 *   assemble — checkerboard sign fix-up, Jacobian folding → foam injection
 *              into a persistent accumulation buffer, and the final
 *              rgba16float texture writes:
 *                dispTex  = (Dx·λ, Dy, Dz·λ, J)
 *                derivTex = (slopeX, slopeZ, crest=1−J, foam)
 *
 * The dispatch kernels use dispatchSize arrays (not counts) so no bounds guard
 * is generated — an early return before workgroupBarrier() would fail WGSL
 * uniformity validation.
 *
 * These cascades are VISUAL detail only: everything the physics can feel stays
 * in the analytic hero band (heightmap.waterHeight()). See spectrum.ts for the
 * band split contract.
 */

const G = 9.81;

export interface OceanCascadeRuntime {
  readonly spec: CascadeSpec;
  /** (Dx·λ, Dy, Dz·λ, J) — world-metre displacement, repeat-wrapped over patchSize. */
  readonly dispTex: THREE.StorageTexture;
  /** (slopeX, slopeZ, crest, foam). */
  readonly derivTex: THREE.StorageTexture;
  /** Analytic Σk²E — drives the distance-roughness ramp when this band drops
   *  below pixel footprint (specular anti-shimmer). */
  readonly slopeVariance: number;
}

export class OceanCascades {
  readonly cascades: OceanCascadeRuntime[];
  readonly size: number;

  /** Global multiplier on horizontal (choppy) displacement. */
  readonly uChoppy = uniform(1);
  /** Jacobian below this injects foam. */
  readonly uFoamBias = uniform(0.62);
  readonly uFoamGain = uniform(1.15);
  /** Per-frame foam retention (exp(−decay·dt), set CPU-side each update). */
  readonly uFoamKeep = uniform(0.98);
  /** Foam decay rate in 1/s. */
  foamDecayRate = 0.55;

  #uTime = uniform(0);
  #passes: Array<{ evolve: any; ffts: any[]; assemble: any }> = [];
  #bufAs: any[] = [];
  #disposed = false;

  constructor(config: OceanSpectrumConfig = DEFAULT_OCEAN_SPECTRUM) {
    const N = config.size;
    this.size = N;
    const logN = Math.log2(N);
    if (!Number.isInteger(logN)) throw new Error(`ocean: size ${N} must be a power of two`);
    const spectra = buildCascadeSpectra(config);

    // Hand the physics band's exact cosine decomposition to the CPU twin —
    // from here on waterHeight() rides the rendered waves.
    const physSpectrum = spectra.find((s) => s.heroComponents);
    if (physSpectrum?.heroComponents) setHeroWaves(physSpectrum.heroComponents, HERO_STRIP_GATE);

    this.cascades = [];
    for (const { spec, h0, slopeVariance } of spectra) {
      const dk = (2 * Math.PI) / spec.patchSize;

      const h0Buf = instancedArray(h0, "vec4");
      const bufA = instancedArray(N * N, "vec4"); // [Dx + i·Dz | Dy + i·dDxdz]
      const bufB = instancedArray(N * N, "vec4"); // [sx + i·sz | dDxdx + i·dDzdz]
      const foamBuf = instancedArray(N * N, "float");

      const makeTex = () => {
        const tex = new THREE.StorageTexture(N, N);
        tex.type = THREE.HalfFloatType;
        tex.format = THREE.RGBAFormat;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.magFilter = THREE.LinearFilter;
        tex.minFilter = THREE.LinearFilter;
        tex.generateMipmaps = false;
        return tex;
      };
      const dispTex = makeTex();
      const derivTex = makeTex();

      // --- evolve: h0(k) → packed derived spectra at time t ----------------
      const uTime = this.#uTime;
      const evolve = Fn(() => {
        const x = instanceIndex.bitAnd(uint(N - 1));
        const y = instanceIndex.shiftRight(uint(logN));
        const kx = x.toFloat().sub(N / 2).mul(dk).toVar();
        const kz = y.toFloat().sub(N / 2).mul(dk).toVar();
        const kLen = max(sqrt(kx.mul(kx).add(kz.mul(kz))), 1e-6).toVar();
        const invK = float(1).div(kLen).toVar();

        const omega = sqrt(kLen.mul(G));
        const phase = omega.mul(uTime);
        const c = cos(phase).toVar();
        const s = sin(phase).toVar();

        const h0v = h0Buf.element(instanceIndex).toVar();
        // h = h0(k)e^{iφ} + conj(h0(−k))e^{−iφ}; packed (a,b,c2,d2).
        const hr = h0v.x.add(h0v.z).mul(c).add(h0v.w.sub(h0v.y).mul(s)).toVar();
        const hi = h0v.x.sub(h0v.z).mul(s).add(h0v.y.add(h0v.w).mul(c)).toVar();

        const kxn = kx.mul(invK).toVar(); // kx/|k|
        const kzn = kz.mul(invK).toVar();
        const kxkzOverK = kxn.mul(kz).toVar(); // kx·kz/|k|

        // A = [Dx + i·Dz | Dy + i·dDxdz]
        bufA.element(instanceIndex).assign(
          vec4(
            kxn.negate().mul(hi).sub(kzn.mul(hr)),
            kxn.mul(hr).sub(kzn.mul(hi)),
            hr.add(kxkzOverK.mul(hi)),
            hi.sub(kxkzOverK.mul(hr))
          )
        );
        // B = [slopeX + i·slopeZ | dDxdx + i·dDzdz]
        const kx2OverK = kxn.mul(kx).toVar();
        const kz2OverK = kzn.mul(kz).toVar();
        bufB.element(instanceIndex).assign(
          vec4(
            kx.negate().mul(hi).sub(kz.mul(hr)),
            kx.mul(hr).sub(kz.mul(hi)),
            kx2OverK.negate().mul(hr).add(kz2OverK.mul(hi)),
            kx2OverK.negate().mul(hi).sub(kz2OverK.mul(hr))
          )
        );
      })().compute(N * N, [64]);

      // --- inverse FFT: rows then columns, per packed buffer ---------------
      const ffts = [
        makeFFTPass(bufA, N, "h"),
        makeFFTPass(bufB, N, "h"),
        makeFFTPass(bufA, N, "v"),
        makeFFTPass(bufB, N, "v")
      ];

      // --- assemble: sign fix, foam accumulate, texture writes -------------
      const uChoppy = this.uChoppy;
      const uFoamBias = this.uFoamBias;
      const uFoamGain = this.uFoamGain;
      const uFoamKeep = this.uFoamKeep;
      const lambda = spec.choppiness;
      const assemble = Fn(() => {
        const x = instanceIndex.bitAnd(uint(N - 1));
        const y = instanceIndex.shiftRight(uint(logN));
        // (−1)^(x+y) undoes the centered-spectrum shift.
        const sgn = x.add(y).bitAnd(uint(1)).toFloat().mul(2).oneMinus().toVar();
        const chop = uChoppy.mul(lambda).toVar();

        const a4 = bufA.element(instanceIndex).toVar();
        const b4 = bufB.element(instanceIndex).toVar();
        const dx = a4.x.mul(sgn).mul(chop).toVar();
        const dz = a4.y.mul(sgn).mul(chop).toVar();
        const dy = a4.z.mul(sgn).toVar();
        const dxz = a4.w.mul(sgn).mul(chop).toVar();
        const sx = b4.x.mul(sgn).toVar();
        const sz = b4.y.mul(sgn).toVar();
        const dxx = b4.z.mul(sgn).mul(chop).toVar();
        const dzz = b4.w.mul(sgn).mul(chop).toVar();

        // Jacobian of the horizontal warp: <1 where crests fold.
        const jac = float(1).add(dxx).mul(float(1).add(dzz)).sub(dxz.mul(dxz)).toVar();
        const inject = saturate(uFoamBias.sub(jac).mul(uFoamGain)).mul(spec.foamWeight);
        const foamPrev = foamBuf.element(instanceIndex);
        const foam = max(foamPrev.mul(uFoamKeep), inject).toVar();
        foamBuf.element(instanceIndex).assign(foam);

        const coord = ivec2(x.toInt(), y.toInt());
        textureStore(dispTex, coord, vec4(dx, dy, dz, jac));
        textureStore(derivTex, coord, vec4(sx, sz, saturate(float(1).sub(jac)), foam));
      })().compute(N * N, [64]);

      this.cascades.push({ spec, dispTex, derivTex, slopeVariance });
      this.#passes.push({ evolve, ffts, assemble });
      this.#bufAs.push(bufA);
    }
  }

  /**
   * Dispatch the sim. `activeMask` bit i gates cascade i (the director
   * throttles far/irrelevant bands by skipping frames; a skipped cascade keeps
   * its last textures — the ocean just advances at a lower rate there).
   */
  update(renderer: THREE.WebGPURenderer, timeSec: number, dtSec: number, activeMask = -1) {
    if (this.#disposed) return;
    this.#uTime.value = timeSec;
    this.uFoamKeep.value = Math.exp(-this.foamDecayRate * Math.max(dtSec, 0));
    for (let i = 0; i < this.#passes.length; i++) {
      if (!(activeMask & (1 << i))) continue;
      const p = this.#passes[i];
      renderer.compute(p.evolve);
      for (const f of p.ffts) renderer.compute(f);
      renderer.compute(p.assemble);
    }
  }

  dispose() {
    this.#disposed = true;
    for (const c of this.cascades) {
      c.dispTex.dispose();
      c.derivTex.dispose();
    }
  }

  /** Dev diagnostics: read each cascade's post-FFT buffer back and report
   *  min/max/NaN counts — ground truth for "is the sim producing data". */
  async debugReadback(renderer: THREE.WebGPURenderer): Promise<Array<Record<string, number>>> {
    const out: Array<Record<string, number>> = [];
    for (const b of this.#bufAs) {
      const ab = await (renderer as any).getArrayBufferAsync(b.value);
      const f = new Float32Array(ab);
      let min = Infinity, max = -Infinity, nan = 0;
      for (let i = 0; i < f.length; i++) {
        const v = f[i];
        if (Number.isNaN(v) || !Number.isFinite(v)) { nan++; continue; }
        if (v < min) min = v;
        if (v > max) max = v;
      }
      out.push({ min: +min.toFixed(4), max: +max.toFixed(4), nan, len: f.length });
    }
    return out;
  }
}

/**
 * One direction of the 2D inverse FFT over a packed vec4 (two complex signals)
 * storage buffer. Stockham radix-2 autosort: reads contiguous halves, writes
 * interleaved by stage — all log2(N) stages inside one dispatch via workgroup
 * shared memory, barriers between stages. In-place globally: each workgroup
 * owns exactly one row (h) or column (v).
 */
function makeFFTPass(buf: any, N: number, dir: "h" | "v"): any {
  const logN = Math.log2(N);
  const half = N / 2;
  // TSL typings lag the runtime here: WorkgroupInfoNode.element and the
  // dispatchSize form of .compute() both exist in r185 but aren't typed.
  const ping: any = workgroupArray("vec4", N);
  const pong: any = workgroupArray("vec4", N);

  const kernel: any = Fn(() => {
    const row = workgroupId.x;
    const j = localId.x; // 0..half−1: one butterfly per thread per stage
    const jHi = j.add(uint(half)).toVar();
    const base = dir === "h" ? row.mul(uint(N)) : row;
    const stride = dir === "h" ? 1 : N;
    const gLo = base.add(j.mul(uint(stride))).toVar();
    const gHi = base.add(jHi.mul(uint(stride))).toVar();

    ping.element(j).assign(buf.element(gLo));
    ping.element(jHi).assign(buf.element(gHi));
    workgroupBarrier();

    let cur = ping;
    let nxt = pong;
    for (let s = 0; s < logN; s++) {
      const ns = 1 << s;
      const m = j.bitAnd(uint(ns - 1)).toVar();
      // +angle → inverse transform (e^{+ik·x}); unnormalized on purpose: the
      // spectrum amplitudes ARE the physical wave amplitudes.
      const angle = m.toFloat().mul(Math.PI / ns);
      const wr = cos(angle).toVar();
      const wi = sin(angle).toVar();
      const v0 = cur.element(j).toVar();
      const v1 = cur.element(jHi).toVar();
      const t = vec4(
        v1.x.mul(wr).sub(v1.y.mul(wi)),
        v1.x.mul(wi).add(v1.y.mul(wr)),
        v1.z.mul(wr).sub(v1.w.mul(wi)),
        v1.z.mul(wi).add(v1.w.mul(wr))
      ).toVar();
      const e = j.shiftRight(uint(s)).shiftLeft(uint(s + 1)).add(m).toVar();
      nxt.element(e).assign(v0.add(t));
      nxt.element(e.add(uint(ns))).assign(v0.sub(t));
      workgroupBarrier();
      const swap = cur;
      cur = nxt;
      nxt = swap;
    }

    buf.element(gLo).assign(cur.element(j));
    buf.element(gHi).assign(cur.element(jHi));
  })();
  // dispatchSize array (NOT a count): no instanceIndex bounds guard may be
  // emitted — an early return before workgroupBarrier() fails WGSL uniformity.
  return kernel.compute([N, 1, 1], [half, 1, 1]);
}

/**
 * TSL helper: sample a cascade's displacement at world xz (vec2 node), with an
 * amplitude fade node the caller derives from distance/altitude. Kept here so
 * water.ts and the lab share one sampling convention (uv = xz / patchSize).
 */
export function cascadeUv(worldXZ: any, spec: CascadeSpec): any {
  return vec2(worldXZ.x.div(spec.patchSize), worldXZ.y.div(spec.patchSize));
}

/** Per-cascade view-distance where its detail normal has fully faded (m).
 *  Beyond it the band's energy folds into roughness instead (LEADR-lite) —
 *  spectral anti-shimmer: distant water gets a wider stable highlight, never
 *  texel crawl. The micro band lives only in arm's reach. */
export const CASCADE_FADE_DIST = [3400, 950, 260, 72];

export interface OceanDetailNodes {
  /** Σ faded slopes (vec2) — build the surface normal from this. */
  slope: any;
  /** Σ faded persistent Jacobian foam (float 0..~1). */
  foam: any;
  /** Σ faded crest mask (1−J clamped) — feeds crest subsurface glow. */
  crest: any;
  /** Slope variance of everything faded OUT at this distance — add to squared
   *  roughness. Already scaled to the cascades' true spectral variance. */
  cutVariance: any;
}

/**
 * Fragment-side cascade composite shared by the bay sheets and the lab.
 * Branchless (mix/multiply only — see the water.ts If() hazard note).
 * `viewDist` is a float node (metres); `count` limits how many cascades the
 * caller pays for (the far sheet skips the finest band — its fade distance is
 * inside the near patch anyway).
 */
export function oceanDetail(
  cascades: readonly OceanCascadeRuntime[],
  worldXZ: any,
  viewDist: any,
  count = cascades.length
): OceanDetailNodes {
  let slope: any = vec2(0);
  let foam: any = float(0);
  let crest: any = float(0);
  let cutVariance: any = float(0);
  // Foam/crest are POINT features on un-mipped 16f textures: past a few
  // hundred metres their texels alias into speckle across the whole bay, so
  // they die much sooner than the slopes they ride on (a whitecap 1 km away
  // is genuinely a sub-pixel event; the roughness ramp represents it).
  const featureFade = saturate(float(1).sub(viewDist.div(760))).toVar();
  for (let i = 0; i < cascades.length; i++) {
    const c = cascades[i];
    const varI = c.slopeVariance;
    if (i >= count) {
      cutVariance = cutVariance.add(varI);
      continue;
    }
    const fade = saturate(float(1).sub(viewDist.div(CASCADE_FADE_DIST[i] ?? 300))).toVar();
    const g = texture(c.derivTex, cascadeUv(worldXZ, c.spec)).toVar();
    slope = slope.add(g.xy.mul(fade));
    foam = foam.add(g.w.mul(fade.mul(featureFade)));
    crest = crest.add(g.z.mul(fade.mul(featureFade)));
    cutVariance = cutVariance.add(float(varI).mul(float(1).sub(fade.mul(fade))));
  }
  return { slope, foam: saturate(foam), crest: saturate(crest), cutVariance };
}
