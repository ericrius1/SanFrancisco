import * as THREE from "three/webgpu";

/**
 * Three kites, built around what they do to light rather than what they look
 * like on the ground.
 *
 * The god-ray pass raymarches a 1024² shadow map covering 220 m — roughly
 * 0.21 m per texel — so a hollow only becomes a shaft if it is comfortably
 * wider than half a metre. Every aperture here is sized against that budget:
 * the sunwheel's eye is 2 m across, the lantern's cells and windows are
 * 0.85–1.9 m, and the blade gaps stay above 0.35 m. Detail finer than that is
 * for the eye, not for the light.
 *
 * Geometry is emitted as plain parameterised grids — rectangles and polar
 * segments — so every hole is an exact absence of triangles rather than a
 * triangulated cut or an alpha test the depth pass would have to honour.
 */

export type KiteDesignId = "diamond" | "sunwheel" | "lantern";

export type KitePalette = {
  clothDeep: number;
  clothLight: number;
  /** Emissive at grazing backlight… */
  glowLow: number;
  /** …and through the sun's own disc. */
  glowHigh: number;
  spar: number;
  hem: number;
  tailA: number;
  tailB: number;
  bows: readonly [number, number, number, number];
};

export type KiteDesign = {
  id: KiteDesignId;
  label: string;
  /** Stable scene name for the cloth mesh; QA probes match on the original. */
  clothMeshName: string;
  /** Overall span and rise, used for framing, culling and tail clearance. */
  width: number;
  height: number;
  /** Extra bounding radius so displaced cloth is never culled early. */
  cullPad: number;
  bridle: readonly [number, number, number];
  tailAnchor: readonly [number, number, number];
  /** Multiplies the tuned line length — a bigger sail wants more sky. */
  lineScale: number;
  /** How wide this silhouette throws its geometric shafts, radians. */
  raySpread: number;
  /** How much cloth this design shows; scales the transmission glow. */
  glowScale: number;
  palette: KitePalette;
  buildCloth(): THREE.BufferGeometry;
  buildFrame(context: FrameContext): THREE.Object3D[];
};

export type FrameContext = {
  /** Register a geometry for disposal with the encounter. */
  own<T extends THREE.BufferGeometry>(geometry: T): T;
  spar: THREE.Material;
  accent: THREE.Material;
  hem: THREE.Material;
};

// ---------------------------------------------------------------- builders

type ClothBuffers = {
  positions: number[];
  normals: number[];
  uvs: number[];
  /** 0 where the cloth is laced to a spar or hem, 1 in free fabric. */
  slack: number[];
  /** Where wind pressure bellies the panel out; peaks mid-panel. */
  bulge: number[];
};

function newBuffers(): ClothBuffers {
  return { positions: [], normals: [], uvs: [], slack: [], bulge: [] };
}

function smooth01(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * (3 - 2 * t);
}

/** 0 at a panel's own edge, 1 by `margin` in — the lacing falloff. */
function edgeFalloff(t: number, margin = 0.3): number {
  return smooth01(Math.min(t, 1 - t) / margin);
}

type PatchSpec = {
  nu: number;
  nv: number;
  point(u: number, v: number, out: THREE.Vector3): void;
  normal(u: number, v: number, out: THREE.Vector3): void;
  uv(u: number, v: number): [number, number];
  /** Defaults to the product of both edge falloffs. */
  slack?(u: number, v: number): number;
  /**
   * Defaults to a tent across this patch. Override when several patches tile a
   * larger shape and the tent must follow that shape's silhouette instead of
   * every internal seam — otherwise the seams show as bands.
   */
  bulge?(u: number, v: number): number;
};

const _p00 = new THREE.Vector3();
const _n00 = new THREE.Vector3();

