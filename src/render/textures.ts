import * as THREE from "three/webgpu";
import type { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

// App-standard texture loader. Pre-authored image textures ship as GPU-native
// KTX2 (Basis/ETC1S, transcoded to BC1/BC7/ASTC/ETC on load — stays COMPRESSED in
// VRAM, ~4-8x less than the RGBA a PNG/WebP reinflates to) plus a WebP fallback
// for DOM <img> and browsers without KTX2. Build the pair with
// tools/optimize-textures.mjs. loadTexture() is stateless (no global cache) so
// lazy-loaded features can dispose their textures and actually free the VRAM.

type Ktx2Loader = import("three/examples/jsm/loaders/KTX2Loader.js").KTX2Loader;
type DecoderService = {
  renderer: THREE.WebGPURenderer;
  promise: Promise<Ktx2Loader | null> | null;
  loader: Ktx2Loader | null;
  users: number;
  retired: boolean;
  failed: boolean;
};
let service: DecoderService | null = null;
const services = new Set<DecoderService>();
const basicLoader = new THREE.TextureLoader();
let warnedKtx2 = false;
const decodeWaiters: Array<() => void> = [];
let activeDecodes = 0;

function retireIfIdle(owner: DecoderService): void {
  if (!owner.retired || owner.users) return;
  owner.loader?.dispose();
  owner.loader = null;
  services.delete(owner);
}

/** Capability registration only: no decoder code or WASM enters boot here. */
export function initTextures(renderer: THREE.WebGPURenderer): void {
  if (service?.renderer === renderer) return;
  if (service) { service.retired = true; retireIfIdle(service); }
  service = { renderer, promise: null, loader: null, users: 0, retired: false, failed: false };
}
export function ktx2Available(): boolean { return !!service && !service.failed; }
export function textureDecoderStats() {
  return { active: activeDecodes, queued: decodeWaiters.length, limit: 2, services: services.size };
}

export async function getKtx2Loader(): Promise<Ktx2Loader | null> {
  const owner = service;
  if (!owner || owner.failed) return null;
  if (!owner.promise) {
    owner.promise = import("three/examples/jsm/loaders/KTX2Loader.js").then(({ KTX2Loader }) => {
      if (owner.retired) return null;
      const loader = new KTX2Loader().setTranscoderPath("/basis/").detectSupport(owner.renderer).setWorkerLimit(2);
      owner.loader = loader;
      services.add(owner);
      const rawLoad = loader.load.bind(loader);
      // GLTF's embedded Basis textures also enter through load(). Admission at
      // this shared boundary covers both authored GLBs and standalone foliage.
      loader.load = (url, onLoad, onProgress, onError) => {
        owner.users++;
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          owner.users--;
          const next = decodeWaiters.shift();
          if (next) queueMicrotask(next); else activeDecodes--;
          retireIfIdle(owner);
        };
        const fail = (error: unknown) => { finish(); onError?.(error); };
        const run = () => {
          if (owner.retired) { fail(new Error("Texture renderer was replaced")); return; }
          try {
            rawLoad(url, texture => {
              if (owner.retired) { texture.dispose(); fail(new Error("Texture renderer was replaced during decode")); return; }
              finish();
              onLoad?.(texture);
            }, onProgress, fail);
          } catch (error) { fail(error); }
        };
        if (activeDecodes >= 2) decodeWaiters.push(run);
        else { activeDecodes++; run(); }
        return undefined;
      };
      return loader;
    }).catch((error: unknown) => {
      owner.failed = true;
      if (!warnedKtx2) { warnedKtx2 = true; console.warn("[textures] KTX2 unavailable; using WebP:", error); }
      return null;
    });
  }
  return owner.promise;
}
export async function loadKtx2Texture(url: string): Promise<THREE.CompressedTexture> {
  const loader = await getKtx2Loader();
  if (!loader) throw new Error("KTX2 decoder is unavailable");
  return loader.loadAsync(url);
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
  /**
   * Asset published WITHOUT a KTX2 sibling — skip the compressed probe and go
   * straight to WebP.
   *
   * The KTX2 path below falls back on failure, so this is not about
   * correctness: it is about not firing a request that is known to 404. Set it
   * for anything whose builder ran `optimize-textures.mjs --webp-only` (which is
   * what happens when the KTX-Software `toktx` binary is unavailable at bake
   * time), so a browser-QA request waterfall stays free of dead entries.
   */
  webpOnly?: boolean;
}

/**
 * Load `<name>.ktx2` (GPU-compressed) when supported, else `<name>.webp`.
 * `name` is a URL WITHOUT extension, e.g. "/francis/art/canticle-cover".
 * The caller owns disposal.
 */
export async function loadTexture(name: string, opts: LoadTextureOpts = {}): Promise<THREE.Texture> {
  const owner = service;
  const srgb = opts.srgb ?? true;
  let tex: THREE.Texture;
  const ktx2 = opts.webpOnly ? null : await getKtx2Loader();
  if (ktx2) {
    try {
      tex = await ktx2.loadAsync(`${name}.ktx2`);
    } catch (error) {
      if (service !== owner) throw error;
      tex = await loadWebp(name);
    }
  } else {
    tex = await loadWebp(name);
  }
  if (service !== owner) { tex.dispose(); throw new Error("Texture renderer was replaced"); }
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
