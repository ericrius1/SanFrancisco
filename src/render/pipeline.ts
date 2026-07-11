import * as THREE from "three/webgpu";
import {
  NodeUpdateType,
  pass,
  mrt,
  normalViewGeometry,
  packNormalToRGB
} from "three/tsl";
import {
  createPostFx,
  applyPostFxParams,
  getPostFxVariantMask,
  POSTFX_TUNING,
  POSTFX_VARIANT_MASKS
} from "./postfx";
import { INK_EXCLUDED_LAYER } from "./transparency";

type SceneSamples = 0 | 4;
/** "boot": compile only the active sample mode + active post-FX variant (fast,
 * covered). "full": every sample mode and all eight variants (revisit for
 * deferred-module materials). */
type WarmupScope = "boot" | "full";
type RuntimePassOptions = { options: { samples?: number } };
type WarmableRenderPipeline = THREE.RenderPipeline & {
  _update: () => void;
  _quadMesh: THREE.QuadMesh;
};
type QueueBackedRenderer = THREE.WebGPURenderer & {
  backend: { device?: { queue: { onSubmittedWorkDone(): Promise<unknown> } } };
};

const OUTLINE_PREPASS_SCALE = 0.5;
const INK_VARIANT_MASK = 1;

/** WebGPU supports one effective sample or 4x MSAA; all other values are 1x. */
const effectiveSceneSamples = (value: unknown): SceneSamples => Number(value) >= 4 ? 4 : 0;

/**
 * WebGPU render graph: a scene pass owns color/MSAA, and a lightweight
 * normal+depth prepass is referenced only by ink-outline variants. Each of the
 * eight post-FX combinations owns a persistent RenderPipeline/material while
 * sharing these two pass targets, so toggles select an already-built graph
 * without discarding the previous fullscreen GPU pipeline.
 */
