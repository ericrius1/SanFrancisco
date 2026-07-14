// Fixed-scene WebGPU capture for player-centric shadow-domain stability.
// The camera, scene, streaming focus, and clock remain fixed while only the
// clipmap projection focus moves. Large raster/atlas or local/far seams then
// appear directly in the A/B difference instead of being hidden by gameplay.

import { access, mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { PNG } from "pngjs"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUT = path.resolve(ROOT, process.env.SF_SHADOW_DOMAIN_OUT ?? ".data/shadow-domain-continuity")
const BASE_URL = (process.env.SF_PROBE_URL ?? "http://127.0.0.1:5240").replace(/\/$/, "")
const VIEWPORT = { width: 1280, height: 800 }
const WORLD = { x: -2248.8, z: 2187.2, facing: Math.PI }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function relocateThroughArrival(page, world) {
  const beforeGeneration = await page.evaluate(() => {
    const sf = window.__sf
    // Keep this a genuinely covered destination prime, then retain its
    // required-only hold so unrelated full-ring streaming cannot mutate the
    // supposedly fixed scene between A/B captures.
    window.__shadowArrivalFreeze = {
      originalResumeBackgroundStreaming: sf.tiles.resumeBackgroundStreaming.bind(sf.tiles)
    }
    sf.tiles.resumeBackgroundStreaming = () => {}
    return sf.worldArrival.snapshot.generation
  })
  await page.evaluate(({ x, z }) => {
    window.__sf.teleportToTarget(x, z, "shadow continuity probe")
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
      roots.push({
        name,
        renderableMeshes,
        triangles: Math.round(triangles),
        bounds: {
          min: [box.min.x, box.min.y, box.min.z],
          max: [box.max.x, box.max.y, box.max.z]
        }
      })
    }
    return {
      loaded: roots.some((root) => root.renderableMeshes > 0 && root.triangles > 0),
      roots,
      totalResidentRoots: sf.tiles.terrain.size,
      playerDistance: Math.hypot(sf.player.position.x - x, sf.player.position.z - z)
    }
  }, world)
}

async function exists(file) {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
}

async function findChrome() {
  for (const file of [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium"
  ].filter(Boolean)) {
    if (await exists(file)) return file
  }
  throw new Error("Chrome/Chromium not found; set CHROME_BIN")
}

async function renderFrames(page, count, dt = 0) {
  for (let i = 0; i < count; i++) {
    await page.evaluate(async (frameDt) => {
      const sf = window.__sf
      const nodeFrame = sf.renderer._nodes.nodeFrame
      nodeFrame.update()
      sf.renderer.info.frame = nodeFrame.frameId
      sf.tick(frameDt)
      await sf.renderer.backend.device.queue.onSubmittedWorkDone()
    }, dt)
  }
}

async function renderFixedFrames(page, count) {
  for (let i = 0; i < count; i++) {
    await page.evaluate(async () => {
      const sf = window.__sf
      const state = window.__shadowDomainProbe
      const nodeFrame = sf.renderer._nodes.nodeFrame
      nodeFrame.update()
      sf.renderer.info.frame = nodeFrame.frameId
      state.schedule(state.focus, state.sunDirection, performance.now())
      sf.pipeline.render()
      await sf.renderer.backend.device.queue.onSubmittedWorkDone()
    })
  }
}

