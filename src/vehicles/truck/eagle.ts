import * as THREE from "three/webgpu";
import { texture, uv } from "three/tsl";
import { rippleMaterial, usFlagTexture } from "../../fx/cloth";

/**
 * A detailed blow-up bald eagle for the truck bed — layered feathering, a white
 * hooked-beak head with a fierce brow, a brown body over a cream belly, big
 * rippling American-flag wings spread in a heroic V (stars at the shoulder,
 * stripes streaming to the tips), a white tail fan and gold grasping talons.
 * Local origin at the feet; front is -Z. Stylized-chunky to match the game, but
 * unmistakably an eagle.
 */

const M = {
  white: () => new THREE.MeshLambertMaterial({ color: 0xf2f0e8 }),
  brown: () => new THREE.MeshLambertMaterial({ color: 0x4a3016 }),
  brownDk: () => new THREE.MeshLambertMaterial({ color: 0x30200f }),
  cream: () => new THREE.MeshLambertMaterial({ color: 0xd9c7a3 }),
  gold: () => new THREE.MeshLambertMaterial({ color: 0xf2a81a }),
  goldDk: () => new THREE.MeshLambertMaterial({ color: 0xcf8b0f }),
  eye: () => new THREE.MeshLambertMaterial({ color: 0xf5cf4a }),
  dark: () => new THREE.MeshLambertMaterial({ color: 0x0b0b0d })
};

// one shared thin "feather" card geometry, scaled per use
const FEATHER = new THREE.BoxGeometry(1, 1, 0.03);

/** A single feather card (elongated box), tapered by scaling. */
function feather(
  parent: THREE.Object3D,
  mat: THREE.Material,
  w: number,
  h: number,
  x: number,
  y: number,
  z: number,
  rx = 0,
  ry = 0,
  rz = 0
) {
  const m = new THREE.Mesh(FEATHER, mat);
  m.scale.set(w, h, 1);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = true;
  parent.add(m);
  return m;
}

/** Overlapping rows of feather cards fanning down a surface. */
function featherPatch(
  parent: THREE.Object3D,
  mat: THREE.Material,
  rows: number,
  perRow: number,
  y0: number,
  y1: number,
  radius: number,
  spreadZ: number,
  size: number,
  tilt: number
) {
  for (let r = 0; r < rows; r++) {
    const t = rows > 1 ? r / (rows - 1) : 0;
    const y = THREE.MathUtils.lerp(y0, y1, t);
    for (let i = 0; i < perRow; i++) {
      const a = ((i / (perRow - 1)) - 0.5) * Math.PI * spreadZ; // fan around the front
      const x = Math.sin(a) * radius;
      const z = -Math.cos(a) * radius * 0.7;
      feather(parent, mat, size, size * 2.1, x, y, z, tilt, -a, 0);
    }
  }
}

/** A wing membrane in local XY (span +X, chord Y, normal +Z) — tapered and
 * swept to a point so the flag reads as a wing, pinned at the shoulder root. */
function wingMembrane(seg = 14): THREE.BufferGeometry {
  const rootLE = new THREE.Vector3(0, 0.62, 0);
  const rootTE = new THREE.Vector3(0, -0.62, 0);
  const tipLE = new THREE.Vector3(1, 0.24, 0);
  const tipTE = new THREE.Vector3(1, -0.02, 0);
  const pos: number[] = [];
  const uvs: number[] = [];
  const nrm: number[] = [];
  const idx: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const p = new THREE.Vector3();
  for (let i = 0; i <= seg; i++) {
    const s = i / seg;
    a.lerpVectors(rootLE, tipLE, s);
    b.lerpVectors(rootTE, tipTE, s);
    for (let j = 0; j <= seg; j++) {
      const c = j / seg;
      p.lerpVectors(a, b, c);
      pos.push(p.x, p.y, p.z);
      // uv.x spanwise (0 = shoulder root, the pinned edge); uv.y leading→trailing,
      // so the star canton (uv ~0,1) lands at the shoulder-leading corner
      uvs.push(s, 1 - c);
      nrm.push(0, 0, 1);
    }
  }
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < seg; j++) {
      const r0 = i * (seg + 1) + j;
      const r1 = r0 + seg + 1;
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

/** A grasping foot: three forward toes + a hallux, each clawed. */
function talon(): THREE.Group {
  const g = new THREE.Group();
  const gold = M.gold();
  const claw = M.dark();
  const shank = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.22, 8), gold);
  shank.position.y = 0.11;
  g.add(shank);
  const toe = (ang: number, len: number, spread: number) => {
    const t = new THREE.Group();
    t.rotation.y = ang;
    g.add(t);
    const seg1 = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, len, 6), gold);
    seg1.position.set(0, 0.02, -len / 2);
    seg1.rotation.x = Math.PI / 2 - spread;
    t.add(seg1);
    const claw1 = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 6), claw);
    claw1.position.set(0, -0.04, -len - 0.02);
    claw1.rotation.x = -1.9;
    t.add(claw1);
  };
  toe(-0.5, 0.24, 0.2);
  toe(0, 0.26, 0.15);
  toe(0.5, 0.24, 0.2);
  toe(Math.PI, 0.18, 0.1); // rear talon
  return g;
}

