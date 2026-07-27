// Two-client phoenix wingbeat probe.
//
// Client A flies the phoenix under real scripted input (a held climb — the
// flight state that makes the wings dig in and never stop beating). Client B
// rides it as a passenger, which is also exactly what an onlooker's client
// does: both go through RemotePlayers. We sample the wing, tail and neck bones
// of B's copy of the mount every frame and assert they actually travel. Before
// the shared-poser fix the remote phoenix carried no animation at all, so a
// passenger flew a statue and only the pilot ever saw the wings work.
//
// Also asserted: the passenger stays glued to their saddle anchor, and B's
// stroke depth is in the same league as the pilot's own — a gait rebuilt from
// the wire, not a token flutter.
//
// Usage: node tools/phoenix-passenger-flap-probe.mjs   (dev server on 5240 by
// default; override with SF_PROBE_URL)

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const OUTPUT = resolve(".data/phoenix/passenger-flap.json");
// Two saddle-view frames a beat apart: the wings must be in visibly different
// places in them. This is the failure the fix was reported against, so it is
// worth having a picture of it and not only a number.
const SHOTS = [
  resolve(".data/phoenix/passenger-flap-upstroke.png"),
  resolve(".data/phoenix/passenger-flap-downstroke.png")
];
const SAMPLE_MS = 4000;

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome/Chromium not found; set CHROME_BIN");
  return found;
}

const browser = await chromium.launch({
  executablePath: chromePath(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures",
    "--use-angle=metal",
    "--hide-scrollbars",
    "--mute-audio"
  ]
});

