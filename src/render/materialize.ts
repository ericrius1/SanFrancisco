// Materialize core (docs/VOID_STREAM_REWRITE.md §A, milestone M1).
//
// One module-level MaterializeField owns the shared "reveal front" uniforms:
// an expanding world-space circle centred on the player's arrival point.
// Content strictly inside the front renders with its normal shading; content
// outside renders as a cyan-teal "holo" contour hologram; content crossing the
// band plays a short dissolve. Every consumer material builds its TSL graph
// against the SAME uniform node objects, so a single CPU-side write (setFront /
// sweep / update) retints or moves the front across the entire world without
// touching any material.
//
// TSL discipline (repo gotchas):
// - NO If()/branches — WGSL emits a node only in the first branch it appears
//   in and other arms then read zeros; everything here is mix/step/clamp math.
// - smoothstep edges are always ascending.
// - The revealed path (amount == 1) must stay a few ALU: the holo look is pure
//   arithmetic (no texture taps), collapsed by plain mixes.
import * as THREE from "three/webgpu";
import {
  abs,
  drawIndex,
  float,
  floor,
  fract,
  fwidth,
  hash,
  instanceIndex,
  int,
  ivec2,
  materialColor,
  materialEmissive,
  materialOpacity,
  min,
  mix,
  positionWorld,
  smoothstep,
  step,
  textureLoad,
  textureSize,
  uniform,
  vec3,
  Fn
} from "three/tsl";
import { LIGHT_SCALE } from "../config";

// TSL composed node types are unwieldy; the repo-wide alias (see
// terrainClipmap.ts / sky.ts) keeps graphs readable while public runtime
// surfaces stay typed.
type N = any;

/** Seconds for a per-residency birth ramp (markBorn → fully shaded). */
export const MATERIALIZE_BIRTH_SECONDS = 1.0;

/** Front radius that means "the whole world is revealed" (holo fully off). */
export const MATERIALIZE_REVEALED_RADIUS = 1e9;

/** Default dissolve band width in metres (holo → shaded transition ring). */
export const MATERIALIZE_DEFAULT_BAND = 48;

/** Cool cyan-teal holo default (fog-city palette); retint via `holoColor`. */
export const HOLO_COLOR_DEFAULT = 0x36e0cf;

/**
 * DEBUG escape hatch (`?gridhorizon=1`): restore the pre-M13 to-horizon terrain
 * contour grid by disabling the edge window on terrain shading. Read once at
 * module load; guarded so headless bakes (no `location`) default to the
 * windowed "immediate area focus" look. Only affects the void/sweep phase —
 * settled shading is identical either way.
 */
export const GRID_TO_HORIZON_DEBUG =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("gridhorizon");

/**
 * Shared front state + birth registry. A single instance lives at module
 * scope (`materializeField`); the uniforms it owns are referenced by every
 * materialize-aware material, so one write updates all of them.
 */
export class MaterializeField {
  /** World XZ of the reveal front's centre. */
  readonly frontCenter = uniform(new THREE.Vector2(0, 0));
  /** Current front radius in metres. Starts fully revealed. */
  readonly frontRadius = uniform(MATERIALIZE_REVEALED_RADIUS);
  /** Width of the holo→shaded dissolve ring, metres. */
  readonly frontBand = uniform(MATERIALIZE_DEFAULT_BAND);
  /** The single holo tint uniform (edge glow, grid, scanline). */
  readonly holoColor = uniform(new THREE.Color(HOLO_COLOR_DEFAULT));
  /** Emissive gain for holo lines — authored against the app's fixed exposure
   *  anchor, so it uses the same LIGHT_SCALE convention as other emissives. */
  readonly holoIntensity = uniform(1.6 * LIGHT_SCALE);
  /** Field-local clock (seconds). Drives birth ramps + scanline animation.
   *  Named worldTime in the contract doc; advanced by update(). */
  readonly worldTime = uniform(0);

  /**
   * M13 steady-state birth-holo gate. 1 = birth/crossfade ramps render the full
   * holo language (boot sweep, teleport-arrival sweeps, debug toggle); 0 = the
   * applyMaterialize amount is forced to 1, so chunks streaming in during
   * NORMAL PLAY skip the cyan grid/scanline look and appear with each system's
   * own plain crossfade (citygen fadeClone alphaHash opacity, shellBatch fade
   * texel dither) or a plain attach (tiles / authored regions) — the pre-M5
   * steady-state behavior. Driven per frame from the ring coordinator state
   * (main's ringUpdate): enabled while not settled, else the debug tunable.
   * Disable lerps down (~0.4 s) so mid-ramp chunks finish smoothly at settle;
   * enable snaps so a teleport cut is atomic with its front collapse.
   */
  readonly birthHoloGate = uniform(1);
  #birthHoloTarget = 1;

