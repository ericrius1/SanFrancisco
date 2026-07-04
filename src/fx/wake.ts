import * as THREE from "three/webgpu";
import {
  attribute,
  clamp,
  color,
  instancedBufferAttribute,
  mix,
  mx_noise_float,
  positionGeometry,
  positionWorld,
  smoothstep,
  uniform,
  uv,
  varying,
  vec3
} from "three/tsl";
import { waterHeight, type WorldMap } from "../world/heightmap";
import { chopZoneMask, swellBase, swellChop } from "../world/tslUtil";
import { LIGHT_SCALE } from "../config";

type N = any;

const POOL = 28;
const LIFE = 2.6; // seconds a ring takes to expand out and die
const SPACING = 3.2; // metres of travel between rings
const MIN_SPEED = 2.0;

// the ripple layer only needs these off the player
type BoatState = {
  mode: string;
  renderPosition: THREE.Vector3;
  velocity: THREE.Vector3;
  speed: number;
};

// prog < 0 = spawn delay still counting down (advances on the same clock)
type Ripple = { x: number; z: number; prog: number };

/**
 * Boat wake: expanding foam rings shed from the stern while under way. One
 * instanced quad batch — per-instance progress drives the ring expansion in
 * the shader, the CPU only re-seats each ring on the swell so they ride the
 * same waterHeight() the hull floats on. Additive with a faint glow so the
 * wake still reads on the night bay without torching the daytime water.
 */
export class WakeRipples {
  #mesh: THREE.InstancedMesh;
  #progAttr: THREE.InstancedBufferAttribute;
  #ripples: Ripple[] = [];
  #next = 0;
  #distAcc = 0;
  #side = 1; // rings alternate port/starboard off the stern

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);

    this.#progAttr = new THREE.InstancedBufferAttribute(new Float32Array(POOL).fill(1), 1);
    this.#progAttr.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshBasicNodeMaterial();
    const prog = varying(instancedBufferAttribute(this.#progAttr) as N) as N;

    // radial distance across the quad: 0 centre, 1 at the edge
    const d = (uv() as N).sub(0.5).length().mul(2);
    // ring sweeps outward; the band thins as it spreads, like a real bow ring
    const ringR = mix(0.14, 0.8, prog) as N;
    const w = mix(0.16, 0.08, prog) as N;
    const band = smoothstep(w, w.mul(0.15), d.sub(ringR).abs()) as N;
    // fainter second crest trailing the leader so the ring reads as water
    const band2 = (smoothstep(w, w.mul(0.2), d.sub(ringR.mul(0.55)).abs()) as N).mul(0.3);
    // world-anchored noise chews the circles up so they never read CG-perfect
    const n = mx_noise_float(vec3(positionWorld.x.mul(0.7), positionWorld.z.mul(0.7), prog.mul(2.0)) as N)
      .mul(0.5)
      .add(0.5);
    // bloom in over the first frames, die away as the ring spends itself
    const fade = prog.oneMinus().pow(1.6).mul(smoothstep(0.0, 0.07, prog));

    mat.colorNode = (color(0xbfe9df) as N)
      .mul(band.add(band2).mul(n.mul(0.35).add(0.75)))
      .mul(fade)
      .mul(0.07 * LIGHT_SCALE);
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.fog = false;

    this.#mesh = new THREE.InstancedMesh(geo, mat, POOL);
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.frustumCulled = false;
    this.#mesh.renderOrder = 12; // over both water sheets (10/11)
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < POOL; i++) {
      this.#mesh.setMatrixAt(i, zero);
      this.#ripples.push({ x: 0, z: 0, prog: 1 });
    }
    scene.add(this.#mesh);
  }

  #mat4 = new THREE.Matrix4();
  #q = new THREE.Quaternion();
  #p = new THREE.Vector3();
  #s = new THREE.Vector3();

  #spawn(x: number, z: number, t: number, size: number, delay = 0) {
    const r = this.#ripples[this.#next];
    const i = this.#next;
    this.#next = (this.#next + 1) % POOL;
    r.x = x;
    r.z = z;
    r.prog = -delay / LIFE;
    (this.#progAttr.array as Float32Array)[i] = 0;
    this.#mat4.compose(
      this.#p.set(x, waterHeight(x, z, t) + 0.06, z),
      this.#q,
      this.#s.set(size, 1, size)
    );
    this.#mesh.setMatrixAt(i, this.#mat4);
  }

  /** Splash rings: concentric foam circles rolling out from an impact point,
   * staggered so the water keeps answering after the hit. */
  burst(x: number, z: number, elapsed: number, size: number, rings = 3) {
    for (let i = 0; i < rings; i++) {
      this.#spawn(x, z, elapsed, size * (0.55 + i * 0.45), i * 0.22);
    }
  }

  update(dt: number, elapsed: number, boat: BoatState) {
    // age the live rings and keep them seated on the moving swell
    const progArr = this.#progAttr.array as Float32Array;
    let touched = false;
    for (let i = 0; i < POOL; i++) {
      const r = this.#ripples[i];
      if (r.prog >= 1) continue;
      r.prog = Math.min(1, r.prog + dt / LIFE);
      progArr[i] = Math.max(0, r.prog);
      if (r.prog >= 1) {
        this.#mesh.setMatrixAt(i, this.#mat4.makeScale(0, 0, 0));
      } else {
        this.#mesh.getMatrixAt(i, this.#mat4);
        this.#mat4.elements[13] = waterHeight(r.x, r.z, elapsed) + 0.06;
        this.#mesh.setMatrixAt(i, this.#mat4);
      }
      touched = true;
    }
    if (touched) {
      this.#mesh.instanceMatrix.needsUpdate = true;
      this.#progAttr.needsUpdate = true;
    }

    // shed new rings by distance travelled, so boost naturally packs the wake
    const v = boat.velocity;
    const h = Math.hypot(v.x, v.z);
    if (boat.mode !== "boat" || h < MIN_SPEED) {
      this.#distAcc = 0;
      return;
    }
    this.#distAcc += h * dt;
    if (this.#distAcc < SPACING) return;
    this.#distAcc -= SPACING;

    const dx = v.x / h;
    const dz = v.z / h;
    const p = boat.renderPosition;
    // off the stern (3.4m astern of centre), alternating shoulder to shoulder
    this.#side = -this.#side;
    const lat = this.#side * 0.8 + (Math.random() - 0.5) * 0.6;
    const x = p.x - dx * 3.4 - dz * lat;
    const z = p.z - dz * 3.4 + dx * lat;
    this.#spawn(x, z, elapsed, 6 + boat.speed * 0.15);
  }
}

