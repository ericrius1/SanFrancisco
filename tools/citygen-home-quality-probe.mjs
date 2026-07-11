// Focused acceptance probe for generated-home doors and interiors.
//
// Covers representative Victorian + SoMa doors through the real app:
//   - deterministic closed / mid-swing / open screenshots from one camera,
//   - dedicated closed backing + baked/dynamic leaf handoff,
//   - panel and hardware children on the live leaf,
//   - visible motion before the collider gap becomes passable,
//   - real KeyE wiring, closed collision, open walk-in / walk-out,
//   - occupied-gap close refusal and mid-close auto-reversal,
//   - a threshold-to-room interior view with a foreground-clearance check,
//   - renderer, scene, ring, and available physics counts.
//
// Usage:
//   node tools/citygen-home-quality-probe.mjs
//   SF_URL=http://127.0.0.1:5198 node tools/citygen-home-quality-probe.mjs
//
// Env:
//   SF_URL          existing dev/preview server (otherwise starts a fresh Vite dev)
//   SF_OUT          artifact directory (default .data/citygen-home-quality)
//   SF_SPOT_VIC     Victorian stream anchor, x,z (default 900,2400)
//   SF_SPOT_SOMA    SoMa stream anchor, x,z (default 1800,800)
//   CHROME_BIN      Chrome/Chromium executable
//   SF_W / SF_H     logical viewport (default 1600x1000)

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.resolve(ROOT, process.env.SF_OUT ?? ".data/citygen-home-quality");
const W = Number(process.env.SF_W ?? 1600);
const H = Number(process.env.SF_H ?? 1000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const parseSpot = (raw, fallback) => {
  const parts = String(raw ?? fallback).split(",").map(Number);
  if (parts.length !== 2 || parts.some((v) => !Number.isFinite(v))) throw new Error(`bad spot "${raw}"; expected x,z`);
  return parts;
};

const DISTRICTS = [
  { label: "victorian", archetype: "victorian", spot: parseSpot(process.env.SF_SPOT_VIC, "900,2400") },
  { label: "soma", archetype: "soma", spot: parseSpot(process.env.SF_SPOT_SOMA, "1800,800") },
];

async function isFile(p) {
  try { await access(p); return true; } catch { return false; }
}

async function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes("/") && !(await isFile(candidate))) continue;
    return candidate;
  }
  throw new Error("No Chrome found. Set CHROME_BIN.");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitHttp(url, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(url, { cache: "no-store" })).ok) return; } catch {}
    await sleep(300);
  }
  throw new Error(`HTTP timeout: ${url}`);
}

class Cdp {
  #ws;
  #id = 1;
  #pending = new Map();
  pageErrors = [];
  consoleErrors = [];
  networkErrors = [];

  constructor(wsUrl) { this.#ws = new WebSocket(wsUrl); }

  async open() {
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener("open", resolve, { once: true });
      this.#ws.addEventListener("error", reject, { once: true });
    });
    this.#ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data.toString());
      if (message.method === "Runtime.exceptionThrown") {
        const detail = message.params?.exceptionDetails;
        this.pageErrors.push((detail?.exception?.description || detail?.text || "page exception").split("\n")[0]);
      } else if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.consoleErrors.push(message.params.args.map((arg) => arg.value || arg.description || "").join(" ").slice(0, 500));
      } else if (message.method === "Network.loadingFailed" && !message.params?.canceled) {
        this.networkErrors.push(`${message.params?.errorText || "loading failed"}: ${message.params?.type || "unknown"}`);
      } else if (message.method === "Network.responseReceived" && message.params?.response?.status >= 400) {
        const response = message.params.response;
        this.networkErrors.push(`${response.status} ${response.url}`);
      }
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result ?? {});
    });
  }

  send(method, params = {}, timeoutMs = 30_000) {
    const id = this.#id++;
    this.#ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
    });
  }

  close() { this.#ws.close(); }
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Runtime.evaluate failed");
  }
  return response.result?.value;
}

async function waitEval(cdp, expression, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if (await evaluate(cdp, expression)) return; } catch {}
    await sleep(300);
  }
  throw new Error(`eval timeout: ${expression}`);
}

async function tick(cdp, dt = 1 / 60) {
  await evaluate(cdp, `window.__sf.tick(${dt})`);
}

async function tickN(cdp, count, dt = 1 / 60) {
  for (let i = 0; i < count; i++) await tick(cdp, dt);
}

async function renderOnly(cdp) {
  await evaluate(cdp, `(()=>{ window.__sf.pipeline.render(); return true; })()`);
  await sleep(140);
}

