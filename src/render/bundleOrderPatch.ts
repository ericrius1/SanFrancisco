import * as THREE from "three/webgpu";

/**
 * three r185 executes WebGPU render bundles at the END of a render pass
 * (WebGPUBackend.finishRender → currentPass.executeBundles), i.e. AFTER every
 * direct draw — opaque and transparent alike. Bundle content (our streamed
 * tiles: roads + baked buildings) therefore paints over anything that does not
 * write depth: additive fireworks sprites, street-lamp ground pools, paintball
 * glows, busker fireflies. Opaque objects survive only because their depth
 * writes make the late bundle draws fail the depth test.
 *
 * Minimal repro: tools/bundle-depth-probe.{html,mjs} — a sprite in front of a
 * BundleGroup box loses its pixels to the box (with or without reversed-z).
 *
 * Fix: execute each bundle the moment the renderer adds it. Renderer order is
 * bundles → opaque → transparent inside one pass, and addBundle() is called in
 * that first phase while the pass encoder is already open, so executing here
 * lands the static world FIRST, exactly where it belongs. executeBundles()
 * resets the render-pass state, so the backend's per-draw state cache must be
 * invalidated or the next direct draw would skip re-binding its pipeline.
 *
 * The layered depth-array path (cube/array render targets) keeps the stock
 * finishRender flow: there currentPass is null during the draw phase and the
 * bundles are replayed per layer at the end — transparency ordering does not
 * apply there.
 */
// project has no @webgpu/types — structural shapes for the two objects we touch
type PassEncoderLike = { executeBundles(bundles: object[]): void };
type RenderContextDataLike = {
  currentPass: PassEncoderLike | null;
  currentSets?: object;
  renderBundles: object[];
};

export function applyBundleOrderPatch(renderer: THREE.WebGPURenderer): void {
  const backend = renderer.backend as unknown as {
    get(object: object): RenderContextDataLike & { bundleGPU?: object };
    addBundle(renderContext: object, bundle: object): void;
  };
  if (typeof backend.addBundle !== "function") {
    throw new Error("WebGPU render-bundle support is unavailable.");
  }

  backend.addBundle = function (renderContext: object, bundle: object): void {
    const renderContextData = this.get(renderContext);
    const bundleGPU = this.get(bundle).bundleGPU!;
    if (renderContextData.currentPass) {
      renderContextData.currentPass.executeBundles([bundleGPU]);
      renderContextData.currentSets = { attributes: {}, bindingGroups: [], pipeline: null, index: null };
    } else {
      // layered render target path — bundles are replayed per layer in finishRender
      renderContextData.renderBundles.push(bundleGPU);
    }
  };
}
