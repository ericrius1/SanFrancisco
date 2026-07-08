import { createBox3D } from "box3d-wasm";
import { DOG, HORSE, actDim, qRot, type CreatureSpec } from "../../src/creatures/quadruped.ts";
import { Box3DEnv } from "../core/box3dEnv.ts";
import { rng32 } from "../core/es.ts";

const box3d = await createBox3D();
const SPECS: Record<string, CreatureSpec> = { horse: HORSE, dog: DOG };
const creatureArg = process.argv.indexOf("--creature");
const creature = creatureArg >= 0 ? process.argv[creatureArg + 1] : "dog";
const target = SPECS[creature];
if (!target) throw new Error("unknown creature " + creature);

function footY(env: any, spec: CreatureSpec, i: number) {
  const sh = env.state.legs[i].shank;
  const seg = spec.legs[i].shank;
  const o = qRot(sh.quat as any, [0, -(seg.halfHeight + seg.radius), 0]);
  return sh.pos[1] + o[1];
}
function run(label: string, spec: CreatureSpec) {
  const env = new Box3DEnv(box3d, spec);
  env.reset(rng32(1));
  const zero = new Float32Array(actDim(spec));
  console.log(`\n[${label}]`);
  for (let s = 0; s < 480; s++) {
    env.step(zero);
    if (s % 60 === 59) {
      const t = env.state.torso; const up = qRot(t.quat as any, [0, 1, 0]);
      const feet = [0,1,2,3].map(i => footY(env, spec, i).toFixed(2)).join(",");
      console.log(`  t=${(s/120).toFixed(1)}s torsoY=${t.pos[1].toFixed(3)} up.y=${up[1].toFixed(2)} feetY=[${feet}]`);
    }
  }
}
const stand: CreatureSpec = { ...target, cpg: { ...target.cpg, hipAmp: 0, kneeAmp: 0 } };
run(`${target.name.toUpperCase()} PURE STANCE (no gait)`, stand);
run(`${target.name.toUpperCase()} DEFAULT GAIT`, target);
