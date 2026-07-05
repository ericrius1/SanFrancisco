import { readFileSync } from 'node:fs';
const path = process.argv[2] || 'rl/runs/horse_gen40.frames.json';
const d = JSON.parse(readFileSync(path,'utf8'));
const F = d.frames; const SH=0.13, SR=0.045, off=SH+SR;
function qRot(q,v){const[x,y,z,w]=q;const tx=2*(y*v[2]-z*v[1]),ty=2*(z*v[0]-x*v[2]),tz=2*(x*v[1]-y*v[0]);
  return [v[0]+w*tx+(y*tz-z*ty), v[1]+w*ty+(z*tx-x*tz), v[2]+w*tz+(x*ty-y*tx)];}
const legNames=['FL','FR','HL','HR'];
const footH=[[],[],[],[]]; let bmn=9,bmx=-9;
for(const f of F){ bmn=Math.min(bmn,f.links[0].pos[1]); bmx=Math.max(bmx,f.links[0].pos[1]);
  for(let i=0;i<4;i++){const L=f.links[2+i*2];const ft=qRot(L.quat,[0,-off,0]);footH[i].push(L.pos[1]+ft[1]);}}
console.log('file',path,'reward',d.reward,'frames',F.length);
console.log('torso bob',(bmx-bmn).toFixed(3),'meanH',(F.reduce((s,f)=>s+f.links[0].pos[1],0)/F.length).toFixed(3));
for(let i=0;i<4;i++){const h=footH[i];const mn=Math.min(...h),mx=Math.max(...h);
  const duty=h.filter(v=>v<0.07).length/h.length;
  console.log(`${legNames[i]}: footY ${mn.toFixed(3)}..${mx.toFixed(3)} lift ${(mx-mn).toFixed(3)} contact ${(duty*100).toFixed(0)}%`);}
const a=F[0].links[0].pos,b=F[F.length-1].links[0].pos;
const along=(b[0]-a[0])*F[0].goal[0]+(b[2]-a[2])*F[0].goal[1];
console.log('path dx',(b[0]-a[0]).toFixed(2),'dz',(b[2]-a[2]).toFixed(2),'along-goal',along.toFixed(2),'goal',F[0].goal.map(x=>x.toFixed(2)).join(','));
