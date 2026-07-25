import type * as THREE from "three/webgpu";
import { RENDER_TUNING } from "../config";

type FrameTracer = {
  frame(frameMs: number): void;
  /** running EMA of frame dt (ms) */
  readonly ema: number;
};

export type FrameDriver = {
  setManual(enabled: boolean): void;
  /**
   * The entry point every deterministic/manual tick MUST use (probes, cinematic
   * capture, calibration). Identical to the wall-clock loop's tick except that
   * it advances the node frame token itself — see advanceNodeFrame below.
   */
  manualTick(forcedDt?: number): void;
  resize(): void;
  readonly debugState: {
    manual: boolean;
    pageVisible: boolean;
    loopRunning: boolean;
    ticks: number;
  };
  dispose(): void;
};

/** three's node frame token, reached through the renderer's private `_nodes`. */
type NodeFrameHost = { _nodes?: { nodeFrame?: { update(): void } } };

/**
 * Advance three's node frame token by hand.
 *
 * `PassNode.updateBeforeType` is `NodeUpdateType.FRAME`, so the post chain's
 * scene pass re-renders ONLY when `nodeFrame.frameId` changed since it last ran
 * (NodeFrame.updateBeforeNode). That token is bumped in exactly one place —
 * `Animation.start()`'s rAF callback (`nodes.nodeFrame.update()`) — which is
 * the renderer's own loop, NOT `renderer.render()`.
 *
 * A manual tick therefore composites without re-rendering the scene: the
 * post-processing pass runs, samples the PREVIOUS scene texture, and presents a
 * stale frame. It goes unnoticed whenever a manual tick loop happens to be slow
 * enough for rAF to interleave (or whenever something calls `compileAsync`,
 * which also bumps the token) — which is why cheaper frames made it visible.
 */
const advanceNodeFrame = (renderer: THREE.WebGPURenderer) => {
  (renderer as unknown as NodeFrameHost)._nodes?.nodeFrame?.update();
};

/**
 * Owns requestAnimationFrame/WebGPU animation-loop plumbing and viewport
 * lifecycle. The simulation remains an injected callback, so main.ts composes
 * the game while this module owns browser side effects and their cleanup.
 */
export function startFrameDriver(opts: {
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  app: HTMLElement;
  tick: (forcedDt?: number) => void;
  tracer: FrameTracer;
  isRevealed: () => boolean;
  /** Adaptive-resolution governor; only driven by the live rAF loop (never manual probe ticks). */
  adaptiveRes?: { update(emaMs: number): void };
}): FrameDriver {
  const { renderer, camera, app, tick, tracer, isRevealed, adaptiveRes } = opts;
  const throttleRaf = navigator.webdriver && !new URLSearchParams(location.search).has("fullfps");
  let lastLoop = performance.now();
  let manual = false;
  let pageVisible = document.visibilityState === "visible";
  let loopRunning = false;
  let ticks = 0;
  let quietParity = 0;

  const loop = () => {
    // setAnimationLoop(null) is the primary background gate. Keep this guard as
    // a hard backstop in case a queued callback crosses the visibility edge.
    if (!pageVisible || manual) return;
    // Battery/quiet mode: render every 2nd rAF (~30 fps). Skip the ENTIRE tick —
    // tick() derives its dt from a clamped wall-clock timer, so the next rendered
    // frame simply sees a ~33 ms delta (the same gap handling as a resumed tab).
    // Do NOT advance lastLoop on a skipped frame, so the tracer/governor measure
    // the true render-to-render interval on the frame that does run.
    const quiet = RENDER_TUNING.values.quietMode;
    if (quiet) {
      quietParity ^= 1;
      if (quietParity) return;
    } else {
      quietParity = 0;
    }
    const now = performance.now();
    if (throttleRaf && now - lastLoop < 50) return;
    const frameMs = now - lastLoop;
    lastLoop = now;
    ticks++;
    tick();
    if (isRevealed()) {
      tracer.frame(frameMs);
      // Quiet mode roughly doubles the render-to-render interval by design; feed
      // the governor the halved EMA so a capped-but-healthy frame reads as its
      // true per-frame cost and never triggers a spurious downscale.
      adaptiveRes?.update(quiet ? tracer.ema * 0.5 : tracer.ema);
    }
  };

  let keepAliveTimer: number | null = null;

  const stopKeepAlive = () => {
    if (keepAliveTimer === null) return;
    window.clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  };

  const syncKeepAlive = () => {
    // The dev watchdog recovers a stalled *visible* WebGPU loop. It must not
    // itself wake the app while the page is suspended.
    if (!import.meta.env.DEV || manual || !pageVisible) {
      stopKeepAlive();
      return;
    }
    if (keepAliveTimer !== null) return;
    keepAliveTimer = window.setInterval(() => {
      if (!manual && pageVisible && performance.now() - lastLoop > 250) {
        ticks++;
        tick(0.05);
      }
    }, 50);
  };

  const syncAnimationLoop = () => {
    const shouldRun = !manual && pageVisible;
    if (shouldRun !== loopRunning) {
      // Reset the wall-clock anchor when resuming so time spent hidden never
      // arrives as a giant simulation delta.
      if (shouldRun) lastLoop = performance.now();
      renderer.setAnimationLoop(shouldRun ? loop : null);
      loopRunning = shouldRun;
    }
    syncKeepAlive();
  };

  const setManual = (enabled: boolean) => {
    manual = enabled;
    syncAnimationLoop();
  };

  const onVisibilityChange = () => {
    pageVisible = document.visibilityState === "visible";
    syncAnimationLoop();
  };

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(RENDER_TUNING.values.pixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };

  const resizeObserver = new ResizeObserver(() => {
    const element = renderer.domElement;
    if (element.clientWidth !== window.innerWidth || element.clientHeight !== window.innerHeight) resize();
  });

  window.addEventListener("resize", resize);
  document.addEventListener("visibilitychange", onVisibilityChange);
  resizeObserver.observe(app);
  syncAnimationLoop();

  return {
    setManual,
    manualTick(forcedDt?: number) {
      // Only when the renderer's loop is parked: a live frame already got its
      // token from Animation's rAF callback, and a second bump there would make
      // every FRAME-scoped node (the scene pass above all) run twice per frame.
      if (manual) advanceNodeFrame(renderer);
      ticks++;
      tick(forcedDt);
    },
    resize,
    get debugState() {
      return { manual, pageVisible, loopRunning, ticks };
    },
    dispose() {
      renderer.setAnimationLoop(null);
      loopRunning = false;
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      resizeObserver.disconnect();
      stopKeepAlive();
    }
  };
}
