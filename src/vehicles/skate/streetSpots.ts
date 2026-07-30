import * as THREE from "three/webgpu";
import { mergeVertexColoredParts } from "../shared";
import type { WorldMap } from "../../world/heightmap";
import { registerGrindRails, unregisterGrindRails, type GrindRail } from "./rails";

/**
 * The city, made skateable.
 *
 * San Francisco is a hundred square kilometres of streets with nothing to grind
 * on, and hand-placing a rail every fifty metres is not a thing anyone can
 * author. So the street furniture is GENERATED around the player, and only
 * while they are actually on a skateboard: a deterministic hash over a lattice
 * decides which cells hold a spot, how long it is, and which way it faces, so
 * the same corner always has the same rail — it just doesn't exist until
 * someone rolls up to it.
 *
 * These are LONG. Forty to a hundred metres, following the ground as a smoothed
 * polyline rather than sitting on a flat pad, so half of them run down a hill
 * and pick up speed the way a real handrail beside a Sanchez Street staircase
 * does. Half are laid along the contour (level), half straight down the fall
 * line (steep) — a level rail and a plunging one are completely different
 * tricks, and the city already supplies both.
 *
 * Each spot merges into ONE vertex-coloured geometry: at this length a rail is
 * a dozen bars and fifty posts, and fifteen resident spots would otherwise be
 * seven hundred draw calls.
 *
 * Deliberately no colliders. A rail you can roll through if you flub the ollie
 * is a much smaller sin than a rail that wedges the physics body — see the
 * skatepark's ground-overlay notes for how that failure actually looks.
 */

/** Lattice pitch. Big, because the rails themselves are big. */
const CELL = 110;
/** Build spots inside this radius, drop them past `UNLOAD`. */
const LOAD = 230;
const UNLOAD = 330;
/** Cells whose hash clears this get a spot. */
const DENSITY = 0.55;
/** Polyline node spacing — the rail bends to the hill every this many metres. */
const SPAN = 7;
const RAIL_LIFT = 0.08;
const OWNER = "skate-street";
/** Steeper than this per span and it stops being a rail and starts being a cliff. */
const MAX_GRADE = 0.62;

type SpotKind = "flatbar" | "highbar" | "hubba";

type Spot = {
  key: string;
  x: number;
  z: number;
  mesh: THREE.Mesh;
  rails: GrindRail[];
};

