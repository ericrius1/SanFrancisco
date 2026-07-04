// One-shot: convert a Mixamo motion-only FBX (skeleton + 1 clip, no mesh) into a
// GLB the app can load with GLTFLoader. Usage: node scripts/fbx-to-glb.mjs <in.fbx> <out.glb>
import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import fs from "node:fs";

// GLTFExporter reads its binary Blob via FileReader (browser API). Shim it on Node.
if (typeof globalThis.FileReader === "undefined") {
  globalThis.FileReader = class {
    result = null;
    onloadend = null;
    onerror = null;
    readAsArrayBuffer(blob) {
      blob
        .arrayBuffer()
        .then((ab) => {
          this.result = ab;
          this.onloadend?.();
        })
        .catch((e) => this.onerror?.(e));
    }
    readAsDataURL(blob) {
      blob
        .arrayBuffer()
        .then((ab) => {
          this.result = `data:${blob.type || "application/octet-stream"};base64,${Buffer.from(ab).toString("base64")}`;
          this.onloadend?.();
        })
        .catch((e) => this.onerror?.(e));
    }
  };
}

const [, , inPath, outPath] = process.argv;
if (!inPath || !outPath) {
  console.error("usage: node scripts/fbx-to-glb.mjs <in.fbx> <out.glb>");
  process.exit(1);
}

const buf = fs.readFileSync(inPath);
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

const obj = new FBXLoader().parse(ab, "");
obj.updateMatrixWorld(true);

const clips = obj.animations ?? [];
console.log("root:", obj.name || "(unnamed)", "children:", obj.children.length);
let bones = 0;
obj.traverse((o) => {
  if (o.isBone) bones++;
});
console.log("bones:", bones, "clips:", clips.map((c) => `${c.name} (${c.duration.toFixed(2)}s, ${c.tracks.length} tracks)`));

new GLTFExporter().parse(
  obj,
  (result) => {
    const out = Buffer.from(result);
    fs.writeFileSync(outPath, out);
    console.log(`wrote ${outPath} (${(out.length / 1024).toFixed(0)} KB)`);
  },
  (err) => {
    console.error("export failed:", err);
    process.exit(1);
  },
  { binary: true, animations: clips, onlyVisible: false }
);
