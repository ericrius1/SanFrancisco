/**
 * Master audio preferences (mute toggle + music/effects/voice sliders in the HUD).
 * Stored under its own localStorage key — deliberately outside the "/" tweak
 * store, so a factory reset (".") doesn't blast the speakers back on.
 * Consumers poll musicAudioLevel(), effectsAudioLevel() or voiceAudioLevel();
 * vehicle hum reads every frame, fireworks read per triggered sound, voice
 * applies per peer, corona songs poll music.
 */

const KEY = "sf-audio";

export type AudioPrefs = {
  musicVolume: number;
  effectsVolume: number;
  voiceVolume: number;
  enabled: boolean;
};

const DEFAULTS: AudioPrefs = {
  // Music defaults near FX so corona songs sit in the same mix ballpark.
  musicVolume: 0.42,
  // Voice defaults a little hotter than FX so proximity chat cuts through the mix.
  effectsVolume: 0.42,
  voiceVolume: 0.62,
  enabled: true
};

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

export const AUDIO_PREFS: AudioPrefs = (() => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<
      AudioPrefs & { volume?: number }
    >;
    const legacy = typeof s.volume === "number" ? clamp01(s.volume) : null;
    const effectsVolume =
      typeof s.effectsVolume === "number"
        ? clamp01(s.effectsVolume)
        : legacy ?? DEFAULTS.effectsVolume;
    return {
      // Music used to ride the effects slider; seed from it when missing so the
      // corona song doesn't jump when the third slider lands.
      musicVolume:
        typeof s.musicVolume === "number" ? clamp01(s.musicVolume) : effectsVolume,
      effectsVolume,
      voiceVolume:
        typeof s.voiceVolume === "number"
          ? clamp01(s.voiceVolume)
          : legacy != null
            ? clamp01(legacy * 1.25)
            : DEFAULTS.voiceVolume,
      enabled: typeof s.enabled === "boolean" ? s.enabled : DEFAULTS.enabled
    };
  } catch {
    return { ...DEFAULTS };
  }
})();

export function saveAudioPrefs() {
  localStorage.setItem(KEY, JSON.stringify(AUDIO_PREFS));
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

export function voiceAudioLevel() {
  return levelFrom(AUDIO_PREFS.voiceVolume);
}
