import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import type { AuthoredRegionStreamer } from "../authoredRegions";
import { registerSwimVolume } from "../swimVolumes";
import {
  SUTRO_BATHS,
  SUTRO_DRAIN,
  SUTRO_GROTTO,
  SUTRO_GROTTO_DROP,
  SUTRO_GROTTO_RISE,
  distanceToSutroBaths,
  distanceToSutroDrain,
  distanceToSutroWater,
  isInsideSutroPool,
  sutroGrottoContains,
  sutroGrottoPoolContains,
  sutroHallWallInset,
  sutroLocalToWorld,
  sutroPoolBounds,
  sutroWalkSurfaceY
} from "./layout";
import { createSutroDrain } from "./drain";
import type { SutroGrotto } from "./grotto";
import { SUTRO_BATHS_TUNING, SUTRO_TUNING_FOLDERS } from "./tuning";
import { createSutroBathsVegetation } from "./vegetation";
import { createSutroBathers } from "./bathers";
import { createSutroParlour } from "./parlour";
import { createSutroTimberGallery } from "./timberGallery";
import { createSutroPavilionClock } from "./pavilionClock";
import type { SutroBathsSteam } from "./steam";
import {
  createSutroBathsStaticWater,
  type SutroBathsStaticWater
} from "./staticWater";
import { createSutroStaticAmbience } from "./staticAmbience";
import { sutroHallCaustics } from "../sutroHallCaustics";
import {
  createSutroTwilight,
  type SutroSkyClock,
  type SutroTwilightState
} from "./twilight";

const WAKE_DISTANCE = 760;
const SLEEP_DISTANCE = 900;
const STEAM_LOAD_DISTANCE = 170;

/**
 * Indoor-camera latch, in metres from the hall wall (see `isPlayerInside`).
 * Enter just past the wall; release only well clear of the building, so the
 * threshold, the spiral's outer treads and the glass-side deck all stay indoors.
 */
const INDOOR_ENTER_INSET = 0.6;
const INDOOR_EXIT_INSET = -3.2;

export type SutroBathsPlayerPosition = { x: number; y?: number; z: number };

export type SutroBathsStats = {
  architectureMeshes: number;
  architectureInstances: number;
  roofRibs: number;
  glassPanels: number;
  lamps: number;
  physicsBodies: number;
  trees: number;
  shrubs: number;
  planters: number;
  flowers: number;
  bathers: number;
  conversations: number;
  parlourTables: number;
  parlourLamps: number;
  galleryBoards: number;
  galleryArtworks: number;
};

export type SutroBathsDebugState = {
  awake: boolean;
  disposed: boolean;
  foliageVisible: boolean;
  distanceToBaths: number;
  nearEffectsLoading: boolean;
  nearEffectsLoaded: boolean;
  nearEffectsFailed: boolean;
  water: ReturnType<SutroBathsStaticWater["debugState"]>;
  steam: SutroBathsSteam["stats"] | null;
  twilight: SutroTwilightState;
  /** Decimal hour the pavilion clock's hands are actually showing. */
  clockHour: number;
  /** The sunken gallery: its own lazy gate, and whether anyone is down there. */
  grottoLoading: boolean;
  grottoLoaded: boolean;
  grottoFailed: boolean;
  playerInGrotto: boolean;
  distanceToDrain: number;
};

/**
 * Where the drain (or the upwelling under it) is putting the player.
 *
 * Deliberately NOT a teleport contract — no label, no cover, no place history.
 * Both ends of the shaft are a continuous swim: the visitor goes into the hole
 * and comes out of the ceiling still falling, and the cut lands inside a dark
 * bore where there is nothing to see it happen against. `heading` is omitted
 * for exactly that reason — turning the body would be the one thing that gave
 * the cut away.
 */
export type SutroBathsRelocation = {
  x: number;
  y: number;
  z: number;
  heading?: number;
};

