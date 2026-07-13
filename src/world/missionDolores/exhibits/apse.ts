import * as THREE from "three/webgpu";
import type { MuseumCtx } from "../ctx";
import type { MdExhibit } from "./index";

// ---------------------------------------------------------------------------
// THE APSE SHRINE — the sacred far end of the nave.
// A statue of Saint Francis on a stepped stone plinth, backlit by a great
// rose window and flanked by two lancet windows, ringed with soft candles,
// and grounded by a dedication plaque at the visitor's approach.
// ---------------------------------------------------------------------------

const SHRINE_X = 0;
const SHRINE_Z = 33.2;
const ALTAR_Z = 29.1;

const STATUE_STONE = 0xcdb79a; // warm pale stone — the statue body
const STATUE_TRIM = 0xe8d9bd; // slightly lighter trim — dove, feather details
const PLINTH_STONE = 0xb08a63; // deeper stone — stepped base
const ROPE_BROWN = 0x5a3e26; // cincture cord + knots
const CANDLE_WAX = 0xe8d9bd;
const CANDLE_FLAME = 0xd9a93b;

interface Candle {
  mat: THREE.MeshStandardMaterial;
  base: number;
  amp: number;
  speed: number;
  phase: number;
}

export function createApseShrine(ctx: MuseumCtx): MdExhibit {
  const grp = new THREE.Group();
  grp.name = "md_ex_apse";
  ctx.root.add(grp);

  const geoms: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const track = <G extends THREE.BufferGeometry>(g: G): G => {
    geoms.push(g);
    return g;
  };
  const trackMat = <M extends THREE.Material>(m: M): M => {
    mats.push(m);
    return m;
  };

  // ---------------- sanctuary floor: a quiet, concentric pilgrimage path ----------------
  // Thin inlays keep the floor fully walkable while making the apse read as a
  // deliberate sacred destination from the far end of the nave.
  const sanctuaryOuterMat = trackMat(ctx.glowMat(0x8f5a3c, 0.13, 0.9));
  const sanctuaryInnerMat = trackMat(ctx.glowMat(0xd8c49f, 0.16, 0.88));
  const outerInlayGeo = track(new THREE.RingGeometry(4.7, 7.15, 48, 1, Math.PI, Math.PI));
  outerInlayGeo.rotateX(-Math.PI / 2);
  const outerInlay = new THREE.Mesh(outerInlayGeo, sanctuaryOuterMat);
  outerInlay.position.set(0, 0.018, 30);
  outerInlay.name = "md_apse_floor_outer_inlay";
  grp.add(outerInlay);

  const innerInlayGeo = track(new THREE.CircleGeometry(4.5, 48, Math.PI, Math.PI));
  innerInlayGeo.rotateX(-Math.PI / 2);
  const innerInlay = new THREE.Mesh(innerInlayGeo, sanctuaryInnerMat);
  innerInlay.position.set(0, 0.02, 30);
  innerInlay.name = "md_apse_floor_inner_inlay";
  grp.add(innerInlay);

  // ---------------- altar: stone table, linen frontal, Franciscan Tau ----------------
  const altarStoneMat = trackMat(ctx.glowMat(0xcdb79a, 0.2, 0.8));
  const altarLinenMat = trackMat(ctx.glowMat(0xf0e4ca, 0.26, 0.88));
  const altarWoodMat = trackMat(ctx.glowMat(0x6a4427, 0.18, 0.72));
  const altarBase = new THREE.Mesh(track(new THREE.BoxGeometry(3.9, 0.16, 1.42)), altarStoneMat);
  altarBase.position.set(0, 0.08, ALTAR_Z);
  altarBase.name = "md_apse_altar_base";
  grp.add(altarBase);
  for (const x of [-1.15, 1.15]) {
    const support = new THREE.Mesh(track(new THREE.BoxGeometry(0.42, 0.9, 0.72)), altarStoneMat);
    support.position.set(x, 0.58, ALTAR_Z);
    support.name = "md_apse_altar_support";
    grp.add(support);
  }
  const mensa = new THREE.Mesh(track(new THREE.BoxGeometry(3.5, 0.18, 1.16)), altarStoneMat);
  mensa.position.set(0, 1.12, ALTAR_Z);
  mensa.name = "md_apse_altar_mensa";
  grp.add(mensa);
  const frontal = new THREE.Mesh(track(new THREE.PlaneGeometry(1.28, 0.72)), altarLinenMat);
  frontal.rotation.y = Math.PI;
  frontal.position.set(0, 0.7, ALTAR_Z - 0.59);
  frontal.name = "md_apse_altar_linen";
  grp.add(frontal);
  const tauStem = new THREE.Mesh(track(new THREE.BoxGeometry(0.09, 0.42, 0.035)), altarWoodMat);
  tauStem.position.set(0, 0.7, ALTAR_Z - 0.615);
  tauStem.name = "md_apse_tau_cross";
  grp.add(tauStem);
  const tauArm = new THREE.Mesh(track(new THREE.BoxGeometry(0.34, 0.09, 0.035)), altarWoodMat);
  tauArm.position.set(0, 0.87, ALTAR_Z - 0.615);
  tauArm.name = "md_apse_tau_cross";
  grp.add(tauArm);

  // ---------------- stepped stone plinth ----------------
  const plinthMat = trackMat(ctx.glowMat(PLINTH_STONE, 0.14, 0.85));
  const steps: [w: number, h: number][] = [
    [2.2, 0.34],
    [1.9, 0.34],
    [1.6, 0.34]
  ];
  let y0 = 0;
  for (const [w, h] of steps) {
    const geo = track(new THREE.BoxGeometry(w, h, w));
    const mesh = new THREE.Mesh(geo, plinthMat);
    mesh.position.set(SHRINE_X, y0 + h / 2, SHRINE_Z);
    mesh.name = "md_apse_plinth_step";
    grp.add(mesh);
    y0 += h;
  }
  const plinthTop = y0; // ~1.02 m

  // ---------------- statue of Saint Francis ----------------
  const stoneMat = trackMat(ctx.glowMat(STATUE_STONE, 0.22, 0.7));
  const trimMat = trackMat(ctx.glowMat(STATUE_TRIM, 0.26, 0.65));
  const ropeMat = trackMat(ctx.glowMat(ROPE_BROWN, 0.1, 0.8));

  // lower robe — floor-length, gently flared at the hem
  const robeGeo = track(new THREE.CylinderGeometry(0.4, 0.6, 1.3, 16));
  const robe = new THREE.Mesh(robeGeo, stoneMat);
  robe.position.set(SHRINE_X, plinthTop + 0.65, SHRINE_Z);
  robe.name = "md_apse_statue_robe";
  grp.add(robe);

  // torso
  const torsoGeo = track(new THREE.CylinderGeometry(0.28, 0.4, 0.55, 16));
  const torso = new THREE.Mesh(torsoGeo, stoneMat);
  const torsoY = plinthTop + 1.3 + 0.275;
  torso.position.set(SHRINE_X, torsoY, SHRINE_Z);
  torso.name = "md_apse_statue_torso";
  grp.add(torso);

  // cincture cord (Franciscan belt) at the waist, with three hanging knots
  // for the vows of poverty, chastity and obedience
  const beltGeo = track(new THREE.TorusGeometry(0.4, 0.022, 8, 20));
  const belt = new THREE.Mesh(beltGeo, ropeMat);
  belt.rotation.x = Math.PI / 2;
  belt.position.set(SHRINE_X, plinthTop + 1.3, SHRINE_Z);
  grp.add(belt);
  const cordGeo = track(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 6));
  const cord = new THREE.Mesh(cordGeo, ropeMat);
  cord.position.set(SHRINE_X + 0.32, plinthTop + 1.3 - 0.24, SHRINE_Z - 0.3);
  grp.add(cord);
  const knotGeo = track(new THREE.SphereGeometry(0.032, 8, 8));
  for (let i = 0; i < 3; i++) {
    const knot = new THREE.Mesh(knotGeo, ropeMat);
    knot.position.set(SHRINE_X + 0.32, plinthTop + 1.3 - 0.42 - i * 0.14, SHRINE_Z - 0.3);
    grp.add(knot);
  }

  // neck + head
  const neckGeo = track(new THREE.CylinderGeometry(0.12, 0.15, 0.13, 12));
  const neck = new THREE.Mesh(neckGeo, stoneMat);
  const neckY = plinthTop + 1.3 + 0.55 + 0.065;
  neck.position.set(SHRINE_X, neckY, SHRINE_Z);
  grp.add(neck);

  const headGeo = track(new THREE.SphereGeometry(0.24, 16, 12));
  const head = new THREE.Mesh(headGeo, stoneMat);
  const headY = neckY + 0.065 + 0.24;
  head.position.set(SHRINE_X, headY, SHRINE_Z + 0.02);
  head.rotation.x = 0.09; // a gentle, downward gaze toward those who enter
  head.name = "md_apse_statue_head";
  grp.add(head);

  // hood (cowl), drawn up and back — a shell that frames the face
  const hoodGeo = track(new THREE.CylinderGeometry(0.0, 0.32, 0.55, 18, 1, true));
  const hood = new THREE.Mesh(hoodGeo, stoneMat);
  hood.position.set(SHRINE_X, headY + 0.05 + 0.275, SHRINE_Z + 0.06);
  hood.rotation.x = -0.1;
  grp.add(hood);

  // arms — open gently and lifted, a welcoming gesture; the dove rests on
  // the visitor's-right hand (+x side)
  const shoulderY = plinthTop + 1.3 + 0.48;
  const armGeo = track(new THREE.CylinderGeometry(0.08, 0.14, 0.72, 10));
  const handGeo = track(new THREE.SphereGeometry(0.095, 10, 8));
  for (const side of [-1, 1]) {
    const shoulder = new THREE.Vector3(SHRINE_X + side * 0.3, shoulderY, SHRINE_Z);
    const dir = new THREE.Vector3(side * 0.7, 0.62, -0.2).normalize();
    const hand = shoulder.clone().addScaledVector(dir, 0.72);
    const mid = shoulder.clone().add(hand).multiplyScalar(0.5);

    const arm = new THREE.Mesh(armGeo, stoneMat);
    arm.position.copy(mid);
    arm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    grp.add(arm);

    const handMesh = new THREE.Mesh(handGeo, stoneMat);
    handMesh.position.copy(hand);
    grp.add(handMesh);

    if (side === 1) {
      buildDove(grp, hand.clone().add(new THREE.Vector3(0, 0.09, 0)), trimMat, ropeMat, track);
    }
  }

  // ---------------- rose window, high on the curved apse wall ----------------
  const roseMat = trackMat(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xffffff,
      emissiveIntensity: 1.2,
      roughness: 0.4,
      side: THREE.DoubleSide
    })
  );
  const roseGeo = track(new THREE.CircleGeometry(2.6, 48));
  const rose = new THREE.Mesh(roseGeo, roseMat);
  const roseGroup = new THREE.Group();
  // A flat oculus must sit slightly forward of the curved masonry or the wall
  // swallows its outer petals. The second ring reaches back into that reveal.
  roseGroup.position.set(0, 8.55, 38.05);
  roseGroup.rotation.y = Math.PI;
  roseGroup.name = "md_apse_rose_window_assembly";
  rose.position.z = 0.035;
  rose.name = "md_apse_rose_window";
  roseGroup.add(rose);
  const roseFrameMat = trackMat(ctx.glowMat(0x8a6a3a, 0.24, 0.55));
  const roseFrameGeo = track(new THREE.TorusGeometry(2.78, 0.22, 12, 64));
  const roseFrame = new THREE.Mesh(roseFrameGeo, roseFrameMat);
  roseFrame.name = "md_apse_rose_window_frame";
  roseGroup.add(roseFrame);
  const roseRearFrame = new THREE.Mesh(roseFrameGeo, roseFrameMat);
  roseRearFrame.position.z = -0.34;
  roseRearFrame.name = "md_apse_rose_window_reveal";
  roseGroup.add(roseRearFrame);
  const roseBoss = new THREE.Mesh(track(new THREE.CylinderGeometry(0.16, 0.16, 0.09, 16)), roseFrameMat);
  roseBoss.rotation.x = Math.PI / 2;
  roseBoss.position.z = 0.08;
  roseGroup.add(roseBoss);
  grp.add(roseGroup);
  ctx.bindArt(rose, roseMat, "glass-rose", [0, 8.55, 38.05], { wakeDistance: 72, fit: "stretch" });

  // ---------------- two flanking lancet windows, mounted on the apse's curved wall ----------------
  // Apse wall = semicircle radius ~9 centred at (0, SHRINE_Z+4). Seat each lancet
  // ON that curve (just inside it) and face it inward toward the nave.
  const APSE_WALL_R = 8.64;
  const APSE_WALL_CZ = 30; // matches Z_APSE in the shell
  const LANCET_W = 2.15;
  const LANCET_H = 3.35;
  const lancetGeo = track(new THREE.PlaneGeometry(LANCET_W, LANCET_H));
  const lancetFrameMat = trackMat(ctx.glowMat(0x8a6a3a, 0.22, 0.58));
  for (const xSign of [-1, 1]) {
    const phi = xSign * 0.9; // ~51° off the centre line
    const lx = APSE_WALL_R * Math.sin(phi);
    const lz = APSE_WALL_CZ + APSE_WALL_R * Math.cos(phi);
    const lancetMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 1.05,
        roughness: 0.45,
        side: THREE.DoubleSide
      })
    );
    const mesh = new THREE.Mesh(lancetGeo, lancetMat);
    const assembly = new THREE.Group();
    assembly.position.set(lx, 6, lz);
    assembly.rotation.y = Math.PI + phi; // inward normal toward the nave centre
    assembly.name = `md_apse_lancet_assembly_${xSign < 0 ? "west" : "east"}`;
    mesh.position.z = 0.04;
    mesh.name = "md_apse_lancet";
    assembly.add(mesh);
    const frameT = 0.16;
    for (const sx of [-1, 1]) {
      const side = new THREE.Mesh(track(new THREE.BoxGeometry(frameT, LANCET_H + 0.34, 0.14)), lancetFrameMat);
      side.position.x = sx * (LANCET_W / 2 + frameT / 2);
      assembly.add(side);
    }
    for (const sy of [-1, 1]) {
      const cap = new THREE.Mesh(track(new THREE.BoxGeometry(LANCET_W + 0.48, frameT, 0.14)), lancetFrameMat);
      cap.position.y = sy * (LANCET_H / 2 + frameT / 2);
      assembly.add(cap);
    }
    grp.add(assembly);
    const artName = xSign < 0 ? "glass-birds" : "glass-wolf";
    ctx.bindArt(mesh, lancetMat, artName, [lx, 6, lz], { wakeDistance: 64, fit: "stretch" });
  }

  // ---------------- ring of candles before the statue ----------------
  const candles: Candle[] = [];
  const CANDLE_COUNT = 9;
  const waxGeo = track(new THREE.CylinderGeometry(0.045, 0.05, 0.32, 8));
  const flameGeo = track(new THREE.ConeGeometry(0.026, 0.09, 8));
  for (let i = 0; i < CANDLE_COUNT; i++) {
    const a = -1.3 + (2.6 * i) / (CANDLE_COUNT - 1);
    const radius = 1.45;
    const x = SHRINE_X + radius * Math.sin(a);
    const z = SHRINE_Z - radius * Math.cos(a); // arc opens toward -z, the nave
    const waxMat = trackMat(ctx.glowMat(CANDLE_WAX, 0.12, 0.6));
    const wax = new THREE.Mesh(waxGeo, waxMat);
    wax.position.set(x, 0.16, z);
    grp.add(wax);
    const flameMat = trackMat(ctx.glowMat(CANDLE_FLAME, 1.1, 0.3));
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(x, 0.32 + 0.045, z);
    grp.add(flame);
    candles.push({ mat: flameMat, base: 1.1, amp: 0.35, speed: 3.1 + (i % 3) * 0.5, phase: i * 1.7 });
  }

  // ---------------- dedication tablet, physically joined to the altar ----------------
  grp.add(
    ctx.makePlaque({
      title: "Pace e bene",
      body: "Saint Francis of Assisi · c. 1181–1226 · Peace and good",
      w: 2.35,
      h: 0.72,
      pos: [0, 0.7, ALTAR_Z - 0.65],
      faceYaw: Math.PI,
      accent: 0xd9a93b
    })
  );

  // Keep the approach clear while making both sacred furnishings tangible.
  ctx.addCollider({ lx: 0, ly: 0.58, lz: ALTAR_Z, hx: 1.95, hy: 0.58, hz: 0.72 });
  ctx.addCollider({ lx: SHRINE_X, ly: plinthTop / 2, lz: SHRINE_Z, hx: 1.15, hy: plinthTop / 2, hz: 1.15 });

  const shrineWorld = ctx.toWorld(SHRINE_X, 0, SHRINE_Z);
  const FAR_DIST_SQ = 60 * 60;

  return {
    update(_dt: number, elapsed: number, playerPos: THREE.Vector3): void {
      const dx = playerPos.x - shrineWorld.x;
      const dz = playerPos.z - shrineWorld.z;
      if (dx * dx + dz * dz > FAR_DIST_SQ) return;
      for (const c of candles) {
        c.mat.emissiveIntensity = Math.max(0.15, c.base + Math.sin(elapsed * c.speed + c.phase) * c.amp);
      }
    },
    dispose(): void {
      ctx.root.remove(grp);
      for (const g of geoms) g.dispose();
      for (const m of mats) m.dispose();
    }
  };
}

