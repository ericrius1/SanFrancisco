import * as THREE from "three/webgpu";
import { CONFIG, RENDER_TUNING } from "../config";
import { applyBundleOrderPatch } from "../render/bundleOrderPatch";
import { registerRenderer } from "./rendererRegistry";

export type RenderCore = {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
};

/**
 * Creates the long-lived GPU boundary. Feature HMR deliberately never replaces
 * anything returned here: the renderer/device, scene and camera survive every
 * supported hot swap.
 */
export async function createRenderCore(app: HTMLElement): Promise<RenderCore> {
  // Reversed float depth keeps distant near-coplanar facades stable out to the
  // 24 km far plane. Canvas AA stays off because every pixel routes through the
  // post pipeline, which owns the scene sample count.
  const renderer = new THREE.WebGPURenderer({ antialias: false, reversedDepthBuffer: true });
  renderer.setPixelRatio(RENDER_TUNING.values.pixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER_TUNING.values.exposure;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);
  await renderer.init();
  registerRenderer(renderer);

  // Tiles are BundleGroups; stock r185 draws bundles after transparency and
  // can cover non-depth-writing effects.
  applyBundleOrderPatch(renderer);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far
  );
  return { renderer, scene, camera };
}
