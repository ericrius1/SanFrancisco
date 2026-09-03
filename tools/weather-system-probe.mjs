import assert from "node:assert/strict";

const { forcedWeather, sampleProceduralWeather } = await import("../src/world/weatherModel.ts");

const storm = sampleProceduralWeather(
  { year: 2026, month: 12, day: 10, hour: 12, minute: 0, second: 0 },
  -6000,
  1000
);
assert(storm.rain > 0.8, `winter front should carry rain: ${JSON.stringify(storm)}`);
assert(storm.storm > 0.7, `winter front should carry a storm band: ${JSON.stringify(storm)}`);

const west = sampleProceduralWeather(
  { year: 2026, month: 9, day: 3, hour: 12, minute: 0, second: 0 },
  -6000,
  1000
);
const east = sampleProceduralWeather(
  { year: 2026, month: 9, day: 3, hour: 12, minute: 0, second: 0 },
  3000,
  1000
);
assert(west.rain > east.rain, "Pacific-facing neighborhoods should receive a soft local rain lift");

const a = sampleProceduralWeather(
  { year: 2026, month: 9, day: 3, hour: 12, minute: 0, second: 0 },
  -2000,
  1000
);
const b = sampleProceduralWeather(
  { year: 2026, month: 9, day: 3, hour: 12.01, minute: 0, second: 0 },
  -2000,
  1000
);
assert(Math.abs(a.rain - b.rain) < 0.02, "weather forecast must be continuous across nearby times");

const forced = forcedWeather("storm");
assert.equal(forced.kind, "storm");
assert(forced.rain > 0.8 && forced.storm > 0.8, "storm override must exercise rain and lightning systems");

console.log("[weather-system] ok", {
  winterStorm: { rain: +storm.rain.toFixed(3), storm: +storm.storm.toFixed(3) },
  septemberMicroclimate: { west: +west.rain.toFixed(3), east: +east.rain.toFixed(3) }
});
