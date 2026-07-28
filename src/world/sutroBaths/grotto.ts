import * as THREE from "three/webgpu";
import {
  Fn,
  cameraPosition,
  float as floatRaw,
  fract,
  length,
  mix as mixRaw,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3 as vec3Raw,
  vec4 as vec4Raw
} from "three/tsl";
import { loadTexture } from "../../render/textures";
import type { Physics } from "../../core/physics";
import {
  lightAnchor,
  registerAmbientLightAnchor,
  type LightAnchorSpec
} from "../../player/lightPool";
import { registerSwimVolume } from "../swimVolumes";
import { registerInteriorVolume } from "../interiorVolumes";
import {
  ART_ROOT,
  Builder,
  LAMP_TINT,
  cladBay,
  createTimberMaterials,
  hangPicture,
  hash,
  loadTimberGrain,
  toneColour,
  type Band
} from "./timberCladding";
import {
  SUTRO_BATHS,
  SUTRO_GROTTO,
  SUTRO_GROTTO_CENTRE,
  sutroGrottoContains,
  sutroGrottoPoolContains,
  sutroLocalToWorld
} from "./layout";
import { createSutroReef, type SutroReef } from "./reef";

/**
 * The sunken gallery — the room the great plunge drains into.
 *
 * Seventy-five metres of timber gallery thirty-one metres under the bath deck,
 * hung with every picture that used to be on the wall upstairs, glazed down one
 * whole side onto the sea floor, and built around the thing that made it: a
 * ring of water falling twelve metres out of the ceiling into an octagonal
 * basin in the middle of the floor.
 *
 * PLAN. It is the plunge's own shadow — same centre, same axis, a little wider,
 * half the length. Which means the inland wall is under the hall's timber
 * gallery and gets the same seven-band section and the same hang, and the
 * glazed wall is under the hall's glass. The difference is what is on the other
 * side of it (reef.ts).
 *
 * WHY THE BASIN IS AN OCTAGON. Its collision shell is a triangle mesh, and a
 * regular octagon is a shape a floor with a hole in it can be decomposed into
 * exactly: four rectangles and four corner triangles, with no seam a capsule
 * can find. `sutroGrottoPoolContains` in layout.ts is the same octagon, so the
 * water's edge and the stone under it cannot disagree.
 *
 * LIFECYCLE. Nothing in here — nor anything in reef.ts, which this module
 * statically imports — is on any boot or site path. index.ts dynamically
 * imports this file the first time a swimmer gets near the drain, and until
 * that build lands the drain stays shut.
 */

type N = any;
const float = floatRaw as (...a: N[]) => N;
const vec3 = vec3Raw as (...a: N[]) => N;
const vec4 = vec4Raw as (...a: N[]) => N;
const mix = mixRaw as (...a: N[]) => N;

const X0 = SUTRO_GROTTO.glassFaceX;
const X1 = SUTRO_GROTTO.artFaceX;
const CZ = SUTRO_GROTTO.centreZ;
const CX = SUTRO_GROTTO_CENTRE.x;
const Z0 = CZ - SUTRO_GROTTO.halfLength;
const Z1 = CZ + SUTRO_GROTTO.halfLength;
const FLOOR = SUTRO_GROTTO.floorY;
const CEILING = SUTRO_GROTTO.ceilingY;
const POOL_R = SUTRO_GROTTO.poolRadius;
/** Octagon vertex offset: r(√2 − 1), the distance from a flat's end to a corner. */
const POOL_B = POOL_R * (Math.SQRT2 - 1);

/** Grade strengths, sized the way staticAmbience.ts sizes the hall's own. */
const TIMBER_SELF_GLOW = 0.07;
const TIMBER_TINT_MIX = 0.22;
const ART_SELF_GLOW = 0.62;
const PICTURE_LIGHT_GLOW = 6.4;

const BANDS: readonly Band[] = [
  { id: "plinth", y0: FLOOR, y1: FLOOR + 0.9, tone: "dark", proud: 0.26, layout: "courses", coursePitch: 0.45, courseHeight: 0.41 },
  { id: "dado", y0: FLOOR + 0.9, y1: FLOOR + 2.8, tone: "dark", proud: 0.18, layout: "slats", slatPitch: 0.36, slatWidth: 0.28 },
  { id: "chair-rail", y0: FLOOR + 2.8, y1: FLOOR + 3.12, tone: "dark", proud: 0.34, layout: "courses", coursePitch: 0.32, courseHeight: 0.32 },
  { id: "art-field", y0: FLOOR + 3.12, y1: FLOOR + 9.1, tone: "warm", proud: 0.16, layout: "courses", coursePitch: 0.48, courseHeight: 0.43 },
  { id: "picture-rail", y0: FLOOR + 9.1, y1: FLOOR + 9.52, tone: "dark", proud: 0.32, layout: "courses", coursePitch: 0.42, courseHeight: 0.42 },
  { id: "clerestory", y0: FLOOR + 9.52, y1: FLOOR + 11.15, tone: "warm", proud: 0.14, layout: "slats", slatPitch: 0.4, slatWidth: 0.3 },
  { id: "cornice", y0: FLOOR + 11.15, y1: CEILING, tone: "dark", proud: 0.44, layout: "courses", coursePitch: 0.55, courseHeight: 0.55 }
];

const ART_CENTRE_Y = FLOOR + 6.1;
const FIELD_PROUD = 0.16;

type Hang = "wide" | "pair";

/**
 * The hang, moved down whole from the hall's inland wall.
 *
 * Seven landscape plates (3:2) take a bay each; the ten portrait plates (2:3)
 * pair up in the five bays between them. Twelve bays, seventeen pictures, no
 * plate hung twice — and the two landscape bays that fall together do so at the
 * exact centre of the room, one on each side of the fall, which is the one
 * place a doubled rhythm reads as deliberate.
 *
 * Sizes are for THIS room, not the hall: the eye is 1.7 m off a floor the
 * pictures start 3.1 m above, across 23 m of gallery rather than 25 m of open
 * water, so everything comes down to roughly two thirds of its old size.
 */
