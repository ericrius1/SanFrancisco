import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  Loop,
  atomicAdd,
  atomicStore,
  clamp,
  exp,
  float,
  floor,
  hash,
  instanceIndex,
  instancedArray,
  length,
  max,
  min,
  mix,
  positionLocal,
  saturate,
  smoothstep,
  sqrt,
  transformNormalToView,
  uint,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
  vertexIndex,
  vertexStage
} from "three/tsl";
import { LIGHT_SCALE } from "../config";

type N = any;

/**
 * Exploratorium exhibit engines — GPU particle "worlds" after the
 * particle-worlds essays (parts 3/4): a counting-sort spatial grid rebuilt
 * every substep (histogram → Hillis-Steele scan → scatter), then one force
 * kernel that only visits the 3×3 neighbouring cells. Everything lives in a
 * 2D local frame (a wall tank or a table disc) and is projected into the
 * world by an origin + two axes, so the sims cost nothing when their room's
 * owner isn't dispatching compute.
 */

/** Local 2D frame: world = origin + ax·x + ay·y. */
export type ExhibitFrame = {
  origin: THREE.Vector3;
  ax: THREE.Vector3;
  ay: THREE.Vector3;
};

export type GrainMode = "sand" | "stars";

type GrainOpts = {
  mode: GrainMode;
  n: number;
  w: number; // domain width (m)
  h: number; // domain height (m)
  cell: number; // grid cell = interaction radius
  size: number; // sprite draw size (m)
};

const SUB_DT = 1 / 120;

// Hard ceiling on how many particles a single grid cell contributes to a
// neighbour's force sum. Normal occupancy is a handful, but an attractor stir
// (the star table's second mass) can crowd a cell far past that
// — and the 9-cell walk is O(k) per neighbour, so a runaway cell turns into a
// GPU-hanging k² blowup that takes the whole tab down. Capping the read keeps
// every dispatch bounded; the overflow grains still get pushed apart next step.
const MAX_PER_CELL = 64;

/** ceil(log2(n)) scan passes for a Hillis-Steele inclusive prefix sum. */
function scanPasses(n: number): number {
  let p = 0;
  while (1 << p < n) p++;
  return p;
}

export class GrainSim {
  mesh: THREE.Sprite;
  readonly mode: GrainMode;

  // instrumentation the headless verify (and the "/" pane) can watch: how many
  // compute batches this sim actually dispatched — proves the room gating
  dispatches = 0;

  #renderer: THREE.WebGPURenderer;
  #opts: GrainOpts;
  #gw: number;
  #gh: number;
  #cells: number;

  #active = false;
  #accum = 0;

  // stir.xy = local point, z = 1 while the visitor holds the beam on the tank
  #stir = uniform(new THREE.Vector3(0, 0, 0));
  #originU = uniform(new THREE.Vector3());
  #axU = uniform(new THREE.Vector3(1, 0, 0));
  #ayU = uniform(new THREE.Vector3(0, 1, 0));

  #passes: { node: N }[] = [];

