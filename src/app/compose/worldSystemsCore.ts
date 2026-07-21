// AUTO-EXTRACTED from src/main.ts (P3 CORE block, lines 1101-1927) — see
// docs/MAIN_DECOMPOSITION.md. Behavior-identical move: crossing consts are
// returned on the record; crossing lets live on `state`.
// Soft-HMR guard must register before any other import.meta.hot listeners.
import * as THREE from "three/webgpu";
import CameraControls from "camera-controls";
import {  CITYGEN_TUNING, CONFIG } from "../../config";
import { createSurfShack, type SurfShack } from "../../gameplay/surfing/shack";
import {
  GHOST_SHIP_RIDE_ID
} from "../../world/ghostShip/route";
import type {  } from "../../world/ghostShip";
import { Water } from "../../world/water";
import { frontGate } from "../../render/frontGate";
import { UnderwaterOverlay } from "../../fx/underwater";
import { createRoadMarkings } from "../../world/roadMarkings";
import { RoadGraph } from "../../world/traffic/roadGraph";
import { TrafficLightView } from "../../world/traffic/trafficLights";
import { createBayLights } from "../../world/bayLights";
import { createGoldenGateLights } from "../../world/goldenGateLights";
import { createSutroBeacons } from "../../world/sutroTower";
import type { GoldenGateTennisSite } from "../../world/goldenGateTennis";
import { warmHiddenRoot } from "../../render/warmHiddenRoot";
import type { CoronaHeightsPark } from "../../world/coronaHeights";
import type { MissionDoloresMuseum } from "../../world/missionDolores";
import { MD_CENTER as MISSION_DOLORES_CENTER } from "../../world/missionDolores/layout";
import type { PlayerMode } from "../../player/types";
import { FX } from "../../fx/fx";
import { BoardWake, WakeRipples } from "../../fx/wake";
import { SkidMarks } from "../../fx/skidMarks";
import { BirdTrails } from "../../fx/birdTrail";
import { WaterSplashes } from "../../fx/splash";
import { Fireworks } from "../../fx/fireworks";
import { Graffiti } from "../../fx/graffiti";
import {
  Paintballs,
  PaintSkins,
} from "../../fx/paintball";
import { Bubbles } from "../../fx/bubbles";
import { WorldCursor } from "../../fx/worldCursor";
import { WorldQueries } from "../../core/worldQueries";
import { BuildingRayRefiner } from "../../core/buildingRayRefine";
import { Toolbar } from "../../ui/toolbar";
import { AudioControls } from "../../ui/audioControls";
import { VehicleAudio } from "../../fx/vehicleAudio";
import { SwimAudio } from "../../fx/swimAudio";
import { GameplaySfxBus } from "../../audio/gameplaySfxBus";
import { PlayerFoleyAudio } from "../../fx/playerFoleyAudio";
import { ModeTransitionAudio } from "../../fx/modeTransitionAudio";
import { JumpLandingAudio } from "../../fx/jumpLandingAudio";
import { DoorAudio } from "../../fx/doorAudio";
import { createNatureSoundscape, DogParkAudio, BallImpactAudio } from "../../audio";
import { WaveAudio } from "../../audio/waveAudio";
import { AbandonedMounts } from "../../gameplay/abandonedMounts";
import { spawnScatterBoats } from "../../gameplay/scatterBoats";
import type { Creatures } from "../../gameplay/creatures";
import type { Forest } from "../../gameplay/forest";
import {
  type GroundDisplacer
} from "../../world/vegetation/runtime";
import type { CityGenRing } from "../../world/citygen";
import { Islands } from "../../gameplay/islands";
import { Hunt } from "../../gameplay/hunt";
import { FetchBall } from "../../gameplay/fetchBall";
import { createSiteGate } from "../../gameplay/siteGate";
import type { ArcheryGame } from "../../gameplay/archery";
import type { PupPen } from "../../gameplay/pup";
import type {  } from "../../gameplay/fortMasonEnsemble";
import type { PalaceReverieGame } from "../../gameplay/palaceReverie";
import type { LandsEndRegion } from "../../world/landsEnd";
import type { WaveOrgan } from "../../world/waveOrgan";
import type {  } from "../../world/beachPianist";
import type { AfterlightExperience } from "../../gameplay/afterlight";
import type { HangGlidingExperience } from "../../gameplay/hangGliding";
import { Satchel } from "../../ui/satchel";
import { HUD } from "../../ui/hud";
// The launcher and reader stay dynamically loaded; a reading entry may create
// the shared reader before this game module begins.
import {  setFlowPostFx } from "../../render/postfx";
import { createBuskersSystem } from "../../app/systems/buskers";
import { createBuskerConversation } from "../../gameplay/buskers/conversation";
import { EmbodimentController } from "../../app/player/embodimentController";
import { createCarLandingFeedback } from "../../app/compose/carLanding";
import { createToolCycle } from "../../app/compose/toolCycle";
import type {  } from "../../app/systems/pickleball";
import type { MainCtx } from "./ctx";


