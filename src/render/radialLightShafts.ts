import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  getViewPosition,
  pass,
  renderOutput,
  rtt,
  screenUV,
  smoothstep,
  uniform,
  vec3,
  vec4
} from "three/tsl";
import { radialBlur } from "three/addons/tsl/display/radialBlur.js";
import type { RadialLightParams, RadialLightSource } from "./radialLightTypes";

/**
 * Optional stained-glass light graph. This file is deliberately reached only through
 * dynamic import: the radial helper's 16–64 tap loop must not join clean boot.
 *
 * The source scene contains only stained-glass proxies. A half-resolution
 * visibility pass rejects windows hidden by the beauty pass depth before the
 * official Three radialBlur() helper turns their colour into screen-space rays.
 */
export function createRadialLightShafts(opts: {
  camera: THREE.Camera;
  sceneDepth: any;
  source: RadialLightSource;
  params: RadialLightParams;
}) {
  const { camera, sceneDepth, source } = opts;

  const sourcePass = pass(source.scene, camera, { samples: 0 });
  sourcePass.name = "radial-light-stained-glass-source";
  sourcePass.transparent = false;
  sourcePass.getTexture("output").type = THREE.HalfFloatType;

  const sourceColor = sourcePass.getTextureNode();
  const sourceDepth = sourcePass.getTextureNode("depth");
  const projectionInverse = uniform(camera.projectionMatrixInverse);

  // Filter the proxy-only pass against the real scene depth. Equal depths are
  // fully visible; a small view-space tolerance absorbs half-res quantization.
  const visibleSourceNode = Fn(() => {
    const art = sourceColor.sample(screenUV);
    const artViewZ = getViewPosition(screenUV, sourceDepth.sample(screenUV).r, projectionInverse).z;
    const sceneViewZ = getViewPosition(screenUV, sceneDepth.sample(screenUV).r, projectionInverse).z;
    const tolerance = sceneViewZ.abs().mul(0.00075).add(0.02);
    const visible = smoothstep(tolerance.negate(), float(0), artViewZ.sub(sceneViewZ));
    return vec4(art.rgb.mul(visible), art.a.mul(visible));
  })();
  visibleSourceNode.name = "radial-light-visible-stained-glass";

  const visibleSource = rtt(visibleSourceNode);
  visibleSource.name = "radial-light-visible-source-rtt";

  const U = {
    center: uniform(source.center),
    intensity: uniform(opts.params.intensity),
    weight: uniform(opts.params.weight),
    decay: uniform(opts.params.decay),
    sampleCount: uniform(opts.params.sampleCount, "int"),
    exposure: uniform(opts.params.exposure)
  };

  const blurred = radialBlur(visibleSource, {
    center: U.center,
    weight: U.weight,
    decay: U.decay,
    count: U.sampleCount,
    exposure: U.exposure
  });

  const outputs = new Map<number, any>();
  const compose = (key: number, baseNode: any) => {
    let output = outputs.get(key);
    if (output !== undefined) return output;

    output = Fn(() => {
      const base = vec4(baseNode).toVar();
      const sourceSample = visibleSource.sample(screenUV).rgb;
      // radialBlur returns source + rays. Remove the source so compositing does
      // not double-light the windows already present in the beauty pass.
      const raysLinear = (blurred as any).rgb.sub(sourceSample).max(vec3(0));
      const raysDisplay = renderOutput(vec4(raysLinear.mul(vec3(1.04, 0.99, 0.9)), 1)).rgb;
      const color = base.rgb.add(raysDisplay.mul(U.intensity)).clamp(0, 1);
      return vec4(color, base.a);
    })();
    outputs.set(key, output);
    return output;
  };

  const configure = (params: RadialLightParams) => {
    U.intensity.value = Math.max(0, params.intensity);
    U.weight.value = THREE.MathUtils.clamp(params.weight, 0, 1);
    U.decay.value = THREE.MathUtils.clamp(params.decay, 0, 1);
    U.sampleCount.value = Math.round(THREE.MathUtils.clamp(params.sampleCount, 16, 64));
    U.exposure.value = Math.max(0, params.exposure);
    const scale = THREE.MathUtils.clamp(params.resolutionScale, 0.25, 1);
    sourcePass.setResolutionScale(scale);
    visibleSource.setResolutionScale(scale);
  };

  configure(opts.params);

  return {
    compose,
    configure,
    update() {
      source.update(camera);
    },
    dispose() {
      sourcePass.renderTarget.dispose();
      visibleSource.renderTarget?.dispose();
      // RTTNode has no public dispose in r185; release its retained fullscreen
      // material explicitly alongside the target it owns.
      (visibleSource as any)._quadMesh?.material?.dispose();
      outputs.clear();
    }
  };
}
