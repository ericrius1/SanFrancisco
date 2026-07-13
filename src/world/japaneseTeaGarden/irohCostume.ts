import * as THREE from "three/webgpu";
import {
  flowingClothMaterial,
  type Capsule,
  type FlowingClothMotion
} from "../../fx/cloth";
import type { Rig } from "../../player/rig";

export type IrohCostume = {
  update(dt: number, motion: number, turn: number): void;
  dispose(): void;
};

// Uncle Iroh reference palette: cream shoulder shawl, dark-navy tunic, a warm
// tan under-robe/skirt under the navy cloak, pale grey-tan sleeves, a pale
// cream obi. (The vertex-colour arrays baked into the geometry are unused — the
// cloth materials sample the palette DataTextures below — but are kept in sync.)
const COLORS = {
  navy: new THREE.Color(0x232a42),
  navyDeep: new THREE.Color(0x1a2036),
  cream: new THREE.Color(0xe9e2d0),
  creamShade: new THREE.Color(0xcbc3ad),
  tan: new THREE.Color(0xccbb96),
  sleeve: 0xcfc6b0,
  sash: 0xd3ccb8
} as const;

type Rgb = readonly [number, number, number];
const RGB = {
  navy: [35, 42, 66],
  navyDeep: [26, 32, 54],
  cream: [233, 226, 208],
  creamShade: [203, 195, 173],
  tan: [204, 187, 150]
} as const satisfies Record<string, Rgb>;

function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const amount = THREE.MathUtils.clamp(t, 0, 1);
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], amount)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], amount)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], amount))
  ];
}

function paletteTexture(
  name: string,
  width: number,
  height: number,
  sample: (u: number, v: number) => Rgb
): THREE.DataTexture {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const [r, g, b] = sample(x / (width - 1), v);
      const offset = (y * width + x) * 4;
      data[offset] = r;
      data[offset + 1] = g;
      data[offset + 2] = b;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height, THREE.RGBAFormat);
  texture.name = name;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function robePaletteTexture(): THREE.DataTexture {
  return paletteTexture("iroh_robe_woven_palette", 64, 32, (u, v) => {
    const angle = u * Math.PI * 2;
    const frontness = Math.max(0, -Math.sin(angle)); // 1 at front centre (-Z), 0 at sides/back
    // Dark navy cloak up top; the warm tan under-robe shows lower. The navy
    // front apron hangs lower down the centre than the sides do, so the tan
    // reads first on the flanks — matching the reference silhouette.
    const tanStart = 0.44 + frontness * 0.3;
    let t = THREE.MathUtils.clamp((v - tanStart) / 0.2, 0, 1);
    t = t * t * (3 - 2 * t);
    let color = mixRgb(RGB.navy, RGB.tan, t);
    if (v > 0.93) color = mixRgb(color, RGB.cream, (v - 0.93) / 0.07); // cream hem trim
    return color;
  });
}

function mantlePaletteTexture(): THREE.DataTexture {
  // The big shoulder shawl: warm ivory throughout, easing to a soft grey-cream
  // shade at the draped outer edge so the folds read.
  return paletteTexture("iroh_mantle_woven_palette", 4, 32, (_u, v) =>
    mixRgb(RGB.cream, RGB.creamShade, v * 0.7)
  );
}

function addVertex(
  positions: number[],
  normals: number[],
  uvs: number[],
  colors: number[],
  position: THREE.Vector3,
  normal: THREE.Vector3,
  u: number,
  v: number,
  color: THREE.Color
): void {
  positions.push(position.x, position.y, position.z);
  normals.push(normal.x, normal.y, normal.z);
  uvs.push(u, v);
  colors.push(color.r, color.g, color.b);
}

/** Closed, generously flared envelope. The authored surface already clears the
 * full leg swing; live capsules are a second line of defence for extreme poses. */
