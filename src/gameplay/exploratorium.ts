import * as THREE from "three/webgpu";
import { BodyType } from "../core/physics";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import {
  cos,
  exp,
  float,
  floor,
  fract,
  hash,
  instanceIndex,
  mix,
  positionLocal,
  saturate,
  sin,
  smoothstep,
  uniform,
  uniformArray,
  vec3,
  vertexStage
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { effectsAudioLevel } from "../core/audioSettings";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";
import type { TileStreamer } from "../world/tiles";
import { GrainSim, RipplePool } from "./exhibits";
import { FluidSim } from "./fluidSim";

type N = any;

/**
 * The Exploratorium — Pier 15 rebuilt with a walkable interior. The OSM shed
 * (tile 14_9, building 1) is suppressed and replaced by a purpose-built hall:
 * a lobby, the Particle Worlds gallery (GPU sand + a protoplanetary disc), the
 * Water Works room (SPH tank + a pokeable ripple pool) and a domed theater
 * where a piano paints expanding rings of light across the planetarium sky.
 *
 * Everything is aggressively locality-gated: geometry builds when you approach
 * the pier, colliders exist only nearby, and each exhibit's compute dispatches
 * only while you stand in its room. Far away, the whole museum costs nothing
 * per frame beyond one distance check.
 */

// ---- the shed's OBB, straight from the baked collider (tile 14_9, i=1)
const KEY = "14_9";
const BID = 1;
const CX = 4084.7;
const CZ = -1271.5;
const YAW = -2.523; // deck-aligned (post-rebake the shed splits to sub-boxes; footprint is the same)
const COS = Math.cos(YAW);
const SIN = Math.sin(YAW);
const HL = 125.6; // half length: +u = shore/entrance end, -u = bay end
const HW = 31.4; // half width: +v = the Pier 17 side
const FLOOR = 3.78; // walking surface — the pier apron tops out at ~3.7
// The whole museum only DRAWS when you're at the pier. Past this many metres
// outside the shell its group is hidden, so the shell mesh, dome sky shader,
// signage and plaques cost nothing to render — only a distance check remains.
const VISIBLE_MARGIN = 80;

const DOME_C = { u: -72, v: 0 }; // dome theater center
// Star Table: exhibit centre (u,v) and the half-extent its sim frame origin is
// offset by — the stir mapping must match the frame passed at construction
const STAR_U = 42;
const STAR_V = 9;
const STAR_HALF = 3.7;
const DOME_R = 10.5;
const DOME_WALL_R = DOME_R + 0.1; // ring-wall radius, just inside the shell
// The ring wall is a full circle minus a doorway centred on +u (angle 0) — the
// direction you enter from the hall on teleport. DOME_DOOR_HALF is half the
// doorway's angular width; the rest of the arc is filled by DOME_WALL_SEGS even
// posts, each DOME_POST_HV long (half the per-post arc chord, + overlap) so the
// wall closes solid with a single clean opening.
const DOME_DOOR_HALF = 0.12; // ~2.5 m walk-through opening at the wall
const DOME_WALL_SEGS = 12;
const DOME_WALL_SPAN = Math.PI * 2 - 2 * DOME_DOOR_HALF;
const DOME_POST_HV = (DOME_WALL_SPAN / DOME_WALL_SEGS) * 0.5 * DOME_WALL_R + 0.09;
const PIANO_U = DOME_C.u + 2.35;
const PIANO_V = 0;
const PIANO_NEAR = 2.8;

/** Minimal HTML escape for plaque text dropped into the reading overlay. */
function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// world <-> pier-local (matches physics' OBB convention exactly)
function toLocal(x: number, z: number): { u: number; v: number } {
  const dx = x - CX;
  const dz = z - CZ;
  return { u: dx * COS - dz * SIN, v: dx * SIN + dz * COS };
}

// pier-frame guide points for the tutorial (ui/tutorial.ts)
function pierWorld(u: number, v: number): { x: number; z: number } {
  return { x: CX + u * COS + v * SIN, z: CZ - u * SIN + v * COS };
}
/** Is a world point on the pier footprint (inside the museum shell)? */
export function insidePier(x: number, z: number): boolean {
  const { u, v } = toLocal(x, z);
  return Math.abs(u) < HL && Math.abs(v) < HW;
}
/** Just outside the front doors, facing down the hall. */
export const PIER_ENTRANCE = (() => {
  const p = pierWorld(HL + 9, 0);
  // forward(θ) = (−sinθ, −cosθ); face −u (into the pier) ⇒ θ = atan2(COS, −SIN)
  return { x: p.x, y: FLOOR + 1.2, z: p.z, facing: Math.atan2(COS, -SIN) };
})();
/** Dome theater center, world space. */
export const DOME_WORLD = pierWorld(DOME_C.u, DOME_C.v);
/**
 * In front of the Water Works wave tank, centred on the SPH screen (plane at
 * v=-28.72, u∈[-22.5,-17.5]) and stood ~7 m back on the room side, facing it.
 * face −v (toward the screen): forward=(−SIN,−COS) ⇒ θ = YAW.
 */
export const WATER_VIEW = (() => {
  const p = pierWorld(-20, -21.7);
  return { x: p.x, y: FLOOR + 1.2, z: p.z, facing: YAW };
})();

const NOTE_SLOTS = 16;
const KEY_COUNT = 8;
const SCALE_SEMIS = [0, 2, 4, 5, 7, 9, 11, 12]; // C major — both instruments
const KEY_HUES = [0.0, 0.09, 0.16, 0.3, 0.5, 0.6, 0.74, 0.86];
// instrument indices on the wire (net "note" messages carry [instrument, key])
export const INST_PIANO = 0;
export const INST_HARP = 1;

type PanelHit = {
  sim: GrainSim | FluidSim;
  v0: number; // plane
  uMin: number;
  uMax: number;
  yMin: number;
  yMax: number;
};

type Plaque = {
  u: number;
  v: number;
  caption: string;
  cool: number;
  title: string;
  body: string;
  accent: string;
};

type RoomId = "lobby" | "gallery" | "water" | "dome" | null;

export class Exploratorium {
  onMessage: (text: string, seconds?: number) => void = () => {};
  /** A local visitor played a note — main.ts broadcasts it to the room. */
  onNote: (instrument: number, key: number) => void = () => {};

  #renderer: THREE.WebGPURenderer;
  #physics: Physics;
  #scene: THREE.Scene;

  #group: THREE.Group | null = null;
  #built = false;
  #bodies: number[] = [];

  #inside = false;
  #room: RoomId = null;
  #roomToast = new Set<string>();

  #sand: GrainSim | null = null;
  #stars: GrainSim | null = null;
  #sph: FluidSim | null = null;
  #pool: RipplePool | null = null;
  #panels: PanelHit[] = [];
  #plaques: Plaque[] = [];

  // full-screen "read the plaque" overlay
  #plaqueEl: HTMLDivElement | null = null;
  #openPlaque: Plaque | null = null;

  // dome show state
  #domeTime = uniform(0);
  #noteA = uniformArray(Array.from({ length: NOTE_SLOTS }, () => new THREE.Vector4(0, 1, 0, -100)));
  #noteB = uniformArray(Array.from({ length: NOTE_SLOTS }, () => new THREE.Vector4(0, 0, 0, 0)));
  #noteCursor = 0;
  #noteEnergy = uniform(0);
  #keyGlow = uniformArray(Array.from({ length: KEY_COUNT }, () => 0));
  #stringGlow = uniformArray(Array.from({ length: KEY_COUNT }, () => 0));
  #keys: THREE.InstancedMesh | null = null;
  #strings: THREE.InstancedMesh | null = null; // invisible fat hit volumes
  #audio = new MuseumAudio();
  #ray = new THREE.Raycaster();
  #pokeCooldown = 0;
  #tankStirred = false; // a click drove the wave tank this frame (beats walk-near)
  #playerPos = new THREE.Vector3();
  #notesLocal = 0;
  #notesRemote = 0;
  #pianoEngaged = false;
  #pianoHint = 0;

  #paintHits: THREE.Intersection[] = [];
  #hitPt = new THREE.Vector3();
  #hitNrm = new THREE.Vector3();
  #normalMatrix = new THREE.Matrix3();

  constructor(renderer: THREE.WebGPURenderer, physics: Physics, _map: WorldMap, scene: THREE.Scene, tiles: TileStreamer) {
    this.#renderer = renderer;
    this.#physics = physics;
    this.#scene = scene;
    // the OSM shed dies the moment its tile streams in; we own this footprint
    tiles.suppressBuilding(KEY, BID);
  }

  /* ================================================== zone + frame update */

  state() {
    return {
      built: this.#built,
      inside: this.#inside,
      room: this.#room,
      colliders: this.#bodies.length,
      noteEnergy: this.#noteEnergy.value as number,
      notesLocal: this.#notesLocal,
      notesRemote: this.#notesRemote,
      pianoEngaged: this.#pianoEngaged,
      sphStirs: this.#sph?.stirs ?? 0,
      dispatches: {
        sand: this.#sand?.dispatches ?? 0,
        stars: this.#stars?.dispatches ?? 0,
        sph: this.#sph?.dispatches ?? 0,
        pool: this.#pool?.dispatches ?? 0
      }
    };
  }

  update(dt: number, _elapsed: number, playerPos: THREE.Vector3) {
    this.#playerPos.copy(playerPos);
    const { u, v } = toLocal(playerPos.x, playerPos.z);
    const eu = Math.max(0, Math.abs(u) - HL);
    const ev = Math.max(0, Math.abs(v) - HW);
    const d = Math.hypot(eu, ev);

    if (!this.#built && d < 380) this.#build();
    if (!this.#built) return;

    if (d < 300 && this.#bodies.length === 0) this.#createColliders();
    else if (d > 380 && this.#bodies.length > 0) this.#dropColliders();

    // hide the whole museum unless you're right at the pier — far away it draws
    // nothing. Bail before any per-frame exhibit work; if we left a room active
    // (e.g. a teleport straight out), stop its compute on the way out.
    const near = d < VISIBLE_MARGIN;
    if (this.#group && this.#group.visible !== near) this.#group.visible = near;
    if (!near) {
      this.#inside = false;
      if (this.#room !== null) {
        this.#room = null;
        this.#onRoomChange(null);
      }
      return;
    }

    const y = playerPos.y;
    this.#inside =
      Math.abs(u) < HL && Math.abs(v) < HW && u > -100 && y > FLOOR - 1.5 && y < FLOOR + 10;

    let room: RoomId = null;
    if (this.#inside) {
      const dd = Math.hypot(u - DOME_C.u, v - DOME_C.v);
      if (dd < DOME_R + 0.6) room = "dome";
      else if (u >= 10 && u < 95) room = "gallery";
      else if (u >= -45 && u < 10) room = "water";
      else if (u >= 95) room = "lobby";
    }
    if (room !== this.#room) {
      this.#room = room;
      this.#onRoomChange(room);
    }

    // walk right up to the wave tank and the water reacts to you — a gentle
    // stir tracks your position along the glass (a click-sweep, handled in
    // handleFire, overrides it and drags harder)
    if (this.#sph && room === "water" && !this.#tankStirred) {
      const uMin = -22.5;
      const uMax = -17.5;
      const dv = Math.abs(v - -28.72); // distance from the tank's glass
      if (dv < 3.0 && u > uMin - 1.1 && u < uMax + 1.1) {
        const lx = Math.min(Math.max(u - uMin, 0), uMax - uMin);
        this.#sph.stir(lx, 0.7, true); // low, into the settled water body
      }
    }

    // exhibits tick only while their room hosts the player
    this.#sand?.update(dt);
    this.#stars?.update(dt);
    this.#sph?.update(dt);
    this.#pool?.update(dt);

    // the dome's clock only runs with someone under it; flashes decay always
    // (a friend's remote note must not leave a crystal stuck lit)
    if (room === "dome") this.#domeTime.value = (this.#domeTime.value as number) + dt;
    this.#noteEnergy.value = Math.max(0, (this.#noteEnergy.value as number) - dt * 0.55);
    const kg = this.#keyGlow.array as unknown as number[];
    const sg = this.#stringGlow.array as unknown as number[];
    for (let i = 0; i < KEY_COUNT; i++) {
      kg[i] = Math.max(0, kg[i] - dt * 3.2);
      sg[i] = Math.max(0, sg[i] - dt * 2.2);
    }

    // walk away from the plaque you're reading and the overlay drops
    if (this.#openPlaque && Math.hypot(u - this.#openPlaque.u, v - this.#openPlaque.v) > 4) {
      this.#closePlaque();
    }

    // plaque captions: stroll close and the HUD teases the label + how to read it
    if ((this.#inside || d < 30) && !this.#openPlaque) {
      for (const p of this.#plaques) {
        p.cool = Math.max(0, p.cool - dt);
        if (Math.hypot(u - p.u, v - p.v) < 2.7) {
          if (p.cool === 0) this.onMessage(`${p.caption}  ·  press E to read`, 4.2);
          p.cool = 9; // re-read only after stepping away a while
        }
      }
    }

    if (this.#pianoEngaged && (room !== "dome" || Math.hypot(u - PIANO_U, v - PIANO_V) > PIANO_NEAR + 1.2)) {
      this.#pianoEngaged = false;
    }
    if (room === "dome" && !this.#pianoEngaged) {
      this.#pianoHint = Math.max(0, this.#pianoHint - dt);
      if (this.#pianoHint === 0 && Math.hypot(u - PIANO_U, v - PIANO_V) < PIANO_NEAR) {
        this.#pianoHint = 14;
        this.onMessage("Press E at the piano to play", 3.2);
      }
    }

    this.#pokeCooldown = Math.max(0, this.#pokeCooldown - dt);
    // stirs are re-asserted by handleFire every held frame (which runs before
    // this update); clear here so releasing the click stops the machinery.
    // (FluidSim self-clears in its own update, so the wave tank isn't listed.)
    this.#sand?.stir(0, 0, false);
    this.#stars?.stir(0, 0, false);
    this.#tankStirred = false; // re-armed next frame by handleFire if clicked
  }

  #onRoomChange(room: RoomId) {
    if (!this.#group) return;
    if (room === "gallery" && !this.#sand) {
      this.#sand = new GrainSim(this.#renderer, this.#group, this.#frame(69, FLOOR + 0.85, -28.72, "panel"), {
        mode: "sand",
        n: 5000,
        w: 6,
        h: 3.4,
        cell: 0.05,
        size: 0.052
      });
      this.#stars = new GrainSim(this.#renderer, this.#group, this.#frame(STAR_U - STAR_HALF, FLOOR + 1.14, STAR_V + STAR_HALF, "table"), {
        mode: "stars",
        n: 14000,
        w: 7.4,
        h: 7.4,
        cell: 0.08,
        size: 0.05
      });
      this.#panels.push({ sim: this.#sand, v0: -28.72, uMin: 69, uMax: 75, yMin: FLOOR + 0.85, yMax: FLOOR + 4.25 });
    }
    if (room === "water" && !this.#sph) {
      // grid-sorted raw-WGSL SPH (see fluidSim.ts) — fast and can't O(k²)-hang
      this.#sph = new FluidSim(
        this.#renderer,
        this.#group,
        {
          origin: new THREE.Vector3(-22.5, FLOOR + 0.85, -28.72),
          ax: new THREE.Vector3(1, 0, 0),
          ay: new THREE.Vector3(0, 1, 0),
          w: 5,
          h: 3
        },
        48000,
        0.03
      );
      this.#panels.push({ sim: this.#sph, v0: -28.72, uMin: -22.5, uMax: -17.5, yMin: FLOOR + 0.85, yMax: FLOOR + 3.85 });
    }
    // leaving a room (or the museum entirely, room = null) stops its compute
    this.#sand?.setActive(room === "gallery");
    this.#stars?.setActive(room === "gallery");
    this.#sph?.setActive(room === "water");
    this.#pool?.setActive(room === "water");

    if (room && !this.#roomToast.has(room)) {
      this.#roomToast.add(room);
      const toast = {
        lobby: "The Exploratorium — walk the halls, read the plaques",
        gallery: "Particle Worlds — hold click on the sand and the star table",
        water: "Water Works — click the pool, drag the wave tank",
        dome: "Dome Theater — press E at the piano to play · harp across the room"
      }[room];
      this.onMessage(toast, 4);
    }
  }

  /** Frame helper: local pier coords -> a GrainSim basis inside the group. */
  #frame(u: number, y: number, v: number, kind: "panel" | "table") {
    // exhibits parent to the museum group, so frames stay in pier-local space
    return kind === "panel"
      ? { origin: new THREE.Vector3(u, y, v), ax: new THREE.Vector3(1, 0, 0), ay: new THREE.Vector3(0, 1, 0) }
      : { origin: new THREE.Vector3(u, y, v), ax: new THREE.Vector3(1, 0, 0), ay: new THREE.Vector3(0, 0, -1) };
  }

  /* ======================================================= interaction */

  /** Seated at the piano — main.ts parks the digit-key mode switcher. */
  get pianoBusy(): boolean {
    return this.#pianoEngaged;
  }

  /** True while the plaque reading overlay is up — main.ts parks other keys. */
  get plaqueOpen(): boolean {
    return this.#openPlaque !== null;
  }

  /**
   * E inside the museum: close an open plaque, else read the nearest plaque,
   * else (in the dome, at the console) sit down at the piano. Returns true when
   * E was consumed so main.ts leaves vehicles/exit alone.
   */
  tryInteract(): boolean {
    if (!this.#built || !this.#inside) return false;
    // an open plaque swallows E first — read, then E again to step away
    if (this.#openPlaque) {
      this.#closePlaque(true);
      return true;
    }
    const { u, v } = toLocal(this.#playerPos.x, this.#playerPos.z);

    // at the dome console, E sits down to play (the piano wins its own spot)
    if (this.#room === "dome" && Math.hypot(u - PIANO_U, v - PIANO_V) <= PIANO_NEAR) {
      this.#pianoEngaged = !this.#pianoEngaged;
      this.onMessage(
        this.#pianoEngaged ? "At the piano — click keys or 1–8 to play · E to step back" : "Stepped back from the piano",
        3.4
      );
      return true;
    }

    // otherwise, read whichever plaque you're standing at
    let best: Plaque | null = null;
    let bd = 2.7;
    for (const p of this.#plaques) {
      const d = Math.hypot(u - p.u, v - p.v);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best) {
      this.#showPlaque(best);
      return true;
    }
    return false;
  }

  /* ------------------------------------------------- plaque reading overlay */

  #showPlaque(p: Plaque) {
    this.#openPlaque = p;
    let el = this.#plaqueEl;
    if (!el) {
      el = document.createElement("div");
      el.id = "sf-plaque-overlay";
      el.addEventListener("click", (e) => {
        // click the dim backdrop or the close button to dismiss (and re-lock)
        if (e.target === el || (e.target as HTMLElement).closest("[data-close]")) this.#closePlaque(true);
      });
      window.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && this.#openPlaque) this.#closePlaque(true);
      });
      document.body.appendChild(el);
      this.#plaqueEl = el;
    }
    el.style.cssText =
      "position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;" +
      "background:rgba(6,9,14,0.62);backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);" +
      "font-family:system-ui,sans-serif;cursor:pointer;animation:none;";
    el.innerHTML =
      `<div style="max-width:620px;width:calc(100% - 48px);max-height:82vh;overflow:auto;cursor:auto;` +
      `background:#101418;color:#f5f2ea;border-radius:14px;border-top:6px solid ${p.accent};` +
      `box-shadow:0 24px 80px rgba(0,0,0,0.6);padding:34px 38px;">` +
      `<div style="font:700 30px/1.2 system-ui,sans-serif;margin-bottom:16px;">${esc(p.title)}</div>` +
      `<div style="font:400 18px/1.62 system-ui,sans-serif;color:#d3d8de;">${esc(p.body)}</div>` +
      `<div style="display:flex;align-items:center;justify-content:space-between;margin-top:26px;">` +
      `<span style="font:italic 15px system-ui,sans-serif;color:${p.accent};">Exploratorium · Pier 15</span>` +
      `<button data-close style="cursor:pointer;border:1px solid #3a3f47;background:#1b2027;color:#f5f2ea;` +
      `border-radius:8px;padding:8px 16px;font:600 14px system-ui,sans-serif;">Close · E</button>` +
      `</div></div>`;
    el.style.display = "flex";
    // free the locked cursor so the reader can scroll / click Close; a locked
    // pointer would also route clicks to the canvas and fire a tool underneath
    document.exitPointerLock?.();
  }

  #closePlaque(relock = false) {
    this.#openPlaque = null;
    if (this.#plaqueEl) this.#plaqueEl.style.display = "none";
    // re-grab the pointer when the close came from a real gesture (E/click/Esc)
    if (relock) {
      try {
        this.#renderer.domElement.requestPointerLock?.();
      } catch {
        /* not a user gesture — the next canvas click re-locks */
      }
    }
  }

  /** Number keys while seated at the piano. Returns true when a note sounded. */
  handlePianoInput(pressed: (code: string) => boolean): boolean {
    if (!this.#pianoEngaged) return false;
    const codes = ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6", "Digit7", "Digit8"];
    for (let k = 0; k < KEY_COUNT; k++) {
      if (pressed(codes[k])) {
        this.#playNote(INST_PIANO, k, false);
        return true;
      }
    }
    return false;
  }

  /**
   * Ray vs the museum shell and exhibits — paintballs use this because the
   * custom interior isn't in the OSM tile colliders.
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { point: THREE.Vector3; normal: THREE.Vector3 } | null {
    if (!this.#built || !this.#group) return null;
    this.#ray.set(origin, dir);
    this.#ray.near = 0.001;
    this.#ray.far = maxDist;
    this.#paintHits.length = 0;
    this.#ray.intersectObject(this.#group, true, this.#paintHits);
    for (const h of this.#paintHits) {
      const o = h.object;
      if (!(o instanceof THREE.Mesh) || o === this.#strings || !o.visible) continue;
      const mat = o.material;
      if (mat && !(Array.isArray(mat) ? mat.some((m) => m.visible) : mat.visible)) continue;
      if (!h.face) continue;
      this.#hitPt.copy(h.point);
      this.#normalMatrix.getNormalMatrix(o.matrixWorld);
      this.#hitNrm.copy(h.face.normal).applyMatrix3(this.#normalMatrix).normalize();
      return { point: this.#hitPt, normal: this.#hitNrm };
    }
    return null;
  }

  #pianoKeyFromRay(origin: THREE.Vector3, dir: THREE.Vector3): number | null {
    const py = FLOOR + 1.02;
    if (Math.abs(dir.y) < 1e-4) return null;
    const t = (py - origin.y) / dir.y;
    if (t < 0 || t > 12) return null;
    const { u, v } = toLocal(origin.x + dir.x * t, origin.z + dir.z * t);
    if (Math.abs(u - PIANO_U) > 0.75 || Math.abs(v) > 1.7) return null;
    return Math.max(0, Math.min(KEY_COUNT - 1, Math.round(v / 0.37 + 3.5)));
  }

  /* ============================================================ firing */

  /**
   * Center-screen click routing while inside: piano keys, tank stirs, pool
   * pokes. Returns true when the museum consumed the click (tools stand down).
   */
  handleFire(origin: THREE.Vector3, dir: THREE.Vector3, pressed: boolean, held: boolean): boolean {
    if (!this.#built || !this.#inside || !this.#group) return false;

    // instruments: piano (E to sit, then click or 1–8), harp across the dome
    if (this.#room === "dome" && pressed) {
      this.#ray.set(origin, dir);
      this.#ray.far = this.#pianoEngaged ? 10 : 8;
      const key = this.#keys && this.#ray.intersectObject(this.#keys, false)[0];
      if (key && key.instanceId !== undefined) {
        this.#playNote(INST_PIANO, key.instanceId, false);
        return true;
      }
      if (this.#pianoEngaged) {
        const k = this.#pianoKeyFromRay(origin, dir);
        if (k !== null) {
          this.#playNote(INST_PIANO, k, false);
          return true;
        }
      }
      const str = this.#strings && this.#ray.intersectObject(this.#strings, false)[0];
      if (str && str.instanceId !== undefined) {
        this.#playNote(INST_HARP, str.instanceId, false);
        return true;
      }
    }
    if (!held) return false;

    // local-frame ray
    const o = toLocal(origin.x, origin.z);
    const du = dir.x * COS - dir.z * SIN;
    const dv = dir.x * SIN + dir.z * COS;
    const oy = origin.y;

    // wall tanks (sand / SPH): ray vs the v = v0 plane
    for (const p of this.#panels) {
      if (!p.sim.active) continue;
      if (Math.abs(dv) < 1e-4) continue;
      const t = (p.v0 - o.v) / dv;
      if (t < 0 || t > 10) continue;
      const hu = o.u + du * t;
      const hy = oy + dir.y * t;
      if (hu < p.uMin - 0.4 || hu > p.uMax + 0.4 || hy < p.yMin - 0.4 || hy > p.yMax + 0.4) continue;
      p.sim.stir(
        Math.min(Math.max(hu - p.uMin, 0), p.uMax - p.uMin),
        Math.min(Math.max(hy - p.yMin, 0), p.yMax - p.yMin),
        true
      );
      this.#tankStirred = true; // a deliberate click-drag; suppress walk-near this frame
      return true;
    }

    // star table: ray vs its horizontal plane
    if (this.#stars?.active && Math.abs(dir.y) > 1e-4) {
      const yT = FLOOR + 1.14;
      const t = (yT - oy) / dir.y;
      if (t > 0 && t < 9) {
        const hu = o.u + du * t;
        const hv = o.v + dv * t;
        if (Math.hypot(hu - STAR_U, hv - STAR_V) < 3.9) {
          this.#stars.stir(hu - (STAR_U - STAR_HALF), (STAR_V + STAR_HALF) - hv, true);
          return true;
        }
      }
    }

    // ripple pool: ray vs the water plane, rate-limited pokes
    if (this.#pool?.active && Math.abs(dir.y) > 1e-4) {
      const yP = FLOOR + 0.72;
      const t = (yP - oy) / dir.y;
      if (t > 0 && t < 14) {
        const hu = o.u + du * t;
        const hv = o.v + dv * t;
        if (hu > -23 && hu < -11 && hv > 1.25 && hv < 8.75) {
          if (this.#pokeCooldown === 0) {
            this.#pokeCooldown = 0.09;
            this.#pool.poke(hu - -23, hv - 1.25, 0.55);
            this.#audio.drip();
          }
          return true;
        }
      }
    }
    return false;
  }

  // dome center in world coords, for the "can I actually hear this" gate
  #domeWorld = new THREE.Vector3(
    CX + DOME_C.u * COS + DOME_C.v * SIN,
    FLOOR + 2,
    CZ - DOME_C.u * SIN + DOME_C.v * COS
  );

  /** A friend's note arriving off the wire: same show, no re-broadcast. */
  remoteNote(instrument: number, key: number) {
    if (!this.#built) return; // museum isn't even near this client
    const inst = instrument === INST_HARP ? INST_HARP : INST_PIANO;
    this.#playNote(inst, Math.max(0, Math.min(KEY_COUNT - 1, key | 0)), true);
  }

  #playNote(inst: number, k: number, remote: boolean) {
    // both instruments share C major; the harp sings an octave above the piano
    const base = inst === INST_HARP ? 523.25 : 261.63;
    const freq = base * Math.pow(2, SCALE_SEMIS[k] / 12);
    // remote notes only sound if we're actually at the theater
    if (!remote || this.#playerPos.distanceTo(this.#domeWorld) < 60) {
      if (inst === INST_HARP) this.#audio.shimmer(freq, (k - 3.5) / 5.5);
      else this.#audio.pluck(freq, (k - 3.5) / 4.5);
    }
    ((inst === INST_HARP ? this.#stringGlow : this.#keyGlow).array as unknown as number[])[k] = 1;

    // launch a dome ripple from this note's own patch of sky — the harp owns
    // the opposite hemisphere and rides higher, so a duet interleaves cleanly
    const az = ((k - 3.5) / KEY_COUNT) * Math.PI * 1.7 + (inst === INST_HARP ? Math.PI : 0);
    const el = inst === INST_HARP ? 0.9 + (k % 2) * 0.3 : 0.55 + (k % 3) * 0.28;
    const dirv = new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
    const a = this.#noteA.array as unknown as THREE.Vector4[];
    const b = this.#noteB.array as unknown as THREE.Vector4[];
    const slot = this.#noteCursor;
    this.#noteCursor = (this.#noteCursor + 1) % NOTE_SLOTS;
    a[slot].set(dirv.x, dirv.y, dirv.z, this.#domeTime.value as number);
    b[slot].set(KEY_HUES[k], inst === INST_HARP ? 1 : 0, 0, 0);
    this.#noteEnergy.value = Math.min(2.2, (this.#noteEnergy.value as number) + (inst === INST_HARP ? 0.35 : 0.5));

    if (remote) this.#notesRemote++;
    else {
      this.#notesLocal++;
      this.onNote(inst, k);
    }
  }

  /* ============================================================== build */

  #build() {
    this.#built = true;
    const g = new THREE.Group();
    g.position.set(CX, 0, CZ);
    g.rotation.y = YAW;
    this.#group = g;
    this.#scene.add(g);

    // ---- material buckets -> one merged mesh each
    const buckets: Record<string, THREE.BoxGeometry[]> = { white: [], inner: [], dark: [], roof: [], floor: [], glow: [], glass: [] };
    const B = (bucket: string, u: number, y: number, v: number, hu: number, hy: number, hv: number, ry = 0) => {
      const geo = new THREE.BoxGeometry(hu * 2, hy * 2, hv * 2);
      const m = new THREE.Matrix4().makeRotationY(ry);
      m.setPosition(u, y, v);
      geo.applyMatrix4(m);
      buckets[bucket].push(geo);
    };
    const F = FLOOR;

    // ---- shell
    B("floor", 0, F - 0.15, 0, HL, 0.15, HW);
    B("white", 0, F + 4.5, HW - 0.2, HL, 4.5, 0.2);
    B("white", 0, F + 4.5, -(HW - 0.2), HL, 4.5, 0.2);
    B("white", -HL + 0.2, F + 4.5, 0, 0.2, 4.5, HW);
    B("white", HL - 0.2, F + 4.5, 17.45, 0.2, 4.5, 13.95); // entrance wall, door gap |v|<3.5
    B("white", HL - 0.2, F + 4.5, -17.45, 0.2, 4.5, 13.95);
    B("white", HL - 0.2, F + 7.6, 0, 0.2, 1.4, 3.5); // lintel: door clears 6.2m
    B("roof", 0, F + 9.15, 19.7, HL, 0.15, 11.7); // solar side roofs
    B("roof", 0, F + 9.15, -19.7, HL, 0.15, 11.7);
    B("glass", 0, F + 10.25, 8, HL, 1.25, 0.15); // clerestory monitor band
    B("glass", 0, F + 10.25, -8, HL, 1.25, 0.15);
    B("roof", 0, F + 11.65, 0, HL, 0.15, 8.15); // monitor cap
    B("white", HL - 0.1, F + 10.25, 0, 0.15, 1.25, 8); // monitor end caps
    B("white", -HL + 0.1, F + 10.25, 0, 0.15, 1.25, 8);
    // entrance parapet — the white bulkhead stack over the doors
    B("white", HL - 0.05, F + 10.15, 0, 0.35, 1.15, 10);
    B("white", HL - 0.05, F + 11.75, 0, 0.35, 0.75, 6.2);

    // ---- interior partitions
    B("inner", -100, F + 4.5, 0, 0.2, 4.5, HW); // back-of-house wall
    B("inner", 10, F + 4.5, -13.2, 0.2, 4.5, 18.2); // gallery wall, door v 5..11
    B("inner", 10, F + 4.5, 21.2, 0.2, 4.5, 10.2);
    B("inner", 10, F + 7.85, 8, 0.2, 1.15, 3);
    B("inner", -45, F + 4.5, 17.2, 0.2, 4.5, 14.2); // water/dome wall, door |v|<3
    B("inner", -45, F + 4.5, -17.2, 0.2, 4.5, 14.2);
    B("inner", -45, F + 7.85, 0, 0.2, 1.15, 3);

    // ---- roof trusses + hanging light strips: honest pier-shed bones
    for (let i = 0; i < 16; i++) {
      const tu = -98 + i * 14;
      B("dark", tu, F + 8.6, 0, 0.22, 0.35, HW - 0.4);
    }
    for (let i = 0; i < 4; i++) {
      const su = -84 + i * 56;
      B("glow", su, F + 8.5, 16, 5.5, 0.06, 0.32);
      B("glow", su, F + 8.5, -16, 5.5, 0.06, 0.32);
    }

    // ---- lobby: welcome desk + bench
    B("dark", 112, F + 0.55, -8, 1.6, 0.55, 0.6);
    B("white", 112, F + 1.16, -8, 1.8, 0.06, 0.75);
    B("dark", 108, F + 0.25, 10, 1.8, 0.25, 0.45);

    // ---- particle gallery: sand tank + star table pedestal + benches
    B("dark", 72, F + 0.42, -28.7, 3.6, 0.42, 0.8); // sand pedestal
    B("dark", 72, F + 2.55, -29.15, 3.62, 2.3, 0.05); // backboard
    B("dark", 68.35, F + 2.55, -28.75, 0.12, 2.3, 0.5);
    B("dark", 75.65, F + 2.55, -28.75, 0.12, 2.3, 0.5);
    B("dark", 72, F + 4.97, -28.75, 3.62, 0.12, 0.5);
    B("dark", 52, F + 0.25, -8, 1.8, 0.25, 0.45); // bench
    B("dark", 30, F + 0.25, -2, 1.8, 0.25, 0.45); // bench

    // ---- water works: SPH tank frame + ripple pool rim
    B("dark", -20, F + 0.42, -28.7, 3.2, 0.42, 0.8);
    B("dark", -20, F + 2.35, -29.15, 3.22, 2.1, 0.05);
    B("dark", -23.1, F + 2.35, -28.75, 0.12, 2.1, 0.5);
    B("dark", -16.9, F + 2.35, -28.75, 0.12, 2.1, 0.5);
    B("dark", -20, F + 4.57, -28.75, 3.22, 0.12, 0.5);
    B("dark", -17, F + 0.45, 8.9, 6.3, 0.45, 0.15); // pool rim
    B("dark", -17, F + 0.45, 1.1, 6.3, 0.45, 0.15);
    B("dark", -23.15, F + 0.45, 5, 0.15, 0.45, 4.05);
    B("dark", -10.85, F + 0.45, 5, 0.15, 0.45, 4.05);
    B("dark", -17, F + 0.14, 5, 6.0, 0.14, 3.75); // pool bed
    B("dark", -34, F + 0.25, -12, 1.8, 0.25, 0.45); // bench

    // ---- dome theater ring wall (a single door-sized gap faces the hall, +u)
    for (let k = 0; k < DOME_WALL_SEGS; k++) {
      const a = DOME_DOOR_HALF + ((k + 0.5) / DOME_WALL_SEGS) * DOME_WALL_SPAN;
      B("inner", DOME_C.u + Math.cos(a) * DOME_WALL_R, F + 1, DOME_C.v + Math.sin(a) * DOME_WALL_R, 0.25, 1, DOME_POST_HV, -a);
    }
    // piano console
    B("dark", DOME_C.u + 2.6, F + 0.45, 0, 0.5, 0.45, 1.7);

    const add = (bucket: string, mat: THREE.Material, opts?: { cast?: boolean; receive?: boolean }) => {
      if (buckets[bucket].length === 0) return;
      const merged = mergeGeometries(buckets[bucket], false)!;
      for (const b of buckets[bucket]) b.dispose();
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = opts?.cast ?? false;
      mesh.receiveShadow = opts?.receive ?? true;
      g.add(mesh);
    };
    add("white", new THREE.MeshStandardMaterial({ color: 0xf2ede1, roughness: 0.88 }), { cast: true });
    add("inner", new THREE.MeshStandardMaterial({ color: 0xe7e0d0, roughness: 0.92 }));
    add("dark", new THREE.MeshStandardMaterial({ color: 0x23262b, roughness: 0.6, metalness: 0.25 }));
    add("roof", new THREE.MeshStandardMaterial({ color: 0x0d1523, roughness: 0.38, metalness: 0.55 }), { cast: true });
    add("floor", new THREE.MeshStandardMaterial({ color: 0x8a6a46, roughness: 0.82 }));
    add(
      "glow",
      new THREE.MeshStandardMaterial({
        color: 0x111111,
        emissive: 0xfff1d8,
        emissiveIntensity: LIGHT_SCALE * 0.5,
        roughness: 0.6
      })
    );
    add(
      "glass",
      new THREE.MeshStandardMaterial({
        color: 0x9fb9c9,
        roughness: 0.18,
        metalness: 0.1,
        emissive: 0x2e4552,
        emissiveIntensity: LIGHT_SCALE * 0.05
      })
    );

    this.#buildDome(g);
    this.#buildPiano(g);
    this.#buildHarp(g);
    this.#buildPool(g);
    this.#buildSignage(g);
    this.#buildPlaques(g);

    // star table: charcoal drum + a near-black glass top the disc floats over
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(4.25, 4.4, 1.04, 40),
      new THREE.MeshStandardMaterial({ color: 0x1b1e24, roughness: 0.55, metalness: 0.3 })
    );
    drum.position.set(STAR_U, FLOOR + 0.52, STAR_V);
    g.add(drum);
    const top = new THREE.Mesh(
      new THREE.CircleGeometry(4.15, 40),
      new THREE.MeshStandardMaterial({ color: 0x04060b, roughness: 0.15, metalness: 0.4 })
    );
    top.rotation.x = -Math.PI / 2;
    top.position.set(STAR_U, FLOOR + 1.045, STAR_V);
    g.add(top);

    // plaza sculpture: the geodesic ball from the entrance forecourt
    const ball = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(1.7, 1)),
      new THREE.LineBasicMaterial({ color: 0xdddddd })
    );
    ball.position.set(HL + 6, F + 1.9, 9);
    g.add(ball);
  }

  /* ------------------------------------------------------------- dome */

  #buildDome(g: THREE.Group) {
    // outer cladding: a matte black shell so the theater reads from the hall
    const shellGeo = new THREE.SphereGeometry(DOME_R + 0.18, 40, 20, 0, Math.PI * 2, 0, Math.PI * 0.56);
    const shell = new THREE.Mesh(shellGeo, new THREE.MeshStandardMaterial({ color: 0x101318, roughness: 0.7 }));
    shell.position.set(DOME_C.u, FLOOR + 2, DOME_C.v);
    g.add(shell);

    // inner sky: BackSide shader — starfield + the piano's expanding rings
    const domeGeo = new THREE.SphereGeometry(DOME_R, 48, 24, 0, Math.PI * 2, 0, Math.PI * 0.58);
    const mat = new THREE.MeshBasicNodeMaterial();
    mat.side = THREE.BackSide;
    mat.fog = false;

    const T = this.#domeTime as N;
    const dir = (positionLocal as N).normalize().toVar();

    // slow sky rotation
    const rot = T.mul(0.012);
    const rx = dir.x.mul(cos(rot)).sub(dir.z.mul(sin(rot)));
    const rz = dir.x.mul(sin(rot)).add(dir.z.mul(cos(rot)));
    const rdir = vec3(rx, dir.y, rz);

    // starfield: quantize direction, hash the cell, keep the top sliver
    const cellF = rdir.mul(26);
    const cell = floor(cellF);
    const cid = cell.x.add(cell.y.mul(57)).add(cell.z.mul(113)).abs().toUint();
    const s = hash(cid) as N;
    const local = fract(cellF).sub(0.5).length();
    const star = smoothstep(0.986, 0.998, s).mul(smoothstep(0.32, 0.05, local));
    const twinkle = sin(T.mul(1.7).add(s.mul(80))).mul(0.4).add(0.6);

    // faint nebula wash, branchless
    const neb1 = sin(rdir.x.mul(2.1).add(rdir.y.mul(1.3)).add(T.mul(0.05))).mul(0.5).add(0.5);
    const neb2 = sin(rdir.z.mul(1.7).sub(rdir.y.mul(2.4)).add(1.9)).mul(0.5).add(0.5);
    const nebula = vec3(0.05, 0.025, 0.11)
      .mul(neb1)
      .add(vec3(0.01, 0.05, 0.08).mul(neb2))
      .mul(saturate(dir.y.mul(0.8).add(0.45)))
      .mul(0.25);

    // keep the void nearly black — the rings and stars carry all the light
    let col: N = mix(vec3(0.0015, 0.0015, 0.004), vec3(0.004, 0.006, 0.014), saturate(dir.y)).add(nebula);
    col = col.add(vec3(0.9, 0.95, 1.1).mul(star).mul(twinkle).mul(1.6));

    // the instruments' rings: for each live note a gaussian ring expands in
    // great-circle angle from its origin direction — pure mix/mul, no branches.
    // kind (noteB.y) morphs the signature: piano = crisp fast ring, harp =
    // slow wide breathing halo, so a duet reads as two voices overhead
    const noteA = this.#noteA as N;
    const noteB = this.#noteB as N;
    for (let i = 0; i < NOTE_SLOTS; i++) {
      const a = noteA.element(i);
      const b = noteB.element(i);
      const kind = b.y;
      const sharp = mix(float(15), float(3.8), kind);
      const speed = mix(float(0.75), float(0.3), kind);
      const fade = mix(float(0.62), float(0.34), kind);
      const amp = mix(float(1.6), float(0.85), kind);
      const age = T.sub(a.w);
      const live = smoothstep(0.0, 0.02, age).mul(exp(age.mul(fade).negate()));
      const ang = a.xyz.dot(dir).clamp(-1, 1).acos();
      const ring = exp(ang.sub(age.mul(speed)).mul(sharp).pow2().negate());
      const wake = exp(ang.sub(age.mul(speed)).mul(3.2).pow2().negate()).mul(0.05);
      const hue = b.x;
      const noteCol = vec3(
        sin(hue.mul(6.283).add(0)).mul(0.5).add(0.5),
        sin(hue.mul(6.283).add(2.094)).mul(0.5).add(0.5),
        sin(hue.mul(6.283).add(4.188)).mul(0.5).add(0.5)
      );
      col = col.add(noteCol.mul(ring.add(wake)).mul(live).mul(amp));
    }
    mat.colorNode = col.mul(LIGHT_SCALE * 0.55);

    const dome = new THREE.Mesh(domeGeo, mat);
    dome.position.set(DOME_C.u, FLOOR + 2, DOME_C.v);
    g.add(dome);

    // floor ring that breathes with the music
    const ringGeo = new THREE.RingGeometry(DOME_WALL_R - 1.5, DOME_WALL_R - 0.6, 48);
    const ringMat = new THREE.MeshBasicNodeMaterial();
    ringMat.transparent = true;
    ringMat.blending = THREE.AdditiveBlending;
    ringMat.depthWrite = false;
    ringMat.fog = false;
    const e = this.#noteEnergy as N;
    ringMat.colorNode = vec3(0.35, 0.5, 0.9).mul(e.mul(0.5).add(0.06)).mul(LIGHT_SCALE * 0.5);
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(DOME_C.u, FLOOR + 0.02, DOME_C.v);
    g.add(ring);
  }

  /* ------------------------------------------------------------ piano */

  #buildPiano(g: THREE.Group) {
    // a dark keybed plate so the keys read as keys, not a glowing strip
    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.06, 3.2),
      new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.5, metalness: 0.3 })
    );
    bed.position.set(DOME_C.u + 2.38, FLOOR + 0.93, 0);
    g.add(bed);

    const keyGeo = new THREE.BoxGeometry(0.44, 0.12, 0.3);
    const mat = new THREE.MeshStandardNodeMaterial({ color: 0xf5f2ea, roughness: 0.35 });
    const glow = this.#keyGlow as N;
    const idx = instanceIndex as N;
    const gv = vertexStage(glow.element(idx)) as N;
    const hue = vertexStage(idx.toFloat().div(KEY_COUNT).mul(0.86)) as N;
    const keyCol = vec3(
      sin(hue.mul(6.283)).mul(0.5).add(0.5),
      sin(hue.mul(6.283).add(2.094)).mul(0.5).add(0.5),
      sin(hue.mul(6.283).add(4.188)).mul(0.5).add(0.5)
    );
    mat.emissiveNode = keyCol.mul(gv.mul(0.85).add(0.03)).mul(LIGHT_SCALE * 0.6) as N;

    const keys = new THREE.InstancedMesh(keyGeo, mat, KEY_COUNT);
    const m = new THREE.Matrix4();
    for (let k = 0; k < KEY_COUNT; k++) {
      m.makeRotationY(0);
      m.setPosition(DOME_C.u + 2.35, FLOOR + 1.02, (k - 3.5) * 0.37);
      keys.setMatrixAt(k, m);
    }
    keys.instanceMatrix.needsUpdate = true;
    g.add(keys);
    this.#keys = keys;
  }

  /* ------------------------------------------------------------- harp */

  /**
   * The starlight harp — the piano's otherworldly duet partner across the
   * dome: eight standing beams of light crowned with floating crystals, tuned
   * to the same C major an octave up. Click a beam to sound it; its halo
   * blooms on the opposite half of the sky from the piano's rings.
   */
  #buildHarp(g: THREE.Group) {
    const F = FLOOR;
    const U = DOME_C.u - 2.55; // mirrored across the dome center from the piano

    const bed = new THREE.Mesh(
      new THREE.BoxGeometry(0.62, 0.1, 3.2),
      new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.5, metalness: 0.3 })
    );
    bed.position.set(U, F + 0.1, 0);
    g.add(bed);

    const glow = this.#stringGlow as N;
    const idx = instanceIndex as N;
    const gv = vertexStage(glow.element(idx)) as N;
    const hue = vertexStage(idx.toFloat().div(KEY_COUNT).mul(0.86)) as N;
    const keyCol = vec3(
      sin(hue.mul(6.283)).mul(0.5).add(0.5),
      sin(hue.mul(6.283).add(2.094)).mul(0.5).add(0.5),
      sin(hue.mul(6.283).add(4.188)).mul(0.5).add(0.5)
    );

    // beams: always faintly lit in their own hue, flaring when sounded
    const strMat = new THREE.MeshStandardNodeMaterial({ color: 0x11131a, roughness: 0.3 });
    strMat.emissiveNode = keyCol.mul(gv.mul(1.1).add(0.09)).mul(LIGHT_SCALE * 0.5) as N;
    const beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.035, 0.05, 2.3, 8), strMat, KEY_COUNT);
    const cryMat = new THREE.MeshStandardNodeMaterial({ color: 0x0a0c12, roughness: 0.2, metalness: 0.4 });
    cryMat.emissiveNode = keyCol.mul(gv.mul(1.3).add(0.15)).mul(LIGHT_SCALE * 0.7) as N;
    const crystals = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.16), cryMat, KEY_COUNT);
    const m = new THREE.Matrix4();
    for (let k = 0; k < KEY_COUNT; k++) {
      const v = (k - 3.5) * 0.37;
      m.makeRotationY(0);
      m.setPosition(U, F + 1.25, v);
      beams.setMatrixAt(k, m);
      m.setPosition(U, F + 2.56, v);
      crystals.setMatrixAt(k, m);
    }
    beams.instanceMatrix.needsUpdate = true;
    crystals.instanceMatrix.needsUpdate = true;
    g.add(beams);
    g.add(crystals);

    // fat invisible hit volumes so a thin beam is still an easy click
    const hitMat = new THREE.MeshBasicMaterial();
    hitMat.visible = false;
    const hits = new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 2.9, 0.3), hitMat, KEY_COUNT);
    for (let k = 0; k < KEY_COUNT; k++) {
      m.setPosition(U, F + 1.45, (k - 3.5) * 0.37);
      hits.setMatrixAt(k, m);
    }
    hits.instanceMatrix.needsUpdate = true;
    g.add(hits);
    this.#strings = hits;
  }

  /* ------------------------------------------------------------- pool */

  #buildPool(g: THREE.Group) {
    this.#pool = new RipplePool(this.#renderer, g, 12, 7.5);
    this.#pool.mesh.position.set(-17, FLOOR + 0.72, 5);
  }

  /* ---------------------------------------------------------- signage */

  #canvasPanel(
    w: number,
    h: number,
    draw: (ctx: CanvasRenderingContext2D, W: number, H: number) => void,
    opts?: { emissive?: number }
  ): THREE.Mesh {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    draw(ctx, w, h);
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.MeshStandardMaterial({
      color: 0x000000,
      emissive: 0xffffff,
      emissiveMap: tex,
      emissiveIntensity: LIGHT_SCALE * (opts?.emissive ?? 0.32),
      roughness: 0.6
    });
    return new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
  }

  #banner(text: string, wM: number, hM: number, accent = "#69d2ff"): THREE.Mesh {
    const mesh = this.#canvasPanel(1024, Math.round((1024 * hM) / wM), (ctx, W, H) => {
      ctx.fillStyle = "#0c0f14";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = accent;
      ctx.fillRect(0, H - 10, W, 10);
      ctx.fillStyle = "#f5f2ea";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = `700 ${Math.round(H * 0.52)}px system-ui, sans-serif`;
      ctx.fillText(text, W / 2, H * 0.48);
    });
    mesh.scale.set(wM, hM, 1);
    return mesh;
  }

  #buildSignage(g: THREE.Group) {
    const F = FLOOR;
    // grand facade sign over the doors, facing the promenade (+u looks out)
    const sign = this.#banner("EXPLORATORIUM", 17, 1.7, "#ffb347");
    sign.position.set(HL + 0.02, F + 8.1, 0);
    sign.rotation.y = Math.PI / 2;
    g.add(sign);

    const gallery = this.#banner("PARTICLE WORLDS", 7, 1.0);
    gallery.position.set(10.15, F + 6.9, 8);
    gallery.rotation.y = Math.PI / 2;
    g.add(gallery);

    const water = this.#banner("WATER WORKS", 6, 1.0, "#5fe0c8");
    water.position.set(-44.85, F + 6.9, 0);
    water.rotation.y = Math.PI / 2;
    g.add(water);

    // sits just outside the wall face, above the doorway, facing the hall (+u)
    const dome = this.#banner("DOME THEATER", 6, 0.9, "#c69bff");
    dome.position.set(DOME_C.u + DOME_WALL_R + 0.25, F + 3.2, 0);
    dome.rotation.y = Math.PI / 2;
    g.add(dome);
  }

  /* ---------------------------------------------------------- plaques */

  #plaque(g: THREE.Group, u: number, v: number, ry: number, title: string, body: string, accent: string, caption: string) {
    const F = FLOOR;
    // pedestal + tilted reading panel
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(0.5, 1.04, 0.14),
      new THREE.MeshStandardMaterial({ color: 0x2b2e33, roughness: 0.6, metalness: 0.3 })
    );
    stand.position.set(u, F + 0.52, v);
    stand.rotation.y = ry;
    g.add(stand);

    const panel = this.#canvasPanel(
      560,
      680,
      (ctx, W, H) => {
        ctx.fillStyle = "#101418";
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = accent;
        ctx.fillRect(0, 0, W, 14);
        ctx.fillStyle = "#f5f2ea";
        ctx.font = "700 44px system-ui, sans-serif";
        ctx.textBaseline = "top";
        this.#wrap(ctx, title, 34, 44, W - 68, 50);
        ctx.font = "400 30px system-ui, sans-serif";
        ctx.fillStyle = "#cfd4da";
        const titleLines = Math.ceil(ctx.measureText(title).width / (W - 68)) || 1;
        this.#wrap(ctx, body, 34, 62 + titleLines * 52 + 26, W - 68, 40);
        ctx.fillStyle = accent;
        ctx.font = "italic 24px system-ui, sans-serif";
        ctx.fillText("Exploratorium · Pier 15", 34, H - 52);
      },
      { emissive: 0.38 }
    );
    panel.scale.set(0.72, 0.88, 1);
    panel.position.set(u, F + 1.42, v);
    panel.rotation.y = ry;
    panel.rotation.x = -0.28;
    g.add(panel);

    this.#plaques.push({ u, v, caption, cool: 0, title, body, accent });
  }

  #wrap(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lineH: number) {
    const words = text.split(" ");
    let line = "";
    let yy = y;
    for (const w of words) {
      const probe = line ? line + " " + w : w;
      if (ctx.measureText(probe).width > maxW && line) {
        ctx.fillText(line, x, yy);
        line = w;
        yy += lineH;
      } else {
        line = probe;
      }
    }
    if (line) ctx.fillText(line, x, yy);
  }

  #buildPlaques(g: THREE.Group) {
    this.#plaque(
      g,
      118,
      6,
      Math.PI / 2,
      "Welcome to the Exploratorium",
      "A museum of noticing. Every exhibit in these halls is a real simulation running live on your GPU — thousands of particles sorted, scanned and integrated every frame. Nothing here is a recording. Poke things.",
      "#ffb347",
      "Welcome — everything in here is a live simulation. Poke things."
    );
    this.#plaque(
      g,
      66,
      -26.5,
      0,
      "Sandbox — granular flow",
      "5,000 grains. Each frame they are counting-sorted into a grid so every grain only talks to its 3×3 neighbourhood — the trick that turns n-squared physics into a straight line. Springs push overlapping grains apart, friction bleeds energy away; that loss is why the pile settles at its angle of repose. Hold click to blast air at it.",
      "#e8b45a",
      "Sand: counting-sorted grains — friction is why the pile stops. Hold click to blow."
    );
    this.#plaque(
      g,
      46,
      5.2,
      Math.PI * 0.5,
      "Protoplanetary table",
      "14,000 dust grains on circular orbits around a young star. Inner lanes outrun outer ones — Kepler shear stretches every clump into a spiral streak — while inelastic collisions bleed energy so clumps grow instead of bouncing apart. Moonlets sweep their lanes clean, spacing themselves like teeth on a comb. Hold click to drag a second mass through the disc.",
      "#c69bff",
      "Star table: Kepler shear + sticky collisions = moonlets. Hold click to stir the disc."
    );
    this.#plaque(
      g,
      -16.5,
      -26.5,
      0,
      "Water — smoothed particles",
      "Smoothed-particle hydrodynamics: each blob overlaps its neighbours, and where they crowd, pressure rises and pushes them apart. Invented in 1977 for exploding stars, later hired by Hollywood to pour oceans. A separate near-pressure keeps droplets from clumping; viscosity keeps the swirls honest. Hold click to pull a swell around the tank.",
      "#5fe0c8",
      "SPH water: crowding makes pressure. Hold click to drag a swell."
    );
    this.#plaque(
      g,
      -12,
      10.5,
      Math.PI / 2,
      "Ripple pool — interference",
      "A wave equation on a 128×80 grid of heights and velocities. Rings spread, reflect off the rim and pass straight through each other — adding where crest meets crest, cancelling where crest meets trough. Click the water and read the interference.",
      "#69d2ff",
      "Ripple pool: click the water — waves add and cancel."
    );
    this.#plaque(
      g,
      DOME_C.u + 7.2,
      3.6,
      Math.PI * 0.72,
      "Dome theater — playable sky",
      "Two instruments, one sky. The piano's notes launch crisp rings of light; the starlight harp opposite answers with slow halos an octave higher, from the other half of the dome. Both speak C major, so any two visitors sound good together — duet with a friend and watch your chords interfere overhead. Notes travel to everyone in the room.",
      "#c69bff",
      "Dome: piano + starlight harp, same scale — duet with a friend."
    );
    this.#plaque(
      g,
      HL + 4,
      -6,
      Math.PI / 2,
      "Pier 15 — the Exploratorium",
      "San Francisco's museum of science, art and human perception, at home on the Embarcadero since 2013 (and in the Palace of Fine Arts before that, since 1969). This edition runs entirely on your graphics card.",
      "#ffb347",
      "The Exploratorium — since 1969. Step inside."
    );
  }

  /* -------------------------------------------------------- colliders */

  #box(u: number, y: number, v: number, hu: number, hy: number, hv: number, ry = 0) {
    const x = CX + u * COS + v * SIN;
    const z = CZ - u * SIN + v * COS;
    const yaw = YAW + ry;
    const h = this.#physics.world.createBox({
      type: BodyType.Static,
      position: [x, y, z],
      halfExtents: [hu, hy, hv],
      friction: 0.7
    });
    this.#physics.world.setBodyTransform(h, [x, y, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    this.#bodies.push(h);
  }

  #createColliders() {
    const F = FLOOR;
    this.#box(0, F - 0.15, 0, HL, 0.15, HW); // floor
    this.#box(0, F + 4.5, HW - 0.2, HL, 4.5, 0.25);
    this.#box(0, F + 4.5, -(HW - 0.2), HL, 4.5, 0.25);
    this.#box(-HL + 0.2, F + 4.5, 0, 0.25, 4.5, HW);
    this.#box(HL - 0.2, F + 4.5, 17.45, 0.25, 4.5, 13.95);
    this.#box(HL - 0.2, F + 4.5, -17.45, 0.25, 4.5, 13.95);
    this.#box(HL - 0.2, F + 7.6, 0, 0.25, 1.4, 3.5);
    this.#box(0, F + 9.15, 19.7, HL, 0.2, 11.7); // roofs — fliers land, walkers can't fall in
    this.#box(0, F + 9.15, -19.7, HL, 0.2, 11.7);
    this.#box(0, F + 11.65, 0, HL, 0.2, 8.15);
    this.#box(0, F + 10.25, 8, HL, 1.25, 0.2); // clerestory
    this.#box(0, F + 10.25, -8, HL, 1.25, 0.2);
    this.#box(-100, F + 4.5, 0, 0.25, 4.5, HW); // BOH
    this.#box(10, F + 4.5, -13.2, 0.25, 4.5, 18.2);
    this.#box(10, F + 4.5, 21.2, 0.25, 4.5, 10.2);
    this.#box(10, F + 7.85, 8, 0.25, 1.15, 3);
    this.#box(-45, F + 4.5, 17.2, 0.25, 4.5, 14.2);
    this.#box(-45, F + 4.5, -17.2, 0.25, 4.5, 14.2);
    this.#box(-45, F + 7.85, 0, 0.25, 1.15, 3);
    this.#box(112, F + 0.6, -8, 1.8, 0.6, 0.75); // desk
    this.#box(108, F + 0.25, 10, 1.8, 0.25, 0.45); // benches
    this.#box(52, F + 0.25, -8, 1.8, 0.25, 0.45);
    this.#box(30, F + 0.25, -2, 1.8, 0.25, 0.45);
    this.#box(-34, F + 0.25, -12, 1.8, 0.25, 0.45);
    this.#box(72, F + 2.5, -28.75, 3.7, 2.5, 0.6); // sand tank
    this.#box(-20, F + 2.3, -28.75, 3.3, 2.3, 0.6); // SPH tank
    this.#box(STAR_U, F + 0.55, STAR_V, 4.3, 0.55, 4.3); // star table
    this.#box(-17, F + 0.45, 8.9, 6.3, 0.45, 0.2); // pool rim
    this.#box(-17, F + 0.45, 1.1, 6.3, 0.45, 0.2);
    this.#box(-23.15, F + 0.45, 5, 0.2, 0.45, 4.05);
    this.#box(-10.85, F + 0.45, 5, 0.2, 0.45, 4.05);
    this.#box(-17, F + 0.14, 5, 6.0, 0.14, 3.75); // pool bed
    for (let k = 0; k < DOME_WALL_SEGS; k++) {
      const a = DOME_DOOR_HALF + ((k + 0.5) / DOME_WALL_SEGS) * DOME_WALL_SPAN;
      this.#box(DOME_C.u + Math.cos(a) * DOME_WALL_R, F + 1, DOME_C.v + Math.sin(a) * DOME_WALL_R, 0.3, 1, DOME_POST_HV + 0.04, -a);
    }
    this.#box(DOME_C.u + 2.5, F + 0.7, 0, 0.75, 0.7, 1.75); // piano console
    this.#box(DOME_C.u - 2.55, F + 0.35, 0, 0.5, 0.35, 1.7); // harp bed
  }

  #dropColliders() {
    for (const h of this.#bodies) this.#physics.world.destroyBody(h);
    this.#bodies.length = 0;
  }
}

