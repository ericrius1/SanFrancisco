import * as THREE from "three/webgpu";
import { applyVehicleShadowPolicy } from "../shadows";
import { LIGHT_SCALE } from "../../config";

/**
 * A real-scale street deck: 0.82 m of seven-ply popsicle with a kicked nose and
 * tail, griptape on top, a painted graphic underneath, two trucks and four
 * urethane wheels that spin with ground speed.
 *
 * Front is local −Z (every other vehicle here agrees). The board's own flip and
 * shove-it rotations live on `trickPivot`, while the rider rig is parented to
 * the mesh ROOT — so the deck spins under the feet exactly like a kickflip,
 * instead of rolling the skater with it.
 *
 * Materials are the same Lambert/Standard programs the rest of the app already
 * compiled, and the whole thing is procedural, so building one per remote
 * player costs a few hundred triangles and no pipeline stall.
 */

/**
 * Ride geometry — and the one chain of numbers that decides whether this reads
 * as a skateboard or as a floating credit card.
 *
 * The avatar is a chunky voxel figure with a 0.31 m foot. A real 0.81 m deck
 * under it looks like a toy, so the whole board is built at cartoon scale:
 * 1.30 m long, 0.33 m wide, 55 mm wheels. Two feet at 0.16 m wide then sit on
 * it with room to spare instead of hanging off both rails.
 *
 * The mesh ORIGIN is not the deck — it sits `SKATE_DECK_DROP` above it, at
 * roughly the rider's shins. That indirection exists for one reason: the
 * physics box is centred on the origin, and this project requires every ground
 * driveable to keep MIN_DRIVE_GROUND_CLEARANCE (0.18 m) between the box bottom
 * and the road (vehicles/shared.ts). A deck riding a hand's width off the
 * tarmac cannot do that, so the collider rides at shin height and the board
 * hangs below it.
 *
 * These four numbers must stay consistent or the board floats:
 *   wheel bottom = RIDE − DECK_DROP − DECK_TO_WHEEL   must equal 0
 *   sole         = RIG_ROOT − SOLE_DROP               must equal −DECK_DROP + ε
 */
import { SKATE_DECK_DROP, SKATE_DECK_TO_WHEEL, SKATE_CONTACT_Y } from "./dimensions";
export { SKATE_RIDE_HEIGHT, SKATE_DECK_DROP, SKATE_DECK_TO_WHEEL, SKATE_CONTACT_Y, SKATE_RIG_ROOT_Y } from "./dimensions";

const HALF_LENGTH = 0.65;
const HALF_WIDTH = 0.165;
const PLY = 0.022;
const WHEEL_R = 0.055;
const AXLE_Z = 0.29;
const AXLE_X = 0.148;
const AXLE_Y = -(SKATE_DECK_TO_WHEEL - WHEEL_R); // wheel centres, deck-top-relative

const SPARK_COUNT = 26;

export type SkateSparkState = {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  vz: Float32Array;
  life: Float32Array;
  next: number;
};

export type SkateAnim = {
  trickPivot: THREE.Group;
  wheels: THREE.Mesh[];
  sparks: THREE.InstancedMesh;
  sparkState: SkateSparkState;
  griptape: THREE.Mesh;
};

/** Per-frame visual state the controller hands the mesh. */
export type SkateVisual = {
  /** Deck roll about its own long axis — kickflips/heelflips (radians). */
  flipRoll: number;
  /** Deck yaw about its own up axis — shove-its (radians). */
  shove: number;
  /** 0..1 — emit sparks off the grinding trucks. */
  grindSparks: number;
  /** Ground speed in m/s (wheel spin). */
  speed: number;
};

