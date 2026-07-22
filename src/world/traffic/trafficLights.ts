import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { abs, attribute, float, mix, positionLocal, saturate, uniform } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { materializeAmount } from "../../render/materialize";
import type { WorldMap } from "../../world/heightmap";
import type { RoadGraph } from "./roadGraph.ts";
import type { TrafficSignal, TrafficSignalSystem } from "./trafficSignals.ts";

const MAX_VISIBLE = 120;
const VIEW_R = 260;

// --- rig anatomy (metres) — a simplified US mast-arm signal, sized to read
// next to a ~1.8 m player. Pole at the corner, arm out over the roadway, heads
// hanging under the arm with visored 3-lens stacks. -----------------------------
const POLE_H = 5.6;
const POLE_R_BOT = 0.16;
const POLE_R_TOP = 0.13;
const POLE_SEG = 10;
const ARM_Y = 5.15; // arm centre height (world metres above the corner ground)
const ARM_R_BASE = 0.11;
const ARM_R_TIP = 0.07;
const ARM_SEG = 8;
const BRACE_R = 0.05;
const HEAD_W = 0.44; // housing size: width (across arm), height, depth (toward driver)
const HEAD_H = 1.26;
const HEAD_D = 0.34;
const HEAD_CENTER_Y = ARM_Y - 0.72; // hangs just below the arm
const LENS_R = 0.15;
const LENS_Z = -(HEAD_D * 0.5 + 0.022); // just proud of the -Z (driver-facing) face
const LENS_YS = [0.42, 0, -0.42] as const; // red / amber / green stack
const CLEAR = 1.0; // pole set-back beyond the paved edge (m)
const MIN_HALF = 2.6;
const MAX_HALF = 12;

// Lit-lens bulge: the active bulb swells, the dim ones shrink (baked into the
// merged lens mesh's vertex shader, driven by the litState uniform).
const LENS_DIM_SCALE = 0.95;
const LENS_LIT_SCALE = 1.12;

// --- baked colours (linear working space via THREE.Color) ---------------------
// Steel pole/arm/brace vs the near-black head housing, mixed per-vertex on ONE
// shared MeshStandardMaterial so the whole gantry frame is a single draw.
const STEEL_COLOR = new THREE.Color(0x2b3033);
const HOUSING_COLOR = new THREE.Color(0x101316);
// index 0 = red, 1 = amber, 2 = green — matches LENS_YS and litState.
const LENS_DIM_COLORS = [new THREE.Color(0x420d0a), new THREE.Color(0x3a2a06), new THREE.Color(0x073a1a)] as const;
const LENS_LIT_COLORS = [
  new THREE.Color(0xff2b1f).multiplyScalar(LIGHT_SCALE * 0.64),
  new THREE.Color(0xffd23a).multiplyScalar(LIGHT_SCALE * 0.58),
  new THREE.Color(0x36ff7a).multiplyScalar(LIGHT_SCALE * 0.6)
] as const;

type LightRig = {
  // each rig is its own WebGPU render bundle: its 4 draws (2 gantries × {frame,
  // lenses}) collapse to one cached command buffer. Per-rig (not one pool-wide
  // bundle) so a rig only re-records when ITS assignment/geometry/visibility
  // changes — a standing player pays zero encode for the whole visible signal
  // set. Repositioning (transform) refreshes through the bundle as the object
  // modelMatrix; the lit lens (colour + bulge) is a per-gantry uniform that the
  // hasNode=true lens material re-uploads every frame during bundle REPLAY
  // (see NodeMaterialObserver.needsRefresh), so a mere phase change costs no
  // re-record either. Only structural changes bump needsUpdate (see update()).
  root: THREE.BundleGroup;
  axis0: SignalGantry;
  axis1: SignalGantry;
  sigId: number; // signal currently shown (-1 = none); a change forces a re-record
};

// A gantry is now just TWO meshes: the merged steel+housing frame and the merged
// six-lens (two heads × R/A/G) mesh. Both hang off gantry.root (yaw) which hangs
// off rig.root (world position). Per-axis visibility stays as gantry.root.visible.
type SignalGantry = {
  root: THREE.Group;
  frame: THREE.Mesh; // pole + arm + brace + both head housings (geometry swapped per plan)
  lenses: THREE.Mesh; // both heads' six lens discs (geometry swapped per plan)
  litState: LensUniform; // 0 = red, 1 = amber, 2 = green — drives the lit lens
};

