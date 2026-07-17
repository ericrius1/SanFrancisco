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
  poseSurfRide,
  poseScooter,
  poseSwim,
  poseWalk,
  rigHandWorld,
  HAND_GRIP,
  setHandPose,
  type Rig
} from "./rig";
import {
  attachToHand,
  buildBow,
  buildGolfClub,
  secondHandCurl,
  wristTargetForGrip,
  GOLF_CLUB_GRIP,
  type GripSpec,
  type HeldItem
} from "./held";
import { setHandTarget } from "./handIK";
import type { GardenRakeMotion, GardenRakeTool } from "./gardenRake";
import { ARCHER_BOW_GRIP, poseArcher } from "../gameplay/archery/poses";
import { avatarFromSeed, normalizeAvatarTraits, type AvatarTraits } from "./avatar";
import { DEFAULT_DRIVE_SPEC, type Cockpit, type DriveSpec, type PlayerMode } from "./types";
import { WalkController, WALK_CAPSULE_HALF_EXTENT, WALK_TUNING } from "./walk";
import { LightPool } from "./lightPool";
import {
  applyBallGlow,
  prepareBallGlowMaterial,
  TENNIS_BALL_COLOR
} from "../fx/ballGlow";
import {
  activateCarAssets,
  animateCar,
  buildCarMesh,
  previewCarConfig as previewCarAppearance,
  updateCarLights,
  CarController,
  type CarConfig
} from "../vehicles/car";
import { buildPlaneMesh, collectPlaneAnim, FlyController, type PlaneAnim } from "../vehicles/plane";
import { buildBoatMesh, buildSpeedboatMesh, BoatController, BOAT_TUNING, SPEEDBOAT_TUNING, type BoatSailRig } from "../vehicles/boat";
import { buildDroneMesh, DroneController } from "../vehicles/drone";
import { buildBoardMesh, activateBoardSurface, animateBoard, updateBoardSurface, BoardController, BOARD_TUNING, type BoardConfig } from "../vehicles/board";
import {
  activateSurfboardAssets,
  animateSurfboard,
  buildSurfboardMesh,
  updateSurfboardSurface,
  SurfController,
  SURFBOARD_FLAT_DECK_TOP,
  SURF_TUNING,
  type SurfboardConfig,
  type SurfTelemetry
} from "../vehicles/surf";
import {
  activateScooterAssets,
  animateScooter,
  buildScooterMesh,
  previewScooterConfig as previewScooterAppearance,
  ScooterController,
  type ScooterConfig
} from "../vehicles/scooter";
import { activateBirdAssets, buildBirdMesh, BirdController } from "../vehicles/bird";
import { setEmbodimentVisible } from "./embodimentVisibility";

export type { GardenRakeMotion, GardenRakeTool } from "./gardenRake";

const V = {
  tmp: new THREE.Vector3(),
  tmp2: new THREE.Vector3(),
  up: new THREE.Vector3(0, 1, 0),
  quat: new THREE.Quaternion()
};

const SURF_FOOT = {
  boardInverse: new THREE.Matrix4(),
  soleToBoard: new THREE.Matrix4(),
  corner: new THREE.Vector3()
};

function soleBottomInBoardSpace(sole: THREE.Mesh, board: THREE.Object3D): number {
  const geometry = sole.geometry;
  if (!geometry.boundingBox) geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return Number.NaN;

  board.updateWorldMatrix(true, false);
  sole.updateWorldMatrix(true, false);
  SURF_FOOT.boardInverse.copy(board.matrixWorld).invert();
  SURF_FOOT.soleToBoard.multiplyMatrices(SURF_FOOT.boardInverse, sole.matrixWorld);

  let minY = Number.POSITIVE_INFINITY;
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        SURF_FOOT.corner.set(x, y, z).applyMatrix4(SURF_FOOT.soleToBoard);
        minY = Math.min(minY, SURF_FOOT.corner.y);
      }
    }
  }
  return minY;
}

const GARDEN_RAKE_DEFAULT_ELEVATION = THREE.MathUtils.degToRad(55);
const GARDEN_RAKE_CARRY_ELEVATION = THREE.MathUtils.degToRad(78);
const GARDEN_RAKE_DEFAULT_BODY_LEAN = 0.34;
const GARDEN_RAKE_LEGACY_SAND_LIFT = 0.12;
const GARDEN_RAKE_LEGACY_CONTACT_FORWARD = 1.44;
const GARDEN_RAKE_GRIP_TILT = -Math.atan2(0.5, 1.52);

// One local player, one rake. All per-frame pose math reuses this scratch so
// dragging a GPU brush never creates a parallel stream of short-lived vectors.
const RAKE = {
  localAcross: new THREE.Vector3(),
  localShaft: new THREE.Vector3(),
  localBinormal: new THREE.Vector3(),
  pull: new THREE.Vector3(),
  normal: new THREE.Vector3(),
  across: new THREE.Vector3(),
  shaft: new THREE.Vector3(),
  binormal: new THREE.Vector3(),
  contact: new THREE.Vector3(),
  rootPosition: new THREE.Vector3(),
  offset: new THREE.Vector3(),
  gripPosition: new THREE.Vector3(),
  gripAim: new THREE.Quaternion(),
  wristTarget: new THREE.Vector3(),
  elbowPole: new THREE.Vector3(),
  worldQuaternion: new THREE.Quaternion(),
  localBasis: new THREE.Matrix4(),
  localBasisInverse: new THREE.Matrix4(),
  worldBasis: new THREE.Matrix4(),
  rotationMatrix: new THREE.Matrix4(),
  desiredWorld: new THREE.Matrix4(),
  parentInverse: new THREE.Matrix4(),
  localMatrix: new THREE.Matrix4(),
  rootInverse: new THREE.Matrix4(),
  unitScale: new THREE.Vector3(1, 1, 1),
  forwardLocal: new THREE.Vector3(0, 0, -1),
  halfTurnX: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI)
};

