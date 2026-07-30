// U5 · DOF + bloom — build spec: .data/postfx/BRIEF.md §4.7
//
// Bloom is ON by default and is NOT a style — it is the base look. The point is
// that a lamp reads as a light source, not that the image glows.
//
// It runs at OUTPUT resolution, AFTER the temporal resolve and BEFORE the
// display transform, so the threshold is measured in PRE-exposure scene-linear:
// exposure is applied downstream inside `grade.toDisplay` (grade.ts:186). Any
// future auto-exposure has to go in that same place, or 2.2 silently changes
// meaning. See ./tuning.ts for what 2.2 buys and what 1.05 cost.
//
// TWO HARD-WON RULES, carried from the deleted pipeline.ts:230-248 because both
// are cheap to re-break:
//
//  (a) THE BLOOMED SOURCE MUST BE A TEXTURE, NOT AN EXPRESSION. Consumers tap it
//      at several UVs — the underwater god rays, the surf-flow lens — and an
//      expression re-evaluates the whole bloom chain per tap. `rtt()` used to buy
//      this; here the chain's `TextureSlot` already hands every stage a
//      `texture()` node over a real target, so the property holds by
//      construction. It stops holding the moment someone hands `BloomPass` a
//      computed vec4 instead.
//  (b) ONE BloomPass PER SOURCE, NEVER SHARED. Upstream pushed five
//      separable-blur materials per NodeBuilder with no reset
//      (BloomNode.js:415-419) while `setSize` (:320-330) and `updateBefore`
//      (:361-379) only ever indexed the first five, so a single instance reached
//      by eight cached style variants built forty materials and orphaned
//      thirty-five. The variant matrix is gone and the fork builds its five once
//      in the constructor, but the rule survives because the failure it describes
//      is silent.
import * as THREE from "three/webgpu"
import { Fn, screenUV, texture, uniform, vec4 } from "three/tsl"
import { createStageQuad } from "../shared/fullscreen"
import { STAGE_ORDER } from "../order"
import type { N, PostFrameContext, PostStage, PostStageSetup, TextureSlot } from "../types"
import { BLOOM_TUNING } from "./tuning"
import { BloomPass } from "./vendor/bloom"

export function createBloomStage(setup: PostStageSetup): PostStage {
  const { allocTarget, inputSlot } = setup
  const slot: TextureSlot = inputSlot()
  const values = BLOOM_TUNING.values

  const U = {
    strength: uniform(values.strength) as N,
    radius: uniform(values.radius) as N,
    threshold: uniform(values.threshold) as N
  }

  const pass = new BloomPass({
    source: slot.node,
    strength: U.strength,
    radius: U.radius,
    threshold: U.threshold
  })
  pass.setResolutionScale(values.resolution)

  // rgba16float at output resolution. Still scene-linear HDR: the display
  // transform is two stages downstream, and an 8-bit intermediate here would
  // quantise exactly the values the look is tuned against (targets.ts:12-20).
  const target = allocTarget({
    name: "post_bloom",
    resolution: "output",
    type: THREE.HalfFloatType
  })

  // A plain `texture()` over the fork's output, not upstream's `passTexture`.
  // `passTexture` exists to hand three's scheduler a handle on the producing
  // node, which is the machinery this chain deliberately does not use — see
  // vendor/bloom.ts, deviation 1. The Texture object survives every resize, so
  // this binds once and never rebinds.
  const bloomTexture = texture(pass.texture) as N
  bloomTexture.name = "post_bloom_source"

  const quad = createStageQuad("post_bloom_add")
  quad.setFragment(
    Fn(() => {
      // `screenUV` here, `uv()` inside the fork. Same value for a QuadMesh drawn
      // into a render target: WGSLNodeBuilder.isFlipY() is hard-false
      // (WGSLNodeBuilder.js:1598-1602) so screenUV is fragCoord/size with y = 0
      // at the top, and QuadGeometry's uv attribute is exactly (1 - ndc)/2
      // (QuadMesh.js:28-30). The equivalence would only break for a draw
      // straight to the canvas, which no chain stage does.
      const uv = screenUV
      const lin = slot.node.sample(uv).rgb
      // Additive, in linear light. The bloom target is at output x resolution,
      // so this tap is also the upsample.
      return vec4(lin.add(bloomTexture.sample(uv).rgb), 1.0)
    })()
  )

  const applyParams = () => {
    U.strength.value = Number(BLOOM_TUNING.values.strength)
    U.radius.value = Number(BLOOM_TUNING.values.radius)
    U.threshold.value = Number(BLOOM_TUNING.values.threshold)
  }
  // Persisted overrides are already in `values` by the time the stage builds, so
  // seed the uniforms before the first frame rather than waiting for the panel.
  applyParams()

  return {
    id: "bloom",
    label: "bloom",
    order: STAGE_ORDER.bloom,
    kind: "colour",
    resolution: "output",
    enabled: () => BLOOM_TUNING.values.enabled === true,
    output: () => target.texture,
    render: (frame: PostFrameContext) => {
      // Twelve nested quad draws, none of them inside an open pass. The chain
      // guarantees that; vendor/bloom.ts records what happens when it is not.
      pass.render(frame.renderer)
      quad.render(frame.renderer, target)
    },
    // The fork owns eleven targets whose sizes are relative to each other rather
    // than to either of the chain's two resolution classes, so unlike most
    // stages this one has real work here. `post_bloom` itself is pool-owned and
    // resized by targets.ts.
    setSize: (frame: PostFrameContext) => {
      pass.setSize(frame.outputWidth, frame.outputHeight)
    },
    warmupQuads: () => [...pass.quads(), quad.mesh],
    applyParams,
    applyStructure: () => {
      // The chain marks sizes dirty after applyStructure(), so the reallocation
      // lands in the next setSize() rather than here.
      pass.setResolutionScale(Number(BLOOM_TUNING.values.resolution))
    },
    tuning: {
      group: BLOOM_TUNING,
      structuralKeys: ["resolution"],
      // MUST stay empty: bloom is enabled by default (types.ts:125-128). Every
      // other knob is a uniform, and `resolution` only resizes targets.
      recompileKeys: []
    },
    dispose: () => {
      pass.dispose()
      quad.dispose()
    }
  }
}
