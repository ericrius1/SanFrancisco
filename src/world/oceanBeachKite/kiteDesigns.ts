import * as THREE from "three/webgpu";

/**
 * Six kites, built around what they do to light rather than what they look
 * like on the ground. Five of them cut it; the prism bends it.
 *
 * The god-ray pass raymarches a 1024² shadow map covering 220 m — roughly
 * 0.21 m per texel — so a hollow only becomes a shaft if it is comfortably
 * wider than half a metre. Every aperture here is sized against that budget:
 * the sunwheel's eye is 2 m across, the lantern's cells and windows are
 * 0.85–1.9 m, the sled's vents are 0.95 m wide, the centipede's pupils
 * 0.92–1.10 m, the prism's eye is 2.1 m on a side over slots 0.58 m wide, and
 * no blade gap drops under 0.35 m. Detail finer than that is for the eye, not
 * for the light.
 *
 * Geometry is emitted as plain parameterised grids — rectangles and polar
 * segments — so every hole is an exact absence of triangles rather than a
 * triangulated cut or an alpha test the depth pass would have to honour.
 */

export type KiteDesignId =
  | "diamond"
  | "sunwheel"
  | "lantern"
  | "sled"
  | "centipede"
  | "prism";

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
  /**
   * This sail disperses rather than occludes. A spectral design is deliberately
   * kept OUT of both shadow paths — it casts nothing, so the shared warm fan in
   * `sunsetAir` and the raymarched god-ray pass have nothing of it to carve —
   * and `prismLight` gives it a rainbow of its own instead. The cloth shader
   * also lays a spectrum across the sail itself.
   */
  spectral?: boolean;
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

// ---------------------------------------------------------------- the sled

/**
 * Light does not leave a kite along its local +Z. `flyer.ts` aims local +Z at
 * the flyer, and with the site's offshore wind and a sun on the water the sun
 * ray runs through the sail at roughly (0, 0.72, 0.70) local — about 46° off
 * +Z, tilted in the YZ plane.
 *
 * That asymmetry is a design tool. A hole's width along local X does not
 * foreshorten at all when the kite is centred in its window — which is exactly
 * the moment `sunsetAir` scores highest — while its height foreshortens by
 * cos 46° ≈ 0.70. So the sled's apertures are TALL VERTICAL SLOTS: they keep
 * their full width through the money beat and pinch shut only at the swing
 * extremes, which makes the doorway of light open and close as the kite comes
 * through the middle.
 */
const SLED_RADIUS = 4;
const SLED_HALF_ANGLE = 0.55;
const SLED_TOP = 2;
const SLED_VENT_TOP = 1.4;
const SLED_VENT_BOTTOM = -0.75;
/** Developed-span coordinates of the six panel edges. */
const SLED_EDGES = [0, 0.1932, 0.4091, 0.5909, 0.8068, 1] as const;

/** Trailing V bitten out of the belly; deepest at the centre. */
function sledBottom(u: number): number {
  return -1.3 - 0.7 * Math.abs(2 * u - 1);
}

function sledPoint(u: number, y: number, out: THREE.Vector3): void {
  const a = (u - 0.5) * SLED_HALF_ANGLE * 2;
  out.set(SLED_RADIUS * Math.sin(a), y, SLED_RADIUS * (1 - Math.cos(a)));
}

/**
 * A vented sled: no cross spar at all, held open by the wind alone. One bowed
 * wall of pale ripstop with two tall slots burnt through it.
 */
