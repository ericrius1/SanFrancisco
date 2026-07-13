import * as THREE from "three/webgpu";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";

// App-standard texture loader. Pre-authored image textures ship as GPU-native
// KTX2 (Basis/ETC1S, transcoded to BC1/BC7/ASTC/ETC on load — stays COMPRESSED in
// VRAM, ~4-8x less than the RGBA a PNG/WebP reinflates to) plus a WebP fallback
// for DOM <img> and browsers without KTX2. Build the pair with
// tools/optimize-textures.mjs. loadTexture() is stateless (no global cache) so
// lazy-loaded features can dispose their textures and actually free the VRAM.

let ktx2: KTX2Loader | null = null;
let ktx2Ready = false;
const basicLoader = new THREE.TextureLoader();

/** Wire the KTX2 transcoder once, after the renderer is initialized. */
export function initTextures(renderer: THREE.WebGPURenderer): void {
  try {
    ktx2 = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(renderer);
    ktx2.setWorkerLimit(2);
    ktx2Ready = true;
  } catch (err) {
    console.warn("[textures] KTX2 unavailable — falling back to WebP:", err);
    ktx2 = null;
    ktx2Ready = false;
  }
}

export function ktx2Available(): boolean {
  return ktx2Ready;
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
  if (ktx2Ready && ktx2) {
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
