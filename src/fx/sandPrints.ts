// Footprints in the sand.
//
// One pooled InstancedMesh of small ground quads — the same shape as the
// asphalt skid marks (fx/skidMarks.ts), with three differences that matter:
//
//  · MULTIPLY BLENDING. A print is not paint, it is a dent: the fragment
//    outputs a MULTIPLIER (a shade under 1 in the hollow, a touch over 1 on the
//    displaced lip) and the framebuffer supplies the sand. That inherits the
//    terrain's own lighting, shadowing and the wet-sand band for free — no
//    lighting integration, no second material, correct at every hour.
//  · ONE SINK, EVERY WALKER. The local player, the beach kite runners and
//    remote players all call the same `stamp`, which owns the rules: sand only,
//    near the player only, shorter life in the swash. Callers stay dumb.
//  · LAZY. Nothing is built until someone is about to walk on sand, and the
//    mesh drops itself again after a long while with no footfalls.
//
// Budget: ~5.5 stamps/second per walker, 9 walkers worst case. Each stamp is
// one Matrix4.compose plus four floats. The draw is one instanced call whose
// prints are a few centimetres across; at MAX_PRINTS the pool is 60 KB.

import * as THREE from "three/webgpu";
import {
  cameraPosition,
  clamp,
  cos,
  float,
  instancedBufferAttribute,
  min,
  mix,
  mx_noise_float,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  uv,
  vec2,
  vec3,
  vertexStage
} from "three/tsl";
import type { WorldMap } from "../world/heightmap";
import { SUN_DIR } from "../world/sky";

// TSL node generics fight composition; any is the idiom here (see facade.ts)
type N = any;

// A walker sheds ~5.5 prints a second. The busiest sand in the world is the
// kite beach: seven runners plus the player, ~44/s, so a pool that holds a full
// DRY_LIFE without recycling a still-visible print needs about this many.
const MAX_PRINTS = 1152;
/** surface.bin class id for sand. */
const SAND = 2;
const TAU = Math.PI * 2;

/** Metres above the sampled ground. Small — polygonOffset does the real work. */
const LIFT = 0.015;
/** Sole footprint, metres. */
const PRINT_LENGTH = 0.34;
const PRINT_WIDTH = 0.17;
/** Half the stance width: how far the foot lands off the walking line. */
const STANCE = 0.12;
/** How far ahead of the body centre the foot plants. */
const LEAD = 0.14;
/** Seconds a print survives up on the dry beach. */
const DRY_LIFE = 26;
/** …and down where the swash still reaches, which erases them. */
const WET_LIFE = 7;
/** World height (metres above the y≈0 waterline) that counts as still-wet. */
const WET_HEIGHT = 1.4;
/** Beyond this from the player a stamp is not worth a slot. */
const STAMP_RANGE = 110;
/** Print detail fades out over this range so distant prints never shimmer. */
const FADE_NEAR = 55;
const FADE_FAR = 105;
/** Deepest shading a print can take out of the sand under it. */
const PRINT_DEPTH = 0.34;
/** Brightest lift the displaced lip can add. */
const PRINT_RIM = 0.11;
/** No footfall for this long (and nothing left on screen) → give the GPU back. */
const IDLE_TEARDOWN = 90;
/** Build the mesh once the player is this close to any sand, so the pipeline
 *  compile lands well before the first step onto the beach. */
const APPROACH_RANGE = 26;

/** What a walker needs to leave prints. Structural so remote avatars, the kite
 *  runners and the local player can all be described without a shared base. */
export type SandPrintSink = {
  /**
   * Record one footfall. `dirX`/`dirZ` are the travel direction (need not be
   * normalized); `side` is 0 for the left foot, 1 for the right; `strength`
   * scales how hard the foot landed (a sprint digs deeper than a stroll).
   */
  stamp(
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    side: number,
    strength: number
  ): void;
  /** False while the system is parked — callers can skip their stride math. */
  readonly active: boolean;
};

/**
 * Turns a walk cycle's stride phase into discrete footfalls.
 *
 * Same half-cycle boundaries the footstep foley uses (playerFoleyAudio), so a
 * print lands on the frame its sound plays. Shared by every walker: the local
 * player, the kite runners and remote players each keep one of these.
 */
export class FootfallTracker {
  #last = 0;
  #ready = false;
  #foot = 0;

  /** Footfalls crossed since the previous call (0..2). Ungrounded re-primes. */
  advance(phase: number, grounded = true): number {
    if (!grounded || !Number.isFinite(phase)) {
      this.#ready = false;
      return 0;
    }
    if (!this.#ready) {
      this.#ready = true;
      this.#last = phase;
      return 0;
    }
    const previous = this.#last;
    this.#last = phase;
    const delta = phase - previous;
    // Stride phase only ever advances. A teleport, an HMR reload or a long
    // stall must not dump a queue of stale footfalls onto the sand at once.
    if (delta <= 0 || delta > TAU * 1.5) return 0;
    const first = Math.floor(previous / Math.PI) + 1;
    const last = Math.floor(phase / Math.PI);
    return Math.min(2, Math.max(0, last - first + 1));
  }

