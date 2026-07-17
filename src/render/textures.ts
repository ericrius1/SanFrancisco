import * as THREE from "three/webgpu";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

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

export async function getKtx2Loader(): Promise<import("three/examples/jsm/loaders/KTX2Loader.js").KTX2Loader | null> {
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

/**
 * Wire the shared lazy KTX2 loader into a GLTFLoader so GLBs using
 * KHR_texture_basisu (KTX2/Basis, built by tools/optimize-glb-textures.mjs) can
 * transcode their embedded textures on the GPU. AWAIT this before loadAsync/parse
 * so the KTX2 loader is present when GLTFLoader hits a basisu texture.
 *
 * Inert for GLBs without KHR_texture_basisu: plain PNG/JPEG GLBs load
 * identically whether or not a KTX2 loader is attached. If the renderer is not
 * yet ready (initTextures not called) or KTX2 is unavailable, this is a no-op and
 * the loader is returned unchanged — so it never blocks or breaks a load. The
 * transcoder chunk/WASM stays unfetched until the first basisu texture is parsed.
 */
export async function attachKtx2Loader(loader: GLTFLoader): Promise<GLTFLoader> {
  const ktx2 = await getKtx2Loader();
  if (ktx2) loader.setKTX2Loader(ktx2);
  return loader;
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
