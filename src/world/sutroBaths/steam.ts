// Beautiful volumetric thermal steam over the restored Sutro Baths hot pools.
//
// Replaces the old flat billboard-puff pool with a GPU raymarched volume: one
// upright box shell per heated tank, whose fragment shader clips the view ray to
// the pool column and marches an advected triNoise3D density with Beer-Lambert
// transmittance and a cheap sun-scatter term. Warm at the water, cool white as
// it rises — real catching-the-light vapour, not particles. The heavy shader
// lives in ./steamVolume; this module owns lifecycle, the distance-sleep gate,
// and per-frame uniform updates. The public signature is unchanged so the
// index.ts wiring stays intact.

import * as THREE from "three/webgpu";
import { SUN_DIR } from "../sky";
import { SUTRO_BATHS, SUTRO_POOLS, distanceToSutroWater } from "./layout";
import { SUTRO_BATHS_TUNING } from "./tuning";
import { STEAM_MAX_HEIGHT, createSteamShell, createSteamUniforms } from "./steamVolume";

const WAKE_DISTANCE = 132;
const SLEEP_DISTANCE = 154;
const MAX_STEPS_CLAMP = 40;

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

const HOT_POOLS = SUTRO_POOLS.filter((pool) => pool.heat >= 0.34);

/** One raymarched volumetric column per heated tank; a few cheap draws. */
export function createSutroBathsSteam(): SutroBathsSteam {
  if (HOT_POOLS.length === 0) throw new Error("Sutro Baths steam has no heated pools");

  const group = new THREE.Group();
  group.name = "sutro_baths_thermal_steam";
  group.visible = false;

  const u = createSteamUniforms();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.name = "sutro_steam_column";

  const siteYaw = SUTRO_BATHS.yaw;

  const shells = HOT_POOLS.map((pool) => {
    const box = {
      cx: (pool.minX + pool.maxX) * 0.5,
      cz: (pool.minZ + pool.maxZ) * 0.5,
      halfX: (pool.maxX - pool.minX) * 0.5 + 0.85,
      halfZ: (pool.maxZ - pool.minZ) * 0.5 + 0.85,
      heat: pool.heat
    };
    return createSteamShell(geometry, box, u, siteYaw);
  });
  for (const shell of shells) group.add(shell.mesh);

  const stats = {
    puffs: shells.length,
    visible: 0,
    awake: false,
    playerDistance: Number.POSITIVE_INFINITY
  };

  let enabled = true;
  let awake = false;
  let disposed = false;

  const hide = () => {
    if (group.visible || stats.visible !== 0) {
      group.visible = false;
      stats.visible = 0;
    }
  };

  return {
    group,
    update(dt, time, player, _camera, gust) {
      if (disposed) return;
      const tuning = SUTRO_BATHS_TUNING.values;
      stats.playerDistance = distanceToSutroWater(player.x, player.z);
      const wantsSteam = enabled && tuning.steamEnabled && tuning.steamAmount > 0.002;
      if (!wantsSteam) awake = false;
      else if (awake) awake = stats.playerDistance <= SLEEP_DISTANCE;
      else awake = stats.playerDistance <= WAKE_DISTANCE;
      stats.awake = awake;
      if (!awake) {
        hide();
        return;
      }

      group.visible = true;
      const safeDt = THREE.MathUtils.clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
      const t = Number.isFinite(time) ? time : (u.time.value as number) + safeDt;
      u.time.value = t;
      u.gust.value = THREE.MathUtils.clamp(Number.isFinite(gust) ? gust : 0, 0, 1);
      u.amount.value = tuning.steamAmount;
      u.opacity.value = tuning.steamOpacity;
      u.height.value = THREE.MathUtils.clamp(tuning.steamHeight, 1, STEAM_MAX_HEIGHT);
      // Optional extra knobs the orchestrator may wire into tuning.ts; read
      // defensively so this module works with or without them.
      const extra = tuning as unknown as Record<string, number | undefined>;
      const rawSteps = extra.steamSteps;
      u.steps.value = THREE.MathUtils.clamp(
        Math.round(typeof rawSteps === "number" && Number.isFinite(rawSteps) ? rawSteps : 28),
        12,
        MAX_STEPS_CLAMP
      );
      const sunGain = extra.steamSunGain;
      u.sunGain.value = typeof sunGain === "number" && Number.isFinite(sunGain) ? sunGain : 0.9;
      const curl = extra.steamCurl;
      u.curl.value = typeof curl === "number" && Number.isFinite(curl) ? curl : 0.6;
      (u.sunDir.value as THREE.Vector3).copy(SUN_DIR);

      stats.visible = shells.length;
    },
    setEnabled(next) {
      enabled = next;
      if (!next) {
        awake = false;
        stats.awake = false;
        hide();
      }
    },
    stats,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const shell of shells) shell.material.dispose();
      geometry.dispose();
      group.removeFromParent();
    }
  };
}
