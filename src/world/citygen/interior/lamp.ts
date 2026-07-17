// Procedural residential pendant inspired by layered brass ribbon chandeliers.
//
// The fixture is plain CityGen panel geometry: no textures, asset requests, or
// THREE objects. It is created only with an already-lazy interior, varies from
// the building's deterministic furniture RNG, and merges into a handful of the
// interior's existing material buckets.
import { PanelBuilder, type Vec3 } from "../core/facade";
import type { Rng } from "../core/rng";
import { PROCEDURAL_LAMP_TUNING } from "./lampTuning";

export { PROCEDURAL_LAMP_TUNING } from "./lampTuning";

type BandSpec = {
  center: Vec3;
  u: Vec3;
  v: Vec3;
  normal: Vec3;
  radiusU: number;
  radiusV: number;
  width: number;
  thickness: number;
};

export type ProceduralLampOptions = {
  x: number;
  z: number;
  ceilingY: number;
  roomWidth: number;
  roomDepth: number;
  rng: Rng;
};

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length > 1e-8 ? mul(a, 1 / length) : [1, 0, 0];
};

function materialIds(): { metal: string; cable: string; glow: string } {
  const finish = PROCEDURAL_LAMP_TUNING.values.finish;
  const tone = PROCEDURAL_LAMP_TUNING.values.lightTone;
  return {
    metal: finish === "aged"
      ? "int.lamp.brass.aged"
      : finish === "champagne"
        ? "int.lamp.brass.champagne"
        : "int.lamp.brass",
    cable: "int.lamp.cable",
    glow: tone === "amber"
      ? "int.lamp.glow.amber"
      : tone === "pearl"
        ? "int.lamp.glow.pearl"
        : "int.lamp.glow",
  };
}

/** A stable orthonormal basis for a ring plane whose normal remains near +Y. */
function planeBasis(normal: Vec3, yaw: number): { u: Vec3; v: Vec3 } {
  const seed = Math.abs(normal[1]) < 0.92 ? ([0, 1, 0] as Vec3) : ([0, 0, 1] as Vec3);
  const u0 = unit(cross(seed, normal));
  const v0 = unit(cross(normal, u0));
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return {
    u: unit(add(mul(u0, c), mul(v0, s))),
    v: unit(add(mul(v0, c), mul(u0, -s))),
  };
}

function bandPoint(band: BandSpec, angle: number): Vec3 {
  return add(
    band.center,
    add(mul(band.u, Math.cos(angle) * band.radiusU), mul(band.v, Math.sin(angle) * band.radiusV)),
  );
}

/** Unit outward direction in an ellipse's plane (the gradient of its equation). */
function bandRadial(band: BandSpec, angle: number): Vec3 {
  return unit(add(
    mul(band.u, Math.cos(angle) / Math.max(0.01, band.radiusU)),
    mul(band.v, Math.sin(angle) / Math.max(0.01, band.radiusV)),
  ));
}

/** Closed rectangular-section ribbon following an arbitrary tilted ellipse. */
function emitBand(out: PanelBuilder, material: string, band: BandSpec, segments: number): void {
  const halfW = band.width / 2;
  const halfT = band.thickness / 2;
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    const p0 = bandPoint(band, a0), p1 = bandPoint(band, a1);
    const r0 = bandRadial(band, a0), r1 = bandRadial(band, a1);
    const n = band.normal;
    const outerN = unit(add(r0, r1));

    const o0b = add(add(p0, mul(r0, halfT)), mul(n, -halfW));
    const o1b = add(add(p1, mul(r1, halfT)), mul(n, -halfW));
    const o1t = add(add(p1, mul(r1, halfT)), mul(n, halfW));
    const o0t = add(add(p0, mul(r0, halfT)), mul(n, halfW));
    const i0b = add(add(p0, mul(r0, -halfT)), mul(n, -halfW));
    const i1b = add(add(p1, mul(r1, -halfT)), mul(n, -halfW));
    const i1t = add(add(p1, mul(r1, -halfT)), mul(n, halfW));
    const i0t = add(add(p0, mul(r0, -halfT)), mul(n, halfW));

    out.quad(material, o0b, o1b, o1t, o0t, outerN);
    out.quad(material, i1b, i0b, i0t, i1t, mul(outerN, -1));
    out.quad(material, o0t, o1t, i1t, i0t, n);
    out.quad(material, i0b, i1b, o1b, o0b, mul(n, -1));
  }
}