/** A small stylized stone dove resting on an open palm. */
function buildDove(
  grp: THREE.Group,
  pos: THREE.Vector3,
  bodyMat: THREE.MeshStandardMaterial,
  beakMat: THREE.MeshStandardMaterial,
  track: <G extends THREE.BufferGeometry>(g: G) => G
): void {
  const dove = new THREE.Group();
  dove.name = "md_apse_dove";
  dove.position.copy(pos);
  grp.add(dove);

  const bodyGeo = track(new THREE.SphereGeometry(0.075, 12, 8));
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.scale.set(1, 0.85, 1.55);
  dove.add(body);

  const headGeo = track(new THREE.SphereGeometry(0.045, 10, 8));
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.position.set(0, 0.05, 0.11);
  dove.add(head);

  const beakGeo = track(new THREE.ConeGeometry(0.014, 0.05, 6));
  const beak = new THREE.Mesh(beakGeo, beakMat);
  beak.rotation.x = Math.PI / 2;
  beak.position.set(0, 0.035, 0.16);
  dove.add(beak);

  const tailGeo = track(new THREE.ConeGeometry(0.05, 0.15, 8));
  const tail = new THREE.Mesh(tailGeo, bodyMat);
  tail.rotation.x = -Math.PI * 0.32;
  tail.position.set(0, 0.02, -0.15);
  dove.add(tail);

  const wingGeo = track(new THREE.ConeGeometry(0.038, 0.16, 6));
  for (const s of [-1, 1]) {
    const wing = new THREE.Mesh(wingGeo, bodyMat);
    wing.rotation.z = (s * Math.PI) / 2.6;
    wing.rotation.x = Math.PI * 0.1;
    wing.position.set(s * 0.06, 0.02, -0.02);
    dove.add(wing);
  }
}
