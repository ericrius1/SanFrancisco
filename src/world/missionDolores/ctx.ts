import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { MD_YAW } from "./layout";
import { loadTexture } from "../../render/textures";

/** A yawed static collider box in WORLD space (what registerStaticBox consumes). */
export interface MdWorldBox {
  x: number;
  y: number;
  z: number;
  hx: number;
  hy: number;
  hz: number;
  yaw: number;
}

export interface MdPlaqueOpts {
  title: string;
  body: string;
  /** art asset name under /francis/art/<name>.png (optional). */
  art?: string;
  /** board size in metres (local). */
  w?: number;
  h?: number;
  /** local centre position [x, y, z]; y is the board's centre height. */
  pos: readonly [number, number, number];
  /** local yaw the board faces. 0 → faces +z (altar). +PI/2 → faces +x (east wall art faces into nave). -PI/2 → faces -x. PI → faces -z (entrance). */
  faceYaw?: number;
  /** frame accent tint (default warm bronze). */
  accent?: number;
  /** small italic caption under the body (e.g. the real Canticle line). */
  caption?: string;
}

const ART_BASE = "/francis/art/";
const ART_WAKE_DISTANCE = 26;

interface DeferredArt {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  material: THREE.MeshStandardMaterial;
  name: string;
  localPosition: readonly [number, number, number];
  maxDistanceSq: number;
  requested: boolean;
  fit: "contain" | "stretch";
}

/**
 * MuseumCtx — the frozen toolkit every Mission Dolores exhibit builds against.
 * Add your meshes to `ctx.root` in LOCAL coordinates (see layout.ts for the
 * frame). Never add a THREE light — the app runs a fixed LightPool, so anything
 * that must read in the dim nave self-lights via emissive materials (use
 * `glowMat`, or the plaques, which are emissive already).
 */
export class MuseumCtx {
  readonly THREE = THREE;
  readonly root: THREE.Group;
  readonly map: WorldMap;
  readonly floorTop: number;
  readonly yaw = MD_YAW;
  #artCache = new Map<string, Promise<THREE.Texture>>();
  #placeholder?: THREE.Texture;
  #registerCollider: (box: MdWorldBox) => void;
  #disposables: { dispose(): void }[] = [];
  #deferredArt: DeferredArt[] = [];
  #disposed = false;

  constructor(opts: {
    root: THREE.Group;
    map: WorldMap;
    floorTop: number;
    registerCollider: (box: MdWorldBox) => void;
  }) {
    this.root = opts.root;
    this.map = opts.map;
    this.floorTop = opts.floorTop;
    this.#registerCollider = opts.registerCollider;
  }

  /** Museum-local point → WORLD Vector3 (for colliders / raycasts). */
  toWorld(lx: number, ly: number, lz: number): THREE.Vector3 {
    const c = Math.cos(MD_YAW);
    const s = Math.sin(MD_YAW);
    return new THREE.Vector3(
      this.root.position.x + lx * c + lz * s,
      this.floorTop + ly,
      this.root.position.z - lx * s + lz * c
    );
  }

