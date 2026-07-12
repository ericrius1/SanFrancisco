import * as THREE from "three/webgpu";
import {
  attribute,
  positionLocal,
  positionWorld,
  positionView,
  cameraProjectionMatrix,
  modelScale,
  normalWorldGeometry,
  cameraPosition,
  float,
  vec2,
  vec3,
  vec4,
  color,
  mix,
  step,
  smoothstep,
  fract,
  floor,
  abs,
  hash,
  texture,
  uniform,
  uint,
  select,
  varying,
  fwidth,
  mod,
  Fn,
  dot,
  normalize,
  mx_noise_float,
  mx_fractal_noise_float
} from "three/tsl";
import { bumpNormal } from "./tslUtil";
import { LIGHT_SCALE } from "../config";
import { cameraCutawayMask } from "../render/cameraCutaway";

/** Sky-driven lit-window weight: 0 in daylight → 1 after dusk, written every
 * frame by Sky#applySun (same twilight curve as the street lamps). Window
 * emissives — here, the citygen parallax glass and the far LOD — multiply by
 * this so lit panes only read after dark. Historically the glow was constant
 * and daylight "crushed" it via the old +2-stop ACES shoulder grade; the 2026-07
 * day re-grade removed that crush, so the gate is now explicit. */
export const WINDOW_GLOW_W = uniform(0);

/* ------------------------------------------------------------------ palettes */

// terrain-bake palette: matches tools/blender_city.py PALETTES (vertex colours)
export const PALETTE_HEX = [0x889eb0, 0xe8e2d5, 0xddd2b8, 0xd9b8a8, 0xb9c9b2, 0xb3c3cd, 0xb07555, 0xc9b189, 0xa8a29a];

export function paletteColor(p: number): THREE.Color {
  return new THREE.Color(PALETTE_HEX[p % PALETTE_HEX.length]);
}

// NYC masonry palette from the reference SkyscraperGenerator: limestone-dominant
// with terracotta accents, so streets read warm stone rather than pastel blocks
export const MASONRY_HEX = [
  0xa8553c, 0x9c4a34, // terracotta & red brick (occasional accent)
  0x8a6a52, 0x7d6450, // warm brick / brownstone (muted)
  0xc4a370, 0xb89a6f, 0xc2b183, // buff / tan
  0xc6c0b2, 0xc6c0b2, 0xbdb7a8, 0xd1ccbe, 0xb4afa1, // limestone — the common default
  0x9a988f, 0x8b8983, 0xa5a39a, // grey granite / concrete
  0xdbd6cb, // pale glazed (accent)
  0x7c868d // steel / glass (cool accent)
];

/* ------------------------------------------------------- facade grid layout */

const FLOOR_H = 3.7; // metres per storey
const COL_W = 3.35; // metres per window column
const STORE_H = 4.4; // ground-floor storefront zone: bulkhead + glazing + fascia

// per-building base height rides in the alive texture (G/B = 16-bit fixed point)
export const BASEY_OFFSET = 100; // metres below zero we can encode
export const BASEY_SCALE = 80; // 1/80 m steps

// per-building roof height above base rides in the alive texture alpha
// (8-bit, 1.5 m steps → 382 m ceiling; 255 = unknown = never mask). The facade
// masks any window row whose full cell doesn't fit under the roof, so
// arbitrary OSM heights stop slicing windows in half at the parapet.
export const TOPH_SCALE = 1.5;

/* -------------------------------------------------- CPU twin of the GPU hash */

/**
 * three's TSL hash(): PCG (pcg-random.org via shadertoy XlGcRh). Bit-exact JS twin,
 * so a CPU caller can derive the same per-building colour the facade shader does.
 */
export function pcgHash(i: number): number {
  const state = (Math.imul(i >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> (((state >>> 28) + 4) & 31)) ^ state) >>> 0, 277803737) >>> 0;
  return (((word >>> 22) ^ word) >>> 0) / 4294967296;
}

/** The per-building masonry tone — the exact colour the facade shader computes. */
export function buildingTone(bid: number, p: number): THREE.Color {
  const idx = Math.min(MASONRY_HEX.length - 1, Math.floor(pcgHash(bid + 101) * MASONRY_HEX.length));
  const tone = paletteColor(p).lerp(new THREE.Color(MASONRY_HEX[idx]), 0.72);
  return tone.multiplyScalar(0.9 + 0.16 * pcgHash(bid + 223));
}

