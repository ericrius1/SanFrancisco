import * as THREE from "three/webgpu";
import { normalFlat } from "three/tsl";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { createTileMeshBatch, type TileBatchHandle } from "./tileBatch";
import { frontGate } from "../render/frontGate";

type Cell = { key: string; x: number; z: number; handle: TileBatchHandle };
/** One far-city batch owner, built from simplified authored tile geometry.
 * Three r185 shares its pipeline binding but emits visible-tile sub-draws. */
export class CitySkyline {
  #cells: Cell[] = [];
  #batch: ReturnType<typeof createTileMeshBatch>;
  #material = new THREE.MeshStandardNodeMaterial({ vertexColors: true, flatShading: true, roughness: 1 });
  visibleTiles = 0;
  private constructor(root: THREE.Object3D, manifest: {tile:number;minX:number;minZ:number}) {
    this.#material.normalNode = normalFlat;
    const meshes: THREE.Mesh[] = [];
    root.updateMatrixWorld(true);
    root.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const vertices = meshes.reduce((n,m)=>n+Math.ceil(m.geometry.getAttribute("position").count/128)*128,0);
    const indices = meshes.reduce((n,m)=>n+Math.ceil((m.geometry.index?.count ?? 1)/256)*256,0);
    // Detached while warming. The original source materials and geometry can
    // be released after copying into this fixed-size arena.
    this.#batch = createTileMeshBatch(new THREE.Group(), {
      name: "sf-city-skyline", material: this.#material, capacity: meshes.length,
      initialVertices: vertices, initialIndices: indices, maxVertices: vertices, maxIndices: indices,
      receiveShadow: false
    });
    const materials = new Set<THREE.Material>();
    for (const mesh of meshes) {
      const key = mesh.name.replace(/^bld_/, "");
      const [ix,iz] = key.split("_").map(Number);
      const handle = this.#batch.add(mesh.geometry, mesh.matrixWorld);
      if (!handle) throw new Error(`Skyline arena rejected ${key}`);
      this.#cells.push({key, x:manifest.minX+(ix+0.5)*manifest.tile, z:manifest.minZ+(iz+0.5)*manifest.tile,handle});
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(m);
      mesh.geometry.dispose();
    }
    for (const m of materials) m.dispose();
  }
  static async load(manifest: {tile:number;minX:number;minZ:number}, prepare: (root:THREE.Object3D)=>Promise<void>) {
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync("/skyline/city.glb");
    const skyline = new CitySkyline(gltf.scene, manifest);
    try { await prepare(skyline.mesh); return skyline; }
    catch (error) { skyline.dispose(); throw error; }
  }
  get mesh() { return this.#batch.mesh; }
  update(x:number,z:number,drawRadius:number,detailReady:(key:string)=>boolean):void {
    this.visibleTiles = 0;
    for (const cell of this.#cells) {
      const visible = Math.hypot(cell.x-x,cell.z-z) <= drawRadius+566 &&
        !detailReady(cell.key) && !frontGate.shouldHide(cell.x,cell.z,566);
      cell.handle.setVisible(visible);
      if (visible) this.visibleTiles++;
    }
  }
  dispose():void { this.#batch.dispose(); this.#material.dispose(); }
  stats() { return {...this.#batch.stats(),visibleTiles:this.visibleTiles}; }
}
