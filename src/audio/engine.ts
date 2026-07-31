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

/**
 * Where the muffle lands when the head is fully under. Water kills the high end
 * long before it kills the level, so this is mostly a filter move with a small
 * duck under it; 420 Hz keeps voices and music recognisable while making it
 * obvious your ears are underwater.
 */
const SUBMERGED_CUTOFF_HZ = 420;
const DRY_CUTOFF_HZ = 21000; // at/above Nyquist: a flat, effectively bypassed filter
const SUBMERGED_GAIN = 0.72;

export class AudioEngine {
  #ctx: AudioContext | null = null;
  #master!: GainNode;
  #groups!: Record<AudioGroupName, GainNode>;
  #levels: Record<AudioGroupName, number> = { music: 0, effects: 0, world: 0, voice: 0 };
  /** Submerged bus: everything except voice chat goes through the muffle. */
  #wet!: GainNode;
  #muffle!: BiquadFilterNode;
  #submersionTarget = 0;
  #submersion = 0;
  /**
   * Open-mic duck on everything the world makes. While the local mic is live,
   * our own output is not just "the mix" — it is loudspeaker spill, on its way
   * back into the microphone, where the browser's echo canceller has to strip
   * it out of what the far end hears. Sustained tonal beds are the worst case
   * an AEC can be handed: the hoverboard hum sits at 59/117 Hz and is the
   * loudest single component in the mix while riding, a laptop speaker
   * reproduces that much sub-bass NONLINEARLY, and an AEC can only model a
   * linear echo path — so the residue it cannot cancel lands on the far end as
   * crackle. Voice is deliberately exempt: ducking the conversation to protect
   * the conversation is self-defeating (see net/voice.ts).
   */
  #micDuck = 1;
  #unlocked = false;
  #hold = 0;
  // Persistent activity holds keep the context running only while the page is
  // visible. Page suspension wins over them, but not over a background hold.
  #persistent = 0;
  // Background holds are the one exemption: while any is live a hidden page
  // keeps the graph running with ONLY the voice group audible (see
  // #groupTargets). Voice chat is the sole holder — a conversation should
  // survive tabbing away; diegetic performers and world ambience should not.
  #background = 0;
  #pageVisible = typeof document === "undefined" || document.visibilityState === "visible";

