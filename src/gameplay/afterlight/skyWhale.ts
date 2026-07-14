import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  clamp,
  color,
  cross,
  float,
  mix,
  mx_noise_float,
  normalWorld,
  normalize,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  time,
  uniform,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { AFTERLIGHT_TUNING } from "./layout";

type N = any;

const FORWARD = new THREE.Vector3(0, 0, -1);
const RIBBON_POINTS = 150;
const RIBBON_LIFE = 6.2;
const RIBBON_SPACING = 1.15;

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function seeded(index: number, salt: number): number {
  const v = Math.sin(index * 91.713 + salt * 47.127) * 43758.5453;
  return v - Math.floor(v);
}

function whaleMaterial(reveal: N, fadeAmount: N, shell: boolean): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  const view = normalize(cameraPosition.sub(positionWorld)) as N;
  const nDotV = clamp((normalWorld as N).dot(view).abs(), 0, 1) as N;
  // Tight rim for the shell glow; softer falloff on the body so the centre stays readable.
  const fresnel = float(1).sub(nDotV).pow(shell ? 1.4 : 2.7) as N;
  const softRim = float(1).sub(nDotV).pow(shell ? 0.9 : 1.8) as N;

  const pulseA = sin(time.mul(0.16)).mul(0.5).add(0.5) as N;
  const pulseB = sin(time.mul(0.1).add(1.9)).mul(0.5).add(0.5) as N;
  const pulseC = sin(time.mul(0.07).add(3.4)).mul(0.5).add(0.5) as N;

  const along = smoothstep(-11.5, 11.5, (positionLocal as N).z) as N;
  const belly = smoothstep(1.2, -2.4, (positionLocal as N).y) as N;

  const drift = mx_noise_float(
    (positionWorld as N)
      .mul(shell ? 0.07 : 0.04)
      .add(vec3(time.mul(shell ? 0.035 : -0.025), time.mul(0.014), time.mul(0.028)))
  )
    .mul(0.5)
    .add(0.5) as N;

  // Saturated aurora stops — keep the core deep so Fresnel rims can bloom without washing white.
  const deep = color(shell ? 0x3d8f9e : 0x247889) as N;
  const cyan = color(shell ? 0x6ef0e4 : 0x4ec9d6) as N;
  const violet = color(shell ? 0xc9a5ff : 0x8f6fd0) as N;
  const rose = color(shell ? 0xff9ece : 0xe07aae) as N;
  const mint = color(shell ? 0x9bffe0 : 0x62d9b8) as N;

  const headWash = mix(cyan, violet, pulseA) as N;
  const tailWash = mix(rose, mint, pulseB) as N;
  const core = mix(mix(deep, headWash, 0.55), mix(deep, tailWash, 0.65), along) as N;
  const rim = mix(mix(cyan, mint, pulseC), mix(violet, rose, pulseA), along.mul(0.7).add(pulseB.mul(0.3))) as N;
  const bellyTint = mix(core, rose, belly.mul(0.35).mul(pulseB.add(0.25))) as N;
  const living = mix(bellyTint, rim, softRim.mul(shell ? 0.95 : 0.72).add(fresnel.mul(0.35))) as N;
  const shimmer = mix(living, mix(violet, mint, pulseA), drift.pow(2.8).mul(shell ? 0.28 : 0.14)) as N;

  const brightness = shell
    ? fresnel.mul(1.15).add(softRim.mul(0.35)).add(0.04)
    : fresnel.mul(0.42).add(softRim.mul(0.22)).add(0.34);

  material.colorNode = shimmer
    .mul(brightness)
    .mul(fadeAmount)
    .mul(LIGHT_SCALE * (shell ? 1.2 : 0.68));
  material.opacityNode = reveal
    .mul(fadeAmount)
    .mul(shell ? fresnel.mul(0.92).add(softRim.mul(0.08)).add(0.02) : fresnel.mul(0.38).add(softRim.mul(0.14)).add(0.28));
  material.transparent = true;
  material.depthWrite = false;
  // FrontSide avoids muddy double-hit through the translucent volume.
  material.side = shell ? THREE.BackSide : THREE.FrontSide;
  material.blending = shell ? THREE.AdditiveBlending : THREE.NormalBlending;
  material.fog = false;
  return material;
}

