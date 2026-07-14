import * as THREE from "three/webgpu";
import {
  abs,
  color,
  float,
  mix,
  positionLocal,
  sin,
  smoothstep,
  time,
  uniform,
  uv,
  vec3
} from "three/tsl";
import { bumpNormal } from "../tslUtil";

/** A large, readable classic diamond without turning one ambient prop into a
 * high-poly hero asset. The four panels are subdivided for GPU ripples. */
export const KITE_WIDTH = 3.5;
export const KITE_HEIGHT = 4.25;
const PANEL_SUBDIVISIONS = 9;

type Point = readonly [number, number];

/**
 * Four independently triangulated panels meet at the spine/cross-spar. Shared
 * vertices are unnecessary here: the material is smooth and the duplicate
 * seams make every panel's attachment line exact.
 */
function createDiamondGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const corners: readonly Point[] = [
    [0, KITE_HEIGHT * 0.5],
    [KITE_WIDTH * 0.5, 0],
    [0, -KITE_HEIGHT * 0.5],
    [-KITE_WIDTH * 0.5, 0]
  ];

  const point = (a: Point, b: Point, i: number, j: number): Point => {
    const u = i / PANEL_SUBDIVISIONS;
    const v = j / PANEL_SUBDIVISIONS;
    return [a[0] * u + b[0] * v, a[1] * u + b[1] * v];
  };
  const push = (p: Point) => {
    positions.push(p[0], p[1], 0);
    normals.push(0, 0, 1);
    uvs.push(p[0] / KITE_WIDTH + 0.5, p[1] / KITE_HEIGHT + 0.5);
  };

  for (let panel = 0; panel < 4; panel++) {
    const a = corners[panel];
    const b = corners[(panel + 1) % corners.length];
    for (let i = 0; i < PANEL_SUBDIVISIONS; i++) {
      for (let j = 0; j < PANEL_SUBDIVISIONS - i; j++) {
        const p00 = point(a, b, i, j);
        const p10 = point(a, b, i + 1, j);
        const p01 = point(a, b, i, j + 1);
        // +Z winding matches the authored normal and the kite's flyer-facing
        // cloth side. DoubleSide can now flip the opposite face correctly.
        push(p00);
        push(p01);
        push(p10);
        if (j < PANEL_SUBDIVISIONS - i - 1) {
          const p11 = point(a, b, i + 1, j + 1);
          push(p10);
          push(p01);
          push(p11);
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeBoundingSphere();
  if (geometry.boundingSphere) geometry.boundingSphere.radius += 1.35;
  return geometry;
}

export type KiteClothState = {
  wind: number;
  tautness: number;
  billow: number;
  ripple: number;
  frequency: number;
  speed: number;
  /** CPU flight wobble phase, used only to keep gust beats synchronized. */
  gustPhase: number;
};

export type KiteCloth = {
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardNodeMaterial>;
  setState(state: KiteClothState): void;
  dispose(): void;
};

/**
 * Fake cloth, fully in the WebGPU vertex stage. The CPU writes six tiny
 * uniforms; the static mesh never changes and nothing is read back. A diamond
 * kite's cloth is laced to a vertical spine, a bowed cross-spar, and its outer
 * hem, so displacement deliberately reaches zero on all three attachments and
 * swells only inside the four free fabric panels.
 */
export function createKiteCloth(): KiteCloth {
  const wind = uniform(1);
  const tautness = uniform(0.68);
  const billow = uniform(0.34);
  const ripple = uniform(0.16);
  const frequency = uniform(4.2);
  const speed = uniform(5.4);
  const gustPhase = uniform(0);

  const nx = abs(positionLocal.x).div(KITE_WIDTH * 0.5);
  const ny = abs(positionLocal.y).div(KITE_HEIGHT * 0.5);
  const edgeRoom = float(1).sub(nx.add(ny));

  // Exactly still on spine/cross-spar and at the sewn hem; fully mobile in the
  // middle of each quadrant. This is the visual equivalent of multi-point pins.
  const freePanel = smoothstep(0.025, 0.34, nx)
    .mul(smoothstep(0.02, 0.28, ny))
    .mul(smoothstep(0.01, 0.2, edgeRoom));

  const pressureShape = sin(nx.mul(Math.PI)).mul(sin(ny.mul(Math.PI)));
  const looseness = float(1.12).sub(tautness.mul(0.82));
  const pressure = pressureShape
    .mul(billow)
    .mul(wind)
    .mul(looseness)
    .mul(0.72);
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
  const displacement = pressure.add(flutter).mul(freePanel);

  const material = new THREE.MeshStandardNodeMaterial({
    side: THREE.DoubleSide,
    roughness: 0.74,
    metalness: 0
  });
  const verticalTint = uv().y.mul(0.58).add(0.18).clamp(0, 1);
  const purple = mix(color(0x4b1f91), color(0xa766ef), verticalTint);
  // Seams beside the spars stay a touch darker; the four breathing panels catch
  // more of the sky and read as actual cloth instead of one flat purple card.
  material.colorNode = purple.mul(float(0.88).add(freePanel.mul(0.12)));
  material.positionNode = positionLocal.add(vec3(0, 0, displacement));
  // Shade the displaced surface, not the original flat card. Screen-space
  // derivatives keep the normal in step with both broad billow and fine waves.
  material.normalNode = bumpNormal(displacement);

  const mesh = new THREE.Mesh(createDiamondGeometry(), material);
  mesh.name = "ocean_beach_purple_kite_gpu_cloth";
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
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      mesh.removeFromParent();
    }
  };
}
