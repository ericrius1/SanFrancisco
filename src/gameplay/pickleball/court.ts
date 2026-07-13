import * as THREE from "three/webgpu";
import { PICKLEBALL_COURT as C } from "./constants";
import { enableLocalShadowLayer } from "../../world/shadows/shadowLayers";

type Disposable = { dispose(): void };

function standard(color: number, roughness = 0.86): THREE.MeshStandardNodeMaterial {
  return new THREE.MeshStandardNodeMaterial({ color, roughness, metalness: 0 });
}

function basic(color: number): THREE.MeshBasicNodeMaterial {
  return new THREE.MeshBasicNodeMaterial({ color });
}

/** Procedural regulation court, apron, linework, net, tape, and posts. */
export class PickleballCourtView {
  readonly group = new THREE.Group();

  #owned: Disposable[] = [];

  constructor() {
    this.group.name = "pickleball-court";
    this.#buildSurface();
    this.#buildNet();
  }

  /** The sagging regulation net height at a court-local X coordinate. */
  netHeightAt(x: number): number {
    const t = THREE.MathUtils.clamp(Math.abs(x) / C.halfWidth, 0, 1);
    return THREE.MathUtils.lerp(C.netCentreHeight, C.netSidelineHeight, t * t);
  }

  dispose(): void {
    for (const item of this.#owned) item.dispose();
    this.#owned.length = 0;
    this.group.removeFromParent();
  }

  #mesh(geometry: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
    this.#owned.push(geometry);
    if (!this.#owned.includes(material)) this.#owned.push(material);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  #buildSurface(): void {
    const apronMaterial = standard(0x315d4d, 0.98);
    const courtMaterial = standard(0x356d91, 0.91);
    const kitchenMaterial = standard(0x467c9b, 0.91);
    const lineMaterial = basic(0xf5efe1);

    const apron = this.#mesh(new THREE.BoxGeometry(C.apronWidth, 0.1, C.apronLength), apronMaterial);
    apron.name = "pickleball-apron";
    apron.position.y = -0.055;

    const surface = this.#mesh(new THREE.BoxGeometry(C.width, 0.018, C.length), courtMaterial);
    surface.name = "pickleball-playing-surface";
    surface.position.y = 0.004;

    const kitchen = this.#mesh(
      new THREE.BoxGeometry(C.width - C.lineWidth * 2, 0.006, C.nonVolleyLine * 2 - C.lineWidth),
      kitchenMaterial
    );
    kitchen.name = "pickleball-non-volley-zone";
    kitchen.position.y = 0.017;

    const lineY = 0.024;
    const addLine = (name: string, width: number, length: number, x: number, z: number) => {
      const line = this.#mesh(new THREE.BoxGeometry(width, 0.012, length), lineMaterial);
      line.name = name;
      line.position.set(x, lineY, z);
      return line;
    };

    addLine("pickleball-line-left", C.lineWidth, C.length, -C.halfWidth + C.lineWidth / 2, 0);
    addLine("pickleball-line-right", C.lineWidth, C.length, C.halfWidth - C.lineWidth / 2, 0);
    addLine("pickleball-line-near-baseline", C.width, C.lineWidth, 0, -C.halfLength + C.lineWidth / 2);
    addLine("pickleball-line-far-baseline", C.width, C.lineWidth, 0, C.halfLength - C.lineWidth / 2);
    // The seven-foot NVZ measurement lands on the line's outside edge.
    const kitchenLineCentre = C.nonVolleyLine - C.lineWidth / 2;
    addLine("pickleball-line-near-kitchen", C.width, C.lineWidth, 0, -kitchenLineCentre);
    addLine("pickleball-line-far-kitchen", C.width, C.lineWidth, 0, kitchenLineCentre);

    const centreLength = C.halfLength - C.nonVolleyLine;
    addLine(
      "pickleball-line-near-centre",
      C.lineWidth,
      centreLength,
      0,
      -(C.nonVolleyLine + centreLength / 2)
    );
    addLine(
      "pickleball-line-far-centre",
      C.lineWidth,
      centreLength,
      0,
      C.nonVolleyLine + centreLength / 2
    );

    // Tiny centre marks aid serving-side readability without changing play.
    addLine("pickleball-centre-mark-near", 0.2, C.lineWidth, 0, -C.halfLength - 0.08);
    addLine("pickleball-centre-mark-far", 0.2, C.lineWidth, 0, C.halfLength + 0.08);
  }

  #buildNet(): void {
    const postMaterial = standard(0x2b3031, 0.42);
    postMaterial.metalness = 0.52;
    const tapeMaterial = standard(0xf0eee5, 0.72);
    const netMaterial = new THREE.MeshBasicNodeMaterial({
      color: 0x17201d,
      transparent: true,
      opacity: 0.5,
      wireframe: true,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    this.#owned.push(postMaterial, tapeMaterial, netMaterial);

    const postRadius = 0.035; // below the 3-in / 76.2-mm maximum diameter
    const postGeometry = new THREE.CylinderGeometry(postRadius, postRadius, C.netSidelineHeight + 0.12, 12);
    this.#owned.push(postGeometry);
    // C.netPostX is the half inside-to-inside distance; move the post centres
    // outward by their radius so the clear gap remains exactly 22 ft.
    for (const x of [-(C.netPostX + postRadius), C.netPostX + postRadius]) {
      const post = new THREE.Mesh(postGeometry, postMaterial);
      post.name = "pickleball-net-post";
      post.position.set(x, (C.netSidelineHeight + 0.12) / 2, 0);
      post.castShadow = true;
      enableLocalShadowLayer(post);
      this.group.add(post);
    }

    // A lightly transparent wireframe plane reads as woven mesh at game scale.
    const netGeometry = new THREE.PlaneGeometry(C.netPostX * 2, C.netCentreHeight, 26, 7);
    this.#owned.push(netGeometry);
    const net = new THREE.Mesh(netGeometry, netMaterial);
    net.name = "pickleball-net-mesh";
    net.position.y = C.netCentreHeight / 2;
    net.castShadow = true;
    enableLocalShadowLayer(net);
    this.group.add(net);

    // Segmented top tape follows the 34-in centre / 36-in sideline sag.
    const segments = 16;
    for (let i = 0; i < segments; i++) {
      const x0 = THREE.MathUtils.lerp(-C.netPostX, C.netPostX, i / segments);
      const x1 = THREE.MathUtils.lerp(-C.netPostX, C.netPostX, (i + 1) / segments);
      const mid = (x0 + x1) / 2;
      const h0 = this.netHeightAt(x0);
      const h1 = this.netHeightAt(x1);
      const length = Math.hypot(x1 - x0, h1 - h0);
      const tapeGeometry = new THREE.BoxGeometry(length + 0.008, 0.048, 0.04);
      this.#owned.push(tapeGeometry);
      const tape = new THREE.Mesh(tapeGeometry, tapeMaterial);
      tape.name = "pickleball-net-tape";
      tape.position.set(mid, (h0 + h1) / 2, 0);
      tape.rotation.z = Math.atan2(h1 - h0, x1 - x0);
      tape.castShadow = true;
      enableLocalShadowLayer(tape);
      this.group.add(tape);
    }
  }
}
