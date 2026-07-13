import * as THREE from "three/webgpu";
import { BodyType } from "../core/physics";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { Physics } from "../core/physics";
import type { WorldMap } from "../world/heightmap";
import { enableLocalFarShadowLayers } from "../world/shadows/shadowLayers";

/**
 * Floating islands drifting over the city — little grass discs with a dirt
 * underbelly, a unified-system tree, gems, and balloons tied to the edge.
 * Visible from blocks away, so they pull you across the map; each has a static
 * slab body, so anything that can reach one (drone, plane bail-out, a bold
 * rooftop jump) can LAND on it. One merged mesh per island + one shared
 * instanced balloon mesh: ~9 draw calls for the whole fleet.
 */

type Island = {
  x: number;
  y: number;
  z: number;
  r: number;
  balloons: { ox: number; oy: number; oz: number; phase: number; scale: number }[];
};

const SPOTS: [number, number, number, number][] = [
  // x, z, lift above ground, radius
  [4210, -240, 52, 11],
  [3560, -690, 62, 9],
  [3920, 470, 66, 12],
  [2620, -1580, 55, 10],
  [520, -2010, 48, 9],
  [-1480, 480, 55, 10],
  [1980, 1480, 60, 11],
  [1700, -3720, 42, 9] // over the bay by Alcatraz
];

const BALLOON_TINTS = [0xffb3c8, 0xa8e4ff, 0xc9ffc4, 0xfff3ad, 0xe0c4ff, 0xffd2a8];

function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.getAttribute("position").count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

function islandGeometry(r: number, seed: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const grass = paint(new THREE.CylinderGeometry(r, r * 0.94, 1.6, 18), 0x6fae58);
  grass.translate(0, 0, 0);
  parts.push(grass);
  const dirt = paint(new THREE.ConeGeometry(r * 0.92, r * 0.85, 14), 0x6b4a33);
  dirt.rotateX(Math.PI);
  dirt.translate(0, -0.8 - r * 0.42, 0);
  parts.push(dirt);
  // scattered gems catching the light
  for (let i = 0; i < 3; i++) {
    const a = seed * 5 + i * 2.1;
    const gem = paint(new THREE.OctahedronGeometry(0.45, 0), [0xff4d88, 0x4dc3ff, 0xffd23d][i]);
    gem.translate(Math.cos(a) * r * 0.55, 1.1, Math.sin(a) * r * 0.55);
    parts.push(gem);
  }
  // the gems are polyhedra (non-indexed) while the rest are indexed primitives;
  // mergeGeometries refuses mixed indexing, so flatten everything first
  const merged = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)));
  for (const p of parts) p.dispose();
  return merged;
}

