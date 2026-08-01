#!/usr/bin/env node
/**
 * Publish the walkable collision for the Sutro Baths descents.
 *
 * Two passes, both re-runnable:
 *
 * 1. Replace discrete stair tread colliders with smooth tilted ramps. box3d
 *    capsules have no step-assist, so discrete tread faces jam / slide (same
 *    contract as citygen/interior/stairs.ts and ghostShip stair ramps).
 *    Authored visuals stay stepped; only collision becomes continuous.
 *
 * 2. Delete the demolished v5 switchback gallery's guard rails. The spiral
 *    rebuild (tools/rebuild-sutro-grand-spiral.py) demolishes the cascade by
 *    dropping every object whose name mentions "gallery" — which caught the
 *    flights, the landings and the rails' VISUALS, but not the rail colliders,
 *    because those are named `sutro_collider_130_guard_*`. Twelve thin iron
 *    parapets were left hanging in the air over a hall with nothing under them,
 *    invisible, and the new spiral runs straight through one of them: a walker
 *    on the inner half of the flight hits a knee-high bar at 210°, jams against
 *    it, and gets squeezed up and over. That is the "I get stuck, then I start
 *    bouncing" report. The Blender script's filter is fixed to match, so a
 *    rebuild does not put them back.
 *
 * Writes data/authored-sites/sutro-baths.json, then re-injects tile_1_12.json.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE_JSON = path.join(ROOT, "data/authored-sites/sutro-baths.json");

const CENTER_X = -6125;
const CENTER_Z = 1117;
const SITE_YAW = -0.077;

const SPIRAL = {
  cx: 24.6,
  cz: 58.2,
  radius: 11.6,
  width: 5.2,
  startDeg: 20.66,
  sweepDeg: 249.34,
  topY: 31.18,
  botY: 5.78,
  /**
   * ONE RAMP PER VISUAL TREAD (tools/rebuild-sutro-grand-spiral.py's 128), and
   * that count is the walkability contract for this flight.
   *
   * Each ramp is a flat slab: level across the tread, tilted along the tangent
   * at its own mid-angle. A helix is not flat, so a slab's top plane sits above
   * the true helical surface on one side of the centre-line and below it on the
   * other, by half-width × yaw-step × slope. Two neighbouring slabs are
   * therefore a CONSTANT height apart at any fixed distance from the
   * centre-line, and the walk surface — the upper envelope of the two — drops
   * that whole distance where the higher slab's coverage ends.
   *
   * At 40 segments that drop was 12 cm on the inner edge, once per segment, all
   * the way down: a hidden 12 cm stair running against the visible one, which a
   * capsule with no step-assist catches on, is bounced by, and jams against.
   * The error scales with the yaw step, so tread-cadence segments put it at
   * ~4 cm — inside what the walker's step-climb allowance absorbs without the
   * body ever leaving the surface (see src/player/walk.ts).
   */
  segments: 128
};

const RAMP_HY = 0.13;
const BEACH = {
  x0: -62,
  x1: -39,
  z: 33.29,
  width: 8.2,
  y0: 1.75,
  y1: 5.83
};
const ROAD = {
  x0: 55.05,
  x1: 59.05,
  z: 63.1,
  width: 9.4,
  y0: 31.44,
  y1: 32.48
};

function localToWorld(lx, lz) {
  const c = Math.cos(SITE_YAW);
  const s = Math.sin(SITE_YAW);
  return {
    x: CENTER_X + c * lx + s * lz,
    z: CENTER_Z - s * lx + c * lz
  };
}

function qmul(a, b) {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz
  ];
}

/**
 * Ramp whose local +X climbs uphill. Matches the building-tile yaw convention
 * (setBodyTransform uses +yaw/2) composed with a +Z pitch, same geometry the
 * stoop builder aims for but with the authored-site yaw sign.
 */