/* --------------------------------------------------------------- TSL helpers */

// eslint-style note: TSL node generics fight composition; any is the idiom here
type N = any;
const mixN = mix as unknown as (a: N, b: N, t: N) => N;

// integer-keyed hash chain: h(key + k) with small integer k, exact on CPU and GPU
const cellHash = (key: N, k: number): N => hash(key.add(uint(k)));

/**
 * Everything both facade flavours share: masonry brickwork, the window grid with
 * dressed-stone frames, glazing (optionally interior-mapped), storefronts and
 * weathering. Returns the node set to assign onto a MeshStandardNodeMaterial.
 */
function facadeSurface(opts: {
  baseTone: N; // per-building masonry colour (linear vec3)
  bid: N; // per-building id (float node)
  baseY: N; // building base height (world Y where it meets the street)
  topRel?: N; // roof height above baseY in metres (omit = never mask rows)
  litWindows: boolean; // lit panes + emissive glow
  litScale?: N; // 0..1 multiplier on the lit mask (fade the windows out)
  // When false, skip mx_noise brick/weathering entirely (far material). Noise
  // cannot be distance-branched inside one shader — If() corrupts lit windows on
  // the WGSL→Metal path — so tiles swap between near/far pooled materials instead.
  detail?: boolean;
  // pattern frame: a caller can pass a frozen spawn-pose position/normal so the
  // facade stays glued to a moving piece instead of re-deriving from live world
  // space (which reads as the pattern scrolling as it moves). Unused by the
  // in-place building material; kept so the surface stays reusable.
  frame?: { pos: N; nrm: N };
}) {
  const { baseTone, bid, baseY, litWindows } = opts;
  const detail = opts.detail !== false;

  const p = opts.frame ? opts.frame.pos : positionWorld;
  const dist = positionWorld.distance(cameraPosition); // LOD by real distance, always
  const n = opts.frame ? opts.frame.nrm : normalWorldGeometry;
  const nAbs = n.abs();

  // walls are near-vertical faces; roofs/ledges stay flat masonry
  const wallMask = smoothstep(0.62, 0.4, abs(n.y));

  // face-tangent coordinate (u along the wall) and per-building storey coordinate
  const across = p.x.mul(n.z).sub(p.z.mul(n.x));
  const rel = p.y.sub(baseY); // metres above this building's own base
  const rowCoord = rel.sub(STORE_H).div(FLOOR_H); // storey 0 starts above the storefront
  const colCoord = across.div(COL_W);
  const fRow = fract(rowCoord);
  const fCol = fract(colCoord);

  // anti-aliased edges: the pixel footprint of the grid coordinates. the horizontal
  // derivative comes from continuous world X/Z weighted by the normal — fwidth(across)
  // spikes where the normal flips at corners. rawDD is the unscaled variant the
  // brick block re-divides by its own period.
  const rawDD = nAbs.z.mul(fwidth(p.x)).add(nAbs.x.mul(fwidth(p.z)));
  const ddCol = rawDD.div(COL_W).clamp(1e-5, 0.5);
  const ddRow = fwidth(rowCoord).clamp(1e-5, 0.5);
  const band = (t: N, lo: number, hi: number, dd: N): N =>
    smoothstep(float(lo).sub(dd), float(lo).add(dd), t).mul(smoothstep(float(hi).add(dd), float(hi).sub(dd), t));

  /* --- masonry + weathering -------------------------------------------------- */

  // Near material: full brick coursing + multi-octave weathering (expensive ALU).
  // Far material: flat masonry — distant brick is sub-pixel and only burned fill.
  const soot = color(0x4a4236);
  let joint: N;
  let brickFace: N;
  let tone: N;
  let dirt: N;
  let roofGrime: N;
  let stoneRough: N;
  let perBrick: N;
  let brickShift: N;

  if (detail) {
    // Beyond ~300 m the brick coursing, streaks and mottle are sub-pixel: the AA
    // mortar has already dissolved and the noise just burns ALU on the pixels
    // that dominate every vista (distant towers). The noise stacks run behind
    // branches and cross-fade to flat fallbacks over 240→300 m, so there is no
    // pop line. tone is a vertex-stage varying — effectively free — and stays on
    // at all distances so far facades keep their broad patina.
    //
    // NO If() around these blocks inside ONE material. An If inside a Fn here
    // corrupts unrelated outputs for the pixels that SKIP the branch (measured:
    // far lit windows died wholesale past the 300 m gate). Far tiles use a
    // separate pooled material with detail=false instead.
    const wFade = smoothstep(300.0, 240.0, dist);
    const texel = fwidth(p).length();
    const fwRel = fwidth(rel);
    tone = varying(mx_fractal_noise_float(p.mul(0.03), 2)).mul(0.18);

    /* masonry brickwork (reference running bond, world-anchored per building) */
    const brick: N = (Fn(([acrossV, relV, rawDDV, fwRelV, texelV, wallMaskV, fadeV]: N[]) => {
      const out = vec4(0, 0, 0.5, 0.5).toVar();
      {
        const BRICK_H = 0.3;
        const BRICK_L = 0.6;
        const MORTAR = 0.025;

        const rowB = relV.div(BRICK_H);
        const courseRow = floor(rowB);
        const colB = acrossV.div(BRICK_L).add(mod(courseRow, 2).mul(0.5)); // half-brick stagger

        const mU = MORTAR / (2 * BRICK_L);
        const mV = MORTAR / (2 * BRICK_H);
        const ddU = rawDDV.div(BRICK_L).clamp(1e-6, 0.5);
        const ddV = fwRelV.div(BRICK_H).clamp(1e-6, 0.5);
        const distU = float(0.5).sub(fract(colB).sub(0.5).abs());
        const distV = float(0.5).sub(fract(rowB).sub(0.5).abs());
        const drawU = ddU.max(mU);
        const drawV = ddV.max(mV);
        const lineU: N = smoothstep(drawU.add(ddU), drawU.sub(ddU), distU).mul(float(mU).div(drawU).min(1));
        const lineV: N = smoothstep(drawV.add(ddV), drawV.sub(ddV), distV).mul(float(mV).div(drawV).min(1));
        const jointN: N = lineU.max(lineV).mul(wallMaskV).mul(fadeV);

        const brickKey = uint(courseRow.add(1 << 16))
          .mul(uint(73856093))
          .bitXor(uint(floor(colB).add(1 << 16)).mul(uint(19349663)))
          .toVar();

        const lodBevel = texelV.mul(1.5).max(0.02);
        const brickFaceN: N = smoothstep(0, lodBevel, distU.mul(BRICK_L)).mul(smoothstep(0, lodBevel, distV.mul(BRICK_H))).mul(wallMaskV);

        out.assign(
          vec4(
            jointN,
            brickFaceN.mul(fadeV),
            mixN(float(0.5), hash(brickKey), fadeV),
            mixN(float(0.5), hash(brickKey.add(uint(1))), fadeV)
          )
        );
      }
      return out;
    }) as N)(across, rel, rawDD, fwRel, texel, wallMask, wFade);
    joint = brick.x;
    brickFace = brick.y;

    const weather: N = (Fn(([pv, relV, fadeV]: N[]) => {
      const out = vec4(0, 0, 0, 0.93).toVar();
      {
        const mottle: N = mx_noise_float(pv.mul(0.7)).mul(0.06);
        const streak: N = mx_fractal_noise_float(vec3(pv.x.mul(1.5), pv.y.mul(0.04), pv.z.mul(1.5)), 2);
        const dirtN: N = smoothstep(-0.1, 0.45, streak).mul(smoothstep(160.0, 0.0, relV)).mul(0.5);
        const roofG: N = smoothstep(0.0, 0.55, mx_fractal_noise_float(pv.mul(0.025), 3)).mul(0.22);
        const rough: N = mx_noise_float(pv.mul(0.5)).mul(0.06).add(0.9);
        out.assign(vec4(mottle.mul(fadeV), dirtN.mul(fadeV), roofG.mul(fadeV), mixN(float(0.93), rough, fadeV)));
      }
      return out;
    }) as N)(p, rel, wFade);
    dirt = weather.y;
    roofGrime = weather.z;
    stoneRough = weather.w.add(joint.mul(0.1));
    perBrick = float(1).add(tone).add(weather.x).add(brick.z.sub(0.5).mul(0.14).mul(wFade));
    const warmCool = brick.w.sub(0.5).mul(0.14).mul(wFade);
    brickShift = vec3(float(1).add(warmCool), float(1), float(1).sub(warmCool));
  } else {
    joint = float(0);
    brickFace = float(0);
    tone = float(0);
    dirt = float(0);
    roofGrime = float(0);
    stoneRough = float(0.93);
    perBrick = float(1);
    brickShift = vec3(1, 1, 1);
  }

  /* --- facade zones ---------------------------------------------------------- */

  // upper-floor window cell: recessed pane inside a dressed-stone frame
  const inShaft = smoothstep(-0.02, 0.02, rowCoord); // above the storefront zone
  // parapet mask: a row only gets a window if its WHOLE cell fits under the
  // roof (0.9 m slack covers the alpha-channel quantization + a wall band), so
  // arbitrary building heights never slice a window mid-pane at the roofline —
  // the leftover strip reads as solid parapet masonry instead
  const rowFits = opts.topRel
    ? step(floor(rowCoord).add(1).mul(FLOOR_H).add(STORE_H), opts.topRel.sub(0.9))
    : float(1);
  const paneX = band(fCol, 0.16, 0.84, ddCol);
  const paneY = band(fRow, 0.24, 0.8, ddRow);
  const frameX = band(fCol, 0.1, 0.9, ddCol);
  const frameY = band(fRow, 0.18, 0.86, ddRow);
  const openingUpper = frameX.mul(frameY).mul(wallMask).mul(inShaft).mul(rowFits);
  const paneUpper = paneX.mul(paneY).mul(wallMask).mul(inShaft).mul(rowFits);
  const frameUpper = openingUpper.sub(paneUpper).max(0);

  // string course band every 6 storeys (smooth stone ridge at the floor line)
  const course6 = step(mod(floor(rowCoord), 6), 0.5).mul(band(fRow, -0.02, 0.12, ddRow)).mul(wallMask).mul(inShaft);

  // ground-floor storefront: bulkhead / tall glazing with mullions / signboard fascia
  // (masked out entirely on structures too short to fit the glazing head, so
  // sheds don't get storefront glass sliced off at their roofline)
  const storeFits = opts.topRel ? step(4.6, opts.topRel) : float(1);
  const inStore = smoothstep(0.03, -0.03, rowCoord).mul(smoothstep(-0.4, 0.0, rel)).mul(wallMask).mul(storeFits);
  const shopCol = fract(colCoord); // reuse the bay grid; wider lights, slim mullions
  const shopPaneX = band(shopCol, 0.07, 0.93, ddCol);
  const ddRel = fwidth(rel).clamp(1e-5, 0.5);
  const shopPaneY = smoothstep(float(0.55).sub(ddRel), float(0.55).add(ddRel), rel).mul(
    smoothstep(float(3.5).add(ddRel), float(3.5).sub(ddRel), rel)
  );
  const paneShop = shopPaneX.mul(shopPaneY).mul(inStore);
  const fascia = smoothstep(float(3.5).sub(ddRel), float(3.5).add(ddRel), rel).mul(inStore);
  const bulkhead = smoothstep(float(0.55).add(ddRel), float(0.55).sub(ddRel), rel).mul(inStore);
  const mullionShop = shopPaneY.mul(inStore).sub(paneShop).max(0);

  const pane = paneUpper.add(paneShop).clamp(0, 1);
  const isShop = paneShop;

  /* --- per-window identity --------------------------------------------------- */

  const cellKey = uint(floor(colCoord).add(1 << 16))
    .mul(uint(73856093))
    .bitXor(uint(floor(rowCoord).add(1 << 16)).mul(uint(19349663)))
    .bitXor(uint(bid.add(7)).mul(uint(83492791)))
    .toVar();

  const litUpper = step(0.8, cellHash(cellKey, 3)); // ~20% of rooms have lights on
  const litShop = step(0.4, cellHash(cellKey, 8)); // most shops read open
  let lit: N = litWindows ? mix(litUpper, litShop, isShop) : float(0);
  if (litWindows && opts.litScale) lit = lit.mul(opts.litScale);

  const warmLight = mix(color(0xffb845), color(0xffe49c), cellHash(cellKey, 4));
  const coolLight = mix(color(0xdfe8ff), color(0x9fb6ff), cellHash(cellKey, 5));
  const lightCol = select(cellHash(cellKey, 6).greaterThan(0.88), coolLight, warmLight);

  /* --- simple glazing (flat panes, no fake interior) ------------------------- */

  // Windows are flat glass now — no interior raymarch. A fixed dark tint reads as
  // glass, lifted toward a cool sky sheen at grazing angles by a cheap fresnel
  // (~(1-facing)^3, no pow/noise), and at night the ~lit panes carry a warm
  // emissive. `facing` is 1 head-on, →0 at grazing; the sheen, the grazing
  // roughness and the emissive cutoff all ride it.
  const facing = dot(normalize(p.sub(cameraPosition)), n).negate();
  const inv = facing.oneMinus().clamp(0, 1);
  const fresnel = inv.mul(inv).mul(inv);

  // dark glass; shops read a touch lighter/cleaner than the residential panes
  const glassTint = select(isShop.greaterThan(0.5), color(0x20262b), color(0x181d22));
  const skySheen = color(0x9db6d2);
  const glazing = mix(glassTint, skySheen, fresnel.mul(0.4));

  /* --- compose the surface ----------------------------------------------------- */

  // masonry: building tone + brick variation, joints recessed darker, soot pooling low
  const tint = baseTone.mul(perBrick).mul(brickShift);
  const masonry = mix(tint, tint.mul(0.76), joint);
  const roofMask = wallMask.oneMinus();
  const stone = mix(masonry, soot, mix(dirt, roofGrime, roofMask));

  // dressed-stone frames, string courses, storefront paint
  const frameColor = baseTone.mul(0.55);
  const courseColor = mix(baseTone, color(0xffffff), 0.2).mul(float(1).add(tone));
  const storeColor = mix(baseTone.mul(0.3), color(0x24201c), 0.5);

  let surface: N = stone;
  surface = mixN(surface, courseColor, course6);
  surface = mixN(surface, frameColor, frameUpper.add(mullionShop).clamp(0, 1));
  surface = mixN(surface, storeColor, fascia.add(bulkhead).clamp(0, 1));
  surface = mixN(surface, glazing, pane);

  // relief: brick domes + window reveals recessed + string course / fascia ledges.
  // the brick bump only belongs on bare masonry — riding under glass it makes the
  // sun glint off phantom joints as rows of staggered bright dashes
  // plain math on already-computed masks — cheap enough to run unbranched;
  // reliefFade zeroes it beyond 220 m anyway. Far material: brickFace is 0.
  const smoothZone = openingUpper.max(paneShop).max(fascia).max(bulkhead).max(course6);
  const reliefFade = detail ? smoothstep(220.0, 50.0, dist) : float(0);
  const relief = brickFace
    .mul(smoothZone.oneMinus())
    .mul(0.0038)
    .add(openingUpper.mul(-0.05))
    .add(paneShop.mul(-0.05))
    .add(course6.mul(0.02))
    .add(fascia.mul(0.015))
    .mul(reliefFade);

  // rougher at grazing: kills the razor-thin white env-glints that slide along
  // near-edge-on facades
  const glassRough = float(0.16).add(fresnel.mul(0.4));
  const roughness = mix(mix(stoneRough, float(0.6), fascia.add(bulkhead).clamp(0, 1)), glassRough, pane);

  // lit panes emit a warm glow, gated by the sky's twilight weight so it only
  // reads after dusk (WINDOW_GLOW_W — daylight used to crush it via the old
  // ACES shoulder grade; the gate is explicit since the 2026-07 day re-grade).
  // Shops glow a touch brighter. A hard grazing cutoff kills sub-pixel emissive
  // shimmer on near-edge-on facades.
  const emitScale = mix(float(2.0 * LIGHT_SCALE), float(2.2 * LIGHT_SCALE), isShop);
  const glowGraze = smoothstep(0.01, 0.06, facing);
  const emissive = litWindows
    ? lightCol.mul(lit).mul(pane).mul(emitScale).mul(glowGraze).mul(WINDOW_GLOW_W)
    : color(0x000000);

  return {
    colorNode: surface,
    roughnessNode: roughness,
    metalnessNode: float(0),
    emissiveNode: emissive,
    normalNode: bumpNormal(relief)
  };
}

