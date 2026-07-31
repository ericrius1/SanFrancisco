// U10 · The tweakpane control surface — build spec: .data/postfx/BRIEF.md §5
//
// THE POINT OF THIS FILE, in the user's own words: "a toggle to toggle it on and
// off, or any piece of the pipeline on and off modularly and other params to
// play with in tweakpane". So: one master switch, one subfolder per stage in the
// order the chain actually runs them, and a live read-out of `chain.state()` so
// untick-a-stage → `passes: 7` becomes `passes: 6` in front of you. That
// read-out is the cheapest possible explanation of how this system works, which
// is why it sits at the top rather than in a diagnostics folder.
//
// THREE LANES, and mixing them up is the whole hazard this file exists to avoid:
//
//  (1) LIVE — a plain uniform push through `stage.applyParams()`. Safe on every
//      pointer-move event: no allocation, no codegen, no reselect. This is where
//      every artistic knob belongs and where all but six of them are.
//
//  (2) STRUCTURAL — `tuning.structuralKeys`. Reallocates a render target or
//      changes a resolution. Gated on slider RELEASE (`last === true`) and then
//      routed through the chain's structure lane. Precedent for the gate is
//      `SHADOW_TUNING.contactResolutionScale` (ui/debug.ts) — without it, a
//      half-second drag across `post.ssao.resolution` reallocates the AO targets
//      once per pointer-move.
//
//  (3) REBUILD — `tuning.recompileKeys`. Genuinely baked JS constants; changing
//      one regenerates WGSL. A long codegen window HOLDS PRESENTED FRAMES
//      (pipeline.ts's exclusive compile depth), so a recompile bound to a live
//      slider is a stutter per pixel of pointer travel. These get their own
//      "rebuild (hitches)" subfolder and an explicit Apply BUTTON — the value is
//      written and persisted immediately, but nothing reads it until you click.
//      Only `post.ssr.blurQuality` and `post.ssr.binaryRefine` are in this class,
//      and both are declared by the stage rather than listed here, so this file
//      never has to be edited when a stage changes its mind.
//
// WHAT A TOGGLE COSTS: nothing. `chain.render()` does `if (!stage.enabled())
// continue` — the stage is not blitted, not cleared, not rendered, and its
// targets stay allocated so re-enabling is free too. No control in this file
// compiles a shader or reallocates a target except the two that say so on the
// label.
//
// LAZY LOADING: `ui/debug.ts` reaches this module through a dynamic import on
// the first "/", alongside tweakpane's own chunk. Nothing heavy is imported at
// module scope here either — every tunable group below is already resident
// because `createPostChain()` constructed the stage that owns it at boot. There
// is deliberately NO warm-on-expand: the old panel pre-warmed pipelines when you
// merely opened a folder, which dragged an FXAA import in as a side effect. One
// RenderPipeline exists, every stage's quad is compiled at boot, and after that
// no toggle can create a new one.
import type { FolderApi } from "tweakpane"
import { saveTweak, withTweakBindingEventsSuppressed } from "../../core/persist"
import { GRADE_TUNING } from "../grade"
import { POST_TUNING } from "./tuning"
import type { PostChainState, PostStage } from "./types"

/** A tweakpane binding, narrowed to the one method this file calls. */
type Refreshable = { refresh(): void }

/**
 * The chain, as the panel needs it. Structurally a subset of `PostChain`, spelled
 * out rather than imported wholesale so `ui/debug.ts` can keep checking the
 * render pipeline against a concrete shape (see the tripwire note there).
 */
export type PostPanelChain = {
  applyParams(): void
  applyStructure(): void
  invalidateHistory(reason: string): void
  stage(id: string): PostStage | undefined
  readonly stages: readonly PostStage[]
  readonly state: () => PostChainState
}

