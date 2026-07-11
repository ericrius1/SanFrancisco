import * as THREE from "three/webgpu";
import { color, float, uv } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import type { Input } from "../../core/input";
import type { ChaseCamera } from "../../core/camera";
import type { Physics } from "../../core/physics";
import type { HUD } from "../../ui/hud";
import type { Player } from "../../player/player";
import type { WorldMap } from "../../world/heightmap";
import { BALL_RADIUS, CLUBS, GolfBall, estimatedCarry, suggestedClubIndex, type Club } from "./ball";
import { GolfCourse, type GolfSurface } from "./data";
import { GolfCourseView } from "./course";
import { GolfAudio } from "./audio";
import { GolfGuide } from "./guide";
import { buildGolfCartMesh, setCartBags, GOLF_CART_SPEC } from "./cart";
import { GolfUI, standingLabel, totalLabel, type GolfHoleScore, type GolfPeerScore } from "./ui";

type N = any;

/**
 * The golf round: stumble on a glowing tee box on foot, press E, play real
 * holes. Hold LMB to draw the swing back (the radial meter fills),
 * release to rip it. Walk (or drive!) to wherever the ball rests, hit again,
 * hole out, next tee lights up. Everyone plays their own ball — remote
 * players' balls fly here from owner-simulated snapshots.
 */

const TEE_ZONE = 8; // "press E" radius around a tee spot
const SWING_ZONE = 2.6; // how close to the resting ball before you can swing (stance eases the rest)
const CHARGE_TIME = 1.15; // seconds, 0 → full draw (then holds at full power)
const SWING_TIME = 0.46; // downswing seconds (release → full follow-through)
const SNAP_HZ = 8;
// Once a roller is this slow, less than ~0.45 m remains on a flat green.
// Hand the camera back early so the golfer is framed before the next walk.
const BALL_CAM_RETURN_SPEED = 0.7;
const BALL_CAM_MIN_FOLLOW_TIME = 0.45; // keep even a soft tap-in on camera briefly

export type GolfNetMsg =
  | { k: "swing"; d: number[] }
  | { k: "b"; d: number[] }
  | { k: "rest"; d: number[] }
  | { k: "score"; h: number; p: number; s: number; r: number } // r = round delta ("t" is the wire's type key)
  | { k: "state"; d: number[]; h: number; p: number; s: number; r: number }
  | { k: "quit" };

type Ctx = {
  player: Player;
  input: Input;
  hud: HUD;
  chase: ChaseCamera;
  camera: THREE.PerspectiveCamera;
};

type RemoteBall = { mesh: THREE.Mesh; target: THREE.Vector3; moving: boolean };

