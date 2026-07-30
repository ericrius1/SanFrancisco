import { tunables } from "../../../core/persist"

export const JITTER_TUNING = tunables("post.jitter", {
  /** Jitter radius multiplier. 0 = no jitter, which is the debug identity. */
  amount: { v: 1, min: 0, max: 1.5, step: 0.05, label: "jitter amount" },
  /** Halton(2,3) cycle length, extracted from TAAUNode.js:819-822. */
  sequenceLength: { v: 32, min: 8, max: 64, step: 8, label: "· sequence" },
  /**
   * What one unit of jitter spans. NOT in the brief's table — it exists because
   * TAAU's own source contradicts itself about this and the tie can only be
   * broken by looking at a moving edge on the Golden Gate deck.
   * `TAAUNode.js:336-339` says the offset is shrunk to one OUTPUT pixel;
   * `:340-354` never shrinks it and jitters a full INPUT pixel, like FSR2.
   * Free to switch (one CPU multiply, no recompile, no reallocation), so the
   * verification phase gets an A/B instead of an argument. See sequence.ts.
   */
  space: { v: "input", options: { "input pixel": "input", "output pixel": "output" }, label: "· span" }
})
