import * as THREE from "three/webgpu";
import type { MuseumCtx } from "../ctx";
import type { MdExhibit } from "./index";

// "THE PEACEMAKER — FRANCIS & THE SULTAN" — central nave tableau depicting the
// 1219 meeting between Francis and Sultan al-Kamil during the Fifth Crusade.
// Two seated figures on a rug beneath a tent canopy, a brazier flickering
// between them, and a standing illustrated plaque for the approaching visitor.

const CZ = 7; // tableau centre, local z (zone is x:[-6,6] z:[2,12])

type Track = (g: THREE.BufferGeometry) => THREE.BufferGeometry;

/** A tapered limb cylinder running from `from` to `to` in the figure's local space. */
function limb(track: Track, from: THREE.Vector3, to: THREE.Vector3, r0: number, r1: number, mat: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(to, from);
  const len = dir.length();
  const geo = track(new THREE.CylinderGeometry(r1, r0, len, 8));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(from).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  return mesh;
}

interface FigureOpts {
  x: number;
  z: number;
  yaw: number;
  robeMat: THREE.Material;
  trimMat: THREE.Material;
  skinMat: THREE.Material;
  headwear: "hood" | "turban";
}

/** A ~1m seated storybook figure built from primitives: bell-shaped robe skirt,
 *  tapered torso, head, resting arms/hands, and headwear (hood or turban). */
function buildSeatedFigure(track: Track, opts: FigureOpts): THREE.Group {
  const fig = new THREE.Group();
  fig.position.set(opts.x, 0, opts.z);
  fig.rotation.y = opts.yaw;

  // seated robe skirt — pools wide at the floor, narrows toward the waist
  const skirt = new THREE.Mesh(track(new THREE.CylinderGeometry(0.3, 0.56, 0.6, 14)), opts.robeMat);
  skirt.position.y = 0.3;
  fig.add(skirt);

  // torso
  const torso = new THREE.Mesh(track(new THREE.CylinderGeometry(0.2, 0.28, 0.42, 12)), opts.robeMat);
  torso.position.y = 0.81;
  fig.add(torso);

  // neck + head
  const neck = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.085, 0.1, 8)), opts.skinMat);
  neck.position.y = 1.07;
  fig.add(neck);
  const head = new THREE.Mesh(track(new THREE.SphereGeometry(0.15, 16, 12)), opts.skinMat);
  head.position.y = 1.27;
  fig.add(head);

  // arms resting on the knees, hands forward in the lap
  const shoulderY = 0.95;
  const handY = 0.62;
  const handZ = 0.36;
  const shoulderX = 0.22;
  const handX = 0.32;
  fig.add(limb(track, new THREE.Vector3(-shoulderX, shoulderY, 0.05), new THREE.Vector3(-handX, handY, handZ), 0.075, 0.06, opts.robeMat));
  fig.add(limb(track, new THREE.Vector3(shoulderX, shoulderY, 0.05), new THREE.Vector3(handX, handY, handZ), 0.075, 0.06, opts.robeMat));
  const handL = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 10, 8)), opts.skinMat);
  handL.position.set(-handX, handY, handZ);
  fig.add(handL);
  const handR = new THREE.Mesh(track(new THREE.SphereGeometry(0.055, 10, 8)), opts.skinMat);
  handR.position.set(handX, handY, handZ);
  fig.add(handR);

  if (opts.headwear === "hood") {
    // Franciscan hood, draped back off the head
    const hood = new THREE.Mesh(track(new THREE.ConeGeometry(0.17, 0.36, 10)), opts.robeMat);
    hood.position.set(0, 1.24, -0.1);
    hood.rotation.x = -0.55;
    fig.add(hood);
    // rope cincture with the three knots of the Franciscan vows
    const belt = new THREE.Mesh(track(new THREE.TorusGeometry(0.25, 0.02, 6, 16)), opts.trimMat);
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.82;
    fig.add(belt);
    for (let i = 0; i < 3; i++) {
      const knot = new THREE.Mesh(track(new THREE.SphereGeometry(0.035, 8, 6)), opts.trimMat);
      knot.position.set(0.23, 0.74 - i * 0.09, 0.08);
      fig.add(knot);
    }
  } else {
    // wrapped turban with a domed cap, and a fine sash at the waist
    const wrap = new THREE.Mesh(track(new THREE.TorusGeometry(0.16, 0.07, 10, 18)), opts.trimMat);
    wrap.rotation.x = Math.PI / 2;
    wrap.position.y = 1.37;
    fig.add(wrap);
    const cap = new THREE.Mesh(track(new THREE.SphereGeometry(0.1, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2)), opts.trimMat);
    cap.position.y = 1.43;
    fig.add(cap);
    const sash = new THREE.Mesh(track(new THREE.TorusGeometry(0.25, 0.025, 6, 16)), opts.trimMat);
    sash.rotation.x = Math.PI / 2;
    sash.position.y = 0.82;
    fig.add(sash);
  }

  return fig;
}