const HANGS: readonly { hang: Hang; plates: readonly string[] }[] = [
  { hang: "wide", plates: ["hall-pacific-plunge"] },
  { hang: "pair", plates: ["bill-grand-opening", "plate-tropical-ferns"] },
  { hang: "wide", plates: ["hall-seal-rocks"] },
  { hang: "pair", plates: ["bill-swimming-carnival", "plate-museum-curios"] },
  { hang: "wide", plates: ["hall-conservatory-palms"] },
  { hang: "pair", plates: ["bill-bathing-suits", "hall-high-dive"] },
  { hang: "wide", plates: ["hall-carnival-night"] },
  { hang: "wide", plates: ["hall-toboggan-slides"] },
  { hang: "pair", plates: ["bill-sutro-railroad", "plate-natatorium-section"] },
  { hang: "wide", plates: ["hall-tide-tunnel"] },
  { hang: "pair", plates: ["plate-pacific-shells", "bill-winter-sea"] },
  { hang: "wide", plates: ["hall-sutro-heights"] }
];

const HANG_SIZES: Record<Hang, { width: number; height: number; offsets: readonly number[] }> = {
  wide: { width: 4.8, height: 3.2, offsets: [0] },
  pair: { width: 2.2, height: 3.3, offsets: [-1.45, 1.45] }
};

/** Six great windows on a 12.6 m pitch — one for every two picture bays. */
const WINDOW = {
  count: 6,
  pitch: (Z1 - Z0) / 6,
  clearWidth: 9.4,
  sillY: FLOOR + 1.5,
  headY: FLOOR + 9.9
} as const;

const WATER_PALE = /*@__PURE__*/ new THREE.Color(0xbdf2ff);
const WATER_BODY = /*@__PURE__*/ new THREE.Color(0x2f8ea3);

export type SutroGrotto = {
  group: THREE.Group;
  /** Resolves once the grain and every plate have landed. */
  ready: Promise<void>;
  /** 0 = daylight grade, 1 = the pocket's evening. Down here it is always 1. */
  setTwilight(depth: number): void;
  update(time: number): void;
  readonly stats: {
    boards: number;
    artworks: number;
    plates: number;
    draws: number;
    triangles: number;
    reefDraws: number;
    reefTriangles: number;
    fish: number;
    plants: number;
  };
  dispose(): void;
};

/** Regular-octagon vertices of the basin, counter-clockwise from +x. */
function poolVertices(): readonly (readonly [number, number])[] {
  return [
    [CX + POOL_R, CZ + POOL_B],
    [CX + POOL_B, CZ + POOL_R],
    [CX - POOL_B, CZ + POOL_R],
    [CX - POOL_R, CZ + POOL_B],
    [CX - POOL_R, CZ - POOL_B],
    [CX - POOL_B, CZ - POOL_R],
    [CX + POOL_B, CZ - POOL_R],
    [CX + POOL_R, CZ - POOL_B]
  ] as const;
}

/** Half-extent in z of the basin at a given x, or null when x misses it. */
function poolSpanAtX(x: number): number | null {
  const dx = Math.abs(x - CX);
  if (dx >= POOL_R) return null;
  return Math.min(POOL_R, POOL_R * Math.SQRT2 - dx);
}

/** …and the mirror, for the ceiling planks that cross the aperture. */
function apertureSpanAtZ(z: number): number | null {
  const dz = Math.abs(z - CZ);
  const r = SUTRO_GROTTO.apertureRadius;
  if (dz >= r) return null;
  return Math.sqrt(r * r - dz * dz);
}

/** Accumulates the collision shell: flat triangle soup, one static body. */
class Shell {
  readonly vertices: number[] = [];
  readonly indices: number[] = [];

  triangle(a: readonly number[], b: readonly number[], c: readonly number[]): void {
    const base = this.vertices.length / 3;
    this.vertices.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    this.indices.push(base, base + 1, base + 2);
  }

  /** A flat rectangle in the y plane. */
  slab(x0: number, x1: number, z0: number, z1: number, y: number): void {
    this.triangle([x0, y, z0], [x1, y, z0], [x1, y, z1]);
    this.triangle([x0, y, z0], [x1, y, z1], [x0, y, z1]);
  }

  /** A vertical quad between two ground points. */
  wall(x0: number, z0: number, x1: number, z1: number, yLow: number, yHigh: number): void {
    this.triangle([x0, yLow, z0], [x1, yLow, z1], [x1, yHigh, z1]);
    this.triangle([x0, yLow, z0], [x1, yHigh, z1], [x0, yHigh, z0]);
  }
}

