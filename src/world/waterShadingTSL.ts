import { DepthTexture, FloatType } from "three/webgpu";
import {
  abs,
  dot,
  exp,
  floor,
  fract,
  hash,
  linearDepth,
  log,
  max,
  mix,
  pow,
  reflect,
  saturate,
  screenUV,
  sin,
  smoothstep,
  vec2,
  vec3,
  viewportDepthTexture
} from "three/tsl";

/**
 * Shared stylized-water shading helpers for the clear "sunlit turquoise" look:
 * Beer-Lambert depth tint over a refracted scene sample, a bed caustic web,
 * discrete sun sparkles and ordered-dither foam edges. Every helper is
 * branchless — If() arms that sample nodes corrupt skipped pixels under the
 * WGSL single-emission rule, so composition stays mix/multiply only.
 */

// TSL node generics fight composition; any is the idiom here (see facade.ts).
type N = any;

/**
 * Interleaved gradient noise: a stable per-pixel ordered-dither value in 0..1.
 * Thresholding a smooth coverage field against it dissolves edges into the
 * chunky stipple the reference art direction uses instead of soft alpha.
 */
export function interleavedGradientNoise(pixelCoord: N): N {
  return fract(fract(dot(pixelCoord, vec2(0.06711056, 0.00583715))).mul(52.9829189));
}

/**
 * Dissolves a smooth 0..1 coverage field through a dither threshold. Full
 * coverage stays solid; partial coverage becomes discrete stipple instead of a
 * translucent smear.
 */
export function ditheredCoverage(coverage: N, dither: N, softness = 0.09): N {
  return saturate(
    smoothstep(dither.mul(0.82).add(0.06).sub(softness), dither.mul(0.82).add(0.06).add(softness), coverage)
  );
}

/**
 * Cheap two-layer caustic filament web. Two counter-drifting warped sine
 * fields multiply so bright ridges only survive where both layers align,
 * which reads as refracted light focusing on the bed.
 */
export function causticWeb(uv: N, t: N): N {
  const layerA = abs(
    sin(uv.x.add(sin(uv.y.mul(1.31).add(t.mul(0.9)))))
      .mul(sin(uv.y.add(sin(uv.x.mul(1.17).sub(t.mul(0.7))))))
  );
  const rotated = vec2(
    uv.x.mul(0.54).sub(uv.y.mul(0.84)),
    uv.x.mul(0.84).add(uv.y.mul(0.54))
  ).mul(1.23);
  const layerB = abs(
    sin(rotated.x.add(sin(rotated.y.mul(1.27).sub(t.mul(0.8)))))
      .mul(sin(rotated.y.add(sin(rotated.x.mul(1.09).add(t.mul(0.63))))))
  );
  const web = pow(saturate(vec3(1).x.sub(layerA.mul(layerB).mul(1.35))), 5.0);
  return smoothstep(0.42, 0.94, web);
}

/**
 * Discrete sun glints: a tight specular lobe gated by a time-flickering hash
 * over world-space cells, so individual points pop on and off rather than one
 * continuous highlight smear.
 */
export function sunSparkle(options: {
  worldPosition: N;
  worldNormal: N;
  viewToFragment: N;
  sunDirection: N;
  time: N;
  cellDensity?: number;
}): N {
  const density = options.cellDensity ?? 9.0;
  const reflected = reflect(options.viewToFragment, options.worldNormal);
  const alignment = saturate(dot(reflected, options.sunDirection));
  const lobe = pow(alignment, 180.0);
  const cell = floor(options.worldPosition.xz.mul(density)) as N;
  const phase = floor(options.time.mul(5.0));
  const seed = cell.x.mul(127.1).add(cell.y.mul(311.7)).add(phase.mul(74.7));
  const gate = smoothstep(0.72, 0.94, hash(seed));
  // Day-only: the gate fades with sun height so night water never glitters.
  const daylight = saturate(options.sunDirection.y.mul(4.0));
  return smoothstep(0.12, 0.55, lobe.mul(gate)).mul(daylight);
}

/**
 * Beer-Lambert transmittance and in-scatter colour for a view path through
 * water. Calibrated so at `clarityDepth` metres the transmitted scene takes on
 * exactly the deep palette colour — palettes stay the single source of truth.
 */
export function beerLambertWater(options: {
  /** Metres of water along the eye ray to whatever is behind the surface. */
  pathLength: N;
  deepColor: N;
  shallowColor: N;
  /** Path length (m) at which the water reaches its full deep colour. */
  clarityDepth: N;
}): { transmittance: N; scatter: N } {
  const sigma = log(max(options.deepColor, vec3(0.02))).negate().div(options.clarityDepth);
  const transmittance = exp(options.pathLength.negate().mul(sigma));
  const scatter = mix(
    options.shallowColor,
    options.deepColor,
    saturate(options.pathLength.div(options.clarityDepth))
  );
  return { transmittance, scatter };
}

// Stock viewportSafeUV() copies the pass depth into a default DepthTexture
// (depth24plus), which mismatches this project's reversed float depth buffer
// (depth32float) and makes every copy fail with a WebGPU validation error. One
// shared float-typed destination keeps the copy format-identical.
let sharedFloatDepth: DepthTexture | null = null;
let sharedFloatDepthNode: N = null;

function floatViewportDepthTexture(uv: N): N {
  if (!sharedFloatDepth) {
    sharedFloatDepth = new DepthTexture(1, 1, FloatType);
    // Build one viewport-copy owner and sample that same copied texture at all
    // UVs. Separate viewportDepthTexture() nodes can otherwise allocate a
    // second, default depth24plus destination during material composition.
    sharedFloatDepthNode = (viewportDepthTexture as unknown as (...args: unknown[]) => N)(
      screenUV,
      null,
      sharedFloatDepth
    );
  }
  return sharedFloatDepthNode.sample(uv);
}

/**
 * Depth-checked refraction UV (reversed-z-safe viewportSafeUV equivalent):
 * where the distorted sample would land on geometry in FRONT of the water
 * surface, fall back to the undistorted UV so foreground objects never smear
 * into the refraction.
 */
export function safeRefractionUV(distortedUV: N): N {
  const sampledIsBehind = linearDepth(floatViewportDepthTexture(distortedUV))
    .greaterThanEqual(linearDepth(floatViewportDepthTexture(screenUV)));
  return sampledIsBehind.select(distortedUV, screenUV);
}

/**
 * Luminance-preserving push of a lit scene sample toward an authored bed
 * colour: keeps the real underwater shading/detail while art-directing the
 * hue (sandy bed under a park lawn, for example).
 */
export function tintTowardBed(sceneColor: N, bedColor: N, amount: N): N {
  const lum = dot(sceneColor, vec3(0.299, 0.587, 0.114));
  const tinted = bedColor.mul(lum.mul(1.35).add(0.22));
  return mix(sceneColor, tinted, amount);
}
