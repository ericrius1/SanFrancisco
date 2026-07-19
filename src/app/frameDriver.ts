import type * as THREE from "three/webgpu";
import { RENDER_TUNING } from "../config";

type FrameTracer = {
  frame(frameMs: number): void;
  /** running EMA of frame dt (ms) */
  readonly ema: number;
};

export type FrameDriver = {
  setManual(enabled: boolean): void;
  resize(): void;
  readonly debugState: {
    manual: boolean;
    pageVisible: boolean;
    loopRunning: boolean;
    ticks: number;
  };
  dispose(): void;
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

  const loop = () => {
    // setAnimationLoop(null) is the primary background gate. Keep this guard as
    // a hard backstop in case a queued callback crosses the visibility edge.
    if (!pageVisible || manual) return;
    const now = performance.now();
    if (throttleRaf && now - lastLoop < 50) return;
    const frameMs = now - lastLoop;
    lastLoop = now;
    ticks++;
    tick();
    if (isRevealed()) {
      tracer.frame(frameMs);
      adaptiveRes?.update(tracer.ema);
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
