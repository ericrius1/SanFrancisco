#!/usr/bin/env node

// The pictures that hang in the Sutro hall's timber gallery: eight
// chromolithographs in the language the baths actually advertised themselves in,
// published as WebP under public/sutro/art/.
//
//   node tools/build-sutro-hall-art.mjs [--preview]
//
// TWO SOURCES, ONE PIPELINE
// A plate is PRINTED from `assets-src/sutro-hall-art/<name>.png` when that file
// exists, and DRAWN in code when it does not. The authored plates are the ones
// hanging today — generated with an image model against the briefs kept beside
// them in that directory — and they take a cover crop to the plate aspect and
// nothing else, because they already carry their own aged stock.
//
// The drawn fallback below is not dead weight: it is what any machine without an
// image model can still bake, it defines every plate's aspect, name and caption,
// and it is the reference for the house style — an 1890s chromolithograph IS
// flat spot colour, hard silhouettes, sunburst rays, stipple shading and
// Didot/Bodoni display type on cream stock, all of which vector work renders
// honestly. Delete a source PNG and that plate simply reverts to it.
//
// Type comes from the system's period faces — Didot and Bodoni 72 for display,
// Copperplate for the small caps rules, Baskerville for body lines, Snell
// Roundhand for the one script flourish. They are resolved at BAKE time, so the
// published WebP carries the artwork and the app never asks for a font.
//
// KTX2: tools/optimize-textures.mjs needs `toktx`, absent here, so these publish
// WebP only and the runtime loads them with { webpOnly: true }.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "assets-src/sutro-hall-art");
const STAGING = path.join(ROOT, ".data/sutro-hall-art");
const PLATE_STAGING = path.join(STAGING, "plates");
const OUTPUT = path.join(ROOT, "public/sutro/art");
const OPTIMIZER = path.join(ROOT, "tools/optimize-textures.mjs");

/** Rasterise at 2x and land at these, so line work reads litho-crisp. */
const WIDE = { w: 768, h: 512 };
const TALL = { w: 512, h: 768 };
const SUPERSAMPLE = 2;

// ---------------------------------------------------------------------------
// the ink box — every plate is drawn from these, the way a press run would be
// ---------------------------------------------------------------------------

const INK = {
  paper: "#f2e3c4",
  paperDeep: "#e6d2ac",
  cream: "#f7eed6",
  ink: "#2b1c14",
  sepia: "#5c3a24",
  terracotta: "#a8412a",
  terracottaDeep: "#7d2a1c",
  coral: "#e07a4e",
  gold: "#e8ab3f",
  goldPale: "#f2cd7c",
  teal: "#1f6b6b",
  tealDeep: "#12454a",
  tealPale: "#6fa8a0",
  seaGreen: "#2e7f6d",
  moss: "#4d6b3a",
  mossDeep: "#31491f",
  indigo: "#1b2b45",
  indigoDeep: "#111c2e",
  plum: "#6b2b47"
};

const FONT_DISPLAY = "Didot, Bodoni 72, Times New Roman, serif";
const FONT_BODONI = "Bodoni 72, Didot, Times New Roman, serif";
const FONT_CAPS = "Copperplate, Optima, sans-serif";
const FONT_BODY = "Baskerville, Times New Roman, serif";
const FONT_SCRIPT = "Snell Roundhand, Zapfino, cursive";

const round = (value) => Math.round(value * 100) / 100;

/** Deterministic per-plate randomness — reruns must produce identical plates. */
function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

const text = (
  content,
  { x, y, size, font = FONT_DISPLAY, fill = INK.ink, spacing = 0, anchor = "middle", weight = "normal", style = "normal", opacity = 1 }
) =>
  `<text x="${round(x)}" y="${round(y)}" font-family="${font}" font-size="${round(size)}" ` +
  `fill="${fill}" letter-spacing="${round(spacing)}" text-anchor="${anchor}" ` +
  `font-weight="${weight}" font-style="${style}" opacity="${opacity}">${content}</text>`;

/** Stipple screens: the litho way of shading a flat ink. */
function halftoneDefs() {
  const screens = [
    ["screenInkFine", INK.ink, 5, 1.05],
    ["screenSepia", INK.sepia, 6, 1.35],
    ["screenTeal", INK.tealDeep, 6, 1.4],
    ["screenGold", INK.gold, 7, 1.7],
    ["screenTerra", INK.terracottaDeep, 6, 1.45],
    ["screenCream", INK.cream, 6, 1.6]
  ];
  return screens
    .map(
      ([id, colour, spacing, radius]) =>
        `<pattern id="${id}" width="${spacing}" height="${spacing}" patternUnits="userSpaceOnUse">` +
        `<circle cx="${spacing / 2}" cy="${spacing / 2}" r="${radius}" fill="${colour}"/></pattern>`
    )
    .join("");
}

/** The plate border: double rule, inner hairline, corner fleurons. */
function plateBorder(w, h, { ruleColour = INK.sepia, corner = INK.terracotta } = {}) {
  const m = Math.round(Math.min(w, h) * 0.035);
  const inner = m + 7;
  const fleuron = (cx, cy, flipX, flipY) =>
    `<g transform="translate(${cx} ${cy}) scale(${flipX} ${flipY})" fill="${corner}">` +
    `<path d="M0 0 L16 0 Q6 2 4 12 Q2 4 0 0 Z"/>` +
    `<circle cx="4.2" cy="4.2" r="2.1"/>` +
    `<path d="M9 9 Q17 11 19 19 Q11 17 9 9 Z" opacity="0.75"/>` +
    `</g>`;
  return (
    `<rect x="${m}" y="${m}" width="${w - m * 2}" height="${h - m * 2}" fill="none" ` +
    `stroke="${ruleColour}" stroke-width="2.4"/>` +
    `<rect x="${inner}" y="${inner}" width="${w - inner * 2}" height="${h - inner * 2}" fill="none" ` +
    `stroke="${ruleColour}" stroke-width="0.7" opacity="0.8"/>` +
    fleuron(inner + 3, inner + 3, 1, 1) +
    fleuron(w - inner - 3, inner + 3, -1, 1) +
    fleuron(inner + 3, h - inner - 3, 1, -1) +
    fleuron(w - inner - 3, h - inner - 3, -1, -1)
  );
}

/** Sunburst rays: alternating wedges from a centre, the period's whole idea of light. */
function sunburst(cx, cy, radius, count, colour, opacity, seed = 3) {
  const random = rng(seed);
  const wedges = [];
  for (let index = 0; index < count; index++) {
    const a0 = (index / count) * Math.PI * 2;
    const spread = ((Math.PI * 2) / count) * (0.3 + random() * 0.24);
    const reach = radius * (0.72 + random() * 0.42);
    const x1 = cx + Math.cos(a0 - spread) * reach;
    const y1 = cy + Math.sin(a0 - spread) * reach;
    const x2 = cx + Math.cos(a0 + spread) * reach;
    const y2 = cy + Math.sin(a0 + spread) * reach;
    wedges.push(`M${round(cx)} ${round(cy)} L${round(x1)} ${round(y1)} L${round(x2)} ${round(y2)} Z`);
  }
  return `<path d="${wedges.join(" ")}" fill="${colour}" opacity="${opacity}"/>`;
}

/** A run of foam scallops along a wave crest. */
function foam(y, w, amplitude, step, colour, opacity = 1, seed = 11) {
  const random = rng(seed);
  const parts = [];
  for (let x = -step; x < w + step; x += step) {
    const lift = amplitude * (0.6 + random() * 0.8);
    parts.push(
      `M${round(x)} ${round(y)} q${round(step / 2)} ${round(-lift)} ${round(step)} 0`
    );
  }
  return `<path d="${parts.join(" ")}" fill="none" stroke="${colour}" stroke-width="${round(
    amplitude * 0.5
  )}" opacity="${opacity}" stroke-linecap="round"/>`;
}

/** Sea as stacked bands, darkest at the horizon — flat spot colour, no gradients. */
function seaBands(y0, y1, w, colours, seed = 5) {
  const random = rng(seed);
  const bands = [];
  const count = colours.length;
  for (let index = 0; index < count; index++) {
    const top = y0 + ((y1 - y0) * index) / count;
    const bottom = y0 + ((y1 - y0) * (index + 1)) / count + 1;
    const wobble = 2 + random() * 3;
    bands.push(
      `<path d="M0 ${round(top + wobble)} Q${round(w * 0.25)} ${round(top - wobble)} ` +
        `${round(w * 0.5)} ${round(top + wobble * 0.5)} T${round(w)} ${round(top)} ` +
        `L${round(w)} ${round(bottom)} L0 ${round(bottom)} Z" fill="${colours[index]}"/>`
    );
  }
  return bands.join("");
}

/** Gulls: three strokes each, which is all a gull ever needs on a poster. */
function gulls(list, colour) {
  return list
    .map(([x, y, s]) => {
      const scale = s ?? 1;
      return (
        `<path d="M${round(x - 9 * scale)} ${round(y)} q${round(4.5 * scale)} ${round(
          -5 * scale
        )} ${round(9 * scale)} 0 q${round(4.5 * scale)} ${round(-5 * scale)} ${round(
          9 * scale
        )} 0" fill="none" stroke="${colour}" stroke-width="${round(1.6 * scale)}" ` +
        `stroke-linecap="round"/>`
      );
    })
    .join("");
}

