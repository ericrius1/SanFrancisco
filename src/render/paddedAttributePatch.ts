// M10 sweep smoothness — r185 padded-attribute update hotfix.
//
// The WebGPU backend pads vertex attributes whose stride is not a 4-byte
// multiple (16-bit quantized tile geometry: position Int16x3 -> 8 B, normal
// Int8x3 -> 4 B). Stock `WebGPUAttributeUtils.updateAttribute` rebuilds the
// ENTIRE padded array on EVERY update — a per-vertex `subarray()` JS loop over
// the whole buffer — before honoring updateRanges for the actual GPU writes.
// For the shared streamed-tile BatchedMesh arenas (~1M vertices) that is
// ~250-300 ms of main-thread work per `setGeometryAt`, i.e. one giant hitch
// per streamed tile attach: the dominant frame spike of the materialize sweep
// (profiled: `updateAttribute` 7.9 s self time in a 10 s mid-sweep window).
//
// This patch keeps a persistent padded mirror per attribute and, when
// updateRanges are present, pads and uploads ONLY the touched vertex spans.
// Everything else (unpadded attributes, storage attributes whose array was
// already swapped to the padded layout at create time, interleaved data,
// range-less full updates) falls through to the stock implementation.
import * as THREE from "three/webgpu";
import { tracer } from "../core/hitchTracer";

type BufferLike = {
  array: ArrayLike<number> & {
    constructor: new (n: number) => Float32Array;
    BYTES_PER_ELEMENT: number;
  };
  count: number;
  itemSize: number;
  updateRanges: { start: number; count: number }[];
  clearUpdateRanges(): void;
};

type AttributeUtils = {
  _getBufferAttribute(attribute: unknown): BufferLike;
  updateAttribute(attribute: unknown): void;
  backend: {
    device: { queue: { writeBuffer(...args: unknown[]): void } };
    get(o: unknown): {
      buffer?: unknown;
      _itemSize?: number;
      _paddedItemSize?: number;
      _sfPaddedMirror?: Float32Array;
    };
  };
};

/** Copy [vertexStart, vertexEnd) from the tight source layout into the padded
 *  mirror. Plain indexed loops — no per-vertex subarray allocation. */
function padSpan(
  src: ArrayLike<number>,
  dst: Float32Array,
  itemSize: number,
  paddedItemSize: number,
  vertexStart: number,
  vertexEnd: number
): void {
  for (let i = vertexStart; i < vertexEnd; i++) {
    const s = i * itemSize;
    const d = i * paddedItemSize;
    for (let c = 0; c < itemSize; c++) dst[d + c] = src[s + c];
  }
}

