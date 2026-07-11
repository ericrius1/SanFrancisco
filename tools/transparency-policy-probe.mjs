// Runtime transparency-policy regression probe. This intentionally creates no
// renderer: fixed-function material state, scene metadata, auditing, and TSL
// node construction are all testable without a GPU.
// Run: npm run test:transparency

import assert from "node:assert/strict";
import * as THREE from "three/webgpu";
import { float } from "three/tsl";
import {
  INK_EXCLUDED_LAYER,
  RenderBand,
  applyMaterialPolicy,
  auditSceneTransparency,
  clampCoverage,
  fresnelCoverage,
  tagTransparency
} from "../src/render/transparency.ts";

const PROFILE_POLICIES = {
  opaque: {
    transparent: false,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: true,
    forceSinglePass: false
  },
  cutout: {
    transparent: false,
    alphaHash: false,
    alphaTest: 0.5,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: true,
    forceSinglePass: false
  },
  hashedCoverage: {
    transparent: false,
    alphaHash: true,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: true,
    forceSinglePass: false
  },
  alphaSurface: {
    transparent: true,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: true,
    depthWrite: false,
    forceSinglePass: false
  },
  additiveWorld: {
    transparent: true,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    forceSinglePass: true
  },
  overlay: {
    transparent: true,
    alphaHash: false,
    alphaTest: 0,
    blending: THREE.NormalBlending,
    depthTest: false,
    depthWrite: false,
    forceSinglePass: true
  }
};

const PROFILE_NAMES = Object.keys(PROFILE_POLICIES);
const EMPTY_PROFILE_COUNTS = Object.fromEntries(PROFILE_NAMES.map((profile) => [profile, 0]));

const assertJsonRoundTrip = (value, label) => {
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, "string", `${label} did not serialize to JSON`);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed, value, `${label} changed during JSON serialization`);
  return parsed;
};

const poisonMaterialState = (material, policy, profile) => {
  material.transparent = !policy.transparent;
  material.alphaHash = !policy.alphaHash;
  material.alphaTest = profile === "cutout" ? 0 : 0.27;
  material.alphaToCoverage = true;
  material.premultipliedAlpha = true;
  material.blending = THREE.CustomBlending;
  material.blendSrc = THREE.DstAlphaFactor;
  material.blendDst = THREE.OneFactor;
  material.blendEquation = THREE.ReverseSubtractEquation;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.ZeroFactor;
  material.blendEquationAlpha = THREE.MaxEquation;
  material.blendAlpha = 0.73;
  material.blendColor.set(0xff3366);
  material.depthFunc = THREE.AlwaysDepth;
  material.depthTest = !policy.depthTest;
  material.depthWrite = !policy.depthWrite;
  material.colorWrite = false;
  material.forceSinglePass = !policy.forceSinglePass;
};

const assertMaterialState = (material, profile, expectedAlphaTest) => {
  const policy = PROFILE_POLICIES[profile];
  assert.equal(material.transparent, policy.transparent, `${profile}: transparent`);
  assert.equal(material.alphaHash, policy.alphaHash, `${profile}: alphaHash`);
  assert.equal(material.alphaTest, expectedAlphaTest, `${profile}: alphaTest`);
  assert.equal(material.alphaToCoverage, false, `${profile}: alphaToCoverage`);
  assert.equal(material.premultipliedAlpha, false, `${profile}: premultipliedAlpha`);
  assert.equal(material.blending, policy.blending, `${profile}: blending`);
  assert.equal(material.blendSrc, THREE.SrcAlphaFactor, `${profile}: blendSrc`);
  assert.equal(material.blendDst, THREE.OneMinusSrcAlphaFactor, `${profile}: blendDst`);
  assert.equal(material.blendEquation, THREE.AddEquation, `${profile}: blendEquation`);
  assert.equal(material.blendSrcAlpha, null, `${profile}: blendSrcAlpha`);
  assert.equal(material.blendDstAlpha, null, `${profile}: blendDstAlpha`);
  assert.equal(material.blendEquationAlpha, null, `${profile}: blendEquationAlpha`);
  assert.equal(material.blendAlpha, 0, `${profile}: blendAlpha`);
  assert.deepEqual(material.blendColor.toArray(), [0, 0, 0], `${profile}: blendColor`);
  assert.equal(material.depthFunc, THREE.LessEqualDepth, `${profile}: depthFunc`);
  assert.equal(material.depthTest, policy.depthTest, `${profile}: depthTest`);
  assert.equal(material.depthWrite, policy.depthWrite, `${profile}: depthWrite`);
  assert.equal(material.colorWrite, true, `${profile}: colorWrite`);
  assert.equal(material.forceSinglePass, policy.forceSinglePass, `${profile}: forceSinglePass`);
  assert.equal(material.userData.transparencyProfile, profile, `${profile}: metadata`);
};

