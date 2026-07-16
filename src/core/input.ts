import type { PlayerMode } from "../player/types";
import { INPUT_TUNING } from "../config";

/**
 * Pointer-lock game input. Clicking the canvas (not HUD/UI) re-captures the
 * mouse when unlocked; mouselook deltas accumulate only while locked. Escape is
 * left to the browser's native pointer-lock exit — this layer only syncs via
 * `pointerlockchange`. Tap L toggles free-cursor controls vs pointer-lock
 * controls (a scene click also exits free-cursor and re-locks).
 * The game keeps simulating while unlocked. While `suspended` (camera-orbit mode)
 * all game inputs read as idle so the player coasts. Global holds that must
 * still work there (Z time-scrub, N look/speed) use `holding()` instead of `down()`.
 *
 * A gamepad (Xbox standard mapping) rides the same logical rails: pollPad()
 * translates buttons into the key codes the game already reads (A→Space,
 * Y→E interact/mount like RDR2, L3/LT→Shift boost/run (drive: LB + L3; LT is
 * reverse), Back→map, …), the left stick into the WASD axis pairs (radial
 * deadzone + move curve from INPUT_TUNING), the right stick into mouselook
 * deltas outside the locked surf activity (same deadzone + look curve), RT into
 * the selected tool while walking or flying as a bird (mouse-hold fire — ball /
 * paint / bubbles; vehicles keep RT as throttle and fire on X), and the
 * triggers into the active mode's throttle — fly routes RT to ↑ (LT is boost),
 * bird routes LB/RB to Q/E twirl, drive uses RT−LT gas/reverse, LB boost, and
 * RB → PadSlideLeft (slide follows steer) — so modes/camera never see a second
 * input path. `device` tracks whichever input was touched last; the HUD swaps
 * its control labels off it.
 *
 * Board mode steals right-stick Y for deck pitch / air flips (stick back =
 * nose up); only right-stick X still feeds mouselook there, with an extra
 * axial deadzone (boardLookXDeadzone) so near-vertical flip holds don't yaw
 * the cam. Right-stick pitch polarity for camera look is global via
 * INPUT_TUNING.invertPadLookY — mouse look is never flipped here.
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

/** Axial deadzone + power curve on one axis (independent of the other stick axis). */
function shapeAxis(v: number, deadzone: number, curve: number): number {
  const a = Math.abs(v);
  if (a < deadzone || a < 1e-8) return 0;
  const remapped = Math.min(1, (a - deadzone) / (1 - deadzone));
  return Math.sign(v) * Math.pow(remapped, Math.max(1, curve));
}

