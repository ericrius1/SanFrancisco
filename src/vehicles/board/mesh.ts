import * as THREE from "three/webgpu";
import { cos, float, floor, fract, length, mix, sin, smoothstep, texture, uniform, uv, vec2, vec3 } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { lightAnchor, type LightAnchorSpec } from "../../player/lightPool";
import { applyMaterialPolicy, clampCoverage, fresnelCoverage, tagTransparency } from "../../render/transparency";
import {
  boardGlowHex,
  boardPlumeHex,
  boardTrimHex,
  normalizeBoardConfig,
  type BoardConfig,
  type BoardFx,
  type BoardShape
} from "./config";
import { paintBoardSurface } from "./surfaceTexture";
import { BOARD_EFFECT_TUNING, HALO_TUNING } from "./tuning";

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
  return (
    `${config.deck}|${config.trim}|${config.glow}|${config.deckHex}|${config.trimHex}|${config.glowHex}|` +
    `${config.surface}|${config.surfaceScale}|${config.surfaceWarp}|${config.surfaceSeed}`
  );
}

type BoardSurfaceState = {
  canvas: HTMLCanvasElement;
  texture: THREE.CanvasTexture;
  paintKey: string;
  flow: number; // 0..1 tempo of every surface motion
  fx: number; // 0..1 strength of the chosen effect
  fxKind: BoardFx;
  phase: number; // seed-derived offset so identical boards don't sync up
  clock: number; // accumulated flow-scaled animation time (edits never snap it)
  scroll: number; // accumulated artwork travel along the deck
  uPhase: ReturnType<typeof uniform>;
  uScroll: ReturnType<typeof uniform>;
  uFlow: ReturnType<typeof uniform>;
  uFx: ReturnType<typeof uniform>; // vec3 weights: x vortex, y ripple, z glitch
  uEmissive: ReturnType<typeof uniform>;
  reducedMotion: boolean;
};

/** One-hot the chosen effect into the shared weight uniform (all three live in
 *  one program — switching kinds is a uniform flip, never a shader rebuild). */
function applyFxWeights(state: BoardSurfaceState) {
  const s = state.reducedMotion ? 0 : state.fx;
  (state.uFx.value as THREE.Vector3).set(
    state.fxKind === "vortex" ? s : 0,
    state.fxKind === "ripple" ? s : 0,
    state.fxKind === "glitch" ? s : 0
  );
}

/**
 * The deck artwork's living skin: one Lambert node material that samples the
 * painted canvas through a warped, travelling UV. Flow scrolls + sways the art
 * (obviously, at full tilt); the chosen effect bends the lookup — a swirling
 * vortex, radial shockwave ripples, or scanline glitch tears with RGB split.
 * All three are computed branchlessly and blended by weight so effect strength
 * 0 is a perfect identity (never If(): see the shader-branch pixel hazard).
 */
