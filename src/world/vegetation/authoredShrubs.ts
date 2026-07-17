// Shared authored shrub renderer.
//
// This deliberately avoids the old squashed-icosahedron "foliage boulder".
// Each GPU instance is a layered spray of individually shaped leaves with a
// soft, irregular silhouette. A compact TSL material gives every patch the
// same wind clock as grass and flowers, while per-instance palette buffers keep
// azaleas, coastal scrub and clipped hedges in a handful of draws.

import * as THREE from "three/webgpu";
import { attribute, color, mix, positionLocal, vec3 } from "three/tsl";
import { instanceAnchorWorld, worldOffsetToModelLocal } from "../groundcover/instanceDeform";
import { groundSway, WIND_DIR } from "../groundcover/sway";

type N = any;

export type AuthoredShrubProfile = "natural" | "azalea" | "hedge" | "fern" | "coastal-scrub";

export type AuthoredShrubPalette = {
  foliageA: number;
  foliageB: number;
  blooms?: readonly number[];
  bloomChance?: number;
};

export type AuthoredShrubPlacement = {
  x: number;
  /** Root surface height; the renderer owns the profile's vertical lift. */
  y: number;
  z: number;
  yaw: number;
  scale: number;
  palette: number;
  profile?: AuthoredShrubProfile;
  /** Stable 0..1 tint/bloom selector. */
  tint?: number;
  /** Per-instance wind response; defaults to a profile-appropriate value. */
  wind?: number;
};

export type AuthoredShrubPatch = {
  group: THREE.Group;
  stats: { instances: number; draws: number; triangles: number };
  dispose(): void;
};

const PROFILES: Record<AuthoredShrubProfile, {
  count: number;
  radiusX: number;
  radiusZ: number;
  height: number;
  leafLength: number;
  leafWidth: number;
  bloomEvery: number;
  wind: number;
  woodyStems?: number;
  /** Extra low outward leaves that seat the bush on the ground. */
  skirt?: number;
  /** Interior mass hull; false only for airy profiles (fern). */
  core?: boolean;
  /** Rounded-square hull rings for clipped profiles. */
  squareness?: number;
}> = {
  natural: { count: 62, radiusX: 0.9, radiusZ: 0.78, height: 1.08, leafLength: 0.31, leafWidth: 0.17, bloomEvery: 8, wind: 0.72, skirt: 5, core: true },
  azalea: { count: 70, radiusX: 0.96, radiusZ: 0.86, height: 0.86, leafLength: 0.28, leafWidth: 0.18, bloomEvery: 5, wind: 0.58, skirt: 6, core: true },
  hedge: { count: 80, radiusX: 1.0, radiusZ: 0.76, height: 0.94, leafLength: 0.25, leafWidth: 0.16, bloomEvery: 11, wind: 0.36, skirt: 7, core: true, squareness: 0.62 },
  fern: { count: 30, radiusX: 1.05, radiusZ: 1.05, height: 1.18, leafLength: 0.62, leafWidth: 0.13, bloomEvery: 999, wind: 0.9 },
  "coastal-scrub": {
    count: 44,
    radiusX: 1.16,
    radiusZ: 0.96,
    height: 1.36,
    leafLength: 0.38,
    leafWidth: 0.15,
    bloomEvery: 999,
    wind: 0.58,
    woodyStems: 6,
    skirt: 8,
    core: true
  }
};

function seeded(index: number, salt: number): number {
  const v = Math.sin(index * 91.713 + salt * 37.119) * 43758.5453;
  return v - Math.floor(v);
}

