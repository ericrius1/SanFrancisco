// SF theme materials — resolves the material ids the grammar emits into real
// THREE materials. This is the render-side of the theme pack (THREE lives here,
// never in core/). The host calls buildCityGenMaterials() once and looks up
// meshData.materialId → material when building scene meshes.
//
// Colours are SF-authentic bases; per-building "painted lady" hue variety is
// applied on top via a seeded vertex tint at mesh-build time (Phase 3). No
// emissive on exteriors — the world sun lights them (interior glow is emissive
// and lives in the interior module).
import * as THREE from "three/webgpu";

function standard(color: number, roughness: number, metalness = 0): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color, roughness, metalness });
  m.envMapIntensity = 2.0; // match the app's low SkyEnv fill on shadowed facades
  return m;
}

/** Build the full id→material table for the SF theme. Cached by the caller. */
export function buildCityGenMaterials(): Record<string, THREE.Material> {
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0x9fb8c4, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.35,
    depthWrite: false, side: THREE.FrontSide,
  });
  return {
    // walls
    "wall.victorian": standard(0xe8e2d2, 0.85),   // warm off-white clapboard
    "wall.edwardian": standard(0xdcd8cc, 0.85),   // pale grey-cream
    "wall.stucco": standard(0xeadfce, 0.9),       // Marina stucco
    "wall.commercial": standard(0xbfc2c4, 0.8),   // grey masonry
    "wall.brick": standard(0x8f4a3a, 0.95),       // SoMa red brick
    "wall.chinatown": standard(0xcabf9e, 0.85),   // tenement tan
    // trim / cornice / bay frames
    "trim.victorian": standard(0xf6f2e9, 0.7),    // bright painted trim
    "trim.edwardian": standard(0xeeeae0, 0.7),
    // ground-floor base tones
    "base.stoop": standard(0x9a8f7d, 0.8),        // stone/garage tone
    // glass
    "glass": glass,
    // roofs
    "roof.flatTrim": standard(0x6f6a60, 0.9),
    "roof.tileCornice": standard(0xa4593a, 0.85), // terracotta tile
    "roof.parapet": standard(0x767068, 0.9),
  };
}
