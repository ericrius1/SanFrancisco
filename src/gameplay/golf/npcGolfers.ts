import * as THREE from "three/webgpu";
import type { Physics } from "../../core/physics";
import type { WorldMap } from "../../world/heightmap";
import { avatarFromSeed } from "../../player/avatar";
import { buildRig, poseGolf, poseIdle, poseWalk, type Rig } from "../../player/rig";
import { attachToHand, buildGolfClub, secondHandCurl, GOLF_CLUB_GRIP } from "../../player/held";
import { BALL_RADIUS, CLUBS, GolfBall, estimatedCarry, suggestedClubIndex, type BallEvent, type Club } from "./ball";
import type { GolfCourse, GolfSurface } from "./data";
import type { GolfAudio } from "./audio";

/**
 * Ambient NPC golfer groups: during the day a few twosomes are out on the
 * Presidio course actually playing — address, swing, real GolfBall flight,
 * walk to the ball, hole out, next tee. They are companions, not opponents:
 * walk up to one and press E (GolfGame.tryStartAtTee → joinHole) to start
 * your own round at their hole and play alongside.
 *
 * Owned by GolfGame: constructed under the gated golf root (hides with the
 * site) and updated only while the site is awake, so far-away golf costs
 * nothing. Within ANIM_RADIUS the groups animate fully (poses + walks); past
 * it they freeze and progress by cheap teleport steps on a slow timer, so no
 * unseen golfer ever simulates a stroll. At night they pack up (hidden), with
 * a debounce so time-scrubbing doesn't strobe them.
 */

const START_HOLES = [1, 6, 11]; // staggered starts: holes 2, 7, 12 (refs)
const GOLFERS_PER_GROUP = 2;
const ANIM_RADIUS = 160; // full pose/walk animation inside this
const AUDIO_RADIUS = 60; // quiet NPC thwacks inside this
const WALK_SPEED = 1.6; // m/s fairway stroll
const RIG_LIFT = 0.92; // rig group origin (hip) above the golf ground
const SWING_TIME = 0.46; // same downswing feel as the player (game.ts)
const IDLE_DWELL = 0.8; // settle beside the ball before addressing
const ADDRESS_TIME = 1.0; // ease into the backswing
const FINISH_HOLD = 0.5; // admire the shot before relaxing
const HOLE_OUT_DIST = 0.35; // close enough — tap-in conceded
const MAX_STROKES = 4; // then they pick up (pace of play!)
const FAR_STEP_SECONDS = 11; // far-mode: one whole shot resolved per timer tick
const DAY_DEBOUNCE = 2.0; // seconds the day/night signal must hold to flip

// one shared ball look for every NPC ball (they're all range balls anyway)
const NPC_BALL_GEO = new THREE.SphereGeometry(BALL_RADIUS, 10, 8);
const NPC_BALL_MAT = new THREE.MeshLambertMaterial({ color: 0xf2f4ef });
// buskers' shadow diet threshold: tiny boxes never earn their cascade encode
const CASTER_MIN_VOLUME = 1.5e-3;

type GolferPhase = "idle" | "walk" | "address" | "swing" | "watch";

type Golfer = {
  rig: Rig;
  ball: GolfBall;
  ballMesh: THREE.Mesh;
  pos: THREE.Vector3; // feet position on the golf ground
  heading: number; // rig group rotation.y
  phase: GolferPhase;
  t: number; // time in phase
  stride: number; // walk cycle phase
  walkTo: THREE.Vector3;
  waypoint: THREE.Vector3 | null; // one-leg water detour
  strokes: number;
  done: boolean; // holed out (or picked up) this hole
  charge: number; // committed swing power for the current shot
  aimYaw: number;
  club: Club;
  struck: boolean; // downswing already released its ball
  preShot: THREE.Vector3; // penalty drops replay from here
  event: BallEvent | null; // stashed ball outcome (fires inside ball.update)
  dirty: boolean; // pose/transform changed → refresh matrices
};

type GroupPhase = "turns" | "advance";

