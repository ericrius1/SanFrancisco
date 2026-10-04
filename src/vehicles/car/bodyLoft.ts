import * as THREE from "three/webgpu";

/**
 * Lofted car shells. The side silhouette (authored in local Z/Y, front = -Z)
 * is swept through superellipse cross-sections whose half-width rounds off in
 * plan view at the nose and tail and leans inward toward the roof (tumblehome),
 * so the body reads as pressed sheet metal instead of an extruded slab. Wheel
 * wells are cut out of the outer flank only, which leaves an inner liner wall
 * behind every tyre.
 *
 * The loft also answers surface queries (flank X at a given Z/Y, nose/tail Z
 * at a given X/Y) so lamps, trim and decals can sit ON the curved panels
 * instead of floating off a flat side that no longer exists.
 */

export type LoftArch = {
  /** Axle Z. */
  z: number;
  /** Hub height. */
  y: number;
  /** Well radius (tyre radius plus clearance). */
  radius: number;
  /** Flank vertices outboard of this |X| are lifted out of the well. */
  innerX: number;
};

export type LoftSpec = {
  /** Closed side silhouette as [z, y] points. */
  profile: readonly (readonly [number, number])[];
  /** Full width at the widest station. */
  width: number;
  /** Stations along the length (cosine-spaced so the ends get the detail). */
  zSteps?: number;
  /** Vertices around each cross-section; a multiple of 4. */
  ringSteps?: number;
  /** Section superellipse exponent: 2 = ellipse, higher = boxier. */
  exponent?: number;
  /** Inward lean of the upper flank, 0..0.45. */
  tumblehome?: number;
  /** Plan-view corner radius at nose and tail (m). */
  planRadius?: number;
  arches?: readonly LoftArch[];
};

type Section = { bot: number; top: number; yc: number; h: number; w: number };

export class CarLoft {
  readonly zMin: number;
  readonly zMax: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly #profile: readonly (readonly [number, number])[];
  readonly #halfWidth: number;
  readonly #exponent: number;
  readonly #tumble: number;
  readonly #planRadius: number;
  readonly #zSteps: number;
  readonly #ringSteps: number;
  readonly #arches: readonly LoftArch[];

