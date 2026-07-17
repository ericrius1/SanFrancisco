import * as THREE from "three/webgpu";
import { fract, max, mix, sin, step, time, uv, vec2, vec3 } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { lightAnchor } from "../../player/lightPool";
import type { Cockpit } from "../../player/types";
import { applyVehicleShadowPolicy } from "../shadows";

/**
 * Animated parts of a plane mesh. Rediscovered by node name (not userData —
 * Object3D.clone JSON-round-trips userData, so THREE refs stored there would
 * serialize a whole scene snapshot per remote join) so both the local mesh and
 * remote deep-clones resolve their own copies.
 */
export type PlaneAnim = { props: THREE.Object3D[]; yoke: THREE.Object3D | null };

export function collectPlaneAnim(root: THREE.Object3D): PlaneAnim {
  const props: THREE.Object3D[] = [];
  let yoke: THREE.Object3D | null = null;
  root.traverse((o) => {
    if (o.name === "prop") props.push(o);
    else if (o.name === "yoke") yoke = o;
  });
  return { props, yoke };
}

/**
 * Photovoltaic wing skin: deep PV blue with a slow iridescent sheen drifting
 * across the cells and brass gridlines between them, plus a faint teal glow so
 * the stored sunlight reads at dusk. Pure mix/step math — distance/pattern
 * branches corrupt skipped pixels on this renderer (see perf notes).
 */
function solarMaterial(): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial({ roughness: 0.35, metalness: 0.3 });
  const cell = fract(uv().mul(vec2(7, 3)));
  const line = max(step(0.9, cell.x), step(0.86, cell.y));
  const sheen = sin(uv().x.mul(9).add(uv().y.mul(4)).add(time.mul(0.6))).mul(0.5).add(0.5);
  const pv = mix(vec3(0.045, 0.14, 0.26), vec3(0.1, 0.3, 0.44), sheen);
  mat.colorNode = mix(pv, vec3(0.62, 0.48, 0.26), line);
  mat.emissiveNode = mix(vec3(0.05, 0.2, 0.22), vec3(0), line).mul(0.045 * LIGHT_SCALE);
  return mat;
}

/**
 * Solarpunk canard prop plane, front is local -Z: rounded copper-and-ivory
 * fuselage, open cockpit (brass coaming, teak seat, yoke — the pilot rig seats
 * at userData.cockpit), low wings inlaid with solar panels driving two nacelle
 * props plus a big two-blade nose prop, verdigris tail. Groups named "prop" /
 * "yoke" animate via collectPlaneAnim.
 */
