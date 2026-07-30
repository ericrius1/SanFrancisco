import type * as THREE from "three/webgpu"

/** A TSL node. The three typings do not export a useful union, and every
 *  existing render module in this repo uses `any` at node boundaries. */
export type N = any

// ---------------------------------------------------------------- targets

export type TargetSpec = {
  /** Debug name. Underscores only — the name is emitted verbatim as a WGSL
   *  identifier in some codegen paths and a dot is a parse error
   *  (see pianoGodRays.ts:112-118). */
  readonly name: string
  /** "input" = beauty-pass resolution (output × temporalScale).
   *  "output" = drawing-buffer resolution. */
  readonly resolution: StageResolution
  /** Further multiplier applied on top, e.g. 0.5 for half-res SSAO. */
  readonly scale?: number
  readonly format?: THREE.PixelFormat
  readonly type?: THREE.TextureDataType
  readonly colorSpace?: THREE.ColorSpace
  /** Extra colour attachments. Index 0 is the primary. */
  readonly count?: number
}

export type StageResolution = "input" | "output"

/** A `texture()` node whose `.value` the chain rebinds every frame to whatever
 *  the last ENABLED upstream stage produced. Rebinding a Texture object updates
 *  a binding, not a shader — three's own DepthOfFieldNode swaps
 *  `_CoCTextureNode.value` three times per frame (DepthOfFieldNode.js:294, 303,
 *  319). This is the mechanism that makes a disabled stage cost exactly zero:
 *  it is skipped, not blitted through. */
export interface TextureSlot {
  /** The TSL node to sample. Stable for the lifetime of the stage. */
  readonly node: N
  /** Called by the chain only. */
  bind(texture: THREE.Texture): void
  /** Texel size uniform, kept in sync with the bound texture. */
  readonly texelSize: N
}

// ---------------------------------------------------------------- g-buffer

/** Everything the beauty pass publishes. Handed to every stage at setup. */
export interface PostGBuffer {
  /** Scene-linear HDR colour, rgba16float, INPUT resolution. */
  readonly colour: N
  /** Raw depth. reversedDepthBuffer is ON, so background is 0.0 and near is 1.0.
   *  NEVER compare against 1.0 — use shared/reversedDepth.ts. FloatType. */
  readonly depth: N
  /** RGBA8: rgb = directionToColor(normalView), a = SSR reflectivity mask. */
  readonly gbuffer: N
  /** Decoded view-space normal (already normalized). */
  normalViewAt(uv: N): N
  /** SSR reflectivity/wetness mask, 0..1. Zero on every surface that has not
   *  explicitly opted in via writeSsrMask(). */
  reflectivityAt(uv: N): N
  /** View-space position from raw depth. Reversed-Z safe: getViewPosition feeds
   *  raw depth straight into clip.z and the camera's projectionMatrixInverse IS
   *  the reversed inverse (Matrix4.js:1159). Do NOT "fix" this. */
  viewPositionAt(uv: N): N
  /** Screen-space motion in NDC units, rg16float, INPUT resolution.
   *  Null when the velocity stage is disabled. */
  readonly velocity: N | null
  readonly camera: THREE.PerspectiveCamera
  /** uniform(camera.projectionMatrixInverse) — object reference, re-uploads
   *  every frame, so it tracks the TAA jitter automatically. */
  readonly projectionInverse: N
  readonly cameraNear: N
  readonly cameraFar: N
}

// ---------------------------------------------------------------- per-frame

export interface PostFrameContext {
  readonly renderer: THREE.WebGPURenderer
  /** Drawing-buffer size. The adaptive-resolution governor owns this. */
  readonly outputWidth: number
  readonly outputHeight: number
  /** Beauty-pass size = output × temporalScale. */
  readonly inputWidth: number
  readonly inputHeight: number
  /** Monotonic PRESENTED-frame counter. Does NOT advance on compile-held frames
   *  (pipeline.ts:994-998 returns early), on warmup covered renders, or on
   *  captureStillRgba. The jitter index and the temporal history are both keyed
   *  to it, so they can never desync from the projection sequence. */
  readonly frameIndex: number
  readonly dt: number
  /** Set for one frame after a resize, teleport, look change, warmup render or
   *  still capture. Temporal stages must seed rather than accumulate. */
  readonly historyInvalid: boolean
}

// ---------------------------------------------------------------- tunables

/**
 * Any persisted `tunables()` group, with its key literals erased.
 *
 * DEPARTURE FROM THE BRIEF, with evidence: the brief specified
 * `ReturnType<typeof tunables>` verbatim, but `tunables` is generic in its spec
 * and `ReturnType` instantiates it at the constraint. The resulting `bind()`
 * carries `keys?: string[]` and `onChange: (key: string, …)`, which is
 * CONTRAVARIANT against every concrete group's `keys?: ("enabled" | …)[]` — so
 * no real group is assignable and every stage failed to typecheck. Widening only
 * `bind`'s parameters keeps `values` exactly as the brief had it, which is the
 * half stages actually read.
 */
