import * as THREE from "three/webgpu";
import { Inspector } from "three/addons/inspector/Inspector.js";
import CameraControls from "camera-controls";
import { CONFIG, DEBRIS_TUNING, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING, type ShadowQuality } from "./config";
import { loadPlayerState, resetAllTweaks, savePlayerState } from "./core/persist";
import { Input } from "./core/input";
import { WorldMap, waterHeight } from "./world/heightmap";
import { Sky, PRE_SUNSET_TIME, SKY_TUNING } from "./world/sky";
import { Water } from "./world/water";
import { TileStreamer } from "./world/tiles";
import { Physics } from "./core/physics";
import { createDebrisMaterial, DEBRIS_LIGHTS, WINDOW_GLOW } from "./world/facade";
import { updateCrownDisplay, resetCrownTweaks } from "./world/salesforceCrown";
import { createBayLights, updateBayLights, resetBayLightsTweaks } from "./world/bayLights";
import { createGoldenGateLights, updateGoldenGateLights, resetGoldenGateLightsTweaks } from "./world/goldenGateLights";
import { createPalaceGlow, updatePalaceGlow, resetPalaceGlowTweaks } from "./world/palaceGlow";
import { createPalaceColonnade, PALACE_RING_BUILDINGS } from "./world/palaceColonnade";
import { createSutroTower, updateSutroTower, resetSutroLightsTweaks } from "./world/sutroTower";
import { findOpenSpawn } from "./world/spawn";
import { Player } from "./player/player";
import type { PlayerMode } from "./player/types";
import { ChaseCamera } from "./core/camera";
import { FX } from "./fx/fx";
import { ProjectileTracers } from "./fx/projectile";
import { Shockwaves } from "./fx/shockwave";
import { BoardWake, WakeRipples } from "./fx/wake";
import { BirdTrails } from "./fx/birdTrail";
import { WaterSplashes } from "./fx/splash";
import { Fireworks } from "./fx/fireworks";
import { Graffiti, PAINT_COLORS } from "./fx/graffiti";
import { Paintballs, PaintSkins, PAINTBALL_SPEED, type PaintTarget } from "./fx/paintball";
import { Bubbles } from "./fx/bubbles";
import { Chimes } from "./fx/chimes";
import { Toolbar, TOOL_ORDER, TOOL_VERB, type ToolName } from "./ui/toolbar";
import { AvatarSelector } from "./ui/avatarSelector";
import { AudioControls } from "./ui/audioControls";
import { VehicleAudio } from "./fx/vehicleAudio";
import { Props } from "./gameplay/props";
import { Traffic, DRIVE_PROFILES, type VehicleClass } from "./gameplay/traffic";
import { AbandonedMounts } from "./gameplay/abandonedMounts";
import { HorseHerd } from "./gameplay/horse/horseHerd";
import { RocketRiders, type LauncherRig } from "./gameplay/launchers";
import { Flyover } from "./gameplay/flyover";
import { BridgeParade } from "./gameplay/bridgeParade";
import { BridgeShow } from "./gameplay/bridgeShow";
import { effectsAudioLevel } from "./core/audioSettings";
import { Creatures } from "./gameplay/creatures";
import { Forest, ANIMALS, type AnimalKind } from "./gameplay/forest";
import { Flora } from "./world/flora";
import { Islands } from "./gameplay/islands";
import { Exploratorium, WATER_VIEW } from "./gameplay/exploratorium";
import { PALACE_FINE_ARTS } from "./world/heightmap";
import { Loot } from "./gameplay/loot";
import { Hunt } from "./gameplay/hunt";
import { Quidditch, QUIDDITCH_PITCH, type QuidditchRole, type QuidditchTeam } from "./gameplay/quidditch";
import { QuidditchHUD, type QuidditchStartMode } from "./ui/quidditchHud";
import { QuidditchAudio } from "./fx/quidditchAudio";
import { Ropes, Grabber, type PickCandidate } from "./gameplay/ropes";
import { Satchel } from "./ui/satchel";
import { HUD } from "./ui/hud";
import { ShareButton } from "./ui/share";
import { BehindTheScenes } from "./ui/behindTheScenes";
import { Tutorial } from "./ui/tutorial";
import { createRenderPipeline } from "./render/pipeline";
import { POSTFX_TUNING } from "./render/postfx";
import { DebugPanel } from "./ui/debug";
import { Net, makeFunName } from "./net/net";
import { RemotePlayers } from "./net/remotes";
import { Voice } from "./net/voice";
import { Minimap } from "./ui/minimap";
import { PlayerLocator } from "./ui/playerLocator";
import { avatarFromSeed, loadSavedAvatar, randomAvatarTraits, saveAvatarTraits } from "./player/avatar";
import { TRUCK_VISUAL_SCALE } from "./vehicles/truck/dimensions";
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
let startGame: ((typedName: string) => void) | null = null;

function focusNameInput() {
  nameInput.focus({ preventScroll: true });
  nameInput.select();
}