/** Warm red/gold woven-rug pattern: border, diamond lattice, central medallion. */
function makeRugTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 340;
  const g = c.getContext("2d")!;
  g.fillStyle = "#8a2e22";
  g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = "#d9a93b";
  g.lineWidth = 18;
  g.strokeRect(9, 9, c.width - 18, c.height - 18);
  g.strokeStyle = "#e8d9bd";
  g.lineWidth = 4;
  g.strokeRect(30, 30, c.width - 60, c.height - 60);
  g.strokeStyle = "rgba(217,169,59,0.5)";
  g.lineWidth = 2.5;
  const step = 36;
  for (let x = -c.height; x < c.width + c.height; x += step) {
    g.beginPath();
    g.moveTo(x, 40);
    g.lineTo(x + (c.height - 80), c.height - 40);
    g.stroke();
    g.beginPath();
    g.moveTo(x + (c.height - 80), 40);
    g.lineTo(x, c.height - 40);
    g.stroke();
  }
  g.fillStyle = "#d9a93b";
  g.beginPath();
  g.ellipse(c.width / 2, c.height / 2, 74, 48, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#8a2e22";
  g.beginPath();
  g.ellipse(c.width / 2, c.height / 2, 48, 29, 0, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Cream / terracotta vertical-stripe canvas for the tent's hanging valance. */
function makeStripeTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 64;
  const g = c.getContext("2d")!;
  const bands = 4;
  const w = c.width / bands;
  for (let i = 0; i < bands; i++) {
    g.fillStyle = i % 2 === 0 ? "#e8d9bd" : "#a9573a";
    g.fillRect(i * w, 0, w, c.height);
  }
  g.fillStyle = "rgba(90,62,38,0.35)";
  for (let i = 1; i < bands; i++) {
    g.fillRect(i * w - 1.5, 0, 3, c.height);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function createPeacemakerExhibit(ctx: MuseumCtx): MdExhibit {
  const grp = new THREE.Group();
  grp.name = "md_ex_peacemaker";
  ctx.root.add(grp);

  const geoms: THREE.BufferGeometry[] = [];
  const customMats: THREE.Material[] = [];
  const customTexs: THREE.Texture[] = [];
  const track: Track = (g) => {
    geoms.push(g);
    return g;
  };

  // ---------------- materials ----------------
  const francisRobeMat = ctx.glowMat(0x6a4a2e, 0.22, 0.78);
  const ropeMat = ctx.glowMat(0xcdb79a, 0.28, 0.7);
  const sultanRobeMat = ctx.glowMat(0x2e5f49, 0.24, 0.72);
  const goldMat = ctx.glowMat(0xd9a93b, 0.32, 0.55);
  const skinMat = ctx.glowMat(0xc79a6b, 0.18, 0.8);
  const postMat = ctx.glowMat(0x5a3e26, 0.15, 0.75);
  const canopyTopMat = ctx.glowMat(0xe8d9bd, 0.2, 0.8);
  const brazierStandMat = ctx.glowMat(0x3a2a1a, 0.12, 0.6);
  const baseMat = ctx.glowMat(0xb08a63, 0.15, 0.8);
  const flameMat = ctx.glowMat(0xd9a93b, 0.85, 0.4);

  const bowlMat = new THREE.MeshStandardMaterial({
    color: 0x8a6a3a,
    emissive: new THREE.Color(0x8a6a3a),
    emissiveIntensity: 0.2,
    roughness: 0.4,
    metalness: 0.6
  });
  customMats.push(bowlMat);

  const rugTex = makeRugTexture();
  customTexs.push(rugTex);
  const rugMat = new THREE.MeshStandardMaterial({
    map: rugTex,
    emissiveMap: rugTex,
    emissive: 0xffffff,
    emissiveIntensity: 0.3,
    roughness: 0.9
  });
  customMats.push(rugMat);

  const stripeTex = makeStripeTexture();
  stripeTex.wrapS = THREE.RepeatWrapping;
  stripeTex.wrapT = THREE.RepeatWrapping;
  stripeTex.repeat.set(6, 1);
  customTexs.push(stripeTex);
  const valanceMat = new THREE.MeshStandardMaterial({
    map: stripeTex,
    emissiveMap: stripeTex,
    emissive: 0xffffff,
    emissiveIntensity: 0.22,
    roughness: 0.85,
    side: THREE.DoubleSide
  });
  customMats.push(valanceMat);

  // ---------------- rug ----------------
  const rug = new THREE.Mesh(track(new THREE.BoxGeometry(3.6, 0.05, 2.4)), rugMat);
  rug.position.set(0, 0.025, CZ);
  grp.add(rug);

  // ---------------- figures ----------------
  const francis = buildSeatedFigure(track, {
    x: -1.3,
    z: CZ,
    yaw: Math.PI / 2, // faces +x, toward the Sultan
    robeMat: francisRobeMat,
    trimMat: ropeMat,
    skinMat,
    headwear: "hood"
  });
  grp.add(francis);

  const sultan = buildSeatedFigure(track, {
    x: 1.3,
    z: CZ,
    yaw: -Math.PI / 2, // faces -x, toward Francis
    robeMat: sultanRobeMat,
    trimMat: goldMat,
    skinMat,
    headwear: "turban"
  });
  grp.add(sultan);

  // ---------------- brazier ----------------
  const brazier = new THREE.Group();
  brazier.position.set(0, 0, CZ);
  grp.add(brazier);
  const standH = 0.55;
  const stand = new THREE.Mesh(track(new THREE.CylinderGeometry(0.03, 0.05, standH, 8)), brazierStandMat);
  stand.position.y = standH / 2;
  brazier.add(stand);
  for (let i = 0; i < 3; i++) {
    const ang = (i / 3) * Math.PI * 2;
    const foot = new THREE.Mesh(track(new THREE.CylinderGeometry(0.015, 0.03, 0.22, 6)), brazierStandMat);
    foot.position.set(Math.cos(ang) * 0.09, 0.11, Math.sin(ang) * 0.09);
    foot.rotation.z = Math.cos(ang) * 0.5;
    foot.rotation.x = Math.sin(ang) * 0.5;
    brazier.add(foot);
  }
  const bowl = new THREE.Mesh(track(new THREE.CylinderGeometry(0.24, 0.16, 0.14, 14)), bowlMat);
  bowl.position.y = standH + 0.07;
  brazier.add(bowl);
  const flame = new THREE.Mesh(track(new THREE.ConeGeometry(0.11, 0.32, 10)), flameMat);
  flame.position.y = standH + 0.14 + 0.14;
  brazier.add(flame);

  // ---------------- tent canopy ----------------
  const half = 2.2;
  const postH = 3.1;
  const postPositions: [number, number][] = [
    [-half, CZ - half],
    [half, CZ - half],
    [-half, CZ + half],
    [half, CZ + half]
  ];
  for (const [px, pz] of postPositions) {
    const post = new THREE.Mesh(track(new THREE.CylinderGeometry(0.055, 0.07, postH, 10)), postMat);
    post.position.set(px, postH / 2, pz);
    grp.add(post);
    const finial = new THREE.Mesh(track(new THREE.ConeGeometry(0.09, 0.22, 8)), goldMat);
    finial.position.set(px, postH + 0.13, pz);
    grp.add(finial);
  }
  const roofSide = half * 2 + 0.3;
  const canopyTop = new THREE.Mesh(track(new THREE.BoxGeometry(roofSide, 0.12, roofSide)), canopyTopMat);
  canopyTop.position.set(0, postH + 0.06, CZ);
  grp.add(canopyTop);

  const valanceH = 0.42;
  const valanceY = postH - valanceH / 2 + 0.02;
  const frontValance = new THREE.Mesh(track(new THREE.PlaneGeometry(roofSide, valanceH)), valanceMat);
  frontValance.position.set(0, valanceY, CZ - half - 0.15);
  grp.add(frontValance);
  const backValance = frontValance.clone();
  backValance.position.z = CZ + half + 0.15;
  grp.add(backValance);
  const leftValance = new THREE.Mesh(track(new THREE.PlaneGeometry(roofSide, valanceH)), valanceMat);
  leftValance.rotation.y = Math.PI / 2;
  leftValance.position.set(-half - 0.15, valanceY, CZ);
  grp.add(leftValance);
  const rightValance = leftValance.clone();
  rightValance.position.x = half + 0.15;
  grp.add(rightValance);

  // keep visitors from walking through the seated figures / brazier
  ctx.addCollider({ lx: 0, ly: 0.5, lz: CZ, hx: half + 0.15, hy: 0.5, hz: half + 0.15 });

  // ---------------- standing plaque ----------------
  const plaqueBase = new THREE.Mesh(track(new THREE.BoxGeometry(0.7, 0.16, 0.44)), baseMat);
  plaqueBase.position.set(0, 0.08, 3.5);
  grp.add(plaqueBase);
  const plaquePost = new THREE.Mesh(track(new THREE.CylinderGeometry(0.07, 0.08, 0.85, 10)), postMat);
  plaquePost.position.set(0, 0.16 + 0.425, 3.5);
  grp.add(plaquePost);

  const plaqueH = 2.6;
  const plaqueCenterY = 0.16 + 0.85 + plaqueH / 2;
  grp.add(
    ctx.makePlaque({
      title: "The Peacemaker",
      body:
        "In 1219, amid the violence of the Fifth Crusade, Francis crossed the battle lines unarmed to meet Sultan al-Kamil of Egypt. Where soldiers expected a spy, the Sultan found a brother in prayer, and for days the two spoke with rare, mutual respect. Francis returned unharmed, having shown that peace is made by listening — not by conquest.",
      art: "peacemaker-sultan",
      caption: "“Blessed are the peacemakers.” — Matthew 5:9",
      w: 2.0,
      h: plaqueH,
      pos: [0, plaqueCenterY, 3.5],
      faceYaw: Math.PI,
      accent: 0xd9a93b
    })
  );

  // ---------------- update / dispose ----------------
  const worldCenter = ctx.toWorld(0, 1, CZ);
  const FAR2 = 45 * 45;

  return {
    update(_dt, elapsed, playerPos) {
      if (playerPos.distanceToSquared(worldCenter) > FAR2) return;
      const flick = 1 + Math.sin(elapsed * 9.0) * 0.08 + Math.sin(elapsed * 17.3 + 1.7) * 0.05;
      flame.scale.set(1, flick, 1);
      flameMat.emissiveIntensity = 0.75 + Math.sin(elapsed * 11.0) * 0.18 + Math.sin(elapsed * 23.0) * 0.08;
    },
    dispose() {
      ctx.root.remove(grp);
      for (const g of geoms) g.dispose();
      for (const m of customMats) m.dispose();
      for (const t of customTexs) t.dispose();
    }
  };
}
