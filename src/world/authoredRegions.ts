import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import type { GroundTopOverlay, WorldMap } from "./heightmap";
import type { TerrainCutoutSpec, TileStreamer } from "./tiles";
import { attachKtx2Loader } from "../render/textures";
import { applyHoloBirth, materializeField } from "../render/materialize";

export type AuthoredRegionBounds = {
  centerX: number;
  centerZ: number;
  halfX: number;
  halfZ: number;
  yaw: number;
};

export type AuthoredTerrainFootprint = TerrainCutoutSpec & {
  id: string;
  /** Collision/ground authority beneath this particular authored surface. */
  groundY?: number;
};

export type AuthoredRegionArrival = {
  spawnKey: string;
  x: number;
  y: number;
  z: number;
  heading: number;
};

export type AuthoredRegionDefinition = {
  id: string;
  label: string;
  asset: string;
  tile: string;
  bounds: AuthoredRegionBounds;
  arrival?: AuthoredRegionArrival;
  arrivalDistance: number;
  loadDistance: number;
  unloadDistance: number;
  terrain?: {
    mode: "flat-ownership";
    groundY: number;
    footprints: AuthoredTerrainFootprint[];
  };
};

type AuthoredRegionManifest = {
  schema: 1;
  regions: AuthoredRegionDefinition[];
};

type RegionState = {
  definition: AuthoredRegionDefinition;
  status: "dormant" | "loading" | "ready" | "failed";
  root: THREE.Group | null;
  promise: Promise<void> | null;
  controller: AbortController | null;
  overlay: GroundTopOverlay | null;
  error: string | null;
};

type RegionWatcher = {
  onLoad(root: THREE.Object3D): void;
  onUnload(): void;
};

export type AuthoredRegionDebug = Readonly<{
  id: string;
  status: RegionState["status"];
  asset: string;
  error: string | null;
  terrainActive: boolean;
}>;

export type AuthoredRegionStreamerOptions = {
  scene: THREE.Scene;
  map: WorldMap;
  tiles: TileStreamer;
  prepareRoot?: (label: string, root: THREE.Group) => void | Promise<void>;
};

function finitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function validateManifest(value: unknown): asserts value is AuthoredRegionManifest {
  const manifest = value as Partial<AuthoredRegionManifest> | null;
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.regions)) {
    throw new Error("authored-region manifest has an unsupported schema");
  }
  const ids = new Set<string>();
  for (const region of manifest.regions) {
    if (!region?.id || ids.has(region.id)) throw new Error("authored-region ids must be unique");
    ids.add(region.id);
    if (!region.asset?.startsWith("/regions/") || !region.tile) {
      throw new Error(`authored region ${region.id} has an invalid asset or tile`);
    }
    const bounds = region.bounds;
    if (
      !bounds || !Number.isFinite(bounds.centerX) || !Number.isFinite(bounds.centerZ) ||
      !finitePositive(bounds.halfX) || !finitePositive(bounds.halfZ) || !Number.isFinite(bounds.yaw) ||
      !finitePositive(region.arrivalDistance) || !finitePositive(region.loadDistance) ||
      !finitePositive(region.unloadDistance) || region.unloadDistance <= region.loadDistance
    ) {
      throw new Error(`authored region ${region.id} has invalid streaming bounds`);
    }
    if (region.arrival && (
      !region.arrival.spawnKey ||
      !Number.isFinite(region.arrival.x) ||
      !Number.isFinite(region.arrival.y) ||
      !Number.isFinite(region.arrival.z) ||
      !Number.isFinite(region.arrival.heading)
    )) {
      throw new Error(`authored region ${region.id} has an invalid arrival pose`);
    }
    if (region.terrain) {
      if (
        region.terrain.mode !== "flat-ownership" ||
        !Number.isFinite(region.terrain.groundY) ||
        !Array.isArray(region.terrain.footprints) ||
        region.terrain.footprints.length === 0
      ) {
        throw new Error(`authored region ${region.id} has invalid terrain ownership`);
      }
      for (const footprint of region.terrain.footprints) {
        if (footprint.groundY !== undefined && !Number.isFinite(footprint.groundY)) {
          throw new Error(`authored region ${region.id} has an invalid footprint ground height`);
        }
      }
    }
  }
}