  #births = new Map<string, ReturnType<typeof uniform>>();
  #sweepTarget: number | null = null;
  #sweepSpeed = 450;

  /** See `birthHoloGate`. Idempotent; call every frame (ringUpdate does). */
  setBirthHoloEnabled(on: boolean): void {
    this.#birthHoloTarget = on ? 1 : 0;
    if (on) this.birthHoloGate.value = 1;
  }

  /** DEBUG/probe: current gate target (true = holo birth language active). */
  get birthHoloEnabled(): boolean {
    return this.#birthHoloTarget === 1;
  }

  /**
   * Shared birth-timestamp uniform for a chunk/site/tile residency key.
   * Unborn keys hold +1e9 (birth ramp evaluates to 0 → invisible/holo);
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

  /** Place the front explicitly; cancels any running sweep. */
  setFront(x: number, z: number, radius: number, band = MATERIALIZE_DEFAULT_BAND): void {
    (this.frontCenter.value as THREE.Vector2).set(x, z);
    this.frontRadius.value = Math.max(0, radius);
    this.frontBand.value = Math.max(1, band);
    this.#sweepTarget = null;
  }

  /** Animate the front radius toward `toRadius` at `speed` m/s (update() drives it). */
  sweep(toRadius: number, speed = 450): void {
    this.#sweepTarget = Math.max(0, toRadius);
    this.#sweepSpeed = Math.max(1, Math.abs(speed));
  }

  /** Everything holo: collapse the front to zero radius at (x,z). */
  holo(x?: number, z?: number): void {
    const c = this.frontCenter.value as THREE.Vector2;
    this.setFront(x ?? c.x, z ?? c.y, 0);
  }

  /** Everything revealed (normal world) — the boot default. */
  reveal(): void {
    this.#sweepTarget = null;
    this.frontRadius.value = MATERIALIZE_REVEALED_RADIUS;
  }

  /** True while a sweep is still expanding/contracting the front. */
  get sweeping(): boolean {
    return this.#sweepTarget !== null;
  }

  /**
   * CPU twin of the front term of `materializeAmount` (no birth): 0 = holo,
   * 1 = fully revealed at (x, z). Used by CPU-driven consumers (Bay Lights /
   * Golden Gate light ramps) that scale an existing intensity uniform instead
   * of adding shader work. Collapses to 1 once `reveal()` parks the radius at
   * the revealed sentinel.
   */
  amountAt(x: number, z: number): number {
    const c = this.frontCenter.value as THREE.Vector2;
    const dx = x - c.x;
    const dz = z - c.y;
    const band = Math.max(1, this.frontBand.value as number);
    const t = ((this.frontRadius.value as number) - Math.hypot(dx, dz)) / band;
    return t <= 0 ? 0 : t >= 1 ? 1 : t;
  }