export type PostPanelDeps = {
  /** Null before the pipeline exists. The folder still builds — master toggle
   *  and preset only — rather than throwing during panel construction. */
  readonly chain: PostPanelChain | null
  /** Lane 1. Pushes every stage's sliders into live uniforms. Never recompiles. */
  readonly applyParams: () => void
  /**
   * Lanes 2 and 3. Reallocates targets, rebuilds any baked graph, re-warms the
   * chain's quads inside an exclusive compile window and invalidates temporal
   * history. May hold presented frames. Never call it from a live slider.
   */
  readonly applyStructure: () => void | Promise<void>
  /** Swaps the LUT's CONTENTS. No recompile, no pipeline reselect — live. */
  readonly setLook: (id: string) => void
  /**
   * God rays reconcile their own lifecycle every frame from the frame driver, so
   * this is only about latency: without it a toggle takes effect on the next
   * presented frame instead of immediately.
   */
  readonly applyGodRays: () => void
  /** True while the host is pushing values into the chrome. Suppress side effects. */
  readonly suppressed: () => boolean
}

export type PostPanelResult = {
  /** Refreshed by the host's existing 4 Hz monitor pass. */
  readonly monitors: Refreshable[]
  /**
   * The mirrored grade-look selector. The look also lives in
   * `advanced ▸ lighting`, where people have always found it; the host refreshes
   * this copy alongside that one so the two can never disagree.
   */
  readonly lookBindings: Refreshable[]
}

/**
 * QUALITY PRESETS — the meaning given to `POST_TUNING.quality`, which nothing in
 * the renderer reads.
 *
 * A dropdown that changes no pixel is worse than no dropdown, so rather than
 * render it inert it becomes the preset selector: low = performance, medium =
 * balanced (the shipped defaults), high = cinematic. Keyed by the option VALUES
 * declared in ./tuning.ts.
 *
 * DELIBERATELY ONLY ENABLES AND RESOLUTIONS. A preset never touches an artistic
 * parameter — your bloom strength, AO radius and grain response survive a preset
 * click. Presets are about what runs and how big, not about how it looks.
 *
 * Persisted paths are `post.<stage id>.<key>`, which every stage group in this
 * folder uses by construction (post/types.ts requires the dotted path so a
 * stage's spec churn cannot discard a sibling's overrides).
 *
 * ONE HONEST LIMITATION: the selection persists, but it is NOT re-applied on
 * load — doing so would clobber hand-tuned values every time you pressed "/".
 * It therefore records the last preset you clicked, not a claim about the
 * current state, and hand-editing any stage below leaves it stale on purpose.
 */
type StagePatch = Readonly<Record<string, Readonly<Record<string, number | boolean>>>>

const PRESETS: Readonly<Record<string, StagePatch>> = {
  // low — performance. Drops the two ray-marched stages entirely and renders the
  // beauty pass at 35% of the output pixels. Bloom and the temporal resolve stay
  // on because they are the base look, not an optional style.
  "0.5": {
    velocity: { enabled: true },
    ssao: { enabled: false },
    ssr: { enabled: false },
    godrays: { enabled: false },
    composite: { enabled: true },
    temporal: { enabled: true, scale: 0.59 },
    dof: { enabled: false },
    bloom: { enabled: true, resolution: 0.5 }
  },
  // medium — balanced. Exactly the shipped defaults; this is the "put it back"
  // button as much as it is a preset.
  //
  // That claim is the one thing in this table that can rot silently, because it
  // is a COPY of numbers whose source of truth is each stage's own tuning.ts.
  // It already did once: `temporal.scale` sat at 0.667 here after the
  // performance pass moved the default to 0.77, so "put it back" quietly put it
  // somewhere else. `tools/post-chain-contract-test.mjs` now diffs this row
  // against the defaults on disk — if you change a stage default, that test
  // tells you to change this line too.
  "0.75": {
    velocity: { enabled: true },
    ssao: { enabled: true, resolution: 0.25 },
    ssr: { enabled: true, resolution: 0.5 },
    godrays: { enabled: true },
    composite: { enabled: true },
    temporal: { enabled: true, scale: 0.77 },
    dof: { enabled: false },
    bloom: { enabled: true, resolution: 0.5 }
  },
  // high — cinematic. Native beauty resolution, full-res AO and reflections, and
  // depth of field ON: nine fullscreen passes and ~160 taps/px make DOF by far
  // the most expensive stage in the chain, which is exactly why it ships off in
  // live play and belongs here instead.
  "1": {
    velocity: { enabled: true },
    ssao: { enabled: true, resolution: 1 },
    ssr: { enabled: true, resolution: 1 },
    godrays: { enabled: true },
    composite: { enabled: true },
    temporal: { enabled: true, scale: 1 },
    dof: { enabled: true },
    bloom: { enabled: true, resolution: 0.75 }
  }
}

