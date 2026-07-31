import { POST_TUNING } from "../tuning"
import { TEMPORAL_TUNING } from "../temporal/tuning"
import { JITTER_TUNING } from "./tuning"

/**
 * The Halton(2,3) sequence, as a PURE FUNCTION of the presented-frame counter.
 *
 * Two stages need this number every frame and they need the SAME number: the
 * jitter stage offsets the projection before the beauty pass, and the temporal
 * resolve needs to know where each input sample actually landed to weight its
 * nine reconstruction taps. Stock TAAU couples them through a mutable
 * `_jitterIndex` field that `clearViewOffset()` increments (TAAUNode.js:369),
 * which is exactly the kind of hidden cross-frame state that desyncs the moment
 * anything renders the beauty pass without presenting.
 *
 * Deriving both from `PostFrameContext.frameIndex` instead means there is no
 * shared mutable state at all: a compile-held frame and a warmup covered render
 * never advance `frameIndex`, so they cannot desync the projection sequence
 * from the accumulated history. H-key still accumulation advances it on
 * purpose — each still present is a real Halton sample. It also makes the
 * sequence reproducible for a probe: frame N always has offset N.
 *
 * Stock's index wrap is `% (_haltonOffsets.length - 1)` (TAAUNode.js:370,
 * TRAANode.js:337), which silently never uses the 32nd entry. We use `% length`.
 */
const MAX_SEQUENCE_LENGTH = 64

function halton(index: number, base: number): number {
  let fraction = 1
  let result = 0
  let remaining = index
  while (remaining > 0) {
    fraction /= base
    result += fraction * (remaining % base)
    remaining = Math.floor(remaining / base)
  }
  return result
}

const HALTON_2_3: readonly (readonly [number, number])[] = Array.from(
  { length: MAX_SEQUENCE_LENGTH },
  (_, index) => [halton(index + 1, 2), halton(index + 1, 3)] as const
)

export type JitterOffset = {
  /** Offset in INPUT pixels — the unit `camera.setViewOffset(inputW, inputH, x, y, …)`
   *  takes, and the unit the temporal resolve's tap centres are expressed in. */
  readonly x: number
  readonly y: number
}

export const NO_JITTER: JitterOffset = { x: 0, y: 0 }

/**
 * Jitter without a temporal resolve is strictly worse than no jitter — it is
 * per-frame sub-pixel shimmer with nothing accumulating it back into a stable
 * image. So the sequence is live only when the chain is on AND the temporal
 * stage is on AND the artist has not zeroed the radius.
 */
export function jitterActive(): boolean {
  if (POST_TUNING.values.enabled !== true) return false
  if (TEMPORAL_TUNING.values.enabled !== true) return false
  return Number(JITTER_TUNING.values.amount) > 0
}

function sequenceLength(): number {
  const raw = Math.round(Number(JITTER_TUNING.values.sequenceLength))
  if (!Number.isFinite(raw)) return 32
  return Math.max(1, Math.min(MAX_SEQUENCE_LENGTH, raw))
}

/**
 * This frame's sub-pixel offset, in INPUT pixels.
 *
 * `space` decides what one unit of jitter spans, and the two answers differ by
 * the resolution ratio:
 *
 *  - **"input"** (default) — the offset spans one input pixel, ±0.5. This is
 *    what stock TAAU actually does (`TAAUNode.js:340-354` passes the raw
 *    `halton - 0.5` straight into `setViewOffset(inputWidth, …)` with
 *    `fullWidth === inputWidth`), and it is what FSR2 does, because the sample
 *    positions have to cover the whole input pixel footprint for the
 *    reconstruction filter to have anything to reconstruct FROM. At scale
 *    0.667 one input pixel is 1.5 output pixels, so a narrower jitter leaves
 *    most output pixel centres never directly sampled by any frame.
 *  - **"output"** — the offset spans one output pixel. This is what TAAU's own
 *    doc comment at `TAAUNode.js:336-339` and BRIEF §4.1 both describe, and
 *    what the code does not do: the comment says "we shrink the input-pixel-unit
 *    offset by the ratio of input to output resolution" and no such shrink
 *    appears anywhere in the file. Narrower jitter converges to a more stable
 *    but softer image.
 *
 * Both are one dropdown apart and cost nothing (a CPU multiply), because the
 * resolve reads the same number back as a uniform either way. The default
 * follows upstream's shipped behaviour rather than upstream's comment; at
 * `scale: 1` the two are identical.
 */
export function jitterOffsetAt(
  frameIndex: number,
  inputWidth: number,
  outputWidth: number
): JitterOffset {
  if (!jitterActive()) return NO_JITTER

  const length = sequenceLength()
  const index = ((Math.trunc(frameIndex) % length) + length) % length
  const sample = HALTON_2_3[index]

  const amount = Number(JITTER_TUNING.values.amount)
  const space = String(JITTER_TUNING.values.space)
  const ratio =
    space === "output" && inputWidth > 0 && outputWidth > 0
      ? Math.min(1, inputWidth / outputWidth)
      : 1
  const scale = amount * ratio

  return { x: (sample[0] - 0.5) * scale, y: (sample[1] - 0.5) * scale }
}