function sledCloth(): THREE.BufferGeometry {
  const buffers = newBuffers();
  // The tent has to span the WHOLE sail, not each panel: six seams feathered
  // individually would band the sail and its shadow (see PatchSpec.bulge).
  const tent = (u: number, y: number) =>
    Math.sin(Math.PI * u) *
    smooth01((y - sledBottom(u)) / 0.9) *
    smooth01((SLED_TOP - y) / 0.9);

  const panel = (
    u0: number,
    u1: number,
    lo: (u: number) => number,
    hi: (u: number) => number,
    nu: number,
    nv: number
  ) => {
    const at = (pu: number, pv: number): [number, number] => {
      const u = THREE.MathUtils.lerp(u0, u1, pu);
      return [u, THREE.MathUtils.lerp(lo(u), hi(u), pv)];
    };
    emitPatch(buffers, {
      nu,
      nv,
      point: (pu, pv, out) => {
        const [u, y] = at(pu, pv);
        sledPoint(u, y, out);
      },
      normal: (pu, _pv, out) => {
        const a = (THREE.MathUtils.lerp(u0, u1, pu) - 0.5) * SLED_HALF_ANGLE * 2;
        out.set(-Math.sin(a), 0, Math.cos(a));
      },
      uv: (pu, pv) => {
        const [u, y] = at(pu, pv);
        return [(u - 0.5) + 0.5, (y + 2) / 4];
      },
      bulge: (pu, pv) => {
        const [u, y] = at(pu, pv);
        return tent(u, y);
      }
    });
  };

  const top = () => SLED_TOP;
  // Outer panels and the centre band run the full height; the two vent columns
  // are split above and below the slot, which is what leaves the slot empty.
  panel(SLED_EDGES[0], SLED_EDGES[1], sledBottom, top, 5, 10);
  panel(SLED_EDGES[1], SLED_EDGES[2], () => SLED_VENT_TOP, top, 6, 3);
  panel(SLED_EDGES[1], SLED_EDGES[2], sledBottom, () => SLED_VENT_BOTTOM, 6, 4);
  panel(SLED_EDGES[2], SLED_EDGES[3], sledBottom, top, 5, 10);
  panel(SLED_EDGES[3], SLED_EDGES[4], () => SLED_VENT_TOP, top, 6, 3);
  panel(SLED_EDGES[3], SLED_EDGES[4], sledBottom, () => SLED_VENT_BOTTOM, 6, 4);
  panel(SLED_EDGES[4], SLED_EDGES[5], sledBottom, top, 5, 10);
  return finishCloth(buffers, 1.5);
}

function sledFrame(ctx: FrameContext): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  // The bow curves only in XZ and a cylinder's native axis is +Y, so all three
  // spars share one geometry and need no rotation whatsoever.
  const sparGeometry = ctx.own(new THREE.CylinderGeometry(0.026, 0.026, 4.02, 8));
  const pocketGeometry = ctx.own(new THREE.BoxGeometry(0.1, 0.05, 0.05));
  const at = new THREE.Vector3();
  for (const u of [0, 0.5, 1]) {
    sledPoint(u, 0, at);
    const spar = new THREE.Mesh(sparGeometry, ctx.spar);
    spar.name = `kite_sled_spar_${u}`;
    spar.position.set(at.x, 0.35, at.z + 0.03);
    parts.push(spar);
    // Sewn sleeve ends — the only hard points on a sled.
    for (const y of [SLED_TOP - 0.06, sledBottom(u) + 0.06]) {
      const pocket = new THREE.Mesh(pocketGeometry, ctx.accent);
      pocket.name = `kite_sled_pocket_${u}_${y > 0 ? "top" : "foot"}`;
      pocket.position.set(at.x, y, at.z + 0.03);
      parts.push(pocket);
    }
  }

  const outline: THREE.Vector3[] = [];
  const edge = new THREE.Vector3();
  const push = (u: number, y: number) => {
    sledPoint(u, y, edge);
    outline.push(edge.clone());
  };
  for (let i = 0; i <= 12; i++) {
    push(i / 12, SLED_TOP);
    if (i > 0) push(i / 12, SLED_TOP);
  }
  push(1, SLED_TOP);
  push(1, sledBottom(1));
  push(1, sledBottom(1));
  push(0.5, sledBottom(0.5));
  push(0.5, sledBottom(0.5));
  push(0, sledBottom(0));
  push(0, sledBottom(0));
  push(0, SLED_TOP);
  // The two vent mouths, sampled on the same arc as the sail.
  for (const [a, b] of [
    [SLED_EDGES[1], SLED_EDGES[2]],
    [SLED_EDGES[3], SLED_EDGES[4]]
  ]) {
    const corners: [number, number][] = [
      [a, SLED_VENT_TOP],
      [b, SLED_VENT_TOP],
      [b, SLED_VENT_BOTTOM],
      [a, SLED_VENT_BOTTOM]
    ];
    for (let i = 0; i < corners.length; i++) {
      push(corners[i][0], corners[i][1]);
      const next = corners[(i + 1) % corners.length];
      push(next[0], next[1]);
    }
  }
  const hem = new THREE.LineSegments(
    ctx.own(new THREE.BufferGeometry().setFromPoints(outline)),
    ctx.hem
  );
  hem.name = "kite_sled_hem";
  parts.push(hem);
  return parts;
}

