import * as THREE from "three/webgpu";
import { BodyType, type Physics } from "../../core/physics";

/**
 * The buskers' perch: a small weathered-wood viewing deck. Free-standing —
 * four posts sink 1.4 m below the group origin so it sits convincingly on
 * any slope we later move it to. The trio sits along the -Z (front) edge,
 * legs dangling over it.
 */

export const PLATFORM = {
  width: 3.4, // X
  depth: 1.9, // Z
  top: 0.62 // deck surface height above the group origin (ground point)
} as const;

const PLANKS = 8;
const POST_DROP = 1.4; // how far the legs continue below the origin

export type BuskerPlatform = {
  group: THREE.Group;
  /** re-anchor the static collider after setPlacement */
  setColliderTransform: (x: number, y: number, z: number, yaw: number) => void;
  dispose: () => void;
};

export function buildPlatform(physics: Physics | null): BuskerPlatform {
  const group = new THREE.Group();
  const deck = new THREE.MeshLambertMaterial({ color: 0x8d7b62 });
  const deckAlt = new THREE.MeshLambertMaterial({ color: 0x83725c });
  const frame = new THREE.MeshLambertMaterial({ color: 0x64543f });

  const add = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  // deck planks run left-right, laid front to back with a weathered gap
  const plankD = PLATFORM.depth / PLANKS;
  for (let i = 0; i < PLANKS; i++) {
    const z = -PLATFORM.depth / 2 + plankD * (i + 0.5);
    add(i % 2 ? deckAlt : deck, PLATFORM.width, 0.055, plankD - 0.018, 0, PLATFORM.top - 0.028, z);
  }
  // rim joists under the deck
  add(frame, PLATFORM.width, 0.12, 0.09, 0, PLATFORM.top - 0.12, -PLATFORM.depth / 2 + 0.045);
  add(frame, PLATFORM.width, 0.12, 0.09, 0, PLATFORM.top - 0.12, PLATFORM.depth / 2 - 0.045);
  add(frame, 0.09, 0.12, PLATFORM.depth - 0.18, -PLATFORM.width / 2 + 0.045, PLATFORM.top - 0.12, 0);
  add(frame, 0.09, 0.12, PLATFORM.depth - 0.18, PLATFORM.width / 2 - 0.045, PLATFORM.top - 0.12, 0);
  // corner posts, buried well below grade so a slope never floats them
  const postH = PLATFORM.top + POST_DROP;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(frame, 0.14, postH, 0.14, sx * (PLATFORM.width / 2 - 0.16), PLATFORM.top - 0.06 - postH / 2, sz * (PLATFORM.depth / 2 - 0.16));
    }
  }

  // one static box collider for the whole deck (walkable, blocks vehicles)
  const hx = PLATFORM.width / 2;
  const hy = PLATFORM.top / 2;
  const hz = PLATFORM.depth / 2;
  let body: number | null = null;
  if (physics) {
    body = physics.world.createBox({
      type: BodyType.Static,
      position: [0, hy, 0],
      halfExtents: [hx, hy, hz],
      friction: 0.85
    });
  }

  const setColliderTransform = (x: number, y: number, z: number, yaw: number) => {
    if (!physics || body === null) return;
    const cy = y + hy;
    physics.world.setBodyTransform(body, [x, cy, z], [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)]);
    physics.addQuerySolid(body, { x, y: cy, z, hx, hy, hz, yaw });
  };

  return {
    group,
    setColliderTransform,
    dispose: () => {
      for (const child of group.children) {
        const mesh = child as THREE.Mesh;
        mesh.geometry?.dispose();
      }
      deck.dispose();
      deckAlt.dispose();
      frame.dispose();
    }
  };
}
