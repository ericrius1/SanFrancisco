import type { MainCtx } from './ctx';
import type { BirdHabitat } from '../../world/aviary/catalog';

/** SF owns placement only. Everything heavy stays behind this proximity gate. */
export const AVIARY_HABITATS: readonly BirdHabitat[] = [
  { id: 'lands-end-pearl', species: 'pearl-gull', center: { x: -5920, y: 62, z: 660 }, radius: 80, count: 48, seed: 17, loadDistance: 350, unloadDistance: 510 },
  { id: 'presidio-lagoon', species: 'lagoon-jay', center: { x: -2900, y: 95, z: -1550 }, radius: 62, count: 40, seed: 29, loadDistance: 310, unloadDistance: 460 },
  { id: 'corona-ember', species: 'ember-kestrel', center: { x: 408, y: 198, z: 2760 }, radius: 74, count: 32, seed: 43, loadDistance: 330, unloadDistance: 490 },
];
export function createWorldAviary(ctx: MainCtx) {
  let runtime: ReturnType<typeof import('../../world/aviary/runtime').createAviary> | null = null;
  let loading = false, disposed = false, retryAt = 0;
  const influencer = { position: ctx.player.renderPosition, velocity: ctx.player.velocity, radius: 4 };
  const distance = (h: BirdHabitat) => Math.hypot(ctx.player.position.x - h.center.x, ctx.player.position.y - h.center.y, ctx.player.position.z - h.center.z);
  const dispose = () => { disposed = true; runtime?.dispose(); runtime = null; };
  import.meta.hot?.dispose(dispose);
  return {
    update(dt: number) {
      if (disposed || ctx.worldArrival.active) return;
      const nearby = AVIARY_HABITATS.some(h => distance(h) < h.loadDistance);
      if (!runtime && !loading && nearby && performance.now() >= retryAt) {
        loading = true;
        void import('../../world/aviary/runtime').then(({ createAviary }) => {
          if (disposed || !AVIARY_HABITATS.some(h => distance(h) < h.loadDistance)) return;
          runtime = createAviary(ctx.renderer, ctx.scene);
          for (const habitat of AVIARY_HABITATS) {
            let floor = -Infinity;
            for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
              floor = Math.max(floor, ctx.map.groundTop(habitat.center.x + x * habitat.radius, habitat.center.z + z * habitat.radius));
            }
            runtime.register({ ...habitat, center: { ...habitat.center, y: Math.max(habitat.center.y, floor + 45) } });
          }
        }).catch(error => { retryAt = performance.now() + 10000; console.error('[aviary]', error); }).finally(() => { loading = false; });
      }
      influencer.radius = ctx.player.mode === 'plane' ? 15 : ctx.player.mode === 'drone' ? 8 : 4;
      runtime?.update(dt, ctx.state.elapsed, influencer);
    },
    get stats() { return runtime?.stats ?? { resident: [], species: [], draws: 0, textureBytes: 0 }; },
    dispose,
  };
}
