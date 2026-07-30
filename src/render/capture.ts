import * as THREE from "three/webgpu";

// WebGPU enum values are stable; TypeScript's DOM lib still omits their names.
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_MAP_MODE_READ = 0x0001;

export type CaptureRuntime = {
  /** Non-null only under `?fastcapture`; every live frame presents into it. */
  readonly fastCaptureTarget: THREE.RenderTarget | null;
  readonly fastCaptureSize: readonly [number, number] | null;
  /** Browser-native review capture reads the final post-FX texture here. */
  queueFastFrame(): Promise<Uint8ClampedArray | null>;
  drainFastFrame(): Promise<Uint8ClampedArray | null>;
  /** One-shot GPU readback of the presented frame for in-game stills (H key). */
  captureStillRgba(): Promise<{ width: number; height: number; pixels: Uint8ClampedArray }>;
  dispose(): void;
};

/**
 * Both GPU readback paths, extracted from pipeline.ts intact.
 *
 * They are deliberately different shapes: `?fastcapture` redirects EVERY live
 * frame into a ping-pong pair of mapped buffers (allocated once at construction
 * and never resized — pin the adaptive-resolution governor for any fastcapture
 * session), while the H-key still allocates on demand and restores the canvas
 * afterwards.
 *
 * Both take a `present` callback rather than a pipeline: the caller decides what
 * "one complete frame" means, which is what lets the still path stay correct as
 * the chain grows stages.
 */
