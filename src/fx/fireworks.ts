import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  float,
  uint,
  vec3,
  vec4,
  uniform,
  instancedArray,
  instanceIndex,
  hash,
  uv,
  mix,
  smoothstep,
  saturate,
  exp,
  floor,
  sin,
  cos,
  sqrt,
  select,
  vertexStage,
  TWO_PI
} from "three/tsl";
import type { FolderApi, Pane } from "tweakpane";
import { LIGHT_SCALE } from "../config";
import { tunables } from "../core/persist";
import type { WorldMap } from "../world/heightmap";
import { AUDIO_TUNING, FireworksAudio } from "./fireworksAudio";

/**
 * GPU fireworks. The whole particle population lives in storage buffers and is
 * integrated by one compute pass; the CPU only decides *when and where* things
 * happen. Each frame the CPU packs at most CMD_MAX emit commands (a launch or a
 * burst) into a storage buffer and one masked compute dispatch writes the new
 * particles into a ring-buffer slice of the pool — so a burst of 10k sparks
 * costs the CPU 20 floats, and cranking the sliders only moves GPU-side work.
 *
 * Launch trails and crackle pops need no per-frame CPU scheduling either: they
 * are emitted up-front with a birth delay, and the sim/render shaders keep them
 * inert/invisible until their moment (the trail's spawn point along the rocket
 * arc is closed-form, so it can be precomputed at launch).
 *
 * Rendering is a single instanced additive sprite draw; dead particles collapse
 * to zero scale and rasterize nothing. Colors are HDR (scaled by LIGHT_SCALE)
 * so the glow reads directly without a separate bloom pass.
 */

const POOL = 1 << 19; // 524288 particles; ring buffer, oldest overwritten under crank
const MAX_SPARKS = 8192;
const MAX_CRACKLE = 2048;
const MAX_TRAIL = 160;
const STRIDE = 1 + MAX_SPARKS + MAX_CRACKLE; // thread slots reserved per command
const CMD_MAX = 96; // commands per frame; overflow carries to the next frame
const CMD_FLOATS = 20; // 5 vec4 per command
const DRONE_FIREWORK_FORWARD = 80;
const DRONE_FIREWORK_RISE = 15;
const DRONE_FIREWORK_FLIGHT = 1.05;
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// particle kinds (pLife.z)
const K_ROCKET = 1;
const K_TRAIL = 2;
const K_SPARK = 3;
const K_CRACKLE = 4;
const K_FLASH = 5;

// Dedicated red / white / blue shells for the parade truck's rocket battery —
// [core, accent] pairs, HDR (LIGHT_SCALE applied at draw). Saturated so the hue
// survives additive over-brightening; the blue is deep on purpose (a pale blue
// just washes to white against the bright core).
const RWB: [[number, number, number], [number, number, number]][] = [
  [
    [1.0, 0.1, 0.08],
    [1.0, 0.32, 0.16]
  ], // red → warm tips
  [
    [1.0, 1.0, 1.0],
    [0.82, 0.86, 1.0]
  ], // white → faint cool tips
  [
    [0.12, 0.26, 1.0],
    [0.2, 0.42, 1.0]
  ] // blue → stays blue as it dies
];

const PALETTES: [number, number, number][][] = [
  [
    [1.0, 0.28, 0.08],
    [1.0, 0.78, 0.28]
  ],
  [
    [0.35, 0.72, 1.0],
    [0.78, 0.95, 1.0]
  ],
  [
    [0.92, 0.24, 1.0],
    [0.24, 0.88, 1.0]
  ],
  [
    [0.52, 1.0, 0.42],
    [1.0, 0.92, 0.36]
  ],
  [
    [1.0, 0.9, 0.72],
    [1.0, 0.35, 0.16]
  ]
];

type Cmd = {
  kind: number;
  count: number;
  ox: number;
  oy: number;
  oz: number;
  vx: number;
  vy: number;
  vz: number;
  p0: number; // launch: flight time · burst: burst speed
  color: [number, number, number];
  accent: [number, number, number];
  seed: number;
  aux: number; // launch: trail count · burst: spark count
  aux2: number; // burst: crackle count
  size: number;
  ttl: number; // rough max particle lifetime, for the alive estimate
};

type Point3 = { x: number; y: number; z: number };

type Rocket = {
  at: number;
  x: number;
  y: number;
  z: number;
  color: [number, number, number];
  accent: [number, number, number];
  secondary?: number; // child bursts that bloom out of this one a beat later
  sizeScale?: number; // >1 = a bigger, harder-throwing shell
};

