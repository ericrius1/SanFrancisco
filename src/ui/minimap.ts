import type { WorldMap } from "../world/heightmap";
import type { PlayerMode } from "../player/types";
import { BOTANICAL_GARDEN_BOUNDS } from "../world/garden/layout";
import { WILD_REGIONS } from "../world/wildlands/regions";
import { SPAWN_POINTS } from "../world/spawnPoints";
import type { RoadGraph } from "../world/traffic/roadGraph";
import { CANVAS_FONT_FAMILY } from "../core/typography";

/**
 * Minimap (top-left, always on) + full-city map (M or click to expand).
 *
 * The immediate terrain backdrop is painted from the heightmap + surface-class
 * grids the game already ships (8 m/px). The expanded map then first-use loads
 * a period-cartography pyramid: one city overview, viewport-selected regional
 * plates, and a smaller Golden Gate detail tile at close zoom. Authoritative
 * roads/bridges stay as live vectors above the artwork.
 * Everything here is 2D canvas; the WebGPU world renderer remains untouched.
 *
 * Multiplayer: every remote player is a colored dot (their server-assigned
 * hue, same as their name tag). On the minimap, players outside the view are
 * clamped to the rim so you always know which way to head. The expanded map
 * can be panned/zoomed; pick a spot, then Enter / X to teleport.
 */

export type MapSelf = { name: string; x: number; z: number; fx: number; fz: number; hue: number };
export type MapRemote = { id: number; name: string; hue: number; x: number; z: number; mode: PlayerMode };
export type MapLayerId = "art" | "science" | "music";
export type MapLayerPoint = { id: string; layer: MapLayerId; title: string; x: number; z: number };

// A minimap teleport target: a player follows its dot, everything else is a
// fixed ground/landmark point.
type MiniSelection =
  | { kind: "player"; id: number; name: string }
  | { kind: "fixed"; x: number; z: number; name: string; toName?: string };
type MiniLandmark = { x: number; z: number; name: string };
type LabelBox = { l: number; t: number; r: number; b: number };
type LandmarkLabelPlacement = {
  textX: number;
  textY: number;
  align: CanvasTextAlign;
  pill?: { x: number; y: number; w: number; h: number };
};

const MAP_FONT = CANVAS_FONT_FAMILY;
const MINI_SIZE = 236; // css px
const MINI_SPAN = 1400; // metres across the minimap view
const MINI_MIN_SPAN = 260;
const MINI_ZOOM_SPEED = 0.0012;
const MINI_DRAG_PX = 4;
const BIG_ZOOM_SPEED = 0.0012;
/** Closest expanded-map zoom (metres across). Stops short of the atlas
 *  upsampling into mush — roughly a neighborhood of city blocks. */
const BIG_MIN_SPAN = 1200;
const BIG_RECENTER_MS = 420;
const PAD_PAN_SPEED = 0.7; // view-spans per second at full stick
const PAD_ZOOM_SPEED = 1.6; // exp rate per second at full trigger / stick
const DOT_HIT_PX = 14; // expanded-map click tolerance around a player dot
const PLACE_HIT_PX = 13;
const GROUND_TARGET_NAME = "Selected spot";
const LANDMARK_DOT_COLOR = "#6fd7c4";
// Bridge decks are painted on the map in their real colour so the spans read at
// a glance. Keyed by the `color` name in meta.json bridges.
const BRIDGE_COLORS: Record<string, string> = {
  internationalOrange: "#d1541f",
  gray: "#9aa6af"
};
const BRIDGE_FALLBACK_COLOR = "#c85a2a";
const LAYERS_ENABLED = false; // art/science/music layers parked for now
// OSM road classes: living street, residential, tertiary, secondary,
// primary/trunk, motorway. The warm progression belongs to the historical
// survey-map treatment while keeping the hierarchy readable under player pins.
const ROAD_COLORS = ["#e4d7b8", "#dfcfaa", "#d7bd8d", "#cea66e", "#c58d52", "#bd7541"] as const;
/** Fraction of the expanded viewport that may show off-map backdrop at each edge. */
const BIG_EDGE_BLEED = 0.035;
/** Live overlay layers drawn above the parchment (roads first; more later). */
export type MapOverlayId = "roads" | "landmarks";
type MapOverlayDefinition = { id: MapOverlayId; label: string; color: string };
const MAP_OVERLAY_DEFS: readonly MapOverlayDefinition[] = [
  { id: "roads", label: "Roads", color: "#c58d52" },
  { id: "landmarks", label: "Landmarks", color: LANDMARK_DOT_COLOR }
];
const HISTORICAL_OVERVIEW_URL = "/map/historical-atlas/city-overview.webp";
const HISTORICAL_DETAIL_URL = "/map/golden-gate-historical-detail.webp";
const HISTORICAL_WORLD_BOUNDS = { minX: -7168, maxX: 7936, minZ: -8896, maxZ: 4992 } as const;
const HISTORICAL_DETAIL_BOUNDS = {
  minX: -3232,
  maxX: -2732,
  minZ: -3172.5,
  maxZ: -2422.5
} as const;
const HISTORICAL_REGIONAL_LOAD_SPAN = 6800;
const HISTORICAL_DETAIL_LOAD_SPAN = 900;

type HistoricalBounds = { minX: number; maxX: number; minZ: number; maxZ: number };
type HistoricalTileSpec = {
  id: string;
  url: string;
  bounds: HistoricalBounds;
  coreBounds: HistoricalBounds;
};

// 3 x 3 generated atlas level. Bounds include a 5.5% bleed (clamped at the
// world edge), which is alpha-feathered over the overview to hide model-to-
// model texture changes without moving any live geometry.
const HISTORICAL_REGION_TILES: readonly HistoricalTileSpec[] = [
  {
    id: "r0-c0",
    url: "/map/historical-atlas/region-r0-c0.webp",
    bounds: { minX: -7168, maxX: -1856.4267, minZ: -8896, maxZ: -4012.0533 },
    coreBounds: { minX: -7168, maxX: -2133.3333, minZ: -8896, maxZ: -4266.6667 }
  },
  {
    id: "r0-c1",
    url: "/map/historical-atlas/region-r0-c1.webp",
    bounds: { minX: -2410.24, maxX: 3178.24, minZ: -8896, maxZ: -4012.0533 },
    coreBounds: { minX: -2133.3333, maxX: 2901.3333, minZ: -8896, maxZ: -4266.6667 }
  },
  {
    id: "r0-c2",
    url: "/map/historical-atlas/region-r0-c2.webp",
    bounds: { minX: 2624.4267, maxX: 7936, minZ: -8896, maxZ: -4012.0533 },
    coreBounds: { minX: 2901.3333, maxX: 7936, minZ: -8896, maxZ: -4266.6667 }
  },
  {
    id: "r1-c0",
    url: "/map/historical-atlas/region-r1-c0.webp",
    bounds: { minX: -7168, maxX: -1856.4267, minZ: -4521.28, maxZ: 617.28 },
    coreBounds: { minX: -7168, maxX: -2133.3333, minZ: -4266.6667, maxZ: 362.6667 }
  },
  {
    id: "r1-c1",
    url: "/map/historical-atlas/region-r1-c1.webp",
    bounds: { minX: -2410.24, maxX: 3178.24, minZ: -4521.28, maxZ: 617.28 },
    coreBounds: { minX: -2133.3333, maxX: 2901.3333, minZ: -4266.6667, maxZ: 362.6667 }
  },
  {
    id: "r1-c2",
    url: "/map/historical-atlas/region-r1-c2.webp",
    bounds: { minX: 2624.4267, maxX: 7936, minZ: -4521.28, maxZ: 617.28 },
    coreBounds: { minX: 2901.3333, maxX: 7936, minZ: -4266.6667, maxZ: 362.6667 }
  },
  {
    id: "r2-c0",
    url: "/map/historical-atlas/region-r2-c0.webp",
    bounds: { minX: -7168, maxX: -1856.4267, minZ: 108.0533, maxZ: 4992 },
    coreBounds: { minX: -7168, maxX: -2133.3333, minZ: 362.6667, maxZ: 4992 }
  },
  {
    id: "r2-c1",
    url: "/map/historical-atlas/region-r2-c1.webp",
    bounds: { minX: -2410.24, maxX: 3178.24, minZ: 108.0533, maxZ: 4992 },
    coreBounds: { minX: -2133.3333, maxX: 2901.3333, minZ: 362.6667, maxZ: 4992 }
  },
  {
    id: "r2-c2",
    url: "/map/historical-atlas/region-r2-c2.webp",
    bounds: { minX: 2624.4267, maxX: 7936, minZ: 108.0533, maxZ: 4992 },
    coreBounds: { minX: 2901.3333, maxX: 7936, minZ: 362.6667, maxZ: 4992 }
  }
] as const;

type RoadPaintGroup = { path: Path2D; width: number; roadClass: number };

const LANDMARK_LABELS: Record<string, string> = {
  transamerica: "Transamerica",
  salesforce: "Salesforce",
  coit: "Coit Tower",
  ferry: "Ferry Building",
  alcatraz: "Alcatraz",
  sutro: "Sutro Tower",
  coronaHeights: "Corona Heights Park"
};

type MapLayerDefinition = {
  id: MapLayerId;
  label: string;
  color: string;
  count: number;
  titles: readonly string[];
};
type MapLayer = MapLayerDefinition & { enabled: boolean; points: MapLayerPoint[] };

const MAP_LAYER_DEFS: readonly MapLayerDefinition[] = [
  {
    id: "art",
    label: "Art",
    color: "#ff6b5e",
    count: 12,
    titles: [
      "Mural Wall",
      "Gallery Pop-up",
      "Sculpture Yard",
      "Ceramic Window",
      "Print Studio",
      "Neon Stair",
      "Street Sketch",
      "Textile Room"
    ]
  },
  {
    id: "science",
    label: "Science",
    color: "#43dce7",
    count: 11,
    titles: [
      "Fog Sensor",
      "Maker Bench",
      "Telescope Demo",
      "Robotics Lab",
      "Bay Model",
      "Bio Booth",
      "Wind Tunnel",
      "Light Table"
    ]
  },
  {
    id: "music",
    label: "Music",
    color: "#9a6bff",
    count: 10,
    titles: [
      "Jazz Corner",
      "Synth Stage",
      "Vinyl Kiosk",
      "Drum Circle",
      "Choir Steps",
      "Ambient Room",
      "Busker Loop",
      "Tape Deck"
    ]
  }
];

export class Minimap {
  /** Fires with a world position when the user asks to teleport. `playerId`
   * is set when the target is a player — main.ts matches their altitude and
   * mode instead of dropping to the ground. */
  onTeleport: (x: number, z: number, toName?: string, playerId?: number) => void = () => {};
  /** Fires when a map-layer point is clicked. Real spots/exhibits/films can hook in here later. */
  onPlaceClick: (place: MapLayerPoint) => void = () => {};
  /** Expanded state changed (main.ts releases/requests pointer lock). */
  onExpandChange: (expanded: boolean) => void = () => {};

  #map: WorldMap;
  #getSelf: () => MapSelf;
  #getRemotes: () => MapRemote[];

