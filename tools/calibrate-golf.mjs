// Calibrate golf club launch speeds so full-power flat-ground carry lands on
// each club's advertised distance, using the exact flight integrator from
// src/gameplay/golf/ball.ts (quadratic drag, 120 Hz substeps).
// Usage: node tools/calibrate-golf.mjs  → paste the table into CLUBS.

const GRAVITY = 9.81;
const DRAG = 0.0016;
const H = 1 / 120;

function carry(speed, loft) {
  let x = 0;
  let y = 0.02;
  let vx = Math.cos(loft) * speed;
  let vy = Math.sin(loft) * speed;
  for (let i = 0; i < 60 / H; i++) {
    const s = Math.hypot(vx, vy);
    const k = 1 - Math.min(0.9, DRAG * s * H);
    vx *= k;
    vy *= k;
    vy -= GRAVITY * H;
    x += vx * H;
    y += vy * H;
    if (y <= 0) return x;
  }
  return x;
}

const clubs = [
  ["driver", 0.24, 230],
  ["wood3", 0.28, 200],
  ["iron3", 0.34, 175],
  ["iron5", 0.42, 155],
  ["iron7", 0.56, 130],
  ["iron9", 0.7, 105],
  ["wedge", 0.91, 75],
  ["sand", 1.01, 55]
];

for (const [id, loft, target] of clubs) {
  let lo = 5;
  let hi = 120;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (carry(mid, loft) < target) lo = mid;
    else hi = mid;
  }
  const v = (lo + hi) / 2;
  console.log(`${id}: speed ${v.toFixed(1)} → carry ${carry(v, loft).toFixed(1)} m (target ${target})`);
}
