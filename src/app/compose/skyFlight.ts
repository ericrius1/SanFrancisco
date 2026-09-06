import * as THREE from "three/webgpu";
import { SKY_ISLANDS, getSkyIsland, type SkyIslandId } from "../../world/skyIslands/metadata";
import type { SkyFlightHUD } from "../../ui/skyFlight";
import { WALK_CAPSULE_HALF_EXTENT } from "../../player/walk";
import type { MainCtx } from "./ctx";

const JOURNAL_KEY = "sf.sky-flight.discovered.v1";

/** Boot owns only an affordance and metadata. Island geometry, gardens and the
 * journal panel each cross their own first-use/proximity boundary. */
export function createSkyFlightFeature(
  ctx: MainCtx,
  core: Awaited<ReturnType<typeof import("./worldSystemsCore").composeWorldSystemsCore>>,
  netW: Awaited<ReturnType<typeof import("./worldSystemsNet").composeWorldSystemsNet>>
) {
  const { player, input, camera, scene, chase } = ctx;
  const host = document.getElementById("hud")!;
  const launch = document.createElement("button");
  launch.id = "sky-flight-launch";
  launch.type = "button";
  launch.textContent = "✦ Flight & gravity · Space to soar";
  launch.setAttribute("aria-label", "Open flight and gravity controls");
  const style = document.createElement("style");
  style.textContent = `
    #sky-flight-launch:not(.sf-flight-launch) {position:absolute;right:18px;bottom:118px;z-index:10;
      border:1px solid #9cebd888;border-radius:24px;padding:10px 14px;
      color:#dffff4;background:linear-gradient(120deg,#102c36ee,#30243eee);
      font:600 11px system-ui;cursor:pointer;pointer-events:auto;box-shadow:0 6px 20px #00152240}
    #sky-flight-launch:not(.sf-flight-launch):focus-visible {outline:2px solid #a9ffe1;outline-offset:3px}
    #sky-garden-signal {position:absolute;top:92px;left:50%;transform:translateX(-50%);
      max-width:calc(100vw - 50px);padding:7px 14px;border-radius:20px;
      background:#122b36ba;color:#c4ffef;font:600 11px system-ui;text-align:center;
      pointer-events:none;text-shadow:0 1px 3px #00131f}
    @media(max-width:620px){#sky-flight-launch:not(.sf-flight-launch){right:12px;bottom:118px;max-width:calc(100vw - 24px)}}
  `;
  document.head.append(style);
  const signal = document.createElement("div");
  signal.id = "sky-garden-signal";
  signal.hidden = true;
  host.append(launch, signal);
  const visited = new Set<SkyIslandId>();
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? "[]");
    if (Array.isArray(ids)) for (const island of SKY_ISLANDS) if (ids.includes(island.id)) visited.add(island.id);
  } catch { /* Storage is optional. */ }
  let panel: SkyFlightHUD | null = null;
  let panelLoading: Promise<void> | null = null;
  let islands: ReturnType<typeof import("../../world/skyIslands").createSkyIslands> | null = null;
  let loading: Promise<void> | null = null;
  let target: SkyIslandId | null = null;
  let dwellId: SkyIslandId | null = null;
  let dwell = 0;
  let uiTime = 0;
  let disposed = false;
  let loadFailedAt = -Infinity;
  const projected = new THREE.Vector3();

  for (const island of SKY_ISLANDS) {
    ctx.state.siteFoliage?.register({
      id: `sky-garden-${island.id}`,
      ...island.center,
      loadDistance: island.bodyRadius + 125,
      unloadDistance: island.bodyRadius + 230,
      build: async () => {
        const { createSkyIslandVegetation } = await import("../../world/skyIslands/vegetation");
        return createSkyIslandVegetation(island.id);
      }
    });
  }

  async function ensureWorld() {
    if (islands) return;
    if (loading) return loading;
    loading = import("../../world/skyIslands").then(({ createSkyIslands }) => {
      if (disposed) return;
      islands = createSkyIslands({ loadDistance: 620, unloadDistance: 880 });
      scene.add(islands.root);
      islands.setAwakened(visited.size === SKY_ISLANDS.length);
    }).catch((error) => {
      loadFailedAt = performance.now();
      console.warn("[sky-flight] gardens could not load", error);
      core.hud.message("The sky gardens couldn't load. Try again in a moment.", 3);
      throw error;
    }).finally(() => { loading = null; });
    return loading;
  }

  function setTarget(id?: SkyIslandId) {
    target = id ?? SKY_ISLANDS.find((island) => !visited.has(island.id))?.id ?? SKY_ISLANDS[0].id;
    core.hud.message(`Follow the sky signal to ${getSkyIsland(target).label} · Space rise · Shift boost`, 4);
  }

  function travel(id: SkyIslandId) {
    const island = getSkyIsland(id);
    target = id;
    panel?.close();
    netW.navigation.teleportCustom({
      label: island.label,
      resolve: async (abort) => {
        await ensureWorld();
        if (abort.aborted) throw new DOMException("Travel cancelled", "AbortError");
        const destination = { x: island.center.x, y: island.center.y + island.bodyRadius + 5, z: island.center.z };
        islands?.update(destination, ctx.state.elapsed);
        if (islands) await ctx.pipeline.compileAsyncPrioritized(islands.root, camera, scene);
        if (abort.aborted) throw new DOMException("Travel cancelled", "AbortError");
        return {
          ...destination,
          cameraYaw: 0,
          commit: () => {
            netW.minigameSession.releaseForNavigation(netW.captureMinigameOrigin());
            core.embodiments.leaveRide();
            core.embodiments.exitToWalk();
            core.setViewMode("third");
            player.respawn({ ...destination, heading: 0 });
            player.skyFlight.enabled = true;
            player.skyFlight.setGravity(0);
            player.snapRenderPose();
          }
        };
      },
      successMessage: `${island.label} · settle into its gravity to hear a memory`
    });
  }

  async function open() {
    if (panel) { panel.open(); return; }
    if (panelLoading) return panelLoading;
    input.releaseLock();
    panelLoading = import("../../ui/skyFlight").then(({ createSkyFlightHUD }) => {
      if (disposed) return;
      panel = createSkyFlightHUD({
        onFlightEnabledChange: (enabled) => {
          if (!enabled) player.skyFlight.suspend(player);
          player.skyFlight.enabled = enabled;
        },
        onTakeoff: () => {
          if (player.mode !== "walk" || player.riding) { core.hud.message("Step off your ride to fly", 2); return; }
          player.skyFlight.requestTakeoff();
          panel?.close();
        },
        onLand: () => { player.skyFlight.suspend(player); panel?.close(); },
        onGravityChange: (gravity) => {
          if (player.mode !== "walk" || player.riding) { core.hud.message("Gravity controls are for your character on foot", 2); return; }
          player.skyFlight.enabled = true;
          player.skyFlight.setGravity(gravity);
        },
        onCameraChange: (view) => core.setViewMode(view),
        onFindSkyGardens: () => { setTarget(); panel?.close(); },
        onTravelToIsland: (island) => travel(island.id as SkyIslandId),
        onPointerLockChange: (locked) => { if (!locked) input.releaseLock(); },
        onFocus: () => { core.hud.collapseHelp(); input.setSuspensionHold("sky-flight-panel", true); },
        onBlur: () => input.setSuspensionHold("sky-flight-panel", false)
      }, host);
      launch.removeEventListener("click", onLaunch);
      launch.remove();
      updateUI();
      panel.open();
    }).catch((error) => {
      console.warn("[sky-flight] controls could not load", error);
      core.hud.message("Flight controls couldn't load. Click to retry.", 3);
    }).finally(() => { panelLoading = null; });
    return panelLoading;
  }
  const onLaunch = () => { void open(); };
  launch.addEventListener("click", onLaunch);

  function updateUI() {
    const flight = player.skyFlight;
    const entries = SKY_ISLANDS.map((island) => ({
      ...island,
      distance: Math.max(0, player.position.distanceTo(island.center) - island.bodyRadius),
      discovered: visited.has(island.id)
    }));
    const next = entries.find((island) => island.id === target)
      ?? entries.find((island) => !island.discovered) ?? entries[0];
    const current = flight.currentIsland;
    panel?.update({
      enabled: flight.enabled && player.mode === "walk" && !player.riding,
      flying: player.personalFlying,
      altitude: player.position.y,
      gravity: flight.gravity,
      camera: chase.manualFirstPerson ? "first" : "third",
      gravityField: current?.label ?? (player.personalFlying ? "Open sky" : "Earth"),
      nearbyIsland: next,
      islands: entries,
      landed: player.personalFlying && flight.grounded,
      storyJournal: visited.size === SKY_ISLANDS.length ? SKY_ISLANDS[4].story.resolution : undefined
    });
    if (!panel) launch.textContent = player.personalFlying
      ? `✦ Flight & gravity · ${Math.round(player.position.y)} m`
      : "✦ Flight & gravity · Space to soar";
  }

  function update(dt: number) {
    if (disposed) return;
    const nearest = Math.min(...SKY_ISLANDS.map((island) => player.position.distanceTo(island.center)));
    if (player.position.y > 180 && nearest < 680 && performance.now() - loadFailedAt > 5000) {
      if (!islands && !loading) void ensureWorld().catch(() => {});
    }
    if (islands) {
      islands.update(player.position, ctx.state.elapsed);
      if (!ctx.worldArrival.active && (nearest > 1600 || player.position.y < 120)) {
        islands.dispose();
        islands = null;
      }
    }
    const fieldIsland = player.skyFlight.currentIsland;
    const current = player.personalFlying && player.skyFlight.grounded && fieldIsland &&
      Math.abs(player.position.distanceTo(fieldIsland.center) - fieldIsland.landingRadius - WALK_CAPSULE_HALF_EXTENT) < 0.3
      ? fieldIsland : null;
    if (current && player.speed < 15 && !visited.has(current.id)) {
      dwell = dwellId === current.id ? dwell + Math.min(dt, 0.1) : 0;
      dwellId = current.id;
      if (dwell >= 1.2) {
        visited.add(current.id);
        try { localStorage.setItem(JOURNAL_KEY, JSON.stringify([...visited])); } catch { /* Optional storage. */ }
        core.hud.message(`${current.story.title} · memory ${visited.size} / ${SKY_ISLANDS.length} saved in Flight & gravity`, 5);
        if (target === current.id) target = SKY_ISLANDS.find((island) => !visited.has(island.id))?.id ?? null;
        islands?.setAwakened(visited.size === SKY_ISLANDS.length);
      }
    } else { dwellId = null; dwell = 0; }
    signal.hidden = !target || player.mode !== "walk";
    if (target && !signal.hidden) {
      const island = getSkyIsland(target);
      projected.set(island.center.x, island.center.y + island.bodyRadius + 10, island.center.z).project(camera);
      const direction = projected.z > 1 ? "↶ Turn toward" : projected.x < -0.45 ? "←" : projected.x > 0.45 ? "→" : projected.y > 0.45 ? "↑ Rise toward" : projected.y < -0.45 ? "↓" : "◇";
      signal.textContent = `${direction} ${island.label} · ${Math.round(player.position.distanceTo(island.center))} m`;
    }
    uiTime += dt;
    if (uiTime > 0.12) { uiTime = 0; updateUI(); }
  }

  return {
    update, open, travel, setTarget, ensureWorld,
    debugSnapshot: () => ({ visited: [...visited], target, awakened: islands?.isAwakened() ?? false, islands: islands?.debugSnapshot() ?? [] }),
    dispose() {
      disposed = true;
      panel?.dispose();
      islands?.dispose();
      launch.remove(); signal.remove(); style.remove();
      input.setSuspensionHold("sky-flight-panel", false);
    }
  };
}