async function screenshot(cdp, name) {
  const response = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 94, fromSurface: true });
  const bytes = Buffer.from(response.data, "base64");
  const file = path.join(OUT, name);
  await writeFile(file, bytes);
  const stats = await sharp(bytes).stats();
  const metadata = await sharp(bytes).metadata();
  const evidence = {
    file,
    width: metadata.width,
    height: metadata.height,
    entropy: Number(stats.entropy.toFixed(3)),
    sharpness: Number(stats.sharpness.toFixed(3)),
    means: stats.channels.slice(0, 3).map((channel) => Number(channel.mean.toFixed(1))),
  };
  console.log(`  saved ${path.relative(ROOT, file)} (entropy ${evidence.entropy})`);
  return evidence;
}

const HMR_BLOCK_SRC = `
(() => {
  const NativeWebSocket = window.WebSocket;
  const isHmr = (protocols) => protocols === "vite-hmr" || (Array.isArray(protocols) && protocols.includes("vite-hmr"));
  const QuietWebSocket = function (url, protocols) {
    if (isHmr(protocols)) return { addEventListener(){}, removeEventListener(){}, send(){}, close(){}, readyState: 3, binaryType: "blob" };
    return new NativeWebSocket(url, protocols);
  };
  QuietWebSocket.prototype = NativeWebSocket.prototype;
  QuietWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
  QuietWebSocket.OPEN = NativeWebSocket.OPEN;
  QuietWebSocket.CLOSING = NativeWebSocket.CLOSING;
  QuietWebSocket.CLOSED = NativeWebSocket.CLOSED;
  window.WebSocket = QuietWebSocket;
})();`;

