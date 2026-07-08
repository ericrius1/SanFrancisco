import { createBox3D } from "box3d-wasm";
import { DOG, HORSE, actDim, thighPitch, kneeAngle, qRot, type CreatureSpec } from "../../src/creatures/quadruped.ts";
import { Box3DEnv } from "../core/box3dEnv.ts";
import { rng32 } from "../core/es.ts";
const box3d = await createBox3D();
const SPECS: Record<string, CreatureSpec> = { horse: HORSE, dog: DOG };
const creatureArg = process.argv.indexOf("--creature");
const creature = creatureArg >= 0 ? process.argv[creatureArg + 1] : "dog";
const target = SPECS[creature];
if (!target) throw new Error("unknown creature " + creature);
const spec: CreatureSpec = { ...target, cpg: { ...target.cpg, hipAmp: 0, kneeAmp: 0 } };
const env = new Box3DEnv(box3d, spec) as any;
env.reset(rng32(1));
const zero = new Float32Array(actDim(spec));
for (let s=0;s<300;s++) env.step(zero);
const names=['FL','FR','HL','HR'];
console.log('torsoY', env.state.torso.pos[1].toFixed(3));
for (let i=0;i<4;i++){
  const hipOff = qRot(env.state.torso.quat, spec.legs[i].hip);
  const hipW = [
    env.state.torso.pos[0] + hipOff[0],
    env.state.torso.pos[1] + hipOff[1],
    env.state.torso.pos[2] + hipOff[2]
  ];
  const sh = env.state.legs[i].shank;
  const seg = spec.legs[i].shank;
  const foot = qRot(sh.quat, [0, -(seg.halfHeight + seg.radius), 0]);
  const fx=sh.pos[0]+foot[0], fy=sh.pos[1]+foot[1], fz=sh.pos[2]+foot[2];
  console.log(`${names[i]}: thighPitch ${thighPitch(env.state,i).toFixed(2)} knee ${kneeAngle(env.state,i).toFixed(2)} | hip(${hipW.map(v=>v.toFixed(2)).join(',')}) foot(${fx.toFixed(2)},${fy.toFixed(2)},${fz.toFixed(2)}) footFromHipXZ dx=${(fx-hipW[0]).toFixed(2)} dz=${(fz-hipW[2]).toFixed(2)}`);
}
