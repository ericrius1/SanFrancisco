import * as THREE from "three/webgpu";
import { Inspector } from "three/addons/inspector/Inspector.js";
import Stats from "three/addons/libs/stats.module.js";
import type { DebugPanel } from "../ui/debug";

/** Owns renderer diagnostics DOM, inspector state, and cleanup. */
export class RendererDiagnostics {
  debugOn = false;
  inspectorOn = false;

  #renderer: THREE.WebGPURenderer;
  #inspector: Inspector | null = null;
  #inspectorAttached = false;
  #stats = new Stats();
  #style: HTMLStyleElement | null = null;

  constructor(renderer: THREE.WebGPURenderer) {
    this.#renderer = renderer;
    this.#stats.dom.style.cssText += ";position:fixed;top:12px;left:12px;z-index:40";
    this.#stats.dom.style.display = "none";
    document.body.appendChild(this.#stats.dom);
  }

  setDebugUI(on: boolean, panel: DebugPanel): void {
    this.debugOn = on;
    if (panel.visible !== on) panel.toggle();
    this.#stats.dom.style.display = on ? "" : "none";
    if (!on) this.setInspector(false);
  }

  toggleInspector(): boolean {
    this.setInspector(!this.inspectorOn);
    return this.inspectorOn;
  }

  setInspector(on: boolean): void {
    if (this.inspectorOn === on) return;
    this.inspectorOn = on;
    // Renderer brackets each loop call with inspector begin/finish. Defer the
    // swap so it cannot tear that pair halfway through a frame.
    requestAnimationFrame(() => this.#applyInspector());
  }

  updateStats(): void {
    if (this.debugOn) this.#stats.update();
  }

  dispose(): void {
    this.inspectorOn = false;
    const backend = this.#renderer.backend as unknown as { trackTimestamp: boolean };
    backend.trackTimestamp = false;
    if (this.#inspectorAttached) this.#renderer.inspector = new THREE.InspectorBase();
    this.#inspectorAttached = false;
    this.#stats.dom.remove();
    this.#inspector?.domElement.remove();
    this.#style?.remove();
    this.#style = null;
  }

  #applyInspector(): void {
    const backend = this.#renderer.backend as unknown as { trackTimestamp: boolean };
    if (this.inspectorOn) {
      if (!this.#inspector) {
        this.#style = document.createElement("style");
        this.#style.textContent = [
          ".three-inspector .profiler-toggle { right: auto !important; left: 50% !important; transform: translateX(-50%); }",
          ".three-inspector .profiler-mini-panel { right: auto !important; left: 50% !important; transform: translateX(-50%); }"
        ].join("\n");
        document.head.appendChild(this.#style);
        this.#inspector = new Inspector();
        // Detaching can null the renderer while a timestamp callback is still
        // in flight. InspectorBase + trackTimestamp=false already stop work.
        const attach = this.#inspector.setRenderer.bind(this.#inspector);
        (this.#inspector as unknown as { setRenderer: (value: unknown) => unknown }).setRenderer = (value) =>
          value === null ? this.#inspector : attach(value as THREE.WebGPURenderer);
        this.#renderer.inspector = this.#inspector;
        this.#inspectorAttached = true;
        this.#inspector.init();
      } else if (!this.#inspectorAttached) {
        this.#renderer.inspector = this.#inspector;
        this.#inspectorAttached = true;
      }
      backend.trackTimestamp = true;
      this.#inspector.domElement.style.display = "";
      return;
    }
    // Keep the inspector attached after first use. Replacing renderer.inspector
    // is a live renderer-state mutation and used to overlap the next frame,
    // causing a long hitch and a transient atmosphere/fog-free render. Pausing
    // timestamp collection and hiding its DOM are sufficient; reopening is now
    // a presentation-only operation and preserves every renderer/game setting.
    backend.trackTimestamp = false;
    if (this.#inspector) this.#inspector.domElement.style.display = "none";
  }
}
