// Soft-HMR guard must register before any other import.meta.hot listeners.
import { suppressesFullReload } from "./app/hmr/suppressFullReload";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import CameraControls from "camera-controls";
import { CAMERA_TUNING, CITYGEN_TUNING, CONFIG, FLOWER_TUNING, FOLIAGE_TUNING, INPUT_TUNING, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING } from "./config";
import { loadPlayerState, resetAllTweaks, saveTweak } from "./core/persist";
import { Input } from "./core/input";
import { tracer } from "./core/hitchTracer";
import { bootMarkStart, bootMark, bootMarkSummary, persistBootHistory } from "./core/bootMarks";
import { createFrameScheduler } from "./core/frameBudget";
import { WorldMap, waterHeight } from "./world/heightmap";
import { OCEAN_BEACH_SURF, oceanBeachShoreline, nearOceanBeachShore } from "./world/oceanBeachWaves";
import { Sky, SKY_TUNING } from "./world/sky";
import { Water } from "./world/water";
import { UnderwaterOverlay } from "./fx/underwater";
import { syncBallGlowNight } from "./fx/ballGlow";
import { SeaPillars } from "./world/seaPillars";
import { TileStreamer } from "./world/tiles";
import { FarOcclusionField } from "./world/shadows/farOcclusionField";
import { createRoadMarkings } from "./world/roadMarkings";
import { RoadGraph } from "./world/traffic/roadGraph";
import { TrafficLightView } from "./world/traffic/trafficLights";
import { StreetLamps } from "./world/streetLamps";
import { Physics } from "./core/physics";
import { updateCrownDisplay, resetCrownTweaks } from "./world/salesforceCrown";
import { createBayLights, updateBayLights, resetBayLightsTweaks } from "./world/bayLights";
import { createGoldenGateLights, updateGoldenGateLights, resetGoldenGateLightsTweaks } from "./world/goldenGateLights";
import { createSutroBeacons, updateSutroTower, resetSutroLightsTweaks } from "./world/sutroTower";
import type { GoldenGateTennisSite } from "./world/goldenGateTennis";
import {
  GOLDMAN_GAMEPLAY_LANDMARK,
  GOLDMAN_SITE_CENTER,
  GOLDMAN_SUPPRESSED_BUILDINGS
} from "./world/goldenGateTennis/meta";
import {
  JAPANESE_TEA_GARDEN_ENTRANCE,
  TEA_GARDEN_SUPPRESSED_BUILDINGS,
  isTeaGardenBuilding
} from "./world/japaneseTeaGarden/layout";
import type { CoronaHeightsPark } from "./world/coronaHeights";
import { prepareCoronaHeightsGround } from "./world/coronaHeights/ground";
import { CORONA_HEIGHTS_SUMMIT } from "./world/coronaHeights/meta";
import type { MissionDoloresMuseum } from "./world/missionDolores";
import { MD_CENTER as MISSION_DOLORES_CENTER } from "./world/missionDolores/layout";
import { findOpenSpawn } from "./world/spawn";
import { resolveSpawnPoint, SPAWN_POINTS } from "./world/spawnPoints";
import { WILD_REGIONS } from "./world/wildlands/regions";
import { BUENA_VISTA_REGION } from "./world/buenaVista";
import { Player } from "./player/player";
import type { PlayerMode } from "./player/types";
import { ChaseCamera } from "./core/camera";
import { FX } from "./fx/fx";
import { BoardWake, WakeRipples } from "./fx/wake";
import { BirdTrails } from "./fx/birdTrail";
import { WaterSplashes } from "./fx/splash";
import { Fireworks } from "./fx/fireworks";
import { Graffiti, PAINT_COLORS } from "./fx/graffiti";
import { Paintballs, PaintSkins, PAINTBALL_SPEED } from "./fx/paintball";
import { Bubbles } from "./fx/bubbles";
import { WorldCursor } from "./fx/worldCursor";
import { WorldQueries, ProxySet } from "./core/worldQueries";
import { BuildingRayRefiner } from "./core/buildingRayRefine";
import { Toolbar, TOOL_ORDER, TOOL_VERB, type ToolName } from "./ui/toolbar";
import { AvatarSelector } from "./ui/avatarSelector";
import { BoardSelector } from "./ui/boardSelector";
import { ScooterSelector } from "./ui/scooterSelector";
import { AudioControls } from "./ui/audioControls";
import { Chat } from "./ui/chat";
import { VehicleAudio } from "./fx/vehicleAudio";
import { SwimAudio } from "./fx/swimAudio";
import { createNatureSoundscape, DogParkAudio } from "./audio";
import { WaveAudio, oceanWaveEnergyAt } from "./audio/waveAudio";
import { AbandonedMounts } from "./gameplay/abandonedMounts";
import type { Creatures } from "./gameplay/creatures";
import type { Forest, AnimalKind } from "./gameplay/forest";
import {
  updateVegetationEnvironment,
  windGustValue,
  type GroundDisplacer
} from "./world/vegetation/runtime";
import { BOTANICAL_GARDEN_BOUNDS } from "./world/garden/layout";
import type { CityGenRing, ColliderBox, ColliderMesh } from "./world/citygen";
import { Islands } from "./gameplay/islands";
import { Hunt } from "./gameplay/hunt";
import { FetchBall } from "./gameplay/fetchBall";
import { createSiteGate } from "./gameplay/siteGate";
import type { ArcheryGame } from "./gameplay/archery";
import { ARCHERY_CENTER } from "./gameplay/archery/meta";
import type { PalaceReverieGame } from "./gameplay/palaceReverie";
import { REVERIE_CENTER } from "./gameplay/palaceReverie/meta";
import type { LandsEndRegion } from "./world/landsEnd";
import { LANDS_END_CENTER } from "./world/landsEnd/meta";
import type { AfterlightExperience } from "./gameplay/afterlight";
import { AFTERLIGHT_ARRIVAL } from "./gameplay/afterlight/meta";
import { Satchel } from "./ui/satchel";
import { HUD } from "./ui/hud";
import { ShareButton } from "./ui/share";
import { PauseToggle } from "./ui/pauseToggle";
// BehindTheScenes is deferred (dynamic import after start is ready)
import { parseReadLink, openReadLink } from "./ui/deepLinks";
import { Tutorial } from "./ui/tutorial";
import { createRenderPipeline } from "./render/pipeline";
import { POSTFX_TUNING, setFlowPostFx } from "./render/postfx";
import type { RadialLightSource } from "./render/radialLightTypes";
import { DebugPanel } from "./ui/debug";
import { ColliderDebug, type DebugBox, type DebugMesh } from "./ui/colliderDebug";
import { CalibrationChart } from "./ui/calibrationChart";
import { Net } from "./net/net";
import { RemotePlayers } from "./net/remotes";
import { Voice } from "./net/voice";
import { Minimap } from "./ui/minimap";
import { PlayerLocator } from "./ui/playerLocator";
import { avatarFromSeed, loadSavedAvatar, randomAvatarTraits, saveAvatarTraits } from "./player/avatar";
import { boardFromSeed, boardVisualKey, loadSavedBoard, randomBoardConfig, saveBoardConfig, setLocalBoardConfig } from "./vehicles/board";
import { CAR_LANDING_TUNING } from "./vehicles/car";
import { loadSavedScooter, randomScooterConfig, saveScooterConfig, scooterFromSeed, scooterKey, setLocalScooterConfig } from "./vehicles/scooter";
import {
  loadSavedSurfboard,
  randomSurfboardConfig,
  saveSurfboardConfig,
  setLocalSurfboardConfig,
  surfboardFromSeed,
  surfboardVisualKey,
  type SurfboardConfig
} from "./vehicles/surf";
import { MENU_MODES, ModeDiscovery, ALL_MODES } from "./player/discovery";
import { BootScreen } from "./app/bootScreen";
import { createRenderCore } from "./app/renderCore";
import { initTextures } from "./render/textures";
import { createBuskersSystem } from "./app/systems/buskers";
import { createSessionPersistence } from "./app/sessionPersistence";
import { startFrameDriver } from "./app/frameDriver";
import { EmbodimentController } from "./app/player/embodimentController";
import { NavigationController } from "./app/navigation";
import { WorldArrivalCoordinator } from "./app/worldArrival";
import { consumeDevReloadSnapshot, writeDevReloadSnapshot } from "./app/hmr/devReloadSnapshot";
import { RendererDiagnostics } from "./app/diagnostics";
import type { PickleballController } from "./app/systems/pickleball";

CameraControls.install({ THREE });

const bootScreen = new BootScreen();
const { app, loading, nameInput, suggestedName } = bootScreen;
const progress = (percent: number, label: string) => bootScreen.progress(percent, label);

type InviteIntent = {
  x: number;
  y: number;
  z: number;
  facing: number;
  mode: PlayerMode;
  animal: AnimalKind | null;
  from: string | null;
};

type RegionKey = "garden" | "wildlands" | "golf";

function parseInviteIntent(search: string): InviteIntent | null {
  const query = new URLSearchParams(search);
  const raw = query.get("j");
  if (!raw) return null;
  const parts = raw.split(",");
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const z = Number(parts[2]);
  const facing = Number(parts[3]);
  const mode = ALL_MODES.find((candidate) => candidate === parts[4]);
  if (![x, y, z, facing].every(Number.isFinite) || !mode) return null;
  const animal = parts[5] === "bear" || parts[5] === "raccoon" ? parts[5] : null;
  return {
    x,
    y,
    z,
    facing,
    mode,
    animal,
    from: query.get("via")
  };
}

