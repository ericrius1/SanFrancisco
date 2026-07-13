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
  const fresnel = float(1).sub((normalWorld as N).dot(view).abs()).pow(shell ? 1.45 : 2.4) as N;
  const drift = mx_noise_float(
    (positionWorld as N)
      .mul(shell ? 0.095 : 0.055)
      .add(vec3(time.mul(shell ? 0.055 : -0.035), time.mul(0.02), time.mul(0.045)))
  )
    .mul(0.5)
    .add(0.5) as N;
  const crown = smoothstep(-1.0, 0.8, (positionLocal as N).y) as N;
  const cyan = color(shell ? 0x83fff0 : 0x56bcd5) as N;
  const pearl = color(shell ? 0xf8e6ff : 0xa4d8ff) as N;
  const rose = color(0xff9fcf) as N;
  const palette = mix(mix(cyan, pearl, crown), rose, drift.pow(3).mul(shell ? 0.34 : 0.16)) as N;
  const brightness = shell
    ? fresnel.mul(1.35).add(drift.mul(0.28)).add(0.08)
    : fresnel.mul(0.48).add(drift.mul(0.22)).add(0.16);

  material.colorNode = palette
    .mul(brightness)
    .mul(fadeAmount)
    .mul(LIGHT_SCALE * (shell ? 1.22 : 0.82));
  material.opacityNode = reveal
    .mul(fadeAmount)
    .mul(shell ? fresnel.mul(0.52).add(0.08) : fresnel.mul(0.18).add(0.2));
  material.transparent = true;
  material.depthWrite = false;
  material.side = shell ? THREE.BackSide : THREE.DoubleSide;
  material.blending = shell ? THREE.AdditiveBlending : THREE.NormalBlending;
  material.fog = false;
  return material;
}

function finGeometry(side: -1 | 1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        0, 0, -2.2,
        side * 8.1, -0.9, 1.0,
        side * 2.2, 0.45, 3.5,
        0, 0, -2.2,
        side * 2.2, 0.45, 3.5,
        side * 0.8, -0.25, 4.7
      ],
      3
    )
  );
  geometry.computeVertexNormals();
  return geometry;
}

function flukeGeometry(side: -1 | 1): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        0, 0, 0,
        side * 6.1, 0.35, 2.5,
        side * 4.2, -0.25, -1.8,
        0, 0, 0,
        side * 4.2, -0.25, -1.8,
        side * 1.1, 0.25, -2.5
      ],
      3
    )
  );
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

/** A translucent sky-whale assembled from authored primitives and TSL light. */
export class AfterlightSkyWhale {
  readonly root = new THREE.Group();

  #whale = new THREE.Group();
  #tail = new THREE.Group();
  #finL = new THREE.Mesh();
  #finR = new THREE.Mesh();
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
    const bodyGeometry = new THREE.SphereGeometry(1, 32, 20);
    const body = new THREE.Mesh(bodyGeometry, inner);
    body.scale.set(4.8, 2.6, 8.8);
    this.#whale.add(body);
    const bodyShell = new THREE.Mesh(bodyGeometry, shell);
    bodyShell.scale.set(5.18, 2.84, 9.42);
    this.#whale.add(bodyShell);

    const headGeometry = new THREE.SphereGeometry(1, 28, 16);
    const head = new THREE.Mesh(headGeometry, inner);
    head.position.z = -6.5;
    head.scale.set(4.65, 2.72, 4.5);
    this.#whale.add(head);
    const headShell = new THREE.Mesh(headGeometry, shell);
    headShell.position.copy(head.position);
    headShell.scale.set(4.98, 2.96, 4.82);
    this.#whale.add(headShell);

    const jaw = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), inner);
    jaw.position.set(0, -1.1, -8.45);
    jaw.scale.set(3.65, 1.05, 2.25);
    this.#whale.add(jaw);

    this.#finL = new THREE.Mesh(finGeometry(-1), inner);
    this.#finR = new THREE.Mesh(finGeometry(1), inner);
    this.#finL.position.set(-2.4, -0.35, -1.4);
    this.#finR.position.set(2.4, -0.35, -1.4);
    this.#whale.add(this.#finL, this.#finR);

    const tailStalk = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 1.75, 5.5, 16), inner);
    tailStalk.rotation.x = Math.PI / 2;
    tailStalk.position.z = 2.6;
    this.#tail.position.z = 7.8;
    this.#tail.add(tailStalk);
    const flukeL = new THREE.Mesh(flukeGeometry(-1), inner);
    const flukeR = new THREE.Mesh(flukeGeometry(1), inner);
    flukeL.position.z = flukeR.position.z = 5.2;
    this.#tail.add(flukeL, flukeR);
    this.#whale.add(this.#tail);

    const eyeMaterial = new THREE.MeshBasicNodeMaterial();
    eyeMaterial.colorNode = color(0xffe9a7)
      .mul(LIGHT_SCALE * 1.9)
      .mul(this.#reveal as N)
      .mul(this.#fade as N);
    const eyeGeometry = new THREE.SphereGeometry(0.22, 12, 8);
    for (const side of [-1, 1]) {
      const eye = new THREE.Mesh(eyeGeometry, eyeMaterial);
      eye.position.set(side * 3.55, 0.54, -8.25);
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
      [-3.2, 0.25, 7.2],
      [0, 0.8, 7.8],
      [3.2, 0.25, 7.2]
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

    const swim = Math.sin(t * 1.55);
    this.#tail.rotation.y = swim * 0.22;
    this.#tail.rotation.x = Math.sin(t * 1.1 + 0.8) * 0.06;
    this.#finL.rotation.z = -0.13 + Math.sin(t * 0.72) * 0.09;
    this.#finR.rotation.z = 0.13 - Math.sin(t * 0.72 + 0.45) * 0.09;
    this.#finL.rotation.x = 0.12 + Math.sin(t * 0.66 + 0.4) * 0.1;
    this.#finR.rotation.x = 0.12 + Math.sin(t * 0.66 + 0.9) * 0.1;
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
