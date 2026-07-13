import * as THREE from "three/webgpu";
import type { MuseumCtx } from "../ctx";
import type { MdExhibit } from "./index";

// ---------------------------------------------------------------------------
// "The Sermon to the Birds" — a small diorama: Francis stands on a low stone
// dais with arms gently open while a flock of birds gathers around him, a few
// aloft on nearly-invisible posts. A standing plaque at the aisle-facing edge
// tells the story. Central nave, west of centre (zone MD_ZONES.birds).
// ---------------------------------------------------------------------------

const DAIS_X = -4;
const DAIS_Z = -7.5;
const DAIS_R = 1.3;
const DAIS_H = 0.25;

/** Deterministic 0..1 pseudo-random from an integer seed (no Math.random so the
 *  flock is stable across reloads). */
function hash01(i: number): number {
  const s = Math.sin(i * 12.9898 + 4.1414) * 43758.5453;
  return s - Math.floor(s);
}

interface FlyingBird {
  group: THREE.Group;
  baseY: number;
  baseRotY: number;
  phase: number;
}

/** Builds one small stylized bird (body/head/beak/tail/wings) as a Group whose
 *  local +z is "forward". `flying` widens the wing spread a little. */
function buildBird(
  bodyMat: THREE.MeshStandardMaterial,
  wingMat: THREE.MeshStandardMaterial,
  beakMat: THREE.MeshStandardMaterial,
  geos: THREE.BufferGeometry[],
  flying: boolean
): THREE.Group {
  const g = new THREE.Group();

  const bodyGeo = new THREE.SphereGeometry(0.09, 10, 8);
  bodyGeo.scale(1, 0.82, 1.55);
  geos.push(bodyGeo);
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.position.set(0, 0.09, 0);
  g.add(body);

  const headGeo = new THREE.SphereGeometry(0.055, 8, 6);
  geos.push(headGeo);
  const head = new THREE.Mesh(headGeo, bodyMat);
  head.position.set(0, 0.155, 0.13);
  g.add(head);

  const beakGeo = new THREE.BoxGeometry(0.028, 0.026, 0.07);
  geos.push(beakGeo);
  const beak = new THREE.Mesh(beakGeo, beakMat);
  beak.position.set(0, 0.145, 0.19);
  g.add(beak);

  const tailGeo = new THREE.ConeGeometry(0.075, 0.19, 4);
  tailGeo.rotateX(-Math.PI / 2);
  tailGeo.rotateY(Math.PI / 4);
  geos.push(tailGeo);
  const tail = new THREE.Mesh(tailGeo, bodyMat);
  tail.position.set(0, 0.12, -0.15);
  tail.rotation.x = flying ? -0.25 : 0.1;
  g.add(tail);

  const wingGeo = new THREE.SphereGeometry(0.075, 8, 6);
  wingGeo.scale(0.3, 0.7, 1.15);
  geos.push(wingGeo);
  const spread = flying ? 0.95 : 0.35;
  for (const mirror of [1, -1]) {
    const wing = new THREE.Mesh(wingGeo, wingMat);
    wing.position.set(mirror * 0.085, 0.11, -0.01);
    wing.rotation.z = mirror * spread;
    wing.rotation.x = flying ? -0.3 : 0;
    g.add(wing);
  }

  return g;
}