// ----------------------------------------------------------- the centipede

/**
 * A Chinese centipede — a head disc and a chain of body discs threaded on one
 * line, with no rigid spine. Every disc is an annulus, so the whole kite is a
 * ladder of apertures: five pupils and the four gaps between them, dealing a
 * bright rung of light out of each.
 *
 * Its apertures are round rather than slotted, which makes it the complement of
 * the sled: the sled's columns are widest exactly when the centipede's rungs are
 * most foreshortened, so the two peak on different beats of the same figure.
 */
const CENTIPEDE_HEAD = { outer: 1.28, inner: 0.55 };
const CENTIPEDE_BODY = { outer: 1.04, inner: 0.46 };
/** Disc centres in local Y, symmetric about the origin. */
const CENTIPEDE_DISCS = [6.28, 2.93, -0.22, -3.37, -6.52] as const;
const CENTIPEDE_HALF_HEIGHT = 7.56;
const CENTIPEDE_DISH = 0.2;

function centipedeCloth(): THREE.BufferGeometry {
  const buffers = newBuffers();
  for (let disc = 0; disc < CENTIPEDE_DISCS.length; disc++) {
    const head = disc === 0;
    const { outer, inner } = head ? CENTIPEDE_HEAD : CENTIPEDE_BODY;
    const centreY = CENTIPEDE_DISCS[disc];
    const slope = (v: number) => (-2 * CENTIPEDE_DISH * (1 - v)) / (outer - inner);
    emitPatch(buffers, {
      // The seam at u=0/1 closes on the same angle, so the ring is continuous.
      nu: head ? 26 : 24,
      nv: head ? 4 : 3,
      point: (u, v, out) => {
        const a = u * Math.PI * 2;
        const r = THREE.MathUtils.lerp(inner, outer, v);
        out.set(Math.cos(a) * r, centreY + Math.sin(a) * r, CENTIPEDE_DISH * (1 - v) * (1 - v));
      },
      normal: (u, v, out) => {
        const a = u * Math.PI * 2;
        out.set(-Math.cos(a) * slope(v), -Math.sin(a) * slope(v), 1).normalize();
      },
      uv: (u, v) => {
        const a = u * Math.PI * 2;
        const r = THREE.MathUtils.lerp(inner, outer, v);
        return [
          (Math.cos(a) * r) / 2.6 + 0.5,
          (centreY + Math.sin(a) * r + CENTIPEDE_HALF_HEIGHT) / (CENTIPEDE_HALF_HEIGHT * 2)
        ];
      },
      // Laced to both hoops only. A `u` term would draw a false lacing line
      // straight down the three-o'clock seam of every disc.
      slack: (_u, v) => edgeFalloff(v, 0.42),
      bulge: (_u, v) => Math.sin(Math.PI * v)
    });
  }
  return finishCloth(buffers, 1.6);
}

