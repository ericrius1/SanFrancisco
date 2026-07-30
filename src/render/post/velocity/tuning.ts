import { tunables } from "../../../core/persist"

/**
 * BRIEF §3.4 is the decision, not a preference: screen-space depth
 * reprojection is the DEFAULT source and true MRT velocity is opt-in and off.
 * MRT velocity destroys the static-BundleGroup fast path across the whole city
 * every frame (NodeMaterialObserver.js:719 returns true unconditionally when the
 * renderer MRT has `velocity`), reports untransformed local coordinates for every
 * BatchedMesh, and evaluates three mat4xmat4 products per pixel in every material.
 */
export const VELOCITY_TUNING = tunables("post.velocity", {
  enabled: { v: true, label: "velocity" },
  source: {
    v: "reproject",
    options: { "depth reproject": "reproject", "mrt (offline)": "mrt" },
    label: "· source"
  }
})
