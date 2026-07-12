// Coordinate-space helpers for TSL materials on InstancedMesh.
//
// Three r185 applies the instance matrix before evaluating material.positionNode,
// so positionLocal already contains the instance translation/rotation/scale there.
// Any LOD shrink must therefore pivot around an explicit instance anchor; scaling
// positionLocal directly also scales the world translation and launches instances
// toward the object origin.

import { modelWorldMatrix, modelWorldMatrixInverse, vec4 } from "three/tsl";

type TslNode = any;

/** Collapse an already-instanced position toward its mesh-local ground anchor. */
export function fadeAroundInstanceAnchor(position: TslNode, anchorLocal: TslNode, fade: TslNode): TslNode {
  return anchorLocal.add(position.sub(anchorLocal).mul(fade));
}

/** Convert a mesh-local instance anchor to world space for wind/trample queries. */
export function instanceAnchorWorld(anchorLocal: TslNode): TslNode {
  return (modelWorldMatrix as TslNode).mul(vec4(anchorLocal, 1)).xyz;
}

/** Convert a world-space displacement vector into post-instance mesh-local space. */
export function worldOffsetToModelLocal(offsetWorld: TslNode): TslNode {
  return (modelWorldMatrixInverse as TslNode).mul(vec4(offsetWorld, 0)).xyz;
}