export type SutroBaths = {
  group: THREE.Group;
  ready: Promise<void>;
  setFoliageVisible(visible: boolean): void;
  /** Debug streaming panel: force sleep and block proximity wake while on. */
  setPerfSuppressed(on: boolean): void;
  update(
    dt: number,
    time: number,
    player: SutroBathsPlayerPosition,
    camera: THREE.Camera,
    gust: number
  ): void;
  isPlayerInside(player: SutroBathsPlayerPosition): boolean;
  /**
   * E, standing in the ring of falling water: ride it back up to the plunge.
   * Returns true when it consumed the press, so the app's interaction chain can
   * fall through to whatever else is nearby when it did not.
   */
  tryInteract(player: SutroBathsPlayerPosition, playerMode: string): boolean;
  /**
   * Is the visitor down in the sunken gallery? A separate question from
   * `isPlayerInside`, because it has a separate answer for the camera: the hall
   * is a 152 m room with space for any shot, and the gallery is a corridor.
   */
  isPlayerInGrotto(player: SutroBathsPlayerPosition): boolean;
  /**
   * One-shot lazy-build floor handoff. Returns the restored deck height the
   * first time a walking visitor is inside the hall footprint, so main can lift
   * a capsule that the terrain-burying overlay left stranded beneath the deck.
   * Returns null once consumed, when asleep, or for non-walking embodiments.
   */
  takeFloorHandoffHeight(player: SutroBathsPlayerPosition, playerMode: string): number | null;
  tuningDescriptor(): DebugFeatureTuningRegistration;
  readonly stats: SutroBathsStats;
  debugState(): SutroBathsDebugState;
  dispose(): void;
};

export type SutroBathsOptions = {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  physics?: Physics;
  authoredRegions?: AuthoredRegionStreamer;
  /**
   * The world clock. Handed in (rather than imported) so the out-of-time pocket
   * can take the sky over while the visitor is inside and hand it straight back
   * on the way out. Omit it and the hall simply keeps the world's own light.
   */
  sky?: SutroSkyClock | null;
  /**
   * Called when the interior gets deep enough that the outside world is no
   * longer observable through the glass. The compose layer owns the actual
   * levers (tile radii, city detail, the fog cull edge); the site only knows
   * when nobody can see out.
   */
  onExteriorThinned?: (thinned: boolean) => void;
  /**
   * Put the player somewhere, atomically and without a travel cover. The site
   * owns WHERE (the two ends of the drain shaft); the app owns the body. Omit
   * it and the drain is scenery — it still turns, but it never takes anyone.
   */
  relocate?: (pose: SutroBathsRelocation) => void;
  /** For the two nudges this site gives; structural so probes can stub it. */
  hud?: { message(text: string, seconds?: number): void };
};

type MonitorState = {
  steamLoaded: boolean;
  backend: string;
  triangles: number;
  computeDispatches: number;
  simulated: boolean;
  playerDistance: number;
  steamVisible: number;
};

/**
 * Dynamic controller for the Blender-authored restored site. The authored
 * region owns architecture while the local physics tile owns colliders; this lazy module owns only foliage,
 * bathers, lighting controls, lightweight visual water, and steam.
 */
