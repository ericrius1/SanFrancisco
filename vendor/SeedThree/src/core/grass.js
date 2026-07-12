// Ground grass: instanced procedural blade clusters, PLAYER-CENTRIC density.
//
// The field is a lazy grid of world-space cells. Each cell deterministically
// generates its candidate tufts once (position, size, tint, rank, per-instance
// wind vector); a throttled rebin then keeps, per cell, the rank-prefix that
// matches the concentric density-ring profile around the CAMERA — dense where
// you stand, thinning outward, params live-tweakable via setGrassProfile.
// Because candidates are world-deterministic, thinning never makes grass
// "swim": a tuft either exists at its fixed spot or it doesn't.
//
// Pop hiding: the exact density cut runs ON THE GPU. Every instance carries
// its rank (aTint.w); the vertex shader compares it against the ring profile
// evaluated at the instance's true camera distance (camera uniform updates
// every frame) and scales tufts smoothly through the fadeBand. The CPU rebin
// only maintains a small superset (approach margin), so between rebins grass
// grows/shrinks continuously instead of popping.
//
// Wind/fade: per-instance aGrassAnchor = (anchorXYZ, heightAmp). In Three r185,
// positionNode receives the already-instanced mesh-local position. Fade must
// therefore scale around that explicit anchor (never around world origin), and
// world-space wind vectors are converted through modelWorldMatrixInverse.
//
// Vegetation staples kept from the original: vertex normals point straight UP
// (tufts inherit the terrain's lighting instead of flickering by card angle),
// per-instance tint variance breaks up tiling, backlit SSS translucency.

import {
  Group, InstancedMesh, InstancedBufferAttribute, BufferGeometry, BufferAttribute,
  MeshSSSNodeMaterial, Vector2, Vector4, Matrix4, DoubleSide, Color, DynamicDrawUsage,
} from 'three/webgpu';
import {
  attribute, cameraViewMatrix, color, normalize, positionGeometry,
  positionLocal, uniform, vec3, vec4, modelWorldMatrix, modelWorldMatrixInverse, mix,
} from 'three/tsl';
import { Rng } from './rng.js';
import { grassSway, WIND_DIR } from './wind.js';

// ---- density ring profile (module-global, shared by every grass field) -----

/** Concentric camera rings: piecewise-linear density (tufts/m²) by camera
 *  distance, then a fixed 40 m taper to zero past the last ring. Radii must
 *  ascend — setGrassProfile enforces it. */
export const GRASS_PROFILE = {
  rings: [
    { radius: 14, density: 0.9 },
    { radius: 30, density: 0.45 },
    { radius: 55, density: 0.15 },
    { radius: 90, density: 0.04 },
  ],
  /** GPU grow/shrink band as a FRACTION of the local visible density (the
   *  sparsest 15% of tufts at any distance are mid-fade) — proportional, so
   *  far sparse rings fade as smoothly as the dense near field */
  fadeBand: 0.15,
};
const TAIL = 40; // m past the last ring where density tapers to 0

const ringRadiiU = uniform(new Vector4());
const ringDensityU = uniform(new Vector4());
const fadeBandU = uniform(GRASS_PROFILE.fadeBand);

/** Wind bend profile: blade displacement ∝ localHeight^bendCurve. 2 = classic
 *  quadratic (base pinned, tips throw); higher = stiffer stalk, only the very
 *  tips move; toward 1 = the whole blade leans. Live-tweakable. */
export const grassBendCurve = uniform(2.0);

/** Albedo multiplier over the tuft texture × per-instance tint (linear space).
 *  Sunny-noon blowout knob: darken + green-bias without touching exposure. */
export const grassAlbedo = uniform(new Color(1, 1, 1));
/** Backlit-SSS glow scale (thicknessScaleNode) — the other blowout source. */
export const grassSSSScale = uniform(2.2);

// Ground conformance: tufts anchor to the LOWEST of five footprint height
// samples (center + 4 offsets) minus `sink`, and are culled outright when the
// footprint rise exceeds `slopeCull` meters. Wide tufts sampled only at their
// center overhang downhill edges on slopes — the "floating grass" layer that
// parallax then slides against the hill while walking.
const GROUNDING = { sink: 0.08, slopeCull: 1.2 };

