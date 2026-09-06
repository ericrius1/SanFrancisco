/**
 * Small, lazy-loadable flight HUD. It deliberately has no world or asset
 * imports: the flight controller owns physics and passes this view the tiny
 * slice of state it needs to present.
 */

export type SkyFlightCamera = "third" | "first";

/** The nearby island shape is intentionally compatible with sky-island metadata
 * plus the two view values (distance and discovery) calculated by the parent. */
export type SkyFlightIsland = {
  id: string;
  label?: string;
  name?: string;
  epithet?: string;
  center?: { x: number; y: number; z: number };
  distance?: number;
  bearing?: number;
  landingRadius?: number;
  discovered?: boolean;
  landed?: boolean;
  story?: {
    order?: number;
    title?: string;
    fragment?: string;
    resolution?: string;
  };
};

export type SkyFlightState = {
  /** Flight is available in the current mode. Defaults to true until the first update. */
  enabled?: boolean;
  /** True once the player is in the Superman flight controller. */
  flying?: boolean;
  /** Alias used by the flight controller integration. */
  active?: boolean;
  /** World altitude in metres. */
  altitude?: number;
  /** Signed gravity: +1 Earth, 0 float, -1 inverse. */
  gravity?: number;
  /** Optional authored field name, e.g. “Opal Memory’s tide”. */
  gravityField?: string;
  /** Alias for integrations that name the sampled field explicitly. */
  currentGravityField?: string;
  camera?: SkyFlightCamera;
  nearbyIsland?: SkyFlightIsland | null;
  /** Alias used by the flight controller integration. */
  currentIsland?: SkyFlightIsland | null;
  /** Optional position lets the HUD derive distance from authored metadata. */
  position?: { x: number; y: number; z: number };
  /** Set by the flight controller when feet are planted on an island. */
  landed?: boolean;
  /** Alias used by the flight controller integration. */
  grounded?: boolean;
  /** Optional lightweight catalog, used to retain authored story metadata. */
  islands?: readonly SkyFlightIsland[];
  /** Optional already-safe journal line from the parent. */
  storyJournal?: string;
};

export type SkyFlightCallbacks = {
  onFlightEnabledChange?: (enabled: boolean) => void;
  onTakeoff?: () => void;
  onLand?: () => void;
  onGravityChange?: (gravity: number) => void;
  onCameraChange?: (camera: SkyFlightCamera) => void;
  /** Set a navigation pointer/heading. This never teleports. */
  onFindSkyGardens?: () => void;
  /** Explicit travel action; the parent decides whether it is available. */
  onTravelToIsland?: (island: SkyFlightIsland) => void;
  onResetEarth?: () => void;
  onResetZero?: () => void;
  /** Called when the HUD needs the game to release/reacquire pointer lock. */
  onPointerLockChange?: (locked: boolean) => void;
  onFocus?: () => void;
  onBlur?: () => void;
  // Short aliases for the flight-controller integration.
  setGravity?: (gravity: number) => void;
  toggleFlight?: () => void;
  cycleView?: () => void;
  navigate?: (islandId: string) => void;
  travel?: (islandId: string) => void;
  setPanelOpen?: (open: boolean) => void;
  setEnabled?: (enabled: boolean) => void;
  onDiscovered?: (islandId: string, count: number) => void;
};

export type SkyFlightHUD = {
  update(state: SkyFlightState): void;
  open(): void;
  close(): void;
  discover(island: SkyFlightIsland): void;
  discoveredIds(): readonly string[];
  dispose(): void;
};

const STORAGE_KEY = "sf.sky-flight.discovered.v1";
const STYLE_ID = "sf-sky-flight-style";

