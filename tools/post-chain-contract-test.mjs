// Post-processing chain architectural contract. Source-text only — no browser,
// no renderer, no WebGPU device. Run with: node tools/post-chain-contract-test.mjs
//
// This file exists because the four things it checks all fail SILENTLY or
// NON-DETERMINISTICALLY at runtime, which is precisely the class of regression a
// human review does not catch on a diff:
//
//  1. A node scheduled by the graph instead of by the chain renders its quad from
//     inside somebody else's open render pass. WebGPU rejects the whole command
//     buffer and the frame comes out as bare clear colour — measured at ~70% of
//     captures across one ten-second shot (contactShadows.ts:326-345), which is
//     exactly the hit rate that gets a bug reported as "flickering" and closed.
//  2. `renderer.reversedDepthBuffer` is TRUE: background is 0.0 and the near
//     plane is 1.0. Every stock `depth.greaterThanEqual(1.0).discard()` therefore
//     discards the geometry and shades the sky. The result is a plausible-looking
//     image with the mask inverted, not a crash.
//  3. A stage group at the wrong dotted path silently collaterals a sibling's
//     persisted overrides (core/persist.ts fingerprints per group).
//  4. A recompile key on a stage that ships enabled means an ordinary slider can
//     open a TSL codegen window, and a codegen window in this renderer HOLDS
//     PRESENTED FRAMES (compileGate.ts / pipeline.render's early return).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POST = path.join(ROOT, "src", "render", "post");

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });

const files = walk(POST);
const rel = (file) => path.relative(ROOT, file);
const read = (file) => readFileSync(file, "utf8");

/** Strip line and block comments. Every assertion below is about CODE — the
 *  files deliberately quote the upstream defects they fix, in prose, and a
 *  grep that cannot tell a fix from the bug it describes trains people to
 *  ignore this test. */
const codeOf = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const sources = new Map(files.map((file) => [file, read(file)]));
const code = new Map(files.map((file) => [file, codeOf(sources.get(file))]));

let checks = 0;
const ok = (message) => {
  checks += 1;
  void message;
};

// ---------------------------------------------------------------------------
// 1. THE #1 RANKED RISK: nothing in the chain may be scheduled by the node graph.
//
// `Renderer.js:3778` calls `_nodes.updateBefore(renderObject)` from
// `renderObject()`, i.e. WHILE A RENDER PASS IS OPEN. Every stock display node
// three ships is FRAME-scoped (GTAONode.js:89, SSRNode.js:160, TAAUNode.js:68,
// TRAANode.js:58, DepthOfFieldNode.js:224, BloomNode.js:266, SharpenNode.js:100),
// so a fork that keeps its Node base and forgets this line renders its own quad
// from inside a foreign pass.
// ---------------------------------------------------------------------------
const UPDATE_BEFORE_ASSIGN = /updateBeforeType\s*=\s*([A-Za-z0-9_.]+)/g;
let updateBeforeAssignments = 0;
for (const file of files) {
  for (const match of code.get(file).matchAll(UPDATE_BEFORE_ASSIGN)) {
    updateBeforeAssignments += 1;
    assert.equal(
      match[1],
      "NodeUpdateType.NONE",
      `${rel(file)}: updateBeforeType must be NodeUpdateType.NONE, found ${match[1]}. ` +
        "A FRAME- or RENDER-scoped node renders its quad from inside an open render pass " +
        "(Renderer.js:3778) and WebGPU rejects the entire command buffer.",
    );
  }
}
assert.ok(
  updateBeforeAssignments > 0,
  "expected at least one updateBeforeType assignment under src/render/post — " +
    "the god-ray RTT and the MRT velocity node are both nodes the chain must pin to NONE. " +
    "Zero matches means this check has quietly stopped covering anything.",
);
ok(`${updateBeforeAssignments} updateBeforeType assignments are NONE`);

