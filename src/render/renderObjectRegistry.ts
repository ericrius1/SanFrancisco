// Per-object RenderObject release (M9, blocker-1 fix for the M6 shared-material
// refactor).
//
// three r185's renderer-common RenderObject subscribes to BOTH its material's
// and its geometry's `dispose` events — but the two listeners are NOT
// symmetric: `onGeometryDispose` only nulls the render object's attribute
// caches (RenderObject.js:337-344), while ONLY `onMaterialDispose` calls
// `renderObject.dispose()`, which is the sole path to the RenderObjects
// cleanup (RenderObjects.js:201-209: pipelines.delete refcount,
// bindings.deleteForRender, nodes.delete, chainMap delete, listener removal).
//
// M6 replaced per-caster material CLONES with process-wide shared materials to
// kill a ~270 ms-per-attach pipeline-build storm — correct — but retired
// meshes' RenderObjects then had NO release path: they sat forever in the
// shared material's `_listeners.dispose` array, pinning the retired mesh, its
// merged geometry arrays, NodeBuilderStates and per-object bind groups.
// Unbounded per-session growth.
//
// This registry keeps the shared materials (so live pipelines never churn and
// the storm can never return) and releases retired RenderObjects DIRECTLY:
// `createRenderObject` is wrapped once per renderer to index render objects by
// their Object3D, and owners call `releaseRenderObjectsFor(mesh)` when they
// retire a mesh. `renderObject.dispose()` performs exactly the cleanup the
// per-clone material dispose used to trigger — pipelines are refcounted
// (Pipelines.js `usedTimes`), so the shared pipeline survives while any live
// user remains and no recompile is ever provoked.
import type * as THREE from "three/webgpu";

type RegistryRenderObject = {
  dispose(): void;
  onDispose: (() => void) | null;
};

type RenderObjectsComponent = {
  createRenderObject: (...args: unknown[]) => RegistryRenderObject;
};

const trackedByObject = new WeakMap<object, Set<RegistryRenderObject>>();
const installedRenderers = new WeakSet<object>();
let releasedTotal = 0;

// `?m9norelease=1`: QA escape hatch — disable the deferred release entirely so
// probe A/Bs can attribute GPU validation noise on one build. Leaks when on.
const releaseDisabled =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("m9norelease");

/**
 * Wrap the renderer's RenderObjects factory so every render object is indexed
 * by its Object3D. Install once, right after `renderer.init()` (the `_objects`
 * component exists only after init) — same pattern as applyBundleOrderPatch.
 */
export function installRenderObjectRegistry(renderer: THREE.WebGPURenderer): void {
  if (installedRenderers.has(renderer)) return;
  const objects = (renderer as unknown as { _objects?: RenderObjectsComponent })._objects;
  if (!objects || typeof objects.createRenderObject !== "function") {
    throw new Error("renderObjectRegistry: renderer has no _objects component (call after init())");
  }
  const original = objects.createRenderObject;
  objects.createRenderObject = function (this: unknown, ...args: unknown[]): RegistryRenderObject {
    const renderObject = original.apply(this, args);
    // createRenderObject(nodes, geometries, renderer, object, material, ...)
    const object = args[3] as object | undefined;
    if (object && typeof object === "object") {
      let set = trackedByObject.get(object);
      if (!set) {
        set = new Set();
        trackedByObject.set(object, set);
      }
      set.add(renderObject);
      // Chain the RenderObjects cleanup so every dispose path (ours, cache-key
      // recreation inside RenderObjects.get, a future material dispose) also
      // drops the index entry. The once-guard keeps the pipelines/bindings
      // refcount cleanup from running twice if a queued deferred release races
      // another dispose path.
      const inner = renderObject.onDispose;
      let cleaned = false;
      renderObject.onDispose = () => {
        if (cleaned) return;
        cleaned = true;
        set.delete(renderObject);
        inner?.();
      };
    }
    return renderObject;
  };
  installedRenderers.add(renderer);
}

// Deferred disposal queue. `renderObject.dispose()` destroys the object's
// uniform GPU buffers IMMEDIATELY (Bindings.deleteForRender →
// _destroyBindings → backend.destroyUniformBuffer). Retained render bundles
// (tiles are BundleGroups) can still replay commands referencing those buffers
// until they re-record without the retired mesh, so disposing synchronously at
// retire produced `buffer used in submit while destroyed` validation storms
// (measured in the M9 leak roam). Two presented frames after retirement every
// bundle has re-recorded and no pending encoder references the buffers.
const pendingRelease: RegistryRenderObject[] = [];
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flushScheduled = false;
      const batch = pendingRelease.splice(0);
      for (const renderObject of batch) renderObject.dispose();
      releasedTotal += batch.length;
      // Releases enqueued between the two frames flush with the NEXT window.
      if (pendingRelease.length > 0) scheduleFlush();
    });
  });
}

/**
 * Dispose every RenderObject the renderer ever created for `object` (deferred
 * by two presented frames — see pendingRelease). Call when a mesh that shares
 * a long-lived material is retired for good — geometry dispose alone does NOT
 * release its RenderObjects (see module comment). Safe on objects that never
 * rendered (returns 0) and before the registry is installed (headless
 * contract tests construct proxies with no renderer).
 */
export function releaseRenderObjectsFor(object: object): number {
  if (releaseDisabled) return 0;
  const set = trackedByObject.get(object);
  if (!set || set.size === 0) return 0;
  const list = [...set];
  // Drop the index entries now (dispose also does this via the chained
  // onDispose, but the queue owns the objects from here).
  set.clear();
  pendingRelease.push(...list);
  scheduleFlush();
  return list.length;
}

// ---------------------------------------------------------------- leak metric
// DEV/probe surface: shared-material owners register a counter reading their
// material's `_listeners.dispose.length` — the exact retention array blocker 1
// is about. `__sf.m9Leak()` samples these during the long-roam probe; a
// plateau proves bounded retention.

const leakCounters = new Map<string, () => number>();

export function registerSharedMaterialLeakCounter(name: string, count: () => number): void {
  leakCounters.set(name, count);
}

/** Read `material._listeners.dispose.length` (0 when never listened). */
export function materialDisposeListenerCount(material: THREE.Material | null): number {
  const listeners = (material as unknown as { _listeners?: { dispose?: unknown[] } } | null)
    ?._listeners;
  return listeners?.dispose?.length ?? 0;
}

export function sharedMaterialLeakSnapshot(): Record<string, number> {
  const snapshot: Record<string, number> = { renderObjectsReleased: releasedTotal };
  for (const [name, count] of leakCounters) snapshot[name] = count();
  return snapshot;
}
