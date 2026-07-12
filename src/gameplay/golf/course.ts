import * as THREE from "three/webgpu";
import {
  attribute,
  color,
  float,
  instancedBufferAttribute,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalView,
  positionLocal,
  positionViewDirection,
  positionWorld,
  smoothstep,
  uniform,
  uv,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { bumpNormal } from "../../world/tslUtil";
import type { WorldMap } from "../../world/heightmap";
import { GolfCourse, type GolfPoly, type GolfSurface } from "./data";
import { TEE_BEACON_TUNING } from "./tuning";

type N = any;

/**
 * Presidio Golf Course, rendered: terrain-draped overlay meshes for fairways /
 * greens / tees / bunkers / cart paths over a dedicated full-footprint rough
 * sheet, 18 pins with waving flags and cups, and a luminous blue web cage
 * over every tee box so the course reads as "playable" from a passing
 * car. One merged mesh per surface kind + 3 instanced pin parts + 2 instanced
 * glow parts — 11 draw calls for the whole course.
 */

const SURF_STYLE: Record<Exclude<GolfSurface, "out">, { maxEdge: number; offset: number }> = {
  rough: { maxEdge: 7, offset: 0 },
  fairway: { maxEdge: 5, offset: -1 },
  path: { maxEdge: 4, offset: -2 },
  bunker: { maxEdge: 3, offset: -3 },
  green: { maxEdge: 2.5, offset: -4 },
  tee: { maxEdge: 2, offset: -5 }
};

/** Ear-cut a polygon (holes supported), then midpoint-subdivide long edges so
 *  the sheet can follow terrain. Shared-edge midpoint cache keeps it crack-free. */
function triangulate(poly: GolfPoly, maxEdge: number): { pos: number[]; idx: number[] } {
  const contour = poly.o.map(([x, z]) => new THREE.Vector2(x, z));
  const holes = poly.i.map((r) => r.map(([x, z]) => new THREE.Vector2(x, z)));
  const tris = THREE.ShapeUtils.triangulateShape(contour, holes);
  const flat: THREE.Vector2[] = contour.concat(...holes);

  const pos: number[] = [];
  for (const v of flat) pos.push(v.x, v.y);
  let idx: number[] = [];
  for (const t of tris) idx.push(t[0], t[1], t[2]);

  const maxEdgeSq = maxEdge * maxEdge;
  const midCache = new Map<number, number>();
  const midpoint = (a: number, b: number): number => {
    const key = a < b ? a * 1e6 + b : b * 1e6 + a;
    let m = midCache.get(key);
    if (m === undefined) {
      m = pos.length / 2;
      pos.push((pos[a * 2] + pos[b * 2]) / 2, (pos[a * 2 + 1] + pos[b * 2 + 1]) / 2);
      midCache.set(key, m);
    }
    return m;
  };
  const edgeSq = (a: number, b: number) => {
    const dx = pos[a * 2] - pos[b * 2];
    const dz = pos[a * 2 + 1] - pos[b * 2 + 1];
    return dx * dx + dz * dz;
  };

  for (let pass = 0; pass < 7; pass++) {
    const next: number[] = [];
    let split = false;
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i];
      const b = idx[i + 1];
      const c = idx[i + 2];
      const ab = edgeSq(a, b);
      const bc = edgeSq(b, c);
      const ca = edgeSq(c, a);
      const m = Math.max(ab, bc, ca);
      if (m <= maxEdgeSq) {
        next.push(a, b, c);
        continue;
      }
      split = true;
      if (m === ab) {
        const mid = midpoint(a, b);
        next.push(a, mid, c, mid, b, c);
      } else if (m === bc) {
        const mid = midpoint(b, c);
        next.push(a, b, mid, a, mid, c);
      } else {
        const mid = midpoint(c, a);
        next.push(a, b, mid, b, c, mid);
      }
    }
    idx = next;
    if (!split) break;
  }
  return { pos, idx };
}