function createRobeGeometry(): THREE.BufferGeometry {
  const radial = 28;
  const vertical = 10;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();

  for (let iy = 0; iy <= vertical; iy++) {
    const v = iy / vertical;
    const eased = v * v * (3 - 2 * v);
    const y = 0.08 - v * 0.92;
    // A dignified column, not a bell tent: the hem falls close to the body with
    // only a soft kimono flare (was 0.67/0.52 — a ~1.5 m-wide cone).
    const rx = THREE.MathUtils.lerp(0.34, 0.44, eased);
    const rz = THREE.MathUtils.lerp(0.27, 0.36, eased);
    for (let ix = 0; ix <= radial; ix++) {
      const u = ix / radial;
      const angle = u * Math.PI * 2;
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      p.set(ca * rx, y, sa * rz);
      n.set(ca / rx, 0.16 + v * 0.18, sa / rz).normalize();

      // Navy cloak up top easing to the warm tan under-robe lower down, with a
      // cream hem — mirrors robePaletteTexture (which is what actually shades
      // the cloth; these vertex colours are kept in sync but unused).
      const frontness = Math.max(0, -sa);
      const tanStart = 0.44 + frontness * 0.3;
      let t = THREE.MathUtils.clamp((v - tanStart) / 0.2, 0, 1);
      t = t * t * (3 - 2 * t);
      c.copy(COLORS.navy).lerp(COLORS.tan, t);
      if (v > 0.93) c.lerp(COLORS.cream, (v - 0.93) / 0.07);
      addVertex(positions, normals, uvs, colors, p, n, u, v, c);
    }
  }

  const row = radial + 1;
  for (let iy = 0; iy < vertical; iy++) {
    for (let ix = 0; ix < radial; ix++) {
      const a = iy * row + ix;
      const b = a + 1;
      const d = (iy + 1) * row + ix;
      const e = d + 1;
      indices.push(a, b, d, b, e, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.boundingBox?.expandByScalar(0.16);
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.16;
  return geometry;
}

/** A shoulder yoke in two cloth arcs. The gaps at local ±X are real armholes,
 * not alpha tricks, so no serving or pointing pose can drive an arm through it. */
function createMantleGeometry(): THREE.BufferGeometry {
  // More radial resolution lets the yoke settle into a rounded shoulder cape
  // instead of reading as a pair of flat, angular plates. It remains one draw
  // and only adds 140 authored vertices before GPU deformation.
  const segments = 24;
  const radial = 6;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const p = new THREE.Vector3();
  const n = new THREE.Vector3();
  const c = new THREE.Color();
  const arcs: readonly [number, number][] = [
    [0.66, Math.PI - 0.66],
    [Math.PI + 0.66, Math.PI * 2 - 0.66]
  ];

  for (const [start, end] of arcs) {
    const base = positions.length / 3;
    for (let ia = 0; ia <= segments; ia++) {
      const u = ia / segments;
      const angle = THREE.MathUtils.lerp(start, end, u);
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      for (let ir = 0; ir <= radial; ir++) {
        const v = ir / radial;
        const eased = v * v * (3 - 2 * v);
        // A modest shoulder cape, not a chin-high ruff: smaller outer radius,
        // and it starts lower (0.36 vs 0.47) and drapes harder so the navy tunic
        // shows in the centre front the way the reference shawl does.
        const rx = THREE.MathUtils.lerp(0.15, 0.31, eased);
        const rz = THREE.MathUtils.lerp(0.13, 0.25, eased);
        const frontDrape = Math.max(0, -sa) * eased * 0.14;
        const backDrape = Math.max(0, sa) * eased * 0.06;
        p.set(ca * rx, 0.36 - eased * 0.3 - v * v * 0.05 - frontDrape - backDrape, sa * rz);
        n.set(ca * (0.2 + eased * 0.22), 1, sa * (0.2 + eased * 0.22)).normalize();
        c.copy(COLORS.cream).lerp(COLORS.creamShade, eased * 0.7);
        addVertex(positions, normals, uvs, colors, p, n, u, v, c);
      }
    }
    const row = radial + 1;
    for (let ia = 0; ia < segments; ia++) {
      for (let ir = 0; ir < radial; ir++) {
        const a = base + ia * row + ir;
        const b = a + 1;
        const d = base + (ia + 1) * row + ir;
        const e = d + 1;
        indices.push(a, d, b, b, d, e);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.boundingBox?.expandByScalar(0.11);
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 0.11;
  return geometry;
}

function localPoint(
  inverseMeshWorld: THREE.Matrix4,
  object: THREE.Object3D,
  point: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  return out.copy(point).applyMatrix4(object.matrixWorld).applyMatrix4(inverseMeshWorld);
}

export function createIrohCostume(rig: Rig): IrohCostume {
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const textures: THREE.Texture[] = [];

  const robePalette = robePaletteTexture();
  const mantlePalette = mantlePaletteTexture();
  textures.push(robePalette, mantlePalette);

  const robeState = flowingClothMaterial({
    color: 0xffffff,
    map: robePalette,
    roughness: 0.91,
    amplitude: 0.07,
    speed: 2.1,
    phase: 0.35
  });
  const robe = new THREE.Mesh(createRobeGeometry(), robeState.material);
  robe.name = "iroh_collision_aware_flowing_robe";
  robe.castShadow = true;
  robe.receiveShadow = true;
  rig.hips.add(robe);
  geometries.push(robe.geometry);
  materials.push(robeState.material);

  const mantleState = flowingClothMaterial({
    color: 0xffffff,
    map: mantlePalette,
    roughness: 0.89,
    amplitude: 0.028,
    speed: 1.75,
    phase: 1.7
  });
  const mantle = new THREE.Mesh(createMantleGeometry(), mantleState.material);
  mantle.name = "iroh_arm_cut_flowing_mantle";
  mantle.castShadow = true;
  mantle.receiveShadow = true;
  rig.torso.add(mantle);
  geometries.push(mantle.geometry);
  materials.push(mantleState.material);

  // Sleeves move in their owning shoulder frames. Their generous frusta clear
  // the stock arm blocks, while the mantle's true armholes keep the systems
  // from competing for the same volume.
  const sleeveState = flowingClothMaterial({
    color: COLORS.sleeve,
    roughness: 0.9,
    amplitude: 0.024,
    speed: 2.5,
    phase: 2.4,
    collisionIterations: 0
  });
  materials.push(sleeveState.material);
  const sleeveGeometry = new THREE.CylinderGeometry(0.16, 0.255, 0.43, 14, 4, true);
  // CylinderGeometry authors v=1 at the shoulder. The cloth contract pins
  // v=0, so reverse it once: shoulder stays sewn down, cuff is the free edge.
  const sleeveUv = sleeveGeometry.getAttribute("uv") as THREE.BufferAttribute;
  for (let index = 0; index < sleeveUv.count; index++) sleeveUv.setY(index, 1 - sleeveUv.getY(index));
  sleeveUv.needsUpdate = true;
  sleeveGeometry.computeBoundingBox();
  sleeveGeometry.computeBoundingSphere();
  sleeveGeometry.boundingBox?.expandByScalar(0.05);
  if (sleeveGeometry.boundingSphere) sleeveGeometry.boundingSphere.radius += 0.05;
  geometries.push(sleeveGeometry);
  const sleeves: THREE.Mesh[] = [];
  for (const [side, arm] of [["L", rig.armL], ["R", rig.armR]] as const) {
    const sleeve = new THREE.Mesh(sleeveGeometry, sleeveState.material);
    sleeve.name = `iroh_flowing_sleeve_${side}`;
    sleeve.position.y = -0.15;
    sleeve.castShadow = true;
    arm.add(sleeve);
    sleeves.push(sleeve);
  }

  const sashMaterial = new THREE.MeshStandardMaterial({ color: COLORS.sash, roughness: 0.78 });
  const sashGeometry = new THREE.CylinderGeometry(0.405, 0.405, 0.105, 20);
  const sash = new THREE.Mesh(sashGeometry, sashMaterial);
  sash.name = "iroh_blue_sash";
  sash.scale.z = 0.88;
  sash.position.y = 0.035;
  sash.castShadow = true;
  rig.hips.add(sash);
  geometries.push(sashGeometry);
  materials.push(sashMaterial);

  const skirtCaps: Capsule[] = [
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.32, skin: 0.025 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.14, skin: 0.022 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.14, skin: 0.022 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.19, skin: 0.025 }
  ];
  const mantleCaps: Capsule[] = [
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.31, skin: 0.02 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.17, skin: 0.02 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.17, skin: 0.02 },
    { a: new THREE.Vector3(), b: new THREE.Vector3(), radius: 0.16, skin: 0.02 }
  ];
  const zero = new THREE.Vector3();
  const pelvisRoot = new THREE.Vector3(0, -0.08, 0);
  const torsoTop = new THREE.Vector3(0, 0.48, 0);
  const legTip = new THREE.Vector3(0, -0.35, 0);
  const armTip = new THREE.Vector3(0, -0.27, 0);
  const neckTop = new THREE.Vector3(0, 0.16, 0);
  const inverseRobeWorld = new THREE.Matrix4();
  const inverseMantleWorld = new THREE.Matrix4();
  const sharedMotion: FlowingClothMotion = { motion: 0, turn: 0, breeze: 0.18 };
  const mantleMotion: FlowingClothMotion = { motion: 0, turn: 0, breeze: 0.18 };
  const sleeveMotion: FlowingClothMotion = { motion: 0, turn: 0, breeze: 0.18 };
  let smoothedMotion = 0;
  let smoothedTurn = 0;

  const syncColliders = () => {
    rig.group.updateWorldMatrix(true, true);
    inverseRobeWorld.copy(robe.matrixWorld).invert();
    inverseMantleWorld.copy(mantle.matrixWorld).invert();

    localPoint(inverseRobeWorld, rig.hips, pelvisRoot, skirtCaps[0].a);
    localPoint(inverseRobeWorld, rig.torso, torsoTop, skirtCaps[0].b);
    localPoint(inverseRobeWorld, rig.legL, zero, skirtCaps[1].a);
    localPoint(inverseRobeWorld, rig.shinL, legTip, skirtCaps[1].b);
    localPoint(inverseRobeWorld, rig.legR, zero, skirtCaps[2].a);
    localPoint(inverseRobeWorld, rig.shinR, legTip, skirtCaps[2].b);
    localPoint(inverseRobeWorld, rig.legL, zero, skirtCaps[3].a);
    localPoint(inverseRobeWorld, rig.legR, zero, skirtCaps[3].b);
    robeState.colliders.set(skirtCaps);

    localPoint(inverseMantleWorld, rig.torso, zero, mantleCaps[0].a);
    localPoint(inverseMantleWorld, rig.torso, torsoTop, mantleCaps[0].b);
    localPoint(inverseMantleWorld, rig.armL, zero, mantleCaps[1].a);
    localPoint(inverseMantleWorld, rig.foreL, armTip, mantleCaps[1].b);
    localPoint(inverseMantleWorld, rig.armR, zero, mantleCaps[2].a);
    localPoint(inverseMantleWorld, rig.foreR, armTip, mantleCaps[2].b);
    localPoint(inverseMantleWorld, rig.torso, torsoTop, mantleCaps[3].a);
    localPoint(inverseMantleWorld, rig.head, neckTop, mantleCaps[3].b);
    mantleState.colliders.set(mantleCaps);
  };

  syncColliders();

  return {
    update(dt, motion, turn) {
      const safeDt = Math.min(Math.max(dt, 0), 0.1);
      smoothedMotion = THREE.MathUtils.damp(smoothedMotion, THREE.MathUtils.clamp(motion, 0, 1), 6.5, safeDt);
      smoothedTurn = THREE.MathUtils.damp(smoothedTurn, THREE.MathUtils.clamp(turn, -1, 1), 8.5, safeDt);
      sharedMotion.motion = smoothedMotion;
      sharedMotion.turn = smoothedTurn;
      sharedMotion.breeze = 0.18 + smoothedMotion * 0.17;
      mantleMotion.motion = smoothedMotion * 0.45;
      mantleMotion.turn = smoothedTurn * 0.55;
      mantleMotion.breeze = sharedMotion.breeze;
      sleeveMotion.motion = smoothedMotion * 0.6;
      sleeveMotion.turn = smoothedTurn * 0.35;
      sleeveMotion.breeze = sharedMotion.breeze;
      robeState.setMotion(sharedMotion);
      mantleState.setMotion(mantleMotion);
      sleeveState.setMotion(sleeveMotion);
      syncColliders();
    },
    dispose() {
      for (const geometry of new Set(geometries)) geometry.dispose();
      for (const material of new Set(materials)) material.dispose();
      for (const texture of new Set(textures)) texture.dispose();
      robe.removeFromParent();
      mantle.removeFromParent();
      sash.removeFromParent();
      for (const sleeve of sleeves) sleeve.removeFromParent();
    }
  };
}