// Show tuning ("/" panel, F folder), persisted to localStorage. Defaults live
// inline with their slider ranges. airAltSpread = total vertical spread (m)
// around player altitude in fly/drone; holdRate/autoRate in volleys/s.
const FIREWORKS_TUNING = tunables("fireworks", {
  rockets: { v: 6, min: 1, max: 200, step: 1, label: "rockets/volley" },
  sparks: { v: 1800, min: 64, max: MAX_SPARKS, step: 32, label: "sparks/burst" },
  crackle: { v: 320, min: 0, max: MAX_CRACKLE, step: 16, label: "crackle/burst" },
  trail: { v: 64, min: 0, max: MAX_TRAIL, step: 4, label: "trail sparks" },
  distance: { v: 140, min: 20, max: 500, step: 5, label: "launch distance" },
  lateralSpread: { v: 90, min: 0, max: 400, step: 5, label: "lateral spread" },
  depthSpread: { v: 110, min: 0, max: 500, step: 5, label: "depth spread" },
  burstHeight: { v: 120, min: 30, max: 300, step: 5, label: "burst height" },
  airAltSpread: { v: 80, min: 10, max: 400, step: 5, label: "air alt spread" },
  flightTime: { v: 1.9, min: 0.8, max: 3, step: 0.05, label: "flight time (s)" },
  burstSpeed: { v: 30, min: 8, max: 60, step: 1, label: "burst speed" },
  shells: { v: 4, min: 1, max: 6, step: 1, label: "shells" },
  sparkSize: { v: 0.9, min: 0.2, max: 3, step: 0.05, label: "spark size" },
  intensity: { v: 1.2, min: 0.1, max: 4, step: 0.05, label: "intensity" },
  gravity: { v: 9.8, min: 0, max: 25, step: 0.1, label: "gravity" },
  drag: { v: 1.1, min: 0.2, max: 3, step: 0.05, label: "drag" },
  holdRate: { v: 4, min: 1, max: 30, step: 1, label: "hold rate (/s)" },
  auto: { v: false, label: "auto show" },
  autoRate: { v: 3, min: 0.5, max: 20, step: 0.5, label: "auto rate (/s)" }
});

export class Fireworks {
  params = FIREWORKS_TUNING.values;

  stats = { alive: 0, queuedCmds: 0 };

  audio = new FireworksAudio();

  /** Every locally launched rocket this frame, as wire rows
   * [ox,oy,oz,tx,ty,tz,flightTime,palette,size] — main.ts forwards them to
   * the relay so other players see the same show (net.sendFireworks). */
  onVolley: (rockets: number[][]) => void = () => {};

  #renderer: THREE.WebGPURenderer;
  #map: WorldMap;
  #listener = { x: 0, y: 0, z: 0, yaw: 0 };

  #outbox: number[][] = [];
  #pending: Cmd[] = [];
  #rockets: Rocket[] = [];
  #aliveEvents: { expire: number; count: number }[] = [];
  #cursor = 0;
  #highWater = 0;
  #now = 0;
  #holdT = 0;
  #autoT = 0;
  #rwbi = 0; // cursor so the truck's shells cycle red→white→blue evenly

  // gpu resources
  #pPos = instancedArray(POOL, "vec4"); // xyz pos, w size
  #pVel = instancedArray(POOL, "vec4"); // xyz vel, w birth delay
  #pLife = instancedArray(POOL, "vec4"); // age, maxLife, kind, twinkle seed
  #pColA = instancedArray(POOL, "vec4");
  #pColB = instancedArray(POOL, "vec4");
  #cmdBuf = instancedArray(CMD_MAX * 5, "vec4");

  #cmdCountU = uniform(0);
  #dtU = uniform(0.016);
  #gravU = uniform(9.8);
  #dragU = uniform(1.1);
  #shellsU = uniform(4);
  #intensityU = uniform(1.2);

  // field-initialized after the buffers/uniforms above so types stay inferred
  #emitCompute = this.#buildEmit();
  #simCompute = this.#buildSim();
  #sprite = this.#buildSprite();