async function settle(page) {
  let previousSignature = ""
  let stableBatches = 0
  for (let batch = 0; batch < 120; batch++) {
    // A zero delta still drains required schedulers and renders the real frame,
    // but it cannot spawn/despawn simulation-time effects. The synthetic input
    // hold is observed on every tick, keeping optional admission postponed.
    await renderFrames(page, 4, 0)
    const state = await page.evaluate(() => ({
      renderIdle: window.__sf.renderIdle?.() === true,
      tileBusy: Number(window.__sf.tiles?.busy ?? Infinity),
      schedulerPending: Number(window.__sf.scheduler?.pending ?? Infinity),
      schedulerWaiting: Number(window.__sf.scheduler?.waiting ?? Infinity),
      ready: window.__sf.farOcclusion?.stats?.ready === true,
      pending: window.__sf.farOcclusion?.stats?.pending === true,
      availability: Number(window.__sf.farOcclusion?.stats?.availability ?? 0),
      width: Number(window.__sf.farOcclusion?.stats?.width ?? 0),
      height: Number(window.__sf.farOcclusion?.stats?.height ?? 0),
      texelSize: Number(window.__sf.farOcclusion?.stats?.texelSize ?? 0),
      gpuBytes: Number(window.__sf.farOcclusion?.stats?.gpuBytes ?? 0),
      contentRevision: Number(window.__sf.farOcclusion?.stats?.contentRevision ?? -1),
      builtRevision: Number(window.__sf.farOcclusion?.stats?.builtRevision ?? -2),
      shadowStaticRevision: Number(
        window.__sf.sky?.sun?.shadow?.shadowNode?.staticRevision ?? -1
      ),
      sceneSignature: (() => {
        let meshes = 0
        let triangles = 0
        window.__sf.scene.traverseVisible((object) => {
          if (!object.isMesh) return
          const positionCount = object.geometry?.attributes?.position?.count ?? 0
          const indexCount = object.geometry?.index?.count ?? 0
          if (positionCount <= 0) return
          meshes++
          triangles += indexCount > 0 ? indexCount / 3 : positionCount / 3
        })
        return `${meshes}:${Math.round(triangles)}`
      })()
    }))
    const signature = `${state.sceneSignature}:${state.tileBusy}:${state.shadowStaticRevision}`
    // renderIdle remains false while optional sites are intentionally queued
    // behind the probe's synthetic activity hold. The covered destination is
    // fixed once its scheduler is empty and the world-locked atlas has caught
    // the latest required-scene revision.
    const fullySettled =
      state.schedulerPending === 0 &&
      state.schedulerWaiting === 0 &&
      state.ready &&
      !state.pending &&
      state.builtRevision >= state.contentRevision &&
      state.availability >= 0.995
    if (fullySettled && signature === previousSignature) stableBatches++
    else stableBatches = fullySettled ? 1 : 0
    previousSignature = signature
    if (stableBatches >= 12) return { ...state, settled: true }
    await sleep(150)
  }
  return page.evaluate(() => ({
    settled: false,
    renderIdle: window.__sf.renderIdle?.() === true,
    tileBusy: Number(window.__sf.tiles?.busy ?? Infinity),
    schedulerPending: Number(window.__sf.scheduler?.pending ?? Infinity),
    schedulerWaiting: Number(window.__sf.scheduler?.waiting ?? Infinity),
    ready: window.__sf.farOcclusion?.stats?.ready === true,
    pending: window.__sf.farOcclusion?.stats?.pending === true,
    availability: Number(window.__sf.farOcclusion?.stats?.availability ?? 0),
    width: Number(window.__sf.farOcclusion?.stats?.width ?? 0),
    height: Number(window.__sf.farOcclusion?.stats?.height ?? 0),
    texelSize: Number(window.__sf.farOcclusion?.stats?.texelSize ?? 0),
    gpuBytes: Number(window.__sf.farOcclusion?.stats?.gpuBytes ?? 0),
    contentRevision: Number(window.__sf.farOcclusion?.stats?.contentRevision ?? -1),
    builtRevision: Number(window.__sf.farOcclusion?.stats?.builtRevision ?? -2)
  }))
}