// In-page helpers intentionally use only public `window.__sf` diagnostics and
// stable citygen object names. They do not reach into private ring state.
const HELPERS_SRC = `
(() => {
  const S = () => window.__sf;
  const effectiveVisible = (object) => {
    for (let o = object; o; o = o.parent) if (!o.visible) return false;
    return true;
  };
  const worldCenter = (object) => {
    if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
    return object.localToWorld(object.geometry.boundingSphere.center.clone());
  };
  const nearestNamed = (name, door) => {
    const s = S();
    s.scene.updateMatrixWorld(true);
    let found = null, distance = Infinity;
    s.scene.traverse((object) => {
      if (!object.isMesh || object.name !== name) return;
      const center = worldCenter(object);
      const d = Math.hypot(center.x - door.center[0], center.z - door.center[2]);
      if (d < distance) { distance = d; found = object; }
    });
    return {
      found: !!found && distance < 3,
      visible: !!found && distance < 3 && effectiveVisible(found),
      distance: Number((distance < Infinity ? distance : -1).toFixed(3)),
      parent: found?.parent?.name || null,
    };
  };
  const rayBox = (px, pz, dx, dz, y, box, maxDistance) => {
    if (box.quat || Math.abs(y - box.y) > box.hy) return false;
    const c = Math.cos(-box.yaw), sn = Math.sin(-box.yaw);
    const ox = px - box.x, oz = pz - box.z;
    const lx = ox * c - oz * sn, lz = ox * sn + oz * c;
    const ldx = dx * c - dz * sn, ldz = dx * sn + dz * c;
    let tmin = 0, tmax = maxDistance;
    for (const [origin, delta, half] of [[lx, ldx, box.hx], [lz, ldz, box.hz]]) {
      if (Math.abs(delta) < 1e-9) { if (origin < -half || origin > half) return false; }
      else {
        let a = (-half - origin) / delta, b = (half - origin) / delta;
        if (a > b) [a, b] = [b, a];
        if (a > tmin) tmin = a;
        if (b < tmax) tmax = b;
        if (tmin > tmax) return false;
      }
    }
    return true;
  };
  const gapState = (door) => {
    const ring = S().citygenRing.current;
    const walls = [];
    ring.debugColliders(walls, []);
    const near = walls.filter((b) => b.x > door.bb.minx - 1.5 && b.x < door.bb.maxx + 1.5 && b.z > door.bb.minz - 1.5 && b.z < door.bb.maxz + 1.5);
    const offsets = [0, door.halfW * 0.5, -door.halfW * 0.5];
    const y = door.sill + Math.min(0.9, (door.openTop - door.sill) * 0.5);
    const crossers = [];
    for (const offset of offsets) {
      const ox = door.center[0] + door.along[0] * offset - door.inward[0] * 1.2;
      const oz = door.center[2] + door.along[2] * offset - door.inward[2] * 1.2;
      for (const box of near) if (rayBox(ox, oz, door.inward[0], door.inward[2], y, box, 2.0) && !crossers.includes(box)) crossers.push(box);
    }
    const midY = (door.base + door.top) / 2;
    const halfH = Math.max(0.1, (door.top - door.base) / 2);
    const ownWall = (box) => !box.quat && Math.abs(box.y - midY) < 0.05 && Math.abs(box.hy - halfH) < 0.05 && box.hz <= 0.4;
    return {
      solid: offsets.every((offset) => {
        const ox = door.center[0] + door.along[0] * offset - door.inward[0] * 1.2;
        const oz = door.center[2] + door.along[2] * offset - door.inward[2] * 1.2;
        return near.some((box) => rayBox(ox, oz, door.inward[0], door.inward[2], y, box, 2.0));
      }),
      clear: offsets.every((offset) => {
        const ox = door.center[0] + door.along[0] * offset - door.inward[0] * 1.2;
        const oz = door.center[2] + door.along[2] * offset - door.inward[2] * 1.2;
        return !near.some((box) => rayBox(ox, oz, door.inward[0], door.inward[2], y, box, 2.0));
      }),
      own: crossers.some(ownWall),
      foreign: crossers.some((box) => !ownWall(box)),
      crossers: crossers.length,
    };
  };
  const frontClear = (door) => {
    const walls = [];
    S().citygenRing.current.debugColliders(walls, []);
    const nearby = walls.filter((b) => Math.abs(b.x - door.center[0]) < 12 && Math.abs(b.z - door.center[2]) < 12);
    const inBox = (px, py, pz, box) => {
      if (box.quat || Math.abs(py - box.y) > box.hy) return false;
      const c = Math.cos(-box.yaw), sn = Math.sin(-box.yaw);
      const ox = px - box.x, oz = pz - box.z;
      const lx = ox * c - oz * sn, lz = ox * sn + oz * c;
      return Math.abs(lx) <= box.hx + 0.34 && Math.abs(lz) <= box.hz + 0.34;
    };
    for (const t of [0.7, 1.1, 1.5, 2.4, 3.2]) {
      const x = door.center[0] - door.inward[0] * t;
      const z = door.center[2] - door.inward[2] * t;
      for (const y of [door.sill + 0.35, door.sill + 0.9, door.sill + 1.55]) {
        if (nearby.some((box) => inBox(x, y, z, box))) return false;
      }
    }
    return true;
  };
  const doorByPosition = (door) => S().citygenRing.current.debugDoors().find((candidate) =>
    Math.hypot(candidate.center[0] - door.center[0], candidate.center[2] - door.center[2]) < 0.05) || null;

  window.__homeDoorState = (door, id) => {
    const s = S();
    const live = doorByPosition(door);
    const backing = nearestNamed("citygen.doorback", door);
    const bakedLeaf = nearestNamed("citygen.doorleaf", door);
    const pivot = s.scene.getObjectByName("cityGenDoor." + id);
    const childNames = pivot ? pivot.children.map((child) => child.name).sort() : [];
    return {
      phase: live?.phase ?? null,
      swing: Number((live?.swing ?? 0).toFixed(5)),
      passable: live?.passable ?? null,
      open: live?.open ?? null,
      dynamicLeaf: live?.dynamicLeaf ?? false,
      backing,
      bakedLeaf,
      gap: gapState(door),
      pivot: {
        found: !!pivot,
        name: pivot?.name ?? null,
        rotationY: pivot ? Number(pivot.rotation.y.toFixed(5)) : null,
        userSwing: pivot ? Number((pivot.userData.swing ?? -1).toFixed(5)) : null,
        childNames,
        panelCount: childNames.filter((name) => name.startsWith("citygen.door.panel.")).length,
        hardwareCount: childNames.filter((name) => name.startsWith("citygen.door.hardware.")).length,
      },
    };
  };

  window.__homePick = ({ near, archetype }) => {
    const s = S(), ring = s.citygenRing.current;
    const candidates = ring.debugDoors().filter((door) => {
      if (door.archetype !== archetype || door.phase !== "closed" || door.passable) return false;
      if (door.openTop - door.sill < 1.8) return false;
      if (Math.max(door.dcenter, door.length - door.dcenter) <= door.halfW + 2.35) return false;
      const fx = door.center[0] - door.inward[0] * 1.5;
      const fz = door.center[2] - door.inward[2] * 1.5;
      const rise = door.sill - s.map.groundHeight(fx, fz);
      return rise >= -0.6 && rise <= 2.4 && frontClear(door);
    });
    candidates.sort((a, b) => {
      const ad = (a.center[0] - near[0]) ** 2 + (a.center[2] - near[1]) ** 2;
      const bd = (b.center[0] - near[0]) ** 2 + (b.center[2] - near[1]) ** 2;
      return ad - bd;
    });
    let best = null;
    for (const door of candidates.slice(0, 30)) {
      const nearest = ring.nearestDoor({ x: door.center[0], y: door.sill + 1, z: door.center[2] });
      const operable = !!nearest && !nearest.open && Math.hypot(nearest.x - door.center[0], nearest.z - door.center[2]) < 0.05;
      const state = operable ? window.__homeDoorState(door, nearest.id) : null;
      const gap = gapState(door);
      const fx = door.center[0] - door.inward[0] * 1.5;
      const fz = door.center[2] - door.inward[2] * 1.5;
      const record = {
        ok: true,
        ready: !!(operable && gap.own && !gap.foreign && gap.solid && state?.backing.found && state.backing.visible && state?.bakedLeaf.found && state.bakedLeaf.visible),
        id: nearest?.id ?? -1,
        rise: Number((door.sill - s.map.groundHeight(fx, fz)).toFixed(2)),
        state,
        door,
      };
      if (!best) best = record;
      if (record.ready) return record;
    }
    return best ?? { ok: false, ready: false, error: candidates.length ? "no fully observable door" : "no candidate doors" };
  };

  window.__homeFrameExterior = (door) => {
    const s = S();
    for (const mesh of Object.values(s.player.meshes || {})) mesh.visible = false;
    s.chase.update = () => {};
    const eye = [
      door.center[0] - door.inward[0] * 5.8 + door.along[0] * 2.35,
      door.sill + 2.35,
      door.center[2] - door.inward[2] * 5.8 + door.along[2] * 2.35,
    ];
    s.camera.position.set(eye[0], eye[1], eye[2]);
    s.camera.lookAt(door.center[0], door.sill + 1.2, door.center[2]);
    s.camera.updateMatrixWorld(true);
    return { eye, target: [door.center[0], door.sill + 1.2, door.center[2]] };
  };

  const pointInBox = (x, y, z, box, pad = 0) => {
    if (box.quat || Math.abs(y - box.y) > box.hy + 0.05) return false;
    const c = Math.cos(-box.yaw), sn = Math.sin(-box.yaw);
    const ox = x - box.x, oz = z - box.z;
    const lx = ox * c - oz * sn, lz = ox * sn + oz * c;
    return Math.abs(lx) <= box.hx + pad && Math.abs(lz) <= box.hz + pad;
  };

  window.__homeFrameInterior = (door) => {
    const s = S(), walls = [], interiors = [];
    s.citygenRing.current.debugColliders(walls, interiors);
    const local = interiors.filter((box) => box.x > door.bb.minx - 1 && box.x < door.bb.maxx + 1 && box.z > door.bb.minz - 1 && box.z < door.bb.maxz + 1);
    const transform = s.physics.world.getBodyTransform(s.player.body);
    const p = transform.position;
    const eye = [p[0], p[1] + 0.68, p[2]];
    const target = [p[0] + door.inward[0] * 4.2, p[1] + 0.2, p[2] + door.inward[2] * 4.2];
    const blockers = [];
    for (const depth of [0.5, 1, 1.5, 2, 2.5, 3, 3.5]) {
      const x = p[0] + door.inward[0] * depth;
      const z = p[2] + door.inward[2] * depth;
      for (let i = 0; i < local.length; i++) {
        const box = local[i];
        if (pointInBox(x, p[1], z, box, 0.34) && !blockers.includes(i)) blockers.push(i);
      }
    }
    let bounds = null;
    if (local.length) {
      let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
      for (const box of local) {
        const r = Math.hypot(box.hx, box.hz);
        minx = Math.min(minx, box.x - r); maxx = Math.max(maxx, box.x + r);
        minz = Math.min(minz, box.z - r); maxz = Math.max(maxz, box.z + r);
      }
      bounds = { minx, maxx, minz, maxz };
    }
    for (const mesh of Object.values(s.player.meshes || {})) mesh.visible = false;
    s.camera.position.set(eye[0], eye[1], eye[2]);
    s.camera.lookAt(target[0], target[1], target[2]);
    s.camera.updateMatrixWorld(true);
    return { eye, target, interiorBoxes: local.length, forwardBlockers: blockers.length, bounds };
  };

  window.__homeDiagnostics = () => {
    const s = S(), walls = [], interiors = [], baked = [];
    s.citygenRing.current.debugColliders(walls, interiors);
    try { s.physics.debugBuildingBodies(baked); } catch {}
    let objects = 0, visibleMeshes = 0;
    const geometries = new Set(), materials = new Set();
    s.scene.traverse((object) => {
      objects++;
      if (!object.isMesh || !effectiveVisible(object)) return;
      visibleMeshes++;
      if (object.geometry) geometries.add(object.geometry.uuid);
      const list = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of list) if (material) materials.add(material.uuid);
    });
    const render = s.renderer.info?.render || {};
    const memory = s.renderer.info?.memory || {};
    const canvas = s.renderer.domElement;
    let worlds = null;
    try { worlds = s.physics.box3d.getWorldCount(); } catch {}
    return {
      ring: s.citygenRing.current.stats(),
      renderer: {
        calls: render.calls ?? render.drawCalls ?? null,
        triangles: render.triangles ?? null,
        points: render.points ?? null,
        lines: render.lines ?? null,
        memoryGeometries: memory.geometries ?? null,
        memoryTextures: memory.textures ?? null,
        cssWidth: canvas.clientWidth,
        cssHeight: canvas.clientHeight,
        bufferWidth: canvas.width,
        bufferHeight: canvas.height,
        dpr: window.devicePixelRatio,
      },
      scene: { objects, visibleMeshes, uniqueGeometries: geometries.size, uniqueMaterials: materials.size },
      physics: { worlds, bakedBuildingBoxes: baked.length, citygenWallBoxes: walls.length, interiorBoxes: interiors.length },
    };
  };
})();`;