/** A palm: layered fronds off a leaning trunk. */
function palm(x, baseY, height, spread, trunkColour, frondColours, seed = 7) {
  const random = rng(seed);
  const lean = (random() - 0.5) * height * 0.16;
  const topX = x + lean;
  const topY = baseY - height;
  const parts = [
    `<path d="M${round(x - height * 0.035)} ${round(baseY)} Q${round(x + lean * 0.4)} ${round(
      baseY - height * 0.55
    )} ${round(topX - height * 0.012)} ${round(topY)} L${round(topX + height * 0.012)} ${round(
      topY
    )} Q${round(x + lean * 0.4 + height * 0.03)} ${round(baseY - height * 0.55)} ${round(
      x + height * 0.035
    )} ${round(baseY)} Z" fill="${trunkColour}"/>`
  ];
  const fronds = 9;
  for (let index = 0; index < fronds; index++) {
    const angle = Math.PI + (index / (fronds - 1)) * Math.PI;
    const reach = spread * (0.72 + random() * 0.5);
    const droop = spread * (0.32 + random() * 0.4);
    const tipX = topX + Math.cos(angle) * reach;
    const tipY = topY + Math.sin(angle) * reach * 0.55 + droop;
    const midX = topX + Math.cos(angle) * reach * 0.5;
    const midY = topY + Math.sin(angle) * reach * 0.3 - droop * 0.25;
    const colour = frondColours[index % frondColours.length];
    const width = spread * 0.17;
    parts.push(
      `<path d="M${round(topX)} ${round(topY)} Q${round(midX)} ${round(midY - width)} ${round(
        tipX
      )} ${round(tipY)} Q${round(midX)} ${round(midY + width)} ${round(topX)} ${round(
        topY + 3
      )} Z" fill="${colour}"/>`
    );
  }
  parts.push(`<circle cx="${round(topX)}" cy="${round(topY)}" r="${round(spread * 0.07)}" fill="${trunkColour}"/>`);
  return parts.join("");
}

/** A period bather in silhouette — standing, arms at rest or raised. */
function figure(x, baseY, height, colour, { arms = "rest", hat = false, skirt = false } = {}) {
  const unit = height / 8;
  const headR = unit * 0.62;
  const parts = [
    `<circle cx="${round(x)}" cy="${round(baseY - height + headR)}" r="${round(headR)}" fill="${colour}"/>`
  ];
  const shoulderY = baseY - height + headR * 2.1;
  const hipY = baseY - height * 0.46;
  parts.push(
    `<path d="M${round(x - unit * 0.72)} ${round(shoulderY)} L${round(x + unit * 0.72)} ${round(
      shoulderY
    )} L${round(x + unit * 0.6)} ${round(hipY)} L${round(x - unit * 0.6)} ${round(hipY)} Z" fill="${colour}"/>`
  );
  if (skirt) {
    parts.push(
      `<path d="M${round(x - unit * 0.62)} ${round(hipY)} L${round(x + unit * 0.62)} ${round(
        hipY
      )} L${round(x + unit * 1.35)} ${round(baseY)} L${round(x - unit * 1.35)} ${round(baseY)} Z" fill="${colour}"/>`
    );
  } else {
    parts.push(
      `<path d="M${round(x - unit * 0.52)} ${round(hipY)} L${round(x - unit * 0.1)} ${round(
        hipY
      )} L${round(x - unit * 0.16)} ${round(baseY)} L${round(x - unit * 0.62)} ${round(baseY)} Z" fill="${colour}"/>` +
        `<path d="M${round(x + unit * 0.1)} ${round(hipY)} L${round(x + unit * 0.52)} ${round(
          hipY
        )} L${round(x + unit * 0.62)} ${round(baseY)} L${round(x + unit * 0.16)} ${round(baseY)} Z" fill="${colour}"/>`
    );
  }
  if (arms === "raised") {
    parts.push(
      `<path d="M${round(x - unit * 0.66)} ${round(shoulderY + unit * 0.1)} L${round(
        x - unit * 1.5
      )} ${round(shoulderY - unit * 1.5)} L${round(x - unit * 1.15)} ${round(
        shoulderY - unit * 1.75
      )} L${round(x - unit * 0.4)} ${round(shoulderY - unit * 0.1)} Z" fill="${colour}"/>` +
        `<path d="M${round(x + unit * 0.66)} ${round(shoulderY + unit * 0.1)} L${round(
          x + unit * 1.5
        )} ${round(shoulderY - unit * 1.5)} L${round(x + unit * 1.15)} ${round(
          shoulderY - unit * 1.75
        )} L${round(x + unit * 0.4)} ${round(shoulderY - unit * 0.1)} Z" fill="${colour}"/>`
    );
  } else {
    parts.push(
      `<path d="M${round(x - unit * 0.72)} ${round(shoulderY)} L${round(x - unit * 1.05)} ${round(
        hipY + unit * 0.2
      )} L${round(x - unit * 0.7)} ${round(hipY + unit * 0.25)} L${round(x - unit * 0.5)} ${round(
        shoulderY + unit * 0.2
      )} Z" fill="${colour}"/>` +
        `<path d="M${round(x + unit * 0.72)} ${round(shoulderY)} L${round(x + unit * 1.05)} ${round(
          hipY + unit * 0.2
        )} L${round(x + unit * 0.7)} ${round(hipY + unit * 0.25)} L${round(
          x + unit * 0.5
        )} ${round(shoulderY + unit * 0.2)} Z" fill="${colour}"/>`
    );
  }
  if (hat) {
    parts.push(
      `<path d="M${round(x - headR * 2)} ${round(baseY - height + headR * 0.75)} L${round(
        x + headR * 2
      )} ${round(baseY - height + headR * 0.75)} L${round(x + headR * 0.9)} ${round(
        baseY - height - headR * 0.5
      )} L${round(x - headR * 0.9)} ${round(baseY - height - headR * 0.5)} Z" fill="${colour}"/>`
    );
  }
  return parts.join("");
}

/**
 * A dive, in silhouette: head tucked between swept arms, legs together, toes
 * pointed. `scale` is the figure's height in plate units, so the same shape
 * serves a medallion vignette and a full-plate hero.
 */
function diver(x, y, height, colour, rotate = 0) {
  const u = height / 100;
  return (
    `<g transform="translate(${round(x)} ${round(y)}) rotate(${round(rotate)}) scale(${round(u)})" fill="${colour}">` +
    // head, tucked — drawn first so the arms close over it
    `<circle cx="0" cy="-24" r="8.5"/>` +
    // torso tapering into the hips
    `<path d="M-8.5 -20 L8.5 -20 L6.5 8 L-6.5 8 Z"/>` +
    // legs together, toes pointed: one silhouette, split by a thin gap
    `<path d="M-6.5 6 L-0.8 6 L-2.4 46 L-6 44 Z"/>` +
    `<path d="M0.8 6 L6.5 6 L6 44 L2.4 46 Z"/>` +
    `<path d="M-6 44 L-2.4 46 L-3.4 52 L-6.8 49 Z"/>` +
    `<path d="M2.4 46 L6 44 L6.8 49 L3.4 52 Z"/>` +
    // arms swept forward and CONVERGING into a point ahead of the head — this is
    // what makes the shape read as a dive instead of a jumping jack
    `<path d="M-8 -18 Q-14 -34 -2 -50 L2 -50 Q-6 -34 -2 -16 Z"/>` +
    `<path d="M8 -18 Q14 -34 2 -50 L-2 -50 Q6 -34 2 -16 Z"/>` +
    `</g>`
  );
}

// ---------------------------------------------------------------------------
// the plates
// ---------------------------------------------------------------------------

