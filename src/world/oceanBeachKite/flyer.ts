import * as THREE from "three/webgpu";
import type { WorldMap } from "../heightmap";
import { SUN_DIR } from "../sky";
import { avatarFromSeed } from "../../player/avatar";
import { setHandTarget, type HandTarget } from "../../player/handIK";
import { attachToHand, wristTargetForGrip, type GripSpec } from "../../player/held";
import { buildRig, poseWalk, type Rig } from "../../player/rig";
import { FootfallTracker, type SandPrintSink } from "../../fx/sandPrints";
import { enableShadowLayer, SHADOW_LAYERS } from "../shadows/shadowLayers";
import { createKiteCloth, type KiteCloth, type KiteClothState } from "./kiteCloth";
import type { KiteDesign, KitePalette } from "./kiteDesigns";
import {
  createGroundRunner,
  KITE_FIGURES,
  KITE_LOOP_START,
  type KiteFigure,
  type KiteFigureName
} from "./choreography";
import { createWindWindow } from "./windWindow";
import { createKiteTail, type KiteTail } from "./tailRibbon";
import { OCEAN_KITE_TUNING } from "./tuning";

/**
 * One person and the kite on the end of their line: rig, reel, sail, tether,
 * tail, the ground path they run and the wind window their kite lives in.
 *
 * The encounter owns a lane of beach for each of these and nothing else about
 * them; everything a flyer needs to disagree with its neighbours — design,
 * stretch of sand, where it starts in the figure loop — arrives as options.
 */

const RIG_HIP_HEIGHT = 0.92;
const TETHER_POINTS = 30;
const UP = new THREE.Vector3(0, 1, 0);
const LOCAL_X = new THREE.Vector3(1, 0, 0);
const LOCAL_Z = new THREE.Vector3(0, 0, 1);
const TETHER_COOL = new THREE.Color(0xf4eaff);
const TETHER_WARM = new THREE.Color(0xffd7a4);

const REEL_GRIP: GripSpec = {
  position: [-0.14, 0, 0],
  rotation: [0, 0, 0],
  curl: 0.92
};

/**
 * A hand to fly from that this module does not own — the local player's.
 *
 * The owner rewrites both vectors in place every frame; the flyer only reads
 * them. `velocity` is the ONLY pilot input an anchored kite gets, which is the
 * whole point: walk across the wind and your own kite swings, exactly as the
 * beach flyers' running does for theirs.
 */
export type KiteAnchor = {
  /** World position the line leaves from. */
  position: THREE.Vector3;
  /** World velocity of that hand, m/s. */
  velocity: THREE.Vector3;
};

export type KiteFlyerOptions = {
  map: WorldMap;
  design: KiteDesign;
  /** Avatar seed; distinct per flyer so the beach is not three of one person. */
  seed: string;
  /** Centre of this flyer's own stretch of sand. */
  lane: { x: number; z: number };
  /** Eastern edge of dry sand for a given z. */
  beachX: (z: number) => number;
  /** Where in the figure loop this flyer starts. 0 is the arrival launch. */
  startFigure: number;
  /** Seconds already elapsed into that figure, so lanes never march in step. */
  startPhase: number;
  /** Skip the ground-level launch and arrive already flying. */
  startAirborne: boolean;
  /** Fraction of the tuned half-span this flyer patrols; groups run tighter. */
  spanScale?: number;
  /**
   * Mirror every turn and steering input. Give one member of a pair the mirror
   * and the two of them carve opposite arcs — their kites sweep toward each
   * other, cross, and part. It is the cheapest thing on the beach that reads as
   * two people flying together on purpose.
   */
  mirror?: boolean;
  /**
   * This flyer takes its figure clock from a troupe leader instead of running
   * its own. Set by the encounter, which calls adoptFigure() each frame.
   */
  ledByTroupe?: boolean;
  /** Dye override. Defaults to the sail's own authored palette. */
  palette?: KitePalette;
  /**
   * Fly off this hand instead of an authored ground runner. An anchored flyer
   * builds no person and no reel, runs no choreography, and lets the pilot's
   * own motion be the only steering there is.
   */
  anchor?: KiteAnchor;
  /** 0..1 across the tuned line range. Anchored flyers only; figures own it otherwise. */
  lineDial?: number;
  /** Multiplies the deployed tail length. */
  tailScale?: number;
  /**
   * Where this flyer's footfalls go. Shared with the player's — the runtime
   * owns the rules (sand only, near the player only), so a runner just reports
   * that a foot landed. Anchored flyers have no feet and ignore it.
   */
  prints?: SandPrintSink;
};

export type KiteFlyerFrame = {
  dt: number;
  elapsed: number;
  gust: number;
  /** Camera position — the tail ribbon turns its face toward it. */
  view: THREE.Vector3;
  /** Site downwind direction. */
  wind: THREE.Vector3;
  /** Horizontal axis across the wind. */
  crosswind: THREE.Vector3;
  /** 0..1 golden-hour window driving cloth transmission and tail glow. */
  backlight: number;
  /** Half-extent of this flyer's lane along the shore. */
  halfSpan: number;
  beachDepth: number;
};

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

type ReelProp = {
  group: THREE.Group;
  spool: THREE.Group;
  guideGrip: THREE.Object3D;
  lineKnot: THREE.Object3D;
};

