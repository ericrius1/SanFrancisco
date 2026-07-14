import type * as THREE from "three/webgpu";
import { RENDER_TUNING } from "../config";

/** Long-edge target for in-game stills (4K). Short edge follows aspect. */
const TARGET_LONG_EDGE = 3840;
/** Cap pixel ratio so a huge window cannot explode GPU memory. */
const MAX_PIXEL_RATIO = 3;

export type InGameScreenshotDeps = {
  renderer: THREE.WebGPURenderer;
  /** Render one beauty frame into the live canvas (post-FX included). */
  renderFrame: () => void;
  /** GPU readback of the post-FX frame at the current drawing-buffer size. */
  captureStillRgba: () => Promise<{ width: number; height: number; pixels: Uint8ClampedArray }>;
  /** Optional: temporarily enable 4× beauty MSAA for the still. */
  setCinematicMultisampling?: (enabled: boolean) => void;
};

export type InGameScreenshotResult = {
  path: string;
  width: number;
  height: number;
};

let capturing = false;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local wall-clock stamp used in the on-disk filename. */
function shotStamp(d = new Date()): string {
  return (
    `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}` +
    `-${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

/** Encode tight RGBA8 (top-left origin, matching cinematic fast readback) to PNG. */
async function rgbaToPngBlob(width: number, height: number, pixels: Uint8ClampedArray): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D context unavailable for PNG encode");
  ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/**
 * Capture a high-resolution PNG of the WebGPU beauty pass (HUD is DOM-only, so
 * it is never in the shot) and POST it to the local /api/in-game-shot writer.
 */
export async function takeInGameScreenshot(deps: InGameScreenshotDeps): Promise<InGameScreenshotResult> {
  if (capturing) throw new Error("screenshot already in progress");
  capturing = true;

  const { renderer, renderFrame, captureStillRgba, setCinematicMultisampling } = deps;
  const prevPixelRatio = renderer.getPixelRatio();
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const longEdge = Math.max(cssW, cssH);
  const targetPr = Math.min(MAX_PIXEL_RATIO, Math.max(1, TARGET_LONG_EDGE / longEdge));

  try {
    setCinematicMultisampling?.(true);
    renderer.setPixelRatio(targetPr);
    renderer.setSize(cssW, cssH);

    const { width, height, pixels } = await captureStillRgba();
    const blob = await rgbaToPngBlob(width, height, pixels);
    const filename = `sf-${shotStamp()}.png`;
    const res = await fetch("/api/in-game-shot", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-SF-Filename": filename
      },
      body: blob
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(detail || `save failed (${res.status})`);
    }
    const json = (await res.json()) as { path?: string };
    if (!json.path) throw new Error("save response missing path");
    return { path: json.path, width, height };
  } finally {
    setCinematicMultisampling?.(false);
    renderer.setPixelRatio(RENDER_TUNING.values.pixelRatio || prevPixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderFrame();
    capturing = false;
  }
}

export function isInGameScreenshotBusy(): boolean {
  return capturing;
}