const doorJson = (door) => JSON.stringify(door);

async function stateOf(cdp, door, id) {
  return evaluate(cdp, `window.__homeDoorState(${doorJson(door)}, ${id})`);
}

async function placePlayer(cdp, xyz, settleTicks = 2) {
  await evaluate(cdp, `(()=>{
    const s=window.__sf, p=${JSON.stringify(xyz)};
    s.input.keys.delete("KeyW");
    s.physics.world.setBodyTransform(s.player.body,p,[0,0,0,1]);
    s.physics.world.setBodyVelocity(s.player.body,[0,0,0],[0,0,0]);
    s.player.position.set(p[0],p[1],p[2]);
    s.player.renderPosition.copy(s.player.position);
    return true;
  })()`);
  await tickN(cdp, settleTicks);
}

async function startFor(cdp, door) {
  const rise = door._rise ?? 0;
  const distance = rise > 0.25 ? 0.3 + rise / Math.tan(0.56) + 0.8 : 2.6;
  return evaluate(cdp, `(()=>{
    const s=window.__sf,d=${doorJson(door)},dist=${distance};
    const x=d.center[0]-d.inward[0]*dist, z=d.center[2]-d.inward[2]*dist;
    return [x,s.map.groundHeight(x,z)+1,z];
  })()`);
}

