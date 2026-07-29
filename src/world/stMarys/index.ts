import * as THREE from "three/webgpu";
import { batchStaticSiblings } from "../staticBatch";

const CENTER_X = 1642.02;
const CENTER_Z = 661.16;
const FLOOR_Y = 64.6;
const YAW = 0.152;
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

// The four window lines carry the four elements — matched to the baked glass:
// +x east = gold air, +y north = green earth, -x west = red fire,
// -y south = blue water — meeting in a prismatic cross at the apex.
const ELEMENTS = [
  { dir: [1, 0] as const, color: 0xffc247 },
  { dir: [0, 1] as const, color: 0x46c26a },
  { dir: [-1, 0] as const, color: 0xff5a35 },
  { dir: [0, -1] as const, color: 0x3878ff }
];
const APEX_COLD = 0xcfc8ff;
const APEX_WARM = 0xffd98a;

type BeamMaterial = THREE.MeshBasicNodeMaterial & { userData: { baseOpacity?: number } };

export interface StMarysRuntime {
  readonly group: THREE.Group;
  update(playerPosition: THREE.Vector3, elapsed: number): void;
  dispose(): void;
}

function localToWorld(lx: number, ly: number, lz: number, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(YAW);
  const s = Math.sin(YAW);
  return out.set(
    CENTER_X + lx * c - ly * s,
    FLOOR_Y + lz,
    CENTER_Z - lx * s - ly * c
  );
}

function worldToLocal(position: THREE.Vector3): { x: number; y: number } {
  const dx = position.x - CENTER_X;
  const dz = position.z - CENTER_Z;
  const c = Math.cos(YAW);
  const s = Math.sin(YAW);
  return { x: c * dx - s * dz, y: -s * dx - c * dz };
}

function makeSoftDiscTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 62);
  gradient.addColorStop(0, "rgba(255,255,255,.82)");
  gradient.addColorStop(0.38, "rgba(255,255,255,.38)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "St Marys soft colored-light pool";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

function makeAdditiveMaterial(color: number, opacity: number, map?: THREE.Texture): BeamMaterial {
  const material = new THREE.MeshBasicNodeMaterial() as BeamMaterial;
  material.color.setHex(color);
  material.transparent = true;
  material.opacity = opacity;
  material.depthWrite = false;
  material.depthTest = true;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.toneMapped = false;
  if (map) material.map = map;
  material.userData.baseOpacity = opacity;
  return material;
}

function addBeam(
  group: THREE.Group,
  materials: Set<BeamMaterial>,
  start: THREE.Vector3,
  end: THREE.Vector3,
  color: number,
  nearRadius: number,
  farRadius: number,
  opacity: number
): void {
  const direction = end.clone().sub(start);
  const length = direction.length();
  const geometry = new THREE.CylinderGeometry(farRadius, nearRadius, length, 8, 1, true);
  geometry.name = "St Marys tapered light volume";
  const material = makeAdditiveMaterial(color, opacity);
  materials.add(material);
  const beam = new THREE.Mesh(geometry, material);
  beam.name = "St Marys dalle-de-verre light stream";
  beam.position.copy(start).add(end).multiplyScalar(0.5);
  beam.quaternion.setFromUnitVectors(LOCAL_Y, direction.normalize());
  beam.renderOrder = 4;
  beam.frustumCulled = true;
  group.add(beam);
}

/**
 * Interior-only dalle-de-verre atmosphere for the cathedral. The authored GLB
 * carries the physical glass; this disposable layer adds the four elemental
 * window-line god rays, the prismatic apex column falling through Lippold's
 * baldacchino onto the altar, soft floor pools, and one dust-mote draw.
 */
export function createStMarysRuntime(scene: THREE.Scene): StMarysRuntime {
  const group = new THREE.Group();
  group.name = "st_marys_dalle_de_verre_atmosphere";
  group.visible = false;
  scene.add(group);

  const materials = new Set<BeamMaterial>();
  const poolTexture = makeSoftDiscTexture();
  const poolGeometry = new THREE.PlaneGeometry(7.4, 4.4);
  poolGeometry.name = "St Marys colored floor pool";

  // Each element band: two beam heights slanting from the window line down
  // across the nave, splayed slightly so the fans interleave at the centre.
  for (const { dir, color } of ELEMENTS) {
    const [dx, dy] = dir;
    for (const [t, splay] of [[0.62, 3.4], [0.42, -2.8]] as const) {
      // seam profile of the shell: x = 20.6 - 12.4 * t^1.55, z = 15 + 44.4t
      const seamR = 20.6 - 12.4 * Math.pow(t, 1.55) - 0.5;
      const seamZ = 15 + 44.4 * t;
      const start = localToWorld(dx * seamR - dy * 0, dy * seamR + dx * 0, seamZ);
      const landR = -8.5 - 4.5 * t;
      const target = localToWorld(dx * landR - dy * splay, dy * landR + dx * splay, 0.4);
      addBeam(group, materials, start, target, color, 0.34, 1.5, 0.012);
      addBeam(group, materials, start, target, color, 0.15, 0.7, 0.024);

      const poolMaterial = makeAdditiveMaterial(color, 0.1, poolTexture);
      materials.add(poolMaterial);
      const pool = new THREE.Mesh(poolGeometry, poolMaterial);
      pool.name = "St Marys stained-glass floor pool";
      pool.position.copy(target);
      pool.position.y = FLOOR_Y + 1.56;
      pool.rotation.x = -Math.PI / 2;
      pool.rotation.z = YAW + Math.atan2(dy, dx) + (splay > 0 ? 0.24 : -0.24);
      pool.renderOrder = 5;
      group.add(pool);
    }
  }

  // The prismatic apex column: light from the ridge-skylight cross falling
  // straight down through the baldacchino's gold veil onto the altar.
  const apexStart = localToWorld(0, 0, 55.5);
  const altar = localToWorld(0, 0, 2.0);
  addBeam(group, materials, apexStart, altar, APEX_COLD, 0.5, 2.6, 0.013);
  addBeam(group, materials, apexStart, altar, APEX_WARM, 0.22, 1.1, 0.02);
  const altarPoolMaterial = makeAdditiveMaterial(APEX_WARM, 0.15, poolTexture);
  materials.add(altarPoolMaterial);
  const altarPool = new THREE.Mesh(new THREE.PlaneGeometry(11, 11), altarPoolMaterial);
  altarPool.name = "St Marys sanctuary light pool";
  localToWorld(0, 0, 2.06, altarPool.position);
  altarPool.rotation.x = -Math.PI / 2;
  altarPool.renderOrder = 5;
  group.add(altarPool);

  // Dust motes drifting inside the cupola volume, tinted by the four elements.
  const DUST = 220;
  const dustPositions = new Float32Array(DUST * 3);
  const dustColors = new Float32Array(DUST * 3);
  const color = new THREE.Color();
  for (let index = 0; index < DUST; index++) {
    const angle = (index * 2.399963) % (Math.PI * 2);
    const radius = 2 + ((index * 53) % 150) / 10;
    const lx = Math.cos(angle) * radius;
    const ly = Math.sin(angle) * radius;
    const lz = 2.5 + ((index * 47) % 300) / 10;
    localToWorld(lx, ly, lz, new THREE.Vector3()).toArray(dustPositions, index * 3);
    color.setHex(ELEMENTS[index % ELEMENTS.length].color);
    color.multiplyScalar(0.5 + (index % 5) * 0.08).toArray(dustColors, index * 3);
  }
  const dustGeometry = new THREE.BufferGeometry();
  dustGeometry.setAttribute("position", new THREE.BufferAttribute(dustPositions, 3));
  dustGeometry.setAttribute("color", new THREE.BufferAttribute(dustColors, 3));
  dustGeometry.computeBoundingSphere();
  const dustMaterial = new THREE.PointsNodeMaterial();
  dustMaterial.size = 0.055;
  dustMaterial.sizeAttenuation = true;
  dustMaterial.vertexColors = true;
  dustMaterial.transparent = true;
  dustMaterial.opacity = 0.42;
  dustMaterial.depthWrite = false;
  dustMaterial.blending = THREE.AdditiveBlending;
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.name = "St Marys elemental dust motes";
  dust.renderOrder = 5;
  group.add(dust);

  // Shared static-merge pass — see graceCathedral/index.ts for why this is
  // currently a no-op that future inert decoration folds into automatically.
  batchStaticSiblings(group, {
    keepKey: "keepStMarysMesh",
    siblingFallbackName: "st_marys_static",
    landmarkPass: false
  });

  return {
    group,
    update(playerPosition, elapsed) {
      const local = worldToLocal(playerPosition);
      const visible =
        Math.abs(local.x) < 42 && Math.abs(local.y) < 42 &&
        playerPosition.y > FLOOR_Y - 3 && playerPosition.y < FLOOR_Y + 62;
      // Assigned every frame (not edge-triggered) so a warmHiddenRoot restore
      // that raced this flag heals on the next frame.
      group.visible = visible;
      if (!visible) return;
      const breath = 0.92 + Math.sin(elapsed * 0.34) * 0.055 + Math.sin(elapsed * 0.09) * 0.025;
      for (const material of materials) {
        material.opacity = (material.userData.baseOpacity ?? material.opacity) * breath;
      }
      dust.rotation.y = Math.sin(elapsed * 0.03) * 0.014;
      dust.position.y = Math.sin(elapsed * 0.16) * 0.09;
    },
    dispose() {
      group.removeFromParent();
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.geometry) return;
        // Shared pool geometry is deliberately disposed once below.
        if (mesh.geometry !== poolGeometry) mesh.geometry.dispose();
      });
      poolGeometry.dispose();
      poolTexture.dispose();
      for (const material of materials) material.dispose();
      dustGeometry.dispose();
      dustMaterial.dispose();
      group.clear();
    }
  };
}
