import * as THREE from "three/webgpu";
import {
  color,
  float,
  mix,
  oscSine,
  time,
  uniform
} from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import type { Input } from "../../core/input";
import { avatarFromSeed, type AvatarTraits } from "../../player/avatar";
import { setHandTarget } from "../../player/handIK";
import { buildRig, poseIdle, setHandPose, type Rig } from "../../player/rig";
import { CANVAS_FONT_FAMILY } from "../../core/typography";
import type { WorldMap } from "../../world/heightmap";
import { AFTERLIGHT_CENTER, AFTERLIGHT_TUNING, ECHO_LAYOUT, KEEPER_LAYOUT } from "./layout";
import { CosmicEnergyWeb, WEB_TUNING } from "./energyWeb";
import { makeSubsurfaceOrbMaterial } from "./subsurfaceOrb";
import { makeVolumetricOrbMaterial, type ScalarUniform } from "./volumeOrb";

type N = any;

export type EchoVisual = {
  root: THREE.Group;
  float: THREE.Group;
  rings: THREE.Group;
  home: THREE.Vector3;
  target: THREE.Vector3;
  glow: ScalarUniform;
};

type PetalVisual = {
  group: THREE.Group;
  activation: ScalarUniform;
  beam: THREE.Mesh;
  target: THREE.Vector3;
};

type KeeperVisual = {
  rig: Rig;
  label: THREE.Sprite;
  phase: number;
};

type Celebrant = {
  rig: Rig;
  phase: number;
  armPhase: number;
  swirl: number;
  stationPosition: THREE.Vector3;
  stationYaw: number;
  observerTarget: THREE.Vector3;
  observerYaw: number;
  observerBlend: number;
  controlBaseL: THREE.Vector3;
  controlBaseR: THREE.Vector3;
  controlTargetL: THREE.Vector3;
  controlTargetR: THREE.Vector3;
  controlSmoothL: THREE.Vector3;
  controlSmoothR: THREE.Vector3;
  controlWorldL: THREE.Vector3;
  controlWorldR: THREE.Vector3;
};

type AnchorBinding = {
  celebrantIndex: number;
  side: "L" | "R";
};

type InteractionBeacon = {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
  context: CanvasRenderingContext2D;
  key: string;
  action: string;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampHandTarget(target: THREE.Vector3, base: THREE.Vector3): void {
  target.x = THREE.MathUtils.clamp(target.x, base.x - 1.15, base.x + 1.15);
  target.y = THREE.MathUtils.clamp(target.y, base.y - 0.9, base.y + 1.25);
  target.z = THREE.MathUtils.clamp(target.z, base.z - 0.9, base.z + 0.7);
}

/** Decorative crowd rigs receive world light but do not enter shadow passes. */
function configureLightweightRig(rig: Rig): void {
  rig.group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) mesh.castShadow = false;
  });
}

function makeRadialTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(48, 48, 0, 48, 48, 47);
  gradient.addColorStop(0, "rgba(255,255,245,1)");
  gradient.addColorStop(0.14, "rgba(212,255,242,.96)");
  gradient.addColorStop(0.42, "rgba(145,221,255,.38)");
  gradient.addColorStop(1, "rgba(90,150,255,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 96, 96);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function makeNameTag(text: string, accent: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 92;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#08141a";
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(46, 12, 228, 58, 24);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#f4fcf8";
  ctx.font = `600 30px ${CANVAS_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 160, 42);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    fog: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(3.1, 0.9, 1);
  sprite.renderOrder = 25;
  return sprite;
}

function makeInteractionBeacon(): InteractionBeacon {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 144;
  const context = canvas.getContext("2d")!;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    fog: false
  });
  const sprite = new THREE.Sprite(material);
  sprite.name = "afterlight-takeover-beacon";
  sprite.scale.set(4.15, 0.94, 1);
  sprite.renderOrder = 42;
  sprite.visible = false;
  return { sprite, texture, context, key: "", action: "" };
}

function drawInteractionBeacon(beacon: InteractionBeacon, key: string, action: string): void {
  if (beacon.key === key && beacon.action === action) return;
  beacon.key = key;
  beacon.action = action;
  const { context: ctx } = beacon;
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.save();
  ctx.shadowColor = "rgba(92, 242, 255, .45)";
  ctx.shadowBlur = 22;
  ctx.fillStyle = "rgba(5, 15, 25, .9)";
  ctx.strokeStyle = "rgba(132, 244, 255, .9)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(42, 20, 556, 104, 36);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "rgba(117, 236, 240, .2)";
  ctx.strokeStyle = "rgba(255, 235, 180, .95)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(64, 35, 74, 74, 19);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#fff0c2";
  ctx.font = `800 37px ${CANVAS_FONT_FAMILY}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(key, 101, 73);
  ctx.fillStyle = "#eafcff";
  ctx.font = `750 29px ${CANVAS_FONT_FAMILY}`;
  ctx.textAlign = "left";
  ctx.letterSpacing = "2px";
  ctx.fillText(action, 166, 75);
  ctx.restore();
  beacon.texture.needsUpdate = true;
}

function disposeRig(rig: Rig | null): void {
  if (!rig) return;
  for (const material of Object.values(rig.avatar.materials)) material.dispose();
  rig.group.removeFromParent();
}

function makeBeamMaterial(hue: number, activation: ScalarUniform): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial();
  const shimmer = oscSine(time.mul(0.73).add(hue * 0.00004)) as N;
  material.colorNode = mix(color(hue), color(0xfff6da), shimmer.mul(0.38))
    .mul((activation as N).mul(LIGHT_SCALE * 0.62));
  material.opacityNode = (activation as N).mul(shimmer.mul(0.22).add(0.34));
  material.transparent = true;
  material.depthWrite = false;
  material.blending = THREE.AdditiveBlending;
  material.fog = false;
  return material;
}

