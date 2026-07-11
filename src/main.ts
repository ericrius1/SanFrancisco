import * as THREE from "three/webgpu";
import { Inspector } from "three/addons/inspector/Inspector.js";
import Stats from "three/addons/libs/stats.module.js";
import CameraControls from "camera-controls";
import { CAMERA_TUNING, CONFIG, FLOWER_TUNING, FOLIAGE_TUNING, RENDER_MODE, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING } from "./config";
import { loadPlayerState, resetAllTweaks, savePlayerState } from "./core/persist";
import { Input } from "./core/input";
import { tracer } from "./core/hitchTracer";
import { bootMarkStart, bootMark, bootMarkSummary, persistBootHistory } from "./core/bootMarks";
import { createFrameScheduler } from "./core/frameBudget";
import { applyBundleOrderPatch } from "./render/bundleOrderPatch";
import { WorldMap, waterHeight } from "./world/heightmap";
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
import { createGoldenGateTennisSite, GOLDMAN_SUPPRESSED_BUILDINGS, inGoldmanTennisSite } from "./world/goldenGateTennis";
import { CoronaHeightsPark, prepareCoronaHeightsGround } from "./world/coronaHeights";
import { createBuskerTrio } from "./gameplay/buskers";
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
import { Toolbar, TOOL_ORDER, TOOL_VERB, type ToolName } from "./ui/toolbar";
import { AvatarSelector } from "./ui/avatarSelector";
import { BoardSelector } from "./ui/boardSelector";
import { AudioControls } from "./ui/audioControls";
import { Chat } from "./ui/chat";
import { VehicleAudio } from "./fx/vehicleAudio";
import { SwimAudio } from "./fx/swimAudio";
import { createNatureSoundscape, DogParkAudio } from "./audio";
import { AbandonedMounts } from "./gameplay/abandonedMounts";
import { RocketRiders, type LauncherRig } from "./gameplay/launchers";
import type { Creatures } from "./gameplay/creatures";
import type { Forest, AnimalKind } from "./gameplay/forest";
import type { GrassDisplacer } from "./world/garden";
import { BOTANICAL_GARDEN_BOUNDS } from "./world/garden/layout";
import type { CityGenRing, ColliderBox } from "./world/citygen";
import { Islands } from "./gameplay/islands";
import { Hunt } from "./gameplay/hunt";
import { FetchBall } from "./gameplay/fetchBall";
import {
  createPickleball,
  PICKLEBALL_TUNING,
  type PickleballInputIntent,
  type PickleballLocalPose,
  type PickleballSide
} from "./gameplay/pickleball";
import { Satchel } from "./ui/satchel";
import { HUD } from "./ui/hud";
import { ShareButton } from "./ui/share";
import { PauseToggle } from "./ui/pauseToggle";
// BehindTheScenes is deferred (dynamic import after start is ready)
import { parseReadLink, openReadLink } from "./ui/deepLinks";
import { Tutorial } from "./ui/tutorial";
import { createRenderPipeline } from "./render/pipeline";
import { createDynamicResolution } from "./render/dynamicRes";
import { POSTFX_TUNING } from "./render/postfx";
import { DebugPanel } from "./ui/debug";
import { ColliderDebug, type DebugBox } from "./ui/colliderDebug";
import { CalibrationChart } from "./ui/calibrationChart";
import { Net, makeFunName, hasChosenName, pickName } from "./net/net";
import { RemotePlayers } from "./net/remotes";
import { Voice } from "./net/voice";
import { Minimap } from "./ui/minimap";
import { PlayerLocator } from "./ui/playerLocator";
import { avatarFromSeed, loadSavedAvatar, randomAvatarTraits, saveAvatarTraits } from "./player/avatar";
import { boardFromSeed, boardVisualKey, loadSavedBoard, randomBoardConfig, saveBoardConfig, setLocalBoardConfig } from "./vehicles/board";
import { MENU_MODES, ModeDiscovery, ALL_MODES } from "./player/discovery";

CameraControls.install({ THREE });

const app = document.getElementById("app")!;
const loading = document.getElementById("loading")!;
const loadingLabel = document.querySelector<HTMLElement>("[data-loading-label]")!;
const loadingBar = document.querySelector<HTMLElement>("[data-loading-bar]")!;
const startForm = document.querySelector<HTMLFormElement>("[data-start-form]")!;
const nameInput = document.querySelector<HTMLInputElement>("[data-name-input]")!;
const startButton = startForm.querySelector<HTMLButtonElement>("button")!;
const suggestedName = makeFunName();
let startReady = false;
let startGame: ((typedName: string, opts?: { lock?: boolean }) => void) | null = null;

function focusNameInput() {
  nameInput.focus({ preventScroll: true });
  nameInput.select();
}

nameInput.value = suggestedName;
startButton.disabled = true;
requestAnimationFrame(focusNameInput);

function submitStart() {
  if (!startReady || !startGame || startButton.disabled) {
    focusNameInput();
    return;
  }
  startGame(nameInput.value.trim());
}

startForm.addEventListener("submit", (e) => {
  e.preventDefault();
  submitStart();
});

window.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.repeat || loading.classList.contains("done")) return;
  const t = e.target;
  if (t === startButton) return; // native click/submit handles this
  if (t instanceof HTMLTextAreaElement) return;
  if (t instanceof HTMLInputElement && t !== nameInput) return;
  e.preventDefault();
  submitStart();
});

function progress(pct: number, label: string) {
  loadingBar.style.width = `${pct}%`;
  loadingLabel.textContent = label;
}

