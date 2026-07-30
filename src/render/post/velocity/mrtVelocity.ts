// U1 · Velocity — the OPT-IN source. Build spec: .data/postfx/BRIEF.md §3.4.
//
// ============================================================================
//  DO NOT MAKE THIS THE DEFAULT. Three measured, independently disqualifying
//  reasons, each verified against r185 source, not inferred:
//
//  1. It destroys the static-BundleGroup fast path across the whole city, every
//     frame. `NodeMaterialObserver.needsRefresh` returns true UNCONDITIONALLY
//     when the renderer MRT has a `velocity` output
//     (NodeMaterialObserver.js:719 -> :166-172), which bypasses the
//     `isStatic || isBundle` early-out at :732-736. `Renderer._renderBundle`'s
//     cached path (Renderer.js:1319-1338) then runs updateBefore +
//     geometries.updateForRender + nodes.updateForRender +
//     bindings.updateForRender + updateAfter for EVERY object in EVERY static
//     BundleGroup, every frame. This project's bundles are tiles.ts:1827,
//     citygen/render.ts:259, trafficLights.ts:268 — downtown FiDi, the marina,
//     the Golden Gate deck — and `BundleGroup.static` defaults to true. No
//     amount of per-material work removes this; it is a property of the MRT.
//
//  2. The velocity it produces is WRONG on the surfaces with the largest screen
//     coverage. `Batch.js` contains no `positionPrevious` handling at all —
//     only Skinning.js:166/:233 and Instance.js:228 write that varying in the
//     whole of three. So every BatchedMesh reports the motion of untransformed
//     per-geometry LOCAL coordinates: citygen/render/shellBatch.ts (all
//     building shells and windows), tileBatch.ts (all road/park/pier decks),
//     the facade.ts batched path. Add ~50 `positionNode` sites (terrain
//     clipmap, FFT ocean, all grass, all trees, all city window modules), 21
//     SpriteNodeMaterial sites, and facade.ts:148's `vertexNode` override which
//     VelocityNode never even reads. Each of those is a confident, plausible,
//     wrong number — strictly worse than no reprojection.
//
//  3. `VelocityNode.setup()` runs in the FRAGMENT stage (VelocityNode.js:164-178
//     — both `positionLocal` and `positionPrevious` resolve as varyings), which
//     is three mat4xmat4 products per pixel in every material, ~192 MACs/px of
//     pure overhead on two stops PERF_LEVELUP.md:16,18,277 already measures as
//     fragment-bound. This file fixes reason 3 (see UnjitteredVelocityNode
//     below); it CANNOT fix 1 or 2.
//
//  It is implemented correctly anyway, because it is the right tool for OFFLINE
//  CINEMATIC CAPTURE: the CPU regression is affordable when frames are not
//  real-time, and moving-object quality is what a cinematic is for.
// ============================================================================
//
// ATTACHING IS ONE-WAY FOR THE SESSION. Once `getTexture("velocity")` has added
// the third colour attachment, the beauty pass's render target HAS three
// attachments, and an MRT that stops emitting a `velocity` output makes every
// material in the world fail pipeline creation with "Color target has no
// corresponding fragment stage output but writeMask is not zero" — pipeline.ts
// records that exact failure, measured, for the gbuffer attachment: the whole
// frame comes back as clear colour. So flipping `post.velocity.source` back to
// "reproject" restores correct PIXELS (the stage rebinds its slot) but not the
// CPU cost of reason 1. Reload to undo that.
import * as THREE from "three/webgpu"
import {
  NodeUpdateType,
  mrt,
  positionLocal,
  positionPrevious,
  uniform,
  varying,
  vec4
} from "three/tsl"
import type { N, PostFrameContext, PostStageSetup } from "../types"
import type { VelocitySourceImpl } from "./source"

/** Must be exactly this string: `NodeBuilder.needsPreviousData()` (:3449) and
 *  `MRTNode.setup()`'s attachment lookup both match on the literal name. */
const VELOCITY_MRT_KEY = "velocity"

const _previousObjectWorld = new WeakMap<THREE.Object3D, THREE.Matrix4>()

type CameraFrameData = {
  frameId: number
  readonly previousProjection: THREE.Matrix4
  readonly previousView: THREE.Matrix4
  readonly currentProjection: THREE.Matrix4
  readonly currentView: THREE.Matrix4
  seeded: boolean
}

