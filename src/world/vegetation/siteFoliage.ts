// Unified streaming for exhibit-site vegetation.
//
// Sites contribute botanical intent only — a registration with a center, its
// own residency radii, and a build() that dynamic-imports the site's placement
// module and plants through the shared vegetation runtime (NativeTreeForest,
// authored shrubs/flowers, bladeGrass). This streamer owns every lifecycle
// concern the sites used to hand-roll: lazy import gating, background
// admission, off-frame pipeline warmup, per-frame focus updates, the master
// foliage toggle, and distance unload.
//
// Residency here is deliberately independent of the exhibit gameplay sites
// (500 m load / 1 km unload): trees are landscape, visible on approach long
// before a labyrinth or dog park needs its NPCs, and they must survive the
// gameplay site unloading behind the player. Registrations are boot-safe data;
// nothing heavy loads until the player crosses a foliage ring.

import * as THREE from "three/webgpu";

export type SiteFoliagePatch = {
  group: THREE.Group;
  ready: Promise<void>;
  update(focus: { x: number; z: number }, force?: boolean): void;
  dispose(): void;
  /** Optional live retune (e.g. wildflower density slider). */
  refresh?: () => void;
};

export type SiteFoliageRegistration = {
  id: string;
  x: number;
  z: number;
  /** Begin building inside this radius (m). Choose it beyond the patch's own
   * visibleDistance so appearance is governed by LOD fade, never residency. */
  loadDistance: number;
  /** Dispose beyond this radius (m); must exceed loadDistance (hysteresis). */
  unloadDistance: number;
  /** Dynamic-import boundary. Heavy templates/geometry stay out of boot. */
  build(): Promise<SiteFoliagePatch>;
};

/** Thrown by an admit callback to hand the single build slot back without
 * failing the entry: the entry returns to dormant with a short retry backoff.
 * Used when an arrival lands mid-park so the destination's own vegetation is
 * not stuck behind a background entry waiting out a quiet window. */
export class SiteFoliageYieldError extends Error {
  constructor() {
    super("site-foliage admission yielded");
    this.name = "SiteFoliageYieldError";
  }
}

export type SiteFoliageDebug = Readonly<{
  id: string;
  status: "dormant" | "loading" | "ready" | "failed";
  distance: number;
}>;

export type SiteFoliageStreamerOptions = {
  scene: THREE.Scene;
  /** Background admission gate (quiet window with a starvation cap). Receives
   * the registration so an arrival-destination lane can fast-track the
   * vegetation the player teleported into. */
  admit(registration: SiteFoliageRegistration, eligibleSince: number): Promise<void>;
  /** Off-frame pipeline warmup for a detached, fully built patch root. */
  prepare(
    label: string,
    root: THREE.Object3D,
    registration: SiteFoliageRegistration
  ): Promise<void>;
};

type EntryState = {
  registration: SiteFoliageRegistration;
  status: "dormant" | "loading" | "ready" | "failed";
  patch: SiteFoliagePatch | null;
  eligibleSince: number;
  /** Bumps on dispose/unload so a stale in-flight build retires itself. */
  generation: number;
  /** Set after an admission yield: skip this entry until the backoff passes. */
  retryAt: number;
};

export class SiteFoliageStreamer {
  readonly root = new THREE.Group();
  #entries: EntryState[] = [];
  #options: SiteFoliageStreamerOptions;
  #visible = true;
  #building = false;
  #disposed = false;
  #focus = { x: 0, z: 0 };

  constructor(options: SiteFoliageStreamerOptions) {
    this.#options = options;
    this.root.name = "site_foliage";
    options.scene.add(this.root);
  }

