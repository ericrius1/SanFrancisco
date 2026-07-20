// Ring coordinator (docs/VOID_STREAM_REWRITE.md §C, milestone M4).
//
// Thin orchestration over the EXISTING streamers: it never loads anything
// itself. Each frame it chases what the tile streamer reports as fully
// attached (`tiles.residentRadiusAround`) with the shared materialize front,
// so the holo→shaded sweep only ever advances over ground that is resident.
// Staged background expansion stays owned by tiles.ts / the worldReady
// quiet-window block in main.ts — the coordinator merely nudges the next
// stage after a stall deadline so continuous player movement can never pin
// the front (or the draw ring) at the boot bubble forever.
//
// Hot-path discipline: `update()` performs a handful of scalar ops and at
// most two uniform writes per frame; the residency query is throttled both
// here (every RESIDENCY_REFRESH_FRAMES frames) and inside the streamer's own
// tick-cadence cache. No allocations per frame.
import { materializeField, MATERIALIZE_DEFAULT_BAND } from "../render/materialize";
import { frontGateClampMargin } from "../render/frontGate";
import { tracer } from "../core/hitchTracer";
import type { TileStreamer } from "../world/tiles";

export type RingCoordinatorState = "holding" | "sweeping" | "settled";

export type RingFocusOptions = {
  /** true (default): collapse the front to radius 0 at the new centre. */
  reset?: boolean;
  /**
   * true (default): re-prime the participants through the injected prime
   * callback. M7 far arrivals pass false because worldArrival already primed
   * tiles/regions/collision for the destination through its own epoch-guarded
   * path — the coordinator then only recenters the front and chases residency.
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
   * M5: distance to the nearest citygen cell that has not yet published its
   * chunk (Infinity when nothing constrains — including before the citygen
   * ring exists, since it loads post-reveal). Min'd into the residency the
   * front chases, so the sweep never crosses a cell mid baked→chunk swap.
   */
  citygenRadius?: (x: number, z: number) => number;
  /**
   * The player's real full draw radius (CONFIG.tileLoadRadius before boot
   * clamped it to the initial visual bubble). Residency reaching
   * min(fullRadius, SETTLE_CAP) is "full draw distance" for settle purposes.
   */
  fullRadius: number;
  /**
   * M9: LIVE CONFIG.tileLoadRadius. A mode can cap it below fullRadius (surf's
   * 2 km cull cap), which would hold residency below the settle radius forever.
   * Once residency has verifiably plateaued at such a cap the coordinator
   * settles at the capped radius instead of sweeping until the age bound. The
   * plateau requirement keeps boot honest: the initial-visual-bubble clamp
   * also reads below fullRadius but lifts (and residency keeps growing)
   * within seconds.
   */
  liveLoadRadius?: () => number;
  /**
   * M12: distance (from the front centre) to the nearest chunk still hidden by
   * the front visibility gate (frontGate.clearedRadius; Infinity when nothing
   * is hidden). The front's target clamps to it minus frontGateClampMargin()
   * so the dissolve edge can never outpace the budgeted unhide queue — the
   * same way it chases residency.
   */
  unhideClearedRadius?: () => number;
  /**
   * Fired once per stall deadline when staged expansion has not grown
   * residency for STALL_MS while the draw ring is still below full. main.ts
   * performs the same restore the worldReady quiet-window block does
   * (CONFIG.tileLoadRadius → full) + `tiles.beginBackgroundExpansion()`.
   */
  onExpansionStalled?: () => void;
  /** Fired once when the front settles to full reveal (bootMark hook). */
  onSettled?: () => void;
  /** `?voidholo=1`: hold the collapsed holo for manual `__sf.materialize`. */
  holdHolo?: boolean;
};

