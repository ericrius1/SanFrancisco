export type PoseLandmark = {
  x: number;
  y: number;
  z: number;
  visibility: number;
};

export const LM = {
  LEFT_EAR: 7,
  RIGHT_EAR: 8,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  HIP_CENTER: 33,
  NECK: 34,
  HEAD_CENTER: 35
} as const;

export const LANDMARK_COUNT = 33;

const MIRROR_PAIRS = [
  [1, 4], [2, 5], [3, 6], [7, 8], [9, 10],
  [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22],
  [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]
] as const;

function midpoint(a: PoseLandmark, b: PoseLandmark): PoseLandmark {
  return {
    x: (a.x + b.x) * 0.5,
    y: (a.y + b.y) * 0.5,
    z: (a.z + b.z) * 0.5,
    visibility: Math.min(a.visibility, b.visibility)
  };
}

/** Mirror the webcam pose so motion feels like looking into a mirror. */
export function mirrorAndExtendLandmarks(input: PoseLandmark[]): PoseLandmark[] {
  const mirrored = input.slice(0, LANDMARK_COUNT).map((point) => ({ ...point, x: -point.x }));
  for (const [left, right] of MIRROR_PAIRS) {
    const swap = mirrored[left];
    mirrored[left] = mirrored[right];
    mirrored[right] = swap;
  }
  mirrored[LM.HIP_CENTER] = midpoint(mirrored[LM.LEFT_HIP], mirrored[LM.RIGHT_HIP]);
  mirrored[LM.NECK] = midpoint(mirrored[LM.LEFT_SHOULDER], mirrored[LM.RIGHT_SHOULDER]);
  mirrored[LM.HEAD_CENTER] = midpoint(mirrored[LM.LEFT_EAR], mirrored[LM.RIGHT_EAR]);
  return mirrored;
}
