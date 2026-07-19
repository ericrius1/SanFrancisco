import assert from "node:assert/strict";
import {
  deferredTextureDisposalState,
  installDeferredTextureDisposePatch,
  markTextureDisposalFrame
} from "../src/render/textureDisposePatch.ts";

let resolveQueue!: () => void;
const queueDone = new Promise<void>((resolve) => {
  resolveQueue = resolve;
});
let rawDestroyCount = 0;
let backendDeleteCount = 0;
let originalDestroyCount = 0;
const rawTexture = { destroy: () => rawDestroyCount++ };
const logicalTexture = {};
const textureData = new Map<object, object>([[logicalTexture, { texture: rawTexture }]]);
const renderer = {
  backend: {
    device: { queue: { onSubmittedWorkDone: () => queueDone } },
    get: (texture: object) => textureData.get(texture) ?? {},
    delete: (texture: object) => {
      backendDeleteCount++;
      textureData.delete(texture);
    },
    destroyTexture: () => {
      originalDestroyCount++;
    }
  }
};

installDeferredTextureDisposePatch(renderer as never);
renderer.backend.destroyTexture(logicalTexture);

assert.equal(backendDeleteCount, 1, "logical backend texture state must retire immediately");
assert.equal(originalDestroyCount, 0, "raw-texture disposal must take the deferred path");
assert.equal(rawDestroyCount, 0, "the first command epoch must retain the raw texture");
assert.equal(deferredTextureDisposalState(renderer as never)?.pending, 1);

markTextureDisposalFrame(renderer as never);
await Promise.resolve();
assert.equal(rawDestroyCount, 0, "one completed frame is not enough to retire retained bundles");

markTextureDisposalFrame(renderer as never);
await Promise.resolve();
assert.equal(rawDestroyCount, 0, "GPU queue completion must gate raw destruction");

resolveQueue();
await queueDone;
await Promise.resolve();
assert.equal(rawDestroyCount, 1, "raw texture must retire after two frames and queue completion");
assert.deepEqual(deferredTextureDisposalState(renderer as never), {
  completedFrames: 2,
  pending: 0,
  destroyed: 1
});

console.log("texture dispose patch: ok (logical immediate, raw GPU destroy after 2 frames + queue drain)");
