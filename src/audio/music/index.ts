// Lo-fi music — public surface.
//
// A fully generative ambient score that covers the whole map: lo-fi e-piano
// chords, pads, sub bass and pentatonic sparkles over vinyl crackle and tape
// wow, region-flavoured and day/night aware. This facade keeps the boot bundle
// clean: the director (and its WebAudio graph + worker buffers) dynamic-imports
// on the first frame where audio is unlocked, the arrival reveal has settled,
// and the HUD music slider is audible.
//
//   const lofiMusic = createLofiMusic();
//   // per frame:
//   lofiMusic.update(dt, { playerPos, timeOfDay: sky.timeOfDay, allowStart: !worldArrival.active });

import { audioEngine } from "../engine";
import { musicAudioLevel } from "../../core/audioSettings";
import type { LofiMusicDirector, MusicFrameInput } from "./director";

export class LofiMusicHandle {
  #director: LofiMusicDirector | null = null;
  #loading = false;

  update(dt: number, o: MusicFrameInput & { allowStart?: boolean }): void {
    if (!this.#director) {
      // Optional feature: nothing loads until the score could actually sound.
      if (this.#loading || o.allowStart === false) return;
      if (!audioEngine.unlocked || musicAudioLevel() <= 0.001) return;
      this.#loading = true;
      void import("./director")
        .then((m) => {
          this.#director = new m.LofiMusicDirector();
        })
        .catch((error) => {
          console.warn("[lofi-music] failed to load:", error);
        });
      return;
    }
    this.#director.update(dt, o);
  }

  get debugState(): Record<string, unknown> {
    return this.#director?.debugState ?? { ctx: "unloaded" };
  }

  dispose(): void {
    this.#director?.dispose();
    this.#director = null;
  }
}

export function createLofiMusic(): LofiMusicHandle {
  return new LofiMusicHandle();
}

export type { MusicFrameInput } from "./director";