// A missed streamed-surface handoff must degrade into a short reset, never an
// endless fall. Large enough not to catch normal jumps or steep-slope travel.
const WALK_BELOW_GROUND_RECOVERY_DEPTH = 12;

/** DEV-only live golf-pose tuning (window.__golfTune), consumed by the golf
 *  grip + poseGolf so tools/golf-pose-probe.mjs can sweep in one boot. The
 *  old chest-pivot keys (pivotY/pivotZ/pivotAX/raise/swingZ) died with the
 *  pivot — the club is now solved into the lead hand via attachToHand, so the
 *  tunables are the item-local grip point/orientation instead. */
type GolfTune = { gripX?: number; gripY?: number; gripZ?: number; gripRX?: number; gripRY?: number; gripRZ?: number; hinge?: number };

/** DEV-only live archery bow-grip tuning (window.__archeryTune) — same idea
 *  as GolfTune: presence re-solves the attach every setArcherPose call. */
type ArcheryTune = { bx?: number; by?: number; bz?: number; brx?: number; bry?: number; brz?: number };

/** Carried surfboard grip: item space is X = width (rail to rail), Y = thin
 *  deck normal, Z = length with the nose at -Z (see buildSurfboardMesh — same
 *  -Z-front convention as the avatar). The grip point sits near the rail at
 *  board centre; rotating +90° about item-local X (the axis that stays put as
 *  the hand's grip-bar axis) swings the length axis (Z) up into the hand's
 *  local +Y — nose up, tucked against the body — while leaving the thin deck
 *  normal facing fore/aft, edge toward the camera, like a board under the arm. */
const CARRY_BOARD_GRIP: GripSpec = {
  position: [0.4, 0.04, 0],
  rotation: [Math.PI / 2, 0, 0]
};
const CARRY_BOARD_SCALE = 0.82; // matches the old fixed-offset prop's scale

// Put only the ridden surf embodiment into the transparent queue after the
// base/contact water and before the barrel roof. Transparent renderOrder stays
// ascending even when the renderer uses a reversed-depth buffer.
const SURF_HERO_RENDER_ORDER = 13;