  constructor(renderer: THREE.WebGPURenderer, scene: THREE.Scene, map: WorldMap) {
    this.#renderer = renderer;
    this.#map = map;
    scene.add(this.#sprite);
  }

  #buildEmit() {
    const pPos = this.#pPos;
    const pVel = this.#pVel;
    const pLife = this.#pLife;
    const pColA = this.#pColA;
    const pColB = this.#pColB;
    const cmds = this.#cmdBuf;
    const cmdCount = this.#cmdCountU;
    const grav = this.#gravU;
    const shellsU = this.#shellsU;

    return Fn(() => {
      const cmdIdx = instanceIndex.div(uint(STRIDE));
      If(cmdIdx.toFloat().lessThan(cmdCount), () => {
        const base = cmdIdx.mul(uint(5));
        const c0 = cmds.element(base); // origin.xyz, count
        const c1 = cmds.element(base.add(uint(1))); // vel.xyz, p0
        const c2 = cmds.element(base.add(uint(2))); // color.rgb, kind
        const c3 = cmds.element(base.add(uint(3))); // accent.rgb, seed
        const c4 = cmds.element(base.add(uint(4))); // cursor, aux, aux2, size

        const localU = instanceIndex.mod(uint(STRIDE));
        const localF = localU.toFloat();
        If(localF.lessThan(c0.w), () => {
          const slot = c4.x.toUint().add(localU).bitAnd(uint(POOL - 1));
          const rid = localU.add(c3.w.toUint()).mul(uint(7919));
          const r0 = hash(rid);
          const r1 = hash(rid.add(uint(1)));
          const r2 = hash(rid.add(uint(2)));
          const r3 = hash(rid.add(uint(3)));
          const r4 = hash(rid.add(uint(4)));
          const r5 = hash(rid.add(uint(5)));
          const r6 = hash(rid.add(uint(6)));
          const pSeed = hash(rid.add(uint(7))).mul(100);

          const origin = c0.xyz;
          const color = c2.xyz;
          const accent = c3.xyz;
          const size = c4.w;

          // uniform direction on the sphere
          const z = r0.mul(2).sub(1);
          const rr = sqrt(saturate(z.mul(z).oneMinus()));
          const phi = r1.mul(TWO_PI);
          const dir = vec3(rr.mul(cos(phi)), z, rr.mul(sin(phi)));

          If(c2.w.lessThan(1.5), () => {
            // ---- launch command: one rocket + its whole trail, pre-scheduled
            If(localU.equal(uint(0)), () => {
              pPos.element(slot).assign(vec4(origin, size.mul(2.4)));
              pVel.element(slot).assign(vec4(c1.xyz, 0));
              pLife.element(slot).assign(vec4(0, c1.w, K_ROCKET, pSeed));
              const head = mix(accent, vec3(1.2, 1.15, 1.0), 0.6);
              pColA.element(slot).assign(vec4(head, 1));
              pColB.element(slot).assign(vec4(accent, 1));
            }).Else(() => {
              // trail spark i wakes at its slice of the flight and appears at
              // the rocket's closed-form arc position for that moment
              const trailN = c4.y.max(1);
              const fr = localF.sub(1).add(r2).div(trailN);
              const d = fr.mul(c1.w);
              const gR = grav.mul(0.35);
              const bp = origin
                .add(c1.xyz.mul(d))
                .sub(vec3(0, 1, 0).mul(gR.mul(d).mul(d).mul(0.5)));
              const tv = c1.xyz.mul(0.12).add(dir.mul(r3.mul(1.4).add(0.5)));
              pPos.element(slot).assign(vec4(bp, size.mul(0.8).mul(r4.mul(0.5).add(0.7))));
              pVel.element(slot).assign(vec4(tv, d));
              pLife.element(slot).assign(vec4(0, d.add(r5.mul(0.45).add(0.3)), K_TRAIL, pSeed));
              pColA.element(slot).assign(vec4(mix(accent, vec3(1.1, 0.9, 0.6), 0.5), 1));
              pColB.element(slot).assign(vec4(accent.mul(0.35), 1));
            });
          }).Else(() => {
            // ---- burst command: flash + peony sparks + delayed crackle
            const sparkN = c4.y;
            If(localU.equal(uint(0)), () => {
              pPos.element(slot).assign(vec4(origin, size.mul(16)));
              pVel.element(slot).assign(vec4(0, 0, 0, 0));
              pLife.element(slot).assign(vec4(0, 0.22, K_FLASH, pSeed));
              const fc = mix(color, vec3(1, 1, 1), 0.65);
              pColA.element(slot).assign(vec4(fc, 1));
              pColB.element(slot).assign(vec4(fc, 1));
            })
              .ElseIf(localF.lessThanEqual(sparkN), () => {
                // quantized shell speeds read as layered petals
                const shells = shellsU.max(1);
                const sIdx = floor(r2.mul(shells)).min(shells.sub(1));
                const speedF = sIdx.add(1).div(shells).mul(0.55).add(0.45);
                const speed = c1.w.mul(speedF).mul(r3.mul(0.3).add(0.85));
                pPos.element(slot).assign(vec4(origin, size.mul(r4.mul(0.6).add(0.7))));
                pVel.element(slot).assign(vec4(dir.mul(speed), 0));
                pLife.element(slot).assign(vec4(0, r5.mul(1.2).add(1.5), K_SPARK, pSeed));
                pColA.element(slot).assign(vec4(mix(color, accent, r6.mul(r6).mul(0.7)), 1));
                pColB.element(slot).assign(vec4(accent, 1));
              })
              .Else(() => {
                // crackle rides the shell invisibly, then pops white
                const speed = c1.w.mul(r2.mul(0.35).add(0.4));
                const cd = r3.mul(1.1).add(0.35);
                pPos.element(slot).assign(vec4(origin, size.mul(0.65)));
                pVel.element(slot).assign(vec4(dir.mul(speed), cd));
                pLife.element(slot).assign(vec4(0, cd.add(r5.mul(0.1).add(0.1)), K_CRACKLE, pSeed));
                pColA.element(slot).assign(vec4(1.6, 1.5, 1.25, 1));
                pColB.element(slot).assign(vec4(color.mul(1.2), 1));
              });
          });
        });
      });
    })().compute(CMD_MAX * STRIDE);
  }

