import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { WIND_DIR } from "../vegetation/wind";
import { avatarFromSeed } from "../../player/avatar";
import { setHandTarget, type HandTarget } from "../../player/handIK";
import {
  attachToHand,
  wristTargetForGrip,
  type GripSpec
} from "../../player/held";
import { buildRig, poseWalk, type Rig } from "../../player/rig";
import type { DebugFeatureTuningRegistration } from "../../ui/debug";
import {
  createKiteCloth,
  KITE_HEIGHT,
  KITE_WIDTH,
  type KiteCloth,
  type KiteClothState
} from "./kiteCloth";
import { bindOceanKiteTuning, OCEAN_KITE_TUNING } from "./tuning";

export type OceanBeachKiteSite = { x: number; z: number };

export type OceanBeachKiteDebugState = {
  webgpuCloth: true;
  awake: boolean;
  action: KiteAction;
  runnerSpeed: number;
  lineLength: number;
  lineTarget: number;
  tension: number;
  kiteHeight: number;
  tailLength: number;
  runner: [number, number, number];
  kite: [number, number, number];
  tetherStart: [number, number, number];
  tetherEnd: [number, number, number];
};

export type OceanBeachKiteEncounter = {
  group: THREE.Group;
  update(dt: number, elapsed: number, player: { x: number; z: number }, gust: number): void;
  setAwake(awake: boolean): void;
  syncTuning(): void;
  tuningDescriptor(): DebugFeatureTuningRegistration;
  debugState(): OceanBeachKiteDebugState;
  dispose(): void;
};

type KiteAction = "launch" | "cruise" | "reel out" | "slow down" | "reel in" | "sprint";
type ActionSpec = {
  name: KiteAction;
  seconds: number;
  speed: number;
  line?: number;
  reel: -1 | 0 | 1;
};

/** The sequence is intentionally legible rather than random: arrive during a
 * launch, then watch the person settle, pay line out, ease, reel in, and run. */
const ACTIONS: readonly ActionSpec[] = [
  { name: "launch", seconds: 6.2, speed: 1, line: 0.22, reel: 1 },
  { name: "cruise", seconds: 4.8, speed: 0.58, reel: 0 },
  { name: "reel out", seconds: 5.3, speed: 0.7, line: 1, reel: 1 },
  { name: "slow down", seconds: 4.1, speed: 0.05, reel: 0 },
  { name: "reel in", seconds: 5.5, speed: 0.34, line: 0.3, reel: -1 },
  { name: "sprint", seconds: 5.2, speed: 1, reel: 0 },
  { name: "cruise", seconds: 4.5, speed: 0.5, reel: 0 }
];
// The launch/catch is the arrival vignette. The steady ambient loop starts at
// reel-out so an already-airborne kite never periodically dives back to launch.
const LOOP_START_INDEX = 2;

const WAKE_DISTANCE = 430;
const SLEEP_DISTANCE = 520;
const RIG_HIP_HEIGHT = 0.92;
const ROUTE_HALF_LENGTH = 40;
const ROUTE_STEP = 5;
// Dry-sand offset east of the live waterline so the runner stays off the wet edge.
const BEACH_RUNNER_PAD = 12;

/**
 * Walk east (shoreward) from just offshore of the anchor until `isWater` flips
 * false, then step a few metres onto dry sand. Generic coastline scan — works on
 * any west-facing beach, unlike the Ocean-Beach-specific shoreline fit.
 */
function beachEdgeX(map: WorldMap, referenceX: number, z: number): number {
  for (let x = referenceX - 90; x < referenceX + 110; x += 2) {
    if (!map.isWater(x, z)) return x + BEACH_RUNNER_PAD;
  }
  return referenceX + BEACH_RUNNER_PAD;
}
const TETHER_POINTS = 30;
const TAIL_POINTS = 22;
const UP = new THREE.Vector3(0, 1, 0);
const LOCAL_Z = new THREE.Vector3(0, 0, 1);

const REEL_GRIP: GripSpec = {
  position: [-0.14, 0, 0],
  rotation: [0, 0, 0],
  curl: 0.92
};

type RouteSample = { x: number; z: number };
type ReelProp = {
  group: THREE.Group;
  spool: THREE.Group;
  guideGrip: THREE.Object3D;
  lineKnot: THREE.Object3D;
};

