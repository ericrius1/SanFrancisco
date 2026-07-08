// Low-poly procedural trees for the botanical garden, derived from the
// threejs-procedural-vegetation skill's structured growth system (species
// table → queued branch growth → oriented rings with a seam → terminal
// continuations + stratified/permuted lateral children → leaf cards with
// rounded normals). Budgets are deliberately tiny (mobile-tier sections/
// segments/leaf counts) because hundreds of instances share each compiled
// geometry; identity comes from the species table, not per-tree detail.
//
// Rendering adaptations vs the skill reference (intentional divergences):
// - vertex colours instead of bark/leaf textures (no alpha cards);
// - no wind shader — geometry is static to keep RL capture frames cheap;
// - one compiled geometry per species, instanced via InstancedMesh.

import * as THREE from "three/webgpu";

// Same generator as the skill examples (marsaglia-style pair).
class SeededRandom {
  private w: number;
  private z: number;
  constructor(seed: number) {
    this.w = (123456789 + seed) | 0;
    this.z = (987654321 - seed) | 0;
  }
  value(max = 1, min = 0): number {
    this.z = (36969 * (this.z & 65535) + (this.z >> 16)) | 0;
    this.w = (18000 * (this.w & 65535) + (this.w >> 16)) | 0;
    const n = (((this.z << 16) + (this.w & 65535)) >>> 0) / 4294967296;
    return min + (max - min) * n;
  }
  shuffledIndices(count: number): number[] {
    const v = Array.from({ length: count }, (_, i) => i);
    for (let i = count - 1; i > 0; i--) {
      const s = Math.floor(this.value() * (i + 1));
      [v[i], v[s]] = [v[s], v[i]];
    }
    return v;
  }
}

export type TreePreset = {
  seed: number;
  /** final branch level index (leaves emit at this level) */
  levels: number;
  branch: {
    length: number[];
    radius: number[];
    taper: number[];
    sections: number[];
    segments: number[];
    children: number[];
    start: number[];
    angle: number[];
    gnarliness: number[];
    twist: number[];
    forceStrength: number;
  };
  leaves: {
    count: number;
    start: number;
    angle: number;
    size: number;
    sizeVariance: number;
    doubleCard: boolean;
    /** card height = size * aspect (fronds >1, default 1) */
    aspect?: number;
  };
  barkColor: number;
  leafColor: number;
  leafColorB: number;
  /** 0..1 chance a card takes accentColor (e.g. magnolia blossoms) */
  accentChance?: number;
  accentColor?: number;
};

type Section = { origin: THREE.Vector3; orientation: THREE.Euler; radius: number };

type Buffers = { positions: number[]; normals: number[]; colors: number[]; indices: number[] };

function interpolateSection(sections: Section[], t: number): Section {
  const scaled = t * (sections.length - 1);
  const ia = Math.min(Math.floor(scaled), sections.length - 1);
  const ib = Math.min(ia + 1, sections.length - 1);
  const alpha = scaled - ia;
  const qA = new THREE.Quaternion().setFromEuler(sections[ia].orientation);
  const qB = new THREE.Quaternion().setFromEuler(sections[ib].orientation);
  return {
    origin: new THREE.Vector3().lerpVectors(sections[ia].origin, sections[ib].origin, alpha),
    radius: THREE.MathUtils.lerp(sections[ia].radius, sections[ib].radius, alpha),
    // contract quirk from the reference: slerp starts at B toward A
    orientation: new THREE.Euler().setFromQuaternion(qB.slerp(qA, alpha))
  };
}

function toGeometry(buf: Buffers): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(buf.positions, 3));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(buf.normals, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(buf.colors, 3));
  g.setIndex(buf.indices);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export type CompiledTree = {
  branchGeometry: THREE.BufferGeometry;
  leafGeometry: THREE.BufferGeometry;
  stats: { branchTriangles: number; leafCards: number };
};

