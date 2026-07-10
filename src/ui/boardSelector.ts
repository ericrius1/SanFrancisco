import {
  BOARD_DECK_COLORS,
  BOARD_DECOS,
  BOARD_FINS,
  BOARD_GLOW_COLORS,
  BOARD_HUMS,
  BOARD_PITCHES,
  BOARD_SHAPES,
  randomBoardConfig,
  type BoardConfig
} from "../vehicles/board/config";

/**
 * Hoverboard garage — the board twin of AvatarSelector, docked next to it in
 * the HUD (it reuses the avatar panel's CSS recipes). Emits complete configs;
 * main.ts owns persistence, the mesh rebuild, the net broadcast and the synth
 * re-voice. Sound edits additionally fire onSoundEdit so the customizer can
 * audition the hum without waiting for a ride.
 */
export class BoardSelector {
  #root: HTMLElement;
  #panel: HTMLElement;
  #toggle: HTMLButtonElement;
  #config: BoardConfig;
  #onChange: (config: BoardConfig) => void;
  #onSoundEdit: () => void;
  #onOpen: () => void;
  #open = false;

  constructor(initial: BoardConfig, onChange: (config: BoardConfig) => void, onSoundEdit: () => void, onOpen: () => void) {
    this.#config = { ...initial };
    this.#onChange = onChange;
    this.#onSoundEdit = onSoundEdit;
    this.#onOpen = onOpen;

    const hud = document.getElementById("hud")!;
    this.#root = document.createElement("div");
    // shares the avatar-ui recipe (position/fade rules); board-ui shifts it left
    this.#root.className = "avatar-ui board-ui";

    this.#toggle = document.createElement("button");
    this.#toggle.className = "avatar-toggle board-toggle";
    this.#toggle.type = "button";
    this.#toggle.title = "Hoverboard garage";
    this.#toggle.addEventListener("click", () => this.setOpen(!this.#open));
    this.#root.appendChild(this.#toggle);

    this.#panel = document.createElement("div");
    this.#panel.className = "avatar-panel board-panel";
    this.#root.appendChild(this.#panel);

    hud.appendChild(this.#root);
    this.#render();
  }

  setOpen(open: boolean) {
    this.#open = open;
    this.#root.classList.toggle("open", open);
    if (open) this.#onOpen();
  }

  /** Reflect an externally-assigned board (server per-id seed) without firing onChange. */
  setConfig(config: BoardConfig) {
    this.#config = { ...config };
    this.#render();
  }

  #set(next: Partial<BoardConfig>, sound = false) {
    this.#config = { ...this.#config, ...next };
    this.#render();
    this.#onChange({ ...this.#config });
    if (sound) this.#onSoundEdit();
  }

  #button<K extends "shape" | "fin" | "deco" | "hum">(key: K, id: BoardConfig[K], label: string, sound = false) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-choice";
    b.textContent = label;
    b.classList.toggle("on", this.#config[key] === id);
    b.addEventListener("click", () => this.#set({ [key]: id } as Partial<BoardConfig>, sound));
    return b;
  }

  #swatch(key: "deck" | "trim" | "glow", index: number, color: number, label: string) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "avatar-swatch";
    b.title = label;
    const hex = `#${color.toString(16).padStart(6, "0")}`;
    b.style.background = hex;
    if (key === "glow") b.style.boxShadow = `0 0 8px ${hex}, inset 0 -4px 0 rgba(0, 0, 0, 0.14)`;
    b.classList.toggle("on", this.#config[key] === index);
    b.addEventListener("click", () => this.#set({ [key]: index } as Partial<BoardConfig>));
    return b;
  }

  #row(label: string, children: HTMLElement[]) {
    const row = document.createElement("div");
    row.className = "avatar-row";
    const name = document.createElement("div");
    name.className = "avatar-label";
    name.textContent = label;
    const controls = document.createElement("div");
    controls.className = "avatar-controls";
    for (const child of children) controls.appendChild(child);
    row.append(name, controls);
    return row;
  }

  #render() {
    const deck = BOARD_DECK_COLORS[this.#config.deck].color;
    const glow = BOARD_GLOW_COLORS[this.#config.glow].color;
    const deckHex = `#${deck.toString(16).padStart(6, "0")}`;
    const glowHex = `#${glow.toString(16).padStart(6, "0")}`;
    // toggle icon: a tilted mini board — deck bar over its glow rail
    this.#toggle.innerHTML =
      `<span class="board-ic-deck" style="background:${deckHex}"></span>` +
      `<span class="board-ic-rail" style="background:${glowHex};box-shadow:0 0 7px ${glowHex}"></span>`;

    this.#panel.innerHTML = "";
    this.#panel.append(
      this.#row(
        "shape",
        BOARD_SHAPES.map((s) => this.#button("shape", s.id, s.label))
      ),
      this.#row(
        "deck",
        BOARD_DECK_COLORS.map((c, i) => this.#swatch("deck", i, c.color, c.label))
      ),
      this.#row(
        "trim",
        BOARD_DECK_COLORS.map((c, i) => this.#swatch("trim", i, c.color, c.label))
      ),
      this.#row(
        "glow",
        BOARD_GLOW_COLORS.map((c, i) => this.#swatch("glow", i, c.color, c.label))
      ),
      this.#row(
        "fins",
        BOARD_FINS.map((f) => this.#button("fin", f.id, f.label))
      ),
      this.#row(
        "deck art",
        BOARD_DECOS.map((d) => this.#button("deco", d.id, d.label))
      ),
      this.#row(
        "hum",
        BOARD_HUMS.map((h) => this.#button("hum", h.id, h.label, true))
      ),
      this.#row(
        "note",
        BOARD_PITCHES.map((p, i) => {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "avatar-choice";
          b.textContent = `♪ ${p.label}`;
          b.classList.toggle("on", this.#config.pitch === i);
          b.addEventListener("click", () => this.#set({ pitch: i }, true));
          return b;
        })
      )
    );

    const random = document.createElement("button");
    random.type = "button";
    random.className = "avatar-random";
    random.textContent = "random";
    random.addEventListener("click", () => this.#set(randomBoardConfig(), true));
    this.#panel.appendChild(random);
  }
}
