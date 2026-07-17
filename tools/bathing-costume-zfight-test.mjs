// Geometry-level regression for the Sutro bathing costumes. Decorative wraps
// may cover the torso/hips/head sides, but must not emit horizontal caps that
// can become coplanar with their host block and flicker under camera motion.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = `
export { buildRig } from './src/player/rig.ts';
export { applyBathingCostume } from './src/world/sutroBaths/bathingCostume.ts';
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: "bathing-costume-zfight-test-entry.ts", loader: "ts" },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent",
});
const { buildRig, applyBathingCostume } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const styles = ["mens-tank", "mens-union", "womens-dress"];
const failures = [];
let costumes = 0;
let bands = 0;
let stripedCostumes = 0;

for (const style of styles) {
  for (let seed = 0; seed < 96; seed++) {
    const rig = buildRig();
    const costume = applyBathingCostume(rig, `band-audit-${style}-${seed}`, { style });
    costumes++;
    const wrapped = costume.addedMeshes.filter((mesh) => mesh.userData.bathingCostumeBand);
    const stripes = wrapped.filter((mesh) => mesh.userData.bathingCostumeBand === "stripe");
    if (costume.hasStripes) {
      stripedCostumes++;
      const expected = costume.stripePattern === "pinstripe" ? 5 : 3;
      if (stripes.length !== expected) {
        failures.push(`${style}/${seed}: ${costume.stripePattern} has ${stripes.length} stripe bands, expected ${expected}`);
      }
    } else if (stripes.length !== 0) {
      failures.push(`${style}/${seed}: solid costume unexpectedly has ${stripes.length} stripe bands`);
    }
    for (const mesh of wrapped) {
      bands++;
      const normal = mesh.geometry.getAttribute("normal");
      const index = mesh.geometry.getIndex();
      if (!normal || !index || index.count !== 24) {
        failures.push(`${style}/${seed}: ${mesh.name} is not the four-sided, eight-triangle band geometry`);
        continue;
      }
      for (let i = 0; i < normal.count; i++) {
        if (Math.abs(normal.getY(i)) > 1e-6) {
          failures.push(`${style}/${seed}: ${mesh.name} emits a horizontal cap normal`);
          break;
        }
      }
    }
    costume.dispose();
  }
}

if (stripedCostumes === 0) failures.push("seed sweep did not exercise any striped costumes");
if (bands === 0) failures.push("seed sweep did not exercise any decorative bands");
if (failures.length) {
  console.error(JSON.stringify({ ok: false, costumes, stripedCostumes, bands, failures: failures.slice(0, 30) }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, costumes, stripedCostumes, bands, check: "costume wraps have no coplanar horizontal caps" }, null, 2));
