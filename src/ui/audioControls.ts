import { AUDIO_PREFS, saveAudioPrefs } from "../core/audioSettings";

/**
 * Master audio widget: effects/voice sliders, a labeled mute button, and a
 * voice-mic button, bottom-left of the HUD. Pure DOM inside #hud
 * (pointer-events: none — this widget opts itself back in, like the toolbar).
 * Writes core/audioSettings; the audio systems poll it, so there's nothing to
 * notify here.
 */
export class AudioControls {
  #btn: HTMLButtonElement;
  #muteIcon: HTMLSpanElement;
  #muteLabel: HTMLSpanElement;
  #mic: HTMLButtonElement;
  #micLabel: HTMLSpanElement;
  #effectsSlider: HTMLInputElement;
  #voiceSlider!: HTMLInputElement;

  /** Voice chat hook — set by main.ts once Voice exists (V key does the same). */
  onMicToggle: () => void = () => {};

  constructor() {
    const root = document.createElement("div");
    root.className = "audio";

    this.#effectsSlider = this.#makeSlider("effects", "game effects volume", (v) => {
      AUDIO_PREFS.effectsVolume = v;
    });
    this.#voiceSlider = this.#makeSlider("voice", "other players' voice volume", (v) => {
      AUDIO_PREFS.voiceVolume = v;
    });

    const sliders = document.createElement("div");
    sliders.className = "audio-sliders";
    sliders.append(this.#labeledRow("FX", this.#effectsSlider), this.#labeledRow("Voice", this.#voiceSlider));

    this.#btn = document.createElement("button");
    this.#btn.className = "mute-btn";
    this.#btn.type = "button";
    this.#btn.title = "mute all sound";
    this.#muteIcon = document.createElement("span");
    this.#muteIcon.className = "ic";
    this.#muteLabel = document.createElement("span");
    this.#muteLabel.className = "label";
    this.#btn.append(this.#muteIcon, this.#muteLabel);
    this.#btn.addEventListener("click", () => {
      AUDIO_PREFS.enabled = !AUDIO_PREFS.enabled;
      saveAudioPrefs();
      this.#btn.blur(); // keep Space as jump, not "click the button again"
      this.#refresh();
    });

    this.#mic = document.createElement("button");
    this.#mic.className = "mic-btn";
    this.#mic.title = "voice chat mic (V)";
    const micIcon = document.createElement("span");
    micIcon.className = "ic";
    micIcon.textContent = "🎙️";
    this.#micLabel = document.createElement("span");
    this.#micLabel.className = "label";
    this.#mic.append(micIcon, this.#micLabel);
    this.#mic.addEventListener("click", () => {
      this.onMicToggle();
      this.#mic.blur();
    });

    root.append(sliders, this.#btn, this.#mic);
    document.getElementById("hud")!.appendChild(root);
    this.setMic(false);
    this.#refresh();
  }

  #makeSlider(kind: "effects" | "voice", title: string, apply: (v: number) => void) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.title = title;
    slider.dataset.kind = kind;
    slider.addEventListener("input", () => {
      const v = Number(slider.value) / 100;
      apply(v);
      if (v > 0) AUDIO_PREFS.enabled = true; // dragging up implies "on"
      saveAudioPrefs();
      this.#refresh();
    });
    slider.addEventListener("change", () => slider.blur());
    return slider;
  }

  #labeledRow(label: string, slider: HTMLInputElement) {
    const row = document.createElement("div");
    row.className = "audio-row";
    const lbl = document.createElement("span");
    lbl.className = "audio-lbl";
    lbl.textContent = label;
    row.append(lbl, slider);
    return row;
  }

  /** Reflect the live mic state (Voice.onMicChange drives this). */
  setMic(on: boolean) {
    this.#mic.classList.toggle("on", on);
    this.#micLabel.textContent = on ? "Microphone on" : "Enable microphone";
  }

  #refresh() {
    const fxOn = AUDIO_PREFS.enabled && AUDIO_PREFS.effectsVolume > 0;
    const voiceOn = AUDIO_PREFS.enabled && AUDIO_PREFS.voiceVolume > 0;
    const muted = !AUDIO_PREFS.enabled;
    const anyOn = !muted && (AUDIO_PREFS.effectsVolume > 0 || AUDIO_PREFS.voiceVolume > 0);
    const peak = Math.max(AUDIO_PREFS.effectsVolume, AUDIO_PREFS.voiceVolume);
    this.#muteIcon.textContent = muted || !anyOn ? "🔇" : peak > 0.5 ? "🔊" : "🔉";
    this.#muteLabel.textContent = muted ? "Unmute" : "Mute";
    this.#btn.title = muted ? "unmute all sound" : "mute all sound";
    this.#btn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    this.#btn.setAttribute("aria-pressed", muted ? "true" : "false");
    this.#btn.classList.toggle("off", muted);
    this.#effectsSlider.value = String(Math.round(AUDIO_PREFS.effectsVolume * 100));
    this.#voiceSlider.value = String(Math.round(AUDIO_PREFS.voiceVolume * 100));
    this.#effectsSlider.classList.toggle("off", !fxOn);
    this.#voiceSlider.classList.toggle("off", !voiceOn);
  }
}
