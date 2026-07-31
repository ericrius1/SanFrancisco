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
  /**
   * Smallest edge, in texels, this target may ever be sized to. Default 1.
   *
   * It exists for ONE class of target and should not be set without that
   * reason: a texture whose `mipmaps` array is pre-populated so
   * `Textures.getMipLevels` allocates a fixed level count (`Textures.js:502-508`
   * returns `texture.mipmaps.length` verbatim). WebGPU rejects a
   * `mipLevelCount` larger than `floor(log2(maxEdge)) + 1`, so such a target is
   * a hard validation failure below its floor rather than a degrade — and the
   * POOL is the sizing path that runs even while the owning stage is disabled
   * and never calls its own `setSize`. Declaring the floor on the spec is what
   * keeps the pool and the stage from disagreeing; SSR's blur chain is the only
   * target in the chain that needs it.
   */
  readonly minEdge?: number
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
   *  (pipeline.ts returns early) or warmup covered renders. H-key still
   *  accumulation DOES advance it — consecutive still presents need consecutive
   *  indices so the temporal resolve accumulates rather than re-seeds. The
   *  jitter index and the temporal history are both keyed to it. */
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

  /**
   * Per-frame reconcile for a stage that may be SKIPPED. Called by the chain
   * once per presented frame for every stage, BEFORE `enabled()`, with no render
   * pass open.
   *
   * This exists so `enabled()` can be a pure predicate. It was not: `enabled()`
   * used to be the only per-frame hook a skipped stage got, so SSR wrote
   * `ssr.active` and SSAO wrote `aoStrength` from inside it — which meant any
   * probe that polled the predicate was writing GPU uniforms (chain.ts records
   * that measurement on `lastRan`). Neutralising a skipped stage's contribution
   * belongs here; deciding whether it runs belongs in `enabled()`.
   *
   * It is also where a stage may do work in order to EARN a skip — SSR's dry
   * probe is one 8x8 draw that buys skipping six half-res passes. Anything here
   * must be cheap enough to pay for itself on the frame the stage is off.
   */
  prepare?(frame: PostFrameContext): void

  /** Live enable check. The chain calls this once per frame, AFTER `prepare()`.
   *  Returning false means the stage is SKIPPED — not blitted, not cleared, not
   *  rendered. Its targets stay allocated so re-enabling is also free.
   *
   *  KEEP IT PURE. No uniform writes, no allocation, no GPU work — probes poll
   *  it (`.data/postfx/smoke-probe.mjs`), and a predicate with side effects
   *  makes every such poll perturb the thing it is measuring. `prepare()` above
   *  is the hook for anything that has to happen anyway. */
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

/**
 * What the last PRESENTED frame did. Three lists, because "how much did this
 * frame cost" and "which looks were applied" are different questions and
 * conflating them made the answer wrong in both directions.
 *
 * `enabled`/`passes` is the cost. `inline` is the looks that ran with no pass of
 * their own — the jitter hook, plus grade / sharpen / grain, which are fused
 * into the display tail's single fragment shader. `inline` is populated even
 * under the master bypass, because bypassing the CHAIN does not bypass the tail.
 */
export type PostChainState = {
  /** Stages that issued a PASS last frame, in the order they ran. */
  enabled: string[]
  /** Stages that were ACTIVE last frame but own no pass. */
  inline: string[]
  /** Beauty-pass width ÷ drawing-buffer width on the last presented frame. */
  inputScale: number
  /**
   * `enabled.length` — STAGES that issued GPU work, NOT fullscreen draws.
   *
   * The distinction is worth 3x: at the shipped defaults this reads 7 while the
   * frame issues roughly two dozen fullscreen draws, because three of those
   * stages are multi-pass internally (bloom's mip chain is ~12, SSR's march +
   * copy + blur levels are 6, the temporal resolve is 1–2). Anyone reading this
   * as a draw count is off by about that factor. It is the right granularity for
   * what it is FOR — "which parts of the chain ran, and did my toggle land" —
   * and the honest place to get a cost is the ablation instrument in
   * .data/postfx/perf/, never this number.
   */
  passes: number
}

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
  /** The single THREE.RenderPipeline that presents. */
  readonly displayPipeline: THREE.RenderPipeline
  readonly stages: readonly PostStage[]
  stage(id: string): PostStage | undefined
  /**
   * For the debug panel and probes. A pure read of the LAST PRESENTED FRAME —
   * `enabled` is what actually rendered, in order, and `passes` is its length.
   *
   * Deliberately history and not prediction. Re-deriving `enabled` from the live
   * `stage.enabled()` predicates made the two fields answer different questions
   * and disagree by construction under the master toggle (the bypass runs one
   * pass; the predicates named all seven that would have run). It also was not
   * read-only: `enabled()` is the only per-frame hook a skipped stage gets and
   * SSR clears `ssr.active` from it, so polling perturbed the thing it measured.
   *
   * Consequence for callers: a tunable written this tick is visible here only
   * after the next presented frame. Tick, then read.
   *
   * Second consequence, which reads as an anomaly if you do not expect it: a tick
   * that does NOT present — the compile gate holds frames (pipeline.ts:74-88) —
   * leaves this reporting the previous frame's record while `renderer.info`
   * records no new draw calls. A probe sampling both per tick will see state
   * "advance" with a flat draw count around any real await that lets a queued
   * compile land. That is the contract working, not a chain fault.
   */
  readonly state: () => PostChainState
  readonly grade: import("../grade").GradeRuntime
  dispose(): void
}
