import * as THREE from "three/webgpu";
import { NodeUpdateType, mrt, output, pass, texture, uniform } from "three/tsl";
import { createContactShadowComplement } from "./contactShadows";
import { SHADOW_LAYERS } from "../world/shadows/shadowLayers";
import { SHADOW_TUNING } from "../world/shadows/tuning";
import { tracer } from "../core/hitchTracer";
import { motionGate } from "../core/motionGate";
import { warmScenePaced } from "./warmStaticRegion";
import { createCompileGate } from "./compileGate";
import { createCaptureRuntime } from "./capture";
import { createWireframeOverride } from "./wireframe";
import { createPostChain, warmChainQuads } from "./post";
import { beautyGBufferAttachment, createGBufferDecoders } from "./post/shared/gbuffer";
import { cameraJitter } from "./post/jitter";
import { godRaysControls } from "./post/godrays";
import { POST_TUNING, postInputScale } from "./post/tuning";
import { TEMPORAL_TUNING } from "./post/temporal/tuning";
import type { WorldUiOverlay } from "./post/display";
import type { N, PostFrameContext, PostGBuffer } from "./post/types";
import {
  deferredTextureDisposalState,
  markTextureDisposalFrame
} from "./textureDisposePatch";

/** "boot": compile what the first live frames need. "full": revisit the scene
 * for materials added by deferred world modules, and warm both wireframe
 * camera identities. The post-FX scope split is GONE — there is one chain and
 * every stage's quad compiles unconditionally at boot. */
type WarmupScope = "boot" | "full";
type QueueBackedRenderer = THREE.WebGPURenderer & {
  backend: { device?: { queue: { onSubmittedWorkDone(): Promise<unknown> } } };
};

const BEAUTY_ONLY_LAYER = SHADOW_LAYERS.BEAUTY_ONLY;

/** The full public surface of the render pipeline object. `src/ui/debug.ts`
 *  checks its `DebugRenderPipeline` contract against this — see the note there
 *  on why that is the ONLY compile-checked consumer. */
export type RenderPipelineApi = ReturnType<typeof createRenderPipeline>;

/**
 * WebGPU render graph: ONE beauty pass publishing colour + depth + a packed
 * normal/SSR-mask g-buffer, and ONE explicitly-driven post chain that ends in
 * the single RenderPipeline that presents.
 *
 * The structural decision everything else follows from lives in post/chain.ts:
 * no stage is ever scheduled by the node graph. `Renderer.js:3778` fires
 * `_nodes.updateBefore` from inside an open render pass, and a FRAME-scoped node
 * that renders its own quad from there makes WebGPU reject the whole command
 * buffer — measured at ~70% of frames coming out as bare clear colour
 * (contactShadows.ts:326-345). Every node this file and the chain own therefore
 * set `updateBeforeType = NodeUpdateType.NONE`, including the beauty pass itself.
 */
