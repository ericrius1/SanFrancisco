import * as THREE from "three/webgpu";
import { formatInteractPrompt } from "../../core/input";
import { BodyType, type Physics } from "../../core/physics";
import type { GroundTopOverlay, WorldMap } from "../heightmap";
import { MuseumCtx, type MdWorldBox, type MdWorldMesh } from "./ctx";
import { basilicaFloorTop, buildBasilicaShell } from "./shell";
import { createCanticleBook, type CanticleBook } from "../../ui/canticleBook";
import { MD_CENTER, mdInsideFootprint, mdInsideInterior, mdToWorldXZ } from "./layout";
import { createExhibits, type MdExhibit } from "./exhibits";
import type { RadialLightSource } from "../../render/radialLightTypes";

export * from "./layout";

/** Minimal HUD surface the museum needs (avoids importing the whole HUD type). */
interface MdHud {
  message(text: string, seconds?: number): void;
}

export interface MissionDoloresOptions {
  scene: THREE.Scene;
  renderer: THREE.WebGPURenderer;
  camera: THREE.PerspectiveCamera;
  /** Called when the Canticle book opens/closes so the host can freeze the world. */
  onBookToggle?: (open: boolean) => void;
}

const BOOK_LOCAL = { x: 0, y: 0, z: -28 } as const; // pedestal on the centre line, in the narthex
const BOOK_REACH = 3.0;
// Lazy-load hysteresis: the heavy shell + exhibits + KTX2 textures only build when
// the player comes near, and tear down (freeing the VRAM) when they wander far.
const BUILD_DIST = 150;
const DISPOSE_DIST = 240;

export class MissionDoloresMuseum {
  readonly group = new THREE.Group();
  readonly floorTop: number;
  #map: WorldMap;
  #physics: Physics;
  #opts: MissionDoloresOptions;
  #book: CanticleBook;
  #bookWorld: THREE.Vector3;
  #promptShown = false;

  // built lazily on approach:
  #built = false;
  #bodies: number[] = [];
  #overlay: GroundTopOverlay | null = null;
  #ctx: MuseumCtx | null = null;
  #exhibits: MdExhibit[] = [];
  #shell: THREE.Group | null = null;
  #floorHandoffPending = false;

  constructor(map: WorldMap, physics: Physics, options: MissionDoloresOptions) {
    this.#map = map;
    this.#physics = physics;
    this.#opts = options;
    this.group.name = "mission_dolores_museum";
    this.floorTop = basilicaFloorTop(map).floorTop;
    options.scene.add(this.group);
    // the Canticle book reader (WebP-illustrated storybook overlay)
    this.#book = createCanticleBook({ onToggle: (open) => options.onBookToggle?.(open) });
    const w = mdToWorldXZ(BOOK_LOCAL.x, BOOK_LOCAL.z);
    this.#bookWorld = new THREE.Vector3(w.x, this.floorTop + 1.05, w.z);
  }

  /* ------------------------------------------------ lazy build / teardown */