/** A slim oriented rectangular rod, used for cables and segmented curved ribs. */
function emitRod(out: PanelBuilder, material: string, a: Vec3, b: Vec3, radius: number): void {
  const delta = sub(b, a);
  const length = Math.hypot(delta[0], delta[1], delta[2]);
  if (length < 1e-5) return;
  const along = mul(delta, 1 / length);
  const reference: Vec3 = Math.abs(dot(along, [0, 1, 0])) > 0.94 ? [1, 0, 0] : [0, 1, 0];
  const normal = unit(cross(along, reference));
  const up = unit(cross(normal, along));
  out.box(material, mul(add(a, b), 0.5), [length / 2, radius, radius], along, up, normal, false);
}

function quadratic(a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 {
  const mt = 1 - t;
  return add(add(mul(a, mt * mt), mul(c, 2 * mt * t)), mul(b, t * t));
}

/**
 * Emit one unique layered-ribbon pendant. Returns false only when the room is too
 * narrow for a readable fixture, allowing the caller to fall back to a pendant.
 */
export function emitProceduralLamp(out: PanelBuilder, options: ProceduralLampOptions): boolean {
  const tuning = PROCEDURAL_LAMP_TUNING.values;
  const roomLimit = Math.min(options.roomWidth, options.roomDepth) * 0.235;
  const radius = Math.min(tuning.radius, roomLimit);
  if (radius < 0.34) return false;

  const r = options.rng;
  const variety = tuning.variation;
  const count = Math.max(2, Math.round(tuning.rings));
  const depth = Math.min(tuning.depth, 1.72);
  const topY = options.ceilingY - tuning.ceilingDrop;
  const centerY = topY - depth * 0.5;
  const fixtureCenter: Vec3 = [options.x, centerY, options.z];
  const { metal, cable, glow } = materialIds();
  const bands: BandSpec[] = [];
  const maxTilt = tuning.maxTilt * Math.PI / 180;

  for (let i = 0; i < count; i++) {
    const u = count === 1 ? 0.5 : i / (count - 1);
    const axisAngle = r() * Math.PI * 2;
    const tilt = (r() * 2 - 1) * maxTilt * (0.42 + variety * 0.58);
    const normal: Vec3 = unit([
      -Math.sin(axisAngle) * Math.sin(tilt),
      Math.cos(tilt),
      Math.cos(axisAngle) * Math.sin(tilt),
    ]);
    const basis = planeBasis(normal, r() * Math.PI * 2);
    const taper = 0.98 - u * 0.21;
    const sizeJitter = 1 + (r() * 2 - 1) * 0.17 * variety;
    const major = radius * taper * sizeJitter;
    const eccentricity = 0.76 + r() * 0.21;
    const verticalJitter = (r() * 2 - 1) * depth * 0.07 * variety;
    const horizontalJitter = radius * 0.055 * variety;
    bands.push({
      center: [
        options.x + (r() * 2 - 1) * horizontalJitter,
        topY - u * depth + verticalJitter,
        options.z + (r() * 2 - 1) * horizontalJitter,
      ],
      u: basis.u,
      v: basis.v,
      normal,
      radiusU: major,
      radiusV: major * eccentricity,
      width: tuning.ribbonWidth,
      thickness: tuning.ribbonThickness,
    });
  }

  // Twenty-four facets keep the silhouette round at arm's length while each
  // lazily active home remains a modest geometry budget.
  for (const band of bands) emitBand(out, metal, band, 24);

  // A small ceiling canopy and a pair of hub rings echo the reference fixture's
  // mirrored cap and nested central mechanism.
  const horizontal: BandSpec = {
    center: [options.x, options.ceilingY - 0.025, options.z],
    u: [1, 0, 0], v: [0, 0, 1], normal: [0, 1, 0],
    radiusU: 0.145, radiusV: 0.145,
    width: 0.055, thickness: 0.028,
  };
  emitBand(out, metal, horizontal, 18);
  for (const yOffset of [-0.055, 0.055]) {
    emitBand(out, metal, {
      ...horizontal,
      center: [options.x, centerY + yOffset, options.z],
      radiusU: 0.14,
      radiusV: 0.14,
      width: 0.05,
      thickness: 0.022,
    }, 16);
  }

  // One central drop plus several taut perimeter cables hold the upper ribbon.
  emitRod(out, cable, [options.x, options.ceilingY - 0.04, options.z], [options.x, centerY + 0.08, options.z], 0.009);
  const upperBand = bands.reduce((best, band) => band.center[1] > best.center[1] ? band : best, bands[0]);
  const cableCount = Math.max(1, Math.round(tuning.cables));
  const cablePhase = r() * Math.PI * 2;
  for (let i = 0; i < cableCount; i++) {
    const angle = cablePhase + i / cableCount * Math.PI * 2;
    const start: Vec3 = [
      options.x + Math.cos(angle) * 0.095,
      options.ceilingY - 0.045,
      options.z + Math.sin(angle) * 0.095,
    ];
    emitRod(out, cable, start, bandPoint(upperBand, angle), 0.0065);
  }

  // Fine bowed ribs flare from the luminous core into a mid-cage ring. Their
  // segmented quadratic path is deliberately slimmer than the main ribbons.
  const ribBand = bands[Math.min(bands.length - 1, Math.max(0, Math.floor(bands.length * 0.56)))];
  const ribCount = Math.max(0, Math.round(tuning.ribs));
  const ribPhase = r() * Math.PI * 2;
  for (let i = 0; i < ribCount; i++) {
    const angle = ribPhase + i / Math.max(1, ribCount) * Math.PI * 2;
    const radial: Vec3 = [Math.cos(angle), 0, Math.sin(angle)];
    const start = add(fixtureCenter, mul(radial, 0.12));
    const end = bandPoint(ribBand, angle);
    const control = add(
      add(mul(add(start, end), 0.5), mul(radial, radius * (0.14 + 0.14 * variety))),
      [0, depth * (0.08 + (i % 2) * 0.04), 0],
    );
    let previous = start;
    for (let segment = 1; segment <= 5; segment++) {
      const next = quadratic(start, control, end, segment / 5);
      emitRod(out, metal, previous, next, Math.max(0.008, tuning.ribbonThickness * 0.48));
      previous = next;
    }
  }

  // Faceted central light engine + four small lamps. Emissive materials carry
  // the room's glow without adding per-home THREE lights to the global budget.
  const glowScale = tuning.glowSize;
  const glowHalf = 0.095 * glowScale;
  out.box(glow, fixtureCenter, [glowHalf, glowHalf * 0.82, glowHalf], [1, 0, 0], [0, 1, 0], [0, 0, 1], false);
  const rotated = Math.SQRT1_2;
  out.box(glow, fixtureCenter, [glowHalf * 0.84, glowHalf * 0.72, glowHalf * 0.84], [rotated, 0, rotated], [0, 1, 0], [-rotated, 0, rotated], false);
  for (let i = 0; i < 4; i++) {
    const angle = ribPhase + i * Math.PI / 2;
    const px = options.x + Math.cos(angle) * 0.235;
    const pz = options.z + Math.sin(angle) * 0.235;
    emitRod(out, metal, fixtureCenter, [px, centerY + 0.015, pz], 0.011);
    const s = 0.047 * glowScale;
    out.box(glow, [px, centerY + 0.02, pz], [s, s * 1.25, s], [1, 0, 0], [0, 1, 0], [0, 0, 1], false);
  }

  return true;
}
