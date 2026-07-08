// Minimal typings for the vendored SeedThree headless API (MIT, plain JS).
// See vendor/SeedThree/src/api/README.md for the real contract.
declare module "*/SeedThree/src/api/seedthree.js" {
  import type { Object3D, Texture } from "three/webgpu";

  export type SeedThreeLoadTexture = (path: string, opts: { srgb: boolean }) => Promise<Texture | null>;

  export function createTree(opts: {
    species: string;
    seed?: number;
    controls?: Record<string, unknown>;
    lod?: Record<string, unknown>;
    loadTexture?: SeedThreeLoadTexture;
    assetsDir?: string;
    sunLight?: unknown;
    level?: string | null;
  }): Promise<{ object: Object3D; group: Object3D; stats: { summary: Record<string, number> } }>;

  export function setWind(opts: { strength?: number; speed?: number }): { strength: number; speed: number };
  export function listSpecies(): { key: string; name: string }[];
}

declare module "*/SeedThree/src/core/leaf-cards.js" {
  export const foliageBrightness: { value: number };
}

declare module "*/SeedThree/src/core/wind.js" {
  import type { Vector3 } from "three/webgpu";
  export const WIND_DIR: Vector3;
  export const windStrength: { value: number };
  export const windSpeed: { value: number };
  export const grassNoiseStrength: { value: number };
  export const grassNoiseScale: { value: number };
  export const grassNoiseSpeed: { value: number };
}
