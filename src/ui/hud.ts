import type { PlayerMode } from "../player/types"
import { MENU_MODES } from "../player/discovery"
const MODE_SHORT: Record<PlayerMode, string> = {
  walk: "walk",
  drive: "drive",
  plane: "plane",
  boat: "boat",
  speedboat: "speedboat",
  drone: "drone",
  board: "board",
  bird: "bird",
  truck: "truck"
}

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
  ],
  truck: [
    { c: ["Mouse"], label: "look" },
    { c: ["W", "S"], label: "gas · brake" },
    { c: ["A", "D"], label: "steer" },
    { c: ["Shift"], label: "boost" },
    { c: ["Click"], label: "LAUNCH! 🎆🎸" },
    { c: ["E"], label: "get out" }
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
  ],
  truck: [
    { c: ["RS"], label: "look" },
    { c: ["RT", "LT"], label: "gas · brake" },
    { c: ["LS"], label: "steer" },
    { c: ["RB"], label: "boost" },
    { c: ["X"], label: "launch" },
    { c: ["B"], label: "get out" }
  ]
}

// one-liner flavor tip under the controls
const TIPS: Partial<Record<PlayerMode, string>> = {
  walk: "Walk into any building face to climb it",
  drive: "Ram buildings to topple them",
  board: "White glow = nose · surfs streets, hills and the bay",
  bird: "Look down + Shift to stoop — skim the bay for spray",
  truck: "Click to launch the rocket battery — a red/white/blue firework barrage"
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
  #msgTimer = 0
  #current: PlayerMode = "walk"
  #device: "kb" | "pad" = "kb"
  #toolVerb = "sling paintballs" // what a click does right now (the toolbar's tool)
  #expanded = false // advanced shortcuts folded away by default
  #isKnown = (_m: PlayerMode) => true

  constructor() {
    // one delegated listener: the fold-out toggle lives inside #help
    this.#help.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest(".more")) {
        this.#expanded = !this.#expanded
        this.#renderHelp()
      }
    })
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

  /** Which roster slots show their name vs ??? */
  setDiscovery(isKnown: (m: PlayerMode) => boolean) {
    this.#isKnown = isKnown
    this.#renderHelp()
  }

  /** Swap the help labels to whichever device was touched last. */
  setDevice(device: "kb" | "pad") {
    if (device === this.#device) return
    this.#device = device
    this.#renderHelp()
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

    // second column: the vehicle roster, always visible so newcomers see there's
    // more than walking. Keyboard picks a mode by number; the pad cycles ◀ ▶.
    const vehicleRows = MENU_MODES.map((m, i) => {
      const known = this.#isKnown(m)
      const key = pad ? "" : `<span class="k">${i + 1}</span>`
      const label = known ? MODE_SHORT[m] : "???"
      return `<div class="mi${m === this.#current ? " on" : ""}${known ? "" : " mystery"}">${key}<span class="lbl">${label}</span></div>`
    }).join("")
    const modes =
      `<div class="modes">` +
      `<div class="modes-h">vehicles${pad ? " · ◀ ▶" : ""}</div>` +
      `<div class="modes-list">${vehicleRows}</div>` +
      `</div>`

    html.push(`<div class="cols"><div class="grid">${rows}</div>${modes}</div>`)

    const tip = TIPS[this.#current]
    if (tip) html.push(`<div class="tip">${tip}</div>`)

    // fold-out toggle: basic movement stays, the big shortcut list hides behind it
    html.push(
      `<button class="more" type="button">` +
        `<span class="chev">${this.#expanded ? "▾" : "▸"}</span>` +
        `<span>${this.#expanded ? "less" : "more"}</span>` +
        `</button>`
    )

    // global shortcuts flow into a wrapped footer so the panel stays compact
    const fi = (keys: string[], label: string, on = false) =>
      `<span class="fi${on ? " on" : ""}">${chips(keys, pad)}<span class="lbl">${label}</span></span>`
    const foot = pad
      ? [
          fi(["◀", "▶"], "switch mode"),
          fi(["Y"], "respawn"),
          fi(["R3"], "camera"),
          fi(["▲"], "fireworks"),
          fi(["▼"], "zero-g"),
          fi(["Start"], "pause"),
          fi(["Back"], "immersive")
        ]
      : [
          fi(["R"], "respawn"),
          fi(["B"], "fireworks"),
          fi(["Z"], "hold — time of day"),
          fi(["G"], "zero-g"),
          fi(["P"], "pause"),
          fi(["C"], "camera"),
          fi(["/"], "debug"),
          fi(["I"], "immersive"),
          fi(["F"], "fullscreen")
        ]
    if (this.#expanded) html.push(`<div class="foot">${foot.join("")}</div>`)

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
    this.#msgTimer = seconds
  }

  update(dt: number) {
    if (this.#msgTimer > 0) {
      this.#msgTimer -= dt
      if (this.#msgTimer <= 0) this.#center.textContent = ""
    }
  }
}
