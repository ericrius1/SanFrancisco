// Void-arrival wiring (M18): the ring coordinator (scan → morph → fill →
// reveal phase machine), the fabric visibility gate arming, far-arrival
// classification/cut hooks and the per-frame ringUpdate driver — extracted
// from main.ts's P5 block (docs/MAIN_DECOMPOSITION.md). main assigns the
// returned hooks onto its boot-scope lets; no behavior change.
import { CONFIG } from "../../config";
import { bootMark } from "../../core/bootMarks";
import { materializeField } from "../../render/materialize";
import { frontGate } from "../../render/frontGate";
import { RingCoordinator } from "../ringCoordinator";
import { tracer } from "../../core/hitchTracer";
import type { TerrainTileStreamer } from "../../world/terrainTiles";
import type { TerrainScanParticles } from "../../world/terrainScanParticles";
import type { MainCtx } from "./ctx";

export function installVoidArrival(deps: {
  ctx: Pick<MainCtx, "player" | "tiles" | "authoredRegions" | "sky" | "map" | "fullTileRadius">;
  bootQuery: URLSearchParams;
  terrainTiles: TerrainTileStreamer | null;
  scanParticles: TerrainScanParticles | null;
  primeInitialVisualAt: (x: number, z: number) => void;
  /** LIVE reads of main's late-assigned citygen hooks (NET module wires them). */
  citygenResidencyRadius: (x: number, z: number) => number;
  citygenApplyFrontGate: () => void;
}) {
  const { player, tiles, authoredRegions, sky, map, fullTileRadius } = deps.ctx;
  const { bootQuery, terrainTiles, scanParticles } = deps;
  // ---------------------------------------------- P5 ring coordinator (M18)
  // Owns the void arrival phases: the terrain-scan particle wave (scanning),
  // the dawn (morphing), the fog-walled world build (filling) and the big
  // fog reveal (revealing). Both voidTick and the real loop call
  // ringCoordinator.update right before materializeField.update. Staged tile
  // expansion keeps its existing triggers (bootArrivalTick completion, the
  // worldReady quiet-window block below); the fill chases what lands and only
  // nudges a stage directly after a 20 s stall so continuous movement can't
  // pin the fog wall forever.
  // `?voidholo=1` still means "hold the void" for manual `__sf.materialize`.
  // M12 QA escape hatch (`?nofrontgate=1`, the ?nofarcut precedent): keep the
  // fabric visibility gate permanently inactive for A/B timing on one build.
  const frontGateDisabled = bootQuery.has("nofrontgate");
  const frontGateWanted = (active: boolean) => frontGate.setActive(active && !frontGateDisabled);
  const ringCoordinator = new RingCoordinator(player.position.x, player.position.z, {
    tiles,
    player,
    prime: deps.primeInitialVisualAt,
    fullRadius: fullTileRadius,
    // M9: surf caps CONFIG.tileLoadRadius at 2 km (< reveal radius); the
    // coordinator reveals at a plateaued live cap instead of waiting forever.
    liveLoadRadius: () => CONFIG.tileLoadRadius,
    // M18: the scan wave chases installed terrain DATA only — the particle
    // field must never form ground whose real heights haven't landed.
    terrainRadius: (x, z) =>
      terrainTiles ? terrainTiles.residentRadiusAround(x, z) : Infinity,
    // M5: citygen cell publication joins the FILL residency min — the fog
    // wall never drops while a cell is mid baked→chunk swap.
    citygenRadius: (x, z) => deps.citygenResidencyRadius(x, z),
    // M18: the void fog wall lives in the sky's fog node.
    fogWall: (x, z, radius, density) => sky.setVoidFogWall(x, z, radius, density),
    holdHolo: bootQuery.has("voidholo"),
    // M16: hold the front at the player's ~5 m pool of light until control is
    // handed over AND the anchor terrain tile is real (spawn OR teleport dest
    // — the gate re-evaluates against the live focus). Only then does the
    // bloom clock start and the world ring out. body.started flips in the
    // start handler's immediate half; classList.contains is a cheap DOM read.
    spreadGate: (cx, cz) =>
      document.body.classList.contains("started") && map.isTileRealAt(cx, cz),
    onSettled: () => bootMark("frontComplete"),
    onExpansionStalled: () => {
      // The same restore the worldReady quiet-window block performs, forced
      // after the stall deadline. Surf keeps its explicit 2 km mode cap (its
      // stash restore is handled by that block when the session quiets down).
      if (player.mode !== "surf" && CONFIG.tileLoadRadius < fullTileRadius) {
        CONFIG.tileLoadRadius = fullTileRadius;
        CONFIG.tileUnloadRadius = fullTileRadius + 400;
      }
      tiles.beginBackgroundExpansion();
    }
  });
  // M12: arm the visibility gate synchronously with the coordinator (same
  // block — no tick, and therefore no tile finalize, can run in between), so
  // the very first resident content beyond the collapsed front starts hidden.
  frontGateWanted(ringCoordinator.fabricHeld);
  // Anything that landed BEFORE the gate armed (P1 landmarks GLB — the Bay/
  // Golden Gate bridges and Alcatraz are boot-resident and were visible as
  // silhouettes across the void) re-gates now against the collapsed front.
  tiles.applyFrontGate();
  // Ready authored regions (rare this early, but the boot-critical ones can
  // attach before this block) re-gate against the collapsed front too.
  authoredRegions.applyFrontGate();
  // M7 far-arrival classification. FAR means "the destination's content is
  // not resident": the hop is a genuine relocation (> FAR_ARRIVAL_MIN_HOP —
  // recovery probes and short covered mode relocations stay near) AND the
  // attached-tile radius measured AROUND THE DESTINATION is below
  // FAR_ARRIVAL_RESIDENT_MIN. `tiles.residentRadiusAround(dest)` is the
  // truest available residency signal: a short hop inside the settled world
  // reads a large radius (near — never re-dissolve a resident front), while a
  // multi-km teleport reads ~0 because nothing near the destination is
  // attached. Classification runs pre-commit, so player.position is the
  // origin. The one-off dest-centred query costs a single 205-entry manifest
  // pass at arrival time.
  const FAR_ARRIVAL_MIN_HOP = 500;
  const FAR_ARRIVAL_RESIDENT_MIN = 500;
  // `?nofarcut=1`: QA escape hatch — force every arrival onto the pre-M7 near
  // path (full visual settle under the cover) for A/B timing on one build.
  const farCutDisabled = bootQuery.has("nofarcut");
  const classifyFarArrival = (x: number, z: number): boolean => {
    if (farCutDisabled) return false;
    const hop = Math.hypot(x - player.position.x, z - player.position.z);
    if (hop < FAR_ARRIVAL_MIN_HOP) return false;
    if (tiles.residentRadiusAround(x, z) < FAR_ARRIVAL_RESIDENT_MIN) return true;
    // M18: mid-phase, ground beyond the unveiled area is still black void
    // (scan) or dense fog (fill) — a near-classified hop there would drop the
    // cover into it. Classify it far so the phases replay at the destination.
    return !ringCoordinator.coversPoint(x, z);
  };
  // The cut moment of a far arrival: abort any in-flight sweep (latest-wins,
  // boot included), recenter + collapse the front at the destination, and
  // chase its residency exactly like boot. `prime: false` — worldArrival
  // already primed tiles/regions/collision through its own epoch-guarded path.
  const onFarArrivalCut = (x: number, z: number): void => {
    tracer.begin("arrivalCut");
    // M14: re-anchor terrain-data streaming at the destination (the arrival's
    // ground wait requires the dest tile REAL before the cover can drop).
    terrainTiles?.setAnchor(x, z);
    ringCoordinator.focus(x, z, { reset: true, prime: false });
    // M12: refocus re-arms the visibility gate — content revealed by the
    // previous sweep (or shown by the covered-arrival adopt while the front was
    // still centred at the origin) re-hides when it lies beyond the collapsed
    // front at the destination. Runs at the cut, under the arrival cover.
    frontGateWanted(true);
    tiles.applyFrontGate();
    authoredRegions.applyFrontGate();
    deps.citygenApplyFrontGate();
    // M15: one-off boot props (surf shack, …) re-gate against the collapsed
    // front at the destination too.
    frontGate.applyStatic();
    tracer.end("arrivalCut");
  };
  // M7 shadow streaming hold: while fabric is held (scan + morph — casters
  // are hidden/black anyway), static shadow-domain redraws are held and
  // latched dirt applies as one redraw per domain when the fill begins.
  let shadowStreamingHold = false;
  const ringUpdate = (dt: number): void => {
    // M14: terrain tile streaming rides the same per-frame path — one decoded
    // install max per call, then fetch top-up (no-op once everything wanted
    // is real).
    terrainTiles?.update(player.position.x, player.position.z);
    ringCoordinator.update(dt);
    // M18: fabric visibility rides the phase machine — held through scan +
    // morph, released into the budgeted flush as the fill begins (fabric
    // birth-fades in behind the fog wall). Both calls are trivial early-outs
    // once settled with an empty gate (zero steady-state cost).
    const held = ringCoordinator.fabricHeld;
    frontGateWanted(held);
    frontGate.update();
    // The scan particle field only draws during the void phases (its scales
    // also collapse via the uniforms, but visible=false skips the draws).
    scanParticles?.setVisible(held);
    if (held !== shadowStreamingHold) {
      shadowStreamingHold = held;
      sky.setStaticShadowStreamingHold(held);
    }
  };
  if (import.meta.env.DEV || bootQuery.has("profile")) {
    Object.assign((window as never as { __sfVoid: Record<string, unknown> }).__sfVoid, {
      ringState: () => ringCoordinator.state,
      residentRadius: () => ringCoordinator.residentRadius(),
      // M12 probe surface: how many chunks the front gate is hiding + the
      // clearedRadius the coordinator clamps to.
      frontGate: () => ({
        active: frontGate.active,
        hidden: frontGate.hiddenCount,
        cleared: frontGate.clearedRadius()
      }),
      // M18 probe surface: the global dawn ramp.
      worldReveal: () => materializeField.worldReveal.value as number,
      // M14 probe surface: terrain-data streaming telemetry.
      terrainTiles: () => terrainTiles
        ? {
          ...terrainTiles.debug(),
          residentRadius: terrainTiles.residentRadiusAround(player.position.x, player.position.z),
          spawnTileReal: map.isTileRealAt(player.position.x, player.position.z)
        }
        : null
    });
  }
  return { ringCoordinator, frontGateWanted, classifyFarArrival, onFarArrivalCut, ringUpdate };
}
