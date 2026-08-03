import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";
import type { ChaseCamera } from "../../core/camera";
import { interactKeyLabel, type Input } from "../../core/input";
import { WorldSign } from "../../fx/worldSign";
import type { Player } from "../../player/player";
import type { HUD } from "../../ui/hud";
import type { WorldMap } from "../../world/heightmap";
import type { Sky } from "../../world/sky";
import { MARIN_ROCKET_FLIGHT } from "../../vehicles/plane/rocketFlight";
import { MarinRocketAudio } from "./audio";
import { MARIN_ROCKET_ARRIVAL, MARIN_ROCKET_PAD_GROUND_Y, MARIN_ROCKET_SITE } from "./meta";
import { createMarinRocketMesh } from "./mesh";
import { MARIN_SPACE_LAYER, MarinSolarSystem } from "./solarSystem";
import { MarinRocketUI } from "./ui";

export type MarinRocketWorldUi = {
  scene: THREE.Scene;
  beautyDepth?: THREE.Texture | null;
};

const INTERACT_RADIUS = 8.5;
const PAD_HALF_X = 14;
const PAD_HALF_Z = 9;

const STAGE_EVENT = {
  launch: "Marin falling away",
  stratosphere: "Stratosphere",
  edge: "Atmosphere crossed",
  orbit: "Orbital altitude",
  "deep-space": "Deep space"
} as const;

function makeLabelTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#071826";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#70dff5";
  ctx.lineWidth = 10;
  ctx.strokeRect(14, 14, canvas.width - 28, canvas.height - 28);
  ctx.fillStyle = "#ffc75d";
  ctx.font = "800 66px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("MARIN ORBITAL", canvas.width / 2, 106);
  ctx.fillStyle = "#b9dce8";
  ctx.font = "600 30px system-ui, sans-serif";
  ctx.fillText("PACIFIC LAUNCH FIELD · STARJET 01", canvas.width / 2, 178);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function disposeRoot(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      materials.add(material);
      const map = (material as THREE.MeshStandardMaterial).map;
      if (map) textures.add(map);
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

export class MarinRocketExperience {
  readonly root = new THREE.Group();
  readonly ready: Promise<void>;
  readonly craft: THREE.Group;
  readonly padY: number;

  #map: WorldMap;
  #physics: Physics;
  #sky: Sky;
  #ui = new MarinRocketUI();
  #audio = new MarinRocketAudio();
  #solarSystem: MarinSolarSystem;
  #sign: WorldSign;
  #platformBody: number;
  #promptAnchor = new THREE.Vector3();
  #beaconRings: THREE.Mesh[] = [];
  #active = false;
  #lastPlayer: Player | null = null;
  #activeChase: ChaseCamera | null = null;
  #savedZoom: number | null = null;
  #savedCameraLayerMask: number | null = null;
  #stage: keyof typeof STAGE_EVENT = "launch";
  #flightElapsed = 0;
  #disposed = false;

  constructor(map: WorldMap, physics: Physics, sky: Sky, worldUi: MarinRocketWorldUi) {
    this.#map = map;
    this.#physics = physics;
    this.#sky = sky;
    this.root.name = "marin_orbital_launch_field";
    const { x, z, heading } = MARIN_ROCKET_SITE;
    this.padY = MARIN_ROCKET_PAD_GROUND_Y + 0.42;
    const padTop = this.padY + 0.32;
    this.#solarSystem = new MarinSolarSystem(this.padY + 1.45);
    this.root.add(this.#solarSystem.root);
    this.ready = this.#solarSystem.ready;
    this.#sky.mesh.layers.enable(MARIN_SPACE_LAYER);
    this.#sky.sun.layers.enable(MARIN_SPACE_LAYER);
    this.#sky.sun.target.layers.enable(MARIN_SPACE_LAYER);

    const concrete = new THREE.MeshStandardMaterial({ color: 0x6f7777, roughness: 0.91, metalness: 0.08 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x15242b, roughness: 0.68, metalness: 0.46 });
    const white = new THREE.MeshStandardMaterial({ color: 0xdce4df, roughness: 0.68, metalness: 0.18 });
    const copper = new THREE.MeshStandardMaterial({ color: 0x9b5b35, roughness: 0.42, metalness: 0.66 });
    const cyan = new THREE.MeshBasicMaterial({ color: 0x73e6ff });
    const amber = new THREE.MeshBasicMaterial({ color: 0xffbd4d });

    const pad = new THREE.Mesh(new THREE.BoxGeometry(PAD_HALF_X * 2, 0.64, PAD_HALF_Z * 2), concrete);
    pad.position.set(x, this.padY, z);
    pad.receiveShadow = true;
    this.root.add(pad);
    for (const radius of [4.8, 7.2]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.1, 8, 72), white);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(x, padTop + 0.025, z);
      ring.receiveShadow = true;
      this.root.add(ring);
    }
    const centerLine = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.04, PAD_HALF_Z * 1.55), white);
    centerLine.position.set(x, padTop + 0.04, z + 1.2);
    this.root.add(centerLine);

    // Open gantry: enough structure to read as a launch field without enclosing
    // the craft or adding a building-sized optional asset.
    for (const side of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.46, 6.7, 0.46), copper);
      leg.position.set(x + side * 4.65, padTop + 3.35, z + 2.6);
      leg.castShadow = true;
      this.root.add(leg);
      for (let i = 0; i < 4; i++) {
        const brace = new THREE.Mesh(new THREE.BoxGeometry(0.22, 3.1, 0.22), dark);
        brace.position.set(x + side * 4.65, padTop + 1.45 + i * 1.15, z + 2.6);
        brace.rotation.z = side * (i % 2 ? 0.78 : -0.78);
        this.root.add(brace);
      }
    }
    const topBeam = new THREE.Mesh(new THREE.BoxGeometry(9.8, 0.5, 0.55), copper);
    topBeam.position.set(x, padTop + 6.55, z + 2.6);
    topBeam.castShadow = true;
    this.root.add(topBeam);

    // Readable placard lives on the world-UI overlay (post-chain bypass) so TAA
    // and grain cannot soften the lettering. Beauty depth still occludes it.
    this.#sign = new WorldSign({
      scene: worldUi.scene,
      map: makeLabelTexture(),
      width: 7.2,
      height: 1.8,
      name: "marin_orbital_sign",
      beautyDepth: worldUi.beautyDepth
    });
    this.#sign.mesh.position.set(x + 8.6, padTop + 2.15, z + 8.85);
    // Face the safe walk-in arrival on the east apron.
    this.#sign.mesh.rotation.y = Math.atan2(
      MARIN_ROCKET_ARRIVAL.x - this.#sign.mesh.position.x,
      MARIN_ROCKET_ARRIVAL.z - this.#sign.mesh.position.z
    );

    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const lamp = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.075, 6, 16), i % 2 ? cyan : amber);
      lamp.rotation.x = Math.PI / 2;
      lamp.position.set(x + Math.cos(a) * 11.7, padTop + 0.14, z + Math.sin(a) * 7.2);
      lamp.renderOrder = 3;
      this.root.add(lamp);
      this.#beaconRings.push(lamp);
    }

    // A short boarding stair on the starboard side. The prompt sits at its foot.
    for (let i = 0; i < 5; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.65, 0.18, 0.42), dark);
      step.position.set(x + 2.25, padTop + 0.1 + i * 0.17, z - 0.7 + i * 0.36);
      step.castShadow = true;
      step.receiveShadow = true;
      this.root.add(step);
    }
    this.#promptAnchor.set(x + 2.25, padTop + 0.25, z - 1.45);

    this.craft = createMarinRocketMesh();
    this.craft.traverse((object) => object.layers.enable(MARIN_SPACE_LAYER));
    this.root.add(this.craft);
    this.#parkCraft();

    this.#platformBody = physics.world.createBox({
      type: BodyType.Static,
      position: [x, this.padY, z],
      halfExtents: [PAD_HALF_X, 0.32, PAD_HALF_Z],
      friction: 0.84
    });
    physics.world.setBodyTransform(this.#platformBody, [x, this.padY, z], [0, 0, 0, 1]);
    physics.addQuerySolid(this.#platformBody, {
      x,
      y: this.padY,
      z,
      hx: PAD_HALF_X,
      hy: 0.32,
      hz: PAD_HALF_Z,
      yaw: 0
    });
    this.root.userData.sfDebug = () => this.debugState;
    this.root.rotation.y = 0;
    // The craft is authored along local -Z; its world yaw is applied directly
    // while parked and by the shared plane body in flight.
    void heading;
  }

  get active(): boolean {
    return this.#active;
  }

  get capturesInteraction(): boolean {
    return this.#active;
  }

  get debugState() {
    return {
      active: this.#active,
      stage: this.#stage,
      padY: this.padY,
      craftParked: this.craft.parent === this.root,
      playerRocketFlying: this.#lastPlayer?.rocketFlying ?? false,
      telemetry: this.#lastPlayer?.rocketTelemetry ?? null,
      flightElapsed: this.#flightElapsed,
      spaceView: this.#savedCameraLayerMask !== null,
      solarSystem: this.#solarSystem.debugState
    };
  }

  tryInteract(player: Player, hud: HUD, input: Input, chase: ChaseCamera): boolean {
    if (this.#disposed) return false;
    if (this.#active) {
      this.#returnToMarin(player, hud, chase);
      return true;
    }
    if (player.mode !== "walk" || player.riding) return false;
    if (player.renderPosition.distanceTo(this.#promptAnchor) > INTERACT_RADIUS) return false;
    this.#begin(player, hud, input, chase);
    return true;
  }

  update(dt: number, time: number, player: Player, hud: HUD, input: Input, chase: ChaseCamera): void {
    if (this.#disposed) return;
    // Headlands toggles root visibility without disposing; keep the overlay sign
    // in lockstep (it is not a child of this.root).
    this.#sign.mesh.visible = this.root.visible;
    for (let i = 0; i < this.#beaconRings.length; i++) {
      const pulse = 0.72 + Math.sin(time * 2.5 + i * 0.86) * 0.22;
      this.#beaconRings[i].scale.setScalar(pulse);
    }
    if (!this.#active) {
      const near =
        this.root.visible &&
        player.mode === "walk" &&
        !player.riding &&
        player.renderPosition.distanceTo(this.#promptAnchor) <= INTERACT_RADIUS;
      this.#ui.setPrompt(
        near ? interactKeyLabel(input.device) : null,
        "board Starjet 01 · fly beyond the atmosphere"
      );
      return;
    }
    if (!player.rocketFlying || player.mode !== "plane") {
      this.releaseForNavigation(player, chase);
      return;
    }

    this.#lastPlayer = player;
    this.#flightElapsed += dt;
    const telemetry = player.rocketTelemetry;
    this.#sky.setSpaceFactor(telemetry.spaceFactor);
    this.#audio.update(telemetry);
    const inSpace = telemetry.stage === "orbit" || telemetry.stage === "deep-space";
    this.#setSpaceView(inSpace, chase, player);
    if (inSpace && (input.pressed("KeyQ") || input.pressed("KeyR"))) {
      const target = this.#solarSystem.cycleTarget(input.pressed("KeyR") ? -1 : 1);
      this.#ui.showEvent(`Target · ${target.label}`);
      hud.message(`${target.label} selected · turn toward its gold locator`, 2.2);
    }
    const navigation = this.#solarSystem.update(
      player.renderPosition,
      chase.camera,
      telemetry,
      this.#flightElapsed
    );
    this.#ui.update(telemetry, navigation);
    this.#ui.setPrompt(interactKeyLabel(input.device), "return to Marin Orbital");
    if (navigation?.reached) {
      const stop = navigation.reached;
      const index = this.#solarSystem.debugState.visited.length;
      this.#ui.showEvent(`${stop.label} flyby`);
      this.#audio.milestone(index);
      hud.message(
        navigation.complete
          ? `${stop.label} reached · every world has now been visited`
          : `${stop.label} reached · Q/R selects another destination`,
        3.4
      );
    }
    if (telemetry.stage !== this.#stage) {
      this.#stage = telemetry.stage;
      const index = ["launch", "stratosphere", "edge", "orbit", "deep-space"].indexOf(this.#stage);
      this.#ui.showEvent(STAGE_EVENT[this.#stage]);
      this.#audio.milestone(Math.max(0, index));
      if (this.#stage === "orbit") hud.message("Space navigation online · Q/R selects any labeled world", 3.6);
      if (this.#stage === "deep-space") hud.message("Deep space reached · follow any projected world marker", 3.6);
    }
  }

  releaseForNavigation(player: Player, chase?: ChaseCamera): void {
    if (this.#active && player.rocketFlying) player.stopRocketFlight();
    this.#active = false;
    this.#sky.setSpaceFactor(0);
    this.#audio.stop();
    this.#solarSystem.stop();
    this.#ui.hideFlight();
    this.#ui.setPrompt(null);
    this.#restoreCamera(chase ?? this.#activeChase);
    this.#parkCraft();
    this.#lastPlayer = null;
    this.#stage = "launch";
    this.#flightElapsed = 0;
  }

  dispose(): void {
    if (this.#disposed) return;
    if (this.#active && this.#lastPlayer?.rocketFlying) this.#lastPlayer.stopRocketFlight();
    this.#disposed = true;
    this.#sky.setSpaceFactor(0);
    this.#restoreCamera(this.#activeChase);
    this.#audio.dispose();
    this.#solarSystem.dispose();
    this.#ui.dispose();
    this.#sign.dispose();
    this.#physics.removeQuerySolid(this.#platformBody);
    this.#physics.world.destroyBody(this.#platformBody);
    this.craft.removeFromParent();
    (this.craft.userData.dispose as (() => void) | undefined)?.();
    disposeRoot(this.root);
    this.root.removeFromParent();
    this.#lastPlayer = null;
  }

  #begin(player: Player, hud: HUD, input: Input, chase: ChaseCamera): void {
    this.#active = true;
    this.#lastPlayer = player;
    this.#activeChase = chase;
    this.#stage = "launch";
    this.#flightElapsed = 0;
    this.#savedZoom ??= chase.zoom;
    chase.zoom = THREE.MathUtils.clamp(chase.zoom, 1.05, 1.38);
    chase.yaw = MARIN_ROCKET_SITE.heading;
    chase.pitch = -0.24;
    this.craft.removeFromParent();
    player.beginRocketFlight(
      this.craft,
      {
        x: MARIN_ROCKET_SITE.x,
        y: this.padY + 1.45,
        z: MARIN_ROCKET_SITE.z,
        heading: MARIN_ROCKET_SITE.heading
      },
      MARIN_ROCKET_FLIGHT
    );
    player.meshes.plane.traverse((object) => object.layers.enable(MARIN_SPACE_LAYER));
    this.#sky.setSpaceFactor(0);
    this.#audio.begin();
    this.#solarSystem.begin();
    this.#ui.begin();
    this.#ui.setPrompt(interactKeyLabel(input.device), "return to Marin Orbital");
    chase.cutTo(player);
    hud.message("Starjet 01 · reach orbit, then Q/R selects any world · E returns to Marin", 6);
  }

  #returnToMarin(player: Player, hud: HUD, chase: ChaseCamera): void {
    player.stopRocketFlight({
      x: MARIN_ROCKET_ARRIVAL.x,
      y: this.#map.effectiveGround(MARIN_ROCKET_ARRIVAL.x, MARIN_ROCKET_ARRIVAL.z) + 1.5,
      z: MARIN_ROCKET_ARRIVAL.z,
      heading: MARIN_ROCKET_ARRIVAL.heading
    });
    this.#active = false;
    this.#sky.setSpaceFactor(0);
    this.#audio.stop();
    this.#solarSystem.stop();
    this.#ui.hideFlight();
    this.#restoreCamera(chase);
    this.#parkCraft();
    this.#lastPlayer = null;
    this.#stage = "launch";
    this.#flightElapsed = 0;
    chase.cutTo(player);
    hud.message("Welcome back to Marin Orbital · Starjet 01 is recharged", 2.8);
  }

  #parkCraft(): void {
    if (this.#disposed) return;
    this.craft.position.set(MARIN_ROCKET_SITE.x, this.padY + 1.38, MARIN_ROCKET_SITE.z);
    this.craft.rotation.set(0, MARIN_ROCKET_SITE.heading, 0);
    this.craft.scale.setScalar(1);
    this.craft.visible = true;
    this.root.add(this.craft);
  }

  #restoreCamera(chase: ChaseCamera | null): void {
    if (chase) {
      if (this.#savedZoom !== null) chase.zoom = this.#savedZoom;
      if (this.#savedCameraLayerMask !== null) {
        chase.camera.layers.mask = this.#savedCameraLayerMask;
      }
    }
    this.#savedZoom = null;
    this.#savedCameraLayerMask = null;
    this.#activeChase = null;
  }

  #setSpaceView(enabled: boolean, chase: ChaseCamera, player: Player): void {
    if (enabled) {
      if (this.#savedCameraLayerMask !== null) return;
      player.meshes.plane.traverse((object) => object.layers.enable(MARIN_SPACE_LAYER));
      this.#savedCameraLayerMask = chase.camera.layers.mask;
      chase.camera.layers.disableAll();
      chase.camera.layers.enable(MARIN_SPACE_LAYER);
      chase.cutTo(player);
      return;
    }
    if (this.#savedCameraLayerMask === null) return;
    chase.camera.layers.mask = this.#savedCameraLayerMask;
    this.#savedCameraLayerMask = null;
    chase.cutTo(player);
  }
}

export function createMarinRocketExperience(
  map: WorldMap,
  physics: Physics,
  sky: Sky,
  worldUi: MarinRocketWorldUi
): MarinRocketExperience {
  return new MarinRocketExperience(map, physics, sky, worldUi);
}
