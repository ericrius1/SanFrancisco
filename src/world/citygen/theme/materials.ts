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
  return standard(hex, 0.92, { emissive: 0.55 });
}

/** Build the shared id→material table (non-wall ids). Cached by the caller. */
export function buildCityGenMaterials(): Record<string, THREE.Material> {
  // window glass: light, sky-reflecting panes with a faint warm interior
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xaec6d2, roughness: 0.1, metalness: 0.1,
    transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide,
    clearcoat: 0.8, clearcoatRoughness: 0.15,
    emissive: new THREE.Color(0xffe6b8), emissiveIntensity: 0.18,
  });
  return {
    // walls (normally replaced per-building by makeWallMaterial; kept as fallback)
    "wall.victorian": standard(0xd9cdb0, 0.9),
    "wall.edwardian": standard(0xdcd8cc, 0.9),
    "wall.stucco": standard(0xeadfce, 0.92),
    "wall.commercial": standard(0xbfc2c4, 0.85),
    "wall.brick": standard(0x8f4a3a, 0.95),
    "wall.chinatown": standard(0xcabf9e, 0.88),
    // trim / cornice / bay frames — bright painted trim, the SF contrast
    "trim.victorian": standard(0xf9f4ea, 0.55, { emissive: 0.34 }),
    "trim.edwardian": standard(0xf2eee4, 0.55, { emissive: 0.34 }),
    // ground-floor base tones
    "base.stoop": standard(0xa89e8c, 0.82),
    "citygen.door": standard(0x53382c, 0.55, { emissive: 0.12 }),
    "citygen.room": standard(0x171922, 0.9, { emissive: 0.05 }),
    // glass
    "glass": glass,
    // roofs
    "roof.flatTrim": standard(0x6f6a60, 0.9),
    "roof.tileCornice": standard(0xa4593a, 0.85),
    "roof.parapet": standard(0x767068, 0.9),
  };
}
