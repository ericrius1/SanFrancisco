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
}
