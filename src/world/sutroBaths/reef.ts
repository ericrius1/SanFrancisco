import * as THREE from "three/webgpu";
import {
  Fn,
  attribute,
  cameraPosition,
  cos,
  float as floatRaw,
  fract,
  mix as mixRaw,
  normalLocal,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3 as vec3Raw,
  vec4 as vec4Raw
} from "three/tsl";
import { SUTRO_GROTTO, SUTRO_GROTTO_CENTRE } from "./layout";

/**
 * What is on the other side of the sunken gallery's windows.
 *
 * A shelf of the Pacific floor thirty metres down: boulders, a kelp forest
 * standing up past the glass, four species of coral, three schools of fish, and
 * the light coming down in bars from a surface nobody in this room can see.
 *
 * UNLIT, ON PURPOSE. Nothing here takes a scene light. The room is under thirty
 * metres of hill, so the sun that would reach these materials is whatever the
 * pocket's held evening happens to be doing on the other side of a cliff —
 * which is to say, wrong, and worse, changing. Every material is a
 * MeshBasicNodeMaterial carrying its own shading instead: a fixed downward key
 * off the vertex normal, a caustic dapple, a depth ramp that cools with the
 * water, and a Beer-ish fade into the water colour with distance. That is
 * cheaper than lit shading, it is stable, and it is how underwater art
 * direction is actually done.
 *
 * ONE DRAW PER SPECIES. Everything is merged: the school of two hundred fish is
 * one mesh whose vertex shader swims each fish along its own orbit from four
 * baked attributes, and the kelp forest is one mesh that sways the same way.
 * Nothing here updates from the CPU except two uniforms.
 */

type N = any;
const float = floatRaw as (...a: N[]) => N;
const vec3 = vec3Raw as (...a: N[]) => N;
const vec4 = vec4Raw as (...a: N[]) => N;
const mix = mixRaw as (...a: N[]) => N;

/** The colour everything dissolves into, and the backdrop's own mid tone. */
const WATER = /*@__PURE__*/ new THREE.Color(0x0d4152);
const WATER_DEEP = /*@__PURE__*/ new THREE.Color(0x02121b);
const WATER_HIGH = /*@__PURE__*/ new THREE.Color(0x1d7d92);

/** The shelf, in site-local metres, hanging off the room's glazed wall. */
const REEF = {
  nearX: SUTRO_GROTTO.glassFaceX - 1.4,
  farX: SUTRO_GROTTO.glassFaceX - 48,
  halfZ: 52,
  bedY: -32.6,
  bedRelief: 2.4,
  topY: -6.5,
  bottomY: -38
} as const;

const CZ = SUTRO_GROTTO_CENTRE.z;

/**
 * Nothing may cross the glass.
 *
 * Every placement below picks an x from the shelf and then grows something
 * around it — a 6 m boulder, a 7 m light shaft, a fish on a 26 m orbit — and
 * "the shelf starts 1.4 m outside the window" is a statement about CENTRES, not
 * about extents. Left unguarded, a wide shaft reaches four metres past the
 * glazed wall and hangs in the gallery as a sheet of grey haze, and the big
 * rockfish swim laps through the pictures.
 *
 * So placement is by CLEARANCE: `shelfX(random, margin)` returns a centre whose
 * own half-extent still leaves it `margin` clear of this line.
 */
const CLEAR_X = SUTRO_GROTTO.glassFaceX - 0.8;

/** Deterministic: the same reef every visit, on every machine. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A centre on the shelf for something `margin` metres across, biased toward the
 * glass by `bias` (>1 crowds the window, which is where the reef should be
 * thickest). Returns null when the thing is simply too big to fit clear.
 */
function shelfX(random: () => number, margin: number, bias = 1): number | null {
  const near = CLEAR_X - margin;
  const far = REEF.farX + margin;
  if (near <= far) return null;
  return near - Math.pow(random(), bias) * (near - far);
}

/** Rolling relief on the shelf, so nothing sits on a table. */
function bedHeight(x: number, z: number): number {
  return (
    REEF.bedY +
    Math.sin(x * 0.11 + 1.7) * REEF.bedRelief * 0.42 +
    Math.sin(z * 0.078 - 0.6) * REEF.bedRelief * 0.5 +
    Math.sin((x + z) * 0.045 + 2.3) * REEF.bedRelief * 0.35
  );
}