function buildSurfaceMaterial(
  map: THREE.CanvasTexture,
  s: Pick<BoardSurfaceState, "uPhase" | "uScroll" | "uFlow" | "uFx" | "uEmissive">
) {
  const material = new THREE.MeshLambertNodeMaterial();
  const phase = s.uPhase as unknown as ReturnType<typeof float>;
  const flow = s.uFlow as unknown as ReturnType<typeof float>;
  const weights = s.uFx as unknown as ReturnType<typeof vec3>;

  // centered, aspect-true frame (art is 1:2, board length runs along v),
  // pre-rotated by the flow wobble so the whole skin sways when animated
  const wob = sin(phase.mul(0.61)).mul(flow).mul(0.1);
  const cw = cos(wob);
  const sw = sin(wob);
  const p0 = uv().sub(0.5).mul(vec2(1, 2));
  const p = vec2(p0.x.mul(cw).sub(p0.y.mul(sw)), p0.x.mul(sw).add(p0.y.mul(cw)));
  const r = length(p);
  const fall = float(1).sub(smoothstep(0.08, 1.15, r)); // effects live near the deck centre

  // vortex — twist angle grows with strength and churns with the clock
  const twist = fall.mul(weights.x).mul(float(2.6).add(sin(phase.mul(0.8)).mul(0.9)));
  const ct = cos(twist);
  const st = sin(twist);
  const swirled = vec2(p.x.mul(ct).sub(p.y.mul(st)), p.x.mul(st).add(p.y.mul(ct)));

  // ripple — expanding rings bend the art radially, crests racing outward
  const wave = sin(r.mul(16).sub(phase.mul(3.4)));
  const radial = p.div(r.max(0.002)).mul(wave).mul(fall).mul(weights.y).mul(0.16);

  const warped = swirled.add(radial).mul(vec2(1, 0.5)).add(0.5);

  // glitch — horizontal band tears that re-deal with the clock
  const tick = floor(phase.mul(2.3));
  const band = floor(warped.y.mul(15).add(tick.mul(3)));
  const jolt = fract(sin(band.mul(127.1).add(tick.mul(311.7))).mul(43758.547));
  const tear = jolt.sub(0.5).mul(smoothstep(0.35, 0.95, jolt)).mul(weights.z).mul(0.42);

  // flow's travelling motion: artwork streams down the deck + gentle sideways sway
  const sway = sin(phase.mul(0.9)).mul(flow).mul(0.05);
  const suv = warped.add(vec2(tear.add(sway), (s.uScroll as unknown as ReturnType<typeof float>).negate()));

  // glitch RGB split: side samples collapse onto the centre one at weight 0
  const split = vec2(weights.z.mul(0.018).mul(float(0.7).add(sin(phase.mul(4.7)).mul(0.3))), 0);
  const art = vec3(
    texture(map, suv.add(split)).r,
    texture(map, suv).g,
    texture(map, suv.sub(split)).b
  );
  material.colorNode = art;
  // faint self-lit copy keeps the artwork legible on the underside while
  // Lambert still describes the bevel and sidewalls. (emissiveNode works on
  // every NodeMaterial at runtime but is only TYPED on MeshStandardNodeMaterial.)
  (material as unknown as { emissiveNode: unknown }).emissiveNode = art.mul(
    s.uEmissive as unknown as ReturnType<typeof float>
  );
  return material;
}

type PlumeUniforms = {
  uPlumeTime: ReturnType<typeof uniform>;
  uPlumeStrength: ReturnType<typeof uniform>;
  uPlumeShimmer: ReturnType<typeof uniform>;
  uPlumeFresnelPower: ReturnType<typeof uniform>;
  uPlumeColor: ReturnType<typeof uniform>; // THREE.Color, raw config hex (LIGHT_SCALE applied in-shader)
};

/**
 * Thruster energy shell: an open taper below each pod wearing one shared
 * additive node material — soft magic emanation, not jet fire. Bands scroll
 * down the shell (cylinder v runs 1 at the pod → 0 at the tip) with a sideways
 * wobble; shimmer scales both the wobble and the band contrast, so 0 is a calm
 * steady glow. Everything is mix/multiply — fades never branch (If() + noise
 * corrupts skipped pixels), and weight 0 stays a perfect identity.
 */
function buildPlumeMaterial(u: PlumeUniforms) {
  const material = new THREE.MeshBasicNodeMaterial({
    // Only the exterior wall contributes. Double-sided additive shells draw
    // both cylinder walls and roughly double their energy through the rider.
    side: THREE.FrontSide
  });
  applyMaterialPolicy(material, "additiveWorld");
  const time = u.uPlumeTime as unknown as ReturnType<typeof float>;
  const strength = u.uPlumeStrength as unknown as ReturnType<typeof float>;
  const shimmer = u.uPlumeShimmer as unknown as ReturnType<typeof float>;
  const fresnelPower = u.uPlumeFresnelPower as unknown as ReturnType<typeof float>;
  const tint = u.uPlumeColor as unknown as ReturnType<typeof vec3>;
  const vuv = uv();
  // hot near-white core where the plume meets the pod, config color below
  material.colorNode = mix(tint, vec3(1, 1, 1), vuv.y.mul(vuv.y).mul(0.7)).mul(LIGHT_SCALE);
  // scrolling energy bands, wobbled around the shell so the flow looks alive.
  // uv.x wraps the cylinder — the wobble frequency is a whole number of turns
  // so the seam stays continuous.
  const wobble = sin(vuv.x.mul(Math.PI * 4).add(time)).mul(shimmer).mul(2.2);
  const bands = sin(vuv.y.mul(14).sub(time.mul(5)).add(wobble)).mul(0.5).add(0.5);
  const banded = mix(float(1), bands, float(0.3).add(shimmer.mul(0.55)));
  const fade = smoothstep(0.0, 0.45, vuv.y); // dissolves toward the tip
  // Suppress face-on coverage while retaining a small core; clamping prevents
  // boost + live intensity tuning from feeding >1 coverage into the blend.
  const fresnel = fresnelCoverage(fresnelPower, 0.08);
  material.opacityNode = clampCoverage(banded.mul(fade).mul(strength).mul(fresnel));
  return material;
}

