import type { BladeApi, FolderApi, Pane } from "tweakpane";
import * as THREE from "three/webgpu";
import {
  CAMERA_TUNING,
  CONFIG,
  FLOWER_TUNING,
  FOLIAGE_TUNING,
  GRASS_TUNING,
  CITYGEN_TUNING,
  INPUT_TUNING,
  RENDER_TUNING,
  WORLD_TUNING
} from "../config";
import { addMovementTuning } from "../player/tuning";
import type { PlayerMode } from "../player/types";
import { CROWN_SLIDERS, CROWN_TUNING } from "../world/salesforceCrown";
import { BAY_LIGHTS_SLIDERS, BAY_LIGHTS_TUNING } from "../world/bayLights";
import { GOLDEN_GATE_LIGHTS_SLIDERS, GOLDEN_GATE_LIGHTS_TUNING } from "../world/goldenGateLights";
import { SKY_TUNING, type Sky } from "../world/sky";
import { STREET_LIGHT_TUNING } from "../world/streetLightTuning";
import {
  POSTFX_TUNING,
  POSTFX_TOGGLES,
  POSTFX_RADIAL_LIGHT_KEYS,
  applyPostFxParams
} from "../render/postfx";
import { VOICE_TUNING } from "../net/voice";
import { NATURE_AUDIO_TUNING } from "../audio";
import { TEE_BEACON_TUNING } from "../gameplay/golf/tuning";
import type { Fireworks } from "../fx/fireworks";
import type { TileStreamer } from "../world/tiles";
import { TUNABLES_UPDATED_EVENT, withTweakBindingEventsSuppressed, saveTweak } from "../core/persist";
import { BUSKER_FIREFLY_TUNING } from "../gameplay/buskers/tuning";
import { VEGETATION_TUNING, applyVegetationTuning } from "../world/vegetation/tuning";
import { SHADOW_TUNING } from "../world/shadows/tuning";
import { TERRAIN_CLIPMAP_TUNING } from "../world/terrainClipmapTuning";
import { WATER_ECHO_TUNING } from "../world/waterEchoes";
import type { ContactShadowComplement } from "../render/contactShadows";
import { OVERLAY_TUNING } from "./overlays/tuning";
import type { OverlayContextFlags } from "./overlays/manager";
import { createFrameBudgetCheckpoint, yieldToFrame } from "../core/cooperativeWork";
import { PROCEDURAL_LAMP_TUNING } from "../world/citygen/interior/lampTuning";

type DebugRenderPipeline = {
  applyPostFx: () => void;
  applyRadialLightFx: () => void;
  setWireframe: (on: boolean) => void;
  setWireframeLodGradient: (on: boolean) => void;
  warmupPostFx?: () => Promise<void>;
  contactShadows: Pick<ContactShadowComplement, "configure" | "setEnabled">;
};

export type DebugMonitorBinding = { refresh(): void };

export type DebugFeatureTuningBuildResult = {
  /** Read-only bindings refreshed with the panel's existing 4 Hz monitor pass. */
  monitors?: DebugMonitorBinding[];
  /** Optional cleanup for listeners or other UI-only resources created by build. */
  dispose?: () => void;
};

/**
 * A feature-owned tuning surface. The panel owns the top-level folder while the
 * feature owns its contents, live side effects, and optional cleanup. Keeping
 * the callback here (rather than importing a feature module) preserves deferred
 * feature chunks such as the Japanese Tea Garden.
 */
export type DebugFeatureTuningRegistration = {
  /** Stable identity; registering the same id replaces the earlier surface. */
  id: string;
  /** Title of the collapsed top-level folder created when the pane exists. */
  title: string;
  build: (folder: FolderApi) => DebugFeatureTuningBuildResult | void;
  /** Re-apply non-live side effects after the "." factory reset. */
  sync?: () => void;
};

type DebugFeatureTuningRecord = {
  registration: DebugFeatureTuningRegistration;
  folder: FolderApi | null;
  monitors: DebugMonitorBinding[];
  dispose: (() => void) | null;
};

function isFolderApi(blade: BladeApi): blade is FolderApi {
  return "children" in blade && "title" in blade && "expanded" in blade;
}

function bladeLabel(blade: BladeApi): string {
  if ("label" in blade && typeof (blade as { label?: unknown }).label === "string") {
    return (blade as { label: string }).label;
  }
  if (isFolderApi(blade) && blade.title) return blade.title;
  return "";
}

function revealAll(blade: BladeApi) {
  blade.hidden = false;
  if (isFolderApi(blade)) for (const child of blade.children) revealAll(child);
}

