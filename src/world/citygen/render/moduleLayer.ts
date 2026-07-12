// Instanced kit-of-parts window layer — the "whole city, six draw calls" path.
//
// Every faceWindow/shaftWindow a streamed detail building would have baked
// (~82 tris each, 60-80% of a building's triangles AND two of its draws) is
// instead ONE instance record on a city-wide instanced mesh per (module kind ×
// {trim, glass}) bucket. The template geometry carries AFFINE coefficients
// (position = c0 + cW·w + cH·h — see theme/moduleDefs.ts) evaluated per
// instance in the vertex stage, and the full wall-basis transform (origin +
// yaw + the building's proud scale) also rides per-instance attributes — we
// deliberately do NOT use InstancedMesh.instanceMatrix, because three applies
// the instance node BEFORE material.positionNode and the affine evaluation
// must happen inside the instance frame (NodeMaterial.setupPosition order).
// positionNode propagates into the shadow depth override, so the CSM cascades
// see the same transform (Renderer's materialOverride path).
//
// All attribute reads are BY NAME (attribute("aInstA") — the bladeGrass idiom),
// so the two shared materials serve every bucket and capacity growth can swap
// larger attribute buffers under the same names.
//
// Per-building CROSSFADE rides a shared fade/flags DataTexture, indexed by a
// per-instance slot id: fading a building is ONE texel write per frame — no
// material clones, no bundle re-records, no per-object refresh. Walls (still in
// per-building bundles for now) keep the alphaHash clone fade; both dither in
// the opaque pass, so the two systems stay visually in step. The G channel is a
// flag byte (bit0: hide glass — the "look out a real window" hook).
//
// Instances are never compacted: freed ones collapse to zero size and go on a
// free list, so population is bounded by the PEAK concurrent detail set, not by
// travel history.
import * as THREE from "three/webgpu";
import {
  float, vec3, uint, ivec2, mix, dot, normalize, smoothstep, step,
  cameraPosition, positionWorld, positionGeometry, attribute,
  textureLoad, vertexStage, transformNormalToView,
} from "three/tsl";
import { EXPOSURE_REBASE, LIGHT_SCALE } from "../../../config";
import { WINDOW_GLOW_W } from "../../facade";
import { moduleBuckets, BUCKET_GLASS, BUCKET_TRIM } from "../theme/moduleDefs";
import { MODULE_KIND_COUNT, type ModuleInstance } from "../core/types";
import { MODULE_TRIM_HEX } from "../theme/materials";
import { ZONES, type ParallaxZone } from "../theme/parallaxWindow";
import { rng } from "../core/rng";

// TSL node generics fight composition; `any` is this app's node-code idiom.
type N = any;

const FADE_TEX_SIZE = 64; // 4096 building slots
const INITIAL_CAPACITY = 4096;

export interface ModuleBuildingHandle {
  /** fade/flags slot — one texel drives every instance of this building */
  slot: number;
  setFade(v: number): void;
  /** bit0 of the flag byte: hide this building's glass (interior look-out) */
  setGlassHidden(hidden: boolean): void;
  free(): void;
}

export interface ModuleLayer {
  addBuilding(
    instances: readonly ModuleInstance[], matTable: readonly string[],
    opts: { matrix: THREE.Matrix4; zone: ParallaxZone; seed: number },
  ): ModuleBuildingHandle | null;
  /** live instance count across buckets (probe/debug) */
  stats(): { instances: number; capacity: number; buildings: number };
  dispose(): void;
}

// ---- fade/flags texture ---------------------------------------------------------

