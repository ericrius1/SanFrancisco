// Ring coordinator (docs/VOID_STREAM_REWRITE.md §C; M18 particle-scan rewrite).
//
// Thin orchestration over the EXISTING streamers: it never loads anything
// itself. It drives the void arrival experience as a phase machine:
//
//   holding    `?voidholo=1` debug hold (manual `__sf.materialize` driving).
//   scanning   The terrain-scan particle wave (materialize front) ripples out
//              to SCAN_RADIUS, chasing TERRAIN-DATA residency only — the wave
//              never outruns installed ground truth, and fabric stays fully
//              hidden behind the front gate.
//   morphing   worldReveal eases 0→1 (~1.6 s): terrain/water/sky dawn in as
//              one ramp, the particle field retires, the void fog wall arms
//              at the bubble edge. The front parks at the revealed sentinel
//              and the front gate releases at the END of the morph (fabric
//              then birth-fades in under its budgeted flush).
//   filling    The rest of the world loads behind the fog wall (staged
//              background expansion, exactly the pre-M18 machinery). The
//              coordinator chases full fabric residency and nudges stalled
//              expansion; the player is free inside (and beyond — the wall is
//              a medium, not a barrier) the scanned bubble.
//   revealing  The payoff: the wall radius sweeps outward while its density
//              eases to zero, unveiling the completed city (~5 s).
//   settled    Normal play. Everything here is inert.
//
// Hot-path discipline: `update()` performs a handful of scalar ops and at
// most a few uniform writes per frame; the residency query is throttled both
// here (every RESIDENCY_REFRESH_FRAMES frames) and inside the streamer's own
// tick-cadence cache. No allocations per frame.
import { bandForRadius, materializeField } from "../render/materialize";
import { tracer } from "../core/hitchTracer";
import type { TileStreamer } from "../world/tiles";

export type RingCoordinatorState =
  | "holding"
  | "scanning"
  | "morphing"
  | "filling"
  | "revealing"
  | "settled";

export type RingFocusOptions = {
  /** true (default): collapse to a fresh void scan at the new centre. */
  reset?: boolean;
  /**
   * true (default): re-prime the participants through the injected prime
   * callback. M7 far arrivals pass false because worldArrival already primed
   * tiles/regions/collision for the destination through its own epoch-guarded
   * path — the coordinator then only recenters and replays the phases.
   */
  prime?: boolean;
};

export type RingCoordinatorOptions = {
  tiles: TileStreamer;
  /** Live player body — read-only X/Z (reference, never copied). */
  player: { position: { x: number; z: number } };
  /**
   * Re-prime participants at a new focus (tiles.primeAt +
   * authoredRegions.prepareAt + the collision arrival). main.ts wires this to
   * the same `primeInitialVisualAt` path boot/worldArrival relocations use —
   * the coordinator never duplicates prime logic. Called by `focus()` only.
   */
  prime: (x: number, z: number) => void;
  /**
   * M18: distance to the nearest terrain DATA that is not yet installed
   * around the focus (terrainTiles.residentRadiusAround). The scan wave
   * chases this — the particle field must never form ground whose real
   * heights haven't landed. Omitted → the wave runs purely on its clock.
   */
  terrainRadius?: (x: number, z: number) => number;
  /**
   * The player's real full draw radius (CONFIG.tileLoadRadius before boot
   * clamped it to the initial visual bubble). Fill residency reaching
   * min(fullRadius, SETTLE_CAP) is "full world" for reveal purposes.
   */
  fullRadius: number;
  /**
   * Radius the initial fog-walled fill is actually allowed to admit. This is
   * deliberately smaller than the full vista radius: the ordinary streamer
   * re-centres this working set as the player moves.
   */
  fillRadius?: number;
  /**
   * M9: LIVE CONFIG.tileLoadRadius. A mode can cap it below fullRadius
   * (surf's 2 km cull cap), which would hold fill residency below the reveal
   * radius forever. Once residency has verifiably plateaued at such a cap the
   * coordinator reveals at the capped radius instead of waiting for the age
   * bound.
   */
  liveLoadRadius?: () => number;
  /**
   * M18: drive the void fog wall (sky.setVoidFogWall). Called with the wall
   * centre/radius/density whenever the coordinator changes it (a few writes
   * per phase transition, per-frame only during `revealing`).
   */
  fogWall?: (x: number, z: number, radius: number, density: number) => void;
  /**
   * Fired once per stall deadline when staged expansion has not grown fill
   * residency for STALL_MS while the draw ring is still below full. main.ts
   * performs the same restore the worldReady quiet-window block does
   * (CONFIG.tileLoadRadius → full) + `tiles.beginBackgroundExpansion()`.
   */
  onExpansionStalled?: () => void;
  /** Fired once when the reveal completes (bootMark hook). */
  onSettled?: () => void;
  /**
   * M16: "spreading starts" gate. While it returns false the scan clock is
   * frozen and the wave stays pinned at the player's tiny PLAYER_CLEAR pool —
   * pure black past a few metres of points. main.ts wires it to "control
   * handed over AND the anchor terrain tile at (cx, cz) is real", so boot and
   * far teleports both hold until the ground is truly ready to ring out.
   * Omitted → always spreading.
   */
  spreadGate?: (cx: number, cz: number) => boolean;
  /** `?voidholo=1`: hold the collapsed void for manual `__sf.materialize`. */
  holdHolo?: boolean;
};