function centipedeFrame(ctx: FrameContext): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];
  const headRim = ctx.own(new THREE.TorusGeometry(CENTIPEDE_HEAD.outer, 0.028, 6, 30));
  const headPupil = ctx.own(new THREE.TorusGeometry(CENTIPEDE_HEAD.inner, 0.02, 6, 20));
  const bodyRim = ctx.own(new THREE.TorusGeometry(CENTIPEDE_BODY.outer, 0.024, 6, 26));
  const bodyPupil = ctx.own(new THREE.TorusGeometry(CENTIPEDE_BODY.inner, 0.018, 6, 18));
  // One cross-stick per disc, running clean through and out both sides as the
  // whiskers — which is literally how a centipede disc is built.
  const headRod = ctx.own(new THREE.CylinderGeometry(0.016, 0.01, 4.86, 6));
  headRod.rotateZ(Math.PI / 2);
  const bodyRod = ctx.own(new THREE.CylinderGeometry(0.016, 0.01, 3.68, 6));
  bodyRod.rotateZ(Math.PI / 2);

  for (let disc = 0; disc < CENTIPEDE_DISCS.length; disc++) {
    const head = disc === 0;
    const y = CENTIPEDE_DISCS[disc];
    const rim = new THREE.Mesh(head ? headRim : bodyRim, ctx.spar);
    rim.name = `kite_centipede_rim_${disc}`;
    rim.position.y = y;
    const pupil = new THREE.Mesh(head ? headPupil : bodyPupil, ctx.accent);
    pupil.name = `kite_centipede_pupil_${disc}`;
    pupil.position.set(0, y, CENTIPEDE_DISH);
    const rod = new THREE.Mesh(head ? headRod : bodyRod, ctx.spar);
    rod.name = `kite_centipede_rod_${disc}`;
    rod.position.y = y;
    parts.push(rim, pupil, rod);
  }

  // The cords that make it a train. A rigid spine would be a lie.
  const cords: THREE.Vector3[] = [];
  for (let disc = 0; disc + 1 < CENTIPEDE_DISCS.length; disc++) {
    const upper = disc === 0 ? CENTIPEDE_HEAD.outer : CENTIPEDE_BODY.outer;
    for (const angle of [Math.PI * 0.5, Math.PI * (7 / 6), Math.PI * (11 / 6)]) {
      cords.push(
        new THREE.Vector3(
          Math.cos(angle) * upper,
          CENTIPEDE_DISCS[disc] + Math.sin(angle) * upper,
          0
        ),
        new THREE.Vector3(
          Math.cos(angle) * CENTIPEDE_BODY.outer,
          CENTIPEDE_DISCS[disc + 1] + Math.sin(angle) * CENTIPEDE_BODY.outer,
          0
        )
      );
    }
  }
  const train = new THREE.LineSegments(
    ctx.own(new THREE.BufferGeometry().setFromPoints(cords)),
    ctx.hem
  );
  train.name = "kite_centipede_train";
  parts.push(train);
  return parts;
}

// --------------------------------------------------------------- the prism

/**
 * The one sail on the beach that is not trying to cut the light into bars.
 *
 * It is a triangle with a triangle taken out of it — the album cover, flown —
 * over a comb of six tall slots that flare as they fall. The hollow eye is 2.1 m
 * on a side, ten texels of the god-ray shadow map across, and the slots are
 * 0.58 m at the batten widening to 0.65 m at the hem: the widest apertures here
 * after the sunwheel's.
 *
 * None of which it uses for shadows. `spectral` keeps this kite out of every
 * shadow map (see `KiteDesign.spectral`), so the warm shafts every other design
 * throws are simply absent from it, and `prismLight` hangs a dispersed spectrum
 * off the same silhouette instead — a white beam in from the sun, a rainbow fan
 * out the far side, and a smear of it lying on the sand underneath.
 */
const PRISM_SIDE = 5;
const PRISM_HEIGHT = (PRISM_SIDE * Math.sqrt(3)) / 2;
/** Apex above the centroid, base below it — the equilateral 2:1 split. */
const PRISM_APEX_Y = (PRISM_HEIGHT * 2) / 3;
const PRISM_BASE_Y = -PRISM_HEIGHT / 3;
/** Inner triangle as a fraction of the outer; 0.42 leaves a 2.1 m eye. */
const PRISM_EYE = 0.42;
const PRISM_SKIRT_BOTTOM = PRISM_BASE_Y - 1.51;
/** The comb flares as it falls, so the slots splay like the spectrum does. */
const PRISM_SKIRT_FLARE = 1.12;
const PRISM_SLOTS = 6;
/** Slot width as a fraction of the batten; ribs take whatever is left. */
const PRISM_SLOT_FRACTION = 0.116;

const PRISM_SPAN_X = PRISM_SIDE * PRISM_SKIRT_FLARE;
const PRISM_SPAN_Y = PRISM_APEX_Y - PRISM_SKIRT_BOTTOM;

/** Outer triangle, apex first, counter-clockwise. */
const PRISM_CORNERS: readonly (readonly [number, number])[] = [
  [0, PRISM_APEX_Y],
  [-PRISM_SIDE * 0.5, PRISM_BASE_Y],
  [PRISM_SIDE * 0.5, PRISM_BASE_Y]
];

