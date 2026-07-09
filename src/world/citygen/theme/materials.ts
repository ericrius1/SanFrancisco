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
import { makeParallaxGlass } from "./parallaxWindow";

const ENV = 5.5;

/** A plain, DoubleSide standard material with a faint self-lit tint. */
function standard(col: number, roughness: number, opts: { metalness?: number; emissive?: number } = {}): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: col, roughness, metalness: opts.metalness ?? 0, side: THREE.DoubleSide });
  m.envMapIntensity = ENV;
  m.emissive = new THREE.Color(col);
  m.emissiveIntensity = opts.emissive ?? 0.22;
  return m;
}

/**
 * Per-building wall material carrying the painted-lady body colour. A brighter
 * self-lit tint than the trim so the colour is unmistakable against the near-white
 * trim in any lighting. (Kept a plain MeshStandardMaterial — node-material
 * colorNode/emissiveNode silently no-op'd under this app's WebGPU pipeline.)
 */
export function makeWallMaterial(hex: number): THREE.MeshStandardMaterial {
  return standard(hex, 0.92, { emissive: 0.3 });
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
    "citygen.room": standard(0x171922, 0.9, { emissive: 0.05 }),
    "citygen.awn": standard(0x8a3b34, 0.7, { emissive: 0.2 }),    // storefront awning
    "citygen.sign": standard(0x2c2f36, 0.6, { emissive: 0.28 }),  // shop signband
    // interiors — self-lit (the room has no sky light) so they read when entered
    "int.floor": standard(0x6b4e34, 0.8, { emissive: 0.4 }),    // wood floor
    "int.wood": standard(0x5a4028, 0.7, { emissive: 0.35 }),    // furniture / stairs
    "int.sofa": standard(0x7a5a52, 0.85, { emissive: 0.4 }),    // upholstery
    "int.glow": standard(0xffdca0, 0.9, { emissive: 2.4 }),     // warm lamp / hearth
    "int.wall": standard(0xcfc4b2, 0.94, { emissive: 0.42 }),   // interior partition (plaster)
    "int.ceil": standard(0xe6ddcb, 0.95, { emissive: 0.5 }),    // ceiling (brighter, self-lit)
    "int.trim": standard(0xece4d4, 0.6, { emissive: 0.4 }),     // baseboards / door casing
    "int.rug": standard(0x7a3b34, 0.9, { emissive: 0.38 }),     // area rug
    "int.metal": standard(0x8a8f96, 0.5, { metalness: 0.6, emissive: 0.3 }), // loft/industrial
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
    // roofs
    "roof.flatTrim": standard(0x6f6a60, 0.9),
    "roof.tileCornice": standard(0xa4593a, 0.85),
    "roof.parapet": standard(0x767068, 0.9),
  };
}
