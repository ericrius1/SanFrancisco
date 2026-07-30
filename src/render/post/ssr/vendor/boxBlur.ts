// VENDORED from three/examples/jsm/tsl/display/boxBlur.js — three r185 (0.185.1).
//
// Why vendored at all: the SSR fork bakes the kernel `size` into this node tree
// (that is the whole reason `blurQuality` is a recompileKey), and an addon that
// three is free to reshape between patch releases must not be load-bearing for a
// stage whose recompile behaviour we are making promises about.
//
// DEVIATIONS FROM UPSTREAM, and why:
//
//  1. `convertToTexture( textureNode )` (upstream:28) is REMOVED; the parameter is
//     now required to already be a TextureNode. `convertToTexture` falls back to
//     `rtt( node )` for anything else, and an RTTNode is `NodeUpdateType.RENDER`
//     — it renders its own quad from `_nodes.updateBefore`, which this chain
//     forbids outright (see post/chain.ts for the measured failure). The SSR fork
//     only ever hands this a `texture( renderTarget.texture )`, so the fallback
//     was pure scheduling risk for zero benefit.
//  2. `premultipliedAlpha` is dropped. SSR reflections are additive scene-linear
//     radiance in `.rgb` with a ray-length payload in `.a`; premultiplying by
//     that alpha would scale the colour by a distance in metres.
//  3. TypeScript signatures. Node parameters are `N` (= any) throughout, matching
//     every other TSL module in this repo.
//
// Everything else — the single-pass (size*2+1)² kernel, the `separation` spread,
// the `pixelStep` from `textureSize` — is upstream's, unchanged.
import * as TSL from "three/tsl"
import type { N } from "../../types"

// @types/three models TSL's return types precisely enough that faithfully
// transcribed upstream expressions (`min(node, TextureSizeNode)`, `Loop({ name })`,
// `vec3(vec3Node)`) do not typecheck, even though they are exactly what three's
// own source does. Every TSL boundary in this repo is already `N` (= any) for the
// same reason; taking the whole namespace loose ONCE keeps the vendored body
// diffable against upstream instead of littered with casts.
const { Fn, Loop, int, max, nodeObject, textureSize, uv, vec2, vec4 } =
  TSL as unknown as Record<string, N>

export type BoxBlurOptions = {
  /** Kernel half-width. BAKED: `(size*2+1)²` taps, so the loop bounds are
   *  compile-time constants. Keep it in [1,3]; widen with `separation` instead. */
  size?: number
  /** Tap spacing in texels. A node — free to vary per pass, no recompile. */
  separation?: N
}

export const boxBlur = /*#__PURE__*/ Fn(([textureNode, options = {}]: N[]): N => {
  const size = nodeObject(options.size ?? 1)
  const separation = nodeObject(options.separation ?? int(1))

  const targetUV = textureNode.uvNode || uv()

  const result = vec4(0)
  const sep = max(separation, 1)
  const count = int(0)
  const pixelStep = vec2(1).div(textureSize(textureNode))

  Loop({ start: size.negate(), end: size, name: "i", condition: "<=" }, ({ i }: N) => {
    Loop({ start: size.negate(), end: size, name: "j", condition: "<=" }, ({ j }: N) => {
      const uvs = targetUV.add(vec2(i, j).mul(pixelStep).mul(sep))
      result.addAssign(textureNode.sample(uvs))
      count.addAssign(1)
    })
  })

  result.divAssign(count)

  return result
})
