import * as THREE from "three/webgpu"
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js"
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
import { GOLDEN_GATE_LIGHTS_INTENSITY } from "./goldenGateLights"
import { SUTRO_LIGHTS_INTENSITY } from "./sutroTower"
import { STREET_LAMPS_INTENSITY } from "./streetLamps"
import { DRAW_BASELINE, EXPOSURE_REBASE, LIGHT_SCALE, WORLD_TUNING } from "../config"
import { tunables } from "../core/persist"
import {
  sanFranciscoCivilNow,
  sanFranciscoTimeOfDay,
  solarPosition,
  type SfCivilTime
} from "./solar"

export { sanFranciscoTimeOfDay }

// Fallback hour used only before the first real-time read lands (warm pre-sunset).
// The default sky follows the real SF clock (see sanFranciscoTimeOfDay / followRealTime).
export const PRE_SUNSET_TIME = 15.48

// Day/night cycle tuning, bound in the "/" panel's lighting folder (persisted).
// timeOfDay: hours 0..24 on the current SF calendar date — the sun follows the
// real astronomical path for that day (seasonal elevation + azimuth), not a
// stylized arc. cycleDuration: real seconds for a full 24h lap.
export const SKY_TUNING = tunables("sky", {
  timeOfDay: { v: 18.48, min: 0, max: 24, step: 0.01, label: "time of day" },
  // default: mirror the real SF wall clock. Scrubbing (Z), dragging the time
  // slider, or turning on the cycle drops this off — a personal, local override.
  realTime: { v: true, label: "follow real SF time" },
  cycleEnabled: { v: false, label: "fast day/night cycle" },
  cycleDuration: {
    v: 1500,
    min: 30,
    max: 2800,
    step: 1,
    label: "day length (s)"
  },
  // scales the low-sun/night fill (moon key, hemi fill, sky/IBL night palette,
  // moon disc) so full dark and late twilight stay readable; 1 = authored look
  nightBrightness: {
    v: 1.18,
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

// Universal render-mode shadow config — the fixed values #applyShadowConfig
// pushes onto the sun + every CSM cascade. This is the old "high" tier, now the
// only tier: cascaded shadow maps are always on (the retired off/low/high
// presets are gone).
//
// Tuned for cost: TWO cascades, not three. Each cascade re-renders every
// shadow-casting mesh in its slice into a depth map, so the cascade COUNT is the
// dominant shadow lever (draw/vertex bound). A tight near cascade (0..40 m at
// 2048 → ~3 cm texels) carries every contact you actually read — the player, the
// GG suspender-cable shadows on the deck, near street furniture — and one coarse
// far cascade (40..350 m at 1024) covers the block beyond. maxFar drops 600→350
// because the marine fog closes the draw distance well before then and shadow
// detail past ~350 m is sub-pixel anyway; that also shrinks the far cascade's
// frustum so it holds fewer casters. lightMargin 400 m still catches tall up-light
// casters (towers) at grazing angles. normalBias grows on the coarser far cascade
// (its texels are ~10× the near one) to kill acne without peter-panning contact.
const SHADOW_CASCADES = 2
const SHADOW_NEAR_SPLIT = 40 // metres; cascade 0 hugs the player out to here
const SHADOW_MAP_SIZE = 2048 // near cascade — the crisp one
// per-cascade map size; the far cascade is half-res — its texels already span
// ~0.5 m across 40..350 m and are seen through haze, so 1024 is indistinguishable
// from 2048 there while costing a quarter of the depth writes + memory.
const SHADOW_MAP_SIZES = [2048, 1024] as const
const SHADOW_MAX_FAR = 350
const SHADOW_LIGHT_MARGIN = 400
const SHADOW_NORMAL_BIAS = [0.25, 2.0] as const

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
const FOG_DENSITY_MIN = 0.82 // moving pockets, centred on the reference density
const FOG_DENSITY_MAX = 1.18
const FOG_EDGE_START = 0.88 // narrow streamed-geometry cull fade
const FOG_EDGE_END = 0.98
const FOG_SKY_BLEND_HEIGHT = 0.08 // match the visible horizon over its lowest ~5°

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
 * `cycleEnabled`/`cycleDuration` scrub hours on today's SF date; `setTimeOfDay`
 * jumps the hour directly.
 */
export class Sky {
  mesh: THREE.Mesh
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  timeOfDay = PRE_SUNSET_TIME
  /** Degrees above the horizon; negative when the sun is down. */
  sunElevation = 0
  /** Compass degrees clockwise from north (0=N, 90=E, 180=S, 270=W). */
  sunAzimuth = 0
  // When set, the sky tracks the real SF wall clock every frame (the default).
  // A manual override (scrub / setTimeOfDay / enabling the cycle) clears it, and
  // only affects this player — time of day is never sent over the network.
  realTime: boolean = SKY_TUNING.values.realTime
  cycleEnabled: boolean = SKY_TUNING.values.cycleEnabled // fast demo cycle; off unless opted in
  cycleDuration = SKY_TUNING.values.cycleDuration

  #scene: THREE.Scene
  #sunVec = new THREE.Vector3() // true sun direction (may point below the horizon)
  // Calendar day the scrubbed/cycled hour is evaluated against. Real-time mode
  // refreshes this every frame; manual mode keeps the SF date from the last
  // followRealTime / construction so season stays coherent while scrubbing hours.
  #civilDate: Pick<SfCivilTime, "year" | "month" | "day"> = (() => {
    const n = sanFranciscoCivilNow()
    return { year: n.year, month: n.month, day: n.day }
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
  #uFogDrift = uniform(WORLD_TUNING.values.fogDrift)
  #uFogEdgeStart = uniform(WORLD_TUNING.values.radius * FOG_EDGE_START)
  #uFogEdgeEnd = uniform(WORLD_TUNING.values.radius * FOG_EDGE_END)
  #uFogBackdrop = uniform(WORLD_TUNING.values.fogEnabled ? 1 : 0)
  #fogNode: N | null = null

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

  // cascaded shadow node (built lazily on first render); coarse-cascade biases
  // are applied once the node has created its per-cascade lights
  #csm: CSMShadowNode
  #csmTuned = false
  // shadow-render throttle state (see update())
  #shadowFrame = 0
  #shadowAutoDisabled = false
  #lastShadowCam = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
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
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    const cam = this.sun.shadow.camera
    cam.near = 0.5
    cam.far = 1400
    this.sun.shadow.bias = -0.0002 // CSM scales this ×(cascade index + 1)
    this.sun.shadow.normalBias = SHADOW_NORMAL_BIAS[0] // near-cascade value; coarser cascades bumped in update()
    scene.add(this.sun)
    scene.add(this.sun.target)

    // Cascaded shadow maps: one tight cascade hugging the player (~3cm texels —
    // the old single 440m map was ~11cm) and one coarse far cascade out to
    // SHADOW_MAX_FAR. Each cascade texel-snaps its own frustum every frame, which
    // kills the shimmer the single sliding map had, and `fade` cross-blends the
    // seam. The ortho left/right/top/bottom above are irrelevant — the node
    // refits each cascade from the view frustum.
    this.#csm = new CSMShadowNode(this.sun, {
      cascades: SHADOW_CASCADES,
      maxFar: SHADOW_MAX_FAR,
      mode: "custom",
      customSplitsCallback: (
        _amount: number,
        _near: number,
        far: number,
        target: number[]
      ) => {
        // cascade 0 = near..SHADOW_NEAR_SPLIT, cascade 1 = split..far
        target.push(SHADOW_NEAR_SPLIT / far, 1)
        // Size each cascade's shadow map to its FINAL per-cascade resolution HERE,
        // while the CSM node is mid-`_init`: the cascade lights already exist (the
        // node pushes them before it calls updateFrustums → this callback) but their
        // depth-map render targets are not built until `_setupShadow` runs a moment
        // later. Setting mapSize now means each ShadowDepthTexture is *born* at its
        // final size, so three's per-frame `shadowMap.setSize(...)` is always a
        // no-op and the GPU texture is never destroyed/recreated at runtime.
        //
        // Why this matters: the far cascade is half-res (1024) but the cascades are
        // cloned from `sun.shadow` at 2048, so the far map used to be shrunk 2048→1024
        // AFTER creation by #applyShadowConfig — a real GPU realloc. If any recorded
        // render bundle (tiles / citygen detail / garden far tier / traffic rigs) had
        // captured a bind group referencing the old 2048 ShadowDepthTexture before that
        // realloc, every subsequent submit throws
        //   "Destroyed texture [ShadowDepthTexture] used in a submit"
        // once per frame, because re-recording a BundleGroup does NOT rebuild a bind
        // group that points at a destroyed shadow texture. Birthing the map at its
        // final size removes the realloc entirely, closing that race by construction.
        this.#presizeCascadeShadows()
      },
      lightMargin: SHADOW_LIGHT_MARGIN // catch tall up-light casters (towers) at grazing dusk angles
    })
    this.#csm.fade = true
    ;(this.sun.shadow as any).shadowNode = this.#csm
    this.#applyShadowConfig()

    // warm ground-bounce fill: stands in for light-probe GI. Intensity and colour
    // follow the phase of day in #applySun
    this.hemi = new THREE.HemisphereLight(0xa9c4d9, 0x9c8468, 14)
    scene.add(this.hemi)

    this.#fogNode = this.#buildFogNode()
    scene.fog = null
    this.applyFogParams()

    this.followRealTime()
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
        return mix(sky, mean, saturate(opts.soften).mul(0.8)).mul(SKY_DOME_BOOST)
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
        return mix(radiance as N, color(FOG_COLOR) as N, horizonFog as N) as N
      }

      return radiance
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

    // Exact reference spatial octaves and timing. At the default 1× motion this
    // evolves at the same restrained pace as the supplied official-example video.
    const nTime = time.mul(this.#uFogDrift as N)
    const noiseA = triNoise3D(
      (positionWorld as N).mul(FOG_NOISE_SCALE_A),
      FOG_NOISE_SPEED,
      nTime
    )
    const noiseB = triNoise3D(
      (positionWorld as N).mul(FOG_NOISE_SCALE_B),
      FOG_NOISE_SPEED,
      nTime.mul(1.2)
    )
    const fogNoise = noiseA.add(noiseB)

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

    // Probabilistic union, identical to the reference for bank + haze and extended
    // by only the narrow cull fade: 1 - (1-bank)(1-haze)(1-edge).
    const clear = bankFog
      .oneMinus()
      .mul(distHaze.oneMinus())
      .mul(edgeFade.oneMinus())

    // Keep the official reference colour in color-managed form. It reads milky
    // white under ACES and now agrees with the visible horizon instead of resolving
    // to the old #4d5358 charcoal attractor.
    return tslFog(color(FOG_COLOR), clear.oneMinus())
  }

  applyFogParams() {
    const v = WORLD_TUNING.values
    // Preserve the same haze curve as draw distance changes (constant d·density),
    // while the cull fade remains pinned to the final slice of the streamed radius.
    // The height bank stays in physical metres.
    const k = v.radius / DRAW_BASELINE
    this.#uFogDensity.value = v.fog / k
    this.#uFogTop.value = v.fogTop
    this.#uFogBank.value = v.fogBank
    this.#uFogNoise.value = v.fogNoise
    this.#uFogDrift.value = v.fogDrift
    this.#uFogEdgeStart.value = v.radius * FOG_EDGE_START
    this.#uFogEdgeEnd.value = v.radius * FOG_EDGE_END
    this.#uFogBackdrop.value = v.fogEnabled ? 1 : 0
    this.#scene.fog = null
    this.#scene.fogNode = v.fogEnabled ? this.#fogNode : null
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

  /** Pin a fixed hour on today's SF calendar date. Stops tracking the real
   *  SF clock (the fast cycle keeps running only if it was already on). */
  setTimeOfDay(hours: number) {
    this.realTime = false
    this.timeOfDay = ((hours % 24) + 24) % 24
    this.#applySun()
  }

  /** Snap to the current real SF date+time and keep mirroring it every frame —
   *  the default sky. Wherever the player is, the game reads the SF wall clock. */
  followRealTime() {
    this.realTime = true
    const now = sanFranciscoCivilNow()
    this.#civilDate = { year: now.year, month: now.month, day: now.day }
    this.timeOfDay = now.hour
    this.#applySun()
  }

  /**
   * Stamp each CSM cascade light with its FINAL per-cascade shadow resolution
   * (and matching normal bias). Split out from #applyShadowConfig so the CSM node
   * can call it from `customSplitsCallback` during `_init` — i.e. *before* the
   * cascade depth-map render targets exist — so every ShadowDepthTexture is born
   * at its final size and is never reallocated at runtime. See the long note at the
   * customSplitsCallback for the render-bundle hazard this closes. Idempotent:
   * because the maps are already at these sizes, later calls never resize (no
   * GPU realloc), they just re-assert the values.
   */
  #presizeCascadeShadows() {
    const lights = this.#csm?.lights
    if (!lights) return
    for (let i = 0; i < lights.length; i++) {
      const l = lights[i]
      l.castShadow = true
      if (!l.shadow) continue
      // per-cascade map size: near cascade stays 2048, far cascade halves
      const size = SHADOW_MAP_SIZES[i] ?? SHADOW_MAP_SIZES[SHADOW_MAP_SIZES.length - 1]
      l.shadow.mapSize.set(size, size)
      l.shadow.normalBias = SHADOW_NORMAL_BIAS[i] ?? SHADOW_NORMAL_BIAS[SHADOW_NORMAL_BIAS.length - 1]
    }
  }

  /**
   * Push the fixed universal-mode shadow config (the SHADOW_* constants above)
   * onto the sun + every CSM cascade light. Called once from the constructor and
   * again as a one-shot in update() the frame the CSM node finishes building its
   * per-cascade lights. The per-cascade MAP SIZES are already stamped at cascade
   * birth (see #presizeCascadeShadows / customSplitsCallback), so re-asserting them
   * here is a no-op resize — no ShadowDepthTexture is ever destroyed. Shadows are
   * always on now; the old off/low/high tiers (and setShadowQuality) are gone.
   */
  #applyShadowConfig() {
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
    this.sun.shadow.needsUpdate = true
    this.#csm.maxFar = SHADOW_MAX_FAR
    this.#csm.lightMargin = SHADOW_LIGHT_MARGIN
    this.#presizeCascadeShadows() // sizes already final → never a realloc
    for (const l of this.#csm.lights) if (l.shadow) l.shadow.needsUpdate = true
    if (this.#csm.camera) this.#csm.updateFrustums()
  }

  #applySun() {
    const civil: SfCivilTime = { ...this.#civilDate, hour: this.timeOfDay }
    const pos = solarPosition(civil)
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
    // evening twilight and fading back out as the sun returns.
    const goldenGateTwilightW = smooth01(0.5, 7.5, -elevation)
    GOLDEN_GATE_LIGHTS_INTENSITY.value = LIGHT_SCALE * 3.0 * goldenGateTwilightW
    // Fake street-lamp pools: dark by day, warm pools fading in through twilight
    // so the night streets read instead of going pitch black. (No real lights.)
    STREET_LAMPS_INTENSITY.value = LIGHT_SCALE * 2.2 * goldenGateTwilightW
    // lit building windows (baked facades + citygen glass + far LOD): dark by
    // day, on through the same twilight ramp as the lamps
    WINDOW_GLOW_W.value = goldenGateTwilightW
    // Sutro's aviation beacons: faint red by day, blazing after dark
    SUTRO_LIGHTS_INTENSITY.value =
      LIGHT_SCALE * (0.12 * dayW + 0.9 * goldW + 1.9 * nightW)
  }

  /** Advance the cycle, keep the dome centred and the key light anchored ahead. */
  update(elapsed: number, cameraPos: THREE.Vector3) {
    const dt =
      this.#lastElapsed < 0 ? 0 : Math.min(elapsed - this.#lastElapsed, 0.1)
    this.#lastElapsed = elapsed

    if (this.realTime) {
      // default: mirror the real San-Francisco date + clock, wherever the player is
      const now = sanFranciscoCivilNow()
      this.#civilDate = { year: now.year, month: now.month, day: now.day }
      this.timeOfDay = now.hour
      this.#applySun() // the analytic env reads #uSun, so the IBL tracks for free
    } else if (this.cycleEnabled && dt > 0) {
      this.timeOfDay =
        (this.timeOfDay + (dt / Math.max(this.cycleDuration, 5)) * 24) % 24
      this.#applySun()
    }

    this.mesh.position.copy(cameraPos)

    // the light only supplies a direction to the CSM node — it refits and
    // texel-snaps every cascade around the view frustum itself each frame
    this.sun.position.copy(cameraPos).addScaledVector(SUN_DIR, 400)
    this.sun.target.position.copy(cameraPos)
    this.sun.target.updateMatrixWorld()

    if (this.#csm.camera) {
      // one-shot once the node has built: coarser cascades need proportionally
      // larger normal bias (texel size grows roughly 4-5x per cascade)
      if (!this.#csmTuned) {
        this.#csmTuned = true
        this.#applyShadowConfig()
      }
      // Shadow-render throttle: re-rendering all city geometry into the
      // cascades EVERY frame was the single biggest cost in the frame (profiled
      // 4–7 ms, > half the frame in the city). The sun is near-static and the
      // world is static — only the camera moves and shadows are low-frequency —
      // so refit + re-render the cascades every OTHER frame. Skip frames reuse
      // the last depth maps; we must NOT refit on them, or the moved cascade
      // projection would sample the stale texture and shadows would slide. A big
      // camera jump (teleport) forces an immediate update so shadows never blank.
      //
      // On top of that, the coarse FAR cascade (40–350 m) re-renders only every
      // OTHER render frame — a quarter of all frames. Far shadows sit through the
      // marine haze, so a 15 Hz refresh is invisible, and skipping it removes ~half
      // the far cascade's amortized encode. The near cascade (contact shadows the
      // player scrutinises) still refreshes on every render frame, and we only ever
      // call updateFrustums on render frames, so the no-slide invariant that
      // protects the near cascade is unchanged.
      if (!this.#shadowAutoDisabled) {
        this.#shadowAutoDisabled = true
        for (const l of this.#csm.lights) if (l.shadow) l.shadow.autoUpdate = false
      }
      this.#shadowFrame++
      const jump = cameraPos.distanceTo(this.#lastShadowCam) > 50
      if (this.#shadowFrame % 2 === 0 || jump) {
        this.#lastShadowCam.copy(cameraPos)
        this.#csm.updateFrustums() // tracks aspect/fov changes (resize, speed kicks)
        const refreshFar = this.#shadowFrame % 4 === 0 || jump
        const lights = this.#csm.lights
        for (let i = 0; i < lights.length; i++) {
          const l = lights[i]
          // cascade 0 = the near/contact cascade (always); the rest are far (staggered)
          if (l.shadow && (i === 0 || refreshFar)) l.shadow.needsUpdate = true
        }
      }
    }
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