function prepareLocalSurfHero(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const landingFoam = object.userData.surfLandingFoam === true;
    object.renderOrder = landingFoam ? 17 : SURF_HERO_RENDER_ORDER;
    if (landingFoam) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      material.transparent = true;
      material.opacity = 1;
      material.depthTest = true;
      material.depthWrite = true;
      material.needsUpdate = true;
    }
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
  /** Set by main from the indoor camera gate; walk/run scale by indoorSpeed. */
  indoor = false;
  /** True while carrying the garden rake; walk/run drop to a deliberate half pace. */
  raking = false;

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
  #arrivalHolds = new Set<string>();
  #arrivalHoldPosition = new THREE.Vector3();
  #arrivalHoldQuaternion = new THREE.Quaternion();

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
  // + prop visibility are driven every walk frame in #animate; embodiment mode
  // visibility is root-only and deliberately preserves these child-owned states.
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
  #phoenixRiderRig: Rig; // front saddle seat; two friends attach over the network
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
  #heldCarryBoard: HeldItem | null = null; // grip attachment into the walk rig's hand
  #carryingBoard = false; // true once setCarryingBoard(true) has ever attached the board
  #gardenRakeTool: GardenRakeTool | null = null;
  #gardenRakeLegacy = false;
  #gardenRaking = false;
  #gardenRakeMotion: GardenRakeMotion = {
    engaged: false,
    dragging: false,
    contactX: 0,
    contactY: 0,
    contactZ: 0,
    pullX: 0,
    pullZ: -1,
    normalX: 0,
    normalY: 1,
    normalZ: 0,
    shaftElevation: GARDEN_RAKE_DEFAULT_ELEVATION,
    bodyLean: GARDEN_RAKE_DEFAULT_BODY_LEAN
  };
  #gardenRakeContactLocal = new THREE.Vector3();
  #gardenRakeRightGripLocal = new THREE.Vector3();
  #gardenRakeLocalAcross = new THREE.Vector3(1, 0, 0);
  #gardenRakeLocalShaft = new THREE.Vector3(0, 1.52, -0.5).normalize();
  #gardenRakeLastPull = new THREE.Vector3(0, 0, -1);
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
    spawn: { x: number; y?: number; z: number; heading: number },
    avatar: AvatarTraits = avatarFromSeed("local-default"),
    board?: BoardConfig,
    scooter?: ScooterConfig,
    surfboard?: SurfboardConfig,
    car?: CarConfig
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
    // Physical surface can receive when its glow is dimmed; the held-ball glow
    // deliberately does not become another tiny animated shadow caster.
    this.#ballProp.receiveShadow = true;
    this.#ballProp.position.set(0, -0.02, -0.05); // cupped in the curled fingers
    this.#ballProp.visible = false;
    this.#walkRig.handR.add(this.#ballProp);
    this.meshes = {
      walk: walkGroup,
      drive: buildCarMesh(car),
      scooter: buildScooterMesh(scooter),
      plane: buildPlaneMesh(),
      boat: buildBoatMesh(),
      speedboat: buildSpeedboatMesh(),
      drone: buildDroneMesh(),
      // The board is invisible in the ordinary walking boot. Its selected
      // procedural deck art hydrates in a worker only if board mode is used.
      board: buildBoardMesh(board, { deferSurface: true }),
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
    prepareLocalSurfHero(this.meshes.surf);
    // A surfboard tucked upright under the arm, shown on foot at the beach so
    // you arrive holding your board, ready to start the surf activity. Built here but not
    // parented yet — setCarryingBoard grips it into the walk rig's hand (the
    // golf-club/bow pattern) on first use, so it swings with the arm instead
    // of floating at a fixed offset off the mesh root.
    this.#carryBoard = buildSurfboardMesh(surfboard);
    this.#carryBoard.visible = false;
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
    this.#phoenixRiderRig = buildRig(this.#avatar);
    this.#phoenixRiderRig.group.name = "phoenix_local_rider";
    const birdSeat = (this.meshes.bird.userData.cockpit as Cockpit).seat;
    this.#phoenixRiderRig.group.position.set(...birdSeat);
    this.#phoenixRiderRig.group.visible = false;
    this.meshes.bird.add(this.#phoenixRiderRig.group);
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
    this.position.set(spawn.x, spawn.y ?? map.effectiveGround(spawn.x, spawn.z) + 1.5, spawn.z);
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
    applyAvatarToRig(this.#phoenixRiderRig, this.#avatar);
  }

  /** Snapshot used by activity-owned embodiment rigs without exposing mutable player state. */
  get avatarTraits(): AvatarTraits {
    return { ...this.#avatar };
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
  #spawnBody(mode: PlayerMode, facing = this.heading - Math.PI, exactBodyY?: number) {
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
    const bodyY = exactBodyY ?? placedY;
    w.setBodyTransform(this.body, [p.x, bodyY, p.z], q);
    if (exactBodyY !== undefined) p.y = bodyY;
    // reset the interpolation history so a teleport/mode switch doesn't smear
    this.quaternion.set(q[0], q[1], q[2], q[3]);
    this.#currPosition.set(p.x, bodyY, p.z);
    this.#currQuaternion.copy(this.quaternion);
    this.#prevPosition.copy(this.#currPosition);
    this.#prevQuaternion.copy(this.quaternion);
    this.renderPosition.copy(this.#currPosition);
    this.renderQuaternion.copy(this.quaternion);
    if (this.worldArrivalHeld) {
      this.#arrivalHoldPosition.copy(this.#currPosition);
      this.#arrivalHoldQuaternion.copy(this.quaternion);
      w.setBodyVelocity(this.body, [0, 0, 0], [0, 0, 0]);
    }
    // keep the storage convention from the first frame, not just after an update
    this.heading = facing + Math.PI;
    for (const [k, m] of Object.entries(this.meshes)) {
      setEmbodimentVisible(m, k === mode);
    }
    // Surf art is intentionally absent from boot. The active board requests
    // only its selected surface/decal the first time surfing actually starts.
    if (mode === "surf") void activateSurfboardAssets(this.meshes.surf);
    if (mode === "board") void activateBoardSurface(this.meshes.board);
    if (mode === "scooter") void activateScooterAssets(this.meshes.scooter);
    if (mode === "drive" && this.meshes.drive === this.#defaultDriveMesh) void activateCarAssets(this.meshes.drive);
    // Imported phoenix geometry/plumage is likewise first-use only. The stable
    // root and controller already exist, so switching remains synchronous while
    // the visual asset hydrates into that root.
    if (mode === "bird") void activateBirdAssets(this.meshes.bird);
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

  /**
   * Claim a nearby world mount without running its menu-entry relocation. In
   * particular, boarding a grounded Phoenix must preserve its waiting body
   * height instead of invoking BirdController.enter() and jumping to cruise.
   */
  boardMount(pose: { mode: PlayerMode; x: number; y: number; z: number; heading: number }) {
    if (pose.mode === this.mode) return;
    this.position.set(pose.x, pose.y, pose.z);
    this.#spawnBody(pose.mode, pose.heading - Math.PI, pose.y);
  }

  /** Landmark teleport landing — always on foot. Callers should exitToWalk first
   *  so surf/vehicles leave an abandoned mount and fire mode-change cleanup. */
  respawn(spawn: { x: number; y?: number; z: number; heading: number }) {
    this.position.set(spawn.x, spawn.y ?? this.map.effectiveGround(spawn.x, spawn.z) + 1.5, spawn.z);
    this.#spawnBody("walk", spawn.heading);
  }

  /**
   * Pin the authoritative body while a world arrival streams its local safety
   * collision. The renderer and the rest of the world remain live, but neither
   * gravity nor held movement input can move the player into an incomplete
   * collision neighbourhood. Body recreation during the arrival (walk landing,
   * remote-mode join) refreshes the pin in #spawnBody.
   */
  holdForWorldArrival(reason = "world-arrival"): void {
    this.#arrivalHolds.add(reason);
    if (!this.body || this.riding) return;
    const t = this.physics.world.getBodyTransform(this.body);
    this.#arrivalHoldPosition.set(t.position[0], t.position[1], t.position[2]);
    this.#arrivalHoldQuaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    this.#applyArrivalHold();
  }

  releaseWorldArrivalHold(reason = "world-arrival"): void {
    if (!this.#arrivalHolds.has(reason)) return;
    if (this.body && !this.riding) this.#applyArrivalHold();
    this.#arrivalHolds.delete(reason);
  }

  get worldArrivalHeld(): boolean {
    return this.#arrivalHolds.size > 0;
  }

  #applyArrivalHold(): void {
    if (!this.body || this.riding) return;
    const w = this.physics.world;
    const p = this.#arrivalHoldPosition;
    const q = this.#arrivalHoldQuaternion;
    w.setBodyTransform(this.body, [p.x, p.y, p.z], [q.x, q.y, q.z, q.w]);
    w.setBodyVelocity(this.body, [0, 0, 0], [0, 0, 0]);
    w.setBodyAwake(this.body, true);
    this.position.copy(p);
    this.renderPosition.copy(p);
    this.#currPosition.copy(p);
    this.#prevPosition.copy(p);
    this.quaternion.copy(q);
    this.renderQuaternion.copy(q);
    this.#currQuaternion.copy(q);
    this.#prevQuaternion.copy(q);
    this.velocity.set(0, 0, 0);
    this.speed = 0;
  }

  /**
   * Complete a streamed walk-surface handoff without recreating the body. This
   * is intentionally lift-only: visitors already above the floor keep their
   * jump/fall, while a capsule caught underneath a newly loaded surface is
   * placed exactly on top with interpolation and downward velocity reset.
   */
  recoverOntoWalkSurface(surfaceY: number): boolean {
    if (this.mode !== "walk" || this.riding || !this.body || !Number.isFinite(surfaceY)) return false;
    const w = this.physics.world;
    const t = w.getBodyTransform(this.body);
    const minY = surfaceY + WALK_CAPSULE_HALF_EXTENT + 0.02;
    if (t.position[1] >= minY) return false;
    const v = w.getBodyVelocity(this.body);
    const position: [number, number, number] = [t.position[0], minY, t.position[2]];
    w.setBodyTransform(this.body, position, t.rotation);
    w.setBodyVelocity(this.body, [v.linear[0], 0, v.linear[2]], [0, 0, 0]);
    w.setBodyAwake(this.body, true);

    this.position.set(...position);
    this.renderPosition.copy(this.position);
    this.#currPosition.copy(this.position);
    this.#prevPosition.copy(this.position);
    this.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    this.renderQuaternion.copy(this.quaternion);
    this.#currQuaternion.copy(this.quaternion);
    this.#prevQuaternion.copy(this.quaternion);
    this.velocity.set(v.linear[0], 0, v.linear[2]);
    return true;
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
    if (this.worldArrivalHeld || this.riding || this.mode !== "walk" || !this.body) return;
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
    this.#lightPool.update(this.renderPosition.x, this.renderPosition.z);
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
    if (this.worldArrivalHeld) {
      this.#applyArrivalHold();
      return;
    }
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

    if (
      this.mode === "walk" &&
      this.position.y < this.map.baseGroundTop(this.position.x, this.position.z) - WALK_BELOW_GROUND_RECOVERY_DEPTH
    ) {
      this.respawn({ x: this.position.x, z: this.position.z, heading: this.heading - Math.PI });
      return;
    }

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

  /** Exact sole-to-deck gaps used by surf QA and cinematic regression checks. */
  get surfFootDeckClearance(): { left: number; right: number } {
    return {
      left: soleBottomInBoardSpace(this.#surfRig.soleL, this.meshes.surf) - SURFBOARD_FLAT_DECK_TOP,
      right: soleBottomInBoardSpace(this.#surfRig.soleR, this.meshes.surf) - SURFBOARD_FLAT_DECK_TOP
    };
  }

  requestWalkJump() {
    if (this.mode === "walk") this.#modes.walk.requestJump();
  }

  /** Air/landing state for probes and the window.__sf diagnostics surface. */
  get driveJumpState() {
    return this.#modes.drive.jumpDebug;
  }

  /** One-shot landing telemetry; main owns the camera/audio/VFX consumers. */
  get driveLandingFeedback() {
    return this.#modes.drive.landingFeedback;
  }

  /** Continuous skid intensity for tire marks + audio (drive or scooter). */
  get driveSlideFeedback() {
    return this.mode === "scooter"
      ? this.#modes.scooter.slideFeedback
      : this.#modes.drive.slideFeedback;
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

  /** Carry a surfboard under the arm while on foot at the beach (visual only).
   *  Grips into the walk rig's right hand on first use (attach once, toggle
   *  visibility after — the golf-club/bow pattern) so it tracks the arm. */
  setCarryingBoard(on: boolean) {
    if (on && !this.#heldCarryBoard) {
      this.#heldCarryBoard = attachToHand(this.#walkRig, "R", this.#carryBoard, CARRY_BOARD_GRIP);
      this.#carryBoard.scale.multiplyScalar(CARRY_BOARD_SCALE);
    }
    this.#carryingBoard = on;
    this.#carryBoard.visible = on && this.mode === "walk";
  }

  /**
   * Take/release an activity-owned rake. Unlike single-hand props, the rake is
   * parented to the walk root: its tine contact owns the tool transform and both
   * hands reach to it. On release the activity immediately reparents `root` to
   * its rack, so this method deliberately leaves it detached.
   */
  setGardenRakeTool(tool: GardenRakeTool | null) {
    if (tool === this.#gardenRakeTool) {
      if (tool) tool.root.visible = this.mode === "walk";
      return;
    }

    const previous = this.#gardenRakeTool;
    this.#gardenRakeTool = null;
    if (previous) previous.root.removeFromParent();
    this.#gardenRakeLegacy = false;
    this.#gardenRaking = false;
    this.#gardenRakeMotion.engaged = false;
    this.#gardenRakeMotion.dragging = false;

    if (!tool) {
      this.raking = false;
      this.#walkRig.hips.position.z = 0;
      this.#walkRig.handL.rotation.set(0, 0, 0);
      this.#walkRig.handR.rotation.set(0, 0, 0);
      setHandPose(this.#walkRig, "L", 0);
      setHandPose(this.#walkRig, "R", 0);
      return;
    }

    // Snapshot the authored anchors in root-local space before reparenting. It
    // remains correct for nested anchors and for a rack with its own transform.
    tool.root.updateWorldMatrix(true, true);
    RAKE.rootInverse.copy(tool.root.matrixWorld).invert();
    tool.contact.getWorldPosition(this.#gardenRakeContactLocal).applyMatrix4(RAKE.rootInverse);
    tool.rightGrip.getWorldPosition(this.#gardenRakeRightGripLocal).applyMatrix4(RAKE.rootInverse);

    const across = tool.localAcross ?? [1, 0, 0];
    const shaft = tool.localShaft ?? [0, 1.52, -0.5];
    this.#gardenRakeLocalAcross.set(across[0], across[1], across[2]);
    if (this.#gardenRakeLocalAcross.lengthSq() < 1e-6) this.#gardenRakeLocalAcross.set(1, 0, 0);
    this.#gardenRakeLocalAcross.normalize();
    this.#gardenRakeLocalShaft.set(shaft[0], shaft[1], shaft[2]);
    this.#gardenRakeLocalShaft.addScaledVector(
      this.#gardenRakeLocalAcross,
      -this.#gardenRakeLocalShaft.dot(this.#gardenRakeLocalAcross)
    );
    if (this.#gardenRakeLocalShaft.lengthSq() < 1e-6) this.#gardenRakeLocalShaft.set(0, 1, 0);
    this.#gardenRakeLocalShaft.normalize();

    this.#gardenRakeTool = tool;
    this.raking = true;
    tool.root.removeFromParent();
    tool.root.matrixAutoUpdate = true;
    tool.root.scale.setScalar(1);
    this.meshes.walk.add(tool.root);
    tool.root.visible = this.mode === "walk";
  }

  /** Copy a reusable sand-contact packet; Player never retains the caller's object. */
  setGardenRakeMotion(motion: Readonly<GardenRakeMotion> | null) {
    this.#gardenRakeLegacy = false;
    const target = this.#gardenRakeMotion;
    if (!motion) {
      target.engaged = false;
      target.dragging = false;
      return;
    }
    const number = (value: number | undefined, fallback: number) =>
      value !== undefined && Number.isFinite(value) ? value : fallback;
    target.engaged = motion.engaged;
    target.dragging = motion.dragging;
    target.contactX = number(motion.contactX, target.contactX);
    target.contactY = number(motion.contactY, target.contactY);
    target.contactZ = number(motion.contactZ, target.contactZ);
    target.pullX = number(motion.pullX, target.pullX);
    target.pullZ = number(motion.pullZ, target.pullZ);
    target.normalX = number(motion.normalX, 0);
    target.normalY = number(motion.normalY, 1);
    target.normalZ = number(motion.normalZ, 0);
    target.shaftElevation = number(motion.shaftElevation, GARDEN_RAKE_DEFAULT_ELEVATION);
    target.bodyLean = number(motion.bodyLean, GARDEN_RAKE_DEFAULT_BODY_LEAN);
  }

  /**
   * Temporary compatibility for the old bare-Group callback. It adds invisible
   * authoring anchors at the current rake geometry's exact grip/contact points;
   * new callers should construct and pass a GardenRakeTool directly.
   */
  setGardenRake(rake: THREE.Group | null) {
    if (!rake) {
      this.setGardenRakeTool(null);
      return;
    }
    const anchor = (name: string) => {
      const existing = rake.getObjectByName(name);
      if (existing) return existing;
      const created = new THREE.Object3D();
      created.name = name;
      rake.add(created);
      return created;
    };
    const contact = anchor("garden_rake_tine_contact");
    contact.position.set(0, -1.777, 0.54);
    contact.quaternion.identity();
    const rightGrip = anchor("garden_rake_grip_right");
    rightGrip.position.set(0, -0.456, 0.15);
    rightGrip.rotation.set(GARDEN_RAKE_GRIP_TILT, 0, Math.PI / 2);
    const leftGrip = anchor("garden_rake_grip_left");
    leftGrip.position.set(0, -0.182, 0.06);
    leftGrip.quaternion.copy(rightGrip.quaternion).multiply(RAKE.halfTurnX);
    this.setGardenRakeTool({
      root: rake,
      contact,
      rightGrip,
      leftGrip,
      localAcross: [1, 0, 0],
      localShaft: [0, 1.52, -0.5]
    });
    this.#gardenRakeLegacy = true;
  }

  /** Temporary boolean alias; the exact-motion integration supersedes it. */
  setGardenRaking(active: boolean) {
    this.#gardenRaking = active && !!this.#gardenRakeTool && this.mode === "walk";
    if (this.#gardenRakeLegacy) {
      this.#gardenRakeMotion.engaged = this.#gardenRaking;
      this.#gardenRakeMotion.dragging = this.#gardenRaking;
    }
  }

  /** Synthesize the old callback's missing contact/normal until main is rewired. */
  #updateLegacyGardenRakeMotion() {
    const motion = this.#gardenRakeMotion;
    motion.engaged = this.#gardenRaking;
    motion.dragging = this.#gardenRaking;
    if (!this.#gardenRaking) return;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed > 0.05) {
      // `pull` is the shaft's head→player direction. While pushing, that is
      // opposite the avatar/tool travel direction.
      RAKE.pull.set(-this.velocity.x / speed, 0, -this.velocity.z / speed);
    } else {
      this.meshes.walk.getWorldQuaternion(RAKE.gripAim);
      RAKE.pull.copy(RAKE.forwardLocal).applyQuaternion(RAKE.gripAim).setY(0).normalize().negate();
    }
    this.#gardenRakeLastPull.copy(RAKE.pull);
    motion.pullX = RAKE.pull.x;
    motion.pullZ = RAKE.pull.z;
    motion.contactX = this.renderPosition.x - RAKE.pull.x * GARDEN_RAKE_LEGACY_CONTACT_FORWARD;
    motion.contactZ = this.renderPosition.z - RAKE.pull.z * GARDEN_RAKE_LEGACY_CONTACT_FORWARD;
    motion.contactY = this.map.groundTop(motion.contactX, motion.contactZ) + GARDEN_RAKE_LEGACY_SAND_LIFT;

    const eps = 0.35;
    const hL = this.map.groundTop(motion.contactX - eps, motion.contactZ);
    const hR = this.map.groundTop(motion.contactX + eps, motion.contactZ);
    const hD = this.map.groundTop(motion.contactX, motion.contactZ - eps);
    const hU = this.map.groundTop(motion.contactX, motion.contactZ + eps);
    RAKE.normal.set(hL - hR, eps * 2, hD - hU).normalize();
    motion.normalX = RAKE.normal.x;
    motion.normalY = RAKE.normal.y;
    motion.normalZ = RAKE.normal.z;
  }

  /** Build the rake-root quaternion from authored local axes and a terrain frame. */
  #gardenRakeWorldFrame(elevation: number): THREE.Quaternion {
    RAKE.normal.normalize();
    RAKE.pull.addScaledVector(RAKE.normal, -RAKE.pull.dot(RAKE.normal));
    if (RAKE.pull.lengthSq() < 1e-6) {
      RAKE.pull.copy(this.#gardenRakeLastPull);
      RAKE.pull.addScaledVector(RAKE.normal, -RAKE.pull.dot(RAKE.normal));
    }
    if (RAKE.pull.lengthSq() < 1e-6) RAKE.pull.set(0, 0, -1);
    RAKE.pull.normalize();
    this.#gardenRakeLastPull.copy(RAKE.pull);

    RAKE.localAcross.copy(this.#gardenRakeLocalAcross);
    RAKE.localShaft.copy(this.#gardenRakeLocalShaft);
    RAKE.localBinormal.crossVectors(RAKE.localAcross, RAKE.localShaft).normalize();
    RAKE.localShaft.crossVectors(RAKE.localBinormal, RAKE.localAcross).normalize();

    RAKE.across.crossVectors(RAKE.normal, RAKE.pull).normalize();
    const angle = THREE.MathUtils.clamp(elevation, THREE.MathUtils.degToRad(25), THREE.MathUtils.degToRad(84));
    RAKE.shaft.copy(RAKE.pull).multiplyScalar(Math.cos(angle)).addScaledVector(RAKE.normal, Math.sin(angle)).normalize();
    RAKE.binormal.crossVectors(RAKE.across, RAKE.shaft).normalize();
    RAKE.shaft.crossVectors(RAKE.binormal, RAKE.across).normalize();

    RAKE.localBasis.makeBasis(RAKE.localAcross, RAKE.localShaft, RAKE.localBinormal);
    RAKE.localBasisInverse.copy(RAKE.localBasis).invert();
    RAKE.worldBasis.makeBasis(RAKE.across, RAKE.shaft, RAKE.binormal);
    RAKE.rotationMatrix.multiplyMatrices(RAKE.worldBasis, RAKE.localBasisInverse);
    return RAKE.worldQuaternion.setFromRotationMatrix(RAKE.rotationMatrix);
  }

  /** Position an authored local anchor at an exact world target. */
  #placeGardenRakeRoot(localAnchor: THREE.Vector3, worldTarget: THREE.Vector3) {
    const tool = this.#gardenRakeTool;
    if (!tool) return;
    RAKE.offset.copy(localAnchor).applyQuaternion(RAKE.worldQuaternion);
    RAKE.rootPosition.copy(worldTarget).sub(RAKE.offset);
    RAKE.desiredWorld.compose(RAKE.rootPosition, RAKE.worldQuaternion, RAKE.unitScale);
    const parent = this.meshes.walk;
    parent.updateWorldMatrix(true, false);
    RAKE.parentInverse.copy(parent.matrixWorld).invert();
    RAKE.localMatrix.multiplyMatrices(RAKE.parentInverse, RAKE.desiredWorld);
    RAKE.localMatrix.decompose(tool.root.position, tool.root.quaternion, tool.root.scale);
    tool.root.updateMatrix();
    tool.root.updateWorldMatrix(false, true);
  }

  #targetGardenRakeHand(rig: Rig, side: "L" | "R", anchor: THREE.Object3D) {
    anchor.getWorldPosition(RAKE.gripPosition);
    anchor.getWorldQuaternion(RAKE.gripAim);
    wristTargetForGrip(rig, side, RAKE.gripPosition, RAKE.gripAim, RAKE.wristTarget);
    // Keep elbows outboard and forward. The generic IK pole bends slightly
    // backward, which is natural for a resting hand but wrong for a two-hand
    // push and can tuck the forearms behind the torso from side views.
    RAKE.elbowPole.set(side === "R" ? -0.62 : 0.62, 0.2, -0.48);
    rig.torso.localToWorld(RAKE.elbowPole);
    setHandTarget(rig, side, {
      pos: RAKE.wristTarget,
      aim: RAKE.gripAim,
      pole: RAKE.elbowPole,
      hand: HAND_GRIP,
      reach: 0.99
    });
  }

  /** Tool-first pose: exact tine contact, then independent two-arm IK. */
  #poseGardenRake(rig: Rig, engaged: boolean) {
    const tool = this.#gardenRakeTool;
    if (!tool) return;
    tool.root.visible = true;

    if (engaged) {
      const motion = this.#gardenRakeMotion;
      RAKE.normal.set(motion.normalX, motion.normalY, motion.normalZ);
      if (RAKE.normal.lengthSq() < 1e-6) RAKE.normal.set(0, 1, 0);
      RAKE.pull.set(motion.pullX, 0, motion.pullZ);
      this.#gardenRakeWorldFrame(motion.shaftElevation ?? GARDEN_RAKE_DEFAULT_ELEVATION);
      RAKE.contact.set(motion.contactX, motion.contactY, motion.contactZ);
      this.#placeGardenRakeRoot(this.#gardenRakeContactLocal, RAKE.contact);

      const lean = THREE.MathUtils.clamp(motion.bodyLean ?? GARDEN_RAKE_DEFAULT_BODY_LEAN, 0, 0.55);
      rig.torso.rotation.x -= lean;
      rig.hips.rotation.x -= lean * 0.28;
      rig.head.rotation.x += lean * 0.62;
      if (motion.dragging) {
        const workTwist = Math.sin(this.#strideT) * 0.04;
        rig.torso.rotation.y += workTwist;
        rig.hips.rotation.y -= workTwist * 0.45;
      }
      // Load the legs and send the hips back as the chest reaches over the
      // handle. This keeps the silhouette balanced instead of reading as an
      // ordinary walk cycle with two IK arms pasted on top.
      rig.hips.position.y -= 0.075;
      // Walk/idle reset hip Y and rotation, but not Z. Assign this authored
      // working offset outright so it cannot accumulate every render frame.
      rig.hips.position.z = 0.045;
      rig.legL.rotation.x += 0.08;
      rig.legR.rotation.x += 0.08;
      rig.shinL.rotation.x -= 0.18;
      rig.shinR.rotation.x -= 0.18;
      rig.group.updateWorldMatrix(true, true);
      tool.root.updateWorldMatrix(true, true);
      this.#targetGardenRakeHand(rig, "R", tool.rightGrip);
      this.#targetGardenRakeHand(rig, "L", tool.leftGrip);
      return;
    }

    // Upright one-hand carry: correct shaft alignment and a low head, without
    // pretending the tines are dragging outside the sand activity.
    rig.hips.position.z = 0;
    RAKE.normal.set(0, 1, 0);
    this.meshes.walk.getWorldQuaternion(RAKE.gripAim);
    RAKE.pull.copy(RAKE.forwardLocal).applyQuaternion(RAKE.gripAim).setY(0);
    if (RAKE.pull.lengthSq() < 1e-6) RAKE.pull.copy(this.#gardenRakeLastPull).setY(0);
    RAKE.pull.normalize();
    this.#gardenRakeWorldFrame(GARDEN_RAKE_CARRY_ELEVATION);
    RAKE.gripPosition
      .copy(this.renderPosition)
      .addScaledVector(RAKE.across, 0.34)
      .addScaledVector(RAKE.normal, 0.65)
      .addScaledVector(RAKE.pull, 0.03);
    this.#placeGardenRakeRoot(this.#gardenRakeRightGripLocal, RAKE.gripPosition);
    rig.group.updateWorldMatrix(true, true);
    tool.root.updateWorldMatrix(true, true);
    this.#targetGardenRakeHand(rig, "R", tool.rightGrip);
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

  /** Stable contact bit used by movement foley and headless audio probes. */
  get walkGrounded(): boolean {
    return this.mode === "walk" && this.#modes.walk.grounded;
  }

  get walkSwimming(): boolean {
    return this.mode === "walk" && this.#modes.walk.swimming;
  }

  /** The exact animation phase that alternates the visible feet. */
  get walkStridePhase(): number {
    return this.#strideT;
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
   * Rebuild the player's stock car while preserving its world pose. If another
   * drive-style mount currently owns drive mode, the customized car waits
   * hidden until that mount is released.
   */
  setCarConfig(config: CarConfig) {
    const old = this.#defaultDriveMesh;
    const wasSelected = this.meshes.drive === old;
    const next = buildCarMesh(config);
    next.position.copy(old.position);
    next.quaternion.copy(old.quaternion);
    setEmbodimentVisible(old, false);
    this.#scene.remove(old);
    (old.userData.dispose as (() => void) | undefined)?.();
    this.#scene.add(next);
    this.#defaultDriveMesh = next;
    if (wasSelected) {
      this.meshes.drive = next;
      this.#seatDriver(next);
      setEmbodimentVisible(next, this.mode === "drive");
      this.driveSpec = DEFAULT_DRIVE_SPEC;
      if (this.mode === "drive") {
        this.#lightPool.claim(next);
        void activateCarAssets(next);
      }
    } else {
      setEmbodimentVisible(next, false);
    }
  }

  /** Held slider/color preview on the existing stock car, without rebuilding or broadcasting. */
  previewCarConfig(config: CarConfig) {
    previewCarAppearance(this.#defaultDriveMesh, config);
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
    prepareLocalSurfHero(next);
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
    carry.visible = oldCarry.visible;
    if (this.#heldCarryBoard) {
      // already gripped into the hand — release the old mesh and re-grip the
      // rebuilt one with the same spec so it keeps tracking the arm
      this.#heldCarryBoard.release();
      this.#heldCarryBoard = attachToHand(this.#walkRig, "R", carry, CARRY_BOARD_GRIP);
      carry.scale.multiplyScalar(CARRY_BOARD_SCALE);
    }
    // not yet carried: oldCarry was never parented anywhere, so there's
    // nothing to remove from the scene graph before disposing it
    (oldCarry.userData.dispose as (() => void) | undefined)?.();
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
    if (this.mode === "scooter") {
      this.#lightPool.claim(next);
      void activateScooterAssets(next);
    }
  }

  /** Held-pad/slider preview without rebuilding or broadcasting the scooter. */
  previewScooterConfig(config: ScooterConfig) {
    previewScooterAppearance(this.meshes.scooter, config);
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
   * Collapse render interpolation onto the live body/position. Used after surf
   * pocket teleports so the board and chase camera do not smear the jump.
   */
  snapRenderPose() {
    if (this.body) {
      const t = this.physics.world.getBodyTransform(this.body);
      this.position.set(t.position[0], t.position[1], t.position[2]);
      this.quaternion.set(t.rotation[0], t.rotation[1], t.rotation[2], t.rotation[3]);
    }
    this.#currPosition.copy(this.position);
    this.#prevPosition.copy(this.position);
    this.renderPosition.copy(this.position);
    this.#currQuaternion.copy(this.quaternion);
    this.#prevQuaternion.copy(this.quaternion);
    this.renderQuaternion.copy(this.quaternion);
  }

  /**
   * Called once per rendered frame, after the fixed-step loop. Advances the
   * interpolated render transform: `stepped` is how many physics steps ran this
   * frame, `alpha` is accumulator/fixedTimeStep in [0,1).
   */
  afterSteps(stepped: number, alpha: number) {
    if (this.worldArrivalHeld) {
      this.#applyArrivalHold();
      return;
    }
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
    this.#lightPool.update(this.renderPosition.x, this.renderPosition.z);
  }

  /** Per-frame character animation: pose whichever rig is embodied right now. */
  #animate(dt: number) {
    this.#animT += dt;
    this.#phoenixRiderRig.group.visible =
      this.mode === "bird" && Boolean(this.meshes.bird.userData.phoenixAsset);
    if (this.mode !== "walk") applyBallGlow(this.#ballMaterial, 0);
    if (this.mode === "walk") {
      const r = this.#walkRig;
      const walk = this.#modes.walk;
      const golfing = this.#golfPose.active && walk.grounded && !walk.swimming;
      const archering = !golfing && this.#archerPose.active && walk.grounded && !walk.swimming;
      if (this.#gardenRakeTool && this.#gardenRakeLegacy) this.#updateLegacyGardenRakeMotion();
      const gardenPoseAllowed = !!this.#gardenRakeTool && !golfing && !archering && !walk.swimming;
      const gardenEngaged = gardenPoseAllowed && walk.grounded && this.#gardenRakeMotion.engaged;
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
      // Prop visibility is explicitly refreshed every walk frame.
      // the left mitt also wraps a held bow (archery); the string hand curls
      // only while actually pulling
      setHandPose(r, "L", golfing || archering || this.#bowCarried || gardenEngaged ? 1 : 0);
      setHandPose(
        r,
        "R",
        golfing || this.#ballHeld || this.#carryingBoard || gardenPoseAllowed || (archering && this.#archerPose.draw > 0.05) ? 1 : 0
      );
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
          const tw = WALK_TUNING.values;
          // cadence scales with speed so the athletic sprint doesn't look like
          // moonwalk-slow legs under a fast capsule — kept a touch under the
          // old rate so full sprint reads grounded instead of flailing
          this.#strideT += dt * (3.0 + h * 1.05);
          const runBlend = THREE.MathUtils.clamp(
            (h - tw.speed) / Math.max(0.1, tw.runSpeed - tw.speed),
            0,
            1
          );
          poseWalk(r, this.#strideT, runBlend);
        } else {
          poseIdle(r, this.#animT);
        }
      }
      if (this.#gardenRakeTool) {
        this.#gardenRakeTool.root.visible = gardenPoseAllowed;
        if (gardenPoseAllowed) this.#poseGardenRake(r, gardenEngaged);
      }
      // throw swing: an additive overlay on the right arm + torso, layered AFTER
      // the base pose so it rides on top of walk/idle without a dedicated pose fn.
      if (this.#throwT > 0 && !golfing && !this.#gardenRakeTool) this.#applyThrowSwing(r);
    } else if (this.mode === "board") {
      const board = this.#modes.board;
      const crouch = Math.min(1, this.speed / BOARD_TUNING.values.boostMaxSpeed + Math.abs(board.lean) * 0.6);
      poseRide(this.#riderRig, board.lean, crouch, !board.grounded, this.#animT);
      this.#riderRig.group.rotation.z = board.lean * 0.4; // whole-body dip on top of the deck roll
      animateBoard(this.meshes.board, dt, this.#animT, board.horizontalSpeed, board);
    } else if (this.mode === "surf") {
      const surf = this.#modes.surf;
      const crouch = Math.min(1, this.speed / SURF_TUNING.values.maxTrim + Math.abs(surf.lean) * 0.5);
      poseSurfRide(
        this.#surfRig,
        surf.lean,
        crouch,
        !surf.grounded,
        this.#animT,
        surf.telemetry.landingCompression
      );
      // The board already carries the wave bank. Rolling the whole rider again
      // pivots around the hips and drives one foot through the deck; torso lean
      // in poseSurfRide provides the carve silhouette without breaking contact.
      this.#surfRig.group.rotation.z = 0;
      this.#surfRig.group.rotation.x = 0;
      animateSurfboard(
        this.meshes.surf,
        dt,
        this.#animT,
        surf.telemetry.landingCompression,
        surf.telemetry.landingSerial
      );
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
      animateCar(this.meshes.drive, dt, Math.hypot(this.velocity.x, this.velocity.z), steer);
      updateCarLights(this.meshes.drive, this.#modes.drive.brakeLevel);
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
    } else if (this.mode === "bird" && this.#phoenixRiderRig.group.visible) {
      poseDrive(this.#phoenixRiderRig, 0, this.#animT, false);
    }
  }

  get aimOrigin(): THREE.Vector3 {
    return V.tmp2.copy(this.position).add(V.tmp.set(0, this.mode === "plane" || this.mode === "drone" || this.mode === "bird" ? 0 : 1.4, 0));
  }
}