// ---------------------------------------------------------------------------
// merged-geometry soup
// ---------------------------------------------------------------------------

type ExtraSpec = Record<string, { size: number; values: number[] }>;

class Soup {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];
  readonly extras = new Map<string, { size: number; data: number[] }>();
  parts = 0;

  /**
   * Append `source`, transformed by `matrix`, tinted `color`, and stamped with
   * one constant value per declared extra attribute — which is how a single
   * merged mesh ends up with two hundred independently swimming fish.
   */
  add(
    source: THREE.BufferGeometry,
    matrix: THREE.Matrix4,
    color: THREE.Color,
    extras?: ExtraSpec
  ): void {
    const positions = source.getAttribute("position");
    const normals = source.getAttribute("normal");
    const base = this.position.length / 3;
    const normalMatrix = new THREE.Matrix3().setFromMatrix4(matrix).invert().transpose();
    const point = new THREE.Vector3();
    const direction = new THREE.Vector3();
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions as THREE.BufferAttribute, i).applyMatrix4(matrix);
      this.position.push(point.x, point.y, point.z);
      if (normals) {
        direction
          .fromBufferAttribute(normals as THREE.BufferAttribute, i)
          .applyMatrix3(normalMatrix)
          .normalize();
        this.normal.push(direction.x, direction.y, direction.z);
      } else {
        this.normal.push(0, 1, 0);
      }
      this.color.push(color.r, color.g, color.b);
      if (extras) {
        for (const [name, spec] of Object.entries(extras)) {
          let slot = this.extras.get(name);
          if (!slot) {
            slot = { size: spec.size, data: [] };
            this.extras.set(name, slot);
          }
          for (let k = 0; k < spec.size; k++) slot.data.push(spec.values[k]);
        }
      }
    }
    const sourceIndex = source.getIndex();
    if (sourceIndex) {
      for (let i = 0; i < sourceIndex.count; i++) this.index.push(base + sourceIndex.getX(i));
    } else {
      for (let i = 0; i < positions.count; i++) this.index.push(base + i);
    }
    this.parts++;
  }

  build(name: string): THREE.BufferGeometry | null {
    if (this.index.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.name = name;
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.color, 3));
    for (const [attributeName, slot] of this.extras) {
      geometry.setAttribute(
        attributeName,
        new THREE.Float32BufferAttribute(slot.data, slot.size)
      );
    }
    geometry.setIndex(this.index);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

// ---------------------------------------------------------------------------
// shading
// ---------------------------------------------------------------------------

/**
 * The look, in one function. Every solid thing in the water runs through it:
 * a downward key, a caustic dapple that only touches upward faces, a cool-and-
 * darken ramp with depth, and the water's own extinction with distance.
 */
function seaShade(base: N, normal: N, uTime: N, glow: number): N {
  const up = normal.y.mul(0.5).add(0.5);
  const key = mix(float(0.2), float(1.05), pow(up, 1.35));
  const dapple = sin(positionWorld.x.mul(0.42).add(uTime.mul(0.55)))
    .mul(sin(positionWorld.z.mul(0.37).sub(uTime.mul(0.41))))
    .mul(0.5)
    .add(0.5);
  const lit = base.mul(key.add(dapple.mul(up).mul(0.42))).add(base.mul(glow));
  // Deeper is colder and darker: the red goes first, exactly as it does.
  const depth = smoothstep(float(REEF.topY), float(REEF.bottomY), positionWorld.y);
  const cooled = mix(lit, lit.mul(vec3(0.3, 0.62, 0.86)).mul(0.72), depth.mul(0.8));
  const distance = cameraPosition.distance(positionWorld);
  const haze = smoothstep(float(5), float(52), distance).mul(0.93);
  return mix(cooled, vec3(WATER.r, WATER.g, WATER.b), haze);
}

/** A solid reef material: vertex colour in, sea shading out. */
function seaMaterial(name: string, uTime: N, glow = 0): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({ name });
  material.colorNode = Fn(() => {
    const base = attribute("color", "vec3") as N;
    return vec4(seaShade(base, normalLocal as N, uTime, glow), 1);
  })() as N;
  return material;
}