export function createRenderPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera
) {
  // Beauty sees the ordinary world plus ephemeral hashed markers. The ink
  // prepass below deliberately stays on layer 0 so alpha-hash grain cannot
  // become a noisy normal/depth outline.
  camera.layers.enable(INK_EXCLUDED_LAYER);

  // cheap outline prepass: view-space normals (packed to 8-bit) + depth, opaque only.
  // Geometry normals, not material normals: normalView pulls in each material's
  // normalNode chain (the facade's brick-bump fractal noise), re-running it over
  // the frame just to feed edge detection that does not need material-scale
  // bumps. The vertex normal is free and visually identical here.
  // samples: 0 — multisampling this half-resolution lookup is pure bandwidth.
  const prePass = pass(scene, camera, { samples: 0 });
  prePass.transparent = false;
  const inkLayers = new THREE.Layers();
  inkLayers.set(0);
  prePass.setLayers(inkLayers);
  prePass.setResolutionScale(OUTLINE_PREPASS_SCALE);
  prePass.setMRT(mrt({ output: packNormalToRGB(normalViewGeometry) }));
  prePass.getTexture("output").type = THREE.UnsignedByteType;

  const prePassDepth = prePass.getTextureNode("depth");

  let activeSceneSamples = effectiveSceneSamples(POSTFX_TUNING.values.sceneSamples);
  // Normalize a stale persisted 1/2/3 before Tweakpane binds to this object.
  POSTFX_TUNING.values.sceneSamples = activeSceneSamples;

  // Lit scene pass. This is where geometry AA happens; the canvas stays 1x.
  const scenePass = pass(scene, camera, { samples: activeSceneSamples });
  const sceneColor = scenePass.getTextureNode();
  const runtimeScenePass = scenePass as typeof scenePass & RuntimePassOptions;
  const setScenePassSamples = (samples: SceneSamples) => {
    runtimeScenePass.options.samples = samples;
    scenePass.renderTarget.samples = samples;
  };

  // Stylized effects apply renderOutput inside their custom shaders. The zero
  // mask uses RenderPipeline's automatic output transform instead.
  const postfx = createPostFx({
    sceneTex: sceneColor,
    normalTex: prePass.getTextureNode(),
    depthTex: prePassDepth,
    camera
  });

  const variants = new Map<number, THREE.RenderPipeline>();
  const getVariantPipeline = (requestedMask: number) => {
    const mask = requestedMask & 7;
    let variant = variants.get(mask);
    if (variant !== undefined) return variant;

    variant = new THREE.RenderPipeline(renderer);
    if (mask === 0) {
      variant.outputColorTransform = true;
      variant.outputNode = sceneColor;
    } else {
      variant.outputColorTransform = false;
      variant.outputNode = postfx.get(mask);
    }
    variants.set(mask, variant);
    return variant;
  };

  let activeVariantMask = getPostFxVariantMask();
  let activePipeline = getVariantPipeline(activeVariantMask);

  const applyPostQuality = () => {
    const samples = effectiveSceneSamples(POSTFX_TUNING.values.sceneSamples);
    POSTFX_TUNING.values.sceneSamples = samples;
    if (samples === activeSceneSamples) return;

    activeSceneSamples = samples;
    setScenePassSamples(samples);
    // The scene target/pipelines necessarily change sample count. The separate
    // fullscreen output material does not, so none of the variants is dirtied.
  };

  const applyPostFx = () => {
    applyPostFxParams();
    applyPostQuality();
    const mask = getPostFxVariantMask();
    if (mask === activeVariantMask) return;

    activeVariantMask = mask;
    activePipeline = getVariantPipeline(mask);
  };

  /**
   * PassNode.compileAsync does not restore its render state if compilation
   * rejects, so put a defensive boundary around the Three r185 API.
   */
  const compilePass = async (node: typeof scenePass) => {
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();
    const renderOpaque = renderer.opaque;
    const renderTransparent = renderer.transparent;
    try {
      renderer.opaque = node.opaque;
      renderer.transparent = node.transparent;
      await node.compileAsync(renderer);
    } finally {
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
      renderer.opaque = renderOpaque;
      renderer.transparent = renderTransparent;
    }
  };

  /**
   * Compile all persistent fullscreen materials in one traversal. RenderPipeline
   * has no public compile method in r185, so this narrowly adapts its quad after
   * asking the pipeline to configure it. Keeping this adapter here makes the
   * returned warmup API independent of Three's private shape.
   */
  const compilePostFxVariants = async (masks: readonly number[] = POSTFX_VARIANT_MASKS) => {
    const quads = masks.map((mask) => {
      const internal = getVariantPipeline(mask) as WarmableRenderPipeline;
      internal._update();
      return internal._quadMesh;
    });
    const group = new THREE.Group();
    group.add(...quads);

    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();
    const toneMapping = renderer.toneMapping;
    const outputColorSpace = renderer.outputColorSpace;
    const xrEnabled = renderer.xr.enabled;

    try {
      // Match RenderPipeline.render() so the compiled target/cache key is the
      // one used by live fullscreen draws, not the renderer's output-conversion
      // framebuffer.
      renderer.toneMapping = THREE.NoToneMapping;
      renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
      renderer.xr.enabled = false;
      await renderer.compileAsync(group, quads[0].camera);
    } finally {
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
      renderer.toneMapping = toneMapping;
      renderer.outputColorSpace = outputColorSpace;
      renderer.xr.enabled = xrEnabled;
      group.remove(...quads);
    }
  };

  /**
   * Precompile both effective scene sample modes and all post-FX variants.
   * This intentionally renders covered warmup frames so BundleGroups are also
   * recorded for 1x, 4x, and the ink MRT context. It mutates one shared scene
   * target sequentially and restores the selected mode last, so it does not
   * retain duplicate full-resolution MSAA targets.
   *
   * Calls are coalesced only while running; invoking warmup again revisits the
   * scene so materials added by deferred world modules are compiled too. Call
   * it while the loading cover is visible and no animation render is running.
   */
  let warmupInFlight: Promise<void> | null = null;
  const warmupOnce = async (scope: WarmupScope) => {
    const sceneUpdateType = scenePass.updateBeforeType;
    const prePassUpdateType = prePass.updateBeforeType;
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();

    // Several warmup renders may happen before the animation loop advances its
    // frame token. Render-scoped updates guarantee that each requested sample
    // mode actually executes its pass and records its own BundleGroups.
    scenePass.updateBeforeType = NodeUpdateType.RENDER;
    prePass.updateBeforeType = NodeUpdateType.RENDER;
    try {
      await compilePass(prePass);

      // "boot": compile only the mode the canvas is about to show. The other
      // MSAA mode and the seven inactive post-FX variants are debug-panel toggles
      // — they compile lazily on first use (a single one-off hitch nobody but a
      // tinkerer ever triggers), keeping the covered boot warmup minimal.
      const sampleOrder: SceneSamples[] =
        scope === "boot" ? [activeSceneSamples] : activeSceneSamples === 0 ? [4, 0] : [0, 4];
      for (const samples of sampleOrder) {
        setScenePassSamples(samples);
        await compilePass(scenePass);
        // compileAsync does not record BundleGroups. A covered render does so
        // without retaining a second target when the next mode replaces it.
        activePipeline.render();
      }

      await compilePostFxVariants(scope === "boot" ? [activeVariantMask & 7] : POSTFX_VARIANT_MASKS);

      // Explicitly visit an ink pipeline: deferred BundleGroup contents need
      // recording in the normal/depth MRT even after the quad's GPU program was
      // already warm. In "boot" scope only bother when ink IS the active look
      // (its prepass BundleGroups otherwise record on first toggle). Finish with
      // the selected look on the canvas.
      if (scope === "full" || activeVariantMask & INK_VARIANT_MASK) {
        setScenePassSamples(activeSceneSamples);
        const inkPipeline = getVariantPipeline(INK_VARIANT_MASK);
        inkPipeline.render();
        if (inkPipeline !== activePipeline) activePipeline.render();
      }
    } finally {
      setScenePassSamples(activeSceneSamples);
      scenePass.updateBeforeType = sceneUpdateType;
      prePass.updateBeforeType = prePassUpdateType;
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
    }

    // compileAsync/render() can resolve after command submission while the GPU
    // still has seconds of warmup work queued. Keep the loading cover's promise
    // pending until that work is genuinely complete; otherwise the first live
    // toggle inherits the tail of the warmup queue and looks falsely slow.
    await (renderer as QueueBackedRenderer).backend.device?.queue.onSubmittedWorkDone();
  };
  const warmup = (scope: WarmupScope = "full") => {
    if (warmupInFlight !== null) return warmupInFlight;
    warmupInFlight = warmupOnce(scope).finally(() => {
      warmupInFlight = null;
    });
    return warmupInFlight;
  };

  applyPostFx();

  return {
    render: () => activePipeline.render(),
    /** The currently selected persistent fullscreen pipeline. */
    get pipeline() {
      return activePipeline;
    },
    /** Apply live scene AA changes without rebuilding the output material. */
    applyPostQuality,
    /** Select the cached post-FX graph after a toggle change. */
    applyPostFx,
    /** Precompile scene/sample/effect variants; safe to repeat after new loads. */
    warmup
  };
}
