import * as THREE from "three/webgpu";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";
import type { Input } from "../core/input";
import type { SavedPlayer } from "../core/persist";
import {
  applyAvatarToRig,
  buildRig,
  buildSteeringWheel,
  poseAir,
  poseClimb,
  poseDrive,
  poseIdle,
  poseRide,
  poseSwim,
  poseWalk,
  type Rig
} from "./rig";
import { avatarFromSeed, normalizeAvatarTraits, type AvatarTraits } from "./avatar";
import { DEFAULT_DRIVE_SPEC, type Cockpit, type DriveSpec, type PlayerMode } from "./types";
import { WalkController, WALK_TUNING } from "./walk";
import { LightPool } from "./lightPool";
import { buildCarMesh, CarController } from "../vehicles/car";
import { buildPlaneMesh, collectPlaneAnim, FlyController, type PlaneAnim } from "../vehicles/plane";
import { buildBoatMesh, BoatController, BOAT_TUNING, type BoatSailRig } from "../vehicles/boat";
import { buildDroneMesh, DroneController } from "../vehicles/drone";
import { buildBoardMesh, BoardController, BOARD_TUNING } from "../vehicles/board";
import { buildBirdMesh, BirdController } from "../vehicles/bird";
import { buildTruckMesh, TruckController } from "../vehicles/truck";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0)
};

/**
 * Show/hide an embodiment's visual meshes. Embodiments carry no Light objects
 * of their own — their lamps are lightAnchor markers served by the shared
 * LightPool, which keeps the scene's light set a constant size (adding or
 * removing a light rebuilds every lit pipeline in the scene: the old 7s
 * first-switch-into-the-boat freeze).
 */
function setEmbodimentVisible(root: THREE.Group, on: boolean) {
  // flag survives on the group so async-loaded meshes (bird GLB) can match
  // the current state when they resolve
  root.userData.embodimentVisible = on;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.visible = on;
  });
}

/**
 * The player: one physics body + one visible embodiment at a time. Each mode's
 * behavior (body shape, entry rules, per-step control) lives in its own
 * controller — vehicles under src/vehicles/<name>/, walking in ./walk.ts.
 * This class owns what's shared: the body lifecycle, mode switching, the
 * fixed-step→render-frame transform interpolation, and the character rigs
 * posed onto whichever embodiment is active.
 */
export class Player {
  mode: PlayerMode = "walk";
  body = 0;
  position = new THREE.Vector3();
  quaternion = new THREE.Quaternion();
  velocity = new THREE.Vector3();
  heading = 0;
  speed = 0;
  time = 0; // sim seconds, advanced by fixed steps (controllers read this)

  // physics runs on a fixed 60 Hz step but the display can render faster
  // (120 Hz ProMotion). Rendering the raw body transform makes the world stutter
  // against the per-frame camera, so visuals read these interpolated transforms:
  // lerp(state before last step, state after last step, accumulator alpha).
  renderPosition = new THREE.Vector3();
  renderQuaternion = new THREE.Quaternion();
  #currPosition = new THREE.Vector3();
  #currQuaternion = new THREE.Quaternion();
  #prevPosition = new THREE.Vector3();
  #prevQuaternion = new THREE.Quaternion();

  meshes: Record<PlayerMode, THREE.Group>;

  readonly physics: Physics;
  readonly map: WorldMap;
  #meshYawQuat = new THREE.Quaternion();