  #buildSim() {
    const pPos = this.#pPos;
    const pVel = this.#pVel;
    const pLife = this.#pLife;
    const dt = this.#dtU;
    const grav = this.#gravU;
    const dragU = this.#dragU;

    return Fn(() => {
      const life = pLife.element(instanceIndex);
      If(life.y.greaterThan(0).and(life.x.lessThan(life.y)), () => {
        const pos = pPos.element(instanceIndex);
        const vel = pVel.element(instanceIndex);
        const kind = life.z;
        const age = life.x.add(dt).toVar();
        life.x.assign(age);

        const isRocket = kind.equal(float(K_ROCKET));
        const isTrail = kind.equal(float(K_TRAIL));
        const isFlash = kind.equal(float(K_FLASH));
        const gMul = select(isRocket, float(0.35), select(isTrail, float(0.1), select(isFlash, float(0), float(1))));
        const drag = select(isRocket, float(0), select(isTrail, float(1.6), dragU));

        // trail sparks hold at their precomputed arc position until birth
        If(isTrail.not().or(age.greaterThanEqual(vel.w)), () => {
          vel.y.subAssign(grav.mul(gMul).mul(dt));
          const damp = exp(drag.negate().mul(dt));
          vel.x.mulAssign(damp);
          vel.y.mulAssign(damp);
          vel.z.mulAssign(damp);
          pos.x.addAssign(vel.x.mul(dt));
          pos.y.addAssign(vel.y.mul(dt));
          pos.z.addAssign(vel.z.mul(dt));
        });
      });
    })().compute(POOL);
  }

  #buildSprite() {
    const pPos = this.#pPos;
    const pVel = this.#pVel;
    const pLife = this.#pLife;
    const pColA = this.#pColA;
    const pColB = this.#pColB;
    const intensity = this.#intensityU;

    // per-particle HDR color + scale, computed once in the vertex stage
    const packed = vertexStage(
      Fn(() => {
        const life = pLife.element(instanceIndex);
        const vel = pVel.element(instanceIndex);
        const pos = pPos.element(instanceIndex);
        const age = life.x;
        const maxLife = life.y;
        const kind = life.z;
        const seed = life.w;
        const delay = vel.w;
        const span = maxLife.sub(delay).max(1e-4);
        const t = saturate(age.sub(delay).div(span));
        const inv = t.oneMinus();
        const on = select(
          maxLife.greaterThan(0).and(age.lessThan(maxLife)).and(age.greaterThanEqual(delay)),
          float(1),
          float(0)
        );

        const isRocket = kind.equal(float(K_ROCKET));
        const isTrail = kind.equal(float(K_TRAIL));
        const isSpark = kind.equal(float(K_SPARK));
        const isCrackle = kind.equal(float(K_CRACKLE));

        // sparks strobe as they die out
        const twinkle = mix(
          float(1),
          saturate(sin(age.mul(seed.fract().mul(20).add(12)).add(seed)).mul(0.5).add(0.5)).mul(0.85).add(0.15),
          smoothstep(0.45, 0.75, t)
        );
        const bright = select(
          isRocket,
          float(2.6).add(sin(age.mul(40).add(seed)).mul(0.5)),
          select(
            isTrail,
            inv.pow(2).mul(1.5),
            select(isSpark, inv.pow(1.6).mul(2.2).mul(twinkle), select(isCrackle, inv.pow(2).mul(6), inv.pow(2).mul(3.5)))
          )
        );
        const grow = smoothstep(0.0, 0.06, t).mul(0.55).add(0.45);
        const scl = select(
          isRocket,
          float(0), // hide the bright launch ball — the ascent reads as just its trail
          select(
            isTrail,
            pos.w.mul(inv.mul(0.75).add(0.25)),
            select(
              isSpark,
              pos.w.mul(grow).mul(inv.mul(0.85).add(0.15)),
              select(isCrackle, pos.w, pos.w.mul(t.mul(1.8).add(0.6)))
            )
          )
        );
        const col = mix(pColA.element(instanceIndex).xyz, pColB.element(instanceIndex).xyz, smoothstep(0.12, 0.8, t));
        const rgb = col.mul(bright).mul(intensity).mul(LIGHT_SCALE).mul(on);
        return vec4(rgb, scl.mul(on));
      })()
    );

    const material = new THREE.SpriteNodeMaterial();
    material.positionNode = pPos.element(instanceIndex).xyz;
    material.scaleNode = packed.w;
    // soft radial falloff with a hot core — no texture needed
    const d = uv().sub(0.5).length().mul(2);
    const soft = saturate(d.oneMinus()).pow(2.4);
    const core = saturate(d.mul(1.6).oneMinus()).pow(5).mul(2.5);
    material.colorNode = vec4(packed.xyz.mul(soft.add(core)), 1);
    material.blending = THREE.AdditiveBlending;
    material.transparent = true;
    material.depthWrite = false;

    const sprite = new THREE.Sprite(material);
    sprite.count = 0;
    sprite.frustumCulled = false;
    sprite.renderOrder = 100;
    sprite.visible = false;
    return sprite;
  }

  /** One volley of rockets launched ahead of `origin` along heading `yaw`. */
  #volley(origin: THREE.Vector3, yaw: number, fly = false, speed = 0) {
    const p = this.params;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = -fz;
    const rz = fx;
    const n = Math.round(THREE.MathUtils.clamp(p.rockets, 1, 200));
    const trailN = Math.round(THREE.MathUtils.clamp(p.trail, 0, MAX_TRAIL));

    for (let i = 0; i < n; i++) {
      const lat = (Math.random() - 0.5) * p.lateralSpread * (fly ? 1.6 : 1);
      const T = p.flightTime * (0.85 + Math.random() * 0.3);
      // flying: lead the plane by its travel during the rocket's flight and
      // stretch the spread, so bursts pop around where the player will be
      const lead = fly ? speed * (T + 0.4) : 0;
      const depth = (p.distance + Math.random() * p.depthSpread) * (fly ? 1.8 : 1) + lead;
      const bx = origin.x + fx * depth + rx * lat;
      const bz = origin.z + fz * depth + rz * lat;
      const by = Math.max(this.#map.effectiveGround(bx, bz), 0) + 1;
      const h = p.burstHeight * (0.8 + Math.random() * 0.4);
      const tx = bx + (Math.random() - 0.5) * h * 0.25;
      const tz = bz + (Math.random() - 0.5) * h * 0.25;
      // flying: burst near the plane/drone altitude with scatter above/below
      const ty = fly
        ? Math.max(by + 15, origin.y + (Math.random() - 0.5) * p.airAltSpread)
        : by + h;

      const palette = Math.floor(Math.random() * PALETTES.length);
      this.#queueLaunch({ x: bx, y: by, z: bz }, { x: tx, y: ty, z: tz }, T, palette, trailN, p.sparkSize);
    }
  }

  #queueLaunch(
    origin: Point3,
    target: Point3,
    flightTime: number,
    palette: number,
    trailN: number,
    size: number,
    broadcast = true
  ) {
    const [color, accent] = PALETTES[palette];
    // solve the launch velocity so the arc reaches the target after flightTime
    const gR = this.params.gravity * 0.35;
    this.#pending.push({
      kind: 1,
      count: 1 + trailN,
      ox: origin.x,
      oy: origin.y,
      oz: origin.z,
      vx: (target.x - origin.x) / flightTime,
      vy: (target.y - origin.y) / flightTime + 0.5 * gR * flightTime,
      vz: (target.z - origin.z) / flightTime,
      p0: flightTime,
      color,
      accent,
      seed: Math.floor(Math.random() * 2 ** 30),
      aux: trailN,
      aux2: 0,
      size,
      ttl: flightTime + 0.8
    });
    this.#rockets.push({ at: this.#now + flightTime, x: target.x, y: target.y, z: target.z, color, accent });
    if (broadcast) {
      const r2 = (n: number) => Math.round(n * 100) / 100;
      this.#outbox.push([
        r2(origin.x),
        r2(origin.y),
        r2(origin.z),
        r2(target.x),
        r2(target.y),
        r2(target.z),
        r2(flightTime),
        palette,
        r2(size)
      ]);
    }
  }

  /** Replay a volley another player broadcast (net "fw" rows, same wire
   * format as onVolley). Trajectory/palette come off the wire; spark counts
   * and trail length stay this client's own tuning. */
  launchRemote(rockets: number[][]) {
    const trailN = Math.round(THREE.MathUtils.clamp(this.params.trail, 0, MAX_TRAIL));
    for (const r of rockets) {
      if (r.length !== 9 || !r.every(Number.isFinite)) continue;
      const T = THREE.MathUtils.clamp(r[6], 0.5, 4);
      const palette = THREE.MathUtils.euclideanModulo(r[7] | 0, PALETTES.length);
      const size = THREE.MathUtils.clamp(r[8], 0.2, 3);
      this.#queueLaunch({ x: r[0], y: r[1], z: r[2] }, { x: r[3], y: r[4], z: r[5] }, T, palette, trailN, size, false);
    }
  }

  launchDroneSalvo(mounts: readonly THREE.Object3D[], aim: THREE.Vector3, velocity?: THREE.Vector3) {
    if (mounts.length === 0) return;
    const p = this.params;
    const trailN = Math.round(THREE.MathUtils.clamp(p.trail, 0, MAX_TRAIL));
    const viewForward = new THREE.Vector3().copy(aim);
    if (viewForward.lengthSq() < 1e-5) viewForward.set(0, 0, -1);
    viewForward.normalize();
    viewForward.y = THREE.MathUtils.clamp(viewForward.y, -0.22, 0.35);
    viewForward.normalize();
    const flatForward = new THREE.Vector3(viewForward.x, 0, viewForward.z);
    if (flatForward.lengthSq() < 1e-5) flatForward.set(0, 0, -1);
    flatForward.normalize();
    const right = new THREE.Vector3(-flatForward.z, 0, flatForward.x);
    const origin = new THREE.Vector3();
    const target = new THREE.Vector3();
    const mid = (mounts.length - 1) * 0.5;

    for (let i = 0; i < mounts.length; i++) {
      mounts[i].getWorldPosition(origin);
      const flightTime = DRONE_FIREWORK_FLIGHT * (0.92 + Math.random() * 0.16);
      const lateral = (i - mid) * 5 + (Math.random() - 0.5) * 3;
      const groundSpeed = velocity ? Math.hypot(velocity.x, velocity.z) : 0;
      target
        .copy(origin)
        .addScaledVector(viewForward, DRONE_FIREWORK_FORWARD + Math.random() * 16 + groundSpeed * 0.35)
        .addScaledVector(right, lateral)
        .addScaledVector(WORLD_UP, DRONE_FIREWORK_RISE + Math.random() * 8);
      // lead the burst by the drone's travel during flight (+ buffer), same idea as fly volleys
      if (velocity) target.addScaledVector(velocity, flightTime + 0.4);
      const palette = Math.floor(Math.random() * PALETTES.length);
      this.#queueLaunch(origin, target, flightTime, palette, trailN, p.sparkSize * 0.85);
    }
  }

  /** A short celebratory volley straight off a point (loot chests, wins). */
  launchCelebration(x: number, y: number, z: number, count = 3) {
    const trailN = Math.round(THREE.MathUtils.clamp(this.params.trail, 0, MAX_TRAIL));
    for (let i = 0; i < count; i++) {
      const T = 1.1 + Math.random() * 0.5;
      const target = {
        x: x + (Math.random() - 0.5) * 24,
        y: y + 40 + Math.random() * 28,
        z: z + (Math.random() - 0.5) * 24
      };
      const palette = Math.floor(Math.random() * PALETTES.length);
      this.#queueLaunch({ x, y: y + 0.5, z }, target, T, palette, trailN, this.params.sparkSize * 0.85);
    }
  }

  /**
   * Launch one shell from `origin` that bursts at `target` after `flightTime`
   * seconds — the public seam mounted launchers use to fire their own arcs (the
   * parade truck's honeycomb rack). `palette` < 0 picks a random palette;
   * broadcasts to the relay like any local volley so other players see it.
   */
  launchShell(origin: THREE.Vector3, target: THREE.Vector3, flightTime: number, palette = -1, size = this.params.sparkSize) {
    const trailN = Math.round(THREE.MathUtils.clamp(this.params.trail, 0, MAX_TRAIL));
    const pal = palette < 0
      ? Math.floor(Math.random() * PALETTES.length)
      : THREE.MathUtils.euclideanModulo(palette | 0, PALETTES.length);
    this.#queueLaunch(
      { x: origin.x, y: origin.y, z: origin.z },
      { x: target.x, y: target.y, z: target.z },
      Math.max(0.5, flightTime),
      pal,
      trailN,
      size
    );
  }

  #burst(r: Rocket) {
    const p = this.params;
    const scale = r.sizeScale ?? 1;
    const sparks = Math.round(THREE.MathUtils.clamp(p.sparks * scale, 8, MAX_SPARKS));
    const crackle = Math.round(THREE.MathUtils.clamp(p.crackle * scale, 0, MAX_CRACKLE));
    const l = this.#listener;
    // bigger shells hit harder; the audio layer handles distance delay/rolloff
    this.audio.boom(r.x, r.y, r.z, l.x, l.y, l.z, l.yaw, Math.min(1.6, (0.7 + (sparks / MAX_SPARKS) * 0.6) * scale));
    this.#pending.push({
      kind: 2,
      count: 1 + sparks + crackle,
      ox: r.x,
      oy: r.y,
      oz: r.z,
      vx: 0,
      vy: 0,
      vz: 0,
      p0: p.burstSpeed * (0.85 + 0.25 * scale), // a fatter shell throws its petals farther
      color: r.color,
      accent: r.accent,
      seed: Math.floor(Math.random() * 2 ** 30),
      aux: sparks,
      aux2: crackle,
      size: p.sparkSize * scale,
      ttl: 3.2
    });

    // shell-of-shells: a beat after the primary opens, a ring of child bursts
    // blooms out of it — the "and then it explodes AGAIN, into even more" stage.
    const sec = r.secondary ?? 0;
    if (sec > 0) {
      const childScale = Math.max(0.7, scale * 0.7);
      const spread = p.burstSpeed * scale * 0.5; // ~where the primary petals reach
      for (let i = 0; i < sec; i++) {
        const a = (i / sec) * Math.PI * 2 + Math.random() * 0.6;
        const rad = spread * (0.55 + Math.random() * 0.6);
        const [color, accent] = this.#nextRWB();
        this.#rockets.push({
          at: this.#now + 0.45 + Math.random() * 0.22,
          x: r.x + Math.cos(a) * rad,
          y: r.y + (Math.random() - 0.3) * spread * 0.5,
          z: r.z + Math.sin(a) * rad,
          color,
          accent,
          secondary: 0,
          sizeScale: childScale
        });
      }
    }
  }

  /** Next red/white/blue shell, cycled so a barrage stays evenly patriotic. */
  #nextRWB(): [[number, number, number], [number, number, number]] {
    return RWB[this.#rwbi++ % RWB.length];
  }

  /**
   * Detonate a shell immediately at a world point — the seam a self-flying
   * mounted rocket calls when it reaches its own apex (the parade truck's bed
   * battery). `secondary` blooms a delayed ring of child bursts out of the
   * first; colors are red/white/blue. Not broadcast — the launcher that owns the
   * flying rockets replays their arcs on other clients.
   */
  burstAt(pos: THREE.Vector3, opts: { secondary?: number; sizeScale?: number } = {}) {
    const [color, accent] = this.#nextRWB();
    this.#rockets.push({
      at: this.#now,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      color,
      accent,
      secondary: opts.secondary ?? 0,
      sizeScale: opts.sizeScale ?? 1.5
    });
  }

  update(
    dt: number,
    ctx: { hold: boolean; origin: THREE.Vector3; yaw: number; fly?: boolean; speed?: number }
  ) {
    const p = this.params;
    this.#now += dt;
    const now = this.#now;
    const fly = ctx.fly ?? false;
    const speed = ctx.speed ?? 0;
    this.#listener.x = ctx.origin.x;
    this.#listener.y = ctx.origin.y;
    this.#listener.z = ctx.origin.z;
    this.#listener.yaw = ctx.yaw;

    // hold-F autofire (first press fires immediately)
    if (ctx.hold) {
      this.#holdT -= dt;
      if (this.#holdT <= 0) {
        this.#volley(ctx.origin, ctx.yaw, fly, speed);
        this.#holdT = 1 / Math.max(0.5, p.holdRate);
      }
    } else {
      this.#holdT = 0;
    }

    // auto show for perf soak testing
    if (p.auto) {
      this.#autoT -= dt;
      if (this.#autoT <= 0) {
        this.#volley(ctx.origin, ctx.yaw + (Math.random() - 0.5) * 1.2, fly, speed);
        this.#autoT = 1 / Math.max(0.1, p.autoRate);
      }
    }

    // ship this frame's locally launched rockets to the relay in one batch
    if (this.#outbox.length) {
      this.onVolley(this.#outbox);
      this.#outbox = [];
    }

    // rockets that reached apex become bursts
    for (let i = this.#rockets.length - 1; i >= 0; i--) {
      if (this.#rockets[i].at <= now) {
        this.#burst(this.#rockets[i]);
        this.#rockets.splice(i, 1);
      }
    }

    // cap the backlog so an over-cranked queue can't grow without bound
    if (this.#pending.length > 600) this.#pending.splice(0, this.#pending.length - 600);

    // drain up to CMD_MAX commands into the storage buffer and emit
    const drained = Math.min(this.#pending.length, CMD_MAX);
    if (drained > 0) {
      const attr = this.#cmdBuf.value as THREE.StorageInstancedBufferAttribute;
      const arr = attr.array as Float32Array;
      for (let i = 0; i < drained; i++) {
        const c = this.#pending[i];
        const o = i * CMD_FLOATS;
        arr[o] = c.ox;
        arr[o + 1] = c.oy;
        arr[o + 2] = c.oz;
        arr[o + 3] = c.count;
        arr[o + 4] = c.vx;
        arr[o + 5] = c.vy;
        arr[o + 6] = c.vz;
        arr[o + 7] = c.p0;
        arr[o + 8] = c.color[0];
        arr[o + 9] = c.color[1];
        arr[o + 10] = c.color[2];
        arr[o + 11] = c.kind;
        arr[o + 12] = c.accent[0];
        arr[o + 13] = c.accent[1];
        arr[o + 14] = c.accent[2];
        arr[o + 15] = c.seed;
        arr[o + 16] = this.#cursor;
        arr[o + 17] = c.aux;
        arr[o + 18] = c.aux2;
        arr[o + 19] = c.size;
        const end = this.#cursor + c.count;
        this.#highWater = end >= POOL ? POOL : Math.max(this.#highWater, end);
        this.#cursor = end % POOL;
        this.#aliveEvents.push({ expire: now + c.ttl, count: c.count });
      }
      this.#pending.splice(0, drained);
      attr.needsUpdate = true;
      this.#cmdCountU.value = drained;
      this.#renderer.compute(this.#emitCompute);
    }

    // alive estimate drives the HUD stat and lets us skip work when idle
    let alive = 0;
    for (let i = this.#aliveEvents.length - 1; i >= 0; i--) {
      if (this.#aliveEvents[i].expire <= now) this.#aliveEvents.splice(i, 1);
      else alive += this.#aliveEvents[i].count;
    }
    this.stats.alive = Math.min(alive, POOL);
    this.stats.queuedCmds = this.#pending.length;

    const active = alive > 0 || drained > 0;
    this.#sprite.visible = active;
    // once everything has expired the sprite is hidden, so the ring can rewind:
    // otherwise highWater ratchets to its crank-peak and every later launch pays
    // vertex work for the whole peak range forever
    if (!active && this.#highWater > 0) {
      this.#highWater = 0;
      this.#cursor = 0;
    }
    this.#sprite.count = this.#highWater;
    if (active) {
      this.#dtU.value = Math.min(dt, 0.05);
      this.#gravU.value = p.gravity;
      this.#dragU.value = p.drag;
      this.#shellsU.value = Math.round(p.shells);
      this.#intensityU.value = p.intensity;
      this.#renderer.compute(this.#simCompute);
    }
  }

  addTuning(pane: Pane | FolderApi) {
    const f = pane.addFolder({ title: "fireworks (F)" });
    FIREWORKS_TUNING.bind(f);
    AUDIO_TUNING.bind(f);
    f.addBinding(this.stats, "alive", { readonly: true, format: (v: number) => `${Math.round(v)}`, label: "≈alive" });
    f.addBinding(this.stats, "queuedCmds", { readonly: true, format: (v: number) => `${Math.round(v)}`, label: "queued cmds" });
  }
}
