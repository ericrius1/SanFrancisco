// Headless end-to-end contract probe for generic world arrivals.
//
// It drives generic far-apart destinations, an open-water bridge deck, and a
// latest-wins rapid pair through
// the same public teleport path as the map. For every completed scenario it
// verifies that the camera cuts locally, input cannot move the fail-closed
// player before collision readiness, and the coordinator returns to idle.
// Resource phases, latency, errors, and rAF gaps are written to one JSON file.
//
//   SF_PROBE_URL=http://127.0.0.1:5260 node tools/world-arrival-probe.mjs
//
// Env: SF_PROBE_URL (default http://127.0.0.1:5260),
//      SF_PROBE_OUT (default .data/world-arrival-probe.json), CHROME_BIN,
//      SF_PROBE_CAMERA_MAX (default 50m), SF_PROBE_HELD_MOVE_MAX (default .05m),
//      SF_PROBE_WAIT_WILDLANDS=1 (wait until deferred foliage is compiled and attached),
//      SF_PROBE_CPU_BACKGROUND=1 (profile that optional warmup interval)
import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE_URL = process.env.SF_PROBE_URL ?? "http://127.0.0.1:5260";
const OUT = path.resolve(ROOT, process.env.SF_PROBE_OUT ?? ".data/world-arrival-probe.json");
const CAMERA_MAX_METERS = Number(process.env.SF_PROBE_CAMERA_MAX ?? 50);
const HELD_MOVE_MAX_METERS = Number(process.env.SF_PROBE_HELD_MOVE_MAX ?? 0.05);
const ARRIVAL_TIMEOUT_MS = Number(process.env.SF_PROBE_ARRIVAL_TIMEOUT ?? 45_000);
const W = Number(process.env.SF_PROBE_W ?? 1600);
const H = Number(process.env.SF_PROBE_H ?? 1000);
const CPU_PROFILE_FIRST = process.env.SF_PROBE_CPU === "1";
const CPU_PROFILE_BACKGROUND = process.env.SF_PROBE_CPU_BACKGROUND === "1";
const WAIT_WILDLANDS = process.env.SF_PROBE_WAIT_WILDLANDS === "1";
const SCREENSHOT = process.env.SF_PROBE_SCREENSHOT
  ? path.resolve(ROOT, process.env.SF_PROBE_SCREENSHOT)
  : null;
const SCREENSHOT_DELAY_MS = Math.max(0, Number(process.env.SF_PROBE_SCREENSHOT_DELAY_MS) || 0);

// Deliberately generic grid locations: no landmark-specific arrival behavior.
const DESTINATIONS = [
  // Start with a dense but non-wildlands city destination so a cold first cut
  // exposes global/background contention independently of foliage preparation.
  { label: "generic-southeast", x: 3000, z: -1500 },
  { label: "generic-west-to-east", x: 900, z: 2400 },
  { label: "generic-northwest", x: -4000, z: 4000 },
  // The canonical owner cell is a visual-empty b=0 tile. This proves collision
  // readiness includes the streamed stepped bridge boxes rather than relying on
  // the flat landmark query-world mirror or terrain underneath the span.
  { label: "bridge-deck-safety", x: -3017, z: -3306 },
  // Return after earlier destinations have retired the initial residency. This
  // exercises pipeline/cache lifetime, not just a never-evicted warm chunk.
  { label: "wildlands-return", x: -4600, z: 2080 }
];
const RAPID_PAIR = {
  label: "rapid-superseding-pair",
  first: { label: "rapid-first", x: 900, z: 2400 },
  second: { label: "rapid-final", x: -4000, z: 4000 }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value, digits = 2) => Number.isFinite(value)
  ? Number(value.toFixed(digits))
  : value;

function summarizeCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMicros = new Map();
  let sampledMicros = 0;
  for (let index = 0; index < (profile.samples?.length ?? 0); index++) {
    const micros = profile.timeDeltas?.[index] ?? 0;
    const id = profile.samples[index];
    sampledMicros += micros;
    selfMicros.set(id, (selfMicros.get(id) ?? 0) + micros);
  }
  return {
    sampledMs: round(sampledMicros / 1000, 1),
    topSelf: [...selfMicros.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([id, micros]) => {
        const frame = nodes.get(id)?.callFrame;
        return {
          name: frame?.functionName || "(anonymous)",
          file: frame?.url ? frame.url.split("/").at(-1) : "",
          line: (frame?.lineNumber ?? -1) + 1,
          selfMs: round(micros / 1000, 1)
        };
      })
  };
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser"
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("No Chrome/Chromium executable found. Set CHROME_BIN.");
}

