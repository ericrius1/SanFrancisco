import {
  ClampToEdgeWrapping,
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat
} from "three/webgpu";
import { Fn, float, rendererReference, texture3D, vec3 } from "three/tsl";
import { tunables } from "../core/persist";
import {
  DEFAULT_GRADE_ID,
  GRADE_LUT_SIZE,
  SHAPER_A,
  SHAPER_MAX,
  evaluateLook,
  findLook,
  gradeOptions,
  shaperInverse,
  type GradeLook
} from "./gradeLooks";

/**
 * The GPU half of the display rendering transform. gradeLooks.ts owns the
 * arithmetic; this file bakes it into a 3D LUT and samples it at the one seam
 * where scene-linear becomes display-referred (render/postfx.ts).
 *
 * WHY A LUT AND NOT THE ARITHMETIC
 *
 * Running the transform per pixel would cost roughly 18 transcendental ops and
 * 40 ALU — about three times the ACES it replaces, which would have made a
 * look upgrade a performance regression. Baked, the per-pixel cost collapses to
 * three sqrt, three divides, a handful of ALU and one trilinear fetch. That is
 * cheaper than the ACES path that shipped before it, so the grade lands as a
 * net win rather than a trade.
 *
 * It also decouples cost from ambition. Every look is the same one fetch, so a
 * look may be as elaborate as it likes — and switching looks rebinds nothing,
 * recompiles nothing, and invalidates none of the eight cached post-FX variants.
 * That is what makes the panel's look selector instant instead of a hitch.
 *
 * The LUT is generated on the CPU at first use, never fetched. 864 KB of VRAM
 * and a few milliseconds of arithmetic, with zero bytes over the network, so
 * the massive-app loading policy is satisfied by construction. Only the ACTIVE
 * look is baked; the others are built the first time they are selected.
 */

/**
 * Its own persisted group rather than a key on RENDER_TUNING. `tunables`
 * fingerprints a group's whole definition and discards that group's saved
 * overrides when the shape changes (core/persist.ts), so folding the selector
 * into RENDER_TUNING would have silently reset everyone's exposure and pixel
 * ratio the first time they loaded this build.
 */
export const GRADE_TUNING = tunables("grade", {
  look: { v: DEFAULT_GRADE_ID, options: gradeOptions(), label: "look" }
});

/** TSL node generics fight composition; `any` is the idiom here (see facade.ts). */
type N = any;

/**
 * Half-texel correction. A LUT coordinate of 0 must land on the CENTRE of texel
 * 0 and 1 on the centre of texel N−1, but a sampler maps texcoord t to texel
 * t·N − 0.5. Without this the whole image is biased by half a cell — the
 * classic LUT bug, which looks "almost right" and is therefore easy to ship.
 */
const LUT_SCALE = (GRADE_LUT_SIZE - 1) / GRADE_LUT_SIZE;
const LUT_OFFSET = 0.5 / GRADE_LUT_SIZE;

const SHAPER_NORM = (Math.sqrt(SHAPER_MAX) + SHAPER_A) / Math.sqrt(SHAPER_MAX);

/**
 * Bake one look into half-float RGBA texel data.
 *
 * Half float, not 8-bit: the stored values are display-referred, so 8 bits per
 * channel would quantise the LUT's own samples to exactly the precision of the
 * final image and put banding in every smooth gradient the sky produces.
 * rgba16float is also filterable in core WebGPU, where float32 filtering is an
 * optional feature this project cannot assume.
 *
 * Memory order is x fastest then y then z, matching Data3DTexture, and the axes
 * are (r, g, b) — the same order `shapeTriple` emits.
 */
function bakeLookData(look: GradeLook, size: number): Uint16Array {
  const data = new Uint16Array(size * size * size * 4);
  const out: [number, number, number] = [0, 0, 0];
  // The axis is shared by all three channels, so resolve it once instead of
  // size³ times.
  const axis = new Float64Array(size);
  for (let i = 0; i < size; i++) axis[i] = shaperInverse(i / (size - 1));

  let o = 0;
  for (let z = 0; z < size; z++) {
    const b = axis[z];
    for (let y = 0; y < size; y++) {
      const g = axis[y];
      for (let x = 0; x < size; x++) {
        evaluateLook(look, axis[x], g, b, out);
        data[o++] = DataUtils.toHalfFloat(out[0]);
        data[o++] = DataUtils.toHalfFloat(out[1]);
        data[o++] = DataUtils.toHalfFloat(out[2]);
        data[o++] = 0x3c00; // half-float 1.0
      }
    }
  }
  return data;
}

