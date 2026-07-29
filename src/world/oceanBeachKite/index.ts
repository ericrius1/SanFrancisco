import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import { KITE_DESIGNS, KITE_DESIGN_ORDER, type KiteDesignId } from "./kiteDesigns";
import { kiteBuildKey, kiteColorway, type KiteConfig } from "./kiteConfig";
import { KiteFlyer, type KiteAnchor, type KiteFlyerFrame } from "./flyer";
import type { SandPrintSink } from "../../fx/sandPrints";
import type { KiteFigureName } from "./choreography";
import { createSunsetAir, type SunsetAir } from "./sunsetAir";
import { createPrismLight, type PrismLight } from "./prismLight";
import { bindOceanKiteTuning, OCEAN_KITE_TUNING } from "./tuning";

export type OceanBeachKiteSite = { x: number; z: number };

/**
 * The local player, as far as their own kite is concerned: the hand the line
 * leaves from and how fast it is travelling. Absent on a frame means "nobody is
 * holding a line" — headless probes drive the encounter without one.
 */
export type OceanBeachKitePilot = {
  hand: THREE.Vector3;
  velocity: THREE.Vector3;
};

export type OceanBeachKiteOptions = {
  /**
   * Compile a freshly built object before it joins the scene. The gate owns the
   * renderer, so it passes this in; without it a design swap in the atelier
   * would land its pipeline compile on the frame the player pressed the button.
   */
  warmup?: (object: THREE.Object3D) => Promise<void>;
  /**
   * The world's footprint runtime. Runners on the sand report their footfalls
   * to it; the runtime decides whether any of them are worth drawing.
   */
  sandPrints?: SandPrintSink;
};

export type OceanBeachKiteFlyerState = {
  design: KiteDesignId;
  action: KiteFigureName;
  runner: [number, number, number];
  runnerSpeed: number;
  lineLength: number;
  kiteHeight: number;
  tailLength: number;
  kite: [number, number, number];
  swing: number;
  elevation: number;
};

export type OceanBeachKiteDebugState = {
  webgpuCloth: true;
  awake: boolean;
  action: KiteFigureName;
  runnerSpeed: number;
  lineLength: number;
  lineTarget: number;
  tension: number;
  kiteHeight: number;
  tailLength: number;
  runner: [number, number, number];
  kite: [number, number, number];
  tetherStart: [number, number, number];
  tetherEnd: [number, number, number];
  /** Wind-window angles, radians — swing across the wind and elevation. */
  swing: number;
  elevation: number;
  /** 0..1 sunset window and how squarely the kite is between camera and sun. */
  golden: number;
  backlight: number;
  /** Every flyer on the beach; index 0 is the one the scalars above describe. */
  flyers: OceanBeachKiteFlyerState[];
};

export type OceanBeachKiteEncounter = {
  group: THREE.Group;
  update(
    dt: number,
    elapsed: number,
    player: { x: number; z: number },
    gust: number,
    view?: THREE.Vector3,
    pilot?: OceanBeachKitePilot
  ): void;
  /**
   * Fly the player's own kite off their hand, or pack it away with `null` /
   * `flying: false`. A new sail rebuilds (warmed up first); a new dye, line
   * length or tail is absorbed by the kite that is already up.
   */
  setPlayerKite(config: KiteConfig | null): void;
  /** The player's kite, for probes and the atelier's own sanity checks. */
  playerKiteFlying(): boolean;
  setAwake(awake: boolean): void;
  syncTuning(): void;
  tuningDescriptor(): DebugFeatureTuningRegistration;
  debugState(): OceanBeachKiteDebugState;
  /**
   * Whether the raymarched god-ray pipeline should run for this encounter, and
   * where to centre it. Null whenever the feature has nothing to ask for.
   */
  godRayRequest(): { active: boolean; center: THREE.Vector3 } | null;
  dispose(): void;
};

const WAKE_DISTANCE = 430;
const SLEEP_DISTANCE = 520;
/** Well inside the wake radius: a full-screen raymarch is not an ambient cost. */
const GOD_RAY_DISTANCE = 190;
const GOD_RAY_EXIT_DISTANCE = 240;
const ROUTE_STEP = 5;
// Dry-sand offset east of the live waterline so the runner stays off the wet edge.
const BEACH_RUNNER_PAD = 12;