/** Update grounding params; flushes every field's candidate cache (cells
 *  rebuild lazily, MAX_CELL_BUILDS_PER_REBIN per pass) only on real change. */
export function setGrassGrounding({ sink, slopeCull } = {}) {
  const s = sink ?? GROUNDING.sink, c = slopeCull ?? GROUNDING.slopeCull;
  if (s === GROUNDING.sink && c === GROUNDING.slopeCull) return;
  GROUNDING.sink = s;
  GROUNDING.slopeCull = c;
  for (const f of FIELDS) { f.cells.clear(); f.dirty = true; }
}

/** Show/hide one tuft silhouette (0 = wide fans, 1 = tall clumps) across all
 *  fields — mainly a diagnosis aid for telling the two layers apart. */
export function setGrassVariantVisible(index, visible) {
  for (const f of FIELDS) {
    const v = f.variants[index];
    if (v) v.mesh.visible = visible;
  }
}

function syncProfileUniforms() {
  const r = GRASS_PROFILE.rings;
  ringRadiiU.value.set(r[0].radius, r[1].radius, r[2].radius, r[3].radius);
  ringDensityU.value.set(r[0].density, r[1].density, r[2].density, r[3].density);
  fadeBandU.value = GRASS_PROFILE.fadeBand;
}
syncProfileUniforms();

/** CPU mirror of the shader's ring chain. */
export function grassDensityAt(d) {
  const r = GRASS_PROFILE.rings;
  const lin = (a, b, x) => Math.min(1, Math.max(0, (x - a) / Math.max(1e-3, b - a)));
  let f = r[0].density;
  f += (r[1].density - f) * lin(r[0].radius, r[1].radius, d);
  f += (r[2].density - f) * lin(r[1].radius, r[2].radius, d);
  f += (r[3].density - f) * lin(r[2].radius, r[3].radius, d);
  f += (0 - f) * lin(r[3].radius, r[3].radius + TAIL, d);
  return f;
}

const FIELDS = new Set(); // live fields, for profile changes / shadow toggles

/** Update rings/fadeBand at runtime; all live fields re-thin on their next
 *  frame. Radii are re-sorted to stay strictly ascending. */
export function setGrassProfile({ rings, fadeBand } = {}) {
  if (rings) {
    for (let i = 0; i < 4 && i < rings.length; i++) {
      if (rings[i]?.radius !== undefined) GRASS_PROFILE.rings[i].radius = rings[i].radius;
      if (rings[i]?.density !== undefined) GRASS_PROFILE.rings[i].density = rings[i].density;
    }
    for (let i = 1; i < 4; i++) {
      GRASS_PROFILE.rings[i].radius = Math.max(GRASS_PROFILE.rings[i].radius, GRASS_PROFILE.rings[i - 1].radius + 2);
    }
  }
  if (fadeBand !== undefined) GRASS_PROFILE.fadeBand = Math.max(0.02, fadeBand);
  syncProfileUniforms();
  for (const f of FIELDS) f.dirty = true;
}

/** Grass shadow casting (default OFF — tens of thousands of alpha-tested
 *  double-sided quads in the shadow pass for barely visible tuft shadows). */
export function setGrassShadows(cast) {
  for (const f of FIELDS) for (const v of f.variants) v.mesh.castShadow = cast;
}

// ---- geometry ----------------------------------------------------------------

