import * as THREE from "three/webgpu"
import { CSMShadowNode } from "three/addons/csm/CSMShadowNode.js"
import {
  Fn,
  abs,
  dot,
  float,
  floor,
  fract,
  hash,
  mix,
  normalize,
  positionLocal,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  vec3
} from "three/tsl"
import { CROWN_INTENSITY } from "./salesforceCrown"
import { BAY_LIGHTS_INTENSITY } from "./bayLights"
import { GOLDEN_GATE_LIGHTS_INTENSITY } from "./goldenGateLights"
import { PALACE_GLOW_INTENSITY } from "./palaceGlow"
import { SUTRO_LIGHTS_INTENSITY } from "./sutroTower"
import { LIGHT_SCALE, RENDER_TUNING, SHADOW_QUALITY, WORLD_TUNING, type ShadowQuality } from "../config"
import { tunables } from "../core/persist"

// Hours on the 24h clock where each session starts: warm pre-sunset, not restored
// from the last visit (scrubbing still works within a session).
export const PRE_SUNSET_TIME = 15.48

// Day/night cycle tuning, bound in the "/" panel's lighting folder (persisted).
// timeOfDay: hours 0..24 — 6 sunrise, 18 sunset, but the sun is capped low so
// the hours between hold at just-before-golden-hour, never bright midday.
// cycleDuration: real seconds for a full 24h lap. Sky instance fields seed
// from these.
// sunsetAzimuth: compass angle (three.js spherical θ, degrees) the sun sits at
// during the golden-hour anchor t=15.0 — drag it to park the sunset anywhere on
// the horizon circle. θ180 = north (-z), θ270 = west (-x); the Golden Gate
// bears ~θ232 from downtown, ~θ262 from Coit.
export const SKY_TUNING = tunables("sky", {
  timeOfDay: { v: 18.48, min: 0, max: 24, step: 0.01, label: "time of day" },
  sunsetAzimuth: {
    v: 224,
    min: 0,
    max: 360,
    step: 1,
    label: "sunset azimuth (°)"
  },
  cycleEnabled: { v: true, label: "day/night cycle" },
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
  // the dusk-locked sky that made distant geometry fade to black. These mirror
  // the shader horizon colours (warm dusty rose at golden hour, a moonlit
  // blue-grey after dark) so far tiles melt into the sky instead of silhouetting.
  fog: {
    day: new THREE.Color(0xc6d6df),
    gold: new THREE.Color(0xc49e8b),
    night: new THREE.Color(0x455168)
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
 * Time runs on a full 24h clock, but the cycle is dusk-locked: the sun never
 * climbs past ~12°, so the loop holds at just-before-golden-hour through the
 * daytime hours, then moves through sunset, twilight, night, and sunrise with
 * no bright midday. `cycleEnabled`/`cycleDuration` animate it (default: a day
 * lasts 10 real minutes); `setTimeOfDay` jumps it directly.
 */
export class Sky {
  mesh: THREE.Mesh
  sun: THREE.DirectionalLight
  hemi: THREE.HemisphereLight
  timeOfDay = PRE_SUNSET_TIME
  sunsetAzimuth = SKY_TUNING.values.sunsetAzimuth
  cycleEnabled = true // start cycling; this field then acts as a per-session on/off toggle
  cycleDuration = SKY_TUNING.values.cycleDuration

  #scene: THREE.Scene
  #sunVec = new THREE.Vector3() // true sun direction (may point below the horizon)

  // sky shader uniforms
  #uSun = uniform(new THREE.Vector3(0, 1, 0))
  #uNightLift = uniform(SKY_TUNING.values.nightBrightness)

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

    scene.fog = new THREE.FogExp2(0xc6d6df, WORLD_TUNING.values.fog)

    this.setTimeOfDay(PRE_SUNSET_TIME)
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

  /** Environment radiance for the IBL: no point features, roughness-softened. */
  envRadiance(dir: N, level: N): N {
    return this.#skyRadiance(dir, { pointFeatures: false, soften: level })
  }

  setTimeOfDay(hours: number) {
    this.timeOfDay = ((hours % 24) + 24) % 24
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
    const t = this.timeOfDay
    // dusk-locked arc: the sun tops out at ~12° so the brightest the day ever
    // gets is the warm slot just before golden hour; sunrise/sunset climb out
    // of the golden band in about an hour, and midnight still dives to -72°
    // for a real night.
    const phase = ((t - 6) / 24) * Math.PI * 2
    const s = Math.sin(phase)
    const elevation = s > 0 ? 12 * Math.pow(s, 0.85) : 72 * s
    // 360° per 24h so the sweep is continuous across midnight; sunsetAzimuth
    // (the "/" panel slider) pins where on the horizon the sun sits at the
    // golden-hour anchor t=15.0
    const azimuth = this.sunsetAzimuth + (t - 15) * 15

    this.#sunVec.setFromSphericalCoords(
      1,
      THREE.MathUtils.degToRad(90 - elevation),
      THREE.MathUtils.degToRad(azimuth)
    )
    ;(this.#uSun.value as THREE.Vector3).copy(this.#sunVec)

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
    const fog = this.#scene.fog as THREE.FogExp2 | null
    if (fog)
      blend3(
        fog.color,
        PALETTE.fog.day,
        PALETTE.fog.gold,
        PALETTE.fog.night,
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
    // Golden Gate architectural lighting: visible at sunset, brilliant at night.
    GOLDEN_GATE_LIGHTS_INTENSITY.value =
      LIGHT_SCALE * (0.55 * dayW + 2.1 * goldW + 3.0 * nightW)
    // palace floodlights: off in daylight, warming through golden hour
    PALACE_GLOW_INTENSITY.value =
      LIGHT_SCALE * (0.03 * dayW + 0.62 * goldW + 1.35 * nightW)
    // Sutro's aviation beacons: faint red by day, blazing after dark
    SUTRO_LIGHTS_INTENSITY.value =
      LIGHT_SCALE * (0.12 * dayW + 0.9 * goldW + 1.9 * nightW)
  }

  /** Advance the cycle, keep the dome centred and the key light anchored ahead. */
  update(elapsed: number, cameraPos: THREE.Vector3) {
    const dt =
      this.#lastElapsed < 0 ? 0 : Math.min(elapsed - this.#lastElapsed, 0.1)
    this.#lastElapsed = elapsed

    if (this.cycleEnabled && dt > 0) {
      this.timeOfDay =
        (this.timeOfDay + (dt / Math.max(this.cycleDuration, 5)) * 24) % 24
      this.#applySun() // the analytic env reads #uSun, so the IBL tracks for free
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
      this.#csm.updateFrustums() // tracks aspect/fov changes (resize, speed kicks)
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
