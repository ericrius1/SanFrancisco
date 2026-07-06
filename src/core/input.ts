import type { PlayerMode } from "../player/types";

/**
 * Pointer-lock game input. Clicking the canvas captures the mouse; mouselook
 * deltas accumulate only while locked. Esc releases the pointer (browser-level),
 * and the game keeps simulating unfocused. While `suspended` (camera-orbit mode)
 * all game inputs read as idle so the player coasts.
 *
 * A gamepad (Xbox standard mapping) rides the same logical rails: pollPad()
 * translates buttons into the key codes the game already reads (A→Space,
 * B→E, RB→Shift, …), the left stick into the WASD axis pairs, the right stick
 * into mouselook deltas, and the triggers into the active mode's throttle or
 * twirl — fly routes them to ↑/↓, bird to Q/E —
 * so modes/camera/fireworks never see a second input path. `device` tracks
 * whichever input was touched last; the HUD swaps its control labels off it.
 */

const DEADZONE = 0.16;
// right-stick look speed, mouse-pixel-equivalents per second at full
// deflection (squared response, so half deflection aims at quarter speed)
const LOOK_X = 1150;
const LOOK_Y = 720;

// button index (standard mapping) → key code it impersonates. X (2) is fire,
// handled separately. Dpad ◀/▶ emit synthetic mode-cycle codes main.ts reads.
const PAD_BUTTONS: Record<number, string> = {
  0: "Space", //     A: jump / ollie / drift / air brake / hover
  1: "KeyE", //      B: enter-exit vehicle
  3: "KeyR", //      Y: respawn
  4: "KeyQ", //      LB: drone down
  5: "ShiftLeft", // RB: boost / run
  8: "KeyI", //      Back: hide UI
  9: "KeyP", //      Start: pause
  10: "ShiftLeft", //L3: boost too
  11: "KeyC", //     R3: camera orbit
  12: "KeyB", //     dpad up: fireworks (held)
  13: "KeyG", //     dpad down: zero-g
  14: "PadModePrev", // dpad left/right: cycle travel modes
  15: "PadModeNext"
};

export class Input {
  keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  wheelX = 0;
  firePressed = false;
  fireHeld = false;
  locked = false;
  suspended = false;
  padConnected = false;
  device: "kb" | "pad" = "kb";

  onLockChange: (locked: boolean) => void = () => {};
  onDeviceChange: (device: "kb" | "pad") => void = () => {};

  #justPressed = new Set<string>();
  #shiftedPresses = new Set<string>();
  #ctrlPresses = new Set<string>();
  #altPresses = new Set<string>();
  #el: HTMLElement;

  // gamepad state, rebuilt by pollPad() once per frame
  #padHeld = new Set<string>();
  #padPrev: boolean[] = [];
  #padAxes = new Map<string, number>();
  #padFireHeld = false;
  #triggerRoute: "plane" | "bird" | "drone" | null = null; // plane: ↑/↓ throttle; bird/drone: Q/U vertical or twirl
  #invertLookY = false; // walk + fly/drone/bird + boat: right-stick pitch opposite mouse convention

  constructor(el: HTMLElement) {
    this.#el = el;

    window.addEventListener("keydown", (e) => {
      // typing into a DOM field (e.g. the "/" tuning panel) must not drive the game
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      // Tab toggles the user UI — never let it (or its repeats) move focus
      if (e.code === "Tab") e.preventDefault();
      // Alt+arrow is location history inside the game, not browser history.
      if (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.#justPressed.add(e.code);
      if (e.shiftKey) this.#shiftedPresses.add(e.code);
      if (e.ctrlKey) this.#ctrlPresses.add(e.code);
      if (e.altKey) this.#altPresses.add(e.code);
      this.#setDevice("kb");
      // Slash: keep "/" (debug panel) from triggering Firefox quick-find
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Slash"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.fireHeld = false;
    });

    el.addEventListener("click", () => {
      if (!this.locked && !this.suspended) this.requestLock();
    });

    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === el;
      if (!this.locked) this.fireHeld = false;
      this.onLockChange(this.locked);
    });