export class KiteFlyer {
  readonly group = new THREE.Group();
  readonly design: KiteDesign;
  /** Live kite position; the encounter reads it for shafts and god rays. */
  readonly kitePosition = new THREE.Vector3();

  #map: WorldMap;
  #lane: { x: number; z: number };
  /** Null for an anchored flyer: nobody is standing there. */
  #rig: Rig | null = null;
  #reel: ReelProp | null = null;
  #anchor: KiteAnchor | null;
  #palette: KitePalette;
  #sparMaterial: THREE.MeshStandardMaterial | null = null;
  #accentMaterial: THREE.MeshStandardMaterial | null = null;
  #hemMaterial: THREE.LineBasicMaterial | null = null;
  #reelBodyMaterial: THREE.MeshStandardMaterial | null = null;
  #lineDial: number;
  #tailScale: number;
  /** Anchored launch ramp: 0 the instant the line goes tight, 1 once it flies. */
  #launchRamp: number;
  /** Pilot ground velocity — the runner's, or the anchor hand's. */
  #pilot = { vx: 0, vz: 0 };
  #cloth: KiteCloth;
  #kite = new THREE.Group();
  #bridleKnot = new THREE.Object3D();
  #tailAnchor = new THREE.Object3D();
  #tether: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  #tetherMaterial: THREE.LineBasicMaterial;
  #tail: KiteTail;
  #runner: ReturnType<typeof createGroundRunner> | null = null;
  #window = createWindWindow();

  #ownedGeometries: THREE.BufferGeometry[] = [];
  #ownedMaterials: THREE.Material[] = [];

  #figureIndex: number;
  #figureTime: number;
  #figureFlip = false;
  #mirror: number;
  #spanScale: number;
  #ledByTroupe: boolean;
  #tug = 0;
  #haul = 0;
  #stride = 0;
  #prints: SandPrintSink | null;
  #footfalls = new FootfallTracker();
  #lineLength: number;
  #lineTarget: number;
  #lineChange = 0;
  #reelSpin = 0;
  #tailLength = 0;
  #tension = 0;
  #lastWind = 1;
  #kiteSpeed = 0;
  #disposed = false;

