import * as THREE from "three/webgpu"
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js"
import {
  Fn,
  abs,
  cameraPosition,
  densityFogFactor,
  dot,
  float,
  floor,
  fog as tslFog,
  fract,
  hash,
  mix,
  mx_noise_float,
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
import { BAY_LIGHTS_INTENSITY } from "./bayLights"
import { GOLDEN_GATE_LIGHTS_INTENSITY } from "./goldenGateLights"
import { SUTRO_LIGHTS_INTENSITY } from "./sutroTower"
import { LIGHT_SCALE, RENDER_TUNING, SHADOW_QUALITY, WORLD_TUNING, type ShadowQuality } from "../config"
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
  }
})

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

// three-way palette blend for the JS-side lights/fog (shader does its own)
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
  },
  // fog tracks the sky's *horizon* tint per phase so the haze band reads as the
  // same air as the dome, not a dark smudge in front of it. The old gold/night
  // values were near-black cool tones while the dusk horizon is warm — against
  // a low sun that made distant geometry fade to black. These mirror
  // the shader horizon colours (warm dusty rose at golden hour, a moonlit
  // blue-grey after dark) so far tiles melt into the sky instead of silhouetting.
  fog: {
    day: new THREE.Color(0xccdae2),
    gold: new THREE.Color(0xc9a794),
    night: new THREE.Color(0x475369)
  },
  // Directional sun-glow the fog picks up when you look toward the sun: the marine
  // haze scatters sunlight, so it warms to gold on the sunward side and stays the
  // neutral `fog` tint (a moonlit blue-grey after dark) away from it. Applied by an
  // amount that's near-zero at night, so night fog just reads bluish.
  fogGlow: {
    day: new THREE.Color(0xe9d6b4),
    gold: new THREE.Color(0xf4b878),
    night: new THREE.Color(0x000000)
  }
}

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
  #fogColor = new THREE.Color(0xc6d6df)
  #uFogColor = uniform(this.#fogColor.clone())
  #uFogDensity = uniform(WORLD_TUNING.values.fog)
  #uFogBase = uniform(WORLD_TUNING.values.fogBase)
  #uFogTop = uniform(WORLD_TUNING.values.fogTop)
  #uFogBank = uniform(WORLD_TUNING.values.fogBank)
  #uFogSoftness = uniform(WORLD_TUNING.values.fogSoftness)
  #uFogNoise = uniform(WORLD_TUNING.values.fogNoise)
  #uFogScale = uniform(WORLD_TUNING.values.fogScale)
  #uFogDrift = uniform(WORLD_TUNING.values.fogDrift)
  #uFogStart = uniform(WORLD_TUNING.values.fogStart)
  #uFogMarine = uniform(WORLD_TUNING.values.fogMarine)
  #uFogFloor = uniform(WORLD_TUNING.values.fogFloor)
  #uFogPeak = uniform(WORLD_TUNING.values.fogPeak)
  #uFogHorizon = uniform(WORLD_TUNING.values.fogHorizon)
  #uFogHorizonStart = uniform(WORLD_TUNING.values.fogHorizonStart)
  #uFogHorizonSoftness = uniform(WORLD_TUNING.values.fogHorizonSoftness)
  // reference near-white marine base (three's webgpu_custom_fog groundColor). The
  // ground bank lerps white → phase-atmospheric by `fogTint`; the far veil always
  // stays atmospheric so distant geometry melts into the sky, not into a white band.
  #uFogWhite = uniform(new THREE.Color(0xd0dee7))
  #uFogTint = uniform(WORLD_TUNING.values.fogTint)
  // directional sun-glow tint (warms the fog toward the sun) — see PALETTE.fogGlow
  #fogGlow = new THREE.Color(0x000000)
  #uFogGlow = uniform(this.#fogGlow.clone())
  #uFogGlowAmt = uniform(0)
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
    this.sun.shadow.mapSize.set(2048, 2048)
    const cam = this.sun.shadow.camera
    cam.near = 0.5
    cam.far = 1400
    this.sun.shadow.bias = -0.0002 // CSM scales this ×(cascade index + 1)
    this.sun.shadow.normalBias = 0.25 // near-cascade value; coarser cascades bumped in update()
    scene.add(this.sun)
    scene.add(this.sun.target)

    // Cascaded shadow maps: one tight cascade hugging the player (~4cm texels —
    // the old single 440m map was ~11cm), a mid cascade for the block around,
    // and a coarse far cascade out to 600m. Each cascade texel-snaps its own
    // frustum every frame, which kills the shimmer the single sliding map had,
    // and `fade` cross-blends the seams. The ortho left/right/top/bottom above
    // are irrelevant — the node refits each cascade from the view frustum.
    this.#csm = new CSMShadowNode(this.sun, {
      cascades: 3,
      maxFar: 600,
      mode: "custom",
      customSplitsCallback: (
        _amount: number,
        _near: number,
        far: number,
        target: number[]
      ) => {
        target.push(35 / far, 150 / far, 1)
      },
      lightMargin: 400 // catch tall up-light casters (towers) at grazing dusk angles
    })
    this.#csm.fade = true
    ;(this.sun.shadow as any).shadowNode = this.#csm
    this.setShadowQuality(RENDER_TUNING.values.shadowQuality as ShadowQuality)

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
   * Output counters the photometric exposure (×7) so authored 0..1 colours read as
   * authored.
   */
  #skyRadiance(d: N, opts: { pointFeatures: boolean; soften?: N }): N {
    const uSun = this.#uSun as N
    const uLift = this.#uNightLift as N
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
        return mix(sky, mean, saturate(opts.soften).mul(0.8)).mul(7.0)
      }

      return sky.mul(7.0)
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
      pointFeatures: true
    })
    return mat
  }

  /**
   * The marine-layer density field over the city, 0..1 in world XZ. San Francisco's
   * fog is a Pacific marine layer: it's a wall at Ocean Beach / the Sunset, floods
   * in through the Golden Gate over the Presidio, and thins out over downtown and
   * the sheltered east bay. `westness` is a smooth W→E ramp; a Gaussian lobe at the
   * Gate draws the bank inland; a very-large-scale slow noise advects the whole
   * front east and west so the edge "rolls" over minutes, not seconds. Pure ALU,
   * evaluated per fragment at its own world position, so distant western geometry
   * genuinely reads foggier than distant eastern geometry.
   */
  #marineField(): N {
    const px = (positionWorld as N).x
    const pz = (positionWorld as N).z
    // W→E ramp: full fog west of x≈-3200 (Ocean Beach / outer Sunset), clear by
    // x≈+1700 (downtown / FiDi).
    const westness = smoothstep(float(1700), float(-3200), px)
    // Golden Gate inflow lobe (bridge ≈ (-2982,-2798)); reaches the Presidio + the
    // northern waterfront so that corridor stays socked in even a bit east.
    const gx = px.sub(-2982).mul(1 / 2700)
    const gz = pz.sub(-2798).mul(1 / 2400)
    const gate = gx.mul(gx).add(gz.mul(gz)).negate().exp()
    const stable = westness.max(gate.mul(0.9))
    // slow, very-large-scale advection (~3 km features) so the front breathes
    const roll = mx_noise_float(
      vec3(px, float(0), pz)
        .mul(0.00034)
        .add((vec3(1, 0, 0.35) as N).mul(time.mul((this.#uFogDrift as N).mul(0.5))))
    )
      .mul(0.5)
      .add(0.5)
    return saturate(stable.mul(mix(float(0.82), float(1.18), roll)).add(roll.sub(0.5).mul(0.22)))
  }

  // Structure follows three's `webgpu_custom_fog` example (a ground-hugging band
  // with a noise-wobbled top, unioned with distance haze) but adds the SF marine
  // field so density varies by region, and keeps a near-fade + a phase-tracked,
  // brighter-when-pooled fog colour.
  #buildFogNode(): N {
    const dist = cameraPosition.sub(positionWorld).length()
    const base = this.#uFogBase as N
    const y = (positionWorld as N).y

    // marine field → per-region density multipliers. `fogMarine` (0..1) lerps
    // between "uniform fog everywhere" and "full coast-heavy gradient".
    const marine = this.#marineField()
    const region = mix(float(1), marine, this.#uFogMarine as N)
    const bankScale = mix(this.#uFogFloor as N, this.#uFogPeak as N, region)
    // the distance haze leans coastal (coast fogs sooner) but never below 1× —
    // downtown must still fog out at long range so distant geometry densifies
    // everywhere, not just at the coast.
    const distScale = mix(float(1), float(1.4), region)

    // animated two-octave volumetric noise (three's built-in fog noise) churns the
    // top of the bank so the marine layer boils and drifts rather than sitting as a
    // flat lid. The drift knob feeds triNoise3D's time so it's one control.
    const nScale = this.#uFogScale as N
    const nTime = time.mul((this.#uFogDrift as N).mul(6))
    const noiseA = triNoise3D((positionWorld as N).mul(nScale), 0.2, nTime)
    const noiseB = triNoise3D(
      (positionWorld as N).mul(nScale.mul(2.1)).add(vec3(11.3, 0, 7.7)),
      0.2,
      nTime.mul(1.25)
    )
    const fogNoise = noiseA.add(noiseB)

    // ground-hugging band: solid from `fogBase` up, fading out through a noisy top
    // (one-sided — real marine layer fills everything below, no bottom cutoff). The
    // noise raises/lowers the top edge (scaled by edge softness) into drifting wisps.
    const top = (this.#uFogTop as N)
      .add(
        fogNoise
          .sub(0.7)
          .mul((this.#uFogSoftness as N).mul(0.6))
          .mul(this.#uFogNoise as N) // "billow" slider: 0 = flat lid, 1 = full wisps
      )
      .max(base.add(1))
    const groundRamp = top.sub(y).div(top.sub(base)).saturate()
    // near-fade so the first ~60 m around the camera stay clear — the player is
    // never whited out in their own valley — then the bank builds in over ~250 m so
    // you're not walled into dense fog the moment you leave the clear bubble.
    const nearFade = smoothstep(
      this.#uFogStart as N,
      (this.#uFogStart as N).add(250),
      dist
    )
    const bankFog = groundRamp
      .mul(nearFade)
      .mul((this.#uFogBank as N).mul(bankScale))
      .saturate()

    // exp² distance haze (three's densityFogFactor, view-Z based) — the draw-distance
    // lever. The coast fogs a little sooner (distScale ≥ 1) but downtown is never
    // thinned below the global base, so distant geometry densifies everywhere.
    const distHaze = densityFogFactor((this.#uFogDensity as N).mul(distScale))
    // far horizon veil: a GLOBAL blanket over the last stretch to the tile edge,
    // region-independent so the whole draw distance melts into the sky evenly (you
    // can't see downtown from Ocean Beach, and the radius can sit low). This is the
    // unified far-cull — not a separate grey height fog.
    const horizonVeil = smoothstep(
      this.#uFogHorizonStart as N,
      (this.#uFogHorizonStart as N).add((this.#uFogHorizonSoftness as N).max(1)),
      dist
    ).mul(this.#uFogHorizon as N)

    // union-composite (probabilistic OR) instead of adding: 1 - ∏(1 - layer). Two
    // moderate layers no longer sum into muddy over-fog in the mid-range, yet where
    // any layer is near-opaque (the far edge) the union still slams shut.
    const clear = bankFog
      .oneMinus()
      .mul(distHaze.oneMinus())
      .mul(horizonVeil.oneMinus())
    // clamp near 1.0 (was 0.985) so the far veil genuinely closes — distant emissive
    // landmarks (bridge lights, Sutro beacons, FiDi) no longer punch through a residual
    // gap; the last stretch to the tile edge goes fully opaque.
    const total = clear.oneMinus().clamp(0, 0.997)

    // The pooled ground bank reads brighter and whiter than the distance haze —
    // a lit marine layer catching skylight, not the horizon smog. Lift the tint
    // toward luminous white in proportion to how much of the fog here is bank, so
    // the sea of fog in the valleys glows while far tiles still melt into the
    // matched horizon colour. (uFogColor already tracks the phase of day, so at
    // night this lifts a dark base only a little — moody, not glowing.)
    const bankShare = (bankFog.div(total.max(0.001)).saturate() as N).mul(0.85)

    // Directional sun-glow: the haze scatters sunlight, so it warms toward gold on
    // the sunward side of the sky and stays the neutral phase tint elsewhere. View
    // ray · sun direction, sharpened, scaled by a day/gold-weighted amount (≈0 at
    // night → night fog just reads bluish). Makes far geometry melt into the actual
    // colour of the sky behind it instead of a flat grey band.
    const viewDir = (positionWorld as N).sub(cameraPosition).normalize()
    const sunAlign = saturate(dot(viewDir, this.#uSun as N))
    const glow = pow(sunAlign as N, float(2.5)).mul(this.#uFogGlowAmt as N) as N
    const litColor = mix(this.#uFogColor as N, this.#uFogGlow as N, glow as N) as N

    // Bank colour = the reference near-white marine base with a slider-controlled
    // amount of the phase-atmospheric `litColor` bled in (fogTint: 0 = pure white,
    // 1 = fully atmospheric). The FAR end keeps pure `litColor` so distant geometry
    // melts into the actual sky; the pooled ground bank glows luminous white (lifted
    // a touch for a lit-marine-layer feel). `bankShare` crossfades between them.
    const bankBase = mix(this.#uFogWhite as N, litColor, this.#uFogTint as N) as N
    const bankBright = bankBase.mul(1.12).add(vec3(0.02, 0.03, 0.04)) as N
    const fogCol = mix(litColor, bankBright, bankShare as N)

    return tslFog(fogCol as N, total as N)
  }

  applyFogParams() {
    const v = WORLD_TUNING.values
    this.#uFogDensity.value = v.fog
    this.#uFogBase.value = v.fogBase
    this.#uFogTop.value = v.fogTop
    this.#uFogBank.value = v.fogBank
    this.#uFogSoftness.value = v.fogSoftness
    this.#uFogNoise.value = v.fogNoise
    this.#uFogScale.value = v.fogScale
    this.#uFogDrift.value = v.fogDrift
    this.#uFogStart.value = v.fogStart
    this.#uFogMarine.value = v.fogMarine
    this.#uFogFloor.value = v.fogFloor
    this.#uFogPeak.value = v.fogPeak
    this.#uFogHorizon.value = v.fogHorizon
    this.#uFogHorizonStart.value = v.fogHorizonStart
    this.#uFogHorizonSoftness.value = v.fogHorizonSoftness
    this.#uFogTint.value = v.fogTint
    this.#scene.fog = null
    this.#scene.fogNode = v.fogEnabled ? this.#fogNode : null
  }

  /** Environment radiance for the IBL: no point features, roughness-softened. */
  envRadiance(dir: N, level: N): N {
    return this.#skyRadiance(dir, { pointFeatures: false, soften: level })
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

  setShadowQuality(quality: ShadowQuality) {
    const q = SHADOW_QUALITY[quality] ?? SHADOW_QUALITY.low
    const mapSize = Math.max(1, q.mapSize)
    this.sun.castShadow = q.enabled
    this.sun.shadow.mapSize.set(mapSize, mapSize)
    this.sun.shadow.needsUpdate = true
    this.#csm.maxFar = Math.max(1, q.maxFar)
    this.#csm.lightMargin = q.lightMargin
    for (let i = 0; i < this.#csm.lights.length; i++) {
      const l = this.#csm.lights[i]
      l.castShadow = q.enabled
      if (l.shadow) {
        l.shadow.mapSize.set(mapSize, mapSize)
        l.shadow.normalBias = q.normalBias[i] ?? q.normalBias[q.normalBias.length - 1]
        l.shadow.needsUpdate = true
      }
    }
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

    // key light: the sun while it's up (photometric ~100 at noon, dimming and
    // warming toward the horizon), handed over to a cold full moon at night —
    // bright enough to read the player by, scaled by the night brightness slider
    const nb = this.#nightLift
    const lowSunLift = 1 + (nb - 1) * lowSunW
    const sinEl = Math.sin(THREE.MathUtils.degToRad(elevation))
    if (elevation > -2) {
      const transmittance = Math.sqrt(Math.max(sinEl, 0))
      this.sun.color
        .set(0xffb072)
        .lerp(WARM_SUN, transmittance)
      this.sun.intensity = 100 * transmittance
      SUN_DIR.copy(this.#sunVec)
    } else {
      this.sun.color.set(0xa8bfe6)
      this.sun.intensity = 6.2 * lowSunLift * smooth01(1.5, 10, -elevation)
      SUN_DIR.copy(this.#sunVec).negate() // the moon is the light source now
    }

    this.hemi.intensity =
      14 * dayW + 3.8 * lowSunLift * goldW + 3.1 * lowSunLift * nightW
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
    blend3(
      this.#fogColor,
      PALETTE.fog.day,
      PALETTE.fog.gold,
      PALETTE.fog.night,
      dayW,
      goldW,
      nightW
    )
    ;(this.#uFogColor.value as THREE.Color).copy(this.#fogColor)
    // directional sun-glow tint + how strongly to apply it (rich at golden hour, a
    // little by day, ~nil at night so the fog stays cool blue-grey after dark)
    blend3(
      this.#fogGlow,
      PALETTE.fogGlow.day,
      PALETTE.fogGlow.gold,
      PALETTE.fogGlow.night,
      dayW,
      goldW,
      nightW
    )
    ;(this.#uFogGlow.value as THREE.Color).copy(this.#fogGlow)
    this.#uFogGlowAmt.value = dayW * 0.4 + goldW * 0.85

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
        this.setShadowQuality(RENDER_TUNING.values.shadowQuality as ShadowQuality)
      }
      // Shadow-render throttle: re-rendering all city geometry into the 3
      // cascades EVERY frame was the single biggest cost in the frame (profiled
      // 4–7 ms, > half the frame in the city). The sun is near-static and the
      // world is static — only the camera moves and shadows are low-frequency —
      // so refit + re-render the cascades every OTHER frame. Skip frames reuse
      // the last depth maps; we must NOT refit on them, or the moved cascade
      // projection would sample the stale texture and shadows would slide. A big
      // camera jump (teleport) forces an immediate update so shadows never blank.
      if (!this.#shadowAutoDisabled) {
        this.#shadowAutoDisabled = true
        for (const l of this.#csm.lights) if (l.shadow) l.shadow.autoUpdate = false
      }
      this.#shadowFrame++
      const jump = cameraPos.distanceTo(this.#lastShadowCam) > 50
      if (this.#shadowFrame % 2 === 0 || jump) {
        this.#lastShadowCam.copy(cameraPos)
        this.#csm.updateFrustums() // tracks aspect/fov changes (resize, speed kicks)
        for (const l of this.#csm.lights) if (l.shadow) l.shadow.needsUpdate = true
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
