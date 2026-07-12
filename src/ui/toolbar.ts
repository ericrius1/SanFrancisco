import { PAINT_COLORS, RAINBOW_INDEX } from "../fx/graffiti";
import { MENU_MODES, MODE_META } from "../player/discovery";
import type { PlayerMode } from "../player/types";

export type ToolName = "ball" | "spray" | "bubbles";
export const TOOL_ORDER: ToolName[] = ["ball", "spray", "bubbles"];

/** What the HUD's Click row should say per tool. */
export const TOOL_VERB: Record<ToolName, string> = {
  ball: "hold 1s to throw",
  spray: "sling paintballs",
  bubbles: "blow bubbles"
};

const TOOL_META: Record<ToolName, { icon: string; label: string }> = {
  ball: { icon: "🎾", label: "ball" },
  spray: { icon: "🎨", label: "paint" },
  bubbles: { icon: "🫧", label: "bubbles" }
};

type FocusRow = "vehicles" | "tools" | "swatches";

/**
 * The click-tool switcher: tool chips bottom-centre, plus the paint palette
 * when the spray can is out. The vehicle row above it mirrors the travel-mode
 * cycle. Pure DOM inside #hud (pointer-events: none — toolbar opts in).
 *
 * Arrow keys: ↑/↓ move the keyboard focus between rows; ←/→ cycle the focused
 * row (and apply the selection). Number keys still jump vehicles; Ctrl+number
 * still jumps tools as a shortcut.
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
  #onVehicle: (m: PlayerMode) => void;
  #focusRow: FocusRow = "vehicles";
  #focusVehicleIx = 0;
  #focusToolIx = 0;
  #focusColorIx = 0;
  #tool: ToolName = "ball";
  #mode: PlayerMode = MENU_MODES[0];

  constructor(onTool: (t: ToolName) => void, onColor: (i: number) => void, onVehicle: (m: PlayerMode) => void) {
    this.#onTool = onTool;
    this.#onColor = onColor;
    this.#onVehicle = onVehicle;
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
      b.addEventListener("click", () => {
        this.#focusRow = "vehicles";
        this.#onVehicle(mode);
      });
      this.#vehicleBtns.set(mode, b);
      vehicles.appendChild(b);
    }
    vehicles.appendChild(keyHint(["↑", "↓", "←", "→"]));
    this.#root.appendChild(vehicles);

    const tools = document.createElement("div");
    tools.className = "tools";
    for (const t of TOOL_ORDER) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "tool";
      b.title = TOOL_META[t].label;
      b.innerHTML = `<span class="ic">${TOOL_META[t].icon}</span><span>${TOOL_META[t].label}</span>`;
      b.addEventListener("click", () => {
        this.#focusRow = "tools";
        this.#onTool(t);
      });
      this.#toolBtns.set(t, b);
      tools.appendChild(b);
    }
    tools.appendChild(keyHint(["←", "→"]));
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
    this.#renderFocus();
  }

  setVehicle(mode: PlayerMode) {
    this.#mode = mode;
    const ix = MENU_MODES.indexOf(mode);
    if (ix >= 0) this.#focusVehicleIx = ix;
    for (const [m, b] of this.#vehicleBtns) b.classList.toggle("on", m === mode);
    this.#renderFocus();
  }

  setTool(tool: ToolName) {
    this.#tool = tool;
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

  /**
   * Arrow-key navigation. `dx` cycles the focused row; `dy` moves between rows
   * (negative = up toward vehicles). Same-frame vertical wins over horizontal.
   */
  navigate(dx: number, dy: number) {
    if (dy) {
      const rows = this.#rows();
      const i = rows.indexOf(this.#focusRow);
      const from = i >= 0 ? i : 0;
      this.#focusRow = rows[(from + (dy > 0 ? 1 : -1) + rows.length) % rows.length];
      this.#renderFocus();
      return;
    }
    if (!dx) return;
    const step = dx > 0 ? 1 : -1;
    if (this.#focusRow === "vehicles") {
      const n = MENU_MODES.length;
      if (!n) return;
      const from = MENU_MODES.indexOf(this.#mode);
      const ix = ((from >= 0 ? from : 0) + step + n) % n;
      this.#focusVehicleIx = ix;
      this.#onVehicle(MENU_MODES[ix]);
      return;
    }
    if (this.#focusRow === "tools") {
      const n = TOOL_ORDER.length;
      const ix = (this.#focusToolIx + step + n) % n;
      this.#focusToolIx = ix;
      this.#onTool(TOOL_ORDER[ix]);
      return;
    }
    const n = this.#swatchBtns.length;
    if (!n) return;
    const ix = (this.#focusColorIx + step + n) % n;
    this.#focusColorIx = ix;
    this.#onColor(ix);
  }

  /** Mark the tools row as keyboard-focused (e.g. after Ctrl+number). */
  focusTools() {
    this.#focusRow = "tools";
    this.#renderFocus();
  }

  /** Mark the vehicles row as keyboard-focused (e.g. after a digit mode switch). */
  focusVehicles() {
    this.#focusRow = "vehicles";
    this.#renderFocus();
  }

  #rows(): FocusRow[] {
    return this.#tool === "spray" ? ["vehicles", "tools", "swatches"] : ["vehicles", "tools"];
  }

  #renderFocus() {
    for (const b of this.#vehicleBtns.values()) b.classList.remove("kbd");
    for (const b of this.#toolBtns.values()) b.classList.remove("kbd");
    for (const b of this.#swatchBtns) b.classList.remove("kbd");
    if (this.#focusRow === "vehicles") {
      this.#vehicleBtns.get(MENU_MODES[this.#focusVehicleIx])?.classList.add("kbd");
    } else if (this.#focusRow === "tools") {
      this.#toolBtns.get(TOOL_ORDER[this.#focusToolIx])?.classList.add("kbd");
    } else {
      this.#swatchBtns[this.#focusColorIx]?.classList.add("kbd");
    }
  }
}
