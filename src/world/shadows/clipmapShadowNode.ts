import * as THREE from "three/webgpu"
import {
  Fn,
  If,
  float,
  mix,
  nodeObject,
  positionWorld,
  renderGroup,
  smoothstep,
  uniform,
  vec2,
  vec4
} from "three/tsl"
import {
  ShadowDiagnostics,
  SHADOW_UPDATE_REASON,
  type ShadowUpdateReason
} from "./diagnostics"
import { SHADOW_LAYERS, type ShadowLayer } from "./shadowLayers"
import type { FarOcclusionField } from "./farOcclusionField"
import { SHADOW_DEFAULTS } from "./defaults"
import { CLIPMAP_SHADOW_EDGES } from "./edgeConfig"
import { SHADOW_TUNING } from "./tuning"
import { composeRasterAtlasVisibility } from "./visibilityComposition"
import { tracer } from "../../core/hitchTracer"
import { motionGate } from "../../core/motionGate"

// M6 hitch closure: streamed caster attaches arrive in bursts (a ring sweep or
// a citygen district publish invalidates every frame for seconds — pre-M6 that
// meant a FULL static-domain redraw every frame). A redraw that includes
// first-ever-drawn casters costs ~250 ms of GPU (measured; redraws of already
// drawn content are cheap), so mid-burst redraws are the storm. Invalidations
// now latch per-domain dirt and apply when the burst QUIETS (no invalidation
// for QUIET_MS), with MAX_DEFER_MS bounding staleness while a burst stays hot.
// A lone streamed attach redraws ≤ QUIET_MS later — imperceptible next to the
// content's own birth fade. Dirt is never dropped.
// Quiet must exceed the typical intra-burst attach gap (~300 ms tile cadence)
// or every attach re-qualifies as "quiet" and redraws anyway; the defer bound
// keeps shadows within a few seconds of streamed content (content itself
// birth-fades over ~1.5 s, so a late shadow reads as part of the fade).
const STATIC_REDRAW_QUIET_MS = 450
const STATIC_REDRAW_MAX_DEFER_MS = 4000
// M7: while the ring coordinator's materialize front is actively sweeping
// (boot or a far teleport arrival), static-domain redraws are held entirely —
// streamed casters are holo-dark under the front, so their shadows are
// visually free to defer — and the latched dirt applies as one redraw per
// domain (frame-staggered, as always) when the sweep settles. The safety
// bound re-enables the normal quiet/defer applies if a sweep somehow never
// settles (a stalled expansion must not freeze shadows forever).
const STREAMING_HOLD_MAX_MS = 60_000
// M10: a full static-domain redraw whose casters were streamed in under the
// hold pays their first-ever shadow-pass draws (render objects + pipelines) in
// one frame — measured ~40-140 ms warm, hundreds cold. Never apply two static
// domain redraws closer than this, and give the settle moment itself a cushion
// (the hold release stamps the same timer) so the redraws land as isolated,
// spaced frames after the reveal instead of stacking on the settle burst.
const STATIC_REDRAW_MIN_INTERVAL_MS = 700
// M11 stillness routing: a ~40-60 ms full-domain redraw frame is imperceptible
// while the view is still (the presented image barely changes and motion isn't
// interrupted) but reads as a blip during a pan/walk. A due redraw therefore
// waits for visual stillness; a continuously moving view forces it after
// STATIC_REDRAW_MOTION_FORCE_MS — measured from when the redraw first became
// APPLICABLE (due + unheld), NOT from dirtySince: hold-era dirt can be tens of
// seconds old and would otherwise force instantly at settle. Motion-forced
// redraws also space wider than still ones so two blips never cluster.
const STATIC_REDRAW_MOTION_FORCE_MS = 6000
const STATIC_REDRAW_MOTION_MIN_INTERVAL_MS = 1600
// M10 visual: the first static redraws after a streaming-hold release contain
// every caster the whole sweep streamed in — at low sun that flips entire
// streets into building shade in ONE frame (a hard lighting pop at the settle
// moment, screenshot-verified). Those redraws instead fade the domain's
// contribution in over this window (shadow.intensity is a reactive reference
// uniform in r185 ShadowNode — no recompiles). Ordinary streamed redraws keep
// their instant apply: their deltas are small and birth-fade-adjacent.
const POST_HOLD_INTRO_FADE_MS = 1500
const POST_HOLD_INTRO_WINDOW_MS = 10_000

