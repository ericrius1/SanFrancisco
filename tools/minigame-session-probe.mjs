import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MinigameSessionController } from "../src/gameplay/minigameSession.ts";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const playerSource = readFileSync(new URL("../src/player/player.ts", import.meta.url), "utf8");
const navigationSource = readFileSync(new URL("../src/app/navigation.ts", import.meta.url), "utf8");
const teaGardenSource = readFileSync(new URL("../src/world/japaneseTeaGarden/index.ts", import.meta.url), "utf8");
const dryLandscapeSource = readFileSync(new URL("../src/world/japaneseTeaGarden/dryLandscape.ts", import.meta.url), "utf8");

// Integration seams: held props, movement modifiers, and navigation all converge
// on one teardown before either a normal teleport or return-to-start relocation.
assert.match(
  dryLandscapeSource,
  /releaseForNavigation\(\)[\s\S]{0,160}setHeld\(false\)/,
  "rake navigation teardown no longer clears the held state"
);
assert.match(
  teaGardenSource,
  /releaseForNavigation\(\)[\s\S]{0,160}dryLandscape\.releaseForNavigation\(\)/,
  "lazy Tea Garden facade no longer exposes rake teardown"
);
assert.match(
  mainSource,
  /id: "sand-raking"[\s\S]{0,360}japaneseTeaGarden\?\.releaseForNavigation\(\)/,
  "sand raking is not registered with the shared minigame session"
);
assert.match(
  mainSource,
  /releaseGameplayForNavigation[\s\S]{0,180}minigameSession\.releaseForNavigation/,
  "teleports no longer use the shared minigame teardown"
);
assert.match(
  playerSource,
  /resetMinigameState\(\)[\s\S]{0,360}setGardenRakeTool\(null\)/,
  "player minigame reset no longer clears the rake speed/tool state"
);
assert.match(
  navigationSource,
  /returnToMinigameStart[\s\S]{0,220}#relocateToPose/,
  "explicit minigame exit no longer shares the navigation arrival path"
);

let active = false;
let releases = 0;
let playerResets = 0;
const sessionChanges = [];
const controller = new MinigameSessionController({
  resetPlayerState: () => { playerResets += 1; },
  onChange: (session) => sessionChanges.push(session?.id ?? null)
});
controller.register({
  id: "probe-raking",
  label: "probe raking",
  isActive: () => active,
  release: () => {
    releases += 1;
    active = false;
  }
});

const origin = { x: 12, y: 3, z: -7, facing: 0.75, mode: "walk" };
controller.beginFrame(origin);
active = true;
controller.endFrame({ ...origin, x: 14 });
assert.deepEqual(controller.current?.origin, origin, "minigame start pose was captured after interaction movement");

const releasedSession = controller.releaseForNavigation({ ...origin, x: 99 });
assert.deepEqual(releasedSession?.origin, origin, "minigame exit lost the saved return pose");
assert.equal(releases, 1, "active minigame controller was not released exactly once");
assert.equal(playerResets, 1, "player-level minigame safety reset did not run exactly once");
assert.equal(controller.current, null, "released minigame remained active");
assert.deepEqual(sessionChanges, ["probe-raking", null], "minigame HUD visibility did not follow the lifecycle");

console.log("minigame session probe passed");
