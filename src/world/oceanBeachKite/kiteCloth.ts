import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  color,
  float,
  mix,
  normalize,
  normalLocal,
  positionLocal,
  positionWorld,
  saturate,
  sin,
  smoothstep,
  time,
  uniform,
  uv
} from "three/tsl";
import { bumpNormal } from "../tslUtil";
import { spectrum } from "./spectrum";
import type { KiteDesign, KitePalette } from "./kiteDesigns";

export { KITE_DESIGNS, KITE_DESIGN_ORDER } from "./kiteDesigns";
export type { KiteDesign, KiteDesignId } from "./kiteDesigns";

export type KiteClothState = {
  wind: number;
  tautness: number;
  billow: number;
  ripple: number;
  frequency: number;
  speed: number;
  /** CPU flight wobble phase, used only to keep gust beats synchronized. */
  gustPhase: number;
  /** World direction toward the sun; drives the sunset transmission term. */
  sunDir: THREE.Vector3;
  /** 0..1 golden-hour window — how much light is behind the cloth. */
  backlight: number;
};

export type KiteCloth = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  setState(state: KiteClothState): void;
  /** Re-dye in place. Colours are uniforms, so this never recompiles. */
  setPalette(palette: KitePalette): void;
  dispose(): void;
};

/**
 * Fake cloth, fully in the WebGPU vertex stage. The CPU writes a handful of
 * tiny uniforms; the static mesh never changes and nothing is read back.
 *
 * Where the fabric is laced to a spar, a hoop or a hem is a property of the
 * design, not of the shader, so each design bakes two per-vertex attributes at
 * build time: `slack` (0 on an attachment, 1 in free fabric) and `bulge` (where
 * wind pressure bellies the panel out). One shader then serves a solid diamond,
 * a six-bladed rotor and a pierced box without knowing anything about any of
 * them.
 *
 * The dye is four colour UNIFORMS rather than four baked constants. The beach
 * flyers set theirs once and never touch them again; the player's own kite
 * re-dyes live from the atelier, and a uniform write is the difference between
 * that being instant and it costing a WebGPU pipeline compile per swatch.
 */
export function createKiteCloth(design: KiteDesign, initialPalette?: KitePalette): KiteCloth {
  const dye = initialPalette ?? design.palette;
  const clothDeep = uniform(new THREE.Color(dye.clothDeep));
  const clothLight = uniform(new THREE.Color(dye.clothLight));
  const glowLow = uniform(new THREE.Color(dye.glowLow));
  const glowHigh = uniform(new THREE.Color(dye.glowHigh));
  const wind = uniform(1);
  const tautness = uniform(0.68);
  const billow = uniform(0.34);
  const ripple = uniform(0.16);
  const frequency = uniform(4.2);
  const speed = uniform(5.4);
  const gustPhase = uniform(0);
  const sunDir = uniform(new THREE.Vector3(-0.52, 0.42, -0.28).normalize());
  const backlight = uniform(0);

  // TSL node generics fight composition; `any` is the idiom here (facade.ts).
  const slack = attribute("slack", "float") as any;
  const bulge = attribute("bulge", "float") as any;

  const looseness = float(1.12).sub(tautness.mul(0.82));
  const pressure = bulge.mul(billow).mul(wind).mul(looseness).mul(0.72);
  const wavePhase = positionLocal.x
    .mul(frequency)
    .add(positionLocal.y.mul(frequency).mul(0.61))
    .sub(time.mul(speed))
    .add(gustPhase);
  const flutter = sin(wavePhase)
    .mul(0.68)
    .add(sin(wavePhase.mul(1.93).add(positionLocal.y.mul(2.1))).mul(0.32))
    .mul(ripple)
    .mul(wind)
    .mul(looseness);
  const displacement = pressure.add(flutter).mul(slack);

  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.74,
    metalness: 0
  });
  const verticalTint = uv().y.mul(0.58).add(0.18).clamp(0, 1);
  const dyed = mix(clothDeep, clothLight, verticalTint);
  // Seams beside the spars stay a touch darker; the breathing panels catch more
  // of the sky and read as actual cloth instead of one flat card.
  material.colorNode = dyed.mul(float(0.88).add(slack.mul(0.12)));
  // Displacement is along the panel's own normal, so a cone, a box face and a
  // flat diamond all belly outward rather than all bellying along +Z.
  material.positionNode = positionLocal.add(normalLocal.mul(displacement));
  // Shade the displaced surface, not the original flat card. Screen-space
  // derivatives keep the normal in step with both broad billow and fine waves.
  material.normalNode = bumpNormal(displacement);

  // Sunset transmission. Ripstop this thin stops being a surface when the sun
  // is behind it and becomes a lit panel — but only the free fabric does, so
  // spars, hoops and hems stay as dark lines drawn across a glowing sail. That
  // silhouette is the whole picture, and it is what the god rays are cut from.
  const towardSun = saturate(normalize(positionWorld.sub(cameraPosition)).dot(sunDir));
  const transmission = towardSun.pow(4.5).mul(backlight);
  const thinness = slack.mul(float(0.72).add(bulge.mul(0.28)));
  const warmth = mix(
    mix(glowLow, glowHigh, towardSun.pow(3)),
    color(0xffb877),
    towardSun.pow(22)
  );
  // A spectral sail does not transmit one colour, it separates the one it is
  // given. The band runs across the cloth rather than up it, so the comb of
  // slots at the bottom reads as the place the spectrum comes out — and it is
  // seeded from the same backlight term as everything else, so the sail is
  // black cloth until the sun is actually behind it.
  const emissive = design.spectral
    ? mix(
        warmth,
        spectrum(uv().x.mul(0.92).add(0.04)),
        smoothstep(0.62, 0.16, uv().y).mul(0.86).add(0.08)
      ).mul(1.25)
    : warmth;
  material.emissiveNode = emissive
    .mul(transmission)
    .mul(thinness)
    .mul(1.5 * design.glowScale);

  const mesh = new THREE.Mesh(design.buildCloth(), material);
  mesh.name = design.clothMeshName;
  mesh.position.z = -0.025;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  return {
    mesh,
    setState(state) {
      wind.value = THREE.MathUtils.clamp(state.wind, 0.05, 3);
      tautness.value = THREE.MathUtils.clamp(state.tautness, 0, 1);
      billow.value = Math.max(0, state.billow);
      ripple.value = Math.max(0, state.ripple);
      frequency.value = Math.max(0.1, state.frequency);
      speed.value = Math.max(0.1, state.speed);
      gustPhase.value = state.gustPhase;
      (sunDir.value as THREE.Vector3).copy(state.sunDir);
      backlight.value = THREE.MathUtils.clamp(state.backlight, 0, 1);
    },
    setPalette(palette) {
      (clothDeep.value as THREE.Color).setHex(palette.clothDeep);
      (clothLight.value as THREE.Color).setHex(palette.clothLight);
      (glowLow.value as THREE.Color).setHex(palette.glowLow);
      (glowHigh.value as THREE.Color).setHex(palette.glowHigh);
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    }
  };
}