async function boot() {
  const bootT0 = performance.now();
  // Wireframe is a transient inspection view, never a valid play-session
  // startup mode. Clear an old persisted toggle before the render pipeline is
  // created so boot warms and reveals the solid-material path (`wf0`) instead
  // of compiling a debug line-list world and carrying it through Start.
  if (RENDER_TUNING.values.wireframe) {
    RENDER_TUNING.values.wireframe = false;
    saveTweak("render.wireframe", false);
  }
  bootMarkStart();
  progress(8, "reading the map");
  const map = await WorldMap.load();
  prepareCoronaHeightsGround(map);
  bootMark("map");

  progress(18, "waking the gpu");
  const { renderer, scene, camera } = await createRenderCore(app);
  initTextures(renderer); // wire the KTX2 transcoder now that the renderer is initialized
  bootMark("gpu");

  const farOcclusion = new FarOcclusionField(map);
  const sky = new Sky(scene, farOcclusion);
  const water = new Water(scene, map);
  // The authored high-resolution break is activity code, not a boot fundamental.
  // Its analytic CPU heightfield stays available through oceanBeachWaves.ts, but
  // the heavy visual mesh/HUD chunk is requested only when surfing starts.
  let oceanBeachWaves: import("./gameplay/surfing/waves").OceanBeachWaves | null = null;
  const underwater = new UnderwaterOverlay(app, map);
  const seaPillars = new SeaPillars(scene, map);

  progress(40, "streaming the city");
  const tiles = new TileStreamer(scene);
  tiles.onShadowCastersChanged = (scope) => sky.invalidateStaticShadows(scope);
  await tiles.init(map);
  bootMark("tiles");

  // Resolve the real initial destination and start its fixed-quality local tile
  // prime while Box3D instantiates. These streams are independent: visual fetch,
  // worker spawn validation, and WASM setup should overlap rather than forming a
  // serial loading waterfall before the first covered frame can be prepared.
  let initialVisualState: "pending" | "ready" | "fallback" = "pending";
  let initialVisualDeadlineAt = performance.now() + 15_000;
  let initialVisualEpoch = 0;
  const initialVisualFocus = { x: Number.NaN, z: Number.NaN };
  const primeInitialVisualAt = (x: number, z: number) => {
    const epoch = ++initialVisualEpoch;
    initialVisualFocus.x = x;
    initialVisualFocus.z = z;
    initialVisualState = "pending";
    initialVisualDeadlineAt = performance.now() + 15_000;
    const prime = tiles.primeAt(x, z);
    void prime.ready.then((result) => {
      if (epoch !== initialVisualEpoch) return;
      if (result.status === "ready") initialVisualState = "ready";
      else if (result.status === "failed") initialVisualState = "fallback";
    });
  };
  const initialArrivalPromise = (async () => {
    // Code spawns win over baked metadata; resume/invite links bypass the default
    // district entirely so a shared link never loads one neighborhood and then
    // performs a second cross-city relocation.
    const arrivalQuery = new URLSearchParams(location.search);
    const requestedSpawn = arrivalQuery.get("spawn")?.trim();
    const autoStartHiroTour = arrivalQuery.get("tour") === "hiro";
    const invite = parseInviteIntent(location.search);
    const reloadCandidate = import.meta.env.DEV ? consumeDevReloadSnapshot() : null;
    const devReload = invite || parseReadLink(location.search) || arrivalQuery.has("demo")
      ? null
      : reloadCandidate;
    const resumed = invite || requestedSpawn ? null : (devReload?.player ?? loadPlayerState());
    const requestedCodeSpawn = requestedSpawn ? resolveSpawnPoint(requestedSpawn) : undefined;
    const requestedBakedSpawn = requestedSpawn ? map.meta.spawns[requestedSpawn] : undefined;
    const spawnKey = requestedCodeSpawn || requestedBakedSpawn ? requestedSpawn! : START.spawn;
    const spawnPoint = requestedCodeSpawn ?? (
      requestedBakedSpawn
        ? undefined
        : resolveSpawnPoint(spawnKey) ?? resolveSpawnPoint(START_DEFAULTS.spawn)
    );
    if (spawnPoint?.key === "oceanBeach") {
      const shore = oceanBeachShoreline(map, spawnPoint.z, 3);
      spawnPoint.x = shore.x;
      spawnPoint.z = shore.z;
    }
    const registeredStart =
      spawnPoint ??
      requestedBakedSpawn ??
      map.meta.spawns[spawnKey] ??
      map.meta.spawns[START_DEFAULTS.spawn];
    const inviteMode = invite?.animal ? "drive" : invite?.mode;
    const inviteSide = invite
      ? inviteMode === "boat" || inviteMode === "plane"
        ? 7
        : inviteMode === "drive"
          ? 4
          : 2.5
      : 0;
    const inviteStart = invite
      ? {
          x: invite.x + Math.cos(invite.facing) * inviteSide,
          z: invite.z - Math.sin(invite.facing) * inviteSide,
          heading: invite.facing
        }
      : null;
    const resumeStart = resumed
      ? { x: resumed.x, z: resumed.z, heading: resumed.heading - Math.PI }
      : null;
    const startAt = inviteStart ?? resumeStart ?? registeredStart;
    const scatterA = Math.random() * Math.PI * 2;
    const scatterR = requestedSpawn || inviteStart || resumeStart
      ? 0
      : 0.8 + Math.random() * 1.6;
    const spawn = inviteStart ?? resumeStart ?? await findOpenSpawn(
      map,
      tiles.manifest,
      {
        ...startAt,
        x: startAt.x + Math.cos(scatterA) * scatterR,
        z: startAt.z + Math.sin(scatterA) * scatterR
      },
      requestedSpawn ? 1.5 : 12,
      requestedSpawn ? 36 : 200
    );

    // Same materials and geometry, smaller initial residency. The normal draw
    // ring expands after the first playable frame; this is not adaptive quality.
    const fullTileRadius = CONFIG.tileLoadRadius;
    const INITIAL_VISUAL_RADIUS = 1000;
    CONFIG.tileLoadRadius = Math.min(fullTileRadius, INITIAL_VISUAL_RADIUS);
    primeInitialVisualAt(spawn.x, spawn.z);
    return {
      autoStartHiroTour,
      invite,
      devReload,
      resumed,
      spawnPoint,
      spawn,
      fullTileRadius
    };
  })();

  // off-boot-path loads (lane markings, the road graph's signals + lamps)
  // still don't block boot, but the settle gate holds the loading cover until
  // they land — success OR failure — so they never pop over the revealed city
  let auxPending = 0;
  let roadMarkings: THREE.Group | null = null;
  auxPending++;
  void createRoadMarkings(scene, map)
    .then((group) => {
      roadMarkings = group;
    })
    .catch((err) => console.warn("[roads] lane markings unavailable", err))
    .finally(() => auxPending--);

  const [physics, initialArrival] = await Promise.all([
    Physics.create(map, tiles),
    initialArrivalPromise
  ]);
  const {
    autoStartHiroTour,
    invite,
    devReload,
    resumed,
    spawnPoint,
    spawn,
    fullTileRadius
  } = initialArrival;
  // Physics owns the primary tile callbacks. Chain the far field after it so
  // streamed collider massing feeds both systems without changing ownership.
  const syncFarTile = (key: string, colliders = tiles.loaded.get(key)?.colliders) => {
    if (!colliders) return;
    farOcclusion.setBoxOccluders(
      `tile:${key}`,
      colliders.filter((collider) => tiles.isAlive(key, collider.i))
    );
  };
  const physicsTileColliders = tiles.onTileColliders;
  tiles.onTileColliders = (key, colliders) => {
    physicsTileColliders(key, colliders);
    syncFarTile(key, colliders);
  };
  const physicsTileUnload = tiles.onTileUnload;
  tiles.onTileUnload = (key) => {
    physicsTileUnload(key);
    farOcclusion.deleteOccluders(`tile:${key}`);
  };
  const physicsBuildingAlive = tiles.onBuildingAlive;
  tiles.onBuildingAlive = (key, index, alive) => {
    physicsBuildingAlive(key, index, alive);
    // Mesh-only CityGen swaps remain alive and retain canonical massing. Full
    // authored suppression/revival refreshes the atlas without ghost blockers.
    syncFarTile(key);
  };
  // Open-water bridge spans and landmark boxes do not belong to streamed
  // visual tiles. Feed their existing physics proxy set into the same field.
  void fetch("/data/landmark-colliders.json")
    .then((response) => response.ok ? response.json() : [])
    .then((colliders) => farOcclusion.setBoxOccluders("landmarks", colliders))
    .catch(() => {});
  bootMark("physics");

  progress(62, "waking up san francisco");
  const input = new Input(renderer.domElement);
  const hud = new HUD();
  const modeDiscovery = new ModeDiscovery();
  const fx = new FX(scene);
  const wake = new WakeRipples(scene);
  const boardWake = new BoardWake(scene, map, wake);
  const splashes = new WaterSplashes(scene, wake, map);
  const fireworks = new Fireworks(renderer, scene, map);
  // Building four audio graphs on the first movement key caused a visible cold
  // input hitch. Fireworks owns the first shared browser audio-device startup,
  // so perform its existing no-network prewarm under the loading cover; later
  // gesture handlers only resume the already-built suspended context.
  fireworks.prewarm();

  // Space / pad-X toys — ↑/↓ pick the toolbar row, ←/→ cycle within it
  const graffiti = new Graffiti(scene);
  const paintballs = new Paintballs(scene);
  const paintSkins = new PaintSkins();
  paintballs.onWater = (x, y, z) => splashes.splash(x, y, z, elapsed, 0.5);
  const bubbles = new Bubbles(scene, map, physics);
  const worldCursor = new WorldCursor(scene);
  let tool: ToolName = "ball";
  let fetchBall: FetchBall | null = null; // built after coronaHeights; setTool runs once before it exists
  const setTool = (t: ToolName) => {
    tool = t;
    toolbar.setTool(t);
    hud.setToolVerb(TOOL_VERB[t]);
    // ball tool → hold-to-throw prop; leaving it hides the prop, but free balls,
    // in-flight fetch + pet follow keep running because fetchBall.update runs every frame
    fetchBall?.setActive(t === "ball");
  };
  let paintColorTouched = false;
  let paintColorSeeded = false;
  const setColor = (i: number, userPicked = false) => {
    if (userPicked) paintColorTouched = true;
    graffiti.colorIndex = i;
    toolbar.setColor(i);
  };
  let switchModeFromToolbar: (mode: PlayerMode) => void = () => {};
  const toolbar = new Toolbar(
    (t) => setTool(t),
    (i) => setColor(i, true),
    (mode) => switchModeFromToolbar(mode)
  );
  setTool("ball");
  setColor(0);

  // procedural vehicle hum + the HUD's master volume/mute widget (bottom-left)
  const vehicleAudio = new VehicleAudio();
  const swimAudio = new SwimAudio();
  const audioControls = new AudioControls();
  // procedural, layered nature soundscape (Botanical Garden / GG Park / Presidio
  // / Marin): sampled beds + gust-locked wind synth + spatial animal calls, all
  // fading in per region. Suspends itself when the player is out in the city.
  const nature = createNatureSoundscape();
  // Reusable ocean-wave layer (breaking surf at Ocean Beach + shoreline wash
  // anywhere near water); rides the nature AudioContext.
  const waveAudio = new WaveAudio(nature);

  // Avatar identity: a saved avatar means the player chose one in the editor;
  // otherwise leave it to the server's per-id seed (adopted on welcome below) so
  // every player — every browser tab included — looks distinct. randomAvatarTraits
  // is just a non-default placeholder for the seconds before we're welcomed (and
  // the whole life of an offline single-player session).
  const savedAvatar = loadSavedAvatar();
  let customized = savedAvatar !== null;
  let avatarTraits = savedAvatar ?? randomAvatarTraits();
  // Board identity follows the exact same contract as the avatar: saved means
  // chosen; otherwise a placeholder until the server's per-id seed arrives.
  const savedBoard = loadSavedBoard();
  let boardCustomized = savedBoard !== null;
  let boardConfig = savedBoard ?? randomBoardConfig();
  setLocalBoardConfig(boardConfig); // abandonedMounts builds YOUR board from this
  const savedScooter = loadSavedScooter();
  let scooterCustomized = savedScooter !== null;
  let scooterConfig = savedScooter ?? randomScooterConfig();
  setLocalScooterConfig(scooterConfig);
  // Surfboard identity follows the same explicit-choice/per-id-seed contract,
  // but its PNG art remains completely unloaded until surfing or the lab starts.
  const savedSurfboard = loadSavedSurfboard();
  let surfboardCustomized = savedSurfboard !== null;
  let surfboardConfig = savedSurfboard ?? randomSurfboardConfig();
  setLocalSurfboardConfig(surfboardConfig);
  vehicleAudio.setBoardStyle(boardConfig);
  const player = new Player(physics, map, scene, spawn, avatarTraits, boardConfig, scooterConfig, surfboardConfig);
  player.holdForWorldArrival("boot-arrival");
  let initialCollisionEpoch = physics.prepareCollisionArrival(player.position);
  physics.activateCollisionArrival(initialCollisionEpoch);
  let initialCollisionReady = false;
  let initialArrivalReleased = false;
  let initialCollisionRetryCycles = 0;
  let initialCollisionFailureReported = false;
  let initialVisualFailureReported = false;
  const chase = new ChaseCamera(camera, map, physics);
  chase.yaw = spawn.heading; // behind the player, looking the way they face (spawn.heading is raw facing)
  // Seed above the local ground — hilltop spawns sit well over y=30.
  camera.position.set(spawn.x + 20, map.effectiveGround(spawn.x, spawn.z) + 30, spawn.z + 20);
  let surfExperience: import("./gameplay/surfing/game").SurfExperience | null = null;
  let surfRuntimeLoading: Promise<void> | null = null;
  const refreshSurfDebug = () => {
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) Object.assign(hooks, { oceanBeachWaves, surfExperience });
  };
  const ensureSurfRuntime = () => {
    const surfing = player.mode === "surf";
    // Face mesh can warm on the sand; SurfExperience only while actually surfing.
    if (oceanBeachWaves && (!surfing || surfExperience)) return Promise.resolve();
    if (surfRuntimeLoading) return surfRuntimeLoading;
    surfRuntimeLoading = import("./gameplay/surfing")
      .then(({ OceanBeachWaves, SurfExperience }) => {
        const stillSurfing = player.mode === "surf";
        const stillNear = nearOceanBeachShore(player.position.x, player.position.z);
        // Drop the construct if the player left the break before the chunk arrived;
        // the cached module is instant on the next E / shore approach.
        if (!stillSurfing && !stillNear) return;
        oceanBeachWaves ??= new OceanBeachWaves(scene);
        if (stillSurfing) surfExperience ??= new SurfExperience(vehicleAudio);
        refreshSurfDebug();
      })
      .catch((error) => console.warn("[surf] runtime failed to load", error))
      .finally(() => {
        surfRuntimeLoading = null;
      });
    return surfRuntimeLoading;
  };
  const releaseSurfVisual = () => {
    oceanBeachWaves?.dispose();
    oceanBeachWaves = null;
    refreshSurfDebug();
  };
  let surfFlowFx = 0;
  let surfFlowPhase = 0;
  let surfFlowSerial = 0;
  let surfSplashSerial = 0;
  const updateSurfPresentation = (dt: number) => {
    const surf = player.surfTelemetry;
    const active = player.mode === "surf" && surf.flowActive;
    const response = active ? 8 : 2.6;
    surfFlowFx += ((active ? 1 : 0) - surfFlowFx) * (1 - Math.exp(-Math.min(dt, 0.1) * response));
    if (surf.flowSerial !== surfFlowSerial) {
      surfFlowSerial = surf.flowSerial;
      surfFlowPhase = 0;
    } else {
      surfFlowPhase += dt;
    }
    setFlowPostFx(surfFlowFx, surfFlowPhase);
  };
  // The customizer module itself is deferred until the player explicitly opens
  // the shaping room. This is rebound after networking exists; the early no-op
  // keeps the mode callback safe during startup/restores.
  let ensureSurfboardCustomizer: (open?: boolean) => void = () => {};
  let setSurfboardLauncherVisible: (visible: boolean) => void = () => {};
  let setSurfboardCustomizerMode: (active: boolean) => void = () => {};
  let setRemoteSurfboardAssetsActive: (active: boolean) => void = () => {};
  let leaveCameraModeForSurf: () => void = () => {};
  const birdTrails = new BirdTrails(scene, player.meshes.bird);
  const droneFireworkMounts = player.meshes.drone.userData.fireworkMounts as THREE.Object3D[] | undefined;
  const startMode = invite || resumed ? "walk" : (spawnPoint?.mode ?? START.mode);
  if (startMode !== "walk" && ALL_MODES.includes(startMode)) {
    if (startMode === "surf") await chase.ensureSurfCamera();
    player.trySwitch(startMode);
  }
  // Surf-mode far-cull (perf audit's #1 win): a west-facing surfer never sees the
  // city behind them, but streamed tiles + citygen chunks are frustumCulled=false
  // — they pay GPU draw cost every frame regardless of view, cleared only by
  // distance-unload. So while surfing we shrink the streamed radius + citygen
  // detail and pull the fog cull-edge in to hide the closer unload seam, then
  // restore on the way out. Mutating .values directly does NOT persist (only the
  // tweakpane onChange path does), so no saved-tweak pollution.
  let surfCullStash: { load: number; unload: number; detail: number; maxDetail: number } | null = null;
  const applySurfCull = (on: boolean) => {
    if (on && !surfCullStash) {
      surfCullStash = {
        load: CONFIG.tileLoadRadius,
        unload: CONFIG.tileUnloadRadius,
        detail: CITYGEN_TUNING.values.detailRadius,
        maxDetail: CITYGEN_TUNING.values.maxDetail
      };
      CONFIG.tileLoadRadius = Math.min(CONFIG.tileLoadRadius, 2000);
      CONFIG.tileUnloadRadius = 2400;
      CITYGEN_TUNING.values.detailRadius = Math.min(CITYGEN_TUNING.values.detailRadius, 140);
      CITYGEN_TUNING.values.maxDetail = Math.min(CITYGEN_TUNING.values.maxDetail, 40);
      sky.setCullRadiusOverride(2000);
      tiles.forceScan();
    } else if (!on && surfCullStash) {
      CONFIG.tileLoadRadius = surfCullStash.load;
      CONFIG.tileUnloadRadius = surfCullStash.unload;
      CITYGEN_TUNING.values.detailRadius = surfCullStash.detail;
      CITYGEN_TUNING.values.maxDetail = surfCullStash.maxDetail;
      surfCullStash = null;
      sky.setCullRadiusOverride(null);
      tiles.forceScan();
    }
  };
  player.onModeChange = (mode) => {
    const fresh = modeDiscovery.discover(mode);
    hud.setMode(mode);
    toolbar.setVehicle(mode);
    input.setMode(mode); // trigger routing (fly puts them on the ↑/↓ throttle)
    debugPanel.setMode(mode); // tuning pane shows only the active mode's movement folder
    applySurfCull(mode === "surf");
    if (mode === "surf") {
      leaveCameraModeForSurf();
      void chase.ensureSurfCamera();
      void ensureSurfRuntime();
    } else if (!nearOceanBeachShore(player.position.x, player.position.z)) {
      // Keep the face mesh warm while still on the sand so E re-entry is instant.
      releaseSurfVisual();
    }
    setRemoteSurfboardAssetsActive(mode === "surf");
    setSurfboardLauncherVisible(mode === "surf");
    setSurfboardCustomizerMode(mode === "surf");
    if (fresh) {
      const msg = modeDiscovery.revealMessage(mode);
      if (msg) hud.message(msg, 2.8);
    }
  };
  input.setMode(player.mode);
  toolbar.setVehicle(player.mode);
  // onModeChange is wired after the startup trySwitch, so a boot straight into
  // surf (spawnPoint/invite) needs the cull applied once explicitly.
  if (player.mode === "surf") {
    // The boot visual prime temporarily reduced this to 1 km. Seed the surf
    // stash from the real fixed-quality radius so leaving surf restores normal
    // residency instead of permanently preserving the boot bubble.
    CONFIG.tileLoadRadius = fullTileRadius;
    CONFIG.tileUnloadRadius = fullTileRadius + 400;
    applySurfCull(true);
    void chase.ensureSurfCamera();
    void ensureSurfRuntime();
  }
  // controller: swap the help labels to whichever device was touched last
  input.onDeviceChange = (device) => hud.setDevice(device);
  window.addEventListener("gamepadconnected", () => hud.message("Controller connected", 2.4));
  window.addEventListener("gamepaddisconnected", () => {
    hud.message("Controller disconnected", 2.4);
    hud.setDevice("kb");
  });

  // Traffic lights: procedural signals along the road graph. The road graph
  // loads off the boot path; once it's ready the light rigs pool into the scene
  // and their state machine cycles (see world/traffic/). The same decoded graph
  // later paints the map roads, avoiding another request/parse. Failures leave
  // the city without signals but never block boot.
  let trafficLights: TrafficLightView | null = null;
  let streetLamps: StreetLamps | null = null;
  auxPending++;
  const roadGraphPromise = RoadGraph.load();
  void roadGraphPromise
    .then((roads) => {
      trafficLights = new TrafficLightView(scene, map, roads);
      // fake night-street lighting: reuse the just-loaded graph (no second fetch)
      streetLamps = new StreetLamps(scene, map, roads);
      const sfHooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (sfHooks) Object.assign(sfHooks, { streetLamps });
    })
    .catch((err: unknown) => console.warn("[traffic] signals unavailable", err))
    .finally(() => auxPending--);
  let creatures: Creatures | null = null;
  let forest: Forest | null = null;
  // ANIMALS record — populated by the deferred forest module load
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ANIMALS: Record<string, any> | null = null;
  const abandonedMounts = new AbandonedMounts(physics, map, scene);
  const embodiments = new EmbodimentController({
    player,
    physics,
    hud,
    abandonedMounts,
    getForest: () => forest
  });
  let switchModeFromExit: (mode: PlayerMode) => void = (mode) => embodiments.switchMode(mode);
  const exitToWalk = () => {
    // Surf exits relocate from a live crest to the shoreline. The normal E/B
    // path and the out-of-bounds repair must use Navigation's covered preview;
    // ordinary mount dismounts remain local and immediate.
    if (player.mode === "surf") {
      switchModeFromExit("walk");
      return true;
    }
    return embodiments.exitToWalk();
  };
  type ViewMode = "third" | "first" | "orbit";
  const VIEW_CYCLE: ViewMode[] = ["third", "first", "orbit"];
  let viewMode: ViewMode = "third";
  const inOrbit = () => viewMode === "orbit";
  // scatter boardable boats around the bay — walk/swim up + E to drive one off.
  // persistent: they wait at their spot no matter how far you roam.
  const scatterBoat = (mode: "boat" | "speedboat", x: number, z: number, heading: number) => {
    abandonedMounts.spawn(
      mode,
      {
        position: new THREE.Vector3(x, waterHeight(x, z, 0) + 0.4, z),
        quaternion: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), heading),
        linear: [0, 0, 0],
        angular: [0, 0, 0]
      },
      { persistent: true }
    );
  };
  // headings are only the starting facing now — the boats wander the bay on
  // their own (see AbandonedMounts #sailBoat). Midpoint spots sit between two
  // known-water spots so they stay in open bay.
  const SAIL_SPOTS: [number, number, number][] = [
    [2600, -2400, 1.2],
    [-700, -2380, 0.4],
    [1700, -3550, 2.3],
    [4000, -2000, -1.0],
    [-1500, -2500, 0.8],
    [3300, -2200, 0.0],
    [-1100, -2440, 2.0]
  ];
  const SPEED_SPOTS: [number, number, number][] = [
    [3300, -2600, -0.6],
    [900, -2950, 1.7],
    [-2350, -2150, 0.2],
    [4550, -1650, -1.4],
    [250, -3750, 2.9],
    [3925, -2125, 1.0],
    [575, -3350, -2.0]
  ];
  for (const [x, z, h] of SAIL_SPOTS) scatterBoat("boat", x, z, h);
  for (const [x, z, h] of SPEED_SPOTS) scatterBoat("speedboat", x, z, h);
  // Nature uses one sandbox vegetation runtime now. The old primitive Flora
  // and site-local blob/tree renderers are gone: regions own placement, while
  // shared trees, shrubs, grass and flowers own geometry/materials/wind/LOD.
  //
  // San Francisco Botanical Garden — self-contained module (src/world/garden):
  // Unified trees + blade grass + leaf-spray shrubs + flower clumps at the real
  // SFBG footprint inside Golden Gate Park. Trees stream in async; grass is live.
  // garden, wildlands are deferred — constructed after progress(100)
  // so they don't block first paint. Nullable refs; update calls are guarded.
  let garden: {
    group: THREE.Group;
    ready: Promise<void>;
    setVisible: (visible: boolean, focus: { x: number; z: number }) => void;
    update: (pos: THREE.Vector3) => void;
  } | null = null;
  let wildlands: {
    groups: THREE.Group[];
    ready: Promise<void>;
    flowers: { refresh: () => void };
    grass: { refresh: () => void };
    prepareAt: (
      focus: { x: number; z: number },
      prepare?: (unit: THREE.Object3D) => Promise<void>,
      signal?: AbortSignal
    ) => Promise<void>;
    update: (pos: THREE.Vector3, cam: THREE.Vector3) => void;
  } | null = null;
  let buenaVistaTrees: {
    group: THREE.Group;
    ready: Promise<void>;
    update: (focus: { x: number; z: number }) => void;
  } | null = null;
  let goldenGateTennis: GoldenGateTennisSite | null = null;
  let japaneseTeaGarden: import("./world/japaneseTeaGarden").JapaneseTeaGarden | null = null;
  let wakeDeferredGarden: (() => void) | null = null;
  let wakeDeferredTeaGarden: (() => void) | null = null;
  let wakeDeferredBuenaVistaTrees: (() => void) | null = null;
  let wakeDeferredWildlandsGolf: (() => void) | null = null;
  // Universal minigame site gate: each located game (pickleball, golf, soon
  // archery) registers a footprint + pads; one cheap update per tick flips
  // them awake only while the player is nearby. Sites register asleep — the
  // first tick wakes any the player already stands in.
  const siteGate = createSiteGate();
  let coronaHeights: CoronaHeightsPark | null = null;
  let missionDolores: MissionDoloresMuseum | null = null;
  let missionDoloresLoading: Promise<void> | null = null;
  let activeMissionDoloresRadialSource: RadialLightSource | null = null;
  let museumBookOpen = false;
  const ensureMissionDolores = (playerPos: THREE.Vector3): void => {
    if (missionDolores || missionDoloresLoading) return;
    const dx = playerPos.x - MISSION_DOLORES_CENTER.x;
    const dz = playerPos.z - MISSION_DOLORES_CENTER.z;
    if (dx * dx + dz * dz > 190 * 190) return;
    missionDoloresLoading = import("./world/missionDolores")
      .then(({ createMissionDoloresMuseum }) => {
        missionDolores = createMissionDoloresMuseum(map, physics, {
          scene,
          renderer,
          camera,
          onBookToggle: (open) => {
            museumBookOpen = open;
            app.classList.toggle("world-dimmed", open);
            input.suspended = open || inOrbit();
            if (open) input.releaseLock();
          }
        });
        const debug = (window as unknown as { __sf?: { missionDolores: MissionDoloresMuseum | null } }).__sf;
        if (debug) debug.missionDolores = missionDolores;
      })
      .catch((err) => {
        console.warn("[boot] Mission Dolores museum unavailable:", err);
      });
  };
  const renderFrame = () => {
    const wantsMuseumRays =
      Boolean(POSTFX_TUNING.values.museumRays) &&
      missionDolores?.isPlayerInInterior(player.position) === true;
    if (!wantsMuseumRays && activeMissionDoloresRadialSource) {
      // Detach the render graph before releasing the source proxies it reads.
      pipeline.setRadialLightSource(null);
      activeMissionDoloresRadialSource = null;
      missionDolores?.releaseRadialLightSource();
    } else if (wantsMuseumRays && !activeMissionDoloresRadialSource) {
      const nextSource = missionDolores?.radialLightSource ?? null;
      if (nextSource) {
        activeMissionDoloresRadialSource = nextSource;
        pipeline.setRadialLightSource(nextSource);
      }
    }
    pipeline.render();
  };
  const gardenDisplacer: GroundDisplacer = { x: 0, z: 0, radius: 1.6, strength: 1 };
  const gardenDisplacers = [gardenDisplacer];
  // Master foliage switch (bound at the top of the "/" panel). When off, every
  // vegetation group is hidden AND its per-frame update is skipped in the loop
  // below — see the `foliageOn` gate around garden/wildlands update.
  let foliageOn = Boolean(FOLIAGE_TUNING.values.visible);
  const setFoliageVisible = (visible: boolean) => {
    foliageOn = visible;
    garden?.setVisible(visible, player.position);
    if (wildlands) for (const g of wildlands.groups) g.visible = visible;
    if (buenaVistaTrees) buenaVistaTrees.group.visible = visible;
    goldenGateTennis?.setFoliageVisible(visible);
    japaneseTeaGarden?.setFoliageVisible(visible);
    coronaHeights?.setFoliageVisible(visible);
    landsEnd?.setFoliageVisible(visible);
    islands.setFoliageVisible(visible);
    sky.invalidateStaticShadows();
  };
  const islands = new Islands(physics, map, scene);
  islands.setFoliageVisible(foliageOn);

  // Decoupled world-query service: every "what does this ray hit" caller (paint,
  // the in-world cursor, future systems) goes through here. Backed by box3d's
  // broadphase cast over a dedicated query world of entity proxies, raced against
  // the static-world caster.
  const worldQueries = new WorldQueries(physics);
  // Building ray refinement: baked building colliders overshoot the true
  // footprint by up to ~2 m, so every raycastWorld consumer (paint, the world
  // cursor, golf bounces) re-tests building hits against the RENDERED citygen
  // geometry — splats land on the visible wall, and rays aimed through gaps
  // between far buildings no longer stop mid-air on the loose box.
  const buildingRayRefiner = new BuildingRayRefiner(scene);
  physics.setBuildingRayRefiner(buildingRayRefiner);

  // Frame-budget scheduler: ALL deferrable bursty work (streamed physics bodies,
  // citygen assembly, material warmups) queues here and drains under a per-frame
  // ms budget in the tick — see core/frameBudget.ts for the contract.
  const scheduler = createFrameScheduler();

  // The production ring is citywide. The small demo spawner is debug-only and
  // stays out of ordinary boot unless a probe explicitly asks for it.
  let citygen: { update?: (dt: number) => void; [k: string]: unknown } | null = null;
  const citygenRing: { current: CityGenRing | null } = { current: null };

  // crabs to hunt (hunt.ts)
  const satchel = new Satchel();
  // Presidio golf: full 18 playable holes on the real course footprint —
  // deferred (data fetch + course meshes build behind the settle gate below)
  let golf: import("./gameplay/golf").GolfGame | null = null;
  // Golden Gate Park archery range — NW corner of the park; site-gated like golf.
  let archery: ArcheryGame | null = null;
  // Palace of Fine Arts blue-hour art quest (site-gated around the lagoon).
  let palaceReverie: PalaceReverieGame | null = null;
  // Lands End — the NW headland: a cliff-top Labyrinth you light by walking,
  // Sutro Baths ruins, cypress and a lantern-keeper. Distance-LOD region.
  let landsEnd: LandsEndRegion | null = null;
  // Buena Vista's hidden summit ritual: five wandering echoes and a sky-scale
  // finale, asleep outside its clearing like the other located activities.
  let afterlight: AfterlightExperience | null = null;
  const hunt = new Hunt(map, scene);
  hunt.onCatch = (kind) => {
    satchel.add(kind);
    hud.message("Crab caught!", 1.1);
  };

  // Decorative landmarks/parks: each build is isolated in its own try/catch so a
  // broken subsystem degrades scenery (a missing tower, dark bridge) instead of
  // wedging boot on a stuck loading cover. Core systems above
  // (map/renderer/tiles/physics/player) stay fatal — the world is unplayable
  // without them. (Direct try/catch, not a closure helper: assigning these outer
  // `let`s inside an immediately-invoked closure trips TS control-flow analysis
  // and spuriously narrows unrelated captured vars to `never`.)
  let bayLights: ReturnType<typeof createBayLights> = null;
  try {
    bayLights = createBayLights(map);
    if (bayLights) scene.add(bayLights);
  } catch (err) {
    console.warn("[boot] bay lights unavailable:", err);
  }
  let goldenGateLights: ReturnType<typeof createGoldenGateLights> = null;
  try {
    goldenGateLights = createGoldenGateLights(map);
    if (goldenGateLights) scene.add(goldenGateLights);
  } catch (err) {
    console.warn("[boot] golden gate lights unavailable:", err);
  }
  try {
    scene.add(createSutroBeacons(map));
  } catch (err) {
    console.warn("[boot] sutro beacons unavailable:", err);
  }
  // The seven mapped Tea Garden buildings are replaced by authored, walkable
  // structures. Hide both baked prisms and their generic colliders up front;
  // the garden module owns the replacement collision and restores these on a
  // construction failure.
  for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
    tiles.suppressBuilding(building.key, building.index);
  }
  // Authored sites are first-approach features. Their map metadata is already
  // available, but code, geometry, UI/audio and shader compilation stay behind
  // the generic post-arrival proximity coordinator below.
  // Mission San Francisco de Asís is a first-use region. Its module, hidden
  // reader UI, procedural shell, exhibits, and art all stay out of clean boot;
  // ensureMissionDolores() crosses the code gate only on physical approach.
  // Fetch-the-ball loop: hold-to-throw (ball + overhand windup start immediately;
  // release before 1s stows, hold longer for power). Walk up and press E to pick
  // one up, or take it from a waiting dog. A free dog in the Corona Heights park
  // chases park throws, carries back and waits — two full fetches adopt it as a
  // pet. Free balls, in-flight fetch and pet follow are driven every frame by
  // fetchBall.update (tool-agnostic). park is a getter — coronaHeights is
  // null-until-built.
  fetchBall = new FetchBall({
    scene,
    map,
    physics,
    park: () => coronaHeights,
    playerView: {
      setBallHeld: (h) => player.setBallHeld(h),
      setThrowAnim: (t) => player.setThrowAnim(t),
      handWorldPos: (out) => player.handWorldPos(out)
    },
    hud: { message: (t, s) => hud.message(t, s) }
  });
  // setTool ran before fetchBall existed — sync the held prop to the active tool
  fetchBall.setActive(tool === "ball");
  // Dog-park sound layer: barks + paw-patter from the actual park dogs, riding
  // the nature soundscape's context/bus so HUD volume/mute and the corona
  // region fade all apply. Idles to a single distance check away from the park.
  const dogParkAudio = new DogParkAudio(nature, () => coronaHeights?.dogs ?? []);
  // First feature-level HMR boundary. The stable facade survives edits while
  // its concrete trio, GPU resources, audio and perch collider are replaced.
  const buskers = createBuskersSystem({ scene, map, physics });
  let ridePromptShown = false;
  let doorPromptShown = false;
  let doorScanCountdown = 0;
  let doorScanHit: ReturnType<CityGenRing["nearestDoor"]> = null;
  // way high above the ground (plane/drone cruising), ground flora and critters
  // are subpixel — their systems pause. Hysteresis so hill flanks don't flicker it.
  let highUp = false;

  // Car physics publishes one stable landing event; presentation consumes each
  // serial exactly once. The controller stays independent from camera/audio/VFX,
  // while every authored range remains together under movement > car > landing.
  let consumedCarLandingSerial = player.driveLandingFeedback.serial;
  const carLandingPosition = new THREE.Vector3();
  const consumeCarLandingFeedback = () => {
    const landing = player.driveLandingFeedback;
    if (landing.serial === consumedCarLandingSerial) return;
    consumedCarLandingSerial = landing.serial;
    const tuning = CAR_LANDING_TUNING.values;
    if (
      player.mode !== "drive" ||
      embodiments.currentAnimal ||
      !tuning.enabled ||
      landing.strength <= 0
    ) return;

    const amount = THREE.MathUtils.clamp(landing.strength, 0, 1);
    const ranged = (a: number, b: number) =>
      THREE.MathUtils.lerp(Math.min(a, b), Math.max(a, b), amount);
    chase.shake(ranged(tuning.shakeMin, tuning.shakeMax));
    vehicleAudio.carLanding(amount, ranged(tuning.soundMin, tuning.soundMax));
    carLandingPosition.set(landing.x, landing.y, landing.z);
    fx.carLandingPuff(
      carLandingPosition,
      landing.yaw,
      amount,
      Math.round(ranged(tuning.smokeMin, tuning.smokeMax)),
      ranged(tuning.smokeScaleMin, tuning.smokeScaleMax),
      tuning.smokeSpread,
      tuning.smokeLife
    );
  };

  // free-orbit inspection camera (C toggles); pointer lock is the game default
  const orbit = new CameraControls(camera, renderer.domElement);
  orbit.enabled = false;
  orbit.smoothTime = 0.12;
  orbit.draggingSmoothTime = 0.08;
  orbit.maxDistance = 1200;
  // O in camera mode: smoothstepped 180° azimuth flip around the current target
  let orbitFlip: {
    t: number;
    duration: number;
    startAz: number;
    delta: number;
    startDist: number;
    endDist: number;
  } | null = null;
  const orbitPickOrigin = new THREE.Vector3();
  const orbitPickDir = new THREE.Vector3();
  // Synthetic negative entity ids for busker pick proxies (stay clear of net ids).
  const BUSKER_PICK_ID = { ukulele: -901, handpan: -902, flute: -903 } as const;
  const BUSKER_BY_ENTITY: Record<number, keyof typeof BUSKER_PICK_ID> = {
    [BUSKER_PICK_ID.ukulele]: "ukulele",
    [BUSKER_PICK_ID.handpan]: "handpan",
    [BUSKER_PICK_ID.flute]: "flute"
  };
  const BUSKER_PICK_R = 0.65;

  const setViewMode = (mode: ViewMode) => {
    viewMode = mode;
    chase.manualFirstPerson = mode === "first";
    const orbitOn = mode === "orbit";
    input.suspended = orbitOn;
    orbit.enabled = orbitOn;
    if (orbitOn) {
      chase.suspend(player); // orbit owns the camera and should show the local avatar
      input.releaseLock();
      orbit.setLookAt(
        camera.position.x,
        camera.position.y,
        camera.position.z,
        player.position.x,
        player.position.y + 1.5,
        player.position.z,
        false
      );
      hud.message("Camera mode — drag to orbit, double-click to retarget, O for 180°, C to cycle", 3.5);
    } else {
      orbitFlip = null;
      hud.message(
        mode === "first"
          ? "First person — C cycles third / first / camera"
          : "Third person — C cycles third / first / camera",
        2.4
      );
      input.requestLock();
    }
  };
  const cycleViewMode = () => {
    const i = VIEW_CYCLE.indexOf(viewMode);
    setViewMode(VIEW_CYCLE[(i + 1) % VIEW_CYCLE.length]!);
  };
  leaveCameraModeForSurf = () => {
    if (viewMode === "orbit") setViewMode("third");
  };

  // Double-click any surface in camera mode → that point becomes the new orbit target
  // (camera stays put; orbit/dolly continue around the new look-at).
  // Busker hits snap to the musician's chest so the orbit centers on the singer.
  renderer.domElement.addEventListener("dblclick", (e) => {
    if (!inOrbit() || e.button !== 0) return;
    const rect = renderer.domElement.getBoundingClientRect();
    const ndcX = ((e.clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ndcY = -(((e.clientY - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    orbitPickOrigin.copy(camera.position);
    orbitPickDir.set(ndcX, ndcY, 0.5).unproject(camera).sub(orbitPickOrigin).normalize();
    const hit = worldQueries.raycast(orbitPickOrigin, orbitPickDir, 2500, { ignoreSelf: true });
    if (!hit) return;
    const buskerId = BUSKER_BY_ENTITY[hit.entityId];
    if (buskerId) {
      buskers.seatWorld(buskerId, orbitPickOrigin);
      void orbit.setTarget(orbitPickOrigin.x, orbitPickOrigin.y, orbitPickOrigin.z, true);
      return;
    }
    void orbit.setTarget(hit.point.x, hit.point.y, hit.point.z, true);
  });

  // Tab toggles the user UI — HUD + start panel fade in/out; pointer lock is independent
  let uiOpen = true;

  const showUi = () => {
    if (!uiOpen) {
      uiOpen = true;
      hud.setFaded(false);
    }
  };
  document.querySelector<HTMLButtonElement>("[data-ui-restore]")!.addEventListener("click", showUi);

  hud.setMode(player.mode);

  // post-processing: scene pass AA + optional stylized screen effects
  const pipeline = createRenderPipeline(renderer, scene, camera, sky.sun);

  // ---- multiplayer: presence relay (src/net/net.ts) + remote avatars +
  // minimap. Drop-in social layer: movement stays client-authoritative, the
  // server only relays poses, and losing the socket never breaks single-player.
  // Send a custom avatar only if the player actually chose one; a null avatar
  // lets the server keep its per-id seed (server.mjs), so un-customized players
  // stay distinct instead of all sending the same saved blob.
  const net = new Net(
    suggestedName,
    savedAvatar ?? undefined,
    savedBoard ?? undefined,
    savedScooter ?? undefined,
    savedSurfboard ?? undefined
  );
  const remotes = new RemotePlayers(scene);
  remotes.localPlayerPosition = () => player.renderPosition;
  setRemoteSurfboardAssetsActive = (active) => remotes.setSurfboardAssetsEnabled(active);
  // Startup/invite can enter surf before networking and its remote-art gate exist.
  setRemoteSurfboardAssetsActive(player.mode === "surf");
  // The controller statically owns every pickleball mesh, UI and audio class,
  // so even constructing an empty facade would pull the activity into boot.
  // It is installed together with the Goldman site on first approach.
  let pickleballController: PickleballController | null = null;
  const releaseGameplayForNavigation = () => {
    if (inOrbit()) setViewMode("third");
    pickleballController?.releaseForNavigation();
    golf?.abandonForNavigation(hud);
    archery?.releaseForNavigation(player);
  };
  const avatarSelector = new AvatarSelector(
    avatarTraits,
    net.name,
    (traits) => {
      avatarTraits = traits;
      customized = true; // an explicit edit — persist it and broadcast from here on
      saveAvatarTraits(traits);
      player.setAvatar(traits);
      net.setAvatar(traits);
    },
    (name) => {
      // rename from the avatar panel: net normalizes (blank / fun → a generated
      // fun name), then we reflect that back into the field.
      net.setName(name);
      avatarSelector.setName(net.name);
      hud.message(`You're now ${net.name}`, 2.2);
    }
  );
  // Hoverboard lab: pad moves preview only the live texture/audio graph; one
  // pointer-up commit persists and broadcasts. Audio-only edits skip the mesh
  // teardown entirely.
  const applyBoardConfig = (config: typeof boardConfig) => {
    const visualChanged = boardVisualKey(boardConfig) !== boardVisualKey(config);
    boardConfig = config;
    setLocalBoardConfig(config);
    if (visualChanged) player.setBoardConfig(config);
    vehicleAudio.setBoardStyle(config);
  };
  const boardSelector = new BoardSelector(
    boardConfig,
    (config) => {
      boardCustomized = true; // an explicit edit — persist it and broadcast from here on
      saveBoardConfig(config);
      applyBoardConfig(config);
      net.setBoard(config);
    },
    (config, kind) => {
      if (kind === "surface") player.previewBoardSurface(config);
      else vehicleAudio.setBoardStyle(config);
    },
    () => vehicleAudio.previewBoard(),
    () => {
      // The object being edited should always be on screen while the lab is open.
      if (player.mode !== "board" && !player.riding) player.trySwitch("board");
    }
  );
  const scooterSelector = new ScooterSelector(
    scooterConfig,
    (config) => {
      scooterCustomized = true;
      const changed = scooterKey(config) !== scooterKey(scooterConfig);
      scooterConfig = config;
      setLocalScooterConfig(config);
      saveScooterConfig(config);
      if (changed) player.setScooterConfig(config);
      net.setScooter(config);
    },
    () => {
      if (player.mode !== "scooter" && !player.riding) switchModeFromToolbar("scooter");
    }
  );
  const applySurfboardConfig = (config: SurfboardConfig) => {
    const changed = surfboardVisualKey(config) !== surfboardVisualKey(surfboardConfig);
    surfboardConfig = config;
    setLocalSurfboardConfig(config);
    if (changed) player.setSurfboardConfig(config);
    else player.previewSurfboardSurface(config);
  };
  let surfboardSelector: {
    setConfig(config: SurfboardConfig): void;
    setOpen(open: boolean): void;
    setVisible(visible: boolean): void;
  } | null = null;
  let surfboardSelectorLoading: Promise<void> | null = null;
  let openSurfboardSelectorAfterLoad = false;
  const surfboardLauncher = document.createElement("div");
  surfboardLauncher.className = "avatar-ui board-ui surfboard-ui surfboard-launcher-ui";
  const surfboardLauncherButton = document.createElement("button");
  surfboardLauncherButton.type = "button";
  surfboardLauncherButton.className = "avatar-toggle board-toggle surfboard-toggle";
  surfboardLauncherButton.title = "Open surfboard shaping room";
  surfboardLauncherButton.setAttribute("aria-label", "Open surfboard shaping room");
  surfboardLauncherButton.textContent = "🏄";
  surfboardLauncher.appendChild(surfboardLauncherButton);
  document.getElementById("hud")!.appendChild(surfboardLauncher);
  setSurfboardLauncherVisible = (visible) => {
    surfboardLauncher.hidden = !visible || surfboardSelector !== null;
  };
  setSurfboardCustomizerMode = (active) => {
    if (!active) openSurfboardSelectorAfterLoad = false;
    surfboardSelector?.setVisible(active);
  };
  surfboardLauncherButton.addEventListener("click", () => {
    input.releaseLock();
    ensureSurfboardCustomizer(true);
  });
  ensureSurfboardCustomizer = (open = false) => {
    if (open) openSurfboardSelectorAfterLoad = true;
    if (surfboardSelector) {
      if (open) surfboardSelector.setOpen(true);
      return;
    }
    if (surfboardSelectorLoading) return;
    surfboardSelectorLoading = import("./ui/surfboardSelector")
      .then(({ SurfboardSelector }) => {
        surfboardSelector = new SurfboardSelector(
          surfboardConfig,
          (config) => {
            surfboardCustomized = true;
            saveSurfboardConfig(config);
            applySurfboardConfig(config);
            net.setSurfboard(config);
          },
          (config) => player.previewSurfboardSurface(config),
          () => {}
        );
        surfboardLauncher.hidden = true;
        surfboardSelector.setVisible(player.mode === "surf");
        if (openSurfboardSelectorAfterLoad && player.mode === "surf") surfboardSelector.setOpen(true);
        openSurfboardSelectorAfterLoad = false;
      })
      .catch((error) => console.warn("[surf] shaping room failed to load", error))
      .finally(() => {
        surfboardSelectorLoading = null;
      });
  };
  setSurfboardLauncherVisible(player.mode === "surf");
  net.onWelcome = () => {
    avatarSelector.setName(net.name); // server may canonicalize a duplicate/invalid name
    if (customized) {
      net.setAvatar(avatarTraits); // re-assert my chosen look after a (re)connect
    } else {
      // adopt the server's per-id seed so my own body matches how everyone else
      // sees me, and reflect it in the editor
      avatarTraits = avatarFromSeed(net.selfId);
      player.setAvatar(avatarTraits);
      avatarSelector.setTraits(avatarTraits);
    }
    if (boardCustomized) {
      net.setBoard(boardConfig); // re-assert my chosen board after a (re)connect
    } else {
      const seeded = boardFromSeed(net.selfId);
      applyBoardConfig(seeded);
      boardSelector.setConfig(seeded);
    }
    if (scooterCustomized) {
      net.setScooter(scooterConfig);
    } else {
      scooterConfig = scooterFromSeed(net.selfId);
      setLocalScooterConfig(scooterConfig);
      player.setScooterConfig(scooterConfig);
      scooterSelector.setConfig(scooterConfig);
    }
    if (surfboardCustomized) {
      net.setSurfboard(surfboardConfig);
    } else {
      const seeded = surfboardFromSeed(net.selfId);
      applySurfboardConfig(seeded);
      surfboardSelector?.setConfig(seeded);
    }
    golf?.syncNetState();
    net.replayGolf();
    pickleballController?.onWelcome();
  };
  const syncRoster = () => {
    for (const info of net.roster.values()) {
      const existing = remotes.avatars.get(info.id);
      if (!existing) remotes.add(info);
      else {
        if (existing.info.name !== info.name) remotes.rename(info);
        remotes.updateAvatar(info);
        remotes.updateBoard(info);
        remotes.updateScooter(info);
        remotes.updateSurfboard(info);
      }
    }
    pickleballController?.syncSlots();
  };
  net.onRoster = syncRoster;
  net.onLeave = (id) => {
    remotes.remove(id);
    voice.drop(id);
    golf?.removeRemote(id);
  };
  net.onSample = (id, s) => remotes.sample(id, s);
  // someone else's paintball: same ballistic sim, their color, splats locally
  net.onPaint = (id, x, y, z, vx, vy, vz, rgb) => paintballs.spawn(x, y, z, vx, vy, vz, remotePaint.set(rgb), id);
  const remotePaint = new THREE.Color();
  // shared skies: my rocket launches go out, friends' volleys replay here
  fireworks.onVolley = (rockets) => net.sendFireworks(rockets);
  net.onFireworks = (_id, rockets) => fireworks.launchRemote(rockets);
  // ephemeral text chat (T to type) — fire-and-forget over the relay, no history.
  // Esc-blur must not re-lock (see Escape priority stack below); Enter-submit may.
  let skipChatRelock = false;
  // Constructed in the deferred loader; Escape stack checks .open when present.
  let behindTheScenes: { isOpen: boolean; setOpen(open: boolean): void } | null = null;
  const chat = new Chat(
    (text) => {
      chat.addMessage(net.name, text, true); // local echo (server doesn't bounce back to sender)
      net.sendChat(text);
    },
    (focused) => {
      if (focused) {
        input.releaseLock();
        return;
      }
      if (skipChatRelock) {
        skipChatRelock = false;
        return;
      }
      if (!inOrbit() && document.body.classList.contains("started") && !input.suspended) {
        input.requestLock();
      }
    }
  );
  net.onChat = (_id, name, text) => chat.addMessage(name, text);
  // golf: friends' swings/balls/scores replay here (owner-simulated snapshots)
  net.onGolf = (id, m) => golf?.handleNet(id, m, hud, net.roster.get(id)?.name ?? "Player");
  input.onLockChange = (locked) => {
    if (!locked && !inOrbit() && !input.freeCursor && !chat.focused) {
      hud.message("Click to capture the mouse · Esc releases it", 2.8);
    }
  };
  // passenger seat support: cars and scooters both publish a local seat anchor.
  remotes.localDriveMesh = () =>
    (player.mode === "drive" || player.mode === "scooter") && !player.riding ? player.meshes[player.mode] : null;

  // Passenger pose scratch; attachment ownership lives in EmbodimentController.
  const ridePos = new THREE.Vector3();
  const rideQuat = new THREE.Quaternion();

  // proximity voice chat: P2P audio spatialised onto the remote avatars,
  // signaled through the relay (src/net/voice.ts). Mic is opt-in — V key or
  // the HUD mic button — and fully released when off.
  const voice = new Voice(
    net,
    (id) => remotes.positionOf(id),
    () => player.position
  );
  voice.onSpeaking = (id, on) => remotes.setSpeaking(id, on);
  voice.onMicChange = (on) => {
    audioControls.setMic(on);
    hud.message(on ? "Mic live — nearby players can hear you" : "Mic off", 2.6);
  };
  const toggleMic = () => {
    void voice.setMic(!voice.micOn).then((ok) => {
      if (!ok) hud.message("Microphone blocked — check the browser permission", 3.5);
    });
  };
  audioControls.onMicToggle = toggleMic;
  net.onStatus = (status, detail) => {
    if (status === "online") {
      if (!paintColorTouched && !paintColorSeeded) {
        setColor(Math.max(0, net.selfId - 1) % PAINT_COLORS.length);
        paintColorSeeded = true;
      }
      hud.message(`Online as ${net.name} — M for the map`, 3.2);
    }
    else if (status === "full") hud.message(detail ?? "Server is full", 4);
    else if (status === "offline") {
      pickleballController?.onOffline();
      // Offline stays silent: the local AI match keeps working and Net retries.
    }
  };

  // Name gate is wired at module startup so typing works during loading; this
  // callback is attached once the game objects it needs exist.
  bootScreen.setStartHandler((typedName, opts) => {
    net.setName(typedName);
    avatarSelector.setName(net.name); // keep the avatar-panel field in step with the gate
    nameInput.blur(); // hand the keyboard back to the game
    document.body.classList.add("started"); // reveals the HUD (hidden behind the gate)
    loading.classList.add("done");
    // the submit click/Enter is the gesture pointer lock needs. A deep-link start
    // has no gesture (and opens a modal that frees the cursor anyway), so skip it.
    if (opts?.lock !== false) input.requestLock();
    // `invite` is declared further down boot; by the time a submit can happen
    // (Start enables at load's end) it's long initialized
    hud.message(
      invite?.from
        ? `Welcome, ${net.name} — you dropped in on ${invite.from}`
        : `Welcome to San Francisco, ${net.name}`,
      3.2
    );
  });

  const mapFwd = new THREE.Vector3();
  const minimap = new Minimap(
    map,
    () => {
      // facing from the active mesh (front is local -Z on every embodiment)
      mapFwd.set(0, 0, -1).applyQuaternion(player.meshes[player.mode].quaternion);
      return { name: net.name, x: player.position.x, z: player.position.z, fx: mapFwd.x, fz: mapFwd.z, hue: net.selfHue };
    },
    () => remotes.positions()
  );
  // The coarse surface mask already makes streets visible immediately. Upgrade
  // it with the exact shared graph as soon as the traffic load finishes.
  void roadGraphPromise.then((roads) => minimap.setRoadGraph(roads)).catch(() => {});
  minimap.addLandmark(GOLDMAN_GAMEPLAY_LANDMARK.x, GOLDMAN_GAMEPLAY_LANDMARK.z, "Goldman Tennis & Pickleball");
  // Archery range — NW corner of Golden Gate Park. Static known coords (the
  // site builds hidden behind its gate), so the pin is safe to drop even when
  // the range is asleep. Marks the field + gives a teleport like golf/tennis.
  minimap.addLandmark(ARCHERY_CENTER.x, ARCHERY_CENTER.z, "Archery Range");
  minimap.addLandmark(REVERIE_CENTER.x, REVERIE_CENTER.z, "Palace Reverie");
  // Ocean Beach surf break. Teleporting arrives on foot at the waterline;
  // one E press enters the live face already standing and moving.
  {
    const shore = oceanBeachShoreline(map, OCEAN_BEACH_SURF.entryZ, 3);
    minimap.addLandmark(shore.x, shore.z, "Ocean Beach · Surf");
  }
  minimap.addLandmark(LANDS_END_CENTER.x, LANDS_END_CENTER.z, "Lands End · Labyrinth");
  const playerLocator = new PlayerLocator();
  const worldArrival = new WorldArrivalCoordinator({
    input,
    player,
    chase,
    tiles,
    physics
  });
  // Background expansion waits for a quiet interval after every arrival. This
  // keeps nonessential region constructors, shader warmups and far-tile decodes
  // from competing with the destination's one-to-four visual cells.
  const WORLD_BACKGROUND_BOOT_QUIET_MS = 5000;
  const WORLD_BACKGROUND_AFTER_ARRIVAL_MS = 3000;
  const WORLD_BACKGROUND_AFTER_MOTION_MS = 1800;
  let worldBackgroundNotBefore = performance.now() + WORLD_BACKGROUND_BOOT_QUIET_MS;
  let worldBackgroundAdmissionAt = worldBackgroundNotBefore;
  const WORLD_BACKGROUND_STAGE_GAP_MS = 320;
  const WORLD_BACKGROUND_MOVEMENT_KEYS = [
    "KeyW", "KeyA", "KeyS", "KeyD",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "KeyQ", "KeyU", "ShiftLeft", "ShiftRight", "Space"
  ] as const;
  let worldBackgroundMotionX = player.position.x;
  let worldBackgroundMotionZ = player.position.z;
  const noteWorldBackgroundMotion = () => {
    if (worldArrival.active) return;
    const pad = input.mapPadAxes();
    const hasMovementIntent =
      WORLD_BACKGROUND_MOVEMENT_KEYS.some((code) => input.holding(code)) ||
      Math.abs(pad.lx) > 0.08 ||
      Math.abs(pad.ly) > 0.08 ||
      pad.lt > 0.08 ||
      pad.rt > 0.08;
    if (hasMovementIntent) {
      // A blocked wheel, a vehicle against a wall, or an airborne embodiment
      // can have near-zero displacement while the player is still actively
      // trying to move. Treat intent as activity too, so optional constructors
      // and WebGPU compilation never mistake that moment for idle time.
      worldBackgroundNotBefore = Math.max(
        worldBackgroundNotBefore,
        performance.now() + WORLD_BACKGROUND_AFTER_MOTION_MS
      );
      return;
    }
    if (Math.hypot(
      player.position.x - worldBackgroundMotionX,
      player.position.z - worldBackgroundMotionZ
    ) < 1.5) return;
    worldBackgroundMotionX = player.position.x;
    worldBackgroundMotionZ = player.position.z;
    worldBackgroundNotBefore = Math.max(
      worldBackgroundNotBefore,
      performance.now() + WORLD_BACKGROUND_AFTER_MOTION_MS
    );
  };
  worldArrival.onStateChange = (snapshot) => {
    if (snapshot.active) {
      worldBackgroundMotionX = player.position.x;
      worldBackgroundMotionZ = player.position.z;
      worldBackgroundNotBefore = performance.now() + WORLD_BACKGROUND_AFTER_ARRIVAL_MS;
    }
    // A runtime relocation owns its own named hold and supersedes the boot
    // collision epoch. Hand ownership over atomically so a forced slow boot can
    // never leave a stale boot hold pinned after the new destination is safe.
    const runtimeOwnsCommittedWorld =
      snapshot.state === "loading-visuals" ||
      snapshot.state === "visual-blocked" ||
      snapshot.state === "visually-ready" ||
      snapshot.state === "loading-collision" ||
      snapshot.state === "collision-blocked";
    if (runtimeOwnsCommittedWorld && !initialArrivalReleased) {
      initialArrivalReleased = true;
      player.releaseWorldArrivalHold("boot-arrival");
    }
  };
  const waitForWorldBackgroundWindow = async (extraQuietMs = 0): Promise<void> => {
    while (true) {
      const target = Math.max(worldBackgroundNotBefore + extraQuietMs, worldBackgroundAdmissionAt);
      if (!worldArrival.active && performance.now() >= target) {
        await new Promise<void>((resolve) => {
          if ("requestIdleCallback" in window) {
            window.requestIdleCallback(() => resolve(), { timeout: 1000 });
          } else {
            setTimeout(resolve, 80);
          }
        });
        if (
          !worldArrival.active &&
          performance.now() >= worldBackgroundNotBefore + extraQuietMs &&
          performance.now() >= worldBackgroundAdmissionAt
        ) {
          // Concurrent optional systems used to all wake from the same idle
          // callback and begin expensive constructors together. Admit one stage
          // at a time with a small presentation gap; quality is unchanged and
          // every stage still loads, just without a post-reveal thundering herd.
          worldBackgroundAdmissionAt = performance.now() + WORLD_BACKGROUND_STAGE_GAP_MS;
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          return;
        }
      }
      const remaining = Math.max(16, Math.min(100, target - performance.now()));
      await new Promise<void>((resolve) => setTimeout(resolve, remaining));
    }
  };
  const navigation = new NavigationController({
    player,
    hud,
    map,
    tiles,
    remotes,
    embodiments,
    arrival: worldArrival,
    releaseGameplay: releaseGameplayForNavigation
  });
  const applyPlaceHistory = (step: -1 | 1) => navigation.applyHistory(step);
  let surfEntryRequest = 0;
  const switchMode = (mode: PlayerMode) => {
    const request = ++surfEntryRequest;
    // Surf is an isolated activity context. Prevent number keys, toolbar clicks,
    // and d-pad travel cycling from silently swapping vehicles mid-wave; E/B is
    // the single clear exit back to the beach.
    if (player.mode === "surf" && mode !== "walk") {
      hud.message("E / B exits surfing — then choose another way to travel", 2.2);
      return;
    }
    if (mode === "surf") {
      void chase.ensureSurfCamera().then(() => {
        if (request === surfEntryRequest && player.mode !== "surf") navigation.switchMode("surf");
      });
      return;
    }
    navigation.switchMode(mode);
  };
  switchModeFromExit = switchMode;
  const teleportToTarget = (x: number, z: number, toName?: string, playerId?: number) =>
    navigation.teleportToTarget(x, z, toName, playerId);
  switchModeFromToolbar = switchMode;
  hud.onHistoryBack = () => applyPlaceHistory(-1);
  hud.onHistoryForward = () => applyPlaceHistory(1);
  minimap.onTeleport = teleportToTarget;
  minimap.onPlaceClick = (place) => {
    const layer = place.layer[0].toUpperCase() + place.layer.slice(1);
    hud.message(`${layer}: ${place.title}`, 2.4);
  };
  minimap.onExpandChange = (on) => {
    // The expanded map intentionally freezes the world. Do not let its mouse
    // affordance pause an otherwise healthy arrival before collision reaches
    // the local safety milestone. A fail-closed arrival may still open the map
    // to choose a replacement destination.
    if (
      on &&
      worldArrival.active &&
      worldArrival.snapshot.state !== "collision-blocked" &&
      worldArrival.snapshot.state !== "visual-blocked"
    ) {
      minimap.setExpanded(false);
      hud.message("Finishing the arrival…", 1.2);
      return;
    }
    input.suspended = on || inOrbit(); // camera mode owns suspension when the map closes
    // Open always frees the pointer. Collapse does not re-lock here — Esc-dismiss
    // must leave the cursor free; M-toggle re-locks in the tick below.
    if (on) input.releaseLock();
  };
  input.onDeviceChange = (device) => {
    hud.setDevice(device);
    minimap.setDevice(device);
  };
  minimap.setDevice(input.device);

  // Escape priority: dismiss an open overlay (stay unlocked) → else release pointer
  // lock. Stops the old "Esc closes UI and immediately re-locks" double-tap.
  // Registered after minimap exists so an early Esc can't hit a TDZ binding.
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.code !== "Escape" && e.key !== "Escape") || e.repeat) return;
      // Input owns this invariant in an earlier capture listener. Keep this
      // idempotent call here too so UI routing can never precede the unlock.
      input.releaseLock();
      const t = e.target;
      // Debug search / other fields keep their own Esc behavior.
      if (
        (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) &&
        !chat.focused
      ) {
        return;
      }
      if (missionDolores?.bookOpen) {
        missionDolores.closeBook();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (behindTheScenes?.isOpen) {
        behindTheScenes.setOpen(false);
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (minimap.expanded) {
        minimap.setExpanded(false);
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      if (chat.focused) {
        skipChatRelock = true;
        chat.blur();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // Lock already released above; don't preventDefault so the UA default
      // unlock still runs if exitPointerLock is ignored.
    },
    true
  );
  // Fullscreen Esc often exits fullscreen first and leaves pointer lock on —
  // drop the lock whenever fullscreen ends so one Esc is enough.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) input.releaseLock();
  });

  // interactive tutorial (ui/tutorial.ts): the 🎓 button under Share starts a
  // chaptered walkthrough — movement, entering buildings, vehicles, and the map.
  // It only reads through this thin context; one-shot events (teleports) arrive
  // via tutorial.note().
  const tutorial = new Tutorial({
    mode: () => player.mode,
    pos: () => player.position,
    mouseDelta: () => Math.abs(input.mouseDX) + Math.abs(input.mouseDY),
    down: (c) => input.down(c),
    pressed: (c) => input.pressed(c),
    mapOpen: () => minimap.expanded,
    teleport: (t) => navigation.teleportToPose(t),
    message: (m, s) => hud.message(m, s)
  });
  navigation.onTeleported = () => tutorial.note("teleport");


  const diagnostics = new RendererDiagnostics(renderer);
  // "/" toggles all debug UI: this tuning panel + the three.js inspector together
  const debugPanel = new DebugPanel(
    renderer,
    sky,
    () => input.releaseLock(),
    fireworks,
    tiles,
    scene,
    pipeline,
    setFoliageVisible,
    () => wildlands?.flowers.refresh(),
    () => wildlands?.grass.refresh(),
    () => diagnostics.toggleInspector()
  );
  debugPanel.setMode(player.mode);

  // Ocean Beach ambient life is an optional, fully procedural chunk. Resolve
  // its anchor against the real shoreline now (cheap), but do not request its
  // person/cloth/behavior code until a post-reveal approach. Loading well before
  // the encounter's own wake radius leaves time for detached WebGPU compilation.
  const oceanKiteSite = oceanBeachShoreline(map, OCEAN_BEACH_SURF.entryZ + 45, 20);
  const OCEAN_KITE_LOAD_DISTANCE = 650;
  let oceanBeachKite: import("./world/oceanBeachKite").OceanBeachKiteEncounter | null = null;
  let oceanBeachKiteLoading: Promise<void> | null = null;
  let unregisterOceanKiteTuning: (() => void) | null = null;
  let oceanKiteGeneration = 0;
  const refreshOceanKiteDebug = () => {
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) Object.assign(hooks, { oceanBeachKite, ensureOceanBeachKite });
  };
  const ensureOceanBeachKite = () => {
    if (oceanBeachKite || oceanBeachKiteLoading) return oceanBeachKiteLoading ?? Promise.resolve();
    const generation = oceanKiteGeneration;
    const loading = import("./world/oceanBeachKite")
      .then(async ({ createOceanBeachKiteEncounter }) => {
        if (generation !== oceanKiteGeneration) return;
        const distance = Math.hypot(
          player.position.x - oceanKiteSite.x,
          player.position.z - oceanKiteSite.z
        );
        // The player can teleport away while the split chunk is in flight.
        if (distance > OCEAN_KITE_LOAD_DISTANCE) return;
        const encounter = createOceanBeachKiteEncounter(map, oceanKiteSite);
        // compileAsync skips invisible roots. Prepare the feature while detached,
        // and temporarily un-cull its descendants so an approach from outside
        // the current camera frustum still warms the rig and node cloth.
        encounter.group.visible = true;
        const culling = new Map<THREE.Object3D, boolean>();
        encounter.group.traverse((object) => {
          culling.set(object, object.frustumCulled);
          object.frustumCulled = false;
        });
        try {
          await renderer.compileAsync(encounter.group, camera, scene);
        } catch (error) {
          console.warn("[ocean kite] detached shader warmup failed", error);
        } finally {
          for (const [object, frustumCulled] of culling) object.frustumCulled = frustumCulled;
        }
        if (generation !== oceanKiteGeneration) {
          encounter.dispose();
          return;
        }
        const stillNear = Math.hypot(
          player.position.x - oceanKiteSite.x,
          player.position.z - oceanKiteSite.z
        ) <= OCEAN_KITE_LOAD_DISTANCE;
        if (!stillNear) {
          encounter.dispose();
          return;
        }
        encounter.group.visible = false;
        scene.add(encounter.group);
        oceanBeachKite = encounter;
        unregisterOceanKiteTuning = debugPanel.registerFeatureTuning(encounter.tuningDescriptor());
        refreshOceanKiteDebug();
      })
      .catch((error) => console.warn("[ocean kite] encounter failed to load", error))
      .finally(() => {
        if (oceanBeachKiteLoading === loading) oceanBeachKiteLoading = null;
      });
    oceanBeachKiteLoading = loading;
    return loading;
  };
  const disposeOceanBeachKite = () => {
    oceanKiteGeneration++;
    unregisterOceanKiteTuning?.();
    unregisterOceanKiteTuning = null;
    oceanBeachKite?.dispose();
    oceanBeachKite = null;
    refreshOceanKiteDebug();
  };
  import.meta.hot?.dispose(disposeOceanBeachKite);

  // Resume last session: position, heading and vehicle survive a refresh. A
  // Vite structural reload additionally restores the exact chase-camera view.
  // (after the debug panel exists — restoreState can fire onModeChange).
  // An invite link wins over the saved session — the click's intent is explicit.
  if (resumed) {
    if (resumed.mode === "surf") await chase.ensureSurfCamera();
    player.restoreState(resumed);
    modeDiscovery.discover(resumed.mode);
    chase.yaw = devReload?.camera.yaw ?? resumed.heading + Math.PI;
    if (devReload) {
      chase.pitch = devReload.camera.pitch;
      chase.zoom = devReload.camera.zoom;
      (window as unknown as { __sfDevReloadRestored?: boolean }).__sfDevReloadRestored = true;
    }
    chase.cutTo(player);
    if (import.meta.env.DEV) console.log("[sf] resumed session", resumed);
  }
  if (invite) {
    let mode = invite.mode;
    if (invite.animal) {
      embodiments.currentAnimal = invite.animal;
      if (forest && ANIMALS && invite.animal) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const animalEntry: any = ANIMALS[invite.animal];
        player.setDriveStyle(forest.buildRiddenMesh(invite.animal), animalEntry?.spec);
      }
      mode = "drive";
    }
    // land to the sharer's right so nobody spawns inside anybody — wider for
    // the big embodiments (a boat is 9 m long, planes bank wide)
    const side = mode === "boat" || mode === "plane" ? 7 : mode === "drive" ? 4 : 2.5;
    const jx = invite.x + Math.cos(invite.facing) * side;
    const jz = invite.z - Math.sin(invite.facing) * side;
    if (mode === "surf") await chase.ensureSurfCamera();
    player.teleportTo({ x: jx, y: invite.y, z: jz, facing: invite.facing, mode });
    chase.yaw = invite.facing;
    chase.cutTo(player);
    // one-shot: strip the params so a refresh resumes the session instead of
    // re-teleporting (the 1 Hz session save takes over from here)
    const q = new URLSearchParams(location.search);
    q.delete("j");
    q.delete("via");
    history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : ""));
    if (import.meta.env.DEV) console.log("[sf] joined via invite", invite);
  }
  // Seed every first visible frame at the final player pose. Fresh sessions use
  // this too; otherwise a fast cached boot can briefly expose the old 20/30 m
  // camera seed damping toward the avatar.
  chase.cutTo(player);

  // Controllers, saved sessions, and invite embodiment restoration can all
  // adjust the authoritative X/Z after the overlapped early prime began. Never
  // reveal or release against the provisional spawn: supersede both streams
  // from the actual held body with the same generic path used at runtime.
  if (Math.hypot(
    player.position.x - initialVisualFocus.x,
    player.position.z - initialVisualFocus.z
  ) >= 1) {
    primeInitialVisualAt(player.position.x, player.position.z);
    initialCollisionEpoch = physics.prepareCollisionArrival(player.position);
    if (!physics.activateCollisionArrival(initialCollisionEpoch)) {
      throw new Error("Initial collision destination was superseded before activation");
    }
    initialCollisionReady = false;
    initialCollisionRetryCycles = 0;
    initialCollisionFailureReported = false;
    initialVisualFailureReported = false;
  }

  // Share button (top-right): copy an invite link that reproduces where I am
  // right now — position, facing, mode, and the ridden animal if I'm on one
  const buildShareUrl = () => {
    const facing = player.heading - Math.PI; // player.heading stores facing+π
    const parts = [
      player.position.x.toFixed(1),
      player.position.y.toFixed(1),
      player.position.z.toFixed(1),
      facing.toFixed(2),
      player.riding ? "walk" : player.mode // a passenger's friend joins on foot beside the car
    ];
    if (!player.riding && player.mode === "drive" && embodiments.currentAnimal) parts.push(embodiments.currentAnimal);
    return `${location.origin}${location.pathname}?j=${parts.join(",")}&via=${encodeURIComponent(net.name)}`;
  };
  new ShareButton(buildShareUrl, (ok) =>
    hud.message(ok ? "Invite link copied — send it to a friend" : "Couldn't copy the link", 3.2)
  );

  // "Behind the scenes" overlay + X/GitHub links (top-right, under Tutorial).
  // Free the pointer lock while it's open so the cursor can reach the links.
  // While it's open the whole world stops rendering (see `btsReading` in tick)
  // and the frozen canvas dims a touch, so no live frames flicker behind the read.
  // Esc-dismiss stays unlocked (click to capture); see Escape priority stack.
  let btsReading = false;
  // BehindTheScenes is constructed after progress(100) in the deferred loader

  // collider x-ray overlay (debug: "/" → collider x-ray). Off unless toggled;
  // the tick gathers active colliders and drives it. Scratch arrays reused so an
  // enabled overlay allocates nothing per frame.
  const colliderDebug = new ColliderDebug(scene);
  // grey-card calibration chart ("/" → advanced → lighting → grey cards): a
  // camera-locked row of known-albedo spheres for reading the tone grade.
  const calibrationChart = new CalibrationChart(scene);
  const colliderBoxes: DebugBox[] = [];
  const colliderMeshes: DebugMesh[] = [];
  const dbgBaked: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; index: boolean }[] = [];
  const dbgWalls: ColliderBox[] = [];
  const dbgInteriors: ColliderBox[] = [];
  const dbgRoofs: ColliderMesh[] = [];
  const syncColliderDebug = () => {
    const on = Boolean(RENDER_TUNING.values.colliderDebug);
    if (on !== colliderDebug.visible) colliderDebug.setVisible(on);
    if (!on) return;
    colliderBoxes.length = 0;
    colliderMeshes.length = 0;
    physics.debugBuildingBodies(dbgBaked);
    for (const b of dbgBaked) {
      // red = baked visual-tile body, orange = citywide-index body
      colliderBoxes.push({ ...b, r: 1, g: b.index ? 0.55 : 0.12, b: 0.12 });
    }
    if (citygenRing.current) {
      citygenRing.current.debugColliders(dbgWalls, dbgInteriors, dbgRoofs);
      for (const c of dbgWalls) colliderBoxes.push({ ...c, r: 0.15, g: 1, b: 0.3 });      // green = walk-in wall
      for (const c of dbgInteriors) colliderBoxes.push({ ...c, r: 0.25, g: 0.55, b: 1 }); // blue = interior
      for (const c of dbgRoofs) colliderMeshes.push({ ...c, r: 0.15, g: 1, b: 0.3 });      // green = walk-in roof
    }
    colliderDebug.sync(colliderBoxes, colliderMeshes);
  };

  const aim = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3(); // aimOrigin returns a shared tmp — keep our own copy
  // The interaction ray. Normally it's the centre-screen aim; while the free
  // cursor is out (Command held) it's the camera-through-mouse ray instead, so
  // clicks and the hover glow track wherever the loose orb is pointing.
  const aimRay = (origin: THREE.Vector3, dir: THREE.Vector3) => {
    if (input.freeCursor) {
      origin.copy(camera.position);
      dir.set(input.mouseNDCx, input.mouseNDCy, 0.5).unproject(camera).sub(camera.position).normalize();
    } else {
      chase.interactionDir(dir, player);
      chase.viewOrigin(origin, player);
    }
  };
  const cursorPos = new THREE.Vector3(); // where the world cursor rests this frame
  // Every raycastable world entity gets a proxy in the shared query world. This
  // keyed set is synced once per frame (begin → put per live entity → end); the
  // cursor and paintballs then just query worldQueries. Grass/flowers never join.
  const entityProxies = new ProxySet(worldQueries);
  const paintDir = new THREE.Vector3();
  const paintVel = new THREE.Vector3();
  const paintMuzzle = new THREE.Vector3();
  const paintTmp = new THREE.Vector3();
  // hit spheres for paint-vs-player, per embodiment: radius + centre lift
  const PAINT_HIT: Record<PlayerMode, { r: number; y: number }> = {
    walk: { r: 1.05, y: 0.95 },
    scooter: { r: 1.45, y: 1.05 },
    board: { r: 1.15, y: 1.0 },
    surf: { r: 1.35, y: 1.0 },
    drive: { r: 2.3, y: 0.8 },
    plane: { r: 3.2, y: 1.0 },
    boat: { r: 4.5, y: 1.8 },
    speedboat: { r: 3.2, y: 1.2 },
    drone: { r: 0.9, y: 0.3 },
    bird: { r: 3.0, y: 1.5 }
  };

  let fireCooldown = 0;
  // pre-throw chase zoom, captured while the ball windup pulls the boom in over
  // the shoulder so it can be restored afterward (−1 = not pulled in).
  let throwZoomBase = -1;

  // Warm only the render path the first frame actually uses. Optional modes,
  // debug overlays, tools, particles, underwater rendering, and audio remain
  // behind their first-use gates instead of taxing every new visitor.
  bootMark("world");
  progress(88, "warming the first view");
  sky.update(0, camera.position, player.renderPosition);
  syncBallGlowNight(sky.sunElevation);
  player.warmup();
  // Initialize render-target contents and the contact-shadow pass once before
  // warmup temporarily freezes render-scoped updates. Without this covered
  // frame, a production WebGPU build can retain an uninitialized (black)
  // contact/output target even though subsequent scene submissions succeed.
  renderFrame();
  await pipeline.warmup("boot");
  bootMark("warmup");
  // One frame flushes the covered compile submission without an arbitrary wait.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  // Optional modules remain in separate chunks and start only after the local
  // baked neighborhood is visible plus one browser-idle opportunity. They never
  // compete with the first frame or hold the Start button.
  progress(92, "finishing the neighborhood");
  // Optional modules stream independently and never gate first play.
  let modulesReady = true;
  // Resolves the instant the loading cover lifts. Any heavy region the spawn
  // doesn't gate waits on this and builds post-reveal (hidden → compileAsync →
  // visible) so it never delays first play — the "load the trees when you go
  // there" idea, generalized across garden / wildlands / golf.
  let resolveRevealed!: () => void;
  const revealedPromise = new Promise<void>((r) => {
    resolveRevealed = r;
  });
  // Expand from the fixed-quality local boot bubble to the normal city radius
  // only after the first view has had a quiet beat. Asset quality is unchanged;
  // this merely stops unseen origin districts from occupying destination slots.
  void revealedPromise.then(async () => {
    await waitForWorldBackgroundWindow();
    if (player.mode === "surf") {
      // Surf's explicit 2 km mode cap remains active; only its restore target is
      // the normal full radius.
      if (surfCullStash) {
        surfCullStash.load = fullTileRadius;
        surfCullStash.unload = fullTileRadius + 400;
      }
    } else {
      CONFIG.tileLoadRadius = fullTileRadius;
      CONFIG.tileUnloadRadius = fullTileRadius + 400;
    }
    tiles.forceScan();
  });
  void revealedPromise.then(async () => {
    await waitForWorldBackgroundWindow(1800);
    islands.armVegetation(scene, async (group) => {
      await waitForWorldBackgroundWindow(1800);
      try {
        await renderer.compileAsync(group, camera, scene);
      } catch (err) {
        console.warn("[islands] deferred vegetation compile failed:", err);
      }
    });
  });
  // Generic proximity gates: every starting point follows the same rule. After
  // first reveal, nearby optional regions may hydrate; distant ones wait for
  // first approach. NEAR_GATE is metres from each region's footprint.
  const NEAR_GATE = 1300;
  const GARDEN_XZ = {
    x: (BOTANICAL_GARDEN_BOUNDS.minX + BOTANICAL_GARDEN_BOUNDS.maxX) / 2,
    z: (BOTANICAL_GARDEN_BOUNDS.minZ + BOTANICAL_GARDEN_BOUNDS.maxZ) / 2
  };
  const GOLF_XZ = { x: -1979, z: -194 }; // Presidio course centroid (golf.json tee coords)

  // Landmark + minigame map pins are registered EAGERLY at boot from static
  // coords, independent of the lazy region builds — the pin is always on the map
  // and clickable (teleport), while the heavy assets stream in only when you
  // approach or teleport there. Names dedupe, so a lazy build re-adding the same
  // name just refines the pin's coords (e.g. golf snaps to the first tee on load).
  minimap.addLandmark(JAPANESE_TEA_GARDEN_ENTRANCE.x, JAPANESE_TEA_GARDEN_ENTRANCE.z, "Japanese Tea Garden");
  minimap.addLandmark(GARDEN_XZ.x, GARDEN_XZ.z, "Botanical Garden");
  minimap.addLandmark(GOLF_XZ.x, GOLF_XZ.z, "Presidio Golf");
  minimap.addLandmark(CORONA_HEIGHTS_SUMMIT.x, CORONA_HEIGHTS_SUMMIT.z, "Corona Heights");
  // Buena Vista summit clearing — west of Corona Heights. Static pin so the
  // quest stays findable even if the site-gated experience fails to boot.
  minimap.addLandmark(AFTERLIGHT_ARRIVAL.x, AFTERLIGHT_ARRIVAL.z, "Afterlight");
  const missionDoloresSpawn = SPAWN_POINTS.missionDolores;
  minimap.addLandmark(missionDoloresSpawn.x, missionDoloresSpawn.z, missionDoloresSpawn.label);

  // Authored sites share one first-approach policy: keep only lightweight
  // coordinates at boot, request one site at a time after reveal, and re-check
  // the destination after the arrival-quiet window before evaluating its chunk.
  // The radius is deliberately generic; visual quality and each site's own LOD
  // remain untouched once the exact same authored root is attached.
  type OptionalSiteId = "goldman" | "archery" | "palace" | "afterlight" | "corona" | "lands-end";
  type OptionalSiteState = "dormant" | "queued" | "loading" | "ready" | "failed";
  type OptionalWorldSite = {
    id: OptionalSiteId;
    label: string;
    x: number;
    z: number;
    state: OptionalSiteState;
    forced: boolean;
    promise: Promise<void> | null;
    load: () => Promise<void>;
  };
  const OPTIONAL_SITE_APPROACH_RADIUS = 1100;
  const OPTIONAL_SITE_RECHECK_RADIUS = OPTIONAL_SITE_APPROACH_RADIUS * 1.25;
  const waitForOptionalSiteStage = () => waitForWorldBackgroundWindow(700);

  const refreshOptionalSiteDebug = () => {
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (!hooks) return;
    Object.assign(hooks, {
      goldenGateTennis,
      pickleballController,
      pickleball: pickleballController?.game ?? null,
      pickleballAmbient: pickleballController?.ambient ?? null,
      pickleballAudio: pickleballController?.audio ?? null,
      pickleballUI: pickleballController?.ui ?? null,
      archery,
      palaceReverie,
      afterlight,
      coronaHeights,
      landsEnd
    });
  };

  const prepareOptionalRoot = async (label: string, root: THREE.Object3D): Promise<void> => {
    const parent = root.parent;
    const renderState: Array<{ object: THREE.Object3D; visible: boolean; frustumCulled: boolean }> = [];
    root.removeFromParent();
    root.traverse((object) => {
      renderState.push({ object, visible: object.visible, frustumCulled: object.frustumCulled });
      object.visible = true;
      object.frustumCulled = false;
    });
    root.updateMatrixWorld(true);
    try {
      // Construction can outlast the idle decision that admitted it. Keep the
      // subtree detached and re-check movement/arrival quiet immediately before
      // asking the WebGPU driver for pipelines.
      await waitForOptionalSiteStage();
      await renderer.compileAsync(root, camera, scene);
    } catch (error) {
      // Compilation is a presentation optimization, never a reason to discard
      // a successfully constructed site. The normal first render remains valid.
      console.warn(`[${label}] deferred compile failed:`, error);
    } finally {
      for (const state of renderState) {
        state.object.visible = state.visible;
        state.object.frustumCulled = state.frustumCulled;
      }
      parent?.add(root);
    }
  };

  const loadGoldman = async (): Promise<void> => {
    const { createGoldenGateTennisSite } = await import("./world/goldenGateTennis");
    await waitForOptionalSiteStage();
    let site: GoldenGateTennisSite | null = null;
    let suppressed = false;
    try {
      site = createGoldenGateTennisSite(map, {
        physics,
        daylight: () => sky.sunElevation > 0
      });
      await prepareOptionalRoot("goldman", site.group);
      // Swap the generic clubhouse only when its authored replacement is ready
      // to attach. Any failure restores the baked fallback immediately.
      for (const building of GOLDMAN_SUPPRESSED_BUILDINGS) {
        tiles.suppressBuildingMesh(building.key, building.index);
      }
      suppressed = true;
      site.addTo(scene);
      site.setFoliageVisible(foliageOn);
      goldenGateTennis = site;
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    } catch (error) {
      site?.dispose();
      if (suppressed) {
        for (const building of GOLDMAN_SUPPRESSED_BUILDINGS) {
          tiles.unsuppressBuildingMesh(building.key, building.index);
        }
      }
      throw error;
    }

    // Pickleball is coupled to the site's dynamic court anchors, but it gets a
    // second idle boundary so its athletes, UI and audio never pile onto the
    // authored-site construction task.
    try {
      await waitForOptionalSiteStage();
      const { PickleballController: LoadedPickleballController } = await import("./app/systems/pickleball");
      await waitForOptionalSiteStage();
      const controller = new LoadedPickleballController({
        goldman: site,
        scene,
        nature,
        daylight: () => sky.sunElevation > 0.05,
        fx,
        siteGate,
        net,
        player,
        input,
        hud,
        chase,
        remotes,
        embodiments,
        getAvatar: () => avatarTraits
      });
      pickleballController = controller;
      try {
        await waitForOptionalSiteStage();
        await controller.prepareRender(renderer, camera, scene);
      } catch (error) {
        console.warn("[pickleball] deferred compile failed:", error);
      }
      if (net.status === "online") controller.onWelcome();
      else controller.syncSlots();
      refreshOptionalSiteDebug();
    } catch (error) {
      console.warn("[pickleball] first-approach construction failed:", error);
    }
  };

  const loadArchery = async (): Promise<void> => {
    const { createArchery } = await import("./gameplay/archery");
    await waitForOptionalSiteStage();
    const game = createArchery(map, physics, worldQueries, scene, {
      nature,
      daylight: () => sky.sunElevation > 0.05
    });
    await prepareOptionalRoot("archery", game.root);
    archery = game;
    siteGate.register(game.siteHooks());
    refreshOptionalSiteDebug();
  };

  const loadPalace = async (): Promise<void> => {
    const { createPalaceReverie } = await import("./gameplay/palaceReverie");
    await waitForOptionalSiteStage();
    const game = createPalaceReverie(map, scene);
    await prepareOptionalRoot("palace-reverie", game.root);
    palaceReverie = game;
    siteGate.register(game.siteHooks());
    refreshOptionalSiteDebug();
  };

  const loadAfterlight = async (): Promise<void> => {
    const { createAfterlight } = await import("./gameplay/afterlight");
    await waitForOptionalSiteStage();
    const experience = createAfterlight(map, scene, nature);
    await experience.ready;
    // prepareWarmup exposes every authored state; detach immediately so none of
    // those temporary states can flash into a live frame while WebGPU compiles.
    const restore = experience.prepareWarmup();
    experience.root.removeFromParent();
    experience.root.updateMatrixWorld(true);
    try {
      await waitForOptionalSiteStage();
      await renderer.compileAsync(experience.root, camera, scene);
    } catch (error) {
      console.warn("[afterlight] deferred compile failed:", error);
    } finally {
      restore();
    }
    afterlight = experience;
    siteGate.register(experience.siteHooks());
    refreshOptionalSiteDebug();
  };

  const loadCorona = async (): Promise<void> => {
    const { CoronaHeightsPark: LoadedCoronaHeightsPark } = await import("./world/coronaHeights");
    await waitForOptionalSiteStage();
    const park = new LoadedCoronaHeightsPark(map, physics);
    park.prepareFoliage = async (group) => {
      await waitForOptionalSiteStage();
      await prepareOptionalRoot("corona-heights foliage", group);
    };
    await prepareOptionalRoot("corona-heights", park.group);
    park.setFoliageVisible(foliageOn);
    park.onDogAudioCue = (dog, cue) => dogParkAudio.cue(dog, cue);
    coronaHeights = park;
    scene.add(park.group);
    sky.invalidateStaticShadows();
    refreshOptionalSiteDebug();
  };

  const loadLandsEnd = async (): Promise<void> => {
    const { LandsEndRegion: LoadedLandsEndRegion } = await import("./world/landsEnd");
    await waitForOptionalSiteStage();
    const region = new LoadedLandsEndRegion(map);
    await prepareOptionalRoot("lands-end", region.group);
    region.setFoliageVisible(foliageOn);
    landsEnd = region;
    scene.add(region.group);
    sky.invalidateStaticShadows();
    refreshOptionalSiteDebug();
  };

  const optionalWorldSites: OptionalWorldSite[] = [
    {
      id: "goldman",
      label: "Goldman Tennis Center",
      x: GOLDMAN_SITE_CENTER.x,
      z: GOLDMAN_SITE_CENTER.z,
      state: "dormant",
      forced: false,
      promise: null,
      load: loadGoldman
    },
    { id: "archery", label: "Archery Range", ...ARCHERY_CENTER, state: "dormant", forced: false, promise: null, load: loadArchery },
    { id: "palace", label: "Palace Reverie", ...REVERIE_CENTER, state: "dormant", forced: false, promise: null, load: loadPalace },
    { id: "afterlight", label: "Afterlight", ...AFTERLIGHT_ARRIVAL, state: "dormant", forced: false, promise: null, load: loadAfterlight },
    { id: "corona", label: "Corona Heights", ...CORONA_HEIGHTS_SUMMIT, state: "dormant", forced: false, promise: null, load: loadCorona },
    { id: "lands-end", label: "Lands End", ...LANDS_END_CENTER, state: "dormant", forced: false, promise: null, load: loadLandsEnd }
  ];
  let optionalSiteQueue: Promise<void> = Promise.resolve();

  const requestOptionalWorldSite = (site: OptionalWorldSite, forced = false): Promise<void> => {
    site.forced ||= forced;
    if (site.state === "ready" || site.state === "failed") return site.promise ?? Promise.resolve();
    if (site.promise) return site.promise;
    site.state = "queued";
    const run = optionalSiteQueue.then(async () => {
      await revealedPromise;
      await waitForOptionalSiteStage();
      const distance = Math.hypot(player.position.x - site.x, player.position.z - site.z);
      if (!site.forced && distance > OPTIONAL_SITE_RECHECK_RADIUS) {
        site.state = "dormant";
        site.forced = false;
        return;
      }
      site.state = "loading";
      await site.load();
      site.state = "ready";
      console.info(`[lazy-site] ${site.label} ready`);
    }).catch((error) => {
      site.state = "failed";
      console.warn(`[lazy-site] ${site.label} unavailable:`, error);
    });
    site.promise = run.finally(() => {
      if (site.state === "dormant") site.promise = null;
    });
    optionalSiteQueue = site.promise;
    return site.promise;
  };

  const ensureOptionalWorldSite = (id: OptionalSiteId): Promise<void> => {
    const site = optionalWorldSites.find((candidate) => candidate.id === id);
    return site ? requestOptionalWorldSite(site, true) : Promise.resolve();
  };

  const updateOptionalWorldSites = (): void => {
    if (!revealed || worldArrival.active) return;
    if (optionalWorldSites.some((site) => site.state === "queued" || site.state === "loading")) return;
    let nearest: OptionalWorldSite | null = null;
    let nearestDistanceSq = OPTIONAL_SITE_APPROACH_RADIUS * OPTIONAL_SITE_APPROACH_RADIUS;
    for (const site of optionalWorldSites) {
      if (site.state !== "dormant") continue;
      const dx = player.position.x - site.x;
      const dz = player.position.z - site.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq <= nearestDistanceSq) {
        nearest = site;
        nearestDistanceSq = distanceSq;
      }
    }
    if (nearest) void requestOptionalWorldSite(nearest);
  };

  const touchesBounds = (
    x: number,
    z: number,
    reach: number,
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number }
  ): boolean =>
    x >= bounds.minX - reach && x <= bounds.maxX + reach &&
    z >= bounds.minZ - reach && z <= bounds.maxZ + reach;
  const nearPrimaryWildRegion = (x: number, z: number, reach: number): boolean =>
    WILD_REGIONS.some((region) =>
      region.id !== "buenavista" && touchesBounds(x, z, reach, region)
    );
  const nearBuenaVista = (x: number, z: number, reach: number): boolean =>
    touchesBounds(x, z, reach, BUENA_VISTA_REGION);
  const nearRegionByDistance = (r: RegionKey): boolean => {
    const p = player.position;
    if (r === "garden") return Math.hypot(p.x - GARDEN_XZ.x, p.z - GARDEN_XZ.z) < NEAR_GATE;
    if (r === "golf") return Math.hypot(p.x - GOLF_XZ.x, p.z - GOLF_XZ.z) < NEAR_GATE;
    return nearPrimaryWildRegion(p.x, p.z, NEAR_GATE);
  };
  const regionGates = (r: RegionKey): boolean => nearRegionByDistance(r);
  // Wildlands' groundcover/tree masks depend on the golf course footprint, so
  // the pair always builds together and in the same order (course data → grove
  // masks → course meshes), gating iff EITHER is near.
  const gardenGates = regionGates("garden");
  const buenaVistaGates = nearBuenaVista(player.position.x, player.position.z, NEAR_GATE);
  const wildlandsGolfGates = regionGates("wildlands") || regionGates("golf");
  void (async () => {
    // Optional regions, activities and CityGen enhancement cannot compete with
    // the local first frame. Baked city/terrain remain the complete fallback;
    // this layer begins only after reveal and one browser idle opportunity.
    await revealedPromise;
    await waitForWorldBackgroundWindow(1800);

    // CityGen improves every district, so start it before fauna and authored
    // sites. Ingestion may outlive the idle window that admitted it; the hook
    // re-enters that gate before an async reply constructs Three/WebGPU owners.
    const citygenMod = await import("./world/citygen");
    await waitForWorldBackgroundWindow(1800);
    try {
      citygenRing.current = await citygenMod.createCityGenRing(
        { excludeBuilding: isTeaGardenBuilding },
        {
          scene,
          physics,
          map,
          tiles,
          schedule: scheduler.schedule,
          beforeRenderOwnership: () => waitForWorldBackgroundWindow(),
          // The ring keeps these exact owners detached and submits them one at
          // a time, re-entering the quiet gate before every compile. It is not
          // published until every exterior driving variant is prepared.
          prepareRenderOwner: (owner) => renderer.compileAsync(owner, camera, scene)
        }
      );
    } catch (error) {
      // CityGen is an enhancement over the complete baked city. A failed
      // exterior compile must not publish a half-warm owner or abort the other
      // deferred world modules.
      console.warn("[citygen] exterior preparation failed — retaining baked city", error);
      citygenRing.current = null;
    }
    // Legacy procedural-spawn probes opt in explicitly. Normal visitors never
    // fetch or construct this duplicate material/render pack.
    if (new URLSearchParams(location.search).has("citygendemo")) {
      await waitForWorldBackgroundWindow();
      const citygenDemoMod = await import("./world/citygen/demo");
      await waitForWorldBackgroundWindow();
      citygen = citygenDemoMod.createCityGenDemo({ scene, map }) as NonNullable<typeof citygen>;
    }

    // Forest + Creatures: ambient wildlife and rideable animals
    const [forestMod, creaturesMod] = await Promise.all([
      import("./gameplay/forest"),
      import("./gameplay/creatures")
    ]);
    await waitForWorldBackgroundWindow(1800);
    ANIMALS = forestMod.ANIMALS as NonNullable<typeof ANIMALS>;
    creatures = new creaturesMod.Creatures(map, scene);
    forest = new forestMod.Forest(map, scene);

    // Each optional region keeps its code, textures and tree growth behind its
    // own gate. A clean boot does not fetch all parks merely because the module
    // coordinator itself is running.
    let gardenModPromise: Promise<typeof import("./world/garden")> | null = null;
    let teaGardenModPromise: Promise<typeof import("./world/japaneseTeaGarden")> | null = null;
    let buenaVistaTreesModPromise: Promise<typeof import("./world/wildlands/buenaVistaTrees")> | null = null;
    let wildlandsModPromise: Promise<typeof import("./world/wildlands")> | null = null;
    let golfModPromise: Promise<typeof import("./gameplay/golf")> | null = null;
    let afterlightLayoutModPromise: Promise<typeof import("./gameplay/afterlight/layout")> | null = null;
    const loadGardenMod = () => gardenModPromise ??= import("./world/garden");
    const loadTeaGardenMod = () => teaGardenModPromise ??= import("./world/japaneseTeaGarden");
    const loadBuenaVistaTreesMod = () => buenaVistaTreesModPromise ??= import("./world/wildlands/buenaVistaTrees");
    const loadWildlandsMod = () => wildlandsModPromise ??= import("./world/wildlands");
    const loadGolfMod = () => golfModPromise ??= import("./gameplay/golf");
    const loadAfterlightLayoutMod = () => afterlightLayoutModPromise ??= import("./gameplay/afterlight/layout");
    // Botanical garden (heaviest single park: native trees + textures). Gate
    // it only when the spawn is near; otherwise build it AFTER the cover lifts,
    // hidden until compiled, so its trees never sit on the boot path.
    const buildGarden = async () => {
      await waitForWorldBackgroundWindow(1800);
      const gardenMod = await loadGardenMod();
      await waitForWorldBackgroundWindow(1800);
      const g = gardenMod.createBotanicalGarden(map);
      garden = g;
      void g.ready.then(() => sky.invalidateStaticShadows(), () => {});
      const h = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (h) Object.assign(h, { garden: g });
      return g;
    };
    const prepareGardenForScene = async () => {
      const g = await buildGarden();
      await g.ready;
      g.update(player.renderPosition);
      try {
        await waitForWorldBackgroundWindow();
        // Every first approach, including a near initial spawn, stays on the
        // baked fallback until the detached authored layer is GPU-ready.
        await renderer.compileAsync(g.group, camera, scene);
      } catch (err) {
        console.warn("[garden] deferred compile failed:", err);
      }
      scene.add(g.group);
      g.setVisible(foliageOn, player.position);
    };
    let gardenReady: Promise<unknown> | null = null;
    if (gardenGates) {
      gardenReady = prepareGardenForScene();
    } else {
      void revealedPromise.then(() => {
        wakeDeferredGarden = () => {
          wakeDeferredGarden = null;
          void prepareGardenForScene().catch((err) =>
            console.warn("[garden] first-approach construction failed:", err)
          );
        };
      });
    }

    // Japanese Tea Garden: exact OSM footprint with authored gates, Tea House,
    // pagoda, ponds, bridges, specimen planting and Hiro's walkable guided tour.
    // It shares the Botanical Garden region gate because the two sites touch;
    // distant boots compile it after reveal so it never delays first play.
    const buildTeaGarden = async () => {
      await waitForWorldBackgroundWindow(1800);
      const teaGardenMod = await loadTeaGardenMod();
      await waitForWorldBackgroundWindow(1800);
      try {
        const site = teaGardenMod.createJapaneseTeaGarden(map, {
          renderer,
          physics,
          nature,
          // Conversation is gameplay-critical, so it must remain visible when
          // the optional HUD panels are faded with Tab.
          dialogueParent: document.body,
          ballSource: {
            visitFreeBalls: (visitor) => fetchBall?.visitFreeBalls(visitor)
          },
          onCarryRake: (rake) => player.setGardenRakeTool(rake),
          onRakeMotion: (motion) => player.setGardenRakeMotion(motion),
          notify: (message, seconds) => hud.message(message, seconds)
        });
        japaneseTeaGarden = site;
        debugPanel.registerFeatureTuning(site.tuningDescriptor());
        site.setFoliageVisible(foliageOn);
        minimap.addLandmark(
          JAPANESE_TEA_GARDEN_ENTRANCE.x,
          JAPANESE_TEA_GARDEN_ENTRANCE.z,
          "Japanese Tea Garden"
        );
        const h = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
        if (h) Object.assign(h, { japaneseTeaGarden: site });
        return site;
      } catch (err) {
        for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
          tiles.unsuppressBuilding(building.key, building.index);
        }
        throw err;
      }
    };
    const prepareTeaGardenForScene = async () => {
      const site = await buildTeaGarden();
      await site.ready;
      site.update(0, 0, player.renderPosition, camera);
      try {
        await waitForWorldBackgroundWindow();
        // The site is born asleep/hidden. Compile its detached subtree while
        // temporarily visible because Three skips hidden roots.
        site.group.visible = true;
        await renderer.compileAsync(site.group, camera, scene);
      } catch (err) {
        console.warn("[tea-garden] deferred compile failed:", err);
      }
      scene.add(site.group);
      site.update(0, 0, player.renderPosition, camera);
      if (autoStartHiroTour) site.interact(player.renderPosition, player.mode);
    };
    let teaGardenReady: Promise<unknown> | null = null;
    if (gardenGates) {
      teaGardenReady = prepareTeaGardenForScene();
    } else {
      void revealedPromise.then(() => {
        wakeDeferredTeaGarden = () => {
          wakeDeferredTeaGarden = null;
          void prepareTeaGardenForScene().catch((err) =>
            console.warn("[tea-garden] first-approach construction failed:", err)
          );
        };
      });
    }

    // Buena Vista's skyline canopy is visible from Corona Heights, but it does
    // not own the citywide Wildlands, flower rings, or Presidio golf. Give this
    // compact forest its own first-approach gate so a Corona visit cannot grow
    // or texture distant redwoods in Golden Gate Park, Marin, or Mount Sutro.
    const buildBuenaVistaTrees = async (deferred: boolean) => {
      await waitForWorldBackgroundWindow(1800);
      const mod = await loadBuenaVistaTreesMod();
      await waitForWorldBackgroundWindow(1800);
      const forest = mod.createBuenaVistaTrees(map);
      buenaVistaTrees = forest;
      forest.group.visible = true;
      await forest.ready;
      forest.update(camera.position);
      try {
        // Near starts and later approaches use the same detached path; neither
        // may leak an uncompiled tree material into the live renderer.
        await forest.prepareVisible(async (unit) => {
          await waitForWorldBackgroundWindow();
          await renderer.compileAsync(unit, camera, scene);
        });
      } catch (err) {
        console.warn(`[buena-vista] ${deferred ? "deferred" : "near"} tree compile failed:`, err);
      }
      scene.add(forest.group);
      forest.group.visible = foliageOn;
      sky.invalidateStaticShadows();
      const h = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (h) Object.assign(h, { buenaVistaTrees: forest });
    };
    let buenaVistaTreesReady: Promise<unknown> | null = null;
    if (buenaVistaGates) {
      buenaVistaTreesReady = buildBuenaVistaTrees(false);
    } else {
      void revealedPromise.then(() => {
        wakeDeferredBuenaVistaTrees = () => {
          wakeDeferredBuenaVistaTrees = null;
          void buildBuenaVistaTrees(true).catch((err) => {
            console.warn("[buena-vista] first-approach construction failed:", err);
          });
        };
      });
    }

    // Wildlands groves + Presidio golf, built as one coupled unit: the course
    // footprint masks groundcover/trees off the fairways, so the order is fixed
    // (course data → masked groves → course meshes). Gate together when near;
    // otherwise the whole pair streams in after reveal, groves hidden until
    // compiled. `deferred` selects which.
    const buildWildlandsGolf = async (deferred: boolean) => {
      await waitForWorldBackgroundWindow(1800);
      const [wildlandsMod, golfMod, afterlightLayout] = await Promise.all([
        loadWildlandsMod(),
        loadGolfMod(),
        loadAfterlightLayoutMod()
      ]);
      await waitForWorldBackgroundWindow(1800);
      let loadedGolfCourse: import("./gameplay/golf").GolfCourse | null = null;
      try {
        loadedGolfCourse = await golfMod.loadGolfCourse(map);
      } catch (err) {
        // Golf data is optional to world boot: vegetation and the city still
        // load if a deploy is missing golf.json.
        console.warn("[golf] course unavailable:", err);
      }
      const _wildlands = wildlandsMod.createWildlands(map, {
        // Keep animated blades and flowers off the compact installation as well
        // as the golf surfaces. The wider Buena Vista meadow stays untouched.
        groundcover: (x: number, z: number) =>
          afterlightLayout.inAfterlightGroundcoverClear(x, z, 1.2) ||
          (loadedGolfCourse?.contains(x, z, 1.2) ?? false),
        // Keep the wooded rough character, but never procedural-tree a play
        // surface or the graded apron around greens/tee pads.
        trees: loadedGolfCourse
          ? (x: number, z: number) => loadedGolfCourse!.clearsProceduralTrees(x, z)
          : undefined
      });
      wildlands = _wildlands;
      // Keep every layer detached and hidden until its own render objects have
      // been prepared. The forest retains this preparer for chunks encountered
      // later through movement or a cross-city teleport.
      for (const g of _wildlands.groups) g.visible = false;
      const h = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (h) Object.assign(h, { wildlands: _wildlands });
      // NativeTreeForest accepts a pre-ready focus. Recording it here lets the
      // sliced 403-chunk assembly finish with the correct local cull already in
      // place instead of briefly exposing every authored grove.
      _wildlands.trees.update(camera.position);
      await _wildlands.ready;
      // A first-approach build can overlap a later user teleport. Re-enter the
      // shared quiet gate before renderer compilation so background foliage can
      // never knowingly compete with a destination prime.
      await waitForWorldBackgroundWindow();
      _wildlands.update(player.renderPosition, camera.position);
      await _wildlands.prepareVisible(async (unit) => {
        try {
          // A stationary player can resume moving between two native-tree
          // pipelines. Re-admit every unit instead of letting one old idle
          // decision launch an uninterruptible compile train during play.
          await waitForWorldBackgroundWindow();
          await renderer.compileAsync(unit, camera, scene);
        } catch (err) {
          // A failed precompile is non-fatal: resolving this unit preserves the
          // existing visual fallback instead of leaving a region hidden forever.
          console.warn(
            `[wildlands] ${deferred ? "deferred" : "near"} prepare failed for ${unit.name || unit.type}:`,
            err
          );
        }
      });
      for (const g of _wildlands.groups) {
        g.visible = foliageOn;
        scene.add(g);
      }
      if (foliageOn) sky.invalidateStaticShadows();
      // Presidio golf game. Own guard — a bad golf.json must not take the
      // groves/city down with it.
      if (loadedGolfCourse) {
        await waitForWorldBackgroundWindow(1800);
        const game = await golfMod.createGolf(map, physics, scene, loadedGolfCourse, {
          daylight: () => sky.sunElevation > 0.05
        });
        // The constructor deliberately adds an asleep/hidden root. Compile it
        // while detached from live visibility, and re-check the quiet window
        // after synchronous game construction so an arrival can preempt here.
        await waitForWorldBackgroundWindow();
        try {
          game.root.visible = true;
          await renderer.compileAsync(game.root, camera, scene);
        } catch (err) {
          console.warn("[golf] deferred compile failed:", err);
        } finally {
          game.root.visible = false;
        }
        game.onNet = (m) => net.sendGolf(m);
        game.onImpact = (p) => fx.impactPuff(p);
        golf = game;
        // Site gate: the course renders nothing and update() early-returns
        // until the player nears the footprint. A live round (or a borrowed
        // cart) holds the site awake wherever it wanders.
        siteGate.register({
          id: "golf",
          contains: (x, z, pad) => game.siteContains(x, z, pad),
          activatePad: golfMod.GOLF_SITE_PADS.activate,
          deactivatePad: golfMod.GOLF_SITE_PADS.deactivate,
          keepAwake: () => game.keepsSiteAwake,
          setAwake: (on) => game.setSiteAwake(on)
        });
        const first = loadedGolfCourse.holes.find((h2) => h2.ref === 1) ?? loadedGolfCourse.holes[0];
        // Refine the eager "Presidio Golf" pin (dropped at the course centroid at
        // boot) to the actual first tee now that the course data has loaded.
        if (first) minimap.addLandmark(first.teeXZ[0], first.teeXZ[1], "Presidio Golf");
        const gh = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
        if (gh) Object.assign(gh, { golf: game });
        // Welcome can arrive before this lands; hydrate any peer golf states Net
        // retained in the meantime.
        net.replayGolf();
      }
    };
    let wildlandsGolfReady: Promise<unknown> | null = null;
    if (wildlandsGolfGates) {
      wildlandsGolfReady = buildWildlandsGolf(false);
    } else {
      void revealedPromise.then(() => {
        wakeDeferredWildlandsGolf = () => {
          wakeDeferredWildlandsGolf = null;
          void buildWildlandsGolf(true).catch((err) => {
            console.warn("[wildlands/golf] first-approach construction failed:", err);
          });
        };
      });
    }

    // Gate the reveal on whatever is near; deferred regions run post-reveal and
    // are intentionally excluded here so they never hold the cover.
    await Promise.all([
      gardenReady,
      teaGardenReady,
      buenaVistaTreesReady,
      wildlandsGolfReady
    ].filter(Boolean));

    // BehindTheScenes: the "how it was made" reading overlay.
    // Closing does not re-lock — Esc (and backdrop/close) leave the cursor free.
    const { BehindTheScenes } = await import("./ui/behindTheScenes");
    behindTheScenes = new BehindTheScenes((open: boolean) => {
      btsReading = open;
      app.classList.toggle("world-dimmed", open);
      input.suspended = open || inOrbit();
      if (open) input.releaseLock();
    });

  })()
    .catch((err) => {
      if (!japaneseTeaGarden) {
        for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
          tiles.unsuppressBuilding(building.key, building.index);
        }
      }
      console.warn("[sf] deferred module load failed:", err);
    });

  // ------------------------------------------------------- settle gate
  // The cover waits only for the fixed-quality local visual minimum and the
  // collision safety bubble. Far tiles and optional systems remain center-out
  // background work, so first play never waits for the whole city.
  const settleStart = performance.now();
  console.info(`[boot] core up in ${((settleStart - bootT0) / 1000).toFixed(1)}s — settling the world`);
  let revealed = false;
  let quietFrames = 0;
  let peakRemaining = 0;
  let settlePct = 88;
  let settleLabel = "";
  const bootQuery = new URLSearchParams(location.search);
  // Local development is primarily exercised by browser agents, so enter the
  // world as soon as it is ready instead of leaving them stranded at a purely
  // human identity gate. `?startscreen=1` keeps the real onboarding path easy
  // to inspect. Deployed browser tests opt in explicitly with `?autostart=1`.
  const autoEnter =
    !parseReadLink(location.search) &&
    !bootQuery.has("startscreen") &&
    (import.meta.env.DEV || ["autostart", "demo", "profile"].some((key) => bootQuery.has(key)));
  // Explicit headless verification, demos and perf runs also skip the settle
  // hold because they measure live-frame behaviour rather than boot polish.
  const skipGate = ["autostart", "demo"].some((key) => bootQuery.has(key));
  // Local HMR reloads that were already in-game resume without the identity gate.
  // Production always waits for Start / Enter — returning players keep their saved
  // name prefilled in the form. Deployed tests still opt in via `?autostart` etc.
  // (handled by `autoEnter` above).
  const autoStartSaved =
    !parseReadLink(location.search) &&
    !bootQuery.has("startscreen") &&
    Boolean(devReload?.started);
  const revealWorld = (reason = "settled") => {
    if (revealed) return;
    revealed = true;
    worldBackgroundNotBefore = Math.max(worldBackgroundNotBefore, performance.now() + 1200);
    resolveRevealed(); // release any region-deferred park builds
    progress(100, "ready");
    bootScreen.markReady();
    // Procedural weather has rendered from frame one. Only after reveal may the
    // optional live adapter/chunk request observations.
    sky.enableLiveFogAfterReveal();
    // Cache world assets for instant repeat loads. Post-reveal on purpose — it
    // must not compete with the boot fetches it is meant to make free next time.
    if (import.meta.env.PROD && "serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    }
    bootMark("reveal");
    console.info(
      `[boot] world ${reason} in ${((performance.now() - bootT0) / 1000).toFixed(1)}s` +
        ` (sched ${scheduler.pending}/${scheduler.waiting} waiting, tiles ${tiles.busy}, modules ${modulesReady}, aux ${auxPending})`
    );
    console.info(`[boot] phases ${bootMarkSummary()}`);
    persistBootHistory();
    // Prefer HMR resume over generic local auto-enter so a mid-session reload
    // keeps the player's name instead of minting a fresh fun one.
    if (autoStartSaved) {
      // no click to consume, so pointer lock has no gesture — startGame still
      // requests it (a no-op if the browser declines; first click re-locks)
      bootScreen.startNow(devReload!.name);
      return;
    }
    if (autoEnter) {
      // Programmatic starts have no user gesture, so do not request pointer
      // lock. The first canvas click can capture it normally when needed.
      bootScreen.startNow(suggestedName, { lock: false });
      return;
    }
    bootScreen.focusNameInput(); // re-focus in case the player clicked away while waiting
  };
  // Called once per covered tick. Only the generic local visual bubble and
  // movement-safety collision bubble gate first play; optional districts,
  // activities, media and the far draw ring keep streaming independently.
  const settleTick = () => {
    if (revealed) return;
    const initialStatus = initialArrivalReleased
      ? null
      : physics.collisionArrivalStatus(initialCollisionEpoch);
    initialCollisionReady = initialArrivalReleased || initialStatus?.ready === true;
    if (initialStatus && initialStatus.failedColliderTiles > 0 && initialCollisionRetryCycles < 1) {
      const restarted = physics.retryCollisionArrival(initialCollisionEpoch);
      if (restarted > 0) {
        initialCollisionRetryCycles++;
        console.warn(`[boot] retrying ${restarted} failed local collision tile${restarted === 1 ? "" : "s"}`);
      }
    }
    const remaining = (initialVisualState === "pending" ? 1 : 0) + (initialCollisionReady ? 0 : 1);
    peakRemaining = Math.max(peakRemaining, remaining);
    if (remaining === 0) quietFrames++;
    else quietFrames = 0;
    // 15 s cap: a missing chunk or a genuinely slow connection falls back to
    // the old behaviour (reveal while still streaming) instead of wedging.
    if (quietFrames >= 12) {
      revealWorld();
      return;
    }
    if (performance.now() - settleStart > 15000) {
      if (initialVisualState === "pending") {
        initialVisualState = "fallback";
        console.warn("[boot] local visuals missed the reveal deadline; using the terrain fallback");
        hud.message("Some neighborhood detail is still streaming in", 8);
      }
      revealWorld("reveal-forced (15s cap)");
      return;
    }
    settlePct = Math.min(99, Math.max(settlePct, 88 + Math.round(11 * (1 - remaining / Math.max(1, peakRemaining)))));
    const label = initialVisualState === "pending"
      ? "bringing the neighborhood into view"
      : !initialCollisionReady
        ? "settling the ground"
        : "ready";
    if (label !== settleLabel) {
      settleLabel = label;
      console.info(`[boot] +${((performance.now() - bootT0) / 1000).toFixed(1)}s ${label} (sched ${scheduler.pending}, tiles ${tiles.busy}, aux ${auxPending})`);
    }
    progress(settlePct, label);
  };

  if (skipGate) {
    loading.classList.add("done");
    revealWorld("skip-gate");
  }

  // `?read=<modal>[.<sub>]` — a shared "reading" link (e.g. ?read=bts.sound for
  // the soundscape chapter). Drop straight into the reading: no name gate, a fun
  // sample name handed out automatically, and the modal opened on its sub-view.
  // Closing it lands the player in the live city with nothing left to fill in.
  if (parseReadLink(location.search)) {
    revealWorld("read-link"); // reading mode starts immediately — the modal covers any late streaming
    bootScreen.startNow(suggestedName, { lock: false });
    openReadLink(); // opens the registered modal + strips ?read= from the URL
  }

  const timer = new THREE.Timer();
  let accumulator = 0;
  let elapsed = 0;
  let paused = false;
  // When paused, the world sim freezes but the player stays live by default
  // (walk/drive/fly on) so you can keep roaming the frozen city. The pause
  // toggle flips this to freeze the player too, for a still shot.
  let freezePlayer = false;
  let immersive = false;
  // Z (hold): scrub the time of day with the trackpad — cursor drag or
  // two-finger swipe, right = later. `target` accumulates raw input; the sky
  // eases toward it each frame so fast swipes glide instead of stepping. The
  // cycle pauses while scrubbing and resumes (from the new time) on release.
  let timeScrub: { target: number; wasCycling: boolean } | null = null;
  const clock12 = (t: number) => {
    const h = Math.floor(t) % 24;
    const m = Math.floor((t % 1) * 60);
    return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
  };

  // Immersive mode snapshots HUD + debug visibility and restores them on exit.
  type ImmersiveSnap = { debugOn: boolean; uiOpen: boolean };
  let immersiveSnap: ImmersiveSnap | null = null;
  const setDebugUI = (on: boolean) => diagnostics.setDebugUI(on, debugPanel);
  const exitImmersive = (opts?: { restoreDebug?: boolean }) => {
    if (!immersive) return;
    immersive = false;
    hud.setHidden(false);
    remotes.setTagsVisible(true);
    if (immersiveSnap) {
      // Slash exits immersive then toggles debug itself — skip restore so `/` still opens the panel.
      if (opts?.restoreDebug !== false) setDebugUI(immersiveSnap.debugOn);
      uiOpen = immersiveSnap.uiOpen;
      hud.setFaded(!uiOpen);
      immersiveSnap = null;
    }
    refreshPauseToggle();
  };

  // Bottom-center pause control: only up while paused (and not immersive, since
  // it lives under #hud). Clicking it freezes/unfreezes the player.
  const pauseToggle = new PauseToggle((freeze) => {
    freezePlayer = freeze;
    hud.message(freeze ? "Player frozen — click the toggle to move again" : "Player live while paused", 2.2);
  });
  const refreshPauseToggle = () => {
    pauseToggle.setVisible(paused && !immersive);
    pauseToggle.setFrozen(freezePlayer);
  };

  const sessionPersistence = createSessionPersistence(player);
  if (import.meta.hot) {
    const captureDevReload = () => {
      // localStorage is shared across tabs, so only the visible one may update
      // the ordinary resume point. The exact reload snapshot is session-scoped.
      sessionPersistence.writeVisible();
      writeDevReloadSnapshot({
        started: document.body.classList.contains("started"),
        name: net.name,
        player: {
          mode: player.mode,
          x: player.position.x,
          y: player.position.y,
          z: player.position.z,
          heading: player.heading
        },
        camera: { yaw: chase.yaw, pitch: chase.pitch, zoom: chase.zoom }
      });
    };
    // Soft-HMR mode suppresses the reload, so skip writing a one-shot snapshot.
    if (!suppressesFullReload) {
      import.meta.hot.on("vite:beforeFullReload", captureDevReload);
    }
    // Vite reconnect/server-restart reloads do not emit beforeFullReload, but
    // still pass through the browser lifecycle. Manual refresh also lands here.
    window.addEventListener("beforeunload", captureDevReload);
  }

  // A demo can install a per-frame cinematic controller that fully owns the
  // player pose AND the camera for a scripted shot (see dev/demos/buskersCinematic.ts).
  let cineHook: ((dt: number) => void) | null = null;

  const updatePickleballGameplay = (dt: number) => pickleballController?.update(dt) ?? false;
  const applyPickleballPlayerPose = () => pickleballController?.applyPlayerPose();
  const hidePickleballRemoteAvatars = () => pickleballController?.hideClaimedRemoteAvatars();
  const sendLocalPresence = (speed = player.speed) => {
    if (pickleballController) {
      pickleballController.sendLocalPresence(speed);
      return;
    }
    net.sendState(
      player.mode,
      player.meshes[player.mode].position,
      player.meshes[player.mode].quaternion,
      speed,
      embodiments.passengerOf ?? 0
    );
  };
  const sendPickleballNetwork = () => pickleballController?.sendNetwork();
  const tick = (forcedDt?: number) => {
    // HMR factories are queued by Vite's socket callback and committed only at
    // this frame boundary, never halfway through simulation/render work.
    buskers.flushHotSwap();
    timer.update();
    const frameDt = forcedDt ?? Math.min(timer.getDelta(), 0.09);
    // Optional regions and shader warmups require a genuinely quiet user
    // window. Continuous first-play movement keeps pushing those stages back;
    // the fixed-quality local tile streamer remains active throughout.
    noteWorldBackgroundMotion();

    // gamepad first so its synthetic key codes exist for every consumer below
    input.pollPad(frameDt);

    // Behind-the-scenes overlay open: freeze the world completely — no sim, no
    // render. The canvas keeps its last frame (dimmed via CSS) so nothing
    // flickers behind the modal; the panel's own diagrams animate on their own
    // rAF, independent of this loop. Resumes cleanly the frame it's closed.
    // Behind-the-scenes and the Canticle book both freeze the world completely —
    // no sim, no render; the canvas keeps its last frame (dimmed via CSS) behind
    // the DOM overlay, whose own animation runs on its own rAF.
    if (btsReading || museumBookOpen) {
      input.endFrame();
      return;
    }

    // P freezes the whole game — player, physics, fx, sky, water, crown.
    // We keep rendering the frozen frame so the window stays live.
    if (input.pressed("KeyP")) {
      paused = !paused;
      if (paused) freezePlayer = false; // each pause starts with the player live
      refreshPauseToggle();
      hud.message(
        paused ? "Paused — you can still move. P to resume" : "Resumed",
        paused ? Infinity : 2.6
      );
    }
    // /: all debug UI — tuning pane + three.js inspector (works while paused too)
    if (input.pressed("Slash")) {
      if (immersive) exitImmersive({ restoreDebug: false });
      setDebugUI(!diagnostics.debugOn);
    }
    // I: immersive mode — every scrap of UI goes away until pressed again
    if (input.pressed("KeyI")) {
      if (immersive) {
        exitImmersive();
        hud.message("Immersive off");
      } else {
        immersiveSnap = { debugOn: diagnostics.debugOn, uiOpen };
        immersive = true;
        // setHidden already covers the HUD — leave uiOpen/faded alone so exit can restore.
        hud.setHidden(true);
        remotes.setTagsVisible(false);
        setDebugUI(false);
        refreshPauseToggle();
      }
    }
    // Tab: toggle the user UI — fade panels in/out. Runs while paused too.
    if (input.pressed("Tab")) {
      uiOpen = !uiOpen;
      hud.setFaded(!uiOpen);
    }
    // M (or clicking the minimap): the full city map — players, teleports.
    // Works while paused. Esc closes it via the Escape priority stack (stays
    // unlocked); M-toggle closed re-locks so play resumes without a click.
    if (input.pressedRaw("KeyM")) {
      if (
        worldArrival.active &&
        worldArrival.snapshot.state !== "collision-blocked" &&
        worldArrival.snapshot.state !== "visual-blocked"
      ) {
        hud.message("Finishing the arrival…", 1.2);
      } else {
        const closing = minimap.expanded;
        minimap.setExpanded(!minimap.expanded);
        if (closing && !inOrbit()) input.requestLock();
      }
    }

    // Expanded map: gamepad pan / zoom / cursor / select / teleport / pin cycle.
    // World + player are fully frozen while the map is open (kb or pad).
    if (minimap.expanded) {
      const axes = input.mapPadAxes();
      minimap.padPan(axes.lx, axes.ly, frameDt);
      minimap.padZoom(axes.rt - axes.lt, frameDt);
      minimap.padMoveCursor(axes.rx, axes.ry, frameDt);
      if (input.pressedRaw("Space")) minimap.padSelectAtCursor();
      if (input.firePressed) minimap.padTeleport();
      if (input.pressedRaw("Enter") || input.pressedRaw("NumpadEnter")) minimap.padTeleport();
      const mapPadCycle =
        (input.pressedRaw("PadModeNext") ? 1 : 0) - (input.pressedRaw("PadModePrev") ? 1 : 0);
      if (mapPadCycle) minimap.padCyclePins(mapPadCycle);

      dogParkAudio.setPaused(true);
      vehicleAudio.update(frameDt, null);
      swimAudio.update(frameDt, null);
      nature.update(frameDt, {
        playerPos: player.renderPosition,
        camera,
        gust: windGustValue(),
        timeOfDay: sky.timeOfDay,
        allowNewLoads: !worldArrival.active
      });
      sendLocalPresence(0);
      sendPickleballNetwork();
      remotes.selfId = net.selfId;
      remotes.update(frameDt);
      hidePickleballRemoteAvatars();
      if (embodiments.passengerOf !== null && remotes.ridePose(embodiments.passengerOf, ridePos, rideQuat)) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      }
      voice.update(camera);
      minimap.update();
      playerLocator.update(camera, player.position, remotes.locatorTargets());
      updateSurfPresentation(frameDt);
      sky.update(elapsed, camera.position, player.renderPosition);
      hud.update(frameDt);
      input.endFrame();
      renderFrame();
      return;
    }

    // Crossing the generic approach radius requests at most one authored site;
    // the queue rechecks after the arrival-quiet window before importing it.
    updateOptionalWorldSites();
    // One wake/sleep pass over every registered minigame site (pickleball,
    // golf, …): a contains() test per site, setAwake only on transitions.
    if (!worldArrival.active) siteGate.update(player.position.x, player.position.z);

    // The shared court keeps advancing even while the rest of the world is
    // paused, so a remote opponent never loses the match when authority opens
    // photo/pause controls.
    const pickleballEConsumed = worldArrival.active ? false : updatePickleballGameplay(frameDt);
    const playingPickleball = pickleballController?.playing ?? false;
    applyPickleballPlayerPose();

    // Full freeze: a pause with "freeze player" armed. Everything holds — sim,
    // player, fx, vehicles — while a clean screenshot floats on top.
    dogParkAudio.setPaused(paused);
    if (paused && freezePlayer && !worldArrival.active) {
      vehicleAudio.update(frameDt, null); // fade the hum out while frozen
      swimAudio.update(frameDt, null);
      // ambience keeps breathing while frozen — it's a chill/social feature
      nature.update(frameDt, {
        playerPos: player.renderPosition,
        camera,
        gust: windGustValue(),
        timeOfDay: sky.timeOfDay,
        allowNewLoads: !worldArrival.active
      });
      // stay social while frozen: peers keep moving, our keepalive keeps flowing
      sendLocalPresence(0);
      sendPickleballNetwork();
      remotes.selfId = net.selfId;
      remotes.update(frameDt);
      hidePickleballRemoteAvatars();
      // stay glued to a friend's car while frozen
      if (embodiments.passengerOf !== null && remotes.ridePose(embodiments.passengerOf, ridePos, rideQuat)) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      }
      voice.update(camera); // keep talking while paused — it's a social feature
      minimap.update();
      playerLocator.update(camera, player.position, remotes.locatorTargets());
      updateSurfPresentation(frameDt);
      // Social/remount poses can still move while the simulation clock is
      // frozen. Keep the full-rate hero map aligned before drawing this frame.
      sky.update(elapsed, camera.position, player.renderPosition);
      input.endFrame();
      renderFrame();
      return;
    }

    // World frozen, player live: the default pause. The whole city sim holds
    // (sky, water, fx never tick) but the player keeps moving — walk, drive,
    // fly — so you can keep roaming the frozen city. We run ONLY the player's own
    // step + camera + tile streaming. The player's dynamic body still steps
    // physics.
    if (paused) {
      accumulator += frameDt; // no elapsed++ — the world clock stays frozen
      if (player.mode === "plane") player.steerFly(input, frameDt);
      if (!playingPickleball && !input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
      if (
        !playingPickleball &&
        !input.suspended &&
        player.mode === "surf" &&
        (input.pressed("Space") || input.pressed("KeyX"))
      ) player.requestSurfFlow();
      if (!playingPickleball && !input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();
      chase.lookDir(aim);
      physics.maintainStreaming(player.position);
      let steps = 0;
      while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
        if (playingPickleball) input.setSuspensionHold("pickleball-step", true);
        player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
        if (playingPickleball) input.setSuspensionHold("pickleball-step", false);
        physics.step(physics.world.fixedTimeStep);
        accumulator -= physics.world.fixedTimeStep;
        steps++;
      }
      if (steps === 3) accumulator = 0;
      remotes.selfId = net.selfId;
      remotes.update(frameDt);
      hidePickleballRemoteAvatars();
      // personal space: standing inside another avatar shimmers like z-fighting
      player.separateFromAvatars(remotes.walkingPositions(), frameDt);
      // riding shotgun with a friend keeps you glued; otherwise settle the render
      // transform between physics states like a live frame
      if (embodiments.passengerOf !== null && remotes.ridePose(embodiments.passengerOf, ridePos, rideQuat)) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      } else {
        player.afterSteps(steps, accumulator / physics.world.fixedTimeStep);
        player.syncMesh(frameDt);
      }
      applyPickleballPlayerPose();
      consumeCarLandingFeedback();
      const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
      highUp = highUp ? altitude > 110 : altitude > 150;
      tiles.update(player.position.x, player.position.z, highUp);
      // Live-player pause still allows walking. Keep the generated-building gate
      // and streaming focus current so crossing a doorway cannot leave the camera
      // stuck in the previous indoor/outdoor mode.
      if (!worldArrival.active) citygenRing.current?.update(player.position, frameDt);
      if (inOrbit()) { chase.suspend(player); orbit.update(frameDt); }
      else { chase.indoor = (citygenRing.current?.isPlayerInside() ?? false) || (missionDolores?.isPlayerInside(player.position) ?? false); chase.update(frameDt, player, input); }
      // keep the vehicle hum, ambience and social presence alive like full pause
      vehicleAudio.update(frameDt, {
        mode: player.mode,
        speed: player.speed,
        vspeed: player.velocity.y,
        boost: input.down("ShiftLeft"),
        grounded: player.mode !== "board" || player.boardGrounded,
        surfFace: player.mode === "surf" ? player.surfTelemetry.face : 0,
        surfFlow: player.mode === "surf" && player.surfTelemetry.flowActive ? 1 : 0,
        surfMotionRate: player.mode === "surf" ? player.surfTelemetry.riderMotionRate : 1,
        driveVoice: player.driveSpec.voice ?? "engine"
      });
      swimAudio.update(frameDt, {
        swimming: player.swimming,
        speed: Math.hypot(player.velocity.x, player.velocity.z),
        vspeed: player.velocity.y
      });
      nature.update(frameDt, {
        playerPos: player.renderPosition,
        camera,
        gust: windGustValue(),
        timeOfDay: sky.timeOfDay,
        allowNewLoads: !worldArrival.active
      });
      sendLocalPresence();
      sendPickleballNetwork();
      voice.update(camera);
      minimap.update();
      playerLocator.update(camera, player.position, remotes.locatorTargets());
      hud.update(frameDt);
      // paused-but-roaming still streams tiles/citygen — keep their deferred
      // assembly draining so the frozen city fills in around the live player
      scheduler.run(frameDt < 1 / 55 ? 3 : 1.5);
      updateSurfPresentation(frameDt);
      // The world clock stays frozen, but the player and camera can move in this
      // branch. Keep shadow coverage and the every-frame subject map current.
      sky.update(elapsed, camera.position, player.renderPosition);
      input.endFrame();
      renderFrame();
      return;
    }

    elapsed += frameDt;
    accumulator += frameDt;

    // Plain number keys switch travel modes; Ctrl+number still jumps click-tools;
    // Shift+number teleports to player slots. Arrows: ↑/↓ between toolbar rows,
    // ←/→ cycle the focused row (vehicles / tools / paint swatches).
    const numberPressed = (i: number) => input.pressed(`Digit${i}`) || input.pressed(`Numpad${i}`);
    const ctrlNumberPress = (i: number) => input.ctrlPressed(`Digit${i}`) || input.ctrlPressed(`Numpad${i}`);
    const shiftedNumberPress = (i: number) => input.shiftedPress(`Digit${i}`) || input.shiftedPress(`Numpad${i}`);
    for (let i = 1; i <= 9; i++) {
      if (!numberPressed(i)) continue;
      if (playingPickleball) break;
      if (golf?.capturesDigits) break; // golf swing UI owns the number row (club picks)
      if (ctrlNumberPress(i)) {
        const nextTool = TOOL_ORDER[i - 1];
        if (nextTool) {
          toolbar.focusTools();
          setTool(nextTool);
        }
        continue;
      }
      // Snapshot Shift from the digit's keydown event; a stale held-key entry
      // should never turn a plain number press into a player-slot teleport.
      if (shiftedNumberPress(i)) {
        const target = playerLocator.targetForDigit(i);
        if (target) teleportToTarget(target.x, target.z, target.name, target.id);
        else hud.message(`No player in slot ${i}`, 1.9);
        continue;
      }
      const nextMode = MENU_MODES[i - 1];
      if (nextMode) {
        toolbar.focusVehicles();
        switchMode(nextMode);
      }
    }
    if (!playingPickleball) {
      const dx =
        (input.pressed("ArrowRight") && !input.altPressed("ArrowRight") ? 1 : 0) -
        (input.pressed("ArrowLeft") && !input.altPressed("ArrowLeft") ? 1 : 0);
      const dy =
        (input.pressed("ArrowDown") ? 1 : 0) - (input.pressed("ArrowUp") ? 1 : 0);
      if (dx || dy) toolbar.navigate(dx, dy);
    }
    const padCycle = (input.pressed("PadModeNext") ? 1 : 0) - (input.pressed("PadModePrev") ? 1 : 0);
    if (padCycle && !playingPickleball) {
      const cycleOrder = MENU_MODES;
      const idx = cycleOrder.indexOf(player.mode);
      const from = idx >= 0 ? idx : 0;
      const step = padCycle < 0 ? -1 : 1;
      if (cycleOrder.length) {
        toolbar.focusVehicles();
        switchMode(cycleOrder[(from + step + cycleOrder.length) % cycleOrder.length]);
      }
    }
    if (!playingPickleball && input.altPressed("ArrowLeft")) applyPlaceHistory(-1);
    if (!playingPickleball && input.altPressed("ArrowRight")) applyPlaceHistory(1);

    // E / pad B: nearby conversations get first refusal. When the prompt was
    // reached on a vehicle or creature, the same press dismounts and is handed
    // back to the conversation once the player is on foot; requiring a second
    // press made Hiro's visible prompt appear unresponsive.
    const interactPressed = !worldArrival.active && !pickleballEConsumed && input.pressed("KeyE");
    // Use the same position the tea-garden prompt distance is measured against
    // (renderPosition), so a visible "Talk" prompt always accepts the matching E.
    let teaGardenEConsumed = interactPressed
      && (japaneseTeaGarden?.interact(player.renderPosition, player.mode) ?? false);
    const exitedToWalk = interactPressed && !teaGardenEConsumed && exitToWalk();
    if (exitedToWalk) {
      teaGardenEConsumed = japaneseTeaGarden?.interact(player.renderPosition, player.mode) ?? false;
    }
    if (
      !pickleballEConsumed &&
      !teaGardenEConsumed &&
      interactPressed &&
      !exitedToWalk &&
      !golf?.tryStartAtTee(player, hud) &&
      !archery?.tryInteract(player, hud, chase) &&
      !palaceReverie?.tryInteract(player, hud) &&
      !landsEnd?.keeper.tryInteract(player, hud) &&
      !missionDolores?.tryInteract(player.position, player.mode, hud) &&
      !afterlight?.tryInteract(player, hud)
    ) {
      const nearOceanBeach = player.mode === "walk" && nearOceanBeachShore(player.position.x, player.position.z);
      if (nearOceanBeach) {
        // Load the exclusive rig before changing embodiment, so even the first
        // visible surf frame uses the locked shot rather than world-camera state.
        const request = ++surfEntryRequest;
        void chase.ensureSurfCamera().then(() => {
          if (request !== surfEntryRequest || player.mode !== "walk") return;
          if (!nearOceanBeachShore(player.position.x, player.position.z)) return;
          // Surf enter() can move the player from shore to the nearest wave
          // crest. Route that discontinuity through the same covered arrival
          // transaction as every other long mode-entry relocation.
          navigation.switchMode("surf");
          hud.message("You're surfing — A/D carve · W pump · S stall · E exits to the beach", 4);
        });
      } else if (!fetchBall?.tryPickup(player.position)) {
        const drv = remotes.nearestDriver(player.position, 5.5);
        const animal = drv ? null : forest?.nearest(player.position, 5);
        if (drv) {
          embodiments.startPassengerRide(drv.id);
          hud.message(`Riding with ${drv.name} — E to hop out`, 2.6);
        } else if (animal && forest && ANIMALS) {
          const info = forest.consume(animal);
          embodiments.currentAnimal = info.kind;
          player.setDriveStyle(forest.buildRiddenMesh(info.kind), ANIMALS[info.kind].spec);
          player.position.set(info.x, player.position.y, info.z);
          player.heading = info.heading + Math.PI; // storage convention is facing+π
          player.trySwitch("drive");
          hud.message(
            info.kind === "raccoon" ? "You're riding the raccoon! Left click — gummy bears" : "You're riding the bear!",
            3
          );
        } else {
          // re-board a vehicle/creature you left behind — walk up, press E,
          // just like a parked mount (the phoenix, a crashed plane, a hoverboard…)
          const mount = abandonedMounts.boardNearest(player.position.x, player.position.z, 5.5);
          if (mount) {
            if (mount.mode === "drive") player.setDriveStyle(null);
            player.position.set(mount.x, mount.y, mount.z);
            player.heading = mount.heading;
            player.trySwitch(mount.mode);
            hud.message("Back on board — E to hop off", 2.4);
          } else if (player.mode === "walk" && citygenRing.current) {
            // front doors: on foot, E toggles the nearest generated-building
            // door (the ring owns the state — swing + collider swap live there)
            const d = citygenRing.current.nearestDoor(player.position);
            if (d && d.dist < 2.6) {
              const r = citygenRing.current.toggleDoor(d.id);
              if (r === "opened") hud.message("Door's open — step inside", 2.4);
              else if (r === "closed") hud.message("Door closed", 1.6);
              else if (r === "blocked") hud.message("Step out of the doorway first", 2);
            }
          }
        }
      }
    }

    // ".": factory reset for tweaks — every tweakpane value back to its
    // source-code default, saved tweaks wiped. Player stays put.
    if (!worldArrival.active && input.pressed("Period")) {
      resetAllTweaks();
      resetCrownTweaks();
      resetBayLightsTweaks();
      resetGoldenGateLightsTweaks();
      resetSutroLightsTweaks();
      START.spawn = START_DEFAULTS.spawn;
      START.mode = START_DEFAULTS.mode;
      // re-apply the side effects the pane's onChange handlers normally push.
      renderer.toneMappingExposure = RENDER_TUNING.values.exposure;
      renderer.setPixelRatio(RENDER_TUNING.values.pixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      CONFIG.tileLoadRadius = WORLD_TUNING.values.radius;
      CONFIG.tileUnloadRadius = WORLD_TUNING.values.radius + 400;
      setFoliageVisible(FOLIAGE_TUNING.values.visible);
      tiles.forceScan();
      sky.applyFogParams();
      sky.invalidateStaticShadows("all");
      pipeline.applyPostFx(); // toggles back off + sliders back to defaults
      sky.timeRatePercent = SKY_TUNING.values.timeRatePercent;
      sky.nightBrightness = SKY_TUNING.values.nightBrightness;
      sky.followRealTime(); // default: back to mirroring the real SF clock
      sky.applyFogParams();
      sky.refreshFogWeatherSource();
      debugPanel.syncNow();
      hud.message("Tweaks back to source defaults", 3);
    }
    if (!worldArrival.active && input.pressed("KeyC")) {
      if (player.mode === "surf") hud.message("Surf camera locked to the wave — E to exit", 1.8);
      else cycleViewMode();
    }
    // R: wireframe overlay (unused elsewhere — retained pass override + camera).
    // Keep transient debug presentation changes behind the identity/loading gate
    // so a key pressed before Start cannot become the first playable frame.
    if (document.body.classList.contains("started") && input.pressed("KeyR")) {
      debugPanel.toggleWireframe();
      hud.message(RENDER_TUNING.values.wireframe ? "Wireframe on (R)" : "Wireframe off (R)", 1.4);
    }
    // O: 180° orbit flip around the current look target (camera mode only)
    if (inOrbit() && input.pressed("KeyO")) {
      const duration = Math.max(0.05, CAMERA_TUNING.values.orbitFlipSec);
      const delta = CAMERA_TUNING.values.orbitFlipCCW ? Math.PI : -Math.PI;
      const startDist = orbit.distance;
      const endDist = Math.min(orbit.maxDistance, startDist + CAMERA_TUNING.values.orbitFlipPull);
      orbitFlip = { t: 0, duration, startAz: orbit.azimuthAngle, delta, startDist, endDist };
    }
    // V: voice chat mic on/off (same as the HUD mic button)
    if (input.pressed("KeyV")) toggleMic();
    // T: focus the text chat field (releases pointer lock so you can type)
    if (input.pressed("KeyT")) {
      chat.focus();
      input.releaseLock();
    }
    // F: fullscreen (keydown grants the transient activation this needs)
    if (input.pressed("KeyF")) {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => hud.message("Fullscreen blocked by browser"));
    }
    updateCrownDisplay(frameDt);
    updateBayLights(frameDt);
    updateGoldenGateLights(frameDt);
    // Sutro's beacons are visible city-wide (that's the point) — keep the tiny
    // sprite set resident and just advance its blink clock every frame.
    updateSutroTower(frameDt);

    // left-click tools, all along the true view direction: the ball launches
    // from the hand, paint sticks to whatever the center-screen ray lands on,
    // bubbles ride the wand
    fireCooldown -= frameDt;
    if (input.freeCursor) {
      // free cursor out: clicks only reach UI panels — the ball/spray/bubble
      // tools stand down so pointing around never fires them
    } else if (playingPickleball) {
      // Pickleball consumes click as a paddle swing; do not also fire the
      // selected city tool or a vehicle weapon.
    } else if (golf?.capturesFire) {
      // golf swing context: the held mouse is the power meter (gameplay/golf
      // reads input.firing itself) — every click-tool stands down
    } else if (archery?.capturesFire) {
      // archery draw context: the held mouse pulls the bow (gameplay/archery
      // reads input.firing itself) — every click-tool stands down
    } else if (player.mode === "drone") {
      if (!input.suspended && input.firePressed && fireCooldown <= 0) {
        chase.lookDir(aim);
        fireCooldown = 0.22;
        fireworks.launchDroneSalvo(droneFireworkMounts ?? [], aim, player.velocity);
        chase.shake(0.08);
      }
    } else if (input.firing && embodiments.currentAnimal === "raccoon") {
      // mounted raccoon: the click-tools stand down, the gummy cannon speaks
      if (fireCooldown <= 0) {
        chase.interactionDir(aim, player);
        fireCooldown = 0.13;
        chase.viewOrigin(rayOrigin, player);
        forest?.fireGummy(rayOrigin, aim, player.velocity);
      }
    } else if (tool === "ball") {
      // Hold to wind up overhand (meter fills); release after 1s to throw,
      // earlier stows. Hands empty afterward — pick balls back up with E.
      if (fetchBall) {
        chase.interactionDir(aim, player);
        const cancelled =
          input.suspended || (input.device === "kb" && (!input.locked || !document.hasFocus()));
        fetchBall.driveThrow(frameDt, input.firing && !input.suspended, aim, cancelled);
      }
    } else if (input.firing) {
      chase.interactionDir(aim, player);
      chase.viewOrigin(rayOrigin, player);
      if (tool === "spray" && fireCooldown <= 0) {
        // paintballs: visible ballistic shots that splat wherever they land —
        // walls via graffiti.burst, vehicles/players via paintSkins. The shot
        // is broadcast (origin+velocity+color) so everyone sees it fly.
        fireCooldown = 0.12;
        const col = graffiti.nextColor();
        // In a plane, fire down the nose, not the free-look camera: the mouse
        // steers the plane and the camera on different rates, so the view drifts
        // off the flight path. Inherit the full airspeed (not 0.6) and add the
        // muzzle speed on top, so a ball always outruns the plane — at boost the
        // old 0.6 inherit + 52 muzzle was slower than the plane and trailed it.
        const fromNose = player.mode === "plane";
        const shotDir = fromNose ? player.flyForward : aim;
        paintDir
          .copy(shotDir)
          .addScaledVector(paintTmp.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5), 0.035)
          .normalize();
        paintVel.copy(paintDir).multiplyScalar(PAINTBALL_SPEED).addScaledVector(player.velocity, fromNose ? 1 : 0.6);
        // clear the fuselage (half-length 2.6) so the ball spawns off the nose
        paintMuzzle.copy(rayOrigin).addScaledVector(shotDir, fromNose ? 3.5 : 1.1);
        paintballs.spawn(paintMuzzle.x, paintMuzzle.y, paintMuzzle.z, paintVel.x, paintVel.y, paintVel.z, col, net.selfId);
        net.sendPaint(paintMuzzle, paintVel, col.getHex());
      } else if (tool === "bubbles" && fireCooldown <= 0) {
        fireCooldown = 0.14;
        bubbles.blow(rayOrigin, aim, player.velocity);
      }
    }

    // Z (hold): the trackpad scrubs time of day instead of the camera. Consumes
    // mouseDX/wheelX before the fly controller and chase camera see them, so
    // the view holds still while the light sweeps. Uses holding() so it still
    // works in camera-orbit mode (where input is otherwise suspended).
    // N (hold): horizontal trackpad → look sensitivity; vertical → move speed.
    const scrubHeld = !worldArrival.active && input.holding("KeyZ");
    const adjustHeld = !worldArrival.active && input.holding("KeyN");
    const flipping = orbitFlip !== null;
    if (inOrbit()) orbit.enabled = !scrubHeld && !adjustHeld && !flipping; // don't let orbit eat the drag/wheel
    if (orbitFlip) {
      orbitFlip.t += frameDt;
      const u = Math.min(1, orbitFlip.t / orbitFlip.duration);
      const eased = u * u * (3 - 2 * u); // smoothstep — zero velocity at ends
      orbit.azimuthAngle = orbitFlip.startAz + orbitFlip.delta * eased;
      orbit.distance = orbitFlip.startDist + (orbitFlip.endDist - orbitFlip.startDist) * eased;
      if (u >= 1) orbitFlip = null;
    }
    if (scrubHeld && !timeScrub) timeScrub = { target: sky.timeOfDay, wasCycling: sky.cycleEnabled };
    if (timeScrub) {
      if (scrubHeld) {
        sky.cycleEnabled = false;
        timeScrub.target += input.mouseDX * 0.01 + input.wheelX * 0.005;
        input.mouseDX = 0;
        input.mouseDY = 0;
        input.wheelX = 0;
        input.wheel = 0; // momentum scroll must not zoom the camera mid-scrub
      }
      // shortest way around the 24h wrap, critically-damped ease
      const d = ((((timeScrub.target - sky.timeOfDay) % 24) + 36) % 24) - 12;
      sky.advanceCivilHours(d * (1 - Math.exp(-frameDt * 10)));
      hud.message(clock12(sky.timeOfDay), 0.8);
      if (!scrubHeld && Math.abs(d) < 0.01) {
        sky.cycleEnabled = timeScrub.wasCycling;
        timeScrub = null;
      }
    }
    if (adjustHeld) {
      const look = INPUT_TUNING.values;
      const nextLook = THREE.MathUtils.clamp(
        look.lookSensitivity + input.mouseDX * 0.002 + input.wheelX * 0.001,
        0.25,
        3
      );
      const nextSpeed = THREE.MathUtils.clamp(
        look.moveSpeedScale - input.mouseDY * 0.002 - input.wheel * 0.001,
        0.4,
        2.5
      );
      if (nextLook !== look.lookSensitivity) {
        look.lookSensitivity = nextLook;
        saveTweak("input.lookSensitivity", nextLook);
      }
      if (nextSpeed !== look.moveSpeedScale) {
        look.moveSpeedScale = nextSpeed;
        saveTweak("input.moveSpeedScale", nextSpeed);
      }
      input.mouseDX = 0;
      input.mouseDY = 0;
      input.wheelX = 0;
      input.wheel = 0;
      hud.message(
        `Look ${look.lookSensitivity.toFixed(2)}× · Move ${look.moveSpeedScale.toFixed(2)}×`,
        0.8
      );
    }

    // fly: mouse steers the plane at frame rate; W/S throttle happens in the fixed step
    if (player.mode === "plane") player.steerFly(input, frameDt);
    // Latch hoverboard ollies at render-frame rate. On high-refresh displays a
    // frame can render without a fixed physics step, so `pressed()` would be gone
    // before #updateBoard saw it.
    if (!playingPickleball && !input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
    if (
      !playingPickleball &&
      !input.suspended &&
      player.mode === "surf" &&
      (input.pressed("Space") || input.pressed("KeyX"))
    ) player.requestSurfFlow();
    if (!playingPickleball && !input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();

    chase.lookDir(aim); // drone moves along the true view direction (no shot bias)
    tracer.begin("physics");
    physics.maintainStreaming(player.position);
    let steps = 0;
    while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
      if (playingPickleball) input.setSuspensionHold("pickleball-step", true);
      player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
      if (playingPickleball) input.setSuspensionHold("pickleball-step", false);
      abandonedMounts.prePhysics(physics.world.fixedTimeStep);
      physics.step(physics.world.fixedTimeStep);
      accumulator -= physics.world.fixedTimeStep;
      steps++;
    }
    if (steps === 3) accumulator = 0;
    tracer.end("physics");
    tracer.begin("world");

    // everyone else's interpolation advances BEFORE my pose settles: a
    // passenger's seat is glued to this frame's view of the driver's car
    remotes.selfId = net.selfId;
    remotes.update(frameDt);
    hidePickleballRemoteAvatars();
    // personal space: standing inside another avatar shimmers like z-fighting
    player.separateFromAvatars(remotes.walkingPositions(), frameDt);
    if (embodiments.passengerOf !== null) {
      if (remotes.ridePose(embodiments.passengerOf, ridePos, rideQuat)) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      } else {
        // driver left, parked, or switched modes — back on our feet right here
        embodiments.leaveRide();
        hud.message("Your ride ended", 2.2);
      }
    } else {
      // interpolate the render transform between the last two physics states so
      // 120 Hz frames don't see a 60 Hz stutter
      player.afterSteps(steps, accumulator / physics.world.fixedTimeStep);
      player.syncMesh(frameDt);
    }
    applyPickleballPlayerPose();
    consumeCarLandingFeedback();
    const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
    highUp = highUp ? altitude > 110 : altitude > 150;
    // Optional park chunks remain unfetched until first approach. Capture the
    // callback before invoking it because each loader clears its own one-shot.
    if (
      !worldArrival.active &&
      wakeDeferredGarden &&
      Math.hypot(player.position.x - GARDEN_XZ.x, player.position.z - GARDEN_XZ.z) < 900
    ) {
      const wake = wakeDeferredGarden;
      wakeDeferredGarden = null;
      wake();
    }
    if (
      !worldArrival.active &&
      wakeDeferredTeaGarden &&
      Math.hypot(
        player.position.x - JAPANESE_TEA_GARDEN_ENTRANCE.x,
        player.position.z - JAPANESE_TEA_GARDEN_ENTRANCE.z
      ) < 700
    ) {
      const wake = wakeDeferredTeaGarden;
      wakeDeferredTeaGarden = null;
      wake();
    }
    if (
      !worldArrival.active &&
      wakeDeferredBuenaVistaTrees &&
      nearBuenaVista(player.position.x, player.position.z, 1150)
    ) {
      const wake = wakeDeferredBuenaVistaTrees;
      wakeDeferredBuenaVistaTrees = null;
      wake();
    }
    if (
      !worldArrival.active &&
      wakeDeferredWildlandsGolf &&
      (
        // Buena Vista owns the Corona skyline separately. Wake the primary
        // Wildlands only on a real approach to one of its four regions.
        nearPrimaryWildRegion(player.position.x, player.position.z, 320) ||
        Math.hypot(player.position.x - GOLF_XZ.x, player.position.z - GOLF_XZ.z) < 700
      )
    ) {
      const wake = wakeDeferredWildlandsGolf;
      wakeDeferredWildlandsGolf = null;
      wake();
    }
    // high over the city streams buildings only — no park lawns / trees uploaded.
    // turbo while the loading cover is still up (see the settle gate)
    tiles.update(player.position.x, player.position.z, highUp, !revealed);
    trafficLights?.update(player.position, performance.now() / 1000);
    streetLamps?.update(player.position);
    abandonedMounts.update(frameDt, player.position);
    if (!worldArrival.active) {
      creatures?.update(elapsed, camera.position); // gulls live at altitude — never distance-gated
      forest?.update(frameDt, camera.position);
    }
    // Night ball glow amount from the current sun elevation (park / fetch / held /
    // pickleball all read BALL_GLOW_NIGHT). Uses last sky.update's elevation —
    // fine; elevation only moves with the clock.
    syncBallGlowNight(sky.sunElevation);
    if (!worldArrival.active) coronaHeights?.update(frameDt, elapsed, camera.position);
    if (!worldArrival.active) landsEnd?.update(frameDt, elapsed, player.position);
    if (!worldArrival.active && landsEnd && player.mode === "walk") {
      landsEnd.keeper.updatePrompt(player.position.x, player.position.z, hud);
    }
    // Ball fetch loop + pet follow run every frame, tool-agnostic, so a thrown
    // ball keeps bouncing and a returning/adopted dog keeps moving even after
    // switching tools. verb() keeps the HUD Click row in sync with hold-to-throw.
    const petSeat = player.mode === "scooter" && !remotes.hasPassenger(net.selfId)
      ? (player.meshes.scooter.userData.petSeat as THREE.Object3D | undefined) ?? null
      : null;
    if (!worldArrival.active) fetchBall?.update(frameDt, elapsed, player.position, petSeat);
    if (tool === "ball" && fetchBall) hud.setToolVerb(fetchBall.verb());
    // brief over-the-shoulder pull-in during a throw, then ease back. Set before
    // chase.update (below) so it reads this zoom; gated to walk so the wheel-zoom
    // (walk+outdoor) never fights it, and restored the moment the throw settles.
    if (player.mode === "walk" && fetchBall && fetchBall.throwProgress() >= 0) {
      if (throwZoomBase < 0) throwZoomBase = chase.zoom;
      chase.zoom = THREE.MathUtils.lerp(chase.zoom, 0.55, 0.15);
    } else if (throwZoomBase >= 0) {
      chase.zoom = THREE.MathUtils.lerp(chase.zoom, throwZoomBase, 0.2);
      if (Math.abs(chase.zoom - throwZoomBase) < 0.02) {
        chase.zoom = throwZoomBase;
        throwZoomBase = -1;
      }
    }
    gardenDisplacer.x = player.renderPosition.x;
    gardenDisplacer.z = player.renderPosition.z;
    updateVegetationEnvironment(frameDt, foliageOn ? gardenDisplacers : undefined);
    const oceanKiteDx = player.position.x - oceanKiteSite.x;
    const oceanKiteDz = player.position.z - oceanKiteSite.z;
    if (
      revealed &&
      !oceanBeachKite &&
      !oceanBeachKiteLoading &&
      oceanKiteDx * oceanKiteDx + oceanKiteDz * oceanKiteDz <
        OCEAN_KITE_LOAD_DISTANCE * OCEAN_KITE_LOAD_DISTANCE
    ) {
      void ensureOceanBeachKite();
    }
    oceanBeachKite?.update(frameDt, elapsed, player.renderPosition, windGustValue());
    buskers.update(frameDt, camera, windGustValue(), sky.sunElevation);
    if (!worldArrival.active) {
      japaneseTeaGarden?.update(
        frameDt,
        elapsed,
        player.renderPosition,
        camera,
        player.mode,
        player.velocity
      );
    }
    // MASTER foliage gate: when the "/" panel's foliage switch is OFF, every
    // vegetation group is already hidden (setFoliageVisible) — skip all its
    // per-frame work too so it costs near zero. We STILL advance the shared wind
    // envelope (cheap CPU math, no rendering) because the nature soundscape below
    // reads its gust value for wind audio.
    if (foliageOn && !worldArrival.active) {
      // Garden moves its near-grass detail ring to the player. Shared wind and
      // displacement were already advanced by the root vegetation runtime above.
      // Cheap when the player is nowhere near the garden
      // (updateFocus distance-culls base chunks and skips the near ring).
      garden?.update(player.renderPosition);
      // wildlands: the grass + flower rings follow the PLAYER (like the garden ring
      // above) so they stay put when you just look around — the chase camera orbits
      // the player, and anchoring the rings to it slid the whole field around you.
      // Tree distance-culling still follows the camera so off-screen groves drop.
      wildlands?.update(player.renderPosition, camera.position);
      buenaVistaTrees?.update(camera.position);
    }
    // Nature soundscape rides the same root vegetation gust envelope,
    // and reads the sky clock for dawn choruses / night owls. Cheap out in the
    // city (suspends), so it's safe to tick unconditionally.
    nature.update(frameDt, {
      playerPos: player.renderPosition,
      camera,
      gust: windGustValue(),
      timeOfDay: sky.timeOfDay,
      allowNewLoads: !worldArrival.active
    });
    // live loop only: the dogs freeze during pause, so barking there would lie
    dogParkAudio.update(frameDt, player.renderPosition);
    if (embodiments.currentAnimal) forest?.setRiddenSpeed(player.speed);
    if (!worldArrival.active) islands.update(elapsed, camera.position);
    // Baked destination tiles already provide the fixed-quality arrival view.
    // CityGen hydrates its richer cells only after the local visual/collision
    // transaction finishes, so it never competes with teleport-critical work.
    if (!worldArrival.active) citygenRing.current?.update(player.position, frameDt);
    if (!worldArrival.active && !highUp) hunt.update(frameDt, elapsed, player.position);
    if (!worldArrival.active) golf?.update(frameDt, elapsed, { player, input, hud, chase, camera });
    if (!worldArrival.active) palaceReverie?.update(frameDt, elapsed, player.position, hud);
    if (!worldArrival.active) {
      const welcome = palaceReverie?.takeWelcome();
      if (welcome) hud.message(welcome, 6.2);
    }
    // Archery: site-gated, one boolean early-return when asleep with nothing live
    if (!worldArrival.active) archery?.update(frameDt, elapsed, { player, input, hud, chase, camera });
    // Afterlight: proximity collectibles, return flights, quest clock and the
    // completed sky performance; site-gated to a single asleep early return.
    if (!worldArrival.active) afterlight?.update(frameDt, elapsed, player, hud);
    // Goldman clubhouse NPCs: one-hypot early return when far — safe every frame
    if (!worldArrival.active) goldenGateTennis?.update(frameDt, elapsed, player.position);
    // Mission Dolores: dynamic code gate first, then shell/art proximity gates.
    if (!worldArrival.active) ensureMissionDolores(player.position);
    if (!worldArrival.active) missionDolores?.update(frameDt, elapsed, player.position, player.mode, hud);
    const museumFloorHandoff = worldArrival.active
      ? null
      : missionDolores?.takeFloorHandoffHeight(player.position, player.mode);
    if (museumFloorHandoff != null) player.recoverOntoWalkSurface(museumFloorHandoff);

    // "hop in" nudge when standing near a ride (friend → wildlife)
    if (!worldArrival.active && player.mode === "walk" && embodiments.passengerOf === null) {
      const drv = remotes.nearestDriver(player.position, 5.5);
      const nearAnimal = drv ? null : forest?.nearest(player.position, 5);
      const nearSurfBreak =
        !drv && !nearAnimal && nearOceanBeachShore(player.position.x, player.position.z);
      const reveriePrompt =
        !drv && !nearAnimal && !nearSurfBreak
          ? palaceReverie?.nearbyPrompt(player.position.x, player.position.z) ?? null
          : null;
      if ((drv || nearAnimal || nearSurfBreak || reveriePrompt) && !ridePromptShown) {
        hud.message(
          drv
            ? `E — ride with ${drv.name}`
            : nearAnimal
              ? `E — ride the ${nearAnimal.label}`
              : nearSurfBreak
                ? "E — start surfing at Ocean Beach"
                : (reveriePrompt as string),
          1.8
        );
        ridePromptShown = true;
      }
      if (!drv && !nearAnimal && !nearSurfBreak && !reveriePrompt) ridePromptShown = false;
      // "open the door" nudge — same one-shot pattern; the ride prompt wins
      // when both are in range. nearestDoor is alloc-light but not free, so
      // it runs every 6th frame (prompt latency ~0.1 s) and only on foot.
      if (--doorScanCountdown <= 0) {
        doorScanCountdown = 6;
        doorScanHit = citygenRing.current?.nearestDoor(player.position) ?? null;
      }
      const door = doorScanHit;
      const nearClosedDoor = !!door && !door.open && door.dist < 3.2;
      if (nearClosedDoor && !drv && !nearAnimal && !doorPromptShown) {
        hud.message("E — open the door", 1.8);
        doorPromptShown = true;
      }
      if (!nearClosedDoor) doorPromptShown = false;
    } else {
      ridePromptShown = false;
      doorPromptShown = false;
    }
    chase.activityFirstPerson = archery?.firstPersonActive ?? false;
    if (cineHook) {
      chase.suspend(player);
      cineHook(frameDt); // scripted cinematic owns pose + camera
    } else if (golf?.updateBallCam(frameDt, camera)) {
      chase.suspend(player);
      // golf flight cam: chases the ball until it settles, then hands back
    } else if (inOrbit()) {
      chase.suspend(player);
      orbit.update(frameDt);
    } else {
      chase.indoor = (citygenRing.current?.isPlayerInside() ?? false) || (missionDolores?.isPlayerInside(player.position) ?? false); // blend into the indoor eye rig
      chase.update(frameDt, player, input);
    }
    // World-anchored dialogue must project after the chase/orbit/cinematic has
    // committed this frame's final camera pose; projecting during simulation
    // left Hiro's card one camera frame behind and visibly jittering.
    japaneseTeaGarden?.project(camera);
    sky.update(elapsed, camera.position, player.renderPosition);
    water.update(elapsed, camera.position, player.renderPosition, player.mode === "surf");
    oceanBeachWaves?.update(elapsed, player.renderPosition);
    // Safety net + shore warm: rebuild the face mesh while surfing or standing
    // at the waterline so the first E never lands on an empty bay sheet.
    if (
      !oceanBeachWaves &&
      (player.mode === "surf" ||
        (player.mode === "walk" && nearOceanBeachShore(player.position.x, player.position.z)))
    ) {
      void ensureSurfRuntime();
    } else if (
      oceanBeachWaves &&
      player.mode !== "surf" &&
      !nearOceanBeachShore(player.position.x, player.position.z)
    ) {
      releaseSurfVisual();
    }
    underwater.update(camera, elapsed);
    seaPillars.update(player.renderPosition, elapsed);
    fx.update(frameDt);
    bubbles.update(frameDt, elapsed);
    wake.update(frameDt, elapsed, player);
    boardWake.update(frameDt, elapsed, player);
    birdTrails.update(elapsed, player);
    splashes.update(frameDt, elapsed, player);
    surfExperience?.update(frameDt, player.mode, player.surfTelemetry);
    if (player.mode === "surf" && player.surfTelemetry.splashSerial !== surfSplashSerial) {
      surfSplashSerial = player.surfTelemetry.splashSerial;
      splashes.splash(
        player.renderPosition.x,
        waterHeight(player.renderPosition.x, player.renderPosition.z, elapsed),
        player.renderPosition.z,
        elapsed,
        player.surfTelemetry.splashEnergy,
        // Surf uses a close chase/orbit camera. Keep the authored spray layers
        // and ring energy, but size the sprites for readable rider hero shots.
        0.4
      );
    }
    updateSurfPresentation(frameDt);
    waveAudio.update(frameDt, oceanWaveEnergyAt(map, player.position.x, player.position.z, elapsed));
    // Explicit E/B is the normal exit. This far-away guard only repairs external
    // teleports that bypass NavigationController; the ride itself never beaches.
    if (player.mode === "surf") {
      const b = OCEAN_BEACH_SURF;
      const farFromBreak =
        player.position.x < b.minX - 500 ||
        player.position.x > b.maxX + 500 ||
        player.position.z < b.minZ - 500 ||
        player.position.z > b.maxZ + 500;
      if (farFromBreak) exitToWalk();
    }
    // On foot at Ocean Beach you carry your board, ready to start the activity.
    player.setCarryingBoard(
      player.mode === "walk" && nearOceanBeachShore(player.position.x, player.position.z)
    );
    vehicleAudio.update(frameDt, {
      mode: player.mode,
      speed: player.speed,
      vspeed: player.velocity.y,
      boost: input.down("ShiftLeft"),
      grounded: player.mode !== "board" || player.boardGrounded,
      surfFace: player.mode === "surf" ? player.surfTelemetry.face : 0,
      surfFlow: player.mode === "surf" && player.surfTelemetry.flowActive ? 1 : 0,
      surfMotionRate: player.mode === "surf" ? player.surfTelemetry.riderMotionRate : 1,
      driveVoice: player.driveSpec.voice ?? "engine"
    });
    swimAudio.update(frameDt, {
      swimming: player.swimming,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      vspeed: player.velocity.y
    });
    // B launches fireworks ahead of the player along the camera heading; airborne
    // modes push them further out and up to the player's altitude
    fireworks.update(frameDt, {
      hold: input.down("KeyB"),
      origin: player.renderPosition,
      yaw: chase.yaw,
      fly: player.mode === "plane" || player.mode === "drone" || player.mode === "bird",
      speed: player.speed
    });
    // multiplayer: publish my pose (the active mesh carries the render-ready
    // position AND facing — walk's body quat is pinned, the mesh isn't; the
    // ride id lets viewers glue me into my driver's car), redraw the minimap.
    // remotes.update already ran before the passenger glue above.
    sendLocalPresence();
    sendPickleballNetwork();
    voice.update(camera); // listener follows the camera, voices follow the avatars
    minimap.update();
    playerLocator.update(camera, player.position, remotes.locatorTargets());

    // Sync the raycastable-entity proxies once, after everyone is posed: remote
    // avatars and me (id = net.selfId, tagged self so the cursor skips it but
    // remote paint still lands). paintballs + cursor then just query.
    entityProxies.begin();
    for (const a of remotes.avatars.values()) {
      const body = a.mode ? a.bodies[a.mode] : undefined;
      if (!body || !body.visible || !a.root.visible) continue;
      const hitSphere = PAINT_HIT[a.mode!];
      entityProxies.put(
        a,
        { id: a.info.id, kind: "avatar", object: body, shape: { form: "sphere", radius: hitSphere.r } },
        a.root.position.x,
        a.root.position.y + hitSphere.y,
        a.root.position.z
      );
    }
    {
      const mesh = player.meshes[player.mode];
      const hitSphere = PAINT_HIT[player.mode];
      entityProxies.put(
        player,
        { id: net.selfId, kind: "player", object: mesh, shape: { form: "sphere", radius: hitSphere.r }, self: true },
        mesh.position.x,
        mesh.position.y + hitSphere.y,
        mesh.position.z
      );
    }
    // Busker trio: chest spheres so camera-mode double-click can retarget onto
    // a singer instead of punching through the mesh to the city behind them.
    if (buskers.group.visible) {
      buskers.forEachPickTarget((id, object, x, y, z) => {
        entityProxies.put(
          `busker:${id}`,
          { id: BUSKER_PICK_ID[id], kind: "prop", object, shape: { form: "sphere", radius: BUSKER_PICK_R } },
          x,
          y,
          z
        );
      });
    }
    entityProxies.end();
    paintballs.update(frameDt, worldQueries, graffiti, paintSkins);
    paintSkins.update(frameDt, scene);

    // The in-world cursor: a glowing orb that rests where you're pointing. It
    // sits centre-screen while the mouse is captured (a soft aim reticle too),
    // and rides the free mouse ray while Command is held. Runs after the entity
    // proxies are synced so its depth is world-aware: a hovered bus/car/avatar
    // lifts it onto their near face instead of letting the ray punch through to
    // the ground behind.
    {
      const cursorLive =
        document.body.classList.contains("started") &&
        player.mode !== "surf" &&
        !inOrbit() &&
        !input.suspended &&
        !cineHook &&
        !(paused && freezePlayer);
      if (cursorLive) {
        aimRay(rayOrigin, aim);
        // rest on the nearest thing the ray meets — entity, building, terrain
        // or water (never my own body) — for honest depth; else float ahead
        const hit = worldQueries.raycast(rayOrigin, aim, 60, { ignoreSelf: true });
        if (hit) cursorPos.copy(hit.point);
        else cursorPos.copy(rayOrigin).addScaledVector(aim, 22);
        worldCursor.update(frameDt, camera, cursorPos, 0, true);
      } else {
        worldCursor.update(frameDt, camera, cursorPos, 0, false);
      }
    }

    hud.update(frameDt);
    tutorial.update(frameDt);
    debugPanel.refresh();

    sessionPersistence.update(frameDt);

    syncColliderDebug(); // debug x-ray of active colliders (no-op unless toggled)
    // grey cards ride the FINAL camera pose (chase or cine hook both settled above)
    calibrationChart.sync(camera, Boolean(RENDER_TUNING.values.greyCards));
    tracer.end("world");

    // Drain deferred bursty work (streamed bodies, citygen assembly, warmups)
    // under a headroom-scaled budget: fast frames catch up, tight frames yield.
    // Behind the opaque loading cover nothing is visible, so the budget jumps
    // to 24 ms/frame and the settle gate re-checks after every drain.
    tracer.begin("sched");
    scheduler.run(revealed ? (frameDt < 1 / 55 ? 3 : frameDt < 1 / 35 ? 1.5 : 0.8) : 24);

    if (!initialArrivalReleased) {
      if (initialVisualState === "pending" && performance.now() >= initialVisualDeadlineAt) {
        initialVisualState = "fallback";
      }
      const initialStatus = physics.collisionArrivalStatus(initialCollisionEpoch);
      initialCollisionReady = initialStatus.ready;
      if (initialVisualState === "fallback" && !initialVisualFailureReported) {
        initialVisualFailureReported = true;
        console.warn("[boot] local building visuals unavailable; continuing with the terrain fallback");
        hud.message("Some neighborhood detail could not load — the map can take you somewhere else", 8);
      }
      if (initialStatus.failedColliderTiles > 0 && initialCollisionRetryCycles < 1) {
        const restarted = physics.retryCollisionArrival(initialCollisionEpoch);
        if (restarted > 0) {
          initialCollisionRetryCycles++;
          console.warn(`[boot] retrying ${restarted} failed local collision tile${restarted === 1 ? "" : "s"}`);
        }
      } else if (
        initialStatus.failedColliderTiles > 0 &&
        initialCollisionRetryCycles >= 1 &&
        !initialCollisionFailureReported
      ) {
        initialCollisionFailureReported = true;
        console.warn("[boot] local collision remains unavailable; player stays fail-closed");
        hud.message("This spot could not settle safely — open the map and choose another place", 8);
      }
      if (initialVisualState !== "pending" && initialCollisionReady) {
        if (physics.completeCollisionArrival(initialCollisionEpoch)) {
          initialArrivalReleased = true;
          player.releaseWorldArrivalHold("boot-arrival");
          tiles.resumeBackgroundStreaming();
        } else {
          initialCollisionReady = false;
        }
      }
    }

    settleTick();
    tracer.end("sched");

    input.endFrame();
    tracer.begin("render");
    renderFrame();
    tracer.end("render");
    diagnostics.updateStats();
  };
  const frameDriver = startFrameDriver({
    renderer,
    camera,
    app,
    tick,
    tracer,
    isRevealed: () => revealed
  });
  // Deterministic capture stops the wall-clock loop so tools can drive tick(dt).
  (window as never as { __sfManual: (on: boolean) => void }).__sfManual = frameDriver.setManual;

  // Dev/profile-only free camera for headless render probes: locks the camera
  // to a fixed eye→target via the cine hook (owns pose+camera, so chase can't
  // fight it). `profile` makes the production-preview probe path functional;
  // ordinary production sessions expose nothing. Pass null to release.
  if (import.meta.env.DEV || new URLSearchParams(location.search).has("profile")) {
    (window as never as { __sfFreeCam: (eye: [number, number, number] | null, target?: [number, number, number]) => void }).__sfFreeCam = (
      eye,
      target = [0, 0, 0]
    ) => {
      if (!eye) {
        cineHook = null;
        return;
      }
      cineHook = () => {
        camera.position.set(eye[0], eye[1], eye[2]);
        camera.up.set(0, 1, 0);
        camera.lookAt(target[0], target[1], target[2]);
        camera.updateMatrixWorld();
      };
    };
  }

  console.log("[sf] city online (webgpu)");

  // Retained in the profiling hook for shadow probe compatibility; dynamic
  // resolution is currently owned internally by the render pipeline.
  const dynRes = undefined;

  const exposeDebugHooks = () => {
    Object.assign(window as never, {
      // renderIdle: probes MUST wait for this before capture phases — while the
      // deferred render warmup runs, tick() early-returns without rendering, so
      // screenshots would capture a stale boot-pose frame no matter what the
      // camera was set to.
      __sf: { scene, camera, player, tiles, physics, renderer, pipeline, dynRes, tracer, scheduler, POSTFX_TUNING, WORLD_TUNING, FLOWER_TUNING, RENDER_TUNING, CAR_LANDING_TUNING, chase, map, input, hud, fx, fireworks, graffiti, bubbles, setTool, setColor, sky, farOcclusion, debugPanel, CONFIG, THREE, tick, creatures, forest, garden, wildlands, buenaVistaTrees, goldenGateTennis, japaneseTeaGarden, pickleball: pickleballController?.game ?? null, pickleballAmbient: pickleballController?.ambient ?? null, pickleballAudio: pickleballController?.audio ?? null, pickleballUI: pickleballController?.ui ?? null, pickleballController, coronaHeights, missionDolores, splashes, vehicleAudio, swimAudio, nature, dogParkAudio, net, remotes, voice, minimap, playerLocator, boardWake, abandonedMounts, paintballs, paintSkins, hunt, satchel, buildShareUrl, tutorial, fetchBall, goldenGateLights, teleportToTarget, trafficLights, streetLamps, citygen, citygenRing, worldCursor, worldQueries, buildingRayRefiner, underwater, seaPillars, water, oceanBeachWaves, surfExperience, ensureSurfRuntime, roadMarkings, colliderDebug, calibrationChart, FOLIAGE_TUNING, CITYGEN_TUNING, setFoliageVisible, buskers, boardSelector, ensureSurfboardCustomizer, getSurfboardConfig: () => ({ ...surfboardConfig }), siteGate, palaceReverie, landsEnd, afterlight, optionalWorldSites, ensureOptionalWorldSite,
        TSL,
        renderIdle: () => modulesReady && !optionalWorldSites.some(
          (site) => site.state === "queued" || site.state === "loading"
        ) }
    });
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) {
      Object.assign(hooks, {
        worldArrival,
        oceanBeachKite,
        ensureOceanBeachKite,
        oceanKiteSite
      });
    }
  };
  if (import.meta.env.DEV || new URLSearchParams(location.search).has("profile")) {
    exposeDebugHooks();
  }

  if (import.meta.env.DEV) {
    const demoCtx = {
      input,
      player,
      physics,
      chase,
      camera,
      scene,
      hud,
      sky,
      minimap,
      map,
      buskers,
      get afterlight() { return afterlight ?? undefined; },
      fetchBall: fetchBall ?? undefined,
      get coronaHeights() { return coronaHeights ?? undefined; },
      get palaceReverie() { return palaceReverie ?? undefined; },
      get landsEnd() { return landsEnd ?? undefined; },
      fireworks,
      worldQueries,
      setTool: (t: string) => setTool(t as ToolName),
      setBoardConfig: (config: typeof boardConfig) => {
        applyBoardConfig(config);
        boardSelector.setConfig(config);
      },
      setCine: (fn: ((dt: number) => void) | null) => {
        cineHook = fn;
      },
      setExposure: (v: number) => {
        renderer.toneMappingExposure = v;
      },
      setPostFx: (values: Record<string, number | boolean>) => {
        Object.assign(POSTFX_TUNING.values, values);
        pipeline.applyPostFx(); // select the retained toggle variant + push uniforms
      }
    };
    const ensureDemoSite = async (name: string): Promise<void> => {
      const site: OptionalSiteId | null =
        name === "afterlight" ? "afterlight" :
        name === "palace" || name === "palace-reverie" ? "palace" :
        name === "landsend" ? "lands-end" :
        null;
      if (site) await ensureOptionalWorldSite(site);
    };
    const runDevDemo = async (name: string): Promise<void> => {
      await ensureDemoSite(name);
      const { runDemo } = await import("./dev/demo");
      runDemo(name, demoCtx);
    };
    (window as never as { __demo: (n: string) => void }).__demo = (n: string) => {
      void runDevDemo(n);
    };
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo) {
      await runDevDemo(demo);
    }
  }
}

boot().catch((err) => {
  console.error("[boot] fatal:", err);
  bootScreen.fail(err);
});
