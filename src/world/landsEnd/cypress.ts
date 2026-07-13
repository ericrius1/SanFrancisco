// Wind-sculpted Monterey cypress for the Lands End headland — the flat-topped,
// ocean-bent silhouettes that frame the real place. A ring of them stands on
// the plateau around the labyrinth (clear of the stones), each bent inland by
// the prevailing sea wind. Cheap: shared materials, static, frozen with the
// region's foliage subtree.

import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { LABYRINTH } from "./layout";

const TRUNK_MAT = new THREE.MeshStandardNodeMaterial({ color: 0x5a4836, roughness: 0.9, flatShading: true });
const CANOPY_MAT = new THREE.MeshStandardNodeMaterial({ color: 0x5c7c4f, roughness: 0.95, flatShading: true });
const CANOPY_DARK = new THREE.MeshStandardNodeMaterial({ color: 0x45603b, roughness: 0.95, flatShading: true });

function hash(n: number): number {
  const s = Math.sin(n * 91.17 + 12.3) * 43758.5453;
  return s - Math.floor(s);
}

/** One wind-bent cypress. Trunk leans toward (leanX,leanZ); the crown is a
 *  domed, wind-sheared cluster shoved and splayed downwind, flat across the top. */
function makeCypress(seed: number, h: number, leanX: number, leanZ: number): THREE.Group {
  const g = new THREE.Group();
  const bend = 0.5 + hash(seed) * 0.5;

  // leaning trunk in two tapered segments (clearly reads as a trunk)
  const lower = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.26, h * 0.55, 6), TRUNK_MAT);
  lower.position.set(leanX * bend * 0.25, h * 0.275, leanZ * bend * 0.25);
  lower.rotation.set(leanZ * bend * 0.18, 0, -leanX * bend * 0.18);
  const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.15, h * 0.5, 6), TRUNK_MAT);
  upper.position.set(leanX * bend * 0.8, h * 0.72, leanZ * bend * 0.8);
  upper.rotation.set(leanZ * bend * 0.4, 0, -leanX * bend * 0.4);
  for (const t of [lower, upper]) {
    t.castShadow = true;
    g.add(t);
  }

  // crown: a domed cluster near the top, splayed downwind and sheared flat on
  // top — the signature Monterey-cypress "table" silhouette, but with volume
  const cx = leanX * bend * 1.5;
  const cz = leanZ * bend * 1.5;
  const cy = h * 0.98;
  const blobs = 6 + Math.floor(hash(seed + 3) * 4);
  for (let i = 0; i < blobs; i++) {
    const r = 0.85 + hash(seed + i * 7) * 0.9;
    const geo = new THREE.IcosahedronGeometry(r, 0);
    geo.scale(1.05, 0.82, 1.05); // gently flattened, not a pancake
    const blob = new THREE.Mesh(geo, i % 3 === 0 ? CANOPY_DARK : CANOPY_MAT);
    // bias the cluster downwind and spread it wider than it is tall
    const a = (i / blobs) * Math.PI * 2 + hash(seed + i) * 0.6;
    const spread = 0.7 + hash(seed + i * 3) * 1.6;
    blob.position.set(
      cx + Math.cos(a) * spread + leanX * 1.0,
      cy + hash(seed + i * 2) * 1.3 - Math.abs(Math.sin(a)) * 0.5,
      cz + Math.sin(a) * spread + leanZ * 1.0
    );
    blob.castShadow = true;
    g.add(blob);
  }
  return g;
}

/** A ring of cypress on the plateau around the labyrinth: grounded (so the
 *  trunks read), clear of the stones, all bent inland. Trees only take on land
 *  that sits high enough to be plateau, never down the sea cliff. */
export function buildCypressGrove(map: WorldMap): THREE.Group {
  const grove = new THREE.Group();
  grove.name = "landsEnd.cypress";
  const count = 14;
  for (let i = 0; i < count; i++) {
    const ang = (i / count) * Math.PI * 2 + hash(i) * 0.5;
    const rad = LABYRINTH.radius + 8 + hash(i + 20) * 16; // 20..36 m out
    const x = LABYRINTH.x + Math.cos(ang) * rad;
    const z = LABYRINTH.z + Math.sin(ang) * rad;
    const gy = map.groundTop(x, z);
    // stay on the plateau shelf — skip the sea cliff / water so nothing floats
    if (map.isWater(x, z) || gy < 55) continue;
    // lean inland: away from the ocean, which lies to the WNW (−x,−z)
    const outX = x - LABYRINTH.x;
    const outZ = z - LABYRINTH.z;
    const len = Math.hypot(outX, outZ) || 1;
    const leanX = 0.5 + (outX / len) * 0.3;
    const leanZ = 0.45 + (outZ / len) * 0.3;
    const h = 6.5 + hash(i + 3) * 4;
    const tree = makeCypress(i * 13.7, h, leanX, leanZ);
    tree.position.set(x, gy - 0.3, z);
    tree.rotation.y = hash(i + 100) * Math.PI * 2;
    tree.scale.setScalar(0.9 + hash(i + 5) * 0.5);
    grove.add(tree);
  }
  return grove;
}