// Front trails resident ground by this margin so the dissolve band never
// touches a tile mid-attach.
const FRONT_MARGIN = 60;
// The player always keeps a revealed bubble. Deliberately TINY: the void
// moment shows only a ~dozen-metre lit disc hugging the avatar ("immediate
// area, even nothing at all"), and the sweep rings out from there. The term
// still tracks a moving player so the ground underfoot is never pure void,
// but it no longer force-jumps the front to a wide radius at spawn. Content
// beyond the front is hidden/discarded, so a small clear bubble is safe.
const PLAYER_CLEAR = 12;
// Generous absolute cap: residency beyond this settles the front regardless
// of the configured draw distance (matches the M3 interim final sweep).
const SETTLE_CAP = 3600;
// Once fully resident, push the band this far past the last ring before
// collapsing to the revealed sentinel, so the final dissolve exits the fog
// veil instead of vanishing mid-air.
const SETTLE_OVERSHOOT = 240;
// Growth profile: slow initial bloom near the player for drama, easing up to
// a brisk-but-visible edge speed across the first BLOOM_SECONDS, then a fast
// catch-up chase once the sweep is established.
const BLOOM_SECONDS = 10;
const V_BLOOM_START = 16; // m/s at focus
const V_BLOOM_END = 120; // m/s at BLOOM_SECONDS
const V_FAST = 520; // m/s catch-up after the bloom
const VELOCITY_EASE = 1.6; // 1/s — exponential approach rate toward vMax
// Residency refresh cadence (frames) + expansion stall deadline.
const RESIDENCY_REFRESH_FRAMES = 20;
const STALL_MS = 20_000;
// ---- M9 settle escapes: a sweep must ALWAYS terminate. -------------------
// Residency is measured around the sweep FOCUS while tiles load/unload around
// the PLAYER, so a player who boots and immediately drives/flies away one
// direction leaves focus residency decaying: the settle condition never fires
// and everything beyond the front stays holo-dark forever. Two escapes:
// Player-escape: beyond this distance from the focus the player has left the
// theater. Content near them is resident (streamers follow the player) and
// post-settle attaches still birth-fade, so the instant reveal is invisible at
// this range. Kept below the front cap (SETTLE_CAP + SETTLE_OVERSHOOT) so the
// escape fires while PLAYER_CLEAR still protects the player's bubble.
const PLAYER_ESCAPE_DISTANCE = 2600;
// Absolute sweep age bound — covers capped load radii (surf) and any future
// residency stall the other escapes miss.
const SWEEP_MAX_AGE_S = 90;
// A live tileLoadRadius below fullRadius (surf's mode cap) becomes the settle
// radius only after residency has plateaued at it this long — never at boot,
// where the initial bubble clamp lifts and growth resumes within seconds.
const CAPPED_RADIUS_QUIET_MS = 12_000;
// M15: the dissolve band (and with it the ~3-band edge-glow window every holo
// consumer renders) SCALES with the front radius during the early bloom, so
// the spawn moment shows a ~10-15 m lit disc instead of a band-48 glow that
// reads ~4x wider than the actual front. Relaxes to the default band as the
// ring grows; the settled sentinel is unaffected (band is irrelevant at
// radius=1e9 — every amount saturates to 1).
const BAND_MIN = 10;
const BAND_RADIUS_SCALE = 0.4;
const bandFor = (radius: number): number =>
  Math.min(MATERIALIZE_DEFAULT_BAND, Math.max(BAND_MIN, radius * BAND_RADIUS_SCALE));

export class RingCoordinator {
  #opts: RingCoordinatorOptions;
  #state: RingCoordinatorState;
  #generation = 0;
  #cx: number;
  #cz: number;
  #radius = 0;
  #velocity = V_BLOOM_START;
  #age = 0; // seconds since the current sweep began
  #resident = 0; // cached tiles.residentRadiusAround at the focus
  #settleTarget = 0; // 0 = not yet fully resident
  #framesSinceResidency = RESIDENCY_REFRESH_FRAMES; // refresh on first update
  #lastGrowthAt = performance.now();
  #lastNudgeAt = 0;

  /**
   * Adopts (cx, cz) as the initial focus WITHOUT re-priming — boot already
   * primed tiles/regions/collision at this point. Collapses the front there.
   */
  constructor(cx: number, cz: number, opts: RingCoordinatorOptions) {
    this.#opts = opts;
    this.#cx = cx;
    this.#cz = cz;
    this.#state = opts.holdHolo ? "holding" : "sweeping";
    materializeField.setFront(cx, cz, 0, bandFor(0));
  }

  get state(): RingCoordinatorState {
    return this.#state;
  }

  get generation(): number {
    return this.#generation;
  }

  /** Cached staged-resident radius around the focus (metres). */
  residentRadius(): number {
    return this.#resident;
  }

  /** Current front radius (metres; MATERIALIZE_REVEALED_RADIUS once settled). */
  frontRadius(): number {
    return materializeField.frontRadius.value as number;
  }

