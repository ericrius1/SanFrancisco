// DebugRegistry — typed backing store for `window.__sf` (see
// docs/MAIN_DECOMPOSITION.md, step 4). Replaces the hand-maintained ~130-entry
// object literal that boot() used to assemble inline.
//
// Two entry kinds, matching the two value semantics the old literal expressed
// implicitly (and error-prone-ly):
//
//   ref(key, value)   — a stable handle captured once. Use for `const`s and for
//                       values that ARE functions (an opener/getter stored as-is
//                       so consumers call `__sf.getPaintAudio()`); the function
//                       is the value, not something to invoke at build time.
//   getter(key, get)  — a thunk evaluated at build() time. Use for mutable `let`
//                       aliases and computed reads (`teaGarden.current()`,
//                       `pickleballController?.game ?? null`) so the snapshot
//                       reflects the live binding rather than a frozen initial
//                       value.
//
// `build()` produces the plain object assigned to `window.__sf`. It is byte-
// compatible with the prior literal: the same keys map to the same values, since
// the exposure runs at the same single point in boot (all `let`s still at their
// initial values there; live updates continue to flow through the existing
// Object.assign refresh paths, e.g. onSitesChanged).

export type DebugEntry =
  | { readonly kind: "ref"; readonly value: unknown }
  | { readonly kind: "getter"; readonly get: () => unknown };

export class DebugRegistry {
  private readonly entries = new Map<string, DebugEntry>();

  /** Register a stable value (a `const` handle, or a function stored as-is). */
  ref(key: string, value: unknown): this {
    this.entries.set(key, { kind: "ref", value });
    return this;
  }

  /** Register a live getter, evaluated on each build(). Use for mutable `let`
   *  aliases and computed reads. */
  getter(key: string, get: () => unknown): this {
    this.entries.set(key, { kind: "getter", get });
    return this;
  }

  /** Batch-register stable values from a record of {key: value}. */
  refs(record: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(record)) this.ref(key, value);
    return this;
  }

  /** Batch-register live getters from a record of {key: () => value}. */
  getters(record: Record<string, () => unknown>): this {
    for (const [key, get] of Object.entries(record)) this.getter(key, get);
    return this;
  }

  /** Build the plain snapshot object exposed as `window.__sf`. */
  build(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of this.entries) {
      out[key] = entry.kind === "ref" ? entry.value : entry.get();
    }
    return out;
  }
}