/**
 * Stages whose group carries nothing worth a control. `post.display` holds only
 * `upscaleFilter`, which its own tuning file documents as NOT YET WIRED — a TSL
 * `.sample()` takes its filter from the bound texture, so honouring it is a
 * resource-level edit in the target pool rather than a display-tail edit. The
 * folder still appears, with a line naming what the tail does, because the tail
 * is where grade / sharpen / grain actually execute and the panel is supposed to
 * read as the signal path.
 */
const DISPLAY_TAIL_SUMMARY = "surf lens → grade → sharpen → grain → surf grade"

/**
 * Build the whole post-chain control surface into `folder`.
 *
 * The folder tree is derived from `chain.stages`, which is the chain's own
 * STAGE_ORDER-sorted array — so the panel reads top to bottom in the order the
 * frame is actually assembled, and a stage added or removed later shows up here
 * with no edit to this file. A stage that is absent simply has no folder; no
 * lookup here assumes `chain.stage(id)` is non-null.
 */
export function buildPostFolder(folder: FolderApi, deps: PostPanelDeps): PostPanelResult {
  const chain = deps.chain
  /** Everything this folder created, for the post-preset chrome refresh. */
  const bindings: Refreshable[] = []
  const lookBindings: Refreshable[] = []

  /**
   * Push values we wrote behind the pane's back into the chrome. Suppressed,
   * because a programmatic refresh emits change events and re-running the
   * handlers would fire the whole preset a second time.
   */
  const refreshChrome = () => {
    withTweakBindingEventsSuppressed(() => {
      for (const binding of bindings) binding.refresh()
      for (const binding of lookBindings) binding.refresh()
    })
  }

  // ------------------------------------------------------------ master + state

  /**
   * THE MASTER SWITCH. Off means the chain runs `#renderBypass` — the same
   * single RenderPipeline reading the beauty texture directly, one pass, no
   * stage rendered at all. It is a per-frame read in `chain.render()`, so
   * nothing needs to be "applied"; `applyParams()` is here only so a toggle
   * leaves every uniform consistent with the values beside it.
   *
   * History is invalidated because the master switch also changes the beauty
   * pass's resolution (`postInputScale()` returns 1 while bypassed), and a
   * temporal resolve carrying history from the other resolution smears for a
   * second. Invalidating is a matrix reset, not an allocation.
   */
  bindings.push(
    ...(POST_TUNING.bind(folder, {
      keys: ["enabled"],
      onChange: () => {
        if (deps.suppressed()) return
        deps.applyParams()
        chain?.invalidateHistory("post master toggle")
      }
    }) as Refreshable[])
  )

  bindings.push(
    ...(POST_TUNING.bind(folder, {
      keys: ["quality"],
      onChange: (_key, value, last) => {
        if (deps.suppressed() || !last) return
        const patch = PRESETS[String(value)]
        if (patch) applyPreset(patch)
      }
    }) as Refreshable[])
  )

  /**
   * The live read-out of `chain.state()`. A pure read of the LAST PRESENTED
   * FRAME — it evaluates no stage predicate and touches no uniform, so watching
   * it cannot perturb what it measures (which an earlier shape of `state()`
   * did: SSR writes a GPU uniform from `enabled()`).
   *
   * Consequence worth knowing while you use it: a tunable written this tick
   * shows up here only after the next presented frame, and a tick that does not
   * present — the compile gate holds frames — leaves it reporting the previous
   * frame. Tick, then read.
   */
  const stateView = { passes: "—", scale: "—", path: "—", fused: "—" }
  const stateReadouts: Refreshable[] = []
  if (chain) {
    stateReadouts.push(
      // "stages", not "passes". The number IS `state().passes`, but the word
      // "passes" invited reading it as a draw count and it is not one: bloom
      // alone issues ~12 fullscreen draws inside its single entry (see the note
      // on PostChainState.passes). The label names what the number counts.
      folder.addBinding(stateView, "passes", { readonly: true, label: "stages ran" }) as Refreshable,
      folder.addBinding(stateView, "scale", { readonly: true, label: "render scale" }) as Refreshable,
      folder.addBinding(stateView, "path", { readonly: true, label: "ran last frame" }) as Refreshable,
      // `inline` is the other half of the answer, and without it this read-out
      // lies by omission: grade, sharpen and grain never appear in `passes`
      // because they are fused into the display tail's single fragment shader,
      // so a reader watching only the row above concludes the grade is off.
      // Jitter is here too — it renders nothing; the frame driver applies its
      // offset to the camera.
      folder.addBinding(stateView, "fused", { readonly: true, label: "· no pass" }) as Refreshable
    )
  }

  const stateMonitor: Refreshable = {
    refresh() {
      if (!chain) return
      const state = chain.state()
      stateView.passes = String(state.passes)
      stateView.scale = `${state.inputScale.toFixed(3)}× internal`
      stateView.path = state.enabled.length > 0 ? state.enabled.join(" · ") : "—"
      stateView.fused = state.inline.length > 0 ? state.inline.join(" · ") : "—"
      for (const readout of stateReadouts) readout.refresh()
    }
  }
  stateMonitor.refresh()

  // ------------------------------------------------------------------- presets

  function applyPreset(patch: StagePatch) {
    if (!chain) return
    POST_TUNING.values.enabled = true
    saveTweak("post.enabled", true)
    for (const [id, keys] of Object.entries(patch)) {
      // Never assume a stage exists. A preset naming a stage this build does not
      // have is a no-op for that stage, not a thrown panel.
      const stage = chain.stage(id)
      if (!stage) continue
      const values = stage.tuning.group.values as Record<string, unknown>
      for (const [key, value] of Object.entries(keys)) {
        // Same reasoning one level down: a stage may have renamed a key, and a
        // stale preset must not invent one.
        if (!(key in values)) continue
        values[key] = value
        saveTweak(`post.${id}.${key}`, value)
      }
    }
    refreshChrome()
    // Uniforms first, then the structural lane — a preset moves resolutions and
    // a render scale, which is a reallocation, and `applyStructure` finishes by
    // re-warming the quads inside an exclusive compile window and invalidating
    // the temporal history the old geometry left behind.
    deps.applyParams()
    deps.applyGodRays()
    void deps.applyStructure()
  }

  // ------------------------------------------------------------- per-stage tree

  if (chain) {
    for (const stage of chain.stages) {
      const sub = folder.addFolder({ title: stage.label, expanded: false })

      // The look selector belongs at the TOP of the grade folder — it is the
      // control people actually come here for, and the AgX knobs below it are
      // inert on every non-AgX look.
      if (stage.id === "grade") lookBindings.push(...bindLookSelector(sub, deps))

      if (stage.id === "display") {
        // No control: this group's only key is documented as unwired. The line
        // is still worth its row — it names what the three "inline" folders
        // above actually execute inside, which is otherwise invisible.
        const tailView = { tail: DISPLAY_TAIL_SUMMARY }
        sub.addBinding(tailView, "tail", { readonly: true, label: "fused tail" })
        continue
      }

      bindStage(sub, stage, deps, bindings)
    }
  }

  return { monitors: [stateMonitor], lookBindings }
}

