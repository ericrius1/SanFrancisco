import type * as THREE from "three/webgpu";
import {
  Fn,
  float,
  vec2,
  vec3,
  vec4,
  uniform,
  screenUV,
  screenSize,
  screenCoordinate,
  time,
  mix,
  clamp,
  smoothstep,
  luminance,
  saturation,
  getViewPosition,
  unpackRGBToNormal,
  renderOutput
} from "three/tsl";
import { tunables } from "../core/persist";
import type { RadialLightParams } from "./radialLightTypes";

/**
 * Stylized post effects, all OFF by default, toggled in the "/" panel's
 * "post fx" folder. Each stylized effect is an independent per-pixel stage so
 * they stack:
 *
 *  - ink & wash: pen outlines from the outline prepass's normals + depth, plus a
 *    soft luminance posterize — storybook illustration.
 *  - dream haze: halation blur + radial color fringe in linear light, then a
 *    pastel lift, gentle vignette and fine animated grain — hazy memory.
 *  - retro crt: virtual pixel grid, Bayer-dithered color quantize and
 *    scanline shading — the handheld-that-never-existed.
 *  - FXAA: an optional final display-space edge cleanup owned by pipeline.ts.
 *
 * Everything runs AFTER tone mapping (the pipeline hands us display-referred
 * sRGB via renderOutput), so quantize/grain/vignette work on the 0..1 image
 * the eye actually sees. Toggles select one of eight cached shader graphs;
 * sliders are uniforms and live-update for free. No If() anywhere: build-time
 * JS branches only, so the mx_noise branch-corruption hazard never applies.
 */
export const POSTFX_TUNING = tunables("postfx", {
  fxaa: { v: false, label: "FXAA" },
  ink: { v: false, label: "ink & wash" },
  inkStrength: { v: 0.65, min: 0, max: 1, step: 0.05, label: "· ink strength" },
  inkWidth: { v: 1.5, min: 1, max: 4, step: 0.5, label: "· line width (px)" },
  dream: { v: false, label: "dream haze" },
  dreamAmount: { v: 0.55, min: 0, max: 1, step: 0.05, label: "· haze" },
  dreamFringe: { v: 0.5, min: 0, max: 1, step: 0.05, label: "· color fringe" },
  retro: { v: false, label: "retro crt" },
  retroPixel: { v: 3, min: 1, max: 8, step: 1, label: "· pixel size" },
  retroLevels: { v: 6, min: 2, max: 10, step: 1, label: "· color steps" },
  retroScan: { v: 0.35, min: 0, max: 1, step: 0.05, label: "· scanlines" },
  museumRays: { v: true, label: "museum · stained-glass rays" },
  museumRaysIntensity: { v: 0.62, min: 0, max: 1.5, step: 0.02, label: "museum · ray strength" },
  museumRaysWeight: { v: 0.9, min: 0, max: 1, step: 0.01, label: "museum · sample weight" },
  museumRaysDecay: { v: 0.96, min: 0.85, max: 1, step: 0.005, label: "museum · decay" },
  museumRaysSamples: { v: 32, min: 16, max: 48, step: 1, label: "museum · samples" },
  museumRaysExposure: { v: 5.5, min: 1, max: 10, step: 0.1, label: "museum · exposure" },
  museumRaysResolution: {
    v: 0.5,
    options: { "⅓ resolution": 0.35, "½ resolution": 0.5, "¾ resolution": 0.75 },
    label: "museum · source quality"
  }
});

/** Toggles that require a pipeline selection/update (everything else is a live uniform). */
export const POSTFX_TOGGLES = ["fxaa", "ink", "dream", "retro"] as const;
export const POSTFX_RADIAL_LIGHT_KEYS = [
  "museumRays",
  "museumRaysIntensity",
  "museumRaysWeight",
  "museumRaysDecay",
  "museumRaysSamples",
  "museumRaysExposure",
  "museumRaysResolution"
] as const;

