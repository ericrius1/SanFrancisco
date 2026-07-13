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
  poseDrive,
  poseIdle,
  poseGolf,
  poseRide,
  poseScooter,
  poseSwim,
  poseWalk,
  rigHandWorld,
  setHandPose,
  type Rig
} from "./rig";
import { attachToHand, buildBow, buildGolfClub, secondHandCurl, GOLF_CLUB_GRIP, type GripSpec, type HeldItem } from "./held";
import { ARCHER_BOW_GRIP, poseArcher } from "../gameplay/archery/poses";
import { avatarFromSeed, normalizeAvatarTraits, type AvatarTraits } from "./avatar";
import { DEFAULT_DRIVE_SPEC, type Cockpit, type DriveSpec, type PlayerMode } from "./types";
import { WalkController, WALK_TUNING } from "./walk";
import { LightPool } from "./lightPool";
import {
  applyBallGlow,
  prepareBallGlowMaterial,
  TENNIS_BALL_COLOR
} from "../fx/ballGlow";
import { buildCarMesh, CarController } from "../vehicles/car";
import { buildPlaneMesh, collectPlaneAnim, FlyController, type PlaneAnim } from "../vehicles/plane";
import { buildBoatMesh, buildSpeedboatMesh, BoatController, BOAT_TUNING, SPEEDBOAT_TUNING, type BoatSailRig } from "../vehicles/boat";
import { buildDroneMesh, DroneController } from "../vehicles/drone";
import { buildBoardMesh, animateBoard, updateBoardSurface, BoardController, BOARD_TUNING, type BoardConfig } from "../vehicles/board";
import {
  activateSurfboardAssets,
  animateSurfboard,
  buildSurfboardMesh,
  updateSurfboardSurface,
  SurfController,
  SURF_TUNING,
  type SurfboardConfig,
  type SurfTelemetry
} from "../vehicles/surf";
import { animateScooter, buildScooterMesh, ScooterController, type ScooterConfig } from "../vehicles/scooter";
import { buildBirdMesh, BirdController } from "../vehicles/bird";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  quat: new THREE.Quaternion()
};

/** DEV-only live golf-pose tuning (window.__golfTune), consumed by the golf
 *  grip + poseGolf so tools/golf-pose-probe.mjs can sweep in one boot. The
 *  old chest-pivot keys (pivotY/pivotZ/pivotAX/raise/swingZ) died with the
 *  pivot — the club is now solved into the lead hand via attachToHand, so the
 *  tunables are the item-local grip point/orientation instead. */
type GolfTune = { gripX?: number; gripY?: number; gripZ?: number; gripRX?: number; gripRY?: number; gripRZ?: number; hinge?: number };

/** DEV-only live archery bow-grip tuning (window.__archeryTune) — same idea
 *  as GolfTune: presence re-solves the attach every setArcherPose call. */
