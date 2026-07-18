import { AUDIO_PREFS, saveAudioPrefs } from "../core/audioSettings";

export type MocapControlState = "off" | "loading" | "searching" | "tracking" | "error";

/**
 * Compact master audio widget. The always-visible row stays small; a disclosure
 * opens the music/effects/world/voice mixer only when the player asks for it.
 * Pure DOM inside #hud
 * (pointer-events: none — this widget opts itself back in, like the toolbar).
 * Writes core/audioSettings; the audio systems poll it, so there's nothing to
 * notify here.
 */
export class AudioControls {
  #btn: HTMLButtonElement;
  #muteIcon: HTMLSpanElement;
  #muteLabel: HTMLSpanElement;
  #mic: HTMLButtonElement;
  #micIcon: HTMLSpanElement;
  #micLabel: HTMLSpanElement;
  #mocap: HTMLButtonElement;
  #mocapIcon: HTMLSpanElement;
  #mocapLabel: HTMLSpanElement;
  #mocapPreview: HTMLDivElement;
  #mocapDebug: HTMLCanvasElement;
  #mocapStatus: HTMLSpanElement;
  #mocapVideo: HTMLVideoElement;
  #mixerButton: HTMLButtonElement;
  #mixerPanel: HTMLDivElement;
  #root: HTMLDivElement;
  #musicSlider: HTMLInputElement;
  #effectsSlider: HTMLInputElement;
  #soundscapeSlider: HTMLInputElement;
  #voiceSlider!: HTMLInputElement;
  #mixerOpen = false;
  #mocapState: MocapControlState = "off";
  #micNudgeShown = false;
  #micNudge: HTMLDivElement | null = null;

  /** Voice chat hook — set by main.ts once Voice exists (V key does the same). */
  onMicToggle: () => void = () => {};
  /** Lazy webcam-pose hook — set by main.ts after the player exists. */
  onMocapToggle: () => void = () => {};

