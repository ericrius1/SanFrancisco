import {
  normalizeSurfboardConfig,
  surfboardAccentHex,
  surfboardBaseHex,
  surfboardRailHex,
  type SurfboardConfig
} from "./config";
import {
  cachedSurfboardImage,
  prepareSurfboardAssets,
  surfboardAssetsReady,
  surfboardDecalAsset,
  surfboardSurfaceAsset
} from "./assets";

const css = (hex: number, alpha = 1) => {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

function fallbackArtwork(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  config: SurfboardConfig
): void {
  const accent = surfboardAccentHex(config);
  const rail = surfboardRailHex(config);
  const seed = config.surface.length * 0.71;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  ctx.lineCap = "round";
  for (let band = 0; band < 9; band++) {
    ctx.beginPath();
    const y0 = (band / 8) * height;
    for (let x = -12; x <= width + 12; x += 8) {
      const u = x / Math.max(1, width);
      const y = y0 + Math.sin(u * Math.PI * (2.2 + (band % 3)) + seed + band * 0.73) * (8 + band * 1.5);
      if (x < 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = css(band % 2 ? accent : rail, 0.08 + (band % 3) * 0.045);
    ctx.lineWidth = 2 + (band % 3) * 1.4;
    ctx.stroke();
  }
  ctx.restore();
}

function drawSurfaceImage(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  config: SurfboardConfig,
  kind: "texture" | "art"
): void {
  const width = canvas.width;
  const height = canvas.height;
  const zoom = 0.62 + (config.textureZoom / 100) * 1.7;
  const rotation = ((config.textureRotation - 50) / 50) * Math.PI;
  const offsetX = ((config.textureOffsetX - 50) / 50) * width * 0.42;
  const offsetY = ((config.textureOffsetY - 50) / 50) * height * 0.42;
  const diagonal = Math.hypot(width, height);

  ctx.save();
  ctx.translate(width * 0.5 + offsetX, height * 0.5 + offsetY);
  ctx.rotate(rotation);
  ctx.globalAlpha = 0.88;
  ctx.globalCompositeOperation = "source-over";

  if (kind === "art") {
    const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight) * zoom;
    const drawWidth = image.naturalWidth * scale;
    const drawHeight = image.naturalHeight * scale;
    ctx.drawImage(image, -drawWidth * 0.5, -drawHeight * 0.5, drawWidth, drawHeight);
  } else {
    const tileWidth = width * (0.32 + zoom * 0.48);
    const scale = tileWidth / Math.max(1, image.naturalWidth);
    const tileHeight = image.naturalHeight * scale;
    const nx = Math.ceil(diagonal / tileWidth) + 3;
    const ny = Math.ceil(diagonal / tileHeight) + 3;
    for (let y = -ny; y <= ny; y++) {
      for (let x = -nx; x <= nx; x++) {
        ctx.drawImage(image, x * tileWidth, y * tileHeight, tileWidth + 0.5, tileHeight + 0.5);
      }
    }
  }
  ctx.restore();
}

function drawDecal(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  config: SurfboardConfig
): void {
  const width = canvas.width;
  const height = canvas.height;
  const maxWidth = width * (0.18 + (config.decalScale / 100) * 0.64);
  const aspect = image.naturalHeight / Math.max(1, image.naturalWidth);
  const drawWidth = maxWidth;
  const drawHeight = maxWidth * aspect;
  const x = width * (0.1 + (config.decalX / 100) * 0.8);
  const y = height * (0.08 + (config.decalY / 100) * 0.84);
  const rotation = ((config.decalRotation - 50) / 50) * Math.PI;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rotation);
  ctx.shadowColor = "rgba(3,18,24,.28)";
  ctx.shadowBlur = Math.max(2, width * 0.025);
  ctx.shadowOffsetY = Math.max(1, width * 0.008);
  ctx.drawImage(image, -drawWidth * 0.5, -drawHeight * 0.5, drawWidth, drawHeight);
  ctx.restore();
}

/** Fields that require repainting pixels rather than updating material motion. */
export function surfboardSurfacePaintKey(config: SurfboardConfig): string {
  const value = normalizeSurfboardConfig(config);
  return [
    value.base,
    value.rail,
    value.accent,
    value.baseHex,
    value.railHex,
    value.accentHex,
    value.surface,
    value.textureZoom,
    value.textureRotation,
    value.textureOffsetX,
    value.textureOffsetY,
    value.decal,
    value.decalScale,
    value.decalRotation,
    value.decalX,
    value.decalY
  ].join("|");
}

/**
 * Compose the board into one caller-owned canvas. It always paints a complete
 * fallback immediately; callers can await prepareSurfboardSurface() and repaint
 * when the selected PNGs finish decoding.
 */
export function paintSurfboardSurface(canvas: HTMLCanvasElement, raw: SurfboardConfig): boolean {
  if (canvas.width <= 0 || canvas.height <= 0) return false;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const config = normalizeSurfboardConfig(raw);
  const base = surfboardBaseHex(config);
  const rail = surfboardRailHex(config);
  const accent = surfboardAccentHex(config);
  const surfaceAsset = surfboardSurfaceAsset(config.surface);
  const surfaceImage = cachedSurfboardImage(surfaceAsset.url);
  const decalAsset = surfboardDecalAsset(config.decal);
  const decalImage = cachedSurfboardImage(decalAsset.url);

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const wash = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  wash.addColorStop(0, css(base));
  wash.addColorStop(0.58, css(base));
  wash.addColorStop(1, css(rail));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (surfaceImage) drawSurfaceImage(ctx, canvas, surfaceImage, config, surfaceAsset.kind);
  else fallbackArtwork(ctx, canvas.width, canvas.height, config);

  // A translucent color wash ties generated art back to the chosen foam/rail
  // palette while preserving the image's authored values.
  ctx.globalCompositeOperation = "soft-light";
  ctx.fillStyle = css(base, 0.23);
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Fine stringer and paired pin lines remain visible over every image and give
  // the long silhouette a readable direction from chase-camera distance.
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = css(accent, 0.78);
  const stringer = Math.max(1, canvas.width * 0.012);
  ctx.fillRect(canvas.width * 0.5 - stringer * 0.5, 0, stringer, canvas.height);
  ctx.fillStyle = css(rail, 0.34);
  ctx.fillRect(canvas.width * 0.18, 0, Math.max(1, stringer * 0.42), canvas.height);
  ctx.fillRect(canvas.width * 0.82, 0, Math.max(1, stringer * 0.42), canvas.height);

  if (decalImage) drawDecal(ctx, canvas, decalImage, config);

  const varnish = ctx.createLinearGradient(0, 0, canvas.width, 0);
  varnish.addColorStop(0, "rgba(255,255,255,.04)");
  varnish.addColorStop(0.35, "rgba(255,255,255,.24)");
  varnish.addColorStop(0.55, "rgba(255,255,255,.02)");
  varnish.addColorStop(1, "rgba(255,255,255,.09)");
  ctx.fillStyle = varnish;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  return surfboardAssetsReady(config);
}

export const prepareSurfboardSurface = prepareSurfboardAssets;
export const loadSelectedSurfboardSurface = prepareSurfboardAssets;