function buildTelescope(): THREE.Group {
  const group = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({ color: 0x9a7241, metalness: 0.72, roughness: 0.28 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a282d, metalness: 0.38, roughness: 0.42 });
  for (let i = 0; i < 3; i++) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.055, 2.1, 7), dark);
    const angle = (i / 3) * Math.PI * 2;
    leg.position.set(Math.cos(angle) * 0.42, 0.95, Math.sin(angle) * 0.42);
    leg.rotation.z = Math.cos(angle) * 0.22;
    leg.rotation.x = Math.sin(angle) * 0.22;
    group.add(leg);
  }
  const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 2.35, 14), brass);
  tube.rotation.x = Math.PI / 2;
  tube.rotation.z = -0.18;
  tube.position.set(0, 2.05, 0);
  group.add(tube);
  const eyepiece = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.1, 0.35, 12), dark);
  eyepiece.rotation.x = Math.PI / 2;
  eyepiece.rotation.z = -0.18;
  eyepiece.position.set(0.16, 2.28, 1.18);
  group.add(eyepiece);
  group.rotation.y = -0.64;
  return group;
}

function buildReel(): THREE.Group {
  const group = new THREE.Group();
  const brass = new THREE.MeshStandardMaterial({ color: 0xb68a4b, metalness: 0.75, roughness: 0.24 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x5d3d2b, roughness: 0.72 });
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.07, 8, 28), brass);
  wheel.position.y = 1.08;
  wheel.rotation.y = Math.PI / 2;
  group.add(wheel);
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.08, 1.45, 8), wood);
    post.position.set(side * 0.46, 0.72, 0);
    group.add(post);
  }
  const axle = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 1.2, 10), brass);
  axle.rotation.z = Math.PI / 2;
  axle.position.y = 1.08;
  group.add(axle);
  return group;
}

function disposeSprite(sprite: THREE.Sprite): void {
  const material = sprite.material as THREE.SpriteMaterial;
  material.map?.dispose();
  material.dispose();
}

export class AfterlightSiteVisuals {
  readonly root = new THREE.Group();
  readonly centerY: number;
  readonly echoes: EchoVisual[] = [];

  #map: WorldMap;
  #petals: PetalVisual[] = [];
  #keepers: KeeperVisual[] = [];
  #loomRings = new THREE.Group();
  #loomCharge = uniform(0);
  #glowTexture = makeRadialTexture();
  #celebrants: Celebrant[] = [];
  #playerRig: Rig | null = null;
  #web: CosmicEnergyWeb | null = null;
  #anchorBindings: AnchorBinding[] = [];
  #controlledCelebrant = -1;
  #controlHalo: THREE.Mesh | null = null;
  #interactionBeacon: InteractionBeacon | null = null;
  #interactionBeaconBaseY = 0;
  #takeoverMotion = 0;
  #energy = WEB_TUNING.baseEnergy;
  #energyTarget = WEB_TUNING.baseEnergy;
  #handWorld = new THREE.Vector3();
  #elapsed = 0;

  constructor(map: WorldMap) {
    this.#map = map;
    this.centerY = map.groundTop(AFTERLIGHT_CENTER.x, AFTERLIGHT_CENTER.z);
    this.root.name = "afterlight-grove";
    this.root.position.set(AFTERLIGHT_CENTER.x, this.centerY, AFTERLIGHT_CENTER.z);
    this.root.visible = false;
    this.#buildGroundRing();
    this.#buildLoom();
    this.#buildEchoes();
    this.#buildKeepers();
    this.#buildCelebrants();
  }

  setAwake(on: boolean): void {
    this.root.visible = on;
    this.#web?.setAwake(on);
  }

  setLabelsVisible(on: boolean): void {
    for (const keeper of this.#keepers) keeper.label.visible = on;
  }

  get controlsCaptured(): boolean {
    return this.#controlledCelebrant >= 0;
  }

  get controlledCelebrant(): number {
    return this.#controlledCelebrant;
  }

  get webDiagnosticsActive(): boolean {
    return this.#web?.diagnosticsActive ?? false;
  }

  toggleWebDiagnostics(): boolean {
    return this.#web?.toggleDiagnostics() ?? false;
  }

  setWebDiagnosticsFocus(focused: boolean, key: string): void {
    this.#web?.setDiagnosticsFocus(focused, key);
  }

  /** Nearest participant in world space, or -1 when none can be claimed. */
  nearestCelebrant(worldX: number, worldZ: number, radius = AFTERLIGHT_TUNING.takeoverRadius): number {
    const localX = worldX - AFTERLIGHT_CENTER.x;
    const localZ = worldZ - AFTERLIGHT_CENTER.z;
    let nearest = -1;
    let nearestSq = radius * radius;
    for (let i = 0; i < this.#celebrants.length; i++) {
      const position = this.#celebrants[i].rig.group.position;
      const dx = localX - position.x;
      const dz = localZ - position.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= nearestSq) continue;
      nearestSq = distanceSq;
      nearest = i;
    }
    return nearest;
  }

  celebrantDistance(index: number, worldX: number, worldZ: number): number {
    const celebrant = this.#celebrants[index];
    if (!celebrant) return Infinity;
    return Math.hypot(
      worldX - (AFTERLIGHT_CENTER.x + celebrant.rig.group.position.x),
      worldZ - (AFTERLIGHT_CENTER.z + celebrant.rig.group.position.z)
    );
  }