  #onVisibilityChange = () => {
    this.#pageVisible = document.visibilityState === "visible";
    this.#syncSuspension();
  };

  /** Group gains for the current visibility/background state. */
  #groupTargets(): Record<AudioGroupName, number> {
    if (this.#pageVisible) {
      return {
        music: musicAudioLevel() * this.#micDuck,
        effects: effectsAudioLevel() * this.#micDuck,
        world: soundscapeAudioLevel() * this.#micDuck,
        voice: voiceAudioLevel()
      };
    }
    // Hidden: everything the world makes is silence. Voice survives — at its
    // normal level, because a ducked conversation is just a worse conversation.
    return { music: 0, effects: 0, world: 0, voice: this.#background > 0 ? voiceAudioLevel() : 0 };
  }

  #wantRunning(): boolean {
    if (!this.#pageVisible) return this.#background > 0;
    return this.#hold > 0 || this.#persistent > 0;
  }

  /**
   * Move the context and the mix across a visibility (or background-hold) edge.
   *
   * update() is driven by the rendered frame loop, which is parked while the
   * page is hidden, so while hidden this edge has to set the mix itself —
   * nothing else will run until the page comes back. While visible, update()
   * still owns the mix: it eases levels instead of jumping them, so tabbing
   * back fades the world in rather than slamming it on.
   */
  #syncSuspension(): void {
    const ctx = this.#ctx;
    if (!ctx || ctx.state === "closed") return;
    if (!this.#wantRunning()) {
      // Suspending the context halts the entire Web Audio graph, including
      // oscillators, analysers, media-stream nodes and scheduled automation.
      if (ctx.state === "running") void ctx.suspend();
      return;
    }
    if (this.#unlocked && ctx.state === "suspended") void ctx.resume();
    // Only re-target a genuinely running graph: a ramp scheduled onto a frozen
    // timeline never completes, and #levels would then disagree with the gains
    // the graph actually holds.
    if (this.#pageVisible || ctx.state !== "running") return;
    const targets = this.#groupTargets();
    for (const g of GROUPS) {
      this.#levels[g] = targets[g];
      this.#groups[g].gain.setTargetAtTime(targets[g], ctx.currentTime, 0.05);
    }
  }

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
      background: this.#background,
      micDuck: +this.#micDuck.toFixed(3),
      pageVisible: this.#pageVisible,
      submersion: +this.#submersion.toFixed(3)
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

  /**
   * A persistent hold that ALSO survives page suspension, for the one feature
   * that has to keep sounding out of frame: voice chat. While one is live a
   * hidden page keeps the context running and mixes every non-voice group to
   * silence rather than freezing the graph. Everything else uses acquireHold.
   */
  acquireBackgroundHold(): () => void {
    this.#persistent++;
    this.#background++;
    this.#syncSuspension();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#persistent = Math.max(0, this.#persistent - 1);
      this.#background = Math.max(0, this.#background - 1);
      this.#syncSuspension();
    };
  }

  /**
   * How far to pull the world down while the local microphone is live; 1 while
   * it is off. Voice owns the policy and the number (net/voice.ts), the engine
   * owns the mix, so this is a plain setter — update() eases the group gains
   * toward it, which is what makes turning the mic on a fade rather than a step.
   */
  setMicDuck(factor: number): void {
    this.#micDuck = factor > 0 ? (factor < 1 ? factor : 1) : 0;
  }

  /** Advance group gains, the idle-suspend policy, and the listener once/frame. */
  update(dt: number, camera: { matrixWorld: unknown } | null): void {
    const ctx = this.#ctx;
    if (!ctx) return;

    this.#hold = Math.max(0, this.#hold - dt);
    const wantRunning = this.#wantRunning();
    const targets = this.#groupTargets();

    const running = ctx.state === "running";
    for (const g of GROUPS) {
      const target = targets[g];
      const level = approach(this.#levels[g], target, dt, target > 0 ? 8 : 14);
      this.#levels[g] = level;
      if (running) this.#groups[g].gain.setTargetAtTime(level, ctx.currentTime, 0.025);
    }

    // Ears go under faster than they come back up — the crossing should land as
    // a lid closing, and the surfacing as a lift rather than a pop.
    const wasSubmerged = this.#submersion;
    this.#submersion = approach(
      this.#submersion,
      this.#submersionTarget,
      dt,
      this.#submersionTarget > this.#submersion ? 9 : 6
    );
    if (this.#submersion < 0.0005) this.#submersion = 0;
    if (running && (this.#submersion > 0 || wasSubmerged > 0)) {
      // Cutoff sweeps geometrically: a linear ramp spends most of its travel in
      // frequencies nobody can hear moving.
      const cutoff = DRY_CUTOFF_HZ * Math.pow(SUBMERGED_CUTOFF_HZ / DRY_CUTOFF_HZ, this.#submersion);
      this.#muffle.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.05);
      this.#wet.gain.setTargetAtTime(
        1 + (SUBMERGED_GAIN - 1) * this.#submersion,
        ctx.currentTime,
        0.05
      );
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

    // group gains (start silent) → [muffle for everything but voice] → master → out
    this.#master = ctx.createGain();
    this.#master.gain.value = 1;
    this.#master.connect(ctx.destination);

    // One shared lowpass, permanently installed and parked at Nyquist so it is
    // audibly a straight wire while dry. Reconnecting the graph on the surface
    // crossing instead would click, and a per-feature filter would need every
    // voice in the app to know about water.
    this.#muffle = ctx.createBiquadFilter();
    this.#muffle.type = "lowpass";
    this.#muffle.frequency.value = DRY_CUTOFF_HZ;
    this.#muffle.Q.value = 0.55;
    this.#wet = ctx.createGain();
    this.#wet.gain.value = 1;
    this.#muffle.connect(this.#wet);
    this.#wet.connect(this.#master);

    this.#groups = {
      music: ctx.createGain(),
      effects: ctx.createGain(),
      world: ctx.createGain(),
      voice: ctx.createGain()
    };
    for (const g of GROUPS) {
      this.#groups[g].gain.value = 0;
      // Voice chat stays dry: muffling other players is a comprehension cost
      // with no payoff — their radio is not in the water with you.
      this.#groups[g].connect(g === "voice" ? this.#master : this.#muffle);
    }
    return ctx;
  }

  /**
   * 0 = head in air, 1 = fully submerged. Smoothed in `update`, so callers can
   * hand over a raw per-frame state (fx/underwaterRig's eased submersion).
   */
  setSubmersion(amount: number): void {
    this.#submersionTarget = amount > 0 ? (amount < 1 ? amount : 1) : 0;
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
