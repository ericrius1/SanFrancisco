import { tunables } from "../../../core/persist"

export const DOF_TUNING = tunables("post.dof", {
  /** OFF in live play. Nine fullscreen passes and ~160 taps/px at half res makes
   *  this by a wide margin the most expensive stage in the chain, and restrained
   *  DOF at play FOV is mostly invisible. On for cinematics and photo mode. */
  enabled: { v: false, label: "depth of field" },
  focusDistance: { v: 24, min: 0.5, max: 500, step: 0.5, label: "· focus (m)" },
  autofocus: { v: true, label: "· autofocus" },
  focalLength: { v: 28, min: 2, max: 200, step: 0.5, label: "· focal length (m)" },
  bokehScale: { v: 2, min: 0.5, max: 8, step: 0.1, label: "· bokeh scale" },
  resolution: {
    v: 0.5,
    options: { "¼": 0.25, "½": 0.5, full: 1 },
    label: "· resolution"
  }
})
