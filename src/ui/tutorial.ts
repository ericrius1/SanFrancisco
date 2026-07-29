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
 * them. Every zone-backed step also has a body-only fallback — the same check
 * the tutorial used before there was a field — so a player who starts the
 * tutorial while the site is still streaming, or who wanders off it entirely,
 * still makes progress by doing the thing. Nothing here can softlock on a chunk.
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
type Scratch = { n: number; base: number | null; px: number | null; pz: number | null }

type Step = {
  keys?: string[]
  action?: string
  text: string
  hint?: string
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
 * Progress for a step the flight school can measure, never below what the
 * player's own body already earned.
 *
 * Both readings are taken every frame — the fallback has an accumulator that
 * would otherwise sit at zero — and the larger wins. That is what keeps the
 * two sources from fighting: a step part-finished on the lawn does not reset
 * when the field finishes streaming in, and a step finished out in the city
 * completes without the field at all.
 */
function zoneOr(
  ctx: TutorialCtx,
  read: (zone: TutorialZoneProgress) => number | boolean,
  fallback: number | boolean
): number {
  const asNumber = (v: number | boolean) => (typeof v === "boolean" ? (v ? 1 : 0) : v)
  const zone = ctx.zone?.() ?? null
  return Math.max(asNumber(fallback), zone ? asNumber(read(zone)) : 0)
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
        check: (c, _dt, st) =>
          zoneOr(c, (z) => z.gatesPassed / 3, traveled(c, st, 26, c.mode() === "walk"))
      },
      {
        keys: ["Shift"],
        action: "Hold",
        text: "to sprint the chalk lane between the bollards",
        check: (c, _dt, st) =>
          zoneOr(c, (z) => z.sprintMeters / 26, traveled(c, st, 22, c.mode() === "walk" && shiftDown(c)))
      },
      {
        keys: ["Space"],
        text: "to jump the hay bales at the end of the lane",
        check: (c) => zoneOr(c, (z) => z.hurdleCleared, c.mode() === "walk" && c.pressed("Space"))
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
        check: (c, _dt, st) => zoneOr(c, (z) => z.cottageVisited, traveled(c, st, 15, c.mode() === "walk"))
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
      {
        keys: ["W"],
        action: "Hold",
        text: "to drive a full lap of the oval",
        hint: "Shift boosts · Space drifts · the banking holds you through the bends",
        check: (c, _dt, st) => zoneOr(c, (z) => z.lapFraction, traveled(c, st, 240, c.mode() === "drive"))
      }
    ]
  },
  {
    title: "The bowl",
    onEnter: (c) => c.message("Concrete bowl on the south-west corner — ride in, and come out of it flying.", 4),
    steps: [
      modeStep("board", "to hop on the hoverboard"),
      {
        keys: ["Space"],
        text: "to ollie out of the bowl and hang in the air",
        hint: "drop in from the deck, carry your speed up the far wall",
        check: (c) => zoneOr(c, (z) => z.bowlAir / 0.6, c.mode() === "board" && c.pressed("Space") ? 1 : 0)
      }
    ]
  },
  {
    title: "Out over the bay",
    onEnter: (c) => c.message("Six rings climb off the bowl and out over the water. Fly them in order.", 4.5),
    steps: [
      modeStep("bird", "to become the phoenix"),
      {
        keys: ["Space"],
        text: "to flap through all six rings",
        hint: "look down + Shift to dive · the lit ring is your next one",
        check: (c, _dt, st) => zoneOr(c, (z) => z.ringsFlown / 6, climbed(c, st, 30, c.mode() === "bird"))
      }
    ]
  },
  {
    title: "Anywhere, instantly",
    onEnter: (c) => c.message("Last thing: the map. It goes anywhere in the city, from anywhere in the city.", 4),
    steps: [
      { keys: ["M"], text: "to open the city map", check: (c) => c.mapOpen() },
      {
        text: "pick a landmark and press Enter",
        hint: "drag pans · click a spot, then Enter to teleport",
        check: (_c, _dt, _st, ev) => (ev.get("teleport") ?? 0) >= 1
      }
    ]
  }
]

