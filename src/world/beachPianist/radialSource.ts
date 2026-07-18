// First-use-only source for the Beach Pianist's bounded god-ray pass. The
// feathered source lives in a proxy-only scene, behind the far edge of the grove.
// The beauty pass depth therefore cuts the trees and flowers out of the source
// before radial blur, making shafts emerge from actual canopy gaps.

import * as THREE from "three/webgpu";
import { color, float, smoothstep, uniform, uv } from "three/tsl";
import { getBeachPianistRadialLightParams, POSTFX_TUNING } from "../../render/postfx";
import type { RadialLightSource } from "../../render/radialLightTypes";

export type BeachPianistRadialSource = {
  source: RadialLightSource;
  dispose(): void;
};

export function createBeachPianistRadialSource(opts: {
  x: number;
  y: number;
  z: number;
}): BeachPianistRadialSource {
  const scene = new THREE.Scene();
  scene.name = "beach-pianist-canopy-light-source";
  scene.background = new THREE.Color(0x000000);

  const geometry = new THREE.CircleGeometry(1, 28);
  const material = new THREE.MeshBasicNodeMaterial();
  material.name = "beach-pianist-canopy-light";
  const feather = uniform(POSTFX_TUNING.values.pianistRaysFeather);
  const radialDistance = uv().sub(0.5).length().mul(2);
  const falloff = smoothstep(float(1).sub(feather), 1, radialDistance)
    .oneMinus()
    .pow(1.65);
  // The source target is cleared to black. Reaching that same black well
  // inside the disc silhouette makes its geometry edge indistinguishable from
  // the target at every camera pitch, so radial blur never reveals a dome or
  // spotlight boundary.
  material.colorNode = color(0xfff1c4).mul(falloff);
  material.toneMapped = false;
  material.depthWrite = true;
  material.depthTest = true;

  const group = new THREE.Group();
  group.name = "beach-pianist-canopy-light-cluster";
  const mesh = new THREE.Mesh(geometry, material);
  mesh.scale.setScalar(8.2);
  mesh.frustumCulled = false;
  group.add(mesh);
  scene.add(group);

  const center = new THREE.Vector2(0.5, 0.58);
  const target = center.clone();
  const cameraWorld = new THREE.Vector3();
  const towardSite = new THREE.Vector3();
  const cameraForward = new THREE.Vector3();
  const projected = new THREE.Vector3();

  const source: RadialLightSource = {
    scene,
    center,
    params: getBeachPianistRadialLightParams,
    update(camera) {
      feather.value = POSTFX_TUNING.values.pianistRaysFeather;
      camera.getWorldPosition(cameraWorld);
      towardSite.set(opts.x - cameraWorld.x, 0, opts.z - cameraWorld.z);
      if (towardSite.lengthSq() < 0.25) {
        camera.getWorldDirection(cameraForward);
        towardSite.set(cameraForward.x, 0, cameraForward.z);
      }
      towardSite.normalize();

      // Always sit just beyond the grove from the current view. The broad,
      // feathered source spans crown height; actual canopy depth provides the
      // irregular openings without overlapping proxy discs that could reveal
      // one another's silhouettes.
      group.position.set(
        opts.x + towardSite.x * 17,
        opts.y + 9.5,
        opts.z + towardSite.z * 17
      );
      group.quaternion.copy(camera.quaternion);
      group.updateMatrixWorld(true);

      projected.copy(group.position).project(camera);
      target.set(
        THREE.MathUtils.clamp(projected.x * 0.5 + 0.5, 0.04, 0.96),
        THREE.MathUtils.clamp(projected.y * 0.5 + 0.5, 0.06, 0.96)
      );
      center.lerp(target, 0.18);
    }
  };

  let disposed = false;
  return {
    source,
    dispose() {
      if (disposed) return;
      disposed = true;
      scene.clear();
      geometry.dispose();
      material.dispose();
    }
  };
}
