/**
 * Master audio preferences (mute + a compact music/effects/world/voice mixer).
 * Stored under its own localStorage key, outside the "/" tweak store. The
 * period-key factory reset explicitly restores this mix to the source defaults.
 * Consumers poll the matching group level; environmental beds use
 * soundscapeAudioLevel(), while player/action feedback uses effectsAudioLevel().
 * vehicle hum reads every frame, fireworks read per triggered sound, voice
 * applies per peer, corona songs poll music.
 */

const KEY = "sf-audio";
const SCHEMA = 2;

export type AudioPrefs = {
  musicVolume: number;
  effectsVolume: number;
  soundscapeVolume: number;
  voiceVolume: number;
  enabled: boolean;
};

const DEFAULTS: AudioPrefs = {
  // Foreground feedback starts decisively above the always-on world bed.
  musicVolume: 0.42,
  effectsVolume: 0.68,
  soundscapeVolume: 0.25,
  // Voice leads the mix — chat intelligibility beats ambience (levels square
  // in levelFrom, so 0.85 → ~0.72 gain; the old 0.62 landed at a faint ~0.38).
  voiceVolume: 0.85,
  enabled: true
};

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

export const AUDIO_PREFS: AudioPrefs = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<AudioPrefs> & {
      schema?: number;
    };
    // One current settings shape: incompatible stored mixes reset cleanly.
    if (s.schema !== SCHEMA) return { ...DEFAULTS };
    return {
      musicVolume: typeof s.musicVolume === "number" ? clamp01(s.musicVolume) : DEFAULTS.musicVolume,
      effectsVolume: typeof s.effectsVolume === "number" ? clamp01(s.effectsVolume) : DEFAULTS.effectsVolume,
      soundscapeVolume:
        typeof s.soundscapeVolume === "number" ? clamp01(s.soundscapeVolume) : DEFAULTS.soundscapeVolume,
      voiceVolume: typeof s.voiceVolume === "number" ? clamp01(s.voiceVolume) : DEFAULTS.voiceVolume,
      enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULTS.enabled
    };
  } catch {
    return { ...DEFAULTS };
  }
})();

export function saveAudioPrefs() {
  localStorage.setItem(KEY, JSON.stringify({ schema: SCHEMA, ...AUDIO_PREFS }));
}

/** Restore the live mixer and discard its persisted override. */
export function resetAudioPrefs() {
  Object.assign(AUDIO_PREFS, DEFAULTS);
  localStorage.removeItem(KEY);
}

/** 0 when muted; volume² otherwise (perceptual taper so mid-slider feels mid-loud). */
function levelFrom(volume: number) {
  return AUDIO_PREFS.enabled ? volume * volume : 0;
}

export function musicAudioLevel() {
  return levelFrom(AUDIO_PREFS.musicVolume);
}

export function effectsAudioLevel() {
  return levelFrom(AUDIO_PREFS.effectsVolume);
}

export function soundscapeAudioLevel() {
  return levelFrom(AUDIO_PREFS.soundscapeVolume);
}

export function voiceAudioLevel() {
  return levelFrom(AUDIO_PREFS.voiceVolume);
}