// Stronger than the grep above, because the grep can only police a line that is
// PRESENT: any class that still extends a three Node must pin the type, and the
// vendored forks must not extend one at all (dropping the base class is the
// complete form of the same instruction — there is no updateBeforeType left to
// be wrong, and no setup() a foreign NodeBuilder can reach).
const NODE_SUBCLASS = /class\s+(\w+)\s+extends\s+(?:THREE\.)?(\w*Node)\b/g;
for (const file of files) {
  const body = code.get(file);
  for (const match of body.matchAll(NODE_SUBCLASS)) {
    assert.match(
      body,
      /updateBeforeType\s*=\s*NodeUpdateType\.NONE/,
      `${rel(file)}: class ${match[1]} extends ${match[2]} but never assigns ` +
        "updateBeforeType = NodeUpdateType.NONE.",
    );
    ok(`${rel(file)}: ${match[1]} pins updateBeforeType`);
  }
}

const VENDOR_DIRS = files.filter((file) => file.includes(`${path.sep}vendor${path.sep}`));
assert.ok(VENDOR_DIRS.length >= 8, "expected the vendored forks to still be present");
for (const file of VENDOR_DIRS) {
  assert.doesNotMatch(
    code.get(file),
    /class\s+\w+\s+extends\s+(?:THREE\.)?(?:TempNode|TextureNode|PassNode|RTTNode)\b/,
    `${rel(file)}: a vendored fork must not keep its Node base class. ` +
      "It is what lets the graph schedule the fork behind the chain's back.",
  );
}
ok(`${VENDOR_DIRS.length} vendored files keep no Node base class`);

// Every vendored fork must carry the provenance header the build order requires:
// the upstream file it came from, so a three upgrade can be diffed against it.
for (const file of VENDOR_DIRS) {
  assert.match(
    sources.get(file),
    /(VENDORED|FORK(ED)?)[\s\S]{0,400}?(three|r185|0\.185)/i,
    `${rel(file)}: vendored code must name its upstream file and three version in a header comment.`,
  );
}
ok("vendored forks carry upstream provenance headers");

// ---------------------------------------------------------------------------
// 2. REVERSED DEPTH. Background is 0.0, near is 1.0 — the inverse of what every
//    stock display node assumes. Only shared/reversedDepth.ts may encode the
//    convention; everything else must route through isGeometryDepth().
// ---------------------------------------------------------------------------
const REVERSED_DEPTH_HELPER = path.join(POST, "shared", "reversedDepth.ts");
assert.ok(sources.has(REVERSED_DEPTH_HELPER), "shared/reversedDepth.ts must exist");
assert.match(
  code.get(REVERSED_DEPTH_HELPER),
  /reversedDepthBuffer\s*===\s*true/,
  "isGeometryDepth must branch on renderer.reversedDepthBuffer rather than assuming it",
);

// A raw-depth comparison against the far plane, in any of the shapes three's own
// display folder uses. Scoped to receivers whose NAME says depth, so the UV
// bounds checks that legitimately compare against 1 (contactShadows.ts:492) are
// not false positives.
const RAW_DEPTH_COMPARE =
  /\b(\w*[Dd]epth\w*)\s*\.\s*(greaterThanEqual|lessThan|greaterThan|lessThanEqual|equal)\s*\(\s*(1|1\.0|float\(\s*1(\.0)?\s*\))\s*\)/g;
for (const file of files) {
  if (file === REVERSED_DEPTH_HELPER) continue;
  for (const match of code.get(file).matchAll(RAW_DEPTH_COMPARE)) {
    assert.fail(
      `${rel(file)}: raw depth compared against 1.0 (\`${match[0]}\`). ` +
        "reversedDepthBuffer is TRUE — background is 0.0 and near is 1.0, so this " +
        "discards the geometry and shades the sky. Use isGeometryDepth() from " +
        "shared/reversedDepth.ts.",
    );
  }
}
ok("no raw depth-vs-1.0 comparisons outside shared/reversedDepth.ts");