/** 1 — the hall itself, seen from the Pacific at the end of the day. */
function platePacificPlunge({ w, h }) {
  const horizon = h * 0.585;
  const hallBase = horizon - 4;
  const hallTop = h * 0.3;
  const hallLeft = w * 0.1;
  const hallRight = w * 0.9;
  const random = rng(21);

  const ribs = [];
  const bayCount = 15;
  for (let index = 0; index <= bayCount; index++) {
    const x = hallLeft + ((hallRight - hallLeft) * index) / bayCount;
    ribs.push(
      `<path d="M${round(x)} ${round(hallBase)} L${round(x)} ${round(
        hallTop + h * 0.02 + Math.abs(index - bayCount / 2) * (h * 0.006)
      )}" stroke="${INK.tealDeep}" stroke-width="${round(h * 0.004)}" opacity="0.85"/>`
    );
  }
  const roof =
    `<path d="M${round(hallLeft - 6)} ${round(hallBase)} L${round(hallLeft - 6)} ${round(
      hallTop + h * 0.09
    )} Q${round(w * 0.5)} ${round(hallTop - h * 0.13)} ${round(hallRight + 6)} ${round(
      hallTop + h * 0.09
    )} ` + `L${round(hallRight + 6)} ${round(hallBase)} Z" fill="${INK.tealPale}" opacity="0.92"/>`;
  const roofShade =
    `<path d="M${round(hallLeft - 6)} ${round(hallTop + h * 0.09)} Q${round(w * 0.5)} ${round(
      hallTop - h * 0.13
    )} ${round(hallRight + 6)} ${round(hallTop + h * 0.09)} Q${round(w * 0.5)} ${round(
      hallTop - h * 0.055
    )} ${round(hallLeft - 6)} ${round(hallTop + h * 0.09)} Z" fill="${INK.cream}" opacity="0.75"/>`;

  const surfLines = [];
  for (let index = 0; index < 7; index++) {
    const y = horizon + 12 + index * ((h - horizon - 26) / 7);
    surfLines.push(foam(y, w, 4 + index * 1.5, 26 + index * 9, INK.cream, 0.5 + index * 0.06, 30 + index));
  }

  // Foreground rock: one mass each side, a crag profile plus a lit top facet so
  // it reads as stone rather than a black blob. Proportional to the plate, so it
  // holds at any supersample factor.
  const rocks = (side) => {
    const flip = side === "left" ? 1 : -1;
    const x0 = side === "left" ? -w * 0.02 : w * 1.02;
    const step = w * 0.07 * flip;
    const peaks = [0.13, 0.22, 0.1, 0.19, 0.05];
    const points = [`M${round(x0)} ${round(h)}`];
    peaks.forEach((peak, index) => {
      points.push(`L${round(x0 + step * index)} ${round(h - h * peak)}`);
    });
    points.push(`L${round(x0 + step * peaks.length)} ${round(h)} Z`);
    const facet =
      `M${round(x0 + step * 0.6)} ${round(h - h * 0.16)} L${round(x0 + step * 1)} ${round(
        h - h * 0.22
      )} L${round(x0 + step * 1.5)} ${round(h - h * 0.12)} Z`;
    return (
      `<path d="${points.join(" ")}" fill="${INK.indigoDeep}"/>` +
      `<path d="${facet}" fill="${INK.sepia}" opacity="0.5"/>`
    );
  };
  const flags = [w * 0.16, w * 0.5, w * 0.84]
    .map((x, index) => {
      const poleTop = hallTop - (index === 1 ? h * 0.12 : h * 0.07);
      const poleBase = index === 1 ? hallTop - h * 0.05 : hallTop + h * 0.02;
      return (
        `<path d="M${round(x)} ${round(poleBase)} L${round(x)} ${round(poleTop)}" stroke="${
          INK.sepia
        }" stroke-width="${round(h * 0.005)}"/>` +
        `<path d="M${round(x)} ${round(poleTop)} L${round(x + w * 0.045)} ${round(
          poleTop + h * 0.018
        )} L${round(x)} ${round(poleTop + h * 0.036)} Z" fill="${INK.terracotta}"/>`
      );
    })
    .join("");

  return {
    background: INK.cream,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.cream}"/>` +
      `<rect y="0" width="${w}" height="${round(horizon)}" fill="${INK.goldPale}"/>` +
      `<rect y="0" width="${w}" height="${round(h * 0.26)}" fill="${INK.coral}" opacity="0.55"/>` +
      sunburst(w * 0.5, horizon - 6, w * 0.62, 26, INK.gold, 0.3, 9) +
      `<circle cx="${round(w * 0.5)}" cy="${round(horizon - 10)}" r="${round(h * 0.085)}" fill="${INK.gold}"/>` +
      gulls([[w * 0.16, h * 0.16, 1.15], [w * 0.24, h * 0.11, 0.85], [w * 0.8, h * 0.14, 1], [w * 0.87, h * 0.2, 0.7]], INK.sepia) +
      // Point Lobos headland behind the hall
      `<path d="M${round(w * 0.72)} ${round(horizon)} L${round(w * 0.82)} ${round(
        horizon - h * 0.14
      )} L${round(w * 0.93)} ${round(horizon - h * 0.07)} L${round(w)} ${round(
        horizon - h * 0.1
      )} L${round(w)} ${round(horizon)} Z" fill="${INK.mossDeep}" opacity="0.9"/>` +
      flags +
      roof +
      roofShade +
      ribs.join("") +
      // terracotta base wall with its arcade
      `<rect x="${round(hallLeft - 6)}" y="${round(hallBase - h * 0.1)}" width="${round(
        hallRight - hallLeft + 12
      )}" height="${round(h * 0.1)}" fill="${INK.terracotta}"/>` +
      `<rect x="${round(hallLeft - 6)}" y="${round(hallBase - h * 0.1)}" width="${round(
        hallRight - hallLeft + 12
      )}" height="${round(h * 0.1)}" fill="url(#screenTerra)" opacity="0.28"/>` +
      Array.from({ length: 12 }, (_unused, index) => {
        const bayWidth = (hallRight - hallLeft) / 12;
        const x = hallLeft + bayWidth * index + bayWidth * 0.25;
        return `<path d="M${round(x)} ${round(hallBase)} L${round(x)} ${round(
          hallBase - h * 0.055
        )} q${round(bayWidth * 0.25)} ${round(-h * 0.03)} ${round(bayWidth * 0.5)} 0 L${round(
          x + bayWidth * 0.5
        )} ${round(hallBase)} Z" fill="${INK.terracottaDeep}"/>`;
      }).join("") +
      seaBands(horizon, h, w, [INK.tealDeep, INK.teal, INK.seaGreen, INK.teal, INK.tealDeep], 5) +
      surfLines.join("") +
      rocks("left") +
      rocks("right") +
      plateBorder(w, h) +
      text("SUTRO BATHS", { x: w * 0.5, y: h * 0.155, size: h * 0.115, spacing: h * 0.012, fill: INK.terracottaDeep }) +
      text("ON THE PACIFIC AT POINT LOBOS", {
        x: w * 0.5,
        y: h * 0.205,
        size: h * 0.036,
        font: FONT_CAPS,
        spacing: h * 0.011,
        fill: INK.sepia
      }) +
      text("THE LARGEST BATHING ESTABLISHMENT IN THE WORLD", {
        x: w * 0.5,
        y: h * 0.955,
        size: h * 0.032,
        font: FONT_CAPS,
        spacing: h * 0.006,
        fill: INK.cream
      })
  };
}