/**
 * The grade look, mirrored from `advanced ▸ lighting`.
 *
 * Two bindings on one group is deliberate and the host keeps them in sync: the
 * look is both a lighting decision (where it has always lived, and where people
 * look for it) and the display transform at the end of this signal path, and
 * omitting it from either place makes one of the two folders lie about what it
 * controls. The option list comes from `gradeLooks.ts`, so `agx` and `agxPunch`
 * appear here the moment they exist in that table — there is nothing to add.
 *
 * Fully live: selecting a look re-bakes and re-uploads the 3D LUT's CONTENTS.
 * Same texture object, same bind group, no pipeline reselect, no shader compile.
 */
function bindLookSelector(folder: FolderApi, deps: PostPanelDeps): Refreshable[] {
  return GRADE_TUNING.bind(folder, {
    onChange: (_key, value) => {
      if (deps.suppressed()) return
      deps.setLook(String(value))
    }
  })
}

/**
 * One stage's controls, split across the three lanes by what the stage itself
 * declares. This function never names a key: `structuralKeys` and
 * `recompileKeys` are the stage's own contract, so a stage that promotes a baked
 * constant to a uniform (as the SSR fork did with `stepExponent`) moves it out
 * from behind the Apply button by editing its own file.
 *
 * The enable toggle comes first because every stage group in this folder
 * declares `enabled` as its first spec key, and `tunables().bind()` emits
 * controls in spec order. Three stages have no `enabled` at all — jitter,
 * sharpen and grain express "off" as an exact arithmetic identity at 0, so their
 * first slider IS the toggle, which is what their tuning files document.
 */
