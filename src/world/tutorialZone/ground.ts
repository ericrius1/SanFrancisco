/**
 * The rendered decks — asphalt ribbon, concrete bowl, cottage floor.
 *
 * Every vertex height comes from `zoneGroundTop`, the same function installed
 * as the ground overlay, so what you see and what you stand on are the same
 * surface by construction rather than by agreement. The meshes are drawn a
 * little wider than the overlay's full-lift footprint: each surface's skirt
 * tapers back to grade under the overhang, so there is never a visible seam or
 * a collision lip at the edge.
 */

import * as THREE from "three/webgpu";
import {
  BOWL,
  COTTAGE,
  TRACK,
  TRACK_START,
  zoneGroundTop,
  zoneWorldX,
  zoneWorldZ,
  type ZoneGrades
} from "./layout";

type Ground = { groundTop(x: number, z: number): number };

/** Deck materials. Shared per surface; disposed with the site. */
export function createGroundMaterials() {
  return {
    asphalt: new THREE.MeshStandardMaterial({ color: 0x33363b, roughness: 0.94, metalness: 0 }),
    concrete: new THREE.MeshStandardMaterial({ color: 0x9a978d, roughness: 0.88, metalness: 0 }),
    berm: new THREE.MeshStandardMaterial({ color: 0x5c7245, roughness: 0.97, metalness: 0 }),
    floorboard: new THREE.MeshStandardMaterial({ color: 0x8a6a45, roughness: 0.8, metalness: 0 }),
    paint: new THREE.MeshStandardMaterial({ color: 0xece7d8, roughness: 0.7, metalness: 0 })
  };
}

export type GroundMaterials = ReturnType<typeof createGroundMaterials>;

/** Height of the finished surface at a local point, in world Y. */
function topAt(map: Ground, grades: ZoneGrades, u: number, v: number): number {
  const x = zoneWorldX(u);
  const z = zoneWorldZ(v);
  return zoneGroundTop(u, v, map.groundTop(x, z), grades);
}

function finish(geometry: THREE.BufferGeometry, material: THREE.Material, name: string): THREE.Mesh {
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.receiveShadow = true;
  return mesh;
}

type GridMeshOpts = {
  cols: number;
  rows: number;
  /** (col, row) → local XZ. */
  place: (i: number, j: number) => { u: number; v: number };
  height: (u: number, v: number) => number;
  material: THREE.Material;
  name: string;
  /** Column 0 and column `cols` are the same ring (the oval, the bowl). */
  wrapCols?: boolean;
  /**
   * Angular sweeps run rows outward and columns anticlockwise, which winds
   * every quad the other way round — without this their faces point at the
   * ground and the deck renders black.
   */
  flipWinding?: boolean;
  /** Drop quads whose centre this rejects, for non-rectangular outlines. */
  skip?: (u: number, v: number) => boolean;
};

/** Build a grid mesh from a (col, row) → local-XZ parameterisation. */
function gridMesh({
  cols,
  rows,
  place,
  height,
  material,
  name,
  wrapCols = false,
  flipWinding = false,
  skip
}: GridMeshOpts): THREE.Mesh {
  const w = wrapCols ? cols : cols + 1;
  const positions = new Float32Array(w * (rows + 1) * 3);
  const uvs = new Float32Array(w * (rows + 1) * 2);
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i < w; i++) {
      const { u, v } = place(i, j);
      const k = j * w + i;
      positions[k * 3] = zoneWorldX(u);
      positions[k * 3 + 1] = height(u, v);
      positions[k * 3 + 2] = zoneWorldZ(v);
      uvs[k * 2] = u * 0.25;
      uvs[k * 2 + 1] = v * 0.25;
    }
  }
  const indices: number[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const i1 = wrapCols ? (i + 1) % cols : i + 1;
      const a = j * w + i;
      const b = j * w + i1;
      const c = (j + 1) * w + i;
      const d = (j + 1) * w + i1;
      if (skip) {
        const p0 = place(i, j);
        const p1 = place(i1, j + 1);
        if (skip((p0.u + p1.u) / 2, (p0.v + p1.v) / 2)) continue;
      }
      if (flipWinding) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return finish(geometry, material, name);
}

