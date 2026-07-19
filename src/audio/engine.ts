/**
 * The app's single AudioContext and its four group buses.
 *
 * Every audio feature used to own a context; the browser's context budget
 * couldn't take ten of them. This engine owns the one context, the gesture
 * unlock, group-volume smoothing against the HUD mixer, the visibility/idle
 * suspend policy, and the ctx.listener camera track. Features keep their own
 * sonic character (their compressors/filters) but plug into a group input and
 * stop owning any of the above.
 */

import {
  musicAudioLevel,
  effectsAudioLevel,
  soundscapeAudioLevel,
  voiceAudioLevel
} from "../core/audioSettings";

export type AudioGroupName = "music" | "effects" | "world" | "voice";
export type EngineBus = { ctx: AudioContext; input: GainNode };

const GROUPS: AudioGroupName[] = ["music", "effects", "world", "voice"];

const approach = (current: number, target: number, dt: number, rate: number) =>
  current + (target - current) * Math.min(1, dt * rate);

export class AudioEngine {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #groups!: Record<AudioGroupName, GainNode>;
  #levels: Record<AudioGroupName, number> = { music: 0, effects: 0, world: 0, voice: 0 };
  #unlocked = false;
  #hold = 0;
  // Persistent activity holds keep the context running only while the page is
  // visible. Page suspension always wins over every feature hold.
  #persistent = 0;
  #pageVisible = typeof document === "undefined" || document.visibilityState === "visible";

