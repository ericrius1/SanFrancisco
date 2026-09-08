import * as THREE from 'three/webgpu';
import { loadBirdAsset, type BirdAsset } from './asset';
import { createBirdFlock, type BirdFlock, type BirdInfluencer } from './flock';
import type { BirdHabitat, BirdSpeciesId, BirdPerch } from './catalog';

/** Copy this directory to another Three/WebGPU project. The host supplies
 * habitats and moving influencers; no SF map, player or global state is imported. */
export function createAviary(renderer: THREE.WebGPURenderer, scene: THREE.Scene, options: { assetBaseUrl?: string; transcoderPath?: string; prepareHabitat?: (habitat: BirdHabitat) => BirdHabitat; getPerches?: (habitat: BirdHabitat) => readonly BirdPerch[] } = {}) {
  const habitats = new Map<string, BirdHabitat>();
  const resident = new Map<string, BirdFlock>();
  const assets = new Map<BirdSpeciesId, { asset: BirdAsset; refs: number }>();
  const pending = new Map<string, Promise<void>>();
  const failedAt = new Map<string, number>();
  let selectionTime = 1;
  const selectionFocus = new THREE.Vector3(Infinity,Infinity,Infinity);
  let desired = new Set<string>(), disposed = false;
  let desiredSpecies = new Set<BirdSpeciesId>();
  // Serial admission avoids duplicate species loads and sudden shader/upload bursts.
  let admission: Promise<void> = Promise.resolve();
  function release(id: string) {
    const flock = resident.get(id); if (!flock) return;
    flock.dispose(); resident.delete(id);
    const h = habitats.get(id)!; const entry = assets.get(h.species)!;
    // A neighboring encounter can reuse the same decoded textures and bone
    // atlas while its cohort is admitted; crossing a cell must not reload it.
    if (--entry.refs === 0 && !desiredSpecies.has(h.species)) { entry.asset.dispose(); assets.delete(h.species); }
  }
  function ensure(h: BirdHabitat) {
    if (pending.has(h.id) || resident.has(h.id) || performance.now() - (failedAt.get(h.id) ?? -Infinity) < 10000) return;
    const promise = admission.then(async () => {
      if (disposed || !desired.has(h.id) || habitats.get(h.id) !== h) return;
      let entry = assets.get(h.species);
      if (!entry) {
        const asset = await loadBirdAsset(h.species, renderer, options.assetBaseUrl, options.transcoderPath);
        if (disposed || !desired.has(h.id) || habitats.get(h.id) !== h) { asset.dispose(); return; }
        entry = { asset, refs: 0 }; assets.set(h.species, entry);
      }
      try {
        const flock = createBirdFlock(renderer, entry.asset, options.prepareHabitat?.(h) ?? h);
        flock.setPerches(options.getPerches?.(h) ?? []);
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
      selectionTime += dt;
      if (selectionTime >= .5 || selectionFocus.distanceToSquared(influencer.position) > 6400) {
        selectionTime = 0; selectionFocus.copy(influencer.position);
        const nearby = [...habitats.values()].map(h => ({ h, d: Math.hypot(influencer.position.x - h.center.x, influencer.position.z - h.center.z,
          Math.max(0, Math.abs(influencer.position.y - (resident.get(h.id)?.mesh.position.y ?? h.center.y)) - 250)) }))
          .filter(({ h, d }) => d < (resident.has(h.id) ? h.unloadDistance : h.loadDistance))
          .sort((a, b) => (a.d - (resident.has(a.h.id) ? 90 : 0)) - (b.d - (resident.has(b.h.id) ? 90 : 0)));
        const candidates: typeof nearby = [], species = new Set<BirdSpeciesId>();
        // Reserve three skyline sectors so close encounters cannot consume
        // every slot. Distant flocks remain visible around the whole horizon.
        const skyline = new Map<number, (typeof nearby)[number]>();
        for (const c of nearby) {
          if (c.d < 850 || c.d > 1450) continue;
          const angle = Math.atan2(c.h.center.z-influencer.position.z, c.h.center.x-influencer.position.x);
          const sector = Math.min(2, Math.floor((angle+Math.PI)/(Math.PI*2)*3));
          const prior = skyline.get(sector);
          const score = (v: typeof c) => Math.abs(v.d-1150)-(resident.has(v.h.id)?100:0);
          if (!prior || score(c)<score(prior)) skyline.set(sector,c);
        }
        const ordered = [...nearby.slice(0,8), ...skyline.values(), ...nearby.slice(8)];
        const selected = new Set<string>();
        let birds = 0;
        for (const c of ordered) {
          if (selected.has(c.h.id)) continue;
          const count = Math.min(64, Math.floor(c.h.count));
          if (candidates.length >= 12 || birds + count > 320 || (!species.has(c.h.species) && species.size >= 3)) continue;
          candidates.push(c); selected.add(c.h.id); birds += count; species.add(c.h.species);
        }
        desired = new Set(candidates.map(c => c.h.id));
        desiredSpecies = species;
        for (const id of resident.keys()) if (!desired.has(id)) release(id);
        for (const [id, entry] of assets) if (!entry.refs && !desiredSpecies.has(id)) { entry.asset.dispose(); assets.delete(id); }
        for (const { h } of candidates) ensure(h);
      }
      for (const flock of resident.values()) flock.update(dt, time, influencer, flock.mesh.position.distanceTo(influencer.position));
    },
    get stats() { return { habitats: habitats.size, resident: [...resident.keys()], pending: [...pending.keys()], species: [...assets.keys()], draws: resident.size, triangles: [...resident.values()].reduce((n,f)=>n+(f.mesh.geometry.index?.count ?? 0)/3*f.mesh.count,0), birds: [...resident.keys()].reduce((n,id)=>n+Math.min(64,habitats.get(id)!.count),0), groups: [...resident].map(([id,f])=>({id,count:habitats.get(id)!.count,center:f.mesh.position.toArray(),triangles:(f.mesh.geometry.index?.count ?? 0)/3,drawn:f.mesh.count})), textureBytes: [...assets.values()].reduce((n, e) => n + e.asset.textureBytes, 0) }; },
    async settled() { await admission; },
    debugPerches(id: string) { return resident.get(id)?.debugPerches(); },
    async debugMotion(id: string) { return resident.get(id)?.debugMotion(); },
    async debugRest(id: string) { return resident.get(id)?.debugRest(); },
    async debugRead(id: string) { return resident.get(id)?.debugRead(); },
    dispose() { if (disposed) return; disposed = true; desired.clear(); desiredSpecies.clear(); for (const id of [...resident.keys()]) release(id); for (const entry of assets.values()) entry.asset.dispose(); assets.clear(); habitats.clear(); },
  };
}
