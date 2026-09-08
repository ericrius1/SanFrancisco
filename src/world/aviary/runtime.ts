import * as THREE from 'three/webgpu';
import { loadBirdAsset, type BirdAsset } from './asset';
import { createBirdFlock, type BirdFlock, type BirdInfluencer } from './flock';
import type { BirdHabitat, BirdSpeciesId } from './catalog';

/** Copy this directory to another Three/WebGPU project. The host supplies
 * habitats and moving influencers; no SF map, player or global state is imported. */
export function createAviary(renderer: THREE.WebGPURenderer, scene: THREE.Scene, options: { assetBaseUrl?: string; transcoderPath?: string } = {}) {
  const habitats = new Map<string, BirdHabitat>();
  const resident = new Map<string, BirdFlock>();
  const assets = new Map<BirdSpeciesId, { asset: BirdAsset; refs: number }>();
  const pending = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  let desired = new Set<string>(), disposed = false;
  // Serial admission avoids duplicate species loads and sudden shader/upload bursts.
  let admission: Promise<void> = Promise.resolve();
  function release(id: string) {
    const flock = resident.get(id); if (!flock) return;
    flock.dispose(); resident.delete(id);
    const h = habitats.get(id)!; const entry = assets.get(h.species)!;
    if (--entry.refs === 0) { entry.asset.dispose(); assets.delete(h.species); }
  }
  function ensure(h: BirdHabitat) {
    if (pending.has(h.id) || resident.has(h.id) || performance.now() - (failedAt.get(h.id) ?? -Infinity) < 10000) return;
    const promise = admission.then(async () => {
      if (disposed || !desired.has(h.id)) return;
      let entry = assets.get(h.species);
      if (!entry) {
        const asset = await loadBirdAsset(h.species, renderer, options.assetBaseUrl, options.transcoderPath);
        if (disposed || !desired.has(h.id)) { asset.dispose(); return; }
        entry = { asset, refs: 0 }; assets.set(h.species, entry);
      }
      try {
        const flock = createBirdFlock(renderer, entry.asset, h);
        resident.set(h.id, flock); entry.refs++; scene.add(flock.mesh);
      } catch (error) {
        if (!entry.refs) { entry.asset.dispose(); assets.delete(h.species); }
        throw error;
      }
    }).catch(error => { failedAt.set(h.id, performance.now()); console.error('[aviary] habitat load failed', h.id, error); })
      .finally(() => pending.delete(h.id));
    pending.set(h.id, promise); admission = promise;
  }
  return {
    register(habitat: BirdHabitat) {
      if (habitats.has(habitat.id)) throw new Error(`[aviary] duplicate habitat ${habitat.id}`);
      if (!(habitat.radius > 0 && habitat.count > 0 && habitat.unloadDistance > habitat.loadDistance)) throw new Error('[aviary] invalid habitat bounds');
      habitats.set(habitat.id, habitat);
    },
    unregister(id: string) { desired.delete(id); release(id); habitats.delete(id); },
    update(dt: number, time: number, influencer: BirdInfluencer) {
      if (disposed) return;
      const candidates = [...habitats.values()].map(h => ({ h, d: Math.hypot(influencer.position.x - h.center.x, influencer.position.y - h.center.y, influencer.position.z - h.center.z) }))
        .filter(({ h, d }) => d < (resident.has(h.id) ? h.unloadDistance : h.loadDistance)).sort((a, b) => a.d - b.d).slice(0, 2);
      desired = new Set(candidates.map(c => c.h.id));
      for (const id of resident.keys()) if (!desired.has(id)) release(id);
      for (const { h, d } of candidates) { ensure(h); resident.get(h.id)?.update(dt, time, influencer, d); }
    },
    get stats() { return { habitats: habitats.size, resident: [...resident.keys()], pending: [...pending.keys()], species: [...assets.keys()], draws: resident.size, textureBytes: [...assets.values()].reduce((n, e) => n + e.asset.textureBytes, 0) }; },
    async settled() { await admission; },
    async debugRead(id: string) { return resident.get(id)?.debugRead(); },
    dispose() { if (disposed) return; disposed = true; desired.clear(); for (const id of [...resident.keys()]) release(id); habitats.clear(); },
  };
}
