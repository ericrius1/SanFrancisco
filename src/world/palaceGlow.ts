import * as THREE from "three/webgpu";
import {
  cos,
  float,
  instancedArray,
  instanceIndex,
  saturate,
  sin,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { tunables } from "../core/persist";
import type { WorldMap } from "./heightmap";

// TSL node generics fight composition; any is the idiom here (see facade.ts)
type N = any;

/** Sky-driven brightness, rewritten every frame next to BAY_LIGHTS_INTENSITY. */
export const PALACE_GLOW_INTENSITY = uniform(0);

/** The installation's own clock, advanced by updatePalaceGlow. */
export const PALACE_GLOW_TIME = uniform(0);

export const PALACE_GLOW_SLIDERS = tunables("palaceGlow", {
  brightness: { v: 0.55, min: 0, max: 3, step: 0.05, label: "brightness x" },
  breathe: { v: 1.0, min: 0, max: 3, step: 0.05, label: "breathing" },
  orb: { v: 0.45, min: 0, max: 2.5, step: 0.05, label: "courtyard orb" },
  particleFlow: { v: 1.0, min: 0, max: 3, step: 0.05, label: "particle flow" },
  particleGlow: { v: 0.55, min: 0, max: 2.5, step: 0.05, label: "particle glow" }
});

export const PALACE_GLOW_TUNING = {
  brightness: uniform(PALACE_GLOW_SLIDERS.values.brightness),
  breathe: uniform(PALACE_GLOW_SLIDERS.values.breathe),
  orb: uniform(PALACE_GLOW_SLIDERS.values.orb),
  particleFlow: uniform(PALACE_GLOW_SLIDERS.values.particleFlow),
  particleGlow: uniform(PALACE_GLOW_SLIDERS.values.particleGlow)
};

/** "." factory reset: slider uniforms back to the current source defaults. */
export function resetPalaceGlowTweaks() {
  for (const k in PALACE_GLOW_TUNING) {
    const key = k as keyof typeof PALACE_GLOW_TUNING;
    PALACE_GLOW_TUNING[key].value = PALACE_GLOW_SLIDERS.values[key];
  }
}

export function updatePalaceGlow(dt: number) {
  PALACE_GLOW_TIME.value += dt;
}

const TAU = Math.PI * 2;

// Layout constants mirror blender_city.py's Palace builder exactly (game
// frame: blender angle a -> position (px + r·cos a, pz - r·sin a)).
const PX = -388;
const PZ = -1426;
const ORB_SCALE = 0.5;
const ORB_RING_DIAMETER = 31.2 * ORB_SCALE;
const ORB_FLOOR_CLEARANCE = 2.0;
const ORB_CENTER_LIFT = ORB_FLOOR_CLEARANCE + ORB_RING_DIAMETER * 0.5;
const ORB_PARTICLE_RADIUS = 10.9 * ORB_SCALE;

/**
 * Palace of Fine Arts night uplighting. Deliberately NOT another Bay-Lights
 * LED strand: this is architectural floodlighting — the way the real palace
 * is lit. Four ingredients, one instanced sprite draw:
 *
 *  - kind 0: uplight washes — tall narrow gradient sprites hugging every
 *    column shaft, hot amber at the base dying out toward the capital, each
 *    with its own slow gas-lamp waver.
 *  - kind 1: dome rim glow — terracotta-rose halos around the drum cornice,
 *    breathing in a slow ring-wide wave so the dome seems to inhale.
 *  - kind 2: interior spill — a few huge soft pools inside the rotunda that
 *    leak warm light through the arches.
 *  - kind 3: ember motes — a handful of tiny fireflies drifting slowly
 *    around the colonnade (the only moving element; position, not color).
 *  - kind 4: courtyard orb body — a billboarded amber installation sitting in
 *    the rotunda court.
 *  - kind 7/8: tiny star particles inside the orb, drifting through a slow
 *    curl-like field so the whole piece has a gentle pulse.
 */
export function createPalaceGlow(map: WorldMap): THREE.Sprite {
  const g = map.effectiveGround(PX, PZ);
  const orbY = g + ORB_CENTER_LIFT;

  // sprite fields: pos.xyz + kind, then seed / phase / unused
  const posK: number[] = [];
  const info: number[] = [];
  const push = (x: number, y: number, z: number, kind: number, phase: number, seed = Math.random()) => {
    posK.push(x, y, z, kind);
    info.push(seed, phase, 0, 0);
  };

  // colonnade column washes (arc mirrors the builder: 55°..305°, r 33, h 13)
  const arc0 = (55 * Math.PI) / 180;
  const arc1 = (305 * Math.PI) / 180;
  for (let k = 0; k < 20; k++) {
    const a = arc0 + ((arc1 - arc0) * k) / 19;
    push(PX + Math.cos(a) * 33, g + 6.2, PZ - Math.sin(a) * 33, 0, k / 20);
  }
  // rotunda pier column washes (paired at r 15.9, taller: h 18)
  for (let k = 0; k < 8; k++) {
    const a = (k * TAU) / 8 + TAU / 16;
    for (const da of [-0.16, 0.16]) {
      push(PX + Math.cos(a + da) * 15.9, g + 9.0, PZ - Math.sin(a + da) * 15.9, 0, (k + 0.5) / 8);
    }
  }
  // dome rim halos around the drum cornice (r 15, just above the entablature)
  for (let k = 0; k < 14; k++) {
    const a = (k * TAU) / 14;
    push(PX + Math.cos(a) * 15.0, g + 29.5, PZ - Math.sin(a) * 15.0, 1, k / 14);
  }
  // interior spill pools
  push(PX, g + 9, PZ, 2, 0);
  push(PX + 4, g + 15, PZ + 3, 2, 0.33);
  push(PX - 4, g + 13, PZ - 3, 2, 0.66);
  // ember motes wandering the colonnade walk
  for (let k = 0; k < 22; k++) {
    const a = arc0 + ((arc1 - arc0) * k) / 21 + 0.06;
    const r = 24 + (k % 5) * 3.2;
    push(PX + Math.cos(a) * r, g + 2.5 + (k % 7) * 0.9, PZ - Math.sin(a) * r, 3, k / 22);
  }
  // courtyard orb body, centered just above the rotunda court
  push(PX, orbY, PZ, 4, 0.13);

  // dense but cheap particle field: still one instanced sprite draw, no CPU
  // simulation. A golden-angle shell gives even coverage; the shader does the
  // flowing drift from the anchor positions.
  const golden = Math.PI * (3 - Math.sqrt(5));
  const orbParticleCount = 430;
  for (let k = 0; k < orbParticleCount; k++) {
    const u = (k + 0.5) / orbParticleCount;
    const yy = 1 - 2 * u;
    const shell = Math.sqrt(Math.max(0, 1 - yy * yy));
    const a = k * golden;
    const seed = Math.random();
    const radius = ORB_PARTICLE_RADIUS * (0.28 + 0.72 * Math.pow(seed, 0.42));
    const x = Math.cos(a) * shell * radius;
    const z = Math.sin(a) * shell * radius;
    const y = yy * radius * 0.86;
    push(PX + x, orbY + y, PZ + z, k % 11 === 0 ? 8 : 7, u, seed);
  }
  // top/bottom dust rivers echo the reference image's denser glowing bands.
  for (let k = 0; k < 150; k++) {
    const top = k < 75 ? 1 : -1;
    const t = (k % 75) / 75;
    const a = k * golden + top * 0.6;
    const seed = Math.random();
    const radius = (5.5 + seed * 6.2) * ORB_SCALE;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius * 0.8;
    const y = top * (8.1 + Math.sin(t * TAU * 2) * 1.1 + seed * 1.8) * ORB_SCALE;
    push(PX + x, orbY + y, PZ + z, 8, t, seed);
  }

  const count = posK.length / 4;
  const sprPos = instancedArray(new Float32Array(posK), "vec4");
  const sprInfo = instancedArray(new Float32Array(info), "vec4");

  const material = new THREE.SpriteNodeMaterial();
  const p = sprPos.element(instanceIndex) as unknown as N;
  const d = sprInfo.element(instanceIndex) as unknown as N;
  const kind = p.w;
  const seed = d.x;
  const phase = d.y;
  const T = PALACE_GLOW_TIME as N;

  // kind weights, all vertex-stage math (mix/multiply only — never branches)
  const w0 = saturate(float(1).sub(kind.abs())); // column wash
  const w1 = saturate(float(1).sub(kind.sub(1).abs())); // dome rim
  const w2 = saturate(float(1).sub(kind.sub(2).abs())); // interior spill
  const w3 = saturate(float(1).sub(kind.sub(3).abs())); // motes
  const w4 = saturate(float(1).sub(kind.sub(4).abs())); // courtyard orb body
  const w7 = saturate(float(1).sub(kind.sub(7).abs())); // fine orb dust
  const w8 = saturate(float(1).sub(kind.sub(8).abs())); // brighter orb flecks
  const orbParticleW = w7.add(w8);

  // motes drift: a slow figure-wander around their anchor; everything else
  // stays nailed to the architecture
  const driftX = sin(T.mul(0.11).add(seed.mul(TAU * 3))).mul(2.2);
  const driftY = sin(T.mul(0.07).add(seed.mul(TAU * 5)).add(1.7)).mul(1.1);
  const driftZ = sin(T.mul(0.09).add(seed.mul(TAU * 7)).add(3.9)).mul(2.2);
  const flow = PALACE_GLOW_TUNING.particleFlow as N;
  const flowT = T.mul(0.18).mul(flow);
  const relX = p.x.sub(PX);
  const relY = p.y.sub(orbY);
  const relZ = p.z.sub(PZ);
  // Curl-ish vector field from phase-shifted sine derivatives. It is bounded,
  // deterministic per particle, and entirely GPU-side.
  const curlX = sin(flowT.add(relY.mul(0.31)).add(seed.mul(TAU * 9)))
    .mul(1.25)
    .add(cos(flowT.mul(0.72).add(relZ.mul(0.17)).add(seed.mul(TAU * 4))).mul(0.75));
  const curlY = sin(flowT.mul(0.76).add(relZ.mul(0.2)).add(seed.mul(TAU * 6))).mul(0.82);
  const curlZ = cos(flowT.mul(0.91).add(relX.mul(0.27)).add(seed.mul(TAU * 7)))
    .mul(1.2)
    .add(sin(flowT.mul(0.58).add(relY.mul(0.19)).add(seed.mul(TAU * 3))).mul(0.72));
  material.positionNode = p.xyz
    .add(vec3(driftX, driftY, driftZ).mul(w3))
    .add(vec3(curlX, curlY, curlZ).mul(flow).mul(ORB_SCALE).mul(orbParticleW));

  // per-kind sprite shape: washes are tall and narrow, halos round, spill
  // huge and soft, motes tiny
  const orbPulse = sin(T.mul(0.17).mul(PALACE_GLOW_TUNING.breathe as N)).mul(0.5).add(0.5);
  const orbSize = float(26.4 * ORB_SCALE).add(orbPulse.mul(1.15 * ORB_SCALE));
  const sx = float(3.2)
    .mul(w0)
    .add(float(7.5).mul(w1))
    .add(float(16).mul(w2))
    .add(float(0.55).mul(w3))
    .add(orbSize.mul(w4))
    .add(float(0.25).mul(w7))
    .add(float(0.44).mul(w8));
  const sy = float(14.5)
    .mul(w0)
    .add(float(5.5).mul(w1))
    .add(float(12).mul(w2))
    .add(float(0.55).mul(w3))
    .add(orbSize.mul(w4))
    .add(float(0.25).mul(w7))
    .add(float(0.44).mul(w8));
  material.scaleNode = vec2(sx, sy);

  // slow shared breathing + per-fixture gas-lamp waver (two incommensurate
  // sines so it never loops visibly)
  const breathe = sin(T.mul(0.12).mul(PALACE_GLOW_TUNING.breathe as N).add(phase.mul(TAU)))
    .mul(0.5)
    .add(0.5);
  const waver = sin(T.mul(1.9).add(seed.mul(TAU * 11)))
    .mul(sin(T.mul(0.53).add(seed.mul(TAU * 4))))
    .mul(0.07)
    .add(0.96);
  const moteGlint = sin(T.mul(0.9).add(seed.mul(TAU * 13))).mul(0.5).add(0.5).pow(3);
  const particlePulse = sin(T.mul(0.42).mul(PALACE_GLOW_TUNING.breathe as N).add(seed.mul(TAU * 17)))
    .mul(0.5)
    .add(0.5)
    .pow(2.2);

  const amber = vec3(1.0, 0.56, 0.2);
  const gold = vec3(1.0, 0.72, 0.34);
  const terracotta = vec3(0.95, 0.38, 0.2);
  const ember = vec3(1.0, 0.45, 0.12);
  const peach = vec3(1.0, 0.48, 0.24);
  const sun = vec3(1.0, 0.88, 0.36);

  let col: N = amber.mul(w0).mul(waver);
  col = col.add(terracotta.mul(w1).mul(breathe.mul(0.5).add(0.55)));
  col = col.add(gold.mul(w2).mul(breathe.mul(0.25).add(0.6)));
  col = col.add(ember.mul(w3).mul(moteGlint.mul(1.6).add(0.1)));
  col = col.add(peach.mul(w4).mul(orbPulse.mul(0.18).add(0.42)).mul(PALACE_GLOW_TUNING.orb));
  col = col.add(gold.mul(w7).mul(particlePulse.mul(1.6).add(0.18)).mul(PALACE_GLOW_TUNING.particleGlow));
  col = col.add(sun.mul(w8).mul(particlePulse.mul(2.4).add(0.6)).mul(PALACE_GLOW_TUNING.particleGlow));

  const glow = vertexStage(col) as unknown as N;
  const vw0 = vertexStage(w0) as unknown as N;
  const vw3 = vertexStage(w3) as unknown as N;
  const vw4 = vertexStage(w4) as unknown as N;
  const vw7 = vertexStage(w7) as unknown as N;
  const vw8 = vertexStage(w8) as unknown as N;

  // fragment shaping: washes fade bottom-hot to top-dark (uplight) and pinch
  // horizontally; everything else is a soft radial falloff with a hot core
  const q = uv().sub(0.5).mul(2);
  const r = q.length();
  const radial = saturate(r.oneMinus());
  const roundShape = radial.pow(2.2).add(saturate(q.length().mul(1.6).oneMinus()).pow(4).mul(0.6));
  const upFade = saturate(uv().y.oneMinus()).pow(1.7);
  const pinch = saturate(q.x.abs().oneMinus()).pow(2.4);
  const washShape = upFade.mul(pinch).mul(1.15);
  const palaceMoteShape = roundShape.mul(radial.pow(3).mul(2.4).add(0.15)).mul(vw3);
  const orbBodyShape = radial.pow(0.78).mul(0.34).add(radial.pow(3.4).mul(0.18)).mul(vw4);
  const particleShape = radial.pow(4).mul(2.25).add(radial.pow(13).mul(1.6)).mul(vw7.add(vw8));
  const shape = washShape
    .mul(vw0)
    .add(roundShape.mul(vertexStage(w1.add(w2)) as unknown as N))
    .add(palaceMoteShape)
    .add(orbBodyShape)
    .add(particleShape);

  material.colorNode = vec4(
    glow
      .mul(shape)
      .mul(0.3)
      .mul(PALACE_GLOW_INTENSITY)
      .mul(PALACE_GLOW_TUNING.brightness),
    1
  );
  material.blending = THREE.AdditiveBlending;
  material.transparent = true;
  material.depthWrite = false;
  material.fog = false;

  const sprite = new THREE.Sprite(material);
  sprite.count = count;
  sprite.frustumCulled = false;
  sprite.renderOrder = 90;
  return sprite;
}
