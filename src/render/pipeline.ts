import * as THREE from "three/webgpu";
import {
  cameraPosition,
  clamp,
  color,
  log2,
  mix,
  NodeUpdateType,
  pass,
  mrt,
  normalViewGeometry,
  packNormalToRGB,
  positionWorld,
  smoothstep,
  uniform,
  texture
} from "three/tsl";
import {
  createPostFx,
  applyPostFxParams,
  getPostFxVariantMask,
  getPianoGodRaysParams,
  POSTFX_TUNING,
  POSTFX_VARIANT_MASKS
} from "./postfx";
import { createContactShadowComplement } from "./contactShadows";
import { SHADOW_TUNING } from "../world/shadows/tuning";
import { yieldToFrame } from "../core/cooperativeWork";
import { tracer } from "../core/hitchTracer";
import { motionGate } from "../core/motionGate";
import { warmScenePaced } from "./warmStaticRegion";
import type { PianoGodRaysParams } from "./pianoGodRaysTypes";
import {
  deferredTextureDisposalState,
  markTextureDisposalFrame
} from "./textureDisposePatch";

type SceneSamples = 0 | 4;
type RuntimePassOptions = { options: { samples?: number } };
/** "boot": compile only the active post-FX variant (fast, covered). "full":
 * compile all eight variants (revisit for deferred-module materials). */
type WarmupScope = "boot" | "full";
type WarmableRenderPipeline = THREE.RenderPipeline & {
  _update: () => void;
  _quadMesh: THREE.QuadMesh;
};
type QueueBackedRenderer = THREE.WebGPURenderer & {
  backend: { device?: { queue: { onSubmittedWorkDone(): Promise<unknown> } } };
};
type PianoGodRaysRuntime = {
  sceneTexture: any;
  configure(params: PianoGodRaysParams): void;
  update(center: THREE.Vector3): void;
  shadowMapReady(): boolean;
  dispose(): void;
};
type FxaaRuntime = {
  pipeline: THREE.RenderPipeline;
  sourceTarget: THREE.RenderTarget;
  size: THREE.Vector2;
};

const OUTLINE_PREPASS_SCALE = 0.5;
const INK_VARIANT_MASK = 1;
const BEAUTY_ONLY_LAYER = 31;
// WebGPU enum values are stable; TypeScript's DOM lib still omits their names.
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_MAP_MODE_READ = 0x0001;

// M11: an exclusive compile window HOLDS presented frames for its duration
// (C3), so a monster TSL codegen window (water sheets ~250 ms, facade family
// ~480 ms) is a visible freeze ONLY if the player was moving — while the view
// is still, the held frame shows an identical image and is imperceptible. Each
// serialized window therefore waits for visual stillness before starting, with
// a bounded per-window deadline (and the motionGate's global motion budget) so
// a player who never stops degrades to the ungated M10 behavior, never worse.
const COMPILE_STILL_DEADLINE_MS = 8000;
// Windows longer than a frame interval are what the stillness gate exists for;
// use the same threshold to classify hidden vs visible in the tracer.
const COMPILE_WINDOW_VISIBLE_MS = 33;

