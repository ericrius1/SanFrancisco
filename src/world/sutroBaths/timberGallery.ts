import * as THREE from "three/webgpu";
import { loadTexture } from "../../render/textures";
import { SUTRO_BATHS, SUTRO_WALL } from "./layout";

/**
 * The inland wall as a timber gallery: boards, rails and hung chromolithographs.
 *
 * WHY THIS IS RUNTIME AND NOT AUTHORED
 * The bleachers that used to hang across this wall are gone from the Blender
 * source, and the wall behind them is a plain plate with a colonnade of
 * pilasters (see SUTRO_WALL in layout.ts, asserted by
 * tools/rebuild-sutro-inland-gallery.py). Everything in front of that plate is
 * built here because it carries TEXTURES, and an authored-GLB material cannot:
 * applyRegionMaterialize (world/authoredRegions.ts) replaces each authored
 * material with a node twin whose colorNode already owns the birth fade, so a
 * map assigned to it afterwards never reaches a pixel.
 *
 * WHAT IT IS
 * Seven horizontal bands, dark and grounding at the bottom, warm mid-century
 * boards above, banded by rails that catch the lamps:
 *
 *   plinth      5.62 → 6.52   dark, heavy courses on the deck
 *   dado        6.52 → 8.42   dark vertical slats — the log-cabin register
 *   chair rail  8.42 → 8.74   dark, standing proud: the room's strong horizontal
 *   art field   8.74 → 17.22  warm wide boards; the pictures hang here
 *   picture rail 17.22 → 17.6 dark cap over the art
 *   clerestory  17.6 → 24.95  warm vertical slats, the mid-century slat wall
 *   cornice     24.95 → 25.5  dark, deepest projection, under the roof spring
 *
 * ONE TILE, MANY WOODS
 * There is a single neutral grain tile (tools/build-sutro-hall-textures.mjs) and
 * every board multiplies its own tint into it through vertex colour. That is
 * what gets a dark grounding timber and a warm honey board out of one 1024²
 * pair, keeps the whole 1000-board wall in ONE draw submission, and lets a
 * scattering of boards run deliberately off-tone so the wall reads as stock that
 * was mixed rather than printed. Per-board UV jitter means no two boards show
 * the same figure even though they share the tile.
 *
 * DRAWS: one timber mesh (boards, rails, frames), one brass mesh (plaques and
 * picture-light hoods), one emissive mesh (the light bars), and one quad mesh per
 * unique plate.
 */

/** Metres of wall per grain tile. Mirrors TILE_METRES in the texture builder. */
const TIMBER_TILE_M = 1.5;
const TIMBER_ROOT = "/sutro/timber";
const ART_ROOT = "/sutro/art";

/** Lamplight, the same warm the hall grade drifts every other surface toward. */
const LAMP_TINT = /*@__PURE__*/ new THREE.Color(0xffb469);
/**
 * Grade strengths, sized against the hall's measured ambient the same way
 * staticAmbience.ts sizes its own (scene.environmentIntensity ~0.14 at the
 * pocket's held hour). Emissive is UNLIT, so it can only ever be a shadow floor
 * here — the tint does the "lit by gas globes" work.
 */
const TIMBER_SELF_GLOW = 0.035;
const TIMBER_TINT_MIX = 0.17;
/** The art is what the room is for: it keeps reading after the sun goes. */
const ART_SELF_GLOW = 0.5;
const PICTURE_LIGHT_GLOW = 5.2;

type Tone = "dark" | "warm";

type Band = {
  id: string;
  y0: number;
  y1: number;
  tone: Tone;
  /** Metres the band's face stands in front of the wall plate. */
  proud: number;
} & (
  | { layout: "courses"; coursePitch: number; courseHeight: number }
  | { layout: "slats"; slatPitch: number; slatWidth: number }
);

