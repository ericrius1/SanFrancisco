// One-draw WebGPU/TSL material for the Beach Pianist's small coastal birds.
// Static instance data describes each orbit while the vertex stage owns the
// path, heading and wing beat. The CPU therefore never uploads per-frame
// matrices for this background life layer.

import * as THREE from "three/webgpu";
import {
  attribute,
  cos,
  float,
  instancedBufferAttribute,
  positionLocal,
  sin,
  time,
  varying,
  vec3
} from "three/tsl";

type N = any;

export type PianoGroveBirdMaterialInputs = {
  /** radius x/z, angular speed, phase */
  motion: THREE.InstancedBufferAttribute;
  /** body scale, vertical wander, wing rate, wing amplitude */
  style: THREE.InstancedBufferAttribute;
  /** linear-space dusk silhouette tint */
  tint: THREE.InstancedBufferAttribute;
};

export function createPianoGroveBirdMaterial(
  inputs: PianoGroveBirdMaterialInputs
): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    depthWrite: true,
    fog: true,
    toneMapped: true
  });

  const motion = instancedBufferAttribute(inputs.motion) as N;
  const style = instancedBufferAttribute(inputs.style) as N;
  const wing = attribute("birdWing", "vec2") as N;
  const phase = (time as N).mul(motion.z).add(motion.w);

  // Local +Z is the beak direction. The analytic ellipse tangent supplies a
  // normalized forward/right frame without atan2, keeping the generated WGSL
  // branch-free and stable for the tiny-radius stationary perching instances.
  const tangentX = sin(phase).mul(motion.x).negate();
  const tangentZ = cos(phase).mul(motion.y);
  const tangentLength = tangentX.mul(tangentX).add(tangentZ.mul(tangentZ)).sqrt().max(0.0001);
  const forwardX = tangentX.div(tangentLength);
  const forwardZ = tangentZ.div(tangentLength);
  const rightX = forwardZ;
  const rightZ = forwardX.negate();

  // wing.y is a root-to-tip weight authored into the geometry. Both halves
  // rise together because abs(local x) is used; the slow secondary term opens
  // occasional glides so the silhouettes do not read as mechanical flapping.
  const glide = sin((time as N).mul(0.37).add(motion.w)).mul(0.5).add(0.5);
  const wingBeat = sin((time as N).mul(style.z).add(motion.w.mul(1.73)))
    .mul(style.w)
    .mul(glide.mul(0.42).add(0.58));
  const scale = style.x;
  const localX = (positionLocal as N).x.mul(scale);
  const localZ = (positionLocal as N).z.mul(scale);
  const localY = (positionLocal as N).y
    .add((positionLocal as N).x.abs().mul(wing.y).mul(wingBeat).mul(0.82))
    .mul(scale);

  const orbitX = cos(phase).mul(motion.x);
  const orbitZ = sin(phase).mul(motion.y);
  const lift = sin(phase.mul(1.67).add(motion.w.mul(0.61))).mul(style.y);
  const rotatedX = rightX.mul(localX).add(forwardX.mul(localZ));
  const rotatedZ = rightZ.mul(localX).add(forwardZ.mul(localZ));
  material.positionNode = (vec3 as N)(rotatedX.add(orbitX), localY.add(lift), rotatedZ.add(orbitZ));

  // A restrained root-to-tip value break preserves feather-plane readability
  // against dark trees while the palette remains a sunset-friendly silhouette.
  const tint = varying(instancedBufferAttribute(inputs.tint) as N) as N;
  const featherValue = float(0.86).add((varying(wing.y) as N).mul(0.14));
  material.colorNode = tint.mul(featherValue);
  return material;
}
