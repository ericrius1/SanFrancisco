import { Pane } from "tweakpane";
import type * as THREE from "three/webgpu";
import {
  CONFIG,
  DEBRIS_TUNING,
  FLOWER_TUNING,
  FOLIAGE_TUNING,
  GRASS_TUNING,
  CITYGEN_TUNING,
  RENDER_QUALITY_PRESETS,
  RENDER_TUNING,
  WORLD_TUNING,
  type RenderQualityPreset,
  type ShadowQuality
} from "../config";
import { saveTweak } from "../core/persist";
import { addMovementTuning } from "../player/tuning";
import type { PlayerMode } from "../player/types";
import { DEBRIS_LIGHTS, WINDOW_GLOW } from "../world/facade";
import { CROWN_SLIDERS, CROWN_TUNING } from "../world/salesforceCrown";
import { BAY_LIGHTS_SLIDERS, BAY_LIGHTS_TUNING } from "../world/bayLights";
import { GOLDEN_GATE_LIGHTS_SLIDERS, GOLDEN_GATE_LIGHTS_TUNING } from "../world/goldenGateLights";
import { SKY_TUNING, type Sky } from "../world/sky";
import { POSTFX_TUNING, POSTFX_TOGGLES, POSTFX_QUALITY_KEYS, applyPostFxParams } from "../render/postfx";
import { VOICE_TUNING } from "../net/voice";
import { NATURE_AUDIO_TUNING } from "../audio";
import type { Fireworks } from "../fx/fireworks";
import type { TileStreamer } from "../world/tiles";

type WireframeMaterial = THREE.Material & { wireframe: boolean };