const BANDS: readonly Band[] = [
  {
    id: "plinth",
    y0: SUTRO_BATHS.deckY,
    y1: 6.52,
    tone: "dark",
    proud: 0.26,
    layout: "courses",
    coursePitch: 0.45,
    courseHeight: 0.41
  },
  {
    id: "dado",
    y0: 6.52,
    y1: SUTRO_WALL.bandLowY,
    tone: "dark",
    proud: 0.18,
    layout: "slats",
    slatPitch: 0.36,
    slatWidth: 0.28
  },
  {
    id: "chair-rail",
    y0: SUTRO_WALL.bandLowY,
    y1: 8.74,
    tone: "dark",
    proud: 0.34,
    layout: "courses",
    coursePitch: 0.32,
    courseHeight: 0.32
  },
  {
    // Runs PAST the authored panel band's 17.22 top on purpose: the plate behind
    // continues to the roof spring, and stopping the boards at the panel left a
    // squeezed picture band under an enormous empty slat wall.
    id: "art-field",
    y0: 8.74,
    y1: 19.4,
    tone: "warm",
    proud: 0.16,
    layout: "courses",
    coursePitch: 0.48,
    courseHeight: 0.43
  },
  {
    id: "picture-rail",
    y0: 19.4,
    y1: 19.82,
    tone: "dark",
    proud: 0.32,
    layout: "courses",
    coursePitch: 0.42,
    courseHeight: 0.42
  },
  {
    id: "clerestory",
    y0: 19.82,
    y1: 24.95,
    tone: "warm",
    proud: 0.14,
    layout: "slats",
    slatPitch: 0.4,
    slatWidth: 0.3
  },
  {
    id: "cornice",
    y0: 24.95,
    y1: SUTRO_BATHS.roofSpringY,
    tone: "dark",
    proud: 0.44,
    layout: "courses",
    coursePitch: 0.55,
    courseHeight: 0.55
  }
];

/**
 * Board tints, as sRGB hex multiplied into the neutral grain tile.
 *
 * `feature` is the mix: a dark plank landed among the honey boards and a warm
 * one among the dark, roughly one board in seven, which is the difference
 * between a timber wall and a painted one.
 */
const TONES: Record<Tone, { base: number; feature: number }> = {
  dark: { base: 0x4a2f20, feature: 0x7d5433 },
  warm: { base: 0xb07b45, feature: 0x5c3a24 }
};

type ArtLayout = "wide" | "tall" | "pair";

type ArtBay = { bay: number; layout: ArtLayout; plates: readonly string[] };

/**
 * What hangs where. Fourteen bays of full-height wall, seventeen pictures, and
 * no plate hung twice anywhere on the wall.
 *
 * The earlier hang had eight plates in eighteen slots, so every picture appeared
 * two or three times — and at 9.5 m centres a repeat is legible from anywhere on
 * the deck, which made 133 m of wall read as wallpaper. One of the four paired
 * bays became a single hang, which is also a better rhythm: a pair reads as a
 * deliberate diptych when it is occasional and as a default when it is every
 * third bay.
 *
 * Ordering rule beyond "no repeats": the four quiet plates — the two natural
 * history / architectural sheets and the two most typographic bills — are spread
 * so that no two land in adjacent bays. They are the plates that reward walking
 * up to them, and clustering them would leave one end of the wall shouting and
 * the other end silent.
 */
const ART_BAYS: readonly ArtBay[] = [
  { bay: -8, layout: "wide", plates: ["hall-pacific-plunge"] },
  { bay: -7, layout: "pair", plates: ["bill-grand-opening", "plate-tropical-ferns"] },
  { bay: -6, layout: "wide", plates: ["hall-seal-rocks"] },
  { bay: -5, layout: "tall", plates: ["bill-swimming-carnival"] },
  { bay: -4, layout: "wide", plates: ["hall-conservatory-palms"] },
  { bay: -3, layout: "pair", plates: ["plate-museum-curios", "bill-bathing-suits"] },
  { bay: -2, layout: "wide", plates: ["hall-carnival-night"] },
  { bay: -1, layout: "tall", plates: ["bill-sutro-railroad"] },
  { bay: 0, layout: "wide", plates: ["hall-toboggan-slides"] },
  { bay: 1, layout: "pair", plates: ["plate-natatorium-section", "plate-pacific-shells"] },
  { bay: 2, layout: "wide", plates: ["hall-tide-tunnel"] },
  { bay: 3, layout: "tall", plates: ["hall-high-dive"] },
  { bay: 4, layout: "wide", plates: ["hall-sutro-heights"] },
  { bay: 5, layout: "tall", plates: ["bill-winter-sea"] }
];

