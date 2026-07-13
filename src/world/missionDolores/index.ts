import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { GroundTopOverlay, WorldMap } from "../heightmap";
import { MuseumCtx, type MdWorldBox } from "./ctx";
import { buildBasilicaShell } from "./shell";
import { createCanticleBook, type CanticleBook } from "../../ui/canticleBook";
import { mdInsideFootprint } from "./layout";
import { createExhibits, type MdExhibit } from "./exhibits";

export * from "./layout";

/** Minimal HUD surface the museum needs (avoids importing the whole HUD type). */
interface MdHud {
  message(text: string, seconds?: number): void;
}

export interface MissionDoloresOptions {
  /** Called when the Canticle book opens/closes so the host can freeze the world. */
  onBookToggle?: (open: boolean) => void;
}

const BOOK_LOCAL = { x: 0, y: 0, z: -28 } as const; // pedestal on the centre line, in the narthex
const BOOK_REACH = 3.0;

export class MissionDoloresMuseum {
  readonly group = new THREE.Group();
  readonly floorTop: number;
  #map: WorldMap;
  #physics: Physics;
  #bodies: number[] = [];
  #overlay: GroundTopOverlay;
  #ctx: MuseumCtx;
  #exhibits: MdExhibit[] = [];
  #book: CanticleBook;
  #bookWorld: THREE.Vector3;
  #promptShown = false;

  constructor(map: WorldMap, physics: Physics, options: MissionDoloresOptions = {}) {
    this.#map = map;
    this.#physics = physics;
    this.group.name = "mission_dolores_museum";

    const shell = buildBasilicaShell(map);
    this.floorTop = shell.floorTop;
    this.group.add(shell.group);

    // wall + column colliders
    for (const box of shell.colliders) this.#registerStaticBox(box);

    // walkable floor + portal ramp (composes with other site overlays)
    this.#overlay = (x, z, base) => shell.groundTopAt(x, z, base) ?? base;
    map.setGroundTopOverlay(this.#overlay);

    // shared toolkit for the exhibits, rooted at the (positioned + rotated) shell group
    this.#ctx = new MuseumCtx({
      root: shell.group,
      map,
      floorTop: shell.floorTop,
      registerCollider: (b) => this.#registerStaticBox(b)
    });

    // the Canticle book + its pedestal
    this.#book = createCanticleBook({ onToggle: (open) => options.onBookToggle?.(open) });
    this.#bookWorld = this.#ctx.toWorld(BOOK_LOCAL.x, 1.05, BOOK_LOCAL.z);
    this.#buildPedestal();

    // exhibits (each self-contained, built against the frozen ctx)
    try {
      this.#exhibits = createExhibits(this.#ctx);
    } catch (err) {
      console.warn("[mission dolores] exhibits unavailable:", err);
    }
  }

  #registerStaticBox(box: MdWorldBox) {
    const body = this.#physics.world.createBox({
      type: BodyType.Static,
      position: [box.x, box.y, box.z],
      halfExtents: [box.hx, box.hy, box.hz],
      friction: 0.7
    });
    const quat: [number, number, number, number] = [0, Math.sin(box.yaw / 2), 0, Math.cos(box.yaw / 2)];
    this.#physics.world.setBodyTransform(body, [box.x, box.y, box.z], quat);
    this.#physics.addQuerySolid(body, box);
    this.#bodies.push(body);
  }

  #buildPedestal() {
    const c = this.#ctx;
    const g = new THREE.Group();
    g.name = "md_book_pedestal";
    g.position.set(BOOK_LOCAL.x, 0, BOOK_LOCAL.z);
    const stone = c.glowMat(0xcdb79a, 0.12, 0.8);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.75, 0.25, 16), stone);
    base.position.y = 0.125;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.65, 16), stone);
    shaft.position.y = 0.55;
    const top = new THREE.Mesh(new THREE.CylinderGeometry(0.62, 0.5, 0.16, 16), stone);
    top.position.y = 0.92;
    g.add(base, shaft, top);
    // a closed book resting on a slight slant, glowing to invite the reader
    const bookGrp = new THREE.Group();
    bookGrp.position.set(0, 1.02, 0);
    bookGrp.rotation.x = -0.32; // tilt toward an approaching visitor from −z
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.46), c.glowMat(0x7a3b26, 0.45, 0.55));
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.4), c.glowMat(0xf4e8cf, 0.6, 0.9));
    pages.position.y = 0.03;
    const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.02, 0.06), c.glowMat(0xd9a93b, 0.7, 0.4));
    clasp.position.y = 0.02;
    bookGrp.add(cover, pages, clasp);
    g.add(bookGrp);
    this.#ctx.root.add(g);
    // pedestal collider
    this.#ctx.addCollider({ lx: BOOK_LOCAL.x, ly: 0.55, lz: BOOK_LOCAL.z, hx: 0.6, hy: 0.6, hz: 0.6 });
  }

  /** E-chain hook: open the book when a walking player stands at the pedestal. */
  tryInteract(playerPos: THREE.Vector3, playerMode: string, hud: MdHud): boolean {
    if (playerMode !== "walk") return false;
    if (playerPos.distanceTo(this.#bookWorld) > BOOK_REACH) return false;
    if (!this.#book.isOpen) {
      this.#book.open();
      hud.message("The Canticle of the Creatures — ← → to turn the page, Esc to close", 3.5);
    }
    return true;
  }

  isPlayerInside(pos: THREE.Vector3): boolean {
    return mdInsideFootprint(pos.x, pos.z, 0.5) && Math.abs(pos.y - this.floorTop) < 6;
  }

  get bookOpen(): boolean {
    return this.#book.isOpen;
  }

  closeBook(): void {
    this.#book.close();
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3, playerMode: string, hud: MdHud): void {
    // proximity prompt latch for the book pedestal
    const near = playerMode === "walk" && !this.#book.isOpen && playerPos.distanceTo(this.#bookWorld) < BOOK_REACH + 0.4;
    if (near && !this.#promptShown) {
      hud.message("E — read the Canticle of the Creatures", 1.8);
      this.#promptShown = true;
    }
    if (!near) this.#promptShown = false;
    for (const ex of this.#exhibits) ex.update?.(dt, elapsed, playerPos);
  }

  addTo(scene: THREE.Scene): this {
    scene.add(this.group);
    return this;
  }

  dispose(): void {
    for (const ex of this.#exhibits) ex.dispose?.();
    this.#exhibits.length = 0;
    this.#book.dispose();
    this.#ctx.dispose();
    this.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) m.dispose();
      }
    });
    for (const body of this.#bodies) {
      this.#physics.removeQuerySolid(body);
      this.#physics.world.destroyBody(body);
    }
    this.#bodies.length = 0;
    this.#map.clearGroundTopOverlay(this.#overlay);
    this.group.removeFromParent();
  }
}

export function createMissionDoloresMuseum(map: WorldMap, physics: Physics, options?: MissionDoloresOptions) {
  return new MissionDoloresMuseum(map, physics, options);
}
