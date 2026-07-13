import * as THREE from "three/webgpu";
import { enableShadowLayer, SHADOW_LAYERS } from "../world/shadows/shadowLayers";

/**
 * Vehicle shadow policy shared by the stock embodiment builders.
 *
 * Casting is deliberately opt-in: every caster is another draw in the full-rate
 * hero projection, so builders nominate only meshes carrying a large silhouette.
 * Receiving is much broader and does not add shadow-map draws. Opaque, lit
 * surfaces receive by default; transparent layers and self-lit FX stay out so
 * windscreens, prop discs, lamps, rails, plumes, and particles do not acquire
 * implausible shadowing or shadow-pass variants.
 */
function isOpaqueLitSurface(material: THREE.Material): boolean {
  if (
    !material.visible ||
    material.transparent ||
    material.opacity < 0.999 ||
    !material.depthWrite ||
    material.blending !== THREE.NormalBlending
  ) {
    return false;
  }

  const m = material as THREE.Material & {
    isMeshBasicMaterial?: boolean;
    isPointsMaterial?: boolean;
    isSpriteMaterial?: boolean;
    isLineBasicMaterial?: boolean;
    emissive?: THREE.Color;
    emissiveNode?: unknown;
  };
  if (m.isMeshBasicMaterial || m.isPointsMaterial || m.isSpriteMaterial || m.isLineBasicMaterial) return false;
  if (m.emissiveNode != null) return false;
  if (m.emissive && m.emissive.r + m.emissive.g + m.emissive.b > 1e-5) return false;
  return true;
}

export function applyVehicleShadowPolicy(
  root: THREE.Object3D,
  casters: Iterable<THREE.Object3D>,
  forcedReceivers: Iterable<THREE.Object3D> = casters
): void {
  const casterSet = new Set(casters);
  const forcedReceiverSet = new Set(forcedReceivers);

  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;

    const materials = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.Material[];
    const casts = casterSet.has(mesh);
    mesh.castShadow = casts;
    if (casts) enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
    mesh.receiveShadow = casts || forcedReceiverSet.has(mesh) || materials.some(isOpaqueLitSurface);
  });
}
