// Player-following foliage field. A toroidal float texture keeps the ecological
// inputs needed by GPU vegetation in one world-stable, paged cache: terrain
// height, density/keep, species/style and height vigour. Only newly entering
// rows/columns are sampled when the player walks; a teleport rebuilds the square
// progressively through the shared frame scheduler.
//
// Resolution is per-instance. The blade field stays at the 1 m / 288-cell grid
// the grass ladder was tuned against; the wildflower ring pages its own coarser,
// wider pair of squares, because clump and drift features span tens of metres and
// the source terrain lattice is 8 m anyway — so its 2.5 m near square plus a 12 m
// horizon square cost half the blade field's cells while reaching seven times
// further out.

import * as THREE from "three/webgpu";
import { valueNoise } from "./scatter";

export const FOLIAGE_FIELD_SPACING = 1;
export const FOLIAGE_FIELD_SIZE = 288;
export const FOLIAGE_FIELD_HALF_EXTENT = FOLIAGE_FIELD_SIZE * FOLIAGE_FIELD_SPACING * 0.5;

const DEFAULT_SLICE_MS = 0.8;
const MAX_CELLS_PER_SLICE = 256;

export type FoliageFieldPaint = Readonly<{
  /** 0 removes foliage; 1 is the authored default density. */
  density: number;
  /** Normalized style/species selector consumed by GPU placement. */
  species: number;
  /** Normalized multiplier for the generated plant height. */
  height: number;
}>;

export type FoliageFieldBuildJob = () => void | "again";

export type FoliageFieldOptions = Readonly<{
  groundHeight(x: number, z: number): number;
  plantable(x: number, z: number): boolean;
  /** Optional authored paint layer composed over the procedural ecology. */
  paint?: (x: number, z: number) => Partial<FoliageFieldPaint> | null;
  schedule?: (job: FoliageFieldBuildJob) => void;
  now?: () => number;
  sliceBudgetMs?: number;
  /** Cells per side (default FOLIAGE_FIELD_SIZE). */
  size?: number;
  /** World metres per cell (default FOLIAGE_FIELD_SPACING). */
  spacing?: number;
  /** Hard cell ceiling for one sampling turn, alongside `sliceBudgetMs`. Raise it
   *  with the budget for a field whose full rebuild gates a world arrival. */
  maxCellsPerSlice?: number;
}>;

export type FoliageFieldStats = Readonly<{
  generation: number;
  ready: boolean;
  pendingCells: number;
  sampledCells: number;
  fullRebuilds: number;
  slabUpdates: number;
  uploadedBytes: number;
  centerX: number;
  centerZ: number;
}>;

type Cell = Readonly<{ x: number; z: number }>;

type Build = {
  id: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cells: Cell[];
  cursor: number;
  full: boolean;
  promise: Promise<void>;
  resolve: () => void;
};

const positiveModulo = (value: number, divisor: number): number =>
  ((value % divisor) + divisor) % divisor;

/**
 * A lazy, toroidal clipmap. Texture channels are:
 *   R world height · G density/keep · B species/style · A height multiplier.
 */
export class FoliageField {
  readonly texture: THREE.DataTexture;
  readonly data: Float32Array;
  /** Cells per side of the toroidal square. */
  readonly size: number;
  /** World metres per cell. */
  readonly spacing: number;

  readonly #options: FoliageFieldOptions;
  readonly #now: () => number;
  readonly #sliceBudgetMs: number;
  readonly #maxCellsPerSlice: number;
  readonly #schedule: (job: FoliageFieldBuildJob) => void;
  #generation = 0;
  #build: Build | null = null;
  #disposed = false;
  #valid = false;
  #minX = 0;
  #maxX = -1;
  #minZ = 0;
  #maxZ = -1;
  #sampledCells = 0;
  #fullRebuilds = 0;
  #slabUpdates = 0;
  #uploadedBytes = 0;