  /**
   * M9: true when (x, z) already lies inside the materialize front (always
   * true once settled). Arrival classification uses this so a mid-sweep hop to
   * ground that is resident but NOT yet swept counts as far — the front then
   * refocuses at the destination instead of the cover dropping onto holo.
   */
  coversPoint(x: number, z: number): boolean {
    if (this.#state === "settled") return true;
    const dx = x - this.#cx;
    const dz = z - this.#cz;
    return dx * dx + dz * dz <= this.#radius * this.#radius;
  }

  /**
   * Recenter the front for a relocation (M7 teleport arrivals). Bumps the
   * generation so any stale async completions from the previous focus are
   * ignored, re-primes the participants through the shared prime path (unless
   * the caller already primed — `prime: false`), and (when `reset`, the
   * default) collapses the front to a fresh bloom at the destination.
   * `reset: false` keeps the current radius for short hops where
   * re-dissolving the whole world would be jarring.
   */
  focus(x: number, z: number, options: RingFocusOptions = {}): void {
    const reset = options.reset !== false;
    this.#generation++;
    this.#cx = x;
    this.#cz = z;
    if (reset) {
      this.#radius = 0;
      this.#velocity = V_BLOOM_START;
      this.#age = 0;
    }
    this.#resident = 0;
    this.#settleTarget = 0;
    this.#framesSinceResidency = RESIDENCY_REFRESH_FRAMES;
    this.#lastGrowthAt = performance.now();
    this.#lastNudgeAt = 0;
    materializeField.setFront(x, z, this.#radius, bandFor(this.#radius));
    if (this.#state !== "holding") this.#state = "sweeping";
    // The prime path owns its own epoch/generation guards (tiles.primeAt
    // generations, primeInitialVisualAt epoch) — stale completions there
    // cannot touch this coordinator's state.
    if (options.prime !== false) this.#opts.prime(x, z);
  }

  /**
   * Per-frame driver. Single call site helper — invoked from BOTH the
   * provisional voidTick and the real loop's updateWorld, right before
   * `materializeField.update`. Never shrinks the front; `bootArrivalTick`'s
   * stray re-anchor moves only the collision bubble, so a wandering player is
   * chased via the PLAYER_CLEAR term rather than by resetting the front.
   */
  update(dt: number): void {
    if (this.#state !== "sweeping") return;
    const clamped = Math.min(Math.max(dt, 0), 0.1);
    this.#age += clamped;

    if (++this.#framesSinceResidency >= RESIDENCY_REFRESH_FRAMES) {
      this.#framesSinceResidency = 0;
      this.#refreshResidency();
    }

    // Target radius: chase staged residency, but keep the player inside a
    // revealed bubble, and never shrink (monotonic during a sweep).
    const p = this.#opts.player.position;
    const pdx = p.x - this.#cx;
    const pdz = p.z - this.#cz;
    const playerDist = Math.sqrt(pdx * pdx + pdz * pdz);

    // M9 settle escapes — see the constants and #forceSettle. Checked before
    // the target math so a pinned sweep can never outlive them.
    if (playerDist > PLAYER_ESCAPE_DISTANCE) {
      this.#forceSettle("player-escape");
      return;
    }
    if (this.#age > SWEEP_MAX_AGE_S) {
      this.#forceSettle("age-cap");
      return;
    }

    let target = Math.max(
      this.#resident - FRONT_MARGIN,
      playerDist + PLAYER_CLEAR,
      this.#radius
    );
    if (this.#settleTarget > 0) target = Math.max(target, this.#settleTarget);
    target = Math.min(target, SETTLE_CAP + SETTLE_OVERSHOOT);
    // M12: never outpace the visibility unhide queue. Content is revealed
    // (visibility flip) at front + band + frontGateLead(); clamping the target
    // to nearestHidden − frontGateClampMargin() (< lead + band) means chunks
    // always flip visible well beyond the dissolve edge, where the holo edge
    // window renders them near-black. A clamp below the current radius simply
    // pauses the front (gap ≤ 0 — monotonicity preserved) until the gate's
    // budgeted reveals catch up. Settle escapes above still terminate a sweep
    // a stuck queue could otherwise pin. M15: both terms scale with the band
    // (which tracks the radius during the early bloom) so nothing flips
    // visible hundreds of metres out at the void moment.
    const cleared = this.#opts.unhideClearedRadius?.() ?? Infinity;
    if (Number.isFinite(cleared)) {
      target = Math.min(target, Math.max(0, cleared - frontGateClampMargin()));
    }

    // Eased, capped velocity: smooth bloom for the first BLOOM_SECONDS so the
    // edge stays visible near the player, then a fast chase outward.
    const bloomT = Math.min(this.#age / BLOOM_SECONDS, 1);
    const vMax =
      bloomT < 1
        ? V_BLOOM_START + (V_BLOOM_END - V_BLOOM_START) * bloomT * bloomT * (3 - 2 * bloomT)
        : V_FAST;
    this.#velocity += (vMax - this.#velocity) * Math.min(1, clamped * VELOCITY_EASE);

    const gap = target - this.#radius;
    if (gap > 0) {
      this.#radius += Math.min(gap, this.#velocity * clamped);
      materializeField.frontRadius.value = this.#radius;
    }
    // M15: keep the band tracking the radius through the early bloom (pure
    // uniform write; monotonic like the radius, capped at the default band).
    materializeField.frontBand.value = bandFor(this.#radius);

    if (this.#settleTarget > 0 && this.#radius >= this.#settleTarget - 0.5) {
      this.#state = "settled";
      // Collapsed-front path: reveal() parks the radius at the revealed
      // sentinel so every materialize mix is byte-stable at amount=1 —
      // steady-state cost is the collapsed-front path, and this update()
      // early-returns from here on.
      materializeField.reveal();
      this.#opts.onSettled?.();
    }
  }

  /**
   * M9: escape settle. Takes the SAME settle path as the residency route —
   * settled state (main's ringUpdate wrapper polls it and releases the M7
   * shadow streaming hold on the change), materializeField.reveal(), and the
   * onSettled bootMark — just without waiting for focus residency that will
   * never arrive. New content keeps birth-fading after settle, so the instant
   * reveal is invisible at escape distances.
   */
  #forceSettle(reason: string): void {
    if (this.#state !== "sweeping") return;
    tracer.count("ringForceSettle");
    console.info(
      `[rings] force-settle (${reason}) age=${this.#age.toFixed(1)}s ` +
      `front=${Math.round(this.#radius)}m resident=${Math.round(this.#resident)}m`
    );
    this.#state = "settled";
    materializeField.reveal();
    this.#opts.onSettled?.();
  }

  #refreshResidency(): void {
    const now = performance.now();
    let resident = this.#opts.tiles.residentRadiusAround(this.#cx, this.#cz);
    if (this.#opts.citygenRadius) {
      tracer.count("ringCitygenResidency");
      const citygen = this.#opts.citygenRadius(this.#cx, this.#cz);
      if (citygen < resident) resident = citygen;
    }
    if (resident > this.#resident + 1) this.#lastGrowthAt = now;
    this.#resident = resident;

    let settleRadius = Math.min(this.#opts.fullRadius, SETTLE_CAP);
    // M9: respect a LIVE capped load radius (surf's 2 km cap) once residency
    // has plateaued at it — see the liveLoadRadius option doc.
    const liveRadius = this.#opts.liveLoadRadius?.() ?? Infinity;
    if (
      liveRadius < settleRadius &&
      resident >= liveRadius - 0.5 &&
      now - this.#lastGrowthAt > CAPPED_RADIUS_QUIET_MS
    ) {
      settleRadius = liveRadius;
    }
    if (this.#settleTarget === 0 && resident >= settleRadius - 0.5) {
      this.#settleTarget = Math.min(resident, SETTLE_CAP) + SETTLE_OVERSHOOT;
      return;
    }

    // Stall nudge: staged expansion is admission-gated (quiet windows, boot
    // arrival completion). If the player keeps moving those gates can stay
    // shut indefinitely — past the deadline, kick the next stage directly.
    if (
      this.#settleTarget === 0 &&
      now - this.#lastGrowthAt > STALL_MS &&
      now - this.#lastNudgeAt > STALL_MS
    ) {
      this.#lastNudgeAt = now;
      // No-op unless a settled visual prime is still holding the draw ring at
      // the destination minimum (the same release bootArrivalTick performs on
      // arrival completion).
      this.#opts.tiles.resumeBackgroundStreaming();
      const dbg = this.#opts.tiles.backgroundStreamingDebug;
      if (dbg.radius < settleRadius) this.#opts.onExpansionStalled?.();
    }
  }
}