// Per (signal, axis) cached layout. The heavy part — the merged frame + lens
// geometries that bake in the road-width-dependent pole offset, arm length and
// head positions — is built once and reused by whichever pool rig shows it.
type GantryPlan = {
  yaw: number;
  frameGeo: THREE.BufferGeometry;
  lensGeo: THREE.BufferGeometry;
};

type LensUniform = ReturnType<typeof uniform>;
// TSL node generics fight composition; any is the idiom here (see bayLights.ts).
type N = any;

const EMPTY_GEO = new THREE.BufferGeometry();

export class TrafficLightView {
  #scene: THREE.Scene;
  #map: WorldMap;
  #roads: RoadGraph;
  #signals: TrafficSignalSystem;
  #pool: LightRig[] = [];
  #near: TrafficSignal[] = [];
  #plans = new Map<number, GantryPlan | null>();
  #headTemplate: THREE.BufferGeometry; // housing shell, cloned + baked per plan
  #lensTemplate: THREE.BufferGeometry; // single lens disc facing −Z, cloned per lens
  // ONE shared frame material: steel vs housing comes from baked vertex colour,
  // so it stays a plain (hasNode=false) material and is skipped by the per-frame
  // bundle refresh — the frame is genuinely static between re-records.
  #frameMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.54, metalness: 0.45 });

  constructor(scene: THREE.Scene, map: WorldMap, roads: RoadGraph) {
    this.#scene = scene;
    this.#map = map;
    this.#roads = roads;
    this.#signals = roads.signals;
    this.#headTemplate = buildHeadGeo();
    this.#lensTemplate = new THREE.CircleGeometry(LENS_R, 14).rotateY(Math.PI); // face −Z (toward driver)
    for (let i = 0; i < MAX_VISIBLE; i++) {
      const rig = this.#makeRig();
      rig.root.visible = false;
      this.#pool.push(rig);
      this.#scene.add(rig.root);
    }
  }

  update(playerPos: THREE.Vector3, timeS: number): void {
    this.#signals.nearest(playerPos.x, playerPos.z, VIEW_R, MAX_VISIBLE, this.#near);
    for (let i = 0; i < this.#pool.length; i++) {
      const rig = this.#pool[i];
      const sig = this.#near[i];
      if (!sig) {
        // visible=false is checked before the bundle records/replays, so hiding an
        // unused rig needs no re-record; drop its assignment so a later reuse re-records.
        rig.root.visible = false;
        rig.sigId = -1;
        continue;
      }
      rig.root.visible = true;
      // position is a per-object uniform (modelMatrix) → refreshes through the bundle
      rig.root.position.set(sig.x, this.#map.effectiveGround(sig.x, sig.z), sig.z);
      let changed = rig.sigId !== sig.id;
      rig.sigId = sig.id;
      const c0 = this.#applyGantry(rig.axis0, sig, 0, timeS);
      const c1 = this.#applyGantry(rig.axis1, sig, 1, timeS);
      // structural change this frame (reassignment / geometry swap / visibility flip)
      // → re-record; a phase change alone only rewrites the litState uniform, which
      // the lens material carries into the replayed command buffer untouched.
      if (changed || c0 || c1) rig.root.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const rig of this.#pool) {
      this.#scene.remove(rig.root);
      // each gantry owns its lens material (its own litState uniform); free them.
      (rig.axis0.lenses.material as THREE.Material).dispose();
      (rig.axis1.lenses.material as THREE.Material).dispose();
    }
    this.#pool.length = 0;
    for (const plan of this.#plans.values()) {
      plan?.frameGeo.dispose();
      plan?.lensGeo.dispose();
    }
    this.#plans.clear();
    this.#frameMat.dispose();
    this.#headTemplate.dispose();
    this.#lensTemplate.dispose();
  }

  /** Returns true if a STRUCTURAL change happened (gantry visibility flip or a
   *  geometry swap) — the caller uses it to bump the rig bundle's needsUpdate.
   *  Transform-only changes (yaw, position) and the lit-lens state refresh through
   *  the bundle with no re-record (yaw/position as object uniforms, lit state as
   *  the lens material's litState uniform). */
  #applyGantry(gantry: SignalGantry, signal: TrafficSignal, axis: 0 | 1, timeS: number): boolean {
    const plan = this.#planFor(signal, axis);
    if (!plan) {
      const changed = gantry.root.visible !== false;
      gantry.root.visible = false;
      return changed;
    }
    let changed = gantry.root.visible !== true;
    gantry.root.visible = true;
    gantry.root.rotation.y = plan.yaw;
    if (gantry.frame.geometry !== plan.frameGeo) { gantry.frame.geometry = plan.frameGeo; changed = true; }
    if (gantry.lenses.geometry !== plan.lensGeo) { gantry.lenses.geometry = plan.lensGeo; changed = true; }
    // Both heads on a gantry share the axis state; one uniform lights the merged
    // lens mesh. This is a live uniform write (no re-record) — see LightRig.
    const state = this.#signals.stateForAxis(signal, axis, timeS);
    gantry.litState.value = state === "red" ? 0 : state === "yellow" ? 1 : 2;
    return changed;
  }

