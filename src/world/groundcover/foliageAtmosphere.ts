// Cheap atmosphere path for high-overdraw foliage (grass, flowers, leaves,
// shrubs). Replaces the analytic sky IBL + marine dual-tri-noise fog with a
// hemispheric mean env and a distance-haze fog — see Sky.grassEnvNode /
// installGrassFog and docs/PERF_LEVELUP.md Wave 7.

import type * as THREE from "three/webgpu";
import { optionalSkyAtmosphere } from "../skyRegistry";

export function applyGroundcoverAtmosphere(
  material:
    | THREE.MeshSSSNodeMaterial
    | THREE.MeshStandardNodeMaterial
    | THREE.MeshLambertNodeMaterial
): void {
  const sky = optionalSkyAtmosphere();
  if (!sky) return;
  // MeshLambert uses BasicEnvironmentNode → cubeMapNode, which expects a
  // texture/cubemap path. Our GrassEnvNode is a plain radiance TempNode meant
  // for EnvironmentNode (Standard/SSS). Fog is safe on every foliage material.
  const isLambert = (material as THREE.MeshLambertNodeMaterial).isMeshLambertNodeMaterial === true;
  if (!isLambert) material.envNode = sky.grassEnvNode() as never;
  sky.installGrassFog(material);
}
