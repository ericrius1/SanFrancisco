import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { float, instancedArray, instanceIndex, saturate, sin, uniform, uv, vec2, vec3, vec4, vertexStage } from "three/tsl";
import { tunables } from "../core/persist";
import type { WorldMap } from "./heightmap";
import { enableLocalFarShadowLayers, enableLocalShadowLayer } from "./shadows/shadowLayers";

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
const LEG_ROT = Math.PI / 6; // splay one bay toward the overlook, matches photo

// stripe palette lifted from blender_city.py (SUTRO_RED / SUTRO_WHITE), taken
// through the same sRGB->linear the baker applied so it reads identically.
const RED = new THREE.Color(0xc44e3c).convertSRGBToLinear();
const WHITE = new THREE.Color(0xebe8e2).convertSRGBToLinear();
const STEEL = new THREE.Color(0x2a2c30).convertSRGBToLinear();

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

const Y_UP = new THREE.Vector3(0, 1, 0);

/**
 * Tapered cylinder between two world points, its length painted in red/white
 * bands (band index by along-axis position). Push into the vertex-colour soup.
 */
function bandedTube(
  out: THREE.BufferGeometry[],
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  rBottom: number,
  rTop: number,
  bandLen: number,
  radial = 8
) {
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const len = dir.length();
  if (len < 1e-3) return;
  const geo = new THREE.CylinderGeometry(rTop, rBottom, len, radial, Math.max(1, Math.round(len / bandLen)), false);
  // colour every vertex by its band before we tilt the cylinder off vertical
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let v = 0; v < pos.count; v++) {
    const along = pos.getY(v) + len / 2; // 0..len from the p0 end
    const band = Math.floor(along / bandLen);
    const c = band % 2 === 0 ? WHITE : RED;
    col[v * 3] = c.r;
    col[v * 3 + 1] = c.g;
    col[v * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  const q = new THREE.Quaternion().setFromUnitVectors(Y_UP, dir.clone().normalize());
  geo.applyQuaternion(q);
  const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
  geo.translate(mid.x, mid.y, mid.z);
  out.push(geo.toNonIndexed());
}

/** Solid-colour box (crossarm decks and struts). */
function box(out: THREE.BufferGeometry[], x: number, y: number, z: number, sx: number, sy: number, sz: number, c: THREE.Color) {
  const geo = new THREE.BoxGeometry(sx, sy, sz).toNonIndexed();
  const col = new Float32Array(geo.attributes.position.count * 3);
  for (let v = 0; v < geo.attributes.position.count; v++) {
    col[v * 3] = c.r;
    col[v * 3 + 1] = c.g;
    col[v * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  geo.translate(x, y, z);
  out.push(geo);
}

/** Thin uncoloured strut/wire, merged into the steel geometry. */
function strut(out: THREE.BufferGeometry[], p0: THREE.Vector3, p1: THREE.Vector3, r: number, radial = 5) {
  const dir = new THREE.Vector3().subVectors(p1, p0);
  const len = dir.length();
  if (len < 1e-3) return;
  const geo = new THREE.CylinderGeometry(r, r, len, radial, 1, false);
  const q = new THREE.Quaternion().setFromUnitVectors(Y_UP, dir.clone().normalize());
  geo.applyQuaternion(q);
  const mid = new THREE.Vector3().addVectors(p0, p1).multiplyScalar(0.5);
  geo.translate(mid.x, mid.y, mid.z);
  out.push(geo.toNonIndexed());
}

/**
 * Runtime Sutro Tower: replaces the crude baked landmark with a proper
 * red/white candelabra — three splayed legs pinched at the waist, X-braced
 * bays, twin crossarm decks, three antenna masts, guy wires — and a set of
 * red FAA aviation-obstruction beacons (steady on the decks, flashing at the
 * mast tips) that light the hill after dark. Returns the whole rig; the caller
 * hides `lm_sutro` so the two do not z-fight.
 */
export function createSutroTower(map: WorldMap): THREE.Group {
  const g = map.groundHeight(CX, CZ);
  const group = new THREE.Group();
  group.name = "sutro_tower";

  const striped: THREE.BufferGeometry[] = []; // red/white vertex-coloured shell
  const steel: THREE.BufferGeometry[] = []; // dark bracing + guy wires

  // --- three candelabra legs, split at the waist so they pinch then rise ---
  for (let i = 0; i < 3; i++) {
    const base = legPoint(i, -3, g); // sink a touch so no ground gap
    const waist = legPoint(i, 150, g);
    const deck = legPoint(i, 250, g);
    bandedTube(striped, base, waist, 3.4, 2.4, 14);
    bandedTube(striped, waist, deck, 2.4, 2.0, 14);
  }

  // --- horizontal ring struts + X-bracing per bay (the truss look) ---
  const bandTops = [24, 72, 150, 210, 250];
  for (const h of bandTops) {
    for (let i = 0; i < 3; i++) {
      strut(steel, legPoint(i, h, g), legPoint((i + 1) % 3, h, g), 0.7);
    }
  }
  const bays: [number, number][] = [
    [24, 72],
    [72, 150],
    [150, 210],
    [210, 250]
  ];
  for (const [h0, h1] of bays) {
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      strut(steel, legPoint(i, h0, g), legPoint(j, h1, g), 0.55);
      strut(steel, legPoint(j, h0, g), legPoint(i, h1, g), 0.55);
    }
  }

  // --- crossarm decks (red bands) + top platform (white) ---
  box(striped, CX, g + 150, CZ, 36, 6, 36, RED);
  box(striped, CX, g + 250, CZ, 30, 8, 30, RED);
  box(striped, CX, g + 258, CZ, 26, 3, 26, WHITE);

  // --- three antenna masts fanning off the top deck (striped, red tips) ---
  const mastTops: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const a = (TAU * i) / 3 + LEG_ROT + Math.PI / 3;
    const bx = CX + Math.cos(a) * 9;
    const bz = CZ - Math.sin(a) * 9;
    const p0 = new THREE.Vector3(bx, g + 259, bz);
    const p1 = new THREE.Vector3(bx, g + 300, bz);
    bandedTube(striped, p0, p1, 1.3, 0.7, 8, 6);
    mastTops.push(p1);
  }

  // --- guy wires: waist + top deck out to distant ground anchors ---
  for (let i = 0; i < 3; i++) {
    const a = (TAU * i) / 3 + LEG_ROT + Math.PI / 3;
    const ax = CX + Math.cos(a) * 150;
    const az = CZ - Math.sin(a) * 150;
    const anchor = new THREE.Vector3(ax, map.groundHeight(ax, az) + 1, az);
    strut(steel, legPoint(i, 250, g), anchor, 0.28, 4);
    strut(steel, legPoint(i, 150, g), anchor, 0.28, 4);
  }

  const shellMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0.15 });
  const steelMat = new THREE.MeshStandardMaterial({ color: STEEL, roughness: 0.7, metalness: 0.4 });

  const shell = new THREE.Mesh(mergeGeometries(striped, false)!, shellMat);
  shell.name = "sutro_shell";
  shell.castShadow = true;
  enableLocalFarShadowLayers(shell);
  shell.receiveShadow = true;
  group.add(shell);

  const braces = new THREE.Mesh(mergeGeometries(steel, false)!, steelMat);
  braces.name = "sutro_braces";
  braces.castShadow = true;
  // Ring/X bracing and the six long guy wires remain readable in the 6.25 cm
  // local map, but collapse into unstable sub-texel lines at the far map's
  // 1 m resolution. The striped legs/decks/masts above own the far silhouette.
  enableLocalShadowLayer(braces);
  braces.receiveShadow = true;
  group.add(braces);

  group.add(buildBeacons(g, mastTops));
  return group;
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
