import * as THREE from "three/webgpu";

/**
 * r185's WebGPUBackend closes occlusion queries that were never opened, which
 * invalidates the whole command buffer and silently drops that pass's submit.
 * Two independent paths do it; the symptom is identical for both:
 *
 *   No occlusion queries are active.
 *    - While encoding [RenderPassEncoder (unlabeled)].EndOcclusionQuery().
 *   [Invalid CommandBuffer from CommandEncoder "renderContext_N"] is invalid
 *    - While calling [Queue].Submit(...)
 *
 * (1) LISTED-BUT-NOT-DRAWN. Two bits of bookkeeping disagree:
 *   - `RenderList.push` increments `occlusionQueryCount` for every LISTED
 *     object carrying `occlusionTest` — it runs during scene projection, long
 *     before anything decides what actually draws.
 *   - `WebGPUBackend.draw` advances `occlusionQueryIndex` only for objects it
 *     actually DRAWS, and only there is `beginOcclusionQuery()` issued.
 * `finishRender` then treats `count > index` as "the last query is still open"
 * and ends one unconditionally. Any pass that lists an occlusion-tested object
 * and then declines to draw it trips this. A shadow pass always does:
 * `ShadowNode.updateShadow` installs a render-object function that skips
 * `castShadow === false`, while its render list was built from every visible
 * object — so an occlusion-gate query proxy (src/render/occlusionGate.ts:
 * `occlusionTest` true, `castShadow` false, `frustumCulled` false, hence listed
 * by every camera) leaves the count non-zero with no query ever opened, and the
 * light's shadow map is never written because its submit is thrown away. A
 * `PassNode` with `transparent = false` (the ink prepass) does the same to the
 * proxy's transparent material. The world sun escapes only by accident:
 * ClipmapShadowNode pins each domain camera to a dedicated shadow layer, so
 * layer-0 proxies are never listed. Lights on a stock ShadowNode — the piano
 * god-ray light, whose shadow camera inherits the beauty camera's full mask —
 * trip it on every frame they refresh.
 *
 * (2) STALE PER-CONTEXT STATE. `beginRender` resets `lastOcclusionObject` and
 * the query set only inside its `count > 0` branch. When a context's count
 * falls back to 0 — the gated content is disposed, an ancestor goes invisible,
 * a pipeline swap parks the context — both survive, so `draw` still sees a
 * defined `occlusionQuerySet` and a stale occlusion-tested `lastOcclusionObject`
 * and ends a query on a pass whose descriptor carries no query set at all. This
 * one hits the main beauty pass, independent of any shadow or god-ray graph.
 *
 * Both fixes keep three's own accounting and only correct what it is told:
 * report the number of queries that genuinely completed when none is open, and
 * forget the last occlusion object once a context stops issuing queries. The
 * healthy path — proxy drawn in the beauty pass, its query still open at pass
 * end — is left completely untouched.
 */
// project has no @webgpu/types — structural shapes for the two objects we touch
type OcclusionRenderContextLike = { occlusionQueryCount: number };
type OcclusionRenderContextDataLike = {
  occlusionQueryIndex?: number;
  lastOcclusionObject?: (THREE.Object3D & { occlusionTest?: boolean }) | null;
};

export function installOcclusionQueryPatch(renderer: THREE.WebGPURenderer): void {
  const backend = renderer.backend as unknown as {
    get(object: object): OcclusionRenderContextDataLike;
    beginRender(renderContext: OcclusionRenderContextLike): void;
    finishRender(renderContext: OcclusionRenderContextLike): void;
  };
  if (typeof backend.beginRender !== "function" || typeof backend.finishRender !== "function") {
    throw new Error("WebGPU backend is missing begin/finishRender; occlusion patch cannot install.");
  }

  const beginRender = backend.beginRender;
  backend.beginRender = function (renderContext: OcclusionRenderContextLike): void {
    if (renderContext.occlusionQueryCount === 0) {
      // Path (2). Nothing in this pass can open a query — count 0 means the
      // render list holds no occlusion-tested object at all — so a remembered
      // one can only produce a stray end. The query set itself is left alone:
      // three destroys it on the next `count > 0` begin, and clearing the
      // reference here would leak it instead.
      this.get(renderContext).lastOcclusionObject = null;
    }
    beginRender.call(this, renderContext);
  };

  const finishRender = backend.finishRender;
  backend.finishRender = function (renderContext: OcclusionRenderContextLike): void {
    const count = renderContext.occlusionQueryCount;
    if (count > 0) {
      const data = this.get(renderContext);
      const completed = data.occlusionQueryIndex ?? 0;
      const last = data.lastOcclusionObject;
      // Path (1). A query is open only if the last object this pass drew was
      // itself occlusion-tested; three ends that one legitimately. Anything else
      // means the listed proxies never reached a draw call in this pass.
      const queryOpen = last != null && last.occlusionTest === true;
      if (!queryOpen && count > completed) {
        renderContext.occlusionQueryCount = completed;
        try {
          finishRender.call(this, renderContext);
        } finally {
          renderContext.occlusionQueryCount = count;
        }
        return;
      }
    }
    finishRender.call(this, renderContext);
  };
}