// Real walk controller path: KeyW + chase yaw drive the capsule exactly as a player does.
async function walkDrive(cdp, start, door, targetDepth, maxTicks = 480) {
  const payload = JSON.stringify({ start, center: door.center, inward: door.inward, targetDepth });
  const aim = `
    const gx=o.center[0]+o.inward[0]*(o.targetDepth>0?4:-4), gz=o.center[2]+o.inward[2]*(o.targetDepth>0?4:-4);
    const body=s.physics.world.getBodyTransform(s.player.body).position;
    const dx=gx-body[0], dz=gz-body[2], len=Math.hypot(dx,dz)||1;
    s.chase.yaw=Math.atan2(-dx/len,-dz/len);`;
  await evaluate(cdp, `(()=>{
    const s=window.__sf,o=${payload};
    s.chase.update=()=>{}; s.input.suspended=false; s.input.keys.add("KeyW");
    s.physics.world.setBodyTransform(s.player.body,o.start,[0,0,0,1]);
    s.physics.world.setBodyVelocity(s.player.body,[0,0,0],[0,0,0]);
    s.player.position.set(o.start[0],o.start[1],o.start[2]); s.player.renderPosition.copy(s.player.position);
    ${aim}
    window.__homeReached=false; return true;
  })()`);
  for (let i = 0; i < maxTicks; i++) {
    const reached = await evaluate(cdp, `(()=>{
      const s=window.__sf,o=${payload}; ${aim}
      const depth=(body[0]-o.center[0])*o.inward[0]+(body[2]-o.center[2])*o.inward[2];
      if(o.targetDepth>0?depth>=o.targetDepth:depth<=o.targetDepth){window.__homeReached=true;return true;} return false;
    })()`);
    await tick(cdp);
    if (reached) { await tick(cdp); break; }
  }
  return evaluate(cdp, `(()=>{
    const s=window.__sf,o=${payload}; s.input.keys.delete("KeyW");
    const p=s.physics.world.getBodyTransform(s.player.body).position;
    const depth=(p[0]-o.center[0])*o.inward[0]+(p[2]-o.center[2])*o.inward[2];
    return {reached:window.__homeReached,depth:Number(depth.toFixed(2)),inside:s.citygenRing.current.isPlayerInside(),
      interiors:s.citygenRing.current.stats().interiors,pos:p.map((v)=>Number(v.toFixed(2)))};
  })()`);
}

async function pressE(cdp, dt = 0.01) {
  await evaluate(cdp, `(window.dispatchEvent(new KeyboardEvent("keydown",{code:"KeyE"})),true)`);
  await tick(cdp, dt);
  await evaluate(cdp, `(window.dispatchEvent(new KeyboardEvent("keyup",{code:"KeyE"})),true)`);
  await tick(cdp, 0.001);
}

async function placeAtDoor(cdp, door, signedDepth) {
  const point = await evaluate(cdp, `(()=>{
    const s=window.__sf,d=${doorJson(door)},depth=${signedDepth};
    const x=d.center[0]+d.inward[0]*depth,z=d.center[2]+d.inward[2]*depth;
    const y=Math.max(s.map.groundHeight(x,z)+1,d.sill+0.8);
    return [x,y,z];
  })()`);
  await placePlayer(cdp, point);
  return point;
}