export const CLIPMAP_SHADOW_CONFIG = {
  hero: {
    extent: 32,
    resolution: 1024,
    depth: 480,
    normalBias: SHADOW_DEFAULTS.heroNormalBias,
    depthBias: SHADOW_DEFAULTS.heroDepthBias,
    anchorStep: 0,
    sunAngle: 0,
    layer: SHADOW_LAYERS.HERO_DYNAMIC
  },
  local: {
    extent: 96,
    resolution: 1536,
    depth: 900,
    normalBias: SHADOW_DEFAULTS.localNormalBias,
    depthBias: SHADOW_DEFAULTS.localDepthBias,
    // Cached projections stay world-correct while the subject moves. Recenter
    // only before the 6 m local→far guard band is consumed.
    anchorStep: 4.5,
    sunAngle: THREE.MathUtils.degToRad(0.05),
    layer: SHADOW_LAYERS.LOCAL_STATIC
  },
  far: {
    extent: 1024,
    resolution: 1024,
    depth: 1800,
    normalBias: SHADOW_DEFAULTS.farNormalBias,
    depthBias: SHADOW_DEFAULTS.farDepthBias,
    anchorStep: 8,
    sunAngle: THREE.MathUtils.degToRad(0.15),
    layer: SHADOW_LAYERS.FAR_PROXY
  }
} as const

/**
 * Projection samples must be fully retired before a PCF footprint touches a
 * map boundary. Ending a fade at (or beyond) the camera extent can still expose
 * a clamped edge texel as a long screen-space wedge under a grazing sun.
 */
type DomainId = keyof typeof CLIPMAP_SHADOW_CONFIG
export type StaticShadowScope = "local" | "far" | "all"
type DomainConfig = (typeof CLIPMAP_SHADOW_CONFIG)[DomainId]
type N = any

/** Render one domain and record only completed map updates. */
class DomainShadowNode extends THREE.ShadowNode {
  readonly #onRendered: () => void

  constructor(
    light: THREE.Light,
    shadowConfig: THREE.DirectionalLight["shadow"],
    onRendered: () => void
  ) {
    super(light, shadowConfig)
    this.#onRendered = onRendered
  }

  renderShadow(frame: any): void {
    // A ShadowNode reached from Renderer.render() is nested after r185's outer
    // scene matrix walk. Skip that redundant walk for each shadow domain. The
    // compileAsync path never increments _callDepth and may only update its
    // compile object—not frame.scene—so it deliberately retains the base walk.
    const renderer = frame.renderer as THREE.WebGPURenderer & { _callDepth?: number }
    if (!(Number(renderer._callDepth) > 0)) {
      ;(THREE.ShadowNode.prototype as any).renderShadow.call(this, frame)
      return
    }
    const scene = frame.scene as THREE.Scene
    const previousAutoUpdate = scene.matrixWorldAutoUpdate
    try {
      scene.matrixWorldAutoUpdate = false
      ;(THREE.ShadowNode.prototype as any).renderShadow.call(this, frame)
    } finally {
      scene.matrixWorldAutoUpdate = previousAutoUpdate
    }
  }

  updateShadow(frame: any): void {
    // Completion means the whole base update finished: depth render, optional
    // VSM, camera-layer restoration, and renderer/scene state restoration.
    ;(THREE.ShadowNode.prototype as any).updateShadow.call(this, frame)
    this.#onRendered()
  }
}

/** A non-illuminating directional-light stand-in owned only by ShadowNode. */
class ProjectionLight extends THREE.Object3D {
  readonly target = new THREE.Object3D()
  readonly shadow: THREE.DirectionalLight["shadow"]
  castShadow = true

  constructor(shadowConfig: THREE.DirectionalLight["shadow"]) {
    super()
    this.shadow = shadowConfig
  }
}

