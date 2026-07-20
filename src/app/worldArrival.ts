import type { ChaseCamera } from "../core/camera";
import type { Input } from "../core/input";
import type { Physics } from "../core/physics";
import type { Player } from "../player/player";
import type { TileStreamer, TileVisualPrime, TileVisualPrimeResult } from "../world/tiles";
import { nextWorldFrame, WorldTransitionView } from "./worldTransition";

export type WorldArrivalState =
  | "idle"
  | "resolving"
  | "committing"
  | "loading-visuals"
  | "visual-blocked"
  | "visually-ready"
  | "loading-collision"
  | "collision-blocked";

export type ResolvedWorldArrival = {
  x: number;
  y?: number;
  z: number;
  cameraYaw: number;
  commit: () => void;
};

/**
 * Optional visual streamers that already exist in the live world (foliage,
 * authored regions, and future activity scenery) can join the same covered
 * destination prime as baked tiles. Participants are enhancements: a failure
 * is logged and the fixed-quality baked destination remains the visual
 * fallback, while an AbortSignal lets latest-wins navigation discard stale
 * preparation promptly.
 */
export type DestinationVisualPreparer = (
  destination: Readonly<ResolvedWorldArrival>,
  signal: AbortSignal
) => void | Promise<void>;

export type WorldArrivalPlan = {
  label?: string;
  /** Explicit teleports replay the point-scan arrival even when the destination
   * is already resident. Mode handoffs omit this and keep their local path. */
  replayPointReveal?: boolean;
  resolve: (signal: AbortSignal) => Promise<ResolvedWorldArrival>;
  onCommitted?: () => void;
  onInteractive?: () => void;
  onVisualBlocked?: (error: Error) => void;
  onCollisionBlocked?: (error: Error) => void;
  onError?: (error: unknown) => void;
};

export type WorldArrivalSnapshot = {
  generation: number;
  state: WorldArrivalState;
  active: boolean;
  visualMs: number | null;
  interactiveMs: number | null;
  collision: ReturnType<Physics["collisionArrivalStatus"]> | null;
};

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
const ARRIVAL_HOLD = "world-arrival";
const COLLISION_BLOCKED_AFTER_MS = 12_000;
const COLLISION_RETRY_CYCLES = 1;
const REQUIRED_VISUAL_TIMEOUT_MS = 18_000;
// M7 far arrivals reveal on the destination's CPU ground carpet instead of the
// full visual settle. Ground is a few frames of clipmap work; if it has not
// converged in this long something is genuinely wrong and the arrival fails
// closed through the same visual-blocked path as a near arrival.
const FAR_GROUND_TIMEOUT_MS = 15_000;
// Supplemental scenery is deliberately non-critical. A renderer/compiler bug
// must never keep the opaque travel cover up forever when the baked local tiles
// are already a valid fixed-quality destination.
const SUPPLEMENTAL_VISUAL_TIMEOUT_MS = 8_000;

class DestinationVisualError extends Error {}

/**
 * One latest-wins transaction for map teleports, history, tutorial jumps and
 * future portal/link arrivals. Visual readiness and movement safety are
 * deliberately separate milestones: the destination is revealed first, while
 * the pinned player waits for only the local collision bubble.
 */
export class WorldArrivalCoordinator {
  onStateChange: (snapshot: WorldArrivalSnapshot) => void = () => {};

  #input: Input;
  #player: Player;
  #chase: ChaseCamera;
  #tiles: TileStreamer;
  #physics: Physics;
  #prepareRequiredDestinationVisuals: DestinationVisualPreparer | null;
  #prepareDestinationVisuals: DestinationVisualPreparer | null;
  #classifyFarArrival: ((x: number, z: number) => boolean) | null;
  #onFarArrivalCut: ((x: number, z: number) => void) | null;
  #destinationRequiresAuthoredFloor: ((x: number, z: number) => boolean) | null;
  #waitForRenderIdle: (() => Promise<void>) | null;
  #view = new WorldTransitionView();
  #generation = 0;
  #abort: AbortController | null = null;
  #state: WorldArrivalState = "idle";
  #startedAt = 0;
  #visualAt: number | null = null;
  #interactiveAt: number | null = null;
  #collisionEpoch: number | null = null;
  #unsafeCollisionEpoch: number | null = null;
  #unsafeVisualReady = false;

