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
const SHRINE_Z = 26;

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
  cord.position.set(SHRINE_X + 0.32, plinthTop + 1.3 - 0.24, SHRINE_Z + 0.3);
  grp.add(cord);
  const knotGeo = track(new THREE.SphereGeometry(0.032, 8, 8));
  for (let i = 0; i < 3; i++) {
    const knot = new THREE.Mesh(knotGeo, ropeMat);
    knot.position.set(SHRINE_X + 0.32, plinthTop + 1.3 - 0.42 - i * 0.14, SHRINE_Z + 0.3);
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
      emissiveIntensity: 1.3,
      roughness: 0.4,
      side: THREE.DoubleSide
    })
  );
  const roseGeo = track(new THREE.CircleGeometry(2.6, 48));
  const rose = new THREE.Mesh(roseGeo, roseMat);
  rose.position.set(0, 8.6, 38.6);
  rose.rotation.y = Math.PI;
  rose.name = "md_apse_rose_window";
  grp.add(rose);
  void ctx.loadArt("glass-rose").then((tex) => {
    roseMat.map = tex;
    roseMat.emissiveMap = tex;
    roseMat.needsUpdate = true;
  });

  // ---------------- two flanking lancet windows, mounted on the apse's curved wall ----------------
  // Apse wall = semicircle radius ~9 centred at (0, SHRINE_Z+4). Seat each lancet
  // ON that curve (just inside it) and face it inward toward the nave.
  const APSE_WALL_R = 8.7;
  const APSE_WALL_CZ = 30; // matches Z_APSE in the shell
  const lancetGeo = track(new THREE.PlaneGeometry(1.5, 3.6));
  for (const xSign of [-1, 1]) {
    const phi = xSign * 0.9; // ~51° off the centre line
    const lx = APSE_WALL_R * Math.sin(phi);
    const lz = APSE_WALL_CZ + APSE_WALL_R * Math.cos(phi);
    const lancetMat = trackMat(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0xffffff,
        emissiveIntensity: 1.15,
        roughness: 0.45,
        side: THREE.DoubleSide
      })
    );
    const mesh = new THREE.Mesh(lancetGeo, lancetMat);
    mesh.position.set(lx, 6, lz - 0.15);
    mesh.rotation.y = Math.PI - phi; // face inward, back toward the nave
    mesh.name = "md_apse_lancet";
    grp.add(mesh);
    void ctx.loadArt("glass-francis").then((tex) => {
      lancetMat.map = tex;
      lancetMat.emissiveMap = tex;
      lancetMat.needsUpdate = true;
    });
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

  // ---------------- dedication plaque ----------------
  grp.add(
    ctx.makePlaque({
      title: "Saint Francis of Assisi",
      body:
        "Brother to sun and moon, wolf and sparrow; poor man of Assisi, peacemaker, " +
        "lover of all creation — for whom this city is named. c. 1181–1226.",
      art: "francis-portrait",
      caption: '"Pace e bene" — Peace and good, the friars’ ancient greeting.',
      w: 2.2,
      h: 2.8,
      pos: [0, 1.55, 23],
      faceYaw: Math.PI,
      accent: 0xd9a93b
    })
  );

  // keep the approach clear: a single collider around the plinth only
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
