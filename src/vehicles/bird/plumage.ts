import * as THREE from "three/webgpu";
import { attribute, float, normalLocal, positionLocal, sin, texture, time, vec3 } from "three/tsl";
import { LIGHT_SCALE } from "../../config";
import { featherAirspeed, featherBeat, featherWind } from "./wind";

const DYNAMICS_ATTRIBUTE = "phxDynamics";
const STYLE_ATTRIBUTE = "phxStyle";
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
function makePlumageMaterial(source: THREE.Material): THREE.MeshSSSNodeMaterial {
  const material = new THREE.MeshSSSNodeMaterial();
  material.copy(source);
  material.name = `${source.name || "PhoenixHero"}_GPUFeatherSSS`;
  material.side = THREE.DoubleSide;
  material.shadowSide = THREE.DoubleSide;

  const dynamics = attribute(DYNAMICS_ATTRIBUTE, "vec3") as N;
  const style = attribute(STYLE_ATTRIBUTE, "vec3") as N;
  const flutter = dynamics.x as N;
  const wing = dynamics.y as N;
  const tail = dynamics.z as N;
  const heat = style.x as N;
  const phase = style.y as N;
  const p = positionLocal as N;
  const n = normalLocal as N;
  const tip = flutter.pow(1.35) as N;

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
      .add(phase.mul(6.28318))
  ) as N;
  const motion = wash.mul(0.36)
    .add(ripple.mul(0.4))
    .add(turbulence.mul(0.24))
    .add(featherBeat.mul(0.22)) as N;
  const energy = featherWind.mul(0.19).add(featherAirspeed.mul(0.14)).add(0.028) as N;
  const normalLift = motion.mul(tip).mul(energy) as N;
  // Airflow has a constant aft bias with oscillation layered over it. Letting
  // the wash change the sign entirely made tips look gelatinous instead of
  // loaded by a coherent airstream.
  const streamBack = tip.mul(featherAirspeed).mul(wash.mul(0.045).add(0.055)) as N;

  // Baked region and phase masks let neighbouring feather clumps move with
  // different timing while remaining one fused skinned draw. Wing primaries
  // chatter across the span; tail streamers describe a slower lateral wave.
  const primaryWave = sin(
    time.mul(8.4)
      .add(phase.mul(8.8))
      .sub(p.z.mul(0.62))
      .add(featherBeat.mul(0.85))
  ) as N;
  const tailWaveA = sin(
    time.mul(4.15)
      .add(phase.mul(7.4))
      .sub(p.x.mul(0.72))
  ) as N;
  const tailWaveB = sin(
    time.mul(2.35)
      .sub(phase.mul(5.1))
      .sub(p.x.mul(0.39))
      .add(p.z.mul(0.27))
  ) as N;
  const wingLift = primaryWave.mul(wing).mul(featherWind.mul(0.11).add(featherAirspeed.mul(0.16)).add(0.022)) as N;
  const tailSide = tailWaveA.mul(0.68).add(tailWaveB.mul(0.32))
    .mul(tail)
    .mul(featherWind.mul(0.24).add(featherAirspeed.mul(0.38)).add(0.04)) as N;
  const tailLift = sin(time.mul(3.35).add(phase.mul(5.2)).sub(p.x.mul(0.24)))
    .mul(tail)
    .mul(featherWind.mul(0.12).add(featherAirspeed.mul(0.2)).add(0.025)) as N;

  material.positionNode = p
    .add(n.mul(normalLift.add(wingLift)))
    .add(vec3(streamBack.negate(), normalLift.mul(0.16).add(tailLift), tailSide));

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
  // A tiny atlas-driven coal lift keeps the shaded side deep crimson during
  // sunset rolls without flattening the normal map or turning the bird into a
  // self-lit sign. It costs no additional texture sample: featherColor below
  // reuses the same source atlas node in the compiled graph.

  // Feather-specific stylized transmission. MeshSSS adds a compact direct-
  // light backscatter lobe rather than screen-space blur or true volumetric
  // transmission, so the thin primaries glow at sunset without another pass.
  const standard = source as THREE.MeshStandardMaterial;
  const featherColor = standard.map ? (texture(standard.map) as N).rgb : vec3(0.72, 0.085, 0.018);
  const coalLift = featherColor.mul(vec3(0.12, 0.035, 0.007));
  material.emissiveNode = ember.mul(glow).add(coalLift).mul(LIGHT_SCALE);
  const thinness = flutter.mul(0.14).add(heat.mul(0.04)).add(0.015) as N;
  material.thicknessColorNode = featherColor
    .mul(vec3(0.62, 0.095, 0.018))
    .add(vec3(0.08, 0.004, 0.0005).mul(heat))
    .mul(thinness);
  material.thicknessDistortionNode = float(0.22);
  material.thicknessAmbientNode = float(0.008);
  material.thicknessAttenuationNode = float(1.35);
  material.thicknessPowerNode = float(6.5);
  material.thicknessScaleNode = float(0.48);

  return material;
}

export function applyPhoenixPlumage(mesh: THREE.Mesh) {
  const geometry = mesh.geometry as PhoenixGeometry;
  aliasBakedAttribute(geometry, "_PHX_DYNAMICS", DYNAMICS_ATTRIBUTE);
  aliasBakedAttribute(geometry, "_PHX_STYLE", STYLE_ATTRIBUTE);

  const sources = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const converted = sources.map(makePlumageMaterial);
  mesh.material = Array.isArray(mesh.material) ? converted : converted[0];

  // The new material shares the source textures, so only retire the old
  // material programs. Texture ownership remains with the GLTF scene.
  for (const source of sources) source.dispose();
}
