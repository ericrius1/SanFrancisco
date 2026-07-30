import type { N } from "../types"

/**
 * `reversedDepthBuffer: true` (app/renderCore.ts:50) inverts the meaning of a
 * raw depth sample: background is **0.0** and the near plane is **1.0**. Stock
 * three barely accounts for it — exactly two lines in the whole display folder
 * do (TRAANode.js:466 and :511) — so every `depth.greaterThanEqual(1.0).discard()`
 * copied out of that folder discards NEAR geometry and shades the SKY. That is
 * the single most likely defect in any new stage here, and it is instantly
 * visible: capture the raw stage output at the Golden Gate deck and the sky is
 * lit while the near plane is black. Make that plate a hard gate before tuning
 * anything.
 *
 * Two further facts that belong next to this helper, because both have already
 * cost someone a day:
 *
 *  - `getViewPosition(uv, rawDepth, camera.projectionMatrixInverse)` is ALREADY
 *    correct under reversed depth. Renderer.js:3454 sets `camera._reversedDepth`,
 *    Matrix4.js:1159 builds a genuinely reversed projection, and
 *    PostProcessingUtils.js:18-37 feeds raw depth straight into `clip.z`. Do NOT
 *    add a `oneMinus()` there.
 *  - three's depth<->viewZ helpers are asymmetric. `perspectiveDepthToViewZ` /
 *    `orthographicDepthToViewZ` ARE reversed-aware (ViewportDepthNode.js:229,
 *    :179); `viewZToPerspectiveDepth` / `viewZToOrthographicDepth` are NOT
 *    (:203, :153), and their reversed twins at :215 / :165 are called by nothing
 *    in three. Raw depth → viewZ is safe with the stock helper; viewZ → depth is
 *    not. A stage that mixes the two ends up comparing depths in two different
 *    spaces — pick one space per stage and name it in a comment.
 *
 * Copied from contactShadows.ts:387-390, which is the one place in this repo
 * that already got it right. Every vendored node substitutes this for its own
 * background test.
 */
export const isGeometryDepth = (builder: any, depth: N): N =>
  builder.renderer.reversedDepthBuffer === true
    ? depth.greaterThan(1e-7) // reversed: background is 0.0
    : depth.lessThan(0.9999999) // standard: background is 1.0
