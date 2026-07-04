/**
 * Master audio preferences (mute toggle + effects/voice sliders in the HUD).
 * Stored under its own localStorage key — deliberately outside the "/" tweak
 * store, so a factory reset (".") doesn't blast the speakers back on.
 * Consumers poll effectsAudioLevel() or voiceAudioLevel(); vehicle hum reads
 * every frame, fireworks/chimes read per triggered sound, voice applies per peer.
 */

const KEY = "sf-audio";

export type AudioPrefs = {
  effectsVolume: number;
  voiceVolume: number;
  enabled: boolean;
};

const DEFAULTS: AudioPrefs = {
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
    return {
      effectsVolume:
        typeof s.effectsVolume === "number"
          ? clamp01(s.effectsVolume)
          : legacy ?? DEFAULTS.effectsVolume,
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

export function effectsAudioLevel() {
  return levelFrom(AUDIO_PREFS.effectsVolume);
}

export function voiceAudioLevel() {
  return levelFrom(AUDIO_PREFS.voiceVolume);
}
