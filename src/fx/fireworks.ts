import type * as THREE from "three/webgpu";
import type { WorldMap } from "../world/heightmap";
import type { Fireworks as Runtime } from "./fireworksRuntime";
import type { FolderApi, Pane } from "tweakpane";
import { AUDIO_TUNING } from "./fireworksAudioSettings";
import { FIREWORKS_TUNING } from "./fireworksSettings";

/** First-use owner. Walking boot allocates no particle buffers or shader graphs. */
export class Fireworks {
  params = FIREWORKS_TUNING.values;
  stats = { alive: 0, queuedCmds: 0 };
  onVolley: (rockets: number[][]) => void = () => {};
  #runtime: Runtime | null = null;
  #loading: Promise<Runtime> | null = null;
  #origin: THREE.Vector3 | null = null;
  #idleSeconds = 0;
  #generation = 0;
  constructor(
    private renderer: THREE.WebGPURenderer,
    private scene: THREE.Scene,
    private map: WorldMap,
    private compile: (owner: THREE.Object3D) => Promise<void>
  ) {}
  get ready(): boolean { return this.#runtime !== null; }
  prepare(): Promise<Runtime> {
    if (this.#runtime) return Promise.resolve(this.#runtime);
    if (this.#loading) return this.#loading;
    const generation = this.#generation;
    this.#loading = import("./fireworksRuntime").then(async ({ Fireworks }) => {
      const runtime = new Fireworks(this.renderer, this.scene, this.map);
      try {
        await runtime.prepare(this.compile);
        if (generation !== this.#generation) throw new Error("Firework preparation was cancelled");
        runtime.onVolley = (rows) => this.onVolley(rows);
        runtime.stats = this.stats;
        this.#runtime = runtime;
        this.#idleSeconds = 0;
        return runtime;
      } catch (error) { runtime.dispose(); throw error; }
    }).finally(() => { this.#loading = null; });
    return this.#loading;
  }
  launchRemote(rockets: number[][]): void {
    // Explicit local show/cinematic request. Network receives use receiveRemote.
    void this.prepare().then(runtime => runtime.launchRemote(rockets.slice(0, 96)))
      .catch(error => console.warn("[fireworks] preparation failed", error));
  }
  receiveRemote(rockets: number[][]): void {
    if (!this.#runtime || !this.#origin) return;
    const origin = this.#origin;
    this.#runtime.launchRemote(rockets.filter(row => Math.hypot(row[0]-origin.x, row[2]-origin.z) < 450).slice(0, 96));
  }
  launchDroneSalvo(...args: Parameters<Runtime["launchDroneSalvo"]>): void {
    void this.prepare().then(runtime => runtime.launchDroneSalvo(...args))
      .catch(error => console.warn("[fireworks] preparation failed", error));
  }
  update(dt: number, ctx: Parameters<Runtime["update"]>[1]): void {
    this.#origin = ctx.origin;
    if (!this.#runtime) {
      if (ctx.hold || this.params.auto) void this.prepare().catch(error => console.warn("[fireworks]", error));
      return;
    }
    this.#runtime.update(dt, ctx);
    this.#idleSeconds = this.stats.alive || this.stats.queuedCmds || this.params.auto ? 0 : this.#idleSeconds + dt;
    if (this.#idleSeconds > 60) this.dispose();
  }
  addTuning(pane: Pane | FolderApi) {
    const folder = pane.addFolder({ title: "fireworks", expanded: false });
    FIREWORKS_TUNING.bind(folder);
    AUDIO_TUNING.bind(folder);
    return [folder.addBinding(this.stats, "alive", { readonly: true }), folder.addBinding(this.stats, "queuedCmds", { readonly: true })];
  }
  dispose(): void {
    this.#generation++;
    this.#runtime?.dispose();
    this.#runtime = null;
    this.stats.alive = this.stats.queuedCmds = 0;
  }
}
