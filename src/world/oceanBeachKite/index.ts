import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import { KITE_DESIGNS, KITE_DESIGN_ORDER, type KiteDesignId } from "./kiteDesigns";
import { KiteFlyer, type KiteFlyerFrame } from "./flyer";
import type { KiteFigureName } from "./choreography";
import { createSunsetAir, type SunsetAir } from "./sunsetAir";
import { bindOceanKiteTuning, OCEAN_KITE_TUNING } from "./tuning";

export type OceanBeachKiteSite = { x: number; z: number };

export type OceanBeachKiteFlyerState = {
  design: KiteDesignId;
  action: KiteFigureName;
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
    view?: THREE.Vector3
  ): void;
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
const ROUTE_HALF_LENGTH = 64;
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
 * Who is on the beach, in what order along the shore, and where each one picks
 * up the figure loop. Lane 0 keeps the arrival launch; the other two are
 * already flying when you get there, so nobody is ever caught mid-setup and
 * the three kites never march in step.
 */
const LANES: readonly {
  design: KiteDesignId;
  seed: string;
  offset: number;
  startFigure: number;
  startPhase: number;
}[] = [
  { design: "diamond", seed: "ocean-beach-kite-flyer", offset: 0, startFigure: 0, startPhase: 0 },
  { design: "sunwheel", seed: "ocean-beach-sunwheel-flyer", offset: -1, startFigure: 3, startPhase: 2.4 },
  { design: "lantern", seed: "ocean-beach-lantern-flyer", offset: 1, startFigure: 6, startPhase: 4.1 }
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
  #route: RouteSample[];
  #flyers: KiteFlyer[] = [];
  #air: SunsetAir;
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
  #rayAnchors: { position: THREE.Vector3; spread: number }[] = [];
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

  constructor(map: WorldMap, site: OceanBeachKiteSite) {
    this.#map = map;
    this.#site = { ...site };
    this.#applyWindBearing();
    this.#route = this.#buildRoute();
    this.group.name = "ocean_beach_kite_encounter";

    const tuning = OCEAN_KITE_TUNING.values;
    const spacing = Math.max(18, tuning.runSpan * 0.78);
    for (const lane of LANES) {
      const laneZ = this.#site.z + lane.offset * spacing;
      const flyer = new KiteFlyer({
        map,
        design: KITE_DESIGNS[lane.design],
        seed: lane.seed,
        lane: { x: this.#routeX(laneZ), z: laneZ },
        beachX: (z) => this.#routeX(z),
        startFigure: lane.startFigure,
        startPhase: lane.startPhase,
        startAirborne: lane.startFigure !== 0
      });
      this.#flyers.push(flyer);
      this.group.add(flyer.group);
      this.#rayAnchors.push({
        position: flyer.kitePosition,
        spread: flyer.design.raySpread
      });
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

  #buildRoute(): RouteSample[] {
    const samples: RouteSample[] = [];
    for (let dz = -ROUTE_HALF_LENGTH; dz <= ROUTE_HALF_LENGTH; dz += ROUTE_STEP) {
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
    view?: THREE.Vector3
  ): void {
    if (this.#disposed) return;
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
    for (const flyer of this.#flyers) flyer.update(frame);

    this.#air.update({
      dt,
      camera: this.#viewPoint,
      mist: tuning.mistDensity,
      shafts: tuning.shaftStrength,
      enabled: tuning.sunsetAir
    });
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
    // flock rather than on whichever one happens to be nearest.
    this.#godRayCenter.set(0, 0, 0);
    for (const flyer of this.#flyers) this.#godRayCenter.add(flyer.kitePosition);
    this.#godRayCenter.multiplyScalar(1 / Math.max(1, this.#flyers.length));
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
    for (const flyer of this.#flyers) flyer.dispose();
    this.#flyers.length = 0;
    this.#air.dispose();
    for (const geometry of new Set(this.#ownedGeometries)) geometry.dispose();
    for (const material of new Set(this.#ownedMaterials)) material.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

export function createOceanBeachKiteEncounter(
  map: WorldMap,
  site: OceanBeachKiteSite
): OceanBeachKiteEncounter {
  return new KiteEncounter(map, site);
}

export { KITE_DESIGNS, KITE_DESIGN_ORDER };
export type { KiteDesignId };