  #world!: HTMLCanvasElement; // pre-rendered terrain, 1 grid cell = 1 px
  #roadsPainted = false;
  #roadPaths: RoadPaintGroup[] = [];
  #historicalOverview: HTMLCanvasElement | null = null;
  #historicalOverviewStarted = false;
  #historicalRegions = new Map<string, HTMLCanvasElement>();
  #historicalRegionsStarted = new Set<string>();
  #historicalDetail: HTMLCanvasElement | null = null;
  #historicalDetailStarted = false;
  #mini!: HTMLCanvasElement;
  #count!: HTMLSpanElement;
  #teleWrap!: HTMLDivElement;
  #teleName!: HTMLSpanElement;
  #selected: MiniSelection | null = null;
  #big: HTMLCanvasElement | null = null;
  #bigWrap: HTMLDivElement | null = null;
  #bigRecenter: HTMLButtonElement | null = null;
  /** Floating “Enter/X to teleport” callout anchored to the selection marker. */
  #bigPinHint: HTMLDivElement | null = null;
  #pinHintKey: string | null = null;
  #device: "kb" | "pad" = "kb";
  #dpr = 1;
  #layers: MapLayer[] = [];
  #layerButtons = new Map<MapLayerId, HTMLButtonElement>();
  // Roads off by default — the parchment already shows the street grid, and
  // Big Map use is landmark-oriented (toggle still available in the side tray).
  #overlays = new Map<MapOverlayId, boolean>(
    MAP_OVERLAY_DEFS.map((d) => [d.id, d.id !== "roads"])
  );
  #overlayButtons = new Map<MapOverlayId, HTMLButtonElement>();
  #selectedPlaceId: string | null = null;
  expanded = false;
  #miniSpan = MINI_SPAN;
  #miniCenter: { x: number; z: number } | null = null; // null means follow self
  #miniDrag:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        centerX: number;
        centerZ: number;
        moved: boolean;
      }
    | null = null;
  #miniSuppressClick = false;
  #bigSpan = 0;
  #bigCenter: { x: number; z: number } | null = null;
  /** Smooth pan+zoom toward the local player after clicking recenter. */
  #bigRecenterAnim: {
    t0: number;
    duration: number;
    fromX: number;
    fromZ: number;
    fromSpan: number;
    toX: number;
    toZ: number;
    toSpan: number;
  } | null = null;
  #bigDrag:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        centerX: number;
        centerZ: number;
        spanZ: number;
        moved: boolean;
      }
    | null = null;
  #bigSuppressClick = false;
  // Gamepad selection crosshair on the expanded map. Stays at view center
  // (nx/ny = 0); left stick pans the map under it. A selects under it.
  #padCursor: { nx: number; ny: number } | null = null;
  // expanded-map dot hit-boxes rebuilt every draw: [screenX, screenY, remote]
  #hits: [number, number, MapRemote][] = [];
  #miniPlaceHits: [number, number, MapLayerPoint][] = [];
  #bigPlaceHits: [number, number, MapLayerPoint][] = [];
  #bigLandmarkHits: [number, number, MiniLandmark][] = [];
  // collapsed-map hit-boxes rebuilt every draw, for click-to-select-then-teleport
  #miniPlayerHits: [number, number, MapRemote][] = [];
  #miniLandmarkHits: [number, number, MiniLandmark][] = [];
  #landmarks: MiniLandmark[] = [];

  constructor(
    map: WorldMap,
    getSelf: () => MapSelf,
    getRemotes: () => MapRemote[]
  ) {
    this.#map = map;
    this.#getSelf = getSelf;
    this.#getRemotes = getRemotes;
    // The map is a DOM canvas, not the WebGPU surface, so it must opt into
    // Retina resolution itself. Cap at 2x to avoid pathological mobile DPRs.
    this.#dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.#paintWorldOffThread();
    // Skip palaceFineArts — Palace Reverie is the dedicated pin for that site.
    this.#landmarks = Object.entries(this.#map.meta.landmarks)
      .filter(([key]) => key !== "palaceFineArts")
      .map(([key, pos]) => ({
        x: pos.x,
        z: pos.z,
        name: LANDMARK_LABELS[key] ?? key
      }));
    // Pin the Golden Gate Bridge at its main-span midpoint (between the two
    // towers) so it gets a landmark dot + label + teleport like the rest.
    const ggb = this.#map.meta.bridges.find((b) => b.name === "Golden Gate Bridge");
    if (ggb && ggb.towers.length >= 2) {
      const [a, b] = ggb.towers;
      this.#landmarks.push({ x: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2, name: "Golden Gate Bridge" });
    }
    const missionDolores = SPAWN_POINTS.missionDolores;
    this.#landmarks.push({
      x: missionDolores.x,
      z: missionDolores.z,
      name: "Mission Dolores · Saint Francis"
    });
    // San Francisco Botanical Garden — a labelled dot + teleport at the garden's
    // own centre (real SFBG, east end of Golden Gate Park by the 9th Ave gate).
    // Location comes from the garden module itself, so the marker always sits
    // exactly where the vegetation renders.
    this.#landmarks.push({
      x: (BOTANICAL_GARDEN_BOUNDS.minX + BOTANICAL_GARDEN_BOUNDS.maxX) / 2,
      z: (BOTANICAL_GARDEN_BOUNDS.minZ + BOTANICAL_GARDEN_BOUNDS.maxZ) / 2,
      name: "Botanical Garden"
    });
    // Forest / open-space areas — the native wildlands regions each get a
    // labelled dot + teleport. The pin is a hand-picked point that lands you IN
    // the foliage (a grove or bloom drift on plantable ground), NOT the raw
    // region centre, which can fall on a road, rooftop or the bay.
    // Skip ggpark — Botanical Garden, Japanese Tea Garden, and Archery Range
    // already cover Golden Gate Park with activity-specific pins.
    const sutroArrival = SPAWN_POINTS.sutroTower;
    const NATURE_ANCHORS: { id: string; name: string; x: number; z: number }[] = [
      { id: "presidio", name: "The Presidio", x: -1820, z: -1520 }, // cypress ridge grove
      { id: "marin", name: "Marin Headlands", x: -4450, z: -6250 }, // poppy hills + groves
      // Reuse the cleared overlook instead of the tower's geographic centre.
      // Landing inside the three splayed legs surrounds the camera with the
      // 300 m structure and makes it look as though the tower follows the view.
      { id: "twinpeaks", name: "Mount Sutro", x: sutroArrival.x, z: sutroArrival.z }
    ];
    const wildIds = new Set<string>(WILD_REGIONS.map((r) => r.id));
    for (const a of NATURE_ANCHORS) {
      if (wildIds.has(a.id)) this.#landmarks.push({ x: a.x, z: a.z, name: a.name });
    }
    // Procedurally-generated building districts (src/world/citygen): each pin drops
    // you into a neighborhood the CityGen ring rebuilds in its true SF style, so you
    // can go see the new buildings. Coords are dense, style-correct clusters verified
    // against the export (see tools/citygen-classify.mjs district boxes).
    const CITYGEN_ANCHORS: { name: string; x: number; z: number }[] = [
      { name: "Pacific Heights", x: 402, z: -1608 }, // grand Victorians
      { name: "The Castro", x: 199, z: 3197 },       // Victorian/Edwardian rowhouses
      { name: "Sunset District", x: -3900, z: 4300 },// Mediterranean stucco
      { name: "SoMa", x: 592, z: 1205 },             // brick warehouses + lofts
      { name: "Downtown", x: 2412, z: -796 }         // commercial mid-rise
    ];
    for (const a of CITYGEN_ANCHORS) this.#landmarks.push({ x: a.x, z: a.z, name: a.name });
    this.#layers = MAP_LAYER_DEFS.map((def) => ({
      ...def,
      enabled: false,
      points: LAYERS_ENABLED ? this.#fakeLayerPoints(def) : []
    }));
    this.#bigSpan = this.#bigMaxSpan();
    this.#buildMini();
  }

  /** Add an asynchronously loaded world feature (golf, future activities) to
   *  both map views without duplicating its coordinates in static metadata. */
  addLandmark(x: number, z: number, name: string) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !name) return;
    const existing = this.#landmarks.find((l) => l.name === name);
    if (existing) {
      existing.x = x;
      existing.z = z;
    } else {
      this.#landmarks.push({ x, z, name });
    }
    this.update();
  }

  /** Move a named landmark without forcing an immediate redraw (next update picks it up). */
  moveLandmark(name: string, x: number, z: number) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !name) return;
    const existing = this.#landmarks.find((l) => l.name === name);
    if (!existing) {
      this.addLandmark(x, z, name);
      return;
    }
    existing.x = x;
    existing.z = z;
  }

  /* ------------------------------------------------ terrain backdrop */

  #paintWorldOffThread() {
    const { width: W, height: H, cellSize, minX, minZ } = this.#map.meta.grid;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    // Immediate period-paper fallback while the full terrain wash is painted
    // off-thread. This avoids both a blank first draw and main-thread pixel work.
    ctx.fillStyle = "#beae8e";
    ctx.fillRect(0, 0, W, H);
    this.#world = c;
    try {
      const worker = new Worker(new URL("./minimapWorldWorker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ bitmap: ImageBitmap }>) => {
        worker.terminate();
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(event.data.bitmap, 0, 0);
        event.data.bitmap.close();
        if (this.#mini) this.update();
      };
      worker.onerror = (event) => {
        event.preventDefault();
        worker.terminate();
        console.warn("[minimap] terrain worker unavailable; using plain backdrop");
        if (this.#mini) this.update();
      };
      const heights = this.#map.heights.slice();
      const surface = this.#map.surface.slice();
      worker.postMessage(
        { width: W, height: H, cellSize, minX, minZ, heights, surface },
        [heights.buffer, surface.buffer]
      );
    } catch {
      console.warn("[minimap] terrain worker unavailable; using plain backdrop");
    }
  }

  /** Retain the traffic system's already-decoded road graph as grouped Path2D
   * geometry. Roads are painted in screen space, so close zoom never magnifies
   * the old 8 m/px raster. */
  setRoadGraph(roads: RoadGraph) {
    if (this.#roadsPainted) return;
    this.#roadsPainted = true;

    const { cellSize, minX, minZ } = this.#map.meta.grid;
    const paths = new Map<string, RoadPaintGroup>();
    roads.forEachSegment((pointsX, pointsZ, start, count, width, roadClass) => {
      if (count < 2) return;
      const cls = Math.max(0, Math.min(ROAD_COLORS.length - 1, roadClass));
      const key = `${cls}:${width}`;
      let group = paths.get(key);
      if (!group) {
        group = { path: new Path2D(), width, roadClass: cls };
        paths.set(key, group);
      }
      group.path.moveTo((pointsX[start] - minX) / cellSize, (pointsZ[start] - minZ) / cellSize);
      for (let i = 1; i < count; i++) {
        const p = start + i;
        group.path.lineTo((pointsX[p] - minX) / cellSize, (pointsZ[p] - minZ) / cellSize);
      }
    });

    this.#roadPaths = [...paths.values()];
    this.update();
  }

  #loadHistoricalOverview() {
    if (this.#historicalOverviewStarted) return;
    this.#historicalOverviewStarted = true;
    const image = new Image();
    image.decoding = "async";
    image.addEventListener(
      "load",
      () => {
        this.#historicalOverview = this.#featherHistoricalImage(image, 0.012);
        this.update();
      },
      { once: true }
    );
    image.src = HISTORICAL_OVERVIEW_URL;
  }

  #loadHistoricalRegion(tile: HistoricalTileSpec) {
    if (this.#historicalRegionsStarted.has(tile.id)) return;
    this.#historicalRegionsStarted.add(tile.id);
    const image = new Image();
    image.decoding = "async";
    image.addEventListener(
      "load",
      () => {
        this.#historicalRegions.set(tile.id, this.#featherHistoricalImage(image, 0.055));
        this.update();
      },
      { once: true }
    );
    image.src = tile.url;
  }

  #loadHistoricalDetail() {
    if (this.#historicalDetailStarted) return;
    this.#historicalDetailStarted = true;
    const image = new Image();
    image.decoding = "async";
    image.addEventListener(
      "load",
      () => {
        this.#historicalDetail = this.#featherHistoricalImage(image, 0.035);
        this.update();
      },
      { once: true }
    );
    image.src = HISTORICAL_DETAIL_URL;
  }

  #featherHistoricalImage(image: HTMLImageElement, verticalFade: number) {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = "destination-in";
    const gx = ctx.createLinearGradient(0, 0, canvas.width, 0);
    gx.addColorStop(0, "rgba(0,0,0,0)");
    gx.addColorStop(0.035, "rgba(0,0,0,1)");
    gx.addColorStop(0.965, "rgba(0,0,0,1)");
    gx.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gx;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const gy = ctx.createLinearGradient(0, 0, 0, canvas.height);
    gy.addColorStop(0, "rgba(0,0,0,0)");
    gy.addColorStop(verticalFade, "rgba(0,0,0,1)");
    gy.addColorStop(1 - verticalFade, "rgba(0,0,0,1)");
    gy.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = gy;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  #maybeLoadHistoricalDetail(center: { x: number; z: number }, spanX: number, spanZ: number) {
    if (spanX > HISTORICAL_DETAIL_LOAD_SPAN || this.#historicalDetailStarted) return;
    const minX = center.x - spanX / 2;
    const maxX = center.x + spanX / 2;
    const minZ = center.z - spanZ / 2;
    const maxZ = center.z + spanZ / 2;
    const intersects = !(
      maxX < HISTORICAL_DETAIL_BOUNDS.minX ||
      minX > HISTORICAL_DETAIL_BOUNDS.maxX ||
      maxZ < HISTORICAL_DETAIL_BOUNDS.minZ ||
      minZ > HISTORICAL_DETAIL_BOUNDS.maxZ
    );
    if (intersects) this.#loadHistoricalDetail();
  }

  #maybeLoadHistoricalRegions(center: { x: number; z: number }, spanX: number, spanZ: number) {
    if (spanX > HISTORICAL_REGIONAL_LOAD_SPAN) return;
    const view = {
      minX: center.x - spanX / 2,
      maxX: center.x + spanX / 2,
      minZ: center.z - spanZ / 2,
      maxZ: center.z + spanZ / 2
    };
    for (const tile of HISTORICAL_REGION_TILES) {
      const overlapX = Math.max(
        0,
        Math.min(view.maxX, tile.coreBounds.maxX) - Math.max(view.minX, tile.coreBounds.minX)
      );
      const overlapZ = Math.max(
        0,
        Math.min(view.maxZ, tile.coreBounds.maxZ) - Math.max(view.minZ, tile.coreBounds.minZ)
      );
      // Ignore a core sliver smaller than 2% of either view dimension. The
      // overview remains underneath that edge until the user pans into it.
      if (overlapX / spanX >= 0.02 && overlapZ / spanZ >= 0.02) this.#loadHistoricalRegion(tile);
    }
  }

  #drawHistoricalOverview(
    ctx: CanvasRenderingContext2D,
    px: (x: number) => number,
    pz: (z: number) => number
  ) {
    this.#drawHistoricalTile(ctx, this.#historicalOverview, HISTORICAL_WORLD_BOUNDS, px, pz);
  }

  #drawHistoricalRegions(
    ctx: CanvasRenderingContext2D,
    px: (x: number) => number,
    pz: (z: number) => number
  ) {
    for (const spec of HISTORICAL_REGION_TILES) {
      this.#drawHistoricalTile(ctx, this.#historicalRegions.get(spec.id) ?? null, spec.bounds, px, pz);
    }
  }

  #drawHistoricalDetail(
    ctx: CanvasRenderingContext2D,
    px: (x: number) => number,
    pz: (z: number) => number
  ) {
    this.#drawHistoricalTile(ctx, this.#historicalDetail, HISTORICAL_DETAIL_BOUNDS, px, pz);
  }

  #drawHistoricalTile(
    ctx: CanvasRenderingContext2D,
    tile: HTMLCanvasElement | null,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number },
    px: (x: number) => number,
    pz: (z: number) => number
  ) {
    if (!tile) return;
    const x = px(bounds.minX);
    const y = pz(bounds.minZ);
    const w = px(bounds.maxX) - x;
    const h = pz(bounds.maxZ) - y;
    ctx.drawImage(tile, x, y, w, h);
  }

  /** Add fine screen-resolution ink when regional source pixels become larger
   * than the display. The regional GPT plate still supplies the composition;
   * these deterministic water strokes and land stipples keep every close view
   * crisp without hundreds of eager bitmap tiles. */
  #drawCloseEngraving(
    ctx: CanvasRenderingContext2D,
    center: { x: number; z: number },
    spanX: number,
    spanZ: number
  ) {
    const maxSpan = 1900;
    if (spanX > maxSpan) return;
    const width = ctx.canvas.width;
    const height = ctx.canvas.height;
    const dpr = this.#dpr;
    const strength = Math.min(1, Math.max(0, (maxSpan - spanX) / 1150 + 0.18));
    const g = this.#map.meta.grid;
    const worldMaxX = g.minX + g.width * g.cellSize;
    const worldMaxZ = g.minZ + g.height * g.cellSize;
    const worldAt = (x: number, y: number) => ({
      x: center.x + (x / width - 0.5) * spanX,
      z: center.z + (y / height - 0.5) * spanZ
    });
    const inWorld = (x: number, z: number) =>
      x >= g.minX && x <= worldMaxX && z >= g.minZ && z <= worldMaxZ;

    ctx.save();
    ctx.lineWidth = Math.max(0.55, 0.42 * dpr);
    ctx.strokeStyle = `rgba(42,72,74,${0.28 * strength})`;
    ctx.beginPath();
    const lineGap = 7 * dpr;
    const sampleStep = 15 * dpr;
    for (let sy = -lineGap; sy <= height + lineGap; sy += lineGap) {
      let active = false;
      for (let sx = -sampleStep; sx <= width + sampleStep; sx += sampleStep) {
        const p = worldAt(sx, sy);
        const water = inWorld(p.x, p.z) && this.#map.isWater(p.x, p.z);
        const y = sy + Math.sin(p.x * 0.018 + p.z * 0.007) * 1.15 * dpr;
        if (!water) {
          active = false;
          continue;
        }
        if (active) ctx.lineTo(sx, y);
        else ctx.moveTo(sx, y);
        active = true;
      }
    }
    ctx.stroke();

    ctx.fillStyle = `rgba(73,58,39,${0.23 * strength})`;
    const dotGap = 13 * dpr;
    for (let sy = dotGap / 2; sy < height; sy += dotGap) {
      for (let sx = dotGap / 2; sx < width; sx += dotGap) {
        const p = worldAt(sx, sy);
        if (!inWorld(p.x, p.z) || this.#map.isWater(p.x, p.z)) continue;
        const hx = Math.floor(p.x / 11);
        const hz = Math.floor(p.z / 11);
        const hash = Math.imul(hx, 73856093) ^ Math.imul(hz, 19349663);
        if ((hash & 3) !== 0) continue;
        const jx = ((hash >>> 3) & 7) * 0.13 * dpr;
        const jy = ((hash >>> 7) & 7) * 0.13 * dpr;
        const r = Math.max(0.6, 0.43 * dpr);
        ctx.fillRect(sx + jx, sy + jy, r, r);
      }
    }
    ctx.restore();
  }

  #overlayEnabled(id: MapOverlayId) {
    return this.#overlays.get(id) !== false;
  }

  #setOverlayEnabled(id: MapOverlayId, enabled: boolean) {
    this.#overlays.set(id, enabled);
    const button = this.#overlayButtons.get(id);
    if (button) {
      button.classList.toggle("on", enabled);
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
    }
    if (id === "landmarks" && !enabled) {
      const s = this.#selected;
      if (s?.kind === "fixed" && this.#landmarks.some((lm) => lm.name === s.name)) {
        this.#selected = null;
        this.#selectedPlaceId = null;
      }
    }
    this.update();
    if (this.expanded) this.#drawBig();
  }

  #drawVectorRoads(
    ctx: CanvasRenderingContext2D,
    center: { x: number; z: number },
    centerX: number,
    centerY: number,
    pxPerMX: number,
    pxPerMZ = pxPerMX
  ) {
    if (!this.#overlayEnabled("roads") || !this.#roadPaths.length) return;
    const { cellSize, minX, minZ, width, height } = this.#map.meta.grid;
    const worldMaxX = minX + width * cellSize;
    const worldMaxZ = minZ + height * cellSize;
    // Clip to the world rectangle so OSM stubs past the heightmap never paint
    // into the off-map blue backdrop when the view sits near an edge.
    const left = centerX + (minX - center.x) * pxPerMX;
    const top = centerY + (minZ - center.z) * pxPerMZ;
    const right = centerX + (worldMaxX - center.x) * pxPerMX;
    const bottom = centerY + (worldMaxZ - center.z) * pxPerMZ;
    const scaleX = cellSize * pxPerMX;
    const scaleY = cellSize * pxPerMZ;
    const scale = Math.max(0.0001, Math.min(scaleX, scaleY));
    const dpr = this.#dpr;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, right - left, bottom - top);
    ctx.clip();
    ctx.setTransform(
      scaleX,
      0,
      0,
      scaleY,
      centerX + (minX - center.x) * pxPerMX,
      centerY + (minZ - center.z) * pxPerMZ
    );
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "rgba(73, 57, 38, 0.82)";
    for (const { path, width: roadWidth } of this.#roadPaths) {
      const targetPx = Math.max(1.25 * dpr, roadWidth * Math.min(pxPerMX, pxPerMZ) + 1.15 * dpr);
      ctx.lineWidth = targetPx / scale;
      ctx.stroke(path);
    }
    for (const { path, width: roadWidth, roadClass } of this.#roadPaths) {
      const targetPx = Math.max(0.7 * dpr, roadWidth * Math.min(pxPerMX, pxPerMZ));
      ctx.strokeStyle = ROAD_COLORS[roadClass];
      ctx.lineWidth = targetPx / scale;
      ctx.stroke(path);
    }
    ctx.restore();
  }

  /** world metres → world-canvas px */
  #wx(x: number) {
    const g = this.#map.meta.grid;
    return (x - g.minX) / g.cellSize;
  }
  #wz(z: number) {
    const g = this.#map.meta.grid;
    return (z - g.minZ) / g.cellSize;
  }

  /* ------------------------------------------------------- minimap */

  #buildMini() {
    const hud = document.getElementById("hud")!;
    const wrap = document.createElement("div");
    wrap.className = "minimap";
    const card = document.createElement("div");
    card.className = "mm-card";
    card.title = "Drag to pan · scroll to zoom · click a player or landmark to select";
    const canvas = document.createElement("canvas");
    canvas.width = MINI_SIZE * this.#dpr;
    canvas.height = MINI_SIZE * this.#dpr;
    canvas.style.width = `${MINI_SIZE}px`;
    canvas.style.height = `${MINI_SIZE}px`;
    const count = document.createElement("div");
    count.className = "mm-count";
    const countDot = document.createElement("span");
    countDot.className = "mm-count-dot";
    const countLabel = document.createElement("span");
    countLabel.textContent = "solo";
    count.appendChild(countDot);
    count.appendChild(countLabel);
    // bottom-right expand affordance: the ONLY spot that opens the full map, so
    // the rest of the card is free for pan/zoom without accidental expands.
    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "mm-expand";
    expand.title = "Expand map (M)";
    expand.setAttribute("aria-label", "Expand map");
    expand.textContent = "⤢";
    expand.addEventListener("pointerdown", (e) => e.stopPropagation()); // never start a pan drag
    expand.addEventListener("click", (e) => {
      e.stopPropagation();
      this.setExpanded(true);
    });
    card.appendChild(canvas);
    card.appendChild(count);
    card.appendChild(expand);

    // teleport bar: shows the selected player/landmark and jumps to it. Sits
    // between the card and the layer toggles, hidden until something is picked.
    const tele = document.createElement("div");
    tele.className = "mm-teleport";
    tele.style.display = "none";
    const teleName = document.createElement("span");
    teleName.className = "mm-teleport-name";
    const teleBtn = document.createElement("button");
    teleBtn.type = "button";
    teleBtn.className = "mm-teleport-btn";
    teleBtn.textContent = "Teleport";
    teleBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = this.#resolveSelected();
      if (t) this.onTeleport(t.x, t.z, t.toName, t.playerId);
      this.#clearSelection();
    });
    tele.appendChild(teleName);
    tele.appendChild(teleBtn);
    this.#teleWrap = tele;
    this.#teleName = teleName;

    const layers = document.createElement("div");
    layers.className = "mm-layers";
    layers.setAttribute("role", "group");
    layers.setAttribute("aria-label", "Map layers");
    for (const layer of this.#layers) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "mm-layer on";
      button.setAttribute("aria-pressed", "true");
      button.style.setProperty("--layer-color", layer.color);
      const dot = document.createElement("span");
      dot.className = "mm-layer-dot";
      const label = document.createElement("span");
      label.className = "mm-layer-label";
      label.textContent = layer.label;
      button.appendChild(dot);
      button.appendChild(label);
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        layer.enabled = !layer.enabled;
        if (!layer.enabled && layer.points.some((p) => p.id === this.#selectedPlaceId)) this.#selectedPlaceId = null;
        this.#syncLayerButton(layer);
        this.update();
      });
      layers.appendChild(button);
      this.#layerButtons.set(layer.id, button);
    }

    wrap.appendChild(card);
    wrap.appendChild(tele);
    if (LAYERS_ENABLED) wrap.appendChild(layers);
    hud.appendChild(wrap);
    // Plain clicks on the map now select a teleport target (player, landmark or
    // layer dot) instead of expanding — expanding lives on the corner button.
    card.addEventListener("click", (e) => {
      if (this.#miniSuppressClick) {
        this.#miniSuppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (e.target === canvas) this.#tryMiniSelect(e as MouseEvent, canvas);
    });
    card.addEventListener(
      "wheel",
      (e) => {
        if (!this.#canInteractMini()) return;
        e.preventDefault();
        e.stopPropagation();

        const rect = canvas.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width - 0.5;
        const ny = (e.clientY - rect.top) / rect.height - 0.5;
        const center = this.#miniViewCenter(this.#getSelf());
        const worldX = center.x + nx * this.#miniSpan;
        const worldZ = center.z + ny * this.#miniSpan;
        const nextSpan = this.#clampMiniSpan(this.#miniSpan * Math.exp(e.deltaY * MINI_ZOOM_SPEED));
        if (nextSpan === this.#miniSpan) return;

        this.#miniSpan = nextSpan;
        this.#miniCenter = this.#clampMiniCenter({
          x: worldX - nx * this.#miniSpan,
          z: worldZ - ny * this.#miniSpan
        });
      },
      { passive: false }
    );
    card.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !this.#canInteractMini()) return;
      const center = this.#miniViewCenter(this.#getSelf());
      this.#miniDrag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        centerX: center.x,
        centerZ: center.z,
        moved: false
      };
      card.setPointerCapture(e.pointerId);
      card.classList.add("dragging");
      e.stopPropagation();
    });
    card.addEventListener("pointermove", (e) => {
      const drag = this.#miniDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const rect = canvas.getBoundingClientRect();
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) >= MINI_DRAG_PX) drag.moved = true;
      this.#miniCenter = this.#clampMiniCenter({
        x: drag.centerX - (dx / rect.width) * this.#miniSpan,
        z: drag.centerZ - (dy / rect.height) * this.#miniSpan
      });
      e.preventDefault();
      e.stopPropagation();
    });
    const endDrag = (e: PointerEvent) => {
      const drag = this.#miniDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      this.#miniDrag = null;
      card.classList.remove("dragging");
      if (card.hasPointerCapture(e.pointerId)) card.releasePointerCapture(e.pointerId);
      if (drag.moved && e.type === "pointerup") {
        this.#miniSuppressClick = true;
        window.setTimeout(() => (this.#miniSuppressClick = false), 0);
        e.preventDefault();
      }
      e.stopPropagation();
    };
    card.addEventListener("pointerup", endDrag);
    card.addEventListener("pointercancel", endDrag);
    this.#mini = canvas;
    this.#count = countLabel;
  }

  #canInteractMini() {
    return !this.expanded && document.pointerLockElement === null;
  }

  #miniViewCenter(self: MapSelf) {
    if (document.pointerLockElement) this.#miniCenter = null;
    return this.#miniCenter ?? { x: self.x, z: self.z };
  }

  #clampMiniSpan(span: number) {
    const g = this.#map.meta.grid;
    return Math.min(Math.max(MINI_MIN_SPAN, span), Math.max(g.width, g.height) * g.cellSize);
  }

  #clampMiniCenter(center: { x: number; z: number }) {
    const g = this.#map.meta.grid;
    const half = this.#miniSpan / 2;
    const minX = g.minX + Math.min(half, (g.width * g.cellSize) / 2);
    const maxX = g.minX + g.width * g.cellSize - Math.min(half, (g.width * g.cellSize) / 2);
    const minZ = g.minZ + Math.min(half, (g.height * g.cellSize) / 2);
    const maxZ = g.minZ + g.height * g.cellSize - Math.min(half, (g.height * g.cellSize) / 2);
    return {
      x: Math.min(maxX, Math.max(minX, center.x)),
      z: Math.min(maxZ, Math.max(minZ, center.z))
    };
  }

  #mapCenter() {
    const g = this.#map.meta.grid;
    return {
      x: g.minX + (g.width * g.cellSize) / 2,
      z: g.minZ + (g.height * g.cellSize) / 2
    };
  }

  #bigMaxSpan() {
    const g = this.#map.meta.grid;
    return g.width * g.cellSize;
  }

  /**
   * CSS size of the expanded map frame. Fills most of the viewport so wide
   * screens stay immersive; a thin ribbon of the dimmed world remains visible.
   * Layer pills sit above the frame, so their chrome is reserved from height.
   */
  #bigCssSize() {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const layerChrome = 52;
    const narrow = vw < 640;
    const sideFrac = narrow ? 0.028 : vw < 1100 ? 0.04 : 0.05;
    const padX = Math.max(narrow ? 10 : 28, Math.round(vw * sideFrac)) * 2;
    const padY = Math.max(vh < 700 ? 18 : 32, Math.round(vh * 0.035)) * 2;
    return {
      w: Math.max(240, Math.round(vw - padX)),
      h: Math.max(240, Math.round(vh - padY - layerChrome))
    };
  }

  /** Viewport aspect of the expanded map (not the world grid). */
  #bigAspect() {
    const { w, h } = this.#bigCssSize();
    return w / Math.max(1, h);
  }

  #clampBigSpan(span: number) {
    return Math.min(Math.max(BIG_MIN_SPAN, span), this.#bigMaxSpan());
  }

  /**
   * Largest view span that still lets world (x,z) sit at the true viewport
   * center — past this, `#clampBigCenter` pulls the pin off-middle near edges.
   */
  #maxSpanForTrueCenter(x: number, z: number) {
    const g = this.#map.meta.grid;
    const worldW = g.width * g.cellSize;
    const worldH = g.height * g.cellSize;
    const halfFactor = 0.5 - BIG_EDGE_BLEED;
    if (halfFactor <= 1e-6) return BIG_MIN_SPAN;
    const distX = Math.max(0, Math.min(x - g.minX, g.minX + worldW - x));
    const distZ = Math.max(0, Math.min(z - g.minZ, g.minZ + worldH - z));
    // inset = spanAxis * halfFactor must stay ≤ distance to that map edge.
    const maxFromX = distX / halfFactor;
    const maxFromZ = (distZ * this.#bigAspect()) / halfFactor;
    return this.#clampBigSpan(Math.min(maxFromX, maxFromZ, this.#bigMaxSpan()));
  }

  #cancelBigRecenterAnim() {
    this.#bigRecenterAnim = null;
  }

  #tickBigRecenterAnim() {
    const anim = this.#bigRecenterAnim;
    if (!anim) return;
    const u = Math.min(1, (performance.now() - anim.t0) / anim.duration);
    const e = 1 - (1 - u) ** 3; // ease-out cubic
    this.#bigSpan = this.#clampBigSpan(anim.fromSpan + (anim.toSpan - anim.fromSpan) * e);
    this.#bigCenter = this.#clampBigCenter({
      x: anim.fromX + (anim.toX - anim.fromX) * e,
      z: anim.fromZ + (anim.toZ - anim.fromZ) * e
    });
    if (u >= 1) {
      this.#bigRecenterAnim = null;
      this.#bigSpan = this.#clampBigSpan(anim.toSpan);
      this.#bigCenter = this.#clampBigCenter({ x: anim.toX, z: anim.toZ });
    }
  }

  #clampBigCenter(center: { x: number; z: number }) {
    const g = this.#map.meta.grid;
    const worldW = g.width * g.cellSize;
    const worldH = g.height * g.cellSize;
    const spanX = this.#clampBigSpan(this.#bigSpan || this.#bigMaxSpan());
    const spanZ = spanX / this.#bigAspect();
    // Keep almost all of the viewport on the map; only a thin ribbon of blue
    // backdrop is allowed when panned hard against an edge.
    const bleedX = spanX * BIG_EDGE_BLEED;
    const bleedZ = spanZ * BIG_EDGE_BLEED;
    const insetX = Math.min(spanX / 2 - bleedX, worldW / 2);
    const insetZ = Math.min(spanZ / 2 - bleedZ, worldH / 2);
    const minX = g.minX + insetX;
    const maxX = g.minX + worldW - insetX;
    const minZ = g.minZ + insetZ;
    const maxZ = g.minZ + worldH - insetZ;
    return {
      x: Math.min(maxX, Math.max(minX, center.x)),
      z: Math.min(maxZ, Math.max(minZ, center.z))
    };
  }

  #bigView() {
    const spanX = this.#clampBigSpan(this.#bigSpan || this.#bigMaxSpan());
    this.#bigSpan = spanX;
    const center = this.#clampBigCenter(this.#bigCenter ?? this.#mapCenter());
    this.#bigCenter = center;
    return { center, spanX, spanZ: spanX / this.#bigAspect() };
  }

  #bigScreenToWorld(canvas: HTMLCanvasElement, mx: number, my: number) {
    const { center, spanX, spanZ } = this.#bigView();
    return {
      x: center.x + (mx / canvas.width - 0.5) * spanX,
      z: center.z + (my / canvas.height - 0.5) * spanZ
    };
  }

  /** Per-frame redraw (2D canvas, sub-ms at this size). */
  update() {
    const remotes = this.#getRemotes();
    const n = remotes.length;
    this.#count.textContent = n === 0 ? "solo" : `${n + 1} online`;

    const ctx = this.#mini.getContext("2d")!;
    const dpr = this.#dpr;
    const size = MINI_SIZE * dpr;
    const self = this.#getSelf();
    const center = this.#miniViewCenter(self);
    const pxPerM = size / this.#miniSpan;
    ctx.clearRect(0, 0, size, size);

    // terrain crop centred on the current minimap viewport
    const cell = this.#map.meta.grid.cellSize;
    const srcSpan = this.#miniSpan / cell;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      this.#world,
      this.#wx(center.x) - srcSpan / 2,
      this.#wz(center.z) - srcSpan / 2,
      srcSpan,
      srcSpan,
      0,
      0,
      size,
      size
    );

    const mc = size / 2;
    const miniPx = (x: number) => mc + (x - center.x) * pxPerM;
    const miniPz = (z: number) => mc + (z - center.z) * pxPerM;
    this.#drawHistoricalOverview(ctx, miniPx, miniPz);
    this.#drawHistoricalRegions(ctx, miniPx, miniPz);
    this.#drawHistoricalDetail(ctx, miniPx, miniPz);
    this.#drawCloseEngraving(ctx, center, this.#miniSpan, this.#miniSpan);
    this.#drawVectorRoads(ctx, center, mc, mc, pxPerM);
    this.#drawBridges(
      ctx,
      miniPx,
      miniPz,
      pxPerM
    );
    if (LAYERS_ENABLED) this.#drawMiniPlaces(ctx, center, pxPerM, size);
    this.#drawMiniLandmarks(ctx, center, pxPerM, size);

    // remote dots, rim-clamped when out of view
    const c = size / 2;
    const rim = c - 9 * dpr;
    this.#miniPlayerHits = [];
    for (const r of remotes) {
      let dx = (r.x - center.x) * pxPerM;
      let dy = (r.z - center.z) * pxPerM;
      const dist = Math.hypot(dx, dy);
      const off = dist > rim;
      if (off && dist > 0) {
        dx *= rim / dist;
        dy *= rim / dist;
      }
      this.#dot(ctx, c + dx, c + dy, 4.5 * dpr, r.hue, off);
      this.#miniPlayerHits.push([c + dx, c + dy, r]);
    }

    // selection ring on the picked target (follows a player that keeps moving),
    // rim-clamped so it stays visible; drives the teleport bar below the map.
    const sel = this.#resolveSelected();
    this.#syncTeleport(sel);
    if (!sel && this.#selected) this.#selected = null; // target (a player) left
    if (sel) {
      let sdx = (sel.x - center.x) * pxPerM;
      let sdy = (sel.z - center.z) * pxPerM;
      const sdist = Math.hypot(sdx, sdy);
      if (sdist > rim && sdist > 0) {
        sdx *= rim / sdist;
        sdy *= rim / sdist;
      }
      ctx.beginPath();
      ctx.arc(c + sdx, c + sdy, 9 * dpr, 0, Math.PI * 2);
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.stroke();
    }

    // self: heading wedge, rim-clamped when the panned view leaves it offscreen
    let selfDx = (self.x - center.x) * pxPerM;
    let selfDy = (self.z - center.z) * pxPerM;
    const selfDist = Math.hypot(selfDx, selfDy);
    if (selfDist > rim && selfDist > 0) {
      selfDx *= rim / selfDist;
      selfDy *= rim / selfDist;
    }
    ctx.save();
    ctx.translate(c + selfDx, c + selfDy);
    ctx.rotate(Math.atan2(self.fx, -self.fz));
    ctx.beginPath();
    ctx.moveTo(0, -8 * dpr);
    ctx.lineTo(5.5 * dpr, 6 * dpr);
    ctx.lineTo(0, 3 * dpr);
    ctx.lineTo(-5.5 * dpr, 6 * dpr);
    ctx.closePath();
    ctx.fillStyle = `hsl(${self.hue} 80% 65%)`;
    ctx.strokeStyle = "rgba(6,14,20,0.9)";
    ctx.lineWidth = 2 * dpr;
    ctx.stroke();
    ctx.fill();
    ctx.restore();

    // north tick
    ctx.fillStyle = "rgba(234,244,248,0.75)";
    ctx.font = `600 ${10 * dpr}px ${MAP_FONT}`;
    ctx.textAlign = "center";
    ctx.fillText("N", c, 15 * dpr);
    ctx.beginPath();
    ctx.moveTo(c, 3 * dpr);
    ctx.lineTo(c + 4.5 * dpr, 10 * dpr);
    ctx.lineTo(c - 4.5 * dpr, 10 * dpr);
    ctx.closePath();
    ctx.fillStyle = "rgba(255,87,214,0.92)";
    ctx.fill();

    if (this.expanded) this.#drawBig();
  }

  #dot(ctx: CanvasRenderingContext2D, x: number, y: number, rad: number, hue: number, hollow = false) {
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = hollow ? "rgba(10,24,36,0.85)" : `hsl(${hue} 78% 62%)`;
    ctx.fill();
    ctx.lineWidth = rad * 0.55;
    ctx.strokeStyle = hollow ? `hsl(${hue} 78% 62%)` : "rgba(6,14,20,0.85)";
    ctx.stroke();
  }

  #syncLayerButton(layer: MapLayer) {
    const button = this.#layerButtons.get(layer.id);
    if (!button) return;
    button.classList.toggle("on", layer.enabled);
    button.setAttribute("aria-pressed", String(layer.enabled));
  }

  #fakeLayerPoints(layer: MapLayerDefinition): MapLayerPoint[] {
    const self = this.#getSelf();
    const nearby = Math.ceil(layer.count * 0.45);
    return Array.from({ length: layer.count }, (_, i) => {
      const nearPlayer = i < nearby;
      const pos = this.#randomLandPosition(nearPlayer ? self : null, nearPlayer ? MINI_SPAN * 0.44 : 0);
      return {
        id: `${layer.id}-${i}-${Math.random().toString(36).slice(2, 8)}`,
        layer: layer.id,
        title: layer.titles[i % layer.titles.length],
        x: pos.x,
        z: pos.z
      };
    });
  }

  #randomLandPosition(center: { x: number; z: number } | null, radius: number) {
    const g = this.#map.meta.grid;
    const minX = g.minX;
    const minZ = g.minZ;
    const maxX = minX + g.width * g.cellSize;
    const maxZ = minZ + g.height * g.cellSize;
    for (let i = 0; i < 90; i++) {
      let x: number;
      let z: number;
      if (center) {
        const a = Math.random() * Math.PI * 2;
        const r = radius * (0.18 + Math.random() * 0.82);
        x = center.x + Math.cos(a) * r;
        z = center.z + Math.sin(a) * r;
      } else {
        x = minX + Math.random() * (maxX - minX);
        z = minZ + Math.random() * (maxZ - minZ);
      }
      if (x < minX || x > maxX || z < minZ || z > maxZ) continue;
      const surface = this.#surfaceAt(x, z);
      if (surface !== undefined && surface !== 3) return { x, z };
    }
    return {
      x: Math.min(maxX, Math.max(minX, center?.x ?? minX + Math.random() * (maxX - minX))),
      z: Math.min(maxZ, Math.max(minZ, center?.z ?? minZ + Math.random() * (maxZ - minZ)))
    };
  }

  #surfaceAt(x: number, z: number) {
    const g = this.#map.meta.grid;
    const gx = Math.floor((x - g.minX) / g.cellSize);
    const gz = Math.floor((z - g.minZ) / g.cellSize);
    if (gx < 0 || gz < 0 || gx >= g.width || gz >= g.height) return undefined;
    if (this.#map.isWater(x, z)) return 3;
    return this.#map.surface[gz * g.width + gx];
  }

  #drawMiniPlaces(ctx: CanvasRenderingContext2D, center: { x: number; z: number }, pxPerM: number, size: number) {
    const dpr = this.#dpr;
    const c = size / 2;
    const margin = 10 * dpr;
    this.#miniPlaceHits = [];
    for (const layer of this.#layers) {
      if (!layer.enabled) continue;
      for (const place of layer.points) {
        const x = c + (place.x - center.x) * pxPerM;
        const y = c + (place.z - center.z) * pxPerM;
        if (x < margin || y < margin || x > size - margin || y > size - margin) continue;
        this.#placeDot(ctx, x, y, layer, place.id === this.#selectedPlaceId, 4.8 * dpr);
        this.#miniPlaceHits.push([x, y, place]);
      }
    }
  }

  #landmarkSelected(name: string) {
    const s = this.#selected;
    return s?.kind === "fixed" && s.name === name;
  }

  #placementBox(p: LandmarkLabelPlacement, tw: number, th: number, pad: number): LabelBox {
    if (p.pill) {
      return { l: p.pill.x - pad, t: p.pill.y - pad, r: p.pill.x + p.pill.w + pad, b: p.pill.y + p.pill.h + pad };
    }
    const l =
      p.align === "right" ? p.textX - tw : p.align === "center" ? p.textX - tw / 2 : p.textX;
    const t = p.textY - th / 2;
    return { l: l - pad, t: t - pad, r: l + tw + pad, b: t + th + pad };
  }

  #boxesOverlap(a: LabelBox, b: LabelBox, gap: number) {
    return !(a.r + gap < b.l || a.l - gap > b.r || a.b + gap < b.t || a.t - gap > b.b);
  }

  #dotBox(x: number, y: number, rad: number): LabelBox {
    const pad = rad + 2 * this.#dpr;
    return { l: x - pad, t: y - pad, r: x + pad, b: y + pad };
  }

  /** Pick a non-overlapping label side for each visible landmark. */
  #layoutLandmarkLabels(
    ctx: CanvasRenderingContext2D,
    font: string,
    items: { lm: MiniLandmark; x: number; y: number; selected: boolean }[],
    rad: number,
    labelH: number,
    pillPadX = 0,
    pillH = 0
  ): Map<MiniLandmark, LandmarkLabelPlacement> {
    ctx.font = font;
    const dpr = this.#dpr;
    const gap = 3 * dpr;
    const pad = 2 * dpr;
    const ph = pillH || labelH;
    const labelBoxes: LabelBox[] = [];
    const out = new Map<MiniLandmark, LandmarkLabelPlacement>();
    const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);

    const collides = (box: LabelBox, self: MiniLandmark) => {
      if (labelBoxes.some((o) => this.#boxesOverlap(o, box, gap))) return true;
      for (const other of items) {
        if (other.lm === self) continue;
        if (this.#boxesOverlap(this.#dotBox(other.x, other.y, rad), box, gap)) return true;
      }
      return false;
    };

    const mk = (
      lm: MiniLandmark,
      x: number,
      y: number,
      side: "right" | "left" | "below" | "above" | "aboveRight" | "aboveLeft"
    ): LandmarkLabelPlacement => {
      const tw = ctx.measureText(lm.name).width;
      const pw = tw + pillPadX * 2;
      switch (side) {
        case "right": {
          const px = x + rad + gap;
          return {
            textX: px + pillPadX,
            textY: y,
            align: "left",
            pill: pillPadX ? { x: px, y: y - ph / 2, w: pw, h: ph } : undefined
          };
        }
        case "left": {
          const px = x - rad - gap - pw;
          return {
            textX: px + pw - pillPadX,
            textY: y,
            align: "right",
            pill: pillPadX ? { x: px, y: y - ph / 2, w: pw, h: ph } : undefined
          };
        }
        case "below": {
          const py = y + rad + gap;
          return {
            textX: x,
            textY: py + ph / 2,
            align: "center",
            pill: pillPadX ? { x: x - pw / 2, y: py, w: pw, h: ph } : undefined
          };
        }
        case "above": {
          const py = y - rad - gap - ph;
          return {
            textX: x,
            textY: py + ph / 2,
            align: "center",
            pill: pillPadX ? { x: x - pw / 2, y: py, w: pw, h: ph } : undefined
          };
        }
        case "aboveRight": {
          const py = y - rad - gap - ph;
          const px = x + rad + gap;
          return {
            textX: px + pillPadX,
            textY: py + ph / 2,
            align: "left",
            pill: pillPadX ? { x: px, y: py, w: pw, h: ph } : undefined
          };
        }
        case "aboveLeft": {
          const py = y - rad - gap - ph;
          const px = x - rad - gap - pw;
          return {
            textX: px + pw - pillPadX,
            textY: py + ph / 2,
            align: "right",
            pill: pillPadX ? { x: px, y: py, w: pw, h: ph } : undefined
          };
        }
      }
    };

    for (const item of sorted) {
      const { lm, x, y } = item;
      const tw = ctx.measureText(lm.name).width;
      const candidates: LandmarkLabelPlacement[] = [
        mk(lm, x, y, "right"),
        mk(lm, x, y, "left"),
        mk(lm, x, y, "below"),
        mk(lm, x, y, "above"),
        mk(lm, x, y, "aboveRight"),
        mk(lm, x, y, "aboveLeft")
      ];

      const chosen =
        candidates.find((c) => !collides(this.#placementBox(c, tw, ph, pad), lm)) ?? candidates[0];
      labelBoxes.push(this.#placementBox(chosen, tw, ph, pad));
      out.set(lm, chosen);
    }
    return out;
  }

  #landmarkDot(ctx: CanvasRenderingContext2D, x: number, y: number, selected: boolean, rad: number) {
    ctx.save();
    ctx.shadowColor = LANDMARK_DOT_COLOR;
    ctx.shadowBlur = selected ? 18 * this.#dpr : 10 * this.#dpr;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = LANDMARK_DOT_COLOR;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = selected ? 2.3 * this.#dpr : 1.4 * this.#dpr;
    ctx.strokeStyle = selected ? "rgba(255,255,255,0.95)" : "rgba(5,12,18,0.78)";
    ctx.stroke();
    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, rad + 4.5 * this.#dpr, 0, Math.PI * 2);
      ctx.lineWidth = 1.2 * this.#dpr;
      ctx.strokeStyle = LANDMARK_DOT_COLOR;
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Paint every bridge deck as a coloured polyline (International Orange for
   * the Golden Gate, gray for the Bay Bridge) with tower dots. Shared by the
   * mini and expanded maps via the passed-in projection. */
  #drawBridges(
    ctx: CanvasRenderingContext2D,
    px: (x: number) => number,
    pz: (z: number) => number,
    pxPerM: number
  ) {
    const dpr = this.#dpr;
    for (const br of this.#map.meta.bridges) {
      const line = br.line;
      if (!line || line.length < 2) continue;
      const color = (br.color && BRIDGE_COLORS[br.color]) || BRIDGE_FALLBACK_COLOR;
      // deck thickness in screen px, tracking real width but clamped for reads
      // Preserve physical width when zoomed in; only cap the extreme close-up
      // so the deck cannot consume the whole canvas.
      const deckPx = Math.max(2.2 * dpr, Math.min(br.width * pxPerM, 24 * dpr));
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.beginPath();
      for (let i = 0; i < line.length; i++) {
        const x = px(line[i][0]);
        const y = pz(line[i][1]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      // dark casing under the deck for contrast against water
      ctx.strokeStyle = "rgba(6,14,20,0.55)";
      ctx.lineWidth = deckPx + 2 * dpr;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = deckPx;
      ctx.stroke();
      // towers as small filled nodes riding the deck
      for (const [tx, tz] of br.towers) {
        ctx.beginPath();
        ctx.arc(px(tx), pz(tz), Math.max(1.6 * dpr, deckPx * 0.62), 0, Math.PI * 2);
        ctx.fillStyle = "rgba(8,16,22,0.9)";
        ctx.fill();
        ctx.lineWidth = 1.2 * dpr;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  #drawMiniLandmarks(ctx: CanvasRenderingContext2D, center: { x: number; z: number }, pxPerM: number, size: number) {
    this.#miniLandmarkHits = [];
    if (!this.#overlayEnabled("landmarks")) return;
    const dpr = this.#dpr;
    const c = size / 2;
    const margin = 12 * dpr;
    const font = `600 ${9 * dpr}px ${MAP_FONT}`;
    const rad = 4.8 * dpr;
    const labelH = 11 * dpr;
    const visible: { lm: MiniLandmark; x: number; y: number; selected: boolean }[] = [];

    for (const lm of this.#landmarks) {
      const x = c + (lm.x - center.x) * pxPerM;
      const y = c + (lm.z - center.z) * pxPerM;
      if (x < margin || y < margin || x > size - margin || y > size - margin) continue;
      visible.push({ lm, x, y, selected: this.#landmarkSelected(lm.name) });
    }

    const labels = this.#layoutLandmarkLabels(ctx, font, visible, rad, labelH);
    ctx.font = font;
    ctx.textBaseline = "middle";
    for (const { lm, x, y, selected } of visible) {
      this.#landmarkDot(ctx, x, y, selected, rad);
      const label = labels.get(lm)!;
      ctx.textAlign = label.align;
      ctx.fillStyle = "rgba(20,32,42,0.7)";
      ctx.fillText(lm.name, label.textX + 0.5, label.textY + 0.5);
      ctx.fillStyle = "rgba(236,246,251,0.9)";
      ctx.fillText(lm.name, label.textX, label.textY);
      this.#miniLandmarkHits.push([x, y, lm]);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
  }

  #placeDot(ctx: CanvasRenderingContext2D, x: number, y: number, layer: MapLayer, selected: boolean, rad: number) {
    ctx.save();
    ctx.shadowColor = layer.color;
    ctx.shadowBlur = selected ? 18 * this.#dpr : 10 * this.#dpr;
    ctx.beginPath();
    ctx.arc(x, y, rad, 0, Math.PI * 2);
    ctx.fillStyle = layer.color;
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.lineWidth = selected ? 2.3 * this.#dpr : 1.4 * this.#dpr;
    ctx.strokeStyle = selected ? "rgba(255,255,255,0.95)" : "rgba(5,12,18,0.78)";
    ctx.stroke();
    if (selected) {
      ctx.beginPath();
      ctx.arc(x, y, rad + 4.5 * this.#dpr, 0, Math.PI * 2);
      ctx.lineWidth = 1.2 * this.#dpr;
      ctx.strokeStyle = layer.color;
      ctx.stroke();
    }
    ctx.restore();
  }

  #placeHit(mx: number, my: number, hits: [number, number, MapLayerPoint][]) {
    const hitRadius = PLACE_HIT_PX * this.#dpr;
    let best: MapLayerPoint | null = null;
    let bestDist = Infinity;
    for (const [hx, hy, place] of hits) {
      const d = Math.hypot(mx - hx, my - hy);
      if (d < hitRadius && d < bestDist) {
        best = place;
        bestDist = d;
      }
    }
    return best;
  }

  /* -------------------------------- collapsed-map select + teleport */

  /** Click on the collapsed map: pick a player / landmark / layer dot (in that
   * priority order) as the teleport target, or clear on an empty-space click. */
  #tryMiniSelect(e: MouseEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    const dotR = DOT_HIT_PX * this.#dpr;

    let best: MiniSelection | null = null;
    let bestDist = Infinity;
    for (const [hx, hy, r] of this.#miniPlayerHits) {
      const d = Math.hypot(mx - hx, my - hy);
      if (d < dotR && d < bestDist) {
        best = { kind: "player", id: r.id, name: r.name };
        bestDist = d;
      }
    }
    for (const [hx, hy, lm] of this.#miniLandmarkHits) {
      const d = Math.hypot(mx - hx, my - hy);
      if (d < dotR && d < bestDist) {
        best = { kind: "fixed", x: lm.x, z: lm.z, name: lm.name, toName: lm.name };
        bestDist = d;
      }
    }
    if (best) {
      this.#selectedPlaceId = null;
      this.#selected = best;
      this.update();
      return;
    }

    if (LAYERS_ENABLED) {
      const place = this.#placeHit(mx, my, this.#miniPlaceHits);
      if (place) {
        this.#selectedPlaceId = place.id;
        this.#selected = { kind: "fixed", x: place.x, z: place.z, name: place.title, toName: place.title };
        this.onPlaceClick(place);
        this.update();
        return;
      }
    }
    this.#clearSelection();
  }

  /** Resolve the current selection to a live world position (players + moving landmarks). */
  #resolveSelected(): { x: number; z: number; name: string; toName?: string; playerId?: number } | null {
    const s = this.#selected;
    if (!s) return null;
    if (s.kind === "fixed") {
      const live = this.#landmarks.find((l) => l.name === s.name || l.name === s.toName);
      if (live) return { x: live.x, z: live.z, name: live.name, toName: live.name };
      return { x: s.x, z: s.z, name: s.name, toName: s.toName };
    }
    const r = this.#getRemotes().find((r) => r.id === s.id);
    return r ? { x: r.x, z: r.z, name: s.name, toName: s.name, playerId: s.id } : null;
  }

  #clearSelection() {
    this.#selected = null;
    this.#selectedPlaceId = null;
    this.update();
  }

  /** Reflect the resolved selection into the minimap teleport bar (idempotent per frame). */
  #syncTeleport(target: { name: string } | null) {
    const name = target?.name ?? null;
    if (name) {
      this.#teleName.textContent = name;
      this.#teleWrap.style.display = "flex";
    } else {
      this.#teleWrap.style.display = "none";
      this.#hidePinTeleportHint();
    }
  }

  /** Swap pad vs keyboard chrome on the expanded map (teleport hint). */
  setDevice(device: "kb" | "pad") {
    if (device === this.#device) return;
    this.#device = device;
    // Force the pin callout to rebuild its key chip on the next draw.
    this.#pinHintKey = null;
  }

  /* --------------------------------------------------- expanded map */

  #centerBigOnSelf(resetZoom = false, animate = false) {
    const self = this.#getSelf();
    // Near the map rim a wide span can't place the player in the middle —
    // pull in just far enough that edge clamp no longer offsets them.
    const maxForCenter = this.#maxSpanForTrueCenter(self.x, self.z);
    let targetSpan: number;
    if (resetZoom) {
      targetSpan = Math.min((this.#bigMaxSpan() + BIG_MIN_SPAN) / 2, maxForCenter);
    } else {
      const current = this.#bigSpan || this.#bigMaxSpan();
      targetSpan = Math.min(current, maxForCenter);
    }
    targetSpan = this.#clampBigSpan(targetSpan);

    if (animate) {
      const from = this.#bigView();
      this.#bigRecenterAnim = {
        t0: performance.now(),
        duration: BIG_RECENTER_MS,
        fromX: from.center.x,
        fromZ: from.center.z,
        fromSpan: from.spanX,
        toX: self.x,
        toZ: self.z,
        toSpan: targetSpan
      };
      return;
    }

    this.#cancelBigRecenterAnim();
    this.#bigSpan = targetSpan;
    this.#bigCenter = this.#clampBigCenter({ x: self.x, z: self.z });
  }

  setExpanded(on: boolean) {
    if (on === this.expanded) return;
    this.expanded = on;
    if (on) {
      // The GPT-painted atlas is optional map art. Keep it out of the clean
      // boot waterfall and request only its overview on first map activation.
      this.#loadHistoricalOverview();
      this.#centerBigOnSelf(true);
      this.#padCursor = { nx: 0, ny: 0 };
      if (!this.#bigWrap) this.#buildBig();
      this.#bigWrap!.style.display = "flex";
      this.#drawBig();
    } else if (this.#bigWrap) {
      this.#cancelBigRecenterAnim();
      this.#bigWrap.style.display = "none";
      this.#padCursor = null;
    }
    this.onExpandChange(on);
  }

  /** Left stick: pan the expanded map. No-op when collapsed. */
  padPan(lx: number, ly: number, dt: number) {
    if (!this.expanded || (lx === 0 && ly === 0)) return;
    this.#cancelBigRecenterAnim();
    const { spanX, spanZ } = this.#bigView();
    const center = this.#bigCenter ?? this.#mapCenter();
    this.#bigCenter = this.#clampBigCenter({
      x: center.x + lx * spanX * PAD_PAN_SPEED * dt,
      z: center.z + ly * spanZ * PAD_PAN_SPEED * dt
    });
  }

  /** Zoom the expanded map toward view center.
   *  Positive zoomAxis zooms in — callers pass RT−LT−RY. */
  padZoom(zoomAxis: number, dt: number) {
    if (!this.expanded || Math.abs(zoomAxis) < 0.02) return;
    this.#cancelBigRecenterAnim();
    // Positive zoomAxis zooms in — matches wheel invert feel.
    const nextSpan = this.#clampBigSpan(this.#bigSpan * Math.exp(-zoomAxis * PAD_ZOOM_SPEED * dt));
    if (nextSpan === this.#bigSpan) return;
    this.#bigSpan = nextSpan;
    // Keep the current center under the fixed crosshair while zooming.
    this.#bigCenter = this.#clampBigCenter(this.#bigCenter ?? this.#mapCenter());
  }

  /** A: select the pin / ground under the centered gamepad crosshair. */
  padSelectAtCursor() {
    if (!this.expanded || !this.#big || !this.#padCursor) return;
    const canvas = this.#big;
    const mx = 0.5 * canvas.width;
    const my = 0.5 * canvas.height;
    this.#selectAtCanvasPx(mx, my);
  }

  /** X / Enter: teleport to the current selection. */
  padTeleport() {
    if (!this.expanded) return;
    const target = this.#resolveSelected();
    if (!target) return;
    this.onTeleport(target.x, target.z, target.toName, target.playerId);
    this.#clearSelection();
    this.setExpanded(false);
  }

  /** D-pad ◀/▶: cycle landmark + player pins. `dir` is −1 or +1. */
  padCyclePins(dir: number) {
    if (!this.expanded || !dir) return;
    const pins = this.#cyclePins();
    if (!pins.length) return;
    const cur = this.#selected;
    let idx = -1;
    if (cur?.kind === "player") idx = pins.findIndex((p) => p.kind === "player" && p.id === cur.id);
    else if (cur?.kind === "fixed") {
      idx = pins.findIndex(
        (p) => p.kind === "fixed" && p.name === cur.name && Math.hypot(p.x - cur.x, p.z - cur.z) < 1
      );
    }
    const next = pins[(idx + dir + pins.length * 8) % pins.length]!;
    if (next.kind === "player") {
      this.#selectedPlaceId = null;
      this.#selected = { kind: "player", id: next.id, name: next.name };
    } else {
      this.#selectedPlaceId = null;
      this.#selected = { kind: "fixed", x: next.x, z: next.z, name: next.name, toName: next.name };
    }
    this.#nudgeCursorToWorld(next.x, next.z);
    this.update();
  }

  #cyclePins(): Array<
    | { kind: "player"; id: number; name: string; x: number; z: number }
    | { kind: "fixed"; name: string; x: number; z: number }
  > {
    const out: Array<
      | { kind: "player"; id: number; name: string; x: number; z: number }
      | { kind: "fixed"; name: string; x: number; z: number }
    > = [];
    for (const lm of this.#landmarks) {
      if (!this.#overlayEnabled("landmarks")) break;
      out.push({ kind: "fixed", name: lm.name, x: lm.x, z: lm.z });
    }
    for (const r of this.#getRemotes()) out.push({ kind: "player", id: r.id, name: r.name, x: r.x, z: r.z });
    return out;
  }

  /** Pan so a pin sits under the centered crosshair (pin-cycle / focus). */
  #nudgeCursorToWorld(x: number, z: number) {
    this.#cancelBigRecenterAnim();
    this.#bigCenter = this.#clampBigCenter({ x, z });
    this.#padCursor = { nx: 0, ny: 0 };
  }

  /** Read-only diagnostics used by browser probes and the existing __sf hook. */
  debugState() {
    const self = this.#getSelf();
    const { center, spanX, spanZ } = this.#bigView();
    return {
      expanded: this.expanded,
      center: { ...center },
      self: { x: self.x, z: self.z, name: self.name },
      spanX,
      spanZ,
      centered: Math.hypot(center.x - self.x, center.z - self.z) < 0.5,
      roadsPainted: this.#roadsPainted
    };
  }

  /** Demo/capture hook: open the full map centered on a named landmark and
   *  pre-select it (selection ring + pin teleport hint), as if the user clicked
   *  its dot. Returns the landmark's world position. */
  focusLandmark(name: string): { x: number; z: number } | null {
    const lm = this.#landmarks.find((l) => l.name.toLowerCase() === name.toLowerCase());
    if (!lm) return null;
    this.setExpanded(true);
    this.#bigCenter = { x: lm.x, z: lm.z };
    this.#bigSpan = this.#clampBigSpan(1700);
    this.#selected = { kind: "fixed", x: lm.x, z: lm.z, name: lm.name, toName: lm.name };
    this.#drawBig();
    return { x: lm.x, z: lm.z };
  }

  /** Capture/QA hook for exercising atlas regions without changing player
   * position. Normal users reach the same state by dragging and scrolling. */
  focusWorldPoint(x: number, z: number, span = 1700) {
    this.setExpanded(true);
    this.#bigCenter = this.#clampBigCenter({ x, z });
    this.#bigSpan = this.#clampBigSpan(span);
    this.#selected = null;
    this.#drawBig();
  }

  #buildBig() {
    const wrap = document.createElement("div");
    wrap.className = "bigmap";
    const inner = document.createElement("div");
    inner.className = "bigmap-inner";
    const mapFrame = document.createElement("div");
    mapFrame.className = "bigmap-frame";
    const canvas = document.createElement("canvas");
    canvas.dataset.bigMap = "";
    canvas.title = "Drag to pan · scroll to zoom · click to select";
    const recenter = document.createElement("button");
    recenter.type = "button";
    recenter.className = "bigmap-recenter";
    recenter.dataset.mapRecenter = "";
    recenter.title = "Recenter on your position";
    recenter.setAttribute("aria-label", "Recenter map on your position");
    recenter.innerHTML =
      `<svg viewBox="0 0 24 24" aria-hidden="true">` +
      `<circle cx="12" cy="12" r="4"></circle>` +
      `<path d="M12 2v3M12 19v3M2 12h3M19 12h3"></path>` +
      `<circle cx="12" cy="12" r="8.25"></circle>` +
      `</svg>`;
    recenter.addEventListener("click", (e) => {
      e.stopPropagation();
      this.#centerBigOnSelf(false, true);
      this.#drawBig();
    });
    const layers = document.createElement("div");
    layers.className = "bigmap-layers";
    layers.setAttribute("role", "group");
    layers.setAttribute("aria-label", "Map layers");
    for (const def of MAP_OVERLAY_DEFS) {
      const enabled = this.#overlayEnabled(def.id);
      const button = document.createElement("button");
      button.type = "button";
      button.className = enabled ? "bigmap-layer on" : "bigmap-layer";
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      button.title = `${enabled ? "Hide" : "Show"} ${def.label.toLowerCase()}`;
      button.style.setProperty("--layer-color", def.color);
      const dot = document.createElement("span");
      dot.className = "bigmap-layer-dot";
      const label = document.createElement("span");
      label.className = "bigmap-layer-label";
      label.textContent = def.label;
      button.append(dot, label);
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        const next = !this.#overlayEnabled(def.id);
        this.#setOverlayEnabled(def.id, next);
        button.title = `${next ? "Hide" : "Show"} ${def.label.toLowerCase()}`;
      });
      layers.appendChild(button);
      this.#overlayButtons.set(def.id, button);
    }
    const sideControls = document.createElement("div");
    sideControls.className = "bigmap-side-controls";
    sideControls.append(recenter);
    const pinHint = document.createElement("div");
    pinHint.className = "bigmap-pin-hint";
    pinHint.hidden = true;
    pinHint.setAttribute("aria-hidden", "true");
    mapFrame.append(canvas, sideControls, pinHint);
    inner.append(layers, mapFrame);
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    // click outside the map closes; the canvas itself owns selection/pan/zoom
    wrap.addEventListener("click", (e) => {
      if (e.target === wrap) this.setExpanded(false);
    });
    canvas.addEventListener("click", (e) => {
      if (this.#bigSuppressClick) {
        this.#bigSuppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      this.#tryBigSelect(e, canvas);
    });
    canvas.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        e.stopPropagation();

        const rect = canvas.getBoundingClientRect();
        const nx = (e.clientX - rect.left) / rect.width - 0.5;
        const ny = (e.clientY - rect.top) / rect.height - 0.5;
        const { center, spanX, spanZ } = this.#bigView();
        const worldX = center.x + nx * spanX;
        const worldZ = center.z + ny * spanZ;
        const nextSpan = this.#clampBigSpan(this.#bigSpan * Math.exp(e.deltaY * BIG_ZOOM_SPEED));
        if (nextSpan === this.#bigSpan) return;

        this.#cancelBigRecenterAnim();
        this.#bigSpan = nextSpan;
        this.#bigCenter = this.#clampBigCenter({
          x: worldX - nx * this.#bigSpan,
          z: worldZ - ny * (this.#bigSpan / this.#bigAspect())
        });
        this.#drawBig();
      },
      { passive: false }
    );
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      this.#cancelBigRecenterAnim();
      const { center, spanZ } = this.#bigView();
      this.#bigDrag = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        centerX: center.x,
        centerZ: center.z,
        spanZ,
        moved: false
      };
      canvas.setPointerCapture(e.pointerId);
      canvas.classList.add("dragging");
      e.stopPropagation();
    });
    canvas.addEventListener("pointermove", (e) => {
      const drag = this.#bigDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      const rect = canvas.getBoundingClientRect();
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) >= MINI_DRAG_PX) drag.moved = true;
      this.#bigCenter = this.#clampBigCenter({
        x: drag.centerX - (dx / rect.width) * this.#bigSpan,
        z: drag.centerZ - (dy / rect.height) * drag.spanZ
      });
      this.#drawBig();
      e.preventDefault();
      e.stopPropagation();
    });
    const endDrag = (e: PointerEvent) => {
      const drag = this.#bigDrag;
      if (!drag || e.pointerId !== drag.pointerId) return;
      this.#bigDrag = null;
      canvas.classList.remove("dragging");
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      if (drag.moved && e.type === "pointerup") {
        this.#bigSuppressClick = true;
        window.setTimeout(() => (this.#bigSuppressClick = false), 0);
        e.preventDefault();
      }
      e.stopPropagation();
    };
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    this.#big = canvas;
    this.#bigWrap = wrap;
    this.#bigRecenter = recenter;
    this.#bigPinHint = pinHint;
  }

  #tryBigSelect(e: MouseEvent, canvas: HTMLCanvasElement) {
    e.preventDefault();
    e.stopPropagation();

    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
    this.#selectAtCanvasPx(mx, my);
  }

  /** Shared hit-test for mouse clicks and the gamepad selection cursor. */
  #selectAtCanvasPx(mx: number, my: number) {
    const canvas = this.#big;
    if (!canvas) return;
    const dotR = DOT_HIT_PX * this.#dpr;

    let bestPlayer: MapRemote | null = null;
    let bestDist = Infinity;
    for (const [hx, hy, r] of this.#hits) {
      const d = Math.hypot(mx - hx, my - hy);
      if (d < dotR && d < bestDist) {
        bestPlayer = r;
        bestDist = d;
      }
    }
    if (bestPlayer) {
      this.#selectedPlaceId = null;
      this.#selected = { kind: "player", id: bestPlayer.id, name: bestPlayer.name };
      this.update();
      return;
    }

    let bestLandmark: MiniLandmark | null = null;
    bestDist = Infinity;
    for (const [hx, hy, lm] of this.#bigLandmarkHits) {
      const d = Math.hypot(mx - hx, my - hy);
      if (d < dotR && d < bestDist) {
        bestLandmark = lm;
        bestDist = d;
      }
    }
    if (bestLandmark) {
      this.#selectedPlaceId = null;
      this.#selected = {
        kind: "fixed",
        x: bestLandmark.x,
        z: bestLandmark.z,
        name: bestLandmark.name,
        toName: bestLandmark.name
      };
      this.update();
      return;
    }

    if (LAYERS_ENABLED) {
      const place = this.#placeHit(mx, my, this.#bigPlaceHits);
      if (place) {
        this.#selectedPlaceId = place.id;
        this.#selected = { kind: "fixed", x: place.x, z: place.z, name: place.title, toName: place.title };
        this.onPlaceClick(place);
        this.update();
        return;
      }
    }

    const pos = this.#bigScreenToWorld(canvas, mx, my);
    const grid = this.#map.meta.grid;
    const maxX = grid.minX + grid.width * grid.cellSize;
    const maxZ = grid.minZ + grid.height * grid.cellSize;
    // Edge-centered views can show a little backdrop beyond the finite world.
    // Keep that margin inert so it can never become an out-of-bounds teleport.
    if (pos.x < grid.minX || pos.x > maxX || pos.z < grid.minZ || pos.z > maxZ) return;
    this.#selectedPlaceId = null;
    this.#selected = { kind: "fixed", x: pos.x, z: pos.z, name: GROUND_TARGET_NAME };
    this.update();
  }

  #drawBig() {
    const canvas = this.#big!;
    this.#tickBigRecenterAnim();
    const dpr = this.#dpr;
    // Fill the available viewport; geography stays undistorted via #bigAspect().
    const { w: cw, h: ch } = this.#bigCssSize();
    const pixelW = Math.round(cw * dpr);
    const pixelH = Math.round(ch * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#102a39";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const { center, spanX, spanZ } = this.#bigView();
    this.#maybeLoadHistoricalRegions(center, spanX, spanZ);
    this.#maybeLoadHistoricalDetail(center, spanX, spanZ);
    const self = this.#getSelf();
    this.#bigRecenter?.classList.toggle(
      "centered",
      Math.hypot(center.x - self.x, center.z - self.z) < 0.5
    );
    const cell = this.#map.meta.grid.cellSize;
    ctx.drawImage(
      this.#world,
      this.#wx(center.x) - spanX / cell / 2,
      this.#wz(center.z) - spanZ / cell / 2,
      spanX / cell,
      spanZ / cell,
      0,
      0,
      canvas.width,
      canvas.height
    );

    const sx = canvas.width / spanX;
    const sy = canvas.height / spanZ;
    const px = (x: number) => canvas.width / 2 + (x - center.x) * sx;
    const pz = (z: number) => canvas.height / 2 + (z - center.z) * sy;
    const visible = (x: number, y: number, margin = 16 * dpr) =>
      x >= -margin && y >= -margin && x <= canvas.width + margin && y <= canvas.height + margin;

    // GPT-painted detail is only an underlay. Authoritative vector streets and
    // bridges are redrawn above it at the current screen resolution.
    this.#drawHistoricalOverview(ctx, px, pz);
    this.#drawHistoricalRegions(ctx, px, pz);
    this.#drawHistoricalDetail(ctx, px, pz);
    this.#drawCloseEngraving(ctx, center, spanX, spanZ);
    this.#drawVectorRoads(ctx, center, canvas.width / 2, canvas.height / 2, sx, sy);

    // bridge decks under the pins
    this.#drawBridges(ctx, px, pz, sx);

    // landmarks — clickable teal dots
    this.#bigLandmarkHits = [];
    if (this.#overlayEnabled("landmarks")) {
      const lmFont = `600 ${10.5 * dpr}px ${MAP_FONT}`;
      const lmRad = 4.8 * dpr;
      const lmLabelH = 14 * dpr;
      const lmPillH = 16 * dpr;
      const lmPillPadX = 7 * dpr;
      const lmVisible: { lm: MiniLandmark; x: number; y: number; selected: boolean }[] = [];
      for (const lm of this.#landmarks) {
        const x = px(lm.x);
        const y = pz(lm.z);
        if (!visible(x, y, 30 * dpr)) continue;
        lmVisible.push({ lm, x, y, selected: this.#landmarkSelected(lm.name) });
      }
      const lmLabels = this.#layoutLandmarkLabels(ctx, lmFont, lmVisible, lmRad, lmLabelH, lmPillPadX, lmPillH);
      ctx.font = lmFont;
      ctx.textBaseline = "middle";
      for (const { lm, x, y, selected } of lmVisible) {
        this.#landmarkDot(ctx, x, y, selected, lmRad);
        const label = lmLabels.get(lm)!;
        ctx.textAlign = label.align;
        if (label.pill) {
          ctx.fillStyle = "#060e14";
          ctx.fillRect(label.pill.x, label.pill.y, label.pill.w, label.pill.h);
        }
        ctx.fillStyle = selected ? LANDMARK_DOT_COLOR : "rgba(234,244,248,0.88)";
        ctx.fillText(lm.name, label.textX, label.textY);
        this.#bigLandmarkHits.push([x, y, lm]);
      }
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
    }

    if (LAYERS_ENABLED) this.#drawBigPlaces(ctx, px, pz, canvas.width, canvas.height);

    // remote players with name labels (canvas text — no HTML injection path)
    this.#hits = [];
    ctx.font = `600 ${11.5 * dpr}px ${MAP_FONT}`;
    for (const r of this.#getRemotes()) {
      const x = px(r.x);
      const y = pz(r.z);
      if (!visible(x, y, 40 * dpr)) continue;
      this.#dot(ctx, x, y, 5 * dpr, r.hue);
      ctx.fillStyle = "#060e14";
      const label = r.name;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(x + 7 * dpr, y - 8 * dpr, tw + 8 * dpr, 16 * dpr);
      ctx.fillStyle = `hsl(${r.hue} 80% 72%)`;
      ctx.fillText(label, x + 11 * dpr, y + 4 * dpr);
      this.#hits.push([x, y, r]);
    }

    // self wedge
    const selfX = px(self.x);
    const selfY = pz(self.z);
    if (visible(selfX, selfY)) {
      ctx.save();
      ctx.translate(selfX, selfY);
      ctx.rotate(Math.atan2(self.fx, -self.fz));
      ctx.beginPath();
      ctx.moveTo(0, -9 * dpr);
      ctx.lineTo(6 * dpr, 7 * dpr);
      ctx.lineTo(0, 3.5 * dpr);
      ctx.lineTo(-6 * dpr, 7 * dpr);
      ctx.closePath();
      ctx.fillStyle = `hsl(${self.hue} 85% 68%)`;
      ctx.strokeStyle = "rgba(6,14,20,0.95)";
      ctx.lineWidth = 2.5 * dpr;
      ctx.stroke();
      ctx.fill();
      ctx.restore();
      this.#drawSelfLabel(ctx, selfX, selfY, self.name, self.hue, canvas.width, canvas.height);
    }

    this.#drawBigSelection(ctx, px, pz, canvas.width, canvas.height);
    this.#drawPadCursor(ctx, canvas.width, canvas.height);
    this.#syncTeleport(this.#resolveSelected());
  }

  #drawPadCursor(ctx: CanvasRenderingContext2D, width: number, height: number) {
    const cur = this.#padCursor;
    if (!cur) return;
    const dpr = this.#dpr;
    const x = (cur.nx + 0.5) * width;
    const y = (cur.ny + 0.5) * height;
    const arm = 11 * dpr;
    const gap = 3.5 * dpr;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x - gap, y);
    ctx.moveTo(x + gap, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y - gap);
    ctx.moveTo(x, y + gap);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2.2 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(111,215,196,0.95)";
    ctx.fill();
    ctx.restore();
  }

  #drawSelfLabel(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    name: string,
    hue: number,
    width: number,
    height: number
  ) {
    const dpr = this.#dpr;
    const safeName = name.trim() || "Player";
    ctx.save();
    ctx.font = `700 ${11.5 * dpr}px ${MAP_FONT}`;
    ctx.textBaseline = "middle";
    const maxTextWidth = Math.max(54 * dpr, Math.min(190 * dpr, width - 30 * dpr));
    const fullLabel = `You · ${safeName}`;
    const label = this.#fitCanvasText(ctx, fullLabel, maxTextWidth);
    const padX = 7 * dpr;
    const boxW = ctx.measureText(label).width + padX * 2;
    const boxH = 20 * dpr;
    let bx = x + 11 * dpr;
    if (bx + boxW > width - 5 * dpr) bx = x - boxW - 11 * dpr;
    bx = Math.min(width - boxW - 5 * dpr, Math.max(5 * dpr, bx));
    const by = Math.min(height - boxH - 5 * dpr, Math.max(5 * dpr, y - boxH / 2));
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 8 * dpr);
    ctx.fillStyle = "rgba(6,14,20,0.82)";
    ctx.fill();
    ctx.strokeStyle = `hsl(${hue} 78% 62% / 0.72)`;
    ctx.lineWidth = dpr;
    ctx.stroke();
    ctx.fillStyle = `hsl(${hue} 82% 76%)`;
    ctx.fillText(label, bx + padX, by + boxH / 2);
    ctx.restore();
  }

  #fitCanvasText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    const ellipsis = "…";
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (ctx.measureText(text.slice(0, mid) + ellipsis).width <= maxWidth) low = mid;
      else high = mid - 1;
    }
    return text.slice(0, low) + ellipsis;
  }

  #drawBigPlaces(
    ctx: CanvasRenderingContext2D,
    px: (x: number) => number,
    pz: (z: number) => number,
    width: number,
    height: number
  ) {
    const dpr = this.#dpr;
    this.#bigPlaceHits = [];
    for (const layer of this.#layers) {
      if (!layer.enabled) continue;
      for (const place of layer.points) {
        const x = px(place.x);
        const y = pz(place.z);
        const margin = 16 * dpr;
        if (x < -margin || y < -margin || x > width + margin || y > height + margin) continue;
        const selected = place.id === this.#selectedPlaceId;
        this.#placeDot(ctx, x, y, layer, selected, 4.8 * dpr);
        this.#bigPlaceHits.push([x, y, place]);
        if (selected) this.#placeLabel(ctx, x, y, `${layer.label}: ${place.title}`, layer.color, width, height);
      }
    }
  }

  #drawBigSelection(
    ctx: CanvasRenderingContext2D,
    px: (x: number) => number,
    pz: (z: number) => number,
    width: number,
    height: number
  ) {
    const target = this.#resolveSelected();
    if (!target) {
      this.#hidePinTeleportHint();
      return;
    }
    const dpr = this.#dpr;
    const x = px(target.x);
    const y = pz(target.z);
    const margin = 20 * dpr;
    if (x < -margin || y < -margin || x > width + margin || y > height + margin) {
      this.#hidePinTeleportHint();
      return;
    }

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 11 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 2.4 * dpr;
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 16 * dpr, 0, Math.PI * 2);
    ctx.lineWidth = 1.2 * dpr;
    ctx.strokeStyle = "rgba(111,215,196,0.92)";
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 6 * dpr, y);
    ctx.lineTo(x + 6 * dpr, y);
    ctx.moveTo(x, y - 6 * dpr);
    ctx.lineTo(x, y + 6 * dpr);
    ctx.lineWidth = 1.4 * dpr;
    ctx.strokeStyle = "rgba(6,14,20,0.78)";
    ctx.stroke();
    ctx.restore();

    this.#syncPinTeleportHint(x, y, width);
  }

  #hidePinTeleportHint() {
    if (!this.#bigPinHint) return;
    this.#bigPinHint.hidden = true;
    this.#bigPinHint.classList.remove("pop", "flip-x", "flip-y");
    this.#pinHintKey = null;
  }

  /** Anchor Enter/X “to teleport” beside the selection ring; pop when the target changes. */
  #syncPinTeleportHint(canvasX: number, canvasY: number, width: number) {
    const el = this.#bigPinHint;
    if (!el) return;
    const s = this.#selected;
    if (!s) {
      this.#hidePinTeleportHint();
      return;
    }
    const key =
      s.kind === "player"
        ? `p:${s.id}:${this.#device}`
        : `f:${s.x.toFixed(1)}:${s.z.toFixed(1)}:${this.#device}`;
    const changed = key !== this.#pinHintKey;
    if (changed) {
      this.#pinHintKey = key;
      const chip =
        this.#device === "pad"
          ? `<span class="k f fx">X</span>`
          : `<span class="k">Enter</span>`;
      el.innerHTML =
        `<div class="bigmap-pin-hint-inner">${chip}` +
        `<span class="bigmap-pin-hint-lbl">to teleport</span></div>`;
      el.classList.remove("pop");
      // Retrigger the entrance animation on a new selection.
      void el.offsetWidth;
      el.classList.add("pop");
    }

    const dpr = this.#dpr;
    const cssX = canvasX / dpr;
    const cssY = canvasY / dpr;
    const cw = width / dpr;
    // Prefer above-right of the pin; flip when near the canvas edge.
    const flipX = cssX > cw * 0.62;
    const flipY = cssY < 48;
    el.classList.toggle("flip-x", flipX);
    el.classList.toggle("flip-y", flipY);
    el.style.left = `${cssX}px`;
    el.style.top = `${cssY}px`;
    el.hidden = false;
  }

  #placeLabel(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    text: string,
    color: string,
    width: number,
    height: number
  ) {
    const dpr = this.#dpr;
    ctx.save();
    ctx.font = `700 ${11.5 * dpr}px ${MAP_FONT}`;
    const padX = 7 * dpr;
    const padY = 4 * dpr;
    const tw = ctx.measureText(text).width;
    const boxW = tw + padX * 2;
    const boxH = 21 * dpr;
    let bx = x + 9 * dpr;
    let by = y - boxH - 7 * dpr;
    if (bx + boxW > width - 5 * dpr) bx = x - boxW - 9 * dpr;
    if (by < 5 * dpr) by = y + 9 * dpr;
    if (by + boxH > height - 5 * dpr) by = height - boxH - 5 * dpr;
    ctx.fillStyle = "#081018";
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * dpr;
    ctx.beginPath();
    ctx.roundRect(bx, by, boxW, boxH, 8 * dpr);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(238,248,252,0.96)";
    ctx.fillText(text, bx + padX, by + padY + 11.5 * dpr);
    ctx.restore();
  }
}
