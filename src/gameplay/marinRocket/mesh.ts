import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import type { Cockpit } from "../../player/types";
import type { RocketFlightTelemetry } from "../../vehicles/plane";
import { applyVehicleShadowPolicy } from "../../vehicles/shadows";

export type RocketPresentation = {
  update(dt: number, telemetry: Readonly<RocketFlightTelemetry>): void;
};

const dispose = (root: THREE.Object3D): void => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
};

function deltaWingGeometry(span: number, rootChord: number, tipChord: number): THREE.BufferGeometry {
  const half = span * 0.5;
  const positions = new Float32Array([
    0, 0, -rootChord * 0.55,
    half, 0, rootChord * 0.45,
    half, 0, rootChord * 0.45 + tipChord,
    0, 0, rootChord * 0.62,
    0, -0.1, -rootChord * 0.55,
    half, -0.1, rootChord * 0.45,
    half, -0.1, rootChord * 0.45 + tipChord,
    0, -0.1, rootChord * 0.62
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1,
    1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

/** A compact single-stage spaceplane: ceramic-white lifting body, black heat
 * shield, broad clipped delta wing and three copper-vector rocket bells. */
export function createMarinRocketMesh(): THREE.Group {
  const root = new THREE.Group();
  root.name = "marin_starjet";
  const casters: THREE.Mesh[] = [];
  const receivers: THREE.Mesh[] = [];

  const white = new THREE.MeshStandardMaterial({
    color: 0xe8ece8,
    emissive: 0x8bb8c6,
    emissiveIntensity: 0.012 * LIGHT_SCALE,
    roughness: 0.48,
    metalness: 0.18
  });
  const ceramic = new THREE.MeshStandardMaterial({
    color: 0xc7d1cd,
    emissive: 0x6c8994,
    emissiveIntensity: 0.009 * LIGHT_SCALE,
    roughness: 0.72,
    metalness: 0.08
  });
  const shield = new THREE.MeshStandardMaterial({ color: 0x11171b, roughness: 0.86, metalness: 0.22 });
  const copper = new THREE.MeshStandardMaterial({ color: 0x9e5930, roughness: 0.35, metalness: 0.78 });
  const goldGlass = new THREE.MeshStandardMaterial({
    color: 0x8c5d22,
    emissive: 0xffb13d,
    emissiveIntensity: 0.18 * LIGHT_SCALE,
    roughness: 0.2,
    metalness: 0.72,
    transparent: true,
    opacity: 0.92
  });
  const darkGlass = new THREE.MeshStandardMaterial({ color: 0x162535, roughness: 0.18, metalness: 0.45 });
  const flameOuter = new THREE.MeshBasicMaterial({
    color: 0x56bfff,
    transparent: true,
    opacity: 0.54,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const flameCore = new THREE.MeshBasicMaterial({
    color: 0xfff5cd,
    transparent: true,
    opacity: 0.86,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });
  const streakMaterial = new THREE.MeshBasicMaterial({
    color: 0xb9ddff,
    transparent: true,
    opacity: 0.42,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  });

  const tube = (
    material: THREE.Material,
    frontRadius: number,
    rearRadius: number,
    length: number,
    z: number,
    radial = 18
  ) => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(rearRadius, frontRadius, length, radial), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = z;
    root.add(mesh);
    return mesh;
  };
  const box = (material: THREE.Material, size: [number, number, number], position: [number, number, number]) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    root.add(mesh);
    return mesh;
  };

  casters.push(tube(white, 0.62, 0.92, 5.5, -0.25));
  casters.push(tube(ceramic, 0.15, 0.62, 1.75, -3.87));
  casters.push(tube(shield, 0.88, 0.62, 1.35, 3.18));
  const belly = box(shield, [1.3, 0.18, 5.8], [0, -0.72, -0.15]);
  belly.rotation.x = -0.018;
  receivers.push(belly);

  const leftWing = new THREE.Mesh(deltaWingGeometry(7.4, 5.3, 0.5), white);
  leftWing.position.set(0.16, -0.16, 0.25);
  root.add(leftWing);
  casters.push(leftWing);
  const rightWing = leftWing.clone();
  rightWing.scale.x = -1;
  root.add(rightWing);
  casters.push(rightWing);
  const wingShield = new THREE.Mesh(deltaWingGeometry(7.15, 5.05, 0.45), shield);
  wingShield.position.set(0.16, -0.29, 0.31);
  root.add(wingShield);
  const wingShieldR = wingShield.clone();
  wingShieldR.scale.x = -1;
  root.add(wingShieldR);
  receivers.push(wingShield, wingShieldR);

  const canopy = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), goldGlass);
  canopy.scale.set(0.68, 0.44, 1.36);
  canopy.position.set(0, 0.72, -1.02);
  root.add(canopy);
  const canopyFrame = new THREE.Mesh(new THREE.TorusGeometry(0.7, 0.045, 8, 24), darkGlass);
  canopyFrame.rotation.x = Math.PI / 2;
  canopyFrame.scale.y = 1.82;
  canopyFrame.position.set(0, 0.71, -0.94);
  root.add(canopyFrame);

  const tail = new THREE.Mesh(deltaWingGeometry(2.35, 2.0, 0.28), ceramic);
  tail.rotation.z = Math.PI / 2;
  tail.rotation.y = -Math.PI / 2;
  tail.position.set(0, 0.64, 2.05);
  root.add(tail);
  casters.push(tail);

  const flames: THREE.Group[] = [];
  for (const x of [-0.58, 0, 0.58]) {
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.48, 0.82, 16, 1, true), copper);
    bell.rotation.x = Math.PI / 2;
    bell.position.set(x, -0.05, 4.05);
    root.add(bell);
    const flame = new THREE.Group();
    flame.position.set(x, -0.05, 4.55);
    const outer = new THREE.Mesh(new THREE.ConeGeometry(0.35, 3.8, 14, 1, true), flameOuter);
    outer.rotation.x = Math.PI / 2;
    outer.position.z = 1.85;
    const core = new THREE.Mesh(new THREE.ConeGeometry(0.17, 2.45, 12, 1, true), flameCore);
    core.rotation.x = Math.PI / 2;
    core.position.z = 1.17;
    flame.add(outer, core);
    flame.visible = false;
    root.add(flame);
    flames.push(flame);
  }

  const navLeft = box(new THREE.MeshBasicMaterial({ color: 0xff314c }), [0.14, 0.1, 0.42], [-3.62, -0.1, 2.02]);
  const navRight = box(new THREE.MeshBasicMaterial({ color: 0x4dff9a }), [0.14, 0.1, 0.42], [3.62, -0.1, 2.02]);
  navLeft.renderOrder = navRight.renderOrder = 2;

  const streaks = new THREE.Group();
  streaks.name = "rocket_streaks";
  for (let i = 0; i < 18; i++) {
    const streak = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.018, 5 + (i % 5) * 1.7), streakMaterial);
    const angle = i * 2.39996;
    const radius = 2.2 + (i % 6) * 0.72;
    streak.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius * 0.62, 7 + (i % 7) * 3.2);
    streak.userData.phase = (i * 0.137) % 1;
    streaks.add(streak);
  }
  streaks.visible = false;
  root.add(streaks);

  root.userData.cockpit = { seat: [0, 0.34, -0.82], wheel: [0, 0.52, -1.45] } satisfies Cockpit;
  root.userData.passengerSeat = [0, 0.3, 0.48] as [number, number, number];
  let flightTime = 0;
  root.userData.rocketPresentation = {
    update(dt, telemetry) {
      flightTime += dt;
      white.emissiveIntensity = (0.012 + telemetry.spaceFactor * 0.2) * LIGHT_SCALE;
      ceramic.emissiveIntensity = (0.009 + telemetry.spaceFactor * 0.14) * LIGHT_SCALE;
      const thrust = Math.min(1, 0.28 + telemetry.throttle * 0.72 + (telemetry.boost ? 0.22 : 0));
      for (let i = 0; i < flames.length; i++) {
        const pulse = 0.9 + Math.sin(flightTime * 28 + i * 1.7) * 0.09;
        flames[i].visible = telemetry.active;
        flames[i].scale.set(0.8 + thrust * 0.3, 0.8 + thrust * 0.3, pulse * (0.42 + thrust * 0.9));
      }
      streaks.visible = telemetry.spaceFactor > 0.18 && telemetry.speed > 420;
      const streakOpacity = Math.min(0.64, telemetry.spaceFactor * 0.46 + telemetry.speed / 5_000);
      streakMaterial.opacity = streakOpacity;
      const streakStretch = 1 + Math.min(6, telemetry.speed / 900);
      for (const child of streaks.children) {
        const phase = child.userData.phase as number;
        child.position.z = 7 + ((phase + flightTime * (0.25 + telemetry.speed / 1_800)) % 1) * 30;
        child.scale.z = streakStretch;
      }
    }
  } satisfies RocketPresentation;
  root.userData.dispose = () => dispose(root);
  applyVehicleShadowPolicy(root, casters, receivers);
  return root;
}