/**
 * Walk east (shoreward) from just offshore of the anchor until `isWater` flips
 * false, then step a few metres onto dry sand. Generic coastline scan — works on
 * any west-facing beach, unlike the Ocean-Beach-specific shoreline fit.
 */
function beachEdgeX(map: WorldMap, referenceX: number, z: number): number {
  for (let x = referenceX - 90; x < referenceX + 110; x += 2) {
    if (!map.isWater(x, z)) return x + BEACH_RUNNER_PAD;
  }
  return referenceX + BEACH_RUNNER_PAD;
}

/**
 * Who is on the beach, where they stand, and how they group.
 *
 * The social grammar is deliberately made of two cheap signals rather than any
 * kind of agent AI. Members of a troupe share the leader's figure clock, so they
 * are always running the SAME figure at the same instant; and one member of each
 * pair is mirrored, so their kites carve opposite arcs, sweep toward each other
 * and cross. Matching silhouette does the rest — a troupe flies one design, and
 * the two soloists fly alone in designs nobody else is using.
 *
 * Offsets are in lane-spacing units along the shore. Intra-troupe gaps are about
 * half an inter-troupe gap, which is the ratio proximity-grouping needs before a
 * viewer reads "those two are together" instead of "those two are near".
 *
 * Every lane must stay inside the god-ray shadow map's ±110 m of the flock's
 * mean kite, or the apertures the designs were sized for stop resolving.
 */
type KiteLane = {
  design: KiteDesignId;
  seed: string;
  /** Lane centre along the shore, in lane-spacing units from the site. */
  offset: number;
  /** Fraction of the tuned half-span; a troupe patrols a tighter stretch. */
  spanScale: number;
  startFigure: number;
  startPhase: number;
  /** Members of a troupe share the first-listed member's figure clock. */
  troupe?: string;
  /** Carve the opposite way to the rest of the troupe. */
  mirror?: boolean;
};

const LANES: readonly KiteLane[] = [
  // The arrival. Keeps its one-shot launch, its own clock, and the middle of
  // the beach; every acceptance contract is written against this flyer.
  { design: "diamond", seed: "ocean-beach-kite-flyer", offset: 0, spanScale: 1, startFigure: 0, startPhase: 0 },

  // North: a sunwheel pair running mirrored figures in lockstep.
  { design: "sunwheel", seed: "ocean-beach-sunwheel-flyer", offset: -1.2, spanScale: 0.55, startFigure: 3, startPhase: 2.4, troupe: "wheels" },
  { design: "sunwheel", seed: "ocean-beach-sunwheel-partner", offset: -1.85, spanScale: 0.55, startFigure: 3, startPhase: 2.4, troupe: "wheels", mirror: true },

  // Far north: one lantern on its own, on a slower clock than anyone else.
  { design: "lantern", seed: "ocean-beach-lantern-flyer", offset: -2.9, spanScale: 0.8, startFigure: 6, startPhase: 4.1 },

  // South: a sled pair, also mirrored, offset half a loop from the wheels.
  { design: "sled", seed: "ocean-beach-sled-flyer", offset: 1.2, spanScale: 0.55, startFigure: 8, startPhase: 1.2, troupe: "deltas" },
  { design: "sled", seed: "ocean-beach-sled-partner", offset: 1.85, spanScale: 0.55, startFigure: 8, startPhase: 1.2, troupe: "deltas", mirror: true },

  // Far south: the centipede, alone, on the longest line of anyone.
  { design: "centipede", seed: "ocean-beach-centipede-flyer", offset: 2.85, spanScale: 0.8, startFigure: 5, startPhase: 3.3 },

  // The far end of the line, and deliberately out on its own: the prism throws
  // a forty-metre spectrum that lands on the sand beside it, and standing it in
  // among the troupes would put that fan straight through somebody else's kite.
  // Appended rather than inserted — the cinematics address flyers by index.
  { design: "prism", seed: "ocean-beach-prism-flyer", offset: 3.85, spanScale: 0.72, startFigure: 4, startPhase: 1.8 }
];

type RouteSample = { x: number; z: number };

