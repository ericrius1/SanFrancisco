// Player-following foliage field. A toroidal float texture keeps the ecological
// inputs needed by GPU vegetation in one world-stable, paged cache: terrain
// height, density/keep, species/style and height vigour. Only newly entering
// rows/columns are sampled when the player walks; a teleport rebuilds the square
// progressively through the shared frame scheduler.

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
  readonly data = new Float32Array(FOLIAGE_FIELD_SIZE * FOLIAGE_FIELD_SIZE * 4);

  readonly #options: FoliageFieldOptions;
  readonly #now: () => number;
  readonly #sliceBudgetMs: number;
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
    this.#now = options.now ?? (() => globalThis.performance?.now() ?? Date.now());
    this.#sliceBudgetMs = Math.max(0.1, options.sliceBudgetMs ?? DEFAULT_SLICE_MS);
    this.#schedule = options.schedule ?? ((job) => {
      const run = () => {
        if (job() === "again") setTimeout(run, 0);
      };
      setTimeout(run, 0);
    });

    this.texture = new THREE.DataTexture(
      this.data,
      FOLIAGE_FIELD_SIZE,
      FOLIAGE_FIELD_SIZE,
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
      minX: this.#minX * FOLIAGE_FIELD_SPACING,
      maxX: this.#maxX * FOLIAGE_FIELD_SPACING,
      minZ: this.#minZ * FOLIAGE_FIELD_SPACING,
      maxZ: this.#maxZ * FOLIAGE_FIELD_SPACING
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
      centerX: this.#valid ? (this.#minX + this.#maxX) * 0.5 * FOLIAGE_FIELD_SPACING : Number.NaN,
      centerZ: this.#valid ? (this.#minZ + this.#maxZ) * 0.5 * FOLIAGE_FIELD_SPACING : Number.NaN
    };
  }

  /**
   * Ensure the square around `focus` exists. Multiple requests are latest-wins;
   * stale scheduled slices stop without publishing their bounds.
   */
  request(focus: Readonly<{ x: number; z: number }>): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Foliage field is disposed"));
    const centerX = Math.floor(focus.x / FOLIAGE_FIELD_SPACING);
    const centerZ = Math.floor(focus.z / FOLIAGE_FIELD_SPACING);
    const half = Math.floor(FOLIAGE_FIELD_SIZE / 2);
    const minX = centerX - half;
    const minZ = centerZ - half;
    const maxX = minX + FOLIAGE_FIELD_SIZE - 1;
    const maxZ = minZ + FOLIAGE_FIELD_SIZE - 1;

    if (
      this.#build &&
      this.#build.minX === minX && this.#build.minZ === minZ
    ) return this.#build.promise;
    if (
      !this.#build && this.#valid &&
      this.#minX === minX && this.#minZ === minZ
    ) return Promise.resolve();

    const full = !this.#valid ||
      Math.abs(minX - this.#minX) >= FOLIAGE_FIELD_SIZE ||
      Math.abs(minZ - this.#minZ) >= FOLIAGE_FIELD_SIZE;
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
    const wx = cell.x * FOLIAGE_FIELD_SPACING;
    const wz = cell.z * FOLIAGE_FIELD_SPACING;
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
    const tx = positiveModulo(cell.x, FOLIAGE_FIELD_SIZE);
    const tz = positiveModulo(cell.z, FOLIAGE_FIELD_SIZE);
    const offset = (tz * FOLIAGE_FIELD_SIZE + tx) * 4;
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
      if (sampled >= MAX_CELLS_PER_SLICE || this.#now() - started >= this.#sliceBudgetMs) {
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
