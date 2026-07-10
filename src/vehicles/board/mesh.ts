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
import { paintBoardSurface } from "./surfaceTexture";

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

/**
 * Project the finished board silhouette through its thickness. Both caps get
 * the complete artwork; bevel/front/tail/side vertices inherit the boundary
 * texel directly above them, so the skin visibly continues over every edge.
 */
function projectShellUV(geometry: THREE.BufferGeometry) {
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox!;
  const width = Math.max(1e-6, bounds.max.x - bounds.min.x);
  const length = Math.max(1e-6, bounds.max.z - bounds.min.z);
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) - bounds.min.x) / width;
    uv[i * 2 + 1] = 1 - (pos.getZ(i) - bounds.min.z) / length;
  }
  geometry.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
}

function surfacePaintKey(config: BoardConfig) {
  return `${config.deck}|${config.trim}|${config.glow}|${config.surface}|${config.surfaceScale}|${config.surfaceWarp}|${config.surfaceSeed}`;
}

type BoardSurfaceState = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  material: THREE.MeshLambertMaterial;
  paintKey: string;
  flow: number;
  reaction: number;
  phase: number;
  air: number;
  airTime: number;
  minVerticalSpeed: number;
  wasGrounded: boolean;
  impact: number;
  impactAge: number;
  visualImpact: number;
  reducedMotion: boolean;
};

export type BoardAnim = {
  spinners: { obj: THREE.Object3D; axis: "y" | "z"; rate: number }[];
  pulseMat: THREE.MeshBasicMaterial;
  pulseBase: THREE.Color; // LIGHT_SCALE already applied
  lightSpec: LightAnchorSpec;
  lightBase: number;
  surface: BoardSurfaceState;
};

export function buildBoardMesh(config?: BoardConfig): THREE.Group {
  const cfg = normalizeBoardConfig(config ?? {});
  const p = PROFILES[cfg.shape];
  const trimColor = BOARD_DECK_COLORS[cfg.trim].color;
  const glowColor = BOARD_GLOW_COLORS[cfg.glow].color;

  const g = new THREE.Group();
  const geos: THREE.BufferGeometry[] = [];
  const mats: THREE.Material[] = [];
  const geo = <T extends THREE.BufferGeometry>(x: T): T => (geos.push(x), x);
  const mat = <T extends THREE.Material>(x: T): T => (mats.push(x), x);

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

  // One authored image is the actual closed shell material, rather than an
  // inset sticker on top. Texture transforms are updated in animateBoard;
  // canvas pixels are uploaded only when the editor changes paint controls.
  const surfaceCanvas = document.createElement("canvas");
  surfaceCanvas.width = 128;
  surfaceCanvas.height = 256;
  paintBoardSurface(surfaceCanvas, cfg);
  const surfaceTexture = new THREE.CanvasTexture(surfaceCanvas);
  surfaceTexture.colorSpace = THREE.SRGBColorSpace;
  surfaceTexture.anisotropy = 4;
  surfaceTexture.wrapS = THREE.RepeatWrapping;
  surfaceTexture.wrapT = THREE.RepeatWrapping;
  surfaceTexture.center.set(0.5, 0.5);
  const surfaceMat = mat(
    new THREE.MeshLambertMaterial({
      color: 0xffffff,
      map: surfaceTexture,
      // A faint self-lit copy keeps the artwork legible on the underside while
      // still letting Lambert shading describe the bevel and sidewalls.
      emissive: 0xffffff,
      emissiveMap: surfaceTexture,
      emissiveIntensity: 0.06
    })
  );

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
    pos.needsUpdate = true;
    deckGeo.computeVertexNormals(); // faceted after the bend — matches the app's stylized look
  }
  projectShellUV(deckGeo);
  deckGeo.clearGroups();
  const shell = new THREE.Mesh(deckGeo, surfaceMat);
  shell.name = "board-surface-shell";
  g.add(shell);

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

  // --- underglow ring: leaves the wrapped underside visible from below ---
  const underPts = outline.map(
    (v) => new THREE.Vector3(v.x * 0.7, -0.075 + kickLift(p, v.y) * 0.55, v.y * 0.72)
  );
  const underGeo = geo(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(underPts, true), 96, 0.027, 5, true));
  const underglow = new THREE.Mesh(underGeo, pulseMat);
  underglow.name = "board-underglow-ring";
  g.add(underglow);

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

  const surfaceState: BoardSurfaceState = {
    canvas: surfaceCanvas,
    texture: surfaceTexture,
    material: surfaceMat,
    paintKey: surfacePaintKey(cfg),
    flow: cfg.surfaceFlow / 100,
    reaction: cfg.surfaceReaction / 100,
    phase: (cfg.surfaceSeed / 65536) * Math.PI * 2,
    air: 0,
    airTime: 0,
    minVerticalSpeed: 0,
    wasGrounded: true,
    impact: 0,
    impactAge: 0,
    visualImpact: 0,
    reducedMotion:
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  };
  const anim: BoardAnim = { spinners, pulseMat, pulseBase, lightSpec, lightBase: 10, surface: surfaceState };
  g.userData.boardAnim = anim;
  g.userData.boardSurface = surfaceState;
  g.userData.dispose = () => {
    for (const x of geos) x.dispose();
    for (const x of mats) x.dispose();
    surfaceTexture.dispose();
  };
  // the rider rig is added by Player/remotes (they own and animate the joints)
  return g;
}