export function createRenderPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  directionalLight: THREE.DirectionalLight | null = null
) {
  // Beauty sees the ordinary world plus ephemeral hashed markers. With the
  // half-res outline prepass deleted, layer 31 is no longer excluded from
  // anything — it now writes to the g-buffer too. Watch for additive markers
  // corrupting normals at the Sutro hall (steam) and the Afterlight grove
  // (fireflies); the mitigation is `writeSsrMask(mat, float(0))` on the
  // offenders, not another pass. Do not chase it before measuring.
  camera.layers.enable(BEAUTY_ONLY_LAYER);

  // ------------------------------------------------------------ beauty pass
  //
  // Live play is permanently single-sample. See setCinematicMultisampling for
  // why MSAA on this pass is a logged no-op now.
  const scenePass = pass(scene, camera, { samples: 0 });
  scenePass.setMRT(
    mrt({
      output,
      gbuffer: beautyGBufferAttachment()
    })
  );
  // MRTNode.setup() silently SKIPS any output whose texture does not exist
  // (MRTNode.js:174 `if (index === -1) continue;`). This getTexture call is what
  // allocates the attachment — without it the MRT entry is a no-op and the
  // buffer reads all-zero, which looks exactly like "nothing wrote normals".
  const gbufferTex = scenePass.getTexture("gbuffer");
  gbufferTex.type = THREE.UnsignedByteType; // RGBA8
  // PassNode.setup() forces the output buffer type on index 0 ONLY
  // (PassNode.js:766), so this override survives every rebuild — the same trick
  // the deleted ink prepass used.
  //
  // DO NOT RENAME `gbufferTex`. `MRTNode.setup()` resolves each MRT key to an
  // attachment index with `getTextureIndex(renderTarget.textures, name)` — a
  // match on `texture.name` — and silently `continue`s on -1. Renaming it to
  // something prettier makes the fragment stage emit ONE output while the
  // target has TWO attachments, and every material in the world then fails
  // pipeline creation with "Color target has no corresponding fragment stage
  // output but writeMask is not zero. While validating targets[1]". Measured:
  // the whole frame comes back as clear colour. The brief's §3.1 snippet
  // suggests a descriptive name here; it is wrong.

  const sceneColour = scenePass.getTextureNode() as N;
  const sceneDepth = scenePass.getTextureNode("depth") as N;
  const sceneGBuffer = scenePass.getTextureNode("gbuffer") as N;

  // The frame driver drives this pass explicitly. `PassNode.updateBefore(frame)`
  // only reads `frame.renderer` (verified against PassNode.js) and does its own
  // setSize / MRT / layer / override-material handling, so a bare
  // `{ renderer }` is a safe and complete drive.
  scenePass.updateBeforeType = NodeUpdateType.NONE;
  const driveBeautyPass = () => {
    (
      scenePass as unknown as {
        updateBefore(frame: { renderer: THREE.WebGPURenderer }): void;
      }
    ).updateBefore({ renderer });
  };

  // ...which means the pass node is no longer reachable from any graph that the
  // display pipeline builds, so `PassNode.setup()` may never run — and setup()
  // is what normally forces the HDR colour type and the FloatType depth under
  // reversedDepthBuffer. Both would silently fall back to an RGBA8 target and a
  // depth24plus depth texture, which is not a visual bug so much as a whole
  // class of them (banded HDR, a depth format nothing else in the chain can
  // copy). State them here instead of hoping something builds the node.
  scenePass.renderTarget.texture.type = renderer.getOutputBufferType();
  if (renderer.reversedDepthBuffer === true && scenePass.renderTarget.depthTexture !== null) {
    scenePass.renderTarget.depthTexture.type = THREE.FloatType;
  }

  // Object-reference uniform: uploads the camera's current inverse projection
  // every frame, reversed-z included — so it tracks the TAA jitter for free.
  const projectionInverse = uniform(
    (camera as THREE.PerspectiveCamera).projectionMatrixInverse
  ) as N;
  const gbuffer: PostGBuffer = {
    colour: sceneColour,
    depth: sceneDepth,
    gbuffer: sceneGBuffer,
    ...createGBufferDecoders({
      gbufferNode: sceneGBuffer,
      depthNode: sceneDepth,
      projectionInverse
    }),
    // Populated by the velocity stage during chain construction, not here: the
    // pixels are that stage's, not the beauty pass's. It is safe because
    // STAGE_ORDER.velocity is the lowest and chain.ts's registry literal builds
    // velocity first, so every downstream stage sees a real node while it is
    // still building its own graph. It stays non-null when the stage is
    // DISABLED (a graph cannot be unbuilt) and the texture then holds the last
    // frame it rendered — a consumer that must tell "no motion" from "stale
    // motion" reads `velocityOf(chain.stage("velocity")).enabled`, never
    // `gbuffer.velocity !== null`.
    velocity: null,
    camera: camera as THREE.PerspectiveCamera,
    projectionInverse,
    cameraNear: uniform((camera as THREE.PerspectiveCamera).near) as N,
    cameraFar: uniform((camera as THREE.PerspectiveCamera).far) as N
  };

  // Reuse the lit pass depth so the close-contact complement adds only its
  // half-resolution six-tap fullscreen pass—not a second geometry prepass.
  const contactShadows = createContactShadowComplement({
    depthTex: sceneDepth,
    camera,
    light: directionalLight,
    normalTex: null,
    options: {
      resolutionScale: SHADOW_TUNING.values.contactResolutionScale,
      maxDistance: SHADOW_TUNING.values.contactMaxDistance,
      thickness: SHADOW_TUNING.values.contactThickness,
      intensity: SHADOW_TUNING.values.contactIntensity,
      fadeStart: SHADOW_TUNING.values.contactFadeStart,
      fadeEnd: SHADOW_TUNING.values.contactFadeEnd,
      normalBias: SHADOW_TUNING.values.contactNormalBias
    }
  });
  contactShadows.setEnabled(SHADOW_TUNING.values.enabled && SHADOW_TUNING.values.contactEnabled);

  // NOTE for anyone reaching for MSAA on this pass at runtime: it does not work
  // here, and the failure is silent-ish. Raising `samples` multisamples the
  // pass's DEPTH attachment too, and several consumers bind that depth as an
  // ordinary non-multisampled texture — the contact-shadow complement above and
  // the underwater package in the composite. WebGPU rejects the bind group
  // ("Sample count (4) of [Texture "depth"] doesn't match expectation
  // (multisampled: 0)") and the whole frame drops to clear colour. Measured,
  // not theorised — and the new chain adds five more depth consumers, while
  // TRAA/TAAU require MSAA off outright (TRAANode.js:17).
  //
  // The interior pockets therefore buy coverage with resolution instead (see
  // render/pocketQuality.ts), which costs only fragment work and leaves every
  // depth consumer's format untouched.
  let cinematicMultisamplingWarned = false;
  const setCinematicMultisampling = (enabled: boolean) => {
    if (!enabled || cinematicMultisamplingWarned) return;
    cinematicMultisamplingWarned = true;
    console.info(
      "[render] setCinematicMultisampling is a no-op: the beauty depth attachment has six consumers and a multisampled depth texture is not bindable."
    );
  };

  const wireframe = createWireframeOverride({ scenePass, camera });

  const compileGate = createCompileGate({ renderer, scene, camera, scenePass });

  // ---------------------------------------------------------- world-UI pass
  //
  // In-world affordances (aim cursor, readable signs) that need real 3D
  // occlusion but must not enter TAA history or pick up film grain. Own scene +
  // full-res pass, driven explicitly like the beauty pass, then composited in
  // the display tail AFTER grade/sharpen/grain with premultiplied over. Do NOT
  // mix renderer.render() after RenderPipeline.present — three rejects that
  // path; compositing inside the display shader is the supported route.
  const worldUiScene = new THREE.Scene();
  worldUiScene.name = "world_ui";
  const worldUiPass = pass(worldUiScene, camera, { samples: 0 });
  worldUiPass.updateBeforeType = NodeUpdateType.NONE;
  // Always native drawing-buffer resolution — crisp UI, independent of the
  // beauty pass's temporal/governor scale.
  worldUiPass.setResolutionScale(1);
  const worldUiClearColor = new THREE.Color(0x000000);
  const driveWorldUiPass = () => {
    // Opaque canvas clear is a=1 by default; world-UI needs a transparent clear
    // so empty pixels do not replace the graded beauty under premultiplied over.
    const prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(worldUiClearColor);
    renderer.setClearColor(0x000000, 0);
    (
      worldUiPass as unknown as {
        updateBefore(frame: { renderer: THREE.WebGPURenderer }): void;
      }
    ).updateBefore({ renderer });
    renderer.setClearColor(worldUiClearColor, prevAlpha);
  };
  const worldUiTextureNode = texture(worldUiPass.getTexture("output")) as N;
  const worldUi: WorldUiOverlay = {
    textureNode: worldUiTextureNode,
    ensureRendered: (_frame: PostFrameContext) => {
      // Keep the pass sized to the presented buffer (still / live / capture).
      if (worldUiPass.getResolutionScale() !== 1) worldUiPass.setResolutionScale(1);
      driveWorldUiPass();
      const tex = worldUiPass.getTexture("output");
      if (worldUiTextureNode.value !== tex) worldUiTextureNode.value = tex;
    }
  };

  // ------------------------------------------------------------- post chain
  const postChain = createPostChain({
    renderer,
    camera: camera as THREE.PerspectiveCamera,
    gbuffer,
    beautyTexture: scenePass.getTexture("output"),
    contactFactorAt: contactShadows.available
      ? (sampleUv: N) => contactShadows.sample(sampleUv)
      : undefined,
    worldUi
  });
  const jitter = cameraJitter(postChain.stage("jitter"));
  const godRays = godRaysControls(postChain.stage("godrays"));
  // The two things `PostStageSetup` does not carry. `chain.ts` constructs every
  // stage from `setup` alone, and `createPianoGodRays` needs the scene its
  // dedicated shadow light attaches to plus the world sun whose direction it
  // copies. Without this call the grove has no god rays at all — the adapter
  // logs a one-time console.error naming this exact line when the area gate
  // fires unattached, so the omission cannot go quiet.
  godRays.attachWorld(scene, directionalLight);

  // ------------------------------------------------------------ frame driver
  const drawingBufferSize = new THREE.Vector2();
  let frameIndex = 0;
  let lastFrameAt = performance.now();
  let historyInvalidPending = true;
  let lastOutputWidth = 0;
  let lastOutputHeight = 0;
  /** True while `capture.present` is driving the chain for an H-key still. */
  let stillPresenting = false;

  /**
   * Halton samples to accumulate into a still when the temporal resolve is live.
   * One seeded frame is the soft pre-TAA look; ~¾ of a 32-long sequence is enough
   * for the resolve to converge at capture resolution without a multi-second hitch.
   */
  const STILL_TEMPORAL_FRAMES = 24;

  const invalidateHistory = (reason: string) => {
    historyInvalidPending = true;
    postChain.invalidateHistory(reason);
  };

  const buildFrameContext = (): PostFrameContext => {
    renderer.getDrawingBufferSize(drawingBufferSize);
    const outputWidth = Math.max(1, Math.round(drawingBufferSize.x));
    const outputHeight = Math.max(1, Math.round(drawingBufferSize.y));
    if (outputWidth !== lastOutputWidth || outputHeight !== lastOutputHeight) {
      lastOutputWidth = outputWidth;
      lastOutputHeight = outputHeight;
      historyInvalidPending = true;
    }

    // The beauty pass's resolution scale is relative to the drawing buffer, and
    // adaptiveResolution.ts stays the single owner of the drawing buffer itself.
    // Applying it HERE, before scenePass.updateBefore, is what makes it take
    // effect this frame — PassNode.setSize reads `_resolutionScale` inside
    // updateBefore.
    //
    // Stills force native beauty (scale 1): the capture already supersamples the
    // drawing buffer toward 4K, and the live 0.77 ceiling exists to buy frame
    // rate — not to soften a downloaded PNG. Enables/toggles stay whatever the
    // player has live; only the resolution ceiling lifts for the still.
    const inputScale = stillPresenting ? 1 : postInputScale();
    if (scenePass.getResolutionScale() !== inputScale) {
      scenePass.setResolutionScale(inputScale);
      historyInvalidPending = true;
    }

    const now = performance.now();
    const dt = Math.min(0.25, Math.max(0, (now - lastFrameAt) / 1000));
    lastFrameAt = now;

    const historyInvalid = historyInvalidPending;
    historyInvalidPending = false;

    return {
      renderer,
      outputWidth,
      outputHeight,
      inputWidth: Math.max(1, Math.floor(outputWidth * inputScale)),
      inputHeight: Math.max(1, Math.floor(outputHeight * inputScale)),
      frameIndex,
      dt,
      historyInvalid
    };
  };

  // ---------------------------------------------------------------- capture
  const capture = createCaptureRuntime({
    renderer,
    present: () => {
      // Same path as a live presented frame (contact shadows → beauty → chain),
      // but the display lands in whatever target capture.ts bound. frameIndex
      // advances so consecutive still presents accumulate temporal history at
      // capture resolution; capture.ts invalidates on both sides so the live
      // history is neither read nor poisoned.
      //
      // It still jitters, and must. The temporal resolve derives its
      // reconstruction weights from `jitterOffsetAt(frame.frameIndex)` — a pure
      // function of the counter, with no shared state to consult — so a beauty
      // pass rendered WITHOUT the offset would be resolved as though it had
      // one, displacing every tap by up to half an input pixel.
      stillPresenting = true;
      try {
        contactShadows.renderNow(renderer);
        frameIndex += 1;
        const frame = buildFrameContext();
        jitter.apply(camera as THREE.PerspectiveCamera, frame);
        // AFTER apply(), for the same reason the live frame does it here —
        // in wireframe mode `scenePass.camera` IS the clone, so a clone
        // carrying the CLEARED projection would render the beauty pass
        // unjittered while the resolve is handed the jittered offset.
        if (wireframe.active) wireframe.syncCamera();
        driveBeautyPass();
        jitter.clear(camera as THREE.PerspectiveCamera);
        postChain.render(frame);
      } finally {
        stillPresenting = false;
      }
    },
    stillAccumulateFrames: () => {
      if (POST_TUNING.values.enabled !== true) return 1;
      if (TEMPORAL_TUNING.values.enabled !== true) return 1;
      return STILL_TEMPORAL_FRAMES;
    },
    invalidateHistory
  });

  const render = () => {
    // M11: the stillness gate samples the presented camera every render call —
    // including held ones, so movement DURING a hold is still observed and
    // waiters/deadlines keep progressing while frames are frozen.
    motionGate.sampleFrame(camera);
    if (compileGate.held) {
      // Held frame: a compile window is mutating shared renderer state (C3).
      // No frameIndex bump and no markTextureDisposalFrame — the jitter
      // sequence and the temporal history are both keyed to PRESENTED frames,
      // and textureDisposePatch.ts:74 counts presented frames too.
      tracer.count("renderSkipCompile");
      return;
    }
    // Promote to the god-ray composite source once the dedicated light's shadow
    // map exists (the beauty pass allocates it a few frames after activation),
    // and demote if a lighting rebuild ever retires that map mid-flight.
    godRays.updatePromotion();
    // Drive the contact complement HERE — top of the frame, before any pipeline
    // render has opened a pass. Its quad samples the beauty pass's depth
    // attachment, and WebGPU rejects a render pass that both writes and binds
    // the same texture, taking the whole command buffer with it. Left to the
    // node graph's FRAME scheduling it fired inside whatever pass was open when
    // the graph first reached it, which made that rejection a coin flip: ~70% of
    // ten-second captures came back as clear colour, the rest were fine.
    contactShadows.renderNow(renderer);

    frameIndex += 1;
    const frame = buildFrameContext();

    jitter.apply(camera as THREE.PerspectiveCamera, frame);
    // AFTER the jitter offset, so wireframe mode carries it. The clone's
    // identity is the point — BundleGroups key their WebGPU command caches by
    // camera identity, so a shared camera would re-record every bundle as line
    // lists and leave them stuck after the toggle clears.
    if (wireframe.active) wireframe.syncCamera();

    // THE BEAUTY PASS, driven explicitly. Never scheduled by the node graph.
    driveBeautyPass();
    // Restore the projection before anything else reads it.
    jitter.clear(camera as THREE.PerspectiveCamera);

    // ?fastcapture redirects the presented frame into a ping-pong readback
    // target. The chain's stages restore whatever target was bound before they
    // ran, so the display tail lands here and every intermediate still writes to
    // its own chain-owned target.
    const captureTarget = capture.fastCaptureTarget;
    if (captureTarget) {
      const previousTarget = renderer.getRenderTarget();
      const previousCubeFace = renderer.getActiveCubeFace();
      const previousMipmapLevel = renderer.getActiveMipmapLevel();
      renderer.setRenderTarget(captureTarget);
      postChain.render(frame);
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    } else {
      postChain.render(frame);
    }
    markTextureDisposalFrame(renderer);
  };

  /**
   * Precompile the scene and the chain's fullscreen quads. This intentionally
   * renders covered warmup frames so BundleGroups are also recorded for the
   * beauty MRT context.
   *
   * Calls are coalesced only while running; invoking warmup again revisits the
   * scene so materials added by deferred world modules are compiled too. Call
   * it while the loading cover is visible and no animation render is running.
   */
  let warmupInFlight: Promise<void> | null = null;
  let warmupRun = 0;
  const warmupOnce = async (scope: WarmupScope, pace?: () => Promise<void>) => {
    const profileWarmup = new URLSearchParams(location.search).has("profile");
    const run = ++warmupRun;
    const startedAt = performance.now();
    let stageStartedAt = startedAt;
    const stages: string[] = [];
    const markStage = (label: string) => {
      if (!profileWarmup) return;
      const now = performance.now();
      stages.push(`${label} ${Math.round(now - stageStartedAt)}ms`);
      stageStartedAt = now;
    };
    // M6: a LIVE (uncovered) warmup re-run must not freeze rendering for one
    // monolithic whole-scene compile — the compile gate holds frames for the
    // full window. Pre-compile every distinct mesh signature in small paced
    // chunks BEFORE the scene sweeps below (live frames keep their normal
    // update types — contact shadows stay live between chunks), so the
    // compilePass sweeps find warm pipelines and finish in a few ms.
    if (pace) {
      const paced = await warmScenePaced(renderer, camera, scene, pace);
      markStage(`paced-prewarm ${paced.representatives}/${paced.meshes} in ${paced.chunks} chunks`);
    }
    const contactUpdateType = contactShadows.pass?.updateBeforeType;
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();

    // Contact samples scenePass depth from a nested QuadMesh render, so it is
    // permanently NONE and driven explicitly from render(); this line only
    // holds that invariant against a pass that arrives already render-scoped.
    // Warmup does not call render(), so the complement simply does not refresh
    // here — its target was initialized by the covered pre-warm render (and by
    // live frames before a late warmup), and frozen contact pixels are
    // sufficient while the loading cover is opaque.
    if (contactShadows.pass) contactShadows.pass.updateBeforeType = NodeUpdateType.NONE;
    try {
      // Visit both retained camera identities so normal and wireframe command
      // bundles coexist; finish on the live mode.
      const selectedWireframeAtStart = wireframe.active;
      const wireframeModes =
        scope === "full" ? [!selectedWireframeAtStart, selectedWireframeAtStart] : [selectedWireframeAtStart];
      for (const wireframeMode of wireframeModes) {
        if (wireframeMode) wireframe.syncCamera();
        wireframe.applyOverride(wireframeMode);
        await compileGate.compilePass(scenePass);
        markStage(`scene-wf${wireframeMode ? 1 : 0}-compile`);
        // compileAsync does not record BundleGroups. A covered render does —
        // and the beauty pass is driven directly now, so this is the render.
        driveBeautyPass();
        markStage(`scene-wf${wireframeMode ? 1 : 0}-record`);
      }
      if (wireframe.active) wireframe.syncCamera();
      wireframe.applyOverride(wireframe.active);

      // World-UI overlay (aim cursor). Empty at boot; still warm the pass so the
      // first live cursor frame does not hitch on pipeline creation.
      await compileGate.compilePass(worldUiPass);
      driveWorldUiPass();
      markStage("world-ui-compile");

      // "Compile every stage's quad once, unconditionally." Strictly cheaper
      // than the eight combinatorial style mega-shaders this replaces, and it
      // removes the boot/full scope distinction for post-FX entirely: after
      // this, no toggle can create a new pipeline at runtime.
      //
      // Through `warmChainQuads`, not `compileFullscreenQuads(warmupQuads())`,
      // and the difference is load bearing rather than stylistic: the WebGPU
      // pipeline cache key includes the bound render context's colour and
      // depth/stencil formats, so compiling with NO target bound warms
      // bgra8unorm + depth32float — the canvas — while every stage but the
      // display tail draws into rgba16float / rg16float / r16float with no
      // depth buffer. `chain.warmupGroups()` carries the source derivation; the
      // adapter binds each group's real target and restores what was bound.
      await warmChainQuads(renderer, postChain, compileGate.compileFullscreenQuads);
      markStage("chain-compile");
    } finally {
      if (wireframe.active) wireframe.syncCamera();
      wireframe.applyOverride(wireframe.active);
      if (contactShadows.pass && contactUpdateType !== undefined) {
        contactShadows.pass.updateBeforeType = contactUpdateType;
      }
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
    }

    // A covered warmup render is not a presented frame; seed rather than
    // accumulate on the first live one.
    invalidateHistory("warmup");

    // compileAsync/render() can resolve after command submission while the GPU
    // still has seconds of warmup work queued. Keep the loading cover's promise
    // pending until that work is genuinely complete; otherwise the first live
    // toggle inherits the tail of the warmup queue and looks falsely slow.
    await (renderer as QueueBackedRenderer).backend.device?.queue.onSubmittedWorkDone();
    markStage("gpu-drain");
    if (profileWarmup) {
      console.info(
        `[warmup] run ${run} ${scope}: ${stages.join(" · ")} = ${Math.round(performance.now() - startedAt)}ms`
      );
    }
  };
  const warmup = (scope: WarmupScope = "full", pace?: () => Promise<void>) => {
    if (warmupInFlight !== null) return warmupInFlight;
    warmupInFlight = warmupOnce(scope, pace).finally(() => {
      warmupInFlight = null;
    });
    return warmupInFlight;
  };

  const applyPostFx = () => {
    postChain.applyParams();
  };
  applyPostFx();

  /**
   * The structural lane: reallocate targets and rebuild any baked graph, then
   * re-warm the chain's quads.
   *
   * `PostStage.applyStructure()` returns void, so a stage that rebuilt its
   * fragment graph has no way to tell the chain that two of its warmup quads now
   * carry WGSL nothing has compiled — `post.ssr.blurQuality` and
   * `post.ssr.binaryRefine` are the two that genuinely do this. Left alone, the
   * first frame after an Apply pays a synchronous shader build mid-frame, which
   * is the exact hitch `recompileKeys` exists to schedule away. Routing the
   * re-warm through `compileFullscreenQuads` puts it inside an exclusive compile
   * window, so the frame is HELD (render() early-returns) rather than corrupted.
   *
   * Deliberately async and deliberately NOT called from applyPostFx: a live
   * slider must never reach this.
   */
  const applyPostStructure = async () => {
    postChain.applyStructure();
    // Same adapter as the boot warm, and for the same reason — but note the
    // extra beat here: applyStructure() REALLOCATES targets, so the groups have
    // to be re-read after it rather than cached. `warmChainQuads` calls
    // `chain.warmupGroups()` itself, which is what makes that automatic.
    await warmChainQuads(renderer, postChain, compileGate.compileFullscreenQuads);
    // Reallocated targets hold garbage and a rebuilt resolve has no history.
    invalidateHistory("post-structure");
  };

  return {
    render,
    /** Late-bind app-level arrival/reveal admission after the phase machine is
     * constructed. Boot compilation remains unblocked before this binding. */
    setCompileBlocker(blocker: () => boolean) {
      compileGate.setBlocker(blocker);
    },
    prepareSceneOwner: (owner: THREE.Object3D) => compileGate.prepareSceneOwner(owner),
    /** Destination-exhibit compile lane: same exclusive-window serialization,
     * but the request jumps queued scenery owners, bypasses the arrival/reveal
     * compile blocker, and near-skips the stillness wait. Reserve it for the
     * content the player is actively traveling to. */
    compileAsyncPrioritized: compileGate.compileAsyncPrioritized,
    /** Wait for GPU owner compilation that was already admitted before a
     * covered world relocation. Does not start or force any new work. */
    waitForCompileIdle: () => compileGate.waitForCompileIdle(),
    /** M10: true while an exclusive compile window is holding presented
     * frames. Streaming attach paths poll this so scene mutations that dirty
     * render bundles don't pile up unseen behind a long window and then all
     * record (with their first-draw pipeline creations) in one giant frame. */
    get compileHeld() {
      return compileGate.held;
    },
    /** Probe/debug visibility into serialized owner preparation backlog. */
    get compileQueueDepth() {
      return compileGate.queueDepth;
    },
    /** The single persistent fullscreen pipeline. There is exactly one now — no
     * style masks, no bloom families, no FXAA detour — so this getter returns a
     * stable object identity that a toggle can never invalidate. */
    get pipeline() {
      return postChain.displayPipeline;
    },
    /** The post chain, for the debug panel and probes. */
    postChain,
    /** Push every stage's sliders into live uniforms. Never a recompile. */
    applyPostFx,
    /** Slider-RELEASE / Apply-button lane: reallocate, rebuild, re-warm. May
     *  hold frames while it compiles. Never call this from a live slider. */
    applyPostStructure,
    /** Force every temporal stage to seed on the next frame. Teleports, look
     * changes, resizes and reel resets all have to call this. */
    invalidateHistory,
    /** Dev-capture only, and a logged no-op since the beauty depth attachment
     * grew consumers. Kept so debugExposure/frameBody/inGameScreenshot and
     * tools/sutro-look-shot.mjs keep working. */
    setCinematicMultisampling,
    /** Read-only diagnostics for probes; play is permanently single-sampled. */
    get sceneSampleCount() {
      return 1;
    },
    /** Enter/leave the only area allowed to allocate and render god rays. */
    setPianoGodRaysArea: (active: boolean, center?: THREE.Vector3) =>
      godRays.setArea(active, center),
    /** Push piano god-ray controls without touching the rest of the chain. */
    applyPianoGodRaysFx: () => godRays.applyFx(),
    /** Probe-facing state; read-only and allocation-free until requested. */
    get pianoGodRaysState() {
      return godRays.state();
    },
    /** Probe-facing raw GPU texture retirement state. */
    get textureDisposalState() {
      return deferredTextureDisposalState(renderer);
    },
    /** Swap the scene pass to/from the retained wireframe override + camera.
     *  Wireframe also bypasses the post chain (see post/chain.ts); leaving it
     *  seeds temporal history so the first live resolve does not smear. */
    setWireframe: (on: boolean) => {
      const was = wireframe.active;
      wireframe.setWireframe(on);
      if (was !== on) invalidateHistory(on ? "wireframe-on" : "wireframe-off");
    },
    /** Blend the wireframe override from neutral grey to its logarithmic LOD ramp. */
    setWireframeLodGradient: (on: boolean) => wireframe.setLodGradient(on),
    /** Browser-native review capture reads the final post-FX texture here. */
    queueFastFrame: () => capture.queueFastFrame(),
    drainFastFrame: () => capture.drainFastFrame(),
    /** One-shot GPU readback of the post-FX frame for in-game stills (H key). */
    captureStillRgba: () => capture.captureStillRgba(),
    fastCaptureSize: capture.fastCaptureSize,
    /** Precompile scene + chain; safe to repeat after new loads. */
    warmup,
    /** Stable half-resolution close-contact complement and live controls. */
    contactShadows,
    /**
     * The display transform (render/grade.ts). Selecting a look swaps the LUT's
     * contents, so — unlike every other look-affecting control on this object —
     * it needs no pipeline reselection and no recompile. That is why it is
     * handed out directly rather than fronted by an applyX() call.
     */
    grade: postChain.grade,
    /**
     * Scene for in-world UI that bypasses the post chain (aim cursor, readable
     * signs). Add meshes here — never to the beauty scene — then bind beauty
     * depth on the material for occlusion (`WorldCursor` / `WorldSign`).
     */
    worldUiScene,
    /** Beauty-pass depth attachment for world-UI occlusion tests. */
    get beautyDepthTexture() {
      return scenePass.renderTarget.depthTexture;
    }
  };
}