/** Comet state for halo fins. All look parameters live in HALO_TUNING (read
 *  per frame), so only the integrated motion state is kept here. */
type BoardHalo = {
  orbs: THREE.Mesh[]; // MAX_HALO_ORBS children of the ring-centre group
  mats: THREE.MeshBasicMaterial[]; // per-orb, additive, recolored per frame
  theta: number; // comet head angle on the ring
  spread: number; // current tail arc, eased toward the speed-scaled target
};

type BoardPlume = PlumeUniforms & {
  cones: THREE.Mesh[]; // one shell per pod; scale.y is the eased length
  motes: { mesh: THREE.Mesh; phase: number }[]; // spark motes, 3 per pod
  moteMat: THREE.MeshBasicMaterial;
  reach: number; // 0..1 from config
  shimmer: number; // 0..1 from config
  sparks: boolean;
  length: number; // current eased shell length (m)
};

const MAX_HALO_ORBS = 12;
const HALO_RADIUS = 0.16;
const HALO_HEAD_RADIUS = 0.034;
const PLUME_MIN_LEN = 0.08;
const PLUME_MAX_LEN = 0.4;

export type BoardAnim = {
  spinners: { obj: THREE.Object3D; axis: "y" | "z"; rate: number }[];
  pulseMat: THREE.MeshBasicMaterial;
  pulseBase: THREE.Color; // LIGHT_SCALE already applied
  lights: { spec: LightAnchorSpec; baseIntensity: number }[];
  surface: BoardSurfaceState;
  halo?: BoardHalo; // only halo-fin boards carry a comet
  plume: BoardPlume;
};

