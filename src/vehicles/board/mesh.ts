import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { lightAnchor, type LightAnchorSpec } from "../../player/lightPool";
import {
  BOARD_DECK_COLORS,
  BOARD_GLOW_COLORS,
  normalizeBoardConfig,
  type BoardConfig,
  type BoardShape
} from "./config";

/**
 * Hoverboard, front is local -Z. The deck is a real silhouette now — a closed
 * spline outline extruded with a bevel, nose/tail kicked by bending vertices
 * up along a curve — with a glow rail tube tracing the rim, a shaped underglow
 * plate that breathes, and twin thruster pods whose turbine blades spin with
 * speed (animateBoard, called by whoever owns the mesh each frame).
 *
 * Everything cosmetic reads from a BoardConfig (config.ts) so the customizer
 * can rebuild the whole thing per player. Materials are created per build —
 * remote players carry their own configs — but they're all Lambert/Basic, the
 * same programs the rest of the app already compiled, so a rebuild never
 * stalls the pipeline. The group carries userData.dispose to free its
 * geometries/materials (remotes swap boards; the local player recustomizes).
 *
 * Direction identity stays fixed on purpose: warm-white nose light, red tail
 * bar — travel direction must read on a distant silhouette no matter how the
 * board is themed (the glow color owns everything else).
 */

type Profile = {
  halfL: number;
  pts: [number, number][]; // (z, halfWidth) control points, nose→tail
  notch?: number; // swallow-tail: pull the tail centre forward to this z
  noseKick: number; // metres of upward bend at the very tip
  tailKick: number;
  kickSpan: number; // how far from the tip the bend starts
};

const PROFILES: Record<BoardShape, Profile> = {
  classic: {
    halfL: 1.05,
    pts: [
      [-1.05, 0.06],
      [-0.98, 0.2],
      [-0.8, 0.3],
      [-0.4, 0.36],
      [0.2, 0.36],
      [0.7, 0.33],
      [0.95, 0.26],
      [1.05, 0.1]
    ],
    noseKick: 0.16,
    tailKick: 0.12,
    kickSpan: 0.45
  },
  dart: {
    halfL: 1.1,
    pts: [
      [-1.1, 0.02],
      [-1.04, 0.05],
      [-0.75, 0.16],
      [-0.3, 0.28],
      [0.3, 0.36],
      [0.8, 0.4],
      [1.04, 0.38],
      [1.1, 0.2]
    ],
    noseKick: 0.06,
    tailKick: 0.18,
    kickSpan: 0.4
  },
  manta: {
    halfL: 0.98,
    pts: [
      [-0.98, 0.08],
      [-0.88, 0.24],
      [-0.66, 0.4],
      [-0.35, 0.46],
      [0.05, 0.42],
      [0.45, 0.3],
      [0.82, 0.22],
      [0.98, 0.16]
    ],
    notch: 0.74,
    noseKick: 0.14,
    tailKick: 0,
    kickSpan: 0.42
  },
  saucer: {
    halfL: 0.95,
    pts: [
      [-0.95, 0.05],
      [-0.8, 0.24],
      [-0.5, 0.37],
      [0, 0.42],
      [0.5, 0.37],
      [0.8, 0.24],
      [0.95, 0.05]
    ],
    noseKick: 0.05,
    tailKick: 0.05,
    kickSpan: 0.35
  },
  twintip: {
    halfL: 1.08,
    pts: [
      [-1.08, 0.08],
      [-0.95, 0.24],
      [-0.65, 0.32],
      [0, 0.33],
      [0.65, 0.32],
      [0.95, 0.24],
      [1.08, 0.08]
    ],
    noseKick: 0.17,
    tailKick: 0.17,
    kickSpan: 0.48
  }
};

const DECK_TOP = 0.05; // rider soles sit at 0.93 on the rig group — keep the top here

/** Closed outline loop in shape space (x = width, y = board z), nose→tail→back. */
function outlinePoints(p: Profile): THREE.Vector2[] {
  const ctrl: THREE.Vector3[] = [];
  for (const [z, w] of p.pts) ctrl.push(new THREE.Vector3(w, z, 0));
  if (p.notch !== undefined) ctrl.push(new THREE.Vector3(0, p.notch, 0));
  for (let i = p.pts.length - 1; i >= 0; i--) {
    const [z, w] = p.pts[i];
    ctrl.push(new THREE.Vector3(-w, z, 0));
  }
  const curve = new THREE.CatmullRomCurve3(ctrl, true, "catmullrom", 0.6);
  return curve.getPoints(88).slice(0, 88).map((v) => new THREE.Vector2(v.x, v.y));
}

