import * as THREE from "three/webgpu";
import { vec3, uv, smoothstep, mx_noise_float, instancedBufferAttribute } from "three/tsl";
import { LIGHT_SCALE } from "../config";

type N = any;

const MAX_SPLATS = 4096;
const RATE = 34; // splats per second while the can is held
const LIFT = 0.06; // metres off the surface — enough for reversed-z, invisible to the eye

/** The nine swatches the toolbar shows; the last one is rainbow (hue cycles per splat). */
export const PAINT_COLORS = [0xff2e88, 0xff7a1a, 0xffd41f, 0x3dffb0, 0x29d5ff, 0x8f5bff, 0xf4f7ff, 0x16181d] as const;
export const RAINBOW_INDEX = PAINT_COLORS.length;

/**
 * The procedural splat, shared by the world graffiti layer and the paint
 * skins that ride vehicles/players (fx/paintball.ts). `tint` is a vec4
 * per-instance attribute: rgb + signed seed (negative = no drips).
 */
export function splatShade(tint: N): { colorNode: N; opacityNode: N } {
  const seed = tint.w.abs();
  const drips = tint.w.sign().max(0.0);

  const p = (uv() as N).mul(2).sub(1); // -1..1 across the quad, +y up in splat space
  const r = p.length();

  // blob body: noise pushes the rim in and out so no two splats share a silhouette
  const rimNoise = mx_noise_float(vec3(p.x.mul(2.2), p.y.mul(2.2), seed.mul(57.0)));
  const rim = rimNoise.mul(0.24).add(0.62);
  const blob = smoothstep(rim, rim.mul(0.5), r);

  // overspray: a speckle ring just outside the body
  const spk = smoothstep(0.45, 0.75, mx_noise_float(vec3(p.x.mul(7.5), p.y.mul(7.5), seed.mul(91.0))))
    .mul(smoothstep(1.05, 0.5, r))
    .mul(0.8);

  // drips: noise over x picks the columns, each column's strength sets its length
  const colNoise = mx_noise_float(vec3(p.x.mul(9.0), seed.mul(133.0), 1.7));
  const colStrength = smoothstep(0.3, 0.75, colNoise);
  const dripLen = colStrength.mul(0.85);
  const drip = colStrength
    .mul(smoothstep(0.05, -0.05, p.y)) // below the blob's midline
    .mul(smoothstep(dripLen.negate(), dripLen.negate().add(0.3), p.y)) // taper at the tip
    .mul(smoothstep(0.75, 0.45, p.x.abs())) // stay under the body
    .mul(drips);

  const alpha = blob.add(spk.mul(blob.oneMinus())).add(drip.mul(0.95)).clamp(0.0, 1.0).mul(0.95);

  // slight value variation so big painted areas don't read as flat fill
  const grain = mx_noise_float(vec3(p.x.mul(3.7), p.y.mul(3.7), seed.mul(11.0))).mul(0.18).add(0.9);
  return { colorNode: tint.xyz.mul(grain).mul(LIGHT_SCALE * 0.55), opacityNode: alpha };
}

/**
 * Spray paint: one InstancedMesh of quads stuck to whatever surface the ray
 * hit, oldest overwritten ring-buffer style. The splat itself is procedural —
 * a noise-wobbled blob with overspray speckle, plus drips that only walls get
 * (their quads are gravity-aligned so local -y is world down; the drip flag
 * rides in the sign of the per-instance seed).
 */
export class Graffiti {
  mesh: THREE.InstancedMesh;
  colorIndex = 0;

  #tint: THREE.InstancedBufferAttribute; // rgb + signed seed (negative = no drips)
  #write = 0;
  #carry = 0; // fractional splats owed from previous frames
  #hue = 0; // rainbow cycle
  #mat4 = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #x = new THREE.Vector3();
  #y = new THREE.Vector3();
  #z = new THREE.Vector3();
  #tmp = new THREE.Vector3();
  #col = new THREE.Color();

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    this.#tint = new THREE.InstancedBufferAttribute(new Float32Array(MAX_SPLATS * 4), 4);
    this.#tint.setUsage(THREE.DynamicDrawUsage);