const DONE_KEY = "sf-tutorial-done"

export class Tutorial {
  #ctx: TutorialCtx
  #btnLabel: HTMLSpanElement
  #panel: HTMLDivElement
  #chEl: HTMLElement
  #progEl: HTMLElement
  #objEl: HTMLElement
  #actionEl: HTMLElement
  #keysEl: HTMLElement
  #textEl: HTMLElement
  #fillEl: HTMLElement
  #hintEl: HTMLElement
  #dotsEl: HTMLElement

  #active = false
  #ci = 0
  #si = 0
  #scratch: Scratch = { n: 0, base: null, px: null, pz: null }
  #events = new Map<string, number>()
  #advance = 0 // ✓ shown; seconds until the next step slides in

  get active() {
    return this.#active
  }

  constructor(ctx: TutorialCtx) {
    this.#ctx = ctx
    const hud = document.getElementById("hud")!

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
      `<div class="tut-bar"><div class="tut-fill"></div></div>` +
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
    this.#fillEl = this.#panel.querySelector(".tut-fill")!
    this.#hintEl = this.#panel.querySelector(".tut-hint")!
    this.#dotsEl = this.#panel.querySelector(".tut-dots")!
    this.#panel.querySelector(".tut-skip")!.addEventListener("click", () => {
      if (this.#advance <= 0) this.#next()
    })
    this.#panel.querySelector(".tut-exit")!.addEventListener("click", () => this.stop(false))
    hud.appendChild(this.#panel)
  }

  start() {
    this.#active = true
    this.#ci = 0
    this.#si = 0
    this.#advance = 0
    this.#panel.style.display = ""
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

  update(dt: number) {
    if (!this.#active) return
    if (this.#advance > 0) {
      this.#advance -= dt
      if (this.#advance <= 0) this.#next()
      return
    }
    const step = CHAPTERS[this.#ci].steps[this.#si]
    const r = step.check(this.#ctx, dt, this.#scratch, this.#events)
    const p = typeof r === "boolean" ? (r ? 1 : 0) : Math.min(1, r)
    this.#fillEl.style.width = `${(p * 100).toFixed(1)}%`
    if (p >= 1) {
      this.#objEl.classList.add("done")
      this.#advance = 0.85
    }
  }

  #next() {
    this.#si++
    if (this.#si >= CHAPTERS[this.#ci].steps.length) {
      this.#ci++
      this.#si = 0
      if (this.#ci >= CHAPTERS.length) {
        this.stop(true)
        return
      }
      CHAPTERS[this.#ci].onEnter?.(this.#ctx)
    }
    this.#enterStep()
  }

  #enterStep() {
    this.#scratch = { n: 0, base: null, px: null, pz: null }
    this.#events.clear()
    this.#advance = 0
    const ch = CHAPTERS[this.#ci]
    const step = ch.steps[this.#si]
    step.onEnter?.(this.#ctx)

    this.#chEl.textContent = `${this.#ci + 1} · ${ch.title}`
    this.#progEl.textContent = `step ${this.#si + 1}/${ch.steps.length}`
    this.#actionEl.textContent = step.keys?.length ? step.action ?? "Press" : ""
    this.#actionEl.style.display = step.keys?.length ? "" : "none"
    this.#keysEl.innerHTML = (step.keys ?? []).map((k) => `<span class="k">${k}</span>`).join("")
    this.#textEl.textContent = step.text
    this.#hintEl.textContent = step.hint ?? ""
    this.#hintEl.style.display = step.hint ? "" : "none"
    this.#fillEl.style.width = "0%"
    this.#dotsEl.innerHTML = CHAPTERS.map((_, i) => `<span class="tut-dot${i <= this.#ci ? " on" : ""}"></span>`).join("")
    this.#objEl.classList.remove("done")
    // restart the slide-in so each new objective reads as a fresh card
    this.#panel.classList.remove("swap")
    void this.#panel.offsetWidth
    this.#panel.classList.add("swap")
  }
}