export function buildEagle(): THREE.Group {
  const g = new THREE.Group();

  // ---- legs + grasping talons (perched, gripping forward)
  for (const sx of [-0.26, 0.26]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.3, 8), M.gold());
    leg.position.set(sx, 0.2, -0.05);
    g.add(leg);
    // brown feathered "trouser" over the top of the leg
    feather(g, M.brown(), 0.2, 0.26, sx, 0.36, -0.05, 0.1, 0, 0);
    const foot = talon();
    foot.position.set(sx, 0.02, -0.16);
    g.add(foot);
  }

  // ---- body: brown teardrop over a cream belly, leaning slightly forward
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 16), M.brown());
  body.scale.set(0.92, 1.25, 0.9);
  body.position.set(0, 0.86, 0.02);
  body.castShadow = true;
  g.add(body);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.42, 18, 14), M.cream());
  belly.scale.set(0.78, 1.05, 0.6);
  belly.position.set(0, 0.66, -0.24);
  g.add(belly);
  // cream belly feathering (rows of pale feather tips down the front)
  featherPatch(g, M.cream(), 4, 5, 0.5, 1.0, 0.34, 0.8, 0.1, 0.55);
  // brown back/shoulder feathering
  featherPatch(body, M.brownDk(), 3, 5, 0.1, 0.55, 0.52, 0.9, 0.12, 0.5);

  // ---- white neck ruff (the bald eagle's brown→white boundary)
  featherPatch(g, M.white(), 2, 9, 1.06, 1.18, 0.34, 1.0, 0.11, 0.35);

  // ---- head: white, tilted, fierce
  const head = new THREE.Group();
  head.position.set(0, 1.3, -0.06);
  head.rotation.x = -0.12;
  g.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.28, 18, 14), M.white());
  skull.scale.set(0.94, 0.98, 1.02);
  skull.castShadow = true;
  head.add(skull);
  // crown + cheek feather layering
  for (const sx of [-1, 1]) {
    feather(head, M.white(), 0.16, 0.24, sx * 0.16, 0.06, -0.06, 0.2, sx * 0.5, sx * 0.3);
    feather(head, M.white(), 0.14, 0.2, sx * 0.2, -0.08, -0.02, 0.1, sx * 0.7, sx * 0.2);
  }
  feather(head, M.white(), 0.2, 0.18, 0, 0.2, 0.06, -0.3, 0, 0); // nape crest
  // brow ridges — angled down for the glare
  for (const sx of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.06, 0.14), M.white());
    brow.position.set(sx * 0.12, 0.06, -0.2);
    brow.rotation.z = sx * 0.5;
    head.add(brow);
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.055, 10, 10), M.eye());
    eye.position.set(sx * 0.13, 0.0, -0.24);
    head.add(eye);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 8), M.dark());
    pupil.position.set(sx * 0.14, 0.0, -0.29);
    head.add(pupil);
  }
  // hooked beak: gold cere + tapering bill + a down-curled tip
  const cere = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), M.goldDk());
  cere.scale.set(1, 0.8, 1);
  cere.position.set(0, -0.05, -0.24);
  head.add(cere);
  const bill = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.34, 10), M.gold());
  bill.rotation.x = -Math.PI / 2;
  bill.position.set(0, -0.08, -0.42);
  head.add(bill);
  const hook = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.12, 8), M.goldDk());
  hook.rotation.x = -2.5; // curls down
  hook.position.set(0, -0.14, -0.55);
  head.add(hook);
  const nostril = new THREE.Mesh(new THREE.SphereGeometry(0.02, 6, 6), M.dark());
  nostril.position.set(0.05, -0.03, -0.3);
  head.add(nostril);

  // ---- flag wings, spread in a heroic V (stars at the shoulder)
  const wingGeo = wingMembrane();
  const wing = (side: 1 | -1) => {
    const mat = rippleMaterial({ colorNode: texture(usFlagTexture(), uv()), amp: 0.13, speed: 4.6, phase: side > 0 ? 0 : 1.4 });
    const w = new THREE.Mesh(wingGeo, mat);
    w.scale.set(side * 2.05, 1.55, 1);
    w.rotation.order = "ZYX";
    // lay the membrane back, sweep it and lift the tip into the V
    w.rotation.set(-1.18, side * -0.28, side * 0.62);
    w.position.set(side * 0.24, 1.02, 0.06);
    w.castShadow = true;
    g.add(w);
    // a few dark primary feathers fanning off the tip for silhouette
    for (let i = 0; i < 4; i++) {
      feather(w, M.brownDk(), 0.09, 0.4, 0.92, -0.3 + i * 0.16, 0.02, 0, 0, 0.2 - i * 0.12);
    }
  };
  wing(1);
  wing(-1);

  // ---- white tail fan (spread down and back)
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 1.1;
    feather(g, M.white(), 0.11, 0.62, Math.sin(a) * 0.24, 0.55, 0.42 + Math.cos(a) * 0.05, 1.15, 0, a * 0.5);
    feather(g, M.brownDk(), 0.05, 0.16, Math.sin(a) * 0.34, 0.36, 0.6, 1.2, 0, a * 0.5); // dark tips
  }

  return g;
}