  /** Load /francis/art/<name> as a GPU-compressed KTX2 texture (WebP fallback).
   *  Cached per museum; resolves to a warm placeholder if missing. */
  loadArt(name: string): Promise<THREE.Texture> {
    const cached = this.#artCache.get(name);
    if (cached) return cached;
    const p = loadTexture(`${ART_BASE}${name}`)
      .then((tex) => {
        if (this.#disposed) {
          tex.dispose();
          throw new Error(`museum disposed before art resolved: ${name}`);
        }
        this.#disposables.push(tex);
        return tex;
      })
      .catch((err) => {
        if (this.#disposed) throw err;
        return this.#placeholderTex();
      });
    this.#artCache.set(name, p);
    return p;
  }

  /**
   * Bind authored art to a mesh without fetching it until the visitor reaches
   * that part of the museum. The shared texture is never mutated; CONTAIN is
   * implemented by scaling only this mesh over its warm matte.
   */
  bindArt(
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>,
    material: THREE.MeshStandardMaterial,
    name: string,
    localPosition: readonly [number, number, number],
    opts: { wakeDistance?: number; fit?: "contain" | "stretch" } = {}
  ): void {
    const wakeDistance = opts.wakeDistance ?? ART_WAKE_DISTANCE;
    mesh.name = `md_art_${name}`;
    mesh.visible = false;
    this.#deferredArt.push({
      mesh,
      material,
      name,
      localPosition,
      maxDistanceSq: wakeDistance * wakeDistance,
      requested: false,
      fit: opts.fit ?? "contain"
    });
  }

  /** Wake only the art surfaces close enough to matter to the current visit. */
  updateArt(playerPos: THREE.Vector3): void {
    if (this.#disposed) return;
    for (const art of this.#deferredArt) {
      if (art.requested) continue;
      const world = this.toWorld(art.localPosition[0], art.localPosition[1], art.localPosition[2]);
      if (playerPos.distanceToSquared(world) > art.maxDistanceSq) continue;
      art.requested = true;
      void this.loadArt(art.name)
        .then((tex) => {
          if (this.#disposed) return;
          art.material.map = tex;
          art.material.emissiveMap = tex;
          art.material.needsUpdate = true;
          if (art.fit === "contain") this.#containArt(art.mesh, tex);
          art.mesh.visible = true;
        })
        .catch(() => {
          // Teardown can legitimately win a race with a texture request.
        });
    }
  }

  #placeholderTex(): THREE.Texture {
    if (this.#placeholder) return this.#placeholder;
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    const g = c.getContext("2d")!;
    g.fillStyle = "#c9a86b";
    g.fillRect(0, 0, 8, 8);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    this.#placeholder = t;
    this.#disposables.push(t);
    return t;
  }

  /** A self-lighting standard material (emissive so it reads in the dim nave). */
  glowMat(color: number, emissiveBoost = 0.35, roughness = 0.7): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color,
      emissive: new THREE.Color(color),
      emissiveIntensity: emissiveBoost,
      roughness,
      metalness: 0
    });
    this.#disposables.push(m);
    return m;
  }

  /** Register a static collider box given in LOCAL coordinates. */
  addCollider(box: { lx: number; ly: number; lz: number; hx: number; hy: number; hz: number; lyaw?: number }): void {
    const w = this.toWorld(box.lx, box.ly, box.lz);
    this.#registerCollider({ x: w.x, y: w.y, z: w.z, hx: box.hx, hy: box.hy, hz: box.hz, yaw: MD_YAW + (box.lyaw ?? 0) });
  }

  /** Word-wrapped canvas → CanvasTexture. Good for captions and small labels. */
  textTexture(
    lines: { text: string; font: string; color: string; gap?: number }[],
    opts: { width?: number; height?: number; bg?: string; align?: CanvasTextAlign; padX?: number } = {}
  ): THREE.CanvasTexture {
    const W = opts.width ?? 1024;
    const H = opts.height ?? 512;
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const g = c.getContext("2d")!;
    if (opts.bg) {
      g.fillStyle = opts.bg;
      g.fillRect(0, 0, W, H);
    }
    g.textAlign = opts.align ?? "center";
    g.textBaseline = "middle";
    const x = opts.align === "left" ? (opts.padX ?? 40) : W / 2;
    let y = H / 2 - (lines.reduce((s, l) => s + (l.gap ?? 60), 0) - (lines[0]?.gap ?? 60)) / 2;
    for (const l of lines) {
      g.font = l.font;
      g.fillStyle = l.color;
      g.fillText(l.text, x, y);
      y += l.gap ?? 60;
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    this.#disposables.push(t);
    return t;
  }

  /**
   * Build a framed wall plaque (title + body paragraph + optional art image +
   * optional caption) as a Group in LOCAL space. Emissive so it reads in the
   * dim nave. Add the returned group to `ctx.root`.
   */
  makePlaque(opts: MdPlaqueOpts): THREE.Group {
    const W = opts.w ?? 2.4;
    const H = opts.h ?? 3.3;
    const accent = opts.accent ?? 0x8a6a3a;
    const grp = new THREE.Group();
    grp.name = `md_plaque_${opts.title.slice(0, 14)}`;
    grp.position.set(opts.pos[0], opts.pos[1], opts.pos[2]);
    grp.rotation.y = opts.faceYaw ?? 0;

    // frame (a slim raised border) + backing board
    const frameMat = new THREE.MeshStandardMaterial({
      color: accent,
      emissive: new THREE.Color(accent),
      emissiveIntensity: 0.14,
      roughness: 0.5,
      metalness: 0.25
    });
    this.#disposables.push(frameMat);
    const board = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.14), frameMat);
    board.name = `${grp.name}_frame`;
    board.castShadow = false;
    board.receiveShadow = true;
    grp.add(board);

    const hasArt = !!opts.art;
    const artFrac = hasArt ? 0.6 : 0; // top 60% art, rest text
    const pad = 0.12;
    const innerW = W - pad * 2;
    const innerH = H - pad * 2;

    // ---- text panel (parchment canvas) on the lower part (or whole board) ----
    const textH = innerH * (1 - artFrac);
    const textTop = innerH / 2 - innerH * artFrac; // local y top of text region within inner
    const panelCanvas = document.createElement("canvas");
    panelCanvas.width = 1024;
    panelCanvas.height = Math.round((1024 / innerW) * textH);
    const pg = panelCanvas.getContext("2d")!;
    // warm parchment
    const grad = pg.createLinearGradient(0, 0, 0, panelCanvas.height);
    grad.addColorStop(0, "#f6ecd4");
    grad.addColorStop(1, "#eaddbe");
    pg.fillStyle = grad;
    pg.fillRect(0, 0, panelCanvas.width, panelCanvas.height);
    // title
    pg.textAlign = "center";
    pg.textBaseline = "top";
    pg.fillStyle = "#5a3d1e";
    pg.font = "600 62px Georgia, 'Times New Roman', serif";
    let ty = 26;
    ty = this.#wrapText(pg, opts.title, panelCanvas.width / 2, ty, panelCanvas.width - 80, 66);
    ty += 12;
    // divider
    pg.strokeStyle = "rgba(120,84,38,0.4)";
    pg.lineWidth = 3;
    pg.beginPath();
    pg.moveTo(panelCanvas.width * 0.28, ty);
    pg.lineTo(panelCanvas.width * 0.72, ty);
    pg.stroke();
    ty += 24;
    // body
    pg.fillStyle = "#3f2f1c";
    pg.font = "400 40px Georgia, 'Times New Roman', serif";
    ty = this.#wrapText(pg, opts.body, panelCanvas.width / 2, ty, panelCanvas.width - 90, 52);
    // caption (italic)
    if (opts.caption) {
      ty += 18;
      pg.fillStyle = "#7a5a2e";
      pg.font = "italic 34px Georgia, 'Times New Roman', serif";
      this.#wrapText(pg, opts.caption, panelCanvas.width / 2, ty, panelCanvas.width - 90, 44);
    }
    const panelTex = new THREE.CanvasTexture(panelCanvas);
    panelTex.colorSpace = THREE.SRGBColorSpace;
    panelTex.anisotropy = 4;
    this.#disposables.push(panelTex);
    const panelMat = new THREE.MeshStandardMaterial({
      map: panelTex,
      emissiveMap: panelTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.5,
      roughness: 0.85,
      metalness: 0
    });
    this.#disposables.push(panelMat);
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(innerW, textH), panelMat);
    panel.position.set(0, textTop - textH / 2, 0.08);
    panel.name = `${grp.name}_text`;
    grp.add(panel);

    // ---- art plane (top) — filled in when the texture loads ----
    if (hasArt) {
      const artH = innerH * artFrac;
      const artMat = new THREE.MeshStandardMaterial({
        color: 0xf3e5c8,
        emissive: 0xf3e5c8,
        emissiveIntensity: 0.35,
        roughness: 0.9,
        metalness: 0
      });
      this.#disposables.push(artMat);
      const matteMat = new THREE.MeshStandardMaterial({
        color: 0xd7c39c,
        emissive: 0xd7c39c,
        emissiveIntensity: 0.16,
        roughness: 0.94,
        metalness: 0
      });
      this.#disposables.push(matteMat);
      const matte = new THREE.Mesh(new THREE.PlaneGeometry(innerW, artH), matteMat);
      matte.position.set(0, innerH / 2 - artH / 2, 0.08);
      matte.name = `${grp.name}_art_matte`;
      grp.add(matte);
      const art = new THREE.Mesh(new THREE.PlaneGeometry(innerW, artH), artMat);
      art.position.set(0, innerH / 2 - artH / 2, 0.084);
      grp.add(art);
      this.bindArt(art, artMat, opts.art!, opts.pos);
    }

    return grp;
  }

  #wrapText(g: CanvasRenderingContext2D, text: string, cx: number, y: number, maxW: number, lh: number): number {
    const words = text.split(/\s+/);
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (g.measureText(test).width > maxW && line) {
        g.fillText(line, cx, y);
        y += lh;
        line = w;
      } else {
        line = test;
      }
    }
    if (line) {
      g.fillText(line, cx, y);
      y += lh;
    }
    return y;
  }

  #containArt(mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>, tex: THREE.Texture): void {
    const image = tex.image as { width?: number; height?: number } | undefined;
    const iw = image?.width ?? 0;
    const ih = image?.height ?? 0;
    const geo = (mesh.geometry as THREE.PlaneGeometry).parameters;
    if (!(iw > 0 && ih > 0 && geo?.width > 0 && geo?.height > 0)) return;
    const imageAspect = iw / ih;
    const slotAspect = geo.width / geo.height;
    if (imageAspect > slotAspect) mesh.scale.set(1, slotAspect / imageAspect, 1);
    else mesh.scale.set(imageAspect / slotAspect, 1, 1);
    mesh.updateMatrix();
    mesh.updateMatrixWorld(true);
  }

  dispose(): void {
    this.#disposed = true;
    this.#deferredArt.length = 0;
    for (const d of this.#disposables) d.dispose();
    this.#disposables.length = 0;
    this.#artCache.clear();
  }
}