export function buildPlaneMesh(): THREE.Group {
  const g = new THREE.Group();
  const shadowCasters: THREE.Mesh[] = [];
  const shadowReceivers: THREE.Mesh[] = [];

  const ivory = new THREE.MeshLambertMaterial({ color: 0xf3eee1 });
  const copper = new THREE.MeshLambertMaterial({ color: 0xa95f33 });
  const brass = new THREE.MeshLambertMaterial({ color: 0xc9973f });
  const verdigris = new THREE.MeshLambertMaterial({ color: 0x3d9483 });
  const teak = new THREE.MeshLambertMaterial({ color: 0xa6743c });
  const teakDark = new THREE.MeshLambertMaterial({ color: 0x6f4a22 });
  const trim = new THREE.MeshLambertMaterial({ color: 0x1b1d22 });
  const glass = new THREE.MeshLambertMaterial({ color: 0x101820 });
  const solar = solarMaterial();
  const navGreen = new THREE.MeshLambertMaterial({ color: 0x2bd45a, emissive: 0x18c74a, emissiveIntensity: 4.2 * LIGHT_SCALE });
  const navRed = new THREE.MeshLambertMaterial({ color: 0xd42b2b, emissive: 0xff2418, emissiveIntensity: 4.2 * LIGHT_SCALE });
  const lampMat = new THREE.MeshLambertMaterial({ color: 0xfff4c9, emissive: 0xffedb0, emissiveIntensity: 3.6 * LIGHT_SCALE });
  // spun-prop suggestion: a faint standing disc behind the blades
  const discMat = new THREE.MeshLambertMaterial({ color: 0xd8e4da, transparent: true, opacity: 0.13, side: THREE.DoubleSide, depthWrite: false });

  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number, parent: THREE.Object3D = g, rx = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.rotation.x = rx;
    parent.add(m);
    return m;
  };
  // fuselage/nacelle section lying along z; rFront is the -z (nose-side) radius
  const tube = (mat: THREE.Material, rFront: number, rBack: number, zFront: number, zBack: number, parent: THREE.Object3D = g, radial = 14) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(rBack, rFront, zBack - zFront, radial), mat);
    m.rotation.x = Math.PI / 2;
    m.position.z = (zFront + zBack) / 2;
    parent.add(m);
    return m;
  };
  const strut = (mat: THREE.Material, r: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number) => {
    const a = new THREE.Vector3(ax, ay, az);
    const b = new THREE.Vector3(bx, by, bz);
    const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, a.distanceTo(b), 6), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
    g.add(m);
    return m;
  };
  const prop = (parent: THREE.Object3D, x: number, y: number, z: number, blades: number, bladeLen: number) => {
    const p = new THREE.Group();
    p.name = "prop";
    p.position.set(x, y, z);
    parent.add(p);
    const spinner = new THREE.Mesh(new THREE.CylinderGeometry(bladeLen * 0.24, 0.05, bladeLen * 0.35, 10), brass);
    spinner.rotation.x = Math.PI / 2;
    spinner.position.z = -bladeLen * 0.1;
    p.add(spinner);
    for (let i = 0; i < blades; i++) {
      const holder = new THREE.Group();
      holder.rotation.z = (i / blades) * Math.PI * 2;
      p.add(holder);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(bladeLen * 0.14, bladeLen, 0.035), teakDark);
      blade.position.y = bladeLen * 0.55;
      blade.rotation.y = 0.38; // blade pitch
      holder.add(blade);
    }
    const disc = new THREE.Mesh(new THREE.CircleGeometry(bladeLen * 1.05, 24), discMat);
    p.add(disc);
    return p;
  };

  // hull: copper cowl, ivory cabin barrel tapering into a copper tail cone
  tube(copper, 0.42, 0.6, -3.1, -2.35);
  shadowCasters.push(tube(ivory, 0.6, 0.58, -2.35, 0.0));
  shadowCasters.push(tube(ivory, 0.58, 0.3, 0.0, 2.1));
  tube(copper, 0.3, 0.1, 2.1, 3.15);
  tube(verdigris, 0.615, 0.615, -2.42, -2.3); // cowl seam band
  tube(verdigris, 0.6, 0.585, -0.06, 0.06); // cabin seam band
  box(teakDark, 0.16, 0.08, 3.0, 0, -0.62, -0.6); // belly keel strip

  // open cockpit: dark tub sunk into the barrel top, brass coaming ring,
  // raked windscreen, teak seat. The pilot rig sits at userData.cockpit.
  box(trim, 0.78, 0.35, 1.5, 0, 0.44, 0.22);
  const coaming = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 8, 24), brass);
  coaming.rotation.x = Math.PI / 2;
  coaming.position.set(0, 0.6, 0.22);
  coaming.scale.y = 1.8; // scale precedes the rotation: local y is world z here
  g.add(coaming);
  box(glass, 0.72, 0.32, 0.05, 0, 0.78, -0.62, g, 0.42);
  box(brass, 0.78, 0.05, 0.05, 0, 0.9, -0.55, g, 0.42); // windscreen cap rail
  box(teak, 0.6, 0.1, 0.55, 0, 0.42, 0.55);
  box(teak, 0.6, 0.45, 0.1, 0, 0.62, 0.86, g, -0.12);
  box(lampMat, 0.06, 0.06, 0.06, 0, 0.66, -0.72); // panel lamp under the screen
  // yoke: brass column + wheel the pilot's hands follow (spins with bank)
  const yokeCol = new THREE.Group();
  yokeCol.position.set(0, 0.73, -0.24);
  g.add(yokeCol);
  box(brass, 0.05, 0.05, 0.26, 0, -0.04, -0.14, yokeCol, 0.45);
  const yoke = new THREE.Group();
  yoke.name = "yoke";
  yokeCol.add(yoke);
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.024, 8, 18), teak);
  yoke.add(rim);
  for (const a of [0, 2.09, -2.09]) {
    const spoke = box(brass, 0.026, 0.14, 0.026, Math.sin(a) * 0.07, Math.cos(a) * 0.07, 0, yoke);
    spoke.rotation.z = -a;
  }
  g.userData.cockpit = { seat: [0, 0.62, 0.3], wheel: [0, 0.73, -0.24] } satisfies Cockpit;
  // Rumble seat: a friend straddles the cabin barrel aft of the coaming.
  g.userData.passengerSeat = [0, 0.56, 1.3] as [number, number, number];

  // canard foreplane at the nose — the dragonfly silhouette
  shadowCasters.push(box(ivory, 2.5, 0.07, 0.5, 0, 0.16, -2.5));
  box(verdigris, 0.2, 0.075, 0.5, 1.34, 0.16, -2.5);
  box(verdigris, 0.2, 0.075, 0.5, -1.34, 0.16, -2.5);

  // wings: low-mounted with dihedral, tapered in two panels to a round tip,
  // solar inlays on top, copper leading edge, nacelle + 3-blade prop below
  for (const s of [1, -1] as const) {
    const wing = new THREE.Group();
    wing.position.set(s * 0.35, 0.05, -0.55);
    wing.rotation.z = s * 0.06;
    g.add(wing);
    shadowCasters.push(box(ivory, 2.55, 0.15, 1.75, s * 1.35, 0, 0, wing));
    shadowCasters.push(box(ivory, 1.95, 0.11, 1.2, s * 3.55, 0.01, 0.12, wing));
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.6, 0.6, 0.1, 14), ivory);
    tip.position.set(s * 4.52, 0.02, 0.12);
    wing.add(tip);
    // These are physical wing skins with only a faint dusk sheen, not glow FX:
    // force receiving so the pilot/fuselage shadow is not cut out of the deck.
    shadowReceivers.push(box(solar, 2.35, 0.03, 1.5, s * 1.35, 0.085, 0, wing));
    shadowReceivers.push(box(solar, 1.7, 0.03, 1.0, s * 3.5, 0.07, 0.12, wing));
    box(copper, 2.55, 0.08, 0.08, s * 1.35, 0, -0.9, wing);
    box(copper, 1.95, 0.06, 0.07, s * 3.55, 0.01, -0.5, wing);
    box(s > 0 ? navGreen : navRed, 0.14, 0.08, 0.3, s * 4.62, 0.03, 0.1, wing);
    // nacelle slung under the wing, verdigris nose ring, prop out front
    const nac = tube(copper, 0.18, 0.26, -0.95, 0.05, wing);
    nac.position.x = s * 2.0;
    nac.position.y = -0.24;
    const ring = tube(verdigris, 0.19, 0.19, -1.0, -0.92, wing);
    ring.position.x = s * 2.0;
    ring.position.y = -0.24;
    prop(wing, s * 2.0, -0.24, -1.02, 3, 0.62);
  }
  // nose prop: big lazy two-blader on the cowl
  prop(g, 0, 0, -3.24, 2, 1.0);
  // wing bracing: brass flying wires from the hull belly to mid-wing
  for (const s of [1, -1] as const) {
    strut(brass, 0.028, s * 0.45, -0.42, -1.15, s * 2.35, 0.12, -1.35);
    strut(brass, 0.028, s * 0.45, -0.42, -0.05, s * 2.35, 0.12, -0.15);
  }

  // tail: ivory plane with verdigris elevator, swept verdigris fin with copper
  // leading rib, teak rudder, round tip cap with the beacon on it
  shadowCasters.push(box(ivory, 3.6, 0.09, 0.85, 0, 0.32, 2.55));
  box(verdigris, 3.4, 0.07, 0.3, 0, 0.32, 3.05);
  box(verdigris, 0.08, 0.8, 0.9, 0, 0.75, 2.6);
  box(verdigris, 0.07, 0.62, 0.62, 0, 1.36, 2.76);
  const finTip = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.06, 12), verdigris);
  finTip.geometry.rotateZ(Math.PI / 2);
  finTip.position.set(0, 1.68, 2.82);
  g.add(finTip);
  box(copper, 0.09, 1.35, 0.06, 0, 0.95, 2.2, g, -0.18);
  box(teakDark, 0.06, 0.9, 0.3, 0, 0.85, 3.12);
  box(lampMat, 0.08, 0.08, 0.08, 0, 1.68, 2.82);

  // taildragger gear: brass legs, teak-dark wheels with brass hubs, tail skid
  const wheelGeo = new THREE.CylinderGeometry(0.24, 0.24, 0.14, 14);
  wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.09, 0.09, 0.16, 10);
  hubGeo.rotateZ(Math.PI / 2);
  for (const s of [1, -1] as const) {
    strut(brass, 0.035, s * 0.4, -0.4, -1.2, s * 0.95, -0.95, -1.25);
    strut(brass, 0.03, s * 0.4, -0.55, -0.75, s * 0.95, -0.95, -1.25);
    const wheel = new THREE.Mesh(wheelGeo, trim);
    wheel.position.set(s * 0.98, -0.95, -1.25);
    g.add(wheel);
    const hub = new THREE.Mesh(hubGeo, brass);
    hub.position.set(s * 0.98, -0.95, -1.25);
    g.add(hub);
  }
  strut(brass, 0.025, 0, -0.2, 2.55, 0, -0.6, 2.85);
  const skidWheel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.09, 10), trim);
  skidWheel.geometry.rotateZ(Math.PI / 2);
  skidWheel.position.set(0, -0.6, 2.85);
  g.add(skidWheel);

  // lamps from the shared LightPool (4 anchors): warm cockpit glow, one wash
  // per wing (warm starboard / cool port, lighting the solar decks), tail beacon
  g.add(lightAnchor({ color: 0xffe2b8, intensity: 16, distance: 9 }, 0, 0.95, 0.25));
  g.add(lightAnchor({ color: 0xffd9a0, intensity: 10, distance: 12 }, 2.6, 0.5, -0.6));
  g.add(lightAnchor({ color: 0xcdd8ff, intensity: 10, distance: 12 }, -2.6, 0.5, -0.6));
  g.add(lightAnchor({ color: 0xfff0d0, intensity: 7, distance: 8 }, 0, 1.75, 2.82));

  // Eight structural pieces preserve the full dragonfly planform: two cabin
  // barrels, canard, four wing panels, and tailplane. Thin solar skins, props,
  // bracing, gear detail, transparent discs, and lamps stay out of CSM draws.
  applyVehicleShadowPolicy(g, shadowCasters, shadowReceivers);
  return g;
}