function comparePng(aBytes, bBytes) {
  const a = PNG.sync.read(aBytes)
  const b = PNG.sync.read(bBytes)
  if (a.width !== b.width || a.height !== b.height) throw new Error("Capture dimensions differ")
  const diff = new PNG({ width: a.width, height: a.height })
  let absolute = 0
  let changed = 0
  let mean = 0
  let meanSquare = 0
  const pixels = a.width * a.height
  for (let i = 0; i < a.data.length; i += 4) {
    const ar = a.data[i]
    const ag = a.data[i + 1]
    const ab = a.data[i + 2]
    const br = b.data[i]
    const bg = b.data[i + 1]
    const bb = b.data[i + 2]
    const delta = (Math.abs(ar - br) + Math.abs(ag - bg) + Math.abs(ab - bb)) / 3
    absolute += delta
    if (delta > 4) changed++
    const luminance = (ar + ag + ab) / 3
    mean += luminance
    meanSquare += luminance * luminance
    const amplified = Math.min(255, Math.round(delta * 8))
    diff.data[i] = amplified
    diff.data[i + 1] = amplified
    diff.data[i + 2] = amplified
    diff.data[i + 3] = 255
  }
  mean /= pixels
  return {
    diff: PNG.sync.write(diff),
    metrics: {
      mae: absolute / pixels,
      changedFraction: changed / pixels,
      sourceStdDev: Math.sqrt(Math.max(0, meanSquare / pixels - mean * mean))
    }
  }
}

function inspectTerrainRoi(bytes) {
  const png = PNG.sync.read(bytes)
  const minX = Math.floor(png.width * 0.2)
  const maxX = Math.ceil(png.width * 0.8)
  const minY = Math.floor(png.height * 0.35)
  const maxY = Math.ceil(png.height * 0.9)
  let count = 0
  let nonBlack = 0
  let mean = 0
  let meanSquare = 0
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      const offset = (y * png.width + x) * 4
      const luminance = (
        png.data[offset] * 0.2126 +
        png.data[offset + 1] * 0.7152 +
        png.data[offset + 2] * 0.0722
      )
      count++
      if (luminance > 12) nonBlack++
      mean += luminance
      meanSquare += luminance * luminance
    }
  }
  mean /= count
  return {
    bounds: { minX, minY, maxX, maxY },
    nonBlackFraction: nonBlack / count,
    meanLuminance: mean,
    luminanceStdDev: Math.sqrt(Math.max(0, meanSquare / count - mean * mean))
  }
}

async function captureTerrainReadiness(page, base) {
  await page.evaluate((terrainBase) => {
    const camera = window.__sf.camera
    camera.position.set(terrainBase.x - 38, terrainBase.y + 48, terrainBase.z + 42)
    camera.up.set(0, 1, 0)
    camera.lookAt(terrainBase.x, terrainBase.y - 1, terrainBase.z)
    camera.fov = 55
    camera.near = 0.1
    camera.far = 6000
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld()
  }, base)
  await renderFixedFrames(page, 5)
  const bytes = await page.screenshot({ type: "png", animations: "disabled" })
  await writeFile(path.join(OUT, "destination-terrain.png"), bytes)
  return inspectTerrainRoi(bytes)
}

async function captureGroundView(page, base) {
  await page.evaluate((terrainBase) => {
    const sf = window.__sf
    const targetX = -2298
    const targetZ = 2182
    const targetY = sf.map.groundHeight(targetX, targetZ) + 2
    sf.camera.position.set(terrainBase.x + 6, terrainBase.y + 1.4, terrainBase.z + 8)
    sf.camera.up.set(0, 1, 0)
    sf.camera.lookAt(targetX, targetY, targetZ)
    sf.camera.fov = 60
    sf.camera.near = 0.1
    sf.camera.far = 6000
    sf.camera.updateProjectionMatrix()
    sf.camera.updateMatrixWorld()
  }, base)
  await renderFixedFrames(page, 5)
  const bytes = await page.screenshot({ type: "png", animations: "disabled" })
  await writeFile(path.join(OUT, "ground-view.png"), bytes)
}

