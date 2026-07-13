// Modular cinematic-demo layer.
//
// A demo is a self-contained module under ./demos/ exporting a `Demo`
// ({ name, run(ctx) }). `runDemo(name, ctx)` looks the name up in the registry
// and dispatches; unknown names log the available set. main.ts wires up ONE
// rich, stable `DemoContext` (below) and never needs to change again when a new
// demo is added — the demo pulls whatever it needs off the context.
//
// URL entry point: /?demo=<name> (see main.ts). A demo drives a scripted shot
// through ctx.setCine (a per-frame hook that fully owns the camera and player
// pose — see demos/buskersCinematic.ts for the canonical pattern: everything a
// pure function of virtual time window.__cineT).

import type * as THREE from "three/webgpu";
import type { Input } from "../core/input";
import type { Player } from "../player/player";
import type { Physics } from "../core/physics";
import type { ChaseCamera } from "../core/camera";
import type { WorldMap } from "../world/heightmap";
import type { BuskerTrioApi } from "../gameplay/buskers";
import type { FetchBall } from "../gameplay/fetchBall";
import type { CoronaHeightsPark } from "../world/coronaHeights";
import type { LandsEndRegion } from "../world/landsEnd";
import type { WorldQueries } from "../core/worldQueries";
import type { BoardConfig } from "../vehicles/board";
import type { PalaceReverieGame } from "../gameplay/palaceReverie";
import type { Fireworks } from "../fx/fireworks";
import type { AfterlightExperience } from "../gameplay/afterlight";

/**
 * Everything a demo can reach. main.ts builds one of these and passes it to
 * `runDemo`. The first block is always present (the running app); the `?`
 * fields are the systems a demo may or may not use. `setCine`/`setExposure`/
 * `setPostFx` are the scripted-shot levers and are always wired.
 */
export type DemoContext = {
  input: Input;
  player: Player;
  physics: Physics;
  chase: ChaseCamera;
  camera: THREE.PerspectiveCamera;
  scene: THREE.Scene;
  hud?: {
    setHidden: (hidden: boolean) => void;
    setFaded: (faded: boolean) => void;
    message: (text: string, seconds?: number) => void;
  };
  sky?: {
    cycleEnabled: boolean;
    nightBrightness: number;
    setTimeOfDay: (time: number) => void;
    readonly sunElevation: number;
    readonly timeOfDay: number;
  };
  minimap?: {
    focusLandmark: (name: string) => { x: number; z: number } | null;
    setExpanded: (on: boolean) => void;
  };
  map?: WorldMap;
  buskers?: BuskerTrioApi;
  fetchBall?: FetchBall;
  coronaHeights?: CoronaHeightsPark;
  palaceReverie?: PalaceReverieGame;
  landsEnd?: LandsEndRegion;
  fireworks?: Fireworks;
  afterlight?: AfterlightExperience;
  worldQueries?: WorldQueries;
  setTool?: (tool: string) => void;
  /** Apply a local, non-persisted board configuration for demos and capture. */
  setBoardConfig?: (config: BoardConfig) => void;
  /** Install (or clear, with null) a per-frame cinematic hook that owns the
   * camera + player pose. main runs it in place of the chase camera. */
  setCine: (fn: ((dt: number) => void) | null) => void;
  setExposure: (v: number) => void;
  setPostFx: (values: Record<string, number | boolean>) => void;
};

/** A demo module: a stable name + a one-shot setup that arms the shot. */
export type Demo = {
  name: string;
  run(ctx: DemoContext): void;
};

import { buskersCinematic } from "./demos/buskersCinematic";
import { hoverboardCinematic } from "./demos/hoverboardCinematic";
import { dogParkCinematic } from "./demos/dogParkCinematic";
import { roqnOpenRoadCinematic } from "./demos/roqnOpenRoadCinematic";
import { palaceShowcase } from "./demos/palaceShowcase";
import { palaceReverieCinematic } from "./demos/palaceReverieCinematic";
import { landsEndCinematic } from "./demos/landsEndCinematic";
import { twitterSummerShot01 } from "./demos/twitterSummerShot01";
import { twitterSummerShot02 } from "./demos/twitterSummerShot02";
import { twitterSummerShot03 } from "./demos/twitterSummerShot03";
import { twitterSummerShot04 } from "./demos/twitterSummerShot04";
import { twitterSummerShot05 } from "./demos/twitterSummerShot05";
import { twitterSummerShot06 } from "./demos/twitterSummerShot06";
import { twitterSummerShot07 } from "./demos/twitterSummerShot07";
import { twitterSummerShot08 } from "./demos/twitterSummerShot08";
import { afterlightCinematic } from "./demos/afterlightCinematic";

const DEMOS: Record<string, Demo> = {
  [buskersCinematic.name]: buskersCinematic,
  [hoverboardCinematic.name]: hoverboardCinematic,
  [dogParkCinematic.name]: dogParkCinematic,
  [roqnOpenRoadCinematic.name]: roqnOpenRoadCinematic,
  [palaceShowcase.name]: palaceShowcase,
  [palaceReverieCinematic.name]: palaceReverieCinematic,
  [landsEndCinematic.name]: landsEndCinematic,
  [twitterSummerShot01.name]: twitterSummerShot01,
  [twitterSummerShot02.name]: twitterSummerShot02,
  [twitterSummerShot03.name]: twitterSummerShot03,
  [twitterSummerShot04.name]: twitterSummerShot04,
  [twitterSummerShot05.name]: twitterSummerShot05,
  [twitterSummerShot06.name]: twitterSummerShot06,
  [twitterSummerShot07.name]: twitterSummerShot07,
  [twitterSummerShot08.name]: twitterSummerShot08,
  [afterlightCinematic.name]: afterlightCinematic
};

export function runDemo(name: string, ctx: DemoContext) {
  const demo = DEMOS[name];
  if (!demo) {
    console.warn(`[demo] unknown demo "${name}". Available: ${Object.keys(DEMOS).join(", ")}`);
    return;
  }
  demo.run(ctx);
}