function makeFadeTexture(): THREE.DataTexture {
  const data = new Uint8Array(FADE_TEX_SIZE * FADE_TEX_SIZE * 2);
  for (let i = 0; i < data.length; i += 2) data[i] = 255; // fade=1, flags=0
  const tex = new THREE.DataTexture(data, FADE_TEX_SIZE, FADE_TEX_SIZE, THREE.RGFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

// ---- shared TSL -----------------------------------------------------------------

// Per-instance attributes (all read by NAME so buckets share the materials):
//   aInstA = (ox, oy, oz, w)         world origin (proud-transformed) + width
//   aInstB = (ax·s, az·s, h, slot)   scaled wall direction + height + fade slot
//   aInstT = (tint.rgb, sy)          trim colour / glass tint + vertical scale
//   aInstG = (glow.rgb)              precomputed lamp colour (glass only)
function moduleNodes(fadeTex: THREE.DataTexture) {
  const A = attribute("aInstA", "vec4") as N;
  const B = attribute("aInstB", "vec4") as N;
  const T = attribute("aInstT", "vec4") as N;
  const G = attribute("aInstG", "vec3") as N;
  // affine template evaluated at this instance's (w, h), in the module frame
  const cW = attribute("aModCW", "vec3") as N;
  const cH = attribute("aModCH", "vec3") as N;
  const local = (positionGeometry as N).add(cW.mul(A.w)).add(cH.mul(B.z));
  // wall basis: the +Y rotation mapping +X → along=(ax,az) maps +Z → (−az, ax),
  // which puts the wall's OUTWARD normal (az, −ax) at local −Z — exactly the
  // frame the templates are authored in (core/types.ModuleInstance). zImage is
  // rotate90 of B.xy, so it needs no extra attribute.
  const alongS = vec3(B.x, 0.0, B.y);
  const zImageS = vec3(B.y.negate(), 0.0, B.x);
  const world = vec3(A.xyz)
    .add(alongS.mul(local.x))
    .add(vec3(0.0, T.w, 0.0).mul(local.y))
    .add(zImageS.mul(local.z));
  // template normals rotate by the unit basis (normalize strips the scale)
  const nLocal = attribute("normal", "vec3") as N;
  const alongU = normalize(alongS);
  const zImageU = vec3(alongU.z.negate(), 0.0, alongU.x);
  const normalW = normalize(alongU.mul(nLocal.x).add(vec3(0.0, 1.0, 0.0).mul(nLocal.y)).add(zImageU.mul(nLocal.z)));
  // fade/flag texel for this building's slot (one write per building per frame)
  const slot = uint(B.w.add(0.5)) as N;
  const texel = textureLoad(fadeTex as unknown as N, ivec2(slot.bitAnd(uint(FADE_TEX_SIZE - 1)) as N, slot.shiftRight(uint(6)) as N) as N);
  return {
    positionNode: world,
    normalWorld: normalW,
    normalNode: transformNormalToView(normalW) as N,
    fade: vertexStage(texel.x) as N,
    glassHidden: vertexStage(texel.y) as N,
    tint: vertexStage(T.xyz) as N,
    glow: vertexStage(G.xyz) as N,
  };
}

function makeTrimMaterial(fadeTex: THREE.DataTexture): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.55, metalness: 0, side: THREE.DoubleSide });
  m.envMapIntensity = 5.5; // matches the theme's standard() ENV
  const nodes = moduleNodes(fadeTex);
  m.positionNode = nodes.positionNode;
  m.normalNode = nodes.normalNode;
  m.colorNode = nodes.tint;
  // same faint self-lit tint as the theme's shared trim materials (emissive 0.16)
  m.emissiveNode = nodes.tint.mul(float(0.16 * EXPOSURE_REBASE));
  m.opacityNode = nodes.fade;
  m.alphaHash = true; // dithered crossfade in the opaque pass (fade=1 → no discard)
  return m;
}

