import { MENU_MODES } from "../player/discovery"
import { distanceToTutorialZone } from "../world/tutorialZone/meta"
import type { TutorialZoneProgress } from "../world/tutorialZone"
import type { PlayerMode } from "../player/types"

/**
 * Interactive tutorial: a chaptered checklist that watches real play instead
 * of narrating over it. The "Tutorial" button (top-right, under Share) is
 * always on screen outside immersive mode; clicking it takes a newcomer to the
 * flight school on the Crissy Field airfield and walks them from WASD through a
 * door, a lap, a bowl and six rings over the bay.
 *
 * The field (world/tutorialZone) is a real place with its own gates, hurdle and
 * rings; it publishes plain totals through `ctx.zone`. This file only reads
 * them.
 *
 * The field is the ONLY authority on a step it can measure. Each such step also
 * carries a body-only fallback, but that is a safety net for having no field at
 * all — not a second way to pass. It arms only once the field has been unable
 * to see the player for `FALLBACK_GRACE` seconds, and arming resets the net's
 * own accumulators so nothing banked while waiting can cash in. See `zoneOr`.
 */

export interface TutorialCtx {
  mode: () => PlayerMode
  pos: () => { x: number; y: number; z: number }
  mouseDelta: () => number
  down: (code: string) => boolean
  pressed: (code: string) => boolean
  mapOpen: () => boolean
  teleport: (t: { x: number; y: number; z: number; facing: number; mode: PlayerMode }) => void
  message: (text: string, seconds?: number) => void
  /** Live totals from the flight school, or null until the site is resident. */
  zone?: () => TutorialZoneProgress | null
  /** Arrive at the field's west gate (and start loading it). */
  goToZone?: () => void
}

/** Per-step scratch state: an accumulator, a baseline, and the last position. */
type Scratch = {
  n: number
  base: number | null
  px: number | null
  pz: number | null
  /** Highest progress reported for this step, so the bar never walks backwards. */
  best: number
  /** Seconds the field has been unable to see the player during this step. */
  blind: number
  /** The body-only fallback has taken over for this step. */
  armed: boolean
}

const freshScratch = (): Scratch => ({ n: 0, base: null, px: null, pz: null, best: 0, blind: 0, armed: false })

type Step = {
  keys?: string[]
  action?: string
  text: string
  hint?: string
  /** Elide this step entirely when it is already satisfied as it opens. */
  skipIfSatisfied?: boolean
  onEnter?: (ctx: TutorialCtx) => void
  /** Progress 0..1 (booleans read as done/not); ev counts one-shot events. */
  check: (ctx: TutorialCtx, dt: number, st: Scratch, ev: Map<string, number>) => number | boolean
}

type Chapter = { title: string; steps: Step[]; onEnter?: (ctx: TutorialCtx) => void }

/** Metres walked/driven since the step began, ignoring teleport-sized jumps. */
function traveled(ctx: TutorialCtx, st: Scratch, want: number, active: boolean): number {
  const p = ctx.pos()
  if (st.px !== null && active) {
    const d = Math.hypot(p.x - st.px, p.z - st.pz!)
    if (d < 20) st.n += d
  }
  st.px = p.x
  st.pz = p.z
  return st.n / want
}

/** Best altitude gained over the lowest point seen while `active`. */
function climbed(ctx: TutorialCtx, st: Scratch, want: number, active: boolean): number {
  if (active) {
    const y = ctx.pos().y
    st.base = st.base === null ? y : Math.min(st.base, y)
    st.n = Math.max(st.n, y - st.base)
  }
  return st.n / want
}

const shiftDown = (ctx: TutorialCtx) => ctx.down("ShiftLeft") || ctx.down("ShiftRight")

/**
 * The number key that switches to `mode`: the MENU_MODES order IS the key row
 * (frameBody maps Digit i → MENU_MODES[i - 1]), so never hardcode the digit —
 * reordering the roster would silently teach newcomers the wrong keys.
 */
const modeKey = (mode: PlayerMode) => `${MENU_MODES.indexOf(mode) + 1}`

/** A "press N to hop on X" step, with the digit read off the roster. */
const modeStep = (mode: PlayerMode, text: string): Step => ({
  keys: [modeKey(mode)],
  text,
  check: (c) => c.mode() === mode
})

