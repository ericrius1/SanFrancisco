import * as THREE from "three/webgpu";
import { color, mix as mixRaw, saturate, smoothstep as smoothstepRaw } from "three/tsl";

/**
 * One ramp, two evaluators.
 *
 * The prism kite puts the same spectrum in four places — across the cloth, out
 * along the dispersed fan, lying on the sand under it, and reflected in the sea
 * (waterShadingTSL's prism lobe) — and they have to be the same spectrum or the
 * effect stops reading as one piece of light. The sail and the sea evaluate it
 * per pixel in TSL; the fan and the sand bake it into vertex colours on the
 * CPU. So the stops live here and no consumer owns them.
 *
 * WHY THIS FILE IS NOT IN `oceanBeachKite/`, where the rest of the prism lives:
 * the water's shader graph is built at BOOT, so importing the ramp from the
 * kite directory made the boot bundle reach into a lazily-loaded feature — and
 * `tools/ocean-beach-kite-probe.mjs`'s `boot-no-kite-runtime-request` check
 * failed on exactly that, which is the massive-app loading policy doing its
 * job. A shared primitive that boot-time code needs has to sit outside the
 * feature that happens to have introduced it.
 *
 * The band is deliberately NOT a hue sweep. A linear trip round HSV spends a
 * third of itself in cyans nobody associates with a prism and comes back to red
 * at the far end; these seven stops are the sleeve's own ramp, red through
 * violet, with no wrap.
 */
const STOPS: readonly { at: number; hex: number }[] = [
  { at: 0, hex: 0xff2d2d },
  { at: 0.2, hex: 0xff8a1f },
  { at: 0.38, hex: 0xffe14a },
  { at: 0.56, hex: 0x46e06a },
  { at: 0.74, hex: 0x2fa8ff },
  { at: 0.88, hex: 0x4a4dff },
  { at: 1, hex: 0xa63cff }
];

// TSL node generics fight composition; `any` is the idiom here (see facade.ts).
type N = any;
const mix = mixRaw as (...a: N[]) => N;
const smoothstep = smoothstepRaw as (...a: N[]) => N;

/**
 * Red at 0, violet at 1, as a TSL colour node. Successive mixes each hand over
 * completely by their own stop, so the chain is a gradient rather than a blur
 * of all seven.
 */
export function spectrum(t: N): N {
  const u = saturate(t);
  let ramp = color(STOPS[0].hex) as N;
  for (let i = 1; i < STOPS.length; i++) {
    ramp = mix(ramp, color(STOPS[i].hex), smoothstep(STOPS[i - 1].at, STOPS[i].at, u));
  }
  return ramp;
}

const _a = new THREE.Color();
const _b = new THREE.Color();

/** The same ramp on the CPU, for baking into a vertex colour attribute. */
export function spectrumColor(t: number, out = new THREE.Color()): THREE.Color {
  const u = THREE.MathUtils.clamp(t, 0, 1);
  out.setHex(STOPS[0].hex, THREE.SRGBColorSpace);
  for (let i = 1; i < STOPS.length; i++) {
    const w = THREE.MathUtils.smoothstep(u, STOPS[i - 1].at, STOPS[i].at);
    if (w <= 0) break;
    _a.copy(out);
    _b.setHex(STOPS[i].hex, THREE.SRGBColorSpace);
    out.copy(_a).lerp(_b, w);
  }
  return out;
}
