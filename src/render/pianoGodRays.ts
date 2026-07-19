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

// One session-pooled shadow light. Its ShadowNode and depth texture stay in
// retained scene bundles for seconds after a light-set change, so destroying
// them on grove exit floods the queue with destroyed-texture submits (and a
// disposed ShadowNode crashes on its nulled map). The light instead detaches
// from the scene with updates paused and keeps its GPU map for the session;
// re-entry reattaches it with the shadow map already allocated.
let pooledShadowLight: THREE.DirectionalLight | null = null;
let pooledLightOwner: object | null = null;

function acquireShadowLight(): THREE.DirectionalLight {
  if (pooledShadowLight) return pooledShadowLight;
  // Black radiance keeps the light fully present in Three's shadow-update path
  // while contributing exactly zero energy to the beauty pass. GodraysNode uses
  // only the light transform/shadow map; its warm composite colour is separate.
  const light = new THREE.DirectionalLight(0x000000, 1);
  light.name = "beachPianist.godRays.shadowLight";
  light.castShadow = true;
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.bias = -0.00035;
  light.shadow.normalBias = 0.08;
  const shadowCamera = light.shadow.camera;
  const halfExtent = SHADOW_EXTENT * 0.5;
  shadowCamera.left = -halfExtent;
  shadowCamera.right = halfExtent;
  shadowCamera.top = halfExtent;
  shadowCamera.bottom = -halfExtent;
  shadowCamera.near = 0.5;
  shadowCamera.far = SHADOW_DISTANCE * 2;
  shadowCamera.updateProjectionMatrix();
  pooledShadowLight = light;
  return light;
}

/**
 * Piano-only implementation of Three's official WebGPU god-ray stack:
 * screen-space raymarch -> bilateral blur -> depth-aware composite.
 *
 * The world's sun uses a custom multi-map ShadowBaseNode, while GodraysNode
 * directly samples one conventional light.shadow map. This graph therefore
 * owns a non-illuminating directional light aligned to the live sun. It exists
 * only while the player is inside the piano area. Its shadow map refreshes per
 * frame so streamed-in grove batches and wind-swayed foliage stay current.
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

  const shadowLight = acquireShadowLight();
  const owner = {};
  pooledLightOwner = owner;
  // Live per-frame refresh: the grove's tree batches stream in and swap LODs
  // after activation (a static bake would miss them), and the foliage shadow
  // pass inherits the wind positionNode, so the dapple sways with the leaves.
  // The map only ever contains the compact grove + piano, so the pass is cheap.
  shadowLight.shadow.autoUpdate = true;
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

    shadowLight.target.position.copy(target);
    shadowLight.position.copy(target).addScaledVector(direction, SHADOW_DISTANCE);
    shadowLight.target.updateMatrixWorld();
    shadowLight.updateMatrixWorld();
  };

  configure(opts.params);
  update(opts.center);

  return {
    sceneTexture,
    configure,
    update,
    /**
     * GodraysNode.setup dereferences light.shadow.map.depthTexture, but the
     * renderer only allocates that map when the beauty pass first renders with
     * this light in the scene. The god-ray pipeline variant must not be
     * selected before then (re-entering the grove rebuilds this graph while
     * the scene pass is already compiled, so the map can lag by frames).
     */
    shadowMapReady: () => shadowLight.shadow.map?.depthTexture != null,
    dispose() {
      if (disposed) return;
      disposed = true;
      // The pooled light is only parked, never destroyed (see acquire above).
      // Skip the detach when a newer runtime has already re-acquired it.
      if (pooledLightOwner === owner) {
        pooledLightOwner = null;
        shadowLight.shadow.autoUpdate = false;
        shadowLight.shadow.needsUpdate = false;
        scene.remove(shadowLight, shadowLight.target);
      }
      rayPass.dispose();
      blurPass.dispose();
      sceneTexture.renderTarget?.dispose();
      sceneTexture._quadMesh?.material?.dispose();
    }
  };
}
