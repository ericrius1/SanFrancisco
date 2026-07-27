import * as THREE from "three/webgpu";
import { attribute, uniform, vec3 } from "three/tsl";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { AuthoredRegionStreamer } from "../authoredRegions";
import { solarPosition } from "../solar";
import { SUTRO_BATHS, sutroLocalToWorld } from "./layout";
import { mixHours, type SutroSkyClock } from "./twilight";

/**
 * The clock on the north conservatory pavilion.
 *
 * The Blender-authored region ships a placeholder here: a flat white disc, a
 * brass ring and two black bars frozen at whatever angle they were modelled at.
 * It is the one object in the hall a visitor walks toward and reads, and it was
 * telling them nothing. This module hides that placeholder and builds the clock
 * the room deserves — 1896 public horology by way of solarpunk: a verdigris
 * copper sunburst, a gilt bezel over a warm enamel dial, IIII at four the way
 * every tower clock of the period had it, a cast-laurel bough round the foot of
 * the case, and blued-steel Breguet hands.
 *
 * IT TELLS THE POCKET'S OWN TIME. The hall is an out-of-time pocket (twilight.ts):
 * step inside and the sky is taken over by a solved sunset hour that drifts
 * slowly down into civil twilight and back. The hands read `sky.timeAuthority`
 * when the pocket holds it and `sky.timeOfDay` when it does not, so the clock
 * always agrees with the light coming through the glass — and when you walk in,
 * it visibly winds itself forward to the evening over the sky's own crossfade.
 *
 * Below the centre is a sun-and-moon aperture, the period's own day/night
 * complication. It is not a schematic 24-hour orbit: the gilt sun sits at the
 * TRUE altitude `solar.ts` computes for the displayed hour on today's date, on
 * the side of the dial the sun is actually on. Because the clock faces south,
 * the viewer reading it faces north, so west falls on the dial's left — which is
 * where the ocean and the real sunset are from that spot. At the pocket's hour
 * the sun is a finger's width above the left rim with the moon already up
 * opposite, which is exactly the hall's weather.
 *
 * COST. Everything static merges into two meshes (one gilt/verdigris/blued
 * metalwork batch on vertex colours, one enamel batch), plus three hands and the
 * aperture rotor: six draws, two materials, ~7k triangles. Nothing casts or
 * receives shadows — the hands move every frame and the hall's shadows are
 * statically cached, so a flat wall ornament 15 m up would buy nothing but cache
 * invalidation.
 */

/** Dial centre in site-local space, matching the placeholder it replaces. */
const CLOCK_LOCAL_X = 0;
const CLOCK_LOCAL_Z = -70.67;
const CLOCK_Y = 21.02;
/** Attic wall face, relative to the dial plane: the case drum spans this gap. */
const WALL_Z = -0.55;

/**
 * Radii, all in metres on the dial plane.
 *
 * The gaps matter as much as the parts. A first pass had the chapter band, the
 * inner ring, the beading and the bezel all touching, and from the deck they
 * fused into one fat gold doughnut with a small dial punched out of it. Ivory
 * has to show between every gilt element or the dial has no face.
 */
const DIAL_R = 1.5;
const BEZEL_R = 1.62;
const CHAPTER_OUTER = 1.36;
const CHAPTER_INNER = 1.2;
const NUMERAL_R = 1.02;
const CORONA_R = 1.72;
const RAY_LONG = 2.16;
const RAY_SHORT = 1.94;
const LAUREL_R = 1.8;

/** Aperture: centred below the arbor, clear of the VI numeral. */
const APERTURE_Y = -0.56;
const APERTURE_R = 0.29;
/** How far the sun and moon ride from the aperture's centre. */
const ORBIT_R = 0.155;

/** Depth stack, front-of-dial. Every hand sits inside the bezel's front lip. */
const Z_DIAL = 0.015;
const Z_ENGRAVING = 0.024;
const Z_NIGHT = 0.03;
const Z_ROTOR = 0.055;
const Z_HORIZON = 0.075;
const Z_APERTURE_RING = 0.088;
const Z_HOUR = 0.105;
const Z_MINUTE = 0.135;
const Z_SECOND = 0.16;
const Z_BOSS = 0.18;

