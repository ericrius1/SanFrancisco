// Instrument registry + the weighted draw that turns a region's palette into a
// concrete voice for one gesture.
//
// Blending discrete timbres is the whole trick behind regional identity: the
// director averages the weight maps across region influence, so standing on the
// line between the Mission and the Castro hears nylon guitar and felt piano
// trading gestures rather than one snapping into the other.

import { BASS_VOICES } from "./bass";
import { KEYS_VOICES } from "./keys";
import { PAD_VOICES } from "./pads";
import { SPARKLE_VOICES } from "./sparkle";
import type {
  BassVoiceId,
  KeysVoiceId,
  PadVoiceId,
  SparkleVoiceId,
  Voice,
  VoiceMix
} from "../voiceTypes";
import {
  BASS_VOICE_IDS,
  KEYS_VOICE_IDS,
  PAD_VOICE_IDS,
  SPARKLE_VOICE_IDS
} from "../voiceTypes";

export { BASS_VOICES, KEYS_VOICES, PAD_VOICES, SPARKLE_VOICES };

/** Weighted pick from a blended mix. Falls back to the family's first id when a
 *  mix is empty or all-zero, so a malformed profile still makes sound. */
export function pickVoice<Id extends string>(
  mix: VoiceMix<Id>,
  ids: readonly Id[],
  rng: () => number
): Id {
  let total = 0;
  for (const id of ids) total += Math.max(0, mix[id] ?? 0);
  if (total <= 0) return ids[0];
  let r = rng() * total;
  for (const id of ids) {
    r -= Math.max(0, mix[id] ?? 0);
    if (r <= 0) return id;
  }
  return ids[0];
}

export const pickKeysVoice = (mix: VoiceMix<KeysVoiceId>, rng: () => number): KeysVoiceId =>
  pickVoice(mix, KEYS_VOICE_IDS, rng);
export const pickPadVoice = (mix: VoiceMix<PadVoiceId>, rng: () => number): PadVoiceId =>
  pickVoice(mix, PAD_VOICE_IDS, rng);
export const pickBassVoice = (mix: VoiceMix<BassVoiceId>, rng: () => number): BassVoiceId =>
  pickVoice(mix, BASS_VOICE_IDS, rng);
export const pickSparkleVoice = (
  mix: VoiceMix<SparkleVoiceId>,
  rng: () => number
): SparkleVoiceId => pickVoice(mix, SPARKLE_VOICE_IDS, rng);

export const keysVoice = (id: KeysVoiceId): Voice => KEYS_VOICES[id];
export const padVoice = (id: PadVoiceId): Voice => PAD_VOICES[id];
export const bassVoice = (id: BassVoiceId): Voice => BASS_VOICES[id];
export const sparkleVoice = (id: SparkleVoiceId): Voice => SPARKLE_VOICES[id];
