/** Portable, boot-safe metadata. Importing this module never requests an asset. */
export const BIRD_SPECIES = [
  { id: 'pearl-gull', name: 'Pearl', subtitle: 'Coastal gull', color: '#dbe9e6', speed: 9.5, scale: .86 },
  { id: 'lagoon-jay', name: 'Lagoon', subtitle: 'Crested jay', color: '#49cdc6', speed: 7.2, scale: .78 },
  { id: 'ember-kestrel', name: 'Ember', subtitle: 'Copper kestrel', color: '#eda66b', speed: 11, scale: .84 },
] as const;
export type BirdSpeciesId = typeof BIRD_SPECIES[number]['id'];
export interface BirdHabitat {
  id: string; species: BirdSpeciesId;
  center: { x: number; y: number; z: number };
  radius: number; count: number; seed: number;
  loadDistance: number; unloadDistance: number;
}

/** Host-provided world-space branch surface; invalidation makes resting birds take off. */
export interface BirdPerch { x: number; y: number; z: number; active(): boolean; }
