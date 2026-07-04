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
  If,
  Fn,
  dot,
  normalize,
  mx_noise_float,
  mx_fractal_noise_float,
  instancedBufferAttribute
} from "three/tsl";
import { bumpNormal } from "./tslUtil";
import { DEBRIS_TUNING, LIGHT_SCALE, RENDER_TUNING } from "../config";

/* ----------------------------------------------------- debris light timing */

// shared uniforms driving how chunk window-lights die after a fracture; the "/"
// debug panel writes these live. hold = seconds fully lit, flicker = seconds of
// stutter-and-fade, spread = per-chunk random extra delay before the fade starts
export const DEBRIS_LIGHTS = {
  hold: uniform(DEBRIS_TUNING.values.hold),
  flicker: uniform(DEBRIS_TUNING.values.flicker),
  spread: uniform(DEBRIS_TUNING.values.spread)
};

// Far-window glow mode, driven by the "/" panel's "far window lights" toggle
// (RENDER_TUNING.farWindowGlow). 1 = lit panes beyond the interior-raymarch
// range glow at full room brightness (whole skyline lit at dusk); 0 = the old
// 0.55·LIGHT_SCALE "dusk sparkle", which ACES at play exposure crushes to
// near-black — window lights then visibly draw in around the camera as the
// interior range (340–520 m) sweeps the city. Uniform-driven so toggling never
// recompiles a pipeline.
export const WINDOW_GLOW = {
  far: uniform(RENDER_TUNING.values.farWindowGlow ? 1 : 0)
};

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
 * so debris chunks can be tinted the same colour the facade shader derived.
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
  interiors: boolean; // raymarched rooms behind the glass (off for debris)
  litWindows: boolean; // lit panes + emissive glow
  litScale?: N; // 0..1 multiplier on the lit mask (debris fades its lights out)
  // pattern frame: debris passes its frozen spawn-pose position/normal here so the
  // facade stays glued to a tumbling chunk instead of re-deriving from live world
  // space (which reads as the pattern scrolling and lights flickering as it spins)
  frame?: { pos: N; nrm: N };
}) {
  const { baseTone, bid, baseY, interiors, litWindows } = opts;

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

  /* --- masonry + weathering, distance-gated -------------------------------- */

  // Beyond ~300 m the brick coursing, streaks and mottle are sub-pixel: the AA
  // mortar has already dissolved and the noise just burns ALU on the pixels
  // that dominate every vista (distant towers). The noise stacks run behind
  // branches and cross-fade to flat fallbacks over 240→300 m, so there is no
  // pop line. tone is a vertex-stage varying — effectively free — and stays on
  // at all distances so far facades keep their broad patina.
  //
  // NO If() around these blocks. An If inside a Fn here corrupts unrelated
  // outputs for the pixels that SKIP the branch (measured: far lit windows
  // died wholesale past the 300 m gate — the "lights draw in around the
  // camera" bug; branch removed → far skyline back to baseline pixel-for-
  // pixel). The interior raymarch below gets away with its If because its body
  // is pure ALU; these blocks pull in the mx_noise library and that combo
  // miscompiles on the WGSL→Metal path. So the fade is a plain multiplier:
  // the noise always runs, and wFade only steers the blend to the flat
  // fallback. Values still route through Fn IIFEs with call-site arguments —
  // keeps the shared varying chains (normalWorldGeometry et al) materializing
  // in uniform flow at main scope.
  const tone = varying(mx_fractal_noise_float(p.mul(0.03), 2)).mul(0.18);
  const soot = color(0x4a4236);
  const wFade = smoothstep(300.0, 240.0, dist);
  const texel = fwidth(p).length();
  const fwRel = fwidth(rel);

  /* masonry brickwork (reference running bond, world-anchored per building) */
  // → vec4(joint, brickFace, brickRnd, brickRnd2); far defaults make every
  //   consumer collapse to the flat fallback (rnd 0.5 = neutral tone shift)
  const brick: N = (Fn(([acrossV, relV, rawDDV, fwRelV, texelV, wallMaskV, fadeV]: N[]) => {
    const out = vec4(0, 0, 0.5, 0.5).toVar();
    {
      const BRICK_H = 0.3;
      const BRICK_L = 0.6;
      const MORTAR = 0.025;

      const rowB = relV.div(BRICK_H);
      const courseRow = floor(rowB);
      const colB = acrossV.div(BRICK_L).add(mod(courseRow, 2).mul(0.5)); // half-brick stagger

      // "pristine grid" AA mortar: joints never fall below a pixel and fade in
      // opacity, so the coursing stays crisp near and dissolves far instead of
      // shimmering. fwidth(rowB) = fwidth(rel)/BRICK_H, precomputed outside.
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
      const joint: N = lineU.max(lineV).mul(wallMaskV).mul(fadeV);

      const brickKey = uint(courseRow.add(1 << 16))
        .mul(uint(73856093))
        .bitXor(uint(floor(colB).add(1 << 16)).mul(uint(19349663)))
        .toVar();

      // soft per-brick dome for the bump, bevel widened to a screen pixel
      const lodBevel = texelV.mul(1.5).max(0.02);
      const brickFace: N = smoothstep(0, lodBevel, distU.mul(BRICK_L)).mul(smoothstep(0, lodBevel, distV.mul(BRICK_H))).mul(wallMaskV);

      // fade the rnds toward the neutral 0.5 so tone shifts dissolve too
      out.assign(
        vec4(
          joint,
          brickFace.mul(fadeV),
          mixN(float(0.5), hash(brickKey), fadeV),
          mixN(float(0.5), hash(brickKey.add(uint(1))), fadeV)
        )
      );
    }
    return out;
  }) as N)(across, rel, rawDD, fwRel, texel, wallMask, wFade);
  const joint = brick.x;
  const brickFace = brick.y;

  /* broad weathering → vec4(mottle, dirt, roofGrime, stoneRoughBase) */
  const weather: N = (Fn(([pv, relV, fadeV]: N[]) => {
    const out = vec4(0, 0, 0, 0.93).toVar();
    {
      const mottle: N = mx_noise_float(pv.mul(0.7)).mul(0.06);
      const streak: N = mx_fractal_noise_float(vec3(pv.x.mul(1.5), pv.y.mul(0.04), pv.z.mul(1.5)), 2);
      const dirt: N = smoothstep(-0.1, 0.45, streak).mul(smoothstep(160.0, 0.0, relV)).mul(0.5);
      const roofG: N = smoothstep(0.0, 0.55, mx_fractal_noise_float(pv.mul(0.025), 3)).mul(0.22);
      const rough: N = mx_noise_float(pv.mul(0.5)).mul(0.06).add(0.9);
      out.assign(vec4(mottle.mul(fadeV), dirt.mul(fadeV), roofG.mul(fadeV), mixN(float(0.93), rough, fadeV)));
    }
    return out;
  }) as N)(p, rel, wFade);
  const dirt = weather.y;
  const roofGrime = weather.z;
  const stoneRough = weather.w.add(joint.mul(0.1));

  // per-brick tone drift + warm/cool firing shift, relative to the building
  // colour (the far-default rnd of 0.5 zeroes both shift terms)
  const perBrick = float(1).add(tone).add(weather.x).add(brick.z.sub(0.5).mul(0.14).mul(wFade));
  const warmCool = brick.w.sub(0.5).mul(0.14).mul(wFade);
  const brickShift = vec3(float(1).add(warmCool), float(1), float(1).sub(warmCool));

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

  /* --- interior mapping (reference technique, procedural room per cell) ------- */

  // grimy glazing film: dust streaks down the facade + dirt pooled at each sill.
  // NOT distance-gated like the masonry block: dustStreak/glassMottle feed the
  // lit-window emissive (grime scales the room glow), so gating them made every
  // lit pane brighten and flatten as the 300 m ring swept past — a glaring
  // draw-in at dusk. Three noise evals is a price worth paying here.
  const filmNoise = mx_fractal_noise_float(vec3(p.x.mul(1.3), p.y.mul(0.06), p.z.mul(1.3)), 2);
  const dustStreak = smoothstep(-0.15, 0.5, filmNoise).mul(0.45);
  const paneV = fRow.sub(0.24).div(0.56).clamp(0, 1); // 0 at the sill, 1 at the head
  const pooled = smoothstep(0.32, 0.0, paneV).mul(0.4);
  const glassMottle = mx_noise_float(p.mul(0.3)).mul(0.5).add(0.5);
  const dirtyGlass = mix(color(0x13161a), color(0x232b31), glassMottle);
  const grime = float(0.6).add(dustStreak).add(pooled).clamp(0, 0.95);
  const shopFilm = float(0.14).add(dustStreak.mul(0.22));

  // grazing views turn the interior slab into long shards that slide wildly with
  // any camera move (dir.z is clamped below, so the parallax divides by ~0.02) —
  // and real glass mirrors out at grazing incidence anyway. Fade the rooms to
  // dirty glass + flat far-glow as the view ray approaches the facade plane.
  const facing = dot(normalize(p.sub(cameraPosition)), n).negate();
  const grazeFade = smoothstep(0.05, 0.22, facing);
  // separate, harder cutoff for the flat pane glow: below ~3° the panes are
  // sub-pixel slivers and any emissive just reads as aliasing shimmer
  const glowGraze = smoothstep(0.005, 0.05, facing);
  const interiorOn = interiors ? smoothstep(520.0, 340.0, dist).mul(pane).mul(grazeFade) : float(0);

  // the raymarch runs behind a branch (skipped for far / non-pane fragments), which
  // TSL only allows inside a Fn body — so the whole interior is an IIFE node
  const room: N = !interiors
    ? vec4(dirtyGlass, 0)
    : Fn(() => {
    const roomOut = vec4(dirtyGlass, 0).toVar();
    If(interiorOn.greaterThan(0.004), () => {
      // room frame: u across the face, v up, depth into the wall
      const uAxis = normalize(vec3(n.z, 0, n.x.negate()));
      const rd = normalize(p.sub(cameraPosition));
      // grazing views push dot(rd, n) to 0 and the slab division explodes into
      // inf/NaN sparkle along wall silhouettes — keep a minimum inward slope
      const dir = vec3(dot(rd, uAxis), rd.y, dot(rd, n).negate().max(0.02));

      // shops get a taller, deeper room anchored to the storefront glazing
      const roomH = mix(float(2.9), float(3.3), isShop);
      const offU = fCol.sub(0.5).mul(COL_W);
      const offVUpper = fRow.sub(0.5).mul(FLOOR_H);
      const offVShop = rel.sub(2.0);
      const offV = mix(offVUpper, offVShop, isShop);
      const origin = vec3(offU, offV, 0);

      const setback = float(0.1);
      const depth = roomH.mul(1.55);
      const boxMax = vec3(float(COL_W / 2), roomH.mul(0.5), setback.add(depth));
      const boxMin = vec3(float(-COL_W / 2), roomH.mul(-0.5), setback);

      // slab method: the far plane the ray exits through
      const tFar = boxMin.sub(origin).div(dir).max(boxMax.sub(origin).div(dir));
      const t = tFar.x.min(tFar.y).min(tFar.z);
      const hit = origin.add(dir.mul(t));
      const q = hit.sub(boxMin).div(boxMax.sub(boxMin)).toVar();

      const onBack = q.z.greaterThan(0.998);
      const onCeil = q.y.greaterThan(0.998);
      const onFloor = q.y.lessThan(0.002);

      const seed = cellHash(cellKey, 11);
      const seed2 = cellHash(cellKey, 12);
      const rect = (ax: N, ay: N, cx: N, cy: N, hw: N, hh: N): N =>
        smoothstep(hw.add(0.006), hw.sub(0.006), ax.sub(cx).abs()).mul(smoothstep(hh.add(0.006), hh.sub(0.006), ay.sub(cy).abs()));
      const falloffAt = (z: N): N => mix(float(1.0), float(0.42), z.sub(setback).div(depth).clamp(0, 1));

      // shell: muted plaster walls with a skirting, boards + rug, lit ceiling lamp
      let wall: N = mix(color(0x9a8b73), color(0x6f7a82), seed);
      wall = mix(wall, color(0xb9ad97), seed2.mul(0.6));
      const wallCol = mix(wall, wall.mul(0.5), smoothstep(0.05, 0.04, q.y));

      const seam = step(0.94, fract(q.x.mul(6)));
      const boards = mix(color(0x4a3320), color(0x6a4c30), seed).mul(seam.mul(0.3).oneMinus());
      const rug = mix(color(0x7a3b32), color(0x3a5760), seed2);
      const floorCol = mix(boards, rug, rect(q.x, q.z, float(0.5), float(0.62), float(0.3), float(0.26)).mul(0.9));

      const lamp = smoothstep(0.16, 0.13, vec2(q.x.sub(0.5), q.z.sub(0.5)).length());
      const ceilCol = mix(mix(wall, color(0xffffff), 0.5), lightCol.mul(mix(float(1.0), float(4.5), lit)), lamp);

      const doorX = mix(float(0.22), float(0.78), seed);
      const door = mix(color(0x5a4631), color(0x39383c), step(0.5, seed2));
      const picX = select(doorX.lessThan(0.5), mix(float(0.68), float(0.82), seed2), mix(float(0.18), float(0.32), seed2));
      const picCol = mix(color(0x2c3a4a), color(0x7a5a3a), cellHash(cellKey, 13));
      let backCol: N = mix(wallCol, door, rect(q.x, q.y, doorX, float(0.33), float(0.085), float(0.35)));
      backCol = mix(backCol, color(0x141210), rect(q.x, q.y, picX, float(0.56), float(0.075), float(0.085)));
      backCol = mix(backCol, picCol, rect(q.x, q.y, picX, float(0.56), float(0.055), float(0.065)));

      const shellCol = select(onBack, backCol, select(onCeil, ceilCol, select(onFloor, floorCol, wallCol)));

      // soft corner AO so the box doesn't read flat-lit
      const aoEdge = (a: N): N => smoothstep(0, 0.15, a).mul(smoothstep(0, 0.15, a.oneMinus()));
      const edgeAO = select(onBack, aoEdge(q.x).mul(aoEdge(q.y)), select(onFloor.or(onCeil), aoEdge(q.x).mul(aoEdge(q.z)), aoEdge(q.y).mul(aoEdge(q.z))));
      const shellAO = mix(float(0.72), float(1.0), edgeAO);

      const bestT = t.toVar();
      const bestCol = shellCol.mul(shellAO).mul(falloffAt(hit.z)).toVar();
      const bestEmit = float(1).toVar();

      const boxHit = (bMin: N, bMax: N) => {
        const ta = bMin.sub(origin).div(dir);
        const tb = bMax.sub(origin).div(dir);
        const lo = ta.min(tb);
        const hi = ta.max(tb);
        const tN = lo.x.max(lo.y).max(lo.z);
        const ph = origin.add(dir.mul(tN));
        return { tN, p: ph, hit: hi.x.min(hi.y).min(hi.z).greaterThan(tN).and(tN.greaterThan(0)), qb: ph.sub(bMin).div(bMax.sub(bMin)) };
      };
      const consider = (h: N, tN: N, c: N, emit = 1) => {
        const nearHit = h.and(tN.lessThan(bestT));
        bestCol.assign(select(nearHit, c, bestCol));
        bestEmit.assign(select(nearHit, float(emit), bestEmit));
        bestT.assign(select(nearHit, tN, bestT));
      };

      const halfU = boxMax.x;
      const floorY = boxMin.y;
      const ceilY = boxMax.y;
      const backZ = boxMax.z;
      const midZ = setback.add(depth.mul(0.5));

      // a low table near the middle, its top catching the light
      const tCx = mix(float(-0.6), float(0.6), seed);
      const tCz = midZ.add(mix(float(-0.4), float(0.5), seed2));
      const tbl = boxHit(vec3(tCx.sub(0.6), floorY, tCz.sub(0.35)), vec3(tCx.add(0.6), floorY.add(0.42), tCz.add(0.35)));
      const tblCol = mix(color(0x4a3526), color(0x6b4a30), seed2).mul(select(tbl.qb.y.greaterThan(0.94), float(1.25), float(0.8)));
      consider(tbl.hit, tbl.tN, tblCol.mul(falloffAt(tbl.p.z)));

      // a wide low sofa against the back wall
      const sofaCx = mix(halfU.mul(-0.3), halfU.mul(0.3), seed2);
      const sofa = boxHit(vec3(sofaCx.sub(1.1), floorY, backZ.sub(0.95)), vec3(sofaCx.add(1.1), floorY.add(mix(float(0.8), float(0.9), seed)), backZ.sub(0.1)));
      const sofaCol = mix(color(0x5a4a3a), color(0x42566a), seed).mul(select(sofa.qb.y.greaterThan(0.9), float(1.12), float(0.85)));
      consider(sofa.hit, sofa.tN, sofaCol.mul(falloffAt(sofa.p.z)));

      // curtains just inside the glass, drawn part-way from each side
      const swatch = (a: number, b: number): N => mix(color(a), color(b), seed2);
      const pick = cellHash(cellKey, 14).mul(6);
      let fabric: N = swatch(0xcabfa6, 0xd8cdb8);
      fabric = select(pick.greaterThan(1), swatch(0x8a7a64, 0x9b8c72), fabric);
      fabric = select(pick.greaterThan(2), swatch(0x706a64, 0x837d76), fabric);
      fabric = select(pick.greaterThan(3), swatch(0x5f7079, 0x6f818b), fabric);
      fabric = select(pick.greaterThan(4), swatch(0x6c7558, 0x79835f), fabric);
      fabric = select(pick.greaterThan(5), swatch(0x8c5a44, 0x9a6a52), fabric);
      const drape = (bMin: N, bMax: N, gate: N) => {
        const h = boxHit(bMin, bMax);
        const pleat = fabric.mul(mix(float(0.78), float(1.12), fract(h.p.x.mul(2.5))));
        consider(h.hit.and(gate), h.tN, pleat.mul(falloffAt(h.p.z)), 0.2);
      };
      const cz1 = setback.add(0.12);
      const sL = smoothstep(0.3, 1.0, seed);
      const sR = smoothstep(0.3, 1.0, seed2);
      const lw = halfU.mul(sL.mul(sL));
      const rw = halfU.mul(sR.mul(sR));
      drape(vec3(halfU.negate(), floorY, setback), vec3(halfU.negate().add(lw), ceilY, cz1), lw.greaterThan(0.05));
      drape(vec3(halfU.sub(rw), floorY, setback), vec3(halfU, ceilY, cz1), rw.greaterThan(0.05));

      const warmth = mix(vec3(1, 1, 1), lightCol, lit.mul(0.85));
      roomOut.assign(vec4(bestCol.mul(warmth).mul(mix(float(1.0), float(1.3), lit)), lit.mul(bestEmit)));
    });
    return roomOut;
  })();

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

  // glazing: the room shows through a dusty film; shops read far cleaner
  const glassTint = select(isShop.greaterThan(0.5), color(0xccd4cf), color(0xb6c6bf));
  const glassFilm = mix(grime, shopFilm, isShop);
  const roomVisible = mix(dirtyGlass, room.xyz.mul(glassTint), grazeFade);
  const glazing = mix(roomVisible, dirtyGlass, glassFilm);

  let surface: N = stone;
  surface = mixN(surface, courseColor, course6);
  surface = mixN(surface, frameColor, frameUpper.add(mullionShop).clamp(0, 1));
  surface = mixN(surface, storeColor, fascia.add(bulkhead).clamp(0, 1));
  surface = mixN(surface, glazing, pane);

  // relief: brick domes + window reveals recessed + string course / fascia ledges.
  // the brick bump only belongs on bare masonry — riding under glass it makes the
  // sun glint off phantom joints as rows of staggered bright dashes
  // plain math on already-computed masks — cheap enough to run unbranched;
  // reliefFade zeroes it beyond 220 m anyway
  const smoothZone = openingUpper.max(paneShop).max(fascia).max(bulkhead).max(course6);
  const reliefFade = smoothstep(220.0, 50.0, dist);
  const relief = brickFace
    .mul(smoothZone.oneMinus())
    .mul(0.0038)
    .add(openingUpper.mul(-0.05))
    .add(paneShop.mul(-0.05))
    .add(course6.mul(0.02))
    .add(fascia.mul(0.015))
    .mul(reliefFade);

  // rougher at grazing: kills the razor-thin white env-glints that slide along
  // near-edge-on facades (the dust film diffuses grazing reflections anyway)
  const glassRough = float(0.16).add(pooled.mul(0.45)).add(dustStreak.mul(0.2)).add(grazeFade.oneMinus().mul(0.4));
  const roughness = mix(mix(stoneRough, float(0.6), fascia.add(bulkhead).clamp(0, 1)), glassRough, pane);

  // beyond the interior range lit panes carry a flat warm glow. WINDOW_GLOW.far
  // ("far window lights" in the "/" panel) picks its strength: 0 = the original
  // 0.55 dusk sparkle, 1 = boosted toward the room-emissive average so the far
  // skyline reads as bright as the near blocks. Uniform-driven — no recompile.
  const farGlow = mix(float(0.55 * LIGHT_SCALE), float(1.35 * LIGHT_SCALE), WINDOW_GLOW.far as N);
  const emissive = litWindows
    ? room.xyz.mul(room.w).mul(pane).mul(grazeFade).mul(mix(float(2.2 * LIGHT_SCALE).mul(grime.mul(0.6).oneMinus()), float(2.0 * LIGHT_SCALE), isShop)).add(
        lightCol.mul(lit).mul(pane).mul(interiorOn.oneMinus()).mul(farGlow).mul(glowGraze)
      )
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
 * Dead buildings sink via the alive flag.
 */
export function createFacadeMaterial(aliveTex: THREE.DataTexture, texWidth: number): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();

  const bid = attribute("_bid", "float") as unknown as N;
  const vColor = attribute("color", "vec3") as unknown as N;
  const uAliveW = uniform(texWidth);

  const info = texture(aliveTex, vec2(bid.add(0.5).div(uAliveW), 0.5));

  // destruction: sink dead buildings far below ground. The same node adds a
  // deterministic per-building nudge (±3cm in XZ): raw OSM leaves duplicate
  // footprints (way + multipolygon twins) and shared party walls exactly
  // coplanar, and two coincident facades with different _bid z-fight as a
  // flickering patchwork of each other's windows — the nudge gives every
  // building its own plane
  const dead = step(info.r, 0.5);
  const nudge = vec3(hash(bid.add(311)).sub(0.5).mul(0.06), 0, hash(bid.add(577)).sub(0.5).mul(0.06));
  // the offset is in meters, but quantized tiles store positions normalized to
  // [-1,1] with the dequantization scale baked into the node transform — a
  // local-space add would be amplified by that scale (~420x), so divide it out
  const offsetMeters = nudge.sub(vec3(0, dead.mul(900), 0));
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

  const nodes = facadeSurface({ baseTone, bid, baseY, topRel, interiors: true, litWindows: true });
  mat.colorNode = nodes.colorNode;
  mat.roughnessNode = nodes.roughnessNode;
  mat.metalnessNode = nodes.metalnessNode;
  mat.emissiveNode = nodes.emissiveNode;
  mat.normalNode = nodes.normalNode;
  mat.envMapIntensity = 1.0;
  return mat;
}