/**
 * WebGPU render graph: a scene pass owns color/depth, and a lightweight
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
  const prePass = pass(scene, camera);
  prePass.transparent = false;
  const inkLayers = new THREE.Layers();
  inkLayers.set(0);
  prePass.setLayers(inkLayers);
  prePass.setResolutionScale(OUTLINE_PREPASS_SCALE);
  prePass.setMRT(mrt({ output: packNormalToRGB(normalViewGeometry) }));
  prePass.getTexture("output").type = THREE.UnsignedByteType;

  const prePassDepth = prePass.getTextureNode("depth");

  // Live play is permanently single-sample. The dev-only cinematic entry point
  // may opt this beauty pass into 4x sampling before an offline capture; it is
  // intentionally not a persisted setting or debug-panel control.
  const scenePass = pass(scene, camera, { samples: 0 });
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
  let activeSceneSamples: SceneSamples = 0;
  const setCinematicMultisampling = (enabled: boolean) => {
    const samples: SceneSamples = enabled ? 4 : 0;
    if (samples === activeSceneSamples) return;
    activeSceneSamples = samples;
    runtimeScenePass.options.samples = samples;
    scenePass.renderTarget.samples = samples;
  };

  // Wireframe debug: PassNode.overrideMaterial + a retained camera clone.
  // BundleGroups (tiles, citygen, traffic lights) key their WebGPU command
  // caches by camera identity. Mutating scene.overrideMaterial on the live
  // camera re-records those bundles as line lists and leaves them stuck after
  // the toggle clears. A separate camera keeps normal and wireframe caches
  // side by side so off restores solid materials instantly.
  const wireframeLodGradient = uniform(1);
  const wireframeMaterial = new THREE.MeshBasicNodeMaterial();
  wireframeMaterial.name = "debug-wireframe-override";
  wireframeMaterial.color.set(0xcccccc);
  // Clipmap spacing doubles at roughly 64/128/256/512/1024/2048/4096 m.
  // Mapping log2(distance / 64) onto 0..1 therefore turns those geometric LOD
  // bands into an unbroken perceptual ramp. The override is scene-wide, so the
  // same resolution story remains visible across terrain and buildings.
  const wireframeDistance = positionWorld.distance(cameraPosition).max(64);
  const wireframeLod = clamp(log2(wireframeDistance.div(64)).div(6), 0, 1);
  const nearColor = color(0x69f5c6);
  const middleColor = color(0x59a7ff);
  const coarseColor = color(0x8c72e8);
  const farColor = color(0xff789e);
  const nearRamp = mix(nearColor, middleColor, smoothstep(0, 0.46, wireframeLod));
  const farRamp = mix(coarseColor, farColor, smoothstep(0.52, 1, wireframeLod));
  const resolutionRamp = mix(nearRamp, farRamp, smoothstep(0.34, 0.7, wireframeLod));
  wireframeMaterial.colorNode = mix(color(0xcccccc), resolutionRamp, wireframeLodGradient);
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
  const setWireframeLodGradient = (on: boolean) => {
    wireframeLodGradient.value = on ? 1 : 0;
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

  // The official raymarched GodraysNode stack is a piano-only nested lazy
  // feature. Its module, dedicated shadow light and render targets do not exist
  // until the player enters the grove gate; leaving disposes all GPU ownership.
  let pianoGodRaysRequested = false;
  const pianoGodRaysCenter = new THREE.Vector3();
  let pianoGodRaysRuntime: PianoGodRaysRuntime | null = null;
  let pianoGodRaysModulePromise: Promise<typeof import("./pianoGodRays")> | null = null;
  let pianoGodRaysBuildPending: { epoch: number } | null = null;
  let pianoGodRaysEpoch = 0;
  let pianoGodRaysActive = false;
  let pianoGodRaysRenderedFrames = 0;
  const pianoGodRaysVariants = new Map<number, THREE.RenderPipeline>();

  const pianoGodRaysEnabled = () => Boolean(
    pianoGodRaysRequested && POSTFX_TUNING.values.pianistRays && directionalLight
  );

  const getPianoGodRaysVariantPipeline = (requestedMask: number) => {
    if (!pianoGodRaysRuntime) return null;
    const mask = requestedMask & 7;
    let variant = pianoGodRaysVariants.get(mask);
    if (variant !== undefined) return variant;
    variant = new THREE.RenderPipeline(renderer);
    variant.outputColorTransform = false;
    variant.outputNode = postfx.getWithSceneTexture(
      mask,
      pianoGodRaysRuntime.sceneTexture
    );
    pianoGodRaysVariants.set(mask, variant);
    return variant;
  };

  const selectActivePipeline = () => {
    const basePipeline = getVariantPipeline(activeVariantMask);
    if (
      pianoGodRaysEnabled() &&
      pianoGodRaysRuntime !== null &&
      // The god-ray graph dereferences the dedicated light's shadow map at
      // setup; hold the base pipeline until the beauty pass has allocated it.
      pianoGodRaysRuntime.shadowMapReady()
    ) {
      const variant = getPianoGodRaysVariantPipeline(activeVariantMask);
      if (variant) {
        activePipeline = variant;
        pianoGodRaysActive = true;
        return;
      }
    }
    activePipeline = basePipeline;
    pianoGodRaysActive = false;
  };

  const disposePianoGodRaysRuntime = () => {
    pianoGodRaysActive = false;
    for (const variant of pianoGodRaysVariants.values()) variant.dispose();
    pianoGodRaysVariants.clear();
    pianoGodRaysRuntime?.dispose();
    pianoGodRaysRuntime = null;
    selectActivePipeline();
  };

  const loadPianoGodRaysModule = () => {
    if (!pianoGodRaysModulePromise) {
      pianoGodRaysModulePromise = import("./pianoGodRays").catch((err) => {
        pianoGodRaysModulePromise = null;
        throw err;
      });
    }
    return pianoGodRaysModulePromise;
  };

  const ensurePianoGodRaysRuntime = () => {
    if (!pianoGodRaysEnabled() || !directionalLight) {
      selectActivePipeline();
      return;
    }
    if (pianoGodRaysRuntime) {
      pianoGodRaysRuntime.configure(getPianoGodRaysParams());
      selectActivePipeline();
      return;
    }

    const epoch = pianoGodRaysEpoch;
    if (pianoGodRaysBuildPending?.epoch === epoch) return;
    pianoGodRaysBuildPending = { epoch };
    void loadPianoGodRaysModule()
      .then(({ createPianoGodRays }) => {
        if (pianoGodRaysEpoch !== epoch || !pianoGodRaysEnabled() || !directionalLight) return;
        disposePianoGodRaysRuntime();
        pianoGodRaysRuntime = createPianoGodRays({
          scene,
          camera,
          sceneColor,
          sceneDepth,
          sourceLight: directionalLight,
          center: pianoGodRaysCenter,
          params: getPianoGodRaysParams()
        });
        selectActivePipeline();
      })
      .catch((err) => console.warn("[render] piano god rays unavailable:", err))
      .finally(() => {
        if (pianoGodRaysBuildPending?.epoch === epoch) pianoGodRaysBuildPending = null;
      });
  };

  const setPianoGodRaysArea = (active: boolean, center?: THREE.Vector3) => {
    if (center) pianoGodRaysCenter.copy(center);
    if (active === pianoGodRaysRequested) return;
    pianoGodRaysRequested = active;
    pianoGodRaysEpoch += 1;
    pianoGodRaysBuildPending = null;
    if (active) ensurePianoGodRaysRuntime();
    else disposePianoGodRaysRuntime();
  };

  const applyPianoGodRaysFx = () => {
    if (!pianoGodRaysEnabled()) {
      pianoGodRaysEpoch += 1; // invalidate an in-flight activation after toggle-off
      pianoGodRaysBuildPending = null;
      disposePianoGodRaysRuntime();
      return;
    }
    pianoGodRaysRuntime?.configure(getPianoGodRaysParams());
    selectActivePipeline();
    if (!pianoGodRaysRuntime) ensurePianoGodRaysRuntime();
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

  // FXAA is a final display-space pass, after every optional light/style graph.
  // Its implementation and one shared RGBA8 source target are first-use gated:
  // clean boot fetches/allocates neither while the toggle remains off.
  let fxaaRequested = Boolean(POSTFX_TUNING.values.fxaa);
  let fxaaRuntime: FxaaRuntime | null = null;
  let fxaaModulePromise: Promise<typeof import("three/addons/tsl/display/FXAANode.js")> | null = null;
  const ensureFxaaRuntime = async () => {
    if (fxaaRuntime) return fxaaRuntime;
    if (!fxaaModulePromise) {
      fxaaModulePromise = import("three/addons/tsl/display/FXAANode.js").catch((err) => {
        fxaaModulePromise = null;
        throw err;
      });
    }
    const { fxaa } = await fxaaModulePromise;
    if (fxaaRuntime) return fxaaRuntime;

    const sourceTarget = new THREE.RenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      // The active graph has already produced display-referred sRGB. An sRGB
      // attachment preserves that value through WebGPU's write/sample roundtrip
      // so FXAA sees the expected luminance without shifting the final image.
      colorSpace: THREE.SRGBColorSpace,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false
    });
    sourceTarget.texture.name = "FXAA display source";
    const fxaaPipeline = new THREE.RenderPipeline(renderer);
    fxaaPipeline.outputColorTransform = false;
    fxaaPipeline.outputNode = fxaa(texture(sourceTarget.texture));
    fxaaRuntime = {
      pipeline: fxaaPipeline,
      sourceTarget,
      size: new THREE.Vector2()
    };
    return fxaaRuntime;
  };

  const applyPostFx = () => {
    applyPostFxParams();
    fxaaRequested = Boolean(POSTFX_TUNING.values.fxaa);
    if (fxaaRequested && !fxaaRuntime) {
      void ensureFxaaRuntime().catch((err) => console.warn("[render] FXAA unavailable:", err));
    }
    const mask = getPostFxVariantMask();
    if (mask !== activeVariantMask) activeVariantMask = mask;
    applyPianoGodRaysFx();
  };

  // compileAsync mutates shared renderer state (tone mapping, color space, …)
  // across an await. Live frames must not draw in that window or atmosphere/fog
  // briefly renders with the compile setup.
  let exclusiveCompileDepth = 0;

  // The same hazard applies to every SCENE warmup (warmHiddenRoot, tile/site/
  // vehicle prepares call renderer.compileAsync directly): r185's compileAsync
  // updates shared node/binding bookkeeping across its awaits, and a live frame
  // drawn inside that window renders with the compile's fog/tone state. The
  // visible symptom is distant fog-hidden geometry — bay sailboats, the
  // ghost-ship horizon proxy — flashing unfaded for a single frame ("flickering
  // objects in the sky"). Route the renderer's own compileAsync through the
  // exclusive gate so a compile in flight holds the previous frame instead of
  // drawing a corrupted one, and serialize compiles so windows never overlap.
  {
    const original = renderer.compileAsync.bind(renderer);
    let chain: Promise<unknown> = Promise.resolve();
    renderer.compileAsync = ((
      compileScene: THREE.Object3D,
      compileCamera: THREE.Camera,
      targetScene: THREE.Scene | null = null
    ) => {
      const run = async () => {
        // M11: start this window during stillness when possible (see
        // COMPILE_STILL_DEADLINE_MS). The wait happens BEFORE the exclusive
        // depth increments, so live frames keep presenting while we wait.
        // Nested calls (compileFullscreenQuads awaits the gated compileAsync
        // while already holding the exclusive depth) must NOT wait: frames are
        // already frozen, so waiting only lengthens the freeze.
        let stillAtStart = true;
        if (exclusiveCompileDepth === 0) {
          const gateWaitStartedAt = performance.now();
          stillAtStart = await motionGate.waitForStillness(
            COMPILE_STILL_DEADLINE_MS,
            // Frames became held by an outer window mid-wait: waiting can no
            // longer hide anything, it only lengthens the frozen image.
            () => exclusiveCompileDepth > 0
          );
          const gateWaitMs = Math.round(performance.now() - gateWaitStartedAt);
          if (gateWaitMs > 0) tracer.count("compileGateWaitMs", gateWaitMs);
          if (!stillAtStart && gateWaitMs > 50) tracer.count("compileGateForced");
        } else {
          stillAtStart = motionGate.isStill();
        }
        exclusiveCompileDepth++;
        const startedAt = performance.now();
        try {
          return await original(compileScene, compileCamera, targetScene);
        } finally {
          exclusiveCompileDepth--;
          // M6 attribution: bursty compiles are the prime hitch suspect. The
          // per-frame counts land on the spiking frame in tracer.spikes.
          tracer.count("gpuCompile");
          const windowMs = Math.round(performance.now() - startedAt);
          tracer.count("gpuCompileMs", windowMs);
          // M11 attribution: a long window is a perceived hitch only when the
          // view was moving at its start or moved during it.
          if (windowMs > COMPILE_WINDOW_VISIBLE_MS) {
            const movedDuring = motionGate.lastMovementAt() > startedAt;
            tracer.count(
              stillAtStart && !movedDuring
                ? "compileWindowStillHidden"
                : "compileWindowMotionVisible"
            );
          }
          // M10 attribution: name the owners of long exclusive windows.
          if (windowMs > 100) {
            const owner = compileScene as THREE.Object3D & { name?: string; type?: string };
            console.info(`[compile] ${owner.name || owner.type || "?"} window ${windowMs}ms`);
          }
        }
      };
      const gated = chain.then(run, run);
      chain = gated.catch(() => {});
      return gated;
    }) as typeof renderer.compileAsync;
  }

  /**
   * PassNode.compileAsync does not restore its render state if compilation
   * rejects, so put a defensive boundary around the Three r185 API.
   */
  const compilePass = async (node: typeof scenePass) => {
    exclusiveCompileDepth++;
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
      exclusiveCompileDepth--;
    }
  };

  /**
   * Compile all persistent fullscreen materials in one traversal. RenderPipeline
   * has no public compile method in r185, so this narrowly adapts its quad after
   * asking the pipeline to configure it. Keeping this adapter here makes the
   * returned warmup API independent of Three's private shape.
   */
  const compileFullscreenQuads = async (quads: THREE.QuadMesh[]) => {
    if (quads.length === 0) return;
    exclusiveCompileDepth++;
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
      exclusiveCompileDepth--;
    }
  };
  const compilePostFxVariants = async (masks: readonly number[] = POSTFX_VARIANT_MASKS) => {
    const quads = masks.map((mask) => {
      const internal = getVariantPipeline(mask) as WarmableRenderPipeline;
      internal._update();
      return internal._quadMesh;
    });
    await compileFullscreenQuads(quads);
  };
  const compileFxaaPipeline = async () => {
    const runtime = await ensureFxaaRuntime();
    const internal = runtime.pipeline as WarmableRenderPipeline;
    internal._update();
    await compileFullscreenQuads([internal._quadMesh]);
  };

  /**
   * Precompile the scene and post-FX variants. This intentionally renders
   * covered warmup frames so BundleGroups are also recorded for the beauty and
   * ink MRT contexts.
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
    // chunks BEFORE the render-scoped overrides below (live frames keep their
    // normal update types — contact shadows stay live between chunks), so the
    // compilePass sweeps find warm pipelines and finish in a few ms.
    if (pace) {
      const paced = await warmScenePaced(renderer, camera, scene, pace);
      markStage(`paced-prewarm ${paced.representatives}/${paced.meshes} in ${paced.chunks} chunks`);
    }
    const sceneUpdateType = scenePass.updateBeforeType;
    const prePassUpdateType = prePass.updateBeforeType;
    const contactUpdateType = contactShadows.pass?.updateBeforeType;
    const renderTarget = renderer.getRenderTarget();
    const activeCubeFace = renderer.getActiveCubeFace();
    const activeMipmapLevel = renderer.getActiveMipmapLevel();
    const renderMRT = renderer.getMRT();

    // Several warmup renders may happen before the animation loop advances its
    // frame token. Render-scoped updates guarantee that each requested sample
    // pass actually executes and records its BundleGroups.
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

      // Visit both retained camera identities so normal and wireframe command
      // bundles coexist; finish on the live mode.
      const selectedWireframeAtStart = wireframeActive;
      const wireframeModes =
        scope === "full" ? [!selectedWireframeAtStart, selectedWireframeAtStart] : [selectedWireframeAtStart];
      for (const wireframe of wireframeModes) {
        if (wireframe) syncWireframeCamera();
        applyWireframeOverride(wireframe);
        await compilePass(scenePass);
        markStage(`scene-${activeSceneSamples || 1}x-wf${wireframe ? 1 : 0}-compile`);
        // compileAsync does not record BundleGroups. A covered render does.
        activePipeline.render();
        markStage(`scene-${activeSceneSamples || 1}x-wf${wireframe ? 1 : 0}-record`);
      }
      if (wireframeActive) syncWireframeCamera();
      applyWireframeOverride(wireframeActive);

      await compilePostFxVariants(scope === "boot" ? [activeVariantMask & 7] : POSTFX_VARIANT_MASKS);
      markStage("output-compile");
      if (fxaaRequested) {
        await compileFxaaPipeline();
        markStage("fxaa-compile");
      }

      // Explicitly visit an ink pipeline: deferred BundleGroup contents need
      // recording in the normal/depth MRT even after the quad's GPU program was
      // already warm. In "boot" scope only bother when ink IS the active look
      // (its prepass BundleGroups otherwise record on first toggle). Finish with
      // the selected look on the canvas.
      if (needsInkWarmup) {
        const inkPipeline = getVariantPipeline(INK_VARIANT_MASK);
        inkPipeline.render();
        if (inkPipeline !== activePipeline) activePipeline.render();
        markStage("ink-record");
      }
    } finally {
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
  const warmup = (scope: WarmupScope = "full", pace?: () => Promise<void>) => {
    if (warmupInFlight !== null) return warmupInFlight;
    warmupInFlight = warmupOnce(scope, pace).finally(() => {
      warmupInFlight = null;
    });
    return warmupInFlight;
  };

  applyPostFx();

  const render = () => {
    // M11: the stillness gate samples the presented camera every render call —
    // including held ones, so movement DURING a hold is still observed and
    // waiters/deadlines keep progressing while frames are frozen.
    motionGate.sampleFrame(camera);
    if (exclusiveCompileDepth > 0) {
      // Held frame: a compile window is mutating shared renderer state (C3).
      tracer.count("renderSkipCompile");
      return;
    }
    if (wireframeActive) syncWireframeCamera();
    // Promote to the god-ray variant once the dedicated light's shadow map
    // exists (the beauty pass allocates it a few frames after activation), and
    // demote if a lighting rebuild ever retires that map mid-flight.
    if (
      pianoGodRaysEnabled() &&
      pianoGodRaysRuntime !== null &&
      pianoGodRaysActive !== pianoGodRaysRuntime.shadowMapReady()
    ) {
      selectActivePipeline();
    }
    if (pianoGodRaysActive) {
      pianoGodRaysRuntime?.update(pianoGodRaysCenter);
      pianoGodRaysRenderedFrames += 1;
    }
    const fxaaActive = fxaaRequested && fxaaRuntime !== null;
    if (!fastCaptureTarget && !fxaaActive) {
      activePipeline.render();
      markTextureDisposalFrame(renderer);
      return;
    }
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    if (fxaaActive) {
      const runtime = fxaaRuntime!;
      if (fastCaptureTarget) runtime.size.set(fastCaptureTarget.width, fastCaptureTarget.height);
      else renderer.getDrawingBufferSize(runtime.size);
      const width = Math.max(1, Math.round(runtime.size.x));
      const height = Math.max(1, Math.round(runtime.size.y));
      if (runtime.sourceTarget.width !== width || runtime.sourceTarget.height !== height) {
        runtime.sourceTarget.setSize(width, height);
      }
      renderer.setRenderTarget(runtime.sourceTarget);
      activePipeline.render();
      renderer.setRenderTarget(fastCaptureTarget);
      runtime.pipeline.render();
    } else {
      renderer.setRenderTarget(fastCaptureTarget);
      activePipeline.render();
    }
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    markTextureDisposalFrame(renderer);
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

  // On-demand still capture for the H-key in-game screenshot path. Unlike
  // ?fastcapture=1 (which redirects every live frame into a ping-pong RT), this
  // only allocates when a still is requested and restores the canvas afterward.
  let stillCaptureTarget: THREE.RenderTarget | null = null;
  let stillReadbackBuffer: { destroy(): void; mapAsync(mode: number): Promise<unknown>; getMappedRange(): ArrayBuffer; unmap(): void } | null =
    null;
  let stillBytesPerRow = 0;

  const ensureStillCapture = (width: number, height: number) => {
    const backend = renderer.backend as any;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const needsTarget =
      !stillCaptureTarget || stillCaptureTarget.width !== width || stillCaptureTarget.height !== height;
    if (needsTarget) {
      stillCaptureTarget?.dispose();
      stillCaptureTarget = new THREE.RenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false
      });
      stillCaptureTarget.texture.name = "in-game-still-final-color";
    }
    if (!stillReadbackBuffer || stillBytesPerRow !== bytesPerRow || needsTarget) {
      stillReadbackBuffer?.destroy();
      stillReadbackBuffer = backend.device.createBuffer({
        size: bytesPerRow * height,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ
      });
      stillBytesPerRow = bytesPerRow;
    }
  };

  const captureStillRgba = async () => {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const width = Math.max(1, Math.round(size.x));
    const height = Math.max(1, Math.round(size.y));
    ensureStillCapture(width, height);
    if (!stillCaptureTarget || !stillReadbackBuffer) {
      throw new Error("in-game still capture buffers failed to allocate");
    }

    if (wireframeActive) syncWireframeCamera();
    if (pianoGodRaysActive) pianoGodRaysRuntime?.update(pianoGodRaysCenter);

    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(stillCaptureTarget);
    activePipeline.render();
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);

    const backend = renderer.backend as any;
    const texture = backend.get(stillCaptureTarget.texture).texture;
    if (!texture) throw new Error("in-game still GPU texture is not initialized");

    const encoder = backend.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      {
        buffer: stillReadbackBuffer,
        bytesPerRow: stillBytesPerRow,
        rowsPerImage: height
      },
      [width, height, 1]
    );
    backend.device.queue.submit([encoder.finish()]);
    await stillReadbackBuffer.mapAsync(GPU_MAP_MODE_READ);

    const tightStride = width * 4;
    const padded = new Uint8Array(stillReadbackBuffer.getMappedRange());
    const tight = new Uint8ClampedArray(tightStride * height);
    if (stillBytesPerRow === tightStride) tight.set(padded.subarray(0, tight.length));
    else {
      for (let y = 0; y < height; y++) {
        tight.set(
          padded.subarray(y * stillBytesPerRow, y * stillBytesPerRow + tightStride),
          y * tightStride
        );
      }
    }
    stillReadbackBuffer.unmap();
    return { width, height, pixels: tight };
  };

  return {
    render,
    /** M10: true while an exclusive compile window is holding presented
     * frames. Streaming attach paths poll this so scene mutations that dirty
     * render bundles don't pile up unseen behind a long window and then all
     * record (with their first-draw pipeline creations) in one giant frame. */
    get compileHeld() {
      return exclusiveCompileDepth > 0;
    },
    /** The currently selected persistent fullscreen pipeline. */
    get pipeline() {
      return activePipeline;
    },
    /** Select the cached post-FX graph after a toggle change. */
    applyPostFx,
    /** Dev-capture only: opt the beauty pass into 4x sampling for film renders. */
    setCinematicMultisampling,
    /** Read-only diagnostics for probes; normal play remains at one sample. */
    get sceneSampleCount() {
      return activeSceneSamples || 1;
    },
    /** Probe-facing first-use state for the optional final FXAA pass. */
    get fxaaState() {
      return {
        requested: fxaaRequested,
        loaded: fxaaRuntime !== null,
        active: fxaaRequested && fxaaRuntime !== null
      };
    },
    /** Enter/leave the only area allowed to allocate and render god rays. */
    setPianoGodRaysArea,
    /** Push piano god-ray controls without changing the global style mask. */
    applyPianoGodRaysFx,
    /** Probe-facing state; read-only and allocation-free until requested. */
    get pianoGodRaysState() {
      return {
        requested: pianoGodRaysRequested,
        active: pianoGodRaysActive,
        loaded: pianoGodRaysRuntime !== null,
        renderedFrames: pianoGodRaysRenderedFrames
      };
    },
    /** Probe-facing raw GPU texture retirement state. */
    get textureDisposalState() {
      return deferredTextureDisposalState(renderer);
    },
    /** Swap the scene pass to/from the retained wireframe override + camera. */
    setWireframe,
    /** Blend the wireframe override from neutral grey to its logarithmic LOD ramp. */
    setWireframeLodGradient,
    /** Browser-native review capture reads the final post-FX texture here. */
    queueFastFrame,
    drainFastFrame,
    /** One-shot GPU readback of the post-FX frame for in-game stills (H key). */
    captureStillRgba,
    fastCaptureSize: fastCaptureTarget ? [fastCaptureTarget.width, fastCaptureTarget.height] as const : null,
    /** Precompile scene/effect variants; safe to repeat after new loads. */
    warmup,
    /** Compile every retained style graph plus the first-use FXAA pass.
     * One variant per frame so live atmosphere is never drawn under the
     * compile-time tone-mapping/color-space override. */
    warmupPostFx: (() => {
      let inFlight: Promise<void> | null = null;
      return async () => {
        if (inFlight) return inFlight;
        inFlight = (async () => {
          for (const mask of POSTFX_VARIANT_MASKS) {
            await compilePostFxVariants([mask]);
            await yieldToFrame();
          }
          await compileFxaaPipeline();
        })().catch((err) => {
          inFlight = null;
          throw err;
        });
        return inFlight;
      };
    })(),
    /** Stable half-resolution close-contact complement and live controls. */
    contactShadows
  };
}
