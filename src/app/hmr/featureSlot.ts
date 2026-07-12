export type DisposableFeature = { dispose(): void };

export type FeatureSlotStatus = {
  readonly generation: number;
  readonly lastSwapMs: number;
  readonly lastError: string | null;
  readonly pending: boolean;
};

/**
 * Stable indirection for a disposable feature. Callers keep the slot while HMR
 * constructs a replacement, captures/restores state, and tears down the old
 * instance. Replacement construction happens first so a broken edit leaves the
 * currently running feature intact.
 */
export class FeatureSlot<T extends DisposableFeature, State> {
  #current: T;
  #capture: (feature: T) => State;
  #generation = 0;
  #lastSwapMs = 0;
  #lastError: string | null = null;
  #onCommit: ((feature: T) => void) | null;
  #onFailure: ((error: unknown) => void) | null;
  #pending: ((state: State) => T) | null = null;

  constructor(
    initial: T,
    capture: (feature: T) => State,
    options?: { onCommit?: (feature: T) => void; onFailure?: (error: unknown) => void }
  ) {
    this.#current = initial;
    this.#capture = capture;
    this.#onCommit = options?.onCommit ?? null;
    this.#onFailure = options?.onFailure ?? null;
    this.#onCommit?.(initial);
  }

  get current(): T {
    return this.#current;
  }

  get status(): FeatureSlotStatus {
    return {
      generation: this.#generation,
      lastSwapMs: this.#lastSwapMs,
      lastError: this.#lastError,
      pending: this.#pending !== null
    };
  }

  /** Coalesces edits; the newest factory is committed by flush() at a frame boundary. */
  queue(build: (state: State) => T): void {
    this.#pending = build;
  }

  flush(): "replaced" | "failed" | null {
    const build = this.#pending;
    if (!build) return null;
    this.#pending = null;
    const previous = this.#current;
    const state = this.#capture(previous);
    let replacement: T;
    try {
      replacement = build(state);
    } catch (error) {
      this.#lastError = error instanceof Error ? error.message : String(error);
      console.error("[hmr] feature replacement build failed; keeping the previous instance", error);
      this.#onFailure?.(error);
      return "failed";
    }

    try {
      previous.dispose();
    } catch (error) {
      // The replacement is already valid. Commit it, but surface the cleanup
      // defect loudly because repeated swaps could otherwise leak resources.
      console.error("[hmr] previous feature cleanup failed", error);
    }
    this.#current = replacement;
    this.#generation += 1;
    this.#lastSwapMs = performance.now();
    this.#lastError = null;
    this.#onCommit?.(replacement);
    return "replaced";
  }

  dispose(): void {
    this.#pending = null;
    this.#current.dispose();
  }
}
