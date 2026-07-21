// AUTO-EXTRACTED from src/main.ts (P3 NET block, lines 1928-3485) — see
// docs/MAIN_DECOMPOSITION.md. Behavior-identical move: crossing consts are
// returned on the record; crossing lets live on `state`.
// Soft-HMR guard must register before any other import.meta.hot listeners.
import * as THREE from "three/webgpu";
import {   CONFIG } from "../../config";
import {   localizeInteractText } from "../../core/input";
import { GhostShipBeacon } from "../../world/ghostShip/beacon";
import {
  GHOST_SHIP_LANDMARK_NAME,
  GHOST_SHIP_RIDE_ID
} from "../../world/ghostShip/route";
import type { GhostShip } from "../../world/ghostShip";
import type {  } from "../../world/goldenGateTennis";
import {
  JAPANESE_TEA_GARDEN_ENTRANCE,
  isTeaGardenBuilding
} from "../../world/japaneseTeaGarden/layout";
import type {  } from "../../world/coronaHeights";
import type {  } from "../../world/missionDolores";
import { WILD_REGIONS } from "../../world/wildlands/regions";
import { BUENA_VISTA_REGION } from "../../world/buenaVista";
import { BACKGROUND_STREAM_LIMIT } from "../../world/tiles";
import type { PlayerMode } from "../../player/types";
import {  PAINT_COLORS } from "../../fx/graffiti";
import {  ProxySet } from "../../core/worldQueries";
import { createLazySelector } from "../../app/compose/selectorHub";
import { Chat } from "../../ui/chat";
import {    BALL_IMPACT_AUDIO_TUNING } from "../../audio";
import type {  } from "../../gameplay/creatures";
import type {  } from "../../gameplay/forest";
import type {  } from "../../world/citygen";
import { MinigameSessionController, type MinigameOrigin } from "../../gameplay/minigameSession";
import type {  } from "../../gameplay/archery";
import type {  } from "../../gameplay/pup";
import type { FortMasonEnsemble } from "../../gameplay/fortMasonEnsemble";
import type {  } from "../../gameplay/palaceReverie";
import type {  } from "../../world/landsEnd";
import type {  } from "../../world/waveOrgan";
import type {  } from "../../world/beachPianist";
import type {  } from "../../gameplay/afterlight";
import { ShareButton } from "../../ui/share";
import { WakeCityButton } from "../../ui/wakeCity";
// The launcher and reader stay dynamically loaded; a reading entry may create
// the shared reader before this game module begins.
import {  initialReadLink } from "../../app/startupIntent";
import {
  getBehindTheScenes,
  openBehindTheScenes,
  subscribeBehindTheScenes
} from "../../ui/behindTheScenesHost";
import { Tutorial } from "../../ui/tutorial";
import { DebugPanel } from "../../ui/debug";
import { DebugOverlays } from "../../ui/overlays";
import { OVERLAY_TUNING } from "../../ui/overlays/tuning";
import { CalibrationChart } from "../../ui/calibrationChart";
import { Net } from "../../net/net";
import { RemotePlayers } from "../../net/remotes";
import { Voice } from "../../net/voice";
import { Minimap } from "../../ui/minimap";
import { PlayerLocator } from "../../ui/playerLocator";
import { avatarFromSeed,  saveAvatarTraits } from "../../player/avatar";
import { boardFromSeed, boardVisualKey,  saveBoardConfig, setLocalBoardConfig } from "../../vehicles/board";
import {
  carFromSeed,
  carKey,
  saveCarConfig,
  setLocalCarConfig
} from "../../vehicles/car";
import {   saveScooterConfig, scooterFromSeed, scooterKey, setLocalScooterConfig } from "../../vehicles/scooter";
import { passengerCapacity } from "../../vehicles/rideable";
import {
  saveSurfboardConfig,
  setLocalSurfboardConfig,
  surfboardFromSeed,
  surfboardVisualKey,
  type SurfboardConfig
} from "../../vehicles/surf";
import {
  GARDEN_XZ,
  GOLF_XZ,
  registerActivityLandmarks,
  registerParkLandmarks
} from "../../app/compose/minimapLandmarks";
import { wireEscapeStack } from "../../app/compose/escapeStack";
import { createOceanKiteGate } from "../../app/compose/oceanKite";
import { createTeaGardenController } from "../../app/compose/teaGarden";
import { createOptionalSites, type OptionalSiteId } from "../../app/compose/optionalSites";
import { NavigationController } from "../../app/navigation";
import { RendererDiagnostics } from "../../app/diagnostics";
import type { PickleballController } from "../../app/systems/pickleball";
import type { MainCtx } from "./ctx";


type RegionKey = "garden" | "wildlands" | "golf"; // mirrors main.ts's boot-scope alias

