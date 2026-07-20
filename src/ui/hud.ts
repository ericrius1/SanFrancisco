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
    { c: ["U", "Q"], label: "up · down" },
    { c: ["Space"], label: "fly up" },
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
    { c: ["Locked"], label: "camera frames the shore" },
    { c: ["A", "D"], label: "carve left · right" },
    { c: ["W"], label: "climb the face · pump" },
    { c: ["S"], label: "stall in the pocket · barrel" },
    { c: ["A", "A"], label: "double-tap = cutback" },
    { c: ["Space"], label: "jump · natural air off the lip" },
    { c: ["X"], label: "flow when ready" },
    { c: ["E"], label: "exit to beach" }
  ],
  bird: [
    { c: ["Mouse"], label: "aim" },
    { c: ["W", "S"], label: "along the view" },
    { c: ["A", "D"], label: "strafe" },
    { c: ["Space"], label: "flap · climb" },
    { c: ["Shift"], label: "tuck dive" },
    { c: ["Q"], label: "twirl" },
    { c: ["E"], label: "dismount" },
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
    { c: ["LT"], label: "reverse" },
    { c: ["LS"], label: "steer" },
    { c: ["LB"], label: "boost" },
    { c: ["RB"], label: "power slide" },
    { c: ["A"], label: "handbrake" },
    { c: ["L3"], label: "boost" },
    { c: ["Y"], label: "get out" },
    { c: ["X"], label: "shoot" }
  ],
  scooter: [
    { c: ["RS"], label: "look" },
    { c: ["RT"], label: "go" },
    { c: ["LS"], label: "steer" },
    { c: ["LB"], label: "power slide" },
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
    { c: ["A"], label: "fly up" },
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
    { c: ["Locked"], label: "camera frames the shore" },
    { c: ["LS ↔"], label: "carve · double-flick = cutback" },
    { c: ["LS ↕", "RT", "LT"], label: "climb/pump · stall" },
    { c: ["A"], label: "jump · natural air off the lip" },
    { c: ["X"], label: "flow when ready" },
    { c: ["Y"], label: "exit to beach" }
  ],
  bird: [
    { c: ["RS"], label: "aim" },
    { c: ["LS"], label: "move" },
    { c: ["A"], label: "flap · climb" },
    { c: ["L3", "LT"], label: "tuck dive" },
    { c: ["LB", "RB"], label: "twirl" },
    { c: ["Y"], label: "dismount" },
    { c: ["RT"], label: "shoot" }
  ]
}

// one-liner flavor tip under the controls
const TIPS: Partial<Record<PlayerMode, string>> = {
  walk: "Every building has a front door — walk in and explore",
  drive: "LB boost · RB power-slide with steer · release for a snap boost · Space handbrake",
  scooter: "LB power-slide with steer · ramps launch cleanly · rear seat fits a friend",
  board: "White glow = nose · pull right stick back in the air to flip",
  surf: "W climbs and pumps · S stalls in the pocket for a barrel · double-tap A/D to cut back",
  bird: "Three-seat saddle — two friends can press E nearby and fly with you"
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
  wakeCity: ".wake-city-ui",
  tutorial: ".tutorial-ui, .tutorial-panel",
  links: ".links-ui",
  locator: ".player-locator",
  pause: ".pause-ui",
  minigameExit: ".minigame-exit",
  restore: ".ui-restore",
}

export class HUD {
  #root = document.getElementById("hud")!
  #help = document.querySelector<HTMLElement>('[data-hud="help"]')!
  #helpBody = document.createElement("div")
  /** Wraps helpBody so the fold-out panel can float above the pinned handle. */
  #helpBodyWrap = document.createElement("div")
  #helpToggle = document.createElement("button")
  #center = document.querySelector<HTMLElement>('[data-hud="center"]')!
  #history = document.createElement("div")
  #minigameExit = document.createElement("button")
  #msgTimer = 0
  #current: PlayerMode = "walk"
  #device: "kb" | "pad" = "kb"
  #toolVerb = "hold 1s to throw" // what a click does right now (the toolbar's tool)
  #historyCanBack = false
  #historyCanForward = false
  /** Controls info panel starts open; user can collapse it. */
  #helpCollapsed = false

