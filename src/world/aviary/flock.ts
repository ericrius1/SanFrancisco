import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, attribute, cameraViewMatrix, cos, cross, dot, float, fract,
  instanceIndex, instancedArray, length, mat4, mix, normalize, normalLocal,
  positionLocal, positionView, uv, sin, smoothstep, texture, uint, uniform, varying, vec2, vec3, vec4,
} from 'three/tsl';
import { BIRD_SPECIES, type BirdPerch, type BirdHabitat } from './catalog';
import { CLIP_FRAMES, CLIP_ROWS, CLIPS, type BirdAsset } from './asset';
// TSL's expression types cannot describe dynamically assembled skin matrices.
type N = any;
export interface BirdInfluencer { position: THREE.Vector3; velocity: THREE.Vector3; radius: number; }
export interface BirdFlock {
  mesh: THREE.Mesh;
  setPerches(perches: readonly BirdPerch[]): void;
  debugRest(): Promise<Float32Array>;
  debugPerches(): { targets: number[]; active: boolean[] };
  update(dt: number, time: number, influencer: BirdInfluencer, distance?: number): void;
  setAnimation(clip: 'Auto' | 'Fly' | 'Glide' | 'Scatter' | 'Perch'): void;
  debugRead(): Promise<Float32Array>;
  debugMotion(): Promise<Float32Array>;
  dispose(): void;
}
const MAX_PATCH_BIRDS = 64;
/** Local boids, bounded to one habitat. Double-buffered simulation prevents
 * invocation-order races. The only CPU uploads are time and the moving obstacle. */