async function capturePair(page, name, camera, focusShift) {
  // Camera changes can wake required proxy/LOD promises even after the covered
  // destination itself is settled. Drain zero-delta ticks while holding this
  // exact view, then require wall-clock stability before the A/B/A begins.
  let previousSignature = ""
  let stableBatches = 0
  for (let batch = 0; batch < 80; batch++) {
    const signature = await page.evaluate(async ({ camera }) => {
      const sf = window.__sf
      const state = window.__shadowDomainProbe
      sf.tick(0)
      state.focus.set(state.base.x, state.base.y, state.base.z)
      sf.camera.position.fromArray(camera.eye)
      sf.camera.up.set(0, 1, 0)
      sf.camera.lookAt(...camera.target)
      sf.camera.fov = camera.fov
      sf.camera.near = 0.1
      sf.camera.far = 6000
      sf.camera.updateProjectionMatrix()
      sf.camera.updateMatrixWorld()
      const nodeFrame = sf.renderer._nodes.nodeFrame
      nodeFrame.update()
      sf.renderer.info.frame = nodeFrame.frameId
      state.schedule(state.focus, state.sunDirection, performance.now())
      sf.pipeline.render()
      await sf.renderer.backend.device.queue.onSubmittedWorkDone()
      let meshes = 0
      let triangles = 0
      sf.scene.traverseVisible((object) => {
        if (!object.isMesh) return
        const positionCount = object.geometry?.attributes?.position?.count ?? 0
        const indexCount = object.geometry?.index?.count ?? 0
        if (positionCount <= 0) return
        meshes++
        triangles += indexCount > 0 ? indexCount / 3 : positionCount / 3
      })
      return [
        meshes,
        Math.round(triangles),
        sf.sky.sun.shadow.shadowNode.staticRevision,
        sf.farOcclusion.stats.contentRevision,
        sf.farOcclusion.stats.builtRevision
      ].join(":")
    }, { camera })
    if (signature === previousSignature) stableBatches++
    else stableBatches = 1
    previousSignature = signature
    if (stableBatches >= 12) break
    await sleep(100)
    if (batch === 79) throw new Error(`${name} camera scene did not settle`)
  }

  const capture = async (suffix, shift) => {
    await page.evaluate(({ camera, shift }) => {
      const state = window.__shadowDomainProbe
      state.focus.set(state.base.x + shift[0], state.base.y, state.base.z + shift[1])
      const liveCamera = window.__sf.camera
      liveCamera.position.fromArray(camera.eye)
      liveCamera.up.set(0, 1, 0)
      liveCamera.lookAt(...camera.target)
      liveCamera.fov = camera.fov
      liveCamera.near = 0.1
      liveCamera.far = 6000
      liveCamera.updateProjectionMatrix()
      liveCamera.updateMatrixWorld()
    }, { camera, shift })
    await renderFixedFrames(page, 5)
    const bytes = await page.screenshot({ type: "png", animations: "disabled" })
    await writeFile(path.join(OUT, `${name}-${suffix}.png`), bytes)
    const fixedState = await page.evaluate(() => {
      const sf = window.__sf
      let meshes = 0
      let triangles = 0
      sf.scene.traverseVisible((object) => {
        if (!object.isMesh) return
        const positionCount = object.geometry?.attributes?.position?.count ?? 0
        const indexCount = object.geometry?.index?.count ?? 0
        if (positionCount <= 0) return
        meshes++
        triangles += indexCount > 0 ? indexCount / 3 : positionCount / 3
      })
      return {
        sceneSignature: `${meshes}:${Math.round(triangles)}`,
        tileBusy: Number(sf.tiles.busy),
        shadowStaticRevision: Number(sf.sky.sun.shadow.shadowNode.staticRevision),
        atlasContentRevision: Number(sf.farOcclusion.stats.contentRevision),
        atlasBuiltRevision: Number(sf.farOcclusion.stats.builtRevision),
        atlasAvailability: Number(sf.farOcclusion.stats.availability)
      }
    })
    return { bytes, fixedState }
  }

  const a = await capture("a", [0, 0])
  const b = await capture("b", focusShift)
  const a2 = await capture("a2", [0, 0])
  const comparison = comparePng(a2.bytes, b.bytes)
  const drift = comparePng(a.bytes, a2.bytes)
  await writeFile(path.join(OUT, `${name}-diff-8x.png`), comparison.diff)
  await writeFile(path.join(OUT, `${name}-drift-8x.png`), drift.diff)
  return {
    ...comparison.metrics,
    drift: drift.metrics,
    fixedStates: { a: a.fixedState, b: b.fixedState, a2: a2.fixedState }
  }
}

