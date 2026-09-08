import type { MainCtx } from './ctx';
import type { BirdHabitat } from '../../world/aviary/catalog';

import { AVIARY_HABITATS } from '../../world/aviary/cityHabitats';
export { AVIARY_HABITATS } from '../../world/aviary/cityHabitats';

export function createWorldAviary(ctx: MainCtx) {
  let runtime: ReturnType<typeof import('../../world/aviary/runtime').createAviary> | null = null;
  let loading = false, disposed = false, retryAt = 0, settledAt = 0;
  const influencer = { position: ctx.player.renderPosition, velocity: ctx.player.velocity, radius: 4 };
  const distance = (h: BirdHabitat) => Math.hypot(ctx.player.position.x - h.center.x, ctx.player.position.z - h.center.z);
  const dispose = () => { disposed = true; runtime?.dispose(); runtime = null; };
  import.meta.hot?.dispose(dispose);
  return {
    update(dt: number) {
      if (disposed || ctx.worldArrival.active || !ctx.state.revealed) return;
      if (!settledAt) settledAt = performance.now();
      // Give arrival essentials the first frames before admitting optional wildlife.
      if (performance.now() - settledAt < 5000) return;
      const nearby = AVIARY_HABITATS.some(h => distance(h) < h.loadDistance);
      if (!runtime && !loading && nearby && performance.now() >= retryAt) {
        loading = true;
        void import('../../world/aviary/runtime').then(({ createAviary }) => {
          if (disposed || !AVIARY_HABITATS.some(h => distance(h) < h.loadDistance)) return;
          runtime = createAviary(ctx.renderer, ctx.scene, {
            prepareHabitat(habitat) {
              let floor = ctx.physics.highestBuildingTop(habitat.center.x, habitat.center.z, habitat.radius * 1.5);
              for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
                floor = Math.max(floor, ctx.map.effectiveGround(habitat.center.x + x * habitat.radius * 1.35, habitat.center.z + z * habitat.radius * 1.35));
              }
              return { ...habitat, center: { ...habitat.center, y: Math.max(38, floor + 38) } };
            },
          });
          for (const habitat of AVIARY_HABITATS) runtime.register(habitat);
        }).catch(error => { retryAt = performance.now() + 10000; console.error('[aviary]', error); }).finally(() => { loading = false; });
      }
      influencer.radius = ctx.player.mode === 'plane' ? 15 : ctx.player.mode === 'drone' ? 8 : 4;
      runtime?.update(dt, ctx.state.elapsed, influencer);
    },
    get stats() { return runtime?.stats ?? { resident: [], species: [], draws: 0, textureBytes: 0 }; },
    async debugRead(id: string) { return runtime?.debugRead(id); },
    dispose,
  };
}
