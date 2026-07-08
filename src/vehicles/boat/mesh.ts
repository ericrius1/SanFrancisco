import * as THREE from "three/webgpu";
import { positionLocal, sin, smoothstep, time, uniform, uv, vec3 } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { lightAnchor } from "../../player/lightPool";
import { capsulesToLocal, clothColliders, pushOutOfColliders, type Capsule, type ClothColliders } from "../../fx/cloth";

// animation handles Player's per-frame animate drives while the boat is embodied
export type BoatSailRig = {
  flap: { value: number };
  billow: { value: number };
  boom: THREE.Group;
  heel: THREE.Group;
};

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Triangular sail panel spanned between three corners. uv.x is the chord
 * fraction from the luff (mast/stay edge, 0) toward the leech; uv.y runs foot
 * to head — the sail material uses both as displacement-pinning weights.
 */
function sailGeometry(head: THREE.Vector3, tack: THREE.Vector3, clew: THREE.Vector3, seg = 12): THREE.BufferGeometry {
  const pos: number[] = [];
  const uvs: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let j = 0; j <= seg; j++) {
    const v = j / seg;
    a.lerpVectors(tack, head, v);
    b.lerpVectors(clew, head, v);
    for (let i = 0; i <= seg; i++) {
      p.lerpVectors(a, b, i / seg);
      pos.push(p.x, p.y, p.z);
      uvs.push((i / seg) * (1 - v), v);
      nrm.push(1, 0, 0);
    }
  }
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const r0 = j * (seg + 1) + i;
      const r1 = r0 + seg + 1;
      // wind the front face toward local +x to match the (1,0,0) normals —
      // DoubleSide flips the normal on back faces, so a winding mismatch
      // lights each side of the canvas from the opposite side's lamps
      idx.push(r0, r1, r0 + 1, r0 + 1, r1, r1 + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute("normal", new THREE.Float32BufferAttribute(nrm, 3));
  g.setIndex(idx);
  return g;
}

// the TSL node-object wrapper type isn't exported cleanly; infer from a factory
const sailUniform = (v: number) => uniform(v);
type SailUniform = ReturnType<typeof sailUniform>;

/**
 * Sailcloth: GPU vertex displacement along local x — a steady belly (billow)
 * plus travelling flutter waves, both zero at the luff so the canvas stays
 * laced to its spar. `boomFoot` also pins the bottom edge (the main's foot
 * rides the boom; a jib's foot flies free). The shared flap/billow uniforms
 * let the boat animation luff the canvas at idle and fill it with speed.
 */
function sailMaterial(colorHex: number, flap: SailUniform, billow: SailUniform, boomFoot: boolean, colliders?: ClothColliders) {
  const mat = new THREE.MeshLambertNodeMaterial({ color: colorHex, side: THREE.DoubleSide });
  const u = uv().x;
  const v = uv().y;
  const pin = boomFoot ? u.mul(smoothstep(0, 0.3, v)) : u;
  const belly = sin(u.mul(Math.PI)).mul(sin(v.mul(2.6).add(0.4))).mul(billow);
  const flutter = sin(u.mul(9).sub(time.mul(5.2)).add(v.mul(3)))
    .mul(0.7)
    .add(sin(u.mul(15).sub(time.mul(8.3))).mul(0.3))
    .mul(pin)
    .mul(flap);
  // B: rectify to one side — the canvas only ever bellies to leeward (+x), so the
  // flutter never sweeps back through the mast/stay plane at x=0.
  const dispX = belly.add(flutter).max(0);
  let pos: unknown = positionLocal.add(vec3(dispX, 0, 0));
  // A: push any vertex that still sits inside a spar/stay back out to its surface.
  if (colliders) pos = pushOutOfColliders(pos, colliders);
  mat.positionNode = pos as never;
  return mat;
}

/**
 * Open bay day-sailer, front is local -Z: walkaround cockpit with teak sole
 * and benches so the helmsman reads from every angle, gaff-free bermuda rig
 * with a fluttering main + jib, nav lights for the dusk sky. All visuals live
 * in a `heel` child group so the boat animation can roll the boat under sail
 * without fighting the physics-driven root transform.
 */