async function captureAtlasToggle(page, camera) {
  const capture = async (suffix, enabled) => {
    await page.evaluate(({ camera, enabled }) => {
      const sf = window.__sf
      const state = window.__shadowDomainProbe
      state.focus.set(state.base.x, state.base.y, state.base.z)
      sf.camera.position.fromArray(camera.eye)
      sf.camera.up.set(0, 1, 0)
      sf.camera.lookAt(...camera.target)
      sf.camera.fov = camera.fov
      sf.camera.updateProjectionMatrix()
      sf.camera.updateMatrixWorld()
      state.originalFarOcclusionUpdate ??= sf.farOcclusion.update.bind(sf.farOcclusion)
      if (enabled) {
        sf.farOcclusion.update = state.originalFarOcclusionUpdate
      } else {
        state.neutralAtlasSun ??= new sf.THREE.Vector3(1, 0, 0)
        sf.farOcclusion.update = (_sunDirection, focus, nowMs) => {
          state.originalFarOcclusionUpdate(state.neutralAtlasSun, focus, nowMs)
        }
      }
    }, { camera, enabled })
    if (!enabled) {
      for (let i = 0; i < 14; i++) {
        await sleep(100)
        await renderFixedFrames(page, 1)
      }
    }
    await renderFixedFrames(page, 5)
    const bytes = await page.screenshot({ type: "png", animations: "disabled" })
    await writeFile(path.join(OUT, `atlas-${suffix}.png`), bytes)
    return {
      bytes,
      availability: await page.evaluate(() => Number(window.__sf.farOcclusion.stats.availability))
    }
  }
  const on = await capture("on", true)
  const off = await capture("off", false)
  const comparison = comparePng(on.bytes, off.bytes)
  await writeFile(path.join(OUT, "atlas-diff-8x.png"), comparison.diff)
  await page.evaluate(() => {
    const sf = window.__sf
    const state = window.__shadowDomainProbe
    sf.farOcclusion.update = state.originalFarOcclusionUpdate
  })
  await renderFixedFrames(page, 2)
  return {
    ...comparison.metrics,
    onAvailability: on.availability,
    offAvailability: off.availability
  }
}

await mkdir(OUT, { recursive: true })
const rawPageErrors = []
const httpFailures = []
const requestFailures = []
const isPreviewWebSocketUrl = (value) => {
  try {
    return new URL(value).pathname === "/ws"
  } catch {
    return false
  }
}
const browser = await chromium.launch({
  executablePath: await findChrome(),
  headless: true,
  args: [
    "--enable-unsafe-webgpu",
    "--enable-features=WebGPUDeveloperFeatures,SharedArrayBuffer",
    `--use-angle=${process.platform === "darwin" ? "metal" : "swiftshader"}`,
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--mute-audio"
  ]
})

