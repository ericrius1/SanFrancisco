/**
 * The skatepark tutorial.
 *
 * Pure logic — no DOM, no scene, no timers. It watches the same telemetry the
 * HUD already reads and advances when the player DOES the thing, never when
 * they read about it. Steps unlock in order, each one is proved by a real
 * event on the board, and the whole thing self-destructs once you've linked a
 * combo, because at that point you know more than the tutorial does.
 *
 * It only runs inside the park. Skating the city is not a lesson.
 */

export type SkateCoachSignals = {
  /** Metres from the park centre. */
  distance: number;
  speed: number;
  airborne: boolean;
  airTime: number;
  grinding: boolean;
  manualing: boolean;
  /** Height below the park's deck level — negative inside the bowl. */
  belowDeck: number;
  /** Names in the currently open combo, oldest first. */
  combo: readonly { name: string }[];
  multiplier: number;
};

export type SkateCoachStep = {
  id: string;
  /** What the player is told to do. */
  prompt: string;
  /** Shown once the step is cleared. */
  done: string;
  clear: (s: SkateCoachSignals) => boolean;
};

const FLIP_NAMES = new Set([
  "Kickflip",
  "Heelflip",
  "Varial Kickflip",
  "360 Shove-it",
  "Impossible"
]);

const hasFlip = (s: SkateCoachSignals) => s.combo.some((c) => FLIP_NAMES.has(c.name));

export const SKATE_COACH_STEPS: readonly SkateCoachStep[] = [
  {
    id: "push",
    prompt: "Hold W to push — a few kicks and you're rolling",
    done: "Rolling.",
    clear: (s) => s.speed > 6
  },
  {
    id: "ollie",
    prompt: "Hold Space to crouch, let go to ollie — the longer you hold, the bigger",
    done: "That's an ollie.",
    clear: (s) => s.airTime > 0.35
  },
  {
    id: "flip",
    prompt: "Ollie again and tap Q in the air for a kickflip",
    done: "Kickflip landed.",
    clear: hasFlip
  },
  {
    id: "grind",
    prompt: "Roll at the flat bar and ollie onto it — it locks on by itself",
    done: "Grinding.",
    clear: (s) => s.grinding
  },
  {
    id: "bowl",
    prompt: "Drop into the bowl and carve the wall — speed comes from the transition",
    done: "That's how you pump.",
    clear: (s) => s.belowDeck < -1.4 && s.speed > 5
  },
  {
    id: "manual",
    prompt: "Hold Shift on the ground for a manual — it keeps a combo alive",
    done: "Manual held.",
    clear: (s) => s.manualing
  },
  {
    id: "link",
    prompt: "Now link three in one go: flip → grind → manual, before you touch down",
    done: "You're a skater. Go bomb a hill.",
    clear: (s) => s.multiplier >= 3
  }
];

/** How far from the park centre the coach stays awake. */
const COACH_RANGE = 62;
/** Seconds the "done" line stays up before the next prompt. */
const CHEER_TIME = 2.1;

export class SkateCoach {
  /** Index into SKATE_COACH_STEPS; equal to the length once finished. */
  step = 0;
  /** Seconds left on the current congratulation. */
  cheer = 0;
  #cheerText = "";
  #dismissed = false;
  #everInside = false;

  get finished(): boolean {
    return this.step >= SKATE_COACH_STEPS.length;
  }

  /** Text to show, or "" for nothing. */
  get line(): string {
    if (this.#dismissed) return "";
    if (this.cheer > 0) return this.#cheerText;
    const step = SKATE_COACH_STEPS[this.step];
    return step ? step.prompt : "";
  }

  /** 0..1 through the course, for a progress pip row. */
  get progress(): number {
    return Math.min(1, this.step / SKATE_COACH_STEPS.length);
  }

  get total(): number {
    return SKATE_COACH_STEPS.length;
  }

  /** Player asked it to go away; it stays away for the session. */
  dismiss() {
    this.#dismissed = true;
  }

  /** True while the coach wants HUD space. */
  update(dt: number, s: SkateCoachSignals): boolean {
    if (this.#dismissed) return false;
    const inside = s.distance < COACH_RANGE;
    if (inside) this.#everInside = true;
    // Leaving the park ends the lesson for good — nobody wants to be coached
    // halfway down Lombard.
    if (this.#everInside && !inside) {
      this.#dismissed = true;
      return false;
    }
    if (!inside) return false;

    if (this.cheer > 0) {
      this.cheer = Math.max(0, this.cheer - dt);
      return true;
    }
    const step = SKATE_COACH_STEPS[this.step];
    if (!step) return false;
    if (step.clear(s)) {
      this.#cheerText = step.done;
      this.cheer = CHEER_TIME;
      this.step++;
    }
    return true;
  }
}
