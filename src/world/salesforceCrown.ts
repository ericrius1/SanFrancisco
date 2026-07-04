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
 * so old gradient/photo/gallery settings are ignored instead of migrated.
 */
export const CROWN_SLIDERS = tunables("crownRipple", {
  cols: { v: 520, min: 32, max: 900, step: 1, label: "LED columns" },
  rows: { v: 360, min: 16, max: 720, step: 1, label: "LED rows" },
  dotCore: { v: 0.34, min: 0.08, max: 0.48, step: 0.01, label: "dot size" },
  brightness: { v: 0.92, min: 0.15, max: 1.5, step: 0.025, label: "brightness x" },
  saturation: { v: 0.9, min: 0, max: 1.25, step: 0.025, label: "saturation" },
  motion: { v: 0.7, min: 0, max: 1.2, step: 0.025, label: "motion" }
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

// Interference sources: [angle 0..1, height 0..1, ring frequency, ripple speed,
// amplitude, drift rate]. Their centres wander over time so the overlapping
// wavefronts never settle — the moiré keeps breathing like water.
const RIPPLE_SOURCES: [number, number, number, number, number, number][] = [
  [0.2, 0.34, 3.3, 0.9, 1.0, 0.17],
  [0.61, 0.7, 4.0, 1.2, 0.9, -0.12],
  [0.85, 0.22, 2.8, 0.72, 1.1, 0.22],
  [0.44, 0.88, 3.6, 1.05, 0.82, -0.19],
  [0.06, 0.55, 4.5, 1.35, 0.86, 0.13]
];
const ANG_SCALE = 3.0; // horizontal (around the tower) wave stretch
const V_SCALE = 7.0; //   vertical wave stretch — bigger = denser rings up the face

/**
 * The Salesforce Tower crown display: a flowing red / white / blue ripple field.
 * Several circular wavefronts drift across the cylinder and interfere, exactly
 * like overlapping raindrops on water. The interference height is remapped to a
 * patriotic palette — deep blue in the troughs, pearl white through the middle,
 * crimson on the crests — and shown on the LED lattice.
 */
export function createCrownMaterial(bbox: THREE.Box3): THREE.MeshStandardNodeMaterial {
  const cx = (bbox.min.x + bbox.max.x) / 2;
  const cz = (bbox.min.z + bbox.max.z) / 2;
  const yMin = bbox.min.y;
  const ySpan = Math.max(1e-3, bbox.max.y - bbox.min.y);

  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.48, metalness: 0.08 });
  mat.colorNode = color(0x2a3038);

  const wp = positionWorld;
  const ang = atan(wp.z.sub(cz), wp.x.sub(cx)) as N;
  const u = ang.div(PI2).add(0.5);
  const v = wp.y.sub(yMin).div(ySpan);

  const cols = CROWN_TUNING.cols as N;
  const rows = CROWN_TUNING.rows as N;
  const uq = floor(u.mul(cols)).add(0.5).div(cols);
  const vq = floor(v.mul(rows)).add(0.5).div(rows);

  const rippleArt = (su: N, sv: N): N => {
    const t = (CROWN_TIME as N).mul(CROWN_TUNING.motion as N);
    const a = su.mul(PI2); // 0..2π around the tower

    // Sum the drifting wavefronts. Angular distance is wrapped through atan2 so
    // the pattern is seamless across the u=0/1 join.
    let field: N = float(0);
    let ampSum = 0;
    for (const [a0, v0, freq, sp, amp, drift] of RIPPLE_SOURCES) {
      const srcA = float(a0 * Math.PI * 2).add(sin(t.mul(drift)).mul(0.6));
      const srcV = float(v0).add(sin(t.mul(drift * 1.4).add(a0 * 7)).mul(0.09));
      const da = a.sub(srcA);
      const wrapped = atan(sin(da), cos(da)); // -π..π shortest angular gap
      const dx = wrapped.mul(ANG_SCALE);
      const dy = sv.sub(srcV).mul(V_SCALE);
      const d = vec2(dx, dy).length();
      field = field.add(sin(d.mul(freq).sub(t.mul(sp))).mul(amp));
      ampSum += amp;
    }

    // Normalise to 0..1, add a faint fine shimmer, then crisp the bands.
    let f: N = field.div(ampSum).mul(0.5).add(0.5);
    f = f.add(sin(a.mul(26).add(sv.mul(58)).sub(t.mul(2.1))).mul(0.028));
    f = smoothstep(0.12, 0.88, f);

    // Bold blue on one side, bold red on the other, white kept to a thin crest
    // at the interference peaks so the palette reads clearly patriotic.
    const blue = vec3(0.04, 0.16, 0.85);
    const white = vec3(0.95, 0.96, 1.0);
    const red = vec3(0.9, 0.06, 0.11);
    let col: N = mix(blue, white, smoothstep(0.3, 0.5, f));
    col = mix(col, red, smoothstep(0.5, 0.7, f));

    // Gentle brightness breathing + soft fade at the very top and bottom lips.
    const breathing = mix(float(0.86), float(1.12), f);
    const edgeFade = smoothstep(0.0, 0.07, sv).mul(smoothstep(1.0, 0.9, sv));
    return col.mul(breathing).mul(edgeFade);
  };

  const art = rippleArt(uq, vq);

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