/** Upward bend applied to deck vertices and rail points near the tips. */
function kickLift(p: Profile, z: number): number {
  const start = p.halfL - p.kickSpan;
  const a = Math.abs(z);
  if (a <= start) return 0;
  const u = Math.min(1, (a - start) / p.kickSpan);
  return u * u * (z < 0 ? p.noseKick : p.tailKick);
}

export type BoardAnim = {
  spinners: { obj: THREE.Object3D; axis: "y" | "z"; rate: number }[];
  pulseMat: THREE.MeshBasicMaterial;
  pulseBase: THREE.Color; // LIGHT_SCALE already applied
  lightSpec: LightAnchorSpec;
  lightBase: number;
};

export function buildBoardMesh(config?: BoardConfig): THREE.Group {
  const cfg = normalizeBoardConfig(config ?? {});
  const p = PROFILES[cfg.shape];
  const deckColor = BOARD_DECK_COLORS[cfg.deck].color;
  const trimColor = BOARD_DECK_COLORS[cfg.trim].color;
  const glowColor = BOARD_GLOW_COLORS[cfg.glow].color;

  const g = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const geo = <T extends THREE.BufferGeometry>(x: T): T => (geos.push(x), x);
  const mat = <T extends THREE.Material>(x: T): T => (mats.push(x), x);

  const deckMat = mat(new THREE.MeshLambertMaterial({ color: deckColor }));
  const trimMat = mat(new THREE.MeshLambertMaterial({ color: trimColor }));
  const darkMat = mat(new THREE.MeshLambertMaterial({ color: 0x262c36 }));
  const glowMat = mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(glowColor).multiplyScalar(LIGHT_SCALE) }));
  // the breathing set (underglow plate + pod rings) gets its own instance so
  // animateBoard can pulse it without touching the steady rails
  const pulseBase = new THREE.Color(glowColor).multiplyScalar(LIGHT_SCALE);
  const pulseMat = mat(new THREE.MeshBasicMaterial({ color: pulseBase.clone(), side: THREE.DoubleSide }));
  const glowNose = mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff4c9).multiplyScalar(LIGHT_SCALE) }));
  const glowTail = mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2818).multiplyScalar(LIGHT_SCALE) }));

  const outline = outlinePoints(p);

  // --- deck: bevelled extrude of the silhouette, then bend the kicks in ---
  const shape = new THREE.Shape(outline);
  const deckGeo = geo(
    new THREE.ExtrudeGeometry(shape, {
      depth: 0.08,
      bevelEnabled: true,
      bevelThickness: 0.014,
      bevelSize: 0.02,
      bevelSegments: 2,
      steps: 1,
      curveSegments: 8
    })
  );
  deckGeo.rotateX(Math.PI / 2); // shape y → world z, extrusion sinks below y=0
  deckGeo.translate(0, DECK_TOP - 0.014, 0);
  {
    const pos = deckGeo.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + kickLift(p, pos.getZ(i)));
    deckGeo.computeVertexNormals(); // faceted after the bend — matches the app's stylized look
  }
  g.add(new THREE.Mesh(deckGeo, deckMat));

  // --- glow rail: one tube riding the rim (follows the kicks). Pushed out
  // along the 2D outward normal so the deck's bevel (which widens the plan by
  // bevelSize) can't swallow it ---
  const railPts = outline.map((v, i) => {
    const prev = outline[(i - 1 + outline.length) % outline.length];
    const next = outline[(i + 1) % outline.length];
    const tx = next.x - prev.x;
    const ty = next.y - prev.y;
    const tl = Math.hypot(tx, ty) || 1e-6;
    // CCW loop: outward normal of tangent (tx,ty) is (ty,-tx)
    const ox = (ty / tl) * 0.022;
    const oy = (-tx / tl) * 0.022;
    return new THREE.Vector3(v.x + ox, kickLift(p, v.y + oy), v.y + oy);
  });
  const railGeo = geo(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts, true), 110, 0.024, 5, true));
  g.add(new THREE.Mesh(railGeo, glowMat));

  // --- underglow plate: the shaped light pool the board rides on ---
  const plateShape = new THREE.Shape(outline.map((v) => new THREE.Vector2(v.x * 0.78, v.y * 0.8)));
  const plateGeo = geo(new THREE.ShapeGeometry(plateShape));
  plateGeo.rotateX(Math.PI / 2);
  plateGeo.translate(0, -0.075, 0);
  g.add(new THREE.Mesh(plateGeo, pulseMat));

  // --- thruster pods: dark casing, glow intake ring, spinning turbine ---
  const spinners: BoardAnim["spinners"] = [];
  const podGeo = geo(new THREE.CylinderGeometry(0.09, 0.115, 0.075, 12, 1, true));
  const ringGeo = geo(new THREE.TorusGeometry(0.1, 0.011, 6, 20));
  ringGeo.rotateX(Math.PI / 2);
  const bladeGeo = geo(new THREE.BoxGeometry(0.15, 0.006, 0.03));
  for (const pz of [-0.5, 0.5]) {
    const y = kickLift(p, pz);
    const casing = new THREE.Mesh(podGeo, darkMat);
    casing.position.set(0, y - 0.095, pz);
    g.add(casing);
    const ring = new THREE.Mesh(ringGeo, pulseMat);
    ring.position.set(0, y - 0.13, pz);
    g.add(ring);
    const turbine = new THREE.Group();
    turbine.position.set(0, y - 0.11, pz);
    for (let k = 0; k < 3; k++) {
      const blade = new THREE.Mesh(bladeGeo, glowMat);
      blade.rotation.y = (k * Math.PI * 2) / 3;
      blade.rotation.x = 0.35;
      turbine.add(blade);
    }
    g.add(turbine);
    spinners.push({ obj: turbine, axis: "y", rate: pz < 0 ? 9 : -9 }); // counter-rotating pair
  }

  // --- direction identity: warm-white nose orb + red tail bar ---
  const noseZ = -(p.halfL - 0.07);
  const orbGeo = geo(new THREE.SphereGeometry(0.052, 10, 8));
  const orb = new THREE.Mesh(orbGeo, glowNose);
  orb.position.set(0, kickLift(p, noseZ) + 0.02, noseZ);
  g.add(orb);
  // swallow tails carry the bar just ahead of the notch (solid deck there);
  // everyone else sits it near the tip but inside the narrowing outline
  const tailZ = p.notch !== undefined ? p.notch - 0.06 : p.halfL - 0.1;
  const barGeo = geo(new THREE.BoxGeometry(0.26, 0.05, 0.07));
  const bar = new THREE.Mesh(barGeo, glowTail);
  bar.position.set(0, kickLift(p, tailZ) + 0.01, tailZ);
  g.add(bar);

  // --- deck art (trim color), sitting just proud of the top face ---
  const artY = DECK_TOP + 0.007;
  if (cfg.deco === "stripe") {
    const s = new THREE.Mesh(geo(new THREE.BoxGeometry(0.12, 0.012, p.halfL * 1.24)), trimMat);
    s.position.y = artY;
    g.add(s);
  } else if (cfg.deco === "chevrons") {
    const cGeo = geo(new THREE.BoxGeometry(0.26, 0.012, 0.07));
    for (const cz of [-0.38, 0, 0.38]) {
      for (const side of [-1, 1]) {
        const c = new THREE.Mesh(cGeo, trimMat);
        c.position.set(side * 0.11, artY, cz);
        c.rotation.y = side * 0.65; // the pair points at the nose
        g.add(c);
      }
    }
  } else if (cfg.deco === "dots") {
    const dGeo = geo(new THREE.CylinderGeometry(0.052, 0.052, 0.012, 10));
    for (let i = 0; i < 5; i++) {
      const d = new THREE.Mesh(dGeo, trimMat);
      d.position.set(0, artY, -0.6 + i * 0.3);
      g.add(d);
    }
  } else if (cfg.deco === "comet") {
    const head = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.09, 0.09, 0.012, 12)), trimMat);
    head.position.set(0, artY, -0.32);
    g.add(head);
    const t1 = new THREE.Mesh(geo(new THREE.BoxGeometry(0.1, 0.012, 0.3)), trimMat);
    t1.position.set(0, artY, 0.02);
    g.add(t1);
    const t2 = new THREE.Mesh(geo(new THREE.BoxGeometry(0.06, 0.012, 0.22)), trimMat);
    t2.position.set(0, artY, 0.42);
    g.add(t2);
  }

  // --- tail furniture ---
  if (cfg.fin === "twin") {
    const finGeo = geo(new THREE.BoxGeometry(0.018, 0.16, 0.22));
    const tipGeo = geo(new THREE.BoxGeometry(0.02, 0.02, 0.12));
    for (const side of [-1, 1]) {
      const fz = p.halfL - 0.28;
      const fy = kickLift(p, fz);
      const fin = new THREE.Mesh(finGeo, trimMat);
      fin.position.set(side * 0.17, fy + 0.12, fz);
      fin.rotation.x = -0.35; // raked back
      g.add(fin);
      const tip = new THREE.Mesh(tipGeo, glowMat);
      tip.position.set(side * 0.17, fy + 0.2, fz - 0.03);
      tip.rotation.x = -0.35;
      g.add(tip);
    }
  } else if (cfg.fin === "spoiler") {
    const fz = p.halfL - 0.22;
    const fy = kickLift(p, fz);
    const postGeo = geo(new THREE.BoxGeometry(0.025, 0.13, 0.025));
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(postGeo, darkMat);
      post.position.set(side * 0.19, fy + 0.1, fz);
      g.add(post);
    }
    const wing = new THREE.Mesh(geo(new THREE.BoxGeometry(0.56, 0.022, 0.14)), trimMat);
    wing.position.set(0, fy + 0.18, fz + 0.02);
    wing.rotation.x = -0.18;
    g.add(wing);
    const strip = new THREE.Mesh(geo(new THREE.BoxGeometry(0.5, 0.012, 0.05)), glowMat);
    strip.position.set(0, fy + 0.163, fz + 0.05);
    strip.rotation.x = -0.18;
    g.add(strip);
  } else if (cfg.fin === "halo") {
    // an energy ring the board perpetually flies through, with a spark orbiting it
    const fz = p.halfL - 0.02;
    const fy = kickLift(p, fz) + 0.17;
    const halo = new THREE.Mesh(geo(new THREE.TorusGeometry(0.16, 0.016, 6, 28)), glowMat);
    halo.position.set(0, fy, fz);
    g.add(halo);
    const orbit = new THREE.Group();
    orbit.position.set(0, fy, fz);
    const spark = new THREE.Mesh(geo(new THREE.SphereGeometry(0.028, 8, 6)), glowNose);
    spark.position.set(0.16, 0, 0);
    orbit.add(spark);
    g.add(orbit);
    spinners.push({ obj: orbit, axis: "z", rate: 3.2 });
  }

  // --- light (shared LightPool anchors — never real Light objects here) ---
  // primary: the glow pool around the deck that lifts the rider out of the dark;
  // its spec object is live — animateBoard breathes the intensity with the plate
  const lightSpec: LightAnchorSpec = { color: glowColor, intensity: 10, distance: 8 };
  g.add(lightAnchor(lightSpec, 0, 0.55, 0));
  // secondary chest-height fill so the rider's vertical faces aren't black at night
  g.add(lightAnchor({ color: glowColor, intensity: 5, distance: 6 }, 0.75, 1.5, -0.65));

  const anim: BoardAnim = { spinners, pulseMat, pulseBase, lightSpec, lightBase: 10 };
  g.userData.boardAnim = anim;
  g.userData.dispose = () => {
    for (const x of geos) x.dispose();
    for (const x of mats) x.dispose();
  };
  // the rider rig is added by Player/remotes (they own and animate the joints)
  return g;
}

/**
 * Per-frame board life: turbines spool with speed, the underglow (and its
 * pooled light, when this is the local player's board) breathes, the halo
 * spark orbits. Cheap — a couple of rotations and one material color write.
 */
export function animateBoard(board: THREE.Group, dt: number, t: number, speed: number) {
  const anim = board.userData.boardAnim as BoardAnim | undefined;
  if (!anim) return;
  const norm = Math.min(1, speed / 30);
  for (const s of anim.spinners) {
    const spool = s.axis === "y" ? 0.55 + norm * 2.6 : 1 + norm * 0.8;
    s.obj.rotation[s.axis] += dt * s.rate * spool;
  }
  const breathe = 0.82 + 0.18 * Math.sin(t * 2.4) + 0.06 * Math.sin(t * 11) * norm;
  anim.pulseMat.color.copy(anim.pulseBase).multiplyScalar(breathe);
  anim.lightSpec.intensity = anim.lightBase * (0.88 + 0.24 * (breathe - 0.82));
}
