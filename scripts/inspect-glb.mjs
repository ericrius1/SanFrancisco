import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import fs from "node:fs";

const buf = fs.readFileSync(process.argv[2]);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
new GLTFLoader().parse(ab, "", (gltf) => {
  const scene = gltf.scene;
  scene.updateMatrixWorld(true);
  const want = new Set([
    "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2",
    "mixamorig:Neck", "mixamorig:Head", "mixamorig:HeadTop_End",
    "mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand",
    "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand",
    "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot", "mixamorig:LeftToeBase",
    "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot"
  ]);
  const box = new THREE.Box3();
  const p = new THREE.Vector3();
  const byName = {};
  scene.traverse((o) => {
    byName[o.name] = o;
    if (o.isBone) {
      o.getWorldPosition(p);
      box.expandByPoint(p);
    }
  });
  console.log("bbox min", box.min.toArray().map((n) => n.toFixed(2)), "max", box.max.toArray().map((n) => n.toFixed(2)));
  console.log("height(Y):", (box.max.y - box.min.y).toFixed(3), "  hips world:", byName["mixamorig:Hips"]?.getWorldPosition(new THREE.Vector3()).toArray().map((n) => n.toFixed(3)));
  console.log("\n-- child local offset (parent frame) & world pos for key bones --");
  for (const n of want) {
    const b = byName[n];
    if (!b) { console.log(n, "MISSING"); continue; }
    const wp = b.getWorldPosition(new THREE.Vector3());
    console.log(n.padEnd(24), "local", b.position.toArray().map((x) => x.toFixed(2)).join(","), " world", wp.toArray().map((x) => x.toFixed(2)).join(","), " parent:", b.parent?.name);
  }
  console.log("\nclip:", gltf.animations[0]?.name, gltf.animations[0]?.duration.toFixed(2) + "s");
});