  #build() {
    if (this.#built) return;
    const shell = buildBasilicaShell(this.#map);
    this.#shell = shell.group;
    this.group.add(shell.group);
    for (const floor of shell.floorColliders) this.#registerStaticMesh(floor);
    for (const box of shell.colliders) this.#registerStaticBox(box);
    this.#overlay = (x, z, base) => shell.groundTopAt(x, z, base) ?? base;
    this.#map.setGroundTopOverlay(this.#overlay);
    this.#ctx = new MuseumCtx({
      root: shell.group,
      map: this.#map,
      floorTop: shell.floorTop,
      registerCollider: (b) => this.#registerStaticBox(b)
    });
    for (const surface of shell.radialSurfaces) this.#ctx.registerRadialSurface(surface);
    this.#buildPedestal(this.#ctx);
    try {
      this.#exhibits = createExhibits(this.#ctx);
    } catch (err) {
      console.warn("[mission dolores] exhibits unavailable:", err);
    }
    this.#built = true;
    this.#floorHandoffPending = true;
    // compile the hidden-until-now geometry off the critical path so the first
    // frame after arrival doesn't hitch on shader/pipeline creation.
    void this.#opts.renderer.compileAsync(shell.group, this.#opts.camera, this.#opts.scene);
  }

  #teardown() {
    if (!this.#built) return;
    for (const ex of this.#exhibits) ex.dispose?.();
    this.#exhibits = [];
    this.#ctx?.dispose();
    this.#ctx = null;
    if (this.#shell) {
      disposeTree(this.#shell);
      this.group.remove(this.#shell);
      this.#shell = null;
    }
    for (const body of this.#bodies) {
      this.#physics.removeQuerySolid(body);
      this.#physics.world.destroyBody(body);
    }
    this.#bodies.length = 0;
    if (this.#overlay) this.#map.clearGroundTopOverlay(this.#overlay);
    this.#overlay = null;
    this.#built = false;
    this.#floorHandoffPending = false;
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

  #registerStaticMesh(mesh: MdWorldMesh) {
    const body = this.#physics.world.createStaticMesh({
      position: [mesh.x, mesh.y, mesh.z],
      vertices: mesh.vertices,
      indices: mesh.indices,
      friction: 0.8
    });
    const quat: [number, number, number, number] = [0, Math.sin(mesh.yaw / 2), 0, Math.cos(mesh.yaw / 2)];
    this.#physics.world.setBodyTransform(body, [mesh.x, mesh.y, mesh.z], quat);
    // The height overlay remains the query/raycast authority. Mirroring this
    // top-only contact mesh would make the cursor classify the floor as a wall.
    this.#bodies.push(body);
  }

  #buildPedestal(c: MuseumCtx) {
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
    bookGrp.rotation.x = -0.32;
    const cover = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.07, 0.46), c.glowMat(0x7a3b26, 0.45, 0.55));
    const pages = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.06, 0.4), c.glowMat(0xf4e8cf, 0.6, 0.9));
    pages.position.y = 0.03;
    const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.02, 0.06), c.glowMat(0xd9a93b, 0.7, 0.4));
    clasp.position.y = 0.02;
    bookGrp.add(cover, pages, clasp);
    g.add(bookGrp);
    c.root.add(g);
    c.addCollider({ lx: BOOK_LOCAL.x, ly: 0.55, lz: BOOK_LOCAL.z, hx: 0.6, hy: 0.6, hz: 0.6 });
  }

  /* ------------------------------------------------------------- interaction */

  /** E-chain hook: open the book when a walking player stands at the pedestal. */
  tryInteract(playerPos: THREE.Vector3, playerMode: string, hud: MdHud): boolean {
    if (!this.#built || playerMode !== "walk") return false;
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

  /**
   * Consume the one-shot lazy-build floor handoff once a walking visitor is
   * actually over the interior. Main lifts an already-below capsule before the
   * next physics step replaces the old terrain patch with the raised overlay.
   */
  takeFloorHandoffHeight(pos: THREE.Vector3, playerMode: string): number | null {
    if (!this.#floorHandoffPending || !this.#built || playerMode !== "walk") return null;
    if (!mdInsideInterior(pos.x, pos.z, 0.1)) return null;
    this.#floorHandoffPending = false;
    return this.floorTop;
  }

  /** Strict doorway/interior gate used by optional museum-only render work. */
  isPlayerInInterior(pos: THREE.Vector3): boolean {
    return mdInsideInterior(pos.x, pos.z) && Math.abs(pos.y - this.floorTop) < 6;
  }

  get radialLightSource(): RadialLightSource | null {
    return this.#ctx?.acquireRadialLightSource() ?? null;
  }

  releaseRadialLightSource(): void {
    this.#ctx?.releaseRadialLightSource();
  }

  get bookOpen(): boolean {
    return this.#book.isOpen;
  }

  closeBook(): void {
    this.#book.close();
  }

  update(dt: number, elapsed: number, playerPos: THREE.Vector3, playerMode: string, hud: MdHud): void {
    const dx = playerPos.x - MD_CENTER.x;
    const dz = playerPos.z - MD_CENTER.z;
    const d2 = dx * dx + dz * dz;
    if (!this.#built) {
      if (d2 < BUILD_DIST * BUILD_DIST) this.#build();
      else return;
    } else if (!this.#book.isOpen && d2 > DISPOSE_DIST * DISPOSE_DIST) {
      this.#teardown();
      return;
    }

    const near = playerMode === "walk" && !this.#book.isOpen && playerPos.distanceTo(this.#bookWorld) < BOOK_REACH + 0.4;
    if (near && !this.#promptShown) {
      hud.message(formatInteractPrompt("read the Canticle of the Creatures"), 1.8);
      this.#promptShown = true;
    }
    if (!near) this.#promptShown = false;
    this.#ctx?.updateArt(playerPos);
    for (const ex of this.#exhibits) ex.update?.(dt, elapsed, playerPos);
  }

  dispose(): void {
    this.#teardown();
    this.#book.dispose();
    this.group.removeFromParent();
  }
}

function disposeTree(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m.dispose();
    }
  });
}

export function createMissionDoloresMuseum(map: WorldMap, physics: Physics, options: MissionDoloresOptions) {
  return new MissionDoloresMuseum(map, physics, options);
}
