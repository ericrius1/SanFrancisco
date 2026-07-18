// Japanese Tea Garden wiring. Extracted from main.ts per
// docs/MAIN_DECOMPOSITION.md: the region module itself
// (src/world/japaneseTeaGarden/) stays put; this owns the destination
// first-approach load, the baked-building swap, the rake/paint/water delegates,
// and the per-frame update/interact/project calls. The garden is threaded
// through paintballs (water impacts), net (rake stamps), the minigame session
// (raking), fetchBall (pond bottom), and setFoliageVisible — main keeps those
// call sites but routes them through this controller's methods, which
// null-check the null-until-approached site internally.
import { TEA_GARDEN_SUPPRESSED_BUILDINGS } from "../../world/japaneseTeaGarden/layout";
import type * as THREE from "three/webgpu";
import type { WorldMap } from "../../world/heightmap";
import type { TileStreamer } from "../../world/tiles";
import type { Physics } from "../../core/physics";
import type { Player } from "../../player/player";
import type { HUD } from "../../ui/hud";
import type { Net } from "../../net/net";
import type { RemotePlayers } from "../../net/remotes";
import type { DebugPanel } from "../../ui/debug";
import type { FetchBall } from "../../gameplay/fetchBall";
import type { Sky } from "../../world/sky";
import type { BallImpactAudio, createNatureSoundscape } from "../../audio";
import type { GardenRakeMotion } from "../../player/gardenRake";
import type { PaintWaterImpact, PaintWaterSegment } from "../../fx/paintball";

type JapaneseTeaGarden = import("../../world/japaneseTeaGarden").JapaneseTeaGarden;
type Nature = ReturnType<typeof createNatureSoundscape>;

const TEA_GARDEN_WAKE_DISTANCE = 700;

