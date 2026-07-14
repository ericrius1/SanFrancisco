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

async function settle(page) {
  for (let batch = 0; batch < 36; batch++) {
    await renderFrames(page, 4, 1 / 60)
    const state = await page.evaluate(() => ({
      renderIdle: window.__sf.renderIdle?.() === true,
      ready: window.__sf.farOcclusion?.stats?.ready === true,
      availability: Number(window.__sf.farOcclusion?.stats?.availability ?? 0)
    }))
    if (state.renderIdle && state.ready && state.availability >= 0.98) return state
    await sleep(150)
  }
  return page.evaluate(() => ({
    renderIdle: window.__sf.renderIdle?.() === true,
    ready: window.__sf.farOcclusion?.stats?.ready === true,
    availability: Number(window.__sf.farOcclusion?.stats?.availability ?? 0)
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

async function capturePair(page, name, camera, focusShift) {
  const capture = async (suffix, shift) => {
    await page.evaluate(({ camera, shift }) => {
      const state = window.__shadowDomainProbe
      state.focus.set(state.base.x + shift[0], state.base.y, state.base.z + shift[1])
      window.__sfFreeCam(camera.eye, camera.target)
      window.__sf.camera.fov = camera.fov
      window.__sf.camera.near = 0.1
      window.__sf.camera.far = 6000
      window.__sf.camera.updateProjectionMatrix()
    }, { camera, shift })
    await renderFrames(page, 5)
    const bytes = await page.screenshot({ type: "png", animations: "disabled" })
    await writeFile(path.join(OUT, `${name}-${suffix}.png`), bytes)
    return bytes
  }

  const a = await capture("a", [0, 0])
  const b = await capture("b", focusShift)
  const comparison = comparePng(a, b)
  await writeFile(path.join(OUT, `${name}-diff-8x.png`), comparison.diff)
  return comparison.metrics
}

async function captureAtlasToggle(page, camera) {
  const capture = async (suffix, strength) => {
    await page.evaluate(async ({ camera, strength }) => {
      const sf = window.__sf
      const state = window.__shadowDomainProbe
      state.focus.set(state.base.x, state.base.y, state.base.z)
      window.__sfFreeCam(camera.eye, camera.target)
      sf.camera.fov = camera.fov
      sf.camera.updateProjectionMatrix()
      const tuning = (await import("/src/world/shadows/tuning.ts")).SHADOW_TUNING
      tuning.values.farFieldStrength = strength
      sf.sky.applyShadowParams()
    }, { camera, strength })
    await renderFrames(page, 5)
    const bytes = await page.screenshot({ type: "png", animations: "disabled" })
    await writeFile(path.join(OUT, `atlas-${suffix}.png`), bytes)
    return bytes
  }
  const on = await capture("on", 1)
  const off = await capture("off", 0)
  const comparison = comparePng(on, off)
  await writeFile(path.join(OUT, "atlas-diff-8x.png"), comparison.diff)
  return comparison.metrics
}

await mkdir(OUT, { recursive: true })
const pageErrors = []
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
  page.on("pageerror", (error) => pageErrors.push(String(error)))
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text())
  })
  await page.goto(`${BASE_URL}/?autostart=1&fullfps=1&profile=1`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000
  })
  await page.waitForFunction(
    () => Boolean(window.__sf?.renderer?.backend?.device && window.__sf?.player && window.__sfFreeCam),
    null,
    { timeout: 180_000 }
  )
  await page.evaluate(async ({ world, viewport }) => {
    const sf = window.__sf
    window.__sfManual(true)
    sf.sky.cycleEnabled = false
    sf.sky.setTimeOfDay(17.5)
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
    sf.player.teleportTo({ x: world.x, y: y + 1.6, z: world.z, facing: world.facing, mode: "walk" })
    for (const mesh of Object.values(sf.player.meshes)) mesh.visible = false
    const tuning = (await import("/src/world/shadows/tuning.ts")).SHADOW_TUNING
    tuning.values.heroStrength = 0
    tuning.values.localStrength = 1
    tuning.values.farStrength = 1
    tuning.values.farFieldStrength = 1
    sf.sky.applyShadowParams()
    const csm = sf.sky.sun.shadow.shadowNode
    const focus = new sf.THREE.Vector3(world.x, y + 1.6, world.z)
    const originalSchedule = csm.schedule.bind(csm)
    csm.schedule = (_focus, sunDirection, nowMs) => originalSchedule(focus, sunDirection, nowMs)
    window.__shadowDomainProbe = { base: { x: world.x, y: y + 1.6, z: world.z }, focus }
    const canvas = sf.renderer.domElement
    for (const element of document.body.querySelectorAll("*")) {
      if (element === canvas || element.contains(canvas)) continue
      element.style.visibility = "hidden"
    }
  }, { world: WORLD, viewport: VIEWPORT })

  const atlas = await settle(page)
  const base = await page.evaluate(() => window.__shadowDomainProbe.base)
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
  const result = { atlas, local: localMetrics, far: farMetrics, atlasToggle: atlasToggleMetrics, pageErrors }
  await writeFile(path.join(OUT, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  if (!atlas.ready || atlas.availability < 0.98) throw new Error("Far atlas did not become fully available")
  if (localMetrics.sourceStdDev < 5 || farMetrics.sourceStdDev < 5) throw new Error("Capture was visually empty")
  if (atlasToggleMetrics.changedFraction < 0.001) throw new Error("Atlas A/B did not exercise visible occlusion")
  if (localMetrics.changedFraction > 0.02 || localMetrics.mae > 1) {
    throw new Error("Local clipmap focus shift exposed a broad lighting discontinuity")
  }
  if (farMetrics.changedFraction > 0.01 || farMetrics.mae > 0.5) {
    throw new Error("Far clipmap focus shift exposed a broad lighting discontinuity")
  }
  if (pageErrors.length) throw new Error(`Page errors: ${pageErrors.slice(0, 3).join(" | ")}`)
} finally {
  await browser.close()
}
