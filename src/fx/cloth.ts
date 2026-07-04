import * as THREE from "three/webgpu";
import { float, normalLocal, positionLocal, sin, texture, time, uv, vec3 } from "three/tsl";

/**
 * Reusable wind-rippled cloth — the GPU vertex-displacement trick from the boat
 * pennant (src/vehicles/boat/mesh.ts) pulled out so flags, bunting and the
 * eagle's flag-feathered wings all flutter the same way.
 *
 * The panel lives in its local XY plane (normals +Z). Displacement pushes each
 * vertex along local Z by travelling sine waves whose amplitude ramps from 0 at
 * the pinned edge (uv.x = 0, the hoist/pole side) to full at the free fly end,
 * so the cloth stays laced to its pole while the tail snaps. A per-panel
 * `phase` decorrelates a row of otherwise-identical pennants.
 */

export type RippleOpts = {
  /** Colour node for the surface (e.g. texture(flagTex, uv())). Falls back to `color`. */
  colorNode?: unknown;
  color?: number;
  /** Peak out-of-plane displacement in local units. */
  amp?: number;
  /** Spatial wave count across the fly. */
  freq?: number;
  /** Wave travel speed. */
  speed?: number;
  /** Phase offset (rad) — vary per panel so neighbours don't ripple in lockstep. */
  phase?: number;
  /** Pin the top edge (uv.y 1) instead of the hoist — for banners hung from a rail. */
  pinTop?: boolean;
  side?: THREE.Side;
};

/** A cloth material that ripples in the wind. Pin edge = local uv.x 0 (or the
 * top edge when `pinTop`), displacing along local +Z. */
export function rippleMaterial(opts: RippleOpts = {}): THREE.MeshLambertNodeMaterial {
  const { amp = 0.14, freq = 6, speed = 5.5, phase = 0, side = THREE.DoubleSide } = opts;
  const mat = new THREE.MeshLambertNodeMaterial({
    color: opts.color ?? 0xffffff,
    side
  });
  if (opts.colorNode) mat.colorNode = opts.colorNode as never;
  const u = uv().x;
  const v = uv().y;
  const ph = float(phase);
  // amplitude ramps from 0 at the pinned edge to full at the free fly end
  const anchor = opts.pinTop ? v.oneMinus() : u;
  // primary travelling wave + a shorter cross-ripple
  const wave = sin(u.mul(freq).sub(time.mul(speed)).add(v.mul(3)).add(ph))
    .mul(0.72)
    .add(sin(u.mul(freq * 1.9).sub(time.mul(speed * 1.35)).add(ph)).mul(0.28))
    .mul(anchor)
    .mul(amp);
  mat.positionNode = positionLocal.add(vec3(0, 0, wave));
  return mat;
}

/**
 * Wind ripple for an arbitrary loaded wing mesh (e.g. the eagle GLB's flag
 * wings), where we can't rely on a clean spanwise UV like {@link rippleMaterial}.
 * Amplitude ramps from 0 at the `shoulder` attach point out to full at the wing
 * tip (`reach` = shoulder→tip distance), so the wing stays laced to the body
 * while the trailing feathers snap. Displacement is along the surface normal so
 * the chunky feathered membrane billows regardless of how the wing is oriented.
 * Keep the mesh at raw GLB scale (positionLocal must match the baked coords used
 * to measure `shoulder`/`reach`) — never feed it a quantised geometry.
 */
export function rippleWingMaterial(opts: {
  map?: THREE.Texture;
  color?: number;
  /** Wing→body attach point in the mesh's own local space (ripple anchor, amp 0). */
  shoulder: THREE.Vector3;
  /** Farthest shoulder→tip distance in local units (normaliser for the ramp). */
  reach: number;
  /** Peak out-of-surface displacement in local units. */
  amp?: number;
  freq?: number;
  speed?: number;
  phase?: number;
  roughness?: number;
  metalness?: number;
}): THREE.MeshStandardNodeMaterial {
  const { amp = 0.08, freq = 7, speed = 4.6, phase = 0, roughness = 0.82, metalness = 0 } = opts;
  const mat = new THREE.MeshStandardNodeMaterial({ side: THREE.DoubleSide, roughness, metalness });
  if (opts.map) mat.map = opts.map;
  else if (opts.color != null) mat.color.set(opts.color);
  const sh = vec3(opts.shoulder.x, opts.shoulder.y, opts.shoulder.z);
  const invReach = float(1 / Math.max(1e-4, opts.reach));
  // 0 at the shoulder, 1 at the tip — ramps the ripple outward
  const anchor = positionLocal.sub(sh).length().mul(invReach).clamp(0, 1);
  const ph = float(phase);
  const wave = sin(anchor.mul(freq).sub(time.mul(speed)).add(ph))
    .mul(0.7)
    .add(sin(anchor.mul(freq * 2.1).sub(time.mul(speed * 1.3)).add(ph.mul(1.7))).mul(0.3))
    .mul(anchor)
    .mul(amp);
  mat.positionNode = positionLocal.add(normalLocal.mul(wave));
  return mat;
}

/**
 * A banner hung from a top rail (tailgate flag, wall drape). Plane in local XY,
 * normal +Z; pinned along the top edge and rippling toward the free bottom.
 * Orient the returned mesh so its +Z faces outward.
 */
