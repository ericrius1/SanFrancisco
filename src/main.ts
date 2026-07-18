// Soft-HMR guard must register before any other import.meta.hot listeners.
import { suppressesFullReload } from "./app/hmr/suppressFullReload";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import CameraControls from "camera-controls";
import { CAMERA_TUNING, CITYGEN_TUNING, CONFIG, FLOWER_TUNING, FOLIAGE_TUNING, LIGHT_SCALE, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING } from "./config";
import { resetAllTweaks, saveTweak } from "./core/persist";
import { Input, formatInteractPrompt, localizeInteractText } from "./core/input";
import { tracer } from "./core/hitchTracer";
import { bootMarkStart, bootMark, bootMarkSummary, persistBootHistory } from "./core/bootMarks";
import { createFrameScheduler } from "./core/frameBudget";
import { WorldMap } from "./world/heightmap";
import { OCEAN_BEACH_SURF, nearOceanBeachShore } from "./world/oceanBeachWaves";
import { createSurfShack, type SurfShack } from "./gameplay/surfing/shack";
import { Sky, SKY_TUNING } from "./world/sky";
import { GhostShipBeacon } from "./world/ghostShip/beacon";
import {
  GHOST_SHIP_DETAIL_WAKE_DISTANCE,
  GHOST_SHIP_LANDMARK_NAME,
  GHOST_SHIP_RIDE_ID
} from "./world/ghostShip/route";
import type { GhostShip } from "./world/ghostShip";
import { Water } from "./world/water";
import { emitEmbodimentWaterEcho } from "./world/waterEchoes";
import { UnderwaterOverlay } from "./fx/underwater";
import { syncBallGlowNight } from "./fx/ballGlow";
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
  JAPANESE_TEA_GARDEN_ENTRANCE,
  isTeaGardenBuilding
} from "./world/japaneseTeaGarden/layout";
import { AuthoredRegionStreamer } from "./world/authoredRegions";
import { warmStaticRegion } from "./render/warmStaticRegion";
import { warmHiddenRoot } from "./render/warmHiddenRoot";
import type { CoronaHeightsPark } from "./world/coronaHeights";
import { prepareCoronaHeightsGround } from "./world/coronaHeights/ground";
import type { MissionDoloresMuseum } from "./world/missionDolores";
import { MD_CENTER as MISSION_DOLORES_CENTER } from "./world/missionDolores/layout";
import {
  distanceToSutroBaths
} from "./world/spawnPoints";
import { WILD_REGIONS } from "./world/wildlands/regions";
import { BUENA_VISTA_REGION } from "./world/buenaVista";
import { Player } from "./player/player";
import type { PlayerMode } from "./player/types";
import { ChaseCamera } from "./core/camera";
import { FX } from "./fx/fx";
import { BoardWake, WakeRipples } from "./fx/wake";
import { SkidMarks } from "./fx/skidMarks";
import { BirdTrails } from "./fx/birdTrail";
import { WaterSplashes } from "./fx/splash";
import { Fireworks } from "./fx/fireworks";
import { Graffiti, PAINT_COLORS } from "./fx/graffiti";
import {
  Paintballs,
  PaintSkins,
  PAINTBALL_SPEED
} from "./fx/paintball";
import { Bubbles } from "./fx/bubbles";
import { WorldCursor } from "./fx/worldCursor";
import { WorldQueries, ProxySet } from "./core/worldQueries";
import { BuildingRayRefiner } from "./core/buildingRayRefine";
import { Toolbar, type ToolName } from "./ui/toolbar";
import { createLazySelector } from "./app/compose/selectorHub";
import { AudioControls } from "./ui/audioControls";
import { Chat } from "./ui/chat";
import { VehicleAudio } from "./fx/vehicleAudio";
import { SwimAudio } from "./fx/swimAudio";
import { GameplaySfxBus } from "./audio/gameplaySfxBus";
import { audioEngine } from "./audio/engine";
import { PlayerFoleyAudio } from "./fx/playerFoleyAudio";
import { ModeTransitionAudio } from "./fx/modeTransitionAudio";
import { JumpLandingAudio } from "./fx/jumpLandingAudio";
import { DoorAudio } from "./fx/doorAudio";
import { createNatureSoundscape, DogParkAudio, BallImpactAudio, BALL_IMPACT_AUDIO_TUNING } from "./audio";
import { WaveAudio, oceanWaveEnergyAt } from "./audio/waveAudio";
import { AbandonedMounts, ABANDONED_MOUNT_PROMPT } from "./gameplay/abandonedMounts";
import { spawnScatterBoats } from "./gameplay/scatterBoats";
import type { Creatures } from "./gameplay/creatures";
import type { Forest } from "./gameplay/forest";
import {
  updateVegetationEnvironment,
  windGustValue,
  type GroundDisplacer
} from "./world/vegetation/runtime";
import type { CityGenRing } from "./world/citygen";
import { PROCEDURAL_LAMP_TUNING } from "./world/citygen/interior/lampTuning";
import { Islands } from "./gameplay/islands";
import { Hunt } from "./gameplay/hunt";
import { FetchBall } from "./gameplay/fetchBall";
import { MinigameSessionController, type MinigameOrigin } from "./gameplay/minigameSession";
import { createSiteGate } from "./gameplay/siteGate";
import type { ArcheryGame } from "./gameplay/archery";
import type { PupPen } from "./gameplay/pup";
import type { FortMasonEnsemble } from "./gameplay/fortMasonEnsemble";
import type { PalaceReverieGame } from "./gameplay/palaceReverie";
import type { LandsEndRegion } from "./world/landsEnd";
import { SiteFoliageStreamer } from "./world/vegetation/siteFoliage";
import type { WaveOrgan } from "./world/waveOrgan";
import type { BeachPianist } from "./world/beachPianist";
import type { AfterlightExperience } from "./gameplay/afterlight";
import { isAfterlightOpenAtHour } from "./gameplay/afterlight/meta";
import { Satchel } from "./ui/satchel";
import { HUD } from "./ui/hud";
import { ShareButton } from "./ui/share";
import { PauseToggle } from "./ui/pauseToggle";
// The launcher and reader stay dynamically loaded; a reading entry may create
// the shared reader before this game module begins.
import { beganAsReadingVisit, initialReadLink } from "./app/startupIntent";
import {
  getBehindTheScenes,
  openBehindTheScenes,
  subscribeBehindTheScenes
} from "./ui/behindTheScenesHost";
import { Tutorial } from "./ui/tutorial";
import { createRenderPipeline } from "./render/pipeline";
import { POSTFX_TUNING, setFlowPostFx } from "./render/postfx";
import type { RadialLightSource } from "./render/radialLightTypes";
import { DebugPanel } from "./ui/debug";
import { DebugOverlays } from "./ui/overlays";
import { OVERLAY_TUNING } from "./ui/overlays/tuning";
import { CalibrationChart } from "./ui/calibrationChart";
import { Net } from "./net/net";
import { RemotePlayers } from "./net/remotes";
import { Voice } from "./net/voice";
import { Minimap } from "./ui/minimap";
import { PlayerLocator } from "./ui/playerLocator";
import { avatarFromSeed, loadSavedAvatar, randomAvatarTraits, saveAvatarTraits } from "./player/avatar";
import { boardFromSeed, boardVisualKey, loadSavedBoard, randomBoardConfig, saveBoardConfig, setLocalBoardConfig } from "./vehicles/board";
import {
  CAR_LANDING_TUNING,
  carFromSeed,
  carKey,
  loadSavedCar,
  randomCarConfig,
  refreshCarHeadlightUniforms,
  saveCarConfig,
  setLocalCarConfig
} from "./vehicles/car";
import { loadSavedScooter, randomScooterConfig, saveScooterConfig, scooterFromSeed, scooterKey, setLocalScooterConfig } from "./vehicles/scooter";
import { passengerCapacity } from "./vehicles/rideable";
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
import { createBuskerConversation } from "./gameplay/buskers/conversation";
import { createSessionPersistence } from "./app/sessionPersistence";
import { startFrameDriver } from "./app/frameDriver";
import { createGameLoop } from "./app/gameLoop";
import { createAdaptiveResolution } from "./render/adaptiveResolution";
import { isInGameScreenshotBusy, takeInGameScreenshot } from "./app/inGameScreenshot";
import { EmbodimentController } from "./app/player/embodimentController";
import { createCarLandingFeedback } from "./app/compose/carLanding";
import { createTimeScrubAndTuningGestures } from "./app/compose/timeScrub";
import {
  GARDEN_XZ,
  GOLF_XZ,
  registerActivityLandmarks,
  registerParkLandmarks
} from "./app/compose/minimapLandmarks";
import { wireEscapeStack } from "./app/compose/escapeStack";
import { createOceanKiteGate } from "./app/compose/oceanKite";
import { createBackgroundAdmission } from "./app/compose/backgroundAdmission";
import { resolveInitialArrival } from "./app/compose/initialArrival";
import { createToolCycle } from "./app/compose/toolCycle";
import { createTeaGardenController } from "./app/compose/teaGarden";
import { createOptionalSites, type OptionalSiteId } from "./app/compose/optionalSites";
import { NavigationController } from "./app/navigation";
import { WorldArrivalCoordinator } from "./app/worldArrival";
import { writeDevReloadSnapshot } from "./app/hmr/devReloadSnapshot";
import { RendererDiagnostics } from "./app/diagnostics";
import type { PickleballController } from "./app/systems/pickleball";

CameraControls.install({ THREE });

const bootScreen = new BootScreen();
const { app, loading, nameInput, suggestedName } = bootScreen;
const progress = (percent: number, label: string) => bootScreen.progress(percent, label);