function prismInner(index: number): [number, number] {
  const [x, y] = PRISM_CORNERS[index % PRISM_CORNERS.length];
  return [x * PRISM_EYE, y * PRISM_EYE];
}

function prismUv(x: number, y: number): [number, number] {
  return [x / PRISM_SPAN_X + 0.5, (y - PRISM_SKIRT_BOTTOM) / PRISM_SPAN_Y];
}

function prismCloth(): THREE.BufferGeometry {
  const buffers = newBuffers();

  // The triangular annulus, cut at the corner bisectors into three trapezoids.
  // Each one is laced along all four of its edges — two hems and two struts —
  // so the default slack is exactly right and the eye stays a clean hole.
  for (let limb = 0; limb < PRISM_CORNERS.length; limb++) {
    const outerA = PRISM_CORNERS[limb];
    const outerB = PRISM_CORNERS[(limb + 1) % PRISM_CORNERS.length];
    const innerA = prismInner(limb);
    const innerB = prismInner(limb + 1);
    const at = (u: number, v: number): [number, number] => [
      THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(outerA[0], outerB[0], u),
        THREE.MathUtils.lerp(innerA[0], innerB[0], u),
        v
      ),
      THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(outerA[1], outerB[1], u),
        THREE.MathUtils.lerp(innerA[1], innerB[1], u),
        v
      )
    ];
    emitPatch(buffers, {
      nu: 10,
      nv: 4,
      point: (u, v, out) => {
        const [x, y] = at(u, v);
        out.set(x, y, 0);
      },
      normal: (_u, _v, out) => out.set(0, 0, 1),
      uv: (u, v) => {
        const [x, y] = at(u, v);
        return prismUv(x, y);
      }
    });
  }

  // The comb. Only the ribs are emitted; the six slots between them are an
  // exact absence of triangles, which is what the light comes through.
  const rib = (1 - PRISM_SLOTS * PRISM_SLOT_FRACTION) / (PRISM_SLOTS + 1);
  const pitch = rib + PRISM_SLOT_FRACTION;
  // One tent across the WHOLE comb rather than one per rib: seven separately
  // feathered ribs would band the panel and its spectrum with it.
  const tent = (n: number, v: number) =>
    Math.cos(n * Math.PI) * smooth01(v / 0.35) * smooth01((1 - v) / 0.3);
  for (let slat = 0; slat <= PRISM_SLOTS; slat++) {
    const start = -0.5 + slat * pitch;
    const at = (u: number, v: number): [number, number] => {
      const n = THREE.MathUtils.lerp(start, start + rib, u);
      const width = THREE.MathUtils.lerp(PRISM_SIDE, PRISM_SIDE * PRISM_SKIRT_FLARE, v);
      return [n * width, THREE.MathUtils.lerp(PRISM_BASE_Y, PRISM_SKIRT_BOTTOM, v)];
    };
    emitPatch(buffers, {
      nu: 2,
      nv: 8,
      point: (u, v, out) => {
        const [x, y] = at(u, v);
        out.set(x, y, 0);
      },
      normal: (_u, _v, out) => out.set(0, 0, 1),
      uv: (u, v) => {
        const [x, y] = at(u, v);
        return prismUv(x, y);
      },
      // Sewn to the batten above and the hem below, and hemmed down both slot
      // edges — a slot mouth on a real kite is bound or it frays open.
      slack: (u, v) => edgeFalloff(u, 0.4) * edgeFalloff(v, 0.28),
      bulge: (u, v) => {
        const n = THREE.MathUtils.lerp(start, start + rib, u);
        return tent(n, v);
      }
    });
  }
  return finishCloth(buffers, 1.45);
}

