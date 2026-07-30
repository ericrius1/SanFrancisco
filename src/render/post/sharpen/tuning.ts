import { tunables } from "../../../core/persist"

export const SHARPEN_TUNING = tunables("post.sharpen", {
  /** WRAPPED. Stock SharpenNode's `sharpness` is inverted (0 = maximum, 2 =
   *  none, via con = exp2(-sharpness) at SharpenNode.js:199). We expose
   *  amount in [0,1] and pass 2 * (1 - amount). 0 is an exact identity, which is
   *  the toggle — there is no separate `enabled`. */
  amount: { v: 0.55, min: 0, max: 1, step: 0.01, label: "sharpen" },
  /** Attenuates sharpening in noisy areas (SharpenNode.js:222-224). On, because
   *  the chain has a temporal resolve and film grain. */
  denoise: { v: true, label: "· denoise" }
})
