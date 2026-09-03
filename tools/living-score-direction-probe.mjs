import assert from "node:assert/strict";

const { scoreDirectionAt } = await import("../src/audio/livingScoreRegions.ts");

const at = (x, z, hour = 12) => scoreDirectionAt(x, z, hour);

assert.equal(at(-2282, 2183).profile, "tea-garden-stillness", "tea garden must override Golden Gate Park");
assert.equal(at(-6125, 1117).profile, "sutro-memory", "Sutro must override the broad Pacific coast");
assert.equal(at(-3150, -5100).profile, "marin-sky", "Marin must select its open-sky score");
assert.equal(at(-2275, -640).profile, "presidio-fog", "Presidio must select the coastal-forest score");
assert.equal(at(208, 2456, 23).profile, "afterlight-cosmos", "Afterlight must wake its cosmic score at night");
assert.notEqual(at(208, 2456, 12).profile, "afterlight-cosmos", "Afterlight score must stay nocturnal");
assert.equal(at(3900, 200, 23).profile, "downtown-neon", "downtown must turn neon at night");
assert.equal(at(3900, 200, 12).profile, "california-gold", "downtown must brighten by day");
assert(at(398, 2752, 12).liveMusicDuck < 0.2, "buskers must duck the non-diegetic score");
assert(at(3900, 200, 12).daylight > at(3900, 200, 23).daylight, "daylight character must ease between day and night");
assert.equal(
  scoreDirectionAt(3900, 200, 12, { rain: 0.8 }).profile,
  "city-rain",
  "sustained city rain must select the rain arrangement"
);
assert.equal(
  scoreDirectionAt(-2282, 2183, 12, { rain: 0.8, storm: 0.7 }).profile,
  "tea-garden-stillness",
  "intimate authored places must retain their geographic identity in rain"
);
assert.match(
  scoreDirectionAt(3900, 200, 12, { rain: 0.8, storm: 0.7 }).label,
  /electrical storm/,
  "storm direction must be visible to diagnostics"
);

console.log("[living-score-direction] ok");