async function findReadyDoor(cdp, district) {
  const [x, z] = district.spot;
  await evaluate(cdp, `(()=>{
    const s=window.__sf,p=s.player,y=s.map.groundHeight(${x},${z})+2;
    p.position.set(${x},y,${z}); p.renderPosition.copy(p.position);
    s.physics.world.setBodyTransform(p.body,[${x},y,${z}],[0,0,0,1]);
    s.physics.world.setBodyVelocity(p.body,[0,0,0],[0,0,0]); return true;
  })()`);
  // Real wall-clock yields are intentional: the detail worker cannot complete
  // while a probe spins through synchronous manual ticks.
  let pick = null;
  for (let attempt = 0; attempt < 36; attempt++) {
    await tickN(cdp, 20);
    await sleep(350);
    pick = await evaluate(cdp, `window.__homePick({near:[${x},${z}],archetype:${JSON.stringify(district.archetype)}})`);
    if (pick?.ready) return pick;
  }
  throw new Error(`${district.label}: no ready ${district.archetype} door (${JSON.stringify(pick)})`);
}

function addCheck(checks, name, pass, details = undefined) {
  const record = { name, pass: !!pass };
  if (details !== undefined) record.details = details;
  checks.push(record);
  console.log(`  ${record.pass ? "PASS" : "FAIL"}  ${name}${details === undefined ? "" : ` — ${typeof details === "string" ? details : JSON.stringify(details)}`}`);
  return record.pass;
}

async function waitForState(cdp, door, id, predicate, { frames = 90, dt = 0.015 } = {}) {
  let state = await stateOf(cdp, door, id);
  for (let i = 0; i < frames && !predicate(state); i++) {
    await tick(cdp, dt);
    state = await stateOf(cdp, door, id);
  }
  return state;
}

