import * as THREE from "three/webgpu";
import type { Rig } from "../../player/rig";
import { enableShadowLayer, SHADOW_LAYERS } from "../shadows/shadowLayers";

export type HiroCostume = {
  update(dt: number, motion: number, turn: number): void;
  dispose(): void;
};

// White Lotus Hiro is identified by the garment hierarchy, not by a blended
// texture: ivory shoulder yoke, navy over-robe, stone inner robe, broad obi and
// pale bell sleeves. Keep these colors together so every procedural layer stays
// coordinated when the art direction changes.
const PALETTE = {
  navy: 0x171d32,
  navyLift: 0x252d49,
  ivory: 0xeee8d8,
  ivoryShade: 0xd8d2c3,
  stone: 0xd3cab6,
  stoneShade: 0xaaa99e
} as const;

type Point2 = readonly [x: number, y: number];

function meshMaterial(color: number): THREE.MeshLambertMaterial {
  return new THREE.MeshLambertMaterial({ color, side: THREE.DoubleSide });
}

function panelGeometry(points: readonly Point2[], z: number): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [x, y] of points) positions.push(x, y, z);
  for (let index = 1; index < points.length - 1; index++) indices.push(0, index, index + 1);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function ribbonGeometry(a: Point2, b: Point2, width: number, z: number): THREE.BufferGeometry {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const length = Math.hypot(dx, dy) || 1;
  const ox = (-dy / length) * width * 0.5;
  const oy = (dx / length) * width * 0.5;
  return panelGeometry(
    [
      [a[0] + ox, a[1] + oy],
      [a[0] - ox, a[1] - oy],
      [b[0] - ox, b[1] - oy],
      [b[0] + ox, b[1] + oy]
    ],
    z
  );
}