function rampQuat(uphillX, uphillZ, pitch) {
  // box3d +Y yaw by ψ sends +X → (cos ψ, −sin ψ). We want +X → (ux, uz), so
  // cos ψ = ux and −sin ψ = uz ⇒ ψ = atan2(−uz, ux).
  const psi = Math.atan2(-uphillZ, uphillX);
  const qYaw = [0, Math.sin(psi / 2), 0, Math.cos(psi / 2)];
  const qPitch = [0, 0, Math.sin(pitch / 2), Math.cos(pitch / 2)];
  return qmul(qYaw, qPitch);
}

function straightRamp({ x0, x1, z, width, y0, y1 }, name, index) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const run = Math.abs(dx);
  const pitch = Math.atan2(Math.abs(dy), run);
  const slopeLen = Math.hypot(run, Math.abs(dy));
  const midLocalX = (x0 + x1) * 0.5;
  const midLocalY = (y0 + y1) * 0.5;
  const uphillLocalX = Math.sign(dy) * Math.sign(dx) || Math.sign(dx) || 1;
  // Uphill in local xz (along ±x).
  const upLocal = { x: uphillLocalX, z: 0 };
  const upWorld = (() => {
    const c = Math.cos(SITE_YAW);
    const s = Math.sin(SITE_YAW);
    return { x: c * upLocal.x + s * upLocal.z, z: -s * upLocal.x + c * upLocal.z };
  })();
  const len = Math.hypot(upWorld.x, upWorld.z) || 1;
  upWorld.x /= len;
  upWorld.z /= len;
  const quat = rampQuat(upWorld.x, upWorld.z, pitch);
  const nY = Math.cos(pitch);
  const nH = Math.sin(pitch);
  const world = localToWorld(midLocalX, z);
  // Sink centre along the surface normal so the TOP face is the walk surface
  // (same offset as citygen stoop: mid - normal·hy).
  const cx = world.x + upWorld.x * nH * RAMP_HY;
  const cy = midLocalY - nY * RAMP_HY;
  const cz = world.z + upWorld.z * nH * RAMP_HY;
  const yaw = Math.atan2(-upWorld.z, upWorld.x);
  return {
    name,
    i: index,
    x: round(cx),
    y: round(cy),
    z: round(cz),
    hx: round(slopeLen * 0.5 + 0.12),
    hy: RAMP_HY,
    hz: round(width * 0.5 + 0.04),
    yaw: round(yaw),
    quat: quat.map(round)
  };
}

