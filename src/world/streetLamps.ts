import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { color, mix, saturate, uniform, uv } from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { applyMaterialPolicy, RenderBand, tagTransparency } from "../render/transparency";
import type { WorldMap } from "./heightmap";
import type { RoadGraph } from "./traffic/roadGraph";

// TSL node generics fight composition; any is the idiom here (see bayLights.ts)
type N = any;

/**
 * Sky-driven overall brightness, rewritten every frame by Sky.#applySun next to
 * GOLDEN_GATE_LIGHTS_INTENSITY: 0 in daylight, ramping up through twilight so the
 * night streets read as lit pools instead of pitch black. These are FAKE lights —
 * no THREE.Light is created (a light-count change rebuilds every pipeline, a ~7s
 * freeze). The look is carried entirely by an additive ground disc (the pool), a
 * warm unlit bulb, and a dark standard-lit post.
 */
export const STREET_LAMPS_INTENSITY = uniform(0);

// --- lamp anatomy (metres) — a plain cobra-head street light, sized to a ~1.8 m
// player: vertical post, a short arm reaching out over the roadway, a small head
// box at the arm tip with the glowing bulb slung just beneath it. -----------------
const POST_H = 4.5;
const POST_R_BOT = 0.1;
const POST_R_TOP = 0.07;
const POST_SEG = 6;
const ARM_LEN = 2.0; // arm reach toward the road (local +X)
const ARM_Y = POST_H - 0.2; // arm centre height
const ARM_R = 0.05;
const HEAD_X = ARM_LEN; // arm tip / head centre (local +X)
const BULB_Y = ARM_Y - 0.28; // bulb hangs just under the head
const POOL_R = 6; // ground-pool disc radius
const LATERAL_PAD = 0.8; // extra set-back past the paved edge (m)

const CAP = 1024; // per-mesh instance capacity; nearest lamps win the slots
const REFRESH_MOVE = 30; // re-scan residency only after the player moves this far
const RESIDENT_R = 500; // residency scan radius around the player
const FILL_PER_FRAME = 128; // amortized residency fill: lamps placed per frame (~8 frames per refresh)
const RES_CELL = 64; // residency spatial-hash cell (m)
const DEDUP_CELL = 16; // build-time dedup spatial-hash cell (m)
const DEDUP_R = 12; // reject a candidate within this of an existing lamp (m)

function resKey(cx: number, cz: number): number {
  return (cx + 4096) * 8192 + (cz + 4096);
}