const _cameraData = new WeakMap<THREE.Camera, CameraFrameData>()

const scratchCurrent = new THREE.Matrix4()
const scratchPrevious = new THREE.Matrix4()

/**
 * A VelocityNode that keeps its per-pixel cost to one `mat4 x vec4` in the
 * VERTEX stage instead of three `mat4 x mat4` products in the fragment stage.
 *
 * Two deviations from stock `VelocityNode`, both deliberate:
 *
 *  - The projection x view x model chain is folded on the CPU into a single
 *    mat4 uniform per object. `THREE.Matrix4.elements` is a plain JS array, so
 *    that fold is float64 — which also keeps this project's world-scale
 *    translations out of float32 (same argument as shared/matrices.ts's
 *    `reprojectFromView`).
 *  - The clip positions are wrapped in `varying()`, moving the remaining
 *    multiply to the vertex stage. Stock leaves it in the fragment stage
 *    because `positionLocal`/`positionPrevious` resolve as varyings there;
 *    naming the varying ourselves is what actually relocates the work.
 *
 * The projection used is the UNJITTERED one on both sides, so jitter never
 * leaks into motion — the same invariant the reprojection source gets
 * structurally. We do not read `camera.projectionMatrix` for it, because during
 * the beauty pass that matrix carries this frame's Halton offset; the stage
 * hands us a jitter-free copy instead — see `unjitteredProjection` and the
 * source's `render()`, which is the one point in the frame where the camera's
 * live projection is guaranteed jitter-free.
 */
class UnjitteredVelocityNode extends THREE.TempNode {
  /** Jitter-free projection, refreshed by the stage once per presented frame. */
  readonly unjitteredProjection = new THREE.Matrix4()

  readonly #currentClip = uniform(new THREE.Matrix4())
  readonly #previousClip = uniform(new THREE.Matrix4())

  constructor() {
    super("vec2")
    this.updateType = NodeUpdateType.OBJECT
    this.updateAfterType = NodeUpdateType.OBJECT
    // NONE, like every other node this chain owns. It renders nothing, so there
    // is no explicit render() to expose — but leaving the field at its default
    // would still put this node on the `_nodes.updateBefore(renderObject)` path
    // that Renderer.js:3778 walks from inside an open render pass.
    this.updateBeforeType = NodeUpdateType.NONE
  }