type HullStation = { z: number; rx: number; ry: number; cy: number };

/** One continuous hull: elliptical rings lofted along a sculpted spine. */
function whaleHullGeometry(radialSegments = 36): THREE.BufferGeometry {
  const key: HullStation[] = [
    { z: -12.0, rx: 0.04, ry: 0.03, cy: -0.08 },
    { z: -11.35, rx: 1.15, ry: 0.85, cy: -0.18 },
    { z: -10.4, rx: 2.55, ry: 1.95, cy: -0.05 },
    { z: -9.2, rx: 3.55, ry: 2.55, cy: 0.1 },
    { z: -7.6, rx: 4.15, ry: 2.7, cy: 0.16 },
    { z: -5.4, rx: 4.55, ry: 2.62, cy: 0.08 },
    { z: -2.6, rx: 4.85, ry: 2.72, cy: -0.02 },
    { z: 0.4, rx: 4.95, ry: 2.78, cy: -0.08 },
    { z: 3.4, rx: 4.55, ry: 2.55, cy: -0.04 },
    { z: 6.2, rx: 3.55, ry: 2.15, cy: 0.04 },
    { z: 8.6, rx: 2.35, ry: 1.5, cy: 0.12 },
    { z: 10.2, rx: 1.45, ry: 1.05, cy: 0.18 },
    { z: 11.5, rx: 0.85, ry: 0.72, cy: 0.22 },
    { z: 12.4, rx: 0.28, ry: 0.32, cy: 0.24 }
  ];

  const samples = 48;
  const curvePoints = key.map((s) => new THREE.Vector3(s.rx, s.ry, s.z));
  const centerCurve = new THREE.CatmullRomCurve3(key.map((s) => new THREE.Vector3(0, s.cy, s.z)));
  const widthCurve = new THREE.CatmullRomCurve3(curvePoints);
  const stations: HullStation[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const w = widthCurve.getPoint(t);
    const c = centerCurve.getPoint(t);
    stations.push({ z: w.z, rx: Math.max(0.02, w.x), ry: Math.max(0.02, w.y), cy: c.y });
  }

  const positions: number[] = [];
  const indices: number[] = [];
  for (let s = 0; s < stations.length; s++) {
    const station = stations[s];
    const taper = 1 - Math.abs(station.z) / 13.5;
    for (let r = 0; r <= radialSegments; r++) {
      const theta = (r / radialSegments) * Math.PI * 2;
      const cos = Math.cos(theta);
      const sinT = Math.sin(theta);
      // Soft belly drop + gentle dorsal ridge so it reads as flesh, not a tube.
      const belly = Math.max(0, -sinT);
      const dorsum = Math.max(0, sinT);
      const rx = station.rx * (1 + belly * 0.1 - dorsum * 0.04);
      const ry = station.ry * (1 + belly * 0.18 + dorsum * 0.06 * taper);
      positions.push(cos * rx, station.cy + sinT * ry, station.z);
    }
  }

  const ring = radialSegments + 1;
  for (let s = 0; s < stations.length - 1; s++) {
    for (let r = 0; r < radialSegments; r++) {
      const a = s * ring + r;
      const b = a + 1;
      const c = a + ring;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function sculptedFinGeometry(side: -1 | 1, kind: "pectoral" | "fluke"): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  if (kind === "pectoral") {
    // Compact flipper: broad root, swept tip, soft trailing edge.
    shape.moveTo(0, -0.85);
    shape.bezierCurveTo(1.1, -1.55, 2.4, -2.35, 3.9, -2.7);
    shape.bezierCurveTo(4.7, -2.8, 5.15, -2.25, 4.95, -1.55);
    shape.bezierCurveTo(4.7, -0.55, 3.5, 0.45, 2.05, 0.75);
    shape.bezierCurveTo(1.0, 0.9, 0.3, 0.45, 0, 0.1);
    shape.closePath();
  } else {
    // Crescent fluke half — wide, short, horizontal.
    shape.moveTo(0, 0.2);
    shape.bezierCurveTo(1.2, 0.55, 2.8, 0.95, 4.4, 1.05);
    shape.bezierCurveTo(5.2, 1.05, 5.55, 0.55, 5.25, 0.05);
    shape.bezierCurveTo(4.85, -0.55, 3.5, -1.15, 2.1, -1.25);
    shape.bezierCurveTo(1.0, -1.3, 0.3, -0.75, 0, -0.2);
    shape.closePath();
  }

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: kind === "pectoral" ? 0.22 : 0.16,
    bevelEnabled: true,
    bevelThickness: kind === "pectoral" ? 0.12 : 0.09,
    bevelSize: kind === "pectoral" ? 0.18 : 0.14,
    bevelSegments: 4,
    curveSegments: 24
  });
  geometry.translate(0, 0, kind === "pectoral" ? -0.11 : -0.08);
  geometry.rotateX(-Math.PI / 2);
  if (side < 0) {
    geometry.scale(-1, 1, 1);
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i < index.count; i += 3) {
        const a = index.getX(i);
        index.setX(i, index.getX(i + 1));
        index.setX(i + 1, a);
      }
    }
  }
  geometry.computeVertexNormals();
  return geometry;
}

