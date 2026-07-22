import * as THREE from "three/webgpu";
import { setUnderwaterPostFx } from "../render/postfx";
import { warmHiddenRoot } from "../render/warmHiddenRoot";
import { SUN_DIR } from "../world/sky";
import { waterHeight, type WorldMap } from "../world/heightmap";
import { LIGHT_SCALE } from "../config";
import type { UnderwaterVolume } from "./underwaterVolume";

/**
 * Underwater package driver — the only piece that lives in the boot bundle.
 * Per frame it:
 *   - smooths a 0..1 camera-submersion state (same test the DOM
 *     UnderwaterOverlay uses: over real water and > 0.35 m under the surface),
 *   - feeds the permanently-installed post-FX fog/god-ray uniforms
 *     (render/postfx.ts — identity when dry, so no pipeline reselection ever),
 *   - computes the REFRACTED sun direction (air→water through a flat surface)
 *     and projects its screen anchor for the god rays,
 *   - lazily dynamic-imports fx/underwaterVolume.ts (marine snow + caustics)
 *     on first near-water approach and prewarms it hidden via warmHiddenRoot,
 *     so the first submersion never pays a synchronous pipeline compile.
 *
 * When the camera is dry and settled, the per-frame cost is one isWater lookup
 * and an early return.
 */

const SIGMA = new THREE.Vector3(0.38, 0.085, 0.05); // per-channel extinction /m
/** Ambient in-scatter, linear before LIGHT_SCALE — sunlit-turquoise family. */
const SCATTER_BASE = new THREE.Vector3(0.05, 0.17, 0.23);
const SUN_SCATTER_BASE = new THREE.Vector3(0.9, 0.72, 0.45);
const ETA = 1 / 1.333;

let ease = 0;
let dryLatched = false;
let loadStarted = false;
let volume: UnderwaterVolume | null = null;
let volumeReady = false;

// Read-only dev/probe introspection; no forcing paths, stripped from prod.
if (import.meta.env.DEV && typeof window !== "undefined") {
  (window as unknown as Record<string, unknown>).__uw = {
    get ease() {
      return ease;
    },
    get loadStarted() {
      return loadStarted;
    },
    get volumeReady() {
      return volumeReady;
    },
    get uniforms() {
      return {
        submersion: ease,
        latched: dryLatched
      };
    }
  };
}

const _lightTravel = new THREE.Vector3();
const _refracted = new THREE.Vector3();
const _toSun = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _project = new THREE.Vector3();
const _sunView = new THREE.Vector3(0, 0, 1);
const _scatterAmbient = new THREE.Vector3();
const _sunScatter = new THREE.Vector3();

function latchDry() {
  if (dryLatched) return;
  dryLatched = true;
  _scatterAmbient.set(0, 0, 0);
  _sunScatter.set(0, 0, 0);
  setUnderwaterPostFx({
    submersion: 0,
    sigmaScale: 1,
    scatterAmbient: _scatterAmbient,
    sunScatter: _sunScatter,
    sunViewDir: _sunView,
    sunScreenX: 0.5,
    sunScreenY: 0.35,
    rayAmount: 0
  });
}

export function updateUnderwaterFx(deps: {
  camera: THREE.PerspectiveCamera;
  map: WorldMap;
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  time: number;
  dt: number;
}) {
  const { camera, map, renderer, scene, time, dt } = deps;
  const cx = camera.position.x;
  const cz = camera.position.z;
  const overWater = map.isWater(cx, cz);
  if (!overWater && ease < 0.002) {
    ease = 0;
    latchDry();
    return;
  }

  const wy = overWater ? waterHeight(cx, cz, time) : -1e3;
  // same hysteresis family as UnderwaterOverlay: centimetre clearances under a
  // crest must not flash the fog on
  const submergedDepth = overWater ? wy - camera.position.y - 0.35 : -1;
  const target = submergedDepth > 0 ? 1 : 0;
  ease += (target - ease) * Math.min(1, dt * 5);
  if (target === 0 && ease < 0.002) ease = 0;

  // Lazy module: prime while merely NEAR the surface (swimming, boating) so
  // the hidden prewarm finishes before the first actual dive.
  const nearWater = overWater && camera.position.y < wy + 8;
  if ((nearWater || target === 1) && !loadStarted) {
    loadStarted = true;
    void import("./underwaterVolume")
      .then(async (m) => {
        const built = m.createUnderwaterVolume(map);
        scene.add(built.root);
        await warmHiddenRoot(renderer, camera, scene, built.root).catch(() => {});
        volume = built;
        volumeReady = true;
      })
      .catch((err) => console.warn("[underwater] volume unavailable:", err));
  }

  const lightUp = THREE.MathUtils.clamp(SUN_DIR.y * 2.8, 0.06, 1);
  if (volumeReady && volume) volume.update(camera, time, ease, lightUp);

  if (ease <= 0) {
    latchDry();
    return;
  }
  dryLatched = false;

  const camDepth = Math.max(0, wy - camera.position.y);

  // Refract the sun through a flat surface (air→water): where the sun's image
  // appears from below. SUN_DIR points toward the light source.
  _lightTravel.copy(SUN_DIR).negate();
  const cosi = Math.max(0, SUN_DIR.y);
  const k = Math.max(0, 1 - ETA * ETA * (1 - cosi * cosi));
  _refracted
    .copy(_lightTravel)
    .multiplyScalar(ETA)
    .add(_toSun.set(0, 1, 0).multiplyScalar(ETA * cosi - Math.sqrt(k)));
  _toSun.copy(_refracted).negate().normalize(); // from camera toward the sun image

  camera.getWorldDirection(_forward);
  const facing = _forward.dot(_toSun);
  const behindFade = THREE.MathUtils.clamp((facing - 0.05) / 0.3, 0, 1);
  _project.copy(camera.position).addScaledVector(_toSun, 100).project(camera);
  const sunScreenX = _project.x * 0.5 + 0.5;
  const sunScreenY = 0.5 - _project.y * 0.5;
  _sunView.copy(_toSun).transformDirection(camera.matrixWorldInverse);

  // Depth grading: deep = darker and bluer. Ambient scatter dims per channel
  // with the eye's own depth (downwelling light already lost that much red).
  _scatterAmbient
    .set(
      SCATTER_BASE.x * Math.exp(-SIGMA.x * 0.7 * camDepth),
      SCATTER_BASE.y * Math.exp(-SIGMA.y * 0.7 * camDepth),
      SCATTER_BASE.z * Math.exp(-SIGMA.z * 0.7 * camDepth)
    )
    .multiplyScalar(LIGHT_SCALE * lightUp);
  _sunScatter
    .copy(SUN_SCATTER_BASE)
    .multiplyScalar(LIGHT_SCALE * 0.55 * lightUp * Math.exp(-0.08 * camDepth));

  const rayDepthFade = THREE.MathUtils.clamp(1 - camDepth / 25, 0, 1);
  setUnderwaterPostFx({
    submersion: ease,
    sigmaScale: 1,
    scatterAmbient: _scatterAmbient,
    sunScatter: _sunScatter,
    sunViewDir: _sunView,
    sunScreenX,
    sunScreenY,
    rayAmount: ease * behindFade * rayDepthFade * lightUp * 1.1
  });
}