function pushLeaf(
  positions: number[],
  colors: number[],
  flex: number[],
  blooms: number[],
  bark: number[],
  indices: number[],
  center: THREE.Vector3,
  outward: THREE.Vector3,
  tangent: THREE.Vector3,
  length: number,
  width: number,
  tipWeight: number,
  phase: number,
  bloom: number,
  shadeMul = 1
) {
  const base = positions.length / 3;
  const rise = new THREE.Vector3(outward.x * 0.22, 0.94, outward.z * 0.22).normalize();
  const root = center.clone().addScaledVector(rise, -length * 0.46);
  const tip = center.clone().addScaledVector(rise, length * 0.58).addScaledVector(outward, length * 0.12);
  const left = center.clone().addScaledVector(tangent, width).addScaledVector(outward, width * 0.18);
  const right = center.clone().addScaledVector(tangent, -width).addScaledVector(outward, width * 0.18);
  const heart = center.clone().addScaledVector(outward, width * 0.46).addScaledVector(rise, length * 0.05);
  for (const vertex of [root, left, tip, right, heart]) {
    positions.push(vertex.x, vertex.y, vertex.z);
  }
  // Root-to-tip brightness makes every individual leaf readable without a
  // texture; the material multiplies this by the instance's botanical tint.
  for (const raw of [0.62, 0.84, 1, 0.79, 0.93]) {
    const shade = raw * shadeMul;
    colors.push(shade, shade, 0.88 + shade * 0.12);
  }
  for (const weight of [0.25, 0.68, 1, 0.68, 0.82]) flex.push(tipWeight * weight, phase);
  for (let i = 0; i < 5; i++) blooms.push(bloom);
  for (let i = 0; i < 5; i++) bark.push(0);
  indices.push(
    base, base + 1, base + 4,
    base + 1, base + 2, base + 4,
    base + 2, base + 3, base + 4,
    base + 3, base, base + 4
  );
}

function pushWoodyStem(
  positions: number[],
  colors: number[],
  flex: number[],
  blooms: number[],
  bark: number[],
  indices: number[],
  start: THREE.Vector3,
  end: THREE.Vector3,
  baseRadius: number,
  tipRadius: number,
  phase: number
) {
  const sides = 5;
  const base = positions.length / 3;
  const direction = end.clone().sub(start).normalize();
  const radialA = new THREE.Vector3().crossVectors(
    Math.abs(direction.y) > 0.92 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0),
    direction
  ).normalize();
  const radialB = new THREE.Vector3().crossVectors(direction, radialA).normalize();
  for (let ring = 0; ring < 2; ring++) {
    const center = ring === 0 ? start : end;
    const radius = ring === 0 ? baseRadius : tipRadius;
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2;
      const vertex = center.clone()
        .addScaledVector(radialA, Math.cos(angle) * radius)
        .addScaledVector(radialB, Math.sin(angle) * radius);
      positions.push(vertex.x, vertex.y, vertex.z);
      const shade = 0.56 + (side / sides) * 0.2 + ring * 0.06;
      colors.push(shade, shade, shade);
      flex.push(ring === 0 ? 0.04 : 0.34, phase);
      blooms.push(0);
      bark.push(1);
    }
  }
  for (let side = 0; side < sides; side++) {
    const next = (side + 1) % sides;
    indices.push(
      base + side,
      base + next,
      base + sides + next,
      base + side,
      base + sides + next,
      base + sides + side
    );
  }
}

/**
 * Interior mass hull: an irregular low-poly dome just inside the leaf shell.
 * Kills the see-through "floating diamond confetti" read by giving the spray a
 * self-shadowed core, for ~40 triangles per instance on the same material.
 */
function pushCoreHull(
  positions: number[],
  colors: number[],
  flex: number[],
  blooms: number[],
  bark: number[],
  indices: number[],
  p: (typeof PROFILES)[AuthoredShrubProfile]
) {
  const sides = 8;
  const clipped = p.squareness ?? 1;
  const rings: { y: number; r: number; shade: number; sway: number }[] = [
    { y: 0.04, r: 0.76, shade: 0.5, sway: 0.04 },
    { y: p.height * 0.42, r: 0.88, shade: 0.62, sway: 0.1 },
    { y: p.height * (clipped < 1 ? 0.78 : 0.74), r: clipped < 1 ? 0.78 : 0.64, shade: 0.74, sway: 0.18 }
  ];
  const base = positions.length / 3;
  for (let ring = 0; ring < rings.length; ring++) {
    const spec = rings[ring];
    for (let side = 0; side < sides; side++) {
      const angle = (side / sides) * Math.PI * 2 + ring * 0.32;
      let c = Math.cos(angle);
      let s = Math.sin(angle);
      if (clipped < 1) {
        c = Math.sign(c) * Math.pow(Math.abs(c), clipped);
        s = Math.sign(s) * Math.pow(Math.abs(s), clipped);
      }
      const jitter = 0.88 + seeded(ring * sides + side, 61) * 0.2;
      positions.push(
        c * p.radiusX * spec.r * jitter,
        spec.y * (0.94 + seeded(ring * sides + side, 67) * 0.12),
        s * p.radiusZ * spec.r * jitter
      );
      const shade = spec.shade + seeded(ring * sides + side, 71) * 0.06;
      colors.push(shade, shade, 0.88 + shade * 0.12);
      flex.push(spec.sway, angle);
      blooms.push(0);
      bark.push(0);
    }
  }
  // top cap vertex (flatter for clipped hedges)
  positions.push(0, p.height * (clipped < 1 ? 0.84 : 0.9), 0);
  colors.push(0.85, 0.85, 0.88 + 0.85 * 0.12);
  flex.push(0.24, 0);
  blooms.push(0);
  bark.push(0);
  const cap = base + rings.length * sides;
  for (let ring = 0; ring < rings.length - 1; ring++) {
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      const a = base + ring * sides + side;
      const b = base + ring * sides + next;
      const c = base + (ring + 1) * sides + next;
      const d = base + (ring + 1) * sides + side;
      indices.push(a, b, c, a, c, d);
    }
  }
  const top = base + (rings.length - 1) * sides;
  for (let side = 0; side < sides; side++) {
    indices.push(top + side, top + ((side + 1) % sides), cap);
  }
}