export function createSutroBaths(options: SutroBathsOptions): SutroBaths {
  const group = new THREE.Group();
  group.name = "sutro_baths_restored_1896";
  group.visible = false;

  // Water is an essential part of the authored pools, not a close-range effect.
  // Construct it with the lazy site root so prepareOptionalRoot prewarms its
  // WebGPU pipeline before the root can become visible. Steam stays behind the
  // tighter proximity gate below.
  const water = createSutroBathsStaticWater({
    renderer: options.renderer,
    // The pools mirror the dome's own radiance rather than a second gradient,
    // so the reflection tracks the pocket's sunset->twilight swing for free.
    sky: options.sky ?? null
  });
  const ambience = createSutroStaticAmbience(options.authoredRegions);
  // Shared with the region streamer, which built the node into the hall's
  // materials before this object existed. Fetching the same instance here is
  // what connects those materials to the site's clock.
  const hallCaustics = sutroHallCaustics();
  const vegetation = createSutroBathsVegetation();
  const bathers = createSutroBathers();
  const parlour = createSutroParlour();
  parlour.setLampGlow(0);
  // The inland wall's timber gallery and its pictures. Built here (not in the
  // authored GLB) because it carries textures — see timberGallery.ts.
  const gallery = createSutroTimberGallery();
  gallery.group.visible = false;
  const pavilionClock = createSutroPavilionClock({
    sky: options.sky,
    authoredRegions: options.authoredRegions
  });
  pavilionClock.setTwilight(0);
  const twilight = createSutroTwilight({
    sky: options.sky,
    onExteriorThinned: options.onExteriorThinned
  });
  // The bronze collar in the floor of the great plunge. Cheap, textureless, and
  // built with the site because it is the only clue the room below exists.
  const drain = createSutroDrain();
  /**
   * Everything that is the HALL, under one switch.
   *
   * Thirty-one metres of rock separate the sunken gallery from all of it, so
   * while a visitor is down there the pools, the cast, the parlour, the
   * planting and the drain itself are not merely invisible — they are
   * unreachable by any ray. Retiring the whole branch (and the water sim and
   * steam with it, below) is what pays for the room and its reef.
   */
  const hallLayer = new THREE.Group();
  hallLayer.name = "sutro_baths_hall_layer";
  hallLayer.add(
    ambience.group,
    vegetation.group,
    parlour.group,
    gallery.group,
    pavilionClock.group,
    bathers.group,
    water.group,
    drain.group
  );
  group.add(hallLayer);

  const stats: SutroBathsStats = {
    architectureMeshes: 55,
    architectureInstances: 2191,
    roofRibs: 306,
    glassPanels: 304,
    lamps: 28,
    physicsBodies: 179,
    trees: vegetation.stats.trees,
    shrubs: vegetation.stats.shrubs,
    planters: vegetation.stats.planters,
    flowers: vegetation.stats.flowers,
    // The cast hydrates across frames, so these two are refreshed on read
    // rather than frozen at construction (when exactly one bather exists).
    bathers: bathers.stats.bathers,
    conversations: bathers.stats.talkGroups,
    parlourTables: parlour.stats.tables,
    parlourLamps: parlour.stats.lamps,
    galleryBoards: gallery.stats.boards,
    galleryArtworks: 0
  };
  const liveStats = (): SutroBathsStats => {
    stats.bathers = bathers.stats.bathers;
    stats.conversations = bathers.stats.talkGroups;
    // The hang moved downstairs, and the room it moved to is lazy — so this is
    // zero until somebody has actually been through the drain.
    stats.galleryArtworks = grotto?.stats.artworks ?? 0;
    return stats;
  };

  const monitors: MonitorState = {
    steamLoaded: false,
    backend: "sleeping · not allocated",
    triangles: 0,
    computeDispatches: 0,
    simulated: false,
    playerDistance: Number.POSITIVE_INFINITY,
    steamVisible: 0
  };

  let steam: SutroBathsSteam | null = null;
  let nearEffectsLoading: Promise<void> | null = null;
  let nearEffectsFailed = false;
  let awake = false;
  let foliageVisible = true;
  let distanceToBaths = Number.POSITIVE_INFINITY;
  let distanceToDrain = Number.POSITIVE_INFINITY;
  let disposed = false;
  /** Latched answer to `isPlayerInside` — see the thresholds by that method. */
  let playerInside = false;

  // --- the sunken gallery, and the two ends of the shaft ------------------
  let grotto: SutroGrotto | null = null;
  let grottoLoading: Promise<void> | null = null;
  let grottoFailed = false;
  let inGrotto = false;
  /**
   * The drain has to be LEFT before it will take anyone again, or it would
   * swallow whoever the upwelling had just put back in the middle of the
   * plunge. Armed by distance, not by a timer.
   *
   * The way UP has no such latch, because it is not automatic: you stand in the
   * ring of falling water and press E (`tryInteract`). Going down is something
   * the water does to you; coming back is something you decide.
   */
  let drainArmed = true;
  /** One-shot latch for the "press E" nudge under the fall. */
  let risePrompted = false;
  // The authored region hands terrain ownership to the hall and publishes its
  // deck/basin bodies asynchronously. Keep a lightweight recovery contract
  // armed for the lifetime of the site: it covers both that handoff frame and
  // rare tunnelling through a thin floor, while pool footprints still resolve
  // to the lower basin so visitors can enter the water normally.
  const hasFloorRecovery = options.physics != null;

  // Bathers still move and animate independently; the visual water intentionally
  // has no gameplay wake contract.
  const batherPlayer = new THREE.Object3D();

  // The seven baths are real water to the swim/underwater stack. Registered
  // with the site (not statically) so nothing outside the hall pays for them,
  // and released on dispose so a streamed-out site cannot leave a phantom pool
  // floating over the cliff. The basin is the built floor, not the terrain.
  const releaseSwimVolume = registerSwimVolume({
    id: "sutro-baths-pools",
    surfaceY: SUTRO_BATHS.waterY,
    floorY: SUTRO_BATHS.basinY,
    ...sutroPoolBounds(),
    // A bath is 2.56 m of water on a tiled floor, and NOT the thirty-one metres
    // of rock and gallery under that floor. Without this the sunken room —
    // which is inside the great plunge's own footprint, because that is where
    // the water goes — would be a column of bath to every submersion test in
    // the game, and buoyancy would fire its visitors at the ceiling.
    bottomY: SUTRO_BATHS.basinY - 0.4,
    contains: isInsideSutroPool,
    // …and getting out again. The coping is only a 0.44 m step above the
    // water, but a swimmer has no jump, so without a rim to haul onto every
    // bath is a one-way trip. The authored walk surface already knows what is
    // beside each pool — the deck, or a stair tread where one meets the water.
    climbOutY: sutroWalkSurfaceY
  });

  const syncTuning = () => {
    ambience.applyTuning(SUTRO_BATHS_TUNING.values);
    water.syncTuning();
  };

  const loadNearEffects = (camera: THREE.Camera): void => {
    if (steam || nearEffectsLoading || nearEffectsFailed || disposed) return;
    nearEffectsLoading = import("./steam")
      .then(async (steamModule) => {
        try {
          let nextSteam: SutroBathsSteam | null = null;
          try {
            nextSteam = steamModule.createSutroBathsSteam();
            if (disposed) return;
            syncTuning();
            try {
              // WebGPURenderer compilation can encode render passes while it
              // builds async pipelines. Reveal the detached steam root so
              // Three actually traverses it.
              nextSteam.group.visible = true;
              await options.renderer.compileAsync(nextSteam.group, camera, options.scene);
            } catch (error) {
              console.warn("[sutro-baths] steam render warmup failed:", error);
            } finally {
              nextSteam.group.visible = false;
            }
            if (disposed) return;
            steam = nextSteam;
            nextSteam = null;
            hallLayer.add(steam.group);
            // …but not while the visitor is thirty-one metres under it.
            steam.setEnabled(awake && !inGrotto);
            monitors.steamLoaded = true;
          } finally {
            nextSteam?.dispose();
          }
        } catch (error) {
          // Constructor/import failures are not made safer by allocating the
          // same GPU resources every frame. Rollback above, then latch until a
          // fresh page load can retry with a valid environment.
          nearEffectsFailed = true;
          throw error;
        }
      })
      .catch((error) => {
        console.warn("[sutro-baths] steam unavailable:", error);
      })
      .finally(() => {
        nearEffectsLoading = null;
      });
  };

  /** The two ends of the shaft, in world space. Fixed for the site's lifetime. */
  const grottoDrop = sutroLocalToWorld(SUTRO_GROTTO_DROP.x, SUTRO_GROTTO_DROP.z);
  const grottoRise = sutroLocalToWorld(SUTRO_GROTTO_RISE.x, SUTRO_GROTTO_RISE.z);

  /**
   * Build the room under the drain.
   *
   * Gated on a swimmer getting within thirty metres of the collar, which is the
   * honest boundary for "about to go down there" and leaves plenty of time: a
   * visitor still has to cross that water and dive 2.5 m before the grab can
   * fire. Nothing here is on the site's own load path — the room, its
   * seventeen plates and the whole reef are one dynamic import that a visitor
   * who never gets in the water never makes.
   *
   * Until it lands, the drain reads shut (`setOpen`) and the grab below cannot
   * fire, so there is no window in which the hole leads nowhere.
   */
  const loadGrotto = (camera: THREE.Camera): void => {
    if (grotto || grottoLoading || grottoFailed || disposed) return;
    grottoLoading = import("./grotto")
      .then(async (grottoModule) => {
        let candidate: SutroGrotto | null = null;
        try {
          candidate = grottoModule.createSutroGrotto({ physics: options.physics });
          // Textures first: the covered warm below must compile the FINAL,
          // mapped graphs, or the first frame in the room recompiles under the
          // visitor's feet.
          await candidate.ready;
          if (disposed) return;
          try {
            // WebGPURenderer compilation can encode render passes while it
            // builds async pipelines, so the detached root has to be visible
            // for Three to traverse it.
            candidate.group.visible = true;
            await options.renderer.compileAsync(candidate.group, camera, options.scene);
          } catch (error) {
            console.warn("[sutro-baths] sunken gallery warmup failed:", error);
          } finally {
            candidate.group.visible = false;
          }
          if (disposed) return;
          grotto = candidate;
          candidate = null;
          group.add(grotto.group);
          drain.setOpen(true);
          options.hud?.message("Something turns at the bottom of the great plunge", 3.4);
        } finally {
          candidate?.dispose();
        }
      })
      .catch((error) => {
        // Rebuilding the same failing room every frame makes nothing better.
        grottoFailed = true;
        console.warn("[sutro-baths] sunken gallery unavailable:", error);
      })
      .finally(() => {
        grottoLoading = null;
      });
  };

  /** Hall on top, room below: exactly one of them is ever worth drawing. */
  const setInGrotto = (next: boolean): void => {
    if (inGrotto === next) return;
    inGrotto = next;
    hallLayer.visible = awake && !next;
    if (grotto) grotto.group.visible = next;
    water.setEnabled(awake && !next);
    steam?.setEnabled(awake && !next);
  };

  /** Is the visitor standing in the ring of falling water? */
  const inTheFall = (player: SutroBathsPlayerPosition): boolean =>
    inGrotto &&
    Math.hypot(player.x - grottoRise.x, player.z - grottoRise.z) <= SUTRO_GROTTO_RISE.radius;

  /**
   * Down the drain.
   *
   * The cut itself is one frame inside a dark bore, and the player keeps their
   * facing and their camera through it (see SutroBathsRelocation); what they
   * actually experience is going into a hole and coming out of a ceiling still
   * heading the same way.
   */
  const updateShaft = (player: SutroBathsPlayerPosition, py: number): void => {
    const relocate = options.relocate;
    if (!grotto || !relocate) return;

    if (inGrotto) {
      // The way back is a prompt, not a trapdoor — see `tryInteract`. All this
      // does is offer it, once, the first time somebody wades into the ring.
      const standing = inTheFall(player);
      if (standing && !risePrompted) {
        risePrompted = true;
        options.hud?.message("Press E to ride the water back up", 3.2);
      } else if (!standing) {
        risePrompted = false;
      }
      return;
    }

    if (!drainArmed) {
      if (distanceToDrain > SUTRO_DRAIN.grabRadius + 2.5) drainArmed = true;
      return;
    }
    // Deep enough that they dived for it, and inside the bore.
    if (distanceToDrain <= SUTRO_DRAIN.grabRadius && py <= SUTRO_DRAIN.grabY) {
      setInGrotto(true);
      relocate({ x: grottoDrop.x, y: SUTRO_GROTTO_DROP.y, z: grottoDrop.z });
    }
  };

  // Staged wake. Revealing the whole site in one frame makes that frame pay the
  // first-draw cost of every part at once — render lists, bind groups and buffer
  // uploads for the pools, the cast, the furniture and the planting together —
  // which is a ~300 ms freeze the instant a visitor arrives. Each layer instead
  // joins on its own frame, in the order that matters: the water IS the hall, so
  // it goes first; the people, the parlour and the planting follow over the next
  // three frames, by which point nobody has looked away from the pools yet.
  const wakeStages: readonly (() => boolean)[] = [
    () => {
      water.group.visible = true;
      return false;
    },
    () => {
      parlour.group.visible = true;
      return false;
    },
    () => {
      gallery.group.visible = true;
      return false;
    },
    // The cast comes out a handful at a time — 38 skinned meshes on one frame is
    // 38 first-draw bind-group builds.
    () => bathers.revealSome(5),
    () => {
      if (foliageVisible) vegetation.setVisible(true);
      return false;
    }
  ];
  let wakeStage = 0;

  const setAwake = (next: boolean) => {
    if (awake === next) return;
    awake = next;
    if (next) {
      wakeStage = 0;
      water.group.visible = false;
      parlour.group.visible = false;
      gallery.group.visible = false;
      vegetation.setVisible(false);
    } else {
      // A site that streamed out with a visitor below it must come back as the
      // hall, not as a hidden hall with an orphaned room showing.
      inGrotto = false;
      if (grotto) grotto.group.visible = false;
      drainArmed = true;
      risePrompted = false;
    }
    hallLayer.visible = next;
    group.visible = next;
    water.setEnabled(next);
    steam?.setEnabled(next);
    // A sleeping site must never keep holding the world's clock or the city
    // culled: releasing here covers streaming-out, perf suppression and the
    // debug panel's A/B toggle in one place. The pavilion clock releases with
    // it so the next arrival finds its hands already on the hour rather than
    // winding to it from wherever the last visit left them, and the hall
    // caustics live on streamer-owned materials that outlive this object, so
    // they need the same explicit release — nothing else will zero them.
    if (!next) {
      twilight.release();
      pavilionClock.release();
      hallCaustics.clear();
    }
  };

  let perfSuppressed = false;

  syncTuning();

  // The site is "ready" for the covered warm once its unified foliage has
  // compiled AND the cast is fully built. Both are sliced across frames, so this
  // adds no frozen time — it only means the warm sees every signature once.
  // The gallery's textures are in here so the covered warm compiles the FINAL
  // material graphs: optionalSites.ts awaits this before prepareOptionalRoot.
  const ready = Promise.all([
    gallery.ready,
    vegetation.ready,
    bathers.hydrate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  ]).then(() => undefined);

  return {
    group,
    ready,
    setFoliageVisible(visible) {
      foliageVisible = visible;
      // While the staged wake is still walking down its list, leave the reveal
      // to it: flipping the group on here would hand one frame the very cost
      // the staging exists to spread out.
      if (wakeStage >= wakeStages.length || !visible) vegetation.setVisible(visible);
    },
    /** Debug perf gate: force sleep and block proximity wake while suppressed. */
    setPerfSuppressed(on: boolean) {
      if (perfSuppressed === on) return;
      perfSuppressed = on;
      if (on) setAwake(false);
    },
    update(dt, time, player, camera, gust) {
      if (disposed) return;
      if (perfSuppressed) {
        if (awake) setAwake(false);
        else twilight.release();
        return;
      }
      distanceToBaths = distanceToSutroBaths(player.x, player.z);
      if (!awake && distanceToBaths <= WAKE_DISTANCE) setAwake(true);
      else if (awake && distanceToBaths >= SLEEP_DISTANCE) setAwake(false);

      const waterDistance = distanceToSutroWater(player.x, player.z);
      if (waterDistance <= STEAM_LOAD_DISTANCE) loadNearEffects(camera);
      if (!awake) return;

      const py = player.y ?? SUTRO_BATHS.waterY;

      // --- the drain -------------------------------------------------------
      // Everything about the shaft happens before the hall's own frame, because
      // the very first thing it can decide is that the hall should not draw.
      distanceToDrain = distanceToSutroDrain(player.x, player.z);
      const inTheWater = py < SUTRO_BATHS.waterY + 0.6;
      if (inTheWater && distanceToDrain <= SUTRO_DRAIN.primeRadius) loadGrotto(camera);
      // Quiet from across the hall, turning hard once you are over it.
      drain.setCharge(
        inTheWater || inGrotto
          ? THREE.MathUtils.clamp(1.25 - distanceToDrain / 14, 0.12, 1)
          : 0.1
      );
      drain.update(time);
      // Derive occupancy from where the body actually IS before letting the
      // shaft act. `updateShaft` sets the same latch optimistically on the frame
      // it relocates — it has to, because the `player` it was handed still holds
      // the pre-relocation pose — and this is what stops that optimism from
      // outliving its frame if a relocation is ever refused.
      setInGrotto(grotto !== null && sutroGrottoContains(player.x, py, player.z, 1.5));
      updateShaft(player, py);
      grotto?.update(time);
      // Below the hall there is nothing of the hall to run: the pools, the cast,
      // the parlour and the planting are all behind thirty-one metres of rock.
      if (inGrotto) {
        // The pocket still owns the sky and the far world — more so down here
        // than anywhere, since nothing outside is observable at all.
        twilight.update(dt, player, true);
        grotto?.setTwilight(1);
        return;
      }

      twilight.update(dt, player);
      // One layer per frame until the site is fully present (see wakeStages).
      // A stage that returns true has more to hand out and keeps its turn.
      if (wakeStage < wakeStages.length && !wakeStages[wakeStage]()) wakeStage++;
      ambience.setTwilight(twilight.depth);
      // Water-light on the ironwork. The node lives on the hall's materials,
      // which the region streamer owns, so the site only feeds it the clock and
      // the pocket depth — and zeroes it on sleep, below, so a retired hall
      // cannot keep shimmering.
      hallCaustics.setTime(time);
      hallCaustics.setTwilight(twilight.depth);
      hallCaustics.setStrength(SUTRO_BATHS_TUNING.values.hallCaustics);
      parlour.setLampGlow(twilight.lampGlow);
      gallery.setTwilight(twilight.depth);
      // After twilight.update: the pocket has just written the hour the sky is
      // rendering, and the clock's whole job is to agree with it.
      pavilionClock.setTwilight(twilight.depth);
      pavilionClock.update(dt);
      bathers.setTwilight(twilight.depth);
      water.setTwilight(twilight.depth);
      ambience.update(time, SUTRO_BATHS_TUNING.values);
      if (foliageVisible) vegetation.update(player);

      batherPlayer.position.set(player.x, py, player.z);
      bathers.update(dt, time, batherPlayer);
      water.update(dt, time, player, camera);
      // Steam lives entirely above the waterline, and from under the surface
      // the sheet is an opaque ceiling — so a submerged swimmer must not see
      // plumes composited over it (the shells draw after the sheet by design;
      // see SUTRO_STEAM_RENDER_ORDER).
      steam?.setSubmerged(water.cameraSubmerged);
      steam?.update(dt, time, player, camera, gust);

      monitors.backend = water.stats.backend;
      monitors.triangles = water.stats.triangles;
      monitors.computeDispatches = water.stats.computeDispatches;
      monitors.simulated = water.stats.simulated;
      monitors.playerDistance = water.stats.playerDistance;
      monitors.steamVisible = steam?.stats.visible ?? 0;
    },
    /**
     * Does the indoor camera rig own the visitor?
     *
     * LATCHED, with the release deliberately outside the building. A plain
     * "inside the footprint" test flipped the camera back to third person at the
     * wall plane — which is to say while the visitor was still under the roof:
     * on the entry threshold slab, on the outer edge of the spiral descent
     * (whose treads reach the wall), or simply walking the deck by the glass.
     * Coming in latches just inside the wall; going out does not release until
     * the visitor is a good three metres clear of it, out on the promenade or
     * the beach, so no walk INSIDE the hall can swing the camera out.
     */
    isPlayerInside(player) {
      const y = player.y ?? SUTRO_BATHS.deckY;
      // The sunken gallery is as interior as a room gets, and it is far below
      // the hall's own vertical band — so it answers first rather than fighting
      // the latch below.
      if (grotto && sutroGrottoContains(player.x, y, player.z, 1.5)) {
        playerInside = true;
        return true;
      }
      const containedVertically =
        y >= SUTRO_BATHS.basinY - (playerInside ? 4.5 : 1.5) &&
        y <= SUTRO_BATHS.roofApexY + (playerInside ? 7 : 4);
      const inset = sutroHallWallInset(player.x, player.z);
      playerInside = containedVertically && inset > (playerInside ? INDOOR_EXIT_INSET : INDOOR_ENTER_INSET);
      return playerInside;
    },
    tryInteract(player, playerMode) {
      if (disposed || playerMode !== "walk" || !grotto || !options.relocate) return false;
      if (!inTheFall(player)) return false;
      drainArmed = false;
      risePrompted = false;
      setInGrotto(false);
      options.relocate({ x: grottoRise.x, y: SUTRO_GROTTO_RISE.y, z: grottoRise.z });
      options.hud?.message("The water carries you back up into the plunge", 2.6);
      return true;
    },
    isPlayerInGrotto(player) {
      return (
        grotto !== null &&
        sutroGrottoContains(player.x, player.y ?? SUTRO_BATHS.deckY, player.z, 1.5)
      );
    },
    takeFloorHandoffHeight(player, playerMode) {
      if (!hasFloorRecovery || disposed || playerMode !== "walk") return null;
      const y = player.y;
      if (grotto && y !== undefined && sutroGrottoContains(player.x, y, player.z, 2)) {
        // The gallery's own floor is the only surface down here — except over
        // the basin, where a body is SUPPOSED to be below it. Recovering there
        // would catch a visitor mid-fall and hover them over the water for ever.
        if (sutroGrottoPoolContains(player.x, player.z)) return null;
        /**
         * …and only when they are genuinely THROUGH it.
         *
         * Everywhere else this contract runs, the surface it names is an
         * authored height that the collider under it only approximates, so
         * `recoverOntoWalkSurface`'s 6 cm "clearly below" margin is comfortably
         * outside the solver's resting slop. Here the two agree exactly — the
         * floor collider's top IS `floorY` — which puts a capsule standing
         * still within a few millimetres of that trigger. It fired on the
         * frames it dipped, teleported, settled, and fired again: the room
         * shook. This is a fell-through-the-world net, so ask it that question.
         */
        return y < SUTRO_GROTTO.floorY + 0.2 ? SUTRO_GROTTO.floorY : null;
      }
      return sutroWalkSurfaceY(player.x, player.z);
    },
    tuningDescriptor() {
      return {
        id: "sutro-baths-restoration",
        title: "Sutro Baths · restored 1896",
        build(folder) {
          for (const descriptor of SUTRO_TUNING_FOLDERS) {
            const child = folder.addFolder({ title: descriptor.title, expanded: descriptor.expanded });
            SUTRO_BATHS_TUNING.bind(child, {
              keys: [...descriptor.keys],
              onChange: () => syncTuning()
            });
          }
          const debug = folder.addFolder({ title: "WebGPU visual water · debug" });
          return {
            monitors: [
              debug.addBinding(monitors, "steamLoaded", { readonly: true, label: "steam loaded" }),
              debug.addBinding(monitors, "backend", { readonly: true, label: "backend" }),
              debug.addBinding(monitors, "triangles", { readonly: true, label: "water triangles" }),
              debug.addBinding(monitors, "computeDispatches", { readonly: true, label: "compute dispatches" }),
              debug.addBinding(monitors, "simulated", { readonly: true, label: "fluid simulated" }),
              debug.addBinding(monitors, "steamVisible", { readonly: true, label: "steam puffs" }),
              debug.addBinding(monitors, "playerDistance", {
                readonly: true,
                label: "water distance",
                format: (value: number) => (Number.isFinite(value) ? value.toFixed(1) : "—")
              })
            ]
          };
        },
        sync: syncTuning
      };
    },
    get stats() {
      return liveStats();
    },
    debugState() {
      return {
        awake,
        disposed,
        foliageVisible,
        distanceToBaths,
        nearEffectsLoading: nearEffectsLoading !== null,
        nearEffectsLoaded: steam !== null,
        nearEffectsFailed,
        water: water.debugState(),
        steam: steam?.stats ?? null,
        twilight: twilight.debugState(),
        clockHour: pavilionClock.displayHour,
        grottoLoading: grottoLoading !== null,
        grottoLoaded: grotto !== null,
        grottoFailed,
        playerInGrotto: inGrotto,
        distanceToDrain
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      releaseSwimVolume();
      twilight.release();
      water.dispose();
      steam?.dispose();
      drain.dispose();
      grotto?.dispose();
      grotto = null;
      bathers.dispose();
      parlour.dispose();
      gallery.dispose();
      pavilionClock.dispose();
      vegetation.dispose();
      ambience.dispose();
      group.removeFromParent();
    }
  };
}

export {
  SUTRO_BATHS,
  SUTRO_BATHS_ARRIVAL,
  SUTRO_DRAIN,
  SUTRO_GROTTO,
  SUTRO_POOLS,
  distanceToSutroBaths,
  distanceToSutroDrain,
  distanceToSutroWater,
  inSutroBathsHall,
  sutroGrottoContains,
  sutroHallWallInset
} from "./layout";
