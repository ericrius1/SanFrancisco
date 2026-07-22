// Materialize core (docs/VOID_STREAM_REWRITE.md §A; M18 particle-scan rewrite).
//
// One module-level MaterializeField owns the shared reveal state:
//
// - The SCAN FRONT (frontCenter/frontRadius/frontBand): an expanding
//   world-space circle centred on the player's arrival point. During the void
//   scan it is the terrain-scan particle wave's radius (the particle field
//   reads these same uniforms); fabric is fully hidden (frontGate) while it
//   runs, so no fabric material needs a front term of its own.
// - WORLD REVEAL (worldReveal): the global dawn ramp. 0 = void (terrain, water
//   and every amount-driven consumer render nothing), eased to 1 by the ring
//   coordinator during the morph that follows the scan. Once 1, everything is
//   byte-identical to the normal world.
// - The BIRTH REGISTRY: per-residency birth timestamps driving plain ~1 s
//   dark→lit fades for streamed-in fabric (applyBirthFade / batch texels) and
//   the matching base-anchored rise for city buildings.
//
// The old cyan holo language (contour grid, scanline, edge glow, dissolve
// tint) is GONE — the void look is pure black + the GPU terrain-scan point
// cloud, and fabric appears via plain dark→lit birth fades after the dawn.
//
// TSL discipline (repo gotchas):
// - NO If()/branches — WGSL emits a node only in the first branch it appears
//   in and other arms then read zeros; everything here is mix/step/clamp math.
// - smoothstep edges are always ascending.
// - The revealed path (amount == 1) must stay a few ALU: plain multiplies that
//   collapse to the original graph.
import * as THREE from "three/webgpu";
import {
  drawIndex,
  float,
  floor,
  hash,
  instanceIndex,
  int,
  ivec2,
  materialColor,
  materialEmissive,
  materialOpacity,
  min,
  positionWorld,
  smoothstep,
  step,
  textureLoad,
  textureSize,
  uniform,
  vec3,
  Fn
} from "three/tsl";

// TSL composed node types are unwieldy; the repo-wide alias (see
// terrainClipmap.ts / sky.ts) keeps graphs readable while public runtime
// surfaces stay typed.
type N = any;

/** Seconds for a per-residency birth ramp (markBorn → fully shaded). */
export const MATERIALIZE_BIRTH_SECONDS = 1.0;

/** Building silhouettes rise for most of the shared one-second birth window;
 *  a short deterministic per-building delay keeps a tile from moving as one
 *  rigid slab while still guaranteeing every roof is settled at t=1 s. */
export const MATERIALIZE_BUILDING_GROW_SECONDS = 0.84;
export const MATERIALIZE_BUILDING_STAGGER_SECONDS =
  MATERIALIZE_BIRTH_SECONDS - MATERIALIZE_BUILDING_GROW_SECONDS;

/** Front radius that means "the whole world is revealed". */
export const MATERIALIZE_REVEALED_RADIUS = 1e9;

/** Default scan-wave band width in metres (the wave's soft leading edge). */
export const MATERIALIZE_DEFAULT_BAND = 48;

/** Band scaled to the front radius so a collapsed front has no wide soft
 *  edge — shared by every setFront caller (the ring coordinator drives its
 *  per-frame sweeps through the same helper). */
const BAND_MIN = 1;
const BAND_RADIUS_SCALE = 0.35;
export const bandForRadius = (radius: number): number =>
  Math.min(MATERIALIZE_DEFAULT_BAND, Math.max(BAND_MIN, radius * BAND_RADIUS_SCALE));

/**
 * Shared front state + birth registry. A single instance lives at module
 * scope (`materializeField`); the uniforms it owns are referenced by every
 * materialize-aware material, so one write updates all of them.
 */
export class MaterializeField {
  /** World XZ of the scan front's centre. */
  readonly frontCenter = uniform(new THREE.Vector2(0, 0));
  /** Current front radius in metres. Starts fully revealed. */
  readonly frontRadius = uniform(MATERIALIZE_REVEALED_RADIUS);
  /** Width of the wave's soft leading edge, metres. */
  readonly frontBand = uniform(MATERIALIZE_DEFAULT_BAND);
  /** Global dawn ramp: 0 = void black, 1 = normal world. The ring coordinator
   *  eases this during the post-scan morph; every amount-driven consumer
   *  (terrain, water, traffic lights, CPU light ramps) rides
   *  it, so the whole world dawns on one uniform. */
  readonly worldReveal = uniform(1);
  /** Field-local clock (seconds). Drives birth ramps; advanced by update(). */
  readonly worldTime = uniform(0);