/** 2 — Seal Rocks and the Cliff House, the view the baths were built beside. */
function plateSealRocks({ w, h }) {
  const horizon = h * 0.55;
  const random = rng(37);
  // Plate unit: everything drawn in absolute path coordinates is scaled by this,
  // so a vignette keeps its intended size at any supersample factor.
  const unit = h / 512;
  const spires = [];
  const houseLeft = w * 0.58;
  const houseRight = w * 0.95;
  const houseBase = horizon - h * 0.02;
  for (let index = 0; index < 6; index++) {
    const x = houseLeft + ((houseRight - houseLeft) * (index + 0.5)) / 6;
    const spireH = h * (0.1 + random() * 0.11);
    spires.push(
      `<path d="M${round(x - 13 * unit)} ${round(houseBase - h * 0.09)} L${round(x)} ${round(
        houseBase - h * 0.09 - spireH
      )} L${round(x + 13 * unit)} ${round(houseBase - h * 0.09)} Z" fill="${INK.indigo}"/>` +
        `<rect x="${round(x - 11 * unit)} " y="${round(houseBase - h * 0.115)}" width="${round(
          22 * unit
        )}" height="${round(h * 0.036)}" fill="${INK.indigo}"/>`
    );
  }
  const seals = [];
  const sealSpots = [
    [w * 0.2, h * 0.72, 1.25],
    [w * 0.27, h * 0.7, 1],
    [w * 0.13, h * 0.76, 1.1],
    [w * 0.35, h * 0.68, 0.85],
    [w * 0.42, h * 0.79, 1.15],
    [w * 0.08, h * 0.68, 0.8]
  ];
  for (const [x, y, s] of sealSpots) {
    seals.push(
      `<g transform="translate(${round(x)} ${round(y)}) scale(${round(s * unit)})" fill="${INK.ink}">` +
        `<path d="M-17 0 q4 -9 15 -9 q10 0 13 7 q4 -6 8 -2 q-3 3 -4 6 q3 2 2 4 l-34 0 z"/>` +
        `<circle cx="10" cy="-6" r="1.2" fill="${INK.paper}"/>` +
        `</g>`
    );
  }
  return {
    background: INK.paper,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.paper}"/>` +
      `<rect width="${w}" height="${round(horizon + 2)}" fill="${INK.goldPale}"/>` +
      `<rect width="${w}" height="${round(h * 0.3)}" fill="${INK.coral}" opacity="0.6"/>` +
      sunburst(w * 0.3, horizon - h * 0.06, w * 0.55, 22, INK.gold, 0.32, 15) +
      `<circle cx="${round(w * 0.3)}" cy="${round(horizon - h * 0.06)}" r="${round(h * 0.075)}" fill="${INK.gold}"/>` +
      `<rect width="${w}" height="${round(h * 0.18)}" fill="url(#screenGold)" opacity="0.22"/>` +
      gulls(
        [
          [w * 0.5, h * 0.16, 1.3],
          [w * 0.58, h * 0.1, 0.9],
          [w * 0.44, h * 0.24, 0.8],
          [w * 0.72, h * 0.3, 0.7],
          [w * 0.2, h * 0.2, 1]
        ],
        INK.sepia
      ) +
      // the bluff and the Cliff House
      `<path d="M${round(w * 0.52)} ${round(horizon)} L${round(w * 0.6)} ${round(
        houseBase - h * 0.06
      )} L${round(w)} ${round(houseBase - h * 0.08)} L${round(w)} ${round(horizon + 2)} Z" fill="${INK.mossDeep}"/>` +
      `<rect x="${round(houseLeft)}" y="${round(houseBase - h * 0.11)}" width="${round(
        houseRight - houseLeft
      )}" height="${round(h * 0.11)}" fill="${INK.indigo}"/>` +
      spires.join("") +
      Array.from({ length: 9 }, (_unused, index) => {
        const x = houseLeft + 8 + index * ((houseRight - houseLeft - 16) / 9);
        return `<rect x="${round(x)}" y="${round(houseBase - h * 0.075)}" width="${round(
          5 * unit
        )}" height="${round(8 * unit)}" fill="${INK.gold}" opacity="0.9"/>`;
      }).join("") +
      seaBands(horizon, h, w, [INK.tealDeep, INK.teal, INK.seaGreen, INK.tealDeep], 8) +
      foam(horizon + h * 0.06, w, 5, 30, INK.cream, 0.6, 22) +
      foam(horizon + h * 0.14, w, 7, 40, INK.cream, 0.5, 26) +
      // Seal Rocks
      `<path d="M${round(w * 0.03)} ${round(h * 0.82)} L${round(w * 0.1)} ${round(
        h * 0.62
      )} L${round(w * 0.16)} ${round(h * 0.7)} L${round(w * 0.23)} ${round(h * 0.6)} L${round(
        w * 0.3
      )} ${round(h * 0.72)} L${round(w * 0.36)} ${round(h * 0.63)} L${round(w * 0.46)} ${round(
        h * 0.84
      )} Z" fill="${INK.sepia}"/>` +
      `<path d="M${round(w * 0.03)} ${round(h * 0.82)} L${round(w * 0.1)} ${round(
        h * 0.62
      )} L${round(w * 0.16)} ${round(h * 0.7)} L${round(w * 0.23)} ${round(h * 0.6)} L${round(
        w * 0.3
      )} ${round(h * 0.72)} L${round(w * 0.36)} ${round(h * 0.63)} L${round(w * 0.46)} ${round(
        h * 0.84
      )} Z" fill="url(#screenInkFine)" opacity="0.35"/>` +
      seals.join("") +
      foam(h * 0.86, w, 8, 34, INK.cream, 0.85, 44) +
      `<rect y="${round(h * 0.88)}" width="${w}" height="${round(h * 0.12)}" fill="${INK.tealDeep}"/>` +
      plateBorder(w, h, { ruleColour: INK.indigo, corner: INK.gold }) +
      text("SEAL ROCKS", { x: w * 0.5, y: h * 0.145, size: h * 0.1, spacing: h * 0.014, fill: INK.indigoDeep }) +
      text("&amp; THE CLIFF HOUSE", {
        x: w * 0.5,
        y: h * 0.2,
        size: h * 0.042,
        font: FONT_CAPS,
        spacing: h * 0.012,
        fill: INK.terracottaDeep
      }) +
      text("A FEW STEPS FROM THE BATHS", {
        x: w * 0.5,
        y: h * 0.955,
        size: h * 0.031,
        font: FONT_CAPS,
        spacing: h * 0.008,
        fill: INK.goldPale
      })
  };
}

/** 3 — the night carnival: lanterns, a lit plunge, a crowd in silhouette. */
function plateCarnivalNight({ w, h }) {
  const random = rng(53);
  const poolTop = h * 0.55;
  const lanternStrings = [];
  for (let row = 0; row < 3; row++) {
    const y = h * (0.17 + row * 0.075);
    const sag = h * (0.05 + row * 0.012);
    lanternStrings.push(
      `<path d="M0 ${round(y)} Q${round(w * 0.5)} ${round(y + sag)} ${round(w)} ${round(
        y
      )}" fill="none" stroke="${INK.sepia}" stroke-width="1.1" opacity="0.75"/>`
    );
    const count = 13 + row * 3;
    for (let index = 0; index <= count; index++) {
      const t = index / count;
      const x = t * w;
      const ly = y + Math.sin(Math.PI * t) * sag;
      const r = 3.4 + random() * 1.8;
      const colour = [INK.gold, INK.coral, INK.goldPale, INK.terracotta][index % 4];
      lanternStrings.push(
        `<circle cx="${round(x)}" cy="${round(ly + r)}" r="${round(r)}" fill="${colour}" opacity="0.95"/>` +
          `<circle cx="${round(x)}" cy="${round(ly + r)}" r="${round(r * 2.6)}" fill="${colour}" opacity="0.16"/>`
      );
    }
  }
  const bursts = [];
  for (const [cx, cy, r, colour] of [
    [w * 0.2, h * 0.15, h * 0.11, INK.goldPale],
    [w * 0.82, h * 0.12, h * 0.085, INK.coral]
  ]) {
    const rays = [];
    for (let index = 0; index < 22; index++) {
      const angle = (index / 22) * Math.PI * 2;
      const reach = r * (0.6 + rng(index + 3)() * 0.7);
      rays.push(
        `M${round(cx)} ${round(cy)} L${round(cx + Math.cos(angle) * reach)} ${round(
          cy + Math.sin(angle) * reach
        )}`
      );
    }
    bursts.push(
      `<path d="${rays.join(" ")}" stroke="${colour}" stroke-width="1.2" opacity="0.8" fill="none"/>` +
        Array.from({ length: 22 }, (_unused, index) => {
          const angle = (index / 22) * Math.PI * 2;
          const reach = r * (0.6 + rng(index + 3)() * 0.7);
          return `<circle cx="${round(cx + Math.cos(angle) * reach)}" cy="${round(
            cy + Math.sin(angle) * reach
          )}" r="1.7" fill="${colour}"/>`;
        }).join("")
    );
  }
  const crowd = [];
  for (let index = 0; index < 26; index++) {
    const x = 8 + index * (w / 26) + random() * 6;
    const height = h * (0.1 + random() * 0.045);
    crowd.push(figure(x, poolTop - 2, height, INK.indigoDeep, { hat: random() > 0.45, skirt: random() > 0.6 }));
  }
  const swimmers = [];
  for (let index = 0; index < 9; index++) {
    const x = w * (0.08 + random() * 0.84);
    const y = poolTop + h * (0.08 + random() * 0.28);
    swimmers.push(
      `<circle cx="${round(x)}" cy="${round(y)}" r="${round(3 + random() * 1.6)}" fill="${INK.indigoDeep}"/>` +
        `<path d="M${round(x - 9)} ${round(y + 2)} q4.5 -4 9 0 q4.5 -4 9 0" fill="none" stroke="${INK.cream}" stroke-width="1.5" opacity="0.7"/>`
    );
  }
  return {
    background: INK.indigoDeep,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.indigoDeep}"/>` +
      `<rect width="${w}" height="${round(poolTop)}" fill="${INK.indigo}"/>` +
      // the barrel roof, читается as ribs against the night
      Array.from({ length: 17 }, (_unused, index) => {
        const x = (w / 16) * index;
        return `<path d="M${round(x)} ${round(poolTop)} Q${round(x)} ${round(h * 0.1)} ${round(
          w * 0.5
        )} ${round(h * 0.055)}" fill="none" stroke="${INK.tealDeep}" stroke-width="1" opacity="0.5"/>`;
      }).join("") +
      bursts.join("") +
      lanternStrings.join("") +
      crowd.join("") +
      // the lit plunge
      `<path d="M${round(w * 0.04)} ${round(poolTop)} L${round(w * 0.96)} ${round(
        poolTop
      )} L${round(w)} ${round(h * 0.94)} L0 ${round(h * 0.94)} Z" fill="${INK.teal}"/>` +
      `<path d="M${round(w * 0.04)} ${round(poolTop)} L${round(w * 0.96)} ${round(
        poolTop
      )} L${round(w)} ${round(h * 0.94)} L0 ${round(h * 0.94)} Z" fill="url(#screenCream)" opacity="0.14"/>` +
      Array.from({ length: 6 }, (_unused, index) => {
        const y = poolTop + ((h * 0.94 - poolTop) * (index + 0.5)) / 6;
        return foam(y, w, 3.5 + index, 30 + index * 7, INK.cream, 0.35 + index * 0.05, 70 + index);
      }).join("") +
      swimmers.join("") +
      `<rect y="${round(h * 0.94)}" width="${w}" height="${round(h * 0.06)}" fill="${INK.indigoDeep}"/>` +
      plateBorder(w, h, { ruleColour: INK.goldPale, corner: INK.coral }) +
      text("GRAND NIGHT CARNIVAL", {
        x: w * 0.5,
        y: h * 0.095,
        size: h * 0.082,
        spacing: h * 0.008,
        fill: INK.goldPale
      }) +
      text("ILLUMINATED SWIMMING · BANDS · FIREWORKS", {
        x: w * 0.5,
        y: h * 0.135,
        size: h * 0.03,
        font: FONT_CAPS,
        spacing: h * 0.008,
        fill: INK.coral
      }) +
      text("EVERY SATURDAY EVENING AT EIGHT", {
        x: w * 0.5,
        y: h * 0.975,
        size: h * 0.03,
        font: FONT_CAPS,
        spacing: h * 0.007,
        fill: INK.goldPale
      })
  };
}