// the board wake only needs these off the player
type BoardState = {
  mode: string;
  renderPosition: THREE.Vector3;
  renderQuaternion: THREE.Quaternion;
  velocity: THREE.Vector3;
  speed: number;
  boardGrounded: boolean;
};

type RibbonOpts = {
  color: number;
  w0: number; // width at birth (metres)
  widen: number; // extra width gained over the full life
  drift: number; // outward speed along each point's lateral dir, eased off with age
  life: number; // seconds
  amp: number; // brightness
};

type RibbonPt = { x: number; z: number; dx: number; dz: number; t: number };

const RIB_PTS = 40; // max control points per ribbon
const RIB_HEAD_TAPER_PTS = 4.0; // control-point span used to feather the live cap

/**
 * One continuous triangle-strip trail. Control points are shed along the
 * path; each contributes ONE shared vertex pair, so neighbouring segments are
 * watertight by construction — curves bend, they can never split into strips
 * the way independent quads did. Everything else runs in the vertex shader
 * off per-vertex age: widening, outward drift (closed-form integral of an
 * ease-out), and seating every vertex on the same swell+chop the physics
 * reads. The CPU only rewrites the small point buffer. Across the width the
 * fragment shader shades a signed distance from the centreline — one smooth
 * analytic falloff, font-style, instead of per-quad feathering.
 */
class WakeRibbon {
  mesh: THREE.Mesh;
  #geo: THREE.BufferGeometry;
  #pos: THREE.BufferAttribute; // control point (x, 0, z), duplicated per side
  #data: THREE.BufferAttribute; // (dirX, dirZ, spawnTime)
  #taper: THREE.BufferAttribute; // 0 at the live head, 1 once the trail is established
  #uTime = uniform(0);
  #pts: RibbonPt[] = [];
  #life: number;

