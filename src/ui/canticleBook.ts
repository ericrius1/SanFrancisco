// The Canticle of the Creatures — an interactive storybook you open (E) at the
// pedestal in the Mission Dolores museum. A children's-book retelling of Saint
// Francis's real 1225 hymn, one gentle spread per creature, with generated
// watercolor art (/francis/art/*.png). Fully self-contained DOM: it injects its
// own styles, drives page flips from arrow keys / clicks / on-screen controls,
// and calls onToggle(open) so the world freezes while you read.

export interface CanticleBook {
  open(): void;
  close(): void;
  toggle(): void;
  readonly isOpen: boolean;
  dispose(): void;
}

interface Spread {
  art: string; // art asset name (/francis/art/<art>.png)
  title: string;
  verse: string;
  note?: string;
  kind?: "cover" | "page" | "back";
}

const ART = "/francis/art/";

const SPREADS: Spread[] = [
  {
    kind: "cover",
    art: "canticle-cover",
    title: "The Canticle of the Creatures",
    verse: "Brother Francis's song of thanks for the whole family of creation.",
    note: "Turn the page with → or click. Press Esc to close."
  },
  {
    art: "francis-portrait",
    title: "A Brother to All",
    verse:
      "Long ago in the hill-town of Assisi lived a joyful man named Francis. He gave away his fine clothes and coins to follow a gentler road, and he began to call the sun, the wind, the water, and even the smallest sparrow his brothers and sisters.",
    note: "Near the end of his life, nearly blind and often in pain, Francis still made a song — this one — praising God through every creature."
  },
  {
    art: "canticle-brother-sun",
    title: "Brother Sun",
    verse:
      "Be praised, my Lord, for Brother Sun,\nwho brings the day and carries your light.\nHow beautiful he is, how full of gold —\nof you, Most High, he is a sign.",
    note: "In the real Canticle: “Praised be You... through Brother Sun, who is the day and through whom You give us light.”"
  },
  {
    art: "canticle-sister-moon",
    title: "Sister Moon and the Stars",
    verse:
      "Be praised for Sister Moon and Stars;\nin heaven you have set them clear\nand precious and fair.\nGoodnight, they whisper. You are not alone.",
    note: "Francis saw the night sky not as darkness but as a ceiling of small kind lamps."
  },
  {
    art: "canticle-brother-wind",
    title: "Brother Wind",
    verse:
      "Be praised for Brother Wind,\nfor air and cloud and clear blue sky,\nand for every kind of weather\nby which you feed the things that grow.",
    note: "Sun or storm, Francis thanked them all — each one does its work for us."
  },
  {
    art: "canticle-sister-water",
    title: "Sister Water",
    verse:
      "Be praised for Sister Water,\nso useful, humble, precious, pure.\nShe laughs along the stones\nand gives a drink to every thirsty thing.",
    note: "“Humble and precious and pure” are Francis's own words for water."
  },
  {
    art: "canticle-brother-fire",
    title: "Brother Fire",
    verse:
      "Be praised for Brother Fire,\nby whom you brighten up the night.\nHe is beautiful and playful,\nstrong and warm.",
    note: "Francis loved fire so much he once refused to let anyone put out a flame that had singed his robe."
  },
  {
    art: "canticle-sister-earth",
    title: "Sister Mother Earth",
    verse:
      "Be praised for our Sister, Mother Earth,\nwho holds us up and feeds us well,\nand brings forth all the colored flowers,\nthe fruit, and grass, and herbs.",
    note: "The Earth is family too — a mother who feeds every brother and sister."
  },
  {
    art: "peacemaker-sultan",
    title: "Those Who Forgive",
    verse:
      "Be praised for those who forgive\nfor love of you,\nand carry sickness and sorrow in peace.\nBlessed are the ones who make peace.",
    note: "Francis crossed a war to speak kindly with Sultan al-Kamil. He believed peace was made by listening, not by winning."
  },
  {
    art: "canticle-creatures-all",
    title: "All Creatures, Sing!",
    verse:
      "So praise and bless my Lord,\nand give him thanks,\nand serve him all together —\nwith great humbleness.",
    note: "Wolf and lamb, sparrow and deer, sun and moon: Francis gathered them all into one great song of thank-you."
  },
  {
    kind: "back",
    art: "mission-dolores",
    title: "About this Song",
    verse:
      "Francis composed the Canticle of the Creatures around 1225, in the everyday Italian of Assisi — one of the very first poems written in that language.",
    note:
      "Franciscan friars carried his name across the world. In 1776 they founded Mission San Francisco de Asís, and the city of San Francisco grew up around it — named, at two removes, for the brother who sang this song."
  }
];