// ---- Phase A: the scan -----------------------------------------------------
/** Scan bubble radius (m): ~20 terrain tiles ≈ 0.7 MB of ground truth. The
 *  particle lattice (terrainScanParticles) is sized to this + margin. */
export const SCAN_RADIUS = 1600;
// Wave never sweeps ground whose terrain tile hasn't installed (margin keeps
// the soft edge off a mid-install tile seam).
const SCAN_TERRAIN_MARGIN = 24;
// The player always keeps a revealed pool around their feet, even pre-spread.
const PLAYER_CLEAR = 2;
// Brisk wave profile: ease in near the player for readability, then sprint.
// ~4.5 s to cover 1600 m when data keeps up.
const V_SCAN_START = 90; // m/s at focus
const V_SCAN_MAX = 620; // m/s once established
const VELOCITY_EASE = 1.9; // 1/s — exponential approach toward vMax
// A scan must always terminate: on starved networks the wave waits for tiles,
// but past this age we morph with whatever installed (far ground dawns from
// the coarse overview and sharpens as tiles land — better than eternal void).
const SCAN_MAX_AGE_S = 45;

// ---- Phase A→B: the morph --------------------------------------------------
const MORPH_SECONDS = 1.6;

// ---- Phase B: the fill -----------------------------------------------------
// Fill completion target (same semantics as the old settle).
const SETTLE_CAP = 3600;
const RESIDENCY_REFRESH_FRAMES = 20;
const STALL_MS = 20_000;
// A live tileLoadRadius below fullRadius (surf's mode cap) becomes the reveal
// radius only after residency has plateaued at it this long.
const CAPPED_RADIUS_QUIET_MS = 12_000;
// The fill must always terminate too (slow networks): past this age the
// reveal runs with whatever loaded; late chunks birth-fade behind normal fog.
const FILL_MAX_AGE_S = 300;
// Player far from the focus with the world around THEM loaded = they've left
// the theater; reveal rather than pinning the wall to an abandoned focus.
const PLAYER_ESCAPE_DISTANCE = 2600;

// ---- Phase B→C: the reveal -------------------------------------------------
const REVEAL_SECONDS = 5.2;
/** Wall radius at the end of the sweep (past the draw/fog edge). */
const REVEAL_END_RADIUS = 6500;
/** Wall density while the fill runs (1 = the authored dense shroud). */
const WALL_DENSITY = 1;

const smooth01 = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

