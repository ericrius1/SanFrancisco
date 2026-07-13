import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three/webgpu";
import { createServer } from "vite";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

Object.defineProperty(globalThis, "localStorage", {
  value: new MemoryStorage(),
  configurable: true
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vite = await createServer({
  root,
  configFile: false,
  logLevel: "silent",
  server: { middlewareMode: true }
});
const [featureModule, perchModule, queryModule, snapshotModule, persistModule, sessionModule] = await Promise.all([
  vite.ssrLoadModule("/src/app/hmr/featureSlot.ts"),
  vite.ssrLoadModule("/src/gameplay/buskers/perchRock.ts"),
  vite.ssrLoadModule("/src/core/worldQueries.ts"),
  vite.ssrLoadModule("/src/app/hmr/devReloadSnapshot.ts"),
  vite.ssrLoadModule("/src/core/persist.ts"),
  vite.ssrLoadModule("/src/app/sessionPersistence.ts")
]);
const { FeatureSlot } = featureModule;
const { buildPerchRock } = perchModule;
const { ProxySet } = queryModule;
const { consumeDevReloadSnapshot, writeDevReloadSnapshot } = snapshotModule;
const { tunables } = persistModule;
const { createSessionPersistence } = sessionModule;

function featureSlotProbe() {
  const disposed = [];
  const make = (id, state = id) => ({ id, state, dispose: () => disposed.push(id) });
  let failures = 0;
  const slot = new FeatureSlot(make(1, 17), (feature) => feature.state, {
    onFailure: () => failures++
  });

  slot.queue((state) => make(2, state));
  slot.queue((state) => make(3, state));
  assert.equal(slot.current.id, 1, "replacement must wait for a frame-boundary flush");
  assert.equal(slot.status.pending, true);
  assert.equal(slot.flush(), "replaced");
  assert.equal(slot.current.id, 3, "rapid edits should coalesce to the newest factory");
  assert.equal(slot.current.state, 17, "plain feature state should cross the replacement");
  assert.deepEqual(disposed, [1]);
  assert.equal(slot.status.generation, 1);

  slot.queue(() => {
    throw new Error("synthetic edit failure");
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(slot.flush(), "failed");
  } finally {
    console.error = originalError;
  }
  assert.equal(slot.current.id, 3, "a broken edit must leave the running feature intact");
  assert.equal(slot.status.generation, 1);
  assert.equal(failures, 1);
  assert.deepEqual(disposed, [1]);

  slot.dispose();
  assert.deepEqual(disposed, [1, 3]);
}

function perchLifecycleProbe() {
  const calls = [];
  const physics = {
    world: {
      createBox() {
        calls.push("create");
        return 42;
      },
      setBodyTransform(handle) {
        assert.equal(handle, 42);
        calls.push("move");
      },
      destroyBody(handle) {
        assert.equal(handle, 42);
        calls.push("destroy");
      }
    },
    addQuerySolid(handle) {
      assert.equal(handle, 42);
      calls.push("addQuery");
    },
    removeQuerySolid(handle) {
      assert.equal(handle, 42);
      calls.push("removeQuery");
    }
  };

  const perch = buildPerchRock(physics);
  perch.setColliderTransform(1, 2, 3, 0.4);
  perch.dispose();
  perch.dispose();
  assert.deepEqual(calls, ["create", "move", "addQuery", "removeQuery", "destroy"]);
}

function proxyIdentityProbe() {
  const calls = [];
  let nextHandle = 1;
  const query = {
    addProxy(spec) {
      calls.push(["add", spec.object]);
      return nextHandle++;
    },
    moveProxy(handle) {
      calls.push(["move", handle]);
    },
    removeProxy(handle) {
      calls.push(["remove", handle]);
    }
  };
  const proxies = new ProxySet(query);
  const first = new THREE.Group();
  const second = new THREE.Group();
  const spec = (object) => ({ id: 7, kind: "prop", object, shape: { form: "sphere", radius: 1 } });

  proxies.begin();
  proxies.put("stable-key", spec(first), 0, 0, 0);
  proxies.end();
  proxies.begin();
  proxies.put("stable-key", spec(second), 0, 0, 0);
  proxies.end();

  assert.deepEqual(
    calls.map(([kind, value]) => [kind, typeof value === "number" ? value : value === first ? "first" : "second"]),
    [
      ["add", "first"],
      ["move", 1],
      ["remove", 1],
      ["add", "second"],
      ["move", 2]
    ],
    "same-shape proxies must refresh when their real Object3D changes"
  );
}

function tunablesIdentityProbe() {
  const globalGrass = tunables("__hmr-probe-grass", {
    density: { v: 1 },
    patchiness: { v: 0.5 }
  });
  const gardenGrass = tunables("__hmr-probe-grass", {
    spacing: { v: 1.65 },
    nearSpacing: { v: 0.48 }
  });
  assert.notStrictEqual(
    globalGrass.values,
    gardenGrass.values,
    "same-path groups with different schemas must stay independent"
  );
  assert.deepEqual(globalGrass.values, { density: 1, patchiness: 0.5 });
  assert.deepEqual(gardenGrass.values, { spacing: 1.65, nearSpacing: 0.48 });

  const hotGlobalGrass = tunables("__hmr-probe-grass", {
    patchiness: { v: 0.5 },
    density: { v: 1.2 }
  });
  assert.strictEqual(hotGlobalGrass.values, globalGrass.values, "same-schema HMR must preserve values identity");
  assert.equal(globalGrass.values.density, 1.2, "an untouched source default should update live");
  assert.deepEqual(gardenGrass.values, { spacing: 1.65, nearSpacing: 0.48 });
}

function sessionPersistenceProbe() {
  const listeners = new Map();
  const eventTarget = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) listeners.delete(type);
    }
  };
  const documentTarget = { ...eventTarget, visibilityState: "hidden" };
  Object.defineProperty(globalThis, "window", { value: eventTarget, configurable: true });
  Object.defineProperty(globalThis, "document", { value: documentTarget, configurable: true });
  localStorage.removeItem("sf-player");

  const player = {
    mode: "walk",
    position: { x: 1, y: 2, z: 3 },
    heading: 4
  };
  const persistence = createSessionPersistence(player);
  persistence.writeVisible();
  assert.equal(localStorage.getItem("sf-player"), null, "a hidden tab must not replace shared player state");
  documentTarget.visibilityState = "visible";
  persistence.writeVisible();
  assert.deepEqual(JSON.parse(localStorage.getItem("sf-player")), {
    mode: "walk",
    x: 1,
    y: 2,
    z: 3,
    heading: 4
  });
  persistence.dispose();
  assert.equal(listeners.size, 0, "session persistence must detach page lifecycle listeners");
}