/* ========================================================== audio voice */

/** Piano pluck + pool drip, gated by the HUD master volume like every toy. */
class MuseumAudio {
  #ctx: AudioContext | null = null;
  #master: GainNode | null = null;

  #ensure(): AudioContext | null {
    if (this.#ctx) return this.#ctx;
    if (typeof AudioContext === "undefined") return null;
    this.#ctx = new AudioContext();
    const limiter = this.#ctx.createDynamicsCompressor();
    limiter.threshold.value = -16;
    limiter.ratio.value = 8;
    limiter.connect(this.#ctx.destination);
    this.#master = this.#ctx.createGain();
    this.#master.gain.value = 0.6;
    this.#master.connect(limiter);
    return this.#ctx;
  }

  pluck(freq: number, pan: number) {
    const master = effectsAudioLevel();
    if (master <= 0) return;
    const ctx = this.#ensure();
    if (!ctx || !this.#master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const dur = 2.6;

    const out = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner);
    panner.connect(this.#master);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.34 * master, t + 0.005);
    out.gain.exponentialRampToValueAtTime(0.0006, t + dur);

    // felt-hammer-ish: triangle fundamental + soft octave & twelfth partials
    const o1 = ctx.createOscillator();
    o1.type = "triangle";
    o1.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = freq * 2.001;
    const g2 = ctx.createGain();
    g2.gain.value = 0.28;
    const o3 = ctx.createOscillator();
    o3.type = "sine";
    o3.frequency.value = freq * 3.003;
    const g3 = ctx.createGain();
    g3.gain.setValueAtTime(0.14, t);
    g3.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    o1.connect(out);
    o2.connect(g2);
    g2.connect(out);
    o3.connect(g3);
    g3.connect(out);
    for (const o of [o1, o2, o3]) {
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }

  /** The harp's voice: slow bloom, detuned chorus pair, long shimmer tail. */
  shimmer(freq: number, pan: number) {
    const master = effectsAudioLevel();
    if (master <= 0) return;
    const ctx = this.#ensure();
    if (!ctx || !this.#master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const dur = 3.6;

    const out = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    out.connect(panner);
    panner.connect(this.#master);
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.26 * master, t + 0.08); // soft attack — nothing struck, only lit
    out.gain.exponentialRampToValueAtTime(0.0005, t + dur);

    const o1 = ctx.createOscillator();
    o1.type = "sine";
    o1.frequency.value = freq * 0.9985; // detuned pair beats gently = the shimmer
    const o2 = ctx.createOscillator();
    o2.type = "sine";
    o2.frequency.value = freq * 1.0015;
    const o3 = ctx.createOscillator();
    o3.type = "sine";
    o3.frequency.value = freq * 2.0;
    const g3 = ctx.createGain();
    g3.gain.value = 0.12;
    const o4 = ctx.createOscillator();
    o4.type = "sine";
    o4.frequency.value = freq * 0.5;
    const g4 = ctx.createGain();
    g4.gain.value = 0.14;
    o1.connect(out);
    o2.connect(out);
    o3.connect(g3);
    g3.connect(out);
    o4.connect(g4);
    g4.connect(out);
    for (const o of [o1, o2, o3, o4]) {
      o.start(t);
      o.stop(t + dur + 0.1);
    }
  }

  drip() {
    const master = effectsAudioLevel();
    if (master <= 0) return;
    const ctx = this.#ensure();
    if (!ctx || !this.#master) return;
    if (ctx.state === "suspended") void ctx.resume();
    const t = ctx.currentTime;
    const out = ctx.createGain();
    out.connect(this.#master);
    out.gain.setValueAtTime(0.12 * master, t);
    out.gain.exponentialRampToValueAtTime(0.0008, t + 0.22);
    const o = ctx.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(520 + Math.random() * 240, t);
    o.frequency.exponentialRampToValueAtTime(90, t + 0.2);
    o.connect(out);
    o.start(t);
    o.stop(t + 0.25);
  }
}