/* ------------------------------------------------------------------ materials */

/**
 * The shared skyscraper-facade material for a tile's buildings. Storeys and window
 * columns grow procedurally from world position; each building's base height (from
 * the alive texture) anchors its storefront and floor lines to its own street level.
 * Suppressed buildings are clipped via the alive flag.
 *
 * `detail` selects the near (full brick/weather noise) or far (flat masonry +
 * windows) graph. Tiles swap between two pooled materials by distance — never
 * branch noise inside one shader (WGSL→Metal If bug).
 */
export function createFacadeMaterial(
  aliveTex: THREE.DataTexture,
  texWidth: number,
  opts: { detail?: boolean } = {}
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();
  const detail = opts.detail !== false;

  const bid = attribute("_bid", "float") as unknown as N;
  const vColor = attribute("color", "vec3") as unknown as N;
  const uAliveW = uniform(texWidth);

  const info = texture(aliveTex, vec2(bid.add(0.5).div(uAliveW), 0.5));

  // Suppressed buildings used to be hidden by moving their vertices 900 m down.
  // That left a complete second city under the playable world, still inside the
  // camera's 24 km far plane. A material mask removes those fragments (including
  // from shadow passes). Both R=0 (mesh and collider off) and R=1/255 (mesh off,
  // collider kept) stay below this threshold.
  mat.maskNode = info.r.greaterThan(0.5).and(cameraCutawayMask());

  // Deterministic per-building nudge (±3cm in XZ): raw OSM leaves duplicate
  // footprints (way + multipolygon twins) and shared party walls exactly
  // coplanar, and two coincident facades with different _bid z-fight as a
  // flickering patchwork of each other's windows — the nudge gives every
  // building its own plane
  const nudge = vec3(hash(bid.add(311)).sub(0.5).mul(0.06), 0, hash(bid.add(577)).sub(0.5).mul(0.06));
  // The mask is the visibility source of truth. Also move suppressed vertices
  // far beyond the camera range so the rasterizer rejects their triangles before
  // fragment work; unlike the old 900 m sink, this can never form a visible city.
  const suppressed = step(info.r, 0.5);
  // The offset is in meters, but quantized tiles store positions normalized to
  // [-1,1] with the dequantization scale baked into the node transform — a
  // local-space add would be amplified by that scale (~420x), so divide it out
  const offsetMeters = nudge.sub(vec3(0, suppressed.mul(1_000_000), 0));
  mat.positionNode = positionLocal.add(offsetMeters.div(modelScale));

  // the XZ nudge has a directional blind spot: when a pair's nudge delta runs
  // parallel to the shared wall (or the shared face is a roof/floor), the two
  // shells stay coplanar and z-fight. Pull each building toward the camera by
  // a per-bid relative hair — along the view ray, so screen position is
  // unchanged and only depth separates. ~2e-4 ≈ 2cm at 100m, ~3000x the f32
  // reversed-z depth precision at any distance.
  mat.vertexNode = cameraProjectionMatrix.mul(
    positionView.mul(hash(bid.add(911)).mul(-2e-4).add(1))
  );

  // per-building base height, 16-bit fixed point in G/B
  const baseY = info.g.mul(255).round().mul(256).add(info.b.mul(255).round()).div(BASEY_SCALE).sub(BASEY_OFFSET);
  // roof height above base, 8-bit in A (255 = unknown → mask never triggers)
  const topRel = info.a.mul(255).round().mul(TOPH_SCALE);

  // per-building masonry tone: bake palette vertex colour pulled toward the
  // reference masonry palette, with per-building brightness (per-vertex varying)
  let palette: N = color(MASONRY_HEX[0]);
  const pick = hash(bid.add(101));
  for (let i = 1; i < MASONRY_HEX.length; i++) {
    palette = mix(palette, color(MASONRY_HEX[i]), step(i / MASONRY_HEX.length, pick));
  }
  const baseTone = varying(mix(vColor, palette, 0.72).mul(hash(bid.add(223)).mul(0.16).add(0.9)) as N) as N;

  const nodes = facadeSurface({ baseTone, bid, baseY, topRel, litWindows: true, detail });
  mat.colorNode = nodes.colorNode;
  mat.roughnessNode = nodes.roughnessNode;
  mat.metalnessNode = nodes.metalnessNode;
  mat.emissiveNode = nodes.emissiveNode;
  mat.normalNode = nodes.normalNode;
  mat.envMapIntensity = 1.0;
  return mat;
}