/** Case-insensitive substring filter over the pane tree. Returns whether any
 * descendant matched (so parent folders stay visible when a child hits). A
 * folder whose own title matches reveals its whole subtree. */
function filterPane(blade: BladeApi, query: string): boolean {
  if (!query) {
    blade.hidden = false;
    if (isFolderApi(blade)) for (const child of blade.children) filterPane(child, query);
    return true;
  }

  const selfMatch = bladeLabel(blade).toLowerCase().includes(query);

  if (!isFolderApi(blade)) {
    blade.hidden = !selfMatch;
    return selfMatch;
  }

  if (selfMatch) {
    revealAll(blade);
    blade.expanded = true;
    return true;
  }

  let childMatch = false;
  for (const child of blade.children) {
    if (filterPane(child, query)) childMatch = true;
  }
  blade.hidden = !childMatch;
  if (childMatch) blade.expanded = true;
  return childMatch;
}

/**
 * Tweakpane debug panel, toggled with "/". Built lazily on first open so it costs
 * nothing until asked for. The first open spreads folder construction across
 * frames so the world keeps rendering; opening releases pointer lock (the pane
 * needs the mouse); clicking the canvas re-locks as usual.
 */
export class DebugPanel {
  visible = false;

  #pane: Pane | null = null;
  #root: HTMLDivElement | null = null;
  #buildTask: Promise<void> | null = null;
  #searchQuery = "";
  #mode: PlayerMode = "walk";
  #moveFolders: ReturnType<typeof addMovementTuning> | null = null;
  #renderer: THREE.WebGPURenderer;
  #sky: Sky;
  #onOpen: () => void;
  #fireworks: Fireworks | null;
  #tiles: TileStreamer | null;
  #postfx: DebugRenderPipeline | null;
  #setFoliageVisible: (visible: boolean) => void;
  #refreshFlowers: () => void;
  #refreshGrass: () => void;
  #refreshCitygenInteriors: () => void;
  #toggleProfiler: () => boolean;
  #lastRefresh = 0;
  /** Tracks the last applied wireframe flag so refresh() can catch external flips. */
  #wireframeActive = false;
  #wireframeBindings: { refresh(): void }[] = [];
  // pane bindings must not round-trip into sky.timeOfDay while the cycle runs
  #lightingView: Record<string, unknown> | null = null;
  #lightingBindings: { refresh(): void }[] = [];
  #monitorBindings: DebugMonitorBinding[] = [];
  #featureTunings = new Map<string, DebugFeatureTuningRecord>();
  #fogMonitorView: Record<string, string> | null = null;
  #syncingFromSky = false;
  #syncingPane = false;
  #overlayContext: OverlayContextFlags = { teaGardenWater: false };
  #overlayContextBlades: { teaGardenWater: { hidden: boolean } | null } = { teaGardenWater: null };

  constructor(
    renderer: THREE.WebGPURenderer,
    sky: Sky,
    onOpen: () => void = () => {},
    fireworks: Fireworks | null = null,
    tiles: TileStreamer | null = null,
    _scene: THREE.Scene | null = null,
    postfx: DebugRenderPipeline | null = null,
    setFoliageVisible: (visible: boolean) => void = () => {},
    refreshFlowers: () => void = () => {},
    refreshGrass: () => void = () => {},
    toggleProfiler: () => boolean = () => false,
    refreshCitygenInteriors: () => void = () => {}
  ) {
    this.#renderer = renderer;
    this.#sky = sky;
    this.#onOpen = onOpen;
    this.#fireworks = fireworks;
    this.#tiles = tiles;
    this.#postfx = postfx;
    this.#setFoliageVisible = setFoliageVisible;
    this.#refreshFlowers = refreshFlowers;
    this.#refreshGrass = refreshGrass;
    this.#toggleProfiler = toggleProfiler;
    this.#refreshCitygenInteriors = refreshCitygenInteriors;
    window.addEventListener(TUNABLES_UPDATED_EVENT, () => this.#refreshAllBindings());
    this.#applyShadowTuning();
    // Honor a persisted wireframe flag immediately (no wait for first refresh).
    if (RENDER_TUNING.values.wireframe) this.#applyWireframe(true);
  }

  toggle() {
    this.visible = !this.visible;
    if (this.visible && !this.#buildTask) {
      this.#buildTask = this.#build().catch((err) => {
        // Retry only when the shell never landed; a partial pane stays put.
        if (!this.#pane) this.#buildTask = null;
        console.warn("[debug] panel build failed:", err);
        throw err;
      });
    }
    this.#applyRootVisibility();
    if (this.visible) this.#onOpen();
  }

