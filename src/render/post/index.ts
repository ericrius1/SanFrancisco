/**
 * The only public entry to the post chain. `pipeline.ts` builds the beauty pass
 * and the g-buffer and hands them here; everything downstream of the beauty pass
 * lives under `post/`.
 */
export { createPostChain, type PostChainDeps } from "./chain"
export { STAGE_ORDER } from "./order"
export { POST_TUNING, postInputScale } from "./tuning"
export { collectChainQuads } from "./warmup"
export { createGBufferDecoders, beautyGBufferAttachment, writeSsrMask } from "./shared/gbuffer"
export { cameraJitter, type CameraJitter } from "./jitter"
export { godRaysControls, type GodRaysControls, type GodRaysState } from "./godrays"
export { setUnderwaterPostFx } from "./composite"
export { setFlowPostFx } from "./display"
export type {
  N,
  PostChain,
  PostFrameContext,
  PostGBuffer,
  PostStage,
  PostStageSetup,
  StageResolution,
  StageTuning,
  TargetSpec,
  TextureSlot
} from "./types"