type ArcheryTune = { bx?: number; by?: number; bz?: number; brx?: number; bry?: number; brz?: number };

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
    scooter: ScooterController;
    plane: FlyController;
    boat: BoatController;
    speedboat: BoatController;
    drone: DroneController;
    board: BoardController;
    surf: SurfController;
    bird: BirdController;
  };

  // character rigs: one per embodiment (walker, board rider, car driver).
  // Poses are written every rendered frame in #animate.
  #walkRig: Rig;
  #golfClub: THREE.Group;
  #heldClub: HeldItem | null = null; // grip attachment while golfing
  #golfPose = { active: false, swing: 0 };
  #golfAddress = new THREE.Vector3(); // world spot the stance eases toward
  #golfAddressSet = false;
  #golfMeshShift = new THREE.Vector3(); // eased rig-root offset (walk-mesh local)
  // archery: a persistent bow in the LEFT mitt, the golf-club pattern verbatim
  // (attach once, toggle visibility; releasing per-frame would zero the wrist)
  #bow: THREE.Group;
  #heldBow: HeldItem | null = null;
  #archerPose = { active: false, draw: 0, pitch: 0 };
  #bowCarried = false; // bow visible + left mitt curled while merely walking around
  // ball tool: a tennis ball riding the right mitt, shown while held. The clasp
  // + prop visibility are driven every walk frame in #animate (setEmbodimentVisible
  // re-shows every walk mesh on a mode return, so #ballHeld is the true owner).
  #ballProp: THREE.Mesh;
  #ballMaterial: THREE.MeshStandardMaterial;
  #ballHeld = false;
  #throwT = 0; // 0 = idle; >0 drives an additive windup→release arm swing
  #riderRig: Rig;
  #surfRig: Rig;
  #scooterRig: Rig;
  #driverRig: Rig;
  #wheel: { group: THREE.Group; spin: THREE.Group };
  #helmRig: Rig; // boat crew: the boat never swaps meshes, so it keeps its own
  #helmWheel: { group: THREE.Group; spin: THREE.Group };
  #speedRig: Rig; // speedboat helm: same deal, its own seated crew + wheel
  #speedWheel: { group: THREE.Group; spin: THREE.Group };
  #pilotRig: Rig; // plane crew: open cockpit, hands on the built-in yoke
  #planeAnim: PlaneAnim;
  #avatar: AvatarTraits;
  #firstPersonView = false;
  #externalEmbodimentHidden = false;
  #hasWheel = false;
  #animT = 0; // free-running clock for idle sway/bob
  #strideT = 0; // stride/stroke phase, advanced by speed

  // what the player is currently driving; swapped when mounting a ridden animal
  driveSpec: DriveSpec = DEFAULT_DRIVE_SPEC;
  swimEnter = false;
  #carryBoard!: THREE.Group; // surfboard tucked under the arm while on the beach
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
    avatar: AvatarTraits = avatarFromSeed("local-default"),
    board?: BoardConfig,
    scooter?: ScooterConfig,
    surfboard?: SurfboardConfig
  ) {
    this.physics = physics;
    this.map = map;
    this.#scene = scene;
    this.#avatar = normalizeAvatarTraits(avatar);
    this.#walkRig = buildRig(this.#avatar);
    const walkGroup = new THREE.Group();
    walkGroup.add(this.#walkRig.group); // rig origin already sits at the capsule centre
    // the club lives IN the lead hand: setGolfPose attaches this persistent
    // instance via the grip system, so it travels with the swinging arms and
    // the fingers visibly wrap the grip. Unparented while not golfing.
    this.#golfClub = buildGolfClub();
    // the bow rides the left hand for the archery range, hidden until held
    this.#bow = buildBow();
    this.#bow.visible = false;
    // tennis ball nestled in the right mitt — rides the animated hand exactly, so
    // a throw launches it from wherever the hand is (no per-frame position math).
    this.#ballMaterial = new THREE.MeshStandardMaterial({ color: TENNIS_BALL_COLOR, roughness: 0.62 });
    prepareBallGlowMaterial(this.#ballMaterial);
    this.#ballProp = new THREE.Mesh(new THREE.SphereGeometry(0.11, 12, 10), this.#ballMaterial);
    this.#ballProp.position.set(0, -0.02, -0.05); // cupped in the curled fingers
    this.#ballProp.visible = false;
    this.#walkRig.handR.add(this.#ballProp);
    this.meshes = {
      walk: walkGroup,
      drive: buildCarMesh(),
      scooter: buildScooterMesh(scooter),
      plane: buildPlaneMesh(),
      boat: buildBoatMesh(),
      speedboat: buildSpeedboatMesh(),
      drone: buildDroneMesh(),
      board: buildBoardMesh(board),
      surf: buildSurfboardMesh(surfboard),
      bird: buildBirdMesh()
    };
    this.#modes = {
      walk: new WalkController(),
      drive: new CarController(),
      scooter: new ScooterController(),
      plane: new FlyController(),
      boat: new BoatController(),
      speedboat: new BoatController(SPEEDBOAT_TUNING),
      drone: new DroneController(this.meshes.drone),
      board: new BoardController(),
      surf: new SurfController(),
      bird: new BirdController(this.meshes.bird)
    };
    this.#modes.surf.setConfig(surfboard ?? this.#modes.surf.config);
    // surf stance across the deck; ZYX order so the carve lean (z) rolls the
    // already-yawed stance around the board's long axis
    this.#riderRig = buildRig(this.#avatar);
    this.#riderRig.group.rotation.order = "ZYX";
    this.#riderRig.group.rotation.y = 1.05;
    this.#riderRig.group.position.y = 0.93; // soles on the deck top
    this.meshes.board.add(this.#riderRig.group);
    this.#surfRig = buildRig(this.#avatar);
    this.#surfRig.group.rotation.order = "ZYX";
    this.#surfRig.group.rotation.y = 1.05;
    this.#surfRig.group.position.y = 0.93;
    this.meshes.surf.add(this.#surfRig.group);
    // A surfboard tucked upright under the right arm, shown on foot at the beach
    // so you arrive "holding your board, ready to paddle out".
    this.#carryBoard = buildSurfboardMesh(surfboard);
    this.#carryBoard.scale.setScalar(0.82);
    this.#carryBoard.position.set(0.62, 1.0, -0.05);
    this.#carryBoard.rotation.set(0.05, 0, Math.PI * 0.52);
    this.#carryBoard.visible = false;
    this.meshes.walk.add(this.#carryBoard);
    this.#scooterRig = buildRig(this.#avatar);
    const scooterCockpit = this.meshes.scooter.userData.cockpit as Cockpit;
    this.#scooterRig.group.position.set(...scooterCockpit.seat);
    this.meshes.scooter.add(this.#scooterRig.group);
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
    // speedboat helmsman at the open console (cockpit anchors on the mesh)
    this.#speedRig = buildRig(this.#avatar);
    this.#speedWheel = buildSteeringWheel();
    const sc = this.meshes.speedboat.userData.cockpit as Cockpit;
    this.#speedRig.group.position.set(sc.seat[0], sc.seat[1], sc.seat[2]);
    this.#speedWheel.group.position.set(sc.wheel![0], sc.wheel![1], sc.wheel![2]);
    this.meshes.speedboat.add(this.#speedRig.group, this.#speedWheel.group);
    // pilot in the plane's open cockpit; the yoke is part of the plane mesh
    this.#pilotRig = buildRig(this.#avatar);
    const pc = this.meshes.plane.userData.cockpit as Cockpit;
    this.#pilotRig.group.position.set(pc.seat[0], pc.seat[1], pc.seat[2]);
    this.meshes.plane.add(this.#pilotRig.group);
    this.#planeAnim = collectPlaneAnim(this.meshes.plane);
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
    applyAvatarToRig(this.#surfRig, this.#avatar);
    applyAvatarToRig(this.#scooterRig, this.#avatar);
    applyAvatarToRig(this.#driverRig, this.#avatar);
    applyAvatarToRig(this.#helmRig, this.#avatar);
    applyAvatarToRig(this.#speedRig, this.#avatar);
    applyAvatarToRig(this.#pilotRig, this.#avatar);
  }

  /** Hide only the local walk embodiment once the camera reaches the FPS eye. */
  setFirstPersonView(active: boolean) {
    this.#firstPersonView = active;
    this.meshes.walk.visible = !active && !this.#externalEmbodimentHidden;
  }

  /** Let an in-world activity rig embody the local player without moving the camera target. */
  setExternalEmbodimentHidden(hidden: boolean) {
    this.#externalEmbodimentHidden = hidden;
    this.meshes[this.mode].visible = !hidden && (this.mode !== "walk" || !this.#firstPersonView);
  }

  #destroyBody() {
    if (this.body) {
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
    // A mode switch can bypass the chase camera for a frame (cinematics/orbit).
    // Never carry the local-only FPS visibility override into another embodiment.
    if (mode !== "walk") this.setFirstPersonView(false);
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
    for (const [k, m] of Object.entries(this.meshes)) {
      setEmbodimentVisible(m, k === mode);
    }
    // Surf art is intentionally absent from boot. The active board requests
    // only its selected surface/decal the first time surfing actually starts.
    if (mode === "surf") void activateSurfboardAssets(this.meshes.surf);
    this.#lightPool.claim(this.meshes[mode]);
    this.onModeChange(mode);
  }

  /**
   * Pre-compile GPU pipelines by making the given modes' meshes visible for a
   * render. Pass `"all"` for every mode, an array for a subset, or omit to show
   * only the current mode (restore after a warm pass). Caller must render while
   * the meshes are visible — visibility alone does not compile WGSL.
   */
  warmup(modes?: PlayerMode[] | "all") {
    for (const [k, m] of Object.entries(this.meshes)) {
      const on =
        modes === "all" || (Array.isArray(modes) ? modes.includes(k as PlayerMode) : k === this.mode);
      setEmbodimentVisible(m, on);
    }
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
    const mode = s.mode in this.#modes ? s.mode : "walk";
    this.position.set(s.x, s.y - this.#modes[mode].spawnLift, s.z);
    this.#spawnBody(mode, s.heading - Math.PI);
  }

  /**
   * Soft personal space against other avatars. When another standing player
   * occupies (almost) the same spot — the shared spawn point, a group photo,
   * an idle friend — the two box rigs interpenetrate and the coplanar faces
   * shimmer like z-fighting. Both clients run this, so overlapping players
   * gently slide apart. On-foot only: vehicles have real silhouettes and a
   * shove while driving would feel like a physics bug.
   */
  separateFromAvatars(others: readonly { x: number; z: number }[], dt: number) {
    if (this.riding || this.mode !== "walk" || !this.body) return;
    const RADIUS = 0.7; // rig shoulders are ~0.6 m wide
    const SPEED = 1.1; // m/s of drift, slow enough to read as a polite step
    let px = 0;
    let pz = 0;
    for (const o of others) {
      const dx = this.position.x - o.x;
      const dz = this.position.z - o.z;
      const d = Math.hypot(dx, dz);
      if (d >= RADIUS) continue;
      if (d < 1e-3) {
        // dead-centre overlap: step out to the side we're facing away from
        px += Math.cos(this.heading);
        pz += -Math.sin(this.heading);
      } else {
        const w = (RADIUS - d) / RADIUS;
        px += (dx / d) * w;
        pz += (dz / d) * w;
      }
    }
    if (px === 0 && pz === 0) return;
    const len = Math.hypot(px, pz);
    const step = Math.min(SPEED * dt, 0.05);
    const w = this.physics.world;
    const t = w.getBodyTransform(this.body);
    w.setBodyTransform(
      this.body,
      [t.position[0] + (px / len) * step, t.position[1], t.position[2] + (pz / len) * step],
      t.rotation
    );
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

  requestSurfJump() {
    if (this.mode === "surf") this.#modes.surf.requestJump();
  }

  requestSurfFlow() {
    if (this.mode === "surf") return this.#modes.surf.requestFlow();
    return false;
  }

  get surfTelemetry(): SurfTelemetry {
    return this.#modes.surf.telemetry;
  }

  requestWalkJump() {
    if (this.mode === "walk") this.#modes.walk.requestJump();
  }

  /** Air/landing state for probes and the window.__sf diagnostics surface. */
  get driveJumpState() {
    return this.#modes.drive.jumpDebug;
  }

  get scooterJumpState() {
    return this.#modes.scooter.jumpDebug;
  }

  /** Gameplay-owned golfer pose; the normal walk/idle animator resumes when off. */
  setGolfPose(active: boolean, swing = 0) {
    this.#golfPose.active = active && this.mode === "walk";
    this.#golfPose.swing = THREE.MathUtils.clamp(swing, -1, 1);
    // club into the LEAD (-X, armR → "R") hand: poseGolf joins both hands at
    // the sternum, so gripping the top of the club with the lead mitt keeps it
    // tracking the whole swing arc; the trail mitt curls alongside (#animate).
    // The golf game flips this false→true within a single update while aiming,
    // so going inactive only HIDES the club — it stays parented in the hand
    // (same lifetime as the old chest pivot) and #animate neutralises wrists.
    const t = import.meta.env.DEV ? (window as unknown as { __golfTune?: GolfTune }).__golfTune : undefined;
    if (this.#golfPose.active && (!this.#heldClub || t)) {
      // DEV: re-solve the grip every call so the probe can sweep offsets live
      const spec: GripSpec = t
        ? {
            position: [t.gripX ?? GOLF_CLUB_GRIP.position[0], t.gripY ?? GOLF_CLUB_GRIP.position[1], t.gripZ ?? GOLF_CLUB_GRIP.position[2]],
            rotation: [t.gripRX ?? GOLF_CLUB_GRIP.rotation![0], t.gripRY ?? GOLF_CLUB_GRIP.rotation![1], t.gripRZ ?? GOLF_CLUB_GRIP.rotation![2]]
          }
        : GOLF_CLUB_GRIP;
      this.#heldClub = attachToHand(this.#walkRig, "R", this.#golfClub, spec);
      secondHandCurl(this.#walkRig, "L", 1);
    }
    this.#golfClub.visible = this.#golfPose.active;
  }

  /** While golfing: world point the stance should occupy (beside the ball).
   *  The rig root eases toward it — the physics capsule never moves. */
  setGolfAddress(target: THREE.Vector3 | null) {
    if (target) this.#golfAddress.copy(target);
    this.#golfAddressSet = !!target;
  }

  /** Gameplay-owned archer pose, the setGolfPose pattern: while active the
   *  walk/idle animator hands the whole rig to poseArcher(draw, pitch); the
   *  bow attaches to the LEFT mitt on first use and stays parented (hidden
   *  when neither aiming nor carrying). `draw` < 0 = nock flourish. */
  setArcherPose(active: boolean, draw = 0, pitch = 0) {
    this.#archerPose.active = active && this.mode === "walk";
    this.#archerPose.draw = THREE.MathUtils.clamp(draw, -1, 1);
    this.#archerPose.pitch = pitch;
    const t = import.meta.env.DEV ? (window as unknown as { __archeryTune?: ArcheryTune }).__archeryTune : undefined;
    if ((this.#archerPose.active || this.#bowCarried) && (!this.#heldBow || t)) {
      // DEV: re-solve the grip every call so a probe can sweep offsets live
      const spec: GripSpec = t
        ? {
            position: [t.bx ?? ARCHER_BOW_GRIP.position[0], t.by ?? ARCHER_BOW_GRIP.position[1], t.bz ?? ARCHER_BOW_GRIP.position[2]],
            rotation: [t.brx ?? ARCHER_BOW_GRIP.rotation![0], t.bry ?? ARCHER_BOW_GRIP.rotation![1], t.brz ?? ARCHER_BOW_GRIP.rotation![2]]
          }
        : ARCHER_BOW_GRIP;
      this.#heldBow = attachToHand(this.#walkRig, "L", this.#bow, spec);
    }
    this.#bow.visible = this.#archerPose.active || this.#bowCarried;
  }

  /** Bow-in-hand while walking around the range (no pose override — the
   *  ordinary walk/idle animator keeps running, the left mitt just curls). */
  setBowCarried(on: boolean) {
    if (this.#bowCarried === on) {
      this.#bow.visible = on || this.#archerPose.active;
      return;
    }
    this.#bowCarried = on;
    if (on && !this.#heldBow) this.setArcherPose(this.#archerPose.active, this.#archerPose.draw, this.#archerPose.pitch);
    this.#bow.visible = on || this.#archerPose.active;
  }

  // ---- ball tool (the PlayerBallView backing FetchBall drives) ----

  /** Show/hide the held tennis ball and curl the right mitt over it. #animate
   *  is the true owner each frame; this just flips the state it reads. */
  setBallHeld(held: boolean) {
    this.#ballHeld = held;
    this.#ballProp.visible = held && this.mode === "walk";
    setHandPose(this.#walkRig, "R", held ? 1 : 0);
  }

  /** Carry a surfboard under the arm while on foot at the beach (visual only). */
  setCarryingBoard(on: boolean) {
    this.#carryBoard.visible = on && this.mode === "walk";
  }

  /** Windup→release arm swing, `t` 0..1 (0 = idle, adds nothing). #animate lays
   *  the overlay on top of the base walk/idle pose while t > 0. */
  setThrowAnim(t: number) {
    this.#throwT = THREE.MathUtils.clamp(t, 0, 1);
  }

  /** World position of the throwing (right) hand. Caller must have updated world
   *  matrices this frame (call after syncMesh). Writes into `out`, returns it. */
  handWorldPos(out: THREE.Vector3): THREE.Vector3 {
    return rigHandWorld(this.#walkRig, "R", out);
  }

  /** Additive baseball-style overhand: cock the ball behind the throwing ear,
   *  drive through a straight high release, then finish across the body.
   *  Deltas taper to 0 at both ends so the base pose shows through when idle. */
  #applyThrowSwing(r: Rig) {
    const t = this.#throwT;
    let armX: number, armY: number, armZ: number, foreX: number;
    let gloveX: number, gloveY: number, gloveZ: number, gloveForeX: number;
    let twist: number, lean: number, hipTwist: number, hipDrop: number;
    let strideL: number, strideR: number, kneeL: number, kneeR: number;
    if (t < 0.4) {
      // Pitcher set: elbow at shoulder height, forearm folded UP so the ball
      // sits behind the throwing ear. The old positive elbow bend folded the
      // hand down beside the ribs, which read as a side-arm push.
      const k = THREE.MathUtils.smoothstep(t, 0, 0.4);
      armX = -0.7 * k;
      armY = 0.35 * k;
      armZ = -1.8 * k;
      foreX = -1.5 * k;
      gloveX = 1.05 * k;
      gloveY = -0.18 * k;
      gloveZ = 1.1 * k;
      gloveForeX = 0.18 * k;
      twist = 0.68 * k;
      lean = -0.1 * k;
      hipTwist = 0.24 * k;
      hipDrop = 0.05 * k;
      strideL = 0.38 * k;
      strideR = -0.18 * k;
      kneeL = -0.45 * k;
      kneeR = -0.16 * k;
    } else if (t < 0.56) {
      // Elbow leads and the arm straightens into a genuinely overhead slot.
      // The ball leaves near the end of this phase, above and ahead of the head.
      const k = THREE.MathUtils.smoothstep(t, 0.4, 0.56);
      armX = THREE.MathUtils.lerp(-0.7, -0.8, k);
      armY = THREE.MathUtils.lerp(0.35, 0, k);
      armZ = THREE.MathUtils.lerp(-1.8, -2.6, k);
      foreX = THREE.MathUtils.lerp(-1.5, 0, k);
      gloveX = THREE.MathUtils.lerp(1.05, 0.55, k);
      gloveY = THREE.MathUtils.lerp(-0.18, -0.3, k);
      gloveZ = THREE.MathUtils.lerp(1.1, 0.25, k);
      gloveForeX = THREE.MathUtils.lerp(0.18, 1.2, k);
      twist = THREE.MathUtils.lerp(0.68, -0.18, k);
      lean = THREE.MathUtils.lerp(-0.1, 0.22, k);
      hipTwist = THREE.MathUtils.lerp(0.24, -0.22, k);
      hipDrop = THREE.MathUtils.lerp(0.05, 0.09, k);
      strideL = THREE.MathUtils.lerp(0.38, 0.85, k);
      strideR = THREE.MathUtils.lerp(-0.18, -0.35, k);
      kneeL = THREE.MathUtils.lerp(-0.45, -0.18, k);
      kneeR = THREE.MathUtils.lerp(-0.16, -0.12, k);
    } else if (t < 0.72) {
      // Pronate and pull the throwing hand across the lead side after release.
      const k = THREE.MathUtils.smoothstep(t, 0.56, 0.72);
      armX = THREE.MathUtils.lerp(-0.8, 1.5, k);
      armY = 0;
      armZ = THREE.MathUtils.lerp(-2.6, 1, k);
      foreX = THREE.MathUtils.lerp(0, 0.25, k);
      gloveX = THREE.MathUtils.lerp(0.55, 0.25, k);
      gloveY = THREE.MathUtils.lerp(-0.3, 0, k);
      gloveZ = THREE.MathUtils.lerp(0.25, 0.15, k);
      gloveForeX = THREE.MathUtils.lerp(1.2, 0.55, k);
      twist = THREE.MathUtils.lerp(-0.18, -0.58, k);
      lean = THREE.MathUtils.lerp(0.22, 0.34, k);
      hipTwist = THREE.MathUtils.lerp(-0.22, -0.38, k);
      hipDrop = THREE.MathUtils.lerp(0.09, 0.04, k);
      strideL = THREE.MathUtils.lerp(0.85, 0.55, k);
      strideR = THREE.MathUtils.lerp(-0.35, -0.16, k);
      kneeL = THREE.MathUtils.lerp(-0.18, -0.08, k);
      kneeR = THREE.MathUtils.lerp(-0.12, -0.06, k);
    } else {
      // Hold the finish for a beat, then hand control back to walk/idle.
      const k = THREE.MathUtils.smoothstep(t, 0.72, 1);
      const relax = 1 - k;
      armX = 1.5 * relax;
      armY = 0;
      armZ = 1 * relax;
      foreX = 0.25 * relax;
      gloveX = 0.25 * relax;
      gloveY = 0;
      gloveZ = 0.15 * relax;
      gloveForeX = 0.55 * relax;
      twist = -0.58 * relax;
      lean = 0.34 * relax;
      hipTwist = -0.38 * relax;
      hipDrop = 0.04 * relax;
      strideL = 0.55 * relax;
      strideR = -0.16 * relax;
      kneeL = -0.08 * relax;
      kneeR = -0.06 * relax;
    }
    r.armR.rotation.x += armX;
    r.armR.rotation.y += armY;
    r.armR.rotation.z += armZ;
    r.foreR.rotation.x += foreX;
    r.armL.rotation.x += gloveX;
    r.armL.rotation.y += gloveY;
    r.armL.rotation.z += gloveZ;
    r.foreL.rotation.x += gloveForeX;
    r.torso.rotation.y += twist;
    r.torso.rotation.x += lean;
    r.head.rotation.y += twist * 0.35;
    r.hips.rotation.y += hipTwist;
    r.hips.position.y -= hipDrop;
    r.legL.rotation.x += strideL;
    r.legR.rotation.x += strideR;
    r.shinL.rotation.x += kneeL;
    r.shinR.rotation.x += kneeR;
  }

  /** Board airborne state — the hoverboard hum softens in the air. */
  get boardGrounded(): boolean {
    return this.#modes.board.grounded;
  }

  /** True while the walk controller has you in the bay (drives swim audio / pose). */
  get swimming(): boolean {
    return this.mode === "walk" && this.#modes.walk.swimming;
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
   * Swap what "drive" means: the mesh (a ridden animal from the forest, or null
   * for the default sports car) and the matching body/handling spec. Takes effect
   * on the next drive body spawn.
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

  /** Swap the drone mesh for a custom flyer. Null restores the stock drone. */
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

  /** Restore the stock camera drone after a custom flyer style. */
  clearDroneStyle() {
    if (this.meshes.drone !== this.#defaultDroneMesh) this.setDroneStyle(null);
  }

  /**
   * Rebuild the hoverboard from a customizer config, in place: the new mesh
   * adopts the old one's transform (no pop while riding) and the rider rig —
   * whose stance transform lives on its own group — moves across untouched.
   */
  setBoardConfig(config: BoardConfig) {
    const old = this.meshes.board;
    const next = buildBoardMesh(config);
    next.position.copy(old.position);
    next.quaternion.copy(old.quaternion);
    // the rider rig is shared with the broom drone style — only re-seat it if
    // the broom doesn't currently own it, and restore the surf stance (the
    // broom writes its own offsets onto the same group)
    if (!this.#broomRigAttached) {
      this.#riderRig.group.removeFromParent();
      this.#riderRig.group.rotation.order = "ZYX";
      this.#riderRig.group.rotation.set(0, 1.05, 0);
      this.#riderRig.group.position.set(0, 0.93, 0);
      next.add(this.#riderRig.group);
    }
    setEmbodimentVisible(old, false);
    this.#scene.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    this.#scene.add(next);
    this.meshes.board = next;
    setEmbodimentVisible(next, this.mode === "board");
    if (this.mode === "board") this.#lightPool.claim(next);
  }

  /** Rebuild both the ridden and carried surfboards from one identity. */
  setSurfboardConfig(config: SurfboardConfig) {
    this.#modes.surf.setConfig(config);

    const old = this.meshes.surf;
    const next = buildSurfboardMesh(config);
    next.position.copy(old.position);
    next.quaternion.copy(old.quaternion);
    this.#surfRig.group.removeFromParent();
    this.#surfRig.group.rotation.order = "ZYX";
    this.#surfRig.group.rotation.set(0, 1.05, 0);
    this.#surfRig.group.position.set(0, 0.93, 0);
    next.add(this.#surfRig.group);
    setEmbodimentVisible(old, false);
    this.#scene.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    this.#scene.add(next);
    this.meshes.surf = next;
    setEmbodimentVisible(next, this.mode === "surf");
    if (this.mode === "surf") {
      this.#lightPool.claim(next);
      void activateSurfboardAssets(next);
    }

    const oldCarry = this.#carryBoard;
    const carry = buildSurfboardMesh(config);
    carry.scale.setScalar(0.82);
    carry.position.set(0.62, 1.0, -0.05);
    carry.rotation.set(0.05, 0, Math.PI * 0.52);
    carry.visible = oldCarry.visible;
    this.meshes.walk.remove(oldCarry);
    (oldCarry.userData.dispose as (() => void) | undefined)?.();
    this.meshes.walk.add(carry);
    this.#carryBoard = carry;
  }

  /** Rebuild the cosmetic scooter shell without disturbing its live pose. */
  setScooterConfig(config: ScooterConfig) {
    const old = this.meshes.scooter;
    const next = buildScooterMesh(config);
    next.position.copy(old.position);
    next.quaternion.copy(old.quaternion);
    this.#scooterRig.group.removeFromParent();
    const cockpit = next.userData.cockpit as Cockpit;
    this.#scooterRig.group.position.set(...cockpit.seat);
    this.#scooterRig.group.rotation.set(0, 0, 0);
    next.add(this.#scooterRig.group);
    setEmbodimentVisible(old, false);
    this.#scene.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    this.#scene.add(next);
    this.meshes.scooter = next;
    setEmbodimentVisible(next, this.mode === "scooter");
    if (this.mode === "scooter") this.#lightPool.claim(next);
  }

  /** Lightweight local-only preview used while the deck XY pad is held. */
  previewBoardSurface(config: BoardConfig) {
    updateBoardSurface(this.meshes.board, config);
  }

  /** Lightweight local preview; shape clicks commit through setSurfboardConfig. */
  previewSurfboardSurface(config: SurfboardConfig) {
    updateSurfboardSurface(this.meshes.surf, config);
    updateSurfboardSurface(this.#carryBoard, config);
    this.#modes.surf.setConfig(config);
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
    if (this.mode !== "walk") applyBallGlow(this.#ballMaterial, 0);
    if (this.mode === "walk") {
      const r = this.#walkRig;
      const walk = this.#modes.walk;
      const golfing = this.#golfPose.active && walk.grounded && !walk.swimming;
      const archering = !golfing && this.#archerPose.active && walk.grounded && !walk.swimming;
      // golf stance shift: the rig root (not the capsule) eases sideways to
      // stand beside the ball, and eases home again when the pose drops
      if (golfing && this.#golfAddressSet) {
        V.tmp.copy(this.#golfAddress).sub(this.renderPosition);
        V.tmp.y = 0;
        V.tmp.applyQuaternion(V.quat.copy(this.meshes.walk.quaternion).invert());
        if (V.tmp.lengthSq() > 2.6 * 2.6) V.tmp.setLength(2.6);
      } else {
        V.tmp.set(0, 0, 0);
      }
      this.#golfMeshShift.lerp(V.tmp, 1 - Math.exp(-dt * 9));
      r.group.position.set(this.#golfMeshShift.x, 0, this.#golfMeshShift.z);
      // both mitts curl over the grip while golfing; the right mitt also curls
      // over a held tennis ball. #ballHeld owns the ball prop's visibility since
      // setEmbodimentVisible re-shows every walk mesh whenever we return on foot.
      // the left mitt also wraps a held bow (archery); the string hand curls
      // only while actually pulling
      setHandPose(r, "L", golfing || archering || this.#bowCarried ? 1 : 0);
      setHandPose(r, "R", golfing || this.#ballHeld || (archering && this.#archerPose.draw > 0.05) ? 1 : 0);
      if (!golfing && !archering) {
        // only poseGolf/poseArcher rotate the wrist groups; neutralise them
        // here so the last swing frame doesn't linger into walk/idle
        r.handL.rotation.set(0, 0, 0);
        r.handR.rotation.set(0, 0, 0);
      }
      this.#ballProp.visible = this.#ballHeld;
      applyBallGlow(this.#ballMaterial, this.#ballHeld ? undefined : 0);
      if (golfing) {
        poseGolf(r, this.#golfPose.swing);
      } else if (archering) {
        poseArcher(r, this.#archerPose.draw, this.#archerPose.pitch);
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
      // throw swing: an additive overlay on the right arm + torso, layered AFTER
      // the base pose so it rides on top of walk/idle without a dedicated pose fn.
      if (this.#throwT > 0 && !golfing) this.#applyThrowSwing(r);
    } else if (this.mode === "board") {
      const board = this.#modes.board;
      const crouch = Math.min(1, this.speed / BOARD_TUNING.values.boostMaxSpeed + Math.abs(board.lean) * 0.6);
      poseRide(this.#riderRig, board.lean, crouch, !board.grounded, this.#animT);
      this.#riderRig.group.rotation.z = board.lean * 0.4; // whole-body dip on top of the deck roll
      animateBoard(this.meshes.board, dt, this.#animT, board.horizontalSpeed, board.boosting);
    } else if (this.mode === "surf") {
      const surf = this.#modes.surf;
      const paddling = surf.telemetry.phase === "paddle";
      const crouch = paddling
        ? 1 // hunched low over the deck while paddling
        : Math.min(1, this.speed / SURF_TUNING.values.maxTrim + Math.abs(surf.lean) * 0.5);
      poseRide(this.#surfRig, surf.lean, crouch, !surf.grounded, this.#animT);
      this.#surfRig.group.rotation.z = surf.lean * 0.34;
      // lean forward onto the board while paddling out
      this.#surfRig.group.rotation.x = paddling ? 0.6 : 0;
      animateSurfboard(this.meshes.surf, dt, this.#animT);
    } else if (this.mode === "scooter") {
      const scooter = this.#modes.scooter;
      const airborne = scooter.jumpDebug.airborne;
      poseScooter(this.#scooterRig, scooter.steerVis, this.#animT, airborne);
      animateScooter(
        this.meshes.scooter,
        dt,
        Math.hypot(this.velocity.x, this.velocity.z),
        scooter.steerVis,
        this.speed > 34
      );
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
    } else if (this.mode === "speedboat") {
      const steer = this.#modes.speedboat.steerVis;
      poseDrive(this.#speedRig, steer, this.#animT, true);
      this.#speedWheel.spin.rotation.z = steer * 2.3;
    }
  }

  get aimOrigin(): THREE.Vector3 {
    return V.tmp2.copy(this.position).add(V.tmp.set(0, this.mode === "plane" || this.mode === "drone" || this.mode === "bird" ? 0 : 1.4, 0));
  }
}