    const mat = new THREE.MeshBasicNodeMaterial();
    const tint = instancedBufferAttribute(this.#tint) as unknown as N;
    const shade = splatShade(tint);
    mat.colorNode = shade.colorNode;
    mat.opacityNode = shade.opacityNode;
    mat.transparent = true;
    mat.depthWrite = false;
    mat.fog = true;

    this.mesh = new THREE.InstancedMesh(geo, mat, MAX_SPLATS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Feed one frame of held spray at the ray hit. Call only on a hit. */
  spray(point: THREE.Vector3, normal: THREE.Vector3, dt: number) {
    this.#carry += RATE * dt;
    let n = Math.floor(this.#carry);
    this.#carry -= n;
    while (n-- > 0) this.#stamp(point, normal, this.nextColor(), 0.7 + Math.random() * 1.1, 1.1);
  }

  /**
   * One paintball impact: a fat central splat plus a few satellite droplets.
   * Color comes from the shot (net paint carries the shooter's color), not
   * from the local palette selection.
   */
  burst(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color) {
    this.#stamp(point, normal, color, 1.15 + Math.random() * 0.6, 0.3);
    const drops = 2 + ((Math.random() * 2) | 0);
    for (let i = 0; i < drops; i++) this.#stamp(point, normal, color, 0.3 + Math.random() * 0.4, 2.6);
  }

  /**
   * Resolve the currently selected paint (advances the rainbow cycle).
   * Returns the shared #col instance — read it now, never retain it.
   */
  nextColor(): THREE.Color {
    if (this.colorIndex === RAINBOW_INDEX) {
      this.#hue = (this.#hue + 0.061) % 1;
      return this.#col.setHSL(this.#hue, 0.95, 0.6);
    }
    return this.#col.set(PAINT_COLORS[this.colorIndex]);
  }

  #stamp(point: THREE.Vector3, normal: THREE.Vector3, color: THREE.Color, size: number, scatter: number) {
    const i = this.#write;
    this.#write = (this.#write + 1) % MAX_SPLATS;
    this.mesh.count = Math.max(this.mesh.count, Math.min(MAX_SPLATS, i + 1));

    const wall = Math.abs(normal.y) < 0.55;
    this.#z.copy(normal);
    if (wall) {
      // gravity-aligned: local +y = world up projected onto the wall, so the
      // shader's drips run toward the street (plus a little human wobble)
      this.#y.set(0, 1, 0).addScaledVector(normal, -normal.y).normalize();
      this.#y.applyAxisAngle(this.#z, (Math.random() - 0.5) * 0.35).normalize();
    } else {
      const a = Math.random() * Math.PI * 2;
      // any tangent will do on ground/roof — no drips there
      this.#tmp.set(Math.cos(a), 0, Math.sin(a));
      this.#y.crossVectors(this.#z, this.#tmp).normalize();
      if (this.#y.lengthSq() < 0.5) this.#y.set(1, 0, 0);
    }
    this.#x.crossVectors(this.#y, this.#z).normalize();
    this.#mat4.makeBasis(this.#x, this.#y, this.#z);

    this.#mat4.scale(this.#tmp.set(size, size, 1));
    // scatter within the spray cone's footprint
    this.#pos
      .copy(point)
      .addScaledVector(this.#x, (Math.random() - 0.5) * scatter)
      .addScaledVector(this.#y, (Math.random() - 0.5) * scatter)
      .addScaledVector(normal, LIFT + Math.random() * 0.015);
    this.#mat4.setPosition(this.#pos);
    this.mesh.setMatrixAt(i, this.#mat4);

    const seed = 0.05 + Math.random() * 0.95;
    const dripSign = wall && Math.random() < 0.65 ? 1 : -1;
    this.#tint.setXYZW(i, color.r, color.g, color.b, seed * dripSign);

    this.mesh.instanceMatrix.needsUpdate = true;
    this.#tint.needsUpdate = true;
  }
}
