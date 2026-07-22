// __sf debug surface + dev demo harness, extracted from main.ts's P4 tail
// (docs/MAIN_DECOMPOSITION.md). Pure exposure — no boot-order coupling; main
// calls this once after the P4 handoff.
import * as THREE from "three/webgpu";
import * as TSL from "three/tsl";
import { CITYGEN_TUNING, CONFIG, FLOWER_TUNING, FOLIAGE_TUNING, RENDER_TUNING, WORLD_TUNING } from "../../config";
import { POSTFX_TUNING } from "../../render/postfx";
import { CAR_LANDING_TUNING } from "../../vehicles/car";
import { PROCEDURAL_LAMP_TUNING } from "../../world/citygen/interior/lampTuning";
import { sharedMaterialLeakSnapshot } from "../../render/renderObjectRegistry";
import { materializeField } from "../../render/materialize";
import { tracer } from "../../core/hitchTracer";
import { motionGate } from "../../core/motionGate";
import { DebugRegistry } from "../debugRegistry";
import { type ToolName } from "../../ui/toolbar";
import { type OptionalSiteId } from "./optionalSites";
import type { MainCtx } from "./ctx";

export async function installDebugSurfaces(
  ctx: MainCtx,
  core: Awaited<ReturnType<typeof import("./worldSystemsCore").composeWorldSystemsCore>>,
  netW: Awaited<ReturnType<typeof import("./worldSystemsNet").composeWorldSystemsNet>>,
  frameB: Awaited<ReturnType<typeof import("./frameBody").composeFrameBody>>,
  extra: {
    dynRes: unknown;
    frameDriver: unknown;
    farOcclusion: unknown;
    ringCoordinator: import("../ringCoordinator").RingCoordinator;
    terrainTiles: import("../../world/terrainTiles").TerrainTileStreamer | null;
    modulesReady: () => boolean;
  }
): Promise<void> {
  const { scene, camera, player, tiles, authoredRegions, physics, renderer, pipeline, scheduler, chase, map, input, sky, worldArrival, voidRealm, audioEngine } = ctx;
  const { hud, fx, fireworks, graffiti, bubbles, setTool, setColor, splashes, vehicleAudio, swimAudio, waveAudio, gameplaySfxBus, playerFoleyAudio, jumpLandingAudio, modeTransitionAudio, doorAudio, nature, dogParkAudio, ballImpactAudio, boardWake, abandonedMounts, embodiments, paintballs, paintSkins, satchel, citygenRing, worldCursor, worldQueries, buildingRayRefiner, underwater, water, ensureSurfRuntime, setFoliageVisible, buskers, buskerTalk, siteGate } = core;
  const { debugPanel, net, remotes, voice, minimap, playerLocator, ghostShipBeacon, switchMode, buildShareUrl, tutorial, teleportToTarget, debugOverlays, calibrationChart, ensureCarCustomizer, lazyRegionTimings, sites, teaGarden, oceanKite, board, car, applyBoardConfig } = netW;
  const { tick } = frameB;

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
        frameB.state.cineHook = null;
        return;
      }
      frameB.state.cineHook = () => {
        camera.position.set(eye[0], eye[1], eye[2]);
        camera.up.set(0, 1, 0);
        camera.lookAt(target[0], target[1], target[2]);
        camera.updateMatrixWorld();
      };
    };
  }

  console.log("[sf] city online (webgpu)");

  // The adaptive-resolution governor doubles as the probe-visible extra.dynRes hook.

  const exposeDebugHooks = () => {
    // The `__sf` debug surface now derives from a typed DebugRegistry
    // (docs/MAIN_DECOMPOSITION.md, step 4) instead of a hand-maintained object
    // literal. `refs` are stable handles captured once — `const`s and any value
    // that IS a function (a getter/opener stored as-is for consumers to call).
    // `getters` are thunks evaluated by build(): every mutable `let` alias and
    // computed read, so this single build reflects the live binding exactly as
    // the old literal's shorthand did at this same point in boot. Live updates
    // continue to flow through the existing Object.assign refresh paths
    // (onSitesChanged, the late region-load callbacks) — untouched.
    const registry = new DebugRegistry();
    registry.refs({
      scene, camera, player, tiles, authoredRegions, physics, renderer, pipeline, frameDriver: extra.frameDriver,
      dynRes: extra.dynRes, tracer, scheduler, POSTFX_TUNING, WORLD_TUNING, FLOWER_TUNING,
      RENDER_TUNING, CAR_LANDING_TUNING, chase, map, input, hud, fx, fireworks,
      graffiti, bubbles, setTool, setColor, sky, farOcclusion: extra.farOcclusion, debugPanel, CONFIG,
      THREE, tick, splashes, vehicleAudio, swimAudio, waveAudio, gameplaySfxBus,
      audioEngine, playerFoleyAudio, jumpLandingAudio, modeTransitionAudio,
      doorAudio, nature, lofiMusic: core.lofiMusic, dogParkAudio, ballImpactAudio, net, remotes, voice,
      minimap, playerLocator, boardWake, abandonedMounts, ghostShipBeacon,
      embodiments, switchMode, paintballs, paintSkins, satchel, buildShareUrl, wakeCity: netW.wakeCity,
      tutorial, teleportToTarget, citygenRing, worldCursor, worldQueries,
      buildingRayRefiner, underwater, water, ensureSurfRuntime, debugOverlays,
      calibrationChart, FOLIAGE_TUNING, CITYGEN_TUNING, PROCEDURAL_LAMP_TUNING,
      setFoliageVisible, buskers, buskerTalk, ensureCarCustomizer, siteGate,
      siteFoliage: ctx.state.siteFoliage, TSL, worldArrival, lazyRegionTimings, voidRealm, motionGate,
      // Materialize front debug surface (docs/VOID_STREAM_REWRITE.md M2):
      // holo() collapses the front at the player (whole world holo), sweep()
      // animates the radius outward, reveal() restores the normal world.
      materialize: {
        field: materializeField,
        setFront: (x: number, z: number, radius: number, band?: number) =>
          materializeField.setFront(x, z, radius, band),
        sweep: (toRadius: number, speed?: number) =>
          materializeField.sweep(toRadius, speed),
        holo: () => materializeField.holo(player.position.x, player.position.z),
        reveal: () => materializeField.reveal()
      },
      // Ring coordinator debug surface (docs/VOID_STREAM_REWRITE.md M4):
      // front/residency telemetry + the teleport-style focus() entry point.
      rings: {
        state: () => extra.ringCoordinator.state,
        residentRadius: () => extra.ringCoordinator.residentRadius(),
        frontRadius: () => extra.ringCoordinator.frontRadius(),
        focus: (x: number, z: number, opts?: { reset?: boolean }) =>
          extra.ringCoordinator.focus(x, z, opts),
        // M14 terrain-data streaming telemetry (null on ?fullmap=1).
        terrain: () => extra.terrainTiles
          ? {
            ...extra.terrainTiles!.debug(),
            residentRadius: extra.terrainTiles.residentRadiusAround(player.position.x, player.position.z),
            playerTileReal: map.isTileRealAt(player.position.x, player.position.z),
            playerTile: map.tileKeyAt(player.position.x, player.position.z)
          }
          : null
      },
      // M9 leak metric: shared-material dispose-listener counts (retired
      // RenderObject retention) + total released. Must plateau on long roams.
      m9Leak: () => sharedMaterialLeakSnapshot(),
      getPaintAudio: () => core.state.paintAudio,
      getBubbleAudio: () => core.state.bubbleAudio,
      boardSelector: board,
      getBoardSelector: () => board.get(),
      getCarSelector: () => car.get(),
      getCarConfig: () => ({ ...ctx.state.carConfig }),
      getSurfboardConfig: () => ({ ...ctx.state.surfboardConfig }),
      optionalWorldSites: sites.list,
      ensureOptionalWorldSite: sites.ensure,
      teaGardenBuildingSwapState: teaGarden.buildingSwapState,
      ensureOceanBeachKite: oceanKite.ensure,
      oceanKiteSite: oceanKite.site,
      // renderIdle: probes MUST wait for this before capture phases — while the
      // deferred render warmup runs, tick() early-returns without rendering, so
      // screenshots would capture a stale boot-pose frame no matter what the
      // camera was set to.
      renderIdle: () => extra.modulesReady() && sites.streamingIdle()
    });
    registry.getters({
      creatures: () => core.state.creatures,
      hunt: () => core.state.hunt,
      islands: () => core.state.islands,
      forest: () => core.state.forest,
      garden: () => core.state.garden,
      wildlands: () => core.state.wildlands,
      buenaVistaTrees: () => core.state.buenaVistaTrees,
      goldenGateTennis: () => core.state.goldenGateTennis,
      japaneseTeaGarden: () => teaGarden.current(),
      pickleball: () => netW.state.pickleballController?.game ?? null,
      pickleballAmbient: () => netW.state.pickleballController?.ambient ?? null,
      pickleballAudio: () => netW.state.pickleballController?.audio ?? null,
      pickleballUI: () => netW.state.pickleballController?.ui ?? null,
      pickleballController: () => netW.state.pickleballController,
      coronaHeights: () => core.state.coronaHeights,
      missionDolores: () => core.state.missionDolores,
      sutroBaths: () => core.state.sutroBaths,
      ghostShip: () => netW.state.ghostShip,
      ensureGhostShipDetail: () => netW.state.ensureGhostShipDetail,
      fetchBall: () => core.state.fetchBall,
      goldenGateLights: () => core.state.goldenGateLights,
      trafficLights: () => core.state.trafficLights,
      citygen: () => core.state.citygen,
      oceanBeachWaves: () => ctx.state.oceanBeachWaves,
      surfExperience: () => core.state.surfExperience,
      ensureSurfboardCustomizer: () => core.state.ensureSurfboardCustomizer,
      palaceReverie: () => core.state.palaceReverie,
      landsEnd: () => core.state.landsEnd,
      beachPianist: () => ctx.state.beachPianist,
      afterlight: () => core.state.afterlight,
      oceanBeachKite: () => oceanKite.current()
    });
    Object.assign(window as never, { __sf: registry.build() });
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
      get afterlight() { return core.state.afterlight ?? undefined; },
      fetchBall: core.state.fetchBall ?? undefined,
      get coronaHeights() { return core.state.coronaHeights ?? undefined; },
      get palaceReverie() { return core.state.palaceReverie ?? undefined; },
      get landsEnd() { return core.state.landsEnd ?? undefined; },
      get waveOrgan() { return core.state.waveOrgan ?? undefined; },
      get beachPianist() { return ctx.state.beachPianist ?? undefined; },
      fireworks,
      worldQueries,
      setTool: (t: string) => setTool(t as ToolName),
      setBoardConfig: (config: any) => {
        applyBoardConfig(config);
        board.get()?.setConfig(config);
      },
      setCine: (fn: ((dt: number) => void) | null) => {
        frameB.state.cineHook = fn;
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
      const { runDemo } = await import("../../dev/demo");
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
