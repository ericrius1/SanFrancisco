/**
 * The chain order, stated once.
 *
 * `PostStage.order` is documented as "fixed constants in chain.ts, not
 * per-stage" — the point being that ordering is a chain-level decision no stage
 * gets to argue with. It lives in its own module rather than literally inside
 * `chain.ts` only because `chain.ts` imports every stage factory, so a stage
 * reading the constant back out of `chain.ts` would be an import cycle. The
 * chain sorts by these values; a stage merely reports the one that belongs to
 * its id.
 *
 * Gaps of 10 are deliberate: a stage inserted later takes a free slot instead of
 * renumbering a file some other unit owns.
 */
export const STAGE_ORDER = {
  /** Screen-space motion vectors. Feeds the temporal resolve. */
  velocity: 10,
  /** Camera sub-pixel offset. Applied by the frame driver BEFORE the beauty pass. */
  jitter: 20,
  /** Half-res ground-truth ambient occlusion. */
  ssao: 30,
  /** Masked screen-space reflections. */
  ssr: 40,
  /** Piano-grove raymarched god rays; publishes an alternate beauty source. */
  godrays: 45,
  /** Linear-HDR fold: occlusion × beauty + SSR, then the underwater package. */
  composite: 50,
  /** TAAU resolve. The only stage that changes chain resolution input → output. */
  temporal: 60,
  /** Depth of field. Off in live play. */
  dof: 70,
  /** Bloom, in linear HDR before the display transform. */
  bloom: 80,
  /** Display transform + LUT. No pass of its own — fused into the display tail. */
  grade: 90,
  /** RCAS. No pass of its own — fused into the display tail. */
  sharpen: 100,
  /** Film grain. No pass of its own — fused into the display tail. */
  grain: 110,
  /** The one THREE.RenderPipeline. Always last, always enabled. */
  display: 120
} as const
