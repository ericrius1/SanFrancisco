import assert from "node:assert/strict";

const store = new Map([
  // Deliberately incompatible: one current schema must reset it, not migrate it.
  ["sf-audio", JSON.stringify({ effectsVolume: 0.03, enabled: false })]
]);
globalThis.localStorage = {
  getItem: (key) => store.get(key) ?? null,
  setItem: (key, value) => store.set(key, value),
  removeItem: (key) => store.delete(key),
  clear: () => store.clear()
};

const audio = await import(`../src/core/audioSettings.ts?probe=${Date.now()}`);
assert.equal(audio.AUDIO_PREFS.effectsVolume, 0.68, "incompatible mix did not reset FX default");
assert.equal(audio.AUDIO_PREFS.soundscapeVolume, 0.25, "World default did not reset");
assert.equal(audio.AUDIO_PREFS.enabled, true, "incompatible mute state leaked into current schema");

audio.AUDIO_PREFS.effectsVolume = 0.8;
audio.AUDIO_PREFS.soundscapeVolume = 0.2;
assert.ok(Math.abs(audio.effectsAudioLevel() - 0.64) < 1e-9, "FX perceptual taper is wrong");
assert.ok(Math.abs(audio.soundscapeAudioLevel() - 0.04) < 1e-9, "World perceptual taper is wrong");
audio.saveAudioPrefs();

const saved = JSON.parse(store.get("sf-audio"));
assert.equal(saved.schema, 2, "saved mix omitted its current schema");
assert.equal(saved.effectsVolume, 0.8);
assert.equal(saved.soundscapeVolume, 0.2);

audio.AUDIO_PREFS.musicVolume = 0.01;
audio.AUDIO_PREFS.effectsVolume = 0.02;
audio.AUDIO_PREFS.soundscapeVolume = 0.03;
audio.AUDIO_PREFS.voiceVolume = 0.04;
audio.AUDIO_PREFS.enabled = false;
audio.saveAudioPrefs();
audio.resetAudioPrefs();
assert.deepEqual(audio.AUDIO_PREFS, {
  musicVolume: 0.42,
  effectsVolume: 0.68,
  soundscapeVolume: 0.25,
  voiceVolume: 0.85,
  enabled: true
}, "factory reset did not restore the complete source-default mix");
assert.equal(store.has("sf-audio"), false, "factory reset left a persisted mixer override");

console.log("audio mixer probe: PASS", {
  effects: audio.effectsAudioLevel(),
  world: audio.soundscapeAudioLevel(),
  schema: saved.schema
});