export function buildBoatMesh(): THREE.Group {
  const g = new THREE.Group();
  const heel = new THREE.Group();
  g.add(heel);

  const hullMat = new THREE.MeshLambertMaterial({ color: 0xf6f1e4 });
  const bottomMat = new THREE.MeshLambertMaterial({ color: 0x14544e });
  const teak = new THREE.MeshLambertMaterial({ color: 0xa6743c });
  const teakDark = new THREE.MeshLambertMaterial({ color: 0x7c5528 });
  const trim = new THREE.MeshLambertMaterial({ color: 0x1b1d22 });
  const spar = new THREE.MeshLambertMaterial({ color: 0xd2b98c });
  const navGreen = new THREE.MeshLambertMaterial({ color: 0x2bd45a, emissive: 0x18c74a, emissiveIntensity: 4.2 * LIGHT_SCALE });
  const navRed = new THREE.MeshLambertMaterial({ color: 0xd42b2b, emissive: 0xff2418, emissiveIntensity: 4.2 * LIGHT_SCALE });
  const lampMat = new THREE.MeshLambertMaterial({ color: 0xfff4c9, emissive: 0xffedb0, emissiveIntensity: 4.0 * LIGHT_SCALE });

  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.set(0, ry, rz);
    heel.add(m);
    return m;
  };

  // hull: solid below the sole, open bulwarks above — the cockpit is visible
  box(hullMat, 2.4, 0.55, 5.9, 0, -0.2, 0.05);
  box(bottomMat, 2.46, 0.3, 5.95, 0, -0.42, 0.05); // antifoul waterline band
  box(bottomMat, 0.16, 0.5, 3.4, 0, -0.7, 0.3); // keel
  box(teakDark, 0.09, 0.75, 0.55, 0, -0.5, 3.0); // rudder
  // bulwark walls with a touch of outward flare, then the pointed bow
  box(hullMat, 0.14, 0.6, 5.0, 1.15, 0.35, 0.35, 0, -0.05);
  box(hullMat, 0.14, 0.6, 5.0, -1.15, 0.35, 0.35, 0, 0.05);
  box(hullMat, 0.14, 0.6, 1.85, 0.575, 0.35, -2.875, 0.67);
  box(hullMat, 0.14, 0.6, 1.85, -0.575, 0.35, -2.875, -0.67);
  box(hullMat, 1.2, 0.55, 1.5, 0, -0.2, -3.0); // bow fill below deck
  box(bottomMat, 1.0, 0.3, 1.4, 0, -0.42, -3.05);
  box(hullMat, 2.3, 0.62, 0.16, 0, 0.34, 2.9); // transom
  box(teak, 2.36, 0.07, 0.24, 0, 0.68, 2.9); // transom cap
  box(teak, 0.12, 0.7, 0.14, 0, 0.38, -3.58); // stem post
  // teak trim: foredeck, gunwale caps, rub rails
  box(teak, 1.75, 0.08, 2.2, 0, 0.68, -1.98);
  box(teak, 0.9, 0.08, 1.0, 0, 0.68, -3.15);
  box(teak, 0.26, 0.06, 5.1, 1.15, 0.68, 0.35);
  box(teak, 0.26, 0.06, 5.1, -1.15, 0.68, 0.35);
  box(trim, 0.07, 0.1, 5.2, 1.24, 0.42, 0.3);
  box(trim, 0.07, 0.1, 5.2, -1.24, 0.42, 0.3);
  // cockpit: planked sole, side + stern benches, engine hatch as the footrest
  box(teak, 1.9, 0.06, 3.9, 0, 0.1, 0.7);
  for (const px of [-0.6, -0.2, 0.2, 0.6]) box(teakDark, 0.04, 0.07, 3.85, px, 0.1, 0.7);
  for (const s of [1, -1] as const) {
    box(teak, 0.44, 0.09, 2.7, s * 0.86, 0.34, 0.75);
    box(hullMat, 0.06, 0.28, 2.7, s * 0.66, 0.2, 0.75);
  }
  box(teak, 1.7, 0.09, 0.55, 0, 0.34, 2.5);
  box(hullMat, 1.7, 0.28, 0.06, 0, 0.2, 2.2);
  box(teak, 0.9, 0.2, 0.8, 0, 0.2, 1.5); // engine hatch / helm footrest
  box(trim, 0.4, 0.34, 0.2, 0, 0.42, 1.6); // helm console (wheel mounts here)
  // deck hardware: cleats, nav lights, stern + masthead lamps
  box(trim, 0.16, 0.05, 0.06, 0.5, 0.75, -2.6);
  box(trim, 0.16, 0.05, 0.06, -0.5, 0.75, -2.6);
  box(trim, 0.16, 0.05, 0.06, 0, 0.75, -3.3);
  box(navGreen, 0.09, 0.07, 0.18, 1.13, 0.76, -1.9);
  box(navRed, 0.09, 0.07, 0.18, -1.13, 0.76, -1.9);
  box(lampMat, 0.08, 0.08, 0.08, 0, 0.76, 2.92);
  box(lampMat, 0.08, 0.08, 0.08, 0, 7.58, -1.0);
  box(lampMat, 0.07, 0.07, 0.07, 0, 0.52, 1.55); // helm console lamp
  box(lampMat, 0.07, 0.07, 0.07, 0, 0.78, -2.85); // bow pulpit lamp

  // rig: mast, boom, standing rigging
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 6.9, 10), spar);
  mast.position.set(0, 4.06, -1.0);
  heel.add(mast);
  const boom = new THREE.Group();
  boom.position.set(0, 2.0, -0.95);
  heel.add(boom);
  const boomSpar = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 2.75, 8), spar);
  boomSpar.rotation.x = Math.PI / 2;
  boomSpar.position.set(0, 0, 1.375);
  boom.add(boomSpar);
  const stayMat = new THREE.MeshLambertMaterial({ color: 0x2a2d33 });
  const stay = (ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, a.distanceTo(b), 5), stayMat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(UP, b.sub(a).normalize());
    heel.add(m);
  };
  stay(0, 0.75, -3.55, 0, 7.45, -1.0); // forestay
  stay(0, 7.45, -1.0, 0, 0.72, 2.85); // backstay
  stay(1.12, 0.7, -0.65, 0, 6.3, -1.0); // shrouds
  stay(-1.12, 0.7, -0.65, 0, 6.3, -1.0);

  // canvas: main on the boom, jib on the forestay, pennant at the masthead.
  // Spars/stays the canvas must not clip, as capsules in `heel` space (matches
  // the geometry above). Transformed into each sail's local frame below.
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const mastCap: Capsule = { a: V(0, 0.61, -1.0), b: V(0, 7.51, -1.0), radius: 0.075, skin: 0.045 };
  const boomCap: Capsule = { a: V(0, 2.0, -0.95), b: V(0, 2.0, 1.8), radius: 0.045, skin: 0.035 };
  const forestayCap: Capsule = { a: V(0, 0.75, -3.55), b: V(0, 7.45, -1.0), radius: 0.03, skin: 0.035 };
  const backstayCap: Capsule = { a: V(0, 7.45, -1.0), b: V(0, 0.72, 2.85), radius: 0.03, skin: 0.035 };

  const flap = sailUniform(0.5);
  const billow = sailUniform(0.15);
  const mainColliders = clothColliders();
  const main = new THREE.Mesh(
    sailGeometry(new THREE.Vector3(0, 5.3, 0.06), new THREE.Vector3(0, 0.12, 0.12), new THREE.Vector3(0, 0.12, 2.62)),
    sailMaterial(0xf2ecd8, flap, billow, true, mainColliders)
  );
  boom.add(main);
  const jibColliders = clothColliders();
  const jib = new THREE.Mesh(
    sailGeometry(new THREE.Vector3(0, 6.9, -1.2), new THREE.Vector3(0, 0.9, -3.45), new THREE.Vector3(0, 1.15, -0.75)),
    sailMaterial(0xece2c8, flap, billow, false, jibColliders)
  );
  heel.add(jib);
  const pennantMat = new THREE.MeshLambertNodeMaterial({ color: 0xe8563f, side: THREE.DoubleSide });
  pennantMat.positionNode = positionLocal.add(vec3(sin(uv().x.mul(7).sub(time.mul(9))).mul(uv().x).mul(0.18), 0, 0));
  const pennant = new THREE.Mesh(
    sailGeometry(new THREE.Vector3(0, 7.52, -0.97), new THREE.Vector3(0, 7.32, -0.97), new THREE.Vector3(0, 7.44, -0.42), 6),
    pennantMat
  );
  heel.add(pennant);

  // Lamps come from the shared LightPool (4 slots — see player/lightPool.ts),
  // so the old 9-fixture layout condenses to 4 anchors:
  // - one warm cockpit lamp standing in for the helm/cockpit/stern trio
  // - the bow lamp for the foredeck pool
  // - one wash lamp per side for the sails. The canvas lies in the centreline
  //   plane, so these must stay off-centreline — warm to starboard, cool to
  //   port, sitting between the main and jib so one lamp covers both, with the
  //   old masthead's deck wash folded into their reach
  heel.add(lightAnchor({ color: 0xffe2b8, intensity: 24, distance: 14 }, 0, 1.25, 1.4));
  heel.add(lightAnchor({ color: 0xfff0d0, intensity: 11, distance: 10 }, 0, 0.9, -2.3));
  heel.add(lightAnchor({ color: 0xffd9a0, intensity: 13, distance: 16 }, 2.35, 4.0, -0.7));
  heel.add(lightAnchor({ color: 0xcdd8ff, intensity: 13, distance: 16 }, -2.35, 4.0, -0.7));

  // Bake the spar capsules into each sail's local frame. Boom swing (≤~0.3 rad)
  // drifts the main's mast/backstay by <2cm at runtime — well inside the skin —
  // so this one-time bake avoids any per-frame collider work.
  g.updateMatrixWorld(true);
  mainColliders.set(capsulesToLocal(main, heel, [mastCap, backstayCap, boomCap]));
  jibColliders.set(capsulesToLocal(jib, heel, [forestayCap, mastCap]));

  g.userData.sail = { flap, billow, boom, heel } satisfies BoatSailRig;
  return g;
}
