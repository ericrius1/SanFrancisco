import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240";
const RACK = { x: -2354.45, z: 2169.15 };
const SAND_PATHS = [
  { fromX: -2349, toX: -2346, z: 2170.3, facing: -Math.PI / 2 },
  { fromX: -2339, toX: -2342, z: 2170.3, facing: Math.PI / 2 }
];

function chromePath() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
  ].filter(Boolean);
  const result = candidates.find((candidate) => existsSync(candidate));
  if (!result) throw new Error("Chrome/Chromium not found; set CHROME_BIN");
  return result;
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
  const teaRequests = [[], []];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    pages.push(page);
    page.on("pageerror", (error) => errors[i].push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") errors[i].push(message.text());
    });
    page.on("request", (request) => {
      if (request.url().includes("/src/world/japaneseTeaGarden/dryLandscape.ts")) {
        teaRequests[i].push(request.url());
      }
    });
    await page.goto(`${BASE_URL}/?autostart=1&fullfps=1`, {
      waitUntil: "domcontentloaded",
      timeout: 120_000
    });
  }

  await Promise.all(pages.map((page) => page.waitForFunction(
    () => window.__sf?.player && window.__sf?.net?.status === "online",
    undefined,
    { timeout: 150_000 }
  )));
  assert.deepEqual(teaRequests.map((requests) => requests.length), [0, 0], "distant boot eagerly loaded rake geometry");

  await Promise.all(pages.map((page, index) => page.evaluate(({ rack, index }) => {
    const sf = window.__sf;
    const x = rack.x + index * 0.75;
    const z = rack.z;
    sf.player.teleportTo({
      x,
      y: sf.map.effectiveGround(x, z) + 0.9,
      z,
      facing: Math.PI / 2,
      mode: "walk"
    });
  }, { rack: RACK, index })));

  await Promise.all(pages.map((page) => page.waitForFunction(
    () => window.__sf?.japaneseTeaGarden?.debugState?.().awake &&
      window.__sf.japaneseTeaGarden.group.parent === window.__sf.scene &&
      Array.from(window.__sf?.remotes?.avatars?.values?.() ?? []).some((avatar) => avatar.mode === "walk" && avatar.root.visible),
    undefined,
    { timeout: 150_000 }
  )));
  assert.deepEqual(teaRequests.map((requests) => requests.length > 0), [true, true], "first approach did not load rake geometry");

  for (const page of pages) {
    await page.evaluate((rack) => {
      const sf = window.__sf;
      sf.player.teleportTo({
        x: rack.x,
        y: sf.map.effectiveGround(rack.x, rack.z) + 0.9,
        z: rack.z,
        facing: Math.PI / 2,
        mode: "walk"
      });
    }, RACK);
    await page.waitForTimeout(100);
    await page.evaluate(() => {
      const sf = window.__sf;
      sf.japaneseTeaGarden.interact(sf.player.renderPosition, sf.player.mode);
    });
    await page.waitForTimeout(500);
  }
  const pickupPresence = await Promise.all(pages.map((page) => page.evaluate(() => ({
    held: window.__sf.japaneseTeaGarden.debugState().dryLandscape.held,
    remotes: Array.from(window.__sf.remotes.avatars.values()).map((avatar) => ({
      id: avatar.info.id,
      mode: avatar.mode,
      visible: avatar.root.visible,
      latestRake: avatar.buffer.at(-1)?.rake ?? null,
      rakeMotion: avatar.rakeMotion,
      hasRakePose: Boolean(avatar.rakePose)
    }))
  }))));
  console.log("[multiplayer-rake] pickup presence", JSON.stringify(pickupPresence));
  await Promise.all(pages.map((page) => page.waitForFunction(
    () => {
      const sf = window.__sf;
      const remote = Array.from(sf?.remotes?.avatars?.values?.() ?? [])
        .find((avatar) => avatar.mode === "walk" && avatar.root.visible);
      return sf?.japaneseTeaGarden?.debugState?.().dryLandscape.held && remote?.rakePose?.tool?.root;
    },
    undefined,
    { timeout: 30_000 }
  )));

  const pickupAudits = await Promise.all(pages.map((page) => page.evaluate(() => {
    const sf = window.__sf;
    const remote = Array.from(sf.remotes.avatars.values())
      .find((avatar) => avatar.mode === "walk" && avatar.root.visible);
    const localRake = sf.player.meshes.walk.getObjectByName("dry_landscape_little_rake");
    const templates = [];
    sf.scene.traverse((object) => {
      if (object.name.startsWith("dry_landscape_rake_template_")) templates.push(object);
    });
    return {
      localVisible: Boolean(localRake?.visible),
      localParent: localRake?.parent?.name ?? null,
      remoteVisible: Boolean(remote.rakePose.tool.root.visible),
      remoteParentMatchesAvatar: remote.rakePose.tool.root.parent === remote.root,
      visibleTemplates: templates.filter((template) => template.visible).length
    };
  })));
  for (const audit of pickupAudits) {
    assert.equal(audit.localVisible, true, "local carried rake is hidden");
    assert.equal(audit.remoteVisible, true, "friend's carried rake is hidden");
    assert.equal(audit.remoteParentMatchesAvatar, true, "friend's rake is not owned by their avatar");
    assert.equal(audit.visibleTemplates, 2, "taking a rake depleted the reusable stand templates");
  }

  const before = await Promise.all(pages.map((page) => page.evaluate(() =>
    window.__sf.japaneseTeaGarden.debugState().dryLandscape.simulation.revision
  )));
  await Promise.all(pages.map((page, index) => page.evaluate(async (path) => {
    const sf = window.__sf;
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const x = path.fromX + (path.toX - path.fromX) * t;
      sf.player.teleportTo({
        x,
        y: sf.map.effectiveGround(x, path.z) + 0.9,
        z: path.z,
        facing: path.facing,
        mode: "walk"
      });
      sf.player.syncMesh(1 / 30);
      sf.japaneseTeaGarden.update(1 / 30, i / 30, sf.player.renderPosition, sf.camera, "walk");
      sf.player.syncMesh(1 / 30);
      if (i % 6 === 0) await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    // teleportTo intentionally arrives above its destination. Pin the final
    // pose to standing hip height so the remote IK audit measures gameplay,
    // not the probe's transient airborne arrival.
    const x = path.toX;
    const y = sf.map.effectiveGround(x, path.z) + 0.9;
    sf.physics.world.setBodyTransform(
      sf.player.body,
      [x, y, path.z],
      [0, Math.sin(path.facing * 0.5), 0, Math.cos(path.facing * 0.5)]
    );
    sf.physics.world.setBodyVelocity(sf.player.body, [0, 0, 0], [0, 0, 0]);
    sf.player.snapRenderPose();
    for (let i = 0; i < 12; i++) sf.tick(1 / 60);
    sf.player.syncMesh(1 / 60);
    sf.japaneseTeaGarden.update(1 / 60, 0, sf.player.renderPosition, sf.camera, "walk");
    sf.player.syncMesh(1 / 60);
  }, SAND_PATHS[index])));
  await pages[0].waitForTimeout(1800);

  const after = await Promise.all(pages.map((page) => page.evaluate(() =>
    window.__sf.japaneseTeaGarden.debugState().dryLandscape.simulation.revision
  )));
  assert.ok(after[0] > before[0] + 5, "player A's GPU sand did not consume shared strokes");
  assert.ok(after[1] > before[1] + 5, "player B's GPU sand did not consume shared strokes");

  const poseAudits = await Promise.all(pages.map((page) => page.evaluate(() => {
    const sf = window.__sf;
    const remote = Array.from(sf.remotes.avatars.values())
      .find((avatar) => avatar.mode === "walk" && avatar.root.visible && avatar.rakePose?.tool?.root);
    const tool = remote.rakePose.tool;
    const rig = remote.rig;
    const THREE = sf.THREE;
    const world = (object) => object.getWorldPosition(new THREE.Vector3());
    const pocket = (hand) => {
      const result = new THREE.Vector3(0, -0.05, -0.038).multiplyScalar(hand.scale.x);
      result.applyQuaternion(hand.getWorldQuaternion(new THREE.Quaternion()));
      return result.add(world(hand));
    };
    const contact = world(tool.contact);
    const rightGrip = world(tool.rightGrip);
    const leftGrip = world(tool.leftGrip);
    const rightHand = pocket(rig.handR);
    const leftHand = pocket(rig.handL);
    const motion = remote.rakeMotion;
    return {
      engaged: motion.engaged,
      contactError: contact.distanceTo(new THREE.Vector3(motion.contactX, motion.contactY, motion.contactZ)),
      rightGripError: rightGrip.distanceTo(rightHand),
      leftGripError: leftGrip.distanceTo(leftHand),
      points: {
        root: remote.root.position.toArray(),
        contact: contact.toArray(),
        rightGrip: rightGrip.toArray(),
        leftGrip: leftGrip.toArray(),
        rightHand: rightHand.toArray(),
        leftHand: leftHand.toArray()
      }
    };
  })));
  console.log("[multiplayer-rake] remote poses", JSON.stringify(poseAudits));
  for (const audit of poseAudits) {
    assert.equal(audit.engaged, true, "remote rake did not remain grounded in the sand");
    assert.ok(audit.contactError < 0.03, `remote rake missed shared contact by ${audit.contactError}m`);
    assert.ok(audit.rightGripError < 0.035, `remote right hand missed rake by ${audit.rightGripError}m`);
    assert.ok(audit.leftGripError < 0.035, `remote left hand missed rake by ${audit.leftGripError}m`);
  }

  const gpuErrors = errors.flat().filter((message) => /WebGPU|GPUValidation|WGSL|render pipeline|bind group|TypeError/i.test(message));
  assert.deepEqual(gpuErrors, [], `browser errors: ${gpuErrors.join("\n")}`);
  console.log("multiplayer rake browser probe passed", JSON.stringify({ pickupAudits, before, after, poseAudits }));
} finally {
  await browser.close();
}
