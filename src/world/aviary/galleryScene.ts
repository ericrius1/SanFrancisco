import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadBirdAsset, type BirdAsset } from './asset';
import { createBirdFlock, type BirdFlock } from './flock';
import type { BirdSpeciesId } from './catalog';
class AviaryRenderer extends THREE.Renderer {
  readonly isWebGPURenderer = true as const;
  constructor(parameters: THREE.WebGPURendererParameters = { antialias: true, alpha: true }) { super(new THREE.WebGPUBackend(parameters), { ...parameters, getFallback: null }); this.library = new THREE.StandardNodeLibrary(); }
}
export async function createGallery(host: HTMLElement) {
  if (!(navigator as Navigator & { gpu?: unknown }).gpu) throw new Error('WebGPU is required for the flight atelier.');
  const renderer: THREE.WebGPURenderer = new AviaryRenderer();
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor(new THREE.Color(0x0b191f), 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  host.append(renderer.domElement);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xb5dce3, 0x142126, 1.1));
  const key = new THREE.DirectionalLight(0xffeed7, 2); key.position.set(2, 4, 5); scene.add(key);
  const rim = new THREE.DirectionalLight(0x68acdc, 1.3); rim.position.set(-4, 2, -4); scene.add(rim);
  const camera = new THREE.PerspectiveCamera(34, 1, .05, 2000);
  camera.position.set(2, 2.8, 5.8);
  const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true; controls.minDistance = 1.4; controls.maxDistance = 300;
  const resize = () => { renderer.setSize(host.clientWidth, host.clientHeight); camera.aspect = host.clientWidth / host.clientHeight; camera.updateProjectionMatrix(); };
  const observer = new ResizeObserver(resize); observer.observe(host); resize();
  const assets = new Map<BirdSpeciesId, BirdAsset>();
  const flocks: BirdFlock[] = [];
  const influencer = { position: new THREE.Vector3(1e6, 0, 0), velocity: new THREE.Vector3(), radius: 0 };
  const plane = new THREE.Mesh(new THREE.ConeGeometry(.5, 3, 4), new THREE.MeshStandardNodeMaterial({ color: 0xe9d4a5, roughness: .45 }));
  plane.rotation.z = -Math.PI / 2; plane.visible = false; scene.add(plane);
  let last = performance.now(), time = 0, flyThrough = -1, disposed = false, generation = 0;
  let animation: 'Auto' | 'Fly' | 'Glide' | 'Scatter' = 'Auto';
  renderer.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(.05, (now - last) / 1000); last = now; time += dt;
    if (flyThrough >= 0) {
      flyThrough += dt; influencer.position.set(-45 + flyThrough * 25, 0, 0); influencer.velocity.set(25, 0, 0); influencer.radius = 9;
      plane.visible = true; plane.position.copy(influencer.position);
      if (flyThrough > 4.5) { flyThrough = -1; influencer.radius = 0; plane.visible = false; }
    }
    for (const flock of flocks) flock.update(dt, time, influencer);
    controls.update(); renderer.render(scene, camera);
  });
  const api = {
    async show(ids: BirdSpeciesId[], flockMode: boolean) {
      const token = ++generation;
      // Keep one view resident; selection releases the old GPU resources.
      for (const f of flocks.splice(0)) f.dispose();
      for (const [id, asset] of assets) if (!ids.includes(id)) { asset.dispose(); assets.delete(id); }
      const loaded: Array<[BirdSpeciesId, BirdAsset]> = [];
      for (const id of ids) {
        const asset = assets.get(id) ?? await loadBirdAsset(id, renderer);
        if (disposed || token !== generation) { if (assets.get(id) !== asset) asset.dispose(); return; }
        assets.set(id, asset); loaded.push([id, asset]);
      }
      loaded.forEach(([id, asset], i) => {
        const flock = createBirdFlock(renderer, asset, { id: `gallery-${id}`, species: id, center: { x: flockMode ? 0 : (i - (ids.length - 1) / 2) * 3.8, y: 0, z: 0 }, radius: 18, count: 48, seed: i + 3, loadDistance: 100, unloadDistance: 200 }, !flockMode);
        flock.setAnimation(animation); scene.add(flock.mesh); flocks.push(flock);
      });
      camera.position.set(flockMode ? 35 : ids.length > 1 ? .5 : .6, flockMode ? 24 : ids.length > 1 ? 5 : 2.6, flockMode ? 58 : ids.length > 1 ? 8 : 2.5);
      controls.target.set(0, 0, 0); controls.update();
    },
    scatter() { flyThrough = 0; },
    setAnimation(clip: typeof animation) { animation = clip; for (const f of flocks) f.setAnimation(clip); },
    async motion() { return Promise.all(flocks.map(f => f.debugMotion().then(a => Array.from(a)))); },
    async read() { return Promise.all(flocks.map(f => f.debugRead().then(a => Array.from(a)))); },
    get stats() { return { draws: flocks.length, assets: [...assets.keys()], info: renderer.info.render, allTexturesCompressed: [...assets.values()].every(a => !!(a.map as THREE.CompressedTexture)?.isCompressedTexture && !!(a.normalMap as THREE.CompressedTexture)?.isCompressedTexture), textureBytes: [...assets.values()].reduce((n, a) => n + a.textureBytes, 0), atlasBytes: [...assets.values()].reduce((n, a) => n + a.atlas.image.data!.byteLength, 0) }; },
    dispose() { disposed = true; generation++; renderer.setAnimationLoop(null); observer.disconnect(); controls.dispose(); for (const f of flocks) f.dispose(); for (const a of assets.values()) a.dispose(); plane.geometry.dispose(); plane.material.dispose(); renderer.dispose(); renderer.domElement.remove(); },
  };
  (window as Window & { __aviary?: typeof api }).__aviary = api;
  return api;
}