export function installPaddedAttributePatch(renderer: THREE.WebGPURenderer): void {
  const backend = renderer.backend as unknown as { attributeUtils?: AttributeUtils };
  const utils = backend.attributeUtils;
  if (!utils) return;
  if ((utils as unknown as { _sfPaddedPatch?: boolean })._sfPaddedPatch) return;
  (utils as unknown as { _sfPaddedPatch?: boolean })._sfPaddedPatch = true;

  // createAttribute runs the same per-vertex `subarray()` padding loop when it
  // first uploads a padded attribute — ~hundreds of ms for the shared batch
  // arenas during P3. Pre-pad with tight indexed loops and hand the stock
  // implementation an already-4-byte-aligned attribute view? Not possible
  // without changing the attribute, so instead: pre-build the padded mirror
  // here (fast), stash it, and let updateAttribute reuse it. The creation
  // itself still runs the stock path, but we skip its slow loop by detecting
  // the common case (normalized quantized vertex data, no int16->int32
  // conversion) and temporarily swapping in a pre-padded fast `subarray`.
  const createOriginal = (utils as unknown as { createAttribute(a: unknown, u: number): void })
    .createAttribute.bind(utils);
  (utils as unknown as { createAttribute(a: unknown, u: number): void }).createAttribute = (
    attribute: unknown,
    usage: number
  ) => {
    const bufferAttribute = utils._getBufferAttribute(attribute);
    const bufferData = utils.backend.get(bufferAttribute);
    if (bufferData.buffer === undefined && bufferAttribute.itemSize > 1) {
      const src = bufferAttribute.array as unknown as Float32Array;
      const bytesPerElement = src.BYTES_PER_ELEMENT;
      const needsInt16Patch =
        (bufferAttribute as unknown as { normalized?: boolean }).normalized === false &&
        (src.constructor === Int16Array ||
          src.constructor === Int8Array ||
          src.constructor === Uint16Array ||
          src.constructor === Uint8Array);
      const isStorage = Boolean(
        (bufferAttribute as unknown as { isStorageBufferAttribute?: boolean }).isStorageBufferAttribute ||
        (bufferAttribute as unknown as { isStorageInstancedBufferAttribute?: boolean })
          .isStorageInstancedBufferAttribute
      );
      const byteStride = bufferAttribute.itemSize * bytesPerElement;
      if (!needsInt16Patch && !isStorage && byteStride % 4 !== 0) {
        // Fast pre-pad (tight loops), then create the GPU buffer ourselves the
        // same way the stock path does — mapped at creation, single set().
        const itemSize = bufferAttribute.itemSize;
        const paddedItemSize = (Math.floor((byteStride + 3) / 4) * 4) / bytesPerElement;
        const Ctor = src.constructor as new (n: number) => Float32Array;
        const startedAt = performance.now();
        const padded = new Ctor(bufferAttribute.count * paddedItemSize);
        padSpan(src, padded, itemSize, paddedItemSize, 0, bufferAttribute.count);
        const device = (utils.backend as unknown as {
          device: {
            createBuffer(desc: {
              label: string;
              size: number;
              usage: number;
              mappedAtCreation: boolean;
            }): { getMappedRange(): ArrayBuffer; unmap(): void };
          };
        }).device;
        const byteLength = padded.byteLength;
        const buffer = device.createBuffer({
          label: (bufferAttribute as unknown as { name?: string }).name ?? "",
          size: byteLength + ((4 - (byteLength % 4)) % 4),
          usage,
          mappedAtCreation: true
        });
        new (src.constructor as unknown as new (b: ArrayBuffer) => Float32Array)(
          buffer.getMappedRange()
        ).set(padded);
        buffer.unmap();
        bufferData.buffer = buffer as unknown as object;
        (bufferData as { _itemSize?: number })._itemSize = itemSize;
        (bufferData as { _paddedItemSize?: number })._paddedItemSize = paddedItemSize;
        bufferData._sfPaddedMirror = padded;
        tracer.count("paddedAttrCreate");
        tracer.count("paddedAttrMs", Math.round(performance.now() - startedAt));
        return;
      }
    }
    createOriginal(attribute, usage);
  };

  const original = utils.updateAttribute.bind(utils);
  utils.updateAttribute = (attribute: unknown) => {
    const bufferAttribute = utils._getBufferAttribute(attribute);
    const bufferData = utils.backend.get(bufferAttribute);
    const paddedItemSize = bufferData._paddedItemSize;
    const itemSize = bufferData._itemSize;
    const buffer = bufferData.buffer;
    if (
      buffer === undefined ||
      paddedItemSize === undefined ||
      itemSize === undefined ||
      // Storage attributes swap their array to the padded layout at create
      // time; the stock path handles them without the rebuild loop hazard.
      bufferAttribute.itemSize === paddedItemSize
    ) {
      original(attribute);
      return;
    }
    const src = bufferAttribute.array;
    const ranges = bufferAttribute.updateRanges;
    const paddedLength = bufferAttribute.count * paddedItemSize;
    const Ctor = src.constructor;
    let mirror = bufferData._sfPaddedMirror;

    const startedAt = performance.now();
    if (
      mirror === undefined ||
      mirror.length !== paddedLength ||
      (mirror as { constructor: unknown }).constructor !== Ctor
    ) {
      // First update (or the arena was resized): build the mirror once, upload
      // whole. Subsequent updates reuse it and only touch dirty spans.
      mirror = new Ctor(paddedLength);
      padSpan(src, mirror, itemSize, paddedItemSize, 0, bufferAttribute.count);
      bufferData._sfPaddedMirror = mirror;
      utils.backend.device.queue.writeBuffer(buffer, 0, mirror, 0);
      bufferAttribute.clearUpdateRanges();
      tracer.count("paddedAttrRebuild");
      tracer.count("paddedAttrMs", Math.round(performance.now() - startedAt));
      return;
    }

    if (ranges.length === 0) {
      // Range-less full update: re-pad in place (no allocation) + full upload.
      padSpan(src, mirror, itemSize, paddedItemSize, 0, bufferAttribute.count);
      utils.backend.device.queue.writeBuffer(buffer, 0, mirror, 0);
      tracer.count("paddedAttrFull");
      tracer.count("paddedAttrMs", Math.round(performance.now() - startedAt));
      return;
    }

    for (let r = 0; r < ranges.length; r++) {
      const range = ranges[r];
      // Ranges are expressed in SOURCE array elements (start/count), exactly
      // as the stock path interprets them.
      const vertexStart = Math.floor(range.start / itemSize);
      const vertexEnd = Math.min(
        bufferAttribute.count,
        Math.ceil((range.start + range.count) / itemSize)
      );
      if (vertexEnd <= vertexStart) continue;
      padSpan(src, mirror, itemSize, paddedItemSize, vertexStart, vertexEnd);
      const elementOffset = vertexStart * paddedItemSize;
      const elementCount = (vertexEnd - vertexStart) * paddedItemSize;
      // Byte offset/size are 4-byte aligned by construction: the padded stride
      // is a whole multiple of 4 bytes.
      utils.backend.device.queue.writeBuffer(
        buffer,
        elementOffset * src.BYTES_PER_ELEMENT,
        mirror,
        elementOffset,
        elementCount
      );
    }
    bufferAttribute.clearUpdateRanges();
    tracer.count("paddedAttrRanged");
    tracer.count("paddedAttrMs", Math.round(performance.now() - startedAt));
  };
}
