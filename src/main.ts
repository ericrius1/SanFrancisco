// Soft-HMR guard must register before any other import.meta.hot listeners.
import * as THREE from "three/webgpu";
import CameraControls from "camera-controls";
import {     FOLIAGE_TUNING, RENDER_TUNING, START } from "./config";
import {  saveTweak } from "./core/persist";
import { Input } from "./core/input";
import { tracer } from "./core/hitchTracer";
import { bootMarkStart, bootMark, bootMarkList, bootMarkSummary, persistBootHistory } from "./core/bootMarks";
import { createFrameScheduler } from "./core/frameBudget";
import { createFrameBudgetCheckpoint } from "./core/cooperativeWork";
import { prefetchBox3D } from "./core/box3dWorld";
import { Sky } from "./world/sky";
import type {  } from "./world/ghostShip";
import { VoidRealm } from "./world/voidRealm";
import { materializeField } from "./render/materialize";
import { syncBallGlowNight } from "./fx/ballGlow";
import { FarOcclusionField } from "./world/shadows/farOcclusionField";
import {    BAY_LIGHTS_INTENSITY } from "./world/bayLights";
import {    GOLDEN_GATE_LIGHTS_INTENSITY } from "./world/goldenGateLights";
import {    SUTRO_LIGHTS_INTENSITY, SUTRO_TOWER_ANCHOR } from "./world/sutroTower";
import type {  } from "./world/goldenGateTennis";
import type {  } from "./world/coronaHeights";
import type {  } from "./world/missionDolores";
import { Player } from "./player/player";
import type {  } from "./player/types";
import { ChaseCamera } from "./core/camera";
import { audioEngine } from "./audio/engine";
import type {  } from "./gameplay/creatures";
import type {  } from "./gameplay/forest";
import type {  } from "./world/citygen";
import type {  } from "./gameplay/archery";
import type {  } from "./gameplay/pup";
import type {  } from "./gameplay/fortMasonEnsemble";
import type {  } from "./gameplay/palaceReverie";
import type {  } from "./world/landsEnd";
import { SiteFoliageStreamer } from "./world/vegetation/siteFoliage";
import type {  } from "./world/waveOrgan";
import type { BeachPianist } from "./world/beachPianist";
import type {  } from "./gameplay/afterlight";
import { HUD } from "./ui/hud";
// The launcher and reader stay dynamically loaded; a reading entry may create
// the shared reader before this game module begins.
import { beganAsReadingVisit } from "./app/startupIntent";
import { createRenderPipeline } from "./render/pipeline";
import { POSTFX_TUNING } from "./render/postfx";
import {  loadSavedAvatar, randomAvatarTraits } from "./player/avatar";
import {   loadSavedBoard, randomBoardConfig,  setLocalBoardConfig } from "./vehicles/board";
import {
  loadSavedCar,
  randomCarConfig,
  setLocalCarConfig
} from "./vehicles/car";
import { loadSavedScooter, randomScooterConfig,  setLocalScooterConfig } from "./vehicles/scooter";
import {
  loadSavedSurfboard,
  randomSurfboardConfig,
  setLocalSurfboardConfig,
} from "./vehicles/surf";
import {  ModeDiscovery, ALL_MODES } from "./player/discovery";
import { BootScreen } from "./app/bootScreen";
import { startFrameDriver } from "./app/frameDriver";
import { createAdaptiveResolution } from "./render/adaptiveResolution";
import { createBackgroundAdmission } from "./app/compose/backgroundAdmission";
import { resolveInitialArrival } from "./app/compose/initialArrival";
import { WorldArrivalCoordinator } from "./app/worldArrival";
import { bootMap } from "./app/boot/bootMap";
import { TerrainTileStreamer } from "./world/terrainTiles";
import { createTerrainScanParticles } from "./world/terrainScanParticles";
import { bootGpu } from "./app/boot/bootGpu";
import { bootTiles } from "./app/boot/bootTiles";
import { bootPhysics } from "./app/boot/bootPhysics";
import type {  } from "./app/systems/pickleball";
import { composeWorldSystemsCore } from "./app/compose/worldSystemsCore";
import { composeWorldSystemsNet } from "./app/compose/worldSystemsNet";
import { composeFrameBody } from "./app/compose/frameBody";
import { installDebugSurfaces } from "./app/compose/debugExposure";
import { installVoidArrival } from "./app/compose/voidArrival";

CameraControls.install({ THREE });