class GolferGroup {
  readonly golfers: Golfer[] = [];
  holeIdx: number;
  phase: GroupPhase = "turns";
  turn = -1;
  farTimer: number;

  readonly #course: GolfCourse;
  readonly #map: WorldMap;
  readonly #pin = new THREE.Vector3();
  readonly #tee = new THREE.Vector3();
  readonly #tmp = new THREE.Vector3();

  constructor(course: GolfCourse, map: WorldMap, physics: Physics, holeIdx: number, seed: string, parent: THREE.Object3D) {
    this.#course = course;
    this.#map = map;
    this.holeIdx = holeIdx;
    this.farTimer = Math.random() * FAR_STEP_SECONDS; // desync group cadence
    for (let i = 0; i < GOLFERS_PER_GROUP; i++) {
      const rig = buildRig(avatarFromSeed(`${seed}-golfer-${i}`));
      const club = buildGolfClub();
      club.visible = true; // buildGolfClub ships hidden; NPCs always carry it
      attachToHand(rig, "R", club, GOLF_CLUB_GRIP);
      secondHandCurl(rig, "L", 1);
      poseGolf(rig, 0); // seed the wrist carry so the club never points wild
      poseIdle(rig, 0);
      applyShadowDiet(rig.group);
      // pruned from the scene matrix pass; refreshed manually when animating
      rig.group.matrixWorldAutoUpdate = false;
      parent.add(rig.group);

      const ball = new GolfBall(course, map, physics);
      const ballMesh = new THREE.Mesh(NPC_BALL_GEO, NPC_BALL_MAT);
      parent.add(ballMesh);

      const g: Golfer = {
        rig,
        ball,
        ballMesh,
        pos: new THREE.Vector3(),
        heading: 0,
        phase: "idle",
        t: Math.random(), // desync idle breathing
        stride: 0,
        walkTo: new THREE.Vector3(),
        waypoint: null,
        strokes: 0,
        done: false,
        charge: 0.7,
        aimYaw: 0,
        club: CLUBS[0],
        struck: false,
        preShot: new THREE.Vector3(),
        event: null,
        dirty: true
      };
      ball.onEvent = (e) => {
        g.event = e;
      };
      this.golfers.push(g);
    }
    this.#setupHole(holeIdx, true);
  }

  /** Anyone in this group close enough to (x,z) to offer the E-join? */
  nearGolfer(x: number, z: number, r: number): boolean {
    for (const g of this.golfers) {
      if (Math.hypot(g.pos.x - x, g.pos.z - z) < r) return true;
    }
    return false;
  }

  setVisible(on: boolean) {
    for (const g of this.golfers) {
      g.rig.group.visible = on;
      g.ballMesh.visible = on && !g.done;
      if (on) g.dirty = true;
    }
  }

  /** Place both golfers + balls on a hole's tee. `teleport` skips the walk. */
  #setupHole(holeIdx: number, teleport: boolean) {
    this.holeIdx = holeIdx;
    this.#course.pin(holeIdx, this.#pin);
    this.#course.teeSpot(holeIdx, this.#tee);
    const aim = this.#course.teeAim(holeIdx);
    this.golfers.forEach((g, i) => {
      const side = i === 0 ? -0.5 : 0.5;
      // balls a step apart on the pad; golfers stand at their address spots
      const bx = this.#tee.x - Math.cos(aim) * side;
      const bz = this.#tee.z + Math.sin(aim) * side;
      g.ball.place(bx, this.#course.ground(bx, bz) + BALL_RADIUS, bz);
      g.ballMesh.position.copy(g.ball.pos);
      g.ballMesh.visible = g.rig.group.visible;
      g.strokes = 0;
      g.done = false;
      g.event = null;
      g.struck = false;
      if (teleport) {
        this.#addressSpot(g, aim, this.#tmp);
        // the away golfer waits a couple of steps behind the teeing one
        if (i > 0) {
          this.#tmp.x -= Math.sin(aim) * 2.2 - 0.6;
          this.#tmp.z -= Math.cos(aim) * 2.2;
        }
        this.#placeGolfer(g, this.#tmp.x, this.#tmp.z, aim + Math.PI / 2);
        g.phase = "idle";
        g.t = Math.random() * 0.5;
      }
    });
    this.phase = "turns";
    this.turn = -1;
  }

