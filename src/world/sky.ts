import * as THREE from "three/webgpu"
import {
  Fn,
  If,
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
  output,
  saturate,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  vec3,
  vec4
} from "three/tsl"
import { registerSkyAtmosphere } from "./skyRegistry"
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
import { createStreamedStaticCasterWarmup } from "./shadows/streamedCasterWarmup"
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
import {
  distanceHazeHalfOpacityM,
  FOG_EDGE_END_FRACTION,
  FOG_EDGE_START_FRACTION,
  FOG_EXTINCTION_LENGTH_M,
  FOG_TOP_VARIATION_M,
  resolveFogParameters
} from "./fogParameters"

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
  // scales the low-sun/night fill (moon key, sky/IBL night palette,
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
  // The persisted key remains `hemiDay` for tuning compatibility, but the fill
  // now comes from the analytic sky environment rather than a scene light.
  hemiDay: { v: 0.9, min: 0, max: 2.6, step: 0.05, label: "day sky fill (IBL)" }
})

// The dome/IBL counter-boost: authored 0..1 sky colours were graded to read
// as-authored under the reference exposure (7 ≈ 1/0.13 pre-rebase, carried
// through the exposure re-anchor so the dome renders identically).
const SKY_DOME_BOOST = 7.0 * EXPOSURE_REBASE
// Analytic-environment intensity that replaces the old 0.9 HemisphereLight at
// the reference day grade. This gives matte materials soft sky/ground bounce
// without spending one of the scene's two actual light slots.
const SKY_IBL_REFERENCE_INTENSITY = 0.24

// Live light direction (world space, pointing toward the dominant light — the sun
// by day, the moon by night). Mutated by Sky; other modules (water) hold a
// reference and read it every frame.
export const SUN_DIR = new THREE.Vector3(-0.52, 0.42, -0.28).normalize()

/**
 * The true solar geometry behind SUN_DIR. SUN_DIR flips to the anti-solar
 * (moon) direction after dusk, so features that key off the hour of the day —
 * golden hour, sunset backlighting — cannot read its `y` and must read this.
 * Mutated by Sky every frame alongside SUN_DIR.
 */
export const SUN_STATE = {
  /** Degrees above the horizon; negative after sunset. */
  elevationDeg: 45,
  /** Degrees clockwise from true north. */
  azimuthDeg: 180,
  /** True once SUN_DIR has handed over to the moon. */
  moonlit: false,
  /** True sun direction, still pointing below the horizon at night. */
  toSun: new THREE.Vector3(-0.52, 0.42, -0.28).normalize()
}
const WARM_SUN = new THREE.Color(0xfff4e8) // midday sun tint, lerped toward as it climbs

// TSL node generics fight composition; any is the idiom here (see facade.ts)
type N = any

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
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
// Octave budget for the two fog fields. Three's stock triNoise3D runs four
// domain-warped octaves, and this graph calls it twice — ~280 ALU per fragment
// compiled into EVERY fogged material in the world, at every overdraw layer.
// Octaves 3 and 4 land at 12–42 m features, well under what the
// smoothstep(0.25, 0.9) billow ramp and the distance-integrated opacity can
// resolve, so fogTriNoise stops at two and remaps the result back onto the
// four-octave distribution. Measured over 60k world samples at three phases:
// gain/bias reproduce the reference mean (0.286) and sd (0.091) exactly, the
// fields correlate 0.91, and the billow term differs by a median of 0.07.
const FOG_NOISE_OCTAVES = 2
const FOG_NOISE_GAIN = 1.094
const FOG_NOISE_BIAS = 0.0695
// Void fog wall (M18): mean free path INSIDE the wall medium at unit density.
// Short — the wall must read near-opaque ~3 lengths past the bubble edge.
const FOG_WALL_EXTINCTION_LENGTH = 40
// SF's broad flat districts do not intersect the noisy ceiling as often as the
// reference's mountain terrain. A symmetric, mean-preserving density swing makes
// the same octaves read as rolling pockets over streets and water.
const FOG_DENSITY_MIN = 0.6
const FOG_DENSITY_MAX = 1.4
// Floating-world guard. The marine bank may wash geometry TOWARD the fog
// colour but never fully erase it: an uncapped bank whose colour sits on the
// horizon gradient turns every fogged hillside and building base into "sky",
// so ridge tops, lit roof rows and lone towers read as crescents and boxes
// floating above nothing (the Sutro Baths window/flyover artifact). Capping
// the bank keeps ~10% of the surface's own colour at full wash — a silhouette,
// not a hole. The cull-edge veil is unioned separately and still completes to
// a full fade, so the streamed edge keeps hiding pop-in.
const FOG_BANK_MAX = 0.78
// Colour grade for fragments deep inside the marine layer: the bank's body
// takes a slightly deeper tone than the shared horizon fog colour, so a fogged
// coastline reads as a fog DECK sitting under the sky instead of as sky
// itself — the other half of the floating-world read. The grade fades back to
// the shared colour across the cull-edge veil (the dome handoff must keep its
// exact colour match) and collapses to identity when weather fog is off.
const FOG_DECK_TONE = 0.86
const FOG_SKY_BLEND_HEIGHT = 0.08 // match the visible horizon over its lowest ~5°
const FOG_GOLD_LIGHT = 0.48 // neutral dusk fog: dimmer, never orange/grey
const FOG_NIGHT_LIGHT = 0.12 // moonlit bank without a daylight-white night seam
const FOG_WEATHER_UPDATE_SECONDS = 0.2
const LIVE_FOG_BLEND_HALFLIFE_SECONDS = 90
const LIVE_FOG_TARGET_HALFLIFE_SECONDS = 180
const LIVE_FOG_EXIT_HALFLIFE_SECONDS = 2.5

