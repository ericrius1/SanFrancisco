import * as THREE from "three/webgpu";
import { color, float, uv } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import type { Input } from "../../core/input";
import type { ChaseCamera } from "../../core/camera";
import type { Physics } from "../../core/physics";
import type { HUD } from "../../ui/hud";
import type { Player } from "../../player/player";
import type { WorldMap } from "../../world/heightmap";
import { CLUBS, GolfBall, lieFactor, type Club } from "./ball";
import { GolfCourse, type GolfSurface } from "./data";
import { GolfCourseView } from "./course";
import { GolfUI, standingLabel, totalLabel } from "./ui";

type N = any;

/**
 * The golf round: stumble on a glowing tee box on foot, press E, play real
 * holes. Hold LMB to draw the swing back (the radial meter ping-pongs),
 * release to rip it. Walk (or drive!) to wherever the ball rests, hit again,
 * hole out, next tee lights up. Everyone plays their own ball — remote
 * players' balls fly here from owner-simulated snapshots.
 */

const TEE_ZONE = 8; // "press E" radius around a tee spot
const SWING_ZONE = 4.2; // how close to the resting ball before you can swing
const CHARGE_TIME = 1.15; // seconds, 0 → full draw (then ping-pong back)
const SNAP_HZ = 8;

export type GolfNetMsg =
  | { k: "swing"; d: number[] }
  | { k: "b"; d: number[] }
  | { k: "rest"; d: number[] }
  | { k: "score"; h: number; p: number; s: number; r: number } // r = round delta ("t" is the wire's type key)
  | { k: "quit" };

type Ctx = {
  player: Player;
  input: Input;
  hud: HUD;
  chase: ChaseCamera;
  camera: THREE.PerspectiveCamera;
};

type RemoteBall = { mesh: THREE.Mesh; target: THREE.Vector3; moving: boolean };

type Phase = "toTee" | "toBall" | "aim" | "charge" | "flight";

export class GolfGame {
  active = false;
  /** outbound golf events — main.ts wires this to net.sendGolf */
  onNet: (msg: GolfNetMsg) => void = () => {};
  /** landing/holing thump hook (fx.impactPuff) */
  onImpact: (pos: THREE.Vector3) => void = () => {};

  #course: GolfCourse;
  #view: GolfCourseView;
  #ball: GolfBall;
  #ui = new GolfUI();
  #map: WorldMap;

  #holeIdx = 0;
  #strokes = 0; // strokes already taken this hole
  #totalDelta = 0;
  #holesDone = 0;
  #phase: Phase = "toTee";
  #clubIdx = 0;
  #charge = 0;
  #chargeDir = 1;
  #preShot = new THREE.Vector3();
  #pin = new THREE.Vector3();
  #teeSpot = new THREE.Vector3();

  #ballMesh: THREE.Mesh;
  #beacon: THREE.Mesh;
  #aimArrow: THREE.Mesh;
  #ballGeo: THREE.SphereGeometry;
  #ballMat: THREE.MeshStandardNodeMaterial;

  #teePromptShown = false;
  #snapAt = 0;
  #camEye = new THREE.Vector3();
  #wantCamYaw: number | null = null;
  #quitArmedAt = -Infinity;
  #remote = new Map<number, RemoteBall>();
  #tmp = new THREE.Vector3();
  #tmp2 = new THREE.Vector3();