function isWireframeMaterial(material: THREE.Material): material is WireframeMaterial {
  return "wireframe" in material && typeof (material as WireframeMaterial).wireframe === "boolean";
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
  #mode: PlayerMode = "walk";
  #moveFolders: ReturnType<typeof addMovementTuning> | null = null;
  #renderer: THREE.WebGPURenderer;
  #sky: Sky;
  #onOpen: () => void;
  #fireworks: Fireworks | null;
  #tiles: TileStreamer | null;
  #scene: THREE.Scene | null;
  #postfx: { applyPostFx: () => void; applyPostQuality: () => void } | null;
  #setFoliageVisible: (visible: boolean) => void;
  #refreshFlowers: () => void;
  #refreshGrass: () => void;
  #lastRefresh = 0;
  #lastWireframeScan = 0;
  #wireframeOriginals = new Map<WireframeMaterial, boolean>();
  #wireframeActive = false;
  // pane bindings must not round-trip into sky.timeOfDay while the cycle runs
  #lightingView: Record<string, unknown> | null = null;
  #syncingFromSky = false;
  #syncingPane = false;

  constructor(
    renderer: THREE.WebGPURenderer,
    sky: Sky,
    onOpen: () => void = () => {},
    fireworks: Fireworks | null = null,
    tiles: TileStreamer | null = null,
    scene: THREE.Scene | null = null,
    postfx: { applyPostFx: () => void; applyPostQuality: () => void } | null = null,
    setFoliageVisible: (visible: boolean) => void = () => {},
    refreshFlowers: () => void = () => {},
    refreshGrass: () => void = () => {}
  ) {
    this.#renderer = renderer;
    this.#sky = sky;
    this.#onOpen = onOpen;
    this.#fireworks = fireworks;
    this.#tiles = tiles;
    this.#scene = scene;
    this.#postfx = postfx;
    this.#setFoliageVisible = setFoliageVisible;
    this.#refreshFlowers = refreshFlowers;
    this.#refreshGrass = refreshGrass;
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
    this.#applyMode();
  }

  #applyMode() {
    if (!this.#moveFolders) return;
    for (const [m, folder] of Object.entries(this.#moveFolders)) folder.hidden = m !== this.#mode;
  }

  /** Keep the pane in sync with the running day/night cycle (call per frame; throttled). */
  refresh() {
    if (RENDER_TUNING.values.wireframe) this.#applyWireframe(true);
    else if (this.#wireframeActive || this.#wireframeOriginals.size) this.#applyWireframe(false, true);
    if (!this.visible || !this.#pane) return;
    const now = performance.now();
    if (now - this.#lastRefresh < 250) return;
    this.#lastRefresh = now;
    if (this.#lightingView) {
      this.#syncingFromSky = true;
      this.#lightingView.timeOfDay = this.#sky.timeOfDay;
      this.#lightingView.realTime = this.#sky.realTime;
      this.#lightingView.sunsetAzimuth = this.#sky.sunsetAzimuth;
      this.#lightingView.cycleEnabled = this.#sky.cycleEnabled;
      this.#lightingView.nightBrightness = this.#sky.nightBrightness;
    }
    this.#syncingPane = true;
    this.#pane.refresh();
    this.#syncingPane = false;
    this.#syncingFromSky = false;
  }

  /** Re-read every binding now — call after "." resets values behind the pane's back. */
  syncNow() {
    this.#applyWireframe(RENDER_TUNING.values.wireframe, true);
    this.#setFoliageVisible(Boolean(FOLIAGE_TUNING.values.visible));
    if (this.#lightingView) {
      this.#syncingFromSky = true;
      this.#lightingView.timeOfDay = this.#sky.timeOfDay;
      this.#lightingView.realTime = this.#sky.realTime;
      this.#lightingView.sunsetAzimuth = this.#sky.sunsetAzimuth;
      this.#lightingView.cycleEnabled = this.#sky.cycleEnabled;
      this.#lightingView.cycleDuration = this.#sky.cycleDuration;
      this.#lightingView.nightBrightness = this.#sky.nightBrightness;
    }
    this.#syncingPane = true;
    this.#pane?.refresh();
    this.#syncingPane = false;
    this.#syncingFromSky = false;
  }

  #applyWireframe(on: boolean, force = false) {
    if (!this.#scene) return;
    const now = performance.now();
    if (on && !force && this.#wireframeActive && now - this.#lastWireframeScan < 500) return;
    if (!on && !force && !this.#wireframeActive && !this.#wireframeOriginals.size) return;
    this.#lastWireframeScan = now;

    if (!on) {
      for (const [material, original] of this.#wireframeOriginals) {
        if (material.wireframe !== original) {
          material.wireframe = original;
          material.needsUpdate = true;
        }
      }
      this.#wireframeOriginals.clear();
      // streamed tiles can pick up wireframe between scans; sweep anything still on
      this.#scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (!isWireframeMaterial(material) || !material.wireframe) continue;
          material.wireframe = false;
          material.needsUpdate = true;
        }
      });
      this.#wireframeActive = false;
      return;
    }

    this.#wireframeActive = true;
    this.#scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!isWireframeMaterial(material)) continue;
        if (!this.#wireframeOriginals.has(material)) this.#wireframeOriginals.set(material, material.wireframe);
        if (!material.wireframe) {
          material.wireframe = true;
          material.needsUpdate = true;
        }
      }
    });
  }

  #applyShadowQuality(value: unknown) {
    const quality = value as ShadowQuality;
    this.#renderer.shadowMap.enabled = quality !== "off";
    this.#sky.setShadowQuality(quality);
  }

  #setRenderValue(key: keyof typeof RENDER_TUNING.values, value: unknown) {
    (RENDER_TUNING.values as Record<string, unknown>)[key] = value;
    saveTweak(`render.${key}`, value);
  }

  #setPostValue(key: keyof typeof POSTFX_TUNING.values, value: unknown) {
    (POSTFX_TUNING.values as Record<string, unknown>)[key] = value;
    saveTweak(`postfx.${key}`, value);
  }

  #applyRenderPreset(value: unknown) {
    const preset = RENDER_QUALITY_PRESETS[value as RenderQualityPreset] ?? RENDER_QUALITY_PRESETS.balanced;
    this.#setRenderValue("maxPixelRatio", preset.maxPixelRatio);
    this.#setRenderValue("shadowQuality", preset.shadowQuality);
    this.#setPostValue("sceneSamples", preset.sceneSamples);

    this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, preset.maxPixelRatio));
    this.#renderer.setSize(window.innerWidth, window.innerHeight);
    this.#applyShadowQuality(preset.shadowQuality);
    this.#postfx?.applyPostQuality();
    this.#syncingPane = true;
    this.#pane?.refresh();
    this.#syncingPane = false;
  }

  #build() {
    const root = document.createElement("div");
    root.style.cssText =
      "position:fixed;top:12px;right:12px;z-index:40;width:300px;max-height:calc(100vh - 24px);overflow:auto;overscroll-behavior:contain";
    document.body.appendChild(root);
    this.#root = root;

    const pane = new Pane({ container: root, title: "tuning — / to close" });
    this.#pane = pane;

    // basics live at the root — the handful of things touched every session;
    // everything else tucks into the collapsed "advanced" folder below.
    // proxy so tweakpane's slider step never quantizes the live cycle clock
    const lightingView = {
      timeOfDay: this.#sky.timeOfDay,
      realTime: this.#sky.realTime,
      sunsetAzimuth: this.#sky.sunsetAzimuth,
      cycleEnabled: this.#sky.cycleEnabled,
      cycleDuration: this.#sky.cycleDuration,
      nightBrightness: this.#sky.nightBrightness
    };
    this.#lightingView = lightingView;
    const onSkyChange = (key: string, value: unknown, last: boolean) => {
      if (key === "timeOfDay") {
        if (this.#syncingFromSky) return;
        this.#sky.setTimeOfDay(value as number); // clears realTime — a manual pin
        return;
      }
      if (key === "realTime") {
        if (this.#syncingFromSky) return;
        if (value) this.#sky.followRealTime();
        else this.#sky.realTime = false;
        return;
      }
      if (key === "cycleEnabled") {
        this.#sky.cycleEnabled = value as boolean;
        if (value) this.#sky.realTime = false; // the cycle can't run while tracking real time
        return;
      }
      if (key === "cycleDuration") {
        this.#sky.cycleDuration = value as number;
        return;
      }
      if (key === "nightBrightness") {
        this.#sky.nightBrightness = value as number;
        return;
      }
      if (key === "sunsetAzimuth") this.#sky.sunsetAzimuth = value as number;
      // while the cycle runs, per-frame updates pick the new azimuth up live but
      // only rebake the IBL on elevation drift — force a rebake once the drag ends
      if (key === "sunsetAzimuth" && (last || !this.#sky.cycleEnabled)) this.#sky.setTimeOfDay(this.#sky.timeOfDay);
    };
    SKY_TUNING.bind(pane, {
      target: lightingView,
      keys: ["timeOfDay", "realTime", "cycleEnabled", "cycleDuration", "nightBrightness"],
      onChange: onSkyChange
    });
    RENDER_TUNING.bind(pane, {
      keys: ["renderQuality"],
      onChange: (_key, value) => this.#applyRenderPreset(value)
    });

    const fog = pane.addFolder({ title: "fog" });
    WORLD_TUNING.bind(fog, {
      keys: [
        "fogEnabled",
        "fogBase",
        "fogTop",
        "fogBank",
        "fogSoftness",
        "fogNoise",
        "fogScale",
        "fogDrift",
        "fogStart",
        "fogMarine",
        "fogFloor",
        "fogPeak",
        "fog",
        "fogHorizon",
        "fogHorizonStart",
        "fogHorizonSoftness"
      ],
      onChange: () => this.#sky.applyFogParams()
    });

    // stylized post effects: toggles rebuild the output shader (one quad
    // recompile), sliders are live uniforms — see render/postfx.ts
    const postfx = pane.addFolder({ title: "post fx", expanded: false });
    POSTFX_TUNING.bind(postfx, {
      onChange: (key) => {
        if ((POSTFX_TOGGLES as readonly string[]).includes(key)) this.#postfx?.applyPostFx();
        else if ((POSTFX_QUALITY_KEYS as readonly string[]).includes(key)) this.#postfx?.applyPostQuality();
        else applyPostFxParams();
      }
    });

    const advanced = pane.addFolder({ title: "advanced", expanded: false });

    const lighting = advanced.addFolder({ title: "lighting" });
    SKY_TUNING.bind(lighting, { target: lightingView, keys: ["sunsetAzimuth"], onChange: onSkyChange });
    RENDER_TUNING.bind(lighting, {
      keys: ["exposure", "maxPixelRatio", "farWindowGlow"],
      onChange: (key, value) => {
        if (key === "exposure") {
          this.#renderer.toneMappingExposure = value as number;
        } else if (key === "maxPixelRatio") {
          this.#renderer.setPixelRatio(Math.min(window.devicePixelRatio, value as number));
          this.#renderer.setSize(window.innerWidth, window.innerHeight);
        } else if (key === "farWindowGlow") {
          WINDOW_GLOW.far.value = value ? 1 : 0;
        }
      }
    });

    const render = advanced.addFolder({ title: "render" });
    RENDER_TUNING.bind(render, {
      keys: ["shadowQuality"],
      onChange: (key, value) => {
        if (this.#syncingPane) return;
        if (key === "shadowQuality") this.#applyShadowQuality(value);
      }
    });
    RENDER_TUNING.bind(render, {
      keys: ["wireframe"],
      onChange: (_key, value) => {
        if (this.#syncingPane) return;
        this.#applyWireframe(Boolean(value), true);
      }
    });

    // draw distance: one slider drives both streaming radii (unload trails load by a
    // fixed hysteresis margin so tiles never thrash at the boundary). forceScan makes
    // the change take effect immediately instead of on the next 30-frame scan
    const world = advanced.addFolder({ title: "draw distance" });
    WORLD_TUNING.bind(world, {
      keys: ["radius"],
      onChange: (key, value) => {
        if (key !== "radius") return;
        CONFIG.tileLoadRadius = value as number;
        CONFIG.tileUnloadRadius = (value as number) + 400;
        this.#tiles?.forceScan();
      }
    });

    const foliage = advanced.addFolder({ title: "foliage" });
    FOLIAGE_TUNING.bind(foliage, {
      onChange: (_key, value) => this.#setFoliageVisible(Boolean(value))
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

    // Grass ring: density + patchiness, independent of the flowers but sharing
    // the same global wind. Re-scatters on slider RELEASE (`last`) so the edit
    // shows immediately without waiting for the player to walk.
    const grass = foliage.addFolder({ title: "grass" });
    GRASS_TUNING.bind(grass, {
      onChange: (_key, _value, last) => {
        if (last) this.#refreshGrass();
      }
    });

    // procedural building streaming (src/world/citygen). The ring reads these live
    // each scan, so no onChange side-effect is needed — drag + watch the fps counter
    // and the near-detail / far-chunk band move.
    const citygenF = advanced.addFolder({ title: "buildings (citygen)", expanded: false });
    CITYGEN_TUNING.bind(citygenF, { onChange: () => {} });

    // debris window lights: hold fully lit, then flicker out; each chunk delays its
    // fade by a random slice of `spread` so a collapse dies out non-uniformly.
    // bind() persists edits; onChange pushes them into the live uniforms
    const debris = advanced.addFolder({ title: "debris lights" });
    DEBRIS_TUNING.bind(debris, {
      onChange: (key, value) => (DEBRIS_LIGHTS[key].value = value as number)
    });

    // Salesforce crown projection. Brightness is a multiplier on the sky-driven
    // CROWN_INTENSITY, which is rewritten every frame.
    const crown = advanced.addFolder({ title: "tower projection" });
    CROWN_SLIDERS.bind(crown, {
      onChange: (key, value) => (CROWN_TUNING[key].value = value as number)
    });

    // Bay Bridge light installation. Brightness multiplies the sky-driven
    // BAY_LIGHTS_INTENSITY, same shape as the crown above.
    const bay = advanced.addFolder({ title: "bay lights" });
    BAY_LIGHTS_SLIDERS.bind(bay, {
      onChange: (key, value) => (BAY_LIGHTS_TUNING[key].value = value as number)
    });

    const goldenGate = advanced.addFolder({ title: "golden gate lights" });
    GOLDEN_GATE_LIGHTS_SLIDERS.bind(goldenGate, {
      onChange: (key, value) => (GOLDEN_GATE_LIGHTS_TUNING[key].value = value as number)
    });

    // proximity voice chat: Voice.update polls these live every frame, so
    // plain persisted bindings are enough — no onChange side effects
    const voiceF = advanced.addFolder({ title: "voice chat" });
    VOICE_TUNING.bind(voiceF);

    // nature soundscape mix — engine polls these live each frame, no side effects
    const natureF = advanced.addFolder({ title: "nature audio", expanded: false });
    NATURE_AUDIO_TUNING.bind(natureF);

    this.#moveFolders = addMovementTuning(advanced);
    this.#applyMode();

    // fireworks bindings read/write the params object the sim consumes each frame
    this.#fireworks?.addTuning(advanced);
  }
}
