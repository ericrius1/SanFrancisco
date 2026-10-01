import type { Input } from "../core/input";
import { STICK_RADIUS, TouchDriver, stickFromOffset } from "./touchDriver";
import "./touchControls.css";

/**
 * On-screen controls for phones and tablets.
 *
 * Loaded only when index.html tagged the page `touch-ui` (primary pointer is a
 * finger, or `?touch=1`), so desktop never fetches this chunk or its CSS.
 *
 * Everything here feeds the game through the Input driver channel — the same
 * rails keyboard, gamepad and scripted QA use — so walk, every vehicle and the
 * chase camera read touch exactly as they read a pad: a left thumb stick on the
 * "KeyA|KeyD" / "KeyS|KeyW" axis pairs, a right-side drag as look deltas, and
 * buttons that hold the same key codes their keyboard twins do (Space, E,
 * Shift, J, M). No controller learns about touch.
 *
 * Layout: the left half of the screen is the move zone (the stick appears
 * under the thumb), the right half is the look zone, and the buttons sit in the
 * bottom-right thumb arc. HUD panels stack above both zones, so a tap on a
 * toolbar chip or the minimap still reaches that panel.
 */

type ButtonSpec = {
  /** Key code held while pressed, "fire" for the selected tool, "" for a menu toggle. */
  code: string;
  label: string;
  /** The keyboard glyph that on-screen prompts name ("E — get in"). */
  cap?: string;
  cls: string;
};

const ACTION_BUTTONS: ButtonSpec[] = [
  { code: "Space", label: "Jump", cap: "Space", cls: "tc-jump" },
  { code: "KeyE", label: "E", cap: "use", cls: "tc-use" },
  { code: "ShiftLeft", label: "Run", cap: "Shift", cls: "tc-run" },
  { code: "fire", label: "Tool", cap: "click", cls: "tc-fire" }
];

const TOP_BUTTONS: ButtonSpec[] = [
  { code: "", label: "Travel", cls: "tc-travel" },
  { code: "KeyJ", label: "Emote", cls: "tc-emote" },
  { code: "KeyM", label: "Map", cls: "tc-map" },
  { code: "", label: "Chat", cls: "tc-chat" }
];

function button(spec: ButtonSpec): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `tc-btn ${spec.cls}`;
  b.dataset.code = spec.code;
  b.setAttribute("aria-label", spec.label);
  b.innerHTML = `<span class="tc-label">${spec.label}</span>` + (spec.cap ? `<span class="tc-cap">${spec.cap}</span>` : "");
  return b;
}

export type TouchControls = {
  driver: TouchDriver;
  root: HTMLElement;
};

