import * as THREE from "three/webgpu";
import {
  cameraPosition,
  color,
  float,
  max,
  mix,
  modelWorldMatrix,
  normalize,
  normalView,
  positionLocal,
  positionWorld,
  smoothstep,
  step,
  texture,
  transformNormalToView,
  uniform,
  vec2,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import type { WorldMap } from "./heightmap";
import {
  createTerrainClipmapLayout,
  createTerrainClipmapSourceGridCenter,
  terrainClipmapCenter,
  terrainClipmapTriangleCount,
  terrainClipmapVertexCount,
  type TerrainClipmapLevelLayout
} from "./terrainClipmapLayout";
import { TERRAIN_CLIPMAP_TUNING } from "./terrainClipmapTuning";
import {
  setTerrainCutoutUniforms,
  terrainCutoutMask,
  type TerrainCutoutSpec
} from "./terrainCutouts";
import {
  computeSurfaceWeightsRegion,
  createTerrainDetailTextureData,
  createTerrainNormalMipData,
  createTerrainSurfaceMipData
} from "./terrainMaterialData";
import {
  GRID_TO_HORIZON_DEBUG,
  edgeGlowWindow,
  holoShade,
  materializeAmount,
  materializeField
} from "../render/materialize";

// TSL's composed node types become unwieldy across texture-stage operations;
// the project uses this local alias for shader graphs while retaining typed
// public/runtime surfaces.
type N = any;

const HEIGHT_MIP_LEVELS = 4;
const HEIGHT_BOUNDS_BLOCK_CELLS = 8;
const BOUNDS_Y_MARGIN = 1;

// Reused scratch for the M14 sub-rect blits (no per-install allocation).
const _stagingRegion = new THREE.Box2();
const _stagingDst = new THREE.Vector2();

export { TERRAIN_CUTOUT_CAPACITY, type TerrainCutoutSpec } from "./terrainCutouts";

const LEVEL_DEBUG_COLORS = [
  0x4ee6a8,
  0x58a6ff,
  0xb584ff,
  0xff75b5,
  0xffa45b,
  0xf0de63,
  0xe8f0ff
] as const;

type TerrainLevelMesh = {
  mesh: THREE.Mesh;
  geometry: THREE.BufferGeometry;
  level: TerrainClipmapLevelLayout;
};

export type TerrainClipmapStats = {
  levels: number;
  patches: number;
  meshes: number;
  vertices: number;
  triangles: number;
  nearSpacing: number;
  activeNearSpacing: number;
  adaptiveMeterMesh: boolean;
  farSpacing: number;
  coverageRadius: number;
  centerX: number;
  centerZ: number;
  buildMs: number;
  geometryBytes: number;
  heightTextureBytes: number;
  normalTextureBytes: number;
  surfaceTextureBytes: number;
};

type HeightTextureData = {
  texture: THREE.DataTexture;
  min: number;
  range: number;
  bytes: number;
};

type FilteredTextureData = {
  texture: THREE.DataTexture;
  bytes: number;
};

/** Compact min/max accelerator for conservative per-patch frustum bounds. */
class TerrainHeightBounds {
  readonly #map: WorldMap;
  readonly #width: number;
  readonly #height: number;
  readonly #mins: Float32Array;
  readonly #maxs: Float32Array;

  constructor(map: WorldMap) {
    this.#map = map;
    const { width, height } = map.meta.grid;
    this.#width = Math.ceil((width - 1) / HEIGHT_BOUNDS_BLOCK_CELLS);
    this.#height = Math.ceil((height - 1) / HEIGHT_BOUNDS_BLOCK_CELLS);
    this.#mins = new Float32Array(this.#width * this.#height);
    this.#maxs = new Float32Array(this.#width * this.#height);

    for (let bz = 0; bz < this.#height; bz++) {
      for (let bx = 0; bx < this.#width; bx++) {
        this.#computeBlock(bx, bz);
      }
    }
  }

  #computeBlock(bx: number, bz: number): void {
    const { width, height } = this.#map.meta.grid;
    const iz0 = bz * HEIGHT_BOUNDS_BLOCK_CELLS;
    const iz1 = Math.min(height - 1, iz0 + HEIGHT_BOUNDS_BLOCK_CELLS);
    const ix0 = bx * HEIGHT_BOUNDS_BLOCK_CELLS;
    const ix1 = Math.min(width - 1, ix0 + HEIGHT_BOUNDS_BLOCK_CELLS);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let iz = iz0; iz <= iz1; iz++) {
      const row = iz * width;
      for (let ix = ix0; ix <= ix1; ix++) {
        const y = this.#map.heights[row + ix];
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    const index = bz * this.#width + bx;
    this.#mins[index] = minY;
    this.#maxs[index] = maxY;
  }

  /** M14: recompute the blocks whose (edge-sharing) cell coverage intersects
   *  the inclusive cell rect a streamed tile just overwrote. */
  updateRegion(gx0: number, gz0: number, gx1: number, gz1: number): void {
    const bx0 = Math.max(0, Math.ceil((gx0 - HEIGHT_BOUNDS_BLOCK_CELLS) / HEIGHT_BOUNDS_BLOCK_CELLS));
    const bx1 = Math.min(this.#width - 1, Math.floor(gx1 / HEIGHT_BOUNDS_BLOCK_CELLS));
    const bz0 = Math.max(0, Math.ceil((gz0 - HEIGHT_BOUNDS_BLOCK_CELLS) / HEIGHT_BOUNDS_BLOCK_CELLS));
    const bz1 = Math.min(this.#height - 1, Math.floor(gz1 / HEIGHT_BOUNDS_BLOCK_CELLS));
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        this.#computeBlock(bx, bz);
      }
    }
  }

  query(minX: number, maxX: number, minZ: number, maxZ: number): { min: number; max: number } | null {
    const grid = this.#map.meta.grid;
    const worldMaxX = grid.minX + (grid.width - 1) * grid.cellSize;
    const worldMaxZ = grid.minZ + (grid.height - 1) * grid.cellSize;
    const clippedMinX = Math.max(grid.minX, minX);
    const clippedMaxX = Math.min(worldMaxX, maxX);
    const clippedMinZ = Math.max(grid.minZ, minZ);
    const clippedMaxZ = Math.min(worldMaxZ, maxZ);
    if (clippedMinX > clippedMaxX || clippedMinZ > clippedMaxZ) return null;

    const toBlockX = (x: number) => Math.max(
      0,
      Math.min(
        this.#width - 1,
        Math.floor((x - grid.minX) / grid.cellSize / HEIGHT_BOUNDS_BLOCK_CELLS)
      )
    );
    const toBlockZ = (z: number) => Math.max(
      0,
      Math.min(
        this.#height - 1,
        Math.floor((z - grid.minZ) / grid.cellSize / HEIGHT_BOUNDS_BLOCK_CELLS)
      )
    );
    const bx0 = toBlockX(clippedMinX);
    const bx1 = toBlockX(clippedMaxX);
    const bz0 = toBlockZ(clippedMinZ);
    const bz1 = toBlockZ(clippedMaxZ);
    let minY = Infinity;
    let maxY = -Infinity;
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const index = bz * this.#width + bx;
        minY = Math.min(minY, this.#mins[index]);
        maxY = Math.max(maxY, this.#maxs[index]);
      }
    }
    return { min: minY - BOUNDS_Y_MARGIN, max: maxY + BOUNDS_Y_MARGIN };
  }
}

function createHeightTexture(map: WorldMap): HeightTextureData {
  // M14: FIXED quantization range from meta.terrain (the int16 encoding
  // envelope) instead of a whole-map rescan, so streamed tile installs
  // re-encode texels identically without global knowledge. The shader decode
  // reads the same min/range constants below. Legacy float32 maps (no terrain
  // meta) keep the scan.
  let min: number;
  let range: number;
  const terrain = map.meta.terrain;
  if (terrain?.heightEncoding === "int16") {
    min = terrain.heightBase;
    range = 32767 * terrain.heightQuant;
  } else {
    let sourceMin = Infinity;
    let sourceMax = -Infinity;
    for (const height of map.heights) {
      sourceMin = Math.min(sourceMin, height);
      sourceMax = Math.max(sourceMax, height);
    }
    min = Math.floor(sourceMin) - 1;
    range = Math.ceil(sourceMax) + 1 - min;
  }
  const encode = (height: number) => Math.max(
    0,
    Math.min(65535, Math.round(((height - min) / range) * 65535))
  );

  let width = map.meta.grid.width;
  let height = map.meta.grid.height;
  let data = new Uint16Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = encode(map.heights[i]);

  const quantizedMips: { data: Uint16Array; width: number; height: number }[] = [];
  let bytes = 0;
  for (let level = 0; level < HEIGHT_MIP_LEVELS; level++) {
    quantizedMips.push({ data, width, height });
    bytes += data.byteLength;
    if (width === 1 && height === 1) break;
    const nextWidth = Math.max(1, Math.floor(width / 2));
    const nextHeight = Math.max(1, Math.floor(height / 2));
    const next = new Uint16Array(nextWidth * nextHeight);
    for (let y = 0; y < nextHeight; y++) {
      const y0 = y * 2;
      const y1 = Math.min(height - 1, y0 + 1);
      for (let x = 0; x < nextWidth; x++) {
        const x0 = x * 2;
        const x1 = Math.min(width - 1, x0 + 1);
        next[y * nextWidth + x] = Math.round((
          data[y0 * width + x0] +
          data[y0 * width + x1] +
          data[y1 * width + x0] +
          data[y1 * width + x1]
        ) * 0.25);
      }
    }
    data = next;
    width = nextWidth;
    height = nextHeight;
  }

  // RG8 is universally available and filterable in WebGPU. Splitting each
  // 16-bit height into high/low bytes retains R16 precision without requiring
  // the optional `texture-formats-tier1` feature. Decoding is a linear function
  // of both channels, so hardware bilinear filtering remains mathematically
  // equivalent to interpolating the original 16-bit values—even across carries.
  const mipmaps = quantizedMips.map(({ data: quantized, width: mipWidth, height: mipHeight }) => {
    const packed = new Uint8Array(quantized.length * 2);
    for (let i = 0; i < quantized.length; i++) {
      packed[i * 2] = quantized[i] >>> 8;
      packed[i * 2 + 1] = quantized[i] & 255;
    }
    return { data: packed, width: mipWidth, height: mipHeight };
  });

  const base = mipmaps[0];
  const textureData = new THREE.DataTexture(
    base.data,
    base.width,
    base.height,
    THREE.RGFormat,
    THREE.UnsignedByteType
  );
  // Manual levels avoid a runtime downsample pass and let each ring select a
  // stable source level explicitly in the vertex stage.
  textureData.mipmaps = mipmaps;
  textureData.generateMipmaps = false;
  textureData.magFilter = THREE.LinearFilter;
  textureData.minFilter = THREE.LinearMipmapLinearFilter;
  textureData.wrapS = textureData.wrapT = THREE.ClampToEdgeWrapping;
  textureData.needsUpdate = true;
  textureData.name = "terrainHeightPyramid";
  return { texture: textureData, min, range, bytes };
}

function createSurfaceTexture(map: WorldMap): FilteredTextureData {
  const { width, height } = map.meta.grid;
  const { mipmaps, bytes } = createTerrainSurfaceMipData(
    map.surface,
    width,
    height,
    HEIGHT_MIP_LEVELS
  );
  const base = mipmaps[0];
  const textureData = new THREE.DataTexture(
    base.data,
    base.width,
    base.height,
    THREE.RGBAFormat,
    THREE.UnsignedByteType
  );
  textureData.mipmaps = mipmaps;
  textureData.magFilter = THREE.LinearFilter;
  textureData.minFilter = THREE.LinearMipmapLinearFilter;
  textureData.generateMipmaps = false;
  textureData.wrapS = textureData.wrapT = THREE.ClampToEdgeWrapping;
  textureData.needsUpdate = true;
  textureData.name = "terrainSurfaceWeights";
  return { texture: textureData, bytes };
}

function createNormalTexture(map: WorldMap): FilteredTextureData {
  const { width, height, cellSize } = map.meta.grid;
  const { mipmaps, bytes } = createTerrainNormalMipData(
    map.heights,
    width,
    height,
    cellSize,
    HEIGHT_MIP_LEVELS
  );
  const base = mipmaps[0];
  const textureData = new THREE.DataTexture(
    base.data,
    base.width,
    base.height,
    THREE.RGFormat,
    THREE.UnsignedByteType
  );
  textureData.mipmaps = mipmaps;
  textureData.magFilter = THREE.LinearFilter;
  textureData.minFilter = THREE.LinearMipmapLinearFilter;
  textureData.generateMipmaps = false;
  textureData.wrapS = textureData.wrapT = THREE.ClampToEdgeWrapping;
  textureData.needsUpdate = true;
  textureData.name = "terrainNormalPyramid";
  return { texture: textureData, bytes };
}

function createDetailTexture(): THREE.DataTexture {
  const size = 256;
  const data = createTerrainDetailTextureData(size);
  const textureData = new THREE.DataTexture(data, size, size, THREE.RGFormat, THREE.UnsignedByteType);
  textureData.magFilter = THREE.LinearFilter;
  textureData.minFilter = THREE.LinearMipmapLinearFilter;
  textureData.generateMipmaps = true;
  textureData.wrapS = textureData.wrapT = THREE.RepeatWrapping;
  textureData.needsUpdate = true;
  textureData.name = "terrainMaterialDetail";
  return textureData;
}

function createLevelGeometry(level: TerrainClipmapLevelLayout): THREE.BufferGeometry {
  const vertices = level.patches.reduce(
    (sum, patch) => sum + (patch.widthCells + 1) * (patch.depthCells + 1),
    0
  );
  if (vertices > 65_535) throw new Error(`terrain clipmap level ${level.level} exceeds 16-bit indices`);
  const positions = new Float32Array(vertices * 3);
  const indices = new Uint16Array(level.triangles * 3);
  let vertexCursor = 0;
  let indexCursor = 0;

  // The four logical patches remain disconnected in the index buffer, but are
  // packed into one geometry per LOD. Baking their X/Z offsets here turns 28
  // patch submissions into seven level submissions without changing topology.
  for (const patch of level.patches) {
    const row = patch.widthCells + 1;
    const patchBaseVertex = vertexCursor;
    const halfWidth = patch.widthCells * level.spacing * 0.5;
    const halfDepth = patch.depthCells * level.spacing * 0.5;
    const offsetX = patch.offsetCellsX * level.spacing;
    const offsetZ = patch.offsetCellsZ * level.spacing;
    for (let z = 0; z <= patch.depthCells; z++) {
      for (let x = 0; x <= patch.widthCells; x++) {
        const positionOffset = vertexCursor * 3;
        positions[positionOffset] = offsetX + x * level.spacing - halfWidth;
        positions[positionOffset + 1] = 0;
        positions[positionOffset + 2] = offsetZ + z * level.spacing - halfDepth;
        vertexCursor++;
      }
    }
    for (let z = 0; z < patch.depthCells; z++) {
      for (let x = 0; x < patch.widthCells; x++) {
        const a = patchBaseVertex + z * row + x;
        const b = patchBaseVertex + (z + 1) * row + x;
        const c = b + 1;
        const d = a + 1;
        indices[indexCursor++] = a;
        indices[indexCursor++] = b;
        indices[indexCursor++] = c;
        indices[indexCursor++] = a;
        indices[indexCursor++] = c;
        indices[indexCursor++] = d;
      }
    }
  }

  // A normal attribute is unnecessary because the material supplies its
  // height-derived normalNode explicitly.
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

/**
 * Camera-centred GPU heightfield. Static patch buffers move only when the
 * player crosses an 8 m source cell; all elevation, normals and LOD morphing are
 * evaluated from shared textures in the vertex stage.
 */
export class TerrainClipmap {
  readonly group = new THREE.Group();

  readonly #layout = createTerrainClipmapLayout();
  readonly #levelMeshes: TerrainLevelMesh[] = [];
  readonly #sourceGridCenter: TerrainLevelMesh;
  readonly #materials: THREE.MeshStandardNodeMaterial[] = [];
  readonly #height: HeightTextureData;
  readonly #normal: FilteredTextureData;
  readonly #surface: FilteredTextureData;
  readonly #detailTexture = createDetailTexture();
  readonly #bounds: TerrainHeightBounds;
  readonly #grid: WorldMap["meta"]["grid"];
  readonly #map: WorldMap;
  // M14 pooled staging textures for sub-rect GPU installs (see applyTileRegion).
  #stagingRG: THREE.DataTexture | null = null;
  #stagingRGBA: THREE.DataTexture | null = null;
  #lastTileInstallMs = 0;
  readonly #center = uniform(new THREE.Vector2());
  readonly #morphBand = uniform(TERRAIN_CLIPMAP_TUNING.values.morphBand);
  readonly #macroVariation = uniform(TERRAIN_CLIPMAP_TUNING.values.macroVariation);
  readonly #microVariation = uniform(TERRAIN_CLIPMAP_TUNING.values.microVariation);
  readonly #debugLevels = uniform(TERRAIN_CLIPMAP_TUNING.values.debugLevels ? 1 : 0);
  #buildMs = 0;
  #geometryBytes = 0;
  #centerX = Number.NaN;
  #centerZ = Number.NaN;
  #adaptiveMeterMesh = TERRAIN_CLIPMAP_TUNING.values.adaptiveMeterMesh;

  constructor(map: WorldMap) {
    const buildStarted = performance.now();
    this.group.name = "terrainClipmap";
    this.#map = map;
    this.#grid = map.meta.grid;
    this.#height = createHeightTexture(map);
    this.#normal = createNormalTexture(map);
    this.#surface = createSurfaceTexture(map);
    this.#bounds = new TerrainHeightBounds(map);

    for (const level of this.#layout) {
      const material = this.#createMaterial(level);
      this.#materials.push(material);
      const geometry = createLevelGeometry(level);
      const mesh = new THREE.Mesh(geometry, material);
      this.#geometryBytes += geometry.getAttribute("position").array.byteLength;
      this.#geometryBytes += geometry.index?.array.byteLength ?? 0;
      mesh.name = `terrainClipmapL${level.level}`;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      this.#levelMeshes.push({ mesh, geometry, level });
      this.group.add(mesh);
    }
    // Keep an 8 m source-lattice centre resident for an instantaneous visual
    // A/B. Only this mesh or the adaptive 1/2/4/8 m inner levels is visible at
    // once, so the comparison changes real topology without recompiling TSL.
    const sourceGridLevel = createTerrainClipmapSourceGridCenter();
    const sourceGridGeometry = createLevelGeometry(sourceGridLevel);
    this.#geometryBytes += sourceGridGeometry.getAttribute("position").array.byteLength;
    this.#geometryBytes += sourceGridGeometry.index?.array.byteLength ?? 0;
    const sourceGridMesh = new THREE.Mesh(sourceGridGeometry, this.#materials[sourceGridLevel.level]);
    sourceGridMesh.name = "terrainClipmapSourceGridCenter";
    sourceGridMesh.receiveShadow = true;
    sourceGridMesh.castShadow = false;
    sourceGridMesh.visible = false;
    this.#sourceGridCenter = { mesh: sourceGridMesh, geometry: sourceGridGeometry, level: sourceGridLevel };
    this.group.add(sourceGridMesh);
    this.#buildMs = performance.now() - buildStarted;
  }

  #decodeHeight(packed: N): N {
    return packed.r.mul(255 * 256)
      .add(packed.g.mul(255))
      .div(65535)
      .mul(this.#height.range)
      .add(this.#height.min);
  }

  /** Mip dims are exact halvings for the lods in use (verified 1888×1736 / 4 levels). */
  #mipDims(sourceLod: number): { width: number; height: number } {
    return { width: this.#grid.width >> sourceLod, height: this.#grid.height >> sourceLod };
  }

  #heightTap(cellX: N, cellY: N, sourceLod: number): N {
    const dims = this.#mipDims(sourceLod);
    const uv = vec2(cellX.add(0.5).div(dims.width), cellY.add(0.5).div(dims.height));
    return this.#decodeHeight((texture(this.#height.texture, uv) as N).level(float(sourceLod)));
  }

  /**
   * Clamped Catmull-Rom bicubic reconstruction of the 8 m source lattice.
   * Bilinear reconstruction is C0 with a slope kink at every source cell edge —
   * rolling hills read as 8 m facets no matter how dense the render mesh is.
   * Catmull-Rom interpolates the lattice values exactly and is C1, so hills
   * genuinely curve. The result is clamped to the min/max of the FULL 4×4 tap
   * neighbourhood — an anti-ringing guard only. Clamping to the central cell's
   * 4 corners instead flattens every in-cell crest/dip into a per-cell plateau
   * (hilltops terrace into visible contour bands); the 4×4 hull never binds on
   * smooth terrain while still bounding cliff-notch ringing to real
   * neighbourhood heights.
   * Must stay in lockstep with the CPU twin in heightmap.ts #sampleGrid.
   */
  #heightAt(worldXZ: N, sourceLod: number): N {
    const grid = this.#grid;
    // Base texel index; mip L texel index = (f0 + 0.5) / 2^L - 0.5 (exact for
    // the power-of-two-halving dims above).
    const baseTexel = worldXZ.sub(vec2(grid.minX, grid.minZ)).div(grid.cellSize);
    const scale = 1 / (1 << sourceLod);
    const texel = baseTexel.add(0.5).mul(scale).sub(0.5);
    const cell = texel.floor();
    const t = texel.fract();
    const weights1D = (f: N): [N, N, N, N] => {
      const f2 = f.mul(f);
      const f3 = f2.mul(f);
      return [
        f3.mul(-0.5).add(f2).sub(f.mul(0.5)),
        f3.mul(1.5).sub(f2.mul(2.5)).add(1),
        f3.mul(-1.5).add(f2.mul(2)).add(f.mul(0.5)),
        f3.mul(0.5).sub(f2.mul(0.5))
      ];
    };
    const wx = weights1D(t.x);
    const wy = weights1D(t.y);
    const taps: N[][] = [];
    for (let j = -1; j <= 2; j++) {
      const row: N[] = [];
      for (let i = -1; i <= 2; i++) {
        row.push(this.#heightTap(cell.x.add(i), cell.y.add(j), sourceLod));
      }
      taps.push(row);
    }
    let value: N = float(0);
    for (let j = 0; j < 4; j++) {
      const row = taps[j][0].mul(wx[0])
        .add(taps[j][1].mul(wx[1]))
        .add(taps[j][2].mul(wx[2]))
        .add(taps[j][3].mul(wx[3]));
      value = value.add(row.mul(wy[j]));
    }
    let low: N = taps[0][0];
    let high: N = taps[0][0];
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        if (i === 0 && j === 0) continue;
        low = low.min(taps[j][i]);
        high = high.max(taps[j][i]);
      }
    }
    return value.clamp(low, high);
  }

  #coarseHeightAt(worldXZ: N, spacing: number, sourceLod: number): N {
    const relative = worldXZ.sub(this.#center).div(spacing);
    const cell = relative.floor();
    const blend = relative.fract();
    const base = this.#center.add(cell.mul(spacing));
    const h00 = this.#heightAt(base, sourceLod);
    const h10 = this.#heightAt(base.add(vec2(spacing, 0)), sourceLod);
    const h01 = this.#heightAt(base.add(vec2(0, spacing)), sourceLod);
    const h11 = this.#heightAt(base.add(vec2(spacing, spacing)), sourceLod);
    return mix(mix(h00, h10, blend.x), mix(h01, h11, blend.x), blend.y);
  }

  #normalTapRG(cellX: N, cellY: N, sourceLod: number): N {
    const dims = this.#mipDims(sourceLod);
    const uv = vec2(cellX.add(0.5).div(dims.width), cellY.add(0.5).div(dims.height));
    return (texture(this.#normal.texture, uv) as N).level(float(sourceLod)).rg;
  }

  /**
   * Bicubic B-spline sample of the prefiltered normal pyramid. Bilinear
   * filtering of an 8 m normal lattice is C0 — the derivative jumps at every
   * texel edge read as Mach-band quilting on smooth lawns and hills. The
   * B-spline kernel is C2 (pure smoothing, no overshoot) and the encoded RG
   * channels are linear in the normal's XZ, so weighting before decode is
   * exact. Y is reconstructed after filtering, as before.
   */
  #normalAt(worldXZ: N, sourceLod: number): N {
    const grid = this.#grid;
    const baseTexel = worldXZ.sub(vec2(grid.minX, grid.minZ)).div(grid.cellSize);
    const scale = 1 / (1 << sourceLod);
    const texel = baseTexel.add(0.5).mul(scale).sub(0.5);
    const cell = texel.floor();
    const t = texel.fract();
    const weights1D = (f: N): [N, N, N, N] => {
      const oneMinus = float(1).sub(f);
      const f2 = f.mul(f);
      const f3 = f2.mul(f);
      return [
        oneMinus.mul(oneMinus).mul(oneMinus).div(6),
        f3.mul(3).sub(f2.mul(6)).add(4).div(6),
        f3.mul(-3).add(f2.mul(3)).add(f.mul(3)).add(1).div(6),
        f3.div(6)
      ];
    };
    const wx = weights1D(t.x);
    const wy = weights1D(t.y);
    let filtered: N = vec2(0, 0);
    for (let j = 0; j < 4; j++) {
      let row: N = vec2(0, 0);
      for (let i = 0; i < 4; i++) {
        row = row.add(this.#normalTapRG(cell.x.add(i - 1), cell.y.add(j - 1), sourceLod).mul(wx[i]));
      }
      filtered = filtered.add(row.mul(wy[j]));
    }
    const xz = filtered.mul(2).sub(1);
    const y = float(1).sub(xz.dot(xz)).max(0).sqrt();
    return normalize(vec3(xz.x, y, xz.y));
  }

  #createMaterial(level: TerrainClipmapLevelLayout): THREE.MeshStandardNodeMaterial {
    const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0 });
    const local = positionLocal as N;
    // modelWorldMatrix is safe inside positionNode: it contains only the patch's
    // ordinary object transform, not the displacement being authored here.
    const worldBase = (modelWorldMatrix as N).mul(vec4(local, 1)).xyz;
    const worldXZ = worldBase.xz;
    const fineHeight = this.#heightAt(worldXZ, level.sourceLod);
    let renderedHeight: N = fineHeight;
    let morph: N = float(0);
    let parent: TerrainClipmapLevelLayout | null = null;
    if (level.level < this.#layout.length - 1) {
      parent = this.#layout[level.level + 1];
      const parentHeight = this.#coarseHeightAt(worldXZ, parent.spacing, parent.sourceLod);
      const distanceFromCenter = max(
        worldXZ.x.sub(this.#center.x).abs(),
        worldXZ.y.sub(this.#center.y).abs()
      );
      const morphStart = float(level.halfExtent).mul(float(1).sub(this.#morphBand));
      morph = smoothstep(morphStart, level.halfExtent, distanceFromCenter);
      renderedHeight = mix(fineHeight, parentHeight, morph);
    }
    material.positionNode = vec3(local.x, renderedHeight, local.z);

    // Normals come from a prefiltered world-space pyramid. Sampling them in the
    // fragment stage and normalizing after LOD blending prevents both triangle
    // facets and 8 m source-cell derivative seams from entering lighting or the
    // slope-driven material mask.
    const fineNormal = this.#normalAt(worldXZ, level.sourceLod);
    const renderedNormal = parent
      ? (mix(
        fineNormal,
        this.#normalAt(worldXZ, parent.sourceLod),
        morph
      ) as N).normalize()
      : fineNormal;
    const worldNormal = (renderedNormal as N).normalize();
    material.normalNode = transformNormalToView(worldNormal);

    const grid = this.#grid;
    const surfaceUv = worldXZ
      .sub(vec2(grid.minX, grid.minZ))
      .div(grid.cellSize)
      .add(0.5)
      .div(vec2(grid.width, grid.height));
    // Terrain classification is authored on the same 8 m source lattice as
    // height, but the uploaded base is Gaussian-feathered by one source cell.
    // Fragment sampling keeps class transitions independent of mesh triangles.
    const fineSurfaceSample = (texture(this.#surface.texture, surfaceUv) as N)
      .level(float(level.sourceLod));
    let renderedSurfaceSample: N = fineSurfaceSample;
    if (parent && parent.sourceLod !== level.sourceLod) {
      const parentSurfaceSample = (texture(this.#surface.texture, surfaceUv) as N)
        .level(float(parent.sourceLod));
      renderedSurfaceSample = mix(fineSurfaceSample, parentSurfaceSample, morph);
    }
    const surfaceSample = renderedSurfaceSample as N;
    const surfaceWeight = surfaceSample.r
      .add(surfaceSample.g)
      .add(surfaceSample.b)
      .add(surfaceSample.a)
      .max(0.001);
    const surface = surfaceSample.div(surfaceWeight);
    const urban = color(0xa19d96);
    // Warmed toward the retired lawn-drape palette (PARK_COLOR mixed with its
    // grass noise) so parks keep their pre-consolidation richness.
    const grass = color(0x7aa163);
    const sand = color(0xd1c49f);
    const bayFloor = color(0x466c68);
    const rock = color(0x878178);
    let terrainColor: N = urban.mul(surface.r)
      .add(grass.mul(surface.g))
      .add(sand.mul(surface.b))
      .add(bayFloor.mul(surface.a));
    const slopeRock = smoothstep(0.42, 0.82, worldNormal.y).oneMinus()
      .mul(surface.a.oneMinus())
      .mul(surface.b.oneMinus());
    // Altitude may strengthen rock on shoulders, but no longer paints a broad
    // grey slab across every flat hilltop between 105 and 185 metres.
    const shoulderRock = smoothstep(0.66, 0.9, worldNormal.y).oneMinus();
    const altitudeRock = smoothstep(125, 210, (positionWorld as N).y)
      .mul(shoulderRock)
      .mul(0.18)
      .mul(surface.a.oneMinus());
    terrainColor = mix(terrainColor, rock, (slopeRock as N).max(altitudeRock));

    // Detail is also evaluated per vertex. At one-metre near spacing this still
    // exceeds the source terrain's useful frequency, while avoiding two repeat
    // texture samples for every covered pixel. Explicit levels keep vertex-stage
    // sampling legal and progressively band-limit the coarser rings.
    // The macro channel is a wrapped, prefiltered field at four metres/texel.
    // Unlike the old 18 m independent hash cells it has no bilinear quilt.
    const detailUv = worldXZ.mul(1 / (4 * 256));
    const macroLod = Math.max(0, level.level - 4);
    const fineMacroSample = (texture(this.#detailTexture, detailUv) as N)
      .level(float(macroLod));
    let renderedMacroSample: N = fineMacroSample;
    if (parent) {
      const parentMacroLod = Math.max(0, parent.level - 4);
      if (parentMacroLod !== macroLod) {
        const parentMacroSample = (texture(this.#detailTexture, detailUv) as N)
          .level(float(parentMacroLod));
        renderedMacroSample = mix(fineMacroSample, parentMacroSample, morph);
      }
    }
    const macro = (vertexStage(renderedMacroSample) as N).r.sub(0.5);
    let variation: N = macro.mul(this.#macroVariation);
    // Rings outside 512 m never receive a non-zero near fade. Omitting this
    // sample from those material graphs saves a texture read on most terrain.
    if (level.level <= 3) {
      const microUv = worldXZ.mul(1 / (1.25 * 256));
      const fineMicroSample = (texture(this.#detailTexture, microUv) as N)
        .level(float(level.level));
      const renderedMicroSample = parent && parent.level <= 3
        ? mix(
          fineMicroSample,
          (texture(this.#detailTexture, microUv) as N).level(float(parent.level)),
          morph
        )
        : fineMicroSample;
      const micro = (vertexStage(renderedMicroSample) as N).g.sub(0.5);
      const nearFade = smoothstep(420, 24, (positionWorld as N).distance(cameraPosition));
      variation = variation.add(micro.mul(this.#microVariation).mul(nearFade));
    }
    terrainColor = terrainColor.mul(variation.add(1));
    terrainColor = mix(terrainColor, color(LEVEL_DEBUG_COLORS[level.level]), this.#debugLevels.mul(0.72));

    // Materialize/void holo mix (docs/VOID_STREAM_REWRITE.md M2 + M13). Terrain
    // is always resident: no birth ramp, no dissolve, no geometry change — the
    // height path (#heightAt) is untouched so CPU/GPU lockstep holds and the
    // holo contour grid conforms to the REAL displaced heights. Below the
    // front the lit response collapses to a dark base and the emissive carries
    // the glowing world-grid + elevation contours; at amount = 1 both terms
    // are plain uniform-driven mixes back to the normal shading (a few ALU,
    // no added texture taps), so the revealed look is unchanged.
    //
    // M13: the grid is now CONCENTRIC like the buildings — the glowing grid +
    // the faint lit floor both ride an edge window hugging the advancing front
    // (edgeGlowWindow: ~1 at/inside the dissolve edge, easing to 0 over ~3
    // bands beyond it). So the void/control moment shows only a small lit patch
    // of contour grid around the front centre, fading to dark ground + sky
    // beyond; as the front sweeps, the lit band grows outward with it. A very
    // faint albedo floor survives far out so the horizon reads as dark ground,
    // not a pure black abyss. The window collapses to 1 once the front parks at
    // the revealed sentinel, so settled shading is byte-identical to today.
    // `?gridhorizon=1` restores the old to-horizon grid for A/B debugging.
    const materialized = materializeAmount({ worldPos: positionWorld as N }).toVar();
    const holoReveal = smoothstep(0.25, 1, materialized);
    const frontDist = (positionWorld as N).xz
      .sub(materializeField.frontCenter as N)
      .length();
    const floorWindow = GRID_TO_HORIZON_DEBUG ? float(1) : edgeGlowWindow(frontDist);
    // Optional very-faint floor: ~0.05 albedo near the front, easing to a
    // minimal 0.02 far beyond it (err toward darker — the void moment is an
    // "immediate area focus", not "ground to horizon").
    const holoFloor = mix(float(0.02), float(0.05), floorWindow);
    material.colorNode = terrainColor.mul(mix(holoFloor, float(1), holoReveal));
    material.emissiveNode = holoShade(positionWorld as N, terrainColor, {
      edgeWindow: !GRID_TO_HORIZON_DEBUG
    }).mul(holoReveal.oneMinus());
    material.roughnessNode = surface.a.mul(0.03).add(0.94);

    // Beyond the front the terrain contributes NOTHING — not even a dark
    // silhouette occluding the sky. The clipmap already alpha-tests for the
    // map-edge cutout, so folding a front-visibility window into opacity is
    // free (no new pipeline): fragments past the glow tail are discarded and
    // the void sky shows through. Collapses to 1 at the revealed sentinel
    // (settled shading byte-identical) and under ?gridhorizon=1.
    // saturate((radius + 3·band − dist) / band): fades out over one band
    // ending at radius+3band. Constant-denominator form — smoothstep here
    // would divide by (b−a)=0 in f32 at the revealed sentinel (1e9).
    const frontVisibility = GRID_TO_HORIZON_DEBUG
      ? float(1)
      : (materializeField.frontRadius as N)
          .add((materializeField.frontBand as N).mul(3))
          .sub(frontDist)
          .div((materializeField.frontBand as N))
          .saturate();

    const worldMaxX = grid.minX + (grid.width - 1) * grid.cellSize;
    const worldMaxZ = grid.minZ + (grid.height - 1) * grid.cellSize;
    const inBounds = step(grid.minX, (positionWorld as N).x)
      .mul(step((positionWorld as N).x, worldMaxX))
      .mul(step(grid.minZ, (positionWorld as N).z))
      .mul(step((positionWorld as N).z, worldMaxZ));
    material.opacityNode = inBounds.mul(terrainCutoutMask()).mul(frontVisibility);
    material.alphaTestNode = float(0.5);
    material.envMapIntensity = 0.68;
    return material;
  }

  /**
   * World-space terrain lighting normal at an arbitrary world XZ, sampled from
   * the prefiltered pyramid with fragment auto-mip (distance band-limiting for
   * free). Shared by ground drapes and groundcover so everything standing on
   * the terrain lights consistently with it.
   */
  worldFieldNormal(worldXZ: N): N {
    const grid = this.#grid;
    const uv = worldXZ
      .sub(vec2(grid.minX, grid.minZ))
      .div(grid.cellSize)
      .add(0.5)
      .div(vec2(grid.width, grid.height));
    const packedNormal = texture(this.#normal.texture, uv) as N;
    const xz = packedNormal.rg.mul(2).sub(1);
    const upComponent = float(1).sub(xz.dot(xz)).max(0).sqrt();
    return normalize(vec3(xz.x, upComponent, xz.y));
  }

  /**
   * View-space base normal that conforms a draped ground mesh (baked lawn/road
   * ribbons, which ship flat-shaded) to the same prefiltered terrain lighting
   * field the clipmap uses, so drape shading is seamless with the ground around
   * it. A height-agreement gate falls back to the mesh's own interpolated
   * normal wherever the surface leaves the heightfield — pier decks, bridge
   * roadways, graded terraces — those are not terrain and must keep their own
   * lighting.
   */
  groundConformNormalBase(): unknown {
    const grid = this.#grid;
    const world = positionWorld as N;
    const uv = world.xz
      .sub(vec2(grid.minX, grid.minZ))
      .div(grid.cellSize)
      .add(0.5)
      .div(vec2(grid.width, grid.height));
    const fieldWorld = this.worldFieldNormal(world.xz);
    const packedHeight = texture(this.#height.texture, uv) as N;
    const terrainY = packedHeight.r.mul(255 * 256)
      .add(packedHeight.g.mul(255))
      .div(65535)
      .mul(this.#height.range)
      .add(this.#height.min);
    // 1 while the drape hugs the terrain (lifts are 0.15-0.45 m), fading to 0
    // by ~2.4 m of separation. Edges ordered low->high (reversed edges emit 0).
    const conform = smoothstep(1.4, 2.4, world.y.sub(terrainY).abs()).oneMinus();
    return mix(normalView as N, transformNormalToView(fieldWorld) as N, conform);
  }

  /**
   * Update authored terrain ownership without rebuilding any clipmap material.
   * Every level references these same uniforms, so the hole remains continuous
   * across ring and morph boundaries.
   */
  setCutouts(cutouts: readonly TerrainCutoutSpec[]): void {
    setTerrainCutoutUniforms(cutouts);
  }

  // ---------------------------------------------------------------- M14
  // Streamed-tile GPU install: regenerate the affected texel sub-rects of the
  // height/normal/surface pyramids FROM THE CPU LATTICE (the source of truth —
  // WorldMap.installTile has already written the rows) for mip0 + the three
  // coarser mips, and blit each rect into the live DataTextures through a
  // pooled 128×128 staging texture + renderer.copyTextureToTexture (WebGPU
  // sub-rect copy, srcRegion/dstPosition/dstLevel). The CPU-side mip arrays
  // are updated in place so any future full re-upload stays consistent. A full
  // 8.7 MB pyramid re-upload per tile is forbidden; this path uploads ~120 KB.

  #staging(bytesPerPixel: 2 | 4): THREE.DataTexture {
    const existing = bytesPerPixel === 2 ? this.#stagingRG : this.#stagingRGBA;
    if (existing) return existing;
    const size = 128;
    const texture = new THREE.DataTexture(
      new Uint8Array(size * size * bytesPerPixel),
      size,
      size,
      bytesPerPixel === 2 ? THREE.RGFormat : THREE.RGBAFormat,
      THREE.UnsignedByteType
    );
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.generateMipmaps = false;
    texture.flipY = false;
    texture.name = `terrainTileStaging${bytesPerPixel === 2 ? "RG" : "RGBA"}`;
    texture.needsUpdate = true;
    if (bytesPerPixel === 2) this.#stagingRG = texture;
    else this.#stagingRGBA = texture;
    return texture;
  }

  #uploadRect(
    renderer: THREE.WebGPURenderer,
    dst: THREE.DataTexture,
    level: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    rows: Uint8Array,
    bytesPerPixel: 2 | 4
  ): void {
    const staging = this.#staging(bytesPerPixel);
    const sdata = staging.image.data as Uint8Array;
    const sw = staging.image.width;
    for (let y = 0; y < h; y++) {
      sdata.set(rows.subarray(y * w * bytesPerPixel, (y + 1) * w * bytesPerPixel), y * sw * bytesPerPixel);
    }
    staging.needsUpdate = true;
    _stagingRegion.min.set(0, 0);
    _stagingRegion.max.set(w, h);
    _stagingDst.set(x0, y0);
    renderer.copyTextureToTexture(staging, dst, _stagingRegion, _stagingDst, 0, level);
  }

  #mip(texture: THREE.DataTexture, level: number): { data: Uint8Array; width: number; height: number } {
    return (texture.mipmaps as unknown as { data: Uint8Array; width: number; height: number }[])[level];
  }

  /** Recompute a height-pyramid sub-rect (packed RG8) in place; returns tight rows. */
  #refreshHeightRect(level: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
    const mip = this.#mip(this.#height.texture, level);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const out = new Uint8Array(w * h * 2);
    if (level === 0) {
      const { min, range } = this.#height;
      const W = mip.width;
      const heights = this.#map.heights;
      for (let y = 0; y < h; y++) {
        const row = (y0 + y) * W;
        for (let x = 0; x < w; x++) {
          let q = Math.round(((heights[row + x0 + x] - min) / range) * 65535);
          q = q < 0 ? 0 : q > 65535 ? 65535 : q;
          const di = (row + x0 + x) * 2;
          mip.data[di] = q >>> 8;
          mip.data[di + 1] = q & 255;
          const oi = (y * w + x) * 2;
          out[oi] = q >>> 8;
          out[oi + 1] = q & 255;
        }
      }
    } else {
      const prev = this.#mip(this.#height.texture, level - 1);
      const readU16 = (index: number) => (prev.data[index * 2] << 8) | prev.data[index * 2 + 1];
      for (let y = 0; y < h; y++) {
        const sy0 = (y0 + y) * 2;
        const sy1 = Math.min(prev.height - 1, sy0 + 1);
        for (let x = 0; x < w; x++) {
          const sx0 = (x0 + x) * 2;
          const sx1 = Math.min(prev.width - 1, sx0 + 1);
          const q = Math.round((
            readU16(sy0 * prev.width + sx0) +
            readU16(sy0 * prev.width + sx1) +
            readU16(sy1 * prev.width + sx0) +
            readU16(sy1 * prev.width + sx1)
          ) * 0.25);
          const di = ((y0 + y) * mip.width + x0 + x) * 2;
          mip.data[di] = q >>> 8;
          mip.data[di + 1] = q & 255;
          const oi = (y * w + x) * 2;
          out[oi] = q >>> 8;
          out[oi + 1] = q & 255;
        }
      }
    }
    return out;
  }

  /** Recompute a normal-pyramid sub-rect from the current heights. Mip levels
   *  ≥ 1 decode the quantized height mip (± half a 0.01 m step of the boot
   *  float chain — invisible inside 8-bit normal channels). */
  #refreshNormalRect(level: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
    const mip = this.#mip(this.#normal.texture, level);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const width = mip.width;
    const height = mip.height;
    const cellSize = this.#grid.cellSize * (1 << level);
    let sample: (gx: number, gz: number) => number;
    if (level === 0) {
      const heights = this.#map.heights;
      const W = this.#grid.width;
      sample = (gx, gz) => heights[gz * W + gx];
    } else {
      const heightMip = this.#mip(this.#height.texture, level);
      const { min, range } = this.#height;
      sample = (gx, gz) => {
        const index = (gz * heightMip.width + gx) * 2;
        return min + (((heightMip.data[index] << 8) | heightMip.data[index + 1]) / 65535) * range;
      };
    }
    const clampX = (v: number) => (v < 0 ? 0 : v > width - 1 ? width - 1 : v);
    const clampY = (v: number) => (v < 0 ? 0 : v > height - 1 ? height - 1 : v);
    const out = new Uint8Array(w * h * 2);
    for (let y = 0; y < h; y++) {
      const gy = y0 + y;
      const ya = clampY(gy - 1);
      const yb = gy;
      const yc = clampY(gy + 1);
      for (let x = 0; x < w; x++) {
        const gx = x0 + x;
        const xa = clampX(gx - 1);
        const xc = clampX(gx + 1);
        // Same separable [1 2 1] derivative as encodeNormalMip.
        const left = sample(xa, ya) + 2 * sample(xa, yb) + sample(xa, yc);
        const right = sample(xc, ya) + 2 * sample(xc, yb) + sample(xc, yc);
        const down = sample(xa, ya) + 2 * sample(gx, ya) + sample(xc, ya);
        const up = sample(xa, yc) + 2 * sample(gx, yc) + sample(xc, yc);
        let nx = left - right;
        const ny = cellSize * 8;
        let nz = down - up;
        const inverseLength = 1 / Math.max(1e-6, Math.hypot(nx, ny, nz));
        nx *= inverseLength;
        nz *= inverseLength;
        const r = Math.round((Math.max(-1, Math.min(1, nx)) * 0.5 + 0.5) * 255);
        const g = Math.round((Math.max(-1, Math.min(1, nz)) * 0.5 + 0.5) * 255);
        const di = (gy * width + gx) * 2;
        mip.data[di] = r;
        mip.data[di + 1] = g;
        const oi = (y * w + x) * 2;
        out[oi] = r;
        out[oi + 1] = g;
      }
    }
    return out;
  }

  /** Recompute a surface-weight sub-rect. Level 0 mirrors the full build's
   *  erosion + feather over the rect (computeSurfaceWeightsRegion); coarser
   *  levels box-average the previous mip like downsampleWeights. */
  #refreshSurfaceRect(level: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
    const mip = this.#mip(this.#surface.texture, level);
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    if (level === 0) {
      const rows = computeSurfaceWeightsRegion(
        this.#map.surface,
        this.#grid.width,
        this.#grid.height,
        x0,
        y0,
        x1,
        y1
      );
      for (let y = 0; y < h; y++) {
        mip.data.set(rows.subarray(y * w * 4, (y + 1) * w * 4), ((y0 + y) * mip.width + x0) * 4);
      }
      return rows;
    }
    const prev = this.#mip(this.#surface.texture, level - 1);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const sy0 = (y0 + y) * 2;
      const sy1 = Math.min(prev.height - 1, sy0 + 1);
      for (let x = 0; x < w; x++) {
        const sx0 = (x0 + x) * 2;
        const sx1 = Math.min(prev.width - 1, sx0 + 1);
        for (let channel = 0; channel < 4; channel++) {
          const value = Math.round((
            prev.data[(sy0 * prev.width + sx0) * 4 + channel] +
            prev.data[(sy0 * prev.width + sx1) * 4 + channel] +
            prev.data[(sy1 * prev.width + sx0) * 4 + channel] +
            prev.data[(sy1 * prev.width + sx1) * 4 + channel]
          ) * 0.25);
          mip.data[((y0 + y) * mip.width + x0 + x) * 4 + channel] = value;
          out[(y * w + x) * 4 + channel] = value;
        }
      }
    }
    return out;
  }

  /**
   * Install one streamed 800 m tile's texel region across all three pyramids
   * (mip0 + 3 coarser mips each) and refresh the frustum height bounds.
   * `gx0/gz0` are the tile's base cell, `cellsX/cellsZ` its extent. Budget:
   * the streamer calls this at most once per frame. Returns the CPU+encode
   * cost in ms (upload is a queue write + sub-rect GPU copy).
   */
  applyTileRegion(
    renderer: THREE.WebGPURenderer,
    gx0: number,
    gz0: number,
    cellsX: number,
    cellsZ: number
  ): number {
    const started = performance.now();
    const mipCount = (this.#height.texture.mipmaps as unknown as unknown[]).length;
    type Rect = { x0: number; y0: number; x1: number; y1: number };
    const heightRects: Rect[] = [];
    let rect: Rect = { x0: gx0, y0: gz0, x1: gx0 + cellsX - 1, y1: gz0 + cellsZ - 1 };
    for (let level = 0; level < mipCount; level++) {
      const mip = this.#mip(this.#height.texture, level);
      const clamped: Rect = {
        x0: Math.max(0, rect.x0),
        y0: Math.max(0, rect.y0),
        x1: Math.min(mip.width - 1, rect.x1),
        y1: Math.min(mip.height - 1, rect.y1)
      };
      heightRects.push(clamped);
      const rows = this.#refreshHeightRect(level, clamped.x0, clamped.y0, clamped.x1, clamped.y1);
      this.#uploadRect(
        renderer,
        this.#height.texture,
        level,
        clamped.x0,
        clamped.y0,
        clamped.x1 - clamped.x0 + 1,
        clamped.y1 - clamped.y0 + 1,
        rows,
        2
      );
      // Next level: halve, then expand one texel so box averages crossing the
      // rect border recompute conservatively.
      rect = {
        x0: (clamped.x0 >> 1) - 1,
        y0: (clamped.y0 >> 1) - 1,
        x1: (clamped.x1 >> 1) + 1,
        y1: (clamped.y1 >> 1) + 1
      };
    }
    for (let level = 0; level < mipCount; level++) {
      const mip = this.#mip(this.#normal.texture, level);
      const source = heightRects[level];
      const clamped: Rect = {
        x0: Math.max(0, source.x0 - 1),
        y0: Math.max(0, source.y0 - 1),
        x1: Math.min(mip.width - 1, source.x1 + 1),
        y1: Math.min(mip.height - 1, source.y1 + 1)
      };
      const rows = this.#refreshNormalRect(level, clamped.x0, clamped.y0, clamped.x1, clamped.y1);
      this.#uploadRect(
        renderer,
        this.#normal.texture,
        level,
        clamped.x0,
        clamped.y0,
        clamped.x1 - clamped.x0 + 1,
        clamped.y1 - clamped.y0 + 1,
        rows,
        2
      );
    }
    // Surface weights reach 4 cells beyond the tile (erosion + feather).
    rect = { x0: gx0 - 4, y0: gz0 - 4, x1: gx0 + cellsX + 3, y1: gz0 + cellsZ + 3 };
    for (let level = 0; level < mipCount; level++) {
      const mip = this.#mip(this.#surface.texture, level);
      const clamped: Rect = {
        x0: Math.max(0, rect.x0),
        y0: Math.max(0, rect.y0),
        x1: Math.min(mip.width - 1, rect.x1),
        y1: Math.min(mip.height - 1, rect.y1)
      };
      const rows = this.#refreshSurfaceRect(level, clamped.x0, clamped.y0, clamped.x1, clamped.y1);
      this.#uploadRect(
        renderer,
        this.#surface.texture,
        level,
        clamped.x0,
        clamped.y0,
        clamped.x1 - clamped.x0 + 1,
        clamped.y1 - clamped.y0 + 1,
        rows,
        4
      );
      rect = {
        x0: (clamped.x0 >> 1) - 1,
        y0: (clamped.y0 >> 1) - 1,
        x1: (clamped.x1 >> 1) + 1,
        y1: (clamped.y1 >> 1) + 1
      };
    }
    this.#bounds.updateRegion(gx0, gz0, gx0 + cellsX - 1, gz0 + cellsZ - 1);
    this.#lastTileInstallMs = performance.now() - started;
    return this.#lastTileInstallMs;
  }

  get lastTileInstallMs(): number {
    return this.#lastTileInstallMs;
  }

  /** M14 QA: the encoded mip0 height data + quantization constants — the exact
   *  bytes the GPU samples — for CPU↔GPU lockstep probes. */
  debugHeightEncoding(): {
    min: number;
    range: number;
    mip0: { data: Uint8Array; width: number; height: number };
  } {
    return { min: this.#height.min, range: this.#height.range, mip0: this.#mip(this.#height.texture, 0) };
  }

  update(x: number, z: number, force = false): void {
    const centerX = terrainClipmapCenter(x);
    const centerZ = terrainClipmapCenter(z);
    if (!force && centerX === this.#centerX && centerZ === this.#centerZ) return;
    this.#centerX = centerX;
    this.#centerZ = centerZ;
    this.#center.value.set(centerX, centerZ);

    for (const entry of [...this.#levelMeshes, this.#sourceGridCenter]) {
      const halfExtent = entry.level.halfExtent;
      entry.mesh.position.set(centerX, 0, centerZ);
      const bounds = this.#bounds.query(
        centerX - halfExtent,
        centerX + halfExtent,
        centerZ - halfExtent,
        centerZ + halfExtent
      );
      const isSourceGridCenter = entry === this.#sourceGridCenter;
      const hiddenAdaptiveInnerLevel = !this.#adaptiveMeterMesh && entry.level.level <= 3;
      entry.mesh.visible = bounds !== null && (
        isSourceGridCenter ? !this.#adaptiveMeterMesh : !hiddenAdaptiveInnerLevel
      );
      if (!bounds) continue;
      const box = entry.geometry.boundingBox ?? new THREE.Box3();
      box.min.set(-halfExtent, bounds.min, -halfExtent);
      box.max.set(halfExtent, bounds.max, halfExtent);
      entry.geometry.boundingBox = box;
      entry.geometry.boundingSphere ??= new THREE.Sphere();
      box.getBoundingSphere(entry.geometry.boundingSphere);
    }
  }

  applyTuning(): void {
    this.setAdaptiveMeterMesh(TERRAIN_CLIPMAP_TUNING.values.adaptiveMeterMesh);
    this.#morphBand.value = TERRAIN_CLIPMAP_TUNING.values.morphBand;
    this.#macroVariation.value = TERRAIN_CLIPMAP_TUNING.values.macroVariation;
    this.#microVariation.value = TERRAIN_CLIPMAP_TUNING.values.microVariation;
    this.setLevelDebug(TERRAIN_CLIPMAP_TUNING.values.debugLevels);
  }

  /** Switch between the adaptive 1 m near mesh and a direct 8 m source-grid mesh. */
  setAdaptiveMeterMesh(enabled: boolean): void {
    if (enabled === this.#adaptiveMeterMesh) return;
    this.#adaptiveMeterMesh = enabled;
    if (Number.isFinite(this.#centerX) && Number.isFinite(this.#centerZ)) {
      this.update(this.#centerX, this.#centerZ, true);
    }
  }

  /** Runtime/probe override; persisted UI changes still flow through applyTuning. */
  setLevelDebug(enabled: boolean): void {
    this.#debugLevels.value = enabled ? 1 : 0;
  }

  stats(): TerrainClipmapStats {
    return {
      levels: this.#layout.length,
      patches: this.#layout.reduce((sum, level) => sum + level.patches.length, 0),
      meshes: this.#levelMeshes.length,
      vertices: terrainClipmapVertexCount(this.#layout),
      triangles: terrainClipmapTriangleCount(this.#layout),
      nearSpacing: this.#layout[0].spacing,
      activeNearSpacing: this.#adaptiveMeterMesh ? this.#layout[0].spacing : this.#sourceGridCenter.level.spacing,
      adaptiveMeterMesh: this.#adaptiveMeterMesh,
      farSpacing: this.#layout.at(-1)!.spacing,
      coverageRadius: this.#layout.at(-1)!.halfExtent,
      centerX: this.#centerX,
      centerZ: this.#centerZ,
      buildMs: Number(this.#buildMs.toFixed(2)),
      geometryBytes: this.#geometryBytes,
      heightTextureBytes: this.#height.bytes,
      normalTextureBytes: this.#normal.bytes,
      surfaceTextureBytes: this.#surface.bytes
    };
  }

  dispose(): void {
    for (const entry of this.#levelMeshes) entry.geometry.dispose();
    this.#sourceGridCenter.geometry.dispose();
    for (const material of this.#materials) material.dispose();
    this.#height.texture.dispose();
    this.#normal.texture.dispose();
    this.#surface.texture.dispose();
    this.#detailTexture.dispose();
    this.#stagingRG?.dispose();
    this.#stagingRGBA?.dispose();
    this.group.clear();
  }
}
