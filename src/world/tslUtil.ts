import { positionView, normalView, sin, cos, smoothstep, exp, fract, floor, min, mix, step, clamp, float } from "three/tsl";
import { OCEAN_BEACH_SURF } from "./oceanBeachWaves";

/**
 * Surface-gradient bump (Mikkelsen): perturbs the normal from screen-space
 * derivatives of a procedural world-space height field — the same trick the
 * three.js city generator uses for its road asphalt.
 * (TSL node generics don't compose across ops; any keeps the math readable.)
 */
export function bumpNormal(height: any, baseNormal: any = normalView): any {
  const dpdx = positionView.dFdx();
  const dpdy = positionView.dFdy();
  const r1 = dpdy.cross(baseNormal);
  const r2 = baseNormal.cross(dpdx);
  const det = dpdx.dot(r1);
  const grad = det.sign().mul(height.dFdx().mul(r1).add(height.dFdy().mul(r2)));
  return det.abs().mul(baseNormal).sub(grad).normalize();
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

/** Chop-zone mask, 0 calm … 1 full chop (GPU twin of chopZone()). Widened
 * (0.28/0.72) so livelier water shows up in more of the bay. */
export function chopZoneMask(x: any, z: any): any {
  return smoothstep(0.28, 0.72, sin(x.mul(0.0016).add(2.1)).mul(sin(z.mul(0.0013).sub(0.6))));
}

/** Zone chop waves at full strength — callers scale by chopZoneMask (and any rim
 * fade). Amplitudes bumped ~20% for a bit more punch on the crests. */
export function swellChop(x: any, z: any, t: any): any {
  return sin(x.mul(0.1).add(t.mul(1.35))).mul(0.36)
    .add(sin(z.mul(0.083).sub(t.mul(1.1))).mul(0.29))
    .add(sin(x.add(z).mul(0.052).add(t.mul(0.8))).mul(0.24));
}

/** GPU twin of oceanBeachBarrelEnvelope(). */
export function oceanBeachBarrelEnvelopeNode(z: any, t: any): any {
  const b = OCEAN_BEACH_SURF;
  const phase = cos(
    z.sub(b.entryZ)
      .mul((Math.PI * 2) / b.barrelPeriod)
      .sub(t.mul(b.barrelDrift))
  );
  return smoothstep(0.05, 0.6, phase);
}

/** GPU twin of oceanBeachTubeRoofFraction(); u is crown 0 … lip 1. */
export function oceanBeachTubeRoofFractionNode(u: any): any {
  const b = OCEAN_BEACH_SURF;
  const x = clamp(u, 0, 1).toVar();
  const v = float(1).sub(x).toVar();
  return v.mul(v).mul(v)
    .add(v.mul(v).mul(x).mul(3 * b.tubeRoofControl1))
    .add(v.mul(x).mul(x).mul(3 * b.tubeRoofControl2))
    .add(x.mul(x).mul(x).mul(b.tubeRoofEnd));
}

/**
 * GPU twin of oceanBeachBreakX(): the wandering line offshore of the waterline
 * where crests begin to throw. `shore` is the caller's already-computed
 * waterline fit, so this costs two sines on top of it.
 */
export function oceanBeachBreakXNode(shore: any, z: any, t: any): any {
  const b = OCEAN_BEACH_SURF;
  const bar = sin(z.mul(0.0034).sub(t.mul(0.006))).mul(0.46)
    .add(sin(z.mul(0.0098).add(1.7)).mul(0.28))
    .add(sin(z.mul(0.026).add(0.9)).mul(0.26));
  return shore.sub(b.breakOffset).sub(bar.mul(b.breakBarAmp));
}

/**
 * WebGPU twin of the analytic Ocean Beach wave field. Returns every channel the
 * surf visuals need from ONE evaluation so the green face mesh, the bay water
 * tint and (via oceanBeachSwell) the displaced height all read the same crest:
 *   height  — displacement (metres), matches CPU oceanBeachWaveHeight()
 *   face    — 0..1 steep translucent shoreward wall (drives the green glow)
 *   lip     — 0..1 breaking crest band (the white pitching lip)
 *   white   — 0..1 spent whitewater shoreward of the break
 *   mask    — 0 outside the strip, feathered inside
 *   breaking— 0 green wall … 1 thrown, for the crest this sample belongs to
 *   lean    — metres the peak has pitched shoreward of the crest line
 *   spent   — 0 thrown … 1 collapsed spent roller
 *   throwEnv— 0..1 envelope of the ~2 s throw window (spray burst rides it)
 * `x`/`z`/`t` are float nodes in world space / seconds. Mirrors
 * sampleOceanBeachWave() in oceanBeachWaves.ts — keep the two in step.
 */
export function oceanBeachSurfField(x: any, z: any, t: any) {
  const b = OCEAN_BEACH_SURF;
  // Twin of oceanBeachApproxShoreX(z) — keep coefficients in lockstep.
  const shore = float(-6323).add(z.mul(0.08504)).add(z.mul(z).mul(0.00000743));
  const shoreCap = shore; // CPU also min()'s with maxX; maxX is always shoreward of the fit.
  // Twin of oceanBeachOffshoreX(): a strip of a minimum WIDTH, not a straight
  // offshore line, so the curving north end gets a surf zone too.
  const offshore = min(float(b.minX), shore.sub(b.stripWidth)).toVar();
  const xMask = smoothstep(offshore, offshore.add(70), x)
    .mul(smoothstep(shoreCap.sub(70), shoreCap, x).oneMinus());
  const zMask = smoothstep(b.minZ, b.minZ + 180, z)
    .mul(smoothstep(b.maxZ - 180, b.maxZ, z).oneMinus());
  const mask = xMask.mul(zMask).toVar();
  const travel = fract(t.mul(b.speed / b.spacing)).mul(b.spacing);
  const peel = sin(z.mul(0.0052).add(t.mul(0.18))).mul(13)
    .add(sin(z.mul(0.0017).sub(t.mul(0.09))).mul(6));
  const q = x.sub(b.offshoreCrest).sub(travel).sub(peel).div(b.spacing);
  const slot = floor(q.add(0.5));
  const d = fract(q.add(0.5)).sub(0.5).mul(b.spacing).toVar(); // signed dist to crest: −offshore …+shoreward
  // --- crash silhouette (GPU twin of oceanBeachBreakShape + the shaped
  // profile in oceanBeachWaveHeight — see the parity tables there). `x.sub(d)`
  // is the crest's own X, so the whole wave answers together instead of each
  // pixel deciding for itself — which is what makes a wave break as one wall
  // rather than dissolving pixel by pixel.
  const over = x.sub(d).sub(oceanBeachBreakXNode(shore, z, t)).toVar();
  const breaking = smoothstep(0, b.breakThrow, over).toVar();
  // prox windows the whole deformation to the crest's neighbourhood (1 within
  // 30 m, 0 past 55 m) so crests in different break stages hand off at the
  // mid-trough (±75 m nearest-crest flip) without a step — see the CPU table.
  const prox = smoothstep(30, 55, d.abs()).oneMinus().toVar();
  // spentRaw is the crest-level stage; `spent` is that stage windowed to this
  // sample. peakShape/throwEnv retire on the RAW stage (the crest has gone
  // spent whether or not this sample sits near it), then window themselves.
  const spentRaw = smoothstep(b.breakThrow, b.breakThrow + b.spentRange, over).toVar();
  const spent = spentRaw.mul(prox).toVar();
  const throwEnv = breaking.mul(spentRaw.oneMinus()).mul(prox).toVar();
  const peakShape = smoothstep(-b.standRange, 0, over).mul(spentRaw.oneMinus()).mul(prox).toVar();
  const lean = peakShape.mul(b.standLean).add(throwEnv.mul(b.throwLean)).toVar();
  const ds = d.sub(lean).toVar();
  const frontW = float(b.faceWidth)
    .mul(peakShape.mul(b.faceTighten).oneMinus())
    .add(spent.mul(b.spentWiden));
  const width = mix(float(b.shoulderWidth), frontW, step(0, ds));
  const ridge = exp(ds.div(width).mul(ds.div(width)).mul(-0.5))
    .mul(peakShape.mul(b.standLift).add(1))
    .toVar();
  const lipLobeD = ds.sub(b.lipAhead).div(b.lipWidth);
  const lipLobe = exp(lipLobeD.mul(lipLobeD).mul(-0.5)).mul(throwEnv.mul(b.lipAmp));
  const collapse = spent.mul(b.collapseDrop).oneMinus();
  const troughD = d.sub(22).div(11);
  const trough = exp(troughD.mul(troughD).mul(-0.5)).mul(0.24);
  const setPulse = sin(t.mul(0.13).add(slot.mul(2.2))).mul(0.13).add(0.82);
  const sandbar = sin(z.mul(0.0041).add(t.mul(0.1))).mul(0.12).add(0.88);
  const amp = float(b.amplitude).mul(setPulse).mul(sandbar);
  const height = ridge.add(lipLobe).mul(collapse).sub(trough).mul(amp).mul(mask);
  // steep translucent wall: a band just shoreward of the crest where the face
  // stands up — riding the LEANED peak so the paint stays on the geometry
  const faceD = ds.sub(4.0).div(5.5);
  const face = mask.mul(exp(faceD.mul(faceD).mul(-0.5)));
  // pitching lip: tight bright band right at the (leaned) crest
  const lipD = ds.sub(1.0).div(2.6);
  const lip = mask.mul(exp(lipD.mul(lipD).mul(-0.5)));
  // spent whitewater: everything shoreward of the face, fading toward the sand
  const white = mask
    .mul(smoothstep(float(b.faceWidth).add(5), float(b.faceWidth).add(14), d))
    .mul(clamp(float(1).sub(d.sub(b.faceWidth).div(52)), 0, 1));
  const barrel = mask.mul(oceanBeachBarrelEnvelopeNode(z, t));
  return { height, face, lip, white, mask, crestD: d, amp, barrel, breaking, lean, spent, throwEnv };
}

/** WebGPU twin of oceanBeachWaveHeight(): periodic shoreward swell with a
 * broad offshore shoulder and a steep shoreward face. */
export function oceanBeachSwell(x: any, z: any, t: any): any {
  return oceanBeachSurfField(x, z, t).height;
}