export function getRadialLightParams(): RadialLightParams {
  const v = POSTFX_TUNING.values;
  return {
    intensity: v.museumRaysIntensity,
    weight: v.museumRaysWeight,
    decay: v.museumRaysDecay,
    sampleCount: v.museumRaysSamples,
    exposure: v.museumRaysExposure,
    resolutionScale: v.museumRaysResolution
  };
}

const POSTFX_INK = 1 << 0;
const POSTFX_DREAM = 1 << 1;
const POSTFX_RETRO = 1 << 2;
const POSTFX_ALL = POSTFX_INK | POSTFX_DREAM | POSTFX_RETRO;

/** All specialized graph variants, ordered by their ink/dream/retro bit mask. */
export const POSTFX_VARIANT_MASKS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

/** Return the cached-variant mask selected by the live tweak values. */
export function getPostFxVariantMask() {
  const v = POSTFX_TUNING.values;
  return (v.ink ? POSTFX_INK : 0) | (v.dream ? POSTFX_DREAM : 0) | (v.retro ? POSTFX_RETRO : 0);
}

const U = {
  inkStrength: uniform(POSTFX_TUNING.values.inkStrength),
  inkWidth: uniform(POSTFX_TUNING.values.inkWidth),
  dreamAmount: uniform(POSTFX_TUNING.values.dreamAmount),
  dreamFringe: uniform(POSTFX_TUNING.values.dreamFringe),
  retroPixel: uniform(POSTFX_TUNING.values.retroPixel),
  retroLevels: uniform(POSTFX_TUNING.values.retroLevels),
  retroScan: uniform(POSTFX_TUNING.values.retroScan),
  // Runtime-only surf flow state. These are intentionally not persisted or
  // exposed in Tweakpane: gameplay owns the envelope and every cached post-FX
  // graph reads the same uniforms without recompilation.
  flowAmount: uniform(0),
  flowPhase: uniform(0)
};

export function setFlowPostFx(amount: number, phase: number) {
  U.flowAmount.value = Math.min(1, Math.max(0, amount));
  U.flowPhase.value = Number.isFinite(phase) ? phase : 0;
}

/** Push the pane's slider values into the live uniforms. */
export function applyPostFxParams() {
  const v = POSTFX_TUNING.values;
  U.inkStrength.value = v.inkStrength;
  U.inkWidth.value = v.inkWidth;
  U.dreamAmount.value = v.dreamAmount;
  U.dreamFringe.value = v.dreamFringe;
  U.retroPixel.value = v.retroPixel;
  U.retroLevels.value = v.retroLevels;
  U.retroScan.value = v.retroScan;
}

// compact analytic 4x4 Bayer matrix (no arrays/If — pure float math)
const bayer2 = (a: any) => {
  const f = a.floor();
  return f.x.mul(0.5).add(f.y.mul(f.y).mul(0.75)).fract();
};
const bayer4 = (a: any) => bayer2(a.mul(0.5)).mul(0.25).add(bayer2(a));

// classic screen-space hash, re-seeded per frame for living grain
const grainNoise = (p: any) =>
  p.dot(vec2(127.1, 311.7)).add(time.fract().mul(43.7)).sin().mul(43758.5453).fract();