export function installTouchControls(input: Input, getTimeOfDay: () => number = () => 12): TouchControls {
  const hud = document.getElementById("hud")!;
  const driver = new TouchDriver();

  const root = document.createElement("div");
  root.className = "touch-controls";

  const moveZone = document.createElement("div");
  moveZone.className = "tc-zone tc-move";
  const lookZone = document.createElement("div");
  lookZone.className = "tc-zone tc-look";

  const stick = document.createElement("div");
  stick.className = "tc-stick";
  const knob = document.createElement("div");
  knob.className = "tc-knob";
  stick.appendChild(knob);
  moveZone.appendChild(stick);

  const actions = document.createElement("div");
  actions.className = "tc-actions";
  for (const spec of ACTION_BUTTONS) actions.appendChild(button(spec));

  const top = document.createElement("div");
  top.className = "tc-top";
  for (const spec of TOP_BUTTONS) top.appendChild(button(spec));
  const travelBtn = top.querySelector<HTMLButtonElement>(".tc-travel")!;
  const chatBtn = top.querySelector<HTMLButtonElement>(".tc-chat")!;

  // Always in reach: relative dragging lets the finger leave the clock without
  // hitting an endpoint. A 240px swipe advances twelve hours; reverse to rewind.
  const clock = document.createElement("div");
  clock.className = "tc-clock";
  clock.tabIndex = 0;
  clock.setAttribute("role", "slider");
  clock.setAttribute("aria-label", "Time of day. Drag left or right");
  clock.setAttribute("aria-valuemin", "0");
  clock.setAttribute("aria-valuemax", "24");
  clock.innerHTML = '<span class="tc-clock-face"><span class="tc-clock-icon" aria-hidden="true">☀</span><span class="tc-clock-time"></span></span><span class="tc-clock-hint" aria-hidden="true">‹ DAY / NIGHT ›</span>';
  const clockTime = clock.querySelector<HTMLElement>(".tc-clock-time")!;
  const clockIcon = clock.querySelector<HTMLElement>(".tc-clock-icon")!;
  let lastMinute = -1;
  const syncClock = () => {
    const hour = ((getTimeOfDay() % 24) + 24) % 24;
    const minute = Math.floor(hour * 60);
    if (minute === lastMinute) return;
    lastMinute = minute;
    const h = Math.floor(minute / 60);
    const label = `${h % 12 || 12}:${String(minute % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
    clockTime.textContent = label;
    clockIcon.textContent = hour >= 6 && hour < 18 ? "☀" : "☾";
    clock.setAttribute("aria-valuenow", String(minute / 60));
    clock.setAttribute("aria-valuetext", label);
  };
  driver.onUpdate = syncClock;
  syncClock();
  let clockPointer: number | null = null;
  let clockX = 0;
  const endClock = () => {
    clockPointer = null;
    clock.classList.remove("scrubbing");
    driver.scrubTime(false);
  };
  clock.addEventListener("pointerdown", (e) => {
    if (clockPointer !== null) return;
    e.preventDefault();
    input.noteTouch();
    clockPointer = e.pointerId;
    clockX = e.clientX;
    clock.setPointerCapture(e.pointerId);
    clock.classList.add("scrubbing");
    driver.scrubTime(true);
  });
  clock.addEventListener("pointermove", (e) => {
    if (e.pointerId !== clockPointer) return;
    driver.scrubTime(true, (e.clientX - clockX) * 0.05);
    clockX = e.clientX;
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
    clock.addEventListener(event, (e) => {
      if (e.pointerId === clockPointer) endClock();
    });
  }
  clock.addEventListener("contextmenu", (e) => e.preventDefault());
  clock.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    driver.scrubTime(false, e.key === "ArrowRight" || e.key === "ArrowUp" ? 0.25 : -0.25);
  });

  root.append(moveZone, lookZone, actions, top, clock);
  // First child of #hud: every HUD panel after it paints above the zones.
  hud.prepend(root);

  // Travel: the vehicle / tool toolbar is a sheet on phones, folded until
  // asked for and folded again once a ride is picked.
  const html = document.documentElement;
  const setToolbarOpen = (open: boolean) => html.classList.toggle("touch-toolbar-open", open);
  travelBtn.addEventListener("click", () => setToolbarOpen(!html.classList.contains("touch-toolbar-open")));
  hud.addEventListener("click", (e) => {
    if ((e.target as Element | null)?.closest?.(".toolbar .vehicle")) setToolbarOpen(false);
  });
  /** A touch on the world while a sheet is open closes it instead of steering. */
  const closeSheets = (): boolean => {
    if (html.classList.contains("touch-toolbar-open")) {
      setToolbarOpen(false);
      return true;
    }
    return false;
  };

  // Move zone: the stick is born where the thumb lands.
  let movePointer: number | null = null;
  let originX = 0;
  let originY = 0;
  moveZone.addEventListener("pointerdown", (e) => {
    if (movePointer !== null) return;
    e.preventDefault();
    input.noteTouch();
    if (closeSheets()) return;
    movePointer = e.pointerId;
    moveZone.setPointerCapture(e.pointerId);
    const r = moveZone.getBoundingClientRect();
    originX = e.clientX;
    originY = e.clientY;
    stick.style.left = `${e.clientX - r.left}px`;
    stick.style.top = `${e.clientY - r.top}px`;
    knob.style.transform = "";
    stick.classList.add("active");
  });
  moveZone.addEventListener("pointermove", (e) => {
    if (e.pointerId !== movePointer) return;
    const dx = e.clientX - originX;
    const dy = e.clientY - originY;
    const s = stickFromOffset(dx, dy);
    driver.moveX = s.x;
    driver.moveY = s.y;
    const len = Math.hypot(dx, dy);
    const k = len > STICK_RADIUS ? STICK_RADIUS / len : 1;
    knob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
  });
  const endMove = (e: PointerEvent) => {
    if (e.pointerId !== movePointer) return;
    movePointer = null;
    driver.moveX = 0;
    driver.moveY = 0;
    stick.classList.remove("active");
  };
  moveZone.addEventListener("pointerup", endMove);
  moveZone.addEventListener("pointercancel", endMove);

  // Look zone: every finger on it drags the camera (a second finger just adds).
  const lookLast = new Map<number, { x: number; y: number }>();
  lookZone.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    input.noteTouch();
    if (closeSheets()) return;
    lookZone.setPointerCapture(e.pointerId);
    lookLast.set(e.pointerId, { x: e.clientX, y: e.clientY });
  });
  lookZone.addEventListener("pointermove", (e) => {
    const last = lookLast.get(e.pointerId);
    if (!last) return;
    driver.look(e.clientX - last.x, e.clientY - last.y);
    last.x = e.clientX;
    last.y = e.clientY;
  });
  const endLook = (e: PointerEvent) => lookLast.delete(e.pointerId);
  lookZone.addEventListener("pointerup", endLook);
  lookZone.addEventListener("pointercancel", endLook);

  // Held buttons: pressed while a finger is on them, released on lift/cancel.
  for (const b of root.querySelectorAll<HTMLButtonElement>(".tc-btn")) {
    const code = b.dataset.code;
    if (!code) continue;
    b.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      input.noteTouch();
      b.setPointerCapture(e.pointerId);
      b.classList.add("down");
      driver.press(code);
    });
    const up = () => {
      b.classList.remove("down");
      driver.release(code);
    };
    b.addEventListener("pointerup", up);
    b.addEventListener("pointercancel", up);
    b.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // Chat: the panel stays folded away until asked for. Focus must happen inside
  // the tap itself — iOS only raises the keyboard for a user-gesture focus.
  // The open state is read on press: by click time a focus change from the
  // press itself may already have folded the panel.
  let chatWasOpen = false;
  chatBtn.addEventListener("pointerdown", (e) => {
    chatWasOpen = html.classList.contains("touch-chat-open");
    e.preventDefault();
  });
  chatBtn.addEventListener("mousedown", (e) => e.preventDefault());
  chatBtn.addEventListener("click", () => {
    const field = document.querySelector<HTMLInputElement>("#hud .chat-input");
    if (!field) return;
    const open = !chatWasOpen;
    html.classList.toggle("touch-chat-open", open);
    if (open) field.focus();
    else field.blur();
  });
  document.addEventListener("focusout", (e) => {
    if ((e.target as Element | null)?.classList?.contains("chat-input")) {
      html.classList.remove("touch-chat-open");
    }
  });

  // A backgrounded tab never sees the pointerup of a finger it lost.
  const releaseTouches = () => {
    endClock();
    movePointer = null;
    lookLast.clear();
    stick.classList.remove("active");
    root.querySelectorAll(".down").forEach(button => button.classList.remove("down"));
    driver.releaseAll();
  };
  window.addEventListener("blur", releaseTouches);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) releaseTouches();
  });

  input.setDriver(driver);
  return { driver, root };
}