export function buildBoardMesh(config?: BoardConfig): THREE.Group {
  const cfg = normalizeBoardConfig(config ?? {});
  const p = PROFILES[cfg.shape];
  // resolved through config.ts helpers so custom paint overrides land on the
  // trim/glow hardware exactly like they do on the painted surface
  const trimColor = boardTrimHex(cfg);
  const glowColor = boardGlowHex(cfg);

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
  // inset sticker on top. Motion happens entirely in the shader via uniforms;
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
  const surfaceUniforms = {
    uPhase: uniform(0),
    uScroll: uniform(0),
    uFlow: uniform(0),
    uFx: uniform(new THREE.Vector3()),
    uEmissive: uniform(0.06)
  };
  const surfaceMat = mat(buildSurfaceMaterial(surfaceTexture, surfaceUniforms));

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

  // --- thruster pods: dark casing, glow intake ring, spinning turbine,
  // and an energy plume shell + spark motes hanging below each pod ---
  const spinners: BoardAnim["spinners"] = [];
  const podGeo = geo(new THREE.CylinderGeometry(0.09, 0.115, 0.075, 12, 1, true));
  const ringGeo = geo(new THREE.TorusGeometry(0.1, 0.011, 6, 20));
  ringGeo.rotateX(Math.PI / 2);
  const bladeGeo = geo(new THREE.BoxGeometry(0.15, 0.006, 0.03));
  // unit-length open shell; top sits at local y=0 so scale.y grows it downward
  const plumeGeo = geo(new THREE.CylinderGeometry(0.07, 0.03, 1, 12, 1, true));
  plumeGeo.translate(0, -0.5, 0);
  const moteGeo = geo(new THREE.SphereGeometry(0.016, 6, 5));
  const plumeHexNow = boardPlumeHex(cfg);
  const plumeUniforms: PlumeUniforms = {
    uPlumeTime: uniform(0),
    uPlumeStrength: uniform(0),
    uPlumeShimmer: uniform(cfg.plumeShimmer / 100),
    uPlumeFresnelPower: uniform(BOARD_EFFECT_TUNING.values.plumeFresnelPower),
    uPlumeColor: uniform(new THREE.Color(plumeHexNow))
  };
  const plumeMat = mat(buildPlumeMaterial(plumeUniforms)); // ONE material, both pods
  const moteMat = mat(new THREE.MeshBasicMaterial({ color: new THREE.Color(plumeHexNow).multiplyScalar(LIGHT_SCALE) }));
  applyMaterialPolicy(moteMat, "additiveWorld");
  const plumeCones: THREE.Mesh[] = [];
  const plumeMotes: BoardPlume["motes"] = [];
  const plumeLen0 = PLUME_MIN_LEN + (cfg.plumeReach / 100) * (PLUME_MAX_LEN - PLUME_MIN_LEN);
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
    // the emanation hangs from a group at the pod mouth; motes position
    // themselves in its local space so animateBoard never touches world math
    const plumeRoot = new THREE.Group();
    plumeRoot.position.set(0, y - 0.135, pz);
    const cone = new THREE.Mesh(plumeGeo, plumeMat);
    cone.scale.y = plumeLen0;
    tagTransparency(cone, { profile: "additiveWorld" });
    plumeRoot.add(cone);
    plumeCones.push(cone);
    for (let k = 0; k < 3; k++) {
      const mote = new THREE.Mesh(moteGeo, moteMat);
      const phase = (pz < 0 ? 0 : Math.PI) + k * 2.1;
      mote.position.set(Math.cos(phase) * 0.05, -((k + 0.5) / 3) * plumeLen0, Math.sin(phase) * 0.05);
      mote.visible = cfg.plumeSparks;
      tagTransparency(mote, { profile: "additiveWorld" });
      plumeRoot.add(mote);
      plumeMotes.push({ mesh: mote, phase });
    }
    g.add(plumeRoot);
  }
  const plume: BoardPlume = {
    ...plumeUniforms,
    cones: plumeCones,
    motes: plumeMotes,
    moteMat,
    reach: cfg.plumeReach / 100,
    shimmer: cfg.plumeShimmer / 100,
    sparks: cfg.plumeSparks,
    length: plumeLen0
  };

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
  let halo: BoardHalo | undefined;
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
    // an energy ring the board perpetually flies through, with a comet riding
    // it: a chain of additive orbs that whips through the sides, stalls at the
    // top/bottom, and collapses there into a concentric glowing stack. All
    // motion + look live in HALO_TUNING (animateBoard reads it per frame).
    const fz = p.halfL - 0.02;
    const fy = kickLift(p, fz) + 0.17;
    const ring = new THREE.Mesh(geo(new THREE.TorusGeometry(HALO_RADIUS, 0.016, 6, 28)), glowMat);
    ring.position.set(0, fy, fz);
    g.add(ring);
    const comet = new THREE.Group();
    comet.position.set(0, fy, fz);
    // one unit sphere serves every orb; scale.setScalar is the radius knob.
    // Per-orb additive materials so overlapping orbs ADD light when stacked.
    const cometOrbGeo = geo(new THREE.SphereGeometry(1, 8, 6));
    const orbs: THREE.Mesh[] = [];
    const orbMats: THREE.MeshBasicMaterial[] = [];
    for (let i = 0; i < MAX_HALO_ORBS; i++) {
      const orbMat = mat(new THREE.MeshBasicMaterial());
      applyMaterialPolicy(orbMat, "additiveWorld");
      const cometOrb = new THREE.Mesh(cometOrbGeo, orbMat);
      cometOrb.scale.setScalar(HALO_HEAD_RADIUS);
      cometOrb.position.set(HALO_RADIUS, 0, 0);
      tagTransparency(cometOrb, { profile: "additiveWorld" });
      comet.add(cometOrb);
      orbs.push(cometOrb);
      orbMats.push(orbMat);
    }
    g.add(comet);
    halo = { orbs, mats: orbMats, theta: 0, spread: 0 };
  }

  // --- light (shared LightPool anchors — never real Light objects here) ---
  // primary: the glow pool around the deck that lifts the rider out of the dark;
  // both spec objects stay live so animateBoard can scale the complete light rig
  const initialLightGain = BOARD_EFFECT_TUNING.values.boardLightIntensity;
  const deckLightSpec: LightAnchorSpec = { color: glowColor, intensity: 10 * initialLightGain, distance: 8 };
  g.add(lightAnchor(deckLightSpec, 0, 0.55, 0));
  // secondary chest-height fill so the rider's vertical faces aren't black at night
  const riderLightSpec: LightAnchorSpec = { color: glowColor, intensity: 5 * initialLightGain, distance: 6 };
  g.add(lightAnchor(riderLightSpec, 0.75, 1.5, -0.65));
  const lights = [
    { spec: deckLightSpec, baseIntensity: 10 },
    { spec: riderLightSpec, baseIntensity: 5 }
  ];

  const surfaceState: BoardSurfaceState = {
    canvas: surfaceCanvas,
    texture: surfaceTexture,
    paintKey: surfacePaintKey(cfg),
    flow: cfg.surfaceFlow / 100,
    fx: cfg.surfaceFx / 100,
    fxKind: cfg.surfaceFxKind,
    phase: (cfg.surfaceSeed / 65536) * Math.PI * 2,
    clock: 0,
    scroll: 0,
    ...surfaceUniforms,
    reducedMotion:
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
  };
  applyFxWeights(surfaceState);
  surfaceState.uPhase.value = surfaceState.phase;
  const anim: BoardAnim = { spinners, pulseMat, pulseBase, lights, surface: surfaceState, halo, plume };
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

