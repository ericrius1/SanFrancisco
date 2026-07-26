// Baked stem manifest — the contract between tools/music/render_stems.py and
// the runtime StemPlayer. All stems are UNPITCHED (texture only) so they can
// never clash with the generative chord walk. loopSeconds is the exact musical
// schedule period; files carry extra ringing tail past it, and the player
// overlap-schedules repeats so codec padding can't open gaps.
//
// The three baked drum loops that used to live here are gone: rhythm is now
// synthesized and performed per region by ./groove, which a fixed loop could
// never do. Texture is the only thing left worth baking.

export type StemId = "dust";

export type StemDef = {
  id: StemId;
  url: string;
  /** exact musical loop length in seconds (schedule period, NOT file length). */
  loopSeconds: number;
  /** transient-scan the decoded head to skip encoder padding (percussive only). */
  detectLead: boolean;
  /** level trim into the music mix. */
  gainTrim: number;
};

export const STEM_DEFS: Record<StemId, StemDef> = {
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