/**
 * Picture sizes, metres — the wide plates are 3:2 and the portrait plates 2:3, so
 * these are the plate aspects exactly and nothing is stretched.
 *
 * Sized for the room, not for a gallery wall: the visitor's eye is 1.7 m above a
 * deck 3 m below the picture band and typically 10-25 m out across the water, so
 * a "normal" 2 m canvas would read as a postage stamp. A 7.4 m sheet subtends
 * about the same angle from the far rim as a large framed print does across a
 * living room.
 */
const ART_CENTRE_Y = 13.5;
const ART_SIZES: Record<ArtLayout, { width: number; height: number; offsets: readonly number[] }> = {
  wide: { width: 7.4, height: 4.93, offsets: [0] },
  tall: { width: 4.0, height: 6.0, offsets: [0] },
  pair: { width: 3.3, height: 4.95, offsets: [-2.3, 2.3] }
};

/**
 * The art field's own projection, and the picture stack in front of it: the sheet
 * sits 2 cm off the boards, the moulding stands 7 cm off the sheet.
 */
const FIELD_PROUD = 0.16;
const ART_PROUD = FIELD_PROUD + 0.02;
const FRAME_DEPTH = 0.07;
const FRAME_WIDTH = 0.19;
/**
 * Every board's back face stops a centimetre short of the wall plate. Landing it
 * exactly ON the plate would put two opaque faces in the same plane, which is a
 * z-fight waiting for a distant camera and a shallow depth range.
 */
const WALL_CLEARANCE = 0.01;

export type SutroTimberGallery = {
  group: THREE.Group;
  /** Resolves once the grain and every plate have landed, so the site's covered
   *  warm compiles the FINAL material graphs rather than untextured ones. */
  ready: Promise<void>;
  /** 0 = daylight, 1 = deep in the pocket's twilight. */
  setTwilight(depth: number): void;
  readonly stats: {
    boards: number;
    artworks: number;
    plates: number;
    draws: number;
    triangles: number;
  };
  dispose(): void;
};

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

type Grain = "along-z" | "along-y";

type BoxSpec = {
  /** Site-local centre. */
  cx: number;
  cy: number;
  cz: number;
  /** Full sizes. */
  sx: number;
  sy: number;
  sz: number;
  grain: Grain;
  /** Vertex colour, already in the renderer's working space. */
  tint: THREE.Color;
  uOffset: number;
  vOffset: number;
};

