// U1 · Velocity + G-buffer helpers — build spec: .data/postfx/BRIEF.md §3.4
//
// Screen-space motion in NDC units, rg16float, at INPUT resolution. The temporal
// resolve is the consumer; nothing else in the chain reads it today.
//
// TWO SOURCES, ONE NODE. `reprojectPass.ts` is the default and the fallback;
// `mrtVelocity.ts` is opt-in, off, and for offline cinematic capture only (its
// header carries the three measured reasons it cannot be the default — read
// them before flipping anything). Downstream stages bind ONE stable `texture()`
// node whose value this stage points at whichever source is live, so switching
// sources is a binding swap for every consumer and never a shader rebuild.
import type * as THREE from "three/webgpu"
import { vec2 } from "three/tsl"
import { createTextureSlot } from "../shared/textureSlot"
import { STAGE_ORDER } from "../order"
import type { N, PostFrameContext, PostStage, PostStageSetup, TextureSlot } from "../types"
import { VELOCITY_TUNING } from "./tuning"
import { createReprojectSource } from "./reprojectPass"
import { createMrtSource } from "./mrtVelocity"
import { ndcMotionToUv, type VelocitySourceImpl, type VelocitySourceKind } from "./source"

export { ndcMotionToUv } from "./source"
export type { VelocitySourceKind } from "./source"

export type VelocityStage = PostStage & {
  /** The stable rg16float motion texture node. Sample it, or `load()` it. */
  readonly velocityNode: N
  /** 1/size of whatever is currently bound. */
  readonly velocityTexelSize: N
  /** Motion in NDC units (y UP). */
  motionAt(uv: N): N
  /** The same motion as a uv offset (y DOWN): `prevUv = uv - motionUvAt(uv)`. */
  motionUvAt(uv: N): N
  activeSource(): VelocitySourceKind
}

export function createVelocityStage(setup: PostStageSetup): VelocityStage {
  const { gbuffer } = setup

  // The reprojection source is built unconditionally, even when the tunable
  // starts on "mrt": it is the fallback the stage falls back TO (mrtVelocity
  // declines when the beauty PassNode is not reachable), and its quad has to be
  // in `warmupQuads()` at boot or flipping back at runtime would compile a
  // fullscreen pipeline mid-frame.
  const reproject: VelocitySourceImpl = createReprojectSource(setup)
  let mrtSource: VelocitySourceImpl | null = null
  let active: VelocitySourceImpl = reproject

  const initial = reproject.texture()
  if (initial === null) throw new Error("[post.velocity] reprojection target has no texture")

  // Not a chain slot — the chain rebinds slots to the upstream COLOUR, and this
  // stage is "aux": it produces no colour. Reusing the mechanism is still right,
  // because what it buys (swap a Texture object, update a binding, never a
  // recompile — Bindings.js compares `binding.generation`) is exactly what the
  // source switch needs.
  const slot: TextureSlot = createTextureSlot("post_velocity", initial)

  const selectSource = () => {
    const wanted = VELOCITY_TUNING.values.source === "mrt" ? "mrt" : "reproject"
    if (wanted === "mrt") {
      if (mrtSource === null) mrtSource = createMrtSource(setup)
      // texture() is what performs the one-way MRT attach. A null return means
      // the source declined (no reachable PassNode) and said so.
      const texture = mrtSource.texture()
      if (texture !== null) {
        active = mrtSource
        slot.bind(texture)
        return
      }
    }
    active = reproject
    const texture = reproject.texture()
    if (texture !== null) slot.bind(texture)
  }
  selectSource()

  const motionAt = (uv: N): N => slot.node.sample(uv).rg
  const motionUvAt = (uv: N): N => ndcMotionToUv(motionAt(uv))

  // PUBLISH the motion node on the shared g-buffer. `PostGBuffer.velocity` is
  // declared `N | null` and pipeline.ts leaves it null because the pixels are
  // this stage's, not the beauty pass's — and the stage is constructed FIRST
  // (STAGE_ORDER.velocity = 10, and chain.ts's registry literal builds it
  // first), so every downstream stage sees a populated field while it is still
  // building its own graph. That ordering is the whole reason this is safe;
  // it is not an incidental convenience.
  //
  // The field stays non-null when the stage is DISABLED, because a node graph
  // cannot be unbuilt. A consumer that must distinguish "no motion" from "stale
  // motion" reads `velocityOf(chain.stage("velocity")).enabled` — see below.
  ;(gbuffer as { velocity: N | null }).velocity = slot.node

  return {
    id: "velocity",
    label: "velocity",
    order: STAGE_ORDER.velocity,
    // "aux": it publishes a buffer, it does not replace the chain colour.
    kind: "aux",
    resolution: "input",
    enabled: () => VELOCITY_TUNING.values.enabled === true,
    output: () => null,
    render: (frame: PostFrameContext) => active.render(frame),
    // Sizing is the chain's job — targets.ts resizes the whole pool from one
    // place. The slot re-derives its texel size from the bound texture on every
    // bind, and a RenderTarget keeps texture identity across setSize(), which is
    // why the bind below is unconditional rather than identity-gated.
    setSize: () => {
      const texture = active.texture()
      if (texture !== null) slot.bind(texture)
    },
    warmupQuads: (): THREE.QuadMesh[] => reproject.warmupQuads(),
    applyParams: () => {},
    // `source` is STRUCTURAL, not a recompile key. Two reasons, and the first is
    // an invariant: this stage is enabled by default, and a default-enabled
    // stage must declare no recompile keys at all. The second is that the flip
    // genuinely belongs in applyStructure() — it rebuilds the beauty MRT and
    // rebinds a target, which is that hook's job description.
    applyStructure: () => selectSource(),
    tuning: {
      group: VELOCITY_TUNING,
      structuralKeys: ["source"],
      recompileKeys: []
    },
    dispose: () => {
      reproject.dispose()
      mrtSource?.dispose()
    },
    velocityNode: slot.node,
    velocityTexelSize: slot.texelSize,
    motionAt,
    motionUvAt,
    activeSource: () => active.kind
  }
}

/**
 * The consumer's handle on this stage, in the same shape as `cameraJitter()` in
 * jitter/index.ts: it returns an exact zero-motion identity when the stage is
 * missing, still a stub, or turned off, so a temporal stage calls it
 * unconditionally and never branches on whether U1 has landed.
 *
 * `enabled` is the one thing a consumer must actually respect. When the stage is
 * off, `node` still points at a real texture holding the LAST frame it rendered;
 * reprojecting against that is worse than reprojecting against nothing.
 */
export type VelocityHandle = {
  readonly enabled: boolean
  readonly node: N | null
  motionAt(uv: N): N
  motionUvAt(uv: N): N
}

const ZERO_MOTION: VelocityHandle = {
  enabled: false,
  node: null,
  motionAt: () => vec2(0.0, 0.0),
  motionUvAt: () => vec2(0.0, 0.0)
}

export function velocityOf(stage: PostStage | undefined): VelocityHandle {
  const candidate = stage as (PostStage & Partial<VelocityStage>) | undefined
  if (!candidate || typeof candidate.motionAt !== "function") return ZERO_MOTION
  if (candidate.enabled() !== true) return ZERO_MOTION
  return {
    enabled: true,
    node: candidate.velocityNode ?? null,
    motionAt: candidate.motionAt.bind(candidate),
    motionUvAt: candidate.motionUvAt!.bind(candidate)
  }
}