function makeGlassMaterial(fadeTex: THREE.DataTexture): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.14, metalness: 0, side: THREE.DoubleSide });
  m.envMapIntensity = 1.0;
  const nodes = moduleNodes(fadeTex);
  m.positionNode = nodes.positionNode;
  m.normalNode = nodes.normalNode;
  // day surface: zone-tinted dark glass lifted toward a sky sheen at grazing —
  // theme/parallaxWindow.ts ported onto per-instance attributes (tint + a
  // precomputed lamp glow) instead of the world-corner reconstruction hack.
  const nWorld = vertexStage(nodes.normalWorld) as N;
  const viewDir = normalize((positionWorld as N).sub(cameraPosition));
  const facing = dot(viewDir, nWorld).negate();
  const refl = viewDir.sub(nWorld.mul(dot(viewDir, nWorld).mul(2.0)));
  const skyCol = mix(vec3(0.339, 0.475, 0.637), vec3(0.693, 0.788, 0.885), refl.y.clamp(0.0, 1.0));
  const inv = facing.oneMinus().clamp(0.0, 1.0);
  const fresnel = inv.mul(inv).mul(inv);
  m.colorNode = mix(nodes.tint, skyCol, fresnel.mul(0.5));
  // night emissive: per-instance lamp colour (zero when unlit), gated by the
  // twilight weight + a grazing cutoff (sub-pixel emissive shimmer guard)
  const glowGraze = smoothstep(0.01, 0.06, facing);
  m.emissiveNode = nodes.glow.mul(float(2.0 * LIGHT_SCALE)).mul(glowGraze).mul(WINDOW_GLOW_W as N);
  m.metalnessNode = float(0.0);
  // fade × the hide-glass flag (interior look-out dithers the pane fully away)
  m.opacityNode = nodes.fade.mul(step(nodes.glassHidden, float(0.001)));
  m.alphaHash = true;
  return m;
}

// ---- per-bucket instanced mesh ----------------------------------------------------

interface Bucket {
  mesh: THREE.Mesh;
  geo: THREE.InstancedBufferGeometry;
  capacity: number;
  /** high-water instance count (geometry.instanceCount) */
  used: number;
  freeList: number[];
  a: THREE.InstancedBufferAttribute;
  b: THREE.InstancedBufferAttribute;
  t: THREE.InstancedBufferAttribute;
  g: THREE.InstancedBufferAttribute;
}

function makeBucket(kind: number, bucketId: string, material: THREE.Material, scene: THREE.Object3D): Bucket {
  const src = moduleBuckets(kind).find((b) => b.bucket === bucketId);
  if (!src) throw new Error(`module ${kind} has no ${bucketId} bucket`);
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(src.c0, 3)); // c0 rides the position slot
  geo.setAttribute("aModCW", new THREE.BufferAttribute(src.cW, 3));
  geo.setAttribute("aModCH", new THREE.BufferAttribute(src.cH, 3));
  geo.setAttribute("normal", new THREE.BufferAttribute(src.normals, 3));
  geo.setIndex(new THREE.BufferAttribute(src.indices, 1));
  const mk = (itemSize: number) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(INITIAL_CAPACITY * itemSize), itemSize);
    a.setUsage(THREE.StaticDrawUsage);
    return a;
  };
  const bucket: Bucket = {
    mesh: null as unknown as THREE.Mesh, geo, capacity: INITIAL_CAPACITY, used: 0, freeList: [],
    a: mk(4), b: mk(4), t: mk(4), g: mk(3),
  };
  geo.setAttribute("aInstA", bucket.a);
  geo.setAttribute("aInstB", bucket.b);
  geo.setAttribute("aInstT", bucket.t);
  geo.setAttribute("aInstG", bucket.g);
  geo.instanceCount = 0;
  const mesh = new THREE.Mesh(geo, material);
  mesh.name = `cityGenModules.${kind}.${bucketId === BUCKET_GLASS ? "glass" : "trim"}`;
  // Windows sit ON the walls, which already cast — their own shadow term is
  // invisible, but with frustumCulled=false every instance would re-render
  // into every CSM cascade (measured: the GPU wall that capped the detail ring).
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // instances span the whole detail ring; a lazily-computed bounding sphere
  // would mis-cull (the app-wide stale-bounds gotcha) — draw unconditionally.
  mesh.frustumCulled = false;
  // paint/cursor rays must land on the WALL behind the pane, and the template
  // geometry lies about its world position until the shader runs — opt out.
  mesh.raycast = () => {};
  bucket.mesh = mesh;
  scene.add(mesh);
  return bucket;
}

/** grow every instanced attribute ×2 — swaps larger buffers under the same
 *  attribute names (the geometry version bump rebinds; the node graph reads by
 *  name, so the shared materials never notice) */
