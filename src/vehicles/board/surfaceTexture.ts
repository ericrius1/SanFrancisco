import {
  BOARD_DECK_COLORS,
  BOARD_GLOW_COLORS,
  type BoardConfig
} from "./config";

type RGB = readonly [number, number, number];

type Palette = {
  base: RGB;
  deep: RGB;
  lift: RGB;
  trim: RGB;
  trimLift: RGB;
  glow: RGB;
  glowLift: RGB;
};

const TAU = Math.PI * 2;
const WHITE: RGB = [255, 255, 255];
const INK: RGB = [5, 10, 18];

const imageCache = new WeakMap<HTMLCanvasElement, ImageData>();

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const fract = (v: number) => v - Math.floor(v);

function fromHex(value: number): RGB {
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(lerp(a[0], b[0], t)),
    Math.round(lerp(a[1], b[1], t)),
    Math.round(lerp(a[2], b[2], t))
  ];
}

function css(c: RGB, alpha = 1) {
  return alpha === 1
    ? `rgb(${c[0]} ${c[1]} ${c[2]})`
    : `rgb(${c[0]} ${c[1]} ${c[2]} / ${alpha})`;
}

function palette(config: BoardConfig): Palette {
  const base = fromHex(BOARD_DECK_COLORS[config.deck]?.color ?? BOARD_DECK_COLORS[0].color);
  const trim = fromHex(BOARD_DECK_COLORS[config.trim]?.color ?? BOARD_DECK_COLORS[0].color);
  const glow = fromHex(BOARD_GLOW_COLORS[config.glow]?.color ?? BOARD_GLOW_COLORS[0].color);
  return {
    base,
    deep: mix(base, INK, 0.28),
    lift: mix(base, WHITE, 0.18),
    trim,
    trimLift: mix(trim, WHITE, 0.2),
    glow,
    glowLift: mix(glow, WHITE, 0.3)
  };
}

/** Fast integer hash for deterministic lattice noise. */
function hash2(x: number, y: number, seed: number) {
  let h = Math.imul(x, 0x1f123bb5) ^ Math.imul(y, 0x5f356495) ^ seed;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 0xffffffff;
}

