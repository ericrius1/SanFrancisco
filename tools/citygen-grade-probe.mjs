// CityGen buried-window (grade) probe — pure geometry, no THREE/DOM.
//
// A building's `base` is the LOWEST ground under its footprint (buildings dig into
// hills). On a sloped lot the uphill ground rises to `grade`, so windows placed
// relative to `base` used to sit half-buried. The fix: façade + LOD keep all
// window/ground-floor detail above `grade`, while the wall skirt still runs to
// `base` (buried part stays solid — no floating gap).
//
// This bundles the pure path (core/massing + theme decorators + render/lod) with
// esbuild (three is stubbed — only TSL builder calls touch it) and asserts the
// invariant on a steep synthetic lot. Run: node tools/citygen-grade-probe.mjs
import esbuild from "esbuild";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";
import { rmSync } from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src/world/citygen");
const OUT = path.join(os.tmpdir(), `citygen-grade-bundle-${process.pid}.mjs`);

const entry = `
export { generate } from ${JSON.stringify(path.join(SRC, "index.ts"))};
export { appendPrism, emptyArrays } from ${JSON.stringify(path.join(SRC, "render/lod.ts"))};
`;

await esbuild.build({
  stdin: { contents: entry, resolveDir: SRC, sourcefile: "entry.mjs", loader: "js" },
  outfile: OUT, bundle: true, format: "esm", platform: "node",
  plugins: [{
    name: "stub-three",
    setup(b) {
      b.onResolve({ filter: /^three(\/.*)?$/ }, () => ({ path: "three-stub", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
        // Chainable no-op that is callable, constructable, coerces to 0, and yields
        // 0 for .r/.g/.b so THREE.Color()/TSL builder calls don't throw.
        contents: `
          const f = function(){ return node; };
          const node = new Proxy(f, {
            get(_, p){ if (p === Symbol.toPrimitive) return () => 0; if (p === "r" || p === "g" || p === "b") return 0; return node; },
            apply(){ return node; },
            construct(){ return node; },
          });
          // esbuild copies the stub into an ESM namespace via __copyProps, which
          // reads ownKeys(). Advertise the THREE members our path constructs so
          // \`new THREE.Color()\` etc. resolve to a newable node (not undefined).
          const KEYS = ["Color","BufferGeometry","BufferAttribute","Mesh","Group","Matrix4","MeshStandardNodeMaterial","DoubleSide"];
          module.exports = new Proxy({}, {
            get: () => node,
            ownKeys: () => KEYS,
            getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true, value: node }),
          });
        `,
        loader: "js",
      }));
    },
  }],
});

const { generate, appendPrism, emptyArrays } = await import(pathToFileURL(OUT).href);
rmSync(OUT, { force: true }); // bundle imported into memory; drop the temp file

const EPS = 0.05;
let pass = 0, fail = 0;
const check = (ok, label, extra = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };

// 12 m × 10 m footprint, base=0 (dug in), top=15, grade=6 → a 6 m slope. The OLD
// code placed the bottom 1–2 window rows below y=6.
const rectSpec = (archetype, grade) => ({
  i: 0, id: 1, archetype, seed: 12345,
  poly: [[0, 0], [12, 0], [12, 10], [0, 10]],
  base: 0, top: 15, grade,
});

// The buried-window artifact is glass + storefront elements below the ground line.
// (Solid skirt bands `base.*`/`wall.*` and full-height `trim.*` corner boards
// legitimately reach `base` — they are the buried-but-solid wall, not windows.)
const DETAIL_MATS = new Set(["glass", "citygen.door", "citygen.awn", "citygen.sign"]);
const isDetail = (id) => DETAIL_MATS.has(id);
const isSkirt = (id) => id.startsWith("wall.") || id.startsWith("base.");

for (const arch of ["victorian", "edwardian", "marina", "downtown", "soma"]) {
  const grade = 6;
  const { mass } = generate(rectSpec(arch, grade), true);

  let minDetailY = Infinity, wallMinY = Infinity, glassCount = 0;
  for (const p of mass.panels) {
    for (let k = 1; k < p.positions.length; k += 3) {
      const y = p.positions[k];
      if (isSkirt(p.materialId)) wallMinY = Math.min(wallMinY, y);
      if (isDetail(p.materialId)) minDetailY = Math.min(minDetailY, y);
      if (p.materialId === "glass") glassCount++;
    }
  }
  check(minDetailY >= grade - EPS, `${arch}: no window/detail below grade`, `minDetailY=${minDetailY.toFixed(2)} grade=${grade}`);
  check(wallMinY <= 0.01, `${arch}: wall skirt still reaches base`, `wallMinY=${wallMinY.toFixed(2)}`);
  check(glassCount > 0, `${arch}: windows present above grade`, `glassVerts=${glassCount}`);

  const arr = emptyArrays();
  appendPrism(rectSpec(arch, grade), arr);
  let lodMinY = Infinity, lodMaxY = -Infinity;
  for (let k = 1; k < arr.pos.length; k += 3) { lodMinY = Math.min(lodMinY, arr.pos[k]); lodMaxY = Math.max(lodMaxY, arr.pos[k]); }
  check(lodMinY <= 0.01 && lodMaxY >= 14.99, `${arch}: LOD prism spans base→top`, `[${lodMinY.toFixed(2)}, ${lodMaxY.toFixed(2)}]`);
}

// FLAT lot (grade=base): unchanged — windows reach the normal low sill.
{
  const { mass } = generate(rectSpec("downtown", 0), true);
  let glassMinY = Infinity;
  for (const p of mass.panels) if (p.materialId === "glass")
    for (let k = 1; k < p.positions.length; k += 3) glassMinY = Math.min(glassMinY, p.positions[k]);
  check(glassMinY < 6, "flat lot: windows keep the normal low sill (no lift)", `glassMinY=${glassMinY.toFixed(2)}`);
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