  /** Advance the field clock and any active sweep. Call once per frame. */
  update(dt: number): void {
    const clamped = Math.min(Math.max(dt, 0), 0.1);
    this.worldTime.value = (this.worldTime.value as number) + clamped;
    // Birth-holo gate: disable direction eases (~0.4 s) so chunks mid-birth at
    // the settle moment ramp smoothly to full instead of popping; the enable
    // direction snapped in the setter.
    const gate = this.birthHoloGate.value as number;
    if (gate > this.#birthHoloTarget) {
      this.birthHoloGate.value = Math.max(this.#birthHoloTarget, gate - clamped * 2.5);
    }
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
 * 0..1 materialize amount at a world position: 1 = fully shaded (inside the
 * front), 0 = holo/void. Combines the front sweep with an optional per-key
 * birth ramp (`min(frontAmt, birthAmt)` — content born after the front passed
 * is governed by its birth ramp alone).
 */
export function materializeAmount(opts: { worldPos?: N; birth?: N } = {}): N {
  const f = materializeField;
  const wp = (opts.worldPos ?? positionWorld) as N;
  const dist = wp.xz.sub(f.frontCenter as N).length();
  const frontAmt = (f.frontRadius as N).sub(dist).div(f.frontBand as N).saturate();
  if (!opts.birth) return frontAmt;
  const birthAmt = (f.worldTime as N)
    .sub(opts.birth)
    .div(MATERIALIZE_BIRTH_SECONDS)
    .saturate();
  return min(frontAmt, birthAmt);
}

/**
 * Antialiased world-space line lattice: ~1.4 px lines every `spacing` metres
 * on both axes of `coord` (a vec2). fwidth keeps the line width in screen
 * space; the smoothstep term retires the lattice before it aliases into moiré
 * at distance (a cell under ~2 px wide fades to nothing).
 */
function gridLines(coord: N, spacing: number): N {
  const p = coord.div(spacing);
  const w = (fwidth(p) as N).max(1e-5);
  const g = (abs(fract(p).sub(0.5)) as N).div(w.mul(1.4));
  const lineX = float(1).sub(min(g.x, 1)).mul(smoothstep(0.25, 0.6, w.x).oneMinus());
  const lineY = float(1).sub(min(g.y, 1)).mul(smoothstep(0.25, 0.6, w.y).oneMinus());
  return lineX.max(lineY);
}

/** Scalar variant of gridLines — used for elevation contours on worldPos.y. */
function contourLines(coord: N, spacing: number): N {
  const p = coord.div(spacing);
  const w = (fwidth(p) as N).max(1e-5);
  const g = (abs(fract(p).sub(0.5)) as N).div(w.mul(1.4));
  return float(1).sub(min(g, 1)).mul(smoothstep(0.4, 0.9, w).oneMinus());
}

/**
 * M12 edge glow window: 1 at/inside the dissolve edge, easing to 0 over
 * ~3 bands beyond the front. Concentrates the holo grid/fill glow in a window
 * hugging the edge so content far beyond the front renders essentially
 * black-on-black against the void sky (the budgeted visibility unhide — see
 * frontGate.ts — flips chunks where this window is ~0, so the flip is
 * imperceptible). Collapses to 1 everywhere once the front parks at the
 * revealed sentinel, so post-settle birth ramps keep today's look exactly.
 */
export function edgeGlowWindow(dist: N): N {
  const f = materializeField;
  const beyond = dist.sub(f.frontRadius as N).div((f.frontBand as N).mul(3));
  return smoothstep(0, 1, beyond).oneMinus();
}

/**
 * The holo look at a world position: near-black base + glowing world-space
 * contour grid (8 m lattice + 1 m sub-grid + 4 m elevation contours that
 * conform to real heights) + an animated scanline band that hugs the dissolve
 * edge. Pure ALU — no texture taps. Returns an emissive-ready vec3 in the
 * shared `holoColor`; `baseColor`, when given, ghosts a hint of the original
 * albedo into the fill so large surfaces keep a whisper of identity.
 *
 * `edgeWindow` (M12): attenuate the grid/fill glow beyond the dissolve edge
 * (see edgeGlowWindow). Default OFF so the terrain clipmap — whose
 * contour-grid-to-horizon IS the void aesthetic — keeps its full-view grid;
 * world fabric wrapped via applyMaterialize/applyHoloBirth opts in.
 */
export function holoShade(
  worldPos: N,
  baseColor?: N,
  opts: { edgeWindow?: boolean } = {}
): N {
  const f = materializeField;
  const wp = worldPos as N;
  const holo = vec3(f.holoColor as N);

  const grid8 = gridLines(wp.xz, 8);
  const grid1 = gridLines(wp.xz, 1);
  const contour = contourLines(wp.y, 4);
  const lines = grid8.mul(0.6).add(grid1.mul(0.18)).add(contour.mul(0.5)).min(1);

  // Scanline band riding the dissolve edge: a radial pulse train drifting
  // outward, windowed to ±1.5 bands around the front radius.
  const dist = wp.xz.sub(f.frontCenter as N).length();
  const edge = float(1)
    .sub(abs(dist.sub(f.frontRadius as N)).div((f.frontBand as N).mul(1.5)))
    .saturate();
  const scan = fract(dist.mul(0.14).sub((f.worldTime as N).mul(1.9)))
    .sub(0.5)
    .abs()
    .mul(2)
    .oneMinus()
    .mul(edge);

  let fill = baseColor
    ? holo.mul(0.028).add((baseColor as N).mul(holo).mul(0.05))
    : holo.mul(0.035);
  let glowLines = holo.mul(lines).mul(f.holoIntensity as N);
  if (opts.edgeWindow) {
    const window = edgeGlowWindow(dist).toVar();
    fill = fill.mul(window);
    glowLines = glowLines.mul(window);
  }
  return fill
    .add(glowLines)
    .add(holo.mul(scan).mul((f.holoIntensity as N).mul(0.45)));
}

export type ApplyMaterializeOptions = {
  /** World position node (defaults to positionWorld). */
  worldPos?: N;
  /** Optional per-residency birth uniform from `materializeField.birthOf`
   *  (or any 0-arg node holding a birth timestamp, e.g. a batch texel). */
  birth?: N;
  /**
   * Screen-door dissolve on opacity while amount is low (default true).
   * Terrain-style always-resident surfaces pass false: they stay opaque and
   * only crossfade their shading.
   */
  dissolve?: boolean;
  /**
   * Extra 0..1 amount MIN'd into the materialize amount — used by systems that
   * already own a crossfade (citygen shell fade texel / fade-clone opacity) so
   * their existing fade drives the SAME holo language as the front.
   */
  extraAmount?: N;
};

/**
 * Wrap a node material's colorNode/emissiveNode/opacityNode with the
 * materialize treatment:
 *   amount < 1 → holo grid look + (optionally) a stable screen-door dissolve
 *                keyed off a world-position hash (never per-frame random);
 *   amount = 1 → the original graph result via plain mixes (a few ALU, no
 *                texture taps on the added path).
 * Must be called before the material's first compile so the (single) pipeline
 * variant exists from construction — no swap-at-sweep-time compiles.
 */
export function applyMaterialize(
  material: THREE.MeshStandardNodeMaterial | (THREE.Material & { colorNode?: unknown }),
  opts: ApplyMaterializeOptions = {}
): void {
  const mat = material as N;
  const wp = (opts.worldPos ?? positionWorld) as N;
  let amountExpr = materializeAmount({ worldPos: wp, birth: opts.birth });
  if (opts.extraAmount) amountExpr = min(amountExpr, (opts.extraAmount as N).saturate());
  // M13 steady-state gate: when birthHoloGate is 0 (ring coordinator settled,
  // debug toggle off) the amount is forced to 1, collapsing the whole wrap to
  // the original graph — steady-state streamed chunks appear WITHOUT the holo
  // look while each system's own plain crossfade still runs (see the gate's
  // doc comment). Gate = 1 during boot/teleport sweeps → exact holo behavior.
  // One shared uniform, ~2 ALU, same single pipeline.
  const amount = amountExpr
    .max((materializeField.birthHoloGate as N).oneMinus())
    .toVar();
  // Shading crossfade rides the upper half of the ramp; the dissolve stipple
  // owns the lower third, so geometry is fully present (as holo) before it
  // starts trading holo shading for real shading.
  const reveal = smoothstep(0.45, 1.0, amount);

  const origColor = (mat.colorNode ?? materialColor) as N;
  // M12: world fabric concentrates the holo glow in a window hugging the
  // dissolve edge — far beyond the front it renders essentially black-on-black
  // so the budgeted visibility unhide (frontGate) is imperceptible.
  const holo = holoShade(wp, origColor, { edgeWindow: true });

  // Holo phase darkens the lit base almost to black — the hologram reads from
  // the emissive lines, not from sun/hemi response. The dark floor also rides
  // the M12 edge window: far beyond the edge even the 4% sunlit albedo goes to
  // zero, so noon boots show no faint silhouettes against the void.
  const colorWindow = edgeGlowWindow(wp.xz.sub(materializeField.frontCenter as N).length());
  mat.colorNode = origColor.mul(mix(colorWindow.mul(0.04), float(1), reveal));

  // Edge flash: a brief extra pulse of holoColor while a fragment crosses the
  // middle of the band (parabola peaking at amount = 0.5, zero at both ends).
  // Kept SUBTLE: under a birth ramp the amount is uniform across the whole
  // object, so a strong flash reads as a flat cyan wash over an entire
  // building (seen in M5 teleport QA) instead of an edge accent.
  const flash = amount.mul(amount.oneMinus()).mul(4);
  // materialEmissive is only valid on materials that HAVE an emissive colour;
  // unlit/basic node materials (some authored-region GLB materials) fall back
  // to zero so the wrap never references a missing material property.
  const origEmissive = (mat.emissiveNode ??
    (mat.emissive && mat.emissive.isColor ? materialEmissive : vec3(0))) as N;
  mat.emissiveNode = origEmissive
    .mul(reveal)
    .add(holo.mul(reveal.oneMinus()))
    .add(vec3(materializeField.holoColor as N).mul(flash).mul(
      (materializeField.holoIntensity as N).mul(0.08)
    ));

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
 * Holo-darkness birth ramp for OPAQUE world fabric (docs M5): identical to
 * `applyMaterialize` but NEVER touches opacity/alphaTest — amount 0 crushes the
 * base colour toward dark + emissive holo grid, amount 1 is the exact original
 * shading via plain mixes. A discard-capable shader would disable early-Z for
 * the whole city forever, so streamed opaque fabric always goes through this.
 * Must run before the material's first compile (creation/clone time) so the
 * single pipeline variant is what gets warmed.
 */
export function applyHoloBirth(
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

/** Convenience: wire the holo-birth mix onto a batch material with a
 *  per-instance birth texture (see `batchBirthNode`). Call AFTER the material's
 *  base node graph is assigned and BEFORE its warm/compile. */
export function configureBatchHoloBirth(
  material: THREE.MeshStandardNodeMaterial,
  batchMesh: THREE.BatchedMesh,
  birthTex: THREE.DataTexture
): void {
  applyHoloBirth(material, { birth: batchBirthNode(batchMesh, birthTex) });
}