function noise2(x: number, y: number, seed: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

function fbm(x: number, y: number, seed: number) {
  let total = 0;
  let weight = 0.58;
  let norm = 0;
  for (let octave = 0; octave < 3; octave++) {
    total += noise2(x, y, seed + octave * 1013) * weight;
    norm += weight;
    x = x * 2.03 + 7.17;
    y = y * 2.03 - 5.31;
    weight *= 0.5;
  }
  return total / norm;
}

/** Mulberry32: stable seeded draws for the vector-based patterns. */
function seededRandom(seed: number) {
  let state = (seed >>> 0) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let n = state;
    n = Math.imul(n ^ (n >>> 15), n | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 0x100000000;
  };
}

function pixelsFor(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  let image = imageCache.get(canvas);
  if (!image || image.width !== canvas.width || image.height !== canvas.height) {
    image = ctx.createImageData(canvas.width, canvas.height);
    imageCache.set(canvas, image);
  }
  return image;
}

function paintAurora(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  p: Palette,
  scale: number,
  warp: number,
  seed: number
) {
  const { width: w, height: h } = canvas;
  const image = pixelsFor(canvas, ctx);
  const data = image.data;
  const density = lerp(1.2, 4.8, scale);
  const bend = lerp(0.12, 1.4, warp);
  const phase = hash2(17, 31, seed) * TAU;
  let index = 0;

  for (let y = 0; y < h; y++) {
    const v = y / Math.max(1, h - 1);
    const py = (v - 0.5) * 3.2;
    for (let x = 0; x < w; x++) {
      const u = x / Math.max(1, w - 1);
      const px = (u - 0.5) * 2;
      const field = fbm(px * density * 0.45 + 3.1, py * density * 0.28 - 1.7, seed);
      const fine = noise2(px * density * 1.15 - 8.3, py * density * 0.7 + 2.4, seed ^ 0x51f2d3a7);
      const flow = px * (1.7 + density * 0.18) + py * 0.22 + (field - 0.5) * bend * 2.7;
      const wave = 0.5 + 0.5 * Math.sin(flow * TAU + phase + (fine - 0.5) * bend * 0.7);
      const counter = 0.5 + 0.5 * Math.sin((flow * 0.54 - py * 0.38) * TAU - phase * 0.63);
      const ribbon = Math.pow(smoothstep(0.2, 0.96, wave), 1.35);
      const hot = smoothstep(0.78, 0.995, wave) * (0.58 + counter * 0.42);
      const grain = (fine - 0.5) * 0.08;
      const edge = smoothstep(0.66, 1, Math.abs(px));
      const baseT = clamp01(0.42 + field * 0.38 + grain - edge * 0.2);

      let r = lerp(p.deep[0], p.base[0], baseT);
      let g = lerp(p.deep[1], p.base[1], baseT);
      let b = lerp(p.deep[2], p.base[2], baseT);
      const ink = ribbon * (0.38 + counter * 0.34);
      r = lerp(r, p.trimLift[0], ink);
      g = lerp(g, p.trimLift[1], ink);
      b = lerp(b, p.trimLift[2], ink);
      r = lerp(r, p.glowLift[0], hot * 0.82);
      g = lerp(g, p.glowLift[1], hot * 0.82);
      b = lerp(b, p.glowLift[2], hot * 0.82);

      data[index++] = r;
      data[index++] = g;
      data[index++] = b;
      data[index++] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function paintTopo(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  p: Palette,
  scale: number,
  warp: number,
  seed: number
) {
  const { width: w, height: h } = canvas;
  const image = pixelsFor(canvas, ctx);
  const data = image.data;
  const density = lerp(1.15, 4.6, scale);
  const bands = lerp(5.5, 12.5, scale);
  const bend = lerp(0.05, 0.72, warp);
  let index = 0;

  for (let y = 0; y < h; y++) {
    const v = y / Math.max(1, h - 1);
    const py = (v - 0.5) * 3.2;
    for (let x = 0; x < w; x++) {
      const u = x / Math.max(1, w - 1);
      const px = (u - 0.5) * 2;
      const drift = noise2(px * 0.75 + 9.2, py * 0.62 - 3.8, seed ^ 0x2a71b64d) - 0.5;
      const height = fbm(
        px * density * 0.7 + drift * bend * 2.1,
        py * density * 0.42 - drift * bend * 1.3,
        seed
      );
      const contourPhase = fract(height * bands + drift * bend * 0.38);
      const contourDistance = Math.min(contourPhase, 1 - contourPhase);
      const line = 1 - smoothstep(0.025, 0.082, contourDistance);
      const majorPhase = fract(height * bands * 0.25 + 0.04);
      const majorDistance = Math.min(majorPhase, 1 - majorPhase);
      const major = 1 - smoothstep(0.018, 0.055, majorDistance);
      const edge = smoothstep(0.66, 1, Math.abs(px));
      const shade = clamp01(0.22 + height * 0.64 - edge * 0.16);

      let r = lerp(p.deep[0], p.lift[0], shade);
      let g = lerp(p.deep[1], p.lift[1], shade);
      let b = lerp(p.deep[2], p.lift[2], shade);
      r = lerp(r, p.trimLift[0], line * 0.82);
      g = lerp(g, p.trimLift[1], line * 0.82);
      b = lerp(b, p.trimLift[2], line * 0.82);
      r = lerp(r, p.glow[0], major * 0.66);
      g = lerp(g, p.glow[1], major * 0.66);
      b = lerp(b, p.glow[2], major * 0.66);

      data[index++] = r;
      data[index++] = g;
      data[index++] = b;
      data[index++] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/** Curling interference cells with bright electric seams. */
function paintPlasma(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  p: Palette,
  scale: number,
  warp: number,
  seed: number
) {
  const { width: w, height: h } = canvas;
  const image = pixelsFor(canvas, ctx);
  const data = image.data;
  const density = lerp(1.15, 3.8, scale);
  const curl = lerp(0.12, 1.15, warp);
  const phase = hash2(43, 79, seed) * TAU;
  const phaseB = hash2(97, 23, seed ^ 0x4f1bbcdc) * TAU;
  let index = 0;

  for (let y = 0; y < h; y++) {
    const v = y / Math.max(1, h - 1);
    const py = (v - 0.5) * 3.2;
    for (let x = 0; x < w; x++) {
      const u = x / Math.max(1, w - 1);
      const px = (u - 0.5) * 2;
      const coarse = fbm(px * density * 0.36 + 5.7, py * density * 0.24 - 3.2, seed);
      const fine = noise2(px * density * 1.4 - 11.3, py * density * 0.92 + 7.1, seed ^ 0x7136a4d9);
      const dx = Math.sin(py * density * 2.1 + phase + coarse * TAU) * curl * 0.28;
      const dy = Math.cos(px * density * 2.35 - phaseB + fine * TAU) * curl * 0.2;
      const qx = px + dx + (coarse - 0.5) * curl * 0.34;
      const qy = py + dy - (fine - 0.5) * curl * 0.24;
      const radial = Math.hypot(qx * 1.18 + 0.22, qy * 0.62 - 0.16);
      const interference =
        Math.sin(qx * density * 4.8 + phase) +
        Math.sin(qy * density * 3.65 - phaseB) +
        Math.sin((qx + qy * 0.54) * density * 3.1 + phaseB * 0.62) +
        Math.sin(radial * density * 5.4 - phase * 0.74);
      const energy = 0.5 + 0.5 * Math.sin(interference * 1.12 + (coarse - 0.5) * curl * 4.2);
      const basin = clamp01(0.12 + energy * 0.82 + (fine - 0.5) * 0.12);
      const seam = 1 - smoothstep(0.025, lerp(0.15, 0.075, scale), Math.abs(energy - 0.5));
      const core = smoothstep(0.76, 0.985, energy) * (0.68 + coarse * 0.32);

      let r = lerp(p.deep[0], p.base[0], basin);
      let g = lerp(p.deep[1], p.base[1], basin);
      let b = lerp(p.deep[2], p.base[2], basin);
      const ink = seam * lerp(0.5, 0.88, warp);
      r = lerp(r, p.trimLift[0], ink);
      g = lerp(g, p.trimLift[1], ink);
      b = lerp(b, p.trimLift[2], ink);
      r = lerp(r, p.glowLift[0], core * 0.9);
      g = lerp(g, p.glowLift[1], core * 0.9);
      b = lerp(b, p.glowLift[2], core * 0.9);

      data[index++] = r;
      data[index++] = g;
      data[index++] = b;
      data[index++] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

function fillBackground(ctx: CanvasRenderingContext2D, w: number, h: number, p: Palette) {
  const background = ctx.createLinearGradient(0, 0, w, h);
  background.addColorStop(0, css(p.lift));
  background.addColorStop(0.48, css(p.base));
  background.addColorStop(1, css(p.deep));
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, w, h);
}

function paintTerrazzo(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: Palette,
  scale: number,
  warp: number,
  seed: number
) {
  fillBackground(ctx, w, h, p);
  const random = seededRandom(seed ^ 0x6a09e667);
  const count = Math.round(lerp(26, 112, scale));
  const averageRadius = lerp(w * 0.105, w * 0.035, scale);
  const colors = [p.trim, p.trimLift, p.glow, p.glowLift, p.lift] as const;

  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(0.55, w / 220);
  ctx.strokeStyle = css(p.deep, 0.32);

  for (let i = 0; i < count; i++) {
    let cx = random() * w;
    const cy = random() * h;
    cx += Math.sin((cy / h) * TAU * 1.7 + seed * 0.003) * warp * w * 0.13;
    const radius = averageRadius * lerp(0.48, 1.5, random());
    const sides = 3 + Math.floor(random() * 4);
    const angle = random() * TAU;
    const stretch = lerp(0.72, 1.7, random()) * lerp(1, 1.35, warp);
    const irregularity = lerp(0.08, 0.52, warp);
    const colorRoll = random();
    const color = colors[Math.min(colors.length - 1, Math.floor(colorRoll * colors.length))];

    ctx.beginPath();
    for (let k = 0; k < sides; k++) {
      const a = angle + (k / sides) * TAU;
      const r = radius * (1 + (random() - 0.5) * irregularity);
      const x = cx + Math.cos(a) * r * stretch;
      const y = cy + Math.sin(a) * r / stretch;
      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.globalAlpha = lerp(0.72, 0.96, random());
    ctx.fillStyle = css(color);
    ctx.fill();
    ctx.stroke();
  }

  // Pinpoint mineral flecks keep sparse/coarse settings from reading empty.
  ctx.globalAlpha = 0.72;
  for (let i = 0; i < Math.round(count * 0.55); i++) {
    const r = lerp(0.5, 1.65, random());
    ctx.beginPath();
    ctx.arc(random() * w, random() * h, r, 0, TAU);
    ctx.fillStyle = css(random() > 0.3 ? p.glow : p.trimLift);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function roundedTrace(
  ctx: CanvasRenderingContext2D,
  points: readonly (readonly [number, number])[],
  roundness: number
) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    const next = points[i + 1];
    const inX = lerp(cur[0], prev[0], roundness);
    const inY = lerp(cur[1], prev[1], roundness);
    const outX = lerp(cur[0], next[0], roundness);
    const outY = lerp(cur[1], next[1], roundness);
    ctx.lineTo(inX, inY);
    ctx.quadraticCurveTo(cur[0], cur[1], outX, outY);
  }
  const last = points[points.length - 1];
  ctx.lineTo(last[0], last[1]);
}

function paintCircuit(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: Palette,
  scale: number,
  warp: number,
  seed: number
) {
  fillBackground(ctx, w, h, p);
  const random = seededRandom(seed ^ 0xbb67ae85);
  const cell = lerp(w * 0.24, w * 0.085, scale);
  const traceCount = Math.round(lerp(7, 25, scale));

  // A quiet drafting grid underneath the luminous traces.
  ctx.lineWidth = Math.max(0.5, w / 300);
  ctx.strokeStyle = css(p.trimLift, 0.11);
  ctx.beginPath();
  for (let x = cell * 0.5; x < w; x += cell) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = cell * 0.5; y < h; y += cell) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  const terminals: [number, number, boolean][] = [];
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < traceCount; i++) {
    const vertical = random() > 0.28;
    const points: [number, number][] = [];
    let x = Math.round((random() * w) / cell) * cell;
    let y = Math.round((random() * h) / cell) * cell;
    if (vertical) y = -cell;
    else x = -cell;
    points.push([x, y]);
    const steps = 4 + Math.floor(random() * 6);

    for (let step = 0; step < steps; step++) {
      const jitter = (random() - 0.5) * cell * warp * 0.72;
      if (vertical) {
        y += cell * lerp(0.8, 2.3, random());
        points.push([x + jitter, y]);
        x = Math.min(w + cell, Math.max(-cell, x + (random() > 0.5 ? 1 : -1) * cell * (random() > 0.72 ? 2 : 1)));
        points.push([x, y + jitter * 0.35]);
      } else {
        x += cell * lerp(0.8, 2.3, random());
        points.push([x, y + jitter]);
        y = Math.min(h + cell, Math.max(-cell, y + (random() > 0.5 ? 1 : -1) * cell * (random() > 0.72 ? 2 : 1)));
        points.push([x + jitter * 0.35, y]);
      }
    }

    const luminous = i % 4 === 0 || random() > 0.82;
    ctx.strokeStyle = css(luminous ? p.glowLift : p.trimLift, luminous ? 0.92 : 0.7);
    ctx.lineWidth = luminous ? Math.max(1.5, w / 68) : Math.max(1, w / 96);
    ctx.shadowColor = luminous ? css(p.glow) : "transparent";
    ctx.shadowBlur = luminous ? lerp(2, 7, warp) : 0;
    roundedTrace(ctx, points, lerp(0.02, 0.19, warp));
    ctx.stroke();

    const terminal = points[points.length - 1];
    terminals.push([terminal[0], terminal[1], luminous]);
  }

  ctx.shadowBlur = 0;
  for (const [x, y, luminous] of terminals) {
    const radius = luminous ? Math.max(2.2, w / 40) : Math.max(1.5, w / 58);
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = css(luminous ? p.glowLift : p.trimLift);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.42, 0, TAU);
    ctx.fillStyle = css(p.deep);
    ctx.fill();
  }
}

type SurfaceFinish = {
  contrast: number;
  effect: "clean" | "grain" | "scanlines" | "prism";
  amount: number;
};

/** Authored finishing is part of each texture preset, not another user-facing
 *  layer. Values stay deliberately subtle so scale/warp remain the obvious
 *  visual controls while every preset still gets a distinct material feel. */
const SURFACE_FINISH: Record<BoardConfig["surface"], SurfaceFinish> = {
  aurora: { contrast: 0.55, effect: "grain", amount: 0.18 },
  topo: { contrast: 0.54, effect: "clean", amount: 0 },
  terrazzo: { contrast: 0.56, effect: "grain", amount: 0.14 },
  circuit: { contrast: 0.62, effect: "scanlines", amount: 0.2 },
  plasma: { contrast: 0.58, effect: "prism", amount: 0.18 }
};

/**
 * One deterministic post stack shared by every preset. This only runs when the
 * caller asks for a repaint, never from the board's animation loop.
 */
function applySurfaceFinish(
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  p: Palette,
  surface: BoardConfig["surface"],
  seed: number
) {
  const { width: w, height: h } = canvas;
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  const finish = SURFACE_FINISH[surface];
  const contrast = finish.contrast;
  const contrastGain = contrast < 0.5
    ? lerp(0.55, 1, contrast * 2)
    : lerp(1, 1.8, (contrast - 0.5) * 2);

  if (Math.abs(contrastGain - 1) > 1e-6) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const adjusted = (luma - 128) * contrastGain + 128;
      const delta = adjusted - luma;
      data[i] = r + delta;
      data[i + 1] = g + delta;
      data[i + 2] = b + delta;
    }
  }

  const amount = finish.amount;
  if (amount > 0 && finish.effect === "grain") {
    const grainSeed = seed ^ 0x2d8f31a7;
    for (let y = 0, i = 0; y < h; y++) {
      for (let x = 0; x < w; x++, i += 4) {
        const fine = hash2(x, y, grainSeed) - 0.5;
        const coarse = hash2(x >> 1, y >> 1, grainSeed ^ 0x6a09e667) - 0.5;
        const grain = (fine * 1.6 + coarse * 0.4) * amount * 34;
        data[i] += grain;
        data[i + 1] += grain;
        data[i + 2] += grain;
      }
    }
  } else if (amount > 0 && finish.effect === "scanlines") {
    const spacing = lerp(8, 3.2, amount);
    const phase = hash2(13, 61, seed ^ 0x9e3779b9) * spacing;
    for (let y = 0, i = 0; y < h; y++) {
      const wave = 0.5 + 0.5 * Math.cos(((y + phase) / spacing) * TAU);
      const dark = smoothstep(0.58, 0.96, wave) * amount * 0.36;
      const shine = smoothstep(0.82, 0.995, 1 - wave) * amount * 0.1;
      for (let x = 0; x < w; x++, i += 4) {
        data[i] = lerp(lerp(data[i], p.deep[0], dark), p.glowLift[0], shine);
        data[i + 1] = lerp(lerp(data[i + 1], p.deep[1], dark), p.glowLift[1], shine);
        data[i + 2] = lerp(lerp(data[i + 2], p.deep[2], dark), p.glowLift[2], shine);
      }
    }
  } else if (amount > 0 && finish.effect === "prism") {
    // Work from a frozen, already-contrasted source so neighbouring reads do not
    // feed back into later pixels. Clamp at the edges: board textures are not
    // required to tile, and a wrapped seam would be much more conspicuous.
    const source = data.slice();
    const phase = hash2(71, 19, seed ^ 0x85ebca6b) * TAU;
    for (let y = 0, i = 0; y < h; y++) {
      const rowWave = 0.5 + 0.5 * Math.sin((y / Math.max(1, h - 1)) * TAU * 2.3 + phase);
      const shift = Math.round(amount * lerp(1.5, 7, rowWave));
      for (let x = 0; x < w; x++, i += 4) {
        const redX = Math.min(w - 1, x + shift);
        const blueX = Math.max(0, x - shift);
        const red = source[(y * w + redX) * 4];
        const blue = source[(y * w + blueX) * 4 + 2];
        const split = amount * (0.58 + rowWave * 0.22);
        data[i] = lerp(source[i], red, split);
        data[i + 1] = source[i + 1];
        data[i + 2] = lerp(source[i + 2], blue, split);
      }
    }
  }

  ctx.putImageData(image, 0, 0);
}

/**
 * Paint the board's procedural color surface into a caller-owned canvas.
 * Inputs are deliberately compact and quantized so the exact same board can be
 * reconstructed for remote riders. The caller owns scheduling; this function
 * is fast enough for a requestAnimationFrame-throttled 128 x 256 preview.
 */
export function paintBoardSurface(canvas: HTMLCanvasElement, config: BoardConfig): void {
  if (canvas.width <= 0 || canvas.height <= 0) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const p = palette(config);
  const scale = clamp01(config.surfaceScale / 100);
  const warp = clamp01(config.surfaceWarp / 100);
  const seed = config.surfaceSeed >>> 0;

  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  ctx.shadowBlur = 0;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (config.surface === "topo") {
    paintTopo(canvas, ctx, p, scale, warp, seed);
  } else if (config.surface === "terrazzo") {
    paintTerrazzo(ctx, canvas.width, canvas.height, p, scale, warp, seed);
  } else if (config.surface === "circuit") {
    paintCircuit(ctx, canvas.width, canvas.height, p, scale, warp, seed);
  } else if (config.surface === "plasma") {
    paintPlasma(canvas, ctx, p, scale, warp, seed);
  } else {
    paintAurora(canvas, ctx, p, scale, warp, seed);
  }

  applySurfaceFinish(canvas, ctx, p, config.surface, seed);

  ctx.restore();
}
