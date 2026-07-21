import * as THREE from "three/webgpu";
import { float, fract, mix, positionLocal, smoothstep, time, uniform, uv, vec3 } from "three/tsl";
import { hangGliderPalette, type HangGliderStyle } from "./style";

type CanopyFlightFrame = Readonly<{
  airspeed: number;
  verticalSpeed: number;
  lift: number;
}>;

export type HangGliderCanopyMaterial = Readonly<{
  material: THREE.MeshStandardNodeMaterial;
  setStyle(style: HangGliderStyle): void;
  update(dt: number, frame: CanopyFlightFrame): void;
}>;

/** A low-cost GPU sail: static tessellated geometry supplies the broad canopy
 * arc, while layered TSL sine fields add positive belly, travelling ripples and
 * a freer trailing-edge flutter. Only five scalar/color uniforms change; the
 * mesh remains GPU-resident and requires no simulation readback. */
export function createHangGliderCanopyMaterial(initial: HangGliderStyle): HangGliderCanopyMaterial {
  const palette = hangGliderPalette(initial.palette);
  const innerColor = uniform(new THREE.Color(palette.colors[0]));
  const outerColor = uniform(new THREE.Color(palette.colors[1]));
  const accentColor = uniform(new THREE.Color(palette.colors[2]));
  const billow = uniform(initial.billow);
  const flutter = uniform(initial.flutter);
  const windTempo = uniform(initial.wind);
  const airflow = uniform(0.48);
  const gust = uniform(0.15);

  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.79,
    metalness: 0
  });

  const u = uv().x;
  const v = uv().y;
  const signedSpan = u.mul(2).sub(1);
  const edge = signedSpan.abs().clamp(0, 1);
  const center = float(1).sub(edge.pow(1.7));
  const chordEnvelope = v.mul(Math.PI).sin().max(0).pow(0.72);
  const trailing = v.pow(3.2);
  const speed = windTempo.mul(2.05).mul(airflow.mul(0.42).add(0.78));

  // A positive pressure belly keeps the membrane visually full. The travelling
  // fields ride on top instead of averaging the sail back into a flat sheet.
  const pressure = chordEnvelope
    .mul(center.mul(0.45).add(0.55))
    .mul(billow)
    .mul(airflow.mul(0.055).add(0.13));
  const longWave = signedSpan.mul(7.3)
    .add(v.mul(3.4))
    .sub(time.mul(speed))
    .sin()
    .mul(0.6);
  const crossWave = signedSpan.mul(15.7)
    .sub(v.mul(6.1))
    .add(time.mul(speed.mul(1.47)))
    .sin()
    .mul(0.4);
  const ripple = longWave.add(crossWave)
    .mul(chordEnvelope)
    .mul(billow)
    .mul(airflow.mul(0.035).add(0.025));
  const leech = signedSpan.mul(19.0)
    .add(time.mul(speed.mul(2.35)))
    .add(v.mul(5.2))
    .sin()
    .mul(trailing)
    .mul(flutter)
    .mul(airflow.mul(0.055).add(gust.mul(0.065)).add(0.02));
  const gustPocket = signedSpan.mul(4.7)
    .sub(time.mul(speed.mul(0.63)))
    .sin()
    .mul(chordEnvelope)
    .mul(gust)
    .mul(0.11);
  const lift = pressure.add(ripple).add(leech).add(gustPocket);
  const sideSlip = crossWave.mul(trailing).mul(flutter).mul(0.018);
  const chordFlex = leech.mul(0.19);
  material.positionNode = positionLocal.add(vec3(sideSlip, lift, chordFlex));

  // Broad dye panels follow the canopy silhouette; fine darker seams reveal
  // the moving surface without resorting to a texture fetch.
  const outerMix = smoothstep(0.22, 0.92, edge);
  const centerFlash = float(1).sub(smoothstep(0.02, 0.16, edge));
  const tipFlash = smoothstep(0.7, 0.96, edge);
  const panelSeam = smoothstep(0.9, 0.985, fract(u.mul(12))).mul(0.16);
  const dyed = mix(innerColor, outerColor, outerMix);
  const accented = mix(dyed, accentColor, centerFlash.mul(0.68).add(tipFlash.mul(0.42)).clamp(0, 1));
  material.colorNode = accented.mul(float(1).sub(panelSeam));

  let flowValue = 0.48;
  let gustValue = 0.15;
  return {
    material,
    setStyle(style) {
      const next = hangGliderPalette(style.palette);
      (innerColor.value as THREE.Color).set(next.colors[0]);
      (outerColor.value as THREE.Color).set(next.colors[1]);
      (accentColor.value as THREE.Color).set(next.colors[2]);
      billow.value = style.billow;
      flutter.value = style.flutter;
      windTempo.value = style.wind;
    },
    update(dt, frame) {
      const smoothDt = Math.min(Math.max(dt, 0), 1 / 20);
      const targetFlow = THREE.MathUtils.clamp((frame.airspeed - 8) / 27, 0.18, 1.2);
      const targetGust = THREE.MathUtils.clamp(
        Math.abs(frame.verticalSpeed) * 0.055 + frame.lift * 0.11,
        0.08,
        1.15
      );
      flowValue += (targetFlow - flowValue) * (1 - Math.exp(-smoothDt * 3.8));
      gustValue += (targetGust - gustValue) * (1 - Math.exp(-smoothDt * 2.25));
      airflow.value = flowValue;
      gust.value = gustValue;
    }
  };
}
