import type { MainCtx } from './ctx';
import type { BirdHabitat } from '../../world/aviary/catalog';

import { AVIARY_HABITATS } from '../../world/aviary/cityHabitats';
export { AVIARY_HABITATS } from '../../world/aviary/cityHabitats';

export function createWorldAviary(ctx: MainCtx) {
  let runtime: ReturnType<typeof import('../../world/aviary/runtime').createAviary> | null = null;
  let loading = false, disposed = false, retryAt = 0, settledAt = 0;
  let localId = '';
  const localHabitats = new Map<string, {x:number;z:number}>();
  const inWildlifeRange = () => ctx.player.position.x > -11000 && ctx.player.position.x < 6500 && ctx.player.position.z > -5500 && ctx.player.position.z < 6500 && ctx.player.position.y < 1500;
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
      const nearby = inWildlifeRange() || AVIARY_HABITATS.some(h => distance(h) < h.loadDistance);
      if (!runtime && !loading && nearby && performance.now() >= retryAt) {
        loading = true;
        void import('../../world/aviary/runtime').then(({ createAviary }) => {
          if (disposed || !(inWildlifeRange() || AVIARY_HABITATS.some(h => distance(h) < h.loadDistance))) return;
          runtime = createAviary(ctx.renderer, ctx.scene, {
            prepareHabitat(habitat) {
              if (habitat.id.startsWith('nearby-')) {
                // Find a compact volume over a street, courtyard or open land.
                // Large skyline habitats keep their own roof clearance below.
                let best = { x: habitat.center.x, z: habitat.center.z, floor: 0, score: Infinity };
                for (const dx of [-40, 0, 40]) for (const dz of [-40, 0, 40]) {
                  const x = habitat.center.x + dx, z = habitat.center.z + dz;
                  let ground = ctx.map.effectiveGround(x, z);
                  for (const [ox,oz] of [[-35,0],[35,0],[0,-35],[0,35]]) ground = Math.max(ground,ctx.map.effectiveGround(x+ox,z+oz));
                  const floor = Math.max(ground, ctx.physics.highestBuildingTop(x,z,38));
                  const score = floor - ground + Math.abs(ground-ctx.player.position.y)*.3 + Math.hypot(dx,dz)*.06;
                  if(score < best.score) best = { x,z,floor,score };
                }
                return { ...habitat, center: { x: best.x, y: best.floor + 9, z: best.z } };
              }
              let floor = ctx.physics.highestBuildingTop(habitat.center.x, habitat.center.z, habitat.radius * 1.5);
              for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) {
                floor = Math.max(floor, ctx.map.effectiveGround(habitat.center.x + x * habitat.radius * 1.35, habitat.center.z + z * habitat.radius * 1.35));
              }
              return { ...habitat, center: { ...habitat.center, y: Math.max(24, floor + 24) } };
            },
          });
          for (const habitat of AVIARY_HABITATS) runtime.register(habitat);
        }).catch(error => { retryAt = performance.now() + 10000; console.error('[aviary]', error); }).finally(() => { loading = false; });
      }
      if (runtime) {
        // Nearby encounters supplement the skyline flocks. Each anchor is
        // fixed in world space; it does not chase the camera or follow a plane.
        const x = ctx.player.position.x, z = ctx.player.position.z;
        const inCity = inWildlifeRange();
        const cx = Math.round(x / 160), cz = Math.round(z / 160);
        const id = inCity ? `nearby-${cx}-${cz}` : '';
        if (id !== localId) {
          localId = id;
          if (id && !localHabitats.has(id)) {
            const direction = ctx.camera.getWorldDirection(ctx.player.position.clone());
            const horizontal = Math.hypot(direction.x,direction.z) || 1;
            const anchor = {x:x+direction.x/horizontal*75,z:z+direction.z/horizontal*75};
            localHabitats.set(id,anchor);
            runtime.register({ id, species: Math.abs(cx+cz)%3 === 0 ? 'pearl-gull' : Math.abs(cx+cz)%3 === 1 ? 'ember-kestrel' : 'lagoon-jay', center: {x:anchor.x,y:ctx.player.position.y+9,z:anchor.z}, radius:26,count:12,seed:Math.abs(cx*137+cz*71)+311,loadDistance:300,unloadDistance:420 });
          }
        }
      }
      if(runtime) for(const [id,center] of localHabitats) {
        if(!inWildlifeRange() || Math.hypot(ctx.player.position.x-center.x,ctx.player.position.z-center.z)>300) {
          runtime.unregister(id);localHabitats.delete(id);
        }
      }
      influencer.radius = ctx.player.mode === 'plane' ? 15 : ctx.player.mode === 'drone' ? 8 : 4;
      runtime?.update(dt, ctx.state.elapsed, influencer);
    },
    get stats() { return runtime?.stats ?? { resident: [], species: [], draws: 0, textureBytes: 0 }; },
    async debugRead(id: string) { return runtime?.debugRead(id); },
    dispose,
  };
}