export class RingCoordinator {
  #opts: RingCoordinatorOptions;
  #state: RingCoordinatorState;
  #generation = 0;
  #cx: number;
  #cz: number;
  #radius = 0;
  #velocity = V_SCAN_START;
  #age = 0; // seconds since the current phase began
  #resident = 0; // cached fill residency around the focus
  #framesSinceResidency = RESIDENCY_REFRESH_FRAMES; // refresh on first update
  #lastGrowthAt = performance.now();
  #lastNudgeAt = 0;

  /**
   * Adopts (cx, cz) as the initial focus WITHOUT re-priming — boot already
   * primed tiles/regions/collision at this point. Collapses to void there.
   */
  constructor(cx: number, cz: number, opts: RingCoordinatorOptions) {
    this.#opts = opts;
    this.#cx = cx;
    this.#cz = cz;
    this.#state = opts.holdHolo ? "holding" : "scanning";
    materializeField.holo(cx, cz);
    this.#opts.fogWall?.(cx, cz, 1e9, 0);
  }

  get state(): RingCoordinatorState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  /** True while fabric visibility must stay held (scan + morph + the debug
   *  hold) — main wires frontGate.setActive to this. */
  get fabricHeld(): boolean {
    return (
      this.#state === "holding" ||
      this.#state === "scanning" ||
      this.#state === "morphing"
    );
  }

  /** Cached fill-residency radius around the focus (metres). */
  residentRadius(): number {
    return this.#resident;
  }

  /** Current scan-front radius (metres; sentinel once morphed). */
  frontRadius(): number {
    return materializeField.frontRadius.value as number;
  }