function makeLeafSprayGeometry(profile: AuthoredShrubProfile): THREE.BufferGeometry {
  const p = PROFILES[profile];
  const positions: number[] = [];
  const colors: number[] = [];
  const flex: number[] = [];
  const blooms: number[] = [];
  const bark: number[] = [];
  const indices: number[] = [];
  const center = new THREE.Vector3();
  const outward = new THREE.Vector3();
  const tangent = new THREE.Vector3();

  for (let i = 0; i < (p.woodyStems ?? 0); i++) {
    const phase = (i / (p.woodyStems ?? 1)) * Math.PI * 2 + seeded(i, 41) * 0.6;
    const reach = 0.3 + seeded(i, 43) * 0.32;
    pushWoodyStem(
      positions,
      colors,
      flex,
      blooms,
      bark,
      indices,
      new THREE.Vector3(Math.cos(phase) * 0.045, 0.02, Math.sin(phase) * 0.045),
      new THREE.Vector3(
        Math.cos(phase) * reach,
        0.72 + seeded(i, 47) * 0.42,
        Math.sin(phase) * reach * 0.82
      ),
      0.055 + seeded(i, 53) * 0.025,
      0.025,
      phase
    );
  }

  for (let i = 0; i < p.count; i++) {
    const level = (i + 0.65) / p.count;
    const coastal = profile === "coastal-scrub";
    const phase = i * 2.399963 + seeded(i, 3) * (coastal ? 0.92 : 0.42);
    const shell = profile === "fern"
      ? 0.36 + level * 0.72
      : Math.pow(Math.sin(Math.PI * Math.min(0.96, level)), coastal ? 0.38 : 0.48) *
        (coastal ? 0.7 + seeded(i, 7) * 0.38 : 0.78 + seeded(i, 7) * 0.24);
    const y = profile === "fern"
      ? 0.86 + seeded(i, 11) * 0.28 + (i % 3) * 0.07
      : 0.12 + level * p.height * (coastal ? 0.7 + seeded(i, 13) * 0.34 : 0.82 + seeded(i, 13) * 0.2);
    outward.set(Math.cos(phase), profile === "fern" ? 0.08 : 0.18 + level * 0.22, Math.sin(phase)).normalize();
    tangent.set(-Math.sin(phase), 0, Math.cos(phase)).normalize();
    // Every third leaf drops to an inner shell with a dimmer shade — depth
    // between the core hull and the outer silhouette instead of one thin skin.
    const inner = profile !== "fern" && i % 3 === 2;
    const shellScale = inner ? shell * 0.58 : shell;
    center.set(
      Math.cos(phase) * p.radiusX * shellScale,
      y,
      Math.sin(phase) * p.radiusZ * shellScale
    );
    const variation = 0.82 + seeded(i, 17) * 0.34;
    pushLeaf(
      positions,
      colors,
      flex,
      blooms,
      bark,
      indices,
      center,
      outward,
      tangent,
      p.leafLength * variation,
      p.leafWidth * (0.84 + seeded(i, 19) * 0.3),
      Math.min(1, 0.28 + level * 0.78),
      phase,
      !inner && i % p.bloomEvery === 0 && level > 0.42 ? 1 : 0,
      inner ? 0.78 : 1
    );
  }

  if (p.core) pushCoreHull(positions, colors, flex, blooms, bark, indices, p);

  // Ground skirt: a low outward ring of slightly larger leaves that seats the
  // bush on the terrain instead of hovering above its own shadow.
  for (let i = 0; i < (p.skirt ?? 0); i++) {
    const phase = i * 2.399963 + 1.31 + seeded(i, 23) * 0.5;
    const shell = 0.62 + seeded(i, 27) * 0.14;
    outward.set(Math.cos(phase), 0.22, Math.sin(phase)).normalize();
    tangent.set(-Math.sin(phase), 0, Math.cos(phase));
    center.set(
      Math.cos(phase) * p.radiusX * shell,
      0.14 + seeded(i, 29) * 0.1,
      Math.sin(phase) * p.radiusZ * shell
    );
    pushLeaf(
      positions,
      colors,
      flex,
      blooms,
      bark,
      indices,
      center,
      outward,
      tangent,
      p.leafLength * (0.9 + seeded(i, 31) * 0.22),
      p.leafWidth * (0.95 + seeded(i, 33) * 0.2),
      0.22,
      phase,
      0,
      0.92
    );
  }

  if (profile === "fern") {
    const sides = 7;
    const base = positions.length / 3;
    for (let ring = 0; ring < 2; ring++) {
      const y = ring * 0.94;
      const radius = ring === 0 ? 0.12 : 0.085;
      for (let side = 0; side < sides; side++) {
        const angle = (side / sides) * Math.PI * 2;
        positions.push(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
        const shade = 0.58 + (side / sides) * 0.22;
        colors.push(shade, shade, shade);
        flex.push(0, 0);
        blooms.push(0);
        bark.push(1);
      }
    }
    for (let side = 0; side < sides; side++) {
      const next = (side + 1) % sides;
      indices.push(base + side, base + next, base + sides + next, base + side, base + sides + next, base + sides + side);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  // Normalized bytes preserve the leaf/stem shading ramp while cutting this
  // immutable vertex channel from 12 bytes to 3 bytes per vertex.
  geometry.setAttribute(
    "color",
    new THREE.Uint8BufferAttribute(colors.map((value) => Math.round(Math.min(1, value) * 255)), 3, true)
  );
  // Keep the whole shrub pipeline at eight vertex buffers on baseline WebGPU:
  // xy = flex/phase, z = bloom mask, w = bark mask. Three separate attributes
  // pushed MeshStandardNodeMaterial past maxVertexBuffers on common devices.
  const vertexData = new Float32Array(blooms.length * 4);
  for (let i = 0; i < blooms.length; i++) {
    vertexData[i * 4] = flex[i * 2];
    vertexData[i * 4 + 1] = flex[i * 2 + 1];
    vertexData[i * 4 + 2] = blooms[i];
    vertexData[i * 4 + 3] = bark[i];
  }
  geometry.setAttribute("aShrubVertex", new THREE.Float32BufferAttribute(vertexData, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeShrubMaterial(): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide;
  material.roughness = 0.9;
  material.metalness = 0;
  const shade: N = attribute("color", "vec3");
  const foliage: N = attribute("aShrubColor", "vec3");
  const bloom: N = attribute("aShrubBloom", "vec4");
  const vertex: N = attribute("aShrubVertex", "vec4");
  const bloomMask: N = vertex.z.mul(bloom.w);
  const barkMask: N = vertex.w;
  const leafColor: N = foliage.mul(shade);
  const botanicalColor: N = mix(leafColor, bloom.xyz, bloomMask);
  material.colorNode = mix(botanicalColor, color(0x5b4935).mul(shade), barkMask);
  material.emissiveNode = bloom.xyz.mul(bloomMask).mul(0.055);

  const data: N = attribute("aShrubAnchor", "vec4");
  const flex: N = vertex.xy;
  const anchorWorld: N = instanceAnchorWorld(data.xyz);
  const phaseOffset: N = vec3(flex.y.cos().mul(1.7), 0, flex.y.sin().mul(1.7));
  const sway: N = groundSway(anchorWorld.xz.add(phaseOffset.xz));
  const bendWorld: N = vec3(WIND_DIR.x, 0, WIND_DIR.z)
    .mul(sway)
    .mul(0.095)
    .mul(flex.x)
    .mul(data.w);
  material.positionNode = (positionLocal as N).add(worldOffsetToModelLocal(bendWorld));
  return material;
}

export function createAuthoredShrubPatch(
  placements: readonly AuthoredShrubPlacement[],
  options: { name: string; palettes: readonly AuthoredShrubPalette[] }
): AuthoredShrubPatch {
  const group = new THREE.Group();
  group.name = options.name;
  const material = makeShrubMaterial();
  const dummy = new THREE.Object3D();
  const foliageA = new THREE.Color();
  const foliageB = new THREE.Color();
  const foliage = new THREE.Color();
  const bloom = new THREE.Color();
  let triangles = 0;
  let draws = 0;

  const byProfile = new Map<AuthoredShrubProfile, AuthoredShrubPlacement[]>();
  for (const placement of placements) {
    const profile = placement.profile ?? "natural";
    const list = byProfile.get(profile);
    if (list) list.push(placement);
    else byProfile.set(profile, [placement]);
  }

  for (const [profile, list] of byProfile) {
    const geometry = makeLeafSprayGeometry(profile);
    const mesh = new THREE.InstancedMesh(geometry, material, list.length);
    mesh.name = `${options.name}_${profile}`;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    const colorAttr = new THREE.StorageInstancedBufferAttribute(list.length, 3);
    const bloomAttr = new THREE.StorageInstancedBufferAttribute(list.length, 4);
    const anchorAttr = new THREE.StorageInstancedBufferAttribute(list.length, 4);
    colorAttr.setUsage(THREE.StaticDrawUsage);
    bloomAttr.setUsage(THREE.StaticDrawUsage);
    anchorAttr.setUsage(THREE.StaticDrawUsage);
    geometry.setAttribute("aShrubColor", colorAttr);
    geometry.setAttribute("aShrubBloom", bloomAttr);
    geometry.setAttribute("aShrubAnchor", anchorAttr);
    const colorArray = colorAttr.array as Float32Array;
    const bloomArray = bloomAttr.array as Float32Array;
    const anchorArray = anchorAttr.array as Float32Array;

    list.forEach((placement, index) => {
      const palette = options.palettes[placement.palette] ?? options.palettes[0] ?? {
        foliageA: 0x315b2d,
        foliageB: 0x547d3b
      };
      const tint = placement.tint ?? seeded(index, placement.palette + 31);
      foliageA.setHex(palette.foliageA);
      foliageB.setHex(palette.foliageB);
      foliage.copy(foliageA).lerp(foliageB, tint);
      const ci = index * 3;
      colorArray[ci] = foliage.r;
      colorArray[ci + 1] = foliage.g;
      colorArray[ci + 2] = foliage.b;

      const blooms = palette.blooms ?? [];
      const bloomChance = palette.bloomChance ?? (blooms.length ? 0.45 : 0);
      const blooming = blooms.length > 0 && tint > 1 - bloomChance;
      bloom.setHex(blooming ? blooms[Math.floor(tint * 97) % blooms.length] : palette.foliageB);
      const bi = index * 4;
      bloomArray[bi] = bloom.r;
      bloomArray[bi + 1] = bloom.g;
      bloomArray[bi + 2] = bloom.b;
      bloomArray[bi + 3] = blooming ? 1 : 0;

      dummy.position.set(placement.x, placement.y, placement.z);
      dummy.rotation.set(0, placement.yaw, 0);
      dummy.scale.setScalar(placement.scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
      const ai = index * 4;
      anchorArray[ai] = placement.x;
      anchorArray[ai + 1] = placement.y;
      anchorArray[ai + 2] = placement.z;
      anchorArray[ai + 3] = placement.wind ?? PROFILES[profile].wind;
    });
    mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
    bloomAttr.needsUpdate = true;
    anchorAttr.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    group.add(mesh);
    triangles += ((geometry.index?.count ?? geometry.getAttribute("position").count) / 3) * list.length;
    draws++;
  }

  return {
    group,
    stats: { instances: placements.length, draws, triangles },
    dispose() {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      material.dispose();
      group.removeFromParent();
      group.clear();
    }
  };
}
