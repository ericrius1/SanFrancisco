import * as THREE from "three/webgpu";
import { attribute, float, normalLocal, positionLocal, sin, time, uniform, uv } from "three/tsl";

/**
 * ───────────────────────────────────────────────────────────────────────────
 * Cloth-vs-spar collision (shared by every shader-displaced cloth)
 * ───────────────────────────────────────────────────────────────────────────
 * None of the game's "cloth" is a physics sim — it's all GPU vertex
 * displacement (see flowingClothMaterial / boat sailMaterial). That means a fluttering
 * panel has no idea a mast, stay or flagpole is in its way and happily pokes
 * through it. Rather than bolt on a Verlet solver (per-frame CPU solve + vertex
 * upload = the exact perf cost we want to avoid), we push penetrating vertices
 * back out in the SAME vertex shader, right after the ripple displacement.
 *
 * Each obstacle is a CAPSULE (segment a→b + radius) — a pole, spar or stay. For
 * every vertex we find the closest point on the segment and, if the vertex is
 * inside `radius + skin`, slide it radially out to that surface. The maths is
 * fully branchless (a `max(0, …)` gates the push) so it never trips the
 * If()+noise pixel-corruption hazard, and it's a handful of ops on already
 * low-seg cloth — cost is shader noise, geometry stays static & GPU-resident.
 *
 * Capsules are supplied in the cloth mesh's OWN local space (the frame its
 * positions live in). For a rig whose spars sit in a shared parent, transform
 * them once with {@link capsulesToLocal} and hand the result to `set()`.
 */

/** Max obstacles a single cloth panel can be told about. Unused slots are free. */
export const MAX_CLOTH_CAPSULES = 4;
/** Default clearance added on top of the capsule radius so cloth hugs, not z-fights. */
const DEFAULT_SKIN = 0.03;

/** A pole/spar/stay as a fat line segment, in some reference frame. */
export type Capsule = { a: THREE.Vector3; b: THREE.Vector3; radius: number; skin?: number };

type CapsuleSlot = {
  a: ReturnType<typeof uniform>;
  b: ReturnType<typeof uniform>;
  rs: ReturnType<typeof uniform>; // (radius, skin) — radius 0 ⇒ slot disabled
};

/** A live, updatable set of capsule uniforms bound into a cloth material. */
export type ClothColliders = {
  readonly slots: CapsuleSlot[];
  /** Replace the active capsules (coords in the cloth mesh's LOCAL space). */
  set(capsules: Capsule[]): void;
};

/** Allocate a collider set (uniforms) to hand to a cloth material and later fill. */
export function clothColliders(max = MAX_CLOTH_CAPSULES): ClothColliders {
  const slots: CapsuleSlot[] = [];
  for (let i = 0; i < max; i++) {
    slots.push({
      a: uniform(new THREE.Vector3()),
      b: uniform(new THREE.Vector3()),
      rs: uniform(new THREE.Vector2(0, 0))
    });
  }
  return {
    slots,
    set(caps) {
      for (let i = 0; i < slots.length; i++) {
        const c = caps[i];
        if (c) {
          (slots[i].a.value as THREE.Vector3).copy(c.a);
          (slots[i].b.value as THREE.Vector3).copy(c.b);
          (slots[i].rs.value as THREE.Vector2).set(c.radius, c.skin ?? DEFAULT_SKIN);
        } else {
          (slots[i].rs.value as THREE.Vector2).set(0, 0); // disable
        }
      }
    }
  };
}

const _m = new THREE.Matrix4();
/**
 * Re-express capsules given in `ref`'s local space into `mesh`'s local space
 * (the frame its shader positions live in). Assumes ~uniform scale — radius is
 * carried through unchanged. Call after the transforms you care about are set;
 * for a static rig, once at build time. Both objects must share an ancestor.
 */
export function capsulesToLocal(mesh: THREE.Object3D, ref: THREE.Object3D, caps: Capsule[]): Capsule[] {
  mesh.updateWorldMatrix(true, false);
  ref.updateWorldMatrix(true, false);
  _m.copy(mesh.matrixWorld).invert().multiply(ref.matrixWorld); // ref-local → mesh-local
  return caps.map((c) => ({
    a: c.a.clone().applyMatrix4(_m),
    b: c.b.clone().applyMatrix4(_m),
    radius: c.radius,
    skin: c.skin
  }));
}

/**
 * TSL: push a local-space position out of every active capsule. Branchless —
 * a vertex outside all capsules is returned untouched. Sequential per capsule,
 * which is fine for the few well-separated spars a panel ever sees.
 *
 * `escape` is the cloth's displacement axis (local, e.g. +x for a sail, +z for a
 * flag). It seeds the push direction so a vertex sitting ON or very near the
 * capsule axis — where the radial `p − closest` collapses to ~0 and has no
 * well-defined outward direction — is shoved out the same (leeward) side the
 * cloth already bellies toward, instead of not moving at all. Off-axis vertices
 * keep their natural radial push; the bias fades out by the capsule surface.
 */
