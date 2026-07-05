import * as THREE from "three/webgpu";
import { waterHeight, type WorldMap } from "../world/heightmap";
import { buildBoatMesh, buildSpeedboatMesh, type BoatSailRig } from "../vehicles/boat";

/**
 * The sea half of the "-" spectacle: a flotilla of sailboats and faster
 * speedboats streams through the strait *underneath* the Golden Gate deck when
 * you set it off from the bridge. Purely kinematic (meshes on rails, seated on
 * the live water surface) — they cross perpendicular to the span, spaced along
 * it and staggered in time, then despawn once clear on the far side.
 *
 * The crossing is centred a little *ahead* of you along the deck (projected onto
 * the tower-to-tower line) so from a truck mid-span the boats sweep across the
 * water below the roadway right where you're looking.
 */
const PARADE_TUNING = {
  sailboats: 5,
  speedboats: 4,
  triggerRange: 1500, // only fires when this near the mid-span
  crossHalf: 340, // half the E–W crossing run (boats travel 2× this)
  aheadOnSpan: 130, // shift the crossing this far ahead of you along the deck
  spanSpacing: 48, // gap between boats spread along the span
  sailSpeed: 8, // m/s
  speedSpeed: 18, // m/s — noticeably quicker than the sailboats
  scale: 1.4, // size bump so they read from up on the deck
  seat: 0.32, // metres the hull origin rides over the water surface
  maxLife: 130,
  maxBoats: 26
};

type ParadeBoat = {
  mesh: THREE.Group;
  pos: THREE.Vector3; // XZ drives motion; Y reseated on the swell each frame
  dir: THREE.Vector3; // horizontal travel unit
  yaw: number;
  speed: number;
  travelled: number;
  crossLen: number;
  life: number;
  heelPhase: number;
  sail?: BoatSailRig;
};

const TMP = { euler: new THREE.Euler(0, 0, 0, "YXZ") };

function reveal(root: THREE.Group) {
  root.userData.embodimentVisible = true;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) o.visible = true;
  });
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    const mat = m.material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

export class BridgeParade {
  #scene: THREE.Scene;
  #map: WorldMap;
  #boats: ParadeBoat[] = [];
  #time = 0;

  constructor(scene: THREE.Scene, map: WorldMap) {
    this.#scene = scene;
    this.#map = map;
  }

  get count(): number {
    return this.#boats.length;
  }

  /**
   * Send boats under the Golden Gate if the player is near it. `playerFwd` only
   * biases which way along the span the crossing is centred. Returns true if a
   * flotilla launched (false = not near the bridge).
   */
  trigger(playerPos: THREE.Vector3, playerFwd: THREE.Vector3): boolean {
    const bridge = this.#map.meta.bridges?.[0];
    if (!bridge?.towers || bridge.towers.length < 2) return false;
    const t = PARADE_TUNING;
    const [t1, t2] = bridge.towers;
    const a = new THREE.Vector3(t1[0], 0, t1[1]);
    const b = new THREE.Vector3(t2[0], 0, t2[1]);

    // closest point on the tower-to-tower segment to the player, then nudged
    // ahead along the deck so the crossing sits where the player is looking
    const ab = new THREE.Vector3().subVectors(b, a);
    const spanLen = ab.length();
    const deck = ab.clone().normalize();
    const flat = new THREE.Vector3(playerPos.x, 0, playerPos.z);
    let s = THREE.MathUtils.clamp(flat.clone().sub(a).dot(deck), 0, spanLen);
    if (Math.hypot(flat.x - (a.x + deck.x * s), flat.z - (a.z + deck.z * s)) > t.triggerRange) return false;
    const fwdOnDeck = playerFwd.x * deck.x + playerFwd.z * deck.z;
    s = THREE.MathUtils.clamp(s + Math.sign(fwdOnDeck || 1) * t.aheadOnSpan, 30, spanLen - 30);
    const center = new THREE.Vector3(a.x + deck.x * s, 0, a.z + deck.z * s);

    // travel perpendicular to the deck (across the strait)
    const perp = new THREE.Vector3(-deck.z, 0, deck.x).normalize();

    const launch = (kind: "sail" | "speed", i: number, n: number, speed: number) => {
      const side = i % 2 ? 1 : -1; // alternate east/west crossings
      const dir = perp.clone().multiplyScalar(side);
      const spanOff = (i - (n - 1) / 2) * t.spanSpacing + (Math.random() - 0.5) * 20;
      const start = center
        .clone()
        .addScaledVector(deck, spanOff)
        .addScaledVector(dir, -t.crossHalf);
      const mesh = kind === "sail" ? buildBoatMesh() : buildSpeedboatMesh();
      reveal(mesh);
      mesh.scale.setScalar(t.scale);
      this.#scene.add(mesh);
      const boat: ParadeBoat = {
        mesh,
        pos: start,
        dir,
        yaw: Math.atan2(-dir.x, -dir.z),
        speed: speed * (0.9 + Math.random() * 0.2),
        travelled: 0,
        crossLen: t.crossHalf * 2,
        life: 0,
        heelPhase: Math.random() * Math.PI * 2
      };
      if (kind === "sail") {
        const sail = mesh.userData.sail as BoatSailRig | undefined;
        if (sail) {
          // fill the canvas for a boat under way (idle luff would look becalmed)
          sail.flap.value = 0.12;
          sail.billow.value = 0.42;
          sail.boom.rotation.y = 0.25 * side;
          boat.sail = sail;
        }
      }
      this.#boats.push(boat);
    };

    for (let i = 0; i < t.sailboats; i++) launch("sail", i, t.sailboats, t.sailSpeed);
    for (let i = 0; i < t.speedboats; i++) launch("speed", i, t.speedboats, t.speedSpeed);
    while (this.#boats.length > t.maxBoats) this.#retire(0);
    return true;
  }

  update(dt: number) {
    this.#time += dt;
    const t = PARADE_TUNING;
    for (let i = this.#boats.length - 1; i >= 0; i--) {
      const boat = this.#boats[i];
      const d = boat.speed * dt;
      boat.pos.addScaledVector(boat.dir, d);
      boat.travelled += d;
      boat.life += dt;

      const wy = waterHeight(boat.pos.x, boat.pos.z, this.#time);
      boat.mesh.position.set(boat.pos.x, wy + t.seat, boat.pos.z);
      // gentle heel + bob so the hull works the swell
      const heel = Math.sin(boat.life * 0.8 + boat.heelPhase) * 0.06;
      const pitch = Math.sin(boat.life * 1.1 + boat.heelPhase) * 0.03;
      TMP.euler.set(pitch, boat.yaw, heel);
      boat.mesh.quaternion.setFromEuler(TMP.euler);
      if (boat.sail) boat.sail.heel.rotation.z = heel * 0.8;

      if (boat.travelled > boat.crossLen || boat.life > t.maxLife) this.#retire(i);
    }
  }

  #retire(i: number) {
    const boat = this.#boats[i];
    boat.mesh.removeFromParent();
    disposeObject(boat.mesh);
    this.#boats.splice(i, 1);
  }
}
