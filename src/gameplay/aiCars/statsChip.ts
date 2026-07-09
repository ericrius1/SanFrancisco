/**
 * Tiny bottom-left HUD readout for the continual-learning AI cars:
 *   🧠 32 cars · skill 497 ↗ · 1,204 km · eldest 2d 7h
 * Fleet-median skill (reward/MINUTE, EMA), a trend arrow vs 10 min ago (hidden
 * until 10 min of data exist), total odometer, and the eldest car's age.
 * Updated ~1 Hz by index.ts. Lives inside #hud so it fades with the Tab
 * HUD-fade. Hidden until the first real stats arrive.
 */
export type LifeStats = {
  /** Number of live cars in the fleet. */
  count: number;
  /** Fleet-median rolling skill (reward per minute). */
  medianSkill: number;
  /** Total distance driven by the whole fleet, in kilometres. */
  totalKm: number;
  /** Eldest car's lifetime, in seconds. */
  eldestAgeS: number;
  /** Median-skill trend vs ~10 min ago: 1 up, -1 down, 0 flat, null = not ready. */
  trend: number | null;
};

/** Compact "2d 7h" / "5h 12m" / "43m" / "18s" age string. */
function fmtAge(s: number): string {
  const sec = Math.max(0, Math.floor(s));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${sec}s`;
}

/** Thousands-separated integer (e.g. 1204 → "1,204"). */
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

const ARROW: Record<string, string> = { "1": " ↗", "-1": " ↘", "0": " →" };

export class StatsChip {
  #el: HTMLDivElement;
  #shown = false;

  constructor() {
    // fade rule for the Tab HUD-fade, injected once
    const STYLE_ID = "ai-cars-chip-style";
    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent =
        ".ai-cars-chip{transition:opacity 0.35s ease}" +
        "#hud.faded .ai-cars-chip{opacity:0;transition:opacity 1s ease}";
      document.head.appendChild(style);
    }
    const el = document.createElement("div");
    el.className = "ai-cars-chip";
    // on-theme glass chip; tabular-nums so the live counters don't jitter width
    el.style.cssText =
      "position:fixed;left:12px;bottom:12px;z-index:var(--z-panel);pointer-events:none;" +
      "font:600 12px/1.35 var(--font);font-variant-numeric:tabular-nums;color:var(--text-soft);" +
      "background:var(--surface);border:1px solid var(--hairline-2);" +
      "border-radius:var(--r-md);padding:5px 10px;letter-spacing:0.2px;" +
      "box-shadow:var(--shadow-sm),var(--edge-hi);backdrop-filter:blur(var(--blur));" +
      "text-shadow:0 1px 2px rgba(0,0,0,0.6);display:none;";
    // parent to #hud so Tab-fade applies; fall back to body if hud missing
    (document.getElementById("hud") ?? document.body).appendChild(el);
    this.#el = el;
  }

  set(s: LifeStats): void {
    if (!this.#shown) {
      this.#el.style.display = "";
      this.#shown = true;
    }
    const arrow = s.trend === null ? "" : ARROW[String(s.trend)] ?? "";
    this.#el.textContent =
      `\u{1F9E0} ${s.count} cars · skill ${Math.round(s.medianSkill)}${arrow}` +
      ` · ${fmtInt(s.totalKm)} km · eldest ${fmtAge(s.eldestAgeS)}`;
    // tooltip explains the units + the trend baseline
    this.#el.title =
      "skill = fleet-median reward per minute (rolling EMA)" +
      (s.trend === null ? "; trend appears after 10 min" : "; arrow = trend vs 10 min ago");
  }

  hide(): void {
    if (this.#shown) {
      this.#el.style.display = "none";
      this.#shown = false;
    }
  }

  dispose(): void {
    this.#el.remove();
  }
}
