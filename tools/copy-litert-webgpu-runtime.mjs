import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const source = join(root, "node_modules", "@litertjs", "core", "wasm");
const destination = join(root, "public", "litert-wasm");
const runtimeFiles = ["litert_wasm_internal.js", "litert_wasm_internal.wasm"];

await mkdir(destination, { recursive: true });
await Promise.all(runtimeFiles.map((file) => copyFile(join(source, file), join(destination, file))));
console.info("[sf] prepared LiteRT WebGPU runtime");
