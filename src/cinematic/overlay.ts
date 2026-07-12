import { clamp01, smoothstep } from "./curves";
import type { OverlayCue } from "./types";

type CueView = {
  cue: OverlayCue;
  root: HTMLDivElement;
};

type CinematicOverlayWindow = Window &
  typeof globalThis & {
    __sfCinematicOverlayCanvas?: HTMLCanvasElement;
  };

function wrappedLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number) {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      lines.push("");
      continue;
    }
    let line = words[0];
    for (let index = 1; index < words.length; index++) {
      const candidate = `${line} ${words[index]}`;
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else {
        lines.push(line);
        line = words[index];
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Frame-driven film titles. No CSS animations: capture time owns every pixel. */
export class CinematicOverlay {
  #root = document.createElement("div");
  #chapter = document.createElement("div");
  #progress = document.createElement("div");
  #views: CueView[];
  #mirror = document.createElement("canvas");
  #letterbox: number;

  constructor(name: string, cues: readonly OverlayCue[], letterbox = 0.055) {
    this.#letterbox = letterbox;
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
    this.#mirror.dataset.cinematicMirror = name;
    (window as CinematicOverlayWindow).__sfCinematicOverlayCanvas = this.#mirror;
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
    this.#drawMirror(time, duration, chapter);
  }

  /**
   * Canvas twin of the DOM titles for browser-native WebCodecs capture. The
   * archival screenshot path still captures the DOM itself; this mirror keeps
   * the fast path deterministic without attempting to rasterize arbitrary DOM.
   */
  #drawMirror(time: number, duration: number, chapter: string) {
    const width = Math.max(2, Math.round(window.innerWidth));
    const height = Math.max(2, Math.round(window.innerHeight));
    if (this.#mirror.width !== width || this.#mirror.height !== height) {
      this.#mirror.width = width;
      this.#mirror.height = height;
    }
    const ctx = this.#mirror.getContext("2d", { alpha: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);

    const barHeight = this.#letterbox * height;
    ctx.fillStyle = "#050709";
    ctx.fillRect(0, 0, width, barHeight);
    ctx.fillRect(0, height - barHeight, width, barHeight);

    const cardWidth = Math.min(width * 0.37, 660);
    const paddingX = 26;
    const paddingTop = 22;
    const titleSize = Math.max(30, Math.min(width * 0.032, 58));
    for (const { cue } of this.#views) {
      const fade = Math.min(cue.fade ?? 0.32, (cue.end - cue.start) * 0.4);
      const enter = smoothstep((time - cue.start) / Math.max(0.001, fade));
      const exit = 1 - smoothstep((time - (cue.end - fade)) / Math.max(0.001, fade));
      const opacity = clamp01(Math.min(enter, exit));
      if (opacity <= 0.0001) continue;

      const align = cue.align ?? "left";
      const travel = (1 - opacity) * (align === "right" ? 26 : align === "center" ? 0 : -26);
      let x = align === "left" ? width * 0.052 : align === "right" ? width - width * 0.052 - cardWidth : (width - cardWidth) / 2;
      x += travel;
      const y = align === "center" ? height * 0.7 : height * 0.18;
      const textWidth = cardWidth - paddingX * 2;

      ctx.save();
      ctx.globalAlpha = opacity;
      const gradient = ctx.createLinearGradient(
        align === "right" ? x + cardWidth : x,
        0,
        align === "right" ? x : x + cardWidth,
        0
      );
      gradient.addColorStop(0, "rgba(4,10,14,.78)");
      gradient.addColorStop(1, "rgba(4,10,14,.12)");
      ctx.fillStyle = gradient;

      ctx.font = `760 ${titleSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
      const titleLines = wrappedLines(ctx, cue.title, textWidth);
      ctx.font = "400 18px Inter, ui-sans-serif, system-ui, sans-serif";
      const detailLines = cue.detail ? wrappedLines(ctx, cue.detail, textWidth) : [];
      const eyebrowHeight = cue.eyebrow ? 20 : 0;
      const titleHeight = titleLines.length * titleSize * 0.98;
      const detailHeight = detailLines.length ? 11 + detailLines.length * 24 : 0;
      const cardHeight = paddingTop + eyebrowHeight + titleHeight + detailHeight + 24;
      ctx.fillRect(x, y, cardWidth, cardHeight);
      ctx.fillStyle = cue.accent ?? "#8ff8eb";
      ctx.fillRect(align === "right" ? x + cardWidth - 3 : x, y, 3, cardHeight);

      const textX = align === "right" ? x + cardWidth - paddingX : align === "center" ? x + cardWidth / 2 : x + paddingX;
      let textY = y + paddingTop;
      ctx.textAlign = align === "right" ? "right" : align === "center" ? "center" : "left";
      ctx.textBaseline = "top";
      ctx.shadowColor = "rgba(0,0,0,.72)";
      ctx.shadowBlur = 16;
      if (cue.eyebrow) {
        ctx.fillStyle = cue.accent ?? "#8ff8eb";
        ctx.font = "750 12px Inter, ui-sans-serif, system-ui, sans-serif";
        ctx.fillText(cue.eyebrow.toUpperCase(), textX, textY);
        textY += 20;
      }
      ctx.fillStyle = "#f7fff9";
      ctx.font = `760 ${titleSize}px Inter, ui-sans-serif, system-ui, sans-serif`;
      for (const line of titleLines) {
        ctx.fillText(line, textX, textY);
        textY += titleSize * 0.98;
      }
      if (detailLines.length) {
        textY += 11;
        ctx.fillStyle = "rgba(241,255,249,.82)";
        ctx.font = "400 18px Inter, ui-sans-serif, system-ui, sans-serif";
        for (const line of detailLines) {
          ctx.fillText(line, textX, textY);
          textY += 24;
        }
      }
      ctx.restore();
    }

    const safe = width * 0.052;
    const trackY = height - barHeight - 9;
    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fillRect(safe, trackY, width - safe * 2, 2);
    const progress = clamp01(time / duration);
    const progressGradient = ctx.createLinearGradient(safe, 0, width - safe, 0);
    progressGradient.addColorStop(0, "#74f5e6");
    progressGradient.addColorStop(1, "#d8ff84");
    ctx.fillStyle = progressGradient;
    ctx.fillRect(safe, trackY, (width - safe * 2) * progress, 2);
    ctx.fillStyle = "rgba(242,255,250,.72)";
    ctx.font = "720 10px Inter, ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(chapter.replaceAll("-", "  ·  ").toUpperCase(), safe, trackY - 8);
  }

  dispose() {
    const win = window as CinematicOverlayWindow;
    if (win.__sfCinematicOverlayCanvas === this.#mirror) delete win.__sfCinematicOverlayCanvas;
    this.#root.remove();
  }
}
