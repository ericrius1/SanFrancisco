/** Compact, transferable representation of the citywide CityGen source grid. */
export interface PackedCityGrid {
  tile: number;
  minX: number;
  minZ: number;
  tilesX: number;
  tilesZ: number;
  readyCount: number;

  /** Sparse cell keys and half-open building ranges into every per-building array. */
  cellKeys: string[];
  cellStarts: Uint32Array;
  archetypes: string[];

  sourceIndices: Uint32Array;
  /** OSM ids can exceed uint32 outside this particular dataset. */
  ids: Float64Array;
  seeds: Uint32Array;
  archetypeCodes: Uint16Array;
  /** [base, top, h-or-NaN] per building. */
  heights: Float32Array;
  /** [cx, cz, minx, maxx, minz, maxz] per building. */
  bounds: Float32Array;
  polyStarts: Uint32Array;
  /** Flat x,z pairs for every footprint vertex. */
  polyXZ: Float32Array;

  /** Sparse 32 m street-neighbour bins, lexicographically sorted by ix then iz. */
  binCoords: Int32Array;
  binStarts: Uint32Array;
  binMembers: Uint32Array;
}

export interface CityGridIngestRequest {
  id: number;
  url: string;
}

export interface CityGridIngestReply {
  id: number;
  grid?: PackedCityGrid;
  error?: string;
}
