import * as THREE from "three/webgpu";
import { color, positionLocal, uniform } from "three/tsl";
import { LIGHT_SCALE } from "../../config";

type N = any;

/**
 * The "which way to the next thing" pointer: a glowing chevron that floats
 * above the golfer and swings to aim at the current objective — the next
 * glowing tee while walking up, the resting ball after a shot, the pin while
 * you settle over it. It hovers, bobs and fades out once you're basically on
 * top of the target so it never nags at close range. One tiny mesh, additive.
 *
 * Opacity rides a single uniform (never reassign a TSL node per frame — that
 * rebuilds the shader and hitches); the pulse is baked into the same uniform.
 */
export class GolfGuide {
  #group = new THREE.Group();
  #spin = new THREE.Group(); // yaws to point at the target
  #alpha = uniform(0);
  #shown = false;
  #vis = 0; // eased 0..1 so it fades rather than popping

  constructor(scene: THREE.Scene) {
    this.#group.name = "golf-guide";
    this.#group.add(this.#spin);
    const a = this.#alpha as unknown as N;

    // chevron: two tapered blades meeting at a forward point. Drawn in XY with
    // the tip at +Y, then stood upright (facing plane = XY) and yawed by #spin
    // to aim at the target, with a slight backward tilt so the chase camera
    // behind the golfer sees its full face rather than a thin edge.
    const shape = new THREE.Shape();
    shape.moveTo(0, 0.98); // tip (forward/up)
    shape.lineTo(0.66, -0.12);
    shape.lineTo(0.3, -0.12);
    shape.lineTo(0, 0.36);
    shape.lineTo(-0.3, -0.12);
    shape.lineTo(-0.66, -0.12);
    shape.closePath();
    const geo = new THREE.ShapeGeometry(shape);

    const arrowMat = new THREE.MeshBasicNodeMaterial();
    // brighter toward the tip so the point of the arrow leads the eye
    const tipGlow = (positionLocal.y as N).mul(0.5).add(0.5).clamp(0, 1);
    arrowMat.colorNode = (color(0x8ef2d0) as N).mul(LIGHT_SCALE * 1.9).mul(tipGlow.mul(0.8).add(0.6));
    arrowMat.opacityNode = a;
    arrowMat.transparent = true;
    arrowMat.blending = THREE.AdditiveBlending;
    arrowMat.depthWrite = false;
    arrowMat.depthTest = false; // always legible, even with a tree between you and it
    arrowMat.side = THREE.DoubleSide;
    arrowMat.fog = false;
    const arrow = new THREE.Mesh(geo, arrowMat);
    arrow.renderOrder = 999;
    // the chevron's face is the XY plane; point the tip along -Z (forward) and
    // pitch it back ~40° so it stands up toward the camera as it flies along
    arrow.rotation.x = -Math.PI / 2 + 0.7;

    this.#spin.add(arrow);
    this.#group.visible = false;
    this.#group.scale.setScalar(1);
    scene.add(this.#group);
  }

  /** Aim the chevron from `from` toward `target`, floating above the player.
   *  `show=false` fades it out. `hideWithin` metres = snap off near the goal. */
  update(dt: number, from: THREE.Vector3, target: THREE.Vector3 | null, show: boolean, elapsed: number, hideWithin = 6) {
    const dx = target ? target.x - from.x : 0;
    const dz = target ? target.z - from.z : 0;
    const dist = Math.hypot(dx, dz);
    this.#shown = !!target && show && dist > hideWithin;
    this.#vis += ((this.#shown ? 1 : 0) - this.#vis) * Math.min(1, dt * 6);
    if (this.#vis < 0.01) {
      this.#group.visible = false;
      this.#alpha.value = 0;
      return;
    }
    this.#group.visible = true;
    // float above the golfer's head, bobbing gently
    const y = from.y + 2.5 + Math.sin(elapsed * 2.2) * 0.14;
    this.#group.position.set(from.x, y, from.z);
    this.#group.scale.setScalar(0.85 * this.#vis + 0.15);
    // the pitched chevron's tip points local -Z; Ry(θ)·(0,0,-1) = (−sinθ,−cosθ)
    // in xz, so θ = atan2(−dx, −dz) swings the tip onto the target bearing
    if (dist > 1e-3) this.#spin.rotation.y = Math.atan2(-dx, -dz);
    // pulse the tip glow as it "beats" toward the goal
    this.#alpha.value = this.#vis * (0.72 + Math.sin(elapsed * 4) * 0.22);
  }

  hide() {
    this.#shown = false;
  }

  dispose() {
    this.#group.removeFromParent();
  }
}