const COUNT_WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"]
const countWord = (n: number) => COUNT_WORDS[n] ?? `${n}`

/**
 * Seconds the field gets to show up before a step will accept a body-only
 * check. Long enough to cover the site streaming in behind the 🎓 teleport,
 * which is the whole reason a step ever sees `watching === false`.
 */
const FALLBACK_GRACE = 8

/**
 * Progress for a step the flight school measures.
 *
 * While the field is watching it is the only authority: walking 26 metres
 * across the lawn is not walking three gates, and tapping Space is not clearing
 * the hurdle. An earlier version took `max(field, body)` every frame, which
 * meant the easier of the two always won and every objective on the field could
 * be passed by generic movement — the field became scenery.
 *
 * The body-only check survives as a net for having no field at all (the site
 * failed, or the player left and it went to sleep). It arms only after
 * `FALLBACK_GRACE` seconds of nobody watching, and the arming frame zeroes the
 * net's accumulators and reports nothing new — so distance banked while waiting
 * for the site cannot cash in the moment it gives up. `traveled`/`climbed` are
 * still evaluated every frame regardless, to keep their last-position and
 * baseline state warm; the result is simply ignored until the net is armed.
 *
 * `st.best` ratchets the reported value so the bar never drops — notably at the
 * moment the field finishes loading and takes over from a partly-filled net.
 */
function zoneOr(
  ctx: TutorialCtx,
  dt: number,
  st: Scratch,
  read: (zone: TutorialZoneProgress) => number | boolean,
  fallback: number | boolean
): number {
  const asNumber = (v: number | boolean) => (typeof v === "boolean" ? (v ? 1 : 0) : v)
  const zone = ctx.zone?.() ?? null

  if (zone?.watching) {
    st.blind = 0
    st.best = Math.max(st.best, asNumber(read(zone)))
    return st.best
  }

  st.blind += dt
  if (st.blind < FALLBACK_GRACE) return st.best
  if (!st.armed) {
    st.armed = true
    st.n = 0
    st.base = null
    return st.best
  }
  st.best = Math.max(st.best, asNumber(fallback))
  return st.best
}

/**
 * A "make your way over there" beat, put in front of every step that can only
 * be done at one end of the field.
 *
 * Without these the checklist asks for a trick at the bowl while you are stood
 * at the oval, and a bar frozen at zero is indistinguishable from a trick you
 * keep muffing — you try harder in the wrong place. Progress here is the gap
 * you have closed since the step opened, so the bar moves the moment you set
 * off and tells you that heading over is the thing being asked for.
 */
function travelStep(
  read: (zone: TutorialZoneProgress) => number,
  arrive: number,
  text: string,
  hint?: string
): Step {
  return {
    action: "Head",
    text,
    hint,
    skipIfSatisfied: true,
    check: (c, dt, st) =>
      zoneOr(
        c,
        dt,
        st,
        (z) => {
          const d = read(z)
          // Infinity until the field has seen a frame of the player, and the
          // arithmetic below turns that into NaN. Report no progress rather
          // than a number: NaN compares false against every threshold, so it
          // reads as "done" to any `< 1` guard and silently eats the step.
          if (!Number.isFinite(d)) return 0
          if (d <= arrive) return 1
          // Baseline the first reading so the bar is a share of the walk you
          // actually have in front of you, not of some fixed distance.
          if (st.base === null) st.base = Math.max(d, arrive + 1)
          return (st.base - d) / (st.base - arrive)
        },
        // With no field there is nowhere to go, so this beat is not a gate.
        1
      )
  }
}