  // `any` on the frame: three types NodeFrame's camera/object as optional, and
  // an OBJECT-scoped node is only ever called with both present.
  update(frame: N): boolean | undefined {
    const { frameId, camera, object } = frame as {
      frameId: number
      camera: THREE.Camera
      object: THREE.Object3D
    }

    let data = _cameraData.get(camera)
    if (data === undefined) {
      data = {
        frameId: -1,
        previousProjection: new THREE.Matrix4(),
        previousView: new THREE.Matrix4(),
        currentProjection: new THREE.Matrix4(),
        currentView: new THREE.Matrix4(),
        seeded: false
      }
      _cameraData.set(camera, data)
    }

    // Per-CAMERA frame history, not the chain's CameraHistory. The chain
    // advances its matrices in chain.render(), which is AFTER the beauty pass,
    // so at the moment this node runs the chain's "current" is last frame's.
    if (data.frameId !== frameId) {
      data.frameId = frameId
      if (data.seeded === true) {
        data.previousProjection.copy(data.currentProjection)
        data.previousView.copy(data.currentView)
      } else {
        data.previousProjection.copy(this.unjitteredProjection)
        data.previousView.copy(camera.matrixWorldInverse)
        data.seeded = true
      }
      data.currentProjection.copy(this.unjitteredProjection)
      data.currentView.copy(camera.matrixWorldInverse)
    }

    let previousWorld = _previousObjectWorld.get(object)
    if (previousWorld === undefined) {
      previousWorld = new THREE.Matrix4().copy(object.matrixWorld)
      _previousObjectWorld.set(object, previousWorld)
    }

    scratchCurrent.multiplyMatrices(data.currentProjection, data.currentView)
    ;(this.#currentClip.value as THREE.Matrix4).multiplyMatrices(scratchCurrent, object.matrixWorld)
    scratchPrevious.multiplyMatrices(data.previousProjection, data.previousView)
    ;(this.#previousClip.value as THREE.Matrix4).multiplyMatrices(scratchPrevious, previousWorld)
    return undefined
  }

  updateAfter(frame: N): boolean | undefined {
    const previousWorld = _previousObjectWorld.get((frame as { object: THREE.Object3D }).object)
    if (previousWorld !== undefined) {
      previousWorld.copy((frame as { object: THREE.Object3D }).object.matrixWorld)
    }
    return undefined
  }

  setup(): N {
    const clipCurrent: N = varying(
      (this.#currentClip as N).mul(vec4(positionLocal, 1.0)),
      "vVelocityClipCurrent"
    )
    const clipPrevious: N = varying(
      (this.#previousClip as N).mul(vec4(positionPrevious, 1.0)),
      "vVelocityClipPrevious"
    )
    return clipCurrent.xy.div(clipCurrent.w).sub(clipPrevious.xy.div(clipPrevious.w))
  }
}

export function createMrtSource(setup: PostStageSetup): VelocitySourceImpl {
  const { gbuffer } = setup

  // The beauty PassNode, reached through its own colour texture node. TRAANode
  // does the same walk (`beautyNode.passNode.renderTarget`, TRAANode.js:363).
  // Going through the node rather than a new constructor argument is what keeps
  // this unit out of pipeline.ts and out of chain.ts.
  const passNode = (gbuffer.colour as { passNode?: N }).passNode ?? null

  const node = new UnjitteredVelocityNode()
  // Seed before the first beauty pass. This factory only ever runs from
  // `selectSource()`, i.e. at chain construction or from applyStructure(), both
  // of which are outside the jitter window — so the live projection is already
  // the jitter-free one. Without the seed the first frame's "previous"
  // projection would be an identity matrix, which is not a subtle wrong answer.
  node.unjitteredProjection.copy(gbuffer.camera.projectionMatrix)
  let attached = false
  let velocityTexture: THREE.Texture | null = null

  const attach = () => {
    if (attached === true) return
    if (passNode === null) {
      console.warn(
        "[post.velocity] source=mrt needs the beauty PassNode; gbuffer.colour is not a PassTextureNode. Staying on reprojection."
      )
      return
    }
    attached = true

    const existing = passNode.getMRT() as {
      outputNodes?: Record<string, N>
    } | null
    passNode.setMRT(
      mrt({
        ...(existing?.outputNodes ?? {}),
        [VELOCITY_MRT_KEY]: node as N
      })
    )

    // MRTNode.setup() silently SKIPS any output whose texture does not exist
    // (MRTNode.js:174 `if (index === -1) continue;`). This call is what
    // allocates the attachment — same trap the gbuffer attachment documents in
    // pipeline.ts. Do NOT rename the key.
    const texture = passNode.getTexture(VELOCITY_MRT_KEY) as THREE.Texture
    // rg16float. three would otherwise clone the beauty attachment's
    // rgba16float; halving it halves the bandwidth of an attachment that is
    // written by every material in the world.
    texture.format = THREE.RGFormat
    texture.type = THREE.HalfFloatType
    // Match the reprojection target's filters exactly. The stage swaps these
    // two textures through one `texture()` node, and a texture node's WGSL
    // sampler binding type is decided by the filter mode of whatever was bound
    // at codegen — a nearest/linear mismatch is a bind-group error, not a
    // cosmetic difference (shared/textureSlot.ts records the same trap).
    texture.minFilter = THREE.LinearFilter
    texture.magFilter = THREE.LinearFilter
    velocityTexture = texture
  }

  return {
    kind: "mrt",
    texture: () => {
      attach()
      return velocityTexture
    },
    render: (frame: PostFrameContext) => {
      // Nothing to draw — the beauty pass already wrote this attachment. What
      // this call is for: capturing the jitter-free projection for the NEXT
      // frame. We run after `jitter.clear()`, so `camera.projectionMatrix` is
      // unjittered right now; during the beauty pass it is not, and there is no
      // hook inside the beauty pass we own.
      //
      // Cost of the one-frame lag: the projection only changes on fov / aspect /
      // near / far edits, and every one of those already raises
      // `historyInvalid`, which makes the temporal resolve seed rather than
      // accumulate on exactly that frame.
      void frame
      node.unjitteredProjection.copy(gbuffer.camera.projectionMatrix)
    },
    warmupQuads: () => [],
    dispose: () => {
      // Deliberately does NOT detach. See the file header: removing the MRT
      // output while the attachment exists breaks every material in the world.
    }
  }
}