type RegionKey = "garden" | "wildlands" | "golf";

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

  progress(40, "streaming the city");
  const tiles = new TileStreamer(scene);
  tiles.onShadowCastersChanged = (scope) => sky.invalidateStaticShadows(scope);
  // Tile batches (buildings/roads/parks) are created lazily on first fold-in;
  // compile their pipelines on the parallel async path the moment they exist so
  // the first live frame that draws them never pays a serial compile (this was
  // a measured ~0.8s of covered settle when left to the sync path).
  tiles.onBatchCreated = (mesh) => {
    void renderer.compileAsync(mesh, camera, scene).catch(() => {});
  };
  await tiles.init(map);
  const authoredRegions = new AuthoredRegionStreamer({
    scene,
    map,
    tiles,
    prepareRoot: async (label, root) => {
      try {
        const warmup = await warmStaticRegion(renderer, camera, scene, root);
        console.info(
          `[authored-region] ${label} warmed ${warmup.representatives}/${warmup.meshes} meshes ` +
          `(${warmup.renderSignatures} render paths) in ${(warmup.durationMs / 1000).toFixed(2)}s`
        );
      } catch (error) {
        // Compilation is a covered presentation optimization. The parsed
        // Blender visual remains valid and can compile on its first live frame.
        console.warn(`[authored-region] ${label} covered compile failed`, error);
      }
    }
  });
  await authoredRegions.init();
  import.meta.hot?.dispose(() => authoredRegions.dispose());
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
    void Promise.all([
      prime.ready,
      authoredRegions.prepareAt({ x, z })
    ]).then(([result]) => {
      if (epoch !== initialVisualEpoch) return;
      if (result.status === "ready") initialVisualState = "ready";
      else initialVisualState = "fallback";
    }).catch((error) => {
      if (epoch !== initialVisualEpoch) return;
      initialVisualState = "fallback";
      console.warn("[boot] required authored region unavailable", error);
    });
  };
  // Spawn/invite/resume resolution + the local visual prime kick-off —
  // extracted per docs/MAIN_DECOMPOSITION.md.
  const initialArrivalPromise = resolveInitialArrival({
    map,
    tiles,
    authoredRegions,
    primeInitialVisual: primeInitialVisualAt
  });

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
  const skidMarks = new SkidMarks(scene, map);
  const splashes = new WaterSplashes(scene, wake, map);
  const fireworks = new Fireworks(renderer, scene, map);
  // Building four audio graphs on the first movement key caused a visible cold
  // input hitch. Fireworks owns the first shared browser audio-device startup,
  // so perform its existing no-network prewarm under the loading cover; later
  // gesture handlers only resume the already-built suspended context.
  fireworks.prewarm();
  // Fundamental player/interaction foley shares one small procedural graph.
  // Prewarming here avoids synthesizing its noise/room buffers on the first W.
  const gameplaySfxBus = new GameplaySfxBus();
  gameplaySfxBus.prewarm();
  audioEngine.prewarm();

  // Space / pad-X toys — ↑/↓ pick the toolbar row, ←/→ cycle within it
  const graffiti = new Graffiti(scene);
  const paintballs = new Paintballs(scene);
  const paintSkins = new PaintSkins();
  // Tea Garden owns the pond water response; teaGarden (created after its region
  // helpers, below) null-checks its own null-until-approached site.
  paintballs.onWaterSegment = (segment) => teaGarden.paintWaterSegment(segment);
  paintballs.onWater = (impact) => {
    if (teaGarden.paintWater(impact)) return;
    // The generic plume is designed for bodies and aircraft. Paint gets a much
    // smaller fallback outside the Tea Garden so it cannot freeze into cyan
    // camera-facing islands across the water plane.
    splashes.splash(impact.x, impact.y, impact.z, elapsed, 0.3, 0.3);
  };
  const bubbles = new Bubbles(scene, map, physics);
  const worldCursor = new WorldCursor(scene);
  type PaintAudioInstance = import("./fx/paintAudio").PaintAudio;
  type BubbleAudioInstance = import("./fx/bubbleAudio").BubbleAudio;
  let paintAudio: PaintAudioInstance | null = null;
  let paintAudioLoading: Promise<PaintAudioInstance> | null = null;
  let bubbleAudio: BubbleAudioInstance | null = null;
  let bubbleAudioLoading: Promise<BubbleAudioInstance> | null = null;
  const ensurePaintAudio = () => {
    if (paintAudio) return Promise.resolve(paintAudio);
    if (paintAudioLoading) return paintAudioLoading;
    paintAudioLoading = import("./fx/paintAudio")
      .then(({ PaintAudio }) => paintAudio ??= new PaintAudio(gameplaySfxBus))
      .finally(() => { paintAudioLoading = null; });
    return paintAudioLoading;
  };
  const ensureBubbleAudio = () => {
    if (bubbleAudio) return Promise.resolve(bubbleAudio);
    if (bubbleAudioLoading) return bubbleAudioLoading;
    bubbleAudioLoading = import("./fx/bubbleAudio")
      .then(({ BubbleAudio }) => bubbleAudio ??= new BubbleAudio(gameplaySfxBus))
      .finally(() => { bubbleAudioLoading = null; });
    return bubbleAudioLoading;
  };
  let fetchBall: FetchBall | null = null; // built after coronaHeights; setTool runs once before it exists
  // Click-tool selection + Ctrl+digit cycling — extracted per
  // docs/MAIN_DECOMPOSITION.md. Late-bound getters break the Toolbar↔setTool
  // and fetchBall-null-until-built cycles.
  const toolCycle = createToolCycle({
    hud,
    getToolbar: () => toolbar,
    getFetchBall: () => fetchBall,
    ensurePaintAudio,
    ensureBubbleAudio
  });
  const setTool = toolCycle.setTool;
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

  // procedural vehicle hum + the HUD's compact four-group mixer (bottom-left)
  const vehicleAudio = new VehicleAudio();
  const swimAudio = new SwimAudio();
  const playerFoleyAudio = new PlayerFoleyAudio(gameplaySfxBus);
  const modeTransitionAudio = new ModeTransitionAudio(gameplaySfxBus);
  const jumpLandingAudio = new JumpLandingAudio(gameplaySfxBus);
  const doorAudio = new DoorAudio(gameplaySfxBus);
  const audioControls = new AudioControls();
  // procedural, layered nature soundscape (Botanical Garden / GG Park / Presidio
  // / Marin): sampled beds + gust-locked wind synth + spatial animal calls, all
  // fading in per region. Suspends itself when the player is out in the city.
  const nature = createNatureSoundscape();
  // Reusable ocean-wave layer (breaking surf at Ocean Beach + shoreline wash
  // anywhere near water); rides the nature AudioContext.
  const waveAudio = new WaveAudio(nature);
  // Thrown-ball impact voices: a dry thud on the ground, a plonk in water. A
  // splash in the Japanese Tea Garden's stream rings through a tunable feedback
  // delay — the fey-realm "magic echo". Rides the nature context/effects bus.
  const ballImpactAudio = new BallImpactAudio(nature);

  // Avatar identity: a saved avatar means the player chose one in the editor;
  // otherwise leave it to the server's per-id seed (adopted on welcome below) so
  // every player — every browser tab included — looks distinct. randomAvatarTraits
  // is just a non-default placeholder for the seconds before we're welcomed (and
  // the whole life of an offline single-player session).
  const savedAvatar = loadSavedAvatar();
  let customized = savedAvatar !== null;
  let avatarTraits = savedAvatar ?? randomAvatarTraits();
  const savedCar = loadSavedCar();
  let carCustomized = savedCar !== null;
  let carConfig = savedCar ?? randomCarConfig();
  setLocalCarConfig(carConfig);
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
  const player = new Player(physics, map, scene, spawn, avatarTraits, boardConfig, scooterConfig, surfboardConfig, carConfig);
  const updatePlayerFoley = (dt: number, active: boolean) => {
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    const surfaceType = map.surfaceType(player.position.x, player.position.z);
    const onFoot = active && player.mode === "walk" && !player.riding;
    jumpLandingAudio.update(dt, onFoot ? {
      active: !player.swimming,
      grounded: player.walkGrounded,
      verticalSpeed: player.velocity.y,
      horizontalSpeed: speed,
      surfaceSoftness: surfaceType === 1 ? 0.82 : surfaceType === 2 ? 0.95 : 0.12
    } : null);
    playerFoleyAudio.update(dt, onFoot ? {
      active: player.mode === "walk" && !player.riding,
      grounded: player.walkGrounded,
      swimming: player.swimming,
      speed,
      stridePhase: player.walkStridePhase,
      surfaceType,
      running: speed > 6.2,
      indoor: player.indoor
    } : null);
  };
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
  const localAudioPlacement = (x: number, y: number, z: number, reach = 70) => {
    const dx = x - camera.position.x;
    const dy = y - camera.position.y;
    const dz = z - camera.position.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > reach) return null;
    const horizontal = Math.hypot(dx, dz) || 1;
    return {
      pan: THREE.MathUtils.clamp(
        ((dx * Math.cos(chase.yaw) - dz * Math.sin(chase.yaw)) / horizontal) * 0.72,
        -0.8,
        0.8
      ),
      intensity: 1 / (1 + Math.pow(distance / 18, 1.35))
    };
  };
  bubbles.onPop = (position, radius) => {
    const placement = localAudioPlacement(position.x, position.y, position.z, 55);
    if (!placement) return;
    bubbleAudio?.pop({
      radius,
      pan: placement.pan,
      intensity: placement.intensity
    });
  };
  paintballs.onImpact = (event) => {
    const placement = localAudioPlacement(event.x, event.y, event.z, 85);
    if (!placement || !paintAudio) return;
    paintAudio.impact({
      material: event.material,
      color: { r: event.r, g: event.g, b: event.b },
      speed: event.speed,
      intensity: placement.intensity,
      wetness: event.material === "water" ? 0.92 : 0.76,
      pan: placement.pan,
      room: player.indoor ? 0.22 : 0.08,
      sourceId: event.shooter
    });
  };
  let surfExperience: import("./gameplay/surfing/game").SurfExperience | null = null;
  let surfRuntimeLoading: Promise<void> | null = null;
  let surfShack: SurfShack | null = null;
  let surfEntryPreparations = 0;
  const ensureSurfShack = () => {
    if (surfShack) return;
    surfShack = createSurfShack(map);
    scene.add(surfShack.group);
    refreshSurfDebug();
  };
  const refreshSurfDebug = () => {
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) Object.assign(hooks, { oceanBeachWaves, surfExperience, surfShack });
  };
  const ensureSurfRuntime = (prepareEntry = false) => {
    const surfing = player.mode === "surf";
    // The activity chunk is a first-use resource: merely visiting Ocean Beach on
    // foot must not fetch or construct any of it. Entry preparation is the one
    // intentional exception because the first visible surf frame needs both the
    // authored break and its HUD ready.
    if (!surfing && !prepareEntry) return Promise.resolve();
    ensureSurfShack();
    if (oceanBeachWaves && surfExperience) return Promise.resolve();
    if (surfRuntimeLoading) return surfRuntimeLoading;
    surfRuntimeLoading = import("./gameplay/surfing")
      .then(async ({ OceanBeachWaves, SurfExperience }) => {
        // A direct transition may have been canceled while the chunk was in
        // flight. Do not resurrect the activity after its owner has left.
        if (!prepareEntry && player.mode !== "surf" && surfEntryPreparations === 0) return;
        if (!oceanBeachWaves) {
          // Compile the wave sheet's pipelines while the group is detached —
          // adding it uncompiled froze the first surf second for >1 s.
          const waves = new OceanBeachWaves();
          try {
            await renderer.compileAsync(waves.group, camera, scene);
          } catch (error) {
            console.warn("[surf] wave warmup compile failed", error);
          }
          scene.add(waves.group);
          oceanBeachWaves = waves;
        }
        surfExperience ??= new SurfExperience(vehicleAudio);
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
  // The primed break stays alive while the player remains in the activity's
  // beach neighborhood (live breaking waves from the sand + instant re-entry).
  // Release only once they genuinely leave — a 240 m pad against the 90 m
  // prime radius so exit→walk cannot churn dispose/recompile cycles.
  const surfBreakStillLocal = () => {
    if (player.mode === "surf" || surfEntryPreparations > 0) return true;
    if (!surfShack) return false;
    const dx = player.position.x - surfShack.pose.x;
    const dz = player.position.z - surfShack.pose.z;
    return dx * dx + dz * dz < 240 * 240;
  };
  // Pre-compile the surf embodiment (board deck + rider rig) pipelines while
  // it is detached, so the first ridden frame draws with zero pipeline work.
  // Same detached-compile pattern the covered encounters use.
  const warmSurfEmbodiment = async (): Promise<void> => {
    const rig = player.meshes.surf;
    if (!rig || rig.userData.surfPipelinesWarm) return;
    // Concurrent preparations (proximity prime + shack E in its window) must
    // share one in-flight warm, or the second resolves while the rig is still
    // detached and the first's restore clobbers a live mode switch.
    const inFlight = rig.userData.surfWarmPromise as Promise<void> | undefined;
    if (inFlight) return inFlight;
    const parent = rig.parent;
    const wasVisible = rig.visible;
    parent?.remove(rig);
    rig.visible = true;
    const run = (async () => {
      try {
        await renderer.compileAsync(rig, camera, scene);
      } catch (error) {
        console.warn("[surf] embodiment warmup compile failed", error);
      } finally {
        delete rig.userData.surfWarmPromise;
        rig.userData.surfPipelinesWarm = true;
        // Restore from LIVE state: the player may have entered surf while the
        // rig was detached, and a rig replaced by setSurfboardConfig mid-warm
        // (player.meshes.surf !== rig) is disposed — never resurrect it.
        if (player.meshes.surf === rig) {
          rig.visible = player.mode === "surf" ? true : wasVisible;
          if (parent && !rig.parent) parent.add(rig);
        }
      }
    })();
    rig.userData.surfWarmPromise = run;
    return run;
  };
  const prepareSurfEntry = async () => {
    surfEntryPreparations++;
    try {
      await Promise.all([chase.ensureSurfCamera(), ensureSurfRuntime(true), warmSurfEmbodiment()]);
      return oceanBeachWaves !== null && surfExperience !== null;
    } catch (error) {
      console.warn("[surf] entry preparation failed", error);
      return false;
    } finally {
      surfEntryPreparations--;
    }
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
  // Rebound after the customizer roots exist; onModeChange may fire earlier.
  let syncCustomizerForMode: (mode: PlayerMode) => void = () => {};
  let setRemoteSurfboardAssetsActive: (active: boolean) => void = () => {};
  let setRemoteScooterAssetsActive: (active: boolean) => void = () => {};
  let setRemoteCarAssetsActive: (active: boolean) => void = () => {};
  let setRemoteBirdAssetsActive: (active: boolean) => void = () => {};
  let leaveCameraModeForSurf: () => void = () => {};
  const birdTrails = new BirdTrails(scene, player.meshes.bird);
  const droneFireworkMounts = player.meshes.drone.userData.fireworkMounts as THREE.Object3D[] | undefined;
  const startMode = invite || resumed ? "walk" : (spawnPoint?.mode ?? START.mode);
  if (startMode !== "walk" && ALL_MODES.includes(startMode)) {
    if (startMode !== "surf" || await prepareSurfEntry()) player.trySwitch(startMode);
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
  let previousAudioMode = player.mode;
  player.onModeChange = (mode) => {
    modeTransitionAudio.event(previousAudioMode, mode);
    previousAudioMode = mode;
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
    } else if (!surfBreakStillLocal()) {
      // The high-resolution break belongs to the surf session and its beach;
      // exiting onto the apron keeps it breaking for the walk-up view.
      releaseSurfVisual();
    }
    setRemoteSurfboardAssetsActive(mode === "surf");
    setRemoteScooterAssetsActive(mode === "scooter");
    setRemoteCarAssetsActive(mode === "drive");
    setRemoteBirdAssetsActive(mode === "bird");
    syncCustomizerForMode(mode);
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
      pipeline.setProjectedSurfaceLightSource(
        streetLamps.projectedSurfaceLightSource
      );
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
  let ghostShipRideZoom: number | null = null;
  let ghostShipRideYaw: number | null = null;
  let switchModeFromExit: (mode: PlayerMode) => void = (mode) => embodiments.switchMode(mode);
  const exitToWalk = () => {
    // Surf exits relocate from a live crest to the shoreline. The normal E/B
    // path and the out-of-bounds repair must use Navigation's covered preview;
    // ordinary mount dismounts remain local and immediate.
    if (player.mode === "surf") {
      switchModeFromExit("walk");
      return true;
    }
    const leavingGhostShip = embodiments.passengerOf === GHOST_SHIP_RIDE_ID;
    const exited = embodiments.exitToWalk();
    if (exited && leavingGhostShip && ghostShipRideZoom !== null) {
      chase.zoom = ghostShipRideZoom;
      ghostShipRideZoom = null;
      ghostShipRideYaw = null;
    }
    return exited;
  };
  type ViewMode = "third" | "first" | "orbit";
  const VIEW_CYCLE: ViewMode[] = ["third", "first", "orbit"];
  let viewMode: ViewMode = "third";
  const inOrbit = () => viewMode === "orbit";
  // Scattered boardable bay boats (persistent, self-sailing, far-hidden) —
  // extracted per docs/MAIN_DECOMPOSITION.md.
  spawnScatterBoats(abandonedMounts);
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
  let wakeDeferredGarden: (() => void) | null = null;
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
  let sutroBaths: import("./world/sutroBaths").SutroBaths | null = null;
  let activeRadialLight: {
    owner: "mission-dolores" | "beach-pianist";
    source: RadialLightSource;
  } | null = null;
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
  const releaseActiveRadialLight = () => {
    if (!activeRadialLight) return;
    // Detach and dispose the render graph before releasing the proxy scene it
    // reads. Outside a bounded owner, the base post-FX pipeline is selected.
    pipeline.setRadialLightSource(null);
    if (activeRadialLight.owner === "mission-dolores") {
      missionDolores?.releaseRadialLightSource();
    } else {
      beachPianist?.releaseRadialLightSource();
    }
    activeRadialLight = null;
  };
  const renderFrame = () => {
    const wantsMuseumRays =
      Boolean(POSTFX_TUNING.values.museumRays) &&
      missionDolores?.isPlayerInInterior(player.position) === true;
    const wantsBeachPianistRays =
      Boolean(POSTFX_TUNING.values.pianistRays) &&
      foliageOn &&
      siteFoliage?.isReady("beach-pianist-grove") === true &&
      beachPianist?.isPlayerInGodRayArea(player.position) === true;
    const nextOwner = wantsMuseumRays
      ? "mission-dolores"
      : wantsBeachPianistRays
        ? "beach-pianist"
        : null;

    if (activeRadialLight?.owner !== nextOwner) {
      releaseActiveRadialLight();
      const nextSource = nextOwner === "mission-dolores"
        ? missionDolores?.radialLightSource ?? null
        : nextOwner === "beach-pianist"
          ? beachPianist?.radialLightSource ?? null
          : null;
      if (nextOwner && nextSource) {
        activeRadialLight = { owner: nextOwner, source: nextSource };
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
  // Exhibit-site vegetation streamer — constructed after the optional-site
  // stage machinery exists; registrations are boot-safe data.
  let siteFoliage: SiteFoliageStreamer | null = null;
  const setFoliageVisible = (visible: boolean) => {
    foliageOn = visible;
    garden?.setVisible(visible, player.position);
    if (wildlands) for (const g of wildlands.groups) g.visible = visible;
    if (buenaVistaTrees) buenaVistaTrees.group.visible = visible;
    goldenGateTennis?.setFoliageVisible(visible);
    teaGarden.setFoliageVisible(visible);
    sutroBaths?.setFoliageVisible(visible);
    siteFoliage?.setVisible(visible);
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
  let pup: PupPen | null = null;
  // Palace of Fine Arts blue-hour art quest (site-gated around the lagoon).
  let palaceReverie: PalaceReverieGame | null = null;
  // Lands End — the NW headland: a cliff-top Labyrinth you light by walking,
  // Sutro Baths ruins, cypress and a lantern-keeper. Distance-LOD region.
  let landsEnd: LandsEndRegion | null = null;
  let waveOrgan: WaveOrgan | null = null;
  // Baker Beach — a bearded voxel pianist at a voxel grand, the Golden Gate
  // Bridge behind him. Lazy optional site (procedural build; recording + note
  // timeline fetched on first approach).
  let beachPianist: BeachPianist | null = null;
  let unregisterBeachPianistTuning: (() => void) | null = null;
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
  // Keep the seven mapped Tea Garden buildings as the immediate baked fallback.
  // Their authored, walkable replacements claim the footprints atomically only
  // after the essential Tea Garden subtree is GPU-ready and attached. Suppressing
  // them here created the conspicuous empty garden during first approach.
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
    hud: { message: (t, s) => hud.message(t, s) },
    onThrow: (throwId, x, y, z, vx, vy, vz) => net.sendBall(throwId, x, y, z, vx, vy, vz),
    onPickupRequest: (sourceId, throwId) => net.requestBallPickup(sourceId ?? net.selfId, throwId),
    // A bounce on the tea-garden pond bottom is submerged — its plonk is voiced
    // by the water feature, so skip the dry thud there.
    onGroundImpact: (x, y, z, speed) => {
      if (teaGarden.containsWater(x, z)) return;
      ballImpactAudio.ground(x, y, z, speed);
    }
  });
  // setTool ran before fetchBall existed — sync the held prop to the active tool
  toolCycle.syncHeldProp();
  // Dog-park sound layer: barks + paw-patter from the actual park dogs, riding
  // the nature soundscape's context/bus so HUD volume/mute and the corona
  // region fade all apply. Idles to a single distance check away from the park.
  const dogParkAudio = new DogParkAudio(nature, () => coronaHeights?.dogs ?? []);
  // First feature-level HMR boundary. The stable facade survives edits while
  // its concrete trio, GPU resources, audio and perch collider are replaced.
  const buskers = createBuskersSystem({
    scene,
    map,
    physics,
    prepareRender: (root) => warmHiddenRoot(renderer, camera, scene, root)
  });
  // Summit dialogue: the trio chills until you walk up, press E and ask for a
  // song (shared NPC conversation system — gameplay/agents/conversation.ts).
  const buskerTalk = createBuskerConversation(buskers);
  let ridePromptShown = false;
  let doorPromptShown = false;
  let doorScanCountdown = 0;
  let doorScanHit: ReturnType<CityGenRing["nearestDoor"]> = null;
  // way high above the ground (plane/drone cruising), ground flora and critters
  // are subpixel — their systems pause. Hysteresis so hill flanks don't flicker it.
  let highUp = false;

  // Car-landing shake/audio/dust feedback — extracted per docs/MAIN_DECOMPOSITION.md.
  const carLanding = createCarLandingFeedback({ player, embodiments, chase, vehicleAudio, fx });

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
      // Start from a clean framing: medium distance, level with the head, facing
      // the player. Entering from first person leaves the camera inside the head
      // (target above camera → confusing worm's-eye view), so never reuse the raw
      // camera position — only its horizontal bearing, when it has one.
      const ORBIT_START_DIST = 8;
      const headY = player.position.y + 1.5;
      let dx = camera.position.x - player.position.x;
      let dz = camera.position.z - player.position.z;
      const horiz = Math.hypot(dx, dz);
      if (horiz > 0.5) {
        dx /= horiz;
        dz /= horiz;
      } else {
        // Degenerate (first person / co-located): sit behind the player's facing.
        dx = -Math.sin(player.heading);
        dz = -Math.cos(player.heading);
      }
      orbit.setLookAt(
        player.position.x + dx * ORBIT_START_DIST,
        headY,
        player.position.z + dz * ORBIT_START_DIST,
        player.position.x,
        headY,
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
    savedSurfboard ?? undefined,
    savedCar ?? undefined
  );
  const remotes = new RemotePlayers(scene);
  remotes.localPlayerPosition = () => player.renderPosition;
  // net.onRakeStamp / onRakeReset are wired just after the Tea Garden controller
  // is created (below) — before then the garden cannot exist, and net's no-op
  // defaults absorb any rake hydration that arrives during a boot await; the
  // controller's replayRakeStamps re-applies once the site loads.
  // The request-free horizon proxy is a world fundamental; detailed geometry,
  // particles and the WebGPU hot-tub solver cross a separate proximity gate.
  const ghostShipBeacon = new GhostShipBeacon(scene, map);
  let ghostShip: GhostShip | null = null;
  let ghostShipLoading: Promise<GhostShip | null> | null = null;
  let ghostShipLoadFailed = false;
  let unregisterGhostShipTuning: (() => void) | null = null;
  let ensureGhostShipDetail: () => Promise<GhostShip | null> = async () => null;
  const ghostShipSeatQuat = new THREE.Quaternion();
  const ghostShipSeatEuler = new THREE.Euler(0, 0, 0, "YXZ");
  remotes.worldRidePose = (rideId, seat, outPosition, outQuaternion) => {
    if (rideId !== GHOST_SHIP_RIDE_ID) return false;
    if (ghostShip?.seatPose(seat, outPosition, outQuaternion)) return true;
    // Keep map-teleport riders glued while the detailed chunk warms up.
    const pose = ghostShipBeacon.pose;
    outPosition.set(pose.x, pose.y + 2.2, pose.z);
    ghostShipSeatEuler.set(pose.pitch, pose.yaw, pose.roll);
    ghostShipSeatQuat.setFromEuler(ghostShipSeatEuler);
    outQuaternion.copy(ghostShipSeatQuat);
    return true;
  };
  setRemoteSurfboardAssetsActive = (active) => remotes.setSurfboardAssetsEnabled(active);
  setRemoteScooterAssetsActive = (active) => remotes.setScooterAssetsEnabled(active);
  setRemoteCarAssetsActive = (active) => remotes.setCarAssetsEnabled(active);
  setRemoteBirdAssetsActive = (active) => remotes.setBirdAssetsEnabled(active);
  // Startup/invite can enter surf before networking and its remote-art gate exist.
  setRemoteSurfboardAssetsActive(player.mode === "surf");
  setRemoteScooterAssetsActive(player.mode === "scooter");
  setRemoteCarAssetsActive(player.mode === "drive");
  setRemoteBirdAssetsActive(player.mode === "bird");
  // The controller statically owns every pickleball mesh, UI and audio class,
  // so even constructing an empty facade would pull the activity into boot.
  // It is installed together with the Goldman site on first approach.
  let pickleballController: PickleballController | null = null;
  let fortMasonEnsemble: FortMasonEnsemble | null = null;
  const captureMinigameOrigin = (): MinigameOrigin => ({
    x: player.position.x,
    y: player.position.y,
    z: player.position.z,
    facing: player.heading - Math.PI,
    mode: player.mode
  });
  const minigameSession = new MinigameSessionController({
    resetPlayerState: () => player.resetMinigameState(),
    onChange: (session) => hud.setMinigameExit(session?.label ?? null)
  });
  minigameSession.register({
    id: "sand-raking",
    label: "sand raking",
    isActive: () => teaGarden.isRaking(),
    release: () => { teaGarden.releaseForNavigation(); }
  });
  minigameSession.register({
    id: "pickleball",
    label: "pickleball",
    isActive: () => pickleballController?.playing ?? false,
    release: () => { pickleballController?.releaseForNavigation(); }
  });
  minigameSession.register({
    id: "fort-mason-ensemble",
    label: "Fort Mason ensemble",
    isActive: () => fortMasonEnsemble?.playing ?? false,
    release: () => { fortMasonEnsemble?.releaseForNavigation(); }
  });
  minigameSession.register({
    id: "golf",
    label: "golf",
    isActive: () => golf?.active ?? false,
    release: () => { golf?.abandonForNavigation(hud); }
  });
  minigameSession.register({
    id: "archery",
    label: "archery",
    isActive: () => archery?.firstPersonActive ?? false,
    release: () => { archery?.releaseForNavigation(player); }
  });
  const releaseGameplayForNavigation = () => {
    if (inOrbit()) setViewMode("third");
    return minigameSession.releaseForNavigation(captureMinigameOrigin());
  };
  // Customizer selectors are all lazy (docs/MAIN_DECOMPOSITION.md step 3): only a
  // placeholder launcher exists at boot; each selector's UI chunk dynamic-imports
  // on FIRST OPEN via the shared createLazySelector mechanic. The mutable config
  // state (avatarTraits/boardConfig/…) stays boot-resident here — net.onWelcome
  // and other call sites read/write it and optional-chain through `.get()` so a
  // pre-load setter is a safe no-op; each `load()` closure reads the current
  // config when it finally constructs the panel.
  const hudRoot = document.getElementById("hud")!;
  const avatar = createLazySelector(hudRoot, {
    id: "avatar",
    launcherClass: "avatar-ui avatar-launcher-ui",
    toggleClass: "avatar-toggle",
    icon: "/ui/customizer-icons/avatar.webp",
    title: "Edit avatar and name",
    ariaLabel: "Edit avatar and name",
    active: () => player.mode === "walk",
    onLauncherClick: () => input.releaseLock(),
    load: async () => {
      const { AvatarSelector } = await import("./ui/avatarSelector");
      return new AvatarSelector(
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
          avatar.get()?.setName(net.name);
          hud.message(`You're now ${net.name}`, 2.2);
        }
      );
    }
  });
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
  const board = createLazySelector(hudRoot, {
    id: "board",
    launcherClass: "avatar-ui board-ui board-launcher-ui",
    toggleClass: "avatar-toggle board-toggle",
    icon: "/ui/customizer-icons/hoverboard.webp",
    title: "Hoverboard lab",
    ariaLabel: "Open hoverboard lab",
    active: () => player.mode === "board",
    onLauncherClick: () => input.releaseLock(),
    load: async () => {
      const { BoardSelector } = await import("./ui/boardSelector");
      return new BoardSelector(
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
    }
  });
  const scooter = createLazySelector(hudRoot, {
    id: "scooter",
    launcherClass: "avatar-ui scooter-ui scooter-launcher-ui",
    toggleClass: "avatar-toggle scooter-toggle",
    icon: "/ui/customizer-icons/scooter.webp",
    title: "Electric scooter atelier",
    ariaLabel: "Open electric scooter atelier",
    active: () => player.mode === "scooter",
    onLauncherClick: () => input.releaseLock(),
    load: async () => {
      const { ScooterSelector } = await import("./ui/scooterSelector");
      return new ScooterSelector(
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
        (config) => player.previewScooterConfig(config),
        () => {
          if (player.mode !== "scooter" && !player.riding) switchModeFromToolbar("scooter");
        }
      );
    }
  });
  const car = createLazySelector(hudRoot, {
    id: "car",
    launcherClass: "avatar-ui car-ui car-launcher-ui",
    toggleClass: "avatar-toggle car-toggle",
    icon: "/ui/customizer-icons/car.webp",
    title: "Open car atelier",
    ariaLabel: "Open car atelier",
    active: () => player.mode === "drive",
    onLauncherClick: () => input.releaseLock(),
    load: async () => {
      const { CarSelector } = await import("./ui/carSelector");
      return new CarSelector(
        carConfig,
        (config) => {
          carCustomized = true;
          const changed = carKey(config) !== carKey(carConfig);
          carConfig = config;
          setLocalCarConfig(config);
          saveCarConfig(config);
          if (changed) player.setCarConfig(config);
          net.setCar(config);
        },
        (config) => player.previewCarConfig(config),
        () => {
          if (player.mode !== "drive" && !player.riding) switchModeFromToolbar("drive");
        }
      );
    }
  });
  // __sf-exposed opener; also called by the drive-mode toolbar wiring.
  const ensureCarCustomizer = (open = false) => car.ensure(open);
  const applySurfboardConfig = (config: SurfboardConfig) => {
    const changed = surfboardVisualKey(config) !== surfboardVisualKey(surfboardConfig);
    surfboardConfig = config;
    setLocalSurfboardConfig(config);
    if (changed) player.setSurfboardConfig(config);
    else player.previewSurfboardSurface(config);
  };
  const surfboard = createLazySelector(hudRoot, {
    id: "surfboard",
    launcherClass: "avatar-ui board-ui surfboard-ui surfboard-launcher-ui",
    toggleClass: "avatar-toggle board-toggle surfboard-toggle",
    icon: "/ui/customizer-icons/surfboard.webp",
    title: "Open surfboard shaping room",
    ariaLabel: "Open surfboard shaping room",
    active: () => player.mode === "surf",
    onLauncherClick: () => input.releaseLock(),
    load: async () => {
      const { SurfboardSelector } = await import("./ui/surfboardSelector");
      return new SurfboardSelector(
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
    }
  });
  ensureSurfboardCustomizer = (open = false) => surfboard.ensure(open);
  // One top-right customizer slot: show only the active mode's atelier (or none).
  syncCustomizerForMode = (mode) => {
    avatar.syncVisible(mode === "walk");
    board.syncVisible(mode === "board");
    scooter.syncVisible(mode === "scooter");
    car.syncVisible(mode === "drive");
    surfboard.syncVisible(mode === "surf");
  };
  syncCustomizerForMode(player.mode);
  net.onWelcome = () => {
    avatar.get()?.setName(net.name); // server may canonicalize a duplicate/invalid name
    if (customized) {
      net.setAvatar(avatarTraits); // re-assert my chosen look after a (re)connect
    } else {
      // adopt the server's per-id seed so my own body matches how everyone else
      // sees me, and reflect it in the editor
      avatarTraits = avatarFromSeed(net.selfId);
      player.setAvatar(avatarTraits);
      avatar.get()?.setTraits(avatarTraits);
    }
    if (boardCustomized) {
      net.setBoard(boardConfig); // re-assert my chosen board after a (re)connect
    } else {
      const seeded = boardFromSeed(net.selfId);
      applyBoardConfig(seeded);
      board.get()?.setConfig(seeded);
    }
    if (scooterCustomized) {
      net.setScooter(scooterConfig);
    } else {
      scooterConfig = scooterFromSeed(net.selfId);
      setLocalScooterConfig(scooterConfig);
      player.setScooterConfig(scooterConfig);
      scooter.get()?.setConfig(scooterConfig);
    }
    if (carCustomized) {
      net.setCar(carConfig);
    } else {
      carConfig = carFromSeed(net.selfId);
      setLocalCarConfig(carConfig);
      player.setCarConfig(carConfig);
      car.get()?.setConfig(carConfig);
    }
    if (surfboardCustomized) {
      net.setSurfboard(surfboardConfig);
    } else {
      const seeded = surfboardFromSeed(net.selfId);
      applySurfboardConfig(seeded);
      surfboard.get()?.setConfig(seeded);
    }
    golf?.syncNetState();
    net.replayGolf();
    pickleballController?.onWelcome();
    fortMasonEnsemble?.onWelcome();
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
        remotes.updateCar(info);
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
    fetchBall?.removeRemoteBalls(id);
  };
  net.onSample = (id, s) => remotes.sample(id, s);
  // someone else's paintball: same ballistic sim, their color, splats locally
  net.onPaint = (id, x, y, z, vx, vy, vz, rgb) => paintballs.spawn(x, y, z, vx, vy, vz, remotePaint.set(rgb), id);
  // Friends' tennis balls use the exact local bounce/roll sim. They stay out of
  // local dog-fetch ownership, but settled balls transfer through E pickup.
  net.onBall = (id, throwId, x, y, z, vx, vy, vz) => fetchBall?.spawnRemote(id, throwId, x, y, z, vx, vy, vz);
  net.onBallPickup = (pickerId, ownerId, throwId, accepted) => {
    const received = fetchBall?.resolvePickup(
      pickerId === net.selfId,
      ownerId === net.selfId ? null : ownerId,
      throwId,
      accepted
    ) ?? false;
    if (received && ownerId !== net.selfId) {
      const ownerName = net.roster.get(ownerId)?.name;
      hud.message(`Picked up ${ownerName ? `${ownerName}'s` : "your friend's"} ball!`, 2.4);
    }
  };
  const remotePaint = new THREE.Color();
  // shared skies: my rocket launches go out, friends' volleys replay here
  fireworks.onVolley = (rockets) => net.sendFireworks(rockets);
  net.onFireworks = (_id, rockets) => fireworks.launchRemote(rockets);
  // ephemeral text chat (T to type) — fire-and-forget over the relay, no history.
  // Esc-blur must not re-lock (see Escape priority stack below); Enter-submit may.
  let skipChatRelock = false;
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
      if (
        !inOrbit() &&
        document.body.classList.contains("started") &&
        !input.suspended &&
        !input.freeCursor
      ) {
        input.requestLock();
      }
    }
  );
  net.onChat = (_id, name, text) => chat.addMessage(name, text);
  // presence toast above the chat panel when someone new enters the world
  net.onJoin = (_id, name) => chat.showJoin(name);
  // golf: friends' swings/balls/scores replay here (owner-simulated snapshots)
  net.onGolf = (id, m) => golf?.handleNet(id, m, hud, net.roster.get(id)?.name ?? "Player");
  input.onLockChange = (locked) => {
    if (!locked && !inOrbit() && !input.freeCursor && !chat.focused) {
      hud.message("Click the scene to capture · Esc releases · L toggles free cursor", 2.8);
    }
  };
  // Passenger support: every mode in PASSENGER_CAPACITY publishes seat
  // anchors in its mesh userData (single anchor or a passengerSeats list).
  remotes.localDriveMesh = () =>
    passengerCapacity(player.mode) > 0 && !player.riding ? player.meshes[player.mode] : null;

  // Passenger pose scratch; attachment ownership lives in EmbodimentController.
  const ridePos = new THREE.Vector3();
  const rideQuat = new THREE.Quaternion();

  // voice chat: P2P audio to the closest players at any distance,
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
    hud.message(on ? "Mic live — the closest players can hear you" : "Mic off", 2.6);
  };
  const toggleMic = () => {
    void voice.setMic(!voice.micOn).then((ok) => {
      if (!ok) hud.message("Microphone blocked — check the browser permission", 3.5);
    });
  };
  audioControls.onMicToggle = toggleMic;

  // Webcam pose control is a first-use feature: neither LiteRT, its WebGPU
  // runtime, the model, nor camera permission is touched until this button.
  let mocapSession: import("./mocap/poseMocapSession").PoseMocapSession | null = null;
  const stopMocap = (announce = true) => {
    mocapSession?.stop();
    mocapSession = null;
    player.setMocapPoseDriver(null);
    audioControls.setMocap("off");
    if (announce) hud.message("Webcam pose off", 2.4);
  };
  const startMocap = async () => {
    audioControls.setMocap("loading", "Loading WebGPU pose");
    hud.message("Starting WebGPU webcam pose…", 3);
    try {
      const { PoseMocapSession } = await import("./mocap/poseMocapSession");
      const session = new PoseMocapSession({
        video: audioControls.mocapVideo,
        onState: (state, message) => audioControls.setMocap(state, message),
        onFatal: (error) => {
          if (mocapSession !== session) return;
          mocapSession = null;
          player.setMocapPoseDriver(null);
          audioControls.setMocap("error", "Pose stopped");
          hud.message(`Webcam pose stopped — ${error.message}`, 4.5);
        }
      });
      mocapSession = session;
      await session.start();
      if (mocapSession !== session) {
        session.stop();
        return;
      }
      player.setMocapPoseDriver(session.poseDriver);
      hud.message("Webcam pose ready — step into view", 3.4);
    } catch (error) {
      mocapSession?.stop();
      mocapSession = null;
      player.setMocapPoseDriver(null);
      const message = error instanceof Error ? error.message : String(error);
      audioControls.setMocap("error", "Pose unavailable");
      hud.message(`Webcam pose unavailable — ${message}`, 4.8);
    }
  };
  audioControls.onMocapToggle = () => {
    if (mocapSession) stopMocap();
    else void startMocap();
  };
  window.addEventListener("pagehide", () => stopMocap(false), { once: true });
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
      fortMasonEnsemble?.onOffline();
      // Offline stays silent: the local AI match keeps working and Net retries.
    }
  };

  // Name gate is wired at module startup so typing works during loading; this
  // callback is attached once the game objects it needs exist.
  bootScreen.setStartHandler((typedName, opts) => {
    net.setName(typedName);
    avatar.get()?.setName(net.name); // keep the avatar-panel field in step with the gate (no-op until opened)
    nameInput.blur(); // hand the keyboard back to the game
    document.body.classList.add("started"); // reveals the HUD (hidden behind the gate)
    loading.classList.add("done");
    window.setTimeout(() => audioControls.showMicNudge(), 650);
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
  // Activity-site pins (static coords) — extracted per docs/MAIN_DECOMPOSITION.md.
  registerActivityLandmarks(minimap, map, ghostShipBeacon.pose, ensureSurfShack);
  const playerLocator = new PlayerLocator();
  let prepareDestinationEssentials: (
    destination: Readonly<{ x: number; z: number }>,
    signal: AbortSignal
  ) => void | Promise<void> = () => {};
  const worldArrival = new WorldArrivalCoordinator({
    input,
    player,
    chase,
    tiles,
    physics,
    prepareRequiredDestinationVisuals: (destination, signal) =>
      authoredRegions.prepareAt(destination, signal),
    prepareDestinationVisuals: (destination, signal) =>
      prepareDestinationEssentials(destination, signal)
  });
  // World-background quiet-window admission (motion/arrival-aware pacing for
  // optional constructors + warmups) — extracted per docs/MAIN_DECOMPOSITION.md.
  const backgroundAdmission = createBackgroundAdmission({
    input,
    player,
    isArrivalActive: () => worldArrival.active
  });
  const {
    waitForWindow: waitForWorldBackgroundWindow,
    nextPresentationFrame,
    waitForCityGenRenderWindow
  } = backgroundAdmission;
  worldArrival.onStateChange = (snapshot) => {
    if (snapshot.active) backgroundAdmission.onArrivalStart();
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
  const navigation = new NavigationController({
    player,
    hud,
    map,
    tiles,
    remotes,
    embodiments,
    arrival: worldArrival,
    resolveAuthoredArrival: (x, z, label) => authoredRegions.arrivalForDestination(x, z, label),
    releaseGameplay: releaseGameplayForNavigation
  });
  const applyPlaceHistory = (step: -1 | 1) => navigation.applyHistory(step);
  let surfEntryRequest = 0;
  const switchMode = (mode: PlayerMode) => {
    const request = ++surfEntryRequest;
    if (mode === "bird") setRemoteBirdAssetsActive(true);
    // Surf is an isolated activity context. Prevent number keys, toolbar clicks,
    // and d-pad travel cycling from silently swapping vehicles mid-wave; E/Y is
    // the single clear exit back to the beach.
    if (player.mode === "surf" && mode !== "walk") {
      hud.message(
        localizeInteractText("E exits surfing — then choose another way to travel", input.device),
        2.2
      );
      return;
    }
    if (mode === "surf") {
      void prepareSurfEntry().then((ready) => {
        if (ready && request === surfEntryRequest && player.mode !== "surf") navigation.switchMode("surf");
      });
      return;
    }
    navigation.switchMode(mode);
  };
  switchModeFromExit = switchMode;
  const teleportAboardGhostShip = () => {
    if (embodiments.passengerOf === GHOST_SHIP_RIDE_ID) {
      hud.message("Already aboard the wandering ghost ship", 2.2);
      return;
    }
    navigation.teleportCustom({
      label: GHOST_SHIP_LANDMARK_NAME,
      successMessage: null,
      resolve: async (signal) => {
        const ship = await ensureGhostShipDetail();
        if (signal.aborted) throw new DOMException("Navigation superseded", "AbortError");
        if (!ship) throw new Error("The ghost ship could not be loaded");
        const seat = ship.claimDeckSeat(remotes.occupiedRideSeats(GHOST_SHIP_RIDE_ID));
        if (seat <= 0) throw new Error("The ghost ship's deck stations are full");
        const pose = ghostShipBeacon.pose;
        ship.update(0, elapsed, pose, player.renderPosition, true);
        if (!ship.seatPose(seat, ridePos, rideQuat)) {
          throw new Error("The ghost ship could not seat you");
        }
        return {
          x: ridePos.x,
          y: ridePos.y,
          z: ridePos.z,
          cameraYaw: pose.yaw,
          commit: () => {
            releaseGameplayForNavigation();
            embodiments.leaveRide();
            embodiments.exitToWalk();
            ghostShipRideZoom ??= chase.zoom;
            chase.zoom = Math.max(chase.zoom, 3.2);
            chase.yaw = pose.yaw;
            ghostShipRideYaw = pose.yaw;
            player.teleportTo({
              x: ridePos.x,
              y: ridePos.y,
              z: ridePos.z,
              facing: pose.yaw,
              mode: "walk"
            });
            embodiments.startPassengerRide(GHOST_SHIP_RIDE_ID, seat);
            hud.message(`Aboard the wandering ghost ship · deck station ${seat} · E to step off`, 3.2);
          }
        };
      }
    });
  };
  const teleportToTarget = (x: number, z: number, toName?: string, playerId?: number) => {
    if (toName === GHOST_SHIP_LANDMARK_NAME) {
      teleportAboardGhostShip();
      return;
    }
    navigation.teleportToTarget(x, z, toName, playerId);
  };
  switchModeFromToolbar = switchMode;
  hud.onHistoryBack = () => applyPlaceHistory(-1);
  hud.onHistoryForward = () => applyPlaceHistory(1);
  hud.onMinigameExit = () => {
    if (worldArrival.active) {
      hud.message("Finishing the arrival…", 1.2);
      return;
    }
    const session = releaseGameplayForNavigation();
    if (!session) return;
    navigation.returnToMinigameStart(session.origin, session.label);
  };
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

  // Escape priority stack (overlay dismissal + fullscreen unlock) — extracted
  // per docs/MAIN_DECOMPOSITION.md. Wired here, after minimap exists, so an
  // early Esc can't hit a TDZ binding.
  wireEscapeStack({
    input,
    minimap,
    chat,
    closeConversation: () => beachPianist?.close() || buskerTalk.close(),
    getMissionDolores: () => missionDolores,
    markChatEscapeBlur: () => { skipChatRelock = true; }
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
  navigation.onTeleported = () => {
    jumpLandingAudio.reset();
    tutorial.note("teleport");
  };


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
    () => diagnostics.toggleInspector(),
    () => { citygenRing.current?.refreshInteriors(); }
  );

  ensureGhostShipDetail = () => {
    if (ghostShip) return Promise.resolve(ghostShip);
    if (ghostShipLoadFailed) return Promise.resolve(null);
    if (!ghostShipLoading) {
      ghostShipLoading = import("./world/ghostShip")
        .then(async ({ createGhostShip }) => {
          const candidate = createGhostShip({ scene, renderer });
          try {
            await candidate.warmup();
          } catch (error) {
            candidate.dispose();
            throw error;
          }
          ghostShip = candidate;
          ghostShipBeacon.detailedVisible = true;
          unregisterGhostShipTuning = debugPanel.registerFeatureTuning(candidate.tuningDescriptor());
          const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
          if (hooks) hooks.ghostShip = candidate;
          return candidate;
        })
        .catch((error) => {
          ghostShipLoadFailed = true;
          console.warn("[ghost-ship] detailed runtime unavailable", error);
          return null;
        })
        .finally(() => {
          ghostShipLoading = null;
        });
    }
    return ghostShipLoading;
  };

  import.meta.hot?.dispose(() => {
    unregisterGhostShipTuning?.();
    ghostShip?.dispose();
    ghostShipBeacon.dispose();
  });
  debugPanel.setMode(player.mode);

  // Thrown-ball impact SFX + the fey-realm magic echo are adjustable at runtime.
  debugPanel.registerFeatureTuning({
    id: "ball-impact-audio",
    title: "Ball impact sound · thud / water / magic echo",
    build(folder) {
      BALL_IMPACT_AUDIO_TUNING.bind(folder);
    }
  });

  // Kid-with-a-kite ambient encounter (lazy first-approach gate) — extracted
  // per docs/MAIN_DECOMPOSITION.md.
  const oceanKite = createOceanKiteGate({ map, scene, renderer, camera, player, debugPanel });
  import.meta.hot?.dispose(oceanKite.dispose);

  // Resume last session: position, heading and vehicle survive a refresh. A
  // Vite structural reload additionally restores the exact chase-camera view.
  // (after the debug panel exists — restoreState can fire onModeChange).
  // An invite link wins over the saved session — the click's intent is explicit.
  if (resumed) {
    const resumedMode = resumed.mode === "surf" && !(await prepareSurfEntry()) ? "walk" : resumed.mode;
    player.restoreState({ ...resumed, mode: resumedMode });
    modeDiscovery.discover(resumedMode);
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
      // Forest is hydrated by a deferred async owner; preserve its declared
      // runtime type here instead of letting synchronous flow analysis freeze
      // the captured binding at its boot-time null value.
      const invitedForest = forest as Forest | null;
      if (invitedForest && ANIMALS && invite.animal) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const animalEntry: any = ANIMALS[invite.animal];
        player.setDriveStyle(invitedForest.buildRiddenMesh(invite.animal), animalEntry?.spec);
      }
      mode = "drive";
    }
    // land to the sharer's right so nobody spawns inside anybody — wider for
    // the big embodiments (a boat is 9 m long, planes bank wide)
    const side = mode === "boat" || mode === "plane" ? 7 : mode === "drive" ? 4 : 2.5;
    const jx = invite.x + Math.cos(invite.facing) * side;
    const jz = invite.z - Math.sin(invite.facing) * side;
    if (mode === "surf" && !(await prepareSurfEntry())) mode = "walk";
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
  // Esc-dismiss stays unlocked (click the scene to recapture); see Escape priority stack.
  let btsReading = false;
  // Both the post-reveal launcher and a shared `?read=` link route through this
  // function so the optional reader chunk is fetched and constructed once.
  const onBtsToggle = (open: boolean) => {
    btsReading = open;
    app.classList.toggle("world-dimmed", open);
    input.suspended = open || inOrbit();
    if (open) input.releaseLock();
    // A shared reading link opens the panel before the player has entered; closing
    // it drops back to the normal start screen instead of leaving them mid-modal.
    if (!open) document.body.classList.remove("reading");
  };
  const unsubscribeBehindTheScenes = subscribeBehindTheScenes(onBtsToggle);
  import.meta.hot?.dispose(unsubscribeBehindTheScenes);
  let btsLauncherMounted = false;
  const mountBehindTheScenesLauncher = async () => {
    if (btsLauncherMounted) return;
    btsLauncherMounted = true;
    const { BehindTheScenesLauncher } = await import("./ui/behindTheScenesLauncher");
    new BehindTheScenesLauncher(
      async () => {
        await openBehindTheScenes();
      },
      (error) => {
        console.warn("[bts] reader load failed:", error);
        hud.message("Behind the scenes couldn't load — please try again", 3.2);
      }
    );
  };
  // `?read=bts.<tab>` — a shared reading link. Drop straight into the panel with the
  // world still streaming behind it (no game entry, no name gate); closing it lands
  // on the normal start screen. Build the panel ASAP instead of waiting for the
  // deferred loader, and let `body.reading` reveal just the modal over the folio.
  if (initialReadLink && !getBehindTheScenes()?.isOpen) {
    document.body.classList.add("reading");
    void openBehindTheScenes(initialReadLink.sub).catch((error) => {
      document.body.classList.remove("reading");
      console.warn("[bts] reader load failed:", error);
    });
  }

  // Debug overlays ("/" → overlays). Off unless toggled; tick gathers active
  // physics / raycast / context-sensitive site overlays into WebGPU line buffers.
  const debugOverlays = new DebugOverlays(scene);
  // grey-card calibration chart ("/" → advanced → lighting → grey cards): a
  // camera-locked row of known-albedo spheres for reading the tone grade.
  const calibrationChart = new CalibrationChart(scene);
  let overlayRayHit: { x: number; y: number; z: number } | null = null;
  const syncDebugOverlays = () => {
    const px = player.position.x;
    const pz = player.position.z;
    if (debugOverlays.updateContext(px, pz)) {
      debugPanel.setOverlayContext(debugOverlays.context);
    }
    const v = OVERLAY_TUNING.values;
    if (!v.physicsColliders && !v.physicsCarpet && !v.playerBody && !v.raycast && !v.teaGardenWaterGrid) {
      debugOverlays.sync({ physics, player });
      return;
    }
    debugOverlays.sync({
      physics,
      player,
      citygenDebug: citygenRing.current
        ? (walls, interiors, roofs) => {
            citygenRing.current!.debugColliders(walls, interiors, roofs);
          }
        : undefined,
      ray: v.raycast
        ? {
            origin: rayOrigin,
            hit: overlayRayHit,
            dir: aim,
            maxDist: 60
          }
        : undefined,
      sampleY: (x, z) => map.groundTop(x, z)
    });
  };

  const aim = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3(); // aimOrigin returns a shared tmp — keep our own copy
  // The interaction ray. Normally it's the centre-screen aim; while the free
  // cursor is out (L toggled) it's the camera-through-mouse ray instead, so
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
  // Keep all Behind-the-scenes UI out of essential loading. After the visual +
  // collision reveal, give the live world a quiet beat, then request only the
  // tiny launcher during browser idle. The timeout guarantees it appears within
  // a few seconds instead of waiting on optional garden/tree/golf completion.
  // The reader itself waits for a click; its heavy chapters wait for their tabs.
  void revealedPromise.then(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 2500));
    await new Promise<void>((resolve) => {
      if ("requestIdleCallback" in window) {
        window.requestIdleCallback(() => resolve(), { timeout: 2000 });
      } else {
        setTimeout(resolve, 120);
      }
    });
    try {
      await mountBehindTheScenesLauncher();
    } catch (error) {
      btsLauncherMounted = false;
      console.warn("[bts] deferred launcher load failed:", error);
    }
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
    tiles.beginBackgroundExpansion();
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
  // Park + authored-region map pins (eager, coords-only) — extracted per
  // docs/MAIN_DECOMPOSITION.md; GARDEN_XZ/GOLF_XZ now live beside the pins.
  registerParkLandmarks(minimap, authoredRegions);

  type LazyRegionTimingEvent = { phase: string; atMs: number; elapsedMs: number };
  const lazyRegionTimings: Record<string, { startedAt: number; events: LazyRegionTimingEvent[] }> = {};
  const markLazyRegion = (region: string, phase: string) => {
    const now = performance.now();
    const timing = lazyRegionTimings[region] ??= { startedAt: now, events: [] };
    const event = { phase, atMs: now, elapsedMs: now - timing.startedAt };
    timing.events.push(event);
    performance.mark(`sf:${region}:${phase}`);
    if (new URLSearchParams(location.search).has("profile")) {
      console.info(`[lazy:${region}] ${phase} +${Math.round(event.elapsedMs)}ms`);
    }
  };

  const waitForAbortable = <T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> => {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(new DOMException("Destination superseded", "AbortError"));
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Destination superseded", "AbortError"));
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  };

  type WildlandsGroundcoverBootstrap = {
    site: import("./world/wildlands").Wildlands;
    golfMod: typeof import("./gameplay/golf");
    loadedGolfCourse: import("./gameplay/golf").GolfCourse | null;
  };
  let wildlandsGroundcoverPromise: Promise<WildlandsGroundcoverBootstrap> | null = null;
  let requestedWildlandsFocus: { x: number; z: number } | null = null;

  /**
   * Request only the selected Wildlands destination's immediate surface. This
   * bootstrap is deliberately declared before the sequential CityGen/fauna
   * coordinator: a teleport must not wait for unrelated owners merely to begin
   * fetching its grass chunk. Defining the gate performs no request at boot.
   */
  const startWildlandsGroundcover = (
    focus: Readonly<{ x: number; z: number }>
  ): Promise<WildlandsGroundcoverBootstrap> => {
    requestedWildlandsFocus = { x: focus.x, z: focus.z };
    if (wildlandsGroundcoverPromise) return wildlandsGroundcoverPromise;

    let candidate: import("./world/wildlands").Wildlands | null = null;
    const attempt = (async (): Promise<WildlandsGroundcoverBootstrap> => {
      markLazyRegion("wildlands", "requested");
      const [wildlandsMod, golfMod, afterlightLayout] = await Promise.all([
        import("./world/wildlands"),
        import("./gameplay/golf"),
        import("./gameplay/afterlight/layout")
      ]);
      let loadedGolfCourse: import("./gameplay/golf").GolfCourse | null = null;
      try {
        loadedGolfCourse = await golfMod.loadGolfCourse(map);
      } catch (error) {
        // Golf data is optional to the world surface. The park remains usable
        // if a deploy is missing its course manifest.
        console.warn("[golf] course unavailable:", error);
      }

      candidate = wildlandsMod.createWildlands(map, {
        scheduleGroundcoverBuild: (job) => scheduler.schedule("build", job),
        groundcover: (x: number, z: number) =>
          afterlightLayout.inAfterlightGroundcoverClear(x, z, 1.2) ||
          (loadedGolfCourse?.contains(x, z, 1.2) ?? false),
        trees: loadedGolfCourse
          ? (x: number, z: number) => loadedGolfCourse!.clearsProceduralTrees(x, z)
          : undefined
      });
      const site = candidate;
      wildlands = site;
      markLazyRegion("wildlands", "constructed");
      const [treeGroup, ...groundcoverGroups] = site.groups;
      treeGroup.visible = false;
      const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (hooks) Object.assign(hooks, { wildlands: site, lazyRegionTimings });

      // Use the latest requested destination, not the player's pre-commit
      // position under the travel cover. Native-tree assembly records the same
      // focus but remains detached and optional.
      const destination = requestedWildlandsFocus ?? player.renderPosition;
      site.trees.update(destination);
      site.update(destination, destination);
      try {
        markLazyRegion("wildlands", "groundcover-compile-start");
        await site.prepareGroundcover((root) => renderer.compileAsync(root, camera, scene));
        markLazyRegion("wildlands", "groundcover-compile-end");
      } catch (error) {
        // Precompilation is an optimization. Publish the complete buffers and
        // let the live renderer compile a valid fallback rather than preserving
        // an empty destination forever.
        console.warn("[wildlands] destination groundcover compile failed:", error);
      }
      for (const group of groundcoverGroups) {
        group.visible = foliageOn;
        scene.add(group);
      }
      markLazyRegion("wildlands", "groundcover-attached");
      return { site, golfMod, loadedGolfCourse };
    })();
    wildlandsGroundcoverPromise = attempt;
    void attempt.catch(() => {
      if (wildlandsGroundcoverPromise !== attempt) return;
      wildlandsGroundcoverPromise = null;
      if (candidate) {
        if (wildlands === candidate) wildlands = null;
        candidate.dispose();
      }
    });
    return attempt;
  };

  const prepareWildlandsGroundcoverAt = async (
    focus: Readonly<{ x: number; z: number }>,
    signal?: AbortSignal
  ): Promise<void> => {
    const bootstrap = await waitForAbortable(startWildlandsGroundcover(focus), signal);
    // A latest-wins teleport can supersede the focus while shared imports or a
    // previous compile finish. Recenter once more, then await only critical
    // grass/flower pipelines—not native trees or golf.
    bootstrap.site.update(focus, focus);
    await waitForAbortable(
      bootstrap.site.prepareGroundcover((root) => renderer.compileAsync(root, camera, scene)),
      signal
    );
  };

  // Walking into a park before the broader deferred coordinator reaches its
  // region setup receives the same early bootstrap. The callback itself is
  // still proximity-gated by the frame loop and therefore requests nothing at
  // a distant clean boot.
  wakeDeferredWildlandsGolf = () => {
    wakeDeferredWildlandsGolf = null;
    void startWildlandsGroundcover(player.renderPosition).catch((error) =>
      console.warn("[wildlands] first-approach groundcover failed:", error)
    );
  };

  // Japanese Tea Garden destination essentials + rake/paint/water/interact
  // wiring — extracted per docs/MAIN_DECOMPOSITION.md. Merely creating the
  // controller requests nothing: the split chunk stays absent at a distant clean
  // boot; a teleport (prepareDestinationEssentials) or a first approach
  // (maybeWakeDeferred) starts it. __sf.japaneseTeaGarden /
  // teaGardenBuildingSwapState refresh through onDebugChanged.
  const teaGarden = createTeaGardenController({
    map,
    renderer,
    physics,
    nature,
    scene,
    camera,
    sky,
    tiles,
    hud,
    net,
    remotes,
    player,
    debugPanel,
    ballImpactAudio,
    getFetchBall: () => fetchBall,
    getFoliageOn: () => foliageOn,
    autoStartHiroTour,
    entrance: JAPANESE_TEA_GARDEN_ENTRANCE,
    markLazyRegion,
    waitForWorldBackgroundWindow,
    nextPresentationFrame,
    waitForAbortable,
    onDebugChanged: () => {
      const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (hooks) Object.assign(hooks, {
        japaneseTeaGarden: teaGarden.current(),
        lazyRegionTimings,
        teaGardenBuildingSwapState: teaGarden.buildingSwapState
      });
    }
  });
  // Wired here (not beside the other net handlers) so the closures never touch
  // the Tea Garden controller before it exists; both are null-safe internally.
  net.onRakeStamp = (stamp) => teaGarden.queueRakeStamp(stamp);
  net.onRakeReset = () => teaGarden.resetSand();

  prepareDestinationEssentials = async (destination, signal) => {
    // Optional exhibit at the destination: retire irrelevant in-flight sites
    // and put the destination's own site on the arrival priority lane. Fire
    // and forget — the travel cover must never wait on optional content.
    sites.reprioritizeForArrival(destination);
    const teaDistance = Math.hypot(
      destination.x - JAPANESE_TEA_GARDEN_ENTRANCE.x,
      destination.z - JAPANESE_TEA_GARDEN_ENTRANCE.z
    );
    if (teaDistance < 820) await teaGarden.ensureEssential(signal);

    // Selected park groundcover starts under the travel cover even when its
    // bundle was not previously resident. The authored Tea Garden owns its own
    // grass and is excluded so Hiro/Tea House remain the sole priority there.
    const inPrimaryWildlands = WILD_REGIONS.some((region) =>
      region.id !== "buenavista" &&
      destination.x >= region.minX - 320 && destination.x <= region.maxX + 320 &&
      destination.z >= region.minZ - 320 && destination.z <= region.maxZ + 320
    );
    if (inPrimaryWildlands && teaDistance >= 820) {
      await prepareWildlandsGroundcoverAt(destination, signal);
    }
  };

  // Optional authored-site scheduler (Goldman/pickleball, archery, pup, Fort
  // Mason, palace, afterlight, Corona Heights, Lands End, Wave Organ, Beach
  // Pianist, Sutro Baths) + exhibit vegetation + the streaming perf panel —
  // extracted per docs/MAIN_DECOMPOSITION.md. The controller owns the site refs
  // and the lazy loads; main keeps thin `let` aliases (declared above) so its
  // hot per-frame loop and the __sf literal read the concrete instances
  // unchanged, re-synced here via onSitesChanged (the old refreshOptionalSiteDebug
  // points). The __sf assignment payload is byte-for-byte the prior one.
  const sites = createOptionalSites({
    map, physics, scene, sky, tiles, renderer, camera, nature, net, player,
    input, hud, chase, remotes, embodiments, fx, siteGate, worldArrival,
    debugPanel, dogParkAudio, authoredRegions, worldQueries,
    waitForWorldBackgroundWindow,
    revealedPromise,
    getFoliageOn: () => foliageOn,
    getRevealed: () => revealed,
    getAvatar: () => avatarTraits,
    onSitesChanged: (r) => {
      goldenGateTennis = r.goldenGateTennis;
      pickleballController = r.pickleballController;
      archery = r.archery;
      pup = r.pup;
      fortMasonEnsemble = r.fortMasonEnsemble;
      palaceReverie = r.palaceReverie;
      afterlight = r.afterlight;
      coronaHeights = r.coronaHeights;
      landsEnd = r.landsEnd;
      waveOrgan = r.waveOrgan;
      // Beach Pianist keeps two concerns in main (they read main-local state the
      // controller can't see): its debug tuning folder and the god-ray radial-
      // light ownership. HEAD ran these inside loadBeachPianist / its unloader;
      // in the extracted model they ride the alias transition here. onSitesChanged
      // fires for every site change, so guard on the pianist ref actually flipping.
      if (r.beachPianist !== beachPianist) {
        if (r.beachPianist) {
          unregisterBeachPianistTuning?.();
          unregisterBeachPianistTuning = debugPanel.registerFeatureTuning(r.beachPianist.tuningDescriptor());
        } else {
          if (activeRadialLight?.owner === "beach-pianist") releaseActiveRadialLight();
          unregisterBeachPianistTuning?.();
          unregisterBeachPianistTuning = null;
        }
      }
      beachPianist = r.beachPianist;
      sutroBaths = r.sutroBaths;
      const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (hooks) Object.assign(hooks, {
        goldenGateTennis,
        pickleballController,
        pickleball: pickleballController?.game ?? null,
        pickleballAmbient: pickleballController?.ambient ?? null,
        pickleballAudio: pickleballController?.audio ?? null,
        pickleballUI: pickleballController?.ui ?? null,
        archery,
        pup,
        fortMasonEnsemble,
        palaceReverie,
        afterlight,
        coronaHeights,
        landsEnd,
        waveOrgan,
        beachPianist,
        sutroBaths
      });
    }
  });
  siteFoliage = sites.siteFoliage;

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
    // CityGen remains a post-reveal dynamic import, so it cannot compete with
    // the local first frame or enter the clean-boot bundle/request waterfall.
    // Once admitted, however, its nearby destination cell must make progress
    // during ordinary walking/driving instead of waiting for movement to stop.
    await revealedPromise;
    await waitForCityGenRenderWindow();

    // CityGen improves every district, so start it before fauna and authored
    // sites. The ring yields once per detached WebGPU owner and can cancel stale
    // cell work by generation before driver compilation starts.
    const citygenMod = await import("./world/citygen");
    await waitForCityGenRenderWindow();
    try {
      citygenRing.current = await citygenMod.createCityGenRing(
        {
          excludeBuilding: (key, index) =>
            // The roster is fixed here, before the restored hall wakes. Reserve
            // its boiler-room footprint alongside the authored Tea Garden and
            // the six source-authored Fort Mason replacements.
            isTeaGardenBuilding(key, index) ||
            (key === "1_12" && index === 0) ||
            (key === "10_8" && [0, 19, 20, 22, 23, 24].includes(index))
        },
        {
          scene,
          physics,
          map,
          tiles,
          schedule: scheduler.schedule,
          beforeRenderOwnership: (isCurrent) => waitForCityGenRenderWindow(isCurrent),
          // The ring keeps these exact owners detached and submits them one at
          // a time, yielding a presentation frame before every compile. It is
          // not published until every exterior driving variant is prepared.
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

    // Forest + Creatures: the bay serpent and rideable animals
    await waitForWorldBackgroundWindow(1800);
    const [forestMod, creaturesMod] = await Promise.all([
      import("./gameplay/forest"),
      import("./gameplay/creatures")
    ]);
    await waitForWorldBackgroundWindow(1800);
    ANIMALS = forestMod.ANIMALS as NonNullable<typeof ANIMALS>;
    creatures = new creaturesMod.Creatures(scene);
    forest = new forestMod.Forest(map, scene);

    // Each optional region keeps its code, textures and tree growth behind its
    // own gate. A clean boot does not fetch all parks merely because the module
    // coordinator itself is running.
    let gardenModPromise: Promise<typeof import("./world/garden")> | null = null;
    let buenaVistaTreesModPromise: Promise<typeof import("./world/wildlands/buenaVistaTrees")> | null = null;
    const loadGardenMod = () => gardenModPromise ??= import("./world/garden");
    const loadBuenaVistaTreesMod = () => buenaVistaTreesModPromise ??= import("./world/wildlands/buenaVistaTrees");
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
      // Destination groundcover has an independent early gate above. Reuse that
      // exact owner here so the later tree/golf enrichment cannot construct a
      // duplicate park or refetch its chunks.
      const {
        site: _wildlands,
        golfMod,
        loadedGolfCourse
      } = await startWildlandsGroundcover(player.renderPosition);
      const [wildTreeGroup] = _wildlands.groups;

      // Tree assembly and driver preparation continue as optional enrichment.
      // They retain the quiet-window policy without holding back the lawn.
      await _wildlands.ready;
      markLazyRegion("wildlands", "trees-ready");
      await waitForWorldBackgroundWindow();
      await _wildlands.prepareTrees(async (unit) => {
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
      wildTreeGroup.visible = foliageOn;
      scene.add(wildTreeGroup);
      markLazyRegion("wildlands", "trees-attached");
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
      buenaVistaTreesReady,
      wildlandsGolfReady
    ].filter(Boolean));

  })()
    .catch((err) => {
      if (!teaGarden.current()) teaGarden.restoreBuildings();
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
  // `?flickerspy=1`: in-session diagnostic for the sky-flicker reports — see
  // dev/flickerSpy.ts. Lazy import; costs nothing without the flag.
  if (bootQuery.has("flickerspy")) {
    void import("./dev/flickerSpy").then(({ installFlickerSpy }) =>
      installFlickerSpy({ renderer, scene, camera })
    );
  }
  // Local development is primarily exercised by browser agents, so enter the
  // world as soon as it is ready instead of leaving them stranded at a purely
  // human identity gate. `?startscreen=1` keeps the real onboarding path easy
  // to inspect. Deployed browser tests opt in explicitly with `?autostart=1`.
  const autoEnter =
    !beganAsReadingVisit &&
    !bootQuery.has("startscreen") &&
    (import.meta.env.DEV || ["autostart", "demo", "profile"].some((key) => bootQuery.has(key)));
  // Explicit headless verification, demos and perf runs also skip the settle
  // hold because they measure live-frame behaviour rather than boot polish.
  const skipGate = ["demo", "skipsettle"].some((key) => bootQuery.has(key));
  // Local HMR reloads that were already in-game resume without the identity gate.
  // Production always waits for Start / Enter — returning players keep their saved
  // name prefilled in the form. Deployed tests still opt in via `?autostart` etc.
  // (handled by `autoEnter` above).
  const autoStartSaved =
    !beganAsReadingVisit &&
    !bootQuery.has("startscreen") &&
    Boolean(devReload?.started);
  const revealWorld = (reason = "settled") => {
    if (revealed) return;
    revealed = true;
    backgroundAdmission.deferAtLeast(1200);
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
      // requests it (a no-op if the browser declines; first scene click re-locks)
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
    // One already-rendered covered destination frame plus this reveal tick are
    // enough to prove the destination is stable: the browser cannot composite
    // the removed cover until this tick's render has also returned. A 12-frame
    // hold made slow GPUs wait much longer than fast ones after identical work.
    if (quietFrames >= 2) {
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

  // A shared `?read=` link is handled earlier by startup.ts: the
  // panel is already opening over the loading folio while the world settles here
  // in the background. No auto-enter — the visitor meets the start screen only
  // when they close the panel.

  const timer = new THREE.Timer();
  let accumulator = 0;
  let elapsed = 0;
  // Past this range the horizon proxy is a sub-15px smudge behind marine fog;
  // keeping it out of the draw list entirely is what prevents it from ever
  // flashing mid-sky on a corrupted frame.
  const GHOST_SHIP_PROXY_VIEW_DISTANCE = 3200;
  const updateGhostShip = (dt: number) => {
    const pose = ghostShipBeacon.update(Date.now());
    minimap.moveLandmark(GHOST_SHIP_LANDMARK_NAME, pose.x, pose.z);
    const distance = ghostShipBeacon.horizontalDistanceTo(player.renderPosition);
    ghostShipBeacon.farHidden = distance > GHOST_SHIP_PROXY_VIEW_DISTANCE;
    if (
      !worldArrival.active &&
      !ghostShip &&
      !ghostShipLoading &&
      !ghostShipLoadFailed &&
      (distance <= GHOST_SHIP_DETAIL_WAKE_DISTANCE || embodiments.passengerOf === GHOST_SHIP_RIDE_ID)
    ) {
      void ensureGhostShipDetail();
    }
    ghostShip?.update(
      dt,
      elapsed,
      pose,
      player.renderPosition,
      embodiments.passengerOf === GHOST_SHIP_RIDE_ID
    );
    if (ghostShip && embodiments.passengerOf === GHOST_SHIP_RIDE_ID) {
      const shipYaw = ghostShip.root.rotation.y;
      if (ghostShipRideYaw === null) {
        chase.yaw = shipYaw;
      } else {
        const delta = Math.atan2(
          Math.sin(shipYaw - ghostShipRideYaw),
          Math.cos(shipYaw - ghostShipRideYaw)
        );
        chase.yaw += delta;
      }
      ghostShipRideYaw = shipYaw;
    } else {
      ghostShipRideYaw = null;
    }
  };
  let paused = false;
  // When paused, the world sim freezes but the player stays live by default
  // (walk/drive/fly on) so you can keep roaming the frozen city. The pause
  // toggle flips this to freeze the player too, for a still shot.
  let freezePlayer = false;
  let immersive = false;
  // Z-hold time scrub + N-hold look/speed adjust — extracted per docs/MAIN_DECOMPOSITION.md.
  const timeScrubGestures = createTimeScrubAndTuningGestures({ input, sky, hud });

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
  const applyPickleballPlayerPose = () => {
    pickleballController?.applyPlayerPose();
    fortMasonEnsemble?.applyPlayerPose();
  };
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
      embodiments.passengerOf ?? 0,
      embodiments.passengerSeat,
      // a held-rake wire row has no rideSeat slot, so while riding shotgun the
      // plain ride row wins — viewers would otherwise collapse us onto seat 1
      embodiments.passengerOf === null ? teaGarden.rakeMotion() : null
    );
  };
  const sendPickleballNetwork = () => pickleballController?.sendNetwork();
  // 0..1 "how strongly a lit streetlamp pool falls on the rider right now",
  // rebuilt on the CPU from the same hero pool centres + night intensity the
  // projected-surface-light pass uses to paint the warm glow on the avatar. Feeds
  // the hoverboard's electric-field whoosh (vehicleAudio) so the sound tracks the
  // light you see on yourself: skirting the edge is a whisper, dead-centre is full.
  const lampFieldPos = new THREE.Vector4();
  const lampFieldNrm = new THREE.Vector4();
  const computeLampField = (): number => {
    const lamps = streetLamps?.projectedSurfaceLightSource;
    if (!lamps) return 0;
    const nightW = Math.min(1, Math.max(0, lamps.intensity / LIGHT_SCALE)); // day→0, night→1
    if (nightW <= 0.001 || lamps.count <= 0) return 0;
    const px = player.position.x;
    const pz = player.position.z;
    let hit = 0;
    for (let i = 0; i < lamps.count; i++) {
      lamps.copyLight(i, lampFieldPos, lampFieldNrm); // xyz = pool centre, w = radius
      const dx = px - lampFieldPos.x;
      const dz = pz - lampFieldPos.z;
      const radius = lampFieldPos.w || 6;
      const fall = Math.max(0, 1 - Math.hypot(dx, dz) / radius);
      const f = fall * fall; // matches the pass's pow(...,2) radial falloff
      if (f > hit) hit = f;
    }
    return hit * nightW;
  };
  // Frame-local crossings hoisted to loop scope so the split hooks share one
  // value per frame: preSimulate computes them (the pickleball gameplay advance
  // has side effects and must run exactly once), the live path reads them; the
  // fixed-step count crosses from simulate into updateWorld.
  let steps = 0;
  let playingPickleball = false;
  let playingFortMasonEnsemble = false;
  let pickleballEConsumed = false;
  // The always-run prologue every branch shares. timer.update()/frameDt and the
  // HMR flush live in createGameLoop (app/gameLoop.ts), which owns frame timing.
  const beginFrame = (frameDt: number) => {
    // The one audio-engine tick — placed before every branch's early return so
    // group gains, idle suspend, and the listener advance in all of them
    // (active, map-open, paused, and the reading-overlay freeze; voice keeps
    // running while paused).
    audioEngine.update(frameDt, camera);
    // Optional regions and shader warmups require a genuinely quiet user
    // window. Continuous first-play movement keeps pushing those stages back;
    // the fixed-quality local tile streamer remains active throughout.
    backgroundAdmission.noteMotion();

    // gamepad first so its synthetic key codes exist for every consumer below,
    // then the scripted driver (third device on the same rails — cinematics,
    // QA probes, autopilots) so its writes land before any consumer reads
    input.pollPad(frameDt);
    input.pollDriver(frameDt);
    minigameSession.beginFrame(captureMinigameOrigin());
  };

  // Behind-the-scenes and the Canticle book both freeze the world completely —
  // no sim, no render; the canvas keeps its last frame (dimmed via CSS) behind
  // the DOM overlay, whose own animation runs on its own rAF. Before the player
  // has entered (a shared ?read= link opens the panel over the loading folio),
  // keep ticking so the world keeps streaming in behind the modal — the gate is
  // the `started` class. The freeze itself is dispatched in app/gameLoop.ts via
  // the readingFrozen/endInputOnly hooks inlined at the createGameLoop call.

  // Global toggles plus the shared wall-clock ghost-ship route. Runs before the
  // minimap branch so an M press here can open/close the map this same frame.
  const globalKeysAndGhost = (frameDt: number) => {
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

    // Wall-clock route remains shared even when the local simulation/sky clock
    // is paused or scrubbed. This runs before remotes so world passengers glue
    // to the current deck transform in every branch below.
    updateGhostShip(frameDt);
  };

  // Expanded map: gamepad pan / zoom / select / teleport / pin cycle.
  // World + player are fully frozen while the map is open (kb or pad). This
  // branch renders itself; minimapOpen (inlined at createGameLoop) gates it.
  const runMinimapFrame = (frameDt: number) => {
    const axes = input.mapPadAxes();
      minimap.padPan(axes.lx, axes.ly, frameDt);
      // RT / stick-up zoom in; LT / stick-down zoom out. Selector stays centered.
      minimap.padZoom(axes.rt - axes.lt - axes.ry, frameDt);
      if (input.pressedRaw("Space")) minimap.padSelectAtCursor();
      if (input.firePressed) minimap.padTeleport();
      if (input.pressedRaw("Enter") || input.pressedRaw("NumpadEnter")) minimap.padTeleport();
      const mapPadCycle =
        (input.pressedRaw("PadModeNext") ? 1 : 0) - (input.pressedRaw("PadModePrev") ? 1 : 0);
      if (mapPadCycle) minimap.padCyclePins(mapPadCycle);

      dogParkAudio.setPaused(true);
      vehicleAudio.update(frameDt, null);
      swimAudio.update(frameDt, null);
      updatePlayerFoley(frameDt, false);
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
      if (
        embodiments.passengerOf !== null &&
        remotes.ridePose(embodiments.passengerOf, embodiments.passengerSeat, ridePos, rideQuat)
      ) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      }
      remotes.glueRidersToLocalVehicle();
      voice.update();
      minimap.update();
      playerLocator.update(camera, player.position, remotes.locatorTargets());
      updateSurfPresentation(frameDt);
      sky.update(elapsed, camera.position, player.renderPosition);
      hud.update(frameDt);
      input.endFrame();
      renderFrame();
  };

  // Site wake/sleep + minigame precompute, then the two paused branches. Returns
  // "handled" when a paused branch rendered this frame, else "live" to fall
  // through to the live frame. The precompute writes the loop-scope crossings
  // (pickleball/fort-mason) the live path also reads.
  const preSimulate = (frameDt: number): "handled" | "live" => {
    // Crossing the generic approach radius requests at most one authored site;
    // the queue rechecks after the arrival-quiet window before importing it.
    afterlight?.setNightOpen(isAfterlightOpenAtHour(sky.timeOfDay));
    sites.update();
    sites.applyPerfGates();
    // One wake/sleep pass over every registered minigame site (pickleball,
    // golf, …): a contains() test per site, setAwake only on transitions.
    if (!worldArrival.active) siteGate.update(player.position.x, player.position.z);

    // The shared court keeps advancing even while the rest of the world is
    // paused, so a remote opponent never loses the match when authority opens
    // photo/pause controls.
    pickleballEConsumed =
      worldArrival.active || !sites.perfAllowed("goldman")
        ? false
        : updatePickleballGameplay(frameDt);
    playingPickleball = pickleballController?.playing ?? false;
    playingFortMasonEnsemble =
      !worldArrival.active && sites.perfAllowed("fort-mason-ensemble")
        ? fortMasonEnsemble?.update(frameDt, elapsed, player.renderPosition, camera) ?? false
        : false;
    applyPickleballPlayerPose();

    // Full freeze: a pause with "freeze player" armed. Everything holds — sim,
    // player, fx, vehicles — while a clean screenshot floats on top.
    dogParkAudio.setPaused(paused);
    if (paused && freezePlayer && !worldArrival.active) {
      vehicleAudio.update(frameDt, null); // fade the hum out while frozen
      swimAudio.update(frameDt, null);
      updatePlayerFoley(frameDt, false);
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
      if (
        embodiments.passengerOf !== null &&
        remotes.ridePose(embodiments.passengerOf, embodiments.passengerSeat, ridePos, rideQuat)
      ) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      }
      remotes.glueRidersToLocalVehicle();
      voice.update(); // keep talking while paused — it's a social feature
      minimap.update();
      playerLocator.update(camera, player.position, remotes.locatorTargets());
      updateSurfPresentation(frameDt);
      // Social/remount poses can still move while the simulation clock is
      // frozen. Keep the full-rate hero map aligned before drawing this frame.
      sky.update(elapsed, camera.position, player.renderPosition);
      input.endFrame();
      renderFrame();
      return "handled";
    }

    // World frozen, player live: the default pause. The whole city sim holds
    // (sky, water, fx never tick) but the player keeps moving — walk, drive,
    // fly — so you can keep roaming the frozen city. We run ONLY the player's own
    // step + camera + tile streaming. The player's dynamic body still steps
    // physics.
    if (paused) {
      accumulator += frameDt; // no elapsed++ — the world clock stays frozen
      if (player.mode === "plane") player.steerFly(input, frameDt);
      if (!playingPickleball && !playingFortMasonEnsemble && !input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
      if (!playingPickleball && !playingFortMasonEnsemble && !input.suspended && player.mode === "surf" && input.pressed("Space")) {
        player.requestSurfJump();
      }
      if (!playingPickleball && !playingFortMasonEnsemble && !input.suspended && player.mode === "surf" && input.pressed("KeyX")) {
        player.requestSurfFlow();
      }
      if (!playingPickleball && !playingFortMasonEnsemble && !input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();
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
      if (
        embodiments.passengerOf !== null &&
        remotes.ridePose(embodiments.passengerOf, embodiments.passengerSeat, ridePos, rideQuat)
      ) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      } else {
        player.afterSteps(steps, accumulator / physics.world.fixedTimeStep);
        player.syncMesh(frameDt);
      }
      remotes.glueRidersToLocalVehicle();
      applyPickleballPlayerPose();
      carLanding.consume();
      const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
      highUp = highUp ? altitude > 110 : altitude > 150;
      tiles.update(player.position.x, player.position.z, highUp);
      // Live-player pause still allows walking. Keep the generated-building gate
      // and streaming focus current so crossing a doorway cannot leave the camera
      // stuck in the previous indoor/outdoor mode.
      if (!worldArrival.active) {
        citygenRing.current?.update(player.position, frameDt);
        if (sites.perfAllowed("sutro-baths")) {
          sutroBaths?.update(0, elapsed, player.renderPosition, camera, windGustValue());
        }
      }
      if (inOrbit()) { chase.suspend(player); orbit.update(frameDt); }
      else {
        player.indoor = chase.indoor =
          (citygenRing.current?.isPlayerInside() ?? false) ||
          (missionDolores?.isPlayerInside(player.position) ?? false) ||
          (sutroBaths?.isPlayerInside(player.position) ?? false);
        chase.update(frameDt, player, input);
      }
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
        driveVoice: player.driveSpec.voice ?? "engine",
        driveSlide: player.driveSlideFeedback.intensity,
        lampLight: player.mode === "board" ? computeLampField() : 0
      });
      swimAudio.update(frameDt, {
        swimming: player.swimming,
        speed: Math.hypot(player.velocity.x, player.velocity.z),
        vspeed: player.velocity.y
      });
      updatePlayerFoley(frameDt, true);
      nature.update(frameDt, {
        playerPos: player.renderPosition,
        camera,
        gust: windGustValue(),
        timeOfDay: sky.timeOfDay,
        allowNewLoads: !worldArrival.active
      });
      sendLocalPresence();
      sendPickleballNetwork();
      voice.update();
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
      return "handled";
    }

    return "live";
  };

  // Live-frame input: mode/tool/teleport keys, interact chain, click-tool fire,
  // time scrub, fly steering + latched jumps, ending at chase.lookDir. Advances
  // the world clock too — this is the only path that increments elapsed.
  const liveInput = (frameDt: number) => {
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
      if (playingPickleball || playingFortMasonEnsemble) break;
      if (golf?.capturesDigits) break; // golf swing UI owns the number row (club picks)
      if (ctrlNumberPress(i)) {
        toolCycle.pickByIndex(i - 1);
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
    // Keyboard arrows and d-pad share the toolbar: ↑/↓ change row focus,
    // ←/→ cycle the focused row (vehicles / tools / paint swatches).
    if (!playingPickleball && !playingFortMasonEnsemble) {
      const dx =
        (input.pressed("ArrowRight") && !input.altPressed("ArrowRight") ? 1 : 0) -
        (input.pressed("ArrowLeft") && !input.altPressed("ArrowLeft") ? 1 : 0) +
        (input.pressed("PadModeNext") ? 1 : 0) -
        (input.pressed("PadModePrev") ? 1 : 0);
      const dy =
        (input.pressed("ArrowDown") ? 1 : 0) -
        (input.pressed("ArrowUp") ? 1 : 0) +
        (input.pressed("PadNavDown") ? 1 : 0) -
        (input.pressed("PadNavUp") ? 1 : 0);
      // An open dialogue choice list owns the nav keys; the toolbar resumes
      // the moment the decision is made.
      const choosingTalk = beachPianist?.choosing
        ? beachPianist
        : buskerTalk.choosing
          ? buskerTalk
          : null;
      if (choosingTalk) {
        if (dy) choosingTalk.navigate(dy);
      } else if (dx || dy) {
        toolbar.navigate(dx, dy);
      }
    }
    if (!playingPickleball && input.altPressed("ArrowLeft")) applyPlaceHistory(-1);
    if (!playingPickleball && input.altPressed("ArrowRight")) applyPlaceHistory(1);

    // Enter is the primary "select" gesture inside an open conversation (E and
    // pad Y confirm too, via the interact chain below). Gated on an active
    // conversation so Enter keeps its other jobs (chat/minimap) everywhere else.
    const activeTalk = beachPianist?.active
      ? beachPianist
      : buskerTalk.active
        ? buskerTalk
        : null;
    if (activeTalk && (input.pressed("Enter") || input.pressed("NumpadEnter"))) {
      activeTalk.confirm();
    }

    // E / pad Y: nearby conversations get first refusal. When the prompt was
    // reached on a vehicle or creature, the same press dismounts and is handed
    // back to the conversation once the player is on foot; requiring a second
    // press made Hiro's visible prompt appear unresponsive.
    const interactPressed = !worldArrival.active && !pickleballEConsumed && input.pressed("KeyE");
    // Use the same position the tea-garden prompt distance is measured against
    // (renderPosition), so a visible "Talk" prompt always accepts the matching E.
    let teaGardenEConsumed = interactPressed
      && teaGarden.interact(player.renderPosition, player.mode);
    const exitedToWalk = interactPressed && !teaGardenEConsumed && exitToWalk();
    if (exitedToWalk) {
      teaGardenEConsumed = teaGarden.interact(player.renderPosition, player.mode);
    }
    if (
      !pickleballEConsumed &&
      !teaGardenEConsumed &&
      interactPressed &&
      !exitedToWalk &&
      !(beachPianist?.tryInteract(player.renderPosition, player.mode) ?? false) &&
      !buskerTalk.tryInteract(player.renderPosition, player.mode) &&
      !golf?.tryStartAtTee(player, hud) &&
      !archery?.tryInteract(player, hud, chase) &&
      !fortMasonEnsemble?.tryInteract(player.renderPosition, player.mode) &&
      !palaceReverie?.tryInteract(player, hud) &&
      !landsEnd?.keeper.tryInteract(player, hud) &&
      !waveOrgan?.tryInteract(player, hud) &&
      !missionDolores?.tryInteract(player.position, player.mode, hud) &&
      !afterlight?.tryInteract(player, hud) &&
      !(
        surfShack?.tryInteract(player, hud, (config) => {
          surfboardConfig = config;
          setLocalSurfboardConfig(config);
          player.setSurfboardConfig(config);
          const request = ++surfEntryRequest;
          // Full preparation (camera + runtime + a fresh embodiment compile if
          // the grabbed board differs) so the first ridden frame is stall-free.
          void prepareSurfEntry().then(() => {
            if (request !== surfEntryRequest || player.mode !== "walk") return;
            navigation.switchMode("surf");
          });
        }) ?? false
      )
    ) {
      const nearGhostShip = player.mode === "walk" && (ghostShip?.nearbyBoarding(player.position) ?? false);
      if (nearGhostShip) {
        const seat = ghostShip?.board(
          player.position,
          remotes.occupiedRideSeats(GHOST_SHIP_RIDE_ID)
        ) ?? 0;
        if (seat > 0) {
          ghostShipRideZoom ??= chase.zoom;
          chase.zoom = Math.max(chase.zoom, 3.2);
          embodiments.startPassengerRide(GHOST_SHIP_RIDE_ID, seat);
          hud.message(`Aboard the wandering ghost ship · deck station ${seat} · E to step off`, 3.2);
        } else {
          hud.message("The ghost ship's deck stations are full", 2.2);
        }
      } else {
        const nearOceanBeach = player.mode === "walk" && nearOceanBeachShore(player.position.x, player.position.z);
        if (nearOceanBeach) {
        // Load both exclusive camera and activity runtime before changing
        // embodiment, so the first visible surf frame is already complete.
        const request = ++surfEntryRequest;
        void prepareSurfEntry().then((ready) => {
          if (!ready || request !== surfEntryRequest || player.mode !== "walk") return;
          if (!nearOceanBeachShore(player.position.x, player.position.z)) return;
          player.trySwitch("surf");
          // The persistent surf HUD already carries controls; keep this as a
          // quick entry confirmation so it is gone before a fast tube line.
          hud.message("You're surfing — A/D carve · W pump · S stall · E exits to the beach", 1);
        });
        } else if (!fetchBall?.tryPickup(player.position)) {
        const drv = remotes.nearestDriver(player.position, 5.5);
        const animal = drv ? null : forest?.nearest(player.position, 5);
        if (drv) {
          if (drv.mode === "bird") setRemoteBirdAssetsActive(true);
          embodiments.startPassengerRide(drv.id, drv.seat);
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
            player.boardMount(mount);
            hud.message("Back on board — E to hop off", 2.4);
          } else if (player.mode === "walk" && citygenRing.current) {
            // front doors: on foot, E toggles the nearest generated-building
            // door (the ring owns the state — swing + collider swap live there)
            const d = citygenRing.current.nearestDoor(player.position);
            if (d && d.dist < 2.6) {
              const r = citygenRing.current.toggleDoor(d.id);
              if (r === "opened" || r === "closed" || r === "blocked") {
                const dx = d.x - camera.position.x;
                const dz = d.z - camera.position.z;
                const distance = Math.hypot(dx, dz) || 1;
                const pan = ((dx * Math.cos(chase.yaw) - dz * Math.sin(chase.yaw)) / distance) * 0.5;
                doorAudio.event(r, {
                  sourceId: d.id,
                  pan,
                  room: player.indoor ? 0.42 : 0.24,
                  intensity: r === "blocked" ? 0.64 : 0.78,
                  weight: 0.68
                });
              }
              if (r === "opened") hud.message("Door's open — step inside", 2.4);
              else if (r === "closed") hud.message("Door closed", 1.6);
              else if (r === "blocked") hud.message("Step out of the doorway first", 2);
            }
          }
        }
      }
      }
    }

    // A claimed Afterlight participant owns locomotion, pointer/right-stick
    // look, wheel and tool fire for this frame. Capture before the player fixed
    // step so controller sticks move the two hands instead of the body/camera.
    const afterlightControlsCaptured =
      !worldArrival.active && (afterlight?.captureInput(input, frameDt, player) ?? false);

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
      citygenRing.current?.refreshInteriors();
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
    // H: high-res in-game still → local in_game_shots folder (dev server writer)
    if (
      document.body.classList.contains("started") &&
      !worldArrival.active &&
      input.pressed("KeyH") &&
      !isInGameScreenshotBusy()
    ) {
      hud.message("Capturing…", 1.2);
      void takeInGameScreenshot({
        renderer,
        renderFrame,
        captureStillRgba: pipeline.captureStillRgba,
        setCinematicMultisampling: pipeline.setCinematicMultisampling
      })
        .then((shot) => {
          const name = shot.path.split("/").pop() ?? "shot.png";
          hud.message(`Saved ${name} (${shot.width}×${shot.height})`, 3.5);
        })
        .catch((err) => {
          console.warn("[screenshot]", err);
          hud.message(err instanceof Error ? err.message : "Screenshot failed", 3.5);
        });
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
    } else if (toolCycle.tool === "ball") {
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
      if (toolCycle.tool === "spray" && fireCooldown <= 0) {
        // paintballs: visible ballistic shots that splat wherever they land —
        // walls via graffiti.burst, vehicles/players via paintSkins. The shot
        // is broadcast (origin+velocity+color) so everyone sees it fly.
        fireCooldown = 0.12;
        const col = graffiti.nextColor();
        const paintColor = { r: col.r, g: col.g, b: col.b };
        const soundPaintShot = (audio: PaintAudioInstance) => audio.shot({
          color: paintColor,
          pressure: 0.82,
          intensity: 0.74,
          pan: 0.035,
          room: player.indoor ? 0.16 : 0.05,
          sourceId: net.selfId
        });
        if (paintAudio) soundPaintShot(paintAudio);
        else void ensurePaintAudio().then(soundPaintShot);
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
      } else if (toolCycle.tool === "bubbles" && fireCooldown <= 0) {
        fireCooldown = 0.14;
        bubbles.blow(rayOrigin, aim, player.velocity);
        if (bubbleAudio) {
          bubbleAudio.blow({
            pan: 0.04,
            intensity: 0.72,
            duration: 0.24,
            shimmer: 0.62
          });
        } else {
          void ensureBubbleAudio().then((audio) => audio.blow({
            pan: 0.04,
            intensity: 0.72,
            duration: 0.24,
            shimmer: 0.62
          }));
        }
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
    timeScrubGestures.update(frameDt, scrubHeld, adjustHeld);

    // fly: mouse steers the plane at frame rate; W/S throttle happens in the fixed step
    if (player.mode === "plane") player.steerFly(input, frameDt);
    // Latch hoverboard ollies at render-frame rate. On high-refresh displays a
    // frame can render without a fixed physics step, so `pressed()` would be gone
    // before #updateBoard saw it.
    if (!playingPickleball && !playingFortMasonEnsemble && !input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
    if (!playingPickleball && !playingFortMasonEnsemble && !input.suspended && player.mode === "surf" && input.pressed("Space")) {
      player.requestSurfJump();
    }
    if (!playingPickleball && !playingFortMasonEnsemble && !input.suspended && player.mode === "surf" && input.pressed("KeyX")) {
      player.requestSurfFlow();
    }
    if (
      !playingPickleball &&
      !playingFortMasonEnsemble &&
      !afterlightControlsCaptured &&
      !input.suspended &&
      player.mode === "walk" &&
      input.pressed("Space")
    ) player.requestWalkJump();

    chase.lookDir(aim); // drone moves along the true view direction (no shot bias)
  };

  // Fixed-step physics accumulation. gameLoop.ts brackets this with the "physics"
  // tracer phase; `steps` crosses to updateWorld for the render interpolation.
  const simulate = (_frameDt: number) => {
    physics.maintainStreaming(player.position);
    steps = 0;
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
  };

  // The full world update. gameLoop.ts brackets this with the "world" tracer
  // phase. Camera commit, water/fx, entity proxies, cursor, HUD/debug all here.
  const updateWorld = (frameDt: number) => {

    // everyone else's interpolation advances BEFORE my pose settles: a
    // passenger's seat is glued to this frame's view of the driver's car
    remotes.selfId = net.selfId;
    remotes.update(frameDt);
    hidePickleballRemoteAvatars();
    // personal space: standing inside another avatar shimmers like z-fighting
    player.separateFromAvatars(remotes.walkingPositions(), frameDt);
    if (embodiments.passengerOf !== null) {
      if (remotes.ridePose(embodiments.passengerOf, embodiments.passengerSeat, ridePos, rideQuat)) {
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
    // riders of MY vehicle re-glue against the mesh transform that was just
    // settled — without this they'd sit one frame behind the cabin at speed
    remotes.glueRidersToLocalVehicle();
    applyPickleballPlayerPose();
    carLanding.consume();
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
    if (!worldArrival.active) teaGarden.maybeWakeDeferred(player.position);
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
        // Wildlands only on a real approach to one of its four regions. The
        // authored Tea Garden owns its immediate foliage and keeps this broader
        // park/golf bundle asleep until the player leaves that site.
        (
          nearPrimaryWildRegion(player.position.x, player.position.z, 320) &&
          Math.hypot(
            player.position.x - JAPANESE_TEA_GARDEN_ENTRANCE.x,
            player.position.z - JAPANESE_TEA_GARDEN_ENTRANCE.z
          ) >= 820
        ) ||
        Math.hypot(player.position.x - GOLF_XZ.x, player.position.z - GOLF_XZ.z) < 700
      )
    ) {
      const wake = wakeDeferredWildlandsGolf;
      wakeDeferredWildlandsGolf = null;
      wake();
    }
    // high over the city streams buildings only — no park lawns / trees uploaded.
    // turbo while the loading cover is still up (see the settle gate)
    if (!worldArrival.active) authoredRegions.update(player.position.x, player.position.z);
    tiles.update(player.position.x, player.position.z, highUp, !revealed);
    trafficLights?.update(player.position, performance.now() / 1000);
    streetLamps?.update(player.position);
    refreshCarHeadlightUniforms();
    abandonedMounts.update(frameDt, player.position);
    if (!worldArrival.active) {
      creatures?.update(elapsed, camera.position);
      forest?.update(frameDt, camera.position);
    }
    // Night ball glow amount from the current sun elevation (park / fetch / held /
    // pickleball all read BALL_GLOW_NIGHT). Uses last sky.update's elevation —
    // fine; elevation only moves with the clock.
    syncBallGlowNight(sky.sunElevation);
    if (!worldArrival.active) {
      if (sites.perfAllowed("corona")) {
        coronaHeights?.update(frameDt, elapsed, camera.position);
      } else if (coronaHeights) {
        coronaHeights.group.visible = false;
      }
      if (sites.perfAllowed("lands-end")) {
        landsEnd?.update(frameDt, elapsed, player.position, camera, windGustValue());
        if (landsEnd && player.mode === "walk") {
          landsEnd.keeper.updatePrompt(player.position.x, player.position.z, hud);
        }
      } else if (landsEnd) {
        landsEnd.group.visible = false;
      }
      if (sites.perfAllowed("wave-organ")) {
        // hud only while on foot — walking is how you put an ear to a pipe.
        waveOrgan?.update(frameDt, elapsed, player.position, player.mode === "walk" ? hud : null);
      } else if (waveOrgan) {
        waveOrgan.group.visible = false;
      }
      if (sites.perfAllowed("beach-pianist")) {
        beachPianist?.setPerfSuppressed(false);
        beachPianist?.update(frameDt, elapsed, player.position, camera, windGustValue());
      } else if (beachPianist) {
        beachPianist.setPerfSuppressed(true);
      }
      // Landscape vegetation rings (internally gated on the master foliage
      // toggle; a few hypot tests per frame when idle).
      siteFoliage?.update(player.position.x, player.position.z);
    }
    // Ball fetch loop + pet follow run every frame, tool-agnostic, so a thrown
    // ball keeps bouncing and a returning/adopted dog keeps moving even after
    // switching tools. verb() keeps the HUD Click row in sync with hold-to-throw.
    const petSeat = player.mode === "scooter" && !remotes.hasPassenger(net.selfId)
      ? (player.meshes.scooter.userData.petSeat as THREE.Object3D | undefined) ?? null
      : null;
    if (!worldArrival.active) fetchBall?.update(frameDt, elapsed, player.position, petSeat);
    if (toolCycle.tool === "ball" && fetchBall) hud.setToolVerb(fetchBall.verb());
    gardenDisplacer.x = player.renderPosition.x;
    gardenDisplacer.z = player.renderPosition.z;
    updateVegetationEnvironment(frameDt, foliageOn ? gardenDisplacers : undefined);
    oceanKite.update(frameDt, elapsed, revealed);
    buskers.update(frameDt, camera, windGustValue(), sky.sunElevation);
    buskerTalk.update(player.renderPosition);
    if (!worldArrival.active) {
      if (sites.perfAllowed("sutro-baths")) {
        sutroBaths?.update(frameDt, elapsed, player.renderPosition, camera, windGustValue());
      }
      teaGarden.update(
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
    // keeps the shared context awake for the magic-echo tail + applies live echo
    // tuning; balls keep flying tool-agnostically, so run it every live frame
    ballImpactAudio.update(frameDt);
    if (embodiments.currentAnimal) forest?.setRiddenSpeed(player.speed);
    if (!worldArrival.active) islands.update(elapsed, camera.position);
    // Baked destination tiles already provide the fixed-quality arrival view.
    // CityGen hydrates its richer cells only after the local visual/collision
    // transaction finishes, so it never competes with teleport-critical work.
    if (!worldArrival.active) citygenRing.current?.update(player.position, frameDt);
    if (!worldArrival.active && !highUp) hunt.update(frameDt, elapsed, player.position);
    if (!worldArrival.active) golf?.update(frameDt, elapsed, { player, input, hud, chase, camera });
    if (!worldArrival.active && sites.perfAllowed("palace")) {
      palaceReverie?.update(frameDt, elapsed, player.position, hud);
      const welcome = palaceReverie?.takeWelcome();
      if (welcome) hud.message(welcome, 6.2);
    }
    // Archery: site-gated, one boolean early-return when asleep with nothing live
    if (!worldArrival.active && sites.perfAllowed("archery")) {
      archery?.update(frameDt, elapsed, { player, input, hud, chase, camera });
    }
    // Biscuit the RL pup: site-gated, one boolean early-return when asleep
    if (!worldArrival.active && sites.perfAllowed("pup")) {
      pup?.update(frameDt, camera);
    }
    // Afterlight: proximity collectibles, return flights, quest clock and the
    // completed sky performance; site-gated to a single asleep early return.
    if (!worldArrival.active && sites.perfAllowed("afterlight")) {
      afterlight?.update(frameDt, elapsed, player, hud);
    }
    // Goldman clubhouse NPCs: one-hypot early return when far — safe every frame
    if (!worldArrival.active && sites.perfAllowed("goldman")) {
      goldenGateTennis?.update(frameDt, elapsed, player.position);
    }
    // Mission Dolores: dynamic code gate first, then shell/art proximity gates.
    if (!worldArrival.active) ensureMissionDolores(player.position);
    if (!worldArrival.active) missionDolores?.update(frameDt, elapsed, player.position, player.mode, hud);
    const museumFloorHandoff = worldArrival.active
      ? null
      : missionDolores?.takeFloorHandoffHeight(player.position, player.mode);
    if (museumFloorHandoff != null) player.recoverOntoWalkSurface(museumFloorHandoff);
    // Sutro Baths buries its footprint and floats the deck above the old ground.
    // Same handoff: lift a capsule stranded beneath the freshly built deck.
    const sutroFloorHandoff = worldArrival.active
      ? null
      : sutroBaths?.takeFloorHandoffHeight(player.position, player.mode);
    if (sutroFloorHandoff != null) player.recoverOntoWalkSurface(sutroFloorHandoff);

    // Prime the surf runtime while the player is still walking up to the
    // shack: waves + rider pipelines compile during the approach, so the E
    // press starts the ride without a single pipeline stall. This is the
    // activity's proximity gate — nothing surf-related loads elsewhere.
    if (
      player.mode === "walk" &&
      surfShack &&
      !oceanBeachWaves &&
      !surfRuntimeLoading &&
      surfEntryPreparations === 0
    ) {
      const surfPrimeDx = player.position.x - surfShack.pose.x;
      const surfPrimeDz = player.position.z - surfShack.pose.z;
      if (surfPrimeDx * surfPrimeDx + surfPrimeDz * surfPrimeDz < 90 * 90) void prepareSurfEntry();
    }

    // "hop in" nudge when standing near a ride (friend → wildlife → parked mount)
    if (!worldArrival.active && player.mode === "walk" && embodiments.passengerOf === null) {
      const nearGhostShip = ghostShip?.nearbyBoarding(player.position) ?? false;
      const drv = nearGhostShip ? null : remotes.nearestDriver(player.position, 5.5);
      if (drv?.mode === "bird") setRemoteBirdAssetsActive(true);
      const nearAnimal = drv ? null : forest?.nearest(player.position, 5);
      const nearMount =
        !drv && !nearAnimal
          ? abandonedMounts.nearest(player.position.x, player.position.z, 5.5)
          : null;
      const surfBoardPrompt =
        !drv && !nearAnimal && !nearMount
          ? surfShack?.nearbyPrompt(player.position.x, player.position.z, input.device) ?? null
          : null;
      const reveriePrompt =
        !drv && !nearAnimal && !nearMount && !surfBoardPrompt
          ? palaceReverie?.nearbyPrompt(player.position.x, player.position.z) ?? null
          : null;
      if ((nearGhostShip || drv || nearAnimal || nearMount || surfBoardPrompt || reveriePrompt) && !ridePromptShown) {
        const rideCopy = nearGhostShip
          ? formatInteractPrompt("board the wandering ghost ship", input.device)
          : drv
          ? formatInteractPrompt(`ride with ${drv.name}`, input.device)
          : nearAnimal
            ? formatInteractPrompt(`ride the ${nearAnimal.label}`, input.device)
            : nearMount
              ? formatInteractPrompt(ABANDONED_MOUNT_PROMPT[nearMount.mode], input.device)
              : surfBoardPrompt
                ? surfBoardPrompt
                : localizeInteractText(reveriePrompt as string, input.device);
        hud.message(rideCopy, 1.8);
        ridePromptShown = true;
      }
      if (!nearGhostShip && !drv && !nearAnimal && !nearMount && !surfBoardPrompt && !reveriePrompt) ridePromptShown = false;
      // "open the door" nudge — same one-shot pattern; the ride prompt wins
      // when both are in range. nearestDoor is alloc-light but not free, so
      // it runs every 6th frame (prompt latency ~0.1 s) and only on foot.
      if (--doorScanCountdown <= 0) {
        doorScanCountdown = 6;
        doorScanHit = citygenRing.current?.nearestDoor(player.position) ?? null;
      }
      const door = doorScanHit;
      const nearClosedDoor = !!door && !door.open && door.dist < 3.2;
      if (nearClosedDoor && !nearGhostShip && !drv && !nearAnimal && !nearMount && !doorPromptShown) {
        hud.message(formatInteractPrompt("open the door", input.device), 1.8);
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
      player.indoor = chase.indoor =
        (citygenRing.current?.isPlayerInside() ?? false) ||
        (missionDolores?.isPlayerInside(player.position) ?? false) ||
        (sutroBaths?.isPlayerInside(player.position) ?? false); // blend into the indoor eye rig
      chase.update(frameDt, player, input);
    }
    // World-anchored dialogue must project after the chase/orbit/cinematic has
    // committed this frame's final camera pose; projecting during simulation
    // left Hiro's card one camera frame behind and visibly jittering.
    teaGarden.project(camera);
    buskerTalk.project(camera);
    beachPianist?.project(camera);
    sky.update(elapsed, camera.position, player.renderPosition);
    // Surf contact/camera use Player's fixed-step simulation clock. Feed that
    // exact clock to the displaced ocean and lazy face/roof too; using render
    // elapsed here let the visible crest and barrel envelope drift away after
    // loading, pause, or deterministic headless stepping.
    const surfaceTime = player.mode === "surf" ? player.time : elapsed;
    water.echoes.beginFrame(surfaceTime, camera);
    const activeEchoMesh = player.meshes[player.mode];
    const birdReady = player.mode !== "bird" || Boolean(activeEchoMesh.userData.rig);
    if (activeEchoMesh.visible && birdReady) {
      emitEmbodimentWaterEcho(water.echoes, player);
    }
    water.echoes.endFrame();
    // The base sheet yields to the high-res surf overlay whenever that overlay
    // exists — it now persists for the beach walk-up too, not just mode==="surf",
    // and leaving both drawn doubles the same transparent wall.
    water.update(surfaceTime, camera.position, player.renderPosition, oceanBeachWaves !== null);
    // The roof materializes with the CAMERA's barrel blend, not the gameplay
    // tube state: state-driven visibility drew the roof while the camera was
    // still outside, where its pale lip seen edge-on through fog read as a
    // white disc floating over the crest.
    const surfTubeVisibility =
      player.mode === "surf" ? chase.surfCameraDiagnostics()?.tubeBlend ?? 0 : 0;
    oceanBeachWaves?.update(surfaceTime, player.renderPosition, surfTubeVisibility);
    // Safety net for restored/direct surf transitions. Entry preparation keeps
    // its newly constructed mesh alive until the mode switch commits; otherwise
    // the activity visual is disposed on the first non-surf frame.
    if (!oceanBeachWaves && player.mode === "surf") {
      void ensureSurfRuntime();
    } else if (oceanBeachWaves && !surfBreakStillLocal()) {
      releaseSurfVisual();
    }
    underwater.update(camera, elapsed);
    fx.update(frameDt);
    bubbles.update(frameDt, elapsed);
    wake.update(frameDt, surfaceTime, player);
    boardWake.update(frameDt, surfaceTime, player);
    skidMarks.update(frameDt, elapsed, player);
    birdTrails.update(elapsed, player);
    splashes.update(frameDt, surfaceTime, player);
    surfExperience?.update(frameDt, player.mode, player.surfTelemetry);
    if (player.mode === "surf" && player.surfTelemetry.splashSerial !== surfSplashSerial) {
      surfSplashSerial = player.surfTelemetry.splashSerial;
      // The generic entry plume is built from camera-facing mist sprites. At
      // surf-camera distance those become large white puffs that obscure both
      // rider and face. Surf already has analytic lip foam and twin rail wakes,
      // so answer launch/landing impacts with low, wave-seated rings instead.
      wake.burst(
        player.renderPosition.x,
        player.renderPosition.z,
        surfaceTime,
        3.2 + player.surfTelemetry.splashEnergy * 3.8,
        2
      );
    }
    updateSurfPresentation(frameDt);
    const waveEnergy = oceanWaveEnergyAt(map, player.position.x, player.position.z, elapsed);
    // Keep the hall's wind/steam ambience, but remove its artificial
    // noise-heavy surf bed. Generic shoreline wash returns outside the site.
    const sutroWaveMix = THREE.MathUtils.smoothstep(
      distanceToSutroBaths(player.position.x, player.position.z),
      80,
      190
    );
    waveEnergy.level *= sutroWaveMix;
    waveEnergy.breaking *= sutroWaveMix;
    waveAudio.update(frameDt, waveEnergy);
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
    // Boards live on the shack rack until grabbed — no under-arm carry on the sand.
    player.setCarryingBoard(false);
    vehicleAudio.update(frameDt, {
      mode: player.mode,
      speed: player.speed,
      vspeed: player.velocity.y,
      boost: input.down("ShiftLeft"),
      grounded: player.mode !== "board" || player.boardGrounded,
      surfFace: player.mode === "surf" ? player.surfTelemetry.face : 0,
      surfFlow: player.mode === "surf" && player.surfTelemetry.flowActive ? 1 : 0,
      surfMotionRate: player.mode === "surf" ? player.surfTelemetry.riderMotionRate : 1,
      driveVoice: player.driveSpec.voice ?? "engine",
      driveSlide: player.driveSlideFeedback.intensity,
      // Lamp-field whoosh only exists on the hoverboard voice — skip the
      // all-lamps scan for every other mode (it already early-outs by day).
      lampLight: player.mode === "board" ? computeLampField() : 0
    });
    swimAudio.update(frameDt, {
      swimming: player.swimming,
      speed: Math.hypot(player.velocity.x, player.velocity.z),
      vspeed: player.velocity.y
    });
    updatePlayerFoley(frameDt, true);
    // Keep the sim ticking for remotes / drone salvo / future area shows — no
    // player hold-to-fire binding (keyboard B / pad face B retired).
    fireworks.update(frameDt, {
      hold: false,
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
    voice.update(); // gains, speaking indicator, roster scan
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
    // and rides the free mouse ray while free-cursor mode is on (L). Runs after the entity
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
        if (hit) {
          cursorPos.copy(hit.point);
          overlayRayHit = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        } else {
          cursorPos.copy(rayOrigin).addScaledVector(aim, 22);
          overlayRayHit = null;
        }
        worldCursor.update(frameDt, camera, cursorPos, 0, true);
      } else {
        overlayRayHit = null;
        worldCursor.update(frameDt, camera, cursorPos, 0, false);
      }
    }

    hud.update(frameDt);
    tutorial.update(frameDt);
    debugPanel.refresh();

    sessionPersistence.update(frameDt);

    syncDebugOverlays(); // "/" → overlays (no-op unless toggled)
    // grey cards ride the FINAL camera pose (chase or cine hook both settled above)
    calibrationChart.sync(camera, Boolean(RENDER_TUNING.values.greyCards));
  };

  // Post-scheduler drain: the deferred-work budget (scheduler.run) lives in
  // gameLoop.ts, bracketed with the "sched" tracer phase; this hook runs after
  // it — initial-arrival reveal release + the settle tick.
  const postSchedule = (_frameDt: number) => {
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
  };

  // Compose the per-frame order in app/gameLoop.ts. It owns frame timing (the
  // forcedDt/manual-tick contract + the clamped THREE.Timer delta), the reduced-
  // tick dispatch, the tracer phase brackets ("physics"/"world"/"sched"/"render"
  // — names probes depend on), the scheduler pacing, and the render call. The
  // trivial branch hooks are inlined here; the substantial ones are the named
  // closures above. See docs/MAIN_DECOMPOSITION.md for why the body stays here.
  const tick = createGameLoop({
    timer,
    scheduler,
    isRevealed: () => revealed,
    hooks: {
      onFrameStart: () => buskers.flushHotSwap(),
      beginFrame,
      readingFrozen: () =>
        (btsReading && document.body.classList.contains("started")) || museumBookOpen,
      endInputOnly: () => input.endFrame(),
      globalKeysAndGhost,
      minimapOpen: () => minimap.expanded,
      runMinimapFrame,
      preSimulate,
      liveInput,
      simulate,
      updateWorld,
      postSchedule,
      endFrameInput: () => {
        minigameSession.endFrame(captureMinigameOrigin());
        input.endFrame();
      },
      render: renderFrame,
      afterRender: () => diagnostics.updateStats()
    }
  });
  const adaptiveRes = createAdaptiveResolution(renderer);
  const frameDriver = startFrameDriver({
    renderer,
    camera,
    app,
    tick,
    tracer,
    isRevealed: () => revealed,
    adaptiveRes
  });
  // Deterministic capture stops the wall-clock loop so tools can drive tick(dt).
  // Discard any fractional wall-clock remainder on entry; otherwise identical
  // fixed-step reels can interpolate from a different boot-time accumulator.
  (window as never as { __sfManual: (on: boolean) => void }).__sfManual = (on) => {
    if (on) accumulator = 0;
    frameDriver.setManual(on);
  };

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

  // The adaptive-resolution governor doubles as the probe-visible dynRes hook.
  const dynRes = adaptiveRes;

  const exposeDebugHooks = () => {
    Object.assign(window as never, {
      // renderIdle: probes MUST wait for this before capture phases — while the
      // deferred render warmup runs, tick() early-returns without rendering, so
      // screenshots would capture a stale boot-pose frame no matter what the
      // camera was set to.
      __sf: { scene, camera, player, tiles, authoredRegions, physics, renderer, pipeline, dynRes, tracer, scheduler, POSTFX_TUNING, WORLD_TUNING, FLOWER_TUNING, RENDER_TUNING, CAR_LANDING_TUNING, chase, map, input, hud, fx, fireworks, graffiti, bubbles, setTool, setColor, sky, farOcclusion, debugPanel, CONFIG, THREE, tick, creatures, forest, garden, wildlands, buenaVistaTrees, goldenGateTennis, japaneseTeaGarden: teaGarden.current(), pickleball: pickleballController?.game ?? null, pickleballAmbient: pickleballController?.ambient ?? null, pickleballAudio: pickleballController?.audio ?? null, pickleballUI: pickleballController?.ui ?? null, pickleballController, coronaHeights, missionDolores, sutroBaths, splashes, vehicleAudio, swimAudio, waveAudio, gameplaySfxBus, audioEngine, playerFoleyAudio, jumpLandingAudio, modeTransitionAudio, doorAudio, getPaintAudio: () => paintAudio, getBubbleAudio: () => bubbleAudio, nature, dogParkAudio, ballImpactAudio, net, remotes, voice, minimap, playerLocator, boardWake, abandonedMounts, ghostShip, ghostShipBeacon, ensureGhostShipDetail, embodiments, switchMode, paintballs, paintSkins, hunt, satchel, buildShareUrl, tutorial, fetchBall, goldenGateLights, teleportToTarget, trafficLights, streetLamps, citygen, citygenRing, worldCursor, worldQueries, buildingRayRefiner, underwater, water, oceanBeachWaves, surfExperience, ensureSurfRuntime, roadMarkings, debugOverlays, calibrationChart, FOLIAGE_TUNING, CITYGEN_TUNING, PROCEDURAL_LAMP_TUNING, setFoliageVisible, buskers, buskerTalk, boardSelector: board, getBoardSelector: () => board.get(), ensureCarCustomizer, getCarSelector: () => car.get(), getCarConfig: () => ({ ...carConfig }), ensureSurfboardCustomizer, getSurfboardConfig: () => ({ ...surfboardConfig }), siteGate, palaceReverie, landsEnd, beachPianist, afterlight, optionalWorldSites: sites.list, ensureOptionalWorldSite: sites.ensure, siteFoliage,
        TSL,
        renderIdle: () => modulesReady && sites.streamingIdle() }
    });
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) {
      Object.assign(hooks, {
        worldArrival,
        lazyRegionTimings,
        teaGardenBuildingSwapState: teaGarden.buildingSwapState,
        oceanBeachKite: oceanKite.current(),
        ensureOceanBeachKite: oceanKite.ensure,
        oceanKiteSite: oceanKite.site
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
      get waveOrgan() { return waveOrgan ?? undefined; },
      get beachPianist() { return beachPianist ?? undefined; },
      fireworks,
      worldQueries,
      setTool: (t: string) => setTool(t as ToolName),
      setBoardConfig: (config: typeof boardConfig) => {
        applyBoardConfig(config);
        board.get()?.setConfig(config);
      },
      setCine: (fn: ((dt: number) => void) | null) => {
        cineHook = fn;
      },
      setExposure: (v: number) => {
        renderer.toneMappingExposure = v;
      },
      setPostFx: (values: Record<string, number | boolean>) => {
        // sceneSamples is a render-target knob, not a POSTFX uniform: route it to
        // the pipeline's multisampling toggle. 0 = single-sampled (a resolvable
        // depth texture; matches real-time play), >0 = MSAA for cleaner edges.
        if ("sceneSamples" in values) {
          pipeline.setCinematicMultisampling(Number(values.sceneSamples) > 0);
          delete values.sceneSamples;
        }
        Object.assign(POSTFX_TUNING.values, values);
        pipeline.applyPostFx(); // select the retained toggle variant + push uniforms
      }
    };
    const ensureDemoSite = async (name: string): Promise<void> => {
      const site: OptionalSiteId | null =
        name === "afterlight" ? "afterlight" :
        name === "palace" || name === "palace-reverie" || name === "phoenix-palace-flyby" ? "palace" :
        name === "landsend" ? "lands-end" :
        null;
      if (site) await sites.ensure(site);
    };
    const runDevDemo = async (name: string): Promise<void> => {
      await ensureDemoSite(name);
      // Cinematic pages trade throughput for cleaner geometry edges. This is
      // deliberately outside persisted render settings and never runs during
      // ordinary real-time play.
      pipeline.setCinematicMultisampling(true);
      await pipeline.warmup("boot");
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
