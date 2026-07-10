// Bake the Presidio Golf Course from raw Overpass captures into a compact
// world-space JSON the game streams at runtime (public/data/golf.json).
//
// Sources: data/raw/golf-presidio.json (ways, `out tags geom`) and
// data/raw/golf-presidio-rels.json (multipolygon relations, `out geom`).
// Frame: tools/geo.mjs local meters (+X east, +Z south). Heights are NOT
// baked — the runtime drapes onto WorldMap and plane-fits the greens.
//
// Usage: node tools/bake-golf.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { lonLatToLocal } from "./geo.mjs";

const RAW = JSON.parse(readFileSync("data/raw/golf-presidio.json", "utf8"));
const RELS = JSON.parse(readFileSync("data/raw/golf-presidio-rels.json", "utf8"));

const els = RAW.elements.filter((e) => e.type !== "relation").concat(RELS.elements);

const q = (v) => Math.round(v * 100) / 100; // cm precision keeps the file small
const toXZ = (g) => g.map((p) => lonLatToLocal(p.lon, p.lat).map(q));

// Drop consecutive duplicates + unclosed-ring tail dupes; keep rings open
// (renderer closes implicitly).
function ring(g) {
  const pts = toXZ(g);
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  if (out.length > 1) {
    const [a, b] = [out[0], out[out.length - 1]];
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

function centroid(r) {
  let x = 0;
  let z = 0;
  for (const p of r) {
    x += p[0];
    z += p[1];
  }
  return [x / r.length, z / r.length];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// Presidio Golf Course scorecard, March 2026. Geometry still comes from OSM;
// these are the authoritative current par/yardage/men's-handicap facts.
const OFFICIAL = {
  par: [4, 5, 4, 3, 4, 4, 3, 4, 5, 5, 4, 4, 3, 4, 3, 4, 4, 5],
  hcp: [7, 15, 1, 17, 13, 3, 5, 9, 11, 10, 4, 2, 12, 14, 16, 8, 6, 18],
  black: [372, 472, 385, 130, 307, 388, 219, 378, 524, 501, 418, 453, 180, 344, 171, 382, 350, 506],
  white: [349, 435, 365, 118, 298, 361, 184, 356, 493, 486, 387, 442, 169, 326, 147, 364, 343, 480],
  blue: [339, 411, 348, 108, 289, 347, 175, 348, 440, 469, 373, 368, 156, 304, 133, 338, 335, 465],
  red: [319, 350, 300, 86, 256, 295, 145, 269, 371, 391, 298, 282, 120, 295, 129, 276, 281, 413]
};

const out = {
  name: "Presidio Golf Course",
  sources: {
    geometry: "OpenStreetMap contributors (ODbL), Overpass snapshot 2026-07-10",
    scorecard: "Presidio Golf Course scorecard, March 2026"
  },
  holes: [],
  greens: [],
  tees: [],
  bunkers: [],
  fairways: [],
  rough: [],
  paths: [],
  boundary: null
};

function pushPoly(e, bucket) {
  if (e.type === "way" && e.geometry) {
    bucket.push({ o: ring(e.geometry), i: [] });
  } else if (e.type === "relation" && e.members) {
    const outers = [];
    const inners = [];
    for (const m of e.members) {
      if (m.type !== "way" || !m.geometry) continue;
      (m.role === "inner" ? inners : outers).push(ring(m.geometry));
    }
    const area = (r) => {
      let a = 0;
      for (let i = 0; i < r.length; i++) {
        const [x1, z1] = r[i];
        const [x2, z2] = r[(i + 1) % r.length];
        a += x1 * z2 - x2 * z1;
      }
      return Math.abs(a) / 2;
    };
    outers.sort((a, b) => area(b) - area(a));
    outers.forEach((o, k) => bucket.push({ o, i: k === 0 ? inners : [] }));
  }
}

const holesRaw = [];
for (const e of els) {
  const t = e.tags ?? {};
  if (t.leisure === "golf_course" && e.type === "way") out.boundary = ring(e.geometry);
  switch (t.golf) {
    case "hole":
      if (e.type === "way")
        holesRaw.push({
          ref: Number(t.ref ?? 0),
          par: Number(t.par ?? 4),
          hcp: Number(t.handicap ?? 0),
          line: toXZ(e.geometry)
        });
      break;
    case "green":
      pushPoly(e, out.greens);
      break;
    case "tee":
      pushPoly(e, out.tees);
      break;
    case "bunker":
      pushPoly(e, out.bunkers);
      break;
    case "fairway":
      pushPoly(e, out.fairways);
      break;
    case "rough":
      pushPoly(e, out.rough);
      break;
    case "cartpath":
      if (e.type === "way") out.paths.push(toXZ(e.geometry));
      break;
  }
}

holesRaw.sort((a, b) => a.ref - b.ref);
for (const h of holesRaw) {
  const start = h.line[0];
  const end = h.line[h.line.length - 1];
  let tee = 0;
  let green = 0;
  let bestT = Infinity;
  let bestG = Infinity;
  out.tees.forEach((p, i) => {
    const d = dist(centroid(p.o), start);
    if (d < bestT) {
      bestT = d;
      tee = i;
    }
  });
  out.greens.forEach((p, i) => {
    const d = dist(centroid(p.o), end);
    if (d < bestG) {
      bestG = d;
      green = i;
    }
  });
  let len = 0;
  for (let i = 0; i < h.line.length - 1; i++) len += dist(h.line[i], h.line[i + 1]);
  out.holes.push({
    ref: h.ref,
    par: OFFICIAL.par[h.ref - 1] ?? h.par,
    hcp: OFFICIAL.hcp[h.ref - 1] ?? h.hcp,
    line: h.line,
    tee,
    green,
    len: Math.round(len),
    yardages: {
      black: OFFICIAL.black[h.ref - 1],
      white: OFFICIAL.white[h.ref - 1],
      blue: OFFICIAL.blue[h.ref - 1],
      red: OFFICIAL.red[h.ref - 1]
    },
    teeXZ: centroid(out.tees[tee].o).map(q),
    pinXZ: end
  });
}

writeFileSync("public/data/golf.json", JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(1);
console.log(
  `golf.json ${kb} KB — ${out.holes.length} holes, ${out.greens.length} greens, ` +
    `${out.tees.length} tees, ${out.bunkers.length} bunkers, ${out.fairways.length} fairways, ` +
    `${out.paths.length} cartpaths`
);
for (const h of out.holes)
  console.log(
    `  #${h.ref} par ${h.par} ${h.len}m tee(${h.teeXZ.map((v) => v.toFixed(0))}) pin(${h.pinXZ.map((v) => v.toFixed(0))})`
  );
