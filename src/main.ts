// Soft-HMR guard must register before any other import.meta.hot listeners.
import { suppressesFullReload } from "./app/hmr/suppressFullReload";
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import CameraControls from "camera-controls";
import { CAMERA_TUNING, CITYGEN_TUNING, CONFIG, FLOWER_TUNING, FOLIAGE_TUNING, INPUT_TUNING, LIGHT_SCALE, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING } from "./config";
import { loadPlayerState, resetAllTweaks, saveTweak } from "./core/persist";
import { Input, formatInteractPrompt, localizeInteractText } from "./core/input";
import { tracer } from "./core/hitchTracer";
import { bootMarkStart, bootMark, bootMarkSummary, persistBootHistory } from "./core/bootMarks";
import { createFrameScheduler } from "./core/frameBudget";
import { WorldMap, waterHeight } from "./world/heightmap";
import { OCEAN_BEACH_SURF, nearOceanBeachShore } from "./world/oceanBeachWaves";
import {
  createSurfShack,
  oceanBeachSurfShackPose,
  type SurfShack
} from "./gameplay/surfing/shack";
import { Sky, SKY_TUNING } from "./world/sky";
import { Water } from "./world/water";
import { emitEmbodimentWaterEcho } from "./world/waterEchoes";
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
import { AuthoredRegionStreamer } from "./world/authoredRegions";
import { warmStaticRegion } from "./render/warmStaticRegion";
import type { CoronaHeightsPark } from "./world/coronaHeights";
import { prepareCoronaHeightsGround } from "./world/coronaHeights/ground";
import { CORONA_HEIGHTS_SUMMIT } from "./world/coronaHeights/meta";
import type { MissionDoloresMuseum } from "./world/missionDolores";
import { MD_CENTER as MISSION_DOLORES_CENTER } from "./world/missionDolores/layout";
import { findOpenSpawn } from "./world/spawn";
import {
  distanceToSutroBaths,
  pickLandmarkSpawn,
  resolveSpawnPoint,
  SAFE_SPAWN_FALLBACK,
  SPAWN_POINTS,
  SUTRO_BATHS_ARRIVAL,
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
  PAINTBALL_SPEED,
  type PaintWaterImpact,
  type PaintWaterSegment
} from "./fx/paintball";
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
import { GameplaySfxBus } from "./audio/gameplaySfxBus";
import { PlayerFoleyAudio } from "./fx/playerFoleyAudio";
import { ModeTransitionAudio } from "./fx/modeTransitionAudio";
import { JumpLandingAudio } from "./fx/jumpLandingAudio";
import { DoorAudio } from "./fx/doorAudio";
import { createNatureSoundscape, DogParkAudio, BallImpactAudio, BALL_IMPACT_AUDIO_TUNING } from "./audio";
import { WaveAudio, oceanWaveEnergyAt } from "./audio/waveAudio";
import { AbandonedMounts, ABANDONED_MOUNT_PROMPT } from "./gameplay/abandonedMounts";
import type { Creatures } from "./gameplay/creatures";
import type { Forest, AnimalKind } from "./gameplay/forest";
import {
  updateVegetationEnvironment,
  windGustValue,
  type GroundDisplacer
} from "./world/vegetation/runtime";
import { BOTANICAL_GARDEN_BOUNDS } from "./world/garden/layout";
import type { CityGenRing } from "./world/citygen";
import { Islands } from "./gameplay/islands";
import { Hunt } from "./gameplay/hunt";
import { FetchBall } from "./gameplay/fetchBall";
import { createSiteGate } from "./gameplay/siteGate";
import type { ArcheryGame } from "./gameplay/archery";
import { ARCHERY_CENTER } from "./gameplay/archery/meta";
import type { PupPen } from "./gameplay/pup";
import { PUP_CENTER } from "./gameplay/pup/meta";
import type { PalaceReverieGame } from "./gameplay/palaceReverie";
import { REVERIE_CENTER } from "./gameplay/palaceReverie/meta";
import type { LandsEndRegion } from "./world/landsEnd";
import { LANDS_END_CENTER } from "./world/landsEnd/meta";
import type { AfterlightExperience } from "./gameplay/afterlight";
import {
  AFTERLIGHT_ARRIVAL,
  isAfterlightOpenAtHour
} from "./gameplay/afterlight/meta";
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
  setLocalCarConfig,
  type CarConfig
} from "./vehicles/car";
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
import { isInGameScreenshotBusy, takeInGameScreenshot } from "./app/inGameScreenshot";
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
  const initialArrivalPromise = (async () => {
    // Code spawns win over baked metadata; resume/invite links bypass the default
    // district entirely so a shared link never loads one neighborhood and then
    // performs a second cross-city relocation.
    const arrivalQuery = new URLSearchParams(location.search);
    const requestedSpawn = arrivalQuery.get("spawn")?.trim();
    const autoStartHiroTour = arrivalQuery.get("tour") === "hiro";
    const invite = parseInviteIntent(location.search);
    const reloadCandidate = import.meta.env.DEV ? consumeDevReloadSnapshot() : null;
    const devReload = invite || beganAsReadingVisit || arrivalQuery.has("demo")
      ? null
      : reloadCandidate;
    const resumed = invite || requestedSpawn ? null : (devReload?.player ?? loadPlayerState());
    const requestedCodeSpawn = requestedSpawn ? resolveSpawnPoint(requestedSpawn) : undefined;
    const requestedBakedSpawn = requestedSpawn ? map.meta.spawns[requestedSpawn] : undefined;
    // Default arrival — no ?spawn=, no invite, no resumable position — drops a
    // fresh visitor at a random landmark from LANDMARK_POOL. A resumed player is
    // placed at their saved spot instead (resumeStart wins downstream), and a
    // start location the user has pinned (START.spawn ≠ the default) is honored.
    const spawnKey =
      requestedCodeSpawn || requestedBakedSpawn
        ? requestedSpawn!
        : resumed || invite
          ? START.spawn
          : START.spawn === START_DEFAULTS.spawn
            ? pickLandmarkSpawn()
            : START.spawn;
    const spawnPoint = requestedCodeSpawn ?? (
      requestedBakedSpawn
        ? undefined
        : resolveSpawnPoint(spawnKey) ?? resolveSpawnPoint(START_DEFAULTS.spawn)
    );
    if (spawnPoint?.key === "oceanBeach") {
      const apron = oceanBeachSurfShackPose(map);
      spawnPoint.x = apron.x;
      spawnPoint.z = apron.z;
      spawnPoint.heading = apron.heading;
    }
    const registeredStart =
      spawnPoint ??
      requestedBakedSpawn ??
      map.meta.spawns[spawnKey] ??
      map.meta.spawns[START_DEFAULTS.spawn];
    const authoredStart = invite || resumed ? null : authoredRegions.arrivalForKey(spawnKey);
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
    const startAt = inviteStart ?? resumeStart ?? authoredStart ?? registeredStart;
    const scatterA = Math.random() * Math.PI * 2;
    const scatterR = requestedSpawn || inviteStart || resumeStart || authoredStart
      ? 0
      : 0.8 + Math.random() * 1.6;
    const openSpawnOrFallback = async () => {
      const scattered = {
        ...startAt,
        x: startAt.x + Math.cos(scatterA) * scatterR,
        z: startAt.z + Math.sin(scatterA) * scatterR
      };
      try {
        return await findOpenSpawn(
          map,
          tiles.manifest,
          scattered,
          requestedSpawn ? 1.5 : 12,
          requestedSpawn ? 36 : 200
        );
      } catch (err) {
        // A random landmark with no movement-safe ground nearby must not crash
        // boot — retire to a guaranteed-open spawn instead of rejecting.
        console.warn(`[spawn] no open ground near "${spawnKey}"; using fallback`, err);
        const fallback = resolveSpawnPoint(SAFE_SPAWN_FALLBACK) ?? startAt;
        return await findOpenSpawn(map, tiles.manifest, fallback, 12, 400);
      }
    };
    const spawn = inviteStart ?? resumeStart ?? authoredStart ?? await openSpawnOrFallback();

    // Arrival breadcrumb: which pool landmark (or resume/invite) placed the
    // player, and where they actually landed after the open-ground search.
    const arrivalOrigin = resumed ? "resume" : invite ? "invite" : spawnKey;
    console.info(`[spawn] arrival "${arrivalOrigin}" → ${Math.round(spawn.x)}, ${Math.round(spawn.z)}`);

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

  // Space / pad-X toys — ↑/↓ pick the toolbar row, ←/→ cycle within it
  const graffiti = new Graffiti(scene);
  const paintballs = new Paintballs(scene);
  const paintSkins = new PaintSkins();
  let teaGardenPaintWater: ((impact: PaintWaterImpact) => boolean) | null = null;
  let teaGardenPaintWaterSegment: ((segment: Readonly<PaintWaterSegment>) => boolean) | null = null;
  paintballs.onWaterSegment = (segment) => teaGardenPaintWaterSegment?.(segment) ?? false;
  paintballs.onWater = (impact) => {
    if (teaGardenPaintWater?.(impact)) return;
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
  let tool: ToolName = "ball";
  let fetchBall: FetchBall | null = null; // built after coronaHeights; setTool runs once before it exists
  const setTool = (t: ToolName) => {
    tool = t;
    if (t === "spray") void ensurePaintAudio();
    else if (t === "bubbles") void ensureBubbleAudio();
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
      .then(({ OceanBeachWaves, SurfExperience }) => {
        // A direct transition may have been canceled while the chunk was in
        // flight. Do not resurrect the activity after its owner has left.
        if (!prepareEntry && player.mode !== "surf" && surfEntryPreparations === 0) return;
        oceanBeachWaves ??= new OceanBeachWaves(scene);
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
  const prepareSurfEntry = async () => {
    surfEntryPreparations++;
    try {
      await Promise.all([chase.ensureSurfCamera(), ensureSurfRuntime(true)]);
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
    } else {
      // The high-resolution break belongs exclusively to the active surf session.
      releaseSurfVisual();
    }
    setRemoteSurfboardAssetsActive(mode === "surf");
    setRemoteScooterAssetsActive(mode === "scooter");
    setRemoteCarAssetsActive(mode === "drive");
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
  let sutroBaths: import("./world/sutroBaths").SutroBaths | null = null;
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
    sutroBaths?.setFoliageVisible(visible);
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
  let pup: PupPen | null = null;
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
    // A bounce on the tea-garden pond bottom is submerged — its plonk is voiced
    // by the water feature, so skip the dry thud there.
    onGroundImpact: (x, y, z, speed) => {
      if (japaneseTeaGarden?.containsWater(x, z)) return;
      ballImpactAudio.ground(x, y, z, speed);
    }
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
    savedSurfboard ?? undefined,
    savedCar ?? undefined
  );
  const remotes = new RemotePlayers(scene);
  remotes.localPlayerPosition = () => player.renderPosition;
  setRemoteSurfboardAssetsActive = (active) => remotes.setSurfboardAssetsEnabled(active);
  setRemoteScooterAssetsActive = (active) => remotes.setScooterAssetsEnabled(active);
  setRemoteCarAssetsActive = (active) => remotes.setCarAssetsEnabled(active);
  // Startup/invite can enter surf before networking and its remote-art gate exist.
  setRemoteSurfboardAssetsActive(player.mode === "surf");
  setRemoteScooterAssetsActive(player.mode === "scooter");
  setRemoteCarAssetsActive(player.mode === "drive");
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
    (config) => player.previewScooterConfig(config),
    () => {
      if (player.mode !== "scooter" && !player.riding) switchModeFromToolbar("scooter");
    }
  );
  let carSelector: {
    setConfig(config: CarConfig): void;
    setOpen(open: boolean): void;
    setVisible(visible: boolean): void;
  } | null = null;
  let carSelectorLoading: Promise<void> | null = null;
  let openCarSelectorAfterLoad = false;
  const carLauncher = document.createElement("div");
  carLauncher.className = "avatar-ui car-ui car-launcher-ui";
  const carLauncherButton = document.createElement("button");
  carLauncherButton.type = "button";
  carLauncherButton.className = "avatar-toggle car-toggle";
  carLauncherButton.title = "Open car atelier";
  carLauncherButton.setAttribute("aria-label", "Open car atelier");
  carLauncherButton.innerHTML = '<img class="customizer-icon" src="/ui/customizer-icons/car.webp" alt="" draggable="false">';
  carLauncher.appendChild(carLauncherButton);
  document.getElementById("hud")!.appendChild(carLauncher);
  const ensureCarCustomizer = (open = false) => {
    // Drive-mode only — refuse open/load intent while another locomotion owns the slot.
    if (open && player.mode !== "drive") return;
    if (open) openCarSelectorAfterLoad = true;
    if (carSelector) {
      if (open) carSelector.setOpen(true);
      return;
    }
    if (carSelectorLoading) return;
    carSelectorLoading = import("./ui/carSelector")
      .then(({ CarSelector }) => {
        carSelector = new CarSelector(
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
        carLauncher.hidden = true;
        carSelector.setVisible(player.mode === "drive");
        if (openCarSelectorAfterLoad && player.mode === "drive") carSelector.setOpen(true);
        openCarSelectorAfterLoad = false;
      })
      .catch((error) => console.warn("[car] atelier failed to load", error))
      .finally(() => {
        carSelectorLoading = null;
      });
  };
  carLauncherButton.addEventListener("click", () => {
    input.releaseLock();
    ensureCarCustomizer(true);
  });
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
  surfboardLauncherButton.innerHTML = '<img class="customizer-icon" src="/ui/customizer-icons/surfboard.webp" alt="" draggable="false">';
  surfboardLauncher.appendChild(surfboardLauncherButton);
  document.getElementById("hud")!.appendChild(surfboardLauncher);
  surfboardLauncherButton.addEventListener("click", () => {
    input.releaseLock();
    ensureSurfboardCustomizer(true);
  });
  ensureSurfboardCustomizer = (open = false) => {
    // Surf-mode only — shaping room must never open from Drive/Walk/etc.
    if (open && player.mode !== "surf") return;
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
  // One top-right customizer slot: show only the active mode's atelier (or none).
  syncCustomizerForMode = (mode) => {
    const showAvatar = mode === "walk";
    const showBoard = mode === "board";
    const showScooter = mode === "scooter";
    const showCar = mode === "drive";
    const showSurf = mode === "surf";
    if (!showCar) openCarSelectorAfterLoad = false;
    if (!showSurf) openSurfboardSelectorAfterLoad = false;
    avatarSelector.setVisible(showAvatar);
    boardSelector.setVisible(showBoard);
    scooterSelector.setVisible(showScooter);
    if (carSelector) {
      carSelector.setVisible(showCar);
      carLauncher.hidden = true;
    } else {
      carLauncher.hidden = !showCar;
    }
    if (surfboardSelector) {
      surfboardSelector.setVisible(showSurf);
      surfboardLauncher.hidden = true;
    } else {
      surfboardLauncher.hidden = !showSurf;
    }
  };
  syncCustomizerForMode(player.mode);
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
    if (carCustomized) {
      net.setCar(carConfig);
    } else {
      carConfig = carFromSeed(net.selfId);
      setLocalCarConfig(carConfig);
      player.setCarConfig(carConfig);
      carSelector?.setConfig(carConfig);
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
  // golf: friends' swings/balls/scores replay here (owner-simulated snapshots)
  net.onGolf = (id, m) => golf?.handleNet(id, m, hud, net.roster.get(id)?.name ?? "Player");
  input.onLockChange = (locked) => {
    if (!locked && !inOrbit() && !input.freeCursor && !chat.focused) {
      hud.message("Click the scene to capture · Esc releases · L toggles free cursor", 2.8);
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
  minimap.addLandmark(PUP_CENTER.x, PUP_CENTER.z, "Puppy Nursery");
  minimap.addLandmark(REVERIE_CENTER.x, REVERIE_CENTER.z, "Palace Reverie");
  // Ocean Beach surf shack. Teleporting arrives on foot at the apron;
  // one E press on a racked board enters the live face already standing and moving.
  {
    const apron = oceanBeachSurfShackPose(map);
    minimap.addLandmark(apron.x, apron.z, "Ocean Beach · Surf");
    ensureSurfShack();
  }
  minimap.addLandmark(LANDS_END_CENTER.x, LANDS_END_CENTER.z, "Lands End · Labyrinth");
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
  const nextPresentationFrame = () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
  /**
   * CityGen's destination cell is part of the nearby world, not optional far
   * scenery. Yield one frame between WebGPU owner preparations, and continue to
   * defer across an active arrival, but never require the player to stop moving.
   * A per-cell generation predicate lets a teleport cancel an old owner before
   * its non-cancellable compileAsync call begins.
   */
  const waitForCityGenRenderWindow = async (isCurrent?: () => boolean): Promise<boolean> => {
    while (worldArrival.active) {
      if (isCurrent && !isCurrent()) return false;
      await nextPresentationFrame();
    }
    if (isCurrent && !isCurrent()) return false;
    await nextPresentationFrame();
    return !isCurrent || isCurrent();
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

  // Escape priority: dismiss an open overlay (stay unlocked). Pointer-lock exit
  // is the browser's job — do not call releaseLock here. Registered after
  // minimap exists so an early Esc can't hit a TDZ binding.
  //
  // Chrome may reserve the *locked* Escape keydown for its native pointer-lock
  // exit, so overlay dismissal also listens on keyup: one Esc both unlocks
  // (browser) and closes the overlay when the keydown was swallowed.
  const dismissEscapeOverlay = (e: KeyboardEvent): boolean => {
    const reader = getBehindTheScenes();
    if (missionDolores?.bookOpen) {
      missionDolores.closeBook();
    } else if (reader?.isOpen) {
      reader.setOpen(false);
    } else if (minimap.expanded) {
      minimap.setExpanded(false);
    } else {
      return false;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    return true;
  };
  window.addEventListener(
    "keydown",
    (e) => {
      if ((e.code !== "Escape" && e.key !== "Escape") || e.repeat) return;
      const t = e.target;
      // Debug search / other fields keep their own Esc behavior.
      if (
        (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) &&
        !chat.focused
      ) {
        return;
      }
      if (dismissEscapeOverlay(e)) return;
      if (chat.focused) {
        skipChatRelock = true;
        chat.blur();
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
    },
    true
  );
  // Keyup mirror: when Chrome swallowed the locked Escape keydown, the keyup is
  // still delivered here (pointer already released by then), so the overlay
  // closes on the same single Escape instead of needing a second press. Chat /
  // field clearing stays keydown-only — a focused field means the pointer is
  // unlocked, so that keydown is never swallowed.
  window.addEventListener(
    "keyup",
    (e) => {
      if (e.code !== "Escape" && e.key !== "Escape") return;
      dismissEscapeOverlay(e);
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
    () => diagnostics.toggleInspector()
  );
  debugPanel.setMode(player.mode);

  // Thrown-ball impact SFX + the fey-realm magic echo are adjustable at runtime.
  debugPanel.registerFeatureTuning({
    id: "ball-impact-audio",
    title: "Ball impact sound · thud / water / magic echo",
    build(folder) {
      BALL_IMPACT_AUDIO_TUNING.bind(folder);
    }
  });

  // Kid-with-a-kite ambient life is an optional, fully procedural chunk. It
  // stands on the sandy NW-headland beach just south of Sutro Baths (roughly
  // between Sutro Baths and the Archery Range), where the player trolley passes.
  // Resolve the waterline X now (cheap) but defer the person/cloth/behavior code
  // until a post-reveal approach so detached WebGPU compilation has runway.
  const KITE_BEACH_Z = 1650;
  let kiteShoreX = -6160;
  for (let x = -6260; x < -6040; x += 2) {
    if (!map.isWater(x, KITE_BEACH_Z)) {
      kiteShoreX = x;
      break;
    }
  }
  const oceanKiteSite = { x: kiteShoreX, z: KITE_BEACH_Z };
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
  minimap.addLandmark(AFTERLIGHT_ARRIVAL.x, AFTERLIGHT_ARRIVAL.z, "Afterlight · 9 PM–5 AM");
  const missionDoloresSpawn = SPAWN_POINTS.missionDolores;
  minimap.addLandmark(missionDoloresSpawn.x, missionDoloresSpawn.z, missionDoloresSpawn.label);
  for (const arrival of authoredRegions.landmarkArrivals()) {
    minimap.addLandmark(arrival.x, arrival.z, arrival.label);
  }

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

  // Tea Garden destination essentials have their own immediate first-approach
  // path. Merely defining this loader requests nothing: the split chunk remains
  // absent at a distant clean boot, but a teleport can start it under the travel
  // cover instead of waiting behind CityGen, fauna, or movement-idle admission.
  let teaGardenModPromise: Promise<typeof import("./world/japaneseTeaGarden")> | null = null;
  let teaGardenEssentialPromise: Promise<void> | null = null;
  let teaGardenOptionalPromise: Promise<void> | null = null;
  let teaGardenBuildingsClaimed = false;

  const teaGardenBuildingSwapState = () => ({
    claimed: teaGardenBuildingsClaimed,
    buildings: TEA_GARDEN_SUPPRESSED_BUILDINGS.map((building) => ({
      key: building.key,
      index: building.index,
      suppressed: tiles.isBuildingSuppressed(building.key, building.index)
    }))
  });

  const publishTeaGardenDebug = () => {
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) Object.assign(hooks, {
      japaneseTeaGarden,
      lazyRegionTimings,
      teaGardenBuildingSwapState
    });
  };
  const claimTeaGardenBuildings = () => {
    if (teaGardenBuildingsClaimed) return;
    for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
      tiles.suppressBuilding(building.key, building.index);
    }
    teaGardenBuildingsClaimed = true;
    markLazyRegion("tea-garden", "baked-swap");
  };
  const restoreTeaGardenBuildings = () => {
    if (!teaGardenBuildingsClaimed) return;
    for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
      tiles.unsuppressBuilding(building.key, building.index);
    }
    teaGardenBuildingsClaimed = false;
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

  const startTeaGardenOptionalPreparation = (
    site: import("./world/japaneseTeaGarden").JapaneseTeaGarden
  ) => {
    if (teaGardenOptionalPromise) return;
    teaGardenOptionalPromise = (async () => {
      markLazyRegion("tea-garden", "optional-trees-wait");
      await site.prepareOptionalFoliage(async (treeGroup) => {
        // Trees are optional enrichment. They alone retain the movement/arrival
        // quiet policy; architecture, Hiro, shrubs and grass are already live.
        await waitForWorldBackgroundWindow();
        markLazyRegion("tea-garden", "optional-tree-compile-start");
        treeGroup.updateMatrixWorld(true);
        await renderer.compileAsync(treeGroup, camera, scene);
        markLazyRegion("tea-garden", "optional-tree-compile-end");
      });
      await site.ready;
      markLazyRegion("tea-garden", "optional-ready");
      if (foliageOn) sky.invalidateStaticShadows("all");
    })().catch((error) => {
      console.warn("[tea-garden] optional foliage preparation failed:", error);
    });
  };

  const ensureTeaGardenEssential = (signal?: AbortSignal): Promise<void> => {
    if (!teaGardenEssentialPromise) {
      const attempt = (async () => {
        markLazyRegion("tea-garden", "requested");
        teaGardenModPromise ??= import("./world/japaneseTeaGarden");
        const teaGardenMod = await teaGardenModPromise;
        markLazyRegion("tea-garden", "chunk-ready");
        await nextPresentationFrame();

        let site: import("./world/japaneseTeaGarden").JapaneseTeaGarden | null = null;
        try {
          site = teaGardenMod.createJapaneseTeaGarden(map, {
            renderer,
            physics,
            nature,
            dialogueParent: document.body,
            ballSource: {
              visitFreeBalls: (visitor) => fetchBall?.visitFreeBalls(visitor)
            },
            onBallWaterImpact: (x, y, z, speed) => ballImpactAudio.water(x, y, z, speed),
            onCarryRake: (rake) => player.setGardenRakeTool(rake),
            onRakeMotion: (motion) => player.setGardenRakeMotion(motion),
            notify: (message, seconds) => hud.message(message, seconds)
          });
          site.deferOptionalFoliage();
          japaneseTeaGarden = site;
          teaGardenPaintWater = (impact) => site?.paintWater(impact) ?? false;
          teaGardenPaintWaterSegment = (segment) => site?.paintWaterSegment(segment) ?? false;
          debugPanel.registerFeatureTuning(site.tuningDescriptor());
          site.setFoliageVisible(foliageOn);
          site.update(0, performance.now() / 1000, player.renderPosition, camera, player.mode);
          markLazyRegion("tea-garden", "constructed");
          publishTeaGardenDebug();

          const awakeBeforeCompile = site.group.visible;
          site.group.visible = true;
          site.group.updateMatrixWorld(true);
          try {
            markLazyRegion("tea-garden", "essential-compile-start");
            await renderer.compileAsync(site.group, camera, scene);
            markLazyRegion("tea-garden", "essential-compile-end");
          } catch (error) {
            // Compilation is a presentation optimization; the live renderer can
            // still compile a valid fallback on the first authored frame.
            console.warn("[tea-garden] essential compile failed:", error);
          } finally {
            site.group.visible = awakeBeforeCompile;
          }

          scene.add(site.group);
          site.update(0, performance.now() / 1000, player.renderPosition, camera, player.mode);
          if (site.group.visible) claimTeaGardenBuildings();
          if (autoStartHiroTour) site.interact(player.renderPosition, player.mode);
          markLazyRegion("tea-garden", "essential-attached");
          startTeaGardenOptionalPreparation(site);
        } catch (error) {
          site?.dispose();
          if (japaneseTeaGarden === site) japaneseTeaGarden = null;
          if (japaneseTeaGarden === null) teaGardenPaintWater = null;
          if (japaneseTeaGarden === null) teaGardenPaintWaterSegment = null;
          restoreTeaGardenBuildings();
          publishTeaGardenDebug();
          throw error;
        }
      })();
      teaGardenEssentialPromise = attempt;
      // A transient chunk/construction failure must not poison the one-shot
      // cache forever. The baked buildings remain live, and a later approach
      // gets a genuine retry instead of awaiting the same rejected promise.
      void attempt.catch(() => {
        if (teaGardenEssentialPromise !== attempt) return;
        teaGardenEssentialPromise = null;
        teaGardenModPromise = null;
      });
    }
    return waitForAbortable(teaGardenEssentialPromise, signal);
  };

  wakeDeferredTeaGarden = () => {
    wakeDeferredTeaGarden = null;
    void ensureTeaGardenEssential().catch((error) =>
      console.warn("[tea-garden] first-approach construction failed:", error)
    );
  };

  prepareDestinationEssentials = async (destination, signal) => {
    const teaDistance = Math.hypot(
      destination.x - JAPANESE_TEA_GARDEN_ENTRANCE.x,
      destination.z - JAPANESE_TEA_GARDEN_ENTRANCE.z
    );
    if (teaDistance < 820) await ensureTeaGardenEssential(signal);

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

  // Authored sites share one first-approach policy: keep only lightweight
  // coordinates at boot, request one site at a time after reveal, and re-check
  // the destination after the arrival-quiet window before evaluating its chunk.
  // The radius is deliberately generic; visual quality and each site's own LOD
  // remain untouched once the exact same authored root is attached.
  type OptionalSiteId =
    | "goldman"
    | "archery"
    | "palace"
    | "afterlight"
    | "corona"
    | "lands-end"
    | "sutro-baths"
    | "pup";
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
    /** A false value prevents automatic import; explicit debug loads still work. */
    available?: () => boolean;
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
      pup,
      palaceReverie,
      afterlight,
      coronaHeights,
      landsEnd,
      sutroBaths
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

  const loadPup = async (): Promise<void> => {
    const { createPupPen } = await import("./gameplay/pup");
    await waitForOptionalSiteStage();
    const pen = createPupPen(map, physics, scene);
    await prepareOptionalRoot("pup", pen.root);
    pup = pen;
    siteGate.register(pen.siteHooks());
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
    experience.setNightOpen(isAfterlightOpenAtHour(sky.timeOfDay));
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

  // Remote bathers rippling the Sutro pools: locatorTargets() gives world x/y/z
  // but no velocity, so difference positions frame-to-frame into a reused
  // scratch array (only touched while the player is near the baths water).
  const sutroRemotePrev = new Map<number, { x: number; z: number; t: number }>();
  const sutroRemoteScratch: { x: number; y: number; z: number; vx: number; vz: number }[] = [];
  const getSutroRemotes = () => {
    sutroRemoteScratch.length = 0;
    const now = performance.now();
    for (const r of remotes.locatorTargets()) {
      const prev = sutroRemotePrev.get(r.id);
      let vx = 0;
      let vz = 0;
      if (prev) {
        const dtS = Math.max((now - prev.t) / 1000, 1e-3);
        vx = (r.x - prev.x) / dtS;
        vz = (r.z - prev.z) / dtS;
      }
      sutroRemotePrev.set(r.id, { x: r.x, z: r.z, t: now });
      sutroRemoteScratch.push({ x: r.x, y: r.y, z: r.z, vx, vz });
    }
    return sutroRemoteScratch;
  };

  const loadSutroBaths = async (): Promise<void> => {
    const { createSutroBaths } = await import("./world/sutroBaths");
    await waitForOptionalSiteStage();
    let candidate: import("./world/sutroBaths").SutroBaths | null = null;
    try {
      candidate = createSutroBaths({
        renderer,
        scene,
        physics,
        authoredRegions,
        ballSource: { visitFreeBalls: (visitor) => fetchBall?.visitFreeBalls(visitor) },
        getRemotes: getSutroRemotes
      });
      // The geographic tile already owns and displays the period hall. Warm only
      // its optional living layer (foliage, bathers and nearby effects) here.
      candidate.setFoliageVisible(true);
      await candidate.ready;
      await prepareOptionalRoot("sutro-baths", candidate.group);

      candidate.setFoliageVisible(foliageOn);
      scene.add(candidate.group);
      sutroBaths = candidate;
      refreshOptionalSiteDebug();

      // Let the feature cross its nested close-water gate only after the hall is
      // warm. The scheduler and render-idle checks below observe that private
      // warmup flag before admitting nearby Lands End or a probe capture.
      candidate.update(
        0,
        performance.now() * 0.001,
        player.renderPosition,
        camera,
        windGustValue()
      );

      debugPanel.registerFeatureTuning(candidate.tuningDescriptor());
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    } catch (error) {
      if (sutroBaths === candidate) sutroBaths = null;
      candidate?.dispose();
      refreshOptionalSiteDebug();
      throw error;
    }
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
    { id: "pup", label: "Puppy Nursery", ...PUP_CENTER, state: "dormant", forced: false, promise: null, load: loadPup },
    { id: "palace", label: "Palace Reverie", ...REVERIE_CENTER, state: "dormant", forced: false, promise: null, load: loadPalace },
    {
      id: "afterlight",
      label: "Afterlight · 21:00–05:00",
      ...AFTERLIGHT_ARRIVAL,
      state: "dormant",
      forced: false,
      promise: null,
      load: loadAfterlight,
      available: () => isAfterlightOpenAtHour(sky.timeOfDay)
    },
    { id: "corona", label: "Corona Heights", ...CORONA_HEIGHTS_SUMMIT, state: "dormant", forced: false, promise: null, load: loadCorona },
    { id: "lands-end", label: "Lands End", ...LANDS_END_CENTER, state: "dormant", forced: false, promise: null, load: loadLandsEnd },
    {
      id: "sutro-baths",
      label: "Sutro Baths · 1896",
      x: SUTRO_BATHS_ARRIVAL.x,
      z: SUTRO_BATHS_ARRIVAL.z,
      state: "dormant",
      forced: false,
      promise: null,
      load: loadSutroBaths
    }
  ];

  // One compact truth panel for the authored-site streaming contract. "ready"
  // means a chunk/resource set is resident after first approach; runtime and
  // scene state answer the more important question of whether it is doing work
  // or drawing right now. The debug panel invokes this only while open (4 Hz).
  const optionalSiteMonitorView: Record<string, string> = { summary: "—" };
  for (const site of optionalWorldSites) optionalSiteMonitorView[site.id] = "dormant";

  // Perf A/B toggles on the streaming monitor. Inspection is side-effect free:
  // opening "/" must never suppress dormant sites or block first approach.
  // Flipping one off explicitly hides + skips that site's work.
  const optionalSitePerfEnabled: Record<OptionalSiteId, boolean> = {
    goldman: true,
    archery: true,
    palace: true,
    afterlight: true,
    corona: true,
    "lands-end": true,
    "sutro-baths": true,
    pup: true
  };
  let optionalSitePerfGating = false;
  const OPTIONAL_SITE_GATE_ID: Partial<Record<OptionalSiteId, string>> = {
    goldman: "pickleball",
    archery: "archery",
    palace: "palace-reverie",
    afterlight: "afterlight",
    pup: "pup"
  };
  const optionalSitePerfAllowed = (id: OptionalSiteId): boolean =>
    !optionalSitePerfGating || optionalSitePerfEnabled[id];

  const applyOptionalSitePerfGate = (site: OptionalWorldSite): void => {
    if (!optionalSitePerfGating) return;
    const on = optionalSitePerfEnabled[site.id];
    const gateId = OPTIONAL_SITE_GATE_ID[site.id];
    if (gateId) siteGate.suppress(gateId, !on);
    switch (site.id) {
      case "goldman":
        if (goldenGateTennis) goldenGateTennis.group.visible = on;
        break;
      case "archery":
        if (!on && archery) archery.root.visible = false;
        break;
      case "pup":
        if (!on && pup) pup.root.visible = false;
        break;
      case "palace":
        if (!on && palaceReverie) palaceReverie.root.visible = false;
        break;
      case "afterlight":
        if (!on && afterlight) afterlight.root.visible = false;
        break;
      case "corona":
        if (!on && coronaHeights) coronaHeights.group.visible = false;
        break;
      case "lands-end":
        if (!on && landsEnd) landsEnd.group.visible = false;
        break;
      case "sutro-baths":
        sutroBaths?.setPerfSuppressed(!on);
        break;
    }
  };

  const applyAllOptionalSitePerfGates = (): void => {
    for (const site of optionalWorldSites) applyOptionalSitePerfGate(site);
  };

  const optionalSiteSceneState = (root: THREE.Object3D | null | undefined): string => {
    if (!root?.parent) return "detached";
    return root.visible ? "visible" : "hidden";
  };

  const optionalSiteRuntimeState = (
    site: OptionalWorldSite
  ): { runtime: "ACTIVE" | "DETAIL" | "STATIC" | "SLEEP"; sceneState: string } => {
    switch (site.id) {
      case "goldman":
        return {
          runtime: siteGate.awake("pickleball") ? "ACTIVE" : "STATIC",
          sceneState: optionalSiteSceneState(goldenGateTennis?.group)
        };
      case "archery":
        return {
          runtime: siteGate.awake("archery") ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(archery?.root)
        };
      case "pup":
        return {
          runtime: siteGate.awake("pup") ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(pup?.root)
        };
      case "palace":
        return {
          runtime: siteGate.awake("palace-reverie") ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(palaceReverie?.root)
        };
      case "afterlight":
        return {
          runtime: siteGate.awake("afterlight") ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(afterlight?.root)
        };
      case "corona":
        return {
          runtime: !coronaHeights?.group.visible
            ? "SLEEP"
            : coronaHeights.activity.visible
              ? "ACTIVE"
              : "DETAIL",
          sceneState: optionalSiteSceneState(coronaHeights?.group)
        };
      case "lands-end":
        return {
          runtime: landsEnd?.group.visible ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(landsEnd?.group)
        };
      case "sutro-baths":
        return {
          runtime: sutroBaths?.debugState().awake ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(sutroBaths?.group)
        };
    }
  };

  const refreshOptionalSiteMonitor = (): void => {
    let ready = 0;
    let working = 0;
    for (const site of optionalWorldSites) {
      const distance = Math.hypot(player.position.x - site.x, player.position.z - site.z);
      const distanceText = `${Math.round(distance)}m`;
      const availability = site.available?.() === false ? " | CLOSED" : "";
      if (site.state !== "ready") {
        optionalSiteMonitorView[site.id] = `${site.state} | — | — | ${distanceText}${availability}`;
        continue;
      }
      ready++;
      const state = optionalSiteRuntimeState(site);
      if (state.runtime === "ACTIVE" || state.runtime === "DETAIL") working++;
      const gated = optionalSitePerfGating && !optionalSitePerfEnabled[site.id] ? " | OFF" : "";
      optionalSiteMonitorView[site.id] =
        `ready | ${state.runtime} | ${state.sceneState} | ${distanceText}${availability}${gated}`;
    }
    optionalSiteMonitorView.summary =
      `${ready}/${optionalWorldSites.length} resident | ${working} working`;
  };

  debugPanel.registerFeatureTuning({
    id: "world-streaming-monitor",
    title: "World streaming · optional sites",
    build(folder) {
      optionalSitePerfGating = true;
      refreshOptionalSiteMonitor();
      applyAllOptionalSitePerfGates();

      const bindings = [
        folder.addBinding(optionalSiteMonitorView, "summary", {
          readonly: true,
          label: "summary"
        }),
        ...optionalWorldSites.flatMap((site) => {
          const toggle = folder.addBinding(optionalSitePerfEnabled, site.id, {
            label: site.label
          });
          toggle.on("change", () => {
            applyOptionalSitePerfGate(site);
            if (optionalSitePerfEnabled[site.id]) {
              void requestOptionalWorldSite(site, true);
            }
            refreshOptionalSiteMonitor();
          });
          return [
            toggle,
            folder.addBinding(optionalSiteMonitorView, site.id, {
              readonly: true,
              label: " "
            })
          ];
        })
      ];
      refreshOptionalSiteMonitor();
      return {
        monitors: [{
          refresh() {
            refreshOptionalSiteMonitor();
            applyAllOptionalSitePerfGates();
            for (const binding of bindings) binding.refresh();
          }
        }]
      };
    }
  });
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
      if (!site.forced && (distance > OPTIONAL_SITE_RECHECK_RADIUS || site.available?.() === false)) {
        site.state = "dormant";
        site.forced = false;
        return;
      }
      site.state = "loading";
      await site.load();
      site.state = "ready";
      console.info(`[lazy-site] ${site.label} ready`);
      applyOptionalSitePerfGate(site);
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
    // Sutro owns an internal, closer GPU gate whose promise is intentionally
    // private. Treat its observable warmup as render-busy before admitting the
    // neighboring Lands End site to this serialized scheduler.
    if (sutroBaths?.debugState().nearEffectsLoading) return;
    if (optionalWorldSites.some((site) => site.state === "queued" || site.state === "loading")) return;
    let nearest: OptionalWorldSite | null = null;
    let nearestDistanceSq = OPTIONAL_SITE_APPROACH_RADIUS * OPTIONAL_SITE_APPROACH_RADIUS;
    for (const site of optionalWorldSites) {
      if (site.state !== "dormant") continue;
      if (!optionalSitePerfAllowed(site.id)) continue;
      if (site.available?.() === false) continue;
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
            // its boiler-room footprint alongside the authored Tea Garden.
            isTeaGardenBuilding(key, index) || (key === "1_12" && index === 0)
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

    // Forest + Creatures: ambient wildlife and rideable animals
    await waitForWorldBackgroundWindow(1800);
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
      if (!japaneseTeaGarden) restoreTeaGardenBuildings();
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
    // Freeze the world (no sim, no render) while a reading overlay is open DURING
    // play. Before the player has entered (a shared ?read= link opens the panel
    // over the loading folio), keep ticking so the world keeps streaming in behind
    // the modal — otherwise it would never finish loading while you read.
    if ((btsReading && document.body.classList.contains("started")) || museumBookOpen) {
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

    // Expanded map: gamepad pan / zoom / select / teleport / pin cycle.
    // World + player are fully frozen while the map is open (kb or pad).
    if (minimap.expanded) {
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
    afterlight?.setNightOpen(isAfterlightOpenAtHour(sky.timeOfDay));
    updateOptionalWorldSites();
    if (optionalSitePerfGating) applyAllOptionalSitePerfGates();
    // One wake/sleep pass over every registered minigame site (pickleball,
    // golf, …): a contains() test per site, setAwake only on transitions.
    if (!worldArrival.active) siteGate.update(player.position.x, player.position.z);

    // The shared court keeps advancing even while the rest of the world is
    // paused, so a remote opponent never loses the match when authority opens
    // photo/pause controls.
    const pickleballEConsumed =
      worldArrival.active || !optionalSitePerfAllowed("goldman")
        ? false
        : updatePickleballGameplay(frameDt);
    const playingPickleball = pickleballController?.playing ?? false;
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
      if (!playingPickleball && !input.suspended && player.mode === "surf" && input.pressed("Space")) {
        player.requestSurfJump();
      }
      if (!playingPickleball && !input.suspended && player.mode === "surf" && input.pressed("KeyX")) {
        player.requestSurfFlow();
      }
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
      if (!worldArrival.active) {
        citygenRing.current?.update(player.position, frameDt);
        if (optionalSitePerfAllowed("sutro-baths")) {
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
        lampLight: computeLampField()
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
    // Keyboard arrows and d-pad share the toolbar: ↑/↓ change row focus,
    // ←/→ cycle the focused row (vehicles / tools / paint swatches).
    if (!playingPickleball) {
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
      if (dx || dy) toolbar.navigate(dx, dy);
    }
    if (!playingPickleball && input.altPressed("ArrowLeft")) applyPlaceHistory(-1);
    if (!playingPickleball && input.altPressed("ArrowRight")) applyPlaceHistory(1);

    // E / pad Y: nearby conversations get first refusal. When the prompt was
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
      !afterlight?.tryInteract(player, hud) &&
      !(
        surfShack?.tryInteract(player, hud, (config) => {
          surfboardConfig = config;
          setLocalSurfboardConfig(config);
          player.setSurfboardConfig(config);
          const request = ++surfEntryRequest;
          void chase.ensureSurfCamera().then(() => {
            if (request !== surfEntryRequest || player.mode !== "walk") return;
            navigation.switchMode("surf");
          });
        }) ?? false
      )
    ) {
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
      } else if (tool === "bubbles" && fireCooldown <= 0) {
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
    if (!playingPickleball && !input.suspended && player.mode === "surf" && input.pressed("Space")) {
      player.requestSurfJump();
    }
    if (!playingPickleball && !input.suspended && player.mode === "surf" && input.pressed("KeyX")) {
      player.requestSurfFlow();
    }
    if (
      !playingPickleball &&
      !afterlightControlsCaptured &&
      !input.suspended &&
      player.mode === "walk" &&
      input.pressed("Space")
    ) player.requestWalkJump();

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
      creatures?.update(elapsed, camera.position); // gulls live at altitude — never distance-gated
      forest?.update(frameDt, camera.position);
    }
    // Night ball glow amount from the current sun elevation (park / fetch / held /
    // pickleball all read BALL_GLOW_NIGHT). Uses last sky.update's elevation —
    // fine; elevation only moves with the clock.
    syncBallGlowNight(sky.sunElevation);
    if (!worldArrival.active) {
      if (optionalSitePerfAllowed("corona")) {
        coronaHeights?.update(frameDt, elapsed, camera.position);
      } else if (coronaHeights) {
        coronaHeights.group.visible = false;
      }
      if (optionalSitePerfAllowed("lands-end")) {
        landsEnd?.update(frameDt, elapsed, player.position);
        if (landsEnd && player.mode === "walk") {
          landsEnd.keeper.updatePrompt(player.position.x, player.position.z, hud);
        }
      } else if (landsEnd) {
        landsEnd.group.visible = false;
      }
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
      if (optionalSitePerfAllowed("sutro-baths")) {
        sutroBaths?.update(frameDt, elapsed, player.renderPosition, camera, windGustValue());
      }
      japaneseTeaGarden?.update(
        frameDt,
        elapsed,
        player.renderPosition,
        camera,
        player.mode,
        player.velocity
      );
      if (
        japaneseTeaGarden?.group.parent === scene &&
        japaneseTeaGarden.debugState().awake
      ) claimTeaGardenBuildings();
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
    if (!worldArrival.active && optionalSitePerfAllowed("palace")) {
      palaceReverie?.update(frameDt, elapsed, player.position, hud);
      const welcome = palaceReverie?.takeWelcome();
      if (welcome) hud.message(welcome, 6.2);
    }
    // Archery: site-gated, one boolean early-return when asleep with nothing live
    if (!worldArrival.active && optionalSitePerfAllowed("archery")) {
      archery?.update(frameDt, elapsed, { player, input, hud, chase, camera });
    }
    // Biscuit the RL pup: site-gated, one boolean early-return when asleep
    if (!worldArrival.active && optionalSitePerfAllowed("pup")) {
      pup?.update(frameDt, camera);
    }
    // Afterlight: proximity collectibles, return flights, quest clock and the
    // completed sky performance; site-gated to a single asleep early return.
    if (!worldArrival.active && optionalSitePerfAllowed("afterlight")) {
      afterlight?.update(frameDt, elapsed, player, hud);
    }
    // Goldman clubhouse NPCs: one-hypot early return when far — safe every frame
    if (!worldArrival.active && optionalSitePerfAllowed("goldman")) {
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

    // "hop in" nudge when standing near a ride (friend → wildlife → parked mount)
    if (!worldArrival.active && player.mode === "walk" && embodiments.passengerOf === null) {
      const drv = remotes.nearestDriver(player.position, 5.5);
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
      if ((drv || nearAnimal || nearMount || surfBoardPrompt || reveriePrompt) && !ridePromptShown) {
        const rideCopy = drv
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
      if (!drv && !nearAnimal && !nearMount && !surfBoardPrompt && !reveriePrompt) ridePromptShown = false;
      // "open the door" nudge — same one-shot pattern; the ride prompt wins
      // when both are in range. nearestDoor is alloc-light but not free, so
      // it runs every 6th frame (prompt latency ~0.1 s) and only on foot.
      if (--doorScanCountdown <= 0) {
        doorScanCountdown = 6;
        doorScanHit = citygenRing.current?.nearestDoor(player.position) ?? null;
      }
      const door = doorScanHit;
      const nearClosedDoor = !!door && !door.open && door.dist < 3.2;
      if (nearClosedDoor && !drv && !nearAnimal && !nearMount && !doorPromptShown) {
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
    japaneseTeaGarden?.project(camera);
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
    water.update(surfaceTime, camera.position, player.renderPosition, player.mode === "surf");
    const surfTubeState = player.surfTelemetry.tubeState;
    const surfTubeVisibility =
      surfTubeState === "inside"
        ? 1
        : surfTubeState === "entering"
          ? 0.72
          : surfTubeState === "exiting"
            ? 0.32
            : 0;
    oceanBeachWaves?.update(surfaceTime, player.renderPosition, surfTubeVisibility);
    // Safety net for restored/direct surf transitions. Entry preparation keeps
    // its newly constructed mesh alive until the mode switch commits; otherwise
    // the activity visual is disposed on the first non-surf frame.
    if (!oceanBeachWaves && player.mode === "surf") {
      void ensureSurfRuntime();
    } else if (
      oceanBeachWaves &&
      player.mode !== "surf" &&
      surfEntryPreparations === 0
    ) {
      releaseSurfVisual();
    }
    underwater.update(camera, elapsed);
    seaPillars.update(player.renderPosition, elapsed);
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
    // The restored glasshouse sits just inland of the sampled shoreline, but
    // period accounts describe the Pacific as audible throughout the hall.
    // Preserve the generic coast model and add a local surf floor that fades
    // naturally across the Point Lobos approach.
    const sutroSurf = THREE.MathUtils.clamp(1 - distanceToSutroBaths(player.position.x, player.position.z) / 170, 0, 1);
    if (sutroSurf > 0) {
      waveEnergy.level = Math.max(waveEnergy.level, sutroSurf * 0.5);
      waveEnergy.breaking = Math.max(waveEnergy.breaking, sutroSurf * 0.68);
    }
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
      lampLight: computeLampField()
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

  // Retained in the profiling hook for shadow probe compatibility; dynamic
  // resolution is currently owned internally by the render pipeline.
  const dynRes = undefined;

  const exposeDebugHooks = () => {
    Object.assign(window as never, {
      // renderIdle: probes MUST wait for this before capture phases — while the
      // deferred render warmup runs, tick() early-returns without rendering, so
      // screenshots would capture a stale boot-pose frame no matter what the
      // camera was set to.
      __sf: { scene, camera, player, tiles, authoredRegions, physics, renderer, pipeline, dynRes, tracer, scheduler, POSTFX_TUNING, WORLD_TUNING, FLOWER_TUNING, RENDER_TUNING, CAR_LANDING_TUNING, chase, map, input, hud, fx, fireworks, graffiti, bubbles, setTool, setColor, sky, farOcclusion, debugPanel, CONFIG, THREE, tick, creatures, forest, garden, wildlands, buenaVistaTrees, goldenGateTennis, japaneseTeaGarden, pickleball: pickleballController?.game ?? null, pickleballAmbient: pickleballController?.ambient ?? null, pickleballAudio: pickleballController?.audio ?? null, pickleballUI: pickleballController?.ui ?? null, pickleballController, coronaHeights, missionDolores, sutroBaths, splashes, vehicleAudio, swimAudio, gameplaySfxBus, playerFoleyAudio, jumpLandingAudio, modeTransitionAudio, doorAudio, getPaintAudio: () => paintAudio, getBubbleAudio: () => bubbleAudio, nature, dogParkAudio, ballImpactAudio, net, remotes, voice, minimap, playerLocator, boardWake, abandonedMounts, paintballs, paintSkins, hunt, satchel, buildShareUrl, tutorial, fetchBall, goldenGateLights, teleportToTarget, trafficLights, streetLamps, citygen, citygenRing, worldCursor, worldQueries, buildingRayRefiner, underwater, seaPillars, water, oceanBeachWaves, surfExperience, ensureSurfRuntime, roadMarkings, debugOverlays, calibrationChart, FOLIAGE_TUNING, CITYGEN_TUNING, setFoliageVisible, buskers, boardSelector, ensureCarCustomizer, getCarSelector: () => carSelector, getCarConfig: () => ({ ...carConfig }), ensureSurfboardCustomizer, getSurfboardConfig: () => ({ ...surfboardConfig }), siteGate, palaceReverie, landsEnd, afterlight, optionalWorldSites, ensureOptionalWorldSite,
        TSL,
        renderIdle: () => modulesReady && !optionalWorldSites.some(
          (site) => site.state === "queued" || site.state === "loading"
        ) && !(sutroBaths?.debugState().nearEffectsLoading ?? false) }
    });
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) {
      Object.assign(hooks, {
        worldArrival,
        lazyRegionTimings,
        teaGardenBuildingSwapState,
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
      if (site) await ensureOptionalWorldSite(site);
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