  #onVisibilityChange = () => {
    this.#pageVisible = document.visibilityState === "visible";
    const ctx = this.#ctx;
    if (!ctx || ctx.state === "closed") return;
    if (!this.#pageVisible) {
      // Suspending the context halts the entire Web Audio graph, including
      // oscillators, analysers, media-stream nodes and scheduled automation.
      if (ctx.state === "running") void ctx.suspend();
      return;
    }
    if (this.#unlocked && (this.#hold > 0 || this.#persistent > 0) && ctx.state === "suspended") {
      void ctx.resume();
    }
  };

  constructor() {
    // Guarded so Node audio probes can import feature modules without a window.
    if (typeof window === "undefined") return;
    const unlock = () => {
      this.#unlocked = true;
      const ctx = this.#ensure();
      if (this.#pageVisible && ctx?.state === "suspended") void ctx.resume();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("touchstart", unlock);
    };
    window.addEventListener("pointerdown", unlock, { passive: true });
    window.addEventListener("keydown", unlock);
    window.addEventListener("touchstart", unlock, { passive: true });
    document.addEventListener("visibilitychange", this.#onVisibilityChange);
  }

  get unlocked(): boolean {
    return this.#unlocked;
  }

  get debugState() {
    return {
      ctx: this.#ctx?.state ?? "none",
      unlocked: this.#unlocked,
      levels: {
        music: +this.#levels.music.toFixed(3),
        effects: +this.#levels.effects.toFixed(3),
        world: +this.#levels.world.toFixed(3),
        voice: +this.#levels.voice.toFixed(3)
      },
      hold: +this.#hold.toFixed(3),
      persistent: this.#persistent,
      pageVisible: this.#pageVisible
    };
  }

  /** Build the empty context/graph under the loading cover; may sit suspended. */
  prewarm(): void {
    this.#ensure();
  }

  /** Force the normal browser gate open for headless audio probes. */
  async unlock(): Promise<void> {
    const ctx = this.#ensure();
    if (!ctx) return;
    this.#unlocked = true;
    if (this.#pageVisible) await ctx.resume().catch(() => {});
  }

  /**
   * A group input to plug a feature graph into. Null until the first gesture —
   * consumers already tolerate that (same contract as voiceBus()).
   */
  bus(group: AudioGroupName, holdSeconds = 0.8): EngineBus | null {
    if (!this.#unlocked) return null;
    const ctx = this.#ensure();
    if (!ctx) return null;
    this.touch(holdSeconds);
    if (this.#pageVisible && ctx.state === "suspended") void ctx.resume();
    return { ctx, input: this.#groups[group] };
  }

  /**
   * A group input for building graphs/buffers under the loading cover BEFORE the
   * first gesture. Exists ONLY for prewarm: unlike bus() there is no unlocked
   * gate and no touch/resume. Creation is allowed pre-gesture, audibility is not
   * — group gains start at 0 and the ctx sits suspended until unlock, so nothing
   * built through this can sound. Runtime code that wants audibility uses bus().
   */
  prewarmBus(group: AudioGroupName): EngineBus | null {
    const ctx = this.#ensure();
    if (!ctx) return null;
    return { ctx, input: this.#groups[group] };
  }

  /** Keep the shared context alive long enough for a newly scheduled tail. */
  touch(seconds = 0.8): void {
    this.#hold = Math.max(this.#hold, seconds);
  }

  /**
   * A persistent hold for a sustained activity. The returned release fn is
   * idempotent. Visibility suspension always overrides persistent holds.
   */
  acquireHold(): () => void {
    this.#persistent++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#persistent = Math.max(0, this.#persistent - 1);
    };
  }

  /** Advance group gains, the idle-suspend policy, and the listener once/frame. */
  update(dt: number, camera: { matrixWorld: unknown } | null): void {
    const ctx = this.#ctx;
    if (!ctx) return;

    const visible = this.#pageVisible;
    this.#hold = Math.max(0, this.#hold - dt);
    const wantRunning = visible && (this.#hold > 0 || this.#persistent > 0);

    const vis = visible ? 1 : 0;
    const targets: Record<AudioGroupName, number> = {
      music: musicAudioLevel() * vis,
      effects: effectsAudioLevel() * vis,
      world: soundscapeAudioLevel() * vis,
      voice: voiceAudioLevel() * vis
    };

    const running = ctx.state === "running";
    for (const g of GROUPS) {
      const target = targets[g];
      const level = approach(this.#levels[g], target, dt, target > 0 ? 8 : 14);
      this.#levels[g] = level;
      if (running) this.#groups[g].gain.setTargetAtTime(level, ctx.currentTime, 0.025);
    }

    if (running) {
      // Mixer levels express how loud a group should be when it has content;
      // they are not evidence that any source is active. Using them as the idle
      // test kept the render thread alive forever whenever a slider was nonzero.
      // Scheduled tails call touch(), and sustained layers own a persistent
      // hold, so those two signals are the authoritative activity contract.
      if (this.#unlocked && !wantRunning) void ctx.suspend();
    } else if (this.#unlocked && wantRunning) {
      void ctx.resume();
    }

    if (camera) this.#updateListener(ctx, camera);
  }

  dispose(): void {
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.#onVisibilityChange);
    }
    const ctx = this.#ctx;
    if (ctx && ctx.state !== "closed") void ctx.close();
    this.#ctx = null;
  }

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null; // Node probes
    const ctx = new AudioContext();
    this.#ctx = ctx;
    if (!this.#pageVisible && ctx.state === "running") void ctx.suspend();

    // group gains (start silent) → master (reserved for future global fades) → out
    this.#master = ctx.createGain();
    this.#master.gain.value = 1;
    this.#master.connect(ctx.destination);

    this.#groups = {
      music: ctx.createGain(),
      effects: ctx.createGain(),
      world: ctx.createGain(),
      voice: ctx.createGain()
    };
    for (const g of GROUPS) {
      this.#groups[g].gain.value = 0;
      this.#groups[g].connect(this.#master);
    }
    return ctx;
  }

  /**
   * The one ctx.listener track. Decoded straight from the camera's world matrix
   * (position + basis columns) so this module stays THREE-free; the damping
   * constants match the old per-feature listener.
   */
  #updateListener(ctx: AudioContext, camera: { matrixWorld: unknown }): void {
    const e = (camera.matrixWorld as { elements?: ArrayLike<number> } | undefined)?.elements;
    if (!e) return;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    // forward = -Z basis column, up = +Y basis column (camera matrices unit-scaled)
    let fx = -e[8];
    let fy = -e[9];
    let fz = -e[10];
    let ux = e[4];
    let uy = e[5];
    let uz = e[6];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;

    // Teleports can leave the camera matrix non-finite for a frame; AudioParam
    // setters throw on non-finite values, so skip the update until it settles.
    if (!Number.isFinite(px + py + pz + fx + fy + fz + ux + uy + uz)) return;

    const l = ctx.listener;
    if (l.positionX) {
      const t = ctx.currentTime;
      l.positionX.setTargetAtTime(px, t, 0.02);
      l.positionY.setTargetAtTime(py, t, 0.02);
      l.positionZ.setTargetAtTime(pz, t, 0.02);
      l.forwardX.setTargetAtTime(fx, t, 0.02);
      l.forwardY.setTargetAtTime(fy, t, 0.02);
      l.forwardZ.setTargetAtTime(fz, t, 0.02);
      l.upX.setTargetAtTime(ux, t, 0.05);
      l.upY.setTargetAtTime(uy, t, 0.05);
      l.upZ.setTargetAtTime(uz, t, 0.05);
    } else {
      // deprecated Safari path
      (l as unknown as { setPosition(x: number, y: number, z: number): void }).setPosition(px, py, pz);
      (l as unknown as { setOrientation(...a: number[]): void }).setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }
}

export const audioEngine = new AudioEngine();