export function pushOutOfColliders(
  pos: unknown,
  colliders: ClothColliders,
  escape?: unknown,
  iterations = 1
): unknown {
  let out = pos as any;
  for (let pass = 0; pass < Math.max(1, iterations); pass++) {
    for (const s of colliders.slots) {
      const a = s.a as any;
      const b = s.b as any;
      const r = (s.rs as any).x;
      const skin = (s.rs as any).y;
      const ba = b.sub(a);
      const pa = out.sub(a);
      // closest point on the segment (t clamped to the endpoints)
      const t = pa.dot(ba).div(ba.dot(ba).max(1e-5)).clamp(0, 1);
      const closest = a.add(ba.mul(t));
      const radial = out.sub(closest);
      const dist = radial.length();
      // Direction to exit along. Near the axis (dist < r) lean on the escape axis
      // so we always have a stable, leeward-biased normal; farther out, pure radial.
      let dir = radial;
      if (escape) dir = radial.add((escape as any).mul(r.sub(dist).max(0)));
      // Safe normalization: disabled slots carry a zero-radius capsule at the
      // origin, so a vertex at that exact point must remain a no-op rather than
      // producing NaNs that poison the whole cloth primitive.
      dir = dir.div(dir.length().max(1e-5));
      const pen = r.add(skin).sub(dist).max(0); // 0 when outside ⇒ no-op
      out = out.add(dir.mul(pen));
    }
  }
  return out;
}

/** Runtime motion fed to a wearable cloth surface. Values are deliberately
 * dimensionless so the same material controller can drive a robe, cape,
 * banner, or sail without tying it to one character rig. */
export type FlowingClothMotion = {
  /** 0 at rest, 1 at the authored full locomotion ripple. */
  motion: number;
  /** Signed turn impulse in roughly -1..1. */
  turn: number;
  /** Ambient breeze strength in roughly 0..1. */
  breeze?: number;
};

export type FlowingClothMaterial = {
  material: THREE.MeshStandardNodeMaterial;
  colliders: ClothColliders;
  setMotion(state: FlowingClothMotion): void;
};

/**
 * Low-cost collision-aware cloth for animated garments and other moving
 * surfaces. Geometry stays static and GPU-resident; only four capsule uniforms
 * and three scalar motion uniforms can change each frame. The pinned edge is
 * UV.y=0 and the free edge is UV.y=1, so authored surfaces control exactly
 * where motion is allowed without a CPU vertex solve or per-frame upload.
 *
 * Collision uses the same capsule contract as sails and flags. A costume can
 * update those capsules from its moving skeleton while a sail can bind them to
 * a mast and boom—the shader path is identical.
 */
export function flowingClothMaterial(opts: {
  color?: number;
  /** Optional authored weave/palette map; useful for costumes and sails. */
  map?: THREE.Texture;
  roughness?: number;
  metalness?: number;
  side?: THREE.Side;
  vertexColors?: boolean;
  amplitude?: number;
  speed?: number;
  phase?: number;
  /** 0 disables capsules for unconstrained sleeves/panels; garment envelopes
   * normally use three passes so overlapping body capsules converge. */
  collisionIterations?: number;
  colliders?: ClothColliders;
} = {}): FlowingClothMaterial {
  const colliders = opts.colliders ?? clothColliders();
  const motion = uniform(0);
  const turn = uniform(0);
  const breeze = uniform(0.22);
  const amplitude = opts.amplitude ?? 0.055;
  const speed = opts.speed ?? 2.35;
  const phase = float(opts.phase ?? 0);
  const collisionIterations = Math.max(0, Math.floor(opts.collisionIterations ?? 3));
  const vertexColors = opts.vertexColors ?? false;
  const mat = new THREE.MeshStandardNodeMaterial({
    color: opts.color ?? 0xffffff,
    map: opts.map,
    side: opts.side ?? THREE.DoubleSide,
    roughness: opts.roughness ?? 0.88,
    metalness: opts.metalness ?? 0
  });
  // Node materials do not consistently honor the legacy `vertexColors` flag
  // once a custom position node is installed. Bind the geometry attribute as
  // the color node explicitly so authored garment palettes survive WebGPU.
  if (vertexColors) mat.colorNode = attribute("color", "vec3");

  const u = uv().x;
  const loose = uv().y.clamp(0, 1).pow(1.45);
  const ambient = sin(u.mul(Math.PI * 4).sub(time.mul(speed)).add(phase))
    .mul(0.72)
    // Integer 2π harmonics keep u=0 and u=1 identical on closed garments.
    .add(sin(u.mul(Math.PI * 8).add(time.mul(speed * 0.63)).add(phase.mul(1.7))).mul(0.28))
    .mul(breeze)
    .mul(amplitude * 0.5);
  const locomotion = sin(u.mul(Math.PI * 6).sub(time.mul(speed * 2.15)).add(phase.mul(0.6)))
    .mul(motion)
    .mul(amplitude);
  const turning = sin(u.mul(Math.PI * 2).add(phase))
    .mul(turn)
    .mul(amplitude * 0.72);
  const displacement = ambient.add(locomotion).add(turning).mul(loose);
  let pos: unknown = positionLocal.add(normalLocal.mul(displacement));
  // Garments wrap overlapping torso/limb envelopes. Three cheap projection
  // passes converge those coupled constraints; unconstrained sleeves opt out,
  // while the boat's sail keeps its own one-pass mast path.
  if (collisionIterations > 0) {
    pos = pushOutOfColliders(pos, colliders, normalLocal, collisionIterations);
  }
  mat.positionNode = pos as never;

  return {
    material: mat,
    colliders,
    setMotion(next) {
      motion.value = THREE.MathUtils.clamp(next.motion, 0, 1);
      turn.value = THREE.MathUtils.clamp(next.turn, -1, 1);
      breeze.value = THREE.MathUtils.clamp(next.breeze ?? 0.22, 0, 1);
    }
  };
}