function devSnapshotProbe() {
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "sessionStorage", { value: storage, configurable: true });
  Object.defineProperty(globalThis, "location", {
    value: { pathname: "/game" },
    configurable: true
  });
  const source = {
    started: true,
    name: "Foggy Otter",
    player: { mode: "board", x: 1, y: 2, z: 3, heading: 4 },
    camera: { yaw: 5, pitch: 0.2, zoom: 1.3 }
  };

  writeDevReloadSnapshot(source);
  const restored = consumeDevReloadSnapshot();
  assert.deepEqual(
    { started: restored?.started, name: restored?.name, player: restored?.player, camera: restored?.camera },
    source
  );
  assert.equal(consumeDevReloadSnapshot(), null, "snapshot must be single-use");

  writeDevReloadSnapshot(source);
  assert.equal(consumeDevReloadSnapshot(Date.now() + 60_001), null, "stale snapshot must be rejected");

  writeDevReloadSnapshot(source);
  const [key, raw] = [...storage.values.entries()][0];
  const bad = JSON.parse(raw);
  bad.player.x = Number.NaN;
  storage.setItem(key, JSON.stringify(bad));
  assert.equal(consumeDevReloadSnapshot(), null, "non-finite state must be rejected");
}

try {
  featureSlotProbe();
  perchLifecycleProbe();
  proxyIdentityProbe();
  tunablesIdentityProbe();
  sessionPersistenceProbe();
  devSnapshotProbe();
  console.log("[hmr-lifecycle] all probes passed");
} finally {
  await vite.close();
}
