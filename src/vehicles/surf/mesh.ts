import * as THREE from "three/webgpu";

function finGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.quadraticCurveTo(0.08, -0.38, 0.32, -0.46);
  shape.lineTo(0.38, 0);
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateY(Math.PI / 2);
  return geo;
}

/** Classic Ocean Beach shortboard: readable white deck, blue rails and thruster fins. */
export function buildSurfboardMesh(): THREE.Group {
  const group = new THREE.Group();
  group.name = "surfboard";
  const outline = new THREE.Shape();
  outline.moveTo(0, -1.65);
  outline.bezierCurveTo(0.46, -1.45, 0.55, -0.72, 0.53, 0.05);
  outline.bezierCurveTo(0.5, 0.92, 0.34, 1.48, 0, 1.58);
  outline.bezierCurveTo(-0.34, 1.48, -0.5, 0.92, -0.53, 0.05);
  outline.bezierCurveTo(-0.55, -0.72, -0.46, -1.45, 0, -1.65);
  const deckGeo = new THREE.ExtrudeGeometry(outline, {
    depth: 0.11,
    bevelEnabled: true,
    bevelSegments: 2,
    bevelSize: 0.055,
    bevelThickness: 0.035,
    curveSegments: 24
  });
  deckGeo.rotateX(Math.PI / 2);
  deckGeo.translate(0, 0.02, 0);
  const deck = new THREE.Mesh(
    deckGeo,
    new THREE.MeshStandardMaterial({ color: 0xf4efe1, roughness: 0.42, metalness: 0 })
  );
  group.add(deck);

  const stripe = new THREE.Mesh(
    new THREE.BoxGeometry(0.105, 0.018, 2.92),
    new THREE.MeshStandardMaterial({ color: 0x1e86a8, roughness: 0.5 })
  );
  stripe.position.set(0, 0.14, -0.02);
  group.add(stripe);
  const noseMark = new THREE.Mesh(
    new THREE.CircleGeometry(0.14, 24),
    new THREE.MeshStandardMaterial({ color: 0xf08f45, roughness: 0.45 })
  );
  noseMark.rotation.x = -Math.PI / 2;
  noseMark.position.set(0, 0.154, -1.15);
  group.add(noseMark);

  const finMat = new THREE.MeshStandardMaterial({ color: 0x173d4d, roughness: 0.34 });
  for (const x of [-0.23, 0, 0.23]) {
    const fin = new THREE.Mesh(finGeometry(), finMat);
    fin.position.set(x, -0.1, 1.12 + Math.abs(x) * 0.32);
    fin.rotation.z = x * 0.7;
    group.add(fin);
  }

  const leash = new THREE.Mesh(
    new THREE.TorusGeometry(0.17, 0.018, 6, 20, Math.PI * 1.55),
    new THREE.MeshStandardMaterial({ color: 0x24272a, roughness: 0.8 })
  );
  leash.rotation.x = Math.PI / 2;
  leash.position.set(0.25, 0.02, 1.55);
  group.add(leash);
  return group;
}