/** 4 — the tropical conservatory: glass, palms, a fountain, parasols. */
function plateConservatoryPalms({ w, h }) {
  const floor = h * 0.82;
  const shafts = [];
  for (let index = 0; index < 5; index++) {
    const x = w * (0.1 + index * 0.2);
    shafts.push(
      `<path d="M${round(x)} ${round(h * 0.1)} L${round(x + w * 0.07)} ${round(
        h * 0.1
      )} L${round(x + w * 0.16)} ${round(floor)} L${round(x - w * 0.02)} ${round(
        floor
      )} Z" fill="${INK.goldPale}" opacity="0.22"/>`
    );
  }
  const arches = [];
  for (let index = 0; index < 6; index++) {
    const x0 = w * 0.04 + index * (w * 0.92) / 6;
    const x1 = x0 + (w * 0.92) / 6;
    arches.push(
      `<path d="M${round(x0)} ${round(h * 0.42)} Q${round((x0 + x1) / 2)} ${round(
        h * 0.11
      )} ${round(x1)} ${round(h * 0.42)}" fill="none" stroke="${INK.seaGreen}" stroke-width="2.2" opacity="0.85"/>` +
        `<path d="M${round((x0 + x1) / 2)} ${round(h * 0.135)} L${round((x0 + x1) / 2)} ${round(
          h * 0.42
        )}" stroke="${INK.seaGreen}" stroke-width="1.1" opacity="0.6"/>`
    );
  }
  return {
    background: INK.cream,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.cream}"/>` +
      `<rect width="${w}" height="${round(h * 0.5)}" fill="${INK.tealPale}" opacity="0.45"/>` +
      shafts.join("") +
      arches.join("") +
      `<rect y="${round(floor)}" width="${w}" height="${round(h - floor)}" fill="${INK.terracotta}"/>` +
      `<rect y="${round(floor)}" width="${w}" height="${round(h - floor)}" fill="url(#screenTerra)" opacity="0.3"/>` +
      Array.from({ length: 14 }, (_unused, index) => {
        const x = (w / 14) * index;
        return `<path d="M${round(x)} ${round(floor)} L${round(x + w / 28)} ${round(h)}" stroke="${INK.terracottaDeep}" stroke-width="1" opacity="0.5"/>`;
      }).join("") +
      // the fountain
      `<g>` +
      `<ellipse cx="${round(w * 0.5)}" cy="${round(floor + 6)}" rx="${round(w * 0.14)}" ry="${round(
        h * 0.032
      )}" fill="${INK.tealDeep}"/>` +
      `<ellipse cx="${round(w * 0.5)}" cy="${round(floor + 3)}" rx="${round(w * 0.125)}" ry="${round(
        h * 0.026
      )}" fill="${INK.tealPale}"/>` +
      `<rect x="${round(w * 0.487)}" y="${round(floor - h * 0.13)}" width="${round(w * 0.026)}" height="${round(
        h * 0.13
      )}" fill="${INK.cream}" stroke="${INK.sepia}" stroke-width="0.8"/>` +
      `<path d="M${round(w * 0.5)} ${round(floor - h * 0.16)} q${round(w * 0.05)} ${round(
        h * 0.04
      )} ${round(w * 0.035)} ${round(h * 0.13)}" fill="none" stroke="${INK.tealPale}" stroke-width="2"/>` +
      `<path d="M${round(w * 0.5)} ${round(floor - h * 0.16)} q${round(-w * 0.05)} ${round(
        h * 0.04
      )} ${round(-w * 0.035)} ${round(h * 0.13)}" fill="none" stroke="${INK.tealPale}" stroke-width="2"/>` +
      `</g>` +
      palm(w * 0.16, floor + 2, h * 0.56, w * 0.15, INK.sepia, [INK.moss, INK.seaGreen, INK.mossDeep], 3) +
      palm(w * 0.84, floor + 2, h * 0.5, w * 0.13, INK.sepia, [INK.seaGreen, INK.moss, INK.mossDeep], 12) +
      palm(w * 0.33, floor + 2, h * 0.36, w * 0.1, INK.sepia, [INK.mossDeep, INK.moss], 19) +
      palm(w * 0.68, floor + 2, h * 0.4, w * 0.11, INK.sepia, [INK.moss, INK.mossDeep], 27) +
      // planters and ferns along the floor
      Array.from({ length: 7 }, (_unused, index) => {
        const x = w * (0.08 + index * 0.14);
        const random = rng(90 + index);
        const fronds = Array.from({ length: 6 }, (_u, i) => {
          const angle = -Math.PI * (0.15 + (i / 5) * 0.7);
          const reach = h * (0.05 + random() * 0.035);
          return `<path d="M${round(x)} ${round(floor)} q${round(Math.cos(angle) * reach * 0.5)} ${round(
            Math.sin(angle) * reach
          )} ${round(Math.cos(angle) * reach)} ${round(Math.sin(angle) * reach * 0.6)}" fill="none" stroke="${
            INK.mossDeep
          }" stroke-width="2" stroke-linecap="round"/>`;
        }).join("");
        return fronds;
      }).join("") +
      figure(w * 0.42, floor + 4, h * 0.15, INK.sepia, { skirt: true, hat: true }) +
      `<path d="M${round(w * 0.42)} ${round(floor - h * 0.16)} q${round(w * 0.045)} ${round(
        -h * 0.03
      )} ${round(w * 0.09)} 0 z" fill="${INK.plum}" opacity="0.9"/>` +
      figure(w * 0.585, floor + 4, h * 0.14, INK.sepia, { hat: true }) +
      plateBorder(w, h, { ruleColour: INK.seaGreen, corner: INK.terracotta }) +
      text("THE TROPICAL CONSERVATORY", {
        x: w * 0.5,
        y: h * 0.085,
        size: h * 0.062,
        spacing: h * 0.006,
        fill: INK.mossDeep
      }) +
      text("PALMS · FERNS · A FOUNTAIN UNDER GLASS", {
        x: w * 0.5,
        y: h * 0.965,
        size: h * 0.03,
        font: FONT_CAPS,
        spacing: h * 0.007,
        fill: INK.cream
      })
  };
}

/** 5 — the opening bill: type, rules and a medallion. */
function plateGrandOpening({ w, h }) {
  const medallionY = h * 0.63;
  const medallionR = w * 0.24;
  return {
    background: INK.paper,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.paper}"/>` +
      `<rect width="${w}" height="${h}" fill="url(#screenGold)" opacity="0.1"/>` +
      plateBorder(w, h, { ruleColour: INK.terracottaDeep, corner: INK.gold }) +
      text("SUTRO", { x: w * 0.5, y: h * 0.175, size: h * 0.115, spacing: w * 0.02, fill: INK.terracottaDeep }) +
      text("BATHS", { x: w * 0.5, y: h * 0.265, size: h * 0.115, spacing: w * 0.02, fill: INK.terracottaDeep }) +
      `<path d="M${round(w * 0.14)} ${round(h * 0.295)} L${round(w * 0.86)} ${round(
        h * 0.295
      )}" stroke="${INK.sepia}" stroke-width="2"/>` +
      `<path d="M${round(w * 0.2)} ${round(h * 0.305)} L${round(w * 0.8)} ${round(
        h * 0.305
      )}" stroke="${INK.sepia}" stroke-width="0.8"/>` +
      text("GRAND OPENING", {
        x: w * 0.5,
        y: h * 0.355,
        size: h * 0.052,
        font: FONT_BODONI,
        spacing: w * 0.008,
        fill: INK.ink
      }) +
      text("Saturday, March the Fourteenth", {
        x: w * 0.5,
        y: h * 0.41,
        size: h * 0.046,
        font: FONT_SCRIPT,
        fill: INK.plum
      }) +
      text("MDCCCXCVI", {
        x: w * 0.5,
        y: h * 0.45,
        size: h * 0.03,
        font: FONT_CAPS,
        spacing: w * 0.014,
        fill: INK.sepia
      }) +
      // medallion: a swimmer under the glass roof
      `<circle cx="${round(w * 0.5)}" cy="${round(medallionY)}" r="${round(medallionR)}" fill="${INK.cream}" stroke="${
        INK.terracottaDeep
      }" stroke-width="2.5"/>` +
      `<circle cx="${round(w * 0.5)}" cy="${round(medallionY)}" r="${round(medallionR - 6)}" fill="none" stroke="${
        INK.gold
      }" stroke-width="1"/>` +
      `<clipPath id="medallion"><circle cx="${round(w * 0.5)}" cy="${round(medallionY)}" r="${round(
        medallionR - 8
      )}"/></clipPath>` +
      `<g clip-path="url(#medallion)">` +
      `<rect x="${round(w * 0.5 - medallionR)}" y="${round(medallionY - medallionR)}" width="${round(
        medallionR * 2
      )}" height="${round(medallionR * 2)}" fill="${INK.goldPale}" opacity="0.5"/>` +
      sunburst(w * 0.5, medallionY - medallionR * 0.35, medallionR * 1.5, 20, INK.gold, 0.35, 5) +
      `<path d="M${round(w * 0.5 - medallionR)} ${round(medallionY + medallionR * 0.25)} Q${round(
        w * 0.5
      )} ${round(medallionY - medallionR * 0.75)} ${round(w * 0.5 + medallionR)} ${round(
        medallionY + medallionR * 0.25
      )}" fill="none" stroke="${INK.tealDeep}" stroke-width="2"/>` +
      `<rect x="${round(w * 0.5 - medallionR)}" y="${round(medallionY + medallionR * 0.22)}" width="${round(
        medallionR * 2
      )}" height="${round(medallionR)}" fill="${INK.teal}"/>` +
      foam(medallionY + medallionR * 0.3, w, 4, 20, INK.cream, 0.7, 12) +
      diver(w * 0.5, medallionY - medallionR * 0.12, medallionR * 1.05, INK.ink, 34) +
      `</g>` +
      text("SEVEN BATHS · TWO THOUSAND", {
        x: w * 0.5,
        y: h * 0.862,
        size: h * 0.024,
        font: FONT_CAPS,
        spacing: w * 0.003,
        fill: INK.sepia
      }) +
      text("DRESSING ROOMS UNDER ONE ROOF", {
        x: w * 0.5,
        y: h * 0.891,
        size: h * 0.024,
        font: FONT_CAPS,
        spacing: w * 0.003,
        fill: INK.sepia
      }) +
      text("Admission ten cents · cars to the door", {
        x: w * 0.5,
        y: h * 0.925,
        size: h * 0.026,
        font: FONT_BODY,
        style: "italic",
        fill: INK.ink
      }) +
      text("ADOLPH SUTRO, PROPRIETOR", {
        x: w * 0.5,
        y: h * 0.958,
        size: h * 0.02,
        font: FONT_CAPS,
        spacing: w * 0.005,
        fill: INK.terracottaDeep
      })
  };
}

