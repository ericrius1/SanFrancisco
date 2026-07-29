import * as THREE from "three/webgpu";

/**
 * The hall's timber, as a kit.
 *
 * This was all inside timberGallery.ts until the pictures moved downstairs.
 * Two rooms now want the same wall — the gallery above the pools and the sunken
 * gallery beneath it — so the parts that ARE the wall live here: the merged
 * geometry builder, the board tints, the seven-band section, and the picture
 * hang (sheet, moulding, plaque, hooded lamp) that goes on top of it.
 *
 * ONE TILE, MANY WOODS
 * There is a single neutral grain tile (tools/build-sutro-hall-textures.mjs) and
 * every board multiplies its own tint into it through vertex colour. That is
 * what gets a dark grounding timber and a warm honey board out of one 1024²
 * pair, keeps a thousand boards in ONE draw submission, and lets a scattering of
 * boards run deliberately off-tone so the wall reads as stock that was mixed
 * rather than printed. Per-board UV jitter means no two boards show the same
 * figure even though they share the tile.
 *
 * CANONICAL WALL SPACE
 * Every wall is authored the same way: its face is a plane of constant x, the
 * room is at -x from it, and the bays run along z. A wall that is actually the
 * other side of the room, or one of the two ends, passes a `frame` matrix and
 * gets the identical code — see `Builder.setFrame`. Grain UVs are taken from
 * the CANONICAL point, before the frame, so every wall's figure runs the same
 * way whatever direction it ends up facing.
 */

/** Metres of wall per grain tile. Mirrors TILE_METRES in the texture builder. */
export const TIMBER_TILE_M = 1.5;
export const TIMBER_ROOT = "/sutro/timber";
export const ART_ROOT = "/sutro/art";

/** Lamplight, the same warm the hall grade drifts every other surface toward. */
export const LAMP_TINT = /*@__PURE__*/ new THREE.Color(0xffb469);

export type Tone = "dark" | "warm";
export type Grain = "along-z" | "along-y";

/**
 * Board tints, as sRGB hex multiplied into the neutral grain tile.
 *
 * `feature` is the mix: a dark plank landed among the honey boards and a warm
 * one among the dark, roughly one board in seven, which is the difference
 * between a timber wall and a painted one.
 */
export const TONES: Record<Tone, { base: number; feature: number }> = {
  dark: { base: 0x4a2f20, feature: 0x7d5433 },
  warm: { base: 0xb07b45, feature: 0x5c3a24 }
};

