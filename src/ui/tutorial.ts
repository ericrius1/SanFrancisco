import type { PlayerMode } from "../player/types"
import { PIER_ENTRANCE, DOME_WORLD, insidePier } from "../gameplay/pierLayout"

/**
 * Interactive tutorial: a chaptered checklist that watches real play instead
 * of narrating over it. The "Tutorial" button (top-right, under Share) is
 * always on screen outside immersive mode; clicking it walks a newcomer from
 * WASD through stepping inside a building, the vehicle roster, the map/teleport
 * flow and a field trip into the Exploratorium. main.ts feeds it a thin context of
 * getters plus one-shot events (note("teleport") etc.) — the tutorial never
 * reaches into game objects itself.
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

const CHAPTERS: Chapter[] = [
  {
    title: "First steps",
    steps: [
      { keys: ["1"], text: "to get on your own two feet", check: (c) => c.mode() === "walk" },
      {
        keys: ["Mouse"],
        action: "Move",
        text: "to look around",
        hint: "click the city first if the cursor is loose — Esc lets it go",
        check: (c, _dt, st) => (st.n += c.mouseDelta()) / 400
      },
      {
        keys: ["W", "A", "S", "D"],
        action: "Use",
        text: "to take a stroll",
        check: (c, _dt, st) => traveled(c, st, 12, c.mode() === "walk")
      },
      {
        keys: ["Shift"],
        action: "Hold",
        text: "to sprint",
        check: (c, _dt, st) => traveled(c, st, 22, c.mode() === "walk" && shiftDown(c))
      },
      { keys: ["Space"], text: "to jump", check: (c) => c.mode() === "walk" && c.pressed("Space") }
    ]
  },
  {
    title: "Step inside",
    onEnter: (c) => c.message("Every building has a front door — walk in and explore, then step back out", 4),
    steps: [
      {
        keys: ["W"],
        action: "Walk",
        text: "up to a building and in through its door",
        check: (c, _dt, st) => traveled(c, st, 15, c.mode() === "walk")
      }
    ]
  },
  {
    title: "Wheels & wings",
    onEnter: (c) => c.message("Seven ways to get around — the number keys switch between them", 4),
    steps: [
      { keys: ["2"], text: "to summon the car", check: (c) => c.mode() === "drive" },
      {
        keys: ["W"],
        action: "Hold",
        text: "to burn some rubber",
        hint: "Shift boosts · Space drifts",
        check: (c, _dt, st) => traveled(c, st, 80, c.mode() === "drive")
      },
      { keys: ["6"], text: "to hop on the hoverboard", check: (c) => c.mode() === "board" },
      { keys: ["Space"], text: "to ollie", check: (c) => c.mode() === "board" && c.pressed("Space") },
      { keys: ["7"], text: "to become the phoenix", check: (c) => c.mode() === "bird" },
      {
        keys: ["Space"],
        text: "to flap and climb 20 m into the sky",
        hint: "look down + Shift to dive",
        check: (c, _dt, st) => climbed(c, st, 20, c.mode() === "bird")
      }
    ]
  },
  {
    title: "Anywhere, instantly",
    steps: [
      { keys: ["M"], text: "to open the city map", check: (c) => c.mapOpen() },
      {
        text: "pick a landmark and hit Teleport",
        hint: "drag pans · click a dot, then the Teleport button",
        check: (_c, _dt, _st, ev) => (ev.get("teleport") ?? 0) >= 1
      }
    ]
  },
  {
    title: "The Exploratorium",
    onEnter: (c) => {
      c.teleport({ x: PIER_ENTRANCE.x, y: PIER_ENTRANCE.y, z: PIER_ENTRANCE.z, facing: PIER_ENTRANCE.facing, mode: "walk" })
      c.message("Field trip — Pier 15, the Exploratorium", 3.5)
    },
    steps: [
      {
        keys: ["W"],
        action: "Hold",
        text: "to head through the front doors",
        check: (c) => c.mode() === "walk" && insidePier(c.pos().x, c.pos().z)
      },
      {
        text: "walk the hall to the domed theater at the far end",
        hint: "past the sand tables and the water room",
        check: (c) => {
          const p = c.pos()
          return Math.hypot(p.x - DOME_WORLD.x, p.z - DOME_WORLD.z) < 11
        }
      },
      { keys: ["E"], text: "to sit down at the piano", check: (_c, _dt, _st, ev) => (ev.get("piano") ?? 0) >= 1 },
      { keys: ["1–8"], text: "to play three notes", check: (_c, _dt, _st, ev) => (ev.get("note") ?? 0) / 3 },
      { keys: ["B"], action: "Hold", text: "for a fireworks finale", check: (c, dt, st) => (st.n += c.down("KeyB") ? dt : 0) / 0.6 }
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

  /** One-shot gameplay events from main.ts: "teleport", "piano", "note". */
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