  constructor() {
    const root = document.createElement("div");
    root.className = "audio";
    this.#root = root;

    this.#musicSlider = this.#makeSlider("music", "music volume (songs)", (v) => {
      AUDIO_PREFS.musicVolume = v;
    });
    this.#effectsSlider = this.#makeSlider("effects", "sound effects volume", (v) => {
      AUDIO_PREFS.effectsVolume = v;
    });
    this.#soundscapeSlider = this.#makeSlider(
      "soundscape",
      "world soundscape volume: wind, water, wildlife, and ambience",
      (v) => {
        AUDIO_PREFS.soundscapeVolume = v;
      }
    );
    this.#voiceSlider = this.#makeSlider("voice", "other players' voice volume", (v) => {
      AUDIO_PREFS.voiceVolume = v;
    });

    const sliders = document.createElement("div");
    sliders.className = "audio-sliders";
    sliders.append(
      this.#labeledRow("Music", this.#musicSlider),
      this.#labeledRow("FX", this.#effectsSlider),
      this.#labeledRow("World", this.#soundscapeSlider),
      this.#labeledRow("Voice", this.#voiceSlider)
    );
    sliders.hidden = true;
    this.#mixerPanel = sliders;

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

    this.#mixerButton = document.createElement("button");
    this.#mixerButton.className = "mixer-btn";
    this.#mixerButton.type = "button";
    this.#mixerButton.title = "open sound mixer";
    this.#mixerButton.setAttribute("aria-expanded", "false");
    this.#mixerButton.innerHTML = '<span class="ic" aria-hidden="true">☷</span><span class="label">Mixer</span><span class="chev" aria-hidden="true">▴</span>';
    this.#mixerButton.addEventListener("click", () => {
      this.#setMixerOpen(!this.#mixerOpen);
      this.#mixerButton.blur();
    });

    this.#mic = document.createElement("button");
    this.#mic.className = "mic-btn";
    this.#mic.type = "button";
    this.#micIcon = document.createElement("span");
    this.#micIcon.className = "ic";
    this.#micIcon.setAttribute("aria-hidden", "true");
    this.#micLabel = document.createElement("span");
    this.#micLabel.className = "label";
    this.#mic.append(this.#micIcon, this.#micLabel);
    this.#mic.addEventListener("click", () => {
      this.#dismissMicNudge();
      this.onMicToggle();
      this.#mic.blur();
    });

    this.#mocap = document.createElement("button");
    this.#mocap.className = "mocap-btn off";
    this.#mocap.type = "button";
    this.#mocapIcon = document.createElement("span");
    this.#mocapIcon.className = "ic";
    this.#mocapIcon.setAttribute("aria-hidden", "true");
    this.#mocapIcon.textContent = "◉";
    this.#mocapLabel = document.createElement("span");
    this.#mocapLabel.className = "label";
    this.#mocapLabel.textContent = "Pose";
    this.#mocap.append(this.#mocapIcon, this.#mocapLabel);
    this.#mocap.addEventListener("click", () => {
      if (this.#mocapState !== "loading") this.onMocapToggle();
      this.#mocap.blur();
    });

    this.#mocapVideo = document.createElement("video");
    this.#mocapVideo.autoplay = true;
    this.#mocapVideo.muted = true;
    this.#mocapVideo.playsInline = true;
    this.#mocapVideo.setAttribute("aria-label", "Mirrored webcam pose preview");
    this.#mocapDebug = document.createElement("canvas");
    this.#mocapDebug.className = "mocap-debug";
    this.#mocapDebug.setAttribute("aria-hidden", "true");
    this.#mocapStatus = document.createElement("span");
    this.#mocapStatus.textContent = "WebGPU pose";
    const previewLabel = document.createElement("div");
    previewLabel.className = "mocap-preview-label";
    previewLabel.append(this.#mocapStatus);
    this.#mocapPreview = document.createElement("div");
    this.#mocapPreview.className = "mocap-preview";
    this.#mocapPreview.hidden = true;
    this.#mocapPreview.append(this.#mocapVideo, this.#mocapDebug, previewLabel);

    const actions = document.createElement("div");
    actions.className = "audio-actions";
    actions.append(this.#btn, this.#mixerButton, this.#mic, this.#mocap);
    root.append(this.#mocapPreview, sliders, actions);
    document.getElementById("hud")!.appendChild(root);
    document.addEventListener("pointerdown", (event) => {
      if (this.#mixerOpen && !this.#root.contains(event.target as Node)) this.#setMixerOpen(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && this.#mixerOpen) this.#setMixerOpen(false);
    });
    this.setMic(false);
    this.setMocap("off");
    this.#refresh();
  }

  get mocapVideo(): HTMLVideoElement {
    return this.#mocapVideo;
  }

  get mocapDebugCanvas(): HTMLCanvasElement {
    return this.#mocapDebug;
  }

  /** A brief first-entry pointer toward opt-in voice chat. */
  showMicNudge(): void {
    if (this.#micNudgeShown || !this.#mic.classList.contains("off")) return;
    this.#micNudgeShown = true;
    const nudge = document.createElement("div");
    nudge.className = "mic-nudge";
    nudge.textContent = "Click the mic to unmute and chat";
    nudge.setAttribute("role", "status");
    this.#root.appendChild(nudge);
    this.#micNudge = nudge;
    window.setTimeout(() => this.#dismissMicNudge(), 6000);
  }

  #makeSlider(kind: "music" | "effects" | "soundscape" | "voice", title: string, apply: (v: number) => void) {
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.step = "1";
    slider.title = title;
    slider.setAttribute("aria-label", title);
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
    this.#mic.classList.toggle("off", !on);
    // Same studio-mic glyph either way; `.off` draws a slash so mobile (label
    // hidden) still reads clearly as not transmitting.
    this.#micIcon.textContent = "🎙️";
    this.#micLabel.textContent = on ? "Mic on" : "Mic off";
    this.#mic.title = on ? "mic live — press V to mute" : "mic off — press V to go live";
    this.#mic.setAttribute("aria-label", on ? "Microphone on" : "Microphone off");
    this.#mic.setAttribute("aria-pressed", on ? "true" : "false");
    if (on) this.#dismissMicNudge();
  }

  setMocap(state: MocapControlState, message = "WebGPU pose"): void {
    this.#mocapState = state;
    const active = state === "loading" || state === "searching" || state === "tracking";
    this.#mocap.classList.toggle("on", state === "searching" || state === "tracking");
    this.#mocap.classList.toggle("off", state === "off");
    this.#mocap.classList.toggle("loading", state === "loading");
    this.#mocap.classList.toggle("error", state === "error");
    this.#mocap.disabled = state === "loading";
    this.#mocap.setAttribute("aria-pressed", active ? "true" : "false");
    this.#mocap.setAttribute("aria-label", active ? "Turn webcam pose control off" : "Drive avatar with webcam pose");
    this.#mocap.title = active ? "webcam pose active — click to stop" : "drive your avatar from the webcam (WebGPU)";
    this.#mocapIcon.textContent = state === "loading" ? "◌" : state === "tracking" ? "●" : "◉";
    this.#mocapLabel.textContent = state === "tracking" ? "Pose on" : state === "error" ? "Retry pose" : "Pose";
    this.#mocapStatus.textContent = message;
    this.#mocapPreview.hidden = state === "off" || state === "error";
  }

  #setMixerOpen(open: boolean) {
    this.#mixerOpen = open;
    this.#mixerPanel.hidden = !open;
    this.#root.classList.toggle("mixer-open", open);
    this.#mixerButton.setAttribute("aria-expanded", String(open));
    this.#mixerButton.title = open ? "close sound mixer" : "open sound mixer";
    const chev = this.#mixerButton.querySelector<HTMLElement>(".chev");
    if (chev) chev.textContent = open ? "▾" : "▴";
  }

  #refresh() {
    const musicOn = AUDIO_PREFS.enabled && AUDIO_PREFS.musicVolume > 0;
    const fxOn = AUDIO_PREFS.enabled && AUDIO_PREFS.effectsVolume > 0;
    const soundscapeOn = AUDIO_PREFS.enabled && AUDIO_PREFS.soundscapeVolume > 0;
    const voiceOn = AUDIO_PREFS.enabled && AUDIO_PREFS.voiceVolume > 0;
    const muted = !AUDIO_PREFS.enabled;
    const anyOn =
      !muted &&
      (AUDIO_PREFS.musicVolume > 0 ||
        AUDIO_PREFS.effectsVolume > 0 ||
        AUDIO_PREFS.soundscapeVolume > 0 ||
        AUDIO_PREFS.voiceVolume > 0);
    const peak = Math.max(
      AUDIO_PREFS.musicVolume,
      AUDIO_PREFS.effectsVolume,
      AUDIO_PREFS.soundscapeVolume,
      AUDIO_PREFS.voiceVolume
    );
    this.#muteIcon.textContent = muted || !anyOn ? "🔇" : peak > 0.5 ? "🔊" : "🔉";
    this.#muteLabel.textContent = muted ? "Unmute" : "Mute";
    this.#btn.title = muted ? "unmute all sound" : "mute all sound";
    this.#btn.setAttribute("aria-label", muted ? "Unmute" : "Mute");
    this.#btn.setAttribute("aria-pressed", muted ? "true" : "false");
    this.#btn.classList.toggle("off", muted);
    this.#musicSlider.value = String(Math.round(AUDIO_PREFS.musicVolume * 100));
    this.#effectsSlider.value = String(Math.round(AUDIO_PREFS.effectsVolume * 100));
    this.#soundscapeSlider.value = String(Math.round(AUDIO_PREFS.soundscapeVolume * 100));
    this.#voiceSlider.value = String(Math.round(AUDIO_PREFS.voiceVolume * 100));
    this.#musicSlider.classList.toggle("off", !musicOn);
    this.#effectsSlider.classList.toggle("off", !fxOn);
    this.#soundscapeSlider.classList.toggle("off", !soundscapeOn);
    this.#voiceSlider.classList.toggle("off", !voiceOn);
  }

  #dismissMicNudge(): void {
    const nudge = this.#micNudge;
    if (!nudge) return;
    this.#micNudge = null;
    nudge.classList.add("closing");
    window.setTimeout(() => nudge.remove(), 240);
  }
}