  constructor(options: {
    input: Input;
    player: Player;
    chase: ChaseCamera;
    tiles: TileStreamer;
    physics: Physics;
    prepareRequiredDestinationVisuals?: DestinationVisualPreparer;
    prepareDestinationVisuals?: DestinationVisualPreparer;
    /**
     * M7: true when the destination lies beyond current residency (content
     * there is not attached). Far arrivals hold the opaque cover only for the
     * cut itself: they reveal the moment the destination's CPU ground carpet
     * is ready and let the materialize front sweep content in as it streams.
     * Called with the RESOLVED destination while the player is still at the
     * origin (pre-commit). Absent → every arrival uses the near path.
     */
    classifyFarArrival?: (x: number, z: number) => boolean;
    /**
     * M7: fired once right after a FAR arrival commits under the cover —
     * main.ts recenters the ring coordinator's materialize front here
     * (`focus(x, z, { reset: true, prime: false })`; the arrival already
     * primed tiles/regions/collision through its own epoch-guarded path).
     */
    onFarArrivalCut?: (x: number, z: number) => void;
    /**
     * M9: true when the destination sits on an authored region that owns
     * terrain (a groundTop-overlay floor handoff). A far arrival there must
     * keep the cover until THAT region's prime finishes: releasing the player
     * onto the CPU carpet and installing the overlay a beat later pops them
     * vertically. All other visuals stay detached on the far path.
     */
    destinationRequiresAuthoredFloor?: (x: number, z: number) => boolean;
    /** Drain a non-cancellable GPU compile already admitted before the travel
     * cover painted, so the destination point scan starts on a clear renderer. */
    waitForRenderIdle?: () => Promise<void>;
  }) {
    this.#input = options.input;
    this.#player = options.player;
    this.#chase = options.chase;
    this.#tiles = options.tiles;
    this.#physics = options.physics;
    this.#prepareRequiredDestinationVisuals = options.prepareRequiredDestinationVisuals ?? null;
    this.#prepareDestinationVisuals = options.prepareDestinationVisuals ?? null;
    this.#classifyFarArrival = options.classifyFarArrival ?? null;
    this.#onFarArrivalCut = options.onFarArrivalCut ?? null;
    this.#destinationRequiresAuthoredFloor = options.destinationRequiresAuthoredFloor ?? null;
    this.#waitForRenderIdle = options.waitForRenderIdle ?? null;
  }

  get active(): boolean {
    return this.#state !== "idle";
  }

  get snapshot(): WorldArrivalSnapshot {
    return {
      generation: this.#generation,
      state: this.#state,
      active: this.active,
      visualMs: this.#visualAt == null ? null : this.#visualAt - this.#startedAt,
      interactiveMs: this.#interactiveAt == null ? null : this.#interactiveAt - this.#startedAt,
      collision: this.#collisionEpoch == null
        ? null
        : this.#physics.collisionArrivalStatus(this.#collisionEpoch)
    };
  }

