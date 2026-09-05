import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://localhost:5271";
const OUT = ".data/world-upgrade/vehicle-transitions.json";
const browser = await chromium.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--use-angle=metal", "--mute-audio"]
});
const report = { url: BASE_URL, errors: [], warnings: [], cases: [] };

async function freshPage() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => report.errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "warning") report.warnings.push(message.text());
  });
  await page.goto(`${BASE_URL}/?autostart=1&profile&fullfps&spawn=oceanBeach`, {
    waitUntil: "domcontentloaded",
    timeout: 120_000
  });
  await page.waitForFunction(
    () => window.__sf?.player && document.body.classList.contains("started") && !window.__sf.worldArrival.active,
    undefined,
    { timeout: 180_000 }
  );
  return { context, page };
}

async function retryUsesNewestCarConfig() {
  const { context, page } = await freshPage();
  try {
    const result = await page.evaluate(async () => {
      const sf = window.__sf;
      const player = sf.player;
      assertFinitePlayer(player);
      const originalPrepareVisual = player.prepareVisual;
      let driveAttempts = 0;
      let rejectedRoot = null;
      player.prepareVisual = async (root) => {
        const isDrivePreparation =
          root === player.meshes.drive &&
          !player.isModeReady("drive") &&
          Boolean(root.userData.carConfig);
        if (!isDrivePreparation) return originalPrepareVisual(root);
        driveAttempts++;
        if (!rejectedRoot) {
          rejectedRoot = root;
          throw new Error("vehicle-transition-probe induced prepare failure");
        }
        await originalPrepareVisual(root);
      };
      let firstFailure = null;
      try {
        await player.prepareMode("drive");
      } catch (error) {
        firstFailure = String(error?.message ?? error);
      }
      if (!firstFailure?.includes("induced prepare failure")) {
        throw new Error(`first preparation did not reject as induced: ${firstFailure}`);
      }
      if (player.isModeReady("drive")) throw new Error("drive became ready after rejected preparation");

      const failedShell = player.meshes.drive;
      const base = sf.getCarConfig();
      const newest = {
        ...base,
        form: base.form === "trail-box" ? "mission-gt" : "trail-box",
        wheel: base.wheel === "rally-eight" ? "mesh-ten" : "rally-eight",
        paintHex: 0x2a71e8,
        clearcoat: base.clearcoat === 93 ? 92 : 93
      };
      player.setCarConfig(newest);
      await player.prepareMode("drive");
      const mesh = player.meshes.drive;
      const actual = mesh.userData.carConfig;
      const wheelNames = ["fl", "fr", "rl", "rr"].map((id) => Boolean(mesh.getObjectByName(`car_wheel_${id}`)));
      const snapshot = {
        driveAttempts,
        firstFailure,
        ready: player.isModeReady("drive"),
        shellRebuilt: mesh !== failedShell,
        expected: newest,
        actual: actual ? { ...actual } : null,
        wheelNames,
        childCount: mesh.children.length,
        finite: finitePlayer(player)
      };
      player.prepareVisual = originalPrepareVisual;
      return snapshot;

      function finitePlayer(p) {
        return p.position.toArray().every(Number.isFinite) && p.quaternion.toArray().every(Number.isFinite);
      }
      function assertFinitePlayer(p) {
        if (!finitePlayer(p)) throw new Error("player began retry case with non-finite state");
      }
    });
    assert.equal(result.driveAttempts, 2, "retry should make exactly one successful Drive preparation after the induced failure");
    assert.equal(result.ready, true);
    assert.equal(result.shellRebuilt, true, "retry must replace the stale shell built before configuration changed");
    assert.deepEqual(result.actual, result.expected, "prepared car mesh must publish the newest complete carConfig");
    assert.ok(result.wheelNames.every(Boolean) && result.childCount > 0, "new car shell must contain substantive visual geometry");
    assert.equal(result.finite, true);
    return result;
  } finally {
    await context.close();
  }
}

