import * as THREE from "three/webgpu";

const UP = new THREE.Vector3(0, 1, 0);

function tubeBetween(
  parent: THREE.Object3D,
  material: THREE.Material,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  radialSegments = 7
): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), radialSegments);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  parent.add(mesh);
  return mesh;
}

function clothPanel(
  parent: THREE.Object3D,
  material: THREE.Material,
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number]
): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([...a, ...b, ...c], 3)
  );
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

/** Broad late-90s sport-wing silhouette: warm segmented sail, visible battens,
 * kingpost, A-frame control bar and a dark cocoon harness. */
export function createHangGliderMesh(): THREE.Group {
  const root = new THREE.Group();
  root.name = "sutro_hang_glider";
  const wing = new THREE.Group();
  wing.name = "hang_glider_wing";
  root.add(wing);

  const cream = new THREE.MeshStandardMaterial({
    color: 0xfff0cc,
    roughness: 0.82,
    side: THREE.DoubleSide
  });
  const saffron = new THREE.MeshStandardMaterial({
    color: 0xf2b544,
    roughness: 0.78,
    side: THREE.DoubleSide
  });
  const coral = new THREE.MeshStandardMaterial({
    color: 0xd95743,
    roughness: 0.76,
    side: THREE.DoubleSide
  });
  const teal = new THREE.MeshStandardMaterial({
    color: 0x237b78,
    roughness: 0.72,
    side: THREE.DoubleSide
  });
  const aluminum = new THREE.MeshStandardMaterial({
    color: 0xd8dfdf,
    roughness: 0.28,
    metalness: 0.72
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x22282c, roughness: 0.7 });

  const nose = [0, 0.03, -3.25] as const;
  const center = [0, -0.01, 2.1] as const;
  const leftInner = [-1.8, 0.02, 2.2] as const;
  const leftTip = [-5.25, -0.05, 2.38] as const;
  const rightInner = [1.8, 0.02, 2.2] as const;
  const rightTip = [5.25, -0.05, 2.38] as const;
  clothPanel(wing, cream, nose, center, leftInner);
  clothPanel(wing, saffron, nose, leftInner, leftTip);
  clothPanel(wing, coral, nose, leftTip, [-4.45, -0.04, 2.35]);
  clothPanel(wing, cream, nose, rightInner, center);
  clothPanel(wing, teal, nose, rightTip, rightInner);
  clothPanel(wing, coral, nose, [4.45, -0.04, 2.35], rightTip);

  const p = (v: readonly [number, number, number]) => new THREE.Vector3(...v);
  tubeBetween(wing, aluminum, p(nose), p(leftTip), 0.055);
  tubeBetween(wing, aluminum, p(nose), p(rightTip), 0.055);
  tubeBetween(wing, aluminum, p(leftTip), p(rightTip), 0.048);
  tubeBetween(wing, aluminum, p(nose), p(center), 0.05);
  for (const x of [-3.6, -1.8, 1.8, 3.6]) {
    tubeBetween(
      wing,
      aluminum,
      new THREE.Vector3(0, 0.015, -2.8),
      new THREE.Vector3(x, -0.025, 2.25),
      0.018,
      5
    );
  }

  const king = new THREE.Vector3(0, 1.05, 0.15);
  tubeBetween(root, aluminum, new THREE.Vector3(0, 0, 0.1), king, 0.034, 6);
  tubeBetween(root, aluminum, king, p(leftTip), 0.012, 5);
  tubeBetween(root, aluminum, king, p(rightTip), 0.012, 5);

  const barLeft = new THREE.Vector3(-0.82, -1.22, -0.68);
  const barRight = new THREE.Vector3(0.82, -1.22, -0.68);
  tubeBetween(root, aluminum, new THREE.Vector3(-2.7, -0.02, 1.05), barLeft, 0.042);
  tubeBetween(root, aluminum, new THREE.Vector3(2.7, -0.02, 1.05), barRight, 0.042);
  tubeBetween(root, aluminum, barLeft, barRight, 0.05);
  tubeBetween(root, dark, new THREE.Vector3(0, -0.1, 0.3), new THREE.Vector3(0, -1.38, 0.48), 0.065);

  const harness = new THREE.Mesh(new THREE.CapsuleGeometry(0.27, 1.65, 6, 10), dark);
  harness.rotation.x = Math.PI / 2;
  harness.position.set(0, -1.54, 1.05);
  harness.castShadow = true;
  root.add(harness);

  root.userData.dispose = () => {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
    });
    for (const material of [cream, saffron, coral, teal, aluminum, dark]) material.dispose();
  };
  return root;
}
