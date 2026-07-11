import type * as THREE from "three/webgpu";

/**
 * Busker trio — shared contracts.
 *
 * Three seated musicians (ukulele / handpan / flute) perched on a flat-topped
 * chert boulder (see ./perchRock.ts), playing one authored song together (see
 * ./song.ts), then resting in the wind between passes. The module is fully
 * self-positioned: nothing in here knows about Corona Heights or any other
 * landmark — `createBuskerTrio` takes a world position and can be re-placed
 * later with `setPlacement`.
 *
 * Conventions (match player/rig.ts):
 *  - A musician's group origin is their SEAT POINT: the spot on the rock's flat
 *    top under their hips. +Y up. They face local -Z (game front), legs
 *    dangling over the rock's -Z front lip.
 *  - Limbs hang along -Y; rotation.x > 0 swings a limb toward -Z (forward);
 *    knees bend with negative x, elbows with positive x.
 *  - Units are metres; a standing figure is ~1.65 m.
 */

export type BuskerId = "ukulele" | "handpan" | "flute";

/** One scheduled note (or strummed chord) in a part. Times are in BEATS from
 * song start — the transport maps beats onto the AudioContext clock. */
export type NoteEvent = {
  /** onset, beats from song start */
  beat: number;
  /** nominal duration in beats (synths may ring longer, e.g. handpan decay) */
  dur: number;
  /** MIDI note numbers. Single-element for melodic parts; strummed chords
   * list every string in physical strum order (down-strum order; reverse
   * for an up-strum). */
  midis: number[];
  /** 0..1 accent — scale the voice's peak gain by this */
  vel: number;
  /** part-specific flavor: "ding" | "tone" (handpan), "down" | "up" |
   * "arpeggio" (ukulele). Melodic parts leave it unset. */
  tag?: string;
};

export type TrioPhase = "playing" | "rest" | "countin";

/** Read-only per-frame clock handed to every musician's update(). */
export type TrioClock = {
  phase: TrioPhase;
  /** seconds since the current phase began */
  phaseTime: number;
  /** seconds into the song (only advances during "playing"; holds at the
   * song end through rest/countin) */
  songTime: number;
  /** fractional beat into the song (songTime / secPerBeat) */
  beat: number;
  /** shared wind sway 0..1 — same signal the foliage bends to, so all three
   * musicians (hair, hood strings, swaying) move coherently with the grass */
  wind: number;
};

/** Per-musician audio tap. The core owns the context, the spatial panner
 * chain and the master (user-volume) gain — a musician only connects voices
 * to `out` and scales gains by NoteEvent.vel. NEVER create an AudioContext
 * (the app is near the browser's context budget) and never connect to
 * ctx.destination directly.
 *
 * IMPORTANT: only touch `ctx`/`out` inside schedule() — build any persistent
 * synth state (noise buffers, shared filters) lazily on the first schedule()
 * call. In audio-less environments (headless tests, unsupported browsers)
 * these fields are null and schedule() is simply never invoked. */
export type MusicianAudio = {
  ctx: AudioContext;
  out: GainNode;
  /** Wet send into the shared "off the mountains" convolution reverb. Connect
   * a fraction of a voice here (in parallel with `out`) to give it a tail;
   * the flute leans on this for its airy alpine echo. Same lifetime rules as
   * `out`. Null only in audio-less contexts (where schedule() never runs). */
  reverb: GainNode;
};

export interface Musician {
  /** Seated figure + instrument. Origin/orientation per the seat convention
   * documented above. */
  group: THREE.Group;
  /**
   * Per-frame procedural animation. Runs in every phase (playing, rest,
   * countin) — even when the audio context is suspended or muted, the body
   * keeps performing. Distance-gated by the core (~200 m).
   */
  update(dt: number, clock: TrioClock): void;
  /**
   * Schedule audio voices for `events` (a slice of this musician's part whose
   * onsets fall inside the transport's lookahead window — each event is
   * delivered exactly once per song pass). `atTime(beat)` converts a beat to
   * an AudioContext timestamp. Only called while the context is running and
   * the trio is audible/playing. Voices must self-clean: stop() every source
   * and disconnect the voice's subgraph in an `onended` handler.
   */
  schedule(events: NoteEvent[], atTime: (beat: number) => number): void;
  /**
   * Swap in a different song's part (Q cycles the songbook). Called while the
   * transport is outside "playing" — rebuild any part-derived state (cursors,
   * choreography maps) so the next pass animates the new score.
   */
  setPart(part: NoteEvent[]): void;
  /** Remove/disconnect everything this musician created. Do NOT dispose
   * geometries from player/rig.ts's shared cache. */
  dispose(): void;
}

/** Every musician module exports one of these; the core calls it with the
 * musician's audio tap and their own part from the song score. */
export type MusicianBuilder = (audio: MusicianAudio, part: NoteEvent[]) => Musician;

/**
 * Cursor over one part's events for ANIMATION (audio scheduling is handled
 * by the core). Cheap monotonic scan — call `at(beat)` once per frame with
 * the clock's beat; call `reset()` when the song loops (beat jumps down).
 */
export class NoteCursor {
  #events: NoteEvent[];
  #idx = 0;

  constructor(events: NoteEvent[]) {
    this.#events = events;
  }

  reset() {
    this.#idx = 0;
  }

  /** Latest event with onset <= beat (null before the first note), plus the
   * next upcoming event (null after the last). Handles the loop's beat reset
   * automatically. */
  at(beat: number): { current: NoteEvent | null; next: NoteEvent | null } {
    const ev = this.#events;
    if (this.#idx > 0 && ev[this.#idx - 1] && ev[this.#idx - 1].beat > beat) this.#idx = 0; // looped
    while (this.#idx < ev.length && ev[this.#idx].beat <= beat) this.#idx++;
    return {
      current: this.#idx > 0 ? ev[this.#idx - 1] : null,
      next: this.#idx < ev.length ? ev[this.#idx] : null
    };
  }
}

/** midi → frequency in Hz (A4 = 69 = 440). */
export function midiHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