  /** Stance beside a golfer's ball for shot yaw `aim` (same offsets the local
   *  player uses in game.ts — lead side down the line, a touch behind). */
  #addressSpot(g: Golfer, aim: number, out: THREE.Vector3): THREE.Vector3 {
    const b = g.ball.pos;
    out.set(b.x + Math.cos(aim) * 0.6 - Math.sin(aim) * 0.12, 0, b.z - Math.sin(aim) * 0.6 - Math.cos(aim) * 0.12);
    return out;
  }

  #placeGolfer(g: Golfer, x: number, z: number, heading: number) {
    g.pos.set(x, this.#course.ground(x, z), z);
    g.heading = heading;
    g.rig.group.position.set(x, g.pos.y + RIG_LIFT, z);
    g.rig.group.rotation.y = heading;
    g.dirty = true;
  }

  /** Farthest-from-pin golfer still playing hits next (real golf "away"). */
  #nextTurn(): number {
    let best = -1;
    let bd = -1;
    this.golfers.forEach((g, i) => {
      if (g.done) return;
      const d = Math.hypot(g.ball.pos.x - this.#pin.x, g.ball.pos.z - this.#pin.z);
      if (d > bd) {
        bd = d;
        best = i;
      }
    });
    return best;
  }

  /** Choose club/power/aim for a golfer's current lie. Plausible, not perfect. */
  #planShot(g: Golfer) {
    const b = g.ball.pos;
    const dist = Math.hypot(b.x - this.#pin.x, b.z - this.#pin.z);
    const lie = this.#course.surfaceAt(b.x, b.z).kind;
    g.club = CLUBS[suggestedClubIndex(dist, lie)];
    let power: number;
    if (g.club.id === "putter") power = Math.sqrt(Math.min(1, dist / g.club.carry));
    else power = THREE.MathUtils.clamp(dist / Math.max(1, estimatedCarry(g.club, 1, lie)), 0.35, 1);
    g.charge = THREE.MathUtils.clamp(power * (0.95 + Math.random() * 0.08), 0.2, 1);
    g.aimYaw = Math.atan2(this.#pin.x - b.x, this.#pin.z - b.z) + (Math.random() - 0.5) * 0.09;
    g.preShot.copy(b);
  }

  #strike(g: Golfer, onStrike: (power: number, putter: boolean, at: THREE.Vector3) => void) {
    const lie = this.#course.surfaceAt(g.ball.pos.x, g.ball.pos.z).kind as GolfSurface;
    g.strokes += 1;
    g.ball.strike(g.club, g.aimYaw, g.charge, lie, this.#pin);
    g.struck = true;
    onStrike(g.charge, g.club.id === "putter", g.ball.pos);
  }

  /** The struck ball came to a stop (rest/water/holed) — score it, next turn. */
  #resolveShot(g: Golfer) {
    const e = g.event;
    g.event = null;
    if (e && e.kind === "water") {
      g.strokes += 1;
      g.ball.place(g.preShot.x, g.preShot.y, g.preShot.z);
    } else if (e && e.kind === "rest" && e.surface === "out") {
      g.strokes += 1;
      g.ball.place(g.preShot.x, g.preShot.y, g.preShot.z);
    }
    g.ballMesh.position.copy(g.ball.pos);
    const dPin = Math.hypot(g.ball.pos.x - this.#pin.x, g.ball.pos.z - this.#pin.z);
    if (g.ball.phase === "holed" || dPin < HOLE_OUT_DIST || g.strokes >= MAX_STROKES) {
      g.done = true;
      g.ballMesh.visible = false;
    }
    this.turn = -1;
    if (this.golfers.every((o) => o.done)) {
      this.phase = "advance";
      // near mode walks the group over; far mode teleports on its timer
      const next = (this.holeIdx + 1) % this.#course.holes.length;
      this.#course.teeSpot(next, this.#tmp);
      this.golfers.forEach((g2, i) => {
        g2.walkTo.set(this.#tmp.x + (i === 0 ? -0.8 : 0.8), 0, this.#tmp.z + (i === 0 ? 0.4 : -0.4));
        g2.waypoint = null;
      });
    }
  }

  /** One straight-line (with a single water sidestep) walk step. True = arrived. */
  #walkStep(g: Golfer, dt: number): boolean {
    const map = this.#map;
    const target = g.waypoint ?? g.walkTo;
    const dx = target.x - g.pos.x;
    const dz = target.z - g.pos.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.25) {
      if (g.waypoint) {
        g.waypoint = null;
        return false;
      }
      return true;
    }
    const step = Math.min(d, WALK_SPEED * dt);
    let nx = g.pos.x + (dx / d) * step;
    let nz = g.pos.z + (dz / d) * step;
    // simple water avoidance: about to wade → sidestep via a lateral waypoint
    if (!g.waypoint && map.isWater(nx, nz)) {
      const px = -dz / d;
      const pz = dx / d;
      const side = map.isWater(g.pos.x + px * 8, g.pos.z + pz * 8) ? -1 : 1;
      g.waypoint = new THREE.Vector3(g.pos.x + px * 9 * side, 0, g.pos.z + pz * 9 * side);
      return false;
    }
    g.heading = Math.atan2(dx, dz) + Math.PI; // rig front (-Z) down the path
    this.#placeGolfer(g, nx, nz, g.heading);
    g.stride += dt * (WALK_SPEED * 3.4);
    poseWalk(g.rig, g.stride, 0);
    return false;
  }

  /** Full animated update (player nearby). */
  updateNear(dt: number, elapsed: number, onStrike: (power: number, putter: boolean, at: THREE.Vector3) => void) {
    if (this.phase === "advance") {
      let allThere = true;
      for (const g of this.golfers) {
        if (!this.#walkStep(g, dt)) allThere = false;
        else {
          poseIdle(g.rig, elapsed + g.t * 7);
          g.dirty = true;
        }
      }
      if (allThere) this.#setupHole((this.holeIdx + 1) % this.#course.holes.length, true);
      this.#refresh();
      return;
    }

    if (this.turn < 0) {
      this.turn = this.#nextTurn();
      if (this.turn >= 0) {
        const g = this.golfers[this.turn];
        this.#planShot(g);
        this.#addressSpot(g, g.aimYaw, g.walkTo);
        g.waypoint = null;
        g.phase = "walk";
        g.struck = false;
      }
    }

    const active = this.turn >= 0 ? this.golfers[this.turn] : null;
    for (let i = 0; i < this.golfers.length; i++) {
      const g = this.golfers[i];
      if (g === active) this.#updateTurnGolfer(g, dt, onStrike);
      else {
        // partner: drift to a spot beside their own ball, then watch
        const near = Math.hypot(g.pos.x - g.walkTo.x, g.pos.z - g.walkTo.z) < 0.4;
        if (!g.done && !near && g.phase === "walk") {
          this.#walkStep(g, dt);
        } else {
          g.phase = "idle";
          g.t += dt;
          poseIdle(g.rig, elapsed + g.t);
          // watch the live ball (or the golfer about to hit)
          if (active) this.#headTrack(g, active.ball.moving ? active.ball.pos : active.pos);
          g.dirty = true;
        }
      }
      if (g.ball.moving) {
        g.ball.update(dt);
        g.ballMesh.position.copy(g.ball.pos);
      }
    }
    this.#refresh();
  }

  #updateTurnGolfer(g: Golfer, dt: number, onStrike: (power: number, putter: boolean, at: THREE.Vector3) => void) {
    g.t += dt;
    switch (g.phase) {
      case "walk": {
        if (this.#walkStep(g, dt)) {
          this.#placeGolfer(g, g.walkTo.x, g.walkTo.z, g.aimYaw + Math.PI / 2);
          g.phase = "idle";
          g.t = 0;
        }
        break;
      }
      case "idle": {
        poseIdle(g.rig, g.t);
        g.dirty = true;
        if (g.t >= IDLE_DWELL) {
          g.phase = "address";
          g.t = 0;
        }
        break;
      }
      case "address": {
        // ease from standing address into the loaded backswing
        const k = Math.min(1, g.t / ADDRESS_TIME);
        const s = k * k * (3 - 2 * k);
        poseGolf(g.rig, -g.charge * s);
        g.dirty = true;
        if (g.t >= ADDRESS_TIME + 0.25) {
          g.phase = "swing";
          g.t = 0;
        }
        break;
      }
      case "swing": {
        // same cubic-eased downswing as the player; ball leaves at s ≥ 0
        const t = Math.min(1, g.t / SWING_TIME);
        const ease = 1 - Math.pow(1 - t, 3);
        const s = THREE.MathUtils.lerp(-g.charge, 1, ease);
        poseGolf(g.rig, s);
        g.dirty = true;
        if (!g.struck && s >= 0) this.#strike(g, onStrike);
        if (g.t >= SWING_TIME) {
          g.phase = "watch";
          g.t = 0;
        }
        break;
      }
      case "watch": {
        // hold the finish, then relax to idle while the ball runs out
        if (g.t < FINISH_HOLD) poseGolf(g.rig, 1);
        else poseIdle(g.rig, g.t);
        this.#headTrack(g, g.ball.pos);
        g.dirty = true;
        if (!g.ball.moving && g.t > FINISH_HOLD) this.#resolveShot(g);
        break;
      }
    }
  }

  /** Far mode: no anim — one whole stroke (or the tee migration) per tick. */
  stepFar(dt: number, onStrike: (power: number, putter: boolean, at: THREE.Vector3) => void) {
    this.farTimer += dt;
    if (this.farTimer < FAR_STEP_SECONDS) return;
    this.farTimer = Math.random() * 2; // jittered cadence
    if (this.phase === "advance") {
      this.#setupHole((this.holeIdx + 1) % this.#course.holes.length, true);
      return;
    }
    if (this.turn < 0) this.turn = this.#nextTurn();
    if (this.turn < 0) return;
    const g = this.golfers[this.turn];
    this.#planShot(g);
    this.#addressSpot(g, g.aimYaw, this.#tmp);
    this.#placeGolfer(g, this.#tmp.x, this.#tmp.z, g.aimYaw + Math.PI / 2);
    g.struck = false;
    this.#strike(g, onStrike);
    // resolve the whole flight synchronously (bounded; one shot per ~11 s)
    for (let i = 0; i < 700 && g.ball.moving; i++) g.ball.update(1 / 30);
    if (g.ball.moving) {
      // pathological roller — just stop it where it is
      g.ball.vel.set(0, 0, 0);
      g.ball.phase = "rest";
    }
    this.#resolveShot(g);
    this.#refresh();
  }

  /** Subtle "everyone watches the shot" head turn, clamped to the neck. */
  #headTrack(g: Golfer, at: THREE.Vector3) {
    const want = Math.atan2(at.x - g.pos.x, at.z - g.pos.z);
    // rig front (-Z) faces heading+π in atan2(x,z) terms
    let dyaw = want - (g.heading + Math.PI);
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw));
    g.rig.head.rotation.y = THREE.MathUtils.clamp(-dyaw, -1.1, 1.1);
  }

  #refresh() {
    for (const g of this.golfers) {
      if (!g.dirty) continue;
      g.dirty = false;
      const grp = g.rig.group;
      grp.matrixWorldAutoUpdate = true;
      grp.updateMatrixWorld(true);
      grp.matrixWorldAutoUpdate = false;
    }
  }
}

