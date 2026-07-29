import * as THREE from "three/webgpu";
import { loadTexture } from "../../render/textures";
import { SUTRO_BATHS, SUTRO_WALL } from "./layout";
import {
  Builder,
  LAMP_TINT,
  cladBay,
  createTimberMaterials,
  hash,
  loadTimberGrain,
  type Band
} from "./timberCladding";

/**
 * The inland wall as a timber gallery: boards, rails — and the marks left by
 * seventeen pictures that are no longer on it.
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
 * WHERE THE PICTURES WENT
 * Down. The whole hang lives in the sunken gallery under this wall now
 * (grotto.ts), and what is left here is the evidence: the brass plaques, the
 * hooded picture lamps still burning over nothing, and a rectangle of unfaded
 * timber where each sheet protected the boards from seventy years of sun. The
 * rhythm of the wall is unchanged and so is its light — the lamp bars were
 * always most of what this wall contributes after dusk — but a visitor who
 * looks at it now has a question, and the answer is at the bottom of the plunge.
 *
 * It is also the single biggest thing this site no longer loads: seventeen
 * plates left the hall's boot path with the hang.
 *
 * WHAT IT IS
 * Seven horizontal bands, dark and grounding at the bottom, warm mid-century
 * boards above, banded by rails that catch the lamps:
 *
 *   plinth      5.62 → 6.52   dark, heavy courses on the deck
 *   dado        6.52 → 8.42   dark vertical slats — the log-cabin register
 *   chair rail  8.42 → 8.74   dark, standing proud: the room's strong horizontal
 *   art field   8.74 → 19.4   warm wide boards; the pictures used to hang here
 *   picture rail 19.4 → 19.82 dark cap over the art
 *   clerestory  19.82 → 24.95 warm vertical slats, the mid-century slat wall
 *   cornice     24.95 → 25.5  dark, deepest projection, under the roof spring
 *
 * DRAWS: one timber mesh (boards, rails, ghost panels), one brass mesh (plaques
 * and picture-light hoods) and one emissive mesh (the light bars). No textured
 * plate draws at all any more.
 */

/**
 * Grade strengths, sized against the hall's measured ambient the same way
 * staticAmbience.ts sizes its own (scene.environmentIntensity ~0.14 at the
 * pocket's held hour). Emissive is UNLIT, so it can only ever be a shadow floor
 * here — the tint does the "lit by gas globes" work.
 */
const TIMBER_SELF_GLOW = 0.035;
const TIMBER_TINT_MIX = 0.17;
const PICTURE_LIGHT_GLOW = 5.2;

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

type GhostLayout = "wide" | "tall" | "pair";

/**
 * Where the seventeen pictures hung, kept exactly as it was so the marks land on
 * the boards the hang actually covered. The plate NAMES moved downstairs with
 * the pictures (grotto.ts owns them now); the wall only remembers the shapes.
 */
const GHOST_BAYS: readonly { bay: number; layout: GhostLayout; count: number }[] = [
  { bay: -8, layout: "wide", count: 1 },
  { bay: -7, layout: "pair", count: 2 },
  { bay: -6, layout: "wide", count: 1 },
  { bay: -5, layout: "tall", count: 1 },
  { bay: -4, layout: "wide", count: 1 },
  { bay: -3, layout: "pair", count: 2 },
  { bay: -2, layout: "wide", count: 1 },
  { bay: -1, layout: "tall", count: 1 },
  { bay: 0, layout: "wide", count: 1 },
  { bay: 1, layout: "pair", count: 2 },
  { bay: 2, layout: "wide", count: 1 },
  { bay: 3, layout: "tall", count: 1 },
  { bay: 4, layout: "wide", count: 1 },
  { bay: 5, layout: "tall", count: 1 }
];

/**
 * Picture sizes, metres — sized for the room, not for a gallery wall: the
 * visitor's eye is 1.7 m above a deck 3 m below the picture band and typically
 * 10-25 m out across the water, so a "normal" 2 m canvas would read as a postage
 * stamp. A 7.4 m sheet subtends about the same angle from the far rim as a large
 * framed print does across a living room.
 */
const ART_CENTRE_Y = 13.5;
const GHOST_SIZES: Record<GhostLayout, { width: number; height: number; offsets: readonly number[] }> = {
  wide: { width: 7.4, height: 4.93, offsets: [0] },
  tall: { width: 4.0, height: 6.0, offsets: [0] },
  pair: { width: 3.3, height: 4.95, offsets: [-2.3, 2.3] }
};

/** The art field's own projection, and the mark standing a few mm off it. */
const FIELD_PROUD = 0.16;
const GHOST_PROUD = 0.004;
/** The unfaded rectangle, as a lift on the boards' own warm tone. */
const GHOST_TINT = /*@__PURE__*/ new THREE.Color(0xd8a976);

