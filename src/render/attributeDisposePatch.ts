// r185 interleaved-attribute dispose hotfix — the "buffer used in submit while
// destroyed" storm root cause (bufstorm probe, 2026-07).
//
// Stock `WebGPUAttributeUtils.destroyAttribute` resolves the backend data via
// `_getBufferAttribute(attribute)` — the shared InterleavedBuffer when the
// attribute is interleaved — destroys that GPU buffer, but then deletes the
// backend entry under the RAW attribute key. For interleaved attributes the
// InterleavedBuffer entry survives holding a destroyed GPUBuffer, and every
// later draw that resolves the same InterleavedBuffer reuses it instead of
// recreating: a permanent per-frame validation-error storm.
//
// The canonical trigger is three's module-global Sprite quad geometry (one
// interleaved position+uv buffer shared by EVERY Sprite in the app): a single
// site disposing a sprite's geometry poisoned all remaining sprites for the
// rest of the session. The site disposals are fixed too; this patch makes the
// failure class impossible — a mis-keyed dispose now fully evicts the entry so
// the next use recreates a live buffer.
import * as THREE from "three/webgpu";

type AttributeUtils = {
  _getBufferAttribute(attribute: unknown): unknown;
  destroyAttribute(attribute: unknown): void;
  backend: {
    get(o: unknown): { buffer?: { destroy(): void } };
    delete(o: unknown): void;
    has?(o: unknown): boolean;
  };
};

export function installAttributeDisposePatch(renderer: THREE.WebGPURenderer): void {
  const backend = renderer.backend as unknown as { attributeUtils?: AttributeUtils };
  const utils = backend.attributeUtils;
  if (!utils || typeof utils.destroyAttribute !== "function") {
    throw new Error("attributeDisposePatch: renderer backend has no attributeUtils");
  }
  if ((utils as unknown as { _sfDisposePatch?: boolean })._sfDisposePatch) return;
  (utils as unknown as { _sfDisposePatch?: boolean })._sfDisposePatch = true;

  utils.destroyAttribute = (attribute: unknown) => {
    // Same lookup key for destroy AND delete — the stock implementation's
    // asymmetry (delete by raw attribute) is the whole bug.
    const bufferAttribute = utils._getBufferAttribute(attribute);
    const data = utils.backend.get(bufferAttribute);
    data.buffer?.destroy();
    utils.backend.delete(bufferAttribute);
  };
}
