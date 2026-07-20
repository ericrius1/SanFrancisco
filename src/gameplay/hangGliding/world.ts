import * as THREE from "three/webgpu";
import type { HangGlidingCourse } from "./layout";

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);

function tubeBetween(
  parent: THREE.Object3D,
  material: THREE.Material,
  a: THREE.Vector3,
  b: THREE.Vector3,
  radius: number,
  segments = 7
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), segments),
    material
  );
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
  parent.add(mesh);
  return mesh;
}

export class HangGlidingWorldVisuals {
  readonly root = new THREE.Group();
  readonly courseRoot = new THREE.Group();
  readonly promptAnchor = new THREE.Vector3();
  readonly liftAnchor = new THREE.Vector3();

  #course: HangGlidingCourse;
  #marker = new THREE.Group();
  #liftMarker = new THREE.Group();
  #markerHalo!: THREE.Mesh;
  #windsock = new THREE.Group();
  #gateGroups: THREE.Group[] = [];
  #gateMaterials: THREE.MeshStandardMaterial[] = [];
  #thermalGroups: THREE.Group[] = [];
  #landingPulse!: THREE.Mesh;
  #materials: THREE.Material[] = [];

  constructor(course: HangGlidingCourse) {
    this.#course = course;
    this.root.name = "hang_gliding_site";
    this.courseRoot.name = "hang_gliding_course";
    this.root.add(this.courseRoot);
    this.#buildLaunchDeck();
    this.#buildCourse();
    this.courseRoot.visible = false;
  }

  setCourseVisible(visible: boolean): void {
    this.courseRoot.visible = visible;
  }

  resetCourse(): void {
    for (let i = 0; i < this.#gateGroups.length; i++) {
      this.#gateGroups[i].visible = true;
      this.#gateMaterials[i].color.setHex(i === 0 ? 0xffcf55 : 0xf6eee0);
      this.#gateMaterials[i].emissive.setHex(i === 0 ? 0xff9a3d : 0x254b51);
      this.#gateMaterials[i].emissiveIntensity = i === 0 ? 2.4 : 0.5;
    }
  }

  completeGate(index: number): void {
    const group = this.#gateGroups[index];
    const material = this.#gateMaterials[index];
    if (!group || !material) return;
    material.color.setHex(0x7de0c4);
    material.emissive.setHex(0x2ac99a);
    material.emissiveIntensity = 2.8;
    group.scale.setScalar(1.08);
    const next = index + 1;
    if (this.#gateMaterials[next]) {
      this.#gateMaterials[next].color.setHex(0xffcf55);
      this.#gateMaterials[next].emissive.setHex(0xff9a3d);
      this.#gateMaterials[next].emissiveIntensity = 2.4;
    }
  }

  update(time: number, activeGate: number): void {
    this.#marker.rotation.y = time * 0.72;
    this.#liftMarker.rotation.y = -time * 0.58;
    this.#markerHalo.scale.setScalar(1 + Math.sin(time * 2.2) * 0.08);
    this.#windsock.rotation.y = Math.sin(time * 0.42) * 0.12;
    for (let i = 0; i < this.#gateGroups.length; i++) {
      const gate = this.#gateGroups[i];
      gate.rotation.z = Math.sin(time * 0.55 + i) * 0.025;
      if (i === activeGate) {
        const pulse = 1 + Math.sin(time * 3.1) * 0.055;
        gate.scale.setScalar(pulse);
      } else if (i > activeGate) {
        gate.scale.setScalar(1);
      }
    }
    for (let i = 0; i < this.#thermalGroups.length; i++) {
      const thermal = this.#thermalGroups[i];
      thermal.rotation.y = time * (i === 0 ? 0.18 : -0.16);
      thermal.position.y = Math.sin(time * 0.65 + i) * 1.2;
    }
    const landingPulse = 1 + Math.sin(time * 2.5) * 0.06;
    this.#landingPulse.scale.setScalar(landingPulse);
  }

