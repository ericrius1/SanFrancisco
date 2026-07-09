import type { PlayerMode } from "../player/types"

/** One help row: keycap chips + what they do. */
type Row = { c: string[]; label: string }

// keyboard/mouse controls per mode
const KB: Record<PlayerMode, Row[]> = {
  walk: [
    { c: ["Mouse"], label: "look" },
    { c: ["W", "A", "S", "D"], label: "move" },
    { c: ["Shift"], label: "run" },
    { c: ["Space"], label: "jump" },
    { c: ["E"], label: "hop in a car" },
    { c: ["Click"], label: "shoot" }
  ],
  drive: [
    { c: ["Mouse"], label: "look" },
    { c: ["W", "S"], label: "gas · brake" },
    { c: ["A", "D"], label: "steer" },
    { c: ["Space"], label: "drift" },
    { c: ["Shift"], label: "boost" },
    { c: ["E"], label: "get out" },
    { c: ["Click"], label: "shoot" }
  ],
  plane: [
    { c: ["Mouse"], label: "aim nose" },
    { c: ["W", "S"], label: "throttle" },
    { c: ["A", "D"], label: "turn" },
    { c: ["Shift"], label: "boost" },
    { c: ["Space"], label: "air brake" },
    { c: ["Click"], label: "shoot" }
  ],
  boat: [
    { c: ["Mouse"], label: "look" },
    { c: ["W", "S"], label: "throttle" },
    { c: ["A", "D"], label: "steer" },
    { c: ["Shift"], label: "boost" },
    { c: ["Click"], label: "shoot" }
  ],
  speedboat: [
    { c: ["Mouse"], label: "look" },
    { c: ["W", "S"], label: "throttle" },
    { c: ["A", "D"], label: "steer" },
    { c: ["Shift"], label: "boost" },
    { c: ["E"], label: "get out" },
    { c: ["Click"], label: "shoot" }
  ],
  drone: [
    { c: ["Mouse"], label: "aim" },
    { c: ["W", "S"], label: "along the view" },
    { c: ["A", "D"], label: "strafe" },
    { c: ["E", "Q"], label: "up · down" },
    { c: ["Space"], label: "hover" },
    { c: ["Shift"], label: "boost" },
    { c: ["Click"], label: "shoot" }
  ],
  board: [
    { c: ["Mouse"], label: "look" },
    { c: ["W"], label: "push" },
    { c: ["S"], label: "reverse" },
    { c: ["A", "D"], label: "carve" },
    { c: ["Space"], label: "ollie" },
    { c: ["Shift"], label: "boost" },
    { c: ["Click"], label: "shoot" }
  ],
  bird: [
    { c: ["Mouse"], label: "aim" },
    { c: ["W", "S"], label: "along the view" },
    { c: ["A", "D"], label: "strafe" },
    { c: ["Space"], label: "flap · climb" },
    { c: ["Shift"], label: "tuck dive" },
    { c: ["Q", "E"], label: "twirl" },
    { c: ["Click"], label: "shoot" }
  ]
}

// Xbox controller controls per mode (Input.pollPad's mapping)
const PAD: Record<PlayerMode, Row[]> = {
  walk: [
    { c: ["RS"], label: "look" },
    { c: ["LS"], label: "move" },
    { c: ["RB"], label: "run" },
    { c: ["A"], label: "jump" },
    { c: ["B"], label: "hop in a car" },
    { c: ["X"], label: "shoot" }
  ],
  drive: [
    { c: ["RS"], label: "look" },
    { c: ["RT", "LT"], label: "gas · brake" },
    { c: ["LS"], label: "steer" },
    { c: ["A"], label: "drift" },
    { c: ["RB"], label: "boost" },
    { c: ["B"], label: "get out" },
    { c: ["X"], label: "shoot" }
  ],
  plane: [
    { c: ["RS"], label: "aim nose" },
    { c: ["LS"], label: "turn" },
    { c: ["RT", "LT"], label: "throttle" },
    { c: ["RB"], label: "boost" },
    { c: ["A"], label: "air brake" },
    { c: ["X"], label: "shoot" }
  ],
  boat: [
    { c: ["RS"], label: "look" },
    { c: ["RT", "LT"], label: "throttle" },
    { c: ["LS"], label: "steer" },
    { c: ["RB"], label: "boost" },
    { c: ["X"], label: "shoot" }
  ],
  speedboat: [
    { c: ["RS"], label: "look" },
    { c: ["RT", "LT"], label: "throttle" },
    { c: ["LS"], label: "steer" },
    { c: ["RB"], label: "boost" },
    { c: ["B"], label: "get out" },
    { c: ["X"], label: "shoot" }
  ],
  drone: [
    { c: ["RS"], label: "aim" },
    { c: ["LS"], label: "move" },
    { c: ["B", "LB"], label: "up · down" },
    { c: ["A"], label: "hover" },
    { c: ["RB"], label: "boost" },
    { c: ["X"], label: "shoot" }
  ],
  board: [
    { c: ["RS"], label: "look" },
    { c: ["RT"], label: "push" },
    { c: ["LT"], label: "reverse" },
    { c: ["LS"], label: "carve" },
    { c: ["A"], label: "ollie" },
    { c: ["RB"], label: "boost" },
    { c: ["X"], label: "shoot" }
  ],
  bird: [
    { c: ["RS"], label: "aim" },
    { c: ["LS"], label: "move" },
    { c: ["A"], label: "flap · climb" },
    { c: ["RB"], label: "tuck dive" },
    { c: ["LB", "B"], label: "twirl" },
    { c: ["X"], label: "shoot" }
  ]
}

