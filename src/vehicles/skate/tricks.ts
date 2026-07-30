/**
 * Combo bookkeeping, Pro-Skater style.
 *
 * Tricks accumulate into a PENDING chain worth `pending × multiplier`, where
 * the multiplier is simply how many links the chain has. The chain only banks
 * when you roll away clean; grinds and manuals hold it open between tricks, and
 * eating it drops the whole thing. That single rule is what turns "do a flip"
 * into "link the whole plaza together", so the controller never banks early.
 *
 * Everything here is plain numbers and pooled strings — the HUD reads it every
 * rendered frame and must not allocate.
 */

export type ComboLink = {
  name: string;
  /** Points this link is worth, already including any repeats. */
  points: number;
  /** Repeats of the same trick back to back ("Kickflip ×3"). */
  count: number;
};

/** Base values. Grinds/manuals/grabs also earn per second while held. */
export const TRICK_POINTS = {
  kickflip: 100,
  heelflip: 100,
  shoveIt: 100,
  shoveIt360: 220,
  varial: 260,
  impossible: 320,
  flip: 420, // one full front/back flip
  spin180: 100,
  spin360: 300,
  spin540: 620,
  spin720: 1100,
  spin900: 1800,
  grind5050: 100,
  grindBoardslide: 160,
  grindNose: 200,
  grind50: 200,
  grindCoping: 240,
  grindPerSecond: 45,
  manual: 60,
  manualPerSecond: 30,
  grab: 60,
  grabPerSecond: 26,
  bigAir: 250
} as const;

const BEST_KEY = "sf-skate-best";

function loadBest(): number {
  try {
    const raw = localStorage.getItem(BEST_KEY);
    const v = raw ? Number.parseInt(raw, 10) : 0;
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function saveBest(v: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(Math.round(v)));
  } catch {
    /* private mode — the run still scores, it just isn't remembered */
  }
}

/** Name for a spin, given total degrees turned in the air. */
export function spinName(deg: number): { name: string; points: number } | null {
  const a = Math.abs(deg);
  if (a >= 880) return { name: "900", points: TRICK_POINTS.spin900 };
  if (a >= 700) return { name: "720", points: TRICK_POINTS.spin720 };
  if (a >= 520) return { name: "540", points: TRICK_POINTS.spin540 };
  if (a >= 340) return { name: "360", points: TRICK_POINTS.spin360 };
  if (a >= 165) return { name: "180", points: TRICK_POINTS.spin180 };
  return null;
}

export class TrickBook {
  score = 0;
  best = loadBest();
  /** Open chain, oldest link first. */
  combo: ComboLink[] = [];
  /** Raw points in the open chain, before the multiplier. */
  pending = 0;
  /** Seconds since the chain last gained anything (HUD urgency + timeout). */
  idle = 0;

  /** Landed/bailed banner the HUD flashes. `life` counts down to 0. */
  banner = { text: "", points: 0, bailed: false, life: 0 };

  #pool: ComboLink[] = [];

  get multiplier(): number {
    return this.combo.length;
  }

  get pendingTotal(): number {
    return Math.round(this.pending * Math.max(1, this.combo.length));
  }

  get active(): boolean {
    return this.combo.length > 0;
  }

  /** Add a completed trick. Repeats of the last link stack instead of piling up. */
  add(name: string, points: number): void {
    this.idle = 0;
    const last = this.combo[this.combo.length - 1];
    if (last && last.name === name) {
      last.count++;
      // Repeats are worth less each time — the game wants variety, not one
      // kickflip pressed forty times.
      const step = points * Math.pow(0.62, last.count - 1);
      last.points += step;
      this.pending += step;
      return;
    }
    const link = this.#pool.pop() ?? { name: "", points: 0, count: 1 };
    link.name = name;
    link.points = points;
    link.count = 1;
    this.combo.push(link);
    this.pending += points;
  }

  /** Points earned continuously while a grind/manual/grab is held. */
  hold(points: number): void {
    if (this.combo.length === 0) return;
    this.pending += points;
    this.idle = 0;
  }

  /** Roll away clean: bank `pending × multiplier`. Returns what was banked. */
  land(): number {
    if (this.combo.length === 0) return 0;
    const total = this.pendingTotal;
    const mult = this.combo.length;
    this.score += total;
    if (this.score > this.best) {
      this.best = this.score;
      saveBest(this.best);
    }
    this.banner.text = this.#chainText();
    this.banner.points = total;
    this.banner.bailed = false;
    this.banner.life = mult >= 4 ? 3.4 : 2.2;
    this.#clear();
    return total;
  }

  /** Ate it: the chain is gone. */
  bail(): void {
    if (this.combo.length === 0) return;
    this.banner.text = this.#chainText();
    this.banner.points = 0;
    this.banner.bailed = true;
    this.banner.life = 2.4;
    this.#clear();
  }

  update(dt: number): void {
    if (this.combo.length > 0) this.idle += dt;
    if (this.banner.life > 0) this.banner.life = Math.max(0, this.banner.life - dt);
  }

  /** Wipe everything (mode switch, teleport). Keeps the session best. */
  reset(): void {
    this.#clear();
    this.banner.life = 0;
    this.score = 0;
  }

  #chainText(): string {
    let out = "";
    for (const link of this.combo) {
      if (out) out += " + ";
      out += link.count > 1 ? `${link.name} ×${link.count}` : link.name;
    }
    return out;
  }

  #clear(): void {
    for (const link of this.combo) this.#pool.push(link);
    this.combo.length = 0;
    this.pending = 0;
    this.idle = 0;
  }
}