// Bezier-curved blade clusters (y 0..1), base anchored. One instance is a
// small botanical clump made from several tapered ribbon blades; shader wind
// still bends every vertex by blade height, so roots stay planted.
function bladeClusterGeometry({ blades = 5, segments = 4, width = 0.055, radius = 0.32, curvature = 0.32, rake = 0.1 } = {}) {
  const positions = [], normals = [], uvs = [], indices = [];
  let base = 0;
  for (let b = 0; b < blades; b++) {
    const f = blades <= 1 ? 0 : b / blades;
    const yaw = f * Math.PI * 2 + (b % 2) * 0.47;
    const rootR = radius * (0.18 + 0.82 * ((b * 5.37) % 1));
    const rootA = yaw + 1.17;
    const rootX = Math.cos(rootA) * rootR;
    const rootZ = Math.sin(rootA) * rootR;
    const dx = Math.cos(yaw);
    const dz = Math.sin(yaw);
    const px = -dz;
    const pz = dx;
    const bend = curvature * (0.72 + 0.36 * ((b * 2.11) % 1));
    const bladeWidth = width * (0.72 + 0.45 * ((b * 3.19) % 1));

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const curve = 2 * (1 - t) * t * bend + t * rake;
      const cx = rootX + dx * curve;
      const cz = rootZ + dz * curve;
      const halfW = bladeWidth * (1 - t * 0.88) * 0.5;
      positions.push(cx - px * halfW, t, cz - pz * halfW);
      positions.push(cx + px * halfW, t, cz + pz * halfW);
      normals.push(0, 1, 0, 0, 1, 0);
      uvs.push(0, t, 1, t);
    }
    for (let i = 0; i < segments; i++) {
      const a = base + i * 2, c = base + (i + 1) * 2;
      indices.push(a, a + 1, c, a + 1, c + 1, c);
    }
    const tip = base + (segments + 1) * 2;
    const tipX = rootX + dx * rake;
    const tipZ = rootZ + dz * rake;
    positions.push(tipX, 1.04, tipZ);
    normals.push(0, 1, 0);
    uvs.push(0.5, 1);
    const last = base + segments * 2;
    indices.push(last, last + 1, tip);
    base = tip + 1;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

// Two botanical silhouettes: low lawn/mixed meadow clumps + taller seed-head
// tufts around collection edges.
const VARIANT_DEFS = [
  { blades: 5, segments: 4, width: 0.052, radius: 0.3, curvature: 0.24, rake: 0.05, share: 0.68, tall: 0.86 },
  { blades: 7, segments: 5, width: 0.07, radius: 0.42, curvature: 0.44, rake: 0.14, share: 0.32, tall: 1.28 },
];

// ---- cells ---------------------------------------------------------------------

// Candidate record layout (Float32Array stride):
// x y z | m00 m02 m20 m22 (yaw·scale 2×2, precomposed) | h | windAmp pad | r g b | rank | variant
const STRIDE = 15;

function buildCell(field, ix, iz) {
  const CS = field.cellSize;
  const rng = new Rng(`grass:${field.seed}:${ix},${iz}`);
  const out = [];
  for (let i = 0; i < field.cellAttempts; i++) {
    const x = (ix + rng.next()) * CS;
    const z = (iz + rng.next()) * CS;
    const rank = i / field.cellAttempts; // attempted-index rank → thinning stays uniform
    const r = Math.hypot(x, z);
    if (r > field.maxR) continue;
    const rocky = field.rocknessAt(x, z);
    if (rocky > rng.range(0.6, 0.95)) continue; // only the harshest scree stays bare
    // Sparse ring under a hero canopy (vendor app): trees shade out their own
    // understory. Fields without a center tree pass clearRadius 0.
    if (r < field.clearRadius && rng.next() > 0.18 + 0.82 * Math.max(0, (r - 1.2) / (field.clearRadius - 1.2))) continue;
    const variant = rng.next() < VARIANT_DEFS[0].share ? 0 : 1;
    const tall = VARIANT_DEFS[variant].tall;
    const yaw = rng.range(0, Math.PI * 2);
    const h = rng.range(0.34, 0.82) * (r > field.flatR ? 1.28 : 1) * tall;
    const sx = rng.range(0.75, 1.35);
    const sz = rng.range(0.75, 1.35);
    const c = Math.cos(yaw), s = Math.sin(yaw);
    // Ground conformance (see GROUNDING): anchor to the lowest of five
    // footprint samples so no blade base hangs in air, cull the tuft when the
    // footprint is steeper than slopeCull (crest/steep-slope tufts poke over
    // the silhouette and read as floaters while moving).
    const fx = 0.5 * sx, fz = 0.5 * sz;
    const h0 = field.heightAt(x, z);
    const h1 = field.heightAt(x - fx, z), h2 = field.heightAt(x + fx, z);
    const h3 = field.heightAt(x, z - fz), h4 = field.heightAt(x, z + fz);
    if (
      !Number.isFinite(h0) || !Number.isFinite(h1) || !Number.isFinite(h2) ||
      !Number.isFinite(h3) || !Number.isFinite(h4)
    ) continue;
    const hMin = Math.min(h0, h1, h2, h3, h4);
    if (Math.max(h0, h1, h2, h3, h4) - hMin > GROUNDING.slopeCull) continue;
    // Wind amplitude only. Direction stays canonical in world space and the
    // shader transforms its displacement as a vector after instancing.
    const amp = 0.7 + 0.35 * h;
    // Green meadow → dry straw-ORANGE as the ground turns rocky (shared noise:
    // the color gradient lands exactly where the scree appears), with wide
    // per-tuft variance and occasional dry clumps even in the meadow.
    const dry = Math.min(1, Math.max(0, (rocky - 0.15) * 1.6)) + (rng.next() < 0.1 ? 0.3 : 0);
    out.push(
      x, hMin - GROUNDING.sink, z,
      c * sx, s * sz, -s * sx, c * sz, // column-major yaw·scale: m[0], m[8], m[2], m[10]
      h,
      amp, 0,
      rng.range(0.55, 1.0) + dry * 0.45,            // R up
      rng.range(0.55, 1.25) * (1 - dry * 0.35),     // G down
      rng.range(0.45, 0.8) * (1 - dry * 0.55),      // B way down
      rank, variant,
    );
  }
  return { data: Float32Array.from(out), n: out.length / STRIDE };
}

// ---- rebin ---------------------------------------------------------------------

const REBIN_MS = 250;       // steady-state cadence while moving
const REBIN_STREAM_MS = 120; // cadence while cells are still streaming in
const REBIN_MOVE_SQ = 9;    // m² camera movement gate
const APPROACH_MARGIN = 8;  // m of camera approach the CPU superset covers
const MAX_CELL_BUILDS_PER_REBIN = 32; // amortize first-visit candidate generation

function rebin(field, camX, camZ) {
  for (const v of field.variants) v.cursor = 0;
  // nearest cells first: they matter most and win any budget contention
  for (const cell of field.cellOrder) {
    const dx = cell.cx - camX, dz = cell.cz - camZ;
    cell.d = Math.sqrt(dx * dx + dz * dz);
  }
  field.cellOrder.sort((a, b) => a.d - b.d);

  let builds = 0;
  field.pendingBuilds = false;
  for (const cell of field.cellOrder) {
    // superset margin: evaluate density at the cell's NEAREST plausible tuft
    // distance minus an approach allowance, so the GPU fade always has the
    // instances it needs between rebins (the GPU draws exactly rank < frac at
    // the TRUE per-tuft distance, so the margin only costs hidden instances)
    const dNear = Math.max(0, cell.d - field.cellHalfDiag - APPROACH_MARGIN);
    const dn = grassDensityAt(dNear);
    if (dn <= 0) continue;
    const frac = dn / field.ceiling;
    let built = field.cells.get(cell.key);
    if (!built) {
      if (builds >= MAX_CELL_BUILDS_PER_REBIN) { field.pendingBuilds = true; continue; }
      built = buildCell(field, cell.ix, cell.iz);
      field.cells.set(cell.key, built);
      builds++;
    }
    if (built.n === 0) continue;
    const a = built.data;
    for (let i = 0, o = 0; i < built.n; i++, o += STRIDE) {
      if (a[o + 13] >= frac) break; // ranks ascend → density prefix
      const v = field.variants[a[o + 14]];
      const j = v.cursor;
      if (j >= v.cap) continue;
      const me = v.mesh.instanceMatrix.array;
      let m = j * 16;
      me[m] = a[o + 3]; me[m + 1] = 0; me[m + 2] = a[o + 5]; me[m + 3] = 0;
      me[m + 4] = 0; me[m + 5] = a[o + 7 + 0]; me[m + 6] = 0; me[m + 7] = 0;
      me[m + 8] = a[o + 4]; me[m + 9] = 0; me[m + 10] = a[o + 6]; me[m + 11] = 0;
      me[m + 12] = a[o]; me[m + 13] = a[o + 1]; me[m + 14] = a[o + 2]; me[m + 15] = 1;
      const t = j * 4;
      v.tint.array[t] = a[o + 10]; v.tint.array[t + 1] = a[o + 11];
      v.tint.array[t + 2] = a[o + 12]; v.tint.array[t + 3] = a[o + 13];
      v.anchor.array[t] = a[o]; v.anchor.array[t + 1] = a[o + 1];
      v.anchor.array[t + 2] = a[o + 2]; v.anchor.array[t + 3] = a[o + 8];
      v.cursor++;
    }
  }
  for (const v of field.variants) {
    v.mesh.count = v.cursor;
    // FULL upload every rebin: the pack order changes each pass, so every slot
    // may hold a different tuft — partial ranges risk stale matrix/attr mixes
    // (tufts visibly teleporting), and the throttled cadence makes ~3 MB cheap.
    v.mesh.instanceMatrix.needsUpdate = true;
    v.tint.needsUpdate = true;
    v.anchor.needsUpdate = true;
  }
}

// ---- public build ----------------------------------------------------------------

/**
 * @param {object} opts {
 *   sampler, seed,
 *   flatRadius   — beyond it tufts grow 1.3× (matches wilder ground)
 *   clearRadius  — hero-tree understory clearing radius (0 = none; default 9
 *                  preserves the vendor app's root clearing)
 *   budget       — hard instance cap across both tuft variants (default 13000;
 *                  legacy `count` accepted as an alias)
 *   densityCeiling — tufts/m² the candidate cells are generated at; ring
 *                  densities saturate here (default 1.5× the peak ring)
 *   cellSize     — candidate cell edge, m (default 12)
 *   dynamic      — false builds the field once around the local origin and
 *                  ignores camera/player-driven density updates
 * }
 * @returns {Group|null} self-driving: rebins + camera uniform via onBeforeRender
 */
export function buildGrass(opts = {}) {
  const heightAt = opts.sampler?.heightAt ?? (() => 0);
  const rocknessAt = opts.sampler?.rocknessAt ?? (() => 0);
  // Reach out to the full caller-provided botanical mask. Placement rejection
  // keeps blades off paths, trunks, water, and off-garden ground.
  const maxR = Math.max(8, opts.sampler?.R ?? 75);
  const budget = opts.budget ?? opts.count ?? 13000;
  const cellSize = opts.cellSize ?? 12;
  const ceiling = opts.densityCeiling ?? Math.max(...GRASS_PROFILE.rings.map((r) => r.density)) * 1.5;
  const dynamic = opts.dynamic !== false;

  const mat = new MeshSSSNodeMaterial({
    side: DoubleSide,
    roughness: 0.92,
    metalness: 0,
  });
  const tintA = attribute('aTint', 'vec4');   // rgb tint, w = density rank
  const grassAnchor = attribute('aGrassAnchor', 'vec4'); // xyz = mesh-local root, w = wind amplitude
  const bladeT = positionGeometry.y.clamp(0, 1);
  const rootAo = bladeT.mul(0.38).add(0.62);
  const grassRoot = color(0x23551f);
  const grassTip = color(0x83b944);
  const bladeColor = mix(grassRoot, grassTip, bladeT.pow(0.82)).mul(tintA.xyz).mul(grassAlbedo).mul(rootAo);
  mat.colorNode = bladeColor;
  // Backlit translucency, same family as the leaves — low sun through the
  // meadow glows. Per-clump variance rides the tint's green channel.
  const transmit = uniform(new Color().setRGB(0.45, 0.65, 0.22));
  mat.thicknessColorNode = tintA.y.mul(bladeT.mul(0.7).add(0.3)).mul(transmit);
  mat.thicknessDistortionNode = uniform(0.4);
  mat.thicknessAmbientNode = uniform(0.06); // low floor — keeps per-tuft tints readable
  mat.thicknessAttenuationNode = uniform(1.0);
  mat.thicknessPowerNode = uniform(5.0);
  mat.thicknessScaleNode = grassSSSScale;

  // GPU density cut: ring profile at this instance's live camera distance vs
  // its rank → smooth grow/shrink through fadeBand (no popping between rebins).
  const camXZU = uniform(new Vector2(1e6, 1e6));
  const ceilingU = uniform(ceiling);
  const lin = (a, b, x) => x.sub(a).div(b.sub(a)).clamp(0, 1);
  const anchorLocal = grassAnchor.xyz;
  const anchorWorld = modelWorldMatrix.mul(vec4(anchorLocal, 1)).xyz;
  const dist = anchorLocal.xz.sub(camXZU).length();
  let dens = ringDensityU.x;
  dens = mix(dens, ringDensityU.y, lin(ringRadiiU.x, ringRadiiU.y, dist));
  dens = mix(dens, ringDensityU.z, lin(ringRadiiU.y, ringRadiiU.z, dist));
  dens = mix(dens, ringDensityU.w, lin(ringRadiiU.z, ringRadiiU.w, dist));
  dens = mix(dens, 0, lin(ringRadiiU.w, ringRadiiU.w.add(TAIL), dist));
  const frac = dens.div(ceilingU);
  const fade = frac.sub(tintA.w).div(frac.mul(fadeBandU).max(1e-4)).clamp(0, 1);

  // positionLocal is already instanced in r185. Shrink around the exact root,
  // and convert the world-space wind VECTOR with w=0 so parent transforms do
  // not rotate, scale, or translate the intended world displacement twice.
  const scaled = anchorLocal.add(positionLocal.sub(anchorLocal).mul(fade));
  const bendK = bladeT.pow(grassBendCurve).mul(fade);
  const bendWorld = vec3(WIND_DIR.x, 0, WIND_DIR.z)
    .mul(grassAnchor.w)
    .mul(grassSway(anchorWorld.xz))
    .mul(bendK);
  const bendLocal = modelWorldMatrixInverse.mul(vec4(bendWorld, 0)).xyz;
  mat.positionNode = scaled.add(bendLocal);

  // Explicit world-up normal via cameraViewMatrix: DoubleSide otherwise FLIPS
  // the vertex normal on back-facing quads → half the crossed blades shade
  // as if lit from below (the "weird grass shading"). The normal MAP rides on
  // top as a DELTA from the flat card normal (same trick as the leaf cards):
  // blade-strand relief survives, card orientation contributes nothing.
  const upView = cameraViewMatrix.mul(vec4(0, 1, 0, 0)).xyz;
  mat.normalNode = normalize(upView);

  const variants = VARIANT_DEFS.map((def) => {
    const cap = Math.max(64, Math.ceil(budget * def.share * 1.25));
    const mesh = new InstancedMesh(bladeClusterGeometry(def), mat, cap);
    mesh.count = 0;
    mesh.castShadow = false; // see setGrassShadows
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // field surrounds the camera; culling can't win
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    const tint = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    const anchor = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    tint.setUsage(DynamicDrawUsage);
    anchor.setUsage(DynamicDrawUsage);
    mesh.geometry.setAttribute('aTint', tint);
    mesh.geometry.setAttribute('aGrassAnchor', anchor);
    return { mesh, cap, cursor: 0, tint, anchor };
  });

  // all cells that can hold candidates (|center| ≤ maxR + half-diagonal)
  const cellHalfDiag = (cellSize * Math.SQRT2) / 2;
  const cellOrder = [];
  const nC = Math.ceil((maxR + cellSize) / cellSize);
  for (let iz = -nC; iz < nC; iz++) {
    for (let ix = -nC; ix < nC; ix++) {
      const cx = (ix + 0.5) * cellSize, cz = (iz + 0.5) * cellSize;
      if (Math.hypot(cx, cz) <= maxR + cellHalfDiag) {
        cellOrder.push({ ix, iz, cx, cz, key: `${ix},${iz}`, d: 0 });
      }
    }
  }

  const field = {
    seed: opts.seed ?? 1,
    cellSize,
    cellAttempts: Math.max(4, Math.round(cellSize * cellSize * ceiling)),
    cellHalfDiag,
    ceiling,
    maxR,
    flatR: opts.flatRadius ?? 15,
    clearRadius: opts.clearRadius ?? 9,
    heightAt,
    rocknessAt,
    cells: new Map(),
    cellOrder,
    variants,
    dirty: true,
    pendingBuilds: false,
    lastT: 0,
    lastX: 1e9,
    lastZ: 1e9,
    camXZU, // the material's camera-distance uniform — driveField writes it
    dynamic,
  };
  FIELDS.add(field);

  const group = new Group();
  group.name = 'grass';
  for (const v of variants) group.add(v.mesh);
  group.userData.dispose = () => FIELDS.delete(field);

  // Seed the field around the origin so the meshes are never empty before the
  // first camera-driven update. Static fields keep that origin forever, which
  // prevents the candidate repack from reading as a detached moving layer.
  if (dynamic) {
    rebin(field, 0, 0);
  } else {
    camXZU.value.set(0, 0);
    do rebin(field, 0, 0);
    while (field.pendingBuilds);
  }

  // dev probe (same spirit as window.__windProbe)
  if (typeof window !== 'undefined') (window.__grassFields ??= []).push(field);

  // Self-drive FALLBACK off the render loop for hosts that call plain
  // renderer.render (the SeedThree preview app): the driver mesh is
  // frustumCulled=false so it renders every frame; its onBeforeRender hands us
  // the live camera. Hosts with multiple perspective passes per frame
  // (minimaps, reflections, postfx prepasses) MUST drive updateGrassFields
  // with their gameplay camera instead — mixed cameras rebin the field and
  // slam the fade uniform back and forth, which reads as tufts teleporting.
  // Any recent external update suppresses the fallback.
  if (dynamic) {
    variants[0].mesh.onBeforeRender = (_renderer, _scene, camera) => {
      if (!camera.isPerspectiveCamera) return;
      if (performance.now() - lastExternalDrive < EXTERNAL_DRIVE_MS) return;
      const ce = camera.matrixWorld.elements;
      driveField(field, ce[12], ce[13], ce[14]);
    };
  }
  return group;
}

// ---- per-frame drive ----------------------------------------------------------

const EXTERNAL_DRIVE_MS = 1500; // external updates own the field for this long
let lastExternalDrive = 0;

const _inv = new Matrix4();

function driveField(field, camWorldX, camWorldY, camWorldZ) {
  if (!field.dynamic) return;
  const mesh = field.variants[0].mesh;
  // mesh-local anchor (meshes sit at the group origin, so this matches the
  // candidates' coordinate space)
  const e = _inv.copy(mesh.matrixWorld).invert().elements;
  const lx = e[0] * camWorldX + e[4] * camWorldY + e[8] * camWorldZ + e[12];
  const lz = e[2] * camWorldX + e[6] * camWorldY + e[10] * camWorldZ + e[14];
  const now = performance.now();
  // The GPU fade tracks the anchor through a short exponential smooth: raw
  // per-frame anchor jumps (respawns, camera-target switches) would make every
  // tuft near its fade threshold visibly pump scale in one frame.
  const u = field.camXZU.value;
  if (u.x > 9e5) u.set(lx, lz); // first real sample — snap, don't glide in from 1e6
  else {
    const dt = Math.min(0.1, (now - (field.lastDriveT || now)) / 1000);
    const a = 1 - Math.exp(-dt * 8);
    u.set(u.x + (lx - u.x) * a, u.y + (lz - u.y) * a);
  }
  field.lastDriveT = now;
  const interval = field.pendingBuilds ? REBIN_STREAM_MS : REBIN_MS;
  const dx = lx - field.lastX, dz = lz - field.lastZ;
  if (!field.dirty && now - field.lastT < interval) return;
  if (!field.dirty && !field.pendingBuilds && dx * dx + dz * dz < REBIN_MOVE_SQ) return;
  field.lastT = now;
  field.lastX = lx;
  field.lastZ = lz;
  field.dirty = false;
  rebin(field, lx, lz);
}

/**
 * Drive every grass field from ONE stable world-space anchor point — the
 * PLAYER (or chase target), not the camera. Chase cameras orbit their target
 * when the user looks around, and that positional swing would sweep every
 * tuft's ring distance a few meters per mouse flick — the ones inside the
 * fade band then pump scale continuously ("grass crawling everywhere").
 * Call once per frame before rendering. While called regularly, the
 * onBeforeRender fallback stays out of the way.
 */
export function updateGrassFieldsAt(worldPos) {
  lastExternalDrive = performance.now();
  for (const f of FIELDS) if (f.dynamic) driveField(f, worldPos.x, worldPos.y, worldPos.z);
}

/** Camera-object convenience wrapper (vendor preview app / legacy callers). */
export function updateGrassFields(camera) {
  lastExternalDrive = performance.now();
  const ce = camera.matrixWorld.elements;
  for (const f of FIELDS) if (f.dynamic) driveField(f, ce[12], ce[13], ce[14]);
}