/** Update a live editor preview; motion/effect edits avoid a canvas upload
 *  entirely (uniform flips), paint edits repaint + re-upload once. */
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
  state.fx = cfg.surfaceFx / 100;
  state.fxKind = cfg.surfaceFxKind;
  state.phase = (cfg.surfaceSeed / 65536) * Math.PI * 2;
  applyFxWeights(state);
  // thruster plume knobs preview live too — uniform/visibility flips only,
  // never a rebuild (reach reshapes the shells via the eased scale next frame)
  const anim = board.userData.boardAnim as BoardAnim | undefined;
  if (anim) {
    const plume = anim.plume;
    plume.reach = cfg.plumeReach / 100;
    plume.shimmer = cfg.plumeShimmer / 100;
    plume.sparks = cfg.plumeSparks;
    plume.uPlumeShimmer.value = plume.shimmer;
    const hex = boardPlumeHex(cfg);
    (plume.uPlumeColor.value as THREE.Color).set(hex);
    plume.moteMat.color.set(hex).multiplyScalar(LIGHT_SCALE);
    for (const mote of plume.motes) mote.mesh.visible = plume.sparks;
  }
}

/**
 * Per-frame board life. Art moves by shader uniforms only: there are no canvas
 * repaints, texture uploads, material swaps, or vertex changes while riding.
 * Flow is the single tempo knob — it drives how fast the artwork streams,
 * sways, and how quickly the chosen deck effect churns.
 */
