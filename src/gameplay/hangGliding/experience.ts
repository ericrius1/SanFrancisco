import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import { interactKeyLabel, type Input } from "../../core/input";
import type { ChaseCamera } from "../../core/camera";
import type { Player } from "../../player/player";
import type { HUD } from "../../ui/hud";
import type { WorldMap } from "../../world/heightmap";
import type { GameSite } from "../siteGate";
import { HANG_GLIDER_PROFILE } from "../../vehicles/plane/hangGliderPhysics";
import { HangGlidingAudio } from "./audio";
import {
  createHangGlidingCourse,
  sampleHangGlidingLift,
  type HangGlidingCourse
} from "./layout";
import {
  createHangGliderMesh,
  type HangGliderPresentation
} from "./mesh";
import {
  loadHangGliderStyle,
  saveHangGliderStyle,
  type HangGliderStyle
} from "./style";
import { HangGlidingUI, type HangGlidingResult } from "./ui";
import { HangGlidingWorldVisuals } from "./world";
import { HangGlidingOceanLights } from "./oceanLights";

export type HangGlidingPhase = "idle" | "flying" | "result";

const INTERACT_RADIUS = 7.5;
const RESULT_SECONDS = 18;

export class HangGlidingExperience {
  readonly root: THREE.Group;
  readonly ready = Promise.resolve();
  readonly course: HangGlidingCourse;

  #map: WorldMap;
  #physics: Physics;
  #scene: THREE.Scene;
  #world: HangGlidingWorldVisuals;
  #oceanLights: HangGlidingOceanLights;
  #sunElevation: () => number;
  #glider: THREE.Group;
  #presentation: HangGliderPresentation;
  #style: HangGliderStyle;
  #ui: HangGlidingUI;
  #audio = new HangGlidingAudio();
  #platformBody: number;
  #phase: HangGlidingPhase = "idle";
  #awake = false;
  #gate = 0;
  #elapsed = 0;
  #score = 0;
  #resultRemaining = 0;
  #lastPlayer: Player | null = null;
  #savedZoom: number | null = null;
  #activeChase: ChaseCamera | null = null;
  #activeInput: Input | null = null;
  #stallAnnounced = false;
  #disposed = false;

  constructor(map: WorldMap, physics: Physics, scene: THREE.Scene, sunElevation: () => number) {
    this.#map = map;
    this.#physics = physics;
    this.#scene = scene;
    this.#sunElevation = sunElevation;
    this.course = createHangGlidingCourse(map);
    this.#world = new HangGlidingWorldVisuals(this.course);
    this.#oceanLights = new HangGlidingOceanLights(map);
    this.#world.root.add(this.#oceanLights.group);
    this.#style = loadHangGliderStyle();
    const glider = createHangGliderMesh(this.#style);
    this.#glider = glider.root;
    this.#presentation = glider.presentation;
    this.#ui = new HangGlidingUI({
      style: this.#style,
      onStyleChange: (style) => this.#applyStyle(style),
      onCustomizerOpen: () => this.#activeInput?.releaseLock()
    });
    this.root = this.#world.root;
    this.#parkGlider();

