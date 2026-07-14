import {
  carPaintHex,
  normalizeCarConfig,
  type CarConfig
} from "./config";
import {
  cachedCarImage,
  carAssetsReady,
  carDecalAsset,
  carSurfaceAsset,
  prepareCarAssets
} from "./assets";

const css = (hex: number, alpha = 1) => {
  const r = (hex >> 16) & 255;
  const g = (hex >> 8) & 255;
  const b = hex & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

function fallbackLacquer(ctx: CanvasRenderingContext2D, width: number, height: number, config: CarConfig) {
  const paint = carPaintHex(config);
  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, css(paint, 1));
  base.addColorStop(0.58, css(paint, 0.95));
  base.addColorStop(1, "rgba(7,12,18,.86)");
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = "screen";
  ctx.globalAlpha = 0.12;
  for (let y = 0; y < height; y += 18) {
    ctx.fillStyle = y % 36 ? "rgba(255,255,255,.22)" : "rgba(255,255,255,.1)";
    ctx.fillRect(0, y, width, 1);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function drawTile(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  image: HTMLImageElement,
  config: CarConfig
) {
  const zoom = 0.55 + (config.surfaceScale / 100) * 1.35;
  const tile = Math.max(96, canvas.width / zoom);
  for (let y = -tile; y < canvas.height + tile; y += tile) {
    for (let x = -tile; x < canvas.width + tile; x += tile) {
      ctx.drawImage(image, x, y, tile, tile);
    }
  }
}

export function carSurfacePaintKey(raw: CarConfig): string {
  const config = normalizeCarConfig(raw);
  return [config.paint, config.paintHex, config.surface, config.surfaceScale, config.clearcoat].join("|");
}

export function carDecalPaintKey(raw: CarConfig): string {
  const config = normalizeCarConfig(raw);
  return [config.decal, config.decalScale, config.decalPosition].join("|");
}

/** Immediate procedural lacquer; selected GPT Image finish appears after activation. */
export function paintCarSurface(canvas: HTMLCanvasElement, raw: CarConfig): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width <= 0 || canvas.height <= 0) return false;
  const config = normalizeCarConfig(raw);
  const surface = carSurfaceAsset(config.surface);
  const image = cachedCarImage(surface.url);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  fallbackLacquer(ctx, canvas.width, canvas.height, config);
  if (image) {
    ctx.globalCompositeOperation = "soft-light";
    ctx.globalAlpha = 0.78;
    drawTile(ctx, canvas, image, config);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "color";
    ctx.fillStyle = css(carPaintHex(config), 0.62);
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.globalCompositeOperation = "screen";
  const varnish = ctx.createLinearGradient(0, 0, 0, canvas.height);
  varnish.addColorStop(0, `rgba(255,255,255,${0.06 + config.clearcoat * 0.0017})`);
  varnish.addColorStop(0.42, "rgba(255,255,255,.015)");
  varnish.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = varnish;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  return carAssetsReady(config);
}

export function paintCarDecal(canvas: HTMLCanvasElement, raw: CarConfig): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width <= 0 || canvas.height <= 0) return false;
  const config = normalizeCarConfig(raw);
  const image = cachedCarImage(carDecalAsset(config.decal).url);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!image) return carAssetsReady(config);
  const scale = 0.4 + (config.decalScale / 100) * 0.58;
  const width = canvas.width * scale;
  const height = width * image.naturalHeight / Math.max(1, image.naturalWidth);
  const x = canvas.width * (0.27 + config.decalPosition * 0.0046);
  ctx.save();
  ctx.translate(x, canvas.height * 0.52);
  ctx.drawImage(image, -width * 0.5, -height * 0.5, width, height);
  ctx.restore();
  return carAssetsReady(config);
}

export const prepareCarSurface = prepareCarAssets;