const STYLE_ID = "canticle-book-style";
const CSS = `
#canticle-book {
  position: fixed; inset: 0; z-index: 55; display: none;
  align-items: center; justify-content: center; padding: 3vh 3vw;
  background: radial-gradient(ellipse at center, rgba(30,18,6,0.55), rgba(8,5,2,0.82));
  backdrop-filter: blur(6px); pointer-events: auto;
  font-family: Georgia, 'Times New Roman', serif; color: #3f2f1c;
  opacity: 0; transition: opacity .28s cubic-bezier(.2,.7,.2,1);
}
#canticle-book.open { display: flex; opacity: 1; }
#canticle-book .cb-book {
  display: flex; width: min(1180px, 96vw); height: min(760px, 90vh);
  border-radius: 12px; overflow: hidden; position: relative;
  box-shadow: 0 40px 120px rgba(0,0,0,.7), 0 0 0 10px #6b4a24, 0 0 0 13px #4a3016;
  background: #f6ecd4;
  transform: scale(.92); transition: transform .32s cubic-bezier(.2,.7,.2,1);
}
#canticle-book.open .cb-book { transform: scale(1); }
#canticle-book .cb-spine {
  position: absolute; left: 50%; top: 0; bottom: 0; width: 26px; transform: translateX(-50%);
  background: linear-gradient(90deg, rgba(90,61,30,0), rgba(60,40,18,.32) 45%, rgba(60,40,18,.32) 55%, rgba(90,61,30,0));
  pointer-events: none; z-index: 3;
}
#canticle-book .cb-page {
  flex: 1 1 50%; min-width: 0; position: relative; overflow: hidden;
  background: linear-gradient(180deg, #f8efd9, #eaddbe);
}
#canticle-book .cb-left { box-shadow: inset -22px 0 40px -22px rgba(90,61,30,.45); }
#canticle-book .cb-right { box-shadow: inset 22px 0 40px -22px rgba(90,61,30,.45); }
#canticle-book .cb-art {
  position: absolute; inset: 26px; border-radius: 6px; background-size: cover; background-position: center;
  box-shadow: 0 6px 24px rgba(60,40,18,.35), inset 0 0 0 1px rgba(90,61,30,.25);
  background-color: #d9c39a;
}
#canticle-book .cb-textwrap {
  position: absolute; inset: 34px 40px; display: flex; flex-direction: column; justify-content: center;
}
#canticle-book .cb-title {
  font-size: clamp(24px, 3.4vw, 40px); font-weight: 600; color: #5a3d1e; margin-bottom: 14px; line-height: 1.1;
}
#canticle-book .cb-cover-title { font-size: clamp(30px, 4.6vw, 56px); text-align: center; }
#canticle-book .cb-verse { font-size: clamp(16px, 1.7vw, 22px); line-height: 1.5; white-space: pre-line; color: #40301c; }
#canticle-book .cb-note {
  margin-top: 20px; font-size: clamp(12px, 1.15vw, 15px); font-style: italic; color: #7a5a2e;
  border-top: 1px solid rgba(120,84,38,.3); padding-top: 12px;
}
#canticle-book .cb-cover-sub { text-align: center; font-style: italic; color: #6b4a24; }
#canticle-book .cb-nav {
  position: absolute; top: 50%; transform: translateY(-50%); z-index: 4;
  width: 52px; height: 52px; border-radius: 50%; border: none; cursor: pointer;
  background: rgba(107,74,36,.85); color: #f6ecd4; font-size: 26px; line-height: 1;
  box-shadow: 0 6px 20px rgba(0,0,0,.4); transition: transform .12s, background .18s;
}
#canticle-book .cb-nav:hover { background: #6b4a24; transform: translateY(-50%) scale(1.08); }
#canticle-book .cb-nav:disabled { opacity: .28; cursor: default; }
#canticle-book .cb-prev { left: -26px; }
#canticle-book .cb-next { right: -26px; }
#canticle-book .cb-close {
  position: absolute; top: -14px; right: -14px; z-index: 5; width: 40px; height: 40px; border-radius: 50%;
  border: none; cursor: pointer; background: rgba(74,48,22,.92); color: #f6ecd4; font-size: 20px;
  box-shadow: 0 4px 14px rgba(0,0,0,.4);
}
#canticle-book .cb-counter {
  position: absolute; bottom: -30px; left: 50%; transform: translateX(-50%); color: #e8d9bd;
  font-size: 13px; font-style: italic; letter-spacing: .04em;
}
#canticle-book .cb-flip { animation: cbflip .34s cubic-bezier(.2,.7,.2,1); }
@keyframes cbflip { from { opacity: .1; transform: translateX(var(--cb-dir, 24px)) rotateY(8deg); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  #canticle-book, #canticle-book .cb-book { transition: none; }
  #canticle-book .cb-flip { animation: none; }
}
`;

