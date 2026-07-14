// Small browser-main-thread scheduling helpers for optional world construction.
// These are deliberately independent of requestIdleCallback: an idle callback can
// run for a long deadline, while world builders need to return to rendering after
// a short, predictable amount of synchronous work.

const now = (): number => globalThis.performance?.now() ?? Date.now();

/** Yield until the browser has had a chance to present another frame. */
export function yieldToFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    // A hidden document may throttle rAF indefinitely. The timeout keeps async
    // construction/disposal from hanging when the tab loses visibility.
    const timeout = setTimeout(finish, 50);
    if (
      typeof requestAnimationFrame === "function" &&
      (typeof document === "undefined" || document.visibilityState === "visible")
    ) {
      requestAnimationFrame(finish);
    } else {
      setTimeout(finish, 0);
    }
  });
}

/**
 * Return a checkpoint that yields after `budgetMs` of accumulated synchronous
 * work. Call it at natural ownership boundaries (chunks, batches, tiles).
 */
export function createFrameBudgetCheckpoint(budgetMs = 6): () => Promise<void> {
  let sliceStarted = now();
  return async () => {
    if (now() - sliceStarted < budgetMs) return;
    await yieldToFrame();
    sliceStarted = now();
  };
}
