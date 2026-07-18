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
assert.equal(TEA_GARDEN_TOUR_STOPS.length, 5, "Hiro's tour must keep exactly five featured stops");
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
    assert.equal(inTeaGardenWater(point[0], point[1]), false, `${stop.id} routes Hiro through water`);
  }
}

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const initialArrivalSource = readFileSync(new URL("../src/app/compose/initialArrival.ts", import.meta.url), "utf8");
const viteConfigSource = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const citygenSource = readFileSync(new URL("../src/world/citygen/stream/ring.ts", import.meta.url), "utf8");
const tourSource = readFileSync(new URL("../src/world/japaneseTeaGarden/dialogue.ts", import.meta.url), "utf8");
const architectureSource = readFileSync(new URL("../src/world/japaneseTeaGarden/architecture.ts", import.meta.url), "utf8");
const teaGardenIndexSource = readFileSync(new URL("../src/world/japaneseTeaGarden/index.ts", import.meta.url), "utf8");
const dryLandscapeSource = readFileSync(new URL("../src/world/japaneseTeaGarden/dryLandscape.ts", import.meta.url), "utf8");
const sandSimulationSource = readFileSync(new URL("../src/world/japaneseTeaGarden/sandSimulation.ts", import.meta.url), "utf8");
const waterSimulationSource = readFileSync(new URL("../src/world/japaneseTeaGarden/waterSimulation.ts", import.meta.url), "utf8");
const streamAudioSource = readFileSync(new URL("../src/world/japaneseTeaGarden/streamAudio.ts", import.meta.url), "utf8");
const fetchBallSource = readFileSync(new URL("../src/gameplay/fetchBall.ts", import.meta.url), "utf8");
const vegetationSource = readFileSync(new URL("../src/world/japaneseTeaGarden/vegetation.ts", import.meta.url), "utf8");
const clothSource = readFileSync(new URL("../src/fx/cloth.ts", import.meta.url), "utf8");
const costumeSource = readFileSync(new URL("../src/world/japaneseTeaGarden/hiroCostume.ts", import.meta.url), "utf8");
const guideSource = readFileSync(new URL("../src/world/japaneseTeaGarden/guide.ts", import.meta.url), "utf8");
const teaMasterSource = readFileSync(new URL("../src/world/japaneseTeaGarden/teaMaster.ts", import.meta.url), "utf8");
const teaGardenSources = [mainSource, tourSource, architectureSource, costumeSource, guideSource, teaMasterSource].join("\n");
// The excludeBuilding closure carries an explanatory comment before it calls
// isTeaGardenBuilding, so anchor on the arrow and allow a wide window rather
// than being sensitive to comment length.
assert.match(
  mainSource,
  /excludeBuilding:\s*\(key, index\)\s*=>[\s\S]{0,500}isTeaGardenBuilding\(key, index\)/,
  "CityGen is not excluding authored Tea Garden buildings"
);
assert.match(
  viteConfigSource,
  /if \(path === "\*"\)[\s\S]*module graph invalidated[\s\S]*return \(send/,
  "Vite can strand a stale Three/TSL module graph after dependency optimization"
);
assert.equal(
  viteConfigSource.includes('code.replaceAll(\n      "location.reload()"'),
  false,
  "Vite reconnect/HMR recovery reloads are disabled, which can duplicate Three/TSL state"
);
assert.match(mainSource, /tiles\.suppressBuilding\(building\.key, building\.index\)/, "baked Tea Garden colliders are not suppressed");
assert.match(initialArrivalSource, /get\("tour"\) === "hiro"/, "Hiro deep-link contract disappeared");
assert.match(citygenSource, /excludeBuilding\?\./, "CityGen exclusion seam disappeared");
assert.equal(new RegExp(["Ha", "ru"].join(""), "i").test(teaGardenSources), false, "legacy Tea Garden guide name returned");
assert.match(tourSource, /id: "tea-master-hiro"/, "Hiro speaker identity disappeared");
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
  "drum_bridge_square_balustrade_posts",
  "drum_bridge_layered_outer_arch_fascias",
  "drum_bridge_round_handrails",
  "drum_bridge_visible_joinery_pegs",
  "drum_bridge_turned_landing_finials"
]) {
  assert.ok(architectureSource.includes(landmarkPart), `beauty-pass landmark part missing: ${landmarkPart}`);
}
assert.equal(architectureSource.includes("woodGrainTexture"), false, "procedural Drum Bridge grain returned");
assert.match(architectureSource, /loadTexture\(`\$\{textureRoot\}\/painted-timber-basecolor`/, "painted bridge texture is not using the app loader");
assert.match(teaGardenIndexSource, /Promise\.all\(\[architecture\.ready, vegetation\.ready\]\)/, "bridge texture readiness is not joined into the deferred site gate");
for (const stem of [
  "painted-timber-basecolor",
  "painted-timber-normal",
  "worn-timber-basecolor",
  "worn-timber-normal"
]) {
  assert.ok(architectureSource.includes(stem), `Drum Bridge does not mount texture ${stem}`);
  for (const extension of ["ktx2", "webp"]) {
    const file = new URL(`../public/japanese-tea-garden/drum-bridge/${stem}.${extension}`, import.meta.url);
    assert.ok(statSync(file).size > 100_000, `Drum Bridge runtime texture is missing or unexpectedly tiny: ${stem}.${extension}`);
  }
}
assert.equal(architectureSource.includes("tea_house_core"), false, "sealed Tea House core collider returned");
for (const art of ["misty-pines", "drum-bridge-moon", "koi-ginkgo", "four-seasons"]) {
  assert.ok(architectureSource.includes(`/art/tea-house/${art}`), `Tea House does not mount artwork: ${art}`);
  for (const extension of ["ktx2", "webp"]) {
    const file = new URL(`../public/art/tea-house/${art}.${extension}`, import.meta.url);
    assert.ok(statSync(file).size > 100_000, `Tea House artwork is missing or unexpectedly tiny: ${art}.${extension}`);
  }
}

// Dry-landscape activity contract: the granular compute field follows terrain,
// the optional rake remains inside the Tea Garden chunk, one exact contact
// drives both simulation and pose, and grass keeps a wind-safe rim clearance.
for (const part of [
  "dry_landscape_hand_set_stone_rim",
  "dry_landscape_little_rake",
  "createSandSimulation",
  "garden_rake_tine_contact",
  "onCarryRake",
  "onRakeMotion"
]) {
  assert.ok(dryLandscapeSource.includes(part), `dry-landscape activity part missing: ${part}`);
}
assert.ok(sandSimulationSource.includes("dry_landscape_gpu_granular_sand"), "GPU sand mesh identity disappeared");
for (const seam of [
  "instancedArray",
  "angle of repose",
  "settleGroup",
  "MAX_QUEUED_STAMPS",
  "MAX_SETTLE_TICKS_PER_FRAME",
  "renderer.compute",
  "releaseRendererAttribute"
]) {
  assert.ok(sandSimulationSource.includes(seam), `GPU sand seam missing: ${seam}`);
}
assert.equal(sandSimulationSource.includes("readBuffer"), false, "GPU sand introduced a hot-path readback");
assert.equal(dryLandscapeSource.includes("dry_garden_player_rake_trails"), false, "legacy box-line rake trails returned");
assert.match(vegetationSource, /inDryLandscape\(px, pz, 1\.2\)/, "Tea Garden grass can clip into the sand rim");
assert.match(vegetationSource, /createAuthoredShrubPatch/, "Tea shrubs bypass the unified authored foliage runtime");
assert.match(vegetationSource, /"tea-azalea"/, "Tea azaleas lost their filled-volume unified profile");
assert.match(vegetationSource, /shadowProxyShape: "organic-lobes"/, "Tea trees lost their organic proxy-shadow opt-in");
assert.equal(mainSource.includes('from "./world/japaneseTeaGarden/dryLandscape"'), false, "rake activity leaked into the boot-critical main chunk");

// Connected-water contract: one direct-WebGPU shallow-water field owns both
// the Drum Bridge stream and south pond. The old concave centroid-scaled banks
// and terrain-draped static sheets caused the asphalt wedge and water clipping
// reported by players, so source-level regression checks intentionally reject
// those implementation seams before the browser probe judges the live field.
assert.match(architectureSource, /inTeaGardenWater\(x, z, waterMargin\)/, "Tea Garden paths can overlap the water again");
assert.equal(architectureSource.includes("function ringMesh("), false, "malformed centroid-scaled stone banks returned");
assert.equal(architectureSource.includes("_stone_bank"), false, "legacy asphalt-looking stone-bank mesh returned");
assert.equal(architectureSource.includes("function shapeMesh("), false, "legacy terrain-draped static water returned");
for (const identity of [
  "japanese_tea_garden_unified_flowing_water",
  "tea_garden_unified_webgpu_shallow_water_surface",
  "tea_garden_narrow_green_shoreline_bank",
  "tea_garden_stream_eddy_obstacle_rocks"
]) {
  assert.ok(waterSimulationSource.includes(identity), `connected-water identity missing: ${identity}`);
}
for (const seam of [
  "instancedArray",
  "storage(",
  "renderer.compute(solverGroup)",
  "renderer.compute(impulseCompute)",
  "derivatives",
  "divergence",
  "curl",
  "vorticity",
  "foam",
  "releaseRendererAttribute",
  "TEA_GARDEN_STREAM_AUDIO_ANCHORS.eddies.map"
]) {
  assert.ok(waterSimulationSource.includes(seam), `WebGPU shallow-water seam missing: ${seam}`);
}
for (const fluidSeam of [
  "type TeaGardenWaterImpulse",
  "queueImpulse(impulse: TeaGardenWaterImpulse): boolean",
  "MAX_QUEUED_IMPULSES",
  "MAX_IMPULSES_PER_DISPATCH",
  "impulseHeaders.value.needsUpdate = true",
  "impulseMotions.value.needsUpdate = true",
  "totalImpulses",
  "waveContrast",
  "fluxX",
  "fluxZ",
  "reflectedX",
  "reflectedZ"
]) {
  assert.ok(waterSimulationSource.includes(fluidSeam), `boundary-fluid/impulse seam missing: ${fluidSeam}`);
}
for (const dyeSeam of [
  "impulseDyes.value.needsUpdate = true",
  "dyeAdvectionGroup",
  "totalDyeImpulses",
  "totalDyeDispatches",
  "dyePersistence",
  "dyeSwirl",
  "dyeGlow",
  "shoreDamping"
]) {
  assert.ok(waterSimulationSource.includes(dyeSeam), `GPU paint-dye seam missing: ${dyeSeam}`);
}
assert.equal(
  waterSimulationSource.includes("visibleEddyInfluence"),
  false,
  "simulated relief is masked to authored rock eddies instead of driving the unified surface"
);
assert.ok(waterSimulationSource.includes("miterScale"), "mitered green shoreline lip disappeared");
assert.ok(waterSimulationSource.includes("mesh.receiveShadow = false"), "broad cascaded shadows can obscure fluid relief again");
for (const legacy of [".setPBO(", "readBuffer", "new THREE.WebGLRenderer", "WebGLBackend"]) {
  assert.equal(waterSimulationSource.includes(legacy), false, `WebGPU water introduced a legacy/readback path: ${legacy}`);
}
assert.match(waterSimulationSource, /requires the WebGPU backend/, "water no longer fails clearly without WebGPU");
assert.match(waterSimulationSource, /TEA_GARDEN_WATER_DROP = 0\.8/, "authored stream-to-pond grade disappeared");
assert.match(waterSimulationSource, /WATER_TUNING_FOLDERS/, "water tuning metadata is no longer colocated with defaults");
assert.match(teaGardenIndexSource, /createTeaGardenWaterSimulation/, "connected water is not integrated into the lazy Tea Garden");
assert.match(teaGardenIndexSource, /water\.update\(dt, time, player\)/, "connected water is not advanced by the Tea Garden update");
assert.match(teaGardenIndexSource, /surfaceY:\s*water\.surfaceY/, "water audio no longer shares the authored surface grade");
assert.match(teaGardenIndexSource, /water\.addTuning/, "water controls are missing from the late Tweakpane registration");
assert.equal(mainSource.includes('from "./world/japaneseTeaGarden/waterSimulation"'), false, "water solver leaked into the boot-critical main chunk");

// Gameplay disturbances stay allocation-free at their sources and converge on
// the same bounded GPU impulse queue. Cumulative per-source counters give the
// headless probe an observable contract without introducing a GPU readback.
for (const seam of [
  "JapaneseTeaGardenWaterInteractions",
  "updatePlayerWaterInteraction",
  "updateBallWaterInteractions",
  "water.queueImpulse(impulse)",
  "options.ballSource?.visitFreeBalls",
  "architecture.update(time, simsNear ? visitKoi : undefined)",
  "waterInteractions: { ...waterInteractions }"
]) {
  assert.ok(teaGardenIndexSource.includes(seam), `water gameplay-interaction seam missing: ${seam}`);
}
for (const seam of [
  "paintWater(impact: TeaGardenPaintWaterImpact)",
  "paintWaterSegment(segment: Readonly<PaintWaterSegment>)",
  'queueInteraction("paint"',
  "dyeR: r",
  "playRippleImpact({"
]) {
  assert.ok(teaGardenIndexSource.includes(seam), `paint/water AV integration seam missing: ${seam}`);
}
for (const seam of [
  "teaGardenPaintWater",
  "teaGardenPaintWaterSegment",
  "paintballs.onWaterSegment",
  "paintballs.onWater = (impact)"
]) {
  assert.ok(mainSource.includes(seam), `paintball Tea Garden routing seam missing: ${seam}`);
}
for (const seam of ["#nextBallId", "visitFreeBalls(", "FetchBallWorldState"]) {
  assert.ok(fetchBallSource.includes(seam), `allocation-free thrown-ball sampling seam missing: ${seam}`);
}
for (const seam of ["TeaGardenKoiVisitor", "waterSurfaceY", "visitKoi("]) {
  assert.ok(architectureSource.includes(seam), `near-surface koi wake seam missing: ${seam}`);
}
assert.match(mainSource, /fetchBall\?\.visitFreeBalls\(visitor\)/, "Tea Garden does not sample live thrown balls lazily");
assert.match(mainSource, /player\.mode,\s*player\.velocity/s, "Tea Garden does not receive live player velocity for directional foot wakes");

// Audio stays procedural and shares the one nature context/FX buses. It must
// remain inert until approach, positional at bridge/pond/rocks, and bounded.
for (const seam of [
  "voiceBus()",
  "alwaysBus",
  "#wet",
  "worldReverbSend",
  "effectsReverbSend",
  "TEA_GARDEN_STREAM_AUDIO_ANCHORS",
  "MAX_ACTIVE_EDDIES = 2",
  "targetDistanceGain",
  "#destroyGraph()"
]) {
  assert.ok(streamAudioSource.includes(seam), `procedural stream-audio seam missing: ${seam}`);
}
for (const seam of [
  "playRippleImpact(event: TeaGardenWaterRippleAudioEvent)",
  "RIPPLE_KIND_COOLDOWN",
  "maxImpactVoices",
  "impactGraphBuilds",
  "rippleAccepted",
  "rippleDroppedByKind",
  "lastKoiMotion",
  "lastKoiRippleDuration",
  "rippleRadius",
  "koiCooldown",
  "koiAudibleRadius",
  "feyBloom",
  "colorTimbre"
]) {
  assert.ok(streamAudioSource.includes(seam), `water-impact audio seam missing: ${seam}`);
}
for (const eagerAudio of ["new AudioContext", "fetch(", "new Audio("]) {
  assert.equal(streamAudioSource.includes(eagerAudio), false, `stream audio introduced its own/eager asset path: ${eagerAudio}`);
}

// The generic cloth path remains available to the world, while Hiro's current
// look-first costume is an explicit static layer stack. Keep the identifying
// pieces separate so the White Lotus silhouette cannot regress to one gradient
// tube or an oversized collision-projected poncho.
for (const seam of ["ClothColliders", "collisionIterations", "map?: THREE.Texture", "pushOutOfColliders"]) {
  assert.ok(clothSource.includes(seam), `reusable cloth seam missing: ${seam}`);
}
for (const garment of [
  "hiro_stone_under_robe",
  "hiro_navy_open_over_robe",
  "hiro_navy_front_apron",
  "hiro_white_lotus_mantle",
  "hiro_stone_bell_sleeve_",
  "hiro_wide_obi",
  "hiro_slipper_strap_"
]) {
  assert.ok(costumeSource.includes(garment), `Hiro garment missing: ${garment}`);
}
assert.match(teaMasterSource, /stridePhase \+ Math\.max\(0, travelDistance\)/, "Hiro gait is no longer distance-driven");
assert.match(teaMasterSource, /THREE\.MathUtils\.damp/, "Hiro pose blending disappeared");
assert.match(guideSource, /type TeaGardenDialogueSource/, "model-backed dialogue seam disappeared");
assert.match(guideSource, /type VoiceOutput/, "voice-output seam disappeared");

const speaker = { id: "probe-hiro", name: "Hiro" };
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
  drumBridgeTextures: ["painted timber color + normal", "worn timber color + normal", "KTX2 + WebP"],
  water: [
    "WebGPU boundary-constrained shallow-water field",
    "bounded GPU impulse queue",
    "advected premultiplied paint dye",
    "unified stream + pond",
    "five eddy rocks",
    "procedural positional and impact audio"
  ],
  cloth: ["shared-cloth-runtime", "static-layered-hiro-costume", "distance-driven-motion"]
}, null, 2));
