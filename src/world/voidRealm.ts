// Void realm (docs/VOID_STREAM_REWRITE.md §B, milestone M2).
//
// Couples the sky dome/fog and the water sheets to the materialize front with
// two uniform-driven ramps — no lights are added, removed, or re-membered
// (sun + hemi + LightPool stay resident; C1). The "void factor" is 1 when the
// front is collapsed (whole world holo: near-black dome, fog off, water
// hidden) and eases to 0 as the front expands past VOID_FADE_RADIUS, restoring
// the normal sky/fog/water shading byte-identically (their graphs are plain
// multiplies by these uniforms).
//
// An explicit override (setVoidFactor) lets later milestones (teleport
// arrivals, cinematics) drive the realm independently of the front.
import type { Sky } from "./sky";
import type { Water } from "./water";
import { materializeField } from "../render/materialize";

/** Front radius (m) by which the void has fully faded back to the normal sky. */
const VOID_FADE_RADIUS = 900;

export class VoidRealm {
  readonly #sky: Sky;
  #water: Water | null = null;
  #override: number | null = null;
  #applied = Number.NaN;

  /** Water is late-bound: the void boot (M3) constructs it in the sliced P3
   *  stretch, well after the realm starts driving the sky. */
  constructor(sky: Sky) {
    this.#sky = sky;
  }

  /** Bind the water sheets once they exist and immediately sync them to the
   *  current void factor (they must not flash fully-revealed for a frame). */
  attachWater(water: Water): void {
    this.#water = water;
    water.setReveal(1 - this.factor);
  }

  /** Pin the void factor explicitly (0 = normal world, 1 = full void);
   *  null returns ownership to the materialize front. */
  setVoidFactor(v: number | null): void {
    this.#override = v === null ? null : Math.min(1, Math.max(0, v));
  }

  /** Current effective void factor (after override/front derivation). */
  get factor(): number {
    return Number.isNaN(this.#applied) ? 0 : this.#applied;
  }

  /** Derive the factor from the front and push it into sky + water uniforms.
   *  Cheap and idempotent — call once per frame next to materializeField.update. */
  update(): void {
    const radius = materializeField.frontRadius.value as number;
    const derived = 1 - Math.min(1, Math.max(0, radius / VOID_FADE_RADIUS));
    const v = this.#override ?? derived;
    if (v === this.#applied) return;
    this.#applied = v;
    this.#sky.setVoidFactor(v);
    this.#water?.setReveal(1 - v);
  }
}
