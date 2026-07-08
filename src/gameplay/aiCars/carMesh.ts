/**
 * Procedural low-poly cars for the AI fleet.
 *
 * Same merged-box + baked-vertex-color recipe as src/gameplay/traffic.ts, but
 * these are a VARIETY pack: six distinct silhouettes, each painted from a hue.
 * Geometry is cached per (bodyKind, hueBucket) so 24 cars share a handful of
 * BufferGeometries and exactly three materials (body / glow / tyre) — no
 * per-car material clones, no THREE.Light objects (LightPool constraint).
 *
 * Convention (LOCKED): group origin sits at the wheel-contact centre, +Z is
 * forward (headlights at +Z, tail lights at -Z). The four wheels are separate
 * un-merged meshes named wheel_fl / wheel_fr / wheel_rl / wheel_rr so the fleet
 * can spin them on their local X axis.
 */

import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { LIGHT_SCALE } from "../../config";

/** Number of body variants. */
export const BODY_KINDS = 6;

const HUE_BUCKETS = 12;

type BoxSpec = { w: number; h: number; d: number; x: number; y: number; z: number; c: number; rx?: number };

// Shared, module-level materials — every car reuses these three.
const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.22 });
const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true });
glowMat.color.setScalar(LIGHT_SCALE); // lift unlit lamps into the photometric scale
const tyreMat = new THREE.MeshStandardMaterial({ color: 0x121216, roughness: 0.85, metalness: 0.05 });

const HEAD = 0xfff2c0;
const TAIL = 0xff2818;
const GLASS = 0x11202c;
const TRIM = 0x23262c;

