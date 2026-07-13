import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import CameraControls from "camera-controls";
import { CAMERA_TUNING, CITYGEN_TUNING, CONFIG, FLOWER_TUNING, FOLIAGE_TUNING, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING } from "./config";
import { loadPlayerState, resetAllTweaks } from "./core/persist";
import { Input } from "./core/input";
import { tracer } from "./core/hitchTracer";
import { bootMarkStart, bootMark, bootMarkSummary, persistBootHistory } from "./core/bootMarks";
import { createFrameScheduler } from "./core/frameBudget";
import { WorldMap, waterHeight } from "./world/heightmap";
import { OCEAN_BEACH_SURF } from "./world/oceanBeachWaves";
import { Sky, SKY_TUNING } from "./world/sky";
import { Water } from "./world/water";
import { UnderwaterOverlay } from "./fx/underwater";
import { syncBallGlowNight } from "./fx/ballGlow";
import { SeaPillars } from "./world/seaPillars";
import { TileStreamer } from "./world/tiles";
import { createRoadMarkings } from "./world/roadMarkings";
import { RoadGraph } from "./world/traffic/roadGraph";
import { TrafficLightView } from "./world/traffic/trafficLights";
import { StreetLamps } from "./world/streetLamps";
import { Physics } from "./core/physics";
import { updateCrownDisplay, resetCrownTweaks } from "./world/salesforceCrown";
import { createBayLights, updateBayLights, resetBayLightsTweaks } from "./world/bayLights";
import { createGoldenGateLights, updateGoldenGateLights, resetGoldenGateLightsTweaks } from "./world/goldenGateLights";
import { createPalaceColonnade, PALACE_RING_BUILDINGS } from "./world/palaceColonnade";
import { createSutroTower, updateSutroTower, resetSutroLightsTweaks } from "./world/sutroTower";
import {
  createGoldenGateTennisSite,
  GOLDMAN_SUPPRESSED_BUILDINGS,
} from "./world/goldenGateTennis";
import {
  JAPANESE_TEA_GARDEN_ENTRANCE,
  TEA_GARDEN_SUPPRESSED_BUILDINGS,
  isTeaGardenBuilding
} from "./world/japaneseTeaGarden/layout";
import { CoronaHeightsPark, prepareCoronaHeightsGround } from "./world/coronaHeights";
import { createMissionDoloresMuseum, type MissionDoloresMuseum } from "./world/missionDolores";
import { OceanBeachWaves, SurfExperience } from "./gameplay/surfing";
import { findOpenSpawn } from "./world/spawn";
import { resolveSpawnPoint, type RegionKey } from "./world/spawnPoints";
import { nearAnyWildRegion } from "./world/wildlands/layout";
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
import { createArchery, ARCHERY_CENTER, type ArcheryGame } from "./gameplay/archery";
import { Satchel } from "./ui/satchel";
import { HUD } from "./ui/hud";
import { ShareButton } from "./ui/share";
import { PauseToggle } from "./ui/pauseToggle";
// BehindTheScenes is deferred (dynamic import after start is ready)
import { parseReadLink, openReadLink } from "./ui/deepLinks";
import { Tutorial } from "./ui/tutorial";
import { createRenderPipeline } from "./render/pipeline";
import { createDynamicResolution } from "./render/dynamicRes";
import { POSTFX_TUNING, setFlowPostFx } from "./render/postfx";
import { DebugPanel } from "./ui/debug";
import { ColliderDebug, type DebugBox, type DebugMesh } from "./ui/colliderDebug";
import { CalibrationChart } from "./ui/calibrationChart";
import { Net, hasChosenName, pickName } from "./net/net";
import { RemotePlayers } from "./net/remotes";
import { Voice } from "./net/voice";
import { Minimap } from "./ui/minimap";
import { PlayerLocator } from "./ui/playerLocator";
import { avatarFromSeed, loadSavedAvatar, randomAvatarTraits, saveAvatarTraits } from "./player/avatar";
import { boardFromSeed, boardVisualKey, loadSavedBoard, randomBoardConfig, saveBoardConfig, setLocalBoardConfig } from "./vehicles/board";
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
import { createBuskersSystem } from "./app/systems/buskers";
import { createSessionPersistence } from "./app/sessionPersistence";
import { startFrameDriver } from "./app/frameDriver";
import { EmbodimentController } from "./app/player/embodimentController";
import { NavigationController } from "./app/navigation";
import { consumeDevReloadSnapshot, writeDevReloadSnapshot } from "./app/hmr/devReloadSnapshot";
import { RendererDiagnostics } from "./app/diagnostics";
import { PickleballController } from "./app/systems/pickleball";

CameraControls.install({ THREE });

const bootScreen = new BootScreen();
const { app, loading, nameInput, suggestedName } = bootScreen;
const progress = (percent: number, label: string) => bootScreen.progress(percent, label);

