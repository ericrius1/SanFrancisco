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
  farNormalBias: 0.5,
  farDepthBias: -0.0002,
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
