import * as THREE from "three/webgpu";
import { lightAnchor } from "../../player/lightPool";
import { GuitaristStand, LauncherRig, RocketBattery, buildGuitarPlayer } from "../../gameplay/launchers";
import { applyMaterialPolicy, tagTransparency } from "../../render/transparency";

/**
 * A sleek open-cockpit speedboat — the fast cousin of the day-sailer. Front is
 * local -Z (game convention): a pointed planing hull (extruded from a boat
 * outline so the bow actually comes to a point), a red/white/blue runabout deck,
 * a wraparound windscreen, two bucket seats at the helm console and a chunky
 * outboard on the transom. No sail, no rig animation — it just goes. Driven by
 * BoatController with SPEEDBOAT_TUNING; the crew rig seats at userData.cockpit.
 *
 * Sizing/origin match the sailboat so the shared BoatController buoyancy (body
 * centre ~0.4 m over the water) floats it right: the hull straddles y=0 with its
 * keel ~0.55 m under the origin and the deck ~0.2 m over it.
 */
export function buildSpeedboatMesh(): THREE.Group {
  const g = new THREE.Group();

  const hullWhite = new THREE.MeshLambertMaterial({ color: 0xf2f0ea });
  const navy = new THREE.MeshLambertMaterial({ color: 0x1c2f6b });
  const red = new THREE.MeshLambertMaterial({ color: 0xc02a35 });
  const deckTan = new THREE.MeshLambertMaterial({ color: 0xb9987a });
  const trim = new THREE.MeshLambertMaterial({ color: 0x1a1c22 });
  const chrome = new THREE.MeshLambertMaterial({ color: 0x9aa3ad });
  const glass = applyMaterialPolicy(
    new THREE.MeshLambertMaterial({ color: 0x0e1a24, opacity: 0.55 }),
    "alphaSurface"
  );

  // hull silhouette (top-down): pointed bow at -Z, transom at +Z. Shape is laid
  // out in X (beam) / Y (length) then rotated so length runs along Z and the
  // extrude falls downward into the water.
  const half = (dx: number, y: number) => [dx, y] as const;
  const outline = new THREE.Shape();
  const pts: (readonly [number, number])[] = [
    half(0, -2.85), // bow point
    half(0.55, -1.9),
    half(1.0, -0.6),
    half(1.02, 1.6),
    half(0.82, 2.75), // transom corner
    half(-0.82, 2.75),
    half(-1.02, 1.6),
    half(-1.0, -0.6),
    half(-0.55, -1.9)
  ];
  outline.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) outline.lineTo(pts[i][0], pts[i][1]);
  outline.closePath();
  const hullGeo = new THREE.ExtrudeGeometry(outline, { depth: 0.78, bevelEnabled: false });
  hullGeo.rotateX(Math.PI / 2); // shape-Y → +Z (length), extrude → -Y (hull depth)
  hullGeo.translate(0, 0.22, 0); // deck lip at +0.22, keel at -0.56
  const hull = new THREE.Mesh(hullGeo, hullWhite);
  g.add(hull);

  // navy sheer stripe + red boot-top, thin flat bands hugging the hull sides
  const band = (matlYo: number, mat: THREE.Material, h: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(2.14, h, 5.75), mat);
    m.position.set(0, matlYo, -0.05);
    g.add(m);
  };
  band(0.08, navy, 0.16);
  band(-0.16, red, 0.1);

  // foredeck cap over the bow (closes the extruded well forward of the cockpit)
  const foredeck = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.12, 2.0), hullWhite);
  foredeck.position.set(0, 0.26, -1.35);
  g.add(foredeck);

  // cockpit sole + coaming (open well amidships/aft)
  const sole = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.1, 2.7), deckTan);
  sole.position.set(0, 0.02, 0.85);
  g.add(sole);
  const coaming = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.34, 3.0), navy);
  coaming.position.set(0, 0.3, 0.8);
  g.add(coaming);
  const well = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.4, 2.6), trim);
  well.position.set(0, 0.34, 0.85);
  g.add(well);

  // helm console + wraparound windscreen just aft of the foredeck
  const console_ = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.42, 0.5), hullWhite);
  console_.position.set(0, 0.42, -0.2);
  g.add(console_);
  const screen = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.34, 0.06), glass);
  tagTransparency(screen, { profile: "alphaSurface" });
  screen.position.set(0, 0.66, -0.42);
  screen.rotation.x = -0.5;
  g.add(screen);

  // two bucket seats — one red, one blue — behind the console
  const seatMk = (x: number, mat: THREE.Material) => {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.16, 0.5), mat);
    base.position.set(x, 0.5, 0.5);
    g.add(base);
    const backrest = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.14), mat);
    backrest.position.set(x, 0.72, 0.72);
    g.add(backrest);
  };
  seatMk(-0.38, red);
  seatMk(0.38, navy);

  // engine cowl + outboard leg on the transom
  const cowl = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.44, 0.7), trim);
  cowl.position.set(0, 0.36, 2.55);
  g.add(cowl);
  const leg = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.7, 0.26), chrome);
  leg.position.set(0, -0.05, 2.95);
  g.add(leg);
  const skeg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.3, 0.5), chrome);
  skeg.position.set(0, -0.4, 3.02);
  g.add(skeg);

  // stubby flagstaff + a little pennant at the stern (July-4 flavour, static)
  const staff = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.9, 6), chrome);
  staff.position.set(0, 0.7, 2.75);
  g.add(staff);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.28, 0.42), red);
  flag.position.set(0, 0.95, 2.53);
  g.add(flag);

  // grab rail along the foredeck
  const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1.5, 6), chrome);
  rail.rotation.z = Math.PI / 2;
  rail.position.set(0, 0.34, -1.9);
  g.add(rail);

  // navigation lamps served by the shared LightPool (markers only — no Lights)
  g.add(lightAnchor({ color: 0xffe2b8, intensity: 16, distance: 12 }, 0, 0.7, 0.1)); // dash glow
  g.add(lightAnchor({ color: 0xff5a5a, intensity: 8, distance: 9 }, -0.9, 0.34, -1.7)); // port bow
  g.add(lightAnchor({ color: 0x63ff8a, intensity: 8, distance: 9 }, 0.9, 0.34, -1.7)); // stbd bow
  g.add(lightAnchor({ color: 0xfff0d0, intensity: 9, distance: 11 }, 0, 0.5, 2.7)); // stern

  // helm crew seat + wheel anchor (player.ts seats the driver rig here)
  g.userData.cockpit = { seat: [0, 0.5, 0.62], wheel: [0, 0.72, 0.12] };

  // --- the show: a rack of patriotic rockets sits in the aft cockpit well (one
  // trigger launches the whole red/white/blue barrage forward over the water)
  // and a guitarist jams up on the foredeck. The launchers hang off a
  // LauncherRig on userData.launcherRig; the host stays dependency-free — main.ts
  // injects the fireworks/rocket-rider systems at fire time, the exact same rig
  // that rides the Freedom Truck.
  const rig = new LauncherRig(g);
  const battery = rig.add(new RocketBattery(), [0, 0.42, 0.75], [0, 0, 0]);
  battery.group.scale.setScalar(0.72); // shrink the truck-bed rack to the cockpit well
  const guitarist = rig.add(new GuitaristStand({ buildRider: buildGuitarPlayer }), [0, 0.37, -1.4], [0, 0, 0]);
  guitarist.group.scale.setScalar(1.0); // human-sized on the foredeck (feet on the 0.32 m deck cap)
  g.userData.launcherRig = rig;

  return g;
}
