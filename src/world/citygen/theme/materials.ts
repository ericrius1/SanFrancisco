// SF theme materials — resolves the material ids the grammar emits into real
// THREE materials. Render-side of the theme pack (THREE lives here, never in
// core/). The host calls buildCityGenMaterials() once and looks up
// meshData.materialId → material when building scene meshes.
//
// Two lessons baked in from the reference kit + this app's lighting:
//  • DoubleSide — the grammar's quad winding isn't guaranteed outward, so
//    single-sided materials backface-cull half the façade (see-through buildings).
//  • The world has a strong sun + near-zero ambient (env ≈ 0.075), so a plain PBR
//    surface reads near-black in shade and blows out in direct sun. We lift
//    envMapIntensity AND add a faint self-lit emissive body tint so the colour
//    reads in any light (how the baked city stays colourful at dusk).
import * as THREE from "three/webgpu";
import { materialColor, uv, float, fract, floor as tslFloor, mod, mix, step, smoothstep, positionWorld, mx_noise_float } from "three/tsl";
import { EXPOSURE_REBASE } from "../../../config";
import { makeParallaxGlass } from "./parallaxWindow";

const ENV = 5.5;
const UV_SCALE = 3.0; // MUST match core/facade.ts (metric UVs = metres / UV_SCALE)

/** wall surface texture kind, chosen per archetype in render.ts */
export type WallKind = "clapboard" | "brick" | "stucco" | "smooth";

/** A plain, DoubleSide standard material with a faint self-lit tint. */
function standard(col: number, roughness: number, opts: { metalness?: number; emissive?: number } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: col, roughness, metalness: opts.metalness ?? 0, side: THREE.DoubleSide });
  m.envMapIntensity = ENV;
  m.emissive = new THREE.Color(col);
  // self-lit tints were authored against the reference exposure — rebased so
  // they render identically at the 1.0 anchor (see config.EXPOSURE_REBASE)
  m.emissiveIntensity = (opts.emissive ?? 0.22) * EXPOSURE_REBASE;
  return m;
}

/**
 * Per-building wall material carrying the painted-lady body colour. A brighter
 * self-lit tint than the trim so the colour is unmistakable against the near-white
 * trim in any lighting.
 *
 * PIPELINE-SHARING DESIGN (the hitch fix): the body colour enters the node graph
 * through `materialColor` — a per-material UNIFORM (material.color) — never as a
 * baked TSL constant, and the whole node graph is built ONCE per WallKind and
 * shared by every material instance. Two consequences:
 *   • every wall of a kind generates identical WGSL → one WebGPU pipeline per
 *     kind (per pass), reused city-wide, instead of a compile per building;
 *   • re-colouring is `m.color.set(hex)` — a uniform write, nothing rebuilds.
 */
// Self-lit body tint factor — the batched shell layer reuses this so a batched
// wall reads identically to a per-material one (both multiply the pattern by it).
export const WALL_EMISSIVE = 0.3 * EXPOSURE_REBASE;

// GRAYSCALE surface pattern per wall kind (no body colour) — a pure function of
// the wall UV/world position. Both the per-material wall (× material.color) and
// the batched-shell wall (× per-instance tint) multiply THIS by their colour, so
// the surface texture is defined once and stays in sync across both paths.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const wallPatternCache = new Map<WallKind, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function wallPattern(kind: WallKind): any {
  let p = wallPatternCache.get(kind);
  if (p) return p;
  // uv() is metric (metres / UV_SCALE) from each wall quad's corner — good for
  // surface patterns. positionWorld drives large-scale weathering mottle.
  const uy = uv().y.mul(UV_SCALE), ux = uv().x.mul(UV_SCALE); // metres up / along
  let pattern: any = float(1);
  if (kind === "clapboard") {
    // horizontal lap-siding shadow line every ~0.19 m
    const lap = fract(uy.mul(1 / 0.19));
    pattern = mix(float(0.8), float(1.0), smoothstep(0.0, 0.06, lap));
  } else if (kind === "brick") {
    // running-bond brick: offset alternate courses; mortar lines darken
    const course = 0.086, brickW = 0.22, mortar = 0.02;
    const row = tslFloor(uy.mul(1 / course));
    const xoff = mod(row, float(2)).mul(brickW * 0.5);
    const my = fract(uy.mul(1 / course));
    const mx = fract(ux.add(xoff).mul(1 / brickW));
    const face = step(mortar / course, my).mul(step(mortar / brickW, mx));
    // per-brick tone jitter so the wall isn't a flat field
    const brickId = tslFloor(uy.mul(1 / course)).add(tslFloor(ux.add(xoff).mul(1 / brickW)).mul(37.0));
    const jitter = fract(brickId.mul(0.113)).mul(0.16).add(0.9);
    pattern = mix(float(0.52), jitter, face); // mortar ≈ 0.52·body, brick face ≈ body·jitter
  } else if (kind === "stucco") {
    // fine troweled mottle
    pattern = mx_noise_float(positionWorld.mul(2.2)).mul(0.06).add(1);
  }
  const mottle = mx_noise_float(positionWorld.mul(0.12)).mul(0.04).add(1);
  p = pattern.mul(mottle);
  wallPatternCache.set(kind, p);
  return p;
}

