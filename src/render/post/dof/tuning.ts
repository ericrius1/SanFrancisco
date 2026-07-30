import { tunables } from "../../../core/persist"

export const DOF_TUNING = tunables("post.dof", {
  /** OFF in live play. Nine fullscreen passes and ~160 taps/px at half res makes
   *  this by a wide margin the most expensive stage in the chain, and restrained
   *  DOF at play FOV is mostly invisible. On for cinematics and photo mode. */
  enabled: { v: false, label: "depth of field" },
  /** Metres along the camera's look direction. Scriptable — a cinematic can
   *  drive this directly. `autofocus` overwrites it every frame while on. */
  focusDistance: { v: 24, min: 0.5, max: 500, step: 0.5, label: "· focus (m)" },
  /** Centre-screen depth tap, eased exponentially on the CPU into a uniform once
   *  per frame — never per pixel. See index.ts for how the tap gets back to JS
   *  and what the one-frame readback latency costs. */
  autofocus: { v: true, label: "· autofocus" },
  /** Distance from the focal plane to FULL defocus. Small = dramatic. */
  focalLength: { v: 28, min: 2, max: 200, step: 0.5, label: "· focal length (m)" },
  bokehScale: { v: 2, min: 0.5, max: 8, step: 0.1, label: "· bokeh scale" },
  /**
   * The blur chain's resolution as a fraction of the chain's OUTPUT size.
   * Structural — it reallocates four targets.
   *
   * ½ is upstream's hardcoded layout (DepthOfFieldNode.js:243-244) and therefore
   * the default. The CoC pass and the composite always run at full size: the
   * composite writes the whole image, in-focus regions included, so scaling it
   * would throw away the temporal resolve's upsample across the 95% of the frame
   * that is sharp. Bokeh diameter does not change with this knob — see
   * vendor/dof.ts, deviation 2.
   */
  resolution: {
    v: 0.5,
    options: { "¼": 0.25, "½": 0.5, full: 1 },
    label: "· resolution"
  }
})
