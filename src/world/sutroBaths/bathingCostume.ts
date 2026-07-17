import * as THREE from "three/webgpu";
import { SKIN_TONES } from "../../player/avatar";
import type { Rig } from "../../player/rig";
import { enableShadowLayer, SHADOW_LAYERS } from "../shadows/shadowLayers";

/**
 * Bathing-costume subsystem for the Sutro Baths NPC bathers.
 *
 * `applyBathingCostume(rig, seed)` takes an already-built {@link Rig} and dresses
 * it into a deterministic, period-authentic early-1900s bathing outfit. Every
 * seed yields a visibly different bather: body type (men's tank/union suit vs a
 * women's dress-suit with bloomers, skirtlet and stockings), stripe pattern,
 * sleeve length, neckline, belt, bathing cap and accessories all roll off the
 * seed, so a crowd of a dozen never repeats.
 *
 * HOW IT WORKS (reuses the rig's own material/box technique):
 *  - The rig already carries twelve flat MeshLambert slots and named silhouette
 *    blocks (torsoBlock, hipBlock, armBlocks[], legBlocks[]). We recolour the
 *    body by REASSIGNING per-block `.material` (each mesh owns its slot, so we
 *    can make an arm bare-skin while the torso stays wool) and by tinting the
 *    shared skin slot to the chosen tone.
 *  - Stripes and period details (belt, collar, skirtlet, cap, towel) are added
 *    as small coloured box meshes parented under the relevant rig joint — the
 *    same trick the stock outfit system uses (rig.ts:267-283). Box-bands read
 *    crisp at distance, which is why they're the primary stripe method rather
 *    than a texture.
 *  - The stock outfit/hat/hair detail (backpack, zip stripe, caps…) is hidden
 *    so nothing pokes through the swimwear.
 *
 * Everything created is parented under the rig and tracked, so `dispose()` frees
 * every added mesh, geometry and material. Purely procedural: no media loads.
 */

// ---------------------------------------------------------------- palette

/** Historically plausible early-1900s wool-swimwear colours (NOT the stock
 *  8-colour avatar palette). Bathing suits of the era were knit wool in deep,
 *  sober tones with contrast trim. */
const PERIOD_COLORS = [
  0x28324f, // navy
  0x2f2f5c, // indigo
  0x9e2b2b, // cardinal red
  0xe7dcc0, // cream / ecru
  0x2a2c30, // charcoal black
  0x2f4a34, // forest
  0x5e2733, // maroon
  0xb98a2e, // mustard
  0x54606b // slate
] as const;

/** Trim / stripe accents — mostly the pale cream + a couple of brights so the
 *  contrast reads. */
const TRIM_COLORS = [0xe7dcc0, 0xf1ead6, 0x9e2b2b, 0x28324f, 0x2a2c30] as const;

/** Stocking / cap tones for the women's suits. */
const HOSE_COLORS = [0x2a2c30, 0x1f2126, 0x4a3b32, 0xe7dcc0] as const;

// caster diet: boxes smaller than this never earn a shadow-cascade encode
// (matches the rig / busker threshold).
const CASTER_MIN_VOLUME = 1.5e-3;

// ---------------------------------------------------------------- rng

/** Tiny deterministic PRNG (mulberry32) seeded from a string/number. Kept local
 *  so costumes are reproducible without leaning on avatar.ts internals. */
