import type * as THREE from "three/webgpu"

/**
 * How the masked-SSR stage reaches the composite.
 *
 * `PostStage.output()` is documented (types.ts:159-161) as "null for aux/inline"
 * and `chain.ts:223-226` only threads a `"colour"` stage's output forward, so
 * there is no channel in the shared interfaces for "SSR produced a reflection
 * buffer this frame, fold it in" — and `chain.ts` / `types.ts` are shared files
 * this unit may not edit.
 *
 * SSAO does NOT come through here: U2 publishes a module-level `ssaoFactorAt(uv)`
 * node accessor that reads exactly 1.0 while the stage is off (ssao/index.ts:70),
 * which is strictly better than a texture handoff because the neutral case needs
 * no branch at all. This registry is the same idea one level down — a Texture
 * rather than a node — and exists only because U3's stage had not published its
 * accessor when this was written. **When it does, replace `ssrColourAt()` in
 * ./index.ts with that import and delete this file.**
 *
 * A pull, resolved once per frame inside `composite.render()`, rather than a
 * push: nothing has to be re-pushed after a resize (a RenderTarget keeps texture
 * identity across `setSize`) or after a toggle. `null` means "not this frame" —
 * disabled, unallocated, or skipped — and is never an error: the composite binds
 * an exact identity (black) in its place and skips the fetch with a uniform
 * branch, so a chain with no SSR stage produces bit-identical pixels to Wave 0's
 * composite.
 *
 * INTEGRATION (U3, or whoever wires the chain): one line at the bottom of the
 * stage factory —
 *
 *   provideReflections(() => (stage.enabled() ? target.texture : null))
 *
 * Module-level, like `setUnderwaterPostFx`, because there is exactly one chain
 * per session and the alternative — a third constructor argument on
 * `createCompositeStage` — would mean editing `chain.ts`.
 */
export type AuxTextureSource = () => THREE.Texture | null

let ssrSource: AuxTextureSource | null = null

/** Masked SSR's half-res reflection colour, in linear HDR (rgba16float). */
export function provideReflections(source: AuxTextureSource | null): void {
  ssrSource = source
}

export function reflectionsTexture(): THREE.Texture | null {
  return ssrSource ? ssrSource() : null
}

/** Chain teardown / HMR. A stale closure here would outlive its render target. */
export function clearAuxSources(): void {
  ssrSource = null
}