  constructor(renderer: THREE.WebGPURenderer, parent: THREE.Object3D, frame: ExhibitFrame, opts: GrainOpts) {
    this.#renderer = renderer;
    this.#opts = opts;
    this.mode = opts.mode;
    this.#gw = Math.ceil(opts.w / opts.cell);
    this.#gh = Math.ceil(opts.h / opts.cell);
    this.#cells = this.#gw * this.#gh;
    this.#originU.value.copy(frame.origin);
    this.#axU.value.copy(frame.ax);
    this.#ayU.value.copy(frame.ay);

    const { n } = opts;
    const init = this.#initialState();
    const posA = instancedArray(init.pos, "vec2");
    const velA = instancedArray(init.vel, "vec2");
    const posB = instancedArray(n, "vec2");
    const velB = instancedArray(n, "vec2");
    const counts = instancedArray(this.#cells, "uint").toAtomic();
    const cursor = instancedArray(this.#cells, "uint").toAtomic();
    const countsPlain = instancedArray(this.#cells, "uint");
    const scanA = instancedArray(this.#cells, "uint");
    const scanB = instancedArray(this.#cells, "uint");

    const gw = this.#gw;
    const cellsN = this.#cells;
    const invCell = 1 / opts.cell;

    const cellOf = (p: N): N => {
      const cx = clamp(floor(p.x.mul(invCell)), 0, gw - 1);
      const cy = clamp(floor(p.y.mul(invCell)), 0, this.#gh - 1);
      return cy.mul(gw).add(cx).toUint();
    };

    // ---- pipeline: clear → count → scan (log2 passes) → cursor → scatter
    const clearPass = Fn(() => {
      atomicStore(counts.element(instanceIndex), uint(0));
    })().compute(cellsN);

    const countPass = Fn(() => {
      const p = posA.element(instanceIndex);
      atomicAdd(counts.element(cellOf(p)), uint(1));
    })().compute(n);

    // read the atomic histogram once (atomicAdd(+0) = load), keep a plain copy
    const scanInit = Fn(() => {
      const c = atomicAdd(counts.element(instanceIndex), uint(0));
      countsPlain.element(instanceIndex).assign(c);
      scanA.element(instanceIndex).assign(c);
    })().compute(cellsN);

    const nPasses = scanPasses(cellsN);
    const scanSteps: N[] = [];
    for (let k = 0; k < nPasses; k++) {
      const from = k % 2 === 0 ? scanA : scanB;
      const to = k % 2 === 0 ? scanB : scanA;
      const off = 1 << k;
      scanSteps.push(
        Fn(() => {
          const i = instanceIndex;
          const v = from.element(i).toVar();
          If(i.greaterThanEqual(uint(off)), () => {
            v.addAssign(from.element(i.sub(uint(off))));
          });
          to.element(i).assign(v);
        })().compute(cellsN)
      );
    }
    const scanFinal = nPasses % 2 === 0 ? scanA : scanB; // inclusive prefix sums

    const cursorInit = Fn(() => {
      const i = instanceIndex;
      const start = scanFinal.element(i).sub(countsPlain.element(i)); // exclusive
      atomicStore(cursor.element(i), start);
    })().compute(cellsN);

    // full-state scatter: spatial neighbours become memory neighbours
    const scatterPass = Fn(() => {
      const i = instanceIndex;
      const p = posA.element(i).toVar();
      const slot = atomicAdd(cursor.element(cellOf(p)), uint(1));
      posB.element(slot).assign(p);
      velB.element(slot).assign(velA.element(i));
    })().compute(n);

    // 9-cell neighbour walk shared by the density + force kernels
    const eachNeighbor = (p: N, body: (j: N, pj: N, r: N, d: N) => void) => {
      const cx = clamp(floor(p.x.mul(invCell)), 0, gw - 1).toInt();
      const cy = clamp(floor(p.y.mul(invCell)), 0, this.#gh - 1).toInt();
      Loop({ start: -1, end: 2, name: "dy" } as never, ({ dy }: any) => {
        Loop({ start: -1, end: 2, name: "dx" } as never, ({ dx }: any) => {
          const nx = cx.add(dx);
          const ny = cy.add(dy);
          If(nx.greaterThanEqual(0).and(nx.lessThan(gw)).and(ny.greaterThanEqual(0)).and(ny.lessThan(this.#gh)), () => {
            const cell = ny.mul(gw).add(nx).toUint();
            const end = scanFinal.element(cell);
            const start = end.sub(countsPlain.element(cell));
            // bound the walk: a stir can crowd a cell past any sane occupancy,
            // and an uncapped k-long inner loop is a GPU-hanging k² blowup
            const cend = (min as N)(end, start.add(uint(MAX_PER_CELL)));
            Loop({ start, end: cend, type: "uint", condition: "<", name: "j" } as never, ({ j }: any) => {
              const pj = posB.element(j);
              const d = pj.sub(p);
              const r = length(d);
              body(j, pj, r, d);
            });
          });
        });
      });
    };

    const passList: N[] = [clearPass, countPass, scanInit, ...scanSteps, cursorInit, scatterPass];

    passList.push(this.#buildForces(n, posA, velA, posB, velB, eachNeighbor));

    this.#passes = passList.map((node) => ({ node }));

    this.mesh = this.#buildSprite(posA, velA);
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  /* ------------------------------------------------ initial particle state */

  #initialState(): { pos: Float32Array; vel: Float32Array } {
    const { n, w, h, mode } = this.#opts;
    const pos = new Float32Array(n * 2);
    const vel = new Float32Array(n * 2);
    if (mode === "sand") {
      // a loose rain filling the upper half — first visitors watch it pile up
      const cols = Math.ceil(Math.sqrt((n * w) / (h * 0.5)));
      const s = w / cols;
      for (let i = 0; i < n; i++) {
        pos[i * 2] = (i % cols) * s + s * 0.5 + (Math.random() - 0.5) * s * 0.5;
        pos[i * 2 + 1] = h * 0.45 + Math.floor(i / cols) * s * 0.92 + Math.random() * s * 0.3;
      }
    } else {
      // stars: an annular dust disc on circular orbits (+2% jitter) around the
      // central mass — Kepler shear stretches it into spiral streaks
      const cx = w / 2;
      const cy = h / 2;
      const GM = STARS.GM;
      for (let i = 0; i < n; i++) {
        const r = 1.15 + Math.sqrt(Math.random()) * 2.25;
        const a = Math.random() * Math.PI * 2;
        pos[i * 2] = cx + Math.cos(a) * r;
        pos[i * 2 + 1] = cy + Math.sin(a) * r;
        const v = Math.sqrt(GM / r) * (1 + (Math.random() - 0.5) * 0.04);
        vel[i * 2] = -Math.sin(a) * v;
        vel[i * 2 + 1] = Math.cos(a) * v;
      }
    }
    return { pos, vel };
  }

  /* -------------------------------------------------- force + integrate */

  #buildForces(
    n: number,
    posA: N,
    velA: N,
    posB: N,
    velB: N,
    eachNeighbor: (p: N, body: (j: N, pj: N, r: N, d: N) => void) => void
  ): N {
    const { mode, w, h } = this.#opts;
    const stir = this.#stir;

    return Fn(() => {
      const i = instanceIndex;
      const p = posB.element(i).toVar();
      const v = velB.element(i).toVar();
      const acc = vec2(0, 0).toVar();

      if (mode === "sand") {
        const C = SAND;
        acc.y.subAssign(C.g);
        // stir = an air puff: grains blast radially out of the held point
        const sd = p.sub(stir.xy);
        const sr = length(sd).max(0.05);
        acc.addAssign(sd.div(sr).mul(exp(sr.mul(sr).mul(-4.5)).mul(C.stir).mul(stir.z)));
        eachNeighbor(p, (j, _pj, r, d) => {
          If(j.notEqual(i).and(r.lessThan(C.rint)).and(r.greaterThan(1e-5)), () => {
            const nrm = d.div(r);
            const vj = velB.element(j);
            const vn = vj.sub(v).dot(nrm);
            // spring–dashpot, push-only (a contact can never pull)
            const fm = min(float(0), r.sub(C.rint).mul(C.k).add(vn.mul(C.c)));
            acc.addAssign(nrm.mul(fm));
            // tangential creep toward the neighbour's velocity = friction;
            // this dissipation is what lets a pile settle at its repose angle
            const vt = vj.sub(v).sub(nrm.mul(vn));
            acc.addAssign(vt.mul(C.mu));
          });
        });
      } else {
        const C = STARS;
        const center = vec2(w / 2, h / 2);
        const d = p.sub(center);
        const r2 = d.dot(d).add(C.soft);
        // the protostar's pull — every grain orbits the middle of the table
        acc.subAssign(d.div(sqrt(r2)).mul(C.GM).div(r2));
        // visitor's finger = a wandering second mass stirring spiral arms
        const sd = stir.xy.sub(p);
        const sr2 = sd.dot(sd).add(0.02);
        acc.addAssign(sd.div(sqrt(sr2)).mul(C.stirGM).mul(stir.z).div(sr2));
        eachNeighbor(p, (j, _pj, r, dd) => {
          If(j.notEqual(i).and(r.lessThan(C.coh)).and(r.greaterThan(1e-5)), () => {
            const nrm = dd.div(r);
            const vj = velB.element(j);
            const vn = vj.sub(v).dot(nrm);
            If(r.lessThan(C.rint), () => {
              // inelastic contact: without this energy bleed nothing accretes
              const fm = min(float(0), r.sub(C.rint).mul(C.k).add(vn.mul(C.c)));
              acc.addAssign(nrm.mul(fm));
              const vt = vj.sub(v).sub(nrm.mul(vn));
              acc.addAssign(vt.mul(C.mu));
            }).Else(() => {
              // a whisker of cohesion just outside contact: touching grains
              // hang on, clumps sweep their lane clean — oligarchic growth
              acc.addAssign(nrm.mul(r.sub(C.rint).mul(C.cohK)));
            });
          });
        });
        // soft rim so the disc never leaves the table
        const rr = length(d);
        acc.subAssign(d.div(rr.max(0.01)).mul(max(float(0), rr.sub(C.rim)).mul(60)));
      }

      // walls for the boxed sims (springy, slightly damped)
      if (mode !== "stars") {
        const m = this.#opts.size * 0.5;
        acc.x.addAssign(max(float(0), float(m).sub(p.x)).mul(900).sub(min(float(0), v.x).mul(smoothstep(m * 3, m, p.x).mul(8))));
        acc.x.subAssign(max(float(0), p.x.sub(w - m)).mul(900).add(max(float(0), v.x).mul(smoothstep(w - m * 3, w - m, p.x).mul(8))));
        acc.y.addAssign(max(float(0), float(m).sub(p.y)).mul(900).sub(min(float(0), v.y).mul(smoothstep(m * 3, m, p.y).mul(8))));
        acc.y.subAssign(max(float(0), p.y.sub(h - m)).mul(900).add(max(float(0), v.y).mul(smoothstep(h - m * 3, h - m, p.y).mul(8))));
      }

      const drag = mode === "sand" ? 0.35 : 0.015;
      const vmax = mode === "stars" ? 4.5 : 3.5;
      v.addAssign(acc.mul(SUB_DT));
      v.mulAssign(float(1).sub(float(drag).mul(SUB_DT)));
      const sp = length(v);
      v.mulAssign(min(float(1), float(vmax).div(sp.max(1e-4))));
      p.addAssign(v.mul(SUB_DT));
      p.assign(clamp(p, vec2(0.01, 0.01), vec2(w - 0.01, h - 0.01)));

      posA.element(i).assign(p);
      velA.element(i).assign(v);
    })().compute(n);
  }

  /* --------------------------------------------------------------- render */

  #buildSprite(posA: N, velA: N): THREE.Sprite {
    const { mode, size } = this.#opts;
    const material = new THREE.SpriteNodeMaterial();
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.transparent = true;
    material.fog = false;

    const origin = this.#originU as N;
    const ax = this.#axU as N;
    const ay = this.#ayU as N;

    const p = posA.element(instanceIndex) as N;
    const vel = velA.element(instanceIndex) as N;
    const speed = vertexStage(length(vel)) as N;

    material.positionNode = origin.add(ax.mul(p.x)).add(ay.mul(p.y));

    let col: N;
    let scale: N = float(size);
    if (mode === "sand") {
      const t = hash(instanceIndex) as N;
      const ochre = mix(vec3(0.72, 0.5, 0.26), vec3(0.94, 0.78, 0.5), t);
      const deep = vec3(0.45, 0.28, 0.15);
      col = mix(deep, ochre, saturate(speed.mul(0.9).add(0.35))).mul(LIGHT_SCALE * 0.5);
    } else {
      // star stuff: slow amber dust, fast blue-white — a temperature ramp
      const cold = vec3(0.85, 0.45, 0.18);
      const hot = vec3(0.75, 0.85, 1.05);
      col = mix(cold, hot, saturate(speed.mul(0.65).sub(0.25))).mul(saturate(speed.mul(0.8).add(0.4))).mul(LIGHT_SCALE * 0.9);
      scale = float(size).mul(saturate(speed.mul(0.3).add(0.75)));
    }

    const d2 = (uv() as N).sub(0.5).length().mul(2);
    const disc = smoothstep(1.0, 0.45, d2);
    material.colorNode = vec4(col, disc);
    material.scaleNode = vertexStage(scale);

    const sprite = new THREE.Sprite(material);
    sprite.count = this.#opts.n;
    sprite.frustumCulled = false;
    // Instanced sim sprites are never paintball targets; skip them during
    // raycast so Exploratorium.raycast (which never sets raycaster.camera)
    // doesn't hit Sprite.raycast and crash.
    sprite.raycast = () => {};
    return sprite;
  }

  /* ------------------------------------------------------------- control */

  setActive(on: boolean) {
    if (this.#active === on) return;
    this.#active = on;
    this.mesh.visible = on;
    this.#accum = 0;
  }

  get active() {
    return this.#active;
  }

  /** Aim the interaction point (local tank coords). `on` while the click is held. */
  stir(x: number, y: number, on: boolean) {
    const s = this.#stir.value as THREE.Vector3;
    s.x = x;
    s.y = y;
    s.z = on ? 1 : 0;
  }

  update(dt: number) {
    if (!this.#active) return;
    this.#accum = Math.min(this.#accum + dt, SUB_DT * 4);
    while (this.#accum >= SUB_DT) {
      this.#accum -= SUB_DT;
      for (const p of this.#passes) this.#renderer.compute(p.node);
      this.dispatches += this.#passes.length;
    }
  }
}

const SAND = { rint: 0.048, k: 480, c: 10, mu: 5, g: 3.4, stir: 26 };
const STARS = { rint: 0.05, coh: 0.08, k: 420, c: 16, mu: 7, cohK: 130, GM: 1.05, soft: 0.02, stirGM: 0.35, rim: 3.55 };

/* ======================================================================== */

/**
 * The ripple pool: a classic wave-equation heightfield on a 128×80 grid.
 * Poke it and rings spread, reflect off the rim and interfere — the plaque's
 * whole lesson visible from the pool's edge. Displacement + normals both read
 * straight from the GPU height buffer; nothing touches the CPU.
 */
export class RipplePool {
  mesh: THREE.Mesh;
  dispatches = 0;

  #renderer: THREE.WebGPURenderer;
  #active = false;
  #accum = 0;
  #rainT = 0;

  #gw: number;
  #gh: number;
  #w: number;
  #h: number;

  #poke = uniform(new THREE.Vector4(0, 0, 0, 0)); // x,y = cell coords, z = amp, w unused
  #stepVel: N;
  #stepHeight: N;

  constructor(
    renderer: THREE.WebGPURenderer,
    parent: THREE.Object3D,
    w: number,
    h: number,
    gw = 128,
    gh = 80
  ) {
    this.#renderer = renderer;
    this.#gw = gw;
    this.#gh = gh;
    this.#w = w;
    this.#h = h;
    const cells = gw * gh;

    const height = instancedArray(cells, "float");
    const veloc = instancedArray(cells, "float");
    const poke = this.#poke;

    // two dispatches per substep so neighbour reads never race the writes:
    // velocity integrates from a frozen height field, then heights advance
    this.#stepVel = Fn(() => {
      const i = instanceIndex;
      const x = (i.mod(uint(gw)) as N).toInt() as N;
      const y = (i.div(uint(gw)) as N).toInt() as N;
      const hC = height.element(i);
      const xm = max(x.sub(1), 0).toUint();
      const xp = min(x.add(1), gw - 1).toUint();
      const ym = max(y.sub(1), 0).toUint();
      const yp = min(y.add(1), gh - 1).toUint();
      const row = y.toUint().mul(uint(gw));
      const avg = height
        .element(row.add(xm))
        .add(height.element(row.add(xp)))
        .add(height.element(ym.mul(uint(gw)).add(x.toUint())))
        .add(height.element(yp.mul(uint(gw)).add(x.toUint())))
        .mul(0.25);
      const v = veloc.element(i);
      v.addAssign(avg.sub(hC).mul(0.5));
      // the poke lands in the velocity field as a gaussian kick
      const pd = vec2(x.toFloat().sub(poke.x), y.toFloat().sub(poke.y));
      v.addAssign(exp(pd.dot(pd).mul(-0.06)).mul(poke.z));
      v.mulAssign(0.994);
      // rim damping: the last few cells eat energy so edges don't ring hard
      const fx = x.toFloat();
      const fy = y.toFloat();
      const edge = min(min(fx, float(gw - 1).sub(fx)), min(fy, float(gh - 1).sub(fy)));
      v.mulAssign(mix(float(0.86), float(1), saturate(edge.mul(0.34))));
    })().compute(cells);

    this.#stepHeight = Fn(() => {
      const i = instanceIndex;
      const hC = height.element(i);
      hC.addAssign(veloc.element(i));
      hC.mulAssign(0.9995);
    })().compute(cells);

    // ---- surface mesh: one vertex per cell, displaced by the height buffer
    const geo = new THREE.PlaneGeometry(w, h, gw - 1, gh - 1);
    const mat = new THREE.MeshStandardNodeMaterial({
      color: new THREE.Color(0x06222e),
      roughness: 0.12,
      metalness: 0.0,
      transparent: true,
      opacity: 0.96
    });

    const idx = vertexIndex as N;
    const hHere = vertexStage(height.element(idx) as N) as N;
    // PlaneGeometry lies in XY before we rotate the mesh flat, so displacement
    // rides local +Z. Amplitude in metres.
    const AMP = 0.16;
    mat.positionNode = (positionLocal as N).add(vec3(0, 0, hHere.mul(AMP)));

    // normals from neighbour differences (guarded at the rim by clamping)
    const vx = (idx.mod(uint(gw)) as N).toInt() as N;
    const vy = (idx.div(uint(gw)) as N).toInt() as N;
    const xm2 = max(vx.sub(1), 0).toUint();
    const xp2 = min(vx.add(1), gw - 1).toUint();
    const ym2 = max(vy.sub(1), 0).toUint();
    const yp2 = min(vy.add(1), gh - 1).toUint();
    const row2 = vy.toUint().mul(uint(gw));
    const hL = vertexStage(height.element(row2.add(xm2))) as N;
    const hR = vertexStage(height.element(row2.add(xp2))) as N;
    const hD = vertexStage(height.element(ym2.mul(uint(gw)).add(vx.toUint()))) as N;
    const hU = vertexStage(height.element(yp2.mul(uint(gw)).add(vx.toUint()))) as N;
    const cellW = w / gw;
    const nrm = vec3(hL.sub(hR).mul(AMP), hD.sub(hU).mul(AMP), cellW * 2).normalize();
    mat.normalNode = transformNormalToView(nrm);

    // moving water tint: crests catch a cyan gleam, troughs stay ink-dark
    const gleam = saturate(hHere.mul(2.2).add(0.18));
    mat.emissiveNode = vec3(0.05, 0.55, 0.62).mul(gleam).mul(LIGHT_SCALE * 0.06);

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.rotation.x = -Math.PI / 2;
    parent.add(this.mesh);
  }

  /** Poke at local pool coords (metres from the pool's min corner). */
  poke(x: number, y: number, amp = 0.5) {
    const p = this.#poke.value as THREE.Vector4;
    p.x = (x / this.#w) * this.#gw;
    p.y = this.#gh - (y / this.#h) * this.#gh; // plane v runs opposite the local axis
    p.z = amp;
  }

  setActive(on: boolean) {
    this.#active = on;
  }

  get active() {
    return this.#active;
  }

  update(dt: number) {
    if (!this.#active) return;
    // idle rain keeps the surface alive for visitors who only watch
    this.#rainT -= dt;
    if (this.#rainT <= 0) {
      this.#rainT = 0.9 + Math.random() * 1.6;
      this.poke(Math.random() * this.#w, Math.random() * this.#h, 0.16 + Math.random() * 0.2);
    }
    this.#accum = Math.min(this.#accum + dt, 4 / 60);
    while (this.#accum >= 1 / 60) {
      this.#accum -= 1 / 60;
      this.#renderer.compute(this.#stepVel);
      this.#renderer.compute(this.#stepHeight);
      this.dispatches += 2;
      (this.#poke.value as THREE.Vector4).z = 0; // a poke lands exactly once
    }
  }
}
