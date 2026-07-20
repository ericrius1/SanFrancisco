import * as THREE from "three/webgpu";
import { float, instancedArray, instanceIndex, saturate, sin, uniform, uv, vec2, vec3, vec4, vertexStage } from "three/tsl";
import { tunables } from "../core/persist";
import type { WorldMap } from "./heightmap";

// TSL node generics fight composition; any is the idiom here (see facade.ts)
type N = any;

/** Sky-driven beacon brightness, rewritten every frame next to BAY_LIGHTS_INTENSITY. */
export const SUTRO_LIGHTS_INTENSITY = uniform(0);

/** Blink clock, advanced by updateSutroTower. */
export const SUTRO_LIGHTS_TIME = uniform(0);

export const SUTRO_LIGHTS_SLIDERS = tunables("sutroLights", {
  brightness: { v: 1.0, min: 0, max: 3, step: 0.05, label: "beacon brightness" },
  halo: { v: 1.0, min: 0.2, max: 3, step: 0.05, label: "halo size" },
  blink: { v: 1.0, min: 0, max: 3, step: 0.05, label: "flash rate" }
});

export const SUTRO_LIGHTS_TUNING = {
  brightness: uniform(SUTRO_LIGHTS_SLIDERS.values.brightness),
  halo: uniform(SUTRO_LIGHTS_SLIDERS.values.halo),
  blink: uniform(SUTRO_LIGHTS_SLIDERS.values.blink)
};

/** "." factory reset: slider uniforms back to the current source defaults. */
export function resetSutroLightsTweaks() {
  for (const k in SUTRO_LIGHTS_TUNING) {
    const key = k as keyof typeof SUTRO_LIGHTS_TUNING;
    SUTRO_LIGHTS_TUNING[key].value = SUTRO_LIGHTS_SLIDERS.values[key];
  }
}

export function updateSutroTower(dt: number) {
  SUTRO_LIGHTS_TIME.value += dt;
}

const TAU = Math.PI * 2;

// game frame: blender angle a -> (cx + r·cos a, cz - r·sin a). Real tower is
// ~298 m tall; 1 world unit == 1 m, so heights below double as metres.
const CX = -782;
const CZ = 3846;

/** World XZ of the tower centre — the materialize front ramp anchor (main's
 *  applyLightFrontRamps scales SUTRO_LIGHTS_INTENSITY by the front amount here,
 *  the Bay/Golden-Gate lights CPU-ramp pattern). */
export const SUTRO_TOWER_ANCHOR = { x: CX, z: CZ };
const LEG_ROT = Math.PI / 6; // splay one bay toward the overlook, matches photo

/** Radius of the candelabra shell at height h above the base (pinched waist). */
function radiusAt(h: number): number {
  if (h <= 150) return 38 + (16 - 38) * (h / 150);
  if (h <= 250) return 16 + (11 - 16) * ((h - 150) / 100);
  return 11;
}

/** World-frame point on leg i at height h above base g. */
function legPoint(i: number, h: number, g: number): THREE.Vector3 {
  const a = (TAU * i) / 3 + LEG_ROT;
  const r = radiusAt(h);
  return new THREE.Vector3(CX + Math.cos(a) * r, g + h, CZ - Math.sin(a) * r);
}

/**
 * Sutro's static lattice, platforms, striped legs and masts are authored in
 * Blender and stream with tile 7_15. Only its animated FAA beacons remain a
 * runtime WebGPU effect.
 */
export function createSutroBeacons(map: WorldMap): THREE.Sprite {
  const g = map.groundHeight(CX, CZ);
  const mastTops: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (TAU * i) / 3 + LEG_ROT + Math.PI / 3;
    const bx = CX + Math.cos(a) * 9;
    const bz = CZ - Math.sin(a) * 9;
    const p1 = new THREE.Vector3(bx, g + 300, bz);
    mastTops.push(p1);
  }
  return buildBeacons(g, mastTops);
}

/**
 * Red aviation-obstruction lights as one instanced sprite draw (hot core +
 * halo, additive). kind 0 = steady deck/leg markers, kind 1 = flashing lamps
 * at the very top and the mast tips. Sky-faded so they only glow after dusk.
 */
function buildBeacons(g: number, mastTops: THREE.Vector3[]): THREE.Sprite {
  const posK: number[] = [];
  const info: number[] = [];
  const push = (x: number, y: number, z: number, kind: number, phase: number) => {
    posK.push(x, y, z, kind);
    info.push(Math.random(), phase, 0, 0);
  };

  // flashing lamps: the three mast tips
  mastTops.forEach((p, i) => push(p.x, p.y + 1.5, p.z, 1, i / 3));
  // steady markers ring each deck and the waist at the leg corners
  for (const [h, k] of [
    [252, 3],
    [152, 3],
    [72, 3]
  ] as const) {
    for (let i = 0; i < k; i++) {
      const p = legPoint(i, h, g);
      push(p.x, p.y, p.z, 0, i / k);
    }
  }
  // one bright flashing lamp crowning the whole structure
  push(CX, g + 262, CZ, 1, 0.5);

  const count = posK.length / 4;
  const sprPos = instancedArray(new Float32Array(posK), "vec4");
  const sprInfo = instancedArray(new Float32Array(info), "vec4");

  const material = new THREE.SpriteNodeMaterial();
  const p = sprPos.element(instanceIndex) as unknown as N;
  const d = sprInfo.element(instanceIndex) as unknown as N;
  const kind = p.w;
  const seed = d.x;
  const phase = d.y;
  const T = SUTRO_LIGHTS_TIME as N;

  const wSteady = saturate(float(1).sub(kind.abs()));
  const wFlash = saturate(float(1).sub(kind.sub(1).abs()));

  material.positionNode = p.xyz;

  // flash: a sharp periodic pulse (FAA red beacon ~ once/1.5 s); steady lamps
  // just breathe faintly so the hill never looks perfectly still.
  const rate = float(0.62).mul(SUTRO_LIGHTS_TUNING.blink as N);
  const flashCycle = sin(T.mul(rate).add(phase.mul(TAU)));
  const flash = saturate(flashCycle).pow(6).mul(1.4).add(0.06);
  const breathe = sin(T.mul(0.5).add(seed.mul(TAU))).mul(0.12).add(0.9);
  const env = wSteady.mul(breathe).add(wFlash.mul(flash));

  const halo = SUTRO_LIGHTS_TUNING.halo as N;
  const size: N = float(6.5).mul(wSteady).add(float(11).mul(wFlash)).mul(halo);
  material.scaleNode = vec2(size, size);

  // aviation red, with a hot near-white core so the lamps read as points
  const red = vec3(1.0, 0.09, 0.05);
  const glow = vertexStage(red.mul(env)) as unknown as N;
  const vEnv = vertexStage(env) as unknown as N;

  const q = uv().sub(0.5).mul(2);
  const r = q.length();
  const radial = saturate(r.oneMinus());
  const core = radial.pow(9).mul(2.2); // tight white-hot centre
  const bloom = radial.pow(2.4).mul(0.9); // soft red halo

  const white = vec3(1.0, 0.7, 0.62);
  const col = glow.mul(bloom).add(white.mul(core).mul(vEnv));

  material.colorNode = vec4(
    col.mul(0.5).mul(SUTRO_LIGHTS_INTENSITY).mul(SUTRO_LIGHTS_TUNING.brightness),
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
  sprite.name = "sutro_beacons";
  return sprite;
}