    const deck = this.course.deck;
    this.#platformBody = physics.world.createBox({
      type: BodyType.Static,
      position: [deck.x, deck.y, deck.z],
      halfExtents: [deck.hx, deck.hy, deck.hz],
      friction: 0.82
    });
    physics.world.setBodyTransform(this.#platformBody, [deck.x, deck.y, deck.z], [0, 0, 0, 1]);
    physics.addQuerySolid(this.#platformBody, {
      x: deck.x,
      y: deck.y,
      z: deck.z,
      hx: deck.hx,
      hy: deck.hy,
      hz: deck.hz,
      yaw: 0
    });
  }

  get phase(): HangGlidingPhase {
    return this.#phase;
  }

  get active(): boolean {
    return this.#phase === "flying";
  }

  get capturesInteraction(): boolean {
    return this.#phase === "flying" || this.#phase === "result";
  }

  get debugState() {
    return {
      phase: this.#phase,
      awake: this.#awake,
      gate: this.#gate,
      gateCount: this.course.gates.length,
      elapsed: this.#elapsed,
      score: this.#score,
      resultRemaining: this.#resultRemaining,
      rootInScene: this.root.parent === this.#scene,
      courseVisible: this.#world.courseRoot.visible,
      playerHangGliding: this.#lastPlayer?.hangGliding ?? false,
      oceanLights: this.#oceanLights.debugState,
      telemetry: this.#lastPlayer?.hangGliderTelemetry ?? null,
      style: this.#style
    };
  }

  siteHooks(): GameSite {
    return {
      id: "hang-gliding",
      contains: (x, z, pad) =>
        Math.hypot(x - this.course.deck.x, z - this.course.deck.z) <= 92 + pad,
      activatePad: 170,
      deactivatePad: 340,
      keepAwake: () => this.#phase !== "idle",
      setAwake: (on) => this.setAwake(on)
    };
  }

  setAwake(on: boolean): void {
    if (this.#disposed || this.#awake === on) return;
    this.#awake = on;
    if (on) {
      if (this.root.parent !== this.#scene) this.#scene.add(this.root);
      this.root.visible = true;
    } else if (this.#phase === "idle") {
      this.#ui.hide();
      this.root.removeFromParent();
    }
  }

  tryInteract(player: Player, hud: HUD, input: Input, chase: ChaseCamera): boolean {
    if (this.#disposed) return false;
    this.#activeInput = input;
    if (this.#phase === "flying") {
      this.#abortToLaunch(player, hud, chase);
      return true;
    }
    if (this.#phase === "result") {
      if (player.mode !== "walk") return false;
      this.#begin(player, hud, input, chase);
      return true;
    }
    if (!this.#awake || player.mode !== "walk" || player.riding) return false;
    const launchDistance = player.renderPosition.distanceTo(this.#world.promptAnchor);
    if (launchDistance > INTERACT_RADIUS) {
      const liftDistance = player.renderPosition.distanceTo(this.#world.liftAnchor);
      if (liftDistance > INTERACT_RADIUS) return false;
      player.respawn({
        x: this.#world.promptAnchor.x,
        y: this.course.deck.y + this.course.deck.hy + 1.12,
        z: this.#world.promptAnchor.z,
        heading: this.course.launch.heading
      });
      chase.cutTo(player);
      hud.message("Sutro service lift · upper flight deck", 2.4);
      return true;
    }
    this.#begin(player, hud, input, chase);
    return true;
  }

  update(
    dt: number,
    time: number,
    player: Player,
    hud: HUD,
    input: Input,
    chase: ChaseCamera
  ): void {
    if (this.#disposed) return;
    this.#activeInput = input;
    this.#world.update(time, this.#gate);
    this.#oceanLights.update(time, this.#phase === "flying", this.#sunElevation());
    if (this.#phase === "idle") {
      if (!this.#awake || player.mode !== "walk" || player.riding) {
        this.#ui.setPrompt(null);
        return;
      }
      const launchDistance = player.renderPosition.distanceTo(this.#world.promptAnchor);
      const liftDistance = player.renderPosition.distanceTo(this.#world.liftAnchor);
      const atLaunch = launchDistance <= INTERACT_RADIUS;
      const atLift = liftDistance <= INTERACT_RADIUS;
      this.#ui.setPrompt(
        atLaunch || atLift ? interactKeyLabel(input.device) : null,
        atLaunch ? "launch the Skyline Glide" : atLift ? "ride the service lift to the flight deck" : ""
      );
      return;
    }

    if (this.#phase === "result") {
      this.#resultRemaining -= dt;
      if (this.#resultRemaining <= 0) this.#resetIdle();
      return;
    }

    if (!player.hangGliding || player.mode !== "plane") {
      this.releaseForNavigation(player, chase);
      return;
    }

    this.#elapsed += dt;
    this.#lastPlayer = player;
    const telemetry = player.hangGliderTelemetry;
    if (input.pressed("KeyK")) this.#ui.toggleCustomizer();
    this.#audio.update(telemetry.airspeed, telemetry.verticalSpeed, telemetry.lift);
    this.#ui.update({
      gate: this.#gate,
      gateCount: this.course.gates.length,
      seconds: this.#elapsed,
      score: this.#score,
      airspeed: telemetry.airspeed,
      altitude: telemetry.altitude,
      verticalSpeed: telemetry.verticalSpeed,
      lift: telemetry.lift,
      stalled: telemetry.stalled
    });
    this.#ui.setPrompt(interactKeyLabel(input.device), "retire this flight");

    if (telemetry.stalled && !this.#stallAnnounced) {
      this.#stallAnnounced = true;
      hud.message("The wing is murmuring — lower the nose and rebuild airspeed", 2.2);
    } else if (!telemetry.stalled && telemetry.airspeed > 16) {
      this.#stallAnnounced = false;
    }

    this.#presentation.update(dt, telemetry);

    const gate = this.course.gates[this.#gate];
    if (gate) {
      const dx = player.renderPosition.x - gate.x;
      const dy = player.renderPosition.y - gate.y;
      const dz = player.renderPosition.z - gate.z;
      if (dx * dx + dy * dy + dz * dz <= Math.pow(gate.radius * 0.74, 2)) {
        const speedBonus = Math.max(0, 480 - Math.abs(telemetry.airspeed - 22) * 28);
        this.#score += 1000 + Math.round(speedBonus);
        this.#world.completeGate(this.#gate);
        this.#audio.gate(this.#gate);
        this.#gate++;
        this.#ui.showEvent(
          this.#gate === this.course.gates.length ? "All gates · bring it home" : `Gate ${this.#gate} · clean line`
        );
      }
    }

    if (telemetry.landed) this.#finishLanding(player, chase);
  }

  /** Navigation/minigame teardown: release the optional visual and audio but
   * leave placement/mode ownership to NavigationController's transaction. */
  releaseForNavigation(player: Player, chase?: ChaseCamera): void {
    if (this.#phase === "flying") player.stopHangGliding();
    this.#audio.stop();
    this.#restoreCamera(chase ?? this.#activeChase);
    this.#resetIdle();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#phase === "flying") this.#lastPlayer?.stopHangGliding();
    this.#restoreCamera(this.#activeChase);
    this.#audio.dispose();
    this.#ui.dispose();
    // The glider is activity-owned even while parked under the world root.
    // Detach it before world teardown so its geometry has one disposer.
    this.#glider.removeFromParent();
    this.#oceanLights.dispose();
    this.#world.dispose();
    (this.#glider.userData.dispose as (() => void) | undefined)?.();
    this.#physics.removeQuerySolid(this.#platformBody);
    this.#physics.world.destroyBody(this.#platformBody);
    this.#lastPlayer = null;
    this.#activeInput = null;
  }

  #begin(player: Player, hud: HUD, input: Input, chase: ChaseCamera): void {
    this.#lastPlayer = player;
    this.#phase = "flying";
    this.#gate = 0;
    this.#elapsed = 0;
    this.#score = 0;
    this.#resultRemaining = 0;
    this.#stallAnnounced = false;
    this.#world.resetCourse();
    this.#world.setCourseVisible(true);
    this.#ui.begin();
    this.#ui.setPrompt(interactKeyLabel(input.device), "retire this flight");
    this.#audio.begin();
    this.#savedZoom ??= chase.zoom;
    this.#activeChase = chase;
    // Keep the much broader canopy readable on video without inheriting an
    // extreme plane zoom; cutTo below makes this authored framing instantaneous.
    chase.zoom = THREE.MathUtils.clamp(chase.zoom, 1.2, 1.55);
    chase.yaw = this.course.launch.heading;
    this.#glider.removeFromParent();
    this.#glider.position.set(0, 0, 0);
    this.#glider.rotation.set(0, 0, 0);
    this.#glider.scale.setScalar(1);
    player.beginHangGliding(
      this.#glider,
      this.course.launch,
      (x, z, time) => sampleHangGlidingLift(this.course.thermals, x, z, time),
      HANG_GLIDER_PROFILE
    );
    chase.cutTo(player);
    hud.message("Skyline Glide · A/D bank · W/S pitch · Shift tuck · Space flare · K wing atelier", 5.8);
  }

  #abortToLaunch(player: Player, hud: HUD, chase: ChaseCamera): void {
    const launch = this.course.launch;
    player.stopHangGliding({
      x: launch.x + 5.2,
      y: this.course.deck.y + this.course.deck.hy + 1.12,
      z: launch.z,
      heading: launch.heading
    });
    this.#audio.stop();
    this.#restoreCamera(chase);
    this.#resetIdle();
    chase.cutTo(player);
    hud.message("Flight retired · the west wind is ready when you are", 2.6);
  }

  #finishLanding(player: Player, chase: ChaseCamera): void {
    const telemetry = player.hangGliderTelemetry;
    const landing = this.course.landing;
    const accuracy = Math.hypot(player.position.x - landing.x, player.position.z - landing.z);
    const gatesClear = this.#gate === this.course.gates.length;
    const onTarget = accuracy <= landing.radius;
    const soft = telemetry.touchdownSink <= 6.2;
    const success = gatesClear && onTarget && soft;
    const landingPoints = Math.max(0, 3000 * (1 - accuracy / (landing.radius * 1.45)));
    const softPoints = Math.max(0, 1600 * (1 - telemetry.touchdownSink / 7.5));
    const timePoints = Math.max(0, 1700 - this.#elapsed * 7.5);
    if (success) this.#score += Math.round(landingPoints + softPoints + timePoints);
    const rank: HangGlidingResult["rank"] = !success
      ? "C"
      : accuracy <= 7 && telemetry.touchdownSink <= 2.2 && this.#elapsed <= 135
        ? "S"
        : accuracy <= 17 && telemetry.touchdownSink <= 3.6
          ? "A"
          : "B";
    const detail = !gatesClear
      ? `${this.course.gates.length - this.#gate} gate${this.course.gates.length - this.#gate === 1 ? "" : "s"} still lit behind you.`
      : !onTarget
        ? "The line was good, but the park marker slipped past the wingtip."
        : !soft
          ? "You found the marker; carry a little more flare into the grass."
          : rank === "S"
            ? "A feather-soft arrival and a line the tower crew will remember."
            : "Every gate, a settled flare, and San Francisco beneath the sail."
    const result: HangGlidingResult = {
      success,
      rank,
      score: Math.round(this.#score),
      accuracy,
      touchdownSink: telemetry.touchdownSink,
      seconds: this.#elapsed,
      detail
    };

    const x = player.position.x;
    const z = player.position.z;
    const heading = player.heading - Math.PI;
    player.stopHangGliding({
      x,
      y: this.#map.effectiveGround(x, z) + 1.45,
      z,
      heading
    });
    this.#phase = "result";
    this.#resultRemaining = RESULT_SECONDS;
    this.#audio.finish(success);
    this.#restoreCamera(chase);
    this.#ui.finish(result, interactKeyLabel());
    chase.cutTo(player);
  }

  #restoreCamera(chase: ChaseCamera | null): void {
    if (chase && this.#savedZoom !== null) chase.zoom = this.#savedZoom;
    this.#savedZoom = null;
    this.#activeChase = null;
  }

  #resetIdle(): void {
    this.#phase = "idle";
    this.#gate = 0;
    this.#elapsed = 0;
    this.#score = 0;
    this.#resultRemaining = 0;
    this.#world.setCourseVisible(false);
    this.#oceanLights.hide();
    this.#parkGlider();
    this.#ui.hide();
    this.#lastPlayer = null;
    this.#activeInput = null;
  }

  #applyStyle(style: HangGliderStyle): void {
    this.#style = style;
    this.#presentation.setStyle(style);
    saveHangGliderStyle(style);
  }

  #parkGlider(): void {
    if (this.#disposed) return;
    const deck = this.course.deck;
    const launch = this.course.launch;
    this.#glider.position.set(launch.x, deck.y + deck.hy + 1.9, launch.z);
    this.#glider.rotation.set(0, launch.heading, 0);
    this.#glider.scale.setScalar(1);
    this.#glider.visible = true;
    this.root.add(this.#glider);
  }
}