/** Accumulates one merged, static geometry — see the draw budget in the header. */
class Builder {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];
  boxes = 0;

  /**
   * A board, as six quads.
   *
   * Each face is generated from a basis whose u × v IS the outward normal, which
   * is what guarantees front-facing winding on all six without six hand-written
   * corner lists to get subtly wrong. Texture UVs are separate: they come from
   * the board's own SITE-LOCAL position in the grain plane, so the tile scale is
   * identical on every board whatever its size, and the per-board offsets
   * decorrelate them.
   */
  box(spec: BoxSpec): void {
    const { cx, cy, cz, sx, sy, sz, grain, tint, uOffset, vOffset } = spec;
    const half: readonly [number, number, number] = [sx * 0.5, sy * 0.5, sz * 0.5];
    const centre: readonly [number, number, number] = [cx, cy, cz];
    // [axis of the normal, its sign, u axis, v axis] with u × v = +normal.
    const faces: readonly [number, number, number, number][] = [
      [0, -1, 2, 1], // -x, the face the hall sees: z × y = -x
      [0, 1, 1, 2], //  +x: y × z = +x
      [1, 1, 2, 0], //  +y: z × x = +y
      [1, -1, 0, 2], // -y: x × z = -y
      [2, 1, 0, 1], //  +z: x × y = +z
      [2, -1, 1, 0] //  -z: y × x = -z
    ];
    for (const [axis, sign, uAxis, vAxis] of faces) {
      const base = this.position.length / 3;
      for (const [su, sv] of [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1]
      ] as const) {
        const point: [number, number, number] = [centre[0], centre[1], centre[2]];
        point[axis] += half[axis] * sign;
        point[uAxis] += half[uAxis] * su;
        point[vAxis] += half[vAxis] * sv;
        this.position.push(point[0], point[1], point[2]);
        this.normal.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
        const grainU = grain === "along-z" ? point[2] : point[1];
        const grainV = grain === "along-z" ? point[1] : point[2];
        this.uv.push(grainU / TIMBER_TILE_M + uOffset, grainV / TIMBER_TILE_M + vOffset);
        this.color.push(tint.r, tint.g, tint.b);
      }
      this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.boxes++;
  }

  /** A single quad facing the hall (-x), UV 0..1, for a hung picture. */
  quad(x: number, centreY: number, centreZ: number, width: number, height: number): void {
    const base = this.position.length / 3;
    const z0 = centreZ - width * 0.5;
    const z1 = centreZ + width * 0.5;
    const y0 = centreY - height * 0.5;
    const y1 = centreY + height * 0.5;
    // Looking along +x with +y up puts local +z on the viewer's right, and three
    // samples v from the bottom — so u runs with z and v runs with y.
    const corners: readonly [number, number, number, number][] = [
      [x, y0, z0, 0],
      [x, y0, z1, 1],
      [x, y1, z1, 1],
      [x, y1, z0, 0]
    ];
    let corner = 0;
    for (const [px, py, pz, u] of corners) {
      this.position.push(px, py, pz);
      this.normal.push(-1, 0, 0);
      this.uv.push(u, corner < 2 ? 0 : 1);
      this.color.push(1, 1, 1);
      corner++;
    }
    this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.boxes++;
  }

  build(name: string, matrix: THREE.Matrix4, withColor: boolean): THREE.BufferGeometry | null {
    if (this.index.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.name = name;
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(this.position, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normal, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    if (withColor) geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.color, 3));
    geometry.setIndex(this.index);
    // Authored in site-local metres, then rotated and dropped onto the world
    // once — the same frame layout.ts and the Blender source both speak.
    geometry.applyMatrix4(matrix);
    geometry.computeBoundingSphere();
    return geometry;
  }
}