function buildGeo(boxes: BoxSpec[]): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  for (const b of boxes) {
    const g = new THREE.BoxGeometry(b.w, b.h, b.d);
    if (b.rx) g.rotateX(b.rx);
    g.translate(b.x, b.y, b.z);
    color.setHex(b.c);
    const n = g.getAttribute("position").count;
    const colors = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    parts.push(g);
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Paint colour for a (kind, bucket). Most buckets are a saturated hue; a couple
 * of buckets per kind become white / black / silver so the fleet isn't a rainbow
 * of only mid-tones. Saturation & lightness bands vary by body kind so a van
 * reads muted and a muscle car reads deep and glossy.
 */
function paintFor(kind: number, bucket: number): number {
  const hue = (bucket + 0.5) / HUE_BUCKETS;
  // a few neutral slots so the fleet isn't a pure rainbow (3 of 12 buckets)
  if (bucket === 0) return 0xf1f2f4; // pearl white
  if (bucket === 6) return 0x181a1f; // near black
  if (bucket === 11) return 0x9aa0a8; // silver
  const bands: Array<[number, number]> = [
    [0.62, 0.5], // sedan  — classic
    [0.85, 0.52], // coupe  — vivid
    [0.9, 0.62], // hatch  — bright/light
    [0.55, 0.45], // pickup — muted
    [0.35, 0.66], // van    — pale/desaturated
    [0.8, 0.38] // muscle — deep & dark
  ];
  const [s, l] = bands[kind] ?? [0.7, 0.5];
  return new THREE.Color().setHSL(hue, s, l).getHex();
}

type Layout = {
  body: BoxSpec[];
  glow: BoxSpec[];
  wheels: Array<[number, number]>; // [x, z] contact positions
  wheelR: number;
  wheelW: number;
};

// ---- Body kinds (front = +Z) --------------------------------------------

function sedan(p: number): Layout {
  const wr = 0.34;
  return {
    body: [
      { w: 1.98, h: 0.5, d: 4.3, x: 0, y: wr + 0.28, z: 0, c: p },
      { w: 1.86, h: 0.46, d: 2.0, x: 0, y: wr + 0.72, z: -0.1, c: p }, // greenhouse
      { w: 1.68, h: 0.4, d: 1.86, x: 0, y: wr + 0.74, z: -0.1, c: GLASS },
      { w: 1.9, h: 0.16, d: 0.5, x: 0, y: wr + 0.16, z: 2.05, c: p }, // hood lip
      { w: 1.9, h: 0.16, d: 0.5, x: 0, y: wr + 0.16, z: -2.05, c: p } // boot
    ],
    glow: [
      { w: 0.42, h: 0.16, d: 0.06, x: -0.66, y: wr + 0.12, z: 2.16, c: HEAD },
      { w: 0.42, h: 0.16, d: 0.06, x: 0.66, y: wr + 0.12, z: 2.16, c: HEAD },
      { w: 0.46, h: 0.14, d: 0.06, x: -0.62, y: wr + 0.16, z: -2.16, c: TAIL },
      { w: 0.46, h: 0.14, d: 0.06, x: 0.62, y: wr + 0.16, z: -2.16, c: TAIL }
    ],
    wheels: [
      [-0.98, 1.42],
      [0.98, 1.42],
      [-0.98, -1.42],
      [0.98, -1.42]
    ],
    wheelR: wr,
    wheelW: 0.28
  };
}

function coupe(p: number): Layout {
  const wr = 0.33;
  return {
    body: [
      { w: 1.94, h: 0.42, d: 4.24, x: 0, y: wr + 0.2, z: 0, c: p }, // low slab
      { w: 1.7, h: 0.4, d: 1.6, x: 0, y: wr + 0.56, z: -0.3, c: p }, // fastback cabin
      { w: 1.5, h: 0.34, d: 1.5, x: 0, y: wr + 0.58, z: -0.15, c: GLASS },
      { w: 1.9, h: 0.12, d: 1.2, x: 0, y: wr + 0.06, z: 1.5, c: p }, // long nose
      { w: 1.86, h: 0.1, d: 0.28, x: 0, y: wr + 0.62, z: -2.12, c: TRIM }, // spoiler blade
      { w: 0.14, h: 0.28, d: 0.3, x: -0.72, y: wr + 0.48, z: -2.1, c: TRIM }, // spoiler strut
      { w: 0.14, h: 0.28, d: 0.3, x: 0.72, y: wr + 0.48, z: -2.1, c: TRIM }
    ],
    glow: [
      { w: 0.5, h: 0.1, d: 0.06, x: -0.6, y: wr + 0.16, z: 2.14, c: HEAD },
      { w: 0.5, h: 0.1, d: 0.06, x: 0.6, y: wr + 0.16, z: 2.14, c: HEAD },
      { w: 1.5, h: 0.09, d: 0.05, x: 0, y: wr + 0.2, z: -2.14, c: TAIL } // full-width bar
    ],
    wheels: [
      [-0.97, 1.46],
      [0.97, 1.46],
      [-0.97, -1.4],
      [0.97, -1.4]
    ],
    wheelR: wr + 0.03,
    wheelW: 0.3
  };
}

function hatch(p: number): Layout {
  const wr = 0.33;
  return {
    body: [
      { w: 1.78, h: 0.5, d: 3.2, x: 0, y: wr + 0.24, z: 0, c: p },
      { w: 1.72, h: 0.6, d: 1.9, x: 0, y: wr + 0.66, z: -0.25, c: p }, // tall rounded cabin
      { w: 1.56, h: 0.46, d: 1.7, x: 0, y: wr + 0.72, z: -0.2, c: GLASS },
      { w: 1.6, h: 0.34, d: 0.5, x: 0, y: wr + 0.5, z: 1.5, c: p } // stubby nose
    ],
    glow: [
      { w: 0.36, h: 0.2, d: 0.06, x: -0.6, y: wr + 0.34, z: 1.62, c: HEAD },
      { w: 0.36, h: 0.2, d: 0.06, x: 0.6, y: wr + 0.34, z: 1.62, c: HEAD },
      { w: 0.34, h: 0.24, d: 0.06, x: -0.66, y: wr + 0.38, z: -1.62, c: TAIL },
      { w: 0.34, h: 0.24, d: 0.06, x: 0.66, y: wr + 0.38, z: -1.62, c: TAIL }
    ],
    wheels: [
      [-0.86, 1.0],
      [0.86, 1.0],
      [-0.86, -1.05],
      [0.86, -1.05]
    ],
    wheelR: wr,
    wheelW: 0.28
  };
}

function pickup(p: number): Layout {
  const wr = 0.4;
  const bed = 0x2a2d33;
  return {
    body: [
      { w: 2.0, h: 0.56, d: 4.6, x: 0, y: wr + 0.3, z: 0, c: p }, // chassis/body
      { w: 1.96, h: 0.62, d: 1.7, x: 0, y: wr + 0.82, z: 1.0, c: p }, // cab
      { w: 1.78, h: 0.44, d: 1.4, x: 0, y: wr + 0.86, z: 1.05, c: GLASS },
      { w: 1.9, h: 0.5, d: 1.9, x: 0, y: wr + 0.5, z: -1.4, c: bed }, // bed interior
      { w: 2.0, h: 0.66, d: 0.16, x: 0, y: wr + 0.42, z: -2.28, c: p }, // tailgate
      { w: 0.12, h: 0.4, d: 1.9, x: -0.94, y: wr + 0.5, z: -1.4, c: p }, // bed side L
      { w: 0.12, h: 0.4, d: 1.9, x: 0.94, y: wr + 0.5, z: -1.4, c: p } // bed side R
    ],
    glow: [
      { w: 0.44, h: 0.24, d: 0.06, x: -0.66, y: wr + 0.3, z: 2.32, c: HEAD },
      { w: 0.44, h: 0.24, d: 0.06, x: 0.66, y: wr + 0.3, z: 2.32, c: HEAD },
      { w: 0.4, h: 0.2, d: 0.06, x: -0.7, y: wr + 0.3, z: -2.36, c: TAIL },
      { w: 0.4, h: 0.2, d: 0.06, x: 0.7, y: wr + 0.3, z: -2.36, c: TAIL }
    ],
    wheels: [
      [-1.0, 1.5],
      [1.0, 1.5],
      [-1.0, -1.5],
      [1.0, -1.5]
    ],
    wheelR: wr,
    wheelW: 0.34
  };
}

function van(p: number): Layout {
  const wr = 0.36;
  return {
    body: [
      { w: 2.1, h: 1.5, d: 4.7, x: 0, y: wr + 0.78, z: -0.2, c: p }, // tall box
      { w: 2.06, h: 0.6, d: 1.0, x: 0, y: wr + 1.1, z: 1.9, c: GLASS }, // windshield
      { w: 2.14, h: 0.5, d: 1.2, x: 0, y: wr + 0.9, z: -0.4, c: GLASS }, // side glass strip
      { w: 2.02, h: 0.4, d: 0.6, x: 0, y: wr + 0.4, z: 2.28, c: p } // sloped nose cap
    ],
    glow: [
      { w: 0.4, h: 0.22, d: 0.06, x: -0.72, y: wr + 0.36, z: 2.48, c: HEAD },
      { w: 0.4, h: 0.22, d: 0.06, x: 0.72, y: wr + 0.36, z: 2.48, c: HEAD },
      { w: 0.34, h: 0.5, d: 0.06, x: -0.82, y: wr + 0.6, z: -2.5, c: TAIL },
      { w: 0.34, h: 0.5, d: 0.06, x: 0.82, y: wr + 0.6, z: -2.5, c: TAIL }
    ],
    wheels: [
      [-1.02, 1.55],
      [1.02, 1.55],
      [-1.02, -1.55],
      [1.02, -1.55]
    ],
    wheelR: wr,
    wheelW: 0.32
  };
}

function muscle(p: number): Layout {
  const wr = 0.36;
  return {
    body: [
      { w: 2.06, h: 0.4, d: 4.8, x: 0, y: wr + 0.14, z: 0, c: p }, // long low body
      { w: 1.78, h: 0.36, d: 1.5, x: 0, y: wr + 0.5, z: -0.55, c: p }, // chopped roof
      { w: 1.58, h: 0.3, d: 1.4, x: 0, y: wr + 0.52, z: -0.5, c: GLASS },
      { w: 2.0, h: 0.14, d: 1.7, x: 0, y: wr + 0.36, z: 1.4, c: p }, // long hood
      { w: 0.5, h: 0.16, d: 0.7, x: 0, y: wr + 0.48, z: 1.4, c: TRIM }, // hood scoop
      { w: 2.08, h: 0.12, d: 4.2, x: 0, y: wr - 0.12, z: 0, c: TRIM } // low rocker (lowrider)
    ],
    glow: [
      { w: 0.4, h: 0.12, d: 0.06, x: -0.66, y: wr + 0.12, z: 2.36, c: HEAD },
      { w: 0.4, h: 0.12, d: 0.06, x: 0.66, y: wr + 0.12, z: 2.36, c: HEAD },
      { w: 0.38, h: 0.16, d: 0.06, x: -0.66, y: wr + 0.16, z: -2.36, c: TAIL },
      { w: 0.38, h: 0.16, d: 0.06, x: 0.66, y: wr + 0.16, z: -2.36, c: TAIL }
    ],
    wheels: [
      [-1.0, 1.62],
      [1.0, 1.62],
      [-1.0, -1.58],
      [1.0, -1.58]
    ],
    wheelR: wr,
    wheelW: 0.36
  };
}

const LAYOUTS: Array<(p: number) => Layout> = [sedan, coupe, hatch, pickup, van, muscle];

type CarGeo = { body: THREE.BufferGeometry; glow: THREE.BufferGeometry; wheel: THREE.BufferGeometry; layout: Layout };
const geoCache = new Map<string, CarGeo>();
const wheelGeoCache = new Map<string, THREE.BufferGeometry>();

function wheelGeo(r: number, w: number): THREE.BufferGeometry {
  const key = `${r.toFixed(2)}_${w.toFixed(2)}`;
  let g = wheelGeoCache.get(key);
  if (!g) {
    // Cylinder axis defaults to Y; rotate so it points along X → spins on local X.
    g = new THREE.CylinderGeometry(r, r, w, 6, 1);
    g.rotateZ(Math.PI / 2);
    wheelGeoCache.set(key, g);
  }
  return g;
}

function carGeo(kind: number, bucket: number): CarGeo {
  const key = `${kind}_${bucket}`;
  let geo = geoCache.get(key);
  if (!geo) {
    const layout = LAYOUTS[kind](paintFor(kind, bucket));
    geo = {
      body: buildGeo(layout.body),
      glow: buildGeo(layout.glow),
      wheel: wheelGeo(layout.wheelR, layout.wheelW),
      layout
    };
    geoCache.set(key, geo);
  }
  return geo;
}

// Layout.wheels entries are ordered [-x front, +x front, -x rear, +x rear],
// i.e. front-left, front-right, rear-left, rear-right.
const WHEEL_NAMES = ["wheel_fl", "wheel_fr", "wheel_rl", "wheel_rr"] as const;

/**
 * Build one car. `bodyKind` picks the silhouette (0..BODY_KINDS-1), `paintHue`
 * (0..1) picks the paint. Geometry is shared across every car of the same
 * (kind, hue-bucket); only the Group and four wheel Meshes are fresh objects.
 */
export function buildCarMesh(bodyKind: number, paintHue: number): THREE.Group {
  const kind = ((bodyKind % BODY_KINDS) + BODY_KINDS) % BODY_KINDS;
  const bucket = Math.min(HUE_BUCKETS - 1, Math.max(0, Math.floor(paintHue * HUE_BUCKETS)));
  const geo = carGeo(kind, bucket);

  const group = new THREE.Group();
  const body = new THREE.Mesh(geo.body, bodyMat);
  body.castShadow = true;
  group.add(body);
  group.add(new THREE.Mesh(geo.glow, glowMat));

  const wr = geo.layout.wheelR;
  for (let i = 0; i < 4; i++) {
    const [x, z] = geo.layout.wheels[i];
    // wheels ordered fl, fr, rl, rr to match WHEEL_NAMES (front = +z)
    const wheel = new THREE.Mesh(geo.wheel, tyreMat);
    wheel.castShadow = true;
    wheel.position.set(x, wr, z);
    wheel.name = WHEEL_NAMES[i];
    group.add(wheel);
  }

  group.userData.bodyKind = kind;
  return group;
}
