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

/**
 * Stylized post effects, all OFF by default, toggled in the "/" panel's
 * "post fx" folder. Quality controls above them steer the render pipeline's
 * scene AA and SSAO passes; each stylized effect is an independent per-pixel
 * stage so they stack:
 *
 *  - ink & wash: pen outlines from the AO prepass's normals + depth, plus a
 *    soft luminance posterize — storybook illustration.
 *  - dream haze: halation blur + radial color fringe in linear light, then a
 *    pastel lift, gentle vignette and fine animated grain — hazy memory.
 *  - retro crt: virtual pixel grid, Bayer-dithered color quantize and
 *    scanline shading — the handheld-that-never-existed.
 *
 * Everything runs AFTER tone mapping (the pipeline hands us display-referred
 * sRGB via renderOutput), so quantize/grain/vignette work on the 0..1 image
 * the eye actually sees. Toggles specialize the output shader (rebuild via
 * applyPostFx — a single fullscreen quad recompile); sliders are uniforms and
 * live-update for free. No If() anywhere: build-time JS branches only, so the
 * mx_noise branch-corruption hazard never applies.
 */
export const POSTFX_TUNING = tunables("postfx", {
  sceneSamples: {
    v: 2,
    min: 0,
    max: 4,
    step: 1,
    label: "scene AA samples"
  },
  ssao: { v: true, label: "SSAO" },
  ssaoScale: { v: 0.5, min: 0.35, max: 1, step: 0.05, label: "· SSAO scale" },
  ssaoSamples: { v: 4, min: 2, max: 12, step: 1, label: "· SSAO samples" },
  ssaoRadius: { v: 1.35, min: 0.5, max: 3, step: 0.05, label: "· SSAO radius" },
  ssaoIntensity: { v: 3.2, min: 0, max: 6, step: 0.1, label: "· SSAO intensity" },
  ink: { v: false, label: "ink & wash" },
  inkStrength: { v: 0.65, min: 0, max: 1, step: 0.05, label: "· ink strength" },
  inkWidth: { v: 1.5, min: 1, max: 4, step: 0.5, label: "· line width (px)" },
  dream: { v: false, label: "dream haze" },
  dreamAmount: { v: 0.55, min: 0, max: 1, step: 0.05, label: "· haze" },
  dreamFringe: { v: 0.5, min: 0, max: 1, step: 0.05, label: "· color fringe" },
  retro: { v: false, label: "retro crt" },
  retroPixel: { v: 3, min: 1, max: 8, step: 1, label: "· pixel size" },
  retroLevels: { v: 6, min: 2, max: 10, step: 1, label: "· color steps" },
  retroScan: { v: 0.35, min: 0, max: 1, step: 0.05, label: "· scanlines" }
});

/** The keys that change the shader itself (everything else is a live uniform). */
export const POSTFX_TOGGLES = ["ink", "dream", "retro"] as const;
export const POSTFX_QUALITY_KEYS = ["sceneSamples", "ssao", "ssaoScale", "ssaoSamples", "ssaoRadius", "ssaoIntensity"] as const;

const U = {
  inkStrength: uniform(POSTFX_TUNING.values.inkStrength),
  inkWidth: uniform(POSTFX_TUNING.values.inkWidth),
  dreamAmount: uniform(POSTFX_TUNING.values.dreamAmount),
  dreamFringe: uniform(POSTFX_TUNING.values.dreamFringe),
  retroPixel: uniform(POSTFX_TUNING.values.retroPixel),
  retroLevels: uniform(POSTFX_TUNING.values.retroLevels),
  retroScan: uniform(POSTFX_TUNING.values.retroScan)
};

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
  /** AO prepass packed-normal texture (half-res is fine for outlines) */
  normalTex: any;
  /** AO prepass depth texture */
  depthTex: any;
  camera: THREE.Camera;
}) {
  const { sceneTex, normalTex, depthTex, camera } = deps;

  // object-reference uniform: uploads the camera's current inverse projection
  // every frame, reversed-z included (same trick as the vendored SSAO)
  const projInv = uniform(camera.projectionMatrixInverse);

  const normalAt = (uv: any) => unpackRGBToNormal(normalTex.sample(uv)).normalize();
  const viewZAt = (uv: any) => getViewPosition(uv, depthTex.sample(uv).r, projInv).z;

  /** Build the output node for the current toggle set (call on toggle change). */
  const build = () => {
    const on = POSTFX_TUNING.values;

    return Fn(() => {
      // retro quantizes the sample position onto a virtual pixel grid; every
      // later stage reads through the same uv so the effects stay coherent
      const grid = screenSize.div(U.retroPixel);
      const cell = screenUV.mul(grid).floor();
      const uv = on.retro ? cell.add(0.5).div(grid) : screenUV;

      // ---- linear-light stage: scene taps (+ dream's halation & fringe)
      let lin: any;
      if (on.dream) {
        // radial color fringe: R/B pulled apart along the from-center axis
        const off = screenUV.sub(0.5).mul(U.dreamFringe.mul(0.0035));
        const center = sceneTex.sample(uv);
        const ca = vec3(sceneTex.sample(uv.add(off)).r, center.g, sceneTex.sample(uv.sub(off)).b);
        // 4-tap diagonal halation, blended in linear light so highlights glow
        const d = vec2(2.5).div(screenSize);
        const blur = sceneTex
          .sample(uv.add(d))
          .rgb.add(sceneTex.sample(uv.sub(d)).rgb)
          .add(sceneTex.sample(uv.add(vec2(d.x, d.y.negate()))).rgb)
          .add(sceneTex.sample(uv.add(vec2(d.x.negate(), d.y))).rgb)
          .mul(0.25);
        lin = mix(ca, blur, U.dreamAmount.mul(0.5));
      } else {
        lin = sceneTex.sample(uv).rgb;
      }

      const c = renderOutput(vec4(lin, 1)).rgb.toVar();

      // ---- ink & wash: outlines where the prepass normals/depth jump
      if (on.ink) {
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
      if (on.dream) {
        const a = U.dreamAmount;
        c.assign(mix(c, c.mul(vec3(1.05, 0.97, 0.92)).add(vec3(0.05, 0.045, 0.085)), a));
        c.assign(saturation(c, float(1).sub(a.mul(0.2))));
        const dist = screenUV.sub(0.5).length().mul(1.4142);
        c.mulAssign(float(1).sub(smoothstep(0.55, 1.15, dist).mul(a).mul(0.35)));
        c.addAssign(grainNoise(screenCoordinate.xy.floor()).sub(0.5).mul(a).mul(0.045));
      }

      // ---- retro crt: dithered quantize on the virtual grid + scanlines
      if (on.retro) {
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

  return { build };
}