export function createBirdsExhibit(ctx: MuseumCtx): MdExhibit {
  const { THREE: T } = ctx;
  const grp = new T.Group();
  grp.name = "md_ex_birds";
  ctx.root.add(grp);

  const geos: THREE.BufferGeometry[] = [];

  // ---- stone dais -----------------------------------------------------
  const stoneMat = ctx.glowMat(0xb08a63, 0.12, 0.85);
  const rimMat = ctx.glowMat(0xa9573a, 0.14, 0.8);

  const rimGeo = new T.CylinderGeometry(DAIS_R + 0.06, DAIS_R + 0.12, 0.08, 28);
  geos.push(rimGeo);
  const rim = new T.Mesh(rimGeo, rimMat);
  rim.position.set(DAIS_X, 0.04, DAIS_Z);
  grp.add(rim);

  const topGeo = new T.CylinderGeometry(DAIS_R, DAIS_R, DAIS_H - 0.08, 32);
  geos.push(topGeo);
  const top = new T.Mesh(topGeo, stoneMat);
  top.position.set(DAIS_X, 0.08 + (DAIS_H - 0.08) / 2, DAIS_Z);
  grp.add(top);

  // ---- Francis, robed, arms gently open --------------------------------
  const robeMat = ctx.glowMat(0x6a4a2e, 0.22, 0.75);
  const hoodMat = ctx.glowMat(0x4a3320, 0.2, 0.75);
  const skinMat = ctx.glowMat(0xd8b48c, 0.26, 0.6);
  const ropeMat = ctx.glowMat(0xd9a93b, 0.3, 0.55);

  const friar = new T.Group();
  friar.position.set(DAIS_X, DAIS_H, DAIS_Z);
  friar.rotation.y = Math.PI / 2; // face +x, toward the aisle & plaque
  grp.add(friar);

  const ROBE_H = 0.95;
  const robeGeo = new T.CylinderGeometry(0.24, 0.34, ROBE_H, 14);
  geos.push(robeGeo);
  const robe = new T.Mesh(robeGeo, robeMat);
  robe.position.set(0, ROBE_H / 2, 0);
  friar.add(robe);

  const cinctureGeo = new T.TorusGeometry(0.27, 0.022, 8, 20);
  cinctureGeo.rotateX(Math.PI / 2);
  geos.push(cinctureGeo);
  const cincture = new T.Mesh(cinctureGeo, ropeMat);
  cincture.position.set(0, 0.55, 0);
  friar.add(cincture);

  const HEAD_Y = ROBE_H + 0.11;
  const headGeo = new T.SphereGeometry(0.14, 16, 12);
  geos.push(headGeo);
  const head = new T.Mesh(headGeo, skinMat);
  head.position.set(0, HEAD_Y, 0);
  friar.add(head);

  const hoodGeo = new T.SphereGeometry(0.17, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.6);
  geos.push(hoodGeo);
  const hood = new T.Mesh(hoodGeo, hoodMat);
  hood.position.set(0, HEAD_Y + 0.05, -0.02);
  friar.add(hood);

  // arms: pivot at the shoulder, cylinder extends outward+up, hand at the tip
  const ARM_LEN = 0.48;
  const ARM_ANGLE = 1.22; // ~70°, an open, welcoming spread
  const armGeo = new T.CylinderGeometry(0.045, 0.06, ARM_LEN, 8);
  armGeo.translate(0, ARM_LEN / 2, 0);
  geos.push(armGeo);
  const handGeo = new T.SphereGeometry(0.055, 8, 6);
  geos.push(handGeo);

  for (const mirror of [1, -1]) {
    const arm = new T.Group();
    arm.position.set(mirror * 0.22, ROBE_H - 0.13, 0.02);
    arm.rotation.z = -mirror * ARM_ANGLE;
    const armMesh = new T.Mesh(armGeo, robeMat);
    arm.add(armMesh);
    const hand = new T.Mesh(handGeo, skinMat);
    hand.position.set(0, ARM_LEN, 0);
    arm.add(hand);
    friar.add(arm);
  }

  // ---- the flock --------------------------------------------------------
  // A small warm palette: mostly brown/russet, a few sky-blue and terracotta-red.
  const bodyMats = [
    ctx.glowMat(0x8a5a35, 0.22, 0.7), // warm brown
    ctx.glowMat(0x6a4a2e, 0.2, 0.75), // dark russet
    ctx.glowMat(0xa9573a, 0.24, 0.7), // terracotta-red accent
    ctx.glowMat(0x6f9ac4, 0.24, 0.65) // sky-blue accent
  ];
  const wingMats = [
    ctx.glowMat(0x5a3e26, 0.18, 0.75),
    ctx.glowMat(0x4a3320, 0.18, 0.78),
    ctx.glowMat(0x8a4028, 0.2, 0.72),
    ctx.glowMat(0x557fa8, 0.2, 0.68)
  ];
  const beakMat = ctx.glowMat(0x2a1f14, 0.12, 0.6);
  // brown/russet dominate; blue/red are occasional accents
  const colorRoll = [0, 0, 1, 0, 1, 0, 2, 0, 1, 3, 0, 1, 0, 2, 0, 1, 3, 0];

  const FLOCK_COUNT = 18;
  const FLYING_COUNT = 5;
  const GOLDEN_ANGLE = 2.399963;
  const flying: FlyingBird[] = [];
  const flockRoot = new T.Group();
  grp.add(flockRoot);

  for (let i = 0; i < FLOCK_COUNT; i++) {
    const isFlying = i >= FLOCK_COUNT - FLYING_COUNT;
    const angle = i * GOLDEN_ANGLE + hash01(i) * 0.3;
    const rFrac = Math.sqrt((i + 0.5) / FLOCK_COUNT);
    const r = 0.35 + rFrac * 1.45; // spread from near Francis's feet out to ~1.8m
    const lx = DAIS_X + Math.cos(angle) * r;
    const lz = DAIS_Z + Math.sin(angle) * r;
    const onDais = r <= DAIS_R - 0.15;
    const groundY = onDais ? DAIS_H : 0;

    const colorIdx = colorRoll[i % colorRoll.length];
    const bird = buildBird(bodyMats[colorIdx], wingMats[colorIdx], beakMat, geos, isFlying);
    const scale = 0.85 + hash01(i + 50) * 0.35;
    bird.scale.setScalar(scale);
    bird.rotation.y = angle + Math.PI + (hash01(i + 100) - 0.5) * 0.9; // loosely facing Francis

    if (isFlying) {
      const flyY = 0.6 + hash01(i + 200) * 0.8;
      bird.position.set(lx, groundY + flyY, lz);
      // a thin, nearly-invisible post holding the bird aloft
      const postH = flyY - 0.04;
      if (postH > 0.02) {
        const postGeo = new T.CylinderGeometry(0.012, 0.016, postH, 5);
        geos.push(postGeo);
        const postMat = new T.MeshStandardMaterial({ color: 0x1c140c, roughness: 0.9, metalness: 0 });
        const post = new T.Mesh(postGeo, postMat);
        post.position.set(lx, groundY + postH / 2, lz);
        flockRoot.add(post);
      }
      flying.push({ group: bird, baseY: groundY + flyY, baseRotY: bird.rotation.y, phase: hash01(i + 300) * Math.PI * 2 });
    } else {
      bird.position.set(lx, groundY, lz);
    }
    flockRoot.add(bird);
  }

  // ---- standing illustrated plaque at the aisle-facing edge --------------
  const plaque = ctx.makePlaque({
    title: "The Sermon to the Birds",
    body:
      "Walking a country road near Bevagna, Francis found the trees full of birds and could not pass them by. " +
      "He greeted his small sisters and called them to praise the Maker who gave them wings, feathers, and the open air.",
    caption: "The birds stretched their necks and spread their wings, and did not fly away until he had blessed them.",
    art: "birds-sermon",
    pos: [-1.4, 1.0 + 2.1 / 2, DAIS_Z],
    faceYaw: Math.PI / 2, // faces +x, into the central walkway
    w: 1.8,
    h: 2.1,
    accent: 0xd9a93b
  });
  grp.add(plaque);

  const postGeo2 = new T.CylinderGeometry(0.08, 0.09, 1.0, 12);
  geos.push(postGeo2);
  const postMat2 = ctx.glowMat(0x5a3e26, 0.15, 0.8);
  const plaquePost = new T.Mesh(postGeo2, postMat2);
  plaquePost.position.set(-1.4, 0.5, DAIS_Z);
  grp.add(plaquePost);

  ctx.addCollider({ lx: DAIS_X, ly: DAIS_H / 2, lz: DAIS_Z, hx: DAIS_R, hy: DAIS_H / 2, hz: DAIS_R });

  const daisWorld = ctx.toWorld(DAIS_X, 0, DAIS_Z);
  const FAR_DIST_SQ = 40 * 40;

  return {
    update(_dt: number, elapsed: number, playerPos: THREE.Vector3) {
      const dx = playerPos.x - daisWorld.x;
      const dz = playerPos.z - daisWorld.z;
      if (dx * dx + dz * dz > FAR_DIST_SQ) return;
      for (const b of flying) {
        b.group.position.y = b.baseY + Math.sin(elapsed * 1.6 + b.phase) * 0.05;
        b.group.rotation.y = b.baseRotY + Math.sin(elapsed * 0.7 + b.phase) * 0.18;
        b.group.rotation.z = Math.sin(elapsed * 1.9 + b.phase) * 0.12;
      }
    },
    dispose() {
      ctx.root.remove(grp);
      for (const g of geos) g.dispose();
      grp.traverse((obj) => {
        if (obj instanceof T.Mesh) {
          const mat = obj.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else mat.dispose();
        }
      });
    }
  };
}
