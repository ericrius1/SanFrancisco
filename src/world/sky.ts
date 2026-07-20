import * as THREE from "three/webgpu"
import {
  Fn,
  abs,
  cameraPosition,
  color,
  densityFogFactor,
  dot,
  float,
  floor,
  fog as tslFog,
  fract,
  hash,
  mix,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  time,
  triNoise3D,
  uniform,
  vec3
} from "three/tsl"
import { CROWN_INTENSITY } from "./salesforceCrown"
import { WINDOW_GLOW_W } from "./facade"
import { BAY_LIGHTS_INTENSITY } from "./bayLights"
import {
  GOLDEN_GATE_LIGHTS_INTENSITY,
  GOLDEN_GATE_LIGHTS_SLIDERS
} from "./goldenGateLights"
import { SUTRO_LIGHTS_INTENSITY } from "./sutroTower"
import { CAR_HEADLIGHT_INTENSITY } from "../vehicles/car/lights"
import { BUENA_VISTA_MIST, BUENA_VISTA_SUMMIT_CLEARING } from "./buenaVista"
import { EXPOSURE_REBASE, LIGHT_SCALE, WORLD_TUNING } from "../config"
import { tunables } from "../core/persist"
import {
  ClipmapShadowNode,
  CLIPMAP_SHADOW_CONFIG,
  type StaticShadowScope
} from "./shadows/clipmapShadowNode"
import type { FarOcclusionField } from "./shadows/farOcclusionField"
import {
  sanFranciscoCivilNow,
  sanFranciscoTimeOfDay,
  sfCivilFromScalarDays,
  sfCivilScalarDays,
  sfUtcOffsetHours,
  solarPosition,
  type SfCivilTime
} from "./solar"
import {
  blendFogWeather,
  effectiveLiveWeight,
  sampleProceduralFog,
  type FogWeatherMode,
  type FogWeatherState,
  type LiveFogBias
} from "./fogWeather"
import type { LiveFogFeedMeta } from "./liveFog"

export { sanFranciscoTimeOfDay }

// Fallback hour used only before the first real-time read lands (warm pre-sunset).
// The default sky follows the real SF clock (see sanFranciscoTimeOfDay / followRealTime).
export const PRE_SUNSET_TIME = 15.48

// Day/night cycle tuning, bound in the "/" panel's lighting folder (persisted).
// timeOfDay: hours 0..24 on the current SF calendar date — the sun follows the
// real astronomical path for that day (seasonal elevation + azimuth), not a
// stylized arc. dayCycleSeconds: when not following real SF time, wall-clock
// seconds for one full in-game 24h lap (30s..30min). Real time itself is the
// "follow real SF time" checkbox.
export const SKY_TUNING = tunables("sky", {
  timeOfDay: { v: 18.48, min: 0, max: 24, step: 0.01, label: "time of day" },
  // default: mirror the real SF wall clock. Scrubbing (Z), dragging the time
  // slider, or unchecking this starts the local day cycle — personal override.
  realTime: { v: true, label: "follow real SF time" },
  dayCycleSeconds: {
    v: 1800,
    min: 30,
    max: 30 * 60,
    step: 5,
    label: "24h cycle length",
    format: (v: number) => (v < 60 ? `${Math.round(v)}s` : `${(v / 60).toFixed(v % 60 === 0 ? 0 : 1)} min`)
  },
  // scales the low-sun/night fill (moon key, hemi fill, sky/IBL night palette,
  // moon disc) so full dark and late twilight stay readable; 1 = authored look
  nightBrightness: {
    v: 1.55,
    min: 0.4,
    max: 2.5,
    step: 0.05,
    label: "night brightness"
  },
  // --- day grade: how much light the daytime scene actually receives. The
  // renderer exposure (RENDER_TUNING, anchored at 1.0) is the FIXED global
  // anchor — night, emissives (LIGHT_SCALE) and the sky dome are all balanced
  // against it — so where daylight lands on the ACES curve is set HERE, not
  // with the exposure slider. At the historical rig (sun 13, fill 1.8 in
  // today's units) the sunlit 18% grey card measured ~+2 stops above
  // photographic neutral: everything over ~30% albedo mashed together on the
  // ACES shoulder (the washed pastel noon, dead exposure slider). 3.6/0.9
  // lands the grey card ~+0.8 stop — still a sunny grade, but with real tonal
  // separation. Referee: "/" grey cards + tools/calibration-probe.mjs.
  sunDay: { v: 3.6, min: 0.6, max: 16, step: 0.1, label: "sun strength" },
  hemiDay: { v: 0.9, min: 0, max: 2.6, step: 0.05, label: "day sky fill" }
})

// The dome/IBL counter-boost: authored 0..1 sky colours were graded to read
// as-authored under the reference exposure (7 ≈ 1/0.13 pre-rebase, carried
// through the exposure re-anchor so the dome renders identically).
const SKY_DOME_BOOST = 7.0 * EXPOSURE_REBASE

// Live light direction (world space, pointing toward the dominant light — the sun
// by day, the moon by night). Mutated by Sky; other modules (water) hold a
// reference and read it every frame.
export const SUN_DIR = new THREE.Vector3(-0.52, 0.42, -0.28).normalize()
const WARM_SUN = new THREE.Color(0xfff4e8) // midday sun tint, lerped toward as it climbs

// TSL node generics fight composition; any is the idiom here (see facade.ts)
type N = any

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

// three-way palette blend for the JS-side lights (shader does its own)
const blend3 = (() => {
  const tmp = new THREE.Color()
  return (
    out: THREE.Color,
    day: THREE.Color,
    gold: THREE.Color,
    night: THREE.Color,
    dw: number,
    gw: number,
    nw: number
  ) => {
    out.copy(day).multiplyScalar(dw)
    out.add(tmp.copy(gold).multiplyScalar(gw))
    out.add(tmp.copy(night).multiplyScalar(nw))
    return out
  }
})()

const PALETTE = {
  hemiSky: {
    day: new THREE.Color(0xa9c4d9),
    gold: new THREE.Color(0x8087a8),
    night: new THREE.Color(0x3a4f7e)
  },
  hemiGround: {
    day: new THREE.Color(0x9c8468),
    gold: new THREE.Color(0x4a3f42),
    night: new THREE.Color(0x30364a)
  }
}

