import * as THREE from "three/webgpu";
import { formatInteractPrompt } from "../../core/input";
import type { NatureSoundscape } from "../../audio/natureSoundscape";
import type { WorldMap } from "../heightmap";
import { HirajoshiWaveAudio } from "./hirajoshiWaveAudio";

const SITE = { x: 275, z: -2004, yaw: -2.12 } as const;
// Authored against the full-resolution ground bake. Optional-site debug
// forcing can construct before this distant tile is resident, when groundTop
// still contains the coarse overview; never seat the monument from that proxy.
const SITE_TOP_Y = 3.7;
const WAND_COUNT = 12;
const TRAIL_SAMPLES = 18;
const LOOP_SECONDS = 48;
const ANIMATE_RADIUS = 245;
const SHOW_RADIUS = 410;
const INTERACT_REACH = 4.4;
const TAU = Math.PI * 2;

const COLORS = [
  0x5b2cff, 0x8a3cff, 0xbe4ee9, 0xed4eb5,
  0xff536f, 0xff654d, 0xff7d32, 0xff9a2e,
  0xffbd4a, 0xffd88a, 0xffeed1, 0xf9fbff
] as const;

const PBR_URLS = {
  albedo: "/art/hirajoshi-wave/pbr/pedestal-mosaic_albedo.png",
  roughness: "/art/hirajoshi-wave/pbr/pedestal-mosaic_roughness.png",
  height: "/art/hirajoshi-wave/pbr/pedestal-mosaic_height.png",
  normal: "/art/hirajoshi-wave/pbr/pedestal-mosaic_normal.png",
  ao: "/art/hirajoshi-wave/pbr/pedestal-mosaic_ao.png"
} as const;

type Hud = { message(text: string, seconds?: number): void };

type Wand = {
  length: number;
  radius: number;
  yaw: number;
  cycles: number;
  local: THREE.Vector3;
  world: THREE.Vector3;
  lastCycle: number;
};

export class HirajoshiWave {
  readonly group = new THREE.Group();
  readonly ready: Promise<void>;

  #audio: HirajoshiWaveAudio;
  #materials = new Set<THREE.Material>();
  #geometries = new Set<THREE.BufferGeometry>();
  #textures = new Set<THREE.Texture>();
  #rods!: THREE.InstancedMesh;
  #orbs!: THREE.InstancedMesh;
  #trails!: THREE.InstancedMesh;
  #pivotMaterial!: THREE.MeshPhysicalMaterial;
  #wands: Wand[] = [];
  #history = new Float32Array(WAND_COUNT * TRAIL_SAMPLES * 3);
  #historyHead = 0;
  #trailAccumulator = 0;
  #time = 0;
  #syncPulse = 1;
  #promptShown = false;
  #wasAnimating = false;
  #disposed = false;
  #topY: number;
  #controlWorld = new THREE.Vector3();
  #scratchMatrix = new THREE.Matrix4();
  #scratchPosition = new THREE.Vector3();
  #scratchScale = new THREE.Vector3();
  #scratchQuaternion = new THREE.Quaternion();
  #scratchDirection = new THREE.Vector3();
  #scratchUnit = new THREE.Vector3();
  #up = new THREE.Vector3(0, 1, 0);
  #pivot = new THREE.Vector3(0, 1.52, 0);
  #audioPositions: THREE.Vector3[] = [];