  #births = new Map<string, ReturnType<typeof uniform>>();
  #sweepTarget: number | null = null;
  #sweepSpeed = 450;

  /**
   * Shared birth-timestamp uniform for a chunk/site/tile residency key.
   * Unborn keys hold +1e9 (birth ramp evaluates to 0 → invisible);
   * `markBorn` stamps the current field time to start the ~1 s ramp.
   */
  birthOf(key: string): ReturnType<typeof uniform> {
    let u = this.#births.get(key);
    if (!u) {
      u = uniform(1e9);
      this.#births.set(key, u);
    }
    return u;
  }

  /** Stamp `key`'s birth at the current field time (idempotent re-stamp). */
  markBorn(key: string): void {
    this.birthOf(key).value = this.worldTime.value as number;
  }

  /** Drop a birth uniform when its residency unloads (next load re-births). */
  forgetBirth(key: string): void {
    this.#births.delete(key);
  }

  /** DEBUG/probe: how many birth registrations are live (streaming-grace QA). */
  get birthCount(): number {
    return this.#births.size;
  }

  /** DEBUG/probe: live birth keys (probes diff these across a teleport). */
  birthKeys(): string[] {
    return [...this.#births.keys()];
  }

  /** Place the front explicitly; cancels any running sweep. Omitting `band`
   *  derives it from the radius (see bandForRadius). */
  setFront(x: number, z: number, radius: number, band?: number): void {
    (this.frontCenter.value as THREE.Vector2).set(x, z);
    this.frontRadius.value = Math.max(0, radius);
    this.frontBand.value = Math.max(1, band ?? bandForRadius(radius));
    this.#sweepTarget = null;
  }

  /** Animate the front radius toward `toRadius` at `speed` m/s (update() drives it). */
  sweep(toRadius: number, speed = 450): void {
    this.#sweepTarget = Math.max(0, toRadius);
    this.#sweepSpeed = Math.max(1, Math.abs(speed));
  }

  /** Full void: collapse the front to zero radius at (x,z) AND zero the dawn
   *  ramp — the world renders nothing until the scan + morph replay. */
  holo(x?: number, z?: number): void {
    const c = this.frontCenter.value as THREE.Vector2;
    this.setFront(x ?? c.x, z ?? c.y, 0);
    this.worldReveal.value = 0;
  }

  /** Everything revealed (normal world) — the boot default and the settled
   *  sentinel. Parks the radius so every amount collapses to 1. */
  reveal(): void {
    this.#sweepTarget = null;
    this.frontRadius.value = MATERIALIZE_REVEALED_RADIUS;
    this.worldReveal.value = 1;
  }

  /** True while a sweep is still expanding/contracting the front. */
  get sweeping(): boolean {
    return this.#sweepTarget !== null;
  }

  /**
   * CPU twin of `materializeAmount` (no birth): 0 = void, 1 = fully revealed
   * at (x, z). Used by CPU-driven consumers (Bay Lights / Golden Gate light
   * ramps) that scale an existing intensity uniform instead of adding shader
   * work. Collapses to 1 once `reveal()` parks the radius at the sentinel.
   */
  amountAt(x: number, z: number): number {
    const reveal = this.worldReveal.value as number;
    if (reveal <= 0) return 0;
    const c = this.frontCenter.value as THREE.Vector2;
    const dx = x - c.x;
    const dz = z - c.y;
    const band = Math.max(1, this.frontBand.value as number);
    const t = ((this.frontRadius.value as number) - Math.hypot(dx, dz)) / band;
    return Math.min(reveal, t <= 0 ? 0 : t >= 1 ? 1 : t);
  }

  /** Advance the field clock and any active sweep. Call once per frame. */
  update(dt: number): void {
    const clamped = Math.min(Math.max(dt, 0), 0.1);
    this.worldTime.value = (this.worldTime.value as number) + clamped;
    if (this.#sweepTarget === null) return;
    const current = this.frontRadius.value as number;
    const delta = this.#sweepTarget - current;
    const stepM = this.#sweepSpeed * clamped;
    if (Math.abs(delta) <= stepM) {
      this.frontRadius.value = this.#sweepTarget;
      this.#sweepTarget = null;
    } else {
      this.frontRadius.value = current + Math.sign(delta) * stepM;
    }
  }
}

/** The one shared field. All materialize-aware materials read these uniforms. */
export const materializeField = new MaterializeField();

/**
 * 0..1 materialize amount at a world position: 1 = fully shaded, 0 = void.
 * min(front sweep, global dawn ramp, optional per-key birth ramp) — content
 * born after the front passed is governed by its birth ramp alone, and
 * NOTHING renders while the dawn ramp is 0 regardless of the front.
 */
export function materializeAmount(opts: { worldPos?: N; birth?: N } = {}): N {
  const f = materializeField;
  const wp = (opts.worldPos ?? positionWorld) as N;
  const dist = wp.xz.sub(f.frontCenter as N).length();
  const frontAmt = (f.frontRadius as N).sub(dist).div(f.frontBand as N).saturate();
  const amt = min(frontAmt, (f.worldReveal as N).saturate());
  if (!opts.birth) return amt;
  const birthAmt = (f.worldTime as N)
    .sub(opts.birth)
    .div(MATERIALIZE_BIRTH_SECONDS)
    .saturate();
  return min(amt, birthAmt);
}

/**
 * Base-anchored building growth amount for the vertex stage. `birth` is the
 * same timestamp already used by the streamed-fabric shading fade, so this
 * adds no CPU animation state. `staggerKey` is stable per building (usually
 * `_bid`); hashing it produces a 0…160 ms delay and the smooth ramp reaches
 * exactly one by the end of the existing one-second birth window.
 */
export function buildingGrowAmount(birth: N, staggerKey: N): N {
  const delay = hash((staggerKey as N).add(0.731))
    .mul(MATERIALIZE_BUILDING_STAGGER_SECONDS);
  const t = (materializeField.worldTime as N)
    .sub(birth)
    .sub(delay)
    .div(MATERIALIZE_BUILDING_GROW_SECONDS)
    .saturate();
  const eased = t.mul(t).mul(float(3).sub(t.mul(2)));
  // Keep a tiny non-zero height so collapsed walls never feed degenerate
  // triangles/normals into a driver while still reading as ground-flat.
  return eased.max(0.001);
}

export type ApplyMaterializeOptions = {
  /** World position node (defaults to positionWorld). */
  worldPos?: N;
  /** Optional per-residency birth uniform from `materializeField.birthOf`
   *  (or any 0-arg node holding a birth timestamp, e.g. a batch texel). */
  birth?: N;
  /**
   * Screen-door dissolve on opacity while amount is low (default true).
   * Always-resident opaque surfaces pass false: they stay opaque and only
   * fade their shading.
   */
  dissolve?: boolean;
  /**
   * Extra 0..1 amount MIN'd into the materialize amount — used by systems that
   * already own a crossfade (citygen shell fade texel / fade-clone opacity) so
   * their existing fade drives the same plain ramp.
   */
  extraAmount?: N;
};

/**
 * Wrap a node material's colorNode/emissiveNode/opacityNode with the plain
 * materialize fade:
 *   amount < 1 → shading scaled toward black (+ optionally a stable
 *                screen-door dissolve keyed off a world-position hash);
 *   amount = 1 → the original graph result via plain multiplies (a few ALU,
 *                no texture taps on the added path).
 * Must be called before the material's first compile so the (single) pipeline
 * variant exists from construction — no swap-at-reveal-time compiles.
 */
export function applyMaterialize(
  material: THREE.MeshStandardNodeMaterial | (THREE.Material & { colorNode?: unknown }),
  opts: ApplyMaterializeOptions = {}
): void {
  const mat = material as N;
  const wp = (opts.worldPos ?? positionWorld) as N;
  let amountExpr = materializeAmount({ worldPos: wp, birth: opts.birth });
  if (opts.extraAmount) amountExpr = min(amountExpr, (opts.extraAmount as N).saturate());
  const amount = amountExpr.toVar();
  // Shading fade rides the upper two thirds of the ramp; the dissolve stipple
  // (when enabled) owns the lower third, so geometry is fully present before
  // it finishes brightening.
  const reveal = smoothstep(0.3, 1.0, amount);

  const origColor = (mat.colorNode ?? materialColor) as N;
  mat.colorNode = origColor.mul(reveal);
  // materialEmissive is only valid on materials that HAVE an emissive colour;
  // unlit/basic node materials (some authored-region GLB materials) fall back
  // to zero so the wrap never references a missing material property.
  const origEmissive = (mat.emissiveNode ??
    (mat.emissive && mat.emissive.isColor ? materialEmissive : null)) as N | null;
  if (origEmissive) mat.emissiveNode = origEmissive.mul(reveal);

  if (opts.dissolve === false) return;
  {
    // Stable screen-door: hash of the quantized WORLD position — the pattern
    // is glued to geometry, never re-rolled per frame. Content pops in over
    // the first third of the ramp, finest cells first.
    const cell = floor(wp.mul(9)) as N;
    const h = hash(cell.dot(vec3(1, 57, 113)));
    const keep = step(h, amount.mul(3).saturate().mul(1.0001));
    const origOpacity = (mat.opacityNode ?? materialOpacity) as N;
    // Explicit opacityNode is mandatory even for plain materials in bundles —
    // the NodeMaterialObserver footgun (citygen/render.ts fadeCloneOf).
    mat.opacityNode = origOpacity.mul(keep);
    if (!mat.transparent && !mat.alphaTestNode && !(mat.alphaTest > 0)) {
      mat.alphaTestNode = float(0.5);
    }
  }
}

/**
 * Plain dark→lit birth ramp for OPAQUE world fabric: identical to
 * `applyMaterialize` but NEVER touches opacity/alphaTest — amount 0 scales the
 * shading to black, amount 1 is the exact original graph via plain multiplies.
 * A discard-capable shader would disable early-Z for the whole city forever,
 * so streamed opaque fabric always goes through this. Must run before the
 * material's first compile (creation/clone time) so the single pipeline
 * variant is what gets warmed.
 */
export function applyBirthFade(
  material: THREE.MeshStandardNodeMaterial | (THREE.Material & { colorNode?: unknown }),
  opts: Omit<ApplyMaterializeOptions, "dissolve"> = {}
): void {
  applyMaterialize(material, { ...opts, dissolve: false });
}

/**
 * Per-instance birth timestamp node for a THREE.BatchedMesh: the batch's
 * indirect texture maps draw/instance id → the live instance row (mirrors
 * three's own Batch node and facade.ts configureFacadeBatchMaterial), and that
 * row indexes `birthTex` — a 1-row float DataTexture the streamer writes ONCE
 * per instance add (no per-frame CPU writes; the shader ramps from
 * worldTime − birth). Two exact texel fetches; acceptable per the moduleLayer
 * precedent, noted in the M5 audit.
 */
export function batchBirthNode(batchMesh: THREE.BatchedMesh, birthTex: THREE.DataTexture): N {
  const indirect = (batchMesh as unknown as { _indirectTexture: THREE.Texture })
    ._indirectTexture as N;
  const texLoad = textureLoad as unknown as (t: N, coord?: N) => N;
  const texSize = textureSize as unknown as (t: N, level: N) => N;
  const row = (Fn((_: N[], builder: N) => {
    const batchingId: N = builder.getDrawIndex() === null ? instanceIndex : drawIndex;
    const size: N = int(texSize(texLoad(indirect), int(0)).x);
    const x: N = int(batchingId).mod(size);
    const y: N = int(batchingId).div(size);
    return int(texLoad(indirect, ivec2(x, y)).x);
  }) as N)();
  return texLoad(birthTex as N, ivec2(row, int(0))).r;
}

/** Convenience: wire the plain birth fade onto a batch material with a
 *  per-instance birth texture (see `batchBirthNode`). Call AFTER the material's
 *  base node graph is assigned and BEFORE its warm/compile. */
export function configureBatchBirthFade(
  material: THREE.MeshStandardNodeMaterial,
  batchMesh: THREE.BatchedMesh,
  birthTex: THREE.DataTexture,
  birthNode?: N
): void {
  applyBirthFade(material, { birth: birthNode ?? batchBirthNode(batchMesh, birthTex) });
}