/**
 * Debris chunks keep the full facade look — masonry, window grid and lit panes —
 * matching the parent building exactly at the moment of fracture. The pattern is
 * evaluated in each chunk's FROZEN spawn pose (per-instance spawn centre + yaw,
 * applied to the geometry-local position), so it stays glued to the piece while
 * it tumbles instead of scrolling/flickering with its live world transform.
 *
 * The window lights survive the fracture: each chunk keeps its panes glowing for
 * DEBRIS_LIGHTS.hold seconds (plus a per-chunk random slice of .spread, so a
 * collapse dies out over a second or two instead of all at once), then stutters
 * dark over .flicker seconds — dropouts get denser as the envelope decays, like
 * mains power dying.
 *
 * Instanced attributes:
 *   tone  vec4 — rgb = buildingTone, w = parent baseY
 *   info  vec4 — x = parent bid, yzw = chunk half extents
 *   spawn vec4 — xyz = spawn centre, w = building yaw
 *   anim  vec2 — x = age (s since fracture), y = per-chunk random seed 0..1
 */
export function createDebrisMaterial(
  toneAttr: THREE.InstancedBufferAttribute,
  infoAttr: THREE.InstancedBufferAttribute,
  spawnAttr: THREE.InstancedBufferAttribute,
  animAttr: THREE.InstancedBufferAttribute
): THREE.MeshStandardNodeMaterial {
  const mat = new THREE.MeshStandardNodeMaterial();

  const tone = instancedBufferAttribute(toneAttr) as unknown as N;
  const info = instancedBufferAttribute(infoAttr) as unknown as N;
  const spawn = instancedBufferAttribute(spawnAttr) as unknown as N;
  const anim = instancedBufferAttribute(animAttr) as unknown as N;

  const baseTone = varying(tone.xyz);
  const baseY = varying(tone.w);
  const bid = varying(info.x);

  // frozen frame: geometry-local (unit box ±1) scaled by the chunk's half extents,
  // rotated by the parent building's yaw, offset to the spawn centre — the world
  // pose the piece had inside the intact facade
  // read the RAW vertex buffers: three's instancing assigns the instance-transformed
  // result into positionLocal/normalLocal, so those vars hold live world-space values
  // here — reading them would re-introduce the motion we're freezing out
  const pl = attribute("position", "vec3") as unknown as N;
  const nl = attribute("normal", "vec3") as unknown as N;
  const cosY = spawn.w.cos();
  const sinY = spawn.w.sin();
  const lx = pl.x.mul(info.y);
  const ly = pl.y.mul(info.z);
  const lz = pl.z.mul(info.w);
  const frozenPos = varying(
    vec3(
      spawn.x.add(lx.mul(cosY)).add(lz.mul(sinY)),
      spawn.y.add(ly),
      spawn.z.add(lx.mul(sinY).negate()).add(lz.mul(cosY))
    ) as N
  ) as N;
  const frozenNrm = varying(
    vec3(
      nl.x.mul(cosY).add(nl.z.mul(sinY)),
      nl.y,
      nl.x.mul(sinY).negate().add(nl.z.mul(cosY))
    ) as N
  ) as N;

  // lights-out timeline, all in seconds since the fracture. Uniform-driven so the
  // "/" panel retunes chunks already in the air. Whole thing is per-instance
  // constant, so it runs once in the vertex stage (varying)
  const age = anim.x;
  const seed = anim.y;
  const fadeStart = DEBRIS_LIGHTS.hold.add(seed.mul(DEBRIS_LIGHTS.spread));
  const t = age.sub(fadeStart); // <0 while still fully lit
  const envelope = t.div(DEBRIS_LIGHTS.flicker.max(0.05)).oneMinus().clamp(0, 1);
  // stutter: ~24 Hz per-chunk coin flips whose pass chance tracks the envelope, so
  // dropouts start sparse and end total (threshold >1 before the fade = always on).
  // +4096 keeps the hash input positive for t < 0
  const stutter = step(hash(floor(t.mul(24)).add(seed.mul(917)).add(4096)), envelope.mul(1.25));
  const litScale = varying(envelope.mul(stutter)) as N;

  const nodes = facadeSurface({
    baseTone,
    bid,
    baseY,
    interiors: false,
    litWindows: true,
    litScale,
    frame: { pos: frozenPos, nrm: frozenNrm }
  });
  mat.colorNode = nodes.colorNode;
  mat.roughnessNode = nodes.roughnessNode;
  mat.metalnessNode = nodes.metalnessNode;
  mat.emissiveNode = nodes.emissiveNode;
  mat.normalNode = nodes.normalNode;
  mat.envMapIntensity = 1.0;
  return mat;
}
