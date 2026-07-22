import * as THREE from "three/webgpu";

const CENTER_X = 2687.5;
const CENTER_Z = -205.2;
const FLOOR_Y = 94.0;
const YAW = 0.153;
const LOCAL_Y = new THREE.Vector3(0, 1, 0);

const GLASS_COLORS = [0x3878ff, 0x8d47ff, 0xff5a35, 0xffc247] as const;

type BeamMaterial = THREE.MeshBasicNodeMaterial & { userData: { baseOpacity?: number } };

export interface GraceCathedralRuntime {
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
  texture.name = "Grace Cathedral soft colored-light pool";
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
  geometry.name = "Grace Cathedral tapered light volume";
  const material = makeAdditiveMaterial(color, opacity);
  materials.add(material);
  const beam = new THREE.Mesh(geometry, material);
  beam.name = "Grace Cathedral stained-glass light stream";
  beam.position.copy(start).add(end).multiplyScalar(0.5);
  beam.quaternion.setFromUnitVectors(LOCAL_Y, direction.normalize());
  beam.renderOrder = 4;
  beam.frustumCulled = true;
  group.add(beam);
}

/**
 * Efficient interior-only stained-glass atmosphere. The authored GLB carries
 * the physical glass and normal maps; this disposable layer adds just sixteen
 * tapered additive meshes, eight soft floor pools, and one dust-mote draw.
 */
export function createGraceCathedralRuntime(scene: THREE.Scene): GraceCathedralRuntime {
  const group = new THREE.Group();
  group.name = "grace_cathedral_colored_light_atmosphere";
  group.visible = false;
  scene.add(group);

  const materials = new Set<BeamMaterial>();
  const poolTexture = makeSoftDiscTexture();
  const poolGeometry = new THREE.PlaneGeometry(6.8, 3.4);
  poolGeometry.name = "Grace Cathedral colored floor pool";

  const sourceXs = [34, 22, 10, -2];
  for (const side of [-1, 1] as const) {
    sourceXs.forEach((x, index) => {
      const color = GLASS_COLORS[(index + (side > 0 ? 1 : 0)) % GLASS_COLORS.length];
      const start = localToWorld(x, side * 6.25, 20.2);
      const target = localToWorld(x - 5.8, -side * (2.0 + index * 0.42), 0.35);
      addBeam(group, materials, start, target, color, 0.42, 2.0, 0.034);
      addBeam(group, materials, start, target, color, 0.18, 0.92, 0.065);

      const poolMaterial = makeAdditiveMaterial(color, 0.18, poolTexture);
      materials.add(poolMaterial);
      const pool = new THREE.Mesh(poolGeometry, poolMaterial);
      pool.name = "Grace Cathedral stained-glass floor reflection";
      pool.position.copy(target);
      pool.rotation.x = -Math.PI / 2;
      pool.rotation.z = YAW + (side > 0 ? 0.22 : -0.22);
      pool.renderOrder = 5;
      group.add(pool);
    });
  }

  // Morning light through the great east rose travels the length of the nave.
  const roseStart = localToWorld(48.4, 0, 29.0);
  const roseTarget = localToWorld(17.5, 0, 1.2);
  addBeam(group, materials, roseStart, roseTarget, 0xffb43b, 0.8, 3.9, 0.025);
  addBeam(group, materials, roseStart, roseTarget, 0x427dff, 0.35, 1.85, 0.047);

  const dustPositions = new Float32Array(180 * 3);
  const dustColors = new Float32Array(180 * 3);
  const color = new THREE.Color();
  for (let index = 0; index < 180; index++) {
    const lx = -12 + ((index * 37) % 580) / 10;
    const ly = -5.6 + ((index * 71) % 112) / 10;
    const lz = 2.5 + ((index * 47) % 220) / 10;
    localToWorld(lx, ly, lz, new THREE.Vector3()).toArray(dustPositions, index * 3);
    color.setHex(GLASS_COLORS[index % GLASS_COLORS.length]);
    color.multiplyScalar(0.52 + (index % 5) * 0.08).toArray(dustColors, index * 3);
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
  dust.name = "Grace Cathedral colored dust motes";
  dust.renderOrder = 5;
  group.add(dust);

  let visible = false;
  return {
    group,
    update(playerPosition, elapsed) {
      const local = worldToLocal(playerPosition);
      const nextVisible =
        local.x > -55 && local.x < 57 && Math.abs(local.y) < 18 &&
        playerPosition.y > FLOOR_Y - 3 && playerPosition.y < FLOOR_Y + 38;
      if (nextVisible !== visible) {
        visible = nextVisible;
        group.visible = visible;
      }
      if (!visible) return;
      const breath = 0.92 + Math.sin(elapsed * 0.38) * 0.055 + Math.sin(elapsed * 0.11) * 0.025;
      for (const material of materials) {
        material.opacity = (material.userData.baseOpacity ?? material.opacity) * breath;
      }
      dust.rotation.y = Math.sin(elapsed * 0.035) * 0.012;
      dust.position.y = Math.sin(elapsed * 0.18) * 0.08;
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
