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
export { footprintGrade } from ${JSON.stringify(path.join(SRC, "render/foundation.ts"))};
`;

// The stub below must advertise every THREE/TSL member the bundle constructs —
// esbuild snapshots ownKeys() once when building the ESM namespace, so a name
// missing from the list arrives as `undefined` and `new THREE.Whatever()`
// throws. Read the real export lists instead of hand-maintaining a whitelist
// (the old hardcoded list had gone stale and the probe could not run at all).
const THREE_KEYS = [...new Set((await Promise.all(
  ["three", "three/tsl", "three/webgpu"].map((m) => import(m).then(Object.keys, () => []))
)).flat())];

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
            // Callers assign onto the stub (\`material.name = ...\`, \`.side = ...\`).
            // Swallow writes — the function target's own \`name\`/\`length\` are
            // read-only and would throw in strict-mode ESM.
            set(){ return true; },
            defineProperty(){ return true; },
          });
          // esbuild copies the stub into an ESM namespace via __copyProps, which
          // reads ownKeys(). Advertise the real three/three-tsl/three-webgpu
          // export names so \`new THREE.Color()\` etc. resolve to a newable node
          // (not undefined).
          const KEYS = ${JSON.stringify(THREE_KEYS)};
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

const { generate, appendPrism, emptyArrays, footprintGrade } = await import(pathToFileURL(OUT).href);
rmSync(OUT, { force: true }); // bundle imported into memory; drop the temp file

const EPS = 0.05;
let pass = 0, fail = 0;
const check = (ok, label, extra = "") => { (ok ? pass++ : fail++); console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  " + extra : ""}`); };

// 12 m × 10 m footprint, base=0 (dug in), top=15, grade=6 → a 6 m slope. The OLD
// code placed the bottom 1–2 window rows below y=6.
const rectSpec = (archetype, grade, foot) => ({
  i: 0, id: 1, archetype, seed: 12345,
  poly: [[0, 0], [12, 0], [12, 10], [0, 10]],
  base: 0, top: 15, grade, foot,
});

// Windows are kit-of-parts INSTANCES, not baked panels — `mass.panels` holds no
// glass at all, so the buried-window assertions used to pass vacuously. Read the
// MERGED meshes with `expandModules`, which folds the instanced windows back in.
const partsOf = (spec, withDoor = true) =>
  generate(spec, withDoor, { expandModules: true }).meshes;

// The buried-window artifact is glass + storefront elements below the ground line.
// (Solid skirt bands `base.*`/`wall.*` and full-height `trim.*` corner boards
// legitimately reach `base` — they are the buried-but-solid wall, not windows.)
const DETAIL_MATS = new Set(["glass", "citygen.door", "citygen.awn", "citygen.sign"]);
const isDetail = (id) => DETAIL_MATS.has(id);
const isSkirt = (id) => id.startsWith("wall.") || id.startsWith("base.");