for (const profile of PROFILE_NAMES) {
  const policy = PROFILE_POLICIES[profile];
  const material = new THREE.MeshBasicNodeMaterial({
    color: 0x123456,
    opacity: 0.37,
    side: THREE.BackSide
  });
  material.name = `${profile}-probe`;
  poisonMaterialState(material, policy, profile);

  const versionBefore = material.version;
  const returned = applyMaterialPolicy(material, profile);
  assert.equal(returned, material, `${profile}: policy did not return the original material`);
  assert.ok(material.version > versionBefore, `${profile}: policy did not invalidate`);
  assertMaterialState(material, profile, policy.alphaTest);

  assert.equal(material.color.getHex(), 0x123456, `${profile}: authored color changed`);
  assert.equal(material.opacity, 0.37, `${profile}: authored opacity changed`);
  assert.equal(material.side, THREE.BackSide, `${profile}: authored side changed`);
  assertJsonRoundTrip(material.userData, `${profile} material metadata`);

  const stableVersion = material.version;
  applyMaterialPolicy(material, profile);
  assert.equal(material.version, stableVersion, `${profile}: idempotent policy application invalidated`);
  material.dispose();
}

const authoredCutout = new THREE.MeshBasicNodeMaterial();
authoredCutout.alphaTest = 0.23;
applyMaterialPolicy(authoredCutout, "cutout");
assertMaterialState(authoredCutout, "cutout", 0.23);
authoredCutout.dispose();

assert.deepEqual(RenderBand, {
  WORLD: 0,
  WATER_UNDERSIDE: 9,
  WATER_SURFACE: 10,
  WATER_OVERLAY: 10.5,
  WATER_NEAR: 11,
  WATER_EFFECTS: 12,
  DECALS: 20,
  DECAL_ADDITIVE: 21,
  WORLD_ADDITIVE: 90,
  WORLD_ADDITIVE_FRONT: 91,
  PARTICLES: 100,
  MARKER_BACK: 998,
  MARKERS: 999,
  OVERLAY: 1_000,
  DEBUG_OVERLAY: 9_999
});
assert.equal(INK_EXCLUDED_LAYER, 31, "ink exclusion layer changed");

const defaultTagObject = new THREE.Object3D();
defaultTagObject.renderOrder = 37;
defaultTagObject.layers.enable(INK_EXCLUDED_LAYER);
assert.equal(
  tagTransparency(defaultTagObject, { profile: "opaque" }),
  defaultTagObject,
  "tagTransparency did not return the original object"
);
assert.equal(defaultTagObject.renderOrder, 37, "implicit render band changed renderOrder");
assert.equal(defaultTagObject.layers.isEnabled(0), true, "ink object is missing scene layer 0");
assert.equal(
  defaultTagObject.layers.isEnabled(INK_EXCLUDED_LAYER),
  false,
  "ink object remained on the excluded layer"
);
assert.deepEqual(assertJsonRoundTrip(defaultTagObject.userData.transparency, "default object tag"), {
  profile: "opaque",
  renderBand: 37,
  ink: true
});

const excludedTagObject = new THREE.Object3D();
tagTransparency(excludedTagObject, {
  profile: "overlay",
  renderBand: RenderBand.DEBUG_OVERLAY,
  ink: false
});
assert.equal(excludedTagObject.renderOrder, RenderBand.DEBUG_OVERLAY, "explicit render band was ignored");
assert.equal(excludedTagObject.layers.isEnabled(0), false, "excluded object remained on scene layer 0");
assert.equal(
  excludedTagObject.layers.isEnabled(INK_EXCLUDED_LAYER),
  true,
  "excluded object is missing the exclusion layer"
);
assert.deepEqual(assertJsonRoundTrip(excludedTagObject.userData.transparency, "excluded object tag"), {
  profile: "overlay",
  renderBand: RenderBand.DEBUG_OVERLAY,
  ink: false
});

const PROFILE_RENDER_BANDS = {
  opaque: RenderBand.WORLD,
  cutout: RenderBand.WORLD,
  hashedCoverage: RenderBand.MARKERS,
  alphaSurface: RenderBand.WATER_SURFACE,
  additiveWorld: RenderBand.WORLD_ADDITIVE,
  overlay: RenderBand.OVERLAY
};