/** Emit one parameterised quad grid as two triangles per cell. */
function emitPatch(buffers: ClothBuffers, spec: PatchSpec): void {
  const { nu, nv } = spec;
  const slackOf = spec.slack ?? ((u: number, v: number) => edgeFalloff(u) * edgeFalloff(v));
  const bulgeOf =
    spec.bulge ??
    ((u: number, v: number) => (1 - Math.abs(2 * u - 1)) * (1 - Math.abs(2 * v - 1)));
  const push = (u: number, v: number) => {
    spec.point(u, v, _p00);
    spec.normal(u, v, _n00);
    const [tu, tv] = spec.uv(u, v);
    const s = slackOf(u, v);
    buffers.positions.push(_p00.x, _p00.y, _p00.z);
    buffers.normals.push(_n00.x, _n00.y, _n00.z);
    buffers.uvs.push(tu, tv);
    buffers.slack.push(s);
    // A wide tent: 1 dead centre, 0 on every edge, smoothly graded the whole
    // way between. It is the right shape for wind pressure, and the ground
    // shadow reuses it as a penumbra — which only works because it never
    // saturates the way the lacing mask does.
    buffers.bulge.push(THREE.MathUtils.clamp(bulgeOf(u, v), 0, 1));
  };
  for (let i = 0; i < nu; i++) {
    const u0 = i / nu;
    const u1 = (i + 1) / nu;
    for (let j = 0; j < nv; j++) {
      const v0 = j / nv;
      const v1 = (j + 1) / nv;
      push(u0, v0); push(u0, v1); push(u1, v0);
      push(u1, v0); push(u0, v1); push(u1, v1);
    }
  }
}

function finishCloth(buffers: ClothBuffers, cullPad: number): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(buffers.positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(buffers.normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(buffers.uvs, 2));
  geometry.setAttribute("slack", new THREE.Float32BufferAttribute(buffers.slack, 1));
  geometry.setAttribute("bulge", new THREE.Float32BufferAttribute(buffers.bulge, 1));
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += cullPad;
  return geometry;
}

// ------------------------------------------------------------ the diamond

const DIAMOND_WIDTH = 3.5;
const DIAMOND_HEIGHT = 4.25;
const DIAMOND_SUBDIVISIONS = 9;

/**
 * The original. Four independently triangulated panels meet at the spine and
 * cross-spar; shared vertices are unnecessary because the material is smooth
 * and the duplicate seams make every attachment line exact.
 */
function diamondCloth(): THREE.BufferGeometry {
  const buffers = newBuffers();
  const corners: readonly (readonly [number, number])[] = [
    [0, DIAMOND_HEIGHT * 0.5],
    [DIAMOND_WIDTH * 0.5, 0],
    [0, -DIAMOND_HEIGHT * 0.5],
    [-DIAMOND_WIDTH * 0.5, 0]
  ];
  // The lacing mask the original shader computed analytically, baked per
  // vertex so every design can share one cloth shader.
  const push = (x: number, y: number) => {
    const nx = Math.abs(x) / (DIAMOND_WIDTH * 0.5);
    const ny = Math.abs(y) / (DIAMOND_HEIGHT * 0.5);
    const edgeRoom = 1 - (nx + ny);
    const slack =
      smooth01((nx - 0.025) / (0.34 - 0.025)) *
      smooth01((ny - 0.02) / (0.28 - 0.02)) *
      smooth01((edgeRoom - 0.01) / (0.2 - 0.01));
    buffers.positions.push(x, y, 0);
    buffers.normals.push(0, 0, 1);
    buffers.uvs.push(x / DIAMOND_WIDTH + 0.5, y / DIAMOND_HEIGHT + 0.5);
    buffers.slack.push(slack);
    buffers.bulge.push(Math.sin(nx * Math.PI) * Math.sin(ny * Math.PI));
  };
  for (let panel = 0; panel < 4; panel++) {
    const a = corners[panel];
    const b = corners[(panel + 1) % corners.length];
    const at = (i: number, j: number): [number, number] => {
      const u = i / DIAMOND_SUBDIVISIONS;
      const v = j / DIAMOND_SUBDIVISIONS;
      return [a[0] * u + b[0] * v, a[1] * u + b[1] * v];
    };
    for (let i = 0; i < DIAMOND_SUBDIVISIONS; i++) {
      for (let j = 0; j < DIAMOND_SUBDIVISIONS - i; j++) {
        const p00 = at(i, j);
        const p10 = at(i + 1, j);
        const p01 = at(i, j + 1);
        // +Z winding matches the authored normal and the flyer-facing side.
        push(p00[0], p00[1]);
        push(p01[0], p01[1]);
        push(p10[0], p10[1]);
        if (j < DIAMOND_SUBDIVISIONS - i - 1) {
          const p11 = at(i + 1, j + 1);
          push(p10[0], p10[1]);
          push(p01[0], p01[1]);
          push(p11[0], p11[1]);
        }
      }
    }
  }
  return finishCloth(buffers, 1.35);
}