  dispose(): void {
    this.root.traverse((object) => {
      if (object instanceof THREE.Mesh) object.geometry.dispose();
    });
    for (const material of new Set(this.#materials)) material.dispose();
    this.root.removeFromParent();
  }

  #material<T extends THREE.Material>(material: T): T {
    this.#materials.push(material);
    return material;
  }

  #buildLaunchDeck(): void {
    const deck = this.#course.deck;
    const steel = this.#material(new THREE.MeshStandardMaterial({
      color: 0x68777b,
      roughness: 0.46,
      metalness: 0.64
    }));
    const safety = this.#material(new THREE.MeshStandardMaterial({
      color: 0xe8aa3f,
      roughness: 0.58,
      metalness: 0.3
    }));
    const dark = this.#material(new THREE.MeshStandardMaterial({
      color: 0x242d31,
      roughness: 0.7,
      metalness: 0.34
    }));
    const beacon = this.#material(new THREE.MeshStandardMaterial({
      color: 0xffc85e,
      emissive: 0xff8a32,
      emissiveIntensity: 2.8,
      roughness: 0.4
    }));

    const platform = new THREE.Mesh(
      new THREE.BoxGeometry(deck.hx * 2, deck.hy * 2, deck.hz * 2),
      steel
    );
    platform.position.set(deck.x, deck.y, deck.z);
    platform.castShadow = true;
    platform.receiveShadow = true;
    this.root.add(platform);

    // Westbound runway chevrons are geometry, not a texture request.
    for (let i = 0; i < 5; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.035, 0.32), safety);
      stripe.position.set(deck.x - 3 - i * 5.2, deck.y + deck.hy + 0.025, deck.z);
      stripe.rotation.y = i % 2 === 0 ? 0.42 : -0.42;
      this.root.add(stripe);
    }

    const railY = deck.y + 1.05;
    for (const z of [deck.z - deck.hz + 0.18, deck.z + deck.hz - 0.18]) {
      tubeBetween(
        this.root,
        safety,
        new THREE.Vector3(deck.x - deck.hx + 1.5, railY, z),
        new THREE.Vector3(deck.x + deck.hx, railY, z),
        0.07
      );
      for (let i = 0; i < 5; i++) {
        const x = deck.x - deck.hx + 2 + i * 7.2;
        tubeBetween(
          this.root,
          dark,
          new THREE.Vector3(x, deck.y + deck.hy, z),
          new THREE.Vector3(x, railY, z),
          0.055
        );
      }
    }

    const terminal = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.4, 0.8), dark);
    terminal.position.set(deck.x + 7.2, deck.y + 0.95, deck.z);
    terminal.castShadow = true;
    this.root.add(terminal);
    const terminalLamp = new THREE.Mesh(new THREE.SphereGeometry(0.18, 12, 8), beacon);
    terminalLamp.position.set(deck.x + 7.2, deck.y + 1.65, deck.z - 0.42);
    this.root.add(terminalLamp);

    this.promptAnchor.set(deck.x - 7.5, deck.y + 2.2, deck.z);
    this.#marker.position.copy(this.promptAnchor);
    const markerMat = this.#material(new THREE.MeshBasicMaterial({
      color: 0xffd36b,
      transparent: true,
      opacity: 0.86,
      depthWrite: false
    }));
    this.#markerHalo = new THREE.Mesh(new THREE.TorusGeometry(1.25, 0.085, 8, 32), markerMat);
    this.#markerHalo.rotation.x = Math.PI / 2;
    this.#marker.add(this.#markerHalo);
    const markerCore = new THREE.Mesh(new THREE.OctahedronGeometry(0.36, 0), markerMat);
    markerCore.position.y = 0.15;
    this.#marker.add(markerCore);
    this.root.add(this.#marker);

    // Ground-level call point beside the existing Sutro Tower landmark. The
    // quest remains on the upper deck; this simply makes that deck reachable
    // from the normal map arrival without a precision aircraft dismount.
    const access = this.#course.access;
    const liftPost = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.8, 0.7), dark);
    liftPost.position.set(access.x, access.y + 0.9, access.z);
    liftPost.castShadow = true;
    this.root.add(liftPost);
    const liftLamp = new THREE.Mesh(new THREE.SphereGeometry(0.17, 12, 8), beacon);
    liftLamp.position.set(access.x, access.y + 1.62, access.z - 0.38);
    this.root.add(liftLamp);
    this.liftAnchor.set(access.x, access.y + 1.45, access.z);
    this.#liftMarker.position.copy(this.liftAnchor).add(new THREE.Vector3(0, 0.1, 0));
    const liftHalo = new THREE.Mesh(new THREE.TorusGeometry(1.05, 0.075, 8, 28), markerMat);
    liftHalo.rotation.x = Math.PI / 2;
    this.#liftMarker.add(liftHalo);
    this.root.add(this.#liftMarker);

    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 3.4, 7), dark);
    mast.position.set(deck.x + 4, deck.y + 1.75, deck.z - 3.6);
    this.root.add(mast);
    const sockMat = this.#material(new THREE.MeshStandardMaterial({
      color: 0xe65b46,
      emissive: 0x6a140b,
      emissiveIntensity: 0.28,
      side: THREE.DoubleSide,
      roughness: 0.86
    }));
    const sock = new THREE.Mesh(new THREE.ConeGeometry(0.34, 2.25, 10, 1, true), sockMat);
    sock.rotation.z = -Math.PI / 2;
    sock.position.x = -0.95;
    this.#windsock.position.set(deck.x + 4, deck.y + 3.25, deck.z - 3.6);
    this.#windsock.add(sock);
    this.root.add(this.#windsock);
  }

  #buildCourse(): void {
    const gates = this.#course.gates;
    for (let i = 0; i < gates.length; i++) {
      const gate = gates[i];
      const previous = i === 0 ? this.#course.launch : gates[i - 1];
      const next = i === gates.length - 1 ? this.#course.landing : gates[i + 1];
      const normal = new THREE.Vector3(next.x - previous.x, next.y - previous.y, next.z - previous.z).normalize();
      const material = this.#material(new THREE.MeshStandardMaterial({
        color: i === 0 ? 0xffcf55 : 0xf6eee0,
        emissive: i === 0 ? 0xff9a3d : 0x254b51,
        emissiveIntensity: i === 0 ? 2.4 : 0.5,
        roughness: 0.36,
        metalness: 0.18
      }));
      const group = new THREE.Group();
      group.position.set(gate.x, gate.y, gate.z);
      group.quaternion.setFromUnitVectors(FORWARD, normal);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(gate.radius, 0.72, 8, 52), material);
      ring.castShadow = false;
      group.add(ring);
      for (let tick = 0; tick < 12; tick++) {
        const angle = (tick / 12) * Math.PI * 2;
        const mark = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.7, 0.18), material);
        mark.position.set(Math.cos(angle) * gate.radius, Math.sin(angle) * gate.radius, 0);
        mark.rotation.z = angle;
        group.add(mark);
      }
      this.#gateGroups.push(group);
      this.#gateMaterials.push(material);
      this.courseRoot.add(group);
    }

    for (const thermal of this.#course.thermals) {
      const group = new THREE.Group();
      group.position.set(thermal.x, 0, thermal.z);
      const material = this.#material(new THREE.MeshBasicMaterial({
        color: 0xf6b54b,
        transparent: true,
        opacity: 0.24,
        depthWrite: false,
        side: THREE.DoubleSide
      }));
      for (let i = 0; i < 9; i++) {
        const t = i / 8;
        const radius = thermal.radius * (0.24 + t * 0.16);
        const hoop = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.42, 5, 36), material);
        hoop.rotation.x = Math.PI / 2;
        hoop.position.y = THREE.MathUtils.lerp(thermal.baseY, thermal.topY, t);
        hoop.rotation.z = i * 0.52;
        group.add(hoop);
      }
      this.#thermalGroups.push(group);
      this.courseRoot.add(group);
    }

    const landing = this.#course.landing;
    const landingGroup = new THREE.Group();
    landingGroup.position.set(landing.x, landing.y, landing.z);
    const landingMaterials = [
      this.#material(new THREE.MeshBasicMaterial({ color: 0xf3d16f, transparent: true, opacity: 0.78, side: THREE.DoubleSide })),
      this.#material(new THREE.MeshBasicMaterial({ color: 0xe65a45, transparent: true, opacity: 0.82, side: THREE.DoubleSide })),
      this.#material(new THREE.MeshBasicMaterial({ color: 0x2b8d82, transparent: true, opacity: 0.86, side: THREE.DoubleSide }))
    ];
    const radii = [landing.radius, landing.radius * 0.62, landing.radius * 0.26];
    for (let i = 0; i < radii.length; i++) {
      const disc = new THREE.Mesh(new THREE.RingGeometry(radii[i] - 1.7, radii[i], 64), landingMaterials[i]);
      disc.rotation.x = -Math.PI / 2;
      disc.position.y = 0.05 + i * 0.012;
      landingGroup.add(disc);
      if (i === 1) this.#landingPulse = disc;
    }
    this.courseRoot.add(landingGroup);
  }
}
