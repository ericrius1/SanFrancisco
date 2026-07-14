import * as THREE from "three/webgpu";

// App-standard texture loader. Pre-authored image textures ship as GPU-native
// KTX2 (Basis/ETC1S, transcoded to BC1/BC7/ASTC/ETC on load — stays COMPRESSED in
// VRAM, ~4-8x less than the RGBA a PNG/WebP reinflates to) plus a WebP fallback
// for DOM <img> and browsers without KTX2. Build the pair with
// tools/optimize-textures.mjs. loadTexture() is stateless (no global cache) so
// lazy-loaded features can dispose their textures and actually free the VRAM.

let ktx2Promise: Promise<import("three/examples/jsm/loaders/KTX2Loader.js").KTX2Loader | null> | null = null;
let ktx2Failed = false;
let warnedKtx2 = false;
const basicLoader = new THREE.TextureLoader();

/**
 * Remember the active renderer without importing the optional transcoder.
 * The KTX2 loader, worker, and WASM stay off the boot path until an activated
 * feature asks for its first authored texture.
 */
export function initTextures(nextRenderer: THREE.WebGPURenderer): void {
  // A renderer replacement is only expected during a full app restart. Drop
  // the old loader promise so capability detection belongs to the new device.
  if (nextRenderer !== activeRenderer) {
    ktx2Promise = null;
    ktx2Failed = false;
  }
  activeRenderer = nextRenderer;
}

export function ktx2Available(): boolean {
  return activeRenderer !== null && !ktx2Failed;
}

// Kept separate from the parameter name so initTextures remains a tiny,
// synchronous boot hook and does not accidentally capture the loader chunk.
let activeRenderer: THREE.WebGPURenderer | null = null;

async function getKtx2Loader(): Promise<import("three/examples/jsm/loaders/KTX2Loader.js").KTX2Loader | null> {
  const currentRenderer = activeRenderer;
  if (!currentRenderer || ktx2Failed) return null;
  if (!ktx2Promise) {
    ktx2Promise = import("three/examples/jsm/loaders/KTX2Loader.js")
      .then(({ KTX2Loader }) => {
        const loader = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(currentRenderer);
        loader.setWorkerLimit(2);
        return loader;
      })
      .catch((err: unknown) => {
        // Memoize terminal capability/import failure for this renderer. A
        // gallery requesting several textures should not retry the same failed
        // dynamic import and capability detection for every file.
        ktx2Failed = true;
        if (!warnedKtx2) {
          warnedKtx2 = true;
          console.warn("[textures] KTX2 unavailable — falling back to WebP:", err);
        }
        return null;
      });
  }
  return ktx2Promise;
}

export interface LoadTextureOpts {
  /** color map (default true) vs data map (normal/roughness). */
  srgb?: boolean;
  anisotropy?: number;
}

/**
 * Load `<name>.ktx2` (GPU-compressed) when supported, else `<name>.webp`.
 * `name` is a URL WITHOUT extension, e.g. "/francis/art/canticle-cover".
 * The caller owns disposal.
 */
export async function loadTexture(name: string, opts: LoadTextureOpts = {}): Promise<THREE.Texture> {
  const srgb = opts.srgb ?? true;
  let tex: THREE.Texture;
  const ktx2 = await getKtx2Loader();
  if (ktx2) {
    try {
      tex = await ktx2.loadAsync(`${name}.ktx2`);
    } catch {
      tex = await loadWebp(name);
    }
  } else {
    tex = await loadWebp(name);
  }
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = opts.anisotropy ?? 4;
  tex.needsUpdate = true;
  return tex;
}

async function loadWebp(name: string): Promise<THREE.Texture> {
  const tex = await basicLoader.loadAsync(`${name}.webp`);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}