export type SutroTimberGallery = {
  group: THREE.Group;
  /** Resolves once the grain has landed, so the site's covered warm compiles
   *  the FINAL material graphs rather than untextured ones. */
  ready: Promise<void>;
  /** 0 = daylight, 1 = deep in the pocket's twilight. */
  setTwilight(depth: number): void;
  readonly stats: {
    boards: number;
    /** Marks left by the hang that moved down to the sunken gallery. */
    ghosts: number;
    draws: number;
    triangles: number;
  };
  dispose(): void;
};

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

  // ---- the boards -------------------------------------------------------
  let seed = 0;
  for (let bay = SUTRO_WALL.firstBay; bay <= SUTRO_WALL.lastBay; bay++) {
    const { centreZ, half } = bayFrame(bay);
    seed = cladBay({ builder: timber, bands: BANDS, faceX: SUTRO_WALL.faceX, centreZ, half, seed });
  }

  // ---- what the pictures left behind ------------------------------------
  let ghosts = 0;
  const white = new THREE.Color(0xffffff);
  for (const entry of GHOST_BAYS) {
    const { centreZ } = bayFrame(entry.bay);
    const size = GHOST_SIZES[entry.layout];
    for (let slot = 0; slot < entry.count; slot++) {
      const offset = size.offsets[Math.min(slot, size.offsets.length - 1)];
      const z = centreZ + offset;
      const halfH = size.height * 0.5;
      ghosts++;
      const ghostSeed = 5000 + ghosts * 7;

      // The unfaded rectangle. A whisper proud of the field so it catches its
      // own sliver of the lamp above rather than z-fighting the boards.
      timber.box({
        cx: SUTRO_WALL.faceX - FIELD_PROUD - GHOST_PROUD * 0.5,
        cy: ART_CENTRE_Y,
        cz: z,
        sx: GHOST_PROUD,
        sy: size.height,
        sz: size.width,
        grain: "along-z",
        tint: GHOST_TINT,
        uOffset: hash(ghostSeed, 53) * 8,
        vOffset: hash(ghostSeed, 71) * 8
      });
      // …and the four picture hooks still screwed into the rail.
      for (const hookZ of [z - size.width * 0.32, z + size.width * 0.32]) {
        brass.box({
          cx: SUTRO_WALL.faceX - FIELD_PROUD - 0.05,
          cy: ART_CENTRE_Y + halfH + 0.12,
          cz: hookZ,
          sx: 0.09,
          sy: 0.16,
          sz: 0.05,
          grain: "along-y",
          tint: white,
          uOffset: 0,
          vOffset: 0
        });
      }

      // A brass plate under the space, and the hooded lamp still lighting it.
      brass.box({
        cx: SUTRO_WALL.faceX - 0.19,
        cy: ART_CENTRE_Y - halfH - 0.62,
        cz: z,
        sx: 0.04,
        sy: 0.15,
        sz: 0.92,
        grain: "along-z",
        tint: white,
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
        tint: white,
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
        tint: white,
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
        tint: white,
        uOffset: 0,
        vOffset: 0
      });
    }
  }

  // ---- materials --------------------------------------------------------
  const siteMatrix = new THREE.Matrix4()
    .makeTranslation(SUTRO_BATHS.centerX, 0, SUTRO_BATHS.centerZ)
    .multiply(new THREE.Matrix4().makeRotationY(SUTRO_BATHS.yaw));

  const materials = createTimberMaterials("sutro_gallery");
  const timberMaterial = materials.timber;
  const brassMaterial = materials.brass;
  const glowMaterial = materials.glow;

  const meshes: THREE.Mesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];
  const addMesh = (builder: Builder, material: THREE.Material, name: string): void => {
    const geometry = builder.build(name, siteMatrix, true);
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

  addMesh(timber, timberMaterial, "sutro_gallery_boards");
  addMesh(brass, brassMaterial, "sutro_gallery_brass");
  addMesh(glow, glowMaterial, "sutro_gallery_picture_lights");

  // ---- textures ---------------------------------------------------------
  // Awaited by the site's `ready`, which optionalSites.ts waits on BEFORE the
  // covered pipeline warm — so the graphs that get compiled are the final,
  // mapped ones and no first-draw recompile lands on the visitor's frame.
  const textures: THREE.Texture[] = [];
  const ready = loadTimberGrain(loadTexture, timberMaterial, brassMaterial, textures).catch((error) => {
    // A missing tile must not take the hall down with it: the boards keep their
    // tints and the wall stays standing, just untextured.
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
  };
  applyGrade();

  const triangles = geometries.reduce(
    (total, geometry) => total + (geometry.getIndex()?.count ?? 0) / 3,
    0
  );
  const stats = {
    boards: timber.boxes,
    ghosts,
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
      meshes.length = 0;
      geometries.length = 0;
      textures.length = 0;
      group.clear();
      group.removeFromParent();
    }
  };
}
