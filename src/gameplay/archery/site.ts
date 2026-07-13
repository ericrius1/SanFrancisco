import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { buildBow } from "../../player/held";
import { enableLocalShadowLayer } from "../../world/shadows/shadowLayers";
import {
  ARCHERY_DIR,
  ARCHERY_LAT,
  ARCHERY_YAW,
  LANE_COUNT,
  LANE_DISTANCES,
  LANE_SPACING,
  laneLineXZ,
  laneTargetXZ,
  laneV,
  SHOOTING_LINE
} from "./layout";

/**
 * The archery field's static props: five straw butts on wooden A-frame easels
 * with painted ring faces, a shooting-line rail + per-lane ground strips, a
 * bow rack with display bows, a wooden sign and a couple of hay bales.
 *
 * Everything is baked in WORLD space and merged into ONE mesh per material
 * (~11 draws for the whole site), so the site gate hides a handful of
 * objects, not a prop forest. Each prop conforms to map.groundTop at its own
 * footprint — no terrain flattening.
 */

export type ArcheryTarget = {
  lane: number;
  /** face centre, world space */
  center: THREE.Vector3;
  /** unit normal pointing back toward the shooting line (slightly up — the
   *  butt leans back on its easel) */
  normal: THREE.Vector3;
  /** outer scoring radius (the white ring's edge) */
  radius: number;
  /** downrange distance from the shooting line, for HUD readouts */
  distance: number;
};

export const TARGET_RADIUS = 0.62;
export const TARGET_TILT = 0.2; // lean-back radians on the easel
const TARGET_FACE_HEIGHT = 1.18; // face centre above ground
/** Scoring ring outer radii (gold→white), even fifths of the face. */
export const RING_RADII = [0.124, 0.248, 0.372, 0.496, 0.62] as const;
export const RING_SCORES = [10, 8, 6, 4, 2] as const;
/** Ring accent colors — shared with the HUD pips. */
export const RING_COLORS = [0xf5c542, 0xe0472e, 0x2e6fd8, 0x23262b, 0xeeeae0] as const;

// one shared material set for the whole site — merged buckets key off these
const MAT = {
  straw: new THREE.MeshLambertMaterial({ color: 0xcbb26a }),
  strawDark: new THREE.MeshLambertMaterial({ color: 0xa89051 }),
  wood: new THREE.MeshLambertMaterial({ color: 0x6b4a2f }),
  woodLight: new THREE.MeshLambertMaterial({ color: 0x8a6b45 }),
  line: new THREE.MeshLambertMaterial({ color: 0xe8e4da }),
  gold: new THREE.MeshLambertMaterial({ color: RING_COLORS[0] }),
  red: new THREE.MeshLambertMaterial({ color: RING_COLORS[1] }),
  blue: new THREE.MeshLambertMaterial({ color: RING_COLORS[2] }),
  black: new THREE.MeshLambertMaterial({ color: RING_COLORS[3] }),
  white: new THREE.MeshLambertMaterial({ color: RING_COLORS[4] })
};
const RING_MATS = [MAT.gold, MAT.red, MAT.blue, MAT.black, MAT.white];

/** Materials whose merged mesh is silhouette-scale and should shadow-cast. */
const CASTING = new Set<THREE.Material>([MAT.straw, MAT.wood, MAT.woodLight]);

type Ground = { groundTop(x: number, z: number): number };

// build-time scratch (this module runs once at site construction)
const M = new THREE.Matrix4();
const E = new THREE.Euler();
const V = new THREE.Vector3();
const Q = new THREE.Quaternion();
const UNIT = new THREE.Vector3(1, 1, 1);
const Y_UP = new THREE.Vector3(0, 1, 0);
const Z_FWD = new THREE.Vector3(0, 0, 1);