const bootScreen = new BootScreen();
const { app, loading, nameInput, suggestedName } = bootScreen;
const progress = (percent: number, label: string) => bootScreen.progress(percent, label);


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
  // ---------------------------------------------------------- P0 kickoff
  // (docs/VOID_STREAM_REWRITE.md M3.) Every boot-critical stream starts NOW,
  // in parallel: map data, GPU init, the box3d WASM module, and the tiles
  // manifest (already racing via the inline <head> prefetch — see index.html
  // __sfPrefetch). The awaits below only order construction, not downloads.
  const mapPromise = bootMap();
  const gpuPromise = bootGpu(app);
  // The awaits below are sequential, so a GPU failure while the map is still
  // pending would briefly surface as an unhandled rejection. This marker only
  // silences that window — the real `await gpuPromise` still throws into
  // boot()'s catch.
  void gpuPromise.catch(() => {});
  prefetchBox3D();
  // Boot stages are extracted into app/boot/* (docs/MAIN_DECOMPOSITION.md step
  // 5). Each bootMark stays here, in the same name/order, right after its stage.
  const { map } = await mapPromise;
  bootMark("map");

  progress(18, "waking the gpu");
  const { renderer, scene, camera } = await gpuPromise;
  bootMark("gpu");

  const farOcclusion = new FarOcclusionField(map);
  const sky = new Sky(scene, farOcclusion);
  // Void realm couples sky/fog/water uniforms to the shared materialize front
  // (docs/VOID_STREAM_REWRITE.md M2/M3). Water itself is a P3 construction —
  // the realm late-binds it via attachWater and drives the sky alone until then.
  const voidRealm = new VoidRealm(sky);
  // The authored high-resolution break is activity code, not a boot fundamental.
  // Its analytic CPU heightfield stays available through oceanBeachWaves.ts, but
  // the heavy visual mesh/HUD chunk is requested only when surfing starts.
  let oceanBeachWaves: import("./gameplay/surfing/waves").OceanBeachWaves | null = null;

  progress(40, "streaming the city");
  const { tiles, authoredRegions } = await bootTiles({ scene, camera, renderer, map, sky });
  bootMark("tiles");

  // M14 terrain-data streaming: real 800 m height/surface/groundtop tiles
  // overwrite the boot overview lattice concentrically behind the front.
  // Anchored below at spawn resolution (primeInitialVisualAt) and re-anchored
  // on far-teleport cuts; driven per frame from the ringUpdate wrapper. Null
  // on the `?fullmap=1` legacy path (everything is real from boot).
  const terrainTiles = map.terrainStreaming && tiles.terrainClipmap
    ? new TerrainTileStreamer({
      map,
      clipmap: tiles.terrainClipmap,
      renderer,
      onAnchorInstalled: () => bootMark("spawnTile")
    })
    : null;

  // Resolve the real initial destination and start its fixed-quality local tile
  // prime while Box3D instantiates. These streams are independent: visual fetch,
  // worker spawn validation, and WASM setup should overlap rather than forming a
  // serial loading waterfall before the first covered frame can be prepared.
  let initialVisualState: "pending" | "ready" | "fallback" = "pending";
  let initialVisualDeadlineAt = performance.now() + 15_000;
  let initialVisualEpoch = 0;
  const initialVisualFocus = { x: Number.NaN, z: Number.NaN };
  const primeInitialVisualAt = (x: number, z: number) => {
    // M14: the destination's REAL terrain tile (+ 3×3 ring) takes absolute
    // fetch priority — physics groundReady now requires it at the anchor.
    terrainTiles?.setAnchor(x, z);
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
  // never block boot; their fetches now kick off in P3 so nothing optional
  // races the void essentials. auxPending only feeds boot log lines today.
  let auxPending = 0;
  let roadMarkings: THREE.Group | null = null;

  // Physics comes online in parallel with initial-arrival resolution and chains
  // the far-occlusion field onto its tile-collider callbacks (extracted to
  // app/boot/bootPhysics.ts — docs/MAIN_DECOMPOSITION.md step 5).
  const { physics, initialArrival } = await bootPhysics({
    map, tiles, farOcclusion, initialArrivalPromise
  });
  const {
    autoStartHiroTour,
    invite,
    devReload,
    resumed,
    spawnPoint,
    spawn,
    fullTileRadius
  } = initialArrival;
  bootMark("physics");

  // ------------------------------------------------------ P1 void essentials
  // (docs/VOID_STREAM_REWRITE.md M3.) Only what the first live void frame
  // needs is constructed before the provisional loop starts: input, the
  // player (all embodiments + the 4-slot LightPool — the light set never
  // changes size after this), the chase camera, the render pipeline and the
  // materialize/void-realm coupling. Everything else builds in P3 as
  // frame-budget-sliced construction UNDER the live void render.
  progress(58, "entering the void");
  const input = new Input(renderer.domElement);
  const modeDiscovery = new ModeDiscovery();
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
  const player = new Player(physics, map, scene, spawn, avatarTraits, boardConfig, scooterConfig, surfboardConfig, carConfig);
  player.holdForWorldArrival("boot-arrival");
  let initialCollisionEpoch = physics.prepareCollisionArrival(player.position);
  physics.activateCollisionArrival(initialCollisionEpoch);
  let initialArrivalReleased = false;
  let initialCollisionRetryCycles = 0;
  let initialCollisionFailureReported = false;
  let initialVisualFailureReported = false;
  const chase = new ChaseCamera(camera, map, physics);
  chase.yaw = spawn.heading; // behind the player, looking the way they face (spawn.heading is raw facing)
  // Seed above the local ground — hilltop spawns sit well over y=30.
  camera.position.set(spawn.x + 20, map.effectiveGround(spawn.x, spawn.z) + 30, spawn.z + 20);

  // Frame-budget scheduler: ALL deferrable bursty work (streamed physics bodies,
  // citygen assembly, material warmups) queues here and drains under a per-frame
  // ms budget in the tick — see core/frameBudget.ts for the contract.
  const scheduler = createFrameScheduler();

  // post-processing: scene pass AA + optional stylized screen effects
  const pipeline = createRenderPipeline(renderer, scene, camera, sky.sun);
  // M10: while an exclusive compile window holds presented frames, the tile
  // streamer pauses its live attach drain (see tiles.isRenderHeld doc).
  tiles.isRenderHeld = () => pipeline.compileHeld;

  // Void-safe aliases: renderFrame reads these from the first void frame,
  // long before P3 constructs the systems behind them.
  let foliageOn = Boolean(FOLIAGE_TUNING.values.visible);
  let siteFoliage: SiteFoliageStreamer | null = null;
  let beachPianist: BeachPianist | null = null;
  let pianoGodRaysActive = false;
  let bootHud: HUD | null = null; // set once the HUD constructs in P3
  const releasePianoGodRays = () => {
    if (!pianoGodRaysActive) return;
    pianoGodRaysActive = false;
    pipeline.setPianoGodRaysArea(false);
  };
  const renderFrame = () => {
    // God rays are intentionally hard-scoped to the piano grove. Mission
    // Dolores and every other region stay on the base post-processing graph.
    const wantsPianoGodRays =
      Boolean(POSTFX_TUNING.values.pianistRays) &&
      foliageOn &&
      siteFoliage?.isReady("beach-pianist-grove") === true &&
      beachPianist?.isPlayerInGodRayArea(player.position, pianoGodRaysActive) === true;
    if (wantsPianoGodRays !== pianoGodRaysActive) {
      pianoGodRaysActive = wantsPianoGodRays;
      pipeline.setPianoGodRaysArea(wantsPianoGodRays, beachPianist?.group.position);
    }
    pipeline.render();
  };

  let prepareDestinationEssentials: (
    destination: Readonly<{ x: number; z: number }>,
    signal: AbortSignal
  ) => void | Promise<void> = () => {};
  // M7 far-arrival hooks: late-bound like prepareDestinationEssentials — the
  // ring coordinator constructs in P5, after this coordinator. Until then
  // every arrival is "near" (boot cannot arrive before P5 anyway).
  let classifyFarArrival: (x: number, z: number) => boolean = () => false;
  let onFarArrivalCut: (x: number, z: number) => void = () => {};
  const worldArrival = new WorldArrivalCoordinator({
    input,
    player,
    chase,
    tiles,
    physics,
    prepareRequiredDestinationVisuals: (destination, signal) =>
      authoredRegions.prepareAt(destination, signal),
    prepareDestinationVisuals: (destination, signal) =>
      prepareDestinationEssentials(destination, signal),
    classifyFarArrival: (x, z) => classifyFarArrival(x, z),
    onFarArrivalCut: (x, z) => onFarArrivalCut(x, z),
    // M9: far arrivals onto an authored groundTop-overlay floor (Sutro Baths
    // deck, Fort Mason bandstand…) keep the cover for that region's prime so
    // the overlay install can never pop the player up post-reveal.
    destinationRequiresAuthoredFloor: (x, z) => authoredRegions.requiresFloorHandoffAt(x, z)
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

  // Session resume / invite placement commits the FINAL player position now,
  // during the void phase, so the void prime, the collision bubble and the
  // first multiplayer Y are exact from the first frame. Surf restoration needs
  // the surf runtime (a P3 concern) — those sessions restore on foot here and
  // upgrade to the wave in P3.
  if (resumed) {
    const resumedInitialMode = resumed.mode === "surf" ? "walk" : resumed.mode;
    player.restoreState({ ...resumed, mode: resumedInitialMode });
    modeDiscovery.discover(resumedInitialMode);
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
    const inviteMode = invite.animal ? "drive" : invite.mode === "surf" ? "walk" : invite.mode;
    // land to the sharer's right so nobody spawns inside anybody — wider for
    // the big embodiments (a boat is 9 m long, planes bank wide)
    const side = inviteMode === "boat" || inviteMode === "plane" ? 7 : inviteMode === "drive" ? 4 : 2.5;
    const jx = invite.x + Math.cos(invite.facing) * side;
    const jz = invite.z - Math.sin(invite.facing) * side;
    player.teleportTo({ x: jx, y: invite.y, z: jz, facing: invite.facing, mode: inviteMode });
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
    initialCollisionRetryCycles = 0;
    initialCollisionFailureReported = false;
    initialVisualFailureReported = false;
  }

  input.setMode(player.mode);
  const startMode = invite || resumed ? "walk" : (spawnPoint?.mode ?? START.mode);
  // Surf needs its runtime/camera chunks (deferred to P3); every other
  // embodiment already exists on the Player and can start immediately.
  if (startMode !== "walk" && startMode !== "surf" && ALL_MODES.includes(startMode)) {
    player.trySwitch(startMode);
  }

  // Collapse the materialize state at the arrival: the world boots as pure
  // black void (terrain hidden until the dawn ramp; sky darkened + water
  // hidden via VoidRealm) with only the terrain-scan particle field lighting
  // the ground as the wave ripples out.
  materializeField.holo(player.position.x, player.position.z);
  voidRealm.update();

  // M18: the scan particle field. Created BEFORE the boot warmup so its
  // sprite pipelines compile in the covered near-empty scene (C2) — it is the
  // very first thing the player sees. Reads the shared materialize uniforms;
  // its scales collapse to zero wherever the wave hasn't passed, so adding it
  // eagerly costs nothing outside the void phases.
  const scanParticles = tiles.terrainClipmap
    ? createTerrainScanParticles(tiles.terrainClipmap)
    : null;
  if (scanParticles) scene.add(scanParticles.group);

  const timer = new THREE.Timer();
  let accumulator = 0;
  let elapsed = 0;
  const aim = new THREE.Vector3();
  const rayOrigin = new THREE.Vector3(); // aimOrigin returns a shared tmp — keep our own copy

  // Warm only the render path the first frame actually uses (a near-empty holo
  // scene: terrain clipmap + sky + avatar). Optional modes, debug overlays,
  // tools, particles, underwater rendering, and audio remain behind their
  // first-use gates instead of taxing every new visitor.
  bootMark("world");
  progress(88, "warming the first view");
  sky.update(0, camera.position, player.renderPosition);
  syncBallGlowNight(sky.sunElevation);
  player.warmup();
  // M17: frames PRESENTED to the canvas that carry the collapsed void front.
  // renderFrame can be gate-held by an exclusive compile window
  // (pipeline.compileHeld), in which case the canvas keeps whatever frame it
  // last presented. The reveal gate below requires at least one presented
  // void-front frame before the cover may fade, or an all-held boot presents
  // a stale frame that then "glitches back" when presents resume. Counted
  // from THIS warm frame onward: holo() above already collapsed the front, so
  // every frame from here on renders the correct tiny-pool look.
  let voidFramesPresented = 0;
  // Initialize render-target contents and the contact-shadow pass once before
  // warmup temporarily freezes render-scoped updates. Without this covered
  // frame, a production WebGPU build can retain an uninitialized (black)
  // contact/output target even though subsequent scene submissions succeed.
  renderFrame();
  if (!pipeline.compileHeld) voidFramesPresented++;
  await pipeline.warmup("boot");
  bootMark("warmup");
  // One frame flushes the covered compile submission without an arbitrary wait.
  await new Promise<void>((r) => requestAnimationFrame(() => r()));

  // ---------------------------------------------------------- P2 void live
  // Reveal now means "the void is ready": ground carpet under the player, a
  // rendered void frame and the boot warmup done — NOT the old full local
  // visual+collision settle. The provisional void loop below renders and
  // accepts input while P3 constructs the rest of the app in ~5 ms slices.
  let modulesReady = true;
  let revealed = false;
  let resolveRevealed!: () => void;
  const revealedPromise = new Promise<void>((r) => {
    resolveRevealed = r;
  });
  let constructionDoneFlag = false;
  let resolveConstructionDone!: () => void;
  const constructionDone = new Promise<void>((r) => {
    resolveConstructionDone = r;
  });
  // Post-reveal deferred region builds must ALSO wait for sliced construction:
  // reveal fires seconds before their dependencies exist now.
  const worldReady = Promise.all([revealedPromise, constructionDone]).then(() => {});
  const pendingStartActions: Array<() => void> = [];
  const runAfterConstruction = (action: () => void) => {
    if (constructionDoneFlag) action();
    else pendingStartActions.push(action);
  };
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
  // Explicit headless verification, demos and perf runs skip the identity hold.
  const skipGate = ["demo", "skipsettle"].some((key) => bootQuery.has(key));
  // Local HMR reloads that were already in-game resume without the identity gate.
  // Production always waits for Start / Enter — returning players keep their saved
  // name prefilled in the form. Deployed tests still opt in via `?autostart` etc.
  // (handled by `autoEnter` above).
  const autoStartSaved =
    !beganAsReadingVisit &&
    !bootQuery.has("startscreen") &&
    Boolean(devReload?.started);
  const settleStart = performance.now();
  console.info(`[boot] void core up in ${((settleStart - bootT0) / 1000).toFixed(1)}s — going live`);
  const revealWorld = (reason = "void-ready") => {
    if (revealed) return;
    revealed = true;
    backgroundAdmission.deferAtLeast(1200);
    resolveRevealed(); // release any region-deferred park builds (gated on constructionDone too)
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

  // Name gate: the immediate half must work from the void (before P3 builds
  // net/hud/audio); everything touching those systems queues until P4.
  bootScreen.setStartHandler((typedName, opts) => {
    nameInput.blur(); // hand the keyboard back to the game
    document.body.classList.add("started"); // reveals the HUD (hidden behind the gate)
    loading.classList.add("done");
    // the submit click/Enter is the gesture pointer lock needs. A deep-link start
    // has no gesture (and opens a modal that frees the cursor anyway), so skip it.
    if (opts?.lock !== false) input.requestLock();
    runAfterConstruction(() => {
      netW.net.setName(typedName);
      netW.avatar.get()?.setName(netW.net.name); // keep the netW.avatar-panel field in step with the gate (no-op until opened)
      window.setTimeout(() => core.audioControls.showMicNudge(), 650);
      core.hud.message(
        invite?.from
          ? `Welcome, ${netW.net.name} — you dropped in on ${invite.from}`
          : `Welcome to San Francisco, ${netW.net.name}`,
        3.2
      );
    });
  });

  // Boot-arrival progression, shared by the void loop and the real loop's
  // postSchedule hook. Control releases the moment the CPU ground carpet is
  // ready under the arrival (the void has no building visuals to fall
  // through); the full collision arrival keeps converging in the background
  // and completes exactly as before.
  let bootHoldReleased = false;
  let bootArrivalX = player.position.x;
  let bootArrivalZ = player.position.z;
  let lastBootReanchorAt = 0;
  const bootArrivalTick = () => {
    if (initialArrivalReleased) return;
    const status = physics.collisionArrivalStatus(initialCollisionEpoch);
    if (!bootHoldReleased && status.groundReady) {
      bootHoldReleased = true;
      player.releaseWorldArrivalHold("boot-arrival");
      bootMark("control");
    }
    if (initialVisualState === "pending" && performance.now() >= initialVisualDeadlineAt) {
      initialVisualState = "fallback";
    }
    if (initialVisualState === "fallback" && !initialVisualFailureReported) {
      initialVisualFailureReported = true;
      console.warn("[boot] local building visuals unavailable; continuing with the terrain fallback");
      bootHud?.message("Some neighborhood detail could not load — the map can take you somewhere else", 8);
    }
    if (status.failedColliderTiles > 0 && initialCollisionRetryCycles < 1) {
      const restarted = physics.retryCollisionArrival(initialCollisionEpoch);
      if (restarted > 0) {
        initialCollisionRetryCycles++;
        console.warn(`[boot] retrying ${restarted} failed local collision tile${restarted === 1 ? "" : "s"}`);
      }
    } else if (
      status.failedColliderTiles > 0 &&
      initialCollisionRetryCycles >= 1 &&
      !initialCollisionFailureReported
    ) {
      initialCollisionFailureReported = true;
      console.warn("[boot] local collision remains unavailable");
      bootHud?.message("This spot could not settle safely — open the map and choose another place", 8);
    }
    // Early control means the player can wander before the pinned arrival
    // completes. Re-anchor the safety bubble under them (the same generic
    // prepare/activate path runtime relocations use) so completion cannot
    // strand on a spawn the carpet has left behind.
    if (bootHoldReleased && !status.ready) {
      const dx = player.position.x - bootArrivalX;
      const dz = player.position.z - bootArrivalZ;
      if (dx * dx + dz * dz > 60 * 60 && performance.now() - lastBootReanchorAt > 2000) {
        lastBootReanchorAt = performance.now();
        bootArrivalX = player.position.x;
        bootArrivalZ = player.position.z;
        initialCollisionEpoch = physics.prepareCollisionArrival(player.position);
        physics.activateCollisionArrival(initialCollisionEpoch);
        initialCollisionRetryCycles = 0;
        return;
      }
    }
    if (initialVisualState !== "pending" && status.ready) {
      if (physics.completeCollisionArrival(initialCollisionEpoch)) {
        initialArrivalReleased = true;
        tiles.resumeBackgroundStreaming();
      }
    }
  };

  // Single call-site helper for the ring coordinator's per-frame update: BOTH
  // the provisional voidTick and the real loop's updateWorld call this right
  // before materializeField.update. Bound when the coordinator is created in
  // P5 below (same synchronous block — no tick can run before then).
  let ringUpdate: (dt: number) => void = () => {};

  // M5: Bay Lights / Golden Gate lights ramp up as the materialize front
  // crosses their world region — a CPU-side scale on the intensity uniforms
  // Sky#applySun rewrites every sky.update, so this multiply must run
  // immediately after EVERY sky.update that precedes a render. Anchor = the
  // bridge midpoint (the front band sweeps it in ~1 s). No shader work.
  const bridgeAnchor = (name: string): { x: number; z: number } | null => {
    const bridge = map.meta.bridges.find((b) => b.name === name);
    if (!bridge || bridge.line.length === 0) return null;
    const mid = bridge.line[Math.floor(bridge.line.length / 2)];
    return { x: mid[0], z: mid[1] };
  };
  const bayLightsAnchor = bridgeAnchor("Bay Bridge");
  const goldenGateAnchor = bridgeAnchor("Golden Gate Bridge");
  const applyLightFrontRamps = () => {
    if (bayLightsAnchor) {
      BAY_LIGHTS_INTENSITY.value *= materializeField.amountAt(bayLightsAnchor.x, bayLightsAnchor.z);
    }
    if (goldenGateAnchor) {
      GOLDEN_GATE_LIGHTS_INTENSITY.value *=
        materializeField.amountAt(goldenGateAnchor.x, goldenGateAnchor.z);
    }
    // M15: Sutro's FAA beacons are visible city-wide by design — during a
    // sweep they must stay dark until the front crosses the tower (the same
    // CPU ramp as the bridges; Sky#applySun rewrites the intensity each frame).
    SUTRO_LIGHTS_INTENSITY.value =
      (SUTRO_LIGHTS_INTENSITY.value as number) *
      materializeField.amountAt(SUTRO_TOWER_ANCHOR.x, SUTRO_TOWER_ANCHOR.z);
  };

  // M5: citygen chunk-publication radius folded into the residency the front
  // chases. The ring is a post-reveal dynamic import — until it exists nothing
  // constrains (Infinity); rebound right after the ring holder is declared.
  let citygenResidencyRadius: (x: number, z: number) => number = () => Infinity;
  // M12: far-teleport re-gate for published citygen cells (rebound with the
  // residency query once the ring's dynamic import lands; no-op before then).
  let citygenApplyFrontGate: () => void = () => {};

  // Provisional void loop: the minimal per-frame set — input → fixed-step
  // physics → player/camera → sky/materialize → streaming drains → render.
  // The real loop (P4) swaps in atomically by replacing `activeTick` between
  // frames: same timer/accumulator/player instances, no double-ticked frame.
  let voidFrames = 0;
  // Shared by voidTick AND the real loop's afterRender: a long boot compile
  // chain can hold every void-phase frame, pushing the first presented frame
  // past the P4 handoff — the reveal decision must keep running there or an
  // all-held void phase (with voidFramesPresented still 0) would never reveal.
  const voidRevealCheck = () => {
    if (revealed) return;
    // compileHeld is synchronous state: reading it right after renderFrame
    // tells whether THIS frame presented or was held by a compile window.
    if (!pipeline.compileHeld) voidFramesPresented++;
    // Either release path may fire first: bootArrivalTick sets
    // bootHoldReleased when the ground carpet is ready, but a runtime
    // relocation (worldArrival.onStateChange) can release the boot hold via
    // initialArrivalReleased alone — after which bootArrivalTick
    // early-returns forever and only the 15 s cap would reveal.
    if (
      voidFrames >= 2 &&
      voidFramesPresented >= 1 &&
      (bootHoldReleased || initialArrivalReleased)
    ) {
      revealWorld("void-ready");
    } else if (performance.now() - settleStart > 15000) revealWorld("reveal-forced (15s cap)");
  };
  const voidTick = (forcedDt?: number) => {
    timer.update();
    const frameDt = forcedDt ?? Math.min(timer.getDelta(), 0.09);
    input.pollPad(frameDt);
    input.pollDriver(frameDt);
    elapsed += frameDt;
    accumulator += frameDt;
    if (!input.suspended && player.mode === "walk" && input.pressed("Space")) player.requestWalkJump();
    if (!input.suspended && player.mode === "board" && input.pressed("Space")) player.requestBoardJump();
    if (player.mode === "plane") player.steerFly(input, frameDt);
    chase.lookDir(aim);
    tracer.begin("physics");
    physics.maintainStreaming(player.position);
    let steps = 0;
    while (accumulator >= physics.world.fixedTimeStep && steps < 3) {
      player.update(physics.world.fixedTimeStep, input, chase.yaw, aim);
      physics.step(physics.world.fixedTimeStep);
      accumulator -= physics.world.fixedTimeStep;
      steps++;
    }
    if (steps === 3) accumulator = 0;
    tracer.end("physics");
    tracer.begin("world");
    player.afterSteps(steps, accumulator / physics.world.fixedTimeStep);
    player.syncMesh(frameDt);
    tiles.update(player.position.x, player.position.z, false, !revealed);
    authoredRegions.update(player.position.x, player.position.z);
    chase.update(frameDt, player, input);
    ringUpdate(frameDt);
    materializeField.update(frameDt);
    voidRealm.update();
    sky.update(elapsed, camera.position, player.renderPosition);
    applyLightFrontRamps();
    tracer.end("world");
    tracer.begin("sched");
    scheduler.run(revealed ? (frameDt < 1 / 55 ? 3 : frameDt < 1 / 35 ? 1.5 : 0.8) : 24);
    bootArrivalTick();
    tracer.end("sched");
    input.endFrame();
    tracer.begin("render");
    renderFrame();
    tracer.end("render");
    if (voidFrames === 0) bootMark("voidFrame");
    voidFrames++;
    voidRevealCheck();
  };
  let activeTick: (forcedDt?: number) => void = voidTick;
  const adaptiveRes = createAdaptiveResolution(renderer);
  const frameDriver = startFrameDriver({
    renderer,
    camera,
    app,
    tick: (forcedDt?: number) => activeTick(forcedDt),
    tracer,
    isRevealed: () => revealed,
    // P3 construction slices legitimately produce long frames after reveal;
    // hold the governor until the P4 handoff so they can never trigger a
    // spurious downscale of the freshly revealed world.
    adaptiveRes: {
      update: (emaMs: number) => {
        if (constructionDoneFlag) adaptiveRes.update(emaMs);
      }
    }
  });
  // Deterministic capture stops the wall-clock loop so tools can drive tick(dt).
  // Discard any fractional wall-clock remainder on entry; otherwise identical
  // fixed-step reels can interpolate from a different boot-time accumulator.
  (window as never as { __sfManual: (on: boolean) => void }).__sfManual = (on) => {
    if (on) accumulator = 0;
    frameDriver.setManual(on);
  };
  // Void-phase probe surface: the full `__sf` registry only exists at the END
  // of boot, but M3 QA needs marks/position/front visibility DURING P2/P3.
  if (import.meta.env.DEV || bootQuery.has("profile")) {
    (window as never as { __sfVoid: unknown }).__sfVoid = {
      marks: () => bootMarkList().map((m) => ({ label: m.label, t: Math.round(m.t) })),
      playerPos: () => [player.position.x, player.position.y, player.position.z],
      revealed: () => revealed,
      constructionDone: () => constructionDoneFlag,
      frontRadius: () => materializeField.frontRadius.value as number,
      frameDriver,
      audioEngine,
      // M15 leak QA: scene + sky handles for void-phase visibility censuses
      // (probes walk the scene to find content rendering beyond the front, and
      // force a time of day BEFORE the void moment — `__sf` only exists at the
      // end of boot).
      scene,
      sky
    };
  }
  if (skipGate) loading.classList.add("done");

  // ---------------------------------------------- P5 void arrival (M18)
  // Ring coordinator + fabric gate + far-arrival hooks + ringUpdate driver —
  // extracted to app/compose/voidArrival.ts.
  const arrival = installVoidArrival({
    ctx: { player, tiles, authoredRegions, sky, map, fullTileRadius },
    bootQuery,
    terrainTiles,
    scanParticles,
    primeInitialVisualAt,
    citygenResidencyRadius: (x, z) => citygenResidencyRadius(x, z),
    citygenApplyFrontGate: () => citygenApplyFrontGate()
  });
  const ringCoordinator = arrival.ringCoordinator;
  classifyFarArrival = arrival.classifyFarArrival;
  onFarArrivalCut = arrival.onFarArrivalCut;
  ringUpdate = arrival.ringUpdate;

  // ------------------------------------------------ P3 sliced construction
  // The former synchronous boot stretch, in its ORIGINAL ORDER, chopped by a
  // ~5 ms frame-budget checkpoint between constructor groups so live void
  // frames never hitch on construction. Systems are constructed but NOT
  // ticked — nothing below runs per-frame until the real loop lands at P4.
  const constructionSlice = createFrameBudgetCheckpoint(5);
  await constructionSlice();

  // ---- P3 construction, decomposed (docs/MAIN_DECOMPOSITION.md) ------------
  // The former inline world-systems block lives in src/app/compose/*: consts
  // come back on typed records; shared mutable state lives on each module's
  // `state` record; main's own mutable boot lets are exposed to the modules
  // through the live ctx.state facade below.
  const ctx = {
    suggestedName,
    late: { teaGarden: null, net: null, debugPanel: null },
    player,
    input,
    camera,
    scene,
    worldArrival,
    chase,
    map,
    physics,
    renderer,
    sky,
    waitForWorldBackgroundWindow,
    aim,
    tiles,
    rayOrigin,
    worldReady,
    scheduler,
    pipeline,
    authoredRegions,
    applyLightFrontRamps,
    waitForCityGenRenderWindow,
    spawn,
    app,
    voidRealm,
    audioEngine,
    renderFrame,
    fullTileRadius,
    modeDiscovery,
    invite,
    timer,
    startMode,
    savedSurfboard,
    savedScooter,
    savedCar,
    savedBoard,
    savedAvatar,
    resumed,
    revealedPromise,
    nextPresentationFrame,
    bootArrivalTick,
    backgroundAdmission,
    autoStartHiroTour,
    releasePianoGodRays,
    voidRevealCheck,
    constructionSlice,
    progress,
    state: {
      get oceanBeachWaves() { return oceanBeachWaves; },
      set oceanBeachWaves(v) { oceanBeachWaves = v as never; },
      get auxPending() { return auxPending; },
      set auxPending(v) { auxPending = v as never; },
      get roadMarkings() { return roadMarkings; },
      set roadMarkings(v) { roadMarkings = v as never; },
      get customized() { return customized; },
      set customized(v) { customized = v as never; },
      get carCustomized() { return carCustomized; },
      set carCustomized(v) { carCustomized = v as never; },
      get boardCustomized() { return boardCustomized; },
      set boardCustomized(v) { boardCustomized = v as never; },
      get scooterCustomized() { return scooterCustomized; },
      set scooterCustomized(v) { scooterCustomized = v as never; },
      get surfboardCustomized() { return surfboardCustomized; },
      set surfboardCustomized(v) { surfboardCustomized = v as never; },
      get foliageOn() { return foliageOn; },
      set foliageOn(v) { foliageOn = v as never; },
      get beachPianist() { return beachPianist; },
      set beachPianist(v) { beachPianist = v as never; },
      get bootHud() { return bootHud; },
      set bootHud(v) { bootHud = v as never; },
      get accumulator() { return accumulator; },
      set accumulator(v) { accumulator = v as never; },
      get elapsed() { return elapsed; },
      set elapsed(v) { elapsed = v as never; },
      get revealed() { return revealed; },
      set revealed(v) { revealed = v as never; },
      get ringUpdate() { return ringUpdate; },
      set ringUpdate(v) { ringUpdate = v as never; },
      get classifyFarArrival() { return classifyFarArrival; },
      set classifyFarArrival(v) { classifyFarArrival = v as never; },
      get onFarArrivalCut() { return onFarArrivalCut; },
      set onFarArrivalCut(v) { onFarArrivalCut = v as never; },
      get citygenResidencyRadius() { return citygenResidencyRadius; },
      set citygenResidencyRadius(v) { citygenResidencyRadius = v as never; },
      get citygenApplyFrontGate() { return citygenApplyFrontGate; },
      set citygenApplyFrontGate(v) { citygenApplyFrontGate = v as never; },
      get avatarTraits() { return avatarTraits; },
      set avatarTraits(v) { avatarTraits = v as never; },
      get carConfig() { return carConfig; },
      set carConfig(v) { carConfig = v as never; },
      get boardConfig() { return boardConfig; },
      set boardConfig(v) { boardConfig = v as never; },
      get scooterConfig() { return scooterConfig; },
      set scooterConfig(v) { scooterConfig = v as never; },
      get surfboardConfig() { return surfboardConfig; },
      set surfboardConfig(v) { surfboardConfig = v as never; },
      get siteFoliage() { return siteFoliage; },
      set siteFoliage(v) { siteFoliage = v as never; },
      get prepareDestinationEssentials() { return prepareDestinationEssentials; },
      set prepareDestinationEssentials(v) { prepareDestinationEssentials = v as never; },
    }
  };
  const core = await composeWorldSystemsCore(ctx);
  const netW = await composeWorldSystemsNet(ctx, core);
  const frameB = await composeFrameBody(ctx, core, netW);
  const { tick } = frameB;

  // ------------------------------------------------------------- P4 handoff
  // The real loop replaces the provisional void tick between frames: same
  // timer/accumulator/player/camera instances (the frame driver from P2 keeps
  // running; only `activeTick` swaps), so no state snaps and no double-ticked
  // frame. The driver + __sfManual were installed in P2.
  bootMark("constructionDone");
  activeTick = tick;
  bootMark("handoff");
  constructionDoneFlag = true;
  resolveConstructionDone();
  for (const action of pendingStartActions.splice(0)) action();
  persistBootHistory();
  console.info(`[boot] construction done — ${bootMarkSummary()}`);
  // P3 built material-heavy systems the P1 boot warmup never saw. Re-run the
  // (re-invokable) pipeline warmup off the critical path so their pipelines
  // compile before their content shows (contract C2).
  void (async () => {
    // M10: the materialize sweep is the visually critical stretch, and even
    // small paced compile chunks stack onto streaming frames as a 20-30 ms
    // carpet for its whole duration. This re-run is a SAFETY sweep (content
    // that streams during the sweep warms through its own gated hooks — C2 is
    // owned by the front never crossing unwarmed ground), so hold it until the
    // front has settled (bounded so a never-settling session still warms),
    // give the settle moment itself a cushion (the held shadow redraws and
    // core.state.citygen settle swaps land there), then trickle behind quiet windows.
    const warmupHoldStart = performance.now();
    while (
      ringCoordinator.fabricHeld &&
      performance.now() - warmupHoldStart < 120_000
    ) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    await waitForWorldBackgroundWindow(1500);
    try {
      // M6: this re-run happens LIVE (post-reveal) — pace it so no single
      // exclusive-compile window freezes rendering for more than a chunk
      // budget. Each pace yields a real presentation frame, then waits for
      // background quiet — with a REAL deadline (M9): the first argument is
      // extra-quiet-ms, not a cap, so a continuously moving player would
      // otherwise defer the paced warmup forever and pin warmupInFlight for
      // the whole session. ~3 s per chunk keeps warmup polite but guarantees
      // progress.
      await pipeline.warmup("boot", async () => {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
        await waitForWorldBackgroundWindow(600, performance.now() + 3000);
      });
    } catch (error) {
      console.warn("[boot] post-construction pipeline warmup failed", error);
    }
  })();

  // __sf debug surface + dev demo harness (app/compose/debugExposure.ts).
  await installDebugSurfaces(ctx, core, netW, frameB, {
    dynRes: adaptiveRes,
    frameDriver,
    farOcclusion,
    ringCoordinator,
    terrainTiles,
    modulesReady: () => modulesReady
  });
}

boot().catch((err) => {
  console.error("[boot] fatal:", err);
  bootScreen.fail(err);
});
