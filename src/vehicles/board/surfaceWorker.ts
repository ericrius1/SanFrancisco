import type { BoardConfig } from "./config";
import { paintBoardSurface } from "./surfaceTexture";

self.onmessage = (event: MessageEvent<{ id: number; config: BoardConfig }>) => {
  const canvas = new OffscreenCanvas(128, 256);
  // The painter needs only the standard 2D canvas surface shared by HTMLCanvas
  // and OffscreenCanvas. Keep its public DOM type stable for editor callers.
  paintBoardSurface(canvas as unknown as HTMLCanvasElement, event.data.config);
  const bitmap = canvas.transferToImageBitmap();
  (self as unknown as Worker).postMessage({ id: event.data.id, bitmap }, [bitmap]);
};