/** Stable, cheap 2D integer hash → [0, 1). */
function hash2(ix: number, iz: number, salt: number): number {
  let h = Math.imul(ix | 0, 0x27d4eb2d) ^ Math.imul(iz | 0, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
  h ^= h >>> 15;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

export class SkateStreetSpots {
  readonly group = new THREE.Group();
  #map: WorldMap;
  #spots = new Map<string, Spot>();
  #active = false;
  #lastCellX = Number.NaN;
  #lastCellZ = Number.NaN;
  /** A scan that hit its per-frame build cap has cells left to look at. */
  #scanPending = false;
  #material: THREE.MeshStandardMaterial;
  #barGeo: THREE.CylinderGeometry;
  #postGeo: THREE.CylinderGeometry;
  #footGeo: THREE.BoxGeometry;
  #disposed = false;

  constructor(map: WorldMap) {
    this.#map = map;
    this.group.name = "skate_street_spots";
    this.group.visible = false;
    // One material for every rail in the city; steel vs footing comes from the
    // baked vertex colours.
    this.#material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.3,
      metalness: 0.7
    });
    // Unit primitives, posed then baked into each spot's merged geometry.
    this.#barGeo = new THREE.CylinderGeometry(0.05, 0.05, 1, 8, 1, true);
    this.#postGeo = new THREE.CylinderGeometry(0.038, 0.045, 1, 6);
    this.#footGeo = new THREE.BoxGeometry(0.26, 0.05, 0.26);
  }

  /** Street spots exist only while a skateboard does. */
  setActive(active: boolean) {
    if (this.#active === active || this.#disposed) return;
    this.#active = active;
    this.group.visible = active;
    if (!active) this.#clear();
    this.#lastCellX = Number.NaN;
  }

  get active(): boolean {
    return this.#active;
  }

  get spotCount(): number {
    return this.#spots.size;
  }

  /** Total registered grind segments — long rails contribute many. */
  get segmentCount(): number {
    let n = 0;
    for (const s of this.#spots.values()) n += s.rails.length;
    return n;
  }

  /** Per frame while skating. Rebuilds only when there is work to do. */
  update(x: number, z: number) {
    if (!this.#active || this.#disposed) return;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    // Re-scan on a cell change, or whenever the last scan ran out of budget
    // before it reached the far cells — otherwise standing still next to
    // unbuilt candidates leaves them unbuilt forever.
    if (cx === this.#lastCellX && cz === this.#lastCellZ && !this.#scanPending) return;
    this.#lastCellX = cx;
    this.#lastCellZ = cz;
    this.#scanPending = false;

    const reach = Math.ceil(LOAD / CELL);
    let added = 0;
    for (let iz = cz - reach; iz <= cz + reach && !this.#scanPending; iz++) {
      for (let ix = cx - reach; ix <= cx + reach; ix++) {
        const key = `${ix}:${iz}`;
        if (this.#spots.has(key)) continue;
        const spot = this.#considerCell(ix, iz, x, z);
        if (spot) {
          this.#spots.set(key, spot);
          added++;
        }
        // One rail per frame. Building a 90 m polyline plus its merge is real
        // work, and crossing a cell must never cost a frame.
        if (added >= 1) {
          this.#scanPending = true;
          break;
        }
      }
    }

    for (const [key, spot] of this.#spots) {
      if (Math.hypot(spot.x - x, spot.z - z) <= UNLOAD) continue;
      this.#drop(key, spot);
    }
    this.#publish();
  }

  #considerCell(ix: number, iz: number, px: number, pz: number): Spot | null {
    if (hash2(ix, iz, 1) > DENSITY) return null;
    // Jitter inside the cell so the lattice never reads as a grid.
    const x = (ix + 0.15 + hash2(ix, iz, 2) * 0.7) * CELL;
    const z = (iz + 0.15 + hash2(ix, iz, 3) * 0.7) * CELL;
    if (Math.hypot(x - px, z - pz) > LOAD) return null;
    if (this.#map.isWater(x, z)) return null;

    const roll = hash2(ix, iz, 5);
    const kind: SpotKind = roll < 0.42 ? "flatbar" : roll < 0.74 ? "highbar" : "hubba";
    const height = kind === "flatbar" ? 0.4 : kind === "highbar" ? 0.66 : 0.52;
    const length = 38 + hash2(ix, iz, 6) * 62; // 38 → 100 m

    // Contour or fall line. A level rail and one that plunges down a hill are
    // different tricks; the city has the gradients, so use both.
    const gx = this.#map.effectiveGround(x + 6, z) - this.#map.effectiveGround(x - 6, z);
    const gz = this.#map.effectiveGround(x, z + 6) - this.#map.effectiveGround(x, z - 6);
    const gradeLen = Math.hypot(gx, gz);
    const downhill = hash2(ix, iz, 4) < 0.5 && gradeLen > 0.25;
    const yaw = downhill
      ? Math.atan2(gx, gz) + Math.PI // straight down the fall line
      : gradeLen > 0.05
        ? Math.atan2(gz, gx) // across it, so the rail sits level
        : hash2(ix, iz, 8) * Math.PI;

    // Walk the polyline, sampling the ground.
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    const nodes = Math.max(3, Math.round(length / SPAN));
    const sx = x - (dirX * length) / 2;
    const sz = z - (dirZ * length) / 2;
    const gy: number[] = [];
    for (let i = 0; i <= nodes; i++) {
      const t = (i / nodes) * length;
      const nx = sx + dirX * t;
      const nz = sz + dirZ * t;
      if (this.#map.isWater(nx, nz)) return null;
      gy.push(this.#map.effectiveGround(nx, nz));
    }
    // Smooth once: the rail should follow the hill, not every kerb and pothole.
    const smooth = gy.slice();
    for (let i = 1; i < gy.length - 1; i++) smooth[i] = (gy[i - 1] + gy[i] * 2 + gy[i + 1]) / 4;
    // Reject anything that turned into a staircase or a cliff.
    for (let i = 1; i < smooth.length; i++) {
      if (Math.abs(smooth[i] - smooth[i - 1]) / SPAN > MAX_GRADE) return null;
    }

    // --- geometry: bars + posts, baked into one mesh --------------------
    const parts: THREE.Mesh[] = [];
    const rails: GrindRail[] = [];
    const steel = new THREE.Color(0xbcc6cc);
    const dark = new THREE.Color(0x2b3138);
    const colours = new Map<THREE.Mesh, THREE.Color>();
    const baseY = smooth[0];
    for (let i = 0; i < smooth.length - 1; i++) {
      const t0 = (i / nodes) * length;
      const t1 = ((i + 1) / nodes) * length;
      const ax = dirX * t0;
      const az = dirZ * t0;
      const bx = dirX * t1;
      const bz = dirZ * t1;
      const ay = smooth[i] - baseY + height;
      const by = smooth[i + 1] - baseY + height;

      const dx = bx - ax;
      const dy = by - ay;
      const dz = bz - az;
      const len = Math.hypot(dx, dy, dz);
      const bar = new THREE.Mesh(this.#barGeo);
      bar.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
      bar.scale.set(1, len, 1);
      bar.quaternion.setFromUnitVectors(UP, TMP.set(dx / len, dy / len, dz / len));
      parts.push(bar);
      colours.set(bar, steel);

      // A post at every node, standing on whatever the ground is doing there.
      const groundHere = smooth[i] - baseY;
      const stand = Math.max(0.1, ay - groundHere);
      const post = new THREE.Mesh(this.#postGeo);
      post.position.set(ax, groundHere + stand / 2, az);
      post.scale.set(1, stand, 1);
      parts.push(post);
      colours.set(post, steel);
      const foot = new THREE.Mesh(this.#footGeo);
      foot.position.set(ax, groundHere + 0.025, az);
      parts.push(foot);
      colours.set(foot, dark);

      rails.push({
        id: `${OWNER}:${ix}:${iz}:${i}`,
        ax: sx + ax,
        ay: baseY + ay,
        az: sz + az,
        bx: sx + bx,
        by: baseY + by,
        bz: sz + bz,
        kind: kind === "hubba" ? "ledge" : "rail",
        lift: RAIL_LIFT
      });
    }

    const merged = mergeVertexColoredParts(parts, (m) => ({ color: colours.get(m) ?? steel }));
    if (!merged) return null;
    const mesh = new THREE.Mesh(merged, this.#material);
    mesh.position.set(sx, baseY, sz);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return { key: `${ix}:${iz}`, x, z, mesh, rails };
  }

  #drop(key: string, spot: Spot) {
    this.group.remove(spot.mesh);
    spot.mesh.geometry.dispose();
    this.#spots.delete(key);
  }

  #clear() {
    for (const [key, spot] of this.#spots) this.#drop(key, spot);
    unregisterGrindRails(OWNER);
  }

  /** Re-register the whole street set (the registry is owner-keyed). */
  #publish() {
    const all: GrindRail[] = [];
    for (const spot of this.#spots.values()) for (const r of spot.rails) all.push(r);
    registerGrindRails(OWNER, all);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clear();
    this.group.removeFromParent();
    this.#barGeo.dispose();
    this.#postGeo.dispose();
    this.#footGeo.dispose();
    this.#material.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const TMP = new THREE.Vector3();
