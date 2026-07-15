import * as THREE from "three/webgpu";
import { attribute, normalLocal, positionLocal, sin, time, vec3 } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { featherAirspeed, featherBeat, featherWind } from "./wind";

const FLUTTER_ATTRIBUTE = "phxFlutter";
const HEAT_ATTRIBUTE = "phxHeat";
type N = any;

type PhoenixGeometry = THREE.BufferGeometry & {
  getAttribute(name: string): THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
};

function aliasBakedAttribute(geometry: PhoenixGeometry, sourceName: string, runtimeName: string) {
  // GLTFLoader lower-cases custom semantics, while Blender/glTF tools retain
  // their authored spelling. Alias both forms to a stable shader-facing name.
  const source = geometry.getAttribute(sourceName) ?? geometry.getAttribute(sourceName.toLowerCase());
  if (!source) throw new Error(`phoenix mesh is missing ${sourceName}`);
  geometry.setAttribute(runtimeName, source);
}

/**
 * Convert the imported PBR material to a WebGPU node material and add the two
 * phoenix-only effects. The feather motion stays in the vertex stage: for one
 * 58k-triangle skinned hero this avoids a compute dispatch, storage buffer,
 * synchronization barrier, and duplicate position stream every frame.
 */
function makePlumageMaterial(source: THREE.Material): THREE.MeshStandardNodeMaterial {
  const material = new THREE.MeshStandardNodeMaterial();
  material.copy(source);
  material.name = `${source.name || "PhoenixHero"}_GPUPlumage`;

  const flutter = attribute(FLUTTER_ATTRIBUTE, "float") as N;
  const heat = attribute(HEAT_ATTRIBUTE, "float") as N;
  const p = positionLocal as N;
  const n = normalLocal as N;
  const tip = flutter.mul(flutter) as N;

  // Three frequency bands keep the silhouette alive without looking rubbery:
  // broad air wash, a span-wise travelling ripple, then restrained tip noise.
  // Asset local axes are +X forward, +Y up, -Z left.
  const wash = sin(
    time.mul(1.35)
      .add(p.x.mul(0.34))
      .sub(p.z.mul(0.18))
  ) as N;
  const ripple = sin(
    time.mul(5.6)
      .sub(p.x.mul(0.72))
      .add(p.y.mul(0.28))
      .add(p.z.mul(0.43))
  ) as N;
  const turbulence = sin(
    time.mul(11.7)
      .add(p.x.mul(1.31))
      .sub(p.y.mul(0.77))
      .add(p.z.mul(0.91))
  ) as N;
  const motion = wash.mul(0.42)
    .add(ripple.mul(0.38))
    .add(turbulence.mul(0.2))
    .add(featherBeat.mul(0.28)) as N;
  const energy = featherWind.mul(0.085).add(featherAirspeed.mul(0.045)).add(0.014) as N;
  const normalLift = motion.mul(tip).mul(energy) as N;
  const streamBack = wash.mul(tip).mul(featherAirspeed).mul(0.026) as N;

  material.positionNode = p
    .add(n.mul(normalLift))
    .add(vec3(streamBack.negate(), normalLift.mul(0.12), 0));

  // The heat mask makes the feather roots and selected vanes breathe from
  // coal-red to gold. It is emissive only; the generated 2K base/normal/ORM
  // atlas remains the source of all surface detail and daylight response.
  const heatPulse = sin(time.mul(2.15).add(p.y.mul(0.47))).mul(0.5).add(0.5) as N;
  const ember = vec3(1.0, 0.075, 0.006)
    .mul(heat.oneMinus())
    .add(vec3(1.0, 0.53, 0.055).mul(heat));
  const glow = heat
    .mul(0.22)
    .add(heat.mul(heatPulse).mul(0.16))
    .add(heat.mul(featherWind).mul(0.1));
  material.emissiveNode = ember.mul(glow).mul(LIGHT_SCALE);

  return material;
}

export function applyPhoenixPlumage(mesh: THREE.Mesh) {
  const geometry = mesh.geometry as PhoenixGeometry;
  aliasBakedAttribute(geometry, "_PHX_FLUTTER", FLUTTER_ATTRIBUTE);
  aliasBakedAttribute(geometry, "_PHX_HEAT", HEAT_ATTRIBUTE);

  const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const converted = sources.map(makePlumageMaterial);
  mesh.material = Array.isArray(mesh.material) ? converted : converted[0];

  // The new material shares the source textures, so only retire the old
  // material programs. Texture ownership remains with the GLTF scene.
  for (const source of sources) source.dispose();
}