// Two-octave fork of three's triNoise3D (node_modules/three/src/nodes/math/
// TriNoise3D.js) — same tri/tri3 domain warp, same 1.8/1.5/1.2 lacunarity, it
// just stops early and rescales; see the FOG_NOISE_* constants above for the
// measurement. The octave loop is unrolled at graph-build time, so no Loop node
// reaches WGSL. One shared graph feeds scene.fogNode, so this adds no material
// variants — it only shrinks the function every fogged shader already calls.
const fogTri = Fn(([x]: [N]) => x.fract().sub(0.5).abs()).setLayout({
  name: "fogTri",
  type: "float",
  inputs: [{ name: "x", type: "float" }]
})

const fogTri3 = Fn(([p]: [N]) =>
  vec3(
    fogTri(p.z.add(fogTri(p.y))),
    fogTri(p.z.add(fogTri(p.x))),
    fogTri(p.y.add(fogTri(p.x)))
  )
).setLayout({
  name: "fogTri3",
  type: "vec3",
  inputs: [{ name: "p", type: "vec3" }]
})

const fogTriNoise = Fn(([position, time]: [N, N]) => {
  const p = vec3(position).toVar()
  const bp = vec3(position).toVar()
  const rz = float(0).toVar()
  // z is the reference's per-octave amplitude divisor (1.4 × 1.5^n). Unrolled it
  // is a compile-time constant, so it stays a JS number rather than a shader var.
  let z = 1.4
  for (let i = 0; i < FOG_NOISE_OCTAVES; i++) {
    const dg = vec3(fogTri3(bp.mul(2))).toVar()
    p.addAssign(dg.add(time.mul(0.1 * FOG_NOISE_SPEED)))
    bp.mulAssign(1.8)
    z *= 1.5
    p.mulAssign(1.2)
    rz.addAssign(fogTri(p.z.add(fogTri(p.x.add(fogTri(p.y))))).div(z))
    bp.addAssign(0.14)
  }
  return rz.mul(FOG_NOISE_GAIN).add(FOG_NOISE_BIAS)
}).setLayout({
  name: "fogTriNoise",
  type: "float",
  inputs: [
    { name: "position", type: "vec3" },
    { name: "time", type: "float" }
  ]
})

// The dome is camera-locked and its shader is direction-only (it normalises
// positionLocal), so the radius is not a look decision — it is purely how the
// dome sorts against depth. Sizing it above every distance the scene can contain
// lets it be depth-tested safely: the map diagonal is ~20.5 km, which is how far
// water's map-wide `horizon` sheet can sit from a camera at the opposite corner,
// and CONFIG.camera.far is 24 km.
const SKY_DOME_RADIUS = 23000
// Three r185's RenderList.sort() sorts the opaque list ASCENDING by renderOrder
// (painterSortStable) and then REVERSES the whole list when the camera runs a
// reversed depth buffer — so renderOrder effectively resolves DESCENDING here.
// A large negative order therefore draws the dome LAST, so depth rejects every
// pixel the city, terrain and water already own and the radiance shader's four
// pow() lobes, star hash and fog backdrop mix run only on real sky.
//
// THE SIGN IS LOAD-BEARING, and it rests on TWO facts about renderCore.ts —
// verify BOTH before trusting it:
//   1. createRenderCore constructs the renderer with `reversedDepthBuffer: true`
//      (renderCore.ts). That is the reverse's ONLY trigger: Renderer._updateCamera
//      copies it to camera._reversedDepth, and RenderList.sort() reverses only
//      when that flag is set. Turning reversed-z OFF silently sends the dome back
//      to drawing FIRST — no visual change, just the lost win.
//   2. It installs no custom opaque comparator (no setOpaqueSort anywhere in
//      src/), so painterSortStable is what runs.
// If either changes, flip this to a large POSITIVE order above water's 11.2
// ladder. The fog backdrop is a term inside the dome shader, not a draw-order
// effect, so it is unaffected either way.
const SKY_DOME_RENDER_ORDER = -1000

/**
 * Where the mid-altitude gradient stop sits, in the SAME parameter the gradient
 * already used: t = pow(saturate(d.y), 0.55). 0.55 puts it at d.y ≈ 0.337,
 * about 20° above the horizon — high enough to read as its own band rather than
 * as a thick horizon line, low enough that the zenith still owns the top half.
 *
 * #applySkyPalette's day and night band colours are mix(hor, zen, this) worked
 * out by hand, so changing this constant WITHOUT re-deriving those two triples
 * will tilt the daytime and night sky. Only the gold band is free.
 */