  /**
   * Keep the completed pane in layout so reopening it does not synchronously
   * restyle and lay out its large binding tree. Visibility/opacity are paint-
   * only changes; pointer-events and aria-hidden keep the closed pane inert.
   */
  #applyRootVisibility() {
    if (!this.#root) return;
    const visible = this.visible;
    this.#root.style.visibility = visible ? "visible" : "hidden";
    this.#root.style.opacity = visible ? "1" : "0";
    this.#root.style.pointerEvents = visible ? "auto" : "none";
    this.#root.setAttribute("aria-hidden", visible ? "false" : "true");
  }

  /** Finish inactive post-FX graphs only when someone opens that folder. */
  #warmPostFxGraphs() {
    void this.#postfx?.warmupPostFx?.().catch((err) => {
      console.warn("[debug] post-fx warmup failed:", err);
    });
  }

  /** Movement tuning is context-dependent — only the active mode's folder shows. */
  setMode(mode: PlayerMode) {
    this.#mode = mode;
    this.#applyFilter();
  }

  /**
   * Context-sensitive overlay bindings (tea garden water grid, …). Call when
   * proximity flags change so site overlays appear only while relevant.
   */
  setOverlayContext(flags: OverlayContextFlags) {
    this.#overlayContext = flags;
    this.#applyOverlayContext();
  }

  /**
   * Register a deferred feature's tuning surface without importing that feature
   * into this boot-critical module. Registration may happen before or after the
   * pane is first opened. The returned function unregisters only this exact
   * record, so a stale disposer cannot remove a newer replacement with the same
   * id (useful for HMR and feature recreation).
   */
  registerFeatureTuning(registration: DebugFeatureTuningRegistration): () => void {
    const previous = this.#featureTunings.get(registration.id);
    if (previous) this.#removeFeatureTuning(previous);

    const record: DebugFeatureTuningRecord = {
      registration,
      folder: null,
      monitors: [],
      dispose: null
    };
    this.#featureTunings.set(registration.id, record);
    this.#buildFeatureTuning(record);

    return () => {
      if (this.#featureTunings.get(registration.id) !== record) return;
      this.#featureTunings.delete(registration.id);
      this.#removeFeatureTuning(record);
      this.#applyFilter();
    };
  }

  /** Hide/show blades by the live search query, then re-assert mode-only movement. */
  #applyFilter() {
    if (!this.#pane) return;
    const query = this.#searchQuery.trim().toLowerCase();
    for (const child of this.#pane.children) filterPane(child, query);
    // Without a query, movement stays mode-gated. While searching, any matching
    // mode folder can surface (so you can find plane/boat knobs while walking).
    if (!query && this.#moveFolders) {
      for (const [m, folder] of Object.entries(this.#moveFolders)) {
        folder.hidden = m !== this.#mode;
      }
    }
    this.#applyOverlayContext();
  }

  /** Site overlays stay hidden until the player is nearby (unless searching). */
  #applyOverlayContext() {
    const query = this.#searchQuery.trim();
    const waterBlade = this.#overlayContextBlades.teaGardenWater;
    if (waterBlade) {
      waterBlade.hidden = query ? false : !this.#overlayContext.teaGardenWater;
    }
  }

  /** Push lightingView → checkbox/slider chrome without re-entering onChange. */
  #refreshLightingBindings() {
    this.#syncingPane = true;
    try {
      withTweakBindingEventsSuppressed(() => {
        for (const binding of this.#lightingBindings) binding.refresh();
      });
    } finally {
      this.#syncingPane = false;
    }
  }

  /** R key / pane checkbox — flip wireframe via the retained pass override. */
  toggleWireframe() {
    const next = !RENDER_TUNING.values.wireframe;
    RENDER_TUNING.values.wireframe = next;
    saveTweak("render.wireframe", next);
    this.#applyWireframe(next);
    this.#refreshWireframeBindings();
  }

  /** Keep the pane in sync with the running day/night cycle (call per frame; throttled). */
  refresh() {
    if (RENDER_TUNING.values.wireframe !== this.#wireframeActive) {
      this.#applyWireframe(RENDER_TUNING.values.wireframe);
    }
    if (!this.visible || !this.#pane) return;
    const now = performance.now();
    if (now - this.#lastRefresh < 250) return;
    this.#lastRefresh = now;
    if (this.#lightingView) {
      this.#syncingFromSky = true;
      this.#lightingView.timeOfDay = this.#sky.timeOfDay;
      this.#lightingView.realTime = this.#sky.realTime;
      this.#lightingView.nightBrightness = this.#sky.nightBrightness;
    }
    this.#syncingPane = true;
    try {
      withTweakBindingEventsSuppressed(() => {
        this.#refreshFogWeatherMonitor();
        for (const binding of this.#lightingBindings) binding.refresh();
        for (const binding of this.#monitorBindings) binding.refresh();
      });
    } finally {
      this.#syncingPane = false;
      this.#syncingFromSky = false;
    }
  }

  #refreshFogWeatherMonitor() {
    if (this.#fogMonitorView) this.#sky.writeFogWeatherDiagnostics(this.#fogMonitorView);
  }

  /** Push one coherent shadow state across projection maps and contact pass. */
  #applyShadowTuning() {
    const values = SHADOW_TUNING.values;
    this.#sky.applyShadowParams();
    this.#postfx?.contactShadows.configure({
      resolutionScale: values.contactResolutionScale,
      maxDistance: values.contactMaxDistance,
      thickness: values.contactThickness,
      intensity: values.contactIntensity,
      fadeStart: values.contactFadeStart,
      fadeEnd: values.contactFadeEnd,
      normalBias: values.contactNormalBias
    });
    this.#postfx?.contactShadows.setEnabled(values.enabled && values.contactEnabled);
  }

  /** Re-read every binding now — call after "." resets values behind the pane's back. */
  syncNow() {
    this.#applyWireframe(RENDER_TUNING.values.wireframe);
    this.#setFoliageVisible(Boolean(FOLIAGE_TUNING.values.visible));
    this.#tiles?.terrainClipmap?.applyTuning();
    this.#applyShadowTuning();
    for (const record of this.#featureTunings.values()) {
      try {
        record.registration.sync?.();
      } catch (error) {
        console.warn(`[debug] feature tuning sync failed (${record.registration.id})`, error);
      }
    }
    if (this.#lightingView) {
      this.#syncingFromSky = true;
      this.#lightingView.timeOfDay = this.#sky.timeOfDay;
      this.#lightingView.realTime = this.#sky.realTime;
      this.#lightingView.timeRatePercent = this.#sky.timeRatePercent;
      this.#lightingView.nightBrightness = this.#sky.nightBrightness;
    }
    try {
      this.#refreshAllBindings();
    } finally {
      this.#syncingFromSky = false;
    }
  }

  #refreshAllBindings() {
    if (!this.#pane) return;
    this.#syncingPane = true;
    try {
      withTweakBindingEventsSuppressed(() => {
        this.#refreshFogWeatherMonitor();
        this.#pane?.refresh();
      });
    } finally {
      this.#syncingPane = false;
    }
  }

  #refreshWireframeBindings() {
    if (!this.#wireframeBindings.length) return;
    this.#syncingPane = true;
    try {
      withTweakBindingEventsSuppressed(() => {
        for (const binding of this.#wireframeBindings) binding.refresh();
      });
    } finally {
      this.#syncingPane = false;
    }
  }

  /**
   * Insert index for a top-level folder so the pane stays alphabetical after
   * pinned `metta`, and before non-folder blades (the profiler button).
   */
  #alphabeticalFolderIndex(title: string): number {
    const pane = this.#pane;
    if (!pane) return 0;
    const children = pane.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!isFolderApi(child)) return i;
      const childTitle = child.title;
      if (!childTitle || childTitle === "metta") continue;
      if (childTitle.localeCompare(title, undefined, { sensitivity: "base" }) > 0) {
        return i;
      }
    }
    return children.length;
  }

  #buildFeatureTuning(record: DebugFeatureTuningRecord) {
    const pane = this.#pane;
    if (!pane || record.folder) return;

    const folder = pane.addFolder({
      title: record.registration.title,
      expanded: false,
      index: this.#alphabeticalFolderIndex(record.registration.title)
    });
    record.folder = folder;
    try {
      const result = record.registration.build(folder);
      record.monitors = result?.monitors ? [...result.monitors] : [];
      record.dispose = result?.dispose ?? null;
      this.#monitorBindings.push(...record.monitors);
    } catch (error) {
      pane.remove(folder);
      folder.dispose();
      record.folder = null;
      console.warn(`[debug] feature tuning build failed (${record.registration.id})`, error);
    }
    this.#applyFilter();
  }

  #removeFeatureTuning(record: DebugFeatureTuningRecord) {
    if (record.monitors.length > 0) {
      const removed = new Set(record.monitors);
      this.#monitorBindings = this.#monitorBindings.filter((binding) => !removed.has(binding));
      record.monitors = [];
    }
    try {
      record.dispose?.();
    } catch (error) {
      console.warn(`[debug] feature tuning cleanup failed (${record.registration.id})`, error);
    }
    record.dispose = null;
    if (record.folder) {
      this.#pane?.remove(record.folder);
      record.folder.dispose();
      record.folder = null;
    }
  }

  /**
   * Instant scene-wide wireframe via the render pipeline's PassNode override.
   * Uses a cloned camera so BundleGroup command caches for tiles/buildings are
   * not overwritten by the wireframe draw path (see pipeline.setWireframe).
   */
  #applyWireframe(on: boolean) {
    this.#postfx?.setWireframeLodGradient(RENDER_TUNING.values.wireframeLodGradient);
    this.#postfx?.setWireframe(on);
    this.#wireframeActive = on;
  }

  async #build() {
    if (this.#pane) return;

    // Tweakpane checkboxes: the real <input> is opacity:0 and 0×0, while the
    // visible mark sits in a sibling. Label mousedown calls preventDefault (to
    // avoid text selection), which also cancels the label→input activation, so
    // clicks on the visible box do nothing. Size the input to the mark and make
    // the decorative sibling ignore pointers so the input receives the click.
    //
    // Tweakpane also switches an opening folder to overflow:visible before its
    // height transition has moved the following rows. A tall folder therefore
    // paints over its siblings for the first 200 ms. Its `-cpl` class marks the
    // transition end, so clip only while expansion is in progress.
    if (!document.getElementById("sf-tp-ui-fixes")) {
      const style = document.createElement("style");
      style.id = "sf-tp-ui-fixes";
      style.textContent = [
        ".tp-ckbv_i{width:var(--cnt-usz,20px);height:var(--cnt-usz,20px);z-index:1;cursor:pointer}",
        ".tp-ckbv_w,.tp-ckbv_w *{pointer-events:none}",
        ".tp-fldv.tp-fldv-expanded:not(.tp-fldv-cpl)>.tp-fldv_c{overflow:hidden}"
      ].join("");
      document.head.appendChild(style);
    }

    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:40;width:300px;max-height:calc(100vh - 24px);overflow:auto;overscroll-behavior:contain;contain:layout style paint;transition:none";
    document.body.appendChild(root);
    this.#root = root;
    // Honor current visibility in case "/" was toggled off before the shell landed.
    this.#applyRootVisibility();

    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "search tweaks…";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("aria-label", "Search tweaks");
    search.style.cssText =
      "display:block;box-sizing:border-box;width:100%;margin:0 0 6px;padding:7px 10px;border:1px solid rgba(255,255,255,0.12);border-radius:4px;background:rgba(12,12,14,0.92);color:#eee;font:12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;outline:none";
    search.addEventListener("input", () => {
      this.#searchQuery = search.value;
      this.#applyFilter();
    });
    search.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        if (search.value) {
          search.value = "";
          this.#searchQuery = "";
          this.#applyFilter();
        } else {
          search.blur();
        }
        e.preventDefault();
      }
    });
    root.appendChild(search);

    // Tweakpane is debug-only tooling: fetch its chunk on first "/" instead of
    // shipping it in the boot bundle.
    const { Pane } = await import("tweakpane");
    const pane = new Pane({ container: root, title: "tuning — / to close" });
    this.#pane = pane;
    // Yield between heavy folder groups so the animation loop keeps presenting.
    const checkpoint = createFrameBudgetCheckpoint(6);

    // Master/meta knobs stay open at the top. Every other folder (and all nested
    // subfolders) starts collapsed — open only what you need.
    const meta = pane.addFolder({ title: "metta", expanded: true });

    // MASTER foliage switch. One checkbox hides AND stops per-frame work for
    // the ENTIRE vegetation system (all trees, grass, flowers, shrubs).
    FOLIAGE_TUNING.bind(meta, {
      onChange: (_key, value) => this.#setFoliageVisible(Boolean(value))
    });

    // MASTER draw distance — drives tile streaming radii (unload trails load
    // by a fixed hysteresis), the narrow cull fade, and citygen chunk reach.
    // forceScan makes it take effect now instead of on the next 30-frame scan.
    WORLD_TUNING.bind(meta, {
      keys: ["radius"],
      onChange: (key, value, last) => {
        if (key !== "radius") return;
        CONFIG.tileLoadRadius = value as number;
        CONFIG.tileUnloadRadius = (value as number) + 400;
        this.#sky.applyFogParams();
        if (last) this.#tiles?.forceScan();
      }
    });

    // MASTER fog switch — detail knobs live in the top-level fog folder.
    WORLD_TUNING.bind(meta, {
      keys: ["fogEnabled"],
      onChange: () => this.#sky.applyFogParams()
    });

    // proxy so tweakpane's slider step never quantizes the live cycle clock
    const lightingView = {
      timeOfDay: this.#sky.timeOfDay,
      realTime: this.#sky.realTime,
      timeRatePercent: this.#sky.timeRatePercent,
      nightBrightness: this.#sky.nightBrightness
    };
    this.#lightingView = lightingView;
    const onSkyChange = (key: string, value: unknown, _last: boolean) => {
      if (this.#syncingFromSky) return;
      if (key === "timeOfDay") {
        this.#sky.setTimeOfDay(value as number); // clears realTime — a manual pin
        lightingView.realTime = false;
        SKY_TUNING.values.realTime = false;
        saveTweak("sky.realTime", false);
        // keep the day cycle running so unchecking real-time (via scrub) still
        // advances; demos/probes that need a freeze set cycleEnabled=false
        this.#sky.cycleEnabled = true;
        this.#refreshLightingBindings();
        return;
      }
      if (key === "realTime") {
        if (value) {
          this.#sky.followRealTime();
        } else {
          // unchecking real SF time starts the local day cycle at the slider %
          this.#sky.realTime = false;
          this.#sky.cycleEnabled = true;
        }
        this.#sky.refreshFogWeatherSource();
        this.#refreshLightingBindings();
        return;
      }
      if (key === "timeRatePercent") {
        this.#sky.timeRatePercent = value as number;
        return;
      }
      if (key === "nightBrightness") {
        this.#sky.nightBrightness = value as number;
        return;
      }
    };
    this.#lightingBindings = SKY_TUNING.bind(meta, {
      target: lightingView,
      keys: ["timeOfDay", "realTime", "timeRatePercent", "nightBrightness"],
      onChange: onSkyChange
    });

    // Shell + metta are enough to show the pane; yield before the heavy folders.
    await yieldToFrame();

    // --- alphabetical folders (after metta) ---

    const advanced = pane.addFolder({ title: "advanced", expanded: false });

    // Bay Bridge light installation. Brightness multiplies the sky-driven
    // BAY_LIGHTS_INTENSITY, same shape as the crown below.
    const bay = advanced.addFolder({ title: "bay lights", expanded: false });
    BAY_LIGHTS_SLIDERS.bind(bay, {
      onChange: (key, value) => (BAY_LIGHTS_TUNING[key].value = value as number)
    });

    // free-orbit camera (C): duration of the O-key 180° flip around the target
    const cameraF = advanced.addFolder({ title: "camera", expanded: false });
    CAMERA_TUNING.bind(cameraF);

    // gamepad look polarity — master switch for every mode (walk + vehicles)
    const controls = advanced.addFolder({ title: "controls", expanded: false });
    INPUT_TUNING.bind(controls);

    // foliage detail knobs (the master on/off lives in the metta folder above).
    const foliage = advanced.addFolder({ title: "foliage", expanded: false });
    const grass = foliage.addFolder({ title: "grass", expanded: false });
    GRASS_TUNING.bind(grass, {
      onChange: (_key, _value, last) => {
        if (last) this.#refreshGrass();
      }
    });
    const sharedVegetation = foliage.addFolder({ title: "shared wind + canopy", expanded: false });
    VEGETATION_TUNING.bind(sharedVegetation, {
      onChange: () => applyVegetationTuning()
    });
    // Wildflower ring: density + clump↔scatter shaping. The ring reads these live on
    // its next re-scatter; force one now (on slider RELEASE only, `last`) so the edit
    // shows without waiting for the player to walk.
    const flowers = foliage.addFolder({ title: "wildflowers", expanded: false });
    FLOWER_TUNING.bind(flowers, {
      onChange: (_key, _value, last) => {
        if (last) this.#refreshFlowers();
      }
    });

    const goldenGate = advanced.addFolder({ title: "golden gate lights", expanded: false });
    GOLDEN_GATE_LIGHTS_SLIDERS.bind(goldenGate, {
      onChange: (key, value) => (GOLDEN_GATE_LIGHTS_TUNING[key].value = value as number)
    });

    // Alpha-hashed tee volumes poll these values into shader uniforms each
    // frame, so both the coverage and Fresnel rim can be judged in place.
    const golfBeacons = advanced.addFolder({ title: "golf tee beacons", expanded: false });
    TEE_BEACON_TUNING.bind(golfBeacons);

    const lighting = advanced.addFolder({ title: "lighting", expanded: false });
    RENDER_TUNING.bind(lighting, {
      // greyCards is a persisted toggle only — main's tick polls the live value
      // and poses the calibration chart (src/ui/calibrationChart.ts).
      keys: ["exposure", "greyCards"],
      onChange: (key, value) => {
        if (key === "exposure") {
          this.#renderer.toneMappingExposure = value as number;
        }
      }
    });
    // day grade: where daylight lands on the ACES curve (sun key + sky fill).
    // Read by #applySun — re-run it so a drag re-grades even with time pinned.
    SKY_TUNING.bind(lighting, {
      keys: ["sunDay", "hemiDay"],
      onChange: () => this.#sky.applyLightGrade()
    });
    // Both the cheap distant discs and close depth-projected pools poll this
    // shared group, so sliders stay live without shader recompiles.
    const streetLights = lighting.addFolder({ title: "street lights", expanded: false });
    STREET_LIGHT_TUNING.bind(streetLights);
    await checkpoint();

    this.#moveFolders = addMovementTuning(advanced);
    await yieldToFrame();

    // nature soundscape mix — engine polls these live each frame, no side effects
    const natureF = advanced.addFolder({ title: "nature audio", expanded: false });
    NATURE_AUDIO_TUNING.bind(natureF);

    // Particle systems live together; fireflies are a tiny CPU-driven ambient
    // group, while fireworks own their GPU simulation controls and monitors.
    const particles = advanced.addFolder({ title: "particles", expanded: false });
    const fireflies = particles.addFolder({ title: "busker fireflies", expanded: false });
    BUSKER_FIREFLY_TUNING.bind(fireflies);
    this.#monitorBindings.push(...(this.#fireworks?.addTuning(particles) ?? []));

    // Salesforce crown projection. Brightness is a multiplier on the sky-driven
    // CROWN_INTENSITY, which is rewritten every frame.
    const crown = advanced.addFolder({ title: "tower projection", expanded: false });
    CROWN_SLIDERS.bind(crown, {
      onChange: (key, value) => (CROWN_TUNING[key].value = value as number)
    });

    // proximity voice chat: Voice.update polls these live every frame, so
    // plain persisted bindings are enough — no onChange side effects
    const voiceF = advanced.addFolder({ title: "voice chat", expanded: false });
    VOICE_TUNING.bind(voiceF);
    await checkpoint();

    // procedural building DETAIL (src/world/citygen) — how many nearby buildings get
    // the full grammar mesh. Reach comes from the top-level draw-distance slider.
    // The ring reads these live each scan, so no onChange side-effect is needed —
    // drag + watch the fps counter and the near-detail band move.
    const citygenF = pane.addFolder({ title: "buildings (citygen)", expanded: false });
    CITYGEN_TUNING.bind(citygenF, { onChange: () => {} });
    const homeLamps = citygenF.addFolder({ title: "procedural home lamps", expanded: false });
    const lampDistribution = homeLamps.addFolder({ title: "distribution + finish", expanded: true });
    PROCEDURAL_LAMP_TUNING.bind(lampDistribution, {
      keys: ["enabled", "coverage", "finish", "lightTone"],
      onChange: (_key, _value, last) => {
        if (last) this.#refreshCitygenInteriors();
      }
    });
    const lampForm = homeLamps.addFolder({ title: "ribbon form", expanded: true });
    PROCEDURAL_LAMP_TUNING.bind(lampForm, {
      keys: ["rings", "radius", "depth", "ceilingDrop", "maxTilt", "variation"],
      onChange: (_key, _value, last) => {
        if (last) this.#refreshCitygenInteriors();
      }
    });
    const lampDetails = homeLamps.addFolder({ title: "construction", expanded: false });
    PROCEDURAL_LAMP_TUNING.bind(lampDetails, {
      keys: ["ribbonWidth", "ribbonThickness", "ribs", "cables", "glowSize"],
      onChange: (_key, _value, last) => {
        if (last) this.#refreshCitygenInteriors();
      }
    });

    // Fog — top-level (master on/off lives in metta above).
    const fog = pane.addFolder({ title: "fog", expanded: false });
    WORLD_TUNING.bind(fog, {
      keys: [
        "fogMaster",
        "fogWeather",
        "fogLiveInfluence",
        "fogTop",
        "fogBank",
        "fogNoise",
        "fogDrift",
        "fog"
      ],
      onChange: (key) => {
        this.#sky.applyFogParams();
        if (key === "fogWeather" || key === "fogLiveInfluence") {
          this.#sky.refreshFogWeatherSource();
        }
      }
    });
    this.#fogMonitorView = {};
    for (const key of [
      "driver",
      "SF date",
      "live mix",
      "bank / haze",
      "coastal front",
      "observations",
      "detail",
      "satellite",
      "received"
    ]) {
      this.#fogMonitorView[key] = "pending";
      this.#monitorBindings.push(
        fog.addBinding(this.#fogMonitorView, key, { readonly: true, label: key })
      );
    }
    this.#refreshFogWeatherMonitor();
    await checkpoint();

    // Stylized post effects: toggles select retained shader variants; sliders
    // are live uniforms — see render/postfx.ts. Boot only warms the active look;
    // expanding this folder finishes the other graphs so comparisons stay smooth.
    const postfx = pane.addFolder({ title: "post fx", expanded: false });
    postfx.on("fold", ({ expanded }) => {
      if (expanded) this.#warmPostFxGraphs();
    });
    POSTFX_TUNING.bind(postfx, {
      onChange: (key, _value, last) => {
        if (this.#syncingPane) return;
        if ((POSTFX_TOGGLES as readonly string[]).includes(key)) this.#postfx?.applyPostFx();
        else if ((POSTFX_RADIAL_LIGHT_KEYS as readonly string[]).includes(key)) {
          if (key !== "museumRaysResolution" || last) this.#postfx?.applyRadialLightFx();
        } else applyPostFxParams();
      }
    });
    await checkpoint();

    const rendering = pane.addFolder({ title: "rendering", expanded: false });
    RENDER_TUNING.bind(rendering, {
      keys: ["pixelRatio"],
      onChange: (_key, value) => {
        this.#renderer.setPixelRatio(value as number);
        this.#renderer.setSize(window.innerWidth, window.innerHeight);
      }
    });
    const waterEchoes = rendering.addFolder({ title: "water echoes", expanded: false });
    WATER_ECHO_TUNING.bind(waterEchoes, { onChange: () => {} });
    await checkpoint();

    const terrain = pane.addFolder({ title: "terrain", expanded: false });
    TERRAIN_CLIPMAP_TUNING.bind(terrain, {
      onChange: () => this.#tiles?.terrainClipmap?.applyTuning()
    });

    // Scene-wide topology inspection: neutral grey remains available, while
    // the default gradient reveals the near→far resolution falloff.
    const wireframe = pane.addFolder({ title: "wireframe", expanded: false });
    this.#wireframeBindings = RENDER_TUNING.bind(wireframe, {
      keys: ["wireframe", "wireframeLodGradient"],
      onChange: (key, value) => {
        if (this.#syncingPane) return;
        if (key === "wireframe") this.#applyWireframe(Boolean(value));
        else this.#postfx?.setWireframeLodGradient(Boolean(value));
      }
    });

    // Debug overlays — physics boxes, raycast, and context-sensitive site grids.
    // Worldwide toggles always show; tea-garden water grid appears when nearby.
    const overlays = pane.addFolder({ title: "overlays", expanded: false });
    OVERLAY_TUNING.bind(overlays, {
      keys: ["physicsColliders", "physicsCarpet", "playerBody", "raycast"]
    });
    const waterBindings = OVERLAY_TUNING.bind(overlays, {
      keys: ["teaGardenWaterGrid"]
    });
    this.#overlayContextBlades.teaGardenWater =
      (waterBindings[0] as unknown as { hidden: boolean } | undefined) ?? null;
    this.#applyOverlayContext();

    // Strength + contact essentials only. Bias / fade minutiae stay off the pane.
    const shadows = pane.addFolder({ title: "shadows", expanded: false });
    SHADOW_TUNING.bind(shadows, {
      keys: [
        "enabled",
        "heroStrength",
        "localStrength",
        "farStrength",
        "farFieldStrength",
        "contactEnabled",
        "contactIntensity",
        "contactResolutionScale",
        "contactMaxDistance",
        "contactFadeEnd"
      ],
      onChange: (key, _value, last) => {
        if (this.#syncingPane) return;
        // Avoid resizing the R8 target for every pointer-move while dragging.
        if (key === "contactResolutionScale" && !last) return;
        this.#applyShadowTuning();
      }
    });
    await checkpoint();

    // Optional feature modules register callbacks rather than being imported by
    // this file. Materialize any surfaces that arrived before the first `/` now;
    // later registrations build immediately in registerFeatureTuning().
    for (const record of this.#featureTunings.values()) {
      this.#buildFeatureTuning(record);
      await checkpoint();
    }

    // Full GPU profiler (three.js Inspector: FPS/CPU/GPU graph, timing, memory).
    // Heavy — per-frame GPU timestamp queries + canvas redraw — so it's OFF by
    // default; the cheap green Stats box covers everyday FPS watching. Deliberate
    // opt-in via this button, last in the pane so you scroll to the bottom for it.
    let profilerOn = false;
    const profiler = pane.addButton({ title: "open full profiler ▸", label: "profiler" });
    profiler.on("click", () => {
      profilerOn = this.#toggleProfiler();
      profiler.title = profilerOn ? "close full profiler ▾" : "open full profiler ▸";
    });

    this.#applyFilter();
  }
}
