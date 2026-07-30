// VENDORED from three r185:
//   node_modules/three/examples/jsm/tsl/display/depthAwareBlend.js
//
// NOT WIRED UP. `src/render/pianoGodRays.ts` still imports the stock addon and
// this unit may not edit that file — and tools/mission-dolores-contract-test.mjs
// asserts the stock import path literally ("piano effect must use the official
// depth-aware composite", :83). Landing this is a two-line change (the import in
// pianoGodRays.ts and that assertion) that belongs to whoever owns those files.
// See the U7 report.
//
// WHY IT EXISTS. The brief (§7, god-rays row) records this as a live bug:
// "depthAwareBlend.js:31 uses the non-reversed viewZToOrthographicDepth,
// producing a negative correctDepth, so abs(diff) < 0.05 * correctDepth is never
// true, count stays 0 and pushDir is always zero."
//
// THAT MECHANISM DOES NOT REPRODUCE, and the arithmetic says so:
//
//   perspectiveDepthToViewZ IS reversed-aware (ViewportDepthNode.js:229). Its
//   reversed branch, near*far / ((near-far)*d - near), maps our reversed buffer
//   correctly: d=1 (near) -> -near, d=0 (background) -> -far. viewZ is negative,
//   as the comment at ViewportDepthNode.js:140 promises.
//
//   viewZToOrthographicDepth (:152) is (viewZ + near) / (near - far). Both the
//   numerator and the denominator are negative for any viewZ in [-near, -far],
//   so correctDepth lands in [0, 1] — POSITIVE — under reversed and standard
//   depth alike. It is a plain linear remap of viewZ; it has no handedness to
//   get wrong. With this project's camera (config.ts:386-390, near 0.3,
//   far 24000) a surface 20 m out gives correctDepth = 8.2e-4 and a tolerance of
//   4.1e-5, which is ±0.98 m of view distance. The edge test fires.
//
//   Expanding both sides shows the stock test is already scale-relative:
//   |Δ viewZ| / (far-near) < 0.05 * (|viewZ| - near) / (far-near), i.e.
//   |Δ viewZ| < 0.05 * (|viewZ| - near). The far-normalisation cancels.
//
// So the vendored version below is a robustness and clarity change, not a
// rescue. Three deviations from upstream, all deliberate:
//
//  1. The edge test is stated in VIEW-SPACE METRES (5% of the pixel's own view
//     distance) instead of in far-normalised orthographic depth. Numerically
//     within the `near` offset of the original, but it no longer depends on a
//     (far - near) factor cancelling out of both sides of an inequality — which
//     is the property that made the stock line look wrong to two readers, and
//     which would genuinely break if anyone ever passed an infinite far plane
//     (correctDepth -> 0, tolerance -> 0, edge protection off). Reversed depth
//     is exactly the setup where an infinite far plane is tempting.
//  2. `pushDir.divAssign( count ).normalize()` upstream DISCARDS the normalize
//     — divAssign returns the assignment, and nothing consumes the normalized
//     node. The push therefore scales with how many neighbours agreed as well as
//     with edgeStrength (up to ~2x the intended offset at edgeRadius 2). Here the
//     normalize is assigned.
//  3. Plain TS function rather than `Fn([...])`. The one caller passes a camera
//     and an options object positionally; a real function documents that better
//     and inlines to the same graph.
//
// Everything else — the 8-tap Poisson disk, the push direction, the `.r`
// channel read and the final mix — is upstream verbatim.
import {
  abs,
  array,
  color,
  float,
  If,
  int,
  ivec2,
  Loop,
  mix,
  nodeObject,
  perspectiveDepthToViewZ,
  reference,
  textureSize,
  uv,
  vec2,
  vec4
} from "three/tsl"
import type * as THREE from "three/webgpu"
import type { N } from "../../types"

/** 5% of the pixel's view distance, upstream's constant in its new units. */
const EDGE_TOLERANCE = 0.05

export type DepthAwareBlendOptions = {
  blendColor?: N
  edgeRadius?: N | number
  edgeStrength?: N | number
}

export function depthAwareBlend(
  baseNode: N,
  blendNode: N,
  depthNode: N,
  camera: THREE.Camera,
  options: DepthAwareBlendOptions = {}
): N {
  const uvNode = baseNode.uvNode || uv()

  const cameraNear = reference("near", "float", camera)
  const cameraFar = reference("far", "float", camera)

  const blendColor = nodeObject(options.blendColor) || color(0xffffff)
  const edgeRadius = nodeObject(options.edgeRadius) || int(2)
  const edgeStrength = nodeObject(options.edgeStrength) || float(2)

  // Reversed-depth safe without a branch of our own: perspectiveDepthToViewZ
  // picks its reversed form from builder.renderer.reversedDepthBuffer. viewZ is
  // negative in front of the camera, hence the abs() on both sides below.
  const viewZ = perspectiveDepthToViewZ(depthNode, cameraNear, cameraFar)
  const viewDistance = abs(viewZ)

  const pushDir = vec2(0.0).toVar()
  const count = float(0).toVar()

  // `N` (the repo's node alias) rather than the shipped generic: r185's
  // TextureSizeNode does not satisfy the ivec2 overload set, and every node
  // boundary in this codebase is `any` for exactly that reason (types.ts:3-5).
  const size: N = textureSize(baseNode)
  const resolution = ivec2(size).toConst()
  const pixelStep = vec2(1).div(resolution)

  const poissonDisk = array([
    vec2(0.493393, 0.394269),
    vec2(0.798547, 0.885922),
    vec2(0.259143, 0.650754),
    vec2(0.605322, 0.023588),
    vec2(-0.574681, 0.137452),
    vec2(-0.430397, -0.638423),
    vec2(-0.849487, -0.366258),
    vec2(0.170621, -0.569941)
  ])

  Loop(8, ({ i }: { i: N }) => {
    const offset = poissonDisk.element(i).mul(edgeRadius)

    const sampleUv = uvNode.add(offset.mul(pixelStep))
    const sampleDepth = depthNode.sample(sampleUv)

    const sampleViewZ = perspectiveDepthToViewZ(sampleDepth, cameraNear, cameraFar)

    If(
      abs(sampleViewZ).sub(viewDistance).abs().lessThan(viewDistance.mul(EDGE_TOLERANCE)),
      () => {
        pushDir.addAssign(offset)
        count.addAssign(1)
      }
    )
  })

  count.assign(count.equal(0).select(1, count))

  // Deviation 2: upstream drops this normalize on the floor.
  pushDir.assign(pushDir.div(count).normalize())

  const sampleUv = pushDir
    .length()
    .greaterThan(0)
    .select(uvNode.add(edgeStrength.mul(pushDir.div(resolution))), uvNode)

  const bestChoice = blendNode.sample(sampleUv).r
  const baseColor = baseNode.sample(uvNode)

  return vec4(mix(baseColor, vec4(blendColor, 1), bestChoice))
}