  #planFor(signal: TrafficSignal, axis: 0 | 1): GantryPlan | null {
    const key = signal.id * 2 + axis;
    const cached = this.#plans.get(key);
    if (cached !== undefined) return cached;
    const plan = this.#buildPlan(signal, axis);
    this.#plans.set(key, plan);
    return plan;
  }

  #buildPlan(signal: TrafficSignal, axis: 0 | 1): GantryPlan | null {
    const mine = signal.approaches.filter((a) => a.axis === axis);
    if (mine.length === 0) return null;
    const rep = mine[0];
    const yaw = Math.atan2(rep.tangentX, rep.tangentZ);
    // local frame after root rotation.y = yaw: +Z = road tangent (T), +X = the
    // approaching driver's right-hand side (P = T rotated −90°).
    const Tx = Math.sin(yaw);
    const Tz = Math.cos(yaw);
    const Px = Math.cos(yaw);
    const Pz = -Math.sin(yaw);

    let thisHalf = MIN_HALF;
    for (const a of mine) thisHalf = Math.max(thisHalf, a.halfWidth);
    let crossHalf = 0;
    for (const a of signal.approaches) if (a.axis !== axis) crossHalf = Math.max(crossHalf, a.halfWidth);
    thisHalf = Math.min(MAX_HALF, thisHalf);
    crossHalf = Math.min(MAX_HALF, crossHalf || thisHalf);

    // The pole belongs at a corner: clear THIS road along P and the CROSS road
    // along T. The ideal is the far-side right corner (+P, +T), but a dense,
    // irregular grid can bury that spot under a third street — so try all four
    // corners, push each diagonally out of the whole paved union, and
    // keep the one that ends up furthest from any pavement.
    const baseX = thisHalf + CLEAR;
    const baseZ = crossHalf + CLEAR;
    let best = { lx: baseX, lz: baseZ, score: -Infinity };
    for (const sx of [1, -1] as const) {
      for (const sz of [1, -1] as const) {
        let lx = sx * baseX;
        let lz = sz * baseZ;
        let clearance = 14;
        for (let iter = 0; iter < 5; iter++) {
          const wx = signal.x + lx * Px + lz * Tx;
          const wz = signal.z + lx * Pz + lz * Tz;
          clearance = this.#roads.pavementClearance(wx, wz, 20);
          if (clearance > 0.4 || !Number.isFinite(clearance)) break;
          // Move farther into this corner. Checking the full paved union matters
          // at skewed/wide junctions where the closest centreline can belong to
          // a narrow road even though the shaft is still inside a wider one.
          const length = Math.hypot(lx, lz) || 1;
          const step = 0.9 - clearance;
          lx += (lx / length) * step;
          lz += (lz / length) * step;
        }
        const pref = (sx === 1 ? 0.25 : 0) + (sz === 1 ? 0.15 : 0); // prefer far-side right
        const score = Math.min(clearance, 1.2) + pref; // cap so preference breaks near-ties
        if (score > best.score) best = { lx, lz, score };
      }
    }
    const poleLx = best.lx;
    const poleLz = best.lz;
    const sgn = poleLx >= 0 ? 1 : -1;

    // arm runs from the pole back over the roadway, a touch past the centreline
    const armFarLx = -sgn * 0.15 * thisHalf;
    const armLen = Math.abs(poleLx - armFarLx);
    const armCx = (poleLx + armFarLx) * 0.5;
    const headLx: [number, number] = [sgn * thisHalf * 0.5, -sgn * thisHalf * 0.05];

    const frameGeo = buildFrameGeo(poleLx, poleLz, armCx, armLen, headLx, this.#headTemplate);
    const lensGeo = buildLensGeo(poleLz, headLx, this.#lensTemplate);
    return { yaw, frameGeo, lensGeo };
  }

  #makeRig(): LightRig {
    const root = new THREE.BundleGroup();
    root.name = "TrafficLightRig";
    root.userData.trafficLightRig = true;

    // bundle children draw unconditionally (a bundle records each draw once, so a
    // per-child frustum test would freeze whatever the record-time camera saw); the
    // whole rig is culled as a unit by rig.root.visible (VIEW_R / nearest-N pool).
    const noCull = (m: THREE.Mesh) => { m.frustumCulled = false; return m; };

    const makeGantry = (name: string): SignalGantry => {
      const gantry = new THREE.Group();
      gantry.name = name;
      const frame = noCull(new THREE.Mesh(EMPTY_GEO, this.#frameMat));
      const { material: lensMat, litState } = makeLensMaterial();
      const lenses = noCull(new THREE.Mesh(EMPTY_GEO, lensMat));
      gantry.add(frame, lenses);
      root.add(gantry);
      return { root: gantry, frame, lenses, litState };
    };

    return { root, axis0: makeGantry("TrafficLightAxis0"), axis1: makeGantry("TrafficLightAxis1"), sigId: -1 };
  }
}

/** Fills a geometry with a flat per-vertex "color" (linear RGB) so several parts
 *  with different tints can share ONE vertex-coloured material after merging. */
function setVertexColor(geo: THREE.BufferGeometry, c: THREE.Color): void {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(arr, 3));
}

