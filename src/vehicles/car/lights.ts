import * as THREE from "three/webgpu";
import {
  cameraPosition,
  color,
  mix,
  normalWorld,
  positionWorld,
  saturate,
  smoothstep,
  uniform,
  uv
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { tunables } from "../../core/persist";
import { carBrakeHex, type CarConfig } from "./config";

// TSL node generics fight composition; `any` is the local idiom (see bayLights.ts).
type N = any;

/**
 * Fake headlamp beams + brake glow. Headlamps create NO THREE.Light (a
 * light-count change rebuilds every pipeline, a ~7s freeze). The forward throw
 * is carried entirely by two additive rim-lit cones (the volumetric beam) and a
 * soft additive ground splash, both gated by a sky-driven night intensity. The
 * brake glow just lerps the shared taillight emissive.
 */

// Sky-driven night ramp, rewritten every frame by Sky.#applySun: 0 in daylight,
// up through twilight so the beams only switch on after dark. Shared by every
// car's beam + splash material.
export const CAR_HEADLIGHT_INTENSITY = uniform(0);

/** A few live knobs in the "/" panel (movement › car › headlights · brake). */
export const CAR_HEADLIGHT_TUNING = tunables("vehicles.car.headlights", {
  beamStrength: { v: 1, min: 0, max: 4, step: 0.05, label: "beam glow" },
  beamReach: { v: 10, min: 3, max: 15, step: 0.5, label: "beam reach (m)" },
  edgeSoftness: { v: 1.8, min: 0.5, max: 4, step: 0.1, label: "edge feather" },
  bands: { v: 6, min: 2, max: 32, step: 1, label: "pixel bands" },
  warmth: { v: 0.7, min: 0, max: 1, step: 0.05, label: "warmth" },
  splashStrength: { v: 1.1, min: 0, max: 3, step: 0.05, label: "ground splash" }
});

// Shared shader uniforms — one set for the whole fleet; refreshed once a frame.
const uStrength = uniform(CAR_HEADLIGHT_TUNING.values.beamStrength);
const uReach = uniform(CAR_HEADLIGHT_TUNING.values.beamReach);
const uEdge = uniform(CAR_HEADLIGHT_TUNING.values.edgeSoftness);
const uBands = uniform(CAR_HEADLIGHT_TUNING.values.bands);
const uWarmth = uniform(CAR_HEADLIGHT_TUNING.values.warmth);
const uSplash = uniform(CAR_HEADLIGHT_TUNING.values.splashStrength);

// Live groups (one per car) so daytime beams are skipped outright rather than
// drawn as no-op additive geometry. Cars remove themselves on dispose.
const lightGroups = new Set<THREE.Group>();

/** Copy the panel values into the shared uniforms and gate beams by night. */
export function refreshCarHeadlightUniforms(): void {
  const t = CAR_HEADLIGHT_TUNING.values;
  uStrength.value = t.beamStrength;
  uReach.value = t.beamReach;
  uEdge.value = t.edgeSoftness;
  uBands.value = t.bands;
  uWarmth.value = t.warmth;
  uSplash.value = t.splashStrength;
  const on = Number(CAR_HEADLIGHT_INTENSITY.value) > 0.01;
  for (const group of lightGroups) group.visible = on;
}

// --- beam anatomy (metres) -------------------------------------------------
const GEO_LEN = 15; // generous cone length; the shader fades it to `beamReach`
const FAR_R = 2; // spread at the far end
const NEAR_R = 0.15; // stub at the lamp
const TILT = 0.16; // ~9° nose-down throw
const SPLAY = 0.22; // ~13° toe-out per lamp so the pair reads as two beams
const SPLASH_R = 2.6; // ground-pool radius where a beam lands
// Front is local -Z (see mesh.ts). One lamp each side of the nose.
const LAMPS: readonly (readonly [number, number, number])[] = [
  [-0.7, 0.2, -2.3],
  [0.7, 0.2, -2.3]
];
// Warm-cool tint pair, blended by `warmth`.
const COOL = color(0xbcd2ff) as N;
const WARM = color(0xffd9a0) as N;

// Taillight lerp: dim red running light → bright configurable brake colour.
const TAIL_REST_COLOR = 0xff1b18;
const TAIL_REST_INTENSITY = 1.1 * LIGHT_SCALE;
const TAIL_BRAKE_INTENSITY = 3.0 * LIGHT_SCALE;

type CarLights = {
  taillight: THREE.MeshStandardMaterial;
  restColor: THREE.Color;
  brakeColor: THREE.Color;
  restIntensity: number;
  brakeIntensity: number;
  group: THREE.Group;
  dispose(): void;
};

function beamMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  const beamColor = mix(COOL, WARM, uWarmth) as N;

  // Fresnel rim: brightest where the view grazes the cone silhouette, so the
  // hollow shell reads as an airy volume of light. A low ambient floor keeps the
  // head-on far end see-through (wispy) instead of a solid bright balloon.
  const viewDir = (cameraPosition as N).sub(positionWorld).normalize();
  const facing = (normalWorld as N).dot(viewDir).abs();
  const rim = facing.oneMinus();
  const vol = rim.pow(uEdge).mul(0.9).add(0.08) as N;

  // Along-cone fade: v runs 0 (at the lamp) → 1 (far end) on a CylinderGeometry.
  const dM = (uv() as N).y.mul(GEO_LEN);
  const emerge = smoothstep(0, 0.8, dM); // ease out of the housing
  const reachFade = smoothstep(uReach.mul(0.55) as N, uReach, dM).oneMinus();
  const profile = emerge.mul(reachFade) as N;

  // Posterize into `bands` steps — the stylised, low-res "pixel" banding.
  const bright = vol.mul(profile);
  const banded = bright.mul(uBands).add(0.5).floor().div(uBands) as N;

  mat.colorNode = beamColor.mul(banded).mul(uStrength).mul(CAR_HEADLIGHT_INTENSITY) as N;
  mat.transparent = true;
  mat.blending = THREE.AdditiveBlending;
  mat.depthWrite = false; // depthTest stays on: scene + terrain occlude the beam
  mat.toneMapped = false;
  mat.fog = false;
  mat.side = THREE.DoubleSide;
  return mat;
}

