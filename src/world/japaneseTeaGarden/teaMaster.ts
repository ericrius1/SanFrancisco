import * as THREE from "three/webgpu";
import { buildRig, poseIdle, poseWalk, setRigClasp, type Rig } from "../../player/rig";

export type TeaMasterAction = "idle" | "welcome" | "serve" | "walk" | "talk" | "point";

export type TeaMasterVisual = {
  group: THREE.Group;
  dialogueAnchor: THREE.Object3D;
  cupAnchor: THREE.Object3D;
  setAction(action: TeaMasterAction): void;
  update(dt: number, time: number, lookTarget?: { x: number; y?: number; z: number }): void;
  dispose(): void;
};

const PALETTE = {
  mantle: 0xe8ece7,
  paleBlue: 0xc9d8df,
  indigo: 0x1b2d47,
  blueTrim: 0x315c78,
  hair: 0x6f8794,
  skin: 0xd7a17b,
  gold: 0xb9934d,
  shoe: 0x182436,
  tea: 0x7a4b20,
  cup: 0xd9c38c
} as const;

function alphaSurface<T extends THREE.Material>(value: T): T {
  value.transparent = true;
  value.depthWrite = false;
  return value;
}

function setRotation(group: THREE.Group, x: number, y: number, z: number): void {
  group.rotation.set(x, y, z);
}

function createTeaCup(geometries: THREE.BufferGeometry[], materials: THREE.Material[]): THREE.Group {
  const group = new THREE.Group();
  group.name = "tea_master_cup";
  const ceramic = new THREE.MeshStandardMaterial({ color: PALETTE.cup, roughness: 0.72, metalness: 0 });
  const tea = new THREE.MeshStandardMaterial({ color: PALETTE.tea, roughness: 0.35, metalness: 0 });
  const steam = alphaSurface(new THREE.MeshBasicMaterial({ color: 0xf3f6ee, opacity: 0.52 }));
  materials.push(ceramic, tea, steam);

  const bowlGeometry = new THREE.CylinderGeometry(0.11, 0.085, 0.105, 14, 1, true);
  const baseGeometry = new THREE.CylinderGeometry(0.075, 0.075, 0.025, 14);
  const teaGeometry = new THREE.CircleGeometry(0.096, 16);
  geometries.push(bowlGeometry, baseGeometry, teaGeometry);
  const bowl = new THREE.Mesh(bowlGeometry, ceramic);
  bowl.name = "tea_cup_bowl";
  bowl.castShadow = true;
  group.add(bowl);
  const base = new THREE.Mesh(baseGeometry, ceramic);
  base.name = "tea_cup_foot";
  base.position.y = -0.062;
  group.add(base);
  const surface = new THREE.Mesh(teaGeometry, tea);
  surface.name = "tea_surface";
  surface.rotation.x = -Math.PI / 2;
  surface.position.y = 0.053;
  group.add(surface);

  for (let i = 0; i < 3; i++) {
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3((i - 1) * 0.035, 0.07, 0),
      new THREE.Vector3((i - 1) * 0.045 + 0.025, 0.18, 0.01),
      new THREE.Vector3((i - 1) * 0.025 - 0.015, 0.29, -0.005),
      new THREE.Vector3((i - 1) * 0.04 + 0.02, 0.4, 0)
    ]);
    const geometry = new THREE.TubeGeometry(curve, 12, 0.006, 5, false);
    geometries.push(geometry);
    const wisp = new THREE.Mesh(geometry, steam);
    wisp.name = `tea_steam_${i}`;
    wisp.userData.phase = i * 2.1;
    group.add(wisp);
  }
  return group;
}

function hideStockFaceAndCostume(rig: Rig): void {
  for (const item of [...rig.avatar.allHair, ...rig.avatar.allHats, ...rig.avatar.allOutfits]) item.visible = false;
  for (const child of rig.head.children) {
    if (child instanceof THREE.Mesh && child.material === rig.avatar.materials.visor) child.visible = false;
  }
}