function makeRng(seed: string | number) {
  const s = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- types

export type BathingStyle = "mens-tank" | "mens-union" | "womens-dress";
export type StripePattern = "solid" | "stripe2" | "pinstripe";
export type SleeveLength = "sleeveless" | "short" | "elbow";
export type BathingCap = "none" | "mob" | "bandana";

export type CostumePalette = {
  primary: number; // suit body wool
  accent: number; // stripes / trim
  trim: number; // collar / belt webbing
  skin: number;
};

export type CostumeInfo = {
  style: BathingStyle;
  hasStripes: boolean;
  stripePattern: StripePattern;
  sleeves: SleeveLength;
  cap: BathingCap;
  palette: CostumePalette;
  /** Every mesh this costume added to the rig (for inspection / debugging). */
  addedMeshes: THREE.Object3D[];
  /** Free all geometries / materials / meshes this costume created. */
  dispose(): void;
};

export type CostumeOptions = {
  /** Force a body type instead of rolling it from the seed. */
  style?: BathingStyle;
  /** Force a skin-tone index into SKIN_TONES. */
  skin?: number;
};

// ---------------------------------------------------------------- helpers

function pick<T>(items: readonly T[], r: () => number): T {
  return items[Math.floor(r() * items.length) % items.length];
}

/**
 * The block layout the rig exposes (see rig.ts buildRig):
 *   armBlocks = [shoulderL, foreL, shoulderR, foreR]
 *   legBlocks = [thighL,    shinL, thighR,    shinR]
 * Named accessors keep the reshaping readable.
 */
const ARM = { shoulderL: 0, foreL: 1, shoulderR: 2, foreR: 3 } as const;
const LEG = { thighL: 0, shinL: 1, thighR: 2, shinR: 3 } as const;

/**
 * Dress an already-built rig into a period bathing costume. Deterministic from
 * `seed`. Returns what it chose plus a dispose handle.
 */
export function applyBathingCostume(rig: Rig, seed: string | number, opts: CostumeOptions = {}): CostumeInfo {
  const r = makeRng(seed);
  const s = rig.avatar;

  // ---- roll the look ----------------------------------------------------
  const style: BathingStyle = opts.style ?? pick(["mens-tank", "mens-union", "womens-dress", "womens-dress"], r);
  const womens = style === "womens-dress";
  const primary = pick(PERIOD_COLORS, r);
  let accent = pick(TRIM_COLORS, r);
  if (accent === primary) accent = TRIM_COLORS[(TRIM_COLORS.indexOf(accent as (typeof TRIM_COLORS)[number]) + 1) % TRIM_COLORS.length];
  const trim = pick(TRIM_COLORS, r);
  const skinIdx = opts.skin ?? Math.floor(r() * SKIN_TONES.length) % SKIN_TONES.length;
  const skin = SKIN_TONES[skinIdx].color;

  const stripePattern: StripePattern = pick(["solid", "solid", "stripe2", "pinstripe"], r);
  const hasStripes = stripePattern !== "solid";
  // women's suits favour more coverage; men's tanks go sleeveless more often
  const sleeves: SleeveLength = womens
    ? pick(["short", "elbow", "elbow"], r)
    : style === "mens-tank"
      ? pick(["sleeveless", "sleeveless", "short"], r)
      : pick(["short", "elbow"], r);
  const cap: BathingCap = womens ? pick(["mob", "mob", "bandana", "none"], r) : pick(["none", "none", "bandana"], r);
  const hasBelt = r() < (womens ? 0.35 : 0.7);
  const sailorCollar = r() < 0.45;
  const hasTowel = r() < 0.18;

  // ---- shared / created materials --------------------------------------
  const created: { geometries: THREE.BufferGeometry[]; materials: THREE.Material[] } = { geometries: [], materials: [] };
  const addedMeshes: THREE.Object3D[] = [];

  const mat = (hex: number) => {
    const m = new THREE.MeshLambertMaterial({ color: hex });
    created.materials.push(m);
    return m;
  };
  const suitMat = mat(primary);
  const accentMat = mat(accent);
  const trimMat = mat(trim);
  const hoseMat = mat(pick(HOSE_COLORS, r));
  // recolour the shared skin slot to the chosen tone (face, neck, hands)
  s.materials.skin.color.set(skin);
  const skinMat = s.materials.skin;

  // ---- hide all stock outfit / hat / hair detail -----------------------
  for (const o of s.allOutfits) o.visible = false;
  for (const o of s.allHats) o.visible = false;
  const showHair = cap === "none";
  for (const o of s.allHair) o.visible = showHair;
  // (crowns are part of allHair; nothing extra needed — they follow showHair)
  // Every rig carries a fixed dark "shades" bar across the face (materials.visor,
  // rig.ts) that reads as modern sunglasses — wrong for 1900s bathers. The slot
  // is per-rig, so hide it by zeroing its opacity (no rig.ts edit needed).
  s.materials.visor.transparent = true;
  s.materials.visor.opacity = 0;
  s.materials.visor.depthWrite = false;

  // Decorative bands wrap a host block, so their visible surface is only the
  // four vertical sides. A closed BoxGeometry also emits horizontal caps; the
  // highest pinstripe cap used to land exactly on the torso's top plane and the
  // two materials alternated under tiny camera motion. Keep the host's top and
  // bottom as the sole depth owners instead of trying to bias coplanar faces.
  const bandGeometry = (w: number, h: number, d: number): THREE.BufferGeometry => {
    const x = w * 0.5;
    const y = h * 0.5;
    const z = d * 0.5;
    const positions: number[] = [];
    const normals: number[] = [];
    const indices: number[] = [];
    const face = (vertices: readonly [number, number, number][], normal: readonly [number, number, number]) => {
      const start = positions.length / 3;
      for (const vertex of vertices) {
        positions.push(...vertex);
        normals.push(...normal);
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    };
    face([[-x, -y, -z], [-x, y, -z], [x, y, -z], [x, -y, -z]], [0, 0, -1]);
    face([[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], [0, 0, 1]);
    face([[-x, -y, z], [-x, y, z], [-x, y, -z], [-x, -y, -z]], [-1, 0, 0]);
    face([[x, -y, -z], [x, y, -z], [x, y, z], [x, -y, z]], [1, 0, 0]);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    return geometry;
  };

  // ---- geometry helpers (track + shadow-diet their own additions) ------
  const addMesh = (
    parent: THREE.Object3D,
    material: THREE.Material,
    geometry: THREE.BufferGeometry,
    volume: number,
    x: number,
    y: number,
    z: number
  ): THREE.Mesh => {
    created.geometries.push(geometry);
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = volume >= CASTER_MIN_VOLUME;
    if (m.castShadow) enableShadowLayer(m, SHADOW_LAYERS.HERO_DYNAMIC);
    m.receiveShadow = true;
    parent.add(m);
    addedMeshes.push(m);
    return m;
  };

  const addBox = (
    parent: THREE.Object3D,
    material: THREE.Material,
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number
  ): THREE.Mesh => {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = addMesh(parent, material, g, w * h * d, x, y, z);
    return m;
  };

  const addBand = (
    parent: THREE.Object3D,
    material: THREE.Material,
    role: "stripe" | "belt" | "hem" | "cap" | "towel",
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number
  ): THREE.Mesh => {
    const m = addMesh(parent, material, bandGeometry(w, h, d), w * h * d, x, y, z);
    m.name = `sutroBaths.costumeBand.${role}`;
    m.userData.bathingCostumeBand = role;
    return m;
  };

  // ---- body colouring: reassign per-block materials --------------------
  // Torso + hips are the suit body; women's suit keeps the hips as bloomers.
  s.torsoBlock.material = suitMat;
  s.hipBlock.material = suitMat;

  // arms by sleeve length
  const armBare = (i: number) => (s.armBlocks[i].material = skinMat);
  const armSuit = (i: number) => (s.armBlocks[i].material = suitMat);
  if (sleeves === "sleeveless") {
    armBare(ARM.shoulderL);
    armBare(ARM.foreL);
    armBare(ARM.shoulderR);
    armBare(ARM.foreR);
  } else if (sleeves === "short") {
    armSuit(ARM.shoulderL);
    armBare(ARM.foreL);
    armSuit(ARM.shoulderR);
    armBare(ARM.foreR);
  } else {
    // elbow — suit covers shoulder + forearm (reads as a full sleeve at range)
    armSuit(ARM.shoulderL);
    armSuit(ARM.foreL);
    armSuit(ARM.shoulderR);
    armSuit(ARM.foreR);
  }

  // legs by body type
  if (womens) {
    // bloomers (thigh) in suit; stockings (shin) in hose colour
    s.legBlocks[LEG.thighL].material = suitMat;
    s.legBlocks[LEG.thighR].material = suitMat;
    s.legBlocks[LEG.shinL].material = hoseMat;
    s.legBlocks[LEG.shinR].material = hoseMat;
  } else if (style === "mens-union") {
    // union suit — full-length wool
    for (const b of s.legBlocks) b.material = suitMat;
  } else {
    // tank suit — trunks to mid-thigh, bare lower leg
    s.legBlocks[LEG.thighL].material = suitMat;
    s.legBlocks[LEG.thighR].material = suitMat;
    s.legBlocks[LEG.shinL].material = skinMat;
    s.legBlocks[LEG.shinR].material = skinMat;
  }

  // ---- silhouette reshape ----------------------------------------------
  if (womens) {
    s.torsoBlock.scale.set(0.9, 1, 0.94);
    s.hipBlock.scale.set(1.18, 1.02, 1.08);
    s.headBlock.scale.setScalar(0.94);
    // skirtlet over the hips (knee-length flare like the dress skirt)
    addBox(rig.hips, suitMat, 0.5, 0.3, 0.3, 0, -0.15, 0);
    addBand(rig.hips, trimMat, "hem", 0.53, 0.05, 0.32, 0, -0.29, 0); // hem trim
  } else {
    // men's suits carry a touch more chest bulk
    s.torsoBlock.scale.set(style === "mens-tank" ? 1.04 : 1.0, 1, 1.02);
    s.hipBlock.scale.set(1.02, 1, 1);
    s.headBlock.scale.setScalar(1);
  }

  // ---- stripes (horizontal box-bands on the torso) ---------------------
  // torsoBlock local: centre y≈0.22, size 0.44 x 0.42 x 0.26. Bands wrap just
  // proud of the surface so they don't z-fight the body block.
  if (hasStripes) {
    const bandW = 0.455;
    const bandD = 0.272;
    const bandMat = accentMat;
    if (stripePattern === "stripe2") {
      // bold two-tone: three fat bands across the chest
      for (const y of [0.09, 0.24, 0.39]) addBand(rig.torso, bandMat, "stripe", bandW, 0.06, bandD, 0, y, 0);
    } else {
      // pinstripe: several thin bands
      for (const y of [0.06, 0.15, 0.24, 0.33, 0.42]) addBand(rig.torso, bandMat, "stripe", bandW, 0.02, bandD, 0, y, 0);
    }
  }

  // ---- neckline / collar -----------------------------------------------
  if (sailorCollar) {
    // square sailor flap across the upper back + a short front placket
    addBox(rig.torso, trimMat, 0.3, 0.02, 0.16, 0, 0.4, 0.075);
    addBox(rig.torso, trimMat, 0.09, 0.16, 0.02, 0, 0.34, -0.135);
  } else {
    // scoop neckline trim at the collarbone
    addBox(rig.torso, trimMat, 0.2, 0.03, 0.02, 0, 0.4, -0.135);
  }

  // ---- webbing belt -----------------------------------------------------
  if (hasBelt) {
    const beltMat = trim === primary ? accentMat : trimMat;
    addBand(rig.torso, beltMat, "belt", 0.462, 0.05, 0.278, 0, 0.03, 0); // band
    addBox(rig.torso, accentMat, 0.06, 0.055, 0.02, 0, 0.03, -0.14); // buckle
  }

  // ---- bathing cap ------------------------------------------------------
  if (cap === "mob") {
    // pale rounded cap covering the crown + a short brim band
    const capMat = mat(pick([0xe7dcc0, 0xf1ead6, 0x2a2c30], r));
    addBox(rig.head, capMat, 0.31, 0.16, 0.31, 0, 0.29, 0);
    addBand(rig.head, capMat, "cap", 0.32, 0.05, 0.32, 0, 0.2, 0); // band round the head
  } else if (cap === "bandana") {
    const bandMat = mat(pick([...TRIM_COLORS], r));
    addBand(rig.head, bandMat, "cap", 0.29, 0.06, 0.29, 0, 0.28, 0);
  }

  // ---- optional accessory: striped towel over one shoulder -------------
  if (hasTowel) {
    const side = r() < 0.5 ? 1 : -1;
    const towelMat = mat(pick([...TRIM_COLORS], r));
    // hang from the shoulder down the chest (parented to torso, not the arm,
    // so a swimming stroke doesn't fling it around)
    const towel = addBox(rig.torso, towelMat, 0.12, 0.5, 0.05, side * 0.2, 0.2, -0.02);
    towel.rotation.z = side * 0.12;
    // one contrast end-stripe
    addBand(towel, accentMat, "towel", 0.13, 0.05, 0.055, 0, -0.2, 0);
  }

  // ---------------------------------------------------------------- return
  return {
    style,
    hasStripes,
    stripePattern,
    sleeves,
    cap,
    palette: { primary, accent, trim, skin },
    addedMeshes,
    dispose() {
      for (const m of addedMeshes) m.parent?.remove(m);
      for (const g of created.geometries) g.dispose();
      for (const m of created.materials) m.dispose();
      addedMeshes.length = 0;
    }
  };
}