function distanceToBounds(x: number, z: number, bounds: AuthoredRegionBounds): number {
  const dx = x - bounds.centerX;
  const dz = z - bounds.centerZ;
  const c = Math.cos(bounds.yaw);
  const s = Math.sin(bounds.yaw);
  const localX = c * dx - s * dz;
  const localZ = s * dx + c * dz;
  return Math.hypot(
    Math.max(Math.abs(localX) - bounds.halfX, 0),
    Math.max(Math.abs(localZ) - bounds.halfZ, 0)
  );
}

function insideFootprint(x: number, z: number, footprint: AuthoredTerrainFootprint): boolean {
  const dx = x - footprint.centerX;
  const dz = z - footprint.centerZ;
  const c = Math.cos(footprint.yaw);
  const s = Math.sin(footprint.yaw);
  const localX = c * dx - s * dz;
  const localZ = s * dx + c * dz;
  return Math.abs(localX) <= footprint.halfX && Math.abs(localZ) <= footprint.halfZ;
}

function disposeRoot(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  root.clear();
}

/**
 * M5 materialize: GLTF materials are plain (non-node) materials whose node
 * slots the WebGPU backend ignores, so each UNIQUE material is converted to
 * its node twin (copy() carries colours/maps/flags) and wrapped with the
 * holo-birth mix keyed to the region's shared birth uniform. Runs BEFORE the
 * region's prepareRoot warm so the compiled pipelines are the final graphs.
 * Multi-material arrays are left untouched (none of the authored GLBs use
 * them today).
 */
function applyRegionMaterialize(root: THREE.Object3D, birth: unknown): void {
  const converted = new Map<THREE.Material, THREE.Material>();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || Array.isArray(mesh.material)) return;
    const source = mesh.material as THREE.Material & { isNodeMaterial?: boolean };
    let material = converted.get(source);
    if (!material) {
      if (source.isNodeMaterial) {
        material = source;
      } else if ((source as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial) {
        material = new THREE.MeshPhysicalNodeMaterial().copy(source as THREE.MeshPhysicalMaterial);
      } else if ((source as THREE.MeshBasicMaterial).isMeshBasicMaterial) {
        material = new THREE.MeshBasicNodeMaterial().copy(source as THREE.MeshBasicMaterial);
      } else {
        material = new THREE.MeshStandardNodeMaterial().copy(source as THREE.MeshStandardMaterial);
      }
      applyHoloBirth(material as THREE.MeshStandardNodeMaterial, { birth });
      converted.set(source, material);
    }
    mesh.material = material;
  });
  // M9: the GLTF originals are fully replaced by their node twins and never
  // render again — release them now instead of leaking one set per region
  // load. The twins SHARE texture objects with the originals (copy() carries
  // references) and Material.dispose() never disposes textures (it only
  // dispatches the material's own dispose event), so the twins' maps stay
  // live. Unload keeps disposing the twins through disposeRoot.
  for (const [source, twin] of converted) {
    if (twin !== source) source.dispose();
  }
}

function waitForSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/**
 * Data-driven static-region residency. Region geometry, its terrain ownership,
 * and observers publish in one synchronous commit after fetch/decode/warmup, so
 * the terrain clipmap can never expose a raw ownership hole while its Blender
 * replacement is still unavailable.
 */
export class AuthoredRegionStreamer {
  readonly #scene: THREE.Scene;
  readonly #map: WorldMap;
  readonly #tiles: TileStreamer;
  readonly #prepareRoot?: AuthoredRegionStreamerOptions["prepareRoot"];
  readonly #loader = new GLTFLoader();
  readonly #states = new Map<string, RegionState>();
  readonly #watchers = new Map<string, Set<RegionWatcher>>();

  constructor(options: AuthoredRegionStreamerOptions) {
    this.#scene = options.scene;
    this.#map = options.map;
    this.#tiles = options.tiles;
    this.#prepareRoot = options.prepareRoot;
    this.#loader.setMeshoptDecoder(MeshoptDecoder);
  }

