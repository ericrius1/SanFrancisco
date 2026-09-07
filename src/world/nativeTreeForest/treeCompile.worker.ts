import { compileTree, treePrototypeTransferables, type TreeRecipe } from "../treeCompiler";
import { bakeTreeImpostor } from "./impostorBake";

type CompileRequest = {
  id: number;
  recipe: TreeRecipe;
  seed: number;
};

type CompileWorkerScope = {
  onmessage: ((event: MessageEvent<CompileRequest>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

const scope = self as unknown as CompileWorkerScope;

scope.onmessage = (event) => {
  const { id, recipe, seed } = event.data;
  try {
    const compiled = compileTree(recipe, seed);
    const impostor = bakeTreeImpostor(compiled.lods[3] ?? compiled.lods[compiled.lods.length - 1]);
    const prototype = { ...compiled, impostor };
    scope.postMessage(
      { id, ok: true, prototype },
      [...treePrototypeTransferables(prototype), impostor.color.buffer, impostor.hulls.buffer] as Transferable[]
    );
  } catch (error) {
    const value = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "Error", message: String(error) };
    scope.postMessage({ id, ok: false, error: value });
  }
};