  constructor(course: GolfCourse, map: WorldMap, physics: Physics, scene: THREE.Scene) {
    this.#course = course;
    this.#map = map;
    this.#view = new GolfCourseView(course, map, scene);
    this.#ball = new GolfBall(course, map, physics);
    this.#ball.onEvent = (e) => this.#onBallEvent(e);

    this.#ballGeo = new THREE.SphereGeometry(0.14, 14, 10);
    this.#ballMat = new THREE.MeshStandardNodeMaterial();
    this.#ballMat.colorNode = (color(0xffffff) as N).mul(LIGHT_SCALE * 0.95);
    this.#ballMat.roughnessNode = float(0.4);
    this.#ballMesh = new THREE.Mesh(this.#ballGeo, this.#ballMat);
    this.#ballMesh.visible = false;
    scene.add(this.#ballMesh);

    // resting-ball beacon: a soft light column so you can find your ball
    const beaconGeo = new THREE.CylinderGeometry(0.22, 0.3, 7, 10, 1, true);
    beaconGeo.translate(0, 3.5, 0);
    const beaconMat = new THREE.MeshBasicNodeMaterial();
    beaconMat.colorNode = (color(0x9ef2df) as N).mul(LIGHT_SCALE * 1.1);
    beaconMat.opacityNode = (uv().y as N).oneMinus().pow(2).mul(0.35);
    beaconMat.transparent = true;
    beaconMat.blending = THREE.AdditiveBlending;
    beaconMat.depthWrite = false;
    beaconMat.side = THREE.DoubleSide;
    this.#beacon = new THREE.Mesh(beaconGeo, beaconMat);
    this.#beacon.visible = false;
    scene.add(this.#beacon);

    // aim chevron: a slim strip pointing down the shot line while aiming
    const arrowGeo = new THREE.PlaneGeometry(0.14, 2.4);
    arrowGeo.rotateX(-Math.PI / 2);
    arrowGeo.translate(0, 0.06, -1.9);
    const arrowMat = new THREE.MeshBasicNodeMaterial();
    arrowMat.colorNode = (color(0x6fd7c4) as N).mul(LIGHT_SCALE * 1.3);
    arrowMat.opacityNode = (uv().y as N).mul(0.55);
    arrowMat.transparent = true;
    arrowMat.blending = THREE.AdditiveBlending;
    arrowMat.depthWrite = false;
    this.#aimArrow = new THREE.Mesh(arrowGeo, arrowMat);
    this.#aimArrow.visible = false;
    scene.add(this.#aimArrow);
  }

  /** main.ts E-chain, first in line: start a round when standing on a glowing
   *  tee (returns true = E consumed, don't hop rides/open doors). */
  tryStartAtTee(player: Player, hud: HUD): boolean {
    if (this.active || player.mode !== "walk") return false;
    const near = this.#course.nearestTee(player.renderPosition.x, player.renderPosition.z, TEE_ZONE);
    if (near < 0) return false;
    this.#startRound(near, hud);
    return true;
  }

  /** main.ts: digits pick clubs instead of vehicles while the swing UI is up. */
  get capturesDigits(): boolean {
    return this.active && (this.#phase === "aim" || this.#phase === "charge");
  }

  /** main.ts: the click-tools stand down while golf owns the mouse. */
  get capturesFire(): boolean {
    return this.capturesDigits || (this.active && this.#phase === "flight");
  }

  get club(): Club {
    return CLUBS[this.#clubIdx];
  }

  // ------------------------------------------------------------- round flow

  #startRound(holeIdx: number, hud: HUD) {
    this.active = true;
    this.#holeIdx = holeIdx;
    this.#totalDelta = 0;
    this.#holesDone = 0;
    this.#beginHole(hud, true);
    this.#ui.setVisible(true);
  }

  #beginHole(hud: HUD, teeNow: boolean) {
    const h = this.#course.holes[this.#holeIdx];
    this.#strokes = 0;
    this.#course.pin(this.#holeIdx, this.#pin);
    this.#course.teeSpot(this.#holeIdx, this.#teeSpot);
    this.#view.setActiveTee(this.#holeIdx);
    this.#ui.setHole(h.ref, h.par, h.len);
    this.#ui.setScore(0, this.#totalDelta, this.#holesDone);
    if (teeNow) this.#teeUp(hud);
    else {
      this.#phase = "toTee";
      this.#ballMesh.visible = false;
      this.#beacon.visible = false;
      hud.message(`Next — Hole ${h.ref} · Par ${h.par} · ${h.len}m. The tee's glowing!`, 3.4);
    }
  }

  #teeUp(hud: HUD) {
    const h = this.#course.holes[this.#holeIdx];
    this.#ball.place(this.#teeSpot.x, this.#teeSpot.y + 0.02, this.#teeSpot.z);
    this.#ballMesh.visible = true;
    this.#syncBallMesh();
    this.#phase = "toBall";
    // swing the camera to face down the hole line (view dir = -(sin,cos) of yaw)
    this.#wantCamYaw = this.#course.teeAim(this.#holeIdx) + Math.PI;
    this.#autoClub();
    hud.message(`Hole ${h.ref} · Par ${h.par} · ${h.len}m — walk to the ball, hold click to swing`, 3.2);
  }

  #endRound(hud: HUD, quiet = false) {
    this.active = false;
    this.#ballMesh.visible = false;
    this.#beacon.visible = false;
    this.#aimArrow.visible = false;
    this.#view.setActiveTee(-1);
    this.#ui.setVisible(false);
    if (!quiet) {
      const played = this.#holesDone;
      hud.message(
        played > 0 ? `Round over — ${played} hole${played > 1 ? "s" : ""}, ${totalLabel(this.#totalDelta)} total ⛳` : "Round abandoned",
        3.5
      );
    }
    this.onNet({ k: "quit" });
  }

  #autoClub() {
    const p = this.#ball.pos;
    const dist = Math.hypot(p.x - this.#pin.x, p.z - this.#pin.z);
    const lie = this.#course.surfaceAt(p.x, p.z).kind;
    let idx: number;
    if (lie === "green") idx = CLUBS.length - 1; // putter
    else if (lie === "bunker") idx = CLUBS.findIndex((c) => c.id === "sand");
    else if (dist < 30) idx = CLUBS.findIndex((c) => c.id === "wedge");
    else {
      idx = 0;
      for (let i = CLUBS.length - 2; i >= 0; i--) {
        if (CLUBS[i].carry >= dist * 1.02) idx = i;
      }
      if (CLUBS[idx].carry < dist) idx = 0;
    }
    this.#clubIdx = Math.max(0, idx);
    this.#ui.setClubs(CLUBS, this.#clubIdx);
  }

  // ------------------------------------------------------------- ball events

  #onBallEvent(e: { kind: string; surface?: GolfSurface; x?: number; z?: number }) {
    // events fire from inside ball.update — stash outcomes; messaging happens
    // in update where hud/ctx are in reach
    this.#pendingEvent = e;
  }
  #pendingEvent: { kind: string; surface?: GolfSurface; x?: number; z?: number } | null = null;

  #settleShot(hud: HUD) {
    const e = this.#pendingEvent;
    if (!e) return;
    this.#pendingEvent = null;
    if (e.kind === "land") {
      this.onImpact(this.#ball.pos);
      return;
    }

    if (e.kind === "water") {
      this.#strokes += 1; // penalty
      this.#ball.place(this.#preShot.x, this.#preShot.y, this.#preShot.z);
      this.#syncBallMesh();
      this.onNet({ k: "rest", d: [this.#preShot.x, this.#preShot.y, this.#preShot.z] });
      hud.message(`Splash! One-stroke penalty — playing ${this.#strokes + 1} from the drop`, 3);
      this.#phase = "toBall";
      this.#ui.setScore(this.#strokes, this.#totalDelta, this.#holesDone);
      this.#autoClub();
      return;
    }

    if (e.kind === "holed") {
      const h = this.#course.holes[this.#holeIdx];
      const label = standingLabel(this.#strokes, h.par);
      this.onImpact(this.#ball.pos);
      this.onNet({ k: "score", h: h.ref, p: h.par, s: this.#strokes, r: this.#totalDelta + (this.#strokes - h.par) });
      hud.message(`${label} — holed in ${this.#strokes} on the par ${h.par} 🏌️`, 3.6);
      this.#totalDelta += this.#strokes - h.par;
      this.#holesDone += 1;
      this.#holeIdx = (this.#holeIdx + 1) % this.#course.holes.length;
      this.#beginHole(hud, false);
      return;
    }

    if (e.kind === "rest") {
      const p = this.#ball.pos;
      const dist = Math.hypot(p.x - this.#pin.x, p.z - this.#pin.z);
      const surf = e.surface ?? "rough";
      const where =
        surf === "green"
          ? "on the green"
          : surf === "fairway"
            ? "fairway"
            : surf === "bunker"
              ? "in the bunker!"
              : surf === "tee"
                ? "on a tee box"
                : surf === "path"
                  ? "on the cart path"
                  : "in the rough";
      this.onNet({ k: "rest", d: [p.x, p.y, p.z] });
      hud.message(`${Math.round(dist)}m to the pin — ${where}`, 2.6);
      this.#phase = "toBall";
      this.#autoClub();
    }
  }

  // ------------------------------------------------------------- per frame

  update(dt: number, elapsed: number, ctx: Ctx) {
    this.#view.update(dt, elapsed);
    this.#updateRemotes(dt);

    const { player, input, hud, chase } = ctx;
    const onFoot = player.mode === "walk";
    const px = player.renderPosition.x;
    const pz = player.renderPosition.z;

    // ---- not playing: nudge at any glowing tee (E itself is handled by
    // main.ts's E-chain via tryStartAtTee, so golf wins over "hop on a ride")
    if (!this.active) {
      if (onFoot) {
        const near = this.#course.nearestTee(px, pz, TEE_ZONE);
        if (near >= 0) {
          const h = this.#course.holes[near];
          if (!this.#teePromptShown) {
            hud.message(`E — play golf · Hole ${h.ref} · Par ${h.par} · ${h.len}m`, 2.4);
            this.#teePromptShown = true;
          }
        } else this.#teePromptShown = false;
      } else this.#teePromptShown = false;
      return;
    }

    // ---- playing
    this.#settleShot(hud);

    // G ends the round (two presses so a stray G never dumps a good card)
    if (input.pressed("KeyG")) {
      if (performance.now() - this.#quitArmedAt < 2600) this.#endRound(hud);
      else {
        this.#quitArmedAt = performance.now();
        hud.message("Press G again to end the round", 2.2);
      }
    }
    if (!this.active) return;

    if (this.#phase === "toTee") {
      // heading to the next tee — auto tee-up on arrival
      if (onFoot && Math.hypot(px - this.#teeSpot.x, pz - this.#teeSpot.z) < TEE_ZONE) this.#teeUp(hud);
      return;
    }

    if (this.#phase === "flight") {
      this.#ball.update(dt);
      this.#syncBallMesh();
      this.#streamSnaps();
      // rest/holed/water events flip the phase via #settleShot next frame
      return;
    }

    // ---- toBall / aim / charge
    if (this.#wantCamYaw !== null) {
      chase.yaw = this.#wantCamYaw;
      this.#wantCamYaw = null;
    }
    const ballP = this.#ball.pos;
    const near = onFoot && Math.hypot(px - ballP.x, pz - ballP.z) < SWING_ZONE;
    this.#beacon.visible = !near;
    this.#beacon.position.set(ballP.x, ballP.y, ballP.z);

    if (!near) {
      if (this.#phase !== "toBall") {
        this.#phase = "toBall";
        this.#ui.showSwing(false);
        this.#aimArrow.visible = false;
      }
      return;
    }

    if (this.#phase === "toBall") {
      this.#phase = "aim";
      this.#ui.showSwing(true);
      this.#ui.setClubs(CLUBS, this.#clubIdx);
      this.#ui.setCharge(0, 0, false);
    }

    // club picking: number keys (main.ts skips its own digit handling for us)
    for (let i = 1; i <= CLUBS.length; i++) {
      if (input.pressed(`Digit${i}`) || input.pressed(`Numpad${i}`)) {
        this.#clubIdx = i - 1;
        this.#ui.setClubs(CLUBS, this.#clubIdx);
      }
    }

    // aim line follows the camera. chase.yaw is the boom side — the view
    // direction is -(sin,cos)(yaw), i.e. heading yaw+π in ball.strike's terms
    const aimYaw = chase.yaw + Math.PI;
    this.#aimArrow.visible = true;
    this.#aimArrow.position.set(ballP.x, ballP.y + 0.02, ballP.z);
    this.#aimArrow.rotation.set(0, chase.yaw, 0);

    const lie = this.#course.surfaceAt(ballP.x, ballP.z).kind;

    if (this.#phase === "aim") {
      if (input.firing && !input.freeCursor) {
        this.#phase = "charge";
        this.#charge = 0;
        this.#chargeDir = 1;
      }
    }

    if (this.#phase === "charge") {
      if (input.firing) {
        this.#charge += (dt / CHARGE_TIME) * this.#chargeDir;
        if (this.#charge >= 1) {
          this.#charge = 1;
          this.#chargeDir = -1;
        } else if (this.#charge <= 0 && this.#chargeDir < 0) {
          this.#charge = 0;
          this.#chargeDir = 1;
        }
      } else {
        // release — swing!
        this.#swing(aimYaw, Math.max(this.#charge, 0.06), lie);
        return;
      }
    }

    const est = this.club.id === "putter" ? this.#charge * 30 : this.club.carry * this.#charge * lieFactor(lie, this.club);
    this.#ui.setCharge(this.#charge, est, this.#phase === "charge");
  }

  #swing(aimYaw: number, power: number, lie: GolfSurface) {
    this.#strokes += 1;
    this.#preShot.copy(this.#ball.pos);
    this.#ball.strike(this.club, aimYaw, power, lie, this.#pin);
    this.#phase = "flight";
    this.#camEye.copy(this.#ball.pos).addScaledVector(this.#tmp.set(Math.sin(aimYaw), 0, Math.cos(aimYaw)), -3.5);
    this.#camEye.y = this.#ball.pos.y + 2.2;
    this.#ui.setScore(this.#strokes, this.#totalDelta, this.#holesDone);
    this.#ui.showSwing(false);
    this.#aimArrow.visible = false;
    const v = this.#ball.vel;
    this.onNet({ k: "swing", d: [this.#ball.pos.x, this.#ball.pos.y, this.#ball.pos.z, v.x, v.y, v.z] });
  }

  /** Flight camera: true = golf owns the camera this frame (main skips chase). */
  updateBallCam(dt: number, camera: THREE.PerspectiveCamera): boolean {
    if (!this.active || this.#phase !== "flight") return false;
    const b = this.#ball.pos;
    // chase eye: hang back along the ball's ground track, ease everything
    const d = this.#tmp.copy(b).sub(this.#camEye);
    d.y = 0;
    const dist = d.length();
    if (dist > 26) this.#camEye.addScaledVector(d.normalize(), (dist - 26) * Math.min(1, dt * 2.2));
    const eyeGround = this.#map.effectiveGround(this.#camEye.x, this.#camEye.z);
    const wantY = Math.max(b.y + 3.2, eyeGround + 2.4);
    this.#camEye.y += (wantY - this.#camEye.y) * Math.min(1, dt * 3);
    camera.position.lerp(this.#camEye, Math.min(1, dt * 5));
    this.#tmp2.copy(b).addScaledVector(this.#ball.vel, 0.12);
    camera.lookAt(this.#tmp2);
    return true;
  }

  #syncBallMesh() {
    this.#ballMesh.position.copy(this.#ball.pos);
  }

  #streamSnaps() {
    const now = performance.now();
    if (now < this.#snapAt) return;
    this.#snapAt = now + 1000 / SNAP_HZ;
    const p = this.#ball.pos;
    this.onNet({ k: "b", d: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100, Math.round(p.z * 100) / 100] });
  }

  // ------------------------------------------------------------- remotes

  #remoteBall(id: number): RemoteBall {
    let r = this.#remote.get(id);
    if (!r) {
      const mesh = new THREE.Mesh(this.#ballGeo, this.#ballMat);
      this.#ballMesh.parent!.add(mesh);
      r = { mesh, target: new THREE.Vector3(), moving: false };
      this.#remote.set(id, r);
    }
    return r;
  }

  remoteSwing(id: number, d: number[]) {
    const r = this.#remoteBall(id);
    r.mesh.visible = true;
    r.mesh.position.set(d[0], d[1], d[2]);
    r.target.copy(r.mesh.position);
    r.moving = true;
  }

  remoteSnap(id: number, d: number[]) {
    const r = this.#remoteBall(id);
    r.mesh.visible = true;
    r.target.set(d[0], d[1], d[2]);
    r.moving = true;
  }

  remoteRest(id: number, d: number[]) {
    const r = this.#remoteBall(id);
    r.mesh.visible = true;
    r.target.set(d[0], d[1], d[2]);
    r.moving = false;
  }

  remoteScore(name: string, h: number, p: number, s: number, hud: HUD) {
    hud.message(`${name}: ${standingLabel(s, p)} on hole ${h} ⛳`, 3);
  }

  /** One inbound relayed golf message from player `id` (already not-self). */
  handleNet(id: number, msg: Record<string, unknown>, hud: HUD, name: string) {
    const d = Array.isArray(msg.d) ? (msg.d as number[]) : [];
    switch (msg.k) {
      case "swing":
        if (d.length === 6) this.remoteSwing(id, d);
        break;
      case "b":
        if (d.length === 3) this.remoteSnap(id, d);
        break;
      case "rest":
        if (d.length === 3) this.remoteRest(id, d);
        break;
      case "score":
        if (typeof msg.h === "number" && typeof msg.p === "number" && typeof msg.s === "number")
          this.remoteScore(name, msg.h, msg.p, msg.s, hud);
        break;
      case "quit":
        this.removeRemote(id);
        break;
    }
  }

  removeRemote(id: number) {
    const r = this.#remote.get(id);
    if (r) {
      r.mesh.removeFromParent();
      this.#remote.delete(id);
    }
  }

  #updateRemotes(dt: number) {
    for (const r of this.#remote.values()) {
      const k = r.moving ? Math.min(1, dt * 10) : Math.min(1, dt * 20);
      r.mesh.position.lerp(r.target, k);
    }
  }
}
