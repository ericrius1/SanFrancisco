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
  createTerrainDetailTextureData,
  createTerrainNormalMipData,
  createTerrainSurfaceMipData
} from "./terrainMaterialData";

// TSL's composed node types become unwieldy across texture-stage operations;
// the project uses this local alias for shader graphs while retaining typed
// public/runtime surfaces.
type N = any;

const HEIGHT_MIP_LEVELS = 4;
const HEIGHT_BOUNDS_BLOCK_CELLS = 8;
const BOUNDS_Y_MARGIN = 1;

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
      const iz0 = bz * HEIGHT_BOUNDS_BLOCK_CELLS;
      const iz1 = Math.min(height - 1, iz0 + HEIGHT_BOUNDS_BLOCK_CELLS);
      for (let bx = 0; bx < this.#width; bx++) {
        const ix0 = bx * HEIGHT_BOUNDS_BLOCK_CELLS;
        const ix1 = Math.min(width - 1, ix0 + HEIGHT_BOUNDS_BLOCK_CELLS);
        let minY = Infinity;
        let maxY = -Infinity;
        for (let iz = iz0; iz <= iz1; iz++) {
          const row = iz * width;
          for (let ix = ix0; ix <= ix1; ix++) {
            const y = map.heights[row + ix];
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
          }
        }
        const index = bz * this.#width + bx;
        this.#mins[index] = minY;
        this.#maxs[index] = maxY;
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
  let sourceMin = Infinity;
  let sourceMax = -Infinity;
  for (const height of map.heights) {
    sourceMin = Math.min(sourceMin, height);
    sourceMax = Math.max(sourceMax, height);
  }
  const min = Math.floor(sourceMin) - 1;
  const maxHeight = Math.ceil(sourceMax) + 1;
  const range = maxHeight - min;
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
    material.colorNode = terrainColor;
    material.roughnessNode = surface.a.mul(0.03).add(0.94);

    const worldMaxX = grid.minX + (grid.width - 1) * grid.cellSize;
    const worldMaxZ = grid.minZ + (grid.height - 1) * grid.cellSize;
    const inBounds = step(grid.minX, (positionWorld as N).x)
      .mul(step((positionWorld as N).x, worldMaxX))
      .mul(step(grid.minZ, (positionWorld as N).z))
      .mul(step((positionWorld as N).z, worldMaxZ));
    material.opacityNode = inBounds.mul(terrainCutoutMask());
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
    this.group.clear();
  }
}