  beginTakeover(index: number, avatar: AvatarTraits, key: string): boolean {
    const celebrant = this.#celebrants[index];
    if (!celebrant) return false;
    if (this.#controlledCelebrant >= 0) this.endTakeover();
    const playerRig = buildRig(avatar);
    configureLightweightRig(playerRig);
    playerRig.group.position.copy(celebrant.stationPosition);
    playerRig.group.rotation.y = celebrant.stationYaw;
    poseIdle(playerRig, this.#elapsed + 0.37);
    this.root.add(playerRig.group);
    this.#playerRig = playerRig;
    this.#controlledCelebrant = index;
    this.root.updateMatrixWorld(true);
    playerRig.handL.getWorldPosition(this.#handWorld);
    playerRig.group.worldToLocal(this.#handWorld);
    celebrant.controlBaseL.copy(this.#handWorld);
    celebrant.controlTargetL.copy(this.#handWorld);
    celebrant.controlSmoothL.copy(this.#handWorld);
    playerRig.handR.getWorldPosition(this.#handWorld);
    playerRig.group.worldToLocal(this.#handWorld);
    celebrant.controlBaseR.copy(this.#handWorld);
    celebrant.controlTargetR.copy(this.#handWorld);
    celebrant.controlSmoothR.copy(this.#handWorld);
    celebrant.observerBlend = 0;
    this.setInteractionFocus(index, key, true);
    this.#takeoverMotion = Math.max(this.#takeoverMotion, 0.45);
    return true;
  }

  endTakeover(): void {
    const celebrant = this.#celebrants[this.#controlledCelebrant];
    if (celebrant) {
      celebrant.rig.group.position.copy(celebrant.stationPosition);
      celebrant.rig.group.rotation.y = celebrant.stationYaw;
      celebrant.observerBlend = 0;
    }
    disposeRig(this.#playerRig);
    this.#playerRig = null;
    this.#controlledCelebrant = -1;
    if (this.#controlHalo) this.#controlHalo.visible = false;
    if (this.#interactionBeacon) this.#interactionBeacon.sprite.visible = false;
  }

  /** Pair the HUD affordance with an unmistakable in-world focus marker. */
  setInteractionFocus(index: number, key: string, captured = false): void {
    const celebrant = this.#celebrants[index];
    if (!celebrant || (this.#controlledCelebrant >= 0 && index !== this.#controlledCelebrant)) {
      if (this.#controlledCelebrant < 0) {
        if (this.#controlHalo) this.#controlHalo.visible = false;
        if (this.#interactionBeacon) this.#interactionBeacon.sprite.visible = false;
      }
      return;
    }
    if (this.#controlHalo) {
      this.#controlHalo.position.set(
        celebrant.stationPosition.x,
        this.#groundY(celebrant.stationPosition.x, celebrant.stationPosition.z) + 0.07,
        celebrant.stationPosition.z
      );
      this.#controlHalo.visible = true;
    }
    if (this.#interactionBeacon) {
      drawInteractionBeacon(this.#interactionBeacon, key, captured ? "RELEASE CONTROL" : "TAKE OVER");
      this.#interactionBeaconBaseY = celebrant.stationPosition.y + 3.28;
      this.#interactionBeacon.sprite.position.set(
        celebrant.stationPosition.x,
        this.#interactionBeaconBaseY,
        celebrant.stationPosition.z
      );
      this.#interactionBeacon.sprite.visible = true;
    }
  }

  /** Capture one frame of player input and turn it into two reachable hand targets. */
  driveTakeover(input: Input, dt: number): void {
    const celebrant = this.#celebrants[this.#controlledCelebrant];
    if (!celebrant) return;
    const step = Math.min(Math.max(dt, 0), 0.05);
    let motion = 0;
    if (input.device === "pad") {
      const axes = input.mapPadAxes();
      const speed = 1.85 * step;
      celebrant.controlTargetL.x += axes.lx * speed;
      celebrant.controlTargetL.y -= axes.ly * speed;
      celebrant.controlTargetR.x += axes.rx * speed;
      celebrant.controlTargetR.y -= axes.ry * speed;
      celebrant.controlTargetL.z = celebrant.controlBaseL.z - axes.lt * 0.82;
      celebrant.controlTargetR.z = celebrant.controlBaseR.z - axes.rt * 0.82;
      motion = (Math.abs(axes.lx) + Math.abs(axes.ly) + Math.abs(axes.rx) + Math.abs(axes.ry)) * step
        + Math.abs(axes.lt) * 0.025
        + Math.abs(axes.rt) * 0.025;
    } else {
      const dx = THREE.MathUtils.clamp(input.mouseDX * 0.0042, -0.22, 0.22);
      const dy = THREE.MathUtils.clamp(-input.mouseDY * 0.0042, -0.22, 0.22);
      const dz = THREE.MathUtils.clamp(-input.wheel * 0.00125, -0.22, 0.22);
      const leftOnly = input.holding("ShiftLeft");
      const rightOnly = input.fireHeld && !leftOnly;
      if (leftOnly) {
        celebrant.controlTargetL.x += dx;
        celebrant.controlTargetL.y += dy;
        celebrant.controlTargetL.z += dz;
      } else if (rightOnly) {
        celebrant.controlTargetR.x += dx;
        celebrant.controlTargetR.y += dy;
        celebrant.controlTargetR.z += dz;
      } else {
        // Mirrored pair: horizontal motion opens/closes the span while vertical
        // and scroll move both hands together.
        celebrant.controlTargetL.x += dx;
        celebrant.controlTargetR.x -= dx;
        celebrant.controlTargetL.y += dy;
        celebrant.controlTargetR.y += dy;
        celebrant.controlTargetL.z += dz;
        celebrant.controlTargetR.z += dz;
      }
      motion = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    }
    clampHandTarget(celebrant.controlTargetL, celebrant.controlBaseL);
    clampHandTarget(celebrant.controlTargetR, celebrant.controlBaseR);
    this.#takeoverMotion = Math.max(this.#takeoverMotion, Math.min(1, motion * 4.2));
    input.captureActivity();
  }

  takeoverDebugState(): {
    index: number | null;
    motion: number;
    playerEmbodied: boolean;
    observerOffset: number;
    beaconVisible: boolean;
    web: ReturnType<CosmicEnergyWeb["debugState"]> | null;
  } {
    const controlled = this.#celebrants[this.#controlledCelebrant];
    return {
      index: this.#controlledCelebrant >= 0 ? this.#controlledCelebrant : null,
      motion: this.#takeoverMotion,
      playerEmbodied: this.#playerRig !== null,
      observerOffset: controlled
        ? controlled.rig.group.position.distanceTo(controlled.stationPosition)
        : 0,
      beaconVisible: this.#interactionBeacon?.sprite.visible ?? false,
      web: this.#web?.debugState() ?? null
    };
  }

  setPetalActivation(index: number, value: number): void {
    const petal = this.#petals[index];
    if (!petal) return;
    const activation = clamp01(value);
    petal.activation.value = activation;
    petal.beam.visible = activation > 0.002;
    petal.group.scale.setScalar(0.92 + activation * 0.08);
  }

  setLoomCharge(value: number): void {
    this.#loomCharge.value = clamp01(value);
  }

  setCompletion(value: number): void {
    const completion = clamp01(value);
    // Celebrants + web are ambient whenever the site is awake; completion just
    // surges the web energy (brighter, higher arms) for the finale.
    this.#energyTarget = WEB_TUNING.baseEnergy + completion * (1 - WEB_TUNING.baseEnergy);
  }

  petalTarget(index: number, out = new THREE.Vector3()): THREE.Vector3 {
    const petal = this.#petals[index];
    return petal ? out.copy(petal.target) : out.set(0, 2.2, 0);
  }

  resetEchoes(visible: boolean): void {
    this.echoes.forEach((echo) => {
      echo.root.position.copy(echo.home);
      echo.root.visible = visible;
      echo.glow.value = 1;
    });
  }

  update(dt: number, elapsed: number, completion: number): void {
    this.#elapsed += Math.min(dt, 0.1);
    const focusPulse = 1 + Math.sin(this.#elapsed * 4.2) * 0.08;
    if (this.#controlHalo?.visible) this.#controlHalo.scale.setScalar(focusPulse);
    if (this.#interactionBeacon?.sprite.visible) {
      this.#interactionBeacon.sprite.scale.set(4.15 * focusPulse, 0.94 * focusPulse, 1);
      this.#interactionBeacon.sprite.position.y = this.#interactionBeaconBaseY + Math.sin(this.#elapsed * 2.8) * 0.08;
    }
    const charge = Number(this.#loomCharge.value);
    this.#loomRings.rotation.y = elapsed * (0.08 + charge * 0.13);
    this.#loomRings.rotation.x = Math.sin(elapsed * 0.31) * 0.08;
    this.#loomRings.position.y = 2.5 + Math.sin(elapsed * 0.72) * 0.08;
    for (let i = 0; i < this.echoes.length; i++) {
      const echo = this.echoes[i];
      echo.float.position.y = Math.sin(elapsed * 1.25 + i * 1.7) * 0.32;
      echo.float.rotation.y = elapsed * (0.42 + i * 0.035);
      echo.rings.rotation.x = elapsed * (0.36 + i * 0.05);
      echo.rings.rotation.z = -elapsed * (0.28 + i * 0.035);
    }
    for (let i = 0; i < this.#keepers.length; i++) {
      const keeper = this.#keepers[i];
      poseIdle(keeper.rig, elapsed + keeper.phase);
      if (completion > 0) {
        const lift = smoothstepNumber(0.12, 0.86, completion);
        keeper.rig.armL.rotation.x += lift * (i === 0 ? 1.25 : 0.88);
        keeper.rig.armR.rotation.x += lift * (i === 0 ? 0.72 : 1.18);
        keeper.rig.head.rotation.x -= lift * 0.25;
      }
      keeper.label.position.y = 2.82 + Math.sin(this.#elapsed * 0.8 + i) * 0.035;
    }
    // Energy eases toward the ambient/finale target; arms rise with it.
    this.#takeoverMotion *= Math.exp(-Math.max(0, dt) * 2.8);
    this.#energyTarget = Math.max(
      WEB_TUNING.baseEnergy + clamp01(completion) * (1 - WEB_TUNING.baseEnergy),
      WEB_TUNING.baseEnergy + this.#takeoverMotion * 0.48
    );
    this.#energy += (this.#energyTarget - this.#energy) * Math.min(1, dt * 1.8);
    const energy = this.#energy;
    const lift = energy * 0.55;

    for (let i = 0; i < this.#celebrants.length; i++) {
      const c = this.#celebrants[i];
      poseIdle(c.rig, elapsed + c.phase);
      if (i === this.#controlledCelebrant && this.#playerRig) {
        c.observerBlend += (1 - c.observerBlend) * Math.min(1, dt * 7.5);
        const observerEase = smoothstepNumber(0, 1, c.observerBlend);
        c.rig.group.position.lerpVectors(c.stationPosition, c.observerTarget, observerEase);
        c.rig.group.rotation.y = THREE.MathUtils.lerp(c.stationYaw, c.observerYaw, observerEase);
        c.rig.armL.rotation.x += 0.22;
        c.rig.armR.rotation.x += 0.34;
        c.rig.foreL.rotation.x += 0.48;
        c.rig.foreR.rotation.x += 0.38;
        c.rig.head.rotation.x = -0.1;
        c.rig.head.rotation.y = Math.sin(elapsed * 0.68 + c.phase) * 0.12;

        const activeRig = this.#playerRig;
        activeRig.group.position.copy(c.stationPosition);
        activeRig.group.rotation.y = c.stationYaw;
        poseIdle(activeRig, elapsed + 0.37);
        const follow = 1 - Math.exp(-Math.max(0, dt) * 15);
        c.controlSmoothL.lerp(c.controlTargetL, follow);
        c.controlSmoothR.lerp(c.controlTargetR, follow);
        activeRig.group.updateWorldMatrix(true, true);
        c.controlWorldL.copy(c.controlSmoothL);
        activeRig.group.localToWorld(c.controlWorldL);
        c.controlWorldR.copy(c.controlSmoothR);
        activeRig.group.localToWorld(c.controlWorldR);
        setHandTarget(activeRig, "L", { pos: c.controlWorldL, hand: 0.12, reach: 0.985 });
        setHandTarget(activeRig, "R", { pos: c.controlWorldR, hand: 0.12, reach: 0.985 });
        activeRig.head.rotation.x = -0.24;
      } else {
        // Both arms reach up-and-in toward the hub and trace a slow circle, so
        // every unclaimed participant keeps contributing a living baseline.
        const raise = 2.02 + lift + Math.sin(elapsed * 0.82 + c.armPhase) * 0.46;
        const swirlX = Math.cos(elapsed * 0.67 + c.armPhase) * 0.34;
        const swirlZ = Math.sin(elapsed * 0.57 + c.swirl) * 0.28;
        c.rig.armL.rotation.set(raise + swirlX, 0, 0.16 + swirlZ + lift * 0.1);
        c.rig.armR.rotation.set(raise - swirlX, 0, -0.16 - swirlZ - lift * 0.1);
        c.rig.foreL.rotation.x = 0.48 + Math.sin(elapsed * 0.93 + c.armPhase) * 0.22;
        c.rig.foreR.rotation.x = 0.48 + Math.cos(elapsed * 0.89 + c.armPhase) * 0.22;
        c.rig.torso.rotation.z += Math.sin(elapsed * 0.48 + c.swirl) * 0.055;
        c.rig.head.rotation.x = -0.2;
        c.rig.head.rotation.y = Math.sin(elapsed * 0.52 + c.armPhase) * 0.09;
        setHandPose(c.rig, "L", 0.3);
        setHandPose(c.rig, "R", 0.3);
      }
    }

    if (this.#web) {
      for (let i = 0; i < this.#anchorBindings.length; i++) {
        const binding = this.#anchorBindings[i];
        const celebrant = this.#celebrants[binding.celebrantIndex];
        const rig = binding.celebrantIndex === this.#controlledCelebrant && this.#playerRig
          ? this.#playerRig
          : celebrant.rig;
        const hand = binding.side === "L" ? rig.handL : rig.handR;
        hand.getWorldPosition(this.#handWorld);
        this.root.worldToLocal(this.#handWorld);
        this.#web.anchorTargets[i].copy(this.#handWorld);
      }
      this.#web.setEnergy(energy);
      this.#web.update(dt, elapsed);
    }
  }

  dispose(): void {
    this.endTakeover();
    for (const keeper of this.#keepers) {
      disposeSprite(keeper.label);
      // Rig box geometry comes from player/rig's global cache and remains owned
      // by that module; only the per-avatar tint materials belong to this site.
      for (const material of Object.values(keeper.rig.avatar.materials)) material.dispose();
      keeper.rig.group.removeFromParent();
    }
    this.#keepers.length = 0;
    // Web owns its own geometry/materials; detach before the traverse below.
    this.#web?.dispose();
    this.#web = null;
    for (const celebrant of this.#celebrants) {
      for (const material of Object.values(celebrant.rig.avatar.materials)) material.dispose();
      celebrant.rig.group.removeFromParent();
    }
    this.#celebrants.length = 0;
    this.#anchorBindings.length = 0;
    this.#controlHalo = null;
    this.#interactionBeacon?.texture.dispose();
    this.#interactionBeacon = null;
    this.#glowTexture.dispose();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh && !(object as THREE.Points).isPoints && !(object as THREE.Sprite).isSprite) return;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const material = (object as THREE.Mesh).material;
      const list = Array.isArray(material) ? material : [material];
      for (const item of list) if (item) materials.add(item);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.root.parent?.remove(this.root);
  }

  #groundY(localX: number, localZ: number): number {
    return this.#map.groundTop(AFTERLIGHT_CENTER.x + localX, AFTERLIGHT_CENTER.z + localZ) - this.centerY;
  }

  #buildGroundRing(): void {
    const stone = new THREE.MeshStandardMaterial({ color: 0x26373a, roughness: 0.88, metalness: 0.04 });
    const brass = new THREE.MeshStandardMaterial({ color: 0x9a7443, roughness: 0.34, metalness: 0.68 });
    const segmentGeometry = new THREE.BoxGeometry(1.05, 0.12, 0.28);
    const segments = new THREE.InstancedMesh(segmentGeometry, stone, 32);
    const ticks = new THREE.InstancedMesh(new THREE.BoxGeometry(0.13, 0.08, 0.62), brass, 16);
    const matrix = new THREE.Matrix4();
    const quaternion = new THREE.Quaternion();
    const position = new THREE.Vector3();
    const scale = new THREE.Vector3(1, 1, 1);
    for (let i = 0; i < 32; i++) {
      const angle = (i / 32) * Math.PI * 2;
      const x = Math.cos(angle) * 6.6;
      const z = Math.sin(angle) * 6.6;
      position.set(x, this.#groundY(x, z) + 0.08, z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle);
      matrix.compose(position, quaternion, scale);
      segments.setMatrixAt(i, matrix);
    }
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const x = Math.cos(angle) * 5.78;
      const z = Math.sin(angle) * 5.78;
      position.set(x, this.#groundY(x, z) + 0.1, z);
      quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -angle);
      matrix.compose(position, quaternion, scale);
      ticks.setMatrixAt(i, matrix);
    }
    segments.castShadow = false;
    segments.receiveShadow = true;
    ticks.castShadow = false;
    ticks.receiveShadow = true;
    this.root.add(segments, ticks);
  }

  #buildLoom(): void {
    const stone = new THREE.MeshStandardMaterial({ color: 0x314246, roughness: 0.82, metalness: 0.08 });
    const brass = new THREE.MeshStandardMaterial({ color: 0xa77b43, roughness: 0.3, metalness: 0.72 });
    const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.38, 1.65, 0.52, 24), stone);
    plinth.position.y = this.#groundY(0, 0) + 0.26;
    plinth.receiveShadow = true;
    this.root.add(plinth);

    const seed = new THREE.Mesh(
      new THREE.SphereGeometry(0.76, 24, 16),
      makeVolumetricOrbMaterial(0x75eadf, this.#loomCharge, 0.17, 0.76, 0.58)
    );
    seed.name = "afterlight-loom-volumetric-orb";
    this.#loomRings.add(seed);
    const seedAura = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.#glowTexture,
      color: 0x72e7e0,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false
    }));
    seedAura.scale.setScalar(5.2);
    seedAura.renderOrder = 13;
    this.#loomRings.add(seedAura);

    const ringMaterial = new THREE.MeshStandardNodeMaterial();
    ringMaterial.colorNode = color(0x8c744f);
    ringMaterial.metalnessNode = float(0.82);
    ringMaterial.roughnessNode = float(0.22);
    ringMaterial.emissiveNode = color(0x82e4dd).mul(this.#loomCharge as N).mul(LIGHT_SCALE * 0.42);
    const ringA = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.055, 8, 56), ringMaterial);
    const ringB = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.045, 8, 48), ringMaterial);
    const ringC = new THREE.Mesh(new THREE.TorusGeometry(1.92, 0.035, 8, 64), ringMaterial);
    ringB.rotation.y = Math.PI / 2;
    ringC.rotation.x = Math.PI / 2;
    ringC.rotation.z = 0.42;
    this.#loomRings.add(ringA, ringB, ringC);
    this.#loomRings.position.y = 2.5;
    this.root.add(this.#loomRings);

    const petalGeometry = new THREE.DodecahedronGeometry(0.48, 1);
    for (let i = 0; i < ECHO_LAYOUT.length; i++) {
      const echo = ECHO_LAYOUT[i];
      const angle = (i / ECHO_LAYOUT.length) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(angle) * AFTERLIGHT_TUNING.loomRadius;
      const z = Math.sin(angle) * AFTERLIGHT_TUNING.loomRadius;
      const ground = this.#groundY(x, z);
      const group = new THREE.Group();
      group.position.set(x, ground, z);
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.68, 0.9, 0.3, 12), stone);
      base.position.y = 0.15;
      base.receiveShadow = true;
      group.add(base);

      const activation = uniform(0);
      const orb = new THREE.Mesh(
        petalGeometry,
        makeSubsurfaceOrbMaterial(echo.hue, activation, 0.41 + i * 0.193, 0.48, 0.42)
      );
      orb.name = `afterlight-subsurface-petal-${i + 1}`;
      orb.position.y = 1.48;
      orb.rotation.set(0.22 + i * 0.31, i * 0.77, -0.16 + i * 0.19);
      orb.scale.set(0.88 + (i % 2) * 0.06, 1.16 - (i % 3) * 0.035, 0.92 + (i % 3) * 0.025);
      group.add(orb);
      const arch = new THREE.Mesh(new THREE.TorusGeometry(0.86, 0.055, 7, 30, Math.PI * 1.48), brass);
      arch.position.y = 1.1;
      arch.rotation.z = -Math.PI * 0.74;
      group.add(arch);

      const target = new THREE.Vector3(x, ground + 1.48, z);
      const curve = new THREE.QuadraticBezierCurve3(
        target.clone(),
        new THREE.Vector3(x * 0.48, Math.max(target.y, 2.5) + 1.9, z * 0.48),
        new THREE.Vector3(0, 2.5, 0)
      );
      const beam = new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.026, 5, false), makeBeamMaterial(echo.hue, activation));
      beam.visible = false;
      beam.renderOrder = 14;
      this.root.add(beam);
      this.root.add(group);
      this.#petals.push({ group, activation, beam, target });
    }
  }

  #buildEchoes(): void {
    const geometry = new THREE.DodecahedronGeometry(0.72, 1);
    for (let i = 0; i < ECHO_LAYOUT.length; i++) {
      const spec = ECHO_LAYOUT[i];
      const root = new THREE.Group();
      root.name = `afterlight-echo-${i + 1}`;
      const y = this.#groundY(spec.x, spec.z) + AFTERLIGHT_TUNING.echoFloatHeight;
      const home = new THREE.Vector3(spec.x, y, spec.z);
      root.position.copy(home);
      root.visible = false;
      const floatGroup = new THREE.Group();
      root.add(floatGroup);
      const glow = uniform(1);
      const core = new THREE.Mesh(
        geometry,
        makeSubsurfaceOrbMaterial(spec.hue, glow, (i + 1) * 0.173, 0.72, 0.5)
      );
      core.name = `afterlight-subsurface-echo-${i + 1}`;
      core.rotation.set(i * 0.29, i * 0.61, 0.18 - i * 0.13);
      core.scale.set(0.86 + (i % 3) * 0.035, 1.18 - (i % 2) * 0.055, 0.93 + (i % 2) * 0.04);
      floatGroup.add(core);
      const rings = new THREE.Group();
      for (let r = 0; r < 3; r++) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(1.02 + r * 0.15, 0.024, 5, 28),
          makeBeamMaterial(spec.hue, glow)
        );
        ring.rotation.set(r * 0.72, r * 0.44, r * 0.63);
        rings.add(ring);
      }
      floatGroup.add(rings);
      const haloMaterial = new THREE.SpriteMaterial({
        map: this.#glowTexture,
        color: spec.hue,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false
      });
      const halo = new THREE.Sprite(haloMaterial);
      halo.scale.setScalar(5.6);
      halo.renderOrder = 13;
      floatGroup.add(halo);

      const motePositions = new Float32Array(18 * 3);
      for (let m = 0; m < 18; m++) {
        const angle = (m / 18) * Math.PI * 2 + i * 0.61;
        const radius = 1.15 + ((m * 17 + i * 7) % 9) * 0.075;
        motePositions[m * 3] = Math.cos(angle) * radius;
        motePositions[m * 3 + 1] = ((m * 13) % 11) * 0.1 - 0.5;
        motePositions[m * 3 + 2] = Math.sin(angle) * radius;
      }
      const moteGeometry = new THREE.BufferGeometry();
      moteGeometry.setAttribute("position", new THREE.BufferAttribute(motePositions, 3));
      const motes = new THREE.Points(
        moteGeometry,
        new THREE.PointsMaterial({
          color: spec.hue,
          size: 0.16,
          transparent: true,
          opacity: 0.9,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false
        })
      );
      floatGroup.add(motes);
      this.root.add(root);
      this.echoes.push({ root, float: floatGroup, rings, home, target: new THREE.Vector3(), glow });
      this.petalTarget(i, this.echoes[i].target);
    }
  }

  #buildKeepers(): void {
    const accents = ["rgba(132,245,222,.82)", "rgba(245,199,120,.82)"];
    for (let i = 0; i < KEEPER_LAYOUT.length; i++) {
      const spec = KEEPER_LAYOUT[i];
      const seeded = avatarFromSeed(spec.seed);
      const avatar: AvatarTraits = i === 0
        ? { ...seeded, outfit: "overalls", hair: "long", hat: "beanie" }
        : { ...seeded, outfit: "jacket", hair: "mohawk", hat: "none" };
      const rig = buildRig(avatar);
      configureLightweightRig(rig);
      rig.group.position.set(spec.x, this.#groundY(spec.x, spec.z) + 0.93, spec.z);
      rig.group.rotation.y = spec.yaw;
      poseIdle(rig, i * 1.7);
      const label = makeNameTag(spec.name, accents[i]);
      label.position.set(0, 2.82, 0);
      rig.group.add(label);
      this.root.add(rig.group);
      this.#keepers.push({ rig, label, phase: i * 2.13 });
    }

    const telescope = buildTelescope();
    telescope.position.set(-6.1, this.#groundY(-6.1, 3.9), 3.9);
    this.root.add(telescope);
    const reel = buildReel();
    reel.position.set(6.2, this.#groundY(6.2, 3.5), 3.5);
    reel.rotation.y = 0.55;
    this.root.add(reel);
  }

  /**
   * The ring of celebrants — real avatars in cosmic sci-fi robes — who stand
   * around the loom and hold the energy web aloft. Present whenever the site is
   * awake; both hands of each avatar pin a vein, so their slow arm circles
   * ripple through the whole net.
   */
  #buildCelebrants(): void {
    const COUNT = 5;
    const RING = 9.2;
    // Deep-space robes with glowing trim; each avatar gets a distinct pairing.
    const COSMIC: Array<{
      robe: number;
      sleeve: number;
      trim: number;
      sash: number;
      hair: AvatarTraits["hair"];
      hat: AvatarTraits["hat"];
      outfit: AvatarTraits["outfit"];
    }> = [
      { robe: 0x2a1c54, sleeve: 0x1b1440, trim: 0x8fe8ff, sash: 0x0e3b6b, hair: "long", hat: "crown", outfit: "dress" },
      { robe: 0x123f6b, sleeve: 0x0c2b4a, trim: 0x86ffd6, sash: 0x146b6b, hair: "bob", hat: "crown", outfit: "jacket" },
      { robe: 0x3a1650, sleeve: 0x26103a, trim: 0xff9be0, sash: 0x4a1d5c, hair: "mohawk", hat: "none", outfit: "hoodie" },
      { robe: 0x0f3b52, sleeve: 0x0a2838, trim: 0x9be8ff, sash: 0x0d5a6e, hair: "long", hat: "crown", outfit: "dress" },
      { robe: 0x241a5e, sleeve: 0x160f3e, trim: 0xc6b4ff, sash: 0x2a2470, hair: "short", hat: "crown", outfit: "jacket" },
      { robe: 0x4a1d3a, sleeve: 0x2f1226, trim: 0xffc0e6, sash: 0x5c1d3a, hair: "long", hat: "none", outfit: "dress" },
      { robe: 0x0d5a6e, sleeve: 0x08313e, trim: 0x7fe9ff, sash: 0x123f3a, hair: "buzz", hat: "crown", outfit: "hoodie" }
    ];

    const raw: Array<{
      hand: THREE.Group;
      local: THREE.Vector3;
      celebrantIndex: number;
      side: "L" | "R";
    }> = [];
    for (let i = 0; i < COUNT; i++) {
      const spec = COSMIC[i % COSMIC.length];
      const seeded = avatarFromSeed(`afterlight-celebrant-${i}`);
      const traits: AvatarTraits = { ...seeded, outfit: spec.outfit, hair: spec.hair, hat: spec.hat };
      const rig = buildRig(traits);
      configureLightweightRig(rig);
      // Off-palette cosmic recolour (after buildRig; never re-run applyAvatarToRig).
      const m = rig.avatar.materials;
      m.jacket.color.set(spec.robe);
      m.sleeve.color.set(spec.sleeve);
      m.shirt.color.set(spec.trim);
      m.pants.color.set(spec.sash).multiplyScalar(0.7);
      m.hat.color.set(spec.trim);
      m.trim.color.set(spec.trim);
      m.pack.color.set(spec.robe);

      const angle = (i / COUNT) * Math.PI * 2 + 0.4;
      const x = Math.cos(angle) * RING;
      const z = Math.sin(angle) * RING;
      rig.group.position.set(x, this.#groundY(x, z) + 0.93, z);
      rig.group.rotation.y = Math.atan2(-x, -z); // face the hub
      const stationPosition = rig.group.position.clone();
      const radial = new THREE.Vector3(x, 0, z).normalize();
      const tangent = new THREE.Vector3(-radial.z, 0, radial.x).multiplyScalar(i % 2 === 0 ? 0.62 : -0.62);
      const observerTarget = stationPosition.clone().addScaledVector(radial, 2.25).add(tangent);
      observerTarget.y = this.#groundY(observerTarget.x, observerTarget.z) + 0.93;
      const observerYaw = Math.atan2(
        stationPosition.x - observerTarget.x,
        stationPosition.z - observerTarget.z
      );

      // Bind pose so the sampled hand positions match the ambient reach.
      poseIdle(rig, i * 1.7);
      rig.armL.rotation.set(1.94, 0, 0.16);
      rig.armR.rotation.set(1.94, 0, -0.16);
      rig.foreL.rotation.x = 0.42;
      rig.foreR.rotation.x = 0.42;
      setHandPose(rig, "L", 0.3);
      setHandPose(rig, "R", 0.3);
      this.root.add(rig.group);
      this.#celebrants.push({
        rig,
        phase: i * 2.13,
        armPhase: i * 1.3,
        swirl: i * 0.9,
        stationPosition,
        stationYaw: rig.group.rotation.y,
        observerTarget,
        observerYaw,
        observerBlend: 0,
        controlBaseL: new THREE.Vector3(),
        controlBaseR: new THREE.Vector3(),
        controlTargetL: new THREE.Vector3(),
        controlTargetR: new THREE.Vector3(),
        controlSmoothL: new THREE.Vector3(),
        controlSmoothR: new THREE.Vector3(),
        controlWorldL: new THREE.Vector3(),
        controlWorldR: new THREE.Vector3()
      });
      raw.push(
        { hand: rig.handL, local: new THREE.Vector3(), celebrantIndex: i, side: "L" },
        { hand: rig.handR, local: new THREE.Vector3(), celebrantIndex: i, side: "R" }
      );
    }

    // Sample bind-pose hand positions in site-local space, sorted by angle so
    // the membrane wraps the ring cleanly.
    this.root.updateMatrixWorld(true);
    for (const entry of raw) {
      entry.hand.getWorldPosition(this.#handWorld);
      this.root.worldToLocal(this.#handWorld);
      entry.local = this.#handWorld.clone();
    }
    raw.sort((a, b) => Math.atan2(a.local.z, a.local.x) - Math.atan2(b.local.z, b.local.x));
    const anchorInit: THREE.Vector3[] = [];
    for (const entry of raw) {
      anchorInit.push(entry.local);
      this.#anchorBindings.push({ celebrantIndex: entry.celebrantIndex, side: entry.side });
    }

    this.#web = new CosmicEnergyWeb({ anchorInit, seed: 7 });
    this.root.add(this.#web.root);

    const haloMaterial = new THREE.MeshBasicNodeMaterial();
    const haloPulse = oscSine(time.mul(0.82)) as N;
    haloMaterial.colorNode = mix(color(0x74ecf0), color(0xffb3e5), haloPulse)
      .mul(haloPulse.mul(0.45).add(0.65))
      .mul(LIGHT_SCALE * 0.8);
    haloMaterial.opacityNode = haloPulse.mul(0.28).add(0.48);
    haloMaterial.transparent = true;
    haloMaterial.depthWrite = false;
    haloMaterial.blending = THREE.AdditiveBlending;
    haloMaterial.fog = false;
    this.#controlHalo = new THREE.Mesh(new THREE.TorusGeometry(0.72, 0.045, 6, 42), haloMaterial);
    this.#controlHalo.name = "afterlight-controlled-participant";
    this.#controlHalo.rotation.x = Math.PI / 2;
    this.#controlHalo.visible = false;
    this.#controlHalo.renderOrder = 17;
    this.root.add(this.#controlHalo);

    this.#interactionBeacon = makeInteractionBeacon();
    this.root.add(this.#interactionBeacon.sprite);
  }
}

function smoothstepNumber(edge0: number, edge1: number, value: number): number {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}
