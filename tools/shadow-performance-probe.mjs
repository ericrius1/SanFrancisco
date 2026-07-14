// GPU-synchronized shadow runtime profile at one deterministic city location.
//
//   node tools/shadow-performance-probe.mjs label=http://127.0.0.1:4188
//   node tools/shadow-performance-probe.mjs baseline=http://127.0.0.1:4187 current=http://127.0.0.1:4188

// Each target gets a fresh Chrome process. After the covered destination is
// fixed, the probe advances Three's NodeFrame and drives the shipping tick with
// dt=0, then waits for every submitted WebGPU frame. The zero delta freezes
// gameplay while the tick keeps the app's optional-world activity gate closed,
// so A/B/A still measures projection passes plus real scene shading.

import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { chromium } from "playwright-core"

const VIEWPORT = {
  width: Number(process.env.SF_W ?? 1280),
  height: Number(process.env.SF_H ?? 720)
}
const DPR = Number(process.env.SF_DPR ?? 1.5)
const WARM_FRAMES = Math.max(8, Number(process.env.SF_WARM ?? 20))
const MEASURE_FRAMES = Math.max(20, Number(process.env.SF_MEASURE ?? 60))
const WORLD = { x: 900, z: 2400, facing: 0.4 }

async function exists(path) {
  if (!path) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ]
  for (const candidate of candidates) if (await exists(candidate)) return candidate
  throw new Error("Chrome/Chromium not found; set CHROME_BIN")
}

function parseTargets() {
  const values = process.argv.slice(2)
  if (values.length === 0 && process.env.SF_PROBE_URL) {
    values.push(`${process.env.SF_PROBE_LABEL ?? "shadow"}=${process.env.SF_PROBE_URL}`)
  }
  if (values.length === 0) values.push("current=http://127.0.0.1:4188")
  return values.map((value) => {
    const split = value.indexOf("=")
    if (split <= 0) throw new Error(`Target must be label=url: ${value}`)
    return { label: value.slice(0, split), url: value.slice(split + 1).replace(/\/$/, "") }
  })
}

async function relocateThroughArrival(page, world) {
  const beforeGeneration = await page.evaluate(() => {
    const sf = window.__sf
    // Retain the coordinator's covered destination hold. The benchmark then
    // measures one proven scene instead of allowing the full optional draw ring
    // to begin at a wall-clock-dependent phase in each fresh browser.
    window.__shadowPerformanceArrivalFreeze = {
      originalResumeBackgroundStreaming: sf.tiles.resumeBackgroundStreaming.bind(sf.tiles)
    }
    sf.tiles.resumeBackgroundStreaming = () => {}
    return sf.worldArrival.snapshot.generation
  })
  await page.evaluate(({ x, z }) => {
    window.__sf.teleportToTarget(x, z, "shadow performance probe")
  }, world)
  await page.waitForFunction(
    ({ generation, x, z }) => {
      const sf = window.__sf
      const arrival = sf?.worldArrival?.snapshot
      return Boolean(
        arrival &&
        arrival.generation > generation &&
        arrival.state === "idle" &&
        !sf.player.worldArrivalHeld &&
        Math.hypot(sf.player.position.x - x, sf.player.position.z - z) < 250
      )
    },
    { generation: beforeGeneration, x: world.x, z: world.z },
    { timeout: 180_000 }
  )
  return page.evaluate(() => ({ ...window.__sf.worldArrival.snapshot }))
}

async function inspectDestinationTerrain(page, world) {
  return page.evaluate(({ x, z }) => {
    const sf = window.__sf
    const visibleInHierarchy = (object) => {
      for (let current = object; current; current = current.parent) {
        if (!current.visible) return false
      }
      return true
    }
    const roots = []
    for (const [name, root] of sf.tiles.terrain) {
      if (root.parent !== sf.scene || !visibleInHierarchy(root)) continue
      root.updateWorldMatrix(true, true)
      const box = new sf.THREE.Box3().setFromObject(root)
      if (
        box.isEmpty() ||
        x < box.min.x - 1 || x > box.max.x + 1 ||
        z < box.min.z - 1 || z > box.max.z + 1
      ) continue
      let renderableMeshes = 0
      let triangles = 0
      root.traverse((object) => {
        if (!object.isMesh || !visibleInHierarchy(object)) return
        const materials = Array.isArray(object.material) ? object.material : [object.material]
        if (!materials.some((material) => material?.visible !== false)) return
        const positionCount = object.geometry?.attributes?.position?.count ?? 0
        const indexCount = object.geometry?.index?.count ?? 0
        if (positionCount <= 0) return
        renderableMeshes++
        triangles += indexCount > 0 ? indexCount / 3 : positionCount / 3
      })
      roots.push({ name, renderableMeshes, triangles: Math.round(triangles) })
    }
    return {
      loaded: roots.some((root) => root.renderableMeshes > 0 && root.triangles > 0),
      roots,
      totalResidentRoots: sf.tiles.terrain.size,
      playerDistance: Math.hypot(sf.player.position.x - x, sf.player.position.z - z)
    }
  }, world)
}

