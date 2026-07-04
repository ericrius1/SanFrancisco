import { PAINT_COLORS, RAINBOW_INDEX } from "../fx/graffiti";

export type ToolName = "spray" | "bubbles" | "chimes" | "rope" | "grab";
export const TOOL_ORDER: ToolName[] = ["spray", "bubbles", "chimes", "rope", "grab"];

/** What the HUD's Click row should say per tool. */
export const TOOL_VERB: Record<ToolName, string> = {
  spray: "sling paintballs",
  bubbles: "blow bubbles",
  chimes: "ring the city",
  rope: "tie two things together",
  grab: "hold — grab · release — throw"
};

const TOOL_META: Record<ToolName, { icon: string; label: string }> = {
  spray: { icon: "🎨", label: "paint" },
  bubbles: { icon: "🫧", label: "bubbles" },
  chimes: { icon: "🎐", label: "chimes" },
  rope: { icon: "🪢", label: "rope" },
  grab: { icon: "🧲", label: "grab" }
};

/**
 * The click-tool switcher: tool chips bottom-centre, plus the paint palette
 * when the spray can is out. Arrow keys navigate rows and options while the
 * UI is visible. Pure DOM inside #hud (pointer-events: none — toolbar opts in).
 */
type NavDir = "left" | "right" | "up" | "down";

function arrowHint(keys: string[]): HTMLElement {
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.innerHTML = keys.map((k) => `<span class="k">${k}</span>`).join("");
  return hint;
}

export class Toolbar {
  #root: HTMLElement;
  #swatchRow: HTMLElement;
  #toolBtns = new Map<ToolName, HTMLButtonElement>();
  #swatchBtns: HTMLButtonElement[] = [];
  #hud = document.getElementById("hud")!;
  #onTool: (t: ToolName) => void;
  #onColor: (i: number) => void;
  #focusRow: "tools" | "swatches" = "tools";
  #focusToolIx = 0;
  #focusColorIx = 0;
  #currentTool: ToolName = "spray";

  constructor(onTool: (t: ToolName) => void, onColor: (i: number) => void) {
    this.#onTool = onTool;
    this.#onColor = onColor;
    this.#root = document.createElement("div");
    this.#root.className = "toolbar";

    const tools = document.createElement("div");
    tools.className = "tools";
    for (const t of TOOL_ORDER) {
      const b = document.createElement("button");
      b.className = "tool";
      b.innerHTML = `<span class="ic">${TOOL_META[t].icon}</span><span>${TOOL_META[t].label}</span>`;
      b.addEventListener("click", () => {
        this.#focusRow = "tools";
        onTool(t);
      });
      this.#toolBtns.set(t, b);
      tools.appendChild(b);
    }
    tools.appendChild(arrowHint(["←", "→", "↓"]));
    this.#root.appendChild(tools);

    this.#swatchRow = document.createElement("div");
    this.#swatchRow.className = "swatches";
    for (let i = 0; i <= RAINBOW_INDEX; i++) {
      const b = document.createElement("button");
      b.className = "swatch";
      if (i === RAINBOW_INDEX) b.classList.add("rainbow");
      else b.style.background = `#${PAINT_COLORS[i].toString(16).padStart(6, "0")}`;
      b.addEventListener("click", () => {
        this.#focusRow = "swatches";
        onColor(i);
      });
      this.#swatchBtns.push(b);
      this.#swatchRow.appendChild(b);
    }
    this.#swatchRow.appendChild(arrowHint(["←", "→", "↑"]));
    this.#root.appendChild(this.#swatchRow);

    this.#hud.appendChild(this.#root);
  }

  setTool(tool: ToolName) {
    this.#currentTool = tool;
    this.#focusToolIx = TOOL_ORDER.indexOf(tool);
    for (const [t, b] of this.#toolBtns) b.classList.toggle("on", t === tool);
    this.#swatchRow.style.display = tool === "spray" ? "" : "none";
    if (tool !== "spray" && this.#focusRow === "swatches") this.#focusRow = "tools";
    this.#renderFocus();
  }

  setColor(index: number) {
    this.#focusColorIx = index;
    this.#swatchBtns.forEach((b, i) => b.classList.toggle("on", i === index));
    this.#renderFocus();
  }

  /** Arrow-key navigation between toolbar rows and items. Returns true when handled. */
  navigate(dir: NavDir): boolean {
    const swatchesOpen = this.#currentTool === "spray";

    if (dir === "up" || dir === "down") {
      if (!swatchesOpen) return false;
      const next = dir === "up" ? "tools" : "swatches";
      if (next === this.#focusRow) return false;
      this.#focusRow = next;
      this.#renderFocus();
      return true;
    }

    if (this.#focusRow === "tools") {
      const step = dir === "left" ? -1 : 1;
      this.#focusToolIx = (this.#focusToolIx + step + TOOL_ORDER.length) % TOOL_ORDER.length;
      this.#onTool(TOOL_ORDER[this.#focusToolIx]);
      return true;
    }

    const count = this.#swatchBtns.length;
    const step = dir === "left" ? -1 : 1;
    this.#focusColorIx = (this.#focusColorIx + step + count) % count;
    this.#onColor(this.#focusColorIx);
    return true;
  }

  #renderFocus() {
    for (const b of this.#toolBtns.values()) b.classList.remove("kbd");
    for (const b of this.#swatchBtns) b.classList.remove("kbd");
    if (this.#focusRow === "tools") {
      this.#toolBtns.get(TOOL_ORDER[this.#focusToolIx])?.classList.add("kbd");
    } else {
      this.#swatchBtns[this.#focusColorIx]?.classList.add("kbd");
    }
  }
}