const SKY_BAND_T = 0.55

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
  // Real-clock read cadence. sanFranciscoCivilNow() is Intl.formatToParts — ~4 µs
  // and ~40 transient objects per call, and solarPosition's DST solve calls it
  // once or twice more. Re-reading it every frame bought 0.017° of sun travel, so
  // the wall clock is sampled at 4 Hz instead. -Infinity makes the first frame apply.
  #lastRealClockMs = -Infinity
  // Pacific UTC offset for the real-time path, cached per civil hour and handed to
  // solarPosition so it skips its own civil→UTC DST solve. Hourly (not daily)
  // keeps the two annual DST transitions correct to within the transition hour.
  #realOffsetCache: { hourKey: number; hours: number } | null = null

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
  #uFogEdgeStart = uniform(WORLD_TUNING.values.radius * FOG_EDGE_START_FRACTION)
  #uFogEdgeEnd = uniform(WORLD_TUNING.values.radius * FOG_EDGE_END_FRACTION)
  #uFogEdgeStrength = uniform(0)
  // Start neutral; the constructor resolves all controls + weather before the
  // first live frame instead of briefly assuming a fully fogged backdrop.
  #uFogEnabled = uniform(0)
  #uFogBackdrop = uniform(0)
  // Strength of the FOG_DECK_TONE grade, resolved on the CPU from the live
  // bank density (0 with weather fog off / clear air, so the grade is inert).
  #uFogDeck = uniform(0)
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
  // Uniform-only half of the analytic sky gradient, resolved on the CPU by
  // #applySkyPalette on exactly the same cadence as #uSun itself. three wraps
  // scene.environmentNode in an EnvironmentNode that builds the node TWICE per
  // lit material — a radiance context and an irradiance context, each inside
  // its own isolate(), so nothing is shared — which meant every lit fragment in
  // the world re-derived four smoothstep phase weights and two vec3 palette
  // blends twice, for values that cannot vary across a draw. Plain Vector3s,
  // not Colors: the shader literals these replace are raw vec3, so a Color
  // uniform's working-colour-space conversion would shift the palette.
  #uSkyZenith = uniform(new THREE.Vector3())
  #uSkyHorizon = uniform(new THREE.Vector3())
  /** Mid-altitude band, the third gradient stop. See SKY_BAND_T. */
  #uSkyBand = uniform(new THREE.Vector3())
  /** mix(hor, zen, 0.35) — the hemispheric mean the soften path collapses toward. */
  #uSkyMean = uniform(new THREE.Vector3())
  /** The night-brightness twilight lift, already folded to a colour. */
  #uSkyTwilight = uniform(new THREE.Vector3())
  /** Golden-hour weight; still needed per fragment by the warm horizon wedge. */
  #uSkyGold = uniform(0)
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

  /** Pocket-realm clock override in hours, or null while the world clock runs. */
  #timeAuthority: number | null = null

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
    scene.environmentIntensity = SKY_IBL_REFERENCE_INTENSITY

    // Covered-boot shadow warmup for streamed merged-proxy vertex layouts.
    // This stays shadow-only and degenerate, but retains both static-domain
    // WebGPU node/pipeline cache entries for the lifetime of the world.
    scene.add(createStreamedStaticCasterWarmup())

    this.mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 24),
      this.#buildMaterial()
    )
    this.mesh.scale.setScalar(SKY_DOME_RADIUS)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = SKY_DOME_RENDER_ORDER
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

    this.#fogNode = this.#buildFogNode()
    scene.fog = null
    scene.fogNode = this.#fogNode

    // High-fragment groundcover (grass/flowers) reads these instead of the full
    // analytic IBL + marine fog graph — see grassEnvNode / installGrassFog.
    registerSkyAtmosphere({
      grassEnvNode: () => this.grassEnvNode(),
      installGrassFog: (material) => this.installGrassFog(material)
    })

    // Prefer a persisted local override over the wall clock; otherwise mirror SF time.
    if (this.realTime) this.followRealTime()
    else this.cycleEnabled = true
    this.#updateFogWeather(true)
    // Idempotent, and the only guarantee that the resolved palette matches
    // #uSun before the first update(): the cycle branch above defers #applySun
    // to the first frame, and a dome drawn from a zeroed palette would be black.
    this.#applySkyPalette()
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
    // The phase weights (day/night/golden/low-sun), the zenith and horizon
    // palettes they blend, the twilight lift and the hemispheric mean are all
    // functions of the sun elevation and the night-brightness slider alone —
    // uniform for an entire draw. #applySkyPalette resolves them on the CPU, so
    // what remains below is only the genuinely direction-dependent maths. The
    // raw weights survive in the shader for the point-feature path only, and
    // that path compiles into the camera-locked dome material alone (one draw,
    // depth-rejected behind everything else).
    const zen = this.#uSkyZenith as N
    const hor = this.#uSkyHorizon as N
    const band = this.#uSkyBand as N
    const goldW = this.#uSkyGold as N
    return Fn(() => {
      const mu = dot(d, uSun)

      // Altitude parameter, unchanged: horizon-heavy so the interesting half of
      // the sky gets most of the range.
      const t = pow(saturate(d.y), 0.55)

      // The gradient. THE DOME GETS THREE STOPS, THE IBL GETS TWO — deliberately.
      // A two-stop ramp cannot produce what a real sunset does: it can only walk
      // from orange to blue through the muddy grey in between, where the actual
      // sky goes orange → violet → deep blue. That violet band is most of the
      // difference between "warm sky" and "sunset".
      //
      // The environment path skips it because `#skyRadiance` is built TWICE per
      // lit material (radiance and irradiance contexts, each isolated), so every
      // term here is paid by every lit fragment in the world — the reason the
      // phase weights were moved to the CPU in the first place. The IBL is a
      // soft ambient term that `soften` collapses toward `#uSkyMean` anyway, and
      // the mean already carries the band's energy (see #applySkyPalette), so
      // the lighting picks up dusk's violet without paying for its shape.
      const grad = opts.pointFeatures
        ? mix(mix(hor, band, smoothstep(0, SKY_BAND_T, t)), zen, smoothstep(SKY_BAND_T, 1, t))
        : mix(hor, zen, t)
      const below = smoothstep(0.0, -0.12, d.y)
      const sky = grad.mul(mix(float(1), float(0.35), below)).toVar()
      sky.addAssign(this.#uSkyTwilight as N)

      // Warm wedge gathering around the sun while it grazes the horizon. The
      // vertical reach was ±20° (smoothstep(0.35, …)), which clipped the glow
      // into a band hugging the waterline; a real low sun throws light most of
      // the way up the sky. Widened to ~38°, and it now fades THROUGH the
      // horizon rather than at it, so the water below keeps the warm cast.
      const wedge = pow(saturate(mu), 3.0)
        .mul(goldW)
        .mul(smoothstep(0.62, -0.06, abs(d.y)))
      sky.addAssign(vec3(1.0, 0.44, 0.17).mul(wedge).mul(0.9))

      if (opts.pointFeatures) {
        // Dome only: a broad magenta-leaning wash centred on the sun. This is
        // the term that BENDS the gradient — where it overlaps the violet band
        // the sky reads plum, and where it overlaps the gold wedge it reads
        // ember, so the orange and the blue are joined by a hue arc instead of
        // meeting in grey. Wider in azimuth than the gold wedge (pow 1.5 vs 3)
        // and taller still, so it survives well above the warm band.
        // Reach is the load-bearing number, not strength: let this climb toward
        // the zenith and the whole upper sky turns pink and the deep blue never
        // arrives. It has to die out ABOVE the violet band (~20°) so the band
        // and the zenith own everything higher — the blue is what makes the
        // orange read as sunset rather than as a wash.
        const wash = pow(saturate(mu), 1.5)
          .mul(goldW)
          .mul(smoothstep(0.42, -0.12, abs(d.y)))
        sky.addAssign(vec3(0.62, 0.20, 0.42).mul(wash).mul(0.26))

        // Dome only: the discs, moon and starfield still need the raw weights.
        const el = uSun.y // sun elevation, sin-scaled
        const dayW = smoothstep(0.02, 0.32, el)
        const nightW = smoothstep(-0.1, -0.3, el)
        const lowSunW = smoothstep(0.02, -0.16, el)
        // The foreground can read as night before the sky reaches the formal
        // night band. Let the slider lift low-sun twilight too, otherwise the
        // control appears dead around 18:00-18:30.
        const lowSunLift = mix(float(1), uLift, lowSunW)

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
        const mean = (this.#uSkyMean as N).mul(
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
    const noiseA = fogTriNoise(fogPosition.mul(FOG_NOISE_SCALE_A), nTime)
    const noiseB = fogTriNoise(fogPosition.mul(FOG_NOISE_SCALE_B), nTime.mul(1.2))
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
    //
    // It is a BOUNDED world feature — a 305x238 m ellipse living between y 72
    // and 222 — but it is unioned into the global `clear` below, so until this
    // gate every fogged fragment on an ~11 km map paid its ~60 ALU. Both bounds
    // are hard zeros in the maths itself (mistHeight's two smoothsteps retire
    // outside [minY, maxY]; mistFootprint's smoothstep is 0 at or past 1.08),
    // so skipping on them is bit-identical rather than an approximation. The
    // altitude test is outermost because it is three ops with no setup; the
    // ellipse test nests inside it so inland towers and hilltops still skip the
    // summit carve, the pocket ramp and the height ramp. Both tests vary per
    // fragment, but they are extremely coherent in screen space — a wave only
    // pays when it genuinely straddles the park.
    //
    // Scope note (same rule as clipmapShadowNode.ts): `noiseA`/`noiseB`/`dist`
    // are read INSIDE this block, so they must already be materialized in the
    // enclosing scope. They are: `clear` builds bankFog first (left operand of
    // the chain below), and bankFog consumes both the noise pair and `dist`.
    const buenaVistaMist = Fn(() => {
      const mist = float(0).toVar()
      If(
        y
          .greaterThan(float(BUENA_VISTA_MIST.minY))
          .and(y.lessThan(float(BUENA_VISTA_MIST.maxY))),
        () => {
          const mistX = (positionWorld as N).x.sub(BUENA_VISTA_MIST.x)
          const mistZ = (positionWorld as N).z.sub(BUENA_VISTA_MIST.z)
          const mistCos = Math.cos(BUENA_VISTA_MIST.rotation)
          const mistSin = Math.sin(BUENA_VISTA_MIST.rotation)
          const mistAlong = mistX.mul(mistCos).add(mistZ.mul(mistSin))
          const mistAcross = mistX.mul(-mistSin).add(mistZ.mul(mistCos))
          const mistEllipse = pow(
            mistAlong.div(BUENA_VISTA_MIST.radiusAlong),
            2
          ).add(pow(mistAcross.div(BUENA_VISTA_MIST.radiusAcross), 2))

          If(mistEllipse.lessThan(float(1.08)), () => {
            const mistFootprint = smoothstep(
              float(1.08),
              float(0.72),
              mistEllipse
            )
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
            mist.assign(
              mistFootprint
                .mul(summitClearing.oneMinus())
                .mul(mistHeight)
                .mul(mistPockets)
                .mul(smoothstep(float(24), float(210), dist))
                .mul(BUENA_VISTA_MIST.strength)
                .mul(this.#uFogLocalScale as N)
            )
          })
        }
      )
      return mist
    })()

    // The official noisy ceiling: a fixed-altitude marine bank whose upper edge
    // continually reforms into 100–200 m billows while hills and towers rise clear.
    const top = (this.#uFogTop as N)
      .add(
        fogNoise
          .sub(FOG_NOISE_CENTER)
          .mul(FOG_TOP_VARIATION_M)
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
    // that overlaps the slab [base, top]. A high bird/plane therefore sees a
    // pooled layer beneath it instead of treating the whole kilometre of clear
    // air as fog.
    //
    // CRITICAL: the slab has a FLOOR. The old ramp `saturate((top−y)/depth)`
    // pinned at maximum for every y below `base`, so a sealed room thirty-one
    // metres underground (the Sutro sunken gallery) sat in full bank wash — a
    // sheet of sea mist hanging in a timber gallery, muddy-warm once the room's
    // own lamp grade mixed through FOG_BANK_MAX. Below the authored bank floor
    // is rock and authored interiors, not weather.
    const layerDepth = top.sub(base).max(1)
    const heightRamp = (sampleY: N) =>
      top
        .sub(sampleY)
        .div(layerDepth)
        .saturate()
        .mul(smoothstep(base.sub(1.5), base, sampleY))
        .mul(0.98)
    const surfaceDensity = heightRamp(y)
    const cameraDensity = heightRamp((cameraPosition as N).y)
    const verticalSpan = (cameraPosition as N).y.sub(y).abs().max(0.001)
    const upperEnd = (cameraPosition as N).y.max(y)
    const lowerEnd = (cameraPosition as N).y.min(y)
    // Fraction of the camera→fragment segment that actually overlaps the slab.
    // Both ends below `base` → overlap ≤ 0 → no bank (the underground case).
    const inLayerFraction = top
      .min(upperEnd)
      .sub(base.max(lowerEnd))
      .max(0)
      .div(verticalSpan)
      .saturate()
    const meanRayDensity = surfaceDensity
      .add(cameraDensity)
      .mul(0.5)
      .mul(inLayerFraction)
      .mul(densityShape)
      .mul(regionalDensity)
    const opticalDepth = dist
      .mul(meanRayDensity)
      .mul(this.#uFogBank as N)
      .div(FOG_EXTINCTION_LENGTH_M)
    const bankFog = opticalDepth.negate().exp().oneMinus()

    // The reference exp² distance haze supplies the broad atmospheric falloff.
    const distHaze = densityFogFactor(this.#uFogDensity as N)
    // Finish the streamed-world fade only at the horizontal draw edge. Altitude is
    // irrelevant to the XZ streaming rings and must never whiten geometry below.
    const edgeFade = smoothstep(
      this.#uFogEdgeStart as N,
      this.#uFogEdgeEnd as N,
      horizontalDist
    ).mul(this.#uFogEdgeStrength as N)

    // Void fog wall (M18): Beer-Lambert extinction over the analytic overlap
    // of the camera→fragment ray with the region OUTSIDE the wall circle
    // (2D XZ ray-vs-circle, branch-free: a missed circle yields zero inside
    // length via sqrt(max(disc, 0))). Radius 1e9 → the whole ray is "inside"
    // → zero optical depth → the term collapses when the wall is down.
    //
    // The wall is armed only during the M18 fill phase (#uWallDensity defaults
    // to 0), so in all settled play this resolved to exactly 0 — after paying a
    // sqrt and an exp on every fogged fragment in the world. A uniform If skips
    // it instead; the condition is a uniform-buffer read, so it is uniform
    // control flow for the whole draw and the skip is bit-identical at density
    // 0 (exp(0) - 1 === 0).
    //
    // The block deliberately recomputes its own horizontal ray length rather
    // than sharing `horizontalDist` with the edge fade. `horizontalDist` is
    // consumed inside the weather branch, and WGSL materializes a multiply-used
    // node in the FIRST branch that builds it (clipmapShadowNode.ts:576-582) —
    // reading it from this sibling branch would read a zero-initialized var
    // whenever fog is enabled, which is exactly the case the wall must survive.
    // A distinct node is six ops inside a branch that is off in normal play.
    const wallL = (cameraPosition as N).xz
      .sub((positionWorld as N).xz)
      .length()
      .max(0.001)
    const wallFog = Fn(() => {
      const wall = float(0).toVar()
      If((this.#uWallDensity as N).greaterThan(0), () => {
        const wallDir = (positionWorld as N).xz
          .sub((cameraPosition as N).xz)
          .div(wallL)
        const wallM = (this.#uWallCenter as N).sub((cameraPosition as N).xz)
        const wallB = wallM.dot(wallDir)
        const wallC = wallM
          .dot(wallM)
          .sub((this.#uWallRadius as N).mul(this.#uWallRadius as N))
        const wallS = wallB.mul(wallB).sub(wallC).max(0).sqrt()
        const wallT0 = wallB.sub(wallS).clamp(0, wallL)
        const wallT1 = wallB.add(wallS).clamp(0, wallL)
        wall.assign(
          wallL
            .sub(wallT1.sub(wallT0))
            .mul(this.#uWallDensity as N)
            .div(FOG_WALL_EXTINCTION_LENGTH)
            .negate()
            .exp()
            .oneMinus()
        )
      })
      return wall
    })()

    // Probabilistic union, identical to the reference for bank + haze and extended
    // by only the narrow cull fade: 1 - (1-bank)(1-haze)(1-edge)(1-mist).
    // The bank alone is clamped to FOG_BANK_MAX (floating-world guard); the
    // edge veil still reaches 1 through the union, so the streamed edge fades
    // out completely exactly as before.
    const clear = bankFog
      .min(FOG_BANK_MAX)
      .oneMinus()
      .mul(distHaze.oneMinus())
      .mul(edgeFade.oneMinus())
      .mul(buenaVistaMist.oneMinus())

    // Weather fog honors the user fog toggle; the void WALL does not (it is a
    // streaming shroud, not weather — disabling it would expose the raw world
    // build during the fill phase). Union the two, then the void ramp gates
    // everything (the scan phase is clear black; the wall arms as the dawn
    // brings the void factor down).
    // The switch/master resolves to a uniform boolean for the whole frame. Keep
    // the costly dual tri-noise/weather path inside a coherent GPU branch so a
    // true zero/off state skips it instead of merely multiplying its result by 0.
    // Weather is a property of the open air. A camera below the bank floor is
    // in authored rock, a basement, or the water column — none of which are the
    // marine layer. Zeroing the whole weather term (bank + distance haze +
    // coastal mist) here is what keeps underground rooms clear; per-material
    // `fog = false` is a backup, not the contract. Soft edge so a camera that
    // grazes `FOG_BASE` does not pop.
    const openAir = smoothstep(
      base.sub(0.5),
      base.add(1.5),
      (cameraPosition as N).y
    )
    const weatherFactor = Fn(() => {
      const factor = float(0).toVar()
      If((this.#uFogEnabled as N).greaterThan(0), () => {
        factor.assign(clear.oneMinus().mul(openAir))
      })
      return factor
    })()
    const combinedFactor = float(1).sub(
      weatherFactor.oneMinus().mul(wallFog.oneMinus())
    )

    // Keep the official reference colour in color-managed form. It reads milky
    // white under ACES and now agrees with the visible horizon instead of resolving
    // to the old #4d5358 charcoal attractor.
    //
    // FOG_DECK_TONE grade: deliberately cheap (uniforms + positionWorld only —
    // no noise, no shared branch state; the horizontal distance is recomputed
    // locally for the same WGSL-materialization reason the wall block documents
    // above). Where the veil takes over (deckEdgeKeep → 0) or the CPU resolves
    // clear air (#uFogDeck = 0) the grade is exactly 1 and the colour is
    // bit-identical to the shared horizon fog colour.
    const deckL = (cameraPosition as N).xz
      .sub((positionWorld as N).xz)
      .length()
    const deckEdgeKeep = smoothstep(
      this.#uFogEdgeStart as N,
      this.#uFogEdgeEnd as N,
      deckL
    ).oneMinus()
    const deckDepth = (this.#uFogTop as N)
      .sub(y)
      .div((this.#uFogTop as N).sub(base).max(1))
      .saturate()
    const deckGrade = mix(
      float(1),
      float(FOG_DECK_TONE),
      deckDepth.mul(deckEdgeKeep).mul(this.#uFogDeck as N)
    )
    return tslFog(
      color(FOG_COLOR).mul(this.#uFogLight as N).mul(deckGrade),
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
   * uniforms only. The sun and contextual point light stay at their normal
   * intensity so the avatar reads — the light set never changes (C1). Driven
   * by VoidRealm.update().
   */
  setVoidFactor(v: number) {
    this.#uVoid.value = Math.min(1, Math.max(0, v))
  }

  /** When set, the cull-edge fade pulls in to this radius instead of the streamed
   *  draw radius — lets surf mode tighten tile streaming without a hard seam
   *  popping at the (much closer) unload distance. null restores the default. */
  #cullRadiusOverride: number | null = null
  #streamingCullRadius: number | null = null

  /** Base cull edge owned by the ordinary moving tile working set. Activity
   * overrides (surf, cinematics) still take precedence and can be cleared
   * without losing this baseline. */
  setStreamingCullRadius(r: number | null) {
    this.#streamingCullRadius = r
    this.applyFogParams()
  }

  setCullRadiusOverride(r: number | null) {
    this.#cullRadiusOverride = r
    this.applyFogParams()
  }

  applyFogParams() {
    const v = WORLD_TUNING.values
    const weather = this.#effectiveFog
    // Atmospheric perspective is an artistic/physical property, not a streaming
    // control. Coupling density inversely to the draw radius made a smaller world
    // turn exponentially whiter, so players had to select absurd 60–300 km radii
    // just to see across an 11 km city. Only the narrow cull-edge fade follows the
    // streamed radius; broad haze and the height bank stay in physical metres.
    const edgeR = this.#cullRadiusOverride ?? this.#streamingCullRadius ?? v.radius
    const resolved = resolveFogParameters(v, weather, edgeR)
    this.#uFogDensity.value = resolved.hazeDensityPerM
    this.#uFogTop.value = resolved.layerTopM
    this.#uFogBank.value = resolved.bankDensity
    this.#uFogNoise.value = resolved.billowScale
    this.#uFogFrontX.value = weather.frontX
    this.#uFogFrontWidth.value = weather.frontWidthM
    this.#uFogFrontSkew.value = weather.frontSkew
    this.#uFogMacroPhase.value = weather.macroPhase
    this.#uFogInlandFloor.value = weather.inlandFloor
    this.#uFogGateReach.value = weather.gateReachM
    this.#uFogLocalScale.value = resolved.localDensity
    this.#fogDriftRate = resolved.motionRate
    this.#fogWindX = resolved.windX
    this.#fogWindZ = resolved.windZ
    this.#uFogEdgeStart.value = resolved.edgeStartM
    this.#uFogEdgeEnd.value = resolved.edgeEndM
    this.#uFogEdgeStrength.value = resolved.farWeatherOpacity
    this.#uFogEnabled.value = resolved.weatherEnabled ? 1 : 0
    this.#uFogBackdrop.value = resolved.farWeatherOpacity
    // Deck grade strength follows the live bank density so a barely-there bank
    // barely grades, a real marine layer reads as a deck, and clear air / fog
    // off leaves the colour untouched.
    this.#uFogDeck.value = resolved.weatherEnabled
      ? Math.min(1, resolved.bankDensity * 3)
      : 0
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
    out["weather scales"] = `bank ${this.#effectiveFog.bankScale.toFixed(2)}× · haze ${this.#effectiveFog.hazeScale.toFixed(2)}×`
    const bankDensity = Number(this.#uFogBank.value)
    const hazeDensity = Number(this.#uFogDensity.value)
    const hazeHalfM = distanceHazeHalfOpacityM(hazeDensity)
    out["effective layer"] = bankDensity > 0
      ? `top ${Math.round(Number(this.#uFogTop.value))} m · density ${bankDensity.toFixed(3)}×`
      : "off"
    out["effective haze"] = hazeHalfM === null
      ? "off"
      : `50% at ${(hazeHalfM / 1000).toFixed(1)} km`
    const edgeStrength = Number(this.#uFogEdgeStrength.value)
    out["edge veil"] = edgeStrength > 0.0005
      ? `${Math.round(edgeStrength * 100)}% · ${(Number(this.#uFogEdgeStart.value) / 1000).toFixed(1)}–${(Number(this.#uFogEdgeEnd.value) / 1000).toFixed(1)} km`
      : "off"
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

  /**
   * Hemispheric mean sky radiance — the ambient/downwelling term, in the same
   * linear render space envRadiance() returns. FREE in a shader: #applySkyPalette
   * already resolves it on the CPU at 4 Hz, so this is a uniform read, not a
   * gradient evaluation. Hand-written BRDFs (world/water.ts) use it as their
   * diffuse/in-scatter illuminant instead of paying a second envRadiance().
   */
  ambientRadiance(): N {
    return (this.#uSkyMean as N)
      .mul(SKY_DOME_BOOST)
      .mul(mix(float(1), float(0.018), this.#uVoid as N))
  }

  /**
   * Cheap environment for high-overdraw groundcover. MeshStandard wraps this in
   * EnvironmentNode and evaluates it twice per fragment (radiance + irradiance);
   * the analytic SkyEnvNode pays a full sky gradient on each of those. Grass is
   * roughness ~0.94 so the soften path already collapses toward #uSkyMean — this
   * node is that mean with a one-MAD hemisphere ground bounce, no gradient.
   */
  grassEnvNode(): N {
    return new GrassEnvNode(this) as N
  }

  #grassFogNode: N | null = null

  /**
   * Distance-haze + smooth height-bank fog for groundcover. Drops the two
   * tri-noise marine fields, Buena Vista mist, and coastal-front macros that
   * the shared scene fog carries — those are invisible at blade scale and were
   * ~60% of meadow fragment ALU on M5 Air (docs/PERF_LEVELUP.md Wave 7).
   */
  #buildGrassFogNode(): N {
    const dist = cameraPosition.sub(positionWorld).length()
    const horizontalDist = (cameraPosition as N).xz.sub((positionWorld as N).xz).length()
    const y = (positionWorld as N).y
    const base = float(FOG_BASE) as N
    const distHaze = densityFogFactor(this.#uFogDensity as N)
    const top = this.#uFogTop as N
    const layerDepth = top.sub(base).max(1)
    // Same slab floor as `#buildFogNode`: density is zero below `FOG_BASE`.
    const heightRamp = (sampleY: N) =>
      top
        .sub(sampleY)
        .div(layerDepth)
        .saturate()
        .mul(smoothstep(base.sub(1.5), base, sampleY))
        .mul(0.98)
    const surfaceDensity = heightRamp(y)
    const cameraDensity = heightRamp((cameraPosition as N).y)
    const bankFog = dist
      .mul(surfaceDensity.add(cameraDensity).mul(0.5))
      .mul(this.#uFogBank as N)
      .div(FOG_EXTINCTION_LENGTH_M)
      .negate()
      .exp()
      .oneMinus()
    const edgeFade = smoothstep(
      this.#uFogEdgeStart as N,
      this.#uFogEdgeEnd as N,
      horizontalDist
    ).mul(this.#uFogEdgeStrength as N)
    const openAir = smoothstep(
      base.sub(0.5),
      base.add(1.5),
      (cameraPosition as N).y
    )
    const weatherFactor = Fn(() => {
      const factor = float(0).toVar()
      If((this.#uFogEnabled as N).greaterThan(0), () => {
        factor.assign(
          bankFog
            .min(FOG_BANK_MAX)
            .oneMinus()
            .mul(distHaze.oneMinus())
            .mul(edgeFade.oneMinus())
            .oneMinus()
            .mul(openAir)
        )
      })
      return factor
    })()
    return tslFog(
      color(FOG_COLOR).mul(this.#uFogLight as N),
      weatherFactor.mul((this.#uVoid as N).oneMinus())
    )
  }

  /** Bind the cheap groundcover fog onto a MeshStandard/SSS material instance. */
  installGrassFog(material: { fog: boolean; setupFog: (...args: any[]) => any }): void {
    if (!this.#grassFogNode) this.#grassFogNode = this.#buildGrassFogNode()
    const fogNode = this.#grassFogNode
    material.fog = true
    material.setupFog = (_builder: unknown, outputNode: N) => {
      output.assign(outputNode)
      return vec4(fogNode.toVar())
    }
  }

  /** Re-run the sun/IBL pass after a day-grade tunable (sunDay/hemiDay)
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
    this.#timeAuthority = null
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
    this.#timeAuthority = null
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
    this.#timeAuthority = null
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

  /**
   * Pocket-realm clock (the Sutro Baths' out-of-time twilight).
   *
   * While an authority is set the dome, IBL, fog palette and every light ramp
   * follow these hours instead of the SF wall clock or a running day cycle.
   * Unlike setTimeOfDay this deliberately does NOT clear `realTime`/`cycleEnabled`,
   * so `setTimeAuthority(null)` hands the world clock straight back on the next
   * sample with no stash to restore and no way to leak a pinned sky. Only the
   * palette-side work runs per change: the fog-weather resample keeps its own
   * cadence in update(), and the live-fog/starlink feeds are left alone because
   * a pocket interior must not disturb what the outdoor world is fetching.
   */
  setTimeAuthority(hours: number | null) {
    if (hours === null) {
      if (this.#timeAuthority === null) return
      this.#timeAuthority = null
      this.#lastRealClockMs = Number.NEGATIVE_INFINITY // re-sample the real clock next update
      return
    }
    const wrapped = ((hours % 24) + 24) % 24
    if (this.#timeAuthority !== null && Math.abs(wrapped - this.#timeAuthority) < 1e-4) return
    this.#timeAuthority = wrapped
    this.timeOfDay = wrapped
    this.#civilDay = Math.floor(this.#civilDay) + wrapped / 24
    this.#applySun()
  }

  get timeAuthority(): number | null {
    return this.#timeAuthority
  }

  /** Snap to the current real SF date+time and keep mirroring it every frame —
   *  the default sky. Wherever the player is, the game reads the SF wall clock. */
  followRealTime() {
    this.#timeAuthority = null
    this.realTime = true
    this.cycleEnabled = false
    const now = sanFranciscoCivilNow()
    // this IS the 4 Hz sample, so update() does not immediately repeat it
    this.#lastRealClockMs = performance.now()
    this.#simulatedUtcOffsetHours = sfUtcOffsetHours({ ...now, hour: 12 })
    this.#civilDay = sfCivilScalarDays(now)
    this.timeOfDay = now.hour
    this.#applySun()
    this.#updateFogWeather(true)
    this.#reconcileLiveFogFeed()
    this.#reconcileStarlinkSky()
  }

  /** Pacific offset for the live clock, resolved at most once per civil hour.
   *  Passing it to solarPosition removes its iterative civil→UTC DST solve, which
   *  is another one or two Intl.formatToParts calls per evaluation. */
  #realUtcOffsetHours(civil: SfCivilTime): number {
    const hourKey = Math.floor(this.#civilDay * 24)
    let cached = this.#realOffsetCache
    if (!cached || cached.hourKey !== hourKey) {
      cached = { hourKey, hours: sfUtcOffsetHours(civil) }
      this.#realOffsetCache = cached
    }
    return cached.hours
  }

  /**
   * CPU transcription of the uniform-only half of #skyRadiance — see the
   * #uSky* uniform declarations for why. Runs on exactly the same cadence as
   * #uSun (4 Hz in real-time mode, per-frame while a cycle scrubs), which is
   * the only input besides the night-brightness slider.
   *
   * EVERY edge pair, constant and multiply below must stay byte-for-byte the
   * same expression as the shader it replaced, or the sky and the IBL drift
   * apart across the day. `smooth01` is the same clamp((x - a) / (b - a)) form
   * WGSL's smoothstep uses, which is what makes the deliberately DESCENDING
   * pairs (night, low sun) ramp as authored.
   */
  #applySkyPalette() {
    const el = (this.#uSun.value as THREE.Vector3).y // sun elevation, sin-scaled
    const lift = this.#nightLift
    // phase weights: day fades out as the sun drops, night fades in below ~-6°,
    // golden hour owns the gap
    const dayW = smooth01(0.02, 0.32, el)
    const nightW = smooth01(-0.1, -0.3, el)
    const goldW = (1 - dayW) * (1 - nightW)
    const lowSunW = smooth01(0.02, -0.16, el)
    // mix(1, lift, lowSunW) — the slider lifts low-sun twilight, not just night
    const lowSunLift = 1 + (lift - 1) * lowSunW
    // moonlit night: the night palette carries a faint starlight/moonglow floor
    // (feeds the IBL too, so surfaces pick it up), scaled by the night
    // brightness slider
    const nightLit = nightW * lowSunLift
    const zen = this.#uSkyZenith.value as THREE.Vector3
    zen.set(
      0.12 * dayW + 0.055 * goldW + 0.022 * nightLit,
      0.34 * dayW + 0.085 * goldW + 0.032 * nightLit,
      0.8 * dayW + 0.36 * goldW + 0.062 * nightLit
    )
    const hor = this.#uSkyHorizon.value as THREE.Vector3
    hor.set(
      0.58 * dayW + 0.86 * goldW + 0.07 * nightLit,
      0.75 * dayW + 0.36 * goldW + 0.098 * nightLit,
      0.9 * dayW + 0.19 * goldW + 0.15 * nightLit
    )
    // The mid band (see SKY_BAND_T). Day and night deliberately carry the exact
    // colour the old two-stop gradient already produced at that height —
    // mix(hor, zen, SKY_BAND_T) evaluated by hand — so adding a third stop
    // leaves noon and midnight bit-identical and changes only dusk. Gold is the
    // one genuinely new authored colour in this function: the violet that makes
    // a sunset read as a sunset rather than as an orange-to-blue ramp.
    const band = this.#uSkyBand.value as THREE.Vector3
    band.set(
      0.364 * dayW + 0.25 * goldW + 0.0436 * nightLit,
      0.5245 * dayW + 0.145 * goldW + 0.0617 * nightLit,
      0.855 * dayW + 0.38 * goldW + 0.1016 * nightLit
    )
    // Hemispheric mean for the IBL's roughness collapse. The weights are chosen
    // so that, wherever `band` sits on the line between hor and zen (day and
    // night, by construction above), this reproduces the previous
    // mix(hor, zen, 0.35) EXACTLY: 0.47 + 0.40·(1−t) = 0.65 and
    // 0.13 + 0.40·t = 0.35 at t = SKY_BAND_T. Dusk therefore gains the band's
    // contribution to ambient light without shifting any other hour.
    const mean = this.#uSkyMean.value as THREE.Vector3
    mean.set(
      0.47 * hor.x + 0.4 * band.x + 0.13 * zen.x,
      0.47 * hor.y + 0.4 * band.y + 0.13 * zen.y,
      0.47 * hor.z + 0.4 * band.z + 0.13 * zen.z
    )
    const twilight = goldW * lowSunW * (lift - 1)
    ;(this.#uSkyTwilight.value as THREE.Vector3).set(
      0.014 * twilight,
      0.02 * twilight,
      0.038 * twilight
    )
    this.#uSkyGold.value = goldW
  }

  #applySun() {
    const civil = this.civilTime
    const pos = solarPosition(
      civil,
      undefined,
      undefined,
      this.realTime
        ? this.#realUtcOffsetHours(civil)
        : this.#simulatedUtcOffsetHours
    )
    this.sunElevation = pos.elevation
    this.sunAzimuth = pos.azimuth
    this.#sunVec.set(pos.x, pos.y, pos.z)
    SUN_STATE.elevationDeg = pos.elevation
    SUN_STATE.azimuthDeg = pos.azimuth
    SUN_STATE.moonlit = pos.elevation <= -2
    SUN_STATE.toSun.copy(this.#sunVec)
    ;(this.#uSun.value as THREE.Vector3).copy(this.#sunVec)
    this.#applySkyPalette()

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
    const skyFill =
      SKY_TUNING.values.hemiDay * dayW +
      EXPOSURE_REBASE * lowSunLift * (3.8 * goldW + 3.1 * nightW)
    this.#scene.environmentIntensity =
      SKY_IBL_REFERENCE_INTENSITY * skyFill / 0.9
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

    if (this.#timeAuthority !== null) {
      // A pocket realm owns the clock; setTimeAuthority already pushed the sun.
    } else if (this.realTime) {
      // default: mirror the real San-Francisco date + clock, wherever the player is.
      // Sampled at 4 Hz — see #lastRealClockMs — because the ephemeris read is ICU
      // work and the sun moves 0.0042° per frame.
      const nowMs = performance.now()
      if (nowMs - this.#lastRealClockMs >= 250) {
        this.#lastRealClockMs = nowMs
        const now = sanFranciscoCivilNow()
        this.#civilDay = sfCivilScalarDays(now)
        this.timeOfDay = now.hour
        this.#applySun() // the analytic env reads #uSun, so the IBL tracks for free
      }
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

/**
 * Groundcover environment: sky mean + a one-MAD ground bounce. EnvironmentNode
 * still samples this twice per fragment, but each sample is a uniform read and
 * a mix — not the full analytic sky gradient SkyEnvNode pays.
 */
class GrassEnvNode extends THREE.TempNode {
  static get type() {
    return "GrassEnvNode"
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
    const skyCol = this.#sky.ambientRadiance()
    // Cool, darkened ground bounce so blades facing down don't pick up a second
    // sky wash. Tuned to read as turf shade, not a second sun.
    const ground = skyCol.mul(vec3(0.2, 0.26, 0.16))
    const w = saturate((dir as N).y.mul(0.5).add(0.5))
    return mix(ground, skyCol, w)
  }
}