export async function composeWorldSystemsNet(ctx: MainCtx, core: Awaited<ReturnType<typeof import("./worldSystemsCore").composeWorldSystemsCore>>) {
  const { player, input, camera, scene, worldArrival, chase, map, physics, renderer, sky, waitForWorldBackgroundWindow, waitForWorldStreamingWindow, aim, tiles, rayOrigin, worldReady, scheduler, pipeline, authoredRegions, waitForCityGenRenderWindow, app, fullTileRadius, invite, startMode, savedSurfboard, savedScooter, savedCar, savedBoard, savedAvatar, resumed, nextPresentationFrame, autoStartHiroTour, releasePianoGodRays, constructionSlice } = ctx;
  const { hud, fx, fireworks, paintballs, setColor, vehicleAudio, jumpLandingAudio, audioControls, nature, ballImpactAudio, ensureSurfShack, prepareSurfEntry, embodiments, inOrbit, siteGate, setFoliageVisible, armIslandsVegetation, worldQueries, citygenRing, dogParkAudio, buskerTalk, setViewMode } = core;
  const state = {
    ghostShip: null as (GhostShip | null),
    ghostShipLoading: null as (Promise<GhostShip | null> | null),
    ghostShipLoadFailed: false as any,
    ensureGhostShipDetail: undefined as undefined | (() => Promise<GhostShip | null>),
    pickleballController: null as (PickleballController | null),
    fortMasonEnsemble: null as (FortMasonEnsemble | null),
    surfEntryRequest: 0 as any,
    btsReading: false as any,
    overlayRayHit: null as ({ x: number; y: number; z: number } | null),
    fireCooldown: 0 as any,
  };
  await constructionSlice();

  // ---- multiplayer: presence relay (src/net/net.ts) + remote avatars +
  // minimap. Drop-in social layer: movement stays client-authoritative, the
  // server only relays poses, and losing the socket never breaks single-player.
  // Send a custom avatar only if the player actually chose one; a null avatar
  // lets the server keep its per-id seed (server.mjs), so un-ctx.state.customized players
  // stay distinct instead of all sending the same saved blob.
  const net = new Net(
    ctx.suggestedName,
    savedAvatar ?? undefined,
    savedBoard ?? undefined,
    savedScooter ?? undefined,
    savedSurfboard ?? undefined,
    savedCar ?? undefined
  );
  ctx.late.net = net;
  const remotes = new RemotePlayers(scene);
  remotes.localPlayerPosition = () => player.renderPosition;
  // net.onRakeStamp / onRakeReset are wired just after the Tea Garden controller
  // is created (below) — before then the core.state.garden cannot exist, and net's no-op
  // defaults absorb any rake hydration that arrives during a boot await; the
  // controller's replayRakeStamps re-applies once the site loads.
  // The request-free horizon proxy is a world fundamental; detailed geometry,
  // particles and the WebGPU hot-tub solver cross a separate proximity gate.
  const ghostShipBeacon = new GhostShipBeacon(scene, map);
  // (state.ghostShip hoisted to the module state record)
  // (state.ghostShipLoading hoisted to the module state record)
  // (state.ghostShipLoadFailed hoisted to the module state record)
  let unregisterGhostShipTuning: (() => void) | null = null;
  state.ensureGhostShipDetail = async () => null;
  const ghostShipSeatQuat = new THREE.Quaternion();
  const ghostShipSeatEuler = new THREE.Euler(0, 0, 0, "YXZ");
  remotes.worldRidePose = (rideId, seat, outPosition, outQuaternion) => {
    if (rideId !== GHOST_SHIP_RIDE_ID) return false;
    if (state.ghostShip?.seatPose(seat, outPosition, outQuaternion)) return true;
    // Keep map-teleport riders glued while the detailed chunk warms up.
    const pose = ghostShipBeacon.pose;
    outPosition.set(pose.x, pose.y + 2.2, pose.z);
    ghostShipSeatEuler.set(pose.pitch, pose.yaw, pose.roll);
    ghostShipSeatQuat.setFromEuler(ghostShipSeatEuler);
    outQuaternion.copy(ghostShipSeatQuat);
    return true;
  };
  core.state.setRemoteSurfboardAssetsActive = (active) => remotes.setSurfboardAssetsEnabled(active);
  core.state.setRemoteScooterAssetsActive = (active) => remotes.setScooterAssetsEnabled(active);
  core.state.setRemoteCarAssetsActive = (active) => remotes.setCarAssetsEnabled(active);
  core.state.setRemoteBirdAssetsActive = (active) => remotes.setBirdAssetsEnabled(active);
  // Startup/invite can enter surf before networking and its remote-art gate exist.
  core.state.setRemoteSurfboardAssetsActive(player.mode === "surf");
  core.state.setRemoteScooterAssetsActive(player.mode === "scooter");
  core.state.setRemoteCarAssetsActive(player.mode === "drive");
  core.state.setRemoteBirdAssetsActive(player.mode === "bird");
  // The controller statically owns every pickleball mesh, UI and audio class,
  // so even constructing an empty facade would pull the activity into boot.
  // It is installed together with the Goldman site on first approach.
  // (state.pickleballController hoisted to the module state record)
  // (state.fortMasonEnsemble hoisted to the module state record)
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
    isActive: () => state.pickleballController?.playing ?? false,
    release: () => { state.pickleballController?.releaseForNavigation(); }
  });
  minigameSession.register({
    id: "fort-mason-ensemble",
    label: "Fort Mason ensemble",
    isActive: () => state.fortMasonEnsemble?.playing ?? false,
    release: () => { state.fortMasonEnsemble?.releaseForNavigation(); }
  });
  minigameSession.register({
    id: "golf",
    label: "golf",
    isActive: () => core.state.golf?.active ?? false,
    release: () => { core.state.golf?.abandonForNavigation(hud); }
  });
  minigameSession.register({
    id: "archery",
    label: "archery",
    isActive: () => core.state.archery?.firstPersonActive ?? false,
    release: () => { core.state.archery?.releaseForNavigation(player); }
  });
  minigameSession.register({
    id: "hang-gliding",
    label: "Skyline Glide",
    isActive: () => core.state.hangGliding?.active ?? false,
    release: () => { core.state.hangGliding?.releaseForNavigation(player, chase); }
  });
  const releaseGameplayForNavigation = () => {
    if (inOrbit()) setViewMode("third");
    return minigameSession.releaseForNavigation(captureMinigameOrigin());
  };
  // Customizer selectors are all lazy (docs/MAIN_DECOMPOSITION.md step 3): only a
  // placeholder launcher exists at boot; each selector's UI chunk dynamic-imports
  // on FIRST OPEN via the shared createLazySelector mechanic. The mutable config
  // state (ctx.state.avatarTraits/ctx.state.boardConfig/…) stays boot-resident here — net.onWelcome
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
      const { AvatarSelector } = await import("../../ui/avatarSelector");
      return new AvatarSelector(
        ctx.state.avatarTraits,
        net.name,
        (traits) => {
          ctx.state.avatarTraits = traits;
          ctx.state.customized = true; // an explicit edit — persist it and broadcast from here on
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
  const applyBoardConfig = (config: typeof ctx.state.boardConfig) => {
    const visualChanged = boardVisualKey(ctx.state.boardConfig) !== boardVisualKey(config);
    ctx.state.boardConfig = config;
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
      const { BoardSelector } = await import("../../ui/boardSelector");
      return new BoardSelector(
        ctx.state.boardConfig,
        (config) => {
          ctx.state.boardCustomized = true; // an explicit edit — persist it and broadcast from here on
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
      const { ScooterSelector } = await import("../../ui/scooterSelector");
      return new ScooterSelector(
        ctx.state.scooterConfig,
        (config) => {
          ctx.state.scooterCustomized = true;
          const changed = scooterKey(config) !== scooterKey(ctx.state.scooterConfig);
          ctx.state.scooterConfig = config;
          setLocalScooterConfig(config);
          saveScooterConfig(config);
          if (changed) player.setScooterConfig(config);
          net.setScooter(config);
        },
        (config) => player.previewScooterConfig(config),
        () => {
          if (player.mode !== "scooter" && !player.riding) core.state.switchModeFromToolbar!("scooter");
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
      const { CarSelector } = await import("../../ui/carSelector");
      return new CarSelector(
        ctx.state.carConfig,
        (config) => {
          ctx.state.carCustomized = true;
          const changed = carKey(config) !== carKey(ctx.state.carConfig);
          ctx.state.carConfig = config;
          setLocalCarConfig(config);
          saveCarConfig(config);
          if (changed) player.setCarConfig(config);
          net.setCar(config);
        },
        (config) => player.previewCarConfig(config),
        () => {
          if (player.mode !== "drive" && !player.riding) core.state.switchModeFromToolbar!("drive");
        }
      );
    }
  });
  // __sf-exposed opener; also called by the drive-mode toolbar wiring.
  const ensureCarCustomizer = (open = false) => car.ensure(open);
  const applySurfboardConfig = (config: SurfboardConfig) => {
    const changed = surfboardVisualKey(config) !== surfboardVisualKey(ctx.state.surfboardConfig);
    ctx.state.surfboardConfig = config;
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
      const { SurfboardSelector } = await import("../../ui/surfboardSelector");
      return new SurfboardSelector(
        ctx.state.surfboardConfig,
        (config) => {
          ctx.state.surfboardCustomized = true;
          saveSurfboardConfig(config);
          applySurfboardConfig(config);
          net.setSurfboard(config);
        },
        (config) => player.previewSurfboardSurface(config),
        () => {}
      );
    }
  });
  core.state.ensureSurfboardCustomizer = (open = false) => surfboard.ensure(open);
  // One top-right customizer slot: show only the active mode's atelier (or none).
  core.state.syncCustomizerForMode = (mode) => {
    avatar.syncVisible(mode === "walk");
    board.syncVisible(mode === "board");
    scooter.syncVisible(mode === "scooter");
    car.syncVisible(mode === "drive");
    surfboard.syncVisible(mode === "surf");
  };
  core.state.syncCustomizerForMode(player.mode);
  await constructionSlice();
  net.onWelcome = () => {
    avatar.get()?.setName(net.name); // server may canonicalize a duplicate/invalid name
    if (ctx.state.customized) {
      net.setAvatar(ctx.state.avatarTraits); // re-assert my chosen look after a (re)connect
    } else {
      // adopt the server's per-id seed so my own body matches how everyone else
      // sees me, and reflect it in the editor
      ctx.state.avatarTraits = avatarFromSeed(net.selfId);
      player.setAvatar(ctx.state.avatarTraits);
      avatar.get()?.setTraits(ctx.state.avatarTraits);
    }
    if (ctx.state.boardCustomized) {
      net.setBoard(ctx.state.boardConfig); // re-assert my chosen board after a (re)connect
    } else {
      const seeded = boardFromSeed(net.selfId);
      applyBoardConfig(seeded);
      board.get()?.setConfig(seeded);
    }
    if (ctx.state.scooterCustomized) {
      net.setScooter(ctx.state.scooterConfig);
    } else {
      ctx.state.scooterConfig = scooterFromSeed(net.selfId);
      setLocalScooterConfig(ctx.state.scooterConfig);
      player.setScooterConfig(ctx.state.scooterConfig);
      scooter.get()?.setConfig(ctx.state.scooterConfig);
    }
    if (ctx.state.carCustomized) {
      net.setCar(ctx.state.carConfig);
    } else {
      ctx.state.carConfig = carFromSeed(net.selfId);
      setLocalCarConfig(ctx.state.carConfig);
      player.setCarConfig(ctx.state.carConfig);
      car.get()?.setConfig(ctx.state.carConfig);
    }
    if (ctx.state.surfboardCustomized) {
      net.setSurfboard(ctx.state.surfboardConfig);
    } else {
      const seeded = surfboardFromSeed(net.selfId);
      applySurfboardConfig(seeded);
      surfboard.get()?.setConfig(seeded);
    }
    core.state.golf?.syncNetState();
    net.replayGolf();
    state.pickleballController?.onWelcome();
    state.fortMasonEnsemble?.onWelcome();
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
    state.pickleballController?.syncSlots();
  };
  net.onRoster = syncRoster;
  net.onLeave = (id) => {
    remotes.remove(id);
    voice.drop(id);
    core.state.golf?.removeRemote(id);
    core.state.fetchBall?.removeRemoteBalls(id);
  };
  net.onSample = (id, s) => remotes.sample(id, s);
  // someone else's paintball: same ballistic sim, their color, splats locally
  net.onPaint = (id, x, y, z, vx, vy, vz, rgb) => paintballs.spawn(x, y, z, vx, vy, vz, remotePaint.set(rgb), id);
  // Friends' tennis balls use the exact local bounce/roll sim. They stay out of
  // local dog-fetch ownership, but settled balls transfer through E pickup.
  net.onBall = (id, throwId, x, y, z, vx, vy, vz) => core.state.fetchBall?.spawnRemote(id, throwId, x, y, z, vx, vy, vz);
  net.onBallPickup = (pickerId, ownerId, throwId, accepted) => {
    const received = core.state.fetchBall?.resolvePickup(
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
  net.onGolf = (id, m) => core.state.golf?.handleNet(id, m, hud, net.roster.get(id)?.name ?? "Player");
  input.onLockChange = (locked) => {
    if (!locked && !inOrbit() && !input.freeCursor && !input.momentaryCursor && !chat.focused) {
      hud.message("Click the scene to capture · Hold ⌘ for cursor · L toggles free cursor", 2.8);
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
  let mocapSession: import("../../mocap/poseMocapSession").PoseMocapSession | null = null;
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
      const { PoseMocapSession } = await import("../../mocap/poseMocapSession");
      const session = new PoseMocapSession({
        video: audioControls.mocapVideo,
        debugCanvas: audioControls.mocapDebugCanvas,
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
      if (!core.state.paintColorTouched && !core.state.paintColorSeeded) {
        setColor(Math.max(0, net.selfId - 1) % PAINT_COLORS.length);
        core.state.paintColorSeeded = true;
      }
      hud.message(`Online as ${net.name} — M for the map`, 3.2);
    }
    else if (status === "full") hud.message(detail ?? "Server is full", 4);
    else if (status === "offline") {
      state.pickleballController?.onOffline();
      state.fortMasonEnsemble?.onOffline();
      // Offline stays silent: the local AI match keeps working and Net retries.
    }
  };

  // The name gate's start handler was installed in P2 (it must work from the
  // live void); its net/hud/audio effects queue through runAfterConstruction.
  await constructionSlice();

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
  ctx.late.minimap = minimap;
  // Null in zone boot until wake loads the graph (the CORE wake runner
  // re-issues this through ctx.late.minimap).
  void core.state.roadGraphPromise?.then((roads) => minimap.setRoadGraph(roads)).catch(() => {});
  // Activity-site pins (static coords) — extracted per docs/MAIN_DECOMPOSITION.md.
  void ctx.zoneBoot.deferCity("activity-landmarks", () =>
    registerActivityLandmarks(minimap, map, ghostShipBeacon.pose, ensureSurfShack)
  );
  const playerLocator = new PlayerLocator();
  // worldArrival + backgroundAdmission were constructed in P1 (the reveal path
  // and void loop need them); only navigation composes here.
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
  // (state.surfEntryRequest hoisted to the module state record)
  const switchMode = (mode: PlayerMode) => {
    const request = ++state.surfEntryRequest;
    if (mode === "bird") core.state.setRemoteBirdAssetsActive!(true);
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
        if (ready && request === state.surfEntryRequest && player.mode !== "surf") navigation.switchMode("surf");
      });
      return;
    }
    navigation.switchMode(mode);
  };
  core.state.switchModeFromExit = switchMode;
  const teleportAboardGhostShip = () => {
    if (embodiments.passengerOf === GHOST_SHIP_RIDE_ID) {
      hud.message("Already aboard the wandering ghost ship", 2.2);
      return;
    }
    navigation.teleportCustom({
      label: GHOST_SHIP_LANDMARK_NAME,
      successMessage: null,
      resolve: async (signal) => {
        const ship = await state.ensureGhostShipDetail!();
        if (signal.aborted) throw new DOMException("Navigation superseded", "AbortError");
        if (!ship) throw new Error("The ghost ship could not be loaded");
        const seat = ship.claimDeckSeat(remotes.occupiedRideSeats(GHOST_SHIP_RIDE_ID));
        if (seat <= 0) throw new Error("The ghost ship's deck stations are full");
        const pose = ghostShipBeacon.pose;
        ship.update(0, ctx.state.elapsed, pose, player.renderPosition, true, 0);
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
            core.state.ghostShipRideZoom ??= chase.zoom;
            chase.zoom = Math.max(chase.zoom, 3.2);
            chase.yaw = pose.yaw;
            core.state.ghostShipRideYaw = pose.yaw;
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
  core.state.switchModeFromToolbar = switchMode;
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
    closeConversation: () => ctx.state.beachPianist?.close() || buskerTalk.close(),
    getMissionDolores: () => core.state.missionDolores,
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
  await constructionSlice();


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
    () => {
      core.state.wildlands?.flowers.refresh();
      ctx.state.siteFoliage?.refresh();
    },
    () => core.state.wildlands?.grass.refresh(),
    () => diagnostics.toggleInspector(),
    () => { citygenRing.current?.refreshInteriors(); }
  );
  ctx.late.debugPanel = debugPanel;

  state.ensureGhostShipDetail = () => {
    if (state.ghostShip) return Promise.resolve(state.ghostShip);
    if (state.ghostShipLoadFailed) return Promise.resolve(null);
    if (!state.ghostShipLoading) {
      state.ghostShipLoading = import("../../world/ghostShip")
        .then(async ({ createGhostShip }) => {
          const candidate = createGhostShip({ scene, renderer, physics });
          try {
            await candidate.warmup();
          } catch (error) {
            candidate.dispose();
            throw error;
          }
          state.ghostShip = candidate;
          ghostShipBeacon.detailedVisible = true;
          unregisterGhostShipTuning = debugPanel.registerFeatureTuning(candidate.tuningDescriptor());
          const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
          if (hooks) hooks.ghostShip = candidate;
          return candidate;
        })
        .catch((error) => {
          state.ghostShipLoadFailed = true;
          console.warn("[ghost-ship] detailed runtime unavailable", error);
          return null;
        })
        .finally(() => {
          state.ghostShipLoading = null;
        });
    }
    return state.ghostShipLoading;
  };

  import.meta.hot?.dispose(() => {
    unregisterGhostShipTuning?.();
    state.ghostShip?.dispose();
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

  // Session resume / invite POSITION was committed back in P1 (void phase).
  // What remains here are the parts that need P3 systems: the surf runtime for
  // surf sessions, and the ridden-animal identity for animal invites.
  if (invite?.animal) embodiments.currentAnimal = invite.animal;
  const wantsBootSurf =
    startMode === "surf" || resumed?.mode === "surf" || (invite && !invite.animal && invite.mode === "surf");
  if (wantsBootSurf && player.mode === "walk" && (await prepareSurfEntry())) {
    player.trySwitch("surf");
  }
  // applySurfCull assigns the stash inside a closure, so synchronous flow
  // analysis freezes the binding at its boot-time null — same cast pattern as
  // the invited-core.state.forest read above.
  const bootSurfStash = core.state.surfCullStash as { load: number; unload: number } | null;
  if (player.mode === "surf" && bootSurfStash) {
    // The boot visual prime temporarily reduced the tile radius to 1 km, and
    // onModeChange's applySurfCull stashed that bubble. Seed the stash from the
    // real fixed-quality radius so leaving surf restores normal residency.
    bootSurfStash.load = fullTileRadius;
    bootSurfStash.unload = fullTileRadius + 400;
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
  const shareButton = new ShareButton(buildShareUrl, (ok) =>
    hud.message(ok ? "Invite link copied — send it to a friend" : "Couldn't copy the link", 3.2)
  );
  // Zone boot: shared links carry the pocket so recipients boot into the same
  // zone at the shared spot; wakeCity() clears it (they're in the full world).
  if (ctx.zoneBoot.worldScope.zone) shareButton.setZone(ctx.zoneBoot.worldScope.zone.id);

  // Zone-only boot → full world upgrade. Idempotent: restore the citywide tile
  // radius (kicking the same background expansion the worldReady quiet-window
  // block uses), drain every deferred city builder sequentially, then lift the
  // optional-site zone restriction. The ring has already settled at the
  // bubble; the front gate is inactive post-settle, so newly loaded tiles
  // simply appear — no new sweep.
  let cityWakePromise: Promise<void> | null = null;
  let wakeButton: WakeCityButton | null = null;
  const wakeCity = (): Promise<void> => {
    if (ctx.zoneBoot.worldScope.mode === "full") return Promise.resolve();
    if (cityWakePromise) return cityWakePromise;
    cityWakePromise = (async () => {
      // cityWoken flips now so any late builder runs inline; worldScope.mode
      // stays "zone" until the drain finishes because the traffic and islands
      // runners branch on it for their wake-only sub-steps.
      ctx.zoneBoot.cityWoken = true;
      hud.message("Waking the rest of San Francisco…", 3.2);
      if (player.mode !== "surf") {
        CONFIG.tileLoadRadius = ctx.zoneBoot.worldScope.cityTileRadius;
        CONFIG.tileUnloadRadius = ctx.zoneBoot.worldScope.cityTileRadius + 400;
      } else if (core.state.surfCullStash) {
        // Surf owns the live radius (capped at 2 km); retarget its exit-restore
        // values so leaving the water lands on the citywide radius, not the
        // zone bubble it stashed when surf began.
        core.state.surfCullStash.load = ctx.zoneBoot.worldScope.cityTileRadius;
        core.state.surfCullStash.unload = ctx.zoneBoot.worldScope.cityTileRadius + 400;
      }
      tiles.beginBackgroundExpansion();
      sky.setStreamingCullRadius(Math.min(ctx.zoneBoot.worldScope.cityTileRadius, BACKGROUND_STREAM_LIMIT));
      while (ctx.zoneBoot.deferredCityWork.length > 0) {
        const work = ctx.zoneBoot.deferredCityWork.shift()!;
        try {
          await work.run();
        } catch (err) {
          console.warn(`[zone] wake step "${work.name}" failed:`, err);
        }
      }
      ctx.zoneBoot.worldScope.mode = "full";
      sites.liftZoneRestriction();
      shareButton.setZone(null);
      wakeButton?.remove();
      wakeButton = null;
    })();
    return cityWakePromise;
  };
  if (ctx.zoneBoot.worldScope.mode === "zone") wakeButton = new WakeCityButton(wakeCity);

  // "Behind the scenes" overlay + X/GitHub links (top-right, under Tutorial).
  // Free the pointer lock while it's open so the cursor can reach the links.
  // While it's open the whole world stops rendering (see `state.btsReading` in tick)
  // and the frozen canvas dims a touch, so no live frames flicker behind the read.
  // Esc-dismiss stays unlocked (click the scene to recapture); see Escape priority stack.
  // (state.btsReading hoisted to the module state record)
  // Both the post-reveal launcher and a shared `?read=` link route through this
  // function so the optional reader chunk is fetched and constructed once.
  const onBtsToggle = (open: boolean) => {
    state.btsReading = open;
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
    const { BehindTheScenesLauncher } = await import("../../ui/behindTheScenesLauncher");
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
  // (state.overlayRayHit hoisted to the module state record)
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
            hit: state.overlayRayHit,
            dir: aim,
            maxDist: 60
          }
        : undefined,
      sampleY: (x, z) => map.groundTop(x, z)
    });
  };

  // The interaction ray (`aim`/`rayOrigin` live in P1 — the void loop steers
  // with them too). Normally it's the centre-screen aim; while the free
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

  // (state.fireCooldown hoisted to the module state record)
  await constructionSlice();

  // Boot warmup + the first covered frame happened in P1; reveal machinery
  // (revealedPromise / worldReady / modulesReady) lives in P2. The deferred
  // region builds below gate on `worldReady` — reveal fires seconds before
  // their construction dependencies exist now.
  // Keep all Behind-the-scenes UI out of essential loading. After the visual +
  // collision reveal, give the live world a quiet beat, then request only the
  // tiny launcher during browser idle. The timeout guarantees it appears within
  // a few seconds instead of waiting on optional core.state.garden/tree/core.state.golf completion.
  // The reader itself waits for a click; its heavy chapters wait for their tabs.
  void worldReady.then(async () => {
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
  void worldReady.then(async () => {
    // The near/mid substrate is the only background lane allowed during the
    // fog-walled fill. Optional regions and enhancement compiles use the
    // stricter settled-world gate.
    await waitForWorldStreamingWindow();
    if (player.mode === "surf") {
      // Surf's explicit 2 km mode cap remains active; only its restore target is
      // the normal full radius.
      if (core.state.surfCullStash) {
        core.state.surfCullStash.load = fullTileRadius;
        core.state.surfCullStash.unload = fullTileRadius + 400;
      }
    } else {
      CONFIG.tileLoadRadius = fullTileRadius;
      CONFIG.tileUnloadRadius = fullTileRadius + 400;
    }
    tiles.beginBackgroundExpansion();
    sky.setStreamingCullRadius(Math.min(fullTileRadius, BACKGROUND_STREAM_LIMIT));
  });
  void worldReady.then(async () => {
    await waitForWorldBackgroundWindow(1800);
    // Null in zone boot (islands is deferred); the wake runner arms it instead.
    armIslandsVegetation();
  });
  // Generic proximity gates: every starting point follows the same rule. After
  // first reveal, nearby optional regions may hydrate; distant ones wait for
  // first approach. NEAR_GATE is metres from each region's footprint.
  const NEAR_GATE = 1300;
  // Park + authored-region map pins (eager, coords-only) — extracted per
  // docs/MAIN_DECOMPOSITION.md; GARDEN_XZ/GOLF_XZ now live beside the pins.
  void ctx.zoneBoot.deferCity("park-landmarks", () => registerParkLandmarks(minimap, authoredRegions));

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
    site: import("../../world/wildlands").Wildlands;
    golfMod: typeof import("../../gameplay/golf");
    loadedGolfCourse: import("../../gameplay/golf").GolfCourse | null;
  };
  let wildlandsGroundcoverPromise: Promise<WildlandsGroundcoverBootstrap> | null = null;
  let requestedWildlandsFocus: { x: number; z: number } | null = null;

  /**
   * Request only the selected Wildlands destination's immediate surface. This
   * bootstrap is deliberately declared before the sequential CityGen/fauna
   * coordinator: a teleport must not wait for unrelated owners merely to begin
   * fetching its grass chunk. Defining the gate performs no request at boot.
   */
  // Arrival vegetation lane (wildlands half): once a teleport/boot names a
  // park as its destination, the surrounding grass/flower/tree pipelines ride
  // pipeline.compileAsyncPrioritized — they bypass the ring-settle compile
  // blocker and land right after the destination exhibit instead of after the
  // whole city fill. Latched (never cleared): later background pages reuse the
  // already-warmed layouts, so the flag only matters for first compiles.
  let wildlandsArrivalPriority = false;
  const wildlandsCompile = (root: THREE.Object3D): Promise<unknown> =>
    wildlandsArrivalPriority
      ? pipeline.compileAsyncPrioritized(root, camera, scene)
      : renderer.compileAsync(root, camera, scene);
  const startWildlandsGroundcover = (
    focus: Readonly<{ x: number; z: number }>
  ): Promise<WildlandsGroundcoverBootstrap> => {
    requestedWildlandsFocus = { x: focus.x, z: focus.z };
    if (wildlandsGroundcoverPromise) return wildlandsGroundcoverPromise;

    let candidate: import("../../world/wildlands").Wildlands | null = null;
    const attempt = (async (): Promise<WildlandsGroundcoverBootstrap> => {
      markLazyRegion("wildlands", "requested");
      const [wildlandsMod, golfMod, afterlightLayout] = await Promise.all([
        import("../../world/wildlands"),
        import("../../gameplay/golf"),
        import("../../gameplay/afterlight/layout")
      ]);
      let loadedGolfCourse: import("../../gameplay/golf").GolfCourse | null = null;
      try {
        loadedGolfCourse = await golfMod.loadGolfCourse(map);
      } catch (error) {
        // Golf data is optional to the world surface. The park remains usable
        // if a deploy is missing its course manifest.
        console.warn("[core.state.golf] course unavailable:", error);
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
      core.state.wildlands = site;
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
        await site.prepareGroundcover(async (root) => { await wildlandsCompile(root); });
        markLazyRegion("wildlands", "groundcover-compile-end");
      } catch (error) {
        // Precompilation is an optimization. Publish the complete buffers and
        // let the live renderer compile a valid fallback rather than preserving
        // an empty destination forever.
        console.warn("[core.state.wildlands] destination groundcover compile failed:", error);
      }
      for (const group of groundcoverGroups) {
        group.visible = ctx.state.foliageOn;
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
        if (core.state.wildlands === candidate) core.state.wildlands = null;
        candidate.dispose();
      }
    });
    return attempt;
  };

  const prepareWildlandsGroundcoverAt = async (
    focus: Readonly<{ x: number; z: number }>,
    signal?: AbortSignal
  ): Promise<void> => {
    wildlandsArrivalPriority = true;
    const bootstrap = await waitForAbortable(startWildlandsGroundcover(focus), signal);
    // A latest-wins teleport can supersede the focus while shared imports or a
    // previous compile finish. Recenter once more, then await only critical
    // grass/flower pipelines—not native trees or core.state.golf.
    bootstrap.site.update(focus, focus);
    await waitForAbortable(
      bootstrap.site.prepareGroundcover(async (root) => { await wildlandsCompile(root); }),
      signal
    );
  };

  // Destination trees (fire-and-forget, never awaited by the travel cover):
  // materialize + warm the native-tree ring around the arrival focus through
  // wildlands.prepareAt, which is latest-wins internally. The group attaches
  // before the warm so chunks reveal as their pipelines land; the later golf
  // enrichment re-adding it is a no-op. A new arrival aborts the previous
  // prime so a superseded park never keeps compiling on the priority lane.
  let wildlandsTreePrimeController: AbortController | null = null;
  const ARRIVAL_TREE_PRIME_WINDOW_MS = 60_000;
  const primeWildlandsTreesAt = async (
    focus: Readonly<{ x: number; z: number }>,
    signal: AbortSignal
  ): Promise<void> => {
    const bootstrap = await waitForAbortable(startWildlandsGroundcover(focus), signal);
    const site = bootstrap.site;
    await waitForAbortable(site.ready, signal);
    // The destination exhibit outranks its scenery: hold the tree warm until
    // no optional site is mid-construction (bounded — builds complete/abort).
    while (!sites.streamingIdle()) {
      if (signal.aborted) return;
      await nextPresentationFrame();
    }
    if (signal.aborted) return;
    const [wildTreeGroup] = site.groups;
    wildTreeGroup.visible = ctx.state.foliageOn;
    scene.add(wildTreeGroup);
    markLazyRegion("wildlands", "destination-trees-start");
    // prepareAt latches this callback as the forest-wide preparer, so it keeps
    // running for pages/chunks long after the arrival. Ride the priority lane
    // only while this prime is live and recent; afterwards behave like the
    // background enrichment preparer (re-admit + normal lane) so no unpaced
    // compile train runs during ordinary play.
    const primeStartedAt = performance.now();
    await site.prepareAt(focus, async (unit) => {
      try {
        if (
          signal.aborted ||
          performance.now() - primeStartedAt > ARRIVAL_TREE_PRIME_WINDOW_MS
        ) {
          await waitForWorldBackgroundWindow();
          await renderer.compileAsync(unit, camera, scene);
          return;
        }
        await wildlandsCompile(unit);
      } catch (err) {
        // Non-fatal: the unit keeps its visual fallback and compiles on first
        // draw instead of leaving the destination bare.
        console.warn("[core.state.wildlands] destination vegetation prepare failed:", err);
      }
    }, signal);
    markLazyRegion("wildlands", "destination-trees-ready");
  };
  const requestWildlandsTreePrime = (focus: Readonly<{ x: number; z: number }>): void => {
    wildlandsTreePrimeController?.abort(new DOMException("superseded", "AbortError"));
    const controller = new AbortController();
    wildlandsTreePrimeController = controller;
    void primeWildlandsTreesAt(focus, controller.signal).catch((error) => {
      if (controller.signal.aborted) return;
      console.warn("[core.state.wildlands] destination tree prime failed:", error);
    });
  };

  // Walking into a park before the broader deferred coordinator reaches its
  // region setup receives the same early bootstrap. The callback itself is
  // still proximity-gated by the frame loop and therefore requests nothing at
  // a distant clean boot.
  core.state.wakeDeferredWildlandsGolf = () => {
    core.state.wakeDeferredWildlandsGolf = null;
    void startWildlandsGroundcover(player.renderPosition).catch((error) =>
      console.warn("[core.state.wildlands] first-approach groundcover failed:", error)
    );
  };

  // Japanese Tea Garden destination essentials + rake/paint/water/interact
  // wiring — extracted per docs/MAIN_DECOMPOSITION.md. Merely creating the
  // controller requests nothing: the split chunk stays absent at a distant clean
  // boot; a teleport (ctx.state.prepareDestinationEssentials) or a first approach
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
    getFetchBall: () => core.state.fetchBall,
    getFoliageOn: () => ctx.state.foliageOn,
    autoStartHiroTour,
    entrance: JAPANESE_TEA_GARDEN_ENTRANCE,
    markLazyRegion,
    waitForWorldBackgroundWindow,
    priorityCompile: pipeline.compileAsyncPrioritized,
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
  ctx.late.teaGarden = teaGarden;
  // Wired here (not beside the other net handlers) so the closures never touch
  // the Tea Garden controller before it exists; both are null-safe internally.
  net.onRakeStamp = (stamp) => teaGarden.queueRakeStamp(stamp);
  net.onRakeReset = () => teaGarden.resetSand();

  ctx.state.prepareDestinationEssentials = async (destination: Readonly<{ x: number; z: number }>, signal: AbortSignal) => {
    // Optional exhibit at the destination: retire irrelevant in-flight sites
    // and put the destination's own site on the arrival priority lane. Fire
    // and forget — the travel cover must never wait on optional content.
    sites.reprioritizeForArrival(destination);
    const teaDistance = Math.hypot(
      destination.x - JAPANESE_TEA_GARDEN_ENTRANCE.x,
      destination.z - JAPANESE_TEA_GARDEN_ENTRANCE.z
    );
    if (teaDistance < 820) await teaGarden.ensureEssential(signal, { priority: true });

    // Selected park groundcover starts under the travel cover even when its
    // bundle was not previously resident. The authored Tea Garden owns its own
    // grass and is excluded so Hiro/Tea House remain the sole priority there.
    const inPrimaryWildlands = WILD_REGIONS.some((region) =>
      region.id !== "buenavista" &&
      destination.x >= region.minX - 320 && destination.x <= region.maxX + 320 &&
      destination.z >= region.minZ - 320 && destination.z <= region.maxZ + 320
    );
    if (inPrimaryWildlands && teaDistance >= 820) {
      // Fire-and-forget FIRST: the groundcover await below can outlive the
      // supplemental 8 s abort on a cold cache, and the tree prime must not
      // die with it (it orders itself after the exhibit internally).
      requestWildlandsTreePrime(destination);
      await prepareWildlandsGroundcoverAt(destination, signal);
    }
  };

  // Optional authored-site scheduler (Goldman/pickleball, core.state.archery, core.state.pup, Fort
  // Mason, palace, core.state.afterlight, Corona Heights, Lands End, Wave Organ, Beach
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
    priorityCompile: pipeline.compileAsyncPrioritized,
    revealedPromise: worldReady,
    getFoliageOn: () => ctx.state.foliageOn,
    getRevealed: () => ctx.state.revealed,
    getAvatar: () => ctx.state.avatarTraits,
    // Zone boot: only the destination site auto-loads (its exhibit foliage
    // too); the site itself hydrates via the normal arrival/proximity path
    // since the spawn is at the site. Lifted by wakeCity().
    zoneAllowlist: ctx.zoneBoot.worldScope.zone
      ? new Set<OptionalSiteId>([ctx.zoneBoot.worldScope.zone.siteId])
      : undefined,
    onSitesChanged: (r) => {
      core.state.goldenGateTennis = r.goldenGateTennis;
      state.pickleballController = r.pickleballController;
      core.state.archery = r.archery;
      core.state.pup = r.pup;
      state.fortMasonEnsemble = r.fortMasonEnsemble;
      core.state.palaceReverie = r.palaceReverie;
      core.state.afterlight = r.afterlight;
      core.state.hangGliding = r.hangGliding;
      core.state.coronaHeights = r.coronaHeights;
      core.state.landsEnd = r.landsEnd;
      core.state.waveOrgan = r.waveOrgan;
      // Beach Pianist keeps two concerns in main (they read main-local state the
      // controller can't see): its debug tuning folder and piano-only god-ray
      // ownership. HEAD ran these inside loadBeachPianist / its unloader;
      // in the extracted model they ride the alias transition here. onSitesChanged
      // fires for every site change, so guard on the pianist ref actually flipping.
      if (r.beachPianist !== ctx.state.beachPianist) {
        if (r.beachPianist) {
          core.state.unregisterBeachPianistTuning?.();
          core.state.unregisterBeachPianistTuning = debugPanel.registerFeatureTuning(r.beachPianist.tuningDescriptor());
        } else {
          releasePianoGodRays();
          core.state.unregisterBeachPianistTuning?.();
          core.state.unregisterBeachPianistTuning = null;
        }
      }
      ctx.state.beachPianist = r.beachPianist;
      core.state.sutroBaths = r.sutroBaths;
      const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (hooks) Object.assign(hooks, {
        goldenGateTennis: core.state.goldenGateTennis,
        pickleballController: state.pickleballController,
        pickleball: state.pickleballController?.game ?? null,
        pickleballAmbient: state.pickleballController?.ambient ?? null,
        pickleballAudio: state.pickleballController?.audio ?? null,
        pickleballUI: state.pickleballController?.ui ?? null,
        archery: core.state.archery,
        pup: core.state.pup,
        fortMasonEnsemble: state.fortMasonEnsemble,
        palaceReverie: core.state.palaceReverie,
        afterlight: core.state.afterlight,
        hangGliding: core.state.hangGliding,
        coronaHeights: core.state.coronaHeights,
        landsEnd: core.state.landsEnd,
        waveOrgan: core.state.waveOrgan,
        beachPianist: ctx.state.beachPianist,
        sutroBaths: core.state.sutroBaths
      });
    }
  });
  ctx.state.siteFoliage = sites.siteFoliage;

  // Boot spawns bypass the WorldArrivalCoordinator, so the tea garden never
  // sees prepareDestinationEssentials there. Mirror the optional-site boot
  // reprioritize: a spawn inside the garden's destination ring puts its
  // ESSENTIAL build on the arrival priority lane the moment the world reveals
  // (maybeWakeDeferred would otherwise start it on the slow background lane).
  void worldReady.then(() => {
    const bootTeaDistance = Math.hypot(
      player.position.x - JAPANESE_TEA_GARDEN_ENTRANCE.x,
      player.position.z - JAPANESE_TEA_GARDEN_ENTRANCE.z
    );
    if (bootTeaDistance < 820) {
      void teaGarden.ensureEssential(undefined, { priority: true }).catch((error) =>
        console.warn("[tea-garden] boot destination construction failed:", error)
      );
    }
    // Boot spawn inside a primary wild region (e.g. the archery range in GG
    // Park): the spawn IS the destination, so its lawn and trees take the same
    // arrival lane a teleport would get (the garden owns its own foliage).
    const spawn = { x: player.position.x, z: player.position.z };
    const bootInWildlands = WILD_REGIONS.some((region) =>
      region.id !== "buenavista" &&
      spawn.x >= region.minX - 320 && spawn.x <= region.maxX + 320 &&
      spawn.z >= region.minZ - 320 && spawn.z <= region.maxZ + 320
    );
    if (bootInWildlands && bootTeaDistance >= 820) {
      wildlandsArrivalPriority = true;
      void prepareWildlandsGroundcoverAt(spawn).catch((error) =>
        console.warn("[core.state.wildlands] boot destination groundcover failed:", error)
      );
      requestWildlandsTreePrime(spawn);
    }
  });

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
  // Wildlands' groundcover/tree masks depend on the core.state.golf course footprint, so
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
    await worldReady;
    await waitForCityGenRenderWindow();

    // CityGen improves every district, so start it before fauna and authored
    // sites. The ring yields once per detached WebGPU prototype and can cancel
    // stale owner work before driver compilation starts.
    // The dynamic import lives inside the builder so zone boot fetches the
    // citygen chunk only at wake, not at reveal.
    const buildCityGenRing = async () => {
      const citygenMod = await import("../../world/citygen");
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
          // a time. Prepare against the live beauty PassNode target—not the
          // default framebuffer context—or r185 rebuilds the node graph on the
          // owner's first real scene-pass frame.
          prepareRenderOwner: (owner) => pipeline.prepareSceneOwner(owner)
        }
      );
    } catch (error) {
      // CityGen is an enhancement over the complete baked city. A failed
      // exterior compile must not publish a half-warm owner or abort the other
      // deferred world modules.
      console.warn("[citygen] exterior preparation failed — retaining baked city", error);
        citygenRing.current = null;
      }
    };
    // Zone boot defers the citygen ring to wake; all consumers use
    // `citygenRing.current?.` so a null ring is already handled everywhere.
    await ctx.zoneBoot.deferCity("citygen", buildCityGenRing);
    // Legacy procedural-spawn probes opt in explicitly. Normal visitors never
    // fetch or construct this duplicate material/render pack.
    if (new URLSearchParams(location.search).has("citygendemo")) {
      await waitForWorldBackgroundWindow();
      const citygenDemoMod = await import("../../world/citygen/demo");
      await waitForWorldBackgroundWindow();
      core.state.citygen = citygenDemoMod.createCityGenDemo({ scene, map }) as unknown as NonNullable<typeof core.state.citygen>;
    }

    // Forest + Creatures: the bay serpent and rideable animals. Zone boot
    // defers them to wake; consumers already read `forest?.`/`creatures?.`.
    const buildForestAndCreatures = async () => {
      await waitForWorldBackgroundWindow(1800);
      const [forestMod, creaturesMod] = await Promise.all([
        import("../../gameplay/forest"),
        import("../../gameplay/creatures")
      ]);
      await waitForWorldBackgroundWindow(1800);
      core.state.ANIMALS = forestMod.ANIMALS as NonNullable<typeof core.state.ANIMALS>;
      core.state.creatures = new creaturesMod.Creatures(scene);
      core.state.forest = new forestMod.Forest(map, scene);
    };
    await ctx.zoneBoot.deferCity("forest-creatures", buildForestAndCreatures);

    // Each optional region keeps its code, textures and tree growth behind its
    // own gate. A clean boot does not fetch all parks merely because the module
    // coordinator itself is running.
    let gardenModPromise: Promise<typeof import("../../world/garden")> | null = null;
    let buenaVistaTreesModPromise: Promise<typeof import("../../world/wildlands/buenaVistaTrees")> | null = null;
    const loadGardenMod = () => gardenModPromise ??= import("../../world/garden");
    const loadBuenaVistaTreesMod = () => buenaVistaTreesModPromise ??= import("../../world/wildlands/buenaVistaTrees");
    // Botanical core.state.garden (heaviest single park: native trees + textures). Gate
    // it only when the spawn is near; otherwise build it AFTER the cover lifts,
    // hidden until compiled, so its trees never sit on the boot path.
    const buildGarden = async () => {
      await waitForWorldBackgroundWindow(1800);
      const gardenMod = await loadGardenMod();
      await waitForWorldBackgroundWindow(1800);
      const g = gardenMod.createBotanicalGarden(map);
      core.state.garden = g;
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
        console.warn("[core.state.garden] deferred compile failed:", err);
      }
      scene.add(g.group);
      g.setVisible(ctx.state.foliageOn, player.position);
    };
    let gardenReady: Promise<unknown> | null = null;
    if (gardenGates) {
      gardenReady = prepareGardenForScene();
    } else {
      void worldReady.then(() => {
        core.state.wakeDeferredGarden = () => {
          core.state.wakeDeferredGarden = null;
          void prepareGardenForScene().catch((err) =>
            console.warn("[core.state.garden] first-approach construction failed:", err)
          );
        };
      });
    }

    // Buena Vista's skyline canopy is visible from Corona Heights, but it does
    // not own the citywide Wildlands, flower rings, or Presidio core.state.golf. Give this
    // compact core.state.forest its own first-approach gate so a Corona visit cannot grow
    // or texture distant redwoods in Golden Gate Park, Marin, or Mount Sutro.
    const buildBuenaVistaTrees = async (deferred: boolean) => {
      await waitForWorldBackgroundWindow(1800);
      const mod = await loadBuenaVistaTreesMod();
      await waitForWorldBackgroundWindow(1800);
      // local, shadows the Marin `forest` state field deliberately
      const forest = mod.createBuenaVistaTrees(map);
      core.state.buenaVistaTrees = forest;
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
      forest.group.visible = ctx.state.foliageOn;
      const h = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
      if (h) Object.assign(h, { buenaVistaTrees: forest });
    };
    let buenaVistaTreesReady: Promise<unknown> | null = null;
    if (buenaVistaGates) {
      buenaVistaTreesReady = buildBuenaVistaTrees(false);
    } else {
      void worldReady.then(() => {
        core.state.wakeDeferredBuenaVistaTrees = () => {
          core.state.wakeDeferredBuenaVistaTrees = null;
          void buildBuenaVistaTrees(true).catch((err) => {
            console.warn("[buena-vista] first-approach construction failed:", err);
          });
        };
      });
    }

    // Wildlands groves + Presidio core.state.golf, built as one coupled unit: the course
    // footprint masks groundcover/trees off the fairways, so the order is fixed
    // (course data → masked groves → course meshes). Gate together when near;
    // otherwise the whole pair streams in after reveal, groves hidden until
    // compiled. `deferred` selects which.
    const buildWildlandsGolf = async (deferred: boolean) => {
      // Destination groundcover has an independent early gate above. Reuse that
      // exact owner here so the later tree/core.state.golf enrichment cannot construct a
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
            `[core.state.wildlands] ${deferred ? "deferred" : "near"} prepare failed for ${unit.name || unit.type}:`,
            err
          );
        }
      });
      wildTreeGroup.visible = ctx.state.foliageOn;
      scene.add(wildTreeGroup);
      markLazyRegion("wildlands", "trees-attached");
      // Presidio core.state.golf game. Own guard — a bad core.state.golf.json must not take the
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
          console.warn("[core.state.golf] deferred compile failed:", err);
        } finally {
          game.root.visible = false;
        }
        game.onNet = (m) => net.sendGolf(m);
        game.onImpact = (p) => fx.impactPuff(p);
        core.state.golf = game;
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
        // Welcome can arrive before this lands; hydrate any peer core.state.golf states Net
        // retained in the meantime.
        net.replayGolf();
      }
    };
    let wildlandsGolfReady: Promise<unknown> | null = null;
    if (wildlandsGolfGates) {
      wildlandsGolfReady = buildWildlandsGolf(false);
    } else {
      void worldReady.then(() => {
        core.state.wakeDeferredWildlandsGolf = () => {
          core.state.wakeDeferredWildlandsGolf = null;
          void buildWildlandsGolf(true).catch((err) => {
            console.warn("[core.state.wildlands/core.state.golf] first-approach construction failed:", err);
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

  // The old settle gate is gone: reveal happened back in P2 the moment the
  // void was ready (bootArrivalTick owns the boot-arrival lifecycle now), and
  // the timer/ctx.state.elapsed/ctx.state.accumulator frame clock lives in P1.
  return {
    net,
    remotes,
    ghostShipBeacon,
    captureMinigameOrigin,
    minigameSession,
    avatar,
    applyBoardConfig,
    board,
    scooter,
    car,
    ensureCarCustomizer,
    chat,
    ridePos,
    rideQuat,
    voice,
    toggleMic,
    minimap,
    playerLocator,
    navigation,
    applyPlaceHistory,
    switchMode,
    teleportToTarget,
    tutorial,
    diagnostics,
    debugPanel,
    oceanKite,
    buildShareUrl,
    debugOverlays,
    calibrationChart,
    syncDebugOverlays,
    aimRay,
    cursorPos,
    entityProxies,
    paintDir,
    paintVel,
    paintMuzzle,
    paintTmp,
    PAINT_HIT,
    lazyRegionTimings,
    teaGarden,
    sites,
    wakeCity,
    nearPrimaryWildRegion,
    nearBuenaVista,
    state
  };
}
