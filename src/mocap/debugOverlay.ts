import type { PoseLandmark } from "./landmarks";

export type DebugRoi = { centerX: number; centerY: number; size: number };

// Raw (pre-mirror) BlazePose indices for the joints the retargeter consumes.
const EDGES: Array<[number, number]> = [
  [0, 2], [0, 5], [2, 7], [5, 8], [9, 10],
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [15, 17], [15, 19], [15, 21], [17, 19],
  [16, 18], [16, 20], [16, 22], [18, 20],
  [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28]
];
const POINTS = [
  0, 2, 5, 7, 8, 9, 10,
  11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22,
  23, 24, 25, 26, 27, 28
];

const confidence = (point: PoseLandmark) => Math.min(point.visibility, point.presence);

function visibilityColor(visibility: number): string {
  if (visibility >= 0.5) return "#6ff7a0";
  if (visibility >= 0.35) return "#ffd166";
  return "#ff5d5d";
}

/**
 * Draws the raw tracked joints over the (mirrored, object-fit: cover) webcam
 * preview so input quality and retargeting quality can be judged separately.
 * Joint color = observed confidence (visibility + in-frame presence) vs the retargeter's thresholds:
 * green ≥ 0.5, amber ≥ 0.35 (arm gate), red below. Blue box = tracking crop.
 */
export function drawPoseDebug(
  canvas: HTMLCanvasElement,
  screen: PoseLandmark[] | null,
  roi: DebugRoi | null,
  videoWidth: number,
  videoHeight: number,
  trackingMode: "full-body" | "upper-body" | null = null
): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (!width || !height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
  if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!videoWidth || !videoHeight) return;

  // Match the video element: object-fit: cover, then CSS scaleX(-1) mirror.
  const scale = Math.max(width / videoWidth, height / videoHeight);
  const offsetX = (width - videoWidth * scale) * 0.5;
  const offsetY = (height - videoHeight * scale) * 0.5;
  const px = (x: number) => width - (x * videoWidth * scale + offsetX);
  const py = (y: number) => y * videoHeight * scale + offsetY;

  if (roi) {
    const half = roi.size * 0.5;
    const x0 = px((roi.centerX + half) / videoWidth);
    const y0 = py((roi.centerY - half) / videoHeight);
    context.strokeStyle = "rgba(110, 190, 255, 0.4)";
    context.lineWidth = 1;
    context.strokeRect(x0, y0, roi.size * scale, roi.size * scale);
  }
  if (!screen) return;

  context.lineWidth = 2;
  context.lineCap = "round";
  for (const [a, b] of EDGES) {
    if (trackingMode === "upper-body" && (a >= 23 || b >= 23)) continue;
    const pa = screen[a];
    const pb = screen[b];
    const visibility = Math.min(confidence(pa), confidence(pb));
    if (visibility < 0.2) continue;
    context.strokeStyle = visibilityColor(visibility);
    context.globalAlpha = 0.35 + 0.55 * Math.min(1, visibility);
    context.beginPath();
    context.moveTo(px(pa.x), py(pa.y));
    context.lineTo(px(pb.x), py(pb.y));
    context.stroke();
  }
  context.globalAlpha = 1;
  for (const index of POINTS) {
    if (trackingMode === "upper-body" && index >= 23) continue;
    const point = screen[index];
    const pointConfidence = confidence(point);
    if (pointConfidence < 0.2) continue;
    context.fillStyle = visibilityColor(pointConfidence);
    context.beginPath();
    context.arc(px(point.x), py(point.y), index === 15 || index === 16 ? 3.5 : 2.5, 0, Math.PI * 2);
    context.fill();
  }
  // Wrist tags (user's own left/right — the preview is mirrored, so they sit
  // on the same side as the player's actual hands).
  context.font = "700 9px system-ui, sans-serif";
  context.fillStyle = "#eaf6ff";
  if (confidence(screen[15]) >= 0.2) context.fillText("L", px(screen[15].x) + 5, py(screen[15].y) - 5);
  if (confidence(screen[16]) >= 0.2) context.fillText("R", px(screen[16].x) + 5, py(screen[16].y) - 5);
}

export function clearPoseDebug(canvas: HTMLCanvasElement): void {
  canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
}