  constructor(options: FoliageFieldOptions) {
    this.#options = options;
    this.size = Math.max(2, Math.floor(options.size ?? FOLIAGE_FIELD_SIZE));
    this.spacing = Math.max(0.05, options.spacing ?? FOLIAGE_FIELD_SPACING);
    this.data = new Float32Array(this.size * this.size * 4);
    this.#now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.#sliceBudgetMs = Math.max(0.1, options.sliceBudgetMs ?? DEFAULT_SLICE_MS);
    this.#maxCellsPerSlice = Math.max(16, Math.floor(options.maxCellsPerSlice ?? MAX_CELLS_PER_SLICE));
    this.#schedule = options.schedule ?? ((job) => {
      const run = () => {
        if (job() === "again") setTimeout(run, 0);
      };
      setTimeout(run, 0);
    });

    this.texture = new THREE.DataTexture(
      this.data,
      this.size,
      this.size,
      THREE.RGBAFormat,
      THREE.FloatType
    );
    this.texture.name = "foliage-density-clipmap";
    this.texture.wrapS = THREE.RepeatWrapping;
    this.texture.wrapT = THREE.RepeatWrapping;
    // Compute consumers perform their own bilinear height sampling with
    // textureLoad. Nearest keeps RGBA32F legal on adapters that do not expose
    // the optional float32-filterable feature.
    this.texture.minFilter = THREE.NearestFilter;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.generateMipmaps = false;
  }

  /** World-space square currently guaranteed valid for GPU sampling. */
  get bounds(): Readonly<{ minX: number; maxX: number; minZ: number; maxZ: number }> {
    return {
      minX: this.#minX * this.spacing,
      maxX: this.#maxX * this.spacing,
      minZ: this.#minZ * this.spacing,
      maxZ: this.#maxZ * this.spacing
    };
  }

  get stats(): FoliageFieldStats {
    return {
      generation: this.#generation,
      ready: this.#valid && this.#build === null,
      pendingCells: this.#build ? this.#build.cells.length - this.#build.cursor : 0,
      sampledCells: this.#sampledCells,
      fullRebuilds: this.#fullRebuilds,
      slabUpdates: this.#slabUpdates,
      uploadedBytes: this.#uploadedBytes,
      centerX: this.#valid ? (this.#minX + this.#maxX) * 0.5 * this.spacing : Number.NaN,
      centerZ: this.#valid ? (this.#minZ + this.#maxZ) * 0.5 * this.spacing : Number.NaN
    };
  }

  /**
   * Forget the resident square so the next `request` re-samples every cell. The
   * ecology a paint function bakes can depend on live authoring values (the
   * wildflower clump tunables); moving one of those has to re-bake, not page.
   */
  invalidate(): void {
    if (this.#disposed) return;
    this.#build?.resolve();
    this.#build = null;
    this.#generation++;
    this.#valid = false;
    this.#minX = 0;
    this.#maxX = -1;
    this.#minZ = 0;
    this.#maxZ = -1;
  }

  /**
   * Ensure the square around `focus` exists. Multiple requests are latest-wins;
   * stale scheduled slices stop without publishing their bounds.
   */
  request(focus: Readonly<{ x: number; z: number }>): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Foliage field is disposed"));
    const centerX = Math.floor(focus.x / this.spacing);
    const centerZ = Math.floor(focus.z / this.spacing);
    const half = Math.floor(this.size / 2);
    const minX = centerX - half;
    const minZ = centerZ - half;
    const maxX = minX + this.size - 1;
    const maxZ = minZ + this.size - 1;

    if (
      this.#build &&
      this.#build.minX === minX && this.#build.minZ === minZ
    ) return this.#build.promise;
    if (
      !this.#build && this.#valid &&
      this.#minX === minX && this.#minZ === minZ
    ) return Promise.resolve();

    // A cancelled slice may already have overwritten toroidal slots belonging
    // to the last published square. Those CPU cells are no longer reusable,
    // even when the replacement destination overlaps the published bounds.
    // The GPU retains the last complete upload until this rebuild publishes.
    const full = !this.#valid || (this.#build?.cursor ?? 0) > 0 ||
      Math.abs(minX - this.#minX) >= this.size ||
      Math.abs(minZ - this.#minZ) >= this.size;
    const cells: Cell[] = [];
    if (full) {
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) cells.push({ x, z });
      }
    } else {
      // Entering X slabs span the complete new Z range.
      for (let x = minX; x < this.#minX; x++) {
        for (let z = minZ; z <= maxZ; z++) cells.push({ x, z });
      }
      for (let x = this.#maxX + 1; x <= maxX; x++) {
        for (let z = minZ; z <= maxZ; z++) cells.push({ x, z });
      }
      // Entering Z slabs cover only the X overlap to avoid double-sampling the corners.
      const overlapMinX = Math.max(minX, this.#minX);
      const overlapMaxX = Math.min(maxX, this.#maxX);
      for (let z = minZ; z < this.#minZ; z++) {
        for (let x = overlapMinX; x <= overlapMaxX; x++) cells.push({ x, z });
      }
      for (let z = this.#maxZ + 1; z <= maxZ; z++) {
        for (let x = overlapMinX; x <= overlapMaxX; x++) cells.push({ x, z });
      }
    }

    // A newer request invalidates the old scheduled slices. Resolve it so a
    // superseded destination never leaves an arrival waiter hanging.
    this.#build?.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    const build: Build = {
      id: ++this.#generation,
      minX,
      maxX,
      minZ,
      maxZ,
      cells,
      cursor: 0,
      full,
      promise,
      resolve
    };
    this.#build = build;
    this.#schedule(() => this.#pump(build));
    return promise;
  }

  #writeCell(cell: Cell): void {
    const wx = cell.x * this.spacing;
    const wz = cell.z * this.spacing;
    const patch = valueNoise(wx, wz, 26, 701);
    const authored = this.#options.paint?.(wx, wz);
    const density = THREE.MathUtils.clamp(
      authored?.density ?? (this.#options.plantable(wx, wz) ? 1 : 0),
      0,
      1
    );
    const species = THREE.MathUtils.clamp(
      authored?.species ?? valueNoise(wx, wz, 44, 1301),
      0,
      1
    );
    const height = THREE.MathUtils.clamp(
      authored?.height ?? (0.82 + patch * 0.36),
      0.25,
      2
    );
    const tx = positiveModulo(cell.x, this.size);
    const tz = positiveModulo(cell.z, this.size);
    const offset = (tz * this.size + tx) * 4;
    this.data[offset] = this.#options.groundHeight(wx, wz);
    this.data[offset + 1] = density;
    this.data[offset + 2] = species;
    this.data[offset + 3] = height;
    this.#sampledCells++;
  }

  #pump(build: Build): void | "again" {
    if (this.#disposed || this.#build !== build || build.id !== this.#generation) return;
    const started = this.#now();
    let sampled = 0;
    while (build.cursor < build.cells.length) {
      this.#writeCell(build.cells[build.cursor++]);
      sampled++;
      if (sampled >= this.#maxCellsPerSlice || this.#now() - started >= this.#sliceBudgetMs) {
        return "again";
      }
    }
    this.texture.needsUpdate = true;
    this.#uploadedBytes += this.data.byteLength;
    this.#minX = build.minX;
    this.#maxX = build.maxX;
    this.#minZ = build.minZ;
    this.#maxZ = build.maxZ;
    this.#valid = true;
    if (build.full) this.#fullRebuilds++;
    else this.#slabUpdates++;
    this.#build = null;
    build.resolve();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#generation++;
    this.#build?.resolve();
    this.#build = null;
    this.texture.dispose();
  }
}

/** UV for the toroidal field. Cell centres are offset by half a texel. */
export function foliageFieldUv(worldX: number, worldZ: number): THREE.Vector2 {
  return new THREE.Vector2(
    positiveModulo(worldX / FOLIAGE_FIELD_SPACING + 0.5, FOLIAGE_FIELD_SIZE) / FOLIAGE_FIELD_SIZE,
    positiveModulo(worldZ / FOLIAGE_FIELD_SPACING + 0.5, FOLIAGE_FIELD_SIZE) / FOLIAGE_FIELD_SIZE
  );
}

/** Deterministic scalar exposed for contract tests and CPU-side preview tools. */
export function foliageFieldCellStyle(cellX: number, cellZ: number): number {
  return valueNoise(
    cellX * FOLIAGE_FIELD_SPACING,
    cellZ * FOLIAGE_FIELD_SPACING,
    44,
    1301
  );
}
