// Pure building generation. Workers must import this module directly; the
// public index also exports the scene runtime and its WebGPU dependency graph.
import { massBuilding, type Massing } from "./core/massing";
import { mergePanels } from "./core/mesh";
import { buildingColliders } from "./core/collider";
import type { BuildingSpec, ColliderBox, MeshData, ModuleInstance } from "./core/types";
import { specFor } from "./theme/archetypes";
import { decoratorFor } from "./theme/decorators";
import { expandModuleInstances } from "./theme/moduleDefs";


/** Generate one building's geometry + colliders from its spec (pure; no scene).
 *  The theme's per-archetype façade decorator authors the detail (Victorian
 *  canted bays, etc.); the mass silhouette always equals the real footprint.
 *  `withDoor` cuts a walk-through doorway in the street wall + returns where.
 *
 *  Windows come back as kit-of-parts INSTANCES (`instances` + `matTable`)
 *  rather than baked triangles; hosts with the instanced module layer draw
 *  them there, everyone else calls `expandModuleInstances` (or passes
 *  `expandModules: true`) to fold them back into `meshes`. */
export function generate(spec: BuildingSpec, withDoor = false, opts: { expandModules?: boolean } = {}): { mass: Massing; meshes: MeshData[]; instances: ModuleInstance[]; matTable: string[]; colliders: ColliderBox[]; door: import("./core/collider").DoorOpening | null } {
  const arch = specFor(spec.archetype);
  const mass = massBuilding(spec, arch, decoratorFor(spec.archetype));
  let panels = mass.panels;
  let instances = mass.instances;
  let matTable = mass.matTable;
  if (opts.expandModules && instances.length) {
    panels = panels.concat(expandModuleInstances(instances, matTable));
    instances = [];
    matTable = [];
  }
  const meshes = mergePanels(panels);
  const { boxes: colliders, door } = buildingColliders(spec, withDoor);
  return { mass, meshes, instances, matTable, colliders, door };
}