/** 6 — the swimming carnival bill: a diver against a sunburst. */
function plateSwimmingCarnival({ w, h }) {
  const random = rng(71);
  const splash = [];
  for (let index = 0; index < 26; index++) {
    const x = w * 0.5 + (random() - 0.5) * w * 0.6;
    const y = h * 0.78 - random() * h * 0.12;
    splash.push(
      `<circle cx="${round(x)}" cy="${round(y)}" r="${round(1.4 + random() * 3.2)}" fill="${INK.cream}" opacity="${round(
        0.4 + random() * 0.5
      )}"/>`
    );
  }
  return {
    background: INK.tealDeep,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.tealDeep}"/>` +
      `<rect width="${w}" height="${round(h * 0.78)}" fill="${INK.teal}"/>` +
      sunburst(w * 0.5, h * 0.44, h * 0.5, 30, INK.goldPale, 0.42, 4) +
      `<circle cx="${round(w * 0.5)}" cy="${round(h * 0.44)}" r="${round(h * 0.16)}" fill="${INK.goldPale}"/>` +
      `<circle cx="${round(w * 0.5)}" cy="${round(h * 0.44)}" r="${round(h * 0.16)}" fill="url(#screenGold)" opacity="0.3"/>` +
      diver(w * 0.5, h * 0.47, h * 0.3, INK.indigoDeep, 22) +
      `<rect y="${round(h * 0.78)}" width="${w}" height="${round(h * 0.22)}" fill="${INK.indigo}"/>` +
      foam(h * 0.78, w, 9, 34, INK.cream, 0.9, 18) +
      foam(h * 0.83, w, 6, 26, INK.tealPale, 0.7, 24) +
      splash.join("") +
      plateBorder(w, h, { ruleColour: INK.goldPale, corner: INK.coral }) +
      text("GRAND", { x: w * 0.5, y: h * 0.13, size: h * 0.075, spacing: w * 0.03, fill: INK.cream }) +
      text("SWIMMING", { x: w * 0.5, y: h * 0.2, size: h * 0.085, spacing: w * 0.012, fill: INK.goldPale }) +
      text("CARNIVAL", { x: w * 0.5, y: h * 0.27, size: h * 0.085, spacing: w * 0.012, fill: INK.goldPale }) +
      `<path d="M${round(w * 0.18)} ${round(h * 0.295)} L${round(w * 0.82)} ${round(
        h * 0.295
      )}" stroke="${INK.cream}" stroke-width="1.6" opacity="0.8"/>` +
      text("SEVEN BATHS UNDER ONE ROOF", {
        x: w * 0.5,
        y: h * 0.735,
        size: h * 0.03,
        font: FONT_CAPS,
        spacing: w * 0.008,
        fill: INK.cream
      }) +
      text("HIGH DIVING FROM THE SPRING BOARDS", {
        x: w * 0.5,
        y: h * 0.93,
        size: h * 0.027,
        font: FONT_CAPS,
        spacing: w * 0.004,
        fill: INK.goldPale
      }) +
      text("AT THREE AND AT EIGHT O'CLOCK", {
        x: w * 0.5,
        y: h * 0.962,
        size: h * 0.024,
        font: FONT_BODY,
        fill: INK.cream
      })
  };
}

/** 7 — a botanical plate from the conservatory's own collection. */
function plateTropicalFerns({ w, h }) {
  const random = rng(89);
  const baseY = h * 0.8;
  const unit = h / 768;

  /**
   * One frond: a tapering rachis with FILLED pinnae down both sides.
   *
   * The first pass drew each leaflet as a stroked arc, which at plate scale came
   * out as a web of hairlines rather than a leaf — a botanical plate lives or
   * dies on the leaflets reading as solid shapes with a silhouette.
   */
  const frond = (x, y, length, angle, leafColour, veinColour) => {
    const tilt = angle;
    const curl = 0.34;
    const tipX = x + Math.cos(tilt) * length;
    const tipY = y + Math.sin(tilt) * length;
    const ctrlX = x + Math.cos(tilt) * length * 0.55 - Math.sin(tilt) * length * curl;
    const ctrlY = y + Math.sin(tilt) * length * 0.55 + Math.cos(tilt) * length * curl;
    const point = (t) => [
      (1 - t) * (1 - t) * x + 2 * (1 - t) * t * ctrlX + t * t * tipX,
      (1 - t) * (1 - t) * y + 2 * (1 - t) * t * ctrlY + t * t * tipY
    ];
    const tangent = (t) => {
      const dx = 2 * (1 - t) * (ctrlX - x) + 2 * t * (tipX - ctrlX);
      const dy = 2 * (1 - t) * (ctrlY - y) + 2 * t * (tipY - ctrlY);
      const len = Math.hypot(dx, dy) || 1;
      return [dx / len, dy / len];
    };
    const parts = [];
    const count = 17;
    for (let index = 1; index <= count; index++) {
      const t = index / (count + 1);
      const [px, py] = point(t);
      const [tx, ty] = tangent(t);
      // Pinnae are longest a third of the way out and shrink to the tip.
      const leaf = length * (0.07 + 0.115 * Math.sin(Math.PI * Math.min(1, t * 1.15)));
      for (const side of [1, -1]) {
        const nx = -ty * side;
        const ny = tx * side;
        const endX = px + nx * leaf + tx * leaf * 0.45;
        const endY = py + ny * leaf + ty * leaf * 0.45;
        const bulgeX = px + nx * leaf * 0.55 + tx * leaf * 0.05;
        const bulgeY = py + ny * leaf * 0.55 + ty * leaf * 0.05;
        const backX = px + nx * leaf * 0.4 + tx * leaf * 0.5;
        const backY = py + ny * leaf * 0.4 + ty * leaf * 0.5;
        parts.push(
          `<path d="M${round(px)} ${round(py)} Q${round(bulgeX)} ${round(bulgeY)} ${round(
            endX
          )} ${round(endY)} Q${round(backX)} ${round(backY)} ${round(px + tx * leaf * 0.16)} ${round(
            py + ty * leaf * 0.16
          )} Z" fill="${leafColour}"/>`
        );
      }
    }
    parts.push(
      `<path d="M${round(x)} ${round(y)} Q${round(ctrlX)} ${round(ctrlY)} ${round(tipX)} ${round(
        tipY
      )}" fill="none" stroke="${veinColour}" stroke-width="${round(3.4 * unit)}" stroke-linecap="round"/>`
    );
    return parts.join("");
  };

  const fronds = [];
  for (let index = 0; index < 5; index++) {
    const angle = -Math.PI * (0.22 + (index / 4) * 0.56);
    const pale = index % 2 === 0;
    fronds.push(
      frond(
        w * 0.46,
        baseY,
        h * (0.4 + random() * 0.12),
        angle,
        pale ? INK.seaGreen : INK.mossDeep,
        INK.mossDeep
      )
    );
  }
  // The crown of the trunk, so the fronds spring from something.
  fronds.push(
    `<path d="M${round(w * 0.46 - 17 * unit)} ${round(baseY + 26 * unit)} L${round(
      w * 0.46 + 17 * unit
    )} ${round(baseY + 26 * unit)} L${round(w * 0.46 + 11 * unit)} ${round(
      baseY - 20 * unit
    )} L${round(w * 0.46 - 11 * unit)} ${round(baseY - 20 * unit)} Z" fill="${INK.sepia}"/>`
  );
  return {
    background: INK.cream,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.cream}"/>` +
      `<rect width="${w}" height="${h}" fill="url(#screenCream)" opacity="0.25"/>` +
      fronds.join("") +
      // a bird of paradise, for the colour the ferns do not have
      `<g transform="translate(${round(w * 0.8)} ${round(h * 0.62)}) scale(${round(unit * 2.1)})">` +
      `<path d="M0 0 q-26 -6 -44 4 l6 -16 q22 -8 38 12 z" fill="${INK.mossDeep}"/>` +
      `<path d="M0 0 l30 -34 l4 10 l-24 26 z" fill="${INK.gold}"/>` +
      `<path d="M2 -4 l26 -46 l6 9 l-22 40 z" fill="${INK.coral}"/>` +
      `<path d="M4 -2 l34 -20 l1 10 l-30 15 z" fill="${INK.terracotta}"/>` +
      `<path d="M-2 2 q-4 30 4 54" fill="none" stroke="${INK.mossDeep}" stroke-width="3"/>` +
      `</g>` +
      // shells at the foot of the plate
      `<g transform="translate(${round(w * 0.24)} ${round(baseY + h * 0.055)}) scale(${round(unit * 1.7)})">` +
      `<path d="M0 0 q-22 -4 -26 -22 q14 -14 30 -6 q16 8 14 24 z" fill="${INK.paperDeep}" stroke="${INK.sepia}" stroke-width="1.1"/>` +
      Array.from({ length: 6 }, (_unused, index) =>
        `<path d="M${round(-24 + index * 4)} ${round(-20 + index * 2)} q12 12 26 16" fill="none" stroke="${
          INK.sepia
        }" stroke-width="0.7" opacity="0.7"/>`
      ).join("") +
      `</g>` +
      `<ellipse cx="${round(w * 0.5)}" cy="${round(baseY + 4)}" rx="${round(w * 0.2)}" ry="${round(
        h * 0.018
      )}" fill="${INK.sepia}" opacity="0.25"/>` +
      plateBorder(w, h, { ruleColour: INK.mossDeep, corner: INK.moss }) +
      `<rect x="${round(w * 0.18)}" y="${round(h * 0.87)}" width="${round(w * 0.64)}" height="${round(
        h * 0.075
      )}" fill="${INK.paper}" stroke="${INK.mossDeep}" stroke-width="1.2"/>` +
      text("SUTRO CONSERVATORY", {
        x: w * 0.5,
        y: h * 0.9,
        size: h * 0.026,
        font: FONT_CAPS,
        spacing: w * 0.01,
        fill: INK.mossDeep
      }) +
      text("Pacific Palms &amp; Tree Ferns", {
        x: w * 0.5,
        y: h * 0.932,
        size: h * 0.03,
        font: FONT_BODY,
        style: "italic",
        fill: INK.ink
      }) +
      text("PLATE XI", {
        x: w * 0.5,
        y: h * 0.078,
        size: h * 0.024,
        font: FONT_CAPS,
        spacing: w * 0.012,
        fill: INK.sepia
      })
  };
}