export async function composeWorldSystemsCore(ctx: MainCtx) {
  const { player, input, camera, scene, chase, map, physics, renderer, sky, tiles, app, voidRealm, audioEngine, modeDiscovery, constructionSlice, progress, waitForWorldBackgroundWindow } = ctx;
  const state = {
    garden: null as {
    group: THREE.Group;
    ready: Promise<void>;
    setVisible: (visible: boolean, focus: { x: number; z: number }) => void;
    update: (pos: THREE.Vector3) => void;
  } | null,
    wildlands: null as {
    groups: THREE.Group[];
    ready: Promise<void>;
    flowers: { refresh: () => void };
    grass: { refresh: () => void };
    prepareAt: (
      focus: { x: number; z: number },
      prepare?: (unit: THREE.Object3D) => Promise<void>,
      signal?: AbortSignal
    ) => Promise<void>;
    update: (pos: THREE.Vector3, cam: THREE.Vector3, cullCamera?: THREE.Camera) => void;
  } | null,
    buenaVistaTrees: null as {
    group: THREE.Group;
    ready: Promise<void>;
    update: (focus: { x: number; z: number }) => void;
  } | null,
    orbitFlip: null as {
    t: number;
    duration: number;
    startAz: number;
    delta: number;
    startDist: number;
    endDist: number;
  } | null,
    paintAudio: null as (PaintAudioInstance | null),
    bubbleAudio: null as (BubbleAudioInstance | null),
    fetchBall: null as (FetchBall | null),
    paintColorTouched: false as any,
    paintColorSeeded: false as any,
    switchModeFromToolbar: undefined as undefined | ((mode: PlayerMode) => void),
    surfExperience: null as (import("../../gameplay/surfing/game").SurfExperience | null),
    surfRuntimeLoading: null as (Promise<void> | null),
    surfShack: null as (SurfShack | null),
    surfEntryPreparations: 0 as any,
    surfSplashSerial: 0 as any,
    ensureSurfboardCustomizer: undefined as undefined | ((open?: boolean) => void),
    syncCustomizerForMode: undefined as undefined | ((mode: PlayerMode) => void),
    setRemoteSurfboardAssetsActive: undefined as undefined | ((active: boolean) => void),
    setRemoteScooterAssetsActive: undefined as undefined | ((active: boolean) => void),
    setRemoteCarAssetsActive: undefined as undefined | ((active: boolean) => void),
    setRemoteBirdAssetsActive: undefined as undefined | ((active: boolean) => void),
    surfCullStash: null as ({ load: number; unload: number; detail: number; maxDetail: number } | null),
    trafficLights: null as (TrafficLightView | null),
    roadGraphPromise: null as (Promise<RoadGraph> | null),
    islands: null as (Islands | null),
    hunt: null as (Hunt | null),
    creatures: null as (Creatures | null),
    forest: null as (Forest | null),
    ANIMALS: null as (Record<string, any> | null),
    ghostShipRideZoom: null as (number | null),
    ghostShipRideYaw: null as (number | null),
    switchModeFromExit: undefined as undefined | ((mode: PlayerMode) => void),
    goldenGateTennis: null as (GoldenGateTennisSite | null),
    wakeDeferredGarden: null as ((() => void) | null),
    wakeDeferredBuenaVistaTrees: null as ((() => void) | null),
    wakeDeferredWildlandsGolf: null as ((() => void) | null),
    coronaHeights: null as (CoronaHeightsPark | null),
    missionDolores: null as (MissionDoloresMuseum | null),
    sutroBaths: null as (import("../../world/sutroBaths").SutroBaths | null),
    museumBookOpen: false as any,
    citygen: null as ({ update?: (dt: number) => void; [k: string]: unknown } | null),
    golf: null as (import("../../gameplay/golf").GolfGame | null),
    archery: null as (ArcheryGame | null),
    pup: null as (PupPen | null),
    palaceReverie: null as (PalaceReverieGame | null),
    landsEnd: null as (LandsEndRegion | null),
    waveOrgan: null as (WaveOrgan | null),
    unregisterBeachPianistTuning: null as ((() => void) | null),
    afterlight: null as (AfterlightExperience | null),
    hangGliding: null as (HangGlidingExperience | null),
    goldenGateLights: null as (ReturnType<typeof createGoldenGateLights>),
    ridePromptShown: false as any,
    doorPromptShown: false as any,
    doorScanCountdown: 0 as any,
    doorScanHit: null as (ReturnType<CityGenRing["nearestDoor"]>),
    highUp: false as any,
    uiOpen: true as any,
  };
  const water = new Water(scene, map);
  voidRealm.attachWater(water);
  // Compile the water sheets detached before their first visible frame — the
  // void loop is LIVE now; an uncompiled sheet would stall a whole frame on
  // its pipeline build (contract C2/C3).
  {
    const waterRoots = [water.far, water.near, water.palaceLagoon, water.underside];
    const restore = waterRoots.map((m) => m.visible);
    for (const m of waterRoots) m.visible = false;
    void Promise.all(
      waterRoots.map((m) => warmHiddenRoot(renderer, camera, scene, m).catch(() => {}))
    ).then(() => waterRoots.forEach((m, i) => (m.visible = restore[i])));
  }
  const underwater = new UnderwaterOverlay(app, map);
  // off-boot-path lane markings (attaches whenever the fetch lands)
  ctx.state.auxPending++;
  void createRoadMarkings(scene, map)
    .then((group) => {
      ctx.state.roadMarkings = group;
    })
    .catch((err) => console.warn("[roads] lane markings unavailable", err))
    .finally(() => ctx.state.auxPending--);
  await constructionSlice();

  progress(62, "waking up san francisco");
  const hud = new HUD();
  ctx.state.bootHud = hud;
  const fx = new FX(scene);
  const wake = new WakeRipples(scene);
  const boardWake = new BoardWake(scene, map, wake);
  const skidMarks = new SkidMarks(scene, map);
  const splashes = new WaterSplashes(scene, wake, map);
  const fireworks = new Fireworks(renderer, scene, map);
  // Compile the optional firework renderer under the loading cover. Its audio
  // graph now warms after the first launch, during the rocket's flight time.
  fireworks.prewarm();
  // Fundamental player/interaction foley shares one small procedural graph.
  // Prewarming here avoids synthesizing its noise/room buffers on the first W.
  const gameplaySfxBus = new GameplaySfxBus();
  gameplaySfxBus.prewarm();
  audioEngine.prewarm();
  await constructionSlice();

  // Space / pad-X toys — ↑/↓ pick the toolbar row, ←/→ cycle within it
  const graffiti = new Graffiti(scene);
  const paintballs = new Paintballs(scene);
  const paintSkins = new PaintSkins();
  // Tea Garden owns the pond water response; ctx.late.teaGarden! (created after its region
  // helpers, below) null-checks its own null-until-approached site.
  paintballs.onWaterSegment = (segment) => ctx.late.teaGarden!.paintWaterSegment(segment);
  paintballs.onWater = (impact) => {
    if (ctx.late.teaGarden!.paintWater(impact)) return;
    // The generic plume is designed for bodies and aircraft. Paint gets a much
    // smaller fallback outside the Tea Garden so it cannot freeze into cyan
    // camera-facing islands across the water plane.
    splashes.splash(impact.x, impact.y, impact.z, ctx.state.elapsed, 0.3, 0.3);
  };
  const bubbles = new Bubbles(scene, map, physics);
  const worldCursor = new WorldCursor(scene);
  type PaintAudioInstance = import("../../fx/paintAudio").PaintAudio;
  type BubbleAudioInstance = import("../../fx/bubbleAudio").BubbleAudio;
  // (state.paintAudio hoisted to the module state record)
  let paintAudioLoading: Promise<PaintAudioInstance> | null = null;
  // (state.bubbleAudio hoisted to the module state record)
  let bubbleAudioLoading: Promise<BubbleAudioInstance> | null = null;
  const ensurePaintAudio = () => {
    if (state.paintAudio) return Promise.resolve(state.paintAudio);
    if (paintAudioLoading) return paintAudioLoading;
    paintAudioLoading = import("../../fx/paintAudio")
      .then(({ PaintAudio }) => state.paintAudio ??= new PaintAudio(gameplaySfxBus))
      .finally(() => { paintAudioLoading = null; });
    return paintAudioLoading;
  };
  const ensureBubbleAudio = () => {
    if (state.bubbleAudio) return Promise.resolve(state.bubbleAudio);
    if (bubbleAudioLoading) return bubbleAudioLoading;
    bubbleAudioLoading = import("../../fx/bubbleAudio")
      .then(({ BubbleAudio }) => state.bubbleAudio ??= new BubbleAudio(gameplaySfxBus))
      .finally(() => { bubbleAudioLoading = null; });
    return bubbleAudioLoading;
  };
  // (state.fetchBall hoisted to the module state record)
  // Click-tool selection + Ctrl+digit cycling — extracted per
  // docs/MAIN_DECOMPOSITION.md. Late-bound getters break the Toolbar↔setTool
  // and state.fetchBall-null-until-built cycles.
  const toolCycle = createToolCycle({
    hud,
    getToolbar: () => toolbar,
    getFetchBall: () => state.fetchBall,
    ensurePaintAudio,
    ensureBubbleAudio
  });
  const setTool = toolCycle.setTool;
  // (state.paintColorTouched hoisted to the module state record)
  // (state.paintColorSeeded hoisted to the module state record)
  const setColor = (i: number, userPicked = false) => {
    if (userPicked) state.paintColorTouched = true;
    graffiti.colorIndex = i;
    toolbar.setColor(i);
  };
  state.switchModeFromToolbar = () => {};
  const toolbar = new Toolbar(
    (t) => setTool(t),
    (i) => setColor(i, true),
    (mode) => state.switchModeFromToolbar!(mode)
  );
  setTool("ball");
  setColor(0);
  await constructionSlice();

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
  // Identity configs loaded in P1 (the Player needed them); re-apply the
  // board's audio styling now that the vehicle-audio graph exists.
  vehicleAudio.setBoardStyle(ctx.state.boardConfig);
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
    state.bubbleAudio?.pop({
      radius,
      pan: placement.pan,
      intensity: placement.intensity
    });
  };
  paintballs.onImpact = (event) => {
    const placement = localAudioPlacement(event.x, event.y, event.z, 85);
    if (!placement || !state.paintAudio) return;
    state.paintAudio.impact({
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
  // (state.surfExperience hoisted to the module state record)
  // (state.surfRuntimeLoading hoisted to the module state record)
  // (state.surfShack hoisted to the module state record)
  // (state.surfEntryPreparations hoisted to the module state record)
  const ensureSurfShack = () => {
    if (state.surfShack) return;
    state.surfShack = createSurfShack(map);
    scene.add(state.surfShack.group);
    // M15 void purity: the shack is a boot-resident one-off prop no streamer
    // owns — register it with the shared front gate so it stays hidden beyond
    // the sweeping front (and re-gates on far-arrival refocus via applyStatic).
    {
      const box = new THREE.Box3().setFromObject(state.surfShack.group);
      if (!box.isEmpty()) {
        frontGate.registerStatic(
          state.surfShack.group,
          (box.min.x + box.max.x) / 2,
          (box.min.z + box.max.z) / 2,
          Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) / 2
        );
      }
    }
    refreshSurfDebug();
  };
  const refreshSurfDebug = () => {
    const hooks = (window as unknown as { __sf?: Record<string, unknown> }).__sf;
    if (hooks) Object.assign(hooks, {
      oceanBeachWaves: ctx.state.oceanBeachWaves,
      surfExperience: state.surfExperience,
      surfShack: state.surfShack
    });
  };
  const ensureSurfRuntime = (prepareEntry = false) => {
    const surfing = player.mode === "surf";
    // The activity chunk is a first-use resource: merely visiting Ocean Beach on
    // foot must not fetch or construct any of it. Entry preparation is the one
    // intentional exception because the first visible surf frame needs both the
    // authored break and its HUD ready.
    if (!surfing && !prepareEntry) return Promise.resolve();
    ensureSurfShack();
    if (ctx.state.oceanBeachWaves && state.surfExperience) return Promise.resolve();
    if (state.surfRuntimeLoading) return state.surfRuntimeLoading;
    state.surfRuntimeLoading = import("../../gameplay/surfing")
      .then(async ({ OceanBeachWaves, SurfExperience }) => {
        // A direct transition may have been canceled while the chunk was in
        // flight. Do not resurrect the activity after its owner has left.
        if (!prepareEntry && player.mode !== "surf" && state.surfEntryPreparations === 0) return;
        if (!ctx.state.oceanBeachWaves) {
          // Compile the wave sheet's pipelines while the group is detached —
          // adding it uncompiled froze the first surf second for >1 s.
          const waves = new OceanBeachWaves();
          try {
            await renderer.compileAsync(waves.group, camera, scene);
          } catch (error) {
            console.warn("[surf] wave warmup compile failed", error);
          }
          scene.add(waves.group);
          ctx.state.oceanBeachWaves = waves;
        }
        state.surfExperience ??= new SurfExperience(vehicleAudio);
        refreshSurfDebug();
      })
      .catch((error) => console.warn("[surf] runtime failed to load", error))
      .finally(() => {
        state.surfRuntimeLoading = null;
      });
    return state.surfRuntimeLoading;
  };
  const releaseSurfVisual = () => {
    ctx.state.oceanBeachWaves?.dispose();
    ctx.state.oceanBeachWaves = null;
    refreshSurfDebug();
  };
  // The primed break stays alive while the player remains in the activity's
  // beach neighborhood (live breaking waves from the sand + instant re-entry).
  // Release only once they genuinely leave — a 240 m pad against the 90 m
  // prime radius so exit→walk cannot churn dispose/recompile cycles.
  const surfBreakStillLocal = () => {
    if (player.mode === "surf" || state.surfEntryPreparations > 0) return true;
    if (!state.surfShack) return false;
    const dx = player.position.x - state.surfShack.pose.x;
    const dz = player.position.z - state.surfShack.pose.z;
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
    state.surfEntryPreparations++;
    try {
      await Promise.all([chase.ensureSurfCamera(), ensureSurfRuntime(true), warmSurfEmbodiment()]);
      return ctx.state.oceanBeachWaves !== null && state.surfExperience !== null;
    } catch (error) {
      console.warn("[surf] entry preparation failed", error);
      return false;
    } finally {
      state.surfEntryPreparations--;
    }
  };
  let surfFlowFx = 0;
  let surfFlowPhase = 0;
  let surfFlowSerial = 0;
  // (state.surfSplashSerial hoisted to the module state record)
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
  state.ensureSurfboardCustomizer = () => {};
  // Rebound after the customizer roots exist; onModeChange may fire earlier.
  state.syncCustomizerForMode = () => {};
  state.setRemoteSurfboardAssetsActive = () => {};
  state.setRemoteScooterAssetsActive = () => {};
  state.setRemoteCarAssetsActive = () => {};
  state.setRemoteBirdAssetsActive = () => {};
  let leaveCameraModeForSurf: () => void = () => {};
  const birdTrails = new BirdTrails(scene, player.meshes.bird);
  const droneFireworkMounts = player.meshes.drone.userData.fireworkMounts as THREE.Object3D[] | undefined;
  // startMode was applied in P1; a surf start upgrades below once the surf
  // runtime + debug panel exist (onModeChange references the latter).
  await constructionSlice();
  // Surf-mode far-cull (perf audit's #1 win): a west-facing surfer never sees the
  // city behind them, but streamed tiles + state.citygen chunks are frustumCulled=false
  // — they pay GPU draw cost every frame regardless of view, cleared only by
  // distance-unload. So while surfing we shrink the streamed radius + state.citygen
  // detail and pull the fog cull-edge in to hide the closer unload seam, then
  // restore on the way out. Mutating .values directly does NOT persist (only the
  // tweakpane onChange path does), so no saved-tweak pollution.
  // (state.surfCullStash hoisted to the module state record)
  const applySurfCull = (on: boolean) => {
    if (on && !state.surfCullStash) {
      state.surfCullStash = {
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
    } else if (!on && state.surfCullStash) {
      CONFIG.tileLoadRadius = state.surfCullStash.load;
      CONFIG.tileUnloadRadius = state.surfCullStash.unload;
      CITYGEN_TUNING.values.detailRadius = state.surfCullStash.detail;
      CITYGEN_TUNING.values.maxDetail = state.surfCullStash.maxDetail;
      state.surfCullStash = null;
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
    // tuning pane shows only the active mode's movement folder; the panel is a
    // late system, and a mode switch can land before it hydrates
    ctx.late.debugPanel?.setMode(mode);
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
    state.setRemoteSurfboardAssetsActive!(mode === "surf");
    state.setRemoteScooterAssetsActive!(mode === "scooter");
    state.setRemoteCarAssetsActive!(mode === "drive");
    state.setRemoteBirdAssetsActive!(mode === "bird");
    state.syncCustomizerForMode!(mode);
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
  // and their state machine cycles (see world/traffic/). The same decoded graph
  // later paints the map roads, avoiding another request/parse. Failures leave
  // the city without signals but never block boot.
  // (state.trafficLights hoisted to the module state record)
  // The road graph feeds both the traffic signals here and the minimap upgrade
  // (worldSystemsNet, via state.roadGraphPromise). In zone boot both defer to
  // wake — the pocket has no city streets to signal — so the wake runner both
  // loads the graph and (re)issues the minimap upgrade (the NET chain no-ops
  // on the null promise).
  const loadRoadGraphAndSignals = () => {
    ctx.state.auxPending++;
    const p = RoadGraph.load();
    state.roadGraphPromise = p;
    void p
      .then((roads) => {
        state.trafficLights = new TrafficLightView(scene, map, roads);
      })
      .catch((err: unknown) => console.warn("[traffic] signals unavailable", err))
      .finally(() => ctx.state.auxPending--);
  };
  void ctx.zoneBoot.deferCity("traffic", () => {
    loadRoadGraphAndSignals();
    if (ctx.zoneBoot.worldScope.mode === "zone") {
      void state.roadGraphPromise!
        .then((roads) => ctx.late.minimap?.setRoadGraph(roads))
        .catch(() => {});
    }
  });
  // (state.creatures hoisted to the module state record)
  // (state.forest hoisted to the module state record)
  // state.ANIMALS record — populated by the deferred state.forest module load
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // (state.ANIMALS hoisted to the module state record)
  const abandonedMounts = new AbandonedMounts(physics, map, scene);
  const embodiments = new EmbodimentController({
    player,
    physics,
    hud,
    abandonedMounts,
    getForest: () => state.forest
  });
  // (state.ghostShipRideZoom hoisted to the module state record)
  // (state.ghostShipRideYaw hoisted to the module state record)
  state.switchModeFromExit = (mode) => embodiments.switchMode(mode);
  const exitToWalk = () => {
    // Surf exits relocate from a live crest to the shoreline. The normal E/B
    // path and the out-of-bounds repair must use Navigation's covered preview;
    // ordinary mount dismounts remain local and immediate.
    if (player.mode === "surf") {
      state.switchModeFromExit!("walk");
      return true;
    }
    const leavingGhostShip = embodiments.passengerOf === GHOST_SHIP_RIDE_ID;
    const exited = embodiments.exitToWalk();
    if (exited && leavingGhostShip && state.ghostShipRideZoom !== null) {
      chase.zoom = state.ghostShipRideZoom;
      state.ghostShipRideZoom = null;
      state.ghostShipRideYaw = null;
    }
    return exited;
  };
  type ViewMode = "third" | "first" | "orbit";
  const VIEW_CYCLE: ViewMode[] = ["third", "first", "orbit"];
  let viewMode: ViewMode = "third";
  const inOrbit = () => viewMode === "orbit";
  // Scattered boardable bay boats (persistent, self-sailing, far-hidden) —
  // extracted per docs/MAIN_DECOMPOSITION.md.
  void ctx.zoneBoot.deferCity("scatter-boats", () => spawnScatterBoats(abandonedMounts));
  await constructionSlice();
  // Nature uses one sandbox vegetation runtime now. The old primitive Flora
  // and site-local blob/tree renderers are gone: regions own placement, while
  // shared trees, shrubs, grass and flowers own geometry/materials/wind/LOD.
  //
  // San Francisco Botanical Garden — self-contained module (src/world/state.garden):
  // Unified trees + blade grass + leaf-spray shrubs + flower clumps at the real
  // SFBG footprint inside Golden Gate Park. Trees stream in async; grass is live.
  // state.garden, state.wildlands are deferred — constructed after progress(100)
  // so they don't block first paint. Nullable refs; update calls are guarded.
  // (state.garden hoisted to the module state record)
  // (state.wildlands hoisted to the module state record)
  // (state.buenaVistaTrees hoisted to the module state record)
  // (state.goldenGateTennis hoisted to the module state record)
  // (state.wakeDeferredGarden hoisted to the module state record)
  // (state.wakeDeferredBuenaVistaTrees hoisted to the module state record)
  // (state.wakeDeferredWildlandsGolf hoisted to the module state record)
  // Universal minigame site gate: each located game (pickleball, state.golf, soon
  // state.archery) registers a footprint + pads; one cheap update per tick flips
  // them awake only while the player is nearby. Sites register asleep — the
  // first tick wakes any the player already stands in.
  const siteGate = createSiteGate();
  // (state.coronaHeights hoisted to the module state record)
  // (state.missionDolores hoisted to the module state record)
  let missionDoloresLoading: Promise<void> | null = null;
  // (state.sutroBaths hoisted to the module state record)
  // (state.museumBookOpen hoisted to the module state record)
  const ensureMissionDolores = (playerPos: THREE.Vector3): void => {
    if (state.missionDolores || missionDoloresLoading) return;
    const dx = playerPos.x - MISSION_DOLORES_CENTER.x;
    const dz = playerPos.z - MISSION_DOLORES_CENTER.z;
    if (dx * dx + dz * dz > 190 * 190) return;
    missionDoloresLoading = import("../../world/missionDolores")
      .then(({ createMissionDoloresMuseum }) => {
        state.missionDolores = createMissionDoloresMuseum(map, physics, {
          scene,
          renderer,
          camera,
          onBookToggle: (open) => {
            state.museumBookOpen = open;
            app.classList.toggle("world-dimmed", open);
            input.suspended = open || inOrbit();
            if (open) input.releaseLock();
          }
        });
        const debug = (window as unknown as { __sf?: { missionDolores: MissionDoloresMuseum | null } }).__sf;
        if (debug) debug.missionDolores = state.missionDolores;
      })
      .catch((err) => {
        console.warn("[boot] Mission Dolores museum unavailable:", err);
      });
  };
  const gardenDisplacer: GroundDisplacer = { x: 0, z: 0, radius: 1.6, strength: 1 };
  const gardenDisplacers = [gardenDisplacer];
  // Master foliage switch (bound at the top of the "/" panel): `ctx.state.foliageOn`,
  // declared in P1 beside renderFrame. When off, every vegetation group is
  // hidden AND its per-frame update is skipped in the loop below.
  const setFoliageVisible = (visible: boolean) => {
    ctx.state.foliageOn = visible;
    state.garden?.setVisible(visible, player.position);
    if (state.wildlands) for (const g of state.wildlands.groups) g.visible = visible;
    if (state.buenaVistaTrees) state.buenaVistaTrees.group.visible = visible;
    state.goldenGateTennis?.setFoliageVisible(visible);
    ctx.late.teaGarden!.setFoliageVisible(visible);
    state.sutroBaths?.setFoliageVisible(visible);
    ctx.state.siteFoliage?.setVisible(visible);
    state.islands?.setFoliageVisible(visible);
  };
  // Alcatraz/Angel/Yerba Buena islands: city-wide scenery, deferred in zone
  // boot and (re)armed with vegetation by the wake runner.
  const armIslandsVegetation = () =>
    state.islands?.armVegetation(scene, async (group) => {
      await waitForWorldBackgroundWindow(1800);
      try {
        await renderer.compileAsync(group, camera, scene);
      } catch (err) {
        console.warn("[islands] deferred vegetation compile failed:", err);
      }
    });
  void ctx.zoneBoot.deferCity("islands", () => {
    state.islands = new Islands(physics, map, scene);
    state.islands.setFoliageVisible(ctx.state.foliageOn);
    if (ctx.zoneBoot.worldScope.mode === "zone") armIslandsVegetation();
  });
  await constructionSlice();

  // Decoupled world-query service: every "what does this ray hit" caller (paint,
  // the in-world cursor, future systems) goes through here. Backed by box3d's
  // broadphase cast over a dedicated query world of entity proxies, raced against
  // the static-world caster.
  const worldQueries = new WorldQueries(physics);
  // Building ray refinement: baked building colliders overshoot the true
  // footprint by up to ~2 m, so every raycastWorld consumer (paint, the world
  // cursor, state.golf bounces) re-tests building hits against the RENDERED state.citygen
  // geometry — splats land on the visible wall, and rays aimed through gaps
  // between far buildings no longer stop mid-air on the loose box.
  const buildingRayRefiner = new BuildingRayRefiner(scene);
  physics.setBuildingRayRefiner(buildingRayRefiner);

  // The production ring is citywide. The small demo spawner is debug-only and
  // stays out of ordinary boot unless a probe explicitly asks for it.
  // (state.citygen hoisted to the module state record)
  const citygenRing: { current: CityGenRing | null } = { current: null };
  // M12: late-bound far-teleport cell re-gate.
  ctx.state.citygenApplyFrontGate = () => citygenRing.current?.applyFrontGate();

  // crabs to hunt (hunt.ts)
  const satchel = new Satchel();
  // Presidio golf: full 18 playable holes on the real course footprint —
  // deferred (data fetch + course meshes build behind the settle gate below)
  // (state.golf hoisted to the module state record)
  // Golden Gate Park state.archery range — NW corner of the park; site-gated like state.golf.
  // (state.archery hoisted to the module state record)
  // (state.pup hoisted to the module state record)
  // Palace of Fine Arts blue-hour art quest (site-gated around the lagoon).
  // (state.palaceReverie hoisted to the module state record)
  // Lands End — the NW headland: a cliff-top Labyrinth you light by walking,
  // Sutro Baths ruins, cypress and a lantern-keeper. Distance-LOD region.
  // (state.landsEnd hoisted to the module state record)
  // (state.waveOrgan hoisted to the module state record)
  // Baker Beach pianist: `ctx.state.beachPianist` is declared in P1 (renderFrame reads
  // it); the lazy optional site hydrates it via onSitesChanged below.
  // (state.unregisterBeachPianistTuning hoisted to the module state record)
  // Buena Vista's hidden summit ritual: five wandering echoes and a sky-scale
  // finale, asleep outside its clearing like the other located activities.
  // (state.afterlight hoisted to the module state record)
  // Shoreline crab hunt: city-wide scenery, deferred in zone boot.
  void ctx.zoneBoot.deferCity("hunt", () => {
    state.hunt = new Hunt(map, scene);
    state.hunt.onCatch = (kind) => {
      satchel.add(kind);
      hud.message("Crab caught!", 1.1);
    };
  });

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
  // (state.goldenGateLights hoisted to the module state record)
  try {
    state.goldenGateLights = createGoldenGateLights(map);
    if (state.goldenGateLights) scene.add(state.goldenGateLights);
  } catch (err) {
    console.warn("[boot] golden gate lights unavailable:", err);
  }
  try {
    scene.add(createSutroBeacons(map));
  } catch (err) {
    console.warn("[boot] sutro beacons unavailable:", err);
  }
  await constructionSlice();
  // Keep the seven mapped Tea Garden buildings as the immediate baked fallback.
  // Their authored, walkable replacements claim the footprints atomically only
  // after the essential Tea Garden subtree is GPU-ready and attached. Suppressing
  // them here created the conspicuous empty state.garden during first approach.
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
  // state.fetchBall.update (tool-agnostic). park is a getter — state.coronaHeights is
  // null-until-built.
  state.fetchBall = new FetchBall({
    scene,
    map,
    physics,
    park: () => state.coronaHeights,
    playerView: {
      setBallHeld: (h) => player.setBallHeld(h),
      setThrowAnim: (t) => player.setThrowAnim(t),
      handWorldPos: (out) => player.handWorldPos(out)
    },
    hud: { message: (t, s) => hud.message(t, s) },
    onThrow: (throwId, x, y, z, vx, vy, vz) => ctx.late.net!.sendBall(throwId, x, y, z, vx, vy, vz),
    onPickupRequest: (sourceId, throwId) => ctx.late.net!.requestBallPickup(sourceId ?? ctx.late.net!.selfId, throwId),
    // A bounce on the tea-state.garden pond bottom is submerged — its plonk is voiced
    // by the water feature, so skip the dry thud there.
    onGroundImpact: (x, y, z, speed) => {
      if (ctx.late.teaGarden!.containsWater(x, z)) return;
      ballImpactAudio.ground(x, y, z, speed);
    }
  });
  // setTool ran before state.fetchBall existed — sync the held prop to the active tool
  toolCycle.syncHeldProp();
  // Dog-park sound layer: barks + paw-patter from the actual park dogs, riding
  // the nature soundscape's context/bus so HUD volume/mute and the corona
  // region fade all apply. Idles to a single distance check away from the park.
  const dogParkAudio = new DogParkAudio(nature, () => state.coronaHeights?.dogs ?? []);
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
  await constructionSlice();
  // (state.ridePromptShown hoisted to the module state record)
  // (state.doorPromptShown hoisted to the module state record)
  // (state.doorScanCountdown hoisted to the module state record)
  // (state.doorScanHit hoisted to the module state record)
  // way high above the ground (plane/drone cruising), ground flora and critters
  // are subpixel — their systems pause. Hysteresis so hill flanks don't flicker it.
  // (state.highUp hoisted to the module state record)

  // Car-landing shake/audio/dust feedback — extracted per docs/MAIN_DECOMPOSITION.md.
  const carLanding = createCarLandingFeedback({ player, embodiments, chase, vehicleAudio, fx });

  // free-orbit inspection camera (C toggles); pointer lock is the game default
  const orbit = new CameraControls(camera, renderer.domElement);
  orbit.enabled = false;
  orbit.smoothTime = 0.12;
  orbit.draggingSmoothTime = 0.08;
  orbit.maxDistance = 1200;
  // O in camera mode: smoothstepped 180° azimuth flip around the current target
  // (state.orbitFlip hoisted to the module state record)
  const orbitPickOrigin = new THREE.Vector3();
  const orbitPickDir = new THREE.Vector3();
  // Synthetic negative entity ids for busker pick proxies (stay clear of ctx.late.net! ids).
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
      state.orbitFlip = null;
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
  renderer.domElement.addEventListener("dblclick", (e: MouseEvent) => {
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
  // (state.uiOpen hoisted to the module state record)

  const showUi = () => {
    if (!state.uiOpen) {
      state.uiOpen = true;
      hud.setFaded(false);
    }
  };
  document.querySelector<HTMLButtonElement>("[data-ui-restore]")!.addEventListener("click", showUi);

  hud.setMode(player.mode);
  return {
    water,
    underwater,
    hud,
    fx,
    wake,
    boardWake,
    skidMarks,
    splashes,
    fireworks,
    gameplaySfxBus,
    graffiti,
    paintballs,
    paintSkins,
    bubbles,
    worldCursor,
    ensurePaintAudio,
    ensureBubbleAudio,
    toolCycle,
    setTool,
    setColor,
    toolbar,
    vehicleAudio,
    swimAudio,
    playerFoleyAudio,
    modeTransitionAudio,
    jumpLandingAudio,
    doorAudio,
    audioControls,
    nature,
    waveAudio,
    ballImpactAudio,
    updatePlayerFoley,
    ensureSurfShack,
    ensureSurfRuntime,
    releaseSurfVisual,
    surfBreakStillLocal,
    prepareSurfEntry,
    updateSurfPresentation,
    birdTrails,
    droneFireworkMounts,
    abandonedMounts,
    embodiments,
    exitToWalk,
    inOrbit,
    siteGate,
    ensureMissionDolores,
    gardenDisplacer,
    gardenDisplacers,
    setFoliageVisible,
    armIslandsVegetation,
    worldQueries,
    buildingRayRefiner,
    citygenRing,
    satchel,
    dogParkAudio,
    buskers,
    buskerTalk,
    carLanding,
    orbit,
    BUSKER_PICK_ID,
    BUSKER_PICK_R,
    setViewMode,
    cycleViewMode,
    state
  };
}
