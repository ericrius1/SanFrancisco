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
};

export type InGameScreenshotResult = {
  filename: string;
  /** Set when the dev-server writer also archived a copy on disk. */
  archivedPath: string | null;
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
  // ImageData requires an ArrayBuffer-backed view; WebGPU readback types may
  // also admit SharedArrayBuffer, so make the encoder's ownership explicit.
  ctx.putImageData(new ImageData(Uint8ClampedArray.from(pixels), width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

/** Hand the PNG to the browser's own download machinery (→ Downloads folder). */
function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.rel = "noopener";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Chrome reads the blob asynchronously after click(); revoking immediately can
  // truncate a multi-megabyte 4K PNG mid-write.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * Best-effort archive copy through the dev server's /api/in-game-shot writer.
 * Absent in preview/production builds, so a failure here never fails the shot —
 * the browser download is the delivery the player actually sees.
 */
async function archiveToDevServer(blob: Blob, filename: string): Promise<string | null> {
  try {
    const res = await fetch("/api/in-game-shot", {
      method: "POST",
      headers: {
        "Content-Type": "image/png",
        "X-SF-Filename": filename
      },
      body: blob
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { path?: string };
    return json.path ?? null;
  } catch {
    return null;
  }
}

/**
 * Capture a high-resolution PNG of the WebGPU beauty pass (HUD is DOM-only, so
 * it is never in the shot) and download it to the player's Downloads folder.
 *
 * Resolution comes purely from the temporary pixel-ratio bump — a 4K
 * supersample. Do NOT reach for the pipeline's cinematic MSAA here: raising the
 * beauty pass's sample count mid-session poisons cached depth bind groups and
 * leaves the live canvas rendering nothing but clear colour (see the MSAA note
 * in render/pipeline.ts). That was a real black-screen-after-screenshot bug.
 */
export async function takeInGameScreenshot(deps: InGameScreenshotDeps): Promise<InGameScreenshotResult> {
  if (capturing) throw new Error("screenshot already in progress");
  capturing = true;

  const { renderer, renderFrame, captureStillRgba } = deps;
  const prevPixelRatio = renderer.getPixelRatio();
  const cssW = window.innerWidth;
  const cssH = window.innerHeight;
  const longEdge = Math.max(cssW, cssH);
  const targetPr = Math.min(MAX_PIXEL_RATIO, Math.max(1, TARGET_LONG_EDGE / longEdge));

  try {
    renderer.setPixelRatio(targetPr);
    renderer.setSize(cssW, cssH);

    const { width, height, pixels } = await captureStillRgba();
    const blob = await rgbaToPngBlob(width, height, pixels);
    const filename = `sf-${shotStamp()}.png`;
    downloadBlob(blob, filename);
    const archivedPath = await archiveToDevServer(blob, filename);
    return { filename, archivedPath, width, height };
  } finally {
    renderer.setPixelRatio(RENDER_TUNING.values.pixelRatio || prevPixelRatio);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderFrame();
    capturing = false;
  }
}

export function isInGameScreenshotBusy(): boolean {
  return capturing;
}