// deterministic 0..1 hash of two ints — drives per-lamp jitter with no RNG state
function hash2(a: number, b: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Merged post + arm + head box, in lamp-local space (arm points toward +X). */
function buildPostGeo(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];

  const post = new THREE.CylinderGeometry(POST_R_TOP, POST_R_BOT, POST_H, POST_SEG);
  post.translate(0, POST_H * 0.5, 0);
  parts.push(post);

  const arm = new THREE.CylinderGeometry(ARM_R, ARM_R, ARM_LEN, 5, 1, true);
  arm.rotateZ(-Math.PI * 0.5);
  arm.translate(ARM_LEN * 0.5, ARM_Y, 0);
  parts.push(arm);

  const head = new THREE.BoxGeometry(0.34, 0.24, 0.42);
  head.translate(HEAD_X, ARM_Y - 0.06, 0);
  parts.push(head);

  const merged = mergeGeometries(parts, false)!;
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Fake street-lamp pools. Walks every road segment (skipping elevated freeways),
 * drops posts along the kerb, and keeps only the nearest ~CAP resident to the
 * player as three InstancedMeshes (post / bulb / ground pool) — three draws total.
 */
export class StreetLamps {
  readonly group = new THREE.Group();
  #map: WorldMap;
  #posts: THREE.InstancedMesh;
  #bulbs: THREE.InstancedMesh;
  #discs: THREE.InstancedMesh;
  // flat lamp store, stride 4: x, z, towardRoadX, towardRoadZ (all placed lamps)
  #lamps: Float32Array;
  #count: number;
  #resCells = new Map<number, number[]>();
  #lastX = Infinity;
  #lastZ = Infinity;

  // scratch — reused every refresh to stay zero-alloc in the loop
  #mat = new THREE.Matrix4();
  #quat = new THREE.Quaternion();
  #nrm = new THREE.Vector3();
  #pos = new THREE.Vector3();
  #scl = new THREE.Vector3(1, 1, 1);
  #up = new THREE.Vector3(0, 0, 1); // CircleGeometry faces local +Z
  // residency-refresh scratch (reused — the old per-refresh {i,d2} object pushes
  // were measurable GC churn at driving speed) + the amortized fill state: the
  // ~CAP×3 terrain samples of a refresh used to land in ONE frame every ~30 m
  // of travel — a reliable ~1 s-cadence driving hitch. Now the gather+sort runs
  // on the trigger frame (cheap) and placements drain ≤FILL_PER_FRAME per
  // update(); the instance buffers upload once, at fill completion.
  #candI: number[] = [];
  #candD2: number[] = [];
  #order: number[] = [];
  #fillCursor = -1; // -1 = idle; else next #order rank to place
  #fillN = 0;

  constructor(scene: THREE.Scene, map: WorldMap, roads: RoadGraph) {
    this.#map = map;
    this.group.name = "StreetLamps";

    // ---- placement: walk the graph, drop kerb-side posts, dedup intersections
    const out: number[] = []; // x, z, towardX, towardZ …
    const dedup = new Map<number, number[]>(); // 16 m cells → placed lamp indices
    const A = { x: 0, z: 0 };
    const B = { x: 0, z: 0 };

    const tryPlace = (
      rx: number,
      rz: number,
      tx: number,
      tz: number,
      halfWidth: number,
      side: 1 | -1
    ) => {
      const tl = Math.hypot(tx, tz) || 1;
      const ux = tx / tl;
      const uz = tz / tl;
      // perpendicular (left of tangent), then the chosen side
      const ox = -uz * side;
      const oz = ux * side;
      const lateral = halfWidth + LATERAL_PAD;
      const lx = rx + ox * lateral;
      const lz = rz + oz * lateral;

      // dedup: reject if any placed lamp sits within DEDUP_R (kills the pile-up
      // where many short segments meet at an intersection)
      const cx = Math.floor(lx / DEDUP_CELL);
      const cz = Math.floor(lz / DEDUP_CELL);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const list = dedup.get(resKey(gx, gz));
          if (!list) continue;
          for (const li of list) {
            const dx = out[li * 4] - lx;
            const dz = out[li * 4 + 1] - lz;
            if (dx * dx + dz * dz < DEDUP_R * DEDUP_R) return;
          }
        }
      }

      const idx = out.length / 4;
      out.push(lx, lz, -ox, -oz); // toward-road = back across the offset
      const key = resKey(cx, cz);
      let cell = dedup.get(key);
      if (!cell) dedup.set(key, (cell = []));
      cell.push(idx);
    };

    const sampleTangent = (seg: number, s: number, len: number) => {
      const sA = s < len - 1 ? s : Math.max(0, s - 1);
      const p0 = roads.lookAhead(seg, 0, 1, sA);
      A.x = p0.x;
      A.z = p0.z;
      const p1 = roads.lookAhead(seg, 0, 1, sA + 1);
      B.x = p1.x;
      B.z = p1.z;
      return { tx: B.x - A.x, tz: B.z - A.z };
    };

    for (let seg = 0; seg < roads.segCount; seg++) {
      const meta = roads.segmentMeta(seg);
      if (meta.roadClass >= 5) continue; // elevated freeways — bridges already gone
      const len = meta.total;
      if (len < 8) continue;
      const step = meta.roadClass >= 3 ? 35 : 45;
      let placed = 0;
      let i = 0;
      for (let s = step * 0.5; s < len; s += step, i++) {
        const jitter = (hash2(seg, i) - 0.5) * step * 0.5;
        const ss = Math.min(len - 0.5, Math.max(0.5, s + jitter));
        const t = sampleTangent(seg, ss, len);
        const p = roads.lookAhead(seg, 0, 1, ss);
        const side: 1 | -1 = (i + seg) % 2 === 0 ? 1 : -1;
        tryPlace(p.x, p.z, t.tx, t.tz, meta.halfWidth, side);
        placed++;
      }
      // short blocks the stride skipped still want one lamp so no street goes dark
      if (placed === 0 && len >= 18) {
        const t = sampleTangent(seg, len * 0.5, len);
        const p = roads.lookAhead(seg, 0, 1, len * 0.5);
        tryPlace(p.x, p.z, t.tx, t.tz, meta.halfWidth, seg % 2 === 0 ? 1 : -1);
      }
    }

    this.#lamps = new Float32Array(out);
    this.#count = out.length / 4;

    // residency hash (64 m cells) for the per-move nearest-N scan
    for (let idx = 0; idx < this.#count; idx++) {
      const cx = Math.floor(this.#lamps[idx * 4] / RES_CELL);
      const cz = Math.floor(this.#lamps[idx * 4 + 1] / RES_CELL);
      const key = resKey(cx, cz);
      let cell = this.#resCells.get(key);
      if (!cell) this.#resCells.set(key, (cell = []));
      cell.push(idx);
    }

    // ---- meshes (three draws) --------------------------------------------------
    // a. POSTS — dark steel, standard-lit, matches the traffic-pole material
    const postGeo = buildPostGeo();
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x2b3033,
      roughness: 0.5,
      metalness: 0.55
    });
    this.#posts = new THREE.InstancedMesh(postGeo, postMat, CAP);

    // b. DISCS — additive ground pool, radial warm falloff scaled by intensity
    const discGeo = new THREE.CircleGeometry(POOL_R, 16);
    const discMat = new THREE.MeshBasicNodeMaterial();
    const d = uv().sub(0.5).length().mul(2); // 0 at centre → 1 at rim
    const falloff = saturate(d).oneMinus().pow(2) as N;
    discMat.colorNode = color(0xffb866).mul(falloff).mul(STREET_LAMPS_INTENSITY) as N;
    applyMaterialPolicy(discMat, "additiveWorld");
    discMat.toneMapped = false;
    discMat.fog = false;
    discMat.polygonOffset = true;
    discMat.polygonOffsetFactor = -2;
    discMat.polygonOffsetUnits = -2;
    this.#discs = new THREE.InstancedMesh(discGeo, discMat, CAP);
    // after road markings, still additive on top
    tagTransparency(this.#discs, { profile: "additiveWorld", renderBand: RenderBand.DECAL_ADDITIVE });

    // c. BULBS — small box under the head: dark glass by day, warm glow at night
    const bulbGeo = new THREE.BoxGeometry(0.22, 0.16, 0.28);
    bulbGeo.translate(HEAD_X, BULB_Y, 0);
    const bulbMat = new THREE.MeshBasicNodeMaterial();
    const lit = saturate(STREET_LAMPS_INTENSITY.div(LIGHT_SCALE)) as N;
    bulbMat.colorNode = mix(color(0x15181b), color(0xffcf99), lit) as N;
    bulbMat.toneMapped = false;
    this.#bulbs = new THREE.InstancedMesh(bulbGeo, bulbMat, CAP);

    for (const m of [this.#posts, this.#bulbs, this.#discs]) {
      m.frustumCulled = false;
      m.castShadow = false;
      m.receiveShadow = false;
      m.count = 0;
      this.group.add(m);
    }
    scene.add(this.group);
  }

  /** Placed-lamp total (across the whole city). */
  get placedCount(): number {
    return this.#count;
  }

  /** Currently resident (drawn) lamp count. */
  get residentCount(): number {
    return this.#posts.count;
  }

  update(playerPos: THREE.Vector3): void {
    // no additive draw by day — the intensity uniform is the on/off switch
    this.#discs.visible = STREET_LAMPS_INTENSITY.value > 0.01;
    if (this.#count === 0) return;

    this.#drainFill(); // an in-progress residency fill continues regardless of movement

    const dx = playerPos.x - this.#lastX;
    const dz = playerPos.z - this.#lastZ;
    if (dx * dx + dz * dz <= REFRESH_MOVE * REFRESH_MOVE) return;
    this.#lastX = playerPos.x;
    this.#lastZ = playerPos.z;

    // gather residency-cell lamps within RESIDENT_R, keep the nearest CAP so the
    // slots always fill inner-out (nearest lamps never lose to farther ones).
    // Parallel number arrays + an argsorted rank list — no per-candidate objects.
    const candI = this.#candI;
    const candD2 = this.#candD2;
    candI.length = 0;
    candD2.length = 0;
    const r2 = RESIDENT_R * RESIDENT_R;
    const pcx = Math.floor(playerPos.x / RES_CELL);
    const pcz = Math.floor(playerPos.z / RES_CELL);
    const cellR = Math.ceil(RESIDENT_R / RES_CELL);
    for (let cx = pcx - cellR; cx <= pcx + cellR; cx++) {
      for (let cz = pcz - cellR; cz <= pcz + cellR; cz++) {
        const list = this.#resCells.get(resKey(cx, cz));
        if (!list) continue;
        for (const idx of list) {
          const lx = this.#lamps[idx * 4] - playerPos.x;
          const lz = this.#lamps[idx * 4 + 1] - playerPos.z;
          const d2 = lx * lx + lz * lz;
          if (d2 <= r2) {
            candI.push(idx);
            candD2.push(d2);
          }
        }
      }
    }
    const order = this.#order;
    order.length = candI.length;
    for (let i = 0; i < order.length; i++) order[i] = i;
    order.sort((a, b) => candD2[a] - candD2[b]);
    // arm the amortized fill: placements (2 ground + 1 normal sample each) drain
    // over the next frames; the visible set holds the previous lamps meanwhile
    this.#fillN = Math.min(CAP, candI.length);
    this.#fillCursor = 0;
    this.#drainFill(); // first slice lands this frame
  }

  // Place up to FILL_PER_FRAME lamps of the armed refresh; on the last slice,
  // publish the new counts + upload the instance buffers ONCE.
  #drainFill(): void {
    if (this.#fillCursor < 0) return;
    const map = this.#map;
    const end = Math.min(this.#fillN, this.#fillCursor + FILL_PER_FRAME);
    for (let k = this.#fillCursor; k < end; k++) {
      const idx = this.#candI[this.#order[k]];
      const x = this.#lamps[idx * 4];
      const z = this.#lamps[idx * 4 + 1];
      const tx = this.#lamps[idx * 4 + 2];
      const tz = this.#lamps[idx * 4 + 3];
      const postY = map.effectiveGround(x, z);

      // post + bulb share a transform: local +X → toward-road, +Y up, plumb post
      this.#mat.makeBasis(
        this.#pos.set(tx, 0, tz), // X axis
        this.#nrm.set(0, 1, 0), // Y axis
        this.#scl.set(-tz, 0, tx) // Z axis (right-handed with the above)
      );
      this.#mat.setPosition(x, postY, z);
      this.#posts.setMatrixAt(k, this.#mat);
      this.#bulbs.setMatrixAt(k, this.#mat);
      this.#scl.set(1, 1, 1); // restore scale scratch after basis abuse

      // ground pool: centred under the arm tip, laid flat to the terrain normal
      const gx = x + tx * ARM_LEN;
      const gz = z + tz * ARM_LEN;
      const gy = map.effectiveGround(gx, gz) + 0.03;
      map.normal(gx, gz, this.#nrm);
      this.#quat.setFromUnitVectors(this.#up, this.#nrm);
      this.#mat.compose(this.#pos.set(gx, gy, gz), this.#quat, this.#scl);
      this.#discs.setMatrixAt(k, this.#mat);
    }
    this.#fillCursor = end;
    if (end < this.#fillN) return; // more slices next frames — no upload yet

    this.#fillCursor = -1;
    this.#posts.count = this.#fillN;
    this.#bulbs.count = this.#fillN;
    this.#discs.count = this.#fillN;
    this.#posts.instanceMatrix.needsUpdate = true;
    this.#bulbs.instanceMatrix.needsUpdate = true;
    this.#discs.instanceMatrix.needsUpdate = true;
  }
}
