import * as THREE from "three/webgpu";
import type { Cockpit } from "../../player/types";
import { buildBunting, buildFlag } from "../../fx/cloth";
import { GuitaristStand, LauncherRig, LAUNCH_SPEED, RocketBattery, buildGuitarPlayer } from "../../gameplay/launchers";
import { TRUCK_RIDE_HEIGHT } from "./dimensions";
import { buildEagle } from "./eagle";

/**
 * The Freedom Truck — a fully procedural flag-wrapped F-450 crew-cab dually
 * flatbed (replaces the old Tripo GLB, which had messy geometry and wobbly
 * tyres). The whole body is painted by one canvas livery projected down the
 * truck's length: a navy star field over the hood/cab flowing into red/white
 * stripes over the bed, like a flag stretched nose to tail. Front is local -Z,
 * group y=0 is the chassis centre (TRUCK_RIDE_HEIGHT above the ground, wheels
 * planted at y=-RIDE), and the bald eagle / rocket battery / jamming guitarist
 * ride the bed + cab roof.
 *
 * The launchers hang off a LauncherRig on `userData.launcherRig`; the host is
 * dependency-free — main.ts injects the fireworks/rocket-rider systems at fire
 * time, so the same rig drops onto a boat later untouched.
 */

const RIDE = TRUCK_RIDE_HEIGHT; // wheels planted this far below the group origin

// --- group-local anchors (kept from the GLB fit so every rider stays put)
const BED_FLOOR_Y = 1.0; // deck surface the rockets/eagle rest on
const BED_RAIL_Y = 2.15; // top of the bed rails
const CAB_ROOF_Y = 3.18; // flat cab roof the guitarist stands on
const BED_CENTRE_Z = 4.8; // middle of the open bed
const BED_REAR_Z = 9.2; // tailgate end of the bed (nearest the chase cam)
const CAB_Z = -2.0; // over the cab roof
const BED_HALF_W = 2.5; // interior half-width of the bed

// --- body plan (game frame: -z = nose, +z = tailgate)
const NOSE_Z = -9.2;
const TAIL_Z = 9.2;
const HOOD_CAB_Z = -4.8; // hood/windshield split
const CAB_BED_Z = 0.4; // back of the cab / bed headboard
const BODY_HALF_W = 2.55; // painted panel width
const GREEN_HALF_W = 2.1; // greenhouse (glass box) width
const BELT_Y = 1.75; // beltline: hood top / bottom of the glass
const ROCKER_Y = -0.3; // bottom edge of the painted body (lifted — frame shows)
const WHEEL_R = 1.4;
const WHEEL_W = 0.72;
const WHEEL_Y = -RIDE + WHEEL_R; // axle height (tyres planted on the ground)
const FRONT_AXLE_Z = -6.4;
const REAR_AXLE_Z = [4.5, 7.1]; // tandem duallys under the bed

const BATTERY_SCALE = 1.7;
const GUITARIST_SCALE = 1.5;
const GUITARIST_FOOT_DROP = 0.05; // hips→sole in the guitarist's own units

// -----------------------------------------------------------------------------
// livery — one flag painted down the side of the whole truck. u runs nose→tail,
// v runs rocker→roof, so every panel just projects its position into this map.
const STAR_SPLIT = 0.42; // u where the star field hands off to the stripes

function drawStar(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const px = x + Math.cos(a) * rad;
    const py = y + Math.sin(a) * rad;
    i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
}