function prismFrame(ctx: FrameContext): THREE.Object3D[] {
  const parts: THREE.Object3D[] = [];

  /** Lay a spar along a 2D segment; the cylinder's native axis is +Y. */
  const strut = (
    a: readonly [number, number],
    b: readonly [number, number],
    radius: number,
    material: THREE.Material,
    name: string
  ) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    const mesh = new THREE.Mesh(
      ctx.own(new THREE.CylinderGeometry(radius, radius, length, 6)),
      material
    );
    mesh.name = name;
    mesh.position.set((a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, 0.04);
    mesh.rotation.z = Math.atan2(-dx, dy);
    parts.push(mesh);
  };

  for (let i = 0; i < PRISM_CORNERS.length; i++) {
    const outerA = PRISM_CORNERS[i];
    const outerB = PRISM_CORNERS[(i + 1) % PRISM_CORNERS.length];
    strut(outerA, outerB, 0.034, ctx.spar, `kite_prism_edge_${i}`);
    // Corner bisectors: where the three trapezoids meet, and what holds the
    // eye open against a sail that would otherwise close it.
    strut(prismInner(i), outerA, 0.026, ctx.spar, `kite_prism_bisector_${i}`);
    strut(prismInner(i), prismInner(i + 1), 0.022, ctx.accent, `kite_prism_eye_${i}`);
  }

  const hemWidth = PRISM_SIDE * PRISM_SKIRT_FLARE * 0.5;
  strut(
    [-hemWidth, PRISM_SKIRT_BOTTOM],
    [hemWidth, PRISM_SKIRT_BOTTOM],
    0.026,
    ctx.accent,
    "kite_prism_hem_batten"
  );

  // The sewn outline: the triangle, then down and around the comb. Slot mouths
  // are bound individually so every aperture reads as a finished edge.
  const outline: THREE.Vector3[] = [];
  const edge = (a: readonly [number, number], b: readonly [number, number]) => {
    outline.push(new THREE.Vector3(a[0], a[1], 0.02), new THREE.Vector3(b[0], b[1], 0.02));
  };
  for (let i = 0; i < PRISM_CORNERS.length; i++) {
    edge(PRISM_CORNERS[i], PRISM_CORNERS[(i + 1) % PRISM_CORNERS.length]);
  }
  edge([-PRISM_SIDE * 0.5, PRISM_BASE_Y], [-hemWidth, PRISM_SKIRT_BOTTOM]);
  edge([PRISM_SIDE * 0.5, PRISM_BASE_Y], [hemWidth, PRISM_SKIRT_BOTTOM]);
  edge([-hemWidth, PRISM_SKIRT_BOTTOM], [hemWidth, PRISM_SKIRT_BOTTOM]);
  const rib = (1 - PRISM_SLOTS * PRISM_SLOT_FRACTION) / (PRISM_SLOTS + 1);
  const pitch = rib + PRISM_SLOT_FRACTION;
  for (let slot = 0; slot < PRISM_SLOTS; slot++) {
    const left = -0.5 + slot * pitch + rib;
    const right = left + PRISM_SLOT_FRACTION;
    for (const n of [left, right]) {
      edge([n * PRISM_SIDE, PRISM_BASE_Y], [n * PRISM_SIDE * PRISM_SKIRT_FLARE, PRISM_SKIRT_BOTTOM]);
    }
  }
  const hem = new THREE.LineSegments(
    ctx.own(new THREE.BufferGeometry().setFromPoints(outline)),
    ctx.hem
  );
  hem.name = "kite_prism_hem";
  parts.push(hem);
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
  },
  sled: {
    id: "sled",
    label: "pearl sled",
    clothMeshName: "ocean_beach_sled_kite_gpu_cloth",
    // The bowed chord, not the developed span: it is what the bridle legs and
    // the framing maths should both reason about.
    width: 4.18,
    height: 4,
    cullPad: 1.5,
    // A sled tows from a very long two-leg bridle; 1.85 m is about 0.42 of the
    // span, which is the real proportion, and 0.55 m low sets the angle of
    // attack that keeps the wall inflated.
    bridle: [0, -0.55, 1.85],
    // The apex of the trailing V — where a sled's single tail is actually tied,
    // and what damps its wander.
    tailAnchor: [0, -1.32, 0.02],
    // A sled stands up on less line than anything else here, and keeping it
    // close is what makes a soft 4 m wall read as big.
    lineScale: 0.88,
    // Hard-edged parallel slabs of light want a tight fan.
    raySpread: 0.1,
    glowScale: 1.18,
    palette: {
      // Achromatic slate to pearl: the one hue family purple, teal and crimson
      // leave open, and a pale single-layer sail is the best transmission host
      // on the beach.
      clothDeep: 0x3b4a66,
      clothLight: 0xeff3fb,
      glowLow: 0xd9a05e,
      glowHigh: 0xfff4d8,
      // Anodised tube, not wood — a sled uses tube, and it keeps this one
      // visually apart from the brown-spar kites.
      spar: 0x2f3a44,
      hem: 0xdfe8ff,
      tailA: 0x6f88b8,
      tailB: 0xffffff,
      bows: [0xffc978, 0xeff3fb, 0x8fa8d6, 0x3b4a66]
    },
    buildCloth: sledCloth,
    buildFrame: sledFrame
  },
  centipede: {
    id: "centipede",
    label: "gilt centipede",
    clothMeshName: "ocean_beach_centipede_kite_gpu_cloth",
    width: 2.56,
    height: CENTIPEDE_HALF_HEIGHT * 2,
    cullPad: 1.6,
    // Towed from a short three-leg bridle on the head disc, below its centre so
    // the head pitches up and the body trails behind it.
    bridle: [0, 6.05, 1.15],
    // The bottom rim of the last disc: the ribbon continues the body.
    tailAnchor: [0, -CENTIPEDE_HALF_HEIGHT, -0.12],
    // A 15 m body needs at least twice its own length of line before it reads
    // as a kite rather than a banner.
    lineScale: 1.6,
    // The widest fan on the beach. One anchor sits at the flight origin, so a
    // tight fan would sprout every shaft from the dragon's midpoint instead of
    // from its separate rungs.
    raySpread: 0.24,
    // Fifteen square metres of jade silk strung over fifteen metres: in
    // silhouette it is nearly invisible until the sun gets behind it, and the
    // whole gag is all five rings igniting at once.
    glowScale: 1.42,
    palette: {
      clothDeep: 0x0d3b2b,
      clothLight: 0xe8c25a,
      glowLow: 0x3f9a52,
      glowHigh: 0xfff0a6,
      spar: 0x7a5a24,
      hem: 0xffe6a4,
      tailA: 0x18774a,
      tailB: 0xffe27a,
      bows: [0xff6b3d, 0xe8c25a, 0x18774a, 0xfff0a6]
    },
    buildCloth: centipedeCloth,
    buildFrame: centipedeFrame
  },
  prism: {
    id: "prism",
    label: "spectrum prism",
    clothMeshName: "ocean_beach_prism_kite_gpu_cloth",
    width: PRISM_SPAN_X,
    height: PRISM_SPAN_Y,
    cullPad: 1.45,
    // Towed from a long three-leg bridle standing well off the sail: the comb
    // hangs below the tow point, so the whole kite pitches nose-high and the
    // spectrum falls away from the eye instead of across it.
    bridle: [0, 0.35, 1.4],
    tailAnchor: [0, PRISM_SKIRT_BOTTOM, 0.02],
    lineScale: 1.18,
    // Never actually consumed — a spectral kite is skipped by the shared warm
    // fan — but the prism rig reads it as the half-angle its own spectrum
    // splays through, which is what makes the rainbow a fan and not a bar.
    raySpread: 0.3,
    glowScale: 1.24,
    spectral: true,
    palette: {
      // Black sleeve, graphite prism: the sail is nearly a hole in the sky
      // until the sun gets behind it, and then the whole spectrum arrives at
      // once. Everything coloured on this kite is light rather than dye.
      clothDeep: 0x090b14,
      clothLight: 0x2b3350,
      glowLow: 0x6a2fd0,
      glowHigh: 0x4fe0ff,
      spar: 0x2a2f3d,
      hem: 0xcfd8ff,
      // The tail is the one piece of pigment: red at the hem running to violet
      // at its tip, with the four bows between them stepping through the band.
      tailA: 0xff4d3a,
      tailB: 0x9b5cff,
      bows: [0xff5a3c, 0xffd24a, 0x4fd97a, 0x4aa8ff]
    },
    buildCloth: prismCloth,
    buildFrame: prismFrame
  }
};

/** Presentation order along the beach: the original first. */
export const KITE_DESIGN_ORDER: readonly KiteDesignId[] = [
  "diamond",
  "sunwheel",
  "lantern",
  "sled",
  "centipede",
  "prism"
];