function skirtGeometry(options: {
  topY: number;
  bottomY: number;
  topRadius: readonly [x: number, z: number];
  bottomRadius: readonly [x: number, z: number];
  startAngle?: number;
  endAngle?: number;
  segments?: number;
  rows?: number;
}): THREE.BufferGeometry {
  const {
    topY,
    bottomY,
    topRadius,
    bottomRadius,
    startAngle = -Math.PI / 2,
    endAngle = startAngle + Math.PI * 2,
    segments = 28,
    rows = 4
  } = options;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];

  for (let row = 0; row <= rows; row++) {
    const v = row / rows;
    const eased = v * v * (3 - 2 * v);
    const rx = THREE.MathUtils.lerp(topRadius[0], bottomRadius[0], eased);
    const rz = THREE.MathUtils.lerp(topRadius[1], bottomRadius[1], eased);
    const y = THREE.MathUtils.lerp(topY, bottomY, v);
    for (let column = 0; column <= segments; column++) {
      const u = column / segments;
      const angle = THREE.MathUtils.lerp(startAngle, endAngle, u);
      positions.push(Math.cos(angle) * rx, y, Math.sin(angle) * rz);
      uvs.push(u, v);
    }
  }

  const stride = segments + 1;
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < segments; column++) {
      const a = row * stride + column;
      const b = a + 1;
      const c = (row + 1) * stride + column;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function mantleGeometry(inner = 0, outer = 1): THREE.BufferGeometry {
  const segmentsPerArc = 18;
  const bands = 5;
  const positions: number[] = [];
  const indices: number[] = [];
  const innerX = 0.13;
  const innerZ = 0.105;
  const outerX = 0.43;
  const outerZ = 0.31;
  // Front and back arcs leave true ±X armholes. The static yoke can therefore
  // stay broad while every cup, welcome and pointing pose passes cleanly through
  // the garment instead of intersecting a hidden full-circle annulus.
  const armGap = 0.48;
  const arcs: readonly [start: number, end: number][] = [
    [armGap, Math.PI - armGap],
    [Math.PI + armGap, Math.PI * 2 - armGap]
  ];
  const stride = bands + 1;

  for (const [start, end] of arcs) {
    const base = positions.length / 3;
    for (let segment = 0; segment <= segmentsPerArc; segment++) {
      const angle = THREE.MathUtils.lerp(start, end, segment / segmentsPerArc);
      const ca = Math.cos(angle);
      const sa = Math.sin(angle);
      const front = Math.max(0, -sa);
      const back = Math.max(0, sa);
      for (let band = 0; band <= bands; band++) {
        const t = THREE.MathUtils.lerp(inner, outer, band / bands);
        const eased = t * t * (3 - 2 * t);
        const rx = THREE.MathUtils.lerp(innerX, outerX, eased);
        const rz = THREE.MathUtils.lerp(innerZ, outerZ, eased);
        // The front becomes a broad shallow bib; the back remains short enough
        // to frame the head rather than swallowing it from three-quarter views.
        const edgeY = 0.3 - front * 0.13 - back * 0.05;
        const y = THREE.MathUtils.lerp(0.455, edgeY, eased) - Math.sin(t * Math.PI) * 0.012;
        positions.push(ca * rx, y, sa * rz);
      }
    }

    for (let segment = 0; segment < segmentsPerArc; segment++) {
      for (let band = 0; band < bands; band++) {
        const a = base + segment * stride + band;
        const b = a + 1;
        const c = base + (segment + 1) * stride + band;
        const d = c + 1;
        indices.push(a, c, b, b, c, d);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function createHiroCostume(rig: Rig): HiroCostume {
  const geometries: THREE.BufferGeometry[] = [];
  const materials = {
    navy: meshMaterial(PALETTE.navy),
    navyLift: meshMaterial(PALETTE.navyLift),
    ivory: meshMaterial(PALETTE.ivory),
    ivoryShade: meshMaterial(PALETTE.ivoryShade),
    mantle: meshMaterial(PALETTE.ivory),
    mantleShade: meshMaterial(PALETTE.ivoryShade),
    stone: meshMaterial(PALETTE.stone),
    stoneShade: meshMaterial(PALETTE.stoneShade)
  };
  // The tea-house eaves put the horizontal yoke into deep shadow. A controlled
  // ambient lift preserves its defining ivory color without flattening the
  // vertical trim, sleeves, or under-robe.
  materials.mantle.emissive.set(0x8c877b);
  materials.mantle.emissiveIntensity = 0.52;
  materials.mantleShade.emissive.set(0x777268);
  materials.mantleShade.emissiveIntensity = 0.45;
  const meshes: THREE.Mesh[] = [];

  const add = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    name: string,
    position: readonly [number, number, number] = [0, 0, 0]
  ): THREE.Mesh => {
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    enableShadowLayer(mesh, SHADOW_LAYERS.HERO_DYNAMIC);
    parent.add(mesh);
    meshes.push(mesh);
    return mesh;
  };

  // Full stone under-robe. It ends above the slippers instead of pooling on the
  // ground, which restores Hiro's feet and makes the whole figure read taller.
  add(
    rig.hips,
    skirtGeometry({
      topY: 0.055,
      bottomY: -0.72,
      topRadius: [0.285, 0.225],
      bottomRadius: [0.35, 0.285]
    }),
    materials.stone,
    "hiro_stone_under_robe"
  );

  // Navy over-robe wraps the sides and back but leaves a real opening at the
  // front. This is deliberately geometry, not a color gradient, so the stone
  // garment remains legible under every light and camera distance.
  const frontGap = 0.58;
  add(
    rig.hips,
    skirtGeometry({
      topY: 0.065,
      bottomY: -0.565,
      topRadius: [0.325, 0.255],
      bottomRadius: [0.405, 0.315],
      startAngle: -Math.PI / 2 + frontGap,
      endAngle: (Math.PI * 3) / 2 - frontGap,
      segments: 26
    }),
    materials.navy,
    "hiro_navy_open_over_robe"
  );
  const overRobeStart = -Math.PI / 2 + frontGap;
  const overRobeEnd = (Math.PI * 3) / 2 - frontGap;
  for (const [side, angle] of [
    ["R", overRobeStart],
    ["L", overRobeEnd]
  ] as const) {
    const edge = new THREE.LineCurve3(
      new THREE.Vector3(Math.cos(angle) * 0.329, 0.066, Math.sin(angle) * 0.259),
      new THREE.Vector3(Math.cos(angle) * 0.409, -0.568, Math.sin(angle) * 0.319)
    );
    add(
      rig.hips,
      new THREE.TubeGeometry(edge, 5, 0.011, 6, false),
      materials.ivory,
      `hiro_over_robe_opening_trim_${side}`
    );
  }
  const hemPoints: THREE.Vector3[] = [];
  for (let index = 0; index <= 28; index++) {
    const angle = THREE.MathUtils.lerp(overRobeStart, overRobeEnd, index / 28);
    hemPoints.push(new THREE.Vector3(Math.cos(angle) * 0.409, -0.568, Math.sin(angle) * 0.319));
  }
  add(
    rig.hips,
    new THREE.TubeGeometry(new THREE.CatmullRomCurve3(hemPoints), 32, 0.011, 6, false),
    materials.ivory,
    "hiro_over_robe_hem_trim"
  );

  // The central armor-like apron and crisp ivory piping are the most readable
  // White Lotus cues in the supplied reference.
  const apronPoints: readonly Point2[] = [
    [-0.205, 0.035],
    [0.205, 0.035],
    [0.19, -0.53],
    [-0.19, -0.53]
  ];
  add(rig.hips, panelGeometry(apronPoints, -0.292), materials.navyLift, "hiro_navy_front_apron");
  add(rig.hips, ribbonGeometry(apronPoints[0], apronPoints[3], 0.026, -0.299), materials.ivory, "hiro_apron_trim_left");
  add(rig.hips, ribbonGeometry(apronPoints[1], apronPoints[2], 0.026, -0.299), materials.ivory, "hiro_apron_trim_right");
  add(rig.hips, ribbonGeometry(apronPoints[3], apronPoints[2], 0.026, -0.299), materials.ivory, "hiro_apron_trim_bottom");
  for (const side of [-1, 1] as const) {
    add(
      rig.hips,
      ribbonGeometry([side * 0.12, -0.54], [side * 0.15, -0.705], 0.014, -0.292),
      materials.stoneShade,
      `hiro_under_robe_fold_${side < 0 ? "R" : "L"}`
    );
  }

  // Long navy cape tails sit behind the articulated sleeves. They create the
  // reference's dark shoulder-to-hip sweep without constraining arm poses.
  for (const side of [-1, 1] as const) {
    const cape = panelGeometry(
      [
        [side * 0.15, 0.32],
        [side * 0.335, 0.29],
        [side * 0.39, -0.05],
        [side * 0.355, -0.29],
        [side * 0.24, -0.245]
      ],
      0.07
    );
    add(rig.torso, cape, materials.navy, `hiro_navy_cape_tail_${side < 0 ? "R" : "L"}`);
  }

  // A clean navy chest panel hides the stock block seams. Paired ivory lapels
  // make the V-shaped wrap visible beneath the mantle and above the obi.
  add(
    rig.torso,
    panelGeometry(
      [
        [-0.205, 0.395],
        [0.205, 0.395],
        [0.235, -0.015],
        [-0.235, -0.015]
      ],
      -0.158
    ),
    materials.navy,
    "hiro_navy_tunic_front"
  );
  add(rig.torso, ribbonGeometry([-0.04, 0.405], [-0.19, 0.015], 0.027, -0.169), materials.ivory, "hiro_lapel_left");
  add(rig.torso, ribbonGeometry([0.04, 0.405], [0.19, 0.015], 0.027, -0.169), materials.ivory, "hiro_lapel_right");

  // Navy upper sleeves beneath pale, flared fore-sleeves reproduce the split
  // seen in the reference instead of turning both arms into one white poncho.
  const upperSleeveGeometry = new THREE.CylinderGeometry(0.13, 0.16, 0.34, 12, 2, true);
  geometries.push(upperSleeveGeometry);
  const bellSleeveGeometry = new THREE.CylinderGeometry(0.115, 0.18, 0.32, 12, 2, true);
  geometries.push(bellSleeveGeometry);
  const cuffGeometry = new THREE.CylinderGeometry(0.183, 0.183, 0.028, 12, 1, true);
  geometries.push(cuffGeometry);
  for (const [side, upperArm, forearm] of [
    ["L", rig.armL, rig.foreL],
    ["R", rig.armR, rig.foreR]
  ] as const) {
    const upper = new THREE.Mesh(upperSleeveGeometry, materials.navy);
    upper.name = `hiro_navy_upper_sleeve_${side}`;
    upper.position.y = -0.145;
    upper.castShadow = true;
    upper.receiveShadow = true;
    enableShadowLayer(upper, SHADOW_LAYERS.HERO_DYNAMIC);
    upperArm.add(upper);
    meshes.push(upper);

    const bell = new THREE.Mesh(bellSleeveGeometry, materials.stone);
    bell.name = `hiro_stone_bell_sleeve_${side}`;
    bell.position.y = -0.115;
    bell.castShadow = true;
    bell.receiveShadow = true;
    enableShadowLayer(bell, SHADOW_LAYERS.HERO_DYNAMIC);
    forearm.add(bell);
    meshes.push(bell);

    const cuff = new THREE.Mesh(cuffGeometry, materials.stoneShade);
    cuff.name = `hiro_bell_sleeve_cuff_${side}`;
    cuff.position.y = -0.274;
    cuff.castShadow = true;
    cuff.receiveShadow = true;
    enableShadowLayer(cuff, SHADOW_LAYERS.HERO_DYNAMIC);
    forearm.add(cuff);
    meshes.push(cuff);
  }

  // Broad ivory yoke, darker outer binding and raised inner collar. The layers
  // are separated by a few millimetres to avoid coplanar shimmer under WebGPU.
  const mantle = add(rig.torso, mantleGeometry(), materials.mantle, "hiro_white_lotus_mantle");
  mantle.position.z = -0.03;
  const mantleBinding = add(rig.torso, mantleGeometry(0.89, 1), materials.mantleShade, "hiro_mantle_outer_binding");
  mantleBinding.position.y = -0.004;
  mantleBinding.position.z = -0.03;
  const collar = add(
    rig.torso,
    new THREE.TorusGeometry(0.145, 0.022, 7, 24),
    materials.mantleShade,
    "hiro_raised_inner_collar",
    [0, 0.445, 0]
  );
  collar.rotation.x = Math.PI / 2;
  collar.scale.y = 0.78;

  // A flatter, snugger obi replaces the old oversized circular ring. The
  // folded front face and bow remain visible even when both hands hold the cup.
  const obi = add(
    rig.hips,
    new THREE.CylinderGeometry(0.342, 0.342, 0.145, 20),
    materials.ivoryShade,
    "hiro_wide_obi",
    [0, 0.035, 0]
  );
  obi.scale.z = 0.78;
  add(rig.hips, new THREE.BoxGeometry(0.54, 0.088, 0.028), materials.stoneShade, "hiro_obi_front_fold", [0, 0.035, -0.275]);
  add(rig.hips, new THREE.SphereGeometry(0.035, 8, 6), materials.ivory, "hiro_obi_knot", [0, 0.035, -0.306]);
  for (const side of [-1, 1] as const) {
    const bow = add(
      rig.hips,
      panelGeometry(
        [
          [0, 0.025],
          [side * 0.125, 0.075],
          [side * 0.115, -0.035]
        ],
        -0.309
      ),
      materials.ivory,
      `hiro_obi_bow_${side < 0 ? "R" : "L"}`
    );
    bow.position.y = 0.035;
  }

  // Navy slippers with ivory soles already come from the shared rig. Add one
  // bold instep strap per foot so they do not disappear beneath the robe hem.
  for (const [side, shin] of [
    ["L", rig.shinL],
    ["R", rig.shinR]
  ] as const) {
    const strap = add(
      shin,
      new THREE.BoxGeometry(0.028, 0.022, 0.21),
      materials.ivory,
      `hiro_slipper_strap_${side}`,
      [0, -0.31, -0.075]
    );
    strap.rotation.x = -0.12;
  }

  return {
    // The authored pieces follow their owning joints. Cloth dynamics can be
    // layered back in later without changing this visual hierarchy.
    update() {},
    dispose() {
      for (const mesh of meshes) mesh.removeFromParent();
      for (const geometry of new Set(geometries)) geometry.dispose();
      for (const material of Object.values(materials)) material.dispose();
    }
  };
}