function diamondFrame(ctx: FrameContext): THREE.Object3D[] {
  const spineGeometry = ctx.own(
    new THREE.CylinderGeometry(0.035, 0.045, DIAMOND_HEIGHT * 0.98, 8)
  );
  const spine = new THREE.Mesh(spineGeometry, ctx.spar);
  spine.name = "kite_spine";
  spine.position.z = 0.045;

  const crossGeometry = ctx.own(
    new THREE.CylinderGeometry(0.032, 0.032, DIAMOND_WIDTH * 0.98, 8)
  );
  crossGeometry.rotateZ(Math.PI / 2);
  const cross = new THREE.Mesh(crossGeometry, ctx.spar);
  cross.name = "kite_cross_spar";
  cross.position.set(0, 0.08, 0.055);

  const hemGeometry = ctx.own(new THREE.BufferGeometry());
  hemGeometry.setFromPoints([
    new THREE.Vector3(0, DIAMOND_HEIGHT * 0.5, 0.02),
    new THREE.Vector3(DIAMOND_WIDTH * 0.5, 0, 0.02),
    new THREE.Vector3(0, -DIAMOND_HEIGHT * 0.5, 0.02),
    new THREE.Vector3(-DIAMOND_WIDTH * 0.5, 0, 0.02),
    new THREE.Vector3(0, DIAMOND_HEIGHT * 0.5, 0.02)
  ]);
  const hem = new THREE.Line(hemGeometry, ctx.hem);
  hem.name = "kite_sewn_hem";

  return [spine, cross, hem];
}

// ----------------------------------------------------------- the sunwheel

const WHEEL_OUTER = 2.24;
const WHEEL_INNER = 1.02;
const WHEEL_BLADES = 6;
/** Fraction of each blade's pitch given over to the gap beside it. */
const WHEEL_GAP = 0.19;
/** How far the inner edge tips toward the flyer — a shallow funnel. */
const WHEEL_CONE = 0.34;

/**
 * A rotor of six sails around a two-metre eye. Shine a low sun straight down
 * its axis and the eye passes a clean core of light while the blades throw six
 * spokes of shadow that sweep as the kite rolls — the whole point of the shape.
 */