  /** Consume the next foot: 0 = left, 1 = right. */
  nextFoot(): number {
    const foot = this.#foot;
    this.#foot = 1 - this.#foot;
    return foot;
  }
}

/** The one-walker signals the local player path reads off the Player. */
type WalkerLike = {
  mode: string;
  riding?: boolean;
  swimming?: boolean;
  walkGrounded: boolean;
  walkStridePhase: number;
  renderPosition: THREE.Vector3;
  velocity: THREE.Vector3;
};

export class SandPrints implements SandPrintSink {
  #scene: THREE.Scene;
  #map: WorldMap;
  /** Detached pipeline warm, so the first print never compiles on-frame. */
  #warm: ((root: THREE.Object3D) => Promise<void>) | null;

  #mesh: THREE.InstancedMesh | null = null;
  #attr: THREE.InstancedBufferAttribute | null = null;
  #write = 0;
  #count = 0;
  #newest = -Infinity;
  #lastStamp = 0;
  #approachCheck = 0;

  #uTime = uniform(0);
  /** Key-light direction flattened onto the ground, plus its strength. */
  #uLight = uniform(new THREE.Vector2(0.7, 0.7));

  #tracker = new FootfallTracker();
  /** Where the player is this frame — the range gate every stamp passes. */
  #focus = new THREE.Vector3();
  #focusValid = false;
  #time = 0;

  #matrix = new THREE.Matrix4();
  #position = new THREE.Vector3();
  #quaternion = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #up = new THREE.Vector3(0, 1, 0);

  constructor(
    scene: THREE.Scene,
    map: WorldMap,
    warm?: (root: THREE.Object3D) => Promise<void>
  ) {
    this.#scene = scene;
    this.#map = map;
    this.#warm = warm ?? null;
  }

  get active(): boolean {
    return this.#focusValid;
  }

