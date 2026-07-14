import * as THREE from "three/webgpu";
import { WIND_DIR } from "../vegetation/wind";
import { SUTRO_BATHS, SUTRO_POOLS, distanceToSutroWater, sutroLocalToWorld } from "./layout";
import { SUTRO_BATHS_TUNING } from "./tuning";

const PUFF_COUNT = 72;
const WAKE_DISTANCE = 132;
const SLEEP_DISTANCE = 154;

type Puff = {
  life: number;
  rate: number;
  localX: number;
  localZ: number;
  lateral: number;
  phase: number;
  size: number;
  spin: number;
  seed: number;
  poolIndex: number;
};

export type SutroBathsSteam = {
  group: THREE.Group;
  update(
    dt: number,
    time: number,
    player: { x: number; z: number },
    camera: THREE.Camera,
    gust: number
  ): void;
  setEnabled(enabled: boolean): void;
  readonly stats: { puffs: number; visible: number; awake: boolean; playerDistance: number };
  dispose(): void;
};

function smooth01(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function random01(puff: Puff): number {
  puff.seed = (Math.imul(puff.seed, 1664525) + 1013904223) >>> 0;
  return puff.seed / 0x1_0000_0000;
}

function softPuffTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Sutro Baths steam requires a 2D canvas context");
  const glow = ctx.createRadialGradient(size * 0.48, size * 0.46, 0, size / 2, size / 2, size / 2);
  glow.addColorStop(0, "rgba(255,255,248,0.58)");
  glow.addColorStop(0.3, "rgba(239,246,239,0.34)");
  glow.addColorStop(0.72, "rgba(222,235,229,0.1)");
  glow.addColorStop(1, "rgba(211,228,223,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.name = "sutro_baths_procedural_steam_puff";
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  return texture;
}

const HOT_POOLS = SUTRO_POOLS
  .map((pool, index) => ({ pool, index }))
  .filter(({ pool }) => pool.heat >= 0.34);

function reseed(puff: Puff, phase = 0): void {
  const selection = HOT_POOLS[Math.floor(random01(puff) * HOT_POOLS.length) % HOT_POOLS.length];
  puff.poolIndex = selection.index;
  const { pool } = selection;
  const margin = 0.7;
  puff.localX = THREE.MathUtils.lerp(pool.minX + margin, pool.maxX - margin, random01(puff));
  puff.localZ = THREE.MathUtils.lerp(pool.minZ + margin, pool.maxZ - margin, random01(puff));
  puff.lateral = (random01(puff) - 0.5) * 1.35;
  puff.phase = random01(puff) * Math.PI * 2;
  puff.size = THREE.MathUtils.lerp(0.38, 0.86, random01(puff));
  puff.spin = (random01(puff) - 0.5) * 0.5;
  puff.rate = 1 / THREE.MathUtils.lerp(4.4, 7.2, random01(puff));
  puff.life = phase;
}

/** One instanced, camera-facing puff pool serves every heated tank. */
export function createSutroBathsSteam(): SutroBathsSteam {
  if (HOT_POOLS.length === 0) throw new Error("Sutro Baths steam has no heated pools");

  const group = new THREE.Group();
  group.name = "sutro_baths_thermal_steam";
  group.visible = false;

  const texture = softPuffTexture();
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    color: 0xe8f0e8,
    transparent: true,
    opacity: SUTRO_BATHS_TUNING.values.steamOpacity,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
    fog: true,
    toneMapped: true
  });
  const mesh = new THREE.InstancedMesh(geometry, material, PUFF_COUNT);
  mesh.name = "sutro_baths_instanced_steam_puffs";
  mesh.frustumCulled = false;
  mesh.renderOrder = 22;
  mesh.layers.set(31);
  group.add(mesh);

  const puffs: Puff[] = [];
  for (let i = 0; i < PUFF_COUNT; i++) {
    const puff: Puff = {
      life: 0,
      rate: 0,
      localX: 0,
      localZ: 0,
      lateral: 0,
      phase: 0,
      size: 1,
      spin: 0,
      seed: (0x9e3779b9 ^ Math.imul(i + 1, 0x85ebca6b)) >>> 0,
      poolIndex: 0
    };
    reseed(puff, i / PUFF_COUNT);
    puffs.push(puff);
  }

  const dummy = new THREE.Object3D();
  const world = new THREE.Vector3();
  const cameraQuaternion = new THREE.Quaternion();
  const spinQuaternion = new THREE.Quaternion();
  const spinAxis = new THREE.Vector3(0, 0, 1);
  const stats = {
    puffs: PUFF_COUNT,
    visible: 0,
    awake: false,
    playerDistance: Number.POSITIVE_INFINITY
  };
  mesh.userData.steam = stats;

  let enabled = true;
  let awake = false;
  let disposed = false;

  const hideAll = () => {
    if (!group.visible && stats.visible === 0) return;
    group.visible = false;
    stats.visible = 0;
  };

  return {
    group,
    update(dt, time, player, camera, gust) {
      if (disposed) return;
      const tuning = SUTRO_BATHS_TUNING.values;
      stats.playerDistance = distanceToSutroWater(player.x, player.z);
      const wantsSteam = enabled && tuning.steamEnabled && tuning.steamAmount > 0.002;
      if (!wantsSteam) awake = false;
      else if (awake) awake = stats.playerDistance <= SLEEP_DISTANCE;
      else awake = stats.playerDistance <= WAKE_DISTANCE;
      stats.awake = awake;
      if (!awake) {
        hideAll();
        return;
      }

      group.visible = true;
      material.opacity = tuning.steamOpacity;
      const safeDt = THREE.MathUtils.clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
      const visibleCount = Math.max(1, Math.round(PUFF_COUNT * tuning.steamAmount));
      const windAmount = THREE.MathUtils.lerp(0.28, 1.05, THREE.MathUtils.clamp(gust, 0, 1));
      const riseHeight = tuning.steamHeight;
      camera.getWorldQuaternion(cameraQuaternion);

      for (let i = 0; i < PUFF_COUNT; i++) {
        const puff = puffs[i];
        if (i >= visibleCount) {
          dummy.position.set(0, -10000, 0);
          dummy.scale.setScalar(0);
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
          continue;
        }

        puff.life += safeDt * puff.rate;
        if (puff.life >= 1) reseed(puff, puff.life - 1);
        const life = puff.life;
        const fadeIn = smooth01(life / 0.12);
        const fadeOut = 1 - smooth01((life - 0.5) / 0.5);
        const billow = fadeIn * fadeOut;
        const base = sutroLocalToWorld(puff.localX, puff.localZ);
        const drift = life * life * (2.2 + riseHeight * 0.42) * windAmount;
        const curl = Math.sin(time * 0.52 + puff.phase + life * 7.2) * (0.18 + life * 0.62);
        world.set(
          base.x + WIND_DIR.x * drift + WIND_DIR.z * puff.lateral * curl,
          SUTRO_BATHS.waterY + 0.14 + life * riseHeight,
          base.z + WIND_DIR.z * drift - WIND_DIR.x * puff.lateral * curl
        );

        dummy.position.copy(world);
        dummy.quaternion.copy(cameraQuaternion);
        spinQuaternion.setFromAxisAngle(
          spinAxis,
          Math.sin(puff.phase) * 0.16 + Math.sin(time * 0.22 + puff.phase) * puff.spin * 0.22
        );
        dummy.quaternion.multiply(spinQuaternion);
        const visibility = Math.max(0.03, billow);
        const width = puff.size * (0.28 + life * 0.92) * visibility;
        const height = puff.size * (0.55 + life * 1.82) * visibility;
        dummy.scale.set(width, height, 1);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.count = PUFF_COUNT;
      mesh.instanceMatrix.needsUpdate = true;
      stats.visible = visibleCount;
    },
    setEnabled(next) {
      enabled = next;
      if (!next) {
        awake = false;
        stats.awake = false;
        hideAll();
      }
    },
    stats,
    dispose() {
      if (disposed) return;
      disposed = true;
      geometry.dispose();
      material.dispose();
      texture.dispose();
      group.removeFromParent();
    }
  };
}