/** Popsicle outline sampled as (lateral, longitudinal) for extrusion. */
function deckShape(): THREE.Shape {
  const shape = new THREE.Shape();
  const N = 26;
  const halfW = (t: number) => HALF_WIDTH * Math.sqrt(Math.max(0, 1 - Math.pow(Math.abs(t), 8)));
  // right side, nose → tail
  for (let i = 0; i <= N; i++) {
    const t = 1 - (2 * i) / N;
    const y = t * HALF_LENGTH;
    const x = halfW(t);
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  // left side, tail → nose
  for (let i = N; i >= 0; i--) {
    const t = 1 - (2 * i) / N;
    shape.lineTo(-halfW(t), t * HALF_LENGTH);
  }
  shape.closePath();
  return shape;
}

/** Extruded deck, laid flat, with the nose/tail bent up and a mild concave. */
function deckGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.ExtrudeGeometry(deckShape(), {
    depth: PLY,
    bevelEnabled: true,
    bevelSize: 0.007,
    bevelThickness: 0.005,
    bevelSegments: 1,
    curveSegments: 1
  });
  geometry.translate(0, 0, -PLY / 2);
  geometry.rotateX(-Math.PI / 2); // (x, y, z) → (x, z, −y): length runs along −Z
  geometry.translate(0, -PLY / 2, 0); // deck top at y = 0

  const pos = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Nose (−Z) kicks harder than the tail, as it should.
    const along = Math.abs(z) / HALF_LENGTH;
    const kickStart = 0.56;
    const k = along <= kickStart ? 0 : (along - kickStart) / (1 - kickStart);
    const kick = k * k * (z < 0 ? 0.1 : 0.085);
    // Concave: the rails ride a few millimetres above the middle.
    const across = Math.min(1, Math.abs(x) / HALF_WIDTH);
    pos.setY(i, y + kick + across * across * 0.011);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

const HUES = [0.02, 0.09, 0.33, 0.5, 0.58, 0.72, 0.86];

/** Stable per-player deck colour so remote skaters aren't all the same board. */
export function skateHueFor(seed: number): number {
  const h = Math.abs(Math.round(seed)) % HUES.length;
  return HUES[h];
}

export function buildSkateMesh(hue = 0.58): THREE.Group {
  const root = new THREE.Group();
  root.name = "skateboard";
  // Everything physical hangs below the collider origin.
  const deckRoot = new THREE.Group();
  deckRoot.name = "skate_deck_root";
  deckRoot.position.y = -SKATE_DECK_DROP;
  root.add(deckRoot);
  const trickPivot = new THREE.Group();
  trickPivot.name = "skate_trick_pivot";
  deckRoot.add(trickPivot);

  const ownedGeometries = new Set<THREE.BufferGeometry>();
  const ownedMaterials: THREE.Material[] = [];
  const shadowCasters: THREE.Mesh[] = [];

  const own = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeometries.add(g);
    return g;
  };
  const mat = <T extends THREE.Material>(m: T): T => {
    ownedMaterials.push(m);
    return m;
  };

  const graphic = new THREE.Color().setHSL(hue, 0.72, 0.46);
  const plyMaterial = mat(new THREE.MeshStandardMaterial({ color: 0xc9a273, roughness: 0.72, metalness: 0.02 }));
  const gripMaterial = mat(new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.98, metalness: 0 }));
  const artMaterial = mat(new THREE.MeshStandardMaterial({ color: graphic, roughness: 0.34, metalness: 0.06 }));
  const steel = mat(new THREE.MeshStandardMaterial({ color: 0xb9c2c6, roughness: 0.3, metalness: 0.78 }));
  const dark = mat(new THREE.MeshStandardMaterial({ color: 0x2a3036, roughness: 0.5, metalness: 0.45 }));
  const urethane = mat(
    new THREE.MeshStandardMaterial({ color: 0xf3efe4, roughness: 0.46, metalness: 0 })
  );

  const deckGeo = own(deckGeometry());
  const deck = new THREE.Mesh(deckGeo, plyMaterial);
  trickPivot.add(deck);
  shadowCasters.push(deck);

  // Griptape and the underside graphic reuse the deck's bent profile, nudged
  // off its faces — one silhouette, three surfaces, no extra outline maths.
  const gripGeo = own(deckGeo.clone());
  gripGeo.scale(0.97, 1, 0.988);
  gripGeo.translate(0, 0.0035, 0);
  const griptape = new THREE.Mesh(gripGeo, gripMaterial);
  trickPivot.add(griptape);

  const artGeo = own(deckGeo.clone());
  artGeo.scale(0.93, 1, 0.965);
  artGeo.translate(0, -0.0045, 0);
  trickPivot.add(new THREE.Mesh(artGeo, artMaterial));

  // --- trucks + wheels -----------------------------------------------------
  const baseplateGeo = own(new THREE.BoxGeometry(0.14, 0.014, 0.085));
  const hangerGeo = own(new THREE.CylinderGeometry(0.024, 0.034, 0.125, 8));
  const axleGeo = own(new THREE.CylinderGeometry(0.008, 0.008, 0.33, 6));
  const kingpinGeo = own(new THREE.CylinderGeometry(0.009, 0.009, 0.05, 5));
  const wheelGeo = own(new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, 0.052, 16));
  wheelGeo.rotateZ(Math.PI / 2); // spin axis along X
  // A pale spot on the wheel face: without it a spinning cylinder of one colour
  // reads as perfectly still, and rolling is most of what a skateboard does.
  const bearingGeo = own(new THREE.CylinderGeometry(0.019, 0.019, 0.056, 8));
  bearingGeo.rotateZ(Math.PI / 2);
  const pipGeo = own(new THREE.BoxGeometry(0.012, 0.07, 0.012));

  const wheels: THREE.Mesh[] = [];
  for (const dz of [-AXLE_Z, AXLE_Z]) {
    const nose = dz < 0;
    const baseplate = new THREE.Mesh(baseplateGeo, dark);
    baseplate.position.set(0, -PLY - 0.007, dz);
    trickPivot.add(baseplate);

    const hanger = new THREE.Mesh(hangerGeo, steel);
    // The hanger leans toward the deck ends, the way a real truck sits.
    hanger.position.set(0, -0.07, dz + (nose ? -0.02 : 0.02));
    hanger.rotation.x = nose ? -0.62 : 0.62;
    trickPivot.add(hanger);
    shadowCasters.push(hanger);

    const kingpin = new THREE.Mesh(kingpinGeo, dark);
    kingpin.position.set(0, -0.05, dz + (nose ? 0.014 : -0.014));
    kingpin.rotation.x = nose ? 0.5 : -0.5;
    trickPivot.add(kingpin);

    const axle = new THREE.Mesh(axleGeo, steel);
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, AXLE_Y, dz);
    trickPivot.add(axle);

    for (const dx of [-AXLE_X, AXLE_X]) {
      const wheel = new THREE.Mesh(wheelGeo, urethane);
      wheel.position.set(dx, AXLE_Y, dz);
      trickPivot.add(wheel);
      wheels.push(wheel);
      shadowCasters.push(wheel);
      const bearing = new THREE.Mesh(bearingGeo, steel);
      bearing.position.set(dx * 0.9, AXLE_Y, dz);
      trickPivot.add(bearing);
      // Spoke pip, parented to the wheel so it turns with it — this is what
      // actually sells "rolling" at a distance.
      const pip = new THREE.Mesh(pipGeo, dark);
      pip.position.set(dx > 0 ? 0.027 : -0.027, 0, 0);
      wheel.add(pip);
    }
  }

  // --- grind sparks --------------------------------------------------------
  // Pooled additive chips thrown off the trucks. They live in DECK-ROOT space
  // (not the trick pivot) so a shove-it doesn't drag the shower around with it.
  const sparkGeo = own(new THREE.PlaneGeometry(0.075, 0.018));
  const sparkMaterial = mat(
    new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xffd08a).multiplyScalar(LIGHT_SCALE),
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    })
  );
  const sparks = new THREE.InstancedMesh(sparkGeo, sparkMaterial, SPARK_COUNT);
  sparks.frustumCulled = false;
  sparks.visible = false;
  sparks.castShadow = false;
  sparks.receiveShadow = false;
  const sparkState: SkateSparkState = {
    x: new Float32Array(SPARK_COUNT),
    y: new Float32Array(SPARK_COUNT),
    z: new Float32Array(SPARK_COUNT),
    vx: new Float32Array(SPARK_COUNT),
    vy: new Float32Array(SPARK_COUNT),
    vz: new Float32Array(SPARK_COUNT),
    life: new Float32Array(SPARK_COUNT),
    next: 0
  };
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < SPARK_COUNT; i++) sparks.setMatrixAt(i, hidden);
  sparks.instanceMatrix.needsUpdate = true;
  deckRoot.add(sparks);

  root.userData.contactY = SKATE_CONTACT_Y;
  root.userData.skateAnim = { trickPivot, wheels, sparks, sparkState, griptape } satisfies SkateAnim;
  applyVehicleShadowPolicy(root, shadowCasters);
  let disposed = false;
  root.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const g of ownedGeometries) g.dispose();
    for (const m of ownedMaterials) m.dispose();
  };
  return root;
}