export function createTeaGardenController({
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
  getFetchBall,
  getFoliageOn,
  autoStartHiroTour,
  entrance,
  markLazyRegion,
  waitForWorldBackgroundWindow,
  nextPresentationFrame,
  waitForAbortable,
  onDebugChanged
}: {
  map: WorldMap;
  renderer: THREE.WebGPURenderer;
  physics: Physics;
  nature: Nature;
  scene: THREE.Scene;
  camera: THREE.Camera;
  sky: Sky;
  tiles: TileStreamer;
  hud: HUD;
  net: Net;
  remotes: RemotePlayers;
  player: Player;
  debugPanel: DebugPanel;
  ballImpactAudio: BallImpactAudio;
  /** fetchBall is built after Corona Heights — late-bound for the rack's free-ball visitor. */
  getFetchBall: () => FetchBall | null;
  getFoliageOn: () => boolean;
  autoStartHiroTour: boolean;
  entrance: Readonly<{ x: number; z: number }>;
  markLazyRegion: (region: string, phase: string) => void;
  waitForWorldBackgroundWindow: (extraQuietMs?: number, deadline?: number) => Promise<void>;
  nextPresentationFrame: () => Promise<void>;
  waitForAbortable: <T>(promise: Promise<T>, signal?: AbortSignal) => Promise<T>;
  /** Refresh __sf.japaneseTeaGarden / teaGardenBuildingSwapState after a change. */
  onDebugChanged: () => void;
}): {
  ensureEssential: (signal?: AbortSignal) => Promise<void>;
  maybeWakeDeferred: (pos: Readonly<{ x: number; z: number }>) => void;
  update: (
    dt: number,
    elapsed: number,
    renderPos: THREE.Vector3,
    frameCamera: THREE.Camera,
    mode: Player["mode"],
    velocity: THREE.Vector3
  ) => void;
  interact: (renderPos: THREE.Vector3, mode: Player["mode"]) => boolean;
  project: (frameCamera: THREE.Camera) => void;
  paintWater: (impact: PaintWaterImpact) => boolean;
  paintWaterSegment: (segment: Readonly<PaintWaterSegment>) => boolean;
  containsWater: (x: number, z: number) => boolean;
  queueRakeStamp: (stamp: Parameters<JapaneseTeaGarden["queueRakeStamp"]>[0]) => boolean;
  resetSand: () => void;
  isRaking: () => boolean;
  releaseForNavigation: () => void;
  setFoliageVisible: (visible: boolean) => void;
  rakeMotion: () => Readonly<GardenRakeMotion> | null;
  restoreBuildings: () => void;
  buildingSwapState: () => {
    claimed: boolean;
    buildings: Array<{ key: string; index: number; suppressed: boolean }>;
  };
  current: () => JapaneseTeaGarden | null;
} {
  let japaneseTeaGarden: JapaneseTeaGarden | null = null;
  let teaGardenPaintWater: ((impact: PaintWaterImpact) => boolean) | null = null;
  let teaGardenPaintWaterSegment: ((segment: Readonly<PaintWaterSegment>) => boolean) | null = null;
  let localGardenRakeMotion: Readonly<GardenRakeMotion> | null = null;
  let teaGardenModPromise: Promise<typeof import("../../world/japaneseTeaGarden")> | null = null;
  let teaGardenEssentialPromise: Promise<void> | null = null;
  let teaGardenOptionalPromise: Promise<void> | null = null;
  let teaGardenBuildingsClaimed = false;
  let wokeDeferred = false;

  const teaGardenBuildingSwapState = () => ({
    claimed: teaGardenBuildingsClaimed,
    buildings: TEA_GARDEN_SUPPRESSED_BUILDINGS.map((building) => ({
      key: building.key,
      index: building.index,
      suppressed: tiles.isBuildingSuppressed(building.key, building.index)
    }))
  });

  const claimTeaGardenBuildings = () => {
    if (teaGardenBuildingsClaimed) return;
    for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
      tiles.suppressBuilding(building.key, building.index);
    }
    teaGardenBuildingsClaimed = true;
    markLazyRegion("tea-garden", "baked-swap");
  };
  const restoreTeaGardenBuildings = () => {
    if (!teaGardenBuildingsClaimed) return;
    for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
      tiles.unsuppressBuilding(building.key, building.index);
    }
    teaGardenBuildingsClaimed = false;
  };

  const startTeaGardenOptionalPreparation = (site: JapaneseTeaGarden) => {
    if (teaGardenOptionalPromise) return;
    teaGardenOptionalPromise = (async () => {
      markLazyRegion("tea-garden", "optional-details-wait");
      await waitForWorldBackgroundWindow();
      markLazyRegion("tea-garden", "optional-trees-wait");
      await Promise.all([
        site.prepareOptionalDetails(async (detailsGroup) => {
          markLazyRegion("tea-garden", "optional-detail-compile-start");
          detailsGroup.updateMatrixWorld(true);
          await renderer.compileAsync(detailsGroup, camera, scene);
          markLazyRegion("tea-garden", "optional-detail-compile-end");
        }),
        site.prepareOptionalFoliage(async (treeGroup) => {
          // Optional enrichment retains the movement/arrival quiet policy;
          // architecture, Hiro, shrubs, grass and water are already live.
          markLazyRegion("tea-garden", "optional-tree-compile-start");
          treeGroup.updateMatrixWorld(true);
          await renderer.compileAsync(treeGroup, camera, scene);
          markLazyRegion("tea-garden", "optional-tree-compile-end");
        })
      ]);
      await site.ready;
      markLazyRegion("tea-garden", "optional-ready");
      if (getFoliageOn()) sky.invalidateStaticShadows("all");
    })().catch((error) => {
      console.warn("[tea-garden] optional foliage preparation failed:", error);
    });
  };

  const ensureTeaGardenEssential = (signal?: AbortSignal): Promise<void> => {
    if (!teaGardenEssentialPromise) {
      const attempt = (async () => {
        markLazyRegion("tea-garden", "requested");
        teaGardenModPromise ??= import("../../world/japaneseTeaGarden");
        const teaGardenMod = await teaGardenModPromise;
        markLazyRegion("tea-garden", "chunk-ready");
        await nextPresentationFrame();

        let site: JapaneseTeaGarden | null = null;
        try {
          site = teaGardenMod.createJapaneseTeaGarden(map, {
            renderer,
            physics,
            nature,
            dialogueParent: document.body,
            ballSource: {
              visitFreeBalls: (visitor) => getFetchBall()?.visitFreeBalls(visitor)
            },
            onBallWaterImpact: (x, y, z, speed) => ballImpactAudio.water(x, y, z, speed),
            onCarryRake: (rake) => {
              if (!rake) localGardenRakeMotion = null;
              player.setGardenRakeTool(rake);
            },
            onRakeMotion: (motion) => {
              localGardenRakeMotion = motion;
              player.setGardenRakeMotion(motion);
            },
            onRakeStamp: (stamp) => net.sendRakeStamp(stamp),
            notify: (message, seconds) => hud.message(message, seconds)
          });
          site.deferOptionalFoliage();
          site.deferOptionalDetails();
          japaneseTeaGarden = site;
          net.replayRakeStamps();
          teaGardenPaintWater = (impact) => site?.paintWater(impact) ?? false;
          teaGardenPaintWaterSegment = (segment) => site?.paintWaterSegment(segment) ?? false;
          debugPanel.registerFeatureTuning(site.tuningDescriptor());
          site.setFoliageVisible(getFoliageOn());
          site.update(0, performance.now() / 1000, player.renderPosition, camera, player.mode);
          markLazyRegion("tea-garden", "constructed");
          onDebugChanged();

          const awakeBeforeCompile = site.group.visible;
          site.group.visible = true;
          site.group.updateMatrixWorld(true);
          try {
            markLazyRegion("tea-garden", "essential-compile-start");
            await site.prepareEssential((root) => renderer.compileAsync(root, camera, scene));
            markLazyRegion("tea-garden", "essential-compile-end");
          } catch (error) {
            // Compilation is a presentation optimization; the live renderer can
            // still compile a valid fallback on the first authored frame.
            console.warn("[tea-garden] essential compile failed:", error);
          } finally {
            site.group.visible = awakeBeforeCompile;
          }

          scene.add(site.group);
          // The rack's visible templates have now warmed the rake material
          // pipelines. Only at this local first-use boundary may remote rake
          // presence instantiate matching geometry in the live scene.
          remotes.setGardenRakeFactory(teaGardenMod.createGardenRakeTool);
          site.update(0, performance.now() / 1000, player.renderPosition, camera, player.mode);
          if (site.group.visible) claimTeaGardenBuildings();
          if (autoStartHiroTour) site.interact(player.renderPosition, player.mode);
          markLazyRegion("tea-garden", "essential-attached");
          startTeaGardenOptionalPreparation(site);
        } catch (error) {
          site?.dispose();
          if (japaneseTeaGarden === site) japaneseTeaGarden = null;
          if (japaneseTeaGarden === null) teaGardenPaintWater = null;
          if (japaneseTeaGarden === null) teaGardenPaintWaterSegment = null;
          restoreTeaGardenBuildings();
          onDebugChanged();
          throw error;
        }
      })();
      teaGardenEssentialPromise = attempt;
      // A transient chunk/construction failure must not poison the one-shot
      // cache forever. The baked buildings remain live, and a later approach
      // gets a genuine retry instead of awaiting the same rejected promise.
      void attempt.catch(() => {
        if (teaGardenEssentialPromise !== attempt) return;
        teaGardenEssentialPromise = null;
        teaGardenModPromise = null;
      });
    }
    return waitForAbortable(teaGardenEssentialPromise, signal);
  };

  return {
    ensureEssential: ensureTeaGardenEssential,
    // First-approach proximity gate (mirrors the sibling region wakes). One-shot;
    // ensureEssential is idempotent, so a prior arrival-triggered load is harmless.
    maybeWakeDeferred: (pos) => {
      if (wokeDeferred) return;
      if (
        Math.hypot(pos.x - entrance.x, pos.z - entrance.z) >= TEA_GARDEN_WAKE_DISTANCE
      ) return;
      wokeDeferred = true;
      void ensureTeaGardenEssential().catch((error) =>
        console.warn("[tea-garden] first-approach construction failed:", error)
      );
    },
    update: (dt, elapsed, renderPos, frameCamera, mode, velocity) => {
      japaneseTeaGarden?.update(dt, elapsed, renderPos, frameCamera, mode, velocity);
      if (
        japaneseTeaGarden?.group.parent === scene &&
        japaneseTeaGarden.debugState().awake
      ) claimTeaGardenBuildings();
    },
    interact: (renderPos, mode) =>
      japaneseTeaGarden?.interact(renderPos, mode) ?? false,
    project: (frameCamera) => {
      japaneseTeaGarden?.project(frameCamera);
    },
    paintWater: (impact) => teaGardenPaintWater?.(impact) ?? false,
    paintWaterSegment: (segment) => teaGardenPaintWaterSegment?.(segment) ?? false,
    containsWater: (x, z) => japaneseTeaGarden?.containsWater(x, z) ?? false,
    queueRakeStamp: (stamp) => japaneseTeaGarden?.queueRakeStamp(stamp) ?? false,
    resetSand: () => {
      japaneseTeaGarden?.resetSand();
    },
    isRaking: () => japaneseTeaGarden?.isRaking() ?? false,
    releaseForNavigation: () => {
      japaneseTeaGarden?.releaseForNavigation();
    },
    setFoliageVisible: (visible) => {
      japaneseTeaGarden?.setFoliageVisible(visible);
    },
    rakeMotion: () => localGardenRakeMotion,
    restoreBuildings: restoreTeaGardenBuildings,
    buildingSwapState: teaGardenBuildingSwapState,
    current: () => japaneseTeaGarden
  };
}
