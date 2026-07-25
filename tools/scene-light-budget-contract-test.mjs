import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(ROOT, relative), "utf8");
const lightConstructors = (source) =>
  [...source.matchAll(/\bnew\s+THREE\.(AmbientLight|DirectionalLight|HemisphereLight|PointLight|RectAreaLight|SpotLight)\s*\(/g)]
    .map((match) => match[1]);
const sourceFiles = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(absolute)
      : entry.name.endsWith(".ts")
        ? [path.relative(ROOT, absolute)]
        : [];
  });

const runtimeConstructors = new Map([
  ["src/player/lightPool.ts", ["PointLight"]],
  ["src/world/sky.ts", ["DirectionalLight"]]
]);

for (const [file, expected] of runtimeConstructors) {
  const actual = lightConstructors(read(file));
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(
      `${file} must construct exactly ${expected.join(", ")}; found ${actual.join(", ") || "none"}`
    );
  }
}

const pool = read("src/player/lightPool.ts");
if (!/export const POOL_SIZE = 1\b/.test(pool)) {
  throw new Error("The contextual LightPool must contain exactly one PointLight");
}

// These helpers construct lights outside the main scene-light set: the ocean
// lab is a standalone two-light page, the clipmap creates shadow-only metadata,
// and piano god rays use an off-scene shadow-camera source.
const utilityConstructors = new Map([
  ["src/world/ocean/lab.ts", ["DirectionalLight", "HemisphereLight"]],
  ["src/world/shadows/clipmapShadowNode.ts", ["DirectionalLight"]],
  ["src/render/pianoGodRays.ts", ["DirectionalLight"]]
]);

for (const [file, expected] of utilityConstructors) {
  const actual = lightConstructors(read(file));
  if (actual.join(",") !== expected.join(",")) {
    throw new Error(
      `${file} light-helper contract changed; expected ${expected.join(", ")}, found ${actual.join(", ") || "none"}`
    );
  }
}

const allowedFiles = new Set([
  ...runtimeConstructors.keys(),
  ...utilityConstructors.keys()
]);
for (const file of sourceFiles(path.join(ROOT, "src"))) {
  const constructors = lightConstructors(read(file));
  if (constructors.length > 0 && !allowedFiles.has(file)) {
    throw new Error(
      `${file} constructs ${constructors.join(", ")} outside the two-light runtime and explicit off-scene helpers`
    );
  }
}

console.log("scene light budget contract: ok (sun/moon + one contextual point light)");