export class Islands {
  #islands: Island[] = [];
  #balloonMesh: THREE.InstancedMesh;
  #strings: THREE.LineSegments;
  #mat = new THREE.Matrix4();
  #pos = new THREE.Vector3();
  #quat = new THREE.Quaternion();
  #scale = new THREE.Vector3();
  #treeRoots: { x: number; y: number; z: number; yaw: number; scale: number; archetype: string }[] = [];
  #treePatch: {
    group: THREE.Group;
    update(focus: { x: number; z: number }): void;
    dispose(): void;
  } | null = null;
  #foliageVisible = true;
  #foliagePrepared = false;
  #foliageLoad: Promise<void> | null = null;
  #foliageArm: {
    scene: THREE.Scene;
    prepare?: (group: THREE.Group) => Promise<void>;
  } | null = null;
  #foliageFocus = { x: 0, z: 0 };

  constructor(physics: Physics, map: WorldMap, scene: THREE.Scene) {
    const bodyMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    let totalBalloons = 0;

    for (let i = 0; i < SPOTS.length; i++) {
      const [x, z, lift, r] = SPOTS[i];
      const y = Math.max(map.effectiveGround(x, z), 0) + lift;
      const mesh = new THREE.Mesh(islandGeometry(r, i + 1), bodyMat);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      enableLocalFarShadowLayers(mesh);
      mesh.receiveShadow = true;
      scene.add(mesh);
      const seed = i + 1;
      const tx = (Math.sin(seed * 12.9898) * 0.5) * r * 0.5;
      const tz = (Math.sin(seed * 78.233) * 0.5) * r * 0.5;
      this.#treeRoots.push({
        x: x + tx,
        y: y + 0.72,
        z: z + tz,
        yaw: seed * 1.927,
        scale: 0.5 + (i % 3) * 0.06,
        archetype: i % 2 === 0 ? "island-pine" : "island-maple"
      });

      // landing slab (thin, flush with the grass top) — lives for the whole
      // session inside the physics world, so we don't retain a handle
      physics.world.createBox({
        type: BodyType.Static,
        position: [x, y - 0.3, z],
        halfExtents: [r * 0.95, 1.1, r * 0.95],
        friction: 0.85
      });

      const balloons: Island["balloons"] = [];
      const count = 3 + (i % 3);
      for (let b = 0; b < count; b++) {
        const a = (b / count) * Math.PI * 2 + i;
        balloons.push({
          ox: Math.cos(a) * (r + 1.2),
          oy: 4.5 + (b % 3) * 1.4,
          oz: Math.sin(a) * (r + 1.2),
          phase: Math.random() * Math.PI * 2,
          scale: 0.8 + (b % 2) * 0.25
        });
        totalBalloons++;
      }
      this.#islands.push({ x, y, z, r, balloons });
    }

    const balloonGeo = new THREE.SphereGeometry(0.62, 16, 12);
    const balloonMat = new THREE.MeshStandardMaterial({ roughness: 0.3 });
    this.#balloonMesh = new THREE.InstancedMesh(balloonGeo, balloonMat, totalBalloons);
    this.#balloonMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.#balloonMesh.frustumCulled = false;
    let bi = 0;
    const tint = new THREE.Color();
    for (const isl of this.#islands) {
      for (let b = 0; b < isl.balloons.length; b++) {
        tint.setHex(BALLOON_TINTS[bi % BALLOON_TINTS.length]);
        this.#balloonMesh.setColorAt(bi, tint);
        bi++;
      }
    }
    if (this.#balloonMesh.instanceColor) this.#balloonMesh.instanceColor.needsUpdate = true;
    scene.add(this.#balloonMesh);

    const stringGeo = new THREE.BufferGeometry();
    stringGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(totalBalloons * 6), 3));
    this.#strings = new THREE.LineSegments(
      stringGeo,
      new THREE.LineBasicMaterial({
        color: 0xf5efdf,
        opacity: 0.7,
        transparent: true,
        depthWrite: false
      })
    );
    this.#strings.frustumCulled = false;
    scene.add(this.#strings);
  }

  /**
   * Load island trees after the world is revealed. The dynamic boundary keeps
   * SeedForest and tree generation out of clean boot while still routing these
   * far-flung landmarks through the one shared tree runtime.
   */
  loadVegetation(
    scene: THREE.Scene,
    prepare?: (group: THREE.Group) => Promise<void>
  ): Promise<void> {
    if (this.#foliageLoad) return this.#foliageLoad;
    this.#foliageLoad = (async () => {
      const { createAuthoredTreePatch } = await import("../world/vegetation/authoredTrees");
      const patch = createAuthoredTreePatch(
        [
          {
            id: "island-pine",
            design: {
              species: "pine",
              seed: 811,
              controls: {
                height: 8,
                branchDensity: 26,
                leavesPerBranch: 18,
                leafColorize: 0x4c8247,
                leafTintAmount: 0.54
              },
              sink: 0.18
            }
          },
          {
            id: "island-maple",
            design: {
              species: "redMaple",
              seed: 823,
              controls: {
                height: 7.5,
                leafColorize: 0x5f914c,
                leafTintAmount: 0.58
              },
              sink: 0.16
            }
          }
        ],
        this.#treeRoots,
        {
          name: "floating_island_trees",
          chunkSize: 280,
          visibleDistance: 1250,
          nearRadius: 64,
          nearExitRadius: 74,
          nearMax: 4
        }
      );
      this.#treePatch = patch;
      await patch.ready;
      patch.update(this.#foliageFocus);
      // Compile while detached but visible: Three skips visible=false roots.
      // Attach only after preparation so no live frame sees an uncompiled tree.
      if (prepare) await prepare(patch.group);
      this.#foliagePrepared = true;
      patch.group.visible = this.#foliageVisible;
      scene.add(patch.group);
    })().catch((error) => {
      this.#treePatch?.dispose();
      this.#treePatch = null;
      console.warn("[islands] unified tree patch unavailable:", error);
    });
    return this.#foliageLoad;
  }

  /** Enable first-approach loading without fetching the tree chunk yet. */
  armVegetation(scene: THREE.Scene, prepare?: (group: THREE.Group) => Promise<void>) {
    this.#foliageArm = { scene, prepare };
  }

  setFoliageVisible(visible: boolean) {
    this.#foliageVisible = visible;
    if (this.#treePatch && this.#foliagePrepared) this.#treePatch.group.visible = visible;
  }

  update(elapsed: number, focus?: { x: number; z: number }) {
    if (focus) {
      this.#foliageFocus.x = focus.x;
      this.#foliageFocus.z = focus.z;
    }
    if (focus && this.#foliageVisible && this.#foliageArm && !this.#foliageLoad) {
      const nearIsland = this.#islands.some((island) =>
        Math.hypot(focus.x - island.x, focus.z - island.z) < 1550
      );
      if (nearIsland) {
        const arm = this.#foliageArm;
        this.#foliageArm = null;
        void this.loadVegetation(arm.scene, arm.prepare);
      }
    }
    if (focus && this.#foliageVisible) this.#treePatch?.update(focus);
    const attr = this.#strings.geometry.getAttribute("position") as THREE.BufferAttribute;
    const arr = attr.array as Float32Array;
    let i = 0;
    for (const isl of this.#islands) {
      for (const b of isl.balloons) {
        const bob = Math.sin(elapsed * 0.8 + b.phase) * 0.5;
        const sway = Math.sin(elapsed * 0.5 + b.phase * 2) * 0.4;
        const bx = isl.x + b.ox + sway;
        const by = isl.y + b.oy + bob;
        const bz = isl.z + b.oz + sway * 0.6;
        this.#pos.set(bx, by, bz);
        this.#mat.compose(this.#pos, this.#quat, this.#scale.setScalar(b.scale));
        this.#balloonMesh.setMatrixAt(i, this.#mat);
        arr[i * 6] = isl.x + b.ox * 0.85;
        arr[i * 6 + 1] = isl.y + 0.6;
        arr[i * 6 + 2] = isl.z + b.oz * 0.85;
        arr[i * 6 + 3] = bx;
        arr[i * 6 + 4] = by - b.scale * 0.6;
        arr[i * 6 + 5] = bz;
        i++;
      }
    }
    this.#balloonMesh.instanceMatrix.needsUpdate = true;
    attr.needsUpdate = true;
  }
}
