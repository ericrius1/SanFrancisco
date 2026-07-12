import * as THREE from "three/webgpu";
import { uniform, uv, smoothstep, sin, cos, float, vec2, vec3, mix } from "three/tsl";
import { LIGHT_SCALE } from "../config";

type N = any;

/**
 * A little glowing orb that lives IN the world instead of as an HTML overlay, so
 * it can rest on real surfaces (raycast depth) and snap onto interactable things
 * with genuine 3D depth. It sits at screen-centre while the mouse is captured
 * (doubling as an aim reticle), and follows the free mouse ray while the player
 * holds a modifier to unlock the pointer.
 *
 * Baseline it is small and dim — a cool cyan mote that only breathes. When it
 * hovers something clickable (`hover=1`) it eases bigger and warmer, a halo ring
 * lights up, and a ring of gold particles swirls in. Everything is one
 * camera-facing plane drawn procedurally in a TSL shader: no per-particle CPU
 * work, no extra draw calls, additive so empty pixels cost nothing on screen.
 */

const ORB_PARTICLES = 7;

export class WorldCursor {
  #mesh: THREE.Mesh;
  #uTime = uniform(0);
  #uHover = uniform(0); // 0..1, eased toward the hover target every frame
  #hover = 0; // CPU mirror of #uHover, drives the size growth too
  #target = new THREE.Vector3();
  #toCam = new THREE.Vector3();
  #enabled = true;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mat = new THREE.MeshBasicNodeMaterial();

    const t = this.#uTime as N;
    const hv = this.#uHover as N;
    const p = (uv() as N).mul(2).sub(1); // -1..1 across the quad
    const r = p.length();
    const pulse = sin(t.mul(3.0)).mul(0.5).add(0.5); // slow breath 0..1

    // soft nucleus + a halo ring that ignites on hover
    const coreR = float(0.32).add(pulse.mul(0.03)).add(hv.mul(0.07));
    const core = smoothstep(coreR, 0.0, r); // filled disk, feathered edge
    const hot = core.pow(2.6); // bright centre
    const halo = smoothstep(0.055, 0.0, r.sub(coreR.add(0.06)).abs()).mul(hv.mul(0.8).add(0.15));

    // a ring of particles orbiting the orb — only visible while hovering
    let parts: N = float(0);
    for (let i = 0; i < ORB_PARTICLES; i++) {
      const base = (i / ORB_PARTICLES) * Math.PI * 2;
      const ang = t.mul(1.6).add(base);
      const wob = sin(t.mul(2.2).add(base * 1.7)).mul(0.03);
      const rad = float(0.52).add(wob).add(hv.mul(0.06));
      const cx = cos(ang).mul(rad);
      const cy = sin(ang).mul(rad);
      const d = p.sub(vec2(cx, cy)).length();
      parts = parts.add(smoothstep(0.06, 0.0, d));
    }
    parts = parts.mul(hv);

    const cool = vec3(0.42, 0.78, 1.0); // resting cyan
    const warm = vec3(1.0, 0.82, 0.5); // hover gold
    const coreCol = mix(cool, warm, hv.mul(0.7));
    const intensity = float(0.42).add(hv.mul(0.85)).add(pulse.mul(0.07));

    const body = coreCol.mul(hot.mul(1.2).add(core.mul(0.3)).add(halo)).mul(intensity);
    const col = body.add(warm.mul(parts).mul(1.5));
    mat.colorNode = col.mul(LIGHT_SCALE * 0.7);

    mat.transparent = true;
    mat.blending = THREE.AdditiveBlending;
    mat.depthWrite = false;
    // Depth-testing lets the marker rest on the
    // surface it points at and remains occluded by foreground geometry.
    mat.side = THREE.DoubleSide;
    mat.fog = false;
    mat.toneMapped = false;

    this.#mesh = new THREE.Mesh(geo, mat);
    this.#mesh.frustumCulled = false;
    this.#mesh.renderOrder = 999;
    this.#mesh.visible = false;
    scene.add(this.#mesh);
  }

  setEnabled(on: boolean) {
    this.#enabled = on;
    if (!on) this.#mesh.visible = false;
  }

  /**
   * Place the orb this frame. `pos` is the world point it points at (a surface
   * hit or an interactable's centre). `hover` is 1 when that point is something
   * clickable, 0 otherwise. `visible=false` parks it (panels open, cinematics…).
   */
  update(dt: number, camera: THREE.Camera, pos: THREE.Vector3, hover: number, visible: boolean) {
    if (!this.#enabled || !visible) {
      this.#mesh.visible = false;
      // let hover relax while hidden so it never pops in mid-swell
      this.#hover += (0 - this.#hover) * Math.min(1, dt * 8);
      this.#uHover.value = this.#hover;
      return;
    }

    this.#uTime.value = (this.#uTime.value as number) + dt;
    this.#hover += (hover - this.#hover) * (1 - Math.exp(-dt * 9));
    this.#uHover.value = this.#hover;

    const depth = THREE.MathUtils.clamp(camera.position.distanceTo(pos), 1.5, 60);
    // nudge toward the camera so an additive quad never z-fights the surface
    this.#toCam.copy(camera.position).sub(pos).normalize();
    this.#target.copy(pos).addScaledVector(this.#toCam, depth * 0.05);

    const lerp = 1 - Math.exp(-dt * 20);
    if (!this.#mesh.visible) this.#mesh.position.copy(this.#target); // no slide-in from stale spot
    else this.#mesh.position.lerp(this.#target, lerp);

    // apparent size ~ constant on screen (scale with depth), grows on hover
    const size = depth * 0.055 * (1 + this.#hover * 0.6);
    this.#mesh.scale.setScalar(size);
    this.#mesh.quaternion.copy(camera.quaternion);
    this.#mesh.visible = true;
  }

  dispose() {
    this.#mesh.removeFromParent();
    this.#mesh.geometry.dispose();
    (this.#mesh.material as THREE.Material).dispose();
  }
}
