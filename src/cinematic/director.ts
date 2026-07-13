import type { DemoContext } from "../dev/demo";
import { ShotCamera } from "./camera";
import { CinematicOverlay } from "./overlay";
import type { CinematicCue, CinematicFrameState, CinematicShot, OverlayCue } from "./types";

export type CinematicDefinition = {
  name: string;
  duration: number;
  shots: readonly CinematicShot[];
  cues?: readonly CinematicCue[];
  overlay?: readonly OverlayCue[];
  letterbox?: number;
  /** Runs once after the director is installed and before frame zero. */
  begin?: () => void;
  /** Runs once per rendered frame after timeline cues, before the camera pose. */
  frame?: (time: number, dt: number) => void;
};

export type CinematicWindow = Window &
  typeof globalThis & {
    __cineT?: number;
    __sfReelArmed?: boolean;
    __sfReelDone?: boolean;
    __sfReelStep?: (seconds: number) => void;
    __sfStartShot?: () => void;
    __sfCinematicState?: CinematicFrameState;
    __sfCinematicReport?: () => unknown;
  };

/**
 * Arms one deterministic cinematic against the app's existing fixed-step loop.
 * The browser renderer remains the single owner of WebGPU resources; this layer
 * only supplies virtual time, authored actions, physical camera poses and
 * frame-readable diagnostics for the capture harness.
 */
export function armCinematic(ctx: DemoContext, definition: CinematicDefinition) {
  const win = window as CinematicWindow;
  const query = new URLSearchParams(location.search);
  const manual = query.has("manual");
  const hold = query.has("hold");
  const camera = new ShotCamera({
    name: definition.name,
    duration: definition.duration,
    camera: ctx.camera,
    map: ctx.map,
    worldQueries: ctx.worldQueries,
    shots: definition.shots
  });
  // Film chrome is opt-in. A transparent canvas still exists for the fast
  // compositor, but clean-plate productions get no bars, cards, text or meter.
  const overlayEnabled = Boolean(definition.overlay?.length);
  const overlay = new CinematicOverlay(
    definition.name,
    definition.overlay ?? [],
    overlayEnabled ? definition.letterbox : 0,
    overlayEnabled
  );
  const cues = [...(definition.cues ?? [])].sort((a, b) => a.at - b.at);
  const fired = new Set<string>();
  let previous = -1e-6;
  let started = !manual && !hold;

  const runCues = (time: number) => {
    // Backward seeks reset cue bookkeeping. Stateful simulations should still be
    // replayed from zero by the capture harness; this makes browser scrubbing sane.
    if (time + 1e-6 < previous) fired.clear();
    for (const cue of cues) {
      if (fired.has(cue.id) || cue.at > time + 1e-7) continue;
      cue.run();
      fired.add(cue.id);
    }
    previous = time;
  };

  const step = (time: number, dt: number) => {
    const clamped = Math.min(definition.duration, Math.max(0, time));
    runCues(clamped);
    definition.frame?.(clamped, dt);
    const state = camera.apply(clamped);
    overlay.update(clamped, definition.duration, state.shot);
    win.__sfCinematicState = state;
    win.__sfReelDone = clamped >= definition.duration;
  };

  definition.begin?.();
  win.__cineT = 0;
  win.__sfReelArmed = true;
  win.__sfReelDone = false;
  step(0, 0);

  ctx.setCine((dt) => {
    if (!manual && started) win.__cineT = Math.min(definition.duration, (win.__cineT ?? 0) + dt);
    step(win.__cineT ?? 0, dt);
  });

  win.__sfReelStep = (seconds) => {
    win.__cineT = Math.min(definition.duration, Math.max(0, seconds));
  };
  win.__sfStartShot = () => {
    win.__cineT = 0;
    previous = -1e-6;
    fired.clear();
    started = true;
  };
  win.__sfCinematicReport = () => ({
    name: definition.name,
    duration: definition.duration,
    shots: camera.shots.map(({ id, start, end }) => ({ id, start, end })),
    cameraAudit: camera.audit,
    state: win.__sfCinematicState ?? null
  });

  if (!manual && !hold) win.__sfStartShot();
  if (camera.audit.issues.length) {
    console.warn(`[cinematic:${definition.name}] camera preflight found ${camera.audit.issues.length} issue(s)`, camera.audit.issues);
  } else {
    console.info(`[cinematic:${definition.name}] camera preflight clean (${camera.audit.samples} samples)`);
  }

  return { camera, overlay };
}
