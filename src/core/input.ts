import type { PlayerMode } from "../player/types";
import { INPUT_TUNING } from "../config";

/**
 * Pointer-lock game input. Clicking the canvas captures the mouse; mouselook
 * deltas accumulate only while locked. Escape is left to the browser's native
 * pointer-lock exit — this layer only syncs via `pointerlockchange`. Tap
 * Command/Meta (alone) toggles free-cursor controls vs pointer-lock controls.
 * The game keeps simulating while unlocked. While `suspended` (camera-orbit mode)
 * all game inputs read as idle so the player coasts. Global holds that must
 * still work there (Z time-scrub, N look/speed) use `holding()` instead of `down()`.
 *
 * A gamepad (Xbox standard mapping) rides the same logical rails: pollPad()
 * translates buttons into the key codes the game already reads (A→Space,
 * Y→E interact/mount like RDR2, L3/LT→Shift boost/run, Back→map, …), the left
 * stick into the WASD axis pairs (radial deadzone + move curve from
 * INPUT_TUNING), the right stick into mouselook deltas outside the locked surf
 * activity (same deadzone + look curve), RT into the selected tool while walking
 * or flying as a bird (mouse-hold fire — ball / paint / bubbles; vehicles keep
 * RT as throttle and fire on X), and the triggers into the active mode's
 * throttle — fly routes RT to ↑ (LT is boost), bird routes LB/RB to Q/E twirl,
 * drive/scooter map LB to PadSlideLeft (slide follows steer; RB left free) —
 * so modes/camera never see a second input path. `device` tracks
 * whichever input was touched last; the HUD swaps its control labels off it.
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
// LT (6) is boost alongside L3 (also handled in pollPad so it stays out of
// the analog throttle). Dpad ↑/↓/◀/▶ emit synthetic toolbar-nav codes main.ts
// reads (row focus + within-row cycle; map pin cycle reuses ◀/▶ while expanded).
// Face layout follows RDR2 conventions where they map cleanly: Y is the world
// interact / mount / dismount button (keyboard E). Boost/run/tuck live on L3
// and LT so RT can own the tool action on foot.
const PAD_BUTTONS: Record<number, string> = {
  0: "Space", //     A: jump / ollie / drift / air brake / hover
  // 1 B: unbound
  3: "KeyE", //      Y: interact / enter-exit vehicle (RDR2-style)
  4: "KeyQ", //      LB: drone down / bird twirl left / (drive: PadSlideLeft only — see pollPad)
  // 5 RB: bird twirl right; drive/scooter leave unbound for a later action
  // 6 LT: boost / run / tuck — see pollPad (not in this table; must leave throttle)
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
  /** Lonely Meta tap (no chord) toggles free-cursor ↔ pointer-lock. */
  #metaAlone = false;
  #suspended = false;
  #suspensionHolds = new Set<string>();
  padConnected = false;
  device: "kb" | "pad" = "kb";

  // Command/Meta tap toggles this: free in-world cursor (mouseNDC is the live
  // screen position, -1..1) vs pointer-lock mouselook. While true, canvas
  // presses feed the cursor, not re-lock — tap Meta again to recapture.
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
      // Lonely Meta tap toggles free-cursor; any other key while Meta is down is a chord
      // (Cmd+C, etc.) and must not flip the mode.
      if (e.code === "MetaLeft" || e.code === "MetaRight") {
        this.#metaAlone = true;
      } else if (e.metaKey) {
        this.#metaAlone = false;
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
        if (e.code === "MetaLeft" || e.code === "MetaRight") {
          const t = e.target;
          const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement;
          if (this.#metaAlone && !this.suspended && !typing) this.#toggleFreeCursor();
          this.#metaAlone = false;
        }
      },
      true
    );
    window.addEventListener("blur", () => {
      this.keys.clear();
      this.fireHeld = false;
      this.#metaAlone = false;
      // Drop capture on focus loss; free-cursor mode is sticky until Meta toggles it.
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
      // Capture on the fresh press, never on click: if the browser releases while a
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
    // LT mirrors L3 as boost/run/tuck everywhere except surf (which still uses
    // LT as stall) so it must not also subtract from analog throttle.
    const ltIsBoost = this.#mode !== "surf";
    const held = new Set<string>();
    for (let i = 0; i < gp.buttons.length; i++) {
      const on = gp.buttons[i].pressed || gp.buttons[i].value > 0.5;
      if (on) active = true;
      const code = PAD_BUTTONS[i];
      if (code) {
        // Drive/scooter: LB is PadSlideLeft only — skip KeyQ so it can't force a left slide.
        if (i === 4 && (this.#mode === "drive" || this.#mode === "scooter")) {
          // PadSlideLeft is added below; RB stays unbound on purpose.
        } else if (on) {
          held.add(code);
          if (!this.#padPrev[i]) this.#justPressed.add(code);
        }
      } else if (i === 2 && this.#mode !== "surf") {
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
    // so map-cursor mode still gets linear post-deadzone motion.
    const [rxLin, ryLin] = shapeStick(gp.axes[2] ?? 0, gp.axes[3] ?? 0, deadzone, 1);
    const lt = gp.buttons[6]?.value ?? 0;
    const rt = gp.buttons[7]?.value ?? 0;
    // Walk: stick-only move so holding RT to throw/paint does not also shove forward.
    // When LT is boost, only RT feeds forward throttle (stick back still brakes).
    const trig = this.#mode === "walk" ? 0 : rt - (ltIsBoost ? 0 : lt);
    // bumpers: bird twirl (RB is axis-only so it doesn't impersonate KeyE / exit);
    // drive/scooter: LB → PadSlideLeft only (steer picks the slide side; RB stays free).
    const lb = gp.buttons[4]?.pressed || (gp.buttons[4]?.value ?? 0) > 0.5 ? 1 : 0;
    const rb = gp.buttons[5]?.pressed || (gp.buttons[5]?.value ?? 0) > 0.5 ? 1 : 0;
    const vehicleSlide = this.#mode === "drive" || this.#mode === "scooter";
    if (vehicleSlide && lb) held.add("PadSlideLeft");
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

  #toggleFreeCursor() {
    if (this.freeCursor) {
      this.#endFreeCursor(true);
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
    // Free-cursor mode owns the pointer until Meta toggles it off.
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
    // Free-cursor mode stays sticky (Meta toggles it); this only drops capture.
    this.#lockRequestGeneration++;
    this.#wantLocked = false;
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
