import { clamp01, smoothstep } from "./curves";
import type { OverlayCue } from "./types";

type CueView = {
  cue: OverlayCue;
  root: HTMLDivElement;
};

/** Frame-driven film titles. No CSS animations: capture time owns every pixel. */
export class CinematicOverlay {
  #root = document.createElement("div");
  #chapter = document.createElement("div");
  #progress = document.createElement("div");
  #views: CueView[];

  constructor(name: string, cues: readonly OverlayCue[], letterbox = 0.055) {
    this.#root.className = "cine-overlay";
    this.#root.dataset.cinematic = name;
    this.#root.style.setProperty("--cine-letterbox", `${letterbox * 100}vh`);

    const style = document.createElement("style");
    style.dataset.cinematicStyle = "true";
    style.textContent = `
      .cine-overlay{position:fixed;inset:0;z-index:2147483000;pointer-events:none;color:#f7fff9;
        font-family:Inter,ui-sans-serif,system-ui,sans-serif;letter-spacing:.01em;overflow:hidden}
      .cine-bar{position:absolute;left:0;right:0;height:var(--cine-letterbox);background:#050709;z-index:3}
      .cine-bar.top{top:0}.cine-bar.bottom{bottom:0}
      .cine-card{position:absolute;top:18%;width:min(37vw,660px);padding:22px 26px 24px;
        border-left:3px solid var(--accent,#8ff8eb);background:linear-gradient(90deg,rgba(4,10,14,.78),rgba(4,10,14,.12));
        text-shadow:0 2px 16px rgba(0,0,0,.72);will-change:transform,opacity}
      .cine-card.left{left:5.2%}.cine-card.right{right:5.2%;border-left:0;border-right:3px solid var(--accent,#8ff8eb);
        text-align:right;background:linear-gradient(270deg,rgba(4,10,14,.78),rgba(4,10,14,.12))}
      .cine-card.center{left:50%;top:70%;transform:translateX(-50%);text-align:center;border:0;background:rgba(4,10,14,.54)}
      .cine-eyebrow{font-size:12px;font-weight:750;letter-spacing:.22em;text-transform:uppercase;color:var(--accent,#8ff8eb);margin-bottom:8px}
      .cine-title{font-size:clamp(30px,3.2vw,58px);line-height:.96;font-weight:760;letter-spacing:-.045em}
      .cine-detail{margin-top:11px;font-size:clamp(12px,1.05vw,18px);line-height:1.35;letter-spacing:.04em;color:rgba(241,255,249,.82);white-space:pre-line}
      .cine-chapter{position:absolute;left:5.2%;bottom:calc(var(--cine-letterbox) + 18px);font-size:10px;font-weight:720;
        letter-spacing:.19em;text-transform:uppercase;color:rgba(242,255,250,.72);text-shadow:0 1px 8px #000}
      .cine-progress-track{position:absolute;left:5.2%;right:5.2%;bottom:calc(var(--cine-letterbox) + 8px);height:2px;background:rgba(255,255,255,.18)}
      .cine-progress{height:100%;width:0;background:linear-gradient(90deg,#74f5e6,#d8ff84);box-shadow:0 0 9px rgba(116,245,230,.75)}
    `;
    document.head.appendChild(style);

    const top = document.createElement("div");
    top.className = "cine-bar top";
    const bottom = document.createElement("div");
    bottom.className = "cine-bar bottom";
    this.#chapter.className = "cine-chapter";
    const track = document.createElement("div");
    track.className = "cine-progress-track";
    this.#progress.className = "cine-progress";
    track.appendChild(this.#progress);
    this.#root.append(top, bottom, this.#chapter, track);

    this.#views = cues.map((cue) => {
      const root = document.createElement("div");
      root.className = `cine-card ${cue.align ?? "left"}`;
      root.style.setProperty("--accent", cue.accent ?? "#8ff8eb");
      const eyebrow = document.createElement("div");
      eyebrow.className = "cine-eyebrow";
      eyebrow.textContent = cue.eyebrow ?? "";
      const title = document.createElement("div");
      title.className = "cine-title";
      title.textContent = cue.title;
      const detail = document.createElement("div");
      detail.className = "cine-detail";
      detail.textContent = cue.detail ?? "";
      if (!cue.eyebrow) eyebrow.style.display = "none";
      if (!cue.detail) detail.style.display = "none";
      root.append(eyebrow, title, detail);
      this.#root.appendChild(root);
      return { cue, root };
    });
    document.body.appendChild(this.#root);
  }

  update(time: number, duration: number, chapter: string) {
    this.#chapter.textContent = chapter.replaceAll("-", "  ·  ");
    this.#progress.style.width = `${clamp01(time / duration) * 100}%`;
    for (const { cue, root } of this.#views) {
      const fade = Math.min(cue.fade ?? 0.32, (cue.end - cue.start) * 0.4);
      const enter = smoothstep((time - cue.start) / Math.max(0.001, fade));
      const exit = 1 - smoothstep((time - (cue.end - fade)) / Math.max(0.001, fade));
      const opacity = clamp01(Math.min(enter, exit));
      const align = cue.align ?? "left";
      const travel = (1 - opacity) * (align === "right" ? 26 : align === "center" ? 0 : -26);
      root.style.opacity = opacity.toFixed(4);
      const center = align === "center" ? "translateX(-50%) " : "";
      root.style.transform = `${center}translate3d(${travel.toFixed(2)}px,0,0)`;
      root.style.visibility = opacity <= 0.0001 ? "hidden" : "visible";
    }
  }

  dispose() {
    this.#root.remove();
  }
}