/** Bakes the per-lens data the merged lens material reads: dim colour ("color"),
 *  lit colour ("aLit"), stack id 0/1/2 ("aId", compared against the litState
 *  uniform) and the disc centre ("aCenter") the vertex shader scales about. */
function setLensAttrs(geo: THREE.BufferGeometry, id: number, dim: THREE.Color, lit: THREE.Color, cx: number, cy: number, cz: number): void {
  const n = geo.attributes.position.count;
  const dimArr = new Float32Array(n * 3);
  const litArr = new Float32Array(n * 3);
  const idArr = new Float32Array(n);
  const ctrArr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    dimArr[i * 3] = dim.r; dimArr[i * 3 + 1] = dim.g; dimArr[i * 3 + 2] = dim.b;
    litArr[i * 3] = lit.r; litArr[i * 3 + 1] = lit.g; litArr[i * 3 + 2] = lit.b;
    idArr[i] = id;
    ctrArr[i * 3] = cx; ctrArr[i * 3 + 1] = cy; ctrArr[i * 3 + 2] = cz;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(dimArr, 3));
  geo.setAttribute("aLit", new THREE.BufferAttribute(litArr, 3));
  geo.setAttribute("aId", new THREE.BufferAttribute(idArr, 1));
  geo.setAttribute("aCenter", new THREE.BufferAttribute(ctrArr, 3));
}

/** Unlit lens material for the merged six-lens mesh. One litState uniform (0/1/2)
 *  selects the lit stack: the matching lens takes its bright "aLit" colour and
 *  swells; the rest stay dim and shrink. Selection is branch-free (abs/saturate/
 *  mix, never If) so every arm's samples materialise — see project shadow lore on
 *  WGSL branch-node reuse. hasNode=true keeps the uniform live inside the bundle. */
function makeLensMaterial(): { material: THREE.MeshBasicNodeMaterial; litState: LensUniform } {
  const material = new THREE.MeshBasicNodeMaterial();
  const litState = uniform(0);
  const id = attribute("aId", "float") as N;
  const center = attribute("aCenter", "vec3") as N;
  const dim = attribute("color", "vec3") as N;
  const lit = attribute("aLit", "vec3") as N;
  // isLit = 1 when this lens's id equals litState, else 0 (ids differ by ≥1, so
  // saturate(|Δ|) is 0 for the match and 1 for every mismatch).
  const isLit = float(1).sub(saturate(abs(id.sub(litState)))) as N;
  // M15 void purity: lenses (the emissive part of a signal) stay black until
  // the materialize front crosses them — no lit reds/greens speckling the void
  // beyond the sweep. Collapses to 1 once the front parks at the revealed
  // sentinel, so settled shading is unchanged. The dark steel frame keeps its
  // plain material (hasNode=false bundle-skip optimization, see #frameMat).
  material.colorNode = mix(dim, lit, isLit).mul(materializeAmount() as N);
  const scale = mix(float(LENS_DIM_SCALE), float(LENS_LIT_SCALE), isLit) as N;
  material.positionNode = center.add(positionLocal.sub(center).mul(scale));
  return { material, litState };
}

