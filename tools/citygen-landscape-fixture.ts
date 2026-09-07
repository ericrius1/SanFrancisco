// Headless visual fixture. Parent harness can call window.__landscapeFixture.set
// ({tier:'landscape'|'detail',view:'elevated'|'street'|'roof-back',night:boolean}).
// It deliberately does not boot gameplay, start an animation loop or fetch a city.
import * as THREE from 'three/webgpu';
import { appendPrism, emptyArrays, geometryFrom, lodMaterial } from '../src/world/citygen/render/lod';
import { buildBuilding } from '../src/world/citygen/render';
import { buildCityGenMaterials } from '../src/world/citygen/theme/materials';
import { WINDOW_GLOW_W } from '../src/world/facade';
import type { BuildingSpec } from '../src/world/citygen/core/types';

const host = window as typeof window & { __landscapeFixture?: unknown; __landscapeFixtureError?: string };
async function init() {
  if (!navigator.gpu) throw new Error('WebGPU is required for the landscape fixture');
  const renderer = new THREE.Renderer(new THREE.WebGPUBackend({ antialias: true }), { antialias: true, getFallback: null });
  renderer.library = new THREE.StandardNodeLibrary();
  await renderer.init();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(1);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  document.body.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xbfcbd7);
  const camera = new THREE.PerspectiveCamera(38, innerWidth / innerHeight, 0.2, 2000);
  const hemi = new THREE.HemisphereLight(0xc8defc, 0x69604c, 1.8);
  const sun = new THREE.DirectionalLight(0xffedd0, 3.0);
  sun.position.set(-40, 90, 50);
  scene.add(hemi, sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500), new THREE.MeshStandardNodeMaterial({color:0x8b9390,roughness:1}));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.06; scene.add(ground);
  const rectangle = (cx: number, w: number, d: number): BuildingSpec['poly'] => [[cx-w/2,-d/2],[cx+w/2,-d/2],[cx+w/2,d/2],[cx-w/2,d/2]];
  const specs: BuildingSpec[] = [
    {id:1,i:0,seed:17,archetype:'victorian',poly:rectangle(-32,12,16),base:0,top:13.6,streetEdge:2},
    {id:2,i:1,seed:91,archetype:'marina',poly:rectangle(-10,14,16),base:0,top:9.6,streetEdge:2},
    {id:3,i:2,seed:43,archetype:'downtown',poly:rectangle(23,28,24),base:0,top:37,streetEdge:2},
  ];
  const materials = buildCityGenMaterials();
  const detail = new THREE.Group(), landscape = new THREE.Group();
  const arrays = emptyArrays();
  let detailTriangles = 0;
  for (const spec of specs) {
    appendPrism(spec, arrays);
    const building = buildBuilding(spec, materials);
    building.setOpacity(1);
    building.group.traverse(o => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).castShadow = false; (o as THREE.Mesh).receiveShadow = false; } });
    detail.add(building.group);
    detailTriangles += building.triangles;
  }
  const merged = new THREE.Mesh(geometryFrom(arrays), lodMaterial());
  merged.name = 'fixture.landscape'; merged.castShadow = false; merged.receiveShadow = false;
  landscape.add(merged); scene.add(detail, landscape);
  let tier: 'landscape'|'detail' = 'landscape', view: 'elevated'|'street'|'roof-back' = 'elevated', night = false;
  const set = async (options: {tier?:typeof tier;view?:typeof view;night?:boolean} = {}) => {
    tier = options.tier ?? tier; view = options.view ?? view; night = options.night ?? night;
    landscape.visible = tier === 'landscape'; detail.visible = tier === 'detail';
    if (view === 'elevated') camera.position.set(74, 72, 122);
    else if (view === 'street') camera.position.set(61, 9, 129);
    else camera.position.set(-65, 65, -112);
    camera.lookAt(0, 15, 0); camera.updateMatrixWorld();
    sun.intensity = night ? 0.03 : 3;
    hemi.intensity = night ? 0.08 : 1.8;
    scene.background = new THREE.Color(night ? 0x111928 : 0xbfcbd7);
    WINDOW_GLOW_W.value = night ? 1 : 0;
    document.querySelector('#state')!.textContent = `${tier === 'landscape' ? 'Merged landscape' : 'Full generated detail'} · ${view} · ${night ? 'night' : 'day'} · ${(tier === 'landscape' ? arrays.idx.length/3 : detailTriangles).toLocaleString()} triangles`;
    await renderer.compileAsync(scene, camera);
    for(let i=0;i<4;i++) await renderer.renderAsync(scene,camera);
    return {tier,view,night,landscapeTriangles:arrays.idx.length/3,detailTriangles};
  };
  await set();
  host.__landscapeFixture = {set,renderer,scene,camera,landscapeTriangles:arrays.idx.length/3,detailTriangles};
}
init().catch(error => { host.__landscapeFixtureError = String(error?.stack ?? error); document.querySelector('#state')!.textContent = host.__landscapeFixtureError; console.error(error); });
