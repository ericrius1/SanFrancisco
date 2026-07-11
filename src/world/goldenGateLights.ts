import * as THREE from "three/webgpu";
import {
  cameraPosition,
  float,
  floor,
  instancedArray,
  instanceIndex,
  mix,
  saturate,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { tunables } from "../core/persist";
import { applyMaterialPolicy, RenderBand, tagTransparency } from "../render/transparency";
import type { WorldMap } from "./heightmap";

// TSL node generics fight composition; any is the idiom here (see bayLights.ts)
type N = any;

/** Sky-driven bridge brightness, rewritten every frame by Sky.#applySun. */
export const GOLDEN_GATE_LIGHTS_INTENSITY = uniform(0);

/** Installation clock, advanced by updateGoldenGateLights. */
export const GOLDEN_GATE_LIGHTS_TIME = uniform(0);

export const GOLDEN_GATE_LIGHTS_SLIDERS = tunables("goldenGateLights", {
  brightness: { v: 1.45, min: 0, max: 4, step: 0.05, label: "brightness x" },
  deck: { v: 1.25, min: 0, max: 3, step: 0.05, label: "deck lamps" },
  cables: { v: 1.15, min: 0, max: 2.5, step: 0.05, label: "cable glow" },
  reflections: { v: 1.2, min: 0, max: 3, step: 0.05, label: "water reflections" },
  beacons: { v: 1.0, min: 0, max: 3, step: 0.05, label: "red beacons" },
  size: { v: 1.0, min: 0.4, max: 2.5, step: 0.05, label: "bulb size" }
});

export const GOLDEN_GATE_LIGHTS_TUNING = {
  brightness: uniform(GOLDEN_GATE_LIGHTS_SLIDERS.values.brightness),
  deck: uniform(GOLDEN_GATE_LIGHTS_SLIDERS.values.deck),
  cables: uniform(GOLDEN_GATE_LIGHTS_SLIDERS.values.cables),
  reflections: uniform(GOLDEN_GATE_LIGHTS_SLIDERS.values.reflections),
  beacons: uniform(GOLDEN_GATE_LIGHTS_SLIDERS.values.beacons),
  size: uniform(GOLDEN_GATE_LIGHTS_SLIDERS.values.size)
};

/** "." factory reset: slider uniforms back to the current source defaults. */
export function resetGoldenGateLightsTweaks() {
  for (const k in GOLDEN_GATE_LIGHTS_TUNING) {
    const key = k as keyof typeof GOLDEN_GATE_LIGHTS_TUNING;
    GOLDEN_GATE_LIGHTS_TUNING[key].value = GOLDEN_GATE_LIGHTS_SLIDERS.values[key];
  }
}

export function updateGoldenGateLights(dt: number) {
  GOLDEN_GATE_LIGHTS_TIME.value += dt;
}

const TAU = Math.PI * 2;
const DECK_SPACING = 23;
const CABLE_SPACING = 12;
const SUSPENDER_SPACING = 17;

function hash01(n: number) {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

type Bridge = WorldMap["meta"]["bridges"][number];

type BridgeSample = {
  x: number;
  y: number;
  z: number;
  u: number;
  yaw: number;
  perpX: number;
  perpZ: number;
};

function sampleBridgeLine(br: Bridge, spacing: number): BridgeSample[] {
  const segs: { a: Bridge["line"][number]; b: Bridge["line"][number]; len: number; yaw: number; u0: number }[] = [];
  let total = 0;
  for (let i = 0; i < br.line.length - 1; i++) {
    const a = br.line[i];
    const b = br.line[i + 1];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len <= 0.001) continue;
    segs.push({ a, b, len, yaw: Math.atan2(dx, dz), u0: total });
    total += len;
  }

  const out: BridgeSample[] = [];
  for (const seg of segs) {
    // floor, not round: must mirror blender_city._bridge_line_samples (int())
    // exactly, or bulbs drift off their modelled lamp posts mid-span
    const steps = Math.max(1, Math.floor(seg.len / spacing));
    for (let i = 0; i <= steps; i++) {
      if (i === steps && seg !== segs[segs.length - 1]) continue;
      const t = i / steps;
      const x = seg.a[0] + (seg.b[0] - seg.a[0]) * t;
      const z = seg.a[1] + (seg.b[1] - seg.a[1]) * t;
      const y = seg.a[2] + (seg.b[2] - seg.a[2]) * t;
      const dx = seg.b[0] - seg.a[0];
      const dz = seg.b[1] - seg.a[1];
      const dl = Math.hypot(dx, dz) || 1;
      out.push({
        x,
        y,
        z,
        u: (seg.u0 + seg.len * t) / total,
        yaw: seg.yaw,
        perpX: dz / dl,
        perpZ: -dx / dl
      });
    }
  }
  return out;
}

function createGoldenGateMaterial(posK: number[], info: number[]) {
  const count = posK.length / 4;
  const sprPos = instancedArray(new Float32Array(posK), "vec4");
  const sprInfo = instancedArray(new Float32Array(info), "vec4");

  const material = new THREE.SpriteNodeMaterial();
  const p = sprPos.element(instanceIndex) as unknown as N;
  const data = sprInfo.element(instanceIndex) as unknown as N;
  const kind = p.w;
  const u = data.x;
  const phase = data.y;
  const seed = data.z;
  const localSize = data.w;
  const T = GOLDEN_GATE_LIGHTS_TIME as N;

  const wDeck = saturate(float(1).sub(kind.sub(0).abs()));
  const wCable = saturate(float(1).sub(kind.sub(2).abs()));
  const wSuspender = saturate(float(1).sub(kind.sub(3).abs()));
  const wBeacon = saturate(float(1).sub(kind.sub(4).abs()));
  const wReflection = saturate(float(1).sub(kind.sub(5).abs()));

  material.positionNode = p.xyz;

  // small, bolted-on bulbs: gentle distance growth so far spans still read,
  // but nothing balloons past ~3x up close
  const dist = p.xyz.distance(cameraPosition);
  const farBoost = dist.mul(0.0038).clamp(0.7, 3.0).mul(GOLDEN_GATE_LIGHTS_TUNING.size as N).mul(localSize);
  const sx: N = wDeck
    .mul(2.1)
    .add(wCable.mul(1.7))
    .add(wSuspender.mul(1.4))
    .add(wBeacon.mul(3.2))
    .mul(farBoost)
    .add(wReflection.mul(20).mul(localSize).mul(GOLDEN_GATE_LIGHTS_TUNING.size as N));
  const sy: N = wDeck
    .mul(2.3)
    .add(wCable.mul(1.7))
    .add(wSuspender.mul(1.4))
    .add(wBeacon.mul(3.2))
    .mul(farBoost)
    .add(wReflection.mul(112).mul(localSize).mul(GOLDEN_GATE_LIGHTS_TUNING.size as N));
  material.scaleNode = vec2(sx, sy);

  const deckPulse = sin(T.mul(0.9).add(u.mul(TAU * 13)).add(seed.mul(TAU))).mul(0.08).add(0.96);
  const cableTwinkle = sin(T.mul(0.72).add(u.mul(TAU * 41)).add(seed.mul(21))).mul(0.18).add(0.86);
  const beaconCycle = sin(T.mul(2.6).add(phase.mul(TAU)));
  const beaconPulse = saturate(beaconCycle).pow(8).mul(2.7).add(0.18);
  const reflectionRipple = sin(T.mul(1.1).add(u.mul(TAU * 17)).add(seed.mul(TAU)))
    .mul(0.18)
    .add(0.88)
    .mul(sin(T.mul(0.47).add(seed.mul(41))).mul(0.16).add(0.92));

  // each deck lamp is red, white, or blue — picked per-lamp from its seed
  const rwbSel = floor(seed.mul(3));
  const wR = saturate(float(1).sub(rwbSel.abs()));
  const wW = saturate(float(1).sub(rwbSel.sub(1).abs()));
  const wB = saturate(float(1).sub(rwbSel.sub(2).abs()));
  const RED = vec3(1.0, 0.16, 0.12);
  const WHITE = vec3(1.0, 1.0, 1.0);
  const BLUE = vec3(0.22, 0.42, 1.0);
  const rwbDeck = RED.mul(wR).add(WHITE.mul(wW)).add(BLUE.mul(wB));
  const warmDeck = rwbDeck.mul(deckPulse).mul(GOLDEN_GATE_LIGHTS_TUNING.deck as N);
  // cables: red→white→blue bands chasing slowly along the catenary (July 4th garland)
  const bandSel = floor(u.mul(36).add(T.mul(0.3)).mod(3));
  const cR = saturate(float(1).sub(bandSel.abs()));
  const cW = saturate(float(1).sub(bandSel.sub(1).abs()));
  const cB = saturate(float(1).sub(bandSel.sub(2).abs()));
  const cableRwb = RED.mul(cR).add(WHITE.mul(cW)).add(BLUE.mul(cB))
    .mul(cableTwinkle)
    .mul(GOLDEN_GATE_LIGHTS_TUNING.cables as N);
  // suspenders: quiet white sparkle so the verticals read without competing
  const suspenderWhite = vec3(1.0, 0.96, 0.9).mul(cableTwinkle).mul(GOLDEN_GATE_LIGHTS_TUNING.cables as N);
  const redBeacon = vec3(1.0, 0.04, 0.02).mul(beaconPulse).mul(GOLDEN_GATE_LIGHTS_TUNING.beacons as N);
  const reflectedGold = vec3(1.0, 0.43, 0.04).mul(reflectionRipple).mul(GOLDEN_GATE_LIGHTS_TUNING.reflections as N);

  const show = warmDeck
    .mul(wDeck)
    .add(cableRwb.mul(wCable))
    .add(suspenderWhite.mul(wSuspender.mul(0.55)))
    .add(redBeacon.mul(wBeacon))
    .add(reflectedGold.mul(wReflection));

  const glow = vertexStage(show) as unknown as N;
  const vReflection = vertexStage(wReflection) as unknown as N;
  const vBeacon = vertexStage(wBeacon) as unknown as N;

  const q = uv().sub(0.5).mul(2);
  const roundR = q.length();
  const reflectionR = vec2(q.x.mul(1.4), q.y.mul(0.16)).length();
  const r = mix(roundR, reflectionR, vReflection);

  const soft = saturate(r.oneMinus()).pow(2.35);
  const core = saturate(r.mul(1.8).oneMinus()).pow(5.5);
  const beaconCore = saturate(r.mul(2.6).oneMinus()).pow(7).mul(vBeacon);
  const reflectionFade = smoothstep(1.0, 0.12, r).mul(vReflection);
  const body = soft.add(core.mul(0.75)).add(beaconCore.mul(1.6));
  const reflectionBody = reflectionFade.mul(reflectionFade).mul(0.7);

  material.colorNode = vec4(
    glow
      .mul(body.add(reflectionBody))
      .mul(0.55)
      .mul(GOLDEN_GATE_LIGHTS_INTENSITY)
      .mul(GOLDEN_GATE_LIGHTS_TUNING.brightness),
    1
  );
  applyMaterialPolicy(material, "additiveWorld");
  material.fog = false;

  const sprite = new THREE.Sprite(material);
  sprite.count = count;
  sprite.frustumCulled = false;
  tagTransparency(sprite, { profile: "additiveWorld", renderBand: RenderBand.WORLD_ADDITIVE_FRONT });
  sprite.name = "golden_gate_lights";
  return sprite;
}

/**
 * Golden Gate architectural lighting: warm deck lamps, lit cable/suspender
 * beads, red aviation beacons, and long water streaks.
 * It is one instanced sprite draw so the bridge reads at night without adding
 * hundreds of dynamic lights to the WebGPU scene.
 */
export function createGoldenGateLights(map: WorldMap): THREE.Sprite | null {
  const br = map.meta.bridges.find((b) => b.name === "Golden Gate Bridge");
  if (!br) return null;

  // sprite fields: pos.xyz + kind, then u/phase/seed/size
  const posK: number[] = [];
  const info: number[] = [];
  let id = 1;
  const push = (x: number, y: number, z: number, kind: number, u: number, size = 1) => {
    const seed = hash01(++id + kind * 37 + u * 101);
    posK.push(x, y, z, kind);
    info.push(u, seed, seed, size);
  };

  const deck = sampleBridgeLine(br, DECK_SPACING);
  for (let i = 0; i < deck.length; i++) {
    const p = deck[i];
    // bulbs sit on the modelled curb lamp posts (blender_city build_golden_gate
    // places posts at width/2 - 0.55 every 23 m, head centred at deck + 2.2)
    const edge = br.width / 2 - 0.55;
    for (const sgn of [-1, 1]) {
      const x = p.x + p.perpX * edge * sgn;
      const z = p.z + p.perpZ * edge * sgn;
      push(x, p.y + 2.25, z, 0, p.u, 0.45);
    }
  }

  const first = br.line[0];
  const last = br.line[br.line.length - 1];
  const dx = last[0] - first[0];
  const dz = last[1] - first[1];
  const dl = Math.hypot(dx, dz) || 1;
  const perpX = dz / dl;
  const perpZ = -dx / dl;
  const cableOffset = br.width / 2 + 1.5;
  const nodes = [
    { x: first[0], y: first[2] + 2, z: first[1] },
    ...br.towers.map(([x, z]) => ({ x, y: br.towerHeight, z })),
    { x: last[0], y: last[2] + 2, z: last[1] }
  ];
  let cableTotal = 0;
  const cableSpans = nodes.slice(0, -1).map((a, i) => {
    const b = nodes[i + 1];
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    const sag = a.y > 50 && b.y > 50 ? Math.max(8, span * 0.095) : Math.max(5, span * 0.052);
    const u0 = cableTotal;
    cableTotal += span;
    return { a, b, span, sag, u0 };
  });

  for (const sgn of [-1, 1]) {
    const ox = perpX * cableOffset * sgn;
    const oz = perpZ * cableOffset * sgn;
    for (const span of cableSpans) {
      const nCable = Math.max(2, Math.round(span.span / CABLE_SPACING));
      for (let i = 0; i <= nCable; i++) {
        const t = i / nCable;
        const x = span.a.x + (span.b.x - span.a.x) * t + ox;
        const y = span.a.y + (span.b.y - span.a.y) * t - span.sag * 4 * t * (1 - t);
        const z = span.a.z + (span.b.z - span.a.z) * t + oz;
        const u = (span.u0 + span.span * t) / cableTotal;
        push(x, y, z, 2, u, 0.6);

        if (i > 0 && i < nCable && i % 3 === 0) {
          const deckY = map.bridgeDeck(x, z);
          // start well above the deck: low beads sit next to thin dark rods
          // at night and read as floating dots over the water
          if (deckY > -Infinity && y > deckY + 24) {
            const top = y - 2.5;
            const bottom = deckY + 16;
            const n = Math.max(1, Math.floor((top - bottom) / SUSPENDER_SPACING));
            for (let j = 0; j <= n; j++) {
              const ty = bottom + (j / n) * (top - bottom);
              push(x, ty, z, 3, u, 0.45);
            }
          }
        }
      }
    }
  }

  for (let t = 0; t < br.towers.length; t++) {
    const [tx, tz] = br.towers[t];
    const u = t === 0 ? 0.36 : 0.62;
    // beacon sprite sits on the modelled mast tip (mast tops out at th + 3.6)
    push(tx, br.towerHeight + 4, tz, 4, u + 0.08, 1.0);
  }

  return createGoldenGateMaterial(posK, info);
}