function spiralRamps(startIndex) {
  const sweepRad = (SPIRAL.sweepDeg * Math.PI) / 180;
  const totalRise = SPIRAL.topY - SPIRAL.botY;
  const pitch = Math.atan2(totalRise, SPIRAL.radius * sweepRad);
  const out = [];
  let index = startIndex;
  for (let seg = 0; seg < SPIRAL.segments; seg++) {
    const t0 = seg / SPIRAL.segments;
    const t1 = (seg + 1) / SPIRAL.segments;
    const mid = (t0 + t1) * 0.5;
    const thetaDeg = SPIRAL.startDeg + SPIRAL.sweepDeg * mid;
    const theta = (thetaDeg * Math.PI) / 180;
    const y = SPIRAL.topY + (SPIRAL.botY - SPIRAL.topY) * mid;
    const lx = SPIRAL.cx + SPIRAL.radius * Math.cos(theta);
    const lz = SPIRAL.cz + SPIRAL.radius * Math.sin(theta);
    const world = localToWorld(lx, lz);

    // Downhill local xz as θ increases: (−sin θ, cos θ). Uphill is opposite.
    const downLocal = { x: -Math.sin(theta), z: Math.cos(theta) };
    const c = Math.cos(SITE_YAW);
    const s = Math.sin(SITE_YAW);
    const downWorld = {
      x: c * downLocal.x + s * downLocal.z,
      z: -s * downLocal.x + c * downLocal.z
    };
    const dLen = Math.hypot(downWorld.x, downWorld.z) || 1;
    downWorld.x /= dLen;
    downWorld.z /= dLen;
    const upWorld = { x: -downWorld.x, z: -downWorld.z };
    const quat = rampQuat(upWorld.x, upWorld.z, pitch);

    const dTheta = sweepRad / SPIRAL.segments;
    const slopeLen = Math.hypot(SPIRAL.radius * dTheta, totalRise / SPIRAL.segments);
    const nY = Math.cos(pitch);
    const nH = Math.sin(pitch);

    out.push({
      name: `sutro_collider_110_spiral_ramp_${String(seg).padStart(2, "0")}`,
      i: index++,
      x: round(world.x + upWorld.x * nH * RAMP_HY),
      y: round(y - nY * RAMP_HY),
      z: round(world.z + upWorld.z * nH * RAMP_HY),
      hx: round(slopeLen * 0.5 + 0.1),
      hy: RAMP_HY,
      hz: round(SPIRAL.width * 0.5 + 0.08),
      yaw: round(Math.atan2(-upWorld.z, upWorld.x)),
      quat: quat.map(round)
    });
  }
  return out;
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

function reindex(colliders, base = 110000) {
  return colliders.map((c, i) => ({ ...c, i: base + i }));
}

async function main() {
  const site = JSON.parse(await fs.readFile(SITE_JSON, "utf8"));
  // Drops both the discrete treads this pass replaces AND the ramps a previous
  // run of this pass wrote, so re-running it retunes the flight instead of
  // stacking a second set of slabs on top of the first.
  const kept = site.colliders.filter((c) => {
    const n = c.name;
    return !(
      n.includes("spiral_tread_") ||
      n.includes("spiral_ramp_") ||
      n.includes("beach_step_") ||
      n.includes("beach_ramp") ||
      n.includes("road_approach_") ||
      // …and the demolished cascade's orphaned parapets (see the header). Match
      // `guard_` exactly: `130_spiral_rail_*` is the LIVE flight's balustrade.
      n.includes("_130_guard_")
    );
  });
  const orphanedGuards = site.colliders.filter((c) => c.name.includes("_130_guard_")).length;

  const nextIndex = 110000 + kept.length;
  const ramps = [
    ...spiralRamps(nextIndex),
    straightRamp(BEACH, "sutro_collider_200_beach_ramp", nextIndex + SPIRAL.segments),
    straightRamp(ROAD, "sutro_collider_120_road_approach_ramp", nextIndex + SPIRAL.segments + 1)
  ];

  site.colliders = reindex([...kept, ...ramps]);
  site.stats = {
    ...site.stats,
    colliders: site.colliders.length
  };

  await fs.writeFile(SITE_JSON, `${JSON.stringify(site)}\n`);

  // Collider-only inject (full inject-authored-site also rewrites the GLB tile
  // and needs @gltf-transform; walkability only needs the physics JSON).
  const colliderPath = path.join(ROOT, "public/data/colliders", `tile_${site.tile}.json`);
  let tileColliders = JSON.parse(await fs.readFile(colliderPath, "utf8"));
  const replacements = new Set(
    (site.replaces ?? []).filter((entry) => entry.tile === site.tile).map((entry) => entry.index)
  );
  tileColliders = tileColliders.filter(
    (collider) => collider.sfSite !== site.id && !replacements.has(collider.i)
  );
  tileColliders.push(
    ...site.colliders.map((collider) => ({
      i: collider.i,
      p: 7,
      x: collider.x,
      y: collider.y,
      z: collider.z,
      hx: collider.hx,
      hy: collider.hy,
      hz: collider.hz,
      yaw: collider.yaw,
      ...(collider.quat ? { quat: collider.quat } : {}),
      vol: 1_000_000_000,
      sfSite: site.id
    }))
  );
  await fs.writeFile(colliderPath, JSON.stringify(tileColliders));

  console.log(
    JSON.stringify({
      kept: kept.length,
      orphanedGuardsRemoved: orphanedGuards,
      spiralRamps: SPIRAL.segments,
      beachRoadRamps: 2,
      total: site.colliders.length,
      tileColliders: tileColliders.length,
      pitchDeg: (Math.atan2(SPIRAL.topY - SPIRAL.botY, SPIRAL.radius * (SPIRAL.sweepDeg * Math.PI) / 180) * 180) / Math.PI
    })
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
