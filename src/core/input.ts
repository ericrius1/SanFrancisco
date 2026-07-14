import type { PlayerMode } from "../player/types";
import { INPUT_TUNING } from "../config";

/**
 * Pointer-lock game input. Clicking the canvas captures the mouse; mouselook
 * deltas accumulate only while locked. Escape release is an input-layer
 * invariant; main.ts separately decides which overlay Escape dismisses. The
 * game keeps simulating while unlocked. While `suspended` (camera-orbit mode)
 * all game inputs read as idle so the player coasts. Global holds that must
 * still work there (Z time-scrub, N look/speed) use `holding()` instead of `down()`.
 *
 * A gamepad (Xbox standard mapping) rides the same logical rails: pollPad()
 * translates buttons into the key codes the game already reads (A→Space,
 * Y→E interact/mount like RDR2, RT→Shift, Back→map, …), the left stick into
 * the WASD axis pairs (radial deadzone + move curve from INPUT_TUNING), the
 * right stick into mouselook deltas outside the locked surf activity (same
 * deadzone + look curve), and the triggers into the active mode's throttle —
 * fly routes them to ↑/↓, bird routes LB/RB to Q/E twirl —
 * so modes/camera/fireworks never see a second input path. `device` tracks
 * whichever input was touched last; the HUD swaps its control labels off it.
 *
 * Board mode steals right-stick Y for deck pitch / air flips (stick back =
 * nose up); only right-stick X still feeds mouselook there. Right-stick pitch
 * polarity for camera look is global via INPUT_TUNING.invertPadLookY — mouse
 * look is never flipped here.
 */

// right-stick look speed, mouse-pixel-equivalents per second at full deflection
// after deadzone + response curve (curve lives in INPUT_TUNING.lookResponse)
const LOOK_X = 1150;
const LOOK_Y = 720;

/** Radial deadzone then optional power curve. Keeps direction; remaps magnitude. */
function shapeStick(x: number, y: number, deadzone: number, curve: number): [number, number] {
  const mag = Math.hypot(x, y);
  if (mag < deadzone || mag < 1e-8) return [0, 0];
  const remapped = Math.min(1, (mag - deadzone) / (1 - deadzone));
  const shaped = Math.pow(remapped, Math.max(1, curve));
  const scale = shaped / mag;
  return [x * scale, y * scale];
}

// button index (standard mapping) → key code it impersonates. X (2) is fire,
// handled separately. Dpad ◀/▶ emit synthetic mode-cycle codes main.ts reads.
// Face layout follows RDR2 conventions where they map cleanly: Y is the world
// interact / mount / dismount button (keyboard E), not B.
const PAD_BUTTONS: Record<number, string> = {
  0: "Space", //     A: jump / ollie / drift / air brake / hover
  // 1 B: unbound (RDR2 reload/melee — unused here)
  3: "KeyE", //      Y: interact / enter-exit vehicle (RDR2-style)
  4: "KeyQ", //      LB: drone down / bird twirl left
  // 5 RB: bird twirl right — routed via pad axis (not KeyE, which exits)
  7: "ShiftLeft", // RT: boost / run / tuck
  8: "KeyM", //      Back/View: map (RDR2 holds Select for map; tap here)
  9: "KeyP", //      Start: pause
  10: "ShiftLeft", //L3: boost too
  11: "KeyC", //     R3: cycle third / first / camera-controls
  12: "KeyB", //     dpad up: fireworks (held)
  13: "KeyG", //     dpad down: zero-g
  14: "PadModePrev", // dpad left/right: cycle travel modes
  15: "PadModeNext"
};

/** Last keyboard/pad device that produced input — for glyph prompts without plumbing. */
let lastInputDevice: "kb" | "pad" = "kb";

/** Keyboard E / pad Y (RDR2-style interact). */
export function interactKeyLabel(device: "kb" | "pad" = lastInputDevice): string {
  return device === "pad" ? "Y" : "E";
}

