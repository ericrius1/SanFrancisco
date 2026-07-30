import { tunables } from "../../core/persist"
import { governorEffects } from "../adaptiveResolution"
import { TEMPORAL_TUNING } from "./temporal/tuning"

/**
 * Chain-wide controls. Everything else lives under its own dotted path
 * (`post.ssao`, `post.bloom`, …) so a stage's spec can churn without discarding
 * a sibling's persisted overrides — `clearGroupOverrides` (core/persist.ts:174)
 * only deletes keys ONE segment below the prefix.
 *
 * `enabled` is the master bypass: off means the display tail samples the beauty
 * pass directly and no stage renders at all. It is the one-line policy change
 * that turns the whole chain into a "film" quality mode if the per-stage budget
 * in BRIEF §9.2 ever fails on the fanless M5 Air.
 */
export const POST_TUNING = tunables("post", {
  enabled: { v: true, label: "post chain" },
  quality: {
    v: 1,
    options: { low: 0.5, medium: 0.75, high: 1 },
    label: "· quality"
  }
})

/**
 * The beauty pass's resolution scale, relative to the drawing buffer.
 *
 * `adaptiveResolution.ts:123-132` stays "the single owner of the drawing
 * buffer" — this never touches `setPixelRatio`. It scales the beauty pass via
 * `PassNode.setResolutionScale`, which is *relative* to whatever the governor
 * decided, so there is no second authority and no fight.
 *
 * The artist's `post.temporal.scale` is a CEILING and the governor composes
 * below it with `Math.min`, mirroring exactly how `contactShadows.ts:306-318`
 * composes its own governor axis. The governor's `temporalScale` field is
 * additive (U11); until it exists this reads as 1 and the artist value wins.
 */
export function postInputScale(): number {
  if (!POST_TUNING.values.enabled) return 1
  // Only the temporal resolve can consume a lower-resolution beauty pass and
  // still present at output resolution. With it off, rendering the beauty pass
  // small would just be a blurrier frame.
  if (!TEMPORAL_TUNING.values.enabled) return 1
  // ...and only the TAAU fork can. TRAA has no reconstruction filter — it
  // resolves one input sample per output pixel — so driving the beauty pass
  // below the drawing buffer in `mode: "traa"` buys nothing and costs the whole
  // image. The stage says the same thing from its own side
  // (`TemporalStage.inputScale()`); this is deliberately a second reading of the
  // same tunable rather than a call into a stage instance, because the frame
  // driver needs the scale BEFORE the beauty pass renders and the chain has not
  // been reached yet at that point in pipeline.render().
  if (String(TEMPORAL_TUNING.values.mode) === "traa") return 1
  const artist = Number(TEMPORAL_TUNING.values.scale)
  const governor = Number(
    (governorEffects() as { temporalScale?: number }).temporalScale ?? 1
  )
  const scale = Math.min(
    Number.isFinite(artist) ? artist : 1,
    Number.isFinite(governor) ? governor : 1
  )
  return Math.min(1, Math.max(0.4, scale))
}
