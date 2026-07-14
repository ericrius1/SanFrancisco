import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LIGHT_SCALE } from "../../config";
import type { WorldMap } from "../../world/heightmap";
import type { RoadGraph } from "./roadGraph.ts";
import type { LightState, TrafficSignal, TrafficSignalSystem } from "./trafficSignals.ts";

const MAX_VISIBLE = 120;
const VIEW_R = 260;

// --- rig anatomy (metres) — a simplified US mast-arm signal, sized to read
// next to a ~1.8 m player. Pole at the corner, arm out over the lanes, heads
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

type LightRig = {
  // each rig is its own WebGPU render bundle: its ~18 pole/head/lens draws collapse
  // to one cached command buffer. Per-rig (not one pool-wide bundle) so a rig only
  // re-records when ITS assignment or signal phase changes — a standing player pays
  // zero encode for the whole visible signal set. Repositioning (transform), head
  // offsets (transform) and lens scale (transform) flow through the bundle via the
  // per-render uniform refresh; only structural changes (geometry swap, gantry
  // visibility flip, lit/dim material swap) bump needsUpdate (see update()).
  root: THREE.BundleGroup;
  axis0: SignalGantry;
  axis1: SignalGantry;
  sigId: number; // signal currently shown (-1 = none); a change forces a re-record
};

type SignalGantry = {
  root: THREE.Group;
  structure: THREE.Mesh; // merged pole + arm + brace (geometry swapped per plan)
  head0: SignalHead;
  head1: SignalHead;
};

type SignalHead = {
  root: THREE.Group;
  bulbs: Record<LightState, THREE.Mesh>;
};

// Per (signal, axis) cached layout. The heavy part — the merged structure
// geometry that bakes in the road-width-dependent pole offset and arm length —
// is built once and reused by whichever pool rig is showing that signal.
type GantryPlan = {
  yaw: number;
  geo: THREE.BufferGeometry;
  poleLz: number;
  headLx: [number, number];
};

const EMPTY_GEO = new THREE.BufferGeometry();

export class TrafficLightView {
  #scene: THREE.Scene;
  #map: WorldMap;
  #roads: RoadGraph;
  #signals: TrafficSignalSystem;
  #pool: LightRig[] = [];
  #near: TrafficSignal[] = [];
  #plans = new Map<number, GantryPlan | null>();
  #headGeo: THREE.BufferGeometry;
  #lensGeo: THREE.BufferGeometry;
  #steelMat = new THREE.MeshStandardMaterial({ color: 0x2b3033, roughness: 0.5, metalness: 0.55 });
  #headMat = new THREE.MeshStandardMaterial({ color: 0x101316, roughness: 0.62, metalness: 0.2 });
  #redDim = new THREE.MeshBasicMaterial({ color: 0x420d0a });
  #yellowDim = new THREE.MeshBasicMaterial({ color: 0x3a2a06 });
  #greenDim = new THREE.MeshBasicMaterial({ color: 0x073a1a });
  #redLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2b1f).multiplyScalar(LIGHT_SCALE * 0.64) });
  #yellowLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd23a).multiplyScalar(LIGHT_SCALE * 0.58) });
  #greenLit = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x36ff7a).multiplyScalar(LIGHT_SCALE * 0.6) });

  constructor(scene: THREE.Scene, map: WorldMap, roads: RoadGraph) {
    this.#scene = scene;
    this.#map = map;
    this.#roads = roads;
    this.#signals = roads.signals;
    this.#headGeo = buildHeadGeo();
    this.#lensGeo = new THREE.CircleGeometry(LENS_R, 14);
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
      // structural change this frame (reassignment / geometry swap / phase flip) →
      // re-record; otherwise the cached command buffer replays untouched.
      if (changed || c0 || c1) rig.root.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const rig of this.#pool) this.#scene.remove(rig.root);
    this.#pool.length = 0;
    for (const plan of this.#plans.values()) plan?.geo.dispose();
    this.#plans.clear();
    this.#headGeo.dispose();
    this.#lensGeo.dispose();
  }

  /** Returns true if a STRUCTURAL change happened (gantry visibility flip, geometry
   *  swap, or a lit/dim material swap) — the caller uses it to bump the rig bundle's
   *  needsUpdate. Transform-only changes (yaw, head offsets, lens scale) are omitted:
   *  they refresh through the bundle as uniforms with no re-record. */
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
    if (gantry.structure.geometry !== plan.geo) { gantry.structure.geometry = plan.geo; changed = true; }
    gantry.head0.root.position.set(plan.headLx[0], HEAD_CENTER_Y, plan.poleLz);
    gantry.head1.root.position.set(plan.headLx[1], HEAD_CENTER_Y, plan.poleLz);
    const state = this.#signals.stateForAxis(signal, axis, timeS);
    const c0 = this.#setBulbs(gantry.head0.bulbs, state);
    const c1 = this.#setBulbs(gantry.head1.bulbs, state);
    return changed || c0 || c1;
  }