  register(registration: SiteFoliageRegistration): void {
    if (registration.unloadDistance <= registration.loadDistance) {
      throw new Error(`[site-foliage] ${registration.id} needs unload > load hysteresis`);
    }
    if (this.#entries.some((entry) => entry.registration.id === registration.id)) {
      throw new Error(`[site-foliage] duplicate registration '${registration.id}'`);
    }
    this.#entries.push({
      registration,
      status: "dormant",
      patch: null,
      eligibleSince: 0,
      generation: 0,
      retryAt: 0
    });
  }

  /** Master foliage toggle. While off: nothing draws, updates, or loads. */
  setVisible(visible: boolean): void {
    this.#visible = visible;
    this.root.visible = visible;
  }

  update(x: number, z: number): void {
    if (this.#disposed || !this.#visible) return;
    this.#focus.x = x;
    this.#focus.z = z;
    const now = performance.now();
    for (const entry of this.#entries) {
      const { registration } = entry;
      const distance = Math.hypot(x - registration.x, z - registration.z);
      if (entry.status === "ready") {
        if (distance >= registration.unloadDistance) this.#unload(entry);
        else entry.patch?.update(this.#focus);
        continue;
      }
      if (entry.status !== "dormant") continue;
      if (distance > registration.loadDistance) {
        entry.eligibleSince = 0;
        continue;
      }
      if (entry.eligibleSince === 0) entry.eligibleSince = now;
      if (now < entry.retryAt) continue;
      if (!this.#building) void this.#begin(entry);
    }
  }

  debugSnapshot(): SiteFoliageDebug[] {
    return this.#entries.map((entry) => ({
      id: entry.registration.id,
      status: entry.status,
      distance: Math.round(
        Math.hypot(this.#focus.x - entry.registration.x, this.#focus.z - entry.registration.z)
      )
    }));
  }

  /** Allocation-free readiness query for effects that depend on actual resident
   * foliage (for example, canopy rays must not run before their trees attach). */
  isReady(id: string): boolean {
    return this.#entries.some((entry) => entry.registration.id === id && entry.status === "ready");
  }

  /** Ask every ready patch to re-apply live tuning (no-op when unsupported). */
  refresh(): void {
    if (this.#disposed) return;
    for (const entry of this.#entries) {
      if (entry.status === "ready") entry.patch?.refresh?.();
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const entry of this.#entries) {
      if (entry.status === "ready") this.#unload(entry);
      entry.generation++;
    }
    this.root.removeFromParent();
  }

  /** One build at a time; a patch that finishes out of range, mid-toggle-off,
   * or after an unload/dispose retires itself instead of attaching. */
  async #begin(entry: EntryState): Promise<void> {
    this.#building = true;
    entry.status = "loading";
    const generation = entry.generation;
    const { registration } = entry;
    try {
      await this.#options.admit(registration, entry.eligibleSince);
      if (this.#stale(entry, generation)) return;
      const patch = await registration.build();
      try {
        // Contract order matters: an update() names the focus whose chunks the
        // patch compiles — ready never resolves for a patch that was never
        // focused (see the reference site implementations).
        patch.update(this.#focus);
        await patch.ready;
        patch.update(this.#focus);
        await this.#options.prepare(`site-foliage:${registration.id}`, patch.group, registration);
        // Detached root preparation temporarily exposes every descendant and
        // restores its captured visibility afterward. Close tree materials can
        // finish loading during that await, so the captured false state may be
        // stale by the time it is restored. Force one authoritative LOD publish
        // before attachment; otherwise populated close batches stay hidden and
        // their opaque landscape-card fallbacks remain overhead indefinitely.
        patch.update(this.#focus, true);
        const distance = Math.hypot(
          this.#focus.x - registration.x,
          this.#focus.z - registration.z
        );
        if (this.#stale(entry, generation) || distance >= registration.unloadDistance) {
          patch.dispose();
          if (entry.status === "loading") entry.status = "dormant";
          return;
        }
        entry.patch = patch;
        entry.status = "ready";
        this.root.add(patch.group);
        console.info(`[site-foliage] ${registration.id} planted`);
      } catch (error) {
        patch.dispose();
        throw error;
      }
    } catch (error) {
      if (error instanceof SiteFoliageYieldError) {
        // Hand the build slot to the arrival destination's entry; retry this
        // one shortly (eligibleSince is kept, so its starvation cap holds).
        entry.retryAt = performance.now() + 3000;
        return;
      }
      // Permanent: a failed build would otherwise hot-retry every cap window.
      // A later unload/dispose generation bump does not resurrect it.
      entry.status = "failed";
      console.warn(`[site-foliage] ${registration.id} unavailable:`, error);
    } finally {
      if (entry.status === "loading") entry.status = "dormant";
      this.#building = false;
    }
  }

  #stale(entry: EntryState, generation: number): boolean {
    return this.#disposed || !this.#visible || entry.generation !== generation;
  }

  #unload(entry: EntryState): void {
    entry.generation++;
    entry.patch?.dispose();
    entry.patch = null;
    entry.status = "dormant";
    entry.eligibleSince = 0;
    console.info(`[site-foliage] ${entry.registration.id} unplanted`);
  }
}