for (const arch of ["victorian", "edwardian", "marina", "downtown", "soma"]) {
  const grade = 6;

  let minDetailY = Infinity, wallMinY = Infinity, glassCount = 0;
  for (const p of partsOf(rectSpec(arch, grade))) {
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

  // FrontSide is safe only when every triangle's geometric winding agrees with
  // the authored outward/+Y normal. This guards against exposing the shell from
  // underneath again by papering an inward mesh over with DoubleSide.
  let minFacing = Infinity, orientedTris = 0;
  for (let k = 0; k + 2 < arr.idx.length; k += 3) {
    const ia = arr.idx[k], ib = arr.idx[k + 1], ic = arr.idx[k + 2];
    const ax = arr.pos[ia * 3], ay = arr.pos[ia * 3 + 1], az = arr.pos[ia * 3 + 2];
    const abx = arr.pos[ib * 3] - ax, aby = arr.pos[ib * 3 + 1] - ay, abz = arr.pos[ib * 3 + 2] - az;
    const acx = arr.pos[ic * 3] - ax, acy = arr.pos[ic * 3 + 1] - ay, acz = arr.pos[ic * 3 + 2] - az;
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    const facing = cx * arr.nor[ia * 3] + cy * arr.nor[ia * 3 + 1] + cz * arr.nor[ia * 3 + 2];
    if (Math.abs(facing) > 1e-8) { minFacing = Math.min(minFacing, facing); orientedTris++; }
  }
  check(orientedTris > 0 && minFacing > 0, `${arch}: LOD winding faces outward`, `minDot=${minFacing.toFixed(2)}`);
}

// FLAT lot (grade=base): unchanged — windows reach the normal low sill.
{
  const parts = partsOf(rectSpec("downtown", 0));
  let glassMinY = Infinity;
  for (const p of parts) if (p.materialId === "glass")
    for (let k = 1; k < p.positions.length; k += 3) glassMinY = Math.min(glassMinY, p.positions[k]);
  check(glassMinY < 6, "flat lot: windows keep the normal low sill (no lift)", `glassMinY=${glassMinY.toFixed(2)}`);

  // No skirt where there is nothing to fill: a flat lot (foot omitted → foot ==
  // base) must be vertex-for-vertex what it was before the foundation existed.
  const explicitFoot = partsOf(rectSpec("downtown", 0, 0));
  const verts = (ms) => ms.reduce((n, m) => n + m.positions.length, 0);
  check(verts(parts) === verts(explicitFoot), "flat lot: no foundation skirt below base",
    `verts=${verts(parts)} vs ${verts(explicitFoot)}`);
}

// ---------------------------------------------------------------------------
// COASTAL CLIFF LIP — the Point Lobos bluff case (tile 1_12 above Sutro Baths).
// The whole footprint sits on high ground; the drop-off starts a few metres
// OUTSIDE its west edge. A sampler that only reads the footprint's own corners
// and edge midpoints sees flat ground, returns foot == base, and both tiers draw
// a wall bottom hanging in the air over the bluff.
// ---------------------------------------------------------------------------
{
  // Ground: a plateau at 12 m that falls away west of x = -3 at 0.55 m/m, to the
  // sea. Terrain everywhere UNDER the 12×10 footprint at x∈[0,12] is flat 12 m.
  const cliffGround = (x) => (x >= -3 ? 12 : Math.max(-1, 12 - (-3 - x) * 0.55));
  const ground = (x) => cliffGround(x);
  const poly = [[0, 0], [12, 0], [12, 10], [0, 10]];
  const base = 11.5, top = 24;

  const { grade, foot } = footprintGrade(poly, base, top, ground);
  check(Math.abs(grade - 12) < EPS, "cliff: grade still reads the footprint's own high ground", `grade=${grade.toFixed(2)}`);
  // 8 m outside the west edge is x = -8 → 12 - 5·0.55 = 9.25 m.
  check(foot <= ground(-8) + EPS, "cliff: foot reaches the drop-off outside the footprint", `foot=${foot.toFixed(2)} groundAt(-8m)=${ground(-8).toFixed(2)}`);
  check(foot < base - 1, "cliff: foot is well below the baked base (skirt has work to do)", `foot=${foot.toFixed(2)} base=${base}`);

  const spec = { i: 0, id: 2, archetype: "marina", seed: 4242, poly, base, top, grade, foot };
  for (const [tier, minY] of [
    ["near (massBuilding)", (() => {
      let m = Infinity;
      for (const p of partsOf(spec)) for (let k = 1; k < p.positions.length; k += 3) m = Math.min(m, p.positions[k]);
      return m;
    })()],
    ["far (appendPrism)", (() => {
      const arr = emptyArrays();
      appendPrism(spec, arr);
      let m = Infinity;
      for (let k = 1; k < arr.pos.length; k += 3) m = Math.min(m, arr.pos[k]);
      return m;
    })()],
  ]) {
    check(minY <= foot + EPS, `cliff: ${tier} wall reaches the foot (no floating gap)`, `minY=${minY.toFixed(2)} foot=${foot.toFixed(2)}`);
  }

  // The skirt is BELOW the ground line, so it must stay solid — no glass, door,
  // awning or sign may have followed the wall down.
  let minDetailY = Infinity;
  for (const p of partsOf(spec)) if (isDetail(p.materialId))
    for (let k = 1; k < p.positions.length; k += 3) minDetailY = Math.min(minDetailY, p.positions[k]);
  check(minDetailY >= grade - EPS, "cliff: no window/detail followed the skirt below grade", `minDetailY=${minDetailY.toFixed(2)} grade=${grade.toFixed(2)}`);

  // Regression guard for the actual bug: the old footprint-only sampler.
  const footprintOnly = Math.min(...poly.map(([x]) => ground(x)));
  check(footprintOnly > foot + 1, "cliff: footprint-only sampling would still float (guards the fix)", `footprintOnlyFoot=${footprintOnly.toFixed(2)} vs foot=${foot.toFixed(2)}`);
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
