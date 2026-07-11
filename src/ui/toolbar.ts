import { PAINT_COLORS, RAINBOW_INDEX } from "../fx/graffiti";
import { MENU_MODES, MODE_META } from "../player/discovery";
import type { PlayerMode } from "../player/types";

export type ToolName = "ball" | "spray" | "bubbles";
export const TOOL_ORDER: ToolName[] = ["ball", "spray", "bubbles"];

/** What the HUD's Click row should say per tool. */
export const TOOL_VERB: Record<ToolName, string> = {
  ball: "hold to throw",
  spray: "sling paintballs",
  bubbles: "blow bubbles"
};

const TOOL_META: Record<ToolName, { icon: string; label: string }> = {
  ball: { icon: "🎾", label: "ball" },
  spray: { icon: "🎨", label: "paint" },
  bubbles: { icon: "🫧", label: "bubbles" }
};

/**
 * The click-tool switcher: tool chips bottom-centre, plus the paint palette
 * when the spray can is out. The vehicle row above it mirrors the travel-mode
 * cycle. Pure DOM inside #hud (pointer-events: none — toolbar opts in).
 */
function keyHint(keys: string[]): HTMLElement {
  const hint = document.createElement("span");
  hint.className = "hint";
  hint.innerHTML = keys.map((k) => `<span class="k">${k}</span>`).join("");
  return hint;
}

export class Toolbar {
  #root: HTMLElement;
  #swatchRow: HTMLElement;
  #vehicleBtns = new Map<PlayerMode, HTMLButtonElement>();
  #toolBtns = new Map<ToolName, HTMLButtonElement>();
  #swatchBtns: HTMLButtonElement[] = [];
  #hud = document.getElementById("hud")!;
  #onTool: (t: ToolName) => void;
  #onColor: (i: number) => void;
  #focusRow: "tools" | "swatches" = "tools";
  #focusToolIx = 0;
  #focusColorIx = 0;

  constructor(onTool: (t: ToolName) => void, onColor: (i: number) => void, onVehicle: (m: PlayerMode) => void) {
    this.#onTool = onTool;
    this.#onColor = onColor;
    this.#root = document.createElement("div");
    this.#root.className = "toolbar";

    const vehicles = document.createElement("div");
    vehicles.className = "vehicles";
    for (const [i, mode] of MENU_MODES.entries()) {
      const meta = MODE_META[mode];
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool vehicle";
      b.title = `${meta.label} (${i + 1})`;
      b.setAttribute("aria-label", meta.label);
      b.innerHTML = `<span class="ic">${meta.icon}</span><span>${meta.label}</span><span class="num">${i + 1}</span>`;
      b.addEventListener("click", () => onVehicle(mode));
      this.#vehicleBtns.set(mode, b);
      vehicles.appendChild(b);
    }
    vehicles.appendChild(keyHint(["←", "→"]));
    this.#root.appendChild(vehicles);

    const tools = document.createElement("div");
    tools.className = "tools";
    for (const [i, t] of TOOL_ORDER.entries()) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool";
      b.title = `${TOOL_META[t].label} (Ctrl+${i + 1})`;
      b.innerHTML = `<span class="ic">${TOOL_META[t].icon}</span><span>${TOOL_META[t].label}</span><span class="num"><span class="mod">⌃</span>${i + 1}</span>`;
      b.addEventListener("click", () => {
        this.#focusRow = "tools";
        this.#onTool(t);
      });
      this.#toolBtns.set(t, b);
      tools.appendChild(b);
    }
    this.#root.appendChild(tools);

    this.#swatchRow = document.createElement("div");
    this.#swatchRow.className = "swatches";
    for (let i = 0; i <= RAINBOW_INDEX; i++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "swatch";
      if (i === RAINBOW_INDEX) b.classList.add("rainbow");
      else b.style.background = `#${PAINT_COLORS[i].toString(16).padStart(6, "0")}`;
      b.addEventListener("click", () => {
        this.#focusRow = "swatches";
        this.#onColor(i);
      });
      this.#swatchBtns.push(b);
      this.#swatchRow.appendChild(b);
    }
    this.#root.appendChild(this.#swatchRow);

    this.#hud.appendChild(this.#root);
  }

  setVehicle(mode: PlayerMode) {
    for (const [m, b] of this.#vehicleBtns) b.classList.toggle("on", m === mode);
  }

  setTool(tool: ToolName) {
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
