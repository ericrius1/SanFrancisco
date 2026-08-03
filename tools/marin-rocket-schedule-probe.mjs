// Deterministic pacing/audio contract for Marin's compressed solar tour.
// Usage: node tools/marin-rocket-schedule-probe.mjs

import { build } from "esbuild";

async function importBundled(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    logLevel: "silent"
  });
  const source = result.outputFiles[0].text;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const [routeModule, profileModule, audioModule] = await Promise.all([
  importBundled("src/gameplay/marinRocket/route.ts"),
  importBundled("src/vehicles/plane/rocketFlight.ts"),
  importBundled("src/gameplay/marinRocket/audio.ts")
]);

const profile = profileModule.MARIN_ROCKET_FLIGHT;
const targets = routeModule.CELESTIAL_TARGETS;
const arrivals = [];
const step = 1 / 60;
let elapsed = 0;
let distance = 0;
let speed = profile.launchSpeed;
let throttle = 0.58;
let targetIndex = 0;

while (elapsed < 55 && targetIndex < targets.length) {
  throttle = Math.min(1, throttle + profile.throttleRate * step);
  const altitude = distance * Math.sin(profile.launchPitch);
  const limit = profile.speedLimit(altitude);
  const targetSpeed = Math.max(
    profile.minimumSpeed,
    limit * (0.28 + throttle * 0.72) * profile.boostSpeedMultiplier
  );
  speed += (targetSpeed - speed) * (1 - Math.exp(-profile.boostResponse * step));
  distance += speed * step;
  elapsed += step;

  const target = targets[targetIndex];
  const encounterDistance = Math.abs(target.routeDistance - distance);
  if (encounterDistance <= target.encounterRadius) {
    arrivals.push({
      id: target.id,
      planned: target.plannedSeconds,
      actual: Number(elapsed.toFixed(2)),
      error: Number((elapsed - target.plannedSeconds).toFixed(2))
    });
    targetIndex++;
  }
}

const audioTargets = audioModule.rocketAudioTargets({
  active: true,
  altitude: 52_000,
  verticalSpeed: 4_000,
  speed: 5_200,
  throttle: 1,
  boost: true,
  spaceFactor: 1,
  orbitFactor: 1,
  stage: "deep-space"
});

const boostPass = profile.boostSpeedMultiplier === 15 &&
  arrivals[0]?.id === "moon" && arrivals[0]?.actual <= 10;
const timingPass = boostPass && arrivals.length === targets.length &&
  arrivals.every((arrival) => Math.abs(arrival.error) <= 0.12);
const audioPass =
  audioTargets.lowFrequency <= 42 &&
  audioTargets.bodyFrequency <= 75 &&
  audioTargets.filterFrequency <= 500 &&
  audioTargets.noiseGain <= 0.003;

console.log(JSON.stringify({ boostPass, timingPass, audioPass, boostSpeedMultiplier: profile.boostSpeedMultiplier, arrivals, audioTargets }, null, 2));
if (!timingPass || !audioPass) process.exitCode = 1;
