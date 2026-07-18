import * as THREE from "three/webgpu";
import { int, rtt, uniform } from "three/tsl";
import { godrays } from "three/addons/tsl/display/GodraysNode.js";
import { bilateralBlur } from "three/addons/tsl/display/BilateralBlurNode.js";
import { depthAwareBlend } from "three/addons/tsl/display/depthAwareBlend.js";
import type { PianoGodRaysParams } from "./pianoGodRaysTypes";

type GodraysPass = ReturnType<typeof godrays> & {
  raymarchSteps: { value: number };
  density: { value: number };
  maxDensity: { value: number };
  distanceAttenuation: { value: number };
  resolutionScale: number;
};

type BilateralPass = ReturnType<typeof bilateralBlur> & {
  resolutionScale: number;
  dispose(): void;
};

const SHADOW_EXTENT = 220;
const SHADOW_DISTANCE = 360;
const SUN_REFRESH_COSINE = Math.cos(THREE.MathUtils.degToRad(0.25));

/**
 * Piano-only implementation of Three's official WebGPU god-ray stack:
 * screen-space raymarch -> bilateral blur -> depth-aware composite.
 *
 * The world's sun uses a custom multi-map ShadowBaseNode, while GodraysNode
 * directly samples one conventional light.shadow map. This graph therefore
 * owns a non-illuminating directional light aligned to the live sun. It exists
 * only while the player is inside the piano area, and its static shadow map is
 * refreshed only when the source direction or site anchor materially changes.
 */
export function createPianoGodRays(opts: {
  scene: THREE.Scene;
  camera: THREE.Camera;
  sceneColor: any;
  sceneDepth: any;
  sourceLight: THREE.DirectionalLight;
  center: THREE.Vector3;
  params: PianoGodRaysParams;
}) {
  const { scene, camera, sceneColor, sceneDepth, sourceLight } = opts;

  // Black radiance keeps the light fully present in Three's shadow-update path
  // while contributing exactly zero energy to the beauty pass. GodraysNode uses
  // only the light transform/shadow map; its warm composite colour is separate.
  const shadowLight = new THREE.DirectionalLight(0x000000, 1);
  shadowLight.name = "beachPianist.godRays.shadowLight";
  shadowLight.castShadow = true;
  shadowLight.shadow.mapSize.set(1024, 1024);
  shadowLight.shadow.bias = -0.00035;
  shadowLight.shadow.normalBias = 0.08;
  shadowLight.shadow.autoUpdate = false;
  shadowLight.shadow.needsUpdate = true;
  const shadowCamera = shadowLight.shadow.camera;
  const halfExtent = SHADOW_EXTENT * 0.5;
  shadowCamera.left = -halfExtent;
  shadowCamera.right = halfExtent;
  shadowCamera.top = halfExtent;
  shadowCamera.bottom = -halfExtent;
  shadowCamera.near = 0.5;
  shadowCamera.far = SHADOW_DISTANCE * 2;
  shadowCamera.updateProjectionMatrix();
  scene.add(shadowLight, shadowLight.target);

  const rayPass = godrays(sceneDepth, camera, shadowLight) as GodraysPass;
  const rayTexture = rayPass.getTextureNode();
  const blurPass = bilateralBlur(rayTexture) as BilateralPass;
  // Blur at the raymarch target's own resolution; there is no second upscale.
  blurPass.resolutionScale = 1;

  const blendColor = uniform(new THREE.Color(0xffe1b8));
  const edgeRadius = uniform(int(opts.params.edgeRadius));
  const edgeStrength = uniform(opts.params.edgeStrength);
  const composite = depthAwareBlend(
    sceneColor,
    blurPass.getTextureNode(),
    sceneDepth,
    camera,
    { blendColor, edgeRadius, edgeStrength }
  );
  // The existing stylized post stack needs a texture source because dream/flow
  // variants take offset samples. One retained half-float RTT keeps those looks
  // composable without changing the official god-ray/blur/blend sequence.
  const sceneTexture = rtt(composite) as any;
  sceneTexture.name = "beachPianist.godRays.composite";

  const lastCenter = new THREE.Vector3(Number.POSITIVE_INFINITY, 0, 0);
  const lastDirection = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const target = new THREE.Vector3();
  let disposed = false;

  const configure = (params: PianoGodRaysParams) => {
    rayPass.raymarchSteps.value = Math.round(THREE.MathUtils.clamp(params.raymarchSteps, 24, 96));
    rayPass.density.value = THREE.MathUtils.clamp(params.density, 0.02, 0.8);
    rayPass.maxDensity.value = THREE.MathUtils.clamp(params.maxDensity, 0.02, 0.5);
    rayPass.distanceAttenuation.value = THREE.MathUtils.clamp(params.distanceAttenuation, 0, 4);
    rayPass.resolutionScale = THREE.MathUtils.clamp(params.resolutionScale, 0.35, 0.75);
    edgeRadius.value = Math.round(THREE.MathUtils.clamp(params.edgeRadius, 0, 5));
    edgeStrength.value = THREE.MathUtils.clamp(params.edgeStrength, 0, 5);
  };

  const update = (center: THREE.Vector3) => {
    target.copy(center);
    target.y += 10;
    direction.subVectors(sourceLight.position, sourceLight.target.position);
    if (direction.lengthSq() < 1e-6) direction.set(-0.52, 0.42, -0.28);
    direction.normalize();

    const anchorChanged = target.distanceToSquared(lastCenter) > 0.25 * 0.25;
    const directionChanged = lastDirection.lengthSq() === 0 || direction.dot(lastDirection) < SUN_REFRESH_COSINE;
    shadowLight.target.position.copy(target);
    shadowLight.position.copy(target).addScaledVector(direction, SHADOW_DISTANCE);
    shadowLight.target.updateMatrixWorld();
    shadowLight.updateMatrixWorld();
    if (anchorChanged || directionChanged) {
      shadowLight.shadow.needsUpdate = true;
      lastCenter.copy(target);
      lastDirection.copy(direction);
    }
  };

  configure(opts.params);
  update(opts.center);

  return {
    sceneTexture,
    configure,
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.remove(shadowLight, shadowLight.target);
      rayPass.dispose();
      blurPass.dispose();
      sceneTexture.renderTarget?.dispose();
      sceneTexture._quadMesh?.material?.dispose();
      shadowLight.dispose();
    }
  };
}