const GILT = new THREE.Color(0xe0ab53);
const GILT_DEEP = new THREE.Color(0x9a7434);
const VERDIGRIS = new THREE.Color(0x59ab86);
const VERDIGRIS_DEEP = new THREE.Color(0x2b6a58);
const BLUED = new THREE.Color(0x232c42);
const NIGHT = new THREE.Color(0x1b2a4d);
const SILVER = new THREE.Color(0xe4e9f2);
const ENAMEL = new THREE.Color(0xffffff);
const ENAMEL_SHADE = new THREE.Color(0xdcccA6);

const DEG = Math.PI / 180;

// TSL node type escape hatch (same convention as parlour.ts and src/fx/*).
type N = any;

export type SutroPavilionClock = {
  group: THREE.Group;
  /** 0 = daylight hall, 1 = deep in the out-of-time twilight. */
  setTwilight(depth: number): void;
  update(dt: number): void;
  /** Next update re-snaps the hands instead of sweeping to the new hour. */
  release(): void;
  readonly displayHour: number;
  dispose(): void;
};

export type SutroPavilionClockOptions = {
  /** The world clock, already carrying the pocket's authority when held. */
  sky?: SutroSkyClock | null;
  /** Used only to hide the authored placeholder once the region streams in. */
  authoredRegions?: AuthoredRegionStreamer;
};

type Piece = { geometry: THREE.BufferGeometry; color: THREE.Color };

/**
 * Extrude a CONVEX closed outline (listed counter-clockwise in XY) by `thick`
 * along Z, centred on the dial plane.
 *
 * Everything with a silhouette here — sunburst rays, laurel leaves, hand blades,
 * glazing bars — is a convex plate, so one fan-triangulated extruder covers the
 * lot and the module never reaches for ExtrudeGeometry's tessellator.
 */
