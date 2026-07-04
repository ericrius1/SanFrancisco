// Hand-written declarations for the vendored SSAONode.js (three r18x addon).
import type { Camera } from "three/webgpu";

interface ValueUniform {
  value: number;
}

export class SSAONode {
  resolutionScale: number;
  radius: ValueUniform;
  intensity: ValueUniform;
  bias: ValueUniform;
  samples: ValueUniform;
  blurEnabled: boolean;
  blurSharpness: ValueUniform;
  // TSL node graph value; typed loosely on purpose, matching how the addon is consumed
  getTextureNode(): any;
  dispose(): void;
}

export function ssao(depthNode: unknown, normalNode: unknown, camera: Camera): SSAONode;

export default SSAONode;