export function createPostFx(deps: {
  /** lit scene pass texture (linear HDR) */
  sceneTex: any;
  /** outline prepass packed-normal texture (half-res is fine for outlines) */
  normalTex: any;
  /** outline prepass depth texture */
  depthTex: any;
  camera: THREE.Camera;
  /** Optional deterministic contact factor sampled in the same UV space. */
  contactFactorAt?: (uv: any) => any;
}) {
  const { sceneTex, normalTex, depthTex, camera, contactFactorAt } = deps;

  // object-reference uniform: uploads the camera's current inverse projection
  // every frame, reversed-z included
  const projInv = uniform(camera.projectionMatrixInverse);

  const normalAt = (uv: any) => unpackRGBToNormal(normalTex.sample(uv)).normalize();
  const viewZAt = (uv: any) => getViewPosition(uv, depthTex.sample(uv).r, projInv).z;

  const variants = new Map<number, any>();

  /** Build one immutable specialization. The public getter retains the result. */
  const build = (mask: number, surfaceLightAt?: (uv: any) => any) => {
    const ink = (mask & POSTFX_INK) !== 0;
    const dream = (mask & POSTFX_DREAM) !== 0;
    const retro = (mask & POSTFX_RETRO) !== 0;

    return Fn(() => {
      // retro quantizes the sample position onto a virtual pixel grid; every
      // later stage reads through the same uv so the effects stay coherent
      const grid = screenSize.div(U.retroPixel);
      const cell = screenUV.mul(grid).floor();
      const uv = retro ? cell.add(0.5).div(grid) : screenUV;
      // Cozy flow-state lens: one warped scene lookup, even in the default
      // zero-effect graph. At amount=0 this is exactly the original UV, so the
      // inactive cost is arithmetic only—not additional texture taps.
      const flowCentre = screenUV.sub(0.5).toVar();
      const flowDist = flowCentre.length().toVar();
      const flowFall = smoothstep(0.08, 0.78, flowDist).oneMinus();
      const flowRipple = flowDist
        .mul(35)
        .sub(U.flowPhase.mul(5.2))
        .sin()
        .mul(flowFall)
        .mul(U.flowAmount);
      const flowTangent = vec2(flowCentre.y.negate(), flowCentre.x);
      const sampleUv = uv
        .add(flowTangent.mul(flowRipple.mul(0.008)))
        .sub(flowCentre.mul(flowFall).mul(U.flowAmount).mul(0.006));

      // ---- linear-light stage: scene taps (+ dream's halation & fringe)
      let lin: any;
      if (dream) {
        // radial color fringe: R/B pulled apart along the from-center axis
        const off = screenUV.sub(0.5).mul(U.dreamFringe.mul(0.0035));
        const center = sceneTex.sample(sampleUv);
        const ca = vec3(sceneTex.sample(sampleUv.add(off)).r, center.g, sceneTex.sample(sampleUv.sub(off)).b);
        // 4-tap diagonal halation, blended in linear light so highlights glow
        const d = vec2(2.5).div(screenSize);
        const blur = sceneTex
          .sample(sampleUv.add(d))
          .rgb.add(sceneTex.sample(sampleUv.sub(d)).rgb)
          .add(sceneTex.sample(sampleUv.add(vec2(d.x, d.y.negate()))).rgb)
          .add(sceneTex.sample(sampleUv.add(vec2(d.x.negate(), d.y))).rgb)
          .mul(0.25);
        lin = mix(ca, blur, U.dreamAmount.mul(0.5));
      } else {
        lin = sceneTex.sample(sampleUv).rgb;
      }
      if (contactFactorAt) lin = lin.mul(contactFactorAt(uv));
      // Optional close-range surface lighting is still linear HDR here. Add it
      // before renderOutput so it follows the exact same tone mapping and
      // stylized grading as the road/sidewalk pixels beneath it.
      if (surfaceLightAt) lin = lin.add(surfaceLightAt(sampleUv));

      const c = renderOutput(vec4(lin, 1)).rgb.toVar();

      // ---- ink & wash: outlines where the prepass normals/depth jump
      if (ink) {
        const w = U.inkWidth.div(screenSize);
        const ox = vec2(w.x, 0);
        const oy = vec2(0, w.y);
        const nEdge = normalAt(uv.sub(ox))
          .dot(normalAt(uv.add(ox)))
          .oneMinus()
          .add(normalAt(uv.sub(oy)).dot(normalAt(uv.add(oy))).oneMinus());
        const zJump = viewZAt(uv.sub(ox))
          .sub(viewZAt(uv.add(ox)))
          .abs()
          .add(viewZAt(uv.sub(oy)).sub(viewZAt(uv.add(oy))).abs());
        // depth term is relative so distant façades don't dissolve into ink
        const zC = viewZAt(uv).abs();
        const dEdge = smoothstep(1.0, 2.0, zJump.div(zC.mul(0.04).add(0.35)));
        // fade lines out with distance: past ~1.5km every rooftop is sub-pixel
        // and the horizon turns to solid stipple (mix-based fade — no branches)
        const fade = smoothstep(700.0, 2200.0, zC).oneMinus();
        const edge = clamp(smoothstep(0.15, 0.5, nEdge).add(dEdge), 0.0, 1.0).mul(fade);
        c.mulAssign(mix(vec3(1.0), vec3(0.16, 0.12, 0.1), edge.mul(U.inkStrength)));
        // soft luminance posterize — flat "wash" fills between the lines
        const lum = luminance(c).max(1e-4);
        const t6 = lum.mul(6.0);
        const ql = t6.floor().add(smoothstep(0.3, 0.7, t6.fract())).div(6.0);
        c.assign(mix(c, c.mul(ql.div(lum)), 0.5));
      }

      // ---- dream haze grade: pastel lift, gentle vignette, living grain
      if (dream) {
        const a = U.dreamAmount;
        c.assign(mix(c, c.mul(vec3(1.05, 0.97, 0.92)).add(vec3(0.05, 0.045, 0.085)), a));
        c.assign(saturation(c, float(1).sub(a.mul(0.2))));
        const dist = screenUV.sub(0.5).length().mul(1.4142);
        c.mulAssign(float(1).sub(smoothstep(0.55, 1.15, dist).mul(a).mul(0.35)));
        c.addAssign(grainNoise(screenCoordinate.xy.floor()).sub(0.5).mul(a).mul(0.045));
      }

      // Sea-glass tri-tone, pearlescent caustic ring and a warm sun flash.
      // Presentation time stays unscaled while only the local rider slows.
      const flow = U.flowAmount;
      const flowGrade = c
        .mul(vec3(0.9, 1.075, 1.045))
        .add(vec3(0.025, 0.045, 0.032));
      c.assign(mix(c, flowGrade, flow.mul(0.78)));
      c.assign(saturation(c, float(1).add(flow.mul(0.14))));
      const ringRadius = U.flowPhase.mul(0.11).fract().mul(0.72).add(0.08);
      const pearlRing = smoothstep(0.0, 0.065, flowDist.sub(ringRadius).abs())
        .oneMinus()
        .mul(flowFall)
        .mul(flow);
      c.addAssign(vec3(0.2, 0.88, 0.72).mul(pearlRing).mul(0.17));
      const sunPulse = U.flowPhase.mul(2.3).sin().mul(0.5).add(0.5).pow(5).mul(flow);
      c.addAssign(vec3(1.0, 0.52, 0.22).mul(sunPulse).mul(0.045));

      // ---- retro crt: dithered quantize on the virtual grid + scanlines
      if (retro) {
        c.assign(saturation(c, 1.12)); // small candy pop before the palette snaps
        const levels = U.retroLevels.sub(1).max(1);
        // 0.7 dither span: full-strength Bayer turns flat lawns into rainbow
        // static; backing off keeps the crosshatch without the dirt
        c.assign(c.clamp(0.0, 1.0).mul(levels).add(bayer4(cell).mul(0.7).add(0.15)).floor().div(levels));
        const fy = screenUV.y.mul(grid.y).fract();
        c.mulAssign(float(1).sub(fy.sub(0.5).abs().mul(2.0).pow(2.5).mul(U.retroScan)));
      }

      return vec4(c, 1.0);
    })();
  };

  /** Return a stable node graph for a toggle mask, building it only once. */
  const get = (requestedMask = getPostFxVariantMask()) => {
    const mask = requestedMask & POSTFX_ALL;
    let variant = variants.get(mask);
    if (variant === undefined) {
      variant = build(mask);
      variants.set(mask, variant);
    }
    return variant;
  };

  /** Build a light-aware specialization; the owning lazy runtime caches it. */
  const getWithSurfaceLight = (
    requestedMask: number,
    surfaceLightAt: (uv: any) => any
  ) => build(requestedMask & POSTFX_ALL, surfaceLightAt);

  return { get, getWithSurfaceLight };
}