async function inspectSceneState(page) {
  return page.evaluate(() => {
    const sf = window.__sf
    let meshes = 0
    let triangles = 0
    const meshGroups = new Map()
    sf.scene.traverseVisible((object) => {
      if (!object.isMesh) return
      const positionCount = object.geometry?.attributes?.position?.count ?? 0
      const indexCount = object.geometry?.index?.count ?? 0
      if (positionCount <= 0) return
      const objectTriangles = indexCount > 0 ? indexCount / 3 : positionCount / 3
      meshes++
      triangles += objectTriangles
      let owner = object.parent
      while (owner && !owner.name) owner = owner.parent
      const materials = Array.isArray(object.material) ? object.material : [object.material]
      const materialKey = materials
        .map((material) => material?.name || material?.type || "<none>")
        .join("+")
      const key = object.name || object.geometry?.name || [
        "<unnamed>",
        object.type,
        object.geometry?.type ?? "<no-geometry-type>",
        materialKey,
        `owner:${owner?.name || owner?.type || "<none>"}`,
        `order:${object.renderOrder}`,
        `userdata:${Object.keys(object.userData ?? {}).sort().join(",") || "<none>"}`
      ].join("|")
      const group = meshGroups.get(key) ?? { name: key, meshes: 0, triangles: 0 }
      group.meshes++
      group.triangles += objectTriangles
      meshGroups.set(key, group)
    })
    return {
      sceneSignature: `${meshes}:${Math.round(triangles)}`,
      meshGroups: [...meshGroups.values()]
        .map((group) => ({ ...group, triangles: Math.round(group.triangles) }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      renderIdle: sf.renderIdle?.() === true,
      tileBusy: Number(sf.tiles?.busy ?? Infinity),
      schedulerPending: Number(sf.scheduler?.pending ?? Infinity),
      schedulerWaiting: Number(sf.scheduler?.waiting ?? Infinity),
      atlasReady: sf.farOcclusion?.stats?.ready === true,
      atlasPending: sf.farOcclusion?.stats?.pending === true,
      atlasAvailability: Number(sf.farOcclusion?.stats?.availability ?? 0),
      atlasContentRevision: Number(sf.farOcclusion?.stats?.contentRevision ?? -1),
      atlasBuiltRevision: Number(sf.farOcclusion?.stats?.builtRevision ?? -2),
      shadowStaticRevision: Number(sf.sky?.sun?.shadow?.shadowNode?.staticRevision ?? -1)
    }
  })
}

async function advanceFrames(page, count) {
  await page.evaluate(async (frameCount) => {
    const sf = window.__sf
    for (let i = 0; i < frameCount; i++) {
      const nodeFrame = sf.renderer._nodes.nodeFrame
      nodeFrame.update()
      sf.renderer.info.frame = nodeFrame.frameId
      sf.tick(0)
    }
    await sf.renderer.backend.device.queue.onSubmittedWorkDone()
  }, count)
}

async function settleSteadyScene(page) {
  // Give destination tile finalization and worker-backed owners real wall time
  // before looking for a stable scene. Optional-world admission is held closed
  // below so unrelated constructors cannot enter at different A/B phases.
  // Let wall-clock-driven transient effects retire before collecting a scene
  // signature. Their dt=0 simulation does not advance, but some presentation
  // owners intentionally have real-time TTLs around ten seconds.
  for (let batch = 0; batch < 48; batch++) {
    await advanceFrames(page, 20)
    await page.waitForTimeout(250)
  }

  let previousSignature = ""
  let stableBatches = 0
  const recentStates = []
  for (let batch = 0; batch < 240; batch++) {
    await advanceFrames(page, 8)
    const state = await inspectSceneState(page)
    const atlasSettled =
      state.atlasReady &&
      !state.atlasPending &&
      state.atlasBuiltRevision >= state.atlasContentRevision &&
      state.atlasAvailability >= 0.995
    // renderIdle intentionally stays false while optional sites are queued
    // behind the synthetic activity hold. Required destination work is steady
    // when tile/scheduler queues have drained and the atlas owns its latest
    // content revision.
    const requiredSceneSettled =
      state.schedulerPending === 0 &&
      state.schedulerWaiting === 0
    const settled = requiredSceneSettled && atlasSettled
    const signature = [
      state.sceneSignature,
      state.tileBusy,
      state.shadowStaticRevision,
      state.atlasContentRevision
    ].join(":")
    if (settled && signature === previousSignature) stableBatches++
    else stableBatches = settled ? 1 : 0
    previousSignature = signature
    if (batch % 10 === 0 || batch >= 235) {
      recentStates.push({ batch, stableBatches, ...state })
      if (recentStates.length > 8) recentStates.shift()
    }
    if (stableBatches >= 20) return state
    await page.waitForTimeout(150)
  }
  throw new Error(`Steady shadow benchmark scene did not settle: ${JSON.stringify(recentStates)}`)
}

async function profileTarget(executablePath, target) {
  const errors = []
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: [
      "--enable-unsafe-webgpu",
      "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
      "--use-angle=metal",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--mute-audio"
    ]
  })
  try {
    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DPR })
    const page = await context.newPage()
    page.on("pageerror", (error) => errors.push(String(error)))
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text())
    })
    await page.goto(`${target.url}/?autostart=1&fullfps=1&profile=1`, {
      waitUntil: "domcontentloaded",
      timeout: 90_000
    })
    await page.waitForFunction(
      () => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player),
      null,
      { timeout: 180_000 }
    )
    await page.waitForFunction(() => window.__sf.renderIdle?.() === true, null, {
      timeout: 180_000
    })
    await page.waitForFunction(
      () => window.__sf.worldArrival?.snapshot?.state === "idle" && !window.__sf.player.worldArrivalHeld,
      null,
      { timeout: 180_000 }
    )
    const arrival = await relocateThroughArrival(page, WORLD)
    const terrain = await inspectDestinationTerrain(page, WORLD)
    if (!terrain.loaded) throw new Error("No visible, renderable terrain root covers the destination")
    if (terrain.playerDistance >= 250) throw new Error("Arrival committed somewhere other than the requested destination")
    await page.evaluate(({ viewport, dpr, world }) => {
      const sf = window.__sf
      window.__sfManual(true)
      sf.sky.cycleEnabled = false
      sf.sky.setTimeOfDay(10.5)
      sf.input.keys.clear()
      // Keep the app's own quiet-window admission gate closed while measuring.
      // A physical hold is visible to that gate, while the named suspension
      // prevents the synthetic key from moving the player or activating UI.
      sf.input.setSuspensionHold("shadow-performance-probe", true)
      sf.input.keys.add("KeyW")
      sf.POSTFX_TUNING.values.ink = false
      sf.POSTFX_TUNING.values.dream = false
      sf.POSTFX_TUNING.values.retro = false
      sf.POSTFX_TUNING.values.sceneSamples = 0
      sf.pipeline.applyPostFx()
      if (sf.dynRes) sf.dynRes.sample = () => {}
      sf.renderer.setPixelRatio(dpr)
      sf.renderer.setSize(viewport.width, viewport.height)
      // The covered arrival owns all cross-city streaming. Once its exact
      // destination terrain is proven resident, restore the historical fixed
      // benchmark pose/facing for comparable frame measurements.
      const y = sf.map.groundHeight(world.x, world.z)
      sf.player.teleportTo({
        x: world.x,
        y: y + 1.6,
        z: world.z,
        facing: world.facing,
        mode: "walk"
      })
      const csm = sf.sky.sun.shadow.shadowNode
      const originalSchedule = csm.schedule.bind(csm)
      const probeState = {
        focus: sf.player.renderPosition.clone(),
        sunDirection: new sf.THREE.Vector3(0, 1, 0),
        schedule: originalSchedule
      }
      csm.schedule = (focus, sunDirection, nowMs) => {
        probeState.focus.copy(focus)
        probeState.sunDirection.copy(sunDirection)
        originalSchedule(focus, sunDirection, nowMs)
      }
      window.__shadowPerformanceProbe = probeState
    }, { viewport: VIEWPORT, dpr: DPR, world: WORLD })

    const steadyScene = await settleSteadyScene(page)

    const phase = (shadowUpdates) => page.evaluate(async ({ shadowUpdates, warm, measure }) => {
      const sf = window.__sf
      const renderer = sf.renderer
      const device = renderer.backend.device
      renderer.shadowMap.enabled = shadowUpdates
      const frame = async () => {
        const nodeFrame = renderer._nodes.nodeFrame
        nodeFrame.update()
        renderer.info.frame = nodeFrame.frameId
        const start = performance.now()
        sf.tick(0)
        const encoded = performance.now()
        await device.queue.onSubmittedWorkDone()
        return [encoded - start, performance.now() - start]
      }
      for (let i = 0; i < warm; i++) await frame()
      const cpu = []
      const total = []
      for (let i = 0; i < measure; i++) {
        const sample = await frame()
        cpu.push(sample[0])
        total.push(sample[1])
      }
      const percentile = (values, p) => {
        values.sort((a, b) => a - b)
        return Number(values[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2))
      }
      renderer.info.autoReset = false
      renderer.info.reset()
      await frame()
      const info = {
        draws: renderer.info.render.drawCalls ?? renderer.info.render.calls ?? 0,
        triangles: renderer.info.render.triangles ?? 0
      }
      renderer.info.autoReset = true
      return {
        cpuP50: percentile(cpu, 0.5),
        cpuP90: percentile(cpu, 0.9),
        frameP50: percentile(total, 0.5),
        frameP90: percentile(total, 0.9),
        info
      }
    }, { shadowUpdates, warm: WARM_FRAMES, measure: MEASURE_FRAMES })

    const onA = await phase(true)
    const off = await phase(false)
    const onB = await phase(true)
    const diagnostics = await page.evaluate(() => {
      const sf = window.__sf
      return sf.sky.shadowDiagnostics?.snapshot?.() ?? null
    })
    const finalScene = await inspectSceneState(page)
    if (
      finalScene.sceneSignature !== steadyScene.sceneSignature ||
      finalScene.shadowStaticRevision !== steadyScene.shadowStaticRevision ||
      finalScene.atlasContentRevision !== steadyScene.atlasContentRevision
    ) {
      throw new Error(
        `Scene changed during measurement: ${JSON.stringify(steadyScene)} -> ${JSON.stringify(finalScene)}`
      )
    }
    return {
      label: target.label,
      url: target.url,
      arrival,
      terrain,
      steadyScene,
      finalScene,
      onA,
      off,
      onB,
      diagnostics,
      errors
    }
  } finally {
    await browser.close()
  }
}