function dampAngle(current: number, target: number, rate: number): number {
  let delta = target - current;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  return current + delta * rate;
}

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function createDynamicLine(
  pointCount: number,
  material: THREE.LineBasicMaterial,
  name: string
): THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial> {
  const geometry = new THREE.BufferGeometry();
  const attribute = new THREE.BufferAttribute(new Float32Array(pointCount * 3), 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute("position", attribute);
  const line = new THREE.Line(geometry, material);
  line.name = name;
  line.frustumCulled = false;
  return line;
}

class KiteEncounter implements OceanBeachKiteEncounter {
  readonly group = new THREE.Group();

  #map: WorldMap;
  #site: OceanBeachKiteSite;
  #route: RouteSample[];
  #rig: Rig;
  #reel: ReelProp;
  #cloth: KiteCloth;
  #kite = new THREE.Group();
  #bridleKnot = new THREE.Object3D();
  #tether: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  #tail: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  #tailBows: THREE.Mesh[] = [];
  #debug = new THREE.Group();
  #runnerMarker: THREE.Mesh;
  #targetMarker: THREE.Mesh;
  #kiteMarker: THREE.Mesh;

  #ownedGeometries: THREE.BufferGeometry[] = [];
  #ownedMaterials: THREE.Material[] = [];

  #awake = false;
  #disposed = false;
  #actionIndex = 0;
  #actionTime = 0;
  #direction: 1 | -1 = 1;
  #runnerZ: number;
  #runnerX: number;
  #runnerSpeed = 0;
  #runnerYaw = Math.PI;
  #stride = 0;
  #lineLength: number;
  #lineTarget: number;
  #lineChange = 0;
  #reelSpin = 0;
  #tailLength = 0;
  #flightEnergy = 0.04;
  #tension = 0;
  #lastWind = 1;
  #lastElapsed = 0;
  #nextMonitorRefresh = 0;

  #kitePosition = new THREE.Vector3();
  #kiteVelocity = new THREE.Vector3();
  #kiteTarget = new THREE.Vector3();
  #tetherStart = new THREE.Vector3();
  #tetherEnd = new THREE.Vector3();
  #lineDelta = new THREE.Vector3();
  #lineDirection = new THREE.Vector3();
  #crosswind = new THREE.Vector3(-WIND_DIR.z, 0, WIND_DIR.x).normalize();
  #targetLocal = new THREE.Vector3();
  #rightWrist = new THREE.Vector3();
  #leftGrip = new THREE.Vector3();
  #leftWrist = new THREE.Vector3();
  #handAim = new THREE.Quaternion();
  #rightHandTarget: HandTarget = {
    pos: this.#rightWrist,
    aim: this.#handAim,
    hand: 0.92,
    reach: 0.97
  };
  #leftHandTarget: HandTarget = {
    pos: this.#leftWrist,
    aim: this.#handAim,
    hand: 0.9,
    reach: 0.97
  };
  #clothState: KiteClothState = {
    wind: 1,
    tautness: 0.68,
    billow: 0.34,
    ripple: 0.16,
    frequency: 4.2,
    speed: 5.4,
    gustPhase: 0
  };
  #targetQuat = new THREE.Quaternion();
  #bankQuat = new THREE.Quaternion();
  #basis = new THREE.Matrix4();
  #basisX = new THREE.Vector3();
  #basisY = new THREE.Vector3();
  #basisZ = new THREE.Vector3();

  #monitor = {
    awake: "no",
    action: "launch",
    speed: "0.00 m/s",
    line: "0.0 m",
    tension: "0%",
    altitude: "0.0 m",
    cloth: "WebGPU vertex cloth"
  };

  constructor(map: WorldMap, site: OceanBeachKiteSite) {
    this.#map = map;
    this.#site = { ...site };
    this.#route = this.#buildRoute();
    this.#runnerZ = site.z - 9;
    this.#runnerX = this.#routeX(this.#runnerZ);

    const tuning = OCEAN_KITE_TUNING.values;
    this.#lineLength = tuning.minLineLength;
    this.#lineTarget = tuning.minLineLength;

    this.group.name = "ocean_beach_kite_encounter";
    this.#rig = buildRig(avatarFromSeed("ocean-beach-kite-flyer"));
    this.#rig.group.name = "ocean_beach_kite_flyer";
    this.group.add(this.#rig.group);

    this.#reel = this.#buildReel();
    attachToHand(this.#rig, "R", this.#reel.group, REEL_GRIP);

    this.#cloth = createKiteCloth();
    this.#buildKite();
    this.#kite.name = "ocean_beach_purple_kite";
    this.group.add(this.#kite);

    const tetherMaterial = this.#ownMaterial(
      new THREE.LineBasicMaterial({
        color: 0xf4eaff,
        opacity: 0.82,
        transparent: true,
        depthWrite: false
      })
    );
    this.#tether = createDynamicLine(TETHER_POINTS, tetherMaterial, "ocean_beach_kite_tether");
    this.#ownGeometry(this.#tether.geometry);
    this.group.add(this.#tether);

    const tailMaterial = this.#ownMaterial(
      new THREE.LineBasicMaterial({ color: 0x7d46ba, opacity: 0.9, transparent: true })
    );
    this.#tail = createDynamicLine(TAIL_POINTS, tailMaterial, "ocean_beach_kite_tail");
    this.#ownGeometry(this.#tail.geometry);
    this.#kite.add(this.#tail);
    this.#buildTailBows();

    const markerGeometry = this.#ownGeometry(new THREE.SphereGeometry(0.18, 8, 6));
    this.#runnerMarker = new THREE.Mesh(
      markerGeometry,
      this.#ownMaterial(new THREE.MeshBasicMaterial({ color: 0x38d6d1, depthTest: false }))
    );
    this.#targetMarker = new THREE.Mesh(
      markerGeometry,
      this.#ownMaterial(new THREE.MeshBasicMaterial({ color: 0xffc861, depthTest: false }))
    );
    this.#kiteMarker = new THREE.Mesh(
      markerGeometry,
      this.#ownMaterial(new THREE.MeshBasicMaterial({ color: 0xd65cff, depthTest: false }))
    );
    this.#debug.name = "ocean_beach_kite_attachment_landmarks";
    this.#debug.renderOrder = 50;
    this.#debug.add(this.#runnerMarker, this.#targetMarker, this.#kiteMarker);
    this.#buildRouteDebug();
    this.group.add(this.#debug);

    const ground = map.groundTop(this.#runnerX, this.#runnerZ);
    this.#rig.group.position.set(this.#runnerX, ground + RIG_HIP_HEIGHT, this.#runnerZ);
    poseWalk(this.#rig, 0, 1);
    this.#rig.group.updateMatrixWorld(true);
    this.#tetherStart.set(this.#runnerX, ground + 1.35, this.#runnerZ);
    this.#kitePosition
      .copy(this.#tetherStart)
      .addScaledVector(WIND_DIR, Math.max(7, this.#lineLength * 0.52));
    this.#kitePosition.y += 2.4;
    this.#kite.position.copy(this.#kitePosition);
    this.#kite.updateMatrixWorld(true);
    this.#bridleKnot.getWorldPosition(this.#tetherEnd);
    this.syncTuning();
    this.#updateTether(0);
    this.#updateTail(0);
    this.group.updateMatrixWorld(true);
  }

  #ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.#ownedGeometries.push(geometry);
    return geometry;
  }

  #ownMaterial<T extends THREE.Material>(material: T): T {
    this.#ownedMaterials.push(material);
    return material;
  }

  #buildRoute(): RouteSample[] {
    const samples: RouteSample[] = [];
    for (let dz = -ROUTE_HALF_LENGTH; dz <= ROUTE_HALF_LENGTH; dz += ROUTE_STEP) {
      const z = this.#site.z + dz;
      const x = beachEdgeX(this.#map, this.#site.x, z);
      samples.push({ x, z });
    }
    return samples;
  }

  #routeX(z: number): number {
    const clamped = THREE.MathUtils.clamp(
      z,
      this.#route[0].z,
      this.#route[this.#route.length - 1].z
    );
    const raw = (clamped - this.#route[0].z) / ROUTE_STEP;
    const i = Math.min(this.#route.length - 2, Math.max(0, Math.floor(raw)));
    const t = raw - i;
    return THREE.MathUtils.lerp(this.#route[i].x, this.#route[i + 1].x, t);
  }

  #buildReel(): ReelProp {
    const group = new THREE.Group();
    group.name = "kite_reel";
    const spool = new THREE.Group();
    const wood = this.#ownMaterial(new THREE.MeshStandardMaterial({ color: 0x704728, roughness: 0.74 }));
    const violet = this.#ownMaterial(new THREE.MeshStandardMaterial({ color: 0x8f53ce, roughness: 0.62 }));
    const brass = this.#ownMaterial(new THREE.MeshStandardMaterial({ color: 0xc99b52, roughness: 0.42, metalness: 0.4 }));

    const coreGeometry = this.#ownGeometry(new THREE.CylinderGeometry(0.095, 0.095, 0.23, 12));
    coreGeometry.rotateZ(Math.PI / 2);
    const core = new THREE.Mesh(coreGeometry, violet);
    spool.add(core);
    const discGeometry = this.#ownGeometry(new THREE.CylinderGeometry(0.145, 0.145, 0.025, 14));
    discGeometry.rotateZ(Math.PI / 2);
    for (const x of [-0.125, 0.125]) {
      const disc = new THREE.Mesh(discGeometry, wood);
      disc.position.x = x;
      spool.add(disc);
    }
    group.add(spool);

    const barGeometry = this.#ownGeometry(new THREE.CylinderGeometry(0.025, 0.025, 0.42, 8));
    barGeometry.rotateZ(Math.PI / 2);
    const bar = new THREE.Mesh(barGeometry, brass);
    bar.position.z = 0.08;
    group.add(bar);

    const guideGrip = new THREE.Object3D();
    guideGrip.position.set(0.14, 0, 0.08);
    group.add(guideGrip);
    const lineKnot = new THREE.Object3D();
    lineKnot.position.set(0, 0.12, -0.08);
    group.add(lineKnot);
    return { group, spool, guideGrip, lineKnot };
  }

  #buildKite(): void {
    this.#kite.add(this.#cloth.mesh);
    const sparMaterial = this.#ownMaterial(
      new THREE.MeshStandardMaterial({ color: 0x5d3a24, roughness: 0.78 })
    );
    const spineGeometry = this.#ownGeometry(
      new THREE.CylinderGeometry(0.035, 0.045, KITE_HEIGHT * 0.98, 8)
    );
    const spine = new THREE.Mesh(spineGeometry, sparMaterial);
    spine.name = "kite_spine";
    spine.position.z = 0.045;
    const crossGeometry = this.#ownGeometry(
      new THREE.CylinderGeometry(0.032, 0.032, KITE_WIDTH * 0.98, 8)
    );
    crossGeometry.rotateZ(Math.PI / 2);
    const cross = new THREE.Mesh(crossGeometry, sparMaterial);
    cross.name = "kite_cross_spar";
    cross.position.set(0, 0.08, 0.055);
    this.#kite.add(spine, cross);

    const hemGeometry = this.#ownGeometry(new THREE.BufferGeometry());
    hemGeometry.setFromPoints([
      new THREE.Vector3(0, KITE_HEIGHT * 0.5, 0.02),
      new THREE.Vector3(KITE_WIDTH * 0.5, 0, 0.02),
      new THREE.Vector3(0, -KITE_HEIGHT * 0.5, 0.02),
      new THREE.Vector3(-KITE_WIDTH * 0.5, 0, 0.02),
      new THREE.Vector3(0, KITE_HEIGHT * 0.5, 0.02)
    ]);
    const hem = new THREE.Line(
      hemGeometry,
      this.#ownMaterial(new THREE.LineBasicMaterial({ color: 0xd5a6ff }))
    );
    hem.name = "kite_sewn_hem";
    this.#kite.add(hem);

    this.#bridleKnot.name = "kite_bridle_knot";
    this.#bridleKnot.position.set(0, -0.12, 0.58);
    this.#kite.add(this.#bridleKnot);
    const bridlePoints = [
      new THREE.Vector3(0, KITE_HEIGHT * 0.34, 0.06),
      this.#bridleKnot.position,
      new THREE.Vector3(KITE_WIDTH * 0.36, 0, 0.06),
      this.#bridleKnot.position,
      new THREE.Vector3(-KITE_WIDTH * 0.36, 0, 0.06),
      this.#bridleKnot.position,
      new THREE.Vector3(0, -KITE_HEIGHT * 0.22, 0.06),
      this.#bridleKnot.position
    ];
    const bridleGeometry = this.#ownGeometry(new THREE.BufferGeometry().setFromPoints(bridlePoints));
    const bridle = new THREE.LineSegments(
      bridleGeometry,
      this.#ownMaterial(
        new THREE.LineBasicMaterial({ color: 0xf5ecda, opacity: 0.72, transparent: true })
      )
    );
    bridle.name = "kite_bridle";
    this.#kite.add(bridle);
  }

  #buildTailBows(): void {
    const bowGeometry = this.#ownGeometry(new THREE.PlaneGeometry(0.42, 0.2));
    const colors = [0xb56ee8, 0x7840b3, 0xd190f1, 0x67339d];
    for (let i = 0; i < 4; i++) {
      const bow = new THREE.Mesh(
        bowGeometry,
        this.#ownMaterial(
          new THREE.MeshStandardMaterial({
            color: colors[i],
            side: THREE.DoubleSide,
            roughness: 0.8
          })
        )
      );
      bow.name = `kite_tail_bow_${i}`;
      this.#tailBows.push(bow);
      this.#kite.add(bow);
    }
  }

  #buildRouteDebug(): void {
    const points = this.#route.map(
      (sample) => new THREE.Vector3(sample.x, this.#map.groundTop(sample.x, sample.z) + 0.08, sample.z)
    );
    const geometry = this.#ownGeometry(new THREE.BufferGeometry().setFromPoints(points));
    const route = new THREE.Line(
      geometry,
      this.#ownMaterial(new THREE.LineBasicMaterial({ color: 0x37ddd4, depthTest: false }))
    );
    route.name = "kite_flyer_route_landmark";
    route.renderOrder = 50;
    this.#debug.add(route);

    const arrow = new THREE.ArrowHelper(WIND_DIR, new THREE.Vector3(this.#site.x, 3, this.#site.z), 8, 0xffc861, 1.1, 0.5);
    arrow.name = "kite_wind_landmark";
    arrow.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        this.#ownedGeometries.push(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        this.#ownedMaterials.push(...materials);
      } else if (object instanceof THREE.Line) {
        this.#ownedGeometries.push(object.geometry);
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        this.#ownedMaterials.push(...materials);
      }
    });
    this.#debug.add(arrow);
  }

  #currentAction(): ActionSpec {
    return ACTIONS[this.#actionIndex];
  }

  #advanceAction(dt: number): void {
    const tempo = Math.max(0.1, OCEAN_KITE_TUNING.values.actionTempo);
    this.#actionTime += dt * tempo;
    const action = this.#currentAction();
    if (this.#actionTime < action.seconds) return;
    this.#actionTime %= action.seconds;
    this.#actionIndex = this.#actionIndex === ACTIONS.length - 1
      ? LOOP_START_INDEX
      : this.#actionIndex + 1;
  }

  #updateRunner(dt: number, elapsed: number): void {
    const tuning = OCEAN_KITE_TUNING.values;
    const action = this.#currentAction();
    const halfSpan = Math.max(6, tuning.runSpan * 0.5);
    const edgeDistance = halfSpan - Math.abs(this.#runnerZ - this.#site.z);
    const edgeEase = THREE.MathUtils.clamp(edgeDistance / 5, 0.34, 1);
    const slow = Math.min(tuning.slowRunSpeed, tuning.fastRunSpeed);
    const fast = Math.max(tuning.slowRunSpeed, tuning.fastRunSpeed);
    const desiredSpeed = THREE.MathUtils.lerp(slow, fast, action.speed) * edgeEase;
    const speedResponse = 1 - Math.exp(-dt * (action.name === "sprint" || action.name === "launch" ? 3.2 : 1.9));
    this.#runnerSpeed += (desiredSpeed - this.#runnerSpeed) * speedResponse;
    this.#runnerZ += this.#direction * this.#runnerSpeed * dt;
    if (this.#runnerZ > this.#site.z + halfSpan) {
      this.#runnerZ = this.#site.z + halfSpan;
      this.#direction = -1;
    } else if (this.#runnerZ < this.#site.z - halfSpan) {
      this.#runnerZ = this.#site.z - halfSpan;
      this.#direction = 1;
    }

    const nextZ = this.#runnerZ + this.#direction * 0.5;
    const nextX = this.#routeX(nextZ);
    this.#runnerX = this.#routeX(this.#runnerZ);
    const dx = nextX - this.#runnerX;
    const dz = nextZ - this.#runnerZ;
    const targetYaw = Math.atan2(-dx, -dz);
    this.#runnerYaw = dampAngle(this.#runnerYaw, targetYaw, 1 - Math.exp(-dt * 6.5));
    const ground = this.#map.groundTop(this.#runnerX, this.#runnerZ);
    this.#rig.group.position.set(this.#runnerX, ground + RIG_HIP_HEIGHT, this.#runnerZ);
    this.#rig.group.rotation.y = this.#runnerYaw;

    this.#stride += dt * this.#runnerSpeed * 4.1;
    const runBlend = THREE.MathUtils.clamp((this.#runnerSpeed - slow * 0.65) / Math.max(0.5, fast - slow * 0.65), 0, 1);
    poseWalk(this.#rig, this.#stride, runBlend);

    // Layer both hands onto the reel after the running gait owns the body/legs.
    // A small rhythmic lift lets reel-in/reel-out read without stopping the run.
    const reeling = THREE.MathUtils.clamp(
      Math.abs(this.#lineChange) / Math.max(1e-5, tuning.reelRate * dt),
      0,
      1
    );
    this.#targetLocal.set(
      -0.14,
      0.12 + Math.sin(elapsed * 5.2) * 0.025 * reeling,
      -0.34 - Math.cos(elapsed * 5.2) * 0.025 * reeling
    );
    this.#rig.group.updateWorldMatrix(true, false);
    this.#rightWrist.copy(this.#targetLocal);
    this.#rig.group.localToWorld(this.#rightWrist);
    this.#handAim.copy(this.#rig.group.quaternion);
    setHandTarget(this.#rig, "R", this.#rightHandTarget);
    // getWorldPosition refreshes only the reel's ancestor chain; avoid a full
    // rig traversal between the two IK solves.
    this.#reel.guideGrip.getWorldPosition(this.#leftGrip);
    wristTargetForGrip(this.#rig, "L", this.#leftGrip, this.#handAim, this.#leftWrist);
    setHandTarget(this.#rig, "L", this.#leftHandTarget);

    // The prop follows actual signed line travel. It stops exactly when the
    // tether stops, even if a long authored action still has time remaining.
    this.#reelSpin += this.#lineChange / 0.095;
    this.#reel.spool.rotation.x = this.#reelSpin;
    this.#reel.lineKnot.getWorldPosition(this.#tetherStart);
  }

  #updateLineLength(dt: number): void {
    const tuning = OCEAN_KITE_TUNING.values;
    const minLine = Math.min(tuning.minLineLength, tuning.maxLineLength - 1);
    const maxLine = Math.max(tuning.maxLineLength, minLine + 1);
    const action = this.#currentAction();
    if (action.reel === 0 || action.line === undefined) {
      this.#lineTarget = this.#lineLength;
      this.#lineChange = 0;
      return;
    }
    this.#lineTarget = THREE.MathUtils.lerp(minLine, maxLine, action.line);
    const previous = this.#lineLength;
    const maxStep = Math.max(0.1, tuning.reelRate) * dt;
    this.#lineLength += THREE.MathUtils.clamp(this.#lineTarget - this.#lineLength, -maxStep, maxStep);
    this.#lineLength = THREE.MathUtils.clamp(this.#lineLength, minLine, maxLine);
    this.#lineChange = this.#lineLength - previous;
  }

  #updateFlight(dt: number, elapsed: number, gust: number): void {
    const tuning = OCEAN_KITE_TUNING.values;
    const action = this.#currentAction();
    const fast = Math.max(tuning.fastRunSpeed, 0.5);
    const wind = tuning.windStrength * (0.72 + gust * tuning.gustResponse * 0.72);
    this.#lastWind = wind;
    const runEnergy = THREE.MathUtils.clamp(this.#runnerSpeed / fast, 0, 1);
    let launchGate = 1;
    if (action.name === "launch" && this.#actionIndex === 0) {
      launchGate = smooth01(this.#actionTime / Math.max(0.1, action.seconds * 0.82));
    }
    const energyTarget = THREE.MathUtils.clamp((0.42 + wind * 0.32 + runEnergy * 0.24) * launchGate, 0.03, 1);
    this.#flightEnergy += (energyTarget - this.#flightEnergy) * (1 - Math.exp(-dt * (1.5 + tuning.lift * 1.7)));

    const elevation = THREE.MathUtils.lerp(0.13, 0.93, this.#flightEnergy * tuning.lift);
    const radial = this.#lineLength * (0.86 + tuning.lineTautness * 0.125);
    const horizontal = Math.cos(elevation) * radial;
    const vertical = Math.sin(elevation) * radial;
    const wander = Math.sin(elapsed * 0.37 + Math.sin(elapsed * 0.11) * 1.7);
    this.#kiteTarget
      .copy(this.#tetherStart)
      .addScaledVector(WIND_DIR, horizontal)
      .addScaledVector(this.#crosswind, wander * radial * (0.018 + gust * 0.035));
    this.#kiteTarget.y += vertical;

    const response = 1.8 + tuning.lineTautness * 4.2;
    this.#kiteVelocity.addScaledVector(this.#lineDelta.copy(this.#kiteTarget).sub(this.#kitePosition), response * response * dt);
    const damping = 2.1 * response + tuning.drag * 1.8;
    this.#kiteVelocity.multiplyScalar(Math.exp(-damping * dt));
    this.#kiteVelocity.addScaledVector(this.#crosswind, Math.sin(elapsed * 1.7) * gust * 0.24 * dt);
    this.#kitePosition.addScaledVector(this.#kiteVelocity, dt);

    // One authored tether constraint, no rigid-body world and no GPU readback.
    this.#lineDelta.copy(this.#kitePosition).sub(this.#tetherStart);
    const distance = this.#lineDelta.length();
    if (distance > this.#lineLength) {
      this.#lineDirection.copy(this.#lineDelta).multiplyScalar(1 / Math.max(distance, 1e-5));
      this.#kitePosition.copy(this.#tetherStart).addScaledVector(this.#lineDirection, this.#lineLength);
      const outward = this.#kiteVelocity.dot(this.#lineDirection);
      if (outward > 0) this.#kiteVelocity.addScaledVector(this.#lineDirection, -outward);
    }
    this.#tension = THREE.MathUtils.clamp(distance / Math.max(1, this.#lineLength), 0, 1);
    this.#kite.position.copy(this.#kitePosition);

    // Face the kite's windward cloth toward the flyer while keeping its diamond
    // upright against the horizon; gusts add a restrained bank around that face.
    this.#basisZ.copy(this.#tetherStart).sub(this.#kitePosition).normalize();
    this.#basisY.copy(UP).addScaledVector(this.#basisZ, -UP.dot(this.#basisZ)).normalize();
    this.#basisX.copy(this.#basisY).cross(this.#basisZ).normalize();
    this.#targetQuat.setFromRotationMatrix(this.#basis.makeBasis(this.#basisX, this.#basisY, this.#basisZ));
    const bank = Math.sin(elapsed * 0.79) * (0.06 + gust * 0.12) + wander * 0.08;
    this.#bankQuat.setFromAxisAngle(LOCAL_Z, bank);
    this.#targetQuat.multiply(this.#bankQuat);
    this.#kite.quaternion.slerp(this.#targetQuat, 1 - Math.exp(-dt * (2.8 + tuning.lineTautness * 3)));
    this.#kite.updateMatrixWorld(true);
    this.#bridleKnot.getWorldPosition(this.#tetherEnd);
  }

  #updateTether(elapsed: number): void {
    const tuning = OCEAN_KITE_TUNING.values;
    const attribute = this.#tether.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const slack = (1 - tuning.lineTautness) * this.#lineLength * 0.14 + (1 - this.#tension) * 1.4;
    for (let i = 0; i < TETHER_POINTS; i++) {
      const t = i / (TETHER_POINTS - 1);
      const arch = 4 * t * (1 - t);
      const offset = i * 3;
      array[offset] = THREE.MathUtils.lerp(this.#tetherStart.x, this.#tetherEnd.x, t);
      array[offset + 1] = THREE.MathUtils.lerp(this.#tetherStart.y, this.#tetherEnd.y, t) - arch * slack;
      array[offset + 2] =
        THREE.MathUtils.lerp(this.#tetherStart.z, this.#tetherEnd.z, t) +
        Math.sin(elapsed * 2.1 + t * 8.5) * arch * (1 - tuning.lineTautness) * 0.28;
    }
    attribute.needsUpdate = true;
  }

  #updateTail(elapsed: number): void {
    const attribute = this.#tail.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const ground = this.#map.groundTop(this.#kitePosition.x, this.#kitePosition.z);
    const availableDrop = Math.max(0, this.#kitePosition.y - ground - KITE_HEIGHT * 0.5 - 0.2);
    const deployed = smooth01((this.#flightEnergy - 0.04) / 0.55);
    const tailLength = Math.min(availableDrop, THREE.MathUtils.lerp(0.12, 7.5, deployed));
    this.#tailLength = tailLength;
    for (let i = 0; i < TAIL_POINTS; i++) {
      const t = i / (TAIL_POINTS - 1);
      const offset = i * 3;
      array[offset] = Math.sin(elapsed * 3.3 - t * 8.2) * t * (0.32 + this.#lastWind * 0.13);
      array[offset + 1] = -KITE_HEIGHT * 0.5 - t * tailLength;
      array[offset + 2] = Math.sin(elapsed * 2.2 - t * 6.4) * t * 0.38;
    }
    attribute.needsUpdate = true;
    for (let i = 0; i < this.#tailBows.length; i++) {
      const t = (i + 1) / (this.#tailBows.length + 1);
      const pointIndex = Math.round(t * (TAIL_POINTS - 1));
      const offset = pointIndex * 3;
      const bow = this.#tailBows[i];
      bow.position.set(array[offset], array[offset + 1], array[offset + 2]);
      bow.rotation.z = Math.sin(elapsed * 3.3 - t * 8.2) * 0.55 + (i % 2 ? 0.35 : -0.35);
      bow.rotation.y = Math.sin(elapsed * 2.1 + i) * 0.28;
    }
  }

  #updateDebug(): void {
    const visible = OCEAN_KITE_TUNING.values.showLandmarks;
    this.#debug.visible = visible;
    if (!visible) return;
    this.#runnerMarker.position.copy(this.#tetherStart);
    this.#targetMarker.position.copy(this.#kiteTarget);
    this.#kiteMarker.position.copy(this.#tetherEnd);
  }

  setAwake(awake: boolean): void {
    if (this.#disposed || this.#awake === awake) return;
    this.#awake = awake;
    this.group.visible = awake && OCEAN_KITE_TUNING.values.enabled;
    this.#monitor.awake = awake ? "yes" : "no";
  }

  update(dt: number, elapsed: number, player: { x: number; z: number }, gust: number): void {
    if (this.#disposed) return;
    const distance = Math.hypot(player.x - this.#site.x, player.z - this.#site.z);
    if (this.#awake ? distance > SLEEP_DISTANCE : distance < WAKE_DISTANCE) {
      this.setAwake(!this.#awake);
    }
    const enabled = OCEAN_KITE_TUNING.values.enabled;
    this.group.visible = this.#awake && enabled;
    if (!this.#awake || !enabled) {
      this.#monitor.awake = this.#awake ? "disabled" : "no";
      return;
    }

    dt = Math.min(Math.max(dt, 0), 0.1);
    this.#lastElapsed = elapsed;
    this.#advanceAction(dt);
    this.#updateLineLength(dt);
    this.#updateRunner(dt, elapsed);
    this.#updateFlight(dt, elapsed, THREE.MathUtils.clamp(gust, 0, 1));
    this.#updateTether(elapsed);
    this.#updateTail(elapsed);
    this.syncTuning();

    // Tweakpane refreshes monitors at 4 Hz; match that cadence so the hot path
    // does not allocate five formatted strings on every rendered frame.
    if (elapsed >= this.#nextMonitorRefresh || elapsed < this.#nextMonitorRefresh - 1) {
      const action = this.#currentAction();
      const ground = this.#map.groundTop(this.#kitePosition.x, this.#kitePosition.z);
      this.#monitor.awake = "yes";
      this.#monitor.action = action.name;
      this.#monitor.speed = `${this.#runnerSpeed.toFixed(2)} m/s`;
      this.#monitor.line = `${this.#lineLength.toFixed(1)} m`;
      this.#monitor.tension = `${Math.round(this.#tension * 100)}%`;
      this.#monitor.altitude = `${Math.max(0, this.#kitePosition.y - ground).toFixed(1)} m`;
      this.#nextMonitorRefresh = elapsed + 0.25;
    }
  }

  syncTuning(): void {
    const tuning = OCEAN_KITE_TUNING.values;
    this.#clothState.wind = this.#lastWind;
    this.#clothState.tautness = tuning.clothTautness;
    this.#clothState.billow = tuning.clothBillow;
    this.#clothState.ripple = tuning.clothRipple;
    this.#clothState.frequency = tuning.clothFrequency;
    this.#clothState.speed = tuning.clothSpeed;
    this.#clothState.gustPhase = Math.sin(this.#lastElapsed * 0.47) * tuning.gustResponse;
    this.#cloth.setState(this.#clothState);
    this.#updateDebug();
    this.group.visible = this.#awake && tuning.enabled;
  }

  tuningDescriptor(): DebugFeatureTuningRegistration {
    return {
      id: "ocean-beach-kite",
      title: "Ocean Beach · purple kite",
      build: (folder) => {
        bindOceanKiteTuning(folder);
        const metrics = folder.addFolder({ title: "metrics", expanded: false });
        const bindings = [
          metrics.addBinding(this.#monitor, "awake", { readonly: true, label: "awake" }),
          metrics.addBinding(this.#monitor, "action", { readonly: true, label: "action" }),
          metrics.addBinding(this.#monitor, "speed", { readonly: true, label: "runner speed" }),
          metrics.addBinding(this.#monitor, "line", { readonly: true, label: "line length" }),
          metrics.addBinding(this.#monitor, "tension", { readonly: true, label: "line tension" }),
          metrics.addBinding(this.#monitor, "altitude", { readonly: true, label: "kite height" }),
          metrics.addBinding(this.#monitor, "cloth", { readonly: true, label: "cloth path" })
        ];
        return { monitors: bindings };
      },
      sync: () => this.syncTuning()
    };
  }

  debugState(): OceanBeachKiteDebugState {
    const ground = this.#map.groundTop(this.#kitePosition.x, this.#kitePosition.z);
    return {
      webgpuCloth: true,
      awake: this.#awake,
      action: this.#currentAction().name,
      runnerSpeed: this.#runnerSpeed,
      lineLength: this.#lineLength,
      lineTarget: this.#lineTarget,
      tension: this.#tension,
      kiteHeight: Math.max(0, this.#kitePosition.y - ground),
      tailLength: this.#tailLength,
      runner: [this.#rig.group.position.x, this.#rig.group.position.y, this.#rig.group.position.z],
      kite: [this.#kitePosition.x, this.#kitePosition.y, this.#kitePosition.z],
      tetherStart: [this.#tetherStart.x, this.#tetherStart.y, this.#tetherStart.z],
      tetherEnd: [this.#tetherEnd.x, this.#tetherEnd.y, this.#tetherEnd.z]
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cloth.dispose();
    for (const material of Object.values(this.#rig.avatar.materials)) material.dispose();
    for (const geometry of new Set(this.#ownedGeometries)) geometry.dispose();
    for (const material of new Set(this.#ownedMaterials)) material.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}

export function createOceanBeachKiteEncounter(
  map: WorldMap,
  site: OceanBeachKiteSite
): OceanBeachKiteEncounter {
  return new KiteEncounter(map, site);
}
