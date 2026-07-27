import * as THREE from "three/webgpu";
import { color, float, mix, uniform, uv } from "three/tsl";

/**
 * The tail is the part of a kite that shows you what it just did. A sine wave
 * hanging off the frame cannot do that, so this one is laid along the kite's
 * own recent path: the ribbon is resampled backwards through a short history of
 * bridle positions, so a swoop leaves the tail carving the same arc a beat
 * later, and a parked kite lets it hang straight down — the same geometry
 * covers both without a special case.
 *
 * World-space vertices under an untransformed root. The path is history; it
 * cannot ride the kite's own matrix.
 */

const SEGMENTS = 26;
const HISTORY = 56;
const SAMPLE_INTERVAL = 1 / 40;
const BOW_COUNT = 4;

export type KiteTailUpdate = {
  dt: number;
  elapsed: number;
  /** Where the tail leaves the kite, world space. */
  root: THREE.Vector3;
  /** Camera position — the ribbon turns its face toward it between twists. */
  view: THREE.Vector3;
  /** Arc length to lay out; the caller clamps this against the sand. */
  length: number;
  /** Kite speed, m/s. Fast flight streams the tail out behind it. */
  speed: number;
  /** Tuned wind strength, for the travelling ripple. */
  wind: number;
  /** 0..1 — how much low sun is shining through the ribbon. */
  backlight: number;
};

export type KiteTail = {
  mesh: THREE.Mesh;
  bows: THREE.Group;
  update(o: KiteTailUpdate): void;
  dispose(): void;
};

export type KiteTailPalette = {
  ribbonNear: number;
  ribbonFar: number;
  bows: readonly [number, number, number, number];
};