export function compileTree(preset: TreePreset): CompiledTree {
  const random = new SeededRandom(preset.seed);
  const branches: Buffers = { positions: [], normals: [], colors: [], indices: [] };
  const leaves: Buffers = { positions: [], normals: [], colors: [], indices: [] };
  const bark = new THREE.Color(preset.barkColor);
  const leafA = new THREE.Color(preset.leafColor);
  const leafB = new THREE.Color(preset.leafColorB);
  const accent = new THREE.Color(preset.accentColor ?? preset.leafColor);
  const up = new THREE.Vector3(0, 1, 0);
  let leafCards = 0;

  type Job = {
    origin: THREE.Vector3;
    orientation: THREE.Euler;
    length: number;
    radius: number;
    level: number;
    sectionCount: number;
    segmentCount: number;
  };
  const jobs: Job[] = [
    {
      origin: new THREE.Vector3(),
      orientation: new THREE.Euler(),
      length: preset.branch.length[0],
      radius: preset.branch.radius[0],
      level: 0,
      sectionCount: preset.branch.sections[0],
      segmentCount: preset.branch.segments[0]
    }
  ];

  function emitLeaf(origin: THREE.Vector3, orientation: THREE.Euler) {
    const size = preset.leaves.size * (1 + random.value(preset.leaves.sizeVariance, -preset.leaves.sizeVariance));
    const height = size * (preset.leaves.aspect ?? 1);
    const isAccent = (preset.accentChance ?? 0) > 0 && random.value() < (preset.accentChance ?? 0);
    const mix = random.value();
    const color = isAccent ? accent : leafA.clone().lerp(leafB, mix);
    const rotations = preset.leaves.doubleCard ? [0, Math.PI * 0.5] : [0];
    const cardNormal = new THREE.Vector3(0, 0, 1).applyEuler(orientation).normalize();
    for (const cardRotation of rotations) {
      const base = leaves.positions.length / 3;
      const local = [
        new THREE.Vector3(-size * 0.5, height, 0),
        new THREE.Vector3(-size * 0.5, 0, 0),
        new THREE.Vector3(size * 0.5, 0, 0),
        new THREE.Vector3(size * 0.5, height, 0)
      ];
      for (const lv of local) {
        const v = lv.applyAxisAngle(up, cardRotation).applyEuler(orientation).add(origin);
        // rounded normal: card normal + direction from leaf origin (crown-volume shading)
        const n = cardNormal.clone().add(v.clone().sub(origin)).normalize();
        leaves.positions.push(v.x, v.y, v.z);
        leaves.normals.push(n.x, n.y, n.z);
        leaves.colors.push(color.r, color.g, color.b);
      }
      leaves.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      leafCards++;
    }
  }

  function emitLeavesAlongBranch(sections: Section[]) {
    const count = preset.leaves.count;
    const radialOffset = random.value();
    const slots = random.shuffledIndices(count);
    const step = (1 - preset.leaves.start) / count;
    for (let slot = 0; slot < count; slot++) {
      const along = preset.leaves.start + (slot + random.value()) * step;
      const parent = interpolateSection(sections, along);
      const azimuth = Math.PI * 2 * (radialOffset + (slots[slot] + random.value(0.5, -0.5)) / count);
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(preset.leaves.angle));
      const spin = new THREE.Quaternion().setFromAxisAngle(up, azimuth);
      const q = new THREE.Quaternion().setFromEuler(parent.orientation).multiply(spin.multiply(tilt));
      emitLeaf(parent.origin, new THREE.Euler().setFromQuaternion(q));
    }
  }

  function enqueueLateralChildren(parentLevel: number, sections: Section[]) {
    const level = parentLevel + 1;
    const count = preset.branch.children[parentLevel];
    if (count <= 0) return;
    const start = preset.branch.start[level];
    const radialOffset = random.value();
    const slots = random.shuffledIndices(count);
    const step = (1 - start) / count;
    for (let slot = 0; slot < count; slot++) {
      const along = start + (slot + random.value()) * step;
      const parent = interpolateSection(sections, along);
      const azimuth = Math.PI * 2 * (radialOffset + (slots[slot] + random.value(0.5, -0.5)) / count);
      const emergence = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.degToRad(preset.branch.angle[level]));
      const spin = new THREE.Quaternion().setFromAxisAngle(up, azimuth);
      const q = new THREE.Quaternion().setFromEuler(parent.orientation).multiply(spin.multiply(emergence));
      jobs.push({
        origin: parent.origin,
        orientation: new THREE.Euler().setFromQuaternion(q),
        length: preset.branch.length[level],
        radius: preset.branch.radius[level] * parent.radius,
        level,
        sectionCount: preset.branch.sections[level],
        segmentCount: preset.branch.segments[level]
      });
    }
  }

  while (jobs.length > 0) {
    const branch = jobs.shift()!;
    const indexOffset = branches.positions.length / 3;
    const orientation = branch.orientation.clone();
    const origin = branch.origin.clone();
    const sectionLength = branch.length / branch.sectionCount;
    const sections: Section[] = [];
    // slight per-level bark shade variation stands in for a texture
    const shade = 1 - branch.level * 0.08;

    for (let s = 0; s <= branch.sectionCount; s++) {
      let sectionRadius = branch.radius * (1 - preset.branch.taper[branch.level] * (s / branch.sectionCount));
      if (s === branch.sectionCount && branch.level === preset.levels) sectionRadius = 0.001;

      let firstVertex: THREE.Vector3 | null = null;
      let firstNormal: THREE.Vector3 | null = null;
      for (let r = 0; r < branch.segmentCount; r++) {
        const angle = (Math.PI * 2 * r) / branch.segmentCount;
        const radial = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
        const vertex = radial.clone().multiplyScalar(sectionRadius).applyEuler(orientation).add(origin);
        const normal = radial.clone().applyEuler(orientation).normalize();
        if (r === 0) {
          firstVertex = vertex.clone();
          firstNormal = normal.clone();
        }
        branches.positions.push(vertex.x, vertex.y, vertex.z);
        branches.normals.push(normal.x, normal.y, normal.z);
        branches.colors.push(bark.r * shade, bark.g * shade, bark.b * shade);
      }
      // duplicated seam vertex keeps ring topology consistent with the contract
      branches.positions.push(firstVertex!.x, firstVertex!.y, firstVertex!.z);
      branches.normals.push(firstNormal!.x, firstNormal!.y, firstNormal!.z);
      branches.colors.push(bark.r * shade, bark.g * shade, bark.b * shade);

      sections.push({ origin: origin.clone(), orientation: orientation.clone(), radius: sectionRadius });
      origin.add(new THREE.Vector3(0, sectionLength, 0).applyEuler(orientation));

      const safeRadius = Math.max(sectionRadius, 0.001);
      const gnarl = Math.max(1, 1 / Math.sqrt(safeRadius)) * preset.branch.gnarliness[branch.level];
      orientation.x += random.value(gnarl, -gnarl);
      orientation.z += random.value(gnarl, -gnarl);

      const q = new THREE.Quaternion().setFromEuler(orientation);
      q.multiply(new THREE.Quaternion().setFromAxisAngle(up, preset.branch.twist[branch.level]));
      const sectionUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const axis = new THREE.Vector3().crossVectors(sectionUp, up);
      const sine = axis.length();
      if (sine > 1e-6) {
        axis.divideScalar(sine);
        const fullAngle = Math.atan2(sine, sectionUp.dot(up));
        const step = preset.branch.forceStrength / safeRadius;
        q.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.clamp(step, -fullAngle, fullAngle)));
      }
      orientation.setFromQuaternion(q);
    }

    const ringSize = branch.segmentCount + 1;
    for (let s = 0; s < branch.sectionCount; s++) {
      for (let r = 0; r < branch.segmentCount; r++) {
        const a = indexOffset + s * ringSize + r;
        const b = a + 1;
        const c = a + ringSize;
        branches.indices.push(a, c, b, b, c, c + 1);
      }
    }

    const finalSection = sections[sections.length - 1];
    if (branch.level < preset.levels) {
      // terminal continuation: inherits tip origin/orientation/radius and the
      // parent's section/segment counts (contract §2)
      jobs.push({
        origin: finalSection.origin,
        orientation: finalSection.orientation,
        length: preset.branch.length[branch.level + 1],
        radius: finalSection.radius,
        level: branch.level + 1,
        sectionCount: branch.sectionCount,
        segmentCount: branch.segmentCount
      });
      enqueueLateralChildren(branch.level, sections);
    } else {
      emitLeaf(finalSection.origin, finalSection.orientation);
      emitLeavesAlongBranch(sections);
    }
  }

  return {
    branchGeometry: toGeometry(branches),
    leafGeometry: toGeometry(leaves),
    stats: { branchTriangles: branches.indices.length / 3, leafCards }
  };
}