// button index (standard mapping) → key code it impersonates. X (2) and RT (7)
// are fire (mouse-hold equivalent for the selected tool), handled separately.
// LT (6) is boost alongside L3 except in drive (reverse) and surf (stall) —
// handled in pollPad so boost modes leave LT out of analog throttle. Dpad
// ↑/↓/◀/▶ emit synthetic toolbar-nav codes main.ts reads (row focus + within-row
// cycle; map pin cycle reuses ◀/▶ while expanded). Face layout follows RDR2
// conventions where they map cleanly: Y is the world interact / mount / dismount
// button (keyboard E). Boost/run/tuck live on L3 and LT (drive: LB + L3; LT is
// reverse) so RT can own the tool action on foot.
const PAD_BUTTONS: Record<number, string> = {
  0: "Space", //     A: jump / ollie / drift / air brake / hover
  // 1 B: unbound
  3: "KeyE", //      Y: interact / enter-exit vehicle (RDR2-style)
  4: "KeyQ", //      LB: drone down / bird twirl left / (drive: boost; scooter: slide — see pollPad)
  // 5 RB: bird twirl right; drive: PadSlideLeft; scooter unbound
  // 6 LT: boost / run / tuck, or drive reverse / surf stall — see pollPad
  // 7 RT: fire — selected tool (ball / paint / bubbles); see pollPad
  8: "KeyM", //      Back/View: map (RDR2 holds Select for map; tap here)
  9: "KeyP", //      Start: pause
  10: "ShiftLeft", //L3: boost / run / tuck
  11: "KeyC", //     R3: cycle third / first / camera-controls
  12: "PadNavUp", //  dpad up/down: toolbar row focus (vehicles ↔ tools ↔ swatches)
  13: "PadNavDown",
  14: "PadModePrev", // dpad left/right: cycle focused toolbar row (map: pins)
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
  #suspended = false;
  #suspensionHolds = new Set<string>();
  #activityCaptured = false;
  padConnected = false;
  device: "kb" | "pad" = "kb";

  // L tap toggles this: free in-world cursor (mouseNDC is the live screen
  // position, -1..1) vs pointer-lock mouselook. A canvas press (not UI) exits
  // free-cursor and re-locks; L also recaptures after a bare Esc unlock.
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

    window.addEventListener("keydown", (e) => {
      // typing into a DOM field (e.g. the "/" tuning panel) must not drive the game
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
      // Tab toggles the user UI — never let it (or its repeats) move focus
      if (e.code === "Tab") e.preventDefault();
      // Alt+arrow is location history inside the game, not browser history.
      if (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) e.preventDefault();
      if (e.repeat) return;
      // L toggles free-cursor ↔ pointer-lock (ignores chords with modifiers).
      if (
        e.code === "KeyL" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !this.suspended
      ) {
        this.#toggleFreeCursor();
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
    window.addEventListener("keyup", (e) => {
      this.keys.delete(e.code);
    });
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.fireHeld = false;
      // Drop capture on focus loss; free-cursor mode is sticky until L toggles it.
      this.#lockRequestGeneration++;
      this.#wantLocked = false;
      document.exitPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
      const nowLocked = document.pointerLockElement === el;
      // The browser is the authority on release (including native Escape exit).
      // Cancel earlier request intent; only a later, explicit gesture may set it.
      if (!nowLocked) {
        this.#lockRequestGeneration++;
        this.#wantLocked = false;
      }
      // A grant that lands after releaseLock() (UI dismiss during an in-flight
      // requestLock) is stale — drop it.
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
      // Scene click re-captures. HUD/UI sits above the canvas so those presses
      // never reach here — only a real world click re-locks. Capture on the
      // fresh press, never on click: if the browser releases while a button is
      // held, that old pointer sequence's trailing mouse-up/click must not undo
      // the release.
      if (!this.locked) {
        if (this.freeCursor) this.#endFreeCursor(false);
        this.requestLock();
        return;
      }
      // captured: fire the held tool.
      if (this.#mode !== "surf") {
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
    let padFire = false;
    // RT owns the selected tool on foot / as a bird. Elsewhere it is throttle
    // (drive, board, plane, …) — those modes keep fire on X.
    const rtFiresTool = this.#mode === "walk" || this.#mode === "bird";
    // LT mirrors L3 as boost/run/tuck except drive (reverse) and surf (stall),
    // so boost modes must not also subtract from analog throttle.
    const ltIsBoost = this.#mode !== "surf" && this.#mode !== "drive";
    const held = new Set<string>();
    for (let i = 0; i < gp.buttons.length; i++) {
      const on = gp.buttons[i].pressed || gp.buttons[i].value > 0.5;
      if (on) active = true;
      const code = PAD_BUTTONS[i];
      if (code) {
        // Drive: LB is boost (ShiftLeft); scooter: PadSlideLeft — skip KeyQ either way.
        if (i === 4 && this.#mode === "drive") {
          if (on) {
            held.add("ShiftLeft");
            if (!this.#padPrev[i]) this.#justPressed.add("ShiftLeft");
          }
        } else if (i === 4 && this.#mode === "scooter") {
          // PadSlideLeft is added below.
        } else if (on) {
          held.add(code);
          if (!this.#padPrev[i]) this.#justPressed.add(code);
        }
      } else if (i === 1 && this.#mode === "surf") {
        // B in surf: grab (mirrors keyboard Shift — slows air rotation, style)
        if (on) {
          held.add("ShiftLeft");
          if (!this.#padPrev[i]) this.#justPressed.add("ShiftLeft");
        }
      } else if (i === 2 && this.#mode === "surf") {
        // X in surf: Flow (mirrors keyboard X — Space/A is always the jump)
        if (on) {
          held.add("KeyX");
          if (!this.#padPrev[i]) this.#justPressed.add("KeyX");
        }
      } else if (i === 2) {
        // X: fire + map teleport
        if (on && !this.#padPrev[i]) this.firePressed = true;
        if (on) padFire = true;
      } else if (i === 6 && ltIsBoost && !this.suspended) {
        // LT: boost / run / tuck (same rail as L3 → ShiftLeft)
        if (on) {
          held.add("ShiftLeft");
          if (!this.#padPrev[i]) this.#justPressed.add("ShiftLeft");
        }
      } else if (i === 7 && rtFiresTool && !this.suspended) {
        // RT: selected tool (mouse-hold). Skipped while suspended — expanded map
        // uses RT for zoom, and orbit/UI should not paint.
        if (on && !this.#padPrev[i]) this.firePressed = true;
        if (on) padFire = true;
      }
      this.#padPrev[i] = on;
    }
    this.#padFireHeld = padFire;
    const tune = INPUT_TUNING.values;
    const deadzone = tune.stickDeadzone;
    // Left stick: deadzone + move curve (vehicles/walk read these axes analog).
    const [lx, ly] = shapeStick(gp.axes[0] ?? 0, gp.axes[1] ?? 0, deadzone, tune.moveResponse);
    // Right stick: deadzone only here — look curve applied when writing mouse deltas
    // so expanded-map zoom still gets linear post-deadzone motion.
    const [rxLin, ryLin] = shapeStick(gp.axes[2] ?? 0, gp.axes[3] ?? 0, deadzone, 1);
    const lt = gp.buttons[6]?.value ?? 0;
    const rt = gp.buttons[7]?.value ?? 0;
    // Walk: stick-only move so holding RT to throw/paint does not also shove forward.
    // When LT is boost, only RT feeds forward throttle (stick back still brakes).
    // Drive: RT−LT is gas/reverse (same dual-trigger shape as surf pump/stall).
    const trig = this.#mode === "walk" ? 0 : rt - (ltIsBoost ? 0 : lt);
    // bumpers: bird twirl (RB is axis-only so it doesn't impersonate KeyE / exit);
    // drive: RB → PadSlideLeft (steer picks the side); scooter: LB → PadSlideLeft.
    const lb = gp.buttons[4]?.pressed || (gp.buttons[4]?.value ?? 0) > 0.5 ? 1 : 0;
    const rb = gp.buttons[5]?.pressed || (gp.buttons[5]?.value ?? 0) > 0.5 ? 1 : 0;
    if (this.#mode === "drive" && rb) held.add("PadSlideLeft");
    else if (this.#mode === "scooter" && lb) held.add("PadSlideLeft");
    this.#padHeld = held;
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
      if (this.#mode === "board") {
        // Axial look-X deadzone on the raw axis (not radial) so holding mostly
        // up/down for flips stays camera-stable until a deliberate horizontal push.
        const rx = shapeAxis(gp.axes[2] ?? 0, tune.boardLookXDeadzone, tune.lookResponse);
        this.mouseDX += rx * LOOK_X * dt;
      } else {
        const [rx, ry] = shapeStick(rxLin, ryLin, 0, tune.lookResponse);
        this.mouseDX += rx * LOOK_X * dt;
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

  /**
   * An in-world station owns locomotion, camera look, wheel and tool fire for
   * the rest of this frame. Edge buttons remain readable so E/Y can release it
   * and global UI shortcuts still work.
   */
  captureActivity(): void {
    this.#activityCaptured = true;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
    this.wheelX = 0;
    this.firePressed = false;
  }

  get activityCaptured(): boolean {
    return this.#activityCaptured;
  }

  #toggleFreeCursor() {
    if (this.freeCursor) {
      this.#endFreeCursor(true);
      return;
    }
    // Esc (or blur) left us unlocked without entering free-cursor — L re-captures
    // directly so one tap gets back to mouselook instead of needing L then L.
    if (!this.locked) {
      if (!this.suspended) this.requestLock();
      return;
    }
    this.freeCursor = true;
    this.mouseNDCx = 0;
    this.mouseNDCy = 0;
    this.fireHeld = false;
    this.#lockRequestGeneration++;
    this.#wantLocked = false;
    this.onFreeCursorChange(true);
    document.exitPointerLock();
  }

  #endFreeCursor(relock: boolean) {
    this.freeCursor = false;
    this.onFreeCursorChange(false);
    if (relock && !this.suspended) this.requestLock();
  }

  requestLock() {
    // Free-cursor mode owns the pointer until L toggles it off.
    if (this.freeCursor) return;
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
    // flag makes the pointerlockchange handler drop that late grant too.
    // Free-cursor mode stays sticky (L toggles it); this only drops capture.
    this.#lockRequestGeneration++;
    this.#wantLocked = false;
    document.exitPointerLock();
  }

  down(code: string) {
    return !this.suspended && !this.#activityCaptured && (this.keys.has(code) || this.#padHeld.has(code));
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

  /** True while a key (or pad-mapped code) is held, honoring suspension. */
  held(code: string) {
    if (this.suspended || this.#activityCaptured) return false;
    return this.keys.has(code) || this.#padHeld.has(code);
  }

  /** −1..1: keyboard keys are digital, pad sticks/triggers merge in analog. */
  axis(neg: string, pos: string) {
    if (this.suspended || this.#activityCaptured) return 0;
    const d = (c: string) => (this.keys.has(c) || this.#padHeld.has(c) ? 1 : 0);
    let v = d(pos) - d(neg);
    // pad contributions are stored under one canonical pair; the reversed
    // lookup (e.g. steering's axis("KeyD","KeyA")) flips the sign
    v += this.#padAxisValue(neg, pos);
    return Math.max(-1, Math.min(1, v));
  }

  /** −1..1 from pad-only virtual axes; useful when keyboard keys have another global action. */
  padAxis(neg: string, pos: string) {
    if (this.suspended || this.#activityCaptured) return 0;
    const v = this.#padAxisValue(neg, pos);
    return Math.max(-1, Math.min(1, v));
  }

  #padAxisValue(neg: string, pos: string) {
    return this.#padAxes.get(`${neg}|${pos}`) ?? -(this.#padAxes.get(`${pos}|${neg}`) ?? 0);
  }

  get firing() {
    return this.#mode !== "surf" && !this.suspended && !this.#activityCaptured && (this.fireHeld || this.#padFireHeld);
  }

  /** Diagnostics/QA contract: surf never forwards pointer/right-stick look. */
  get cameraLookLocked() {
    return this.#mode === "surf";
  }

  /** Call once per frame after consuming state. */
  endFrame() {
    this.#activityCaptured = false;
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