try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 })
  const page = await context.newPage()
  page.on("pageerror", (error) => rawPageErrors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error") rawPageErrors.push(message.text())
  })
  page.on("response", (response) => {
    if (response.status() >= 400 && !isPreviewWebSocketUrl(response.url())) {
      httpFailures.push(`${response.status()} ${response.url()}`)
    }
  })
  page.on("requestfailed", (request) => {
    if (!isPreviewWebSocketUrl(request.url())) {
      requestFailures.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`)
    }
  })
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000
  })
  console.log("[shadow-continuity] page loaded; waiting for initial world")
  await page.waitForFunction(
    () => Boolean(
      window.__sf?.renderer?.backend?.device &&
      window.__sf?.player &&
      window.__sfFreeCam &&
      window.__sf?.worldArrival?.snapshot?.state === "idle" &&
      !window.__sf.player.worldArrivalHeld
    ),
    null,
    { timeout: 180_000 }
  )
  console.log("[shadow-continuity] initial world interactive; starting covered relocation")
  const arrival = await relocateThroughArrival(page, WORLD)
  const terrain = await inspectDestinationTerrain(page, WORLD)
  console.log(
    `[shadow-continuity] arrival generation ${arrival.generation} idle; ` +
    `${terrain.roots.length} covering terrain root(s)`
  )
  await page.evaluate(({ world, viewport }) => {
    const sf = window.__sf
    window.__sfManual(true)
    sf.sky.cycleEnabled = false
    sf.sky.setTimeOfDay(17.5)
    // Exercise one covered destination in isolation. A synthetic physical hold
    // continually postpones optional-world admission; the named suspension
    // keeps that key from moving the player or triggering gameplay.
    sf.input.setSuspensionHold("shadow-domain-continuity-probe", true)
    sf.input.keys.add("KeyW")
    sf.POSTFX_TUNING.values.ink = false
    sf.POSTFX_TUNING.values.dream = false
    sf.POSTFX_TUNING.values.retro = false
    sf.POSTFX_TUNING.values.sceneSamples = 0
    sf.pipeline.applyPostFx()
    sf.WORLD_TUNING.values.fogEnabled = false
    sf.sky.applyFogParams()
    sf.renderer.setPixelRatio(1)
    sf.renderer.setSize(viewport.width, viewport.height)
    const y = sf.map.groundHeight(world.x, world.z)
    for (const mesh of Object.values(sf.player.meshes)) mesh.visible = false
    const csm = sf.sky.sun.shadow.shadowNode
    csm.lights[0].shadow.intensity = 0
    csm.lights[1].shadow.intensity = 1
    csm.lights[2].shadow.intensity = 1
    const focus = new sf.THREE.Vector3(world.x, y + 1.6, world.z)
    const originalSchedule = csm.schedule.bind(csm)
    const probeState = {
      base: { x: world.x, y: y + 1.6, z: world.z },
      focus,
      schedule: originalSchedule,
      sunDirection: new sf.THREE.Vector3(0, 1, 0)
    }
    csm.schedule = (_focus, sunDirection, nowMs) => {
      probeState.sunDirection.copy(sunDirection)
      originalSchedule(focus, sunDirection, nowMs)
    }
    window.__shadowDomainProbe = probeState
    const canvas = sf.renderer.domElement
    for (const element of document.body.querySelectorAll("*")) {
      if (element === canvas || element.contains(canvas)) continue
      element.style.visibility = "hidden"
    }
  }, { world: WORLD, viewport: VIEWPORT })

  const atlas = await settle(page)
  console.log("[shadow-continuity] fixed scene settled; capturing domains")
  const base = await page.evaluate(() => window.__shadowDomainProbe.base)
  await captureGroundView(page, base)
  const terrainRoi = await captureTerrainReadiness(page, base)
  const localMetrics = await capturePair(page, "local", {
    eye: [base.x - 95, base.y + 125, base.z + 155],
    target: [base.x, base.y - 2, base.z],
    fov: 64
  }, [8, 0])
  const farCamera = {
    eye: [base.x - 360, base.y + 720, base.z + 620],
    target: [base.x, base.y - 5, base.z],
    fov: 72
  }
  const farMetrics = await capturePair(page, "far", farCamera, [64, 0])
  const atlasToggleMetrics = await captureAtlasToggle(page, farCamera)
  const hasExpectedPreviewWebSocketFailure = rawPageErrors.some((error) =>
    error.includes("WebSocket connection to") && error.includes("/ws")
  )
  const ignoredPreviewNetworkErrors = rawPageErrors.filter((error) =>
    (error.includes("WebSocket connection to") && error.includes("/ws")) ||
    (
      hasExpectedPreviewWebSocketFailure &&
      error === "Failed to load resource: the server responded with a status of 500 (Internal Server Error)"
    )
  )
  const pageErrors = rawPageErrors.filter((error) => !ignoredPreviewNetworkErrors.includes(error))
  const result = {
    arrival,
    terrain,
    terrainRoi,
    atlas,
    local: localMetrics,
    far: farMetrics,
    atlasToggle: atlasToggleMetrics,
    pageErrors,
    httpFailures,
    requestFailures,
    ignoredPreviewNetworkErrors
  }
  await writeFile(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  const assertFixedStates = (name, states) => {
    const keys = [
      "sceneSignature",
      "shadowStaticRevision",
      "atlasContentRevision",
      "atlasBuiltRevision"
    ]
    for (const key of keys) {
      if (states.a[key] !== states.b[key] || states.a[key] !== states.a2[key]) {
        throw new Error(
          `${name} A/B/A scene changed at ${key}: ` +
          `${states.a[key]} -> ${states.b[key]} -> ${states.a2[key]}`
        )
      }
    }
  }
  assertFixedStates("Local", localMetrics.fixedStates)
  assertFixedStates("Far", farMetrics.fixedStates)
  if (arrival.state !== "idle" || arrival.active) throw new Error("Destination arrival did not settle to idle")
  if (!terrain.loaded) throw new Error("No visible, renderable terrain root covers the destination")
  if (terrain.playerDistance >= 250) throw new Error("Arrival committed somewhere other than the requested destination")
  if (terrainRoi.nonBlackFraction < 0.85 || terrainRoi.meanLuminance < 15) {
    throw new Error("Destination terrain readiness capture contains a black ground ROI")
  }
  if (
    !atlas.settled ||
    !atlas.ready ||
    atlas.pending ||
    atlas.builtRevision < atlas.contentRevision ||
    atlas.availability < 0.995
  ) throw new Error("Far atlas or destination stream did not become fully available")
  if (
    atlas.width !== 944 ||
    atlas.height !== 868 ||
    atlas.texelSize !== 16 ||
    atlas.gpuBytes !== 3_277_568
  ) {
    throw new Error(
      `Far atlas is not the 16 m production field: ` +
      `${atlas.width}x${atlas.height} @ ${atlas.texelSize} m / ${atlas.gpuBytes} bytes`
    )
  }
  if (localMetrics.sourceStdDev < 5 || farMetrics.sourceStdDev < 5) throw new Error("Capture was visually empty")
  if (localMetrics.drift.changedFraction > 0.015 || localMetrics.drift.mae > 0.5) {
    throw new Error("Local focus A/B/A control detected scene drift")
  }
  if (farMetrics.drift.changedFraction > 0.015 || farMetrics.drift.mae > 0.5) {
    throw new Error("Far focus A/B/A control detected scene drift")
  }
  if (atlasToggleMetrics.changedFraction < 0.001) throw new Error("Atlas A/B did not exercise visible occlusion")
  if (atlasToggleMetrics.onAvailability < 0.995 || atlasToggleMetrics.offAvailability > 0.02) {
    throw new Error("Atlas A/B did not reach its on/off availability endpoints")
  }
  if (localMetrics.changedFraction > 0.02 || localMetrics.mae > 1) {
    throw new Error("Local clipmap focus shift exposed a broad lighting discontinuity")
  }
  if (farMetrics.changedFraction > 0.01 || farMetrics.mae > 0.5) {
    throw new Error("Far clipmap focus shift exposed a broad lighting discontinuity")
  }
  if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.slice(0, 3).join(" | ")}`)
  if (httpFailures.length) throw new Error(`HTTP failures: ${httpFailures.slice(0, 3).join(" | ")}`)
  if (requestFailures.length) throw new Error(`Request failures: ${requestFailures.slice(0, 3).join(" | ")}`)
} finally {
  await browser.close()
}
