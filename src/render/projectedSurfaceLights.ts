import * as THREE from "three/webgpu";
import {
  Fn,
  Loop,
  NodeUpdateType,
  color,
  float,
  getViewPosition,
  passTexture,
  saturate,
  smoothstep,
  uniform,
  uniformArray,
  uv,
  vec3,
  vec4
} from "three/tsl";
import {
  MAX_PROJECTED_SURFACE_LIGHTS,
  type ProjectedSurfaceLightSource
} from "./projectedSurfaceLightTypes";

const RESOLUTION_SCALE = 0.5;
const HEIGHT_FADE_START = 1.8;
const HEIGHT_FADE_END = 3.2;

/**
 * Fixed-budget close lighting complement. It reconstructs the already-visible
 * surface from beauty depth, so a single lamp footprint crosses road, marking,
 * curb, sidewalk, and ground meshes without transparent sorting seams.
 */
class ProjectedSurfaceLightPassNode extends THREE.TempNode {
  static get type() {
    return "ProjectedSurfaceLightPassNode";
  }

  readonly #source: ProjectedSurfaceLightSource;
  readonly #depthNode: any;
  readonly #projectionInverse: any;
  readonly #cameraWorldMatrix: any;
  readonly #count = uniform(0, "int");
  readonly #intensity = uniform(0);
  readonly #positions = Array.from(
    { length: MAX_PROJECTED_SURFACE_LIGHTS },
    () => new THREE.Vector4()
  );
  readonly #normals = Array.from(
    { length: MAX_PROJECTED_SURFACE_LIGHTS },
    () => new THREE.Vector4(0, 1, 0, 0)
  );
  readonly #positionsNode = uniformArray(this.#positions, "vec4");
  readonly #normalsNode = uniformArray(this.#normals, "vec4");
  readonly #renderTarget: THREE.RenderTarget;
  readonly #material: THREE.NodeMaterial;
  readonly #quad: THREE.QuadMesh;
  readonly #textureNode: any;
  readonly #size = new THREE.Vector2();
  #rendererState: any = undefined;
  #disposed = false;

  constructor(
    depthNode: any,
    camera: THREE.Camera,
    source: ProjectedSurfaceLightSource
  ) {
    super("vec4");
    this.updateBeforeType = NodeUpdateType.FRAME;
    this.#source = source;
    this.#depthNode = depthNode;
    // Object-reference uniforms follow the live camera matrices, including
    // reversed depth and camera cuts, without per-frame object churn.
    this.#projectionInverse = uniform(camera.projectionMatrixInverse);
    this.#cameraWorldMatrix = uniform(camera.matrixWorld);

    this.#renderTarget = new THREE.RenderTarget(1, 1, {
      depthBuffer: false,
      stencilBuffer: false,
      format: THREE.RGBAFormat,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false
    });
    this.#renderTarget.texture.name = "ProjectedSurfaceLights";
    this.#material = new THREE.NodeMaterial();
    this.#material.name = "ProjectedSurfaceLights";
    this.#quad = new THREE.QuadMesh(this.#material);
    this.#quad.name = "ProjectedSurfaceLights";
    this.#textureNode = passTexture(this as any, this.#renderTarget.texture);
  }

  sample(sampleUv?: any) {
    return sampleUv === undefined
      ? this.#textureNode.rgb
      : this.#textureNode.sample(sampleUv).rgb;
  }

  syncSource() {
    const count = Math.min(
      MAX_PROJECTED_SURFACE_LIGHTS,
      Math.max(0, this.#source.count | 0)
    );
    this.#count.value = count;
    this.#intensity.value = Math.max(0, this.#source.intensity);
    for (let i = 0; i < count; i++) {
      this.#source.copyLight(i, this.#positions[i], this.#normals[i]);
    }
    // UniformArrayNode uploads the fixed arrays each render. Clear stale slots
    // when the live count contracts so debug captures cannot retain old data.
    for (let i = count; i < MAX_PROJECTED_SURFACE_LIGHTS; i++) {
      this.#positions[i].set(0, 0, 0, 0);
      this.#normals[i].set(0, 1, 0, 0);
    }
  }

  updateBefore(frame: any): boolean | undefined {
    if (this.#disposed) return undefined;
    const renderer = frame.renderer as THREE.WebGPURenderer;
    const size = renderer.getDrawingBufferSize(this.#size);
    const width = Math.max(1, Math.round(size.x * RESOLUTION_SCALE));
    const height = Math.max(1, Math.round(size.y * RESOLUTION_SCALE));
    if (this.#renderTarget.width !== width || this.#renderTarget.height !== height) {
      this.#renderTarget.setSize(width, height);
    }

    this.#rendererState = THREE.RendererUtils.resetRendererState(
      renderer,
      this.#rendererState
    );
    try {
      renderer.setClearColor(0x000000, 0);
      renderer.setRenderTarget(this.#renderTarget);
      this.#quad.render(renderer);
    } finally {
      THREE.RendererUtils.restoreRendererState(renderer, this.#rendererState);
    }
    return undefined;
  }

  setup(builder: any) {
    const sampleUv = uv();
    const reversedDepth = builder.renderer.reversedDepthBuffer === true;
    const isGeometryDepth = (depth: any) =>
      reversedDepth ? depth.greaterThan(1e-7) : depth.lessThan(0.9999999);

    const evaluate = Fn(() => {
      const receiverDepth = this.#depthNode.sample(sampleUv).r.toVar();
      isGeometryDepth(receiverDepth).not().discard();

      const receiverView = getViewPosition(
        sampleUv,
        receiverDepth,
        this.#projectionInverse
      ).toVar("surfaceLightReceiverView");
      const receiverWorld = this.#cameraWorldMatrix
        .mul(vec4(receiverView, 1))
        .xyz.toVar("surfaceLightReceiverWorld");
      const receiverNormal = this.#cameraWorldMatrix
        .transformDirection(receiverView.dFdx().cross(receiverView.dFdy()).normalize())
        .normalize()
        .toVar("surfaceLightReceiverNormal");
      const accumulated = vec3(0).toVar("projectedSurfaceLight");

      // Dynamic count, hard-clamped to 16 on the CPU boundary. Sparse scenes
      // therefore pay only for their actual nearby lamps.
      Loop(this.#count as any, ({ i }: any) => {
        const positionAndRadius: any = this.#positionsNode.element(i);
        const normalAndWeight: any = this.#normalsNode.element(i);
        const lightNormal = normalAndWeight.xyz.normalize();
        const delta = receiverWorld.sub(positionAndRadius.xyz).toVar();
        const height = delta.dot(lightNormal);
        const planarDistance = delta.sub(lightNormal.mul(height)).length();
        const radial = saturate(planarDistance.div(positionAndRadius.w.max(0.01)))
          .oneMinus()
          .pow(2);
        const heightGate = smoothstep(
          HEIGHT_FADE_START,
          HEIGHT_FADE_END,
          height.abs()
        ).oneMinus();
        // Upward/terrain-aligned receivers participate; façades and the sides
        // of curbs/vehicles do not turn into glowing vertical billboards.
        const facing = smoothstep(
          0.08,
          0.58,
          receiverNormal.dot(lightNormal)
        );
        accumulated.addAssign(
          color(0xffb866)
            .mul(radial)
            .mul(heightGate)
            .mul(facing)
            .mul(normalAndWeight.w)
        );
      });

      return vec4(accumulated.mul(this.#intensity), float(1));
    });

    this.#material.fragmentNode = evaluate().context(builder.getSharedContext());
    this.#material.needsUpdate = true;
    return this.#textureNode;
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#renderTarget.dispose();
    this.#material.dispose();
  }
}

export function createProjectedSurfaceLights(opts: {
  camera: THREE.Camera;
  sceneDepth: any;
  source: ProjectedSurfaceLightSource;
}) {
  const pass = new ProjectedSurfaceLightPassNode(
    opts.sceneDepth,
    opts.camera,
    opts.source
  );
  return {
    sample: (sampleUv?: any) => pass.sample(sampleUv),
    update: () => pass.syncSource(),
    dispose: () => pass.dispose()
  };
}