function sunwheelCloth(): THREE.BufferGeometry {
  const buffers = newBuffers();
  const pitch = (Math.PI * 2) / WHEEL_BLADES;
  const arc = pitch * (1 - WHEEL_GAP);
  const span = WHEEL_OUTER * 2;
  const radiusAt = (v: number) => THREE.MathUtils.lerp(WHEEL_INNER, WHEEL_OUTER, v);
  // z(r) is a quadratic funnel; its slope gives the authored normal so the
  // cone is lit as a cone rather than as a flat disc.
  const zAt = (v: number) => WHEEL_CONE * (1 - v) * (1 - v);

  for (let blade = 0; blade < WHEEL_BLADES; blade++) {
    const start = blade * pitch + pitch * WHEEL_GAP * 0.5;
    emitPatch(buffers, {
      nu: 9,
      nv: 7,
      point: (u, v, out) => {
        const angle = start + arc * u;
        const r = radiusAt(v);
        out.set(Math.cos(angle) * r, Math.sin(angle) * r, zAt(v));
      },
      normal: (u, v, out) => {
        const angle = start + arc * u;
        const slope = (-2 * WHEEL_CONE * (1 - v)) / (WHEEL_OUTER - WHEEL_INNER);
        out.set(-Math.cos(angle) * slope, -Math.sin(angle) * slope, 1).normalize();
      },
      uv: (u, v) => {
        const angle = start + arc * u;
        const r = radiusAt(v);
        return [(Math.cos(angle) * r) / span + 0.5, (Math.sin(angle) * r) / span + 0.5];
      },
      // Laced along both radial spokes and to the two hoops.
      slack: (u, v) => edgeFalloff(u, 0.26) * edgeFalloff(v, 0.34)
    });
  }
  return finishCloth(buffers, 1.1);
}

function sunwheelFrame(ctx: FrameContext): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  const outerHoop = new THREE.Mesh(
    ctx.own(new THREE.TorusGeometry(WHEEL_OUTER, 0.036, 6, 40)),
    ctx.spar
  );
  outerHoop.name = "kite_outer_hoop";
  const innerHoop = new THREE.Mesh(
    ctx.own(new THREE.TorusGeometry(WHEEL_INNER, 0.03, 6, 28)),
    ctx.spar
  );
  innerHoop.name = "kite_inner_hoop";
  innerHoop.position.z = WHEEL_CONE;
  parts.push(outerHoop, innerHoop);

  // One spoke per blade gap, so the sails hang between spokes rather than
  // across them and the gaps stay honest holes.
  const spokeLength = Math.hypot(WHEEL_OUTER - WHEEL_INNER, WHEEL_CONE);
  const spokeGeometry = ctx.own(new THREE.CylinderGeometry(0.026, 0.03, spokeLength, 6));
  const pitch = (Math.PI * 2) / WHEEL_BLADES;
  for (let i = 0; i < WHEEL_BLADES; i++) {
    const angle = i * pitch;
    const spoke = new THREE.Mesh(spokeGeometry, ctx.spar);
    spoke.name = `kite_spoke_${i}`;
    const midRadius = (WHEEL_INNER + WHEEL_OUTER) * 0.5;
    spoke.position.set(Math.cos(angle) * midRadius, Math.sin(angle) * midRadius, WHEEL_CONE * 0.25);
    // The cylinder runs along local +Y; aim it outward along the cone slope.
    spoke.rotation.z = angle - Math.PI / 2;
    parts.push(spoke);
  }

  const hub = new THREE.Mesh(ctx.own(new THREE.TorusGeometry(0.16, 0.05, 6, 12)), ctx.accent);
  hub.name = "kite_hub";
  hub.position.z = WHEEL_CONE + 0.34;
  parts.push(hub);

  // Three tensioners from the hub ring out to the rim — the eye stays open.
  const stayPoints: THREE.Vector3[] = [];
  for (let i = 0; i < 3; i++) {
    const angle = (i / 3) * Math.PI * 2 + 0.5;
    stayPoints.push(new THREE.Vector3(0, 0, WHEEL_CONE + 0.34));
    stayPoints.push(
      new THREE.Vector3(Math.cos(angle) * WHEEL_OUTER, Math.sin(angle) * WHEEL_OUTER, 0)
    );
  }
  const stays = new THREE.LineSegments(
    ctx.own(new THREE.BufferGeometry().setFromPoints(stayPoints)),
    ctx.hem
  );
  stays.name = "kite_hub_stays";
  parts.push(stays);
  return parts;
}

// ------------------------------------------------------------ the lantern

const CELL_SIDE = 2.2;
const CELL_DEPTH = 1.25;
/** Open air between the two cells — the widest single aperture on the kite. */
const CELL_GAP = 1;
const WINDOW_W = 0.98;
const WINDOW_H = 0.62;

