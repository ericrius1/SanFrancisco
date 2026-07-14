// GPU-synchronized shadow runtime profile at one deterministic city location.
//
//   node tools/shadow-performance-probe.mjs label=http://127.0.0.1:4188
//   node tools/shadow-performance-probe.mjs baseline=http://127.0.0.1:4187 current=http://127.0.0.1:4188

// Each target gets a fresh Chrome process. The probe advances Three's NodeFrame
// manually so every-frame hero shadows really update, then reports an A/B/A of
// the shipping frame against projection-map updates disabled. This is not a
// synthetic shader microbenchmark: it drives the real app tick and waits for
// every submitted WebGPU frame.

import { access } from "node:fs/promises"
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
    await page.evaluate(({ viewport, dpr, world }) => {
      const sf = window.__sf
      window.__sfManual(true)
      sf.sky.cycleEnabled = false
      sf.sky.setTimeOfDay(10.5)
      sf.input.keys.clear()
      sf.POSTFX_TUNING.values.ink = false
      sf.POSTFX_TUNING.values.dream = false
      sf.POSTFX_TUNING.values.retro = false
      sf.pipeline.applyPostFx()
      sf.dynRes.sample = () => {}
      sf.renderer.setPixelRatio(dpr)
      sf.renderer.setSize(viewport.width, viewport.height)
      const y = sf.map.groundHeight(world.x, world.z)
      sf.player.teleportTo({ x: world.x, y: y + 1.6, z: world.z, facing: world.facing, mode: "walk" })
    }, { viewport: VIEWPORT, dpr: DPR, world: WORLD })

    // Give streamers real wall time as well as deterministic simulation time.
    for (let batch = 0; batch < 6; batch++) {
      await page.evaluate(async () => {
        const sf = window.__sf
        for (let i = 0; i < 20; i++) {
          const nodeFrame = sf.renderer._nodes.nodeFrame
          nodeFrame.update()
          sf.renderer.info.frame = nodeFrame.frameId
          sf.tick(1 / 60)
        }
        await sf.renderer.backend.device.queue.onSubmittedWorkDone()
      })
      await page.waitForTimeout(200)
    }

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
        sf.tick(1 / 60)
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
    return { label: target.label, url: target.url, onA, off, onB, diagnostics, errors }
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