export function buildDrape(opts: { w?: number; h?: number; seg?: number; amp?: number; speed?: number; phase?: number; map?: THREE.Texture } = {}): THREE.Mesh {
  const { w = 1.8, h = 1.15, seg = 18, amp = 0.12, speed = 4.5, phase = 0 } = opts;
  const geo = new THREE.PlaneGeometry(w, h, seg, seg);
  const map = opts.map ?? usFlagTexture();
  const mat = rippleMaterial({ colorNode: texture(map, uv()), amp, speed, phase, pinTop: true });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

/**
 * Procedural US flag on a canvas → texture. Union top-left, 7 red / 6 white
 * stripes, 50 stars in the 6-5-6-5-6-5-6-5-6 offset grid. Cached: one texture
 * feeds every flag, banner and eagle wing on the truck.
 */
let flagTex: THREE.CanvasTexture | null = null;
export function usFlagTexture(): THREE.CanvasTexture {
  if (flagTex) return flagTex;
  const W = 570;
  const H = 300;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const c = cv.getContext("2d")!;
  const red = "#b22234";
  const white = "#ffffff";
  const navy = "#3c3b6e";
  // 13 stripes
  const sh = H / 13;
  for (let i = 0; i < 13; i++) {
    c.fillStyle = i % 2 === 0 ? red : white;
    c.fillRect(0, i * sh, W, sh + 1);
  }
  // union: 7 stripes tall, 0.4 wide
  const uW = W * 0.4;
  const uH = sh * 7;
  c.fillStyle = navy;
  c.fillRect(0, 0, uW, uH);
  // 50 stars
  const star = (cx: number, cy: number, r: number) => {
    c.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = -Math.PI / 2 + (k * 2 * Math.PI) / 5;
      const a2 = a + Math.PI / 5;
      c.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      c.lineTo(cx + Math.cos(a2) * r * 0.42, cy + Math.sin(a2) * r * 0.42);
    }
    c.closePath();
    c.fill();
  };
  c.fillStyle = white;
  const r = uH * 0.05;
  for (let row = 0; row < 9; row++) {
    const cols = row % 2 === 0 ? 6 : 5;
    const offX = row % 2 === 0 ? 0 : uW / 12;
    for (let col = 0; col < cols; col++) {
      const cx = offX + (uW / 12) + (col * uW) / 6;
      const cy = (uH / 10) + (row * uH) / 10;
      star(cx, cy, r);
    }
  }
  flagTex = new THREE.CanvasTexture(cv);
  flagTex.colorSpace = THREE.SRGBColorSpace;
  flagTex.anisotropy = 4;
  return flagTex;
}

/**
 * A rippling flag panel. Local origin sits at the hoist (pole) edge, cloth
 * extends +X to `w` and is centred on Y; mount it by transforming the returned
 * mesh. `tex` defaults to the US flag; pass a phase to desync a cluster.
 */
export function buildFlag(opts: {
  w?: number;
  h?: number;
  seg?: number;
  amp?: number;
  speed?: number;
  phase?: number;
  map?: THREE.Texture;
} = {}): THREE.Mesh {
  const { w = 1.6, h = 1.0, seg = 20, amp = 0.14, speed = 5.5, phase = 0 } = opts;
  const geo = new THREE.PlaneGeometry(w, h, seg, Math.max(2, Math.round(seg * (h / w))));
  geo.translate(w / 2, 0, 0); // pole edge (uv.x 0) at local x=0
  const map = opts.map ?? usFlagTexture();
  const mat = rippleMaterial({ colorNode: texture(map, uv()), amp, speed, phase });
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  return m;
}

const BUNTING_COLORS = [0xb22234, 0xffffff, 0x3c3b6e];

/**
 * A string of triangular pennants (July-4th bunting) spanning `span` along +X,
 * gently swagged. Each pennant flutters on its own phase. Returns a group whose
 * origin is the left tie-off; mount both ends by placing/rotating the group.
 */
export function buildBunting(opts: { span?: number; count?: number; drop?: number; sag?: number } = {}): THREE.Group {
  const { span = 3.2, count = 9, drop = 0.34, sag = 0.18 } = opts;
  const g = new THREE.Group();
  const cordMat = new THREE.MeshLambertMaterial({ color: 0x241c12 });
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / (count - 1) : 0.5;
    const x = t * span;
    // catenary-ish swag: lowest in the middle
    const y = -sag * Math.sin(t * Math.PI);
    // small triangle pennant hanging point-down
    const wdt = span / count * 0.92;
    const tri = new THREE.BufferGeometry();
    tri.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([-wdt / 2, 0, 0, wdt / 2, 0, 0, 0, -drop, 0], 3)
    );
    tri.setAttribute("uv", new THREE.Float32BufferAttribute([0, 1, 1, 1, 0.5, 0], 2));
    tri.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    tri.setIndex([0, 2, 1]);
    const mat = rippleMaterial({ color: BUNTING_COLORS[i % 3], amp: 0.06, freq: 3, speed: 6.5, phase: i * 0.8 });
    const m = new THREE.Mesh(tri, mat);
    m.position.set(x, y, 0);
    g.add(m);
    // cord segment to the next pennant
    if (i > 0) {
      const px = ((i - 1) / (count - 1)) * span;
      const py = -sag * Math.sin(((i - 1) / (count - 1)) * Math.PI);
      const a = new THREE.Vector3(px, py, 0);
      const b = new THREE.Vector3(x, y, 0);
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, a.distanceTo(b), 5), cordMat);
      cord.position.copy(a).add(b).multiplyScalar(0.5);
      cord.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
      g.add(cord);
    }
  }
  return g;
}
