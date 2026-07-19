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
  smoothstep,
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
  const flightMask = smoothstep(0.01, 0.06, angularSpeed) as N;
  const clockPhase = (time as N).mul(angularSpeed).add(instancePhase);
  const verticalWander = style.y.clamp(0, 4.8);

  // Layered incommensurate harmonics turn the old perfect ellipses into loose,
  // asymmetric circuits. Warping the travel phase also eases each bird through
  // wide turns instead of moving at visibly constant angular speed. The
  // derivative of the warp remains positive, so a bird can never reverse.
  const sampleFlight = (clock: N) => {
    const warped = clock
      .add(sin(clock.mul(0.47).add(instancePhase.mul(1.13))).mul(0.2))
      .add(sin(clock.mul(1.73).add(instancePhase.mul(0.71))).mul(0.055));
    return {
      x: cos(warped)
        .mul(radiusX)
        .add(sin(warped.mul(0.59).add(instancePhase.mul(1.7))).mul(radiusX).mul(0.11))
        .add(cos(warped.mul(2.17).add(instancePhase.mul(0.37))).mul(radiusX).mul(0.055)),
      y: sin(warped.mul(1.31).add(instancePhase.mul(0.83)))
        .mul(verticalWander)
        .mul(0.72)
        .add(
          sin(warped.mul(0.47).add(instancePhase.mul(1.91)))
            .mul(verticalWander)
            .mul(0.28)
        ),
      z: sin(warped)
        .mul(radiusZ)
        .add(cos(warped.mul(0.53).add(instancePhase.mul(0.93))).mul(radiusZ).mul(0.12))
        .add(sin(warped.mul(1.83).add(instancePhase.mul(1.41))).mul(radiusZ).mul(0.06))
    };
  };

  // Two inexpensive look-ahead samples provide a true 3D flight frame and
  // local curvature. Birds now pitch with climbs and bank into turns instead
  // of sliding upright around a flat orbit. Local +Z remains beak-forward.
  const path = sampleFlight(clockPhase);
  const pathAhead = sampleFlight(clockPhase.add(0.04));
  const pathFarAhead = sampleFlight(clockPhase.add(0.08));
  const tangentX = pathAhead.x.sub(path.x);
  const tangentY = pathAhead.y.sub(path.y);
  const tangentZ = pathAhead.z.sub(path.z);
  const tangentLength = tangentX
    .mul(tangentX)
    .add(tangentY.mul(tangentY))
    .add(tangentZ.mul(tangentZ))
    .sqrt()
    .max(0.0001);
  const forwardX = tangentX.div(tangentLength);
  const forwardY = tangentY.div(tangentLength);
  const forwardZ = tangentZ.div(tangentLength);
  const horizontalLength = tangentX.mul(tangentX).add(tangentZ.mul(tangentZ)).sqrt().max(0.0001);
  const headingX = tangentX.div(horizontalLength);
  const headingZ = tangentZ.div(horizontalLength);

  const aheadX = pathFarAhead.x.sub(pathAhead.x);
  const aheadZ = pathFarAhead.z.sub(pathAhead.z);
  const aheadLength = aheadX.mul(aheadX).add(aheadZ.mul(aheadZ)).sqrt().max(0.0001);
  const turn = headingX
    .mul(aheadZ.div(aheadLength))
    .sub(headingZ.mul(aheadX.div(aheadLength)));
  const bankAngle = turn
    .mul(10)
    .add(sin(clockPhase.mul(0.71).add(instancePhase.mul(2.31))).mul(0.075))
    .mul(flightMask)
    .clamp(-0.58, 0.58);

  const rightX = headingZ;
  const rightZ = headingX.negate();
  // up = cross(forward, right); the horizontal right vector is perpendicular
  // to forward, so this basis is already normalized even while climbing.
  const upX = forwardY.mul(rightZ);
  const upY = forwardZ.mul(rightX).sub(forwardX.mul(rightZ));
  const upZ = forwardY.mul(rightX).negate();
  const bankCos = cos(bankAngle);
  const bankSin = sin(bankAngle);
  const bankRightX = rightX.mul(bankCos).add(upX.mul(bankSin));
  const bankRightY = upY.mul(bankSin);
  const bankRightZ = rightZ.mul(bankCos).add(upZ.mul(bankSin));
  const bankUpX = upX.mul(bankCos).sub(rightX.mul(bankSin));
  const bankUpY = upY.mul(bankCos);
  const bankUpZ = upZ.mul(bankCos).sub(rightZ.mul(bankSin));

  // Rotate each complete wing as one rigid plane around its authored root.
  // The previous root-to-tip Y displacement sheared individual triangles; at
  // grazing angles that could read as the very long spikes seen above the
  // grove. A bounded rotation preserves every triangle's edge lengths.
  const wingSide = wing.x.clamp(-1, 1);
  const wingMask = wingSide.abs().clamp(0, 1);
  const flapRate = style.z.clamp(0, 32);
  const flapAmplitude = style.w.clamp(0, 0.85);
  const activity = flapAmplitude.sub(0.45).div(0.4).clamp(0, 1);
  const burstClock = (time as N)
    .mul(float(0.34).add(angularSpeed.mul(0.72)))
    .add(instancePhase.mul(2.17));
  const burstWave = sin(burstClock).add(sin(burstClock.mul(0.47).add(instancePhase)).mul(0.32));
  const burstThreshold = (mix as N)(0.28, -0.08, activity);
  const flapGate = (smoothstep as N)(
    burstThreshold.sub(0.2),
    burstThreshold.add(0.2),
    burstWave
  ).mul(flightMask);
  const flapClock = (time as N).mul(flapRate).add(instancePhase.mul(2.73));
  const wingBeat = sin(flapClock)
    .mul(0.86)
    .add(sin(flapClock.mul(2).sub(0.6)).mul(0.14));
  const glideDihedral = sin(clockPhase.mul(0.71).add(instancePhase))
    .mul(0.025)
    .add(0.11);
  const wingPose = (mix as N)(
    glideDihedral,
    wingBeat.mul(flapAmplitude).mul(0.72),
    flapGate
  ).mul(flightMask);
  const flapAngle = wingPose.mul(wingSide).clamp(-0.7, 0.7);
  const wingPivotX = wingSide.mul(0.05);
  const wingFromRootX = (positionLocal as N).x.sub(wingPivotX);
  const rigidWingX = wingPivotX.add(wingFromRootX.mul(cos(flapAngle)));
  const rigidWingY = (positionLocal as N).y.add(wingFromRootX.mul(sin(flapAngle)));
  const scale = style.x.clamp(0.3, 1.15);
  const localX = (mix as N)((positionLocal as N).x, rigidWingX, wingMask).mul(scale);
  const localZ = (positionLocal as N).z.mul(scale);
  const localY = (mix as N)((positionLocal as N).y, rigidWingY, wingMask).mul(scale);

  const bodyHeave = cos(flapClock).mul(flapGate).mul(scale).mul(0.018);
  const rotatedX = bankRightX.mul(localX).add(bankUpX.mul(localY)).add(forwardX.mul(localZ));
  const rotatedY = bankRightY
    .mul(localX)
    .add(bankUpY.mul(localY))
    .add(forwardY.mul(localZ));
  const rotatedZ = bankRightZ.mul(localX).add(bankUpZ.mul(localY)).add(forwardZ.mul(localZ));
  material.positionNode = (vec3 as N)(
    rotatedX.add(path.x),
    rotatedY.add(path.y).add(bodyHeave),
    rotatedZ.add(path.z)
  );

  // A restrained root-to-tip value break preserves feather-plane readability
  // against dark trees while the palette remains a sunset-friendly silhouette.
  const tint = varying(instancedBufferAttribute(inputs.tint) as N) as N;
  const featherValue = float(0.86).add((varying(wing.y) as N).mul(0.14));
  material.colorNode = tint.mul(featherValue);
  return material;
}
