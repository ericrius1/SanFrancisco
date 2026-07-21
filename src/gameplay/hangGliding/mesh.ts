import * as THREE from "three/webgpu";
import { createHangGliderCanopyMaterial } from "./canopyMaterial";
import {
  hangGliderFrame,
  hangGliderPalette,
  type HangGliderStyle
} from "./style";

const UP = new THREE.Vector3(0, 1, 0);
const HALF_SPAN = 6.7;
const SPAN_SEGMENTS = 48;
const CHORD_SEGMENTS = 18;

export type HangGliderVisualFrame = Readonly<{
  airspeed: number;
  verticalSpeed: number;
  lift: number;
}>;

export type HangGliderPresentation = Readonly<{
  /** Live customizer edits; changes uniforms/transforms without rebuilding. */
  setStyle(style: HangGliderStyle): void;
  /** Flight telemetry drives cloth pressure/gust response. */
  update(dt: number, frame: HangGliderVisualFrame): void;
}>;

export type CreatedHangGliderMesh = Readonly<{
  root: THREE.Group;
  presentation: HangGliderPresentation;
}>;

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

function profilePoint(span: number, chord: number): THREE.Vector3 {
  const edge = Math.min(1, Math.abs(span));
  const leadingZ = -3.3 + Math.pow(edge, 1.72) * 4.02;
  const trailingZ = 2.52 - Math.pow(edge, 2.7) * 1.62;
  const arch = 0.54 * (1 - Math.pow(edge, 1.72));
  const belly = Math.sin(Math.PI * chord) * (0.1 + 0.12 * (1 - edge));
  return new THREE.Vector3(
    span * HALF_SPAN,
    -0.18 + arch + belly,
    THREE.MathUtils.lerp(leadingZ, trailingZ, chord)
  );
}

function createCanopyGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let x = 0; x <= SPAN_SEGMENTS; x++) {
    const u = x / SPAN_SEGMENTS;
    const span = u * 2 - 1;
    for (let z = 0; z <= CHORD_SEGMENTS; z++) {
      const v = z / CHORD_SEGMENTS;
      const point = profilePoint(span, v);
      positions.push(point.x, point.y, point.z);
      uvs.push(u, v);
    }
  }
  const stride = CHORD_SEGMENTS + 1;
  for (let x = 0; x < SPAN_SEGMENTS; x++) {
    for (let z = 0; z < CHORD_SEGMENTS; z++) {
      const a = x * stride + z;
      const b = (x + 1) * stride + z;
      const c = b + 1;
      const d = a + 1;
      indices.push(a, d, b, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function curvedTube(
  parent: THREE.Object3D,
  material: THREE.Material,
  points: THREE.Vector3[],
  radius: number,
  name: string
): THREE.Mesh {
  const curve = new THREE.CatmullRomCurve3(points, false, "centripetal", 0.45);
  const mesh = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 64, radius, 8, false),
    material
  );
  mesh.name = name;
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function edgePoints(chord: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  for (let i = 0; i <= 24; i++) points.push(profilePoint(i / 12 - 1, chord));
  return points;
}

/** A broad, crescent-planform sport canopy. The airframe follows the curved
 * membrane boundaries rather than drawing a triangular delta beneath it; a
 * lightweight TSL vertex field supplies the live pressure and trailing flutter. */
export function createHangGliderMesh(initial: HangGliderStyle): CreatedHangGliderMesh {
  const root = new THREE.Group();
  root.name = "sutro_hang_glider";
  const wing = new THREE.Group();
  wing.name = "hang_glider_wing";
  root.add(wing);

  const canopy = createHangGliderCanopyMaterial(initial);
  const canopyMesh = new THREE.Mesh(createCanopyGeometry(), canopy.material);
  canopyMesh.name = "hang_glider_canopy";
  canopyMesh.castShadow = true;
  canopyMesh.receiveShadow = true;
  wing.add(canopyMesh);

  const frameMaterial = new THREE.MeshStandardMaterial({
    color: 0x202a31,
    roughness: 0.24,
    metalness: 0.76
  });
  const frameAccent = new THREE.MeshStandardMaterial({
    color: 0x8e9da4,
    roughness: 0.32,
    metalness: 0.68
  });
  const cableMaterial = new THREE.MeshStandardMaterial({
    color: 0x151a1f,
    roughness: 0.52,
    metalness: 0.6
  });
  const harnessMaterial = new THREE.MeshStandardMaterial({
    color: 0x1c262e,
    roughness: 0.72,
    metalness: 0.06
  });
  const lightMaterial = new THREE.MeshStandardMaterial({
    color: 0xbffbf0,
    emissive: 0x57e0c0,
    emissiveIntensity: 3.4,
    roughness: 0.22,
    metalness: 0.08
  });

  // The leading and trailing tubes inherit exactly the canopy's authored arcs.
  curvedTube(wing, frameMaterial, edgePoints(0.015), 0.073, "hang_glider_leading_spar");
  curvedTube(wing, frameAccent, edgePoints(0.985), 0.036, "hang_glider_trailing_spar");
  tubeBetween(wing, frameMaterial, profilePoint(0, 0.01), profilePoint(0, 0.99), 0.054, 8);
  for (const span of [-0.82, -0.61, -0.39, -0.18, 0.18, 0.39, 0.61, 0.82]) {
    tubeBetween(wing, frameAccent, profilePoint(span, 0.035), profilePoint(span, 0.965), 0.02, 6);
  }

  // Kingpost and tension web make the machine legible without obscuring the sail.
  const keel = profilePoint(0, 0.56);
  const king = new THREE.Vector3(0, 1.48, -0.1);
  tubeBetween(wing, frameMaterial, keel, king, 0.038, 7);
  tubeBetween(wing, cableMaterial, king, profilePoint(-0.99, 0.25), 0.012, 5);
  tubeBetween(wing, cableMaterial, king, profilePoint(0.99, 0.25), 0.012, 5);
  tubeBetween(wing, cableMaterial, king, profilePoint(0, 0.98), 0.011, 5);

  // Sculpted nose fairing and compact glowing tip pods give the glider an
  // authored vehicle identity at video distance, not just a sail plus sticks.
  const noseFairing = new THREE.Mesh(new THREE.CapsuleGeometry(0.15, 0.46, 6, 12), frameAccent);
  noseFairing.rotation.x = Math.PI / 2;
  noseFairing.position.copy(profilePoint(0, 0)).add(new THREE.Vector3(0, 0.01, 0.06));
  noseFairing.castShadow = true;
  wing.add(noseFairing);
  for (const side of [-1, 1]) {
    const tip = new THREE.Group();
    tip.position.copy(profilePoint(side, 0.48));
    tip.rotation.z = side * -0.16;
    const pod = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.3, 5, 10), frameAccent);
    pod.rotation.x = Math.PI / 2;
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.105, 12, 8), lightMaterial);
    lamp.position.z = 0.27;
    tip.add(pod, lamp);
    wing.add(tip);
  }

  // Aerodynamic A-frame and softly curved base bar remain close to the pilot,
  // independent of the customizer's wider sail-span transform.
  const barLeft = new THREE.Vector3(-0.92, -1.32, -0.58);
  const barRight = new THREE.Vector3(0.92, -1.32, -0.58);
  tubeBetween(root, frameMaterial, new THREE.Vector3(-2.45, -0.05, 0.85), barLeft, 0.045, 8);
  tubeBetween(root, frameMaterial, new THREE.Vector3(2.45, -0.05, 0.85), barRight, 0.045, 8);
  tubeBetween(root, frameAccent, barLeft, barRight, 0.058, 9);
  tubeBetween(root, cableMaterial, new THREE.Vector3(0, -0.04, 0.18), new THREE.Vector3(0, -1.42, 0.48), 0.064, 7);

  const harness = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.29, 1.8, 7, 12),
    harnessMaterial
  );
  harness.rotation.x = Math.PI / 2;
  harness.position.set(0, -1.58, 1.05);
  harness.castShadow = true;
  root.add(harness);

  const setStyle = (style: HangGliderStyle) => {
    canopy.setStyle(style);
    wing.scale.set(style.span, style.crown, 1);
    const finish = hangGliderFrame(style.frame);
    const palette = hangGliderPalette(style.palette);
    frameMaterial.color.set(finish.color);
    frameMaterial.metalness = finish.metalness;
    frameAccent.color.set(finish.accent);
    frameAccent.metalness = Math.max(0.55, finish.metalness - 0.08);
    lightMaterial.color.set(palette.colors[0]);
    lightMaterial.emissive.set(palette.colors[2]);
  };

  setStyle(initial);
  const presentation: HangGliderPresentation = {
    setStyle,
    update(dt, frame) {
      canopy.update(dt, frame);
      const liftPulse = THREE.MathUtils.clamp(frame.lift * 0.22 + Math.abs(frame.verticalSpeed) * 0.035, 0, 1.4);
      lightMaterial.emissiveIntensity +=
        (3.2 + liftPulse - lightMaterial.emissiveIntensity) *
        (1 - Math.exp(-Math.min(Math.max(dt, 0), 1 / 20) * 4));
    }
  };

  root.userData.hangGliderPresentation = presentation;
  root.userData.dispose = () => {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      geometries.add(object.geometry);
      const entries = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of entries) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  };
  return { root, presentation };
}
