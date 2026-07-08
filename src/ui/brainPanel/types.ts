import type * as THREE from "three/webgpu";

/**
 * The minimal structural view of an MLP policy the inspector panel needs. Both
 * concrete `Policy` classes (src/gameplay/aiCars/policy.ts and
 * src/creatures/policy.ts) satisfy this shape, so the panel never imports either
 * — any future NN creature just has to expose the same four members.
 *
 * `forward` runs a full pass as a side effect, refreshing `layerOut` (index 0 =
 * first hidden layer, last = squashed action). `getParams` returns the flat
 * weight vector: per layer, W (out*in, row-major) followed by B (out).
 */
export type BrainNet = {
  readonly sizes: readonly number[]; // [obs, h1, ..., act]
  readonly layerOut: Float32Array[]; // per-layer activations, refreshed by forward()
  forward(obs: ArrayLike<number>): unknown;
  getParams(): Float32Array;
};

/**
 * One in-world entity whose brain can be clicked and inspected. Entities build
 * these on demand (see AiCars.inspectables / HorseHerd.inspectables); the panel
 * treats them uniformly.
 */
export interface InspectableBrain {
  id: string; // stable per entity, e.g. "car:12"
  label: string; // panel title, e.g. "AI Car #12"
  /** Current world position of this entity's floating brain lattice. */
  getWorldPos(out: THREE.Vector3): void;
  /** Ray-vs-sphere pick radius in metres (~ the lattice's on-screen size). */
  pickRadius: number;
  net: BrainNet;
  /** The entity's current real observation (copied on open — never mutated). */
  liveObs(): Float32Array;
  inputLabels?: string[]; // per-input names; falls back to "in[i]"
  outputLabels?: string[]; // per-output names; falls back to "out[j]"
}
