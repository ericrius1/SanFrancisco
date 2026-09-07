// Run with node tools/citygen-landscape-test.mjs. Pure geometry: no browser/GPU.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/world/citygen/render/lodGeometry.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false, metafile: true,
});
assert.ok(Object.keys(bundled.metafile.inputs).every(name => !name.includes('node_modules/three/')),
  'landscape geometry must stay pure and portable to tile-generation workers');
const { appendPrism, emptyArrays } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const cells = JSON.parse(readFileSync('public/citygen/buildings.json', 'utf8')).cells;
const stock = Object.values(cells).flat();
const samples = stock.filter((_, i) => i % Math.max(1, Math.floor(stock.length / 1200)) === 0);
const costs = [];
for (const spec of samples) {
  const out = emptyArrays();
  appendPrism(spec, out);
  const vertices = out.pos.length / 3;
  assert.equal(out.nor.length, out.pos.length);
  assert.equal(out.col.length, out.pos.length);
  assert.equal(out.uvs.length, vertices * 2);
  assert.equal(out.vis.length, vertices);
  assert.ok(out.pos.every(Number.isFinite));
  assert.ok(out.vis.every(value => value === out.vis[0]), 'one visibility range must hide the entire building envelope');
  const at = i => out.pos.slice(i * 3, i * 3 + 3);
  for (let i = 0; i < out.idx.length; i += 3) {
    const [ia, ib, ic] = out.idx.slice(i, i + 3);
    assert.ok(Math.min(ia, ib, ic) >= 0 && Math.max(ia, ib, ic) < vertices);
    const a = at(ia), b = at(ib), c = at(ic), n = out.nor.slice(ia * 3, ia * 3 + 3);
    const ab = b.map((v, j) => v - a[j]), ac = c.map((v, j) => v - a[j]);
    const dot = (ab[1] * ac[2] - ab[2] * ac[1]) * n[0]
      + (ab[2] * ac[0] - ab[0] * ac[2]) * n[1]
      + (ab[0] * ac[1] - ab[1] * ac[0]) * n[2];
    assert.ok(dot >= -1e-6, `front-side winding must agree with normals: building ${spec.id}, triangle ${i / 3}`);
  }
  const triangles = out.idx.length / 3;
  assert.ok(triangles <= spec.poly.length * 43 + 44, 'geometry must scale with footprint edges, never windows or floor count');
  costs.push(triangles);
}
const prototype = { i: 0, id: 1, poly: [[0,0],[12,0],[12,16],[0,16]], base: 0, grade: 3, foot: -5, top: 16, archetype: 'victorian', seed: 17 };
const first = emptyArrays(); appendPrism(prototype, first);
assert.equal(Math.min(...first.pos.filter((_, i) => i % 3 === 1)), -5, 'landscape skirt must still reach the downhill foot');
assert.ok(Math.max(...first.pos.filter((_, i) => i % 3 === 1)) > prototype.top + 1, 'retain rooftop volume silhouette');
const roofVertices = first.pos.filter((_, i) => i % 3 === 1).filter(y => y > prototype.top + 1).length;
assert.ok(roofVertices > 0);
const joined = emptyArrays(); appendPrism(prototype, joined); appendPrism({ ...prototype, i: 1, seed: 29 }, joined);
assert.equal(joined.vis.slice(0, first.vis.length).every(v => v === first.vis[0]), true, 'appending a neighbor must not alter an existing visibility range');
const tall = emptyArrays(); appendPrism({ ...prototype, top: 160 }, tall);
assert.equal(tall.idx.length, first.idx.length, 'ten times the facade height must not create more landscape geometry');
costs.sort((a,b) => a-b);
console.log(JSON.stringify({ ok: true, samples: samples.length, pureModuleBytes: bundled.outputFiles[0].contents.length,
  triangles: { median: costs[Math.floor(costs.length * 0.5)], p95: costs[Math.floor(costs.length * 0.95)], max: costs.at(-1) },
  contracts: ['front-sided winding', 'linear envelope complexity', 'foundation coverage', 'atomic visibility', 'constant cost with height'] }, null, 2));
