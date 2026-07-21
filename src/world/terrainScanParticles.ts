// Terrain-scan particle field (docs/VOID_STREAM_REWRITE.md M18).
//
// The void-boot visual: the player spawns into pure black, then a wave of
// glowing points ripples outward from them, FORMING the terrain — every point
// sits on the real ground surface, so the scanned area reads as a dense
// point-cloud relief of the actual city topography (Elite-scanner look).
//
// Fully STATELESS on the GPU: a ring lattice of world-space XZ offsets is
// generated once (deterministic RNG) into instancedArray storage; per frame
// only the shared materialize uniforms change (frontCenter/frontRadius = the
// wave, worldTime = shimmer clock, worldReveal = the dawn that retires the
// field). Heights come from the terrain clipmap's height atlas IN THE VERTEX
// STAGE — the same texture the terrain-tile streamer blits into — so the
// point cloud sharpens live as real tiles install, and a particle can never
// disagree with the ground the player will stand on.
//
// Repo gotchas honored: SpriteNodeMaterial + instancedArray reads resolve in
// the vertex stage and cross to fragment via vertexStage() (Bay Lights
// precedent); no If()/branches — pure mix/step math; unborn/out-of-bounds
// points collapse to zero scale (degenerate quads rasterize to nothing).
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
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { tunables } from "../core/persist";
import { materializeField } from "../render/materialize";
import type { TerrainClipmap } from "./terrainClipmap";

type N = any;

const TAU = Math.PI * 2;

/** Outer edge of the lattice (metres) — sized for the 1.6 km scan bubble with
 *  margin so the wave's soft edge never runs out of points. */
export const SCAN_FIELD_RADIUS = 1750;

/** Density tiers: [outer radius, point spacing] — dense underfoot, sparse far
 *  (the far dots subtend pixels anyway). ~178k points total. */
const TIERS: readonly [number, number][] = [
  [90, 1],
  [150, 1.7],
  [600, 4.5],
  [SCAN_FIELD_RADIUS, 10]
];
/** Points beyond this ring distance sample the coarser height mip. */
const FAR_LOD_FROM = 600;

/** Rise band: a point fades/scales in over this many metres of wave travel. */
const RISE_BAND = 90;
/** Bright white-hot window hugging the wavefront. */
const EDGE_GLOW_BAND = 70;

const CYAN = new THREE.Vector3(0.055, 0.5, 0.56);
const AMBER = new THREE.Vector3(1.0, 0.32, 0.075);
/** Fraction of points that read as warm "data returns" (screenshot look). */
const AMBER_FRACTION = 0.018;

/**
 * Live visual controls for the scan field. The shader expresses size in world
 * units, so `screenScale` is the distance multiplier that keeps an in-focus
 * return close to a small screen-space point. Background points widen into
 * dim bokeh discs after `dofStart`, approximating a focused scanner camera
 * without paying for a fullscreen depth-of-field pass during normal play.
 */
export const TERRAIN_SCAN_PARTICLE_TUNING = tunables("terrainScanParticles", {
  screenScale: {
    v: 0.0025,
    min: 0.0008,
    max: 0.004,
    step: 0.00005,
    label: "point size"
  },
  closeSize: {
    v: 0.05,
    min: 0.006,
    max: 0.08,
    step: 0.002,
    label: "close point floor"
  },
  dofStart: {
    v: 180,
    min: 80,
    max: 800,
    step: 10,
    label: "DOF start (m)"
  },
  dofEnd: {
    v: 850,
    min: 300,
    max: 1800,
    step: 25,
    label: "DOF full (m)"
  },
  backgroundBokeh: {
    v: 3.5,
    min: 1,
    max: 7,
    step: 0.1,
    label: "background bokeh"
  },
  backgroundBrightness: {
    v: 0.2,
    min: 0.04,
    max: 0.6,
    step: 0.01,
    label: "background brightness"
  },
  brightness: {
    v: 1.06,
    min: 0.2,
    max: 1.8,
    step: 0.02,
    label: "field brightness"
  },
  edgeBoost: {
    v: 2.4,
    min: 0,
    max: 5,
    step: 0.05,
    label: "wavefront boost"
  }
});

const SCAN_U = {
  screenScale: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.screenScale),
  closeSize: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.closeSize),
  dofStart: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.dofStart),
  dofEnd: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.dofEnd),
  backgroundBokeh: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.backgroundBokeh),
  backgroundBrightness: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.backgroundBrightness),
  brightness: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.brightness),
  edgeBoost: uniform(TERRAIN_SCAN_PARTICLE_TUNING.values.edgeBoost)
};