function growBucket(bucket: Bucket): void {
  const cap = bucket.capacity * 2;
  const grow = (attr: THREE.InstancedBufferAttribute): THREE.InstancedBufferAttribute => {
    const next = new THREE.InstancedBufferAttribute(new Float32Array(cap * attr.itemSize), attr.itemSize);
    (next.array as Float32Array).set(attr.array as Float32Array);
    next.setUsage(THREE.StaticDrawUsage);
    return next;
  };
  bucket.a = grow(bucket.a);
  bucket.b = grow(bucket.b);
  bucket.t = grow(bucket.t);
  bucket.g = grow(bucket.g);
  bucket.geo.setAttribute("aInstA", bucket.a);
  bucket.geo.setAttribute("aInstB", bucket.b);
  bucket.geo.setAttribute("aInstT", bucket.t);
  bucket.geo.setAttribute("aInstG", bucket.g);
  bucket.capacity = cap;
}

// ---- the layer --------------------------------------------------------------------

const _pos = new THREE.Vector3();
const _color = new THREE.Color();

export function createModuleLayer(scene: THREE.Object3D): ModuleLayer {
  const fadeTex = makeFadeTexture();
  const fadeData = fadeTex.image.data as Uint8Array;
  const trimMat = makeTrimMaterial(fadeTex);
  const glassMat = makeGlassMaterial(fadeTex);

  // buckets are created lazily per module kind (victorian districts never touch
  // shaftWindow) — ≤6 meshes / 2 pipelines total
  const trimBuckets: (Bucket | null)[] = new Array(MODULE_KIND_COUNT).fill(null);
  const glassBuckets: (Bucket | null)[] = new Array(MODULE_KIND_COUNT).fill(null);
  const bucketFor = (kind: number, glass: boolean): Bucket => {
    const arr = glass ? glassBuckets : trimBuckets;
    let b = arr[kind];
    if (!b) arr[kind] = b = makeBucket(kind, glass ? BUCKET_GLASS : BUCKET_TRIM, glass ? glassMat : trimMat, scene);
    return b;
  };

  // Pipeline warmup: materialize the faceWindow buckets NOW with one zero-size
  // instance each, so both pipelines (trim + glass — shared by every bucket,
  // the attribute layouts are identical) compile behind the boot cover instead
  // of on the first driven-up-to building.
  for (const glass of [false, true]) {
    const b = bucketFor(0, glass);
    if (b.used === 0) { b.used = 1; b.geo.instanceCount = 1; b.freeList.push(0); }
  }

  // slot allocator
  const freeSlots: number[] = [];
  let nextSlot = 0;
  let liveBuildings = 0;
  const allocSlot = (): number => {
    const s = freeSlots.pop() ?? nextSlot++;
    return s < FADE_TEX_SIZE * FADE_TEX_SIZE ? s : -1;
  };
  const writeSlot = (slot: number, fade: number | null, flags: number | null): void => {
    const o = slot * 2;
    if (fade !== null) fadeData[o] = Math.max(0, Math.min(255, Math.round(fade * 255)));
    if (flags !== null) fadeData[o + 1] = flags;
    fadeTex.needsUpdate = true;
  };

  const takeIndex = (b: Bucket): number => {
    const idx = b.freeList.pop();
    if (idx !== undefined) return idx;
    if (b.used >= b.capacity) growBucket(b);
    const i = b.used++;
    b.geo.instanceCount = b.used;
    return i;
  };

  const writeInstance = (
    b: Bucket, idx: number, inst: ModuleInstance, matrix: THREE.Matrix4, slot: number,
    tint: THREE.Color, glow: THREE.Color,
  ): void => {
    // fold the building's proud transform (axis-aligned scale about its centroid
    // + a seeded nudge — never a rotation) into the instance basis: transform
    // the origin as a point, scale the basis axes by the matrix diagonal.
    const el = matrix.elements;
    const sx = el[0], sy = el[5];
    _pos.set(inst.ox, inst.oy, inst.oz).applyMatrix4(matrix);
    const aArr = b.a.array as Float32Array;
    aArr[idx * 4] = _pos.x; aArr[idx * 4 + 1] = _pos.y; aArr[idx * 4 + 2] = _pos.z; aArr[idx * 4 + 3] = inst.w;
    b.a.addUpdateRange(idx * 4, 4);
    b.a.needsUpdate = true;
    const bArr = b.b.array as Float32Array;
    bArr[idx * 4] = inst.ax * sx; bArr[idx * 4 + 1] = inst.az * sx; bArr[idx * 4 + 2] = inst.h; bArr[idx * 4 + 3] = slot;
    b.b.addUpdateRange(idx * 4, 4);
    b.b.needsUpdate = true;
    const tArr = b.t.array as Float32Array;
    tArr[idx * 4] = tint.r; tArr[idx * 4 + 1] = tint.g; tArr[idx * 4 + 2] = tint.b; tArr[idx * 4 + 3] = sy;
    b.t.addUpdateRange(idx * 4, 4);
    b.t.needsUpdate = true;
    const gArr = b.g.array as Float32Array;
    gArr[idx * 3] = glow.r; gArr[idx * 3 + 1] = glow.g; gArr[idx * 3 + 2] = glow.b;
    b.g.addUpdateRange(idx * 3, 3);
    b.g.needsUpdate = true;
  };

  const releaseInstance = (b: Bucket, idx: number): void => {
    // collapse to a zero-size module → zero-area triangles, nothing rasterizes
    const aArr = b.a.array as Float32Array;
    aArr[idx * 4 + 3] = 0;
    b.a.addUpdateRange(idx * 4, 4);
    b.a.needsUpdate = true;
    const bArr = b.b.array as Float32Array;
    bArr[idx * 4] = 0; bArr[idx * 4 + 1] = 0; bArr[idx * 4 + 2] = 0;
    b.b.addUpdateRange(idx * 4, 4);
    b.b.needsUpdate = true;
    b.freeList.push(idx);
  };

  return {
    addBuilding(instances, matTable, opts) {
      if (!instances.length) return null;
      const slot = allocSlot();
      if (slot < 0) return null; // slot texture full — caller falls back to baked expansion
      const zone = ZONES[opts.zone] ?? ZONES.residential;
      const jitter = rng(opts.seed, 137);
      const placed: [Bucket, number][] = [];
      const glassTint = new THREE.Color(zone.glass);
      const warm = new THREE.Color(zone.light[0]);
      const cool = new THREE.Color(zone.light[1]);
      const lamp = new THREE.Color();
      const zero = new THREE.Color(0, 0, 0);
      for (const inst of instances) {
        const tb = bucketFor(inst.module, false);
        const ti = takeIndex(tb);
        const trimHex = MODULE_TRIM_HEX[matTable[inst.trim]] ?? MODULE_TRIM_HEX["trim.victorian"];
        writeInstance(tb, ti, inst, opts.matrix, slot, _color.set(trimHex), zero);
        placed.push([tb, ti]);
        // per-pane lit/lamp identity precomputed here (replaces the old
        // shader-side world-corner hash — same litChance/lamp mix per zone)
        const gb = bucketFor(inst.module, true);
        const gi = takeIndex(gb);
        const lit = jitter() < zone.litChance;
        if (lit) lamp.copy(warm).lerp(cool, jitter()); else { jitter(); lamp.copy(zero); }
        writeInstance(gb, gi, inst, opts.matrix, slot, glassTint, lamp);
        placed.push([gb, gi]);
      }
      liveBuildings++;
      writeSlot(slot, 0.02, 0); // born fading (the ring fades every build in)
      let freed = false;
      return {
        slot,
        setFade(v) { writeSlot(slot, v, null); },
        setGlassHidden(hidden) { writeSlot(slot, null, hidden ? 1 : 0); },
        free() {
          if (freed) return;
          freed = true;
          for (const [b, idx] of placed) releaseInstance(b, idx);
          writeSlot(slot, 1, 0);
          freeSlots.push(slot);
          liveBuildings--;
        },
      };
    },
    stats() {
      let instances = 0, capacity = 0;
      for (const b of [...trimBuckets, ...glassBuckets]) {
        if (!b) continue;
        instances += b.used - b.freeList.length;
        capacity += b.capacity;
      }
      return { instances, capacity, buildings: liveBuildings };
    },
    dispose() {
      for (const b of [...trimBuckets, ...glassBuckets]) {
        if (!b) continue;
        scene.remove(b.mesh);
        b.geo.dispose();
      }
      trimMat.dispose();
      glassMat.dispose();
      fadeTex.dispose();
    },
  };
}
