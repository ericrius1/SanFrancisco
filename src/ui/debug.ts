import { Pane } from "tweakpane";
import type { BladeApi, FolderApi } from "tweakpane";
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
import {
  POSTFX_TUNING,
  POSTFX_TOGGLES,
  POSTFX_QUALITY_KEYS,
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
import type { ContactShadowComplement } from "../render/contactShadows";

type DebugRenderPipeline = {
  applyPostFx: () => void;
  applyPostQuality: () => void;
  applyRadialLightFx: () => void;
  setWireframe: (on: boolean) => void;
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
 * nothing until asked for. Opening releases pointer lock (the pane needs the mouse);
 * clicking the canvas re-locks as usual.
 */
export class DebugPanel {
  visible = false;

  #pane: Pane | null = null;
  #root: HTMLDivElement | null = null;
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
    toggleProfiler: () => boolean = () => false
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
    window.addEventListener(TUNABLES_UPDATED_EVENT, () => this.#refreshAllBindings());
    this.#applyShadowTuning();
    // Honor a persisted wireframe flag immediately (no wait for first refresh).
    if (RENDER_TUNING.values.wireframe) this.#applyWireframe(true);
  }

  toggle() {
    this.visible = !this.visible;
    if (this.visible && !this.#pane) this.#build();
    if (this.#root) this.#root.style.display = this.visible ? "" : "none";
    if (this.visible) this.#onOpen();
  }

  /** Movement tuning is context-dependent — only the active mode's folder shows. */
  setMode(mode: PlayerMode) {
    this.#mode = mode;
    this.#applyFilter();
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
      if (child.title === "metta") continue;
      if (child.title.localeCompare(title, undefined, { sensitivity: "base" }) > 0) {
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
    this.#postfx?.setWireframe(on);
    this.#wireframeActive = on;
  }

  #build() {
    // Tweakpane checkboxes put an SVG checkmark mark over a zero-size <input>.
    // Clicks on that SVG do not activate the <label> (SVG hit-testing quirk), so
    // the visible box looks dead — especially when unchecked (invisible path
    // still captures the pointer). Let clicks fall through to the label/wrap.
    if (!document.getElementById("sf-tp-checkbox-fix")) {
      const style = document.createElement("style");
      style.id = "sf-tp-checkbox-fix";
      style.textContent = ".tp-ckbv_w svg{pointer-events:none}";
      document.head.appendChild(style);
    }

    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:40;width:300px;max-height:calc(100vh - 24px);overflow:auto;overscroll-behavior:contain";
    document.body.appendChild(root);
    this.#root = root;

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

    const pane = new Pane({ container: root, title: "tuning — / to close" });
    this.#pane = pane;

    // Master/meta knobs stay open at the top. Everything else is collapsed and
    // sorted alphabetically below.
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

    this.#wireframeBindings = RENDER_TUNING.bind(meta, {
      keys: ["wireframe"],
      onChange: (_key, value) => {
        if (this.#syncingPane) return;
        this.#applyWireframe(Boolean(value));
      }
    });

    // --- alphabetical folders (after metta) ---

    const advanced = pane.addFolder({ title: "advanced", expanded: false });

    // Bay Bridge light installation. Brightness multiplies the sky-driven
    // BAY_LIGHTS_INTENSITY, same shape as the crown below.
    const bay = advanced.addFolder({ title: "bay lights" });
    BAY_LIGHTS_SLIDERS.bind(bay, {
      onChange: (key, value) => (BAY_LIGHTS_TUNING[key].value = value as number)
    });

    // free-orbit camera (C): duration of the O-key 180° flip around the target
    const cameraF = advanced.addFolder({ title: "camera" });
    CAMERA_TUNING.bind(cameraF);

    // gamepad look polarity — master switch for every mode (walk + vehicles)
    const controls = advanced.addFolder({ title: "controls" });
    INPUT_TUNING.bind(controls);

    // foliage detail knobs (the master on/off lives in the metta folder above).
    const foliage = advanced.addFolder({ title: "foliage" });
    const grass = foliage.addFolder({ title: "grass" });
    GRASS_TUNING.bind(grass, {
      onChange: (_key, _value, last) => {
        if (last) this.#refreshGrass();
      }
    });
    const sharedVegetation = foliage.addFolder({ title: "shared wind + canopy" });
    VEGETATION_TUNING.bind(sharedVegetation, {
      onChange: () => applyVegetationTuning()
    });
    // Wildflower ring: density + clump↔scatter shaping. The ring reads these live on
    // its next re-scatter; force one now (on slider RELEASE only, `last`) so the edit
    // shows without waiting for the player to walk.
    const flowers = foliage.addFolder({ title: "wildflowers" });
    FLOWER_TUNING.bind(flowers, {
      onChange: (_key, _value, last) => {
        if (last) this.#refreshFlowers();
      }
    });

    const goldenGate = advanced.addFolder({ title: "golden gate lights" });
    GOLDEN_GATE_LIGHTS_SLIDERS.bind(goldenGate, {
      onChange: (key, value) => (GOLDEN_GATE_LIGHTS_TUNING[key].value = value as number)
    });

    // Alpha-hashed tee volumes poll these values into shader uniforms each
    // frame, so both the coverage and Fresnel rim can be judged in place.
    const golfBeacons = advanced.addFolder({ title: "golf tee beacons" });
    TEE_BEACON_TUNING.bind(golfBeacons);

    const lighting = advanced.addFolder({ title: "lighting" });
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

    this.#moveFolders = addMovementTuning(advanced);

    // nature soundscape mix — engine polls these live each frame, no side effects
    const natureF = advanced.addFolder({ title: "nature audio", expanded: false });
    NATURE_AUDIO_TUNING.bind(natureF);

    // Particle systems live together; fireflies are a tiny CPU-driven ambient
    // group, while fireworks own their GPU simulation controls and monitors.
    const particles = advanced.addFolder({ title: "particles" });
    const fireflies = particles.addFolder({ title: "busker fireflies" });
    BUSKER_FIREFLY_TUNING.bind(fireflies);
    this.#monitorBindings.push(...(this.#fireworks?.addTuning(particles) ?? []));

    // Salesforce crown projection. Brightness is a multiplier on the sky-driven
    // CROWN_INTENSITY, which is rewritten every frame.
    const crown = advanced.addFolder({ title: "tower projection" });
    CROWN_SLIDERS.bind(crown, {
      onChange: (key, value) => (CROWN_TUNING[key].value = value as number)
    });

    // proximity voice chat: Voice.update polls these live every frame, so
    // plain persisted bindings are enough — no onChange side effects
    const voiceF = advanced.addFolder({ title: "voice chat" });
    VOICE_TUNING.bind(voiceF);
    // procedural building DETAIL (src/world/citygen) — how many nearby buildings get
    // the full grammar mesh. Reach comes from the top-level draw-distance slider.
    // The ring reads these live each scan, so no onChange side-effect is needed —
    // drag + watch the fps counter and the near-detail band move.
    const citygenF = pane.addFolder({ title: "buildings (citygen)", expanded: false });
    CITYGEN_TUNING.bind(citygenF, { onChange: () => {} });

    // Stylized post effects: toggles select retained shader variants; sliders
    // are live uniforms — see render/postfx.ts.
    const postfx = pane.addFolder({ title: "post fx", expanded: false });
    POSTFX_TUNING.bind(postfx, {
      onChange: (key, _value, last) => {
        if (this.#syncingPane) return;
        if ((POSTFX_TOGGLES as readonly string[]).includes(key)) this.#postfx?.applyPostFx();
        else if ((POSTFX_QUALITY_KEYS as readonly string[]).includes(key)) {
          if (last) this.#postfx?.applyPostQuality();
        }
        else if ((POSTFX_RADIAL_LIGHT_KEYS as readonly string[]).includes(key)) {
          if (key !== "museumRaysResolution" || last) this.#postfx?.applyRadialLightFx();
        } else applyPostFxParams();
      }
    });

    // Render knobs. Fog nests here.
    const rendering = pane.addFolder({ title: "rendering", expanded: false });
    RENDER_TUNING.bind(rendering, {
      keys: ["pixelRatio"],
      onChange: (_key, value) => {
        this.#renderer.setPixelRatio(value as number);
        this.#renderer.setSize(window.innerWidth, window.innerHeight);
      }
    });
    // collider x-ray: persisted toggle only — main's tick polls the live value
    // each frame, gathers active colliders and drives the overlay.
    RENDER_TUNING.bind(rendering, { keys: ["colliderDebug"] });
    const fog = rendering.addFolder({ title: "fog", expanded: false });
    WORLD_TUNING.bind(fog, {
      keys: [
        "fogEnabled",
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

    // Optional feature modules register callbacks rather than being imported by
    // this file. Materialize any surfaces that arrived before the first `/` now;
    // later registrations build immediately in registerFeatureTuning().
    for (const record of this.#featureTunings.values()) this.#buildFeatureTuning(record);

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