export function buildArcherySite(map: Ground): {
  group: THREE.Group;
  targets: ArcheryTarget[];
  rackXZ: { x: number; z: number };
} {
  const group = new THREE.Group();
  group.name = "archery-site";
  const buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const targets: ArcheryTarget[] = [];

  const put = (mat: THREE.Material, geo: THREE.BufferGeometry, pos: THREE.Vector3, quat: THREE.Quaternion) => {
    geo.applyMatrix4(M.compose(pos, quat, UNIT));
    let list = buckets.get(mat);
    if (!list) buckets.set(mat, (list = []));
    list.push(geo);
  };
  const putE = (mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, ex = 0, ey = 0, ez = 0) =>
    put(mat, geo, V.set(x, y, z), Q.setFromEuler(E.set(ex, ey, ez)));
  /** Bake an already-built prop group (display bows) into the buckets. */
  const putGroup = (root: THREE.Object3D) => {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      const mat = mesh.material as THREE.Material;
      let list = buckets.get(mat);
      if (!list) buckets.set(mat, (list = []));
      list.push(geo);
    });
  };

  const dirX = ARCHERY_DIR.x;
  const dirZ = ARCHERY_DIR.z;
  // props whose long (local X) axis should run laterally across the range
  const latYaw = ARCHERY_YAW;

  // ---- target butts + easels -------------------------------------------------
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const t = laneTargetXZ(lane);
    const gy = map.groundTop(t.x, t.z);
    const center = new THREE.Vector3(t.x, gy + TARGET_FACE_HEIGHT, t.z);
    // face normal: back toward the shooter, tipped up by the easel lean
    const normal = new THREE.Vector3(
      -dirX * Math.cos(TARGET_TILT),
      Math.sin(TARGET_TILT),
      -dirZ * Math.cos(TARGET_TILT)
    );
    const buttQ = new THREE.Quaternion().setFromUnitVectors(Y_UP, normal);
    put(MAT.straw, new THREE.CylinderGeometry(TARGET_RADIUS + 0.05, TARGET_RADIUS + 0.05, 0.26, 18), center, buttQ);
    // darker straw band reads as the coiled rim
    put(MAT.strawDark, new THREE.CylinderGeometry(TARGET_RADIUS + 0.07, TARGET_RADIUS + 0.07, 0.1, 18, 1, true), center, buttQ);

    // ring face: flat discs just proud of the straw, innermost highest (tiny
    // normal offsets — never coplanar, so no z-fight at grazing angles)
    const faceBase = center.clone().addScaledVector(normal, 0.135);
    const faceQ = new THREE.Quaternion().setFromUnitVectors(Z_FWD, normal);
    for (let ring = 0; ring < RING_RADII.length; ring++) {
      const geo =
        ring === 0
          ? new THREE.CircleGeometry(RING_RADII[0], 24)
          : new THREE.RingGeometry(RING_RADII[ring - 1], RING_RADII[ring], 28);
      put(RING_MATS[ring], geo, V.copy(faceBase).addScaledVector(normal, (RING_RADII.length - ring) * 0.004), faceQ);
    }

    // A-frame easel: two splayed side legs + a rear prop + a low cross beam
    const legLen = 1.9;
    for (const side of [-1, 1]) {
      const lx = t.x + ARCHERY_LAT.x * side * 0.55;
      const lz = t.z + ARCHERY_LAT.z * side * 0.55;
      const ly = map.groundTop(lx, lz);
      // splay laterally toward an apex above the butt, lean back with the tilt
      put(
        MAT.wood,
        new THREE.BoxGeometry(0.09, legLen, 0.09),
        V.set(lx - dirX * 0.05, ly + legLen / 2 - 0.05, lz - dirZ * 0.05),
        Q.setFromEuler(E.set(-TARGET_TILT * 0.4, latYaw, side * 0.26, "YXZ"))
      );
    }
    const px = t.x + dirX * 0.62;
    const pz = t.z + dirZ * 0.62;
    put(
      MAT.wood,
      new THREE.BoxGeometry(0.08, 2.0, 0.08),
      V.set(px, map.groundTop(px, pz) + 0.95, pz),
      Q.setFromEuler(E.set(TARGET_TILT * 1.7, latYaw, 0, "YXZ"))
    );
    putE(MAT.woodLight, new THREE.BoxGeometry(1.5, 0.08, 0.08), t.x, gy + 0.55, t.z, 0, latYaw, 0);

    targets.push({ lane, center: faceBase, normal, radius: TARGET_RADIUS, distance: LANE_DISTANCES[lane] });
  }

  // ---- shooting line: bright ground strip per lane + a low rail behind --------
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const l = laneLineXZ(lane);
    const ly = map.groundTop(l.x, l.z);
    putE(MAT.line, new THREE.BoxGeometry(3.2, 0.03, 0.24), l.x, ly + 0.015, l.z, 0, latYaw, 0);
    putE(MAT.wood, new THREE.BoxGeometry(0.07, 0.85, 0.07), l.x - dirX * 1.4, ly + 0.42, l.z - dirZ * 1.4);
    putE(MAT.woodLight, new THREE.BoxGeometry(3.9, 0.06, 0.06), l.x - dirX * 1.4, ly + 0.82, l.z - dirZ * 1.4, 0, latYaw, 0);
  }

  // ---- bow rack (behind the line, between lanes 0 and 1) -----------------------
  const rackV = laneV(0) + LANE_SPACING / 2;
  const rackXZ = {
    x: SHOOTING_LINE.x + ARCHERY_LAT.x * rackV - dirX * 5,
    z: SHOOTING_LINE.z + ARCHERY_LAT.z * rackV - dirZ * 5
  };
  const rackY = map.groundTop(rackXZ.x, rackXZ.z);
  for (const side of [-1, 1]) {
    putE(
      MAT.wood,
      new THREE.BoxGeometry(0.09, 1.5, 0.09),
      rackXZ.x + ARCHERY_LAT.x * side * 0.9,
      rackY + 0.75,
      rackXZ.z + ARCHERY_LAT.z * side * 0.9
    );
  }
  putE(MAT.woodLight, new THREE.BoxGeometry(2.0, 0.07, 0.07), rackXZ.x, rackY + 1.42, rackXZ.z, 0, latYaw, 0);
  putE(MAT.woodLight, new THREE.BoxGeometry(2.0, 0.07, 0.07), rackXZ.x, rackY + 0.35, rackXZ.z, 0, latYaw, 0);
  // display bows leaning on the rack (buildBow shares held.ts materials; the
  // whole trio merges into ~3 extra buckets, not 18 draws)
  for (const [i, lean] of [-0.55, 0.05, 0.6].entries()) {
    const bow = buildBow();
    bow.position.set(rackXZ.x + ARCHERY_LAT.x * lean, rackY + 0.72, rackXZ.z + ARCHERY_LAT.z * lean);
    bow.rotation.set(0.14, ARCHERY_YAW + (i - 1) * 0.12, 0.08 * (i - 1));
    putGroup(bow);
  }

  // ---- sign + hay bales (range-front furniture) --------------------------------
  const signV = laneV(LANE_COUNT - 1) + 4;
  const sx = SHOOTING_LINE.x + ARCHERY_LAT.x * signV - dirX * 6;
  const sz = SHOOTING_LINE.z + ARCHERY_LAT.z * signV - dirZ * 6;
  const signY = map.groundTop(sx, sz);
  putE(MAT.wood, new THREE.BoxGeometry(0.1, 2.1, 0.1), sx, signY + 1.05, sz);
  putE(MAT.woodLight, new THREE.BoxGeometry(1.7, 0.62, 0.07), sx, signY + 1.85, sz, 0, latYaw, 0);
  // a small target-face roundel on the board says "archery" without text
  const roundelN = new THREE.Vector3(-dirX, 0, -dirZ);
  const roundelQ = new THREE.Quaternion().setFromUnitVectors(Z_FWD, roundelN);
  const roundelMats = [MAT.gold, MAT.red, MAT.blue];
  for (let ring = 0; ring < 3; ring++) {
    const geo = ring === 0 ? new THREE.CircleGeometry(0.08, 16) : new THREE.RingGeometry(0.08 * ring, 0.08 * (ring + 1), 20);
    put(roundelMats[ring], geo, V.set(sx, signY + 1.85, sz).addScaledVector(roundelN, 0.045 + (3 - ring) * 0.004), roundelQ);
  }
  for (const [hv, hu, yaw] of [
    [laneV(0) - 4.5, -4, 0.4],
    [laneV(0) - 5.2, -6.5, -0.7],
    [laneV(LANE_COUNT - 1) + 4.2, -7.5, 1.1]
  ] as const) {
    const hx = SHOOTING_LINE.x + ARCHERY_LAT.x * hv + dirX * hu;
    const hz = SHOOTING_LINE.z + ARCHERY_LAT.z * hv + dirZ * hu;
    putE(MAT.straw, new THREE.BoxGeometry(1.15, 0.55, 0.62), hx, map.groundTop(hx, hz) + 0.27, hz, 0, yaw, 0);
  }

  // ---- merge: one mesh per material --------------------------------------------
  for (const [mat, geos] of buckets) {
    const merged = mergeGeometries(geos, false);
    if (!merged) continue;
    for (const g of geos) g.dispose();
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = CASTING.has(mat);
    if (mesh.castShadow) enableLocalShadowLayer(mesh);
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return { group, targets, rackXZ };
}
