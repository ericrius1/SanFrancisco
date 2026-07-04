import * as THREE from "three/webgpu";
import {
  PI2,
  abs,
  atan,
  cameraPosition,
  color,
  cos,
  float,
  floor,
  fract,
  mix,
  mx_fractal_noise_float,
  normalWorldGeometry,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { tunables } from "../core/persist";

// TSL node generics fight composition; any is the idiom here (see facade.ts)
type N = any;

/** Live-tunable overall brightness of the crown display ("/" panel friendly). */
export const CROWN_INTENSITY = uniform(6 * LIGHT_SCALE);

/** The display's own clock, advanced by updateCrownDisplay and frozen by pause. */
export const CROWN_TIME = uniform(0);

/**
 * Current Salesforce crown artwork controls. This uses a fresh persistence path
 * so old photo/gallery/fire settings are ignored instead of migrated.
 */
export const CROWN_SLIDERS = tunables("crownGradient", {
  cols: { v: 520, min: 32, max: 900, step: 1, label: "LED columns" },
  rows: { v: 360, min: 16, max: 720, step: 1, label: "LED rows" },
  dotCore: { v: 0.34, min: 0.08, max: 0.48, step: 0.01, label: "dot size" },
  brightness: { v: 0.82, min: 0.15, max: 1.5, step: 0.025, label: "brightness x" },
  saturation: { v: 0.78, min: 0, max: 1.25, step: 0.025, label: "saturation" },
  motion: { v: 0.62, min: 0, max: 1.2, step: 0.025, label: "motion" }
});

export const CROWN_TUNING = {
  cols: uniform(CROWN_SLIDERS.values.cols),
  rows: uniform(CROWN_SLIDERS.values.rows),
  dotCore: uniform(CROWN_SLIDERS.values.dotCore),
  brightness: uniform(CROWN_SLIDERS.values.brightness),
  saturation: uniform(CROWN_SLIDERS.values.saturation),
  motion: uniform(CROWN_SLIDERS.values.motion)
};

/** "." factory reset: slider uniforms back to the current source defaults. */
export function resetCrownTweaks() {
  for (const k in CROWN_TUNING) {
    const key = k as keyof typeof CROWN_TUNING;
    CROWN_TUNING[key].value = CROWN_SLIDERS.values[key];
  }
}

export function updateCrownDisplay(dt: number) {
  CROWN_TIME.value += dt;
}

/**
 * The Salesforce Tower crown display: one seamless, slowly evolving gradient
 * piece, sampled through the tower's cylindrical coordinates and shown on the
 * LED lattice. The palette stays deliberately restrained: bay teal, blue-gray,
 * muted lilac, dusty rose, and a soft pearl highlight.
 */
export function createCrownMaterial(bbox: THREE.Box3): THREE.MeshStandardNodeMaterial {
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;
  const yMin = bbox.min.y;
  const ySpan = Math.max(1e-3, bbox.max.y - bbox.min.y);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.48, metalness: 0.08 });
  mat.colorNode = color(0x46535d);

  const wp = positionWorld;
  const ang = atan(wp.z.sub(cz), wp.x.sub(cx)) as N;
  const u = ang.div(PI2).add(0.5);
  const v = wp.y.sub(yMin).div(ySpan);

  const cols = CROWN_TUNING.cols as N;
  const rows = CROWN_TUNING.rows as N;
  const uq = floor(u.mul(cols)).add(0.5).div(cols);
  const vq = floor(v.mul(rows)).add(0.5).div(rows);

  const gradientArt = (su: N, sv: N): N => {
    const t = (CROWN_TIME as N).mul(CROWN_TUNING.motion as N);
    const a = su.sub(0.5).mul(PI2);

    const vertical = smoothstep(0.02, 0.98, sv);
    const lower = smoothstep(0.94, 0.08, sv);
    const upper = smoothstep(0.24, 0.94, sv);
    const midBand = smoothstep(0.12, 0.62, sv).mul(smoothstep(1.04, 0.58, sv));

    const slowA = t.mul(0.036);
    const slowB = t.mul(0.024);
    const fieldA = mx_fractal_noise_float(
      vec3(cos(a.add(slowA)).mul(0.92), sin(a.add(slowA)).mul(0.92), sv.mul(1.55).sub(t.mul(0.018))),
      4
    )
      .mul(0.5)
      .add(0.5);
    const fieldB = mx_fractal_noise_float(
      vec3(cos(a.sub(slowB)).mul(1.35), sin(a.sub(slowB)).mul(1.35), sv.mul(2.15).add(t.mul(0.012))),
      3
    )
      .mul(0.5)
      .add(0.5);
    const ribbon = sin(a.mul(1.7).add(sv.mul(5.4)).add(t.mul(0.052))).mul(0.5).add(0.5);
    const veil = sin(a.sub(t.mul(0.026)).mul(2.3).sub(sv.mul(3.8))).mul(0.5).add(0.5);

    const base = mix(vec3(0.055, 0.115, 0.15), vec3(0.2, 0.27, 0.36), vertical);
    const bay = vec3(0.15, 0.34, 0.37);
    const lilac = vec3(0.36, 0.33, 0.5);
    const rose = vec3(0.56, 0.4, 0.37);
    const pearl = vec3(0.72, 0.68, 0.56);

    let art: N = mix(base, bay, fieldA.mul(0.38).mul(lower));
    art = mix(art, lilac, ribbon.mul(0.28).mul(upper));
    art = mix(art, rose, fieldB.mul(0.24).mul(midBand));

    const pearlWash = smoothstep(0.54, 0.98, fieldA.mul(0.52).add(fieldB.mul(0.3)).add(veil.mul(0.18))).mul(midBand);
    const breathing = mix(float(0.84), float(1.06), fieldB.mul(0.55).add(ribbon.mul(0.45)));
    const edgeFade = smoothstep(0.0, 0.08, sv).mul(smoothstep(1.0, 0.82, sv));
    return art.add(pearl.mul(pearlWash).mul(0.18)).mul(breathing).mul(edgeFade).mul(0.95);
  };

  const art = gradientArt(uq, vq);

  // Round LED dots up close; at distance they merge into a smoother video panel.
  const cellUV = vec2(fract(u.mul(cols)) as N, fract(v.mul(rows)) as N).sub(0.5);
  const dot = smoothstep(0.5, CROWN_TUNING.dotCore as N, cellUV.length());
  const dist = wp.distance(cameraPosition);
  const led = mix(dot, float(0.84), smoothstep(250, 650, dist));

  const luma = art.r.mul(0.2126).add(art.g.mul(0.7152)).add(art.b.mul(0.0722));
  const graded = mix(vec3(luma), art, CROWN_TUNING.saturation as N).max(0.0);

  // Display band: wall faces only, faded off at the crown lip and sculpted tip.
  const band = smoothstep(0.02, 0.09, v).mul(smoothstep(1.0, 0.86, v));
  const wall = smoothstep(0.62, 0.4, abs(normalWorldGeometry.y));

  mat.emissiveNode = graded
    .mul(led)
    .mul(band)
    .mul(wall)
    .mul(CROWN_INTENSITY)
    .mul(CROWN_TUNING.brightness);
  return mat;
}
