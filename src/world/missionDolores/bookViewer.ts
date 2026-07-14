// The Canticle of the Creatures — WebGPU 3D book viewer. Replaces the old DOM
// overlay (src/ui/canticleBook.ts) with a camera-attached group of unlit quads
// drawn straight into the WebGPU scene: no <img>, no HTML panel. Content
// (spreads: art names, titles, verses, notes) is carried over verbatim from
// the DOM version — only the rendering changed.
//
// Layered like a HUD: every mesh is MeshBasicMaterial with depthTest off, so
// nothing z-fights the frozen world behind it; paint order is guaranteed by
// strictly increasing renderOrder (scrim < book body/spine < pages < flip),
// per the common renderer's painterSortStable, which sorts by renderOrder before
// material/depth. Art loads as GPU-compressed KTX2 via loadTexture(); page
// text is baked into a small offscreen <canvas> → CanvasTexture (never
// attached to the document). Positioned every frame 1m in front of the
// camera, matching its orientation (see CalibrationChart / WorldCursor for
// the same camera-lock pattern elsewhere in this codebase).
import * as THREE from "three/webgpu";
import { loadTexture } from "../../render/textures";
import { CANVAS_FONT_FAMILY } from "../../core/typography";

export interface CanticleBookOptions {
  onToggle: (open: boolean) => void;
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

// ---------------------------------------------------------------------------
// Layout constants (metres, in the book's own local space before it's placed
// in front of the camera).
// ---------------------------------------------------------------------------
const BOOK_DISTANCE = 1.0; // metres in front of the camera
const BOOK_W = 1.4;
const BOOK_H = 0.9;
const SPINE_W = 0.035;
const PAGE_GAP = 0.015; // gap between a page's inner edge and the spine
const OUTER_MARGIN = 0.05; // leather border visible around the pages
const PAGE_W = (BOOK_W - SPINE_W - PAGE_GAP * 2 - OUTER_MARGIN * 2) / 2;
const PAGE_H = BOOK_H - OUTER_MARGIN * 2;
const PAGE_OFFSET_X = SPINE_W / 2 + PAGE_GAP + PAGE_W / 2;

const PARCHMENT = 0xf4ecd6;
const LEATHER = 0x5a3a1c;
const SPINE_DARK = 0x3f2712;
const SCRIM_COLOR = 0x0a0a0a;
const SCRIM_OPACITY = 0.72;

// Increasing so paint order (with depthTest off) is always correct. Half-step
// values guarantee spine-over-body and settled-vs-flipping ordering without
// relying on any implicit same-renderOrder tie-break.
const RENDER_ORDER = {
  scrim: 990,
  bodyBack: 991,
  bodySpine: 991.5,
  pageArt: 992,
  pageText: 993,
  flip: 994
} as const;

const FLIP_DURATION = 0.3; // seconds
const FLIP_SWING = 0.4; // radians (~23°) the incoming page swings in from
const FLIP_SCALE_FROM = 0.94;

// Small text canvas — well under the 512x768 budget.
const TEXT_W = 480;
const TEXT_H = 620;
const TEXT_FONT = CANVAS_FONT_FAMILY;

const TMP_FORWARD = new THREE.Vector3();

/** Word-wraps `text`, preserving explicit "\n" line breaks in the source. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim().length === 0) {
      out.push("");
      continue;
    }
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(test).width > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

type FlipSide = "left" | "right";

export class CanticleBook {
  #opts: CanticleBookOptions;
  #root = new THREE.Group();

  #geoms: THREE.BufferGeometry[] = [];
  #mats: THREE.Material[] = [];
  #ownedArtTextures: THREE.Texture[] = [];

  #leftPage: THREE.Mesh;
  #rightPage: THREE.Mesh;
  #leftMat: THREE.MeshStandardNodeMaterial;
  #rightMat: THREE.MeshStandardNodeMaterial;

  #textCanvas: HTMLCanvasElement;
  #textCtx: CanvasRenderingContext2D;
  #textTexture: THREE.CanvasTexture;

  #artPromises = new Map<number, Promise<THREE.Texture | null>>();
  #resolvedArt = new Map<number, THREE.Texture | null>();

  #open = false;
  #placed = false; // book is world-fixed on open (NOT re-posed each frame)
  #idx = 0;
  #flipSide: FlipSide = "right";
  #flipT = 1; // 1 = settled, no animation in flight
  #reducedMotion = false;

  constructor(scene: THREE.Scene, opts: CanticleBookOptions) {
    this.#opts = opts;
    this.#root.name = "canticleBookViewer";
    this.#root.visible = false;
    this.#root.frustumCulled = false;

    const mq = typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    this.#reducedMotion = mq?.matches ?? false;

    // ---- offscreen text canvas (right page) ----
    this.#textCanvas = document.createElement("canvas");
    this.#textCanvas.width = TEXT_W;
    this.#textCanvas.height = TEXT_H;
    const ctx2d = this.#textCanvas.getContext("2d");
    if (!ctx2d) throw new Error("CanticleBook: 2D canvas context unavailable");
    this.#textCtx = ctx2d;
    this.#textTexture = new THREE.CanvasTexture(this.#textCanvas);
    this.#textTexture.colorSpace = THREE.SRGBColorSpace;

    // ---- scrim: dims the frozen world behind the book ----
    const scrimGeo = this.#track(new THREE.PlaneGeometry(40, 40));
    const scrimMat = this.#trackMat(
      new THREE.MeshStandardNodeMaterial({
        color: 0x000000,
        emissive: new THREE.Color(SCRIM_COLOR),
        emissiveIntensity: 1,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: SCRIM_OPACITY,
        depthTest: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        side: THREE.DoubleSide
      })
    );
    const scrim = new THREE.Mesh(scrimGeo, scrimMat);
    scrim.position.z = -0.5;
    scrim.renderOrder = RENDER_ORDER.scrim;
    scrim.frustumCulled = false;
    this.#root.add(scrim);

    // ---- book body: leather backing + spine ----
    const bodyGeo = this.#track(new THREE.PlaneGeometry(BOOK_W + 0.12, BOOK_H + 0.12));
    const bodyMat = this.#trackMat(this.#opaqueMat(LEATHER));
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    body.position.z = -0.05;
    body.renderOrder = RENDER_ORDER.bodyBack;
    body.frustumCulled = false;
    this.#root.add(body);

    const spineGeo = this.#track(new THREE.PlaneGeometry(SPINE_W, BOOK_H + 0.1));
    const spineMat = this.#trackMat(this.#opaqueMat(SPINE_DARK));
    const spine = new THREE.Mesh(spineGeo, spineMat);
    spine.position.z = -0.03;
    spine.renderOrder = RENDER_ORDER.bodySpine;
    spine.frustumCulled = false;
    this.#root.add(spine);

    // ---- pages: left = art, right = baked text ----
    const pageGeo = this.#track(new THREE.PlaneGeometry(PAGE_W, PAGE_H));

    this.#leftMat = this.#trackMat(this.#opaqueMat(PARCHMENT));
    this.#leftPage = new THREE.Mesh(pageGeo, this.#leftMat);
    this.#leftPage.position.set(-PAGE_OFFSET_X, 0, 0.01);
    this.#leftPage.renderOrder = RENDER_ORDER.pageArt;
    this.#leftPage.frustumCulled = false;
    this.#root.add(this.#leftPage);

    this.#rightMat = this.#trackMat(this.#opaqueMat(0xffffff));
    this.#rightMat.map = this.#textTexture;
    this.#rightMat.emissiveMap = this.#textTexture;
    this.#rightMat.emissive.set(0xffffff);
    this.#rightMat.emissiveIntensity = 0.95;
    this.#rightPage = new THREE.Mesh(pageGeo, this.#rightMat);
    this.#rightPage.position.set(PAGE_OFFSET_X, 0, 0.01);
    this.#rightPage.renderOrder = RENDER_ORDER.pageText;
    this.#rightPage.frustumCulled = false;
    this.#root.add(this.#rightPage);

    scene.add(this.#root);
  }

  get isOpen(): boolean {
    return this.#open;
  }

  open(): void {
    if (this.#open) return;
    this.#open = true;
    this.#placed = false; // re-place in front of the camera on the next update
    this.#idx = 0;
    this.#root.visible = true;
    this.#renderSpread(1);
    window.addEventListener("keydown", this.#onKey, true);
    this.#opts.onToggle(true);
  }

  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.#root.visible = false;
    window.removeEventListener("keydown", this.#onKey, true);
    this.#opts.onToggle(false);
  }

  toggle(): void {
    if (this.#open) this.close();
    else this.open();
  }

  /** Call every frame while open. Places the book head-on in front of the camera
   *  ONCE (world-fixed thereafter — the player is frozen while reading), then
   *  drives the page-flip. We force updateMatrixWorld because the app disables
   *  the scene's automatic matrix pass, so a moved-but-unflushed group would
   *  render at the origin (off-screen). */
  update(dt: number, camera: THREE.PerspectiveCamera): void {
    if (!this.#open) return;

    if (!this.#placed) {
      camera.getWorldDirection(TMP_FORWARD);
      this.#root.position.copy(camera.position).addScaledVector(TMP_FORWARD, BOOK_DISTANCE);
      this.#root.quaternion.copy(camera.quaternion);
      this.#placed = true;
    }

    if (this.#flipT < 1) {
      this.#flipT = Math.min(1, this.#flipT + dt / FLIP_DURATION);
      const settled = this.#flipT >= 1;
      const mesh = this.#flipSide === "left" ? this.#leftPage : this.#rightPage;
      const eased = 1 - Math.pow(1 - this.#flipT, 3);
      const sign = this.#flipSide === "left" ? 1 : -1;
      mesh.rotation.y = settled ? 0 : sign * FLIP_SWING * (1 - eased);
      mesh.scale.setScalar(settled ? 1 : THREE.MathUtils.lerp(FLIP_SCALE_FROM, 1, eased));
      mesh.renderOrder = settled ? (this.#flipSide === "left" ? RENDER_ORDER.pageArt : RENDER_ORDER.pageText) : RENDER_ORDER.flip;
    }

    // The scene's auto matrix pass is off — flush the book's matrices ourselves
    // so the placement + flip actually reach the GPU this frame.
    this.#root.updateMatrixWorld(true);
  }

  dispose(): void {
    window.removeEventListener("keydown", this.#onKey, true);
    this.#root.removeFromParent();
    for (const g of this.#geoms) g.dispose();
    for (const m of this.#mats) m.dispose();
    for (const t of this.#ownedArtTextures) t.dispose();
    this.#textTexture.dispose();
    this.#artPromises.clear();
    this.#resolvedArt.clear();
  }

  // -------------------------------------------------------------------------
  #onKey = (e: KeyboardEvent): void => {
    if (!this.#open) return;
    switch (e.key) {
      case "ArrowRight":
      case " ":
      case "PageDown":
        this.#go(1);
        e.preventDefault();
        e.stopImmediatePropagation();
        break;
      case "ArrowLeft":
      case "PageUp":
        this.#go(-1);
        e.preventDefault();
        e.stopImmediatePropagation();
        break;
      case "Escape":
        this.close();
        e.preventDefault();
        e.stopImmediatePropagation();
        break;
    }
  };

  #go(delta: number): void {
    const next = Math.min(SPREADS.length - 1, Math.max(0, this.#idx + delta));
    if (next === this.#idx) return;
    this.#idx = next;
    this.#renderSpread(delta);
  }

  #renderSpread(dir: number): void {
    const idx = this.#idx;
    const spread = SPREADS[idx];
    if (!spread) return;

    // Right page text is cheap to redraw synchronously — always current.
    this.#drawTextCanvas(spread);
    this.#textTexture.needsUpdate = true;

    // Left page art — instant if already resolved, else parchment until it loads.
    const resolved = this.#resolvedArt.get(idx);
    if (resolved !== undefined) {
      this.#applyArt(idx, resolved);
    } else {
      this.#leftMat.map = null;
      this.#leftMat.emissiveMap = null;
      this.#leftMat.emissive.set(PARCHMENT);
      this.#leftMat.emissiveIntensity = 0.9;
      this.#leftMat.needsUpdate = true;
      void this.#ensureArt(idx).then((tex) => this.#applyArt(idx, tex));
    }
    // Lazy-load neighbors so flipping onward feels instant, without preloading everything.
    if (idx > 0) void this.#ensureArt(idx - 1);
    if (idx < SPREADS.length - 1) void this.#ensureArt(idx + 1);

    // Page-flip flourish.
    this.#flipSide = dir >= 0 ? "right" : "left";
    if (this.#reducedMotion) {
      this.#flipT = 1;
      this.#leftPage.rotation.y = 0;
      this.#leftPage.scale.setScalar(1);
      this.#leftPage.renderOrder = RENDER_ORDER.pageArt;
      this.#rightPage.rotation.y = 0;
      this.#rightPage.scale.setScalar(1);
      this.#rightPage.renderOrder = RENDER_ORDER.pageText;
    } else {
      this.#flipT = 0;
    }
  }

  #ensureArt(index: number): Promise<THREE.Texture | null> {
    const inflight = this.#artPromises.get(index);
    if (inflight) return inflight;
    const spread = SPREADS[index];
    if (!spread) return Promise.resolve(null);
    const p = loadTexture(ART + spread.art, { srgb: true })
      .then((tex) => {
        this.#ownedArtTextures.push(tex);
        this.#resolvedArt.set(index, tex);
        return tex;
      })
      .catch((err: unknown) => {
        console.warn("[bookViewer] failed to load art", spread.art, err);
        this.#resolvedArt.set(index, null);
        return null;
      });
    this.#artPromises.set(index, p);
    return p;
  }

  #applyArt(index: number, tex: THREE.Texture | null): void {
    if (index !== this.#idx || !tex) return; // stale nav or load failure — keep parchment
    this.#leftMat.map = tex;
    this.#leftMat.emissiveMap = tex;
    this.#leftMat.emissive.set(0xffffff);
    this.#leftMat.emissiveIntensity = 1;
    this.#leftMat.needsUpdate = true;
  }

  // Unlit basic materials render as nothing in this app's pipeline; the proven
  // pattern (plaques, apse windows, CalibrationChart) is an emissive Standard
  // node material — colour driven by `emissive` (+ `emissiveMap` for textures).
  #opaqueMat(color: number): THREE.MeshStandardNodeMaterial {
    return new THREE.MeshStandardNodeMaterial({
      color: 0x0b0b0b,
      emissive: new THREE.Color(color),
      emissiveIntensity: 0.9,
      roughness: 1,
      metalness: 0,
      depthTest: true,
      depthWrite: false,
      fog: false,
      toneMapped: false,
      side: THREE.DoubleSide
    });
  }

  #track<G extends THREE.BufferGeometry>(g: G): G {
    this.#geoms.push(g);
    return g;
  }

  #trackMat<M extends THREE.Material>(m: M): M {
    this.#mats.push(m);
    return m;
  }

  #drawTextCanvas(spread: Spread): void {
    const ctx = this.#textCtx;
    const W = TEXT_W;
    const H = TEXT_H;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#f4ecd6";
    ctx.fillRect(0, 0, W, H);
    ctx.textBaseline = "alphabetic";

    const cover = spread.kind === "cover";
    const padX = W * 0.11;
    const maxW = W - padX * 2;

    if (cover) {
      ctx.textAlign = "center";
      const titleSize = Math.round(W * 0.082);
      ctx.font = `700 ${titleSize}px ${TEXT_FONT}`;
      ctx.fillStyle = "#5a3d1e";
      const titleLines = wrapLines(ctx, spread.title, maxW);
      let y = H * 0.3 - ((titleLines.length - 1) * titleSize * 1.18) / 2;
      for (const line of titleLines) {
        ctx.fillText(line, W / 2, y);
        y += titleSize * 1.18;
      }
      y += titleSize * 0.4;

      const verseSize = Math.round(W * 0.048);
      ctx.font = `italic 400 ${verseSize}px ${TEXT_FONT}`;
      ctx.fillStyle = "#40301c";
      for (const line of wrapLines(ctx, spread.verse, maxW)) {
        ctx.fillText(line, W / 2, y);
        y += verseSize * 1.5;
      }

      if (spread.note) {
        y += verseSize * 0.6;
        const noteSize = Math.round(W * 0.034);
        ctx.font = `italic 400 ${noteSize}px ${TEXT_FONT}`;
        ctx.fillStyle = "#7a5a2e";
        for (const line of wrapLines(ctx, spread.note, maxW)) {
          ctx.fillText(line, W / 2, y);
          y += noteSize * 1.4;
        }
      }
      ctx.textAlign = "left";
      return;
    }

    ctx.textAlign = "left";
    let y = H * 0.1;
    const titleSize = Math.round(W * 0.072);
    ctx.font = `700 ${titleSize}px ${TEXT_FONT}`;
    ctx.fillStyle = "#5a3d1e";
    for (const line of wrapLines(ctx, spread.title, maxW)) {
      y += titleSize;
      ctx.fillText(line, padX, y);
      y += titleSize * 0.18;
    }
    y += titleSize * 0.45;

    const verseSize = Math.round(W * 0.05);
    ctx.font = `400 ${verseSize}px ${TEXT_FONT}`;
    ctx.fillStyle = "#40301c";
    for (const line of wrapLines(ctx, spread.verse, maxW)) {
      y += verseSize * 1.35;
      ctx.fillText(line, padX, y);
    }

    if (spread.note) {
      y += verseSize * 0.9;
      ctx.strokeStyle = "rgba(120,84,38,0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padX, y);
      ctx.lineTo(W - padX, y);
      ctx.stroke();
      y += verseSize * 0.7;

      const noteSize = Math.round(W * 0.036);
      ctx.font = `italic 400 ${noteSize}px ${TEXT_FONT}`;
      ctx.fillStyle = "#7a5a2e";
      for (const line of wrapLines(ctx, spread.note, maxW)) {
        y += noteSize * 1.3;
        ctx.fillText(line, padX, y);
      }
    }
  }
}
