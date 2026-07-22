// AUTO-EXTRACTED from src/main.ts (P3 FRAME block, lines 3486-5003) — see
// docs/MAIN_DECOMPOSITION.md. Behavior-identical move: crossing consts are
// returned on the record; crossing lets live on `state`.
// Soft-HMR guard must register before any other import.meta.hot listeners.
import { suppressesFullReload } from "../../app/hmr/suppressFullReload";
import * as THREE from "three/webgpu";
import { CAMERA_TUNING,  CONFIG,  FOLIAGE_TUNING, RENDER_TUNING, START, START_DEFAULTS, WORLD_TUNING } from "../../config";
import { resetAllTweaks } from "../../core/persist";
import {  formatInteractPrompt, localizeInteractText } from "../../core/input";
import { OCEAN_BEACH_SURF, nearOceanBeachShore } from "../../world/oceanBeachWaves";
import { tetherTreeCullFocus } from "../../world/vegetation/treeCullFocus";
import {  SKY_TUNING } from "../../world/sky";
import {
  GHOST_SHIP_DETAIL_WAKE_DISTANCE,
  GHOST_SHIP_LANDMARK_NAME,
  GHOST_SHIP_RIDE_ID
} from "../../world/ghostShip/route";
import type {  } from "../../world/ghostShip";
import { materializeField } from "../../render/materialize";
import { emitEmbodimentWaterEcho } from "../../world/waterEchoes";
import { syncBallGlowNight } from "../../fx/ballGlow";
import { updateUnderwaterFx } from "../../fx/underwaterRig";
import { updateCrownDisplay, resetCrownTweaks } from "../../world/salesforceCrown";
import {  updateBayLights, resetBayLightsTweaks } from "../../world/bayLights";
import {  updateGoldenGateLights, resetGoldenGateLightsTweaks } from "../../world/goldenGateLights";
import {  updateSutroTower, resetSutroLightsTweaks } from "../../world/sutroTower";
import type {  } from "../../world/goldenGateTennis";
import {
  JAPANESE_TEA_GARDEN_ENTRANCE,
} from "../../world/japaneseTeaGarden/layout";
import type {  } from "../../world/coronaHeights";
import type {  } from "../../world/missionDolores";
import {
  distanceToSutroBaths
} from "../../world/spawnPoints";
import type {  } from "../../player/types";
import {
  PAINTBALL_SPEED
} from "../../fx/paintball";
import {  oceanWaveEnergyAt } from "../../audio/waveAudio";
import {  ABANDONED_MOUNT_PROMPT } from "../../gameplay/abandonedMounts";
import type {  } from "../../gameplay/creatures";
import type {  } from "../../gameplay/forest";
import {
  updateVegetationEnvironment,
  windGustValue,
} from "../../world/vegetation/runtime";
import type {  } from "../../world/citygen";
import { BACKGROUND_STREAM_LIMIT } from "../../world/tiles";
import type {  } from "../../gameplay/archery";
import type {  } from "../../gameplay/pup";
import type {  } from "../../gameplay/fortMasonEnsemble";
import type {  } from "../../gameplay/palaceReverie";
import type {  } from "../../world/landsEnd";
import type {  } from "../../world/waveOrgan";
import type {  } from "../../world/beachPianist";
import type {  } from "../../gameplay/afterlight";
import { isAfterlightOpenAtHour } from "../../gameplay/afterlight/meta";
import { PauseToggle } from "../../ui/pauseToggle";
// The launcher and reader stay dynamically loaded; a reading entry may create
// the shared reader before this game module begins.
import {
  refreshCarHeadlightUniforms,
} from "../../vehicles/car";
import {
  setLocalSurfboardConfig,
} from "../../vehicles/surf";
import { MENU_MODES } from "../../player/discovery";
import { createSessionPersistence } from "../../app/sessionPersistence";
import { createGameLoop } from "../../app/gameLoop";
import type { PassengerExitPose } from "../player/embodimentController";
import { isInGameScreenshotBusy, takeInGameScreenshot } from "../../app/inGameScreenshot";
import { createTimeScrubAndTuningGestures } from "../../app/compose/timeScrub";
import {
  GARDEN_XZ,
  GOLF_XZ,
} from "../../app/compose/minimapLandmarks";
import { writeDevReloadSnapshot } from "../../app/hmr/devReloadSnapshot";
import type {  } from "../../app/systems/pickleball";
import type { MainCtx } from "./ctx";


