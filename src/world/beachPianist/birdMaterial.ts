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
  mix,
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
  // Clamp every instanced control before it reaches vertex position math. These
  // buffers are static, but a bad/partial attribute read must never be able to
  // turn one tiny background bird into a screen-spanning triangle.
  const radiusX = motion.x.clamp(0.001, 32);
  const radiusZ = motion.y.clamp(0.001, 32);
  const angularSpeed = motion.z.clamp(0, 0.6);
  const instancePhase = motion.w.clamp(0, Math.PI * 2);
  const phase = (time as N).mul(angularSpeed).add(instancePhase);

  // Local +Z is the beak direction. The analytic ellipse tangent supplies a
  // normalized forward/right frame without atan2, keeping the generated WGSL
  // branch-free and stable for the tiny-radius stationary perching instances.
  const tangentX = sin(phase).mul(radiusX).negate();
  const tangentZ = cos(phase).mul(radiusZ);
  const tangentLength = tangentX.mul(tangentX).add(tangentZ.mul(tangentZ)).sqrt().max(0.0001);
  const forwardX = tangentX.div(tangentLength);
  const forwardZ = tangentZ.div(tangentLength);
  const rightX = forwardZ;
  const rightZ = forwardX.negate();

  // Rotate each complete wing as one rigid plane around its authored root.
  // The previous root-to-tip Y displacement sheared individual triangles; at
  // grazing angles that could read as the very long spikes seen above the
  // grove. A bounded rotation preserves every triangle's edge lengths.
  const wingSide = wing.x.clamp(-1, 1);
  const wingMask = wingSide.abs().clamp(0, 1);
  const glide = sin((time as N).mul(0.37).add(instancePhase)).mul(0.5).add(0.5);
  const flapRate = style.z.clamp(0, 9);
  const flapAmplitude = style.w.clamp(0, 0.85);
  const wingBeat = sin((time as N).mul(flapRate).add(instancePhase.mul(1.73)))
    .mul(flapAmplitude)
    .mul(glide.mul(0.42).add(0.58));
  const flapAngle = wingBeat.mul(wingSide).mul(0.82).clamp(-0.72, 0.72);
  const wingPivotX = wingSide.mul(0.05);
  const wingFromRootX = (positionLocal as N).x.sub(wingPivotX);
  const rigidWingX = wingPivotX.add(wingFromRootX.mul(cos(flapAngle)));
  const rigidWingY = (positionLocal as N).y.add(wingFromRootX.mul(sin(flapAngle)));
  const scale = style.x.clamp(0.3, 1.15);
  const localX = (mix as N)((positionLocal as N).x, rigidWingX, wingMask).mul(scale);
  const localZ = (positionLocal as N).z.mul(scale);
  const localY = (mix as N)((positionLocal as N).y, rigidWingY, wingMask).mul(scale);

  const orbitX = cos(phase).mul(radiusX);
  const orbitZ = sin(phase).mul(radiusZ);
  const lift = sin(phase.mul(1.67).add(instancePhase.mul(0.61)))
    .mul(style.y.clamp(0, 4));
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