/** Deterministic per-board noise: the wall must be identical every visit. */
function hash(index: number, salt: number): number {
  let value = Math.imul(index + 1, 374761393) ^ Math.imul(salt + 1, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

/** Bay centre and the clear span between its two pilasters. */
function bayFrame(bay: number): { centreZ: number; half: number } {
  const centreZ = SUTRO_WALL.pitch * (bay + 0.5);
  // Stop clear of both pilasters so the boards read as infill between them.
  const half = SUTRO_WALL.pitch * 0.5 - SUTRO_WALL.pilasterHalf - 0.03;
  return { centreZ, half };
}

export function createSutroTimberGallery(): SutroTimberGallery {
  const group = new THREE.Group();
  group.name = "sutro_baths_timber_gallery";

  const timber = new Builder();
  const brass = new Builder();
  const glow = new Builder();
  const artBuilders = new Map<string, Builder>();

  const toneColour = (tone: Tone, seed: number): THREE.Color => {
    const palette = TONES[tone];
    const feature = hash(seed, 11) < 0.18;
    const colour = new THREE.Color(feature ? palette.feature : palette.base);
    // Board-to-board exposure and a little hue drift, so no two planks out of
    // the same stack are quite the same piece of wood.
    const level = 0.8 + hash(seed, 23) * 0.44;
    const warmth = 0.97 + hash(seed, 37) * 0.07;
    colour.multiplyScalar(level);
    colour.r = Math.min(1, colour.r * warmth);
    colour.b = Math.min(1, colour.b / warmth);
    return colour;
  };

  let boardSeed = 0;
  const pushBoard = (
    tone: Tone,
    grain: Grain,
    centreY: number,
    centreZ: number,
    height: number,
    width: number,
    proud: number
  ): void => {
    const seed = boardSeed++;
    timber.box({
      cx: SUTRO_WALL.faceX - WALL_CLEARANCE - proud * 0.5,
      cy: centreY,
      cz: centreZ,
      sx: proud,
      sy: height,
      sz: width,
      grain,
      tint: toneColour(tone, seed),
      // Jitter in whole-ish tiles: each board is cut from somewhere else in the
      // stock, which is what hides the tile's 1.5 m repeat along a long board.
      uOffset: hash(seed, 53) * 8,
      vOffset: hash(seed, 71) * 8
    });
  };

  // ---- the boards -------------------------------------------------------
  for (let bay = SUTRO_WALL.firstBay; bay <= SUTRO_WALL.lastBay; bay++) {
    const { centreZ, half } = bayFrame(bay);
    for (const band of BANDS) {
      if (band.layout === "courses") {
        const span = band.y1 - band.y0;
        const count = Math.max(1, Math.floor(span / band.coursePitch));
        const pitch = span / count;
        for (let course = 0; course < count; course++) {
          const y = band.y0 + pitch * (course + 0.5);
          pushBoard(
            band.tone,
            "along-z",
            y,
            centreZ,
            Math.min(band.courseHeight, pitch - 0.03),
            half * 2,
            band.proud
          );
        }
      } else {
        const span = half * 2;
        const count = Math.max(1, Math.round(span / band.slatPitch));
        const pitch = span / count;
        const height = band.y1 - band.y0 - 0.04;
        const centreBandY = (band.y0 + band.y1) * 0.5;
        for (let slat = 0; slat < count; slat++) {
          const z = centreZ - half + pitch * (slat + 0.5);
          pushBoard(
            band.tone,
            "along-y",
            centreBandY,
            z,
            height,
            Math.min(band.slatWidth, pitch - 0.05),
            band.proud
          );
        }
      }
    }
  }

  // ---- the pictures, their frames, plaques and picture lights ------------
  let artworks = 0;
  for (const entry of ART_BAYS) {
    const { centreZ } = bayFrame(entry.bay);
    const size = ART_SIZES[entry.layout];
    entry.plates.forEach((plate, slot) => {
      const offset = size.offsets[Math.min(slot, size.offsets.length - 1)];
      const z = centreZ + offset;
      const canvasX = SUTRO_WALL.faceX - ART_PROUD;
      const frameX = canvasX - FRAME_DEPTH;
      const halfW = size.width * 0.5;
      const halfH = size.height * 0.5;

      let builder = artBuilders.get(plate);
      if (!builder) {
        builder = new Builder();
        artBuilders.set(plate, builder);
      }
      builder.quad(canvasX, ART_CENTRE_Y, z, size.width, size.height);
      artworks++;

      // Moulding: four members of dark stock around the sheet, standing off the
      // boards so the frame throws its own line under the picture lights.
      const seed = 5000 + artworks * 7;
      const frameTint = toneColour("dark", seed);
      const member = (
        cy: number,
        cz: number,
        sy: number,
        sz: number,
        grain: Grain
      ): void => {
        timber.box({
          cx: (frameX + (SUTRO_WALL.faceX - FIELD_PROUD)) * 0.5,
          cy,
          cz,
          sx: SUTRO_WALL.faceX - FIELD_PROUD - frameX,
          sy,
          sz,
          grain,
          tint: frameTint,
          uOffset: hash(seed, 91) * 8,
          vOffset: hash(seed, 97) * 8
        });
      };
      member(ART_CENTRE_Y + halfH + FRAME_WIDTH * 0.5, z, FRAME_WIDTH, size.width + FRAME_WIDTH * 2, "along-z");
      member(ART_CENTRE_Y - halfH - FRAME_WIDTH * 0.5, z, FRAME_WIDTH, size.width + FRAME_WIDTH * 2, "along-z");
      member(ART_CENTRE_Y, z - halfW - FRAME_WIDTH * 0.5, size.height, FRAME_WIDTH, "along-y");
      member(ART_CENTRE_Y, z + halfW + FRAME_WIDTH * 0.5, size.height, FRAME_WIDTH, "along-y");

      // A brass plate under the picture, and a hooded lamp over it.
      brass.box({
        cx: SUTRO_WALL.faceX - 0.19,
        cy: ART_CENTRE_Y - halfH - 0.62,
        cz: z,
        sx: 0.04,
        sy: 0.15,
        sz: 0.92,
        grain: "along-z",
        tint: new THREE.Color(0xffffff),
        uOffset: 0,
        vOffset: 0
      });
      const hoodY = ART_CENTRE_Y + halfH + 0.66;
      brass.box({
        cx: SUTRO_WALL.faceX - 0.42,
        cy: hoodY,
        cz: z,
        sx: 0.46,
        sy: 0.13,
        sz: 1.15,
        grain: "along-z",
        tint: new THREE.Color(0xffffff),
        uOffset: 0,
        vOffset: 0
      });
      brass.box({
        cx: SUTRO_WALL.faceX - 0.2,
        cy: hoodY + 0.16,
        cz: z,
        sx: 0.07,
        sy: 0.3,
        sz: 0.07,
        grain: "along-y",
        tint: new THREE.Color(0xffffff),
        uOffset: 0,
        vOffset: 0
      });
      glow.box({
        cx: SUTRO_WALL.faceX - 0.42,
        cy: hoodY - 0.08,
        cz: z,
        sx: 0.36,
        sy: 0.05,
        sz: 0.95,
        grain: "along-z",
        tint: new THREE.Color(0xffffff),
        uOffset: 0,
        vOffset: 0
      });
    });
  }

  // ---- materials --------------------------------------------------------
  const siteMatrix = new THREE.Matrix4()
    .makeTranslation(SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ)
    .multiply(new THREE.Matrix4().makeRotationY(SUTRO_BATHS.yaw));

  const timberMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_gallery_timber",
    color: 0xffffff,
    roughness: 0.58,
    metalness: 0,
    vertexColors: true
  });
  const brassMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_gallery_brass",
    color: 0x9a6a2c,
    roughness: 0.34,
    metalness: 0.74,
    vertexColors: true
  });
  const glowMaterial = new THREE.MeshStandardNodeMaterial({
    name: "sutro_gallery_picture_light",
    color: 0x2a2118,
    roughness: 0.5,
    metalness: 0,
    vertexColors: true,
    emissive: new THREE.Color(0xffc98a),
    emissiveIntensity: 0
  });
  const artMaterials = new Map<string, THREE.MeshStandardNodeMaterial>();
  for (const plate of artBuilders.keys()) {
    artMaterials.set(
      plate,
      new THREE.MeshStandardNodeMaterial({
        name: `sutro_gallery_art_${plate}`,
        color: 0xffffff,
        roughness: 0.86,
        metalness: 0,
        emissive: new THREE.Color(0xffffff),
        emissiveIntensity: 0
      })
    );
  }

  const meshes: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const addMesh = (
    builder: Builder,
    material: THREE.Material,
    name: string,
    withColor: boolean
  ): void => {
    const geometry = builder.build(name, siteMatrix, withColor);
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    // A wall clad flat against a wall has nothing worth casting; it does want the
    // roof's own shadows across it. Keeping it out of the caster set leaves the
    // shadow atlas for the ironwork that actually shapes this room.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // One mesh spans 133 m of wall: culling it as a unit only ever throws away
    // the whole gallery, so leave it resident and let the depth buffer work.
    mesh.frustumCulled = false;
    meshes.push(mesh);
    geometries.push(geometry);
    group.add(mesh);
  };

  addMesh(timber, timberMaterial, "sutro_gallery_boards", true);
  addMesh(brass, brassMaterial, "sutro_gallery_brass", true);
  addMesh(glow, glowMaterial, "sutro_gallery_picture_lights", true);
  for (const [plate, builder] of artBuilders) {
    addMesh(builder, artMaterials.get(plate)!, `sutro_gallery_art_${plate}`, false);
  }

  // ---- textures ---------------------------------------------------------
  // Awaited by the site's `ready`, which optionalSites.ts waits on BEFORE the
  // covered pipeline warm — so the graphs that get compiled are the final,
  // mapped ones and no first-draw recompile lands on the visitor's frame.
  const textures: THREE.Texture[] = [];
  const grainLoads = Promise.all([
    loadTexture(`${TIMBER_ROOT}/hall-timber-basecolor`, {
      srgb: true,
      anisotropy: 8,
      webpOnly: true
    }),
    loadTexture(`${TIMBER_ROOT}/hall-timber-normal`, {
      srgb: false,
      anisotropy: 8,
      webpOnly: true
    })
  ]).then(([basecolor, normal]) => {
    for (const texture of [basecolor, normal]) {
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.needsUpdate = true;
      textures.push(texture);
    }
    timberMaterial.map = basecolor;
    timberMaterial.normalMap = normal;
    timberMaterial.normalScale.set(0.55, 0.55);
    timberMaterial.needsUpdate = true;
    // Brass reads as metal, not as wood: it borrows the grain as faint surface
    // relief only, and never as colour.
    brassMaterial.normalMap = normal;
    brassMaterial.normalScale.set(0.16, 0.16);
    brassMaterial.needsUpdate = true;
  });

  const artLoads = [...artMaterials].map(([plate, material]) =>
    loadTexture(`${ART_ROOT}/${plate}`, { srgb: true, anisotropy: 8, webpOnly: true }).then(
      (texture) => {
        texture.needsUpdate = true;
        textures.push(texture);
        material.map = texture;
        // The plates are what stay legible once the pocket goes to dusk: the
        // picture lights above them are geometry, so the sheet carries its own
        // (small) self-glow, ramped by setTwilight below.
        material.emissiveMap = texture;
        material.needsUpdate = true;
      }
    )
  );

  const ready = Promise.all([grainLoads, ...artLoads])
    .then(() => undefined)
    .catch((error) => {
      // A missing plate must not take the hall down with it: the boards keep
      // their tints and the frames stay hung, just untextured.
      console.warn("[sutro-baths] timber gallery textures unavailable:", error);
    });

  let twilight = 0;
  const baseTimber = timberMaterial.color.clone();
  const baseBrass = brassMaterial.color.clone();

  const applyGrade = (): void => {
    timberMaterial.color.copy(baseTimber).lerp(LAMP_TINT, twilight * TIMBER_TINT_MIX);
    timberMaterial.emissive.copy(LAMP_TINT);
    timberMaterial.emissiveIntensity = twilight * TIMBER_SELF_GLOW;
    brassMaterial.color.copy(baseBrass).lerp(LAMP_TINT, twilight * 0.4);
    glowMaterial.emissiveIntensity = twilight * PICTURE_LIGHT_GLOW;
    for (const material of artMaterials.values()) {
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
    plates: artMaterials.size,
    draws: meshes.length,
    triangles
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
    stats,
    dispose() {
      for (const mesh of meshes) mesh.removeFromParent();
      for (const geometry of geometries) geometry.dispose();
      for (const texture of textures) texture.dispose();
      timberMaterial.dispose();
      brassMaterial.dispose();
      glowMaterial.dispose();
      for (const material of artMaterials.values()) material.dispose();
      meshes.length = 0;
      geometries.length = 0;
      textures.length = 0;
      group.clear();
      group.removeFromParent();
    }
  };
}