// one-liner flavor tip under the controls
const TIPS: Partial<Record<PlayerMode, string>> = {
  walk: "Every building has a front door — walk in and explore",
  drive: "Handbrake (Space) drifts · Shift boosts",
  board: "White glow = nose · surfs streets, hills and the bay",
  bird: "Look down + Shift to stoop — skim the bay for spray"
}

// Xbox face buttons get their signature colors
const FACE_CLASS: Record<string, string> = {
  A: "fa",
  B: "fb",
  X: "fx",
  Y: "fy"
}

function chips(tokens: string[], pad: boolean): string {
  return tokens
    .map((t) => {
      const face = pad ? FACE_CLASS[t] : undefined
      return `<span class="k${face ? ` f ${face}` : ""}">${t}</span>`
    })
    .join("")
}

export class HUD {
  #root = document.getElementById("hud")!
  #help = document.querySelector<HTMLElement>('[data-hud="help"]')!
  #center = document.querySelector<HTMLElement>('[data-hud="center"]')!
  #history = document.createElement("div")
  #msgTimer = 0
  #current: PlayerMode = "walk"
  #device: "kb" | "pad" = "kb"
  #toolVerb = "sling paintballs" // what a click does right now (the toolbar's tool)
  #historyCanBack = false
  #historyCanForward = false

  onHistoryBack: () => void = () => {}
  onHistoryForward: () => void = () => {}

  constructor() {
    this.#history.className = "place-history"
    this.#root.appendChild(this.#history)
    this.#history.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest('[data-history="back"]')) {
        this.onHistoryBack()
      } else if ((e.target as HTMLElement).closest('[data-history="forward"]')) {
        this.onHistoryForward()
      }
    })
    this.#renderHistory()
  }

  /** The Click/X row tracks the active toolbar tool. */
  setToolVerb(verb: string) {
    this.#toolVerb = verb
    this.#renderHelp()
  }

  setMode(mode: PlayerMode) {
    this.#current = mode
    this.#renderHelp()
  }

  setTeleportHistory(canBack: boolean, canForward: boolean) {
    if (canBack === this.#historyCanBack && canForward === this.#historyCanForward) return
    this.#historyCanBack = canBack
    this.#historyCanForward = canForward
    this.#renderHistory()
  }

  /** Swap the help labels to whichever device was touched last. */
  setDevice(device: "kb" | "pad") {
    if (device === this.#device) return
    this.#device = device
    this.#renderHistory()
    this.#renderHelp()
  }

  #renderHistory() {
    const pad = this.#device === "pad"
    this.#history.innerHTML =
      `<button class="history-btn" data-history="back" type="button" title="Back (Alt+Left)"${this.#historyCanBack ? "" : " disabled"}>` +
      `<span class="hist-main">Back</span><span class="hist-keys">${chips(["Alt", "←"], pad)}</span></button>` +
      `<button class="history-btn" data-history="forward" type="button" title="Forward (Alt+Right)"${this.#historyCanForward ? "" : " disabled"}>` +
      `<span class="hist-main">Forward</span><span class="hist-keys">${chips(["Alt", "→"], pad)}</span></button>`
  }

  #renderHelp() {
    const pad = this.#device === "pad"
    const html: string[] = []

    const source = (pad ? PAD : KB)[this.#current]
    const allRows = pad
      ? source
      : [
          ...source,
          { c: ["M"], label: "map" },
          { c: ["T"], label: "chat" },
          { c: ["Tab"], label: "toggle UI" },
          { c: ["Esc"], label: "release mouse" }
        ]
    const rows = allRows
      .map(
        (r) =>
          `<div class="keys">${chips(r.c, pad)}</div>` +
          `<div class="lbl">${r.label === "shoot" ? this.#toolVerb : r.label}</div>`
      )
      .join("")

    const extraRows = (pad
      ? [
          { c: ["Y"], label: "respawn" },
          { c: ["R3"], label: "camera" },
          { c: ["▲"], label: "fireworks" },
          { c: ["Start"], label: "pause" },
          { c: ["Back"], label: "immersive" }
        ]
      : [
          { c: ["R"], label: "respawn" },
          { c: ["B"], label: "fireworks" },
          { c: ["Z"], label: "hold — time of day" },
          { c: ["P"], label: "pause" },
          { c: ["C"], label: "camera" },
          { c: ["N"], label: "ride AI car" },
          { c: ["/"], label: "debug" },
          { c: ["I"], label: "immersive" },
          { c: ["F"], label: "fullscreen" }
        ]
    )
      .map(
        (r) =>
          `<div class="keys">${chips(r.c, pad)}</div>` +
          `<div class="lbl">${r.label}</div>`
      )
      .join("")
    const extras = `<div class="extras"><div class="grid">${extraRows}</div></div>`

    html.push(`<div class="cols"><div class="grid">${rows}</div>${extras}</div>`)

    const tip = TIPS[this.#current]
    if (tip) html.push(`<div class="tip">${tip}</div>`)

    this.#help.innerHTML = html.join("")
    // restart the fade-in so mode/device swaps read as a deliberate change
    this.#help.classList.remove("swap")
    void this.#help.offsetWidth
    this.#help.classList.add("swap")
  }

  setHidden(hidden: boolean) {
    this.#root.style.display = hidden ? "none" : ""
  }

  /** Fade the help panel + toolbar (center messages stay). CSS animates it. */
  setFaded(faded: boolean) {
    this.#root.classList.toggle("faded", faded)
  }

  message(text: string, seconds = 2.6) {
    this.#center.textContent = text
    this.#center.classList.add("show") // CSS rises + fades it in
    this.#msgTimer = seconds
  }

  update(dt: number) {
    if (this.#msgTimer > 0) {
      this.#msgTimer -= dt
      // fade the toast out (keep the text so the words fade, not pop away)
      if (this.#msgTimer <= 0) this.#center.classList.remove("show")
    }
  }
}
