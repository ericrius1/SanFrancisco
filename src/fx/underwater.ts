import * as THREE from "three/webgpu";
import { waterHeight, type WorldMap } from "../world/heightmap";

/**
 * Stylized underwater screen overlay — pure DOM/CSS, zero GPU cost (no extra
 * render pass, no pipeline rebuild). It kicks in whenever the *camera* dips
 * below the water surface (diving, or riding a car/boat that sinks), giving two
 * things the 3D water alone can't from below:
 *
 *   1. a light "you are underwater" blue-green cast + soft depth vignette, and
 *   2. a WATERLINE band that tracks the real surface by camera pitch, so you can
 *      always find which way is up.
 *
 * Deliberately LOW intensity: the goal is a readable cue, not a fog that blinds
 * you. The scene (and the seabed pillars that give depth cues) stays clearly
 * visible through it. No caustic pattern — the moving diagonal net read as an
 * annoying screen artefact, so it's gone.
 *
 * Everything animates via compositor-only properties (opacity + one transform).
 * Layering: appended INSIDE #app after the canvas at opacity 1 / no transform so
 * it never isolates; plain alpha-blend fills (a WebGPU canvas backdrop doesn't
 * reliably composite with CSS `mix-blend-mode`). #hud is a later sibling of #app,
 * so the HUD stays untinted.
 */
export class UnderwaterOverlay {
  #map: WorldMap;
  #root: HTMLDivElement;
  #tint: HTMLDivElement;
  #body: HTMLDivElement;
  #vignette: HTMLDivElement;
  #ease = 0; // smoothed presence 0..1 (soft fade at the surface crossing)
  #dir = new THREE.Vector3();

  constructor(app: HTMLElement, map: WorldMap) {
    this.#map = map;

    const root = document.createElement("div");
    root.id = "uw-root";
    root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;";

    // 1) tint — a light translucent teal→navy veil over the scene
    const tint = document.createElement("div");
    tint.style.cssText = "position:absolute;inset:0;opacity:0;background:#0c5f78;";

    // 2) body — tall vertical gradient: a soft brighter "surface" above the
    //    mid-band, a gentle waterline at the centre, deeper tone below. Translated
    //    so the mid-band lands on the surface's apparent horizon (the waterline).
    const body = document.createElement("div");
    body.style.cssText =
      "position:absolute;left:0;right:0;top:0;height:200vh;opacity:0;will-change:transform;" +
      "background:linear-gradient(to bottom," +
      "rgba(188,244,250,.42) 0%,rgba(150,232,242,.24) 44%," +
      "rgba(224,252,255,.62) 50%," + // the waterline: a soft bright band at the gradient centre
      "rgba(16,110,140,.30) 57%,rgba(6,44,70,.52) 100%);";

    // 3) vignette — gently darken the edges, a touch more with depth
    const vignette = document.createElement("div");
    vignette.style.cssText =
      "position:absolute;inset:0;opacity:0;background:radial-gradient(135% 100% at 50% 44%,transparent 46%,rgba(3,20,36,.6) 100%);";

    root.append(tint, body, vignette);
    app.appendChild(root);
    this.#root = root;
    this.#tint = tint;
    this.#body = body;
    this.#vignette = vignette;
  }

  /** Call every frame with the live camera and sim time (seconds). */
  update(camera: THREE.PerspectiveCamera, timeSec: number) {
    const cx = camera.position.x,
      cz = camera.position.z;
    // only over actual water — land dipping just below y=0 near shore isn't "underwater"
    const overWater = this.#map.isWater(cx, cz);
    const wy = waterHeight(cx, cz, timeSec);
    const depth = overWater ? wy - camera.position.y : -1; // >0 = camera submerged

    const target = depth > 0 ? 1 : 0;
    this.#ease += (target - this.#ease) * 0.18;
    if (this.#ease < 0.002) {
      if (this.#root.style.visibility !== "hidden") {
        this.#root.style.visibility = "hidden";
        this.#tint.style.opacity = this.#body.style.opacity = this.#vignette.style.opacity = "0";
      }
      return;
    }
    this.#root.style.visibility = "visible";

    // waterline screen position from camera pitch: the water plane's apparent
    // horizon sits where the view ray is horizontal. Looking up drops it toward
    // the bottom; above the band = surface/air, below = deep water.
    camera.getWorldDirection(this.#dir);
    const elev = Math.asin(THREE.MathUtils.clamp(this.#dir.y, -1, 1));
    const vHalf = ((camera.fov * Math.PI) / 180) / 2;
    let L = 0.5 + 0.5 * (Math.tan(elev) / Math.tan(vHalf));
    L = THREE.MathUtils.clamp(L, -0.35, 1.35);
    this.#body.style.transform = `translateY(${(L - 1) * 100}vh)`;

    // depth response — kept light so the world stays readable
    const d = Math.max(0, depth);
    const deepK = THREE.MathUtils.clamp(d / 16, 0, 1); // 0 at surface → 1 deep
    const e = this.#ease;

    this.#tint.style.background = lerpHex(0x0f6f8a, 0x06283e, deepK);
    this.#tint.style.opacity = String((0.24 + deepK * 0.26) * e);
    this.#body.style.opacity = String((0.42 + deepK * 0.22) * e);
    this.#vignette.style.opacity = String((0.16 + deepK * 0.3) * e);
  }
}

function lerpHex(a: number, b: number, t: number): string {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}
