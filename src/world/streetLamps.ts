import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  attribute,
  cameraPosition,
  color,
  float,
  mix,
  positionWorld,
  saturate,
  smoothstep,
  uniform,
  uv,
  vertexStage
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { applyHoloBirth, materializeAmount } from "../render/materialize";
import {
  MAX_PROJECTED_SURFACE_LIGHTS,
  type ProjectedSurfaceLightSource
} from "../render/projectedSurfaceLightTypes";
import type { WorldMap } from "./heightmap";
import { STREET_LIGHT_TUNING } from "./streetLightTuning";
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
const ROAD_CLEARANCE = 0.35; // pole-base clearance beyond every paved edge (m)

const CAP = 1024; // per-mesh instance capacity; nearest lamps win the slots
const REFRESH_MOVE = 30; // re-scan residency only after the player moves this far
const RESIDENT_R = 500; // residency scan radius around the player
const LAMP_FADE_IN = 1.1; // seconds a newly resident pool takes to reach full glow
const HERO_FULL_R = 55; // depth-projected lighting is fully weighted nearby
const HERO_END_R = 85; // cheap disc has fully taken over by here
// Include one residency-refresh movement of headroom so the same selected lamp
// can cross the whole blend band without waiting for a rescan.
const HERO_SELECT_R = HERO_END_R + REFRESH_MOVE;
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
  readonly projectedSurfaceLightSource: ProjectedSurfaceLightSource;
  #map: WorldMap;
  #posts: THREE.InstancedMesh;
  #bulbs: THREE.InstancedMesh;
  #discs: THREE.InstancedMesh;
  #discProjected: THREE.InstancedBufferAttribute;
  #lampFadeAttr: THREE.InstancedBufferAttribute;
  #projectionReady = uniform(0);
  #poolStrength = uniform(STREET_LIGHT_TUNING.values.strength);
  #falloffPower = uniform(STREET_LIGHT_TUNING.values.falloffPower);
  // residency-edge fade: pools dim to nothing before the resident-set boundary,
  // so refresh pops land where the disc is already invisible
  #now = uniform(0);
  #fadeCenter = uniform(new THREE.Vector2());
  #fadeStart = uniform(RESIDENT_R * 0.66);
  #fadeEnd = uniform(RESIDENT_R * 0.92);
  #nextEdge = RESIDENT_R;
  // lamp idx → first-resident timestamp (s); survives refreshes while the lamp
  // stays resident so a mid-fade lamp never restarts its fade
  #birth = new Map<number, number>();
  #nextBirth = new Map<number, number>();
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
  #heroCount = 0;
  #nextHeroCount = 0;
  #heroPositions = Array.from(
    { length: MAX_PROJECTED_SURFACE_LIGHTS },
    () => new THREE.Vector4()
  );
  #heroNormals = Array.from(
    { length: MAX_PROJECTED_SURFACE_LIGHTS },
    () => new THREE.Vector4(0, 1, 0, 0)
  );
  #heroBirth = new Float32Array(MAX_PROJECTED_SURFACE_LIGHTS);
  #nextHeroBirth = new Float32Array(MAX_PROJECTED_SURFACE_LIGHTS);
  #nextHeroPositions = Array.from(
    { length: MAX_PROJECTED_SURFACE_LIGHTS },
    () => new THREE.Vector4()
  );
  #nextHeroNormals = Array.from(
    { length: MAX_PROJECTED_SURFACE_LIGHTS },
    () => new THREE.Vector4(0, 1, 0, 0)
  );
  #viewX = Infinity;
  #viewZ = Infinity;

  constructor(scene: THREE.Scene, map: WorldMap, roads: RoadGraph) {
    this.#map = map;
    this.group.name = "StreetLamps";
    const owner = this;
    this.projectedSurfaceLightSource = {
      get active() {
        return owner.#projectedLightingActive();
      },
      get count() {
        return owner.#heroCount;
      },
      get intensity() {
        return Number(STREET_LAMPS_INTENSITY.value);
      },
      get resolutionScale() {
        return STREET_LIGHT_TUNING.values.resolutionScale;
      },
      get strength() {
        return STREET_LIGHT_TUNING.values.strength;
      },
      get falloffPower() {
        return STREET_LIGHT_TUNING.values.falloffPower;
      },
      get heightReach() {
        return STREET_LIGHT_TUNING.values.heightReach;
      },
      copyLight(index, positionAndRadius, normalAndWeight) {
        owner.#copyProjectedLight(index, positionAndRadius, normalAndWeight);
      },
      setViewPosition(position) {
        owner.#viewX = position.x;
        owner.#viewZ = position.z;
      },
      setProjectionReady(ready) {
        owner.#projectionReady.value = ready ? 1 : 0;
      }
    };

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

      // A point outside this segment can still land inside a crossing street or
      // the neighbouring carriageway of a divided road. Check the complete road
      // graph, not just the segment that proposed the lamp, and leave those
      // conflict areas empty rather than putting a pole in live pavement.
      if (roads.pavementClearance(lx, lz, lateral + ROAD_CLEARANCE + 1) < ROAD_CLEARANCE) return;

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
    const postMat = new THREE.MeshStandardNodeMaterial({
      color: 0x2b3033,
      roughness: 0.5,
      metalness: 0.55
    });
    // M15 void purity: posts are world fabric — beyond the sweeping front they
    // render the shared holo language (near-black past the edge window) instead
    // of a sunlit pole against the void. Inert once settled (front sentinel).
    applyHoloBirth(postMat);
    this.#posts = new THREE.InstancedMesh(postGeo, postMat, CAP);

    // b. DISCS — additive ground pool, radial warm falloff scaled by intensity
    const discGeo = new THREE.CircleGeometry(POOL_R, 16);
    this.#discProjected = new THREE.InstancedBufferAttribute(
      new Float32Array(CAP),
      1
    );
    discGeo.setAttribute("surfaceProjected", this.#discProjected);
    this.#lampFadeAttr = new THREE.InstancedBufferAttribute(
      new Float32Array(CAP * 2),
      2
    );
    discGeo.setAttribute("lampFade", this.#lampFadeAttr);
    const discMat = new THREE.MeshBasicNodeMaterial();
    const d = uv().sub(0.5).length().mul(2); // 0 at centre → 1 at rim
    // A cubic Hermite ramp is C1-continuous at the rim. Compared with the old
    // quadratic cutoff it leaves a longer, gentler low-energy tail, so pools no
    // longer read as bright decals floating just above the road while driving.
    const falloff = smoothstep(0, 1, saturate(d))
      .oneMinus()
      .pow(this.#falloffPower) as N;
    // For the selected close set, crossfade this geometry-only fallback out as
    // the depth-aware pass fades in. Distance is evaluated at the vertices and
    // interpolated across the 16-gon, avoiding a per-fragment square root.
    const projected = attribute("surfaceProjected", "float") as N;
    const distance = vertexStage(
      (positionWorld as N).distance(cameraPosition)
    ) as N;
    const closeWeight = smoothstep(HERO_FULL_R, HERO_END_R, distance).oneMinus();
    const discWeight = float(1).sub(
      projected.mul(closeWeight).mul(this.#projectionReady as N)
    );
    // x = first-resident timestamp (s), y = per-lamp brightness jitter
    const lampFade = attribute("lampFade", "vec2") as N;
    // Residency-edge fade, measured from the live player (the residency centre),
    // NOT the camera: from a plane every disc is hundreds of metres from the
    // camera, but only lamps near the resident-set boundary should dim.
    const fadeDist = vertexStage(
      (positionWorld as N).xz.sub(this.#fadeCenter as N).length()
    ) as N;
    const edgeFade = smoothstep(
      this.#fadeStart as N,
      this.#fadeEnd as N,
      fadeDist
    ).oneMinus();
    const bornFade = smoothstep(
      lampFade.x,
      lampFade.x.add(LAMP_FADE_IN),
      this.#now as N
    );
    // Per-channel Reinhard knee BEFORE any crossfade weight: the raw peak
    // (~4.8 linear) used to clip flat on the tone-map shoulder, reading as a
    // solid decal from altitude. The knee keeps a hot slightly-whitened core
    // with a visible gradient. The projected pass applies the identical knee
    // per light, weights outside, so the 55–85 m crossfade stays matched.
    const litRaw = color(0xffb866)
      .mul(falloff)
      .mul(lampFade.y)
      .mul(this.#poolStrength)
      .mul(STREET_LAMPS_INTENSITY) as N;
    // M15 void purity: the pool only lights up once the materialize front has
    // crossed it (per-vertex front amount, interpolated across the 16-gon like
    // the other vertexStage terms). Collapses to 1 at the revealed sentinel.
    const discFrontAmt = vertexStage(materializeAmount()) as N;
    discMat.colorNode = litRaw
      .div(litRaw.add(1))
      .mul(discWeight)
      .mul(edgeFade)
      .mul(bornFade)
      .mul(discFrontAmt) as N;
    discMat.transparent = true;
    discMat.blending = THREE.AdditiveBlending;
    discMat.depthWrite = false;
    discMat.toneMapped = false;
    discMat.fog = false;
    discMat.polygonOffset = true;
    // This renderer uses reversed depth: positive offset pulls the fallback
    // toward the camera. Negative values pushed it into roads and sidewalks.
    discMat.polygonOffsetFactor = 2;
    discMat.polygonOffsetUnits = 2;
    this.#discs = new THREE.InstancedMesh(discGeo, discMat, CAP);
    // after road markings, still additive on top
    this.#discs.renderOrder = 21;

    // c. BULBS — small box under the head: dark glass by day, warm glow at night
    const bulbGeo = new THREE.BoxGeometry(0.22, 0.16, 0.28);
    bulbGeo.translate(HEAD_X, BULB_Y, 0);
    const bulbMat = new THREE.MeshBasicNodeMaterial();
    const lit = saturate(STREET_LAMPS_INTENSITY.div(LIGHT_SCALE)) as N;
    // M15 void purity: bulbs stay dark glass until the front crosses them —
    // the warm night glow (and the daylight glass tint) is front-gated so no
    // orange points speckle the void horizon during a sweep.
    const bulbFrontAmt = vertexStage(materializeAmount()) as N;
    bulbMat.colorNode = mix(color(0x15181b), color(0xffcf99), lit).mul(
      bulbFrontAmt
    ) as N;
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
    // Tweakpane writes plain numbers; polling two uniforms keeps slider changes
    // allocation-free and avoids rebuilding either node material.
    this.#poolStrength.value = STREET_LIGHT_TUNING.values.strength;
    this.#falloffPower.value = STREET_LIGHT_TUNING.values.falloffPower;
    this.#now.value = performance.now() * 0.001;
    // live position (not the 30 m-quantized scan centre): trailing pools dim
    // smoothly as you leave and the leading band brightens as you approach
    this.#fadeCenter.value.set(playerPos.x, playerPos.z);
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
    // actual resident edge: the scan radius, unless CAP truncated the set first
    // (dense downtown) — then the farthest kept lamp defines where pops happen
    this.#nextEdge =
      candI.length > CAP ? Math.sqrt(candD2[order[CAP - 1]]) : RESIDENT_R;
    this.#nextBirth.clear();
    this.#nextHeroCount = 0;
    const heroSelectR2 = HERO_SELECT_R * HERO_SELECT_R;
    while (
      this.#nextHeroCount < Math.min(MAX_PROJECTED_SURFACE_LIGHTS, this.#fillN) &&
      candD2[order[this.#nextHeroCount]] <= heroSelectR2
    ) {
      this.#nextHeroCount++;
    }
    this.#fillCursor = 0;
    this.#drainFill(); // first slice lands this frame
  }

  // Place up to FILL_PER_FRAME lamps of the armed refresh; on the last slice,
  // publish the new counts + upload the instance buffers ONCE.
  #drainFill(): void {
    if (this.#fillCursor < 0) return;
    const map = this.#map;
    const nowS = performance.now() * 0.001;
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

      // ground pool: centred under the arm tip, laid flat to the terrain normal.
      // Hash-jittered radius (and a brightness jitter in the fade attribute)
      // breaks the uniform stamped-decal look; the jittered radius rides the
      // hero position's w so the projected pass and lamp-field audio agree.
      const gx = x + tx * ARM_LEN;
      const gz = z + tz * ARM_LEN;
      const gy = map.effectiveGround(gx, gz) + 0.03;
      const radiusJitter = 0.88 + 0.28 * hash2(idx, 57);
      map.normal(gx, gz, this.#nrm);
      this.#quat.setFromUnitVectors(this.#up, this.#nrm);
      this.#mat.compose(
        this.#pos.set(gx, gy, gz),
        this.#quat,
        this.#scl.set(radiusJitter, radiusJitter, 1)
      );
      this.#scl.set(1, 1, 1);
      this.#discs.setMatrixAt(k, this.#mat);
      // fade-in starts at first residency; a retained lamp keeps its birth so a
      // refresh can never restart (or skip) a fade mid-ramp
      const birth = this.#birth.get(idx) ?? nowS;
      this.#nextBirth.set(idx, birth);
      this.#lampFadeAttr.setXY(k, birth, 0.85 + 0.3 * hash2(idx, 101));
      const isHero = k < this.#nextHeroCount;
      this.#discProjected.setX(k, isHero ? 1 : 0);
      if (isHero) {
        this.#nextHeroPositions[k].set(gx, gy, gz, POOL_R * radiusJitter);
        this.#nextHeroBirth[k] = birth;
        this.#nextHeroNormals[k].set(
          this.#nrm.x,
          this.#nrm.y,
          this.#nrm.z,
          0
        );
      }
    }
    this.#fillCursor = end;
    if (end < this.#fillN) return; // more slices next frames — no upload yet

    this.#fillCursor = -1;
    this.#posts.count = this.#fillN;
    this.#bulbs.count = this.#fillN;
    this.#discs.count = this.#fillN;
    [this.#heroPositions, this.#nextHeroPositions] = [
      this.#nextHeroPositions,
      this.#heroPositions
    ];
    [this.#heroNormals, this.#nextHeroNormals] = [
      this.#nextHeroNormals,
      this.#heroNormals
    ];
    [this.#heroBirth, this.#nextHeroBirth] = [
      this.#nextHeroBirth,
      this.#heroBirth
    ];
    // dropping the old map forgets departed lamps: if one re-enters later it
    // fades in again instead of popping at its stale full-brightness birth
    [this.#birth, this.#nextBirth] = [this.#nextBirth, this.#birth];
    this.#heroCount = this.#nextHeroCount;
    // fade band published atomically with the swapped set: fully transparent
    // one refresh-move inside the edge, so pop-in lands at ~zero alpha
    const fadeEnd = Math.max(90, this.#nextEdge * 0.95 - REFRESH_MOVE);
    this.#fadeEnd.value = fadeEnd;
    this.#fadeStart.value = fadeEnd * 0.72;
    this.#posts.instanceMatrix.needsUpdate = true;
    this.#bulbs.instanceMatrix.needsUpdate = true;
    this.#discs.instanceMatrix.needsUpdate = true;
    this.#discProjected.needsUpdate = true;
    this.#lampFadeAttr.needsUpdate = true;
  }

  #projectedLightingActive(): boolean {
    if (!this.group.visible || Number(STREET_LAMPS_INTENSITY.value) <= 0.01) return false;
    const end2 = HERO_END_R * HERO_END_R;
    for (let i = 0; i < this.#heroCount; i++) {
      const p = this.#heroPositions[i];
      const dx = p.x - this.#viewX;
      const dz = p.z - this.#viewZ;
      if (dx * dx + dz * dz < end2) return true;
    }
    return false;
  }

  #copyProjectedLight(
    index: number,
    positionAndRadius: THREE.Vector4,
    normalAndWeight: THREE.Vector4
  ): void {
    positionAndRadius.copy(this.#heroPositions[index]);
    normalAndWeight.copy(this.#heroNormals[index]);
    const dx = positionAndRadius.x - this.#viewX;
    const dz = positionAndRadius.z - this.#viewZ;
    const distance = Math.hypot(dx, dz);
    const t = THREE.MathUtils.clamp(
      (distance - HERO_FULL_R) / (HERO_END_R - HERO_FULL_R),
      0,
      1
    );
    const smooth = t * t * (3 - 2 * t);
    // same first-residency fade-in the disc applies, so a boot/teleport at
    // night ramps the projected pools in step with their fallbacks
    const b = THREE.MathUtils.clamp(
      (performance.now() * 0.001 - this.#heroBirth[index]) / LAMP_FADE_IN,
      0,
      1
    );
    normalAndWeight.w = (1 - smooth) * b * b * (3 - 2 * b);
  }
}
