import * as THREE from "three/webgpu";
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

/**
 * Booster exhaust — a stack of emissive cones streaming out the tail (+Z).
 * Caller toggles `.visible` and pulses `.scale.z` while thrusting.
 */
export function buildBoosterFlame(): THREE.Group {
  const g = new THREE.Group();
  g.position.z = 1.08;
  const cone = (len: number, r: number, hex: number, gain: number) => {
    const m = new THREE.Mesh(
      new THREE.ConeGeometry(r, len, 12, 1, true),
      new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2; // open end toward +Z
    m.position.z = len / 2;
    void gain;
    g.add(m);
    return m;
  };
  cone(1.5, 0.22, 0xffe08a, 1); // hot core
  cone(2.4, 0.34, 0xff7a1e, 1); // orange plume
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