/** `Y — open the door` when a pad is active, else `E — open the door`. */
export function formatInteractPrompt(action: string, device: "kb" | "pad" = lastInputDevice): string {
  return `${interactKeyLabel(device)} — ${action}`;
}

/**
 * Rewrite keyboard-authored interact copy (`E — …`, `Press E …`, `E · …`) for
 * the active device. Leaves non-interact text alone.
 */
export function localizeInteractText(text: string, device: "kb" | "pad" = lastInputDevice): string {
  if (device !== "pad") return text;
  const key = interactKeyLabel("pad");
  return text
    .replace(/\bPress E\b/g, `Press ${key}`)
    .replace(/\bE ·/g, `${key} ·`)
    .replace(/\bE —/g, `${key} —`)
    .replace(/\bE \/ B\b/g, `E / ${key}`)
    .replace(/\bpad B\b/gi, `pad ${key}`);
}

export type MapPadAxes = { lx: number; ly: number; rx: number; ry: number; lt: number; rt: number };

export class Input {
  keys = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  wheelX = 0;
  firePressed = false;
  fireHeld = false;
  locked = false;
  /** Last caller intent — false after releaseLock so a late lock grant is dropped. */
  #wantLocked = false;
  /** Invalidates rejected/late request promises without touching a newer gesture. */
  #lockRequestGeneration = 0;
  /** Escape owns the current key transaction; no callback may re-lock during it. */
  #escapeHeld = false;
  /** Prevents a swallowed keyup from leaving pointer capture disabled forever. */
  #escapeReleaseTimeout: number | null = null;
  #suspended = false;
  #suspensionHolds = new Set<string>();
  padConnected = false;
  device: "kb" | "pad" = "kb";

  // Hold Command/Meta to temporarily release the pointer and steer a free
  // in-world cursor (mouseNDC is the live screen position, -1..1). Releasing
  // Meta re-locks. While true, canvas presses feed the cursor, not re-lock.
  freeCursor = false;
  mouseNDCx = 0;
  mouseNDCy = 0;

  onLockChange: (locked: boolean) => void = () => {};
  onDeviceChange: (device: "kb" | "pad") => void = () => {};
  onFreeCursorChange: (free: boolean) => void = () => {};

  /**
   * Ordinary UI ownership continues to assign `suspended` directly. Long-lived
   * asynchronous operations (notably world arrival) use named holds so a map
   * close or camera-mode change cannot accidentally re-enable gameplay halfway
   * through the operation.
   */
  get suspended(): boolean {
    return this.#suspended || this.#suspensionHolds.size > 0;
  }

  set suspended(value: boolean) {
    this.#suspended = value;
  }

  setSuspensionHold(reason: string, held: boolean): void {
    if (held) {
      this.#suspensionHolds.add(reason);
      this.mouseDX = 0;
      this.mouseDY = 0;
      this.wheel = 0;
      this.wheelX = 0;
      this.firePressed = false;
      this.fireHeld = false;
      this.#padFireHeld = false;
    } else {
      this.#suspensionHolds.delete(reason);
    }
  }

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
  #mapPadAxes: MapPadAxes = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
  #triggerRoute: "plane" | "bird" | "drone" | null = null; // plane: ↑/↓ throttle; bird: LB/RB twirl; drone: Q/U vertical
  #mode: PlayerMode = "walk";