/**
 * A two-cell Hargrave box, each face pierced by a square window. It flies with
 * its axis pointing at the flyer, which at this beach is straight into the
 * setting sun — so the sun looks right down the barrel and the shadow becomes
 * two square annuli with a lit core, punched through by eight windows.
 */
function lanternCloth(): THREE.BufferGeometry {
  const buffers = newBuffers();
  const half = CELL_SIDE * 0.5;
  const span = CELL_SIDE * 2;
  const cellFronts = [CELL_GAP * 0.5, -CELL_GAP * 0.5 - CELL_DEPTH];

  // A pierced face is four border strips, so the window is an exact absence of
  // triangles that the depth pass gets for free.
  const emitPiercedFace = (
    z0: number,
    place: (a: number, b: number, out: THREE.Vector3) => void,
    normal: readonly [number, number, number]
  ) => {
    const aHalf = half;
    const bHalf = CELL_DEPTH * 0.5;
    const wHalf = WINDOW_W * 0.5;
    const hHalf = Math.min(WINDOW_H, CELL_DEPTH * 0.72) * 0.5;
    const strips: readonly (readonly [number, number, number, number])[] = [
      [-aHalf, aHalf, hHalf, bHalf],
      [-aHalf, aHalf, -bHalf, -hHalf],
      [-aHalf, -wHalf, -hHalf, hHalf],
      [wHalf, aHalf, -hHalf, hHalf]
    ];
    for (const [a0, a1, b0, b1] of strips) {
      emitPatch(buffers, {
        nu: 5,
        nv: 5,
        point: (u, v, out) =>
          place(THREE.MathUtils.lerp(a0, a1, u), z0 + THREE.MathUtils.lerp(b0, b1, v), out),
        normal: (_u, _v, out) => out.set(normal[0], normal[1], normal[2]),
        uv: (u, v) => [THREE.MathUtils.lerp(a0, a1, u) / span + 0.5, THREE.MathUtils.lerp(b0, b1, v) / span + 0.5]
      });
    }
  };

  for (const front of cellFronts) {
    const mid = front + CELL_DEPTH * 0.5;
    emitPiercedFace(mid, (a, b, out) => out.set(a, half, b), [0, 1, 0]);
    emitPiercedFace(mid, (a, b, out) => out.set(a, -half, b), [0, -1, 0]);
    emitPiercedFace(mid, (a, b, out) => out.set(half, a, b), [1, 0, 0]);
    emitPiercedFace(mid, (a, b, out) => out.set(-half, a, b), [-1, 0, 0]);
  }
  return finishCloth(buffers, 1.2);
}

function lanternFrame(ctx: FrameContext): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  const half = CELL_SIDE * 0.5;
  const depth = CELL_GAP + CELL_DEPTH * 2;

  const longeronGeometry = ctx.own(new THREE.CylinderGeometry(0.026, 0.026, depth, 6));
  longeronGeometry.rotateX(Math.PI / 2);
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const longeron = new THREE.Mesh(longeronGeometry, ctx.spar);
      longeron.name = `kite_longeron_${sx}_${sy}`;
      longeron.position.set(sx * half, sy * half, 0);
      parts.push(longeron);
    }
  }

  // Square frames at each cell mouth; these are what hold the box open.
  const strutGeometry = ctx.own(new THREE.CylinderGeometry(0.022, 0.022, CELL_SIDE, 6));
  const rings = [
    CELL_GAP * 0.5,
    CELL_GAP * 0.5 + CELL_DEPTH,
    -CELL_GAP * 0.5,
    -CELL_GAP * 0.5 - CELL_DEPTH
  ];
  for (let r = 0; r < rings.length; r++) {
    for (const [sx, sy, vertical] of [
      [0, 1, false],
      [0, -1, false],
      [1, 0, true],
      [-1, 0, true]
    ] as const) {
      const strut = new THREE.Mesh(strutGeometry, ctx.accent);
      strut.name = `kite_strut_${r}_${sx}_${sy}`;
      strut.position.set(sx * half, sy * half, rings[r]);
      if (!vertical) strut.rotation.z = Math.PI / 2;
      parts.push(strut);
    }
  }
  return parts;
}

