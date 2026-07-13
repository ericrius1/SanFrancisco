export type Vec3 = { x: number; y: number; z: number };

export const VEC3_ZERO: Readonly<Vec3> = { x: 0, y: 0, z: 0 };
export const VEC3_UP: Readonly<Vec3> = { x: 0, y: 1, z: 0 };

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(value: Vec3, scalar: number): Vec3 {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

export function multiplyAdd(origin: Vec3, direction: Vec3, amount: number): Vec3 {
  return {
    x: origin.x + direction.x * amount,
    y: origin.y + direction.y * amount,
    z: origin.z + direction.z * amount
  };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x
  };
}

export function lengthSq(value: Vec3): number {
  return dot(value, value);
}

export function length(value: Vec3): number {
  return Math.sqrt(lengthSq(value));
}

export function normalize(value: Vec3, fallback: Vec3 = { x: 0, y: 1, z: 0 }): Vec3 {
  const magnitude = length(value);
  return magnitude > 1e-8 ? scale(value, 1 / magnitude) : { ...fallback };
}

export function lerp(a: Vec3, b: Vec3, amount: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * amount,
    y: a.y + (b.y - a.y) * amount,
    z: a.z + (b.z - a.z) * amount
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function degToRad(value: number): number {
  return value * (Math.PI / 180);
}

/** Rodrigues rotation. Axis is normalized internally. */
export function rotateAroundAxis(value: Vec3, axis: Vec3, angle: number): Vec3 {
  const unitAxis = normalize(axis, VEC3_UP);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const parallel = scale(unitAxis, dot(unitAxis, value) * (1 - cosine));
  const perpendicular = scale(cross(unitAxis, value), sine);
  return add(add(scale(value, cosine), perpendicular), parallel);
}

export type OrthonormalBasis = {
  tangent: Vec3;
  normal: Vec3;
  binormal: Vec3;
};

export function basisFromTangent(rawTangent: Vec3): OrthonormalBasis {
  const tangent = normalize(rawTangent);
  const reference = Math.abs(tangent.y) < 0.88 ? VEC3_UP : { x: 1, y: 0, z: 0 };
  const normal = normalize(cross(reference, tangent), { x: 1, y: 0, z: 0 });
  const binormal = normalize(cross(tangent, normal), { x: 0, y: 0, z: 1 });
  return { tangent, normal, binormal };
}

/**
 * Rotation-minimizing frames transported along a polyline. The initial frame
 * is arbitrary but stable; subsequent normals only rotate enough to follow the
 * changed tangent, avoiding the sudden tube twists produced by Frenet frames.
 */
export function buildRotationMinimizingFrames(points: readonly Vec3[]): OrthonormalBasis[] {
  if (points.length < 2) throw new Error("A branch centerline needs at least two points");

  const tangents = points.map((point, index) => {
    if (index === 0) return normalize(sub(points[1], point));
    if (index === points.length - 1) return normalize(sub(point, points[index - 1]));
    return normalize(sub(points[index + 1], points[index - 1]));
  });

  const first = basisFromTangent(tangents[0]);
  const frames: OrthonormalBasis[] = [first];
  let normal = first.normal;

  for (let index = 1; index < points.length; index++) {
    const previousTangent = tangents[index - 1];
    const tangent = tangents[index];
    const rotationAxis = cross(previousTangent, tangent);
    const sine = length(rotationAxis);
    if (sine > 1e-7) {
      const cosine = clamp(dot(previousTangent, tangent), -1, 1);
      normal = rotateAroundAxis(normal, scale(rotationAxis, 1 / sine), Math.atan2(sine, cosine));
    }

    // Remove accumulated floating-point drift from the transported normal.
    normal = normalize(sub(normal, scale(tangent, dot(normal, tangent))), basisFromTangent(tangent).normal);
    const binormal = normalize(cross(tangent, normal));
    frames.push({ tangent, normal, binormal });
  }

  return frames;
}

export function polylineLength(points: readonly Vec3[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index++) total += length(sub(points[index], points[index - 1]));
  return total;
}

export type PolylineSample = {
  position: Vec3;
  tangent: Vec3;
  segmentIndex: number;
  segmentT: number;
};

/** Samples by arc length, not point index, so authored segment counts do not affect placement. */
export function samplePolyline(points: readonly Vec3[], normalizedDistance: number): PolylineSample {
  const clamped = clamp(normalizedDistance, 0, 1);
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index++) {
    const segmentLength = length(sub(points[index], points[index - 1]));
    lengths.push(segmentLength);
    total += segmentLength;
  }
  if (total <= 1e-8) {
    return { position: { ...points[0] }, tangent: { ...VEC3_UP }, segmentIndex: 0, segmentT: 0 };
  }

  const target = clamped * total;
  let traversed = 0;
  for (let index = 0; index < lengths.length; index++) {
    const next = traversed + lengths[index];
    if (target <= next || index === lengths.length - 1) {
      const segmentT = lengths[index] > 1e-8 ? (target - traversed) / lengths[index] : 0;
      return {
        position: lerp(points[index], points[index + 1], segmentT),
        tangent: normalize(sub(points[index + 1], points[index])),
        segmentIndex: index,
        segmentT
      };
    }
    traversed = next;
  }

  const last = points.length - 1;
  return {
    position: { ...points[last] },
    tangent: normalize(sub(points[last], points[last - 1])),
    segmentIndex: last - 1,
    segmentT: 1
  };
}