export function createTeaMasterVisual(): TeaMasterVisual {
  const rig = buildRig({ skin: 2, hair: "buzz", hat: "none", outfit: "jacket", color: 5, accent: 6 });
  hideStockFaceAndCostume(rig);
  rig.avatar.materials.skin.color.set(PALETTE.skin);
  rig.avatar.materials.jacket.color.set(PALETTE.indigo);
  rig.avatar.materials.sleeve.color.set(PALETTE.paleBlue);
  rig.avatar.materials.pants.color.set(PALETTE.indigo);
  rig.avatar.materials.shoe.color.set(PALETTE.shoe);
  rig.avatar.materials.hair.color.set(PALETTE.hair);
  rig.avatar.torsoBlock.scale.set(1.32, 1.06, 1.16);
  rig.avatar.hipBlock.scale.set(1.34, 1.05, 1.18);
  for (const arm of rig.avatar.armBlocks) arm.scale.set(1.12, 1.02, 1.12);

  const group = new THREE.Group();
  group.name = "tea_master_haru";
  group.scale.setScalar(1.12);
  rig.group.position.y = 0.9;
  group.add(rig.group);

  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const lambert = (color: number) => {
    const value = new THREE.MeshLambertMaterial({ color });
    materials.push(value);
    return value;
  };
  const skin = rig.avatar.materials.skin;
  const indigo = lambert(PALETTE.indigo);
  const mantle = lambert(PALETTE.mantle);
  const paleBlue = lambert(PALETTE.paleBlue);
  const blue = lambert(PALETTE.blueTrim);
  const hair = lambert(PALETTE.hair);
  const gold = lambert(PALETTE.gold);
  const ink = new THREE.MeshBasicMaterial({ color: 0x17212a });
  const amber = new THREE.MeshBasicMaterial({ color: 0x815c2d });
  const eyeWhite = new THREE.MeshBasicMaterial({ color: 0xf6eddd });
  materials.push(ink, amber, eyeWhite);

  const addMesh = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    mat: THREE.Material,
    position: readonly [number, number, number],
    name: string
  ) => {
    geometries.push(geometry);
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.name = name;
    mesh.position.set(position[0], position[1], position[2]);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // Bell-shaped indigo robe: visually roots him to the garden and hides the
  // stock trousers while keeping the walk joints available under the hem.
  const robe = addMesh(rig.hips, new THREE.CylinderGeometry(0.31, 0.55, 0.98, 12), indigo, [0, -0.42, 0], "tea_master_robe");
  robe.scale.z = 0.82;
  const robePanel = addMesh(rig.hips, new THREE.BoxGeometry(0.24, 0.82, 0.035), mantle, [0, -0.38, -0.47], "tea_master_robe_panel");
  robePanel.rotation.x = -0.05;
  const sash = addMesh(rig.hips, new THREE.CylinderGeometry(0.39, 0.39, 0.1, 12), blue, [0, 0.02, 0], "tea_master_sash");
  sash.scale.z = 0.86;

  // Broad white shoulder mantle with pale-blue underside and indigo piping.
  const mantleLower = addMesh(rig.torso, new THREE.CylinderGeometry(0.46, 0.64, 0.21, 12), paleBlue, [0, 0.37, 0], "tea_master_mantle_lining");
  mantleLower.scale.z = 0.78;
  const mantleTop = addMesh(rig.torso, new THREE.CylinderGeometry(0.42, 0.61, 0.17, 12), mantle, [0, 0.43, -0.01], "tea_master_white_mantle");
  mantleTop.scale.z = 0.8;
  const collar = addMesh(rig.torso, new THREE.TorusGeometry(0.25, 0.035, 6, 18, Math.PI), blue, [0, 0.43, -0.2], "tea_master_collar_trim");
  collar.rotation.z = Math.PI;

  // Bald crown, grey wing-like side hair, topknot, side beard and goatee.
  for (const side of [-1, 1]) {
    const sideHair = addMesh(
      rig.head,
      new THREE.DodecahedronGeometry(0.11, 0),
      hair,
      [side * 0.17, 0.2, 0.015],
      "tea_master_side_hair"
    );
    sideHair.scale.set(0.85, 1.55, 0.75);
    sideHair.rotation.z = side * 0.32;
    const whisker = addMesh(rig.head, new THREE.ConeGeometry(0.085, 0.22, 7), hair, [side * 0.1, 0.095, -0.105], "tea_master_beard_wing");
    whisker.rotation.z = side * 0.36;
  }
  const topknot = addMesh(rig.head, new THREE.SphereGeometry(0.09, 10, 7), hair, [0, 0.43, 0.02], "tea_master_topknot");
  topknot.scale.set(0.8, 1.1, 0.8);
  addMesh(rig.head, new THREE.CylinderGeometry(0.075, 0.07, 0.055, 10), gold, [0, 0.38, 0.02], "tea_master_topknot_band");
  const goatee = addMesh(rig.head, new THREE.ConeGeometry(0.075, 0.28, 8), hair, [0, 0.01, -0.145], "tea_master_goatee");
  goatee.rotation.z = Math.PI;

  // Welcoming face: bright eyes, warm pupils, soft brows, cheeks and a clear smile.
  for (const side of [-1, 1]) {
    const eye = addMesh(rig.head, new THREE.SphereGeometry(0.034, 10, 7), eyeWhite, [side * 0.065, 0.235, -0.142], "tea_master_eye");
    eye.scale.set(1.25, 0.72, 0.5);
    const pupil = addMesh(rig.head, new THREE.SphereGeometry(0.018, 8, 6), amber, [side * 0.064, 0.234, -0.164], "tea_master_pupil");
    pupil.scale.set(0.82, 0.92, 0.5);
    const brow = addMesh(rig.head, new THREE.BoxGeometry(0.07, 0.013, 0.012), hair, [side * 0.066, 0.29, -0.151], "tea_master_soft_brow");
    brow.rotation.z = side * 0.11;
    const cheek = addMesh(rig.head, new THREE.SphereGeometry(0.038, 8, 6), skin, [side * 0.095, 0.16, -0.146], "tea_master_cheek");
    cheek.scale.set(1.25, 0.58, 0.4);
  }
  const smile = addMesh(rig.head, new THREE.TorusGeometry(0.064, 0.009, 5, 16, Math.PI), ink, [0, 0.138, -0.16], "tea_master_smile");
  smile.rotation.z = Math.PI;
  const mouthOpen = addMesh(rig.head, new THREE.SphereGeometry(0.036, 10, 6), ink, [0, 0.12, -0.158], "tea_master_mouth_open");
  mouthOpen.scale.set(1.25, 0.62, 0.35);
  mouthOpen.visible = false;

  const cupAnchor = new THREE.Group();
  cupAnchor.name = "tea_master_cup_anchor";
  cupAnchor.position.set(0, 0.22, -0.48);
  rig.torso.add(cupAnchor);
  const cup = createTeaCup(geometries, materials);
  cupAnchor.add(cup);

  const dialogueAnchor = new THREE.Object3D();
  dialogueAnchor.name = "tea_master_dialogue_anchor";
  dialogueAnchor.position.set(0, 2.18, 0);
  group.add(dialogueAnchor);

  let action: TeaMasterAction = "idle";
  let actionTime = 0;
  const headTarget = new THREE.Vector3();
  const localTarget = new THREE.Vector3();

  const setAction = (next: TeaMasterAction) => {
    if (next === action) return;
    action = next;
    actionTime = 0;
  };

  const update = (dt: number, time: number, lookTarget?: { x: number; y?: number; z: number }) => {
    actionTime += dt;
    if (action === "walk") poseWalk(rig, time * 5.2, 0);
    else poseIdle(rig, time);
    setRigClasp(rig, "L", 0);
    setRigClasp(rig, "R", 0);

    if (action === "welcome") {
      setRotation(rig.armL, -0.25, 0, 1.05);
      setRotation(rig.foreL, 0.45, 0, 0);
      setRotation(rig.armR, 0.28, 0, -0.16);
      setRotation(rig.foreR, 0.78, 0, 0);
      rig.torso.rotation.x += Math.sin(Math.min(1, actionTime * 2.4) * Math.PI) * 0.08;
    } else if (action === "serve") {
      setRotation(rig.armL, 0.98, -0.18, 0.18);
      setRotation(rig.armR, 0.98, 0.18, -0.18);
      setRotation(rig.foreL, 0.78, 0.08, 0);
      setRotation(rig.foreR, 0.78, -0.08, 0);
      setRigClasp(rig, "L", 0.72);
      setRigClasp(rig, "R", 0.72);
    } else if (action === "talk") {
      const gesture = 0.55 + Math.sin(time * 1.35) * 0.12;
      setRotation(rig.armL, 0.2, 0, 0.72);
      setRotation(rig.foreL, gesture, 0, 0.08);
      setRotation(rig.armR, 0.4, 0, -0.2);
      setRotation(rig.foreR, 0.75, 0, 0);
    } else if (action === "point") {
      setRotation(rig.armL, 1.12, 0.08, 0.38);
      setRotation(rig.foreL, 0.12, 0, 0);
      setRotation(rig.armR, 0.35, 0, -0.18);
      setRotation(rig.foreR, 0.68, 0, 0);
    }

    // The cup remains visible as a quiet emblem; during walking it tucks nearer the sash.
    const servedZ = -0.54 - Math.sin(Math.min(1, actionTime * 1.5) * Math.PI * 0.5) * 0.08;
    const cupTargetZ = action === "serve" ? servedZ : action === "walk" ? -0.38 : -0.48;
    cupAnchor.position.z = THREE.MathUtils.damp(cupAnchor.position.z, cupTargetZ, 7, dt);
    cupAnchor.position.y = action === "walk" ? 0.1 : 0.22;
    cupAnchor.rotation.x = action === "walk" ? -0.2 : 0;
    cup.children.forEach((child) => {
      if (!child.name.startsWith("tea_steam")) return;
      const phase = Number(child.userData.phase ?? 0);
      child.position.x = Math.sin(time * 1.2 + phase) * 0.015;
      child.scale.y = 0.88 + Math.sin(time * 1.6 + phase) * 0.1;
    });

    const speaking = action === "talk" || action === "point";
    const mouthPulse = speaking && Math.sin(time * 8.4) > 0.2;
    mouthOpen.visible = mouthPulse;
    smile.visible = !mouthPulse;

    if (lookTarget) {
      headTarget.set(lookTarget.x, lookTarget.y ?? group.position.y + 1.55, lookTarget.z);
      localTarget.copy(headTarget);
      group.worldToLocal(localTarget);
      const desiredYaw = THREE.MathUtils.clamp(Math.atan2(-localTarget.x, -localTarget.z), -0.55, 0.55);
      const desiredPitch = THREE.MathUtils.clamp(Math.atan2(localTarget.y - 1.55, Math.hypot(localTarget.x, localTarget.z)), -0.28, 0.25);
      rig.head.rotation.y = THREE.MathUtils.damp(rig.head.rotation.y, desiredYaw, 4.2, dt);
      rig.head.rotation.x = THREE.MathUtils.damp(rig.head.rotation.x, desiredPitch, 4.2, dt);
    }
  };

  return {
    group,
    dialogueAnchor,
    cupAnchor,
    setAction,
    update,
    dispose() {
      for (const geometry of geometries) geometry.dispose();
      for (const value of materials) value.dispose();
      for (const value of Object.values(rig.avatar.materials)) value.dispose();
      group.removeFromParent();
    }
  };
}
