import type { CompiledTreePrototype, TreeRecipe } from "../treeCompiler";

type CompileResponse =
  | { id: number; ok: true; prototype: CompiledTreePrototype }
  | { id: number; ok: false; error: { name: string; message: string; stack?: string } };

type PendingCompile = {
  resolve(prototype: CompiledTreePrototype): void;
  reject(error: Error): void;
};

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;
const pending = new Map<number, PendingCompile>();

function rejectPending(reason: unknown): void {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function getWorker(): Worker | null {
  if (worker || workerFailed || typeof Worker === "undefined") return worker;
  try {
    worker = new Worker(new URL("./treeCompile.worker.ts", import.meta.url), {
      type: "module",
      name: "native-tree-compiler"
    });
    worker.onmessage = (event: MessageEvent<CompileResponse>) => {
      const response = event.data;
      const request = pending.get(response.id);
      if (!request) return;
      pending.delete(response.id);
      if (response.ok) {
        request.resolve(response.prototype);
        return;
      }
      const error = new Error(response.error.message);
      error.name = response.error.name;
      if (response.error.stack) error.stack = response.error.stack;
      request.reject(error);
    };
    worker.onerror = (event) => {
      workerFailed = true;
      worker?.terminate();
      worker = null;
      rejectPending(new Error(event.message || "Native tree compiler worker failed"));
    };
    worker.onmessageerror = () => {
      workerFailed = true;
      worker?.terminate();
      worker = null;
      rejectPending(new Error("Native tree compiler worker returned an unreadable message"));
    };
  } catch (error) {
    workerFailed = true;
    console.warn("[native trees] compiler worker unavailable; retaining fallback foliage", error);
  }
  return worker;
}

/** Compile off the render thread, transferring every typed array without a copy. */
export async function compileTreeAsync(recipe: TreeRecipe, seed: number): Promise<CompiledTreePrototype> {
  const target = getWorker();
  if (!target) throw new Error("Native tree compiler worker is unavailable");
  const id = nextId++;
  return new Promise<CompiledTreePrototype>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      target.postMessage({ id, recipe, seed });
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function disposeTreeCompilerWorker(): void {
  worker?.terminate();
  worker = null;
  rejectPending(new Error("Native tree compiler worker disposed"));
}

if (import.meta.hot) import.meta.hot.dispose(disposeTreeCompilerWorker);
