// Pure Japanese Tea Garden regression probe: mapped placement, replacement
// identities, tour route integrity, and the reusable scripted-dialogue contract.
// Run: npm run test:tea-garden

import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
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
assert.equal(TEA_GARDEN_TOUR_STOPS.length, 5, "Iroh's tour must keep exactly five featured stops");
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
    assert.equal(inTeaGardenWater(point[0], point[1]), false, `${stop.id} routes Iroh through water`);
  }
}

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const citygenSource = readFileSync(new URL("../src/world/citygen/stream/ring.ts", import.meta.url), "utf8");
const tourSource = readFileSync(new URL("../src/world/japaneseTeaGarden/dialogue.ts", import.meta.url), "utf8");
const architectureSource = readFileSync(new URL("../src/world/japaneseTeaGarden/architecture.ts", import.meta.url), "utf8");
const dryLandscapeSource = readFileSync(new URL("../src/world/japaneseTeaGarden/dryLandscape.ts", import.meta.url), "utf8");
const vegetationSource = readFileSync(new URL("../src/world/japaneseTeaGarden/vegetation.ts", import.meta.url), "utf8");
const clothSource = readFileSync(new URL("../src/fx/cloth.ts", import.meta.url), "utf8");
const costumeSource = readFileSync(new URL("../src/world/japaneseTeaGarden/irohCostume.ts", import.meta.url), "utf8");
const guideSource = readFileSync(new URL("../src/world/japaneseTeaGarden/guide.ts", import.meta.url), "utf8");
const teaMasterSource = readFileSync(new URL("../src/world/japaneseTeaGarden/teaMaster.ts", import.meta.url), "utf8");
const teaGardenSources = [mainSource, tourSource, architectureSource, costumeSource, guideSource, teaMasterSource].join("\n");
assert.match(mainSource, /excludeBuilding:\s*isTeaGardenBuilding/, "CityGen is not excluding authored Tea Garden buildings");
assert.match(mainSource, /tiles\.suppressBuilding\(building\.key, building\.index\)/, "baked Tea Garden colliders are not suppressed");
assert.match(mainSource, /get\("tour"\) === "iroh"/, "Iroh deep-link contract disappeared");
assert.match(citygenSource, /excludeBuilding\?\./, "CityGen exclusion seam disappeared");
assert.equal(new RegExp(["Ha", "ru"].join(""), "i").test(teaGardenSources), false, "legacy Tea Garden guide name returned");
assert.match(tourSource, /id: "tea-master-iroh"/, "Iroh speaker identity disappeared");
for (const historyAnchor of ["1894", "forced from its garden home", "Shinshichi Nakatani", "1915", "Nagao Sakurai", "2019", "two hundred million"]) {
  assert.ok(tourSource.includes(historyAnchor), `tour history anchor missing: ${historyAnchor}`);
}

// Beauty-pass invariants: open walkable Tea House, original art, and the
// real bridge's stair/rib/rail vocabulary must not regress to proxy boxes.
for (const landmarkPart of [
  "tea_house_walkable_veranda",
  "tea_house_original_fusuma_gallery",
  "drum_bridge_worn_stair_treads",
  "drum_bridge_six_laminated_arch_ribs",
  "drum_bridge_joined_upper_and_lower_rails",
  "drum_bridge_square_balustrade_posts"
]) {
  assert.ok(architectureSource.includes(landmarkPart), `beauty-pass landmark part missing: ${landmarkPart}`);
}
assert.equal(architectureSource.includes("tea_house_core"), false, "sealed Tea House core collider returned");
for (const art of ["misty-pines.webp", "drum-bridge-moon.webp", "koi-ginkgo.webp", "four-seasons.webp"]) {
  const file = new URL(`../public/art/tea-house/${art}`, import.meta.url);
  assert.ok(statSync(file).size > 100_000, `Tea House artwork is missing or unexpectedly tiny: ${art}`);
  assert.ok(architectureSource.includes(`/art/tea-house/${art}`), `Tea House does not mount artwork: ${art}`);
}

// Dry-landscape activity contract: the sand follows terrain, the optional rake
// remains inside the Tea Garden chunk, trails use a bounded instance buffer,
// and authored grass leaves a full wind-safe margin around the stone rim.
for (const part of [
  "dry_garden_terrain_conforming_sand",
  "dry_landscape_hand_set_stone_rim",
  "dry_landscape_little_rake",
  "dry_garden_player_rake_trails",
  "TRAIL_GROOVE_CAPACITY = 2400",
  "onCarryRake",
  "onRakingChange"
]) {
  assert.ok(dryLandscapeSource.includes(part), `dry-landscape activity part missing: ${part}`);
}
assert.match(vegetationSource, /inDryLandscape\(px, pz, 1\.2\)/, "Tea Garden grass can clip into the sand rim");
assert.equal(mainSource.includes('from "./world/japaneseTeaGarden/dryLandscape"'), false, "rake activity leaked into the boot-critical main chunk");

// The generic cloth path remains available to the world, while Iroh's current
// look-first costume is an explicit static layer stack. Keep the identifying
// pieces separate so the White Lotus silhouette cannot regress to one gradient
// tube or an oversized collision-projected poncho.
for (const seam of ["ClothColliders", "collisionIterations", "map?: THREE.Texture", "pushOutOfColliders"]) {
  assert.ok(clothSource.includes(seam), `reusable cloth seam missing: ${seam}`);
}
for (const garment of [
  "iroh_stone_under_robe",
  "iroh_navy_open_over_robe",
  "iroh_navy_front_apron",
  "iroh_white_lotus_mantle",
  "iroh_stone_bell_sleeve_",
  "iroh_wide_obi",
  "iroh_slipper_strap_"
]) {
  assert.ok(costumeSource.includes(garment), `Iroh garment missing: ${garment}`);
}
assert.match(teaMasterSource, /stridePhase \+ Math\.max\(0, travelDistance\)/, "Iroh gait is no longer distance-driven");
assert.match(teaMasterSource, /THREE\.MathUtils\.damp/, "Iroh pose blending disappeared");
assert.match(guideSource, /type TeaGardenDialogueSource/, "model-backed dialogue seam disappeared");
assert.match(guideSource, /type VoiceOutput/, "voice-output seam disappeared");

const speaker = { id: "probe-iroh", name: "Iroh" };
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
  tour: TEA_GARDEN_TOUR_STOPS.map((stop) => ({ id: stop.id, routePoints: stop.route.length })),
  art: ["misty-pines", "drum-bridge-moon", "koi-ginkgo", "four-seasons"],
  cloth: ["shared-cloth-runtime", "static-layered-iroh-costume", "distance-driven-motion"]
}, null, 2));
