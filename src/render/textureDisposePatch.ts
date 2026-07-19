import type * as THREE from "three/webgpu";

// Three r185's Textures._destroyTexture() correctly invalidates its CPU-side
// bind-group cache, but WebGPU render bundles have already captured the raw
// GPUBindGroup. Destroying that group's GPUTexture synchronously makes a later
// bundle replay invalidate the ENTIRE command-buffer submit. The visible result
// is the canvas clear colour plus a permanent validation storm such as:
//   Destroyed texture "ShadowDepthTexture" used in a submit.
//
// Logical disposal still happens immediately (Three drops its backend entry and
// cached bindings). Only raw GPUTexture.destroy() is deferred. Two completed
// pipeline frames let retained bundles re-record without the resource; waiting
// for queue completion then proves no submitted command still owns it.

type GPUTextureLike = { destroy(): void };
type TextureLike = { isExternalTexture?: boolean };
type TextureData = {
  texture?: GPUTextureLike;
  msaaTexture?: GPUTextureLike;
};
type BackendLike = {
  device?: { queue?: { onSubmittedWorkDone(): Promise<unknown> } };
  get(texture: object): TextureData;
  delete(texture: object): unknown;
  destroyTexture(texture: TextureLike, isDefaultTexture?: boolean): void;
};
type Retirement = {
  textures: GPUTextureLike[];
  eligibleFrame: number;
};
type RetirementState = {
  completedFrames: number;
  pending: Retirement[];
  destroyed: number;
};

const states = new WeakMap<object, RetirementState>();

export function installDeferredTextureDisposePatch(renderer: THREE.WebGPURenderer): void {
  if (states.has(renderer)) return;
  const backend = renderer.backend as unknown as BackendLike;
  if (typeof backend.destroyTexture !== "function") {
    throw new Error("textureDisposePatch: WebGPU backend has no destroyTexture()");
  }

  const state: RetirementState = { completedFrames: 0, pending: [], destroyed: 0 };
  const original = backend.destroyTexture.bind(backend);
  backend.destroyTexture = (texture: TextureLike, isDefaultTexture = false): void => {
    const data = backend.get(texture);
    const retired = new Set<GPUTextureLike>();
    if (!isDefaultTexture && texture.isExternalTexture !== true && data.texture) {
      retired.add(data.texture);
    }
    if (data.msaaTexture) retired.add(data.msaaTexture);

    if (retired.size === 0) {
      original(texture, isDefaultTexture);
      return;
    }

    // Match WebGPUTextureUtils.destroyTexture's immediate logical teardown.
    // Textures._destroyTexture continues by releasing binding wrappers and its
    // own DataMap entry; only raw GPU destruction moves to the retirement queue.
    backend.delete(texture);
    state.pending.push({
      textures: [...retired],
      eligibleFrame: state.completedFrames + 2
    });
  };
  states.set(renderer, state);
}

/**
 * Mark one fully submitted pipeline frame. Compile-held/skipped frames must not
 * call this: a wall-clock rAF is not proof that retained bundles re-recorded.
 */
export function markTextureDisposalFrame(renderer: THREE.WebGPURenderer): void {
  const state = states.get(renderer);
  if (!state) return;
  state.completedFrames += 1;

  const ready: GPUTextureLike[] = [];
  for (let i = state.pending.length - 1; i >= 0; i--) {
    const retirement = state.pending[i];
    if (retirement.eligibleFrame > state.completedFrames) continue;
    ready.push(...retirement.textures);
    state.pending.splice(i, 1);
  }
  if (ready.length === 0) return;

  const queue = (renderer.backend as unknown as BackendLike).device?.queue;
  const drained = queue?.onSubmittedWorkDone() ?? Promise.resolve();
  void drained.then(() => {
    for (const texture of ready) texture.destroy();
    state.destroyed += ready.length;
  }).catch((error) => {
    // Device loss owns the resources from here; never create an unhandled
    // rejection while the renderer's normal device-loss path reports it.
    console.warn("[render] deferred GPU texture retirement skipped:", error);
  });
}

/** Probe/test diagnostics; no renderer internals or GPU objects are exposed. */
export function deferredTextureDisposalState(renderer: THREE.WebGPURenderer): {
  completedFrames: number;
  pending: number;
  destroyed: number;
} | null {
  const state = states.get(renderer);
  return state
    ? {
        completedFrames: state.completedFrames,
        pending: state.pending.reduce((count, item) => count + item.textures.length, 0),
        destroyed: state.destroyed
      }
    : null;
}
