// Grey-card calibration chart — a camera-locked row of matte spheres at known
// linear albedos (5% / 18% / 50% / 90%, darkest left) for reading where the
// light rig + ACES grade actually places real surface values. Toggled in the
// "/" panel (advanced → lighting → "grey cards"); tools/calibration-probe.mjs
// samples it headless across the day cycle and prints measured-vs-predicted
// values. The spheres are ordinary lit standard materials on purpose: they
// measure what a matte surface does in THIS pipeline (sun + hemi + analytic
// IBL + CSM shadows + tone mapping), not an idealized Lambert term — expect a
// few percent of IBL/specular on top of the textbook prediction.
import * as THREE from "three/webgpu";

/** Linear albedos, darkest → brightest, left → right on screen. */
export const CARD_ALBEDOS = [0.05, 0.18, 0.5, 0.9] as const;

const AHEAD = 2.2; // metres in front of the camera
const DROP = 0.7; // metres below the view axis — clear of the aim cursor + player
const SPACING = 0.55;
const RADIUS = 0.22;

export class CalibrationChart {
  readonly group = new THREE.Group();
  readonly spheres: { albedo: number; mesh: THREE.Mesh }[] = [];
  /** Sphere radius (m) — the probe sizes its pixel sampling disc from this. */
  readonly radius = RADIUS;

  constructor(scene: THREE.Object3D) {
    const geo = new THREE.SphereGeometry(RADIUS, 32, 16);
    CARD_ALBEDOS.forEach((albedo, i) => {
      const mat = new THREE.MeshStandardNodeMaterial({
        color: new THREE.Color(albedo, albedo, albedo), // linear working space
        roughness: 1,
        metalness: 0
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set((i - (CARD_ALBEDOS.length - 1) / 2) * SPACING, -DROP, -AHEAD);
      mesh.castShadow = false; // receiving light IS the measurement; casting just decorates
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.spheres.push({ albedo, mesh });
    });
    this.group.name = "calibrationChart";
    this.group.visible = false;
    scene.add(this.group);
  }

  /**
   * Pose the row in front of the final camera. Call once per frame after the
   * chase cam / cine hook has settled the camera; free while hidden.
   */
  sync(camera: THREE.Camera, on: boolean) {
    if (this.group.visible !== on) this.group.visible = on;
    if (!on) return;
    this.group.position.copy(camera.position);
    this.group.quaternion.copy(camera.quaternion);
  }
}
