import { tunables } from "../../../core/persist"

/**
 * The display tail owns the PASS; grade, sharpen and grain own their LOOK. All
 * three are display-referred and cheap, so fusing them into one fragment shader
 * avoids two RGBA8 round trips — and that matters: the deleted FXAA intermediate
 * (old pipeline.ts:481-498) was 8-bit SRGBColorSpace, which would quantise away
 * any grain amplitude below 1/255 at the pass boundary.
 */
export const DISPLAY_TUNING = tunables("post.display", {
  /** Bilinear upscale from the beauty resolution when the temporal resolve is
   *  off. With temporal on the chain already arrives at output resolution and
   *  this is an exact 1:1 fetch. */
  upscaleFilter: {
    v: "linear",
    options: { linear: "linear", nearest: "nearest" },
    label: "· upscale filter"
  }
})