export function animateBoard(board: THREE.Group, dt: number, t: number, speed: number, boosting = false) {
  const anim = board.userData.boardAnim as BoardAnim | undefined;
  if (!anim) return;
  const step = THREE.MathUtils.clamp(dt, 0, 0.05);
  const norm = Math.min(1, speed / 30);
  for (const s of anim.spinners) {
    const spool = s.axis === "y" ? 0.55 + norm * 2.6 : 1 + norm * 0.8;
    s.obj.rotation[s.axis] += step * s.rate * spool;
  }

  const surface = anim.surface;
  const flow = surface.reducedMotion ? 0 : surface.flow;
  const fx = surface.reducedMotion ? 0 : surface.fx;
  const boostGain = boosting ? 1.35 : 1;
  // clocks accumulate (instead of scaling absolute time) so dragging the flow
  // pad retunes the tempo live without teleporting the pattern
  surface.clock += step * (0.22 + flow * 2.6) * boostGain;
  surface.scroll = (surface.scroll + step * flow * (0.05 + flow * 0.17 + norm * 0.06) * boostGain) % 1;
  surface.uPhase.value = surface.phase + surface.clock;
  surface.uScroll.value = surface.scroll;
  surface.uFlow.value = flow;
  surface.uEmissive.value = 0.06 + fx * 0.05 + (boosting ? flow * 0.05 : 0);

  const breathe = 0.82 + 0.18 * Math.sin(t * 2.4) + 0.06 * Math.sin(t * 11) * norm;
  anim.pulseMat.color.copy(anim.pulseBase).multiplyScalar(breathe);
  const lightPulse = 0.88 + 0.24 * (breathe - 0.82);
  const lightGain = BOARD_EFFECT_TUNING.values.boardLightIntensity;
  for (const light of anim.lights) light.spec.intensity = light.baseIntensity * lightGain * lightPulse;

  // --- thruster plumes: uniforms + transforms only, shared by both pods ---
  const plume = anim.plume;
  // reducedMotion freezes the flow but keeps the static soft glow standing
  if (!surface.reducedMotion) {
    plume.uPlumeTime.value = (plume.uPlumeTime.value as number) + step * (0.8 + plume.shimmer * 2.2 + norm * 0.8);
  }
  const effects = BOARD_EFFECT_TUNING.values;
  plume.uPlumeFresnelPower.value = effects.plumeFresnelPower;
  plume.uPlumeStrength.value = (0.28 + plume.reach * 0.22) * effects.plumeIntensity * (boosting ? 1.4 : 1);
  const targetLen =
    PLUME_MIN_LEN + plume.reach * (PLUME_MAX_LEN - PLUME_MIN_LEN) + norm * 0.08 + (boosting ? 0.05 : 0);
  plume.length += (targetLen - plume.length) * Math.min(1, dt * 6);
  for (const cone of plume.cones) cone.scale.y = plume.length;
  if (plume.sparks && !surface.reducedMotion) {
    // motes spiral lazily down the plume, wrap back to the pod mouth, and
    // pulse — cheap CPU transforms on six tiny spheres
    for (const mote of plume.motes) {
      const cyc = (t * 0.45 + mote.phase * 0.161) % 1;
      const ang = t * 1.4 + mote.phase;
      const r = 0.05 + 0.015 * Math.sin(t * 2.1 + mote.phase * 2);
      mote.mesh.position.set(Math.cos(ang) * r, -cyc * plume.length, Math.sin(ang) * r);
      mote.mesh.scale.setScalar(1 + 0.35 * Math.sin(t * 6 + mote.phase * 3));
    }
  }

  // --- halo comet: eased orbit + tail that stretches through the fast sides
  // and collapses into a concentric stack at the slow poles. Reads live
  // HALO_TUNING so every slider (count included) lands without a rebuild. ---
  const halo = anim.halo;
  if (halo) {
    const hv = HALO_TUNING.values;
    const count = Math.max(2, Math.min(MAX_HALO_ORBS, Math.round(hv.count)));
    // ring plane is local x/y: sin(theta) is height, so sin² stalls top+bottom
    const sinT = Math.sin(halo.theta);
    const omega = hv.orbitSpeed * (1 - hv.slowdown * sinT * sinT);
    halo.theta = (halo.theta + step * omega * (1 + norm * 0.6)) % (Math.PI * 2);
    // tail arc chases the speed ratio: long through the whip, tight at the stall
    const targetSpread = hv.tailSpread * (omega / Math.max(1e-4, hv.orbitSpeed));
    halo.spread += (targetSpread - halo.spread) * Math.min(1, dt * hv.collapse);
    for (let i = 0; i < halo.orbs.length; i++) {
      const orb = halo.orbs[i];
      orb.visible = i < count;
      if (!orb.visible) continue;
      const a = halo.theta - (i * halo.spread) / count;
      orb.position.set(Math.cos(a) * HALO_RADIUS, Math.sin(a) * HALO_RADIUS, 0);
      const pulse = 1 + 0.12 * Math.sin(t * 5.2 + i * 1.7);
      orb.scale.setScalar(HALO_HEAD_RADIUS * Math.pow(hv.taper, i) * pulse);
      // dark blue head → caribbean glow → near-white tip; the tip is smallest
      // AND brightest, so the collapsed stack reads as light shining from
      // inside a dark sphere. ≤12 setHSL calls — trivial per frame.
      const f = count > 1 ? i / (count - 1) : 1;
      const white = f * f * hv.whiten;
      const orbMat = halo.mats[i];
      orbMat.color.setHSL(
        THREE.MathUtils.lerp(hv.hueDeep, hv.hueGlow, f) / 360,
        hv.sat * (1 - white),
        0.32 + white * 0.6
      );
      orbMat.color.multiplyScalar(LIGHT_SCALE * (0.7 + f * f * 1.6));
    }
  }
}