/** The paved oval, swept from the ellipse and lifted by the overlay itself. */
export function buildTrackDeck(map: Ground, grades: ZoneGrades, mats: GroundMaterials): THREE.Mesh {
  const cols = 260;
  const rows = 10;
  const reach = TRACK.halfWidth + TRACK.bevel + 0.35; // overhang hides the seam
  return gridMesh({
    cols,
    rows,
    wrapCols: true,
    flipWinding: true,
    place: (i, j) => {
      const t = (i / cols) * Math.PI * 2;
      const lateral = (j / rows) * 2 - 1;
      // Offset along the ellipse's outward normal so the ribbon keeps its width
      // through the bends rather than pinching at the apexes.
      const nu = Math.cos(t) / TRACK.a;
      const nv = Math.sin(t) / TRACK.b;
      const n = Math.hypot(nu, nv) || 1;
      return {
        u: TRACK.cu + Math.cos(t) * TRACK.a + (nu / n) * lateral * reach,
        v: TRACK.cv + Math.sin(t) * TRACK.b + (nv / n) * lateral * reach
      };
    },
    height: (u, v) => topAt(map, grades, u, v),
    material: mats.asphalt,
    name: "tutorial_track_deck"
  });
}

/** The bowl plinth: concrete out to the deck edge, grass over the berm. */
export function buildBowlDecks(map: Ground, grades: ZoneGrades, mats: GroundMaterials): THREE.Mesh[] {
  const segments = 72;
  const radial = (r0: number, r1: number, rings: number, material: THREE.Material, name: string) =>
    gridMesh({
      cols: segments,
      rows: rings,
      wrapCols: true,
      flipWinding: true,
      place: (i, j) => {
        const t = (i / segments) * Math.PI * 2;
        const r = r0 + ((r1 - r0) * j) / rings;
        return { u: BOWL.cu + Math.cos(t) * r, v: BOWL.cv + Math.sin(t) * r };
      },
      height: (u, v) => topAt(map, grades, u, v),
      material,
      name
    });
  return [
    // Dense through the transition, where the profile actually curves.
    radial(0, BOWL.deckRadius, 34, mats.concrete, "tutorial_bowl_concrete"),
    radial(BOWL.deckRadius - 0.05, BOWL.bermRadius + 0.4, 14, mats.berm, "tutorial_bowl_berm")
  ];
}

/** Cottage floor + its stoop ramp, one board-coloured slab. */
export function buildCottageFloor(map: Ground, grades: ZoneGrades, mats: GroundMaterials): THREE.Mesh {
  const halfU = COTTAGE.halfU + COTTAGE.wall + 0.9;
  const vMin = COTTAGE.v - (COTTAGE.halfV + COTTAGE.wall + 0.9);
  const vMax = COTTAGE.doorV + COTTAGE.stoopDepth + 0.5;
  const cols = 26;
  const rows = 30;
  return gridMesh({
    cols,
    rows,
    place: (i, j) => ({
      u: COTTAGE.u - halfU + (2 * halfU * i) / cols,
      v: vMin + ((vMax - vMin) * j) / rows
    }),
    height: (u, v) => topAt(map, grades, u, v),
    material: mats.floorboard,
    name: "tutorial_cottage_floor",
    // Drop the corners flanking the stoop — they would render a floating tongue
    // of floorboard out on the lawn either side of the steps.
    skip: (u, v) =>
      v > COTTAGE.v + COTTAGE.halfV + COTTAGE.wall + 0.9 &&
      Math.abs(u - COTTAGE.doorU) > COTTAGE.doorWidth
  });
}

/**
 * Painted markings: the start/finish bar across the ribbon and a chalk lane for
 * the sprint. Ground decals ride a POSITIVE polygonOffset — this renderer uses a
 * reversed depth buffer, where a negative offset pushes a decal *into* the
 * surface and it disappears.
 */
export function buildGroundPaint(map: Ground, grades: ZoneGrades, mats: GroundMaterials): THREE.Mesh {
  const material = mats.paint;
  material.polygonOffset = true;
  material.polygonOffsetFactor = 2;
  material.polygonOffsetUnits = 4;

  const positions: number[] = [];
  const indices: number[] = [];
  const quad = (corners: readonly { u: number; v: number }[]) => {
    const base = positions.length / 3;
    for (const c of corners) {
      positions.push(zoneWorldX(c.u), topAt(map, grades, c.u, c.v) + 0.012, zoneWorldZ(c.v));
    }
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  };

  // Start/finish bar, across the ribbon at the north apex.
  const w = TRACK.halfWidth;
  quad([
    { u: TRACK_START.u - 0.55, v: TRACK_START.v - w },
    { u: TRACK_START.u + 0.55, v: TRACK_START.v - w },
    { u: TRACK_START.u - 0.55, v: TRACK_START.v + w },
    { u: TRACK_START.u + 0.55, v: TRACK_START.v + w }
  ]);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return finish(geometry, material, "tutorial_ground_paint");
}