function plate(outline: readonly (readonly [number, number])[], thick: number): THREE.BufferGeometry {
  const half = thick * 0.5;
  const position: number[] = [];
  const push = (x: number, y: number, z: number) => position.push(x, y, z);
  const n = outline.length;
  for (let i = 1; i < n - 1; i++) {
    const [ax, ay] = outline[0];
    const [bx, by] = outline[i];
    const [cx, cy] = outline[i + 1];
    push(ax, ay, half);
    push(bx, by, half);
    push(cx, cy, half);
    push(ax, ay, -half);
    push(cx, cy, -half);
    push(bx, by, -half);
  }
  for (let i = 0; i < n; i++) {
    const [ax, ay] = outline[i];
    const [bx, by] = outline[(i + 1) % n];
    push(ax, ay, half);
    push(ax, ay, -half);
    push(bx, by, -half);
    push(ax, ay, half);
    push(bx, by, -half);
    push(bx, by, half);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** A tapered blade along +Y: `w0` wide at `r0`, `w1` at `r1`. */
function blade(r0: number, r1: number, w0: number, w1: number, thick: number): THREE.BufferGeometry {
  return plate(
    [
      [-w0 * 0.5, r0],
      [w0 * 0.5, r0],
      [w1 * 0.5, r1],
      [-w1 * 0.5, r1]
    ],
    thick
  );
}

/** A cast leaf pointing along +Y, widest a third of the way up. */
function leaf(length: number, width: number, thick: number): THREE.BufferGeometry {
  return plate(
    [
      [0, 0],
      [width * 0.5, length * 0.36],
      [0, length],
      [-width * 0.5, length * 0.36]
    ],
    thick
  );
}

/**
 * Roman numeral strokes in a unit cell: origin at the baseline centre, cap
 * height 1, and an advance width per glyph. Only I, V and X are ever needed.
 */
const GLYPH_ADVANCE: Readonly<Record<string, number>> = { I: 0.26, V: 0.62, X: 0.62 };
const STROKE = 0.19; // of cap height — public dials carry a heavy numeral

function glyphStrokes(glyph: string): readonly (readonly (readonly [number, number])[])[] {
  const t = STROKE * 0.5;
  if (glyph === "I") {
    return [[[-t, 0], [t, 0], [t, 1], [-t, 1]]];
  }
  // V and X are the same two obliques; V meets at the baseline, X crosses.
  const lean = 0.2;
  if (glyph === "V") {
    return [
      [[-lean - t, 1], [-lean + t, 1], [t, 0], [-t, 0]],
      [[lean - t, 1], [lean + t, 1], [t, 0], [-t, 0]]
    ];
  }
  return [
    [[-lean - t, 1], [-lean + t, 1], [lean + t, 0], [lean - t, 0]],
    [[lean - t, 1], [lean + t, 1], [-lean + t, 0], [-lean - t, 0]]
  ];
}

/** IIII at four, as every tower clock of the period had it. */
const NUMERALS = ["I", "II", "III", "IIII", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"] as const;

export function createSutroPavilionClock(
  options: SutroPavilionClockOptions = {}
): SutroPavilionClock {
  const sky = options.sky ?? null;

  const group = new THREE.Group();
  group.name = "sutro_pavilion_clock";
  const world = sutroLocalToWorld(CLOCK_LOCAL_X, CLOCK_LOCAL_Z);
  group.position.set(world.x, CLOCK_Y, world.z);
  group.rotation.y = SUTRO_BATHS.yaw;

  // ------------------------------------------------------------- materials
  // Two, and deliberately two. Gilt, verdigris, blued steel and the night sky
  // of the aperture differ only in colour at this distance, so they share one
  // metalwork pipeline through vertex colours; the dial needs its own because
  // it is the only thing here that lights up.
  //
  // The lamplight the hall picks up at dusk has to go through emissiveNode, not
  // the scalar `emissive`. A flat emissive term adds the SAME warm value to
  // every vertex, and against a dark blued hand or a green patina that term is
  // far larger than the surface itself — the first build came out uniformly
  // gold, hands, numerals, patina and all. Multiplying the glow by the vertex
  // colour keeps gilt gold, patina green and blued steel dark.
  const metalGlow = uniform(0);
  const metalwork = new THREE.MeshStandardNodeMaterial({
    color: 0xffffff,
    vertexColors: true,
    roughness: 0.36,
    metalness: 0.48
  });
  metalwork.name = "sutro_clock_metalwork";
  metalwork.emissiveNode = (attribute("color", "vec3") as N)
    .mul(vec3(1, 0.74, 0.46))
    .mul(metalGlow);
  const enamel = new THREE.MeshStandardMaterial({
    color: 0xf3e7cb,
    vertexColors: true,
    roughness: 0.52,
    metalness: 0.03,
    emissive: new THREE.Color(0xffcf95),
    emissiveIntensity: 0
  });
  enamel.name = "sutro_clock_enamel";

  const metalPieces: Piece[] = [];
  const enamelPieces: Piece[] = [];
  const matrix = new THREE.Matrix4();

  /** Stamp a piece into a batch at a position/rotation, painting it as we go. */
  const stamp = (
    pieces: Piece[],
    geometry: THREE.BufferGeometry,
    color: THREE.Color,
    x: number,
    y: number,
    z: number,
    roll = 0
  ) => {
    matrix.makeRotationZ(roll);
    matrix.setPosition(x, y, z);
    geometry.applyMatrix4(matrix);
    pieces.push({ geometry, color });
  };

  // ------------------------------------------------------------- the case
  // A real drum reaching back to the attic wall. The placeholder was a decal on
  // a flat plane, which is why it read as a sticker from the deck below.
  const drum = new THREE.CylinderGeometry(BEZEL_R * 0.99, BEZEL_R * 0.99, -WALL_Z, 30, 1, true);
  drum.rotateX(Math.PI * 0.5);
  stamp(metalPieces, drum, VERDIGRIS_DEEP, 0, 0, WALL_Z * 0.5);
  stamp(
    metalPieces,
    new THREE.CircleGeometry(BEZEL_R * 0.99, 30),
    VERDIGRIS_DEEP,
    0,
    0,
    WALL_Z + 0.01
  );

  // ------------------------------------------------------------- the sunburst
  // Alternating gilt and verdigris rays: the solar emblem the whole hall is
  // pointed at, sized to clear the attic frieze above and the sash windows
  // either side rather than to be as big as possible. Twenty-four, not the
  // thirty-two of the first pass — that many spikes at this radius read as a
  // cog rather than a sun.
  const RAYS = 24;
  for (let i = 0; i < RAYS; i++) {
    const long = i % 2 === 0;
    stamp(
      metalPieces,
      blade(CORONA_R - 0.1, long ? RAY_LONG : RAY_SHORT, long ? 0.19 : 0.13, 0.025, 0.05),
      long ? GILT : VERDIGRIS,
      0,
      0,
      -0.1,
      (i / RAYS) * Math.PI * 2
    );
  }

  // ------------------------------------------------------------- the laurel
  // A cast bough wrapping the foot of the case. Belle Époque ironwork and
  // solarpunk want the same thing here: metal that remembers it grew.
  const LAUREL_FROM = 200 * DEG;
  const LAUREL_ARC = 140 * DEG;
  const stem = new THREE.TorusGeometry(LAUREL_R, 0.032, 4, 40, LAUREL_ARC);
  stem.rotateZ(LAUREL_FROM);
  stamp(metalPieces, stem, GILT_DEEP, 0, 0, 0.02);
  // Few and large. Twenty small leaves at this radius is a serrated skirt from
  // the deck; thirteen big ones lying nearly along the bough each read as a
  // leaf, which is the only way a wreath survives being seen from 40 m.
  const LEAVES = 13;
  for (let i = 0; i < LEAVES; i++) {
    const angle = LAUREL_FROM + (i / (LEAVES - 1)) * LAUREL_ARC;
    const outward = i % 2 === 0;
    // tilt = angle is the tangent; the flare alternates the spray in and out.
    const tilt = angle + (outward ? 0.32 : -0.32);
    stamp(
      metalPieces,
      leaf(0.44, 0.2, 0.032),
      // Gilt throughout: a verdigris leaf against the verdigris rays behind it
      // simply disappears, and the bough is the one botanical note here.
      outward ? GILT : GILT_DEEP,
      Math.cos(angle) * LAUREL_R,
      Math.sin(angle) * LAUREL_R,
      0.025,
      tilt
    );
  }

  // ------------------------------------------------------------- the bezel
  // Verdigris outside, gilt inside: the case has weathered, the bezel has been
  // kept polished. The beading rides ON the bezel rather than inside it, or the
  // two run together into one band.
  const BEZEL_TUBE = 0.1;
  stamp(metalPieces, new THREE.TorusGeometry(BEZEL_R, BEZEL_TUBE, 8, 64), VERDIGRIS, 0, 0, 0.05);
  stamp(metalPieces, new THREE.TorusGeometry(BEZEL_R - 0.105, 0.05, 6, 56), GILT, 0, 0, 0.1);
  // Beading rides on the CROWN of the bezel tube. Sunk anywhere shallower it is
  // simply inside the torus and invisible.
  const BEADS = 44;
  for (let i = 0; i < BEADS; i++) {
    const angle = (i / BEADS) * Math.PI * 2;
    stamp(
      metalPieces,
      new THREE.SphereGeometry(0.045, 5, 4),
      GILT,
      Math.cos(angle) * BEZEL_R,
      Math.sin(angle) * BEZEL_R,
      0.05 + BEZEL_TUBE
    );
  }

  // ------------------------------------------------------------- the dial
  stamp(enamelPieces, new THREE.CircleGeometry(DIAL_R, 48), ENAMEL, 0, 0, Z_DIAL);
  // Engine-turned circles: flat annuli, not tubes. At reading distance a hairline
  // ring of gilt is indistinguishable from an engraved one and costs two
  // triangles a segment.
  for (const radius of [0.36, 0.62]) {
    stamp(
      metalPieces,
      new THREE.RingGeometry(radius - 0.006, radius + 0.006, 40),
      GILT_DEEP,
      0,
      0,
      Z_ENGRAVING
    );
  }
  // The chapter track: two hairlines with ivory between them, not a filled band.
  for (const radius of [CHAPTER_INNER, CHAPTER_OUTER]) {
    stamp(
      metalPieces,
      new THREE.RingGeometry(radius - 0.009, radius + 0.009, 48),
      GILT_DEEP,
      0,
      0,
      Z_ENGRAVING
    );
  }
  for (let minute = 0; minute < 60; minute++) {
    const onFive = minute % 5 === 0;
    const angle = minute * 6 * DEG;
    stamp(
      metalPieces,
      blade(
        onFive ? CHAPTER_INNER + 0.012 : CHAPTER_OUTER - 0.055,
        CHAPTER_OUTER - 0.012,
        onFive ? 0.055 : 0.022,
        onFive ? 0.055 : 0.022,
        0.014
      ),
      BLUED,
      0,
      0,
      Z_ENGRAVING + 0.008,
      -angle
    );
  }

  // ------------------------------------------------------------- the numerals
  const NUMERAL_HEIGHT = 0.29;
  NUMERALS.forEach((numeral, index) => {
    const hour = index + 1;
    const angle = hour * 30 * DEG;
    const width = [...numeral].reduce((sum, glyph) => sum + GLYPH_ADVANCE[glyph], 0);
    let pen = -width * 0.5;
    for (const glyph of numeral) {
      const advance = GLYPH_ADVANCE[glyph];
      for (const outline of glyphStrokes(glyph)) {
        // Cell coordinates → dial coordinates. Stroke outlines are ALREADY in
        // advance units, so the pen only offsets them; scaling them by the
        // advance as well (the first pass did) shrinks every glyph inside its
        // own slot and leaves XII reading as X I I.
        const cell = outline.map(
          ([cx, cy]) =>
            [(pen + advance * 0.5 + cx) * NUMERAL_HEIGHT, cy * NUMERAL_HEIGHT] as const
        );
        const geometry = plate(cell, 0.022);
        geometry.translate(0, NUMERAL_R - NUMERAL_HEIGHT * 0.5, 0);
        stamp(metalPieces, geometry, BLUED, 0, 0, Z_ENGRAVING + 0.01, -angle);
      }
      pen += advance;
    }
  });

  // ------------------------------------------------- sun-and-moon aperture
  stamp(metalPieces, new THREE.CircleGeometry(APERTURE_R, 26), NIGHT, 0, APERTURE_Y, Z_NIGHT);
  // Small stars pricked into the night plate, so the moon has something to be up
  // against once the sun has gone under the rim.
  for (const [sx, sy] of [
    [-0.15, 0.13],
    [0.11, 0.17],
    [0.19, 0.03],
    [-0.21, 0.02],
    [0.02, 0.22]
  ] as const) {
    stamp(
      metalPieces,
      new THREE.CircleGeometry(0.014, 5),
      SILVER,
      sx,
      APERTURE_Y + sy,
      Z_NIGHT + 0.004
    );
  }
  // The horizon: enamel, so it reads as the dial surface with a window cut in
  // it rather than as a separate plate. It is what hides the body that is down.
  const horizon: (readonly [number, number])[] = [];
  const HORIZON_SEGMENTS = 22;
  for (let i = 0; i <= HORIZON_SEGMENTS; i++) {
    const angle = Math.PI + (i / HORIZON_SEGMENTS) * Math.PI;
    horizon.push([Math.cos(angle) * (APERTURE_R + 0.01), Math.sin(angle) * (APERTURE_R + 0.01)]);
  }
  stamp(
    enamelPieces,
    plate(horizon, 0.016),
    ENAMEL_SHADE,
    0,
    APERTURE_Y,
    Z_HORIZON
  );
  stamp(
    metalPieces,
    new THREE.TorusGeometry(APERTURE_R + 0.012, 0.03, 4, 26),
    GILT,
    0,
    APERTURE_Y,
    Z_APERTURE_RING
  );

  // ------------------------------------------------------------- the arbor
  const boss = new THREE.SphereGeometry(0.085, 10, 6);
  boss.scale(1, 1, 0.7);
  stamp(metalPieces, boss, GILT, 0, 0, Z_BOSS);

  // -------------------------------------------- flanking fanlight tracery
  // The two attic sashes either side of the clock are bare glass panes in the
  // authored region — the flat dark rectangles that made this facade read as a
  // shed wall. Glazing bars and a radiating fan head turn them into the
  // conservatory windows the rest of the pavilion is pretending to have.
  const SASH = { x: 5.201, y: 20.62 - CLOCK_Y, halfX: 1.55, halfY: 1.7, z: -0.3 };
  const BAR = 0.062;
  for (const side of [-1, 1]) {
    const cx = side * SASH.x;
    const bar = (x: number, y: number, w: number, h: number, color: THREE.Color) =>
      stamp(metalPieces, plate([[-w, -h], [w, -h], [w, h], [-w, h]], BAR), color, cx + x, SASH.y + y, SASH.z);
    // Outer frame.
    bar(0, SASH.halfY, SASH.halfX + BAR, BAR * 0.5, GILT_DEEP);
    bar(0, -SASH.halfY, SASH.halfX + BAR, BAR * 0.5, GILT_DEEP);
    bar(-SASH.halfX, 0, BAR * 0.5, SASH.halfY, GILT_DEEP);
    bar(SASH.halfX, 0, BAR * 0.5, SASH.halfY, GILT_DEEP);
    // Sash: one mullion and the transom the fan springs from.
    const transomY = SASH.halfY * 0.05;
    bar(0, -SASH.halfY * 0.5, BAR * 0.4, SASH.halfY * 0.55, VERDIGRIS_DEEP);
    bar(0, transomY, SASH.halfX, BAR * 0.4, GILT_DEEP);
    bar(-SASH.halfX * 0.5, -SASH.halfY * 0.5, BAR * 0.4, SASH.halfY * 0.55, VERDIGRIS_DEEP);
    bar(SASH.halfX * 0.5, -SASH.halfY * 0.5, BAR * 0.4, SASH.halfY * 0.55, VERDIGRIS_DEEP);
    // Fan head: bars radiating from the transom's midpoint, tied by one arc.
    const fanR = SASH.halfY - transomY - BAR;
    for (let i = 1; i <= 7; i++) {
      const angle = (i / 8) * Math.PI;
      stamp(
        metalPieces,
        blade(0.1, fanR, BAR * 0.85, BAR * 0.5, BAR),
        i % 2 ? GILT : VERDIGRIS,
        cx,
        SASH.y + transomY,
        SASH.z,
        Math.PI * 0.5 - angle
      );
    }
    const arc = new THREE.TorusGeometry(fanR * 0.55, BAR * 0.36, 4, 26, Math.PI);
    stamp(metalPieces, arc, GILT_DEEP, cx, SASH.y + transomY, SASH.z);
    stamp(
      metalPieces,
      new THREE.SphereGeometry(0.11, 8, 6),
      GILT,
      cx,
      SASH.y + transomY,
      SASH.z + 0.03
    );
  }

  // ------------------------------------------------------------- batching
  const build = (pieces: Piece[], material: THREE.Material, name: string): THREE.Mesh => {
    const parts = pieces.map(({ geometry, color }) => {
      const flat = geometry.index ? geometry.toNonIndexed() : geometry;
      if (flat !== geometry) geometry.dispose();
      // Uniform tint per piece; one merged batch carries the whole palette.
      const count = flat.attributes.position.count;
      const colors = new Float32Array(count * 3);
      for (let i = 0; i < count; i++) {
        colors[i * 3] = color.r;
        colors[i * 3 + 1] = color.g;
        colors[i * 3 + 2] = color.b;
      }
      flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      flat.deleteAttribute("uv");
      return flat;
    });
    const merged = mergeGeometries(parts, false)!;
    for (const part of parts) part.dispose();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    return mesh;
  };

  const ornament = build(metalPieces, metalwork, "sutro_pavilion_clock_metalwork");
  const dial = build(enamelPieces, enamel, "sutro_pavilion_clock_dial");

  // ------------------------------------------------------------- the hands
  /**
   * A Breguet hand: tapered blade, pierced pomme ring near the tip, tail
   * counterweight. `reach` is the tip radius; everything else scales with it.
   */
  const handMesh = (reach: number, width: number, ringAt: number, name: string, color: THREE.Color) => {
    const tail = reach * 0.24;
    const parts: THREE.BufferGeometry[] = [
      plate([[-width * 0.62, -tail], [width * 0.62, -tail], [width * 0.5, 0], [-width * 0.5, 0]], 0.022),
      blade(0, reach * 0.86, width, width * 0.34, 0.022),
      plate([[-width * 0.17, reach * 0.86], [width * 0.17, reach * 0.86], [0, reach]], 0.022)
    ];
    if (ringAt > 0) {
      const ring = new THREE.TorusGeometry(width * 0.95, width * 0.3, 4, 14);
      ring.translate(0, reach * ringAt, 0);
      parts.push(ring.toNonIndexed());
      ring.dispose();
    }
    const flattened = parts.map((part) => {
      const flat = part.index ? part.toNonIndexed() : part;
      if (flat !== part) part.dispose();
      // The pomme ring comes from TorusGeometry and carries a uv the extruded
      // blades never have; merge refuses a mixed attribute set.
      flat.deleteAttribute("uv");
      return flat;
    });
    const merged = mergeGeometries(flattened, false)!;
    for (const part of flattened) part.dispose();
    const count = merged.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    merged.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    merged.deleteAttribute("uv");
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, metalwork);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    return mesh;
  };

  const hourHand = handMesh(0.82, 0.115, 0.62, "sutro_pavilion_clock_hour_hand", BLUED);
  hourHand.position.z = Z_HOUR;
  const minuteHand = handMesh(1.24, 0.085, 0.74, "sutro_pavilion_clock_minute_hand", BLUED);
  minuteHand.position.z = Z_MINUTE;
  const secondHand = handMesh(1.3, 0.032, 0, "sutro_pavilion_clock_second_hand", GILT);
  secondHand.position.z = Z_SECOND;

  // ---------------------------------------------------- the aperture rotor
  const rotorPieces: THREE.BufferGeometry[] = [];
  const rotorColors: THREE.Color[] = [];
  const sun = new THREE.CircleGeometry(0.082, 14);
  sun.translate(0, ORBIT_R, 0);
  rotorPieces.push(sun);
  rotorColors.push(GILT);
  for (let i = 0; i < 8; i++) {
    const ray = blade(0.08, 0.135, 0.032, 0.011, 0.01);
    ray.rotateZ((i / 8) * Math.PI * 2);
    ray.translate(0, ORBIT_R, 0);
    rotorPieces.push(ray);
    rotorColors.push(GILT);
  }
  const moon = new THREE.CircleGeometry(0.06, 12);
  moon.translate(0, -ORBIT_R, 0);
  rotorPieces.push(moon);
  rotorColors.push(SILVER);
  const rotorParts = rotorPieces.map((part, index) => {
    const flat = part.index ? part.toNonIndexed() : part;
    if (flat !== part) part.dispose();
    const count = flat.attributes.position.count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = rotorColors[index].r;
      colors[i * 3 + 1] = rotorColors[index].g;
      colors[i * 3 + 2] = rotorColors[index].b;
    }
    flat.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    flat.deleteAttribute("uv");
    return flat;
  });
  const rotorGeometry = mergeGeometries(rotorParts, false)!;
  for (const part of rotorParts) part.dispose();
  rotorGeometry.computeBoundingSphere();
  const rotor = new THREE.Mesh(rotorGeometry, metalwork);
  rotor.name = "sutro_pavilion_clock_sun_moon";
  rotor.castShadow = false;
  rotor.receiveShadow = false;
  rotor.position.set(0, APERTURE_Y, Z_ROTOR);
  group.add(rotor);

  // ------------------------------------------- hide the authored placeholder
  // Hidden exactly while THIS module is drawing a clock, and not a moment
  // longer. The authored region streams in from 1100 m out but the site only
  // wakes at 760 m, so hiding on load would leave a few hundred metres of
  // approach where the pavilion has an empty socket where its clock should be.
  let placeholder: THREE.Object3D | null = null;
  const showPlaceholder = (visible: boolean) => {
    if (placeholder) placeholder.visible = visible;
  };
  const unwatch =
    options.authoredRegions?.watch(
      "sutro-baths",
      (root) => {
        placeholder = root.getObjectByName("sutro_baths_pavilion_clock") ?? null;
      },
      () => {
        // The region owns that node; hand it back exactly as it was found.
        showPlaceholder(true);
        placeholder = null;
      }
    ) ?? (() => {});

  // ------------------------------------------------------------- the movement
  let displayHour = sky?.timeOfDay ?? 12;
  let solvedHour = Number.NaN;
  let primed = false;
  let disposed = false;

  const targetHour = (): number => {
    if (!sky) return displayHour;
    // The pocket's authority when it holds one, the world's own clock when it
    // does not. Both are already the hour the sky is actually rendering.
    return sky.timeAuthority ?? sky.timeOfDay;
  };

  return {
    group,
    setTwilight(depth) {
      const t = THREE.MathUtils.clamp(depth, 0, 1);
      // A lit dial is what makes a public clock readable at dusk, and it is the
      // single strongest thing this object does for the room: a warm coin of
      // light at the far end of a hall that has gone to evening.
      enamel.emissiveIntensity = 0.05 + t * 0.95;
      enamel.color.setRGB(0.95 - t * 0.06, 0.905 - t * 0.075, 0.796 - t * 0.13);
      metalGlow.value = t * 0.42;
    },
    update(dt) {
      if (disposed) return;
      showPlaceholder(false);
      const target = targetHour();
      if (!primed) {
        primed = true;
        displayHour = target;
      } else {
        // Track fast enough to look mechanical rather than laggy. The pocket's
        // own 7-second sky crossfade is what actually paces the sweep when a
        // visitor walks in; this only removes the discontinuity at the ends.
        const step = Math.min(1, Math.max(0, dt) * 4);
        displayHour = mixHours(displayHour, target, step);
      }

      const minutes = (displayHour % 1) * 60;
      const seconds = (minutes % 1) * 60;
      hourHand.rotation.z = -(displayHour % 12) * 30 * DEG;
      minuteHand.rotation.z = -minutes * 6 * DEG;
      secondHand.rotation.z = -seconds * 6 * DEG;

      // The aperture only needs re-solving when the hour has actually moved;
      // inside the pocket that is a slow drift, not a per-frame quantity.
      if (sky && !(Math.abs(displayHour - solvedHour) < 0.0008)) {
        solvedHour = displayHour;
        const position = solarPosition({ ...sky.civilTime, hour: displayHour });
        // Zenith is straight up on the dial; the sun swings down toward the rim
        // the way it does in the sky. West is dial-LEFT because a visitor
        // reading this clock is facing north.
        const fromZenith = (90 - position.elevation) * DEG;
        rotor.rotation.z = position.azimuth >= 180 ? fromZenith : -fromZenith;
      }
    },
    release() {
      primed = false;
      showPlaceholder(true);
    },
    get displayHour() {
      return displayHour;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unwatch();
      showPlaceholder(true);
      placeholder = null;
      for (const mesh of [ornament, dial, hourHand, minuteHand, secondHand, rotor]) {
        mesh.removeFromParent();
        mesh.geometry.dispose();
      }
      metalwork.dispose();
      enamel.dispose();
      group.removeFromParent();
    }
  };
}
