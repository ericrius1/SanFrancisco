import type * as THREE from "three/webgpu";

type DynamicResolution = {
  readonly ratio: number;
  sample(frameMs: number): void;
};

type FrameTracer = {
  frame(frameMs: number): void;
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
  dynamicResolution: DynamicResolution;
  tracer: FrameTracer;
  isRevealed: () => boolean;
}): FrameDriver {
  const { renderer, camera, app, tick, dynamicResolution, tracer, isRevealed } = opts;
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
      dynamicResolution.sample(frameMs);
      tracer.frame(frameMs);
    }
  };

  const setManual = (enabled: boolean) => {
    manual = enabled;
    renderer.setAnimationLoop(enabled ? null : loop);
  };

  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(dynamicResolution.ratio);
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