type RibbonPoint = { x: number; y: number; z: number; dx: number; dy: number; dz: number; born: number };

class AfterlightRibbon {
  readonly mesh: THREE.Mesh;

  #geometry: THREE.BufferGeometry;
  #position: THREE.BufferAttribute;
  #direction: THREE.BufferAttribute;
  #born: THREE.BufferAttribute;
  #clock = uniform(0);
  #points: RibbonPoint[] = [];

  constructor(parent: THREE.Object3D, hue: number, widthGain: number, fadeAmount: N) {
    const geometry = new THREE.BufferGeometry();
    const side = new Float32Array(RIBBON_POINTS * 2);
    const indices: number[] = [];
    for (let i = 0; i < RIBBON_POINTS; i++) {
      side[i * 2] = -0.5;
      side[i * 2 + 1] = 0.5;
      if (i === 0) continue;
      const a = (i - 1) * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    this.#position = new THREE.BufferAttribute(new Float32Array(RIBBON_POINTS * 2 * 3), 3);
    this.#direction = new THREE.BufferAttribute(new Float32Array(RIBBON_POINTS * 2 * 3), 3);
    this.#born = new THREE.BufferAttribute(new Float32Array(RIBBON_POINTS * 2), 1);
    this.#position.setUsage(THREE.DynamicDrawUsage);
    this.#direction.setUsage(THREE.DynamicDrawUsage);
    this.#born.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("position", this.#position);
    geometry.setAttribute("aDir", this.#direction);
    geometry.setAttribute("aBorn", this.#born);
    geometry.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);
    this.#geometry = geometry;

    const material = new THREE.MeshBasicNodeMaterial();
    const age = clamp((this.#clock as N).sub(attribute("aBorn", "float")).div(RIBBON_LIFE), 0, 1) as N;
    const dir = attribute("aDir", "vec3") as N;
    const sideNode = attribute("aSide", "float") as N;
    const lateral = normalize(cross(dir, cameraPosition.sub(positionWorld)).add(vec3(0, 0.0001, 0))) as N;
    const width = mix(0.08, widthGain, age.pow(0.62)) as N;
    const lift = age.mul(age.oneMinus()).mul(2.4) as N;
    material.positionNode = positionGeometry.add(lateral.mul(sideNode.mul(width))).add(vec3(0, lift, 0));

    const edge = smoothstep(1, 0.18, sideNode.abs().mul(2)) as N;
    const fade = age.oneMinus().pow(1.55).mul(smoothstep(0, 0.025, age)) as N;
    const glint = mx_noise_float(
      vec3((positionWorld as N).x.mul(0.8), (positionWorld as N).y.mul(0.8), (positionWorld as N).z.mul(0.8).add(this.#clock.mul(0.7)))
    )
      .mul(0.5)
      .add(0.5) as N;
    const base = color(hue) as N;
    const hot = color(0xfff1d2) as N;
    material.colorNode = mix(base, hot, glint.pow(4).mul(0.72))
      .mul(edge)
      .mul(fade)
      .mul(fadeAmount)
      .mul(LIGHT_SCALE * 0.72);
    material.opacityNode = fade.mul(edge).mul(fadeAmount).mul(0.78);
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.fog = false;

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = "afterlight-whale-ribbon";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 18;
    this.mesh.visible = false;
    parent.add(this.mesh);
  }

  clear(): void {
    this.#points.length = 0;
    this.#geometry.setDrawRange(0, 0);
    this.mesh.visible = false;
  }

  add(position: THREE.Vector3, direction: THREE.Vector3, born: number): void {
    if (this.#points.length >= RIBBON_POINTS - 1) this.#points.shift();
    this.#points.push({
      x: position.x,
      y: position.y,
      z: position.z,
      dx: direction.x,
      dy: direction.y,
      dz: direction.z,
      born
    });
  }

  update(now: number, head: { position: THREE.Vector3; direction: THREE.Vector3 } | null): void {
    this.#clock.value = now;
    while (this.#points.length > 0 && now - this.#points[0].born >= RIBBON_LIFE) this.#points.shift();
    const count = this.#points.length + (head && this.#points.length > 0 ? 1 : 0);
    if (count < 2) {
      this.#geometry.setDrawRange(0, 0);
      this.mesh.visible = false;
      return;
    }

    const positions = this.#position.array as Float32Array;
    const directions = this.#direction.array as Float32Array;
    const born = this.#born.array as Float32Array;
    let vertex = 0;
    const put = (x: number, y: number, z: number, dx: number, dy: number, dz: number, t: number) => {
      for (let side = 0; side < 2; side++) {
        const p = vertex * 3;
        positions[p] = x;
        positions[p + 1] = y;
        positions[p + 2] = z;
        directions[p] = dx;
        directions[p + 1] = dy;
        directions[p + 2] = dz;
        born[vertex] = t;
        vertex++;
      }
    };
    for (const point of this.#points) {
      put(point.x, point.y, point.z, point.dx, point.dy, point.dz, point.born);
    }
    if (head) {
      const p = head.position;
      const d = head.direction;
      put(p.x, p.y, p.z, d.x, d.y, d.z, now);
    }
    this.#position.needsUpdate = true;
    this.#direction.needsUpdate = true;
    this.#born.needsUpdate = true;
    this.#geometry.setDrawRange(0, (count - 1) * 6);
    this.mesh.visible = true;
  }

  dispose(): void {
    this.mesh.parent?.remove(this.mesh);
    this.#geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

/** A translucent sky-whale with a continuous sculpted hull and TSL light. */
export class AfterlightSkyWhale {
  readonly root = new THREE.Group();

  #whale = new THREE.Group();
  #tail = new THREE.Group();
  #finL = new THREE.Mesh();
  #finR = new THREE.Mesh();
  #flukeL = new THREE.Mesh();
  #flukeR = new THREE.Mesh();
  #anchors: THREE.Object3D[] = [];
  #ribbons: AfterlightRibbon[] = [];
  #reveal = uniform(0);
  #fade = uniform(1);
  #time = 0;
  #active = false;
  #trailAccumulator = 0;
  #previousTail = new THREE.Vector3();
  #tailHead = new THREE.Vector3();
  #tailDirection = new THREE.Vector3(0, 0, 1);
  #temp = new THREE.Vector3();
  #next = new THREE.Vector3();
  #direction = new THREE.Vector3();
  #motes: THREE.Points;
  #motesMaterial: THREE.PointsMaterial;

  constructor() {
    this.root.name = "afterlight-sky-whale";
    this.root.visible = false;
    this.root.add(this.#whale);

    const inner = whaleMaterial(this.#reveal as N, this.#fade as N, false);
    const shell = whaleMaterial(this.#reveal as N, this.#fade as N, true);
    const hullGeometry = whaleHullGeometry();

    const body = new THREE.Mesh(hullGeometry, inner);
    this.#whale.add(body);
    const bodyShell = new THREE.Mesh(hullGeometry, shell);
    bodyShell.scale.setScalar(1.05);
    this.#whale.add(bodyShell);
    // Soft outer aura — kept close so the halo reads as light, not a second shell.
    const aura = new THREE.Mesh(hullGeometry, shell);
    aura.scale.setScalar(1.09);
    this.#whale.add(aura);

    // Additive fins stay luminous through the translucent hull and never punch dark holes.
    const finMat = whaleMaterial(this.#reveal as N, this.#fade as N, true);
    finMat.side = THREE.DoubleSide;

    this.#finL = new THREE.Mesh(sculptedFinGeometry(-1, "pectoral"), finMat);
    this.#finR = new THREE.Mesh(sculptedFinGeometry(1, "pectoral"), finMat);
    // Sit on the hull surface and sweep outward/back — avoid folding into the volume.
    this.#finL.position.set(-4.55, -0.35, -0.9);
    this.#finR.position.set(4.55, -0.35, -0.9);
    this.#finL.rotation.set(0.22, 0.12, -0.55);
    this.#finR.rotation.set(0.22, -0.12, 0.55);
    this.#whale.add(this.#finL, this.#finR);

    this.#tail.position.z = 11.45;
    this.#flukeL = new THREE.Mesh(sculptedFinGeometry(-1, "fluke"), finMat);
    this.#flukeR = new THREE.Mesh(sculptedFinGeometry(1, "fluke"), finMat);
    this.#flukeL.position.set(-0.12, 0.04, 0.2);
    this.#flukeR.position.set(0.12, 0.04, 0.2);
    // Keep flukes mostly horizontal so they read as a crescent, not a spike.
    this.#flukeL.rotation.set(0.05, 0.05, -0.05);
    this.#flukeR.rotation.set(0.05, -0.05, 0.05);
    this.#tail.add(this.#flukeL, this.#flukeR);
    this.#whale.add(this.#tail);

    const eyeMaterial = new THREE.MeshBasicNodeMaterial();
    eyeMaterial.colorNode = color(0xffe9a7)
      .mul(LIGHT_SCALE * 1.9)
      .mul(this.#reveal as N)
      .mul(this.#fade as N);
    const eyeGeometry = new THREE.SphereGeometry(0.2, 12, 8);
    for (const side of [-1, 1] as const) {
      const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
      eye.position.set(side * 3.15, 0.42, -9.05);
      this.#whale.add(eye);
    }

    const motePositions = new Float32Array(180 * 3);
    for (let i = 0; i < 180; i++) {
      const angle = seeded(i, 1) * Math.PI * 2;
      const radius = 3.8 + seeded(i, 2) * 8.5;
      motePositions[i * 3] = Math.cos(angle) * radius;
      motePositions[i * 3 + 1] = (seeded(i, 3) - 0.5) * 6.4;
      motePositions[i * 3 + 2] = 1.5 + Math.sin(angle) * radius + seeded(i, 4) * 8;
    }
    const moteGeometry = new THREE.BufferGeometry();
    moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
    this.#motesMaterial = new THREE.PointsMaterial({
      color: 0xc4fff1,
      size: 0.34,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    });
    this.#motes = new THREE.Points(moteGeometry, this.#motesMaterial);
    this.#motes.frustumCulled = false;
    this.#whale.add(this.#motes);

    const anchorOffsets: readonly [number, number, number][] = [
      [-1.15, 0.15, 0.85],
      [0, 0.35, 1.15],
      [1.15, 0.15, 0.85]
    ];
    for (const [x, y, z] of anchorOffsets) {
      const anchor = new THREE.Object3D();
      anchor.position.set(x, y, z);
      this.#tail.add(anchor);
      this.#anchors.push(anchor);
    }
    this.#ribbons = [
      new AfterlightRibbon(this.root, 0x7fffe8, 1.3, this.#fade as N),
      new AfterlightRibbon(this.root, 0xf8c6ff, 1.75, this.#fade as N),
      new AfterlightRibbon(this.root, 0x8ebdff, 1.3, this.#fade as N)
    ];

    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.renderOrder = 17;
    });
  }

  get active(): boolean {
    return this.#active;
  }

  activate(): void {
    this.#active = true;
    this.#time = 0;
    this.#trailAccumulator = 0;
    this.#previousTail.set(0, 0, 0);
    this.#reveal.value = 0;
    this.setFade(1);
    this.root.visible = true;
    for (const ribbon of this.#ribbons) ribbon.clear();
    this.#setPose(0, 0);
  }

  reset(): void {
    this.#active = false;
    this.#time = 0;
    this.#reveal.value = 0;
    this.setFade(1);
    this.root.visible = false;
    for (const ribbon of this.#ribbons) ribbon.clear();
  }

  setFade(value: number): void {
    const fade = THREE.MathUtils.clamp(value, 0, 1);
    this.#fade.value = fade;
    this.#motesMaterial.opacity = 0.72 * Number(this.#reveal.value) * fade;
  }

  /** Live-play update. The performance loops after its reveal. */
  update(dt: number): void {
    if (!this.#active) return;
    const step = Math.min(dt, 0.08);
    this.#time += step;
    const reveal = smooth01(this.#time / AFTERLIGHT_TUNING.whaleRevealSeconds);
    this.#setPose(this.#time, reveal);
    this.#updateTrail(step, this.#time, reveal);
  }

  /** Deterministic capture hook: derives the entire creature pose from film time. */
  setCinematicTime(timeSeconds: number, dt: number): void {
    if (!this.#active) this.activate();
    this.#time = Math.max(0, timeSeconds);
    const reveal = smooth01(this.#time / AFTERLIGHT_TUNING.whaleRevealSeconds);
    this.#setPose(this.#time, reveal);
    this.#updateTrail(Math.max(0, Math.min(dt, 0.08)), this.#time, reveal);
  }

  #setPose(t: number, reveal: number): void {
    this.#reveal.value = reveal;
    this.#motesMaterial.opacity = 0.72 * reveal * Number(this.#fade.value);
    const revealSeconds = AFTERLIGHT_TUNING.whaleRevealSeconds;
    if (t < revealSeconds) {
      const rise = smooth01(t / revealSeconds);
      this.#whale.position.set(0, -5 + rise * (AFTERLIGHT_TUNING.whaleCruiseHeight + 4), 1 - rise * 5);
      this.#direction.set(0.12, 0.42 - rise * 0.28, -1).normalize();
      this.#whale.quaternion.setFromUnitVectors(FORWARD, this.#direction);
      this.#whale.scale.setScalar(0.3 + rise * 0.7);
    } else {
      const orbitTime = t - revealSeconds;
      const angle = orbitTime * 0.145 - Math.PI * 0.58;
      const bob = Math.sin(orbitTime * 0.43) * 3.4 + Math.sin(orbitTime * 0.17) * 1.8;
      this.#whale.position.set(
        Math.cos(angle) * AFTERLIGHT_TUNING.whaleOrbitRadiusX,
        AFTERLIGHT_TUNING.whaleCruiseHeight + bob,
        Math.sin(angle) * AFTERLIGHT_TUNING.whaleOrbitRadiusZ
      );
      const nextAngle = angle + 0.015;
      this.#next.set(
        Math.cos(nextAngle) * AFTERLIGHT_TUNING.whaleOrbitRadiusX,
        AFTERLIGHT_TUNING.whaleCruiseHeight + Math.sin((orbitTime + 0.1) * 0.43) * 3.4 + Math.sin((orbitTime + 0.1) * 0.17) * 1.8,
        Math.sin(nextAngle) * AFTERLIGHT_TUNING.whaleOrbitRadiusZ
      );
      this.#direction.subVectors(this.#next, this.#whale.position).normalize();
      this.#whale.quaternion.setFromUnitVectors(FORWARD, this.#direction);
      this.#whale.rotateZ(Math.sin(orbitTime * 0.32) * 0.13);
      this.#whale.scale.setScalar(1);
    }

    const swim = Math.sin(t * 1.2);
    const flap = Math.sin(t * 0.78);
    const flapDelay = Math.sin(t * 0.78 + 0.45);
    this.#tail.rotation.y = swim * 0.16;
    this.#tail.rotation.x = Math.sin(t * 0.9 + 0.8) * 0.07;
    this.#finL.rotation.z = -0.55 + flap * 0.28;
    this.#finR.rotation.z = 0.55 - flapDelay * 0.28;
    this.#finL.rotation.x = 0.22 + Math.sin(t * 0.55 + 0.4) * 0.14;
    this.#finR.rotation.x = 0.22 + Math.sin(t * 0.55 + 0.95) * 0.14;
    this.#finL.rotation.y = 0.12 + Math.sin(t * 0.42) * 0.08;
    this.#finR.rotation.y = -0.12 - Math.sin(t * 0.42 + 0.3) * 0.08;
    this.#flukeL.rotation.x = 0.05 + Math.sin(t * 1.05) * 0.18;
    this.#flukeR.rotation.x = 0.05 + Math.sin(t * 1.05 + 0.18) * 0.18;
    this.#flukeL.rotation.z = -0.05 + swim * 0.1;
    this.#flukeR.rotation.z = 0.05 - swim * 0.1;
    this.#motes.rotation.z = t * 0.035;
    this.#motes.rotation.y = -t * 0.055;
  }

  #updateTrail(dt: number, now: number, reveal: number): void {
    this.root.updateWorldMatrix(true, true);
    this.#anchors[1].getWorldPosition(this.#tailHead);
    this.root.worldToLocal(this.#tailHead);
    if (this.#previousTail.lengthSq() > 0) {
      this.#direction.subVectors(this.#tailHead, this.#previousTail);
      const travelled = this.#direction.length();
      if (travelled > 0.0001) this.#tailDirection.copy(this.#direction).divideScalar(travelled);
      this.#trailAccumulator += travelled;
    }
    const canShed = reveal > 0.7 && this.#previousTail.lengthSq() > 0;
    if (canShed && this.#trailAccumulator >= RIBBON_SPACING) {
      this.#trailAccumulator %= RIBBON_SPACING;
      for (let i = 0; i < this.#anchors.length; i++) {
        this.#anchors[i].getWorldPosition(this.#temp);
        this.root.worldToLocal(this.#temp);
        this.#ribbons[i].add(this.#temp, this.#tailDirection, now);
      }
    }
    for (let i = 0; i < this.#anchors.length; i++) {
      if (canShed) {
        this.#anchors[i].getWorldPosition(this.#temp);
        this.root.worldToLocal(this.#temp);
        this.#ribbons[i].update(now, { position: this.#temp, direction: this.#tailDirection });
      } else {
        this.#ribbons[i].update(now, null);
      }
    }
    if (dt > 0) this.#previousTail.copy(this.#tailHead);
  }

  dispose(): void {
    for (const ribbon of this.#ribbons) ribbon.dispose();
    this.#ribbons.length = 0;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      const points = object as THREE.Points;
      if (!mesh.isMesh && !points.isPoints) return;
      const renderable = object as THREE.Mesh | THREE.Points;
      geometries.add(renderable.geometry);
      const list = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      for (const material of list) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.root.parent?.remove(this.root);
  }
}