  constructor(el: HTMLElement) {
    this.#el = el;

    // This runs in capture phase and is registered before any UI is built.
    // Focused fields and modals may consume Escape for their own close/clear
    // behavior, but none of them may keep (or later restore) pointer lock.
    window.addEventListener(
      "keydown",
      (e) => {
        if (e.code === "Escape" || e.key === "Escape") {
          this.#beginEscapeRelease();
          this.releaseLock();
        }
      },
      true
    );

    window.addEventListener("keydown", (e) => {
      // typing into a DOM field (e.g. the "/" tuning panel) must not drive the game
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      // Tab toggles the user UI — never let it (or its repeats) move focus
      if (e.code === "Tab") e.preventDefault();
      // Alt+arrow is location history inside the game, not browser history.
      if (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) e.preventDefault();
      if (e.repeat) return;
      // Any key with Command demonstrably up recovers a stale free cursor whose
      // Meta keyup was lost (macOS) — heal then relock (keydown is a gesture).
      // (never re-lock on Escape — Esc must always leave the cursor free)
      if (this.freeCursor && !e.metaKey && !this.suspended) this.#endFreeCursor(e.code !== "Escape");
      // Command/Meta held: drop pointer lock so a free cursor can roam the world
      // and reach UI panels. Its keyup re-locks. Never fights the map/camera modes.
      if ((e.code === "MetaLeft" || e.code === "MetaRight") && this.locked && !this.suspended && !this.freeCursor) {
        this.freeCursor = true;
        this.mouseNDCx = 0;
        this.mouseNDCy = 0;
        this.fireHeld = false;
        this.onFreeCursorChange(true);
        document.exitPointerLock();
      }
      this.keys.add(e.code);
      this.#justPressed.add(e.code);
      if (e.shiftKey) this.#shiftedPresses.add(e.code);
      if (e.ctrlKey) this.#ctrlPresses.add(e.code);
      if (e.altKey) this.#altPresses.add(e.code);
      this.#setDevice("kb");
      // Slash: keep "/" (debug panel) from triggering Firefox quick-find
      if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Slash"].includes(e.code)) e.preventDefault();
    });
    window.addEventListener(
      "keyup",
      (e) => {
        this.keys.delete(e.code);
        if (e.code === "Escape" || e.key === "Escape") {
          // Chrome/Firefox may reserve the locked keydown for browser UI yet
          // deliver keyup while the pointer is still captured. Treat either
          // phase as authoritative, and keep re-lock blocked through the rest
          // of this event's propagation.
          this.#beginEscapeRelease();
          this.releaseLock();
          queueMicrotask(() => {
            this.#endEscapeRelease();
          });
        }
        if ((e.code === "MetaLeft" || e.code === "MetaRight") && this.freeCursor) this.#endFreeCursor(true);
      },
      true
    );
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.fireHeld = false;
      this.#endEscapeRelease();
      // Focus loss can swallow keyup and browser-owned Escape events. Make it an
      // authoritative release too; the next fresh canvas press may recapture.
      this.releaseLock();
    });

    document.addEventListener("pointerlockchange", () => {
      const nowLocked = document.pointerLockElement === el;
      // The browser is the authority on release. It may consume Escape before
      // the page receives a key event, so every observed unlock must also cancel
      // all earlier request intent. Only a later, explicit gesture may set it.
      if (!nowLocked) {
        this.#lockRequestGeneration++;
        this.#wantLocked = false;
      }
      // A grant that lands after releaseLock() (Esc during an in-flight
      // requestLock) is stale — drop it so Esc always wins.
      if (nowLocked && !this.#wantLocked) {
        document.exitPointerLock();
        return;
      }
      this.locked = nowLocked;
      if (!this.locked) this.fireHeld = false;
      this.onLockChange(this.locked);
    });

    el.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      if (this.suspended) return;
      // Command released but its keyup never arrived (macOS Chrome swallows the
      // Meta keyup behind system shortcuts / Mission Control) — this new press's
      // metaKey is authoritative, so drop the stale free cursor and recapture.
      if (this.freeCursor && !e.metaKey) {
        this.#endFreeCursor(true);
        return;
      }
      // Capture on the fresh press, never on click: if Escape releases while a
      // button is held, that old pointer sequence's trailing mouse-up/click can
      // no longer undo the release.
      if (!this.locked && !this.freeCursor) {
        this.requestLock();
        return;
      }
      // captured: fire the held tool. free cursor: a single click-to-inspect
      // (no held auto-fire — the world stays put while you point at things).
      if (this.locked && this.#mode !== "surf") {
        this.firePressed = true;
        this.fireHeld = true;
        this.#setDevice("kb");
      } else if (this.freeCursor && this.#mode !== "surf") {
        this.firePressed = true;
        this.#setDevice("kb");
      }
    });
    window.addEventListener("mouseup", (e) => {
      if (e.button === 0) this.fireHeld = false;
    });
    el.addEventListener("contextmenu", (e) => e.preventDefault());

    window.addEventListener("mousemove", (e) => {
      // Pointer-lock look, or Z/N-held scrub (works unlocked in camera-orbit
      // mode where the chase cam has released the pointer).
      const holdScrub = this.keys.has("KeyZ") || this.keys.has("KeyN");
      if (this.suspended && !holdScrub) return;
      if (this.locked || holdScrub) {
        // Surf owns a locked authored camera. Pointer lock can stay captured, but
        // physical mouse motion must be a mathematical no-op for that activity.
        if (this.#mode !== "surf" || holdScrub) {
          this.mouseDX += e.movementX;
          this.mouseDY += e.movementY;
        }
        if (this.locked) return;
      }
      // stale free cursor (lost Meta keyup): metaKey is authoritative, so drop
      // it here too — the next canvas press then relocks like it used to.
      if (this.freeCursor && !e.metaKey) this.#endFreeCursor(false);
      // free cursor / unlocked: track the absolute pointer as NDC (-1..1)
      this.mouseNDCx = (e.clientX / window.innerWidth) * 2 - 1;
      this.mouseNDCy = -((e.clientY / window.innerHeight) * 2 - 1);
    });

    el.addEventListener(
      "wheel",
      (e) => {
        const holdScrub = this.keys.has("KeyZ") || this.keys.has("KeyN");
        if (this.suspended && !holdScrub) {
          e.preventDefault();
          return;
        }
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
    lastInputDevice = device;
    this.onDeviceChange(device);
  }

  #beginEscapeRelease() {
    this.#escapeHeld = true;
    if (this.#escapeReleaseTimeout !== null) window.clearTimeout(this.#escapeReleaseTimeout);
    // Some browser/OS paths swallow keyup without blurring the page. Keep the
    // barrier long enough to cover async UI callbacks, then recover click-to-lock.
    this.#escapeReleaseTimeout = window.setTimeout(() => {
      this.#escapeHeld = false;
      this.#escapeReleaseTimeout = null;
    }, 1500);
  }

  #endEscapeRelease() {
    this.#escapeHeld = false;
    if (this.#escapeReleaseTimeout !== null) window.clearTimeout(this.#escapeReleaseTimeout);
    this.#escapeReleaseTimeout = null;
  }

  /** Per-mode pad routing: fly → ↑/↓ throttle, bird → LB/RB twirl, drone → Q/U vertical. */
  setMode(mode: PlayerMode) {
    this.#mode = mode;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.firePressed = false;
    this.fireHeld = false;
    this.#padFireHeld = false;
    this.#triggerRoute =
      mode === "plane" ? "plane" : mode === "bird" ? "bird" : mode === "drone" ? "drone" : null;
  }

  /**
   * Read the gamepad once per frame, before any consumer. Buttons feed
   * keys/justPressed under their mapped codes, sticks and triggers feed the
   * axis pairs, and the right stick feeds mouselook outside surf (board keeps
   * stick-X look and routes stick-Y to BoardNoseDown|BoardNoseUp).
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
        this.#mapPadAxes = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0 };
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
      } else if (i === 2 && this.#mode !== "surf") {
        if (on && !this.#padPrev[i]) this.firePressed = true;
        this.#padFireHeld = on;
      }
      this.#padPrev[i] = on;
    }
    this.#padHeld = held;

    const tune = INPUT_TUNING.values;
    const deadzone = tune.stickDeadzone;
    // Left stick: deadzone + move curve (vehicles/walk read these axes analog).
    const [lx, ly] = shapeStick(gp.axes[0] ?? 0, gp.axes[1] ?? 0, deadzone, tune.moveResponse);
    // Right stick: deadzone only here — look curve applied when writing mouse deltas
    // so map-cursor mode still gets linear post-deadzone motion.
    const [rxLin, ryLin] = shapeStick(gp.axes[2] ?? 0, gp.axes[3] ?? 0, deadzone, 1);
    const lt = gp.buttons[6]?.value ?? 0;
    const rt = gp.buttons[7]?.value ?? 0;
    const trig = rt - lt;
    // bumpers: bird twirl (RB is axis-only so it doesn't impersonate KeyE / exit)
    const lb = gp.buttons[4]?.pressed || (gp.buttons[4]?.value ?? 0) > 0.5 ? 1 : 0;
    const rb = gp.buttons[5]?.pressed || (gp.buttons[5]?.value ?? 0) > 0.5 ? 1 : 0;
    this.#padAxes.set("KeyA|KeyD", lx);
    this.#padAxes.set("KeyS|KeyW", -ly + (this.#triggerRoute ? 0 : trig));
    if (this.#triggerRoute === "plane") {
      this.#padAxes.set("ArrowDown|ArrowUp", trig);
      this.#padAxes.delete("KeyQ|KeyE");
      this.#padAxes.delete("KeyQ|KeyU");
      this.#padAxes.delete("BoardNoseDown|BoardNoseUp");
    } else if (this.#triggerRoute === "bird") {
      // LB is also KeyQ in PAD_BUTTONS; RB contributes via this axis only
      this.#padAxes.set("KeyQ|KeyE", rb);
      this.#padAxes.delete("ArrowDown|ArrowUp");
      this.#padAxes.delete("KeyQ|KeyU");
      this.#padAxes.delete("BoardNoseDown|BoardNoseUp");
    } else if (this.#triggerRoute === "drone") {
      this.#padAxes.set("KeyQ|KeyU", trig);
      this.#padAxes.delete("ArrowDown|ArrowUp");
      this.#padAxes.delete("KeyQ|KeyE");
      this.#padAxes.delete("BoardNoseDown|BoardNoseUp");
    } else if (this.#mode === "board") {
      // Stick back/down (+ry) = nose up; shaped so light presses are manuals
      // and a hard hold can drive air flips in BoardController.
      const pitchMag = Math.abs(ryLin);
      const pitchShaped =
        pitchMag < 1e-8 ? 0 : Math.sign(ryLin) * Math.pow(pitchMag, Math.max(1, tune.moveResponse));
      this.#padAxes.set("BoardNoseDown|BoardNoseUp", pitchShaped);
      this.#padAxes.delete("ArrowDown|ArrowUp");
      this.#padAxes.delete("KeyQ|KeyE");
      this.#padAxes.delete("KeyQ|KeyU");
    } else {
      this.#padAxes.delete("ArrowDown|ArrowUp");
      this.#padAxes.delete("KeyQ|KeyE");
      this.#padAxes.delete("KeyQ|KeyU");
      this.#padAxes.delete("BoardNoseDown|BoardNoseUp");
    }
    if (lx !== 0 || ly !== 0 || rxLin !== 0 || ryLin !== 0 || lt > 0.02 || rt > 0.02 || lb || rb) {
      active = true;
    }

    // Post-deadzone sticks/triggers for the expanded map (readable while suspended).
    this.#mapPadAxes = { lx, ly, rx: rxLin, ry: ryLin, lt, rt };

    // right stick = mouselook; works without pointer lock except in surf's
    // authored camera. Board keeps stick-X look but routes stick-Y to deck pitch.
    // Pitch polarity is the global INPUT_TUNING toggle.
    // Sensitivity is applied once in ChaseCamera (same path as mouse) — do not
    // multiply it here or pad look scales with lookSensitivity².
    if (!this.suspended && this.#mode !== "surf") {
      const [rx, ry] = shapeStick(rxLin, ryLin, 0, tune.lookResponse);
      this.mouseDX += rx * LOOK_X * dt;
      if (this.#mode !== "board") {
        const pitchStick = tune.invertPadLookY ? -ry : ry;
        this.mouseDY += pitchStick * LOOK_Y * dt;
      }
    }

    if (active) this.#setDevice("pad");
  }

  /** Left/right sticks + triggers, ignoring `suspended` — for expanded-map navigation. */
  mapPadAxes(): MapPadAxes {
    return this.#mapPadAxes;
  }

  #endFreeCursor(relock: boolean) {
    this.freeCursor = false;
    this.onFreeCursorChange(false);
    if (relock && !this.suspended) this.requestLock();
  }

  requestLock() {
    // Escape dominates the entire key transaction, including UI blur/toggle
    // callbacks that run later during the same event propagation.
    if (this.#escapeHeld) {
      this.#lockRequestGeneration++;
      this.#wantLocked = false;
      return;
    }
    const generation = ++this.#lockRequestGeneration;
    this.#wantLocked = true;
    // Chrome returns a promise and rejects during the post-Esc cooldown —
    // clear only this request's intent; a later gesture owns a newer generation.
    try {
      const p = this.#el.requestPointerLock() as unknown as Promise<void> | undefined;
      p?.catch(() => {
        if (generation === this.#lockRequestGeneration && document.pointerLockElement !== this.#el) {
          this.#wantLocked = false;
        }
      });
    } catch {
      if (generation === this.#lockRequestGeneration) this.#wantLocked = false;
    }
  }

  releaseLock() {
    // Unconditional: `this.locked` lags reality (pointerlockchange is async) and
    // a pending requestLock grant may still be in flight — clearing the intent
    // flag makes the pointerlockchange handler drop that late grant too. End a
    // temporary Command cursor as well, otherwise its later keyup could re-lock.
    this.#lockRequestGeneration++;
    this.#wantLocked = false;
    if (this.freeCursor) this.#endFreeCursor(false);
    document.exitPointerLock();
  }

  down(code: string) {
    return !this.suspended && (this.keys.has(code) || this.#padHeld.has(code));
  }

  /** Physical hold — ignores `suspended` so global holds (Z time-scrub) work in camera-orbit mode. */
  holding(code: string) {
    return this.keys.has(code) || this.#padHeld.has(code);
  }

  /**
   * True on the frame the key went down. Ordinary UI suspension still permits
   * mode toggles, but named asynchronous holds suppress edge actions across all
   * gameplay systems so an arrival cannot be mutated out from under its pin.
   */
  pressed(code: string) {
    return this.#suspensionHolds.size === 0 && this.#justPressed.has(code);
  }

  /** UI escape hatches that intentionally read through a named hold. */
  pressedRaw(code: string) {
    return this.#justPressed.has(code);
  }

  /** True when this keydown happened with Shift held on the event itself. */
  shiftedPress(code: string) {
    return this.#suspensionHolds.size === 0 && this.#shiftedPresses.has(code);
  }

  /** True when this keydown happened with Ctrl held on the event itself. */
  ctrlPressed(code: string) {
    return this.#suspensionHolds.size === 0 && this.#ctrlPresses.has(code);
  }

  /** True when this keydown happened with Alt held on the event itself. */
  altPressed(code: string) {
    return this.#suspensionHolds.size === 0 && this.#altPresses.has(code);
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
    return this.#mode !== "surf" && !this.suspended && (this.fireHeld || this.#padFireHeld);
  }

  /** Diagnostics/QA contract: surf never forwards pointer/right-stick look. */
  get cameraLookLocked() {
    return this.#mode === "surf";
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