/** Plants: the same shading, plus the sway their `aSway` attribute describes. */
function swayPositionNode(uTime: N): N {
  const sway = attribute("aSway", "vec4") as N;
  const height = saturate((positionLocal.y as N).sub(sway.y).mul(sway.z));
  const bend = pow(height, 1.45).mul(sway.w);
  const along = sin(uTime.mul(0.5).add(sway.x).add((positionLocal.y as N).mul(0.14)));
  const across = cos(uTime.mul(0.37).add(sway.x.mul(1.7)));
  return (positionLocal as N).add(vec3(along.mul(bend), 0, across.mul(bend).mul(0.72)));
}

// ---------------------------------------------------------------------------
// species
// ---------------------------------------------------------------------------

/** A sea fan: a flat rounded plate on a short stem, always double sided. */
function fanGeometry(): THREE.BufferGeometry {
  const plate = new THREE.CircleGeometry(1, 14, Math.PI * 0.08, Math.PI * 0.84);
  plate.translate(0, 0.05, 0);
  plate.rotateX(-Math.PI / 2);
  plate.rotateX(Math.PI / 2);
  return plate;
}

/** Staghorn: a trunk that forks twice. Built once, instanced by the soup. */
function staghornGeometry(seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const soup = new Soup();
  const white = new THREE.Color(1, 1, 1);
  const branch = (
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    length: number,
    radius: number,
    depth: number
  ): void => {
    const geometry = new THREE.CylinderGeometry(radius * 0.55, radius, length, 6, 1, false);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      direction.clone().normalize()
    );
    const centre = origin.clone().addScaledVector(direction, length * 0.5);
    matrix.compose(centre, quaternion, new THREE.Vector3(1, 1, 1));
    soup.add(geometry, matrix, white);
    geometry.dispose();
    if (depth === 0) return;
    const tip = origin.clone().addScaledVector(direction, length);
    const forks = depth > 1 ? 3 : 2;
    for (let i = 0; i < forks; i++) {
      const angle = (i / forks) * Math.PI * 2 + random() * 1.4;
      const lean = 0.42 + random() * 0.4;
      const next = new THREE.Vector3(
        direction.x + Math.cos(angle) * lean,
        direction.y * 0.86,
        direction.z + Math.sin(angle) * lean
      ).normalize();
      branch(tip, next, length * (0.62 + random() * 0.14), radius * 0.62, depth - 1);
    }
  };
  branch(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0), 0.9, 0.12, 2);
  return soup.build("staghorn") ?? new THREE.BufferGeometry();
}

/** Brain coral: a squashed, faceted dome. */
function brainGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.SphereGeometry(1, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.62);
  geometry.scale(1, 0.68, 1);
  return geometry;
}

/** Tube sponges: a clump of open chimneys. */
function tubeGeometry(seed: number): THREE.BufferGeometry {
  const random = rng(seed);
  const soup = new Soup();
  const white = new THREE.Color(1, 1, 1);
  const count = 5 + Math.floor(random() * 4);
  for (let i = 0; i < count; i++) {
    const height = 0.6 + random() * 1.5;
    const radius = 0.12 + random() * 0.13;
    const geometry = new THREE.CylinderGeometry(radius, radius * 0.82, height, 8, 1, true);
    const angle = random() * Math.PI * 2;
    const spread = random() * 0.45;
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(Math.cos(angle) * spread, height * 0.5, Math.sin(angle) * spread),
      new THREE.Quaternion().setFromEuler(
        new THREE.Euler((random() - 0.5) * 0.3, random() * 3, (random() - 0.5) * 0.3)
      ),
      new THREE.Vector3(1, 1, 1)
    );
    soup.add(geometry, matrix, white);
    geometry.dispose();
  }
  return soup.build("tube_sponge") ?? new THREE.BufferGeometry();
}

/**
 * One fish, nose at +x and tail at -x so the vertex shader can find the tail by
 * its own local x. Ten triangles: a faceted body, a tail fin and a dorsal.
 */