export function createKiteTail(palette: KiteTailPalette): KiteTail {
  const vertexCount = (SEGMENTS + 1) * 2;
  const positions = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const normals = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
  const uvs = new THREE.BufferAttribute(new Float32Array(vertexCount * 2), 2);
  positions.setUsage(THREE.DynamicDrawUsage);
  normals.setUsage(THREE.DynamicDrawUsage);

  const indices: number[] = [];
  for (let i = 0; i <= SEGMENTS; i++) {
    const a = i * 2;
    uvs.setXY(a, 0, i / SEGMENTS);
    uvs.setXY(a + 1, 1, i / SEGMENTS);
    if (i < SEGMENTS) indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", positions);
  geometry.setAttribute("normal", normals);
  geometry.setAttribute("uv", uvs);
  geometry.setIndex(indices);
  // World-space vertices have no meaningful local bounds; the encounter's own
  // wake radius already decides whether any of this is worth drawing.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

  const backlight = uniform(0);
  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.62,
    metalness: 0,
    transparent: true,
    depthWrite: false
  });
  const along = uv().y;
  material.colorNode = mix(color(palette.ribbonNear), color(palette.ribbonFar), along.mul(0.9));
  // Thin dyed nylon lit from behind stops being purple and becomes a filament
  // of the sunset itself — brightest out at the whipping tip.
  material.emissiveNode = mix(color(0xd9612a), color(0xffc27e), along)
    .mul(backlight)
    .mul(along.mul(0.5).add(0.4))
    .mul(0.8);
  material.opacityNode = float(1).sub(along.mul(0.24));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "ocean_beach_kite_tail_ribbon";
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.renderOrder = 2;

  const bows = new THREE.Group();
  bows.name = "ocean_beach_kite_tail_bows";
  const bowGeometry = new THREE.PlaneGeometry(0.52, 0.24);
  const bowMaterials: THREE.MeshStandardNodeMaterial[] = [];
  const bowMeshes: THREE.Mesh[] = [];
  const bowColors = palette.bows;
  for (let i = 0; i < BOW_COUNT; i++) {
    const bowMaterial = new THREE.MeshStandardNodeMaterial({
      side: THREE.DoubleSide,
      roughness: 0.72
    });
    bowMaterial.colorNode = color(bowColors[i]);
    bowMaterial.emissiveNode = color(0xffb469).mul(backlight).mul(0.9);
    const bow = new THREE.Mesh(bowGeometry, bowMaterial);
    bow.name = `ocean_beach_kite_tail_bow_${i}`;
    bow.frustumCulled = false;
    bow.castShadow = false;
    bow.receiveShadow = false;
    bowMaterials.push(bowMaterial);
    bowMeshes.push(bow);
    bows.add(bow);
  }

  // Path history: a ring of recent bridle positions on a fixed clock, so the
  // ribbon's shape does not change with the frame rate.
  const history: THREE.Vector3[] = Array.from({ length: HISTORY }, () => new THREE.Vector3());
  let historyHead = 0;
  let seeded = false;
  let sampleClock = 0;

  // Newest-first polyline plus its cumulative arc length, rebuilt each frame.
  const path: THREE.Vector3[] = Array.from({ length: HISTORY + 1 }, () => new THREE.Vector3());
  const arc = new Float32Array(HISTORY + 1);

  const point = new THREE.Vector3();
  const previousPoint = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const ribbonAxis = new THREE.Vector3();
  const toView = new THREE.Vector3();
  const edge = new THREE.Vector3();
  const bowSide = new THREE.Vector3();
  const bowUp = new THREE.Vector3();
  const bowNormal = new THREE.Vector3();
  const bowBasis = new THREE.Matrix4();
  // Per-vertex ribbon frame, kept so the bows can sit on the finished curve.
  const spine = new Float32Array((SEGMENTS + 1) * 3);
  const spineAxis = new Float32Array((SEGMENTS + 1) * 3);

  return {
    mesh,
    bows,
    update(o) {
      if (!seeded) {
        for (const entry of history) entry.copy(o.root);
        seeded = true;
      }
      sampleClock += o.dt;
      while (sampleClock >= SAMPLE_INTERVAL) {
        sampleClock -= SAMPLE_INTERVAL;
        history[historyHead].copy(o.root);
        historyHead = (historyHead + 1) % HISTORY;
      }

      path[0].copy(o.root);
      arc[0] = 0;
      let pathCount = 1;
      for (let i = 0; i < HISTORY; i++) {
        const sample = history[(historyHead - 1 - i + HISTORY * 2) % HISTORY];
        const step = sample.distanceTo(path[pathCount - 1]);
        if (step < 0.01) continue;
        path[pathCount].copy(sample);
        arc[pathCount] = arc[pathCount - 1] + step;
        pathCount++;
      }
      const pathEnd = arc[pathCount - 1];

      const length = Math.max(0.2, o.length);
      const step = length / SEGMENTS;
      // A tail hangs unless the kite is dragging it out; fast flight trades sag
      // for a streamed ribbon, which is what a real one does.
      const streamed = THREE.MathUtils.clamp(o.speed / 7, 0, 1);
      const sag = length * 0.16 * (1 - streamed * 0.75);
      const ripple = 0.16 + o.wind * 0.12;
      backlight.value = o.backlight;

      let cursor = 1;
      for (let i = 0; i <= SEGMENTS; i++) {
        const target = i * step;
        if (target <= pathEnd) {
          while (cursor < pathCount - 1 && arc[cursor] < target) cursor++;
          const spanStart = arc[cursor - 1];
          const spanLength = Math.max(1e-5, arc[cursor] - spanStart);
          edge.copy(path[cursor]).sub(path[cursor - 1]);
          point.copy(path[cursor - 1]).addScaledVector(edge, (target - spanStart) / spanLength);
        } else {
          // Past the end of the remembered path the tail simply hangs — the
          // stationary-kite case, reached without a branch in the caller.
          point.copy(path[pathCount - 1]);
          point.y -= target - pathEnd;
        }

        const t = i / SEGMENTS;
        point.y -= t * t * sag;

        tangent.set(0, -1, 0);
        if (i > 0) {
          tangent.copy(point).sub(previousPoint);
          if (tangent.lengthSq() < 1e-8) tangent.set(0, -1, 0);
          tangent.normalize();
        }
        previousPoint.copy(point);

        toView.copy(o.view).sub(point);
        side.copy(tangent).cross(toView);
        if (side.lengthSq() < 1e-8) side.set(1, 0, 0);
        side.normalize();
        normal.copy(side).cross(tangent).normalize();

        // Ripple travelling down the ribbon, then a twist about its own spine
        // so the band periodically flashes edge-on instead of reading as tape.
        const wave = Math.sin(o.elapsed * 3.1 - t * 7.4) * t * ripple;
        const lift = Math.sin(o.elapsed * 2.3 - t * 5.9 + 1.3) * t * ripple * 0.8;
        point.addScaledVector(side, wave).addScaledVector(normal, lift);

        // Enough twist to flash edge-on now and then, not enough to spend most
        // of its length looking like a rope.
        const twist = Math.sin(o.elapsed * 2.1 - t * 4.4) * (0.3 + streamed * 0.32);
        ribbonAxis
          .copy(side)
          .multiplyScalar(Math.cos(twist))
          .addScaledVector(normal, Math.sin(twist));
        normal.copy(ribbonAxis).cross(tangent).normalize();

        const halfWidth = 0.3 - t * 0.19;
        const a = i * 2;
        positions.setXYZ(
          a,
          point.x - ribbonAxis.x * halfWidth,
          point.y - ribbonAxis.y * halfWidth,
          point.z - ribbonAxis.z * halfWidth
        );
        positions.setXYZ(
          a + 1,
          point.x + ribbonAxis.x * halfWidth,
          point.y + ribbonAxis.y * halfWidth,
          point.z + ribbonAxis.z * halfWidth
        );
        normals.setXYZ(a, normal.x, normal.y, normal.z);
        normals.setXYZ(a + 1, normal.x, normal.y, normal.z);

        spine[i * 3] = point.x;
        spine[i * 3 + 1] = point.y;
        spine[i * 3 + 2] = point.z;
        spineAxis[i * 3] = ribbonAxis.x;
        spineAxis[i * 3 + 1] = ribbonAxis.y;
        spineAxis[i * 3 + 2] = ribbonAxis.z;
      }

      positions.needsUpdate = true;
      normals.needsUpdate = true;

      for (let i = 0; i < bowMeshes.length; i++) {
        const index = Math.round(((i + 1) / (BOW_COUNT + 1)) * SEGMENTS);
        const previous = Math.max(0, index - 1);
        const bow = bowMeshes[i];
        bow.position.set(spine[index * 3], spine[index * 3 + 1], spine[index * 3 + 2]);
        bowSide.set(spineAxis[index * 3], spineAxis[index * 3 + 1], spineAxis[index * 3 + 2]);
        bowUp.set(
          spine[index * 3] - spine[previous * 3],
          spine[index * 3 + 1] - spine[previous * 3 + 1],
          spine[index * 3 + 2] - spine[previous * 3 + 2]
        );
        if (bowUp.lengthSq() < 1e-8) bowUp.set(0, -1, 0);
        bowUp.normalize();
        bowNormal.copy(bowSide).cross(bowUp).normalize();
        bowSide.copy(bowUp).cross(bowNormal).normalize();
        bow.quaternion.setFromRotationMatrix(bowBasis.makeBasis(bowSide, bowUp, bowNormal));
        bow.scale.x = 0.85 + Math.sin(o.elapsed * 4.1 + i * 1.7) * 0.15;
      }
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      bowGeometry.dispose();
      for (const bowMaterial of bowMaterials) bowMaterial.dispose();
      mesh.removeFromParent();
      bows.removeFromParent();
    }
  };
}
