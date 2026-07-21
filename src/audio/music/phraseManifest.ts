// Baked phrase palette — contract between tools/music/render_phrases.py and
// the runtime PhrasePlayer. Every phrase is authored purely from pentatonic
// tones (bright = major penta, dusk = minor penta) and baked with root C, so
// transposing to the current key keeps it consonant over any diatonic chord.

export type PhraseFlavor = "bright" | "dusk";

export type PhraseDef = {
  id: string;
  url: string;
  flavor: PhraseFlavor;
  voice: "rhodes" | "ks";
  gainTrim: number;
};

/** Pitch class the phrases were rendered in (C). */
export const PHRASE_REF_ROOT = 0;

export const PHRASE_DEFS: PhraseDef[] = [
  { id: "sigh-bright", url: "/audio/music/phrases/sigh-bright.mp3", flavor: "bright", voice: "rhodes", gainTrim: 0.8 },
  { id: "lift-bright", url: "/audio/music/phrases/lift-bright.mp3", flavor: "bright", voice: "rhodes", gainTrim: 0.8 },
  { id: "turn-bright", url: "/audio/music/phrases/turn-bright.mp3", flavor: "bright", voice: "rhodes", gainTrim: 0.8 },
  { id: "sigh-dusk", url: "/audio/music/phrases/sigh-dusk.mp3", flavor: "dusk", voice: "rhodes", gainTrim: 0.8 },
  { id: "turn-dusk", url: "/audio/music/phrases/turn-dusk.mp3", flavor: "dusk", voice: "rhodes", gainTrim: 0.8 },
  { id: "ask-dusk", url: "/audio/music/phrases/ask-dusk.mp3", flavor: "dusk", voice: "rhodes", gainTrim: 0.8 },
  { id: "swell-bright", url: "/audio/music/phrases/swell-bright.mp3", flavor: "bright", voice: "ks", gainTrim: 0.7 },
  { id: "swell-dusk", url: "/audio/music/phrases/swell-dusk.mp3", flavor: "dusk", voice: "ks", gainTrim: 0.7 },
  { id: "drift-bright", url: "/audio/music/phrases/drift-bright.mp3", flavor: "bright", voice: "rhodes", gainTrim: 0.8 },
  { id: "high-bright", url: "/audio/music/phrases/high-bright.mp3", flavor: "bright", voice: "rhodes", gainTrim: 0.8 },
  { id: "step-bright", url: "/audio/music/phrases/step-bright.mp3", flavor: "bright", voice: "rhodes", gainTrim: 0.8 },
  { id: "swell2-bright", url: "/audio/music/phrases/swell2-bright.mp3", flavor: "bright", voice: "ks", gainTrim: 0.7 },
  { id: "fall-dusk", url: "/audio/music/phrases/fall-dusk.mp3", flavor: "dusk", voice: "rhodes", gainTrim: 0.8 },
  { id: "float-dusk", url: "/audio/music/phrases/float-dusk.mp3", flavor: "dusk", voice: "rhodes", gainTrim: 0.8 },
  { id: "step-dusk", url: "/audio/music/phrases/step-dusk.mp3", flavor: "dusk", voice: "rhodes", gainTrim: 0.8 },
  { id: "swell2-dusk", url: "/audio/music/phrases/swell2-dusk.mp3", flavor: "dusk", voice: "ks", gainTrim: 0.7 }
];
