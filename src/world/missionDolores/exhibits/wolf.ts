import * as THREE from "three/webgpu";
import type { MuseumCtx } from "../ctx";
import type { MdExhibit } from "./index";

// "The Wolf of Gubbio" diorama — central nave, east of the walking lane.
// A low stone dais holds the reconciliation tableau: Francis meets the wolf
// that had terrorized Gubbio, the wolf sits and lifts a paw, Francis reaches
// down to receive it, with a hint of the hill town's gate behind them.

const CX = 4; // zone/dais centre x
const CZ = -7.6; // zone/dais centre z
const DAIS_TOP = 0.3; // local y of the dais top surface
const DAIS_W = 4.6;
const DAIS_D = 5.4;

const GOLD = 0xd9a93b;
const WOOD = 0x5a3e26;
const TERRACOTTA = 0xa9573a;
const STONE = 0xb08a63;
const TRIM = 0xe8d9bd;
const CREAM = 0xcdb79a;
const ROBE = 0x6a4a2e;
const DEEP_ROBE = 0x4a3320;
const FUR = 0x8a8478;

const TAIL_WAG_SPEED = 2.4;
const TAIL_WAG_AMOUNT = 0.32;
const FAR_DIST2 = 42 * 42;

export function createWolfExhibit(ctx: MuseumCtx): MdExhibit {
  const grp = new THREE.Group();
  grp.name = "md_ex_wolf";
  ctx.root.add(grp);

  // geometries this exhibit constructs directly (ctx.glowMat materials are
  // already tracked/disposed by ctx itself, so only geometry needs tracking here).
  const geos: THREE.BufferGeometry[] = [];
  function G<T extends THREE.BufferGeometry>(g: T): T {
    geos.push(g);
    return g;
  }

  // ---- materials (all emissive so the tableau reads in the dim nave) ----
  const stoneMat = ctx.glowMat(STONE, 0.22, 0.85);
  const stoneEdgeMat = ctx.glowMat(0x8a6a4a, 0.18, 0.9);
  const furMat = ctx.glowMat(FUR, 0.3, 0.75);
  const furDarkMat = ctx.glowMat(0x5f5a50, 0.25, 0.8);
  const padMat = ctx.glowMat(0x332b22, 0.18, 0.9);
  const robeMat = ctx.glowMat(ROBE, 0.28, 0.8);
  const robeDeepMat = ctx.glowMat(DEEP_ROBE, 0.22, 0.85);
  const skinMat = ctx.glowMat(0xc79f7a, 0.32, 0.7);
  const ropeMat = ctx.glowMat(TRIM, 0.2, 0.9);
  const gateStoneMat = ctx.glowMat(CREAM, 0.2, 0.9);
  const gateRoofMat = ctx.glowMat(TERRACOTTA, 0.25, 0.75);
  const eyeMat = ctx.glowMat(GOLD, 0.6, 0.3);
  const postMat = ctx.glowMat(WOOD, 0.22, 0.8);

  // ---- small helpers ----
  function mesh(
    parent: THREE.Object3D,
    g: THREE.BufferGeometry,
    m: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0
  ): THREE.Mesh {
    const mm = new THREE.Mesh(g, m);
    mm.position.set(x, y, z);
    if (rx) mm.rotation.x = rx;
    if (ry) mm.rotation.y = ry;
    if (rz) mm.rotation.z = rz;
    parent.add(mm);
    return mm;
  }

  /** A tapered cylinder oriented to run from `from` to `to` — used for limbs,
   *  torso, neck, snout and tail so nothing needs hand-derived Euler angles. */
  function limb(
    parent: THREE.Object3D,
    m: THREE.Material,
    from: THREE.Vector3,
    to: THREE.Vector3,
    rTop: number,
    rBot: number,
    segs = 7
  ): THREE.Mesh {
    const dir = new THREE.Vector3().subVectors(to, from);
    const len = Math.max(0.02, dir.length());
    const mid = new THREE.Vector3().copy(from).addScaledVector(dir, 0.5);
    const g = G(new THREE.CylinderGeometry(rTop, rBot, len, segs));
    const mm = new THREE.Mesh(g, m);
    mm.position.copy(mid);
    mm.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    parent.add(mm);
    return mm;
  }

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

  // ==================================================================
  // DAIS — low stone platform
  // ==================================================================
  mesh(grp, G(new THREE.BoxGeometry(DAIS_W, 0.3, DAIS_D)), stoneMat, CX, DAIS_TOP / 2, CZ);
  mesh(grp, G(new THREE.BoxGeometry(DAIS_W + 0.16, 0.08, DAIS_D + 0.16)), stoneEdgeMat, CX, 0.04, CZ);

  // ==================================================================
  // GUBBIO TOWN GATE — small stone backdrop near the far (+z) edge
  // ==================================================================
  const gateZ = CZ + 2.45; // near the dais's +z edge
  const pierH = 1.0;
  mesh(grp, G(new THREE.BoxGeometry(0.22, pierH, 0.22)), gateStoneMat, CX - 0.6, DAIS_TOP + pierH / 2, gateZ);
  mesh(grp, G(new THREE.BoxGeometry(0.22, pierH, 0.22)), gateStoneMat, CX + 0.6, DAIS_TOP + pierH / 2, gateZ);
  mesh(grp, G(new THREE.BoxGeometry(1.42, 0.2, 0.24)), gateStoneMat, CX, DAIS_TOP + pierH + 0.1, gateZ);

  function littleHouse(x: number, z: number, s: number) {
    const wallH = 0.75 * s;
    mesh(grp, G(new THREE.BoxGeometry(0.85 * s, wallH, 0.85 * s)), gateStoneMat, x, DAIS_TOP + wallH / 2, z);
    const roof = mesh(
      grp,
      G(new THREE.ConeGeometry(0.62 * s, 0.5 * s, 4)),
      gateRoofMat,
      x,
      DAIS_TOP + wallH + (0.25 * s),
      z
    );
    roof.rotation.y = Math.PI / 4;
  }
  littleHouse(CX - 1.7, gateZ + 0.1, 1);
  littleHouse(CX + 1.7, gateZ + 0.1, 1);
  littleHouse(CX + 2.9, gateZ + 0.2, 0.72);

  // ==================================================================
  // FRANCIS — a small robed friar, kneeling low with one hand reaching out
  // ==================================================================
  const FX = 3.3;
  const FZ = -7.7;
  mesh(grp, G(new THREE.CylinderGeometry(0.2, 0.29, 1.05, 8)), robeMat, FX, DAIS_TOP + 0.525, FZ);
  mesh(grp, G(new THREE.TorusGeometry(0.235, 0.02, 6, 16)), ropeMat, FX, DAIS_TOP + 0.55, FZ, Math.PI / 2);
  mesh(grp, G(new THREE.SphereGeometry(0.15, 10, 7)), skinMat, FX, DAIS_TOP + 1.2, FZ);
  mesh(grp, G(new THREE.ConeGeometry(0.19, 0.24, 8)), robeDeepMat, FX - 0.08, DAIS_TOP + 1.04, FZ);

  // reaching arm (the hand that will receive the wolf's paw)
  const shoulderR = V(FX + 0.15, DAIS_TOP + 0.98, FZ + 0.05);
  const handPos = V(3.75, 0.8, -7.45);
  limb(grp, robeMat, shoulderR, handPos, 0.065, 0.05);
  mesh(grp, G(new THREE.SphereGeometry(0.075, 8, 6)), skinMat, handPos.x, handPos.y, handPos.z);

  // other arm, tucked at rest
  const shoulderL = V(FX - 0.15, DAIS_TOP + 0.98, FZ - 0.05);
  const wristL = V(FX - 0.2, DAIS_TOP + 0.65, FZ - 0.08);
  limb(grp, robeMat, shoulderL, wristL, 0.06, 0.05);
  mesh(grp, G(new THREE.SphereGeometry(0.06, 8, 6)), skinMat, wristL.x, wristL.y, wristL.z);

  // sandaled feet peeking from the hem
  mesh(grp, G(new THREE.BoxGeometry(0.1, 0.06, 0.17)), robeDeepMat, FX - 0.06, DAIS_TOP + 0.03, FZ + 0.04);
  mesh(grp, G(new THREE.BoxGeometry(0.1, 0.06, 0.17)), robeDeepMat, FX + 0.08, DAIS_TOP + 0.03, FZ - 0.06);

  // ==================================================================
  // THE WOLF OF GUBBIO — sitting calmly, one front paw lifted
  // ==================================================================
  const hip = V(4.55, 0.42, -7.55);
  const shoulder = V(4.15, 0.75, -7.35);
  const head = V(3.88, 0.85, -7.3);
  const snoutTip = V(3.6, 0.78, -7.28);

  limb(grp, furMat, hip, shoulder, 0.22, 0.26, 8); // torso
  mesh(grp, G(new THREE.SphereGeometry(0.26, 10, 7)), furMat, hip.x, hip.y, hip.z); // haunch
  mesh(grp, G(new THREE.SphereGeometry(0.2, 10, 7)), furMat, shoulder.x, shoulder.y, shoulder.z); // chest
  limb(grp, furMat, shoulder, head, 0.14, 0.18, 7); // neck
  mesh(grp, G(new THREE.SphereGeometry(0.17, 10, 8)), furMat, head.x, head.y, head.z); // head
  limb(grp, furMat, head, snoutTip, 0.05, 0.1, 6); // snout
  mesh(grp, G(new THREE.SphereGeometry(0.035, 6, 5)), padMat, snoutTip.x, snoutTip.y, snoutTip.z); // nose

  // ears
  const earGeo = G(new THREE.ConeGeometry(0.055, 0.14, 4));
  mesh(grp, earGeo, furDarkMat, head.x + 0.02, head.y + 0.15, head.z + 0.1, 0, 0, 0.18);
  mesh(grp, earGeo, furDarkMat, head.x + 0.02, head.y + 0.15, head.z - 0.1, 0, 0, -0.18);

  // eyes — a small warm glint
  const eyeGeo = G(new THREE.SphereGeometry(0.025, 6, 5));
  mesh(grp, eyeGeo, eyeMat, head.x - 0.12, head.y + 0.02, head.z + 0.06);
  mesh(grp, eyeGeo, eyeMat, head.x - 0.12, head.y + 0.02, head.z - 0.06);

  // tail — animated by update() via tailPivot.rotation.y
  const tailBase = V(4.68, 0.32, -7.55);
  const tailPivot = new THREE.Group();
  tailPivot.position.copy(tailBase);
  grp.add(tailPivot);
  limb(tailPivot, furMat, V(0, 0, 0), V(0.32, 0.2, 0.18), 0.04, 0.1, 6);
  mesh(tailPivot, G(new THREE.SphereGeometry(0.06, 8, 6)), furDarkMat, 0.32, 0.2, 0.18);

  // front standing (support) leg
  const supTop = V(4.05, 0.68, -7.18);
  const supBot = V(4.02, 0.3, -7.12);
  limb(grp, furMat, supTop, supBot, 0.075, 0.065);
  mesh(grp, G(new THREE.SphereGeometry(0.05, 6, 5)), padMat, supBot.x, supBot.y - 0.02, supBot.z);

  // front lifted leg — paw reaching toward the friar's hand
  const liftTop = V(4.05, 0.68, -7.45);
  const liftPaw = V(3.6, 0.72, -7.4);
  limb(grp, furMat, liftTop, liftPaw, 0.065, 0.055);
  mesh(grp, G(new THREE.SphereGeometry(0.055, 8, 6)), padMat, liftPaw.x, liftPaw.y, liftPaw.z);

  // rear legs, tucked under the sitting haunch
  const rl1Top = V(4.6, 0.4, -7.4);
  const rl1Bot = V(4.55, 0.3, -7.3);
  limb(grp, furMat, rl1Top, rl1Bot, 0.06, 0.07);
  mesh(grp, G(new THREE.SphereGeometry(0.045, 6, 5)), padMat, rl1Bot.x, rl1Bot.y - 0.02, rl1Bot.z);
  const rl2Top = V(4.6, 0.4, -7.7);
  const rl2Bot = V(4.55, 0.3, -7.8);
  limb(grp, furMat, rl2Top, rl2Bot, 0.06, 0.07);
  mesh(grp, G(new THREE.SphereGeometry(0.045, 6, 5)), padMat, rl2Bot.x, rl2Bot.y - 0.02, rl2Bot.z);

  // ==================================================================
  // STANDING PLAQUE — at the aisle-facing edge of the diorama
  // ==================================================================
  const plaqueX = 1.4;
  const plaqueLy = 1.55;
  const plaqueH = 2.2;
  grp.add(
    ctx.makePlaque({
      title: "The Wolf of Gubbio",
      body:
        "A wolf prowled outside the hill town of Gubbio, and no one dared pass beyond the gates. Francis walked out " +
        "alone to meet it, called it \"Brother Wolf,\" and gently asked it to make peace with the frightened town. " +
        "The wolf padded forward and laid its paw in his open hand — and from that day it troubled no one in Gubbio again.",
      art: "wolf-gubbio",
      caption: "\"Brother Wolf, I ask you to make peace.\"",
      w: 1.6,
      h: plaqueH,
      pos: [plaqueX, plaqueLy, CZ],
      faceYaw: -Math.PI / 2, // faces -x, into the central walkway
      accent: GOLD
    })
  );
  const postBottom = plaqueLy - plaqueH / 2;
  mesh(grp, G(new THREE.BoxGeometry(0.16, postBottom, 0.16)), postMat, plaqueX, postBottom / 2, CZ);
  mesh(grp, G(new THREE.BoxGeometry(0.42, 0.08, 0.42)), stoneEdgeMat, plaqueX, 0.04, CZ);

  // ==================================================================
  // collider so players walk around the tableau, not through it
  // ==================================================================
  ctx.addCollider({ lx: CX, ly: DAIS_TOP / 2, lz: CZ, hx: DAIS_W / 2, hy: DAIS_TOP / 2, hz: DAIS_D / 2 });

  const anchorWorld = ctx.toWorld(CX, 0.6, CZ);

  return {
    update(_dt, elapsed, playerPos) {
      if (playerPos.distanceToSquared(anchorWorld) > FAR_DIST2) return;
      tailPivot.rotation.y = Math.sin(elapsed * TAIL_WAG_SPEED) * TAIL_WAG_AMOUNT;
    },
    dispose() {
      ctx.root.remove(grp);
      for (const g of geos) g.dispose();
    }
  };
}