const CHAPTERS: Chapter[] = [
  {
    title: "The airfield",
    onEnter: (c) =>
      c.message("Crissy Field — the Army taught people to fly here. Everything on this field is a thing to try.", 5),
    steps: [
      modeStep("walk", "to get on your own two feet"),
      {
        keys: ["Mouse"],
        action: "Move",
        text: "to look around — find the windsock",
        hint: "click the city first if the cursor is loose — Esc or L lets it go",
        check: (c, _dt, st) => (st.n += c.mouseDelta()) / 400
      },
      {
        keys: ["W", "A", "S", "D"],
        action: "Use",
        text: "to walk through all three bunting gates",
        check: (c, dt, st) =>
          zoneOr(c, dt, st, (z) => z.gatesPassed / 3, traveled(c, st, 26, c.mode() === "walk"))
      },
      {
        keys: ["Shift"],
        action: "Hold",
        text: "to sprint the chalk lane between the bollards",
        check: (c, dt, st) =>
          zoneOr(c, dt, st, (z) => z.sprintMeters / 26, traveled(c, st, 22, c.mode() === "walk" && shiftDown(c)))
      },
      {
        keys: ["Space"],
        text: "to jump the hay bales at the end of the lane",
        check: (c, dt, st) =>
          zoneOr(c, dt, st, (z) => z.hurdleCleared, c.mode() === "walk" && c.pressed("Space"))
      }
    ]
  },
  {
    title: "The cottage",
    onEnter: (c) =>
      c.message("The hut on the north side has a door. Every front door in the city works the same way.", 4.5),
    steps: [
      {
        keys: ["E"],
        action: "Press",
        text: "at the cottage door to open it, then step inside",
        hint: "stand close — the prompt appears when you are in reach",
        // Off-field there is no cottage to stand in, so the net checks the one
        // thing the step is really teaching: the key that opens a door.
        check: (c, dt, st) => zoneOr(c, dt, st, (z) => z.cottageVisited, c.mode() === "walk" && c.pressed("KeyE"))
      }
    ]
  },
  {
    title: "The oval",
    onEnter: (c) => {
      const n = countWord(MENU_MODES.length)
      c.message(
        `${n[0].toUpperCase()}${n.slice(1)} ways to get around — the number keys switch between them. Start with the car, on the track.`,
        5
      )
    },
    steps: [
      modeStep("drive", "to summon the car"),
      travelStep((z) => z.toStartLine, 14, "east to the start line on the oval's north apex", "the black-and-white line across the asphalt"),
      {
        keys: ["W"],
        action: "Hold",
        text: "to drive a full lap of the oval — either way round",
        hint: "Shift boosts · Space drifts · the banking holds you through the bends",
        check: (c, dt, st) => zoneOr(c, dt, st, (z) => z.lapFraction, traveled(c, st, 240, c.mode() === "drive"))
      }
    ]
  },
  {
    title: "The bowl",
    onEnter: (c) =>
      c.message("The concrete bowl is on the south-west corner, back past the cottage — ride in, and come out of it flying.", 5),
    steps: [
      modeStep("board", "to hop on the hoverboard"),
      travelStep((z) => z.toBowl, 20, "west to the concrete bowl", "the round pad with the grind rail across its deck"),
      {
        keys: ["Space"],
        text: "to get air off the bowl",
        hint: "drop in, carry your speed up the far wall, and jump as you hit the lip",
        check: (c, dt, st) =>
          zoneOr(c, dt, st, (z) => z.bowlAir / 0.35, c.mode() === "board" && c.pressed("Space") ? 1 : 0)
      }
    ]
  },
  {
    title: "Out over the bay",
    onEnter: (c) => c.message("Six rings climb off the bowl and out over the water. Fly them in order.", 4.5),
    steps: [
      modeStep("bird", "to become the phoenix"),
      travelStep((z) => z.toFirstRing, 30, "for the first ring, low over the bowl", "it is the one breathing — they light as you pass them"),
      {
        keys: ["Space"],
        text: "to flap through all six rings",
        hint: "look down + Shift to dive · the lit ring is your next one",
        check: (c, dt, st) => zoneOr(c, dt, st, (z) => z.ringsFlown / 6, climbed(c, st, 30, c.mode() === "bird"))
      }
    ]
  },
  {
    title: "Anywhere, instantly",
    onEnter: (c) =>
      c.message("Last one. You have been everywhere on this field — the map takes you everywhere else.", 4.5),
    steps: [
      { keys: ["M"], text: "to open the city map", check: (c) => c.mapOpen() },
      {
        // One card for the whole map, because you are looking at the map when
        // you read it: panning, zooming and picking are no use as a separate
        // beat you meet before the map is open, or as a footnote after you
        // have already teleported.
        keys: ["Drag", "Scroll", "Click", "Enter"],
        action: "Use",
        text: "to pan, zoom, pick a spot, and teleport there",
        hint: "the labelled dots are landmarks — click one, or click any spot on the map · Esc closes it and leaves you where you are",
        check: (_c, _dt, _st, ev) => (ev.get("teleport") ?? 0) >= 1
      }
    ]
  }
]

