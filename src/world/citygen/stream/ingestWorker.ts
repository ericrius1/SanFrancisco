// Citywide CityGen ingestion worker. The 20 MB JSON fetch, JSON.parse, footprint
// bounds, and global 32 m neighbour index all stay off the main thread. Only
// compact typed arrays transfer back; ring.ts materializes destination cells on
// demand instead of hydrating ~92k Entry objects at boot.
import type {
  CityGridIngestReply,
  CityGridIngestRequest,
  PackedCityGrid
} from "./ingestTypes";

type RawBuilding = {
  i: number;
  id: number;
  poly: [number, number][];
  base: number;
  top: number;
  h?: number;
  archetype: string;
  seed: number;
};

type RawGrid = {
  tile: number;
  minX: number;
  minZ: number;
  tilesX: number;
  tilesZ: number;
  cells: Record<string, RawBuilding[]>;
};

const READY = new Set(["victorian", "edwardian", "marina", "downtown", "soma"]);
const STREET_BIN = 32;

function pack(raw: RawGrid): PackedCityGrid {
  const cellKeys: string[] = [];
  const cellStarts: number[] = [0];
  const archetypes: string[] = [];
  const archetypeIndex = new Map<string, number>();
  const sourceIndices: number[] = [];
  const ids: number[] = [];
  const seeds: number[] = [];
  const archetypeCodes: number[] = [];
  const heights: number[] = [];
  const bounds: number[] = [];
  const polyStarts: number[] = [0];
  const polyXZ: number[] = [];
  const bins = new Map<string, { ix: number; iz: number; members: number[] }>();
  let readyCount = 0;

  for (const [cellKey, buildings] of Object.entries(raw.cells)) {
    cellKeys.push(cellKey);
    for (const building of buildings) {
      const packedIndex = sourceIndices.length;
      let code = archetypeIndex.get(building.archetype);
      if (code === undefined) {
        code = archetypes.length;
        archetypes.push(building.archetype);
        archetypeIndex.set(building.archetype, code);
      }
      if (READY.has(building.archetype)) readyCount++;
      sourceIndices.push(building.i >>> 0);
      ids.push(building.id);
      seeds.push(building.seed >>> 0);
      archetypeCodes.push(code);
      heights.push(building.base, building.top, building.h ?? Number.NaN);

      let cx = 0;
      let cz = 0;
      let minx = Infinity;
      let maxx = -Infinity;
      let minz = Infinity;
      let maxz = -Infinity;
      for (const [x, z] of building.poly) {
        polyXZ.push(x, z);
        cx += x;
        cz += z;
        if (x < minx) minx = x;
        if (x > maxx) maxx = x;
        if (z < minz) minz = z;
        if (z > maxz) maxz = z;
      }
      const count = Math.max(1, building.poly.length);
      bounds.push(cx / count, cz / count, minx, maxx, minz, maxz);
      polyStarts.push(polyXZ.length / 2);

      const ix0 = Math.floor(minx / STREET_BIN);
      const ix1 = Math.floor(maxx / STREET_BIN);
      const iz0 = Math.floor(minz / STREET_BIN);
      const iz1 = Math.floor(maxz / STREET_BIN);
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iz = iz0; iz <= iz1; iz++) {
          const key = `${ix}_${iz}`;
          let bin = bins.get(key);
          if (!bin) {
            bin = { ix, iz, members: [] };
            bins.set(key, bin);
          }
          bin.members.push(packedIndex);
        }
      }
    }
    cellStarts.push(sourceIndices.length);
  }

  const orderedBins = [...bins.values()].sort((a, b) => a.ix - b.ix || a.iz - b.iz);
  const binCoords = new Int32Array(orderedBins.length * 2);
  const binStarts = new Uint32Array(orderedBins.length + 1);
  let membershipCount = 0;
  for (let i = 0; i < orderedBins.length; i++) {
    const bin = orderedBins[i];
    binCoords[i * 2] = bin.ix;
    binCoords[i * 2 + 1] = bin.iz;
    binStarts[i] = membershipCount;
    membershipCount += bin.members.length;
  }
  binStarts[orderedBins.length] = membershipCount;
  const binMembers = new Uint32Array(membershipCount);
  let cursor = 0;
  for (const bin of orderedBins) {
    binMembers.set(bin.members, cursor);
    cursor += bin.members.length;
  }

  return {
    tile: raw.tile,
    minX: raw.minX,
    minZ: raw.minZ,
    tilesX: raw.tilesX,
    tilesZ: raw.tilesZ,
    readyCount,
    cellKeys,
    cellStarts: Uint32Array.from(cellStarts),
    archetypes,
    sourceIndices: Uint32Array.from(sourceIndices),
    ids: Float64Array.from(ids),
    seeds: Uint32Array.from(seeds),
    archetypeCodes: Uint16Array.from(archetypeCodes),
    heights: Float32Array.from(heights),
    bounds: Float32Array.from(bounds),
    polyStarts: Uint32Array.from(polyStarts),
    polyXZ: Float32Array.from(polyXZ),
    binCoords,
    binStarts,
    binMembers
  };
}

self.onmessage = async (event: MessageEvent<CityGridIngestRequest>) => {
  const { id, url } = event.data;
  try {
    const response = await fetch(url, { cache: "force-cache" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const raw = JSON.parse(await response.text()) as RawGrid;
    const grid = pack(raw);
    const transfer = [
      grid.cellStarts.buffer,
      grid.sourceIndices.buffer,
      grid.ids.buffer,
      grid.seeds.buffer,
      grid.archetypeCodes.buffer,
      grid.heights.buffer,
      grid.bounds.buffer,
      grid.polyStarts.buffer,
      grid.polyXZ.buffer,
      grid.binCoords.buffer,
      grid.binStarts.buffer,
      grid.binMembers.buffer
    ] as ArrayBuffer[];
    const reply: CityGridIngestReply = { id, grid };
    (self as unknown as { postMessage(message: unknown, transfer: ArrayBuffer[]): void }).postMessage(reply, transfer);
  } catch (error) {
    const reply: CityGridIngestReply = {
      id,
      error: error instanceof Error ? error.message : String(error)
    };
    self.postMessage(reply);
  }
};