const CSS = `
#hud .sf-sky-flight {
  position: absolute;
  right: 18px;
  bottom: calc(max(18px, env(safe-area-inset-bottom)) + 92px);
  z-index: 10;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  width: min(326px, calc(100vw - 28px));
  color: #e4fff8;
  font: 600 11px/1.3 var(--font, ui-sans-serif, system-ui, sans-serif);
  letter-spacing: .01em;
  text-shadow: 0 1px 3px rgba(0, 10, 20, .7);
  pointer-events: none;
}
#hud .sf-sky-flight button,
#hud .sf-sky-flight input { font: inherit; }
#hud .sf-sky-flight button { color: inherit; }
#hud .sf-flight-launch {
  pointer-events: auto;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 34px;
  padding: 7px 12px 7px 10px;
  border: 1px solid rgba(161, 242, 222, .54);
  border-radius: 999px;
  background: linear-gradient(135deg, rgba(11, 40, 48, .94), rgba(33, 28, 61, .94));
  box-shadow: 0 8px 22px rgba(0, 4, 14, .28), inset 0 1px 0 rgba(255,255,255,.16), 0 0 18px rgba(114, 230, 207, .1);
  transition: border-color .16s ease, transform .16s ease, background .16s ease;
}
#hud .sf-flight-launch:hover { border-color: #b8ffe9; transform: translateY(-1px); }
#hud .sf-flight-launch:active { transform: translateY(0); }
#hud .sf-flight-launch[aria-expanded="true"] { background: linear-gradient(135deg, rgba(20, 61, 66, .97), rgba(44, 32, 74, .97)); }
#hud .sf-flight-wing { color: #9effdf; font-size: 16px; line-height: 1; }
#hud .sf-flight-launch .sf-launch-copy { display: grid; gap: 1px; text-align: left; }
#hud .sf-flight-launch b { font-size: 11.5px; letter-spacing: .03em; }
#hud .sf-flight-launch small { color: rgba(220,255,246,.68); font-size: 9px; font-weight: 700; }
#hud .sf-flight-chevron { color: rgba(230,255,249,.62); font-size: 12px; margin-left: 2px; }
#hud .sf-flight-panel {
  pointer-events: auto;
  box-sizing: border-box;
  width: 100%;
  max-height: min(72vh, 560px);
  overflow: auto;
  padding: 13px;
  border: 1px solid rgba(165, 240, 223, .34);
  border-radius: 16px;
  background:
    radial-gradient(circle at 92% 0%, rgba(185, 155, 255, .18), transparent 42%),
    linear-gradient(145deg, rgba(9, 30, 38, .96), rgba(28, 22, 53, .95));
  box-shadow: 0 16px 38px rgba(0, 5, 16, .42), inset 0 1px 0 rgba(255,255,255,.1), 0 0 26px rgba(124, 224, 205, .08);
  scrollbar-width: thin;
  scrollbar-color: rgba(162, 240, 220, .35) transparent;
}
#hud .sf-flight-panel[hidden] { display: none; }
#hud .sf-flight-head { display: flex; justify-content: space-between; gap: 10px; align-items: start; margin-bottom: 11px; }
#hud .sf-flight-kicker { color: #a2f5df; font-size: 9px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
#hud .sf-flight-title { margin-top: 2px; color: #f1fffb; font-size: 15px; font-weight: 800; letter-spacing: -.01em; }
#hud .sf-flight-enabled { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; color: rgba(221,255,246,.8); font-size: 10px; cursor: pointer; }
#hud .sf-flight-enabled input { accent-color: #8ef0d6; width: 14px; height: 14px; margin: 0; }
#hud .sf-flight-control { padding: 9px 0; border-top: 1px solid rgba(190, 224, 229, .13); }
#hud .sf-flight-control:first-of-type { border-top: 0; }
#hud .sf-flight-row { display: flex; align-items: center; justify-content: space-between; gap: 9px; }
#hud .sf-flight-label { color: rgba(226,255,247,.72); font-size: 10px; font-weight: 750; }
#hud .sf-flight-value { color: #eafff9; font-variant-numeric: tabular-nums; font-weight: 800; }
#hud .sf-gravity-range { width: 100%; margin: 8px 0 2px; accent-color: #9cebd8; cursor: pointer; }
#hud .sf-gravity-scale { display: flex; justify-content: space-between; color: rgba(211, 245, 240, .5); font-size: 9px; font-weight: 750; }
#hud .sf-flight-actions { display: flex; gap: 6px; flex-wrap: wrap; }
#hud .sf-flight-action {
  cursor: pointer;
  min-height: 28px;
  padding: 5px 9px;
  border: 1px solid rgba(173, 238, 224, .27);
  border-radius: 8px;
  background: rgba(255,255,255,.055);
  color: #e4fff8;
  transition: background .16s ease, border-color .16s ease;
}
#hud .sf-flight-action:hover { border-color: rgba(180, 255, 232, .72); background: rgba(150, 241, 218, .12); }
#hud .sf-flight-action.primary { flex: 1 1 118px; border-color: rgba(163, 243, 220, .55); background: linear-gradient(110deg, rgba(91, 196, 173, .22), rgba(157, 120, 232, .2)); font-weight: 800; }
#hud .sf-flight-action[disabled] { cursor: default; opacity: .42; }
#hud .sf-flight-camera { display: inline-flex; gap: 4px; }
#hud .sf-flight-camera button { border: 0; border-radius: 6px; padding: 4px 7px; background: transparent; color: rgba(217, 251, 243, .58); cursor: pointer; }
#hud .sf-flight-camera button[aria-pressed="true"] { background: rgba(145, 234, 212, .17); color: #dffff5; }
#hud .sf-flight-stats { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
#hud .sf-flight-stat { min-width: 0; padding: 7px 8px; border: 1px solid rgba(186, 224, 226, .12); border-radius: 9px; background: rgba(255,255,255,.035); }
#hud .sf-flight-stat .sf-stat-name { display: block; color: rgba(215, 249, 240, .5); font-size: 9px; font-weight: 750; text-transform: uppercase; letter-spacing: .08em; }
#hud .sf-flight-stat .sf-stat-value { display: block; overflow: hidden; margin-top: 2px; color: #eafff9; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-variant-numeric: tabular-nums; }
#hud .sf-flight-island { display: grid; gap: 5px; }
#hud .sf-flight-island-name { color: #edfff8; font-size: 12px; font-weight: 850; }
#hud .sf-flight-island-epithet { color: rgba(219, 248, 242, .62); font-size: 10px; font-style: italic; }
#hud .sf-flight-island-note { color: rgba(218, 250, 242, .73); font-size: 10px; line-height: 1.4; }
#hud .sf-flight-island-note.unknown { color: #c8b9f2; }
#hud .sf-flight-journal { display: grid; gap: 4px; }
#hud .sf-flight-journal-copy { color: rgba(225, 251, 243, .7); font-size: 10px; line-height: 1.45; }
#hud .sf-flight-journal-copy.empty { color: rgba(225, 251, 243, .48); }
#hud .sf-flight-journal-list { display: grid; gap: 4px; margin-top: 2px; }
#hud .sf-flight-journal-list details { border: 1px solid rgba(186, 224, 226, .12); border-radius: 8px; background: rgba(255,255,255,.03); }
#hud .sf-flight-journal-list summary { cursor: pointer; padding: 6px 8px; color: rgba(235, 255, 248, .88); font-size: 10px; font-weight: 800; list-style: none; }
#hud .sf-flight-journal-list summary::-webkit-details-marker { display: none; }
#hud .sf-flight-journal-list summary::before { content: "＋"; display: inline-block; width: 15px; color: #9cebd8; }
#hud .sf-flight-journal-list details[open] summary::before { content: "−"; }
#hud .sf-flight-journal-list details p { margin: 0; padding: 0 8px 8px 23px; color: rgba(225, 251, 243, .68); font-size: 10px; line-height: 1.45; }
#hud .sf-flight-hint { color: rgba(211, 245, 238, .54); font-size: 9px; line-height: 1.45; }
#hud .sf-flight-keys { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
#hud .sf-flight-key { display: inline-flex; align-items: center; min-height: 18px; padding: 1px 5px; border: 1px solid rgba(189, 229, 225, .26); border-radius: 5px; background: rgba(255,255,255,.06); color: rgba(235,255,249,.86); font-size: 9px; font-weight: 800; text-shadow: none; }
@media (max-width: 620px) {
  #hud .sf-sky-flight { right: 12px; bottom: calc(max(14px, env(safe-area-inset-bottom)) + 158px); width: min(326px, calc(100vw - 24px)); }
}
@media (max-height: 520px) {
  #hud .sf-sky-flight { bottom: max(12px, env(safe-area-inset-bottom)); }
  #hud .sf-flight-panel { max-height: calc(100vh - 64px); }
}
`;

function installStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function make<T extends HTMLElement>(tag: string, className?: string, text?: string): T {
  const element = document.createElement(tag) as T;
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function clampGravity(value: number | undefined): number {
  return Math.max(-1, Math.min(1, Number.isFinite(value) ? value! : 1));
}

function gravityCopy(value: number): string {
  if (value <= -0.82) return "Inverse gravity";
  if (value >= 0.82) return "Earth gravity";
  if (Math.abs(value) < 0.08) return "Free flight";
  return value < 0 ? "Light · inverse-leaning" : "Light · Earth-leaning";
}

function distanceCopy(distance: number | undefined): string {
  if (!Number.isFinite(distance)) return "—";
  const metres = Math.max(0, distance!);
  if (metres >= 1000) return `${(metres / 1000).toFixed(metres >= 10_000 ? 0 : 1)} km`;
  return `${Math.round(metres)} m`;
}

function readVisited(): Set<string> {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = value ? JSON.parse(value) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

class SkyFlightHUDImpl implements SkyFlightHUD {
  readonly #root: HTMLDivElement;
  readonly #panel: HTMLDivElement;
  readonly #launch: HTMLButtonElement;
  readonly #launchLabel: HTMLElement;
  readonly #launchMeta: HTMLElement;
  readonly #chevron: HTMLElement;
  readonly #enabled: HTMLInputElement;
  readonly #takeoff: HTMLButtonElement;
  readonly #gravity: HTMLInputElement;
  readonly #gravityValue: HTMLElement;
  readonly #altitude: HTMLElement;
  readonly #field: HTMLElement;
  readonly #islandDistance: HTMLElement;
  readonly #islandName: HTMLElement;
  readonly #islandEpithet: HTMLElement;
  readonly #islandNote: HTMLElement;
  readonly #travel: HTMLButtonElement;
  readonly #journalCount: HTMLElement;
  readonly #journalCopy: HTMLElement;
  readonly #journalList: HTMLElement;
  readonly #firstPerson: HTMLButtonElement;
  readonly #thirdPerson: HTMLButtonElement;
  readonly #callbacks: SkyFlightCallbacks;
  #open = false;
  #disposed = false;
  #state: SkyFlightState = { enabled: true, flying: false, altitude: 0, gravity: 1, camera: "third" };
  #visited = readVisited();
  #lastIsland: SkyFlightIsland | null = null;
  #catalog = new Map<string, SkyFlightIsland>();
  #lastJournal = "";
  #lastJournalKey = "";

  constructor(callbacks: SkyFlightCallbacks, host: HTMLElement) {
    this.#callbacks = callbacks;
    installStyles();

    this.#root = make<HTMLDivElement>("div", "sf-sky-flight");
    this.#root.setAttribute("aria-label", "Sky flight controls");

    this.#panel = make<HTMLDivElement>("div", "sf-flight-panel");
    this.#panel.hidden = true;
    this.#panel.setAttribute("aria-label", "Sky flight settings and status");
    const head = make<HTMLDivElement>("div", "sf-flight-head");
    const heading = make<HTMLDivElement>("div");
    heading.append(make<HTMLDivElement>("div", "sf-flight-kicker", "SKY FLIGHT"), make<HTMLDivElement>("div", "sf-flight-title", "Superman mode"));
    const enableLabel = make<HTMLLabelElement>("label", "sf-flight-enabled");
    this.#enabled = make<HTMLInputElement>("input");
    this.#enabled.type = "checkbox";
    this.#enabled.checked = true;
    this.#enabled.setAttribute("aria-label", "Enable sky flight");
    enableLabel.append(this.#enabled, document.createTextNode("available"));
    head.append(heading, enableLabel);
    this.#panel.appendChild(head);

    const actionControl = make<HTMLDivElement>("div", "sf-flight-control");
    const actionRow = make<HTMLDivElement>("div", "sf-flight-actions");
    this.#takeoff = make<HTMLButtonElement>("button", "sf-flight-action primary", "Take off");
    this.#takeoff.type = "button";
    actionRow.appendChild(this.#takeoff);
    const resetEarth = make<HTMLButtonElement>("button", "sf-flight-action", "Earth");
    resetEarth.type = "button";
    resetEarth.title = "Restore full Earth gravity";
    const resetZero = make<HTMLButtonElement>("button", "sf-flight-action", "Zero-g");
    resetZero.type = "button";
    resetZero.title = "Set gravity to free flight";
    actionRow.append(resetEarth, resetZero);
    actionControl.appendChild(actionRow);
    this.#panel.appendChild(actionControl);

    const gravityControl = make<HTMLDivElement>("div", "sf-flight-control");
    const gravityRow = make<HTMLDivElement>("div", "sf-flight-row");
    gravityRow.append(make<HTMLSpanElement>("span", "sf-flight-label", "Gravity field"));
    this.#gravityValue = make<HTMLSpanElement>("span", "sf-flight-value", "Earth gravity · 1.00 g");
    gravityRow.appendChild(this.#gravityValue);
    this.#gravity = make<HTMLInputElement>("input", "sf-gravity-range");
    this.#gravity.type = "range";
    this.#gravity.min = "-1";
    this.#gravity.max = "1";
    this.#gravity.step = "0.01";
    this.#gravity.value = "1";
    this.#gravity.setAttribute("aria-label", "Gravity field, from inverse gravity to Earth gravity");
    const scale = make<HTMLDivElement>("div", "sf-gravity-scale");
    scale.append(make<HTMLSpanElement>("span", undefined, "inverse"), make<HTMLSpanElement>("span", undefined, "float"), make<HTMLSpanElement>("span", undefined, "Earth"));
    gravityControl.append(gravityRow, this.#gravity, scale);
    this.#panel.appendChild(gravityControl);

    const cameraControl = make<HTMLDivElement>("div", "sf-flight-control");
    const cameraRow = make<HTMLDivElement>("div", "sf-flight-row");
    cameraRow.append(make<HTMLSpanElement>("span", "sf-flight-label", "View"));
    const camera = make<HTMLDivElement>("div", "sf-flight-camera");
    this.#thirdPerson = make<HTMLButtonElement>("button", undefined, "Third person");
    this.#firstPerson = make<HTMLButtonElement>("button", undefined, "First person");
    for (const button of [this.#thirdPerson, this.#firstPerson]) {
      button.type = "button";
      button.setAttribute("aria-pressed", "false");
    }
    camera.append(this.#thirdPerson, this.#firstPerson);
    cameraRow.appendChild(camera);
    cameraControl.appendChild(cameraRow);
    this.#panel.appendChild(cameraControl);

    const statsControl = make<HTMLDivElement>("div", "sf-flight-control");
    const stats = make<HTMLDivElement>("div", "sf-flight-stats");
    const altitudeStat = make<HTMLDivElement>("div", "sf-flight-stat");
    altitudeStat.append(make<HTMLSpanElement>("span", "sf-stat-name", "Altitude"));
    this.#altitude = make<HTMLSpanElement>("span", "sf-stat-value", "0 m");
    altitudeStat.appendChild(this.#altitude);
    const fieldStat = make<HTMLDivElement>("div", "sf-flight-stat");
    fieldStat.append(make<HTMLSpanElement>("span", "sf-stat-name", "Local field"));
    this.#field = make<HTMLSpanElement>("span", "sf-stat-value", "Earth");
    fieldStat.appendChild(this.#field);
    const islandDistanceStat = make<HTMLDivElement>("div", "sf-flight-stat");
    islandDistanceStat.append(make<HTMLSpanElement>("span", "sf-stat-name", "Nearest garden"));
    this.#islandDistance = make<HTMLSpanElement>("span", "sf-stat-value", "Scanning…");
    islandDistanceStat.appendChild(this.#islandDistance);
    stats.append(altitudeStat, fieldStat, islandDistanceStat);
    statsControl.appendChild(stats);
    this.#panel.appendChild(statsControl);

    const islandControl = make<HTMLDivElement>("div", "sf-flight-control sf-flight-island");
    this.#islandName = make<HTMLDivElement>("div", "sf-flight-island-name", "Sky garden signal");
    this.#islandEpithet = make<HTMLDivElement>("div", "sf-flight-island-epithet", "Search the cloudline for a path upward");
    this.#islandNote = make<HTMLDivElement>("div", "sf-flight-island-note unknown", "No island in range yet — follow the pointer when a signal appears.");
    const islandActions = make<HTMLDivElement>("div", "sf-flight-actions");
    const find = make<HTMLButtonElement>("button", "sf-flight-action", "Find the sky gardens");
    find.type = "button";
    this.#travel = make<HTMLButtonElement>("button", "sf-flight-action", "Travel to …");
    this.#travel.type = "button";
    this.#travel.hidden = true;
    islandActions.append(find, this.#travel);
    islandControl.append(this.#islandName, this.#islandEpithet, this.#islandNote, islandActions);
    this.#panel.appendChild(islandControl);

    const journalControl = make<HTMLDivElement>("div", "sf-flight-control sf-flight-journal");
    const journalHead = make<HTMLDivElement>("div", "sf-flight-row");
    journalHead.append(make<HTMLSpanElement>("span", "sf-flight-label", "Sky story"));
    this.#journalCount = make<HTMLSpanElement>("span", "sf-flight-value", "0 / 5 fragments");
    journalHead.appendChild(this.#journalCount);
    this.#journalCopy = make<HTMLDivElement>("div", "sf-flight-journal-copy empty", "Land on an island to add its first whisper to your journal.");
    this.#journalList = make<HTMLDivElement>("div", "sf-flight-journal-list");
    journalControl.append(journalHead, this.#journalCopy, this.#journalList);
    this.#panel.appendChild(journalControl);

    const hint = make<HTMLDivElement>("div", "sf-flight-hint", "WASD aim-relative · Space ascend · Q descend · Shift boost · G flight · C camera · Mouse / trackpad look");
    const keys = make<HTMLDivElement>("div", "sf-flight-keys");
    for (const key of ["W A S D", "Space", "Q", "Shift", "G", "C"]) keys.appendChild(make<HTMLSpanElement>("span", "sf-flight-key", key));
    this.#panel.append(hint, keys);

    // The composer owns a boot-safe stub with this id and removes that stub
    // after the lazy import resolves. Always create our own replacement so the
    // persistent affordance survives that handoff.
    this.#launch = make<HTMLButtonElement>("button", "sf-flight-launch");
    this.#launch.className = "sf-flight-launch";
    this.#launch.type = "button";
    this.#launch.replaceChildren();
    this.#launch.setAttribute("aria-expanded", "false");
    this.#launch.setAttribute("aria-controls", "sf-flight-panel");
    this.#launch.innerHTML = '<span class="sf-flight-wing" aria-hidden="true">✦</span>';
    const launchCopy = make<HTMLSpanElement>("span", "sf-launch-copy");
    this.#launchLabel = make<HTMLSpanElement>("b", undefined, "Flight controls");
    this.#launchMeta = make<HTMLSpanElement>("small", undefined, "Take off anywhere");
    launchCopy.append(this.#launchLabel, this.#launchMeta);
    this.#chevron = make<HTMLSpanElement>("span", "sf-flight-chevron", "⌃");
    this.#chevron.setAttribute("aria-hidden", "true");
    this.#launch.append(launchCopy, this.#chevron);
    this.#root.append(this.#panel, this.#launch);
    this.#panel.id = "sf-flight-panel";
    host.appendChild(this.#root);

    this.#enabled.addEventListener("change", () => {
      this.#callbacks.setEnabled?.(this.#enabled.checked);
      this.#callbacks.onFlightEnabledChange?.(this.#enabled.checked);
      this.#releasePointerLock();
    });
    this.#takeoff.addEventListener("click", () => {
      if (this.#callbacks.toggleFlight) this.#callbacks.toggleFlight();
      else if (this.#state.flying || this.#state.active) this.#callbacks.onLand?.();
      else if (this.#state.enabled !== false) this.#callbacks.onTakeoff?.();
      this.#releasePointerLock();
      this.close();
      this.#takeoff.blur();
    });
    this.#gravity.addEventListener("input", () => {
      const value = clampGravity(Number(this.#gravity.value));
      this.#setGravityText(value);
      this.#callbacks.setGravity?.(value);
      this.#callbacks.onGravityChange?.(value);
    });
    resetEarth.addEventListener("click", () => {
      this.#gravity.value = "1";
      this.#setGravityText(1);
      this.#callbacks.onResetEarth?.();
      this.#callbacks.setGravity?.(1);
      this.#callbacks.onGravityChange?.(1);
    });
    resetZero.addEventListener("click", () => {
      this.#gravity.value = "0";
      this.#setGravityText(0);
      this.#callbacks.onResetZero?.();
      this.#callbacks.setGravity?.(0);
      this.#callbacks.onGravityChange?.(0);
    });
    this.#thirdPerson.addEventListener("click", () => this.#chooseCamera("third"));
    this.#firstPerson.addEventListener("click", () => this.#chooseCamera("first"));
    find.addEventListener("click", () => {
      this.#callbacks.onFindSkyGardens?.();
      if (this.#lastIsland) this.#callbacks.navigate?.(this.#lastIsland.id);
      this.#islandNote.classList.remove("unknown");
      this.#islandNote.textContent = "Navigation pointer set — look for the mint shimmer on the horizon.";
      this.#releasePointerLock();
    });
    this.#travel.addEventListener("click", () => {
      if (this.#lastIsland) {
        this.#callbacks.travel?.(this.#lastIsland.id);
        this.#callbacks.onTravelToIsland?.(this.#lastIsland);
      }
      this.#releasePointerLock();
      this.close();
    });
    this.#launch.addEventListener("click", () => this.#setOpen(!this.#open));
    this.#root.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      this.#releasePointerLock();
    });
    this.#root.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Escape" && this.#open) {
        event.preventDefault();
        this.#setOpen(false);
      }
    }, true);

    this.#render(this.#state);
  }

  update(state: SkyFlightState) {
    if (this.#disposed) return;
    this.#state = { ...this.#state, ...state };
    this.#render(this.#state);
  }

  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#root.remove();
  }

  open() {
    if (!this.#disposed) this.#setOpen(true);
  }

  close() {
    if (!this.#disposed) this.#setOpen(false);
  }

  discover(island: SkyFlightIsland) {
    if (!island.id || this.#visited.has(island.id)) return;
    this.#visited.add(island.id);
    this.#callbacks.onDiscovered?.(island.id, this.#visited.size);
    this.#render({ ...this.#state, nearbyIsland: island });
  }

  discoveredIds(): readonly string[] {
    return [...this.#visited];
  }

  #setOpen(open: boolean) {
    if (this.#open === open) return;
    this.#open = open;
    this.#panel.hidden = !open;
    this.#launch.setAttribute("aria-expanded", String(open));
    this.#chevron.textContent = open ? "⌄" : "⌃";
    this.#callbacks.setPanelOpen?.(open);
    if (open) this.#callbacks.onFocus?.();
    else {
      this.#callbacks.onBlur?.();
      this.#releasePointerLock();
    }
  }

  #releasePointerLock() {
    this.#callbacks.onPointerLockChange?.(false);
  }

  #chooseCamera(camera: SkyFlightCamera) {
    if (this.#callbacks.onCameraChange) this.#callbacks.onCameraChange(camera);
    else this.#callbacks.cycleView?.();
    this.#thirdPerson.setAttribute("aria-pressed", String(camera === "third"));
    this.#firstPerson.setAttribute("aria-pressed", String(camera === "first"));
    this.#releasePointerLock();
  }

  #setGravityText(value: number) {
    this.#gravityValue.textContent = `${gravityCopy(value)} · ${value.toFixed(2)} g`;
  }

  #render(state: SkyFlightState) {
    const enabled = state.enabled !== false;
    const flying = !!state.flying || !!state.active;
    this.#enabled.checked = enabled;
    this.#takeoff.disabled = !enabled;
    this.#takeoff.textContent = flying ? "Land" : "Take off";
    this.#launchLabel.textContent = flying ? "In flight" : "Flight controls";
    this.#launchMeta.textContent = flying ? "Superman mode active" : enabled ? "Take off anywhere" : "Flight disabled";
    this.#altitude.textContent = `${Math.round(state.altitude ?? 0).toLocaleString("en-US")} m`;
    const gravity = clampGravity(state.gravity);
    this.#gravity.value = String(gravity);
    this.#setGravityText(gravity);
    this.#field.textContent = state.gravityField || state.currentGravityField || gravityCopy(gravity).replace(" gravity", "");
    const camera = state.camera ?? "third";
    this.#thirdPerson.setAttribute("aria-pressed", String(camera === "third"));
    this.#firstPerson.setAttribute("aria-pressed", String(camera === "first"));

    for (const entry of state.islands ?? []) {
      this.#catalog.set(entry.id, entry);
      if (entry.discovered && !this.#visited.has(entry.id)) this.#visited.add(entry.id);
    }
    const rawIsland = state.nearbyIsland ?? state.currentIsland ?? null;
    const island = rawIsland ? { ...(this.#catalog.get(rawIsland.id) ?? {}), ...rawIsland } : null;
    if (island && island.distance === undefined && island.center && state.position) {
      const dx = state.position.x - island.center.x;
      const dy = state.position.y - island.center.y;
      const dz = state.position.z - island.center.z;
      island.distance = Math.hypot(dx, dy, dz);
    }
    this.#lastIsland = island;
    this.#islandDistance.textContent = island ? distanceCopy(island.distance) : "Scanning…";
    if (!island) {
      this.#islandName.textContent = "Sky garden signal";
      this.#islandEpithet.textContent = "Search the cloudline for a path upward";
      this.#islandNote.className = "sf-flight-island-note unknown";
      this.#islandNote.textContent = "No island in range yet — follow the pointer when a signal appears.";
      this.#travel.hidden = true;
    } else {
      const islandName = island.label || island.name || "Unnamed sky garden";
      const discovered = !!island.discovered || this.#visited.has(island.id);
      if (discovered && !this.#visited.has(island.id)) {
        this.#visited.add(island.id);
      }
      this.#islandName.textContent = islandName;
      this.#islandEpithet.textContent = island.epithet || "A garden suspended between worlds";
      this.#islandNote.className = `sf-flight-island-note${discovered ? "" : " unknown"}`;
      if (discovered) {
        const story = island.story;
        const fragment = story?.fragment || story?.resolution || "The island remembers your arrival.";
        this.#islandNote.textContent = story?.title ? `${story.title} · ${fragment}` : fragment;
      } else {
        this.#islandNote.textContent = "Uncharted signal · land here to reveal what it is saying.";
      }
      this.#travel.hidden = false;
      this.#travel.textContent = `Travel to ${islandName}`;
    }

    const externalJournal = state.storyJournal || "";
    const islandStory = island && (island.discovered || this.#visited.has(island.id)) ? island.story?.fragment || island.story?.resolution || "" : "";
    const journal = externalJournal || islandStory;
    this.#journalCount.textContent = `${this.#visited.size} / 5 fragments`;
    if (journal !== this.#lastJournal) {
      this.#lastJournal = journal;
      this.#journalCopy.textContent = journal || "Land on an island to add its first whisper to your journal.";
      this.#journalCopy.classList.toggle("empty", !journal);
    }
    this.#renderJournal(externalJournal);
  }

  #renderJournal(externalJournal: string) {
    const entries = [...this.#catalog.values()]
      .filter((entry) => entry.discovered || this.#visited.has(entry.id))
      .sort((a, b) => (a.story?.order ?? 999) - (b.story?.order ?? 999));
    const key = `${externalJournal}|${entries.map((entry) => `${entry.id}:${entry.story?.title ?? ""}:${entry.story?.fragment ?? ""}:${entry.story?.resolution ?? ""}`).join("|")}`;
    if (key === this.#lastJournalKey) return;
    this.#lastJournalKey = key;
    this.#journalList.replaceChildren();
    for (const entry of entries) {
      const details = make<HTMLDetailsElement>("details");
      const summary = make<HTMLElement>("summary");
      const order = entry.story?.order;
      summary.textContent = `${order ? `${order} · ` : ""}${entry.story?.title || entry.label || entry.name || "Sky garden memory"}`;
      const fragment = entry.story?.fragment || entry.story?.resolution;
      if (fragment) details.append(summary, make<HTMLParagraphElement>("p", undefined, fragment));
      else details.append(summary);
      this.#journalList.appendChild(details);
    }
  }
}

/** Construct the persistent flight affordance. Import this module on first
 * flight interaction to keep the boot path free of optional UI code. */
export function createSkyFlightHUD(callbacks: SkyFlightCallbacks = {}, host: HTMLElement = document.getElementById("hud") ?? document.body): SkyFlightHUD {
  return new SkyFlightHUDImpl(callbacks, host);
}
