// Semantic audit for the lane-free road graph and procedural signals.
//
// This complements runtime checkpoint checks by proving the current road graph
// has the traffic-control structure the trainer is learning against.
//
// Usage:
//   node --experimental-strip-types tools/audit-traffic-system.mjs

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RoadGraph } from "../src/world/traffic/roadGraph.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const roads = JSON.parse(readFileSync(path.join(ROOT, "public/data/roads.json"), "utf8"));
const graph = new RoadGraph(roads);

const failures = [];
const warnings = [];

function denseCore(x, z) {
  const downtown = x > 1700 && x < 5200 && z > -900 && z < 2600;
  const somaMission = x > 1200 && x < 4300 && z >= 1800 && z < 4300;
  return downtown || somaMission;
}

function segLengthAndCenter(seg) {
  let len = 0;
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let i = 0; i < seg.p.length - 2; i += 2) {
    const ax = seg.p[i] / 10;
    const az = seg.p[i + 1] / 10;
    const bx = seg.p[i + 2] / 10;
    const bz = seg.p[i + 3] / 10;
    len += Math.hypot(bx - ax, bz - az);
    sx += ax + bx;
    sz += az + bz;
    n += 2;
  }
  return { len, x: sx / Math.max(1, n), z: sz / Math.max(1, n) };
}

if (roads.v !== 4) failures.push(`roads schema v${roads.v}, expected v4`);
if (!Array.isArray(roads.segs) || roads.segs.length < 9000) {
  failures.push(`roads segment count ${roads.segs?.length ?? 0} is unexpectedly low`);
}

let oneWay = 0;
let twoWay = 0;
let malformed = 0;
let legacyLaneMetadata = 0;
let denseKm = 0;
let outsideKm = 0;

for (const seg of roads.segs ?? []) {
  const dir = seg.d === 1 || seg.d === -1 ? seg.d : 0;
  const { len, x, z } = segLengthAndCenter(seg);
  if (denseCore(x, z)) denseKm += len / 1000;
  else outsideKm += len / 1000;
  if (!Array.isArray(seg.p) || seg.p.length < 4 || seg.p.length % 2 !== 0 || !(seg.w > 0)) {
    malformed++;
    continue;
  }
  if ("l" in seg || "f" in seg || "b" in seg) legacyLaneMetadata++;
  if (dir) {
    oneWay++;
  } else {
    twoWay++;
  }
}

if (malformed) failures.push(`${malformed} malformed road segments`);
if (oneWay < 1000) failures.push(`only ${oneWay} one-way segments found`);
if (twoWay < 1000) failures.push(`only ${twoWay} two-way segments found`);
if (legacyLaneMetadata) failures.push(`${legacyLaneMetadata} road segments still carry lane metadata`);

const signals = graph.signals.signals;
let denseSignals = 0;
let outsideSignals = 0;
let singleAxisSignals = 0;
let phaseConflicts = 0;
let bothGreen = 0;
const sampleTimes = [0, 5, 12, 23.9, 24, 27.9, 28, 30, 42, 54, 59.9, 60];

for (const signal of signals) {
  if (denseCore(signal.x, signal.z)) denseSignals++;
  else outsideSignals++;
  const axes = new Set(signal.approaches.map((a) => a.axis));
  if (axes.size < 2) singleAxisSignals++;
  for (const t of sampleTimes) {
    const byAxis = new Map();
    for (const approach of signal.approaches) {
      const state = graph.signals.stateForAxis(signal, approach.axis, t);
      const prev = byAxis.get(approach.axis);
      if (prev && prev !== state) phaseConflicts++;
      byAxis.set(approach.axis, state);
    }
    if (byAxis.get(0) === "green" && byAxis.get(1) === "green") bothGreen++;
  }
}

const denseSignalPerKm = denseSignals / Math.max(1e-6, denseKm);
const outsideSignalPerKm = outsideSignals / Math.max(1e-6, outsideKm);

if (signals.length < 1500) failures.push(`only ${signals.length} procedural signals found`);
if (denseSignals < 200) failures.push(`only ${denseSignals} dense-core signals found`);
if (outsideSignals < 400) failures.push(`only ${outsideSignals} non-core signals found`);
if (denseSignalPerKm < outsideSignalPerKm * 1.2) {
  failures.push(`dense signal density ${round(denseSignalPerKm)} / km is not at least 1.2x outside density ${round(outsideSignalPerKm)} / km`);
}
if (phaseConflicts) failures.push(`${phaseConflicts} same-axis signal phase conflicts found`);
if (bothGreen) failures.push(`${bothGreen} samples had both signal axes green`);
if (singleAxisSignals) warnings.push(`${singleAxisSignals} signals have approaches on only one axis; tolerated for irregular OSM junction clusters`);

const summary = {
  roadsVersion: roads.v,
  segments: roads.segs?.length ?? 0,
  oneWay,
  twoWay,
  legacyLaneMetadata,
  signals: signals.length,
  denseSignals,
  outsideSignals,
  denseKm: round(denseKm),
  outsideKm: round(outsideKm),
  denseSignalPerKm: round(denseSignalPerKm),
  outsideSignalPerKm: round(outsideSignalPerKm),
  singleAxisSignals,
  warnings,
  failures
};

console.log(`[traffic-audit] ${failures.length ? "FAIL" : "ok"} ${signals.length} signals, ${roads.segs?.length ?? 0} road segments`);
console.log(JSON.stringify(summary, null, 2));
if (failures.length) process.exit(1);

function round(n) {
  return Math.round(n * 1000) / 1000;
}