export type Band = {
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

export type BoxSpec = {
  /** Canonical wall-space centre. */
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

/** Deterministic per-board noise: a wall must be identical every visit. */
export function hash(index: number, salt: number): number {
  let value = Math.imul(index + 1, 374761393) ^ Math.imul(salt + 1, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967296;
}

export function toneColour(tone: Tone, seed: number): THREE.Color {
  const palette = TONES[tone];
  const feature = hash(seed, 11) < 0.18;
  const colour = new THREE.Color(feature ? palette.feature : palette.base);
  // Board-to-board exposure and a little hue drift, so no two planks out of the
  // same stack are quite the same piece of wood.
  const level = 0.8 + hash(seed, 23) * 0.44;
  const warmth = 0.97 + hash(seed, 37) * 0.07;
  colour.multiplyScalar(level);
  colour.r = Math.min(1, colour.r * warmth);
  colour.b = Math.min(1, colour.b / warmth);
  return colour;
}

const FRAME_NORMAL = /*@__PURE__*/ new THREE.Matrix3();
const FRAME_POINT = /*@__PURE__*/ new THREE.Vector3();
const FRAME_DIR = /*@__PURE__*/ new THREE.Vector3();

/** Accumulates one merged, static geometry — see the draw budget in the header. */
export class Builder {
  readonly position: number[] = [];
  readonly normal: number[] = [];
  readonly uv: number[] = [];
  readonly color: number[] = [];
  readonly index: number[] = [];
  boxes = 0;

  #frame: THREE.Matrix4 | null = null;
  #frameNormal: THREE.Matrix3 | null = null;

  /**
   * Place subsequent boards through `matrix` instead of straight into wall
   * space. Pass null to go back to the canonical wall. Positions and normals
   * are transformed; UVs are NOT — the grain is a property of the board, not of
   * where the board ended up.
   */
  setFrame(matrix: THREE.Matrix4 | null): void {
    this.#frame = matrix;
    this.#frameNormal = matrix ? FRAME_NORMAL.setFromMatrix4(matrix).invert().transpose().clone() : null;
  }

  #push(px: number, py: number, pz: number, nx: number, ny: number, nz: number): void {
    if (this.#frame) {
      FRAME_POINT.set(px, py, pz).applyMatrix4(this.#frame);
      FRAME_DIR.set(nx, ny, nz).applyMatrix3(this.#frameNormal!).normalize();
      this.position.push(FRAME_POINT.x, FRAME_POINT.y, FRAME_POINT.z);
      this.normal.push(FRAME_DIR.x, FRAME_DIR.y, FRAME_DIR.z);
      return;
    }
    this.position.push(px, py, pz);
    this.normal.push(nx, ny, nz);
  }

  /**
   * A board, as six quads.
   *
   * Each face is generated from a basis whose u × v IS the outward normal, which
   * is what guarantees front-facing winding on all six without six hand-written
   * corner lists to get subtly wrong. Texture UVs are separate: they come from
   * the board's own wall-space position in the grain plane, so the tile scale is
   * identical on every board whatever its size, and the per-board offsets
   * decorrelate them.
   */
  box(spec: BoxSpec): void {
    const { cx, cy, cz, sx, sy, sz, grain, tint, uOffset, vOffset } = spec;
    const half: readonly [number, number, number] = [sx * 0.5, sy * 0.5, sz * 0.5];
    const centre: readonly [number, number, number] = [cx, cy, cz];
    // [axis of the normal, its sign, u axis, v axis] with u × v = +normal.
    const faces: readonly [number, number, number, number][] = [
      [0, -1, 2, 1], // -x, the face the room sees: z × y = -x
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
        this.#push(
          point[0],
          point[1],
          point[2],
          axis === 0 ? sign : 0,
          axis === 1 ? sign : 0,
          axis === 2 ? sign : 0
        );
        const grainU = grain === "along-z" ? point[2] : point[1];
        const grainV = grain === "along-z" ? point[1] : point[2];
        this.uv.push(grainU / TIMBER_TILE_M + uOffset, grainV / TIMBER_TILE_M + vOffset);
        this.color.push(tint.r, tint.g, tint.b);
      }
      this.index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    this.boxes++;
  }

  /** A single quad facing the room (-x in wall space), UV 0..1, for a picture. */
  quad(x: number, centreY: number, centreZ: number, width: number, height: number): void {
    const base = this.position.length / 3;
    const z0 = centreZ - width * 0.5;
    const z1 = centreZ + width * 0.5;
    const y0 = centreY - height * 0.5;
    const y1 = centreY + height * 0.5;
    // Looking along +x with +y up puts wall-space +z on the viewer's right, and
    // three samples v from the bottom — so u runs with z and v runs with y.
    const corners: readonly [number, number, number, number][] = [
      [x, y0, z0, 0],
      [x, y0, z1, 1],
      [x, y1, z1, 1],
      [x, y1, z0, 0]
    ];
    let corner = 0;
    for (const [px, py, pz, u] of corners) {
      this.#push(px, py, pz, -1, 0, 0);
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

/**
 * Every board's back face stops a centimetre short of the wall plate. Landing it
 * exactly ON the plate would put two opaque faces in the same plane, which is a
 * z-fight waiting for a distant camera and a shallow depth range.
 */
export const WALL_CLEARANCE = 0.01;

export type CladBayOptions = {
  builder: Builder;
  bands: readonly Band[];
  /** Wall-space x of the plate the boards stand off. */
  faceX: number;
  centreZ: number;
  /** Half the clear span between the bay's flanking members. */
  half: number;
  /** Bumped per board so two walls in one builder never share a grain offset. */
  seed: number;
};

/** Clads one bay with the seven-band section. Returns the next seed. */
export function cladBay(options: CladBayOptions): number {
  const { builder, bands, faceX, centreZ, half } = options;
  let seed = options.seed;
  const pushBoard = (
    tone: Tone,
    grain: Grain,
    centreY: number,
    boardZ: number,
    height: number,
    width: number,
    proud: number
  ): void => {
    const boardSeed = seed++;
    builder.box({
      cx: faceX - WALL_CLEARANCE - proud * 0.5,
      cy: centreY,
      cz: boardZ,
      sx: proud,
      sy: height,
      sz: width,
      grain,
      tint: toneColour(tone, boardSeed),
      // Jitter in whole-ish tiles: each board is cut from somewhere else in the
      // stock, which is what hides the tile's 1.5 m repeat along a long board.
      uOffset: hash(boardSeed, 53) * 8,
      vOffset: hash(boardSeed, 71) * 8
    });
  };

  for (const band of bands) {
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
  return seed;
}

// ---------------------------------------------------------------------------
// the hang
// ---------------------------------------------------------------------------

/** The picture stack: the sheet sits 2 cm off the boards, the moulding 7 cm off it. */
export const ART_SHEET_OFFSET = 0.02;
export const FRAME_DEPTH = 0.07;

export type HangOptions = {
  /** One builder per plate, so each picture is its own textured draw. */
  sheet: Builder;
  timber: Builder;
  brass: Builder;
  glow: Builder;
  faceX: number;
  /** Metres the art field's boards stand proud of the plate. */
  fieldProud: number;
  centreY: number;
  centreZ: number;
  width: number;
  height: number;
  /** Moulding width; scaled with the picture so a small hang is not clunky. */
  frameWidth: number;
  seed: number;
};

/**
 * One picture: the sheet, four members of moulding, a brass plate under it and a
 * hooded lamp over it. The lamp bar goes in `glow` (unlit emissive) and the hood
 * and plaque in `brass`, so the whole hang costs three shared draws plus the
 * plate's own.
 */
export function hangPicture(options: HangOptions): void {
  const { sheet, timber, brass, glow, faceX, fieldProud, centreY, centreZ } = options;
  const canvasX = faceX - fieldProud - ART_SHEET_OFFSET;
  const frameX = canvasX - FRAME_DEPTH;
  const halfW = options.width * 0.5;
  const halfH = options.height * 0.5;
  const frameWidth = options.frameWidth;

  sheet.quad(canvasX, centreY, centreZ, options.width, options.height);

  const frameTint = toneColour("dark", options.seed);
  const member = (cy: number, cz: number, sy: number, sz: number, grain: Grain): void => {
    timber.box({
      cx: (frameX + (faceX - fieldProud)) * 0.5,
      cy,
      cz,
      sx: faceX - fieldProud - frameX,
      sy,
      sz,
      grain,
      tint: frameTint,
      uOffset: hash(options.seed, 91) * 8,
      vOffset: hash(options.seed, 97) * 8
    });
  };
  member(centreY + halfH + frameWidth * 0.5, centreZ, frameWidth, options.width + frameWidth * 2, "along-z");
  member(centreY - halfH - frameWidth * 0.5, centreZ, frameWidth, options.width + frameWidth * 2, "along-z");
  member(centreY, centreZ - halfW - frameWidth * 0.5, options.height, frameWidth, "along-y");
  member(centreY, centreZ + halfW + frameWidth * 0.5, options.height, frameWidth, "along-y");

  const white = new THREE.Color(0xffffff);
  const plaqueScale = Math.min(1, options.width / 7.4);
  brass.box({
    cx: faceX - 0.19,
    cy: centreY - halfH - 0.62 * Math.max(0.55, plaqueScale),
    cz: centreZ,
    sx: 0.04,
    sy: 0.15,
    sz: 0.92 * Math.max(0.5, plaqueScale),
    grain: "along-z",
    tint: white,
    uOffset: 0,
    vOffset: 0
  });
  const hoodY = centreY + halfH + 0.66 * Math.max(0.55, plaqueScale);
  brass.box({
    cx: faceX - 0.42,
    cy: hoodY,
    cz: centreZ,
    sx: 0.46,
    sy: 0.13,
    sz: 1.15 * Math.max(0.5, plaqueScale),
    grain: "along-z",
    tint: white,
    uOffset: 0,
    vOffset: 0
  });
  brass.box({
    cx: faceX - 0.2,
    cy: hoodY + 0.16,
    cz: centreZ,
    sx: 0.07,
    sy: 0.3,
    sz: 0.07,
    grain: "along-y",
    tint: white,
    uOffset: 0,
    vOffset: 0
  });
  glow.box({
    cx: faceX - 0.42,
    cy: hoodY - 0.08,
    cz: centreZ,
    sx: 0.36,
    sy: 0.05,
    sz: 0.95 * Math.max(0.5, plaqueScale),
    grain: "along-z",
    tint: white,
    uOffset: 0,
    vOffset: 0
  });
}

/** The shared material set every timber room is drawn with. */
export function createTimberMaterials(prefix: string): {
  timber: THREE.MeshStandardNodeMaterial;
  brass: THREE.MeshStandardNodeMaterial;
  glow: THREE.MeshStandardNodeMaterial;
} {
  return {
    timber: new THREE.MeshStandardNodeMaterial({
      name: `${prefix}_timber`,
      color: 0xffffff,
      roughness: 0.58,
      metalness: 0,
      vertexColors: true
    }),
    brass: new THREE.MeshStandardNodeMaterial({
      name: `${prefix}_brass`,
      color: 0x9a6a2c,
      roughness: 0.34,
      metalness: 0.74,
      vertexColors: true
    }),
    glow: new THREE.MeshStandardNodeMaterial({
      name: `${prefix}_picture_light`,
      color: 0x2a2118,
      roughness: 0.5,
      metalness: 0,
      vertexColors: true,
      emissive: new THREE.Color(0xffc98a),
      emissiveIntensity: 0
    })
  };
}

/**
 * Load the shared grain pair and bind it to a timber/brass material pair.
 * Resolves when both have landed so a caller's `ready` can gate the covered
 * pipeline warm on the FINAL, mapped material graphs.
 */
export async function loadTimberGrain(
  loadTexture: (name: string, opts: { srgb: boolean; anisotropy: number; webpOnly: boolean }) => Promise<THREE.Texture>,
  timber: THREE.MeshStandardNodeMaterial,
  brass: THREE.MeshStandardNodeMaterial,
  keep: THREE.Texture[]
): Promise<void> {
  const [basecolor, normal] = await Promise.all([
    loadTexture(`${TIMBER_ROOT}/hall-timber-basecolor`, { srgb: true, anisotropy: 8, webpOnly: true }),
    loadTexture(`${TIMBER_ROOT}/hall-timber-normal`, { srgb: false, anisotropy: 8, webpOnly: true })
  ]);
  for (const texture of [basecolor, normal]) {
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.needsUpdate = true;
    keep.push(texture);
  }
  timber.map = basecolor;
  timber.normalMap = normal;
  timber.normalScale.set(0.55, 0.55);
  timber.needsUpdate = true;
  // Brass reads as metal, not as wood: it borrows the grain as faint surface
  // relief only, and never as colour.
  brass.normalMap = normal;
  brass.normalScale.set(0.16, 0.16);
  brass.needsUpdate = true;
}