export function createCaptureRuntime(deps: {
  renderer: THREE.WebGPURenderer;
  /** Draw one complete presented frame into the currently bound render target. */
  present: () => void;
  /** Per-frame state the still path would otherwise skip (wireframe camera, …). */
  beforeStill?: () => void;
  /** Called before AND after a still so it neither poisons nor inherits history. */
  invalidateHistory?: (reason: string) => void;
}): CaptureRuntime {
  const { renderer, present } = deps;

  const fastCaptureEnabled = new URLSearchParams(location.search).has("fastcapture");
  const fastCaptureSize = new THREE.Vector2();
  let fastCaptureTarget: THREE.RenderTarget | null = null;
  let fastReadback:
    | {
        buffers: any[];
        bytesPerRow: number;
        nextSlot: number;
        pending: { slot: number; mapped: Promise<unknown> } | null;
      }
    | null = null;
  if (fastCaptureEnabled) {
    renderer.getDrawingBufferSize(fastCaptureSize);
    fastCaptureTarget = new THREE.RenderTarget(fastCaptureSize.x, fastCaptureSize.y, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: false,
      stencilBuffer: false
    });
    fastCaptureTarget.texture.name = "cinematic-fast-final-color";
    const backend = renderer.backend as any;
    const bytesPerRow = Math.ceil((fastCaptureSize.x * 4) / 256) * 256;
    fastReadback = {
      buffers: [0, 1].map(() => backend.device.createBuffer({
        size: bytesPerRow * fastCaptureSize.y,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ
      })),
      bytesPerRow,
      nextSlot: 0,
      pending: null
    };
  }

  const drainFastSlot = (slot: number) => {
    if (!fastCaptureTarget || !fastReadback) throw new Error("fast cinematic readback is not enabled");
    const width = fastCaptureTarget.width;
    const height = fastCaptureTarget.height;
    const tightStride = width * 4;
    const padded = new Uint8Array(fastReadback.buffers[slot].getMappedRange());
    const tight = new Uint8ClampedArray(tightStride * height);
    if (fastReadback.bytesPerRow === tightStride) tight.set(padded.subarray(0, tight.length));
    else {
      for (let y = 0; y < height; y++) {
        tight.set(
          padded.subarray(y * fastReadback.bytesPerRow, y * fastReadback.bytesPerRow + tightStride),
          y * tightStride
        );
      }
    }
    fastReadback.buffers[slot].unmap();
    return tight;
  };

  const queueFastFrame = async () => {
    if (!fastCaptureTarget || !fastReadback) throw new Error("fast cinematic render target is not enabled");
    const backend = renderer.backend as any;
    const texture = backend.get(fastCaptureTarget.texture).texture;
    if (!texture) throw new Error("fast cinematic GPU texture is not initialized");
    const slot = fastReadback.nextSlot;
    const encoder = backend.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      {
        buffer: fastReadback.buffers[slot],
        bytesPerRow: fastReadback.bytesPerRow,
        rowsPerImage: fastCaptureTarget.height
      },
      [fastCaptureTarget.width, fastCaptureTarget.height, 1]
    );
    backend.device.queue.submit([encoder.finish()]);
    const mapped = fastReadback.buffers[slot].mapAsync(GPU_MAP_MODE_READ);
    const previous = fastReadback.pending;
    fastReadback.pending = { slot, mapped };
    fastReadback.nextSlot = 1 - slot;
    if (!previous) return null;
    await previous.mapped;
    return drainFastSlot(previous.slot);
  };

  const drainFastFrame = async () => {
    if (!fastReadback?.pending) return null;
    const pending = fastReadback.pending;
    fastReadback.pending = null;
    await pending.mapped;
    return drainFastSlot(pending.slot);
  };

  // On-demand still capture for the H-key in-game screenshot path. Unlike
  // ?fastcapture=1 (which redirects every live frame into a ping-pong RT), this
  // only allocates when a still is requested and restores the canvas afterward.
  let stillCaptureTarget: THREE.RenderTarget | null = null;
  let stillReadbackBuffer: { destroy(): void; mapAsync(mode: number): Promise<unknown>; getMappedRange(): ArrayBuffer; unmap(): void } | null =
    null;
  let stillBytesPerRow = 0;

  const ensureStillCapture = (width: number, height: number) => {
    const backend = renderer.backend as any;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    const needsTarget =
      !stillCaptureTarget || stillCaptureTarget.width !== width || stillCaptureTarget.height !== height;
    if (needsTarget) {
      stillCaptureTarget?.dispose();
      stillCaptureTarget = new THREE.RenderTarget(width, height, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false
      });
      stillCaptureTarget.texture.name = "in-game-still-final-color";
    }
    if (!stillReadbackBuffer || stillBytesPerRow !== bytesPerRow || needsTarget) {
      stillReadbackBuffer?.destroy();
      stillReadbackBuffer = backend.device.createBuffer({
        size: bytesPerRow * height,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ
      });
      stillBytesPerRow = bytesPerRow;
    }
  };

  const captureStillRgba = async () => {
    const size = new THREE.Vector2();
    renderer.getDrawingBufferSize(size);
    const width = Math.max(1, Math.round(size.x));
    const height = Math.max(1, Math.round(size.y));
    ensureStillCapture(width, height);
    if (!stillCaptureTarget || !stillReadbackBuffer) {
      throw new Error("in-game still capture buffers failed to allocate");
    }

    deps.beforeStill?.();
    // The still does not go through the chain's frame driver, so its render must
    // not be allowed to accumulate into (or read from) the live temporal
    // history — before AND after.
    deps.invalidateHistory?.("still-capture");

    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmapLevel = renderer.getActiveMipmapLevel();
    renderer.setRenderTarget(stillCaptureTarget);
    present();
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);

    deps.invalidateHistory?.("still-capture-done");

    const backend = renderer.backend as any;
    const texture = backend.get(stillCaptureTarget.texture).texture;
    if (!texture) throw new Error("in-game still GPU texture is not initialized");

    const encoder = backend.device.createCommandEncoder();
    encoder.copyTextureToBuffer(
      { texture },
      {
        buffer: stillReadbackBuffer,
        bytesPerRow: stillBytesPerRow,
        rowsPerImage: height
      },
      [width, height, 1]
    );
    backend.device.queue.submit([encoder.finish()]);
    await stillReadbackBuffer.mapAsync(GPU_MAP_MODE_READ);

    const tightStride = width * 4;
    const padded = new Uint8Array(stillReadbackBuffer.getMappedRange());
    const tight = new Uint8ClampedArray(tightStride * height);
    if (stillBytesPerRow === tightStride) tight.set(padded.subarray(0, tight.length));
    else {
      for (let y = 0; y < height; y++) {
        tight.set(
          padded.subarray(y * stillBytesPerRow, y * stillBytesPerRow + tightStride),
          y * tightStride
        );
      }
    }
    stillReadbackBuffer.unmap();
    return { width, height, pixels: tight };
  };

  return {
    get fastCaptureTarget() {
      return fastCaptureTarget;
    },
    fastCaptureSize: fastCaptureTarget
      ? ([fastCaptureTarget.width, fastCaptureTarget.height] as const)
      : null,
    queueFastFrame,
    drainFastFrame,
    captureStillRgba,
    dispose() {
      fastCaptureTarget?.dispose();
      stillCaptureTarget?.dispose();
      stillReadbackBuffer?.destroy();
      stillReadbackBuffer = null;
    }
  };
}
