import type * as THREE from "three/webgpu";
import { optionalRenderer } from "../app/rendererRegistry";

export type TextureRegion = Readonly<{ x: number; y: number; width: number; height: number }>;

/** Three r185's WebGPU updater ignores Texture.updateRanges. Keep its native
 * texture access in this one version-pinned boundary; writeTexture supports
 * unaligned row pitches (unlike copyBufferToTexture's 256-byte rule).
 * Queue ordering publishes all strips before the next vegetation dispatch.
 */
export function uploadFloatTextureRegions(texture: THREE.DataTexture, regions: readonly TextureRegion[]): number {
  const data = texture.image.data as Float32Array;
  const renderer = optionalRenderer();
  if (!renderer?.hasInitialized()) {
    // CPU authoring/tests have no device. The first GPU consumer initializes
    // the complete texture; never pretend these are partial GPU uploads.
    texture.needsUpdate = true;
    return data.byteLength;
  }
  const backend = renderer.backend as unknown as {
    device: { queue: { writeTexture(
      destination: { texture: object; origin: { x: number; y: number } },
      data: Float32Array<ArrayBuffer>,
      layout: { offset: number; bytesPerRow: number },
      size: { width: number; height: number }
    ): void } };
    get(texture: THREE.Texture): { texture?: object };
  };
  let gpu = backend.get(texture).texture;
  if (!gpu) {
    texture.needsUpdate = true;
    renderer.initTexture(texture);
    return data.byteLength;
  }
  const rowBytes = texture.image.width * 4 * Float32Array.BYTES_PER_ELEMENT;
  let bytes = 0;
  for (const region of regions) {
    backend.device.queue.writeTexture(
      { texture: gpu, origin: { x: region.x, y: region.y } },
      data as Float32Array<ArrayBuffer>,
      { offset: region.y * rowBytes + region.x * 16, bytesPerRow: rowBytes },
      { width: region.width, height: region.height }
    );
    bytes += region.width * region.height * 16;
  }
  return bytes;
}