export async function composeFrameBody(ctx: MainCtx, core: Awaited<ReturnType<typeof import("./worldSystemsCore").composeWorldSystemsCore>>, netW: Awaited<ReturnType<typeof import("./worldSystemsNet").composeWorldSystemsNet>>) {
  const { player, input, camera, scene, worldArrival, chase, map, physics, renderer, sky, aim, tiles, rayOrigin, scheduler, pipeline, authoredRegions, applyLightFrontRamps, voidRealm, audioEngine, renderFrame, timer, bootArrivalTick, backgroundAdmission, voidRevealCheck, ringCoordinator, constructionSlice } = ctx;
  const { water, underwater, hud, fx, wake, boardWake, skidMarks, splashes, fireworks, graffiti, paintballs, paintSkins, bubbles, worldCursor, ensurePaintAudio, ensureBubbleAudio, toolCycle, toolbar, vehicleAudio, swimAudio, doorAudio, nature, lofiMusic, waveAudio, ballImpactAudio, updatePlayerFoley, ensureSurfRuntime, releaseSurfVisual, surfBreakStillLocal, prepareSurfEntry, updateSurfPresentation, birdTrails, droneFireworkMounts, abandonedMounts, embodiments, exitToWalk, inOrbit, siteGate, ensureMissionDolores, gardenDisplacer, gardenDisplacers, setFoliageVisible, worldQueries, citygenRing, dogParkAudio, buskers, buskerTalk, carLanding, orbit, BUSKER_PICK_ID, BUSKER_PICK_R, cycleViewMode } = core;
  const { net, remotes, ghostShipBeacon, captureMinigameOrigin, minigameSession, chat, ridePos, rideQuat, voice, toggleMic, minimap, playerLocator, navigation, applyPlaceHistory, switchMode, teleportToTarget, tutorial, diagnostics, debugPanel, oceanKite, calibrationChart, syncDebugOverlays, aimRay, cursorPos, entityProxies, paintDir, paintVel, paintMuzzle, paintTmp, PAINT_HIT, teaGarden, sites, nearPrimaryWildRegion, nearBuenaVista } = netW;
  const state = {
    cineHook: null as (((dt: number) => void) | null),
  };
  await constructionSlice();

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
      !netW.state.ghostShip &&
      !netW.state.ghostShipLoading &&
      !netW.state.ghostShipLoadFailed &&
      (distance <= GHOST_SHIP_DETAIL_WAKE_DISTANCE || embodiments.passengerOf === GHOST_SHIP_RIDE_ID)
    ) {
      void netW.state.ensureGhostShipDetail!();
    }
    netW.state.ghostShip?.update(
      dt,
      ctx.state.elapsed,
      pose,
      player.renderPosition,
      embodiments.passengerOf === GHOST_SHIP_RIDE_ID,
      player.mode === "walk" && embodiments.passengerOf === null ? player.body : 0
    );
    if (netW.state.ghostShip && embodiments.passengerOf === GHOST_SHIP_RIDE_ID) {
      const shipYaw = netW.state.ghostShip.root.rotation.y;
      if (core.state.ghostShipRideYaw === null) {
        chase.yaw = shipYaw;
      } else {
        const delta = Math.atan2(
          Math.sin(shipYaw - core.state.ghostShipRideYaw),
          Math.cos(shipYaw - core.state.ghostShipRideYaw)
        );
        chase.yaw += delta;
      }
      core.state.ghostShipRideYaw = shipYaw;
    } else {
      core.state.ghostShipRideYaw = null;
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
      core.state.uiOpen = immersiveSnap.uiOpen;
      hud.setFaded(!core.state.uiOpen);
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
  // (state.cineHook hoisted to the module state record)

  const updatePickleballGameplay = (dt: number) => netW.state.pickleballController?.update(dt) ?? false;
  const applyPickleballPlayerPose = () => {
    netW.state.pickleballController?.applyPlayerPose();
    netW.state.fortMasonEnsemble?.applyPlayerPose();
  };
  const hidePickleballRemoteAvatars = () => netW.state.pickleballController?.hideClaimedRemoteAvatars();
  const sendLocalPresence = (speed = player.speed) => {
    if (netW.state.pickleballController) {
      netW.state.pickleballController.sendLocalPresence(speed);
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
  const sendPickleballNetwork = () => netW.state.pickleballController?.sendNetwork();
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
        immersiveSnap = { debugOn: diagnostics.debugOn, uiOpen: core.state.uiOpen };
        immersive = true;
        // setHidden already covers the HUD — leave core.state.uiOpen/faded alone so exit can restore.
        hud.setHidden(true);
        remotes.setTagsVisible(false);
        setDebugUI(false);
        refreshPauseToggle();
      }
    }
    // Tab: toggle the user UI — fade panels in/out. Runs while paused too.
    if (input.pressed("Tab")) {
      core.state.uiOpen = !core.state.uiOpen;
      hud.setFaded(!core.state.uiOpen);
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
      // Either stick pans. Cap their combined vector so using both together is
      // never faster than one full stick and opposing inputs cancel naturally.
      let panX = axes.lx + axes.rx;
      let panY = axes.ly + axes.ry;
      const panMagnitude = Math.hypot(panX, panY);
      if (panMagnitude > 1) {
        panX /= panMagnitude;
        panY /= panMagnitude;
      }
      minimap.padPan(panX, panY, frameDt);
      // RT zooms in; LT zooms out. The selector stays
      // centered until the finite-world framing clamp requires an edge offset.
      minimap.padZoom(axes.rt - axes.lt, frameDt);
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
      lofiMusic.update(frameDt, {
        playerPos: player.renderPosition,
        timeOfDay: sky.timeOfDay,
        allowStart: !worldArrival.active
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
      sky.update(ctx.state.elapsed, camera.position, player.renderPosition);
      applyLightFrontRamps();
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
    core.state.afterlight?.setNightOpen(isAfterlightOpenAtHour(sky.timeOfDay));
    sites.update();
    sites.applyPerfGates();
    // One wake/sleep pass over every registered minigame site (pickleball,
    // core.state.golf, …): a contains() test per site, setAwake only on transitions.
    if (!worldArrival.active) siteGate.update(player.position.x, player.position.z);

    // The shared court keeps advancing even while the rest of the world is
    // paused, so a remote opponent never loses the match when authority opens
    // photo/pause controls.
    pickleballEConsumed =
      worldArrival.active || !sites.perfAllowed("goldman")
        ? false
        : updatePickleballGameplay(frameDt);
    playingPickleball = netW.state.pickleballController?.playing ?? false;
    playingFortMasonEnsemble =
      !worldArrival.active && sites.perfAllowed("fort-mason-ensemble")
        ? netW.state.fortMasonEnsemble?.update(frameDt, ctx.state.elapsed, player.renderPosition, camera) ?? false
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
      lofiMusic.update(frameDt, {
        playerPos: player.renderPosition,
        timeOfDay: sky.timeOfDay,
        allowStart: !worldArrival.active
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
      sky.update(ctx.state.elapsed, camera.position, player.renderPosition);
      applyLightFrontRamps();
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
      ctx.state.accumulator += frameDt; // no ctx.state.elapsed++ — the world clock stays frozen
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
      while (ctx.state.accumulator >= physics.world.fixedTimeStep && steps < 3) {
        if (playingPickleball) input.setSuspensionHold("pickleball-step", true);
        player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
        if (playingPickleball) input.setSuspensionHold("pickleball-step", false);
        physics.step(physics.world.fixedTimeStep);
        ctx.state.accumulator -= physics.world.fixedTimeStep;
        steps++;
      }
      if (steps === 3) ctx.state.accumulator = 0;
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
        player.afterSteps(steps, ctx.state.accumulator / physics.world.fixedTimeStep);
        player.syncMesh(frameDt);
      }
      remotes.glueRidersToLocalVehicle();
      applyPickleballPlayerPose();
      carLanding.consume();
      const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
      core.state.highUp = core.state.highUp ? altitude > 110 : altitude > 150;
      tiles.update(player.position.x, player.position.z, core.state.highUp);
      // Live-player pause still allows walking. Keep the generated-building gate
      // and streaming focus current so crossing a doorway cannot leave the camera
      // stuck in the previous indoor/outdoor mode.
      if (!worldArrival.active) {
        if (ringCoordinator.state === "settled") {
          citygenRing.current?.update(player.position, frameDt);
        }
        if (sites.perfAllowed("sutro-baths")) {
          core.state.sutroBaths?.update(0, ctx.state.elapsed, player.renderPosition, camera, windGustValue());
        }
        if (sites.perfAllowed("hang-gliding")) {
          core.state.hangGliding?.update(frameDt, ctx.state.elapsed, player, hud, input, chase);
        }
      }
      if (inOrbit()) { chase.suspend(player); orbit.update(frameDt); }
      else {
        player.indoor = chase.indoor =
          (citygenRing.current?.isPlayerInside() ?? false) ||
          (core.state.missionDolores?.isPlayerInside(player.position) ?? false) ||
          (core.state.sutroBaths?.isPlayerInside(player.position) ?? false);
        chase.update(frameDt, player, input);
      }
      // keep the vehicle hum, ambience and social presence alive like full pause
      vehicleAudio.update(frameDt, {
        mode: player.hangGliding ? "walk" : player.mode,
        speed: player.speed,
        vspeed: player.velocity.y,
        boost: input.down("ShiftLeft"),
        grounded: player.mode !== "board" || player.boardGrounded,
        surfFace: player.mode === "surf" ? player.surfTelemetry.face : 0,
        surfFlow: player.mode === "surf" && player.surfTelemetry.flowActive ? 1 : 0,
        surfMotionRate: player.mode === "surf" ? player.surfTelemetry.riderMotionRate : 1,
        driveVoice: player.driveSpec.voice ?? "engine",
        driveSlide: player.driveSlideFeedback.intensity
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
      lofiMusic.update(frameDt, {
        playerPos: player.renderPosition,
        timeOfDay: sky.timeOfDay,
        allowStart: !worldArrival.active
      });
      sendLocalPresence();
      sendPickleballNetwork();
      voice.update();
      minimap.update();
      playerLocator.update(camera, player.position, remotes.locatorTargets());
      hud.update(frameDt);
      // paused-but-roaming still streams tiles/core.state.citygen — keep their deferred
      // assembly draining so the frozen city fills in around the live player
      scheduler.run(frameDt < 1 / 55 ? 3 : 1.5);
      updateSurfPresentation(frameDt);
      // The world clock stays frozen, but the player and camera can move in this
      // branch. Keep shadow coverage and the every-frame subject map current.
      sky.update(ctx.state.elapsed, camera.position, player.renderPosition);
      // The GPU foliage frustum culls follow the render camera; without this
      // the paused orbit would pan past a frozen visibility set and grass or
      // blooms would pop out at the old frustum's edge.
      if (ctx.state.foliageOn && !worldArrival.active) {
        core.state.wildlands?.update(player.renderPosition, camera.position, camera);
      }
      applyLightFrontRamps();
      input.endFrame();
      renderFrame();
      return "handled";
    }

    return "live";
  };

  // Live-frame input: mode/tool/teleport keys, interact chain, click-tool fire,
  // time scrub, fly steering + latched jumps, ending at chase.lookDir. Advances
  // the world clock too — this is the only path that increments ctx.state.elapsed.
  const liveInput = (frameDt: number) => {
    ctx.state.elapsed += frameDt;
    ctx.state.accumulator += frameDt;

    // Plain number keys switch travel modes; Ctrl+number still jumps click-tools;
    // Shift+number teleports to player slots. Arrows: ↑/↓ between toolbar rows,
    // ←/→ cycle the focused row (vehicles / tools / paint swatches).
    const numberPressed = (i: number) => input.pressed(`Digit${i}`) || input.pressed(`Numpad${i}`);
    const ctrlNumberPress = (i: number) => input.ctrlPressed(`Digit${i}`) || input.ctrlPressed(`Numpad${i}`);
    const shiftedNumberPress = (i: number) => input.shiftedPress(`Digit${i}`) || input.shiftedPress(`Numpad${i}`);
    for (let i = 1; i <= 9; i++) {
      if (!numberPressed(i)) continue;
      if (playingPickleball || playingFortMasonEnsemble) break;
      if (core.state.golf?.capturesDigits) break; // core.state.golf swing UI owns the number row (club picks)
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
      const choosingTalk = ctx.state.beachPianist?.choosing
        ? ctx.state.beachPianist
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
    const activeTalk = ctx.state.beachPianist?.active
      ? ctx.state.beachPianist
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
    // Use the same position the tea-core.state.garden prompt distance is measured against
    // (renderPosition), so a visible "Talk" prompt always accepts the matching E.
    let teaGardenEConsumed = interactPressed
      && teaGarden.interact(player.renderPosition, player.mode);
    const hangGlidingOwnsInteract =
      interactPressed && (core.state.hangGliding?.capturesInteraction ?? false);
    let passengerExit: PassengerExitPose | undefined;
    if (embodiments.passengerOf === GHOST_SHIP_RIDE_ID && netW.state.ghostShip) {
      const facing = netW.state.ghostShip.deckDismountPose(
        embodiments.passengerSeat,
        ridePos
      );
      if (facing !== null) passengerExit = { position: ridePos, facing };
    }
    const exitedToWalk =
      interactPressed && !teaGardenEConsumed && !hangGlidingOwnsInteract && exitToWalk(passengerExit);
    if (exitedToWalk) {
      teaGardenEConsumed = teaGarden.interact(player.renderPosition, player.mode);
    }
    if (
      !pickleballEConsumed &&
      !teaGardenEConsumed &&
      interactPressed &&
      !exitedToWalk &&
      !(ctx.state.beachPianist?.tryInteract(player.renderPosition, player.mode) ?? false) &&
      !buskerTalk.tryInteract(player.renderPosition, player.mode) &&
      !core.state.golf?.tryStartAtTee(player, hud) &&
      !core.state.archery?.tryInteract(player, hud, chase) &&
      !netW.state.fortMasonEnsemble?.tryInteract(player.renderPosition, player.mode) &&
      !core.state.palaceReverie?.tryInteract(player, hud) &&
      !core.state.landsEnd?.keeper.tryInteract(player, hud) &&
      !core.state.waveOrgan?.tryInteract(player, hud) &&
      !core.state.missionDolores?.tryInteract(player.position, player.mode, hud) &&
      !core.state.hangGliding?.tryInteract(player, hud, input, chase) &&
      !core.state.afterlight?.tryInteract(player, hud) &&
      !(
        core.state.surfShack?.tryInteract(player, hud, (config) => {
          ctx.state.surfboardConfig = config;
          setLocalSurfboardConfig(config);
          player.setSurfboardConfig(config);
          const request = ++netW.state.surfEntryRequest;
          // Full preparation (camera + runtime + a fresh embodiment compile if
          // the grabbed board differs) so the first ridden frame is stall-free.
          void prepareSurfEntry().then(() => {
            if (request !== netW.state.surfEntryRequest || player.mode !== "walk") return;
            navigation.switchMode("surf");
          });
        }) ?? false
      )
    ) {
      const nearGhostShip = player.mode === "walk" && (netW.state.ghostShip?.nearbyBoarding(player.position) ?? false);
      if (nearGhostShip) {
        const seat = netW.state.ghostShip?.board(
          player.position,
          remotes.occupiedRideSeats(GHOST_SHIP_RIDE_ID)
        ) ?? 0;
        if (seat > 0) {
          core.state.ghostShipRideZoom ??= chase.zoom;
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
        const request = ++netW.state.surfEntryRequest;
        void prepareSurfEntry().then((ready) => {
          if (!ready || request !== netW.state.surfEntryRequest || player.mode !== "walk") return;
          if (!nearOceanBeachShore(player.position.x, player.position.z)) return;
          player.trySwitch("surf");
          // The persistent surf HUD already carries controls; keep this as a
          // quick entry confirmation so it is gone before a fast tube line.
          hud.message("You're surfing — A/D carve · W climb + pump · S stall · E exits", 1);
        });
        } else if (!core.state.fetchBall?.tryPickup(player.position)) {
        const drv = remotes.nearestDriver(player.position, 5.5);
        const animal = drv ? null : core.state.forest?.nearest(player.position, 5);
        if (drv) {
          if (drv.mode === "bird") core.state.setRemoteBirdAssetsActive!(true);
          embodiments.startPassengerRide(drv.id, drv.seat);
          hud.message(`Riding with ${drv.name} — E to hop out`, 2.6);
        } else if (animal && core.state.forest && core.state.ANIMALS) {
          const info = core.state.forest.consume(animal);
          embodiments.currentAnimal = info.kind;
          player.setDriveStyle(core.state.forest.buildRiddenMesh(info.kind), core.state.ANIMALS[info.kind].spec);
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
      !worldArrival.active && (core.state.afterlight?.captureInput(input, frameDt, player) ?? false);

    // ".": factory reset for tweaks and the audio mixer — every value back to
    // its source-code default, saved overrides wiped. Player stays put.
    if (!worldArrival.active && input.pressed("Period")) {
      resetAllTweaks();
      core.audioControls.resetToDefaults();
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
      sky.setStreamingCullRadius(Math.min(WORLD_TUNING.values.radius, BACKGROUND_STREAM_LIMIT));
      setFoliageVisible(FOLIAGE_TUNING.values.visible);
      tiles.forceScan();
      sky.applyFogParams();
      sky.invalidateStaticShadows("all");
      pipeline.applyPostFx(); // toggles back off + sliders back to defaults
      sky.dayCycleSeconds = SKY_TUNING.values.dayCycleSeconds;
      sky.nightBrightness = SKY_TUNING.values.nightBrightness;
      sky.followRealTime(); // default: back to mirroring the real SF clock
      sky.applyFogParams();
      sky.refreshFogWeatherSource();
      debugPanel.syncNow();
      citygenRing.current?.refreshInteriors();
      hud.message("Tweaks and mixer back to source defaults", 3);
    }
    if (!worldArrival.active && input.pressed("KeyC")) {
      cycleViewMode();
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
      core.state.orbitFlip = { t: 0, duration, startAz: orbit.azimuthAngle, delta, startDist, endDist };
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
    // B: Beach pianist film cue — start/restart the song without talking to him
    // (set the camera first). Shift+B picks Fogline Nocturne; plain B is Sunset Jam.
    if (
      document.body.classList.contains("started") &&
      !worldArrival.active &&
      ctx.state.beachPianist &&
      input.pressed("KeyB")
    ) {
      const songIndex = input.shiftedPress("KeyB") ? 1 : 0;
      if (ctx.state.beachPianist.cueShow(songIndex)) {
        hud.message(songIndex === 1 ? "Pianist · Fogline Nocturne" : "Pianist · Sunset Jam", 2.2);
      }
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
    netW.state.fireCooldown -= frameDt;
    if (input.freeCursor) {
      // free cursor out: clicks only reach UI panels — the ball/spray/bubble
      // tools stand down so pointing around never fires them
    } else if (playingPickleball) {
      // Pickleball consumes click as a paddle swing; do not also fire the
      // selected city tool or a vehicle weapon.
    } else if (core.state.golf?.capturesFire) {
      // core.state.golf swing context: the held mouse is the power meter (gameplay/core.state.golf
      // reads input.firing itself) — every click-tool stands down
    } else if (core.state.archery?.capturesFire) {
      // core.state.archery draw context: the held mouse pulls the bow (gameplay/core.state.archery
      // reads input.firing itself) — every click-tool stands down
    } else if (player.mode === "drone") {
      if (!input.suspended && input.firePressed && netW.state.fireCooldown <= 0) {
        chase.lookDir(aim);
        netW.state.fireCooldown = 0.22;
        fireworks.launchDroneSalvo(droneFireworkMounts ?? [], aim, player.velocity);
        chase.shake(0.08);
      }
    } else if (input.firing && embodiments.currentAnimal === "raccoon") {
      // mounted raccoon: the click-tools stand down, the gummy cannon speaks
      if (netW.state.fireCooldown <= 0) {
        chase.interactionDir(aim, player);
        netW.state.fireCooldown = 0.13;
        chase.viewOrigin(rayOrigin, player);
        core.state.forest?.fireGummy(rayOrigin, aim, player.velocity);
      }
    } else if (toolCycle.tool === "ball") {
      // Hold to wind up overhand (meter fills); release after 1s to throw,
      // earlier stows. Hands empty afterward — pick balls back up with E.
      if (core.state.fetchBall) {
        chase.interactionDir(aim, player);
        const cancelled =
          input.suspended || (input.device === "kb" && (!input.locked || !document.hasFocus()));
        core.state.fetchBall.driveThrow(frameDt, input.firing && !input.suspended, aim, cancelled);
      }
    } else if (input.firing) {
      chase.interactionDir(aim, player);
      chase.viewOrigin(rayOrigin, player);
      if (toolCycle.tool === "spray" && netW.state.fireCooldown <= 0) {
        // paintballs: visible ballistic shots that splat wherever they land —
        // walls via graffiti.burst, vehicles/players via paintSkins. The shot
        // is broadcast (origin+velocity+color) so everyone sees it fly.
        netW.state.fireCooldown = 0.12;
        const col = graffiti.nextColor();
        const paintColor = { r: col.r, g: col.g, b: col.b };
        const soundPaintShot = (audio: import("../../fx/paintAudio").PaintAudio) => audio.shot({
          color: paintColor,
          pressure: 0.82,
          intensity: 0.74,
          pan: 0.035,
          room: player.indoor ? 0.16 : 0.05,
          sourceId: net.selfId
        });
        if (core.state.paintAudio) soundPaintShot(core.state.paintAudio);
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
      } else if (toolCycle.tool === "bubbles" && netW.state.fireCooldown <= 0) {
        netW.state.fireCooldown = 0.14;
        bubbles.blow(rayOrigin, aim, player.velocity);
        if (core.state.bubbleAudio) {
          core.state.bubbleAudio.blow({
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
    const flipping = core.state.orbitFlip !== null;
    if (inOrbit()) orbit.enabled = !scrubHeld && !adjustHeld && !flipping; // don't let orbit eat the drag/wheel
    if (core.state.orbitFlip) {
      core.state.orbitFlip.t += frameDt;
      const u = Math.min(1, core.state.orbitFlip.t / core.state.orbitFlip.duration);
      const eased = u * u * (3 - 2 * u); // smoothstep — zero velocity at ends
      orbit.azimuthAngle = core.state.orbitFlip.startAz + core.state.orbitFlip.delta * eased;
      orbit.distance = core.state.orbitFlip.startDist + (core.state.orbitFlip.endDist - core.state.orbitFlip.startDist) * eased;
      if (u >= 1) core.state.orbitFlip = null;
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
    while (ctx.state.accumulator >= physics.world.fixedTimeStep && steps < 3) {
      if (playingPickleball) input.setSuspensionHold("pickleball-step", true);
      player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
      if (playingPickleball) input.setSuspensionHold("pickleball-step", false);
      abandonedMounts.prePhysics(physics.world.fixedTimeStep);
      physics.step(physics.world.fixedTimeStep);
      ctx.state.accumulator -= physics.world.fixedTimeStep;
      steps++;
    }
    if (steps === 3) ctx.state.accumulator = 0;
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
      player.afterSteps(steps, ctx.state.accumulator / physics.world.fixedTimeStep);
      player.syncMesh(frameDt);
    }
    // riders of MY vehicle re-glue against the mesh transform that was just
    // settled — without this they'd sit one frame behind the cabin at speed
    remotes.glueRidersToLocalVehicle();
    applyPickleballPlayerPose();
    carLanding.consume();
    const altitude = player.position.y - map.groundHeight(player.position.x, player.position.z);
    core.state.highUp = core.state.highUp ? altitude > 110 : altitude > 150;
    // Optional park chunks remain unfetched until first approach. Capture the
    // callback before invoking it because each loader clears its own one-shot.
    if (
      !worldArrival.active &&
      core.state.wakeDeferredGarden &&
      Math.hypot(player.position.x - GARDEN_XZ.x, player.position.z - GARDEN_XZ.z) < 900
    ) {
      const wake = core.state.wakeDeferredGarden;
      core.state.wakeDeferredGarden = null;
      wake();
    }
    if (!worldArrival.active) teaGarden.maybeWakeDeferred(player.position);
    if (
      !worldArrival.active &&
      core.state.wakeDeferredBuenaVistaTrees &&
      nearBuenaVista(player.position.x, player.position.z, 1150)
    ) {
      const wake = core.state.wakeDeferredBuenaVistaTrees;
      core.state.wakeDeferredBuenaVistaTrees = null;
      wake();
    }
    if (
      !worldArrival.active &&
      core.state.wakeDeferredWildlandsGolf &&
      (
        // Buena Vista owns the Corona skyline separately. Wake the primary
        // Wildlands only on a real approach to one of its four regions. The
        // authored Tea Garden owns its immediate foliage and keeps this broader
        // park/core.state.golf bundle asleep until the player leaves that site.
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
      const wake = core.state.wakeDeferredWildlandsGolf;
      core.state.wakeDeferredWildlandsGolf = null;
      wake();
    }
    // high over the city streams buildings only — no park lawns / trees uploaded.
    // turbo while the loading cover is still up (see the settle gate)
    if (!worldArrival.active) authoredRegions.update(player.position.x, player.position.z);
    tiles.update(player.position.x, player.position.z, core.state.highUp, !ctx.state.revealed);
    core.state.trafficLights?.update(player.position, performance.now() / 1000);
    refreshCarHeadlightUniforms();
    abandonedMounts.update(frameDt, player.position);
    if (!worldArrival.active) {
      core.state.creatures?.update(ctx.state.elapsed, camera.position);
      core.state.forest?.update(frameDt, camera.position);
    }
    // Night ball glow amount from the current sun elevation (park / fetch / held /
    // pickleball all read BALL_GLOW_NIGHT). Uses last sky.update's elevation —
    // fine; elevation only moves with the clock.
    syncBallGlowNight(sky.sunElevation);
    if (!worldArrival.active) {
      if (sites.perfAllowed("corona")) {
        core.state.coronaHeights?.update(frameDt, ctx.state.elapsed, camera.position);
      } else if (core.state.coronaHeights) {
        core.state.coronaHeights.group.visible = false;
      }
      if (sites.perfAllowed("lands-end")) {
        core.state.landsEnd?.update(frameDt, ctx.state.elapsed, player.position, camera, windGustValue());
        if (core.state.landsEnd && player.mode === "walk") {
          core.state.landsEnd.keeper.updatePrompt(player.position.x, player.position.z, hud);
        }
      } else if (core.state.landsEnd) {
        core.state.landsEnd.group.visible = false;
      }
      if (sites.perfAllowed("wave-organ")) {
        // hud only while on foot — walking is how you put an ear to a pipe.
        core.state.waveOrgan?.update(frameDt, ctx.state.elapsed, player.position, player.mode === "walk" ? hud : null);
      } else if (core.state.waveOrgan) {
        core.state.waveOrgan.group.visible = false;
      }
      if (sites.perfAllowed("beach-pianist")) {
        ctx.state.beachPianist?.setPerfSuppressed(false);
        ctx.state.beachPianist?.update(frameDt, ctx.state.elapsed, player.position, camera, windGustValue());
      } else if (ctx.state.beachPianist) {
        ctx.state.beachPianist.setPerfSuppressed(true);
      }
      // Landscape vegetation rings (internally gated on the master foliage
      // toggle; a few hypot tests per frame when idle).
      ctx.state.siteFoliage?.update(player.position.x, player.position.z);
    }
    // Ball fetch loop + pet follow run every frame, tool-agnostic, so a thrown
    // ball keeps bouncing and a returning/adopted dog keeps moving even after
    // switching tools. verb() keeps the HUD Click row in sync with hold-to-throw.
    const petSeat = player.mode === "scooter" && !remotes.hasPassenger(net.selfId)
      ? (player.meshes.scooter.userData.petSeat as THREE.Object3D | undefined) ?? null
      : null;
    if (!worldArrival.active) core.state.fetchBall?.update(frameDt, ctx.state.elapsed, player.position, petSeat);
    if (toolCycle.tool === "ball" && core.state.fetchBall) hud.setToolVerb(core.state.fetchBall.verb());
    gardenDisplacer.x = player.renderPosition.x;
    gardenDisplacer.z = player.renderPosition.z;
    updateVegetationEnvironment(frameDt, ctx.state.foliageOn ? gardenDisplacers : undefined);
    oceanKite.update(frameDt, ctx.state.elapsed, ctx.state.revealed);
    buskers.update(frameDt, camera, windGustValue(), sky.sunElevation);
    buskerTalk.update(player.renderPosition);
    if (!worldArrival.active) {
      if (sites.perfAllowed("sutro-baths")) {
        core.state.sutroBaths?.update(frameDt, ctx.state.elapsed, player.renderPosition, camera, windGustValue());
      }
      teaGarden.update(
        frameDt,
        ctx.state.elapsed,
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
    if (ctx.state.foliageOn && !worldArrival.active) {
      // Garden moves its near-grass detail ring to the player. Shared wind and
      // displacement were already advanced by the root vegetation runtime above.
      // Cheap when the player is nowhere near the core.state.garden
      // (updateFocus distance-culls base chunks and skips the near ring).
      core.state.garden?.update(player.renderPosition);
      // wildlands: the grass + flower rings follow the PLAYER (like the core.state.garden ring
      // above) so they stay put when you just look around — the chase camera orbits
      // the player, and anchoring the rings to it slid the whole field around you.
      // Tree distance-culling follows the camera only once it truly leaves the
      // player (flyover/cinematics): inside the chase tether it pins to the
      // player so looking around never re-centres tree LOD/near rings.
      core.state.wildlands?.update(player.renderPosition, camera.position, camera);
      core.state.buenaVistaTrees?.update(
        tetherTreeCullFocus(player.renderPosition, camera.position)
      );
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
    // the lo-fi score breathes alongside the nature ambience everywhere
    lofiMusic.update(frameDt, {
      playerPos: player.renderPosition,
      timeOfDay: sky.timeOfDay,
      allowStart: !worldArrival.active
    });
    // live loop only: the dogs freeze during pause, so barking there would lie
    dogParkAudio.update(frameDt, player.renderPosition);
    // keeps the shared context awake for the magic-echo tail + applies live echo
    // tuning; balls keep flying tool-agnostically, so run it every live frame
    ballImpactAudio.update(frameDt);
    if (embodiments.currentAnimal) core.state.forest?.setRiddenSpeed(player.speed);
    if (!worldArrival.active) core.state.islands?.update(ctx.state.elapsed, camera.position);
    // Baked destination tiles already provide the fixed-quality arrival view.
    // CityGen hydrates its richer cells only after the complete point/fog
    // handoff settles, so it never competes with teleport-critical work or
    // changes the authored reveal timing.
    if (!worldArrival.active && ringCoordinator.state === "settled") {
      citygenRing.current?.update(player.position, frameDt);
    }
    if (!worldArrival.active && !core.state.highUp) core.state.hunt?.update(frameDt, ctx.state.elapsed, player.position);
    if (!worldArrival.active) core.state.golf?.update(frameDt, ctx.state.elapsed, { player, input, hud, chase, camera });
    if (!worldArrival.active && sites.perfAllowed("palace")) {
      core.state.palaceReverie?.update(frameDt, ctx.state.elapsed, player.position, hud);
      const welcome = core.state.palaceReverie?.takeWelcome();
      if (welcome) hud.message(welcome, 6.2);
    }
    // Archery: site-gated, one boolean early-return when asleep with nothing live
    if (!worldArrival.active && sites.perfAllowed("archery")) {
      core.state.archery?.update(frameDt, ctx.state.elapsed, { player, input, hud, chase, camera });
    }
    // Biscuit the RL pup: site-gated, one boolean early-return when asleep
    if (!worldArrival.active && sites.perfAllowed("pup")) {
      core.state.pup?.update(frameDt, camera);
    }
    // Afterlight: proximity collectibles, return flights, quest clock and the
    // completed sky performance; site-gated to a single asleep early return.
    if (!worldArrival.active && sites.perfAllowed("afterlight")) {
      core.state.afterlight?.update(frameDt, ctx.state.elapsed, player, hud);
    }
    // Sutro Tower's Skyline Glide: the fixed-step plane controller owns the
    // air; this lazy site owns gates, thermals, scoring and landing evaluation.
    if (!worldArrival.active && sites.perfAllowed("hang-gliding")) {
      core.state.hangGliding?.update(frameDt, ctx.state.elapsed, player, hud, input, chase);
    }
    // Goldman clubhouse NPCs: one-hypot early return when far — safe every frame
    if (!worldArrival.active && sites.perfAllowed("goldman")) {
      core.state.goldenGateTennis?.update(frameDt, ctx.state.elapsed, player.position);
    }
    // Mission Dolores: dynamic code gate first, then shell/art proximity gates.
    if (!worldArrival.active) ensureMissionDolores(player.position);
    if (!worldArrival.active) core.state.missionDolores?.update(frameDt, ctx.state.elapsed, player.position, player.mode, hud);
    const museumFloorHandoff = worldArrival.active
      ? null
      : core.state.missionDolores?.takeFloorHandoffHeight(player.position, player.mode);
    if (museumFloorHandoff != null) player.recoverOntoWalkSurface(museumFloorHandoff);
    // Sutro Baths buries its footprint and floats the deck above the old ground.
    // Same handoff: lift a capsule stranded beneath the freshly built deck.
    const sutroFloorHandoff = worldArrival.active
      ? null
      : core.state.sutroBaths?.takeFloorHandoffHeight(player.position, player.mode);
    if (sutroFloorHandoff != null) player.recoverOntoWalkSurface(sutroFloorHandoff);

    // Prime the surf runtime while the player is still walking up to the
    // shack: waves + rider pipelines compile during the approach, so the E
    // press starts the ride without a single pipeline stall. This is the
    // activity's proximity gate — nothing surf-related loads elsewhere.
    if (
      player.mode === "walk" &&
      core.state.surfShack &&
      !ctx.state.oceanBeachWaves &&
      !core.state.surfRuntimeLoading &&
      core.state.surfEntryPreparations === 0
    ) {
      const surfPrimeDx = player.position.x - core.state.surfShack.pose.x;
      const surfPrimeDz = player.position.z - core.state.surfShack.pose.z;
      if (surfPrimeDx * surfPrimeDx + surfPrimeDz * surfPrimeDz < 90 * 90) void prepareSurfEntry();
    }

    // "hop in" nudge when standing near a ride (friend → wildlife → parked mount)
    if (!worldArrival.active && player.mode === "walk" && embodiments.passengerOf === null) {
      const nearGhostShip = netW.state.ghostShip?.nearbyBoarding(player.position) ?? false;
      const drv = nearGhostShip ? null : remotes.nearestDriver(player.position, 5.5);
      if (drv?.mode === "bird") core.state.setRemoteBirdAssetsActive!(true);
      const nearAnimal = drv ? null : core.state.forest?.nearest(player.position, 5);
      const nearMount =
        !drv && !nearAnimal
          ? abandonedMounts.nearest(player.position.x, player.position.z, 5.5)
          : null;
      const surfBoardPrompt =
        !drv && !nearAnimal && !nearMount
          ? core.state.surfShack?.nearbyPrompt(player.position.x, player.position.z, input.device) ?? null
          : null;
      const reveriePrompt =
        !drv && !nearAnimal && !nearMount && !surfBoardPrompt
          ? core.state.palaceReverie?.nearbyPrompt(player.position.x, player.position.z) ?? null
          : null;
      if ((nearGhostShip || drv || nearAnimal || nearMount || surfBoardPrompt || reveriePrompt) && !core.state.ridePromptShown) {
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
        core.state.ridePromptShown = true;
      }
      if (!nearGhostShip && !drv && !nearAnimal && !nearMount && !surfBoardPrompt && !reveriePrompt) core.state.ridePromptShown = false;
      // "open the door" nudge — same one-shot pattern; the ride prompt wins
      // when both are in range. nearestDoor is alloc-light but not free, so
      // it runs every 6th frame (prompt latency ~0.1 s) and only on foot.
      if (--core.state.doorScanCountdown <= 0) {
        core.state.doorScanCountdown = 6;
        core.state.doorScanHit = citygenRing.current?.nearestDoor(player.position) ?? null;
      }
      const door = core.state.doorScanHit;
      const nearClosedDoor = !!door && !door.open && door.dist < 3.2;
      if (nearClosedDoor && !nearGhostShip && !drv && !nearAnimal && !nearMount && !core.state.doorPromptShown) {
        hud.message(formatInteractPrompt("open the door", input.device), 1.8);
        core.state.doorPromptShown = true;
      }
      if (!nearClosedDoor) core.state.doorPromptShown = false;
    } else {
      core.state.ridePromptShown = false;
      core.state.doorPromptShown = false;
    }
    chase.activityFirstPerson = core.state.archery?.firstPersonActive ?? false;
    if (state.cineHook) {
      chase.suspend(player);
      state.cineHook(frameDt); // scripted cinematic owns pose + camera
    } else if (core.state.golf?.updateBallCam(frameDt, camera)) {
      chase.suspend(player);
      // core.state.golf flight cam: chases the ball until it settles, then hands back
    } else if (inOrbit()) {
      chase.suspend(player);
      orbit.update(frameDt);
    } else {
      player.indoor = chase.indoor =
        (citygenRing.current?.isPlayerInside() ?? false) ||
        (core.state.missionDolores?.isPlayerInside(player.position) ?? false) ||
        (core.state.sutroBaths?.isPlayerInside(player.position) ?? false); // blend into the indoor eye rig
      chase.update(frameDt, player, input);
    }
    // World-anchored dialogue must project after the chase/orbit/cinematic has
    // committed this frame's final camera pose; projecting during simulation
    // left Hiro's card one camera frame behind and visibly jittering.
    teaGarden.project(camera);
    buskerTalk.project(camera);
    ctx.state.beachPianist?.project(camera);
    // Ring-coordinator front driver + materialize front animation + void-realm
    // coupling (uniform writes only).
    ctx.state.ringUpdate(frameDt);
    materializeField.update(frameDt);
    voidRealm.update();
    sky.update(ctx.state.elapsed, camera.position, player.renderPosition);
    applyLightFrontRamps();
    // Surf contact/camera use Player's fixed-step simulation clock. Feed that
    // exact clock to the displaced ocean and lazy face/roof too; using render
    // ctx.state.elapsed here let the visible crest and barrel envelope drift away after
    // loading, pause, or deterministic headless stepping.
    const surfaceTime = player.mode === "surf" ? player.time : ctx.state.elapsed;
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
    water.update(surfaceTime, camera.position, player.renderPosition, ctx.state.oceanBeachWaves !== null);
    // The roof materializes with the CAMERA's barrel blend, not the gameplay
    // tube state: state-driven visibility drew the roof while the camera was
    // still outside, where its pale lip seen edge-on through fog read as a
    // white disc floating over the crest.
    const surfTubeVisibility =
      player.mode === "surf" ? chase.surfCameraDiagnostics()?.tubeBlend ?? 0 : 0;
    ctx.state.oceanBeachWaves?.update(surfaceTime, player.renderPosition, surfTubeVisibility);
    // Safety net for restored/direct surf transitions. Entry preparation keeps
    // its newly constructed mesh alive until the mode switch commits; otherwise
    // the activity visual is disposed on the first non-surf frame.
    if (!ctx.state.oceanBeachWaves && player.mode === "surf") {
      void ensureSurfRuntime();
    } else if (ctx.state.oceanBeachWaves && !surfBreakStillLocal()) {
      releaseSurfVisual();
    }
    underwater.update(camera, ctx.state.elapsed);
    // GPU underwater package: drives the permanent post-FX fog/god-ray
    // uniforms and lazily loads/prewarms the marine-snow + caustics volume on
    // first near-water approach (identity + early-return while dry).
    updateUnderwaterFx({
      camera,
      map,
      renderer,
      scene,
      time: ctx.state.elapsed,
      dt: frameDt
    });
    fx.update(frameDt);
    bubbles.update(frameDt, ctx.state.elapsed);
    wake.update(frameDt, surfaceTime, player);
    boardWake.update(frameDt, surfaceTime, player);
    skidMarks.update(frameDt, ctx.state.elapsed, player);
    birdTrails.update(ctx.state.elapsed, player);
    splashes.update(frameDt, surfaceTime, player);
    core.state.surfExperience?.update(frameDt, player.mode, player.surfTelemetry);
    if (player.mode === "surf" && player.surfTelemetry.splashSerial !== core.state.surfSplashSerial) {
      core.state.surfSplashSerial = player.surfTelemetry.splashSerial;
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
    const waveEnergy = oceanWaveEnergyAt(map, player.position.x, player.position.z, ctx.state.elapsed);
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
      mode: player.hangGliding ? "walk" : player.mode,
      speed: player.speed,
      vspeed: player.velocity.y,
      boost: input.down("ShiftLeft"),
      grounded: player.mode !== "board" || player.boardGrounded,
      surfFace: player.mode === "surf" ? player.surfTelemetry.face : 0,
      surfFlow: player.mode === "surf" && player.surfTelemetry.flowActive ? 1 : 0,
      surfMotionRate: player.mode === "surf" ? player.surfTelemetry.riderMotionRate : 1,
      driveVoice: player.driveSpec.voice ?? "engine",
      driveSlide: player.driveSlideFeedback.intensity
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
        !immersive &&
        player.mode !== "surf" &&
        !inOrbit() &&
        !input.suspended &&
        !state.cineHook &&
        !(paused && freezePlayer);
      if (cursorLive) {
        aimRay(rayOrigin, aim);
        // rest on the nearest thing the ray meets — entity, building, terrain
        // or water (never my own body) — for honest depth; else float ahead
        const hit = worldQueries.raycast(rayOrigin, aim, 60, { ignoreSelf: true });
        if (hit) {
          cursorPos.copy(hit.point);
          netW.state.overlayRayHit = { x: hit.point.x, y: hit.point.y, z: hit.point.z };
        } else {
          cursorPos.copy(rayOrigin).addScaledVector(aim, 22);
          netW.state.overlayRayHit = null;
        }
        worldCursor.update(frameDt, camera, cursorPos, 0, true);
      } else {
        netW.state.overlayRayHit = null;
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
  // it. Boot-arrival progression (control release, collision retries,
  // completion) is shared with the void loop via bootArrivalTick (P2).
  const postSchedule = (_frameDt: number) => {
    bootArrivalTick();
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
    isRevealed: () => ctx.state.revealed,
    hooks: {
      onFrameStart: () => buskers.flushHotSwap(),
      beginFrame,
      readingFrozen: () =>
        (netW.state.btsReading && document.body.classList.contains("started")) || core.state.museumBookOpen,
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
      afterRender: () => {
        // See voidRevealCheck: reveal can still be pending here when boot
        // compiles held every void-phase frame through the handoff.
        voidRevealCheck();
        diagnostics.updateStats();
      }
    }
  });
  return {
    tick,
    state
  };
}
