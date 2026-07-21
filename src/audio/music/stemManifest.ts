// Baked stem manifest — the contract between tools/music/render_stems.py and
// the runtime StemPlayer. All stems are UNPITCHED (grooves + texture) so they
// can never clash with the generative chord walk. loopSeconds is the exact
// musical schedule period; files carry extra ringing tail past it, and the
// player overlap-schedules repeats so codec padding can't open gaps.

export type StemId = "beatWarm" | "beatDusk" | "dust";

export type StemDef = {
  id: StemId;
  url: string;
  /** exact musical loop length in seconds (schedule period, NOT file length). */
  loopSeconds: number;
  /** percussive stems scan for their first transient to skip encoder padding. */
  detectLead: boolean;
  /** level trim into the music mix. */
  gainTrim: number;
};

export const STEM_DEFS: Record<StemId, StemDef> = {
  // 72 BPM swung lo-fi kit — the daytime city groove
  beatWarm: {
    id: "beatWarm",
    url: "/audio/music/stems/beat-warm.mp3",
    loopSeconds: (8 * 4 * 60) / 72,
    detectLead: true,
    gainTrim: 0.5
  },
  // 58 BPM half-time, deep and sparse — dusk/night
  beatDusk: {
    id: "beatDusk",
    url: "/audio/music/stems/beat-dusk.mp3",
    loopSeconds: (8 * 4 * 60) / 58,
    detectLead: true,
    gainTrim: 0.55
  },
  // tape-dust texture bed; 4 s equal-power fades baked at both ends
  dust: {
    id: "dust",
    url: "/audio/music/stems/dust.mp3",
    loopSeconds: 20,
    detectLead: false,
    gainTrim: 0.8
  }
};

export const STEM_IDS = Object.keys(STEM_DEFS) as StemId[];