type Phase = "toTee" | "toBall" | "aim" | "charge" | "swing" | "flight";

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
  #guide: GolfGuide;
  #map: WorldMap;
  #scene: THREE.Scene;

  // golf cart: a parked cart waits at the first tee; press E beside it to hop
  // in and drive it (reusing the car controller via setDriveStyle). Bags on the
  // rear deck track occupancy — driver's bag always, passenger's when someone
  // rides shotgun (main.ts can bump the count via setCartOccupants).
  #parkedCart: THREE.Group | null = null;
  #driveCart: THREE.Group | null = null;
  #cartBoarded = false;
  #cartOccupants = 1;
  #lastTrackX = NaN; // last frame's player XZ — a big jump = a teleport
  #lastTrackZ = NaN;

  #holeIdx = 0;
  #strokes = 0; // strokes already taken this hole
  #totalDelta = 0;
  #holesDone = 0;
  #holeScores: GolfHoleScore[] = [];
  #phase: Phase = "toTee";
  #clubIdx = 0;
  #charge = 0;
  #swingAnim = -1;
  #swingFrom = -1;
  #pendingStrike: { yaw: number; power: number; lie: GolfSurface } | null = null;
  #audio = new GolfAudio();
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
  #ballCamActive = false;
  #ballCamAge = 0;
  #wantCamYaw: number | null = null;
  #quitArmedAt = -Infinity;
  #summaryUntil = 0;
  #roundComplete = false;
  #remote = new Map<number, RemoteBall>();
  #remoteScores = new Map<number, GolfPeerScore>();
  #tmp = new THREE.Vector3();
  #tmp2 = new THREE.Vector3();

  constructor(course: GolfCourse, map: WorldMap, physics: Physics, scene: THREE.Scene) {
    this.#course = course;
    this.#map = map;
    this.#scene = scene;
    this.#view = new GolfCourseView(course, map, scene);
    this.#guide = new GolfGuide(scene);
    this.#ball = new GolfBall(course, map, physics);
    this.#ball.onEvent = (e) => this.#onBallEvent(e);
    this.#spawnParkedCart();

    if (import.meta.env.DEV) {
      Object.assign(window as object, {
        __golfGame: this,
        __golfBall: this.#ball,
        __spawnGolfCart: (x: number, z: number, occupants = 2) => {
          const m = buildGolfCartMesh();
          m.position.set(x, map.effectiveGround(x, z) + 0.55, z);
          setCartBags(m, occupants);
          scene.add(m);
          return m;
        }
      });
    }

    this.#ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 14, 10);
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
   *  tee, or hop into the parked golf cart if you're beside it (returns true =
   *  E consumed, don't hop other rides / open doors). */
  tryStartAtTee(player: Player, hud: HUD): boolean {
    if (player.mode !== "walk") return false;
    if (!this.active) {
      const near = this.#course.nearestTee(player.renderPosition.x, player.renderPosition.z, TEE_ZONE);
      if (near >= 0) {
        this.#startRound(near, hud);
        return true;
      }
    }
    // beside the cart? climb in and drive (works mid-round too — go find your ball)
    return this.#tryBoardCart(player, hud);
  }

  // ------------------------------------------------------------- golf cart

  #spawnParkedCart() {
    const first = this.#course.holes.find((h) => h.ref === 1) ?? this.#course.holes[0];
    if (!first) return;
    // park it a few metres off the first tee, nose pointing down the hole
    const [tx, tz] = first.teeXZ;
    const aim = this.#course.teeAim(0);
    const x = tx + Math.cos(aim) * 5 + 3;
    const z = tz - Math.sin(aim) * 5 + 3;
    const cart = buildGolfCartMesh();
    cart.position.set(x, this.#map.effectiveGround(x, z) + 0.55, z);
    cart.rotation.y = aim + Math.PI;
    setCartBags(cart, 0);
    this.#scene.add(cart);
    this.#parkedCart = cart;
  }

  /** Where the parked golf cart waits (world pos), or null once it's driven off. */
  get parkedCartPosition(): THREE.Vector3 | null {
    return this.#parkedCart && this.#parkedCart.visible ? this.#parkedCart.position : null;
  }

  /** Number of people aboard the cart (1 driver, 2 with a passenger). main.ts's
   *  passenger wiring can call this so the second golf bag appears on the deck. */
  setCartOccupants(n: number) {
    this.#cartOccupants = Math.max(1, Math.min(2, n));
    if (this.#driveCart) setCartBags(this.#driveCart, this.#cartOccupants);
  }

  #tryBoardCart(player: Player, hud: HUD): boolean {
    if (!this.#parkedCart || this.#cartBoarded || this.#parkedCart.visible === false) return false;
    const p = player.renderPosition;
    const cp = this.#parkedCart.position;
    if (Math.hypot(p.x - cp.x, p.z - cp.z) > 3.6) return false;
    // swap the player's drive embodiment to the cart + its lighter, tippier spec
    this.#driveCart = buildGolfCartMesh();
    this.#cartOccupants = 1;
    setCartBags(this.#driveCart, this.#cartOccupants);
    player.setDriveStyle(this.#driveCart, GOLF_CART_SPEC);
    player.position.set(cp.x, player.position.y, cp.z);
    player.heading = this.#parkedCart.rotation.y + Math.PI;
    player.trySwitch("drive");
    this.#parkedCart.visible = false; // it's now the thing you're driving
    this.#cartBoarded = true;
    hud.message("Electric golf cart — drive to your ball, E to hop off ⛳", 3);
    return true;
  }

  /** Watch for the driver hopping out (E → walk) and leave the cart parked
   *  where they got off; keep the deck bags synced to occupancy while aboard. */
  #updateCart(player: Player) {
    if (!this.#cartBoarded) return;
    if (player.mode !== "drive") {
      // exited (or switched modes): main.ts restored the default drive mesh, so
      // re-show the parked cart here for the next hop-in
      this.#cartBoarded = false;
      this.#driveCart = null;
      if (this.#parkedCart) {
        const p = player.renderPosition;
        this.#parkedCart.position.set(p.x, this.#map.effectiveGround(p.x, p.z) + 0.55, p.z);
        this.#parkedCart.rotation.y = player.heading;
        setCartBags(this.#parkedCart, 0);
        this.#parkedCart.visible = true;
      }
      return;
    }
    if (this.#driveCart) setCartBags(this.#driveCart, this.#cartOccupants);
  }

  /** main.ts: digits pick clubs instead of vehicles while the swing UI is up. */
  get capturesDigits(): boolean {
    return this.active && (this.#phase === "aim" || this.#phase === "charge");
  }

  /** main.ts: the click-tools stand down while golf owns the mouse. */
  get capturesFire(): boolean {
    return this.capturesDigits || (this.active && (this.#phase === "swing" || this.#phase === "flight"));
  }

  get club(): Club {
    return CLUBS[this.#clubIdx];
  }

  // ------------------------------------------------------------- round flow

  #startRound(holeIdx: number, hud: HUD) {
    this.active = true;
    this.#roundComplete = false;
    this.#lastTrackX = NaN; // don't read a start-frame teleport as "leaving"
    this.#summaryUntil = 0;
    this.#holeIdx = holeIdx;
    this.#totalDelta = 0;
    this.#holesDone = 0;
    this.#holeScores.length = 0;
    this.#charge = 0;
    this.#teePromptShown = false;
    this.#beginHole(hud, true);
    this.#ui.setVisible(true);
  }

  #beginHole(hud: HUD, teeNow: boolean) {
    const h = this.#course.holes[this.#holeIdx];
    this.#strokes = 0;
    this.#course.pin(this.#holeIdx, this.#pin);
    this.#course.teeSpot(this.#holeIdx, this.#teeSpot);
    this.#view.setActiveTee(this.#holeIdx);
    this.#ui.setHole(h.ref, h.par, h.len, h.yardages?.black);
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
    this.#ball.place(this.#teeSpot.x, this.#teeSpot.y + BALL_RADIUS, this.#teeSpot.z);
    this.#ballMesh.visible = true;
    this.#syncBallMesh();
    this.#phase = "toBall";
    this.#charge = 0;
    // swing the camera to face down the hole line (view dir = -(sin,cos) of yaw)
    this.#wantCamYaw = this.#course.teeAim(this.#holeIdx) + Math.PI;
    this.#autoClub();
    this.#publishState(true, false);
    hud.message(`Hole ${h.ref} · Par ${h.par} · ${h.len}m — walk to the ball, hold click to swing`, 3.2);
  }

  #endRound(hud: HUD, quiet = false) {
    this.active = false;
    this.#roundComplete = false;
    this.#pendingStrike = null; // a quit mid-downswing must not still launch the ball
    this.#ballMesh.visible = false;
    this.#beacon.visible = false;
    this.#aimArrow.visible = false;
    this.#guide.hideNow(); // never let the pointer linger after you leave
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

  #finishRound(hud: HUD) {
    this.active = false;
    this.#roundComplete = true;
    this.#summaryUntil = performance.now() + 9000;
    this.#ballMesh.visible = false;
    this.#beacon.visible = false;
    this.#aimArrow.visible = false;
    this.#view.setActiveTee(-1);
    this.#ui.setComplete(this.#totalDelta, this.#holeScores);
    hud.message(`Round complete — ${totalLabel(this.#totalDelta)} through 18 ⛳`, 6);
  }

  /** Canonical late-join/reconnect snapshot. Event packets still make swings
   *  immediate; this state packet owns ball visibility plus the shared card. */
  #publishState(visible: boolean, moving: boolean) {
    const h = this.#course.holes[this.#holeIdx];
    const p = this.#ball.pos;
    this.onNet({
      k: "state",
      d: [
        Math.round(p.x * 100) / 100,
        Math.round(p.y * 100) / 100,
        Math.round(p.z * 100) / 100,
        visible ? 1 : 0,
        moving ? 1 : 0
      ],
      h: h.ref,
      p: h.par,
      s: this.#strokes,
      r: this.#totalDelta
    });
  }

  /** Re-assert local golf state after a socket reconnect. */
  syncNetState() {
    if (this.active) this.#publishState(this.#ballMesh.visible, this.#ball.moving);
    else if (this.#roundComplete) this.#publishState(false, false);
  }

  #autoClub() {
    const p = this.#ball.pos;
    const dist = Math.hypot(p.x - this.#pin.x, p.z - this.#pin.z);
    const lie = this.#course.surfaceAt(p.x, p.z).kind;
    this.#clubIdx = suggestedClubIndex(dist, lie);
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
      this.#audio.landThud(this.#ball.vel.length() * 2);
      return;
    }

    if (e.kind === "water") {
      this.#strokes += 1; // penalty
      this.#ball.place(this.#preShot.x, this.#preShot.y, this.#preShot.z);
      this.#syncBallMesh();
      this.onNet({ k: "rest", d: [this.#preShot.x, this.#preShot.y, this.#preShot.z] });
      this.#publishState(true, false);
      hud.message(`Splash! One-stroke penalty — playing ${this.#strokes + 1} from the drop`, 3);
      this.#phase = "toBall";
      this.#ui.setScore(this.#strokes, this.#totalDelta, this.#holesDone);
      this.#autoClub();
      return;
    }

    if (e.kind === "holed") {
      const h = this.#course.holes[this.#holeIdx];
      const label = standingLabel(this.#strokes, h.par);
      const nextTotal = this.#totalDelta + (this.#strokes - h.par);
      this.onImpact(this.#ball.pos);
      this.#audio.holed();
      this.onNet({ k: "score", h: h.ref, p: h.par, s: this.#strokes, r: nextTotal });
      hud.message(`${label} — holed in ${this.#strokes} on the par ${h.par} 🏌️`, 3.6);
      this.#totalDelta = nextTotal;
      this.#holesDone += 1;
      this.#holeScores.push({ hole: h.ref, par: h.par, strokes: this.#strokes });
      this.#publishState(false, false);
      if (this.#holesDone >= this.#course.holes.length) {
        this.#finishRound(hud);
        return;
      }
      this.#holeIdx = (this.#holeIdx + 1) % this.#course.holes.length;
      this.#beginHole(hud, false);
      return;
    }

    if (e.kind === "rest") {
      const p = this.#ball.pos;
      const dist = Math.hypot(p.x - this.#pin.x, p.z - this.#pin.z);
      const surf = e.surface ?? "rough";
      if (surf === "out") {
        this.#strokes += 1; // stroke-and-distance penalty
        this.#ball.place(this.#preShot.x, this.#preShot.y, this.#preShot.z);
        this.#syncBallMesh();
        this.onNet({ k: "rest", d: [this.#preShot.x, this.#preShot.y, this.#preShot.z] });
        this.#publishState(true, false);
        hud.message(`Out of bounds — one-stroke penalty, playing ${this.#strokes + 1} from the previous lie`, 3.2);
        this.#phase = "toBall";
        this.#ui.setScore(this.#strokes, this.#totalDelta, this.#holesDone);
        this.#autoClub();
        return;
      }
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
      this.#publishState(true, false);
      hud.message(`${Math.round(dist)}m to the pin — ${where}`, 2.6);
      this.#phase = "toBall";
      this.#autoClub();
    }
  }

  /** Point the floating chevron at whatever the golfer should head for next. */
  #updateGuide(dt: number, elapsed: number, player: Player) {
    let target: THREE.Vector3 | null = null;
    let hideWithin = 6;
    if (this.active) {
      if (this.#phase === "toTee") {
        target = this.#teeSpot;
        hideWithin = TEE_ZONE;
      } else if (this.#phase === "toBall") {
        target = this.#ball.pos;
        hideWithin = SWING_ZONE + 1;
      } else if (this.#phase === "aim" || this.#phase === "charge") {
        target = this.#pin; // once you're over the ball, it aims at the hole
        hideWithin = 4;
      }
      // swing / flight: no pointer (the shot has the stage)
    }
    // only ever show it on foot, while a round is live, and inside the course
    const p = player.renderPosition;
    const show = target !== null && player.mode === "walk" && this.#course.contains(p.x, p.z, 30);
    this.#guide.update(dt, p, target, show, elapsed, hideWithin);
  }

  // ------------------------------------------------------------- per frame

  update(dt: number, elapsed: number, ctx: Ctx) {
    this.#view.update(dt, elapsed);
    this.#updateRemotes(dt);

    const { player, input, hud, chase } = ctx;
    if (this.#swingAnim >= 0) {
      this.#swingAnim += dt;
      const t = Math.min(1, this.#swingAnim / SWING_TIME);
      const ease = 1 - Math.pow(1 - t, 3);
      const s = THREE.MathUtils.lerp(this.#swingFrom, 1, ease);
      player.setGolfPose(true, s);
      // the ball leaves when the CLUB arrives, not on mouse-up: contact fires
      // as the eased pose sweeps through s=0 (address/impact)
      if (this.#pendingStrike && s >= 0) this.#strikeNow();
      if (this.#swingAnim >= SWING_TIME + 0.32) {
        this.#swingAnim = -1;
        player.setGolfPose(false);
      }
    } else {
      player.setGolfPose(false);
    }
    const onFoot = player.mode === "walk";
    const px = player.renderPosition.x;
    const pz = player.renderPosition.z;

    // Teleporting (a big single-frame jump) or leaving the course footprint
    // auto-ends the round, so the guide/beacon never follow you across the city.
    if (this.active) {
      const jumped = Number.isFinite(this.#lastTrackX) && Math.hypot(px - this.#lastTrackX, pz - this.#lastTrackZ) > 35;
      if (jumped || !this.#course.contains(px, pz, 120)) this.#endRound(hud);
    }
    this.#lastTrackX = px;
    this.#lastTrackZ = pz;

    this.#updateCart(player);

    // floating "next objective" pointer: aims at the tee on the way up, the
    // resting ball after a shot, the pin while you settle over it
    this.#updateGuide(dt, elapsed, player);

    // ---- not playing: nudge at any glowing tee (E itself is handled by
    // main.ts's E-chain via tryStartAtTee, so golf wins over "hop on a ride")
    if (!this.active) {
      if (this.#summaryUntil > 0 && performance.now() >= this.#summaryUntil) {
        this.#summaryUntil = 0;
        this.#ui.setVisible(false);
      }
      if (onFoot) {
        const near = this.#course.nearestTee(px, pz, TEE_ZONE);
        if (near >= 0) {
          const h = this.#course.holes[near];
          if (!this.#teePromptShown) {
            hud.message(`Press E to start · Hole ${h.ref} · Par ${h.par} · ${h.len}m`, 2.4);
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

    if (this.#phase === "swing") {
      // club is on its way down — stance stays planted; the swingAnim block
      // above drives the pose and fires #strikeNow at impact
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
        this.#charge = 0;
        this.#ui.showSwing(false);
        this.#aimArrow.visible = false;
      }
      return;
    }

    if (this.#phase === "toBall") {
      this.#phase = "aim";
      this.#charge = 0;
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
    // stand side-on like a real golfer: target line to the lead side. The rig
    // root (not the capsule) eases to the address spot beside the ball —
    // 0.6m back across the line, a touch toward the trail foot.
    player.heading = aimYaw - Math.PI / 2;
    this.#tmp2.set(
      ballP.x + Math.cos(aimYaw) * 0.6 - Math.sin(aimYaw) * 0.12,
      ballP.y,
      ballP.z - Math.sin(aimYaw) * 0.6 - Math.cos(aimYaw) * 0.12
    );
    player.setGolfAddress(this.#tmp2);
    this.#aimArrow.visible = true;
    this.#aimArrow.position.set(ballP.x, ballP.y + 0.02, ballP.z);
    this.#aimArrow.rotation.set(0, chase.yaw, 0);

    const lie = this.#course.surfaceAt(ballP.x, ballP.z).kind;

    if (this.#phase === "aim") {
      if (input.firing && !input.freeCursor) {
        this.#phase = "charge";
        this.#charge = 0;
      }
    }

    if (this.#phase === "charge") {
      if (input.firing) {
        // Monotonic charge: holding longer can only add force; full draw holds.
        this.#charge = Math.min(1, this.#charge + dt / CHARGE_TIME);
      } else {
        // Losing focus/pointer lock cancels instead of firing an accidental shot.
        const cancelled = input.device === "kb" && (!input.locked || !document.hasFocus());
        if (cancelled) {
          this.#phase = "aim";
          this.#charge = 0;
        } else {
          // release — swing!
          this.#beginSwing(aimYaw, Math.max(this.#charge, 0.06), lie);
          return;
        }
      }
    }

    const est = estimatedCarry(this.club, this.#charge, lie);
    this.#ui.setCharge(this.#charge, est, this.#phase === "charge");
    if (this.#swingAnim < 0) player.setGolfPose(true, -this.#charge);
  }

  /** Mouse released: start the downswing. The strike itself lands ~0.1s later
   *  when the animated club sweeps through the ball (#strikeNow). */
  #beginSwing(aimYaw: number, power: number, lie: GolfSurface) {
    this.#phase = "swing";
    this.#pendingStrike = { yaw: aimYaw, power, lie };
    this.#swingFrom = -power;
    this.#swingAnim = 0;
    // cubic-eased downswing crosses s=0 here — aim the whoosh's peak at it
    const impactIn = SWING_TIME * (1 - Math.cbrt(1 / (1 + power)));
    this.#audio.whoosh(power, impactIn);
    this.#ui.showSwing(false);
    this.#aimArrow.visible = false;
  }

  #strikeNow() {
    const hit = this.#pendingStrike;
    if (!hit) return;
    this.#pendingStrike = null;
    this.#strokes += 1;
    this.#preShot.copy(this.#ball.pos);
    this.#ball.strike(this.club, hit.yaw, hit.power, hit.lie, this.#pin);
    this.#audio.thwack(hit.power, this.club.id === "putter");
    this.#phase = "flight";
    this.#ballCamActive = true;
    this.#ballCamAge = 0;
    this.#camEye.copy(this.#ball.pos).addScaledVector(this.#tmp.set(Math.sin(hit.yaw), 0, Math.cos(hit.yaw)), -3.5);
    this.#camEye.y = this.#ball.pos.y + 2.2;
    this.#ui.setScore(this.#strokes, this.#totalDelta, this.#holesDone);
    const v = this.#ball.vel;
    this.onNet({ k: "swing", d: [this.#ball.pos.x, this.#ball.pos.y, this.#ball.pos.z, v.x, v.y, v.z] });
    this.#publishState(true, true);
  }

  /** Flight camera: true = golf owns the camera this frame (main skips chase). */
  updateBallCam(dt: number, camera: THREE.PerspectiveCamera): boolean {
    if (!this.active || this.#phase !== "flight" || !this.#ballCamActive) return false;
    this.#ballCamAge += Math.min(dt, 0.1);

    // The ball can creep indefinitely on a slope, so camera ownership cannot
    // wait for the simulation's exact rest event. Release once a ground roll is
    // nearly spent, and latch the release for this shot so a downhill nudge
    // cannot yank the view away from the player again.
    const nearlyStopped =
      this.#ballCamAge >= BALL_CAM_MIN_FOLLOW_TIME &&
      this.#ball.phase === "roll" &&
      this.#ball.vel.lengthSq() <= BALL_CAM_RETURN_SPEED * BALL_CAM_RETURN_SPEED;
    if (!this.#ball.moving || nearlyStopped) {
      this.#ballCamActive = false;
      return false;
    }

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
    this.#publishState(true, true);
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

  remoteScore(id: number, name: string, h: number, p: number, s: number, r: number, hud: HUD) {
    this.#remoteScores.set(id, { name, hole: h, strokes: s, total: r });
    this.#syncPeerScores();
    hud.message(`${name}: ${standingLabel(s, p)} on hole ${h} ⛳`, 3);
  }

  remoteState(id: number, name: string, d: number[], h: number, s: number, r: number) {
    const ball = this.#remoteBall(id);
    const visible = d[3] === 1;
    ball.mesh.visible = visible;
    if (visible) {
      ball.target.set(d[0], d[1], d[2]);
      if (!Number.isFinite(ball.mesh.position.x) || ball.mesh.position.lengthSq() === 0) ball.mesh.position.copy(ball.target);
      ball.moving = d[4] === 1;
    }
    this.#remoteScores.set(id, { name, hole: h, strokes: s, total: r });
    this.#syncPeerScores();
  }

  #syncPeerScores() {
    this.#ui.setPeers([...this.#remoteScores.values()]);
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
        if (typeof msg.h === "number" && typeof msg.p === "number" && typeof msg.s === "number" && typeof msg.r === "number")
          this.remoteScore(id, name, msg.h, msg.p, msg.s, msg.r, hud);
        break;
      case "state":
        if (
          d.length === 5 &&
          typeof msg.h === "number" &&
          typeof msg.s === "number" &&
          typeof msg.r === "number"
        )
          this.remoteState(id, name, d, msg.h, msg.s, msg.r);
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
    this.#remoteScores.delete(id);
    this.#syncPeerScores();
  }

  #updateRemotes(dt: number) {
    for (const r of this.#remote.values()) {
      const k = r.moving ? Math.min(1, dt * 10) : Math.min(1, dt * 20);
      r.mesh.position.lerp(r.target, k);
    }
  }
}