/** Compass bearing (0 = north, 90 = east) → a world downwind direction. */
function bearingToDirection(degrees: number, out: THREE.Vector3): THREE.Vector3 {
  const radians = THREE.MathUtils.degToRad(degrees);
  return out.set(Math.sin(radians), 0, -Math.cos(radians)).normalize();
}

class KiteEncounter implements OceanBeachKiteEncounter {
  readonly group = new THREE.Group();

  #map: WorldMap;
  #site: OceanBeachKiteSite;
  #warmup: ((object: THREE.Object3D) => Promise<void>) | null;
  #route: RouteSample[];
  #flyers: KiteFlyer[] = [];
  /** The player's own kite: one more flyer, with the player where the rig goes. */
  #playerKite: KiteFlyer | null = null;
  #playerConfig: KiteConfig | null = null;
  #playerBuildKey = "";
  #playerGeneration = 0;
  #pilotSeen = false;
  #pilotAnchor: KiteAnchor = {
    position: new THREE.Vector3(),
    velocity: new THREE.Vector3()
  };
  /** Followers that take a leader's figure clock every frame. */
  #troupe: { follower: KiteFlyer; leader: KiteFlyer }[] = [];
  #air: SunsetAir;
  /** One per spectral sail on the beach; empty unless a prism is flying. */
  #prisms: PrismLight[] = [];
  /** The player's own, if they picked the prism. Rebuilt with the sail. */
  #playerPrism: PrismLight | null = null;
  #debug = new THREE.Group();
  #runnerMarker: THREE.Mesh;
  #targetMarker: THREE.Mesh;
  #kiteMarker: THREE.Mesh;

  #ownedGeometries: THREE.BufferGeometry[] = [];
  #ownedMaterials: THREE.Material[] = [];

  #awake = false;
  #disposed = false;
  #lastElapsed = 0;
  #playerDistance = Infinity;
  #godRaysHeld = false;
  #nextMonitorRefresh = 0;

  #viewPoint = new THREE.Vector3();
  // Site wind, not the global vegetation wind — see OCEAN_KITE_TUNING.windBearing.
  #siteWind = new THREE.Vector3(0, 0, 1);
  #crosswind = new THREE.Vector3(1, 0, 0);
  #windBearing = Number.NaN;
  #frame: KiteFlyerFrame;
  #rayAnchors: { position: THREE.Vector3; spread: number; spectral?: boolean }[] = [];
  #godRayCenter = new THREE.Vector3();

  #monitor = {
    awake: "no",
    action: "launch",
    speed: "0.00 m/s",
    line: "0.0 m",
    tension: "0%",
    altitude: "0.0 m",
    window: "0° / 0°",
    air: "daylight",
    kites: "diamond · sunwheel · lantern",
    cloth: "WebGPU vertex cloth"
  };

  constructor(map: WorldMap, site: OceanBeachKiteSite, options?: OceanBeachKiteOptions) {
    this.#map = map;
    this.#site = { ...site };
    this.#warmup = options?.warmup ?? null;
    this.#applyWindBearing();
    this.group.name = "ocean_beach_kite_encounter";

    const tuning = OCEAN_KITE_TUNING.values;
    const spacing = Math.max(18, tuning.runSpan * 0.78);
    const halfSpan = Math.max(8, tuning.runSpan * 0.34);
    this.#route = this.#buildRoute(this.#routeHalfLength(spacing, halfSpan));

    const leaders = new Map<string, KiteFlyer>();
    for (const lane of LANES) {
      const laneZ = this.#site.z + lane.offset * spacing;
      const leader = lane.troupe ? leaders.get(lane.troupe) : undefined;
      const flyer = new KiteFlyer({
        map,
        design: KITE_DESIGNS[lane.design],
        seed: lane.seed,
        lane: { x: this.#routeX(laneZ), z: laneZ },
        beachX: (z) => this.#routeX(z),
        startFigure: lane.startFigure,
        startPhase: lane.startPhase,
        startAirborne: lane.startFigure !== 0,
        spanScale: lane.spanScale,
        mirror: lane.mirror,
        ledByTroupe: Boolean(leader),
        prints: options?.sandPrints
      });
      if (lane.troupe && !leader) leaders.set(lane.troupe, flyer);
      else if (leader) this.#troupe.push({ follower: flyer, leader });
      this.#flyers.push(flyer);
      this.group.add(flyer.group);
      this.#rayAnchors.push({
        position: flyer.kitePosition,
        spread: flyer.design.raySpread,
        spectral: flyer.design.spectral
      });
      // A spectral sail casts nothing, so the warm fan has no work to do on it.
      // It gets a dispersed spectrum of its own instead — one rig per prism,
      // reading the same live position and orientation the kite already owns.
      if (flyer.design.spectral) {
        const prism = createPrismLight({
          anchor: {
            position: flyer.kitePosition,
            quaternion: flyer.kiteOrientation,
            spread: flyer.design.raySpread
          },
          ground: (x, z) => map.groundTop(x, z),
          water: (x, z) => map.isWater(x, z)
        });
        this.#prisms.push(prism);
        this.group.add(prism.group);
      }
    }

    this.#air = createSunsetAir({
      center: this.#site,
      groundY: map.groundTop(this.#site.x, this.#site.z),
      wind: this.#siteWind,
      anchors: this.#rayAnchors
    });
    this.group.add(this.#air.group);

    const markerGeometry = this.#ownGeometry(new THREE.SphereGeometry(0.18, 8, 6));
    this.#runnerMarker = new THREE.Mesh(
      markerGeometry,
      this.#ownMaterial(new THREE.MeshBasicMaterial({ color: 0x38d6d1, depthTest: false }))
    );
    this.#targetMarker = new THREE.Mesh(
      markerGeometry,
      this.#ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffc861, depthTest: false }))
    );
    this.#kiteMarker = new THREE.Mesh(
      markerGeometry,
      this.#ownMaterial(new THREE.MeshBasicMaterial({ color: 0xd65cff, depthTest: false }))
    );
    this.#debug.name = "ocean_beach_kite_attachment_landmarks";
    this.#debug.renderOrder = 50;
    this.#debug.add(this.#runnerMarker, this.#targetMarker, this.#kiteMarker);
    this.#buildRouteDebug();
    this.group.add(this.#debug);

    const primary = this.#flyers[0];
    this.#viewPoint.set(
      primary.tetherStart.x,
      primary.tetherStart.y + 12,
      primary.tetherStart.z - 40
    );
    for (const flyer of this.#flyers) flyer.place(this.#siteWind, this.#viewPoint);

    this.#frame = {
      dt: 0,
      elapsed: 0,
      gust: 0,
      view: this.#viewPoint,
      wind: this.#siteWind,
      crosswind: this.#crosswind,
      backlight: 0,
      halfSpan: 12,
      beachDepth: 26
    };
    this.syncTuning();
    this.group.updateMatrixWorld(true);
  }

  #ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.#ownedGeometries.push(geometry);
    return geometry;
  }

  #ownMaterial<T extends THREE.Material>(material: T): T {
    this.#ownedMaterials.push(material);
    return material;
  }

  /**
   * The sampled waterline has to reach past the outermost lane plus the stretch
   * that flyer patrols, or #routeX clamps and the outer flyers steer against a
   * stale waterline that is metres from where the sea actually is.
   */
  #routeHalfLength(spacing: number, halfSpan: number): number {
    let reach = 0;
    for (const lane of LANES) {
      reach = Math.max(reach, Math.abs(lane.offset) * spacing + halfSpan * lane.spanScale);
    }
    return Math.ceil((reach + 14) / ROUTE_STEP) * ROUTE_STEP;
  }

  #buildRoute(halfLength: number): RouteSample[] {
    const samples: RouteSample[] = [];
    for (let dz = -halfLength; dz <= halfLength; dz += ROUTE_STEP) {
      const z = this.#site.z + dz;
      const x = beachEdgeX(this.#map, this.#site.x, z);
      samples.push({ x, z });
    }
    return samples;
  }

  #applyWindBearing(): void {
    const bearing = OCEAN_KITE_TUNING.values.windBearing;
    if (bearing === this.#windBearing) return;
    this.#windBearing = bearing;
    bearingToDirection(bearing, this.#siteWind);
    this.#crosswind.set(-this.#siteWind.z, 0, this.#siteWind.x).normalize();
  }

  /** Waterline-relative eastern edge of dry sand at a given z. */
  #routeX(z: number): number {
    const clamped = THREE.MathUtils.clamp(
      z,
      this.#route[0].z,
      this.#route[this.#route.length - 1].z
    );
    const raw = (clamped - this.#route[0].z) / ROUTE_STEP;
    const i = Math.min(this.#route.length - 2, Math.max(0, Math.floor(raw)));
    const t = raw - i;
    return THREE.MathUtils.lerp(this.#route[i].x, this.#route[i + 1].x, t);
  }

  #buildRouteDebug(): void {
    const points = this.#route.map(
      (sample) => new THREE.Vector3(sample.x, this.#map.groundTop(sample.x, sample.z) + 0.08, sample.z)
    );
    const geometry = this.#ownGeometry(new THREE.BufferGeometry().setFromPoints(points));
    const route = new THREE.Line(
      geometry,
      this.#ownMaterial(new THREE.LineBasicMaterial({ color: 0x37ddd4, depthTest: false }))
    );
    route.name = "kite_flyer_route_landmark";
    route.renderOrder = 50;
    this.#debug.add(route);

    const arrow = new THREE.ArrowHelper(
      this.#siteWind,
      new THREE.Vector3(this.#site.x, 3, this.#site.z),
      8,
      0xffc861,
      1.1,
      0.5
    );
    arrow.name = "kite_wind_landmark";
    arrow.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        this.#ownedGeometries.push(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        this.#ownedMaterials.push(...materials);
      }
    });
    this.#debug.add(arrow);
  }

  #updateDebug(): void {
    const visible = OCEAN_KITE_TUNING.values.showLandmarks;
    this.#debug.visible = visible;
    if (!visible) return;
    const primary = this.#flyers[0];
    this.#runnerMarker.position.copy(primary.tetherStart);
    this.#targetMarker.position.copy(primary.kiteTarget);
    this.#kiteMarker.position.copy(primary.tetherEnd);
  }

  /** Line length and tail are dials on a live kite; the sail is not. */
  #dressPlayerKite(config: KiteConfig): void {
    const kite = this.#playerKite;
    if (!kite) return;
    const colorway = kiteColorway(config.colorway);
    kite.setPalette(colorway.palette ?? KITE_DESIGNS[config.design].palette);
    kite.setLineDial(config.line / 100);
    // 0 leaves a stub rather than nothing: a kite with no tail at all wanders,
    // and the ribbon is half of what makes the flight legible from the sand.
    kite.setTailScale(0.22 + (config.tail / 100) * 1.32);
  }

  #retirePlayerKite(): void {
    this.#playerGeneration++;
    this.#playerKite?.dispose();
    this.#playerKite = null;
    this.#playerPrism?.dispose();
    this.#playerPrism = null;
    this.#playerBuildKey = "";
  }

  async #buildPlayerKite(config: KiteConfig): Promise<void> {
    const generation = ++this.#playerGeneration;
    const buildKey = kiteBuildKey(config);
    const design = KITE_DESIGNS[config.design];
    const colorway = kiteColorway(config.colorway);
    const kite = new KiteFlyer({
      map: this.#map,
      design,
      // Unused by an anchored flyer (no rig is built), but the option is not
      // optional and a stable string keeps the group names deterministic.
      seed: "ocean-beach-player-kite",
      lane: { x: this.#site.x, z: this.#site.z },
      beachX: (z) => this.#routeX(z),
      startFigure: 0,
      startPhase: 0,
      startAirborne: true,
      palette: colorway.palette ?? design.palette,
      anchor: this.#pilotAnchor,
      lineDial: config.line / 100,
      tailScale: 0.22 + (config.tail / 100) * 1.32
    });
    kite.place(this.#siteWind, this.#viewPoint);
    try {
      // Detached warmup: the sail must not compile on the frame the player
      // pressed a swatch. Same contract the gate uses for the whole encounter.
      if (this.#warmup) await this.#warmup(kite.group);
    } catch (error) {
      console.warn("[ocean kite] player kite warmup failed", error);
    }
    // The player can re-pick, pack away or walk off the beach mid-compile.
    if (generation !== this.#playerGeneration || this.#disposed) {
      kite.dispose();
      return;
    }
    this.#playerKite?.dispose();
    this.#playerKite = kite;
    this.#playerBuildKey = buildKey;
    this.group.add(kite.group);
    // Your prism disperses too. It is the one sail whose whole point is light it
    // makes rather than light it blocks, so handing the player a black triangle
    // and no spectrum would be handing them the half of it that does nothing.
    this.#playerPrism?.dispose();
    this.#playerPrism = null;
    if (design.spectral) {
      this.#playerPrism = createPrismLight({
        anchor: {
          position: kite.kitePosition,
          quaternion: kite.kiteOrientation,
          spread: design.raySpread
        },
        ground: (x, z) => this.#map.groundTop(x, z),
        water: (x, z) => this.#map.isWater(x, z)
      });
      this.group.add(this.#playerPrism.group);
    }
    // Deliberately NOT added to #rayAnchors: the sunset shaft fan and the god-ray
    // shadow map are both sized around the FLOCK's mean kite, and the player can
    // stand a hundred metres up the beach from it. Their sail is still a shadow
    // caster, so it carves the rays whenever it is inside that map — it just
    // never drags the map away from the seven kites the pass was built for.
  }

  setPlayerKite(config: KiteConfig | null): void {
    if (this.#disposed) return;
    this.#playerConfig = config;
    if (!config || !config.flying) {
      this.#retirePlayerKite();
      return;
    }
    // Nothing to anchor to until the gate has told us where the player is; the
    // next update() with a pilot picks this up.
    if (!this.#pilotSeen) return;
    if (this.#playerKite && this.#playerBuildKey === kiteBuildKey(config)) {
      this.#dressPlayerKite(config);
      return;
    }
    void this.#buildPlayerKite(config);
  }

  playerKiteFlying(): boolean {
    return Boolean(this.#playerKite);
  }

  setAwake(awake: boolean): void {
    if (this.#disposed || this.#awake === awake) return;
    this.#awake = awake;
    this.group.visible = awake && OCEAN_KITE_TUNING.values.enabled;
    this.#monitor.awake = awake ? "yes" : "no";
  }

  update(
    dt: number,
    elapsed: number,
    player: { x: number; z: number },
    gust: number,
    view?: THREE.Vector3,
    pilot?: OceanBeachKitePilot
  ): void {
    if (this.#disposed) return;
    if (pilot) {
      this.#pilotAnchor.position.copy(pilot.hand);
      this.#pilotAnchor.velocity.copy(pilot.velocity);
      // First hand of the session: a config that arrived before we knew where
      // the player was has been waiting for exactly this.
      if (!this.#pilotSeen) {
        this.#pilotSeen = true;
        if (this.#playerConfig?.flying) this.setPlayerKite(this.#playerConfig);
      }
    }
    const distance = Math.hypot(player.x - this.#site.x, player.z - this.#site.z);
    this.#playerDistance = distance;
    if (this.#awake ? distance > SLEEP_DISTANCE : distance < WAKE_DISTANCE) {
      this.setAwake(!this.#awake);
    }
    const tuning = OCEAN_KITE_TUNING.values;
    this.group.visible = this.#awake && tuning.enabled;
    if (!this.#awake || !tuning.enabled) {
      this.#monitor.awake = this.#awake ? "disabled" : "no";
      return;
    }

    dt = Math.min(Math.max(dt, 0), 0.1);
    this.#lastElapsed = elapsed;
    // Headless probes drive this with a bare {x, z}; fall back to the flyer's
    // own eyeline so every view-dependent term stays finite.
    if (view) this.#viewPoint.copy(view);
    else this.#viewPoint.set(player.x, this.#map.groundTop(player.x, player.z) + 1.7, player.z);

    // The air reads last frame's kite positions, which is what lets the flyers
    // consume this frame's backlight without a second pass over them.
    const frame = this.#frame;
    frame.dt = dt;
    frame.elapsed = elapsed;
    frame.gust = THREE.MathUtils.clamp(gust, 0, 1);
    frame.backlight = this.#air.state.backlight * tuning.clothBacklight;
    frame.halfSpan = Math.max(8, tuning.runSpan * 0.34);
    frame.beachDepth = Math.max(8, tuning.beachDepth);
    // Troupes adopt their leader's figure before anyone moves, so a pair is
    // always mid-way through the same shape on the same frame.
    for (const { follower, leader } of this.#troupe) follower.adoptFigure(leader);
    for (const flyer of this.#flyers) flyer.update(frame);
    // The player's kite runs the same frame as everyone else's: same wind, same
    // gust, same sunset. It only differs in who is holding the line.
    this.#playerKite?.update(frame);

    this.#air.update({
      dt,
      camera: this.#viewPoint,
      mist: tuning.mistDensity,
      shafts: tuning.shaftStrength,
      enabled: tuning.sunsetAir
    });
    // After the flyers have moved and after the air, on the same frame's
    // positions: the prism's landing solve marches from a kite that has already
    // been placed, so its smear can never trail the sail by a frame.
    const prismFrame = {
      dt,
      camera: this.#viewPoint,
      strength: tuning.shaftStrength * tuning.prismStrength,
      enabled: tuning.sunsetAir && tuning.prismLight
    };
    for (const prism of this.#prisms) prism.update(prismFrame);
    this.#playerPrism?.update(prismFrame);
    this.syncTuning();

    // Tweakpane refreshes monitors at 4 Hz; match that cadence so the hot path
    // does not allocate formatted strings on every rendered frame.
    if (elapsed >= this.#nextMonitorRefresh || elapsed < this.#nextMonitorRefresh - 1) {
      const primary = this.#flyers[0];
      this.#monitor.awake = "yes";
      this.#monitor.action = primary.figure;
      this.#monitor.speed = `${primary.runnerSpeed.toFixed(2)} m/s`;
      this.#monitor.line = `${primary.lineLength.toFixed(1)} m`;
      this.#monitor.tension = `${Math.round(primary.tension * 100)}%`;
      this.#monitor.altitude = `${Math.max(0, primary.kitePosition.y - primary.surfaceBelowKite()).toFixed(1)} m`;
      this.#monitor.window = `${Math.round(THREE.MathUtils.radToDeg(primary.swing))}° swing / ${Math.round(THREE.MathUtils.radToDeg(primary.elevation))}° up`;
      this.#monitor.air = this.#air.state.golden > 0.01
        ? `golden ${Math.round(this.#air.state.golden * 100)}% · backlight ${Math.round(this.#air.state.backlight * 100)}%`
        : "daylight";
      this.#monitor.kites = this.#flyers.map((flyer) => `${flyer.design.id} ${flyer.figure}`).join(" · ");
      this.#nextMonitorRefresh = elapsed + 0.25;
    }
  }

  syncTuning(): void {
    const tuning = OCEAN_KITE_TUNING.values;
    this.#applyWindBearing();
    const golden = this.#air.state.golden;
    const backlight = this.#air.state.backlight;
    for (const flyer of this.#flyers) flyer.syncAppearance(this.#lastElapsed, golden, backlight);
    this.#playerKite?.syncAppearance(this.#lastElapsed, golden, backlight);
    this.#updateDebug();
    this.group.visible = this.#awake && tuning.enabled;
  }

  tuningDescriptor(): DebugFeatureTuningRegistration {
    return {
      id: "ocean-beach-kite",
      title: "Ocean Beach · purple kite",
      build: (folder) => {
        bindOceanKiteTuning(folder);
        const metrics = folder.addFolder({ title: "metrics", expanded: false });
        const bindings = [
          metrics.addBinding(this.#monitor, "awake", { readonly: true, label: "awake" }),
          metrics.addBinding(this.#monitor, "action", { readonly: true, label: "figure" }),
          metrics.addBinding(this.#monitor, "speed", { readonly: true, label: "runner speed" }),
          metrics.addBinding(this.#monitor, "line", { readonly: true, label: "line length" }),
          metrics.addBinding(this.#monitor, "tension", { readonly: true, label: "line tension" }),
          metrics.addBinding(this.#monitor, "altitude", { readonly: true, label: "kite height" }),
          metrics.addBinding(this.#monitor, "window", { readonly: true, label: "wind window" }),
          metrics.addBinding(this.#monitor, "air", { readonly: true, label: "sunset air" }),
          metrics.addBinding(this.#monitor, "kites", { readonly: true, label: "kites" }),
          metrics.addBinding(this.#monitor, "cloth", { readonly: true, label: "cloth path" })
        ];
        return { monitors: bindings };
      },
      sync: () => this.syncTuning()
    };
  }

  godRayRequest(): { active: boolean; center: THREE.Vector3 } | null {
    if (this.#disposed || !this.#awake) return null;
    const tuning = OCEAN_KITE_TUNING.values;
    if (!tuning.enabled || !tuning.volumetricRays) return null;
    // Hysteresis on the radius so a player walking the boundary does not
    // rebuild the whole raymarch graph every few frames.
    const radius = this.#godRaysHeld ? GOD_RAY_EXIT_DISTANCE : GOD_RAY_DISTANCE;
    this.#godRaysHeld =
      this.#air.state.golden > 0.2 && this.#playerDistance <= radius && this.group.visible;
    // One shadow map has to cover every kite on the beach, so centre it on the
    // flock rather than on whichever one happens to be nearest — and on the
    // CASTING flock, since a spectral sail contributes nothing to the map and
    // would only drag it away from the six kites that do.
    this.#godRayCenter.set(0, 0, 0);
    let casters = 0;
    for (const flyer of this.#flyers) {
      if (flyer.design.spectral) continue;
      this.#godRayCenter.add(flyer.kitePosition);
      casters++;
    }
    this.#godRayCenter.multiplyScalar(1 / Math.max(1, casters));
    return { active: this.#godRaysHeld, center: this.#godRayCenter };
  }

  debugState(): OceanBeachKiteDebugState {
    const primary = this.#flyers[0];
    const ground = primary.surfaceBelowKite();
    return {
      webgpuCloth: true,
      awake: this.#awake,
      action: primary.figure,
      runnerSpeed: primary.runnerSpeed,
      lineLength: primary.lineLength,
      lineTarget: primary.lineTarget,
      tension: primary.tension,
      kiteHeight: Math.max(0, primary.kitePosition.y - ground),
      tailLength: primary.tailLength,
      runner: [primary.runnerPosition.x, primary.runnerPosition.y, primary.runnerPosition.z],
      kite: [primary.kitePosition.x, primary.kitePosition.y, primary.kitePosition.z],
      tetherStart: [primary.tetherStart.x, primary.tetherStart.y, primary.tetherStart.z],
      tetherEnd: [primary.tetherEnd.x, primary.tetherEnd.y, primary.tetherEnd.z],
      swing: primary.swing,
      elevation: primary.elevation,
      golden: this.#air.state.golden,
      backlight: this.#air.state.backlight,
      flyers: this.#flyers.map((flyer) => ({
        design: flyer.design.id,
        action: flyer.figure,
        runner: [flyer.runnerPosition.x, flyer.runnerPosition.y, flyer.runnerPosition.z] as
          [number, number, number],
        runnerSpeed: flyer.runnerSpeed,
        lineLength: flyer.lineLength,
        kiteHeight: Math.max(0, flyer.kitePosition.y - flyer.surfaceBelowKite()),
        tailLength: flyer.tailLength,
        kite: [flyer.kitePosition.x, flyer.kitePosition.y, flyer.kitePosition.z],
        swing: flyer.swing,
        elevation: flyer.elevation
      }))
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#playerGeneration++;
    this.#playerKite?.dispose();
    this.#playerKite = null;
    for (const flyer of this.#flyers) flyer.dispose();
    this.#flyers.length = 0;
    this.#troupe.length = 0;
    for (const prism of this.#prisms) prism.dispose();
    this.#prisms.length = 0;
    this.#air.dispose();
    for (const geometry of new Set(this.#ownedGeometries)) geometry.dispose();
    for (const material of new Set(this.#ownedMaterials)) material.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

export function createOceanBeachKiteEncounter(
  map: WorldMap,
  site: OceanBeachKiteSite,
  options?: OceanBeachKiteOptions
): OceanBeachKiteEncounter {
  return new KiteEncounter(map, site, options);
}

export { KITE_DESIGNS, KITE_DESIGN_ORDER };
export type { KiteDesignId };
