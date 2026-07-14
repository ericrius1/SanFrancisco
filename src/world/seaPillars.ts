import * as THREE from "three/webgpu";
import { EXPOSURE_REBASE } from "../config";
import { waterHeight, type WorldMap } from "./heightmap";
import { OCEAN_BEACH_SURF, oceanBeachMask } from "./oceanBeachWaves";
import { hash2 } from "./groundcover/scatter";

/**
 * Scattered seabed pillars — stone spires / old pilings rising off the bay floor,
 * there purely to give you a sense of place underwater. Diving into open water is
 * disorienting because nothing is fixed; these are static world landmarks you can
 * gauge depth, distance and motion against.
 *
 * One InstancedMesh, grid-anchored: a pillar's existence and position are a pure
 * hash of its cell, so they never drift — as you swim, the field streams the
 * cells near you into the instance buffer (rebuilt only when you cross a cell,
 * so it's near-free per frame). Only placed over real water where the floor is
 * deep enough to matter, and hidden when you're well above the surface.
 */

const CELL = 30; // metres between candidate pillars
const RADIUS = 168; // how far out to populate around the player
const DENSITY = 0.5; // fraction of cells that grow a pillar
const MIN_FLOOR_DEPTH = 5; // seabed must be at least this far below the surface
const CAP = 220; // instance budget

const M = new THREE.Matrix4();
const Q = new THREE.Quaternion();
const POS = new THREE.Vector3();
const SCL = new THREE.Vector3();
const TILT_AXIS = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const COL = new THREE.Color();

export class SeaPillars {
  mesh: THREE.InstancedMesh;
  #map: WorldMap;
  #cellX = Infinity;
  #cellZ = Infinity;
  #time = 0;

  constructor(scene: THREE.Scene, map: WorldMap) {
    this.#map = map;

    // low-poly tapered spire (base at y=0, tip at y=1 after the unit-height shift)
    const geo = new THREE.CylinderGeometry(0.26, 1, 1, 7, 1);
    geo.translate(0, 0.5, 0); // pivot at the base so we can plant it on the floor

    const mat = new THREE.MeshStandardNodeMaterial({
      roughness: 0.92,
      metalness: 0,
      // faint self-glow so the spires stay legible in the murk without lighting cost
      emissive: new THREE.Color(0x0c2f30),
      emissiveIntensity: 0.45 * EXPOSURE_REBASE, // authored at the reference exposure (config.EXPOSURE_REBASE)
      flatShading: true
    });

    this.mesh = new THREE.InstancedMesh(geo, mat, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false; // we cull by cell ourselves
    this.mesh.renderOrder = -1; // draw before the transparent water sheet
    scene.add(this.mesh);
  }

  update(playerPos: THREE.Vector3, timeSec: number) {
    this.#time = timeSec;
    // pillars only matter around/under the water; skip the work when flying high
    const wy = waterHeight(playerPos.x, playerPos.z, timeSec);
    const near = playerPos.y < wy + 10;
    if (this.mesh.visible !== near) this.mesh.visible = near;
    if (!near) return;

    const cx = Math.round(playerPos.x / CELL);
    const cz = Math.round(playerPos.z / CELL);
    if (cx === this.#cellX && cz === this.#cellZ) return; // same cell → nothing to rebuild
    this.#cellX = cx;
    this.#cellZ = cz;
    this.#rebuild(playerPos);
  }

  #rebuild(playerPos: THREE.Vector3) {
    const map = this.#map;
    const span = Math.ceil(RADIUS / CELL);
    const cx = this.#cellX,
      cz = this.#cellZ;
    let n = 0;

    for (let dz = -span; dz <= span && n < CAP; dz++) {
      for (let dx = -span; dx <= span && n < CAP; dx++) {
        const ix = cx + dx,
          iz = cz + dz;
        if (hash2(ix, iz, 7001) >= DENSITY) continue; // this cell has no pillar

        // jittered position inside the cell (deterministic)
        const px = (ix + hash2(ix, iz, 11) - 0.5) * CELL;
        const pz = (iz + hash2(ix, iz, 23) - 0.5) * CELL;
        if (Math.hypot(px - playerPos.x, pz - playerPos.z) > RADIUS) continue;
        if (!map.isWater(px, pz)) continue;
        // Keep spires well clear of the Ocean Beach surf break. The tight surf
        // mask is not enough: tall pillars offshore of the strip (and just past
        // its along-beach ends) still jut up behind the translucent green wall
        // and read straight through it. Exclude a generous box around the whole
        // break, extended offshore where the seabed is deep and pillars are tall.
        if (oceanBeachMask(px, pz) > 0.05) continue;
        if (
          px > OCEAN_BEACH_SURF.minX - 900 &&
          px < OCEAN_BEACH_SURF.maxX + 250 &&
          pz > OCEAN_BEACH_SURF.minZ - 500 &&
          pz < OCEAN_BEACH_SURF.maxZ + 500
        ) {
          continue;
        }

        const floor = map.groundHeight(px, pz);
        const wy = waterHeight(px, pz, this.#time);
        const col = wy - floor; // water column above the floor here
        if (col < MIN_FLOOR_DEPTH) continue;

        // height rises off the floor toward (but not through) the surface
        const h = Math.min(70, col * (0.4 + hash2(ix, iz, 31) * 0.45));
        const r = 0.8 + hash2(ix, iz, 47) * 1.9; // base radius

        // slight lean so they don't look like a printed grid
        const lean = hash2(ix, iz, 53) * 0.16;
        const dir = hash2(ix, iz, 59) * Math.PI * 2;
        TILT_AXIS.set(Math.cos(dir), 0, Math.sin(dir));
        Q.setFromAxisAngle(TILT_AXIS, lean);
        // add a random spin about the trunk so the facets vary
        Q.multiply(_yaw(hash2(ix, iz, 67) * Math.PI * 2));

        POS.set(px, floor, pz);
        SCL.set(r, h, r);
        M.compose(POS, Q, SCL);
        this.mesh.setMatrixAt(n, M);

        // two-tone: kelp-green through rocky teal-grey
        COL.setHex(0x2f6b52).lerp(_grey, hash2(ix, iz, 71));
        this.mesh.setColorAt(n, COL);
        n++;
      }
    }

    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }
}

const _grey = new THREE.Color(0x3a5960);
const _q = new THREE.Quaternion();
function _yaw(a: number): THREE.Quaternion {
  return _q.setFromAxisAngle(UP, a);
}