async function waitHttp(url, timeoutMs = 30_000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return response.status;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError?.message ?? "unreachable"}`);
}

function probeUrl() {
  const url = new URL(BASE_URL);
  url.searchParams.set("autostart", "1");
  url.searchParams.set("profile", "1");
  // Chrome throttles rAF in some automated contexts without this app flag.
  url.searchParams.set("fullfps", "1");
  return url.toString();
}

function resourceCategory(name) {
  if (/\/tiles\/tile_[^/]*\.glb(?:\?|$)/i.test(name)) return "building-tile-glb";
  if (/\/tiles\/terrain_[^/]*\.glb(?:\?|$)/i.test(name)) return "terrain-tile-glb";
  if (/\/data\/colliders\//i.test(name)) return "collision-data";
  if (/\/data\/.*(?:building|map|terrain|manifest)/i.test(name)) return "world-data";
  if (/\.(?:m?js)(?:\?|$)/i.test(name)) return "script";
  if (/\.(?:png|jpe?g|webp|avif|ktx2?)(?:\?|$)/i.test(name)) return "image-texture";
  if (/\.(?:mp3|ogg|wav|m4a)(?:\?|$)/i.test(name)) return "audio";
  if (/\.(?:woff2?|ttf|otf)(?:\?|$)/i.test(name)) return "font";
  return "other";
}

function arrivalPhase(state) {
  if (state === "resolving" || state === "committing") return "resolve-commit";
  if (state === "loading-visuals") return "visual-prime";
  if (
    state === "visually-ready" ||
    state === "loading-collision" ||
    state === "visual-blocked" ||
    state === "collision-blocked"
  ) {
    return "collision-prime";
  }
  return "idle-other";
}

function summarizeResources(resources, stateEvents, startedAt, endedAt) {
  const inWindow = resources.filter((resource) =>
    resource.startT >= startedAt && resource.startT <= endedAt
  );
  const enriched = inWindow.map((resource) => {
    const stateAtStart = [...stateEvents]
      .reverse()
      .find((event) => event.t <= resource.startT);
    return {
      ...resource,
      category: resourceCategory(resource.name),
      phase: arrivalPhase(stateAtStart?.state)
    };
  });
  const aggregate = (key) => Object.fromEntries(
    [...new Set(enriched.map((resource) => resource[key]))].sort().map((value) => {
      const entries = enriched.filter((resource) => resource[key] === value);
      return [value, {
        requests: entries.length,
        transferBytes: entries.reduce((sum, resource) => sum + (resource.transferSize || 0), 0),
        decodedBytes: entries.reduce((sum, resource) => sum + (resource.decodedBodySize || 0), 0),
        maxDurationMs: round(Math.max(0, ...entries.map((resource) => resource.duration)), 1)
      }];
    })
  );
  return {
    requestCount: enriched.length,
    byPhase: aggregate("phase"),
    byCategory: aggregate("category"),
    requests: enriched
  };
}

function maxFrameGap(samples, startedAt, endedAt) {
  return round(Math.max(
    0,
    ...samples
      .filter((sample) => sample.t >= startedAt && sample.t <= endedAt)
      .map((sample) => sample.dt)
  ), 1);
}

function maxPlanarMovement(samples, origin) {
  return round(Math.max(
    0,
    ...samples.map((sample) => Math.hypot(sample.position.x - origin.x, sample.position.z - origin.z))
  ), 4);
}

function visualAssetContract(name) {
  const tile = /\/tiles\/tile_([^/]+)\.glb(?:\?|$)/i.exec(name);
  if (tile) return { kind: "tile", key: tile[1] };
  const terrain = /\/tiles\/(terrain_[^/]+)\.glb(?:\?|$)/i.exec(name);
  if (terrain) return { kind: "terrain", key: terrain[1] };
  return null;
}

async function installInstrumentation(page) {
  await page.evaluate(() => {
    const sf = window.__sf;
    if (!sf?.worldArrival) throw new Error("window.__sf.worldArrival is unavailable; include ?profile");
    const arrival = sf.worldArrival;
    const startedAbsolute = performance.now();
    const events = [];
    const markers = [];
    const samples = [];
    const resources = [];
    const visualPrimes = [];
    let rapid = null;
    let lastFrame = startedAbsolute;
    sf.tracer?.reset?.();

    const now = () => performance.now() - startedAbsolute;
    const plainCollision = (collision) => collision ? {
      epoch: collision.epoch,
      current: collision.current,
      active: collision.active,
      groundReady: collision.groundReady,
      colliderDataReady: collision.colliderDataReady,
      buildingBodiesReady: collision.buildingBodiesReady,
      ready: collision.ready,
      pendingColliderTiles: collision.pendingColliderTiles,
      failedColliderTiles: collision.failedColliderTiles,
      pendingBuildingBodies: collision.pendingBuildingBodies
    } : null;
    const point = (value) => ({ x: value.x, y: value.y, z: value.z });
    const read = (t, dt = 0) => {
      const snapshot = arrival.snapshot;
      const playerPosition = point(sf.player.position);
      const cameraPosition = point(sf.camera.position);
      return {
        t,
        dt,
        generation: snapshot.generation,
        state: snapshot.state,
        position: playerPosition,
        cameraPosition,
        cameraGap: Math.hypot(
          cameraPosition.x - playerPosition.x,
          cameraPosition.y - playerPosition.y,
          cameraPosition.z - playerPosition.z
        ),
        held: sf.player.worldArrivalHeld,
        inputSuspended: sf.input.suspended,
        keyW: sf.input.keys.has("KeyW"),
        collision: plainCollision(snapshot.collision),
        collisionReady: snapshot.collision?.ready ?? null
      };
    };
    const mark = (type, details = {}) => {
      const marker = { type, t: now(), ...details };
      markers.push(marker);
      return marker;
    };

    // Record the streamer's exact minimum-key contract separately from
    // coordinator state. A successful prime remains required-only until the
    // coordinator releases its background ring after interaction readiness.
    const originalPrimeAt = sf.tiles.primeAt.bind(sf.tiles);
    sf.tiles.primeAt = (x, z) => {
      const startedT = now();
      // A latest-wins request may replace a prime that already reached ready
      // but had not yet reached interaction release. TileStreamer correctly
      // adopts the new generation without resolving the already-settled
      // promise twice; mirror that replacement as superseded in the probe.
      const replacedReady = [...visualPrimes].reverse().find((candidate) =>
        candidate.status === "ready" && candidate.releasedT === null
      );
      if (replacedReady) replacedReady.status = "superseded";
      const prime = originalPrimeAt(x, z);
      const record = {
        generation: prime.generation,
        focus: { x, z },
        startedT,
        settledT: null,
        releasedT: null,
        releaseRequestedT: null,
        status: "pending",
        requiredTileKeys: [...prime.requiredTileKeys],
        requiredTerrainKeys: [...prime.requiredTerrainKeys]
      };
      visualPrimes.push(record);
      void prime.ready.then((result) => {
        record.settledT = now();
        record.status = result.status;
        if (result.status === "ready" && record.releaseRequestedT !== null) {
          record.releasedT = Math.max(record.releaseRequestedT, record.settledT);
        }
      });
      return prime;
    };
    const originalResumeBackground = sf.tiles.resumeBackgroundStreaming.bind(sf.tiles);
    sf.tiles.resumeBackgroundStreaming = () => {
      const record = [...visualPrimes].reverse().find((prime) =>
        prime.status !== "superseded" && prime.releasedT === null
      );
      const requestedT = now();
      const accepted = originalResumeBackground();
      if (accepted && record) {
        record.releaseRequestedT = requestedT;
        if (record.status === "ready") record.releasedT = record.releaseRequestedT;
      }
      return accepted;
    };

    const recordState = (snapshot) => {
      const reading = read(now());
      events.push({
        type: "state",
        ...reading,
        state: snapshot.state,
        generation: snapshot.generation,
        visualMs: snapshot.visualMs,
        interactiveMs: snapshot.interactiveMs,
        collision: plainCollision(snapshot.collision)
      });

      // Fire the second request from the state callback's microtask, so this is
      // genuinely a latest-wins supersession rather than two slow CDP calls.
      if (
        rapid && !rapid.fired && snapshot.generation > rapid.beforeGeneration &&
        snapshot.state === "loading-visuals"
      ) {
        rapid.fired = true;
        rapid.firstGeneration = snapshot.generation;
        queueMicrotask(() => {
          rapid.supersedeState = arrival.snapshot.state;
          const marker = mark("rapid-supersede", {
            scenario: rapid.scenario,
            firstGeneration: rapid.firstGeneration,
            state: rapid.supersedeState
          });
          rapid.supersedeT = marker.t;
          sf.teleportToTarget(rapid.second.x, rapid.second.z, rapid.second.label);
        });
      }
    };

    const originalStateChange = arrival.onStateChange;
    arrival.onStateChange = (snapshot) => {
      originalStateChange(snapshot);
      recordState(snapshot);
    };
    recordState(arrival.snapshot);

    const resourceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.startTime < startedAbsolute) continue;
        let name = entry.name;
        try {
          const url = new URL(entry.name, location.href);
          name = `${url.pathname}${url.search}`;
        } catch {}
        resources.push({
          name,
          initiatorType: entry.initiatorType,
          startT: entry.startTime - startedAbsolute,
          responseEndT: entry.responseEnd - startedAbsolute,
          duration: entry.duration,
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
          decodedBodySize: entry.decodedBodySize,
          observedGeneration: arrival.snapshot.generation,
          observedState: arrival.snapshot.state
        });
      }
    });
    resourceObserver.observe({ type: "resource" });

    const onFrame = (frameNow) => {
      const dt = frameNow - lastFrame;
      lastFrame = frameNow;
      samples.push(read(frameNow - startedAbsolute, dt));
      requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);

    window.__arrivalProbe = {
      events,
      markers,
      samples,
      resources,
      visualPrimes,
      now,
      mark,
      invoke(destination, scenario) {
        const beforeGeneration = arrival.snapshot.generation;
        const marker = mark("invoke", { scenario, beforeGeneration, destination });
        sf.teleportToTarget(destination.x, destination.z, destination.label);
        return { beforeGeneration, invokeT: marker.t };
      },
      invokeRapid(first, second, scenario) {
        const beforeGeneration = arrival.snapshot.generation;
        rapid = {
          beforeGeneration,
          firstGeneration: null,
          fired: false,
          scenario,
          second,
          supersedeT: null,
          supersedeState: null
        };
        const marker = mark("invoke", { scenario, beforeGeneration, destination: first });
        sf.teleportToTarget(first.x, first.z, first.label);
        return { beforeGeneration, invokeT: marker.t };
      },
      markW(scenario, generation, direction) {
        const marker = mark(`w-${direction}`, { scenario, generation });
        samples.push(read(marker.t, 0));
        return marker;
      },
      export() {
        return {
          elapsedMs: now(),
          events: [...events],
          markers: [...markers],
          samples: [...samples],
          resources: [...resources],
          visualPrimes: visualPrimes.map((prime) => ({ ...prime })),
          tracer: sf.tracer ? {
            summary: sf.tracer.summary(),
            spikes: [...sf.tracer.spikes]
          } : null,
          rapid: rapid ? { ...rapid } : null,
          final: read(now())
        };
      }
    };
  });
}

async function waitForCommitted(page, beforeGeneration, minimumGeneration = beforeGeneration + 1) {
  const handle = await page.waitForFunction(
    ({ beforeGeneration: before, minimumGeneration: minimum }) =>
      window.__arrivalProbe.events.find((event) =>
        event.type === "state" &&
        event.state === "loading-visuals" &&
        event.generation > before &&
        event.generation >= minimum
      ) ?? false,
    { beforeGeneration, minimumGeneration },
    { timeout: ARRIVAL_TIMEOUT_MS, polling: "raf" }
  );
  const event = await handle.jsonValue();
  await handle.dispose();
  return event;
}

async function waitForIdle(page, generation) {
  const handle = await page.waitForFunction(
    ({ generation: expected }) =>
      window.__arrivalProbe.events.find((event) =>
        event.type === "state" && event.state === "idle" && event.generation === expected
      ) ?? false,
    { generation },
    { timeout: ARRIVAL_TIMEOUT_MS, polling: "raf" }
  );
  const event = await handle.jsonValue();
  await handle.dispose();
  return event;
}

function assertCommitted(event, scenario) {
  assert.ok(event, `${scenario}: destination was never committed`);
  assert.ok(event.cameraGap <= CAMERA_MAX_METERS,
    `${scenario}: first destination frame camera was ${round(event.cameraGap)}m from the player`);
  assert.equal(event.held, true, `${scenario}: player was not held at destination commit`);
  assert.equal(event.inputSuspended, true, `${scenario}: input was not suspended at destination commit`);
}

async function runSingle(page, destination) {
  // Hold movement before invoking so the synchronous commit-state sample proves
  // the destination is pinned even when collision finishes behind a slower
  // visual prime before the test runner can issue a post-commit key event.
  await page.keyboard.down("w");
  const down = await page.evaluate(({ scenario }) =>
    window.__arrivalProbe.markW(scenario, -1, "down"), { scenario: destination.label });
  let invoke;
  let commit;
  let idle;
  try {
    invoke = await page.evaluate(({ destination: target }) =>
      window.__arrivalProbe.invoke(target, target.label), { destination });
    commit = await waitForCommitted(page, invoke.beforeGeneration);
    assertCommitted(commit, destination.label);
    idle = await waitForIdle(page, commit.generation);
  } finally {
    await page.keyboard.up("w");
    await page.evaluate(({ scenario }) =>
      window.__arrivalProbe.markW(scenario, -1, "up"), { scenario: destination.label });
  }
  let postIdleSafety = null;
  if (destination.label === "bridge-deck-safety") {
    await page.waitForTimeout(1200);
    postIdleSafety = await page.evaluate(() => {
      const sf = window.__sf;
      const x = sf.player.position.x;
      const y = sf.player.position.y;
      const z = sf.player.position.z;
      const deck = sf.map.bridgeDeck(x, z);
      const bodies = [];
      sf.physics.debugBuildingBodies(bodies);
      const supportBodies = bodies.filter((body) => {
        const dx = x - body.x;
        const dz = z - body.z;
        const cos = Math.cos(body.yaw);
        const sin = Math.sin(body.yaw);
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        return (
          Math.abs(lx) <= body.hx + 0.5 &&
          Math.abs(lz) <= body.hz + 0.5 &&
          Math.abs(body.y + body.hy - deck) <= 1.5
        );
      });
      return { x, y, z, deck, supportBodyCount: supportBodies.length };
    });
    assert.ok(Number.isFinite(postIdleSafety.deck),
      `${destination.label}: final position was no longer on a bridge deck`);
    assert.ok(postIdleSafety.supportBodyCount > 0,
      `${destination.label}: no stepped deck support body was materialized before unlock`);
    assert.ok(postIdleSafety.y >= postIdleSafety.deck + 0.25,
      `${destination.label}: player fell below the deck after collision unlock`);
  }
  return {
    label: destination.label,
    kind: "single",
    invokeT: invoke.invokeT,
    endT: idle.t,
    generations: [commit.generation],
    commits: [commit],
    finalGeneration: commit.generation,
    wDownT: down.t,
    idle,
    postIdleSafety
  };
}

async function runRapid(page) {
  await page.keyboard.down("w");
  const down = await page.evaluate(({ scenario }) =>
    window.__arrivalProbe.markW(scenario, -1, "down"), { scenario: RAPID_PAIR.label });
  let invoke;
  let firstCommit;
  let secondCommit;
  let rapidState;
  let idle;
  try {
    invoke = await page.evaluate(({ pair }) =>
      window.__arrivalProbe.invokeRapid(pair.first, pair.second, pair.label), { pair: RAPID_PAIR });
    firstCommit = await waitForCommitted(page, invoke.beforeGeneration);
    assertCommitted(firstCommit, `${RAPID_PAIR.label}/first`);
    secondCommit = await waitForCommitted(page, invoke.beforeGeneration, firstCommit.generation + 1);
    assertCommitted(secondCommit, `${RAPID_PAIR.label}/final`);
    assert.ok(secondCommit.generation > firstCommit.generation,
      `${RAPID_PAIR.label}: final target did not supersede the first generation`);
    rapidState = await page.evaluate(() => window.__arrivalProbe.export().rapid);
    assert.equal(rapidState?.fired, true, `${RAPID_PAIR.label}: superseding request never fired`);
    assert.notEqual(rapidState?.supersedeState, "idle",
      `${RAPID_PAIR.label}: second request started only after the first was idle`);
    idle = await waitForIdle(page, secondCommit.generation);
  } finally {
    await page.keyboard.up("w");
    await page.evaluate(({ scenario }) =>
      window.__arrivalProbe.markW(scenario, -1, "up"), { scenario: RAPID_PAIR.label });
  }
  return {
    label: RAPID_PAIR.label,
    kind: "rapid-latest-wins",
    invokeT: invoke.invokeT,
    endT: idle.t,
    generations: [firstCommit.generation, secondCommit.generation],
    commits: [firstCommit, secondCommit],
    finalGeneration: secondCommit.generation,
    supersedeT: rapidState.supersedeT,
    supersedeState: rapidState.supersedeState,
    wDownT: down.t,
    idle
  };
}

function analyzeScenario(raw, instrumentation) {
  const stateEvents = instrumentation.events.filter((event) =>
    event.type === "state" && event.t >= raw.invokeT && event.t <= raw.endT
  );
  // Include synchronous state snapshots as well as rAF samples. On a fast cache
  // collision may become ready before the first rAF after commit, but the
  // loading-visuals state is emitted at the exact unsafe destination commit.
  const finalSamples = [...instrumentation.samples, ...instrumentation.events].filter((sample) =>
    sample.generation === raw.finalGeneration &&
    sample.t >= raw.commits.at(-1).t && sample.t <= raw.endT &&
    sample.held && sample.collisionReady === false
  );
  assert.ok(finalSamples.length > 0,
    `${raw.label}: no sampled state showed the player held while collision was pending`);
  const heldMovementMeters = maxPlanarMovement(finalSamples, raw.commits.at(-1).position);
  assert.ok(heldMovementMeters <= HELD_MOVE_MAX_METERS,
    `${raw.label}: W moved the held player ${heldMovementMeters}m before collision readiness`);

  const blocked = stateEvents.filter(
    (event) => event.state === "visual-blocked" || event.state === "collision-blocked"
  );
  assert.equal(blocked.length, 0, `${raw.label}: arrival entered a blocked state`);
  assert.equal(raw.idle.state, "idle", `${raw.label}: arrival did not return to idle`);
  assert.equal(raw.idle.held, false, `${raw.label}: arrival returned idle with player still held`);
  assert.equal(raw.idle.inputSuspended, false, `${raw.label}: arrival returned idle with input suspended`);

  const scenarioPrimes = instrumentation.visualPrimes.filter((prime) =>
    prime.startedT >= raw.invokeT && prime.startedT <= raw.endT
  );
  let primeWindowVisualRequests = 0;
  for (const prime of scenarioPrimes) {
    const index = instrumentation.visualPrimes.indexOf(prime);
    const nextPrime = instrumentation.visualPrimes[index + 1];
    const windowEnd = prime.status === "ready"
      ? prime.releasedT
      : Math.min(raw.endT, nextPrime?.startedT ?? raw.endT);
    if (prime.status === "ready") {
      assert.equal(typeof windowEnd, "number", `${raw.label}: ready visual prime was never released`);
      assert.ok(windowEnd >= prime.settledT,
        `${raw.label}: background streaming resumed before the visual minimum settled`);
    }
    if (typeof windowEnd !== "number") continue;
    const duringPrime = instrumentation.resources.filter((resource) =>
      resource.startT >= prime.startedT && resource.startT < windowEnd
    );
    for (const resource of duringPrime) {
      const asset = visualAssetContract(resource.name);
      if (!asset) continue;
      primeWindowVisualRequests++;
      const allowed = asset.kind === "tile"
        ? prime.requiredTileKeys.includes(asset.key)
        : prime.requiredTerrainKeys.includes(asset.key);
      assert.ok(allowed,
        `${raw.label}: ${asset.kind} ${asset.key} started outside the destination minimum`);
    }
    const sampledBeds = duringPrime.filter((resource) =>
      /\/(?:forest-birds|wind-tree|night-crickets|wind-grass)\.mp3(?:\?|$)/.test(resource.name)
    );
    assert.equal(sampledBeds.length, 0,
      `${raw.label}: sampled nature beds started before interaction readiness`);
  }

  return {
    label: raw.label,
    kind: raw.kind,
    generations: raw.generations,
    stateSequence: stateEvents.map((event) => `${event.generation}:${event.state}`),
    cameraGapMeters: raw.commits.map((event) => round(event.cameraGap)),
    visualLatencyMs: round(raw.idle.visualMs, 1),
    interactiveLatencyMs: round(raw.idle.interactiveMs, 1),
    heldPendingSamples: finalSamples.length,
    heldMovementMeters,
    maxFrameGapMs: maxFrameGap(instrumentation.samples, raw.invokeT, raw.endT),
    supersedeAfterMs: raw.supersedeT == null ? null : round(raw.supersedeT - raw.invokeT, 1),
    supersedeState: raw.supersedeState ?? null,
    bridgeSafety: raw.postIdleSafety ?? null,
    visualPrimes: scenarioPrimes,
    primeWindowVisualRequests,
    resources: summarizeResources(instrumentation.resources, instrumentation.events, raw.invokeT, raw.endT),
    final: {
      state: raw.idle.state,
      held: raw.idle.held,
      inputSuspended: raw.idle.inputSuspended,
      collisionReady: raw.idle.collision?.ready ?? null
    }
  };
}

function printScenario(result) {
  const gaps = result.cameraGapMeters.map((value) => `${value}m`).join(" -> ");
  console.log(
    `[arrival-probe] ${result.label}: visual=${result.visualLatencyMs}ms ` +
    `interactive=${result.interactiveLatencyMs}ms max-rAF=${result.maxFrameGapMs}ms ` +
    `camera=${gaps} held-move=${result.heldMovementMeters}m resources=${result.resources.requestCount}`
  );
}

async function main() {
  await mkdir(path.dirname(OUT), { recursive: true });
  const url = probeUrl();
  const report = {
    ok: false,
    createdAt: new Date().toISOString(),
    url,
    viewport: { width: W, height: H, deviceScaleFactor: 1 },
    limits: {
      cameraMaxMeters: CAMERA_MAX_METERS,
      heldMoveMaxMeters: HELD_MOVE_MAX_METERS,
      arrivalTimeoutMs: ARRIVAL_TIMEOUT_MS
    },
    destinations: { singles: DESTINATIONS, rapidPair: RAPID_PAIR },
    serverStatus: null,
    appReadyMs: null,
    scenarios: [],
    errors: { page: [], console: [], requestFailures: [] }
  };
  let browser;
  let page;
  try {
    report.serverStatus = await waitHttp(url);
    const executablePath = await findChrome();
    browser = await chromium.launch({
      executablePath,
      headless: true,
      args: [
        "--enable-unsafe-webgpu",
        "--enable-features=WebGPUDeveloperFeatures",
        ...(process.platform === "darwin" ? ["--use-angle=metal"] : []),
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--hide-scrollbars",
        "--mute-audio"
      ]
    });
    const context = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1
    });
    page = await context.newPage();
    page.on("pageerror", (error) => report.errors.page.push(error.stack ?? error.message));
    page.on("console", (message) => {
      if (message.type() === "error") report.errors.console.push(message.text());
    });
    page.on("requestfailed", (request) => report.errors.requestFailures.push({
      url: request.url(),
      method: request.method(),
      error: request.failure()?.errorText ?? "unknown"
    }));

    const navigationStarted = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.waitForFunction(
      () => window.__sf?.worldArrival && window.__sf?.renderIdle?.() === true,
      null,
      { timeout: 120_000, polling: "raf" }
    );
    report.appReadyMs = Date.now() - navigationStarted;
    // Start frame/resource capture before an optional warm-world wait. That
    // interval is user-visible live play and must not disappear from the report
    // merely because the teleport scenarios begin after it.
    await installInstrumentation(page);
    let backgroundCpuSession = null;
    if (CPU_PROFILE_BACKGROUND) {
      backgroundCpuSession = await context.newCDPSession(page);
      await backgroundCpuSession.send("Profiler.enable");
      await backgroundCpuSession.send("Profiler.setSamplingInterval", { interval: 500 });
      await backgroundCpuSession.send("Profiler.start");
    }
    if (WAIT_WILDLANDS) {
      // `ready` covers descriptor/geometry construction; parent attachment
      // happens only after the detached WebGPU compile pass has also finished.
      // Waiting for both recreates the previously troublesome warm-world case.
      await page.waitForFunction(
        () => {
          const wildlands = window.__sf?.wildlands;
          return Boolean(
            wildlands &&
            wildlands.groups.length > 0 &&
            wildlands.groups.every((group) => group.parent)
          );
        },
        null,
        { timeout: 180_000, polling: 100 }
      );
      report.wildlandsReadyMs = Date.now() - navigationStarted;
    }
    if (backgroundCpuSession) {
      const { profile } = await backgroundCpuSession.send("Profiler.stop");
      report.backgroundWarmupCpu = summarizeCpuProfile(profile);
      await backgroundCpuSession.detach();
      backgroundCpuSession = null;
    }

    let cpuSession = null;
    if (CPU_PROFILE_FIRST) {
      cpuSession = await context.newCDPSession(page);
      await cpuSession.send("Profiler.enable");
      await cpuSession.send("Profiler.setSamplingInterval", { interval: 500 });
      await cpuSession.send("Profiler.start");
    }

    const rawScenarios = [];
    for (let index = 0; index < DESTINATIONS.length; index++) {
      const destination = DESTINATIONS[index];
      rawScenarios.push(await runSingle(page, destination));
      if (SCREENSHOT && destination.label === "wildlands-return") {
        if (SCREENSHOT_DELAY_MS > 0) await page.waitForTimeout(SCREENSHOT_DELAY_MS);
        await mkdir(path.dirname(SCREENSHOT), { recursive: true });
        await page.screenshot({ path: SCREENSHOT, type: "png" });
        report.screenshot = SCREENSHOT;
      }
      if (index === 0 && cpuSession) {
        const { profile } = await cpuSession.send("Profiler.stop");
        report.firstArrivalCpu = summarizeCpuProfile(profile);
        await cpuSession.detach();
        cpuSession = null;
      }
    }
    rawScenarios.push(await runRapid(page));
    const instrumentation = await page.evaluate(() => window.__arrivalProbe.export());
    const firstInvokeT = Math.min(...rawScenarios.map((scenario) => scenario.invokeT));
    report.backgroundWarmup = WAIT_WILDLANDS ? {
      durationMs: round(firstInvokeT, 1),
      maxFrameGapMs: maxFrameGap(instrumentation.samples, 0, firstInvokeT),
      frameGaps: instrumentation.samples
        .filter((sample) => sample.t >= 0 && sample.t <= firstInvokeT && sample.dt > 20)
        .sort((a, b) => b.dt - a.dt)
        .slice(0, 30)
        .map((sample) => round(sample.dt, 1))
    } : null;
    report.instrumentation = {
      elapsedMs: round(instrumentation.elapsedMs, 1),
      stateEventCount: instrumentation.events.length,
      frameSampleCount: instrumentation.samples.length,
      resourceCount: instrumentation.resources.length,
      visualPrimeCount: instrumentation.visualPrimes.length,
      stateEvents: instrumentation.events,
      markers: instrumentation.markers,
      visualPrimes: instrumentation.visualPrimes,
      tracer: instrumentation.tracer,
      largestFrameGaps: instrumentation.samples
        .filter((sample) => sample.dt > 20)
        .sort((a, b) => b.dt - a.dt)
        .slice(0, 30)
        .map((sample) => ({
          t: round(sample.t, 1),
          dt: round(sample.dt, 1),
          generation: sample.generation,
          state: sample.state
        }))
    };
    report.scenarios = rawScenarios.map((raw) => analyzeScenario(raw, instrumentation));
    report.retention = await page.evaluate(() => {
      const sf = window.__sf;
      const resident = sf.wildlands?.trees?.group?.userData?.nativeTreeResidentChunks?.() ?? null;
      const memory = sf.renderer?.info?.memory;
      return {
        nativeTreeResidentChunks: resident,
        nativeTreeAuthoredChunks: sf.wildlands?.trees?.stats?.chunks ?? null,
        rendererGeometries: memory?.geometries ?? null,
        rendererTextures: memory?.textures ?? null
      };
    });
    report.maxFrameGapMs = round(Math.max(
      0,
      ...report.scenarios.map((scenario) => scenario.maxFrameGapMs)
    ), 1);
    assert.equal(report.errors.page.length, 0, "uncaught page errors occurred during the probe");
    assert.equal(instrumentation.final.state, "idle", "coordinator was not idle after all scenarios");
    assert.equal(instrumentation.final.held, false, "player remained held after all scenarios");
    report.ok = true;
    for (const scenario of report.scenarios) printScenario(scenario);
    console.log(`[arrival-probe] PASS; global max-rAF=${report.maxFrameGapMs}ms`);
  } catch (error) {
    if (page && !page.isClosed() && !report.instrumentation) {
      try {
        const partial = await page.evaluate(() => window.__arrivalProbe?.export?.() ?? null);
        if (partial) {
          report.partialInstrumentation = {
            elapsedMs: round(partial.elapsedMs, 1),
            stateEvents: partial.events,
            markers: partial.markers,
            resourceCount: partial.resources.length,
            largestFrameGaps: partial.samples
              .filter((sample) => sample.dt > 20)
              .sort((a, b) => b.dt - a.dt)
              .slice(0, 30)
          };
        }
      } catch {}
    }
    report.failure = {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : null
    };
    console.error(`[arrival-probe] FAIL: ${report.failure.message}`);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`[arrival-probe] wrote ${OUT}`);
  }
}

await main();