    el.addEventListener("mousedown", (e) => {
      if (e.button === 0 && this.locked) {
        this.firePressed = true;
        this.fireHeld = true;
        this.#setDevice("kb");
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("mousemove", (e) => {
      if (this.locked) {
        this.mouseDX += e.movementX;
        this.mouseDY += e.movementY;
      }
    });

    el.addEventListener(
      "wheel",
      (e) => {
        this.wheel += e.deltaY;
        this.wheelX += e.deltaX;
        e.preventDefault();
      },
      { passive: false }
    );
  }

  #setDevice(device: "kb" | "pad") {
    if (this.device === device) return;
    this.device = device;
    this.onDeviceChange(device);
  }

  /** Per-mode pad routing: fly → ↑/↓ throttle, bird → Q/E twirl, drone → Q/U vertical; walk + flying + boat modes invert right-stick pitch. */
  setMode(mode: PlayerMode) {
    this.#triggerRoute =
      mode === "plane" ? "plane" : mode === "bird" ? "bird" : mode === "drone" ? "drone" : null;
    this.#invertLookY =
      mode === "walk" ||
      mode === "plane" ||
      mode === "drone" ||
      mode === "bird" ||
      mode === "boat" ||
      mode === "speedboat";
  }

  /**
   * Read the gamepad once per frame, before any consumer. Buttons feed
   * keys/justPressed under their mapped codes, sticks and triggers feed the
   * axis pairs, the right stick feeds mouselook.
   */
  pollPad(dt: number) {
    const pads = navigator.getGamepads?.() ?? [];
    const gp = pads.find((p) => p?.mapping === "standard") ?? pads.find((p) => p);
    if (!gp) {
      if (this.padConnected) {
        this.padConnected = false;
        this.#padHeld.clear();
        this.#padAxes.clear();
        this.#padPrev.length = 0;
        this.#padFireHeld = false;
      }
      return;
    }
    this.padConnected = true;

    let active = false;
    const held = new Set<string>();
    for (let i = 0; i < gp.buttons.length; i++) {
      const on = gp.buttons[i].pressed || gp.buttons[i].value > 0.5;
      if (on) active = true;
      const code = PAD_BUTTONS[i];
      if (code) {
        if (on) {
          held.add(code);
          if (!this.#padPrev[i]) this.#justPressed.add(code);
        }
      } else if (i === 2) {
        if (on && !this.#padPrev[i]) this.firePressed = true;
        this.#padFireHeld = on;
      }
      this.#padPrev[i] = on;
    }
    this.#padHeld = held;

    const dz = (v: number) => {
      const a = Math.abs(v);
      return a < DEADZONE ? 0 : (Math.sign(v) * (a - DEADZONE)) / (1 - DEADZONE);
    };
    const lx = dz(gp.axes[0] ?? 0);
    const ly = dz(gp.axes[1] ?? 0);
    const rx = dz(gp.axes[2] ?? 0);
    const ry = dz(gp.axes[3] ?? 0);
    const lt = gp.buttons[6]?.value ?? 0;
    const rt = gp.buttons[7]?.value ?? 0;
    const trig = rt - lt;
    this.#padAxes.set("KeyA|KeyD", lx);
    this.#padAxes.set("KeyS|KeyW", -ly + (this.#triggerRoute ? 0 : trig));
    if (this.#triggerRoute === "plane") {
      this.#padAxes.set("ArrowDown|ArrowUp", trig);
      this.#padAxes.delete("KeyQ|KeyE");
      this.#padAxes.delete("KeyQ|KeyU");
    } else if (this.#triggerRoute === "bird") {
      this.#padAxes.set("KeyQ|KeyE", trig);
      this.#padAxes.delete("ArrowDown|ArrowUp");
      this.#padAxes.delete("KeyQ|KeyU");
    } else if (this.#triggerRoute === "drone") {
      this.#padAxes.set("KeyQ|KeyU", trig);
      this.#padAxes.delete("ArrowDown|ArrowUp");
      this.#padAxes.delete("KeyQ|KeyE");
    } else {
      this.#padAxes.delete("ArrowDown|ArrowUp");
      this.#padAxes.delete("KeyQ|KeyE");
      this.#padAxes.delete("KeyQ|KeyU");
    }
    if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0 || lt > 0.02 || rt > 0.02) active = true;

    // right stick = mouselook; works without pointer lock
    if (!this.suspended) {
      this.mouseDX += rx * Math.abs(rx) * LOOK_X * dt;
      const pitchStick = this.#invertLookY ? -ry : ry;
      this.mouseDY += pitchStick * Math.abs(pitchStick) * LOOK_Y * dt;
    }

    if (active) this.#setDevice("pad");
  }

  requestLock() {
    // Chrome returns a promise and rejects during the post-Esc cooldown —
    // swallow it, the existing click-to-lock path is the fallback
    const p = this.#el.requestPointerLock() as unknown as Promise<void> | undefined;
    p?.catch(() => {});
  }

  releaseLock() {
    if (this.locked) document.exitPointerLock();
  }

  down(code: string) {
    return !this.suspended && (this.keys.has(code) || this.#padHeld.has(code));
  }

  /** True on the frame the key went down. Reads through even while suspended for mode toggles. */
  pressed(code: string) {
    return this.#justPressed.has(code);
  }

  /** True when this keydown happened with Shift held on the event itself. */
  shiftedPress(code: string) {
    return this.#shiftedPresses.has(code);
  }

  /** True when this keydown happened with Ctrl held on the event itself. */
  ctrlPressed(code: string) {
    return this.#ctrlPresses.has(code);
  }

  /** True when this keydown happened with Alt held on the event itself. */
  altPressed(code: string) {
    return this.#altPresses.has(code);
  }

  /** −1..1: keyboard keys are digital, pad sticks/triggers merge in analog. */
  axis(neg: string, pos: string) {
    if (this.suspended) return 0;
    const d = (c: string) => (this.keys.has(c) || this.#padHeld.has(c) ? 1 : 0);
    let v = d(pos) - d(neg);
    // pad contributions are stored under one canonical pair; the reversed
    // lookup (e.g. steering's axis("KeyD","KeyA")) flips the sign
    v += this.#padAxisValue(neg, pos);
    return Math.max(-1, Math.min(1, v));
  }

  /** −1..1 from pad-only virtual axes; useful when keyboard keys have another global action. */
  padAxis(neg: string, pos: string) {
    if (this.suspended) return 0;
    const v = this.#padAxisValue(neg, pos);
    return Math.max(-1, Math.min(1, v));
  }

  #padAxisValue(neg: string, pos: string) {
    return this.#padAxes.get(`${neg}|${pos}`) ?? -(this.#padAxes.get(`${pos}|${neg}`) ?? 0);
  }

  get firing() {
    return !this.suspended && (this.fireHeld || this.#padFireHeld);
  }

  /** Call once per frame after consuming state. */
  endFrame() {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.wheelX = 0;
    this.firePressed = false;
    this.#justPressed.clear();
    this.#shiftedPresses.clear();
    this.#ctrlPresses.clear();
    this.#altPresses.clear();
  }
}