export type GradeRuntime = {
  /** scene-linear vec3 → display-referred sRGB vec3. The seam. */
  toDisplay: (linear: N) => N;
  /** Select a look by id. Costs one texture upload; never a recompile. */
  setLook: (id: string) => void;
  activeLookId: () => string;
  /**
   * Re-bake at a different edge length. Debug only: rendering a frame at 48³
   * and again at, say, 128³ and differencing the two bounds the shipped LUT's
   * error on real content, which is the only measurement that actually counts.
   */
  setLutSize: (size: number) => void;
  dispose: () => void;
};

export function createGrade(): GradeRuntime {
  let lutSize = GRADE_LUT_SIZE;
  let activeId = GRADE_TUNING.values.look;

  const makeTexture = (look: GradeLook, size: number) => {
    const tex = new Data3DTexture(bakeLookData(look, size), size, size, size);
    tex.format = RGBAFormat;
    tex.type = HalfFloatType;
    // Trilinear between samples is the entire premise; point sampling would
    // posterise the image to the LUT's grid.
    tex.minFilter = LinearFilter;
    tex.magFilter = LinearFilter;
    tex.wrapS = ClampToEdgeWrapping;
    tex.wrapT = ClampToEdgeWrapping;
    tex.wrapR = ClampToEdgeWrapping;
    // The bake already applied the sRGB OETF. Tagging this sRGB would make the
    // sampler decode it a second time.
    tex.colorSpace = NoColorSpace;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  };

  const lut = makeTexture(findLook(activeId), lutSize);
  const lutNode = texture3D(lut) as N;

  /**
   * Exposure comes straight off the renderer, so the three existing writers
   * (the "/" panel, the factory reset in app/compose/frameBody.ts, and
   * __sf.setExposure) keep working untouched and cannot drift out of sync with
   * a private copy.
   */
  const exposure = rendererReference("toneMappingExposure", "float") as N;

  const rebake = () => {
    const next = bakeLookData(findLook(activeId), lutSize);
    const image = lut.image as { data: Uint16Array; width: number; height: number; depth: number };
    if (image.width !== lutSize) {
      image.width = lutSize;
      image.height = lutSize;
      image.depth = lutSize;
    }
    image.data = next;
    // Bumps texture.version, which is what Textures.js compares to decide to
    // re-upload. Same GPU resource, same bind group, new contents.
    lut.needsUpdate = true;
  };

  const toDisplay = (linear: N): N =>
    Fn(() => {
      const c = vec3(linear).mul(exposure).max(0).toVar();

      // Over-range guard. Scale the whole triple so its peak lands inside the
      // shaped range instead of clamping each channel, which would change the
      // channel ratios — and above the shoulder the ratios ARE the colour. See
      // `shapeTriple` in gradeLooks.ts for why this is an identity and not an
      // approximation. max(peak, MAX) in the denominator keeps it branchless
      // and safe at peak 0.
      const peak = c.r.max(c.g).max(c.b);
      c.mulAssign(float(SHAPER_MAX).div(peak.max(SHAPER_MAX)));

      // The shaper, mirroring gradeLooks.shaperForward exactly.
      const s = c.sqrt();
      const u = s.div(s.add(SHAPER_A)).mul(SHAPER_NORM).clamp(0, 1);

      return lutNode.sample(u.mul(LUT_SCALE).add(LUT_OFFSET)).rgb;
    })();

  return {
    toDisplay,
    setLook: (id: string) => {
      const look = findLook(id);
      if (look.id === activeId) return;
      activeId = look.id;
      GRADE_TUNING.values.look = look.id;
      rebake();
    },
    activeLookId: () => activeId,
    setLutSize: (size: number) => {
      const next = Math.max(8, Math.min(128, Math.round(size)));
      if (next === lutSize) return;
      lutSize = next;
      rebake();
    },
    dispose: () => lut.dispose()
  };
}
