// Optional authored-site scheduler. Extracted from main.ts per
// docs/MAIN_DECOMPOSITION.md. This owns the lazily-imported destination
// sites (Goldman/pickleball, archery, pup, Fort Mason, palace, afterlight,
// Skyline Glide, Corona Heights, Lands End, Wave Organ, Beach Pianist, Sutro Baths) plus their
// exhibit-vegetation streamer, the streaming-monitor perf A/B panel, the
// serialized load queue, distance unload, and arrival re-prioritization.
//
// Design (see MAIN_DECOMPOSITION.md): the controller OWNS the site refs. main
// keeps thin `let` aliases only so its hot per-frame loop and `__sf` literal
// read the concrete instances unchanged — `onSitesChanged` fires at exactly the
// points the old `refreshOptionalSiteDebug` did (every ref write), letting main
// re-sync those aliases and refresh `__sf` in one place. Every `await import`
// stays inside a load function, so the lazy code-splitting boundaries and the
// WHEN of each fetch are byte-for-byte the prior behavior.
import * as THREE from "three/webgpu";
import { warmRootPaced } from "../../render/warmStaticRegion";
import { SiteFoliageStreamer, SiteFoliageYieldError } from "../../world/vegetation/siteFoliage";
import { windGustValue } from "../../world/vegetation/runtime";
import { GOLDMAN_SITE_CENTER, GOLDMAN_SUPPRESSED_BUILDINGS } from "../../world/goldenGateTennis/meta";
import { CORONA_HEIGHTS_SUMMIT, CORONA_DOG_PARK } from "../../world/coronaHeights/meta";
import {
  distanceToTrails as coronaDistanceToTrails,
  hash2 as coronaHash2,
  pointInPolygon as coronaPointInPolygon
} from "../../world/coronaHeights/rules";
import { ARCHERY_CENTER } from "../../gameplay/archery/meta";
import { PUP_CENTER } from "../../gameplay/pup/meta";
import { FORT_MASON_ENSEMBLE_CENTER } from "../../gameplay/fortMasonEnsemble/meta";
import { REVERIE_CENTER } from "../../gameplay/palaceReverie/meta";
import { AFTERLIGHT_ARRIVAL, isAfterlightOpenAtHour } from "../../gameplay/afterlight/meta";
import { HANG_GLIDING_SITE } from "../../gameplay/hangGliding/meta";
import { LANDS_END_CENTER } from "../../world/landsEnd/meta";
import { WAVE_ORGAN_CENTER } from "../../world/waveOrgan/meta";
import { BEACH_PIANIST_CENTER } from "../../world/beachPianist/meta";
import { SUTRO_BATHS_ARRIVAL } from "../../world/spawnPoints";
import type { WorldMap } from "../../world/heightmap";
import type { Physics } from "../../core/physics";
import type { TileStreamer } from "../../world/tiles";
import type { Sky } from "../../world/sky";
import type { Player } from "../../player/player";
import type { Input } from "../../core/input";
import type { HUD } from "../../ui/hud";
import type { Net } from "../../net/net";
import type { RemotePlayers } from "../../net/remotes";
import type { ChaseCamera } from "../../core/camera";
import type { FX } from "../../fx/fx";
import type { DebugPanel } from "../../ui/debug";
import type { AuthoredRegionStreamer } from "../../world/authoredRegions";
import type { WorldQueries } from "../../core/worldQueries";
import type { EmbodimentController } from "../player/embodimentController";
import type { WorldArrivalCoordinator } from "../worldArrival";
import type { AvatarTraits } from "../../player/avatar";
import type { DogParkAudio, createNatureSoundscape } from "../../audio";
import type { createSiteGate } from "../../gameplay/siteGate";
import type { GoldenGateTennisSite } from "../../world/goldenGateTennis";
import type { CoronaHeightsPark } from "../../world/coronaHeights";
import type { ArcheryGame } from "../../gameplay/archery";
import type { PupPen } from "../../gameplay/pup";
import type { FortMasonEnsemble } from "../../gameplay/fortMasonEnsemble";
import type { PalaceReverieGame } from "../../gameplay/palaceReverie";
import type { LandsEndRegion } from "../../world/landsEnd";
import type { WaveOrgan } from "../../world/waveOrgan";
import type { BeachPianist } from "../../world/beachPianist";
import type { AfterlightExperience } from "../../gameplay/afterlight";
import type { HangGlidingExperience } from "../../gameplay/hangGliding";
import type { PickleballController } from "../systems/pickleball";

type Nature = ReturnType<typeof createNatureSoundscape>;
type SiteGate = ReturnType<typeof createSiteGate>;
type SutroBaths = import("../../world/sutroBaths").SutroBaths;

export type OptionalSiteId =
  | "goldman"
  | "archery"
  | "palace"
  | "afterlight"
  | "hang-gliding"
  | "corona"
  | "lands-end"
  | "wave-organ"
  | "sutro-baths"
  | "pup"
  | "fort-mason-ensemble"
  | "beach-pianist";
type OptionalSiteState = "dormant" | "queued" | "loading" | "ready" | "failed";
type OptionalSiteStage = () => Promise<void>;
type OptionalSiteCompile = (
  object: THREE.Object3D,
  camera: THREE.Camera,
  scene: THREE.Scene
) => Promise<unknown>;
type OptionalSiteLoadContext = {
  /** Abortable stage boundary: waits for admission, then throws if the load
   * was aborted or the player left residency. Use between stages whose
   * partial work the load function can dispose. */
  stage: OptionalSiteStage;
  /** Admission wait without abort semantics, for stages after a
   * construction step the site cannot roll back. */
  waitStage: OptionalSiteStage;
  /** Pipeline warm entry: dispatches to the arrival priority compile lane
   * while the site is the teleport/boot destination, else the ordinary
   * serialized background path. Dynamic — an in-flight load upgraded to the
   * priority lane by a new arrival gets the fast lane for its remaining
   * compiles. */
  compile: OptionalSiteCompile;
  signal: AbortSignal;
};
type OptionalWorldSite = {
  id: OptionalSiteId;
  label: string;
  x: number;
  z: number;
  state: OptionalSiteState;
  forced: boolean;
  /** Arrival lane: this site is the teleport/boot destination's exhibit.
   * Skips background quiet windows; only the travel cover outranks it. */
  priority: boolean;
  /** First time the player was inside the approach radius while dormant.
   * Caps quiet-window deferral so a moving player still gets the exhibit. */
  eligibleSince: number;
  controller: AbortController | null;
  promise: Promise<void> | null;
  load: (context: OptionalSiteLoadContext) => Promise<void>;
  /** A false value prevents automatic import; explicit debug loads still work. */
  available?: () => boolean;
};