type Domain = {
  id: DomainId
  config: DomainConfig
  light: ProjectionLight
  node: N
  /** Tuning strength; shadow.intensity = strengthBase * intro-fade factor. */
  strengthBase: number
  /** performance.now() when a post-hold intro fade began (0 = no fade). */
  introFadeAt: number
  initialized: boolean
  lastAnchor: THREE.Vector3
  lastSunDir: THREE.Vector3
  lastStaticRevision: number
  pendingReason: ShadowUpdateReason
}

const WORLD_UP = new THREE.Vector3(0, 1, 0)
const FALLBACK_UP = new THREE.Vector3(0, 0, 1)

/**
 * Player-centric selective shadow maps:
 *
 * - hero: dynamic silhouettes, every displayed frame;
 * - local: cached nearby static proxies;
 * - far: cached coarse massing proxies.
 *
 * The maps use fixed light-space extents, so camera FOV, orbit, shake and indoor
 * handoffs cannot resize or phase-shift their texels. Static and dynamic shadow
 * factors are composed under the one real sun rather than adding extra lights.
 */
export class ClipmapShadowNode extends THREE.ShadowBaseNode {
  readonly diagnostics = new ShadowDiagnostics(
    (Object.entries(CLIPMAP_SHADOW_CONFIG) as [DomainId, DomainConfig][]).map(
      ([id, config]) => ({
        id,
        resolution: config.resolution,
        extentMeters: config.extent
      })
    )
  )

  /** Compatibility/debug surface used by existing probes and the inspector. */
  readonly lights: ProjectionLight[]

  #domains: Domain[]
  #farOcclusion: FarOcclusionField | null
  #focusUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #heroCenterUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #heroRightUniform = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup)
  #heroUpUniform = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup)
  #localCenterUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #localRightUniform = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup)
  #localUpUniform = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup)
  #farCenterUniform = uniform(new THREE.Vector3()).setGroup(renderGroup)
  #farRightUniform = uniform(new THREE.Vector3(1, 0, 0)).setGroup(renderGroup)
  #farUpUniform = uniform(new THREE.Vector3(0, 1, 0)).setGroup(renderGroup)
  #enabledUniform = uniform(SHADOW_TUNING.values.enabled ? 1 : 0).setGroup(renderGroup)
  #farFieldStrengthUniform = uniform(SHADOW_TUNING.values.farFieldStrength).setGroup(renderGroup)
  #enabled = SHADOW_TUNING.values.enabled
  #frame = 0
  #localStaticRevision = 0
  #farStaticRevision = 0
  #localStaticDirty = false
  #farStaticDirty = false
  #localStaticInvalidatedAt = -Infinity
  #farStaticInvalidatedAt = -Infinity
  #localStaticDirtySince = -Infinity
  #farStaticDirtySince = -Infinity
  #localMotionDeferSince = -Infinity
  #farMotionDeferSince = -Infinity
  #streamingHold = false
  #streamingHoldSince = 0
  #lastStaticRedrawAt = -Infinity
  #holdReleaseFadeUntil = -Infinity
  #right = new THREE.Vector3()
  #shadowUp = new THREE.Vector3()
  #snapped = new THREE.Vector3()

