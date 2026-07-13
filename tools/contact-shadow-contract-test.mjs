import assert from "node:assert/strict"
import {
  CONTACT_SHADOW_DEFAULTS,
  combineContactShadowEvidence,
  contactShadowDepthConfidence,
  createContactShadowComplement,
  normalizeContactShadowOptions
} from "../src/render/contactShadows.ts"

const defaults = normalizeContactShadowOptions()
assert.deepEqual(defaults, CONTACT_SHADOW_DEFAULTS)
assert.equal(defaults.intensity, 0.14)

// Continuous evidence is neutral around self-intersection and unrelated
// foreground, full only through the middle of the accepted thickness band.
assert.equal(contactShadowDepthConfidence(-0.01, 0.12), 0)
assert.equal(contactShadowDepthConfidence(0.002, 0.12), 0)
assert.equal(contactShadowDepthConfidence(0.03, 0.12), 1)
assert.equal(contactShadowDepthConfidence(0.12, 0.12), 0)
const softLower = contactShadowDepthConfidence(0.008, 0.12)
const softUpper = contactShadowDepthConfidence(0.1, 0.12)
assert.ok(softLower > 0 && softLower < 1)
assert.ok(softUpper > 0 && softUpper < 1)

// One newly intersecting ray tap cannot flip the entire contact pixel. Multiple
// corroborating taps accumulate smoothly toward (but never beyond) one.
const oneNearTap = combineContactShadowEvidence([1, 0, 0, 0, 0, 0])
const oneFarTap = combineContactShadowEvidence([0, 0, 0, 0, 0, 1])
const allTaps = combineContactShadowEvidence([1, 1, 1, 1, 1, 1])
assert.ok(oneNearTap > 0 && oneNearTap < 0.42)
assert.ok(oneFarTap > 0 && oneFarTap < oneNearTap)
assert.ok(allTaps > 0.85 && allTaps < 1)

const clamped = normalizeContactShadowOptions({
  resolutionScale: 0.01,
  maxDistance: 99,
  thickness: -1,
  intensity: 5,
  fadeStart: 12,
  fadeEnd: 2,
  normalBias: 1,
  samples: 7
})
assert.deepEqual(clamped, {
  resolutionScale: 0.25,
  maxDistance: 2,
  thickness: 0.005,
  intensity: 1,
  fadeStart: 12,
  fadeEnd: 12.25,
  normalBias: 0.1,
  samples: 6
})

const sentinel = {}
const disabled = createContactShadowComplement({ enabled: false })
assert.equal(disabled.available, false)
assert.equal(disabled.reason, "disabled")
assert.equal(disabled.apply(sentinel), sentinel)

const noDepth = createContactShadowComplement({})
assert.equal(noDepth.available, false)
assert.equal(noDepth.reason, "depth buffer unavailable")
assert.equal(noDepth.apply(sentinel), sentinel)
noDepth.configure({ intensity: 1 })
noDepth.dispose()

const noCamera = createContactShadowComplement({ depthTex: sentinel })
assert.equal(noCamera.available, false)
assert.equal(noCamera.reason, "camera unavailable")

console.log("contact-shadow contract: ok")
