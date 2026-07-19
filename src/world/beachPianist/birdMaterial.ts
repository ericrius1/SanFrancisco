// One-draw WebGPU/TSL material for the Beach Pianist's small coastal birds.
// Static instance data describes each orbit AND its perch cycle while the
// vertex stage owns the path, heading, wing beat and landings. The CPU
// therefore never uploads per-frame matrices for this background life layer.

import * as THREE from "three/webgpu";
import {
  attribute,
  cos,
  float,
  fract,
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
  /** Orbit centre in site-local space. Deliberately an attribute, NOT the
   *  instance matrix: r185's InstanceNode multiplies `positionLocal` by the
   *  instance matrix BEFORE a custom positionNode runs, so a translation
   *  stored there would be scaled/rotated by the flight frame below and
   *  scatter every bird. Instance matrices must stay identity. */
  center: THREE.InstancedBufferAttribute;
  /** radius x/z, angular speed, phase */
  motion: THREE.InstancedBufferAttribute;
  /** body scale, vertical wander, wing rate, wing amplitude */
  style: THREE.InstancedBufferAttribute;
  /** 1/cyclePeriod, fly-fraction end (2 = never perch), cycle phase, blend width */
  cycle: THREE.InstancedBufferAttribute;
  /** landing point relative to the orbit centre, settled facing yaw */
  perch: THREE.InstancedBufferAttribute;
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

  const center = instancedBufferAttribute(inputs.center) as N;
  const motion = instancedBufferAttribute(inputs.motion) as N;
  const style = instancedBufferAttribute(inputs.style) as N;
  const cycle = instancedBufferAttribute(inputs.cycle) as N;
  const perch = instancedBufferAttribute(inputs.perch) as N;
  const wing = attribute("birdWing", "vec2") as N;
  // Clamp every instanced control before it reaches vertex position math. These
  // buffers are static, but a bad/partial attribute read must never be able to
  // turn one tiny background bird into a screen-spanning triangle.
  const radiusX = motion.x.clamp(0.001, 32);
  const radiusZ = motion.y.clamp(0.001, 32);
  const angularSpeed = motion.z.clamp(0, 1.0);
  const instancePhase = motion.w.clamp(0, Math.PI * 2);
  const flightMask = smoothstep(0.01, 0.06, angularSpeed) as N;
  const verticalWander = style.y.clamp(0, 4.8);
  const invPeriod = cycle.x.clamp(0.005, 1);
  const flyEnd = cycle.y.clamp(0, 2);
  const cyclePhase = cycle.z.clamp(0, 1);
  const blendWidth = cycle.w.clamp(0.01, 0.25);
  const perchX = perch.x.clamp(-64, 64);
  const perchY = perch.y.clamp(-64, 64);
  const perchZ = perch.z.clamp(-64, 64);
  const perchYaw = perch.w;

  // Layered incommensurate harmonics turn perfect ellipses into loose,
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

  // Perch weight over the cycle phase s ∈ [0,1): 0 while cruising, ramps to 1
  // across the glide-in window before `flyEnd`, holds 1 while settled, and
  // ramps back to 0 across the take-off window at the end of the cycle — so
  // the weight is continuous through the phase wrap. Always-fly instances put
  // `flyEnd` beyond the phase range and the first smoothstep never leaves 0.
  const perchWeightAt = (dtSeconds: number) => {
    const s = fract((time as N).add(dtSeconds).mul(invPeriod).add(cyclePhase)) as N;
    return (smoothstep as N)(flyEnd.sub(blendWidth), flyEnd, s).mul(
      float(1).sub((smoothstep as N)(float(1).sub(blendWidth), 1, s))
    );
  };

  // The rendered path is the orbit blended toward the landing point by the
  // perch weight; sampling the SAME composite at small time look-aheads gives
  // a true 3D flight frame that swoops into the crown and climbs back out.
  const compositeAt = (dtSeconds: number) => {
    const clock = (time as N).add(dtSeconds).mul(angularSpeed).add(instancePhase);
    const flight = sampleFlight(clock);
    const weight = perchWeightAt(dtSeconds);
    return {
      x: (mix as N)(flight.x, perchX, weight),
      y: (mix as N)(flight.y, perchY, weight),
      z: (mix as N)(flight.z, perchZ, weight),
      weight
    };
  };

  const path = compositeAt(0);
  const pathAhead = compositeAt(0.12);
  const pathFarAhead = compositeAt(0.24);
  const perchWeight = path.weight;
  const airborne = float(1).sub(perchWeight);
  // Settled birds keep an authored facing: the composite tangent collapses to
  // zero length on the perch plateau, so the flight frame hands the heading to
  // the perch yaw across the final approach instead of normalizing noise.
  const settleBlend = (smoothstep as N)(0.7, 0.96, perchWeight);
  const perchForwardX = sin(perchYaw);
  const perchForwardZ = cos(perchYaw);

  const tangentX = pathAhead.x.sub(path.x);
  const tangentY = pathAhead.y.sub(path.y);
  const tangentZ = pathAhead.z.sub(path.z);
  const tangentLength = tangentX
    .mul(tangentX)
    .add(tangentY.mul(tangentY))
    .add(tangentZ.mul(tangentZ))
    .sqrt()
    .max(0.0001);
  const mixedForwardX = (mix as N)(tangentX.div(tangentLength), perchForwardX, settleBlend);
  const mixedForwardY = (mix as N)(tangentY.div(tangentLength), 0, settleBlend);
  const mixedForwardZ = (mix as N)(tangentZ.div(tangentLength), perchForwardZ, settleBlend);
  const mixedForwardLength = mixedForwardX
    .mul(mixedForwardX)
    .add(mixedForwardY.mul(mixedForwardY))
    .add(mixedForwardZ.mul(mixedForwardZ))
    .sqrt()
    .max(0.0001);
  const forwardX = mixedForwardX.div(mixedForwardLength);
  const forwardY = mixedForwardY.div(mixedForwardLength);
  const forwardZ = mixedForwardZ.div(mixedForwardLength);
  const horizontalLength = forwardX.mul(forwardX).add(forwardZ.mul(forwardZ)).sqrt().max(0.0001);
  const headingX = forwardX.div(horizontalLength);
  const headingZ = forwardZ.div(horizontalLength);

  const aheadX = pathFarAhead.x.sub(pathAhead.x);
  const aheadZ = pathFarAhead.z.sub(pathAhead.z);
  const aheadLength = aheadX.mul(aheadX).add(aheadZ.mul(aheadZ)).sqrt().max(0.0001);
  const turn = headingX
    .mul(aheadZ.div(aheadLength))
    .sub(headingZ.mul(aheadX.div(aheadLength)));
  const bankAngle = turn
    .mul(10)
    .add(sin((time as N).mul(angularSpeed).mul(0.71).add(instancePhase.mul(2.31))).mul(0.075))
    .mul(flightMask)
    .mul(airborne)
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
  // A bounded rotation preserves every triangle's edge lengths, so grazing
  // angles can never smear a wing into a screen-length spike.
  const wingSide = wing.x.clamp(-1, 1);
  const wingMask = wingSide.abs().clamp(0, 1);
  const flapRate = style.z.clamp(0, 32);
  const flapAmplitude = style.w.clamp(0, 0.85);
  const activity = flapAmplitude.sub(0.45).div(0.4).clamp(0, 1);
  const burstClock = (time as N)
    .mul(float(0.4).add(angularSpeed.mul(0.75)))
    .add(instancePhase.mul(2.17));
  const burstWave = sin(burstClock).add(sin(burstClock.mul(0.47).add(instancePhase)).mul(0.32));
  const burstThreshold = (mix as N)(0.22, -0.14, activity);
  const cruiseGate = (smoothstep as N)(
    burstThreshold.sub(0.2),
    burstThreshold.add(0.2),
    burstWave
  );
  // Take-off and final approach always power-flap: the transition weight peaks
  // mid-blend, exactly where a real bird brakes or climbs hardest.
  const transitionFlap = perchWeight.mul(airborne).mul(4).clamp(0, 1);
  const flapGate = cruiseGate.max(transitionFlap).mul(flightMask);
  const flapClock = (time as N).mul(flapRate).add(instancePhase.mul(2.73));
  const wingBeat = sin(flapClock)
    .mul(0.86)
    .add(sin(flapClock.mul(2).sub(0.6)).mul(0.14));
  const glideDihedral = sin((time as N).mul(angularSpeed).mul(0.71).add(instancePhase))
    .mul(0.025)
    .add(0.11);
  const flightWingPose = (mix as N)(
    glideDihedral,
    wingBeat.mul(flapAmplitude).mul(0.72),
    flapGate
  ).mul(flightMask);
  // Settled birds tuck their wings; a rare, tiny shuffle keeps them alive
  // without reading as restlessness from the performance area below.
  const shufflePulse = (smoothstep as N)(
    0.985,
    1,
    sin((time as N).mul(0.31).add(instancePhase.mul(7)))
  );
  const perchedWingPose = float(0.32).add(
    sin((time as N).mul(9).add(instancePhase.mul(17))).mul(shufflePulse).mul(0.06)
  );
  const foldBlend = (smoothstep as N)(0.6, 0.92, perchWeight);
  const wingPose = (mix as N)(flightWingPose, perchedWingPose, foldBlend);
  const flapAngle = wingPose.mul(wingSide).clamp(-0.7, 0.7);
  const wingPivotX = wingSide.mul(0.05);
  const wingFromRootX = (positionLocal as N).x.sub(wingPivotX);
  const rigidWingX = wingPivotX.add(wingFromRootX.mul(cos(flapAngle)));
  const rigidWingY = (positionLocal as N).y.add(wingFromRootX.mul(sin(flapAngle)));
  const scale = style.x.clamp(0.3, 1.15);
  const localX = (mix as N)((positionLocal as N).x, rigidWingX, wingMask).mul(scale);
  const localZ = (positionLocal as N).z.mul(scale);
  const localY = (mix as N)((positionLocal as N).y, rigidWingY, wingMask).mul(scale);

  const bodyHeave = cos(flapClock).mul(flapGate).mul(scale).mul(0.018).mul(airborne);
  const rotatedX = bankRightX.mul(localX).add(bankUpX.mul(localY)).add(forwardX.mul(localZ));
  const rotatedY = bankRightY
    .mul(localX)
    .add(bankUpY.mul(localY))
    .add(forwardY.mul(localZ));
  const rotatedZ = bankRightZ.mul(localX).add(bankUpZ.mul(localY)).add(forwardZ.mul(localZ));
  const centerX = center.x.clamp(-160, 160);
  const centerY = center.y.clamp(-160, 160);
  const centerZ = center.z.clamp(-160, 160);
  material.positionNode = (vec3 as N)(
    rotatedX.add(path.x).add(centerX),
    rotatedY.add(path.y).add(bodyHeave).add(centerY),
    rotatedZ.add(path.z).add(centerZ)
  );

  // A restrained root-to-tip value break preserves feather-plane readability
  // against dark trees while the palette remains a sunset-friendly silhouette.
  const tint = varying(instancedBufferAttribute(inputs.tint) as N) as N;
  const featherValue = float(0.86).add((varying(wing.y) as N).mul(0.14));
  material.colorNode = tint.mul(featherValue);
  return material;
}
