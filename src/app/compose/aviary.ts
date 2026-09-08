import type { MainCtx } from './ctx';
import { nearbyTreePerches, type TreePerch } from '../../world/vegetation/treePerches';
import type { BirdHabitat } from '../../world/aviary/catalog';

import { AVIARY_HABITATS } from '../../world/aviary/cityHabitats';
export { AVIARY_HABITATS } from '../../world/aviary/cityHabitats';

export function createWorldAviary(ctx: MainCtx) {
  let runtime: ReturnType<typeof import('../../world/aviary/runtime').createAviary> | null = null;
  let loading = false, disposed = false, retryAt = 0, settledAt = 0;
  let localId = '', perchCheckedAt = 0, treeId = '';
  const treeHabitats = new Map<string, TreePerch[]>();
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
            getPerches: habitat => treeHabitats.get(habitat.id) ?? [],
            prepareHabitat(habitat) {
              if (habitat.id.startsWith('tree-')) return habitat;
              if (habitat.id.startsWith('nearby-')) {
                // Find a compact volume over a street, courtyard or open land.
                // Large skyline habitats keep their own roof clearance below.
                let best = { x: habitat.center.x, z: habitat.center.z, floor: 0, score: Infinity };
                for (const dx of [-40, 0, 40]) for (const dz of [-40, 0, 40]) {
                  const x = habitat.center.x + dx, z = habitat.center.z + dz;
                  let ground = ctx.map.effectiveGround(x, z);
                  const span = habitat.radius * 1.25;
                  for (const [ox,oz] of [[-span,0],[span,0],[0,-span],[0,span]]) ground = Math.max(ground,ctx.map.effectiveGround(x+ox,z+oz));
                  const floor = Math.max(ground, ctx.physics.highestBuildingTop(x,z,habitat.radius*1.6));
                  const score = floor - ground + Math.abs(ground-ctx.player.position.y)*.3 + Math.hypot(dx,dz)*.06;
                  if(score < best.score) best = { x,z,floor,score };
                }
                return { ...habitat, center: { x: best.x, y: best.floor + (habitat.radius < 20 ? 7 : 12), z: best.z } };
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
          if (id) {
            const direction = ctx.camera.getWorldDirection(ctx.player.position.clone());
            // Three world-fixed encounter volumes surround the route, including
            // one in the forward view. They survive camera turns and overlap cells.
            for (let layer = 0; layer < 3; layer++) {
              const angle = Math.atan2(direction.z, direction.x) + (layer-1) * 1.15;
              const reach = [125,38,190][layer];
              const anchor = {x:x+Math.cos(angle)*reach,z:z+Math.sin(angle)*reach};
              const groupId = `${id}-${layer}`;
              if (localHabitats.has(groupId)) continue;
              localHabitats.set(groupId,anchor);
              const species = (Math.abs(cx+cz)+layer)%3;
              runtime.register({ id:groupId, species: species === 0 ? 'pearl-gull' : species === 1 ? 'ember-kestrel' : 'lagoon-jay', center: {x:anchor.x,y:ctx.player.position.y+12,z:anchor.z}, radius:layer === 1 ? 12 : 32,count:[20,16,24][layer],seed:Math.abs(cx*137+cz*71)+311+layer*43,loadDistance:480,unloadDistance:640 });
            }
          }
        }
      }
      if(runtime) for(const [id,center] of localHabitats) {
        if(!inWildlifeRange() || Math.hypot(ctx.player.position.x-center.x,ctx.player.position.z-center.z)>540) {
          runtime.unregister(id);localHabitats.delete(id);
        }
      }
      if (runtime && performance.now() - perchCheckedAt > 3500) {
        perchCheckedAt = performance.now();
        const existing = treeHabitats.get(treeId);
        if (existing && (!inWildlifeRange() || !existing.some(p=>p.active()) || Math.hypot(ctx.player.position.x-existing[0].x, ctx.player.position.z-existing[0].z) > 220)) {
          runtime.unregister(treeId); treeHabitats.delete(treeId); treeId = '';
        }
        if (!treeId && inWildlifeRange()) {
          const points = nearbyTreePerches(ctx.player.position.x, ctx.player.position.z, 145, 12);
          if (points.length) {
            const first = points[0];
            const cluster = points.filter(p=>Math.hypot(p.x-first.x,p.z-first.z)<48);
            treeId = `tree-${Math.round(first.x)}-${Math.round(first.z)}`;
            treeHabitats.set(treeId, cluster);
            runtime.register({id:treeId,species:'lagoon-jay',center:{x:first.x,y:Math.max(...cluster.map(p=>p.y))+8,z:first.z},radius:35,count:14,seed:713,loadDistance:260,unloadDistance:340});
          }
        }
      }
      influencer.radius = ctx.player.mode === 'plane' ? 15 : ctx.player.mode === 'drone' ? 8 : 4;
      runtime?.update(dt, ctx.state.elapsed, influencer);
    },
    get stats() { return runtime?.stats ?? { resident: [], species: [], draws: 0, textureBytes: 0 }; },
    debugPerches(id: string) { return runtime?.debugPerches(id); },
    async debugMotion(id: string) { return runtime?.debugMotion(id); },
    async debugRest(id: string) { return runtime?.debugRest(id); },
    async debugRead(id: string) { return runtime?.debugRead(id); },
    dispose,
  };
}