// --- species presets (indices match GARDEN_SPECIES ids in src/sim) -------------
//
// Budgets are "hero tier": ~1.5–6k triangles per compiled species. Every
// instance shares the compiled geometry, so the whole garden stays a handful
// of draw calls — richness comes from branch levels + leaf counts, not from
// per-tree uniqueness.

export const GARDEN_TREE_PRESETS: TreePreset[] = [
  // 0 coast redwood: tall, straight, dense short horizontal laterals
  {
    seed: 4101,
    levels: 2,
    branch: {
      length: [16, 3.2, 2.0],
      radius: [0.5, 0.38, 0.55],
      taper: [0.6, 0.7, 0.7],
      sections: [10, 4, 2],
      segments: [7, 5, 3],
      children: [13, 3, 0],
      start: [0, 0.34, 0.12],
      angle: [0, 86, 60],
      gnarliness: [0.012, 0.06, 0.05],
      twist: [0.03, 0, 0],
      forceStrength: 0.025
    },
    leaves: { count: 9, start: 0, angle: 62, size: 1.35, sizeVariance: 0.4, doubleCard: true },
    barkColor: 0x6e3f2a,
    leafColor: 0x1d4529,
    leafColorB: 0x2f5f38
  },
  // 1 magnolia: low spreading crown, glossy leaves, heavy pink blossom set
  {
    seed: 4202,
    levels: 2,
    branch: {
      length: [4.6, 3.8, 2.5],
      radius: [0.32, 0.55, 0.6],
      taper: [0.6, 0.7, 0.7],
      sections: [5, 4, 3],
      segments: [7, 5, 4],
      children: [6, 4, 0],
      start: [0, 0.22, 0.18],
      angle: [0, 55, 52],
      gnarliness: [0.05, 0.14, 0.1],
      twist: [0.06, -0.04, 0],
      forceStrength: 0.012
    },
    leaves: { count: 18, start: 0.05, angle: 48, size: 1.15, sizeVariance: 0.45, doubleCard: true },
    barkColor: 0x8a8072,
    leafColor: 0x2f5c2e,
    leafColorB: 0x4d7d3c,
    accentChance: 0.45,
    accentColor: 0xe3a8c8
  },
  // 2 monterey cypress: leaning, gnarled, broad wind-sculpted canopy
  {
    seed: 4303,
    levels: 2,
    branch: {
      length: [5.8, 4.4, 2.8],
      radius: [0.4, 0.5, 0.55],
      taper: [0.65, 0.7, 0.7],
      sections: [6, 4, 2],
      segments: [7, 5, 3],
      children: [6, 4, 0],
      start: [0, 0.3, 0.2],
      angle: [0, 62, 50],
      gnarliness: [0.07, 0.2, 0.14],
      twist: [0.09, -0.06, 0],
      forceStrength: 0.006
    },
    leaves: { count: 16, start: 0, angle: 66, size: 1.5, sizeVariance: 0.35, doubleCard: true },
    barkColor: 0x5d4630,
    leafColor: 0x2c5233,
    leafColorB: 0x3f6a35
  },
  // 3 tree fern: single fibrous trunk, radial crown of long drooping fronds
  {
    seed: 4404,
    levels: 1,
    branch: {
      length: [2.8, 1.0],
      radius: [0.22, 0.5],
      taper: [0.25, 0.8],
      sections: [4, 2],
      segments: [6, 4],
      children: [0, 0],
      start: [0, 0],
      angle: [0, 0],
      gnarliness: [0.03, 0.04],
      twist: [0, 0],
      forceStrength: 0.015
    },
    leaves: { count: 13, start: 0.3, angle: 95, size: 1.0, sizeVariance: 0.25, doubleCard: false, aspect: 2.8 },
    barkColor: 0x4c3a26,
    leafColor: 0x3f7a33,
    leafColorB: 0x5c9440
  },
  // 4 coast live oak: three branch levels, wide gnarled crown, small dense leaves
  {
    seed: 4505,
    levels: 3,
    branch: {
      length: [3.2, 2.8, 2.2, 1.5],
      radius: [0.45, 0.6, 0.62, 0.6],
      taper: [0.5, 0.65, 0.7, 0.7],
      sections: [6, 4, 3, 2],
      segments: [8, 6, 4, 3],
      children: [4, 3, 3, 0],
      start: [0, 0.2, 0.15, 0.12],
      angle: [0, 58, 50, 46],
      gnarliness: [0.08, 0.18, 0.16, 0.12],
      twist: [0.08, -0.06, 0.05, 0],
      forceStrength: 0.004
    },
    leaves: { count: 12, start: 0.05, angle: 52, size: 1.0, sizeVariance: 0.5, doubleCard: true },
    barkColor: 0x4a3826,
    leafColor: 0x2d4f26,
    leafColorB: 0x486d2e
  },
  // 5 japanese maple: small, layered, red-orange foliage (moon-viewing garden)
  {
    seed: 4606,
    levels: 2,
    branch: {
      length: [2.2, 1.9, 1.4],
      radius: [0.24, 0.6, 0.65],
      taper: [0.55, 0.7, 0.7],
      sections: [4, 3, 2],
      segments: [6, 5, 4],
      children: [7, 3, 0],
      start: [0, 0.18, 0.15],
      angle: [0, 62, 55],
      gnarliness: [0.07, 0.15, 0.12],
      twist: [0.1, -0.07, 0],
      forceStrength: 0.003
    },
    leaves: { count: 15, start: 0.05, angle: 50, size: 0.8, sizeVariance: 0.4, doubleCard: true },
    barkColor: 0x574138,
    leafColor: 0xa63c2a,
    leafColorB: 0xc96a33,
    accentChance: 0.18,
    accentColor: 0xd9903f
  },
  // 6 eucalyptus: tall pale trunk, high sparse sage-green canopy (Australia)
  {
    seed: 4707,
    levels: 2,
    branch: {
      length: [11, 4.5, 2.8],
      radius: [0.38, 0.42, 0.55],
      taper: [0.55, 0.7, 0.7],
      sections: [8, 4, 2],
      segments: [7, 5, 3],
      children: [7, 3, 0],
      start: [0, 0.35, 0.15],
      angle: [0, 48, 52],
      gnarliness: [0.03, 0.12, 0.1],
      twist: [0.05, -0.04, 0],
      forceStrength: 0.015
    },
    leaves: { count: 12, start: 0, angle: 60, size: 1.3, sizeVariance: 0.4, doubleCard: true, aspect: 1.6 },
    barkColor: 0xc4b8a5,
    leafColor: 0x5a7150,
    leafColorB: 0x74886a
  },
  // 7 chilean wine palm: thick single trunk, crown of long arcing fronds
  {
    seed: 4808,
    levels: 1,
    branch: {
      length: [7.5, 1.2],
      radius: [0.35, 0.4],
      taper: [0.35, 0.6],
      sections: [6, 2],
      segments: [8, 5],
      children: [0, 0],
      start: [0, 0],
      angle: [0, 0],
      gnarliness: [0.015, 0.02],
      twist: [0, 0],
      forceStrength: 0.02
    },
    leaves: { count: 15, start: 0.1, angle: 105, size: 0.95, sizeVariance: 0.2, doubleCard: false, aspect: 3.2 },
    barkColor: 0x9a8d7a,
    leafColor: 0x3f6d33,
    leafColorB: 0x5d8a3f
  }
];
