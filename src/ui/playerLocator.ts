import * as THREE from "three/webgpu";
import type { PlayerMode } from "../player/types";

export type PlayerLocatorTarget = {
  id: number;
  name: string;
  hue: number;
  x: number;
  y: number;
  z: number;
  mode: PlayerMode;
};

type LocatorSlot = {
  key: number;
  target: PlayerLocatorTarget;
  distance: number;
};

type Marker = {
  root: HTMLDivElement;
  key: HTMLSpanElement;
  name: HTMLSpanElement;
  distance: HTMLSpanElement;
};

const MAX_SLOTS = 9;
const EDGE_PAD_X = 82;
const EDGE_PAD_Y = 48;

const MARKER_Y: Record<PlayerMode, number> = {
  walk: 2.7,
  drive: 2.9,
  plane: 3.3,
  boat: 8.4,
  drone: 2.2,
  board: 2.9,
  bird: 2.8,
  truck: 6.2
};

function distanceLabel(metres: number) {
  if (metres >= 9500) return `${(metres / 1000).toFixed(0)} km`;
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)} km`;
  return `${Math.max(1, Math.round(metres))} m`;
}

function finiteTarget(t: PlayerLocatorTarget) {
  return Number.isFinite(t.x) && Number.isFinite(t.y) && Number.isFinite(t.z);
}

export class PlayerLocator {
  #root: HTMLDivElement;
  #markers: Marker[] = [];
  #slots: LocatorSlot[] = [];
  #world = new THREE.Vector3();
  #screen = new THREE.Vector3();
  #toTarget = new THREE.Vector3();
  #cameraDir = new THREE.Vector3();

  constructor(parent = document.getElementById("hud")!) {
    this.#root = document.createElement("div");
    this.#root.className = "player-locator empty";
    parent.insertBefore(this.#root, parent.firstChild);
    for (let i = 0; i < MAX_SLOTS; i++) this.#markers.push(this.#makeMarker());
  }

  targetForDigit(digit: number): PlayerLocatorTarget | null {
    return this.#slots.find((slot) => slot.key === digit)?.target ?? null;
  }

  update(camera: THREE.Camera, local: THREE.Vector3, targets: PlayerLocatorTarget[]) {
    // fill the reused slot list in place (nearest first, capped), pooling the
    // slot objects across frames — this runs every frame, so no fresh arrays
    const slots = this.#slots;
    let n = 0;
    for (const target of targets) {
      if (!finiteTarget(target)) continue;
      const slot = slots[n] ?? (slots[n] = { key: 0, target, distance: 0 });
      slot.target = target;
      slot.distance = Math.hypot(target.x - local.x, target.y - local.y, target.z - local.z);
      n++;
    }
    slots.length = n;
    slots.sort((a, b) => a.distance - b.distance || a.target.id - b.target.id);
    if (slots.length > MAX_SLOTS) slots.length = MAX_SLOTS;
    for (let i = 0; i < slots.length; i++) slots[i].key = i + 1;

    this.#root.classList.toggle("empty", slots.length === 0);
    camera.updateMatrixWorld();
    camera.getWorldDirection(this.#cameraDir);

    const width = Math.max(1, window.innerWidth);
    const height = Math.max(1, window.innerHeight);
    const cx = width * 0.5;
    const cy = height * 0.5;
    const halfW = Math.max(1, cx - EDGE_PAD_X);
    const halfH = Math.max(1, cy - EDGE_PAD_Y);

    for (let i = 0; i < this.#markers.length; i++) {
      const marker = this.#markers[i];
      const slot = this.#slots[i];
      if (!slot) {
        marker.root.style.display = "none";
        continue;
      }

      const t = slot.target;
      this.#world.set(t.x, t.y + MARKER_Y[t.mode], t.z);
      this.#toTarget.copy(this.#world).sub(camera.position);
      const inFront = this.#toTarget.dot(this.#cameraDir) > 0;
      this.#screen.copy(this.#world).project(camera);
      if (!Number.isFinite(this.#screen.x) || !Number.isFinite(this.#screen.y) || !Number.isFinite(this.#screen.z)) {
        marker.root.style.display = "none";
        continue;
      }

      let ndcX = this.#screen.x;
      let ndcY = this.#screen.y;
      if (!inFront) {
        ndcX *= -1;
        ndcY *= -1;
      }

      let x = cx + ndcX * cx;
      let y = cy - ndcY * cy;
      const onScreen = inFront && this.#screen.z >= -1 && this.#screen.z <= 1 && Math.abs(ndcX) <= 0.96 && Math.abs(ndcY) <= 0.9;

      if (!onScreen) {
        let dx = x - cx;
        let dy = y - cy;
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001)) {
          dx = ndcX === 0 ? 1 : Math.sign(ndcX);
          dy = ndcY === 0 ? 0 : -Math.sign(ndcY);
        }
        const scale = Math.min(halfW / Math.max(1, Math.abs(dx)), halfH / Math.max(1, Math.abs(dy)));
        x = cx + dx * scale;
        y = cy + dy * scale;
      }

      const dist = distanceLabel(slot.distance);
      marker.root.style.display = "";
      marker.root.style.left = `${x}px`;
      marker.root.style.top = `${y}px`;
      marker.root.style.setProperty("--hue", String(t.hue));
      marker.root.style.setProperty("--angle", `${Math.atan2(y - cy, x - cx)}rad`);
      marker.root.classList.toggle("edge", !onScreen);
      marker.key.textContent = `⇧${slot.key}`;
      marker.name.textContent = t.name;
      marker.distance.textContent = dist;
      marker.root.title = `Shift+${slot.key}: ${t.name} - ${dist}`;
    }
  }

  #makeMarker(): Marker {
    const root = document.createElement("div");
    root.className = "player-locator-marker";

    const key = document.createElement("span");
    key.className = "pl-key";
    const body = document.createElement("span");
    body.className = "pl-body";
    const name = document.createElement("span");
    name.className = "pl-name";
    const distance = document.createElement("span");
    distance.className = "pl-distance";
    const arrow = document.createElement("span");
    arrow.className = "pl-arrow";

    body.append(name, distance);
    root.append(key, body, arrow);
    this.#root.appendChild(root);
    return { root, key, name, distance };
  }
}
