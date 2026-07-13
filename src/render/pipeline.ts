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
  getRadialLightParams,
  POSTFX_TUNING,
  POSTFX_VARIANT_MASKS
} from "./postfx";
import { createContactShadowComplement } from "./contactShadows";
import { SHADOW_TUNING } from "../world/shadows/tuning";
import type { RadialLightParams, RadialLightSource } from "./radialLightTypes";

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
type RadialLightRuntime = {
  compose(key: number, baseNode: any): any;
  configure(params: RadialLightParams): void;
  update(): void;
  dispose(): void;
};

const OUTLINE_PREPASS_SCALE = 0.5;
const INK_VARIANT_MASK = 1;
const BEAUTY_ONLY_LAYER = 31;
// WebGPU enum values are stable; TypeScript's DOM lib still omits their names.
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_MAP_MODE_READ = 0x0001;

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
  camera: THREE.Camera,
  directionalLight: THREE.DirectionalLight | null = null
) {
  // Beauty sees the ordinary world plus ephemeral hashed markers. The ink
  // prepass below deliberately stays on layer 0 so alpha-hash grain cannot
  // become a noisy normal/depth outline.
  camera.layers.enable(BEAUTY_ONLY_LAYER);

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
  const sceneDepth = scenePass.getTextureNode("depth");
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
  const runtimeScenePass = scenePass as typeof scenePass & RuntimePassOptions;
  const setScenePassSamples = (samples: SceneSamples) => {
    runtimeScenePass.options.samples = samples;
    scenePass.renderTarget.samples = samples;
  };

  // Wireframe debug: PassNode.overrideMaterial + a retained camera clone.
  // BundleGroups (tiles, citygen, traffic lights) key their WebGPU command
  // caches by camera identity. Mutating scene.overrideMaterial on the live
  // camera re-records those bundles as line lists and leaves them stuck after
  // the toggle clears. A separate camera keeps normal and wireframe caches
  // side by side so off restores solid materials instantly.
  const wireframeMaterial = new THREE.MeshBasicNodeMaterial();
  wireframeMaterial.name = "debug-wireframe-override";
  wireframeMaterial.color.set(0xcccccc);
  wireframeMaterial.wireframe = true;
  wireframeMaterial.toneMapped = false;
  const wireframeCamera = camera.clone();
  const syncWireframeCamera = () => wireframeCamera.copy(camera, false);
  let wireframeActive = false;
  const applyWireframeOverride = (on: boolean) => {
    scenePass.overrideMaterial = on ? wireframeMaterial : null;
    scenePass.camera = on ? wireframeCamera : camera;
  };
  const setWireframe = (on: boolean) => {
    if (wireframeActive === on) return;
    wireframeActive = on;
    if (on) syncWireframeCamera();
    applyWireframeOverride(on);
  };

  // Stylized effects apply renderOutput inside their custom shaders. The zero
  // mask uses RenderPipeline's automatic output transform instead.
  const postfx = createPostFx({
    sceneTex: sceneColor,
    normalTex: prePass.getTextureNode(),
    depthTex: prePassDepth,
    camera,
    contactFactorAt: contactShadows.available
      ? (sampleUv) => contactShadows.sample(sampleUv)
      : undefined
  });

  const variants = new Map<number, THREE.RenderPipeline>();
  const getVariantPipeline = (requestedMask: number) => {
    const mask = requestedMask & 7;
    let variant = variants.get(mask);
    if (variant !== undefined) return variant;

    variant = new THREE.RenderPipeline(renderer);
    // The zero-style graph still owns the runtime surf-flow lens. It resolves
    // to the original scene sample while inactive, and avoids a shader compile
    // hitch on the first flow-state activation.
    variant.outputColorTransform = false;
    variant.outputNode = postfx.get(mask);
    variants.set(mask, variant);
    return variant;
  };

  let activeVariantMask = getPostFxVariantMask();
  let activePipeline = getVariantPipeline(activeVariantMask);

  // The expensive radial helper and its stained-glass-only passes are a nested lazy
  // feature. Nothing below imports/builds them until a source crosses an
  // interior gate; outside, activePipeline is always one of the base variants.
  let radialSource: RadialLightSource | null = null;
  let radialRuntime: RadialLightRuntime | null = null;
  let radialRuntimeSource: RadialLightSource | null = null;
  let radialModulePromise: Promise<typeof import("./radialLightShafts")> | null = null;
  let radialBuildPending: { source: RadialLightSource; epoch: number } | null = null;
  let radialEpoch = 0;
  let radialActive = false;
  let radialRenderedFrames = 0;
  const radialVariants = new Map<number, THREE.RenderPipeline>();

  const radialEnabled = () => Boolean(POSTFX_TUNING.values.museumRays);

  const getRadialVariantPipeline = (requestedMask: number) => {
    if (!radialRuntime) return null;
    const mask = requestedMask & 7;
    let variant = radialVariants.get(mask);
    if (variant !== undefined) return variant;
    variant = new THREE.RenderPipeline(renderer);
    variant.outputColorTransform = false;
    variant.outputNode = radialRuntime.compose(mask, postfx.get(mask));
    radialVariants.set(mask, variant);
    return variant;
  };

  const selectActivePipeline = () => {
    if (
      radialEnabled() &&
      radialSource !== null &&
      radialRuntime !== null &&
      radialRuntimeSource === radialSource
    ) {
      const variant = getRadialVariantPipeline(activeVariantMask);
      if (variant) {
        activePipeline = variant;
        radialActive = true;
        return;
      }
    }
    activePipeline = getVariantPipeline(activeVariantMask);
    radialActive = false;
  };

  const disposeRadialRuntime = () => {
    activePipeline = getVariantPipeline(activeVariantMask);
    radialActive = false;
    for (const variant of radialVariants.values()) variant.dispose();
    radialVariants.clear();
    radialRuntime?.dispose();
    radialRuntime = null;
    radialRuntimeSource = null;
  };

  const loadRadialModule = () => {
    if (!radialModulePromise) {
      radialModulePromise = import("./radialLightShafts").catch((err) => {
        radialModulePromise = null;
        throw err;
      });
    }
    return radialModulePromise;
  };

  const ensureRadialRuntime = () => {
    const requestedSource = radialSource;
    if (!requestedSource || !radialEnabled()) {
      selectActivePipeline();
      return;
    }
    if (radialRuntime && radialRuntimeSource === requestedSource) {
      radialRuntime.configure(getRadialLightParams());
      selectActivePipeline();
      return;
    }

    const epoch = radialEpoch;
    if (radialBuildPending?.source === requestedSource && radialBuildPending.epoch === epoch) return;
    radialBuildPending = { source: requestedSource, epoch };
    void loadRadialModule()
      .then(({ createRadialLightShafts }) => {
        if (radialEpoch !== epoch || radialSource !== requestedSource || !radialEnabled()) return;
        disposeRadialRuntime();
        radialRuntime = createRadialLightShafts({
          camera,
          sceneDepth,
          source: requestedSource,
          params: getRadialLightParams()
        });
        radialRuntimeSource = requestedSource;
        selectActivePipeline();
      })
      .catch((err) => console.warn("[render] radial stained-glass light unavailable:", err))
      .finally(() => {
        if (radialBuildPending?.source === requestedSource && radialBuildPending.epoch === epoch) {
          radialBuildPending = null;
        }
      });
  };

  const setRadialLightSource = (source: RadialLightSource | null) => {
    if (source === radialSource) return;
    radialEpoch += 1;
    radialBuildPending = null;
    radialSource = source;
    if (radialRuntimeSource !== source) disposeRadialRuntime();
    if (source) ensureRadialRuntime();
    else selectActivePipeline();
  };

  const applyRadialLightFx = () => {
    radialEpoch += 1; // invalidates an in-flight activation after a toggle-off
    radialBuildPending = null;
    radialRuntime?.configure(getRadialLightParams());
    selectActivePipeline();
    if (radialEnabled() && radialSource) ensureRadialRuntime();
  };

  const fastCaptureEnabled = new URLSearchParams(location.search).has("fastcapture");
  const fastCaptureSize = new THREE.Vector2();
  let fastCaptureTarget: THREE.RenderTarget | null = null;
  let fastReadback:
    | {
        buffers: any[];
        bytesPerRow: number;
        nextSlot: number;
        pending: { slot: number; mapped: Promise<unknown> } | null;
      }
    | null = null;
  if (fastCaptureEnabled) {
    renderer.getDrawingBufferSize(fastCaptureSize);
    fastCaptureTarget = new THREE.RenderTarget(fastCaptureSize.x, fastCaptureSize.y, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false
    });
    fastCaptureTarget.texture.name = "cinematic-fast-final-color";
    const backend = renderer.backend as any;
    const bytesPerRow = Math.ceil((fastCaptureSize.x * 4) / 256) * 256;
    fastReadback = {
      buffers: [0, 1].map(() => backend.device.createBuffer({
        size: bytesPerRow * fastCaptureSize.y,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ
      })),
      bytesPerRow,
      nextSlot: 0,
      pending: null
    };
  }

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
    if (mask !== activeVariantMask) activeVariantMask = mask;
    applyRadialLightFx();
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
  let warmupRun = 0;
  const warmupOnce = async (scope: WarmupScope) => {
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
    const sceneUpdateType = scenePass.updateBeforeType;
    const prePassUpdateType = prePass.updateBeforeType;
    const contactUpdateType = contactShadows.pass?.updateBeforeType;
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();

    // Several warmup renders may happen before the animation loop advances its
    // frame token. Render-scoped updates guarantee that each requested sample
    // mode actually executes its pass and records its own BundleGroups.
    scenePass.updateBeforeType = NodeUpdateType.RENDER;
    prePass.updateBeforeType = NodeUpdateType.RENDER;
    // Contact samples scenePass depth from a nested QuadMesh render. Leaving it
    // render-scoped here would retrigger the entire scene under a second render
    // context and record duplicate BundleGroups. Its target was initialized by
    // the covered pre-warm render (and by live frames before a late warmup), so
    // frozen contact pixels are sufficient while the loading cover is opaque.
    if (contactShadows.pass) contactShadows.pass.updateBeforeType = NodeUpdateType.NONE;
    try {
      const needsInkWarmup = scope === "full" || (activeVariantMask & INK_VARIANT_MASK) !== 0;
      if (needsInkWarmup) {
        await compilePass(prePass);
        markStage("outline-compile");
      }

      // "boot": compile only the mode the canvas is about to show. The other
      // MSAA mode and the seven inactive post-FX variants are debug-panel toggles
      // — they compile lazily on first use (a single one-off hitch nobody but a
      // tinkerer ever triggers), keeping the covered boot warmup minimal.
      const sampleOrder: SceneSamples[] =
        scope === "boot" ? [activeSceneSamples] : activeSceneSamples === 0 ? [4, 0] : [0, 4];
      // Visit both retained camera identities so normal and wireframe command
      // bundles coexist; finish on the live mode.
      const selectedWireframeAtStart = wireframeActive;
      const wireframeModes =
        scope === "full" ? [!selectedWireframeAtStart, selectedWireframeAtStart] : [selectedWireframeAtStart];
      for (const wireframe of wireframeModes) {
        if (wireframe) syncWireframeCamera();
        applyWireframeOverride(wireframe);
        for (const samples of sampleOrder) {
          setScenePassSamples(samples);
          await compilePass(scenePass);
          markStage(`scene-${samples || 1}x-wf${wireframe ? 1 : 0}-compile`);
          // compileAsync does not record BundleGroups. A covered render does so
          // without retaining a second target when the next mode replaces it.
          activePipeline.render();
          markStage(`scene-${samples || 1}x-wf${wireframe ? 1 : 0}-record`);
        }
      }
      if (wireframeActive) syncWireframeCamera();
      applyWireframeOverride(wireframeActive);

      await compilePostFxVariants(scope === "boot" ? [activeVariantMask & 7] : POSTFX_VARIANT_MASKS);
      markStage("output-compile");

      // Explicitly visit an ink pipeline: deferred BundleGroup contents need
      // recording in the normal/depth MRT even after the quad's GPU program was
      // already warm. In "boot" scope only bother when ink IS the active look
      // (its prepass BundleGroups otherwise record on first toggle). Finish with
      // the selected look on the canvas.
      if (needsInkWarmup) {
        setScenePassSamples(activeSceneSamples);
        const inkPipeline = getVariantPipeline(INK_VARIANT_MASK);
        inkPipeline.render();
        if (inkPipeline !== activePipeline) activePipeline.render();
        markStage("ink-record");
      }
    } finally {
      setScenePassSamples(activeSceneSamples);
      if (wireframeActive) syncWireframeCamera();
      applyWireframeOverride(wireframeActive);
      scenePass.updateBeforeType = sceneUpdateType;
      prePass.updateBeforeType = prePassUpdateType;
      if (contactShadows.pass && contactUpdateType !== undefined) {
        contactShadows.pass.updateBeforeType = contactUpdateType;
      }
      renderer.setRenderTarget(renderTarget, activeCubeFace, activeMipmapLevel);
      renderer.setMRT(renderMRT);
    }

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
  const warmup = (scope: WarmupScope = "full") => {
    if (warmupInFlight !== null) return warmupInFlight;
    warmupInFlight = warmupOnce(scope).finally(() => {
      warmupInFlight = null;
    });
    return warmupInFlight;
  };

  applyPostFx();

  const render = () => {
    if (wireframeActive) syncWireframeCamera();
    if (radialActive) {
      radialRuntime?.update();
      radialRenderedFrames += 1;
    }
    if (!fastCaptureTarget) {
      activePipeline.render();
      return;
    }
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(fastCaptureTarget);
    activePipeline.render();
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
  };

  const drainFastSlot = (slot: number) => {
    if (!fastCaptureTarget || !fastReadback) throw new Error("fast cinematic readback is not enabled");
    const width = fastCaptureTarget.width;
    const height = fastCaptureTarget.height;
    const tightStride = width * 4;
    const padded = new Uint8Array(fastReadback.buffers[slot].getMappedRange());
    const tight = new Uint8ClampedArray(tightStride * height);
    if (fastReadback.bytesPerRow === tightStride) tight.set(padded.subarray(0, tight.length));
    else {
      for (let y = 0; y < height; y++) {
        tight.set(
          padded.subarray(y * fastReadback.bytesPerRow, y * fastReadback.bytesPerRow + tightStride),
          y * tightStride
        );
      }
    }
    fastReadback.buffers[slot].unmap();
    return tight;
  };

  const queueFastFrame = async () => {
    if (!fastCaptureTarget || !fastReadback) throw new Error("fast cinematic render target is not enabled");
    const backend = renderer.backend as any;
    const texture = backend.get(fastCaptureTarget.texture).texture;
    if (!texture) throw new Error("fast cinematic GPU texture is not initialized");
    const slot = fastReadback.nextSlot;
    const encoder = backend.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      {
        buffer: fastReadback.buffers[slot],
        bytesPerRow: fastReadback.bytesPerRow,
        rowsPerImage: fastCaptureTarget.height
      },
      [fastCaptureTarget.width, fastCaptureTarget.height, 1]
    );
    backend.device.queue.submit([encoder.finish()]);
    const mapped = fastReadback.buffers[slot].mapAsync(GPU_MAP_MODE_READ);
    const previous = fastReadback.pending;
    fastReadback.pending = { slot, mapped };
    fastReadback.nextSlot = 1 - slot;
    if (!previous) return null;
    await previous.mapped;
    return drainFastSlot(previous.slot);
  };

  const drainFastFrame = async () => {
    if (!fastReadback?.pending) return null;
    const pending = fastReadback.pending;
    fastReadback.pending = null;
    await pending.mapped;
    return drainFastSlot(pending.slot);
  };

  return {
    render,
    /** The currently selected persistent fullscreen pipeline. */
    get pipeline() {
      return activePipeline;
    },
    /** Apply live scene AA changes without rebuilding the output material. */
    applyPostQuality,
    /** Select the cached post-FX graph after a toggle change. */
    applyPostFx,
    /** Attach/detach an optional interior-only radial-light source. */
    setRadialLightSource,
    /** Push radial-light controls without adding them to the global style mask. */
    applyRadialLightFx,
    /** Probe-facing state; read-only and allocation-free until requested. */
    get radialLightState() {
      return {
        active: radialActive,
        loaded: radialRuntime !== null,
        renderedFrames: radialRenderedFrames
      };
    },
    /** Swap the scene pass to/from the retained wireframe override + camera. */
    setWireframe,
    /** Browser-native review capture reads the final post-FX texture here. */
    queueFastFrame,
    drainFastFrame,
    fastCaptureSize: fastCaptureTarget ? [fastCaptureTarget.width, fastCaptureTarget.height] as const : null,
    /** Precompile scene/sample/effect variants; safe to repeat after new loads. */
    warmup,
    /** Stable half-resolution close-contact complement and live controls. */
    contactShadows
  };
}