type WallNodes = { color: THREE.MeshStandardNodeMaterial["colorNode"]; emissive: THREE.MeshStandardNodeMaterial["emissiveNode"] };
const wallNodeCache = new Map<WallKind, WallNodes>();
function wallNodes(kind: WallKind): WallNodes {
  let g = wallNodeCache.get(kind);
  if (g) return g;
  const tinted = materialColor.mul(wallPattern(kind));
  // self-lit body tint (the world's ambient is near-zero) so shaded façades read.
  g = { color: tinted as WallNodes["color"], emissive: tinted.mul(float(WALL_EMISSIVE)) as WallNodes["emissive"] };
  wallNodeCache.set(kind, g);
  return g;
}

/** Trim hex per trim material id — the instanced window layer tints its shared
 *  trim mesh per instance instead of binding these materials (KEEP IN SYNC with
 *  the `standard()` colours in buildCityGenMaterials below). */
export const MODULE_TRIM_HEX: Record<string, number> = {
  "trim.victorian": 0xf9f4ea,
  "trim.edwardian": 0xf2eee4,
};

export function makeWallMaterial(hex: number, kind: WallKind = "smooth"): THREE.MeshStandardNodeMaterial {
  const m = new THREE.MeshStandardNodeMaterial({ roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
  m.envMapIntensity = ENV;
  const g = wallNodes(kind);
  m.colorNode = g.color;
  m.emissiveNode = g.emissive;
  m.color.set(hex); // read by materialColor inside the shared graph — a uniform
  return m;
}

/** Build the shared id→material table (non-wall ids). Cached by the caller. */
export function buildCityGenMaterials(): Record<string, THREE.Material> {
  // window glass: parallax/raymarched interior — each pane shows a shallow
  // recessed room behind the glass that shifts with the camera (see
  // parallaxWindow.ts), plus a glassy sky sheen and distance/grazing fades. The
  // default zone is a warm residential parlor; render.ts can call
  // makeParallaxGlass({ zone }) per building for shopfronts/lofts and hand that
  // material to buildBuilding as the glass.
  const glass = makeParallaxGlass();
  return {
    // walls (normally replaced per-building by makeWallMaterial; kept as fallback)
    "wall.victorian": standard(0xd9cdb0, 0.9),
    "wall.edwardian": standard(0xdcd8cc, 0.9),
    "wall.stucco": standard(0xeadfce, 0.92),
    "wall.commercial": standard(0xbfc2c4, 0.85),
    "wall.brick": standard(0x8f4a3a, 0.95),
    "wall.chinatown": standard(0xcabf9e, 0.88),
    // trim / cornice / bay frames — bright painted trim, the SF contrast
    "trim.victorian": standard(0xf9f4ea, 0.55, { emissive: 0.16 }),
    "trim.edwardian": standard(0xf2eee4, 0.55, { emissive: 0.16 }),
    // ground-floor base tones
    "base.stoop": standard(0xa89e8c, 0.82),
    "citygen.door": standard(0x53382c, 0.55, { emissive: 0.12 }),
    // operable front-door LEAF — same look as citygen.door but its OWN id +
    // material instance: mergePanels buckets it into a dedicated sub-mesh (named
    // "citygen.doorleaf" by assembleBuilding) that the ring runtime finds/hides
    // when the player opens a door with E, and the dynamic swinging leaf reuses
    // this shared material so baked + live leaves match exactly.
    "citygen.doorleaf": standard(0x53382c, 0.55, { emissive: 0.12 }),
    // Dedicated closed-door occluder. Unlike the generic room-dark material this
    // bucket is owned by the door runtime, which hides it with the baked leaf so
    // an opened doorway reveals the real lazy-built interior instead of leaving
    // an intangible black quad across the threshold.
    "citygen.doorback": standard(0x171922, 0.9, { emissive: 0.05 }),
    // Small live-leaf accents. These stay shared city-wide; an animated door adds
    // only geometry, never a one-off material/pipeline.
    "citygen.door.panel": standard(0x794b35, 0.68, { emissive: 0.14 }),
    "citygen.door.hardware": standard(0xd8bd70, 0.28, { metalness: 0.78, emissive: 0.28 }),
    "citygen.room": standard(0x171922, 0.9, { emissive: 0.05 }),
    "citygen.awn": standard(0x8a3b34, 0.7, { emissive: 0.2 }),    // storefront awning
    "citygen.sign": standard(0x2c2f36, 0.6, { emissive: 0.28 }),  // shop signband
    // interiors — self-lit (the room has no sky light) so they read when entered
    "int.floor": standard(0x6b4e34, 0.8, { emissive: 0.4 }),    // wood floor
    "int.floor.light": standard(0x9c7449, 0.78, { emissive: 0.42 }), // sunlit oak / refined homes
    "int.floor.tile": standard(0xc9bba4, 0.82, { emissive: 0.48 }),  // kitchens, baths, polished entries
    "int.wood": standard(0x5a4028, 0.7, { emissive: 0.35 }),    // furniture / stairs
    "int.sofa": standard(0x7a5a52, 0.85, { emissive: 0.4 }),    // upholstery
    "int.fabric.blue": standard(0x486a82, 0.86, { emissive: 0.42 }),
    "int.fabric.green": standard(0x55715c, 0.88, { emissive: 0.4 }),
    "int.fabric.gold": standard(0xb68a42, 0.84, { emissive: 0.44 }),
    "int.linen": standard(0xe9dfcb, 0.9, { emissive: 0.54 }),
    "int.glow": standard(0xffdca0, 0.9, { emissive: 2.4 }),     // warm lamp / hearth
    "int.wall": standard(0xd7ccba, 0.94, { emissive: 0.62 }),   // interior partition (plaster)
    "int.wall.warm": standard(0xe4d7c2, 0.94, { emissive: 0.62 }),
    "int.wall.sage": standard(0xc7d0c0, 0.94, { emissive: 0.58 }),
    "int.wall.cool": standard(0xbfc7cd, 0.92, { emissive: 0.55 }),
    "int.ceil": standard(0xefe7d6, 0.95, { emissive: 0.85 }),   // ceiling doubles as the room's fill light
    "int.window": standard(0xbcd6ea, 0.3, { emissive: 2.6 }),   // daylight behind an interior window (bright, so rooms aren't caves)
    "int.window.haze": standard(0xd8c9ad, 0.62, { emissive: 1.35 }), // warm horizon layer in the stylized view
    "int.window.city": standard(0x66747d, 0.82, { emissive: 0.62 }), // distant low-poly skyline silhouettes
    "int.trim": standard(0xece4d4, 0.6, { emissive: 0.4 }),     // baseboards / door casing
    "int.rug": standard(0x7a3b34, 0.9, { emissive: 0.38 }),     // area rug
    "int.metal": standard(0x8a8f96, 0.5, { metalness: 0.6, emissive: 0.3 }), // loft/industrial
    "int.brass": standard(0xc79b45, 0.34, { metalness: 0.68, emissive: 0.35 }),
    "int.plant": standard(0x47734b, 0.9, { emissive: 0.3 }),
    "int.book": standard(0x7a3e36, 0.82, { emissive: 0.3 }),
    "int.ceramic": standard(0xd5c9b6, 0.55, { emissive: 0.48 }),
    "int.counter": standard(0x40352a, 0.6, { emissive: 0.34 }), // shop counter / shelving
    // placeholder framed art (paintings/photos) — self-lit so they read on the wall;
    // real art textures come later. int.frame = the gilt/dark frame around each.
    "int.frame": standard(0x2a231a, 0.5, { metalness: 0.3, emissive: 0.5 }),
    "int.art1": standard(0x3f5d7a, 0.85, { emissive: 0.9 }),    // cool landscape
    "int.art2": standard(0x8a5a2c, 0.85, { emissive: 0.9 }),    // warm portrait/sepia
    "int.art3": standard(0x5a7a4a, 0.85, { emissive: 0.9 }),    // green pastoral
    "int.art4": standard(0x7a3550, 0.85, { emissive: 0.9 }),    // rose abstract
    // large-commercial (big downtown/warehouse blocks) — stone base + banding
    "lc.stone": standard(0xb8b0a2, 0.82),                       // limestone/precast base
    "lc.band": standard(0xd9d2c4, 0.7, { emissive: 0.14 }),     // spandrel banding
    "lc.pier": standard(0x9a948a, 0.85),                        // vertical piers
    // glass
    "glass": glass,
    // roofs — you see these from the air + hills, so they must READ (not crush to
    // black at play exposure): tar-and-gravel grey with a strong self-lit term.
    "roof.flatTrim": standard(0x9a9384, 0.92, { emissive: 0.5 }),
    "roof.tileCornice": standard(0xb56545, 0.85, { emissive: 0.4 }),   // clay tile, warm
    "roof.parapet": standard(0x969084, 0.9, { emissive: 0.5 }),
  };
}
