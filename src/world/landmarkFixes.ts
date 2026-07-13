import * as THREE from "three/webgpu";
import type { WorldMap } from "./heightmap";
import { enableLocalFarShadowLayers } from "./shadows/shadowLayers";

const COIT_BASE = 0xbdb5a4;

function groundMin(map: WorldMap, x: number, z: number, radius: number, n = 24): number {
  let g = map.groundHeight(x, z);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g = Math.min(g, map.groundHeight(x + radius * Math.cos(a), z + radius * Math.sin(a)));
  }
  return g;
}

/**
 * Runtime patches for baked landmark GLBs. Coit Tower's pedestal is keyed to the
 * hilltop heightmap sample; coarse terrain sags on the Telegraph Hill slopes and
 * leaves a visible gap under the base — a wide footing skirt fills it in.
 */
export function applyLandmarkFixes(root: THREE.Object3D, map: WorldMap) {
  // the crude baked Sutro Tower is superseded by the detailed runtime rig in
  // sutroTower.ts (createSutroTower); hide it so they do not z-fight.
  const sutro = root.getObjectByName("lm_sutro");
  if (sutro) sutro.visible = false;

  const coit = root.getObjectByName("lm_coit");
  if (!coit) return;

  const { x, z } = map.meta.landmarks.coit;
  const gPeak = map.groundHeight(x, z);
  const gRim = groundMin(map, x, z, 19);
  const bottom = gRim - 2.5;
  const top = gPeak + 4.5;
  const h = top - bottom;
  if (h < 0.5) return;

  const mat = new THREE.MeshStandardMaterial({
    color: COIT_BASE,
    roughness: 0.92,
    metalness: 0
  });
  const skirt = new THREE.Mesh(new THREE.CylinderGeometry(16.2, 19.8, h, 24), mat);
  skirt.name = "lm_coit_footing";
  skirt.position.set(x, bottom + h / 2, z);
  skirt.castShadow = true;
  enableLocalFarShadowLayers(skirt);
  skirt.receiveShadow = true;
  root.add(skirt);
}