export type TunableGroup = {
  readonly values: ReturnType<typeof import("../../core/persist").tunables>["values"]
  bind(folder: any, hooks?: any): unknown
}

export interface StageTuning {
  /** The persisted group. MUST live at its own dotted path ("post.ssao") —
   *  core/persist.ts:187-195 fingerprints per group and discards that group's
   *  saved overrides when its spec changes, and clearGroupOverrides only deletes
   *  keys one segment deep, so sibling stages are never collateral. */
  readonly group: TunableGroup
  /** Keys that reallocate a render target or change a resolution. The panel
   *  gates these on slider RELEASE (last === true) and calls chain.applyStructure().
   *  Precedent: SHADOW_TUNING.contactResolutionScale, debug.ts:1036-1037. */
  readonly structuralKeys: readonly string[]
  /** Keys baked into the node graph as JS constants, whose change REQUIRES a
   *  shader rebuild. INVARIANT: this must be EMPTY for any stage that is enabled
   *  by default. The panel renders these under a separate "rebuild" subfolder
   *  with an explicit Apply button — never a live slider. */
  readonly recompileKeys: readonly string[]
}

// ---------------------------------------------------------------- the stage

export interface PostStageSetup {
  readonly renderer: THREE.WebGPURenderer
  readonly gbuffer: PostGBuffer
  readonly matrices: import("./shared/matrices").CameraHistory
  /** Allocate a chain-owned target. The chain resizes and disposes it. */
  readonly allocTarget: (spec: TargetSpec) => THREE.RenderTarget
  /** The upstream colour slot. Rebound per frame by the chain. */
  readonly inputSlot: () => TextureSlot
}

export interface PostStage {
  readonly id: string
  readonly label: string
  /** Chain order; lower runs first. Fixed constants in chain.ts, not per-stage. */
  readonly order: number
  /** Does this stage replace the chain colour, or only read it? */
  readonly kind: "colour" | "aux" | "inline"
  /** Resolution of the colour this stage produces. Only the temporal stage
   *  changes it from "input" to "output". */
  readonly resolution: StageResolution

  /** Live enable check. The chain calls this once per frame. Returning false
   *  means the stage is SKIPPED — not blitted, not cleared, not rendered.
   *  Its targets stay allocated so re-enabling is also free. */
  enabled(): boolean

  /** The colour texture this stage produced this frame, or null for "aux"/"inline".
   *  Only read by the chain, only when enabled() returned true. */
  output(): THREE.Texture | null

  /** Render. Called ONLY by the chain, from pipeline.render(), with NO render
   *  pass open. Must leave renderer render-target state as it found it —
   *  use RendererUtils.resetRendererState/restoreRendererState. */
  render(frame: PostFrameContext): void

  /** Resize owned targets. The chain calls this whenever input or output size
   *  changes, before render(). */
  setSize(frame: PostFrameContext): void

  /** Drop temporal history. Optional. */
  invalidateHistory?(): void

  /** Every quad whose WGSL must be compiled at boot. The chain hands the union
   *  of these to compileFullscreenQuads() so no toggle can ever create an
   *  uncompiled pipeline at runtime. */
  warmupQuads(): THREE.QuadMesh[]

  /** Push tunable values into live uniforms. MUST NOT recompile, reallocate, or
   *  reselect anything. Called from the panel's fallback lane and from
   *  chain.applyParams(). */
  applyParams(): void

  /** Reallocate targets / rebuild baked graphs after a structural key changed.
   *  Called only on slider release or an explicit Apply. */
  applyStructure?(): void

  readonly tuning: StageTuning
  dispose(): void
}

// ---------------------------------------------------------------- the chain

export interface PostChain {
  /** Drive one presented frame. Called from pipeline.render() AFTER
   *  contactShadows.renderNow() and AFTER the beauty pass has been driven. */
  render(frame: PostFrameContext): void
  /** Push every stage's sliders into uniforms. No recompile. */
  applyParams(): void
  /** Reallocate/rebuild after a structural change. May compile. */
  applyStructure(): void
  /** Force every temporal stage to seed on the next frame. */
  invalidateHistory(reason: string): void
  /** For compileFullscreenQuads at boot. */
  warmupQuads(): THREE.QuadMesh[]
  /** The single THREE.RenderPipeline that presents. */
  readonly displayPipeline: THREE.RenderPipeline
  readonly stages: readonly PostStage[]
  stage(id: string): PostStage | undefined
  /** For the debug panel and probes. */
  readonly state: () => { enabled: string[]; inputScale: number; passes: number }
  readonly grade: import("../grade").GradeRuntime
  dispose(): void
}