nameInput.value = suggestedName;
startButton.disabled = true;
requestAnimationFrame(focusNameInput);
startForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!startReady || !startGame || startButton.disabled) {
    focusNameInput();
    return;
  }
  startGame(nameInput.value.trim());
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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_TUNING.values.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = RENDER_TUNING.values.exposure; // reference grading: physical sun (~100) + low exposure
  renderer.shadowMap.enabled = RENDER_TUNING.values.shadowQuality !== "off";
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

  progress(40, "streaming the city");
  const tiles = new TileStreamer(scene);
  await tiles.init(map);

  const physics = await Physics.create(map, tiles);

  progress(62, "waking up san francisco");
  const input = new Input(renderer.domElement);
  const hud = new HUD();
  const modeDiscovery = new ModeDiscovery();
  const fx = new FX(scene);
  const shockwaves = new Shockwaves(scene);
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
  const audioControls = new AudioControls();

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
  const truckLaunchers = player.meshes.truck.userData.launcherRig as LauncherRig | undefined;
  const boatLaunchers = player.meshes.speedboat.userData.launcherRig as LauncherRig | undefined;
  if (START.mode !== "walk") player.trySwitch(START.mode);
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

  // the playground layer: physics-toy discovery sites at the landmarks, ambient
  // traffic you can commandeer with E, and the local wildlife
  const props = new Props(physics, map, scene);
  props.onDiscover = (name) => hud.message(`Discovered: ${name}`, 4);
  const traffic = new Traffic(physics, map, scene);
  const creatures = new Creatures(map, scene);
  const forest = new Forest(map, scene);
  const abandonedMounts = new AbandonedMounts(physics, map, scene);
  // RL horses roaming Golden Gate Park — live box3d ragdolls running the trained
  // policy, with their neural activations bubbling over their heads.
  const horseHerd = new HorseHerd(physics, map, scene);
  const rocketRiders = new RocketRiders(scene, map);
  // "-" spectacle: planes + phoenixes overhead, boats under the Golden Gate
  const flyover = new Flyover(scene);
  const bridgeParade = new BridgeParade(scene, map);
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
  // vegetation layer: park trees + grass masks ride the tile stream; the grass
  // field and Marin near-forest follow the camera (physics hooked unload first)
  const flora = new Flora(map, scene, tiles.manifest);
  tiles.onTileGreens = (key, group) => flora.onTileGreens(key, group);
  const prevTileUnload = tiles.onTileUnload;
  tiles.onTileUnload = (key) => {
    prevTileUnload(key);
    flora.dropTile(key);
  };
  const islands = new Islands(physics, map, scene);

  // the Exploratorium: Pier 15 rebuilt walkable — replaces the OSM shed and
  // gates every exhibit (GPU sims, dome show, colliders) on actual presence
  const exploratorium = new Exploratorium(renderer, physics, map, scene, tiles);
  exploratorium.onMessage = (m, s) => hud.message(m, s);

  // the Fortnite-ish layer: treasure chests raining coins, critters to hunt,
  // and the Garry's-Mod rope/grab click-tools (loot.ts / hunt.ts / ropes.ts)
  const satchel = new Satchel();
  const loot = new Loot(physics, map, scene);
  loot.onCollect = (kind, n) => satchel.add(kind, n);
  loot.onOpen = () => hud.message("Treasure! Grab the coins", 2.2);
  loot.onFireworks = (x, y, z) => fireworks.launchCelebration(x, y, z);
  const hunt = new Hunt(map, scene);
  hunt.onCatch = (kind) => {
    satchel.add(kind);
    hud.message(kind === "crab" ? "Crab caught!" : "Butterfly caught!", 1.1);
  };
  const quidditch = new Quidditch(map, scene);
  const quidHud = new QuidditchHUD();
  const quidAudio = new QuidditchAudio();
  quidditch.onMessage = (m, s) => hud.message(m, s);
  quidditch.onActiveChange = (on) => quidHud.setActive(on);
  quidditch.onWhistle = () => quidAudio.whistle();
  quidditch.onScore = (team, red, blue, x, y, z) => {
    quidHud.setScores(red, blue);
    quidHud.flashGoal(team);
    quidHud.noteTutorial("score");
    fireworks.launchCelebration(x, y, z, 2);
    chase.shake(0.08);
  };
  quidditch.onSnitchCaught = (team, red, blue) => {
    quidAudio.snitch();
    quidHud.setScores(red, blue);
    quidHud.setSnitch(true, team);
    quidHud.noteTutorial("snitch");
    // a golden shower of fireworks over the pitch to crown the winner
    fireworks.launchCelebration(QUIDDITCH_PITCH.x, map.effectiveGround(QUIDDITCH_PITCH.x, QUIDDITCH_PITCH.z) + 40, QUIDDITCH_PITCH.z);
    chase.shake(0.16);
  };
  quidditch.onBludgerHit = (x, y, z, hitPlayer) => {
    quidAudio.bludger();
    if (hitPlayer) chase.shake(0.22);
  };
  // Role picker → actually take the broom
  quidHud.onPickRole = (team, role, mode) => joinQuidditchRole(team, role, mode);
  quidHud.onCloseModal = () => {
    if (!input.suspended && document.body.classList.contains("started")) input.requestLock();
  };
  const ropes = new Ropes(physics, scene);
  const grabber = new Grabber(physics, scene);
  grabberRef = grabber;
  // bodies owned by props/traffic can vanish (zones retire, cars despawn or get
  // commandeered) — ropes and the grab beam must let go BEFORE the destroy
  const releaseBody = (h: number) => {
    ropes.severBody(h);
    grabber.dropIf(h);
  };
  props.onWillRemoveBody = releaseBody;
  traffic.onWillRemoveBody = releaseBody;
  const pickables: PickCandidate[] = [];
  const gatherPickables = () => {
    pickables.length = 0;
    props.collectPickables(pickables);
    for (const v of traffic.vehicles) {
      const he = DRIVE_PROFILES[v.cls].halfExtents;
      pickables.push({ handle: v.handle, x: v.pos.x, y: v.pos.y, z: v.pos.z, r: Math.hypot(he[0], he[1], he[2]) + 0.5 });
    }
    return pickables;
  };

  const bayLights = createBayLights(map);
  if (bayLights) scene.add(bayLights);
  const goldenGateLights = createGoldenGateLights(map);
  if (goldenGateLights) scene.add(goldenGateLights);
  const palaceGlow = createPalaceGlow(map);
  scene.add(palaceGlow);
  // Palace of Fine Arts peristyle: the OSM data carries the curved colonnade as
  // ordinary windowed buildings, so swap them for a real open row of columns.
  for (const b of PALACE_RING_BUILDINGS) tiles.suppressBuilding(b.key, b.index);
  scene.add(createPalaceColonnade(map));
  const sutroTower = createSutroTower(map);
  scene.add(sutroTower);
  let currentRide: VehicleClass | null = null;
  let currentAnimal: AnimalKind | null = null;
  let currentQuidditch: { team: "red" | "blue"; role: QuidditchRole } | null = null;
  // Take over a specific open broom (from the role picker). Mounts the drone
  // with the team-tinted broom and drops the player onto that flyer's spot.
  function joinQuidditchRole(team: QuidditchTeam, role: QuidditchRole, startMode: QuidditchStartMode = "play") {
    const info = quidditch.joinAs(team, role, player.position);
    if (!info) {
      hud.message("That position was just taken — try another", 2);
      return;
    }
    currentQuidditch = { team: info.team, role: info.role };
    player.setDroneStyle(quidditch.buildRiddenMesh(info.team));
    player.position.set(info.x, info.y, info.z);
    player.heading = info.heading;
    player.velocity.set(info.vx, info.vy, info.vz);
    player.trySwitch("drone");
    quidHud.setRole(info.label);
    if (startMode === "tutorial") quidHud.startTutorial(info.label, info.role);
    else quidHud.stopTutorial();
    const verb = role === "Beater" ? "swat Bludgers" : role === "Seeker" ? "catch the Snitch" : role === "Keeper" ? "guard the hoops" : "sling the Quaffle";
    hud.message(startMode === "tutorial" ? `Tutorial started — ${verb}` : `You're the ${info.label} — ${verb}! E to dismount`, 3.4);
  }
  let currentPaint: number | undefined; // commandeered car's paint, so invites clone the exact look
  let zeroG = false;
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
  let cameraMode = false;

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

  input.onLockChange = (locked) => {
    if (!locked && !cameraMode) hud.message("Click to capture the mouse · Esc releases it", 2.8);
  };

  const showUi = () => {
    if (!uiOpen) {
      uiOpen = true;
      hud.setFaded(false);
    }
  };
  document.querySelector<HTMLButtonElement>("[data-ui-restore]")!.addEventListener("click", showUi);

  physics.onExplosion = (pos, radius) => {
    fx.explosion(pos, radius);
    shockwaves.spawn(pos, radius);
    const d = pos.distanceTo(player.position);
    chase.shake(Math.max(0, 1.1 - d / 60));
  };
  physics.onFracture = (pos, vol, height) => {
    // dust plume up the building's height as it comes down
    fx.fractureDust(pos, vol);
    if (height > 12) fx.fractureDust(new THREE.Vector3(pos.x, pos.y + height * 0.45, pos.z), vol * 0.7);
    if (height > 30) fx.fractureDust(new THREE.Vector3(pos.x, pos.y + height * 0.85, pos.z), vol * 0.5);
  };
  physics.onHardImpact = (pos, speed) => {
    fx.impactPuff(pos);
    chase.shake(Math.min(0.7, speed / 40));
  };

  hud.setMode(player.mode);

  // post-processing: SSAO folded into the lit pass + optional stylized screen effects
  const pipeline = createRenderPipeline(renderer, scene, camera);

  // ---- multiplayer: presence relay (src/net/net.ts) + remote avatars +
  // minimap. Drop-in social layer: movement stays client-authoritative, the
  // server only relays poses, and losing the socket never breaks single-player.
  // Send a custom avatar only if the player actually chose one; a null avatar
  // lets the server keep its per-id seed (server.mjs), so un-customized players
  // stay distinct instead of all sending the same saved blob.
  const net = new Net(suggestedName, savedAvatar ?? undefined);
  const avatarSelector = new AvatarSelector(avatarTraits, (traits) => {
    avatarTraits = traits;
    customized = true; // an explicit edit — persist it and broadcast from here on
    saveAvatarTraits(traits);
    player.setAvatar(traits);
    net.setAvatar(traits);
  });
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
  // museum jam session: my notes go out, friends' notes play the same
  // flash + dome ripple here (audible only if I'm actually at the theater)
  exploratorium.onNote = (inst, key) => {
    net.sendNote(inst, key);
    tutorial.note("note"); // the tutorial's museum chapter counts these
  };
  net.onNote = (_id, inst, key) => exploratorium.remoteNote(inst, key);
  // shared skies: my rocket launches go out, friends' volleys replay here
  fireworks.onVolley = (rockets) => net.sendFireworks(rockets);
  net.onFireworks = (_id, rockets) => fireworks.launchRemote(rockets);

  // passenger seat support: remotes resolves "riding MY car" through this
  remotes.localDriveMesh = () => (player.mode === "drive" && !player.riding ? player.meshes.drive : null);

  // riding shotgun in a friend's car: who's driving me (null = on my own).
  // The pose glue runs each frame in the render loop; every mode change,
  // respawn or teleport goes through leaveRide first.
  let passengerOf: number | null = null;
  let ridingHorse = -1; // index of the RL horse the player is riding, or -1
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
  startGame = (typedName) => {
    net.setName(typedName);
    nameInput.blur(); // hand the keyboard back to the game
    document.body.classList.add("started"); // reveals the HUD (hidden behind the gate)
    loading.classList.add("done");
    input.requestLock(); // the submit click/Enter is the user gesture pointer lock needs
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
    if (mode === "drive" && currentRide) return Math.max(2.8, DRIVE_PROFILES[currentRide].halfExtents[0] + 1.7);
    if (mode === "drive" && currentAnimal) return currentAnimal === "bear" ? 3.0 : 2.4;
    if (mode === "plane" || mode === "boat") return 6.5;
    if (mode === "drone" || mode === "board" || mode === "bird") return 2.8;
    return 2.4;
  };
  const dropCurrentDriveMount = (motion = readPlayerMotion()) => {
    let dropped = false;
    if (currentRide) {
      const mount = player.meshes.drive.position;
      traffic.releaseVehicle(currentRide, mount.x, mount.z, player.heading - Math.PI, {
        paint: currentPaint,
        y: mount.y,
        linear: motion.linear,
        angular: motion.angular
      });
      currentRide = null;
      currentPaint = undefined;
      player.setDriveStyle(null);
      dropped = true;
    }
    if (currentAnimal) {
      const mount = player.meshes.drive.position;
      forest.dropAnimal(currentAnimal, mount.x, mount.z, player.heading - Math.PI, { speed: motion.horizontalSpeed });
      currentAnimal = null;
      currentPaint = undefined;
      player.setDriveStyle(null);
      dropped = true;
    }
    if (currentQuidditch) {
      quidditch.dropFlyer(
        currentQuidditch.team,
        currentQuidditch.role,
        player.position.x,
        player.position.y,
        player.position.z,
        player.heading - Math.PI,
        { vx: motion.linear[0], vy: motion.linear[1], vz: motion.linear[2] }
      );
      currentQuidditch = null;
      player.clearDroneStyle();
      quidHud.setRole(null);
      quidHud.stopTutorial();
      dropped = true;
    }
    return dropped;
  };
  /** E (or pad B): leave any vehicle, creature, or passenger seat for on-foot. */
  const exitToWalk = () => {
    if (ridingHorse >= 0) {
      horseHerd.dismount();
      ridingHorse = -1;
      player.position.x += Math.cos(player.heading) * 2.2;
      player.position.z -= Math.sin(player.heading) * 2.2;
      player.endRide();
      hud.message("Off the horse", 1.8);
      return true;
    }
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
    const record = mode !== "walk";
    if (record) beginPlaceNavigation("Previous place");
    leaveRide(); // a mode key while riding shotgun hops out first
    if ((currentRide || currentAnimal || currentQuidditch) && mode !== "drive" && mode !== "drone") dropCurrentDriveMount();
    if (mode === "drive" && !currentRide && !currentAnimal) player.setDriveStyle(null);
    if (mode === "drone" && !currentQuidditch) player.clearDroneStyle();
    // Always spawn a fresh mount — any one you left behind keeps living its own
    // life (the phoenix flies on, the plane lies where it crashed).
    player.trySwitch(mode);
    if (record) finishPlaceNavigation(`${mode} place`);
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
      } else if (toName === "Exploratorium") {
        // land inside, in front of the Water Works wave-tank screen, facing it
        player.respawn({ x: WATER_VIEW.x, z: WATER_VIEW.z, heading: WATER_VIEW.facing });
      } else if (toName === QUIDDITCH_PITCH.name) {
        dropCurrentDriveMount();
        if (player.mode !== "walk") player.trySwitch("walk");
        quidHud.stopTutorial();
        player.respawn({ x: QUIDDITCH_PITCH.x, z: QUIDDITCH_PITCH.z, heading: -Math.PI / 2 });
      } else if (toName === "Horse Paddock") {
        // the horses live on a raised platform above the buggy hill — put the
        // rider up on it too (respawn grounds them, then lift onto the deck).
        dropCurrentDriveMount();
        if (player.mode !== "walk") player.trySwitch("walk");
        player.respawn({ x, z, heading });
        const py = horseHerd.platformY + 1.5;
        player.position.y = py;
        physics.world.setBodyTransform(player.body, [x, py, z], [0, Math.sin(heading / 2), 0, Math.cos(heading / 2)]);
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
  // chaptered walkthrough — movement, climbing, vehicles, the map, and a field
  // trip into the Exploratorium. It only reads through this thin context;
  // one-shot events (teleports, piano notes) arrive via tutorial.note().
  const tutorial = new Tutorial({
    mode: () => player.mode,
    pos: () => player.position,
    climbing: () => player.climbing,
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
    pipeline
  );
  debugPanel.setMode(player.mode);

  // ?j=x,y,z,facing,mode[,ride[,paint]] — invite links from the Share button.
  // A friend opening one spawns right where the sharer stood, in the same kind
  // of vehicle (commandeered taxi/bus/cable car and ridden animals included).
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
    const ride = p[5] && p[5] in DRIVE_PROFILES ? (p[5] as VehicleClass) : null;
    const animal = p[5] && p[5] in ANIMALS ? (p[5] as AnimalKind) : null;
    const paint = p[6] ? parseInt(p[6], 16) : NaN;
    return { x, y, z, facing, mode, ride, animal, paint: Number.isFinite(paint) ? paint : undefined, from: q.get("via") };
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
    if (invite.ride) {
      currentRide = invite.ride;
      currentPaint = invite.paint;
      player.setDriveStyle(traffic.buildMesh(invite.ride, invite.paint), DRIVE_PROFILES[invite.ride]);
      mode = "drive";
    } else if (invite.animal) {
      currentAnimal = invite.animal;
      player.setDriveStyle(forest.buildRiddenMesh(invite.animal), ANIMALS[invite.animal].spec);
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
  // right now — position, facing, mode, and the exact ride if I'm in one
  const buildShareUrl = () => {
    const facing = player.heading - Math.PI; // player.heading stores facing+π
    const parts = [
      player.position.x.toFixed(1),
      player.position.y.toFixed(1),
      player.position.z.toFixed(1),
      facing.toFixed(2),
      player.riding ? "walk" : player.mode // a passenger's friend joins on foot beside the car
    ];
    if (!player.riding && player.mode === "drive") {
      if (currentAnimal) parts.push(currentAnimal);
      else if (currentRide) parts.push(currentRide, (currentPaint ?? 0).toString(16));
    }
    return `${location.origin}${location.pathname}?j=${parts.join(",")}&via=${encodeURIComponent(net.name)}`;
  };
  new ShareButton(buildShareUrl, (ok) =>
    hud.message(ok ? "Invite link copied — send it to a friend" : "Couldn't copy the link", 3.2)
  );

  // "Behind the scenes" overlay + X/GitHub links (top-right, under Tutorial).
  // Free the pointer lock while it's open so the cursor can reach the links.
  new BehindTheScenes((open) => {
    input.suspended = open || cameraMode;
    if (open) input.releaseLock();
    else if (!cameraMode) input.requestLock();
  });

  // debris instancing: chunks keep the facade look. Per-instance attributes carry
  // the building tone/baseY, the parent bid + chunk half extents, and the frozen
  // spawn pose (centre + yaw) the shader evaluates the facade pattern in.
  const debrisGeo = new THREE.BoxGeometry(2, 2, 2);
  const debrisTone = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.maxDebris * 4), 4);
  debrisTone.setUsage(THREE.DynamicDrawUsage);
  const debrisInfo = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.maxDebris * 4), 4);
  debrisInfo.setUsage(THREE.DynamicDrawUsage);
  const debrisSpawn = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.maxDebris * 4), 4);
  debrisSpawn.setUsage(THREE.DynamicDrawUsage);
  const debrisAnim = new THREE.InstancedBufferAttribute(new Float32Array(CONFIG.maxDebris * 2), 2);
  debrisAnim.setUsage(THREE.DynamicDrawUsage);
  const debrisMat = createDebrisMaterial(debrisTone, debrisInfo, debrisSpawn, debrisAnim);
  const debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, CONFIG.maxDebris);
  debrisMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  debrisMesh.count = 0;
  debrisMesh.frustumCulled = false;
  debrisMesh.castShadow = true;
  scene.add(debrisMesh);

  // projectile tracers: instanced TSL energy orbs (fx/projectile.ts)
  const tracers = new ProjectileTracers(scene);

  const mat4 = new THREE.Matrix4();
  const quat = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const aim = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3(); // aimOrigin returns a shared tmp — keep our own copy
  const paintDir = new THREE.Vector3();
  const paintVel = new THREE.Vector3();
  const paintMuzzle = new THREE.Vector3();
  const paintTmp = new THREE.Vector3();
  const paintTargets: PaintTarget[] = [];
  // hit spheres for paint-vs-player, per embodiment: radius + centre lift
  const PAINT_HIT: Record<PlayerMode, { r: number; y: number }> = {
    walk: { r: 1.05, y: 0.95 },
    board: { r: 1.15, y: 1.0 },
    drive: { r: 2.3, y: 0.8 },
    plane: { r: 3.2, y: 1.0 },
    boat: { r: 4.5, y: 1.8 },
    speedboat: { r: 3.2, y: 1.2 },
    drone: { r: 0.9, y: 0.3 },
    bird: { r: 1.0, y: 0.5 },
    truck: { r: 3.6 * TRUCK_VISUAL_SCALE, y: 1.5 * TRUCK_VISUAL_SCALE }
  };

  let fireCooldown = 0;

  // Warm the GPU pipelines while the loading screen still covers the canvas.
  // First render lets the CSM shadow node build its cascade lights (that build
  // changes the scene light set once, and anything compiled before it would
  // need a second compile after). Then one render with every embodiment's
  // meshes visible compiles all the vehicle materials up front. Vehicle lamps
  // come from Player's fixed-size LightPool (always in the scene), so this is
  // the only compile the vehicles ever pay — later mode switches recompile
  // nothing. Culling is off so the meshes still parked at the origin draw no
  // matter where the camera looks.
  progress(88, "warming up the vehicles");
  sky.update(0, camera.position);
  pipeline.render();
  player.warmup(true);
  fx.prewarm(); // compiles both sprite blend pipelines before gameplay
  const unculled: THREE.Object3D[] = [];
  for (const m of Object.values(player.meshes)) {
    m.traverse((o) => {
      if (o.frustumCulled) {
        o.frustumCulled = false;
        unculled.push(o);
      }
    });
  }
  pipeline.render();
  // let the GPU process flush the compiles; hidden tabs never fire rAF
  // (headless/preview verification), so a timer backstops the wait
  await new Promise((r) => {
    requestAnimationFrame(r);
    setTimeout(r, 350);
  });
  for (const o of unculled) o.frustumCulled = true;
  player.warmup(false);

  progress(100, "ready");
  // Load done: enable Start (form already sits over the idling city), fade the
  // opaque backdrop and re-focus in case the player clicked away while waiting.
  startReady = true;
  startButton.disabled = false;
  loading.classList.add("ready");
  focusNameInput();
  // headless verification, demos and perf runs can't click — skip the gate
  const skipGate = ["autostart", "demo", "profile"].some((k) => new URLSearchParams(location.search).has(k));
  if (skipGate) loading.classList.add("done");

  const timer = new THREE.Timer();
  let accumulator = 0;
  let elapsed = 0;
  let paused = false;
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

  // "/" drives the tuning pane + inspector as one debug-UI switch; I (immersive)
  // hides every scrap of UI, stashing the debug state to restore on exit
  let debugOn = false;
  let debugWasOn = false;
  const setDebugUI = (on: boolean) => {
    debugOn = on;
    if (debugPanel.visible !== on) debugPanel.toggle();
    setInspector(on);
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

  // A demo can install a per-frame cinematic controller: it fully owns the
  // truck's render pose AND the camera for a scripted shot (see dev/demo.ts
  // "bridge"). Runs at the camera step, replacing the chase cam.
  let cineHook: ((dt: number) => void) | null = null;

  // The Golden Gate "Freedom Truck" hero shot as a live experience: press `]`
  // and it drops you onto the span in the truck and rolls the same on-rails
  // drive/orbit/barrage as the rendered reel, in real time, with input left live
  // so other toys can play over the top of the locked shot.
  const bridgeShow = new BridgeShow({
    map,
    player,
    physics,
    chase,
    hud,
    effectsLevel: effectsAudioLevel,
    fireGuns: (fwd: THREE.Vector3) =>
      truckLaunchers?.fireAll({
        scene,
        fireworks,
        rocketRiders,
        map,
        playerPos: player.position,
        forward: fwd,
        hostVelocity: player.velocity
      }),
    setCine: (fn) => {
      cineHook = fn;
    },
    configureEnv: () => {
      sky.cycleEnabled = false;
      sky.sunsetAzimuth = 250;
      sky.setTimeOfDay(18.85);
      sky.nightBrightness = 2.15;
      renderer.toneMappingExposure = 0.2;
      Object.assign(POSTFX_TUNING.values, {
        ink: true,
        inkStrength: 0.7,
        inkWidth: 1.5,
        dream: false,
        retro: true,
        retroPixel: 1,
        retroLevels: 8,
        retroScan: 0.35
      });
      pipeline.applyPostFx();
    },
    restoreEnv: () => {
      Object.assign(POSTFX_TUNING.values, { ink: false, retro: false });
      pipeline.applyPostFx();
    },
    flyover,
    musicUrl: "/audio/rockin.mp3"
  });

  const tick = (forcedDt?: number) => {
    timer.update();
    const frameDt = forcedDt ?? Math.min(timer.getDelta(), 0.09);

    // gamepad first so its synthetic key codes exist for every consumer below
    input.pollPad(frameDt);

    // P freezes the whole game — player, physics, fx, sky, water, crown.
    // We keep rendering the frozen frame so the window stays live.
    if (input.pressed("KeyP")) {
      paused = !paused;
      hud.message(paused ? "Paused — P to resume" : "Resumed", paused ? Infinity : 2.6);
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

    if (paused) {
      vehicleAudio.update(frameDt, null); // fade the hum out while frozen
      // stay social while frozen: peers keep moving, our keepalive keeps flowing
      net.sendState(player.mode, player.meshes[player.mode].position, player.meshes[player.mode].quaternion, 0, passengerOf ?? 0);
      remotes.selfId = net.selfId;
      remotes.update(frameDt);
      // if a friend is still driving me around, stay in the seat while frozen
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

    elapsed += frameDt;
    accumulator += frameDt;

    // Plain number keys select click-tools; Shift+number still teleports to player slots.
    const numberPressed = (i: number) => input.pressed(`Digit${i}`) || input.pressed(`Numpad${i}`);
    const shiftedNumberPress = (i: number) => input.shiftedPress(`Digit${i}`) || input.shiftedPress(`Numpad${i}`);
    // seated at the piano the digits play notes (handlePianoInput below) — the
    // tool switcher stands down so hitting "3" plays the instrument instead
    if (!exploratorium.pianoBusy && !exploratorium.plaqueOpen)
      for (let i = 1; i <= 9; i++) {
        if (!numberPressed(i)) continue;
        // Snapshot Shift from the digit's keydown event; a stale held-key entry
        // should never turn a plain number press into a player-slot teleport.
        if (!shiftedNumberPress(i)) {
          const nextTool = TOOL_ORDER[i - 1];
          if (nextTool) setTool(nextTool);
          continue;
        }
        const target = playerLocator.targetForDigit(i);
        if (target) teleportToTarget(target.x, target.z, target.name, target.id);
        else hud.message(`No player in slot ${i}`, 1.9);
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

    // E: Exploratorium piano, then exit any vehicle/creature, or on foot hop
    // into the nearest car (a friend's passenger seat wins over parked traffic)
    if (input.pressed("KeyL")) {
      // L: train the horses LIVE in a worker — watch the herd learn in the patch
      if (horseHerd.training) {
        horseHerd.stopTraining();
        hud.message("Live horse training: stopped", 2);
      } else {
        horseHerd.startTraining((p) => {
          if (p.gen % 4 === 0) hud.message(`Training live — gen ${p.gen} · fitness ${p.fitness} (best ${p.best})`, 1.3);
        });
        hud.message("Live horse training started — watch the herd learn (L stops)", 3);
      }
    }
    if (input.pressed("KeyE") && exploratorium.tryInteract()) {
      // consumed E inside the museum: seated at the dome piano, or opened/closed
      // a plaque — only the piano advances the tutorial
      if (exploratorium.pianoBusy) tutorial.note("piano");
    } else if (input.pressed("KeyE") && !exitToWalk()) {
        const drv = remotes.nearestDriver(player.position, 5.5);
        // standing in the pitch's join circle: open the position picker instead
        // of auto-assigning, so you can choose Seeker / Beater / Chaser / Keeper
        const wantQuid = !drv && !currentQuidditch && quidditch.inJoinZoneAt(player.position);
        const animal = drv || wantQuid ? null : forest.nearest(player.position, 5);
        const horseNear = drv || wantQuid || animal ? -1 : horseHerd.nearest(player.position.x, player.position.z, 3.5);
        if (drv) {
          passengerOf = drv.id;
          player.startRide();
          hud.message(`Riding with ${drv.name} — E to hop out`, 2.6);
        } else if (wantQuid) {
          const open = quidditch.openRoles();
          if (open.length) quidHud.showStart(open);
          else hud.message("Every broom is taken right now", 2);
        } else if (animal) {
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
        } else if (horseNear >= 0) {
          ridingHorse = horseNear;
          horseHerd.mount(horseNear);
          player.startRide();
          hud.message("You're on the RL horse — look to steer, E to hop off", 3.2);
        } else {
          // re-board a vehicle/creature you left behind — walk up, press E,
          // just like a parked car (the phoenix, a crashed plane, a hoverboard…)
          const mount = abandonedMounts.boardNearest(player.position.x, player.position.z, 5.5);
          const v = mount ? null : traffic.nearest(player.position, 5.5);
          if (mount) {
            if (mount.mode === "drive") player.setDriveStyle(null);
            player.position.set(mount.x, mount.y, mount.z);
            player.heading = mount.heading;
            player.trySwitch(mount.mode);
            hud.message("Back on board — E to hop off", 2.4);
          } else if (v) {
            const info = traffic.consume(v);
            currentRide = info.cls;
            currentPaint = info.paint;
            player.setDriveStyle(traffic.buildMesh(info.cls, info.paint), DRIVE_PROFILES[info.cls]);
            player.position.set(info.x, player.position.y, info.z);
            player.heading = info.heading + Math.PI; // storage convention is facing+π
            player.trySwitch("drive");
            hud.message(`You're driving the ${DRIVE_PROFILES[info.cls].label}!`, 2.6);
          }
        }
    }
    exploratorium.handlePianoInput((c) => input.pressed(c));

    // G: zero-g playground (props + ragdolls float off)
    if (input.pressed("KeyG")) {
      zeroG = !zeroG;
      props.setZeroG(zeroG);
      ropes.setZeroG(zeroG);
      hud.message(zeroG ? "Zero-G — the toys are floating" : "Gravity restored", 2.4);
    }
    if (input.pressed("KeyR")) {
      leaveRide();
      player.respawn(spawn);
      hud.message("Back at the start");
    }

    // "]": drop onto the Golden Gate and roll the exact filmed cinematic in real
    // time — truck drives itself, camera on rails, "rockin" from the top. Input
    // stays live so you can play effects over the locked shot; "]" again restarts.
    if (input.pressed("BracketRight")) {
      leaveRide();
      bridgeShow.trigger();
    }

    // ".": factory reset for tweaks — every tweakpane value back to its
    // source-code default, saved tweaks wiped. Player stays put ("R" respawns).
    if (input.pressed("Period")) {
      resetAllTweaks();
      resetCrownTweaks();
      resetBayLightsTweaks();
      resetGoldenGateLightsTweaks();
      resetPalaceGlowTweaks();
      resetSutroLightsTweaks();
      START.spawn = START_DEFAULTS.spawn;
      START.mode = START_DEFAULTS.mode;
      // re-apply the side effects the pane's onChange handlers normally push
      renderer.toneMappingExposure = RENDER_TUNING.values.exposure;
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, RENDER_TUNING.values.maxPixelRatio));
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.shadowMap.enabled = RENDER_TUNING.values.shadowQuality !== "off";
      sky.setShadowQuality(RENDER_TUNING.values.shadowQuality as ShadowQuality);
      CONFIG.tileLoadRadius = WORLD_TUNING.values.radius;
      CONFIG.tileUnloadRadius = WORLD_TUNING.values.radius + 400;
      tiles.forceScan();
      if (scene.fog) (scene.fog as THREE.FogExp2).density = WORLD_TUNING.values.fog;
      DEBRIS_LIGHTS.hold.value = DEBRIS_TUNING.values.hold;
      DEBRIS_LIGHTS.flicker.value = DEBRIS_TUNING.values.flicker;
      DEBRIS_LIGHTS.spread.value = DEBRIS_TUNING.values.spread;
      WINDOW_GLOW.far.value = RENDER_TUNING.values.farWindowGlow ? 1 : 0;
      pipeline.applyPostFx(); // toggles back off + sliders back to defaults
      sky.cycleEnabled = true;
      sky.cycleDuration = SKY_TUNING.values.cycleDuration;
      sky.sunsetAzimuth = SKY_TUNING.values.sunsetAzimuth;
      sky.nightBrightness = SKY_TUNING.values.nightBrightness;
      sky.setTimeOfDay(PRE_SUNSET_TIME);
      debugPanel.syncNow();
      hud.message("Tweaks back to source defaults", 3);
    }
    if (input.pressed("KeyC")) setCameraMode(!cameraMode);
    // V: voice chat mic on/off (same as the HUD mic button)
    if (input.pressed("KeyV")) toggleMic();
    // F: fullscreen (keydown grants the transient activation this needs)
    if (input.pressed("KeyF")) {
      if (document.fullscreenElement) void document.exitFullscreen();
      else void document.documentElement.requestFullscreen().catch(() => hud.message("Fullscreen blocked by browser"));
    }
    // "-" : a flyover of planes + phoenixes streaks over the way you're facing;
    // from the bridge, a flotilla of boats sails through underneath it too
    if (input.pressed("Minus") || input.pressed("NumpadSubtract")) {
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(player.meshes[player.mode].quaternion);
      fwd.y = 0;
      if (fwd.lengthSq() < 1e-4) fwd.set(Math.sin(player.heading - Math.PI), 0, -Math.cos(player.heading - Math.PI));
      fwd.normalize();
      flyover.trigger(player.renderPosition, fwd);
      const underBridge = bridgeParade.trigger(player.renderPosition, fwd);
      hud.message(underBridge ? "Flyover! 🛩️🔥🦅  — boats under the bridge ⛵️" : "Flyover! 🛩️🔥🦅", 2.4);
    }
    updateCrownDisplay(frameDt);
    updateBayLights(frameDt);
    updateGoldenGateLights(frameDt);
    // the Palace orb (and its 400+ drifting motes) only runs with someone
    // near enough to see it — same locality rule as the Exploratorium rooms
    const palaceNear =
      (player.position.x - PALACE_FINE_ARTS.x) ** 2 + (player.position.z - PALACE_FINE_ARTS.z) ** 2 < 1100 * 1100;
    if (palaceGlow.visible !== palaceNear) palaceGlow.visible = palaceNear;
    if (palaceNear) updatePalaceGlow(frameDt);
    // Sutro's beacons are visible city-wide (that's the point) — keep the tiny
    // sprite set resident and just advance its blink clock every frame.
    updateSutroTower(frameDt);

    // left-click tools, all along the true view direction: paint sticks to
    // whatever the center-screen ray lands on, bubbles ride the wand, chimes ring
    // the struck surface (pitch keyed to strike height)
    fireCooldown -= frameDt;
    if (
      !input.suspended &&
      input.firePressed &&
      fireCooldown <= 0 &&
      currentQuidditch?.role === "Beater" &&
      quidditch.active
    ) {
      // Beater: swing the bat at the nearest bludger along the aim ray
      chase.lookDir(aim);
      if (quidditch.swingBat(player.aimOrigin, aim)) {
        quidHud.noteTutorial("action");
        fireCooldown = 0.34;
        chase.shake(0.12);
      }
    } else if (
      !input.suspended &&
      input.firePressed &&
      fireCooldown <= 0 &&
      quidditch.canThrow(player.position)
    ) {
      chase.lookDir(aim);
      rayOrigin.copy(player.aimOrigin);
      if (quidditch.throwQuaffle(rayOrigin, aim, player.velocity)) {
        quidHud.noteTutorial("action");
        fireCooldown = 0.28;
        chase.shake(0.07);
      }
    } else if (player.mode === "drone") {
      if (!input.suspended && input.firePressed && fireCooldown <= 0) {
        chase.lookDir(aim);
        fireCooldown = 0.22;
        fireworks.launchDroneSalvo(droneFireworkMounts ?? [], aim, player.velocity);
        chase.shake(0.08);
      }
    } else if (player.mode === "truck") {
      // parade truck: one press launches the whole rocket battery in the bed —
      // they fly out ahead and burst into a two-stage red/white/blue show
      if (!input.suspended && input.firePressed && fireCooldown <= 0 && truckLaunchers) {
        chase.lookDir(aim);
        fireCooldown = 0.6;
        const truckFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(player.quaternion);
        truckFwd.y = 0;
        truckLaunchers.fireAll({
          scene,
          fireworks,
          rocketRiders,
          map,
          playerPos: player.position,
          forward: truckFwd,
          hostVelocity: player.velocity
        });
        chase.shake(0.18);
      }
    } else if (player.mode === "speedboat") {
      // freedom boat: one press launches the whole cockpit rocket battery forward
      // over the water — same two-stage red/white/blue barrage as the truck
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
        forest.fireGummy(rayOrigin, aim, player.velocity);
      }
    } else if (
      (input.firing || input.firePressed) &&
      !input.suspended &&
      (chase.lookDir(aim), rayOrigin.copy(player.aimOrigin), exploratorium.handleFire(rayOrigin, aim, input.firePressed, input.firing))
    ) {
      // inside the Exploratorium and aiming at an exhibit: the museum consumed
      // the click (piano key, tank stir, pool poke) — click-tools stand down
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
    let steps = 0;
    while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
      player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
      traffic.prePhysics(physics.world.fixedTimeStep, player.position, sky.timeOfDay, sky.sunsetAzimuth);
      abandonedMounts.prePhysics(physics.world.fixedTimeStep);
      horseHerd.prePhysics(physics.world.fixedTimeStep); // step each horse's private RL sim
      physics.step(physics.world.fixedTimeStep, player.position);
      accumulator -= physics.world.fixedTimeStep;
      steps++;
    }
    if (steps === 3) accumulator = 0;

    // trampolines: launch the walker/boarder standing on a pad
    if ((player.mode === "walk" || player.mode === "board") && !player.riding && steps > 0) {
      const launch = props.padLaunch(player.position, player.velocity.y);
      if (launch !== null) {
        physics.world.setBodyVelocity(player.body, [player.velocity.x, launch, player.velocity.z]);
        chase.shake(0.12);
      }
    }

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
    } else if (ridingHorse >= 0) {
      horseHerd.steer(chase.yaw);
      if (horseHerd.riddenSeat(ridePos, rideQuat)) player.setRidePose(ridePos, rideQuat, frameDt);
      else { horseHerd.dismount(); ridingHorse = -1; player.endRide(); }
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
    props.update(frameDt, player.position);
    traffic.update(player.position, frameDt, sky.timeOfDay, sky.sunsetAzimuth);
    abandonedMounts.update(frameDt, player.position);
    flyover.update(frameDt); // planes + phoenixes streaking over on "-"
    bridgeParade.update(frameDt); // boats crossing under the Golden Gate on "-"
    rocketRiders.update(frameDt, player.position); // the launched guitarists live their own lives
    if (player.mode === "truck") truckLaunchers?.update(frameDt); // idle strum + reload
    if (player.mode === "speedboat") boatLaunchers?.update(frameDt); // guitarist jam + rocket reload
    creatures.update(elapsed, camera.position); // gulls live at altitude — never gated
    forest.update(frameDt, camera.position);
    horseHerd.update(frameDt, camera); // sync ragdoll meshes onto terrain + refresh brain bubbles
    flora.update(camera.position, highUp);
    if (currentAnimal) forest.setRiddenSpeed(player.speed);
    islands.update(elapsed);
    exploratorium.update(frameDt, elapsed, player.position);
    quidditch.update(frameDt, player.position, elapsed);
    if (quidditch.active) {
      const qs = quidditch.scores;
      quidHud.setScores(qs.red, qs.blue);
      if (quidditch.matchState === "playing") quidHud.setSnitch(false);
      // a bludger tagged the human rider: shove them and rattle the camera
      if (currentQuidditch) {
        const kick = quidditch.takeBludgerKick();
        if (kick) {
          player.velocity.x += kick.x;
          player.velocity.y += kick.y;
          player.velocity.z += kick.z;
          chase.shake(0.2);
          hud.message("Bludger! You're knocked off course", 1.4);
        }
      }
    }
    quidHud.update(frameDt, {
      riding: currentQuidditch !== null,
      role: currentQuidditch?.role ?? null,
      x: player.position.x,
      y: player.position.y,
      z: player.position.z,
      speed: player.speed
    });
    loot.update(frameDt, player.position, elapsed);
    if (!highUp) hunt.update(frameDt, elapsed, player.position);
    ropes.update(frameDt, player.position, elapsed);
    if (grabber.holding) {
      // the carry servo chases a point in front of the live camera every frame
      chase.lookDir(aim);
      grabber.update(rayOrigin.copy(player.aimOrigin), aim);
    }

    // "hop in" nudge when standing near a vehicle (a friend's car first, then wildlife)
    if (player.mode === "walk" && passengerOf === null) {
      const drv = remotes.nearestDriver(player.position, 5.5);
      const quidLabel = drv || currentQuidditch ? null : quidditch.joinLabel();
      const nearAnimal = drv || quidLabel ? null : forest.nearest(player.position, 5);
      const near = drv || quidLabel || nearAnimal ? null : traffic.nearest(player.position, 5.5);
      if ((drv || quidLabel || nearAnimal || near) && !ridePromptShown) {
        hud.message(
          drv
            ? `E — ride with ${drv.name}`
            : quidLabel
              ? `E — start Quidditch`
              : nearAnimal
                ? `E — ride the ${nearAnimal.label}`
                : `E — hop in the ${DRIVE_PROFILES[near!.cls].label}`,
          1.8
        );
        ridePromptShown = true;
      }
      if (!drv && !quidLabel && !nearAnimal && !near) ridePromptShown = false;
    } else {
      ridePromptShown = false;
    }
    if (cineHook) {
      cineHook(frameDt); // scripted cinematic owns truck pose + camera
    } else if (cameraMode) {
      orbit.update(frameDt);
    } else {
      chase.update(frameDt, player, input);
    }
    sky.update(elapsed, camera.position);
    water.update(elapsed, camera.position, player.renderPosition);
    fx.update(frameDt);
    shockwaves.update(frameDt);
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

    // paintballs fly after everyone is posed: candidate targets are traffic,
    // remote avatars, and me (remote shots can splatter my clothes)
    paintTargets.length = 0;
    for (const v of traffic.vehicles) {
      const big = v.cls === "bus" || v.cls === "cable";
      paintTargets.push({
        obj: v.mesh,
        x: v.mesh.position.x,
        y: v.mesh.position.y + (big ? 1.5 : 0.7),
        z: v.mesh.position.z,
        r: big ? 3.6 : 2.1,
        owner: -1
      });
    }
    for (const a of remotes.avatars.values()) {
      const body = a.mode ? a.bodies[a.mode] : undefined;
      if (!body || !a.root.visible) continue;
      const hitSphere = PAINT_HIT[a.mode!];
      paintTargets.push({
        obj: body,
        x: a.root.position.x,
        y: a.root.position.y + hitSphere.y,
        z: a.root.position.z,
        r: hitSphere.r,
        owner: a.info.id
      });
    }
    {
      const mesh = player.meshes[player.mode];
      const hitSphere = PAINT_HIT[player.mode];
      paintTargets.push({
        obj: mesh,
        x: mesh.position.x,
        y: mesh.position.y + hitSphere.y,
        z: mesh.position.z,
        r: hitSphere.r,
        owner: net.selfId
      });
    }
    paintballs.update(frameDt, physics, graffiti, paintSkins, paintTargets, (o, d, m) => exploratorium.raycast(o, d, m));
    paintSkins.update(frameDt, scene);

    hud.update(frameDt);
    tutorial.update(frameDt);
    debugPanel.refresh();

    saveTimer += frameDt;
    if (saveTimer >= 1) {
      saveTimer = 0;
      saveSession();
    }

    // debris sync
    const data = physics.debrisTransforms();
    if (data) {
      const n = physics.debris.length;
      debrisMesh.count = n;
      const toneArr = debrisTone.array as Float32Array;
      const infoArr = debrisInfo.array as Float32Array;
      const spawnArr = debrisSpawn.array as Float32Array;
      const animArr = debrisAnim.array as Float32Array;
      const sinkSpan = 2.8;
      const sinkStart = CONFIG.debrisLifetime - sinkSpan;
      for (let i = 0; i < n; i++) {
        const o = i * 8;
        const d = physics.debris[i];
        // rubble settles, then sinks into the ground instead of shrinking away
        const sinkT = d.age > sinkStart ? (d.age - sinkStart) / sinkSpan : 0;
        const yOff = sinkT * sinkT * (d.hy * 2 + 0.8);
        pos.set(data[o], data[o + 1] - yOff, data[o + 2]);
        quat.set(data[o + 3], data[o + 4], data[o + 5], data[o + 6]);
        scl.set(d.hx, d.hy, d.hz);
        mat4.compose(pos, quat, scl);
        debrisMesh.setMatrixAt(i, mat4);
        toneArr[i * 4] = d.color.r;
        toneArr[i * 4 + 1] = d.color.g;
        toneArr[i * 4 + 2] = d.color.b;
        toneArr[i * 4 + 3] = d.baseY;
        infoArr[i * 4] = d.bid;
        infoArr[i * 4 + 1] = d.hx;
        infoArr[i * 4 + 2] = d.hy;
        infoArr[i * 4 + 3] = d.hz;
        spawnArr[i * 4] = d.sx;
        spawnArr[i * 4 + 1] = d.sy;
        spawnArr[i * 4 + 2] = d.sz;
        spawnArr[i * 4 + 3] = d.yaw;
        animArr[i * 2] = d.age;
        animArr[i * 2 + 1] = d.seed;
      }
      debrisMesh.instanceMatrix.needsUpdate = true;
      debrisTone.needsUpdate = true;
      debrisInfo.needsUpdate = true;
      debrisSpawn.needsUpdate = true;
      debrisAnim.needsUpdate = true;
    } else {
      debrisMesh.count = 0;
    }

    // projectile sync: pose + stretch each tracer along its velocity
    tracers.sync(physics);

    input.endFrame();
    pipeline.render();
  };
  // automation tabs (Playwright/Puppeteer probes) render with no vsync
  // backpressure — one orphaned headless probe pegged the GPU at 100%
  // machine-wide. Cap them to ~20fps; measurement harnesses opt out with
  // ?fullfps. Manual __sf.tick() driving is unaffected.
  const throttleRaf = navigator.webdriver && !new URLSearchParams(location.search).has("fullfps");
  let lastLoop = performance.now();
  let manualDrive = false; // frame-by-frame capture drives tick(dt) itself
  const loopFn = () => {
    if (throttleRaf && performance.now() - lastLoop < 50) return;
    lastLoop = performance.now();
    tick();
  };
  renderer.setAnimationLoop(loopFn);
  // Deterministic capture: stop the wall-clock loop (and the hidden-tab fallback
  // below) so the sim only advances one fixed step per screenshotted frame —
  // smooth output no matter how slow rendering runs under GPU contention.
  (window as never as { __sfManual: (on: boolean) => void }).__sfManual = (on: boolean) => {
    manualDrive = on;
    renderer.setAnimationLoop(on ? null : loopFn);
  };

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  console.log("[sf] city online (webgpu)");

  const exposeDebugHooks = () => {
    Object.assign(window as never, {
      __sf: { scene, camera, player, tiles, physics, renderer, pipeline, POSTFX_TUNING, chase, map, input, hud, fx, fireworks, graffiti, bubbles, chimes, setTool, setColor, sky, debugPanel, DEBRIS_LIGHTS, CONFIG, THREE, tick, props, exploratorium, traffic, creatures, forest, flora, splashes, vehicleAudio, net, remotes, voice, minimap, playerLocator, boardWake, abandonedMounts, paintballs, paintSkins, loot, hunt, ropes, grabber, satchel, gatherPickables, buildShareUrl, tutorial, quidditch, quidHud, rocketRiders, truckLaunchers, boatLaunchers, goldenGateLights, bridgeShow, flyover, bridgeParade }
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
      launchTruckFireworks: (forward: THREE.Vector3) => {
        truckLaunchers?.fireAll({
          scene,
          fireworks,
          rocketRiders,
          map,
          playerPos: player.position,
          forward,
          hostVelocity: player.velocity
        });
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
      },
      flyover
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
