import * as THREE from "three/webgpu";
import {
  cameraPosition,
  float,
  instancedArray,
  instanceIndex,
  mix,
  saturate,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { tunables } from "../core/persist";
import type { WorldMap } from "./heightmap";

// TSL node generics fight composition; any is the idiom here (see facade.ts)
type N = any;

/** Sky-driven overall brightness, rewritten every frame like CROWN_INTENSITY. */
export const BAY_LIGHTS_INTENSITY = uniform(2.2 * LIGHT_SCALE);

/** The installation's own clock, advanced by updateBayLights, frozen by pause. */
export const BAY_LIGHTS_TIME = uniform(0);

export const BAY_LIGHTS_SLIDERS = tunables("bayLights", {
  brightness: { v: 1.0, min: 0, max: 3, step: 0.05, label: "brightness x" },
  motion: { v: 1.0, min: 0, max: 4, step: 0.05, label: "motion" },
  size: { v: 1.0, min: 0.3, max: 3, step: 0.05, label: "bulb size" }
});

export const BAY_LIGHTS_TUNING = {
  brightness: uniform(BAY_LIGHTS_SLIDERS.values.brightness),
  motion: uniform(BAY_LIGHTS_SLIDERS.values.motion),
  size: uniform(BAY_LIGHTS_SLIDERS.values.size)
};

/** "." factory reset: slider uniforms back to the current source defaults. */
export function resetBayLightsTweaks() {
  for (const k in BAY_LIGHTS_TUNING) {
    const key = k as keyof typeof BAY_LIGHTS_TUNING;
    BAY_LIGHTS_TUNING[key].value = BAY_LIGHTS_SLIDERS.values[key];
  }
}

/**
 * Auto-cycling show: the piece rotates through MODE_COUNT looks, holding each
 * for MODE_HOLD seconds then crossfading over MODE_FADE. Blending happens on
 * the CPU via weight uniforms so the shader stays branch-free (TSL If() on
 * varying data corrupts branch-skipping pixels — mix/multiply only).
 */
const MODE_COUNT = 4;
const MODE_HOLD = 52;
const MODE_FADE = 8;
const MODE_W = [uniform(1), uniform(0), uniform(0), uniform(0)];

export function updateBayLights(dt: number) {
  BAY_LIGHTS_TIME.value += dt;
  const period = MODE_HOLD + MODE_FADE;
  const cycles = BAY_LIGHTS_TIME.value / period;
  const idx = Math.floor(cycles) % MODE_COUNT;
  const into = (cycles - Math.floor(cycles)) * period;
  const s = Math.min(Math.max((into - MODE_HOLD) / MODE_FADE, 0), 1);
  const f = s * s * (3 - 2 * s); // smoothstep so the handoff never snaps
  for (let i = 0; i < MODE_COUNT; i++) MODE_W[i].value = 0;
  MODE_W[idx].value = 1 - f;
  MODE_W[(idx + 1) % MODE_COUNT].value += f;
}

const TAU = Math.PI * 2;

const CABLE_SPACING = 3.2; // metres between bulbs along the main cables
const SUSPENDER_SPACING = 2.4; // metres between bulbs down a suspender

/**
 * The Bay Lights: LED strands strung along the Bay Bridge's main cables and
 * down every suspender, running a slow show that cycles through four looks
 * every minute or so — drifting aurora bands, rain running down the
 * suspenders, a breathing tide wash, and a quiet star field.
 *
 * Bulb placement re-derives the baked geometry's cable math (blender_city.py
 * build_suspension_bridge) from the same meta.json bridge def, so the strands
 * hug the rendered cables: parabolic "catenary" between anchor/tower nodes,
 * two cables offset width/2 + 1.5 off the centreline, suspenders at the
 * span/40 sample points.
 */
export function createBayLights(map: WorldMap): THREE.Sprite | null {
  const br = map.meta.bridges.find((b) => b.name === "Bay Bridge");
  if (!br) return null;

  const th = br.towerHeight;
  const line = br.line;
  const last = line[line.length - 1];
  // cable nodes in game frame (x, y-up, z): anchors sit 2m over the deck ends
  const nodes = [
    { x: line[0][0], y: line[0][2] + 2, z: line[0][1] },
    ...br.towers.map(([tx, tz]) => ({ x: tx, y: th, z: tz })),
    { x: last[0], y: last[2] + 2, z: last[1] }
  ];

  // two cables sit perpendicular to the overall anchor-to-anchor direction
  const dx = last[0] - line[0][0];
  const dz = last[1] - line[0][1];
  const dl = Math.hypot(dx, dz) || 1;
  const perpX = dz / dl;
  const perpZ = -dx / dl;
  const off = br.width / 2 + 1.5;

  // spans + cumulative length so the gradient parameter u runs 0..1 end to end
  const spans: { span: number; sag: number; u0: number; u1: number }[] = [];
  let total = 0;
  for (let k = 0; k < nodes.length - 1; k++) {
    const a = nodes[k];
    const b = nodes[k + 1];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const sag =
      a.y > 50 && b.y > 50 ? Math.max(6, span * 0.095) : Math.max(4, span * 0.05);
    spans.push({ span, sag, u0: total, u1: total + span });
    total += span;
  }

  // bulbs: pos.xyz + gradient param, then kind / height fraction / seed
  const posU: number[] = [];
  const info: number[] = [];
  const push = (x: number, y: number, z: number, u: number, kind: number, hf: number) => {
    posU.push(x, y, z, u);
    info.push(kind, hf, Math.random(), 0);
  };

  for (const sgn of [-1, 1]) {
    const ox = perpX * off * sgn;
    const oz = perpZ * off * sgn;
    for (let k = 0; k < spans.length; k++) {
      const a = nodes[k];
      const b = nodes[k + 1];
      const { span, sag, u0 } = spans[k];
      const at = (t: number) => ({
        x: a.x + (b.x - a.x) * t + ox,
        y: a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t),
        z: a.z + (b.z - a.z) * t + oz
      });

      // main cable strand
      const nCable = Math.max(2, Math.round(span / CABLE_SPACING));
      for (let i = 0; i <= nCable; i++) {
        if (i === nCable && k < spans.length - 1) continue; // next span owns the node
        const t = i / nCable;
        const p = at(t);
        push(p.x, p.y, p.z, (u0 + span * t) / total, 0, 1);
      }

      // suspender strands at the baked geometry's sample points
      const steps = Math.max(6, Math.floor(span / 40));
      for (let i = 1; i < steps; i++) {
        const t = i / steps;
        const p = at(t);
        const deck = map.bridgeDeck(p.x, p.z);
        if (!(deck > -Infinity) || p.y < deck + 4) continue;
        const top = p.y - 1.2;
        const bottom = deck + 1.4;
        const n = Math.floor((top - bottom) / SUSPENDER_SPACING);
        const u = (u0 + span * t) / total;
        for (let j = 0; j <= n; j++) {
          const y = bottom + j * SUSPENDER_SPACING;
          push(p.x, y, p.z, u, 1, (y - bottom) / Math.max(1e-3, top - bottom));
        }
      }
    }
  }

  const count = posU.length / 4;
  const ledPos = instancedArray(new Float32Array(posU), "vec4");
  const ledInfo = instancedArray(new Float32Array(info), "vec4");

  const material = new THREE.SpriteNodeMaterial();
  const led = ledPos.element(instanceIndex) as unknown as N;
  const data = ledInfo.element(instanceIndex) as unknown as N;
  const u = led.w;
  const kind = data.x; // 0 = main cable, 1 = suspender
  const hf = data.y; // height fraction up the suspender
  const seed = data.z;
  const T = (BAY_LIGHTS_TIME as N).mul(BAY_LIGHTS_TUNING.motion as N);

  material.positionNode = led.xyz;
  // bulbs hold presence across the bay: real size close up, gently distance-
  // compensated so the strands still read from the city waterfront
  const dist = led.xyz.distance(cameraPosition);
  material.scaleNode = dist.mul(0.008).clamp(1.2, 6.5).mul(BAY_LIGHTS_TUNING.size as N);

  // ---- mode 0: aurora — long colour bands sliding along the span, periods
  // mutually irrational so the piece never visibly repeats
  const w1 = sin(u.mul(TAU * 2.6).sub(T.mul(0.32))).mul(0.5).add(0.5);
  const w2 = sin(u.mul(TAU * 5.7).add(T.mul(0.21)).add(2.4)).mul(0.5).add(0.5);
  const w3 = sin(u.mul(TAU * 1.3).add(T.mul(0.14)).add(4.0)).mul(0.5).add(0.5);

  const indigo = vec3(0.04, 0.1, 0.38);
  const teal = vec3(0.05, 0.5, 0.52);
  const violet = vec3(0.36, 0.18, 0.58);
  const rose = vec3(0.68, 0.22, 0.35);
  const amber = vec3(0.85, 0.55, 0.22);

  let art: N = mix(indigo, teal, w1);
  art = mix(art, violet, w2.mul(0.55));
  art = mix(art, rose, w3.mul(w3).mul(0.45));
  // a narrow warm pulse crosses the whole bridge every couple of minutes
  const goldSweep = smoothstep(0.92, 1.0, sin(u.mul(TAU).sub(T.mul(0.09))));
  art = mix(art, amber, goldSweep.mul(0.85));
  // overshoot saturation: the additive core inevitably whitens, so start vivid
  const luma = art.r.mul(0.2126).add(art.g.mul(0.7152)).add(art.b.mul(0.0722));
  art = mix(vec3(luma), art, 1.45).max(0.0);

  // shimmer: two drifting waves along the span + a cascade down the suspenders
  const s1 = sin(u.mul(TAU * 30).sub(T.mul(0.55))).mul(0.5).add(0.5);
  const s2 = sin(u.mul(TAU * 11).add(T.mul(0.34)).add(1.3)).mul(0.5).add(0.5);
  const shimmer = s1.mul(0.6).add(s2.mul(0.4)).mul(0.38).add(0.62);
  const cascade = sin(hf.mul(7).sub(T.mul(0.7)).add(u.mul(260))).mul(0.5).add(0.5);
  const vertical = mix(float(1), cascade.mul(0.45).add(mix(0.62, 0.95, hf)), kind);
  const aurora: N = art.mul(shimmer).mul(vertical);

  // ---- mode 1: rain — ice-blue beads glide along the cables while droplets
  // run down every suspender (~6s top to bottom)
  const ice = vec3(0.3, 0.55, 0.95);
  const drop = hf.mul(3.0).add(T.mul(0.5)).add(u.mul(97.0)).fract().pow(6);
  const comet = u.mul(120).sub(T.mul(0.4)).fract().pow(8);
  const rain: N = ice.mul(mix(comet, drop, kind).mul(2.2).add(0.16));

  // ---- mode 2: tide — a warm wash breathes across the span (~15s at a bulb),
  // suspenders lagging slightly behind their cable so the wave rolls downward
  const breathe = sin(u.mul(TAU * 1.5).sub(T.mul(0.42)).sub(hf.mul(0.9)))
    .mul(0.5)
    .add(0.5);
  const deep = vec3(0.03, 0.08, 0.3);
  const warm = vec3(0.75, 0.35, 0.16);
  const tide: N = mix(deep, warm, breathe.mul(breathe)).mul(breathe.mul(0.9).add(0.25));

  // ---- mode 3: stars — faint ember field where individual bulbs pop, mostly
  // deep gold with a few ice-blue, each on its own seed-offset ~8s clock.
  // Warm-dominant so the far silhouette can't be confused with rain's ice.
  const glint = sin(T.mul(0.8).add(seed.mul(TAU * 37))).mul(0.5).add(0.5).pow(14);
  const starCol = mix(
    vec3(1.0, 0.55, 0.18),
    vec3(0.5, 0.7, 1.0),
    seed.mul(7.31).fract().pow(3).mul(0.8)
  );
  const stars: N = starCol.mul(glint.mul(3.2)).add(vec3(0.16, 0.09, 0.04));

  const twinkle = sin(T.mul(1.7).add(seed.mul(TAU * 7))).mul(0.06).add(0.97);
  const show: N = aurora
    .mul(MODE_W[0])
    .add(rain.mul(MODE_W[1]))
    .add(tide.mul(MODE_W[2]))
    .add(stars.mul(MODE_W[3]));

  // per-bulb colour must resolve in the vertex stage: instanceIndex (and the
  // storage reads through it) are vertex-only builtins, same as fireworks
  const glow = vertexStage(show.mul(twinkle)) as unknown as N;

  // soft radial falloff with a hot core — no texture needed (fireworks pattern)
  const d = uv().sub(0.5).length().mul(2);
  const soft = saturate(d.oneMinus()).pow(2.4);
  const core = saturate(d.mul(1.5).oneMinus()).pow(4).mul(0.5);

  material.colorNode = vec4(
    glow
      .mul(soft.add(core))
      .mul(0.55)
      .mul(BAY_LIGHTS_INTENSITY)
      .mul(BAY_LIGHTS_TUNING.brightness),
    1
  );
  material.transparent = true;
  material.blending = THREE.AdditiveBlending;
  material.depthWrite = false;
  material.fog = false;

  const sprite = new THREE.Sprite(material);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = 90;
  return sprite;
}
