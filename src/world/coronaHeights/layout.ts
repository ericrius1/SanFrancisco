// Corona Heights Park authored layout. Coordinates come from the same local
// projection as the city bake (+X east, +Z south, metres). The dog run and
// trails are current OpenStreetMap ways converted once into game coordinates;
// keeping them here makes the renderer deterministic and independent of the
// network at runtime.

import { CORONA_DOG_PARK, type CoronaXZ } from "./meta";

export { CORONA_DOG_PARK, CORONA_HEIGHTS_SUMMIT, type CoronaXZ } from "./meta";

export type CoronaTrail = {
  name: string;
  surface: "dirt" | "compacted" | "steps";
  width: number;
  points: readonly CoronaXZ[];
};

/** The principal dirt/compacted routes that make the hill read from the air and
 * guide a walker from the dog area to the summit. Dense OSM curves are lightly
 * decimated without moving their endpoints or switchbacks. */
export const CORONA_TRAILS: readonly CoronaTrail[] = [
  {
    name: "Bill Kraus Pathway",
    surface: "dirt",
    width: 2.1,
    points: [
      [258.6, 2732.9],
      [270.2, 2734.9],
      [328.9, 2736.6],
      [364.5, 2719.6],
      [378.3, 2713],
      [399.6, 2707.4],
      [407.1, 2707.9],
      [427.4, 2711.9],
      [437.1, 2717.1],
      [453.5, 2726.9],
      [476.7, 2740.9]
    ]
  },
  {
    name: "West switchback",
    surface: "dirt",
    width: 1.8,
    points: [
      [328.9, 2736.6],
      [307.6, 2774.3],
      [312.3, 2777.1]
    ]
  },
  {
    name: "West box steps",
    surface: "steps",
    width: 1.75,
    points: [
      [312.3, 2777.1],
      [319.1, 2778.7],
      [330.2, 2774.6],
      [339.9, 2774.4]
    ]
  },
  {
    name: "South summit approach",
    surface: "compacted",
    width: 1.8,
    points: [
      [339.9, 2774.4],
      [348, 2777.4],
      [363.1, 2782],
      [380.7, 2786],
      [392.6, 2796.2],
      [404.1, 2799.8],
      [417.4, 2798.3],
      [433.5, 2797.1],
      [453.1, 2786.7],
      [470.2, 2768.3],
      [489.6, 2745.7]
    ]
  },
  {
    name: "Peak trail",
    surface: "dirt",
    width: 1.65,
    points: [
      [386.1, 2745.2],
      [393, 2751.1],
      [400.5, 2755.5],
      [408, 2760],
      [418.1, 2759.3],
      [422.3, 2769.7]
    ]
  },
  {
    name: "North summit steps",
    surface: "steps",
    width: 1.7,
    points: [
      [348, 2777.4],
      [356.1, 2763.1],
      [368.3, 2760.3],
      [378.3, 2750.5],
      [386.1, 2745.2]
    ]
  },
  {
    name: "East summit steps",
    surface: "steps",
    width: 1.65,
    points: [
      [437.2, 2784.2],
      [432.4, 2778.9],
      [426, 2777.1],
      [422.3, 2769.7]
    ]
  }
] as const;

export const CORONA_DOG_GATE = CORONA_DOG_PARK[0];
