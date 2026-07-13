const DEFAULT_LIMITS = Object.freeze({
  pixelThreshold: 4,
  maxStaticMae: 0.35,
  maxStaticChangedFraction: 0.003,
  maxPeriodScore: 0.62,
  minMotionMae: 0.02
});

function assertFrames(frames) {
  if (!Array.isArray(frames) || frames.length < 2) throw new Error("At least two RGBA frames are required");
  const bytes = frames[0].length;
  if (bytes === 0 || bytes % 4 !== 0) throw new Error("Frames must contain RGBA bytes");
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].length !== bytes) throw new Error("All frames must have the same dimensions");
  }
}

export function rgbaDifference(a, b, pixelThreshold = DEFAULT_LIMITS.pixelThreshold) {
  if (a.length !== b.length || a.length % 4 !== 0) throw new Error("RGBA buffers must have equal lengths");
  const histogram = new Uint32Array(256);
  const pixels = a.length / 4;
  let absolute = 0;
  let squared = 0;
  let changed = 0;
  let max = 0;

  for (let i = 0; i < a.length; i += 4) {
    const delta = (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2])) / 3;
    absolute += delta;
    squared += delta * delta;
    if (delta > pixelThreshold) changed++;
    if (delta > max) max = delta;
    histogram[Math.min(255, Math.round(delta))]++;
  }

  const p95Target = Math.ceil(pixels * 0.95);
  let accumulated = 0;
  let p95 = 0;
  for (; p95 < histogram.length; p95++) {
    accumulated += histogram[p95];
    if (accumulated >= p95Target) break;
  }

  return {
    mae: absolute / pixels,
    rms: Math.sqrt(squared / pixels),
    max,
    p95,
    changedPixels: changed,
    changedFraction: changed / pixels
  };
}

function mean(values) {
  if (values.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < values.length; i++) total += values[i];
  return total / values.length;
}

function max(values) {
  let value = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > value) value = values[i];
  return value;
}

function lagDifferences(frames, lag, pixelThreshold) {
  const differences = [];
  for (let i = lag; i < frames.length; i++) differences.push(rgbaDifference(frames[i - lag], frames[i], pixelThreshold));
  return differences;
}

/**
 * Measures how strongly frame-to-frame change energy is concentrated in one
 * phase of a cadence. Constant-velocity motion produces near-equal buckets;
 * a held shadow map refreshed every N frames produces one hot bucket.
 */
function phaseConcentration(energies, period) {
  if (energies.length < period * 2) return 0;
  const sums = new Float64Array(period);
  const counts = new Uint32Array(period);
  for (let i = 0; i < energies.length; i++) {
    const phase = i % period;
    sums[phase] += energies[i];
    counts[phase]++;
  }
  let high = 0;
  let low = Number.POSITIVE_INFINITY;
  for (let i = 0; i < period; i++) {
    const bucket = counts[i] === 0 ? 0 : sums[i] / counts[i];
    if (bucket > high) high = bucket;
    if (bucket < low) low = bucket;
  }
  if (high <= 1e-9) return 0;
  return (high - low) / high;
}

function recurrenceScore(periodLag, competingLags) {
  if (periodLag <= 1e-9 && competingLags.some((value) => value > 1e-9)) return 1;
  let baseline = Number.POSITIVE_INFINITY;
  for (let i = 0; i < competingLags.length; i++) {
    const value = competingLags[i];
    if (value > 1e-9 && value < baseline) baseline = value;
  }
  if (!Number.isFinite(baseline)) return 0;
  return Math.max(0, Math.min(1, 1 - periodLag / baseline));
}

/**
 * Analyze a deterministic ROI sequence. The returned period scores are 0 for
 * smooth/constant update energy and approach 1 for every-2/every-4 impulses.
 */
export function analyzeFrameSequence(frames, pixelThreshold = DEFAULT_LIMITS.pixelThreshold) {
  assertFrames(frames);
  const adjacent = lagDifferences(frames, 1, pixelThreshold);
  const lag2 = frames.length > 2 ? lagDifferences(frames, 2, pixelThreshold) : [];
  const lag3 = frames.length > 3 ? lagDifferences(frames, 3, pixelThreshold) : [];
  const lag4 = frames.length > 4 ? lagDifferences(frames, 4, pixelThreshold) : [];
  const energies = adjacent.map((entry) => entry.mae);
  const adjacentMeanMae = mean(energies);
  const lag2MeanMae = mean(lag2.map((entry) => entry.mae));
  const lag3MeanMae = mean(lag3.map((entry) => entry.mae));
  const lag4MeanMae = mean(lag4.map((entry) => entry.mae));
  return {
    frameCount: frames.length,
    adjacent,
    adjacentMeanMae,
    adjacentMaxMae: max(energies),
    adjacentMaxChangedFraction: max(adjacent.map((entry) => entry.changedFraction)),
    lag2MeanMae,
    lag3MeanMae,
    lag4MeanMae,
    period2Score: Math.max(phaseConcentration(energies, 2), recurrenceScore(lag2MeanMae, [adjacentMeanMae])),
    period4Score: Math.max(
      phaseConcentration(energies, 4),
      recurrenceScore(lag4MeanMae, [adjacentMeanMae, lag2MeanMae, lag3MeanMae])
    )
  };
}

export function evaluateShadowTemporalProbe({ staticFrames, motionFrames, limits = {} }) {
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const staticResult = analyzeFrameSequence(staticFrames, resolved.pixelThreshold);
  const motionResult = analyzeFrameSequence(motionFrames, resolved.pixelThreshold);
  const failures = [];

  if (staticResult.adjacentMaxMae > resolved.maxStaticMae) {
    failures.push(`static ROI MAE ${staticResult.adjacentMaxMae.toFixed(4)} > ${resolved.maxStaticMae}`);
  }
  if (staticResult.adjacentMaxChangedFraction > resolved.maxStaticChangedFraction) {
    failures.push(
      `static ROI changed fraction ${(staticResult.adjacentMaxChangedFraction * 100).toFixed(3)}% > ${(resolved.maxStaticChangedFraction * 100).toFixed(3)}%`
    );
  }
  if (motionResult.adjacentMeanMae >= resolved.minMotionMae) {
    if (motionResult.period2Score > resolved.maxPeriodScore) {
      failures.push(`period-2 cadence score ${motionResult.period2Score.toFixed(3)} > ${resolved.maxPeriodScore}`);
    }
    if (motionResult.period4Score > resolved.maxPeriodScore) {
      failures.push(`period-4 cadence score ${motionResult.period4Score.toFixed(3)} > ${resolved.maxPeriodScore}`);
    }
  }

  return {
    pass: failures.length === 0,
    limits: resolved,
    static: staticResult,
    motion: motionResult,
    failures
  };
}
