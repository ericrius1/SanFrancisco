import { execFile } from "node:child_process";
import { access, copyFile, mkdir, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const nodeModules = join(root, "node_modules");
const source = join(root, "node_modules", "@litertjs", "core", "wasm");
const destination = join(root, "public", "litert-wasm");
const runtimeFiles = ["litert_wasm_internal.js", "litert_wasm_internal.wasm"];
const run = promisify(execFile);

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Linked git worktrees do not inherit the primary checkout's ignored
 * node_modules directory. Reuse that installation automatically so every new
 * worktree can run npm dev/build scripts without a manual symlink step.
 */
async function ensureWorktreeDependencies() {
  if (await exists(nodeModules)) return;

  const { stdout } = await run("git", ["rev-parse", "--git-common-dir"], { cwd: root });
  const primaryRoot = dirname(resolve(root, stdout.trim()));
  const primaryNodeModules = join(primaryRoot, "node_modules");
  if (primaryRoot === root || !(await exists(primaryNodeModules))) {
    throw new Error(
      `[sf] node_modules is missing. Run npm install in the primary checkout (${primaryRoot}) first.`
    );
  }

  await symlink(primaryNodeModules, nodeModules, process.platform === "win32" ? "junction" : "dir");
  console.info(`[sf] linked worktree dependencies from ${primaryNodeModules}`);
}

await ensureWorktreeDependencies();
await mkdir(destination, { recursive: true });
await Promise.all(runtimeFiles.map((file) => copyFile(join(source, file), join(destination, file))));
console.info("[sf] prepared LiteRT WebGPU runtime");
