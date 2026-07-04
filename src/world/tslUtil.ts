import { positionView, normalView, sin, smoothstep } from "three/tsl";

/**
 * Surface-gradient bump (Mikkelsen): perturbs the normal from screen-space
 * derivatives of a procedural world-space height field — the same trick the
 * three.js city generator uses for its road asphalt.
 * (TSL node generics don't compose across ops; any keeps the math readable.)
 */
export function bumpNormal(height: any): any {
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(normalView);
  const r2 = normalView.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)));
  return det.abs().mul(normalView).sub(grad).normalize();
}

/**
 * GPU twins of the CPU water surface in heightmap.ts — base swell and the
 * chop-zone extra. Anything that must sit ON the water (the near water patch,
 * wake ribbons) builds its Y from these so visuals and physics never drift
 * apart. `x`/`z`/`t` are float nodes in world space / seconds.
 */
export function swellBase(x: any, z: any, t: any): any {
  return sin(x.mul(0.055).add(t.mul(0.9))).mul(0.09)
    .add(sin(z.mul(0.042).sub(t.mul(0.7))).mul(0.07))
    .add(sin(x.add(z).mul(0.021).add(t.mul(0.45))).mul(0.1));
}

/** Chop-zone mask, 0 calm … 1 full chop (GPU twin of chopZone()). */
export function chopZoneMask(x: any, z: any): any {
  return smoothstep(0.35, 0.75, sin(x.mul(0.0016).add(2.1)).mul(sin(z.mul(0.0013).sub(0.6))));
}

/** Zone chop waves at full strength — callers scale by chopZoneMask (and any rim fade). */
export function swellChop(x: any, z: any, t: any): any {
  return sin(x.mul(0.1).add(t.mul(1.35))).mul(0.3)
    .add(sin(z.mul(0.083).sub(t.mul(1.1))).mul(0.24))
    .add(sin(x.add(z).mul(0.052).add(t.mul(0.8))).mul(0.2));
}