  constructor(map: WorldMap, nature: NatureSoundscape) {
    this.group.name = "hirajoshiWave";
    this.#audio = new HirajoshiWaveAudio(nature);

    let minGround = Infinity;
    let maxGround = -Infinity;
    for (let dz = -8; dz <= 8; dz += 2) {
      for (let dx = -8; dx <= 8; dx += 2) {
        const y = map.groundTop(SITE.x + dx, SITE.z + dz);
        minGround = Math.min(minGround, y);
        maxGround = Math.max(maxGround, y);
      }
    }
    this.#topY = Math.max(SITE_TOP_Y, maxGround + 0.16);
    this.group.position.set(SITE.x, this.#topY, SITE.z);
    this.group.rotation.y = SITE.yaw;

    const pedestalMaterial = this.#ownMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x28484d,
      roughness: 0.58,
      metalness: 0,
      clearcoat: 0.32,
      clearcoatRoughness: 0.24
    }));
    this.#buildDais(Math.max(3.8, maxGround - minGround + 0.5), pedestalMaterial);
    this.#buildPortal();
    this.#buildWands();
    this.#audioPositions = this.#wands.map((wand) => wand.world);
    this.#buildControlStone();
    this.#seedHistory();
    this.#updateInstances(true);

    this.#controlWorld.set(-6.4, 0.8, -2.7)
      .applyAxisAngle(this.#up, SITE.yaw)
      .add(this.group.position);

    const heartSocket = new THREE.Object3D();
    heartSocket.name = "hirajoshiWave.heartSocket";
    heartSocket.position.set(0, 1.52, 0);
    this.group.add(heartSocket);
    this.group.userData.sculptRuntime = {
      nodes: {
        root: this.group,
        pedestal: this.group.getObjectByName("hirajoshiWave.dais"),
        portalFrame: this.group.getObjectByName("hirajoshiWave.portal"),
        pivotHeart: this.group.getObjectByName("hirajoshiWave.heart"),
        pendulumArray: this.#rods,
        trailField: this.#trails
      },
      sockets: { "root:heart-socket": heartSocket },
      colliders: [{
        id: "dais",
        type: "cylinder",
        radius: 8.4,
        height: Math.max(1.1, maxGround - minGround + 0.5)
      }],
      loopSeconds: LOOP_SECONDS,
      cycleCounts: this.#wands.map((wand) => wand.cycles)
    };

    this.ready = this.#loadPedestalMaps(pedestalMaterial);
  }

  get center(): Readonly<{ x: number; z: number }> {
    return SITE;
  }

  restart(hud?: Hud): void {
    this.#time = 0;
    this.#syncPulse = 1;
    for (const wand of this.#wands) wand.lastCycle = 0;
    this.#updateInstances(true);
    this.#seedHistory();
    this.#audio.alignmentPulse();
    for (let i = 0; i < WAND_COUNT; i++) this.#audio.strike(i, 0.62);
    hud?.message("The wave returns to one · C Hiraijoshi", 5.5);
  }

  /** Deterministic probe/cinematic hook; ordinary play uses restart + update. */
  debugSetTime(seconds: number): void {
    this.#time = Math.max(0, seconds);
    for (const wand of this.#wands) {
      wand.lastCycle = Math.floor((this.#time * wand.cycles) / LOOP_SECONDS);
    }
    this.#updateInstances(true);
  }

  debugState() {
    let alignmentError = 0;
    for (const wand of this.#wands) {
      alignmentError = Math.max(alignmentError, Math.hypot(wand.local.x, wand.local.z));
    }
    return {
      center: { x: SITE.x, y: this.#topY, z: SITE.z },
      time: this.#time,
      loopSeconds: LOOP_SECONDS,
      loopPhase: this.#time % LOOP_SECONDS,
      alignmentError,
      cycleCounts: this.#wands.map((wand) => wand.cycles),
      wandCount: this.#wands.length,
      trailInstances: this.#trails.count,
      loadedTextures: this.#textures.size,
      visible: this.group.visible
    };
  }

  tryInteract(
    player: { renderPosition: { x: number; z: number }; mode: string },
    hud: Hud
  ): boolean {
    if (player.mode !== "walk") return false;
    const dx = player.renderPosition.x - this.#controlWorld.x;
    const dz = player.renderPosition.z - this.#controlWorld.z;
    if (dx * dx + dz * dz > INTERACT_REACH * INTERACT_REACH) return false;
    this.restart(hud);
    return true;
  }

  update(
    dt: number,
    _elapsed: number,
    playerPos: Readonly<{ x: number; z: number }>,
    hud: Hud | null
  ): void {
    const distance = Math.hypot(playerPos.x - SITE.x, playerPos.z - SITE.z);
    this.group.visible = distance < SHOW_RADIUS;
    this.#audio.update(playerPos, SITE, this.#audioPositions);
    if (!this.group.visible) return;

    const animating = distance < ANIMATE_RADIUS;
    if (animating) {
      const previousLoop = Math.floor(this.#time / LOOP_SECONDS);
      this.#time += dt;
      const currentLoop = Math.floor(this.#time / LOOP_SECONDS);
      if (currentLoop > previousLoop) {
        this.#syncPulse = 1;
        this.#audio.alignmentPulse();
      }
      this.#updateInstances(false);
      this.#trailAccumulator += dt;
      if (this.#trailAccumulator >= 1 / 30) {
        this.#trailAccumulator %= 1 / 30;
        this.#recordTrail();
        this.#updateTrails();
      }
      this.#wasAnimating = true;
    } else if (this.#wasAnimating) {
      // Leave a clean aligned silhouette when the expensive dynamic gate closes.
      this.#wasAnimating = false;
      this.#time = Math.ceil(this.#time / LOOP_SECONDS) * LOOP_SECONDS;
      this.#updateInstances(true);
    }

    this.#syncPulse = Math.max(0, this.#syncPulse - dt * 0.42);
    this.#pivotMaterial.emissiveIntensity = 2.2 + this.#syncPulse * 8;

    if (hud) {
      const dx = playerPos.x - this.#controlWorld.x;
      const dz = playerPos.z - this.#controlWorld.z;
      const nearControl = dx * dx + dz * dz < INTERACT_REACH * INTERACT_REACH;
      if (nearControl && !this.#promptShown) {
        this.#promptShown = true;
        hud.message(formatInteractPrompt("return the twelve voices to one"), 2.4);
      } else if (!nearControl && this.#promptShown) {
        this.#promptShown = false;
      }
    }
  }

  #buildDais(skirtHeight: number, mosaic: THREE.MeshPhysicalMaterial): void {
    const dais = new THREE.Group();
    dais.name = "hirajoshiWave.dais";
    const basalt = this.#ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x11191b,
      roughness: 0.86,
      metalness: 0.03
    }));
    const brass = this.#ownMaterial(new THREE.MeshStandardMaterial({
      color: 0xb8893f,
      roughness: 0.26,
      metalness: 0.9
    }));

    const skirt = new THREE.Mesh(
      this.#ownGeometry(new THREE.CylinderGeometry(8.4, 8.85, skirtHeight, 64)),
      basalt
    );
    skirt.position.y = -skirtHeight * 0.5;
    skirt.name = "hirajoshiWave.dais.skirt";
    dais.add(skirt);

    const lower = new THREE.Mesh(
      this.#ownGeometry(new THREE.CylinderGeometry(8.15, 8.35, 0.25, 64)),
      basalt
    );
    lower.position.y = 0.125;
    dais.add(lower);

    const mosaicStep = new THREE.Mesh(
      this.#ownGeometry(new THREE.CylinderGeometry(6.7, 7.2, 0.38, 64)),
      mosaic
    );
    mosaicStep.position.y = 0.43;
    mosaicStep.name = "hirajoshiWave.dais.mosaic";
    dais.add(mosaicStep);

    const inner = new THREE.Mesh(
      this.#ownGeometry(new THREE.CylinderGeometry(4.8, 5.2, 0.26, 64)),
      basalt
    );
    inner.position.y = 0.74;
    dais.add(inner);

    for (const [radius, tube, y] of [
      [7.36, 0.045, 0.275],
      [5.35, 0.055, 0.64],
      [3.15, 0.035, 0.89]
    ] as const) {
      const ring = new THREE.Mesh(
        this.#ownGeometry(new THREE.TorusGeometry(radius, tube, 8, 96)),
        brass
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = y;
      dais.add(ring);
    }

    const finGeometry = this.#ownGeometry(new THREE.BoxGeometry(0.42, 1.3, 0.18));
    finGeometry.translate(0, 0.65, 0);
    const fins = new THREE.InstancedMesh(finGeometry, brass, 5);
    fins.name = "hirajoshiWave.tuningFins";
    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const quaternion = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    for (let i = 0; i < 5; i++) {
      const angle = THREE.MathUtils.lerp(-1.05, 1.05, i / 4);
      position.set(Math.sin(angle) * 6.2, 0.88, Math.cos(angle) * 6.2 + 0.15);
      quaternion.setFromAxisAngle(this.#up, angle);
      scale.set(1, 0.72 + i * 0.09, 1);
      matrix.compose(position, quaternion, scale);
      fins.setMatrixAt(i, matrix);
    }
    fins.instanceMatrix.needsUpdate = true;
    dais.add(fins);

    dais.traverse(disableShadows);
    this.group.add(dais);
  }

  #buildPortal(): void {
    const portal = new THREE.Group();
    portal.name = "hirajoshiWave.portal";
    const bronze = this.#ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x80602b,
      roughness: 0.24,
      metalness: 0.92
    }));
    const glow = this.#ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x163936,
      emissive: 0x49ead4,
      emissiveIntensity: 2.4,
      roughness: 0.32,
      metalness: 0.45
    }));

    for (const side of [-1, 1] as const) {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.05, 1.52, 0),
        new THREE.Vector3(side * 1.7, 3.8, side * 0.2),
        new THREE.Vector3(side * 4.2, 7.4, side * 0.72),
        new THREE.Vector3(side * 7.15, 11.7, side * 1.45)
      ]);
      const outer = new THREE.Mesh(
        this.#ownGeometry(new THREE.TubeGeometry(curve, 72, 0.17, 10, false)),
        bronze
      );
      const inner = new THREE.Mesh(
        this.#ownGeometry(new THREE.TubeGeometry(curve, 72, 0.065, 8, false)),
        glow
      );
      portal.add(outer, inner);
    }

    this.#pivotMaterial = this.#ownMaterial(new THREE.MeshPhysicalMaterial({
      color: 0x271326,
      emissive: 0xf47cff,
      emissiveIntensity: 8,
      roughness: 0.16,
      metalness: 0.06,
      clearcoat: 1,
      clearcoatRoughness: 0.08
    }));
    const heart = new THREE.Mesh(
      this.#ownGeometry(new THREE.IcosahedronGeometry(0.43, 2)),
      this.#pivotMaterial
    );
    heart.name = "hirajoshiWave.heart";
    heart.position.y = 1.52;
    portal.add(heart);

    const collar = new THREE.Mesh(
      this.#ownGeometry(new THREE.TorusGeometry(0.68, 0.13, 10, 36)),
      bronze
    );
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 1.3;
    portal.add(collar);
    portal.traverse(disableShadows);
    this.group.add(portal);
  }

  #buildWands(): void {
    const rodGeometry = this.#ownGeometry(new THREE.CylinderGeometry(0.055, 0.082, 1, 8));
    const orbGeometry = this.#ownGeometry(new THREE.SphereGeometry(1, 18, 12));
    const rodMaterial = this.#ownMaterial(new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.25,
      metalness: 0.74,
      emissive: 0x181018,
      emissiveIntensity: 0.45
    }));
    const orbMaterial = this.#ownMaterial(new THREE.MeshPhysicalMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.1,
      metalness: 0.04,
      clearcoat: 1,
      clearcoatRoughness: 0.055,
      emissive: 0x2a1024,
      emissiveIntensity: 0.8
    }));
    this.#rods = new THREE.InstancedMesh(rodGeometry, rodMaterial, WAND_COUNT);
    this.#orbs = new THREE.InstancedMesh(orbGeometry, orbMaterial, WAND_COUNT);
    this.#rods.name = "hirajoshiWave.rods";
    this.#orbs.name = "hirajoshiWave.orbs";
    this.#rods.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#orbs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < WAND_COUNT; i++) {
      const color = new THREE.Color(COLORS[i]);
      this.#rods.setColorAt(i, color.clone().multiplyScalar(0.56));
      this.#orbs.setColorAt(i, color);
      this.#wands.push({
        length: 5.4 + i * 0.49,
        radius: 0.25 + i * 0.011,
        yaw: THREE.MathUtils.lerp(-0.29, 0.29, i / (WAND_COUNT - 1)),
        cycles: 18 + i,
        local: new THREE.Vector3(),
        world: new THREE.Vector3(),
        lastCycle: 0
      });
    }
    if (this.#rods.instanceColor) this.#rods.instanceColor.needsUpdate = true;
    if (this.#orbs.instanceColor) this.#orbs.instanceColor.needsUpdate = true;

    const trailGeometry = this.#ownGeometry(new THREE.SphereGeometry(0.12, 8, 6));
    const trailMaterial = this.#ownMaterial(new THREE.MeshBasicMaterial({
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      opacity: 0.26,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    this.#trails = new THREE.InstancedMesh(
      trailGeometry,
      trailMaterial,
      WAND_COUNT * TRAIL_SAMPLES
    );
    this.#trails.name = "hirajoshiWave.phaseTrails";
    this.#trails.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < WAND_COUNT; i++) {
      const color = new THREE.Color(COLORS[i]);
      for (let age = 0; age < TRAIL_SAMPLES; age++) {
        this.#trails.setColorAt(i * TRAIL_SAMPLES + age, color);
      }
    }
    if (this.#trails.instanceColor) this.#trails.instanceColor.needsUpdate = true;
    for (const mesh of [this.#rods, this.#orbs, this.#trails]) disableShadows(mesh);
    this.group.add(this.#trails, this.#rods, this.#orbs);
  }

  #buildControlStone(): void {
    const stone = new THREE.Group();
    stone.name = "hirajoshiWave.control";
    stone.position.set(-6.4, 0.1, -2.7);
    stone.rotation.y = 0.3;
    const basalt = this.#ownMaterial(new THREE.MeshStandardMaterial({
      color: 0x182325,
      roughness: 0.78,
      metalness: 0.04
    }));
    const gold = this.#ownMaterial(new THREE.MeshStandardMaterial({
      color: 0xc19648,
      emissive: 0x70440c,
      emissiveIntensity: 0.45,
      roughness: 0.25,
      metalness: 0.85
    }));
    const base = new THREE.Mesh(
      this.#ownGeometry(new THREE.CylinderGeometry(0.55, 0.72, 1.05, 8)),
      basalt
    );
    base.position.y = 0.52;
    const inlay = new THREE.Mesh(
      this.#ownGeometry(new THREE.TorusGeometry(0.28, 0.035, 8, 28)),
      gold
    );
    inlay.rotation.x = Math.PI / 2;
    inlay.position.y = 1.06;
    stone.add(base, inlay);
    stone.traverse(disableShadows);
    this.group.add(stone);
  }

  #updateInstances(force: boolean): void {
    const pivot = this.#pivot;
    for (let i = 0; i < this.#wands.length; i++) {
      const wand = this.#wands[i];
      const turns = (this.#time * wand.cycles) / LOOP_SECONDS;
      const angle = 0.72 * Math.sin(TAU * turns);
      this.#scratchDirection.set(
        Math.sin(angle) * wand.length,
        Math.cos(angle) * wand.length,
        0
      ).applyAxisAngle(this.#up, wand.yaw);
      wand.local.copy(pivot).add(this.#scratchDirection);
      wand.world.copy(wand.local).applyAxisAngle(this.#up, SITE.yaw).add(this.group.position);

      this.#scratchPosition.copy(pivot).addScaledVector(this.#scratchDirection, 0.5);
      this.#scratchUnit.copy(this.#scratchDirection).normalize();
      this.#scratchQuaternion.setFromUnitVectors(this.#up, this.#scratchUnit);
      this.#scratchScale.set(1, wand.length, 1);
      this.#scratchMatrix.compose(
        this.#scratchPosition,
        this.#scratchQuaternion,
        this.#scratchScale
      );
      this.#rods.setMatrixAt(i, this.#scratchMatrix);

      this.#scratchScale.setScalar(wand.radius * (1 + this.#syncPulse * 0.18));
      this.#scratchMatrix.compose(
        wand.local,
        this.#scratchQuaternion.identity(),
        this.#scratchScale
      );
      this.#orbs.setMatrixAt(i, this.#scratchMatrix);

      const cycle = Math.floor(turns + 1e-7);
      if (!force && cycle > wand.lastCycle) {
        const alignment = Math.abs(this.#time % LOOP_SECONDS) < 0.08;
        this.#audio.strike(i, alignment ? 0.66 : 0.34 + i * 0.018);
      }
      wand.lastCycle = cycle;
    }
    this.#rods.instanceMatrix.needsUpdate = true;
    this.#orbs.instanceMatrix.needsUpdate = true;
  }

  #seedHistory(): void {
    for (let sample = 0; sample < TRAIL_SAMPLES; sample++) {
      for (let i = 0; i < WAND_COUNT; i++) {
        const offset = (i * TRAIL_SAMPLES + sample) * 3;
        const p = this.#wands[i].local;
        this.#history[offset] = p.x;
        this.#history[offset + 1] = p.y;
        this.#history[offset + 2] = p.z;
      }
    }
    this.#historyHead = 0;
    this.#updateTrails();
  }

  #recordTrail(): void {
    this.#historyHead = (this.#historyHead + 1) % TRAIL_SAMPLES;
    for (let i = 0; i < WAND_COUNT; i++) {
      const offset = (i * TRAIL_SAMPLES + this.#historyHead) * 3;
      const p = this.#wands[i].local;
      this.#history[offset] = p.x;
      this.#history[offset + 1] = p.y;
      this.#history[offset + 2] = p.z;
    }
  }

  #updateTrails(): void {
    for (let i = 0; i < WAND_COUNT; i++) {
      for (let age = 0; age < TRAIL_SAMPLES; age++) {
        const sample = (this.#historyHead - age + TRAIL_SAMPLES) % TRAIL_SAMPLES;
        const source = (i * TRAIL_SAMPLES + sample) * 3;
        const destination = i * TRAIL_SAMPLES + age;
        this.#scratchPosition.set(
          this.#history[source],
          this.#history[source + 1],
          this.#history[source + 2]
        );
        const age01 = age / (TRAIL_SAMPLES - 1);
        this.#scratchScale.setScalar(THREE.MathUtils.lerp(0.94, 0.09, age01));
        this.#scratchMatrix.compose(
          this.#scratchPosition,
          this.#scratchQuaternion.identity(),
          this.#scratchScale
        );
        this.#trails.setMatrixAt(destination, this.#scratchMatrix);
      }
    }
    this.#trails.instanceMatrix.needsUpdate = true;
  }

  async #loadPedestalMaps(material: THREE.MeshPhysicalMaterial): Promise<void> {
    const loader = new THREE.TextureLoader();
    const entries = await Promise.all(
      Object.entries(PBR_URLS).map(async ([kind, url]) => {
        try {
          return [kind, await loader.loadAsync(url)] as const;
        } catch (error) {
          console.warn(`[hirajoshi-wave] optional ${kind} map unavailable`, error);
          return [kind, null] as const;
        }
      })
    );
    if (this.#disposed) {
      for (const [, texture] of entries) texture?.dispose();
      return;
    }
    for (const [kind, texture] of entries) {
      if (!texture) continue;
      texture.wrapS = THREE.RepeatWrapping;
      texture.wrapT = THREE.RepeatWrapping;
      texture.repeat.set(2.15, 2.15);
      texture.anisotropy = 8;
      if (kind === "albedo") texture.colorSpace = THREE.SRGBColorSpace;
      this.#textures.add(texture);
      if (kind === "albedo") material.map = texture;
      else if (kind === "roughness") material.roughnessMap = texture;
      else if (kind === "height") {
        material.bumpMap = texture;
        material.bumpScale = 0.065;
      } else if (kind === "normal") {
        material.normalMap = texture;
        material.normalScale.set(0.34, 0.34);
      } else if (kind === "ao") {
        material.aoMap = texture;
        material.aoMapIntensity = 0.72;
      }
    }
    material.needsUpdate = true;
  }

  #ownGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.#geometries.add(geometry);
    return geometry;
  }

  #ownMaterial<T extends THREE.Material>(material: T): T {
    this.#materials.add(material);
    return material;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#audio.dispose();
    this.group.removeFromParent();
    this.group.clear();
    for (const geometry of this.#geometries) geometry.dispose();
    for (const material of this.#materials) material.dispose();
    for (const texture of this.#textures) texture.dispose();
    this.#geometries.clear();
    this.#materials.clear();
    this.#textures.clear();
  }
}

function disableShadows(object: THREE.Object3D): void {
  const mesh = object as THREE.Mesh;
  if (!mesh.isMesh) return;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
}