/** The card the checklist becomes once the last step is done. */
const FINALE = {
  title: "Congratulations",
  text: "That is everything — you can walk, drive, ride, fly and teleport anywhere in the city.",
  hint: "the 🎓 button starts the tour again any time"
} as const

const DONE_KEY = "sf-tutorial-done"

export class Tutorial {
  #ctx: TutorialCtx
  #btnLabel: HTMLSpanElement
  #hud: HTMLElement
  #panel: HTMLDivElement
  #chEl: HTMLElement
  #progEl: HTMLElement
  #objEl: HTMLElement
  #actionEl: HTMLElement
  #keysEl: HTMLElement
  #textEl: HTMLElement
  #barEl: HTMLElement
  /** Fill of the segment for the step being worked on, or null on the finale. */
  #segFill: HTMLElement | null = null
  #hintEl: HTMLElement
  #dotsEl: HTMLElement
  #skipBtn: HTMLButtonElement
  #exitBtn: HTMLButtonElement

  #active = false
  /** Showing the finale card: the run is over but the panel is still up. */
  #done = false
  #ci = 0
  #si = 0
  #scratch: Scratch = freshScratch()
  #events = new Map<string, number>()
  #advance = 0 // ✓ shown; seconds until the next step slides in

  get active() {
    return this.#active
  }