  /** Debug/probe surface: what the pool is doing right now. */
  get debugState() {
    return {
      built: Boolean(this.#mesh),
      live: this.#count,
      drawn: this.#mesh?.count ?? 0,
      visible: this.#mesh?.visible ?? false
    };
  }

  update(dt: number, elapsed: number, player: WalkerLike): void {
    this.#time = elapsed;
    this.#uTime.value = elapsed;
    this.#focus.copy(player.renderPosition);
    this.#focusValid = true;

    // The key light hands over to the moon at night; SUN_DIR is whichever is
    // lighting the beach. Flattened to the ground plane, where a footprint's
    // walls actually catch it.
    const horizontal = Math.hypot(SUN_DIR.x, SUN_DIR.z);
    if (horizontal > 1e-3) {
      // Overhead light gives a print no directional read at all, so the
      // length of the flattened vector doubles as the directional weight.
      const weight = Math.min(1, horizontal * 1.6);
      this.#uLight.value.set(
        (SUN_DIR.x / horizontal) * weight,
        (SUN_DIR.z / horizontal) * weight
      );
    } else {
      this.#uLight.value.set(0, 0);
    }

    const onFoot =
      player.mode === "walk" &&
      !player.riding &&
      !player.swimming &&
      player.walkGrounded;
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    const walking = onFoot && speed > 0.42;

    if (walking) {
      const steps = this.#tracker.advance(player.walkStridePhase, true);
      for (let i = 0; i < steps; i++) {
        // Land the print where the foot is, not where the hips are: half a
        // stance off the walking line and a little ahead of the body.
        const dirX = player.velocity.x / speed;
        const dirZ = player.velocity.z / speed;
        const side = this.#tracker.nextFoot();
        this.stamp(
          player.renderPosition.x + dirX * LEAD,
          player.renderPosition.z + dirZ * LEAD,
          dirX,
          dirZ,
          side,
          0.72 + Math.min(1, (speed - 1.4) / 8) * 0.4
        );
      }
    } else {
      this.#tracker.advance(0, false);
    }

    // Cheap approach probe: build (and warm) the pool a few strides before the
    // player reaches sand, not on the step that needs it.
    if (!this.#mesh) {
      this.#approachCheck -= dt;
      if (this.#approachCheck <= 0) {
        this.#approachCheck = 0.4;
        if (onFoot && this.#nearSand(player.renderPosition)) this.#ensure();
      }
    }

    this.#refresh();
  }

  stamp(
    x: number,
    z: number,
    dirX: number,
    dirZ: number,
    side: number,
    strength: number
  ): void {
    if (!this.#focusValid) return;
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const dx = x - this.#focus.x;
    const dz = z - this.#focus.z;
    if (dx * dx + dz * dz > STAMP_RANGE * STAMP_RANGE) return;
    if (this.#map.surfaceType(x, z) !== SAND) return;

    const length = Math.hypot(dirX, dirZ);
    if (!(length > 1e-4)) return;
    const fx = dirX / length;
    const fz = dirZ / length;
    // Right of travel, Y up: right = forward × up.
    const rx = -fz;
    const rz = fx;
    const offset = side === 0 ? -STANCE : STANCE;
    const px = x + rx * offset;
    const pz = z + rz * offset;
    if (this.#map.surfaceType(px, pz) !== SAND) return;

    const mesh = this.#ensure();
    const attr = this.#attr!;
    const y = this.#map.groundTop(px, pz);
    // Down in the swash the next wave takes the print; up on the dry beach the
    // wind has to do it, which takes a lot longer.
    const wet = y < WET_HEIGHT;
    const life = wet ? WET_LIFE : DRY_LIFE;

    const i = this.#write;
    this.#write = (this.#write + 1) % MAX_PRINTS;
    this.#count = Math.max(this.#count, Math.min(MAX_PRINTS, i + 1));
    mesh.count = this.#count;
    mesh.visible = true;

    // The quad lies in the XZ plane: local +X is the toe direction, local -Z
    // (which the plane's +v maps to) is the walker's right.
    const yaw = Math.atan2(-fz, fx);
    this.#quaternion.setFromAxisAngle(this.#up, yaw);
    this.#matrix.compose(
      this.#position.set(px, y + LIFT, pz),
      this.#quaternion,
      this.#scale.set(PRINT_LENGTH, 1, PRINT_WIDTH)
    );
    mesh.setMatrixAt(i, this.#matrix);

    const clamped = Math.min(1.25, Math.max(0.2, strength)) * (wet ? 0.82 : 1);
    attr.setXYZW(i, this.#time, life, clamped, yaw);
    mesh.instanceMatrix.needsUpdate = true;
    attr.needsUpdate = true;

    this.#newest = this.#time;
    this.#lastStamp = this.#time;
  }

  dispose(): void {
    const mesh = this.#mesh;
    if (!mesh) return;
    mesh.removeFromParent();
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.#mesh = null;
    this.#attr = null;
    this.#write = 0;
    this.#count = 0;
    this.#newest = -Infinity;
  }

  /** Per-frame pool bookkeeping: stop drawing what has finished fading. */
  #refresh(): void {
    const mesh = this.#mesh;
    if (!mesh) return;
    if (this.#count > 0 && this.#time - this.#newest > DRY_LIFE) {
      // Everything in the pool has faded to a no-op multiply. Retire the draw
      // rather than blending a screenful of 1.0s.
      this.#count = 0;
      this.#write = 0;
      mesh.count = 0;
    }
    if (mesh.count === 0) {
      mesh.visible = false;
      if (this.#time - this.#lastStamp > IDLE_TEARDOWN) this.dispose();
    }
  }

  /** True when sand is within a few strides — including under the player. */
  #nearSand(at: THREE.Vector3): boolean {
    const r = APPROACH_RANGE;
    return (
      this.#map.surfaceType(at.x, at.z) === SAND ||
      this.#map.surfaceType(at.x + r, at.z) === SAND ||
      this.#map.surfaceType(at.x - r, at.z) === SAND ||
      this.#map.surfaceType(at.x, at.z + r) === SAND ||
      this.#map.surfaceType(at.x, at.z - r) === SAND
    );
  }

  #ensure(): THREE.InstancedMesh {
    if (this.#mesh) return this.#mesh;
    // Start the idle clock at the build, not at zero: the approach probe builds
    // the pool BEFORE the first footfall, and an idle age measured from 0 would
    // tear it straight back down and rebuild it on the next probe, forever.
    this.#lastStamp = this.#time;

    // Flat in XZ so a single Y rotation orients the print — no reflected basis.
    const geometry = new THREE.PlaneGeometry(1, 1);
    geometry.rotateX(-Math.PI / 2);

    const attr = new THREE.InstancedBufferAttribute(
      new Float32Array(MAX_PRINTS * 4),
      4
    );
    attr.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX_PRINTS; i++) attr.setXYZW(i, -9999, 1, 0, 0);
    this.#attr = attr;

    const material = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.FrontSide
    });
    // dst × src: the fragment is a shading multiplier, the sand under it is the
    // colour. Alpha is left exactly as the terrain wrote it.
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.DstColorFactor;
    material.blendDst = THREE.ZeroFactor;
    material.blendSrcAlpha = THREE.ZeroFactor;
    material.blendDstAlpha = THREE.OneFactor;
    // A reversed depth buffer flips the sign: ground decals need POSITIVE
    // offsets here, negative ones bury them.
    material.polygonOffset = true;
    material.polygonOffsetFactor = 2;
    material.polygonOffsetUnits = 2;
    // Fog would drag the multiplier toward the fog COLOUR, tinting the sand.
    // Distance is handled below by fading the multiplier toward 1 instead.
    material.fog = false;
    material.toneMapped = false;

    const print = instancedBufferAttribute(attr) as unknown as N;
    const spawn = print.x as N;
    const life = print.y as N;
    const strength = print.z as N;
    const yaw = print.w as N;

    const age = clamp(this.#uTime.sub(spawn).div(life), 0, 1) as N;
    // Wind fills a print in from the edges: hold most of the depth, then go.
    const fade = age.oneMinus().pow(1.3).mul(strength) as N;
    const distanceFade = smoothstep(
      FADE_FAR,
      FADE_NEAR,
      (positionWorld as N).distance(cameraPosition)
    ) as N;
    const weight = fade.mul(distanceFade) as N;

    // Local print space: p.x runs heel→toe, p.y runs left→right.
    const p = (uv() as N).mul(2).sub(1);
    const grain = mx_noise_float(
      vec3(p.x.mul(5.4), p.y.mul(7.8), spawn.mul(11.0)) as N
    ).mul(0.5).add(0.5) as N;
    // Two overlapping ellipses — forefoot and heel — pinched at the arch.
    const ball = vec2(p.x.sub(0.32).div(0.58), p.y.div(0.92)).length() as N;
    const heel = vec2(p.x.add(0.60).div(0.38), p.y.div(0.66)).length() as N;
    const sole = min(ball, heel).mul(grain.mul(0.1).add(0.95)) as N;
    const pit = smoothstep(1.0, 0.66, sole) as N;
    // The sand the foot pushed out, standing proud just outside the sole.
    const rim = smoothstep(0.94, 1.14, sole).mul(smoothstep(1.6, 1.2, sole)) as N;

    // The key light, rotated out of world space into this print's frame. Done
    // once per vertex: four evaluations per print instead of one per fragment.
    const c = cos(yaw) as N;
    const s = sin(yaw) as N;
    const light = this.#uLight as N;
    const lightLocal = vertexStage(
      vec2(
        light.x.mul(c).sub(light.y.mul(s)),
        light.x.mul(s).negate().sub(light.y.mul(c))
      )
    ) as N;

    // Which way this fragment's wall faces, corrected for the quad's aspect so
    // the narrow axis is not flattened. >0 = on the light's side of the print.
    const gradient = vec2(p.x, p.y.mul(PRINT_LENGTH / PRINT_WIDTH))
      .normalize() as N;
    const facing = gradient.dot(lightLocal) as N;

    // Inside the hollow the near wall (facing the light) turns its face away
    // and goes dark; the far wall keeps some light. Outside, the displaced lip
    // does the opposite and catches it.
    const shade = pit
      .mul(PRINT_DEPTH)
      .mul(facing.saturate().mul(0.5).add(0.5))
      .mul(grain.mul(0.25).add(0.85)) as N;
    const lift = rim.mul(PRINT_RIM).mul(facing.mul(0.5).add(0.5)) as N;
    const factor = float(1).sub(shade).add(lift) as N;

    material.colorNode = vec3(mix(float(1), factor, weight)) as N;

    const mesh = new THREE.InstancedMesh(geometry, material, MAX_PRINTS);
    mesh.name = "sand_prints";
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    // The pool only ever holds prints within STAMP_RANGE of the player, so a
    // per-frame bounds recompute would cost more than the draw it saves.
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    this.#scene.add(mesh);
    this.#mesh = mesh;

    // Compile detached — on a THROWAWAY PROXY, never the live pool. The warm
    // helper removes its root from the scene for the length of the compile and
    // then restores the visibility that root had on the way out; handing it the
    // pool would blank every print stamped during the compile and leave the
    // mesh hidden afterwards. A one-instance proxy shares this geometry and
    // material, so it warms exactly the pipeline the pool needs.
    if (this.#warm) {
      const proxy = new THREE.InstancedMesh(geometry, material, 1);
      proxy.name = "sand_prints_warm";
      proxy.frustumCulled = false;
      proxy.setMatrixAt(0, this.#matrix.compose(
        this.#position.set(0, 0, 0),
        this.#quaternion.identity(),
        this.#scale.set(PRINT_LENGTH, 1, PRINT_WIDTH)
      ));
      // Failure is not fatal — the worst case is one small pipeline built on
      // the frame of the first step.
      void this.#warm(proxy)
        .catch(() => {})
        .then(() => {
          proxy.removeFromParent();
          proxy.dispose();
        });
    }
    return mesh;
  }
}