  constructor(spec: LoftSpec) {
    this.#profile = spec.profile;
    this.#halfWidth = spec.width / 2;
    this.#exponent = spec.exponent ?? 4;
    this.#tumble = spec.tumblehome ?? 0.12;
    this.#planRadius = spec.planRadius ?? 0.5;
    this.#zSteps = spec.zSteps ?? 40;
    this.#ringSteps = Math.max(8, Math.round((spec.ringSteps ?? 36) / 4) * 4);
    this.#arches = spec.arches ?? [];
    let zMin = Infinity, zMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const [z, y] of spec.profile) {
      zMin = Math.min(zMin, z);
      zMax = Math.max(zMax, z);
      yMin = Math.min(yMin, y);
      yMax = Math.max(yMax, y);
    }
    this.zMin = zMin;
    this.zMax = zMax;
    this.yMin = yMin;
    this.yMax = yMax;
  }

  /** Lower/upper silhouette at a station (vertical line through the polygon). */
  #envelope(zIn: number): [number, number] {
    const eps = 1e-4;
    const z = Math.min(this.zMax - eps, Math.max(this.zMin + eps, zIn));
    let lo = Infinity, hi = -Infinity;
    const pts = this.#profile;
    for (let i = 0; i < pts.length; i++) {
      const [za, ya] = pts[i];
      const [zb, yb] = pts[(i + 1) % pts.length];
      if (za === zb) continue;
      const t = (z - za) / (zb - za);
      if (t < 0 || t > 1) continue;
      const y = ya + (yb - ya) * t;
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    if (!Number.isFinite(lo)) {
      // Degenerate (only reachable on a malformed profile): collapse to the
      // nearest vertex height so the loft stays closed.
      const near = pts.reduce((best, p) => (Math.abs(p[0] - z) < Math.abs(best[0] - z) ? p : best), pts[0]);
      lo = hi = near[1];
    }
    return [lo, hi];
  }

  #planFactor(z: number): number {
    const r = this.#planRadius;
    if (r <= 0) return 1;
    const d = Math.min(z - this.zMin, this.zMax - z);
    if (d >= r) return 1;
    const k = 1 - Math.max(0, d) / r;
    return Math.sqrt(Math.max(0, 1 - k * k));
  }

  #section(z: number): Section {
    const [bot, top] = this.#envelope(z);
    return { bot, top, yc: (bot + top) / 2, h: Math.max(1e-4, (top - bot) / 2), w: this.#halfWidth * this.#planFactor(z) };
  }

  /** Outer flank |X| at (z, y); 0 when (z, y) is outside the silhouette. */
  sideX(z: number, y: number): number {
    const s = this.#section(z);
    if (y < s.bot || y > s.top) return 0;
    const ny = (y - s.yc) / s.h;
    const n = this.#exponent;
    let x = s.w * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(ny), n)), 1 / n);
    if (ny > 0) x *= 1 - this.#tumble * ny * ny;
    return x;
  }

  /** Z of the nose (end = -1) or tail (end = +1) surface at (x, y). */
  endZ(x: number, y: number, end: -1 | 1): number {
    const mid = (this.zMin + this.zMax) / 2;
    const outer = end < 0 ? this.zMin : this.zMax;
    const inside = (z: number) => Math.abs(x) <= this.sideX(z, y);
    // March in from the extreme, then bisect the first crossing.
    const steps = 160;
    let prev = outer;
    for (let i = 1; i <= steps; i++) {
      const z = outer + (mid - outer) * (i / steps);
      if (inside(z)) {
        let a = prev, b = z;
        for (let k = 0; k < 18; k++) {
          const m = (a + b) / 2;
          if (inside(m)) b = m;
          else a = m;
        }
        return b;
      }
      prev = z;
    }
    return mid;
  }

  /** Outward surface normal of the flank at (z, y) for the +X side (finite differences). */
  sideNormal(z: number, y: number, out = new THREE.Vector3()): THREE.Vector3 {
    const e = 0.02;
    const dxdz = (this.sideX(z + e, y) - this.sideX(z - e, y)) / (2 * e);
    const dxdy = (this.sideX(z, y + e) - this.sideX(z, y - e)) / (2 * e);
    return out.set(1, -dxdy, -dxdz).normalize();
  }

  /** Closed shell geometry with projected side UVs (u: tail → nose, v: up). */
  build(): THREE.BufferGeometry {
    const N = this.#zSteps;
    const M = this.#ringSteps;
    const n = this.#exponent;
    const positions: number[] = [];
    const uvs: number[] = [];
    const ySpan = Math.max(1e-4, this.yMax - this.yMin);
    const zSpan = Math.max(1e-4, this.zMax - this.zMin);
    for (let i = 0; i <= N; i++) {
      const z = this.zMin + zSpan * (0.5 - 0.5 * Math.cos((Math.PI * i) / N));
      const s = this.#section(z);
      const wells = this.#arches.filter((a) => Math.abs(z - a.z) < a.radius);
      for (let j = 0; j < M; j++) {
        const theta = (j / M) * Math.PI * 2;
        const c = Math.cos(theta);
        const sn = Math.sin(theta);
        let x = s.w * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
        const ny = Math.sign(sn) * Math.pow(Math.abs(sn), 2 / n);
        let y = s.yc + s.h * ny;
        if (ny > 0) x *= 1 - this.#tumble * ny * ny;
        for (const a of wells) {
          const dz = z - a.z;
          const archY = Math.min(a.y + Math.sqrt(a.radius * a.radius - dz * dz), s.top - 0.05);
          if (y < archY && Math.abs(x) > a.innerX) y = archY;
        }
        positions.push(x, y, z);
        uvs.push((this.zMax - z) / zSpan, (y - this.yMin) / ySpan);
      }
    }
    const index: number[] = [];
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < M; j++) {
        const a = i * M + j;
        const b = i * M + ((j + 1) % M);
        const c = (i + 1) * M + j;
        const d = (i + 1) * M + ((j + 1) % M);
        index.push(a, b, c, b, d, c);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
    // Orientation check on the roof of the middle station: flip if inward.
    const probe = Math.floor(N / 2) * M + M / 4;
    if (geometry.getAttribute("normal").getY(probe) < 0) {
      for (let k = 0; k < index.length; k += 3) {
        const t = index[k + 1];
        index[k + 1] = index[k + 2];
        index[k + 2] = t;
      }
      geometry.setIndex(index);
      geometry.computeVertexNormals();
    }
    return geometry;
  }
}

/**
 * A thin ribbon laid along a surface curve, `point(t, s)` for t∈[0,1] along
 * and s∈{0,1} across. `outward` orients the face; lamps, trim lines and
 * grilles built this way hug any curvature the loft has.
 */
export function surfaceRibbon(
  point: (t: number, s: number, out: THREE.Vector3) => THREE.Vector3,
  outward: (t: number, out: THREE.Vector3) => THREE.Vector3,
  steps = 12
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const s of [0, 1]) {
      point(t, s, p);
      positions.push(p.x, p.y, p.z);
      uvs.push(t, s);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < steps; i++) {
    const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
    index.push(a, c, b, b, c, d);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(index);
  // Face the requested side: compare the first quad's winding normal.
  const v0 = new THREE.Vector3().fromArray(positions, 0);
  const v1 = new THREE.Vector3().fromArray(positions, 3);
  const v2 = new THREE.Vector3().fromArray(positions, 6);
  const faceN = new THREE.Vector3().subVectors(v2, v0).cross(new THREE.Vector3().subVectors(v1, v0));
  if (faceN.dot(outward(0, new THREE.Vector3())) < 0) {
    for (let k = 0; k < index.length; k += 3) {
      const t = index[k + 1];
      index[k + 1] = index[k + 2];
      index[k + 2] = t;
    }
    geometry.setIndex(index);
  }
  geometry.computeVertexNormals();
  return geometry;
}
