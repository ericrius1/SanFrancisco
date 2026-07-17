import * as THREE from "three/webgpu";

/**
 * In-session diagnostic for the "flickering objects in the sky" reports.
 * Enabled with `?flickerspy=1`. Every frame it:
 *  - keeps a small ring buffer of downscaled canvas captures (last ~2s),
 *  - records the frame's draw list (object name + world position for
 *    everything rendered beyond 2 m), via a renderObject wrap,
 *  - diffs the sky band (upper 45%) of consecutive downscaled frames and
 *    flags compact transient clusters.
 *
 * On a detection — or manually with F9 the moment the artifact is seen — it
 * downloads a PNG of the flagged frame, the previous frame, and a JSON with
 * the two frames' draw lists and detection metadata. Captures are throttled
 * to one per 2 s, at most 12 per session.
 */
export function installFlickerSpy(opts: {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.Camera;
}): void {
  const { renderer, camera } = opts;
  const canvas = renderer.domElement;
  const W = 320;
  const H = 200;
  const SKY_ROWS = Math.floor(H * 0.45);
  const off = document.createElement("canvas");
  off.width = W;
  off.height = H;
  const ctx = off.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;

  type DrawRec = [string, number, number, number];
  type FrameRec = { frame: number; time: number; draws: DrawRec[]; pixels: ImageData | null; shot: string | null };

  const ring: FrameRec[] = [];
  let frame = 0;
  let lastCaptureAt = -Infinity;
  let captures = 0;
  const v = new THREE.Vector3();

  // Draw-list wrap: cheap name+position capture of everything rendered.
  let currentDraws: DrawRec[] = [];
  const anyRenderer = renderer as unknown as {
    renderObject: (...args: unknown[]) => unknown;
  };
  const origRenderObject = anyRenderer.renderObject.bind(renderer);
  anyRenderer.renderObject = (...args: unknown[]) => {
    const object = args[0] as THREE.Object3D | undefined;
    try {
      if (object && currentDraws.length < 900) {
        v.setFromMatrixPosition(object.matrixWorld);
        if (v.distanceToSquared(camera.position) > 4) {
          currentDraws.push([object.name || object.type, Math.round(v.x * 10) / 10, Math.round(v.y * 10) / 10, Math.round(v.z * 10) / 10]);
        }
      }
    } catch {
      /* diagnostics must never break rendering */
    }
    return origRenderObject(...args);
  };

  const download = (filename: string, url: string) => {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
  };

  const dump = (reason: string, meta: Record<string, unknown>, manual = false) => {
    const now = performance.now();
    // Auto-detections are throttled/capped; a manual key press always dumps.
    if (!manual && (now - lastCaptureAt < 2000 || captures >= 30)) return;
    lastCaptureAt = now;
    captures++;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const current = ring[ring.length - 1];
    const previous = ring[ring.length - 2];
    // Full-resolution shot of the CURRENT canvas (the flagged frame is the one
    // still on screen when this runs synchronously inside the rAF).
    let fullShot: string | null = null;
    try {
      fullShot = canvas.toDataURL("image/png");
    } catch {
      fullShot = null;
    }
    if (fullShot) download(`flicker-${stamp}.png`, fullShot);
    if (previous?.shot) download(`flicker-${stamp}-prev.png`, previous.shot);
    const payload = {
      reason,
      meta,
      frame,
      camera: { position: camera.position.toArray(), quaternion: (camera as THREE.PerspectiveCamera).quaternion.toArray() },
      currentDraws: current?.draws ?? [],
      previousDraws: previous?.draws ?? []
    };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: "application/json" });
    download(`flicker-${stamp}.json`, URL.createObjectURL(blob));
    console.warn(`[flickerspy] captured (${reason})`, meta);
  };

  // Capture-phase on both window and document so nothing swallows it first.
  // `G` (grab) is a free key — F9 is intercepted by the OS/browser.
  const onKey = (event: KeyboardEvent) => {
    if (event.code === "KeyG") {
      event.preventDefault();
      event.stopPropagation();
      console.warn("[flickerspy] G pressed — dumping frame");
      dump("manual G", {}, true);
    }
  };
  window.addEventListener("keydown", onKey, { capture: true });
  document.addEventListener("keydown", onKey, { capture: true });

  const scan = () => {
    frame++;
    try {
      ctx.drawImage(canvas, 0, 0, W, H);
      const pixels = ctx.getImageData(0, 0, W, SKY_ROWS);
      let shot: string | null = null;
      try {
        shot = off.toDataURL("image/png");
      } catch {
        shot = null;
      }
      ring.push({ frame, time: performance.now(), draws: currentDraws, pixels, shot });
      if (ring.length > 40) ring.shift();

      const prev = ring[ring.length - 2];
      if (prev?.pixels) {
        const a = pixels.data;
        const b = prev.pixels.data;
        let hits = 0;
        let cx = 0;
        let cy = 0;
        for (let p = 0; p < a.length; p += 4) {
          const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]);
          if (d > 110) {
            hits++;
            cx += (p / 4) % W;
            cy += Math.floor(p / 4 / W);
          }
        }
        // compact transient: a handful of sky pixels changed hard, but not the
        // whole band (camera pans change everything a little, not a lot).
        if (hits >= 3 && hits <= 500) {
          dump("sky transient", { hits, px: Math.round((cx / hits / W) * 100) / 100, py: Math.round((cy / hits / SKY_ROWS) * 100) / 100 });
        }
      }
    } catch {
      /* keep scanning */
    }
    currentDraws = [];
    requestAnimationFrame(scan);
  };
  requestAnimationFrame(scan);
  console.warn("[flickerspy] armed — press G to dump the current+previous frame and draw lists");
}
