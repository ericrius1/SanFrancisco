// Pure regression probe for CityGen interiors. It bundles the production TS
// modules in memory with esbuild (Vite's existing dependency), so the test calls
// the real partition/circulation/furnishing code without copying planner logic.
//
//   node tools/citygen-interior-layout-probe.mjs
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = `
export { buildInterior } from './src/world/citygen/interior/interior.ts';
export { partition, planCirculation } from './src/world/citygen/interior/rooms.ts';
export { stairFits, planStair } from './src/world/citygen/interior/stairs.ts';
export { furnish } from './src/world/citygen/interior/props.ts';
export { interiorStyle } from './src/world/citygen/interior/style.ts';
export { PanelBuilder } from './src/world/citygen/core/facade.ts';
export { massBuilding } from './src/world/citygen/core/massing.ts';
export { doorMetrics } from './src/world/citygen/core/collider.ts';
export { specFor } from './src/world/citygen/theme/archetypes.ts';
export { decoratorFor } from './src/world/citygen/theme/decorators.ts';
export { rng } from './src/world/citygen/core/rng.ts';
export { overlaps, expand, rectArea } from './src/world/citygen/interior/common.ts';
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: "citygen-interior-probe-entry.ts", loader: "ts" },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const prod = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const {
  buildInterior, partition, planCirculation, stairFits, planStair, furnish,
  interiorStyle, PanelBuilder, massBuilding, doorMetrics, specFor, decoratorFor,
  rng, overlaps, expand, rectArea,
} = prod;

const failures = [];
const fail = (message) => { if (failures.length < 40) failures.push(message); };
const touches = (a, b) => a.x0 <= b.x1 + 1e-6 && a.x1 >= b.x0 - 1e-6 && a.z0 <= b.z1 + 1e-6 && a.z1 >= b.z0 - 1e-6;
const roles = ["parlor", "dining", "kitchen", "hall", "bedroom", "bath", "retail", "office", "loft"];
const archetypes = ["victorian", "edwardian", "marina", "downtown", "soma"];

let layouts = 0, placedProps = 0, minPortal = Infinity, maxPropW = 0, maxPropD = 0;
for (let seed = 1; seed <= 1200; seed++) {
  const random = rng(seed, 991);
  const width = 5.8 + random() * 20;
  const depth = 5.8 + random() * 26;
  const area = { x0: 0, x1: width, z0: 0, z1: depth };
  const layout = partition(area, 1 + Math.floor(random() * 3), rng(seed, 101));
  const entryAccess = {
    point: [width * 0.5, 0.7],
    keepout: { x0: width * 0.5 - 1, x1: width * 0.5 + 1, z0: 0, z1: 2.4 },
  };
  const entryRoom = planCirculation(layout.rooms, layout.portals, entryAccess, null).entryRoom;
  let stairRoom = layout.rooms.findIndex((room, i) => i !== entryRoom && stairFits(room));
  if (stairRoom < 0) stairRoom = layout.rooms.findIndex(stairFits);
  const stair = stairRoom >= 0 ? planStair(layout.rooms[stairRoom], entryAccess.keepout) : null;
  const circulation = planCirculation(
    layout.rooms,
    layout.portals,
    entryAccess,
    stair ? { room: stairRoom, point: stair.accessPoint, keepout: stair.approach } : null,
  );

  // The clear rectangles must form one touching union across every portal.
  const clearRects = circulation.byRoom.flat();
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const i = queue.shift();
    for (let j = 0; j < clearRects.length; j++) {
      if (!seen.has(j) && touches(clearRects[i], clearRects[j])) { seen.add(j); queue.push(j); }
    }
  }
  if (seen.size !== clearRects.length) fail(`seed ${seed}: circulation islands ${seen.size}/${clearRects.length}`);
  for (const portal of layout.portals) {
    minPortal = Math.min(minPortal, portal.width);
    if (portal.width < 1.2 - 1e-6) fail(`seed ${seed}: ${portal.width.toFixed(3)}m portal`);
  }

  const archetype = archetypes[seed % archetypes.length];
  const use = archetype === "soma" ? "loft" : archetype === "downtown" ? "commercial" : "residential";
  const spec = { i: 0, id: seed, poly: [[0, 0], [width, 0], [width, depth], [0, depth]], base: 0, top: 10, archetype, seed };
  const style = interiorStyle(spec, use, rectArea(area));
  for (let room = 0; room < layout.rooms.length; room++) {
    const colliders = [];
    const props = furnish(
      new PanelBuilder(), colliders, stair?.region ?? null,
      roles[(seed + room) % roles.length], layout.rooms[room], 0, rng(seed, 300 + room),
      circulation.byRoom[room], style,
    );
    for (let i = 0; i < props.length; i++) {
      const prop = props[i];
      placedProps++;
      maxPropW = Math.max(maxPropW, prop.foot.x1 - prop.foot.x0);
      maxPropD = Math.max(maxPropD, prop.foot.z1 - prop.foot.z0);
      if (circulation.byRoom[room].some((keepout) => overlaps(prop.foot, keepout))) fail(`seed ${seed}: ${prop.kind} blocks circulation`);
      if (stair && overlaps(prop.foot, expand(stair.region, 0.12))) fail(`seed ${seed}: ${prop.kind} blocks stair`);
      for (let j = i + 1; j < props.length; j++) if (overlaps(prop.foot, props[j].foot)) fail(`seed ${seed}: prop footprints overlap`);
    }
    if (colliders.some((c) => c.hx * 2 > 2.8 || c.hz * 2 > 2.8)) fail(`seed ${seed}: giant furniture collider`);
  }
  layouts++;
}

// Determinism/finite-output sweep across footprint quantiles of every live style.
const grid = JSON.parse(fs.readFileSync(path.join(ROOT, "public/citygen/buildings.json"), "utf8"));
const all = Object.values(grid.cells).flat();
const samples = [];
const polygonArea = (poly) => Math.abs(poly.reduce((sum, [x, z], i) => {
  const [nx, nz] = poly[(i + 1) % poly.length];
  return sum + x * nz - nx * z;
}, 0)) / 2;
for (const archetype of archetypes) {
  const rows = all.filter((building) => building.archetype === archetype)
    .sort((a, b) => polygonArea(a.poly) - polygonArea(b.poly));
  for (const q of [0.05, 0.25, 0.5, 0.75, 0.95]) samples.push(rows[Math.floor((rows.length - 1) * q)]);
}
const zoneFor = (archetype) => archetype === "soma" ? "loft" : archetype === "downtown" ? "commercial" : "residential";
const hashInterior = (built) => {
  const hash = crypto.createHash("sha256");
  for (const panel of built.panels) {
    hash.update(panel.materialId);
    hash.update(Buffer.from(new Float64Array(panel.positions).buffer));
    hash.update(Buffer.from(new Float64Array(panel.normals).buffer));
    hash.update(Buffer.from(new Uint32Array(panel.indices).buffer));
  }
  hash.update(JSON.stringify(built.colliders));
  return hash.digest("hex");
};
let deterministic = 0, triangles = 0, colliders = 0;
const tiers = { 0: 0, 1: 0, 2: 0 };
for (const spec of samples) {
  const zone = zoneFor(spec.archetype);
  const first = buildInterior(spec, zone);
  const second = buildInterior(spec, zone);
  if (hashInterior(first) === hashInterior(second)) deterministic++;
  else fail(`building ${spec.id}: nondeterministic output`);
  if (!first.panels.length || !first.colliders.length || first.floors < 1 || first.floors > 4) fail(`building ${spec.id}: empty/invalid build`);
  for (const panel of first.panels) {
    triangles += panel.indices.length / 3;
    if (!panel.positions.every(Number.isFinite) || !panel.normals.every(Number.isFinite)) fail(`building ${spec.id}: non-finite panel`);
  }
  for (const collider of first.colliders) {
    colliders++;
    if (![collider.x, collider.y, collider.z, collider.hx, collider.hy, collider.hz, collider.yaw].every(Number.isFinite)) fail(`building ${spec.id}: non-finite collider`);
  }
  tiers[interiorStyle(spec, zone, polygonArea(spec.poly)).tier]++;
}

// Open-door aperture sweep. Build every live grammar at short/medium/wide facade
// lengths and reject any permanent triangle whose bounds cross the central clear
// doorway volume. The two runtime-owned closed pieces are deliberately excluded:
// citygen.doorleaf + citygen.doorback are hidden when the hinged leaf takes over.
let apertureCases = 0;
const apertureOffenders = [];
const apertureGrades = [
  { top: 10, grade: 0 },
  { top: 12, grade: 3.6 },
  { top: 16, grade: 7.2 },
  { top: 30, grade: 12 },
  { top: 30, grade: 20 },
  { top: 30, grade: 25 },
  { top: 30, grade: 27 },
];
for (const archetype of archetypes) for (const length of [4.5, 6, 6.1, 9, 16]) for (const elevation of apertureGrades) {
  const spec = {
    i: 0, id: 900000 + apertureCases, seed: 1200 + apertureCases,
    poly: [[0, 0], [length, 0], [length, 9], [0, 9]],
    streetEdge: 0, doorAllowed: true,
    base: 0, grade: elevation.grade, top: elevation.top, archetype,
  };
  const mass = massBuilding(spec, specFor(archetype), decoratorFor(archetype));
  const dm = doorMetrics(length, spec.base, spec.top, spec.grade);
  const x0 = dm.tc * length - dm.halfW + 0.16;
  const x1 = dm.tc * length + dm.halfW - 0.16;
  const y0 = dm.sill + 0.22, y1 = dm.openTop - 0.22;
  const offenders = new Set();
  for (const panel of mass.panels) {
    if (panel.materialId === "citygen.doorleaf" || panel.materialId === "citygen.doorback") continue;
    for (let j = 0; j + 2 < panel.indices.length; j += 3) {
      const ids = [panel.indices[j], panel.indices[j + 1], panel.indices[j + 2]];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const id of ids) {
        const x = panel.positions[id * 3], y = panel.positions[id * 3 + 1], z = panel.positions[id * 3 + 2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      if (maxX > x0 && minX < x1 && maxY > y0 && minY < y1 && maxZ > -0.24 && minZ < 0.24) offenders.add(panel.materialId);
    }
  }
  if (offenders.size) {
    apertureOffenders.push({ archetype, length, grade: elevation.grade, top: elevation.top, materials: [...offenders].sort() });
    fail(`${archetype} ${length}m grade ${elevation.grade}: permanent doorway geometry ${[...offenders].sort().join(",")}`);
  }
  apertureCases++;
}

const report = {
  ok: failures.length === 0,
  synthetic: {
    layouts,
    placedProps,
    minPortalMetres: Number(minPortal.toFixed(2)),
    maxPropMetres: [Number(maxPropW.toFixed(2)), Number(maxPropD.toFixed(2))],
  },
  realBuildings: { samples: samples.length, deterministic, triangles, colliders, tiers },
  doorApertures: { cases: apertureCases, offenders: apertureOffenders },
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exitCode = 1;