  #kiteVelocity = new THREE.Vector3();
  #kiteTarget = new THREE.Vector3();
  #tetherStart = new THREE.Vector3();
  #tetherEnd = new THREE.Vector3();
  #tailRoot = new THREE.Vector3();
  #lineDelta = new THREE.Vector3();
  #lineDirection = new THREE.Vector3();
  #windowDir = new THREE.Vector3();
  #kiteLocal = new THREE.Vector3();
  #targetLocal = new THREE.Vector3();
  #rightWrist = new THREE.Vector3();
  #leftGrip = new THREE.Vector3();
  #leftWrist = new THREE.Vector3();
  #handAim = new THREE.Quaternion();
  #rightHandTarget: HandTarget = { pos: this.#rightWrist, aim: this.#handAim, hand: 0.92, reach: 0.97 };
  #leftHandTarget: HandTarget = { pos: this.#leftWrist, aim: this.#handAim, hand: 0.9, reach: 0.97 };
  #clothState: KiteClothState = {
    wind: 1,
    tautness: 0.68,
    billow: 0.34,
    ripple: 0.16,
    frequency: 4.2,
    speed: 5.4,
    gustPhase: 0,
    sunDir: new THREE.Vector3().copy(SUN_DIR),
    backlight: 0
  };
  #targetQuat = new THREE.Quaternion();
  #rollQuat = new THREE.Quaternion();
  #pitchQuat = new THREE.Quaternion();
  #basis = new THREE.Matrix4();
  #basisX = new THREE.Vector3();
  #basisY = new THREE.Vector3();
  #basisZ = new THREE.Vector3();

  constructor(options: KiteFlyerOptions) {
    this.#map = options.map;
    this.design = options.design;
    this.#lane = { ...options.lane };
    this.#figureIndex = options.startFigure;
    this.#figureTime = options.startPhase;
    this.#mirror = options.mirror ? -1 : 1;
    this.#spanScale = options.spanScale ?? 1;
    this.#ledByTroupe = Boolean(options.ledByTroupe);
    this.#anchor = options.anchor ?? null;
    this.#palette = options.palette ?? this.design.palette;
    this.#lineDial = THREE.MathUtils.clamp(options.lineDial ?? 0.5, 0, 1);
    this.#tailScale = Math.max(0, options.tailScale ?? 1);
    this.#prints = options.prints ?? null;
    // An anchored kite is handed to a player who is already standing there, so
    // it launches from cold; the beach flyers have their own authored launch.
    this.#launchRamp = this.#anchor ? 0 : 1;

    const tuning = OCEAN_KITE_TUNING.values;
    this.#lineLength = tuning.minLineLength * this.design.lineScale;
    this.#lineTarget = this.#lineLength;

    const startZ = options.lane.z;
    const startX = options.beachX(startZ) + 8;
    this.group.name = this.#anchor
      ? `ocean_beach_player_kite_${this.design.id}`
      : `ocean_beach_kite_flyer_${this.design.id}`;

    if (!this.#anchor) {
      this.#runner = createGroundRunner({
        site: this.#lane,
        beachX: options.beachX,
        start: { x: startX, z: startZ, yaw: Math.PI }
      });
      this.#rig = buildRig(avatarFromSeed(options.seed));
      this.#rig.group.name = `ocean_beach_kite_flyer_rig_${this.design.id}`;
      this.group.add(this.#rig.group);
      this.#reel = this.#buildReel();
      attachToHand(this.#rig, "R", this.#reel.group, REEL_GRIP);
    }

    this.#cloth = createKiteCloth(this.design, this.#palette);
    this.#buildKite();
    this.#kite.name = `ocean_beach_${this.design.id}_kite`;
    this.group.add(this.#kite);

    this.#tetherMaterial = this.#ownMaterial(
      new THREE.LineBasicMaterial({
        color: TETHER_COOL.clone(),
        opacity: 0.82,
        transparent: true,
        depthWrite: false
      })
    );
    this.#tether = createDynamicLine(
      TETHER_POINTS,
      this.#tetherMaterial,
      `ocean_beach_kite_tether_${this.design.id}`
    );
    this.#ownGeometry(this.#tether.geometry);
    this.group.add(this.#tether);

    // The tail lives in world space because its shape is the kite's history,
    // not anything the kite's own matrix can carry.
    this.#tail = createKiteTail({
      ribbonNear: this.#palette.tailA,
      ribbonFar: this.#palette.tailB,
      bows: this.#palette.bows
    });
    this.group.add(this.#tail.mesh, this.#tail.bows);

    if (options.startAirborne) {
      const flight = this.#window.state;
      flight.energy = 0.72;
      flight.elevation = 0.78;
      this.#lineLength = THREE.MathUtils.lerp(tuning.minLineLength, tuning.maxLineLength, 0.6) *
        this.design.lineScale;
      this.#lineTarget = this.#lineLength;
    }

    if (this.#rig) {
      const ground = this.#map.groundTop(startX, startZ);
      this.#rig.group.position.set(startX, ground + RIG_HIP_HEIGHT, startZ);
      poseWalk(this.#rig, 0, 1);
      this.#rig.group.updateMatrixWorld(true);
      this.#tetherStart.set(startX, ground + 1.35, startZ);
    } else {
      this.#tetherStart.copy(this.#anchor!.position);
    }
  }

  /** Second-stage seed: needs the encounter's wind axes and a view point. */
  place(wind: THREE.Vector3, view: THREE.Vector3): void {
    const flight = this.#window.state;
    this.kitePosition
      .copy(this.#tetherStart)
      .addScaledVector(wind, Math.cos(flight.elevation) * Math.max(7, this.#lineLength * 0.62));
    this.kitePosition.y += Math.sin(flight.elevation) * this.#lineLength * 0.62 + 2.4;
    this.#kite.position.copy(this.kitePosition);
    this.#kite.updateMatrixWorld(true);
    this.#bridleKnot.getWorldPosition(this.#tetherEnd);
    this.#tailAnchor.getWorldPosition(this.#tailRoot);
    this.#updateTether(0);
    // Seed the ribbon so the first visible frame is a hanging tail, not a
    // collapsed one snapping into place.
    this.#updateTail(0, 0, view, 0);
  }

  #ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.#ownedGeometries.push(geometry);
    return geometry;
  }

  #ownMaterial<T extends THREE.Material>(material: T): T {
    this.#ownedMaterials.push(material);
    return material;
  }

  #buildReel(): ReelProp {
    const group = new THREE.Group();
    group.name = "kite_reel";
    const spool = new THREE.Group();
    const wood = this.#ownMaterial(new THREE.MeshStandardMaterial({ color: 0x704728, roughness: 0.74 }));
    const violet = this.#ownMaterial(
      new THREE.MeshStandardMaterial({ color: this.#palette.clothLight, roughness: 0.62 })
    );
    this.#reelBodyMaterial = violet;
    const brass = this.#ownMaterial(
      new THREE.MeshStandardMaterial({ color: 0xc99b52, roughness: 0.42, metalness: 0.4 })
    );

    const coreGeometry = this.#ownGeometry(new THREE.CylinderGeometry(0.095, 0.095, 0.23, 12));
    coreGeometry.rotateZ(Math.PI / 2);
    spool.add(new THREE.Mesh(coreGeometry, violet));
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
    // The sail and its frame are the occluders the whole sunset depends on —
    // they have to be in the shadow map for the god-ray raymarch to have
    // anything to carve, and for the kite to lay its own shape on the sand.
    //
    // Except the prism, which is the one sail that is not an occluder at all.
    // A spectral design casts nothing anywhere, so the warm shafts stop at its
    // silhouette and `prismLight` is the only light it throws; the shadow it
    // would otherwise lay on the beach lands the better part of a kilometre
    // downsun at these hours and is no loss.
    const casts = !this.design.spectral;
    this.#cloth.mesh.castShadow = casts;
    if (casts) enableShadowLayer(this.#cloth.mesh, SHADOW_LAYERS.HERO_DYNAMIC);

    const spar = this.#ownMaterial(
      new THREE.MeshStandardMaterial({ color: this.#palette.spar, roughness: 0.78 })
    );
    const accent = this.#ownMaterial(
      new THREE.MeshStandardMaterial({ color: this.#palette.spar, roughness: 0.66 })
    );
    const hem = this.#ownMaterial(
      new THREE.LineBasicMaterial({ color: this.#palette.hem, opacity: 0.9, transparent: true })
    );
    this.#sparMaterial = spar;
    this.#accentMaterial = accent;
    this.#hemMaterial = hem;
    const frame = this.design.buildFrame({
      own: (geometry) => this.#ownGeometry(geometry),
      ownMaterial: (material) => this.#ownMaterial(material),
      spar,
      accent,
      hem
    });
    for (const part of frame) {
      if (part instanceof THREE.Mesh && casts) {
        part.castShadow = true;
        enableShadowLayer(part, SHADOW_LAYERS.HERO_DYNAMIC);
      }
      this.#kite.add(part);
    }

    this.#bridleKnot.name = "kite_bridle_knot";
    this.#bridleKnot.position.set(...(this.design.bridle as [number, number, number]));
    this.#kite.add(this.#bridleKnot);
    this.#tailAnchor.name = "kite_tail_anchor";
    this.#tailAnchor.position.set(...(this.design.tailAnchor as [number, number, number]));
    this.#kite.add(this.#tailAnchor);

    // Four legs from the sail out to the knot, so the line visibly ends on the
    // kite's structure rather than at a point floating in front of it.
    const halfWidth = this.design.width * 0.36;
    const halfHeight = this.design.height * 0.34;
    const knot = this.#bridleKnot.position;
    const bridlePoints = [
      new THREE.Vector3(0, halfHeight, 0.06), knot,
      new THREE.Vector3(halfWidth, 0, 0.06), knot,
      new THREE.Vector3(-halfWidth, 0, 0.06), knot,
      new THREE.Vector3(0, -halfHeight * 0.65, 0.06), knot
    ];
    const bridle = new THREE.LineSegments(
      this.#ownGeometry(new THREE.BufferGeometry().setFromPoints(bridlePoints)),
      this.#ownMaterial(
        new THREE.LineBasicMaterial({ color: 0xf5ecda, opacity: 0.72, transparent: true })
      )
    );
    bridle.name = "kite_bridle";
    this.#kite.add(bridle);
  }

  #currentFigure(): KiteFigure {
    return KITE_FIGURES[this.#figureIndex];
  }

  #advanceFigure(dt: number): void {
    const tempo = Math.max(0.1, OCEAN_KITE_TUNING.values.actionTempo);
    this.#figureTime += dt * tempo;
    const figure = this.#currentFigure();
    // Alternating figures reverse their turn once, at the crossover.
    this.#figureFlip = Boolean(figure.alternate) && this.#figureTime > figure.seconds * 0.5;
    if (this.#figureTime < figure.seconds) return;
    this.#figureTime %= figure.seconds;
    this.#figureFlip = false;
    this.#figureIndex =
      this.#figureIndex === KITE_FIGURES.length - 1 ? KITE_LOOP_START : this.#figureIndex + 1;
    // Every figure opens with the flyer taking the line — a haul that loads the
    // kite and gives the transition a beat instead of a cut.
    this.#tug = Math.max(this.#tug, this.#currentFigure().tug ?? 0);
  }

  #updateLineLength(dt: number): void {
    const tuning = OCEAN_KITE_TUNING.values;
    const scale = this.design.lineScale;
    const minLine = Math.min(tuning.minLineLength, tuning.maxLineLength - 1) * scale;
    const maxLine = Math.max(tuning.maxLineLength * scale, minLine + 1);
    // An anchored kite has no authored figure to reel for it: the dial IS the
    // reel, and the same rate limit makes letting line out read as letting line
    // out rather than as the kite teleporting further away.
    if (this.#anchor) {
      this.#lineTarget = THREE.MathUtils.lerp(minLine, maxLine, this.#lineDial);
      const previous = this.#lineLength;
      const maxStep = Math.max(0.1, tuning.reelRate) * dt;
      this.#lineLength += THREE.MathUtils.clamp(
        this.#lineTarget - this.#lineLength,
        -maxStep,
        maxStep
      );
      this.#lineChange = this.#lineLength - previous;
      return;
    }
    const figure = this.#currentFigure();
    if (figure.reel === 0 || figure.line === undefined) {
      this.#lineTarget = this.#lineLength;
      this.#lineChange = 0;
      return;
    }
    this.#lineTarget = THREE.MathUtils.lerp(minLine, maxLine, figure.line);
    const previous = this.#lineLength;
    const maxStep = Math.max(0.1, tuning.reelRate) * dt;
    this.#lineLength += THREE.MathUtils.clamp(this.#lineTarget - this.#lineLength, -maxStep, maxStep);
    this.#lineLength = THREE.MathUtils.clamp(this.#lineLength, minLine, maxLine);
    this.#lineChange = this.#lineLength - previous;
  }

  /**
   * The anchored counterpart of #updateRunner: no legs to pose, no reel to
   * swing, no footprints in the sand. The line simply starts wherever the owner
   * put the hand this frame, and the hand's own velocity becomes pilot input.
   */
  #updateAnchor(frame: KiteFlyerFrame): void {
    const anchor = this.#anchor!;
    this.#tetherStart.copy(anchor.position);
    this.#pilot.vx = anchor.velocity.x;
    this.#pilot.vz = anchor.velocity.z;
    // Ramp the launch over a couple of seconds. Snapping a 4 m sail to full
    // window energy on frame one looks like a spawn, not like a launch.
    this.#launchRamp = Math.min(1, this.#launchRamp + frame.dt * 0.55);
    this.#tug *= Math.exp(-frame.dt * 2.4);
  }

  #updateRunner(frame: KiteFlyerFrame): void {
    const rig = this.#rig!;
    const reel = this.#reel!;
    const tuning = OCEAN_KITE_TUNING.values;
    const figure = this.#currentFigure();
    const slow = Math.min(tuning.slowRunSpeed, tuning.fastRunSpeed);
    const fast = Math.max(tuning.slowRunSpeed, tuning.fastRunSpeed);
    const turnSign = (this.#figureFlip ? -1 : 1) * this.#mirror;
    const dt = frame.dt;

    this.#runner!.update(dt, {
      speed: THREE.MathUtils.lerp(slow, fast, figure.speed),
      turn: figure.turn * tuning.turnRate * turnSign,
      halfSpan: frame.halfSpan * this.#spanScale,
      beachDepth: frame.beachDepth,
      response: figure.name === "sprint" || figure.name === "launch" ? 3.2 : 1.9
    });
    const runner = this.#runner!.state;
    this.#pilot.vx = runner.vx;
    this.#pilot.vz = runner.vz;

    const ground = this.#map.groundTop(runner.x, runner.z);
    rig.group.position.set(runner.x, ground + RIG_HIP_HEIGHT, runner.z);
    rig.group.rotation.set(0, runner.yaw, runner.lean);

    // Stride is driven by ground speed OR by how hard they are pivoting, so a
    // spin has quick shuffling feet instead of a frozen pair of legs.
    const strideRate = Math.max(runner.speed, Math.abs(runner.turnRate) * 0.85);
    this.#stride += dt * strideRate * 4.1;
    const runBlend = THREE.MathUtils.clamp(
      (runner.speed - slow * 0.65) / Math.max(0.5, fast - slow * 0.65),
      0,
      1
    );
    poseWalk(rig, this.#stride, runBlend);

    // …and the same stride leaves prints where those feet land. Off the same
    // phase the pose reads, so a print appears under the foot that planted it.
    if (this.#prints?.active) {
      const steps = this.#footfalls.advance(this.#stride, true);
      if (steps > 0) {
        // Facing, not velocity: a flyer pivoting on the spot still plants feet.
        const forwardX = -Math.sin(runner.yaw);
        const forwardZ = -Math.cos(runner.yaw);
        for (let i = 0; i < steps; i++) {
          this.#prints.stamp(
            runner.x + forwardX * 0.14,
            runner.z + forwardZ * 0.14,
            forwardX,
            forwardZ,
            this.#footfalls.nextFoot(),
            0.72 + THREE.MathUtils.clamp(runner.speed / 9, 0, 1) * 0.4
          );
        }
      }
    }

    // Body layer: eyes on the kite, chest following them round. `watch` is what
    // separates a jogger from someone flying something.
    rig.group.updateWorldMatrix(true, false);
    this.#kiteLocal.copy(this.kitePosition);
    rig.group.worldToLocal(this.#kiteLocal);
    const horizontal = Math.hypot(this.#kiteLocal.x, this.#kiteLocal.z);
    const lookYaw = THREE.MathUtils.clamp(
      Math.atan2(-this.#kiteLocal.x, -this.#kiteLocal.z),
      -1.05,
      1.05
    );
    const lookPitch = THREE.MathUtils.clamp(
      Math.atan2(this.#kiteLocal.y - 0.62, Math.max(0.2, horizontal)),
      -0.25,
      1.15
    );
    const watch = THREE.MathUtils.clamp(figure.watch, 0, 1);
    rig.head.rotation.y += lookYaw * watch;
    rig.head.rotation.x -= lookPitch * watch * 0.82;
    rig.torso.rotation.y += lookYaw * watch * 0.32;
    // Watching something high pulls the whole spine back a little.
    rig.torso.rotation.x -= lookPitch * watch * 0.16;

    // Hands. Both stay on the reel — that is how a spool is actually held — but
    // the reel itself travels: up toward the kite while watching, back into the
    // chest on a haul, and hand-over-hand while the line is coming in.
    this.#tug *= Math.exp(-dt * 2.4);
    const reeling = THREE.MathUtils.clamp(
      Math.abs(this.#lineChange) / Math.max(1e-5, tuning.reelRate * dt),
      0,
      1
    );
    this.#haul += dt * (2.6 + reeling * 3.4);
    const haulCycle = Math.sin(this.#haul) * reeling;
    this.#targetLocal.set(
      -0.14 + haulCycle * 0.05,
      0.12 + watch * 0.17 + this.#tug * 0.12 + Math.cos(this.#haul) * 0.045 * reeling,
      -0.34 - watch * 0.05 + this.#tug * 0.2 - haulCycle * 0.06
    );
    this.#rightWrist.copy(this.#targetLocal);
    rig.group.localToWorld(this.#rightWrist);
    this.#handAim.copy(rig.group.quaternion);
    setHandTarget(rig, "R", this.#rightHandTarget);
    // getWorldPosition refreshes only the reel's ancestor chain; avoid a full
    // rig traversal between the two IK solves.
    reel.guideGrip.getWorldPosition(this.#leftGrip);
    wristTargetForGrip(rig, "L", this.#leftGrip, this.#handAim, this.#leftWrist);
    setHandTarget(rig, "L", this.#leftHandTarget);

    // The prop follows actual signed line travel. It stops exactly when the
    // tether stops, even if a long authored figure still has time remaining.
    this.#reelSpin += this.#lineChange / 0.095;
    reel.spool.rotation.x = this.#reelSpin;
    reel.lineKnot.getWorldPosition(this.#tetherStart);
  }

  #updateFlight(frame: KiteFlyerFrame): void {
    const tuning = OCEAN_KITE_TUNING.values;
    const figure = this.#currentFigure();
    const pilot = this.#pilot;
    const dt = frame.dt;
    const wind = tuning.windStrength * (0.72 + frame.gust * tuning.gustResponse * 0.72);
    this.#lastWind = wind;

    // An anchored kite has no choreography to steer it and no authored launch:
    // it comes up on its own ramp and everything after that is the player's own
    // feet, arriving through pilotLateral/pilotUpwind below.
    let launchGate = this.#anchor ? smooth01(this.#launchRamp) : 1;
    let steer = 0;
    if (!this.#anchor) {
      if (figure.name === "launch" && this.#figureIndex === 0) {
        launchGate = smooth01(this.#figureTime / Math.max(0.1, figure.seconds * 0.82));
      }
      const flip = (this.#figureFlip ? -1 : 1) * this.#mirror;
      steer = (figure.steer ?? 0) * flip * tuning.steerAuthority;
    }
    this.#window.update({
      dt,
      elapsed: frame.elapsed,
      wind,
      gust: frame.gust,
      steer,
      pilotLateral: pilot.vx * frame.crosswind.x + pilot.vz * frame.crosswind.z,
      pilotUpwind: -(pilot.vx * frame.wind.x + pilot.vz * frame.wind.z),
      tug: this.#tug,
      lift: tuning.lift,
      drag: tuning.drag,
      launchGate,
      // Authored flyers keep their kites HIGH — the whole festival is seen
      // from a beach-length away, and a low kite reads as a kite in the sea
      // (see the note on elevationFloor). Ramped by the launch gate so the
      // arrival's ground start is untouched. The player's own kite keeps the
      // full window: they fly it from arm's length, where low is just low.
      elevationFloor: this.#anchor ? 0 : 0.54 * launchGate
    });
    const flight = this.#window.state;

    // The two window angles become a point on the sphere around the flyer's
    // hand. Nothing else in the flight decides where the kite goes.
    const radial = this.#lineLength * (0.86 + tuning.lineTautness * 0.125);
    this.#windowDir
      .copy(frame.wind)
      .multiplyScalar(Math.cos(flight.swing))
      .addScaledVector(frame.crosswind, Math.sin(flight.swing));
    this.#windowDir.y = 0;
    this.#windowDir.normalize();
    this.#kiteTarget
      .copy(this.#tetherStart)
      .addScaledVector(this.#windowDir, Math.cos(flight.elevation) * radial);
    this.#kiteTarget.y += Math.sin(flight.elevation) * radial;

    const response = 1.8 + tuning.lineTautness * 4.2;
    this.#kiteVelocity.addScaledVector(
      this.#lineDelta.copy(this.#kiteTarget).sub(this.kitePosition),
      response * response * dt
    );
    const damping = 2.1 * response + tuning.drag * 1.8;
    this.#kiteVelocity.multiplyScalar(Math.exp(-damping * dt));
    this.kitePosition.addScaledVector(this.#kiteVelocity, dt);

    // One authored tether constraint, no rigid-body world and no GPU readback.
    this.#lineDelta.copy(this.kitePosition).sub(this.#tetherStart);
    const distance = this.#lineDelta.length();
    if (distance > this.#lineLength) {
      this.#lineDirection.copy(this.#lineDelta).multiplyScalar(1 / Math.max(distance, 1e-5));
      this.kitePosition.copy(this.#tetherStart).addScaledVector(this.#lineDirection, this.#lineLength);
      const outward = this.#kiteVelocity.dot(this.#lineDirection);
      if (outward > 0) this.#kiteVelocity.addScaledVector(this.#lineDirection, -outward);
    }
    this.#tension = THREE.MathUtils.clamp(distance / Math.max(1, this.#lineLength), 0, 1);

    // A kite never touches the sand. The floor also guarantees the tail always
    // has room to hang: it keeps `availableDrop` in #updateTail positive, which
    // is what holds the measured tail-to-sand clearance at its intended value
    // instead of letting a low pass eat into it.
    //
    // Authored flyers carry a much higher floor than the physical one, ramped
    // in with the launch gate: this is the hard backstop under the elevation
    // floor above, so no combination of figure, gust and spring overshoot can
    // ever put a festival kite low enough to project into the sea from a
    // distant lens. Twelve metres, not two — the number is set by camera
    // geometry, not by collision.
    const floor =
      this.surfaceBelowKite() +
      this.design.height * 0.5 +
      0.62 +
      (this.#anchor ? 0 : 12 * launchGate);
    if (this.kitePosition.y < floor) {
      this.kitePosition.y = floor;
      if (this.#kiteVelocity.y < 0) this.#kiteVelocity.y = 0;
    }

    this.#kiteSpeed = this.#kiteVelocity.length();
    this.#kite.position.copy(this.kitePosition);

    // Face the windward cloth toward the flyer and keep the sail upright
    // against the horizon — then bank it into its own swing and lift the nose
    // as it climbs. That roll is the difference between a kite and a signpost.
    this.#basisZ.copy(this.#tetherStart).sub(this.kitePosition).normalize();
    this.#basisY.copy(UP).addScaledVector(this.#basisZ, -UP.dot(this.#basisZ)).normalize();
    this.#basisX.copy(this.#basisY).cross(this.#basisZ).normalize();
    this.#targetQuat.setFromRotationMatrix(
      this.#basis.makeBasis(this.#basisX, this.#basisY, this.#basisZ)
    );
    this.#rollQuat.setFromAxisAngle(LOCAL_Z, flight.bank);
    this.#pitchQuat.setFromAxisAngle(
      LOCAL_X,
      THREE.MathUtils.clamp(flight.elevationVel * 0.22, -0.24, 0.24)
    );
    this.#targetQuat.multiply(this.#rollQuat).multiply(this.#pitchQuat);
    this.#kite.quaternion.slerp(
      this.#targetQuat,
      1 - Math.exp(-dt * (2.8 + tuning.lineTautness * 3))
    );
    this.#kite.updateMatrixWorld(true);
    this.#bridleKnot.getWorldPosition(this.#tetherEnd);
    this.#tailAnchor.getWorldPosition(this.#tailRoot);
  }

  #updateTether(elapsed: number): void {
    const tuning = OCEAN_KITE_TUNING.values;
    const attribute = this.#tether.geometry.getAttribute("position") as THREE.BufferAttribute;
    const array = attribute.array as Float32Array;
    const slack = (1 - tuning.lineTautness) * this.#lineLength * 0.14 + (1 - this.#tension) * 1.4;
    // A haul sends a visible wave up the line before the kite answers it.
    const pull = this.#tug;
    for (let i = 0; i < TETHER_POINTS; i++) {
      const t = i / (TETHER_POINTS - 1);
      const arch = 4 * t * (1 - t);
      const offset = i * 3;
      const travel = Math.sin(t * 9 - elapsed * 7) * pull * arch * 0.5;
      array[offset] = THREE.MathUtils.lerp(this.#tetherStart.x, this.#tetherEnd.x, t);
      array[offset + 1] =
        THREE.MathUtils.lerp(this.#tetherStart.y, this.#tetherEnd.y, t) - arch * slack + travel;
      array[offset + 2] =
        THREE.MathUtils.lerp(this.#tetherStart.z, this.#tetherEnd.z, t) +
        Math.sin(elapsed * 2.1 + t * 8.5) * arch * (1 - tuning.lineTautness) * 0.28;
    }
    attribute.needsUpdate = true;
  }

  #updateTail(dt: number, elapsed: number, view: THREE.Vector3, backlight: number): void {
    // The tail may never touch the sand: the probe measures exactly this
    // clearance, and a tail dragging through the beach reads as a bug.
    //
    // For AUTHORED flyers the clearance is seven metres, not twenty
    // centimetres, and the reason is a lens, not a collision. The kite fix
    // (elevation floor + altitude backstop in #updateFlight) put every SAIL
    // safely above the wave line — and the films still showed "a kite in the
    // ocean", because the diamond's ribbon hung from the sail all the way
    // down to its 0.2 m clearance, and from a head-height camera a hundred
    // metres back everything below about eight metres projects onto the strip
    // of sea between the surf and the sky. The tail END is the lowest point
    // of the whole silhouette; it has to clear the same band the sail does.
    // The player's own kite keeps the sand-tickling 0.2 m — from arm's
    // length that is charm, not a bug.
    const ground = this.surfaceBelowKite();
    const clearance = this.#anchor ? 0.2 : 7.5;
    const availableDrop = Math.max(
      0,
      this.kitePosition.y - ground - this.design.height * 0.5 - clearance
    );
    const deployed = smooth01((this.#window.state.energy - 0.04) / 0.55);
    this.#tailLength = Math.min(
      availableDrop,
      THREE.MathUtils.lerp(0.12, 9.5, deployed) * this.#tailScale
    );
    this.#tail.update({
      dt,
      elapsed,
      root: this.#tailRoot,
      view,
      length: this.#tailLength,
      speed: this.#kiteSpeed,
      wind: this.#lastWind,
      backlight
    });
  }

  /**
   * Whatever the kite would land on: the sand, or the sea's own surface where
   * an offshore leg carries it past the waterline. Using the seabed out there
   * would let the tail hang straight through the water.
   */
  surfaceBelowKite(): number {
    const ground = this.#map.groundTop(this.kitePosition.x, this.kitePosition.z);
    return this.#map.isWater(this.kitePosition.x, this.kitePosition.z)
      ? Math.max(ground, this.#map.meta.seaLevel)
      : ground;
  }

  update(frame: KiteFlyerFrame): void {
    if (this.#disposed) return;
    if (!this.#ledByTroupe && !this.#anchor) this.#advanceFigure(frame.dt);
    this.#updateLineLength(frame.dt);
    if (this.#anchor) this.#updateAnchor(frame);
    else this.#updateRunner(frame);
    this.#updateFlight(frame);
    this.#updateTether(frame.elapsed);
    this.#updateTail(frame.dt, frame.elapsed, frame.view, frame.backlight);
  }

  /** Push tuning + sunset state into the cloth and the line's own tint. */
  syncAppearance(elapsed: number, golden: number, backlight: number): void {
    const tuning = OCEAN_KITE_TUNING.values;
    this.#clothState.wind = this.#lastWind;
    this.#clothState.tautness = tuning.clothTautness;
    this.#clothState.billow = tuning.clothBillow;
    this.#clothState.ripple = tuning.clothRipple;
    this.#clothState.frequency = tuning.clothFrequency;
    this.#clothState.speed = tuning.clothSpeed;
    this.#clothState.gustPhase = Math.sin(elapsed * 0.47) * tuning.gustResponse;
    this.#clothState.sunDir.copy(SUN_DIR);
    this.#clothState.backlight = golden * tuning.clothBacklight;
    this.#cloth.setState(this.#clothState);
    // The line catches the low sun before anything else on the beach does.
    this.#tetherMaterial.color
      .copy(TETHER_COOL)
      .lerp(TETHER_WARM, THREE.MathUtils.clamp(backlight * 1.4, 0, 1));
  }

  /**
   * Re-dye a live kite. Every colour on it is a uniform or a material property,
   * so a swatch press costs no geometry and no pipeline compile — which is what
   * makes the atelier's swatch row feel like a swatch row.
   */
  setPalette(palette: KitePalette): void {
    if (this.#disposed) return;
    this.#palette = palette;
    this.#cloth.setPalette(palette);
    this.#sparMaterial?.color.setHex(palette.spar);
    this.#accentMaterial?.color.setHex(palette.spar);
    this.#hemMaterial?.color.setHex(palette.hem);
    this.#reelBodyMaterial?.color.setHex(palette.clothLight);
    this.#tail.setPalette({
      ribbonNear: palette.tailA,
      ribbonFar: palette.tailB,
      bows: palette.bows
    });
  }

  /** 0..1 across the tuned line range. Anchored flyers only. */
  setLineDial(dial: number): void {
    this.#lineDial = THREE.MathUtils.clamp(dial, 0, 1);
  }

  setTailScale(scale: number): void {
    this.#tailScale = Math.max(0, scale);
  }

  get figure(): KiteFigureName {
    return this.#currentFigure().name;
  }
  get figureIndex(): number {
    return this.#figureIndex;
  }
  get figureTime(): number {
    return this.#figureTime;
  }
  get figureFlip(): boolean {
    return this.#figureFlip;
  }

  /**
   * Take a troupe leader's figure clock. Two flyers on the same figure at the
   * same instant — one of them mirrored — is what "flying together" looks like
   * from a hundred metres away, and it needs no path planning to achieve.
   */
  adoptFigure(leader: KiteFlyer): void {
    if (leader.figureIndex !== this.#figureIndex) {
      this.#figureIndex = leader.figureIndex;
      // Pick up the incoming figure's haul so the whole troupe loads together.
      this.#tug = Math.max(this.#tug, this.#currentFigure().tug ?? 0);
    }
    this.#figureTime = leader.figureTime;
    this.#figureFlip = leader.figureFlip;
  }
  /** Where the flyer stands — the rig's hips, or the anchored hand itself. */
  get runnerPosition(): THREE.Vector3 {
    return this.#rig ? this.#rig.group.position : this.#tetherStart;
  }
  get runnerSpeed(): number {
    return this.#runner
      ? this.#runner.state.speed
      : Math.hypot(this.#pilot.vx, this.#pilot.vz);
  }
  get lineLength(): number {
    return this.#lineLength;
  }
  get lineTarget(): number {
    return this.#lineTarget;
  }
  get tension(): number {
    return this.#tension;
  }
  get tailLength(): number {
    return this.#tailLength;
  }
  get tetherStart(): THREE.Vector3 {
    return this.#tetherStart;
  }
  get tetherEnd(): THREE.Vector3 {
    return this.#tetherEnd;
  }
  get kiteTarget(): THREE.Vector3 {
    return this.#kiteTarget;
  }
  /**
   * The sail's live orientation. Handed out live rather than copied, on the
   * same contract as `kitePosition`: the prism rig holds onto it and reads the
   * roll every frame to swing its fan with the bank.
   */
  get kiteOrientation(): THREE.Quaternion {
    return this.#kite.quaternion;
  }
  get swing(): number {
    return this.#window.state.swing;
  }
  get elevation(): number {
    return this.#window.state.elevation;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#cloth.dispose();
    this.#tail.dispose();
    if (this.#rig) {
      for (const material of Object.values(this.#rig.avatar.materials)) material.dispose();
    }
    for (const geometry of new Set(this.#ownedGeometries)) geometry.dispose();
    for (const material of new Set(this.#ownedMaterials)) material.dispose();
    this.group.removeFromParent();
    this.group.clear();
  }
}