export function createCanticleBook(opts: { onToggle: (open: boolean) => void }): CanticleBook {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  const root = document.createElement("div");
  root.id = "canticle-book";
  root.innerHTML = `
    <div class="cb-book" role="dialog" aria-modal="true" aria-label="The Canticle of the Creatures">
      <div class="cb-spine"></div>
      <div class="cb-page cb-left"><div class="cb-art" data-art></div><div class="cb-textwrap" data-cover-left hidden></div></div>
      <div class="cb-page cb-right"><div class="cb-textwrap" data-text></div></div>
      <button class="cb-nav cb-prev" aria-label="Previous page">‹</button>
      <button class="cb-nav cb-next" aria-label="Next page">›</button>
      <button class="cb-close" aria-label="Close book">✕</button>
      <div class="cb-counter" data-counter></div>
    </div>`;
  (document.getElementById("hud") ?? document.body).appendChild(root);

  const artEl = root.querySelector<HTMLElement>("[data-art]")!;
  const textEl = root.querySelector<HTMLElement>("[data-text]")!;
  const counterEl = root.querySelector<HTMLElement>("[data-counter]")!;
  const prevBtn = root.querySelector<HTMLButtonElement>(".cb-prev")!;
  const nextBtn = root.querySelector<HTMLButtonElement>(".cb-next")!;
  const closeBtn = root.querySelector<HTMLButtonElement>(".cb-close")!;
  const leftPage = root.querySelector<HTMLElement>(".cb-left")!;
  const rightPage = root.querySelector<HTMLElement>(".cb-right")!;

  let idx = 0;
  let open = false;

  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  function render(dir: number) {
    const s = SPREADS[idx];
    artEl.style.backgroundImage = `url('${ART}${s.art}.png')`;
    const cover = s.kind === "cover";
    if (cover) {
      textEl.innerHTML = `<div class="cb-title cb-cover-title">${esc(s.title)}</div><div class="cb-verse cb-cover-sub">${esc(s.verse)}</div>${s.note ? `<div class="cb-note" style="text-align:center;border:none">${esc(s.note)}</div>` : ""}`;
    } else {
      textEl.innerHTML = `<div class="cb-title">${esc(s.title)}</div><div class="cb-verse">${esc(s.verse)}</div>${s.note ? `<div class="cb-note">${esc(s.note)}</div>` : ""}`;
    }
    counterEl.textContent = cover ? "" : s.kind === "back" ? "The End" : `${idx} of ${SPREADS.length - 1}`;
    prevBtn.disabled = idx === 0;
    nextBtn.disabled = idx === SPREADS.length - 1;
    // flip animation
    const page = dir >= 0 ? rightPage : leftPage;
    page.style.setProperty("--cb-dir", dir >= 0 ? "24px" : "-24px");
    for (const p of [leftPage, rightPage]) p.classList.remove("cb-flip");
    void page.offsetWidth; // reflow to restart animation
    page.classList.add("cb-flip");
  }

  function go(delta: number) {
    const next = Math.min(SPREADS.length - 1, Math.max(0, idx + delta));
    if (next === idx) return;
    idx = next;
    render(delta);
  }

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") {
      go(1);
      e.preventDefault();
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      go(-1);
      e.preventDefault();
    } else if (e.key === "Escape") {
      api.close();
      e.preventDefault();
      e.stopPropagation();
    }
  }

  prevBtn.addEventListener("click", () => go(-1));
  nextBtn.addEventListener("click", () => go(1));
  closeBtn.addEventListener("click", () => api.close());
  // click the outer scrim to close; click a page half to flip
  root.addEventListener("click", (e) => {
    if (e.target === root) api.close();
  });
  leftPage.addEventListener("click", () => go(-1));
  rightPage.addEventListener("click", () => go(1));

  const api: CanticleBook = {
    get isOpen() {
      return open;
    },
    open() {
      if (open) return;
      open = true;
      idx = 0;
      render(1);
      root.classList.add("open");
      window.addEventListener("keydown", onKey, true);
      opts.onToggle(true);
    },
    close() {
      if (!open) return;
      open = false;
      root.classList.remove("open");
      window.removeEventListener("keydown", onKey, true);
      opts.onToggle(false);
    },
    toggle() {
      open ? api.close() : api.open();
    },
    dispose() {
      window.removeEventListener("keydown", onKey, true);
      root.remove();
    }
  };
  return api;
}
