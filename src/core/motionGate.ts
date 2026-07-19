// M11 stillness gate — "a long frame while the image is still is imperceptible".
//
// A held/long frame is only PERCEIVED as a hitch when the presented image was
// changing (camera pan, walk, drive): the freeze interrupts motion. While the
// player idles — and most players pause a beat right after gaining control —
// the same frozen frame shows an identical image and costs nothing perceptually.
// Deferrable-but-not-sliceable lumps (monster TSL compile windows, full
// static-shadow-domain redraws) therefore wait for VISUAL STILLNESS before
// running, with a bounded deadline so a player who never stops moving degrades
// to the pre-gate behavior instead of starving streaming.
//
// Stillness is derived purely from the render camera's world transform, sampled
// once per presented frame (pipeline.render). Player velocity, vehicle motion
// and look input all move the chase camera, so one signal covers them; the
// anchor-based comparison below also catches slow sub-frame drift that a
// frame-to-frame delta would miss. Zero allocation on the per-frame path.
//
// Deadline discipline: waiters get a per-window deadline, and a GLOBAL motion
// budget caps the TOTAL stall a continuously moving player can accumulate
// (refilled whenever stillness is reached). Once the budget drains, waits
// resolve immediately — worst case is the ungated behavior, never worse.

import * as THREE from "three/webgpu";

/** No camera movement for this long ⇒ visually still (hysteresis so a single
 *  mouse twitch doesn't flap the gate). */
const STILL_AFTER_MS = 300;
/** Anchor displacement that counts as movement. The chase camera can carry
 *  sub-centimeter simulation jitter while the player idles; these must be
 *  comfortably above that and comfortably below a real step/pan per frame. */
const POSITION_EPSILON_M = 0.05;
const POSITION_EPSILON_SQ = POSITION_EPSILON_M * POSITION_EPSILON_M;
/** Quaternion half-angle threshold: |dot| below cos(theta/2) counts as a
 *  rotation. 0.01 rad ≈ 0.57° of camera yaw/pitch. */
const ROTATION_EPSILON_RAD = 0.01;
const ROTATION_DOT_MIN = Math.cos(ROTATION_EPSILON_RAD / 2);
/** Total wait a continuously moving player can impose across ALL waiters
 *  before the gate falls open; refilled to full whenever stillness occurs. */
const MOTION_WAIT_BUDGET_MS = 12000;
/** Self-inflicted motion must not count: after a long held/blocked frame the
 *  simulation catches up in one step and the chase camera visibly jumps and
 *  re-converges for a few frames (measured 60-90 mm/frame for ~3 frames after
 *  a ~500 ms compile window) — with no player input at all. Counting that as
 *  movement un-stills the gate right after every monster window and drains the
 *  budget while the player idles (feedback loop). Movement detected within the
 *  grace period after a frame-delivery gap therefore re-anchors silently.
 *  Real input during the grace is re-detected at most one grace later. */
const STALL_GAP_MS = 90;
const POST_STALL_GRACE_MS = 250;

type Waiter = {
  deadlineAt: number;
  timer: ReturnType<typeof setTimeout>;
  abortWhen: (() => boolean) | null;
  resolve: (hiddenByStillness: boolean) => void;
};

class MotionGate {
  #anchorPosition = new THREE.Vector3();
  #anchorQuaternion = new THREE.Quaternion();
  #samplePosition = new THREE.Vector3();
  #sampleQuaternion = new THREE.Quaternion();
  #hasAnchor = false;
  // Before any sample, the world is a covered/static boot render: still.
  #lastMovementAt = -Infinity;
  #lastSampleAt = 0;
  #budgetMs = MOTION_WAIT_BUDGET_MS;
  #graceUntil = 0;
  #waiters: Waiter[] = [];

