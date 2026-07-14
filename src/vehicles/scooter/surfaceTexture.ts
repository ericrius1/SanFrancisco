import {
  normalizeScooterConfig,
  scooterPaintHex,
  scooterTrimHex,
  type ScooterConfig
} from "./config";
import {
  cachedScooterImage,
  prepareScooterAssets,
  scooterAssetsReady,
  scooterDecalAsset,
  scooterSurfaceAsset
} from "./assets";

const css = (hex: number, alpha = 1) => {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

function fallbackPinstripes(ctx: CanvasRenderingContext2D, width: number, height: number, config: ScooterConfig) {
  const trim = scooterTrimHex(config);
  ctx.save();
  ctx.lineCap = "round";
  ctx.globalCompositeOperation = "screen";
  for (let row = 0; row < 7; row++) {
    const y = height * (0.16 + row * 0.11);
    ctx.beginPath();
    ctx.moveTo(-width * 0.08, y);
    ctx.bezierCurveTo(width * 0.22, y - height * 0.17, width * 0.68, y + height * 0.14, width * 1.08, y - height * 0.04);
    ctx.strokeStyle = css(trim, 0.08 + (row % 3) * 0.045);
    ctx.lineWidth = 2 + (row % 2) * 1.6;
    ctx.stroke();
  }
  ctx.restore();
}

function drawSurface(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  config: ScooterConfig
) {
  const zoom = 0.62 + (config.bodyVolume / 100) * 0.46;
  const scale = Math.max(canvas.width / image.naturalWidth, canvas.height / image.naturalHeight) * zoom;
  const w = image.naturalWidth * scale;
  const h = image.naturalHeight * scale;
  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.translate(canvas.width * 0.5, canvas.height * 0.5);
  ctx.rotate(((config.stance - 50) / 50) * 0.08);
  ctx.drawImage(image, -w * 0.5, -h * 0.5, w, h);
  ctx.restore();
}

function drawDecal(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  config: ScooterConfig
) {
  const scale = 0.16 + (config.decalScale / 100) * 0.55;
  const width = canvas.width * scale;
  const height = width * (image.naturalHeight / Math.max(1, image.naturalWidth));
  const x = canvas.width * (0.18 + (config.decalPosition / 100) * 0.64);
  const y = canvas.height * 0.54;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(((config.decalPosition - 50) / 50) * -0.14);
  ctx.shadowColor = "rgba(2, 12, 18, .3)";
  ctx.shadowBlur = Math.max(2, canvas.width * 0.014);
  ctx.shadowOffsetY = Math.max(1, canvas.height * 0.012);
  ctx.drawImage(image, -width * 0.5, -height * 0.5, width, height);
  ctx.restore();
}

export function scooterSurfacePaintKey(raw: ScooterConfig): string {
  const config = normalizeScooterConfig(raw);
  return [
    config.paint,
    config.trim,
    config.paintHex,
    config.trimHex,
    config.surface,
    config.decal,
    config.stance,
    config.bodyVolume,
    config.decalScale,
    config.decalPosition
  ].join("|");
}

/** Paints an immediate procedural finish; selected generated art appears after activation. */
export function paintScooterSurface(canvas: HTMLCanvasElement, raw: ScooterConfig): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width <= 0 || canvas.height <= 0) return false;
  const config = normalizeScooterConfig(raw);
  const paint = scooterPaintHex(config);
  const trim = scooterTrimHex(config);
  const surface = scooterSurfaceAsset(config.surface);
  const decal = scooterDecalAsset(config.decal);
  const surfaceImage = cachedScooterImage(surface.url);
  const decalImage = cachedScooterImage(decal.url);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const base = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  base.addColorStop(0, css(paint));
  base.addColorStop(0.62, css(paint));
  base.addColorStop(1, css(trim, 0.92));
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (surfaceImage) drawSurface(ctx, canvas, surfaceImage, config);
  else fallbackPinstripes(ctx, canvas.width, canvas.height, config);

  // Keep generated surfaces tied to the user's selected paint instead of
  // reading like a pasted rectangular photo.
  ctx.globalCompositeOperation = "soft-light";
  ctx.fillStyle = css(paint, 0.29);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.globalCompositeOperation = "source-over";

  const piping = Math.max(2, canvas.height * 0.024);
  ctx.strokeStyle = css(trim, 0.86);
  ctx.lineWidth = piping;
  ctx.beginPath();
  ctx.moveTo(-8, canvas.height * 0.78);
  ctx.bezierCurveTo(canvas.width * 0.28, canvas.height * 0.66, canvas.width * 0.7, canvas.height * 0.82, canvas.width + 8, canvas.height * 0.58);
  ctx.stroke();

  if (decalImage) drawDecal(ctx, canvas, decalImage, config);

  const varnish = ctx.createLinearGradient(0, 0, 0, canvas.height);
  varnish.addColorStop(0, "rgba(255,255,255,.25)");
  varnish.addColorStop(0.3, "rgba(255,255,255,.03)");
  varnish.addColorStop(1, "rgba(0,0,0,.12)");
  ctx.fillStyle = varnish;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  return scooterAssetsReady(config);
}

export const prepareScooterSurface = prepareScooterAssets;