function makeLiveryTexture(): THREE.CanvasTexture {
  const W = 2048;
  const H = 512;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  // stripes over everything (red leads at the top, like a flying flag)
  const STRIPES = 9;
  for (let i = 0; i < STRIPES; i++) {
    ctx.fillStyle = i % 2 === 0 ? "#b01230" : "#ece7dc";
    ctx.fillRect(0, (i * H) / STRIPES, W, H / STRIPES + 1);
  }

  // navy star field over the nose, with a ragged hand-painted trailing edge
  const edge = STAR_SPLIT * W;
  ctx.fillStyle = "#141b30";
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(edge, 0);
  const teeth = 12;
  for (let i = 0; i <= teeth; i++) {
    const y = (i / teeth) * H;
    const wob = Math.sin(i * 2.4) * 26 + Math.sin(i * 0.9 + 1.7) * 18;
    ctx.lineTo(edge + wob, y);
  }
  ctx.lineTo(0, H);
  ctx.closePath();
  ctx.fill();

  // scattered stars, jittered off a grid so they read painted-on, not printed
  ctx.fillStyle = "#f4f1e6";
  const cols = 9;
  const rows = 6;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const jx = Math.sin(cx * 12.9 + cy * 78.2) * 0.5 + 0.5;
      const jy = Math.sin(cx * 39.4 + cy * 11.1) * 0.5 + 0.5;
      const x = ((cx + 0.15 + jx * 0.7) / cols) * edge;
      const y = ((cy + 0.15 + jy * 0.7) / rows) * H;
      const r = 16 + jx * 14;
      ctx.globalAlpha = 0.75 + jy * 0.25;
      drawStar(ctx, x, y, r);
    }
  }
  ctx.globalAlpha = 1;

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** navy + stars tile for upward faces (hood, roof, fender flares). */
function makeStarTileTexture(): THREE.CanvasTexture {
  const S = 256;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#141b30";
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = "#f4f1e6";
  for (let i = 0; i < 5; i++) {
    const jx = Math.sin(i * 12.9) * 0.5 + 0.5;
    const jy = Math.sin(i * 78.2) * 0.5 + 0.5;
    ctx.globalAlpha = 0.8 + jy * 0.2;
    drawStar(ctx, (0.15 + jx * 0.7) * S, (0.15 + jy * 0.7) * S, 18 + jx * 10);
  }
  ctx.globalAlpha = 1;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/**
 * Rewrite a box's UVs so side/front/back faces sample the livery by their
 * group-space position (u: nose→tail, v: ground→roof) and up/down faces tile
 * the star pattern by world footprint. `at` is where the mesh will sit.
 */
function projectLiveryUV(geom: THREE.BufferGeometry, at: THREE.Vector3) {
  const pos = geom.attributes.position;
  const nrm = geom.attributes.normal;
  const uv = geom.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + at.x;
    const y = pos.getY(i) + at.y;
    const z = pos.getZ(i) + at.z;
    if (Math.abs(nrm.getY(i)) < 0.7) {
      uv.setXY(i, (z - NOSE_Z) / (TAIL_Z - NOSE_Z), (y + RIDE) / (CAB_ROOF_Y + RIDE + 0.4));
    } else {
      uv.setXY(i, x / 1.6, z / 1.6); // star tile, uniform world density
    }
  }
  uv.needsUpdate = true;
}

/** A flag flying from a pole (bed rails). Sizes in game metres. */
function poleFlag(height: number, flagW: number, flagH: number, phase = 0): THREE.Group {
  const g = new THREE.Group();
  const poleRadius = 0.08;
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(poleRadius, poleRadius, height, 8),
    new THREE.MeshLambertMaterial({ color: 0x8a8f96 })
  );
  pole.position.y = height / 2;
  g.add(pole);
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 8), new THREE.MeshLambertMaterial({ color: 0xf2b01a }));
  knob.position.y = height + 0.06;
  g.add(knob);
  const flag = buildFlag({ w: flagW, h: flagH, amp: 0.13, speed: 6, phase });
  flag.position.set(0.04, height - flagH * 0.6, 0);
  g.add(flag);
  return g;
}

// -----------------------------------------------------------------------------