/** 8 — the museum's cabinet of marvels, four vignettes under one bill. */
function plateMuseumCurios({ w, h }) {
  // Plate unit: the four vignettes are drawn in absolute path coordinates and
  // scaled to the panel, so they fill it at any rasterisation size.
  const unit = (h / 768) * 2.1;
  const panelX = [w * 0.09, w * 0.53];
  const panelY = [h * 0.19, h * 0.52];
  const panelW = w * 0.38;
  const panelH = h * 0.28;
  const panel = (x, y, inner) =>
    `<rect x="${round(x)}" y="${round(y)}" width="${round(panelW)}" height="${round(
      panelH
    )}" fill="${INK.paperDeep}" stroke="${INK.sepia}" stroke-width="1.4"/>` +
    `<rect x="${round(x + 4)}" y="${round(y + 4)}" width="${round(panelW - 8)}" height="${round(
      panelH - 8
    )}" fill="none" stroke="${INK.gold}" stroke-width="0.7"/>` +
    inner;

  const ship =
    `<g transform="translate(${round(panelX[0] + panelW * 0.5)} ${round(panelY[0] + panelH * 0.72)}) scale(${round(unit)})" fill="${INK.sepia}">` +
    `<path d="M-52 0 q52 16 104 0 l-10 12 q-42 10 -84 0 z"/>` +
    `<rect x="-2" y="-58" width="4" height="58"/>` +
    `<path d="M2 -54 q30 12 26 30 l-26 6 z" fill="${INK.paper}" stroke="${INK.sepia}" stroke-width="1"/>` +
    `<path d="M-2 -46 q-26 10 -22 26 l22 5 z" fill="${INK.paper}" stroke="${INK.sepia}" stroke-width="1"/>` +
    `<path d="M-42 -4 L42 -4" stroke="${INK.terracottaDeep}" stroke-width="2"/>` +
    `</g>`;
  const mummy =
    `<g transform="translate(${round(panelX[1] + panelW * 0.5)} ${round(panelY[0] + panelH * 0.5)}) scale(${round(unit)})">` +
    // case: shoulders, tapered foot, domed head
    `<path d="M0 -74 q15 0 18 16 l4 12 q4 6 4 16 l-2 44 q-2 12 -24 12 q-22 0 -24 -12 l-2 -44 q0 -10 4 -16 l4 -12 q3 -16 18 -16 z" fill="${INK.gold}" stroke="${INK.sepia}" stroke-width="1.4"/>` +
    // nemes headdress
    `<path d="M-18 -58 q0 -18 18 -18 q18 0 18 18 l-6 6 q-12 -8 -24 0 z" fill="${INK.tealDeep}"/>` +
    // face mask
    `<path d="M0 -62 q11 0 11 14 q0 14 -11 16 q-11 -2 -11 -16 q0 -14 11 -14 z" fill="${INK.paperDeep}" stroke="${INK.sepia}" stroke-width="1"/>` +
    `<circle cx="-4.5" cy="-50" r="2" fill="${INK.ink}"/><circle cx="4.5" cy="-50" r="2" fill="${INK.ink}"/>` +
    `<path d="M-7 -42 q7 4 14 0" fill="none" stroke="${INK.ink}" stroke-width="1.2"/>` +
    // crossed arms
    `<path d="M-15 -26 L13 -16 L11 -10 L-17 -20 Z" fill="${INK.tealDeep}" opacity="0.9"/>` +
    `<path d="M15 -26 L-13 -16 L-11 -10 L17 -20 Z" fill="${INK.tealDeep}" opacity="0.9"/>` +
    Array.from({ length: 4 }, (_unused, index) =>
      `<path d="M-18 ${round(-4 + index * 12)} L18 ${round(-4 + index * 12)}" stroke="${INK.terracottaDeep}" stroke-width="1.6" opacity="0.8"/>`
    ).join("") +
    `</g>`;
  const nautilus =
    `<g transform="translate(${round(panelX[0] + panelW * 0.5)} ${round(panelY[1] + panelH * 0.55)}) scale(${round(unit)})">` +
    // logarithmic spiral: outer wall, then the septa that make it a nautilus
    (() => {
      const outer = [];
      const inner = [];
      const septa = [];
      const turns = 2.35;
      const steps = 90;
      for (let index = 0; index <= steps; index++) {
        const t = index / steps;
        const angle = t * Math.PI * 2 * turns;
        const radius = 4 * Math.exp(2.05 * t);
        const width = radius * 0.34;
        const ox = Math.cos(angle) * (radius + width);
        const oy = Math.sin(angle) * (radius + width) * 0.92;
        const ix = Math.cos(angle) * Math.max(0, radius - width);
        const iy = Math.sin(angle) * Math.max(0, radius - width) * 0.92;
        outer.push(`${index === 0 ? "M" : "L"}${round(ox)} ${round(oy)}`);
        inner.push(`${round(ix)} ${round(iy)}`);
        if (index % 9 === 0 && t > 0.25) {
          septa.push(
            `<path d="M${round(ix)} ${round(iy)} L${round(ox)} ${round(oy)}" stroke="${
              INK.sepia
            }" stroke-width="0.9" opacity="0.75"/>`
          );
        }
      }
      const shell =
        outer.join(" ") + " L" + inner.reverse().join(" L") + " Z";
      return (
        `<path d="${shell}" fill="${INK.paperDeep}" stroke="${INK.sepia}" stroke-width="1.3"/>` +
        `<path d="${shell}" fill="url(#screenTerra)" opacity="0.22"/>` +
        septa.join("")
      );
    })() +
    `</g>`;
  const fan =
    `<g transform="translate(${round(panelX[1] + panelW * 0.5)} ${round(panelY[1] + panelH * 0.72)}) scale(${round(unit)})">` +
    Array.from({ length: 11 }, (_unused, index) => {
      const angle = Math.PI + (index / 10) * Math.PI;
      const reach = 62;
      return `<path d="M0 0 L${round(Math.cos(angle) * reach)} ${round(
        Math.sin(angle) * reach * 0.9
      )}" stroke="${INK.sepia}" stroke-width="1.2"/>`;
    }).join("") +
    `<path d="M-62 0 A62 56 0 0 1 62 0 z" fill="${INK.plum}" opacity="0.28"/>` +
    `<path d="M-44 0 A44 40 0 0 1 44 0" fill="none" stroke="${INK.terracottaDeep}" stroke-width="1.4"/>` +
    `<circle cx="0" cy="0" r="4" fill="${INK.sepia}"/>` +
    `</g>`;

  return {
    background: INK.paper,
    body:
      `<rect width="${w}" height="${h}" fill="${INK.paper}"/>` +
      `<rect width="${w}" height="${h}" fill="url(#screenSepia)" opacity="0.08"/>` +
      panel(panelX[0], panelY[0], ship) +
      panel(panelX[1], panelY[0], mummy) +
      panel(panelX[0], panelY[1], nautilus) +
      panel(panelX[1], panelY[1], fan) +
      plateBorder(w, h, { ruleColour: INK.sepia, corner: INK.plum }) +
      text("MUSEUM OF MARVELS", {
        x: w * 0.5,
        y: h * 0.115,
        size: h * 0.055,
        spacing: w * 0.006,
        fill: INK.plum
      }) +
      text("GATHERED BY MR SUTRO IN EVERY SEA", {
        x: w * 0.5,
        y: h * 0.155,
        size: h * 0.024,
        font: FONT_CAPS,
        spacing: w * 0.005,
        fill: INK.sepia
      }) +
      text("SHIPS OF THE PACIFIC · A PRINCESS OF EGYPT", {
        x: w * 0.5,
        y: h * 0.845,
        size: h * 0.022,
        font: FONT_BODY,
        fill: INK.ink
      }) +
      text("SHELLS · FANS · ARMOUR · TEN THOUSAND CURIOS", {
        x: w * 0.5,
        y: h * 0.875,
        size: h * 0.022,
        font: FONT_BODY,
        fill: INK.ink
      }) +
      text("FREE TO BATHERS", {
        x: w * 0.5,
        y: h * 0.93,
        size: h * 0.03,
        font: FONT_CAPS,
        spacing: w * 0.012,
        fill: INK.terracottaDeep
      })
  };
}

