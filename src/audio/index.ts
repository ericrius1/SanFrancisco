// Nature soundscape — public surface.
//
// A modular, multi-region procedural ambient audio layer. Hand it the player
// position, camera, the shared wind-gust value, and the time of day each frame;
// it fades sampled beds + a procedural wind synth + spatial animal calls in and
// out as the listener moves through the Botanical Garden, Golden Gate Park, the
// Presidio, Marin, and any future nature area. To add a region, append one entry
// to NATURE_REGIONS in ./regions — the engine is generic over the list.
//
//   const nature = createNatureSoundscape();
//   // per frame:
//   nature.update(dt, { playerPos, camera, gust: windGustValue(), timeOfDay: sky.timeOfDay });

import { NatureSoundscape } from "./natureSoundscape";

export function createNatureSoundscape(): NatureSoundscape {
  return new NatureSoundscape();
}

export { NatureSoundscape, NATURE_AUDIO_TUNING } from "./natureSoundscape";
export { NATURE_REGIONS } from "./regions";
export type { NatureRegionSpec, BedId, VoiceWeight } from "./regions";
export type { NatureVoiceKind } from "./voices";
export { DogParkAudio } from "./dogPark";
export type { DogAudioCue, DogParkDog } from "./dogPark";
export { BallImpactAudio, BALL_IMPACT_AUDIO_TUNING } from "./ballImpactAudio";