async function newerSurfCancelsColdDrive() {
  const { context, page } = await freshPage();
  try {
    await page.evaluate(() => {
      const sf = window.__sf;
      const player = sf.player;
      const originalPrepareVisual = player.prepareVisual;
      const originalOnModeChange = player.onModeChange;
      const gates = new Map();
      window.__vehicleTransitionFixture = {
        events: [],
        gates,
        originalPrepareVisual,
        originalOnModeChange,
        release(mode) {
          const gate = gates.get(mode);
          if (!gate) throw new Error(`${mode} preparation gate was not reached`);
          gate.resolve();
        },
        cleanup() {
          player.prepareVisual = originalPrepareVisual;
          player.onModeChange = originalOnModeChange;
          gates.clear();
        }
      };
      player.onModeChange = (mode) => {
        window.__vehicleTransitionFixture.events.push(mode);
        originalOnModeChange(mode);
      };
      player.prepareVisual = async (root) => {
        const mode = root === player.meshes.drive ? "drive" : root === player.meshes.surf ? "surf" : "other";
        if (mode === "other") return originalPrepareVisual(root);
        await new Promise((resolve, reject) => gates.set(mode, { resolve, reject }));
        await originalPrepareVisual(root);
      };
      sf.switchMode("drive");
    });
    await page.waitForFunction(() => window.__vehicleTransitionFixture?.gates.has("drive"), undefined, { timeout: 30_000 });
    await page.evaluate(() => window.__sf.switchMode("surf"));
    await page.waitForFunction(() => window.__vehicleTransitionFixture?.gates.has("surf"), undefined, { timeout: 120_000 });

    await page.evaluate(() => window.__vehicleTransitionFixture.release("drive"));
    await page.waitForFunction(() => window.__sf.player.isModeReady("drive"), undefined, { timeout: 120_000 });
    await page.waitForTimeout(750);
    const afterDrive = await page.evaluate(() => ({
      mode: window.__sf.player.mode,
      events: [...window.__vehicleTransitionFixture.events],
      finite: window.__sf.player.position.toArray().every(Number.isFinite)
    }));
    assert.equal(afterDrive.mode, "walk", "superseded Drive preparation must not change the current mode");
    assert.equal(afterDrive.events.includes("drive"), false, "superseded Drive must not emit onModeChange");
    assert.equal(afterDrive.finite, true);

    await page.evaluate(() => window.__vehicleTransitionFixture.release("surf"));
    await page.waitForFunction(
      () => window.__sf.player.mode === "surf" && !window.__sf.worldArrival.active,
      undefined,
      { timeout: 180_000 }
    );
    const final = await page.evaluate(() => ({
      mode: window.__sf.player.mode,
      events: [...window.__vehicleTransitionFixture.events],
      ready: { drive: window.__sf.player.isModeReady("drive"), surf: window.__sf.player.isModeReady("surf") },
      finite: window.__sf.player.position.toArray().every(Number.isFinite) &&
        window.__sf.player.quaternion.toArray().every(Number.isFinite)
    }));
    assert.equal(final.mode, "surf");
    assert.equal(final.events.includes("drive"), false);
    assert.equal(final.events.filter((mode) => mode === "surf").length, 1);
    assert.deepEqual(final.ready, { drive: true, surf: true });
    assert.equal(final.finite, true);
    await page.evaluate(() => window.__vehicleTransitionFixture.cleanup());
    return { afterDrive, final };
  } finally {
    await context.close();
  }
}

try {
  report.cases.push({ name: "retry-uses-newest-car-config", result: await retryUsesNewestCarConfig() });
  report.cases.push({ name: "newer-surf-cancels-cold-drive", result: await newerSurfCancelsColdDrive() });
  assert.equal(report.errors.length, 0, report.errors.join("\n"));
  report.warningSummary = {
    total: report.warnings.length,
    missingPosition: report.warnings.filter((warning) => /attribute[^\n]*position|position[^\n]*attribute/i.test(warning)).length,
    missingACenter: report.warnings.filter((warning) => /attribute[^\n]*aCenter|aCenter[^\n]*attribute/i.test(warning)).length,
    missingAId: report.warnings.filter((warning) => /attribute[^\n]*aId|aId[^\n]*attribute/i.test(warning)).length,
    missingColor: report.warnings.filter((warning) => /attribute[^\n]*color|color[^\n]*attribute/i.test(warning)).length,
    missingALit: report.warnings.filter((warning) => /attribute[^\n]*aLit|aLit[^\n]*attribute/i.test(warning)).length,
    normal: report.warnings.filter((warning) => /attribute[^\n]*normal|normal[^\n]*attribute/i.test(warning)).length,
    patterns: [...new Set(report.warnings)]
  };
  report.ok = true;
  console.log(JSON.stringify({ ok: true, cases: report.cases.map(({ name }) => name), warnings: report.warningSummary }, null, 2));
} catch (error) {
  report.ok = false;
  report.failure = error?.stack ?? String(error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await mkdir(".data/world-upgrade", { recursive: true });
  await writeFile(OUT, JSON.stringify(report, null, 2));
  await browser.close();
}
