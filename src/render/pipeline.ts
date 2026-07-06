import * as THREE from "three/webgpu";
import {
  pass,
  mrt,
  normalViewGeometry,
  packNormalToRGB
} from "three/tsl";
import { createPostFx, applyPostFxParams, POSTFX_TUNING, POSTFX_TOGGLES } from "./postfx";

type RuntimePassOptions = { options: { samples?: number } };
const OUTLINE_PREPASS_SCALE = 0.5;

/**
 * WebGPU render graph: a scene pass owns color/MSAA, and a lightweight
 * normal+depth prepass is referenced only when ink outlines are enabled.
 * With all stylized effects off, the pipeline outputs the scene pass directly
 * and lets RenderPipeline apply tone mapping/color space conversion.
 */
export function createRenderPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera
) {
  const pipeline = new THREE.RenderPipeline(renderer);

  // cheap outline prepass: view-space normals (packed to 8-bit) + depth, opaque only.
  // Geometry normals, not material normals: normalView pulls in each material's
  // normalNode chain (the facade's brick-bump fractal noise), re-running it over
  // the frame just to feed edge detection that does not need material-scale
  // bumps. The vertex normal is free and visually identical here.
  // samples: 0 — the canvas is non-MSAA (see main.ts), so PassNode would
  // otherwise inherit whatever the renderer reports; multisampling this target
  // is pure raster/bandwidth waste for an outline lookup.
  const prePass = pass(scene, camera, { samples: 0 });
  prePass.transparent = false;
  prePass.setResolutionScale(OUTLINE_PREPASS_SCALE);
  prePass.setMRT(mrt({ output: packNormalToRGB(normalViewGeometry) }));
  prePass.getTexture("output").type = THREE.UnsignedByteType;

  const prePassDepth = prePass.getTextureNode("depth");

  const clampSceneSamples = () => Math.max(0, Math.min(4, Math.round(POSTFX_TUNING.values.sceneSamples as number)));
  let activeSceneSamples = clampSceneSamples();

  // lit scene pass. samples: this is where the image's geometry AA actually
  // happens now that the canvas itself is single-sampled (main.ts)
  const scenePass = pass(scene, camera, { samples: activeSceneSamples });
  const sceneColor = scenePass.getTextureNode();

  // stylized post effects (postfx.ts) sit after tone mapping. They disable the
  // pipeline's automatic output transform and apply renderOutput inside their
  // custom shader; the default no-effect path keeps the automatic transform.
  const postfx = createPostFx({
    sceneTex: sceneColor,
    normalTex: prePass.getTextureNode(),
    depthTex: prePassDepth,
    camera
  });
  const applyPostQuality = () => {
    const sceneSamples = clampSceneSamples();
    if (sceneSamples === activeSceneSamples) return;

    activeSceneSamples = sceneSamples;
    (scenePass as typeof scenePass & RuntimePassOptions).options.samples = sceneSamples;
    scenePass.renderTarget.samples = sceneSamples;
    pipeline.needsUpdate = true;
  };
  const applyPostFx = () => {
    applyPostFxParams();
    applyPostQuality();
    if (POSTFX_TOGGLES.some((key) => Boolean(POSTFX_TUNING.values[key]))) {
      pipeline.outputColorTransform = false;
      pipeline.outputNode = postfx.build();
    } else {
      pipeline.outputColorTransform = true;
      pipeline.outputNode = sceneColor;
    }
    pipeline.needsUpdate = true;
  };
  applyPostFx();

  return {
    render: () => pipeline.render(),
    pipeline,
    /** Apply live scene AA quality changes from the "/" panel or render preset. */
    applyPostQuality,
    /** Rebuild the output shader after a post-fx toggle change ("/" panel). */
    applyPostFx
  };
}