  /**
   * True when (x, z) lies inside the currently-unveiled world: within the
   * scan wave while scanning, within the fog wall's bubble during fill, and
   * everywhere once revealed. Arrival classification uses this so a mid-fill
   * hop into the shroud counts as far — the phases then replay at the
   * destination instead of the cover dropping into dense fog.
   */
  coversPoint(x: number, z: number): boolean {
    if (this.#state === "settled" || this.#state === "revealing") return true;
    const dx = x - this.#cx;
    const dz = z - this.#cz;
    const r = this.#state === "filling" ? SCAN_RADIUS : this.#radius;
    return dx * dx + dz * dz <= r * r;
  }

  /**
   * Recenter for a relocation (M7 teleport arrivals). Bumps the generation so
   * stale async completions from the previous focus are ignored, re-primes
   * the participants through the shared prime path (unless the caller already
   * primed — `prime: false`), and (when `reset`, the default) replays the
   * whole void arrival at the destination.
   */
  focus(x: number, z: number, options: RingFocusOptions = {}): void {
    const reset = options.reset !== false;
    this.#generation++;
    this.#cx = x;
    this.#cz = z;
    if (reset) {
      this.#radius = 0;
      this.#velocity = V_SCAN_START;
      this.#age = 0;
      materializeField.holo(x, z);
      this.#opts.fogWall?.(x, z, 1e9, 0);
      if (this.#state !== "holding") this.#state = "scanning";
    } else {
      // Keep the current phase for short covered hops; just recenter.
      const c = materializeField.frontCenter.value as { set(x: number, z: number): void };
      c.set(x, z);
      this.#opts.fogWall?.(x, z, this.#state === "filling" ? SCAN_RADIUS : 1e9, this.#state === "filling" ? WALL_DENSITY : 0);
    }
    this.#resident = 0;
    this.#framesSinceResidency = RESIDENCY_REFRESH_FRAMES;
    this.#lastGrowthAt = performance.now();
    this.#lastNudgeAt = 0;
    // The prime path owns its own epoch/generation guards (tiles.primeAt
    // generations, primeInitialVisualAt epoch) — stale completions there
    // cannot touch this coordinator's state.
    if (options.prime !== false) this.#opts.prime(x, z);
  }

  /**
   * Per-frame driver. Single call site helper — invoked from BOTH the
   * provisional voidTick and the real loop's updateWorld, right before
   * `materializeField.update`.
   */
  update(dt: number): void {
    if (this.#state === "holding" || this.#state === "settled") return;
    const clamped = Math.min(Math.max(dt, 0), 0.1);
    switch (this.#state) {
      case "scanning":
        this.#updateScan(clamped);
        return;
      case "morphing":
        this.#updateMorph(clamped);
        return;
      case "filling":
        this.#updateFill(clamped);
        return;
      case "revealing":
        this.#updateReveal(clamped);
        return;
    }
  }

  // ---- scanning -----------------------------------------------------------
  #updateScan(dt: number): void {
    const p = this.#opts.player.position;
    const pdx = p.x - this.#cx;
    const pdz = p.z - this.#cz;
    const playerDist = Math.sqrt(pdx * pdx + pdz * pdz);

    // Player long gone (booted and immediately flew off) — settle everything.
    if (playerDist > PLAYER_ESCAPE_DISTANCE) {
      this.#forceSettle("player-escape-scan");
      return;
    }

    // M16: before spreading starts, the wave is pinned at the player's feet —
    // the scan clock stays at 0 so the eventual spread opens from scratch.
    const spreading = this.#opts.spreadGate?.(this.#cx, this.#cz) !== false;
    if (!spreading) {
      const pinned = Math.max(playerDist + PLAYER_CLEAR, this.#radius);
      if (pinned > this.#radius) {
        this.#radius = pinned;
        materializeField.frontRadius.value = this.#radius;
      }
      materializeField.frontBand.value = bandForRadius(this.#radius);
      return;
    }

    this.#age += dt;
    if (this.#age > SCAN_MAX_AGE_S) {
      tracer.count("ringScanAgeCap");
      this.#beginMorph();
      return;
    }

    // Target: the scan bubble, clamped to installed terrain data, but never
    // below the player's pool and never shrinking.
    const terrain = this.#opts.terrainRadius?.(this.#cx, this.#cz) ?? Infinity;
    let target = Math.min(
      SCAN_RADIUS,
      Math.max(
        Number.isFinite(terrain) ? terrain - SCAN_TERRAIN_MARGIN : SCAN_RADIUS,
        playerDist + PLAYER_CLEAR,
        this.#radius
      )
    );

    const vMax = this.#age < 1.2 ? V_SCAN_START + (V_SCAN_MAX - V_SCAN_START) * smooth01(this.#age / 1.2) : V_SCAN_MAX;
    this.#velocity += (vMax - this.#velocity) * Math.min(1, dt * VELOCITY_EASE);
    const gap = target - this.#radius;
    if (gap > 0) {
      this.#radius += Math.min(gap, this.#velocity * dt);
      materializeField.frontRadius.value = this.#radius;
    }
    materializeField.frontBand.value = bandForRadius(this.#radius);

    if (this.#radius >= SCAN_RADIUS - 0.5) this.#beginMorph();
  }

  // ---- morphing -----------------------------------------------------------
  #beginMorph(): void {
    this.#state = "morphing";
    this.#age = 0;
    // Arm the wall at the bubble edge BEFORE the dawn: the sky's (1 − void)
    // multiply ramps its visible density in exactly as the world lights up.
    this.#opts.fogWall?.(this.#cx, this.#cz, SCAN_RADIUS, WALL_DENSITY);
  }

  #updateMorph(dt: number): void {
    this.#age += dt;
    const t = Math.min(1, this.#age / MORPH_SECONDS);
    materializeField.worldReveal.value = smooth01(t);
    if (t >= 1) {
      // Park the front at the revealed sentinel: every materialize amount
      // collapses to its plain birth/extra terms from here on, and the scan
      // particle field (scaled by 1 − worldReveal) is fully retired.
      materializeField.reveal();
      this.#state = "filling";
      this.#age = 0;
      this.#lastGrowthAt = performance.now();
      // main's ringUpdate sees fabricHeld flip false and releases the front
      // gate → budgeted flush; fabric birth-fades in behind the fog wall.
    }
  }

  // ---- filling ------------------------------------------------------------
  #updateFill(dt: number): void {
    this.#age += dt;
    if (++this.#framesSinceResidency >= RESIDENCY_REFRESH_FRAMES) {
      this.#framesSinceResidency = 0;
      this.#refreshFillResidency();
    }
    if (this.#age > FILL_MAX_AGE_S) {
      tracer.count("ringFillAgeCap");
      this.#beginReveal();
      return;
    }
    const p = this.#opts.player.position;
    const playerDist = Math.hypot(p.x - this.#cx, p.z - this.#cz);
    if (
      playerDist > PLAYER_ESCAPE_DISTANCE &&
      this.#opts.tiles.residentRadiusAround(p.x, p.z) > 800
    ) {
      tracer.count("ringPlayerEscapeFill");
      this.#beginReveal();
    }
  }

  #refreshFillResidency(): void {
    const now = performance.now();
    let resident = this.#opts.tiles.residentRadiusAround(this.#cx, this.#cz);
    if (resident > this.#resident + 1) this.#lastGrowthAt = now;
    this.#resident = resident;

    let revealRadius = Math.min(
      this.#opts.fullRadius,
      this.#opts.fillRadius ?? Infinity,
      SETTLE_CAP
    );
    // M9: respect a LIVE capped load radius (surf's 2 km cap) once residency
    // has plateaued at it.
    const liveRadius = this.#opts.liveLoadRadius?.() ?? Infinity;
    if (
      liveRadius < revealRadius &&
      resident >= liveRadius - 0.5 &&
      now - this.#lastGrowthAt > CAPPED_RADIUS_QUIET_MS
    ) {
      revealRadius = liveRadius;
    }
    if (resident >= revealRadius - 0.5) {
      this.#beginReveal();
      return;
    }

    // Stall nudge: staged expansion is admission-gated (quiet windows, boot
    // arrival completion). If the player keeps moving those gates can stay
    // shut indefinitely — past the deadline, kick the next stage directly.
    if (now - this.#lastGrowthAt > STALL_MS && now - this.#lastNudgeAt > STALL_MS) {
      this.#lastNudgeAt = now;
      this.#opts.tiles.resumeBackgroundStreaming();
      const dbg = this.#opts.tiles.backgroundStreamingDebug;
      if (dbg.radius < revealRadius) this.#opts.onExpansionStalled?.();
    }
  }

  // ---- revealing ----------------------------------------------------------
  #beginReveal(): void {
    if (this.#state === "revealing" || this.#state === "settled") return;
    tracer.count("ringReveal");
    console.info(
      `[rings] reveal begins — fill resident=${Math.round(this.#resident)}m ` +
      `after ${this.#age.toFixed(1)}s`
    );
    this.#state = "revealing";
    this.#age = 0;
  }

  #updateReveal(dt: number): void {
    this.#age += dt;
    const t = Math.min(1, this.#age / REVEAL_SECONDS);
    const eased = smooth01(t);
    const radius = SCAN_RADIUS + (REVEAL_END_RADIUS - SCAN_RADIUS) * eased;
    // Density holds through the first stretch (the wall visibly recedes),
    // then dissolves entirely over the back half.
    const density = WALL_DENSITY * (1 - smooth01((t - 0.45) / 0.55));
    this.#opts.fogWall?.(this.#cx, this.#cz, radius, density);
    if (t >= 1) {
      this.#opts.fogWall?.(this.#cx, this.#cz, 1e9, 0);
      this.#state = "settled";
      this.#opts.onSettled?.();
    }
  }

  /**
   * Escape settle: jump straight to the fully-revealed steady state (used
   * when the player has left the theater entirely). New content keeps
   * birth-fading after settle, so the instant reveal is invisible at escape
   * distances.
   */
  #forceSettle(reason: string): void {
    if (this.#state === "settled") return;
    tracer.count("ringForceSettle");
    console.info(`[rings] force-settle (${reason}) age=${this.#age.toFixed(1)}s`);
    materializeField.reveal();
    this.#opts.fogWall?.(this.#cx, this.#cz, 1e9, 0);
    this.#state = "settled";
    this.#opts.onSettled?.();
  }
}
