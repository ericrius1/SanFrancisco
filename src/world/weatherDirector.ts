import type * as THREE from "three/webgpu";
import {
  forcedWeather,
  labelForWeather,
  sampleProceduralWeather,
  type WeatherKind,
  type WeatherState
} from "./weatherModel";
import type { SfCivilTime } from "./solar";

export type WeatherUpdate = {
  civil: SfCivilTime;
  x: number;
  z: number;
  camera: THREE.Camera;
  indoor: boolean;
  allowNewLoads: boolean;
};

type WeatherEffects = {
  update(dt: number, state: Readonly<WeatherState>, camera: THREE.Camera, indoor: boolean): void;
  dispose(): void;
  readonly debugState: unknown;
};

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
const approach = (current: number, target: number, dt: number, halfLife: number) =>
  current + (target - current) * (1 - Math.exp((-Math.LN2 * Math.max(0, dt)) / halfLife));

function queryOverride(): WeatherKind | null {
  if (typeof location === "undefined") return null;
  const value = new URLSearchParams(location.search).get("weather");
  return value === "clear" || value === "mist" || value === "rain" || value === "storm"
    ? value
    : null;
}

/** Lightweight global weather state; visual/audio effects remain first-rain lazy. */
export class WeatherDirector {
  readonly state: WeatherState = {
    cloud: 0,
    rain: 0,
    storm: 0,
    lightning: 0,
    wetness: 0,
    wind: 0,
    kind: "clear",
    label: "clear air"
  };

  #scene: THREE.Scene;
  #target: WeatherState = { ...this.state };
  #initialized = false;
  #override: WeatherKind | null = queryOverride();
  #effects: WeatherEffects | null = null;
  #effectsLoading = false;
  #lightningTimer = 9;
  #lightningCount = 0;

  constructor(scene: THREE.Scene) {
    this.#scene = scene;
  }

  get debugState() {
    return {
      kind: this.state.kind,
      label: this.state.label,
      rain: +this.state.rain.toFixed(3),
      storm: +this.state.storm.toFixed(3),
      cloud: +this.state.cloud.toFixed(3),
      wind: +this.state.wind.toFixed(3),
      wetness: +this.state.wetness.toFixed(3),
      lightning: +this.state.lightning.toFixed(3),
      override: this.#override,
      effects: this.#effects ? "active" : this.#effectsLoading ? "loading" : "dormant",
      effectState: this.#effects?.debugState ?? null
    };
  }

  /** Deterministic demo/QA hook. The atmosphere still eases toward the override. */
  setOverride(kind: WeatherKind | null): void {
    this.#override = kind;
  }

  update(dt: number, input: WeatherUpdate): Readonly<WeatherState> {
    if (this.#override) forcedWeather(this.#override, this.#target);
    else sampleProceduralWeather(input.civil, input.x, input.z, this.#target);

    const safeDt = Math.min(1, Math.max(0, dt));
    if (!this.#initialized) {
      Object.assign(this.state, this.#target);
      this.#initialized = true;
    } else {
      this.state.cloud = approach(this.state.cloud, this.#target.cloud, safeDt, 42);
      this.state.rain = approach(
        this.state.rain,
        this.#target.rain,
        safeDt,
        this.#target.rain > this.state.rain ? 72 : 112
      );
      this.state.storm = approach(this.state.storm, this.#target.storm, safeDt, 96);
      this.state.wind = approach(this.state.wind, this.#target.wind, safeDt, 48);
      this.state.wetness = approach(
        this.state.wetness,
        Math.max(this.#target.rain, this.state.rain * 0.75),
        safeDt,
        this.#target.rain > this.state.wetness ? 170 : 420
      );
    }

    this.#advanceLightning(safeDt, input.civil);
    this.state.kind = this.state.storm > 0.38
      ? "storm"
      : this.state.rain > 0.12
        ? "rain"
        : this.state.cloud > 0.62
          ? "mist"
          : "clear";
    this.state.label = labelForWeather(this.state.kind);

    if (
      input.allowNewLoads &&
      (this.state.rain > 0.012 || this.state.storm > 0.05) &&
      !this.#effects &&
      !this.#effectsLoading
    ) {
      this.#loadEffects();
    }
    this.#effects?.update(safeDt, this.state, input.camera, input.indoor);
    return this.state;
  }

  dispose(): void {
    this.#effects?.dispose();
    this.#effects = null;
  }

  #advanceLightning(dt: number, civil: SfCivilTime): void {
    this.state.lightning *= Math.exp(-dt / 0.46);
    if (this.state.lightning < 0.001) this.state.lightning = 0;
    if (this.state.storm < 0.22) {
      this.#lightningTimer = Math.max(this.#lightningTimer, 4);
      return;
    }
    this.#lightningTimer -= dt * (0.32 + this.state.storm * 1.35);
    if (this.#lightningTimer > 0) return;
    this.state.lightning = clamp01(0.7 + this.state.storm * 0.3);
    this.#lightningCount++;
    const seed = civil.day * 131 + civil.month * 977 + this.#lightningCount * 3571;
    const jitter = Math.abs(Math.sin(seed * 12.9898)) % 1;
    this.#lightningTimer = 7 + (1 - this.state.storm) * 17 + jitter * 13;
  }

  #loadEffects(): void {
    this.#effectsLoading = true;
    void import("./weatherEffects")
      .then(({ WeatherEffects }) => {
        this.#effects = new WeatherEffects(this.#scene);
      })
      .catch((error) => {
        console.warn("[weather] effects unavailable", error);
      })
      .finally(() => {
        this.#effectsLoading = false;
      });
  }
}