function splashMaterial(): THREE.MeshBasicNodeMaterial {
  const mat = new THREE.MeshBasicNodeMaterial();
  const splashColor = mix(color(0x9fb8ff) as N, color(0xffcf94) as N, uWarmth) as N;
  const d = (uv() as N).sub(0.5).length().mul(2);
  const falloff = smoothstep(0, 1, saturate(d)).oneMinus().pow(1.6) as N;
  mat.colorNode = splashColor.mul(falloff).mul(uSplash).mul(CAR_HEADLIGHT_INTENSITY) as N;
  mat.transparent = true;
  mat.blending = THREE.AdditiveBlending;
  mat.depthWrite = false;
  mat.toneMapped = false;
  mat.fog = false;
  mat.polygonOffset = true; // reversed-z: positive pulls the pool toward camera
  mat.polygonOffsetFactor = 2;
  mat.polygonOffsetUnits = 2;
  return mat;
}

/**
 * Attach the volumetric beam cones + ground splashes to a freshly built car and
 * wire the shared taillight material for brake glow. Returns the rig (also left
 * on `root.userData.carLights`) so the per-frame updater can lerp the taillights.
 */
export function attachCarLights(
  root: THREE.Group,
  taillight: THREE.MeshStandardMaterial,
  config: CarConfig
): CarLights {
  const group = new THREE.Group();
  group.name = "carLights";

  const beamMat = beamMaterial();
  const splashMat = splashMaterial();
  const beamGeo = new THREE.CylinderGeometry(FAR_R, NEAR_R, GEO_LEN, 24, 1, true);
  const splashGeo = new THREE.CircleGeometry(SPLASH_R, 20);
  splashGeo.rotateX(-Math.PI / 2); // lay flat, facing up

  const up = new THREE.Vector3(0, 1, 0);
  const dir = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const splashY = (root.userData.contactY as number) + 0.06;
  const ct = Math.cos(TILT);
  const st = Math.sin(TILT);

  for (const [lx, ly, lz] of LAMPS) {
    // Forward (-Z), tilted down, and toed outward so the pair diverges into two
    // legible beams instead of overlapping into one blob dead astern.
    const side = Math.sign(lx) || 1;
    dir.set(Math.sin(SPLAY) * ct * side, -st, -Math.cos(SPLAY) * ct).normalize();
    q.setFromUnitVectors(up, dir);

    // Cone: small end (v=0) pinned at the lamp, big end thrown down-range.
    const beam = new THREE.Mesh(beamGeo, beamMat);
    beam.position.set(lx + dir.x * (GEO_LEN / 2), ly + dir.y * (GEO_LEN / 2), lz + dir.z * (GEO_LEN / 2));
    beam.quaternion.copy(q);
    beam.castShadow = beam.receiveShadow = false;
    group.add(beam);

    // Splash: soft pool where this beam meets the ground plane ~1 m below.
    const travel = (ly - splashY) / Math.max(st, 1e-3);
    const splash = new THREE.Mesh(splashGeo, splashMat);
    splash.position.set(lx + dir.x * travel, splashY, lz + dir.z * travel);
    splash.castShadow = splash.receiveShadow = false;
    splash.renderOrder = 21;
    group.add(splash);
  }

  root.add(group);
  lightGroups.add(group);

  const rig: CarLights = {
    taillight,
    restColor: new THREE.Color(TAIL_REST_COLOR),
    brakeColor: new THREE.Color(carBrakeHex(config)),
    restIntensity: TAIL_REST_INTENSITY,
    brakeIntensity: TAIL_BRAKE_INTENSITY,
    group,
    dispose() {
      lightGroups.delete(group);
      beamGeo.dispose();
      splashGeo.dispose();
      beamMat.dispose();
      splashMat.dispose();
    }
  };
  // Seed the resting (unbraked) look so a parked car shows dim tail lights.
  taillight.emissive.copy(rig.restColor);
  taillight.emissiveIntensity = rig.restIntensity;
  root.userData.carLights = rig;
  return rig;
}

/** Refresh the configurable brake colour on a live car (customizer preview). */
export function previewCarBrakeColor(root: THREE.Group, config: CarConfig): void {
  const rig = root.userData.carLights as CarLights | undefined;
  if (rig) rig.brakeColor.set(carBrakeHex(config));
}

/** Per-frame: lerp the taillights red → brake colour by the 0..1 brake level. */
export function updateCarLights(root: THREE.Group, brake: number): void {
  const rig = root.userData.carLights as CarLights | undefined;
  if (!rig) return;
  const b = THREE.MathUtils.clamp(brake, 0, 1);
  rig.taillight.emissive.copy(rig.restColor).lerp(rig.brakeColor, b);
  rig.taillight.emissiveIntensity = THREE.MathUtils.lerp(rig.restIntensity, rig.brakeIntensity, b);
}