  async init(): Promise<void> {
    // Wire KTX2 before any region can load (update()/prepareAt() only fire after
    // init resolves). Inert for region GLBs without KHR_texture_basisu.
    await attachKtx2Loader(this.#loader);
    const response = await fetch("/data/authored-regions.json");
    if (!response.ok) throw new Error(`authored-region manifest HTTP ${response.status}`);
    const manifest: unknown = await response.json();
    validateManifest(manifest);
    for (const definition of manifest.regions) {
      this.#states.set(definition.id, {
        definition,
        status: "dormant",
        root: null,
        promise: null,
        controller: null,
        overlay: null,
        error: null
      });
    }
  }

  /** Required arrival participant: only regions intersecting the destination
   * wait under the opaque travel cover; all others remain completely unfetched. */
  async prepareAt(destination: Readonly<{ x: number; z: number }>, signal?: AbortSignal): Promise<void> {
    const required = [...this.#states.values()].filter((state) =>
      distanceToBounds(destination.x, destination.z, state.definition.bounds) <=
      state.definition.arrivalDistance
    );
    const requiredIds = new Set(required.map((state) => state.definition.id));
    // A discontinuous cut does not imply travel through every region between
    // destinations. Retire stale parses before they can publish an unrelated
    // landmark into the new arrival's covered frame.
    for (const state of this.#states.values()) {
      if (state.status === "loading" && !requiredIds.has(state.definition.id)) {
        state.controller?.abort(new DOMException("Superseded destination", "AbortError"));
      }
    }
    const abortRequired = () => {
      for (const state of required) {
        if (state.status === "loading") {
          state.controller?.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
        }
      }
    };
    signal?.addEventListener("abort", abortRequired, { once: true });
    try {
      await Promise.all(required.map((state) => this.#ensure(state, signal)));
    } finally {
      signal?.removeEventListener("abort", abortRequired);
    }
  }

  /**
   * M9: does this destination sit within the arrival radius of a region that
   * OWNS TERRAIN (a groundTop-overlay floor handoff)? Far arrivals must keep
   * the cover for that region's prime — releasing the player on the CPU
   * carpet and installing the overlay afterwards pops them vertically.
   * Regions without terrain stay detached on the far path.
   */
  requiresFloorHandoffAt(x: number, z: number): boolean {
    for (const state of this.#states.values()) {
      if (!state.definition.terrain) continue;
      if (distanceToBounds(x, z, state.definition.bounds) <= state.definition.arrivalDistance) {
        return true;
      }
    }
    return false;
  }

  /** Proximity path for ordinary travel. Call only from the live world tick;
   * arrival code uses prepareAt so it can wait for the exact same transaction. */
  update(x: number, z: number): void {
    for (const state of this.#states.values()) {
      const distance = distanceToBounds(x, z, state.definition.bounds);
      if ((state.status === "dormant" || state.status === "failed") &&
          distance <= state.definition.loadDistance) {
        void this.#ensure(state).catch((error) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            console.warn(`[authored-region] ${state.definition.id} unavailable`, error);
          }
        });
      } else if (state.status === "ready" && distance >= state.definition.unloadDistance) {
        this.#unload(state);
      } else if (state.status === "loading" && distance >= state.definition.unloadDistance) {
        state.controller?.abort(new DOMException("Region left residency", "AbortError"));
      }
    }
  }

  watch(
    id: string,
    onLoad: (root: THREE.Object3D) => void,
    onUnload: () => void = () => {}
  ): () => void {
    const watcher: RegionWatcher = { onLoad, onUnload };
    const watchers = this.#watchers.get(id) ?? new Set<RegionWatcher>();
    watchers.add(watcher);
    this.#watchers.set(id, watchers);
    const root = this.#states.get(id)?.root;
    if (root) onLoad(root);
    return () => {
      watchers.delete(watcher);
      if (watchers.size === 0) this.#watchers.delete(id);
    };
  }

  debugSnapshot(): AuthoredRegionDebug[] {
    return [...this.#states.values()].map((state) => ({
      id: state.definition.id,
      status: state.status,
      asset: state.definition.asset,
      error: state.error,
      terrainActive: state.overlay !== null
    }));
  }

  /** Exact poses live with the region's Blender authoring data. Boot links and
   * map landmarks use them instead of asking generated terrain for a nearby
   * point that may sit outside a narrow entrance, bridge, or interior deck. */
  arrivalForKey(key: string): AuthoredRegionArrival | null {
    for (const state of this.#states.values()) {
      if (state.definition.arrival?.spawnKey === key) return { ...state.definition.arrival };
    }
    return null;
  }

  arrivalForDestination(x: number, z: number, label?: string): AuthoredRegionArrival | null {
    const normalizedLabel = label?.trim().toLocaleLowerCase();
    for (const state of this.#states.values()) {
      const { arrival } = state.definition;
      if (!arrival) continue;
      if (normalizedLabel === state.definition.label.trim().toLocaleLowerCase()) return { ...arrival };
      if (Math.hypot(arrival.x - x, arrival.z - z) <= 8) return { ...arrival };
    }
    return null;
  }

  landmarkArrivals(): ReadonlyArray<Readonly<AuthoredRegionArrival & { id: string; label: string }>> {
    const result: Array<AuthoredRegionArrival & { id: string; label: string }> = [];
    for (const state of this.#states.values()) {
      const { arrival } = state.definition;
      if (arrival) result.push({ id: state.definition.id, label: state.definition.label, ...arrival });
    }
    return result;
  }

  dispose(): void {
    for (const state of this.#states.values()) {
      state.controller?.abort(new DOMException("Disposed", "AbortError"));
      if (state.root) this.#unload(state);
    }
    this.#watchers.clear();
  }

  #ensure(state: RegionState, signal?: AbortSignal): Promise<void> {
    if (state.status === "ready") return Promise.resolve();
    if (state.promise) return waitForSignal(state.promise, signal);
    state.status = "loading";
    state.error = null;
    const controller = new AbortController();
    state.controller = controller;
    const promise = this.#load(state, controller.signal)
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          state.status = "dormant";
        } else {
          state.status = "failed";
          state.error = error instanceof Error ? error.message : String(error);
        }
        throw error;
      })
      .finally(() => {
        if (state.promise === promise) state.promise = null;
        if (state.controller === controller) state.controller = null;
      });
    state.promise = promise;
    return waitForSignal(promise, signal);
  }

  async #load(state: RegionState, signal: AbortSignal): Promise<void> {
    const { definition } = state;
    const response = await fetch(definition.asset, { signal });
    if (!response.ok) throw new Error(`${definition.asset} HTTP ${response.status}`);
    const buffer = await response.arrayBuffer();
    if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const gltf = await this.#loader.parseAsync(buffer, "/regions/");
    const root = gltf.scene;
    root.name ||= `authored_region_${definition.id}`;
    root.userData.sfRegion = definition.id;
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    });
    // M5: holo-birth wrap (per unique material) BEFORE the warm below, keyed
    // to this region's birth uniform (stamped at attach, forgotten at unload).
    applyRegionMaterialize(root, materializeField.birthOf(`region:${definition.id}`));
    try {
      await this.#prepareRoot?.(definition.label, root);
      if (signal.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      this.#attach(state, root);
    } catch (error) {
      disposeRoot(root);
      throw error;
    }
  }

  #attach(state: RegionState, root: THREE.Group): void {
    const { definition } = state;
    // The Blender replacement is present before terrain ownership changes. Both
    // operations are synchronous, so no render can observe the intermediate.
    // M5: stamp the region's birth so a region streaming in after the front
    // passed fades in through the holo ramp instead of popping.
    materializeField.markBorn(`region:${definition.id}`);
    this.#scene.add(root);
    const terrain = definition.terrain;
    const claimedFootprints: string[] = [];
    try {
      if (terrain) {
        const overlay: GroundTopOverlay = (x, z, base) => {
          for (const footprint of terrain.footprints) {
            if (insideFootprint(x, z, footprint)) {
              return Math.min(base, footprint.groundY ?? terrain.groundY);
            }
          }
          return base;
        };
        state.overlay = overlay;
        this.#map.setGroundTopOverlay(overlay);
        for (const footprint of terrain.footprints) {
          const id = `${definition.id}:${footprint.id}`;
          this.#tiles.setTerrainCutout(id, footprint);
          claimedFootprints.push(id);
        }
      }
      state.root = root;
      state.status = "ready";
      for (const watcher of this.#watchers.get(definition.id) ?? []) watcher.onLoad(root);
      this.#tiles.onShadowCastersChanged("all");
      console.info(`[authored-region] ${definition.label} ready`);
    } catch (error) {
      for (const id of claimedFootprints) this.#tiles.clearTerrainCutout(id);
      if (state.overlay) this.#map.clearGroundTopOverlay(state.overlay);
      state.overlay = null;
      root.removeFromParent();
      throw error;
    }
  }

  #unload(state: RegionState): void {
    const root = state.root;
    if (!root) return;
    materializeField.forgetBirth(`region:${state.definition.id}`); // next load re-births
    for (const watcher of this.#watchers.get(state.definition.id) ?? []) watcher.onUnload();
    root.removeFromParent();
    if (state.definition.terrain) {
      for (const footprint of state.definition.terrain.footprints) {
        this.#tiles.clearTerrainCutout(`${state.definition.id}:${footprint.id}`);
      }
    }
    if (state.overlay) this.#map.clearGroundTopOverlay(state.overlay);
    state.overlay = null;
    state.root = null;
    state.status = "dormant";
    disposeRoot(root);
    this.#tiles.onShadowCastersChanged("all");
  }
}
