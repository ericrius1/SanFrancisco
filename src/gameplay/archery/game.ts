import * as THREE from "three/webgpu";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Input } from "../../core/input";
import type { ChaseCamera } from "../../core/camera";
import type { HUD } from "../../ui/hud";
import type { Player } from "../../player/player";
import type { WorldMap } from "../../world/heightmap";
import type { WorldQueries } from "../../core/worldQueries";
import type { GameSite } from "../siteGate";
import type { NatureSoundscape } from "../../audio/natureSoundscape";
import { ArcheryAudio } from "./audio";
import { ArcheryUI, ringColorCss } from "./ui";
import { NpcArchers } from "./npcArchers";
import { buildArcherySite, RING_RADII, RING_SCORES, type ArcheryTarget } from "./site";
import { archeryLocal, inArcheryRange, LANE_COUNT, LANE_SPACING, laneV } from "./layout";

/**
 * The Golden Gate Park archery range: walk up to the rack (or a lane), press
 * E for a bow, stand on the white shooting line and HOLD click to draw —
 * the meter fills, the archer pulls to the cheek — release to loose. Arrows
 * fly a real ballistic arc, stick where they land, and score by ring in
 * ends of six, Mario-Sports style. Two NPC archers work the outer lanes by
 * day; E beside one borrows their lane.
 *
 * Site-gated: born hidden with a frozen matrix pass; while asleep update()
 * costs a single boolean test. Arrows in flight (or a held bow) keep the
 * site awake so nothing freezes mid-arc.
 */

export const ARCHERY_SITE_PADS = Object.freeze({ activate: 60, deactivate: 110 });

const DRAW_TIME = 1.1; // seconds to full draw
const NOCK_TIME = 0.3; // quiver-reach flourish before the pull
const RELEASE_TIME = 0.28; // pose ease after the loose
const ARROWS_PER_END = 6;
const ARROW_CAP = 40; // live instances (flight + stuck + fading)
const STUCK_CAP = 30; // stuck arrows recycled FIFO beyond this
const MAX_FLIGHT_SECONDS = 4;
const MAX_FLIGHT_METRES = 120;
const GROUND_FADE_DELAY = 10; // seconds a missed arrow rests before fading
const GRAVITY = 9.8;
const LINE_PAD = 3.2; // how close to the shooting line counts as "at the line"
const RACK_REACH = 4.2;
const NPC_REACH = 2.4;
const NPC_LANES = [0, LANE_COUNT - 1] as const;

const RING_NAMES = ["GOLD!", "RED!", "BLUE!", "BLACK", "WHITE"] as const;

type Ctx = {
  player: Player;
  input: Input;
  hud: HUD;
  chase: ChaseCamera;
  camera: THREE.PerspectiveCamera;
};

type ArrowMode = "free" | "fly" | "stuck" | "ground";

type Arrow = {
  mode: ArrowMode;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: number;
  age: number; // flight seconds / rest seconds, per mode
  travelled: number;
  fromPlayer: boolean;
  endSlot: number; // which pip this player arrow fills (-1 for NPC arrows)
  stuckOrder: number; // FIFO ticket for the stuck cap
};

// per-frame scratch — the flight loop allocates nothing
const S = {
  seg: new THREE.Vector3(),
  dir: new THREE.Vector3(),
  toFace: new THREE.Vector3(),
  hit: new THREE.Vector3(),
  m: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  v: new THREE.Vector3(),
  v2: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  e: new THREE.Euler(),
  s: new THREE.Vector3()
};

export class ArcheryGame {
  /** Everything archery renders lives under here — the site gate hides it whole. */
  root = new THREE.Group();

  #wq: WorldQueries;
  #audio: ArcheryAudio;
  #ui = new ArcheryUI();
  #targets: ArcheryTarget[];
  #rackXZ: { x: number; z: number };
  #npcs: NpcArchers;
  #daylight: () => boolean;

  #siteAwake = false;
  /** probe counter: increments only when update() does real work */
  updatesRan = 0;