// ----------------------------------------------------------------- designs

export const KITE_DESIGNS: Readonly<Record<KiteDesignId, KiteDesign>> = {
  diamond: {
    id: "diamond",
    label: "purple diamond",
    clothMeshName: "ocean_beach_purple_kite_gpu_cloth",
    width: DIAMOND_WIDTH,
    height: DIAMOND_HEIGHT,
    cullPad: 1.35,
    bridle: [0, -0.12, 0.58],
    tailAnchor: [0, -DIAMOND_HEIGHT * 0.5, 0.02],
    lineScale: 1,
    raySpread: 0.11,
    glowScale: 1,
    palette: {
      clothDeep: 0x4b1f91,
      clothLight: 0xa766ef,
      glowLow: 0x7d2ea8,
      glowHigh: 0xd8409a,
      spar: 0x5d3a24,
      hem: 0xd5a6ff,
      tailA: 0x9a4ae0,
      tailB: 0xffc8f0,
      bows: [0xf0d27a, 0xd08cf5, 0xffb27a, 0xa26be0]
    },
    buildCloth: diamondCloth,
    buildFrame: diamondFrame
  },
  sunwheel: {
    id: "sunwheel",
    label: "teal sunwheel",
    clothMeshName: "ocean_beach_sunwheel_kite_gpu_cloth",
    width: WHEEL_OUTER * 2,
    height: WHEEL_OUTER * 2,
    cullPad: 1.1,
    bridle: [0, -0.1, WHEEL_CONE + 0.92],
    tailAnchor: [0, -WHEEL_OUTER, 0.02],
    lineScale: 1.12,
    // Six blades want a wider fan than a solid diamond: the shafts should read
    // as spokes leaving the rim, not as one bloom off the middle.
    raySpread: 0.2,
    glowScale: 1.15,
    palette: {
      clothDeep: 0x0c4d5e,
      clothLight: 0x46d4c6,
      glowLow: 0x1f8f9c,
      glowHigh: 0x8ffbe2,
      spar: 0x4a3524,
      hem: 0x9ff3e4,
      tailA: 0x1f9fae,
      tailB: 0xc8fff2,
      bows: [0xffd98a, 0x59e0cf, 0xa9f7ea, 0x1c7f8c]
    },
    buildCloth: sunwheelCloth,
    buildFrame: sunwheelFrame
  },
  lantern: {
    id: "lantern",
    label: "crimson lantern",
    clothMeshName: "ocean_beach_lantern_kite_gpu_cloth",
    width: CELL_SIDE * 1.42,
    height: CELL_SIDE * 1.42,
    cullPad: 1.2,
    bridle: [0, -0.3, CELL_GAP * 0.5 + CELL_DEPTH + 0.72],
    tailAnchor: [0, -CELL_SIDE * 0.5, -CELL_GAP * 0.5 - CELL_DEPTH],
    lineScale: 0.94,
    // A box throws hard-edged bars rather than a spray; keep the fan tight so
    // the shafts read as the windows they came through.
    raySpread: 0.075,
    glowScale: 1.3,
    palette: {
      clothDeep: 0x7a1230,
      clothLight: 0xff7a4e,
      glowLow: 0xc4321f,
      glowHigh: 0xffd08a,
      spar: 0x241a12,
      hem: 0xffb08a,
      tailA: 0xd93b32,
      tailB: 0xffd9a8,
      bows: [0xffd07a, 0xe4553c, 0xffb27a, 0x8f1f2e]
    },
    buildCloth: lanternCloth,
    buildFrame: lanternFrame
  }
};

/** Presentation order along the beach: the original first. */
export const KITE_DESIGN_ORDER: readonly KiteDesignId[] = ["diamond", "sunwheel", "lantern"];