async function verifyDistrict(cdp, district) {
  console.log(`\n[${district.label}] stream anchor ${district.spot.join(",")}`);
  const checks = [];
  const screenshots = [];
  const pick = await findReadyDoor(cdp, district);
  const door = { ...pick.door, _rise: pick.rise };
  const id = pick.id;
  const descriptor = {
    id,
    archetype: door.archetype,
    center: door.center,
    rise: pick.rise,
    openingHeight: Number((door.openTop - door.sill).toFixed(2)),
    buildingHeight: Number((door.top - door.base).toFixed(1)),
  };
  console.log(`  target ${JSON.stringify(descriptor)}`);

  const closed = await stateOf(cdp, door, id);
  addCheck(checks, "closed phase starts non-passable", closed.phase === "closed" && !closed.passable && closed.swing === 0, closed);
  addCheck(checks, "dedicated citygen.doorback is visible while closed", closed.backing.found && closed.backing.visible, closed.backing);
  addCheck(checks, "baked citygen.doorleaf is visible while closed", closed.bakedLeaf.found && closed.bakedLeaf.visible, closed.bakedLeaf);
  addCheck(checks, "closed doorway collider is solid", closed.gap.solid && !closed.gap.clear, closed.gap);
  const exteriorFrame = await evaluate(cdp, `window.__homeFrameExterior(${doorJson(door)})`);
  await renderOnly(cdp);
  screenshots.push(await screenshot(cdp, `${district.label}-door-closed.jpg`));

  const blockedWalk = await walkDrive(cdp, await startFor(cdp, door), door, 0.8, 180);
  addCheck(checks, "real walk is blocked by the closed door", !blockedWalk.reached && blockedWalk.depth <= -0.15, blockedWalk);

  await placeAtDoor(cdp, door, -1.5);
  const nearestBeforeKey = await evaluate(cdp, `(()=>{const d=${doorJson(door)},n=window.__sf.citygenRing.current.nearestDoor(window.__sf.player.position);return n?{id:n.id,dist:n.dist,same:Math.hypot(n.x-d.center[0],n.z-d.center[2])<0.05}:null;})()`);
  await pressE(cdp, 0.01);
  const early = await stateOf(cdp, door, id);
  addCheck(checks, "real KeyE selects and opens this door", nearestBeforeKey?.id === id && nearestBeforeKey.same && early.phase === "opening", { nearestBeforeKey, early });
  addCheck(checks, "visible swing begins before passability", early.swing > 0.02 && !early.passable && early.gap.solid, early);
  addCheck(checks, "closed backing and baked leaf hide on live-leaf handoff", !early.backing.visible && !early.bakedLeaf.visible, { backing: early.backing, bakedLeaf: early.bakedLeaf });
  const expectedParts = [
    "citygen.doorleaf.dynamic",
    "citygen.door.panel.upper",
    "citygen.door.panel.lower",
    "citygen.door.hardware.plate",
    "citygen.door.hardware.outer",
    "citygen.door.hardware.inner",
  ];
  addCheck(checks, "dynamic leaf has slab, panels, and hardware", early.pivot.found && expectedParts.every((name) => early.pivot.childNames.includes(name)) && early.pivot.panelCount >= 2 && early.pivot.hardwareCount >= 3, early.pivot);

  let beforePassable = early;
  let firstPassable = early;
  for (let i = 0; i < 80 && !firstPassable.passable; i++) {
    beforePassable = firstPassable;
    await tick(cdp, 0.01);
    firstPassable = await stateOf(cdp, door, id);
  }
  addCheck(checks, "collider gap activates only after a visibly ajar swing", !beforePassable.passable && beforePassable.swing > 0 && firstPassable.passable && firstPassable.swing >= 0.45 && firstPassable.gap.clear, { beforePassable, firstPassable });

  const mid = await waitForState(cdp, door, id, (state) => state.phase === "opening" && state.swing >= 0.9, { frames: 80, dt: 0.012 });
  addCheck(checks, "mid-swing angle differs from closed and full-open", mid.swing >= 0.9 && mid.swing < 1.72 && Math.abs(mid.pivot.userSwing - mid.swing) < 0.02, mid);
  await evaluate(cdp, `window.__homeFrameExterior(${doorJson(door)})`);
  await renderOnly(cdp);
  screenshots.push(await screenshot(cdp, `${district.label}-door-mid.jpg`));

  const opened = await waitForState(cdp, door, id, (state) => state.phase === "open", { frames: 100, dt: 0.02 });
  addCheck(checks, "fully open door is passable at about 100 degrees", opened.phase === "open" && opened.passable && opened.swing > 1.68 && opened.gap.clear, opened);
  addCheck(checks, "doorback and baked leaf stay hidden while open", !opened.backing.visible && !opened.bakedLeaf.visible, { backing: opened.backing, bakedLeaf: opened.bakedLeaf });
  await evaluate(cdp, `window.__homeFrameExterior(${doorJson(door)})`);
  await renderOnly(cdp);
  screenshots.push(await screenshot(cdp, `${district.label}-door-open.jpg`));

  const walkIn = await walkDrive(cdp, await startFor(cdp, door), door, 2.2, 520);
  addCheck(checks, "real walk enters through the open door", walkIn.reached && walkIn.depth >= 2.2 && walkIn.inside && walkIn.interiors >= 1, walkIn);
  await tickN(cdp, 10);
  const interiorFrame = await evaluate(cdp, `window.__homeFrameInterior(${doorJson(door)})`);
  addCheck(checks, "interior foreground corridor is clear for 3.5 m", interiorFrame.interiorBoxes > 0 && interiorFrame.forwardBlockers === 0, interiorFrame);
  await renderOnly(cdp);
  screenshots.push(await screenshot(cdp, `${district.label}-interior.jpg`));
  const diagnostics = await evaluate(cdp, `window.__homeDiagnostics()`);
  console.log(`  diagnostics ${JSON.stringify(diagnostics)}`);

  const walkOut = await walkDrive(cdp, walkIn.pos, door, -1.4, 520);
  addCheck(checks, "real walk exits through the open door", walkOut.reached && walkOut.depth <= -1.4 && !walkOut.inside, walkOut);

  // An OPEN door must refuse a close while the player occupies its aperture.
  await placeAtDoor(cdp, door, 0);
  const beforeBlockedClose = await stateOf(cdp, door, id);
  await pressE(cdp, 0.01);
  const blockedClose = await stateOf(cdp, door, id);
  addCheck(checks, "close stays safe while player occupies the gap", beforeBlockedClose.phase === "open" && blockedClose.phase === "open" && blockedClose.passable && Math.abs(blockedClose.swing - beforeBlockedClose.swing) < 0.02, { beforeBlockedClose, blockedClose });

  // Start a close from clear ground, then enter the aperture: update() should
  // reverse the visual immediately and leave the gapped collider live.
  await placeAtDoor(cdp, door, -2.2);
  await pressE(cdp, 0.04);
  const closing = await stateOf(cdp, door, id);
  await placeAtDoor(cdp, door, 0, 0);
  await tick(cdp, 0.02);
  const reversed = await stateOf(cdp, door, id);
  addCheck(checks, "mid-close reverses open when player enters the gap", closing.phase === "closing" && closing.passable && (reversed.phase === "opening" || reversed.phase === "open") && reversed.passable, { closing, reversed });

  await placeAtDoor(cdp, door, -2.2);
  await waitForState(cdp, door, id, (state) => state.phase === "open", { frames: 120, dt: 0.02 });
  await pressE(cdp, 0.02);
  const reclosed = await waitForState(cdp, door, id, (state) => state.phase === "closed", { frames: 140, dt: 0.02 });
  addCheck(checks, "settled close restores backing, baked leaf, and solid collider", reclosed.phase === "closed" && !reclosed.passable && !reclosed.pivot.found && reclosed.backing.visible && reclosed.bakedLeaf.visible && reclosed.gap.solid, reclosed);

  return {
    label: district.label,
    ok: checks.every((check) => check.pass),
    descriptor,
    exteriorFrame,
    interiorFrame,
    diagnostics,
    states: { closed, early, firstPassable, mid, opened, blockedClose, closing, reversed, reclosed },
    walks: { blockedWalk, walkIn, walkOut },
    checks,
    screenshots,
  };
}

function targetUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.searchParams.set("autostart", "1");
  url.searchParams.set("fullfps", "1");
  url.searchParams.set("profile", "1");
  return url.toString();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let baseUrl = process.env.SF_URL || null;
  let dev = null;
  if (!baseUrl) {
    const vitePort = await freePort();
    const relayPort = await freePort();
    baseUrl = `http://127.0.0.1:${vitePort}/`;
    dev = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(vitePort), "--strictPort"], {
      cwd: ROOT,
      env: { ...process.env, SF_RELAY_PORT: String(relayPort) },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
  }

  const url = targetUrl(baseUrl);
  const chromePath = await findChrome();
  const debugPort = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "sf-home-quality-chrome-"));
  let chrome = null;
  let cdp = null;
  let failed = false;
  try {
    await waitHttp(baseUrl, 120_000);
    chrome = spawn(chromePath, [
      `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${profile}`,
      "--headless=new",
      "--no-first-run",
      "--mute-audio",
      "--enable-features=SharedArrayBuffer,WebGPUDeveloperFeatures",
      "--use-angle=metal",
      "--enable-unsafe-webgpu",
      "--enable-gpu",
      `--window-size=${W},${H}`,
      "--force-device-scale-factor=1",
      "about:blank",
    ], { stdio: "ignore" });

    let version = null;
    for (let i = 0; i < 80 && !version; i++) {
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json(); } catch { await sleep(200); }
    }
    if (!version) throw new Error("Chrome debugging endpoint did not start");
    const page = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })).json();
    cdp = new Cdp(page.webSocketDebuggerUrl);
    await cdp.open();
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: HMR_BLOCK_SRC });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url });
    await waitEval(cdp, "Boolean(window.__sf?.player && window.__sf?.citygenRing?.current && window.__sf?.renderer && window.__sf?.pipeline)", 180_000);
    await evaluate(cdp, `(()=>{
      window.__sfManual?.(true);
      const s=window.__sf;
      s.sky.cycleEnabled=false; s.sky.setTimeOfDay(11);
      s.input.suspended=false;
      if(s.player.mode!=="walk") try{s.player.trySwitch("walk");}catch{}
      s.chase.update=()=>{};
      return {mode:s.player.mode,renderer:s.renderer.constructor.name};
    })()`);
    await evaluate(cdp, HELPERS_SRC);
    console.log(`[probe] ready ${url}`);

    const results = [];
    for (const district of DISTRICTS) {
      try { results.push(await verifyDistrict(cdp, district)); }
      catch (error) {
        console.error(`[${district.label}] ERROR`, error);
        results.push({ label: district.label, ok: false, error: String(error?.stack || error) });
      }
    }
    const report = {
      generatedAt: new Date().toISOString(),
      url,
      viewport: { width: W, height: H, dpr: 1 },
      results,
      pageErrors: cdp.pageErrors,
      consoleErrors: cdp.consoleErrors,
      networkErrors: [...new Set(cdp.networkErrors)],
    };
    report.ok = results.every((result) => result.ok) && !report.pageErrors.length && !report.consoleErrors.length;
    const reportPath = path.join(OUT, "report.json");
    await writeFile(reportPath, JSON.stringify(report, null, 2));
    console.log(`\n[probe] page errors: ${report.pageErrors.length ? JSON.stringify(report.pageErrors) : "none"}`);
    console.log(`[probe] console errors: ${report.consoleErrors.length ? JSON.stringify(report.consoleErrors) : "none"}`);
    console.log(`[probe] network errors: ${report.networkErrors.length ? JSON.stringify(report.networkErrors.slice(0, 8)) : "none"}`);
    console.log(`[probe] report: ${reportPath}`);
    console.log(`${report.ok ? "ALL PASS" : "SOME FAILED"} — ${results.map((result) => `${result.label}:${result.ok ? "ok" : "FAIL"}`).join("  ")}`);
    failed = !report.ok;
  } finally {
    try { cdp?.close(); } catch {}
    chrome?.kill("SIGTERM");
    if (dev) {
      try { process.kill(-dev.pid, "SIGTERM"); } catch { dev.kill("SIGTERM"); }
    }
    await sleep(200);
    await rm(profile, { recursive: true, force: true });
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error("[probe] FAIL", error);
  process.exitCode = 1;
});