const SPARK_M = new THREE.Matrix4();
const SPARK_P = new THREE.Vector3();
const SPARK_Q = new THREE.Quaternion();
const SPARK_S = new THREE.Vector3();
const SPARK_E = new THREE.Euler();

/**
 * Roll the wheels, apply the deck's own trick rotation, and run the spark pool.
 * Called once per rendered frame by whoever owns the mesh.
 */
export function animateSkate(root: THREE.Group, dt: number, visual: SkateVisual): void {
  const anim = root.userData.skateAnim as SkateAnim | undefined;
  if (!anim) return;

  const spin = (dt * visual.speed) / WHEEL_R;
  for (const wheel of anim.wheels) wheel.rotation.x -= spin;

  anim.trickPivot.rotation.set(0, visual.shove, visual.flipRoll, "YZX");

  const s = anim.sparkState;
  let alive = false;
  const emit = visual.grindSparks;
  if (emit > 0.01) {
    // Two or three chips per frame off the trailing truck, scaled by intensity.
    const want = 1 + Math.floor(emit * 2.4);
    for (let n = 0; n < want; n++) {
      const i = s.next;
      s.next = (s.next + 1) % SPARK_COUNT;
      const side = Math.random() < 0.5 ? -1 : 1;
      s.x[i] = side * 0.08 * Math.random();
      s.y[i] = -0.1;
      s.z[i] = AXLE_Z * (Math.random() < 0.5 ? -1 : 1) * 0.9;
      s.vx[i] = side * (0.3 + Math.random() * 0.9);
      s.vy[i] = 0.4 + Math.random() * 1.5;
      s.vz[i] = (0.6 + Math.random() * 2.6) * (visual.speed > 0 ? 1 : -1);
      s.life[i] = 0.22 + Math.random() * 0.26;
    }
  }
  for (let i = 0; i < SPARK_COUNT; i++) {
    if (s.life[i] <= 0) continue;
    s.life[i] -= dt;
    if (s.life[i] <= 0) {
      SPARK_M.makeScale(0, 0, 0);
      anim.sparks.setMatrixAt(i, SPARK_M);
      continue;
    }
    alive = true;
    s.vy[i] -= 7 * dt;
    s.x[i] += s.vx[i] * dt;
    s.y[i] += s.vy[i] * dt;
    s.z[i] += s.vz[i] * dt;
    const fade = Math.min(1, s.life[i] * 4);
    SPARK_P.set(s.x[i], s.y[i], s.z[i]);
    SPARK_E.set(0, Math.atan2(s.vx[i], s.vz[i]), 0);
    SPARK_Q.setFromEuler(SPARK_E);
    SPARK_S.set(0.5 + fade, fade, 0.5 + fade * 1.6);
    SPARK_M.compose(SPARK_P, SPARK_Q, SPARK_S);
    anim.sparks.setMatrixAt(i, SPARK_M);
  }
  anim.sparks.instanceMatrix.needsUpdate = true;
  anim.sparks.visible = alive;
}
