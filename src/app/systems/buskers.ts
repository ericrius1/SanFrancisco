import type * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { WorldMap } from "../../world/heightmap";
import {
  createBuskerTrio,
  type BuskerTrio,
  type BuskerTrioApi,
  type BuskerTrioOptions,
  type BuskerTrioState
} from "../../gameplay/buskers";
import { FeatureSlot } from "../hmr/featureSlot";

export type BuskersSystemDeps = {
  scene: THREE.Scene;
  map: WorldMap;
  physics: Physics;
};

type BuskerFactory = (opts: BuskerTrioOptions) => BuskerTrio;
const liveSystems = new Set<BuskersSystem>();

function options(deps: BuskersSystemDeps, state?: BuskerTrioState): BuskerTrioOptions {
  return {
    x: 412,
    z: 2760,
    yaw: -1.72,
    groundHeight: (x, z) => deps.map.groundTop(x, z),
    physics: deps.physics,
    state
  };
}

/**
 * Stable facade retained by main, debug hooks and running demos. Only the
 * concrete BuskerTrio behind it changes, so no consumer can capture a stale
 * instance during HMR.
 */
export class BuskersSystem implements BuskerTrioApi {
  #deps: BuskersSystemDeps;
  #slot: FeatureSlot<BuskerTrio, BuskerTrioState>;

  constructor(deps: BuskersSystemDeps) {
    this.#deps = deps;
    const initial = this.#build(createBuskerTrio);
    this.#slot = new FeatureSlot(initial, (trio) => trio.snapshotState(), {
      onFailure: () => import.meta.hot?.invalidate("buskers HMR replacement failed")
    });
    liveSystems.add(this);
  }

  get current(): BuskerTrio {
    return this.#slot.current;
  }

  get generation(): number {
    return this.#slot.status.generation;
  }

  get hotStatus() {
    return this.#slot.status;
  }

  get group() {
    return this.current.group;
  }

  get clock() {
    return this.current.clock;
  }

  flushHotSwap(): void {
    const verdict = this.#slot.flush();
    if (verdict === "replaced") console.info(`[hmr] buskers replaced (generation ${this.generation})`);
  }

  queueFactory(factory: BuskerFactory): void {
    this.#slot.queue((state) => this.#build(factory, state));
  }

  setPlacement(...args: Parameters<BuskerTrio["setPlacement"]>) {
    return this.current.setPlacement(...args);
  }

  restartSong(...args: Parameters<BuskerTrio["restartSong"]>) {
    return this.current.restartSong(...args);
  }

  cycleSong(...args: Parameters<BuskerTrio["cycleSong"]>) {
    return this.current.cycleSong(...args);
  }

  cueShow(...args: Parameters<BuskerTrio["cueShow"]>) {
    return this.current.cueShow(...args);
  }

  seek(...args: Parameters<BuskerTrio["seek"]>) {
    return this.current.seek(...args);
  }

  captureStream(...args: Parameters<BuskerTrio["captureStream"]>) {
    return this.current.captureStream(...args);
  }

  seatWorld(...args: Parameters<BuskerTrio["seatWorld"]>) {
    return this.current.seatWorld(...args);
  }

  forEachPickTarget(...args: Parameters<BuskerTrio["forEachPickTarget"]>) {
    return this.current.forEachPickTarget(...args);
  }

  update(...args: Parameters<BuskerTrio["update"]>) {
    return this.current.update(...args);
  }

  dispose(): void {
    liveSystems.delete(this);
    this.#slot.dispose();
  }

  #build(factory: BuskerFactory, state?: BuskerTrioState): BuskerTrio {
    const trio = factory(options(this.#deps, state));
    this.#deps.scene.add(trio.group);
    return trio;
  }
}

export function createBuskersSystem(deps: BuskersSystemDeps): BuskersSystem {
  return new BuskersSystem(deps);
}

if (import.meta.hot) {
  import.meta.hot.accept("../../gameplay/buskers", (next) => {
    if (!next) return;
    for (const system of liveSystems) system.queueFactory(next.createBuskerTrio);
  });
}