// ---------------------------------------------------------------------------
// Fog constants. The five expressive controls (height, density, billow, motion,
// haze) live in WORLD_TUNING; everything below is the fixed r185 reference shape
// plus the two accommodations a streamed open world needs: path accumulation for
// a playable camera inside the layer, and a very short fade at the cull edge.
// ---------------------------------------------------------------------------
// This is the official example's pale near-white in working colour space. It is
// intentionally passed through `color()` directly: multiplying it by the scene's
// exposure-rebase constant was the bug that made the old bank charcoal grey.
const FOG_COLOR = 0xd0dee7
const FOG_BASE = -20 // official bank floor, in world metres
const FOG_NOISE_SCALE_A = 0.005 // ~200 m macro billows
const FOG_NOISE_SCALE_B = 0.01 // ~100 m secondary wisps
const FOG_NOISE_SPEED = 0.2
const FOG_NOISE_CENTER = 0.7
const FOG_TOP_VARIATION = 22 // metres, exactly the r185 reference amplitude
const FOG_EXTINCTION_LENGTH = 160 // metres at unit density (Beer-Lambert mean free path)
// Void fog wall (M18): mean free path INSIDE the wall medium at unit density.
// Short — the wall must read near-opaque ~3 lengths past the bubble edge.
const FOG_WALL_EXTINCTION_LENGTH = 40
// SF's broad flat districts do not intersect the noisy ceiling as often as the
// reference's mountain terrain. A symmetric, mean-preserving density swing makes
// the same octaves read as rolling pockets over streets and water.
const FOG_DENSITY_MIN = 0.6
const FOG_DENSITY_MAX = 1.4
const FOG_EDGE_START = 0.88 // narrow streamed-geometry cull fade
const FOG_EDGE_END = 0.98
const FOG_SKY_BLEND_HEIGHT = 0.08 // match the visible horizon over its lowest ~5°
const FOG_GOLD_LIGHT = 0.48 // neutral dusk fog: dimmer, never orange/grey
const FOG_NIGHT_LIGHT = 0.12 // moonlit bank without a daylight-white night seam
const FOG_WEATHER_UPDATE_SECONDS = 0.2
const LIVE_FOG_BLEND_HALFLIFE_SECONDS = 90
const LIVE_FOG_TARGET_HALFLIFE_SECONDS = 180
const LIVE_FOG_EXIT_HALFLIFE_SECONDS = 2.5

/**
 * A custom analytic sky driving both the backdrop and the image-based lighting.
 * The dome is a single TSL gradient keyed off the live sun direction: zenith and
 * horizon palettes crossfade through day / golden hour / night, a warm wedge
 * gathers around the sun as it grazes the horizon, and after dark a moon and a
 * hashed starfield take over. The same gradient doubles as an analytic environment
 * (SkyEnvNode below — no PMREM bake), and a single directional key light — sun by
 * day, moon by night — supplies the crisp shadows the IBL alone cannot.
 *
 * The sun follows the real astronomical path for San Francisco (lat/lon + current
 * civil date), so noon elevation and sunset bearing shift with the seasons.
 * When not following real SF time, `cycleEnabled`/`dayCycleSeconds` scrub hours
 * on today's SF date; `setTimeOfDay` jumps the hour directly.
 */
export class Sky {
  mesh: THREE.Mesh
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  timeOfDay = SKY_TUNING.values.timeOfDay
  /** Degrees above the horizon; negative when the sun is down. */
  sunElevation = 0
  /** Compass degrees clockwise from north (0=N, 90=E, 180=S, 270=W). */
  sunAzimuth = 0
  // When set, the sky tracks the real SF wall clock every frame (the default).
  // A manual override (scrub / setTimeOfDay / unchecking real-time) clears it, and
  // only affects this player — time of day is never sent over the network.
  realTime: boolean = SKY_TUNING.values.realTime
  // Programmatic pause for demos/probes/Z-scrub — not a panel toggle. When the
  // player unchecks "follow real SF time", the panel turns this on so the day
  // advances over dayCycleSeconds of wall clock.
  cycleEnabled = !SKY_TUNING.values.realTime
  /** Wall-clock seconds for one full in-game 24h lap. Panel range is 30..1800. */
  dayCycleSeconds = SKY_TUNING.values.dayCycleSeconds

