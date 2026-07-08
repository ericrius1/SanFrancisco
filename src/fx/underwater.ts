import * as THREE from "three/webgpu";
import { waterHeight, type WorldMap } from "../world/heightmap";

/**
 * Stylized underwater screen overlay — pure DOM/CSS, zero GPU cost (no extra
 * render pass, no pipeline rebuild). It kicks in whenever the *camera* dips
 * below the water surface (diving, or riding a car/boat that sinks), giving two
 * things the 3D water alone can't from below:
 *
 *   1. a clear "you are underwater" blue-green cast + depth vignette, and
 *   2. a bright WATERLINE band that tracks the real surface by camera pitch, so
 *      you can always find which way is up.
 *
 * How it stays free: everything animates via compositor-only properties. The
 * tint is one `mix-blend-mode: multiply` fill over the canvas (opacity drives
 * strength); the waterline is a tall vertical gradient div translated with
 * `transform` so its bright mid-band sits on the surface's apparent horizon; the
 * caustic shimmer is a CSS keyframe. No per-frame canvas redraw or layout.
 *
 * Layering note: appended INSIDE #app after the canvas and kept at opacity 1 /
 * no transform so it never isolates — the multiply child then blends against the
 * canvas backdrop. #hud is a later sibling of #app, so the HUD stays untinted.
 */
export class UnderwaterOverlay {
  #map: WorldMap;
  #root: HTMLDivElement;
  #tint: HTMLDivElement;
  #body: HTMLDivElement;
  #vignette: HTMLDivElement;
  #caustics: HTMLDivElement;
  #ease = 0; // smoothed presence 0..1 (soft fade at the surface crossing)
  #dir = new THREE.Vector3();

  constructor(app: HTMLElement, map: WorldMap) {
    this.#map = map;

    if (!document.getElementById("uw-keyframes")) {
      const style = document.createElement("style");
      style.id = "uw-keyframes";
      // slow lateral drift + breathe so the caustics feel like moving light
      style.textContent =
        "@keyframes uwDrift{0%{transform:translate3d(-6%,0,0)}50%{transform:translate3d(6%,1.5%,0)}100%{transform:translate3d(-6%,0,0)}}";
      document.head.appendChild(style);
    }

    const root = document.createElement("div");
    root.id = "uw-root";
    // opacity:1, no transform/filter → does NOT isolate, so multiply reaches the canvas
    root.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:1;";

    // 1) tint — a translucent teal→navy veil over the scene. Plain alpha blend
    //    (NOT mix-blend-mode: a WebGPU canvas backdrop doesn't reliably composite
    //    with CSS blend modes, so multiply washed out to nothing). Painted first,
    //    so the bright surface-ceiling gradient below still reads over the top.
    const tint = document.createElement("div");
    tint.style.cssText = "position:absolute;inset:0;opacity:0;background:#0c5f78;";

    // 2) body — tall vertical gradient: a bright washed "surface ceiling" ABOVE
    //    the mid-band (so you don't see a crisp horizon — you see the underside of
    //    the surface, Snell's-window style), a bright waterline at the centre, and
    //    darkening deep below. Translated so the mid-band lands on the waterline.
    const body = document.createElement("div");
    body.style.cssText =
      "position:absolute;left:0;right:0;top:0;height:200vh;opacity:0;will-change:transform;" +
      "background:linear-gradient(to bottom," +
      "rgba(206,252,255,.72) 0%,rgba(150,238,246,.55) 40%," +
      "rgba(233,255,255,.95) 50%," + // the waterline: a bright band at the gradient centre
      "rgba(14,120,150,.64) 56%,rgba(3,34,60,.92) 100%);";

    // 3) vignette — darken the edges, denser with depth
    const vignette = document.createElement("div");
    vignette.style.cssText =
      "position:absolute;inset:0;opacity:0;background:radial-gradient(125% 95% at 50% 42%,transparent 38%,rgba(2,16,32,.82) 100%);";

    // 4) caustics — animated light shimmer, strongest near the surface
    const caustics = document.createElement("div");
    caustics.style.cssText =
      "position:absolute;inset:-25% -10%;opacity:0;animation:uwDrift 11s ease-in-out infinite;" +
      "background:repeating-linear-gradient(68deg,transparent 0 26px,rgba(200,255,255,.16) 30px 34px,transparent 40px 72px)," +
      "repeating-linear-gradient(112deg,transparent 0 34px,rgba(160,245,255,.12) 40px 44px,transparent 52px 88px);";

    root.append(tint, body, vignette, caustics);
    app.appendChild(root);
    this.#root = root;
    this.#tint = tint;
    this.#body = body;
    this.#vignette = vignette;
    this.#caustics = caustics;
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
        this.#tint.style.opacity = this.#body.style.opacity = this.#vignette.style.opacity = this.#caustics.style.opacity = "0";
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

    // depth response
    const d = Math.max(0, depth);
    const deepK = THREE.MathUtils.clamp(d / 12, 0, 1); // 0 at surface → 1 deep
    const surfK = 1 - THREE.MathUtils.smoothstep(d, 0.6, 11); // 1 near surface → 0 deep
    const e = this.#ease;

    // teal veil deepens toward navy as you sink; strong enough even shallow that
    // it reads as underwater immediately, near-opaque in the depths
    this.#tint.style.background = lerpHex(0x0f6f8a, 0x041c30, deepK);
    this.#tint.style.opacity = String((0.5 + deepK * 0.42) * e);
    this.#body.style.opacity = String((0.6 + deepK * 0.35) * e);
    this.#vignette.style.opacity = String((0.32 + deepK * 0.55) * e);
    this.#caustics.style.opacity = String(0.3 * surfK * e);
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