  /** Sample the presented camera once per rendered frame (zero allocation). */
  sampleFrame(camera: THREE.Camera, nowMs = performance.now()): void {
    if (nowMs - this.#lastSampleAt > STALL_GAP_MS) {
      this.#graceUntil = nowMs + POST_STALL_GRACE_MS;
      // Moving when frames stopped ⇒ assume the motion continued through the
      // gap (a forced window during a sprint must not flip the gate still);
      // idle when frames stopped ⇒ stillness keeps accruing and the grace
      // below absorbs the catch-up transient.
      if (this.#lastSampleAt - this.#lastMovementAt < STILL_AFTER_MS) {
        this.#lastMovementAt = nowMs;
      }
    }
    camera.getWorldPosition(this.#samplePosition);
    camera.getWorldQuaternion(this.#sampleQuaternion);
    if (!this.#hasAnchor) {
      this.#hasAnchor = true;
      this.#anchorPosition.copy(this.#samplePosition);
      this.#anchorQuaternion.copy(this.#sampleQuaternion);
    } else {
      const moved =
        this.#samplePosition.distanceToSquared(this.#anchorPosition) > POSITION_EPSILON_SQ;
      const rotated =
        Math.abs(this.#sampleQuaternion.dot(this.#anchorQuaternion)) < ROTATION_DOT_MIN;
      if (moved || rotated) {
        this.#anchorPosition.copy(this.#samplePosition);
        this.#anchorQuaternion.copy(this.#sampleQuaternion);
        // Post-stall catch-up transients re-anchor without stamping movement.
        if (nowMs >= this.#graceUntil) this.#lastMovementAt = nowMs;
      }
    }

    if (this.isStill(nowMs)) {
      // Stillness reached: the motion budget is earned back in full.
      this.#budgetMs = MOTION_WAIT_BUDGET_MS;
    } else if (this.#waiters.length > 0) {
      // Someone is being stalled by motion: drain the global budget.
      const dt = Math.max(0, Math.min(1000, nowMs - this.#lastSampleAt));
      this.#budgetMs = Math.max(0, this.#budgetMs - dt);
    }
    this.#lastSampleAt = nowMs;

    if (this.#waiters.length > 0) this.#flushWaiters(nowMs);
  }

  /** True when the camera has not moved for STILL_AFTER_MS. */
  isStill(nowMs = performance.now()): boolean {
    return nowMs - this.#lastMovementAt >= STILL_AFTER_MS;
  }

  /** Milliseconds since the last detected camera movement. */
  stillFor(nowMs = performance.now()): number {
    return nowMs - this.#lastMovementAt;
  }

  /** performance.now() of the last detected camera movement (-Infinity if never). */
  lastMovementAt(): number {
    return this.#lastMovementAt;
  }

  /** Remaining global motion-stall budget (QA/probe surface). */
  get budgetMs(): number {
    return this.#budgetMs;
  }

  /**
   * Resolve when the view is still (true) or after min(deadlineMs, remaining
   * motion budget) of continued motion (false). Immediate when already still
   * or when the budget is drained — the gate can only ever ADD bounded delay.
   * A timer backstop covers stalled frame delivery (hidden tab), where the
   * player cannot be moving anyway. `abortWhen` (checked once per sampled
   * frame) lets the caller bail early — e.g. when frames became held anyway,
   * so waiting can no longer hide anything.
   */
  waitForStillness(deadlineMs: number, abortWhen: (() => boolean) | null = null): Promise<boolean> {
    const now = performance.now();
    if (this.isStill(now)) return Promise.resolve(true);
    const allowedMs = Math.min(deadlineMs, this.#budgetMs);
    if (allowedMs <= 0 || abortWhen?.()) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: Waiter = {
        deadlineAt: now + allowedMs,
        timer: setTimeout(() => this.#resolveWaiter(waiter, false), allowedMs + 50),
        abortWhen,
        resolve
      };
      this.#waiters.push(waiter);
    });
  }

  #flushWaiters(nowMs: number): void {
    const still = this.isStill(nowMs);
    for (let i = this.#waiters.length - 1; i >= 0; i--) {
      const waiter = this.#waiters[i];
      if (still) this.#resolveWaiter(waiter, true);
      else if (nowMs >= waiter.deadlineAt || waiter.abortWhen?.()) {
        this.#resolveWaiter(waiter, false);
      }
    }
  }

  #resolveWaiter(waiter: Waiter, hiddenByStillness: boolean): void {
    const index = this.#waiters.indexOf(waiter);
    if (index === -1) return;
    this.#waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(hiddenByStillness);
  }
}

/** App-wide singleton: sampled by the render pipeline, consulted by deferrable
 *  heavy work (exclusive compile windows, static shadow redraws). */
export const motionGate = new MotionGate();

// QA hook: probes need the stillness timeline from the FIRST post-control
// frames, long before the full `__sf` debug registry exists (P3/P4). Mirrors
// the `__sfVoid` precedent; read-only surface, no gameplay coupling.
if (typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__sfMotionGate = motionGate;
}