  /**
   * Draw the bar as one cell per step in the current chapter.
   *
   * A chapter's steps used to differ only by "step 2/3" in the far corner,
   * while the title your eye is on stayed put — so moving between them looked
   * like nothing had happened, or like the same step had come back. Cells make
   * the position within the chapter spatial: cleared ones stay full, the one
   * you are on is brighter and fills as you work, the rest are empty.
   */
  #drawSegments(count: number, current: number) {
    this.#barEl.innerHTML = Array.from({ length: count }, (_, i) => {
      const state = i < current ? " done" : i === current ? " now" : ""
      return `<span class="tut-seg${state}"><i></i></span>`
    }).join("")
    this.#segFill = this.#barEl.querySelector(".tut-seg.now i")
  }

  constructor(ctx: TutorialCtx) {
    this.#ctx = ctx
    const hud = document.getElementById("hud")!
    this.#hud = hud
    // Evict any panel a previous instance left behind. Two Tutorials stack
    // their panels at the same absolute position, so the older one sits
    // invisibly under the newer: clicks land on whichever is on top while the
    // frame loop drives the other, and the checklist appears to re-show a step
    // it just left. Only one tour can be on screen, so make that structural.
    for (const stale of hud.querySelectorAll(".tutorial-ui, .tutorial-panel")) stale.remove()

    // the launch button — parked under Share; Tab fades it with the rest of the HUD
    const ui = document.createElement("div")
    ui.className = "tutorial-ui"
    const btn = document.createElement("button")
    btn.className = "share-btn"
    btn.type = "button"
    btn.title = "Learn the ropes — movement, entering buildings, vehicles, teleporting"
    btn.innerHTML = `<span class="ic">🎓</span><span class="tut-btn-label">Tutorial</span>`
    if (!localStorage.getItem(DONE_KEY)) btn.classList.add("pulse")
    this.#btnLabel = btn.querySelector(".tut-btn-label")!
    btn.addEventListener("click", () => {
      btn.classList.remove("pulse")
      if (this.#active) this.stop(false)
      else this.start()
    })
    ui.appendChild(btn)
    hud.appendChild(ui)

    this.#panel = document.createElement("div")
    this.#panel.className = "tutorial-panel"
    this.#panel.style.display = "none"
    this.#panel.innerHTML =
      `<div class="tut-top"><span class="tut-ch"></span><span class="tut-prog"></span></div>` +
      `<div class="tut-obj"><span class="tut-action"></span><span class="tut-keys"></span><span class="tut-text"></span><span class="tut-check">✓</span></div>` +
      `<div class="tut-bar"></div>` +
      `<div class="tut-hint"></div>` +
      `<div class="tut-row"><span class="tut-dots"></span>` +
      `<button class="tut-skip" type="button">skip step ▸</button>` +
      `<button class="tut-exit" type="button">end</button></div>`
    this.#chEl = this.#panel.querySelector(".tut-ch")!
    this.#progEl = this.#panel.querySelector(".tut-prog")!
    this.#objEl = this.#panel.querySelector(".tut-obj")!
    this.#actionEl = this.#panel.querySelector(".tut-action")!
    this.#keysEl = this.#panel.querySelector(".tut-keys")!
    this.#textEl = this.#panel.querySelector(".tut-text")!
    this.#barEl = this.#panel.querySelector(".tut-bar")!
    this.#hintEl = this.#panel.querySelector(".tut-hint")!
    this.#dotsEl = this.#panel.querySelector(".tut-dots")!
    this.#skipBtn = this.#panel.querySelector(".tut-skip")!
    this.#exitBtn = this.#panel.querySelector(".tut-exit")!
    // Skip must always mean skip. It used to no-op for the 0.85 s a completed
    // step spends celebrating, and during a step whose card had just opened —
    // clicking and having nothing happen reads as a broken button, so a press
    // now cancels any pending advance and moves on immediately.
    this.#skipBtn.addEventListener("click", () => {
      if (this.#active && !this.#done) {
        this.#advance = 0
        this.#next()
      }
    })
    this.#exitBtn.addEventListener("click", () => this.stop(false))
    hud.appendChild(this.#panel)
  }

  start() {
    this.#active = true
    this.#done = false
    this.#ci = 0
    this.#si = 0
    this.#advance = 0
    this.#panel.style.display = ""
    this.#skipBtn.style.display = ""
    this.#exitBtn.textContent = "end"
    this.#btnLabel.textContent = "End tutorial"
    // Take them to the field — unless they are already standing on it, in which
    // case moving them would be the rudest possible way to begin.
    const p = this.#ctx.pos()
    if (distanceToTutorialZone(p.x, p.z) > 40) this.#ctx.goToZone?.()
    CHAPTERS[0].onEnter?.(this.#ctx)
    this.#enterStep()
  }

  stop(done: boolean) {
    this.#active = false
    this.#done = false
    this.#hud.classList.remove("tutorial-over-map")
    this.#panel.style.display = "none"
    this.#btnLabel.textContent = "Tutorial"
    if (done) {
      localStorage.setItem(DONE_KEY, "1")
      this.#ctx.message("Tutorial complete — the city is yours 🎉", 5)
    }
  }

  /** One-shot gameplay events from main.ts, e.g. "teleport". */
  note(kind: string) {
    if (this.#active) this.#events.set(kind, (this.#events.get(kind) ?? 0) + 1)
  }

  /**
   * The end of the tour: the checklist stays on screen and turns into a
   * congratulations, rather than vanishing the instant the last box ticks.
   * Disappearing was the whole problem — the tutorial ended and nothing said
   * so, which reads as the tutorial having quietly broken.
   */
  #finale() {
    this.#done = true
    this.#advance = 0
    localStorage.setItem(DONE_KEY, "1")
    this.#btnLabel.textContent = "Tutorial"
    this.#chEl.textContent = `✓ ${FINALE.title}`
    this.#progEl.textContent = `${CHAPTERS.length}/${CHAPTERS.length} chapters`
    this.#actionEl.textContent = ""
    this.#actionEl.style.display = "none"
    this.#keysEl.innerHTML = ""
    this.#textEl.textContent = FINALE.text
    this.#hintEl.textContent = FINALE.hint
    this.#hintEl.style.display = ""
    // Every cell of every chapter, cleared.
    this.#drawSegments(CHAPTERS.length, CHAPTERS.length)
    this.#objEl.classList.add("done")
    this.#dotsEl.innerHTML = CHAPTERS.map(() => `<span class="tut-dot on"></span>`).join("")
    this.#segFill = null
    this.#skipBtn.style.display = "none"
    this.#exitBtn.textContent = "close"
    this.#panel.classList.remove("swap")
    void this.#panel.offsetWidth
    this.#panel.classList.add("swap")
    this.#ctx.message("Tutorial complete — the city is yours 🎉", 6)
  }

  update(dt: number) {
    if (!this.#active) return
    // The last chapter asks you to open the map, and the map is drawn over the
    // whole hud — so the instructions for using it were behind it. Lift the hud
    // for exactly as long as the map is up.
    this.#hud.classList.toggle("tutorial-over-map", this.#ctx.mapOpen())
    if (this.#done) return
    if (this.#advance > 0) {
      this.#advance -= dt
      if (this.#advance <= 0) this.#next()
      return
    }
    const step = CHAPTERS[this.#ci].steps[this.#si]
    const r = step.check(this.#ctx, dt, this.#scratch, this.#events)
    const p = typeof r === "boolean" ? (r ? 1 : 0) : Math.min(1, r)
    if (this.#segFill) this.#segFill.style.width = `${(p * 100).toFixed(1)}%`
    if (p >= 1) {
      this.#objEl.classList.add("done")
      this.#advance = 0.85
    }
  }

  #next() {
    if (this.#advanceIndex()) this.#enterStep()
  }

  /** Move to the next step, or finish. False once the finale has taken over. */
  #advanceIndex(): boolean {
    this.#si++
    if (this.#si >= CHAPTERS[this.#ci].steps.length) {
      this.#ci++
      this.#si = 0
      if (this.#ci >= CHAPTERS.length) {
        this.#finale()
        return false
      }
      CHAPTERS[this.#ci].onEnter?.(this.#ctx)
    }
    return true
  }

  #enterStep() {
    this.#events.clear()
    this.#advance = 0
    // A "head over there" beat you are already standing on must not open at
    // all. Opening it and ticking it a frame later is what makes the checklist
    // look like it is advancing on its own — you see a card you never had a
    // chance to read. Only travel beats are elided this way; a real objective
    // always gets its card, even if you happen to satisfy it instantly.
    for (let guard = 0; guard < 32; guard++) {
      const pending = CHAPTERS[this.#ci].steps[this.#si]
      if (!pending.skipIfSatisfied) break
      const probe = freshScratch()
      const r = pending.check(this.#ctx, 0, probe, this.#events)
      // `>= 1`, never `< 1`: a NaN reading must leave the step standing, not
      // elide it. Every inequality against NaN is false, so the negated test
      // would treat "no idea" as "already done".
      if (!((typeof r === "boolean" ? (r ? 1 : 0) : r) >= 1)) break
      if (!this.#advanceIndex()) return
    }
    this.#scratch = freshScratch()
    const ch = CHAPTERS[this.#ci]
    const step = ch.steps[this.#si]
    step.onEnter?.(this.#ctx)

    this.#chEl.textContent = `${this.#ci + 1} · ${ch.title}`
    this.#progEl.textContent = `step ${this.#si + 1} of ${ch.steps.length}`
    this.#drawSegments(ch.steps.length, this.#si)
    // A travel beat has an action ("Head") and no keys — the verb is the whole
    // instruction there, so show it whenever the step names one, not only when
    // there is a key to press beside it.
    const action = step.keys?.length ? step.action ?? "Press" : step.action ?? ""
    this.#actionEl.textContent = action
    this.#actionEl.style.display = action ? "" : "none"
    this.#keysEl.innerHTML = (step.keys ?? []).map((k) => `<span class="k">${k}</span>`).join("")
    this.#textEl.textContent = step.text
    this.#hintEl.textContent = step.hint ?? ""
    this.#hintEl.style.display = step.hint ? "" : "none"
    // The dots are chapters, the bar cells are the steps inside this one. Only
    // chapters BEFORE this one are filled — lighting the current chapter's dot
    // on arrival was half of why finishing a chapter looked like nothing.
    this.#dotsEl.innerHTML = CHAPTERS.map(
      (_, i) => `<span class="tut-dot${i < this.#ci ? " on" : i === this.#ci ? " now" : ""}"></span>`
    ).join("")
    this.#objEl.classList.remove("done")
    // restart the slide-in so each new objective reads as a fresh card
    this.#panel.classList.remove("swap")
    void this.#panel.offsetWidth
    this.#panel.classList.add("swap")
  }
}
