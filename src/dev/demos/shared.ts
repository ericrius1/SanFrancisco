// Reusable building blocks for cinematic demos (see ./buskersCinematic.ts).

import type { DemoContext } from "../demo";

/**
 * The window globals a cinematic demo installs so the render tool (and manual
 * frame capture) can drive it deterministically:
 *  - __sfReelArmed  : demo is wired and ready.
 *  - __sfReelDone   : the shot has reached its final frame.
 *  - __sfReelStep(s): (manual capture) jump virtual time to `s` seconds.
 *  - __cineT        : current virtual time in seconds.
 *  - __sfStartShot(): (realtime + ?hold) release the armed shot at __cineT = 0.
 */
export type CineWindow = Window &
  typeof globalThis & {
    __sfReelArmed?: boolean;
    __sfReelDone?: boolean;
    __sfReelStep?: (sec: number) => void;
    __cineT?: number;
    __sfStartShot?: () => void;
  };

/**
 * Clean capture plate: strip all HUD chrome and the loading veil so the frame
 * is pure gameplay footage — no captions, no branding. Injects a scoped style
 * (idempotent-ish; a repeat call just adds another identical <style>) and flips
 * the app into its started/reveal state.
 */
export function cleanPlate(hud?: DemoContext["hud"]) {
  const style = document.createElement("style");
  style.dataset.reelCapture = "true";
  style.textContent = `body.reel-capture #hud, body.reel-capture #loading { display:none !important; }`;
  document.head.appendChild(style);
  document.body.classList.add("started", "reel-capture");
  document.getElementById("loading")?.classList.add("done");
  hud?.setHidden(true);
  hud?.setFaded(true);
  hud?.message("");
}

/**
 * Freeze the local player and drop the avatar mesh far underground so it never
 * appears in a scripted shot, while keeping the tile streamer fed at the scene
 * XZ (tiles load off renderPosition XZ). We:
 *   - noop update/afterSteps so the body pose can't drive the mesh,
 *   - do one final syncMesh at the buried spot, then noop syncMesh so nothing
 *     moves the mesh back,
 *   - park + zero the physics body once.
 * Returns the buried world position; call `repin(buried, ctx)` every cine frame
 * to keep the (still-stepping) body from drifting or going NaN.
 */
export function freezeAndBuryPlayer(ctx: DemoContext, x: number, z: number) {
  const { player, map } = ctx;
  const groundY = map ? map.groundTop(x, z) : 0;
  const buriedY = groundY - 300;

  // Move to the buried spot, then take one last mesh sync there so the visible
  // avatar is underground before we pin syncMesh shut.
  player.position.set(x, buriedY, z);
  player.renderPosition.set(x, buriedY, z);
  player.velocity.set(0, 0, 0);
  player.syncMesh(0);

  // Silence the per-frame movement path so nothing walks the mesh back up.
  player.update = () => {};
  player.afterSteps = () => {};
  player.syncMesh = () => {};

  repin({ x, y: buriedY, z }, ctx);
  return { x, y: buriedY, z };
}

/** Re-pin the (still-stepping) player body to a fixed spot with zero velocity. */
export function repin(pos: { x: number; y: number; z: number }, ctx: DemoContext) {
  const { player, physics } = ctx;
  if (!player.body) return;
  const w = physics.world;
  w.setBodyTransform(player.body, [pos.x, pos.y, pos.z], [0, 0, 0, 1]);
  w.setBodyVelocity(player.body, [0, 0, 0], [0, 0, 0]);
  player.position.set(pos.x, pos.y, pos.z);
  player.renderPosition.set(pos.x, pos.y, pos.z);
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smoothstep = (x: number) => {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
};
export const mixf = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Monotone piecewise-cubic interpolator (Fritsch–Carlson). Given ascending
 * (t, v) keyframes, returns a C1 curve that never overshoots between knots —
 * ideal for a time-of-day ramp or a camera radius that must stay monotone. `t`
 * is clamped to the key range.
 */
export function monotoneCurve(keys: [number, number][]): (t: number) => number {
  const n = keys.length;
  if (n === 0) return () => 0;
  if (n === 1) return () => keys[0][1];

  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);

  // secant slopes
  const d: number[] = new Array(n - 1);
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);

  // initial tangents: endpoints = adjacent secant, interior = average
  const m: number[] = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2;

  // Fritsch–Carlson monotonicity fix-up
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const tau = 3 / Math.sqrt(s);
      m[i] = tau * a * d[i];
      m[i + 1] = tau * b * d[i];
    }
  }

  return (t: number) => {
    if (t <= xs[0]) return ys[0];
    if (t >= xs[n - 1]) return ys[n - 1];
    // find interval (linear scan — key counts are tiny)
    let i = 0;
    while (i < n - 1 && t > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const s = (t - xs[i]) / h;
    const s2 = s * s;
    const s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1;
    const h10 = s3 - 2 * s2 + s;
    const h01 = -2 * s3 + 3 * s2;
    const h11 = s3 - s2;
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1];
  };
}