  // per-mode behavior; adding a vehicle = new folder + one entry here
  #modes: {
    walk: WalkController;
    drive: CarController;
    plane: FlyController;
    boat: BoatController;
    drone: DroneController;
    board: BoardController;
    bird: BirdController;
    truck: TruckController;
  };

  // character rigs: one per embodiment (walker, board rider, car driver).
  // Poses are written every rendered frame in #animate.
  #walkRig: Rig;
  #riderRig: Rig;
  #driverRig: Rig;
  #wheel: { group: THREE.Group; spin: THREE.Group };
  #helmRig: Rig; // boat crew: the boat never swaps meshes, so it keeps its own
  #helmWheel: { group: THREE.Group; spin: THREE.Group };
  #pilotRig: Rig; // plane crew: open cockpit, hands on the built-in yoke
  #planeAnim: PlaneAnim;
  #truckRig: Rig; // parade-truck driver: the truck never swaps meshes, keeps its own
  #truckWheel: { group: THREE.Group; spin: THREE.Group };
  #avatar: AvatarTraits;
  #hasWheel = false;
  #animT = 0; // free-running clock for idle sway/bob
  #strideT = 0; // stride/stroke phase, advanced by speed

  // what the player is currently driving; swapped when commandeering traffic
  driveSpec: DriveSpec = DEFAULT_DRIVE_SPEC;
  swimEnter = false;
  #defaultDriveMesh!: THREE.Group;
  #defaultDroneMesh!: THREE.Group;
  #broomRigAttached = false;
  #scene: THREE.Scene;
  #lightPool: LightPool;

  onModeChange: (mode: PlayerMode) => void = () => {};

  constructor(
    physics: Physics,
    map: WorldMap,
    scene: THREE.Scene,
    spawn: { x: number; z: number; heading: number },
    avatar: AvatarTraits = avatarFromSeed("local-default")
  ) {
    this.physics = physics;
    this.map = map;
    this.#scene = scene;
    this.#avatar = normalizeAvatarTraits(avatar);
    this.#walkRig = buildRig(this.#avatar);
    const walkGroup = new THREE.Group();
    walkGroup.add(this.#walkRig.group); // rig origin already sits at the capsule centre
    this.meshes = {
      walk: walkGroup,
      drive: buildCarMesh(),
      plane: buildPlaneMesh(),
      boat: buildBoatMesh(),
      drone: buildDroneMesh(),
      board: buildBoardMesh(),
      bird: buildBirdMesh(),
      truck: buildTruckMesh()
    };
    this.#modes = {
      walk: new WalkController(),
      drive: new CarController(),
      plane: new FlyController(),
      boat: new BoatController(),
      drone: new DroneController(this.meshes.drone),
      board: new BoardController(),
      bird: new BirdController(this.meshes.bird),
      truck: new TruckController()
    };
    // surf stance across the deck; ZYX order so the carve lean (z) rolls the
    // already-yawed stance around the board's long axis
    this.#riderRig = buildRig(this.#avatar);
    this.#riderRig.group.rotation.order = "ZYX";
    this.#riderRig.group.rotation.y = 1.05;
    this.#riderRig.group.position.y = 0.93; // soles on the deck top
    this.meshes.board.add(this.#riderRig.group);
    this.#driverRig = buildRig(this.#avatar);
    this.#wheel = buildSteeringWheel();
    // helmsman on the stern bench, hands on a wheel at the console (same
    // seat→wheel offsets as the car cockpit so poseDrive's reach lines up)
    this.#helmRig = buildRig(this.#avatar);
    this.#helmWheel = buildSteeringWheel();
    const boatDeck = (this.meshes.boat.userData.sail as BoatSailRig).heel;
    this.#helmRig.group.position.set(0, 0.5, 2.26);
    this.#helmWheel.group.position.set(0, 0.61, 1.72);
    boatDeck.add(this.#helmRig.group, this.#helmWheel.group);
    // pilot in the plane's open cockpit; the yoke is part of the plane mesh
    this.#pilotRig = buildRig(this.#avatar);
    const pc = this.meshes.plane.userData.cockpit as Cockpit;
    this.#pilotRig.group.position.set(pc.seat[0], pc.seat[1], pc.seat[2]);
    this.meshes.plane.add(this.#pilotRig.group);
    this.#planeAnim = collectPlaneAnim(this.meshes.plane);
    // parade-truck driver on the bench, hands on a wheel at the console (same
    // seat→wheel offsets as the car cockpit so poseDrive's reach lines up)
    this.#truckRig = buildRig(this.#avatar);
    this.#truckWheel = buildSteeringWheel();
    const tc = this.meshes.truck.userData.cockpit as Cockpit;
    this.#truckRig.group.position.set(tc.seat[0], tc.seat[1], tc.seat[2]);
    this.#truckWheel.group.position.set(tc.wheel![0], tc.wheel![1], tc.wheel![2]);
    this.meshes.truck.add(this.#truckRig.group, this.#truckWheel.group);
    this.#defaultDriveMesh = this.meshes.drive;
    this.#defaultDroneMesh = this.meshes.drone;
    this.#seatDriver(this.meshes.drive);
    // pool constructed before the first render so the warm-up compile already
    // sees the final (and only-ever) light set
    this.#lightPool = new LightPool(scene);
    for (const m of Object.values(this.meshes)) {
      setEmbodimentVisible(m, false);
      scene.add(m);
    }
    this.position.set(spawn.x, map.effectiveGround(spawn.x, spawn.z) + 1.5, spawn.z);
    this.#spawnBody("walk", spawn.heading);
  }

  setAvatar(avatar: AvatarTraits) {
    this.#avatar = normalizeAvatarTraits(avatar);
    applyAvatarToRig(this.#walkRig, this.#avatar);
    applyAvatarToRig(this.#riderRig, this.#avatar);
    applyAvatarToRig(this.#driverRig, this.#avatar);
    applyAvatarToRig(this.#helmRig, this.#avatar);
    applyAvatarToRig(this.#pilotRig, this.#avatar);
    applyAvatarToRig(this.#truckRig, this.#avatar);
  }

  #destroyBody() {
    if (this.body) {
      this.physics.unregisterVehicle(this.body);
      this.physics.world.destroyBody(this.body);
      this.body = 0;
    }
  }

  /**
   * `facing` is the raw yaw the new body noses toward. The stored `heading`
   * field carries facing+π (every mode update writes atan2(...)+π), so the
   * default converts back — passing `this.heading` raw here is what used to
   * spin every mode switch 180°.
   */
  #spawnBody(mode: PlayerMode, facing = this.heading - Math.PI) {
    const w = this.physics.world;
    const p = this.position;
    this.#destroyBody();
    this.riding = false; // any body spawn ends a passenger ride
    this.mode = mode;
    const q: [number, number, number, number] = [0, Math.sin(facing / 2), 0, Math.cos(facing / 2)];
    // the controller creates its body shape at p and resets its per-mode state
    const placedY = this.#modes[mode].spawnBody(this, facing);
    w.setBodyTransform(this.body, [p.x, placedY, p.z], q);
    // reset the interpolation history so a teleport/mode switch doesn't smear
    this.quaternion.set(q[0], q[1], q[2], q[3]);
    this.#currPosition.set(p.x, placedY, p.z);
    this.#currQuaternion.copy(this.quaternion);
    this.#prevPosition.copy(this.#currPosition);
    this.#prevQuaternion.copy(this.quaternion);
    this.renderPosition.copy(this.#currPosition);
    this.renderQuaternion.copy(this.quaternion);
    // keep the storage convention from the first frame, not just after an update
    this.heading = facing + Math.PI;
    this.physics.registerVehicle(this.body);
    for (const [k, m] of Object.entries(this.meshes)) {
      setEmbodimentVisible(m, k === mode);
    }
    this.#lightPool.claim(this.meshes[mode]);
    this.onModeChange(mode);
  }

  /**
   * Loading-screen shader warm-up: show every embodiment at once (true), then
   * restore the real mode (false). One render with everything visible compiles
   * every vehicle material before play; the scene light set never changes
   * after construction, so mode switches stay compile-free.
   */
  warmup(all: boolean) {
    for (const [k, m] of Object.entries(this.meshes)) setEmbodimentVisible(m, all || k === this.mode);
  }

  trySwitch(mode: PlayerMode) {
    if (mode === this.mode) return;
    let facing = this.heading - Math.PI; // keep pointing the way we face now
    const entered = this.#modes[mode].enter?.(this);
    if (typeof entered === "number") facing = entered;
    this.#spawnBody(mode, facing);
  }

  respawn(spawn: { x: number; z: number; heading: number }) {
    this.position.set(spawn.x, this.map.effectiveGround(spawn.x, spawn.z) + 1.5, spawn.z);
    this.#spawnBody(this.mode === "boat" ? "walk" : this.mode, spawn.heading);
  }

  /**
   * Teleport to another player: their spot INCLUDING altitude, adopting their
   * mode so the reunion sticks (arrive flying next to a flyer instead of
   * watching them shrink from the street). Spawns ~2 m above the target pose:
   * a body overlapping a building OBB defers that building's collider
   * (physics.#updateBuildingBodies), so arriving flush with a rooftop would
   * fall straight through it — the clearance keeps the spawn outside the
   * defer margin for the first sweep, then we drop onto the now-solid roof.
   */
  teleportTo(t: { x: number; y: number; z: number; facing: number; mode: PlayerMode }) {
    const y = Math.max(t.y + 2.0, this.map.effectiveGround(t.x, t.z) + 1.5);
    this.position.set(t.x, y - this.#modes[t.mode].spawnLift, t.z);
    this.#spawnBody(t.mode, t.facing);
  }

  /**
   * Restore a saved session (position/heading/vehicle from localStorage).
   * Skips the controllers' entry adjustments (altitude pushes, shore hops) —
   * the saved pose was already valid. Y is pre-compensated for the lift
   * spawnBody adds so a refresh doesn't creep the player upward. The saved
   * heading is the facing+π convention, so the facing yaw is heading−π.
   */
  restoreState(s: SavedPlayer) {
    this.position.set(s.x, s.y - this.#modes[s.mode].spawnLift, s.z);
    this.#spawnBody(s.mode, s.heading - Math.PI);
  }

  /**
   * Riding shotgun in another player's vehicle: no physics body of our own,
   * the pose is glued to the driver's car every frame (setRidePose). Wire and
   * HUD treat the rider as a walker; main.ts owns who the driver is.
   */
  riding = false;

  startRide() {
    if (this.riding) return;
    this.riding = true;
    this.#destroyBody(); // no body: the driver's car is the physics now
  }

  /** Glue the walker to the passenger seat (world pose from RemotePlayers.ridePose). */
  setRidePose(pos: THREE.Vector3, quat: THREE.Quaternion, dt: number) {
    if (dt > 0) {
      V.tmp.copy(pos).sub(this.renderPosition).divideScalar(dt);
      // first glued frame after boarding jumps from the sidewalk — don't let
      // that read as a 60 m/s gust in the audio/FX
      if (V.tmp.length() < 60) this.velocity.copy(V.tmp);
      this.speed = this.velocity.length();
    }
    this.position.copy(pos);
    this.renderPosition.copy(pos);
    this.renderQuaternion.copy(quat);
    this.#currPosition.copy(pos);
    this.#prevPosition.copy(pos);
    this.#currQuaternion.copy(quat);
    this.#prevQuaternion.copy(quat);
    V.tmp.set(0, 0, -1).applyQuaternion(quat);
    this.heading = Math.atan2(-V.tmp.x, -V.tmp.z) + Math.PI; // storage convention (facing+π)
    const mesh = this.meshes.walk;
    mesh.position.copy(pos);
    mesh.quaternion.copy(quat); // full car tilt, not the yaw-only walk slerp
    this.#animT += dt;
    poseDrive(this.#walkRig, 0, this.#animT, false); // seated, hands in lap
    this.#lightPool.update();
  }

  /** Hop out: back on our own feet where we are (caller offsets clear of the car). */
  endRide(facing = this.heading - Math.PI) {
    if (!this.riding) return;
    this.riding = false;
    this.#spawnBody("walk", facing);
  }

  /** One fixed physics step of control. `aim` (camera direction) drives drone movement; fly steers via steerFly. */
  update(dt: number, input: Input, camYaw: number, aim: THREE.Vector3) {
    if (this.riding) return; // no body — the driver's car moves us
    this.time += dt;
    const w = this.physics.world;
    // keep the player body hot: box3d silently drops velocity writes on sleeping
    // bodies (their state lives only in the awake solver set)
    w.setBodyAwake(this.body, true);
    const t = w.getBodyTransform(this.body);
    const v = w.getBodyVelocity(this.body);
    this.position.set(t.position[0], t.position[1], t.position[2]);
    this.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    this.velocity.set(v.linear[0], v.linear[1], v.linear[2]);
    this.speed = this.velocity.length();

    this.#modes[this.mode].update(this, dt, input, { camYaw, aim, v });
  }

  requestBoardJump() {
    if (this.mode === "board") this.#modes.board.requestJump();
  }

  requestWalkJump() {
    if (this.mode === "walk") this.#modes.walk.requestJump();
  }

  /** Board airborne state — the hoverboard hum softens in the air. */
  get boardGrounded(): boolean {
    return this.#modes.board.grounded;
  }

  /** On a wall right now — the tutorial's climbing chapter watches this. */
  get climbing(): boolean {
    return this.mode === "walk" && this.#modes.walk.climbing;
  }

  /** Frame-rate flight steering — mouse aims the plane, A/D add banked yaw. */
  steerFly(input: Input, dt: number) {
    if (this.mode !== "plane") return;
    this.#modes.plane.steerFly(input, dt);
  }

  /** Plane forward (fly mode). */
  get flyForward(): THREE.Vector3 {
    return this.#modes.plane.fwd;
  }

  /**
   * Swap what "drive" means: the mesh (a commandeered taxi/bus/cable car from
   * traffic, or null for the default sports car) and the matching body/handling
   * spec. Takes effect on the next drive body spawn.
   */
  setDriveStyle(mesh: THREE.Group | null, spec?: DriveSpec) {
    const next = mesh ?? this.#defaultDriveMesh;
    if (next !== this.meshes.drive) {
      const old = this.meshes.drive;
      setEmbodimentVisible(old, false);
      if (old !== this.#defaultDriveMesh) this.#scene.remove(old);
      if (next.parent !== this.#scene) this.#scene.add(next);
      this.meshes.drive = next;
      this.#seatDriver(next); // seat first: the rig's meshes ride the toggle below
      setEmbodimentVisible(next, this.mode === "drive");
      if (this.mode === "drive") this.#lightPool.claim(next);
    }
    this.driveSpec = spec ?? DEFAULT_DRIVE_SPEC;
  }

  /** Swap the drone mesh (Quidditch broom, etc.). Null restores the stock drone. */
  setDroneStyle(mesh: THREE.Group | null) {
    const next = mesh ?? this.#defaultDroneMesh;
    if (next === this.meshes.drone) return;
    const old = this.meshes.drone;
    this.#riderRig.group.removeFromParent();
    this.#broomRigAttached = false;
    setEmbodimentVisible(old, false);
    if (old !== this.#defaultDroneMesh) this.#scene.remove(old);
    if (next.parent !== this.#scene) this.#scene.add(next);
    this.meshes.drone = next;
    if (next.userData.broom) {
      this.#riderRig.group.rotation.order = "ZYX";
      this.#riderRig.group.rotation.set(0, 1.05, 0);
      this.#riderRig.group.position.set(0, 0.72, -0.35);
      next.add(this.#riderRig.group);
      this.#broomRigAttached = true;
    }
    setEmbodimentVisible(next, this.mode === "drone");
    if (this.mode === "drone") this.#lightPool.claim(next);
  }

  /** Restore the stock camera drone after a Quidditch broom ride. */
  clearDroneStyle() {
    if (this.meshes.drone !== this.#defaultDroneMesh) this.setDroneStyle(null);
  }

  /**
   * Put the driver rig (and wheel, if the vehicle has one) into a drive mesh
   * at its cockpit anchor. Closed cabs (`hide`) park the rig invisible so it
   * doesn't poke through the roof.
   */
  #seatDriver(mesh: THREE.Group) {
    const c = mesh.userData.cockpit as Cockpit | undefined;
    this.#driverRig.group.removeFromParent();
    this.#wheel.group.removeFromParent();
    this.#hasWheel = false;
    if (!c || c.hide) {
      this.#driverRig.group.visible = false;
      return;
    }
    this.#driverRig.group.visible = true;
    this.#driverRig.group.position.set(c.seat[0], c.seat[1], c.seat[2]);
    this.#driverRig.group.rotation.set(0, 0, 0);
    mesh.add(this.#driverRig.group);
    if (c.wheel) {
      this.#hasWheel = true;
      this.#wheel.group.position.set(c.wheel[0], c.wheel[1], c.wheel[2]);
      mesh.add(this.#wheel.group);
    }
  }

  /**
   * Called once per rendered frame, after the fixed-step loop. Advances the
   * interpolated render transform: `stepped` is how many physics steps ran this
   * frame, `alpha` is accumulator/fixedTimeStep in [0,1).
   */
  afterSteps(stepped: number, alpha: number) {
    if (stepped > 0) {
      // this.position/quaternion hold the state read at the START of the last
      // update() — i.e. one step behind the solver — which is exactly `prev`
      this.#prevPosition.copy(this.position);
      this.#prevQuaternion.copy(this.quaternion);
      const t = this.physics.world.getBodyTransform(this.body);
      this.#currPosition.set(t.position[0], t.position[1], t.position[2]);
      this.#currQuaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    }
    this.renderPosition.lerpVectors(this.#prevPosition, this.#currPosition, alpha);
    this.renderQuaternion.slerpQuaternions(this.#prevQuaternion, this.#currQuaternion, alpha);
  }

  /** Copies the interpolated transform into the active mesh + animates the rig. */
  syncMesh(dt = 1 / 60) {
    const mesh = this.meshes[this.mode];
    mesh.position.copy(this.renderPosition);
    if (this.mode === "walk") {
      // the capsule's physics rotation is pinned; face the travel heading smoothly
      this.#meshYawQuat.setFromAxisAngle(V.up, this.heading + Math.PI);
      mesh.quaternion.slerp(this.#meshYawQuat, 0.22);
    } else {
      mesh.quaternion.copy(this.renderQuaternion);
    }
    this.#animate(dt);
    this.#lightPool.update();
  }

  /** Per-frame character animation: pose whichever rig is embodied right now. */
  #animate(dt: number) {
    this.#animT += dt;
    if (this.mode === "walk") {
      const r = this.#walkRig;
      const walk = this.#modes.walk;
      if (walk.climbing) {
        this.#strideT += dt * 7;
        poseClimb(r, this.#strideT);
      } else if (walk.swimming) {
        this.#strideT += dt * 3.4;
        poseSwim(r, this.#strideT);
      } else if (!walk.grounded) {
        poseAir(r);
      } else {
        const h = Math.hypot(this.velocity.x, this.velocity.z);
        if (h > 0.35) {
          this.#strideT += dt * (3.2 + h * 1.15);
          poseWalk(r, this.#strideT, THREE.MathUtils.clamp((h - WALK_TUNING.values.speed) / 4.8, 0, 1));
        } else {
          poseIdle(r, this.#animT);
        }
      }
    } else if (this.mode === "board") {
      const board = this.#modes.board;
      const crouch = Math.min(1, this.speed / BOARD_TUNING.values.boostMaxSpeed + Math.abs(board.lean) * 0.6);
      poseRide(this.#riderRig, board.lean, crouch, !board.grounded, this.#animT);
      this.#riderRig.group.rotation.z = board.lean * 0.4; // whole-body dip on top of the deck roll
    } else if (this.mode === "drone" && this.#broomRigAttached) {
      const lean = THREE.MathUtils.clamp(this.velocity.x * 0.04, -0.5, 0.5);
      const crouch = Math.min(1, this.speed / 28);
      poseRide(this.#riderRig, lean, crouch, this.speed > 8, this.#animT);
      this.#riderRig.group.rotation.z = lean * 0.35;
    } else if (this.mode === "drive" && this.#driverRig.group.visible) {
      const steer = this.#modes.drive.steerVis;
      poseDrive(this.#driverRig, steer, this.#animT, this.#hasWheel);
      this.#wheel.spin.rotation.z = steer * 2.3;
    } else if (this.mode === "plane") {
      // pilot leans with the bank, hands following the yoke; props spin with
      // airspeed (the local mesh's parts — remotes rediscover their clones')
      const bank = this.#modes.plane.bank;
      poseDrive(this.#pilotRig, bank, this.#animT, true);
      if (this.#planeAnim.yoke) this.#planeAnim.yoke.rotation.z = bank * 1.6;
      const spin = dt * (7 + this.speed * 0.55);
      for (const p of this.#planeAnim.props) p.rotation.z += spin;
    } else if (this.mode === "boat") {
      const steer = this.#modes.boat.steerVis;
      poseDrive(this.#helmRig, steer, this.#animT, true);
      this.#helmWheel.spin.rotation.z = steer * 2.3;
      // wind response: idle canvas luffs hard with no belly; speed sheets the
      // boom in, fills the sail and heels the hull. Turns dip into the carve.
      const s = this.meshes.boat.userData.sail as BoatSailRig;
      const wind = THREE.MathUtils.clamp(this.speed / BOAT_TUNING.values.maxSpeed, 0, 1);
      const k = Math.min(1, dt * 2);
      s.flap.value += (0.5 - wind * 0.42 - s.flap.value) * k;
      s.billow.value += (0.1 + wind * 0.36 - s.billow.value) * k;
      s.boom.rotation.y = 0.1 + wind * 0.2 + Math.sin(this.#animT * 0.6) * 0.05;
      s.heel.rotation.z = steer * 0.1 - wind * 0.08;
    } else if (this.mode === "truck") {
      const steer = this.#modes.truck.steerVis;
      poseDrive(this.#truckRig, steer, this.#animT, true);
      this.#truckWheel.spin.rotation.z = steer * 2.3;
    }
  }

  get aimOrigin(): THREE.Vector3 {
    return V.tmp2.copy(this.position).add(V.tmp.set(0, this.mode === "plane" || this.mode === "drone" || this.mode === "bird" ? 0 : 1.4, 0));
  }
}
