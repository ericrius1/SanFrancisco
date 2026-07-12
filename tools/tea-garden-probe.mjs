// Pure Japanese Tea Garden regression probe: mapped placement, replacement
// identities, tour route integrity, and the reusable scripted-dialogue contract.
// Run: npm run test:tea-garden

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  JAPANESE_TEA_GARDEN_CENTER,
  TEA_GARDEN_BUILDINGS,
  TEA_GARDEN_SUPPRESSED_BUILDINGS,
  TEA_GARDEN_TOUR_STOPS,
  inJapaneseTeaGarden,
  inTeaGardenWater,
  isTeaGardenBuilding
} from "../src/world/japaneseTeaGarden/layout.ts";
import {
  ScriptedDialogueProvider
} from "../src/gameplay/agents/dialogue.ts";

assert.equal(TEA_GARDEN_BUILDINGS.length, 7, "expected all seven authored mapped buildings");
assert.equal(TEA_GARDEN_SUPPRESSED_BUILDINGS.length, 7, "replacement list must cover all seven baked prisms");
assert.equal(TEA_GARDEN_TOUR_STOPS.length, 5, "Haru's tour must keep exactly five featured stops");
assert.equal(new Set(TEA_GARDEN_TOUR_STOPS.map((stop) => stop.id)).size, 5, "tour stop ids must be unique");
assert.ok(
  inJapaneseTeaGarden(JAPANESE_TEA_GARDEN_CENTER.x, JAPANESE_TEA_GARDEN_CENTER.z),
  "mapped center escaped the garden outline"
);
assert.equal(inJapaneseTeaGarden(-2100, 2000), false, "distant Golden Gate Park point entered the garden mask");

for (const building of TEA_GARDEN_SUPPRESSED_BUILDINGS) {
  assert.ok(isTeaGardenBuilding(building.key, building.index), `missing replacement identity ${building.key}:${building.index}`);
}
for (const stop of TEA_GARDEN_TOUR_STOPS) {
  assert.ok(inJapaneseTeaGarden(stop.x, stop.z, 1), `${stop.id} landmark lies outside the mapped garden`);
  assert.ok(inJapaneseTeaGarden(stop.guideX, stop.guideZ, 1), `${stop.id} guide position lies outside the mapped garden`);
  assert.equal(inTeaGardenWater(stop.guideX, stop.guideZ), false, `${stop.id} guide position lies in water`);
  assert.ok(stop.route.length > 0, `${stop.id} has no walking route`);
  for (const point of stop.route) {
    assert.equal(point.length, 2, `${stop.id} has a malformed route point`);
    assert.ok(point.every(Number.isFinite), `${stop.id} has a non-finite route coordinate`);
    assert.equal(inTeaGardenWater(point[0], point[1]), false, `${stop.id} routes Haru through water`);
  }
}

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const citygenSource = readFileSync(new URL("../src/world/citygen/stream/ring.ts", import.meta.url), "utf8");
const tourSource = readFileSync(new URL("../src/world/japaneseTeaGarden/dialogue.ts", import.meta.url), "utf8");
assert.match(mainSource, /excludeBuilding:\s*isTeaGardenBuilding/, "CityGen is not excluding authored Tea Garden buildings");
assert.match(mainSource, /tiles\.suppressBuilding\(building\.key, building\.index\)/, "baked Tea Garden colliders are not suppressed");
assert.match(citygenSource, /excludeBuilding\?\./, "CityGen exclusion seam disappeared");
for (const historyAnchor of ["1894", "forced from its garden home", "Shinshichi Nakatani", "1915", "Nagao Sakurai", "2019", "two hundred million"]) {
  assert.ok(tourSource.includes(historyAnchor), `tour history anchor missing: ${historyAnchor}`);
}

const speaker = { id: "probe-haru", name: "Haru" };
const turns = [
  { id: "one", speaker, text: "Welcome." },
  { id: "two", speaker, text: "Come along." }
];
const provider = new ScriptedDialogueProvider(turns);
const history = [];
const request = { agentId: speaker.id, conversationId: "probe", history };
const first = await provider.nextTurn(request, new AbortController().signal);
assert.equal(first?.id, "one", "scripted dialogue lost ordering");
if (first) history.push(first);
const second = await provider.nextTurn({ ...request, history }, new AbortController().signal);
assert.equal(second?.id, "two", "scripted dialogue skipped a turn");
assert.equal(await provider.nextTurn(request, new AbortController().signal), null, "scripted dialogue did not exhaust");
provider.reset();
assert.equal(provider.position, 0, "scripted dialogue did not reset");
const aborted = new AbortController();
aborted.abort();
await assert.rejects(() => provider.nextTurn(request, aborted.signal), { name: "AbortError" });

console.log(JSON.stringify({
  ok: true,
  buildings: TEA_GARDEN_BUILDINGS.map((building) => building.name),
  replacements: TEA_GARDEN_SUPPRESSED_BUILDINGS.map((building) => `${building.key}:${building.index}`),
  tour: TEA_GARDEN_TOUR_STOPS.map((stop) => ({ id: stop.id, routePoints: stop.route.length }))
}, null, 2));
