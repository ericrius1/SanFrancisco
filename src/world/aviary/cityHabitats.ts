import type { BirdHabitat, BirdSpeciesId } from './catalog';

/** Placement data only: neither the city lattice nor its landmarks load models. */
const habitat = (id: string, species: BirdSpeciesId, x: number, z: number, count: number, radius: number, seed: number): BirdHabitat => ({
  id, species, center: { x, y: 55, z }, count, radius, seed, loadDistance: 1450, unloadDistance: 1700,
});
const landmarks = [
  habitat('lands-end-pearl', 'pearl-gull', -5920, 660, 36, 80, 17),
  habitat('presidio-lagoon', 'lagoon-jay', -2900, -1550, 24, 95, 29),
  habitat('corona-ember', 'ember-kestrel', 408, 2760, 12, 85, 43),
  habitat('ferry-pearl', 'pearl-gull', 4580, -580, 32, 85, 51),
  habitat('bayfront-pearl', 'pearl-gull', 3000, -2600, 28, 110, 61),
  habitat('marina-pearl', 'pearl-gull', 500, -2050, 24, 95, 71),
  habitat('golden-gate-pearl', 'pearl-gull', -2770, -2850, 32, 110, 81),
  habitat('ocean-beach-pearl', 'pearl-gull', -6220, 2500, 36, 115, 91),
  habitat('palace-lagoon', 'lagoon-jay', -300, -1426, 16, 70, 101),
  habitat('park-west-lagoon', 'lagoon-jay', -4250, 2130, 24, 115, 111),
  habitat('park-east-lagoon', 'lagoon-jay', -1320, 2180, 20, 105, 121),
  habitat('tea-garden-lagoon', 'lagoon-jay', -2250, 2150, 12, 70, 131),
  habitat('telegraph-ember', 'ember-kestrel', 3350, -1380, 3, 75, 141),
  habitat('mission-ember', 'ember-kestrel', 1800, 3150, 2, 100, 151),
];

const neighborhoods: BirdHabitat[] = [];
for (let row = 0, z = -5300; z <= 6200; row++, z += 440) {
  for (let col = 0, x = -10500; x <= 6000; col++, x += 440) {
    const seed = 200 + row * 31 + col * 13;
    const px = x + ((seed * 37) % 181 - 90), pz = z + ((seed * 53) % 181 - 90);
    if (landmarks.some(h => Math.hypot(h.center.x - px, h.center.z - pz) < 240)) continue;
    const coast = px < -5000 || px > 3950 || pz < -1850;
    const park = px < -600 && pz > 1300 && pz < 2600;
    const species: BirdSpeciesId = coast ? 'pearl-gull' : park || seed % 5 < 3 ? 'lagoon-jay' : 'ember-kestrel';
    // Loose parties and large flocks populate several depth layers of the skyline.
    const count = [8, 14, 20, 28, 36][seed % 5];
    neighborhoods.push(habitat(`city-${row}-${col}`, species, px, pz, count, count <= 2 ? 120 : 95, seed));
  }
}
export const AVIARY_HABITATS: readonly BirdHabitat[] = [...landmarks, ...neighborhoods];