  onHistoryBack: () => void = () => {}
  onHistoryForward: () => void = () => {}
  onMinigameExit: () => void = () => {}

  constructor() {
    this.#helpBody.className = "help-body"
    this.#helpBodyWrap.className = "help-body-wrap"
    this.#helpBodyWrap.appendChild(this.#helpBody)
    this.#helpToggle.type = "button"
    this.#helpToggle.className = "help-toggle"
    this.#helpToggle.addEventListener("click", (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.#helpCollapsed = !this.#helpCollapsed
      this.#syncHelpCollapse()
    })
    // Body-wrap first, handle last: in the bottom-anchored, right-aligned
    // br-stack the handle stays pinned to the bottom-right while the panel
    // folds out ABOVE it — so clicking the handle never makes it jump.
    this.#help.replaceChildren(this.#helpBodyWrap, this.#helpToggle)
    this.#syncHelpCollapse()
    // Defaults match boot (walk / kb / ball), so setMode/setDevice/setToolVerb
    // all early-return — paint the rows once here or the panel stays empty.
    this.#renderHelp()

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

    this.#minigameExit.type = "button"
    this.#minigameExit.className = "minigame-exit"
    this.#minigameExit.hidden = true
    this.#minigameExit.addEventListener("click", (event) => {
      event.preventDefault()
      event.stopPropagation()
      this.onMinigameExit()
    })
    this.#root.querySelector<HTMLElement>(".br-stack")?.appendChild(this.#minigameExit)
  }

  #syncHelpCollapse() {
    this.#help.classList.toggle("collapsed", this.#helpCollapsed)
    this.#helpToggle.setAttribute("aria-expanded", this.#helpCollapsed ? "false" : "true")
    this.#helpToggle.title = this.#helpCollapsed ? "Show controls" : "Hide controls"
    this.#helpToggle.setAttribute("aria-label", this.#helpToggle.title)
    this.#helpToggle.innerHTML =
      `<span class="help-toggle-label">Controls</span>` +
      `<span class="help-toggle-chevron" aria-hidden="true">${this.#helpCollapsed ? "▴" : "▾"}</span>`
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
    // Surf already has a compact, always-visible control strip. Collapse the
    // full global help panel on entry so it cannot cover the rider and wave;
    // the pinned Controls handle remains available for anyone who wants it.
    if (mode === "surf" && !this.#helpCollapsed) {
      this.#helpCollapsed = true
      this.#syncHelpCollapse()
    }
    this.#renderHelp()
  }

  setTeleportHistory(canBack: boolean, canForward: boolean) {
    if (canBack === this.#historyCanBack && canForward === this.#historyCanForward) return
    this.#historyCanBack = canBack
    this.#historyCanForward = canForward
    this.#renderHistory()
  }

  setMinigameExit(label: string | null) {
    this.#minigameExit.hidden = !label
    if (!label) return
    this.#minigameExit.title = `Exit ${label} and return to where you started`
    this.#minigameExit.setAttribute("aria-label", this.#minigameExit.title)
    this.#minigameExit.innerHTML =
      `<span class="minigame-exit-icon" aria-hidden="true">↩</span>` +
      `<span class="minigame-exit-copy"><b>Exit ${label}</b><small>Return to start</small></span>`
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
          { c: ["Esc"], label: "release mouse" },
          { c: ["L"], label: "pointer lock / free cursor" }
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
          { c: ["F"], label: "fullscreen" },
          { c: ["H"], label: "screenshot" }
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

    this.#helpBody.innerHTML = html.join("")
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