  /** Returns true if any lens material reference changed (i.e. the signal state
   *  changed) — that is a pipeline swap the recorded bundle must re-capture. Lens
   *  scale is a transform and refreshes through the bundle without a re-record. */
  #setBulbs(bulbs: Record<LightState, THREE.Mesh>, state: LightState): boolean {
    const red = state === "red" ? this.#redLit : this.#redDim;
    const yellow = state === "yellow" ? this.#yellowLit : this.#yellowDim;
    const green = state === "green" ? this.#greenLit : this.#greenDim;
    const changed = bulbs.red.material !== red || bulbs.yellow.material !== yellow || bulbs.green.material !== green;
    bulbs.red.material = red;
    bulbs.yellow.material = yellow;
    bulbs.green.material = green;
    bulbs.red.scale.setScalar(state === "red" ? 1.12 : 0.95);
    bulbs.yellow.scale.setScalar(state === "yellow" ? 1.12 : 0.95);
    bulbs.green.scale.setScalar(state === "green" ? 1.12 : 0.95);
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

    // arm runs from the pole back over the lanes, a touch past the centreline
    const armFarLx = -sgn * 0.15 * thisHalf;
    const armLen = Math.abs(poleLx - armFarLx);
    const armCx = (poleLx + armFarLx) * 0.5;
    const headLx: [number, number] = [sgn * thisHalf * 0.5, -sgn * thisHalf * 0.05];

    const geo = buildStructureGeo(poleLx, poleLz, armCx, armLen);
    return { yaw, geo, poleLz, headLx };
  }

  #makeRig(): LightRig {
    const root = new THREE.BundleGroup();
    root.name = "TrafficLightRig";
    root.userData.trafficLightRig = true;

    // bundle children draw unconditionally (a bundle records each draw once, so a
    // per-child frustum test would freeze whatever the record-time camera saw); the
    // whole rig is culled as a unit by rig.root.visible (VIEW_R / nearest-N pool).
    const noCull = (m: THREE.Mesh) => { m.frustumCulled = false; return m; };

    const makeHead = (): SignalHead => {
      const head = new THREE.Group();
      const housing = noCull(new THREE.Mesh(this.#headGeo, this.#headMat));
      head.add(housing);
      const red = noCull(new THREE.Mesh(this.#lensGeo, this.#redDim));
      const yellow = noCull(new THREE.Mesh(this.#lensGeo, this.#yellowDim));
      const green = noCull(new THREE.Mesh(this.#lensGeo, this.#greenDim));
      const bulbs = { red, yellow, green } as Record<LightState, THREE.Mesh>;
      const order: LightState[] = ["red", "yellow", "green"];
      order.forEach((k, i) => {
        const m = bulbs[k];
        m.position.set(0, LENS_YS[i], LENS_Z);
        m.rotation.y = Math.PI; // face −Z (toward the approaching driver)
        head.add(m);
      });
      return { root: head, bulbs };
    };

    const makeGantry = (name: string): SignalGantry => {
      const gantry = new THREE.Group();
      gantry.name = name;
      const structure = noCull(new THREE.Mesh(EMPTY_GEO, this.#steelMat));
      gantry.add(structure);
      const head0 = makeHead();
      const head1 = makeHead();
      gantry.add(head0.root, head1.root);
      root.add(gantry);
      return { root: gantry, structure, head0, head1 };
    };

    return { root, axis0: makeGantry("TrafficLightAxis0"), axis1: makeGantry("TrafficLightAxis1"), sigId: -1 };
  }
}

/** Merged pole + tapered mast arm + angled brace strut, in gantry-local space. */
function buildStructureGeo(poleLx: number, poleLz: number, armCx: number, armLen: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const pole = new THREE.CylinderGeometry(POLE_R_TOP, POLE_R_BOT, POLE_H, POLE_SEG);
  pole.translate(poleLx, POLE_H * 0.5, poleLz);
  parts.push(pole);

  // arm runs along local X; thick (base) end sits at the pole (+X)
  const arm = new THREE.CylinderGeometry(ARM_R_BASE, ARM_R_TIP, armLen, ARM_SEG);
  arm.rotateZ(-Math.PI * 0.5);
  arm.translate(armCx, ARM_Y, poleLz);
  parts.push(arm);

  // diagonal brace: pole (lower) up to the arm a short way out
  const braceA = new THREE.Vector3(poleLx, ARM_Y - 1.15, poleLz);
  const braceB = new THREE.Vector3(poleLx - 1.4, ARM_Y - 0.02, poleLz);
  parts.push(cylBetween(braceA, braceB, BRACE_R));

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
 * Lenses (the emissive discs) are separate meshes so their material can swap.
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