async function boot() {
  const bootT0 = performance.now();
  bootMarkStart();
  progress(8, "reading the map");
  const map = await WorldMap.load();
  prepareCoronaHeightsGround(map);
  bootMark("map");

  progress(18, "waking the gpu");
  // reversed-z: near 0.3 / far 24000 leaves classic depth with sub-metre steps
  // beyond a kilometre, so distant near-coplanar facades shimmer. Reversed float
  // depth keeps precision effectively uniform out to the far plane.
  // antialias stays OFF at the canvas: every pixel routes through the post
  // pipeline, whose scene pass can switch between one sample and 4x MSAA.
  // Multisampling the canvas would only resolve the final fullscreen quad.
  const renderer = new THREE.WebGPURenderer({ antialias: false, reversedDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_MODE.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER_TUNING.values.exposure; // anchored at 1.0; the DAY grade lives in sky.ts (sunDay/hemiDay)
  renderer.shadowMap.enabled = true; // universal render mode: CSM shadows always on (see world/sky.ts)
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);
  await renderer.init();
  // tiles are BundleGroups; stock r185 draws bundles AFTER transparency and
  // eats every non-depth-writing effect (fireworks/lamp pools/paintball glows)
  applyBundleOrderPatch(renderer);
  bootMark("gpu");

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    CONFIG.camera.fov,
    window.innerWidth / window.innerHeight,
    CONFIG.camera.near,
    CONFIG.camera.far
  );

  const sky = new Sky(scene);
  const water = new Water(scene, map);
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

  // left-click toys — the toolbar swaps between them (arrow keys while UI is open)
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

  // Where a fresh session begins. Code spawns (src/world/spawnPoints.ts) win
  // over the baked meta.json table so a location can declare which heavy foliage
  // regions it needs before reveal; default is the Corona Heights summit. Falls
  // back to the baked spawn, then Golden Gate. Nudged onto open ground — never
  // under (or inside) a building. (Resume/invite paths override this entirely.)
  const spawnPoint = resolveSpawnPoint(START.spawn) ?? resolveSpawnPoint(START_DEFAULTS.spawn);
  const startAt = spawnPoint ?? map.meta.spawns[START.spawn] ?? map.meta.spawns[START_DEFAULTS.spawn];
  // Per-session scatter: every fresh session lands a stride or two off the
  // registered point, so two players (or two tabs) never boot into the exact
  // same spot — co-located avatars interpenetrate and read as z-fighting.
  // findOpenSpawn validates the scattered point like any other candidate.
  const scatterA = Math.random() * Math.PI * 2;
  const scatterR = 0.8 + Math.random() * 1.6;
  const spawn = await findOpenSpawn(map, tiles.manifest, {
    ...startAt,
    x: startAt.x + Math.cos(scatterA) * scatterR,
    z: startAt.z + Math.sin(scatterA) * scatterR
  });
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
  vehicleAudio.setBoardStyle(boardConfig);
  const player = new Player(physics, map, scene, spawn, avatarTraits, boardConfig);
  const birdTrails = new BirdTrails(scene, player.meshes.bird);
  const droneFireworkMounts = player.meshes.drone.userData.fireworkMounts as THREE.Object3D[] | undefined;
  const boatLaunchers = player.meshes.speedboat.userData.launcherRig as LauncherRig | undefined;
  const startMode = spawnPoint?.mode ?? START.mode;
  if (startMode !== "walk" && ALL_MODES.includes(startMode)) player.trySwitch(startMode);
  player.onModeChange = (mode) => {
    const fresh = modeDiscovery.discover(mode);
    hud.setMode(mode);
    toolbar.setVehicle(mode);
    input.setMode(mode); // trigger routing (fly puts them on the ↑/↓ throttle)
    debugPanel.setMode(mode); // tuning pane shows only the active mode's movement folder
    if (fresh) {
      const msg = modeDiscovery.revealMessage(mode);
      if (msg) hud.message(msg, 2.8);
    }
  };
  input.setMode(player.mode);
  toolbar.setVehicle(player.mode);
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
  let cameraMode = false;
  const rocketRiders = new RocketRiders(scene, map);
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
    update: (dt: number, pos: THREE.Vector3, d: GrassDisplacer[]) => void;
  } | null = null;
  let wildlands: {
    groups: THREE.Group[];
    ready: Promise<void>;
    flowers: { refresh: () => void };
    grass: { refresh: () => void };
    update: (pos: THREE.Vector3, cam: THREE.Vector3) => void;
  } | null = null;
  let goldenGateTennis: ReturnType<typeof createGoldenGateTennisSite> | null = null;
  let pickleball: ReturnType<typeof createPickleball> | null = null;
  let pickleballSiteAwake = false;
  let coronaHeights: CoronaHeightsPark | null = null;
  let windGustValue: (() => number) | null = null;
  let advanceWind: ((dt: number) => void) | null = null;
  const gardenDisplacer: GrassDisplacer = { x: 0, z: 0, radius: 1.6, strength: 1 };
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
    coronaHeights?.setFoliageVisible(visible);
  };
  const islands = new Islands(physics, map, scene);

  // Decoupled world-query service: every "what does this ray hit" caller (paint,
  // the in-world cursor, future systems) goes through here. Backed by box3d's
  // broadphase cast over a dedicated query world of entity proxies, raced against
  // the static-world caster.
  const worldQueries = new WorldQueries(physics);

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
    goldenGateTennis = createGoldenGateTennisSite(map, { physics }).addTo(scene);
    goldenGateTennis.setFoliageVisible(foliageOn);
  } catch (err) {
    for (const building of GOLDMAN_SUPPRESSED_BUILDINGS) {
      tiles.unsuppressBuildingMesh(building.key, building.index);
    }
    console.warn("[boot] Goldman Tennis Center unavailable:", err);
  }
  try {
    const anchor = goldenGateTennis?.gameplayAnchor;
    if (anchor) {
      pickleball = createPickleball({
        origin: { x: anchor.x, y: anchor.y, z: anchor.z },
        yaw: anchor.yaw,
        authoritative: true,
        seed: 1402
      });
      scene.add(pickleball.root);
      pickleball.onEvent = (event) => {
        if (event.kind === "paddle") {
          fx.impactPuff(event.worldPosition);
        } else if (event.kind === "point") {
          const score = `${event.score[0]}–${event.score[1]}`;
          const result = event.scoringSide === null ? "side out" : "point";
          hud.message(`${event.winner === 0 ? "Near" : "Far"} side ${result} · ${score}`, 2.2);
        } else if (event.kind === "game") {
          hud.message(`${event.winner === 0 ? "Near" : "Far"} side wins · ${event.score[0]}–${event.score[1]}`, 4);
        }
      };
      // Sleep until the player is near Goldman tennis/pickleball — otherwise the
      // ambient AI match scores and HUD-spams from across the city.
      const nearCourts = inGoldmanTennisSite(player.position.x, player.position.z, PICKLEBALL_TUNING.activateSitePad);
      pickleball.setActive(nearCourts);
      pickleballSiteAwake = nearCourts;
    }
  } catch (err) {
    console.warn("[boot] pickleball game unavailable:", err);
  }
  try {
    coronaHeights = new CoronaHeightsPark(map, physics);
    coronaHeights.setFoliageVisible(foliageOn);
    scene.add(coronaHeights.group);
  } catch (err) {
    console.warn("[boot] corona heights unavailable:", err);
  }
  // Fetch-the-ball loop: hold-to-throw (ball appears only while winding up;
  // hands empty after release). Walk up and press E to pick one up, or take it
  // from a waiting dog. A free dog in the Corona Heights park chases park
  // throws, carries back and waits — two full fetches adopt it as a pet. Free
  // balls, in-flight fetch and pet follow are driven every frame by
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
  // Busker trio right on the Corona Heights summit crown (the flat top the
  // player stands on) so a 360 orbit clears the hill on every side and takes in
  // Sutro, Buena Vista and the whole city. Same ESE facing. Grounds to
  // groundTop — the LIFTED, walkable summit surface (the platform lift lives in
  // groundTops, not the raw heightfield) — so the perch sits on top, not sunk
  // into it. The module is placeless; move it with setPlacement (re-grounds).
  const buskers = createBuskerTrio({
    x: 412,
    z: 2760, // summit platform centre — the crown
    yaw: -1.72, // unchanged facing (ESE) over downtown / the Mission
    groundHeight: (x, z) => map.groundTop(x, z),
    physics
  });
  scene.add(buskers.group);
  let currentAnimal: AnimalKind | null = null;
  let ridePromptShown = false;
  let doorPromptShown = false;
  let doorScanCountdown = 0;
  let doorScanHit: ReturnType<CityGenRing["nearestDoor"]> = null;
  // way high above the ground (plane/drone cruising), ground flora and critters
  // are subpixel — their systems pause. Hysteresis so hill flanks don't flicker it.
  let highUp = false;

  const chase = new ChaseCamera(camera, map);
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
  let orbitFlip: { t: number; duration: number; startAz: number; delta: number } | null = null;

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
      hud.message("Camera mode — drag to orbit, O for 180°, C to return", 3);
    } else {
      orbitFlip = null;
      hud.message("");
      input.requestLock();
    }
  };

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
  // drawing-buffer pixel ratio between RENDER_MODE.minPixelRatio and the boot
  // ceiling — min(devicePixelRatio, RENDER_MODE.pixelRatioCap) — to hold the
  // frame budget on weaker GPUs. The apply path is exactly what boot + resize
  // do (setPixelRatio + setSize); the WebGPU pass targets re-derive from the
  // drawing-buffer on the next render, so nothing else needs a resize hook.
  // Starts at the ceiling boot already applied above.
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
  const net = new Net(suggestedName, savedAvatar ?? undefined, savedBoard ?? undefined);
  let pendingPickleballClaim: PickleballSide | null = null;
  let pendingPickleballRelease: PickleballSide | null = null;
  let pickleballNetSendAt = 0;
  let pickleballSwingQueued = false;
  let pickleballPromptSide: PickleballSide | null = null;
  let pickleballInput: PickleballInputIntent = {};
  let pickleballLocalPose: PickleballLocalPose | null = null;
  const pickleballUp = new THREE.Vector3(0, 1, 0);
  const pickleballNetPosition = new THREE.Vector3();
  const pickleballNetQuaternion = new THREE.Quaternion();
  const pickleballOwnerName = (id: number): string | null => {
    if (!id) return null;
    if (id === net.selfId) return net.name;
    return net.roster.get(id)?.name ?? `Player ${id}`;
  };
  const syncPickleballSlots = (slots: readonly [number, number] = net.pickleballSlots, authorityId = net.pickleballAuthority) => {
    if (!pickleball) return;
    pickleball.setSlotOwner(0, pickleballOwnerName(slots[0]));
    pickleball.setSlotOwner(1, pickleballOwnerName(slots[1]));
    // With no human claimant, every browser may run the same ambient AI rally.
    // Once a slot is claimed, only the relay-selected client advances physics.
    pickleball.setAuthoritative(authorityId === 0 || authorityId === net.selfId);
  };
  const enterPickleballSide = (side: PickleballSide): boolean => {
    if (!pickleball) return false;
    exitToWalk();
    if (!pickleball.enterSide(side, net.name)) return false;
    player.setExternalEmbodimentHidden(true);
    return true;
  };
  const finishPickleballExit = (side: PickleballSide) => {
    if (!pickleball) return;
    const pose = pickleballLocalPose;
    pickleball.exitSide(side);
    pickleballLocalPose = null;
    if (pose) {
      player.restoreState({
        mode: "walk",
        x: pose.worldPosition.x,
        y: pose.worldPosition.y + 0.58,
        z: pose.worldPosition.z,
        heading: pose.worldHeading + Math.PI
      });
      chase.yaw = pose.worldHeading;
    }
    player.setExternalEmbodimentHidden(false);
  };
  const requestPickleballSide = (side: PickleballSide) => {
    if (!pickleball || pendingPickleballClaim !== null || pickleball.localSide !== null) return;
    if (net.status === "online" && net.selfId) {
      pendingPickleballClaim = side;
      net.claimPickleball(side);
      hud.message("Claiming pickleball side…", 1.4);
    } else if (enterPickleballSide(side)) {
      hud.message("You’re playing · WASD move · click/Space swings · E leaves", 3.4);
    }
  };
  const releasePickleballSide = (): boolean => {
    const side = pickleball?.localSide;
    if (side === null || side === undefined || !pickleball) return false;
    if (net.status === "online" && net.selfId && net.pickleballSlots[side] === net.selfId) {
      if (pendingPickleballRelease === null) {
        pendingPickleballRelease = side;
        net.releasePickleball(side);
      }
    } else {
      finishPickleballExit(side);
      hud.message("Back to exploring", 1.8);
    }
    return true;
  };
  const releasePickleballForNavigation = (): boolean => {
    const side = pickleball?.localSide;
    if (side === null || side === undefined || !pickleball) return false;
    if (net.status === "online" && net.selfId && net.pickleballSlots[side] === net.selfId) {
      pendingPickleballRelease = side;
      net.releasePickleball(side);
    }
    // Navigation is immediate locally; the relay acknowledgement only frees
    // the server slot and must not pull a respawn/teleport back to the court.
    finishPickleballExit(side);
    return true;
  };
  net.onPickleballSlots = (slots, authorityId) => syncPickleballSlots(slots, authorityId);
  net.onPickleballClaim = (side, ownerId, ok) => {
    if (ok && ownerId === net.selfId) {
      pendingPickleballClaim = null;
      enterPickleballSide(side);
      hud.message("You’re playing · WASD move · click/Space swings · E leaves", 3.4);
    } else if (!ok && pendingPickleballClaim === side) {
      pendingPickleballClaim = null;
      if (pickleball?.localSide === side) finishPickleballExit(side);
      hud.message(`${pickleballOwnerName(ownerId) ?? "Another player"} already has that side`, 2.6);
    }
  };
  net.onPickleballRelease = (side, ownerId, ok) => {
    if (ok && (ownerId === net.selfId || pendingPickleballRelease === side)) {
      pendingPickleballRelease = null;
      finishPickleballExit(side);
      hud.message("Back to exploring", 1.8);
    } else if (!ok && pendingPickleballRelease === side) {
      pendingPickleballRelease = null;
    }
  };
  net.onPickleballState = (ownerId, state) => {
    if (ownerId !== net.selfId && pickleball?.active) pickleball.applyState(state);
  };
  net.onPickleballInput = (side, _ownerId, d) => {
    if (!pickleball?.active) return;
    pickleball.setRemoteInput(side, {
      moveX: d[0] ?? 0,
      moveZ: d[1] ?? 0,
      swing: (d[2] ?? 0) > 0.5,
      sprint: (d[3] ?? 0) > 0.5,
      aimX: d[4] ?? 0,
      aimZ: d[5] ?? 0
    });
  };
  syncPickleballSlots();
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
    golf?.syncNetState();
    net.replayGolf();
    syncPickleballSlots();
    net.replayPickleball();
    // An offline takeover remains playable. On reconnect, ask the relay to
    // reserve that same side; a conflicting owner will reject it cleanly.
    if (pickleball?.localSide !== null && pickleball?.localSide !== undefined) {
      pendingPickleballClaim = pickleball.localSide;
      net.claimPickleball(pickleball.localSide);
    }
  };
  const remotes = new RemotePlayers(scene);
  const syncRoster = () => {
    for (const info of net.roster.values()) {
      const existing = remotes.avatars.get(info.id);
      if (!existing) remotes.add(info);
      else {
        if (existing.info.name !== info.name) remotes.rename(info);
        remotes.updateAvatar(info);
        remotes.updateBoard(info);
      }
    }
    syncPickleballSlots();
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
  // passenger seat support: remotes resolves "riding MY car" through this
  remotes.localDriveMesh = () => (player.mode === "drive" && !player.riding ? player.meshes.drive : null);

  // riding shotgun in a friend's car (remote player id). Pose glue runs each
  // frame; every mode change, respawn or teleport goes through leaveRide first.
  let passengerOf: number | null = null;
  const ridePos = new THREE.Vector3();
  const rideQuat = new THREE.Quaternion();
  const leaveRide = () => {
    if (passengerOf === null) return;
    passengerOf = null;
    player.endRide();
  };

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
      pendingPickleballClaim = null;
      pendingPickleballRelease = null;
      syncPickleballSlots();
      // Offline stays silent: the local AI match keeps working and Net retries.
    }
  };

  // Name gate is wired at module startup so typing works during loading; this
  // callback is attached once the game objects it needs exist.
  startGame = (typedName, opts) => {
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
  };

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
  const playerLocator = new PlayerLocator();
  type ReleaseMotion = {
    linear: [number, number, number];
    angular: [number, number, number];
    speed: number;
    horizontalSpeed: number;
  };
  const readPlayerMotion = (): ReleaseMotion => {
    let linear: [number, number, number] = [player.velocity.x, player.velocity.y, player.velocity.z];
    let angular: [number, number, number] = [0, 0, 0];
    if (player.body) {
      const v = physics.world.getBodyVelocity(player.body);
      linear = [v.linear[0], v.linear[1], v.linear[2]];
      angular = [v.angular[0], v.angular[1], v.angular[2]];
    }
    return {
      linear,
      angular,
      speed: Math.hypot(linear[0], linear[1], linear[2]),
      horizontalSpeed: Math.hypot(linear[0], linear[2])
    };
  };
  const exitClearance = (mode: PlayerMode) => {
    if (mode === "drive" && currentAnimal) return currentAnimal === "bear" ? 3.0 : 2.4;
    if (mode === "plane" || mode === "boat") return 6.5;
    if (mode === "drone" || mode === "board") return 2.8;
    if (mode === "bird") return 6.5;
    return 2.4;
  };
  const dropCurrentDriveMount = (motion = readPlayerMotion()) => {
    let dropped = false;
    if (currentAnimal && forest) {
      const mount = player.meshes.drive.position;
      forest.dropAnimal(currentAnimal, mount.x, mount.z, player.heading - Math.PI, { speed: motion.horizontalSpeed });
      currentAnimal = null;
      player.setDriveStyle(null);
      dropped = true;
    }
    return dropped;
  };
  /** E (or pad B): leave any vehicle, creature, or passenger seat for on-foot. */
  const exitToWalk = () => {
    if (passengerOf !== null) {
      passengerOf = null;
      player.position.x += Math.cos(player.heading) * 2.4;
      player.position.z -= Math.sin(player.heading) * 2.4;
      player.endRide();
      hud.message("Hopped out", 1.8);
      return true;
    }
    if (player.mode === "walk") return false;
    const exitMode = player.mode;
    const clearance = exitClearance(exitMode);
    const motion = readPlayerMotion();
    const handedToWorld = dropCurrentDriveMount(motion);
    if (!handedToWorld) {
      const mount = player.meshes[exitMode];
      abandonedMounts.spawn(exitMode, {
        position: mount.position,
        quaternion: mount.quaternion,
        linear: motion.linear,
        angular: motion.angular
      });
    }
    if (exitMode === "boat" || exitMode === "speedboat") {
      // step off the gunwale into the water — stay beside the hull so you can swim back on
      const side = 2.2;
      player.position.x += Math.sin(player.heading) * side;
      player.position.z += Math.cos(player.heading) * side;
      const wy = waterHeight(player.position.x, player.position.z, player.time);
      player.position.y = wy + 0.45;
      if (motion.speed > 0.5) {
        player.position.x += (motion.linear[0] / motion.speed) * 0.35;
        player.position.z += (motion.linear[2] / motion.speed) * 0.35;
      }
      player.swimEnter = true;
    } else {
      player.position.x += Math.cos(player.heading) * clearance;
      player.position.z -= Math.sin(player.heading) * clearance;
      if (motion.speed > 0.5) {
        player.position.x += (motion.linear[0] / motion.speed) * 0.35;
        player.position.z += (motion.linear[2] / motion.speed) * 0.35;
      }
    }
    player.trySwitch("walk");
    hud.message("Hopped out", 1.8);
    return true;
  };
  type PlaceHistoryEntry = { x: number; y: number; z: number; heading: number; mode: PlayerMode; label: string };
  const PLACE_HISTORY_LIMIT = 32;
  let placeHistory: PlaceHistoryEntry[] = [];
  let placeHistoryIndex = -1;
  const capturePlace = (label: string): PlaceHistoryEntry => ({
    x: player.position.x,
    y: player.position.y,
    z: player.position.z,
    heading: player.heading,
    mode: player.mode,
    label
  });
  const samePlace = (a: PlaceHistoryEntry, b: PlaceHistoryEntry) =>
    a.mode === b.mode &&
    Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 0.5 &&
    Math.abs(Math.atan2(Math.sin(a.heading - b.heading), Math.cos(a.heading - b.heading))) < 0.05;
  const updatePlaceHistoryHud = () => {
    hud.setTeleportHistory(placeHistoryIndex > 0, placeHistoryIndex >= 0 && placeHistoryIndex < placeHistory.length - 1);
  };
  const beginPlaceNavigation = (label: string) => {
    const current = capturePlace(label);
    if (placeHistoryIndex < 0) {
      placeHistory = [current];
      placeHistoryIndex = 0;
    } else {
      placeHistory[placeHistoryIndex] = current;
      placeHistory = placeHistory.slice(0, placeHistoryIndex + 1);
    }
    updatePlaceHistoryHud();
  };
  const finishPlaceNavigation = (label: string) => {
    const next = capturePlace(label);
    if (placeHistoryIndex >= 0 && samePlace(placeHistory[placeHistoryIndex], next)) {
      placeHistory[placeHistoryIndex] = next;
      updatePlaceHistoryHud();
      return;
    }
    placeHistory = placeHistory.slice(0, placeHistoryIndex + 1);
    placeHistory.push(next);
    if (placeHistory.length > PLACE_HISTORY_LIMIT) {
      placeHistory.shift();
    } else {
      placeHistoryIndex++;
    }
    placeHistoryIndex = placeHistory.length - 1;
    updatePlaceHistoryHud();
  };
  const applyPlaceHistory = (step: -1 | 1) => {
    const nextIndex = placeHistoryIndex + step;
    if (nextIndex < 0 || nextIndex >= placeHistory.length) {
      hud.message(step < 0 ? "No earlier place" : "No later place", 1.8);
      updatePlaceHistoryHud();
      return;
    }
    releasePickleballForNavigation();
    if (placeHistoryIndex >= 0) placeHistory[placeHistoryIndex] = capturePlace(placeHistory[placeHistoryIndex].label);
    const spot = placeHistory[nextIndex];
    exitToWalk();
    if (spot.mode === "drive") player.setDriveStyle(null);
    if (spot.mode === "drone") player.clearDroneStyle();
    player.restoreState({ mode: spot.mode, x: spot.x, y: spot.y, z: spot.z, heading: spot.heading });
    chase.yaw = spot.heading + Math.PI;
    placeHistoryIndex = nextIndex;
    updatePlaceHistoryHud();
    hud.message(spot.label, 2.2);
  };
  const switchMode = (mode: PlayerMode) => {
    if (mode === player.mode) return;
    releasePickleballForNavigation();
    // Switching to walk = hop off wherever you are, same as pressing E
    // (steps off the gunwale into the water when leaving a boat, etc.)
    if (mode === "walk") {
      exitToWalk();
      return;
    }
    leaveRide(); // a mode key while riding shotgun hops out first
    if (currentAnimal && mode !== "drive" && mode !== "drone") dropCurrentDriveMount();
    if (mode === "drive" && !currentAnimal) player.setDriveStyle(null);
    if (mode === "drone") player.clearDroneStyle();
    // Stay put: spawn the new embodiment underfoot. (Boats still hop to the
    // nearest navigable water via enter(); parked mounts are reclaimed with E.)
    player.trySwitch(mode);
  };
  switchModeFromToolbar = switchMode;
  hud.onHistoryBack = () => applyPlaceHistory(-1);
  hud.onHistoryForward = () => applyPlaceHistory(1);
  const teleportToTarget = (x: number, z: number, toName?: string, playerId?: number) => {
    releasePickleballForNavigation();
    void (async () => {
      const t = playerId !== undefined ? remotes.stateOf(playerId) : null;
      if (playerId !== undefined && !t) {
        hud.message(`${toName ?? "Player"} is no longer available`, 2.2);
        return;
      }
      beginPlaceNavigation("Previous place");
      leaveRide();
      const tx = t?.x ?? x;
      const tz = t?.z ?? z;
      // land a couple of metres off the target so you don't spawn inside them
      const dx = tx - player.position.x;
      const dz = tz - player.position.z;
      const d = Math.hypot(dx, dz) || 1;
      const back = t ? Math.min(3, d) : 0;
      // raw facing yaw: forward(θ) = (−sinθ, −cosθ) in xz, so face (dx,dz) ⇒ θ = atan2(−dx, −dz)
      const heading = Math.atan2(-dx, -dz);
      // player target: arrive at THEIR altitude in THEIR mode, so a walker
      // jumping to a flyer comes out flying alongside instead of losing them
      if (t) {
        if (t.mode !== "drive") dropCurrentDriveMount();
        player.teleportTo({ x: tx - (dx / d) * back, y: t.y, z: tz - (dz / d) * back, facing: heading, mode: t.mode });
      } else {
        const want = { x: tx, z: tz, heading };
        const open = await findOpenSpawn(map, tiles.manifest, want);
        const faceDx = tx - open.x;
        const faceDz = tz - open.z;
        const faceHeading = Math.hypot(faceDx, faceDz) > 0.5 ? Math.atan2(-faceDx, -faceDz) : open.heading;
        player.respawn({ x: open.x, z: open.z, heading: faceHeading });
      }
      finishPlaceNavigation(toName ?? "Teleported place");
      hud.message(toName ? `Teleported to ${toName}` : "Teleported", 2.4);
      tutorial.note("teleport"); // map/teleport chapter listens for this
    })();
  };
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
      const t = e.target;
      // Debug search / other fields keep their own Esc behavior.
      if (
        (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) &&
        !chat.focused
      ) {
        return;
      }
      // Esc ALWAYS frees the mouse, whatever else it also dismisses below.
      // releaseLock is unconditional and cancels any in-flight relock grant.
      input.releaseLock();
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
    // toggle the heavy three.js Inspector on/off; returns its new on-state so the
    // pane button can relabel. Defined below the pane, but only ever runs on click.
    () => {
      setInspector(!inspectorOn);
      return inspectorOn;
    }
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

  // resume last session: position, heading and vehicle survive a refresh
  // (after the debug panel exists — restoreState can fire onModeChange).
  // An invite link wins over the saved session — the click's intent is explicit.
  const resumed = invite ? null : loadPlayerState();
  if (resumed) {
    player.restoreState(resumed);
    modeDiscovery.discover(resumed.mode);
    chase.yaw = resumed.heading + Math.PI;
    camera.position.set(resumed.x + 20, resumed.y + 30, resumed.z + 20);
    if (import.meta.env.DEV) console.log("[sf] resumed session", resumed);
  }
  if (invite) {
    let mode = invite.mode;
    if (invite.animal) {
      currentAnimal = invite.animal;
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
    if (!player.riding && player.mode === "drive" && currentAnimal) parts.push(currentAnimal);
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
  const dbgBaked: { x: number; y: number; z: number; hx: number; hy: number; hz: number; yaw: number; index: boolean }[] = [];
  const dbgWalls: ColliderBox[] = [];
  const dbgInteriors: ColliderBox[] = [];
  const syncColliderDebug = () => {
    const on = Boolean(RENDER_TUNING.values.colliderDebug);
    if (on !== colliderDebug.visible) colliderDebug.setVisible(on);
    if (!on) return;
    colliderBoxes.length = 0;
    physics.debugBuildingBodies(dbgBaked);
    for (const b of dbgBaked) {
      // red = baked visual-tile body, orange = citywide-index body
      colliderBoxes.push({ ...b, r: 1, g: b.index ? 0.55 : 0.12, b: 0.12 });
    }
    if (citygenRing.current) {
      citygenRing.current.debugColliders(dbgWalls, dbgInteriors);
      for (const c of dbgWalls) colliderBoxes.push({ ...c, r: 0.15, g: 1, b: 0.3 });      // green = walk-in wall
      for (const c of dbgInteriors) colliderBoxes.push({ ...c, r: 0.25, g: 0.55, b: 1 }); // blue = interior
    }
    colliderDebug.sync(colliderBoxes);
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
    board: { r: 1.15, y: 1.0 },
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
    const [gardenMod, wildlandsMod, golfMod] = await Promise.all([
      import("./world/garden"),
      import("./world/wildlands"),
      import("./gameplay/golf")
    ]);
    windGustValue = gardenMod.windGustValue;
    advanceWind = gardenMod.updateWindGusts; // keep the wind envelope live when foliage is toggled off

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
        const game = await golfMod.createGolf(map, physics, scene, loadedGolfCourse);
        game.onNet = (m) => net.sendGolf(m);
        game.onImpact = (p) => fx.impactPuff(p);
        golf = game;
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
    await Promise.all([gardenReady, wildlandsGolfReady].filter(Boolean));

    // CityGen: procedural building ring + demo. Awaited (not fire-and-forget)
    // so modulesReady only flips once the ring exists — its cell builds land in
    // the scheduler on the next covered tick and keep the settle gate honest.
    const [citygenMod, citygenDemoMod] = await Promise.all([
      import("./world/citygen"),
      import("./world/citygen/demo")
    ]);
    citygen = citygenDemoMod.createCityGenDemo({ scene, map }) as NonNullable<typeof citygen>;
    citygenRing.current = await citygenMod.createCityGenRing({}, { scene, physics, map, tiles, schedule: scheduler.schedule });

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
    .catch((err) => console.warn("[sf] deferred module load failed:", err))
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
  // headless verification, demos and perf runs can't click — skip the gate
  // (and the settle hold: they measure live-frame behaviour, not boot polish)
  const skipGate = ["autostart", "demo", "profile"].some((k) => new URLSearchParams(location.search).has(k));
  // A returning player who already picked a real name skips the gate: once the
  // world is ready we drop them straight in under their saved name. Fun/generated
  // names don't count (re-rolled each load), and the headless/demo (`skipGate`)
  // and reading-link paths run their own start, so they opt out here.
  const autoStartSaved = !skipGate && !parseReadLink(location.search) && hasChosenName();
  const revealWorld = (reason = "settled") => {
    if (revealed) return;
    revealed = true;
    resolveRevealed(); // release any region-deferred park builds
    // Restore the full draw distance now that the near district gated the cover;
    // the rest of the city streams in from here (tiles + citygen both re-expand).
    CONFIG.tileLoadRadius = fullTileRadius;
    progress(100, "ready");
    startReady = true;
    startButton.disabled = false;
    loading.classList.add("ready");
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
    if (autoStartSaved && startGame) {
      // no click to consume, so pointer lock has no gesture — startGame still
      // requests it (a no-op if the browser declines; first click re-locks)
      startGame(pickName());
      return;
    }
    focusNameInput(); // re-focus in case the player clicked away while waiting
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
  if (parseReadLink(location.search) && startGame) {
    revealWorld("read-link"); // reading mode starts immediately — the modal covers any late streaming
    startGame(suggestedName, { lock: false });
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

  // three.js Inspector (perf/GPU-timing/memory/console tabs), lazy-built the
  // first time "/" turns the debug UI on. Off = swap the stock no-op InspectorBase back in and stop
  // timestamp tracking, so the profiler costs nothing while hidden. (Merely
  // hiding the DOM would leave GPU timestamp queries piling up unresolved.)
  let inspector: Inspector | null = null;
  let inspectorOn = false;
  const applyInspector = () => {
    const backend = renderer.backend as unknown as { trackTimestamp: boolean };
    if (inspectorOn) {
      if (!inspector) {
        // the stock toggle pill lands at top-right, exactly under the "/" pane —
        // re-anchor it (and its mini panel) to top-centre
        const style = document.createElement("style");
        style.textContent = [
          ".three-inspector .profiler-toggle { right: auto !important; left: 50% !important; transform: translateX(-50%); }",
          ".three-inspector .profiler-mini-panel { right: auto !important; left: 50% !important; transform: translateX(-50%); }"
        ].join("\n");
        document.head.appendChild(style);
        inspector = new Inspector();
        // vendor race: detaching (renderer.inspector = InspectorBase) nulls the
        // inspector's renderer while a resolveTimestamp rAF is still in flight,
        // which then crashes on null._nodes / null.backend. Ignore the null-out;
        // the InspectorBase swap + trackTimestamp=false already stop new work.
        const attach = inspector.setRenderer.bind(inspector);
        (inspector as unknown as { setRenderer: (r: unknown) => unknown }).setRenderer = (r: unknown) =>
          r === null ? inspector : attach(r as THREE.WebGPURenderer);
        renderer.inspector = inspector;
        inspector.init(); // renderer.init() already ran, so attach its DOM ourselves
      } else {
        renderer.inspector = inspector;
      }
      backend.trackTimestamp = true;
      inspector.domElement.style.display = "";
    } else {
      renderer.inspector = new THREE.InspectorBase();
      backend.trackTimestamp = false;
      if (inspector) inspector.domElement.style.display = "none";
    }
  };
  const setInspector = (on: boolean) => {
    if (inspectorOn === on) return;
    inspectorOn = on;
    // the renderer brackets each animation-loop call with inspector.begin()/
    // finish(); swapping mid-tick tears that pairing (finish() lands on an
    // inspector that never began the frame), so apply at the frame boundary
    requestAnimationFrame(applyInspector);
  };

  // Cheap FPS readout (the little green Stats.js box). This is what the debug UI
  // shows by default — near-zero cost, unlike the full Inspector's per-frame GPU
  // timestamp queries + canvas graph redraw. update() is called each frame only
  // while debug is on. Anchored top-left so it clears the top-right tuning pane.
  const stats = new Stats();
  stats.dom.style.cssText += ";position:fixed;top:12px;left:12px;z-index:40";
  stats.dom.style.display = "none";
  document.body.appendChild(stats.dom);

  // "/" drives the tuning pane + Stats box as one debug-UI switch; the full
  // Inspector is opt-in via a button at the bottom of the pane. I (immersive)
  // hides every scrap of UI, stashing the debug state to restore on exit
  let debugOn = false;
  let debugWasOn = false;
  const setDebugUI = (on: boolean) => {
    debugOn = on;
    if (debugPanel.visible !== on) debugPanel.toggle();
    stats.dom.style.display = on ? "" : "none";
    if (!on) setInspector(false); // closing debug also stops the heavy profiler
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

  // session state persistence: 1 Hz while playing + on tab close/refresh.
  // Only the visible tab writes — localStorage is shared per origin, and the
  // dev keep-alive keeps hidden tabs ticking, so an idle background tab would
  // otherwise clobber the state the user is actually playing (the "resume
  // worked once, then reset to spawn" bug).
  let saveTimer = 0;
  const writeSession = () => {
    savePlayerState({
      mode: player.mode,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      heading: player.heading
    });
  };
  const saveSession = () => {
    if (document.visibilityState === "visible") writeSession();
  };
  window.addEventListener("pagehide", saveSession);
  // pagehide can see visibilityState already "hidden" on refresh in some
  // browsers; the visible→hidden transition (this tab was the one the user
  // watched) is the reliable last-write hook
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") writeSession();
  });

  // A demo can install a per-frame cinematic controller that fully owns the
  // player pose AND the camera for a scripted shot (see dev/demos/buskersCinematic.ts).
  let cineHook: ((dt: number) => void) | null = null;

  let pickleballAnimationTime = 0;
  const syncPickleballSiteActivation = () => {
    if (!pickleball) return;
    // A claimed local seat always stays live, even if the player somehow leaves
    // the site while still controlling a side.
    if (pickleball.localSide !== null) {
      pickleballSiteAwake = true;
      pickleball.setActive(true);
      return;
    }
    const { x, z } = player.position;
    const wasAwake = pickleballSiteAwake;
    if (pickleballSiteAwake) {
      pickleballSiteAwake = inGoldmanTennisSite(x, z, PICKLEBALL_TUNING.deactivateSitePad);
    } else {
      pickleballSiteAwake = inGoldmanTennisSite(x, z, PICKLEBALL_TUNING.activateSitePad);
    }
    pickleball.setActive(pickleballSiteAwake);
    // Approaching the courts after a long roam: ask the relay for the latest
    // match snapshot so we don't briefly show a stale local AI serve.
    if (!wasAwake && pickleballSiteAwake && net.status === "online") net.replayPickleball();
  };
  const updatePickleballGameplay = (dt: number): boolean => {
    if (!pickleball) return false;
    syncPickleballSiteActivation();
    if (!pickleball.active) {
      pickleballLocalPose = null;
      pickleballPromptSide = null;
      pickleballInput = {};
      return false;
    }
    pickleballAnimationTime += dt;
    const side = pickleball.localSide;
    const moveX = input.axis("KeyA", "KeyD");
    const moveTowardNet = input.axis("KeyS", "KeyW");
    const swing = input.firePressed || input.pressed("Space");
    pickleballInput = {
      moveX,
      moveZ: moveTowardNet * (side === 1 ? -1 : 1),
      swing,
      sprint: input.down("ShiftLeft") || input.down("ShiftRight"),
      aimX: moveX,
      aimZ: input.down("KeyS") ? -0.35 : input.down("KeyW") ? 0.78 : 0.42,
      interact: input.pressed("KeyE"),
      exit: input.pressed("KeyE")
    };
    if (swing) pickleballSwingQueued = true;
    const frame = pickleball.update(dt, pickleballAnimationTime, player.position, pickleballInput);
    pickleballLocalPose = frame.localPose;
    let eConsumed = false;
    if (frame.requestedRelease !== null) {
      eConsumed = releasePickleballSide();
    } else if (frame.requestedSide !== null) {
      eConsumed = true;
      requestPickleballSide(frame.requestedSide);
    } else if (input.pressed("KeyE") && frame.interaction) {
      eConsumed = true;
      hud.message(frame.interaction.prompt, 2);
    }
    if (pickleball.localSide === null && frame.interaction?.available) {
      if (pickleballPromptSide !== frame.interaction.side) {
        pickleballPromptSide = frame.interaction.side;
        hud.message(frame.interaction.prompt, 2.2);
      }
    } else {
      pickleballPromptSide = null;
    }
    return eConsumed;
  };
  const applyPickleballPlayerPose = () => {
    const pose = pickleballLocalPose;
    if (!pose) return;
    const y = pose.worldPosition.y + 0.58;
    player.position.set(pose.worldPosition.x, y, pose.worldPosition.z);
    player.renderPosition.copy(player.position);
    player.heading = pose.worldHeading + Math.PI;
    player.velocity.set(0, 0, 0);
    pickleballNetQuaternion.setFromAxisAngle(pickleballUp, pose.worldHeading);
    player.quaternion.copy(pickleballNetQuaternion);
    player.renderQuaternion.copy(pickleballNetQuaternion);
    const mesh = player.meshes.walk;
    mesh.position.copy(player.renderPosition);
    mesh.quaternion.copy(pickleballNetQuaternion);
    player.setExternalEmbodimentHidden(true);
  };
  const hidePickleballRemoteAvatars = () => {
    const claimed = new Set(net.pickleballSlots.filter((id) => id && id !== net.selfId));
    for (const [id, remote] of remotes.avatars) {
      const body = remote.mode ? remote.bodies[remote.mode] : undefined;
      if (body) body.visible = !claimed.has(id);
      // Keep the presence root/name tag live: map clicks, shift-number travel,
      // voice positioning and HUD locators still lead friends to the open side.
      remote.root.visible = Boolean(remote.mode);
    }
  };
  const sendLocalPresence = (speed = player.speed) => {
    if (pickleballLocalPose) {
      pickleballNetPosition.copy(player.renderPosition);
      pickleballNetQuaternion.setFromAxisAngle(pickleballUp, pickleballLocalPose.worldHeading);
      net.sendState("walk", pickleballNetPosition, pickleballNetQuaternion, 0, 0);
    } else {
      net.sendState(player.mode, player.meshes[player.mode].position, player.meshes[player.mode].quaternion, speed, passengerOf ?? 0);
    }
  };
  const sendPickleballNetwork = () => {
    if (!pickleball || !pickleball.active || net.status !== "online") return;
    const now = performance.now() / 1000;
    if (now < pickleballNetSendAt) return;
    pickleballNetSendAt = now + 1 / 12;
    const side = pickleball.localSide;
    if (net.pickleballAuthority === net.selfId) {
      net.sendPickleballState(pickleball.serializeState());
    } else if (side !== null && net.pickleballSlots[side] === net.selfId) {
      net.sendPickleballInput(side, [
        pickleballInput.moveX ?? 0,
        pickleballInput.moveZ ?? 0,
        pickleballSwingQueued ? 1 : 0,
        pickleballInput.sprint ? 1 : 0,
        pickleballInput.aimX ?? 0,
        pickleballInput.aimZ ?? 0
      ]);
    }
    pickleballSwingQueued = false;
  };

  const tick = (forcedDt?: number) => {
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
    if (btsReading) {
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
      setDebugUI(!debugOn);
    }
    // I: immersive mode — every scrap of UI goes away until pressed again
    if (input.pressed("KeyI")) {
      immersive = !immersive;
      hud.setHidden(immersive);
      remotes.setTagsVisible(!immersive);
      if (immersive) {
        debugWasOn = debugOn;
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

    // The shared court keeps advancing even while the rest of the world is
    // paused, so a remote opponent never loses the match when authority opens
    // photo/pause controls.
    const pickleballEConsumed = updatePickleballGameplay(frameDt);
    const playingPickleball = pickleball?.localSide !== null && pickleball?.localSide !== undefined;
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
        gust: windGustValue?.() ?? 0,
        timeOfDay: sky.timeOfDay
      });
      // stay social while frozen: peers keep moving, our keepalive keeps flowing
      sendLocalPresence(0);
      sendPickleballNetwork();
      remotes.selfId = net.selfId;
      remotes.update(frameDt);
      hidePickleballRemoteAvatars();
      // stay glued to a friend's car while frozen
      if (passengerOf !== null && remotes.ridePose(passengerOf, ridePos, rideQuat)) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      }
      voice.update(camera); // keep talking while paused — it's a social feature
      minimap.update();
      playerLocator.update(camera, player.position, remotes.locatorTargets());
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
      if (passengerOf !== null && remotes.ridePose(passengerOf, ridePos, rideQuat)) {
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
      else { chase.indoor = citygenRing.current?.isPlayerInside() ?? false; chase.update(frameDt, player, input); }
      // keep the vehicle hum, ambience and social presence alive like full pause
      vehicleAudio.update(frameDt, {
        mode: player.mode,
        speed: player.speed,
        vspeed: player.velocity.y,
        boost: input.down("ShiftLeft"),
        grounded: player.mode !== "board" || player.boardGrounded,
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
        gust: windGustValue?.() ?? 0,
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
      input.endFrame();
      pipeline.render();
      return;
    }

    elapsed += frameDt;
    accumulator += frameDt;

    // Plain number keys switch travel modes; Ctrl+number picks click-tools;
    // Shift+number still teleports to player slots.
    const numberPressed = (i: number) => input.pressed(`Digit${i}`) || input.pressed(`Numpad${i}`);
    const ctrlNumberPress = (i: number) => input.ctrlPressed(`Digit${i}`) || input.ctrlPressed(`Numpad${i}`);
    const shiftedNumberPress = (i: number) => input.shiftedPress(`Digit${i}`) || input.shiftedPress(`Numpad${i}`);
    for (let i = 1; i <= 9; i++) {
      if (!numberPressed(i)) continue;
      if (playingPickleball) break;
      if (golf?.capturesDigits) break; // golf swing UI owns the number row (club picks)
      if (ctrlNumberPress(i)) {
        const nextTool = TOOL_ORDER[i - 1];
        if (nextTool) setTool(nextTool);
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
      if (nextMode) switchMode(nextMode);
    }
    const keyboardCycle =
      ((input.pressed("ArrowRight") && !input.altPressed("ArrowRight")) || (input.pressed("ArrowDown") && !input.altPressed("ArrowDown")) ? 1 : 0) -
      ((input.pressed("ArrowLeft") && !input.altPressed("ArrowLeft")) || (input.pressed("ArrowUp") && !input.altPressed("ArrowUp")) ? 1 : 0);
    const cycle = keyboardCycle + (input.pressed("PadModeNext") ? 1 : 0) - (input.pressed("PadModePrev") ? 1 : 0);
    if (cycle && !playingPickleball) {
      const cycleOrder = MENU_MODES;
      const idx = cycleOrder.indexOf(player.mode);
      const from = idx >= 0 ? idx : 0;
      const step = cycle < 0 ? -1 : 1;
      if (cycleOrder.length) switchMode(cycleOrder[(from + step + cycleOrder.length) % cycleOrder.length]);
    }
    if (!playingPickleball && input.altPressed("ArrowLeft")) applyPlaceHistory(-1);
    if (!playingPickleball && input.altPressed("ArrowRight")) applyPlaceHistory(1);

    // E: exit any vehicle/creature, pick up a thrown tennis ball, or on foot
    // hop into the nearest ride (a friend's passenger seat, a rideable animal,
    // or a mount you left behind)
    if (!pickleballEConsumed && input.pressed("KeyE") && !exitToWalk() && !golf?.tryStartAtTee(player, hud)) {
      if (!fetchBall?.tryPickup(player.position)) {
        const drv = remotes.nearestDriver(player.position, 5.5);
        const animal = drv ? null : forest?.nearest(player.position, 5);
        if (drv) {
          passengerOf = drv.id;
          player.startRide();
          hud.message(`Riding with ${drv.name} — E to hop out`, 2.6);
        } else if (animal && forest && ANIMALS) {
          const info = forest.consume(animal);
          currentAnimal = info.kind;
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

    if (input.pressed("KeyR")) {
      releasePickleballForNavigation();
      leaveRide();
      player.respawn(spawn);
      hud.message("Back at the start");
    }

    // Q: busker trio cycles to the next song in its songbook and cues it
    // 2s before the first note (no teleport)
    if (input.pressed("KeyQ")) {
      const song = buskers.cycleSong(2);
      hud.message(`♪ ${song} — playing in 2s`, 2.2);
    }

    // ".": factory reset for tweaks — every tweakpane value back to its
    // source-code default, saved tweaks wiped. Player stays put ("R" respawns).
    if (input.pressed("Period")) {
      resetAllTweaks();
      resetCrownTweaks();
      resetBayLightsTweaks();
      resetGoldenGateLightsTweaks();
      resetSutroLightsTweaks();
      START.spawn = START_DEFAULTS.spawn;
      START.mode = START_DEFAULTS.mode;
      // re-apply the side effects the pane's onChange handlers normally push.
      // Pixel ratio + shadows are no longer tweakable (universal render mode);
      // the reset just re-asserts the dynamic-res governor's ceiling.
      renderer.toneMappingExposure = RENDER_TUNING.values.exposure;
      dynRes.syncToCap();
      CONFIG.tileLoadRadius = WORLD_TUNING.values.radius;
      CONFIG.tileUnloadRadius = WORLD_TUNING.values.radius + 400;
      setFoliageVisible(FOLIAGE_TUNING.values.visible);
      tiles.forceScan();
      sky.applyFogParams();
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
      orbitFlip = { t: 0, duration, startAz: orbit.azimuthAngle, delta: Math.PI };
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
    } else if (player.mode === "drone") {
      if (!input.suspended && input.firePressed && fireCooldown <= 0) {
        chase.lookDir(aim);
        fireCooldown = 0.22;
        fireworks.launchDroneSalvo(droneFireworkMounts ?? [], aim, player.velocity);
        chase.shake(0.08);
      }
    } else if (player.mode === "speedboat") {
      // freedom boat: one press launches the whole cockpit rocket battery forward
      // over the water — red/white/blue barrage from the cockpit rocket battery
      if (!input.suspended && input.firePressed && fireCooldown <= 0 && boatLaunchers) {
        chase.lookDir(aim);
        fireCooldown = 0.6;
        const boatFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);
        boatFwd.y = 0;
        boatLaunchers.fireAll({
          scene,
          fireworks,
          rocketRiders,
          map,
          playerPos: player.position,
          forward: boatFwd,
          hostVelocity: player.velocity
        });
        chase.shake(0.18);
      }
    } else if (input.firing && currentAnimal === "raccoon") {
      // mounted raccoon: the click-tools stand down, the gummy cannon speaks
      if (fireCooldown <= 0) {
        chase.interactionDir(aim, player);
        fireCooldown = 0.13;
        chase.viewOrigin(rayOrigin, player);
        forest?.fireGummy(rayOrigin, aim, player.velocity);
      }
    } else if (tool === "ball") {
      // Hold ≥1s to spot the ball in hand, then wind up; release to throw.
      // Hands stay empty afterward — pick thrown balls back up with E.
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
      const eased = u * u * (3 - 2 * u); // smoothstep — zero angular velocity at ends
      orbit.azimuthAngle = orbitFlip.startAz + orbitFlip.delta * eased;
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
    if (passengerOf !== null) {
      if (remotes.ridePose(passengerOf, ridePos, rideQuat)) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      } else {
        // driver left, parked, or switched modes — back on our feet right here
        passengerOf = null;
        player.endRide();
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
    rocketRiders.update(frameDt, player.position); // the launched guitarists live their own lives
    if (player.mode === "speedboat") boatLaunchers?.update(frameDt); // guitarist jam + rocket reload
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
    fetchBall?.update(frameDt, elapsed, player.position);
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
    buskers.update(frameDt, camera, windGustValue?.() ?? 0, sky.sunElevation);
    // MASTER foliage gate: when the "/" panel's foliage switch is OFF, every
    // vegetation group is already hidden (setFoliageVisible) — skip all its
    // per-frame work too so it costs near zero. We STILL advance the shared wind
    // envelope (cheap CPU math, no rendering) because the nature soundscape below
    // reads its gust value for wind audio.
    if (foliageOn) {
      // garden: advance wind, move the near-grass detail ring to the player, and
      // flatten grass under them. Cheap when the player is nowhere near the garden
      // (updateFocus distance-culls base chunks and skips the near ring).
      gardenDisplacer.x = player.renderPosition.x;
      gardenDisplacer.z = player.renderPosition.z;
      garden?.update(frameDt, player.renderPosition, gardenDisplacers);
      // wildlands: the grass + flower rings follow the PLAYER (like the garden ring
      // above) so they stay put when you just look around — the chase camera orbits
      // the player, and anchoring the rings to it slid the whole field around you.
      // Tree distance-culling still follows the camera so off-screen groves drop.
      wildlands?.update(player.renderPosition, camera.position);
    } else {
      advanceWind?.(frameDt); // foliage hidden: keep only the wind gust envelope ticking for nature audio
    }
    // nature soundscape rides the same gust envelope garden.update just advanced,
    // and reads the sky clock for dawn choruses / night owls. Cheap out in the
    // city (suspends), so it's safe to tick unconditionally.
    nature.update(frameDt, {
      playerPos: player.renderPosition,
      camera,
      gust: windGustValue?.() ?? 0,
      timeOfDay: sky.timeOfDay
    });
    // live loop only: the dogs freeze during pause, so barking there would lie
    dogParkAudio.update(frameDt, player.renderPosition);
    if (currentAnimal) forest?.setRiddenSpeed(player.speed);
    islands.update(elapsed);
    citygenRing.current?.update(player.position, frameDt);
    if (!highUp) hunt.update(frameDt, elapsed, player.position);
    golf?.update(frameDt, elapsed, { player, input, hud, chase, camera });

    // "hop in" nudge when standing near a ride (friend → wildlife)
    if (player.mode === "walk" && passengerOf === null) {
      const drv = remotes.nearestDriver(player.position, 5.5);
      const nearAnimal = drv ? null : forest?.nearest(player.position, 5);
      if ((drv || nearAnimal) && !ridePromptShown) {
        hud.message(
          drv ? `E — ride with ${drv.name}` : `E — ride the ${nearAnimal!.label}`,
          1.8
        );
        ridePromptShown = true;
      }
      if (!drv && !nearAnimal) ridePromptShown = false;
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
      chase.indoor = citygenRing.current?.isPlayerInside() ?? false; // blend into the indoor eye rig
      chase.update(frameDt, player, input);
    }
    sky.update(elapsed, camera.position);
    water.update(elapsed, camera.position, player.renderPosition);
    underwater.update(camera, elapsed);
    seaPillars.update(player.renderPosition, elapsed);
    fx.update(frameDt);
    bubbles.update(frameDt, elapsed);
    wake.update(frameDt, elapsed, player);
    boardWake.update(frameDt, elapsed, player);
    birdTrails.update(elapsed, player);
    splashes.update(frameDt, elapsed, player);
    vehicleAudio.update(frameDt, {
      mode: player.mode,
      speed: player.speed,
      vspeed: player.velocity.y,
      boost: input.down("ShiftLeft"),
      grounded: player.mode !== "board" || player.boardGrounded,
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

    saveTimer += frameDt;
    if (saveTimer >= 1) {
      saveTimer = 0;
      saveSession();
    }

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
    if (debugOn) stats.update(); // cheap FPS box; skipped entirely while hidden
  };
  // automation tabs (Playwright/Puppeteer probes) render with no vsync
  // backpressure — one orphaned headless probe pegged the GPU at 100%
  // machine-wide. Cap them to ~20fps; measurement harnesses opt out with
  // ?fullfps. Manual __sf.tick() driving is unaffected.
  const throttleRaf = navigator.webdriver && !new URLSearchParams(location.search).has("fullfps");
  let lastLoop = performance.now();
  let manualDrive = false; // frame-by-frame capture drives tick(dt) itself
  const loopFn = () => {
    const now = performance.now();
    if (throttleRaf && now - lastLoop < 50) return;
    const frameMs = now - lastLoop; // true rAF-to-rAF cadence, incl. render
    lastLoop = now;
    tick();
    // covered boot frames are deliberately long (turbo drains + compiles) —
    // keep them out of the res governor's cadence/EMA and the spike log so
    // the refresh-rate lock and hitch stats only ever see live frames
    if (revealed) {
      dynRes.sample(frameMs); // step pixel ratio to hold the frame budget
      tracer.frame(frameMs); // spike log: phases + counters snapshot on bad frames
    }
  };
  renderer.setAnimationLoop(loopFn);
  // Deterministic capture: stop the wall-clock loop (and the hidden-tab fallback
  // below) so the sim only advances one fixed step per screenshotted frame —
  // smooth output no matter how slow rendering runs under GPU contention.
  (window as never as { __sfManual: (on: boolean) => void }).__sfManual = (on: boolean) => {
    manualDrive = on;
    renderer.setAnimationLoop(on ? null : loopFn);
  };

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

  const applyViewportSize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    // Keep the governor's CURRENT ratio across resize/fullscreen — not the cap —
    // so a size change doesn't silently undo an active down-step.
    renderer.setPixelRatio(dynRes.ratio);
    renderer.setSize(window.innerWidth, window.innerHeight);
  };
  window.addEventListener("resize", applyViewportSize);
  // Booting inside a zero-sized viewport (hidden tab, embedded pane still
  // laying out) leaves a 0×0 swapchain and no `resize` event ever corrects it
  // — the canvas stays black. Watch the app container itself and re-apply
  // whenever its box actually changes.
  new ResizeObserver(() => {
    const el = renderer.domElement;
    if (el.clientWidth !== window.innerWidth || el.clientHeight !== window.innerHeight) applyViewportSize();
  }).observe(app);

  console.log("[sf] city online (webgpu)");

  const exposeDebugHooks = () => {
    Object.assign(window as never, {
      __sf: { scene, camera, player, tiles, physics, renderer, pipeline, dynRes, tracer, scheduler, POSTFX_TUNING, WORLD_TUNING, FLOWER_TUNING, RENDER_TUNING, chase, map, input, hud, fx, fireworks, graffiti, bubbles, setTool, setColor, sky, debugPanel, CONFIG, THREE, tick, creatures, forest, garden, wildlands, goldenGateTennis, pickleball, coronaHeights, splashes, vehicleAudio, swimAudio, nature, dogParkAudio, net, remotes, voice, minimap, playerLocator, boardWake, abandonedMounts, paintballs, paintSkins, hunt, satchel, buildShareUrl, tutorial, fetchBall, rocketRiders, boatLaunchers, goldenGateLights, teleportToTarget, trafficLights, streetLamps, citygen, citygenRing, worldCursor, worldQueries, underwater, seaPillars, water, roadMarkings, colliderDebug, calibrationChart, FOLIAGE_TUNING, setFoliageVisible, buskers, boardSelector }
    });
  };
  if (import.meta.env.DEV || new URLSearchParams(location.search).has("profile")) {
    exposeDebugHooks();
  }

  if (import.meta.env.DEV) {
    // dev-only: keep the sim alive when the tab is hidden OR rAF is throttled
    // (occluded/background tabs), + expose debug/demo hooks
    setInterval(() => {
      if (!manualDrive && (document.hidden || performance.now() - lastLoop > 250)) tick(0.05);
    }, 50);
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
      setTool: (t: string) => setTool(t as ToolName),
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
  const msg = err instanceof Error ? err.message : String(err);
  loadingLabel.textContent = `boot failed: ${msg} — click to reload`;
  loadingBar.style.width = "100%";
  loadingBar.style.background = "#c0392b";
  loading.style.cursor = "pointer";
  loading.addEventListener("click", () => location.reload(), { once: true });
});
