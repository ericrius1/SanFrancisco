import * as THREE from "three/webgpu";

export const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export const smoothstep = (value: number) => {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
};

export const smootherstep = (value: number) => {
  const t = clamp01(value);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

export const easeInOutCubic = (value: number) => {
  const t = clamp01(value);
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

export const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** A retained Catmull-Rom rail. `sample()` writes into the caller's vector. */
export function vectorRail(points: readonly (readonly [number, number, number])[], tension = 0.45) {
  if (points.length < 2) throw new Error("A cinematic rail needs at least two points");
  const curve = new THREE.CatmullRomCurve3(
    points.map(([x, y, z]) => new THREE.Vector3(x, y, z)),
    false,
    "catmullrom",
    tension
  );
  return (progress: number, out: THREE.Vector3) => curve.getPoint(clamp01(progress), out);
}

/** Piecewise eased scalar track. Key times must be ascending. */
export function scalarTrack(keys: readonly (readonly [number, number])[]) {
  if (keys.length === 0) return () => 0;
  if (keys.length === 1) return () => keys[0][1];
  return (time: number) => {
    if (time <= keys[0][0]) return keys[0][1];
    const last = keys[keys.length - 1];
    if (time >= last[0]) return last[1];
    for (let i = 0; i < keys.length - 1; i++) {
      const a = keys[i];
      const b = keys[i + 1];
      if (time > b[0]) continue;
      const u = smoothstep((time - a[0]) / Math.max(1e-6, b[0] - a[0]));
      return mix(a[1], b[1], u);
    }
    return last[1];
  };
}

/** Small deterministic camera breath. It returns to zero at both shot ends. */
export function cinematicBreath(time: number, progress: number, seed = 0) {
  const envelope = Math.sin(clamp01(progress) * Math.PI) ** 2;
  return new THREE.Vector3(
    Math.sin(time * 0.71 + seed * 1.17) * 0.018,
    Math.sin(time * 0.93 + seed * 2.31) * 0.012,
    Math.sin(time * 0.57 + seed * 0.73) * 0.014
  ).multiplyScalar(envelope);
}