const pages = [];
try {
  const errors = [[], []];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors[i].push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors[i].push(message.text());
    });
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&spawn=goldenGate`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
  }
  const [pilot, passenger] = pages;

  await Promise.all(pages.map((page) => page.waitForFunction(
    () => window.__sf?.player && window.__sf?.net?.status === "online" && window.__sf?.renderIdle?.(),
    undefined,
    { timeout: 180_000 }
  )));

  const pilotId = await pilot.evaluate(() => window.__sf.net.selfId);
  const passengerId = await passenger.evaluate(() => window.__sf.net.selfId);
  assert(pilotId > 0 && passengerId > 0 && pilotId !== passengerId, "both clients must be online");

  // --- pilot mounts up ----------------------------------------------------
  await pilot.evaluate(() => window.__sf.player.trySwitch("bird"));
  await pilot.waitForFunction(
    () => window.__sf.player.meshes.bird.userData.rig && window.__sf.player.meshes.bird.userData.phoenixAsset,
    undefined,
    { timeout: 60_000 }
  );

  // --- passenger sees the mount, then rides it ----------------------------
  // Same first-use gate the walk-up prompt opens; the 180 m proximity rule in
  // remotes.ts still decides whether this particular bird hydrates.
  await passenger.evaluate(() => window.__sf.remotes.setBirdAssetsEnabled(true));
  await passenger.waitForFunction(
    (id) => {
      const avatar = window.__sf.remotes.avatars.get(id);
      return avatar?.mode === "bird" && !!avatar.bodies.bird?.userData.rig;
    },
    pilotId,
    { timeout: 60_000 }
  );
  await passenger.evaluate((id) => window.__sf.embodiments.startPassengerRide(id, 1), pilotId);

  // --- pilot flies a sustained climb --------------------------------------
  await pilot.evaluate(() => {
    window.__sf.input.setDriver({
      update(dt, controls) {
        controls.hold("KeyW");
        controls.hold("Space");
        controls.look(0, -2.5); // pin the camera nose-up: W then flies the climb
      }
    });
  });

  // Per-frame bone sampler. Deflection is measured against each bone's REST
  // quaternion (BoneCtl.rest), so it is axis-agnostic: whichever way the rig
  // twists, a bone that never leaves its rest pose scores zero.
  const sampler = `(id) => {
    const sf = window.__sf;
    const THREE = sf.THREE;
    const KEYS = ["wingL", "wingR", "elbowL", "handL", "tail", "neck"];
    const ctlOf = (rig, key) => (key === "tail" ? rig.tail[2] : key === "neck" ? rig.neck[0] : rig[key]);
    const state = { frames: 0, seatGap: 0, travel: {}, depth: {}, samples: [] };
    window.__flapSpy = state;
    const last = {};
    const seat = new THREE.Vector3();
    const seatQuat = new THREE.Quaternion();
    const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
    sf.input.setDriver({
      update() {
        const avatar = sf.remotes.avatars.get(id);
        const rig = avatar?.bodies.bird?.userData.rig;
        if (!rig) return;
        state.frames++;
        for (const key of KEYS) {
          const ctl = ctlOf(rig, key);
          const q = ctl.bone.quaternion;
          if (last[key]) state.travel[key] = (state.travel[key] ?? 0) + angle(last[key], q);
          last[key] = q.clone();
          state.depth[key] = Math.max(state.depth[key] ?? 0, angle(ctl.rest, q));
        }
        // Skip the boarding frames: this hook runs in the frame prologue, so
        // for the first few ticks after startPassengerRide the walker is still
        // standing on the bridge while the mount is already a hundred metres up.
        if (state.frames > 30 && sf.remotes.ridePose(id, 1, seat, seatQuat)) {
          state.seatGap = Math.max(state.seatGap, seat.distanceTo(sf.player.renderPosition));
        }
        if (state.frames % 20 === 0) {
          state.samples.push({
            speed: +avatar.speed.toFixed(2),
            vy: +avatar.birdFlight.vertical.toFixed(2),
            climb: +avatar.birdFlight.drive.climb.toFixed(3),
            twirl: +avatar.birdFlight.drive.twirl.toFixed(3),
            demand: +avatar.birdPoser.beat.demand.toFixed(3),
            beatW: +avatar.birdPoser.beat.beatW.toFixed(3)
          });
        }
      }
    });
    return true;
  }`;
  await passenger.evaluate(`(${sampler})(${pilotId})`);

  // The pilot's own wing over the same window is the control group — same
  // metric, chained behind the flight driver already installed above.
  await pilot.evaluate(() => {
    const sf = window.__sf;
    const state = { frames: 0, travel: 0, depth: 0 };
    window.__flapSpy = state;
    const flight = sf.input.driver;
    let last = null;
    const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b))));
    sf.input.setDriver({
      update(dt, controls) {
        flight.update(dt, controls);
        const rig = sf.player.meshes.bird.userData.rig;
        if (!rig) return;
        state.frames++;
        const q = rig.wingL.bone.quaternion;
        if (last) state.travel += angle(last, q);
        last = q.clone();
        state.depth = Math.max(state.depth, angle(rig.wingL.rest, q));
      }
    });
  });

  await passenger.waitForTimeout(SAMPLE_MS);

  const remote = await passenger.evaluate(() => {
    const spy = window.__flapSpy;
    return {
      frames: spy.frames,
      travel: spy.travel,
      depth: spy.depth,
      seatGap: spy.seatGap,
      samples: spy.samples,
      riding: window.__sf.player.riding,
      passengerOf: window.__sf.embodiments.passengerOf
    };
  });
  const local = await pilot.evaluate(() => ({ ...window.__flapSpy, mode: window.__sf.player.mode }));

  // Saddle view, a third of a stroke apart.
  mkdirSync(dirname(SHOTS[0]), { recursive: true });
  await passenger.screenshot({ path: SHOTS[0] });
  await passenger.waitForTimeout(220);
  await passenger.screenshot({ path: SHOTS[1] });

  // --- and once more from the ground, as a bystander -----------------------
  // Hop off and keep watching the same phoenix fly away. Nothing about the
  // wingbeat may depend on being aboard it.
  await passenger.evaluate(() => {
    window.__sf.embodiments.leaveRide();
    const spy = window.__flapSpy;
    spy.frames = 0;
    spy.travel = {};
    spy.depth = {};
  });
  await passenger.waitForTimeout(2000);
  const watching = await passenger.evaluate(() => {
    const spy = window.__flapSpy;
    return { frames: spy.frames, travel: spy.travel, depth: spy.depth, riding: window.__sf.player.riding };
  });

  assert.equal(local.mode, "bird", "pilot must still be flying");
  assert(remote.frames > 60, `passenger sampled too few frames (${remote.frames})`);
  assert.equal(remote.riding, true, "passenger must still be on the mount");
  assert.equal(remote.passengerOf, pilotId, "passenger must still be seated on the pilot's phoenix");

  // The fix: the remote skeleton moves at all, and moves like a wingbeat.
  assert(remote.travel.wingL > 6, `left wing barely moved on the passenger's client (${remote.travel.wingL} rad)`);
  assert(remote.travel.wingR > 6, `right wing barely moved on the passenger's client (${remote.travel.wingR} rad)`);
  assert(remote.depth.wingL > 0.35, `left wing stroke too shallow (${remote.depth.wingL} rad off rest)`);
  assert(remote.depth.wingR > 0.35, `right wing stroke too shallow (${remote.depth.wingR} rad off rest)`);
  assert(remote.travel.elbowL > 2, `elbow did not follow the stroke (${remote.travel.elbowL} rad)`);
  assert(remote.travel.handL > 2, `wrist did not follow the stroke (${remote.travel.handL} rad)`);
  assert(remote.travel.tail > 0.2, `tail is frozen on the passenger's client (${remote.travel.tail} rad)`);
  assert(remote.travel.neck > 0.001, `neck is frozen on the passenger's client (${remote.travel.neck} rad)`);

  // Same league as the pilot's own stroke — a rebuilt gait, not a token flutter.
  const ratio = remote.depth.wingL / local.depth;
  assert(ratio > 0.45 && ratio < 2.2, `remote stroke depth ${remote.depth.wingL} vs pilot ${local.depth} (ratio ${ratio})`);
  // The gait must have loaded up on the climb rather than settling into a glide.
  const demand = Math.max(...remote.samples.map((s) => s.demand));
  assert(demand > 0.85, `remote gait never loaded up on the climb (peak demand ${demand})`);

  assert(remote.seatGap < 0.05, `passenger drifted off the saddle anchor by ${remote.seatGap} m`);

  // Bystander view: same wings, no saddle involved.
  assert.equal(watching.riding, false, "passenger should be back on their feet");
  assert(watching.frames > 30, `bystander sampled too few frames (${watching.frames})`);
  assert(watching.travel.wingL > 3, `wings froze once off the mount (${watching.travel.wingL} rad)`);
  assert(watching.depth.wingL > 0.35, `bystander stroke too shallow (${watching.depth.wingL} rad off rest)`);
  assert.equal(errors[0].length, 0, `pilot errors:\n${errors[0].join("\n")}`);
  assert.equal(errors[1].length, 0, `passenger errors:\n${errors[1].join("\n")}`);

  const report = { remote, watching, local, ratio: +ratio.toFixed(2) };
  writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ok: true, screenshots: SHOTS, ...report }, null, 2));
} finally {
  await browser.close();
}
