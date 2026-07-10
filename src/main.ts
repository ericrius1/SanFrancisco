import * as THREE from "three/webgpu";
import { Inspector } from "three/addons/inspector/Inspector.js";
import Stats from "three/addons/libs/stats.module.js";
import CameraControls from "camera-controls";
import { CONFIG, FLOWER_TUNING, FOLIAGE_TUNING, RENDER_MODE, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING } from "./config";
import { loadPlayerState, resetAllTweaks, savePlayerState } from "./core/persist";
import { Input } from "./core/input";
import { tracer } from "./core/hitchTracer";
import { createFrameScheduler } from "./core/frameBudget";
import { WorldMap, waterHeight } from "./world/heightmap";
import { Sky, SKY_TUNING } from "./world/sky";
import { Water } from "./world/water";
import { UnderwaterOverlay } from "./fx/underwater";
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
import { findOpenSpawn } from "./world/spawn";
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
import { Chimes } from "./fx/chimes";
import { WorldCursor } from "./fx/worldCursor";
import { WorldQueries, ProxySet } from "./core/worldQueries";
import { Toolbar, TOOL_ORDER, TOOL_VERB, type ToolName } from "./ui/toolbar";
import { AvatarSelector } from "./ui/avatarSelector";
import { AudioControls } from "./ui/audioControls";
import { Chat } from "./ui/chat";
import { VehicleAudio } from "./fx/vehicleAudio";
import { SwimAudio } from "./fx/swimAudio";
import { createNatureSoundscape } from "./audio";
import { AbandonedMounts } from "./gameplay/abandonedMounts";
import { RocketRiders, type LauncherRig } from "./gameplay/launchers";
import type { Creatures } from "./gameplay/creatures";
import type { Forest, AnimalKind } from "./gameplay/forest";
import type { GrassDisplacer } from "./world/garden";
import type { CityGenRing, ColliderBox } from "./world/citygen";
import { Islands } from "./gameplay/islands";
import { Hunt } from "./gameplay/hunt";
import { Ropes, Grabber, type PickCandidate } from "./gameplay/ropes";
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
import { Net, makeFunName } from "./net/net";
import { RemotePlayers } from "./net/remotes";
import { Voice } from "./net/voice";
import { Minimap } from "./ui/minimap";
import { PlayerLocator } from "./ui/playerLocator";
import { avatarFromSeed, loadSavedAvatar, randomAvatarTraits, saveAvatarTraits } from "./player/avatar";
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
  progress(8, "reading the map");
  const map = await WorldMap.load();

  progress(18, "waking the gpu");
  // reversed-z: near 0.3 / far 24000 leaves classic depth with sub-metre steps
  // beyond a kilometre, so distant near-coplanar facades shimmer. Reversed float
  // depth keeps precision effectively uniform out to the far plane.
  // antialias stays OFF at the canvas: every pixel routes through the post
  // pipeline, so edge AA comes from the scene pass's own 4x target
  // (pipeline.ts) — a multisampled canvas would only buy a 4x resolve of the
  // final fullscreen quad
  const renderer = new THREE.WebGPURenderer({ antialias: false, reversedDepthBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_MODE.pixelRatioCap));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER_TUNING.values.exposure; // reference grading: physical sun (~100) + low exposure
  renderer.shadowMap.enabled = true; // universal render mode: CSM shadows always on (see world/sky.ts)
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);
  await renderer.init();

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
  let roadMarkings: THREE.Group | null = null;
  void createRoadMarkings(scene, map)
    .then((group) => {
      roadMarkings = group;
    })
    .catch((err) => console.warn("[roads] lane markings unavailable", err));

  const physics = await Physics.create(map, tiles);

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
  const chimes = new Chimes(scene);
  const worldCursor = new WorldCursor(scene);
  let tool: ToolName = "spray";
  let grabberRef: Grabber | null = null; // assigned below; setTool runs once before it exists
  const setTool = (t: ToolName) => {
    if (t !== "grab") grabberRef?.release(); // switching tools drops whatever the beam held
    tool = t;
    toolbar.setTool(t);
    hud.setToolVerb(TOOL_VERB[t]);
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
  setTool("spray");
  setColor(0);

  // procedural vehicle hum + the HUD's master volume/mute widget (bottom-left)
  const vehicleAudio = new VehicleAudio();
  const swimAudio = new SwimAudio();
  const audioControls = new AudioControls();
  // procedural, layered nature soundscape (Botanical Garden / GG Park / Presidio
  // / Marin): sampled beds + gust-locked wind synth + spatial animal calls, all
  // fading in per region. Suspends itself when the player is out in the city.
  const nature = createNatureSoundscape();

  // start where the "/" panel's start folder points (source default: Golden Gate
  // Bridge deck), nudged onto open ground — never under (or inside) a building.
  const startAt = map.meta.spawns[START.spawn] ?? map.meta.spawns[START_DEFAULTS.spawn];
  const spawn = await findOpenSpawn(map, tiles.manifest, startAt);
  // Avatar identity: a saved avatar means the player chose one in the editor;
  // otherwise leave it to the server's per-id seed (adopted on welcome below) so
  // every player — every browser tab included — looks distinct. randomAvatarTraits
  // is just a non-default placeholder for the seconds before we're welcomed (and
  // the whole life of an offline single-player session).
  const savedAvatar = loadSavedAvatar();
  let customized = savedAvatar !== null;
  let avatarTraits = savedAvatar ?? randomAvatarTraits();
  const player = new Player(physics, map, scene, spawn, avatarTraits);
  const birdTrails = new BirdTrails(scene, player.meshes.bird);
  const droneFireworkMounts = player.meshes.drone.userData.fireworkMounts as THREE.Object3D[] | undefined;
  const boatLaunchers = player.meshes.speedboat.userData.launcherRig as LauncherRig | undefined;
  if (START.mode !== "walk" && ALL_MODES.includes(START.mode)) player.trySwitch(START.mode);
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
  void RoadGraph.load()
    .then((roads) => {
      trafficLights = new TrafficLightView(scene, map, roads);
      // fake night-street lighting: reuse the just-loaded graph (no second fetch)
      streetLamps = new StreetLamps(scene, map, roads);
      const sfHooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (sfHooks) Object.assign(sfHooks, { streetLamps });
    })
    .catch((err: unknown) => console.warn("[traffic] signals unavailable", err));
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
  let garden: { group: THREE.Group; update: (dt: number, pos: THREE.Vector3, d: GrassDisplacer[]) => void } | null = null;
  let wildlands: { groups: THREE.Group[]; flowers: { refresh: () => void }; grass: { refresh: () => void }; update: (pos: THREE.Vector3, cam: THREE.Vector3) => void } | null = null;
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
    if (garden) garden.group.visible = visible;
    if (wildlands) for (const g of wildlands.groups) g.visible = visible;
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

  // crabs to hunt plus the Garry's-Mod rope/grab click-tools
  // (hunt.ts / ropes.ts)
  const satchel = new Satchel();
  const hunt = new Hunt(map, scene);
  hunt.onCatch = (kind) => {
    satchel.add(kind);
    hud.message("Crab caught!", 1.1);
  };
  const ropes = new Ropes(physics, scene);
  const grabber = new Grabber(physics, scene);
  grabberRef = grabber;
  // No ambient vehicles anymore, so the rope/grab tools have no extra spherical
  // candidates to offer — they still reach the static world directly.
  const pickables: PickCandidate[] = [];
  const gatherPickables = () => pickables;

  const bayLights = createBayLights(map);
  if (bayLights) scene.add(bayLights);
  const goldenGateLights = createGoldenGateLights(map);
  if (goldenGateLights) scene.add(goldenGateLights);
  // Palace of Fine Arts peristyle: the OSM data carries the curved colonnade as
  // ordinary windowed buildings, so swap them for a real open row of columns.
  for (const b of PALACE_RING_BUILDINGS) tiles.suppressBuilding(b.key, b.index);
  scene.add(createPalaceColonnade(map));
  const sutroTower = createSutroTower(map);
  scene.add(sutroTower);
  let currentAnimal: AnimalKind | null = null;
  let ridePromptShown = false;
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

  const setCameraMode = (on: boolean) => {
    cameraMode = on;
    input.suspended = on;
    orbit.enabled = on;
    if (on) {
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
      hud.message("Camera mode — drag to orbit, C to return", 3);
    } else {
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
  const net = new Net(suggestedName, savedAvatar ?? undefined);
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
  net.onWelcome = () => {
    if (customized) {
      net.setAvatar(avatarTraits); // re-assert my chosen look after a (re)connect
    } else {
      // adopt the server's per-id seed so my own body matches how everyone else
      // sees me, and reflect it in the editor
      avatarTraits = avatarFromSeed(net.selfId);
      player.setAvatar(avatarTraits);
      avatarSelector.setTraits(avatarTraits);
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
      }
    }
  };
  net.onRoster = syncRoster;
  net.onLeave = (id) => {
    remotes.remove(id);
    voice.drop(id);
  };
  net.onSample = (id, s) => remotes.sample(id, s);
  // someone else's paintball: same ballistic sim, their color, splats locally
  net.onPaint = (id, x, y, z, vx, vy, vz, rgb) => paintballs.spawn(x, y, z, vx, vy, vz, remotePaint.set(rgb), id);
  const remotePaint = new THREE.Color();
  // shared skies: my rocket launches go out, friends' volleys replay here
  fireworks.onVolley = (rockets) => net.sendFireworks(rockets);
  net.onFireworks = (_id, rockets) => fireworks.launchRemote(rockets);
  // ephemeral text chat (T to type) — fire-and-forget over the relay, no history
  const chat = new Chat(
    (text) => {
      chat.addMessage(net.name, text, true); // local echo (server doesn't bounce back to sender)
      net.sendChat(text);
    },
    (focused) => {
      if (focused) {
        input.releaseLock();
      } else if (!cameraMode && document.body.classList.contains("started") && !input.suspended) {
        input.requestLock();
      }
    }
  );
  net.onChat = (_id, name, text) => chat.addMessage(name, text);
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
    // "offline" stays silent: single-player keeps working and Net retries forever
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
      return { x: player.position.x, z: player.position.z, fx: mapFwd.x, fz: mapFwd.z, hue: net.selfHue };
    },
    () => remotes.positions()
  );
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
    if (mode === "drone" || mode === "board" || mode === "bird") return 2.8;
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
    // Switching to walk = hop off wherever you are, same as pressing E
    // (steps off the gunwale into the water when leaving a boat, etc.)
    if (mode === "walk") {
      exitToWalk();
      return;
    }
    beginPlaceNavigation("Previous place");
    leaveRide(); // a mode key while riding shotgun hops out first
    if (currentAnimal && mode !== "drive" && mode !== "drone") dropCurrentDriveMount();
    if (mode === "drive" && !currentAnimal) player.setDriveStyle(null);
    if (mode === "drone") player.clearDroneStyle();
    // Always spawn a fresh mount — any one you left behind keeps living its own
    // life (the phoenix flies on, the plane lies where it crashed).
    player.trySwitch(mode);
    finishPlaceNavigation(`${mode} place`);
  };
  switchModeFromToolbar = switchMode;
  hud.onHistoryBack = () => applyPlaceHistory(-1);
  hud.onHistoryForward = () => applyPlaceHistory(1);
  const teleportToTarget = (x: number, z: number, toName?: string, playerId?: number) => {
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
    if (on) input.releaseLock();
    else if (!cameraMode) input.requestLock();
  };

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
  let btsReading = false;
  // BehindTheScenes is constructed after progress(100) in the deferred loader

  // collider x-ray overlay (debug: "/" → collider x-ray). Off unless toggled;
  // the tick gathers active colliders and drives it. Scratch arrays reused so an
  // enabled overlay allocates nothing per frame.
  const colliderDebug = new ColliderDebug(scene);
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
      chase.lookDir(dir);
      origin.copy(player.aimOrigin);
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
    bird: { r: 1.0, y: 0.5 }
  };

  let fireCooldown = 0;

  // Warm the GPU pipelines while the loading screen still covers the canvas.
  // First render lets the CSM shadow node build its cascade lights (that build
  // changes the scene light set once, and anything compiled before it would
  // need a second compile after). Then one render with the START mode's meshes
  // visible compiles that vehicle up front; remaining modes idle-warm below so
  // Start isn't blocked on all 8. Vehicle lamps come from Player's fixed-size
  // LightPool (always in the scene), so mode switches stay compile-free once
  // warmed. Culling is off so meshes parked at the origin still draw.
  progress(88, "warming up the vehicles");
  sky.update(0, camera.position);
  pipeline.render();
  player.warmup([player.mode]);
  fx.prewarm(); // compiles both sprite blend pipelines before gameplay
  const unculled: THREE.Object3D[] = [];
  const startMesh = player.meshes[player.mode];
  startMesh.traverse((o) => {
    if (o.frustumCulled) {
      o.frustumCulled = false;
      unculled.push(o);
    }
  });
  pipeline.render();
  // one rAF flush is enough for a single-mode compile; no fixed 350ms wait
  await new Promise<void>((r) => requestAnimationFrame(() => r()));
  for (const o of unculled) o.frustumCulled = true;
  player.warmup(); // restore: only the current mode visible

  progress(100, "ready");
  // Load done: enable Start (form already sits over the idling city), fade the
  // opaque backdrop and re-focus in case the player clicked away while waiting.
  startReady = true;
  startButton.disabled = false;
  loading.classList.add("ready");
  focusNameInput();

  // Idle-warm remaining modes one-at-a-time so the first mode-switch is hitch-free
  // without blocking Start. Keep the current embodiment visible (city is already
  // on screen behind the gate). Must pipeline.render() while the extra mesh is
  // drawn — visibility alone does not compile WGSL.
  {
    const modesLeft: PlayerMode[] = (["walk", "drive", "plane", "boat", "speedboat", "drone", "board", "bird"] as PlayerMode[])
      .filter((m) => m !== player.mode);
    const warmNext = () => {
      const m = modesLeft.shift();
      if (!m) return;
      player.warmup([player.mode, m]);
      const mesh = player.meshes[m];
      const freed: THREE.Object3D[] = [];
      mesh.traverse((o) => {
        if (o.frustumCulled) {
          o.frustumCulled = false;
          freed.push(o);
        }
      });
      pipeline.render();
      requestAnimationFrame(() => {
        for (const o of freed) o.frustumCulled = true;
        player.warmup(); // restore current mode only
        const schedule: (cb: () => void) => void =
          typeof requestIdleCallback !== "undefined"
            ? (cb) => requestIdleCallback(cb, { timeout: 2000 })
            : (cb) => setTimeout(cb, 200);
        schedule(warmNext);
      });
    };
    (typeof requestIdleCallback !== "undefined"
      ? (cb: () => void) => requestIdleCallback(cb, { timeout: 3000 })
      : (cb: () => void) => setTimeout(cb, 500))(warmNext);
  }
  // Deferred module loader — constructs all non-critical systems after the Start
  // button is visible. Modules are dynamically imported so Vite emits separate
  // chunks; the world fills while the user types their name. The Start button is
  // already enabled above so this never blocks first interaction.
  (async () => {
    // small stagger so the deferred request doesn't compete with the initial render
    await new Promise<void>((r) => setTimeout(r, 100));

    // Forest + Creatures: ambient wildlife and rideable animals
    const [forestMod, creaturesMod] = await Promise.all([
      import("./gameplay/forest"),
      import("./gameplay/creatures")
    ]);
    ANIMALS = forestMod.ANIMALS as NonNullable<typeof ANIMALS>;
    creatures = new creaturesMod.Creatures(map, scene);
    forest = new forestMod.Forest(map, scene);

    // Garden + Wildlands: botanical garden grass + designed SeedThree groves
    const [gardenMod, wildlandsMod] = await Promise.all([
      import("./world/garden"),
      import("./world/wildlands")
    ]);
    windGustValue = gardenMod.windGustValue;
    advanceWind = gardenMod.updateWindGusts; // keep the wind envelope live when foliage is toggled off
    const _garden = gardenMod.createBotanicalGarden(map);
    scene.add(_garden.group);
    _garden.group.visible = FOLIAGE_TUNING.values.visible;
    garden = _garden;
    const _wildlands = wildlandsMod.createWildlands(map);
    for (const g of _wildlands.groups) { g.visible = FOLIAGE_TUNING.values.visible; scene.add(g); }
    wildlands = _wildlands;
    // __sf snapshots these refs at expose time (they were null then) — patch the
    // live objects in so probes/console can reach the garden + wildlands groups.
    const sfHooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (sfHooks) Object.assign(sfHooks, { garden: _garden, wildlands: _wildlands });

    // CityGen: procedural building ring + demo
    const [citygenMod, citygenDemoMod] = await Promise.all([
      import("./world/citygen"),
      import("./world/citygen/demo")
    ]);
    citygen = citygenDemoMod.createCityGenDemo({ scene, map }) as NonNullable<typeof citygen>;
    citygenMod.createCityGenRing({}, { scene, physics, map, tiles, schedule: scheduler.schedule }).then((r) => { citygenRing.current = r; });

    // BehindTheScenes: the "how it was made" reading overlay
    const { BehindTheScenes } = await import("./ui/behindTheScenes");
    new BehindTheScenes((open: boolean) => {
      btsReading = open;
      app.classList.toggle("world-dimmed", open);
      input.suspended = open || cameraMode;
      if (open) input.releaseLock();
      else if (!cameraMode) input.requestLock();
    });
  })().catch((err) => console.warn("[sf] deferred module load failed:", err));

  // headless verification, demos and perf runs can't click — skip the gate
  const skipGate = ["autostart", "demo", "profile"].some((k) => new URLSearchParams(location.search).has(k));
  if (skipGate) loading.classList.add("done");

  // `?read=<modal>[.<sub>]` — a shared "reading" link (e.g. ?read=bts.sound for
  // the soundscape chapter). Drop straight into the reading: no name gate, a fun
  // sample name handed out automatically, and the modal opened on its sub-view.
  // Closing it lands the player in the live city with nothing left to fill in.
  if (parseReadLink(location.search) && startGame) {
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
  // player pose AND the camera for a scripted shot (see dev/demo.ts "ggboat").
  let cineHook: ((dt: number) => void) | null = null;

  const tick = (forcedDt?: number) => {
    timer.update();
    const frameDt = forcedDt ?? Math.min(timer.getDelta(), 0.09);

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
      }
      setDebugUI(!debugOn);
    }
    // I: immersive mode — every scrap of UI goes away until pressed again
    if (input.pressed("KeyI")) {
      immersive = !immersive;
      hud.setHidden(immersive);
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
    // Works while paused; Esc also closes it.
    if (input.pressed("KeyM") || (minimap.expanded && input.pressed("Escape"))) {
      minimap.setExpanded(!minimap.expanded);
    }

    // Full freeze: a pause with "freeze player" armed. Everything holds — sim,
    // player, fx, vehicles — while a clean screenshot floats on top.
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
      net.sendState(player.mode, player.meshes[player.mode].position, player.meshes[player.mode].quaternion, 0, passengerOf ?? 0);
      remotes.selfId = net.selfId;
      remotes.update(frameDt);
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
      if (!input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
      if (!input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();
      chase.lookDir(aim);
      let steps = 0;
      while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
        player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
        physics.step(physics.world.fixedTimeStep, player.position);
        accumulator -= physics.world.fixedTimeStep;
        steps++;
      }
      if (steps === 3) accumulator = 0;
      remotes.selfId = net.selfId;
      remotes.update(frameDt);
      // riding shotgun with a friend keeps you glued; otherwise settle the render
      // transform between physics states like a live frame
      if (passengerOf !== null && remotes.ridePose(passengerOf, ridePos, rideQuat)) {
        player.setRidePose(ridePos, rideQuat, frameDt);
      } else {
        player.afterSteps(steps, accumulator / physics.world.fixedTimeStep);
        player.syncMesh(frameDt);
      }
      const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
      highUp = highUp ? altitude > 110 : altitude > 150;
      tiles.update(player.position.x, player.position.z, highUp);
      if (cameraMode) orbit.update(frameDt);
      else { chase.indoor = citygenRing.current?.isPlayerInside() ?? false; chase.update(frameDt, player, input); }
      // keep the vehicle hum, ambience and social presence alive like full pause
      vehicleAudio.update(frameDt, {
        mode: player.mode,
        speed: player.speed,
        vspeed: player.velocity.y,
        boost: input.down("ShiftLeft"),
        grounded: player.mode !== "board" || player.boardGrounded
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
      net.sendState(player.mode, player.meshes[player.mode].position, player.meshes[player.mode].quaternion, player.speed, passengerOf ?? 0);
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
    if (cycle) {
      const cycleOrder = MENU_MODES;
      const idx = cycleOrder.indexOf(player.mode);
      const from = idx >= 0 ? idx : 0;
      const step = cycle < 0 ? -1 : 1;
      if (cycleOrder.length) switchMode(cycleOrder[(from + step + cycleOrder.length) % cycleOrder.length]);
    }
    if (input.altPressed("ArrowLeft")) applyPlaceHistory(-1);
    if (input.altPressed("ArrowRight")) applyPlaceHistory(1);

    // E: exit any vehicle/creature, or on foot hop into the nearest ride (a
    // friend's passenger seat, a rideable animal, or a mount you left behind)
    if (input.pressed("KeyE") && !exitToWalk()) {
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
          }
        }
    }

    if (input.pressed("KeyR")) {
      leaveRide();
      player.respawn(spawn);
      hud.message("Back at the start");
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

    // left-click tools, all along the true view direction: paint sticks to
    // whatever the center-screen ray lands on, bubbles ride the wand, chimes ring
    // the struck surface (pitch keyed to strike height)
    fireCooldown -= frameDt;
    if (input.freeCursor) {
      // free cursor out: clicks only reach UI panels — the spray/chime/grab
      // tools stand down so pointing around never fires them
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
        chase.lookDir(aim);
        fireCooldown = 0.13;
        rayOrigin.copy(player.aimOrigin);
        forest?.fireGummy(rayOrigin, aim, player.velocity);
      }
    } else if (tool === "rope") {
      // rope tool: click one end, click the other — ropes.ts narrates each step
      if (input.firePressed && !input.suspended) {
        chase.lookDir(aim);
        rayOrigin.copy(player.aimOrigin);
        hud.message(ropes.toolClick(rayOrigin, aim, gatherPickables()), 2.4);
      }
    } else if (tool === "grab") {
      // grab tool: hold to tractor-beam something, release to drop/throw
      chase.lookDir(aim);
      rayOrigin.copy(player.aimOrigin);
      if (input.firing && !grabber.holding && fireCooldown <= 0) {
        if (!grabber.tryGrab(rayOrigin, aim, gatherPickables())) fireCooldown = 0.2; // re-probe 5×/s while held on air
      } else if (!input.firing && grabber.holding) {
        grabber.release(aim);
      }
    } else if (input.firing) {
      chase.lookDir(aim);
      rayOrigin.copy(player.aimOrigin);
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
      } else if (tool === "chimes" && fireCooldown <= 0) {
        fireCooldown = 0.32;
        const hit = physics.raycastWorld(rayOrigin, aim, 300);
        if (hit) chimes.strike(hit.point, hit.normal, hit.kind, chase.yaw, camera.position);
      }
    }

    // Z (hold): the trackpad scrubs time of day instead of the camera. Consumes
    // mouseDX/wheelX before the fly controller and chase camera see them, so
    // the view holds still while the light sweeps.
    const scrubHeld = input.down("KeyZ");
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
    if (!input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
    if (!input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();

    chase.lookDir(aim); // drone moves along the true view direction (no shot bias)
    tracer.begin("physics");
    let steps = 0;
    while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
      player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
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
    const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
    highUp = highUp ? altitude > 110 : altitude > 150;
    // high over the city streams buildings only — no park lawns / trees uploaded
    tiles.update(player.position.x, player.position.z, highUp);
    trafficLights?.update(player.position, performance.now() / 1000);
    streetLamps?.update(player.position);
    abandonedMounts.update(frameDt, player.position);
    rocketRiders.update(frameDt, player.position); // the launched guitarists live their own lives
    if (player.mode === "speedboat") boatLaunchers?.update(frameDt); // guitarist jam + rocket reload
    creatures?.update(elapsed, camera.position); // gulls live at altitude — never gated
    forest?.update(frameDt, camera.position);
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
    if (currentAnimal) forest?.setRiddenSpeed(player.speed);
    islands.update(elapsed);
    citygenRing.current?.update(player.position, frameDt);
    if (!highUp) hunt.update(frameDt, elapsed, player.position);
    ropes.update(frameDt, player.position, elapsed);
    if (grabber.holding) {
      // the carry servo chases a point in front of the live camera every frame
      chase.lookDir(aim);
      grabber.update(rayOrigin.copy(player.aimOrigin), aim);
    }

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
    } else {
      ridePromptShown = false;
    }
    if (cineHook) {
      cineHook(frameDt); // scripted cinematic owns pose + camera
    } else if (cameraMode) {
      orbit.update(frameDt);
    } else {
      chase.indoor = citygenRing.current?.isPlayerInside() ?? false; // pull the boom in indoors
      chase.update(frameDt, player, input);
    }
    sky.update(elapsed, camera.position);
    water.update(elapsed, camera.position, player.renderPosition);
    underwater.update(camera, elapsed);
    seaPillars.update(player.renderPosition, elapsed);
    fx.update(frameDt);
    bubbles.update(frameDt, elapsed);
    chimes.update(frameDt);
    wake.update(frameDt, elapsed, player);
    boardWake.update(frameDt, elapsed, player);
    birdTrails.update(elapsed, player);
    splashes.update(frameDt, elapsed, player);
    vehicleAudio.update(frameDt, {
      mode: player.mode,
      speed: player.speed,
      vspeed: player.velocity.y,
      boost: input.down("ShiftLeft"),
      grounded: player.mode !== "board" || player.boardGrounded
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
    net.sendState(player.mode, player.meshes[player.mode].position, player.meshes[player.mode].quaternion, player.speed, passengerOf ?? 0);
    voice.update(camera); // listener follows the camera, voices follow the avatars
    minimap.update();
    playerLocator.update(camera, player.position, remotes.locatorTargets());

    // Sync the raycastable-entity proxies once, after everyone is posed: remote
    // avatars and me (id = net.selfId, tagged self so the cursor skips it but
    // remote paint still lands). paintballs + cursor then just query.
    entityProxies.begin();
    for (const a of remotes.avatars.values()) {
      const body = a.mode ? a.bodies[a.mode] : undefined;
      if (!body || !a.root.visible) continue;
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
    tracer.end("world");

    // Drain deferred bursty work (streamed bodies, citygen assembly, warmups)
    // under a headroom-scaled budget: fast frames catch up, tight frames yield.
    tracer.begin("sched");
    scheduler.run(frameDt < 1 / 55 ? 3 : frameDt < 1 / 35 ? 1.5 : 0.8);
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
    dynRes.sample(frameMs); // step pixel ratio to hold the frame budget
    tracer.frame(frameMs); // spike log: phases + counters snapshot on bad frames
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

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    // Keep the governor's CURRENT ratio across resize/fullscreen — not the cap —
    // so a size change doesn't silently undo an active down-step.
    renderer.setPixelRatio(dynRes.ratio);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  console.log("[sf] city online (webgpu)");

  const exposeDebugHooks = () => {
    Object.assign(window as never, {
      __sf: { scene, camera, player, tiles, physics, renderer, pipeline, dynRes, tracer, scheduler, POSTFX_TUNING, WORLD_TUNING, FLOWER_TUNING, RENDER_TUNING, chase, map, input, hud, fx, fireworks, graffiti, bubbles, chimes, setTool, setColor, sky, debugPanel, CONFIG, THREE, tick, creatures, forest, garden, wildlands, splashes, vehicleAudio, swimAudio, nature, net, remotes, voice, minimap, playerLocator, boardWake, abandonedMounts, paintballs, paintSkins, hunt, ropes, grabber, satchel, gatherPickables, buildShareUrl, tutorial, rocketRiders, boatLaunchers, goldenGateLights, teleportToTarget, trafficLights, streetLamps, citygen, citygenRing, worldCursor, worldQueries, underwater, seaPillars, water, roadMarkings, colliderDebug, FOLIAGE_TUNING, setFoliageVisible }
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
      hud,
      sky,
      minimap,
      map,
      setTool: (t: string) => setTool(t as ToolName),
      setCine: (fn: ((dt: number) => void) | null) => {
        cineHook = fn;
      },
      setExposure: (v: number) => {
        renderer.toneMappingExposure = v;
      },
      setPostFx: (values: Record<string, number | boolean>) => {
        Object.assign(POSTFX_TUNING.values, values);
        pipeline.applyPostFx(); // rebuild the chain for the toggles + push uniforms
      },
      launchBoatFireworks: (forward: THREE.Vector3) => {
        boatLaunchers?.fireAll({
          scene,
          fireworks,
          rocketRiders,
          map,
          playerPos: player.position,
          forward,
          hostVelocity: player.velocity
        });
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
  loadingLabel.textContent = String(err);
  console.error(err);
});
