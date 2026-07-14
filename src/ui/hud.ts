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
    { c: ["E"], label: "hop on a ride" },
    { c: ["Click"], label: "shoot" }
  ],
  drive: [
    { c: ["Mouse"], label: "look" },
    { c: ["W", "S"], label: "gas · brake" },
    { c: ["A", "D"], label: "steer" },
    { c: ["[", "]"], label: "power slide" },
    { c: ["Space"], label: "handbrake" },
    { c: ["Shift"], label: "boost" },
    { c: ["E"], label: "get out" },
    { c: ["Click"], label: "shoot" }
  ],
  scooter: [
    { c: ["Mouse"], label: "look" },
    { c: ["W", "S"], label: "go · reverse" },
    { c: ["A", "D"], label: "steer" },
    { c: ["[", "]"], label: "power slide" },
    { c: ["Space"], label: "handbrake" },
    { c: ["Shift"], label: "boost" },
    { c: ["E"], label: "hop off" }
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
  surf: [
    { c: ["Locked"], label: "camera follows the wave" },
    { c: ["W", "S"], label: "pump · stall" },
    { c: ["A", "D"], label: "carve left / right" },
    { c: ["Space"], label: "flow when ready" },
    { c: ["Auto"], label: "lip launch" },
    { c: ["E"], label: "exit to beach" }
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

// Xbox controller controls per mode (Input.pollPad's mapping; Y = RDR2-style interact)
const PAD: Record<PlayerMode, Row[]> = {
  walk: [
    { c: ["RS"], label: "look" },
    { c: ["LS"], label: "move" },
    { c: ["L3", "LT"], label: "run" },
    { c: ["A"], label: "jump" },
    { c: ["Y"], label: "hop on a ride" },
    { c: ["RT"], label: "shoot" }
  ],
  drive: [
    { c: ["RS"], label: "look" },
    { c: ["RT"], label: "gas" },
    { c: ["LS"], label: "steer" },
    { c: ["LB", "RB"], label: "power slide" },
    { c: ["A"], label: "handbrake" },
    { c: ["L3", "LT"], label: "boost" },
    { c: ["Y"], label: "get out" },
    { c: ["X"], label: "shoot" }
  ],
  scooter: [
    { c: ["RS"], label: "look" },
    { c: ["RT"], label: "go" },
    { c: ["LS"], label: "steer" },
    { c: ["LB", "RB"], label: "power slide" },
    { c: ["A"], label: "handbrake" },
    { c: ["L3", "LT"], label: "boost" },
    { c: ["Y"], label: "hop off" }
  ],
  plane: [
    { c: ["RS"], label: "aim nose" },
    { c: ["LS"], label: "turn" },
    { c: ["RT"], label: "throttle" },
    { c: ["L3", "LT"], label: "boost" },
    { c: ["A"], label: "air brake" },
    { c: ["X"], label: "shoot" }
  ],
  boat: [
    { c: ["RS"], label: "look" },
    { c: ["RT"], label: "throttle" },
    { c: ["LS"], label: "steer" },
    { c: ["L3", "LT"], label: "boost" },
    { c: ["X"], label: "shoot" }
  ],
  speedboat: [
    { c: ["RS"], label: "look" },
    { c: ["RT"], label: "throttle" },
    { c: ["LS"], label: "steer" },
    { c: ["L3", "LT"], label: "boost" },
    { c: ["Y"], label: "get out" },
    { c: ["X"], label: "shoot" }
  ],
  drone: [
    { c: ["RS"], label: "aim" },
    { c: ["LS"], label: "move" },
    { c: ["RT", "LB"], label: "up · down" },
    { c: ["L3", "LT"], label: "boost" },
    { c: ["A"], label: "hover" },
    { c: ["Y"], label: "land" },
    { c: ["X"], label: "shoot" }
  ],
  board: [
    { c: ["RS ↔"], label: "look" },
    { c: ["RS ↕"], label: "pitch · hold to flip" },
    { c: ["RT"], label: "push" },
    { c: ["LS"], label: "carve" },
    { c: ["A"], label: "ollie" },
    { c: ["L3", "LT"], label: "boost" },
    { c: ["X"], label: "shoot" }
  ],
  surf: [
    { c: ["Locked"], label: "camera follows the wave" },
    { c: ["RT", "LT"], label: "pump · stall" },
    { c: ["LS"], label: "carve left / right" },
    { c: ["A"], label: "flow when ready" },
    { c: ["Auto"], label: "lip launch" },
    { c: ["Y"], label: "exit to beach" }
  ],
  bird: [
    { c: ["RS"], label: "aim" },
    { c: ["LS"], label: "move" },
    { c: ["A"], label: "flap · climb" },
    { c: ["L3", "LT"], label: "tuck dive" },
    { c: ["LB", "RB"], label: "twirl" },
    { c: ["RT"], label: "shoot" }
  ]
}

// one-liner flavor tip under the controls
const TIPS: Partial<Record<PlayerMode, string>> = {
  walk: "Every building has a front door — walk in and explore",
  drive: "LB/RB power-slide · release for a snap boost · Space handbrake",
  scooter: "LB/RB power-slide · ramps launch cleanly · rear seat fits a friend",
  board: "White glow = nose · pull right stick back in the air to flip",
  surf: "Neutral input keeps you riding · mouse and right stick cannot move this camera",
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

/** Named HUD panels for per-panel visibility control (setPanelHidden / soloPanel). */
const PANELS: Record<string, string> = {
  help: ".help",
  toolbar: ".toolbar",
  audio: ".audio",
  chat: ".chat",
  minimap: ".minimap",
  history: ".place-history",
  avatar: ".avatar-ui:not(.board-ui):not(.scooter-ui):not(.car-ui)",
  board: ".board-ui",
  scooter: ".scooter-ui",
  car: ".car-ui",
  satchel: ".satchel",
  share: ".share-ui",
  tutorial: ".tutorial-ui, .tutorial-panel",
  links: ".links-ui",
  locator: ".player-locator",
  pause: ".pause-ui",
  restore: ".ui-restore",
}

export class HUD {
  #root = document.getElementById("hud")!
  #help = document.querySelector<HTMLElement>('[data-hud="help"]')!
  #center = document.querySelector<HTMLElement>('[data-hud="center"]')!
  #history = document.createElement("div")
  #msgTimer = 0
  #current: PlayerMode = "walk"
  #device: "kb" | "pad" = "kb"
  #toolVerb = "hold 1s to throw" // what a click does right now (the toolbar's tool)
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
    if (verb === this.#toolVerb) return
    this.#toolVerb = verb
    this.#renderHelp()
  }

  setMode(mode: PlayerMode) {
    if (mode === this.#current) return
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
          { c: ["Back"], label: "map" },
          { c: ["R3"], label: "view" },
          { c: ["Start"], label: "pause" }
        ]
      : [
          { c: ["Z"], label: "hold — time of day" },
          { c: ["N"], label: "hold — look / speed" },
          { c: ["P"], label: "pause" },
          { c: ["C"], label: "view" },
          { c: ["/"], label: "debug" },
          { c: ["I"], label: "immersive" },
          { c: ["F"], label: "fullscreen" }
        ]
    )
      .filter((r) => this.#current !== "surf" || r.label !== "view")
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

  /** Hide/show one named panel (see PANELS). Unlike Tab-fade this is a hard
   *  display:none, independent of the faded state. */
  setPanelHidden(name: string, hidden: boolean) {
    const sel = PANELS[name]
    if (!sel) return
    for (const el of this.#root.querySelectorAll<HTMLElement>(sel)) {
      el.classList.toggle("panel-hidden", hidden)
    }
  }

  /** Show only the named panel, hiding every other registered one.
   *  Pass null to restore everything. */
  soloPanel(name: string | null) {
    for (const key of Object.keys(PANELS)) {
      this.setPanelHidden(key, name !== null && key !== name)
    }
  }

  panelNames(): string[] {
    return Object.keys(PANELS)
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
