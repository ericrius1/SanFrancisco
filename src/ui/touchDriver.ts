import type { InputDriver, ScriptedControls } from "../core/input";

/**
 * The DOM-free half of the touch controls (src/ui/touchControls.ts): gathers
 * stick, look and button state between frames and writes it to Input's driver
 * channel once per frame. Kept apart so it can be exercised without a page.
 */

/** Stick travel, in CSS px, for full deflection. */
export const STICK_RADIUS = 56;
/** Ignore thumb wobble inside this fraction of the travel. */
const STICK_DEADZONE = 0.12;
/**
 * Look drag → mouse-pixel equivalents. The chase camera turns 0.0032 rad per
 * mouse pixel; a finger covers far fewer pixels than a mouse swipe, so a
 * half-screen drag should be roughly a half turn.
 */
const LOOK_SCALE = 1.6;

/** Collects touch state from DOM handlers; writes it to Input once per frame. */
export class TouchDriver implements InputDriver {
  moveX = 0;
  moveY = 0;
  #lookDX = 0;
  #lookDY = 0;
  #scrubHeld = false;
  #scrubHours = 0;
  /** Refresh the small HUD readout from the same frame cadence as input. */
  onUpdate: () => void = () => {};
  /** Codes whose button is currently under a finger. */
  #held = new Set<string>();
  /** Codes pressed since the last update — kept so a tap shorter than a frame still lands. */
  #pressed = new Set<string>();
  /** Codes this driver currently holds on the Input channel. */
  #applied = new Set<string>();
  #fireHeld = false;
  #fireEdge = false;

  press(code: string): void {
    if (code === "fire") {
      this.#fireHeld = true;
      this.#fireEdge = true;
      return;
    }
    this.#held.add(code);
    this.#pressed.add(code);
  }

  release(code: string): void {
    if (code === "fire") this.#fireHeld = false;
    else this.#held.delete(code);
  }

  look(dx: number, dy: number): void {
    this.#lookDX += dx * LOOK_SCALE;
    this.#lookDY += dy * LOOK_SCALE;
  }

  scrubTime(held: boolean, hours = 0): void {
    this.#scrubHeld = held;
    this.#scrubHours += hours;
  }

  releaseAll(): void {
    this.#held.clear();
    this.#fireHeld = false;
    this.#fireEdge = false;
    this.#pressed.clear();
    this.#lookDX = this.#lookDY = 0;
    this.#scrubHeld = false;
    this.#scrubHours = 0;
    this.moveX = 0;
    this.moveY = 0;
  }

  update(_dt: number, c: ScriptedControls): void {
    this.onUpdate();
    c.scrubTime(this.#scrubHeld, this.#scrubHours);
    this.#scrubHours = 0;
    c.axis("KeyA|KeyD", this.moveX);
    c.axis("KeyS|KeyW", this.moveY);
    // hold() raises the pressed() edge only for a code not already held, so a
    // re-press between frames releases first. A code lifted within the same
    // frame is released again below, but its edge still reaches this frame.
    for (const code of this.#pressed) {
      if (this.#applied.has(code)) c.release(code);
      c.hold(code);
    }
    for (const code of this.#held) {
      if (!this.#applied.has(code) && !this.#pressed.has(code)) c.hold(code);
    }
    for (const code of new Set([...this.#applied, ...this.#pressed])) {
      if (!this.#held.has(code)) c.release(code);
    }
    this.#applied = new Set(this.#held);
    this.#pressed.clear();
    if (this.#lookDX !== 0 || this.#lookDY !== 0) {
      c.look(this.#lookDX, this.#lookDY);
      this.#lookDX = 0;
      this.#lookDY = 0;
    }
    c.fire(this.#fireHeld, this.#fireEdge);
    this.#fireEdge = false;
  }
}

/** Map a thumb offset (px from the stick origin) to a −1..1 stick with deadzone. */
export function stickFromOffset(dx: number, dy: number): { x: number; y: number } {
  const mag = Math.hypot(dx, dy) / STICK_RADIUS;
  if (mag < STICK_DEADZONE) return { x: 0, y: 0 };
  const clamped = Math.min(1, mag);
  const remapped = (clamped - STICK_DEADZONE) / (1 - STICK_DEADZONE);
  const scale = remapped / (mag * STICK_RADIUS);
  // Screen y grows downward; stick up is forward (+KeyW).
  return { x: dx * scale, y: -dy * scale };
}