export function createSutroGrotto(options: { physics?: Physics } = {}): SutroGrotto {
  // Everything below is authored in SITE-LOCAL metres and this one group puts
  // it in the world — which is also what lets reef.ts drive its fish from a
  // positionNode, since a positionNode is read before the model matrix.
  const group = new THREE.Group();
  group.name = "sutro_baths_sunken_gallery";
  group.position.set(SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ);
  group.rotation.y = SUTRO_BATHS.yaw;
  group.visible = false;

  const uTime = uniform(0) as N;

  const timber = new Builder();
  const brass = new Builder();
  const glow = new Builder();
  const plateBuilders = new Map<string, Builder>();
  const white = new THREE.Color(0xffffff);
  let seed = 9000;

  const identity = new THREE.Matrix4();
  const meshes: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  const attach = (
    geometry: THREE.BufferGeometry | null,
    material: THREE.Material,
    name: string,
    ownMaterial = true
  ): THREE.Mesh | null => {
    if (!geometry) return null;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // A sealed room 31 m under a hill: the sun's shadow atlas has no business
    // here, and every light in the room is emissive geometry or a pooled anchor.
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    meshes.push(mesh);
    geometries.push(geometry);
    if (ownMaterial) materials.push(material);
    group.add(mesh);
    return mesh;
  };

  // ---- the two long walls, the two ends ---------------------------------
  // `Builder.setFrame` is what makes three of these four the same code as the
  // hall's wall: each is authored face-at-+x, room-at-−x, bays-along-z, and the
  // frame turns that canonical wall into the one being built.
  const endWallFrame = (faceZ: number, facing: 1 | -1): THREE.Matrix4 => {
    // Canonical wall space is "face at x = 0, room at −x, bays along z". A
    // quarter turn about y sends canonical −x to the room and canonical z
    // across the width, and rotY(∓π/2) keeps det = +1 so winding survives.
    // facing +1 is the far end (its face looks back down −z).
    return new THREE.Matrix4()
      .makeTranslation(CX, 0, faceZ)
      .multiply(new THREE.Matrix4().makeRotationY(facing === 1 ? -Math.PI / 2 : Math.PI / 2));
  };

  /** The plate every wall's boards stand off — the room's actual envelope. */
  const plate = (
    cx: number,
    cz: number,
    sx: number,
    sz: number,
    tone: "dark" | "warm" = "dark"
  ): void => {
    timber.box({
      cx,
      cy: (FLOOR + CEILING) * 0.5,
      cz,
      sx,
      sy: CEILING - FLOOR,
      sz,
      grain: "along-y",
      tint: toneColour(tone, seed++),
      uOffset: hash(seed, 53) * 8,
      vOffset: hash(seed, 71) * 8
    });
  };

  const shellHalf = SUTRO_GROTTO.shell * 0.5;
  plate(X1 + shellHalf, CZ, SUTRO_GROTTO.shell, Z1 - Z0 + SUTRO_GROTTO.shell * 2);
  plate(CX, Z1 + shellHalf, X1 - X0, SUTRO_GROTTO.shell);
  plate(CX, Z0 - shellHalf, X1 - X0, SUTRO_GROTTO.shell);
  // …and deliberately NO plate on the glazed side. Its sill band, head band and
  // seven piers ARE that wall, and the six holes between them are the whole
  // point of the room. (A plate there is a wall behind the windows, which is
  // exactly as much sea as you would expect to see through one.) The collision
  // shell still closes the envelope, so nothing can swim out through a window.

  // The hung wall: twelve bays of the hall's own seven-band section.
  const bayHalf = SUTRO_GROTTO.bayPitch * 0.5 - 0.18;
  for (let bay = 0; bay < SUTRO_GROTTO.bays; bay++) {
    const centreZ = Z0 + SUTRO_GROTTO.bayPitch * (bay + 0.5);
    seed = cladBay({ builder: timber, bands: BANDS, faceX: X1, centreZ, half: bayHalf, seed });
    // …and the pilaster between bays, so the rhythm reads from across the room.
    timber.box({
      cx: X1 - 0.3,
      cy: (FLOOR + CEILING) * 0.5,
      cz: Z0 + SUTRO_GROTTO.bayPitch * bay,
      sx: 0.6,
      sy: CEILING - FLOOR,
      sz: 0.36,
      grain: "along-y",
      tint: toneColour("dark", seed++),
      uOffset: hash(seed, 53) * 8,
      vOffset: hash(seed, 71) * 8
    });
  }

  // The two ends, clad with the same section a quarter turn round.
  for (const [faceZ, facing] of [
    [Z1, 1],
    [Z0, -1]
  ] as const) {
    timber.setFrame(endWallFrame(faceZ, facing));
    const width = X1 - X0;
    const endBays = 3;
    for (let bay = 0; bay < endBays; bay++) {
      const centre = -width * 0.5 + (width / endBays) * (bay + 0.5);
      seed = cladBay({
        builder: timber,
        bands: BANDS,
        faceX: 0,
        centreZ: centre,
        half: width / endBays / 2 - 0.2,
        seed
      });
    }
    timber.setFrame(null);
  }

  // ---- the pictures ------------------------------------------------------
  let artworks = 0;
  for (let bay = 0; bay < HANGS.length; bay++) {
    const entry = HANGS[bay];
    const centreZ = Z0 + SUTRO_GROTTO.bayPitch * (bay + 0.5);
    const size = HANG_SIZES[entry.hang];
    entry.plates.forEach((plateId, slot) => {
      let builder = plateBuilders.get(plateId);
      if (!builder) {
        builder = new Builder();
        plateBuilders.set(plateId, builder);
      }
      artworks++;
      hangPicture({
        sheet: builder,
        timber,
        brass,
        glow,
        faceX: X1,
        fieldProud: FIELD_PROUD,
        centreY: ART_CENTRE_Y,
        centreZ: centreZ + size.offsets[Math.min(slot, size.offsets.length - 1)],
        width: size.width,
        height: size.height,
        frameWidth: 0.13,
        seed: 5000 + artworks * 7
      });
    });
  }

  // ---- the glazed wall ---------------------------------------------------
  // Sill band, head band and seven piers: a wall built the way a glazed wall is
  // built, which is also the only way to get openings out of merged boxes.
  const glassBoards = (cy: number, sy: number, cz: number, sz: number): void => {
    const courses = Math.max(1, Math.round(sy / 0.46));
    for (let i = 0; i < courses; i++) {
      timber.box({
        cx: X0 + 0.13,
        cy: cy - sy * 0.5 + (sy / courses) * (i + 0.5),
        cz,
        sx: 0.26,
        sy: Math.min(0.42, sy / courses - 0.03),
        sz,
        grain: "along-z",
        tint: toneColour(i % 3 === 0 ? "dark" : "warm", seed++),
        uOffset: hash(seed, 53) * 8,
        vOffset: hash(seed, 71) * 8
      });
    }
  };
  const pierWidth = WINDOW.pitch - WINDOW.clearWidth;
  /**
   * Backing for the glazed wall.
   *
   * Everywhere else in this room the boards stand off a solid plate, so the
   * 5 cm reveal between courses is shadow. Here there is no plate — that is the
   * whole point — and the same reveal is a slot straight through to the sea,
   * which reads as a wall leaking daylight. So the sill band, the head band and
   * the seven piers get their own backing, cut to exactly the shape that is not
   * a window.
   */
  const glassBacking = (cy: number, sy: number, cz: number, sz: number): void => {
    timber.box({
      cx: X0 - 0.14,
      cy,
      cz,
      sx: 0.28,
      sy,
      sz,
      grain: "along-y",
      tint: toneColour("dark", seed++),
      uOffset: hash(seed, 53) * 8,
      vOffset: hash(seed, 71) * 8
    });
  };
  glassBacking((FLOOR + WINDOW.sillY) * 0.5, WINDOW.sillY - FLOOR, CZ, Z1 - Z0);
  glassBacking((WINDOW.headY + CEILING) * 0.5, CEILING - WINDOW.headY, CZ, Z1 - Z0);
  glassBoards((FLOOR + WINDOW.sillY) * 0.5, WINDOW.sillY - FLOOR, CZ, Z1 - Z0);
  glassBoards((WINDOW.headY + CEILING) * 0.5, CEILING - WINDOW.headY, CZ, Z1 - Z0);
  for (let pier = 0; pier <= WINDOW.count; pier++) {
    const z = Z0 + WINDOW.pitch * pier;
    glassBacking((WINDOW.sillY + WINDOW.headY) * 0.5, WINDOW.headY - WINDOW.sillY, z, pierWidth);
    timber.box({
      cx: X0 + 0.28,
      cy: (WINDOW.sillY + WINDOW.headY) * 0.5,
      cz: z,
      sx: 0.56,
      sy: WINDOW.headY - WINDOW.sillY,
      sz: pierWidth,
      grain: "along-y",
      tint: toneColour("dark", seed++),
      uOffset: hash(seed, 53) * 8,
      vOffset: hash(seed, 71) * 8
    });
  }

  // Brass mullions and transoms inside every opening, and a rebate all round.
  const glassSoup: { position: number[]; normal: number[]; index: number[] } = {
    position: [],
    normal: [],
    index: []
  };
  for (let window = 0; window < WINDOW.count; window++) {
    const centreZ = Z0 + WINDOW.pitch * (window + 0.5);
    const halfW = WINDOW.clearWidth * 0.5;
    for (const offset of [-halfW / 3, halfW / 3]) {
      brass.box({
        cx: X0 + 0.16,
        cy: (WINDOW.sillY + WINDOW.headY) * 0.5,
        cz: centreZ + offset,
        sx: 0.13,
        sy: WINDOW.headY - WINDOW.sillY,
        sz: 0.15,
        grain: "along-y",
        tint: white,
        uOffset: 0,
        vOffset: 0
      });
    }
    for (const level of [0.34, 0.67]) {
      brass.box({
        cx: X0 + 0.16,
        cy: WINDOW.sillY + (WINDOW.headY - WINDOW.sillY) * level,
        cz: centreZ,
        sx: 0.13,
        sy: 0.13,
        sz: WINDOW.clearWidth,
        grain: "along-z",
        tint: white,
        uOffset: 0,
        vOffset: 0
      });
    }
    // The pane itself: one quad per opening, all six merged into one draw.
    const base = glassSoup.position.length / 3;
    const x = X0 + 0.02;
    for (const [z, y] of [
      [centreZ - halfW, WINDOW.sillY],
      [centreZ + halfW, WINDOW.sillY],
      [centreZ + halfW, WINDOW.headY],
      [centreZ - halfW, WINDOW.headY]
    ] as const) {
      glassSoup.position.push(x, y, z);
      glassSoup.normal.push(1, 0, 0);
    }
    glassSoup.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  // ---- floor, coping and ceiling ----------------------------------------
  // Decking along z, interrupted where the basin is. Every plank knows the
  // basin's own half-span at its x, so the opening in the boards IS the octagon
  // the collision shell and the swim volume use.
  const plankPitch = 0.38;
  const plankCount = Math.floor((X1 - X0) / plankPitch);
  for (let plank = 0; plank < plankCount; plank++) {
    const x = X0 + (X1 - X0) * ((plank + 0.5) / plankCount);
    const span = poolSpanAtX(x);
    const runs: [number, number][] = span === null
      ? [[Z0, Z1]]
      : [
          [Z0, CZ - span],
          [CZ + span, Z1]
        ];
    for (const [z0, z1] of runs) {
      if (z1 - z0 < 0.05) continue;
      timber.box({
        cx: x,
        // Deck boards BUTT. A 4 cm reveal is shadow on a wall with a plate
        // behind it and a hole in a floor with nothing behind it; the plank
        // read comes from the per-board tint and grain offset instead.
        cy: FLOOR - 0.09,
        cz: (z0 + z1) * 0.5,
        sx: plankPitch,
        sy: 0.18,
        sz: z1 - z0,
        grain: "along-z",
        tint: toneColour(hash(plank, 7) < 0.3 ? "dark" : "warm", seed++),
        uOffset: hash(seed, 53) * 8,
        vOffset: hash(seed, 71) * 8
      });
    }
  }

  // Ceiling: planks across the width on a coffer pitch, split round the
  // aperture, with deeper beams on the bay centres.
  const ceilingPitch = 1.05;
  const ceilingCount = Math.floor((Z1 - Z0) / ceilingPitch);
  for (let plank = 0; plank < ceilingCount; plank++) {
    const z = Z0 + (Z1 - Z0) * ((plank + 0.5) / ceilingCount);
    const span = apertureSpanAtZ(z);
    const runs: [number, number][] = span === null
      ? [[X0, X1]]
      : [
          [X0, CX - span],
          [CX + span, X1]
        ];
    for (const [x0, x1] of runs) {
      if (x1 - x0 < 0.05) continue;
      timber.box({
        cx: (x0 + x1) * 0.5,
        cy: CEILING + 0.11,
        cz: z,
        sx: x1 - x0,
        sy: 0.22,
        // Butted, for the same reason as the deck: the only thing above this
        // ceiling is the Pacific.
        sz: ceilingPitch,
        grain: "along-z",
        tint: toneColour(plank % 2 === 0 ? "dark" : "warm", seed++),
        uOffset: hash(seed, 53) * 8,
        vOffset: hash(seed, 71) * 8
      });
    }
  }
  for (let beam = 0; beam <= SUTRO_GROTTO.bays; beam++) {
    const z = Z0 + SUTRO_GROTTO.bayPitch * beam;
    const span = apertureSpanAtZ(z);
    const runs: [number, number][] = span === null
      ? [[X0, X1]]
      : [
          [X0, CX - span],
          [CX + span, X1]
        ];
    for (const [x0, x1] of runs) {
      if (x1 - x0 < 0.05) continue;
      timber.box({
        cx: (x0 + x1) * 0.5,
        cy: CEILING - 0.34,
        cz: z,
        sx: x1 - x0,
        sy: 0.68,
        sz: 0.5,
        grain: "along-z",
        tint: toneColour("dark", seed++),
        uOffset: hash(seed, 53) * 8,
        vOffset: hash(seed, 71) * 8
      });
    }
  }

  /**
   * The cove.
   *
   * A continuous brass reflector under the cornice on both long walls, with a
   * bar of light behind it. The renderer carries exactly one contextual light
   * for the entire world (player/lightPool.ts), so a room this size has to be
   * lit by its own surfaces — and a cove is what a room like this would
   * actually have done, rather than seventeen picture lamps and nothing else.
   */
  for (const [faceX, direction] of [
    [X1, -1],
    [X0, 1]
  ] as const) {
    brass.box({
      cx: faceX + direction * 0.42,
      cy: CEILING - 0.72,
      cz: CZ,
      sx: 0.5,
      sy: 0.14,
      sz: Z1 - Z0,
      grain: "along-z",
      tint: white,
      uOffset: 0,
      vOffset: 0
    });
    glow.box({
      cx: faceX + direction * 0.34,
      cy: CEILING - 0.6,
      cz: CZ,
      sx: 0.3,
      sy: 0.09,
      sz: Z1 - Z0,
      grain: "along-z",
      tint: white,
      uOffset: 0,
      vOffset: 0
    });
  }

  // Bronze rims: one round the aperture the water comes through, one round the
  // basin it lands in.
  const rimMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_grotto_bronze",
    color: 0x8d6a34,
    roughness: 0.34,
    metalness: 0.84
  });
  materials.push(rimMaterial);
  const apertureRim = new THREE.TorusGeometry(SUTRO_GROTTO.apertureRadius + 0.16, 0.24, 8, 44);
  apertureRim.rotateX(Math.PI / 2);
  apertureRim.translate(CX, CEILING - 0.05, CZ);
  attach(apertureRim, rimMaterial, "sutro_grotto_aperture_rim", false);

  const copingVertices = poolVertices();
  const coping = new Builder();
  for (let i = 0; i < copingVertices.length; i++) {
    const [ax, az] = copingVertices[i];
    const [bx, bz] = copingVertices[(i + 1) % copingVertices.length];
    const midX = (ax + bx) * 0.5;
    const midZ = (az + bz) * 0.5;
    const lengthOfEdge = Math.hypot(bx - ax, bz - az);
    const angle = Math.atan2(bz - az, bx - ax);
    const frame = new THREE.Matrix4()
      .makeTranslation(midX, 0, midZ)
      .multiply(new THREE.Matrix4().makeRotationY(-angle));
    coping.setFrame(frame);
    coping.box({
      cx: 0,
      cy: FLOOR - 0.02,
      cz: 0,
      sx: lengthOfEdge + 0.5,
      sy: 0.3,
      sz: 0.62,
      grain: "along-z",
      tint: new THREE.Color(0xb9c2bd),
      uOffset: hash(i, 53) * 8,
      vOffset: hash(i, 71) * 8
    });
    coping.setFrame(null);
  }

  // ---- the basin ---------------------------------------------------------
  const tileMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_grotto_basin_tile",
    color: 0x9fc9cf,
    roughness: 0.32,
    metalness: 0,
    emissive: new THREE.Color(0x2a6d80),
    emissiveIntensity: 0.35
  });
  materials.push(tileMaterial);
  {
    const position: number[] = [];
    const normal: number[] = [];
    const index: number[] = [];
    const pushQuad = (
      a: readonly number[],
      b: readonly number[],
      c: readonly number[],
      d: readonly number[],
      n: readonly number[]
    ): void => {
      const base = position.length / 3;
      for (const point of [a, b, c, d]) {
        position.push(point[0], point[1], point[2]);
        normal.push(n[0], n[1], n[2]);
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    for (let i = 0; i < copingVertices.length; i++) {
      const [ax, az] = copingVertices[i];
      const [bx, bz] = copingVertices[(i + 1) % copingVertices.length];
      const nx = -(bz - az);
      const nz = bx - ax;
      const inv = 1 / Math.hypot(nx, nz);
      pushQuad(
        [ax, SUTRO_GROTTO.poolFloorY, az],
        [bx, SUTRO_GROTTO.poolFloorY, bz],
        [bx, FLOOR, bz],
        [ax, FLOOR, az],
        [-nx * inv, 0, -nz * inv]
      );
    }
    const centreIndex = position.length / 3;
    position.push(CX, SUTRO_GROTTO.poolFloorY, CZ);
    normal.push(0, 1, 0);
    for (let i = 0; i < copingVertices.length; i++) {
      const [ax, az] = copingVertices[i];
      position.push(ax, SUTRO_GROTTO.poolFloorY, az);
      normal.push(0, 1, 0);
    }
    for (let i = 0; i < copingVertices.length; i++) {
      index.push(
        centreIndex,
        centreIndex + 1 + ((i + 1) % copingVertices.length),
        centreIndex + 1 + i
      );
    }
    const basin = new THREE.BufferGeometry();
    basin.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    basin.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    basin.setIndex(index);
    basin.computeBoundingSphere();
    attach(basin, tileMaterial, "sutro_grotto_basin", false);
  }

  // ---- the ringed fall ---------------------------------------------------
  // Three nested curtains at slightly different radii and speeds. Concentric
  // rings of water rushing down is exactly what a wide drain looks like from
  // underneath, and it leaves the middle clear enough to swim down through.
  const fallTop = CEILING;
  const fallBottom = SUTRO_GROTTO.poolSurfaceY;
  const fallHeight = fallTop - fallBottom;
  const curtain = (radius: number, speed: number, opacity: number, index: number): void => {
    const geometry = new THREE.CylinderGeometry(radius, radius * 1.06, fallHeight, 44, 1, true);
    geometry.translate(CX, (fallTop + fallBottom) * 0.5, CZ);
    const material = new THREE.MeshBasicNodeMaterial({ name: `sutro_grotto_fall_${index}` });
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.colorNode = Fn(() => {
      const coord = uv() as N;
      // Streaks running DOWN: v is 0 at the basin, so subtract time.
      const streak = fract(coord.x.mul(26).add(uTime.mul(speed * 0.35)));
      const line = smoothstep(float(0.55), float(0.02), streak).mul(0.7).add(0.3);
      const rush = fract(coord.y.mul(3).add(uTime.mul(speed)).add(coord.x.mul(1.7)));
      const ring = smoothstep(float(0.75), float(0.2), rush);
      // Bright where it leaves the ceiling and where it hits the water.
      const lip = smoothstep(float(0.86), float(1), coord.y).mul(0.35);
      const foot = smoothstep(float(0.16), float(0), coord.y).mul(0.5);
      const body = mix(
        vec3(WATER_BODY.r, WATER_BODY.g, WATER_BODY.b),
        vec3(WATER_PALE.r, WATER_PALE.g, WATER_PALE.b),
        line.mul(ring).saturate()
      );
      const alpha = line.mul(ring.mul(0.7).add(0.3)).mul(opacity).add(lip.mul(0.22)).add(foot.mul(0.2));
      return vec4(body.mul(float(0.85).add(lip).add(foot)), alpha.saturate());
    })() as N;
    attach(geometry, material, `sutro_grotto_fall_${index}`);
  };
  // Three curtains ADD, so each one is a third of what it would be alone —
  // otherwise the middle of the column blows out to flat white and the rings
  // stop being legible, which is the one thing this is for.
  curtain(SUTRO_GROTTO.apertureRadius, 0.55, 0.3, 0);
  curtain(SUTRO_GROTTO.apertureRadius * 0.86, 0.78, 0.2, 1);
  curtain(SUTRO_GROTTO.apertureRadius * 0.7, 1.05, 0.13, 2);

  /**
   * The bore, above the aperture.
   *
   * Look up the middle of the fall and you are looking up the shaft you came
   * down, so there had better be a shaft there: without this you see straight
   * past the ceiling into the open sky, which is a startling thing to find
   * thirty-one metres underground. Ten metres of dark rock tube with the ribs
   * of the drain still turning down it, capped by the pale disc of the plunge
   * far above — the same light the drain's collar is set into.
   */
  {
    const shaftHeight = 11;
    const geometry = new THREE.CylinderGeometry(
      SUTRO_GROTTO.apertureRadius,
      SUTRO_GROTTO.apertureRadius,
      shaftHeight,
      36,
      1,
      true
    );
    geometry.translate(CX, CEILING + shaftHeight * 0.5, CZ);
    const material = new THREE.MeshBasicNodeMaterial({ name: "sutro_grotto_bore" });
    material.side = THREE.BackSide;
    material.colorNode = Fn(() => {
      const coord = uv() as N;
      const climb = coord.y;
      // Dark at the bottom where the room's own light cannot reach, opening to
      // a wash of pool light at the top.
      const daylight = smoothstep(float(0.45), float(1), climb);
      const ribs = fract(coord.x.mul(11).sub(climb.mul(6)).add(uTime.mul(0.5)));
      const rib = smoothstep(float(0.66), float(0.95), ribs).mul(0.12);
      const body = mix(vec3(0.012, 0.02, 0.026), vec3(0.2, 0.42, 0.5), daylight);
      return vec4(body.add(vec3(0.16, 0.3, 0.34).mul(rib)), 1);
    })() as N;
    attach(geometry, material, "sutro_grotto_bore");

    const capGeometry = new THREE.CircleGeometry(SUTRO_GROTTO.apertureRadius, 36);
    capGeometry.rotateX(Math.PI / 2);
    capGeometry.translate(CX, CEILING + shaftHeight, CZ);
    const capMaterial = new THREE.MeshBasicNodeMaterial({ name: "sutro_grotto_bore_cap" });
    capMaterial.side = THREE.DoubleSide;
    capMaterial.colorNode = Fn(() => {
      const radius = length(
        vec3((positionLocal.x as N).sub(CX), float(0), (positionLocal.z as N).sub(CZ))
      ).div(SUTRO_GROTTO.apertureRadius);
      // The tiles of the plunge, seen from underneath and a long way off.
      const centre = smoothstep(float(1.05), float(0.1), radius);
      const shimmer = sin(radius.mul(11).sub(uTime.mul(1.4))).mul(0.5).add(0.5).mul(0.14);
      return vec4(mix(vec3(0.05, 0.12, 0.15), vec3(0.42, 0.72, 0.8), centre).add(shimmer), 1);
    })() as N;
    attach(capGeometry, capMaterial, "sutro_grotto_bore_cap");
  }

  // Spray where it lands: a low flare standing on the water, and the mist that
  // hangs over it.
  {
    const geometry = new THREE.CylinderGeometry(
      SUTRO_GROTTO.apertureRadius * 2.4,
      SUTRO_GROTTO.apertureRadius * 1.05,
      3.1,
      40,
      1,
      true
    );
    geometry.translate(CX, fallBottom + 1.4, CZ);
    const material = new THREE.MeshBasicNodeMaterial({ name: "sutro_grotto_spray" });
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.blending = THREE.AdditiveBlending;
    material.colorNode = Fn(() => {
      const coord = uv() as N;
      const billow = sin(coord.x.mul(19).add(uTime.mul(1.3)))
        .mul(sin(coord.y.mul(7).sub(uTime.mul(0.9))))
        .mul(0.5)
        .add(0.5);
      const rise = smoothstep(float(1), float(0.05), coord.y).mul(smoothstep(float(0), float(0.12), coord.y));
      return vec4(vec3(0.72, 0.94, 1), rise.mul(billow.mul(0.7).add(0.3)).mul(0.16));
    })() as N;
    attach(geometry, material, "sutro_grotto_spray");
  }

  // ---- the water in the basin -------------------------------------------
  // Rings running OUT from where the fall lands, which is the same ringed idea
  // read from above.
  {
    const position: number[] = [];
    const normal: number[] = [];
    const index: number[] = [];
    const centreIndex = 0;
    position.push(CX, SUTRO_GROTTO.poolSurfaceY, CZ);
    normal.push(0, 1, 0);
    for (const [ax, az] of copingVertices) {
      position.push(ax, SUTRO_GROTTO.poolSurfaceY, az);
      normal.push(0, 1, 0);
    }
    for (let i = 0; i < copingVertices.length; i++) {
      index.push(centreIndex, centreIndex + 1 + i, centreIndex + 1 + ((i + 1) % copingVertices.length));
    }
    const sheet = new THREE.BufferGeometry();
    sheet.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
    sheet.setAttribute("normal", new THREE.Float32BufferAttribute(normal, 3));
    sheet.setIndex(index);
    sheet.computeBoundingSphere();
    const material = new THREE.MeshBasicNodeMaterial({ name: "sutro_grotto_water" });
    material.transparent = true;
    material.depthWrite = false;
    material.side = THREE.DoubleSide;
    material.colorNode = Fn(() => {
      // Distance from the fall, taken in the mesh's own space so the rings are
      // concentric with the column whatever the site's yaw is.
      const local = length(
        vec3((positionLocal.x as N).sub(CX), float(0), (positionLocal.z as N).sub(CZ))
      );
      const rings = fract(local.mul(0.55).sub(uTime.mul(0.5)));
      const crest = smoothstep(float(0.62), float(0.92), rings).mul(
        smoothstep(float(1), float(0.94), rings)
      );
      const near = smoothstep(float(9), float(2.6), local);
      const chop = sin(local.mul(6).sub(uTime.mul(2.2))).mul(0.5).add(0.5).mul(near).mul(0.25);
      const body = mix(
        vec3(0.05, 0.24, 0.31),
        vec3(WATER_PALE.r, WATER_PALE.g, WATER_PALE.b),
        crest.mul(0.8).add(chop)
      );
      const depth = smoothstep(float(1.5), float(9), cameraPosition.distance(positionWorld));
      return vec4(body, mix(float(0.62), float(0.88), depth));
    })() as N;
    attach(sheet, material, "sutro_grotto_water");
  }

  // ---- materials ---------------------------------------------------------
  const timberMaterials = createTimberMaterials("sutro_grotto");
  const timberMaterial = timberMaterials.timber;
  const brassMaterial = timberMaterials.brass;
  const glowMaterial = timberMaterials.glow;
  materials.push(timberMaterial, brassMaterial, glowMaterial);

  const copingMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_grotto_coping",
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0,
    vertexColors: true
  });
  materials.push(copingMaterial);

  const glassMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_grotto_glass",
    color: 0xbfe6ef,
    roughness: 0.08,
    metalness: 0,
    transparent: true,
    opacity: 0.14,
    side: THREE.DoubleSide
  });
  glassMaterial.depthWrite = false;
  materials.push(glassMaterial);

  const plateMaterials = new Map<string, THREE.MeshStandardNodeMaterial>();
  for (const plateId of plateBuilders.keys()) {
    const material = new THREE.MeshStandardNodeMaterial({
      name: `sutro_grotto_art_${plateId}`,
      color: 0xffffff,
      roughness: 0.86,
      metalness: 0,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0
    });
    plateMaterials.set(plateId, material);
    materials.push(material);
  }

  attach(timber.build("sutro_grotto_boards", identity, true), timberMaterial, "sutro_grotto_boards", false);
  attach(brass.build("sutro_grotto_brass", identity, true), brassMaterial, "sutro_grotto_brass", false);
  attach(glow.build("sutro_grotto_picture_lights", identity, true), glowMaterial, "sutro_grotto_picture_lights", false);
  attach(coping.build("sutro_grotto_coping", identity, true), copingMaterial, "sutro_grotto_coping", false);
  for (const [plateId, builder] of plateBuilders) {
    attach(
      builder.build(`sutro_grotto_art_${plateId}`, identity, false),
      plateMaterials.get(plateId)!,
      `sutro_grotto_art_${plateId}`,
      false
    );
  }
  {
    const glass = new THREE.BufferGeometry();
    glass.setAttribute("position", new THREE.Float32BufferAttribute(glassSoup.position, 3));
    glass.setAttribute("normal", new THREE.Float32BufferAttribute(glassSoup.normal, 3));
    glass.setIndex(glassSoup.index);
    glass.computeBoundingSphere();
    const pane = attach(glass, glassMaterial, "sutro_grotto_glass", false);
    // The reef is opaque and the sea shell encloses it, so the panes only ever
    // need to composite over already-resolved colour. Draw them last.
    if (pane) pane.renderOrder = 1;
  }

  // ---- the reef ----------------------------------------------------------
  const reef: SutroReef = createSutroReef();
  group.add(reef.group);

  // ---- light -------------------------------------------------------------
  // Emissive geometry does the room; the pooled contextual light does the body
  // standing in it. Never a new scene light — see player/lightPool.ts.
  const lampSpecs: LightAnchorSpec[] = [];
  const lightAnchors: THREE.Object3D[] = [];
  const unregisterLights: (() => void)[] = [];
  const anchorAt = (lx: number, ly: number, lz: number, color: number, intensity: number, distance: number) => {
    const spec: LightAnchorSpec = { color, intensity, distance, range: 46 };
    // Site-local, parented to the room's own group: the pool reads anchors with
    // getWorldPosition, and `isEffectivelyVisible` walks the same chain — so a
    // hidden room releases its light slot without a line of code.
    const anchor = lightAnchor(spec, lx, ly, lz);
    anchor.name = `sutro_grotto_light_${lampSpecs.length}`;
    lampSpecs.push(spec);
    group.add(anchor);
    lightAnchors.push(anchor);
    unregisterLights.push(registerAmbientLightAnchor(anchor));
  };

  // ---- collision ---------------------------------------------------------
  const shell = new Shell();
  {
    // Floor: four rectangles round the basin's bounding square, then the four
    // corner triangles that turn that square into the octagon.
    shell.slab(X0, CX - POOL_R, Z0, Z1, FLOOR);
    shell.slab(CX + POOL_R, X1, Z0, Z1, FLOOR);
    shell.slab(CX - POOL_R, CX + POOL_R, Z0, CZ - POOL_R, FLOOR);
    shell.slab(CX - POOL_R, CX + POOL_R, CZ + POOL_R, Z1, FLOOR);
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1]
    ] as const) {
      shell.triangle(
        [CX + sx * POOL_R, FLOOR, CZ + sz * POOL_R],
        [CX + sx * POOL_R, FLOOR, CZ + sz * POOL_B],
        [CX + sx * POOL_B, FLOOR, CZ + sz * POOL_R]
      );
    }
    // The basin: eight walls and an eight-triangle floor.
    for (let i = 0; i < copingVertices.length; i++) {
      const [ax, az] = copingVertices[i];
      const [bx, bz] = copingVertices[(i + 1) % copingVertices.length];
      shell.wall(ax, az, bx, bz, SUTRO_GROTTO.poolFloorY, FLOOR);
      shell.triangle(
        [CX, SUTRO_GROTTO.poolFloorY, CZ],
        [ax, SUTRO_GROTTO.poolFloorY, az],
        [bx, SUTRO_GROTTO.poolFloorY, bz]
      );
    }
    // The envelope. A solid ceiling on purpose: nothing in this room can jump
    // eleven metres, and a hole in it is one more edge to fall through.
    shell.wall(X0, Z0, X0, Z1, FLOOR, CEILING);
    shell.wall(X1, Z0, X1, Z1, FLOOR, CEILING);
    shell.wall(X0, Z0, X1, Z0, FLOOR, CEILING);
    shell.wall(X0, Z1, X1, Z1, FLOOR, CEILING);
    shell.slab(X0, X1, Z0, Z1, CEILING);
  }

  let collisionBody: number | null = null;
  const physics = options.physics;
  if (physics) {
    collisionBody = physics.world.createStaticMesh({
      position: [SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ],
      vertices: shell.vertices,
      indices: shell.indices,
      friction: 0.75
    });
    const yaw = SUTRO_BATHS.yaw;
    physics.world.setBodyTransform(
      collisionBody,
      [SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ],
      [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]
    );
  }

  // ---- what the rest of the world needs to know about this room ---------
  const poolWorldCorners = poolVertices().map(([lx, lz]) => sutroLocalToWorld(lx, lz));
  const roomWorldCorners = [
    [X0, Z0],
    [X0, Z1],
    [X1, Z0],
    [X1, Z1]
  ].map(([lx, lz]) => sutroLocalToWorld(lx, lz));
  // "There is authored floor thirty-one metres down here." Without it the walk
  // controller's fell-through-the-world net respawns every visitor onto the
  // bath deck on their first frame in the room — see world/interiorVolumes.ts.
  const releaseInteriorVolume = registerInteriorVolume({
    id: "sutro-grotto",
    minX: Math.min(...roomWorldCorners.map((corner) => corner.x)) - 2,
    maxX: Math.max(...roomWorldCorners.map((corner) => corner.x)) + 2,
    minY: SUTRO_GROTTO.poolFloorY - 3,
    maxY: CEILING + 3,
    minZ: Math.min(...roomWorldCorners.map((corner) => corner.z)) - 2,
    maxZ: Math.max(...roomWorldCorners.map((corner) => corner.z)) + 2,
    contains: (x, y, z) => sutroGrottoContains(x, y, z, 2)
  });

  const releaseSwimVolume = registerSwimVolume({
    id: "sutro-grotto-basin",
    surfaceY: SUTRO_GROTTO.poolSurfaceY,
    floorY: SUTRO_GROTTO.poolFloorY,
    minX: Math.min(...poolWorldCorners.map((corner) => corner.x)),
    maxX: Math.max(...poolWorldCorners.map((corner) => corner.x)),
    minZ: Math.min(...poolWorldCorners.map((corner) => corner.z)),
    maxZ: Math.max(...poolWorldCorners.map((corner) => corner.z)),
    contains: (x, z) => sutroGrottoPoolContains(x, z),
    // Coping is 42 cm above the water and a swimmer has no jump, so without
    // this the basin is a bath you fall into and never leave.
    climbOutY: () => SUTRO_GROTTO.floorY
  });

  anchorAt(CX, SUTRO_GROTTO.poolSurfaceY + 2.6, CZ, 0x9fe8ff, 46, 26);
  anchorAt(CX + 3, ART_CENTRE_Y + 1.4, Z0 + 16, 0xffd79a, 34, 22);
  anchorAt(CX + 3, ART_CENTRE_Y + 1.4, Z1 - 16, 0xffd79a, 34, 22);

  // ---- textures ----------------------------------------------------------
  const grainLoad = loadTimberGrain(loadTexture, timberMaterial, brassMaterial, textures);
  const plateLoads = [...plateMaterials].map(([plateId, material]) =>
    loadTexture(`${ART_ROOT}/${plateId}`, { srgb: true, anisotropy: 8, webpOnly: true }).then(
      (texture) => {
        texture.needsUpdate = true;
        textures.push(texture);
        material.map = texture;
        // The plates are the only thing in here with any daylight in them, and
        // the room has none. They carry their own small glow, ramped below.
        material.emissiveMap = texture;
        material.needsUpdate = true;
      }
    )
  );
  const ready = Promise.all([grainLoad, ...plateLoads])
    .then(() => undefined)
    .catch((error) => {
      console.warn("[sutro-baths] sunken gallery textures unavailable:", error);
    });

  // ---- grade -------------------------------------------------------------
  let twilight = 1;
  const baseTimber = timberMaterial.color.clone();
  const baseBrass = brassMaterial.color.clone();
  const applyGrade = (): void => {
    timberMaterial.color.copy(baseTimber).lerp(LAMP_TINT, twilight * TIMBER_TINT_MIX);
    timberMaterial.emissive.copy(LAMP_TINT);
    timberMaterial.emissiveIntensity = twilight * TIMBER_SELF_GLOW;
    brassMaterial.color.copy(baseBrass).lerp(LAMP_TINT, twilight * 0.45);
    glowMaterial.emissiveIntensity = twilight * PICTURE_LIGHT_GLOW;
    for (const material of plateMaterials.values()) {
      material.emissiveIntensity = twilight * ART_SELF_GLOW;
    }
  };
  applyGrade();

  const triangles = geometries.reduce(
    (total, geometry) => total + (geometry.getIndex()?.count ?? 0) / 3,
    0
  );
  const stats = {
    boards: timber.boxes,
    artworks,
    plates: plateMaterials.size,
    draws: meshes.length,
    triangles,
    reefDraws: reef.stats.draws,
    reefTriangles: reef.stats.triangles,
    fish: reef.stats.fish,
    plants: reef.stats.plants
  };

  return {
    group,
    ready,
    setTwilight(depth) {
      const next = THREE.MathUtils.clamp(depth, 0, 1);
      if (Math.abs(next - twilight) < 1e-3) return;
      twilight = next;
      applyGrade();
    },
    update(time) {
      uTime.value = time;
      reef.update(time);
      for (let i = 0; i < lampSpecs.length; i++) {
        // The fall throws light that moves; the picture lamps barely breathe.
        const drift = i === 0
          ? 0.86 + Math.sin(time * 1.9) * 0.1 + Math.sin(time * 3.7) * 0.04
          : 0.975 + Math.sin(time * 2.1 + i * 2.71) * 0.025;
        lampSpecs[i].intensity = (i === 0 ? 46 : 34) * drift;
      }
    },
    stats,
    dispose() {
      releaseSwimVolume();
      releaseInteriorVolume();
      for (const unregister of unregisterLights) unregister();
      for (const anchor of lightAnchors) anchor.removeFromParent();
      lightAnchors.length = 0;
      if (collisionBody !== null && physics) physics.world.destroyBody(collisionBody);
      collisionBody = null;
      reef.dispose();
      for (const mesh of meshes) mesh.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of textures) texture.dispose();
      meshes.length = 0;
      geometries.length = 0;
      materials.length = 0;
      textures.length = 0;
      group.clear();
      group.removeFromParent();
    }
  };
}
