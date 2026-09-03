import assert from "node:assert/strict";

const { forcedWeather, sampleProceduralWeather } = await import("../src/world/weatherModel.ts");

let clearSamples = 0;
let wetSamples = 0;
let stormSamples = 0;
let rainyCloud = 0;
let clearCloud = 0;
let rainyCloudSamples = 0;
let clearCloudSamples = 0;
let microclimateFront = null;
const sampleCount = 365 * 24 * 2;
for (let day = 1; day <= 365; day++) {
  const date = new Date(Date.UTC(2026, 0, day));
  for (let halfHour = 0; halfHour < 48; halfHour++) {
    const civil = {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
      hour: halfHour / 2
    };
    const weather = sampleProceduralWeather(civil, 0, 0);
    if (weather.kind === "clear") clearSamples++;
    if (weather.rain > 0.12) {
      wetSamples++;
      rainyCloud += weather.cloud;
      rainyCloudSamples++;
      if (!microclimateFront) microclimateFront = civil;
    } else {
      clearCloud += weather.cloud;
      clearCloudSamples++;
    }
    if (weather.storm > 0.38) stormSamples++;
  }
}
const clearShare = clearSamples / sampleCount;
const wetShare = wetSamples / sampleCount;
const stormShare = stormSamples / sampleCount;
assert(clearShare > 0.62, `clear weather should dominate the year: ${clearShare}`);
assert(wetShare > 0.04 && wetShare < 0.2, `rain should be occasional: ${wetShare}`);
assert(stormShare > 0 && stormShare < wetShare * 0.3, `electrical storms should be rare: ${stormShare}`);
assert(
  rainyCloud / rainyCloudSamples > clearCloud / clearCloudSamples + 0.28,
  "wet fronts should carry substantially more cloud cover than dry weather"
);
assert(microclimateFront, "annual schedule should contain at least one wet front");

const west = sampleProceduralWeather(microclimateFront, -6000, 1000);
const east = sampleProceduralWeather(microclimateFront, 3000, 1000);
assert(west.rain > east.rain, "Pacific-facing neighborhoods should receive a soft local rain lift");

const a = sampleProceduralWeather(microclimateFront, -2000, 1000);
const b = sampleProceduralWeather(
  { ...microclimateFront, hour: microclimateFront.hour + 0.01 },
  -2000,
  1000
);
assert(Math.abs(a.rain - b.rain) < 0.02, "weather forecast must be continuous across nearby times");

const forced = forcedWeather("storm");
assert.equal(forced.kind, "storm");
assert(forced.rain > 0.8 && forced.storm > 0.8, "storm override must exercise rain and lightning systems");

console.log("[weather-system] ok", {
  annual: {
    clear: +clearShare.toFixed(3),
    rain: +wetShare.toFixed(3),
    storm: +stormShare.toFixed(3)
  },
  rainyCloud: +(rainyCloud / rainyCloudSamples).toFixed(3),
  clearCloud: +(clearCloud / clearCloudSamples).toFixed(3),
  microclimate: { west: +west.rain.toFixed(3), east: +east.rain.toFixed(3) }
});
