import { palaceLagoonMask, type WorldMap } from "../world/heightmap";
import type { PlayerMode } from "../player/types";
import { BOTANICAL_GARDEN_BOUNDS } from "../world/garden/layout";
import { WILD_REGIONS } from "../world/wildlands/layout";

/**
 * Minimap (top-left, always on) + full-city map (M or click to expand).
 *
 * The terrain backdrop is painted once from the heightmap + surface-class
 * grids the game already ships (8 m/px): water shaded by bay depth, land by
 * class (urban/park/sand) with a cheap NW hillshade. No tiles, no GPU work —
 * everything here is 2D canvas.
 *
 * Multiplayer: every remote player is a colored dot (their server-assigned
 * hue, same as their name tag). On the minimap, players outside the view are
 * clamped to the rim so you always know which way to head. The expanded map
 * can be panned/zoomed and uses the same select-then-teleport flow.
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

// Canvas 2D can't read CSS custom properties, so mirror the --font stack here
// for the labels painted straight onto the map.
const MAP_FONT = "'InterVariable', Inter, system-ui, -apple-system, sans-serif";
const MINI_SIZE = 236; // css px
const MINI_SPAN = 1400; // metres across the minimap view
const MINI_MIN_SPAN = 260;
const MINI_ZOOM_SPEED = 0.0012;
const MINI_DRAG_PX = 4;
const BIG_ZOOM_SPEED = 0.0012;
const BIG_MIN_SPAN = 260;
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

const LANDMARK_LABELS: Record<string, string> = {
  transamerica: "Transamerica",
  salesforce: "Salesforce",
  coit: "Coit Tower",
  ferry: "Ferry Building",
  alcatraz: "Alcatraz",
  sutro: "Sutro Tower",
  palaceFineArts: "Palace of Fine Arts",
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
  #mini!: HTMLCanvasElement;
  #count!: HTMLSpanElement;
  #teleWrap!: HTMLDivElement;
  #teleName!: HTMLSpanElement;
  #selected: MiniSelection | null = null;
  #big: HTMLCanvasElement | null = null;
  #bigWrap: HTMLDivElement | null = null;
  #bigRecenter: HTMLButtonElement | null = null;
  #bigTeleWrap: HTMLDivElement | null = null;
  #bigTeleName: HTMLSpanElement | null = null;
  #dpr = Math.min(window.devicePixelRatio || 1, 2);
  #layers: MapLayer[] = [];
  #layerButtons = new Map<MapLayerId, HTMLButtonElement>();
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
    this.#paintWorld();
    this.#landmarks = Object.entries(this.#map.meta.landmarks).map(([key, pos]) => ({
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
    // San Francisco Botanical Garden — a labelled dot + teleport at the garden's
    // own centre (real SFBG, east end of Golden Gate Park by the 9th Ave gate).
    // Location comes from the garden module itself, so the marker always sits
    // exactly where the vegetation renders.
    this.#landmarks.push({
      x: (BOTANICAL_GARDEN_BOUNDS.minX + BOTANICAL_GARDEN_BOUNDS.maxX) / 2,
      z: (BOTANICAL_GARDEN_BOUNDS.minZ + BOTANICAL_GARDEN_BOUNDS.maxZ) / 2,
      name: "Botanical Garden"
    });
    // Forest / open-space areas — the SeedThree wildlands regions each get a
    // labelled dot + teleport. The pin is a hand-picked point that lands you IN
    // the foliage (a grove or bloom drift on plantable ground), NOT the raw
    // region centre, which can fall on a road, rooftop or the bay.
    const NATURE_ANCHORS: { id: string; name: string; x: number; z: number }[] = [
      { id: "ggpark", name: "Golden Gate Park", x: -3050, z: 2000 }, // dense central forest
      { id: "presidio", name: "The Presidio", x: -1820, z: -1520 }, // cypress ridge grove
      { id: "marin", name: "Marin Headlands", x: -4450, z: -6250 }, // poppy hills + groves
      { id: "twinpeaks", name: "Mount Sutro", x: -782, z: 3846 } // Sutro cloud-forest under the tower
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

  /* ------------------------------------------------ terrain backdrop */

  #paintWorld() {
    const { width: W, height: H, cellSize, minX, minZ } = this.#map.meta.grid;
    const heights = this.#map.heights;
    const surface = this.#map.surface;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(W, H);
    const d = img.data;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const o = i * 4;
        const s = surface[i];
        const h = heights[i];
        const isWater = s === 3 || palaceLagoonMask(minX + x * cellSize, minZ + y * cellSize) > 0.08;
        let r: number, g: number, b: number;
        if (isWater) {
          // bay: deeper = darker
          const t = Math.min(1, Math.max(0, s === 3 ? -h / 16 : 0.18));
          r = 24 + (1 - t) * 20;
          g = 88 + (1 - t) * 46;
          b = 112 + (1 - t) * 42;
        } else {
          if (s === 1) {
            r = 52;
            g = 92;
            b = 60; // parks
          } else if (s === 2) {
            r = 158;
            g = 142;
            b = 104; // sand
          } else {
            r = 62;
            g = 74;
            b = 86; // urban
          }
          // NW hillshade from the height gradient
          const hx = heights[i + (x < W - 1 ? 1 : 0)] - h;
          const hy = heights[i + (y < H - 1 ? W : 0)] - h;
          const shade = Math.min(1.25, Math.max(0.62, 1 - (hx + hy) * 0.02));
          // subtle altitude lift so the hills read even face-on
          const lift = 1 + Math.min(0.35, Math.max(0, h) * 0.0016);
          r *= shade * lift;
          g *= shade * lift;
          b *= shade * lift;
        }
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.#world = c;
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

  #bigAspect() {
    const g = this.#map.meta.grid;
    return g.width / g.height;
  }

  #clampBigSpan(span: number) {
    return Math.min(Math.max(BIG_MIN_SPAN, span), this.#bigMaxSpan());
  }

  #clampBigCenter(center: { x: number; z: number }) {
    const g = this.#map.meta.grid;
    const worldW = g.width * g.cellSize;
    const worldH = g.height * g.cellSize;
    // The viewport center may reach the world edge. This intentionally allows
    // some off-map backdrop around edge locations, which keeps an exact player
    // center from snapping inward on the first drag or wheel interaction.
    const minX = g.minX;
    const maxX = g.minX + worldW;
    const minZ = g.minZ;
    const maxZ = g.minZ + worldH;
    return {
      x: Math.min(maxX, Math.max(minX, center.x)),
      z: Math.min(maxZ, Math.max(minZ, center.z))
    };
  }

  #bigView() {
    const spanX = this.#clampBigSpan(this.#bigSpan || this.#bigMaxSpan());
    this.#bigSpan = spanX;
    // Keep explicitly requested centers exact. User-driven pan/zoom assignments
    // are clamped at the interaction sites, but opening/recentering near a world
    // edge may intentionally reveal a little off-map backdrop so the player can
    // remain mathematically centered.
    const center = this.#bigCenter ?? this.#mapCenter();
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
    this.#drawBridges(
      ctx,
      (x) => mc + (x - center.x) * pxPerM,
      (z) => mc + (z - center.z) * pxPerM,
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
      const deckPx = Math.max(2.2 * dpr, Math.min(br.width * pxPerM, 9 * dpr));
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
    const dpr = this.#dpr;
    const c = size / 2;
    const margin = 12 * dpr;
    this.#miniLandmarkHits = [];
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

  /** Resolve the current selection to a live world position (players move). */
  #resolveSelected(): { x: number; z: number; name: string; toName?: string; playerId?: number } | null {
    const s = this.#selected;
    if (!s) return null;
    if (s.kind === "fixed") return { x: s.x, z: s.z, name: s.name, toName: s.toName };
    const r = this.#getRemotes().find((r) => r.id === s.id);
    return r ? { x: r.x, z: r.z, name: s.name, toName: s.name, playerId: s.id } : null;
  }

  #clearSelection() {
    this.#selected = null;
    this.#selectedPlaceId = null;
    this.update();
  }

  /** Reflect the resolved selection into the teleport bar (idempotent per frame). */
  #syncTeleport(target: { name: string } | null) {
    const name = target?.name ?? null;
    if (name) {
      this.#teleName.textContent = name;
      this.#teleWrap.style.display = "flex";
    } else {
      this.#teleWrap.style.display = "none";
    }
    if (this.#bigTeleWrap && this.#bigTeleName) {
      if (name) {
        this.#bigTeleName.textContent = name;
        this.#bigTeleWrap.style.display = "flex";
      } else {
        this.#bigTeleWrap.style.display = "none";
      }
    }
  }

  /* --------------------------------------------------- expanded map */

  #centerBigOnSelf(resetZoom = false) {
    const self = this.#getSelf();
    this.#bigCenter = { x: self.x, z: self.z };
    if (resetZoom) {
      const maxSpan = this.#bigMaxSpan();
      this.#bigSpan = (maxSpan + BIG_MIN_SPAN) / 2;
    }
  }

  setExpanded(on: boolean) {
    if (on === this.expanded) return;
    this.expanded = on;
    if (on) {
      this.#centerBigOnSelf(true);
      if (!this.#bigWrap) this.#buildBig();
      this.#bigWrap!.style.display = "flex";
      this.#drawBig();
    } else if (this.#bigWrap) {
      this.#bigWrap.style.display = "none";
    }
    this.onExpandChange(on);
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
      centered: Math.hypot(center.x - self.x, center.z - self.z) < 0.5
    };
  }

  /** Demo/capture hook: open the full map centered on a named landmark and
   *  pre-select it (selection ring + Teleport bar), as if the user clicked its
   *  dot. Returns the landmark's world position. */
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
      this.#centerBigOnSelf();
      this.#drawBig();
    });
    const hint = document.createElement("div");
    hint.className = "bigmap-hint";
    hint.textContent = "Select a destination";
    const action = document.createElement("div");
    action.className = "bigmap-action";
    action.style.display = "none";
    const targetName = document.createElement("span");
    targetName.className = "bigmap-target";
    const teleportBtn = document.createElement("button");
    teleportBtn.type = "button";
    teleportBtn.className = "bigmap-teleport-btn";
    teleportBtn.textContent = "Teleport";
    teleportBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = this.#resolveSelected();
      if (!target) return;
      this.onTeleport(target.x, target.z, target.toName, target.playerId);
      this.#clearSelection();
      this.setExpanded(false);
    });
    action.appendChild(targetName);
    action.appendChild(teleportBtn);
    mapFrame.append(canvas, recenter);
    inner.appendChild(mapFrame);
    inner.appendChild(action);
    inner.appendChild(hint);
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
    this.#bigTeleWrap = action;
    this.#bigTeleName = targetName;
  }

  #tryBigSelect(e: MouseEvent, canvas: HTMLCanvasElement) {
    e.preventDefault();
    e.stopPropagation();

    const rect = canvas.getBoundingClientRect();
    const mx = (e.clientX - rect.left) * (canvas.width / rect.width);
    const my = (e.clientY - rect.top) * (canvas.height / rect.height);
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
    const { width: W, height: H } = this.#map.meta.grid;
    const dpr = this.#dpr;
    // fit the viewport, keep the world aspect
    const fit = Math.min((window.innerWidth - 90) / W, (window.innerHeight - 130) / H);
    const cw = Math.round(W * fit);
    const ch = Math.round(H * fit);
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

    // bridge decks under the pins
    this.#drawBridges(ctx, px, pz, sx);

    // landmarks — clickable teal dots
    this.#bigLandmarkHits = [];
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
        ctx.fillStyle = "rgba(6,14,20,0.72)";
        ctx.fillRect(label.pill.x, label.pill.y, label.pill.w, label.pill.h);
      }
      ctx.fillStyle = selected ? LANDMARK_DOT_COLOR : "rgba(234,244,248,0.88)";
      ctx.fillText(lm.name, label.textX, label.textY);
      this.#bigLandmarkHits.push([x, y, lm]);
    }
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    if (LAYERS_ENABLED) this.#drawBigPlaces(ctx, px, pz, canvas.width, canvas.height);

    // remote players with name labels (canvas text — no HTML injection path)
    this.#hits = [];
    ctx.font = `600 ${11.5 * dpr}px ${MAP_FONT}`;
    for (const r of this.#getRemotes()) {
      const x = px(r.x);
      const y = pz(r.z);
      if (!visible(x, y, 40 * dpr)) continue;
      this.#dot(ctx, x, y, 5 * dpr, r.hue);
      ctx.fillStyle = "rgba(6,14,20,0.75)";
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
    this.#syncTeleport(this.#resolveSelected());
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
    if (!target) return;
    const dpr = this.#dpr;
    const x = px(target.x);
    const y = pz(target.z);
    const margin = 20 * dpr;
    if (x < -margin || y < -margin || x > width + margin || y > height + margin) return;

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
    ctx.fillStyle = "rgba(8,16,24,0.84)";
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