/** Merged pole + tapered mast arm + angled brace strut + both head housings, in
 *  gantry-local space. Steel parts and the near-black housings carry different
 *  baked vertex colours so the whole frame renders as ONE draw. */
function buildFrameGeo(
  poleLx: number,
  poleLz: number,
  armCx: number,
  armLen: number,
  headLx: [number, number],
  headTemplate: THREE.BufferGeometry
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const pole = new THREE.CylinderGeometry(POLE_R_TOP, POLE_R_BOT, POLE_H, POLE_SEG);
  pole.translate(poleLx, POLE_H * 0.5, poleLz);
  setVertexColor(pole, STEEL_COLOR);
  parts.push(pole);

  // arm runs along local X; thick (base) end sits at the pole (+X)
  const arm = new THREE.CylinderGeometry(ARM_R_BASE, ARM_R_TIP, armLen, ARM_SEG);
  arm.rotateZ(-Math.PI * 0.5);
  arm.translate(armCx, ARM_Y, poleLz);
  setVertexColor(arm, STEEL_COLOR);
  parts.push(arm);

  // diagonal brace: pole (lower) up to the arm a short way out
  const braceA = new THREE.Vector3(poleLx, ARM_Y - 1.15, poleLz);
  const braceB = new THREE.Vector3(poleLx - 1.4, ARM_Y - 0.02, poleLz);
  const brace = cylBetween(braceA, braceB, BRACE_R);
  setVertexColor(brace, STEEL_COLOR);
  parts.push(brace);

  // both head housings, baked at their hanging positions under the arm
  for (const lx of headLx) {
    const housing = headTemplate.clone();
    housing.translate(lx, HEAD_CENTER_Y, poleLz);
    setVertexColor(housing, HOUSING_COLOR);
    parts.push(housing);
  }

  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return merged;
}

/** Merged six lens discs (two heads × red/amber/green) in gantry-local space.
 *  Each disc carries its dim + lit colours, stack id and centre so a single
 *  litState uniform can light exactly one stack per head. */
function buildLensGeo(poleLz: number, headLx: [number, number], lensTemplate: THREE.BufferGeometry): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cz = poleLz + LENS_Z;
  for (const lx of headLx) {
    for (let j = 0; j < 3; j++) {
      const cx = lx;
      const cy = HEAD_CENTER_Y + LENS_YS[j];
      const disc = lensTemplate.clone();
      disc.translate(cx, cy, cz);
      setLensAttrs(disc, j, LENS_DIM_COLORS[j], LENS_LIT_COLORS[j], cx, cy, cz);
      parts.push(disc);
    }
  }
  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return merged;
}

/** A capped cylinder of radius r spanning points a→b. */
function cylBetween(a: THREE.Vector3, b: THREE.Vector3, r: number): THREE.BufferGeometry {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length() || 1e-3;
  const geo = new THREE.CylinderGeometry(r, r, len, 6);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5),
    q,
    new THREE.Vector3(1, 1, 1)
  );
  geo.applyMatrix4(m);
  return geo;
}

/**
 * Shared signal-head shell (road-width independent): dark housing + a hooded
 * visor above each of the three lenses + a stub connecting up to the arm. The
 * visor lip is the single strongest "traffic signal" cue, so it is modelled.
 * Baked (per plan) into the gantry frame; the emissive lens discs live in the
 * separate merged lens mesh so their state can switch without touching this.
 */
function buildHeadGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const housing = new THREE.BoxGeometry(HEAD_W, HEAD_H, HEAD_D);
  parts.push(housing);

  const backplate = new THREE.BoxGeometry(HEAD_W + 0.16, HEAD_H + 0.14, 0.05);
  backplate.translate(0, 0, HEAD_D * 0.5 - 0.02);
  parts.push(backplate);

  for (const ly of LENS_YS) {
    const visor = new THREE.BoxGeometry(HEAD_W - 0.06, 0.06, 0.2);
    const m = new THREE.Matrix4()
      .makeRotationX(0.34)
      .setPosition(0, ly + 0.19, LENS_Z - 0.06);
    visor.applyMatrix4(m);
    parts.push(visor);
  }

  const stub = new THREE.BoxGeometry(0.1, 0.36, 0.1);
  stub.translate(0, HEAD_H * 0.5 + 0.14, 0);
  parts.push(stub);

  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return merged;
}
