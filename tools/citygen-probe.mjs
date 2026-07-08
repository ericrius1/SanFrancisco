// CityGen Phase-1 acceptance probe (Node, no DOM).
//
// Validates the exported data foundation — the things Phase 1 promises:
//   1. Every record is well-formed (real polygon ≥3 pts, base<top, valid archetype).
//   2. Footprints are REAL shapes, not rectangularized — the anti-"shift" guarantee.
//      (The old export collapsed every footprint to a 4-corner box; here a healthy
//       fraction of buildings must have >4-vertex polygons.)
//   3. The classifier lands known SF locations in the right neighborhood.
// Prints PASS/FAIL lines; exits non-zero if any check fails.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classify, ARCHETYPES } from "./citygen-classify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const data = JSON.parse(await readFile(path.join(ROOT, "public/citygen/buildings.json"), "utf8"));

let pass = 0, fail = 0;
const check = (ok, label) => { (ok ? pass++ : fail++); console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}`); };

// --- 1. well-formedness sweep ------------------------------------------------
let n = 0, badPoly = 0, badH = 0, badArch = 0, vGt4 = 0, vHist = {};
for (const list of Object.values(data.cells)) {
  for (const b of list) {
    n++;
    if (!Array.isArray(b.poly) || b.poly.length < 3) badPoly++;
    if (!(b.top > b.base)) badH++;
    if (!ARCHETYPES.includes(b.archetype)) badArch++;
    const v = Array.isArray(b.poly) ? b.poly.length : 0;
    vHist[v] = (vHist[v] ?? 0) + 1;
    if (v > 4) vGt4++;
  }
}
console.log(`\n[1] well-formedness  (${n} buildings)`);
check(badPoly === 0, `all polygons have ≥3 vertices  (bad=${badPoly})`);
check(badH === 0, `all have top > base  (bad=${badH})`);
check(badArch === 0, `all archetypes valid  (bad=${badArch})`);

// --- 2. real footprints, not boxes ------------------------------------------
const pctReal = ((vGt4 / n) * 100).toFixed(1);
console.log(`\n[2] footprint fidelity (anti-shift)`);
console.log(`    vertex-count histogram: ${Object.entries(vHist).sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}:${v}`).join("  ")}`);
check(vGt4 / n > 0.15, `>15% of footprints are non-rectangular (>4 verts): ${pctReal}%`);

// --- 3. classifier spot-checks (game coords) --------------------------------
// Anchors chosen from known SF neighborhoods in this project's frame.
const spots = [
  { name: "Marina waterfront",   x: 300,   z: -2400, want: "marina" },
  { name: "Pacific Heights",     x: 300,   z: -1500, want: "victorian" },
  { name: "Haight / Mission",    x: 800,   z: 2600,  want: ["victorian", "edwardian"] },
  { name: "far-west Sunset",     x: -4200, z: 1500,  want: "marina" },
  { name: "SoMa",                x: 1800,  z: 800,   want: "soma" },
  { name: "warehouse by tag(p6)", x: 9999, z: 9999,  want: "soma", p: 6 },
];
console.log(`\n[3] classifier spot-checks`);
for (const s of spots) {
  const got = classify(s.x, s.z, { p: s.p ?? 0, seed: 0, area: 400, height: 12 });
  const want = Array.isArray(s.want) ? s.want : [s.want];
  check(want.includes(got), `${s.name.padEnd(22)} → ${got}  (want ${want.join("/")})`);
}

console.log(`\n${fail === 0 ? "ALL PASS" : fail + " FAILED"}  (${pass} pass, ${fail} fail)`);
process.exit(fail === 0 ? 0 : 1);
