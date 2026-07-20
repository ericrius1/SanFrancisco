// Shared boot context handed from main.ts's boot() into the extracted
// world-system compose modules (docs/MAIN_DECOMPOSITION.md).
//
// - Plain fields are stable references created before P3 composition begins.
// - `state` is a LIVE get/set facade over main's own mutable boot lets
//   (elapsed, revealed, the lazy-region aliases, …) so modules read/write the
//   same bindings main's remaining code uses — no snapshot staleness.
//
// Typing: the load-bearing systems are precise; the long tail of boot-local
// helpers is typed loosely (`any`) — tightening them is welcome but each one
// is a small, isolated improvement, not a correctness risk (the modules were
// extracted verbatim from code that already used these values).
import type * as THREE from "three/webgpu";
import type { Player } from "../../player/player";
import type { Input } from "../../core/input";
import type { ChaseCamera } from "../../core/camera";
import type { WorldMap } from "../../world/heightmap";
import type { Sky } from "../../world/sky";
import type { TileStreamer } from "../../world/tiles";
import type { VoidRealm } from "../../world/voidRealm";
import type { WorldArrivalCoordinator } from "../worldArrival";
import type { BeachPianist } from "../../world/beachPianist";
import type { HUD } from "../../ui/hud";

export interface MainCtx {
  player: Player;
  input: Input;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  worldArrival: WorldArrivalCoordinator;
  chase: ChaseCamera;
  map: WorldMap;
  physics: any;
  renderer: any;
  sky: Sky;
  waitForWorldBackgroundWindow: (extraQuietMs?: number, deadline?: number) => Promise<void>;
  aim: THREE.Vector3;
  tiles: TileStreamer;
  rayOrigin: THREE.Vector3;
  worldReady: Promise<void>;
  scheduler: any;
  pipeline: any;
  authoredRegions: any;
  applyLightFrontRamps: any;
  waitForCityGenRenderWindow: any;
  spawn: any;
  app: any;
  voidRealm: VoidRealm;
  audioEngine: any;
  renderFrame: () => void;
  fullTileRadius: number;
  modeDiscovery: any;
  invite: any;
  timer: THREE.Timer;
  startMode: any;
  savedSurfboard: any;
  savedScooter: any;
  savedCar: any;
  savedBoard: any;
  savedAvatar: any;
  resumed: any;
  revealedPromise: Promise<void>;
  nextPresentationFrame: any;
  bootArrivalTick: () => void;
  backgroundAdmission: any;
  autoStartHiroTour: any;
  releasePianoGodRays: () => void;
  voidRevealCheck: any;
  constructionSlice: () => Promise<void>;
  progress: (pct: number, label: string) => void;
  suggestedName: string;
  /** Late-bound NET-module systems that CORE-module closures capture (they
   *  only run after construction; the non-null asserts at the use sites
   *  mirror the original single-closure TDZ semantics). */
  late: {
    teaGarden: ReturnType<typeof import("./teaGarden").createTeaGardenController> | null;
    net: import("../../net/net").Net | null;
    debugPanel: import("../../ui/debug").DebugPanel | null;
  };
  state: {
    oceanBeachWaves: import("../../gameplay/surfing/waves").OceanBeachWaves | null;
    auxPending: number;
    roadMarkings: THREE.Group | null;
    customized: boolean;
    carCustomized: boolean;
    boardCustomized: boolean;
    scooterCustomized: boolean;
    surfboardCustomized: boolean;
    foliageOn: boolean;
    beachPianist: BeachPianist | null;
    bootHud: HUD | null;
    accumulator: number;
    elapsed: number;
    revealed: boolean;
    ringUpdate: (dt: number) => void;
    classifyFarArrival: (x: number, z: number) => boolean;
    onFarArrivalCut: (x: number, z: number) => void;
    citygenResidencyRadius: (x: number, z: number) => number;
    citygenApplyFrontGate: () => void;
    avatarTraits: any;
    carConfig: any;
    boardConfig: any;
    scooterConfig: any;
    surfboardConfig: any;
    siteFoliage: any;
    prepareDestinationEssentials: any;
  };
}
