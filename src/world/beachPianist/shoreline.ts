// Baker Beach performance shoreline — a quiet, bioluminescent counterpoint to
// Ocean Beach's surfable break. The mesh follows the real water mask instead
// of assuming a straight coast, then animates a few low travelling crests in
// TSL. Visible sparkle is emissive/instanced; one existing pooled PointLight is
// used as the aggregate cyan key on the pianist so the scene light set remains
// stable while this optional site streams in and out.

import * as THREE from "three/webgpu";
import {
  clamp,
  color,
  float,
  max,
  mix,
  mx_noise_float,
  positionGeometry,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { registerAmbientLightAnchor, type LightAnchorSpec } from "../../player/lightPool";
import type { WorldMap } from "../heightmap";
import { bumpNormal } from "../tslUtil";
import { BEACH_PIANIST_SITE } from "./meta";

type N = any;

const ALONG_MIN = -118;
const ALONG_MAX = 118;
const ALONG_SEGMENTS = 160;
const CROSS_SEGMENTS = 38;
const NEAR_WATER = 2.5;
const FAR_WATER = 74;
const SHORE_SCAN_MIN = -24;
const SHORE_SCAN_MAX = 108;
const SHORE_SCAN_STEP = 1;
const SPARKLE_COUNT = 144;
const TAU = Math.PI * 2;

type ShoreLayout = {
  geometry: THREE.BufferGeometry;
  shore: Float32Array;
};

type Sparkle = {
  x: number;
  distance: number;
  z: number;
  phase: number;
  twinkle: number;
  size: number;
};

function hash(n: number): number {
  const value = Math.sin(n * 91.73 + 17.17) * 43758.5453;
  return value - Math.floor(value);
}

function localToWorld(localX: number, localZ: number, out: THREE.Vector2): THREE.Vector2 {
  const c = Math.cos(BEACH_PIANIST_SITE.yaw);
  const s = Math.sin(BEACH_PIANIST_SITE.yaw);
  return out.set(
    BEACH_PIANIST_SITE.x + c * localX + s * localZ,
    BEACH_PIANIST_SITE.z - s * localX + c * localZ
  );
}

function firstWaterAt(map: WorldMap, localX: number, scratch: THREE.Vector2): number {
  for (let localZ = SHORE_SCAN_MIN; localZ <= SHORE_SCAN_MAX; localZ += SHORE_SCAN_STEP) {
    localToWorld(localX, localZ, scratch);
    if (!map.isWater(scratch.x, scratch.y)) continue;
    // The generated water mask is an 8 m lattice. Requiring another wet sample
    // offshore rejects single-cell edge flecks that would kink a crest ribbon.
    localToWorld(localX, localZ + 4, scratch);
    if (map.isWater(scratch.x, scratch.y)) return localZ;
  }
  return SHORE_SCAN_MAX;
}

function smoothShoreline(values: Float32Array): Float32Array {
  let source = values;
  for (let pass = 0; pass < 4; pass++) {
    const next = new Float32Array(source.length);
    next[0] = source[0];
    next[next.length - 1] = source[source.length - 1];
    for (let i = 1; i < source.length - 1; i++) {
      next[i] = source[i - 1] * 0.25 + source[i] * 0.5 + source[i + 1] * 0.25;
    }
    source = next;
  }
  return source;
}

function buildShoreLayout(map: WorldMap, seaY: number): ShoreLayout {
  const nx = ALONG_SEGMENTS + 1;
  const nz = CROSS_SEGMENTS + 1;
  const scratch = new THREE.Vector2();
  const rawShore = new Float32Array(nx);
  for (let i = 0; i < nx; i++) {
    const x = THREE.MathUtils.lerp(ALONG_MIN, ALONG_MAX, i / ALONG_SEGMENTS);
    rawShore[i] = firstWaterAt(map, x, scratch);
  }
  const shore = smoothShoreline(rawShore);
  const positions = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const indices: number[] = [];

  for (let j = 0; j < nz; j++) {
    const v = j / CROSS_SEGMENTS;
    // A slight quadratic bias gives the shore wash extra rows while the open
    // water, where only thin glints remain, can be coarser.
    const distance = THREE.MathUtils.lerp(NEAR_WATER, FAR_WATER, 0.62 * v + 0.38 * v * v);
    for (let i = 0; i < nx; i++) {
      const u = i / ALONG_SEGMENTS;
      const x = THREE.MathUtils.lerp(ALONG_MIN, ALONG_MAX, u);
      const k = (j * nx + i) * 3;
      positions[k] = x;
      positions[k + 1] = seaY;
      positions[k + 2] = shore[i] + distance;
      const uvIndex = (j * nx + i) * 2;
      uvs[uvIndex] = u;
      uvs[uvIndex + 1] = v;
    }
  }

  for (let j = 0; j < CROSS_SEGMENTS; j++) {
    for (let i = 0; i < ALONG_SEGMENTS; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return { geometry, shore };
}

function shoreAt(shore: Float32Array, localX: number): number {
  const u = THREE.MathUtils.clamp((localX - ALONG_MIN) / (ALONG_MAX - ALONG_MIN), 0, 1);
  const scaled = u * ALONG_SEGMENTS;
  const i = Math.min(ALONG_SEGMENTS - 1, Math.floor(scaled));
  return THREE.MathUtils.lerp(shore[i], shore[i + 1], scaled - i);
}

export class PianistShoreline {
  readonly group = new THREE.Group();

  #time = uniform(0);
  #seaY: number;
  #surface: THREE.Mesh;
  #sparkleGeometry: THREE.BufferGeometry;
  #sparkleMaterial: THREE.MeshBasicNodeMaterial;
  #sparkles: THREE.InstancedMesh;
  #sparkleLayout: Sparkle[] = [];
  #matrix = new THREE.Matrix4();
  #position = new THREE.Vector3();
  #quaternion = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #fillSpec: LightAnchorSpec = {
    color: 0x6edfff,
    intensity: 0,
    distance: 10,
    range: 240
  };
  #fillAnchor = new THREE.Object3D();
  #unregisterFill: () => void;

  constructor(map: WorldMap, seaY: number) {
    this.#seaY = seaY;
    this.group.name = "beachPianist.bioluminescentShoreline";

    const layout = buildShoreLayout(map, seaY);
    const material = this.#buildSurfaceMaterial();
    this.#surface = new THREE.Mesh(layout.geometry, material);
    this.#surface.name = "beachPianist.gentleLappingWaves";
    this.#surface.renderOrder = 12.6;
    this.#surface.frustumCulled = false;
    this.#surface.castShadow = false;
    this.#surface.receiveShadow = false;
    this.group.add(this.#surface);

    this.#sparkleGeometry = new THREE.OctahedronGeometry(0.06, 0);
    this.#sparkleMaterial = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    });
    this.#sparkleMaterial.colorNode = color(0x8cfff0).mul(1.05 * LIGHT_SCALE);
    this.#sparkleMaterial.opacity = 0.92;
    this.#sparkles = new THREE.InstancedMesh(
      this.#sparkleGeometry,
      this.#sparkleMaterial,
      SPARKLE_COUNT
    );
    this.#sparkles.name = "beachPianist.bioluminescentSparkles";
    this.#sparkles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#sparkles.renderOrder = 12.7;
    this.#sparkles.frustumCulled = false;
    this.#sparkles.castShadow = false;
    this.#sparkles.receiveShadow = false;
    this.#buildSparkleLayout(layout.shore);
    this.#writeSparkles(0);
    this.group.add(this.#sparkles);

    // One soft cyan key, supplied by the stable scene-wide light pool. It hangs
    // above and just in front of the bench so the whole glowing shoreline reads
    // as one broad performance light across the pianist and piano lid.
    this.#fillAnchor.name = "beachPianist.bioluminescentKeyLight";
    this.#fillAnchor.userData.lightSpec = this.#fillSpec;
    this.#fillAnchor.position.set(-1.3, 4.7, -0.55);
    this.group.add(this.#fillAnchor);
    this.#unregisterFill = registerAmbientLightAnchor(this.#fillAnchor);
  }

  #buildSurfaceMaterial(): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial({
      roughness: 0.42,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    const t = this.#time as N;
    const v = uv().y.toVar();
    const along = positionGeometry.x;
    const distance = mix(float(NEAR_WATER), float(FAR_WATER), v.mul(0.62).add(v.mul(v).mul(0.38))).toVar();
    const bend = sin(along.mul(0.027).add(t.mul(0.09))).mul(0.72);
    // Constant phase travels toward decreasing shore distance as time advances.
    // Fifteen-metre spacing and ~1.8 m/s travel keep this a lap, not a surf set.
    const primary = sin(distance.mul(0.42).add(t.mul(0.76)).add(bend)).toVar();
    const cross = sin(
      distance.mul(0.78)
        .add(along.mul(0.052))
        .add(t.mul(1.05))
        .add(bend.mul(0.4))
    ).toVar();
    const shoreShape = smoothstep(0.01, 0.1, v)
      .mul(smoothstep(1, 0.58, v))
      .add(smoothstep(0.15, 0.01, v).mul(0.42))
      .toVar();
    const height = primary.mul(0.105)
      .add(cross.mul(0.028))
      .mul(shoreShape)
      .add(0.042)
      .toVar();
    material.positionNode = positionGeometry.add(vec3(0, height, 0));

    const wave01 = primary.mul(0.5).add(0.5).toVar();
    const crest = smoothstep(0.56, 0.93, wave01)
      .mul(smoothstep(1, 0.07, v))
      .toVar();
    const wash = smoothstep(0.2, 0.015, v)
      .mul(smoothstep(-0.28, 0.78, primary))
      .toVar();
    const breakNoise = mx_noise_float(
      vec3(along.mul(0.19), distance.mul(0.31), t.mul(0.42))
    ).mul(0.5).add(0.5).toVar();
    const foam = clamp(
      crest.mul(breakNoise.mul(0.5).add(0.5))
        .add(wash.mul(0.74)),
      0,
      1
    ).toVar();
    const sparkle = smoothstep(
      0.68,
      0.97,
      breakNoise.mul(0.72).add(crest.mul(0.43))
    ).mul(crest.mul(0.74).add(wash.mul(0.38))).toVar();

    const waterColor = mix(color(0x0a5a65), color(0x65dcca), crest.mul(0.72));
    material.colorNode = mix(waterColor, color(0xd3fff6), foam.mul(0.72));
    material.emissiveNode = vec3(0.09, 1.0, 0.82)
      .mul(max(crest.mul(0.24), sparkle))
      .mul(0.86 * LIGHT_SCALE)
      .add(vec3(0.18, 0.72, 0.68).mul(wash.mul(0.18 * LIGHT_SCALE)));
    material.normalNode = bumpNormal(height.add(breakNoise.mul(0.014)));
    material.roughnessNode = mix(float(0.38), float(0.74), foam);

    const alongEdge = smoothstep(0.0, 0.055, uv().x)
      .mul(smoothstep(1.0, 0.945, uv().x));
    const farEdge = smoothstep(1.0, 0.77, v);
    material.opacityNode = clamp(
      float(0.025)
        .add(foam.mul(0.48))
        .add(sparkle.mul(0.72)),
      0,
      0.9
    ).mul(alongEdge).mul(farEdge);
    material.envMapIntensity = 0.18;
    return material;
  }

  #buildSparkleLayout(shore: Float32Array): void {
    for (let i = 0; i < SPARKLE_COUNT; i++) {
      // A low-discrepancy stride avoids rows while keeping the layout stable.
      const x = THREE.MathUtils.lerp(ALONG_MIN + 5, ALONG_MAX - 5, hash(i * 13 + 1));
      const distance = THREE.MathUtils.lerp(4, 58, Math.pow(hash(i * 17 + 4), 1.18));
      this.#sparkleLayout.push({
        x,
        distance,
        z: shoreAt(shore, x) + distance,
        phase: hash(i * 19 + 7) * TAU,
        twinkle: 2.2 + hash(i * 23 + 9) * 3.8,
        size: 0.65 + hash(i * 29 + 11) * 1.7
      });
    }
  }

  #writeSparkles(time: number): void {
    for (let i = 0; i < this.#sparkleLayout.length; i++) {
      const sparkle = this.#sparkleLayout[i];
      const bend = Math.sin(sparkle.x * 0.027 + time * 0.09) * 0.72;
      const wave = Math.sin(sparkle.distance * 0.42 + time * 0.76 + bend);
      const crest = THREE.MathUtils.smoothstep(wave, 0.22, 0.96);
      const twinkle = 0.3 + 0.7 * Math.max(0, Math.sin(time * sparkle.twinkle + sparkle.phase));
      const breathe = 0.78 + 0.22 * Math.sin(time * 0.44 + sparkle.phase * 0.31);
      const amount = crest * crest * twinkle * breathe;
      const scale = 0.001 + sparkle.size * amount;
      this.#position.set(
        sparkle.x,
        this.#seaY + 0.08 + wave * 0.095 + amount * 0.035,
        sparkle.z
      );
      this.#scale.setScalar(scale);
      this.#matrix.compose(this.#position, this.#quaternion, this.#scale);
      this.#sparkles.setMatrixAt(i, this.#matrix);
    }
    this.#sparkles.instanceMatrix.needsUpdate = true;
  }

  update(elapsed: number, active: boolean): void {
    this.group.visible = active;
    if (!active) {
      this.#fillSpec.intensity = 0;
      return;
    }
    this.#time.value = elapsed;
    this.#writeSparkles(elapsed);
    // The pool owns the sole real light. Tiny variations make it feel like an
    // aggregate of many living flecks without visibly pulsing the performer.
    this.#fillSpec.intensity =
      14 + Math.sin(elapsed * 0.44) * 0.9 + Math.sin(elapsed * 0.19 + 1.7) * 0.45;
  }

  get debugState() {
    return {
      visible: this.group.visible,
      sparkleCount: SPARKLE_COUNT,
      lightCount: this.#fillSpec.intensity > 0 ? 1 : 0,
      lightIntensity: this.#fillSpec.intensity,
      waveHeight: 0.105,
      waveSpacing: TAU / 0.42
    };
  }

  dispose(): void {
    this.#fillSpec.intensity = 0;
    this.#unregisterFill();
    this.#surface.geometry.dispose();
    (this.#surface.material as THREE.Material).dispose();
    this.#sparkleGeometry.dispose();
    this.#sparkleMaterial.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
