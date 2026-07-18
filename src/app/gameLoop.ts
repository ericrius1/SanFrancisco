// Per-frame dispatch skeleton — extracted from main.ts's inline `tick()` per
// docs/MAIN_DECOMPOSITION.md step 2.
//
// This module owns the frame ORDER and pacing, not the frame CONTENT:
//   • the forcedDt/frameDt contract (deterministic capture drives tick(1/60));
//   • the reduced-tick DISPATCH (reading-overlay freeze → global keys → minimap
//     → the paused/frozen branches → the live frame);
//   • the tracer phase brackets ("physics" / "world" / "sched" / "render") whose
//     names hitch attribution and the perf probes depend on — they MUST stay
//     byte-identical;
//   • the frameBudget scheduler.run pacing for the live path and the render call.
//
// The frame BODY stays in main.ts as a small set of ordered, named callbacks
// (GameLoopHooks). main's tick body is one ~1300-line closure whose ~28 mutable
// frame vars (paused, elapsed, accumulator, initialArrival*, …) are shared with
// ~15 other main closures (settleTick, updateGhostShip, exitImmersive, the pause
// toggle, __sfManual, the reveal path). Relocating the body would mean threading
// all of that shared mutable state across the module boundary — the "big risky"
// path docs/MAIN_DECOMPOSITION.md defers. Instead the hooks are plain closures
// over main's scope, so there is zero state threading and zero behavior change.
import type { FrameScheduler } from "../core/frameBudget";
import { tracer } from "../core/hitchTracer";

/** A frame that a reduced-tick branch fully handled (already rendered, or a
 *  render-suppressed freeze) short-circuits the live path. */
type FrameDisposition = "handled" | "live";

/**
 * The frame body, provided by main.ts as ordered closures over its scope. Each
 * method maps to a contiguous span of the original inline tick, keeping the
 * exact call order and side effects.
 */
export interface GameLoopHooks {
  /** Before the clock advances: commit any queued HMR factories at the frame
   *  boundary (never mid-simulation). */
  onFrameStart(): void;
  /** After frameDt is known: the always-run prologue that every branch shares
   *  (audio engine, background-admission motion note, gamepad + scripted-driver
   *  polls, minigame-session frame open). */
  beginFrame(frameDt: number): void;
  /** Reading overlay (behind-the-scenes / Canticle book) open during play:
   *  freeze the world with no sim and no render. */
  readingFrozen(): boolean;
  /** input.endFrame() only — the reading-freeze exit renders nothing. */
  endInputOnly(): void;
  /** Global toggles (P/‌/‌I/Tab/M) plus the shared wall-clock ghost-ship route,
   *  which must run before the minimap branch reads its expanded state. */
  globalKeysAndGhost(frameDt: number): void;
  /** Whether the expanded city map owns this frame (fully frozen world). */
  minimapOpen(): boolean;
  /** The expanded-map branch: pad pan/zoom/teleport, social keepalive, map +
   *  hero-map update, then input.endFrame() and its own render. */
  runMinimapFrame(frameDt: number): void;
  /** Site wake/sleep + minigame precompute, then the two paused branches
   *  (full freeze, and world-frozen/player-live). Returns "handled" when a
   *  paused branch rendered this frame, else "live" to run the live path. */
  preSimulate(frameDt: number): FrameDisposition;
  /** Live path input: mode/tool/teleport keys, interact chain, click-tool fire,
   *  time scrub, fly steering + latched jumps, ending at chase.lookDir. Also
   *  advances the world clock (elapsed/accumulator). */
  liveInput(frameDt: number): void;
  /** Fixed-step physics accumulation (player.update + physics.step loop). */
  simulate(frameDt: number): void;
  /** The full world update: remotes, streaming, regions, activities, audio,
   *  camera commit, water/fx, entity proxies, cursor, HUD/debug. */
  updateWorld(frameDt: number): void;
  /** Post-scheduler drain: initial-arrival reveal release + settle tick. */
  postSchedule(frameDt: number): void;
  /** minigameSession.endFrame() + input.endFrame() before the render. */
  endFrameInput(): void;
  /** The render call (renderFrame). */
  render(): void;
  /** diagnostics.updateStats() after the frame is on screen. */
  afterRender(): void;
}

export interface GameLoopDeps {
  timer: { update(): void; getDelta(): number };
  scheduler: FrameScheduler;
  /** True once the loading cover is gone; gates the scheduler budget. */
  isRevealed(): boolean;
  hooks: GameLoopHooks;
}

/**
 * Build the `tick(forcedDt?)` closure the frame driver (and probes, via
 * `window.__sf.tick`) call. The signature and forcedDt semantics are preserved
 * exactly: a manual/deterministic tick passes its own dt; the wall-clock loop
 * passes nothing and the clamped THREE.Timer delta is used.
 */
export function createGameLoop(deps: GameLoopDeps): (forcedDt?: number) => void {
  const { timer, scheduler, isRevealed, hooks } = deps;

  return (forcedDt?: number) => {
    // HMR factories are queued by Vite's socket callback and committed only at
    // this frame boundary, never halfway through simulation/render work.
    hooks.onFrameStart();
    timer.update();
    const frameDt = forcedDt ?? Math.min(timer.getDelta(), 0.09);
    hooks.beginFrame(frameDt);

    // Reading overlay open during play: freeze the world completely (no sim, no
    // render); the canvas keeps its last frame behind the DOM overlay.
    if (hooks.readingFrozen()) {
      hooks.endInputOnly();
      return;
    }

    // Global toggles + the shared ghost-ship route run before the minimap check,
    // since M (handled here) can open/close the expanded map this same frame.
    hooks.globalKeysAndGhost(frameDt);

    // Expanded city map: world + player fully frozen; the branch renders itself.
    if (hooks.minimapOpen()) {
      hooks.runMinimapFrame(frameDt);
      return;
    }

    // Site/minigame precompute + the paused branches. "handled" means a reduced
    // tick already rendered (full freeze, or world-frozen/player-live pause).
    if (hooks.preSimulate(frameDt) === "handled") return;

    // ---- Live frame ----
    hooks.liveInput(frameDt);

    tracer.begin("physics");
    hooks.simulate(frameDt);
    tracer.end("physics");

    tracer.begin("world");
    hooks.updateWorld(frameDt);
    tracer.end("world");

    // Drain deferred bursty work under a headroom-scaled budget: fast frames
    // catch up, tight frames yield. Behind the opaque loading cover nothing is
    // visible, so the budget jumps to 24 ms/frame and the settle gate re-checks.
    tracer.begin("sched");
    scheduler.run(isRevealed() ? (frameDt < 1 / 55 ? 3 : frameDt < 1 / 35 ? 1.5 : 0.8) : 24);
    hooks.postSchedule(frameDt);
    tracer.end("sched");

    hooks.endFrameInput();

    tracer.begin("render");
    hooks.render();
    tracer.end("render");

    hooks.afterRender();
  };
}
