// Touch controls → Input rails, without a page: the real Input class with the
// TouchDriver attached, read back through the same down()/pressed()/axis()/
// mouseDX/firing readers every controller and the chase camera use.
// Run: npm run test:touch-input
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = `
export { Input } from './src/core/input.ts';
export { createTimeScrubAndTuningGestures } from './src/app/compose/timeScrub.ts';
export { TouchDriver, stickFromOffset, STICK_RADIUS } from './src/ui/touchDriver.ts';
`;
const bundled = await build({
  stdin: { contents: entry, resolveDir: ROOT, sourcefile: "touch-input-test-entry.ts", loader: "ts" },
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node22",
  logLevel: "silent"
});

// Just enough browser for Input's constructor and the tunables store.
const noop = () => {};
const target = () => ({ addEventListener: noop, removeEventListener: noop, requestPointerLock: noop });
const store = new Map();
globalThis.window = Object.assign(target(), { setTimeout, clearTimeout, innerWidth: 390, innerHeight: 844 });
globalThis.document = Object.assign(target(), { pointerLockElement: null, hasFocus: () => true, exitPointerLock: noop });
globalThis.localStorage = {
  getItem: (k) => store.get(k) ?? null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

const { Input, TouchDriver, stickFromOffset, STICK_RADIUS, createTimeScrubAndTuningGestures } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

const input = new Input(target());
const driver = new TouchDriver();
input.setDriver(driver);
/** One game frame: poll the driver, let the caller read, then end the frame. */
const frame = (read = noop) => {
  input.pollDriver(1 / 60);
  const out = read();
  input.endFrame();
  return out;
};

// Stick geometry: deadzone, full travel, clamp, screen-up is forward.
check(stickFromOffset(3, 3).x === 0 && stickFromOffset(3, 3).y === 0, "stick deadzone should swallow thumb wobble");
const up = stickFromOffset(0, -STICK_RADIUS);
check(near(up.x, 0) && near(up.y, 1), `full push up should be forward 1, got ${JSON.stringify(up)}`);
const far = stickFromOffset(STICK_RADIUS * 3, 0);
check(near(far.x, 1) && near(far.y, 0), `stick should clamp at full travel, got ${JSON.stringify(far)}`);

// Stick → the WASD axis pairs walk and every vehicle read.
driver.moveX = 0.5;
driver.moveY = 1;
frame(() => {
  check(near(input.axis("KeyS", "KeyW"), 1), "stick forward should read as W");
  check(near(input.axis("KeyA", "KeyD"), 0.5), "stick right should read as half D");
  check(near(input.axis("KeyD", "KeyA"), -0.5), "reversed steering lookup should flip sign");
});
driver.moveX = 0;
driver.moveY = 0;
frame(() => check(input.axis("KeyS", "KeyW") === 0, "released stick should read zero"));

// A tap shorter than a frame still lands as a pressed() edge, then lets go.
driver.press("Space");
driver.release("Space");
frame(() => {
  check(input.pressed("Space"), "sub-frame jump tap should raise pressed(Space)");
  check(!input.down("Space"), "sub-frame jump tap should not stay held");
});
frame(() => check(!input.pressed("Space"), "the jump edge should last exactly one frame"));

// A held button stays down across frames with a single edge.
driver.press("ShiftLeft");
frame(() => check(input.pressed("ShiftLeft") && input.down("ShiftLeft"), "run press should edge and hold"));
frame(() => check(!input.pressed("ShiftLeft") && input.down("ShiftLeft"), "held run should stay down without a second edge"));
driver.release("ShiftLeft");
frame(() => check(!input.down("ShiftLeft"), "lifting run should release Shift"));

// Lift and press again between two frames: a fresh edge, still held.
driver.press("KeyE");
frame();
driver.release("KeyE");
driver.press("KeyE");
frame(() => check(input.pressed("KeyE") && input.down("KeyE"), "re-press between frames should edge again"));
driver.release("KeyE");
frame();

// Look drag → the camera's mouse deltas (no pointer lock involved).
driver.look(10, -4);
frame(() => {
  check(input.mouseDX > 0 && input.mouseDY < 0, `look drag should feed mouseDX/DY, got ${input.mouseDX}, ${input.mouseDY}`);
  check(!input.locked, "touch look must not need pointer lock");
});
frame(() => check(input.mouseDX === 0 && input.mouseDY === 0, "look deltas should not repeat next frame"));

// Surf routes the same drag to the board, never the camera (same as a pad).
input.setMode("surf");
driver.look(10, 0);
frame(() => check(input.mouseDX === 0 && input.surfDX > 0, "surf should steer the board with a look drag"));
input.setMode("walk");

// Tool button → the mouse-hold fire rail.
driver.press("fire");
frame(() => check(input.firePressed && input.firing, "tool press should fire with an edge"));
frame(() => check(!input.firePressed && input.firing, "held tool should keep firing without a new edge"));
driver.release("fire");
frame(() => check(!input.firing, "lifting the tool should stop firing"));

// Suspension (map / menus) gates touch exactly like keyboard and pad.
input.suspended = true;
driver.moveY = 1;
driver.press("ShiftLeft");
driver.look(20, 0);
frame(() => {
  check(input.axis("KeyS", "KeyW") === 0 && !input.down("ShiftLeft"), "suspended input should read idle");
  check(input.mouseDX === 0, "suspended input should not look");
});
input.suspended = false;
driver.releaseAll();
frame();

// Pointer-lock loss cancels keyboard holds (golf / bow / ball) but never a
// touch player's, who had no lock to lose.
check(input.pointerCaptureLost, "unlocked keyboard player should read as capture lost");
input.noteTouch();
check(input.touchActive && !input.pointerCaptureLost, "touch player should never read as capture lost");
check(input.device === "kb", "touch should not change the kb/pad glyph device");
let lockRequests = 0;
const lockInput = new Input(Object.assign(target(), { requestPointerLock: () => lockRequests++ }));
lockInput.requestLock();
check(lockRequests === 1, "a keyboard player's requestLock should reach the browser");
lockInput.noteTouch();
lockInput.requestLock();
check(lockRequests === 1, "a touch player's requestLock should not ask the browser for pointer lock");

// iOS has no Pointer Lock API. Opening the map must finish the frame rather
// than throw and replay the same KeyM edge on the following frame.
document.exitPointerLock = undefined;
driver.press("KeyM");
driver.release("KeyM");
frame(() => {
  check(input.pressedRaw("KeyM"), "map tap should raise its UI edge");
  input.suspended = true;
  input.releaseLock();
});
frame(() => check(!input.pressedRaw("KeyM"), "map opening must not replay after releasing unsupported pointer lock"));
input.suspended = false;
document.exitPointerLock = noop;

// The clock shares desktop easing and wrapping, but never the camera/surf rail.
const sky = {
  timeOfDay: 23, cycleEnabled: true,
  advanceCivilHours(h) { this.timeOfDay = (this.timeOfDay + h + 24) % 24; }
};
const gestures = createTimeScrubAndTuningGestures({ input, sky, hud: { message: noop } });
const scrubFrame = (allow = true, keyboard = false) => frame(() => gestures.update(1 / 60, keyboard, false, false, allow));
input.setMode("surf");
driver.scrubTime(true, 2);
scrubFrame();
check(sky.timeOfDay > 23 && sky.timeOfDay < 24, "clock must ease toward target, not jump");
check(!sky.cycleEnabled, "clock holds the day cycle while dragging");
check(input.mouseDX === 0 && input.surfDX === 0, "clock must not steer the camera or surfboard");
driver.scrubTime(false);
for (let i = 0; i < 100; i++) scrubFrame();
check(Math.abs(sky.timeOfDay - 1) < .01, "clock must wrap forward across midnight");
check(sky.cycleEnabled, "clock must restore a running day cycle after settling");
sky.cycleEnabled = false;
// An entire reverse swipe before the next frame must not disappear.
driver.scrubTime(true, -2);
driver.scrubTime(false);
for (let i = 0; i < 100; i++) scrubFrame();
check(Math.abs(sky.timeOfDay - 23) < .02, "sub-frame swipe must rewind across midnight");
check(!sky.cycleEnabled, "clock must preserve a previously paused day cycle");
const beforeBlocked = sky.timeOfDay;
driver.scrubTime(true, 4);
scrubFrame(false);
driver.releaseAll();
for (let i = 0; i < 100; i++) scrubFrame();
check(near(sky.timeOfDay, beforeBlocked), "map/arrival must discard scrub deltas rather than replay later");
driver.scrubTime(true, 4);
driver.look(30, 40);
driver.releaseAll();
scrubFrame();
check(!input.timeScrubHeld && near(sky.timeOfDay, beforeBlocked), "backgrounding must clear pending time gestures");
check(input.surfDX === 0, "backgrounding must clear pending look gestures");
input.setMode("walk");
input.mouseDX = 100;
scrubFrame(true, true);
for (let i = 0; i < 100; i++) scrubFrame();
check(Math.abs((((sky.timeOfDay - beforeBlocked) % 24) + 24) % 24 - 1) < .01, "desktop Z scrub must still advance one hour per 100 pixels");

if (failures.length) {
  console.error(`touch input: ${failures.length} failure(s)\n - ${failures.join("\n - ")}`);
  process.exit(1);
}
console.log("touch input: stick, buttons, look, fire, surf routing, suspension lock-cancel rails, and smooth day/night gestures OK");
