import * as THREE from "three/webgpu";
import { LIGHT_SCALE } from "../../config";
import { lightAnchor } from "../../player/lightPool";

// Hoverboard, front is local -Z: kicked deck, rider in a surf stance, and a
// glow rig underneath (it hovers on light, obviously). The strips are unlit
// emissive boxes; the point light is what actually lifts the rider out of the
// dark at night.
export function buildBoardMesh(): THREE.Group {
  const g = new THREE.Group();
  const deckMat = new THREE.MeshLambertMaterial({ color: 0xe8563f });
  const stripeMat = new THREE.MeshLambertMaterial({ color: 0xf4ead2 });
  const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x54f0ff).multiplyScalar(LIGHT_SCALE) });

  const deck = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.1, 2.1), deckMat);
  g.add(deck);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.04, 0.5), stripeMat);
  stripe.position.set(0, 0.04, 0);
  g.add(stripe);
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.4), deckMat);
  nose.position.set(0, 0.09, -1.15);
  nose.rotation.x = 0.5;
  g.add(nose);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.1, 0.35), deckMat);
  tail.position.set(0, 0.07, 1.1);
  tail.rotation.x = -0.42;
  g.add(tail);
  const strip = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.06, 1.7), glow);
  strip.position.y = -0.08;
  g.add(strip);
  // glow wraps the deck perimeter so it reads from above, not just below:
  // side rails plus nose/tail caps, slightly proud of the deck faces
  for (const rx of [-0.37, 0.37]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 1.9), glow);
    rail.position.set(rx, -0.01, 0);
    g.add(rail);
  }
  // nose/tail caps use headlight/taillight colors so travel direction reads
  // instantly even when the rider is a distant silhouette
  const glowNose = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xfff4c9).multiplyScalar(LIGHT_SCALE) });
  const glowTail = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2818).multiplyScalar(LIGHT_SCALE) });
  const capF = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.1), glowNose);
  capF.position.set(0, -0.01, -1.06);
  g.add(capF);
  const capB = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.08, 0.1), glowTail);
  capB.position.set(0, -0.01, 1.06);
  g.add(capB);
  // the actual light: cyan pool around the deck that reaches the rider's body
  // (via the shared LightPool). Intensity sits between the hemi's night floor
  // (1.0) and its day value (14) so it owns the rider after dark and
  // disappears into daylight.
  g.add(lightAnchor({ color: 0x54f0ff, intensity: 10, distance: 8 }, 0, 0.55, 0));
  // deck light alone leaves the rider's vertical faces black (grazing angles);
  // a second light at chest height, offset toward the face side of the surf
  // stance, fills the body so the silhouette reads after dark
  g.add(lightAnchor({ color: 0x54f0ff, intensity: 5, distance: 6 }, 0.75, 1.5, -0.65));
  // the rider rig is added by Player (it owns and animates the joints)
  return g;
}
