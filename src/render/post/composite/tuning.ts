import { tunables } from "../../../core/persist"

export const COMPOSITE_TUNING = tunables("post.composite", {
  enabled: { v: true, label: "linear composite" },
  /**
   * SSAO x contact-shadow reconciliation. contactShadows.ts already darkens
   * contacts, keyed to the sun direction and discarding back/grazing faces;
   * GTAO on top double-darkens (flagged at docs/POSTFX_CINEMATIC_PATHWAY.md §6.6).
   * `min` means whichever term is more confident wins and stacking is
   * impossible. Mission Dolores nave is the referee stop.
   */
  occlusionCombine: {
    v: "min",
    options: { "min (no stacking)": "min", multiply: "multiply" },
    label: "· occlusion combine"
  },
  ssrIntensity: { v: 0.8, min: 0, max: 2, step: 0.01, label: "· ssr intensity" },
  /** Debug only — gameplay drives the underwater uniforms directly. */
  underwater: { v: true, label: "· underwater" }
})
