// Regression probe for close-range CityGen rooftop geometry. It exercises the
// production massing/PanelBuilder code and guards the two bugs that showed up
// from the hoverboard: freestanding roof props with an open side, and a
// double-sided bottom face coplanar with the roof cap.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = `
export { PanelBuilder } from './src/world/citygen/core/facade.ts';
export { massBuilding } from './src/world/citygen/core/massing.ts';
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: "citygen-roof-visual-probe-entry.ts", loader: "ts" },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const { PanelBuilder, massBuilding } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const faceNormals = (panel) => {
  const out = [];
  for (let i = 0; i < panel.normals.length; i += 12) {
    out.push(panel.normals.slice(i, i + 3).map((n) => Math.round(n)));
  }
  return out;
};
const hasNormal = (normals, wanted) => normals.some((n) => n.every((v, i) => v === wanted[i]));

// Primitive contract: a surface-seated box has four closed walls plus a top,
// while its coplanar bottom is intentionally absent.
{
  const out = new PanelBuilder();
  out.box("test", [0, 1, 0], [1, 1, 1], [1, 0, 0], [0, 1, 0], [0, 0, 1], false, true);
  const panel = out.panels()[0];
  const normals = faceNormals(panel);
  check(panel.indices.length === 30, `surface-seated box has ${panel.indices.length / 3} triangles, expected 10`);
  for (const n of [[0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, -1]]) {
    check(hasNormal(normals, n), `surface-seated box is missing face normal ${n.join(",")}`);
  }
  check(!hasNormal(normals, [0, -1, 0]), "surface-seated box still emits a coplanar bottom face");
}

const arch = {
  floorH: 3.4,
  wallMaterial: "wall.test",
  roofMaterial: "roof.test",
  roofType: "flat",
};
let audited = 0;
for (let seed = 1; seed <= 256; seed++) {
  const top = 10;
  const mass = massBuilding({
    id: `roof-${seed}`,
    seed,
    archetype: "victorian",
    poly: [[0, 0], [12, 0], [12, 10], [0, 10]],
    base: 0,
    grade: 0,
    top,
  }, arch, () => {});

  // roof.test occurs once for the bulkhead and once for the separately emitted
  // triangulated cap. The larger panel must be a five-faced, vertically closed
  // surface-seated box.
  const roofPanels = mass.panels.filter((p) => p.materialId === "roof.test");
  const bulkhead = roofPanels.find((p) => p.indices.length === 30);
  const cap = roofPanels.find((p) => p.indices.length === 6);
  check(Boolean(bulkhead), `seed ${seed}: missing closed five-face bulkhead`);
  check(Boolean(cap), `seed ${seed}: missing roof cap`);
  if (bulkhead) {
    const normals = faceNormals(bulkhead);
    check(hasNormal(normals, [0, 0, -1]), `seed ${seed}: bulkhead back is open`);
    check(!hasNormal(normals, [0, -1, 0]), `seed ${seed}: bulkhead bottom overlaps roof cap`);
  }

  // No generated downward face may lie exactly on the roof. The elevated tank
  // can retain its real bottom; only surface-seated props must omit theirs.
  for (const panel of mass.panels) {
    for (let v = 0; v < panel.positions.length / 3; v += 4) {
      const ni = v * 3;
      if (Math.round(panel.normals[ni + 1]) !== -1) continue;
      const ys = [0, 1, 2, 3].map((k) => panel.positions[(v + k) * 3 + 1]);
      check(!ys.every((y) => Math.abs(y - top) < 1e-6), `seed ${seed}: coplanar downward roof-prop face remains`);
    }
  }
  audited++;
}

if (failures.length) {
  console.error(JSON.stringify({ ok: false, audited, failures: failures.slice(0, 30) }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, audited, checks: ["closed vertical sides", "no coplanar bottoms", "roof cap retained"] }, null, 2));
