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

  const loop = () => {
    const now = performance.now();
    if (throttleRaf && now - lastLoop < 50) return;
    const frameMs = now - lastLoop;
    lastLoop = now;
    tick();
    if (isRevealed()) {
      tracer.frame(frameMs);
      adaptiveRes?.update(tracer.ema);
    }
  };

  const setManual = (enabled: boolean) => {
    manual = enabled;
    renderer.setAnimationLoop(enabled ? null : loop);
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
  resizeObserver.observe(app);
  renderer.setAnimationLoop(loop);

  let keepAliveTimer: number | null = null;
  if (import.meta.env.DEV) {
    keepAliveTimer = window.setInterval(() => {
      if (!manual && (document.hidden || performance.now() - lastLoop > 250)) tick(0.05);
    }, 50);
  }

  return {
    setManual,
    resize,
    dispose() {
      renderer.setAnimationLoop(null);
      window.removeEventListener("resize", resize);
      resizeObserver.disconnect();
      if (keepAliveTimer !== null) window.clearInterval(keepAliveTimer);
    }
  };
}
