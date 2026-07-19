import * as THREE from "three/webgpu";
import { CONFIG, RENDER_TUNING } from "../config";
import { applyBundleOrderPatch } from "../render/bundleOrderPatch";
import { installAttributeDisposePatch } from "../render/attributeDisposePatch";
import { installPaddedAttributePatch } from "../render/paddedAttributePatch";
import { installRenderObjectRegistry } from "../render/renderObjectRegistry";
import { installDeferredTextureDisposePatch } from "../render/textureDisposePatch";
import { registerRenderer } from "./rendererRegistry";

export type RenderCore = {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
};

/**
 * Three's WebGPURenderer wrapper silently installs a WebGL2 fallback. This
 * project is intentionally WebGPU-only, so build the generic renderer around
 * WebGPUBackend directly: adapter/device failures reject init instead of
 * switching rendering APIs.
 */
class WebGPUOnlyRenderer extends THREE.Renderer {
  readonly isWebGPURenderer = true as const;

  constructor(parameters: THREE.WebGPURendererParameters = {}) {
    super(new THREE.WebGPUBackend(parameters), { ...parameters, getFallback: null });
    this.library = new THREE.StandardNodeLibrary();
  }
}

/**
 * Creates the long-lived GPU boundary. Feature HMR deliberately never replaces
 * anything returned here: the renderer/device, scene and camera survive every
 * supported hot swap.
 */
export async function createRenderCore(app: HTMLElement): Promise<RenderCore> {
  const browserGpu = (navigator as Navigator & { gpu?: unknown }).gpu;
  if (!browserGpu) {
    throw new Error(
      "WebGPU is required to run San Francisco. Use a current browser and device with WebGPU enabled."
    );
  }

  // Reversed float depth keeps distant near-coplanar facades stable out to the
  // 24 km far plane. Live canvas sampling stays off; offline cinematic capture
  // opts only the scene beauty pass into higher sampling.
  const renderer: THREE.WebGPURenderer = new WebGPUOnlyRenderer({
    antialias: false,
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(RENDER_TUNING.values.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER_TUNING.values.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  await renderer.init();
  if ((renderer.backend as THREE.WebGPUBackend).isWebGPUBackend !== true) {
    throw new Error("WebGPU backend initialization failed.");
  }
  app.appendChild(renderer.domElement);
  registerRenderer(renderer);

  // Tiles are BundleGroups; stock r185 draws bundles after transparency and
  // can cover non-depth-writing effects.
  applyBundleOrderPatch(renderer);

  // M9: index RenderObjects by mesh so retiring streamed content that SHARES a
  // long-lived material (tile shadow proxies, citygen chunk cells) can release
  // its render objects — geometry dispose alone never does in r185.
  installRenderObjectRegistry(renderer);

  // r185 destroys an interleaved attribute's shared GPU buffer but evicts the
  // backend cache under the wrong key, so later draws reuse the destroyed
  // buffer forever (the sprite-geometry validation storm). Symmetrize the key.
  installAttributeDisposePatch(renderer);

  // M10: r185 rebuilds a padded attribute's ENTIRE mirror array on every
  // update (per-vertex subarray loop) — ~280 ms per streamed-tile batch attach
  // on the 16-bit quantized arenas. The patch pads/uploads only updateRanges.
  installPaddedAttributePatch(renderer);

  // r185 destroys a render target's raw GPUTexture synchronously even though
  // retained render bundles can still replay a bind group that references it.
  // Retire raw textures only after completed frames and a queue drain.
  installDeferredTextureDisposePatch(renderer);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far
  );
  return { renderer, scene, camera };
}