export function buildTruckMesh(): THREE.Group {
  const g = new THREE.Group();

  const livery = new THREE.MeshStandardMaterial({
    map: makeLiveryTexture(),
    roughness: 0.45,
    metalness: 0.2
  });
  const starTop = new THREE.MeshStandardMaterial({
    map: makeStarTileTexture(),
    roughness: 0.5,
    metalness: 0.2
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x14161b, roughness: 0.85 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xd7dade, roughness: 0.22, metalness: 0.95 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x233242, roughness: 0.08, metalness: 0.85 });
  const rust = new THREE.MeshStandardMaterial({ color: 0xa35c22, roughness: 0.6, metalness: 0.5 });

  const shadowed = (m: THREE.Mesh) => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // painted body panel: livery on the sides/ends, star tile on top, dark below
  const bodyBox = (w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
    const geom = new THREE.BoxGeometry(w, h, d);
    const at = new THREE.Vector3(x, y, z);
    projectLiveryUV(geom, at);
    const m = new THREE.Mesh(geom, [livery, livery, starTop, dark, livery, livery]);
    m.position.copy(at);
    g.add(shadowed(m));
    return m;
  };
  const box = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(shadowed(m));
    return m;
  };

  // --- painted body: hood → crew cab → bed walls, one continuous flag
  const hoodLen = HOOD_CAB_Z - NOSE_Z;
  bodyBox(BODY_HALF_W * 2, BELT_Y - ROCKER_Y, hoodLen, 0, (BELT_Y + ROCKER_Y) / 2, (NOSE_Z + HOOD_CAB_Z) / 2);
  bodyBox(1.5, 0.3, 1.5, 0, BELT_Y + 0.15, -6.9); // hood scoop

  const cabLen = CAB_BED_Z - HOOD_CAB_Z;
  const cabMidZ = (HOOD_CAB_Z + CAB_BED_Z) / 2;
  bodyBox(BODY_HALF_W * 2, BELT_Y - ROCKER_Y, cabLen, 0, (BELT_Y + ROCKER_Y) / 2, cabMidZ);
  // greenhouse: painted pillars/roof, glass slabs sitting proud of each face
  bodyBox(GREEN_HALF_W * 2, CAB_ROOF_Y - BELT_Y, cabLen - 0.5, 0, (CAB_ROOF_Y + BELT_Y) / 2, cabMidZ);
  const windshield = new THREE.Mesh(new THREE.BoxGeometry(GREEN_HALF_W * 2 - 0.3, 1.35, 0.1), glass);
  windshield.position.set(0, 2.45, HOOD_CAB_Z + 0.18);
  windshield.rotation.x = 0.25; // raked back
  g.add(shadowed(windshield));
  box(glass, GREEN_HALF_W * 2 - 0.3, 1.0, 0.1, 0, 2.5, CAB_BED_Z - 0.2); // rear glass
  for (const sx of [-1, 1] as const) {
    box(glass, 0.1, 1.0, cabLen - 1.1, sx * GREEN_HALF_W, 2.45, cabMidZ); // side glass
    bodyBox(0.14, 1.1, 0.28, sx * GREEN_HALF_W, 2.45, cabMidZ); // B-pillar over it
    // mirrors on chrome arms
    box(chrome, 0.55, 0.08, 0.08, sx * (BODY_HALF_W + 0.28), 2.4, HOOD_CAB_Z + 0.5);
    box(dark, 0.1, 0.55, 0.4, sx * (BODY_HALF_W + 0.55), 2.4, HOOD_CAB_Z + 0.5);
  }

  // --- flatbed: floor + painted walls; the rockets/eagle sit on BED_FLOOR_Y
  const bedLen = TAIL_Z - CAB_BED_Z;
  const bedMidZ = (CAB_BED_Z + TAIL_Z) / 2;
  box(dark, BED_HALF_W * 2 + 0.5, 0.3, bedLen, 0, BED_FLOOR_Y - 0.15, bedMidZ); // deck
  for (const sx of [-1, 1] as const) {
    bodyBox(0.28, BED_RAIL_Y - ROCKER_Y, bedLen, sx * (BED_HALF_W + 0.14), (BED_RAIL_Y + ROCKER_Y) / 2, bedMidZ);
  }
  bodyBox(BED_HALF_W * 2, BED_RAIL_Y - ROCKER_Y, 0.3, 0, (BED_RAIL_Y + ROCKER_Y) / 2, CAB_BED_Z + 0.15); // headboard
  bodyBox(BED_HALF_W * 2, BED_RAIL_Y - ROCKER_Y, 0.3, 0, (BED_RAIL_Y + ROCKER_Y) / 2, TAIL_Z - 0.15); // tailgate

  // --- chassis peeking out under the lifted body
  for (const sx of [-1, 1] as const) {
    box(dark, 0.3, 0.6, 16.5, sx * 1.4, -1.35, 0.2); // frame rails
  }
  for (const az of [FRONT_AXLE_Z, ...REAR_AXLE_Z]) {
    const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 4.6, 10), dark);
    axle.rotation.z = Math.PI / 2;
    axle.position.set(0, WHEEL_Y, az);
    g.add(shadowed(axle));
  }
  box(dark, 1.6, 0.9, 2.2, 0, -1.5, 0.6); // transfer case

  // --- nose furniture: chrome bumper, grille, emissive headlights
  box(chrome, 4.9, 0.7, 0.45, 0, -0.2, NOSE_Z - 0.15);
  box(dark, 3.6, 1.35, 0.2, 0, 0.9, NOSE_Z - 0.02); // grille shell
  for (let i = 0; i < 3; i++) box(chrome, 3.4, 0.14, 0.24, 0, 0.45 + i * 0.42, NOSE_Z - 0.04);
  const headlightMat = new THREE.MeshStandardMaterial({
    color: 0xf6f2df,
    emissive: 0xfff3cf,
    emissiveIntensity: 2.2,
    roughness: 0.3
  });
  for (const sx of [-1, 1] as const) box(headlightMat, 0.7, 0.35, 0.16, sx * 1.95, 1.25, NOSE_Z - 0.04);

  // --- tail: chrome step bumper + red taillights on the rail ends
  box(chrome, 4.9, 0.6, 0.4, 0, -0.15, TAIL_Z + 0.15);
  const tailMat = new THREE.MeshStandardMaterial({
    color: 0x7a0d18,
    emissive: 0xff1a22,
    emissiveIntensity: 1.6,
    roughness: 0.4
  });
  for (const sx of [-1, 1] as const) box(tailMat, 0.26, 0.9, 0.14, sx * (BED_HALF_W + 0.14), 1.5, TAIL_Z + 0.03);

  // --- monster-truck jewellery: roof marker lights, chrome stacks, side steps
  const markerMat = new THREE.MeshStandardMaterial({
    color: 0xe8901c,
    emissive: 0xffa21e,
    emissiveIntensity: 2.4,
    roughness: 0.4
  });
  for (let i = 0; i < 5; i++) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 8), markerMat);
    m.position.set(-1.3 + i * 0.65, CAB_ROOF_Y + 0.06, HOOD_CAB_Z + 0.55);
    g.add(m);
  }
  for (const sx of [-1, 1] as const) {
    const stack = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.16, 3.1, 10), chrome);
    stack.position.set(sx * 2.05, BED_RAIL_Y + 1.1, CAB_BED_Z + 0.55);
    g.add(shadowed(stack));
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.13, 0.5, 10), chrome);
    tip.position.set(sx * 2.05, BED_RAIL_Y + 2.85, CAB_BED_Z + 0.55);
    g.add(tip);
    box(chrome, 0.3, 0.12, 4.6, sx * (BODY_HALF_W + 0.25), -0.75, cabMidZ); // running board
  }

  // --- wheels: front singles + rear tandem duallys. Each wheel group is yawed
  // 90° so its local Z lands on the game's width axis — the driver spins
  // rotation.z by travelled distance (same convention the old GLB verified).
  const buildWheel = (dually: boolean): THREE.Group => {
    const w = new THREE.Group();
    const tyreGeom = new THREE.CylinderGeometry(WHEEL_R, WHEEL_R, WHEEL_W, 24).rotateX(Math.PI / 2);
    const rimGeom = new THREE.CylinderGeometry(0.74, 0.74, WHEEL_W + 0.14, 16).rotateX(Math.PI / 2);
    const hubGeom = new THREE.CylinderGeometry(0.24, 0.24, WHEEL_W + 0.34, 10).rotateX(Math.PI / 2);
    const ringGeom = new THREE.TorusGeometry(0.72, 0.07, 8, 24);
    const tyreMat = new THREE.MeshStandardMaterial({ color: 0x17181a, roughness: 0.95 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x585d66, roughness: 0.3, metalness: 0.9 });
    const spokeMat = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.5, metalness: 0.7 });
    const spokeGeom = new THREE.BoxGeometry(0.16, 1.15, WHEEL_W + 0.2);
    for (const off of dually ? [-0.42, 0.42] : [0]) {
      const tyre = new THREE.Mesh(tyreGeom, tyreMat);
      tyre.position.z = off;
      w.add(shadowed(tyre));
      const rim = new THREE.Mesh(rimGeom, rimMat);
      rim.position.z = off;
      w.add(rim);
      const hub = new THREE.Mesh(hubGeom, rimMat);
      hub.position.z = off;
      w.add(hub);
      for (let s = 0; s < 3; s++) {
        const spoke = new THREE.Mesh(spokeGeom, spokeMat);
        spoke.position.z = off;
        spoke.rotation.z = (s * Math.PI) / 3; // 6 dark spokes over the steel rim face
        w.add(spoke);
      }
      for (const rz of [-1, 1]) {
        const ring = new THREE.Mesh(ringGeom, rust); // rusty beadlock rings
        ring.position.z = off + rz * (WHEEL_W / 2 + 0.02);
        w.add(ring);
      }
    }
    return w;
  };

  const wheels: { mesh: THREE.Object3D; invRadius: number }[] = [];
  const placeWheel = (x: number, z: number, dually: boolean) => {
    const w = buildWheel(dually);
    w.position.set(x, WHEEL_Y, z);
    w.rotation.y = Math.PI / 2; // local Z → world X (the axle)
    g.add(w);
    wheels.push({ mesh: w, invRadius: 1 / WHEEL_R });
  };
  for (const sx of [-1, 1] as const) {
    placeWheel(sx * 2.35, FRONT_AXLE_Z, false);
    for (const az of REAR_AXLE_Z) placeWheel(sx * 2.35, az, true);
  }
  g.userData.wheels = wheels;

  // star-spangled fender flares hugging the tyres
  for (const sx of [-1, 1] as const) {
    bodyBox(0.9, 0.5, 3.6, sx * (BODY_HALF_W - 0.1), -0.05, FRONT_AXLE_Z);
    bodyBox(0.9, 0.5, 4.9, sx * (BED_HALF_W + 0.1), -0.05, (REAR_AXLE_Z[0] + REAR_AXLE_Z[1]) / 2);
  }

  // closed cab — the driver rides inside behind tinted glass, so the driver rig
  // is parked (player.ts honours `hide`). Seat/wheel kept for anyone who reads it.
  g.userData.cockpit = {
    seat: [-0.9, 1.5, CAB_Z + 0.4],
    wheel: [-0.9, 2.05, CAB_Z - 0.7],
    hide: true
  } satisfies Cockpit;

  // --- the blow-up eagle: perched at the very BACK of the bed on a low riser,
  // towering behind the launchers, facing forward down the truck (-Z). This is
  // the element the chase cam frames as it swings behind at the climax.
  const riser = new THREE.Mesh(
    new THREE.BoxGeometry(2.6, 0.7, 1.6),
    new THREE.MeshLambertMaterial({ color: 0x1c1f25 })
  );
  riser.position.set(0, BED_FLOOR_Y + 0.35, BED_REAR_Z - 1.0);
  riser.castShadow = true;
  g.add(riser);
  const eagle = buildEagle();
  eagle.position.set(0, BED_FLOOR_Y + 0.7, BED_REAR_Z - 1.0);
  eagle.scale.setScalar(1.7);
  g.add(eagle);

  // bunting swagged across the headboard (front wall of the bed, behind the cab)
  const bunting = buildBunting({ span: BED_HALF_W * 2, count: 11, drop: 0.55, sag: 0.32 });
  bunting.position.set(-BED_HALF_W, BED_RAIL_Y + 0.35, 0.3);
  g.add(bunting);

  // a run of rippling flags flying off both bed rails, framing the show
  for (const sx of [-1, 1] as const) {
    for (let i = 0; i < 3; i++) {
      const f = poleFlag(1.9, 1.35, 0.85, i * 0.7 + (sx > 0 ? 0.3 : 1.5));
      f.position.set(sx * (BED_HALF_W + 0.15), BED_RAIL_Y - 0.15, 1.6 + i * 2.6);
      g.add(f);
    }
  }

  // --- the show: a rack of rockets lies in the open bed (one click launches
  // them all into a red/white/blue firework barrage), and the guitarist jams on
  // the cab roof, well clear of the eagle at the back.
  const rig = new LauncherRig(g);
  // battery rows sit at local z {0.4,1.7}·scale; offset the origin so they centre
  // on the bed and nose forward toward the cab.
  const rowMid = ((0.4 + 1.7) / 2) * BATTERY_SCALE;
  const battery = rig.add(new RocketBattery(LAUNCH_SPEED * 1.5), [0, BED_FLOOR_Y, BED_CENTRE_Z - rowMid], [0, 0, 0]);
  battery.group.scale.setScalar(BATTERY_SCALE);
  const guitarist = rig.add(new GuitaristStand({ buildRider: buildGuitarPlayer }), [
    0,
    CAB_ROOF_Y + GUITARIST_FOOT_DROP * GUITARIST_SCALE,
    CAB_Z
  ], [0, 0, 0]);
  guitarist.group.scale.setScalar(GUITARIST_SCALE);
  g.userData.launcherRig = rig;

  return g;
}