function bindStage(
  folder: FolderApi,
  stage: PostStage,
  deps: PostPanelDeps,
  bindings: Refreshable[]
) {
  const { group, structuralKeys, recompileKeys } = stage.tuning
  const structural = new Set<string>(structuralKeys)
  const recompile = new Set<string>(recompileKeys)

  // Everything that is not a rebuild key, in spec order. Rebuild keys are pulled
  // out entirely — a live slider is exactly what must not happen to them.
  const liveKeys = Object.keys(group.values).filter((key) => !recompile.has(key))

  if (liveKeys.length > 0) {
    bindings.push(
      ...(group.bind(folder, {
        keys: liveKeys,
        onChange: (key: string, _value: unknown, last: boolean) => {
          if (deps.suppressed()) return

          if (structural.has(key)) {
            // LANE 2. Gate on RELEASE. `post.ssao.samples` is a slider, and
            // reallocating the AO targets once per pointer-move while dragging
            // it is a hitch per pixel of travel for no intermediate image
            // anybody sees. Dropdowns report `last === true` on their single
            // change event, so they pass straight through.
            if (!last) return
            void deps.applyStructure()
            return
          }

          // LANE 1. A pure uniform push into THIS stage. Deliberately not
          // `chain.applyParams()`: that fans out to every stage, and the grade
          // adapter re-bakes its LUT from its own applyParams — a ~148 ms AgX
          // bake triggered by nudging a bloom slider.
          stage.applyParams()

          if (stage.id === "godrays") {
            // The god-ray runtime's existence is level-triggered from the frame
            // driver, so this lane only removes a frame of latency. It also
            // clears the one-shot build-failure latch, which is what makes
            // re-ticking the box after a failed build actually retry.
            deps.applyGodRays()
          }

          if (key === "enabled") {
            // Toggling a stage never compiles or reallocates — the chain simply
            // stops calling render() — but the temporal resolve's history is
            // now describing a frame assembled differently, and for
            // `post.temporal.enabled` the beauty pass resolution changes with
            // it. Reseeding is a matrix reset, not an allocation.
            deps.chain?.invalidateHistory(`post stage toggle: ${stage.id}`)
          }
        }
      }) as Refreshable[])
    )
  }

  if (recompile.size === 0) return

  /**
   * LANE 3. The only two entries in the whole chain: `post.ssr.blurQuality`
   * (the box blur's (size*2+1)² loop bounds must be WGSL constants) and
   * `post.ssr.binaryRefine` (adds an 8-iteration bisection to the march).
   *
   * The sliders here are inert by design — they write and persist their value,
   * and nothing reads it until Apply. That is the point: a codegen window holds
   * presented frames, so binding these live would be one stutter per pointer
   * move. Apply routes through the structure lane, which re-warms the chain's
   * quads inside an exclusive compile window, so the frame is HELD rather than
   * showing a half-built pipeline.
   *
   * Knock-on worth knowing: because Apply is the shared structural lane, a
   * pending value here is also picked up by any OTHER structural release (say,
   * a resolution dropdown). Same lane, same hold, no surprise beyond the timing.
   */
  const rebuild = folder.addFolder({ title: "rebuild (hitches)", expanded: false })
  bindings.push(
    ...(group.bind(rebuild, {
      keys: [...recompile],
      onChange: () => {}
    }) as Refreshable[])
  )

  let applying = false
  const button = rebuild.addButton({ title: "apply · rebuilds shaders", label: "apply" })
  button.on("click", () => {
    if (applying) return
    applying = true
    button.title = "compiling…"
    void Promise.resolve(deps.applyStructure()).finally(() => {
      applying = false
      button.title = "apply · rebuilds shaders"
    })
  })
}
