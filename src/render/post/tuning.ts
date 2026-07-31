import { tunables } from "../../core/persist"
import { governorEffects } from "../adaptiveResolution"
import { pocketTemporalScale } from "../pocketQuality"
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
 *
 * `quality` IS THE PRESET SELECTOR, and nothing in the renderer reads it. That
 * was a defect for as long as it was only a dropdown; it is now the key
 * `panel.ts` looks `PRESETS` up by, so choosing an option writes the enables
 * and resolutions of every stage below and changes real pixels. Two
 * consequences for anyone editing this spec:
 *
 *  - The option VALUES ("0.5" / "0.75"), not the labels, are the preset keys.
 *    Renaming an option is cosmetic; renumbering one silently un-wires that
 *    preset, because `PRESETS[String(value)]` simply misses and the click does
 *    nothing.
 *  - The stored value records the last preset CLICKED, not the current state of
 *    the chain — it is deliberately not re-applied on load, so hand-tuning a
 *    stage leaves it stale rather than clobbering your values on the next boot.
 *
 * Anything that would still be inert belongs deleted, not decorated: this group
 * is pinned in the `metta` folder and every key in it is expected to move the
 * image.
 */
export const POST_TUNING = tunables("post", {
  /**
   * THE MASTER BYPASS, AND IT SHIPS ON. The full reasoning, including the
   * acceptance gate it fails and why that is not the same question, is in
   * docs/POSTFX_CINEMATIC_PATHWAY.md §8.6 and in the header above. The short
   * version, recorded here because this one boolean is the whole policy:
   *
   *  - This is no longer "the chain" versus "the old image". The four style
   *    treatments and FXAA are deleted; bypassing runs the display tail alone,
   *    which is an image nobody has ever art-directed.
   *  - The temporal resolve is load-bearing beyond edges. With it off, citygen's
   *    alphaHash LOD crossfade renders every crossfading building as 1-px
   *    confetti — turning the chain off is a WORSE picture, not a cheaper one.
   *  - BRIEF §9.2's acceptance gate FAILS (+1.65…+2.08 ms at the botanical
   *    meadow, +5.09 ms on open water) and that is reported, not hidden: the
   *    cost is structural (temporal + bloom + the display tail all run at OUTPUT
   *    resolution and do not shrink with `post.temporal.scale`), so no default
   *    on this branch can close it. The lever that answers it is the user's:
   *    this toggle, and the `quality` presets below.
   */
  enabled: { v: true, label: "post chain" },
  /**
   * 0.75 = "high", WHICH IS WHAT THE CHAIN ACTUALLY SHIPS. There used to be a
   * third "cinematic" rung (value 1) that cranked SSAO/SSR to full res, native
   * temporal scale, and DOF — it looked worse than the shipped defaults and is
   * gone. `PRESETS["0.75"]` is contract-tested against every stage default on
   * disk (tools/post-chain-contract-test.mjs), so this label cannot go stale
   * again silently.
   *
   * Changing `options` changes this group's persistence fingerprint
   * (core/persist.ts:46-61), so the first boot after this lands discards
   * persisted `post.enabled` and `post.quality` overrides ONE time — including
   * anyone still holding the deleted cinematic value. `clearGroupOverrides`
   * only deletes one segment below the prefix, so `post.ssao.*`, `post.bloom.*`
   * and every sibling group are untouched.
   */
  quality: {
    v: 0.75,
    options: { low: 0.5, high: 0.75 },
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
 * Three authorities, composed in a fixed order, and the order is the whole
 * design:
 *
 *   ceiling = max(artist, pocket)      then      scale = min(ceiling, governor)
 *
 * The artist's `post.temporal.scale` is the baseline CEILING and the governor
 * composes BELOW it with `Math.min`, mirroring exactly how
 * `contactShadows.ts:306-318` composes its own governor axis.
 *
 * The pocket raises that ceiling and cannot pass a `Math.min`, which is why it
 * is a separate term rather than a fourth argument to the same clamp. A thinned
 * interior asks for a NATIVE beauty pass resolved by TAA (`pocketQuality.ts:182`)
 * in place of the 1.5x pixel-ratio supersample it used to buy coverage with;
 * `max` is how a request ABOVE the artist default survives. It returns 0 when
 * not asking, so the max is inert outdoors.
 *
 * The governor still gets the last word, and it degrades from the ARTIST value
 * rather than from the pocket's raised request (`adaptiveResolution.ts:158-161`
 * carries that reasoning) — so an interior that turns out too heavy is walked
 * back down the same ladder as the open world, and no rung the governor
 * publishes can ever sit above the artist's own number.
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
  // Read straight off GovernorEffects rather than through a structural cast.
  // The cast that stood here while the field was still landing would have kept
  // compiling — and silently fallen back to 1 — if `temporalScale` were ever
  // renamed or dropped, disarming the governor's only per-pixel lever with no
  // error anywhere. A plain property read makes that a tsc failure.
  const governor = Number(governorEffects().temporalScale)
  const ceiling = Math.max(
    Number.isFinite(artist) ? artist : 1,
    // 0 when the pocket is not asking, so this is a no-op in the open world.
    pocketTemporalScale()
  )
  const scale = Math.min(ceiling, Number.isFinite(governor) ? governor : 1)
  return Math.min(1, Math.max(0.4, scale))
}