const executablePath = await findChrome()
const results = []
for (const target of parseTargets()) {
  const result = await profileTarget(executablePath, target)
  results.push(result)
  const on = (result.onA.frameP50 + result.onB.frameP50) / 2
  const projection = on - result.off.frameP50
  console.log(
    `[shadow-perf:${result.label}] frame ${on.toFixed(2)}ms p50, ` +
    `projection updates ${projection >= 0 ? "+" : ""}${projection.toFixed(2)}ms, ` +
    `CPU ${(result.onA.cpuP50 + result.onB.cpuP50) / 2}ms, ` +
    `${result.onB.info.draws} draws / ${Math.round(result.onB.info.triangles)} tris`
  )
  if (result.diagnostics) {
    console.log(
      "  domains " + result.diagnostics.domains
        .map((domain) => `${domain.id}:${domain.updateHz.toFixed(1)}Hz/${(domain.texelMeters * 100).toFixed(1)}cm`)
        .join(" · ")
    )
  }
  if (result.errors.length) console.log(`  page errors: ${result.errors.slice(0, 3).join(" | ")}`)
}

if (results.some((result) => result.errors.length > 0)) process.exitCode = 1

if (process.env.SF_SHADOW_PERF_OUT) {
  const outputPath = path.resolve(process.env.SF_SHADOW_PERF_OUT)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(outputPath, `${JSON.stringify({
    viewport: VIEWPORT,
    dpr: DPR,
    warmFrames: WARM_FRAMES,
    measureFrames: MEASURE_FRAMES,
    results
  }, null, 2)}\n`)
}