/** Push persisted/pane values into the already-compiled scan shader. */
export function applyTerrainScanParticleTuning(): void {
  const v = TERRAIN_SCAN_PARTICLE_TUNING.values;
  SCAN_U.screenScale.value = v.screenScale;
  SCAN_U.closeSize.value = v.closeSize;
  SCAN_U.dofStart.value = v.dofStart;
  SCAN_U.dofEnd.value = Math.max(v.dofStart + 1, v.dofEnd);
  SCAN_U.backgroundBokeh.value = v.backgroundBokeh;
  SCAN_U.backgroundBrightness.value = v.backgroundBrightness;
  SCAN_U.brightness.value = v.brightness;
  SCAN_U.edgeBoost.value = v.edgeBoost;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Ring lattice with jitter: rings every `spacing`, points at ~`spacing` arc
 *  steps, both jittered ±35% — regular enough to read as a scan lattice,
 *  irregular enough to avoid moiré against the pixel grid. */
function buildOffsets(): { near: Float32Array; far: Float32Array } {
  const rand = mulberry32(0x5eaf00d);
  const near: number[] = [];
  const far: number[] = [];
  let innerRadius = 0.8;
  for (const [outer, spacing] of TIERS) {
    for (let r = innerRadius; r < outer; r += spacing) {
      const count = Math.max(6, Math.floor((TAU * r) / spacing));
      const phase = rand() * TAU;
      for (let i = 0; i < count; i++) {
        const jr = r + (rand() - 0.5) * spacing * 0.7;
        const ja = phase + ((i + (rand() - 0.5) * 0.7) / count) * TAU;
        const dx = Math.cos(ja) * jr;
        const dz = Math.sin(ja) * jr;
        const dist = Math.hypot(dx, dz);
        (dist <= FAR_LOD_FROM ? near : far).push(dx, dz, rand(), dist);
      }
    }
    innerRadius = outer;
  }
  return { near: new Float32Array(near), far: new Float32Array(far) };
}

export interface TerrainScanParticles {
  readonly group: THREE.Group;
  /** Total points across both LOD sprites (probe surface). */
  readonly count: number;
  /** Show/hide the whole field. Cheap — flip on scan start, off once the dawn
   *  ramp reaches 1 (the ring coordinator's phase machine drives this). */
  setVisible(visible: boolean): void;
  dispose(): void;
}

export function createTerrainScanParticles(clipmap: TerrainClipmap): TerrainScanParticles {
  const { near, far } = buildOffsets();
  const bounds = clipmap.gridBounds();
  const group = new THREE.Group();
  group.name = "terrainScanParticles";

  const materials: THREE.SpriteNodeMaterial[] = [];
  const makeSprite = (offsets: Float32Array, sourceLod: number): THREE.Sprite => {
    const count = offsets.length / 4;
    const store = instancedArray(offsets, "vec4");
    const material = new THREE.SpriteNodeMaterial();
    materials.push(material);

    const f = materializeField;
    const point = store.element(instanceIndex) as unknown as N;
    const dist = point.w as N;
    const seed = point.z as N;
    const center = f.frontCenter as N;
    const worldXZ = center.add(vec2(point.x, point.y)) as N;
    const time = f.worldTime as N;

    // Wave state. birth: 0 = beyond the wavefront (invisible), 1 = fully
    // risen. dawnOut retires the whole field as the world dawns in.
    const birth = saturate((f.frontRadius as N).sub(dist).div(RISE_BAND));
    const dawnOut = saturate(float(1).sub(f.worldReveal as N));

    // Height from the live terrain atlas (+0.3 m so points sit proud of the
    // eventual ground instead of z-embedding in it during the dawn overlap).
    const height = clipmap.heightNodeBilinear(worldXZ, sourceLod);
    material.positionNode = vec3(worldXZ.x, height.add(0.3), worldXZ.y);

    // Out-of-lattice points collapse (the bay west of the map edge, etc.).
    // smoothstep edges ascending per repo rule; oneMinus flips the max side.
    const inBounds = smoothstep(bounds.minX, bounds.minX + 1, worldXZ.x)
      .mul(smoothstep(bounds.maxX - 1, bounds.maxX, worldXZ.x).oneMinus())
      .mul(smoothstep(bounds.minZ, bounds.minZ + 1, worldXZ.y))
      .mul(smoothstep(bounds.maxZ - 1, bounds.maxZ, worldXZ.y).oneMinus());

    // Small, nearly screen-stable returns replace the old large nearby-orb
    // clamp. Past the focus range the quad grows into a dim, soft bokeh disc:
    // only the scan particles pay for the effect, and ordinary world rendering
    // keeps its zero-DOF post-processing path.
    const camDist = (material.positionNode as N).distance(cameraPosition);
    const backgroundBlur = smoothstep(SCAN_U.dofStart, SCAN_U.dofEnd, camDist);
    const backgroundBlurV = vertexStage(backgroundBlur) as N;
    const bokehScale = mix(float(1), SCAN_U.backgroundBokeh, backgroundBlur);
    const pop = smoothstep(0, 1, birth);
    material.scaleNode = camDist
      .mul(SCAN_U.screenScale)
      .clamp(SCAN_U.closeSize, 2.8)
      .mul(bokehScale)
      .mul(pop)
      .mul(dawnOut)
      .mul(inBounds);

    // Colour: cyan lattice, a sprinkling of warm returns, white-hot wavefront.
    const isAmber = smoothstep(1 - AMBER_FRACTION, 1 - AMBER_FRACTION + 0.001, seed);
    let glow: N = mix(
      vec3(CYAN.x, CYAN.y, CYAN.z),
      vec3(AMBER.x, AMBER.y, AMBER.z),
      isAmber
    );
    // Wavefront: the newest EDGE_GLOW_BAND metres burn brighter and whiter.
    const edge = saturate(
      float(1).sub((f.frontRadius as N).sub(dist).div(EDGE_GLOW_BAND))
    ).mul(birth.min(1));
    glow = mix(glow, vec3(1.0, 1.0, 1.0), edge.mul(0.38));

    // Outward-drifting pulse rings across the whole field + per-point twinkle.
    const pulse = sin(dist.mul(0.055).sub(time.mul(6)))
      .mul(0.5)
      .add(0.5)
      .pow(6)
      .mul(0.4);
    const twinkle = sin(time.mul(2.3).add(seed.mul(TAU * 9)))
      .mul(0.15)
      .add(0.9);
    // Defocused background returns lose energy as their footprint grows. The
    // live wavefront retains enough gain to remain a legible travelling ridge.
    const backgroundGain = mix(float(1), SCAN_U.backgroundBrightness, backgroundBlur);
    const depthGain = mix(backgroundGain, float(1), edge.mul(0.55));
    const intensity = float(LIGHT_SCALE)
      .mul(SCAN_U.brightness)
      .mul(twinkle.add(pulse))
      .mul(float(1).add(edge.mul(SCAN_U.edgeBoost)))
      .mul(depthGain);

    // instanceIndex-derived values must resolve in the vertex stage.
    const shaded = vertexStage(glow.mul(intensity).mul(pop).mul(dawnOut)) as N;

    // In-focus points are crisp pinpricks. Far points exchange the hot core for
    // a wide, low-energy lens disc, making terrain behind the focus ridge read
    // as depth rather than a flat wall of equally sharp dots.
    const d = (uv() as N).sub(0.5).length().mul(2);
    const crisp = saturate(d.oneMinus()).pow(2.25);
    const bokeh = saturate(d.oneMinus()).pow(1.25).mul(0.58);
    const profile = mix(crisp, bokeh, backgroundBlurV);
    const core = saturate(d.mul(1.75).oneMinus())
      .pow(5)
      .mul(0.55)
      .mul(backgroundBlurV.oneMinus());
    material.colorNode = vec4(shaded.mul(profile.add(core)), 1);

    material.transparent = true;
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.fog = false;

    const sprite = new THREE.Sprite(material);
    sprite.count = count;
    sprite.frustumCulled = false;
    sprite.renderOrder = 95;
    sprite.name = `terrainScanParticles.lod${sourceLod}`;
    return sprite;
  };

  const nearSprite = makeSprite(near, 0);
  const farSprite = makeSprite(far, 1);
  group.add(nearSprite);
  group.add(farSprite);

  return {
    group,
    count: near.length / 4 + far.length / 4,
    setVisible(visible: boolean): void {
      group.visible = visible;
    },
    dispose(): void {
      group.removeFromParent();
      for (const material of materials) material.dispose();
    }
  };
}