  constructor(light: THREE.DirectionalLight, farOcclusion: FarOcclusionField | null = null) {
    super(light)
    this.#farOcclusion = farOcclusion
    this.#domains = (Object.entries(CLIPMAP_SHADOW_CONFIG) as [DomainId, DomainConfig][]).map(
      ([id, config]) => this.#createDomain(id, config)
    )
    this.lights = this.#domains.map((domain) => domain.light)
    this.applyTuning()
  }

  get staticRevision(): number {
    return Math.max(this.#localStaticRevision, this.#farStaticRevision)
  }

  /** Latch a static-caster change; the redraw applies (burst-coalesced) in schedule(). */
  invalidateStatic(scope: StaticShadowScope = "all"): void {
    const now = performance.now()
    if (scope !== "far") {
      if (!this.#localStaticDirty) this.#localStaticDirtySince = now
      this.#localStaticDirty = true
      this.#localStaticInvalidatedAt = now
    }
    if (scope !== "local") {
      if (!this.#farStaticDirty) this.#farStaticDirtySince = now
      this.#farStaticDirty = true
      this.#farStaticInvalidatedAt = now
    }
    tracer.count("shadowInvalidate")
  }

  /** M7 streaming-burst hint (see STREAMING_HOLD_MAX_MS). Idempotent; lone
   *  events outside a sweep keep the normal quiet-window apply path. */
  setStreamingHold(active: boolean): void {
    if (active === this.#streamingHold) return
    this.#streamingHold = active
    if (active) this.#streamingHoldSince = performance.now()
    // Release cushion: the settle frame already carries the reveal + citygen
    // settle swaps; the held redraws start one interval later and stay spaced.
    else {
      const now = performance.now()
      this.#lastStaticRedrawAt = now
      this.#holdReleaseFadeUntil = now + POST_HOLD_INTRO_WINDOW_MS
    }
  }

  /** True while the M7 streaming hold is active (bounded by its safety cap). */
  #holdActive(nowMs: number): boolean {
    return this.#streamingHold && nowMs - this.#streamingHoldSince < STREAMING_HOLD_MAX_MS
  }

  /** True when this domain's latched dirt should redraw now: its invalidation
   *  burst has quieted, or the deferral bound expired while the burst stays hot. */
  #staticRedrawDue(nowMs: number, invalidatedAt: number, dirtySince: number): boolean {
    return (
      nowMs - invalidatedAt >= STATIC_REDRAW_QUIET_MS ||
      nowMs - dirtySince >= STATIC_REDRAW_MAX_DEFER_MS
    )
  }

  /** Promote latched dirt into revision bumps once per burst (bounded defer).
   *  Local and far never apply on the same frame — the two full-domain map
   *  redraws land on different frames, halving the worst single-frame cost. */
  #applyPendingStaticInvalidations(nowMs: number): void {
    if (this.#holdActive(nowMs)) {
      if (this.#localStaticDirty || this.#farStaticDirty) {
        tracer.count("shadowRedrawHeldStreaming")
      }
      return
    }
    // M10: global spacing — a domain redraw with fresh casters is one big
    // frame; two of them must never land within the same perceptual moment.
    // M11: prefer landing redraws in visual stillness (see
    // STATIC_REDRAW_MOTION_FORCE_MS above); moving views widen the spacing.
    const still = motionGate.isStill(nowMs)
    const minIntervalMs = still
      ? STATIC_REDRAW_MIN_INTERVAL_MS
      : STATIC_REDRAW_MOTION_MIN_INTERVAL_MS
    if (nowMs - this.#lastStaticRedrawAt < minIntervalMs) return
    if (
      this.#localStaticDirty &&
      this.#staticRedrawDue(nowMs, this.#localStaticInvalidatedAt, this.#localStaticDirtySince)
    ) {
      if (this.#localMotionDeferSince === -Infinity) this.#localMotionDeferSince = nowMs
      if (still || nowMs - this.#localMotionDeferSince >= STATIC_REDRAW_MOTION_FORCE_MS) {
        this.#localStaticDirty = false
        this.#localMotionDeferSince = -Infinity
        this.#localStaticRevision = (this.#localStaticRevision + 1) >>> 0
        this.#lastStaticRedrawAt = nowMs
        this.#beginIntroFadeIfPostHold("local", nowMs)
        tracer.count("shadowStaticRedrawLocal")
        tracer.count(still ? "shadowRedrawStillHidden" : "shadowRedrawMotionForced")
        return
      }
      tracer.count("shadowRedrawHeldMotion")
    }
    if (
      this.#farStaticDirty &&
      this.#staticRedrawDue(nowMs, this.#farStaticInvalidatedAt, this.#farStaticDirtySince)
    ) {
      if (this.#farMotionDeferSince === -Infinity) this.#farMotionDeferSince = nowMs
      if (still || nowMs - this.#farMotionDeferSince >= STATIC_REDRAW_MOTION_FORCE_MS) {
        this.#farStaticDirty = false
        this.#farMotionDeferSince = -Infinity
        this.#farStaticRevision = (this.#farStaticRevision + 1) >>> 0
        this.#lastStaticRedrawAt = nowMs
        this.#beginIntroFadeIfPostHold("far", nowMs)
        tracer.count("shadowStaticRedrawFar")
        tracer.count(still ? "shadowRedrawStillHidden" : "shadowRedrawMotionForced")
        return
      }
      tracer.count("shadowRedrawHeldMotion")
    }
  }

  /** Start a contribution fade for a static domain's first redraw after a
   *  streaming-hold release (see POST_HOLD_INTRO_FADE_MS). */
  #beginIntroFadeIfPostHold(id: DomainId, nowMs: number): void {
    if (nowMs >= this.#holdReleaseFadeUntil) return
    for (let i = 0; i < this.#domains.length; i++) {
      const domain = this.#domains[i]
      if (domain.id === id && domain.introFadeAt === 0) {
        domain.introFadeAt = nowMs
        tracer.count("shadowIntroFade")
        return
      }
    }
  }

  /** Apply persisted/live pane values without rebuilding materials or shadow maps. */
  applyTuning(): void {
    const values = SHADOW_TUNING.values
    const wasEnabled = this.#enabled
    this.#enabled = Boolean(values.enabled)
    this.#enabledUniform.value = this.#enabled ? 1 : 0
    this.#farFieldStrengthUniform.value = values.farFieldStrength

    const byDomain = {
      hero: {
        strength: values.heroStrength,
        normalBias: values.heroNormalBias,
        depthBias: values.heroDepthBias
      },
      local: {
        strength: values.localStrength,
        normalBias: values.localNormalBias,
        depthBias: values.localDepthBias
      },
      far: {
        strength: values.farStrength,
        normalBias: values.farNormalBias,
        depthBias: values.farDepthBias
      }
    } as const

    for (const domain of this.#domains) {
      const next = byDomain[domain.id]
      const wasActive = domain.light.shadow.intensity > 0
      domain.strengthBase = next.strength
      domain.light.shadow.intensity = next.strength
      domain.light.shadow.normalBias = next.normalBias
      domain.light.shadow.bias = next.depthBias
      const active = this.#enabled && next.strength > 0
      if (active && (!wasEnabled || !wasActive)) domain.initialized = false
      if (!active) domain.light.shadow.needsUpdate = false
    }
  }

  /** Schedule map refreshes before the owning render call. */
  schedule(focus: THREE.Vector3, sunDirection: THREE.Vector3, nowMs = performance.now()): void {
    this.#focusUniform.value.copy(focus)
    this.diagnostics.beginFrame(++this.#frame, nowMs)
    if (!this.#enabled) return
    if (SHADOW_TUNING.values.farFieldStrength > 0) {
      this.#farOcclusion?.update(sunDirection, focus, nowMs)
    }
    this.#applyPendingStaticInvalidations(nowMs)

    for (let i = 0; i < this.#domains.length; i++) {
      const domain = this.#domains[i]
      // M10 post-hold intro fade: ramp the domain's contribution back in after
      // its held redraw applied (shadow.intensity is a reactive reference).
      if (domain.introFadeAt > 0) {
        const k = (nowMs - domain.introFadeAt) / POST_HOLD_INTRO_FADE_MS
        if (k >= 1) {
          domain.introFadeAt = 0
          domain.light.shadow.intensity = domain.strengthBase
        } else {
          domain.light.shadow.intensity = domain.strengthBase * Math.max(0.02, k * k)
        }
      }
      if (domain.light.shadow.intensity <= 0) continue
      let reason: ShadowUpdateReason = 0

      if (!domain.initialized) reason |= SHADOW_UPDATE_REASON.INITIAL
      if (domain.id === "hero") reason |= SHADOW_UPDATE_REASON.EVERY_FRAME

      const movedSq = focus.distanceToSquared(domain.lastAnchor)
      if (domain.initialized && domain.config.anchorStep > 0 && movedSq >= domain.config.anchorStep ** 2) {
        reason |= movedSq >= 50 * 50
          ? SHADOW_UPDATE_REASON.TELEPORT
          : SHADOW_UPDATE_REASON.ANCHOR_MOVED
      }

      // M10: a slow real-sun drift crossing the threshold re-renders the WHOLE
      // domain — including every caster streamed in since the last redraw,
      // whose first-ever shadow-pass draws (render objects + pipelines) land
      // in one frame (observed as a ~170-pipeline spike at the settle moment).
      // Static-domain sun crossings therefore never re-render directly: they
      // LATCH the domain's static dirt and let #applyPendingStaticInvalidations
      // pace them (streaming hold, quiet window, global min-interval). The
      // redraw re-places with the CURRENT sun, so nothing is lost; lastSunDir
      // updates only when a render fires, keeping the latch idempotent.
      // Anchor/teleport recenters stay live — they are correctness.
      if (domain.initialized && domain.config.sunAngle > 0) {
        const dot = THREE.MathUtils.clamp(domain.lastSunDir.dot(sunDirection), -1, 1)
        if (Math.acos(dot) >= domain.config.sunAngle) {
          if (domain.id === "hero") reason |= SHADOW_UPDATE_REASON.SUN_MOVED
          else this.invalidateStatic(domain.id === "local" ? "local" : "far")
        }
      }

      if (
        domain.id !== "hero" &&
        domain.initialized &&
        domain.lastStaticRevision !== this.#staticRevisionFor(domain.id)
      ) {
        reason |= SHADOW_UPDATE_REASON.STREAM_CHANGED
      }

      if (reason === 0) continue
      this.#placeDomain(domain, focus, sunDirection)
      domain.light.shadow.needsUpdate = true
      domain.initialized = true
      domain.lastAnchor.copy(focus)
      domain.lastSunDir.copy(sunDirection)
      domain.lastStaticRevision = this.#staticRevisionFor(domain.id)
      domain.pendingReason |= reason
    }
  }

  setup(_builder: unknown) {
    const [hero, local, far] = this.#domains.map((domain) => domain.node)
    const heroCenter = this.#heroCenterUniform
    const heroRight = this.#heroRightUniform
    const heroUp = this.#heroUpUniform
    const localCenter = this.#localCenterUniform
    const localRight = this.#localRightUniform
    const localUp = this.#localUpUniform
    const farCenter = this.#farCenterUniform
    const farRight = this.#farRightUniform
    const farUp = this.#farUpUniform
    const enabled = this.#enabledUniform
    const farFieldStrength = this.#farFieldStrengthUniform
    const farField = this.#farOcclusion?.replacementSampleNode() ?? null
    return Fn((builder: any) => {
      this.setupShadowPosition(builder)
      const visibility = (vec4(1) as N).toVar()

      // Use a radial metric in the light's projection plane. All samples retire
      // inside the square texture, but the transition has no square isocontour
      // that can become visible on broad, low-sun shadow fields.
      const heroOffset = positionWorld.sub(heroCenter)
      const heroAxisRight = heroOffset.dot(heroRight).abs()
      const heroAxisUp = heroOffset.dot(heroUp).abs()
      const heroRadius = vec2(heroAxisRight, heroAxisUp).length()
      const heroFadeEnd = CLIPMAP_SHADOW_CONFIG.hero.extent * 0.5
        - CLIPMAP_SHADOW_EDGES.hero.sampleMarginMeters
      const heroEdgeWeight = smoothstep(
        heroFadeEnd - CLIPMAP_SHADOW_EDGES.hero.fadeMeters,
        heroFadeEnd,
        heroRadius
      ).oneMinus()
      // This continuous weight is already zero inside the valid map boundary;
      // no branch or out-of-domain edge texel can become a visible hard line.
      visibility.mulAssign(mix(1, hero as N, heroEdgeWeight))

      // Representation handoffs use the same projection-plane radius. A broad
      // local feather makes the composition stable for every caster set and sun
      // angle rather than attempting to special-case oversized projections.
      const localOffset = positionWorld.sub(localCenter)
      const localRadius = vec2(
        localOffset.dot(localRight),
        localOffset.dot(localUp)
      ).length()
      // Fade the far raster to lit before its own light-space square boundary.
      // When the world atlas is faded out this is the visible layer; without the
      // feather its 1024 m frustum edge draws a hard rotated square across the
      // fog. Interior far radii are unaffected (fade weight is 1 there), so the
      // atlas handoff and normal daytime far coverage are unchanged.
      const farOffset = positionWorld.sub(farCenter)
      const farRadius = vec2(
        farOffset.dot(farRight),
        farOffset.dot(farUp)
      ).length()
      const farHalfExtent = CLIPMAP_SHADOW_CONFIG.far.extent * 0.5
      const farFadeEnd = farHalfExtent - CLIPMAP_SHADOW_EDGES.far.sampleMarginMeters
      const farEdgeFade = smoothstep(
        farFadeEnd - CLIPMAP_SHADOW_EDGES.far.fadeMeters,
        farFadeEnd,
        farRadius
      ).oneMinus()
      // WGSL materializes each TSL node once, inside the FIRST branch that
      // references it; any other branch would read a zero-initialized private
      // var. The domain ShadowNode samples and the shared atlas sample must
      // therefore each be referenced from exactly ONE branch (or none), never
      // from two arms of an If/ElseIf/Else. Each sample lands in a pre-declared
      // neutral var via its own single-purpose gate, and the composition below
      // is pure branch-free weight math over those vars.
      const localHalfExtent = CLIPMAP_SHADOW_CONFIG.local.extent * 0.5
      const localFadeEnd = localHalfExtent - CLIPMAP_SHADOW_EDGES.local.sampleMarginMeters
      const localFadeStart = localFadeEnd - CLIPMAP_SHADOW_EDGES.local.fadeMeters
      const farWeight = smoothstep(localFadeStart, localFadeEnd, localRadius)

      // Sampling gates keep the PCF reads skippable: LOCAL is never read where
      // it has fully retired, FAR is never read inside the local core. The
      // neutral default is only ever combined at zero weight.
      const localSample = float(1).toVar()
      If(localRadius.lessThan(localFadeEnd), () => {
        localSample.assign(local as N)
      })
      const farSample = float(1).toVar()
      If(localRadius.greaterThan(localFadeStart), () => {
        farSample.assign(far as N)
      })
      const farVisible = mix(1, farSample, farEdgeFade)

      const farFieldVisibility = farField
        ? mix(1, (farField.visibility as N).toVar(), farFieldStrength)
        : null
      // Coverage includes atlas availability and its world-edge guard. Fold it
      // into a neutral-to-atlas base once, then keep that base continuous under
      // both raster domains. `min` unions duplicated caster representations;
      // multiplying them here would darken buildings twice.
      const farFieldBase = farField && farFieldVisibility
        ? mix(1, farFieldVisibility as N, (farField.coverage as N).toVar())
        : null
      // A focus-relative far-map edge is itself a moving square. Retiring the
      // raster only in that band made raster-only darkness appear/disappear as
      // the projection recentered, even though the atlas underneath was stable.
      // At full coverage the world-locked atlas therefore owns everything past
      // the local guard band; the far raster remains the exact fallback while
      // atlas availability or its edge guard fades in, and when the pane turns
      // atlas strength down.
      // Saturate the retire weight: once the world atlas has any real coverage
      // it should fully own the far domain, so the coarse 1 m far raster cannot
      // bleed a stepped, self-shadowed patch through a merely-partial (overcast,
      // low/stale-sun, mid-rebuild) linear dip. Near-zero coverage still keeps
      // the raster as the genuine fallback.
      const atlasOwnership = farField
        ? smoothstep(0, 0.6, farField.coverage as N).mul(farFieldStrength)
        : null

      // Continuous equivalent of the former inner/feather/far branches:
      // farWeight 0 -> min(local, atlasBase); feather -> blended raster with a
      // proportional atlas retire; farWeight 1 -> atlas-owned far domain.
      const rasterVisibility = mix(localSample as N, farVisible, farWeight)
      if (!farFieldBase || !atlasOwnership) {
        visibility.mulAssign(rasterVisibility)
      } else {
        visibility.mulAssign(composeRasterAtlasVisibility(
          rasterVisibility as N,
          farFieldBase as N,
          farWeight.mul(atlasOwnership),
          (a, b) => (a as N).min(b as N),
          (a, b, weight) => (mix as N)(a, b, weight)
        ))
      }

      return mix(vec4(1), visibility, enabled)
    })()
  }

  // ShadowBaseNode marks itself for render-time updates, but this composite has
  // no map of its own: the three child ShadowNodes perform their normal
  // updateBefore work. An explicit no-op avoids invoking the abstract base hook.
  updateBefore(): boolean {
    return true
  }

  dispose(): void {
    for (let i = 0; i < this.#domains.length; i++) this.#domains[i].node.dispose()
    super.dispose()
  }

  #createDomain(id: DomainId, config: DomainConfig): Domain {
    const shadowConfig = new THREE.DirectionalLight(0xffffff, 0).shadow
    const half = config.extent * 0.5
    const camera = shadowConfig.camera
    camera.left = -half
    camera.right = half
    camera.top = half
    camera.bottom = -half
    camera.near = 0.5
    camera.far = config.depth
    camera.layers.disableAll()
    camera.layers.enable(config.layer as ShadowLayer)
    camera.updateProjectionMatrix()

    shadowConfig.mapSize.set(config.resolution, config.resolution)
    shadowConfig.bias = config.depthBias
    shadowConfig.normalBias = config.normalBias
    shadowConfig.autoUpdate = false
    shadowConfig.needsUpdate = true

    const light = new ProjectionLight(shadowConfig)
    light.name = `shadow.${id}`
    const node = nodeObject(
      new DomainShadowNode(
        light as unknown as THREE.Light,
        shadowConfig,
        () => this.#recordCompletedUpdate(id)
      )
    )

    return {
      id,
      config,
      light,
      node,
      strengthBase: shadowConfig.intensity,
      introFadeAt: 0,
      initialized: false,
      lastAnchor: new THREE.Vector3(),
      lastSunDir: new THREE.Vector3(),
      lastStaticRevision: -1,
      pendingReason: 0
    }
  }

  #placeDomain(domain: Domain, focus: THREE.Vector3, sunDirection: THREE.Vector3): void {
    const direction = sunDirection
    const up = Math.abs(direction.dot(WORLD_UP)) > 0.98 ? FALLBACK_UP : WORLD_UP
    this.#right.crossVectors(up, direction).normalize()
    this.#shadowUp.crossVectors(direction, this.#right).normalize()

    const texel = domain.config.extent / domain.config.resolution
    const rightCoord = focus.dot(this.#right)
    const upCoord = focus.dot(this.#shadowUp)
    const snappedRight = Math.round(rightCoord / texel) * texel
    const snappedUp = Math.round(upCoord / texel) * texel

    this.#snapped.copy(focus)
    this.#snapped.addScaledVector(this.#right, snappedRight - rightCoord)
    this.#snapped.addScaledVector(this.#shadowUp, snappedUp - upCoord)

    const centerUniform = domain.id === "hero"
      ? this.#heroCenterUniform
      : domain.id === "local"
        ? this.#localCenterUniform
        : this.#farCenterUniform
    const rightUniform = domain.id === "hero"
      ? this.#heroRightUniform
      : domain.id === "local"
        ? this.#localRightUniform
        : this.#farRightUniform
    const upUniform = domain.id === "hero"
      ? this.#heroUpUniform
      : domain.id === "local"
        ? this.#localUpUniform
        : this.#farUpUniform
    centerUniform.value.copy(this.#snapped)
    rightUniform.value.copy(this.#right)
    upUniform.value.copy(this.#shadowUp)

    // LightShadow.updateMatrices() calls camera.lookAt() later. Match the same
    // fallback up vector used by our snap basis at near-zenith directions.
    domain.light.shadow.camera.up.copy(up)

    // Keep the target inside the depth volume with room on both lightward and
    // lee sides for hill/building casters at grazing sun angles.
    domain.light.position
      .copy(this.#snapped)
      .addScaledVector(direction, domain.config.depth * 0.45)
    domain.light.target.position.copy(this.#snapped)
    domain.light.updateMatrix()
    domain.light.updateMatrixWorld(true)
    domain.light.target.updateMatrix()
    domain.light.target.updateMatrixWorld(true)
  }

  #recordCompletedUpdate(id: DomainId): void {
    let domain: Domain | undefined
    for (let i = 0; i < this.#domains.length; i++) {
      if (this.#domains[i].id === id) {
        domain = this.#domains[i]
        break
      }
    }
    if (!domain) return
    const reason = domain.pendingReason || SHADOW_UPDATE_REASON.FORCED
    this.diagnostics.recordUpdate(
      domain.id,
      reason,
      domain.config.extent,
      domain.config.resolution,
      Number.NaN,
      performance.now()
    )
    domain.pendingReason = 0
  }

  #staticRevisionFor(id: DomainId): number {
    return id === "local" ? this.#localStaticRevision : this.#farStaticRevision
  }
}
