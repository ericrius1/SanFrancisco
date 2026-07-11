import * as THREE from "three/webgpu";
import { color, positionLocal } from "three/tsl";
import { LIGHT_SCALE } from "../../config";

type N = any;

/**
 * The "which way to the next thing" pointer: a glowing chevron that floats
 * above the golfer and swings to aim at the current objective — the next
 * glowing tee while walking up, the resting ball after a shot, the pin while
 * you settle over it. It hovers, bobs and pops away once you're on top of the
 * target so it never nags at close range.
 *
 * Opaque, depth-test off (always on top) with a dark backing shell for contrast
 * on pale skies. A scale-pop on show/hide stands in for an alpha fade — the
 * WebGPU transparent+opacity path renders unreliably here, and a hard-edged
 * chevron reads better as a waypoint than a faint translucent one anyway.
 */
export class GolfGuide {
  #group = new THREE.Group();
  #spin = new THREE.Group(); // yaws to point at the target
  #shown = false;
  #vis = 0; // eased 0..1, drives a scale pop

  constructor(scene: THREE.Scene) {
    this.#group.name = "golf-guide";
    this.#group.add(this.#spin);

    const A = 1.7; // overall size
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.98 * A); // tip (forward/up)
    shape.lineTo(0.66 * A, -0.12 * A);
    shape.lineTo(0.3 * A, -0.12 * A);
    shape.lineTo(0, 0.36 * A);
    shape.lineTo(-0.3 * A, -0.12 * A);
    shape.lineTo(-0.66 * A, -0.12 * A);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);

    // NOTE: depthTest stays ON. depthTest=false vanishes under this scene's
    // reversed-z depth (same MeshBasicNodeMaterial gotcha as the underwater
    // veil). Floating above the golfer, terrain rarely occludes it anyway.
    const arrowMat = new THREE.MeshBasicNodeMaterial();
    // teal, a touch brighter toward the tip so the point leads the eye
    const tipGlow = (positionLocal.y as N).mul(0.4).add(0.6).clamp(0, 1);
    arrowMat.colorNode = (color(0x25e6b4) as N).mul(LIGHT_SCALE * 0.62).mul(tipGlow);
    arrowMat.side = THREE.DoubleSide;
    arrowMat.fog = false;
    const arrow = new THREE.Mesh(geo, arrowMat);
    arrow.renderOrder = 999;
    arrow.rotation.x = -Math.PI / 2 + 0.7; // face forward, pitched back toward the chase camera

    // dark shell a hair bigger + behind → a clean outline on bright skies
    const shellMat = new THREE.MeshBasicNodeMaterial();
    shellMat.colorNode = color(0x06342b) as N;
    shellMat.side = THREE.DoubleSide;
    shellMat.fog = false;
    const shell = new THREE.Mesh(geo, shellMat);
    shell.renderOrder = 998;
    shell.rotation.x = arrow.rotation.x;
    shell.position.set(0, 0, 0.04);
    shell.scale.setScalar(1.18);

    this.#spin.add(shell, arrow);
    this.#group.visible = false;
    scene.add(this.#group);
  }

  /** Aim the chevron from `from` toward `target`, floating above the player.
   *  `show=false` retracts it. `hideWithin` metres = pop off near the goal. */
  update(dt: number, from: THREE.Vector3, target: THREE.Vector3 | null, show: boolean, elapsed: number, hideWithin = 6) {
    const dx = target ? target.x - from.x : 0;
    const dz = target ? target.z - from.z : 0;
    const dist = Math.hypot(dx, dz);
    this.#shown = !!target && show && dist > hideWithin;
    this.#vis += ((this.#shown ? 1 : 0) - this.#vis) * Math.min(1, dt * 7);
    if (this.#vis < 0.02) {
      this.#group.visible = false;
      return;
    }
    this.#group.visible = true;
    // float well above the golfer's head, bobbing gently
    const y = from.y + 3.4 + Math.sin(elapsed * 2.2) * 0.16;
    this.#group.position.set(from.x, y, from.z);
    this.#group.scale.setScalar(0.55 + 0.55 * this.#vis + Math.sin(elapsed * 4) * 0.04);
    // the pitched chevron's tip points local -Z; Ry(θ)·(0,0,-1) = (−sinθ,−cosθ)
    // in xz, so θ = atan2(−dx, −dz) swings the tip onto the target bearing
    if (dist > 1e-3) this.#spin.rotation.y = Math.atan2(-dx, -dz);
  }

  hide() {
    this.#shown = false;
  }

  /** Snap fully off this frame (no fade) — e.g. the round ended / you teleported. */
  hideNow() {
    this.#shown = false;
    this.#vis = 0;
    this.#group.visible = false;
  }

  dispose() {
    this.#group.removeFromParent();
  }
}
