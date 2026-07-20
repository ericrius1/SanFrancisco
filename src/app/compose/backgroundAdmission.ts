// Post-reveal background-work admission: optional regions, shader warmups and
// far decodes wait for a genuinely quiet user window (no arrival in flight, no
// movement intent, staged one at a time). Extracted from main.ts per
// docs/MAIN_DECOMPOSITION.md: pure pacing state + waiters, no scene ownership.
import type { Input } from "../../core/input";
import type { Player } from "../../player/player";

const WORLD_BACKGROUND_BOOT_QUIET_MS = 5000;
const WORLD_BACKGROUND_AFTER_ARRIVAL_MS = 3000;
const WORLD_BACKGROUND_AFTER_MOTION_MS = 1800;
const WORLD_BACKGROUND_STAGE_GAP_MS = 320;
const WORLD_BACKGROUND_MOVEMENT_KEYS = [
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "KeyQ", "KeyU", "ShiftLeft", "ShiftRight", "Space"
] as const;

/**
 * Background expansion waits for a quiet interval after every arrival. This
 * keeps nonessential region constructors, shader warmups and far-tile decodes
 * from competing with the destination's one-to-four visual cells.
 */
export function createBackgroundAdmission({
  input,
  player,
  isArrivalActive
}: {
  input: Input;
  player: Player;
  isArrivalActive: () => boolean;
}): {
  /** Once per tick: movement intent or displacement pushes the quiet window back. */
  noteMotion: () => void;
  /** Resolves at the next admitted quiet stage (idle + one presentation frame).
   * `deadline` caps the wait: past it, admission happens even while moving. */
  waitForWindow: (extraQuietMs?: number, deadline?: number) => Promise<void>;
  /** Critical substrate expansion may run once the point/dawn handoff ends,
   * while the fog wall still covers the outer fill. */
  waitForStreamingWindow: (extraQuietMs?: number, deadline?: number) => Promise<void>;
  /** Arrival began: re-anchor motion and hold background work for a fixed beat. */
  onArrivalStart: () => void;
  /** Never admit before now+quietMs (keeps any later deadline already set). */
  deferAtLeast: (quietMs: number) => void;
  nextPresentationFrame: () => Promise<void>;
  /** CityGen's gentler gate: yield frames across arrivals, never require idling. */
  waitForCityGenRenderWindow: (isCurrent?: () => boolean) => Promise<boolean>;
  /** Late-bind the reveal phase machine (constructed after this coordinator). */
  setRevealLifecycle: (lifecycle: { fabricHeld(): boolean; settled(): boolean }) => void;
} {
  let revealFabricHeld = () => false;
  let revealSettled = () => true;
  let worldBackgroundNotBefore = performance.now() + WORLD_BACKGROUND_BOOT_QUIET_MS;
  let worldBackgroundAdmissionAt = worldBackgroundNotBefore;
  let worldBackgroundMotionX = player.position.x;
  let worldBackgroundMotionZ = player.position.z;
  const noteMotion = () => {
    if (isArrivalActive()) return;
    const pad = input.mapPadAxes();
    const hasMovementIntent =
      WORLD_BACKGROUND_MOVEMENT_KEYS.some((code) => input.holding(code)) ||
      Math.abs(pad.lx) > 0.08 ||
      Math.abs(pad.ly) > 0.08 ||
      pad.lt > 0.08 ||
      pad.rt > 0.08;
    if (hasMovementIntent) {
      // A blocked wheel, a vehicle against a wall, or an airborne embodiment
      // can have near-zero displacement while the player is still actively
      // trying to move. Treat intent as activity too, so optional constructors
      // and WebGPU compilation never mistake that moment for idle time.
      worldBackgroundNotBefore = Math.max(
        worldBackgroundNotBefore,
        performance.now() + WORLD_BACKGROUND_AFTER_MOTION_MS
      );
      return;
    }
    if (Math.hypot(
      player.position.x - worldBackgroundMotionX,
      player.position.z - worldBackgroundMotionZ
    ) < 1.5) return;
    worldBackgroundMotionX = player.position.x;
    worldBackgroundMotionZ = player.position.z;
    worldBackgroundNotBefore = Math.max(
      worldBackgroundNotBefore,
      performance.now() + WORLD_BACKGROUND_AFTER_MOTION_MS
    );
  };
  const onArrivalStart = () => {
    worldBackgroundMotionX = player.position.x;
    worldBackgroundMotionZ = player.position.z;
    worldBackgroundNotBefore = performance.now() + WORLD_BACKGROUND_AFTER_ARRIVAL_MS;
  };
  const deferAtLeast = (quietMs: number) => {
    worldBackgroundNotBefore = Math.max(worldBackgroundNotBefore, performance.now() + quietMs);
  };
  /** `deadline` caps only the quiet/motion wait. Arrival and reveal lifecycle
   * gates remain hard: optional work must never interrupt the authored handoff. */
  const waitForWindowWithGate = async (
    lifecycleBlocked: () => boolean,
    extraQuietMs = 0,
    deadline = Infinity,
    postLifecycleQuietMs = 0,
  ): Promise<void> => {
    while (true) {
      if (lifecycleBlocked() && postLifecycleQuietMs > 0) {
        // Keep sliding the quiet edge while the point/fog reveal is active.
        // When it finally settles, optional work gets a genuine calm beat
        // instead of waking as a thundering herd on the very next frame.
        deferAtLeast(postLifecycleQuietMs);
      }
      const target = Math.min(
        Math.max(worldBackgroundNotBefore + extraQuietMs, worldBackgroundAdmissionAt),
        deadline
      );
      if (!isArrivalActive() && !lifecycleBlocked() && performance.now() >= target) {
        await new Promise<void>((resolve) => {
          if ("requestIdleCallback" in window) {
            window.requestIdleCallback(() => resolve(), { timeout: 1000 });
          } else {
            setTimeout(resolve, 80);
          }
        });
        if (
          !isArrivalActive() &&
          !lifecycleBlocked() &&
          (performance.now() >= deadline ||
            (performance.now() >= worldBackgroundNotBefore + extraQuietMs &&
              performance.now() >= worldBackgroundAdmissionAt))
        ) {
          // Concurrent optional systems used to all wake from the same idle
          // callback and begin expensive constructors together. Admit one stage
          // at a time with a small presentation gap; quality is unchanged and
          // every stage still loads, just without a post-reveal thundering herd.
          worldBackgroundAdmissionAt = performance.now() + WORLD_BACKGROUND_STAGE_GAP_MS;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          return;
        }
      }
      const remaining = Math.max(16, Math.min(100, target - performance.now()));
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  };
  const waitForWindow = (extraQuietMs = 0, deadline = Infinity) =>
    waitForWindowWithGate(
      () => !revealSettled(),
      extraQuietMs,
      deadline,
      WORLD_BACKGROUND_AFTER_ARRIVAL_MS,
    );
  const waitForStreamingWindow = (extraQuietMs = 0, deadline = Infinity) =>
    waitForWindowWithGate(revealFabricHeld, extraQuietMs, deadline);
  const nextPresentationFrame = () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  /**
   * CityGen is an enhancement over the complete baked city. Each non-cancellable
   * driver preparation therefore waits for the reveal to settle AND for a real
   * quiet window; if motion begins, at most the one already-admitted owner can
   * finish before the sequence pauses again.
   * A per-cell generation predicate lets a teleport cancel an old owner before
   * its non-cancellable compileAsync call begins.
   */
  const waitForCityGenRenderWindow = async (isCurrent?: () => boolean): Promise<boolean> => {
    while (isArrivalActive() || !revealSettled()) {
      if (isCurrent && !isCurrent()) return false;
      deferAtLeast(WORLD_BACKGROUND_AFTER_ARRIVAL_MS);
      await nextPresentationFrame();
    }
    if (isCurrent && !isCurrent()) return false;
    await waitForWindow();
    return !isCurrent || isCurrent();
  };
  const setRevealLifecycle = (lifecycle: { fabricHeld(): boolean; settled(): boolean }) => {
    revealFabricHeld = lifecycle.fabricHeld;
    revealSettled = lifecycle.settled;
  };
  return {
    noteMotion,
    waitForWindow,
    waitForStreamingWindow,
    onArrivalStart,
    deferAtLeast,
    nextPresentationFrame,
    waitForCityGenRenderWindow,
    setRevealLifecycle
  };
}
