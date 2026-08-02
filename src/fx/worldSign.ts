import * as THREE from "three/webgpu";
import {
  Fn,
  texture,
  uv,
  screenUV,
  positionView,
  perspectiveDepthToViewZ,
  cameraNear,
  cameraFar
} from "three/tsl";

type N = any;

/** Stand-in until `bindOcclusionDepth` hands the beauty depth attachment. */
function makePlaceholderDepth(): THREE.DepthTexture {
  const depth = new THREE.DepthTexture(1, 1);
  depth.name = "world_sign_depth_placeholder";
  depth.type = THREE.FloatType;
  return depth;
}

export type WorldSignOptions = {
  /** Pipeline world-UI overlay scene — never the beauty scene. */
  scene: THREE.Scene;
  map: THREE.Texture;
  width: number;
  height: number;
  name?: string;
  /** Beauty-pass depth for occlusion against world geometry. */
  beautyDepth?: THREE.Texture | null;
};

/**
 * Opaque in-world placard drawn in the world-UI overlay pass: same camera and
 * beauty-depth occlusion as the aim cursor, but composited after TAA/grain so
 * lettering stays sharp. Add meshes here — never to the beauty scene.
 */
export class WorldSign {
  readonly mesh: THREE.Mesh;
  readonly #map: THREE.Texture;
  readonly #depthNode: N;
  #disposed = false;

  constructor(options: WorldSignOptions) {
    this.#map = options.map;
    this.#depthNode = texture(options.beautyDepth ?? makePlaceholderDepth());
    const mapNode = texture(options.map);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.colorNode = Fn(() => {
      const sceneRaw = this.#depthNode.sample(screenUV).r as N;
      const sceneViewZ = perspectiveDepthToViewZ(sceneRaw, cameraNear, cameraFar);
      const fragViewZ = positionView.z as N;
      // Reversed-Z: closer beauty geometry has a larger (less negative) view Z.
      sceneRaw
        .greaterThan(1e-7)
        .and(sceneViewZ.greaterThan(fragViewZ.add(0.02)))
        .discard();
      return mapNode.sample(uv());
    })();
    mat.transparent = true;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.side = THREE.FrontSide;
    mat.fog = false;
    mat.toneMapped = false;

    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(options.width, options.height), mat);
    this.mesh.name = options.name ?? "world_sign";
    this.mesh.frustumCulled = true;
    this.mesh.renderOrder = 80;
    options.scene.add(this.mesh);
  }

  bindOcclusionDepth(depth: THREE.Texture) {
    this.#depthNode.value = depth;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    const mat = this.mesh.material as THREE.MeshBasicNodeMaterial;
    mat.dispose();
    this.#map.dispose();
  }
}