// `draw` is optional. The first eight plates carry a vector implementation and
// so survive on a machine with no image model; the plates added since are
// source-only, and a missing source for one of those is a hard error rather
// than a silently blank wall — see the bake loop.
const PLATES = [
  { name: "hall-pacific-plunge", size: WIDE, draw: platePacificPlunge },
  { name: "hall-seal-rocks", size: WIDE, draw: plateSealRocks },
  { name: "hall-carnival-night", size: WIDE, draw: plateCarnivalNight },
  { name: "hall-conservatory-palms", size: WIDE, draw: plateConservatoryPalms },
  { name: "bill-grand-opening", size: TALL, draw: plateGrandOpening },
  { name: "bill-swimming-carnival", size: TALL, draw: plateSwimmingCarnival },
  { name: "plate-tropical-ferns", size: TALL, draw: plateTropicalFerns },
  { name: "plate-museum-curios", size: TALL, draw: plateMuseumCurios },
  { name: "hall-toboggan-slides", size: WIDE },
  { name: "hall-tide-tunnel", size: WIDE },
  { name: "hall-sutro-heights", size: WIDE },
  { name: "hall-high-dive", size: TALL },
  { name: "bill-sutro-railroad", size: TALL },
  { name: "bill-bathing-suits", size: TALL },
  { name: "bill-winter-sea", size: TALL },
  { name: "plate-natatorium-section", size: TALL },
  { name: "plate-pacific-shells", size: TALL }
];

// ---------------------------------------------------------------------------
// paper: the pass that stops these looking like vector art
// ---------------------------------------------------------------------------

function hash2(ix, iy, seed) {
  let value = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 2246822519);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

const smooth = (t) => t * t * (3 - 2 * t);

function valueNoise(x, y, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);
  return (n00 + (n10 - n00) * fx) * (1 - fy) + (n01 + (n11 - n01) * fx) * fy;
}

/**
 * Laid paper, foxing and a printer's vignette, as a multiply layer.
 *
 * Chromolithographs are a hundred and thirty years old wherever they still
 * hang: the stock has tooth, the sheet has gone unevenly warm, and the corners
 * have caught more light than the middle. Without this pass the plates read as
 * clean SVG on a wall, which is the one thing they must not.
 */
function paperLayer(width, height, seed) {
  const buffer = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // fibre tooth: fine, slightly directional
      const tooth =
        valueNoise(x * 0.6, y * 0.22, seed) * 0.5 + valueNoise(x * 0.19, y * 0.61, seed + 7) * 0.5;
      // blotch: slow warm/cool drift across the sheet
      const blotch = valueNoise(x * 0.012, y * 0.012, seed + 31);
      // foxing: sparse rusty spots
      const foxField = valueNoise(x * 0.05, y * 0.05, seed + 61);
      const foxing = Math.max(0, foxField - 0.78) * 3.4;
      // vignette: a touch more light at the edges of the sheet
      const dx = (x / width - 0.5) * 2;
      const dy = (y / height - 0.5) * 2;
      const edge = Math.min(1, Math.hypot(dx, dy) / 1.35);
      const lift = 1 + edge * edge * 0.075;

      const base = 1 - 0.085 * (tooth - 0.5) - 0.05 * (blotch - 0.5);
      const r = base * lift * (1 - foxing * 0.1);
      const g = base * lift * (1 - foxing * 0.17) - 0.012 * (blotch - 0.5);
      const b = base * lift * (1 - foxing * 0.28) - 0.03 * (blotch - 0.5);
      const index = (y * width + x) * 3;
      buffer[index] = Math.max(0, Math.min(255, Math.round(r * 255)));
      buffer[index + 1] = Math.max(0, Math.min(255, Math.round(g * 255)));
      buffer[index + 2] = Math.max(0, Math.min(255, Math.round(b * 255)));
    }
  }
  return sharp(buffer, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

// ---------------------------------------------------------------------------

const preview = process.argv.includes("--preview");

rmSync(STAGING, { recursive: true, force: true });
mkdirSync(PLATE_STAGING, { recursive: true });
mkdirSync(OUTPUT, { recursive: true });

let plateIndex = 0;
for (const plate of PLATES) {
  plateIndex++;
  const bigW = plate.size.w * SUPERSAMPLE;
  const bigH = plate.size.h * SUPERSAMPLE;
  // WebP first: the archived plates are stored that way (see the directory's
  // README), with PNG accepted so a freshly generated plate can be dropped in
  // and baked without converting it first.
  const sourcePlate = [".webp", ".png"]
    .map((extension) => path.join(SOURCE, `${plate.name}${extension}`))
    .find((candidate) => existsSync(candidate));
  const hasSource = Boolean(sourcePlate);

  let printed;
  if (hasSource) {
    // An authored plate (assets-src/sutro-hall-art) wins over the drawn
    // fallback. It arrives already printed on aged stock, so it skips the paper
    // pass — running the generated tooth over a plate that has its own only
    // muddies it — and takes a cover crop to the plate aspect instead.
    printed = await sharp(sourcePlate)
      .resize(bigW, bigH, { fit: "cover", position: "centre", kernel: sharp.kernel.lanczos3 })
      .removeAlpha()
      .png()
      .toBuffer();
  } else if (!plate.draw) {
    // A source-only plate with no source is a wall with a hole in it. Fail
    // loudly and name the file to produce, rather than baking something blank.
    throw new Error(
      `${plate.name} has no vector fallback and no source. Generate it first:\n` +
        `  node tools/generate-sutro-art.mjs ${plate.name}\n` +
        `then accept it into ${path.relative(ROOT, SOURCE)}/${plate.name}.webp`
    );
  } else {
    const drawn = plate.draw({ w: bigW, h: bigH });
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${bigW}" height="${bigH}" ` +
      `viewBox="0 0 ${bigW} ${bigH}"><defs>${halftoneDefs()}</defs>${drawn.body}</svg>`;
    // density 72 makes librsvg treat the SVG's px units 1:1, so the raster lands
    // exactly on bigW × bigH and the paper layer composites without a resize.
    const art = await sharp(Buffer.from(svg), { density: 72 }).png().toBuffer();
    const paper = await paperLayer(bigW, bigH, 900 + plateIndex * 17);
    // sharp resizes BEFORE it composites within one pipeline, so the paper pass
    // has to finish in its own before the supersampled plate is brought down.
    printed = await sharp(art)
      .composite([{ input: paper, blend: "multiply" }])
      .png()
      .toBuffer();
  }

  const aged = await sharp(printed)
    .resize(plate.size.w, plate.size.h, { kernel: sharp.kernel.lanczos3 })
    .modulate({ saturation: 0.96 })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await sharp(aged).toFile(path.join(PLATE_STAGING, `${plate.name}.png`));
  if (preview) {
    await sharp(aged).toFile(path.join(STAGING, `preview-${plate.name}.png`));
  }
  console.log(
    `  ${hasSource ? "printed" : "drew   "} ${plate.name} (${plate.size.w}x${plate.size.h})` +
      `${hasSource ? " ← assets-src" : ""}`
  );
}

execFileSync(
  process.execPath,
  [OPTIMIZER, PLATE_STAGING, OUTPUT, "--max=768", "--webp-only"],
  { cwd: ROOT, stdio: "inherit" }
);

console.log(`sutro hall art ready in ${path.relative(ROOT, OUTPUT)} (${PLATES.length} plates)`);