/** Live instances the controller owns; main mirrors these into its aliases +
 * `__sf` whenever `onSitesChanged` fires. */
export type OptionalSiteRefs = {
  goldenGateTennis: GoldenGateTennisSite | null;
  pickleballController: PickleballController | null;
  archery: ArcheryGame | null;
  pup: PupPen | null;
  fortMasonEnsemble: FortMasonEnsemble | null;
  palaceReverie: PalaceReverieGame | null;
  afterlight: AfterlightExperience | null;
  hangGliding: HangGlidingExperience | null;
  coronaHeights: CoronaHeightsPark | null;
  landsEnd: LandsEndRegion | null;
  waveOrgan: WaveOrgan | null;
  beachPianist: BeachPianist | null;
  sutroBaths: SutroBaths | null;
};

export function createOptionalSites({
  map,
  physics,
  scene,
  sky,
  tiles,
  renderer,
  camera,
  nature,
  net,
  player,
  input,
  hud,
  chase,
  remotes,
  embodiments,
  fx,
  siteGate,
  worldArrival,
  debugPanel,
  dogParkAudio,
  authoredRegions,
  worldQueries,
  waitForWorldBackgroundWindow,
  priorityCompile,
  revealedPromise,
  getFoliageOn,
  getRevealed,
  getAvatar,
  onSitesChanged,
  zoneAllowlist
}: {
  map: WorldMap;
  physics: Physics;
  scene: THREE.Scene;
  sky: Sky;
  tiles: TileStreamer;
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  nature: Nature;
  net: Net;
  player: Player;
  input: Input;
  hud: HUD;
  chase: ChaseCamera;
  remotes: RemotePlayers;
  embodiments: EmbodimentController;
  fx: FX;
  siteGate: SiteGate;
  worldArrival: WorldArrivalCoordinator;
  debugPanel: DebugPanel;
  dogParkAudio: DogParkAudio;
  authoredRegions: AuthoredRegionStreamer;
  worldQueries: WorldQueries;
  waitForWorldBackgroundWindow: (extraQuietMs?: number, deadline?: number) => Promise<void>;
  /** pipeline.compileAsyncPrioritized: the destination-exhibit compile lane
   * (jumps queued scenery, bypasses the reveal blocker, near-skips
   * stillness). */
  priorityCompile: OptionalSiteCompile;
  revealedPromise: Promise<void>;
  getFoliageOn: () => boolean;
  getRevealed: () => boolean;
  getAvatar: () => AvatarTraits;
  /** Fires at every site ref change (the old refreshOptionalSiteDebug points). */
  onSitesChanged: (refs: OptionalSiteRefs) => void;
  /** Zone-only boot: when set, only sites in this set auto-load and only their
   * exhibit foliage registers. `liftZoneRestriction()` (called by wakeCity)
   * clears it. Independent of the perf A/B flags. */
  zoneAllowlist?: ReadonlySet<OptionalSiteId>;
}): {
  update: () => void;
  /** Per-frame (runs even during arrival, unlike update): re-assert the streaming
   * panel's A/B visibility toggles while its gating is active — a no-op otherwise. */
  applyPerfGates: () => void;
  ensure: (id: OptionalSiteId) => Promise<void>;
  reprioritizeForArrival: (destination: Readonly<{ x: number; z: number }>) => void;
  perfAllowed: (id: OptionalSiteId) => boolean;
  /** Zone-only boot: drop the allowlist (all sites auto-loadable again) and
   * register the exhibit foliage entries that were skipped. Idempotent. */
  liftZoneRestriction: () => void;
  streamingIdle: () => boolean;
  /** The live site registry, exposed on __sf.optionalWorldSites for the lazy-site probes. */
  readonly list: readonly OptionalWorldSite[];
  readonly siteFoliage: SiteFoliageStreamer | null;
} {
  let goldenGateTennis: GoldenGateTennisSite | null = null;
  let archery: ArcheryGame | null = null;
  let pup: PupPen | null = null;
  let fortMasonEnsemble: FortMasonEnsemble | null = null;
  let palaceReverie: PalaceReverieGame | null = null;
  let afterlight: AfterlightExperience | null = null;
  let hangGliding: HangGlidingExperience | null = null;
  let coronaHeights: CoronaHeightsPark | null = null;
  let landsEnd: LandsEndRegion | null = null;
  let waveOrgan: WaveOrgan | null = null;
  let beachPianist: BeachPianist | null = null;
  let sutroBaths: SutroBaths | null = null;
  let pickleballController: PickleballController | null = null;
  let siteFoliage: SiteFoliageStreamer | null = null;
  // Zone-only boot allowlist (independent of the perf A/B flags). Cleared by
  // liftZoneRestriction() at wake, which then registers the deferred foliage.
  let zoneRestriction: ReadonlySet<OptionalSiteId> | null = zoneAllowlist ?? null;
  const zoneAllowed = (id: OptionalSiteId): boolean => !zoneRestriction || zoneRestriction.has(id);
  const OPTIONAL_SITE_APPROACH_RADIUS = 500;
  const OPTIONAL_SITE_RECHECK_RADIUS = OPTIONAL_SITE_APPROACH_RADIUS * 1.25;
  const OPTIONAL_SITE_UNLOAD_RADIUS = 1000;
  const OPTIONAL_SITE_STARVATION_CAP_MS = 2500;
  const waitForOptionalSiteStage = () => waitForWorldBackgroundWindow(700);
  const optionalSiteAbortError = () =>
    new DOMException("Optional site load aborted", "AbortError");
  const isAbortError = (error: unknown): boolean =>
    error instanceof DOMException && error.name === "AbortError";
  const optionalSiteDistance = (site: OptionalWorldSite): number =>
    Math.hypot(player.position.x - site.x, player.position.z - site.z);
  // rAF raced against a timeout: a hidden tab has no presentation frames, and
  // an rAF-only wait would deadlock the load exactly like the tea-garden
  // backgrounded-tab build once did.
  const presentationFrameOrTimeout = () => new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    requestAnimationFrame(settle);
    setTimeout(settle, 250);
  });
  // Pre-commit arrival phases: the resolver/committer own the main thread to
  // plan the destination and cut the player over. Once the arrival reaches its
  // loading phases the destination is fixed and its ground work is mostly
  // async, so the exhibit's construction can overlap the cover and the
  // materialize sweep — its compiles ride the priority lane, which bypasses
  // the reveal blocker.
  const ARRIVAL_PRE_COMMIT_STATES = new Set(["resolving", "committing"]);
  const optionalSiteAdmission = async (site: OptionalWorldSite): Promise<void> => {
    if (site.priority) {
      // Destination content: start as soon as the arrival has committed the
      // destination instead of after the whole arrival transaction ends.
      while (
        worldArrival.active && ARRIVAL_PRE_COMMIT_STATES.has(worldArrival.snapshot.state)
      ) {
        await presentationFrameOrTimeout();
      }
      await presentationFrameOrTimeout();
      return;
    }
    const deadline = site.eligibleSince > 0
      ? site.eligibleSince + OPTIONAL_SITE_STARVATION_CAP_MS
      : Infinity;
    // The quiet-window park is settle-gated and uninterruptible on its own; a
    // teleport that flags THIS site priority (or aborts it) must not leave the
    // load stuck behind the whole city fill. Race the park against both.
    const signal = site.controller?.signal ?? null;
    let admissionSettled = false;
    const interrupt = (async () => {
      while (!admissionSettled && !site.priority && !(signal?.aborted ?? false)) {
        await presentationFrameOrTimeout();
      }
    })();
    try {
      await Promise.race([waitForWorldBackgroundWindow(700, deadline), interrupt]);
    } finally {
      admissionSettled = true;
    }
    if (signal?.aborted) throw signal.reason ?? optionalSiteAbortError();
    if (site.priority) return optionalSiteAdmission(site);
  };
  const optionalSiteStagesFor = (
    site: OptionalWorldSite,
    signal: AbortSignal
  ): Pick<OptionalSiteLoadContext, "stage" | "waitStage" | "compile"> => ({
    waitStage: () => optionalSiteAdmission(site),
    compile: (object, warmCamera, warmScene) =>
      site.priority
        ? priorityCompile(object, warmCamera, warmScene)
        : renderer.compileAsync(object, warmCamera, warmScene),
    stage: async () => {
      if (signal.aborted) throw signal.reason ?? optionalSiteAbortError();
      await optionalSiteAdmission(site);
      if (signal.aborted) throw signal.reason ?? optionalSiteAbortError();
      if (
        !site.forced && !site.priority &&
        (site.state === "queued" || site.state === "loading") &&
        optionalSiteDistance(site) > OPTIONAL_SITE_RECHECK_RADIUS
      ) {
        site.controller?.abort(optionalSiteAbortError());
        throw optionalSiteAbortError();
      }
    }
  });

  // Publish the live instances back to main, which re-syncs its thin aliases and
  // refreshes __sf (the pickleball derivatives + all site keys) in one place —
  // this fires at exactly the points the old inline refreshOptionalSiteDebug did.
  const refreshOptionalSiteDebug = () => {
    onSitesChanged({
      goldenGateTennis,
      pickleballController,
      archery,
      pup,
      fortMasonEnsemble,
      palaceReverie,
      afterlight,
      hangGliding,
      coronaHeights,
      landsEnd,
      waveOrgan,
      beachPianist,
      sutroBaths
    });
  };

  const prepareOptionalRoot = async (
    label: string,
    root: THREE.Object3D,
    stage: OptionalSiteStage = waitForOptionalSiteStage,
    compile?: OptionalSiteCompile
  ): Promise<void> => {
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
      await stage();
      // Per-signature paced warm: one small exclusive-compile window per chunk
      // with a presented frame between, instead of one monolithic compileAsync
      // that froze rendering ~1 s when a dense site hydrated at an arrival.
      await warmRootPaced(renderer, camera, scene, root, async () => {
        await new Promise<void>((r) => requestAnimationFrame(() => r()));
      }, 8, compile);
    } catch (error) {
      // Compilation is a presentation optimization, never a reason to discard
      // a successfully constructed site. An abortable stage may still retire
      // the whole load here — the caller owns that cleanup.
      if (isAbortError(error)) throw error;
      console.warn(`[${label}] deferred compile failed:`, error);
    } finally {
      for (const state of renderState) {
        state.object.visible = state.visible;
        state.object.frustumCulled = state.frustumCulled;
      }
      parent?.add(root);
    }
  };

  // Gate registrations are kept so a distance unload can retire its site's
  // wake/sleep pads with the rest of the feature.
  const optionalSiteGateRegistrations: Partial<
    Record<OptionalSiteId, ReturnType<typeof siteGate.register>>
  > = {};

  // Shared teardown for distance unload and mid-load aborts: the court, its
  // physics and overlay, the clubhouse swap, and the pickleball layer all
  // return to their pre-approach state so a later approach rebuilds cleanly.
  const teardownGoldman = (): void => {
    pickleballController?.dispose();
    pickleballController = null;
    if (goldenGateTennis) {
      goldenGateTennis.dispose();
      goldenGateTennis = null;
      for (const building of GOLDMAN_SUPPRESSED_BUILDINGS) {
        tiles.unsuppressBuildingMesh(building.key, building.index);
      }
      sky.invalidateStaticShadows();
    }
    refreshOptionalSiteDebug();
  };

  const loadGoldman = async ({ stage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createGoldenGateTennisSite } = await import("../../world/goldenGateTennis");
    await stage();
    let site: GoldenGateTennisSite | null = null;
    let suppressed = false;
    try {
      site = createGoldenGateTennisSite(map, {
        physics,
        daylight: () => sky.sunElevation > 0
      });
      await prepareOptionalRoot("goldman", site.group, stage, compile);
      // Swap the generic clubhouse only when its authored replacement is ready
      // to attach. Any failure restores the baked fallback immediately.
      for (const building of GOLDMAN_SUPPRESSED_BUILDINGS) {
        tiles.suppressBuildingMesh(building.key, building.index);
      }
      suppressed = true;
      site.addTo(scene);
      site.setFoliageVisible(getFoliageOn());
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
      await stage();
      const { PickleballController: LoadedPickleballController } = await import("../systems/pickleball");
      await stage();
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
        getAvatar: () => getAvatar()
      });
      pickleballController = controller;
      try {
        await stage();
        await controller.prepareRender(renderer, camera, scene);
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn("[pickleball] deferred compile failed:", error);
      }
      if (net.status === "online") controller.onWelcome();
      else controller.syncSlots();
      refreshOptionalSiteDebug();
    } catch (error) {
      if (isAbortError(error)) {
        // A superseded destination mid-build: leave nothing half-attached. The
        // whole site returns to dormant so the next approach rebuilds it.
        teardownGoldman();
        throw error;
      }
      console.warn("[pickleball] first-approach construction failed:", error);
    }
  };

  const loadArchery = async ({ stage, waitStage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createArchery } = await import("../../gameplay/archery");
    await stage();
    // Construction registers physics and gate state the site cannot yet roll
    // back, so no abort boundaries after this point — only admission waits.
    const game = createArchery(map, physics, worldQueries, scene, {
      nature,
      daylight: () => sky.sunElevation > 0.05
    });
    await prepareOptionalRoot("archery", game.root, waitStage, compile);
    archery = game;
    optionalSiteGateRegistrations.archery = siteGate.register(game.siteHooks());
    refreshOptionalSiteDebug();
  };

  const loadPup = async ({ stage, waitStage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createPupPen } = await import("../../gameplay/pup");
    await stage();
    const pen = createPupPen(map, physics, scene);
    await prepareOptionalRoot("pup", pen.root, waitStage, compile);
    pup = pen;
    optionalSiteGateRegistrations.pup = siteGate.register(pen.siteHooks());
    refreshOptionalSiteDebug();
  };

  const loadFortMasonEnsemble = async ({ stage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createFortMasonEnsemble } = await import("../../gameplay/fortMasonEnsemble");
    await stage();
    const ensemble = createFortMasonEnsemble({ map, net, player, input, hud, chase });
    try {
      await prepareOptionalRoot("fort-mason ensemble", ensemble.root, stage, compile);
      fortMasonEnsemble = ensemble;
      scene.add(ensemble.root);
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    } catch (error) {
      if (fortMasonEnsemble === ensemble) fortMasonEnsemble = null;
      ensemble.dispose();
      throw error;
    }
  };

  const loadPalace = async ({ stage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createPalaceReverie } = await import("../../gameplay/palaceReverie");
    await stage();
    const game = createPalaceReverie(map, scene);
    try {
      await prepareOptionalRoot("palace-reverie", game.root, stage, compile);
      palaceReverie = game;
      optionalSiteGateRegistrations.palace = siteGate.register(game.siteHooks());
      refreshOptionalSiteDebug();
    } catch (error) {
      if (palaceReverie === game) palaceReverie = null;
      game.dispose();
      throw error;
    }
  };

  const loadAfterlight = async ({ stage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createAfterlight } = await import("../../gameplay/afterlight");
    await stage();
    const experience = createAfterlight(map, scene, nature);
    try {
      await experience.ready;
      // prepareWarmup exposes every authored state; detach immediately so none of
      // those temporary states can flash into a live frame while WebGPU compiles.
      const restore = experience.prepareWarmup();
      experience.root.removeFromParent();
      experience.root.updateMatrixWorld(true);
      try {
        await stage();
        await warmRootPaced(renderer, camera, scene, experience.root, async () => {
          await new Promise<void>((r) => requestAnimationFrame(() => r()));
        }, 8, compile);
      } catch (error) {
        if (isAbortError(error)) throw error;
        console.warn("[afterlight] deferred compile failed:", error);
      } finally {
        restore();
      }
      afterlight = experience;
      experience.setNightOpen(isAfterlightOpenAtHour(sky.timeOfDay));
      optionalSiteGateRegistrations.afterlight = siteGate.register(experience.siteHooks());
      refreshOptionalSiteDebug();
    } catch (error) {
      if (afterlight === experience) afterlight = null;
      experience.root.removeFromParent();
      experience.dispose();
      throw error;
    }
  };

  const loadHangGliding = async ({ stage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createHangGliding } = await import("../../gameplay/hangGliding");
    await stage();
    const experience = createHangGliding(map, physics, scene, () => sky.sunElevation);
    try {
      await experience.ready;
      await prepareOptionalRoot("hang-gliding", experience.root, stage, compile);
      hangGliding = experience;
      optionalSiteGateRegistrations["hang-gliding"] = siteGate.register(experience.siteHooks());
      refreshOptionalSiteDebug();
    } catch (error) {
      if (hangGliding === experience) hangGliding = null;
      experience.dispose();
      throw error;
    }
  };

  const loadCorona = async ({ stage, waitStage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { CoronaHeightsPark: LoadedCoronaHeightsPark } = await import("../../world/coronaHeights");
    await stage();
    const park = new LoadedCoronaHeightsPark(map, physics);
    await prepareOptionalRoot("corona-heights", park.group, waitStage, compile);
    park.onDogAudioCue = (dog, cue) => dogParkAudio.cue(dog, cue);
    coronaHeights = park;
    scene.add(park.group);
    sky.invalidateStaticShadows();
    refreshOptionalSiteDebug();
  };

  const loadLandsEnd = async ({ stage, waitStage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { LandsEndRegion: LoadedLandsEndRegion } = await import("../../world/landsEnd");
    await stage();
    const region = new LoadedLandsEndRegion(map);
    // The eye-walker's GLB + rider arm later (near the labyrinth); warm their
    // pipelines off-frame when that happens.
    region.walker.prepareRender = (root) => prepareOptionalRoot("lands-end-walker", root, waitStage, compile);
    await prepareOptionalRoot("lands-end", region.group, waitStage, compile);
    landsEnd = region;
    scene.add(region.group);
    sky.invalidateStaticShadows();
    refreshOptionalSiteDebug();
  };

  const loadWaveOrgan = async ({ stage, waitStage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { WaveOrgan: LoadedWaveOrgan } = await import("../../world/waveOrgan");
    await stage();
    const organ = new LoadedWaveOrgan(map, nature);
    await prepareOptionalRoot("wave-organ", organ.group, waitStage, compile);
    waveOrgan = organ;
    scene.add(organ.group);
    sky.invalidateStaticShadows();
    refreshOptionalSiteDebug();
  };

  const loadBeachPianist = async ({ stage, waitStage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { BeachPianist: LoadedBeachPianist } = await import("../../world/beachPianist");
    await stage();
    // The whole site is procedural; its pipelines warm off-frame at PRIME range
    // (prepareRender), so the first visible flip never compiles mid-frame.
    const site = new LoadedBeachPianist({
      map,
      prepareRender: (root) => prepareOptionalRoot("beach-pianist", root, waitStage, compile)
    });
    scene.add(site.group);
    beachPianist = site;
    sky.invalidateStaticShadows();
    refreshOptionalSiteDebug();
  };

  const loadSutroBaths = async ({ stage, compile }: OptionalSiteLoadContext): Promise<void> => {
    const { createSutroBaths } = await import("../../world/sutroBaths");
    await stage();
    let candidate: import("../../world/sutroBaths").SutroBaths | null = null;
    try {
      candidate = createSutroBaths({
        renderer,
        scene,
        physics,
        authoredRegions
      });
      // The geographic tile already owns and displays the period hall. Warm only
      // its optional living layer (foliage, bathers and nearby effects) here.
      candidate.setFoliageVisible(true);
      await candidate.ready;
      await prepareOptionalRoot("sutro-baths", candidate.group, stage, compile);

      candidate.setFoliageVisible(getFoliageOn());
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

  const optionalWorldSite = (
    base: Pick<OptionalWorldSite, "id" | "label" | "x" | "z" | "load"> &
      Partial<Pick<OptionalWorldSite, "available">>
  ): OptionalWorldSite => ({
    ...base,
    state: "dormant",
    forced: false,
    priority: false,
    eligibleSince: 0,
    controller: null,
    promise: null
  });

  const optionalWorldSites: OptionalWorldSite[] = [
    optionalWorldSite({
      id: "goldman",
      label: "Goldman Tennis Center",
      x: GOLDMAN_SITE_CENTER.x,
      z: GOLDMAN_SITE_CENTER.z,
      load: loadGoldman
    }),
    optionalWorldSite({ id: "archery", label: "Archery Range", ...ARCHERY_CENTER, load: loadArchery }),
    optionalWorldSite({ id: "pup", label: "Puppy Nursery", ...PUP_CENTER, load: loadPup }),
    optionalWorldSite({
      id: "fort-mason-ensemble",
      label: "Fort Mason Jam",
      ...FORT_MASON_ENSEMBLE_CENTER,
      load: loadFortMasonEnsemble
    }),
    optionalWorldSite({ id: "palace", label: "Palace Reverie", ...REVERIE_CENTER, load: loadPalace }),
    optionalWorldSite({
      id: "hang-gliding",
      label: "Sutro Tower · Skyline Glide",
      ...HANG_GLIDING_SITE,
      load: loadHangGliding
    }),
    optionalWorldSite({
      id: "afterlight",
      label: "Afterlight · 21:00–05:00",
      ...AFTERLIGHT_ARRIVAL,
      load: loadAfterlight,
      available: () => isAfterlightOpenAtHour(sky.timeOfDay)
    }),
    optionalWorldSite({ id: "corona", label: "Corona Heights", ...CORONA_HEIGHTS_SUMMIT, load: loadCorona }),
    optionalWorldSite({ id: "lands-end", label: "Lands End", ...LANDS_END_CENTER, load: loadLandsEnd }),
    optionalWorldSite({ id: "wave-organ", label: "Wave Organ", ...WAVE_ORGAN_CENTER, load: loadWaveOrgan }),
    optionalWorldSite({ id: "beach-pianist", label: "Beach Pianist", ...BEACH_PIANIST_CENTER, load: loadBeachPianist }),
    optionalWorldSite({
      id: "sutro-baths",
      label: "Sutro Baths · 1896",
      x: SUTRO_BATHS_ARRIVAL.x,
      z: SUTRO_BATHS_ARRIVAL.z,
      load: loadSutroBaths
    })
  ];

  // Exhibit vegetation streams on its own landscape radii, decoupled from the
  // gameplay sites above: trees read from far offshore and survive their
  // exhibit unloading behind the player. Each build() dynamic-imports the
  // site's placement module and plants through the shared vegetation runtime.
  // The destination exhibit always outranks scenery: a cypress compile racing
  // the labyrinth's own pipeline work at boot can starve the thing the player
  // actually teleported to. Foliage admissions wait until no optional site is
  // mid-construction (bounded — exhibit builds complete or abort).
  const optionalSiteConstructionIdle = async (): Promise<void> => {
    while (
      optionalWorldSites.some((site) => site.state === "queued" || site.state === "loading")
    ) {
      await new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        };
        requestAnimationFrame(settle);
        setTimeout(settle, 250);
      });
    }
  };
  // Arrival vegetation lane: the grass/flowers/trees around a teleport or boot
  // destination are the player's immediate surroundings, so they follow the
  // destination exhibit — ahead of far tile detail and background scenery.
  // Quiet windows hard-gate on the ring settling (the whole city fill), which
  // is exactly the inversion this lane exists to break; entries outside the
  // destination's ring keep the ordinary background admission.
  const ARRIVAL_VEGETATION_WINDOW_MS = 60_000;
  let arrivalFocus: { x: number; z: number; atMs: number } | null = null;
  // Bumped on every arrival: parked background admissions watch it so a new
  // destination can interrupt a quiet-window wait instead of hiding behind it.
  let arrivalFocusEpoch = 0;
  const noteArrivalFocus = (x: number, z: number): void => {
    arrivalFocus = { x, z, atMs: performance.now() };
    arrivalFocusEpoch++;
  };
  const onArrivalVegetationLane = (registration: {
    x: number;
    z: number;
    loadDistance: number;
  }): boolean => {
    if (!arrivalFocus) return false;
    if (performance.now() - arrivalFocus.atMs > ARRIVAL_VEGETATION_WINDOW_MS) return false;
    return (
      Math.hypot(arrivalFocus.x - registration.x, arrivalFocus.z - registration.z) <=
      registration.loadDistance
    );
  };
  siteFoliage = new SiteFoliageStreamer({
    scene,
    admit: async (registration, eligibleSince) => {
      await optionalSiteConstructionIdle();
      // Destination-near vegetation starts right behind the exhibit instead of
      // waiting out a quiet window the post-arrival streaming never opens.
      if (onArrivalVegetationLane(registration)) return;
      // Single build slot: if an arrival lands while this background entry is
      // parked, yield the slot so the destination's own vegetation can start.
      const epochAtPark = arrivalFocusEpoch;
      let admissionSettled = false;
      const interrupt = (async () => {
        while (!admissionSettled && arrivalFocusEpoch === epochAtPark) {
          await presentationFrameOrTimeout();
        }
      })();
      try {
        await Promise.race([
          waitForWorldBackgroundWindow(
            700,
            eligibleSince > 0 ? eligibleSince + OPTIONAL_SITE_STARVATION_CAP_MS : Infinity
          ),
          interrupt
        ]);
      } finally {
        admissionSettled = true;
      }
      if (arrivalFocusEpoch !== epochAtPark) {
        if (onArrivalVegetationLane(registration)) return;
        throw new SiteFoliageYieldError();
      }
    },
    // The compile admission needs the same treatment as build admission: an
    // uncapped quiet window never opens for a player who keeps moving, and an
    // exhibit that started constructing meanwhile takes the GPU first.
    prepare: (label, root, registration) =>
      onArrivalVegetationLane(registration)
        ? prepareOptionalRoot(label, root, async () => {
            await optionalSiteConstructionIdle();
          }, priorityCompile)
        : prepareOptionalRoot(label, root, async () => {
            await optionalSiteConstructionIdle();
            await waitForWorldBackgroundWindow(700, performance.now() + OPTIONAL_SITE_STARVATION_CAP_MS);
          })
  });
  siteFoliage.setVisible(getFoliageOn());
  const coronaFoliageRules = {
    hash: coronaHash2,
    inDogPark: (x: number, z: number) => coronaPointInPolygon(x, z, CORONA_DOG_PARK),
    distanceToTrails: coronaDistanceToTrails
  };
  // Each exhibit-foliage entry names the optional site (zone) it belongs to.
  // Under a zone allowlist only the matching zone's entries register at boot;
  // the rest are held and registered by liftZoneRestriction() at wake.
  const siteFoliageRegistrations: Array<{
    zone: OptionalSiteId;
    entry: Parameters<SiteFoliageStreamer["register"]>[0];
  }> = [
    {
      zone: "lands-end",
      entry: {
        id: "lands-end-cypress",
        x: LANDS_END_CENTER.x,
        z: LANDS_END_CENTER.z,
        loadDistance: 1500,
        unloadDistance: 2000,
        build: async () => (await import("../../world/landsEnd/vegetation")).createLandsEndFoliage(map)
      }
    },
    {
      zone: "beach-pianist",
      entry: {
        id: "beach-pianist-grove",
        x: BEACH_PIANIST_CENTER.x,
        z: BEACH_PIANIST_CENTER.z,
        loadDistance: 950,
        unloadDistance: 1250,
        build: async () =>
          (await import("../../world/beachPianist/vegetation")).createBeachPianistFoliage(map)
      }
    },
    {
      zone: "corona",
      entry: {
        id: "corona-trees",
        x: CORONA_HEIGHTS_SUMMIT.x,
        z: CORONA_HEIGHTS_SUMMIT.z,
        loadDistance: 1500,
        unloadDistance: 2000,
        build: async () =>
          (await import("../../world/coronaHeights/vegetation")).createCoronaHeightsFoliage(
            map,
            coronaFoliageRules,
            ["trees"]
          )
      }
    },
    {
      zone: "corona",
      entry: {
        id: "corona-groundcover",
        x: CORONA_HEIGHTS_SUMMIT.x,
        z: CORONA_HEIGHTS_SUMMIT.z,
        loadDistance: 650,
        unloadDistance: 950,
        build: async () =>
          (await import("../../world/coronaHeights/vegetation")).createCoronaHeightsFoliage(
            map,
            coronaFoliageRules,
            ["groundcover"]
          )
      }
    }
  ];
  const deferredFoliageRegistrations = siteFoliageRegistrations.filter((registration) => {
    if (zoneAllowed(registration.zone)) {
      siteFoliage!.register(registration.entry);
      return false;
    }
    return true;
  });

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
    "hang-gliding": true,
    corona: true,
    "lands-end": true,
    "wave-organ": true,
    "sutro-baths": true,
    pup: true,
    "fort-mason-ensemble": true,
    "beach-pianist": true
  };
  let optionalSitePerfGating = false;
  const OPTIONAL_SITE_GATE_ID: Partial<Record<OptionalSiteId, string>> = {
    goldman: "pickleball",
    archery: "archery",
    palace: "palace-reverie",
    afterlight: "afterlight",
    "hang-gliding": "hang-gliding",
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
      case "fort-mason-ensemble":
        if (!on && fortMasonEnsemble) fortMasonEnsemble.root.visible = false;
        break;
      case "palace":
        if (!on && palaceReverie) palaceReverie.root.visible = false;
        break;
      case "afterlight":
        if (!on && afterlight) afterlight.root.visible = false;
        break;
      case "hang-gliding":
        if (!on && hangGliding) hangGliding.root.visible = false;
        break;
      case "corona":
        if (!on && coronaHeights) coronaHeights.group.visible = false;
        break;
      case "lands-end":
        if (!on && landsEnd) landsEnd.group.visible = false;
        break;
      case "wave-organ":
        if (!on && waveOrgan) waveOrgan.group.visible = false;
        break;
      case "beach-pianist":
        beachPianist?.setPerfSuppressed(!on);
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
      case "fort-mason-ensemble":
        return {
          runtime: fortMasonEnsemble?.root.visible ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(fortMasonEnsemble?.root)
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
      case "hang-gliding":
        return {
          runtime: hangGliding?.phase === "flying" || hangGliding?.phase === "result" ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(hangGliding?.root)
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
      case "wave-organ":
        return {
          runtime: waveOrgan?.group.visible ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(waveOrgan?.group)
        };
      case "beach-pianist":
        return {
          runtime: beachPianist?.group.visible ? "ACTIVE" : "SLEEP",
          sceneState: optionalSiteSceneState(beachPianist?.group)
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
    const controller = new AbortController();
    site.controller = controller;
    const { stage, waitStage, compile } = optionalSiteStagesFor(site, controller.signal);
    // Destination-lane sites do not wait behind the serialized background
    // queue: an earlier site parked at a quiet-window admission (or mid-warm
    // behind the reveal blocker) must never delay the exhibit the player is
    // actively traveling to. Their promise still lands on the queue below, so
    // background sites keep serializing behind them.
    const admissionQueue = site.priority ? Promise.resolve() : optionalSiteQueue;
    const run = admissionQueue.then(async () => {
      await revealedPromise;
      if (controller.signal.aborted) throw controller.signal.reason ?? optionalSiteAbortError();
      // Destination-lane sites start at once so their chunk fetch can overlap
      // the travel cover; background sites wait for the quiet window and
      // re-check residency here.
      if (!site.priority) await stage();
      if (!site.forced && !site.priority && site.available?.() === false) {
        throw optionalSiteAbortError();
      }
      site.state = "loading";
      console.info(`[lazy-site] ${site.label} loading…`);
      await site.load({ stage, waitStage, compile, signal: controller.signal });
      site.state = "ready";
      console.info(`[lazy-site] ${site.label} ready`);
      applyOptionalSitePerfGate(site);
    }).catch((error) => {
      if (isAbortError(error) || controller.signal.aborted) {
        site.state = "dormant";
      } else {
        site.state = "failed";
        console.warn(`[lazy-site] ${site.label} unavailable:`, error);
      }
    });
    site.promise = run.finally(() => {
      if (site.controller === controller) site.controller = null;
      site.priority = false;
      if (site.state !== "ready") site.forced = false;
      if (site.state === "dormant") {
        site.promise = null;
        site.eligibleSince = 0;
      }
    });
    optionalSiteQueue = site.promise;
    return site.promise;
  };

  const ensureOptionalWorldSite = (id: OptionalSiteId): Promise<void> => {
    const site = optionalWorldSites.find((candidate) => candidate.id === id);
    return site ? requestOptionalWorldSite(site, true) : Promise.resolve();
  };

  // Distance unload: every optional site owns a complete teardown, so leaving
  // an exhibit's 1 km residency ring returns the world to its pre-approach
  // state. A site the streaming panel force-loaded is pinned until its toggle
  // releases it.
  const OPTIONAL_SITE_UNLOADERS: Record<OptionalSiteId, () => void> = {
    goldman: teardownGoldman,
    "fort-mason-ensemble": () => {
      fortMasonEnsemble?.dispose();
      fortMasonEnsemble = null;
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    },
    palace: () => {
      optionalSiteGateRegistrations.palace?.dispose();
      delete optionalSiteGateRegistrations.palace;
      palaceReverie?.dispose();
      palaceReverie = null;
      refreshOptionalSiteDebug();
    },
    afterlight: () => {
      optionalSiteGateRegistrations.afterlight?.dispose();
      delete optionalSiteGateRegistrations.afterlight;
      if (afterlight) {
        afterlight.root.removeFromParent();
        afterlight.dispose();
        afterlight = null;
      }
      refreshOptionalSiteDebug();
    },
    "hang-gliding": () => {
      optionalSiteGateRegistrations["hang-gliding"]?.dispose();
      delete optionalSiteGateRegistrations["hang-gliding"];
      hangGliding?.dispose();
      hangGliding = null;
      refreshOptionalSiteDebug();
    },
    archery: () => {
      optionalSiteGateRegistrations.archery?.dispose();
      delete optionalSiteGateRegistrations.archery;
      archery?.dispose();
      archery = null;
      refreshOptionalSiteDebug();
    },
    pup: () => {
      optionalSiteGateRegistrations.pup?.dispose();
      delete optionalSiteGateRegistrations.pup;
      pup?.dispose();
      pup = null;
      refreshOptionalSiteDebug();
    },
    corona: () => {
      coronaHeights?.dispose();
      coronaHeights = null;
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    },
    "lands-end": () => {
      landsEnd?.dispose();
      landsEnd = null;
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    },
    "wave-organ": () => {
      waveOrgan?.dispose();
      waveOrgan = null;
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    },
    "beach-pianist": () => {
      beachPianist?.dispose();
      beachPianist = null;
      sky.invalidateStaticShadows();
      refreshOptionalSiteDebug();
    },
    "sutro-baths": () => {
      sutroBaths?.dispose();
      sutroBaths = null;
      refreshOptionalSiteDebug();
    }
  };

  const unloadOptionalWorldSite = (site: OptionalWorldSite): void => {
    const unloader = OPTIONAL_SITE_UNLOADERS[site.id];
    if (!unloader || site.state !== "ready") return;
    unloader();
    site.state = "dormant";
    site.promise = null;
    site.priority = false;
    site.eligibleSince = 0;
    console.info(`[lazy-site] ${site.label} unloaded (left residency)`);
  };

  /** Arrival participant (fire-and-forget): retire in-flight sites the new
   * destination makes irrelevant and put the destination's own exhibit on the
   * priority lane. Never awaited — the travel cover must not wait on it. */
  const reprioritizeOptionalSitesForArrival = (
    destination: Readonly<{ x: number; z: number }>
  ): void => {
    // Both teleports and the boot spawn route through here, so this is the one
    // place the arrival vegetation lane learns its focus.
    noteArrivalFocus(destination.x, destination.z);
    for (const site of optionalWorldSites) {
      const destDistance = Math.hypot(destination.x - site.x, destination.z - site.z);
      const inFlight = site.state === "queued" || site.state === "loading";
      if (inFlight && !site.forced && destDistance > OPTIONAL_SITE_RECHECK_RADIUS) {
        site.controller?.abort(optionalSiteAbortError());
      }
    }
    let nearest: OptionalWorldSite | null = null;
    let nearestDistance = OPTIONAL_SITE_APPROACH_RADIUS;
    for (const site of optionalWorldSites) {
      if (site.state === "ready" || site.state === "failed") continue;
      if (!zoneAllowed(site.id)) continue;
      if (!optionalSitePerfAllowed(site.id)) continue;
      if (site.available?.() === false) continue;
      const destDistance = Math.hypot(destination.x - site.x, destination.z - site.z);
      if (destDistance <= nearestDistance) {
        nearest = site;
        nearestDistance = destDistance;
      }
    }
    if (nearest) {
      nearest.priority = true;
      void requestOptionalWorldSite(nearest);
    }
  };

  const updateOptionalWorldSites = (): void => {
    if (!getRevealed() || worldArrival.active) return;
    const now = performance.now();
    for (const site of optionalWorldSites) {
      const distance = optionalSiteDistance(site);
      // Ordinary travel out of residency: retire a ready site with a teardown
      // (hysteresis: load ≤ 500 m, unload ≥ 1 km) and abort an in-flight build
      // the player has clearly walked away from.
      if (site.state === "ready" && !site.forced && distance >= OPTIONAL_SITE_UNLOAD_RADIUS) {
        const runtime = optionalSiteRuntimeState(site).runtime;
        const busy = runtime === "ACTIVE" || runtime === "DETAIL" ||
          (site.id === "goldman" && (pickleballController?.playing ?? false));
        if (!busy) unloadOptionalWorldSite(site);
      } else if (
        (site.state === "queued" || site.state === "loading") &&
        !site.forced && !site.priority &&
        distance > OPTIONAL_SITE_RECHECK_RADIUS
      ) {
        site.controller?.abort(optionalSiteAbortError());
      } else if (site.state === "dormant") {
        // Starvation cap anchor: first moment the player is inside the
        // approach radius. Cleared when they wander back out.
        if (distance <= OPTIONAL_SITE_APPROACH_RADIUS) {
          if (site.eligibleSince === 0) site.eligibleSince = now;
        } else {
          site.eligibleSince = 0;
        }
      }
    }
    // Sutro owns an internal, closer GPU gate whose promise is intentionally
    // private. Treat its observable warmup as render-busy before admitting the
    // neighboring Lands End site to this serialized scheduler.
    if (sutroBaths?.debugState().nearEffectsLoading) return;
    if (optionalWorldSites.some((site) => site.state === "queued" || site.state === "loading")) return;
    let nearest: OptionalWorldSite | null = null;
    let nearestDistanceSq = OPTIONAL_SITE_APPROACH_RADIUS * OPTIONAL_SITE_APPROACH_RADIUS;
    for (const site of optionalWorldSites) {
      if (site.state !== "dormant") continue;
      if (!zoneAllowed(site.id)) continue;
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

  // Boot arrivals bypass the WorldArrivalCoordinator (they own the
  // "boot-arrival" hold), so give the spawn landmark's exhibit the same
  // priority lane the moment the world reveals.
  void revealedPromise.then(() => {
    reprioritizeOptionalSitesForArrival({ x: player.position.x, z: player.position.z });
  });

  const liftZoneRestriction = (): void => {
    if (!zoneRestriction) return;
    zoneRestriction = null;
    for (const registration of deferredFoliageRegistrations.splice(0)) {
      siteFoliage?.register(registration.entry);
    }
  };

  return {
    update: updateOptionalWorldSites,
    applyPerfGates: () => {
      if (optionalSitePerfGating) applyAllOptionalSitePerfGates();
    },
    ensure: ensureOptionalWorldSite,
    reprioritizeForArrival: reprioritizeOptionalSitesForArrival,
    perfAllowed: optionalSitePerfAllowed,
    liftZoneRestriction,
    // renderIdle's site half: no site queued/loading and Sutro's private close-
    // water GPU gate is quiet. main ANDs this with modulesReady.
    streamingIdle: () =>
      !optionalWorldSites.some(
        (site) => site.state === "queued" || site.state === "loading"
      ) && !(sutroBaths?.debugState().nearEffectsLoading ?? false),
    list: optionalWorldSites,
    get siteFoliage() {
      return siteFoliage;
    }
  };
}