/** Merge many polys of one kind into a single draped BufferGeometry. */
function buildSurfaceGeometry(
  polys: GolfPoly[],
  maxEdge: number,
  course: GolfCourse,
  withCenterAttr: boolean
): THREE.BufferGeometry {
  const positions: number[] = [];
  const centers: number[] = [];
  const indices: number[] = [];
  for (const poly of polys) {
    const { pos, idx } = triangulate(poly, maxEdge);
    const base = positions.length / 3;
    let cx = 0;
    let cz = 0;
    for (const [x, z] of poly.o) {
      cx += x;
      cz += z;
    }
    cx /= poly.o.length;
    cz /= poly.o.length;
    for (let i = 0; i < pos.length; i += 2) {
      const x = pos[i];
      const z = pos[i + 1];
      positions.push(x, course.ground(x, z), z);
      if (withCenterAttr) centers.push(x - cx, z - cz);
    }
    for (const i of idx) indices.push(base + i);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  if (withCenterAttr) geo.setAttribute("gc", new THREE.Float32BufferAttribute(centers, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/** Cart paths: polyline → draped ribbon quads. */
function buildRibbonGeometry(lines: [number, number][][], width: number, course: GolfCourse): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const half = width / 2;
  for (const line of lines) {
    for (let i = 0; i < line.length - 1; i++) {
      const [x1, z1] = line[i];
      const [x2, z2] = line[i + 1];
      const len = Math.hypot(x2 - x1, z2 - z1);
      if (len < 0.01) continue;
      const steps = Math.max(1, Math.ceil(len / 5));
      const nx = -(z2 - z1) / len;
      const nz = (x2 - x1) / len;
      let prevL = -1;
      let prevR = -1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const x = x1 + (x2 - x1) * t;
        const z = z1 + (z2 - z1) * t;
        const lx = x + nx * half;
        const lz = z + nz * half;
        const rx = x - nx * half;
        const rz = z - nz * half;
        const li = positions.length / 3;
        positions.push(lx, course.ground(lx, lz) + 0.02, lz, rx, course.ground(rx, rz) + 0.02, rz);
        if (prevL >= 0) indices.push(prevL, prevR, li, prevR, li + 1, li);
        prevL = li;
        prevR = li + 1;
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

function grassMaterial(a: number, b: number, opts: { rings?: boolean; stripes?: boolean; offset: number }) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const patch = mx_fractal_noise_float(p.mul(0.08), 3).mul(0.5).add(0.5);
  const tuft = mx_noise_float(p.mul(3.4)).mul(0.5).add(0.5);
  let grass: N = mix(color(a), color(b), patch).mul(tuft.mul(0.12).add(0.94));
  if (opts.stripes) {
    // mow stripes: alternating catch of the light down a fixed course-wide axis
    const band = (p.x as N).add(p.z).mul(0.14).sin().mul(0.04).add(1);
    grass = grass.mul(band);
  }
  if (opts.rings) {
    // concentric mow rings around each green's own center (gc = offset attr)
    const gc = attribute("gc", "vec2") as unknown as N;
    const ring = gc.length().mul(1.8).sin().mul(0.035).add(1);
    grass = grass.mul(ring);
  }
  mat.colorNode = grass;
  mat.roughnessNode = float(1);
  mat.normalNode = bumpNormal(tuft.mul(0.006));
  mat.envMapIntensity = 0.35;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = opts.offset;
  mat.polygonOffsetUnits = opts.offset;
  return mat;
}

/** Dense-looking course rough without blade geometry: broad colour mottling,
 *  short-fibre grain and a stronger normal make it read thicker/darker than the
 *  mown fairway while remaining a smooth, reliable rolling surface. */
function roughMaterial(offset: number) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const broad = mx_fractal_noise_float(p.mul(0.055), 4).mul(0.5).add(0.5);
  const fibre = mx_noise_float(vec3((p.x as N).mul(1.7), (p.y as N).mul(0.4), (p.z as N).mul(2.3)))
    .mul(0.5)
    .add(0.5);
  mat.colorNode = mix(color(0x3e6638), color(0x66834a), broad).mul(fibre.mul(0.13).add(0.9));
  mat.roughnessNode = float(1);
  mat.normalNode = bumpNormal(fibre.mul(0.014));
  mat.envMapIntensity = 0.22;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = offset;
  mat.polygonOffsetUnits = offset;
  return mat;
}

function sandMaterial(offset: number) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const grain = mx_noise_float(p.mul(9)).mul(0.5).add(0.5);
  const drift = mx_fractal_noise_float(p.mul(0.35), 2).mul(0.5).add(0.5);
  mat.colorNode = mix(color(0xcbb890), color(0xe0d2ac), drift).mul(grain.mul(0.1).add(0.95));
  // wind ripples: fine directional waves you only notice up close
  const ripple = (p.x as N).mul(2.1).add((p.z as N).mul(1.3)).sin().mul(mx_noise_float(p.mul(0.8)).mul(0.5).add(0.5));
  mat.roughnessNode = float(1);
  mat.normalNode = bumpNormal(ripple.mul(0.01));
  mat.envMapIntensity = 0.25;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = offset;
  mat.polygonOffsetUnits = offset;
  return mat;
}

function pathMaterial(offset: number) {
  const mat = new THREE.MeshStandardNodeMaterial();
  const p = positionWorld;
  const blotch = mx_fractal_noise_float(p.mul(0.5), 2).mul(0.5).add(0.5);
  mat.colorNode = mix(color(0x8f8578), color(0xa79b89), blotch);
  mat.roughnessNode = float(0.95);
  mat.envMapIntensity = 0.2;
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = offset;
  mat.polygonOffsetUnits = offset;
  return mat;
}

export class GolfCourseView {
  group = new THREE.Group();

  #time: ReturnType<typeof uniform>;
  #activeTee: ReturnType<typeof uniform>;
  #flagTime: ReturnType<typeof uniform>;
  #teeAlpha: ReturnType<typeof uniform>;
  #teeFresnelPower: ReturnType<typeof uniform>;

  constructor(course: GolfCourse, _map: WorldMap, parent: THREE.Object3D) {
    this.group.name = "golf-course";
    this.#time = uniform(0);
    this.#activeTee = uniform(-1);
    this.#flagTime = uniform(0);
    this.#teeAlpha = uniform(TEE_BEACON_TUNING.values.alpha);
    this.#teeFresnelPower = uniform(TEE_BEACON_TUNING.values.fresnelPower);

    const add = (name: string, geo: THREE.BufferGeometry, mat: THREE.Material) => {
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = `golf-${name}`;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      return mesh;
    };

    const d = course.data;
    add(
      "rough",
      buildSurfaceGeometry([{ o: d.boundary, i: [] }], SURF_STYLE.rough.maxEdge, course, false),
      roughMaterial(SURF_STYLE.rough.offset)
    );
    add(
      "fairways",
      buildSurfaceGeometry(d.fairways, SURF_STYLE.fairway.maxEdge, course, false),
      grassMaterial(0x74a458, 0x93ba64, { stripes: true, offset: SURF_STYLE.fairway.offset })
    );
    add("paths", buildRibbonGeometry(d.paths, 2.2, course), pathMaterial(SURF_STYLE.path.offset));
    add("bunkers", buildSurfaceGeometry(d.bunkers, SURF_STYLE.bunker.maxEdge, course, false), sandMaterial(SURF_STYLE.bunker.offset));
    add(
      "greens",
      buildSurfaceGeometry(d.greens, SURF_STYLE.green.maxEdge, course, true),
      grassMaterial(0x8cbd66, 0xa8d174, { rings: true, offset: SURF_STYLE.green.offset })
    );
    add(
      "tees",
      buildSurfaceGeometry(d.tees, SURF_STYLE.tee.maxEdge, course, false),
      grassMaterial(0x7cae5c, 0x92c268, { offset: SURF_STYLE.tee.offset })
    );

    this.#buildPins(course);
    this.#buildTeeGlow(course);
    parent.add(this.group);
  }

  /** 18 pins: pole + waving flag + cup, one InstancedMesh each. */
  #buildPins(course: GolfCourse) {
    const n = course.holes.length;
    const pin = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const s = new THREE.Vector3(1, 1, 1);

    const poleGeo = new THREE.CylinderGeometry(0.02, 0.025, 2.3, 6);
    poleGeo.translate(0, 1.15, 0);
    const poleMat = new THREE.MeshStandardNodeMaterial();
    poleMat.colorNode = (color(0xf2f4f0) as N).mul(LIGHT_SCALE * 0.9);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, n);

    // flag: a little sail off the pole top; TSL ripple keyed to distance from
    // the hoist so the free edge whips harder
    const flagGeo = new THREE.PlaneGeometry(0.62, 0.4, 8, 3);
    flagGeo.translate(0.31, 1.98, 0);
    const flagMat = new THREE.MeshStandardNodeMaterial();
    const hoist = (uv().x as N).mul(1);
    const waveT = this.#flagTime as unknown as N;
    const ripple = hoist
      .mul(7)
      .add(waveT.mul(6.5))
      .sin()
      .mul(hoist.mul(0.09));
    flagMat.positionNode = (positionLocal as N).add(vec3(0, 0, ripple));
    flagMat.colorNode = mix(color(0xd7263d), color(0xa71930), (uv().y as N)).mul(LIGHT_SCALE * 0.95);
    flagMat.side = THREE.DoubleSide;
    const flags = new THREE.InstancedMesh(flagGeo, flagMat, n);

    const cupGeo = new THREE.CircleGeometry(0.16, 20);
    cupGeo.rotateX(-Math.PI / 2);
    const cupMat = new THREE.MeshBasicNodeMaterial();
    cupMat.colorNode = color(0x101211);
    cupMat.polygonOffset = true;
    cupMat.polygonOffsetFactor = -8;
    cupMat.polygonOffsetUnits = -8;
    const cups = new THREE.InstancedMesh(cupGeo, cupMat, n);

    for (let i = 0; i < n; i++) {
      course.pin(i, pin);
      q.setFromAxisAngle(up, (i * 137.5 * Math.PI) / 180); // varied flag facing
      m.compose(pin, q, s);
      poles.setMatrixAt(i, m);
      flags.setMatrixAt(i, m);
      m.compose(pin.clone().setY(pin.y + 0.015), q, s);
      cups.setMatrixAt(i, m);
    }
    for (const mesh of [poles, flags, cups]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  /** Blue spider-web cage + ground halo over each tee box: luminous vertical
   *  spokes and sagging cross-strands that say "walk up and press E". */
  #buildTeeGlow(course: GolfCourse) {
    const n = course.holes.length;
    const tee = new THREE.Vector3();
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);

    const seeds = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    for (let i = 0; i < n; i++) seeds.setX(i, i);
    const seed = instancedBufferAttribute(seeds) as unknown as N;
    const t = this.#time as unknown as N;
    const active = this.#activeTee as unknown as N;
    const alpha = this.#teeAlpha as unknown as N;
    const fresnelPower = this.#teeFresnelPower as unknown as N;
    // active hole's tee burns much brighter; -1 = free-roam, everything simmers
    // at a clearly-visible base. WGSL smoothstep requires edge0 < edge1; invert a
    // legal step rather than relying on the undefined reversed-edge form.
    const isActive = smoothstep(float(0.45), float(0.5), seed.sub(active).abs()).oneMinus(); // 1 on the active tee
    const boost = isActive.mul(0.85).add(1.0); // ~1.85 active, 1.0 idle

    // — web cage: an open cylinder whose UVs draw fine upright spokes connected
    // by bowed cross-strands. A broad low-alpha copy around each thread supplies
    // the glow without relying on a post-process bloom pass.
    const curtainGeo = new THREE.CylinderGeometry(4.8, 5.5, 8.4, 42, 1, true);
    curtainGeo.translate(0, 4.2, 0);
    const curtain = new THREE.MeshBasicNodeMaterial();
    const webU = uv().x as N;
    const webV = uv().y as N;
    const vfade = webV.oneMinus().pow(0.7).mul(0.62).add(0.38);
    const facing = (normalView as N).normalize().dot((positionViewDirection as N).normalize()).abs().clamp(0, 1);
    const rim = facing.oneMinus().pow((fresnelPower as N).max(0));
    const fresnel = float(0.18).add(rim.mul(0.82)).clamp(0, 1) as N;
    const spokeCell = webU.mul(14).fract();
    const spokeDist = spokeCell.sub(0.5).abs();
    const spokeCore = smoothstep(float(0.015), float(0.055), spokeDist).oneMinus();
    const spokeGlow = smoothstep(float(0.025), float(0.16), spokeDist).oneMinus();
    // Each connector droops between adjacent uprights, like a strand pulled
    // taut at the spokes. The entire web drifts upward very slowly.
    const strandSag = spokeCell.mul(Math.PI).sin().mul(0.24);
    const strandPhase = webV.mul(7).add(strandSag).sub(t.mul(0.08));
    const strandDist = strandPhase.fract().sub(0.5).abs();
    const strandCore = smoothstep(float(0.02), float(0.07), strandDist).oneMinus();
    const strandGlow = smoothstep(float(0.035), float(0.18), strandDist).oneMinus();
    const webCore = spokeCore.max(strandCore);
    const webGlow = spokeGlow.max(strandGlow);
    const pulse = t.mul(1.6).add(seed.mul(2.1)).sin().mul(0.1).add(0.92);
    const blue = mix(vec3(0.003, 0.035, 0.65), vec3(0.01, 0.27, 1.0), webCore);
    curtain.colorNode = blue.mul(webCore.mul(0.48).add(0.52)).mul(LIGHT_SCALE * 0.8);
    curtain.opacityNode = vfade
      .mul(fresnel.mul(0.45).add(0.55))
      .mul(webCore.mul(0.6).add(webGlow.mul(0.28)))
      .mul(pulse)
      .mul(boost)
      .mul(alpha)
      .clamp(0, 1);
    // Normal alpha keeps the electric-blue core saturated against bright sky
    // and grass; the broad low-coverage strands still read as a soft glow.
    curtain.transparent = true;
    curtain.depthWrite = false;
    curtain.side = THREE.DoubleSide;
    curtain.fog = true;
    const curtains = new THREE.InstancedMesh(curtainGeo, curtain, n);
    curtains.name = "golf-tee-curtains";
    curtains.layers.set(31);

    // — ground halo ring
    const haloGeo = new THREE.RingGeometry(3.4, 5.1, 36);
    haloGeo.rotateX(-Math.PI / 2);
    haloGeo.translate(0, 0.14, 0);
    const halo = new THREE.MeshBasicNodeMaterial();
    // RingGeometry UVs are planar — recover the radius from local position for
    // a soft band peaking mid-ring
    const rad = (positionLocal as N).xz.length().sub(3.4).div(1.7).sub(0.5).abs().mul(2).oneMinus().max(0).pow(1.8);
    halo.colorNode = mix(vec3(0.003, 0.045, 0.65), vec3(0.012, 0.3, 1.0), rad).mul(LIGHT_SCALE * 0.86);
    halo.opacityNode = rad.mul(pulse).mul(boost).mul(alpha).mul(1.15);
    halo.transparent = true;
    halo.blending = THREE.AdditiveBlending;
    halo.depthWrite = false;
    halo.fog = true;
    const halos = new THREE.InstancedMesh(haloGeo, halo, n);
    halos.name = "golf-tee-halos";

    // — sky beam: a tall soft shaft over ONLY the active tee, the long-range
    // "the hole you're playing is over here" cue. Idle tees show none of it.
    const beamGeo = new THREE.CylinderGeometry(0.8, 1.55, 34, 20, 1, true);
    beamGeo.translate(0, 17, 0);
    const beam = new THREE.MeshBasicNodeMaterial();
    const bFade = (uv().y as N).oneMinus().pow(1.5); // solid at the grass, feathering to nothing up high
    const bFres = float(0.06).add(rim.mul(0.94)).clamp(0, 1) as N;
    const bPulse = t.mul(2.3).add(seed.mul(1.1)).sin().mul(0.18).add(0.82);
    beam.colorNode = mix(vec3(0.003, 0.055, 0.7), vec3(0.012, 0.32, 1.0), (uv().y as N)).mul(LIGHT_SCALE * 0.88);
    beam.opacityNode = bFade
      .mul(bFres)
      .mul(bPulse)
      .mul(isActive)
      .mul(alpha)
      .mul(0.82)
      .clamp(0, 1); // isActive gate → only the current tee
    beam.transparent = true;
    beam.depthWrite = false;
    beam.side = THREE.DoubleSide;
    beam.fog = true;
    const beams = new THREE.InstancedMesh(beamGeo, beam, n);
    beams.name = "golf-tee-active-beams";
    beams.layers.set(31);

    for (let i = 0; i < n; i++) {
      course.teeSpot(i, tee);
      m.compose(tee, q, s);
      curtains.setMatrixAt(i, m);
      halos.setMatrixAt(i, m);
      beams.setMatrixAt(i, m);
    }
    for (const mesh of [curtains, halos, beams]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.frustumCulled = false;
    }
    this.group.add(curtains, halos, beams);
  }

  /** Spotlight one hole's tee (the hole being played / up next), -1 for all. */
  setActiveTee(holeIdx: number) {
    this.#activeTee.value = holeIdx;
  }

  update(_dt: number, elapsed: number) {
    this.#time.value = elapsed;
    this.#flagTime.value = elapsed;
    this.#teeAlpha.value = TEE_BEACON_TUNING.values.alpha;
    this.#teeFresnelPower.value = TEE_BEACON_TUNING.values.fresnelPower;
  }
}
