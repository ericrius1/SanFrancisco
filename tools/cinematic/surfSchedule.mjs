/**
 * Crash-schedule solver for the pinned-sea-clock films.
 *
 * The sunset films pin the world's sea clock to `T0 + shotTime` (see
 * `setSeaTimePin` in src/dev/demo.ts), which makes the analytic wave train
 * phase-deterministic per production. This tool searches T0 so that crests
 * cross the break line at chosen shot seconds in the framed stretch of beach,
 * and emits the full crash/swash event list a picture-locked soundtrack can
 * hard-author against.
 *
 * The math here is a PORT of the timing subset of src/world/oceanBeachWaves.ts
 * (crest train, bar field, break line, set pulse). It must stay in step with
 * that file; if the model's constants change, change them here too. Geometry
 * shaping terms (faces, tubes, foam) are irrelevant to timing and not ported.
 * Every candidate schedule is still verified against probe stills before a
 * master renders, so a drift here fails loudly at the contact sheet, not in a
 * published film.
 */

const SURF = {
  spacing: 150,
  speed: 9.2,
  amplitude: 7.2,
  offshoreCrest: -6310,
  breakOffset: 118,
  breakBarAmp: 52,
  breakThrow: 18
};

const TAU = Math.PI * 2;

export function shoreX(z) {
  return -6323 + 0.08504 * z + 0.00000743 * z * z;
}

function crestBase(time) {
  const travel = ((time * SURF.speed) % SURF.spacing + SURF.spacing) % SURF.spacing;
  return SURF.offshoreCrest + travel;
}

function crestX(slot, z, time) {
  const peel = Math.sin(z * 0.0052 + time * 0.18) * 13;
  const shoulder = Math.sin(z * 0.0017 - time * 0.09) * 6;
  return crestBase(time) + slot * SURF.spacing + peel + shoulder;
}

function breakBarField(z, time) {
  return (
    Math.sin(z * 0.0034 - time * 0.006) * 0.46 +
    Math.sin(z * 0.0098 + 1.7) * 0.28 +
    Math.sin(z * 0.026 + 0.9) * 0.26
  );
}

export function breakX(z, time) {
  return shoreX(z) - SURF.breakOffset - breakBarField(z, time) * SURF.breakBarAmp;
}

function waveAmplitude(z, time, slot) {
  const setPulse = 0.82 + Math.sin(time * 0.13 + slot * 2.2) * 0.13;
  const sandbar = 0.88 + Math.sin(z * 0.0041 + time * 0.1) * 0.12;
  return SURF.amplitude * setPulse * sandbar;
}

/**
 * All crest→break crossings inside [t0, t1] (absolute sea time) for one z.
 * A crossing is when a crest's X rises past the local break line; the visible
 * "throw" runs ~2 s from that instant (breakThrow / speed).
 */
export function crossingsAt(z, t0, t1, stepSeconds = 0.02) {
  const events = [];
  // Track the nearest few slots: at 9.2 m/s a 20 s window is ~2 slots wide.
  const slotAt = (time) => Math.round((breakX(z, time) - crestBase(time)) / SURF.spacing);
  const gap = (slot, time) => crestX(slot, z, time) - breakX(z, time);
  const center = slotAt(t0);
  for (let slot = center - 2; slot <= center + 2; slot++) {
    let prev = gap(slot, t0);
    for (let t = t0 + stepSeconds; t <= t1 + 1e-9; t += stepSeconds) {
      const g = gap(slot, t);
      if (prev < 0 && g >= 0) {
        // Refine by bisection to ~1 ms.
        let lo = t - stepSeconds;
        let hi = t;
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2;
          if (gap(slot, mid) < 0) lo = mid; else hi = mid;
        }
        const at = (lo + hi) / 2;
        events.push({
          time: at,
          z,
          slot,
          amplitude: waveAmplitude(z, at, slot),
          breakX: breakX(z, at)
        });
      }
      prev = g;
    }
  }
  events.sort((a, b) => a.time - b.time);
  return events;
}

/**
 * Full event list for a shot window across a stretch of beach: crossings at
 * `sections` (z values), throw peak ~1 s after crossing, swash arrival at the
 * sand ~(breakOffset/speed) later.
 */
export function scheduleFor(T0, seconds, sections) {
  const all = [];
  for (const z of sections) {
    for (const event of crossingsAt(z, T0, T0 + seconds)) {
      all.push({
        shotTime: event.time - T0,
        throwPeak: event.time - T0 + 1.0,
        swashAt: event.time - T0 + SURF.breakOffset / SURF.speed,
        z: event.z,
        amplitude: event.amplitude,
        breakX: event.breakX
      });
    }
  }
  all.sort((a, b) => a.shotTime - b.shotTime);
  return all;
}

/**
 * Search T0 so that the LARGEST crossings land near the wanted shot seconds at
 * the wanted section. `targets` = [{z, at, weight?}]; earlier targets matter
 * more by default. Returns the best few candidates with their schedules.
 */
export function solveT0({ targets, seconds = 20, sections, scanSeconds = 900, step = 0.05 }) {
  const ranked = [];
  for (let T0 = 0; T0 <= scanSeconds; T0 += step) {
    let score = 0;
    for (const target of targets) {
      const events = crossingsAt(target.z, T0 + target.at - 2.5, T0 + target.at + 2.5);
      let best = 0;
      for (const event of events) {
        const dt = Math.abs(event.time - T0 - target.at);
        // Sharp on timing (within ~0.8 s), linear on size (big sets win).
        const timing = Math.max(0, 1 - dt / 0.8);
        const size = (event.amplitude / SURF.amplitude - 0.62) / 0.33;
        best = Math.max(best, timing * (0.35 + 0.65 * size) * (target.weight ?? 1));
      }
      score += best;
    }
    ranked.push({ T0: Math.round(T0 * 100) / 100, score });
  }
  ranked.sort((a, b) => b.score - a.score);
  // De-duplicate near-identical T0s (within 4 s) keeping the best of each well.
  const picks = [];
  for (const candidate of ranked) {
    if (picks.every((p) => Math.abs(p.T0 - candidate.T0) > 4)) picks.push(candidate);
    if (picks.length >= 5) break;
  }
  return picks.map((pick) => ({
    ...pick,
    schedule: scheduleFor(pick.T0, seconds, sections ?? targets.map((t) => t.z))
  }));
}

// CLI: node tools/cinematic/surfSchedule.mjs '<json>' where json is the
// solveT0 options object. Prints candidates with their full schedules.
if (import.meta.url === `file://${process.argv[1]}`) {
  const options = JSON.parse(process.argv[2] ?? "{}");
  if (!options.targets) {
    console.error("usage: node tools/cinematic/surfSchedule.mjs '{\"targets\":[{\"z\":1650,\"at\":6}],\"sections\":[1600,1650,1700]}'");
    process.exit(1);
  }
  for (const candidate of solveT0(options)) {
    console.log(`\nT0=${candidate.T0}  score=${candidate.score.toFixed(3)}`);
    for (const event of candidate.schedule) {
      console.log(
        `  break t=${event.shotTime.toFixed(2)}s  throw~${event.throwPeak.toFixed(2)}s  ` +
        `swash~${event.swashAt.toFixed(2)}s  z=${event.z}  amp=${event.amplitude.toFixed(2)}m`
      );
    }
  }
}