// The two forks that discard the background must actually use the helper, not
// merely avoid the literal. A fork that dropped the discard entirely would pass
// the check above while shading the sky at full cost.
for (const forkName of ["ssao/vendor/gtao.ts", "ssr/vendor/ssr.ts"]) {
  const file = path.join(POST, ...forkName.split("/"));
  assert.ok(sources.has(file), `${forkName} must exist`);
  assert.match(
    code.get(file),
    /isGeometryDepth\s*\(/,
    `${forkName}: must gate its background discard on isGeometryDepth(), not on a depth literal.`,
  );
}
ok("gtao and ssr gate their background discard on isGeometryDepth");

// getViewPosition is ALREADY correct under reversed depth: it feeds raw depth
// straight into clip.z and the camera's projectionMatrixInverse IS the reversed
// inverse. The single worst bug found during recon was someone "fixing" it.
for (const file of files) {
  const body = code.get(file);
  assert.doesNotMatch(
    body,
    /getViewPosition\s*\([^)]*oneMinus\s*\(/,
    `${rel(file)}: do not oneMinus() the depth handed to getViewPosition — it is already reversed-Z safe.`,
  );
}
ok("no oneMinus() applied to getViewPosition's depth argument");

// ---------------------------------------------------------------------------
// 3. ONE TUNABLE GROUP PER STAGE, AT ITS OWN DOTTED PATH.
//    core/persist.ts fingerprints per group and clearGroupOverrides only deletes
//    keys one segment deep, so a stage sharing a path with a sibling discards the
//    sibling's saved values whenever its own spec churns.
// ---------------------------------------------------------------------------
const stageFolders = readdirSync(POST).filter((entry) => {
  if (entry === "shared") return false;
  return statSync(path.join(POST, entry)).isDirectory();
});
assert.ok(stageFolders.length >= 12, `expected >=12 stage folders, found ${stageFolders.length}`);

const seenPaths = new Map();
for (const folder of stageFolders) {
  const tuningFile = path.join(POST, folder, "tuning.ts");
  assert.ok(sources.has(tuningFile), `${folder}/ must own a tuning.ts`);
  const match = code.get(tuningFile).match(/tunables\(\s*"([^"]+)"/);
  assert.ok(match, `${folder}/tuning.ts must declare a tunables() group`);
  assert.equal(
    match[1],
    `post.${folder}`,
    `${folder}/tuning.ts declares "${match[1]}" — every stage group lives at post.<folder>.`,
  );
  assert.ok(
    !seenPaths.has(match[1]),
    `dotted path ${match[1]} is claimed by both ${seenPaths.get(match[1])} and ${folder}`,
  );
  seenPaths.set(match[1], folder);
}
ok(`${stageFolders.length} stage folders own a tuning.ts at post.<folder>`);

// The chain-wide group must stay at the bare "post" prefix, and must NOT collide
// with a stage folder named "post".
assert.match(
  code.get(path.join(POST, "tuning.ts")),
  /tunables\(\s*"post"\s*,/,
  "post/tuning.ts must own the chain-wide group at the bare \"post\" path",
);
ok("chain-wide tunables live at \"post\"");

// ---------------------------------------------------------------------------
// 4. RECOMPILE KEYS. A stage that ships ENABLED must not be able to open a
//    codegen window from an ordinary control.
// ---------------------------------------------------------------------------
/**
 * THE ONE DOCUMENTED EXCEPTION, pinned so it cannot grow silently.
 *
 * BRIEF §5 states two things that cannot both be true: "recompileKeys must be
 * EMPTY for any stage enabled by default", and "only `ssr.blurQuality` and
 * `ssr.binaryRefine` survive [as baked constants]" — while §4.3's table ships
 * `post.ssr.enabled` at `true`. §4.3 is explicit that those two "stay baked and
 * are declared in recompileKeys".
 *
 * The ruling: the invariant is enforced for every stage, and SSR's two keys are
 * allowed ONLY as an exact-match exception that also requires the held-frame
 * Apply lane to exist (asserted immediately below). That is what the invariant
 * is actually for — the hazard is a LIVE control opening a codegen window on a
 * presented frame, and routing the rebuild through compileFullscreenQuads
 * increments exclusiveCompileDepth so the frame is HELD, not corrupted.
 *
 * Adding a third key to SSR, or a recompile key to any other default-enabled
 * stage, fails here. Making boxBlur's kernel size a uniform (which would make
 * the loop bounds uniform-derived and legal, at the cost of an unrollable loop)
 * retires this exception entirely — delete the entry and the test tightens.
 */
const RECOMPILE_EXCEPTIONS = new Map([["ssr", ["blurQuality", "binaryRefine"]]]);

const parseKeyList = (body, key) => {
  const match = body.match(new RegExp(`${key}\\s*:\\s*\\[([^\\]]*)\\]`));
  assert.ok(match, `expected a ${key} declaration`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
};

let defaultEnabledStages = 0;
for (const folder of stageFolders) {
  const tuning = code.get(path.join(POST, folder, "tuning.ts"));
  const indexFile = path.join(POST, folder, "index.ts");
  assert.ok(sources.has(indexFile), `${folder}/ must own an index.ts`);
  const index = code.get(indexFile);

  // "enabled by default" = the stage's own group ships `enabled: { v: true }`.
  // A folder with no `enabled` key (grade, sharpen, grain, jitter, display) owns
  // no pass and is identity-driven by a strength/amount of 0 instead.
  const enabledDefault = /enabled\s*:\s*\{\s*v\s*:\s*true\b/.test(tuning);
  const recompileKeys = parseKeyList(index, "recompileKeys");
  if (!enabledDefault) {
    // Not exempt from everything: a stage that ships OFF may declare recompile
    // keys, but only if the Apply lane exists to hold the frame while it builds.
    if (recompileKeys.length > 0) {
      assert.ok(
        RECOMPILE_EXCEPTIONS.has(folder),
        `${folder}: declares recompileKeys ${JSON.stringify(recompileKeys)} without an entry in ` +
          "RECOMPILE_EXCEPTIONS. Register it with its reason, or promote the keys to uniforms.",
      );
    }
    continue;
  }
  defaultEnabledStages += 1;

  const allowed = RECOMPILE_EXCEPTIONS.get(folder) ?? [];
  assert.deepEqual(
    [...recompileKeys].sort(),
    [...allowed].sort(),
    `${folder}: ships enabled by default, so recompileKeys must be ${JSON.stringify(allowed)} ` +
      `(found ${JSON.stringify(recompileKeys)}). A recompile key on a default-enabled stage means ` +
      "an ordinary control can open a TSL codegen window, and a codegen window HOLDS PRESENTED FRAMES.",
  );

  // Every declared key must exist in that stage's tunable table, in both
  // directions of honesty: a key that is not a tunable is dead, and a structural
  // key that does not appear cannot be gated on slider release.
  for (const key of [...recompileKeys, ...parseKeyList(index, "structuralKeys")]) {
    assert.match(
      tuning,
      new RegExp(`\\b${key}\\s*:\\s*\\{`),
      `${folder}: declares "${key}" but ${folder}/tuning.ts has no such tunable.`,
    );
  }
}
assert.ok(
  defaultEnabledStages >= 6,
  `expected >=6 default-enabled stages, found ${defaultEnabledStages} — ` +
    "if this collapsed, the invariant above is passing vacuously.",
);
ok(`${defaultEnabledStages} default-enabled stages hold the recompileKeys invariant`);

// DOF must stay OFF by default. It is the most expensive stage in the chain
// (nine fullscreen passes, ~160 taps/px) and restrained depth of field at play
// FOV is very nearly invisible.
assert.match(
  code.get(path.join(POST, "dof", "tuning.ts")),
  /enabled\s*:\s*\{\s*v\s*:\s*false\b/,
  "post.dof must default to disabled — BRIEF §4.6.",
);
ok("dof ships disabled");

// The exception above is only defensible because the rebuild is routed through a
// lane that HOLDS the frame. Assert that lane exists, in pipeline.ts, wired in
// that order.
const pipelineSource = readFileSync(path.join(ROOT, "src", "render", "pipeline.ts"), "utf8");
assert.match(
  codeOf(pipelineSource),
  /applyStructure\(\)[\s\S]{0,400}?compileFullscreenQuads\([\s\S]{0,80}?warmupQuads\(\)\)/,
  "pipeline.ts must follow postChain.applyStructure() with " +
    "compileGate.compileFullscreenQuads(postChain.warmupQuads()) — otherwise the first frame " +
    "after an Apply pays a synchronous WGSL build mid-frame, which is the exact hitch " +
    "recompileKeys exists to schedule away.",
);
ok("the structural Apply lane re-warms the chain's quads");

// ---------------------------------------------------------------------------
// 5. CHAIN SHAPE. Order is a chain-level decision no stage argues with, and the
//    display tail must be last or the chain presents an intermediate.
// ---------------------------------------------------------------------------
const orderSource = code.get(path.join(POST, "order.ts"));
const orderEntries = [...orderSource.matchAll(/(\w+)\s*:\s*(\d+)/g)].map(([, id, value]) => [
  id,
  Number(value),
]);
assert.ok(orderEntries.length >= 12, "STAGE_ORDER must name every stage");
for (const folder of stageFolders) {
  assert.ok(
    orderEntries.some(([id]) => id === folder),
    `STAGE_ORDER has no entry for the ${folder}/ stage`,
  );
  assert.match(
    code.get(path.join(POST, folder, "index.ts")),
    new RegExp(`order\\s*:\\s*STAGE_ORDER\\.${folder}\\b`),
    `${folder}/index.ts must report order: STAGE_ORDER.${folder}, never a literal.`,
  );
}
const orderValues = orderEntries.map(([, value]) => value);
assert.equal(
  new Set(orderValues).size,
  orderValues.length,
  "two stages share a STAGE_ORDER value; the chain's sort would then be unstable",
);
const display = orderEntries.find(([id]) => id === "display");
assert.ok(display, "STAGE_ORDER must name the display tail");
assert.equal(
  display[1],
  Math.max(...orderValues),
  "the display tail must be last in STAGE_ORDER — it is the only stage that presents",
);
// The god rays publish the composite's beauty source, so they must resolve
// BEFORE it; the temporal resolve is the input->output transition and must sit
// after the composite and before bloom.
const orderOf = (id) => orderEntries.find(([entry]) => entry === id)[1];
assert.ok(orderOf("godrays") < orderOf("composite"), "god rays must precede the composite");
assert.ok(orderOf("ssao") < orderOf("composite"), "SSAO must precede the composite");
assert.ok(orderOf("ssr") < orderOf("composite"), "SSR must precede the composite");
assert.ok(orderOf("composite") < orderOf("temporal"), "the composite is the last linear-HDR stage");
assert.ok(orderOf("temporal") < orderOf("bloom"), "bloom runs at output resolution, after the resolve");
assert.ok(orderOf("velocity") < orderOf("temporal"), "velocity must be written before it is consumed");
ok("STAGE_ORDER is unique, display-last and dependency-consistent");

// Exactly one THREE.RenderPipeline in the whole chain: the display tail. The
// rebuild's headline is 33 retained pipelines collapsing to one, and each extra
// is its own codegen window.
const pipelineConstructions = files.filter((file) =>
  /new\s+THREE\.RenderPipeline\s*\(/.test(code.get(file)),
);
assert.deepEqual(
  pipelineConstructions.map(rel),
  ["src/render/post/display/index.ts"],
  "only the display tail may construct a THREE.RenderPipeline",
);
ok("exactly one RenderPipeline, in the display tail");

// ---------------------------------------------------------------------------
// 6. RESOLUTION OWNERSHIP. adaptiveResolution.ts stays the single owner of the
//    DRAWING BUFFER; the temporal scale only scales the beauty pass, relative to
//    it. Two authorities fighting over setPixelRatio is the failure this pins.
// ---------------------------------------------------------------------------
const postTuning = code.get(path.join(POST, "tuning.ts"));
assert.match(
  postTuning,
  /"traa"/,
  "postInputScale() must clamp the beauty scale to 1 in TRAA mode — TRAA has no " +
    "reconstruction filter and cannot upscale.",
);
for (const file of files) {
  assert.doesNotMatch(
    code.get(file),
    /setPixelRatio\s*\(/,
    `${rel(file)}: the post chain must never touch setPixelRatio — adaptiveResolution.ts owns the drawing buffer.`,
  );
}
assert.match(
  codeOf(pipelineSource),
  /scenePass\.setResolutionScale\(\s*inputScale\s*\)/,
  "pipeline.ts must apply postInputScale() to the beauty pass before it renders",
);
ok("beauty-pass scale is applied by the frame driver; nothing touches setPixelRatio");

// ---------------------------------------------------------------------------
// 7. WIRES THAT FAIL SILENTLY. Each of these is a single line whose absence
//    removes a feature without producing an error anywhere.
// ---------------------------------------------------------------------------
assert.match(
  codeOf(pipelineSource),
  /godRays\.attachWorld\(\s*scene\s*,\s*directionalLight\s*\)/,
  "pipeline.ts must call godRays.attachWorld(scene, directionalLight) — PostStageSetup carries " +
    "neither, and without it the piano grove renders no god rays at all.",
);
assert.match(
  code.get(path.join(POST, "velocity", "index.ts")),
  /gbuffer\s+as\s+\{[^}]*velocity[^}]*\}\s*\)\.velocity\s*=/,
  "the velocity stage must publish its motion node on gbuffer.velocity — pipeline.ts " +
    "constructs the g-buffer before the pixels exist and leaves the field null.",
);
assert.match(
  code.get(path.join(POST, "ssr", "index.ts")),
  /provideReflections\(\s*\(\)\s*=>/,
  "the SSR stage must register its reflection texture with composite/auxSources — the composite " +
    "adds an exact black identity otherwise and the stage renders into nothing.",
);
assert.match(
  code.get(path.join(POST, "composite", "index.ts")),
  /ssaoFactorAt\(/,
  "the composite must consume SSAO through ssaoFactorAt(), which reads exactly 1.0 when the " +
    "stage is off (no branch, no second graph).",
);
ok("the four silent-failure wires are present");

// ---------------------------------------------------------------------------
// 8. NO NOISE INSIDE AN If(). An If() condition must be a uniform-buffer read so
//    the branch is uniform control flow for the whole draw; a noise-driven
//    condition makes it divergent and any textureSample inside becomes illegal
//    WGSL (postfx.ts:44-51 records the original failure).
// ---------------------------------------------------------------------------
const IF_CONDITION = /\bIf\(\s*([^,]{0,160}?),/g;
for (const file of files) {
  for (const match of code.get(file).matchAll(IF_CONDITION)) {
    assert.doesNotMatch(
      match[1],
      /mx_noise|hash21|hash23|interleavedGradientNoise|rand\(/,
      `${rel(file)}: If(${match[1].trim()}) is driven by noise. The condition must be a ` +
        "uniform-buffer read, or the branch is divergent and textureSample inside it is illegal.",
    );
  }
}
ok("no noise node drives an If() condition");

console.log(`post-chain contract: ${checks} checks passed across ${files.length} files`);