  // player flow
  #holding = false;
  #drawing = false;
  #charge = 0;
  #nockT = 0;
  #releaseT = 0;
  #releasedCharge = 0;
  #lane = 2;
  #nearLine = false;
  #promptShown = false;
  #takenOverNpc = -1;

  // scoring: an end of six. endScores[i] = -1 not shot, 0 miss, else ring pts
  #endScores: number[] = new Array(ARROWS_PER_END).fill(-1);
  #shotIdx = 0;
  #endTotal = 0;
  #grandTotal = 0;
  #endResetAt = 0;

  // arrow pool: two instanced meshes (shaft+tip, fletches) for EVERY arrow —
  // player shots, NPC shots, stuck and fading alike. 2 draws total.
  #arrows: Arrow[] = [];
  #shaftMesh: THREE.InstancedMesh;
  #fletchMesh: THREE.InstancedMesh;
  #stuckTicket = 0;

  constructor(map: WorldMap, worldQueries: WorldQueries, scene: THREE.Scene, opts: { nature: NatureSoundscape; daylight?: () => boolean }) {
    this.#wq = worldQueries;
    this.#audio = new ArcheryAudio(opts.nature);
    this.#daylight = opts.daylight ?? (() => true);

    // Born asleep: hidden root, frozen matrix pass (site-gate recipe).
    this.root.name = "archery";
    this.root.visible = false;
    this.root.matrixWorldAutoUpdate = false;
    scene.add(this.root);

    const site = buildArcherySite(map);
    this.root.add(site.group);
    this.#targets = site.targets;
    this.#rackXZ = site.rackXZ;

    this.#npcs = new NpcArchers(
      NPC_LANES,
      this.#targets,
      (x, z) => map.groundTop(x, z),
      (origin, dir, speed, _lane) => {
        this.#spawnArrow(origin, dir, speed, false, -1);
        this.#audio.loose(origin.x, origin.y, origin.z, 0.8, true);
      },
      (x, y, z) => this.#audio.drawCreak(x, y, z, 1.2, true)
    );
    this.root.add(this.#npcs.group);

    // arrow instancing: shaft+tip merged into one geometry (+Y = tip, origin
    // at the nock, matching held.ts buildArrow), fins in a second mesh
    const shaft = new THREE.CylinderGeometry(0.008, 0.008, 0.66, 5);
    shaft.translate(0, 0.35, 0);
    const tip = new THREE.ConeGeometry(0.016, 0.06, 5);
    tip.translate(0, 0.7, 0);
    const shaftGeo = mergeGeometries([shaft, tip], false)!;
    shaft.dispose();
    tip.dispose();
    const finParts: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 3; i++) {
      const fin = new THREE.BoxGeometry(0.004, 0.09, 0.03);
      fin.translate(0, 0.075, 0.017);
      fin.applyMatrix4(S.m.makeRotationY((i / 3) * Math.PI * 2));
      finParts.push(fin);
    }
    const finGeo = mergeGeometries(finParts, false)!;
    for (const f of finParts) f.dispose();
    this.#shaftMesh = new THREE.InstancedMesh(shaftGeo, new THREE.MeshLambertMaterial({ color: 0xc9a86a }), ARROW_CAP);
    this.#fletchMesh = new THREE.InstancedMesh(finGeo, new THREE.MeshLambertMaterial({ color: 0xdd5544 }), ARROW_CAP);
    for (const m of [this.#shaftMesh, this.#fletchMesh]) {
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.castShadow = false;
      m.frustumCulled = false; // instances span the whole range; root gating owns culling
      this.root.add(m);
    }
    for (let i = 0; i < ARROW_CAP; i++) {
      this.#arrows.push({
        mode: "free",
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        scale: 0,
        age: 0,
        travelled: 0,
        fromPlayer: false,
        endSlot: -1,
        stuckOrder: 0
      });
    }
    this.#writeInstances();

    if (import.meta.env.DEV) {
      Object.assign(window as object, {
        __archery: {
          game: this,
          targets: this.#targets,
          /** Deterministic shot for probes: fire straight at lane's target
           *  centre offset by (side, up) metres in the face plane, from 12 m
           *  out along the face normal (fast + flat → lands where aimed). */
          fire: (lane: number, offSide = 0, offUp = 0) => {
            const t = this.#targets.find((tt) => tt.lane === lane)!;
            const origin = new THREE.Vector3().copy(t.center).addScaledVector(t.normal, 12);
            const side = new THREE.Vector3().crossVectors(t.normal, S.up).normalize();
            const aimAt = new THREE.Vector3()
              .copy(t.center)
              .addScaledVector(side, offSide)
              .addScaledVector(S.up, offUp)
              .addScaledVector(t.normal, -0.02);
            // pre-compensate the ~12 m gravity drop at 60 m/s (t≈0.2 s → 0.2 m)
            aimAt.y += 0.5 * GRAVITY * Math.pow(12 / 60, 2);
            const dir = aimAt.sub(origin).normalize();
            this.#spawnArrow(origin, dir, 60, true, this.#shotIdx < ARROWS_PER_END ? this.#shotIdx : -1);
            if (this.#shotIdx < ARROWS_PER_END) this.#shotIdx++;
          },
          npcs: this.#npcs,
          stats: () => ({
            updatesRan: this.updatesRan,
            npcPhases: this.#npcs.debugPhases(),
            awake: this.#siteAwake,
            visible: this.root.visible,
            flying: this.arrowsInFlight,
            stuck: this.#arrows.filter((a) => a.mode === "stuck").length,
            holding: this.#holding,
            end: [...this.#endScores],
            endTotal: this.#endTotal,
            grandTotal: this.#grandTotal
          })
        }
      });
    }
  }

  // ------------------------------------------------------------- site gate

  get siteAwake(): boolean {
    return this.#siteAwake;
  }

  get arrowsInFlight(): number {
    let n = 0;
    for (const a of this.#arrows) if (a.mode === "fly") n++;
    return n;
  }

  /** Held bow or live arrows hold the site awake (never leaks: putting the
   *  bow back and arrows resolving both clear within seconds). */
  get playerEngaged(): boolean {
    return this.#holding || this.arrowsInFlight > 0;
  }

  setSiteAwake(on: boolean) {
    if (this.#siteAwake === on) return;
    this.#siteAwake = on;
    this.root.visible = on;
    this.root.matrixWorldAutoUpdate = on;
    this.#audio.setAwake(on);
    if (on) {
      this.root.updateMatrixWorld(true);
      this.#npcs.setShown(this.#daylight());
    } else {
      this.#promptShown = false;
    }
  }

  /** The registration record main.ts hands to siteGate.register(). */
  siteHooks(): GameSite {
    return {
      id: "archery",
      contains: (x, z, pad) => inArcheryRange(x, z, pad),
      activatePad: ARCHERY_SITE_PADS.activate,
      deactivatePad: ARCHERY_SITE_PADS.deactivate,
      keepAwake: () => this.playerEngaged,
      setAwake: (on) => this.setSiteAwake(on)
    };
  }

  /** main.ts: the click-tools stand down while the bow owns the mouse. */
  get capturesFire(): boolean {
    return this.#holding && (this.#drawing || this.#nearLine);
  }

  // ------------------------------------------------------------- E-chain

  /** main.ts E-chain: pick a bow off the rack / at the line, take over an NPC
   *  lane, or put a held bow back. Returns true = E consumed. */
  tryInteract(player: Player, hud: HUD): boolean {
    if (player.mode !== "walk" || !this.#siteAwake) return false;
    if (this.#holding) {
      if (this.#drawing) return true; // mid-draw E is swallowed, not a putback
      this.#putBack(player);
      hud.message("Bow returned 🏹", 2.2);
      return true;
    }
    const p = player.renderPosition;
    if (!inArcheryRange(p.x, p.z, 8)) return false;
    // an NPC lane takeover wins over a plain rack grab when beside one
    const npcIdx = this.#npcs.nearestLane(p.x, p.z, NPC_REACH);
    if (npcIdx >= 0) {
      this.#npcs.setTakenOver(npcIdx, true);
      this.#takenOverNpc = npcIdx;
      this.#equip(hud, `Lane ${this.#npcs.laneOf(npcIdx) + 1} is yours — hold click to draw 🏹`);
      return true;
    }
    const nearRack = Math.hypot(p.x - this.#rackXZ.x, p.z - this.#rackXZ.z) < RACK_REACH;
    const local = archeryLocal(p.x, p.z);
    const nearLine = Math.abs(local.u) < LINE_PAD && Math.abs(local.v) < laneV(LANE_COUNT - 1) + LANE_SPACING;
    if (nearRack || nearLine) {
      this.#equip(hud, "Bow in hand — stand on the white line, hold click to draw 🏹");
      return true;
    }
    return false;
  }

  #equip(hud: HUD, msg: string) {
    this.#holding = true;
    this.#drawing = false;
    this.#charge = 0;
    this.#resetEnd();
    this.#ui.setVisible(true);
    this.#ui.setEnd(this.#endScores, this.#endTotal, this.#grandTotal);
    hud.message(msg, 3);
  }

  #putBack(player: Player) {
    this.#holding = false;
    this.#drawing = false;
    player.setArcherPose(false);
    player.setBowCarried(false);
    this.#ui.setVisible(false);
    if (this.#takenOverNpc >= 0) {
      this.#npcs.setTakenOver(this.#takenOverNpc, false);
      this.#takenOverNpc = -1;
    }
  }

  #resetEnd() {
    this.#endScores.fill(-1);
    this.#shotIdx = 0;
    this.#endTotal = 0;
    this.#endResetAt = 0;
  }

  // ------------------------------------------------------------- per frame

  update(dt: number, _elapsed: number, ctx: Ctx) {
    // Asleep with nothing live: the whole feature costs this one test.
    if (!this.#siteAwake && !this.playerEngaged) return;
    this.updatesRan++;
    dt = Math.min(dt, 0.1);

    this.#ui.update();
    this.#stepArrows(dt, ctx.hud);
    this.#npcs.setShown(this.#daylight());
    this.#npcs.update(dt, ctx.player.renderPosition.x, ctx.player.renderPosition.z);
    this.#updatePlayer(dt, ctx);
  }

  #updatePlayer(dt: number, ctx: Ctx) {
    const { player, input, hud, chase, camera } = ctx;
    const p = player.renderPosition;
    const onFoot = player.mode === "walk";

    if (!this.#holding) {
      // gentle nudge at the rack / line, golf's tee-prompt pattern
      if (onFoot && this.#siteAwake) {
        const nearRack = Math.hypot(p.x - this.#rackXZ.x, p.z - this.#rackXZ.z) < RACK_REACH;
        const local = archeryLocal(p.x, p.z);
        const nearLine = Math.abs(local.u) < LINE_PAD && Math.abs(local.v) < laneV(LANE_COUNT - 1) + LANE_SPACING;
        const nearNpc = this.#npcs.nearestLane(p.x, p.z, NPC_REACH) >= 0;
        if (nearRack || nearLine || nearNpc) {
          if (!this.#promptShown) {
            hud.message(nearNpc ? "Press E — take over this lane 🏹" : "Press E — pick up a bow 🏹", 2.4);
            this.#promptShown = true;
          }
        } else this.#promptShown = false;
      }
      return;
    }

    // holding: dropping the walk mode (vehicles, swimming) or wandering off
    // the field quietly racks the bow
    if (!onFoot || !inArcheryRange(p.x, p.z, 45)) {
      this.#putBack(player);
      if (inArcheryRange(p.x, p.z, 200)) hud.message("You set the bow down", 2);
      return;
    }

    const local = archeryLocal(p.x, p.z);
    this.#nearLine = Math.abs(local.u) < LINE_PAD && Math.abs(local.v) < laneV(LANE_COUNT - 1) + LANE_SPACING;
    this.#lane = THREE.MathUtils.clamp(Math.round(local.v / LANE_SPACING + (LANE_COUNT - 1) / 2), 0, LANE_COUNT - 1);
    const target = this.#targets[this.#lane];

    player.setBowCarried(true);

    // release-follow-through easing after a loose
    if (this.#releaseT > 0) {
      this.#releaseT -= dt;
      const k = Math.max(0, this.#releaseT / RELEASE_TIME);
      player.setArcherPose(true, this.#releasedCharge * k * 0.35, 0);
      this.#ui.setDraw(0, target.distance);
      return;
    }

    if (!this.#drawing) {
      player.setArcherPose(false);
      this.#ui.showDraw(this.#nearLine);
      if (this.#nearLine) this.#ui.setDraw(0, target.distance);
      // start the draw: hold fire at the line (kb focus rules match golf)
      if (this.#nearLine && input.firing && !input.freeCursor && !input.suspended) {
        this.#drawing = true;
        this.#charge = 0;
        this.#nockT = NOCK_TIME;
        this.#audio.drawCreak(p.x, p.y + 0.5, p.z, DRAW_TIME + NOCK_TIME);
      }
      return;
    }

    // ---- drawing
    const aimYaw = chase.yaw + Math.PI;
    // face downrange: poseArcher aims along the rig's local +X
    player.heading = aimYaw + Math.PI / 2;
    camera.getWorldDirection(S.dir);
    const pitch = Math.asin(THREE.MathUtils.clamp(S.dir.y, -0.95, 0.95));

    // sprinting out of the stance (or losing kb focus) cancels, never fires
    const moving = Math.hypot(player.velocity.x, player.velocity.z) > 2;
    const focusLost = input.device === "kb" && (!input.locked || !document.hasFocus());
    if (moving || focusLost || !this.#nearLine) {
      this.#drawing = false;
      player.setArcherPose(false);
      return;
    }

    if (input.firing) {
      if (this.#nockT > 0) {
        this.#nockT -= dt;
        player.setArcherPose(true, -(1 - Math.max(0, this.#nockT) / NOCK_TIME), pitch);
      } else {
        this.#charge = Math.min(1, this.#charge + dt / DRAW_TIME);
        player.setArcherPose(true, this.#charge, pitch);
      }
      this.#ui.showDraw(true);
      this.#ui.setDraw(this.#charge, target.distance);
      return;
    }

    // released — loose! (a release during the nock flourish just cancels)
    this.#drawing = false;
    if (this.#nockT > 0 || this.#charge < 0.05) {
      player.setArcherPose(false);
      return;
    }
    camera.getWorldDirection(S.dir);
    S.dir.y += 0.012; // a hair of loft so point-blank aim reads true at range
    S.dir.normalize();
    S.v.copy(p);
    S.v.y += 0.55; // chest anchor
    S.v.addScaledVector(S.dir, 0.6);
    const speed = 20 + this.#charge * 35;
    const slot = this.#shotIdx < ARROWS_PER_END ? this.#shotIdx : -1;
    if (slot >= 0) this.#shotIdx++;
    this.#spawnArrow(S.v, S.dir, speed, true, slot);
    this.#audio.loose(S.v.x, S.v.y, S.v.z, this.#charge);
    this.#releasedCharge = this.#charge;
    this.#releaseT = RELEASE_TIME;
    this.#charge = 0;
    this.#ui.setDraw(0, target.distance);
  }

  // ------------------------------------------------------------- arrows

  #spawnArrow(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, fromPlayer: boolean, endSlot: number) {
    let arrow = this.#arrows.find((a) => a.mode === "free");
    if (!arrow) {
      // pool exhausted: recycle the oldest stuck arrow
      arrow = this.#oldestStuck() ?? this.#arrows[0];
    }
    arrow.mode = "fly";
    arrow.pos.copy(origin);
    arrow.vel.copy(dir).multiplyScalar(speed);
    arrow.quat.setFromUnitVectors(S.up, S.v2.copy(dir).normalize());
    arrow.scale = 1;
    arrow.age = 0;
    arrow.travelled = 0;
    arrow.fromPlayer = fromPlayer;
    arrow.endSlot = endSlot;
  }

  #oldestStuck(): Arrow | null {
    let best: Arrow | null = null;
    for (const a of this.#arrows) {
      if (a.mode !== "stuck") continue;
      if (!best || a.stuckOrder < best.stuckOrder) best = a;
    }
    return best;
  }

  #enforceStuckCap() {
    let count = 0;
    for (const a of this.#arrows) if (a.mode === "stuck") count++;
    while (count > STUCK_CAP) {
      const oldest = this.#oldestStuck();
      if (!oldest) break;
      oldest.mode = "free";
      oldest.scale = 0;
      count--;
    }
  }

  #stepArrows(dt: number, hud: HUD) {
    let dirty = false;
    for (const arrow of this.#arrows) {
      if (arrow.mode === "free" || arrow.mode === "stuck") continue; // stuck = static, already written
      dirty = true;

      if (arrow.mode === "ground") {
        arrow.age += dt;
        if (arrow.age > GROUND_FADE_DELAY) {
          // "fade": ground arrows shrink away (instances can't blend opacity)
          arrow.scale = Math.max(0, 1 - (arrow.age - GROUND_FADE_DELAY) / 0.8);
          if (arrow.scale <= 0) arrow.mode = "free";
        }
        continue;
      }

      // ---- flight
      arrow.age += dt;
      arrow.vel.y -= GRAVITY * dt;
      S.seg.copy(arrow.vel).multiplyScalar(dt);
      const segLen = S.seg.length();
      S.dir.copy(S.seg).divideScalar(Math.max(segLen, 1e-6));

      // 1) analytic disc test against every target face (5 targets, cheap)
      let resolved = false;
      for (const t of this.#targets) {
        const denom = S.seg.dot(t.normal);
        if (denom >= 0) continue; // flying away from / parallel to the face
        S.toFace.copy(t.center).sub(arrow.pos);
        const s = S.toFace.dot(t.normal) / denom;
        if (s < 0 || s > 1) continue;
        S.hit.copy(arrow.pos).addScaledVector(S.seg, s);
        const r = S.v.copy(S.hit).sub(t.center).length();
        if (r > t.radius + 0.02) continue;
        this.#stickInTarget(arrow, r, S.hit, hud);
        resolved = true;
        break;
      }
      if (resolved) continue;

      // 2) world raycast for everything else (terrain, trees, buildings)
      const hit = this.#wq.raycast(arrow.pos, S.dir, segLen);
      if (hit) {
        arrow.pos.copy(hit.point).addScaledVector(S.dir, -(0.7 - 0.24)); // tip buried ~0.24
        arrow.quat.setFromUnitVectors(S.up, S.dir);
        arrow.mode = "ground";
        arrow.age = 0;
        const soundQuiet = !arrow.fromPlayer;
        if (hit.kind === "terrain" || hit.kind === "water") this.#audio.thunk(hit.point.x, hit.point.y, hit.point.z, soundQuiet);
        else this.#audio.crack(hit.point.x, hit.point.y, hit.point.z, soundQuiet);
        if (arrow.fromPlayer && arrow.endSlot >= 0) this.#scoreArrow(arrow.endSlot, 0, hud);
        continue;
      }

      arrow.pos.add(S.seg);
      arrow.travelled += segLen;
      arrow.quat.setFromUnitVectors(S.up, S.v2.copy(arrow.vel).normalize());
      if (arrow.age > MAX_FLIGHT_SECONDS || arrow.travelled > MAX_FLIGHT_METRES) {
        if (arrow.fromPlayer && arrow.endSlot >= 0) this.#scoreArrow(arrow.endSlot, 0, hud);
        arrow.mode = "free";
        arrow.scale = 0;
      }
    }
    if (dirty) this.#writeInstances();

    // deferred end reset: after the summary toast, clear pips + fade the
    // player's arrows out of the targets
    if (this.#endResetAt > 0 && performance.now() >= this.#endResetAt) {
      this.#endResetAt = 0;
      for (const a of this.#arrows) {
        if (a.mode === "stuck" && a.fromPlayer) {
          a.mode = "ground"; // reuse the shrink-out path
          a.age = GROUND_FADE_DELAY;
        }
      }
      const grand = this.#grandTotal;
      this.#resetEnd();
      this.#grandTotal = grand;
      this.#ui.setEnd(this.#endScores, this.#endTotal, this.#grandTotal);
    }
  }

  #stickInTarget(arrow: Arrow, r: number, hitPoint: THREE.Vector3, hud: HUD) {
    // ring by radial distance (gold outward)
    let score = 0;
    for (let i = 0; i < RING_RADII.length; i++) {
      if (r <= RING_RADII[i]) {
        score = RING_SCORES[i];
        break;
      }
    }
    // stick: nock out toward the shooter, slight random tilt for texture
    S.dir.copy(arrow.vel).normalize();
    arrow.quat.setFromUnitVectors(S.up, S.dir);
    S.q.setFromEuler(S.e.set((Math.random() - 0.5) * 0.12, (Math.random() - 0.5) * 0.12, 0));
    arrow.quat.multiply(S.q);
    // place the nock so the tip sits ~0.14 into the straw
    arrow.pos.copy(hitPoint).addScaledVector(S.dir, -(0.7 - 0.14));
    arrow.mode = "stuck";
    arrow.scale = 1;
    arrow.age = 0;
    arrow.stuckOrder = this.#stuckTicket++;
    this.#enforceStuckCap();

    const quiet = !arrow.fromPlayer;
    this.#audio.thunk(hitPoint.x, hitPoint.y, hitPoint.z, quiet);
    if (arrow.fromPlayer) {
      this.#audio.chime(score, hitPoint.x, hitPoint.y, hitPoint.z);
      if (arrow.endSlot >= 0) this.#scoreArrow(arrow.endSlot, score, hud);
    }
  }

  #scoreArrow(slot: number, score: number, hud: HUD) {
    if (this.#endScores[slot] >= 0) return; // already resolved (safety)
    this.#endScores[slot] = score;
    this.#endTotal += score;
    this.#grandTotal += score;
    if (score > 0) {
      const ringIdx = RING_SCORES.indexOf(score as (typeof RING_SCORES)[number]);
      this.#ui.toast(`${RING_NAMES[ringIdx]} +${score}`, ringColorCss(score));
    } else if (this.#holding) {
      this.#ui.toast("MISS", "rgba(233, 244, 250, 0.55)", 1);
    }
    this.#ui.setEnd(this.#endScores, this.#endTotal, this.#grandTotal);
    // end complete once every pip has resolved
    if (this.#endScores.every((s) => s >= 0)) {
      this.#ui.toast(`End complete — ${this.#endTotal} pts · Total ${this.#grandTotal}`, "var(--accent-strong)", 2.6);
      hud.message(`End of 6: ${this.#endTotal} points 🏹`, 3);
      this.#endResetAt = performance.now() + 2600;
    }
  }

  /** Push every slot's transform into the two instanced meshes. */
  #writeInstances() {
    for (let i = 0; i < ARROW_CAP; i++) {
      const a = this.#arrows[i];
      const sc = a.mode === "free" ? 0 : a.scale;
      S.m.compose(a.pos, a.quat, S.s.set(sc, sc, sc));
      this.#shaftMesh.setMatrixAt(i, S.m);
      this.#fletchMesh.setMatrixAt(i, S.m);
    }
    this.#shaftMesh.instanceMatrix.needsUpdate = true;
    this.#fletchMesh.instanceMatrix.needsUpdate = true;
  }
}