const validScene = new THREE.Scene();
for (const profile of PROFILE_NAMES) {
  const material = applyMaterialPolicy(new THREE.MeshBasicNodeMaterial(), profile);
  material.name = `${profile}-valid-material`;
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
  mesh.name = `${profile}-valid-object`;
  tagTransparency(mesh, {
    profile,
    renderBand: PROFILE_RENDER_BANDS[profile],
    ink: profile !== "overlay"
  });
  validScene.add(mesh);
}

const validAudit = auditSceneTransparency(validScene);
assert.deepEqual(validAudit.counts, {
  objectsVisited: 7,
  renderableObjects: 6,
  materialSlots: 6,
  uniqueMaterials: 6,
  transparentMaterials: 3,
  hashedMaterials: 1,
  taggedObjects: 6,
  untaggedTransparentMaterials: 0,
  untaggedHashedMaterials: 0,
  warningCount: 0,
  profiles: Object.fromEntries(PROFILE_NAMES.map((profile) => [profile, 1]))
});
assert.deepEqual(validAudit.warnings, [], "valid scene produced transparency warnings");
assertJsonRoundTrip(validAudit, "valid transparency audit");

const malformedScene = new THREE.Scene();
const malformedMaterial = new THREE.MeshBasicNodeMaterial();
malformedMaterial.name = "malformed-material";
malformedMaterial.transparent = true;
malformedMaterial.alphaHash = true;
malformedMaterial.blending = THREE.AdditiveBlending;
malformedMaterial.userData.transparencyProfile = "not-a-profile";
const malformedMesh = new THREE.Mesh(new THREE.BufferGeometry(), malformedMaterial);
malformedMesh.name = "malformed-object";
malformedMesh.userData.transparency = {
  profile: "not-a-profile",
  renderBand: Number.POSITIVE_INFINITY,
  ink: "yes"
};
malformedScene.add(malformedMesh);

const malformedAudit = auditSceneTransparency(malformedScene);
assert.deepEqual(malformedAudit.counts, {
  objectsVisited: 2,
  renderableObjects: 1,
  materialSlots: 1,
  uniqueMaterials: 1,
  transparentMaterials: 1,
  hashedMaterials: 1,
  taggedObjects: 0,
  untaggedTransparentMaterials: 1,
  untaggedHashedMaterials: 1,
  warningCount: 6,
  profiles: EMPTY_PROFILE_COUNTS
});
assert.deepEqual(
  malformedAudit.warnings.map((warning) => warning.code),
  [
    "invalid-object-tag",
    "invalid-material-tag",
    "untagged-transparent-material",
    "untagged-alpha-hash-material",
    "alpha-hash-transparent-conflict",
    "alpha-hash-additive-conflict"
  ]
);
assert.ok(
  malformedAudit.warnings.every(
    (warning) =>
      typeof warning.message === "string" &&
      typeof warning.objectUuid === "string" &&
      typeof warning.materialUuid === "string" &&
      Array.isArray(warning.fields)
  ),
  "malformed audit returned non-serializable warning fields"
);
assertJsonRoundTrip(malformedAudit, "malformed transparency audit");

const invalidSceneAudit = auditSceneTransparency(null);
assert.equal(invalidSceneAudit.counts.objectsVisited, 0, "invalid scene was traversed");
assert.equal(invalidSceneAudit.counts.warningCount, 1, "invalid scene warning count changed");
assert.equal(invalidSceneAudit.warnings[0]?.code, "invalid-scene", "invalid scene warning is missing");
assertJsonRoundTrip(invalidSceneAudit, "invalid-scene transparency audit");

const coverageNodes = {
  clampedNumber: clampCoverage(1.4),
  clampedNode: clampCoverage(float(0.4)),
  fresnelDefaults: fresnelCoverage(2.2),
  fresnelNodes: fresnelCoverage(float(3), float(0.06))
};
for (const [name, node] of Object.entries(coverageNodes)) {
  assert.equal(node.isNode, true, `${name} is not a TSL node`);
  assert.doesNotThrow(() => JSON.stringify(node.toJSON()), `${name} did not construct cleanly`);
}

console.log(
  JSON.stringify(
    {
      ok: true,
      profiles: PROFILE_NAMES,
      renderBands: Object.keys(RenderBand).length,
      audits: {
        validWarnings: validAudit.counts.warningCount,
        malformedWarnings: malformedAudit.warnings.map((warning) => warning.code),
        invalidSceneWarnings: invalidSceneAudit.counts.warningCount
      },
      coverageNodes: Object.fromEntries(
        Object.entries(coverageNodes).map(([name, node]) => [name, node.constructor.name])
      )
    },
    null,
    2
  )
);