export class NpcGolfers {
  /** parented under GolfGame.root, so the site gate hides everything at once */
  readonly group = new THREE.Group();
  /** dev probe: increments once per live update() (asleep golf never ticks) */
  ticks = 0;

  #groups: GolferGroup[] = [];
  #audio: GolfAudio;
  #daylight: () => boolean;
  #dayShown = true; // current visibility state
  #dayFlip = 0; // seconds the opposite signal has held (debounce)
  #tmp = new THREE.Vector3();

  constructor(course: GolfCourse, map: WorldMap, physics: Physics, audio: GolfAudio, daylight: () => boolean, parent: THREE.Object3D) {
    this.#audio = audio;
    this.#daylight = daylight;
    this.group.name = "golf-npcs";
    parent.add(this.group);
    for (let i = 0; i < START_HOLES.length; i++) {
      this.#groups.push(new GolferGroup(course, map, physics, START_HOLES[i] % course.holes.length, `presidio-${i}`, this.group));
    }
    if (import.meta.env.DEV) Object.assign(window as object, { __golfNpc: this });
  }

  /** Dev/probe: swap the day/night signal live (main wires the real sky). */
  setDaylightProvider(fn: () => boolean) {
    this.#daylight = fn;
  }

  /** Dev/probe snapshot: where every group is and what everyone is doing. */
  debugState() {
    return {
      visible: this.group.visible,
      ticks: this.ticks,
      groups: this.#groups.map((g) => ({
        holeIdx: g.holeIdx,
        phase: g.phase,
        turn: g.turn,
        golfers: g.golfers.map((p) => ({
          phase: p.phase,
          x: Math.round(p.pos.x * 10) / 10,
          z: Math.round(p.pos.z * 10) / 10,
          heading: Math.round(p.heading * 100) / 100,
          strokes: p.strokes,
          done: p.done,
          ballMoving: p.ball.moving,
          ball: [Math.round(p.ball.pos.x * 10) / 10, Math.round(p.ball.pos.z * 10) / 10]
        }))
      }))
    };
  }

  /** E-join: hole index of a group with a golfer within `r` of (x,z), or -1. */
  joinableHole(x: number, z: number, r = 6): number {
    if (!this.#dayShown) return -1;
    for (const g of this.#groups) {
      if (g.nearGolfer(x, z, r)) return g.holeIdx;
    }
    return -1;
  }

  /** Called by GolfGame.update AFTER its site-awake early-return. */
  update(dt: number, elapsed: number, playerPos: THREE.Vector3) {
    this.ticks++;
    // ---- day/night with a debounce so scrubbing time can't strobe them
    const day = this.#daylight();
    if (day !== this.#dayShown) {
      this.#dayFlip += dt;
      if (this.#dayFlip >= DAY_DEBOUNCE) {
        this.#dayShown = day;
        this.#dayFlip = 0;
        this.group.visible = day;
        for (const g of this.#groups) g.setVisible(day);
      }
    } else this.#dayFlip = 0;
    if (!this.#dayShown) return; // packed up for the night

    const onStrike = (power: number, putter: boolean, at: THREE.Vector3) => {
      // non-spatial synth — only let nearby swings through, scaled down
      const d = this.#tmp.copy(at).sub(playerPos).length();
      if (d < AUDIO_RADIUS) this.#audio.thwack(power * (0.5 - (0.35 * d) / AUDIO_RADIUS), putter);
    };

    for (const g of this.#groups) {
      // group proximity = nearest golfer (groups sprawl mid-hole)
      let near = Infinity;
      for (const golfer of g.golfers) {
        const d = Math.hypot(golfer.pos.x - playerPos.x, golfer.pos.z - playerPos.z);
        if (d < near) near = d;
      }
      if (near < ANIM_RADIUS) g.updateNear(dt, elapsed, onStrike);
      else g.stepFar(dt, onStrike);
    }
  }
}

/** Buskers' size-based caster diet: only chunky parts shadow-cast. */
function applyShadowDiet(root: THREE.Object3D) {
  const size = new THREE.Vector3();
  const scale = new THREE.Vector3();
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    const geo = mesh.geometry;
    if (!geo.boundingBox) geo.computeBoundingBox();
    geo.boundingBox!.getSize(size);
    mesh.getWorldScale(scale);
    const volume = Math.abs(size.x * scale.x) * Math.abs(size.y * scale.y) * Math.abs(size.z * scale.z);
    if (volume < CASTER_MIN_VOLUME) mesh.castShadow = false;
  });
}
