import { tunables } from "../../../core/persist"

export const JITTER_TUNING = tunables("post.jitter", {
  /** Jitter radius multiplier. 0 = no jitter, which is the debug identity. */
  amount: { v: 1, min: 0, max: 1.5, step: 0.05, label: "jitter amount" },
  /** Halton(2,3) cycle length, extracted from TAAUNode.js:819-822. */
  sequenceLength: { v: 32, min: 8, max: 64, step: 8, label: "· sequence" }
})
