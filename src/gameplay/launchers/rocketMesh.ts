import * as THREE from "three/webgpu";
import { saturate, uv, vec3, vec4 } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { usFlagTexture } from "../../fx/cloth";

/**
 * The rocket the performer rides — a stubby patriotic missile lying along local
 * -Z (nose forward, tail +Z), sized so a rig can straddle it at +Y. Shared by
 * the launcher's parked prop and the in-flight RocketRiders entity.
 */
export function buildRocket(): THREE.Group {
  const g = new THREE.Group();
  const white = new THREE.MeshLambertMaterial({ color: 0xf4f4f8 });
  const red = new THREE.MeshLambertMaterial({ color: 0xb22234 });
  const navy = new THREE.MeshLambertMaterial({ color: 0x2c2b57 });
  const metal = new THREE.MeshLambertMaterial({ color: 0x3a3d44 });

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 1.7, 16), white);
  body.rotation.x = Math.PI / 2; // axis along Z
  body.castShadow = true;
  g.add(body);
  // red bands
  for (const z of [-0.5, 0.1, 0.66]) {
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.245, 0.245, 0.12, 16), red);
    band.rotation.x = Math.PI / 2;
    band.position.z = z;
    g.add(band);
  }
  // navy nose cone (points -Z)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.24, 0.5, 16), navy);
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -1.1;
  nose.castShadow = true;
  g.add(nose);
  // little star on the nose flank
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 8, 8), new THREE.MeshLambertMaterial({ color: 0xffd447, emissive: 0xffcf3a, emissiveIntensity: 2 * LIGHT_SCALE }));
  tip.position.z = -1.36;
  g.add(tip);
  // tail fins
  for (let i = 0; i < 4; i++) {
    const fin = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 0.4), red);
    const a = (i / 4) * Math.PI * 2;
    fin.position.set(Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0.72);
    fin.rotation.z = a - Math.PI / 2;
    fin.castShadow = true;
    g.add(fin);
  }
  // nozzle
  const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.24, 12), metal);
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.z = 0.96;
  g.add(nozzle);
  return g;
}

/** A soft, textureless additive glow billboard material — a hot spot of light.
 *  Shared module-wide (each flame reuses these), so they're never disposed
 *  per-rocket (destroying a node material mid-frame corrupts the GPU submit). */
function glowMaterial(hex: number, gain: number): THREE.SpriteNodeMaterial {
  const mat = new THREE.SpriteNodeMaterial();
  const d = uv().sub(0.5).length().mul(2);
  const falloff = saturate(d.oneMinus()).pow(2.3).add(saturate(d.mul(1.7).oneMinus()).pow(6).mul(1.8));
  const c = new THREE.Color(hex);
  mat.colorNode = vec4(vec3(c.r, c.g, c.b).mul(falloff).mul(gain * LIGHT_SCALE), 1);
  mat.blending = THREE.AdditiveBlending;
  mat.transparent = true;
  mat.depthWrite = false;
  return mat;
}

const FLAME_CORE = glowMaterial(0xffe6a8, 2.4); // hot white-gold core
const FLAME_HALO = glowMaterial(0xff8a28, 1.15); // softer orange halo

/**
 * Booster exhaust — just a bright glow at the nozzle (+Z tail), no fake cones.
 * A hot white-gold core inside a softer orange halo. Caller toggles `.visible`
 * and pulses `.scale` while thrusting.
 */
export function buildBoosterFlame(): THREE.Group {
  const g = new THREE.Group();
  g.position.z = 1.15; // just off the nozzle
  const core = new THREE.Sprite(FLAME_CORE);
  core.scale.setScalar(0.9);
  const halo = new THREE.Sprite(FLAME_HALO);
  halo.scale.setScalar(1.7);
  g.add(halo, core);
  g.visible = false;
  return g;
}

/**
 * Round parachute canopy on suspension lines, rigged above the rider (+Y).
 * Hidden and un-inflated until deploy; caller ramps `.scale` from ~0 to 1.
 */
export function buildChute(): THREE.Group {
  const g = new THREE.Group();
  g.position.y = 2.5;
  // dome profile → LatheGeometry
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 8; i++) {
    const a = (i / 8) * (Math.PI / 2);
    pts.push(new THREE.Vector2(Math.sin(a) * 1.7, Math.cos(a) * 0.9));
  }
  const canopy = new THREE.Mesh(
    new THREE.LatheGeometry(pts, 24),
    new THREE.MeshLambertMaterial({ map: usFlagTexture(), side: THREE.DoubleSide })
  );
  canopy.castShadow = true;
  g.add(canopy);
  // scalloped white rim
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(1.7, 0.06, 6, 24),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  rim.rotation.x = Math.PI / 2;
  g.add(rim);
  // suspension lines converging on the rider's harness point (down at -Y)
  const lineMat = new THREE.MeshLambertMaterial({ color: 0x2a2a2a });
  const harness = new THREE.Vector3(0, -2.5, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const top = new THREE.Vector3(Math.cos(a) * 1.65, 0, Math.sin(a) * 1.65);
    const line = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, top.distanceTo(harness), 4), lineMat);
    line.position.copy(top).add(harness).multiplyScalar(0.5);
    line.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), harness.clone().sub(top).normalize());
    g.add(line);
  }
  g.visible = false;
  g.scale.setScalar(0.01);
  return g;
}
