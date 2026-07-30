import {
  ClampToEdgeWrapping,
  Data3DTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  Vector2
} from "three/webgpu";
import { Fn, float, rendererReference, texture3D, uniform, vec3 } from "three/tsl";
import { tunables } from "../core/persist";
import {
  DEFAULT_GRADE_ID,
  GRADE_LUT_SIZE,
  SHAPER_A,
  SHAPER_MAX,
  // Imported, never re-derived. This and the shaper it normalises must stay in
  // lockstep with the bake, and two copies of one formula is precisely how a
  // LUT and its sampler drift apart by half a cell.
  SHAPER_NORM,
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
 * look may be as elaborate as it likes — and switching looks rebinds nothing
 * and recompiles nothing: same texture object, same bind group, new contents.
 *
 * WHAT A LOOK SWITCH ACTUALLY COSTS. This header used to claim "instant" and "a
 * few milliseconds", and both were already false before AgX arrived. Measured,
 * for the 110,592 evaluations a 48³ bake needs: goldenState 53.9 ms, AgX base
 * 147.9 ms, AgX punchy 133.6 ms — on the main thread, so it is a dropped frame
 * or several. The bake CACHE below is what makes the claim true on the second
 * visit: A→B→A used to re-pay in full every time, and now pays once per
 * (look, size, parameter revision).
 *
 * The LUT is generated on the CPU at first use, never fetched. 864 KB of VRAM,
 * zero bytes over the network, so the massive-app loading policy is satisfied by
 * construction. Only the ACTIVE look is baked; the others are built the first
 * time they are selected.
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
 *
 * It is a uniform rather than a constant because `setLutSize` can re-bake at a
 * different edge length: baking N=128 while the correction still says 48 leaves
 * the reference lookup shifted by a fraction of a cell, which is small enough to
 * hide (it measured under one code value) and would quietly bias the very
 * comparison the debug path exists to make.
 */
const lutCorrection = (size: number) => new Vector2((size - 1) / size, 0.5 / size);

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
   * Overlay live parameters onto the active look WITHOUT touching GRADE_LOOKS.
   *
   * The looks table is the shipped artistic record and three Node probes import
   * it directly; a debug slider must not be able to edit it out from under them.
   * Passing null clears the overlay. Does not re-bake on its own — call
   * `refresh()`, so a caller dragging several sliders pays one bake, not five.
   */
  setLookPatch: (patch: Partial<GradeLook> | null) => void;
  /**
   * Re-bake the active look. THE ENTRY POINT FOR LIVE LOOK PARAMETERS:
   * `setLook` early-returns on an unchanged id, by design, so without this the
   * AgX CDL knobs had no way to reach the LUT at all.
   *
   * `previewSize` bakes at a smaller edge length for the duration of a drag —
   * 16³ is 4,096 evaluations against 48³'s 110,592, i.e. ~6 ms instead of
   * ~148 ms. Call once more with no argument on release to restore full
   * fidelity. The half-texel correction follows the size, so a preview is
   * coarse but not SHIFTED, which is what makes it a usable preview.
   */
  refresh: (previewSize?: number) => void;
  /**
   * Re-bake at a different edge length. Debug only: rendering a frame at 48³
   * and again at, say, 128³ and differencing the two bounds the shipped LUT's
   * error on real content, which is the only measurement that actually counts.
   */
  setLutSize: (size: number) => void;
  dispose: () => void;
};

/**
 * How many baked LUTs to keep. Each 48³ entry is 864 KB of JS heap, so this is
 * a deliberate ceiling and not a "big enough" number: eight covers every look in
 * the file at one size, which is the A→B→A case the cache exists for, and caps
 * the cache at ~6.9 MB even if someone clicks through the whole dropdown.
 */
const BAKE_CACHE_LIMIT = 8;

export function createGrade(): GradeRuntime {
  let lutSize = GRADE_LUT_SIZE;
  let activeId = GRADE_TUNING.values.look;
  let patch: Partial<GradeLook> | null = null;
  /**
   * The parameter revision, as CONTENT rather than as a counter. It is part of
   * the cache key because a patched look is a different look wearing the same
   * id, and keying on the id alone would serve a stale bake the moment an AgX
   * slider moves. Content-derived rather than incremented so that returning to
   * a set of values you had before is a cache HIT — which is the whole A→B→A
   * complaint, and a counter would miss it every time.
   */
  let patchRevision = "";

  const activeLook = (): GradeLook => {
    const base = findLook(activeId);
    return patch ? { ...base, ...patch } : base;
  };

  /**
   * `${id}|${size}|${revision}` → baked texel data. Insertion-ordered FIFO.
   *
   * The cached array is handed straight to `lut.image.data` rather than copied,
   * so the LUT and the cache alias. That is safe only because nothing writes to
   * baked data after `bakeLookData` returns — the upload path reads it and the
   * next look switch replaces the reference. If anything ever mutates texel data
   * in place, this has to become a copy.
   */
  const bakeCache = new Map<string, Uint16Array>();

  const bakeCached = (look: GradeLook, size: number): Uint16Array => {
    const key = `${look.id}|${size}|${patchRevision}`;
    const hit = bakeCache.get(key);
    if (hit) return hit;
    const data = bakeLookData(look, size);
    bakeCache.set(key, data);
    // Map preserves insertion order, so the first key is the oldest.
    if (bakeCache.size > BAKE_CACHE_LIMIT) {
      const oldest = bakeCache.keys().next();
      if (!oldest.done) bakeCache.delete(oldest.value);
    }
    return data;
  };

  const makeTexture = (look: GradeLook, size: number) => {
    const tex = new Data3DTexture(bakeCached(look, size), size, size, size);
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

  const lut = makeTexture(activeLook(), lutSize);
  const lutNode = texture3D(lut) as N;
  const uCorrection = uniform(lutCorrection(lutSize)) as N;

  /**
   * Exposure comes straight off the renderer, so the three existing writers
   * (the "/" panel, the factory reset in app/compose/frameBody.ts, and
   * __sf.setExposure) keep working untouched and cannot drift out of sync with
   * a private copy.
   */
  const exposure = rendererReference("toneMappingExposure", "float") as N;

  /**
   * `size` is the edge length to bake AT, which is not always `lutSize`: a live
   * drag re-bakes at 16³ and only restores the shipped size on release.
   */
  const rebake = (size: number = lutSize) => {
    const next = bakeCached(activeLook(), size);
    const image = lut.image as { data: Uint16Array; width: number; height: number; depth: number };
    if (image.width !== size) {
      image.width = size;
      image.height = size;
      image.depth = size;
    }
    image.data = next;
    (uCorrection.value as Vector2).copy(lutCorrection(size));
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

      return lutNode.sample(u.mul(uCorrection.x).add(uCorrection.y)).rgb;
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
    setLookPatch: (next: Partial<GradeLook> | null) => {
      patch = next && Object.keys(next).length > 0 ? next : null;
      patchRevision = patch ? JSON.stringify(patch) : "";
    },
    refresh: (previewSize?: number) => {
      rebake(previewSize === undefined ? lutSize : Math.max(8, Math.min(128, Math.round(previewSize))));
    },
    setLutSize: (size: number) => {
      const next = Math.max(8, Math.min(128, Math.round(size)));
      if (next === lutSize) return;
      lutSize = next;
      rebake();
    },
    dispose: () => {
      bakeCache.clear();
      lut.dispose();
    }
  };
}
