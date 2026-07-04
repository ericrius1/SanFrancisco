import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";

// Camera drone, front is local -Z. Rotor groups live in userData.rotors with a
// per-rotor spin sign in userData.dir; DroneController spins them. Firework
// sockets are fixed to the motor hubs, not the spinning blade groups.
export function buildDroneMesh(): THREE.Group {
  const g = new THREE.Group();
  const shell = new THREE.MeshLambertMaterial({ color: 0xd9d7d0 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x24262b });
  const lens = new THREE.MeshLambertMaterial({ color: 0x101820 });
  const barrel = new THREE.MeshLambertMaterial({ color: 0x343137 });
  const warmTrim = new THREE.MeshLambertMaterial({ color: 0xb9834b, emissive: 0x4a2308, emissiveIntensity: 0.45 * LIGHT_SCALE });
  const armedGlow = new THREE.MeshLambertMaterial({ color: 0xffbd6c, emissive: 0xff7a1a, emissiveIntensity: 1.6 * LIGHT_SCALE });
  const navGreen = new THREE.MeshLambertMaterial({ color: 0x2bd45a, emissive: 0x18c74a, emissiveIntensity: 2.4 * LIGHT_SCALE });
  const navRed = new THREE.MeshLambertMaterial({ color: 0xd42b2b, emissive: 0xff2418, emissiveIntensity: 2.4 * LIGHT_SCALE });

  // body: flat pod with a raised spine, battery bulge at the rear
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.28, 1.15), shell);
  g.add(body);
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.12, 0.9), shell);
  spine.position.y = 0.2;
  g.add(spine);
  const battery = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.34), dark);
  battery.position.set(0, 0.02, 0.62);
  g.add(battery);

  // gimbal camera slung under the nose
  const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), dark);
  gimbal.position.set(0, -0.18, -0.52);
  g.add(gimbal);
  const eye = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.06), lens);
  eye.position.set(0, -0.18, -0.66);
  g.add(eye);

  // four arms out to the motor pods; nav lights on the tips (green front, red rear)
  const rotors: THREE.Group[] = [];
  const fireworkMounts: THREE.Object3D[] = [];
  const armGeo = new THREE.BoxGeometry(0.14, 0.09, 1.05);
  const podGeo = new THREE.CylinderGeometry(0.09, 0.11, 0.2, 10);
  const bladeGeo = new THREE.BoxGeometry(1.06, 0.02, 0.09);
  const discGeo = new THREE.CylinderGeometry(0.56, 0.56, 0.015, 24);
  const launcherBaseGeo = new THREE.CylinderGeometry(0.085, 0.1, 0.045, 12);
  const launcherTubeGeo = new THREE.CylinderGeometry(0.04, 0.052, 0.24, 12);
  const launcherRingGeo = new THREE.CylinderGeometry(0.055, 0.055, 0.028, 12);
  const launcherGlowGeo = new THREE.SphereGeometry(0.032, 8, 6);
  const launcherAxis = new THREE.Vector3(0, 0.48, -1).normalize();
  const launcherQuat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), launcherAxis);
  const discMat = new THREE.MeshLambertMaterial({ color: 0x1a1c20, transparent: true, opacity: 0.16, depthWrite: false });
  for (const [ax, az] of [[-0.82, -0.82], [0.82, -0.82], [-0.82, 0.82], [0.82, 0.82]]) {
    const arm = new THREE.Mesh(armGeo, dark);
    arm.position.set(ax * 0.55, 0.02, az * 0.55);
    arm.rotation.y = Math.atan2(ax, az);
    g.add(arm);
    const pod = new THREE.Mesh(podGeo, dark);
    pod.position.set(ax, 0.08, az);
    g.add(pod);
    const light = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.05, 0.1), az < 0 ? navGreen : navRed);
    light.position.set(ax, -0.02, az);
    g.add(light);
    const rotor = new THREE.Group();
    rotor.position.set(ax, 0.2, az);
    const blade = new THREE.Mesh(bladeGeo, dark);
    rotor.add(blade);
    const blade2 = new THREE.Mesh(bladeGeo, dark);
    blade2.rotation.y = Math.PI / 2;
    rotor.add(blade2);
    const disc = new THREE.Mesh(discGeo, discMat);
    rotor.add(disc);
    rotor.userData.dir = ax * az > 0 ? 1 : -1; // counter-rotating pairs
    rotor.rotation.y = Math.random() * Math.PI;
    g.add(rotor);
    rotors.push(rotor);

    const launcher = new THREE.Group();
    launcher.name = `fireworkLauncher_${ax < 0 ? "left" : "right"}_${az < 0 ? "front" : "rear"}`;
    launcher.position.set(ax, 0.245, az);
    const base = new THREE.Mesh(launcherBaseGeo, dark);
    base.name = "launcherBase";
    launcher.add(base);
    const tube = new THREE.Mesh(launcherTubeGeo, barrel);
    tube.name = "launcherTube";
    tube.quaternion.copy(launcherQuat);
    tube.position.copy(launcherAxis).multiplyScalar(0.085);
    launcher.add(tube);
    const ring = new THREE.Mesh(launcherRingGeo, warmTrim);
    ring.name = "launcherMuzzleRing";
    ring.quaternion.copy(launcherQuat);
    ring.position.copy(launcherAxis).multiplyScalar(0.21);
    launcher.add(ring);
    const glow = new THREE.Mesh(launcherGlowGeo, armedGlow);
    glow.name = "launcherReadyLight";
    glow.position.copy(launcherAxis).multiplyScalar(0.235);
    launcher.add(glow);
    const socket = new THREE.Object3D();
    socket.name = "fireworkMuzzle";
    socket.position.copy(launcherAxis).multiplyScalar(0.255);
    launcher.add(socket);
    g.add(launcher);
    fireworkMounts.push(socket);
  }
  g.userData.rotors = rotors;
  g.userData.fireworkMounts = fireworkMounts;
  return g;
}
