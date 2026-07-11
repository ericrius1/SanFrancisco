#!/usr/bin/env node

/**
 * Static guard for render-state policy centralization.
 *
 * Raw writes remain temporarily allowlisted by a line-insensitive fingerprint.
 * New code should use src/render/transparency.ts instead. To inspect every site,
 * run `node tools/transparency-audit.mjs --list`. Maintainers can print a fresh
 * count-based baseline with `--print-baseline`, then review and copy only the
 * intentional additions into LEGACY_ALLOWLIST.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const CENTRAL_POLICY = "src/render/transparency.ts";
const TRACKED = new Set([
  "transparent",
  "alphaHash",
  "blending",
  "depthWrite",
  "depthTest",
  "renderOrder"
]);

// Incremental legacy baseline. Keys deliberately omit line numbers so harmless
// source movement does not churn the allowlist; counts still make a newly added
// duplicate fail. Generate candidate entries with --print-baseline, then review.
const LEGACY_ALLOWLIST = new Map([
  ["src/fx/birdTrail.ts|write|mat.blending=THREE.AdditiveBlending", 1],
  ["src/fx/birdTrail.ts|write|mat.depthWrite=false", 1],
  ["src/fx/birdTrail.ts|write|mat.transparent=true", 1],
  ["src/fx/birdTrail.ts|write|this.mesh.renderOrder=12", 1],
  ["src/fx/bubbles.ts|write|mat.blending=THREE.AdditiveBlending", 1],
  ["src/fx/bubbles.ts|write|mat.depthWrite=false", 1],
  ["src/fx/bubbles.ts|write|mat.transparent=true", 1],
  ["src/fx/bubbles.ts|write|popMat.blending=THREE.AdditiveBlending", 1],
  ["src/fx/bubbles.ts|write|popMat.depthWrite=false", 1],
  ["src/fx/bubbles.ts|write|popMat.transparent=true", 1],
  ["src/fx/fireworks.ts|write|material.blending=THREE.AdditiveBlending", 1],
  ["src/fx/fireworks.ts|write|material.depthWrite=false", 1],
  ["src/fx/fireworks.ts|write|material.transparent=true", 1],
  ["src/fx/fireworks.ts|write|sprite.renderOrder=100", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.dust|depthWrite=false", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.dust|transparent=true", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.fire|blending=THREE.AdditiveBlending", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.fire|depthWrite=false", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.fire|transparent=true", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.flash|blending=THREE.AdditiveBlending", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.flash|depthWrite=false", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.flash|transparent=true", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.smoke|depthWrite=false", 1],
  ["src/fx/fx.ts|construct:SpriteMaterial@baseMats.smoke|transparent=true", 1],
  ["src/fx/graffiti.ts|write|mat.depthWrite=false", 1],
  ["src/fx/graffiti.ts|write|mat.transparent=true", 1],
  ["src/fx/paintball.ts|write|this.#mat.depthWrite=false", 1],
  ["src/fx/paintball.ts|write|this.#mat.transparent=true", 1],
  ["src/fx/splash.ts|construct:SpriteMaterial@this.#dropMat|blending=THREE.AdditiveBlending", 1],
  ["src/fx/splash.ts|construct:SpriteMaterial@this.#dropMat|depthWrite=false", 1],
  ["src/fx/splash.ts|construct:SpriteMaterial@this.#dropMat|transparent=true", 1],
  ["src/fx/splash.ts|construct:SpriteMaterial@this.#sprayMat|depthWrite=false", 1],
  ["src/fx/splash.ts|construct:SpriteMaterial@this.#sprayMat|transparent=true", 1],
  ["src/fx/wake.ts|write|mat.blending=THREE.AdditiveBlending", 3],
  ["src/fx/wake.ts|write|mat.depthWrite=false", 3],
  ["src/fx/wake.ts|write|mat.transparent=true", 3],
  ["src/fx/wake.ts|write|this.#mesh.renderOrder=12", 2],
  ["src/fx/wake.ts|write|this.mesh.renderOrder=12", 1],
  ["src/fx/worldCursor.ts|write|mat.blending=THREE.AdditiveBlending", 1],
  ["src/fx/worldCursor.ts|write|mat.depthTest=true", 1],
  ["src/fx/worldCursor.ts|write|mat.depthWrite=false", 1],
  ["src/fx/worldCursor.ts|write|mat.transparent=true", 1],
  ["src/fx/worldCursor.ts|write|this.#mesh.renderOrder=999", 1],
  ["src/gameplay/forest.ts|construct:MeshStandardNodeMaterial@gummyMat|transparent=true", 1],
  ["src/gameplay/golf/course.ts|write|beam.alphaHash=true", 1],
  ["src/gameplay/golf/course.ts|write|beam.depthWrite=true", 1],
  ["src/gameplay/golf/course.ts|write|beam.transparent=false", 1],
  ["src/gameplay/golf/course.ts|write|curtain.alphaHash=true", 1],
  ["src/gameplay/golf/course.ts|write|curtain.depthWrite=true", 1],
  ["src/gameplay/golf/course.ts|write|curtain.transparent=false", 1],
  ["src/gameplay/golf/course.ts|write|halo.blending=THREE.AdditiveBlending", 1],
  ["src/gameplay/golf/course.ts|write|halo.depthWrite=false", 1],
  ["src/gameplay/golf/course.ts|write|halo.transparent=true", 1],
  ["src/gameplay/golf/game.ts|write|arrowMat.blending=THREE.AdditiveBlending", 1],
  ["src/gameplay/golf/game.ts|write|arrowMat.depthWrite=false", 1],
  ["src/gameplay/golf/game.ts|write|arrowMat.transparent=true", 1],
  ["src/gameplay/golf/game.ts|write|beaconMat.blending=THREE.AdditiveBlending", 1],
  ["src/gameplay/golf/game.ts|write|beaconMat.depthWrite=false", 1],
  ["src/gameplay/golf/game.ts|write|beaconMat.transparent=true", 1],
  ["src/gameplay/golf/guide.ts|write|arrow.renderOrder=999", 1],
  ["src/gameplay/golf/guide.ts|write|shell.renderOrder=998", 1],
  ["src/gameplay/hunt.ts|construct:MeshBasicMaterial@poofMat|blending=THREE.AdditiveBlending", 1],
  ["src/gameplay/hunt.ts|construct:MeshBasicMaterial@poofMat|depthWrite=false", 1],
  ["src/gameplay/hunt.ts|construct:MeshBasicMaterial@poofMat|transparent=true", 1],
  ["src/gameplay/islands.ts|construct:LineBasicMaterial@inline:LineBasicMaterial|transparent=true", 1],
  ["src/gameplay/launchers/rocketMesh.ts|write|mat.blending=THREE.AdditiveBlending", 1],
  ["src/gameplay/launchers/rocketMesh.ts|write|mat.depthWrite=false", 1],
  ["src/gameplay/launchers/rocketMesh.ts|write|mat.transparent=true", 1],
  ["src/gameplay/pickleball/court.ts|construct:MeshBasicNodeMaterial@netMaterial|depthWrite=false", 1],
  ["src/gameplay/pickleball/court.ts|construct:MeshBasicNodeMaterial@netMaterial|transparent=true", 1],
  ["src/net/remotes.ts|construct:SpriteMaterial@mat|depthWrite=false", 1],
  ["src/net/remotes.ts|construct:SpriteMaterial@mat|transparent=true", 1],
  ["src/render/pipeline.ts|write|prePass.transparent=false", 1],
  ["src/render/pipeline.ts|write|renderer.transparent=node.transparent", 1],
  ["src/render/pipeline.ts|write|renderer.transparent=renderTransparent", 1],
  ["src/ui/colliderDebug.ts|construct:LineBasicNodeMaterial@mat|depthTest=false", 1],
  ["src/ui/colliderDebug.ts|construct:LineBasicNodeMaterial@mat|depthWrite=false", 1],
  ["src/ui/colliderDebug.ts|construct:LineBasicNodeMaterial@mat|transparent=true", 1],
  ["src/ui/colliderDebug.ts|write|line.renderOrder=9999", 1],
  ["src/vehicles/boat/speedboat.ts|construct:MeshLambertMaterial@glass|transparent=true", 1],
  ["src/vehicles/drone/mesh.ts|construct:MeshLambertMaterial@discMat|depthWrite=false", 1],
  ["src/vehicles/drone/mesh.ts|construct:MeshLambertMaterial@discMat|transparent=true", 1],
  ["src/vehicles/plane/mesh.ts|construct:MeshLambertMaterial@discMat|depthWrite=false", 1],
  ["src/vehicles/plane/mesh.ts|construct:MeshLambertMaterial@discMat|transparent=true", 1],
  ["src/world/bayLights.ts|write|material.blending=THREE.AdditiveBlending", 1],
  ["src/world/bayLights.ts|write|material.depthWrite=false", 1],
  ["src/world/bayLights.ts|write|material.transparent=true", 1],
  ["src/world/bayLights.ts|write|sprite.renderOrder=90", 1],
  ["src/world/citygen/render.ts|write|f.alphaHash=true", 1],
  ["src/world/garden/seedTreeGarden.ts|construct:MeshBasicMaterial@inline:MeshBasicMaterial|depthWrite=false", 1],
  ["src/world/goldenGateLights.ts|write|material.blending=THREE.AdditiveBlending", 1],
  ["src/world/goldenGateLights.ts|write|material.depthWrite=false", 1],
  ["src/world/goldenGateLights.ts|write|material.transparent=true", 1],
  ["src/world/goldenGateLights.ts|write|sprite.renderOrder=91", 1],
  ["src/world/goldenGateTennis/index.ts|construct:MeshStandardMaterial@inline:MeshStandardMaterial|depthWrite=false", 3],
  ["src/world/goldenGateTennis/index.ts|construct:MeshStandardMaterial@inline:MeshStandardMaterial|transparent=true", 3],
  ["src/world/roadMarkings.ts|construct:MeshBasicNodeMaterial@mat|depthWrite=false", 1],
  ["src/world/roadMarkings.ts|write|mat.transparent=true", 1],
  ["src/world/roadMarkings.ts|write|mesh.renderOrder=20", 1],
  ["src/world/seaPillars.ts|write|this.mesh.renderOrder=-1", 1],
  ["src/world/seedForest/index.ts|construct:MeshBasicMaterial@inline:MeshBasicMaterial|depthWrite=false", 1],
  ["src/world/sky.ts|construct:MeshBasicNodeMaterial@mat|depthWrite=false", 1],
  ["src/world/streetLamps.ts|write|discMat.blending=THREE.AdditiveBlending", 1],
  ["src/world/streetLamps.ts|write|discMat.depthWrite=false", 1],
  ["src/world/streetLamps.ts|write|discMat.transparent=true", 1],
  ["src/world/streetLamps.ts|write|this.#discs.renderOrder=21", 1],
  ["src/world/sutroTower.ts|write|material.blending=THREE.AdditiveBlending", 1],
  ["src/world/sutroTower.ts|write|material.depthWrite=false", 1],
  ["src/world/sutroTower.ts|write|material.transparent=true", 1],
  ["src/world/sutroTower.ts|write|sprite.renderOrder=90", 1],
  ["src/world/water.ts|construct:MeshBasicNodeMaterial@undMat|depthTest=false", 1],
  ["src/world/water.ts|construct:MeshBasicNodeMaterial@undMat|depthWrite=false", 1],
  ["src/world/water.ts|construct:MeshBasicNodeMaterial@undMat|transparent=true", 1],
  ["src/world/water.ts|construct:MeshPhysicalNodeMaterial@mat|depthWrite=false", 1],
  ["src/world/water.ts|construct:MeshPhysicalNodeMaterial@mat|transparent=true", 1],
  ["src/world/water.ts|construct:MeshStandardNodeMaterial@mat|depthWrite=false", 1],
  ["src/world/water.ts|construct:MeshStandardNodeMaterial@mat|transparent=true", 1],
  ["src/world/water.ts|write|this.far.renderOrder=10", 1],
  ["src/world/water.ts|write|this.near.renderOrder=11", 1],
  ["src/world/water.ts|write|this.palaceLagoon.renderOrder=10.5", 1],
  ["src/world/water.ts|write|this.underside.renderOrder=9", 1],
]);

const normalize = (value) => value.replace(/\s+/g, " ").trim();
const relative = (file) => path.relative(ROOT, file).split(path.sep).join("/");

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function propertyName(node, sf) {
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  return normalize(node.getText(sf));
}

function accessParts(node, sf) {
  if (ts.isPropertyAccessExpression(node)) {
    return { receiver: normalize(node.expression.getText(sf)), property: node.name.text };
  }
  if (ts.isElementAccessExpression(node) && node.argumentExpression) {
    const property = propertyName(node.argumentExpression, sf);
    return { receiver: normalize(node.expression.getText(sf)), property };
  }
  return null;
}

function scopeId(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return `${p.kind}@${p.getStart(sf)}`;
  }
  return "source";
}

function shortCallee(expr, sf) {
  const text = normalize(expr.getText(sf));
  return text.split(".").at(-1) ?? text;
}

function objectBinding(object, sf) {
  const parent = object.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === object) return normalize(parent.name.getText(sf));
  if (ts.isBinaryExpression(parent) && parent.right === object) return normalize(parent.left.getText(sf));
  if (ts.isPropertyAssignment(parent) && parent.initializer === object) {
    const child = propertyName(parent.name, sf);
    const outer = parent.parent.parent;
    if (ts.isVariableDeclaration(outer) && outer.initializer === parent.parent) {
      return `${normalize(outer.name.getText(sf))}.${child}`;
    }
    return child;
  }
  return "object";
}

function newBinding(node, sf) {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && parent.initializer === node) return normalize(parent.name.getText(sf));
  if (ts.isBinaryExpression(parent) && parent.right === node) return normalize(parent.left.getText(sf));
  if (ts.isPropertyAssignment(parent) && parent.initializer === node) {
    const child = propertyName(parent.name, sf);
    const outer = parent.parent.parent;
    if (ts.isVariableDeclaration(outer) && outer.initializer === parent.parent) {
      return `${normalize(outer.name.getText(sf))}.${child}`;
    }
    return child;
  }
  return `inline:${shortCallee(node.expression, sf)}`;
}

function constructionContext(object, sf) {
  for (let p = object.parent; p; p = p.parent) {
    if (ts.isNewExpression(p)) {
      return {
        label: `${shortCallee(p.expression, sf)}@${newBinding(p, sf)}`,
        binding: newBinding(p, sf),
        material: /Material$/.test(shortCallee(p.expression, sf))
      };
    }
    if (ts.isStatement(p) || ts.isFunctionLike(p)) break;
  }
  return { label: `object@${objectBinding(object, sf)}`, binding: objectBinding(object, sf), material: false };
}

function assignmentOperator(kind) {
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

function operatorText(kind) {
  return ts.tokenToString(kind) ?? "=";
}

function scanFile(file) {
  const rel = relative(file);
  if (rel === CENTRAL_POLICY) return { sites: [], groups: new Map() };

  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const sites = [];
  const groups = new Map();

  const groupFor = (key) => {
    let group = groups.get(key);
    if (!group) {
      group = { key, material: false, sites: [], states: new Map() };
      groups.set(key, group);
    }
    return group;
  };

  const add = ({ node, property, kind, value, fingerprint, groupKey, material = false }) => {
    const lc = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const site = {
      file: rel,
      line: lc.line + 1,
      column: lc.character + 1,
      property,
      kind,
      value,
      fingerprint,
      groupKey
    };
    sites.push(site);
    const group = groupFor(groupKey);
    group.material ||= material;
    group.sites.push(site);
    let values = group.states.get(property);
    if (!values) group.states.set(property, (values = new Set()));
    values.add(value);
  };

  const visit = (node) => {
    if (ts.isNewExpression(node) && /Material$/.test(shortCallee(node.expression, sf))) {
      const binding = newBinding(node, sf);
      groupFor(`${scopeId(node, sf)}|${binding}`).material = true;
    }

    if (ts.isBinaryExpression(node) && assignmentOperator(node.operatorToken.kind)) {
      const access = accessParts(node.left, sf);
      if (access && TRACKED.has(access.property)) {
        const op = operatorText(node.operatorToken.kind);
        const rhs = normalize(node.right.getText(sf));
        const value = op === "=" ? rhs : `${op}${rhs}`;
        add({
          node,
          property: access.property,
          kind: "write",
          value,
          fingerprint: `${rel}|write|${access.receiver}.${access.property}=${value}`,
          groupKey: `${scopeId(node, sf)}|${access.receiver}`
        });
      }
    } else if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) {
      const access = accessParts(node.operand, sf);
      if (access && TRACKED.has(access.property)) {
        const value = node.operator === ts.SyntaxKind.PlusPlusToken ? "++" : "--";
        add({
          node,
          property: access.property,
          kind: "write",
          value,
          fingerprint: `${rel}|write|${access.receiver}.${access.property}${value}`,
          groupKey: `${scopeId(node, sf)}|${access.receiver}`
        });
      }
    } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      const property = propertyName(node.name, sf);
      if (TRACKED.has(property)) {
        const context = constructionContext(node.parent, sf);
        const value = normalize(node.initializer.getText(sf));
        add({
          node,
          property,
          kind: "construct",
          value,
          fingerprint: `${rel}|construct:${context.label}|${property}=${value}`,
          groupKey: `${scopeId(node, sf)}|${context.binding}`,
          material: context.material
        });
      }
    } else if (ts.isShorthandPropertyAssignment(node) && TRACKED.has(node.name.text)) {
      const context = constructionContext(node.parent, sf);
      add({
        node,
        property: node.name.text,
        kind: "construct",
        value: node.name.text,
        fingerprint: `${rel}|construct:${context.label}|${node.name.text}=${node.name.text}`,
        groupKey: `${scopeId(node, sf)}|${context.binding}`,
        material: context.material
      });
    } else if (ts.isPropertyDeclaration(node) && node.initializer) {
      const property = propertyName(node.name, sf);
      if (TRACKED.has(property)) {
        const value = normalize(node.initializer.getText(sf));
        add({
          node,
          property,
          kind: "field",
          value,
          fingerprint: `${rel}|field|${property}=${value}`,
          groupKey: `${scopeId(node, sf)}|field:${property}`
        });
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sf);
  return { sites, groups };
}

function has(group, property, value) {
  return group.states.get(property)?.has(value) ?? false;
}

function groupDiagnostics(group) {
  const invalid = [];
  const risk = [];
  const alphaHash = has(group, "alphaHash", "true");
  const transparent = has(group, "transparent", "true");
  const additive = [...(group.states.get("blending") ?? [])].some((v) => /(?:^|\.)AdditiveBlending$/.test(v));
  const depthWriteFalse = has(group, "depthWrite", "false");
  const depthWriteTrue = has(group, "depthWrite", "true");
  const depthTestFalse = has(group, "depthTest", "false");

  if (alphaHash && transparent) invalid.push("alphaHash and transparent are both enabled");
  if (alphaHash && additive) invalid.push("alphaHash is combined with additive blending");
  if (alphaHash && depthWriteFalse) invalid.push("alphaHash has depthWrite disabled");
  if (additive && depthWriteTrue) invalid.push("additive blending explicitly writes depth");
  if (depthTestFalse && depthWriteTrue) invalid.push("depthTest is disabled while depthWrite is enabled");
  if (group.material && additive && !depthWriteFalse && !depthWriteTrue) {
    invalid.push("additive material inherits depthWrite=true");
  } else if (group.material && transparent && !depthWriteFalse && !depthWriteTrue) {
    risk.push("transparent material inherits depthWrite=true");
  }
  return { invalid, risk };
}

const scanned = sourceFiles(SRC).map(scanFile);
const sites = scanned.flatMap((x) => x.sites).sort((a, b) =>
  a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.property.localeCompare(b.property)
);
const groups = scanned.flatMap((x) => [...x.groups.values()]).filter((g) => g.sites.length > 0);

const actualCounts = new Map();
for (const site of sites) actualCounts.set(site.fingerprint, (actualCounts.get(site.fingerprint) ?? 0) + 1);

if (process.argv.includes("--print-baseline")) {
  console.log("const LEGACY_ALLOWLIST = new Map([");
  for (const [fingerprint, count] of [...actualCounts].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`  [${JSON.stringify(fingerprint)}, ${count}],`);
  }
  console.log("]);");
  process.exit(0);
}

const consumed = new Map();
const violations = [];
for (const site of sites) {
  const occurrence = (consumed.get(site.fingerprint) ?? 0) + 1;
  consumed.set(site.fingerprint, occurrence);
  site.legacy = occurrence <= (LEGACY_ALLOWLIST.get(site.fingerprint) ?? 0);
  if (!site.legacy) violations.push(site);
}

const invalidGroups = [];
const riskyGroups = [];
for (const group of groups) {
  const diagnostic = groupDiagnostics(group);
  if (diagnostic.invalid.length) invalidGroups.push({ group, messages: diagnostic.invalid });
  if (diagnostic.risk.length) riskyGroups.push({ group, messages: diagnostic.risk });
}

const counts = Object.fromEntries([...TRACKED].sort().map((key) => [key, sites.filter((s) => s.property === key).length]));
console.log(
  `[transparency] raw=${sites.length} files=${new Set(sites.map((s) => s.file)).size} ` +
  Object.entries(counts).map(([key, count]) => `${key}=${count}`).join(" ")
);

if (process.argv.includes("--list")) {
  for (const site of sites) {
    console.log(`  ${site.legacy ? "L" : "N"} ${site.file}:${site.line}:${site.column} ${site.kind} ${site.property}=${site.value}`);
  }
}

for (const { group, messages } of riskyGroups) {
  const first = group.sites[0];
  console.log(`[transparency] risk ${first.file}:${first.line} ${messages.join("; ")}`);
}

const newInvalid = invalidGroups.filter(({ group }) => group.sites.some((site) => !site.legacy));
for (const { group, messages } of invalidGroups) {
  const first = group.sites[0];
  const label = group.sites.every((site) => site.legacy) ? "legacy-invalid" : "invalid";
  console.error(`[transparency] ${label} ${first.file}:${first.line} ${messages.join("; ")}`);
}

if (violations.length) {
  console.error(`[transparency] ${violations.length} unallowlisted raw state site(s):`);
  for (const site of violations) {
    console.error(`  ${site.file}:${site.line}:${site.column} ${site.kind} ${site.property}=${site.value}`);
  }
}

const failed = violations.length > 0 || newInvalid.length > 0;
console.log(`[transparency] ${failed ? "FAIL" : "PASS"} legacy=${sites.length - violations.length} new=${violations.length}`);
process.exitCode = failed ? 1 : 0;
