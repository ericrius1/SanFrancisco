// Maps an archetype id → its façade decorator. Victorian + Edwardian ship the
// canted-bay grammar (theme/victorian.ts). The remaining archetypes (marina,
// downtown, soma, chinatown) fall back to the plain grid for now and get their
// own bespoke decorators next — each in its own file so they can be authored in
// parallel without collisions.
import type { ArchetypeId } from "../core/types";
import { defaultFlatWall, type FacadeDecorator } from "../core/facade";
import { victorianFacade } from "./victorian";

const REGISTRY: Record<ArchetypeId, FacadeDecorator> = {
  victorian: victorianFacade,
  edwardian: victorianFacade, // shallow-bay variant driven by bayProjection in the spec
  // marina / downtown / soma / chinatown → bespoke decorators (Phase 2 cont.)
};

/** Decorator for an archetype; plain flat wall + grid until a bespoke one lands. */
export function decoratorFor(archetype: ArchetypeId): FacadeDecorator {
  return REGISTRY[archetype] ?? defaultFlatWall;
}