export function createBirdFlock(renderer: THREE.WebGPURenderer, asset: BirdAsset, habitat: BirdHabitat, portrait = false): BirdFlock {
  const count = portrait ? 1 : Math.max(1, Math.min(MAX_PATCH_BIRDS, Math.floor(habitat.count)));
  const spec = BIRD_SPECIES.find(s => s.id === habitat.species)!;
  const center = new THREE.Vector3(habitat.center.x, habitat.center.y, habitat.center.z);
  const pos = new Float32Array(count * 4), vel = new Float32Array(count * 4);
  let seed = habitat.seed >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < count; i++) {
    const a = random() * Math.PI * 2, r = habitat.radius * (.2 + random() * .45);
    pos.set([Math.cos(a) * r, (random() - .5) * Math.min(12, habitat.radius * .45), Math.sin(a) * r, random() * 10], i * 4);
    vel.set([-Math.sin(a) * spec.speed, 0, Math.cos(a) * spec.speed, 0], i * 4);
  }
  const positions = instancedArray(pos, 'vec4'), velocities = instancedArray(vel, 'vec4');
  const nextPositions = instancedArray(count, 'vec4'), nextVelocities = instancedArray(count, 'vec4');
  const perchData = new Float32Array(count * 4);
  const perchTargets = instancedArray(perchData, 'vec4');
  const resting = instancedArray(count, 'float'), nextResting = instancedArray(count, 'float');
  let assignedPerches: readonly BirdPerch[] = [];
  const step = uniform(1 / 30), clock = uniform(0);
  const obstacle = uniform(new THREE.Vector3(1e6, 1e6, 1e6));
  const obstacleVelocity = uniform(new THREE.Vector3());
  const obstacleRadius = uniform(0);
  const simulation = portrait ? Fn(() => {
    const p = positions.element(instanceIndex);
    nextPositions.element(instanceIndex).assign(vec4(0, 0, 0, p.w.add(step)));
    nextVelocities.element(instanceIndex).assign(vec4(0, 0, 1, 0));
  })().compute(count) : Fn(() => {
    const p: N = positions.element(instanceIndex).toVar();
    const v: N = velocities.element(instanceIndex).toVar();
    const separation = vec3(0).toVar(), alignment = vec3(0).toVar(), cohesion = vec3(0).toVar();
    const neighbors = float(0).toVar();
    Loop({ start: uint(0), end: uint(count), type: 'uint', condition: '<' }, ({ i }) => {
      If(i.notEqual(instanceIndex), () => {
        const other = positions.element(i).xyz;
        const delta = p.xyz.sub(other).toVar(); const d2 = dot(delta, delta).max(.02);
        If(d2.lessThan(625), () => {
          alignment.addAssign(velocities.element(i).xyz);
          cohesion.addAssign(other); neighbors.addAssign(1);
          If(d2.lessThan(25), () => { separation.addAssign(delta.div(d2)); });
        });
      });
    });
    const force = separation.mul(15).toVar();
    If(neighbors.greaterThan(0), () => {
      force.addAssign(alignment.div(neighbors).sub(v.xyz).mul(.55));
      force.addAssign(cohesion.div(neighbors).sub(p.xyz).mul(.12));
    });
    // A soft habitat boundary and circling flow; no teleport/wrap at the edge.
    const radial = vec3(p.x, 0, p.z);
    force.addAssign(radial.negate().mul(smoothstep(habitat.radius * .5, habitat.radius, length(radial))).mul(.45));
    force.addAssign(vec3(p.z.negate(), 0, p.x).mul(.025));
    force.y.addAssign(p.y.negate().mul(.45).add(sin(clock.mul(.65).add(float(instanceIndex))).mul(.65)));
    // Avoid a swept capsule ahead of the plane, rather than reacting after contact.
    const sweep = obstacleVelocity.mul(.9);
    const relative = p.xyz.sub(obstacle);
    const along = dot(relative, sweep).div(dot(sweep, sweep).max(.001)).clamp(0, 1);
    const away = relative.sub(sweep.mul(along)).toVar();
    const dist = length(away);
    const alarm: N = float(1).sub(smoothstep(obstacleRadius.add(3), obstacleRadius.add(28), dist)).mul(float(obstacleRadius.greaterThan(0)));
    force.addAssign(away.add(vec3(.01, .3, .01)).div(dist.max(1)).mul(alarm).mul(55));
    const fear: N = mix(v.w, alarm.max(v.w.sub(step.mul(.38))), step.mul(7).min(1));
    const forceLength = length(force).max(.001);
    const accelerated: N = v.xyz.add(force.div(forceLength).mul(forceLength.min(38)).mul(step));
    const speed = length(accelerated).clamp(spec.speed * .72, float(spec.speed).mul(float(1).add(fear.mul(.7))));
    const velocity: N = normalize(accelerated.add(vec3(.00001, 0, 0))).mul(speed);
    const target = perchTargets.element(instanceIndex);
    const rest = resting.element(instanceIndex);
    const wantsRest = target.w.greaterThan(.5).and(fear.lessThan(.15)).and(sin(p.w.mul(.075).add(float(instanceIndex).mul(1.8))).greaterThan(-.15));
    const resultVelocity = velocity.toVar(), resultPosition = p.xyz.add(velocity.mul(step)).toVar();
    nextResting.element(instanceIndex).assign(rest.sub(step.mul(2)).max(0));
    If(wantsRest, () => {
      const delta = target.xyz.sub(p.xyz), distance = length(delta);
      // A braking approach converges on the actual branch surface. A few
      // individuals rest while the rest of the cohort continues flying.
      const approach = delta.mul(1.6).div(distance.max(1)).mul(distance.min(spec.speed));
      resultVelocity.assign(mix(v.xyz, approach, step.mul(4).min(1)));
      resultPosition.assign(p.xyz.add(resultVelocity.mul(step)));
      If(distance.lessThan(.65).or(rest.greaterThan(.05)), () => {
        resultPosition.assign(target.xyz);
        resultVelocity.assign(vec3(cos(float(instanceIndex).mul(2.4)), 0, sin(float(instanceIndex).mul(2.4))).mul(.001));
        nextResting.element(instanceIndex).assign(rest.add(step.mul(2)).min(1));
      });
    });
    If(wantsRest.not().and(rest.greaterThan(.05)), () => {
      resultVelocity.assign(normalize(vec3(v.x, .65, v.z).add(vec3(.3, 0, .2))).mul(spec.speed));
      resultPosition.assign(p.xyz.add(resultVelocity.mul(step)));
    });
    nextVelocities.element(instanceIndex).assign(vec4(resultVelocity, fear));
    nextPositions.element(instanceIndex).assign(vec4(resultPosition, p.w.add(step)));
  })().compute(count);
  const commit = Fn(() => {
    positions.element(instanceIndex).assign(nextPositions.element(instanceIndex));
    velocities.element(instanceIndex).assign(nextVelocities.element(instanceIndex));
    resting.element(instanceIndex).assign(nextResting.element(instanceIndex));
  })().compute(count);
  const material = new THREE.MeshStandardNodeMaterial({ map: asset.map, vertexColors: !!asset.geometry.getAttribute("color"), roughness: .64, metalness: 0 });
  const state: N = positions.element(instanceIndex);
  const motion: N = velocities.element(instanceIndex);
  const forward: N = normalize(motion.xyz.add(vec3(0, 0, .0001)));
  const right: N = normalize(cross(vec3(0, 1, 0), forward));
  const up: N = normalize(cross(forward, right));
  const bank = portrait ? float(0) : sin(state.w.mul(.7).add(float(instanceIndex))).mul(.12).add(
    dot(right, state.xyz.negate()).mul(.006).clamp(-.48, .48)).mul(float(1).sub(resting.element(instanceIndex)));
  const bankRight = right.mul(cos(bank)).add(up.mul(sin(bank)));
  const bankUp = up.mul(cos(bank)).sub(right.mul(sin(bank)));
  const orient = (p: N) => bankRight.mul(p.x).add(bankUp.mul(p.y)).add(forward.mul(p.z));
  const visibilityScale = uniform(1);
  const forcedGlide = uniform(-1), forcedScatter = uniform(-1), forcedRest = uniform(0);
  const fear: N = mix(motion.w, forcedScatter, float(forcedScatter.greaterThanEqual(0)));
  const automaticGlide: N = smoothstep(.25, .65, sin(state.w.mul(.6).add(float(instanceIndex).mul(1.7)))).mul(float(1).sub(motion.w));
  const glide: N = mix(automaticGlide, forcedGlide, float(forcedGlide.greaterThanEqual(0)));
  const joints: N = attribute('skinIndex', 'uvec4'), weights: N = attribute('skinWeight', 'vec4');
  const boneMatrix = (joint: N, clip: number): N => {
    const frame = fract(state.w.div(asset.durations[clip])).mul(CLIP_FRAMES);
    const y = frame.add(clip * CLIP_ROWS + .5).div(CLIP_ROWS * CLIPS.length);
    const cols = [0, 1, 2, 3].map(k => texture(asset.atlas, vec2(float(joint).mul(4).add(k + .5).div(asset.boneCount * 4), y)).level(float(0)));
    return mat4(cols[0], cols[1], cols[2], cols[3]);
  };
  const skinMatrix = Fn(() => {
    const result = mat4(vec4(0), vec4(0), vec4(0), vec4(0)).toVar();
    for (let j = 0; j < asset.influences; j++) {
      const joint = joints.element(j);
      const fly = boneMatrix(joint, 0), sail = boneMatrix(joint, 1), scatter = boneMatrix(joint, 2);
      const matrix = fly.mul(float(1).sub(glide)).add(sail.mul(glide));
      const flight = matrix.mul(float(1).sub(fear)).add(scatter.mul(fear));
      const rest = resting.element(instanceIndex).max(forcedRest);
      result.addAssign(flight.mul(float(1).sub(rest)).add(boneMatrix(joint, 3).mul(rest)).mul(weights.element(j)));
    }
    return result;
  });
  material.positionNode = Fn(() => {
    const p = skinMatrix().mul(vec4(positionLocal, 1)).xyz;
    return orient(p).mul(portrait ? float(1) : visibilityScale.mul(spec.scale)).add(state.xyz);
  })();
  const surfaceNormal = varying(Fn(() => {
    const n = skinMatrix().mul(vec4(normalLocal, 0)).xyz;
    return cameraViewMatrix.mul(vec4(orient(n), 0)).xyz.normalize();
  })());
  material.normalNode = asset.normalMap ? Fn(() => {
    const n: N = surfaceNormal.normalize();
    const q0: N = positionView.dFdx(), q1: N = positionView.dFdy();
    const st0: N = uv().dFdx(), st1: N = uv().dFdy();
    const t: N = cross(q1, n).mul(st0.x).add(cross(n, q0).mul(st1.x));
    const b: N = cross(q1, n).mul(st0.y).add(cross(n, q0).mul(st1.y));
    const scale: N = dot(t, t).max(dot(b, b)).max(.0000001).sqrt().reciprocal();
    const sampled: N = texture(asset.normalMap!).xyz.mul(2).sub(1);
    return t.mul(sampled.x).add(b.mul(sampled.y)).mul(scale).mul(.65).add(n.mul(sampled.z)).normalize();
  })() : surfaceNormal;
  // Mesh.count uses storage-driven instancing without allocating CPU matrices.
  const mesh = new THREE.Mesh(portrait ? asset.geometry : asset.lods[2], material);
  mesh.count = count; mesh.name = `aviary:${habitat.id}`; mesh.position.copy(center); mesh.frustumCulled = false;
  let accumulated = 0, disposed = false;
  return {
    mesh,
    setPerches(perches) {
      assignedPerches = perches.slice(0, Math.min(6, Math.floor(count * .4)));
      perchData.fill(0);
      assignedPerches.forEach((p,i) => perchData.set([p.x-center.x, p.y-center.y+.18, p.z-center.z, p.active()?1:0], i*4));
      perchTargets.value.needsUpdate = true;
    },
    debugPerches() { return {targets:Array.from(perchData),active:assignedPerches.map(p=>p.active())}; },
    async debugRest() { return new Float32Array(await renderer.getArrayBufferAsync(resting.value)); },
    update(dt, time, influencer, distance = 0) {
      if (disposed) return;
      const period = distance > 550 ? 1 / 10 : distance > 190 ? 1 / 15 : 1 / 30;
      // Keep the entire flock at range. Geometry, not population, is the LOD.
      const lod = portrait || distance < 95 ? 0 : distance < 320 ? 1 : 2;
      mesh.geometry = asset.lods[lod];
      mesh.count = count;
      visibilityScale.value = 1 + THREE.MathUtils.smoothstep(distance, 150, 1100) * .65;
      for (let i = 0; i < assignedPerches.length; i++) {
        const active = assignedPerches[i].active() ? 1 : 0;
        if (perchData[i * 4 + 3] !== active) { perchData[i * 4 + 3] = active; perchTargets.value.needsUpdate = true; }
      }
      accumulated += Math.min(Math.max(dt, 0), .1);
      clock.value = time;
      obstacle.value.copy(influencer.position).sub(center); obstacleVelocity.value.copy(influencer.velocity);
      obstacleRadius.value = influencer.radius;
      // Bound catch-up work after a suspended tab or loading hitch.
      for (let steps = 0; accumulated >= period && steps < 3; steps++) {
        step.value = period; renderer.compute(simulation); renderer.compute(commit); accumulated -= period;
      }
      accumulated = Math.min(accumulated, period);
    },
    setAnimation(clip) {
      forcedRest.value = clip === 'Perch' ? 1 : 0;
      forcedGlide.value = clip === 'Auto' ? -1 : clip === 'Glide' ? 1 : 0;
      forcedScatter.value = clip === 'Auto' ? -1 : clip === 'Scatter' ? 1 : 0;
    },
    async debugMotion() { return new Float32Array(await renderer.getArrayBufferAsync(velocities.value)); },
    async debugRead() { return new Float32Array(await renderer.getArrayBufferAsync(positions.value)); },
    dispose() {
      if (disposed) return; disposed = true; mesh.removeFromParent(); material.dispose();
      for (const buffer of [positions, velocities, nextPositions, nextVelocities, perchTargets, resting, nextResting]) buffer.value.dispose();
      simulation.dispose(); commit.dispose();
    },
  };
}
