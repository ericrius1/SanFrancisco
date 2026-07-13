import type * as THREE from "three/webgpu";
import type { MuseumCtx } from "../ctx";
import { createCanticleGallery } from "./canticleGallery";
import { createLifeTimeline } from "./lifeTimeline";
import { createBirdsExhibit } from "./birds";
import { createWolfExhibit } from "./wolf";
import { createPeacemakerExhibit } from "./peacemaker";
import { createApseShrine } from "./apse";

/** One exhibit's live handle. Meshes are added to ctx.root inside the factory;
 *  update()/dispose() are optional. */
export interface MdExhibit {
  update?(dt: number, elapsed: number, playerPos: THREE.Vector3): void;
  dispose?(): void;
}

export type MdExhibitFactory = (ctx: MuseumCtx) => MdExhibit;

/** Build every exhibit against the shared museum context. Each is isolated so a
 *  broken one degrades a single display instead of the whole museum. */
export function createExhibits(ctx: MuseumCtx): MdExhibit[] {
  const factories: { name: string; make: MdExhibitFactory }[] = [
    { name: "canticleGallery", make: createCanticleGallery },
    { name: "lifeTimeline", make: createLifeTimeline },
    { name: "birds", make: createBirdsExhibit },
    { name: "wolf", make: createWolfExhibit },
    { name: "peacemaker", make: createPeacemakerExhibit },
    { name: "apse", make: createApseShrine }
  ];
  const out: MdExhibit[] = [];
  for (const f of factories) {
    try {
      out.push(f.make(ctx));
    } catch (err) {
      console.warn(`[mission dolores] exhibit "${f.name}" failed:`, err);
    }
  }
  return out;
}