async function boot() {
  const bootT0 = performance.now();
  bootMarkStart();
  progress(8, "reading the map");
  const map = await WorldMap.load();
  prepareCoronaHeightsGround(map);
  bootMark("map");

  progress(18, "waking the gpu");
  const { renderer, scene, camera } = await createRenderCore(app);
  bootMark("gpu");

  const sky = new Sky(scene);
  const water = new Water(scene, map);
  const oceanBeachWaves = new OceanBeachWaves(scene);
  const underwater = new UnderwaterOverlay(app, map);
  const seaPillars = new SeaPillars(scene, map);

  progress(40, "streaming the city");
  const tiles = new TileStreamer(scene);
  await tiles.init(map);
  bootMark("tiles");
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

  const physics = await Physics.create(map, tiles);
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

  // Where a fresh session begins. Code spawns (src/world/spawnPoints.ts) win
  // over the baked meta.json table so a location can declare which heavy foliage
  // regions it needs before reveal; default is the Corona Heights summit. Falls
  // back to the baked spawn, then Golden Gate. Nudged onto open ground — never
  // under (or inside) a building. (Resume/invite paths override this entirely.)
  // `?spawn=<code-or-baked-key>` is a non-persisting place link used by QA and
  // future location sharing. An unknown key safely falls back to the saved/default
  // start without changing settings.
  const requestedSpawn = new URLSearchParams(location.search).get("spawn")?.trim();
  const autoStartIrohTour = new URLSearchParams(location.search).get("tour") === "iroh";
  const spawnKey = requestedSpawn && (resolveSpawnPoint(requestedSpawn) || map.meta.spawns[requestedSpawn])
    ? requestedSpawn
    : START.spawn;
  const spawnPoint = resolveSpawnPoint(spawnKey) ?? resolveSpawnPoint(START_DEFAULTS.spawn);
  const startAt = spawnPoint ?? map.meta.spawns[spawnKey] ?? map.meta.spawns[START_DEFAULTS.spawn];
  // Per-session scatter: every fresh session lands a stride or two off the
  // registered point, so two players (or two tabs) never boot into the exact
  // same spot — co-located avatars interpenetrate and read as z-fighting. An
  // explicit place link is exact so authored interaction ranges remain reliable.
  // findOpenSpawn validates the scattered point like any other candidate.
  const scatterA = Math.random() * Math.PI * 2;
  const scatterR = requestedSpawn ? 0 : 0.8 + Math.random() * 1.6;
  const spawn = await findOpenSpawn(map, tiles.manifest, {
    ...startAt,
    x: startAt.x + Math.cos(scatterA) * scatterR,
    z: startAt.z + Math.sin(scatterA) * scatterR
  }, requestedSpawn ? 1.5 : 12, requestedSpawn ? 36 : 200);
  // Lean-boot spawns cap the draw radius while the cover is up: only the near
  // district (tiles + citygen cells, both keyed off CONFIG.tileLoadRadius) gates
  // the reveal. The first covered tile scan runs after this, so the cap takes
  // effect before anything streams; revealWorld restores the full radius.
  const fullTileRadius = CONFIG.tileLoadRadius;
  if (spawnPoint?.bootTileRadius) {
    CONFIG.tileLoadRadius = Math.min(fullTileRadius, spawnPoint.bootTileRadius);
  }
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
  const surfExperience = new SurfExperience(vehicleAudio);
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
  // The customizer module itself is deferred until surf first activates. This
  // is rebound after networking exists; the early no-op keeps the mode callback
  // safe during startup/restores.
  let ensureSurfboardCustomizer: () => void = () => {};
  const birdTrails = new BirdTrails(scene, player.meshes.bird);
  const droneFireworkMounts = player.meshes.drone.userData.fireworkMounts as THREE.Object3D[] | undefined;
  const startMode = spawnPoint?.mode ?? START.mode;
  if (startMode !== "walk" && ALL_MODES.includes(startMode)) player.trySwitch(startMode);
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
      ensureSurfboardCustomizer();
      // Drop straight into a readable down-the-line shot: the board travels
      // south while the wave face peels along the player's left shoulder.
      chase.yaw = Math.PI - 0.38;
      chase.pitch = 0.12;
      chase.zoom = 1.15;
    }
    if (fresh) {
      const msg = modeDiscovery.revealMessage(mode);
      if (msg) hud.message(msg, 2.8);
    }
  };
  input.setMode(player.mode);
  toolbar.setVehicle(player.mode);
  // onModeChange is wired after the startup trySwitch, so a boot straight into
  // surf (spawnPoint/invite) needs the cull applied once explicitly.
  if (player.mode === "surf") applySurfCull(true);
  // controller: swap the help labels to whichever device was touched last
  input.onDeviceChange = (device) => hud.setDevice(device);
  window.addEventListener("gamepadconnected", () => hud.message("Controller connected", 2.4));
  window.addEventListener("gamepaddisconnected", () => {
    hud.message("Controller disconnected", 2.4);
    hud.setDevice("kb");
  });

  // Traffic lights: procedural signals along the road graph. The road graph
  // loads off the boot path; once it's ready the light rigs pool into the scene
  // and their state machine cycles (see world/traffic/). Failures leave the city
  // without signals but never block boot.
  let trafficLights: TrafficLightView | null = null;
  let streetLamps: StreetLamps | null = null;
  auxPending++;
  void RoadGraph.load()
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
  const leaveRide = () => embodiments.leaveRide();
  const exitToWalk = () => embodiments.exitToWalk();
  const dropCurrentDriveMount = () => embodiments.dropCurrentDriveMount();
  let cameraMode = false;
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
  // Nature = SeedThree ONLY now. The old primitive Flora (whole-world low-poly
  // trees + blade grass riding the tile stream) is gone — one better system,
  // grown region by region, and no world-wide grass/tree tax on the GPU.
  //
  // San Francisco Botanical Garden — self-contained module (src/world/garden):
  // SeedThree trees + procedural blade grass + shrubs/flora at the real SFBG
  // footprint inside Golden Gate Park. Trees stream in async; grass is live now.
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
    update: (pos: THREE.Vector3, cam: THREE.Vector3) => void;
  } | null = null;
  let goldenGateTennis: ReturnType<typeof createGoldenGateTennisSite> | null = null;
  let japaneseTeaGarden: import("./world/japaneseTeaGarden").JapaneseTeaGarden | null = null;
  // Universal minigame site gate: each located game (pickleball, golf, soon
  // archery) registers a footprint + pads; one cheap update per tick flips
  // them awake only while the player is nearby. Sites register asleep — the
  // first tick wakes any the player already stands in.
  const siteGate = createSiteGate();
  let coronaHeights: CoronaHeightsPark | null = null;
  let missionDolores: MissionDoloresMuseum | null = null;
  let museumBookOpen = false;
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
    goldenGateTennis?.setFoliageVisible(visible);
    japaneseTeaGarden?.setFoliageVisible(visible);
    coronaHeights?.setFoliageVisible(visible);
  };
  const islands = new Islands(physics, map, scene);

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

  // citygen (demo + ring) are deferred — populated by the loader
  // after progress(100); citygenRing uses the existing nullable-current pattern
  let citygen: { update?: (dt: number) => void; [k: string]: unknown } | null = null;
  const citygenRing: { current: CityGenRing | null } = { current: null };

  // crabs to hunt (hunt.ts)
  const satchel = new Satchel();
  // Presidio golf: full 18 playable holes on the real course footprint —
  // deferred (data fetch + course meshes build behind the settle gate below)
  let golf: import("./gameplay/golf").GolfGame | null = null;
  // Golden Gate Park archery range — NW corner of the park; site-gated like golf.
  let archery: ArcheryGame | null = null;
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
    // Palace of Fine Arts peristyle: the OSM data carries the curved colonnade as
    // ordinary windowed buildings, so swap them for a real open row of columns.
    for (const b of PALACE_RING_BUILDINGS) tiles.suppressBuilding(b.key, b.index);
    scene.add(createPalaceColonnade(map));
  } catch (err) {
    console.warn("[boot] palace colonnade unavailable:", err);
  }
  try {
    scene.add(createSutroTower(map));
  } catch (err) {
    console.warn("[boot] sutro tower unavailable:", err);
  }
  try {
    // Replace the generic extruded OSM clubhouse mesh but retain its accurate
    // baked collider. The authored site owns all 16 tennis courts, the five
    // current pickleball/mini courts, circulation, fencing, and hill-edge trees.
    for (const building of GOLDMAN_SUPPRESSED_BUILDINGS) {
      tiles.suppressBuildingMesh(building.key, building.index);
    }
    goldenGateTennis = createGoldenGateTennisSite(map, {
      physics,
      daylight: () => sky.sunElevation > 0
    }).addTo(scene);
    goldenGateTennis.setFoliageVisible(foliageOn);
  } catch (err) {
    for (const building of GOLDMAN_SUPPRESSED_BUILDINGS) {
      tiles.unsuppressBuildingMesh(building.key, building.index);
    }
    console.warn("[boot] Goldman Tennis Center unavailable:", err);
  }
  // The seven mapped Tea Garden buildings are replaced by authored, walkable
  // structures. Hide both baked prisms and their generic colliders up front;
  // the garden module owns the replacement collision and restores these on a
  // construction failure.
  for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
    tiles.suppressBuilding(building.key, building.index);
  }
  try {
    // Archery range in GG Park's NW corner. Born hidden (site-gated); a live
    // draw or an arrow in flight holds the site awake. Compile the hidden root
    // off the critical path so the first wake never hitches on shaders.
    archery = createArchery(map, physics, worldQueries, scene, {
      nature,
      daylight: () => sky.sunElevation > 0.05
    });
    siteGate.register(archery.siteHooks());
    void renderer.compileAsync(archery.root, camera, scene);
  } catch (err) {
    console.warn("[boot] archery range unavailable:", err);
  }
  try {
    coronaHeights = new CoronaHeightsPark(map, physics);
    coronaHeights.setFoliageVisible(foliageOn);
    scene.add(coronaHeights.group);
  } catch (err) {
    console.warn("[boot] corona heights unavailable:", err);
  }
  try {
    // Mission San Francisco de Asís (Mission Dolores) — the founding Franciscan
    // mission the city is named for, rebuilt basilica-scale and turned into a
    // walkable museum of Saint Francis. The Canticle book (E at the pedestal)
    // freezes the world exactly like the behind-the-scenes reader.
    missionDolores = createMissionDoloresMuseum(map, physics, {
      onBookToggle: (open) => {
        museumBookOpen = open;
        app.classList.toggle("world-dimmed", open);
        input.suspended = open || cameraMode;
        if (open) input.releaseLock();
      }
    }).addTo(scene);
  } catch (err) {
    console.warn("[boot] Mission Dolores museum unavailable:", err);
  }
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
  if (coronaHeights) {
    coronaHeights.onDogAudioCue = (dog, cue) => dogParkAudio.cue(dog, cue);
  }
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

  const chase = new ChaseCamera(camera, map, physics);
  chase.yaw = spawn.heading; // behind the player, looking the way they face (spawn.heading is raw facing)
  // seed the camera above the local ground — hilltop spawns sit well over y=30
  camera.position.set(spawn.x + 20, map.effectiveGround(spawn.x, spawn.z) + 30, spawn.z + 20);

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

  const setCameraMode = (on: boolean) => {
    cameraMode = on;
    input.suspended = on;
    orbit.enabled = on;
    if (on) {
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
      hud.message("Camera mode — drag to orbit, double-click to retarget, O for 180°, C to return", 3.5);
    } else {
      orbitFlip = null;
      hud.message("");
      input.requestLock();
    }
  };

  // Double-click any surface in camera mode → that point becomes the new orbit target
  // (camera stays put; orbit/dolly continue around the new look-at).
  // Busker hits snap to the musician's chest so the orbit centers on the singer.
  renderer.domElement.addEventListener("dblclick", (e) => {
    if (!cameraMode || e.button !== 0) return;
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
  const pipeline = createRenderPipeline(renderer, scene, camera);

  // Dynamic-resolution governor: watches the real rAF cadence and steps the
  // drawing-buffer pixel ratio between RENDER_MODE.minPixelRatio and
  // RENDER_MODE.pixelRatioCap to hold the frame budget on weaker GPUs.
  // Currently off (cap == floor == 1); kept wired so re-enabling is a config flip.
  // The apply path is exactly what boot + resize do (setPixelRatio + setSize);
  // the WebGPU pass targets re-derive from the drawing-buffer on the next
  // render, so nothing else needs a resize hook.
  const applyPixelRatio = (ratio: number) => {
    renderer.setPixelRatio(ratio);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  const dynRes = createDynamicResolution({
    apply: applyPixelRatio,
    readRatio: () => renderer.getPixelRatio()
  });

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
  const pickleballController = new PickleballController({
    goldman: goldenGateTennis,
    scene,
    renderer,
    camera,
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
  const releasePickleballForNavigation = () => pickleballController.releaseForNavigation();
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
      if (player.mode !== "scooter" && !player.riding) player.trySwitch("scooter");
    }
  );
  const applySurfboardConfig = (config: SurfboardConfig) => {
    const changed = surfboardVisualKey(config) !== surfboardVisualKey(surfboardConfig);
    surfboardConfig = config;
    setLocalSurfboardConfig(config);
    if (changed) player.setSurfboardConfig(config);
    else player.previewSurfboardSurface(config);
  };
  let surfboardSelector: { setConfig(config: SurfboardConfig): void } | null = null;
  let surfboardSelectorLoading: Promise<void> | null = null;
  ensureSurfboardCustomizer = () => {
    if (surfboardSelector || surfboardSelectorLoading) return;
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
          () => {
            if (player.mode !== "surf" && !player.riding) player.trySwitch("surf");
          }
        );
      })
      .catch((error) => console.warn("[surf] shaping room failed to load", error))
      .finally(() => {
        surfboardSelectorLoading = null;
      });
  };
  // Startup can already be in surf mode before onModeChange is wired.
  if (player.mode === "surf") ensureSurfboardCustomizer();
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
    pickleballController.onWelcome();
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
    pickleballController.syncSlots();
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
      if (!cameraMode && document.body.classList.contains("started") && !input.suspended) {
        input.requestLock();
      }
    }
  );
  net.onChat = (_id, name, text) => chat.addMessage(name, text);
  // golf: friends' swings/balls/scores replay here (owner-simulated snapshots)
  net.onGolf = (id, m) => golf?.handleNet(id, m, hud, net.roster.get(id)?.name ?? "Player");
  input.onLockChange = (locked) => {
    if (!locked && !cameraMode && !input.freeCursor && !chat.focused) {
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
      pickleballController.onOffline();
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
  if (goldenGateTennis) {
    minimap.addLandmark(
      goldenGateTennis.gameplayAnchor.x,
      goldenGateTennis.gameplayAnchor.z,
      "Goldman Tennis & Pickleball"
    );
  }
  // Archery range — NW corner of Golden Gate Park. Static known coords (the
  // site builds hidden behind its gate), so the pin is safe to drop even when
  // the range is asleep. Marks the field + gives a teleport like golf/tennis.
  if (archery) {
    minimap.addLandmark(ARCHERY_CENTER.x, ARCHERY_CENTER.z, "Archery Range");
  }
  // Ocean Beach surf break. The pin sits just inside the waterline so a teleport
  // (or a shared ?j= link) drops you on the sand at the shore, facing the swell,
  // board in hand — ready to press E and paddle out.
  minimap.addLandmark(OCEAN_BEACH_SURF.maxX - 26, OCEAN_BEACH_SURF.entryZ, "Ocean Beach · Surf");
  const playerLocator = new PlayerLocator();
  const navigation = new NavigationController({
    player,
    chase,
    hud,
    map,
    tiles,
    remotes,
    embodiments,
    releaseGameplay: releasePickleballForNavigation
  });
  const beginPlaceNavigation = (label: string) => navigation.begin(label);
  const finishPlaceNavigation = (label: string) => navigation.finish(label);
  const applyPlaceHistory = (step: -1 | 1) => navigation.applyHistory(step);
  const switchMode = (mode: PlayerMode) => navigation.switchMode(mode);
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
    input.suspended = on || cameraMode; // camera mode owns suspension when the map closes
    // Open always frees the pointer. Collapse does not re-lock here — Esc-dismiss
    // must leave the cursor free; M-toggle re-locks in the tick below.
    if (on) input.releaseLock();
  };

  // Escape priority: dismiss an open overlay (stay unlocked) → else release pointer
  // lock. Stops the old "Esc closes UI and immediately re-locks" double-tap.
  // Registered after minimap exists so an early Esc can't hit a TDZ binding.
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "Escape" || e.repeat) return;
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
    teleport: (t) => {
      beginPlaceNavigation("Previous place");
      leaveRide();
      dropCurrentDriveMount();
      player.teleportTo(t);
      chase.yaw = t.facing;
      finishPlaceNavigation("Tutorial place");
    },
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

  // ?j=x,y,z,facing,mode[,animal] — invite links from the Share button.
  // A friend opening one spawns right where the sharer stood, in the same kind
  // of vehicle (a ridden animal included).
  const invite = (() => {
    const q = new URLSearchParams(location.search);
    const raw = q.get("j");
    if (!raw) return null;
    const p = raw.split(",");
    const x = Number(p[0]);
    const y = Number(p[1]);
    const z = Number(p[2]);
    const facing = Number(p[3]);
    const mode = ALL_MODES.find((m) => m === p[4]);
    if (![x, y, z, facing].every(Number.isFinite) || !mode) return null;
    const animal = p[5] && ANIMALS && p[5] in ANIMALS ? (p[5] as AnimalKind) : null;
    return { x, y, z, facing, mode, animal, from: q.get("via") };
  })();

  const reloadCandidate = import.meta.env.DEV ? consumeDevReloadSnapshot() : null;
  const query = new URLSearchParams(location.search);
  const devReload = invite || parseReadLink(location.search) || query.has("demo") ? null : reloadCandidate;

  // Resume last session: position, heading and vehicle survive a refresh. A
  // Vite structural reload additionally restores the exact chase-camera view.
  // (after the debug panel exists — restoreState can fire onModeChange).
  // An invite link wins over the saved session — the click's intent is explicit.
  const resumed = invite || requestedSpawn ? null : (devReload?.player ?? loadPlayerState());
  if (resumed) {
    player.restoreState(resumed);
    modeDiscovery.discover(resumed.mode);
    chase.yaw = devReload?.camera.yaw ?? resumed.heading + Math.PI;
    if (devReload) {
      chase.pitch = devReload.camera.pitch;
      chase.zoom = devReload.camera.zoom;
      (window as unknown as { __sfDevReloadRestored?: boolean }).__sfDevReloadRestored = true;
    }
    camera.position.set(resumed.x + 20, resumed.y + 30, resumed.z + 20);
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
    player.teleportTo({ x: jx, y: invite.y, z: jz, facing: invite.facing, mode });
    chase.yaw = invite.facing;
    camera.position.set(jx + 20, invite.y + 30, jz + 20);
    // one-shot: strip the params so a refresh resumes the session instead of
    // re-teleporting (the 1 Hz session save takes over from here)
    const q = new URLSearchParams(location.search);
    q.delete("j");
    q.delete("via");
    history.replaceState(null, "", location.pathname + (q.size ? `?${q}` : ""));
    if (import.meta.env.DEV) console.log("[sf] joined via invite", invite);
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

  // Warm the GPU pipelines while the loading screen still covers the canvas.
  // First render lets the CSM shadow node build its cascade lights (that build
  // changes the scene light set once, and anything compiled before it would
  // need a second compile after). Then one render with EVERY mode's meshes
  // visible compiles all eight vehicles in a single covered pass — the compile
  // stall lands behind the opaque backdrop where nobody can see it, so the
  // old post-reveal idle-warm chain (one visible hitch per mode) is gone and
  // every mode-switch in play is compile-free from the first frame. Vehicle
  // lamps come from Player's fixed-size LightPool (always in the scene).
  // Culling is off so meshes parked at the origin still draw.
  bootMark("world");
  progress(88, "warming up the vehicles");
  sky.update(0, camera.position);
  syncBallGlowNight(sky.sunElevation);
  // The small debug overlays are normally hidden, which used to leave their
  // line/standard-material pipelines cold until the first checkbox click.
  // Show one representative collider and the grey cards only under the opaque
  // boot cover, then restore the persisted visibility after the warm render.
  const warmColliderDebug = Boolean(RENDER_TUNING.values.colliderDebug);
  const warmGreyCards = Boolean(RENDER_TUNING.values.greyCards);
  colliderDebug.setVisible(true);
  colliderDebug.sync([{ x: player.position.x, y: player.position.y, z: player.position.z, hx: 1, hy: 1, hz: 1, yaw: 0, r: 1, g: 0.2, b: 0.2 }]);
  calibrationChart.sync(camera, true);
  pipeline.render();
  player.warmup("all");
  fx.prewarm(); // compiles both sprite blend pipelines before gameplay
  fireworks.prewarm(); // sprite-pool pipeline — was a lazy first-use hitch
  nature.prewarm(); // procedural audio buffers (contexts stay suspended until a gesture — autoplay policy holds)
  paintballs.spawn(0, -520, 0, 0, 0, 0, new THREE.Color(PAINT_COLORS[0]), 0); // paintball pipeline
  const unculled: THREE.Object3D[] = [];
  for (const mesh of Object.values(player.meshes)) {
    mesh.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false;
        unculled.push(o);
      }
    });
  }
  progress(90, "warming render paths");
  await pipeline.warmup("boot");
  bootMark("warmup");
  colliderDebug.setVisible(warmColliderDebug);
  calibrationChart.sync(camera, warmGreyCards);
  // one rAF flush is enough for the compile submit; no fixed 350ms wait
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  for (const o of unculled) o.frustumCulled = true;
  player.warmup(); // restore: only the current mode visible
  {
    // underwater ceiling pipeline: visible for two scheduled frames under the
    // cover (water.update() re-hides it each frame after it draws once)
    let warmTicks = 0;
    scheduler.schedule("background", () => {
      water.underside.visible = true;
      return ++warmTicks < 2 ? "again" : undefined;
    });
  }

  // Deferred module construction — still split into separate Vite chunks, but
  // built BEHIND the opaque cover now instead of after it lifts: the forest,
  // garden, wildlands and the citygen ring used to pop into the live city
  // while the player looked at the name gate. The settle gate below holds the
  // cover (and the Start button) until these exist and the work they queue on
  // the scheduler has fully drained.
  progress(92, "growing the parks");
  let modulesReady = false;
  let deferredModulesSettled = false;
  let lateRenderWarmupActive = false;
  let lateRenderWarmupRequestedAt = 0;
  // Resolves the instant the loading cover lifts. Any heavy region the spawn
  // doesn't gate waits on this and builds post-reveal (hidden → compileAsync →
  // visible) so it never delays first play — the "load the trees when you go
  // there" idea, generalized across garden / wildlands / golf.
  let resolveRevealed!: () => void;
  const revealedPromise = new Promise<void>((r) => {
    resolveRevealed = r;
  });
  // A region gates (builds before reveal) if the spawn says so; otherwise by
  // distance — only what sits within NEAR_GATE of the player's start. Corona
  // Heights gates nothing (spawnPoints.gates = []), so every grove streams in
  // after the cover lifts. NEAR_GATE is metres from each region's footprint.
  const NEAR_GATE = 1300;
  const GARDEN_XZ = {
    x: (BOTANICAL_GARDEN_BOUNDS.minX + BOTANICAL_GARDEN_BOUNDS.maxX) / 2,
    z: (BOTANICAL_GARDEN_BOUNDS.minZ + BOTANICAL_GARDEN_BOUNDS.maxZ) / 2
  };
  const GOLF_XZ = { x: -1979, z: -194 }; // Presidio course centroid (golf.json tee coords)
  const nearRegionByDistance = (r: RegionKey): boolean => {
    const p = player.position;
    if (r === "garden") return Math.hypot(p.x - GARDEN_XZ.x, p.z - GARDEN_XZ.z) < NEAR_GATE;
    if (r === "golf") return Math.hypot(p.x - GOLF_XZ.x, p.z - GOLF_XZ.z) < NEAR_GATE;
    return nearAnyWildRegion(p.x, p.z, NEAR_GATE);
  };
  const spawnGates = spawnPoint?.gates;
  const regionGates = (r: RegionKey): boolean =>
    spawnGates ? spawnGates.includes(r) : nearRegionByDistance(r);
  // Wildlands' groundcover/tree masks depend on the golf course footprint, so
  // the pair always builds together and in the same order (course data → grove
  // masks → course meshes), gating iff EITHER is near.
  const gardenGates = regionGates("garden");
  const wildlandsGolfGates = regionGates("wildlands") || regionGates("golf");
  void (async () => {
    // Forest + Creatures: ambient wildlife and rideable animals
    const [forestMod, creaturesMod] = await Promise.all([
      import("./gameplay/forest"),
      import("./gameplay/creatures")
    ]);
    ANIMALS = forestMod.ANIMALS as NonNullable<typeof ANIMALS>;
    creatures = new creaturesMod.Creatures(map, scene);
    forest = new forestMod.Forest(map, scene);

    // Garden + Wildlands: botanical garden grass + designed SeedThree groves
    const [gardenMod, wildlandsMod, golfMod, teaGardenMod] = await Promise.all([
      import("./world/garden"),
      import("./world/wildlands"),
      import("./gameplay/golf"),
      import("./world/japaneseTeaGarden")
    ]);
    // Botanical garden (heaviest single park: SeedThree trees + textures). Gate
    // it only when the spawn is near; otherwise build it AFTER the cover lifts,
    // hidden until compiled, so its trees never sit on the boot path.
    const buildGarden = () => {
      const g = gardenMod.createBotanicalGarden(map);
      garden = g;
      const h = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (h) Object.assign(h, { garden: g });
      return g;
    };
    let gardenReady: Promise<unknown> | null = null;
    if (gardenGates) {
      const g = buildGarden();
      scene.add(g.group);
      g.setVisible(foliageOn, player.position);
      gardenReady = g.ready;
    } else {
      void revealedPromise.then(async () => {
        const g = buildGarden();
        g.group.visible = false;
        scene.add(g.group);
        await g.ready;
        try {
          await renderer.compileAsync(g.group, camera, scene);
        } catch (err) {
          console.warn("[garden] deferred compile failed:", err);
        }
        g.setVisible(foliageOn, player.position);
      });
    }

    // Japanese Tea Garden: exact OSM footprint with authored gates, Tea House,
    // pagoda, ponds, bridges, specimen planting and Iroh's walkable guided tour.
    // It shares the Botanical Garden region gate because the two sites touch;
    // distant boots compile it after reveal so it never delays first play.
    const buildTeaGarden = () => {
      try {
        const site = teaGardenMod.createJapaneseTeaGarden(map, {
          physics,
          // Conversation is gameplay-critical, so it must remain visible when
          // the optional HUD panels are faded with Tab.
          dialogueParent: document.body
        });
        japaneseTeaGarden = site;
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
    let teaGardenReady: Promise<unknown> | null = null;
    if (gardenGates) {
      const site = buildTeaGarden();
      scene.add(site.group);
      site.update(0, 0, player.renderPosition, camera);
      if (autoStartIrohTour) site.interact(player.position, player.mode);
      teaGardenReady = site.ready;
    } else {
      void revealedPromise.then(async () => {
        const site = buildTeaGarden();
        site.group.visible = false;
        await site.ready;
        try {
          await renderer.compileAsync(site.group, camera, scene);
        } catch (err) {
          console.warn("[tea-garden] deferred compile failed:", err);
        }
        scene.add(site.group);
        site.update(0, 0, player.renderPosition, camera);
        if (autoStartIrohTour) site.interact(player.position, player.mode);
      }).catch((err) => {
        console.warn("[tea-garden] deferred construction failed:", err);
      });
    }

    // Wildlands groves + Presidio golf, built as one coupled unit: the course
    // footprint masks groundcover/trees off the fairways, so the order is fixed
    // (course data → masked groves → course meshes). Gate together when near;
    // otherwise the whole pair streams in after reveal, groves hidden until
    // compiled. `deferred` selects which.
    const buildWildlandsGolf = async (deferred: boolean) => {
      let loadedGolfCourse: import("./gameplay/golf").GolfCourse | null = null;
      try {
        loadedGolfCourse = await golfMod.loadGolfCourse(map);
      } catch (err) {
        // Golf data is optional to world boot: vegetation and the city still
        // load if a deploy is missing golf.json.
        console.warn("[golf] course unavailable:", err);
      }
      const _wildlands = wildlandsMod.createWildlands(
        map,
        loadedGolfCourse
          ? {
              // No animated blade clusters or flowers inside the course; its own
              // smooth rough/fairway/green materials own that footprint.
              groundcover: (x: number, z: number) => loadedGolfCourse!.contains(x, z, 1.2),
              // Keep the wooded rough character, but never procedural-tree a play
              // surface or the graded apron around greens/tee pads.
              trees: (x: number, z: number) => loadedGolfCourse!.clearsProceduralTrees(x, z)
            }
          : undefined
      );
      wildlands = _wildlands;
      const showFoliage = foliageOn && !deferred;
      for (const g of _wildlands.groups) {
        g.visible = showFoliage;
        scene.add(g);
      }
      const h = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (h) Object.assign(h, { wildlands: _wildlands });
      await _wildlands.ready;
      if (deferred) {
        // Compile each grove group before it is ever shown, so a live frame
        // never draws an uncompiled tree (no first-look hitch).
        for (const g of _wildlands.groups) {
          try {
            await renderer.compileAsync(g, camera, scene);
          } catch (err) {
            console.warn("[wildlands] deferred compile failed:", err);
          }
        }
        if (foliageOn) for (const g of _wildlands.groups) g.visible = true;
      }
      // Presidio golf game. Own guard — a bad golf.json must not take the
      // groves/city down with it.
      if (loadedGolfCourse) {
        const game = await golfMod.createGolf(map, physics, scene, loadedGolfCourse, {
          daylight: () => sky.sunElevation > 0.05
        });
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
        // Pre-compile the hidden root (garden/wildlands deferred pattern) so
        // the first wake never draws an uncompiled course.
        void renderer
          .compileAsync(game.root, camera, scene)
          .catch((err) => console.warn("[golf] deferred compile failed:", err));
        const first = loadedGolfCourse.holes.find((h2) => h2.ref === 1) ?? loadedGolfCourse.holes[0];
        if (first) minimap.addLandmark(first.teeXZ[0], first.teeXZ[1], "Presidio Golf · Hole 1");
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
      void revealedPromise.then(() => buildWildlandsGolf(true));
    }

    // Gate the reveal on whatever is near; deferred regions run post-reveal and
    // are intentionally excluded here so they never hold the cover.
    await Promise.all([gardenReady, teaGardenReady, wildlandsGolfReady].filter(Boolean));

    // CityGen: procedural building ring + demo. Awaited (not fire-and-forget)
    // so modulesReady only flips once the ring exists — its cell builds land in
    // the scheduler on the next covered tick and keep the settle gate honest.
    const [citygenMod, citygenDemoMod] = await Promise.all([
      import("./world/citygen"),
      import("./world/citygen/demo")
    ]);
    citygen = citygenDemoMod.createCityGenDemo({ scene, map }) as NonNullable<typeof citygen>;
    citygenRing.current = await citygenMod.createCityGenRing(
      { excludeBuilding: isTeaGardenBuilding },
      { scene, physics, map, tiles, schedule: scheduler.schedule }
    );

    // BehindTheScenes: the "how it was made" reading overlay.
    // Closing does not re-lock — Esc (and backdrop/close) leave the cursor free.
    const { BehindTheScenes } = await import("./ui/behindTheScenes");
    behindTheScenes = new BehindTheScenes((open: boolean) => {
      btsReading = open;
      app.classList.toggle("world-dimmed", open);
      input.suspended = open || cameraMode;
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
    })
    .finally(() => {
      // The animation loop owns the renderer, so it starts the second warmup at
      // a frame boundary after deferred construction/scheduler work has settled.
      // A failed chunk still reaches this path and cannot wedge the cover.
      deferredModulesSettled = true;
      lateRenderWarmupRequestedAt = performance.now();
    });

  // ------------------------------------------------------- settle gate
  // Hold the opaque cover until the world stops moving. Everything above
  // queued bursty work that used to run visibly behind the translucent name
  // gate — tile finalizes, citygen assembly, physics body batches, module
  // construction, streetlight/marking loads. While covered, tick() drains it
  // all in TURBO (24 ms scheduler budget, hot tile streaming) precisely
  // because none of it can be seen. Once nothing is outstanding for a
  // sustained window — which also guarantees every late-added mesh has been
  // rendered (= compiled) under the cover — the backdrop fades and Start
  // enables over a city that is already built, warm and idle-smooth.
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
  const skipGate = ["autostart", "demo", "profile"].some((key) => bootQuery.has(key));
  // A returning player who already picked a real name skips the gate: once the
  // world is ready we drop them straight in under their saved name. Fun/generated
  // names don't count (re-rolled each load), and the headless/demo (`skipGate`)
  // and reading-link paths run their own start, so they opt out here.
  const autoStartSaved =
    !parseReadLink(location.search) &&
    !bootQuery.has("startscreen") &&
    ((!skipGate && hasChosenName()) || Boolean(devReload?.started));
  const revealWorld = (reason = "settled") => {
    if (revealed) return;
    revealed = true;
    resolveRevealed(); // release any region-deferred park builds
    // Restore the full draw distance now that the near district gated the cover;
    // the rest of the city streams in from here (tiles + citygen both re-expand).
    CONFIG.tileLoadRadius = fullTileRadius;
    progress(100, "ready");
    bootScreen.markReady();
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
    if (autoEnter) {
      // Programmatic starts have no user gesture, so do not request pointer
      // lock. The first canvas click can capture it normally when needed.
      bootScreen.startNow(suggestedName, { lock: false });
      return;
    }
    if (autoStartSaved) {
      // no click to consume, so pointer lock has no gesture — startGame still
      // requests it (a no-op if the browser declines; first click re-locks)
      bootScreen.startNow(devReload?.started ? devReload.name : pickName());
      return;
    }
    bootScreen.focusNameInput(); // re-focus in case the player clicked away while waiting
  };
  // Called once per covered tick, after the scheduler drain. The weights only
  // shape the progress bar; the gate itself is remaining === 0.
  const settleTick = () => {
    if (revealed) return;
    // pending minus waiting: jobs parked on external state (anti-wedge retries
    // wait for the player to move — permanent while they idle at spawn) must
    // not hold the cover; fresh backlog must.
    const backlog = Math.max(0, scheduler.pending - scheduler.waiting);
    const remaining = backlog + tiles.busy + (modulesReady ? 0 : 24) + auxPending * 4;
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
      revealWorld("reveal-forced (15s cap)");
      return;
    }
    settlePct = Math.min(99, Math.max(settlePct, 88 + Math.round(11 * (1 - remaining / Math.max(1, peakRemaining)))));
    const label = !modulesReady ? "growing the parks" : tiles.busy > 0 ? "paving the streets" : "settling the city";
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

  // Immersive mode remembers whether the diagnostics layer was visible.
  let debugWasOn = false;
  const setDebugUI = (on: boolean) => diagnostics.setDebugUI(on, debugPanel);

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
    import.meta.hot.on("vite:beforeFullReload", captureDevReload);
    // Vite reconnect/server-restart reloads do not emit beforeFullReload, but
    // still pass through the browser lifecycle.
    window.addEventListener("beforeunload", captureDevReload);
  }

  // A demo can install a per-frame cinematic controller that fully owns the
  // player pose AND the camera for a scripted shot (see dev/demos/buskersCinematic.ts).
  let cineHook: ((dt: number) => void) | null = null;

  const updatePickleballGameplay = (dt: number) => pickleballController.update(dt);
  const applyPickleballPlayerPose = () => pickleballController.applyPlayerPose();
  const hidePickleballRemoteAvatars = () => pickleballController.hideClaimedRemoteAvatars();
  const sendLocalPresence = (speed = player.speed) => pickleballController.sendLocalPresence(speed);
  const sendPickleballNetwork = () => pickleballController.sendNetwork();
  const tick = (forcedDt?: number) => {
    // HMR factories are queued by Vite's socket callback and committed only at
    // this frame boundary, never halfway through simulation/render work.
    buskers.flushHotSwap();
    timer.update();
    const frameDt = forcedDt ?? Math.min(timer.getDelta(), 0.09);

    // pipeline.warmup() records covered frames asynchronously. Do not let the
    // regular animation loop touch the renderer until that exclusive work ends.
    if (lateRenderWarmupActive) {
      input.endFrame();
      return;
    }

    // gamepad first so its synthetic key codes exist for every consumer below
    input.pollPad(frameDt);

    // Behind-the-scenes overlay open: freeze the world completely — no sim, no
    // render. The canvas keeps its last frame (dimmed via CSS) so nothing
    // flickers behind the modal; the panel's own diagrams animate on their own
    // rAF, independent of this loop. Resumes cleanly the frame it's closed.
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
      if (immersive) {
        immersive = false;
        hud.setHidden(false);
        remotes.setTagsVisible(true);
        refreshPauseToggle();
      }
      setDebugUI(!diagnostics.debugOn);
    }
    // I: immersive mode — every scrap of UI goes away until pressed again
    if (input.pressed("KeyI")) {
      immersive = !immersive;
      hud.setHidden(immersive);
      remotes.setTagsVisible(!immersive);
      if (immersive) {
        debugWasOn = diagnostics.debugOn;
        setDebugUI(false);
        if (uiOpen) {
          uiOpen = false;
          hud.setFaded(true);
        }
      } else {
        setDebugUI(debugWasOn);
        hud.message("Immersive off");
      }
      refreshPauseToggle(); // the toggle hides in immersive mode
    }
    // Tab: toggle the user UI — fade panels in/out. Runs while paused too.
    if (input.pressed("Tab")) {
      uiOpen = !uiOpen;
      hud.setFaded(!uiOpen);
    }
    // M (or clicking the minimap): the full city map — players, teleports.
    // Works while paused. Esc closes it via the Escape priority stack (stays
    // unlocked); M-toggle closed re-locks so play resumes without a click.
    if (input.pressed("KeyM")) {
      const closing = minimap.expanded;
      minimap.setExpanded(!minimap.expanded);
      if (closing && !cameraMode) input.requestLock();
    }

    // One wake/sleep pass over every registered minigame site (pickleball,
    // golf, …): a contains() test per site, setAwake only on transitions.
    siteGate.update(player.position.x, player.position.z);

    // The shared court keeps advancing even while the rest of the world is
    // paused, so a remote opponent never loses the match when authority opens
    // photo/pause controls.
    const pickleballEConsumed = updatePickleballGameplay(frameDt);
    const playingPickleball = pickleballController.playing;
    applyPickleballPlayerPose();

    // Full freeze: a pause with "freeze player" armed. Everything holds — sim,
    // player, fx, vehicles — while a clean screenshot floats on top.
    dogParkAudio.setPaused(paused);
    if (paused && freezePlayer) {
      vehicleAudio.update(frameDt, null); // fade the hum out while frozen
      swimAudio.update(frameDt, null);
      // ambience keeps breathing while frozen — it's a chill/social feature
      nature.update(frameDt, {
        playerPos: player.renderPosition,
        camera,
        gust: windGustValue(),
        timeOfDay: sky.timeOfDay
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
      input.endFrame();
      pipeline.render();
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
      if (!playingPickleball && !input.suspended && player.mode === "surf" && input.pressed("KeyX")) player.requestSurfFlow();
      if (!playingPickleball && !input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();
      chase.lookDir(aim);
      let steps = 0;
      while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
        const wasSuspended = input.suspended;
        if (playingPickleball) input.suspended = true;
        player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
        input.suspended = wasSuspended;
        physics.step(physics.world.fixedTimeStep, player.position);
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
      const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
      highUp = highUp ? altitude > 110 : altitude > 150;
      tiles.update(player.position.x, player.position.z, highUp);
      // Live-player pause still allows walking. Keep the generated-building gate
      // and streaming focus current so crossing a doorway cannot leave the camera
      // stuck in the previous indoor/outdoor mode.
      citygenRing.current?.update(player.position, frameDt);
      if (cameraMode) { chase.suspend(player); orbit.update(frameDt); }
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
        timeOfDay: sky.timeOfDay
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
      input.endFrame();
      pipeline.render();
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

    // E: exit any vehicle/creature, pick up a thrown tennis ball, or on foot
    // hop into the nearest ride (a friend's passenger seat, a rideable animal,
    // or a mount you left behind)
    const teaGardenEConsumed = !pickleballEConsumed
      && input.pressed("KeyE")
      && (japaneseTeaGarden?.interact(player.position, player.mode) ?? false);
    if (
      !pickleballEConsumed &&
      !teaGardenEConsumed &&
      input.pressed("KeyE") &&
      !exitToWalk() &&
      !golf?.tryStartAtTee(player, hud) &&
      !archery?.tryInteract(player, hud, chase) &&
      !missionDolores?.tryInteract(player.position, player.mode, hud)
    ) {
      const nearOceanBeach =
        player.mode === "walk" &&
        player.position.x > OCEAN_BEACH_SURF.minX - 180 &&
        player.position.x < OCEAN_BEACH_SURF.maxX + 60 && // must be at the waterline, not inland
        player.position.z > OCEAN_BEACH_SURF.minZ - 120 &&
        player.position.z < OCEAN_BEACH_SURF.maxZ + 120;
      if (nearOceanBeach) {
        player.trySwitch("surf");
        hud.message("Paddle out (W) — carve the green face with A/D, Space off the lip!", 4);
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

    // Q: busker trio cycles to the next song in its songbook and cues it
    // 2s before the first note (no teleport)
    if (input.pressed("KeyQ")) {
      const song = buskers.cycleSong(2);
      hud.message(`♪ ${song} — playing in 2s`, 2.2);
    }

    // ".": factory reset for tweaks — every tweakpane value back to its
    // source-code default, saved tweaks wiped. Player stays put.
    if (input.pressed("Period")) {
      resetAllTweaks();
      resetCrownTweaks();
      resetBayLightsTweaks();
      resetGoldenGateLightsTweaks();
      resetSutroLightsTweaks();
      START.spawn = START_DEFAULTS.spawn;
      START.mode = START_DEFAULTS.mode;
      // re-apply the side effects the pane's onChange handlers normally push.
      renderer.toneMappingExposure = RENDER_TUNING.values.exposure;
      dynRes.syncToCap();
      CONFIG.tileLoadRadius = WORLD_TUNING.values.radius;
      CONFIG.tileUnloadRadius = WORLD_TUNING.values.radius + 400;
      setFoliageVisible(FOLIAGE_TUNING.values.visible);
      tiles.forceScan();
      sky.applyFogParams();
      sky.applyShadowParams();
      pipeline.applyPostFx(); // toggles back off + sliders back to defaults
      sky.cycleEnabled = SKY_TUNING.values.cycleEnabled;
      sky.cycleDuration = SKY_TUNING.values.cycleDuration;
      sky.nightBrightness = SKY_TUNING.values.nightBrightness;
      sky.followRealTime(); // default: back to mirroring the real SF clock
      sky.applyFogParams();
      debugPanel.syncNow();
      hud.message("Tweaks back to source defaults", 3);
    }
    if (input.pressed("KeyC")) setCameraMode(!cameraMode);
    // O: 180° orbit flip around the current look target (camera mode only)
    if (cameraMode && input.pressed("KeyO")) {
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
    const scrubHeld = input.holding("KeyZ");
    const flipping = orbitFlip !== null;
    if (cameraMode) orbit.enabled = !scrubHeld && !flipping; // don't let orbit eat the drag/wheel
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
      sky.setTimeOfDay(sky.timeOfDay + d * (1 - Math.exp(-frameDt * 10)));
      hud.message(clock12(sky.timeOfDay), 0.8);
      if (!scrubHeld && Math.abs(d) < 0.01) {
        sky.cycleEnabled = timeScrub.wasCycling;
        timeScrub = null;
      }
    }

    // fly: mouse steers the plane at frame rate; W/S throttle happens in the fixed step
    if (player.mode === "plane") player.steerFly(input, frameDt);
    // Latch hoverboard ollies at render-frame rate. On high-refresh displays a
    // frame can render without a fixed physics step, so `pressed()` would be gone
    // before #updateBoard saw it.
    if (!playingPickleball && !input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
    if (!playingPickleball && !input.suspended && player.mode === "surf" && input.pressed("KeyX")) player.requestSurfFlow();
    if (!playingPickleball && !input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();

    chase.lookDir(aim); // drone moves along the true view direction (no shot bias)
    tracer.begin("physics");
    let steps = 0;
    while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
      const wasSuspended = input.suspended;
      if (playingPickleball) input.suspended = true;
      player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
      input.suspended = wasSuspended;
      abandonedMounts.prePhysics(physics.world.fixedTimeStep);
      physics.step(physics.world.fixedTimeStep, player.position);
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
    const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
    highUp = highUp ? altitude > 110 : altitude > 150;
    // high over the city streams buildings only — no park lawns / trees uploaded.
    // turbo while the loading cover is still up (see the settle gate)
    tiles.update(player.position.x, player.position.z, highUp, !revealed);
    trafficLights?.update(player.position, performance.now() / 1000);
    streetLamps?.update(player.position);
    abandonedMounts.update(frameDt, player.position);
    creatures?.update(elapsed, camera.position); // gulls live at altitude — never gated
    forest?.update(frameDt, camera.position);
    // Night ball glow amount from the current sun elevation (park / fetch / held /
    // pickleball all read BALL_GLOW_NIGHT). Uses last sky.update's elevation —
    // fine; elevation only moves with the clock.
    syncBallGlowNight(sky.sunElevation);
    coronaHeights?.update(frameDt, elapsed, camera.position);
    // Ball fetch loop + pet follow run every frame, tool-agnostic, so a thrown
    // ball keeps bouncing and a returning/adopted dog keeps moving even after
    // switching tools. verb() keeps the HUD Click row in sync with hold-to-throw.
    const petSeat = player.mode === "scooter" && !remotes.hasPassenger(net.selfId)
      ? (player.meshes.scooter.userData.petSeat as THREE.Object3D | undefined) ?? null
      : null;
    fetchBall?.update(frameDt, elapsed, player.position, petSeat);
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
    buskers.update(frameDt, camera, windGustValue(), sky.sunElevation);
    japaneseTeaGarden?.update(frameDt, elapsed, player.renderPosition, camera);
    // MASTER foliage gate: when the "/" panel's foliage switch is OFF, every
    // vegetation group is already hidden (setFoliageVisible) — skip all its
    // per-frame work too so it costs near zero. We STILL advance the shared wind
    // envelope (cheap CPU math, no rendering) because the nature soundscape below
    // reads its gust value for wind audio.
    if (foliageOn) {
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
    }
    // Nature soundscape rides the same root vegetation gust envelope,
    // and reads the sky clock for dawn choruses / night owls. Cheap out in the
    // city (suspends), so it's safe to tick unconditionally.
    nature.update(frameDt, {
      playerPos: player.renderPosition,
      camera,
      gust: windGustValue(),
      timeOfDay: sky.timeOfDay
    });
    // live loop only: the dogs freeze during pause, so barking there would lie
    dogParkAudio.update(frameDt, player.renderPosition);
    if (embodiments.currentAnimal) forest?.setRiddenSpeed(player.speed);
    islands.update(elapsed);
    citygenRing.current?.update(player.position, frameDt);
    if (!highUp) hunt.update(frameDt, elapsed, player.position);
    golf?.update(frameDt, elapsed, { player, input, hud, chase, camera });
    // Archery: site-gated, one boolean early-return when asleep with nothing live
    archery?.update(frameDt, elapsed, { player, input, hud, chase, camera });
    // Goldman clubhouse NPCs: one-hypot early return when far — safe every frame
    goldenGateTennis?.update(frameDt, elapsed, player.position);
    // Mission Dolores museum: book proximity prompt + exhibit animation (cheap far away)
    missionDolores?.update(frameDt, elapsed, player.position, player.mode, hud);

    // "hop in" nudge when standing near a ride (friend → wildlife)
    if (player.mode === "walk" && embodiments.passengerOf === null) {
      const drv = remotes.nearestDriver(player.position, 5.5);
      const nearAnimal = drv ? null : forest?.nearest(player.position, 5);
      const nearSurfBreak =
        !drv &&
        !nearAnimal &&
        player.position.x > OCEAN_BEACH_SURF.minX - 180 &&
        player.position.x < OCEAN_BEACH_SURF.maxX + 280 &&
        player.position.z > OCEAN_BEACH_SURF.minZ - 120 &&
        player.position.z < OCEAN_BEACH_SURF.maxZ + 120;
      if ((drv || nearAnimal || nearSurfBreak) && !ridePromptShown) {
        hud.message(
          drv ? `E — ride with ${drv.name}` : nearAnimal ? `E — ride the ${nearAnimal.label}` : "E — paddle out at Ocean Beach",
          1.8
        );
        ridePromptShown = true;
      }
      if (!drv && !nearAnimal && !nearSurfBreak) ridePromptShown = false;
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
    } else if (cameraMode) {
      chase.suspend(player);
      orbit.update(frameDt);
    } else {
      chase.indoor = (citygenRing.current?.isPlayerInside() ?? false) || (missionDolores?.isPlayerInside(player.position) ?? false); // blend into the indoor eye rig
      chase.update(frameDt, player, input);
    }
    // World-anchored dialogue must project after the chase/orbit/cinematic has
    // committed this frame's final camera pose; projecting during simulation
    // left Iroh's card one camera frame behind and visibly jittering.
    japaneseTeaGarden?.project(camera);
    sky.update(elapsed, camera.position);
    water.update(elapsed, camera.position, player.renderPosition);
    oceanBeachWaves.update(elapsed, player.renderPosition);
    underwater.update(camera, elapsed);
    seaPillars.update(player.renderPosition, elapsed);
    fx.update(frameDt);
    bubbles.update(frameDt, elapsed);
    wake.update(frameDt, elapsed, player);
    boardWake.update(frameDt, elapsed, player);
    birdTrails.update(elapsed, player);
    splashes.update(frameDt, elapsed, player);
    surfExperience.update(frameDt, player.mode, player.surfTelemetry);
    if (player.mode === "surf" && player.surfTelemetry.splashSerial !== surfSplashSerial) {
      surfSplashSerial = player.surfTelemetry.splashSerial;
      splashes.splash(
        player.renderPosition.x,
        waterHeight(player.renderPosition.x, player.renderPosition.z, elapsed),
        player.renderPosition.z,
        elapsed,
        player.surfTelemetry.splashEnergy
      );
    }
    updateSurfPresentation(frameDt);
    waveAudio.update(frameDt, oceanWaveEnergyAt(map, player.position.x, player.position.z, elapsed));
    // Ride ends on the sand: stand up, board in hand (you can only surf in the water).
    if (player.mode === "surf" && player.surfTelemetry.beached) {
      player.trySwitch("walk");
      hud.message("Back on the beach — E to paddle out again", 2.4);
    }
    // On foot at Ocean Beach you carry your board, ready to paddle out.
    player.setCarryingBoard(
      player.mode === "walk" &&
        player.position.x > OCEAN_BEACH_SURF.minX - 40 &&
        player.position.x < OCEAN_BEACH_SURF.maxX + 110 &&
        player.position.z > OCEAN_BEACH_SURF.minZ - 60 &&
        player.position.z < OCEAN_BEACH_SURF.maxZ + 60
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
        !cameraMode &&
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

    // Revisit every retained AA/post-FX variant once the deferred world has
    // stopped adding meshes. The timeout keeps the existing 15 s reveal escape
    // hatch useful if a background job never becomes completely idle.
    const settleBacklog = Math.max(0, scheduler.pending - scheduler.waiting);
    const deferredWorldIdle = settleBacklog === 0 && tiles.busy === 0 && auxPending === 0;
    const lateWarmupTimedOut = performance.now() - lateRenderWarmupRequestedAt > 12000;
    if (
      deferredModulesSettled &&
      !modulesReady &&
      (deferredWorldIdle || lateWarmupTimedOut)
    ) {
      lateRenderWarmupActive = true;
      progress(Math.max(settlePct, 99), "warming render paths");
      tracer.end("sched");
      input.endFrame();
      void pipeline.warmup("boot")
        .catch((err) => console.warn("[sf] deferred render warmup failed:", err))
        .finally(() => {
          lateRenderWarmupActive = false;
          modulesReady = true;
        });
      return;
    }
    settleTick();
    tracer.end("sched");

    input.endFrame();
    tracer.begin("render");
    pipeline.render();
    tracer.end("render");
    diagnostics.updateStats();
  };
  const frameDriver = startFrameDriver({
    renderer,
    camera,
    app,
    tick,
    dynamicResolution: dynRes,
    tracer,
    isRevealed: () => revealed
  });
  // Deterministic capture stops the wall-clock loop so tools can drive tick(dt).
  (window as never as { __sfManual: (on: boolean) => void }).__sfManual = frameDriver.setManual;

  // Dev-only free camera for headless render probes: locks the camera to a fixed
  // eye→target via the cine hook (owns pose+camera, so chase can't fight it).
  // Pass null to release back to the chase camera.
  if (import.meta.env.DEV) {
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

  const exposeDebugHooks = () => {
    Object.assign(window as never, {
      // renderIdle: probes MUST wait for this before capture phases — while the
      // deferred render warmup runs, tick() early-returns without rendering, so
      // screenshots would capture a stale boot-pose frame no matter what the
      // camera was set to.
      __sf: { scene, camera, player, tiles, physics, renderer, pipeline, dynRes, tracer, scheduler, POSTFX_TUNING, WORLD_TUNING, FLOWER_TUNING, RENDER_TUNING, chase, map, input, hud, fx, fireworks, graffiti, bubbles, setTool, setColor, sky, debugPanel, CONFIG, THREE, tick, creatures, forest, garden, wildlands, goldenGateTennis, japaneseTeaGarden, pickleball: pickleballController.game, pickleballAmbient: pickleballController.ambient, pickleballAudio: pickleballController.audio, pickleballUI: pickleballController.ui, pickleballController, coronaHeights, missionDolores, splashes, vehicleAudio, swimAudio, nature, dogParkAudio, net, remotes, voice, minimap, playerLocator, boardWake, abandonedMounts, paintballs, paintSkins, hunt, satchel, buildShareUrl, tutorial, fetchBall, goldenGateLights, teleportToTarget, trafficLights, streetLamps, citygen, citygenRing, worldCursor, worldQueries, buildingRayRefiner, underwater, seaPillars, water, oceanBeachWaves, surfExperience, roadMarkings, colliderDebug, calibrationChart, FOLIAGE_TUNING, CITYGEN_TUNING, setFoliageVisible, buskers, boardSelector, ensureSurfboardCustomizer, getSurfboardConfig: () => ({ ...surfboardConfig }), siteGate,
        TSL,
        renderIdle: () => modulesReady && !lateRenderWarmupActive }
    });
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
      fetchBall: fetchBall ?? undefined,
      coronaHeights: coronaHeights ?? undefined,
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
    (window as never as { __demo: (n: string) => void }).__demo = (n: string) => {
      void import("./dev/demo").then(({ runDemo }) => runDemo(n, demoCtx));
    };
    const demo = new URLSearchParams(location.search).get("demo");
    if (demo) {
      const { runDemo } = await import("./dev/demo");
      runDemo(demo, demoCtx);
    }
  }
}

boot().catch((err) => {
  console.error("[boot] fatal:", err);
  bootScreen.fail(err);
});