  async arrive(plan: WorldArrivalPlan): Promise<boolean> {
    const priorUnsafeEpoch = this.#unsafeCollisionEpoch;
    const priorUnsafeVisualReady = this.#unsafeVisualReady;
    this.#abort?.abort();
    const controller = new AbortController();
    this.#abort = controller;
    const generation = ++this.#generation;
    this.#startedAt = performance.now();
    this.#visualAt = null;
    this.#interactiveAt = null;
    this.#collisionEpoch = null;
    this.#input.setSuspensionHold(ARRIVAL_HOLD, true);
    this.#player.holdForWorldArrival(ARRIVAL_HOLD);
    this.#setState("resolving");
    const coverPainted = this.#view.show(generation, plan.label);
    let committed = false;
    let preparedEpoch: number | null = null;

    try {
      const [, destination] = await Promise.all([coverPainted, plan.resolve(controller.signal)]);
      if (!this.#isCurrent(generation, controller)) return false;
      // The cover is now painted and input is held. Finish at most the compile
      // that had already begun before the request, then cut/restart the point
      // reveal. Optional compilation admission sees this arrival as active and
      // cannot start another owner behind the wait.
      await this.#waitForRenderIdle?.();
      if (!this.#isCurrent(generation, controller)) return false;

      // Begin both independent streams, then atomically commit under the opaque
      // cover. Fixed steps now drain destination physics while the visual prime
      // attaches only its one-to-four local cells.
      const visualPrime = this.#tiles.primeAt(destination.x, destination.z);
      const collisionEpoch = this.#physics.prepareCollisionArrival(destination);
      const requiredVisuals = Promise.resolve().then(() =>
        this.#prepareRequiredDestinationVisuals?.(destination, controller.signal)
      );
      const supplementalVisuals = this.#prepareSupplementalVisuals(destination, controller, generation);
      preparedEpoch = collisionEpoch;
      this.#collisionEpoch = collisionEpoch;
      // Classify while the player is still at the origin: "far" means the
      // destination is beyond current residency, so the cover holds only for
      // the cut and the materialize sweep plays the streaming instead.
      const far = plan.replayPointReveal === true ||
        (this.#classifyFarArrival?.(destination.x, destination.z) ?? false);
      this.#setState("committing");
      if (!this.#physics.activateCollisionArrival(collisionEpoch)) {
        throw new Error("Collision arrival was superseded before commit");
      }
      // Mark the destination unsafe before calling user code. A commit callback
      // can partially relocate and then throw; fail closed in that case rather
      // than releasing gravity into an unprepared world.
      this.#unsafeCollisionEpoch = collisionEpoch;
      this.#unsafeVisualReady = false;
      committed = true;
      destination.commit();
      this.#chase.yaw = destination.cameraYaw;
      this.#chase.cutTo(this.#player);
      this.#callSafely(plan.onCommitted, "onCommitted");
      if (far) {
        // Recenter the materialize front at the cut moment: generation bump
        // aborts any in-flight sweep (boot or a prior teleport), the front
        // collapses at the destination and chases residency exactly like boot.
        this.#callSafely(
          this.#onFarArrivalCut
            ? () => this.#onFarArrivalCut?.(destination.x, destination.z)
            : undefined,
          "onFarArrivalCut"
        );
      }

      this.#setState("loading-visuals");
      if (far) {
        // Far arrival: the destination reveals as holo-terrain void once its
        // CPU ground carpet is ready — a few frames, not the full visual
        // settle. The tile/region/supplemental primes keep running in the
        // background; the ring coordinator sweeps their content in as it
        // attaches. Rejections must not become unhandled, and a failed
        // required region is only a warning here (the holo terrain + sweep is
        // the destination's visual floor, exactly like boot's void).
        void Promise.allSettled([visualPrime.ready, requiredVisuals, supplementalVisuals])
          .then(([, required]) => {
            if (required.status === "rejected" && this.#isCurrent(generation, controller)) {
              console.warn("[arrival] far-destination authored region unavailable", required.reason);
            }
          });
        if (!await this.#waitForDestinationGround(collisionEpoch, generation, controller)) {
          return false;
        }
        // M9: a far destination ON an authored floor handoff (groundTop
        // overlay) additionally waits for the required-region prime — the
        // overlay is the ground authority there, and revealing on the CPU
        // carpet would pop the player up when the overlay installs a beat
        // later. Only the required regions wait; tile prime + supplemental
        // scenery stay detached (the sweep is still their reveal).
        if (this.#destinationRequiresAuthoredFloor?.(destination.x, destination.z)) {
          await this.#waitForRequiredFloorRegion(requiredVisuals);
          if (!this.#isCurrent(generation, controller)) return false;
        }
      } else {
        const visual = await this.#waitForDestinationVisuals(
          visualPrime,
          requiredVisuals,
          supplementalVisuals
        );
        if (!this.#isCurrent(generation, controller)) return false;
        if (visual.status === "failed") {
          throw new DestinationVisualError("Destination visuals could not be loaded");
        }
        if (visual.status !== "ready") {
          throw new DestinationVisualError("Destination visuals were superseded");
        }
      }

      // Let the normal animation loop draw one destination frame while the
      // cover is still opaque; only then begin the reveal.
      await nextWorldFrame();
      if (!this.#isCurrent(generation, controller)) return false;
      this.#visualAt = performance.now();
      this.#unsafeVisualReady = true;
      this.#setState("visually-ready");
      const revealDone = this.#view.hide(generation);

      this.#setState("loading-collision");
      if (!await this.#waitForCollision(collisionEpoch, generation, controller, plan)) return false;
      // Collision and the short visual reveal overlap, but controls remain held
      // until both are finished. Otherwise cached collision can move the player
      // under the still-fading cover and make the first visible camera pose jump.
      await revealDone;
      if (!this.#isCurrent(generation, controller)) return false;
      // A real terrain tile can install during the 180 ms cover fade. That
      // increments the ground revision and deliberately invalidates the local
      // carpet/patch for a frame or two. Re-converge here instead of treating
      // that normal destination refinement as a terminal collision failure.
      if (!this.#physics.isCollisionArrivalReady(collisionEpoch)) {
        this.#setState("loading-collision");
        if (!await this.#waitForCollision(collisionEpoch, generation, controller, plan)) return false;
      }
      if (!this.#physics.completeCollisionArrival(collisionEpoch)) {
        throw new Error("Destination collision changed before interaction release");
      }

      this.#interactiveAt = performance.now();
      if (this.#unsafeCollisionEpoch === collisionEpoch) this.#unsafeCollisionEpoch = null;
      this.#unsafeVisualReady = false;
      this.#collisionEpoch = null;
      this.#player.releaseWorldArrivalHold(ARRIVAL_HOLD);
      this.#input.setSuspensionHold(ARRIVAL_HOLD, false);
      // Let completion observers of the prime's ready promise run before its
      // required-only hold is released. This preserves a precise ready→release
      // lifecycle for diagnostics and downstream ownership hooks.
      await Promise.resolve();
      this.#tiles.resumeBackgroundStreaming();
      // Publish idle only after the generation-owned visual prime is released.
      // An observer may synchronously start the next teleport from this event;
      // it must never be followed by the previous arrival resuming that new
      // destination's required-only stream.
      this.#setState("idle");
      this.#callSafely(plan.onInteractive, "onInteractive");
      if (new URLSearchParams(location.search).has("profile")) {
        const snapshot = this.snapshot;
        console.info(
          `[arrival] ${plan.label ?? "destination"}: visual ${Math.round(snapshot.visualMs ?? 0)}ms, ` +
          `interactive ${Math.round(snapshot.interactiveMs ?? 0)}ms${far ? " (far cut)" : ""}`
        );
      }
      return true;
    } catch (error) {
      if (!this.#isCurrent(generation, controller) || isAbort(error)) return false;
      console.warn("[arrival] transition failed", error);
      const visualBlocked = error instanceof DestinationVisualError;
      if (visualBlocked) {
        this.#callSafely(
          plan.onVisualBlocked ? () => plan.onVisualBlocked?.(error) : undefined,
          "onVisualBlocked"
        );
      } else {
        this.#callSafely(plan.onError ? () => plan.onError?.(error) : undefined, "onError");
      }

      if (committed || preparedEpoch !== null && priorUnsafeEpoch !== null) {
        // The body may already be at a destination whose collision is not ready,
        // or preparation may have superseded an earlier unsafe destination. Keep
        // both holds. The user can issue a new latest-wins arrival, but gravity
        // and interactions remain fail-closed.
        const priorWasVisuallyUnsafe = !committed && !priorUnsafeVisualReady;
        const blockedState = visualBlocked || priorWasVisuallyUnsafe
          ? "visual-blocked"
          : "collision-blocked";
        this.#setState(blockedState);
        this.#view.setStage(
          generation,
          blockedState === "visual-blocked"
            ? "Destination visuals need another try"
            : "Destination needs another try"
        );
        void this.#view.hide(generation);
        return false;
      }

      // Resolution failed before any world mutation. If it superseded an
      // already-committed arrival, resume that collision wait instead of
      // accidentally releasing its safety hold.
      if (priorUnsafeEpoch !== null && this.#physics.collisionArrivalStatus(priorUnsafeEpoch).current) {
        this.#unsafeCollisionEpoch = priorUnsafeEpoch;
        this.#collisionEpoch = priorUnsafeEpoch;
        const recoveryRevealDone = this.#view.hide(generation);
        if (!priorUnsafeVisualReady) {
          this.#unsafeVisualReady = false;
          await recoveryRevealDone;
          if (this.#isCurrent(generation, controller)) this.#setState("visual-blocked");
          return false;
        }
        this.#unsafeVisualReady = true;
        this.#setState("loading-collision");
        try {
          if (await this.#waitForCollision(priorUnsafeEpoch, generation, controller, {})) {
            await recoveryRevealDone;
            if (!this.#isCurrent(generation, controller)) return false;
            if (!this.#physics.completeCollisionArrival(priorUnsafeEpoch)) {
              throw new Error("Prior destination collision changed before recovery release");
            }
            this.#unsafeCollisionEpoch = null;
            this.#unsafeVisualReady = false;
            this.#collisionEpoch = null;
            this.#player.releaseWorldArrivalHold(ARRIVAL_HOLD);
            this.#input.setSuspensionHold(ARRIVAL_HOLD, false);
            await Promise.resolve();
            this.#tiles.resumeBackgroundStreaming();
            this.#setState("idle");
          }
        } catch (recoveryError) {
          if (this.#isCurrent(generation, controller)) {
            console.warn("[arrival] prior collision recovery failed closed", recoveryError);
            this.#setState("collision-blocked");
          }
        }
        return false;
      }

      void this.#view.hide(generation);
      this.#unsafeCollisionEpoch = null;
      this.#unsafeVisualReady = false;
      this.#player.releaseWorldArrivalHold(ARRIVAL_HOLD);
      this.#input.setSuspensionHold(ARRIVAL_HOLD, false);
      this.#tiles.resumeBackgroundStreaming();
      this.#setState("idle");
      return false;
    }
  }

  cancel(): void {
    const generation = this.#generation;
    this.#abort?.abort();
    this.#abort = null;
    void this.#view.hide(generation);
    this.#generation++;
    const unsafe = this.#unsafeCollisionEpoch;
    if (unsafe !== null && !this.#unsafeVisualReady) {
      this.#setState("visual-blocked");
      return;
    }
    if (unsafe !== null && !this.#physics.isCollisionArrivalReady(unsafe)) {
      this.#setState("collision-blocked");
      return;
    }
    if (unsafe !== null && !this.#physics.completeCollisionArrival(unsafe)) {
      this.#setState("collision-blocked");
      return;
    }
    this.#unsafeCollisionEpoch = null;
    this.#unsafeVisualReady = false;
    this.#collisionEpoch = null;
    this.#player.releaseWorldArrivalHold(ARRIVAL_HOLD);
    this.#input.setSuspensionHold(ARRIVAL_HOLD, false);
    this.#tiles.resumeBackgroundStreaming();
    this.#setState("idle");
  }

  dispose(): void {
    this.cancel();
    this.#view.dispose();
  }

  #isCurrent(generation: number, controller: AbortController): boolean {
    return generation === this.#generation && this.#abort === controller && !controller.signal.aborted;
  }

  #setState(state: WorldArrivalState): void {
    this.#state = state;
    this.onStateChange(this.snapshot);
  }

  async #waitForCollision(
    epoch: number,
    generation: number,
    controller: AbortController,
    plan: Pick<WorldArrivalPlan, "onCollisionBlocked">
  ): Promise<boolean> {
    const startedAt = performance.now();
    let reportedBlocked = false;
    let retryCycles = 0;
    while (this.#isCurrent(generation, controller)) {
      const status = this.#physics.collisionArrivalStatus(epoch);
      if (!status.current) throw new Error("Destination collision was superseded");
      if (status.ready) return true;
      if (status.failedColliderTiles > 0 && retryCycles < COLLISION_RETRY_CYCLES) {
        const restarted = this.#physics.retryCollisionArrival(epoch);
        if (restarted > 0) {
          retryCycles++;
          console.warn(`[arrival] retrying ${restarted} failed collision tile${restarted === 1 ? "" : "s"}`);
          await nextWorldFrame();
          continue;
        }
      }
      if (
        !reportedBlocked &&
        (status.failedColliderTiles > 0 || performance.now() - startedAt >= COLLISION_BLOCKED_AFTER_MS)
      ) {
        reportedBlocked = true;
        this.#setState("collision-blocked");
        const error = new Error(
          `Destination collision is still pending (${status.pendingColliderTiles} tiles, ` +
          `${status.failedColliderTiles} failed, ` +
          `${status.pendingBuildingBodies} bodies)`
        );
        console.warn("[arrival] collision remains fail-closed", error);
        this.#callSafely(
          plan.onCollisionBlocked ? () => plan.onCollisionBlocked?.(error) : undefined,
          "onCollisionBlocked"
        );
      }
      await nextWorldFrame();
    }
    return false;
  }

  /**
   * M7 far-arrival reveal milestone: only the destination's CPU ground carpet
   * (the same `groundReady` boot releases control on). Times out into the
   * fail-closed visual-blocked path; a superseded epoch throws so the shared
   * catch keeps the holds exactly as a superseded near arrival would.
   */
  async #waitForDestinationGround(
    epoch: number,
    generation: number,
    controller: AbortController
  ): Promise<boolean> {
    const startedAt = performance.now();
    while (this.#isCurrent(generation, controller)) {
      const status = this.#physics.collisionArrivalStatus(epoch);
      if (!status.current) throw new Error("Destination collision was superseded");
      if (status.groundReady) return true;
      if (performance.now() - startedAt >= FAR_GROUND_TIMEOUT_MS) {
        throw new DestinationVisualError(
          `Destination ground exceeded ${FAR_GROUND_TIMEOUT_MS}ms`
        );
      }
      await nextWorldFrame();
    }
    return false;
  }

  /**
   * M9 far-arrival authored-floor wait: bounds the required-region prime with
   * the same timeout/fail-closed semantics as the near path's visual wait
   * (failure → DestinationVisualError → visual-blocked, cover stays honest).
   */
  async #waitForRequiredFloorRegion(requiredVisuals: Promise<void>): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DestinationVisualError(
          `Destination authored floor exceeded ${REQUIRED_VISUAL_TIMEOUT_MS}ms`
        ));
      }, REQUIRED_VISUAL_TIMEOUT_MS);
    });
    try {
      await Promise.race([requiredVisuals, deadline]);
    } catch (error) {
      if (error instanceof DestinationVisualError) throw error;
      throw new DestinationVisualError(
        `Destination authored floor failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #callSafely(callback: (() => void) | undefined, label: string): void {
    if (!callback) return;
    try {
      callback();
    } catch (error) {
      console.warn(`[arrival] ${label} callback failed`, error);
    }
  }

  async #waitForDestinationVisuals(
    visualPrime: TileVisualPrime,
    requiredVisuals: Promise<void>,
    supplementalVisuals: Promise<void>
  ): Promise<TileVisualPrimeResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new DestinationVisualError(
          `Destination visuals exceeded ${REQUIRED_VISUAL_TIMEOUT_MS}ms`
        ));
      }, REQUIRED_VISUAL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.all([visualPrime.ready, requiredVisuals, supplementalVisuals]).then(([visual]) => visual),
        deadline
      ]);
    } catch (error) {
      if (error instanceof DestinationVisualError) throw error;
      throw new DestinationVisualError(
        `Required destination visuals failed: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #prepareSupplementalVisuals(
    destination: Readonly<ResolvedWorldArrival>,
    controller: AbortController,
    generation: number
  ): Promise<void> {
    if (!this.#prepareDestinationVisuals) return;
    const participantController = new AbortController();
    const abortParticipant = () => participantController.abort(controller.signal.reason);
    controller.signal.addEventListener("abort", abortParticipant, { once: true });
    let timedOut = false;
    let rejectDeadline!: (reason: Error) => void;
    const deadline = new Promise<never>((_resolve, reject) => { rejectDeadline = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(
        `Supplemental destination visuals exceeded ${SUPPLEMENTAL_VISUAL_TIMEOUT_MS}ms`
      );
      participantController.abort(error);
      rejectDeadline(error);
    }, SUPPLEMENTAL_VISUAL_TIMEOUT_MS);
    try {
      await Promise.race([
        this.#prepareDestinationVisuals(destination, participantController.signal),
        deadline
      ]);
    } catch (error) {
      if ((timedOut || !isAbort(error)) && this.#isCurrent(generation, controller)) {
        // Baked tile + terrain readiness remains the guaranteed visual floor.
        // Optional participant failure must never strand a player or turn a
        // cosmetic region into a movement-safety dependency.
        console.warn("[arrival] supplemental destination visuals unavailable", error);
      }
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", abortParticipant);
    }
  }
}