/** Update a live editor preview; motion-only edits avoid a canvas upload. */
export function updateBoardSurface(board: THREE.Group, config: BoardConfig) {
  const state = board.userData.boardSurface as BoardSurfaceState | undefined;
  if (!state) return;
  const cfg = normalizeBoardConfig(config);
  const paintKey = surfacePaintKey(cfg);
  if (paintKey !== state.paintKey) {
    paintBoardSurface(state.canvas, cfg);
    state.texture.needsUpdate = true;
    state.paintKey = paintKey;
  }
  state.flow = cfg.surfaceFlow / 100;
  state.reaction = cfg.surfaceReaction / 100;
  state.phase = (cfg.surfaceSeed / 65536) * Math.PI * 2;
}

/**
 * Per-frame board life. Art moves by texture uniforms only: there are no canvas
 * repaints, texture uploads, material swaps, or vertex changes while riding.
 */
export function animateBoard(
  board: THREE.Group,
  dt: number,
  t: number,
  speed: number,
  grounded = true,
  verticalSpeed = 0,
  landingImpact = 0,
  boosting = false
) {
  const anim = board.userData.boardAnim as BoardAnim | undefined;
  if (!anim) return;
  const step = THREE.MathUtils.clamp(dt, 0, 0.05);
  const norm = Math.min(1, speed / 30);
  for (const s of anim.spinners) {
    const spool = s.axis === "y" ? 0.55 + norm * 2.6 : 1 + norm * 0.8;
    s.obj.rotation[s.axis] += step * s.rate * spool;
  }

  const surface = anim.surface;
  const motion = surface.reducedMotion ? 0 : surface.flow;
  const reaction = surface.reducedMotion ? 0 : surface.reaction;
  const safeVy = Number.isFinite(verticalSpeed) ? verticalSpeed : 0;
  const airTarget = grounded ? 0 : 1;
  const airRate = grounded ? 8.5 : 4.5;
  surface.air += (airTarget - surface.air) * (1 - Math.exp(-step * airRate));

  // Remotes do not transmit grounded state, so keep a conservative fallback
  // impact detector alongside the exact one-shot local controller impulse.
  let inferredImpact = 0;
  if (!grounded) {
    if (surface.wasGrounded) {
      surface.airTime = 0;
      surface.minVerticalSpeed = Math.min(0, safeVy);
    }
    surface.airTime += step;
    surface.minVerticalSpeed = Math.min(surface.minVerticalSpeed, safeVy);
  } else {
    if (surface.wasGrounded === false && surface.airTime >= 0.08 && surface.minVerticalSpeed <= -3) {
      inferredImpact = THREE.MathUtils.clamp((-surface.minVerticalSpeed - 3) / 21, 0, 1);
    }
    surface.airTime = 0;
    surface.minVerticalSpeed = 0;
  }
  surface.wasGrounded = grounded;

  const trigger = Math.max(THREE.MathUtils.clamp(landingImpact, 0, 1), inferredImpact);
  if (trigger > 0.001) {
    surface.impact = Math.max(surface.visualImpact, trigger);
    surface.impactAge = 0;
  } else if (surface.impact > 0) {
    surface.impactAge += step;
  }
  const landing =
    surface.impact *
    Math.exp(-surface.impactAge * 7.2) *
    (0.35 + 0.65 * (1 - Math.exp(-surface.impactAge * 28)));
  surface.visualImpact = landing;
  if (landing < 0.0005 && surface.impactAge > 0.4) {
    surface.impact = 0;
    surface.impactAge = 0;
    surface.visualImpact = 0;
  }

  const phase = t * (0.42 + motion * 1.15) + surface.phase;
  const airDrift = surface.air * reaction;
  const landingReact = landing * reaction;
  const boostGain = boosting ? 1.22 : 1;
  const drift = motion * (0.0025 + norm * 0.0015 + airDrift * 0.004) * boostGain;
  surface.texture.offset.set(
    Math.sin(phase) * drift + Math.sin(phase * 2.7) * landingReact * 0.003,
    Math.cos(phase * 0.73) * drift * 0.78 + Math.cos(phase * 3.1) * landingReact * 0.002
  );
  surface.texture.rotation =
    Math.sin(phase * 0.61) * motion * 0.008 + Math.sin(phase * 3.8) * landingReact * 0.012;
  const airStretch = airDrift * 0.006;
  const landingZoom = landingReact * 0.014;
  surface.texture.repeat.set(1 + airStretch - landingZoom, 1 - airStretch * 0.45 - landingZoom);
  surface.texture.updateMatrix();
  surface.material.emissiveIntensity =
    0.06 + airDrift * 0.08 + landingReact * 0.28 + (boosting ? motion * 0.035 : 0);

  const breathe = 0.82 + 0.18 * Math.sin(t * 2.4) + 0.06 * Math.sin(t * 11) * norm;
  const pulse = breathe + landingReact * 0.12;
  anim.pulseMat.color.copy(anim.pulseBase).multiplyScalar(pulse);
  anim.lightSpec.intensity = anim.lightBase * (0.88 + 0.24 * (pulse - 0.82));
}
