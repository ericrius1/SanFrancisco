import * as THREE from "three/webgpu";
import {
  pass,
  mrt,
  normalViewGeometry,
  screenUV,
  sample,
  packNormalToRGB,
  unpackRGBToNormal,
  builtinAOContext
} from "three/tsl";
import { ssao } from "./vendor/SSAONode.js";
import { createPostFx, applyPostFxParams, POSTFX_TUNING } from "./postfx";

type RuntimePassOptions = { options: { samples?: number } };

/**
 * The reference webgpu_generator_city post stack (three @ 8be3d501): a normal+depth
 * pre-pass feeds a fast SSAO, whose occlusion is folded into the lit scene pass
 * through the built-in AO lighting context (so it only darkens the sky/IBL fill in
 * crevices, never the direct sun). SSAONode is vendored from that commit — three
 * 0.185 doesn't ship it yet. ACES tone mapping is set on the renderer.
 */
export function createRenderPipeline(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.Camera
) {
  const pipeline = new THREE.RenderPipeline(renderer);

  // cheap pre-pass: view-space normals (packed to 8-bit) + depth, opaque only.
  // Geometry normals, not material normals: normalView pulls in each material's
  // normalNode chain (the facade's brick-bump fractal noise), re-running it over
  // the whole frame just to feed a half-res 1.5m-radius AO that can't see brick
  // bumps anyway. The vertex normal is free and visually identical here.
  // samples: 0 — the canvas is non-MSAA (see main.ts), so PassNode would
  // otherwise inherit whatever the renderer reports; this target feeds a
  // configurable, low-res AO and multisampling it is pure raster/bandwidth waste.
  // Half resolution for the same reason: the AO pass samples at 0.5 scale, so
  // a full-res prepass rasterizes the whole city for texels the AO never reads.
  const prePass = pass(scene, camera, { samples: 0 });
  prePass.transparent = false;
  prePass.setResolutionScale(0.5);
  prePass.setMRT(mrt({ output: packNormalToRGB(normalViewGeometry) }));
  prePass.getTexture("output").type = THREE.UnsignedByteType;

  const prePassNormal = sample((uv) => unpackRGBToNormal(prePass.getTextureNode().sample(uv)));
  const prePassDepth = prePass.getTextureNode("depth");

  // screen-space AO for the facade's contact shadows; half-res is plenty for soft
  // fill, and few taps suffice since the AO only tints the sky fill in crevices
  const aoPass = ssao(prePassDepth, prePassNormal, camera);
  aoPass.blurEnabled = false;

  // lit scene pass, with the AO tinting only the ambient term via the context.
  // samples: this is where the image's geometry AA actually happens now
  // that the canvas itself is single-sampled (main.ts)
  const scenePass = pass(scene, camera, { samples: POSTFX_TUNING.values.sceneSamples as number });
  const aoContext = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
  const sceneColor = scenePass.getTextureNode();

  // stylized post effects (postfx.ts) sit after tone mapping, so the pipeline
  // hands them display-referred sRGB: outputColorTransform off, renderOutput
  // applied inside the postfx chain instead. With every toggle off the chain
  // degenerates to renderOutput(scene).
  pipeline.outputColorTransform = false;
  const postfx = createPostFx({
    sceneTex: sceneColor,
    normalTex: prePass.getTextureNode(),
    depthTex: prePassDepth,
    camera
  });
  const applyPostQuality = () => {
    const v = POSTFX_TUNING.values;
    const sceneSamples = Math.max(0, Math.min(4, Math.round(v.sceneSamples as number)));
    const ssaoScale = Math.max(0.25, Math.min(1, v.ssaoScale as number));
    const ssaoSamples = Math.max(1, Math.min(12, Math.round(v.ssaoSamples as number)));

    (scenePass as typeof scenePass & RuntimePassOptions).options.samples = sceneSamples;
    scenePass.renderTarget.samples = sceneSamples;
    prePass.setResolutionScale(ssaoScale);
    aoPass.resolutionScale = ssaoScale;
    aoPass.samples.value = ssaoSamples;
    aoPass.radius.value = v.ssaoRadius as number;
    aoPass.intensity.value = v.ssaoIntensity as number;
    scenePass.contextNode = v.ssao ? aoContext : null;
    pipeline.needsUpdate = true;
  };
  const applyPostFx = () => {
    applyPostFxParams();
    applyPostQuality();
    pipeline.outputNode = postfx.build();
    pipeline.needsUpdate = true;
  };
  applyPostFx();

  return {
    render: () => pipeline.render(),
    pipeline,
    /** Apply live AA/SSAO quality changes from the "/" panel or render preset. */
    applyPostQuality,
    /** Rebuild the output shader after a post-fx toggle change ("/" panel). */
    applyPostFx
  };
}