  constructor(scene: THREE.Scene, opts: RibbonOpts) {
    this.#life = opts.life;

    const geo = new THREE.BufferGeometry();
    const side = new Float32Array(RIB_PTS * 2);
    const idx: number[] = [];
    for (let i = 0; i < RIB_PTS; i++) {
      side[i * 2] = -0.5;
      side[i * 2 + 1] = 0.5;
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.#pos = new THREE.BufferAttribute(new Float32Array(RIB_PTS * 2 * 3), 3);
    this.#pos.setUsage(THREE.DynamicDrawUsage);
    this.#data = new THREE.BufferAttribute(new Float32Array(RIB_PTS * 2 * 3), 3);
    this.#data.setUsage(THREE.DynamicDrawUsage);
    this.#taper = new THREE.BufferAttribute(new Float32Array(RIB_PTS * 2), 1);
    this.#taper.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.#pos);
    geo.setAttribute("aData", this.#data);
    geo.setAttribute("aTaper", this.#taper);
    geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    this.#geo = geo;

    const mat = new THREE.MeshBasicNodeMaterial();
    const t = this.#uTime;
    const aSide = attribute("aSide", "float") as N;
    const aData = attribute("aData", "vec3") as N;
    const cap = smoothstep(0.0, 1.0, attribute("aTaper", "float") as N) as N;
    const age = clamp((t as N).sub(aData.z).div(opts.life), 0, 1) as N;
    // width grows with age; the whole pair of edge vertices also slides
    // outward along the point's lateral dir (integral of the eased drift)
    const off = ((aSide.mul(mix(opts.w0, opts.w0 + opts.widen, age)) as N)
      .add(age.sub(age.mul(age).mul(0.5)).mul(opts.drift * opts.life)) as N)
      .mul(mix(0.08, 1.0, cap)) as N;
    const px = positionGeometry.x.add(aData.x.mul(off)) as N;
    const pz = positionGeometry.z.add(aData.y.mul(off)) as N;
    const py = swellBase(px, pz, t).add(swellChop(px, pz, t).mul(chopZoneMask(px, pz))).add(0.08);
    mat.positionNode = vec3(px, py, pz);

    const vAge = varying(age) as N;
    const vCap = varying(cap) as N;
    // signed distance from the centreline, −1..1 across the ribbon
    const sd = (varying(aSide.mul(2)) as N).abs() as N;
    const band = smoothstep(1.0, 0.3, sd) as N;
    // world-anchored noise chews the ribbon into churn; keyed on age so the
    // pattern evolves smoothly down the whole trail
    const n = mx_noise_float(vec3(positionWorld.x.mul(1.3), positionWorld.z.mul(1.3), vAge.mul(2.0)) as N)
      .mul(0.5)
      .add(0.5);
    // bloom in over the first metres behind the board, spend out with age
    const fade = vAge.oneMinus().pow(1.3).mul(smoothstep(0.0, 0.05, vAge));

    mat.colorNode = (color(opts.color) as N)
      .mul(band.mul(n.mul(0.45).add(0.7)))
      .mul(fade.mul(vCap))
      .mul(opts.amp * 0.34 * LIGHT_SCALE);
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.fog = false;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 12; // over both water sheets (10/11)
    this.mesh.visible = false; // hidden until the strip has ≥2 points to draw
    scene.add(this.mesh);
  }

  shed(x: number, z: number, dx: number, dz: number, t: number) {
    // a big jump since the last point = the board was airborne or teleported;
    // break the chain rather than bridge the gap with one long segment
    const last = this.#pts[this.#pts.length - 1];
    if (last && Math.hypot(x - last.x, z - last.z) > 8) this.#pts.length = 0;
    if (this.#pts.length >= RIB_PTS - 1) this.#pts.shift();
    this.#pts.push({ x, z, dx, dz, t });
  }

  /** Rebuild the strip: shed points oldest→newest, plus a live head vertex
   * pair glued to the board so the trail never lags the tail. */
  update(elapsed: number, head: { x: number; z: number; dx: number; dz: number; t?: number } | null) {
    this.#uTime.value = elapsed;
    const pts = this.#pts;
    while (pts.length && elapsed - pts[0].t >= this.#life) pts.shift();
    const n = pts.length + (head && pts.length ? 1 : 0);
    if (n < 2) {
      this.#geo.setDrawRange(0, 0);
      this.mesh.visible = false;
      return;
    }
    const posArr = this.#pos.array as Float32Array;
    const dataArr = this.#data.array as Float32Array;
    const taperArr = this.#taper.array as Float32Array;
    let vi = 0;
    const put = (x: number, z: number, dx: number, dz: number, t: number, taper: number) => {
      for (let s = 0; s < 2; s++) {
        posArr[vi * 3] = x;
        posArr[vi * 3 + 1] = 0;
        posArr[vi * 3 + 2] = z;
        dataArr[vi * 3] = dx;
        dataArr[vi * 3 + 1] = dz;
        dataArr[vi * 3 + 2] = t;
        taperArr[vi] = taper;
        vi++;
      }
    };
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      put(p.x, p.z, p.dx, p.dz, p.t, Math.min(1, (n - 1 - i) / RIB_HEAD_TAPER_PTS));
    }
    if (head) put(head.x, head.z, head.dx, head.dz, head.t ?? elapsed, 0);
    this.#pos.needsUpdate = true;
    this.#data.needsUpdate = true;
    this.#taper.needsUpdate = true;
    this.#geo.setDrawRange(0, (n - 1) * 6);
    this.mesh.visible = true;
  }
}

// landing surges: brief standalone quads, so the old instanced recipe is fine
type Surge = {
  x: number;
  z: number;
  yaw: number;
  scaleX: number; // quad width in metres; the band drifts/widens inside it in-shader
  len: number;
  life: number;
  prog: number; // 0..1, kept ≥1 when dead
};

const BW_POOL = 16;
const BW_SPACING = 1.7; // metres of travel between shed ribbon points
const BW_MIN_SPEED = 2.5;
const BW_SURF_HEIGHT = 2.6; // deck must hover this close to the swell to wake it
const BW_FRONT_TIP = 1.28; // source wakes from the visible nose/front tip
const BW_RAIL_OFFSET = 0.55;
const BW_BIRTH_WARMUP = 0.04; // seconds; avoids zero-alpha blink on new head points

/**
 * Hoverboard wake: three continuous WakeRibbon trails — a foam stream off
 * each rail corner spreading outward into a V, plus a wide faint downwash
 * band under the centreline — and, on ollie landings, a pair of hard
 * outward surge quads with a ring burst from WakeRipples.
 */
export class BoardWake {
  #mesh: THREE.InstancedMesh;
  #progAttr: THREE.InstancedBufferAttribute;
  #shapeAttr: THREE.InstancedBufferAttribute; // (w0n, wMaxN, driftN) per quad
  #surges: Surge[] = [];
  #next = 0;
  #distAcc = 0;
  #map: WorldMap;
  #ripples: WakeRipples;
  #ribL: WakeRibbon;
  #ribR: WakeRibbon;
  #ribC: WakeRibbon;
  #wasSurfing = false;
  #wasActive = false;
  #prevVy = 0;

  constructor(scene: THREE.Scene, map: WorldMap, ripples: WakeRipples) {
    this.#map = map;
    this.#ripples = ripples;

    // foam pulled toward the deck's 0x54f0ff hover glow: reads as downwash
    const rail = { color: 0x9beef0, w0: 0.65, widen: 2.4, drift: 1.0, life: 1.5, amp: 1 };
    this.#ribL = new WakeRibbon(scene, rail);
    this.#ribR = new WakeRibbon(scene, rail);
    this.#ribC = new WakeRibbon(scene, { color: 0x9beef0, w0: 1.6, widen: 3.4, drift: 0, life: 0.8, amp: 0.4 });

    const geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);

    this.#progAttr = new THREE.InstancedBufferAttribute(new Float32Array(BW_POOL).fill(1), 1);
    this.#progAttr.setUsage(THREE.DynamicDrawUsage);
    this.#shapeAttr = new THREE.InstancedBufferAttribute(new Float32Array(BW_POOL * 3), 3);
    this.#shapeAttr.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshBasicNodeMaterial();
    const prog = varying(instancedBufferAttribute(this.#progAttr) as N) as N;
    const shape = varying(instancedBufferAttribute(this.#shapeAttr) as N) as N;
    const u = uv() as N;

    // band widens with age inside the fixed-width quad, drifting outward
    const hw = (mix(shape.x, shape.y, prog) as N).mul(0.5) as N;
    const centre = shape.z.mul(prog.sub(prog.mul(prog).mul(0.5))) as N;
    const lat = smoothstep(hw, hw.mul(0.2), u.x.sub(0.5).sub(centre).abs()) as N;
    const ends = (smoothstep(0.0, 0.12, u.y) as N).mul(smoothstep(1.0, 0.88, u.y)) as N;
    const n = mx_noise_float(vec3(positionWorld.x.mul(1.3), positionWorld.z.mul(1.3), prog.mul(2.0)) as N)
      .mul(0.5)
      .add(0.5);
    const fade = prog.oneMinus().pow(1.3).mul(smoothstep(0.0, 0.05, prog));

    mat.colorNode = (color(0x9beef0) as N)
      .mul(lat.mul(ends).mul(n.mul(0.45).add(0.7)))
      .mul(fade)
      .mul(0.8 * 0.34 * LIGHT_SCALE);
    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    mat.side = THREE.DoubleSide;
    mat.fog = false;

    this.#mesh = new THREE.InstancedMesh(geo, mat, BW_POOL);
    this.#mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#mesh.frustumCulled = false;
    this.#mesh.renderOrder = 12; // over both water sheets (10/11)
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < BW_POOL; i++) {
      this.#mesh.setMatrixAt(i, zero);
      this.#surges.push({ x: 0, z: 0, yaw: 0, scaleX: 1, len: 0, life: 1, prog: 1 });
    }
    scene.add(this.#mesh);
  }

  #mat4 = new THREE.Matrix4();
  #q = new THREE.Quaternion();
  #p = new THREE.Vector3();
  #s = new THREE.Vector3();
  #fwd = new THREE.Vector3();
  static #UP = new THREE.Vector3(0, 1, 0);

  /** `drift` is the outward speed along local x (signed). */
  #spawnSurge(
    spec: { x: number; z: number; yaw: number; len: number; w0: number; widen: number; drift: number; life: number },
    elapsed: number
  ) {
    const i = this.#next;
    this.#next = (this.#next + 1) % BW_POOL;
    const s = this.#surges[i];
    s.x = spec.x;
    s.z = spec.z;
    s.yaw = spec.yaw;
    s.len = spec.len;
    s.life = spec.life;
    // quad wide enough to hold the band at max width AND max drift
    s.scaleX = spec.w0 + spec.widen + Math.abs(spec.drift) * spec.life;
    s.prog = 0;
    (this.#progAttr.array as Float32Array)[i] = 0;
    const shp = this.#shapeAttr.array as Float32Array;
    shp[i * 3] = spec.w0 / s.scaleX;
    shp[i * 3 + 1] = (spec.w0 + spec.widen) / s.scaleX;
    shp[i * 3 + 2] = (spec.drift * spec.life) / s.scaleX;
    this.#shapeAttr.needsUpdate = true;
    this.#mat4.compose(
      this.#p.set(s.x, waterHeight(s.x, s.z, elapsed) + 0.08, s.z),
      this.#q.setFromAxisAngle(BoardWake.#UP, s.yaw),
      this.#s.set(s.scaleX, 1, s.len)
    );
    this.#mesh.setMatrixAt(i, this.#mat4);
  }

  update(dt: number, elapsed: number, board: BoardState) {
    // age the live surge quads and keep them seated on the moving swell
    const progArr = this.#progAttr.array as Float32Array;
    let touched = false;
    for (let i = 0; i < BW_POOL; i++) {
      const s = this.#surges[i];
      if (s.prog >= 1) continue;
      s.prog = Math.min(1, s.prog + dt / s.life);
      progArr[i] = s.prog;
      if (s.prog >= 1) {
        this.#mesh.setMatrixAt(i, this.#mat4.makeScale(0, 0, 0));
      } else {
        this.#mesh.getMatrixAt(i, this.#mat4);
        this.#mat4.elements[13] = waterHeight(s.x, s.z, elapsed) + 0.08;
        this.#mesh.setMatrixAt(i, this.#mat4);
      }
      touched = true;
    }
    if (touched) {
      this.#mesh.instanceMatrix.needsUpdate = true;
      this.#progAttr.needsUpdate = true;
    }

    const p = board.renderPosition;
    const v = board.velocity;
    const h = Math.hypot(v.x, v.z);
    const surfing =
      board.mode === "board" &&
      board.boardGrounded &&
      this.#map.isWater(p.x, p.z) &&
      p.y - waterHeight(p.x, p.z, elapsed) < BW_SURF_HEIGHT;

    const fwd = this.#fwd.set(0, 0, -1).applyQuaternion(board.renderQuaternion);
    fwd.y = 0;
    if (fwd.lengthSq() > 1e-6) fwd.normalize();
    else if (h > 0.3) fwd.set(v.x / h, 0, v.z / h);
    else fwd.set(0, 0, -1);
    const dx = fwd.x;
    const dz = fwd.z;
    const yaw = Math.atan2(dx, dz);

    // ollie landing: the downwash slaps the swell — hard outward surges off
    // both rails plus a small ring burst rolling away from the touch-down
    if (surfing && !this.#wasSurfing && this.#prevVy < -3) {
      const impact = Math.min(1.6, 0.4 - this.#prevVy / 18);
      this.#ripples.burst(p.x, p.z, elapsed, 3 + impact * 3, 2);
      for (const side of [-1, 1]) {
        this.#spawnSurge(
          {
            x: p.x - dz * side * 0.9,
            z: p.z + dx * side * 0.9,
            yaw,
            len: 1.8,
            w0: 0.6,
            widen: 2.2,
            drift: -side * (2.2 + impact), // outward = local -side·x
            life: 0.65
          },
          elapsed
        );
      }
    }
    this.#wasSurfing = surfing;
    this.#prevVy = v.y;

    const active = surfing && h >= BW_MIN_SPEED;
    if (active) {
      // The source is the board nose: the path history of that front tip forms
      // a continuous ribbon backward under the board, instead of a late wake
      // that begins behind the tail.
      const hx = p.x + dx * BW_FRONT_TIP;
      const hz = p.z + dz * BW_FRONT_TIP;
      const ht = elapsed - BW_BIRTH_WARMUP;
      const lx = hx + dz * BW_RAIL_OFFSET;
      const lz = hz - dx * BW_RAIL_OFFSET;
      const rx = hx - dz * BW_RAIL_OFFSET;
      const rz = hz + dx * BW_RAIL_OFFSET;
      if (!this.#wasActive) {
        this.#distAcc = 0;
        this.#ribL.shed(lx, lz, dz, -dx, ht);
        this.#ribR.shed(rx, rz, -dz, dx, ht);
        this.#ribC.shed(hx, hz, dz, -dx, ht);
      }
      this.#distAcc += h * dt;
      if (this.#distAcc >= BW_SPACING) {
        this.#distAcc %= BW_SPACING;
        this.#ribL.shed(lx, lz, dz, -dx, ht);
        this.#ribR.shed(rx, rz, -dz, dx, ht);
        this.#ribC.shed(hx, hz, dz, -dx, ht);
      }
      this.#ribL.update(elapsed, { x: lx, z: lz, dx: dz, dz: -dx, t: ht });
      this.#ribR.update(elapsed, { x: rx, z: rz, dx: -dz, dz: dx, t: ht });
      this.#ribC.update(elapsed, { x: hx, z: hz, dx: dz, dz: -dx, t: ht });
    } else {
      // airborne/off-water: no head glue, the shed trail lingers and fades;
      // shed() breaks the chain itself if the board comes down far away
      this.#distAcc = 0;
      this.#ribL.update(elapsed, null);
      this.#ribR.update(elapsed, null);
      this.#ribC.update(elapsed, null);
    }
    this.#wasActive = active;
  }
}
