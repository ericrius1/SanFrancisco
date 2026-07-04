import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LIGHT_SCALE } from "../../config";

/** Flying broom for Quidditch — rider rig is parented by Player. */
export function buildBroomMesh(teamColor = 0x8b4513): THREE.Group {
  const g = new THREE.Group();
  g.userData.broom = true;

  const stickMat = new THREE.MeshLambertMaterial({ color: teamColor });
  const bristleMat = new THREE.MeshLambertMaterial({ color: 0xd4a574 });
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffe08a).multiplyScalar(LIGHT_SCALE * 0.35) });

  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 2.2, 8), stickMat);
  stick.rotation.x = Math.PI / 2;
  stick.position.set(0, 0.15, 0.3);
  g.add(stick);

  const bristles = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.55, 10), bristleMat);
  bristles.rotation.x = -Math.PI / 2;
  bristles.position.set(0, 0.12, 1.35);
  g.add(bristles);

  const trail = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.04, 0.9), glow);
  trail.position.set(0, 0.08, 1.05);
  g.add(trail);

  return g;
}

/** Compact broom+rider blob for instanced AI players. */
export function broomRiderGeometry(): THREE.BufferGeometry {
  const stick = new THREE.Color(0x6b3f1f);
  const robe = new THREE.Color(0xffffff);
  const paint = (g: THREE.BufferGeometry, c: THREE.Color) => {
    const n = g.getAttribute("position").count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = c.r;
      arr[i * 3 + 1] = c.g;
      arr[i * 3 + 2] = c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(arr, 3));
    return g;
  };
  const body = paint(new THREE.CapsuleGeometry(0.22, 0.5, 4, 8), robe);
  body.translate(0, 0.55, -0.15);
  const broom = paint(new THREE.BoxGeometry(0.08, 0.08, 1.6), stick);
  broom.translate(0, 0.28, 0.35);
  broom.rotateX(-0.35);
  const merged = mergeGeometries([body, broom]);
  body.dispose();
  broom.dispose();
  return merged;
}