function fishGeometry(): THREE.BufferGeometry {
  const v: number[] = [];
  const push = (a: number[], b: number[], c: number[]): void => {
    v.push(...a, ...b, ...c);
  };
  const nose = [0.5, 0, 0];
  const stern = [-0.34, 0, 0];
  const top = [0.06, 0.15, 0];
  const belly = [0.06, -0.12, 0];
  const left = [0.06, 0.01, 0.1];
  const right = [0.06, 0.01, -0.1];
  push(nose, top, left);
  push(nose, left, belly);
  push(nose, belly, right);
  push(nose, right, top);
  push(stern, left, top);
  push(stern, belly, left);
  push(stern, right, belly);
  push(stern, top, right);
  // Tail fin and dorsal, both flat and double sided by the material.
  push(stern, [-0.52, 0.2, 0], [-0.5, -0.17, 0]);
  push([0.1, 0.15, 0], [-0.08, 0.29, 0], [-0.2, 0.13, 0]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------------
// the reef
// ---------------------------------------------------------------------------

export type SutroReef = {
  group: THREE.Group;
  update(time: number): void;
  readonly stats: { draws: number; triangles: number; fish: number; plants: number };
  dispose(): void;
};

export function createSutroReef(): SutroReef {
  const group = new THREE.Group();
  group.name = "sutro_grotto_reef";
  const uTime = uniform(0) as N;

  const meshes: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];

  const attach = (
    geometry: THREE.BufferGeometry | null,
    material: THREE.Material,
    name: string,
    doubleSided = false
  ): void => {
    if (!geometry) {
      material.dispose();
      return;
    }
    if (doubleSided) material.side = THREE.DoubleSide;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // Everything here lives in one bounded shelf that is either wholly visible
    // through the windows or wholly hidden with the room; per-mesh culling only
    // ever throws away all of it, so let the depth buffer do the work.
    mesh.frustumCulled = false;
    meshes.push(mesh);
    geometries.push(geometry);
    materials.push(material);
    group.add(mesh);
  };

  // ---- the water itself, as a backdrop -----------------------------------
  // An inverted box round the whole shelf. Distant reef fades into exactly its
  // mid tone (see seaShade), so there is never a visible edge to the world.
  // Its near face stops exactly at the glass. Reaching past it would put the
  // backdrop's own wall inside the room, in front of the windows it is meant to
  // be seen through.
  const shellFarX = REEF.farX - 22;
  const shellGeometry = new THREE.BoxGeometry(
    REEF.nearX - shellFarX,
    REEF.topY - REEF.bottomY + 10,
    REEF.halfZ * 2 + 20
  );
  shellGeometry.translate(
    (REEF.nearX + shellFarX) * 0.5,
    (REEF.topY + REEF.bottomY) * 0.5,
    CZ
  );
  const shellMaterial = new THREE.MeshBasicNodeMaterial({ name: "sutro_reef_water" });
  shellMaterial.side = THREE.BackSide;
  shellMaterial.colorNode = Fn(() => {
    const height = smoothstep(float(REEF.bottomY), float(REEF.topY), positionWorld.y as N);
    const body = mix(
      vec3(WATER_DEEP.r, WATER_DEEP.g, WATER_DEEP.b),
      vec3(WATER_HIGH.r, WATER_HIGH.g, WATER_HIGH.b),
      pow(height, 1.7)
    );
    // A slow, wide shimmer where the light is coming from.
    const shimmer = sin(positionWorld.x.mul(0.05).add(uTime.mul(0.18)))
      .mul(sin(positionWorld.z.mul(0.043).sub(uTime.mul(0.12))))
      .mul(0.5)
      .add(0.5)
      .mul(pow(height, 3))
      .mul(0.16);
    return vec4(body.add(vec3(0.16, 0.4, 0.44).mul(shimmer)), 1);
  })() as N;
  attach(shellGeometry, shellMaterial, "sutro_reef_water");

  // ---- the shelf ---------------------------------------------------------
  const bedSegmentsX = 40;
  const bedSegmentsZ = 60;
  const bedGeometry = new THREE.PlaneGeometry(
    Math.abs(REEF.nearX - REEF.farX),
    REEF.halfZ * 2,
    bedSegmentsX,
    bedSegmentsZ
  );
  bedGeometry.rotateX(-Math.PI / 2);
  bedGeometry.translate((REEF.nearX + REEF.farX) * 0.5, 0, CZ);
  {
    const positions = bedGeometry.getAttribute("position") as THREE.BufferAttribute;
    const colors = new Float32Array(positions.count * 3);
    const sand = new THREE.Color(0x5c6a5e);
    const silt = new THREE.Color(0x2f3f42);
    const tone = new THREE.Color();
    for (let i = 0; i < positions.count; i++) {
      const x = positions.getX(i);
      const z = positions.getZ(i);
      positions.setY(i, bedHeight(x, z));
      const patch = Math.sin(x * 0.19 + 0.4) * Math.sin(z * 0.16 - 1.1) * 0.5 + 0.5;
      tone.copy(silt).lerp(sand, 0.25 + patch * 0.6);
      colors[i * 3] = tone.r;
      colors[i * 3 + 1] = tone.g;
      colors[i * 3 + 2] = tone.b;
    }
    positions.needsUpdate = true;
    bedGeometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    bedGeometry.computeVertexNormals();
  }
  attach(bedGeometry, seaMaterial("sutro_reef_bed", uTime, 0.02), "sutro_reef_bed");

  // ---- boulders ----------------------------------------------------------
  const rockSoup = new Soup();
  {
    const random = rng(0x5e4b0c);
    const shapes = [0, 1, 2].map((i) => new THREE.IcosahedronGeometry(1, i === 2 ? 1 : 0));
    const stone = new THREE.Color();
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 120; i++) {
      const size = 0.9 + Math.pow(random(), 2.1) * 5.2;
      const x = shelfX(random, size * 1.1);
      if (x === null) continue;
      const z = CZ + (random() * 2 - 1) * REEF.halfZ;
      stone.setHSL(0.36 + random() * 0.1, 0.12 + random() * 0.1, 0.14 + random() * 0.12);
      matrix.compose(
        new THREE.Vector3(x, bedHeight(x, z) + size * 0.24, z),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler(random() * 3, random() * 6, random() * 3)
        ),
        new THREE.Vector3(size, size * (0.5 + random() * 0.4), size * (0.7 + random() * 0.5))
      );
      rockSoup.add(shapes[Math.floor(random() * shapes.length)], matrix, stone);
    }
    for (const shape of shapes) shape.dispose();
  }
  attach(rockSoup.build("sutro_reef_rocks"), seaMaterial("sutro_reef_rocks", uTime), "sutro_reef_rocks");

  // ---- coral -------------------------------------------------------------
  const coralSpecies: {
    id: string;
    geometry: THREE.BufferGeometry;
    count: number;
    hue: [number, number];
    scale: [number, number];
    sway: number;
    glow: number;
    doubleSided: boolean;
  }[] = [
    {
      id: "fan",
      geometry: fanGeometry(),
      count: 90,
      hue: [0.93, 0.06],
      scale: [0.7, 2.4],
      sway: 0.26,
      glow: 0.1,
      doubleSided: true
    },
    {
      id: "staghorn",
      geometry: staghornGeometry(0x51a3),
      count: 100,
      hue: [0.72, 0.82],
      scale: [0.55, 1.5],
      sway: 0.12,
      glow: 0.12,
      doubleSided: false
    },
    {
      id: "brain",
      geometry: brainGeometry(),
      count: 70,
      hue: [0.12, 0.2],
      scale: [0.5, 1.5],
      sway: 0,
      glow: 0.08,
      doubleSided: false
    },
    {
      id: "sponge",
      geometry: tubeGeometry(0x9f31),
      count: 80,
      hue: [0.0, 0.06],
      scale: [0.6, 1.7],
      sway: 0.1,
      glow: 0.14,
      doubleSided: true
    }
  ];

  let plants = 0;
  for (const species of coralSpecies) {
    const soup = new Soup();
    const random = rng(0x1000 + species.id.length * 977);
    const tint = new THREE.Color();
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < species.count; i++) {
      const scale = species.scale[0] + random() * (species.scale[1] - species.scale[0]);
      // Bias toward the glass: the reef should be thickest right at the window.
      const x = shelfX(random, scale * 2.2 + species.sway * scale, 1.7);
      if (x === null) continue;
      const z = CZ + (random() * 2 - 1) * REEF.halfZ * 0.92;
      const baseY = bedHeight(x, z);
      tint.setHSL(
        (species.hue[0] + random() * (species.hue[1] - species.hue[0]) + 1) % 1,
        0.55 + random() * 0.35,
        0.4 + random() * 0.22
      );
      matrix.compose(
        new THREE.Vector3(x, baseY, z),
        new THREE.Quaternion().setFromEuler(
          new THREE.Euler((random() - 0.5) * 0.3, random() * 6.28, (random() - 0.5) * 0.3)
        ),
        new THREE.Vector3(scale, scale, scale)
      );
      soup.add(species.geometry, matrix, tint, {
        aSway: {
          size: 4,
          values: [random() * 6.28, baseY, 1 / Math.max(0.6, scale * 1.6), species.sway * scale]
        }
      });
      plants++;
    }
    const material = seaMaterial(`sutro_reef_coral_${species.id}`, uTime, species.glow);
    if (species.sway > 0) material.positionNode = swayPositionNode(uTime);
    attach(
      soup.build(`sutro_reef_coral_${species.id}`),
      material,
      `sutro_reef_coral_${species.id}`,
      species.doubleSided
    );
    species.geometry.dispose();
  }

  // ---- the kelp forest ---------------------------------------------------
  // The hero: eighteen-metre stipes standing up past the windows, so the room
  // looks out INTO something rather than at a diorama on the floor.
  {
    const soup = new Soup();
    const random = rng(0x4b17);
    const blade = new THREE.PlaneGeometry(1, 1, 1, 10);
    blade.translate(0, 0.5, 0);
    const tint = new THREE.Color();
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 150; i++) {
      const height = 8 + random() * 13;
      const width = 0.5 + random() * 0.7;
      // The stipes sway up to 2 m off vertical, so that goes in the clearance.
      const x = shelfX(random, width + 2.4, 1.5);
      if (x === null) continue;
      const z = CZ + (random() * 2 - 1) * REEF.halfZ * 0.9;
      const baseY = bedHeight(x, z);
      tint.setHSL(0.22 + random() * 0.09, 0.5 + random() * 0.25, 0.16 + random() * 0.14);
      matrix.compose(
        new THREE.Vector3(x, baseY, z),
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * 6.28),
        new THREE.Vector3(width, height, width)
      );
      soup.add(blade, matrix, tint, {
        aSway: { size: 4, values: [random() * 6.28, baseY, 1 / height, 0.9 + random() * 1.1] }
      });
      plants++;
    }
    blade.dispose();
    const material = seaMaterial("sutro_reef_kelp", uTime, 0.06);
    material.positionNode = swayPositionNode(uTime);
    attach(soup.build("sutro_reef_kelp"), material, "sutro_reef_kelp", true);
  }

  // ---- the schools -------------------------------------------------------
  const fishBase = fishGeometry();
  const schools: {
    id: string;
    count: number;
    size: [number, number];
    radius: [number, number];
    speed: [number, number];
    height: [number, number];
    hue: [number, number];
    lightness: [number, number];
    glow: number;
  }[] = [
    {
      id: "silverside",
      count: 240,
      size: [0.16, 0.3],
      radius: [3, 13],
      speed: [0.28, 0.5],
      height: [-27, -13],
      hue: [0.52, 0.6],
      lightness: [0.55, 0.78],
      glow: 0.2
    },
    {
      id: "senorita",
      count: 80,
      size: [0.4, 0.7],
      radius: [5, 20],
      speed: [0.16, 0.3],
      height: [-30, -18],
      hue: [0.09, 0.15],
      lightness: [0.45, 0.62],
      glow: 0.16
    },
    {
      id: "rockfish",
      count: 14,
      size: [1.3, 2.4],
      radius: [9, 26],
      speed: [0.07, 0.13],
      height: [-31, -22],
      hue: [0.02, 0.07],
      lightness: [0.24, 0.36],
      glow: 0.08
    }
  ];

  let fish = 0;
  for (const school of schools) {
    const soup = new Soup();
    const random = rng(0x7700 + school.count);
    const tint = new THREE.Color();
    const identity = new THREE.Matrix4();
    for (let i = 0; i < school.count; i++) {
      const radius = school.radius[0] + random() * (school.radius[1] - school.radius[0]);
      // A fish is its ORBIT, not its body: a rockfish on a 26 m circle would
      // otherwise spend half of every lap swimming through the gallery.
      const centreX = shelfX(random, radius + school.size[1]);
      if (centreX === null) continue;
      const centreZ = CZ + (random() * 2 - 1) * (REEF.halfZ - radius - 4);
      const centreY = school.height[0] + random() * (school.height[1] - school.height[0]);
      const size = school.size[0] + random() * (school.size[1] - school.size[0]);
      const speed = (school.speed[0] + random() * (school.speed[1] - school.speed[0])) *
        (random() < 0.5 ? -1 : 1);
      tint.setHSL(
        school.hue[0] + random() * (school.hue[1] - school.hue[0]),
        0.3 + random() * 0.45,
        school.lightness[0] + random() * (school.lightness[1] - school.lightness[0])
      );
      soup.add(fishBase, identity, tint, {
        aFishA: { size: 4, values: [centreX, centreY, centreZ, radius] },
        aFishB: { size: 4, values: [random() * 6.28, speed, 0.25 + random() * 1.1, size] }
      });
      fish++;
    }
    const material = seaMaterial(`sutro_reef_fish_${school.id}`, uTime, school.glow);
    material.positionNode = Fn(() => {
      const a = attribute("aFishA", "vec4") as N;
      const b = attribute("aFishB", "vec4") as N;
      const angle = b.x.add(uTime.mul(b.y));
      // The orbit, and a slow independent rise and fall on top of it.
      const centre = vec3(a.x, a.y, a.z);
      const swim = centre.add(
        vec3(
          cos(angle).mul(a.w),
          sin(uTime.mul(b.y.mul(0.61)).add(b.x)).mul(b.z),
          sin(angle).mul(a.w)
        )
      );
      // Body basis from the orbit's own tangent, so a fish always faces the way
      // it is going without a scrap of CPU work.
      const forward = vec3(sin(angle).negate(), 0, cos(angle));
      const lateral = vec3(cos(angle).negate(), 0, sin(angle).negate());
      const local = (positionLocal as N).mul(b.w);
      // Tail beat: nothing at the nose, everything at the stern.
      const tail = smoothstep(float(0.1), float(-0.5), local.x.div(b.w));
      const beat = sin(uTime.mul(b.y.abs().mul(26)).add(b.x.mul(3))).mul(tail).mul(b.w.mul(0.42));
      return swim
        .add(forward.mul(local.x))
        .add(vec3(0, local.y, 0))
        .add(lateral.mul(local.z.add(beat)));
    })() as N;
    attach(soup.build(`sutro_reef_fish_${school.id}`), material, `sutro_reef_fish_${school.id}`, true);
  }
  fishBase.dispose();

  // ---- light coming down -------------------------------------------------
  {
    const soup = new Soup();
    const random = rng(0x2c9a);
    const white = new THREE.Color(1, 1, 1);
    const blade = new THREE.PlaneGeometry(1, 1, 1, 1);
    blade.translate(0, -0.5, 0);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 26; i++) {
      const width = 1.6 + random() * 6;
      const drop = 16 + random() * 14;
      // Crossed blades, so the extent is the full half-width in every direction.
      const x = shelfX(random, width * 0.5 + 0.5);
      if (x === null) continue;
      const z = CZ + (random() * 2 - 1) * REEF.halfZ * 0.85;
      // Two crossed blades so a shaft never disappears when seen edge-on.
      for (const turn of [0, Math.PI * 0.5]) {
        matrix.compose(
          new THREE.Vector3(x, REEF.topY + 1, z),
          new THREE.Quaternion().setFromEuler(
            new THREE.Euler(0, random() * 6.28 + turn, 0.1 + random() * 0.22)
          ),
          new THREE.Vector3(width, drop, 1)
        );
        soup.add(blade, matrix, white);
      }
    }
    blade.dispose();
    const material = new THREE.MeshBasicNodeMaterial({ name: "sutro_reef_shafts" });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.side = THREE.DoubleSide;
    material.colorNode = Fn(() => {
      const coord = uv() as N;
      // Bright and hard at the top, gone before the sea floor.
      const fall = smoothstep(float(0), float(0.85), coord.y);
      const across = smoothstep(float(0), float(0.34), coord.x).mul(
        smoothstep(float(1), float(0.66), coord.x)
      );
      const flicker = sin(uTime.mul(0.6).add(coord.x.mul(9))).mul(0.5).add(0.5).mul(0.4).add(0.6);
      const distance = cameraPosition.distance(positionWorld);
      const near = smoothstep(float(2), float(9), distance);
      return vec4(
        vec3(0.42, 0.86, 0.95),
        fall.mul(across).mul(flicker).mul(near).mul(0.16)
      );
    })() as N;
    attach(soup.build("sutro_reef_shafts"), material, "sutro_reef_shafts");
  }

  // ---- marine snow -------------------------------------------------------
  // Crossed pairs rather than points: a mote has to survive being looked at
  // edge-on, and two triangles are cheaper than a sprite pipeline.
  {
    const soup = new Soup();
    const random = rng(0x33d1);
    const white = new THREE.Color(0.72, 0.88, 0.92);
    const quad = new THREE.PlaneGeometry(1, 1);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 520; i++) {
      const size = 0.03 + random() * 0.05;
      const x = shelfX(random, size + 1.2);
      if (x === null) continue;
      const z = CZ + (random() * 2 - 1) * REEF.halfZ * 0.7;
      const y = REEF.bedY + random() * (REEF.topY - REEF.bedY);
      const drift = random() * 6.28;
      for (const turn of [0, Math.PI * 0.5]) {
        matrix.compose(
          new THREE.Vector3(x, y, z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, turn, random() * 3)),
          new THREE.Vector3(size, size, size)
        );
        soup.add(quad, matrix, white, {
          aSway: { size: 4, values: [drift, y - 40, 0.02, 0.7 + random() * 0.9] }
        });
      }
    }
    quad.dispose();
    const material = new THREE.MeshBasicNodeMaterial({ name: "sutro_reef_snow" });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.side = THREE.DoubleSide;
    material.positionNode = swayPositionNode(uTime);
    material.colorNode = Fn(() => {
      const distance = cameraPosition.distance(positionWorld);
      const near = smoothstep(float(1.5), float(6), distance).mul(
        smoothstep(float(46), float(20), distance)
      );
      return vec4(vec3(0.7, 0.9, 0.95), near.mul(0.5));
    })() as N;
    attach(soup.build("sutro_reef_snow"), material, "sutro_reef_snow");
  }

  // ---- rising bubbles ----------------------------------------------------
  // A vent in the shelf right outside the middle window; the strand climbs on a
  // fract() so it loops for ever without a particle system.
  {
    const soup = new Soup();
    const random = rng(0x6ae2);
    const white = new THREE.Color(1, 1, 1);
    const quad = new THREE.PlaneGeometry(1, 1);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < 130; i++) {
      const ventAngle = random() * 6.28;
      const ventSpread = Math.pow(random(), 0.6) * 2.6;
      const x = Math.min(CLEAR_X - 1.2, REEF.nearX - 12 + Math.cos(ventAngle) * ventSpread);
      const z = CZ + Math.sin(ventAngle) * ventSpread;
      const size = 0.05 + Math.pow(random(), 2) * 0.22;
      for (const turn of [0, Math.PI * 0.5]) {
        matrix.compose(
          new THREE.Vector3(x, bedHeight(x, z), z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, turn, 0)),
          new THREE.Vector3(size, size, size)
        );
        soup.add(quad, matrix, white, {
          aRise: { size: 3, values: [random(), 0.5 + random() * 0.7, random() * 6.28] }
        });
      }
    }
    quad.dispose();
    const material = new THREE.MeshBasicNodeMaterial({ name: "sutro_reef_bubbles" });
    material.transparent = true;
    material.depthWrite = false;
    material.blending = THREE.AdditiveBlending;
    material.side = THREE.DoubleSide;
    const rise = attribute("aRise", "vec3") as N;
    const climb = fract(rise.x.add(uTime.mul(rise.y).mul(0.04)));
    material.positionNode = (positionLocal as N).add(
      vec3(
        sin(climb.mul(9).add(rise.z)).mul(0.5),
        climb.mul(24),
        cos(climb.mul(7).add(rise.z)).mul(0.5)
      )
    );
    material.colorNode = Fn(() => {
      const fade = smoothstep(float(0), float(0.06), climb).mul(smoothstep(float(1), float(0.72), climb));
      return vec4(vec3(0.66, 0.92, 1), fade.mul(0.42));
    })() as N;
    attach(soup.build("sutro_reef_bubbles"), material, "sutro_reef_bubbles");
  }

  const triangles = geometries.reduce(
    (total, geometry) => total + (geometry.getIndex()?.count ?? 0) / 3,
    0
  );

  return {
    group,
    update(time) {
      uTime.value = time;
    },
    stats: { draws: meshes.length, triangles, fish, plants },
    dispose() {
      for (const mesh of meshes) mesh.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      meshes.length = 0;
      geometries.length = 0;
      materials.length = 0;
      group.clear();
      group.removeFromParent();
    }
  };
}
