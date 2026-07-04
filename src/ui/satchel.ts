/**
 * The satchel: a little scoreboard pinned to the right edge counting what
 * you've looted and hunted — coins and gems from chests, crabs and
 * butterflies caught around town. Rows appear once the first of their kind
 * lands, and pop when the count ticks. Pure DOM inside #hud .br-stack (above
 * the help panel; pointer-events stay off — nothing here is clickable).
 */

export type SatchelKind = "coin" | "gem" | "crab" | "butterfly";

const META: Record<SatchelKind, { icon: string; label: string }> = {
  coin: { icon: "🪙", label: "coins" },
  gem: { icon: "💎", label: "gems" },
  crab: { icon: "🦀", label: "crabs" },
  butterfly: { icon: "🦋", label: "butterflies" }
};

const ORDER: SatchelKind[] = ["coin", "gem", "crab", "butterfly"];

export class Satchel {
  counts: Record<SatchelKind, number> = { coin: 0, gem: 0, crab: 0, butterfly: 0 };

  #root: HTMLElement;
  #rows = new Map<SatchelKind, { row: HTMLElement; num: HTMLElement }>();

  constructor() {
    this.#root = document.createElement("div");
    this.#root.className = "satchel";
    document.querySelector("#hud .br-stack")!.prepend(this.#root);
  }

  add(kind: SatchelKind, n = 1) {
    this.counts[kind] += n;
    let entry = this.#rows.get(kind);
    if (!entry) {
      const row = document.createElement("div");
      row.className = "srow";
      const ic = document.createElement("span");
      ic.className = "sic";
      ic.textContent = META[kind].icon;
      const num = document.createElement("span");
      num.className = "snum";
      row.title = META[kind].label;
      row.append(ic, num);
      entry = { row, num };
      this.#rows.set(kind, entry);
      // keep a stable order no matter what was found first
      const after = ORDER.slice(0, ORDER.indexOf(kind))
        .reverse()
        .map((k) => this.#rows.get(k)?.row)
        .find(Boolean);
      if (after) after.insertAdjacentElement("afterend", entry.row);
      else this.#root.prepend(entry.row);
    }
    entry.num.textContent = String(this.counts[kind]);
    // restart the pop animation
    entry.row.classList.remove("pop");
    void entry.row.offsetWidth;
    entry.row.classList.add("pop");
  }
}
