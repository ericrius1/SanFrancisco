/** Pure shadow defaults shared by browser tuning and Node-side contract tests. */
export const SHADOW_DEFAULTS = Object.freeze({
  enabled: true,
  heroStrength: 1,
  localStrength: 1,
  farStrength: 1,
  farFieldStrength: 1,
  heroNormalBias: 0.02,
  heroDepthBias: -0.00004,
  localNormalBias: 0.05,
  localDepthBias: -0.00008,
  // The far map is 1 m/texel over 1024 m. At 0.5 / -0.0002 flat ground self-
  // shadowed under a grazing sun, painting a soft light-space square of false
  // darkening across the whole far frustum (no real caster — the world atlas
  // correctly showed the same ground lit). Raised to ~1 texel so flat ground
  // stays lit; peter-panning at 48-512 m is sub-metre and invisible.
  farNormalBias: 1.0,
  farDepthBias: -0.0005,
  contactEnabled: true,
  contactResolutionScale: 0.5,
  contactMaxDistance: 0.8,
  contactThickness: 0.12,
  contactIntensity: 0.14,
  contactFadeStart: 10,
  contactFadeEnd: 18,
  contactNormalBias: 0.012,
  contactSamples: 6 as const
})