  #sunVec = new THREE.Vector3() // true sun direction (may point below the horizon)
  // Continuous civil time lets accelerated/manual play advance the date as well
  // as the hour, which drives both the astronomical sun and multi-day weather.
  #civilDay = (() => {
    const n = sanFranciscoCivilNow()
    return sfCivilScalarDays({ ...n, hour: SKY_TUNING.values.timeOfDay })
  })()
  #simulatedUtcOffsetHours = (() => {
    const now = sanFranciscoCivilNow()
    return sfUtcOffsetHours({ ...now, hour: 12 })
  })()

  // sky shader uniforms
  #uSun = uniform(new THREE.Vector3(0, 1, 0))
  #uNightLift = uniform(SKY_TUNING.values.nightBrightness)
  // the five fog controls (uniforms so the "/" panel edits land live); the rest
  // of the fog shape is the FOG_* constants above. Haze and the narrow cull-edge
  // fade are draw-distance-scaled in applyFogParams.
  #uFogDensity = uniform(WORLD_TUNING.values.fog)
  #uFogTop = uniform(WORLD_TUNING.values.fogTop)
  #uFogBank = uniform(WORLD_TUNING.values.fogBank)
  #uFogNoise = uniform(WORLD_TUNING.values.fogNoise)
  #uFogPhase = uniform(0)
  #uFogAdvection = uniform(new THREE.Vector3())
  #uFogFrontX = uniform(-2500)
  #uFogFrontWidth = uniform(1200)
  #uFogFrontSkew = uniform(0)
  #uFogMacroPhase = uniform(0)
  #uFogInlandFloor = uniform(0.12)
  #uFogGateReach = uniform(1800)
  #uFogLocalScale = uniform(WORLD_TUNING.values.fogMaster)
  #uFogLight = uniform(1)
  #uFogEdgeStart = uniform(WORLD_TUNING.values.radius * FOG_EDGE_START)
  #uFogEdgeEnd = uniform(WORLD_TUNING.values.radius * FOG_EDGE_END)
  #uFogEnabled = uniform(WORLD_TUNING.values.fogEnabled ? 1 : 0)
  #uFogBackdrop = uniform(WORLD_TUNING.values.fogEnabled ? 1 : 0)
  // Void-realm ramp (docs/VOID_STREAM_REWRITE.md M2): 0 = normal sky, 1 = the
  // dark holo void. A pure uniform multiply on dome/IBL radiance and on fog
  // opacity — light-set membership and light intensities are never touched.
  #uVoid = uniform(0)
  // Void fog wall (M18 fill phase): everything OUTSIDE the circle
  // (#uWallCenter, #uWallRadius) is a participating medium of density
  // #uWallDensity — the world beyond the scanned bubble builds up invisibly
  // behind it until the big reveal sweeps the radius out and the density to 0.
  // Transmittance uses the analytic overlap of the camera→fragment ray with
  // the outside region, so a player who walks INTO the wall is correctly
  // immersed (short rays stay clear, long rays whiten). Radius 1e9 + density 0
  // collapse the term to zero (the boot/settled default).
  #uWallCenter = uniform(new THREE.Vector2(0, 0))
  #uWallRadius = uniform(1e9)
  #uWallDensity = uniform(0)
  #fogNode: N | null = null

  #proceduralFog = sampleProceduralFog(sfCivilFromScalarDays(this.#civilDay))
  #effectiveFog: FogWeatherState = { ...this.#proceduralFog }
  #liveFogBias: LiveFogBias | null = null
  #liveFogCurrent: FogWeatherState | null = null
  #liveFogTarget: FogWeatherState | null = null
  #liveFogMix = 0
  #liveFogStatus: "procedural" | "loading" | "live" | "stale" | "offline" = "procedural"
  #liveFogDetail = "deterministic SF weather"
  #liveFogSource = "none"
  #liveFogSatellite = "GOES mask pending"
  #liveFogReceivedAt = 0
  #liveFogRevealReady = false
  #liveFogStarting = false
  #liveFogStop: (() => void) | null = null
  #starlink: import("./starlinkSky").StarlinkSky | null = null
  #starlinkStarting = false
  #scene: THREE.Scene
  #fogWeatherElapsed = 0
  #lastFogWeatherWallMs = performance.now()
  #fogMotionPhase = 0
  #fogDriftRate = WORLD_TUNING.values.fogDrift
  #fogWindX = 0
  #fogWindZ = 0

  // night-only brightness multiplier (the "/" panel's night brightness slider);
  // the setter re-applies so edits land even while the cycle is paused
  #nightLift = SKY_TUNING.values.nightBrightness
  get nightBrightness() {
    return this.#nightLift
  }
  set nightBrightness(v: number) {
    this.#nightLift = v
    this.#uNightLift.value = v
    this.#applySun()
  }

  #lastElapsed = -1

  #shadowNode: ClipmapShadowNode

  get shadowDiagnostics() {
    return this.#shadowNode.diagnostics
  }

  /** Re-push the live shadow pane values without recompiling render materials. */
  applyShadowParams() {
    this.#shadowNode.applyTuning()
  }

  /** Streamers/proxy owners call this only when static caster membership changes. */
  invalidateStaticShadows(scope: StaticShadowScope = "all") {
    this.#shadowNode.invalidateStatic(scope)
  }

  /** M7: the ring coordinator holds static shadow redraws while its
   *  materialize sweep is active; latched dirt applies on settle. */
  setStaticShadowStreamingHold(active: boolean) {
    this.#shadowNode.setStreamingHold(active)
  }

  constructor(scene: THREE.Scene, farOcclusion: FarOcclusionField | null = null) {
    this.#scene = scene
    scene.environmentIntensity = 0.075 // a hint of sky in the reflections; the diffuse fill is the hemi's job

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24),
      this.#buildMaterial()
    )
    this.mesh.scale.setScalar(12000)
    this.mesh.frustumCulled = false
    scene.add(this.mesh)

    // analytic IBL: evaluate the sky gradient directly per reflection/normal ray
    // instead of baking a PMREM. The old bake ran every 0.08 s while the cycle
    // played — the single most expensive GPU operation in the game (100–300 ms
    // spike frames) spent on an environment shown at intensity 0.05. This node
    // costs a few ALU per env sample, never bakes, and tracks the sun exactly.
    scene.environmentNode = new SkyEnvNode(this) as N // raw node class lacks the TSL proxy sugar the types expect

    this.sun = new THREE.DirectionalLight(0xfff2e0, 100)
    this.sun.castShadow = true
    // The custom node owns three final-sized targets from construction. Keeping
    // the placeholder sun shadow aligned with the hero domain avoids any lazy
    // default-size target if Three inspects it before attaching shadowNode.
    this.sun.shadow.mapSize.set(
      CLIPMAP_SHADOW_CONFIG.hero.resolution,
      CLIPMAP_SHADOW_CONFIG.hero.resolution
    )
    this.sun.shadow.bias = CLIPMAP_SHADOW_CONFIG.hero.depthBias
    this.sun.shadow.normalBias = CLIPMAP_SHADOW_CONFIG.hero.normalBias
    scene.add(this.sun)
    scene.add(this.sun.target)

    this.#shadowNode = new ClipmapShadowNode(this.sun, farOcclusion)
    ;(this.sun.shadow as any).shadowNode = this.#shadowNode

    // warm ground-bounce fill: stands in for light-probe GI. Intensity and colour
    // follow the phase of day in #applySun
    this.hemi = new THREE.HemisphereLight(0xa9c4d9, 0x9c8468, 14)
    scene.add(this.hemi)

    this.#fogNode = this.#buildFogNode()
    scene.fog = null
    scene.fogNode = this.#fogNode

    // Prefer a persisted local override over the wall clock; otherwise mirror SF time.
    if (this.realTime) this.followRealTime()
    else this.cycleEnabled = true
    this.#updateFogWeather(true)
  }

  /**
   * The dome/environment radiance along direction `d`. Stylized single-scattering
   * look: horizon/zenith gradient per phase, a Mie-ish halo and disc for the sun,
   * a cold disc for the moon, a cell-hashed starfield. One TSL graph serves both
   * consumers: the dome gets the full treatment (discs, moon, stars); the analytic
   * environment (see SkyEnvNode) skips those point features — the key light already
   * carries the sun, exactly like the old PMREM bake with `uDisc = 0` — and instead
   * softens toward the hemispheric mean as `soften` (env roughness level) rises,
   * standing in for the prefiltered-mip blur the PMREM chain used to provide.
   * Output counters the reference exposure (SKY_DOME_BOOST) so authored 0..1
   * colours read as authored.
   */
  #skyRadiance(d: N, opts: { pointFeatures: boolean; soften?: N; fogBackdrop?: boolean }): N {
    const uSun = this.#uSun as N
    const uLift = this.#uNightLift as N
    const uFogBackdrop = this.#uFogBackdrop as N
    const fogColor = color(FOG_COLOR).mul(this.#uFogLight as N)
    // Void dim floor: not absolute black, so the dome keeps a faint deep-space
    // read behind the holo grid (a multiply, never a branch).
    const voidDim = mix(float(1), float(0.018), this.#uVoid as N)
    const voidKeep = (this.#uVoid as N).oneMinus()
    return Fn(() => {
      const mu = dot(d, uSun)
      const el = uSun.y // sun elevation, sin-scaled

      // phase weights: day fades out as the sun drops, night fades in below ~-6°,
      // golden hour owns the gap
      const dayW = smoothstep(0.02, 0.32, el)
      const nightW = smoothstep(-0.1, -0.3, el)
      const goldW = dayW.oneMinus().mul(nightW.oneMinus())
      // The foreground can read as night before the sky reaches the formal
      // night band. Let the slider lift low-sun twilight too, otherwise the
      // control appears dead around 18:00-18:30.
      const lowSunW = smoothstep(0.02, -0.16, el)
      const lowSunLift = mix(float(1), uLift, lowSunW)

      // moonlit night: the night palette carries a faint starlight/moonglow floor
      // (feeds the IBL too, so surfaces pick it up), scaled by the night
      // brightness slider — a multiply, never a branch (see SHADER-BRANCH HAZARD)
      const zen = vec3(0.12, 0.34, 0.8)
        .mul(dayW)
        .add(vec3(0.1, 0.15, 0.33).mul(goldW))
        .add(vec3(0.022, 0.032, 0.062).mul(nightW).mul(lowSunLift))
      const hor = vec3(0.58, 0.75, 0.9)
        .mul(dayW)
        .add(vec3(0.55, 0.34, 0.26).mul(goldW))
        .add(vec3(0.07, 0.098, 0.15).mul(nightW).mul(lowSunLift))

      // horizon-heavy gradient; below the horizon fall off toward ground haze
      const grad = mix(hor, zen, pow(saturate(d.y), 0.55))
      const below = smoothstep(0.0, -0.12, d.y)
      const sky = grad.mul(mix(float(1), float(0.35), below)).toVar()
      sky.addAssign(
        vec3(0.014, 0.02, 0.038)
          .mul(goldW)
          .mul(lowSunW)
          .mul(uLift.sub(1))
      )

      // warm wedge gathering around the sun while it grazes the horizon
      const wedge = pow(saturate(mu), 3.5)
        .mul(goldW)
        .mul(smoothstep(0.35, 0.02, abs(d.y)))
      sky.addAssign(vec3(1.0, 0.42, 0.16).mul(wedge).mul(0.85))

      if (opts.pointFeatures) {
        // sun disc + halo (visible slightly past sunset while the limb sinks)
        const sunVis = smoothstep(-0.06, 0.04, el)
        const discCol = mix(vec3(1.6, 0.95, 0.55), vec3(1.35, 1.28, 1.15), dayW)
        const disc = smoothstep(0.99955, 0.99985, mu).mul(6)
        const halo = pow(saturate(mu), 320)
          .mul(1.1)
          .add(pow(saturate(mu), 18).mul(0.16))
        sky.addAssign(discCol.mul(disc.add(halo)).mul(sunVis))

        // moon rides opposite the sun — always dead-opposite, so always full:
        // a big cold disc, tight halo, plus a broad moonglow wash, night only
        const mm = dot(d, uSun.negate())
        const moon = smoothstep(0.9994, 0.9998, mm)
          .mul(4)
          .add(pow(saturate(mm), 500).mul(0.8))
          .add(pow(saturate(mm), 40).mul(0.1))
        sky.addAssign(vec3(0.85, 0.9, 1.02).mul(moon).mul(nightW).mul(lowSunLift))

        // stars: one hash per direction cell, round dot inside the cell, slow twinkle
        const cells = d.mul(220)
        const seed = hash((floor(cells) as N).dot(vec3(1, 57, 113)).add(80000))
        const sp = fract(cells).sub(0.5).length()
        const mag = saturate(seed.sub(0.9982).div(0.0018))
        const twinkle = sin(time.mul(2).add(seed.mul(628)))
          .mul(0.35)
          .add(0.75)
        const star = step(0.9982, seed)
          .mul(smoothstep(0.42, 0.1, sp))
          .mul(mag.mul(mag).mul(2.0).add(0.2))
          .mul(twinkle)
        sky.addAssign(
          vec3(0.9, 0.93, 1.0)
            .mul(star)
            .mul(nightW)
            .mul(saturate(d.y.mul(2.5).add(0.1)))
        )
      }

      if (opts.soften) {
        // roughness blur stand-in: collapse toward the hemispheric mean, keeping a
        // touch of up/down directionality so rough down-facing surfaces stay dimmer
        const mean = mix(hor, zen, 0.35).mul(
          mix(float(1), float(0.5), smoothstep(0.2, -0.6, d.y))
        )
        return mix(sky, mean, saturate(opts.soften).mul(0.8))
          .mul(SKY_DOME_BOOST)
          .mul(voidDim)
      }

      const radiance = sky.mul(SKY_DOME_BOOST)
      if (opts.fogBackdrop) {
        // The r185 example makes its visible horizon exactly the fog colour. Keep
        // the authored SF sky everywhere except its lowest few degrees, where a
        // matching backdrop lets fogged geometry disappear without a colour seam.
        const horizonFog = smoothstep(
          float(FOG_SKY_BLEND_HEIGHT),
          float(0),
          d.y.max(0)
        ).mul(uFogBackdrop)
        // Void: the fog backdrop retires with the fog itself, and the whole
        // dome collapses toward the dark floor.
        return mix(
          radiance as N,
          fogColor as N,
          (horizonFog as N).mul(voidKeep)
        ).mul(voidDim) as N
      }

      return radiance.mul(voidDim)
    })()
  }

  #buildMaterial(): THREE.MeshBasicNodeMaterial {
    const mat = new THREE.MeshBasicNodeMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    })
    // view direction (dome centred on camera)
    mat.colorNode = this.#skyRadiance(normalize(positionLocal) as N, {
      pointFeatures: true,
      fogBackdrop: true
    })
    return mat
  }

  // Three r185's `webgpu_custom_fog` graph, scaled in metres for San Francisco.
  // The old regional mask, broad clear bubble, and 600–1150 m horizon blanket are
  // deliberately gone: they overwhelmed the reference billows and made a flat wall.
  #buildFogNode(): N {
    const dist = cameraPosition.sub(positionWorld).length()
    const horizontalDist = (cameraPosition as N).xz.sub((positionWorld as N).xz).length()
    const base = float(FOG_BASE) as N
    const y = (positionWorld as N).y

    // The retained reference octaves use integrated phase/advection. Updating a
    // weather rate therefore changes future motion without retroactively moving
    // the entire texture by rate × total session time.
    const nTime = this.#uFogPhase as N
    const fogPosition = (positionWorld as N).sub(this.#uFogAdvection as N)
    const noiseA = triNoise3D(
      fogPosition.mul(FOG_NOISE_SCALE_A),
      FOG_NOISE_SPEED,
      nTime
    )
    const noiseB = triNoise3D(
      fogPosition.mul(FOG_NOISE_SCALE_B),
      FOG_NOISE_SPEED,
      nTime.mul(1.2)
    )
    const fogNoise = noiseA.add(noiseB)

    // Stable macro coverage: a west-to-east Pacific front plus a soft tongue
    // through the Golden Gate. This analytic XZ meander exactly matches the CPU
    // diagnostic/test helper and avoids another noise sample or render pass.
    const frontMeander = sin(
      (positionWorld as N).z.mul(0.00072).add(this.#uFogMacroPhase as N)
    ).mul(430)
    const frontCoord = (positionWorld as N).x
      .add((positionWorld as N).z.mul(this.#uFogFrontSkew as N))
      .add(frontMeander)
    const pacific = smoothstep(
      (this.#uFogFrontX as N).sub(this.#uFogFrontWidth as N),
      (this.#uFogFrontX as N).add(this.#uFogFrontWidth as N),
      frontCoord
    ).oneMinus()
    const gateAlong = (positionWorld as N).x.add(3000)
    const gateAcross = (positionWorld as N).z
      .add(2700)
      .sub(gateAlong.mul(0.12))
      .abs()
    const gate = smoothstep(float(-300), float(450), gateAlong)
      .mul(
        smoothstep(
          this.#uFogGateReach as N,
          (this.#uFogGateReach as N).add(900),
          gateAlong
        ).oneMinus()
      )
      .mul(smoothstep(float(350), float(1350), gateAcross).oneMinus())
    const macroCoverage = pacific.oneMinus().mul(gate.oneMinus()).oneMinus()
    const regionalDensity = mix(
      this.#uFogInlandFloor as N,
      float(1),
      macroCoverage
    )

    // A compact patch bank threaded through Buena Vista's canopy. This is a
    // separate, bounded opacity term rather than a raised global bank ceiling:
    // lifting the shared ceiling would make the entire 450 m camera ray opaque
    // from Corona Heights. The rotated footprint follows the park's long axis,
    // the existing two fog octaves leave clear gaps between wisps, and the
    // summit carve keeps the opening readable during the high orbit.
    const mistX = (positionWorld as N).x.sub(BUENA_VISTA_MIST.x)
    const mistZ = (positionWorld as N).z.sub(BUENA_VISTA_MIST.z)
    const mistCos = Math.cos(BUENA_VISTA_MIST.rotation)
    const mistSin = Math.sin(BUENA_VISTA_MIST.rotation)
    const mistAlong = mistX.mul(mistCos).add(mistZ.mul(mistSin))
    const mistAcross = mistX.mul(-mistSin).add(mistZ.mul(mistCos))
    const mistEllipse = pow(mistAlong.div(BUENA_VISTA_MIST.radiusAlong), 2).add(
      pow(mistAcross.div(BUENA_VISTA_MIST.radiusAcross), 2)
    )
    const mistFootprint = smoothstep(float(1.08), float(0.72), mistEllipse)

    const clearingX = (positionWorld as N).x
      .sub(BUENA_VISTA_SUMMIT_CLEARING.x)
      .div(BUENA_VISTA_SUMMIT_CLEARING.radiusX * 1.18)
    const clearingZ = (positionWorld as N).z
      .sub(BUENA_VISTA_SUMMIT_CLEARING.z)
      .div(BUENA_VISTA_SUMMIT_CLEARING.radiusZ * 1.18)
    const summitClearing = smoothstep(
      float(1.08),
      float(0.68),
      pow(clearingX, 2).add(pow(clearingZ, 2))
    )
    const mistPockets = smoothstep(
      float(0.27),
      float(0.52),
      mix(noiseA, noiseB, 0.38)
    )
    const mistHeight = smoothstep(
      float(BUENA_VISTA_MIST.minY),
      float(BUENA_VISTA_MIST.fullY),
      y
    ).mul(
      smoothstep(
        float(BUENA_VISTA_MIST.maxY),
        float(BUENA_VISTA_MIST.fadeY),
        y
      )
    )
    const buenaVistaMist = mistFootprint
      .mul(summitClearing.oneMinus())
      .mul(mistHeight)
      .mul(mistPockets)
      .mul(smoothstep(float(24), float(210), dist))
      .mul(BUENA_VISTA_MIST.strength)
      .mul(this.#uFogLocalScale as N)

    // The official noisy ceiling: a fixed-altitude marine bank whose upper edge
    // continually reforms into 100–200 m billows while hills and towers rise clear.
    const top = (this.#uFogTop as N)
      .add(
        fogNoise
          .sub(FOG_NOISE_CENTER)
          .mul(FOG_TOP_VARIATION)
          .mul(this.#uFogNoise as N)
      )
      .max(base.add(1))
    // The alpine reference gets most of its visible density structure from terrain
    // crossing the noisy ceiling. Large parts of SF are flat, so let that same
    // reference noise gently modulate density throughout the layer as well. This
    // preserves rolling white pockets over streets and water instead of a solid fill.
    const billowDensity = smoothstep(float(0.25), float(0.9), fogNoise)
    const densityShape = mix(
      float(1),
      mix(float(FOG_DENSITY_MIN), float(FOG_DENSITY_MAX), billowDensity),
      (this.#uFogNoise as N).saturate()
    )

    // Unlike the reference's fixed elevated camera, gameplay can walk inside the
    // bank or fly far above it. Approximate the density integral along the ray:
    // sample the height ramp at both ends, then count only the fraction of the ray
    // below the noisy ceiling. A high bird/plane therefore sees a pooled layer
    // beneath it instead of treating the whole kilometre of clear air as fog.
    const layerDepth = top.sub(base).max(1)
    const surfaceDensity = top.sub(y).div(layerDepth).saturate().mul(0.98)
    const cameraDensity = top
      .sub((cameraPosition as N).y)
      .div(layerDepth)
      .saturate()
      .mul(0.98)
    const verticalSpan = (cameraPosition as N).y.sub(y).abs().max(0.001)
    const lowerEnd = (cameraPosition as N).y.min(y)
    const inLayerFraction = top.sub(lowerEnd).div(verticalSpan).saturate()
    const meanRayDensity = surfaceDensity
      .add(cameraDensity)
      .mul(0.5)
      .mul(inLayerFraction)
      .mul(densityShape)
      .mul(regionalDensity)
    const opticalDepth = dist
      .mul(meanRayDensity)
      .mul(this.#uFogBank as N)
      .div(FOG_EXTINCTION_LENGTH)
    const bankFog = opticalDepth.negate().exp().oneMinus()

    // The reference exp² distance haze supplies the broad atmospheric falloff.
    const distHaze = densityFogFactor(this.#uFogDensity as N)
    // Finish the streamed-world fade only at the horizontal draw edge. Altitude is
    // irrelevant to the XZ streaming rings and must never whiten geometry below.
    const edgeFade = smoothstep(
      this.#uFogEdgeStart as N,
      this.#uFogEdgeEnd as N,
      horizontalDist
    )

    // Void fog wall (M18): Beer-Lambert extinction over the analytic overlap
    // of the camera→fragment ray with the region OUTSIDE the wall circle
    // (2D XZ ray-vs-circle, branch-free: a missed circle yields zero inside
    // length via sqrt(max(disc, 0))). Radius 1e9 → the whole ray is "inside"
    // → zero optical depth → the term collapses when the wall is down.
    const wallL = horizontalDist.max(0.001)
    const wallDir = (positionWorld as N).xz.sub((cameraPosition as N).xz).div(wallL)
    const wallM = (this.#uWallCenter as N).sub((cameraPosition as N).xz)
    const wallB = wallM.dot(wallDir)
    const wallC = wallM.dot(wallM).sub((this.#uWallRadius as N).mul(this.#uWallRadius as N))
    const wallS = wallB.mul(wallB).sub(wallC).max(0).sqrt()
    const wallT0 = wallB.sub(wallS).clamp(0, wallL)
    const wallT1 = wallB.add(wallS).clamp(0, wallL)
    const wallOutside = wallL.sub(wallT1.sub(wallT0))
    const wallFog = wallOutside
      .mul(this.#uWallDensity as N)
      .div(FOG_WALL_EXTINCTION_LENGTH)
      .negate()
      .exp()
      .oneMinus()

    // Probabilistic union, identical to the reference for bank + haze and extended
    // by only the narrow cull fade: 1 - (1-bank)(1-haze)(1-edge)(1-mist).
    const clear = bankFog
      .oneMinus()
      .mul(distHaze.oneMinus())
      .mul(edgeFade.oneMinus())
      .mul(buenaVistaMist.oneMinus())

    // Weather fog honors the user fog toggle; the void WALL does not (it is a
    // streaming shroud, not weather — disabling it would expose the raw world
    // build during the fill phase). Union the two, then the void ramp gates
    // everything (the scan phase is clear black; the wall arms as the dawn
    // brings the void factor down).
    const weatherFactor = clear.oneMinus().mul(this.#uFogEnabled as N)
    const combinedFactor = float(1).sub(
      weatherFactor.oneMinus().mul(wallFog.oneMinus())
    )

    // Keep the official reference colour in color-managed form. It reads milky
    // white under ACES and now agrees with the visible horizon instead of resolving
    // to the old #4d5358 charcoal attractor.
    return tslFog(
      color(FOG_COLOR).mul(this.#uFogLight as N),
      // Void realm: fog fades out with the void ramp (a uniform multiply on
      // the fog factor — the graph and pipeline are unchanged).
      combinedFactor.mul((this.#uVoid as N).oneMinus())
    )
  }

  /**
   * Void fog wall control (M18 fill phase). Everything outside `radius` around
   * (x, z) renders through a dense shroud while the far world builds behind
   * it; the reveal animation sweeps `radius` outward while easing `density`
   * to 0. `density` 0 (or a huge radius) collapses the term entirely.
   */
  setVoidFogWall(x: number, z: number, radius: number, density: number) {
    ;(this.#uWallCenter.value as THREE.Vector2).set(x, z)
    this.#uWallRadius.value = Math.max(1, radius)
    this.#uWallDensity.value = Math.max(0, density)
  }

  /**
   * Void-realm ramp (docs/VOID_STREAM_REWRITE.md M2): 0 = normal sky, 1 = the
   * dark holo void. Darkens the dome + analytic IBL and disables marine fog via
   * uniforms only. Sun/hemi stay at their normal intensity so the avatar reads
   * — the light set never changes (C1). Driven by VoidRealm.update().
   */
  setVoidFactor(v: number) {
    this.#uVoid.value = Math.min(1, Math.max(0, v))
  }

  /** When set, the cull-edge fade pulls in to this radius instead of the streamed
   *  draw radius — lets surf mode tighten tile streaming without a hard seam
   *  popping at the (much closer) unload distance. null restores the default. */
  #cullRadiusOverride: number | null = null
  setCullRadiusOverride(r: number | null) {
    this.#cullRadiusOverride = r
    this.applyFogParams()
  }

  applyFogParams() {
    const v = WORLD_TUNING.values
    const weather = this.#effectiveFog
    const master = Math.max(0, v.fogMaster)
    // Atmospheric perspective is an artistic/physical property, not a streaming
    // control. Coupling density inversely to the draw radius made a smaller world
    // turn exponentially whiter, so players had to select absurd 60–300 km radii
    // just to see across an 11 km city. Only the narrow cull-edge fade follows the
    // streamed radius; broad haze and the height bank stay in physical metres.
    const edgeR = this.#cullRadiusOverride ?? v.radius
    // densityFogFactor is exp², so sqrt keeps master/weather linear in optical
    // effect. The bank is already a Beer-Lambert path integral.
    this.#uFogDensity.value = v.fog * Math.sqrt(master * weather.hazeScale)
    this.#uFogTop.value = v.fogTop + weather.topOffsetM
    this.#uFogBank.value = v.fogBank * master * weather.bankScale
    this.#uFogNoise.value = v.fogNoise * weather.billowScale
    this.#uFogFrontX.value = weather.frontX
    this.#uFogFrontWidth.value = weather.frontWidthM
    this.#uFogFrontSkew.value = weather.frontSkew
    this.#uFogMacroPhase.value = weather.macroPhase
    this.#uFogInlandFloor.value = weather.inlandFloor
    this.#uFogGateReach.value = weather.gateReachM
    this.#uFogLocalScale.value = master * weather.bankScale
    this.#fogDriftRate = v.fogDrift * weather.driftScale
    this.#fogWindX = weather.windX * v.fogDrift
    this.#fogWindZ = weather.windZ * v.fogDrift
    this.#uFogEdgeStart.value = edgeR * FOG_EDGE_START
    this.#uFogEdgeEnd.value = edgeR * FOG_EDGE_END
    this.#uFogEnabled.value = v.fogEnabled ? 1 : 0
    this.#uFogBackdrop.value = v.fogEnabled ? 1 : 0
  }

  #fogWeatherMode(): FogWeatherMode {
    const requested = WORLD_TUNING.values.fogWeather
    return requested === "live" || requested === "procedural" ? requested : "blend"
  }

  #updateFogWeather(force = false) {
    if (!force && this.#fogWeatherElapsed < FOG_WEATHER_UPDATE_SECONDS) return
    this.#fogWeatherElapsed = 0
    const wallNow = performance.now()
    const wallDt = Math.min(2, Math.max(0, (wallNow - this.#lastFogWeatherWallMs) / 1000))
    this.#lastFogWeatherWallMs = wallNow

    sampleProceduralFog(this.civilTime, this.#proceduralFog)
    if (this.#liveFogCurrent && this.#liveFogTarget && wallDt > 0) {
      const targetAlpha = 1 - Math.exp(
        (-Math.LN2 * wallDt) / LIVE_FOG_TARGET_HALFLIFE_SECONDS
      )
      blendFogWeather(
        this.#liveFogCurrent,
        this.#liveFogTarget,
        targetAlpha,
        this.#liveFogCurrent
      )
    }

    const mode = this.#fogWeatherMode()
    const targetMix = effectiveLiveWeight(
      mode,
      WORLD_TUNING.values.fogLiveInfluence,
      this.realTime,
      this.#liveFogBias,
      Date.now()
    )
    if (wallDt > 0) {
      const halfLife = !this.realTime || mode === "procedural"
        ? LIVE_FOG_EXIT_HALFLIFE_SECONDS
        : LIVE_FOG_BLEND_HALFLIFE_SECONDS
      const mixAlpha = 1 - Math.exp(
        (-Math.LN2 * wallDt) / halfLife
      )
      this.#liveFogMix += (targetMix - this.#liveFogMix) * mixAlpha
      if (this.#liveFogMix < 0.0001 && targetMix === 0) this.#liveFogMix = 0
    }

    if (this.#liveFogCurrent) {
      blendFogWeather(
        this.#proceduralFog,
        this.#liveFogCurrent,
        this.#liveFogMix,
        this.#effectiveFog
      )
    } else {
      blendFogWeather(
        this.#proceduralFog,
        this.#proceduralFog,
        0,
        this.#effectiveFog
      )
    }
    this.applyFogParams()
  }

  /** Live data module sink: values have already been normalized and aged. */
  acceptLiveFog(bias: LiveFogBias, meta: LiveFogFeedMeta) {
    this.#liveFogBias = bias
    if (!this.#liveFogCurrent) this.#liveFogCurrent = { ...bias.state }
    this.#liveFogTarget = { ...bias.state }
    this.#liveFogSource = meta.source
    this.#liveFogSatellite = meta.satellite
    this.#liveFogReceivedAt = meta.receivedAtMs
    this.#updateFogWeather(true)
  }

  setLiveFogStatus(
    status: "procedural" | "loading" | "live" | "stale" | "offline",
    detail: string
  ) {
    this.#liveFogStatus = status
    this.#liveFogDetail = detail
  }

  /** Main calls this once after reveal; a procedural-only setting loads nothing. */
  enableLiveFogAfterReveal() {
    this.#liveFogRevealReady = true
    this.#reconcileLiveFogFeed()
    this.#reconcileStarlinkSky()
  }

  /** Called after the weather-source selector changes. */
  refreshFogWeatherSource() {
    this.#updateFogWeather(true)
    this.#reconcileLiveFogFeed()
  }

  #reconcileLiveFogFeed() {
    if (!this.#liveFogRevealReady) return
    if (!this.realTime || this.#fogWeatherMode() === "procedural") {
      this.#liveFogStop?.()
      this.#liveFogStop = null
      this.setLiveFogStatus(
        "procedural",
        this.realTime
          ? "live feed disabled · deterministic SF weather"
          : "simulated clock · deterministic SF weather"
      )
      return
    }
    if (this.#liveFogStop || this.#liveFogStarting) return
    this.#liveFogStarting = true
    this.setLiveFogStatus("loading", "procedural now · loading SF observations")
    void import("./liveFog")
      .then(({ startLiveFogFeed }) => {
        this.#liveFogStarting = false
        if (!this.#liveFogRevealReady || !this.realTime || this.#fogWeatherMode() === "procedural") return
        this.#liveFogStop = startLiveFogFeed(this)
      })
      .catch((error) => {
        this.#liveFogStarting = false
        this.setLiveFogStatus(
          "offline",
          `procedural fallback · ${error instanceof Error ? error.message : "feed unavailable"}`
        )
      })
  }

  /** Real-time night sky only: lazy-load Starlink GP → SGP4 points. */
  #reconcileStarlinkSky() {
    if (!this.#liveFogRevealReady || !this.realTime) {
      // Keep the catalog warm; update() hides the sprites when ineligible.
      return
    }
    if (this.#starlink || this.#starlinkStarting) return
    this.#starlinkStarting = true
    void import("./starlinkSky")
      .then(({ StarlinkSky }) => {
        this.#starlinkStarting = false
        if (!this.#liveFogRevealReady || !this.realTime || this.#starlink) return
        this.#starlink = new StarlinkSky(this.#scene)
      })
      .catch((error) => {
        this.#starlinkStarting = false
        console.warn(
          "[starlink] module unavailable:",
          error instanceof Error ? error.message : error
        )
      })
  }

  /** Allocation-free diagnostics writer for the 4 Hz Tweakpane monitor. */
  writeFogWeatherDiagnostics(out: Record<string, string>, nowMs = Date.now()) {
    const civil = this.civilTime
    const liveEligible = this.realTime && this.#fogWeatherMode() !== "procedural"
    const minutes = Math.floor(civil.hour * 60 + 0.5) % (24 * 60)
    const hh = String(Math.floor(minutes / 60)).padStart(2, "0")
    const mm = String(minutes % 60).padStart(2, "0")
    const ageMinutes = liveEligible && this.#liveFogBias
      ? Math.max(0, (nowMs - this.#liveFogBias.observedAtMs) / 60000)
      : null
    out.driver = !this.realTime
      ? this.#liveFogMix > 0.005
        ? "transition → procedural · simulated clock"
        : "procedural · simulated clock"
      : this.#liveFogMix > 0.005
        ? `procedural + ${this.#liveFogSource}`
        : "procedural"
    out["SF date"] = `${civil.year}-${String(civil.month).padStart(2, "0")}-${String(civil.day).padStart(2, "0")} ${hh}:${mm}`
    out["live mix"] = `${Math.round(this.#liveFogMix * 100)}%`
    out["bank / haze"] = `${this.#effectiveFog.bankScale.toFixed(2)}× / ${this.#effectiveFog.hazeScale.toFixed(2)}×`
    out["coastal front"] = `${Math.round(this.#effectiveFog.frontX)} m · gate ${Math.round(this.#effectiveFog.gateReachM)} m`
    out.observations = liveEligible
      ? `${this.#liveFogStatus}${ageMinutes === null ? "" : ` · ${Math.round(ageMinutes)} min old`}`
      : "procedural"
    out.detail = this.#liveFogDetail
    out.satellite = liveEligible ? this.#liveFogSatellite : "inactive"
    out.received = liveEligible && this.#liveFogReceivedAt
      ? `${Math.max(0, Math.round((nowMs - this.#liveFogReceivedAt) / 60000))} min ago`
      : liveEligible ? "not yet" : "not active"
  }

  /** Environment radiance for the IBL: no point features, roughness-softened. */
  envRadiance(dir: N, level: N): N {
    return this.#skyRadiance(dir, { pointFeatures: false, soften: level })
  }

  /** Re-run the sun/hemi pass after a day-grade tunable (sunDay/hemiDay)
   *  changes — the "/" panel calls this so the sliders re-grade live even
   *  while the time of day is pinned. */
  applyLightGrade() {
    this.#applySun()
  }

  /** Current continuous simulated/real San-Francisco civil instant. */
  get civilTime(): SfCivilTime {
    return sfCivilFromScalarDays(this.#civilDay)
  }

  /** Deterministic probe/demo hook: pin both date and time and freeze cycling. */
  setCivilTime(civil: SfCivilTime) {
    this.realTime = false
    this.cycleEnabled = false
    // This hook is used by deterministic captures/tests: never let a
    // network/cache race contaminate a pinned procedural instant.
    this.#liveFogMix = 0
    this.#simulatedUtcOffsetHours = sfUtcOffsetHours({ ...civil, hour: 12 })
    this.#civilDay = sfCivilScalarDays(civil)
    this.timeOfDay = this.civilTime.hour
    this.#applySun()
    this.#updateFogWeather(true)
    this.#reconcileLiveFogFeed()
    this.#reconcileStarlinkSky()
  }

  /** Move the simulated calendar continuously, including date/year rollover. */
  advanceCivilHours(hours: number) {
    if (!Number.isFinite(hours) || hours === 0) return
    if (this.realTime) {
      this.#simulatedUtcOffsetHours = sfUtcOffsetHours({ ...this.civilTime, hour: 12 })
    }
    this.realTime = false
    this.#civilDay += hours / 24
    this.timeOfDay = this.civilTime.hour
    this.#applySun()
    this.#updateFogWeather(true)
    this.#reconcileLiveFogFeed()
    this.#reconcileStarlinkSky()
  }

  /** Pin a fixed hour on the current SF calendar date. Stops tracking the real
   *  SF clock (the day cycle keeps running only if it was already on). */
  setTimeOfDay(hours: number) {
    if (this.realTime) {
      this.#simulatedUtcOffsetHours = sfUtcOffsetHours({ ...this.civilTime, hour: 12 })
    }
    this.realTime = false
    this.timeOfDay = ((hours % 24) + 24) % 24
    this.#civilDay = Math.floor(this.#civilDay) + this.timeOfDay / 24
    this.#applySun()
    this.#updateFogWeather(true)
    this.#reconcileLiveFogFeed()
    this.#reconcileStarlinkSky()
  }

  /** Snap to the current real SF date+time and keep mirroring it every frame —
   *  the default sky. Wherever the player is, the game reads the SF wall clock. */
  followRealTime() {
    this.realTime = true
    this.cycleEnabled = false
    const now = sanFranciscoCivilNow()
    this.#simulatedUtcOffsetHours = sfUtcOffsetHours({ ...now, hour: 12 })
    this.#civilDay = sfCivilScalarDays(now)
    this.timeOfDay = now.hour
    this.#applySun()
    this.#updateFogWeather(true)
    this.#reconcileLiveFogFeed()
    this.#reconcileStarlinkSky()
  }

  #applySun() {
    const civil = this.civilTime
    const pos = solarPosition(
      civil,
      undefined,
      undefined,
      this.realTime ? undefined : this.#simulatedUtcOffsetHours
    )
    this.sunElevation = pos.elevation
    this.sunAzimuth = pos.azimuth
    this.#sunVec.set(pos.x, pos.y, pos.z)
    ;(this.#uSun.value as THREE.Vector3).copy(this.#sunVec)

    const elevation = pos.elevation
    const dayW = smooth01(1.5, 18, elevation)
    const nightW = smooth01(6, 17, -elevation)
    const goldW = (1 - dayW) * (1 - nightW)
    const lowSunW = smooth01(-1, 9, -elevation)

    // key light: the sun while it's up (sunDay at noon — see the day-grade
    // comment on SKY_TUNING — dimming and warming toward the horizon), handed
    // over to a cold full moon at night — bright enough to read the player by,
    // scaled by the night brightness slider. Moon/twilight terms carry the
    // exposure re-anchor factor; the day terms are the live day-grade sliders.
    const nb = this.#nightLift
    const lowSunLift = 1 + (nb - 1) * lowSunW
    // Keep the official fog hue neutral at every hour. Only incident-light
    // energy falls with the sun, and the dome uses this same value so fully
    // fogged geometry has no horizon seam. Midday remains the exact reference.
    this.#uFogLight.value =
      dayW +
      FOG_GOLD_LIGHT * goldW * lowSunLift +
      FOG_NIGHT_LIGHT * nightW * lowSunLift
    const sinEl = Math.sin(THREE.MathUtils.degToRad(elevation))
    if (elevation > -2) {
      const transmittance = Math.sqrt(Math.max(sinEl, 0))
      this.sun.color
        .set(0xffb072)
        .lerp(WARM_SUN, transmittance)
      this.sun.intensity = SKY_TUNING.values.sunDay * transmittance
      SUN_DIR.copy(this.#sunVec)
    } else {
      this.sun.color.set(0xa8bfe6)
      this.sun.intensity =
        6.2 * EXPOSURE_REBASE * lowSunLift * smooth01(1.5, 10, -elevation)
      SUN_DIR.copy(this.#sunVec).negate() // the moon is the light source now
    }

    this.hemi.intensity =
      SKY_TUNING.values.hemiDay * dayW +
      EXPOSURE_REBASE * lowSunLift * (3.8 * goldW + 3.1 * nightW)
    blend3(
      this.hemi.color,
      PALETTE.hemiSky.day,
      PALETTE.hemiSky.gold,
      PALETTE.hemiSky.night,
      dayW,
      goldW,
      nightW
    )
    blend3(
      this.hemi.groundColor,
      PALETTE.hemiGround.day,
      PALETTE.hemiGround.gold,
      PALETTE.hemiGround.night,
      dayW,
      goldW,
      nightW
    )

    // the crown display holds its proportion to the ambient light: brilliant at
    // noon, eased down after dark so emissive landmarks do not blow out
    CROWN_INTENSITY.value =
      LIGHT_SCALE * (6 * dayW + 2.4 * goldW + 1.5 * nightW)
    // the Bay Lights fade up as the sun drops: faint at noon, full art after dark
    BAY_LIGHTS_INTENSITY.value =
      LIGHT_SCALE * (0.7 * dayW + 1.7 * goldW + 2.6 * nightW)
    // Golden Gate architectural lighting: off in daylight, fading in through
    // evening twilight (onDeg → fullDeg below horizon; tweakpane-adjustable).
    const ggOn = GOLDEN_GATE_LIGHTS_SLIDERS.values.onDeg
    const ggFull = Math.max(ggOn + 0.2, GOLDEN_GATE_LIGHTS_SLIDERS.values.fullDeg)
    const goldenGateTwilightW = smooth01(ggOn, ggFull, -elevation)
    GOLDEN_GATE_LIGHTS_INTENSITY.value = LIGHT_SCALE * 3.0 * goldenGateTwilightW
    // Car headlamps / window glow keep a slower shared dusk ramp so they are
    // not tied to the bridge-light onset knobs.
    const nightGlowW = smooth01(0.5, 7.5, -elevation)
    CAR_HEADLIGHT_INTENSITY.value = LIGHT_SCALE * 0.95 * nightGlowW
    WINDOW_GLOW_W.value = nightGlowW
    // Sutro's aviation beacons: faint red by day, blazing after dark
    SUTRO_LIGHTS_INTENSITY.value =
      LIGHT_SCALE * (0.12 * dayW + 0.9 * goldW + 1.9 * nightW)
  }

  /** Advance the cycle, keep the dome centred and the key light anchored ahead.
   *  `shadowFocus` is the stable gameplay subject (normally player.renderPosition),
   *  deliberately separate from camera shake/cinematic framing. */
  update(
    elapsed: number,
    cameraPos: THREE.Vector3,
    shadowFocus: THREE.Vector3 = cameraPos
  ) {
    const dt =
      this.#lastElapsed < 0 ? 0 : Math.min(elapsed - this.#lastElapsed, 0.1)
    this.#lastElapsed = elapsed
    if (dt > 0) {
      this.#fogMotionPhase += dt * this.#fogDriftRate
      this.#uFogPhase.value = this.#fogMotionPhase
      const advection = this.#uFogAdvection.value as THREE.Vector3
      advection.x += dt * this.#fogWindX * 0.08
      advection.z += dt * this.#fogWindZ * 0.08
    }

    if (this.realTime) {
      // default: mirror the real San-Francisco date + clock, wherever the player is
      const now = sanFranciscoCivilNow()
      this.#civilDay = sfCivilScalarDays(now)
      this.timeOfDay = now.hour
      this.#applySun() // the analytic env reads #uSun, so the IBL tracks for free
    } else if (this.cycleEnabled && this.dayCycleSeconds > 0 && dt > 0) {
      this.#civilDay += dt / this.dayCycleSeconds
      this.timeOfDay = this.civilTime.hour
      this.#applySun()
    }
    this.#fogWeatherElapsed += dt
    this.#updateFogWeather()

    this.mesh.position.copy(cameraPos)

    this.#starlink?.update(this, cameraPos)

    // The visible key remains camera-relative to preserve directional-light
    // precision. Its custom shadow node uses the independent stable subject
    // focus and fixed light-space clipmaps below.
    this.sun.position.copy(cameraPos).addScaledVector(SUN_DIR, 400)
    this.sun.target.position.copy(cameraPos)
    this.sun.target.updateMatrixWorld()
    this.#shadowNode.schedule(shadowFocus, SUN_DIR)
  }
}

/**
 * Analytic environment for the IBL. three wraps `scene.environmentNode` in an
 * EnvironmentNode, which builds this node twice per lit material: once under a
 * radiance context (getUV = world-space reflect vector, getTextureLevel =
 * roughness) and once under an irradiance context (getUV = world normal,
 * level = 1). Evaluating the sky gradient directly along that ray replaces the
 * PMREM bake — no render target, no rebake cadence, and the reflections track
 * the moving sun continuously through #uSun instead of at the bake rate.
 */
class SkyEnvNode extends THREE.TempNode {
  static get type() {
    return "SkyEnvNode"
  }

  #sky: Sky

  constructor(sky: Sky) {
    super("vec3")
    this.#sky = sky
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL builder (see N above)
  setup(builder: any) {
    const ctx = builder.context
    const dir = ctx.getUV ? ctx.getUV() : vec3(0, 1, 0)
    const level = ctx.getTextureLevel ? ctx.getTextureLevel() : float(0)
    return this.#sky.envRadiance(dir as N, level as N)
  }
}
