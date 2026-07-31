import * as THREE from "three/webgpu";
import { armCinematic, mix, setPose, smoothstep, vectorRail } from "../../cinematic";
import { OCEAN_KITE_TUNING } from "../../world/oceanBeachKite/tuning";
import { SUTRO_BATHS, inSutroBathsHall, sutroLocalToWorld } from "../../world/sutroBaths/layout";
import type { OceanBeachKiteEncounter } from "../../world/oceanBeachKite";
import type { Demo } from "../demo";
import { cleanPlate, freezeAndBuryPlayer, repin } from "./shared";

export const KITE_TO_SUTRO_SECONDS = 15;

/**
 * Two continuous flights that leave the Ocean Beach kite festival, run north up
 * the sand, cross the Point Lobos headland, and finish gliding down the inside
 * of the restored Sutro Baths.
 *
 * Everything else in `kiteFestivalCinematic.ts` stands still: the camera picks a
 * spot a hundred metres back and holds it, because that is the only geometry in
 * which a kite and a four-degree sun share a frame. These two give that up on
 * purpose. They open on the same live encounter — seven flyers, kites at thirty
 * metres — hold it long enough to read, and then leave, which is the one thing
 * the static set cannot show: that the beach, the headland and the baths are one
 * continuous piece of world.
 *
 * The geography sets the shape of both. The sand runs flat at 0..3 m from the
 * kite site (z 1650) to about z 1370; the headland then climbs to 25..30 m and
 * peaks around z 1270..1320; and the baths sit in a cut basin behind it, its
 * authored ground flattened to 2 m with the sea against the western wall. So a
 * flight north is a long low run, one climb, and a drop into a hole — which is
 * why both end above the hall rather than beside it.
 *
 * Distances are what they are: about 600 m in fifteen seconds, so the middle of
 * each flight is moving at highway speed. The waypoint SPACING is the speed
 * control — `vectorRail` gives each segment the same slice of time, so short
 * segments are slow ones. Both rails are laid out slow at the kites, fast up the
 * beach, and slow again inside the building.
 */

type Flight = {
  id: string;
  title: string;
  /** SF wall-clock hour. 19.4 is sun-on-water; 20.75 is past sunset. */
  hour: number;
  exposure: number;
  mist: number;
  shafts: number;
  /** Which flyer the opening frames are about; 0 is the diamond soloist. */
  subject: number;
  /** The subject's troupe partner, when the opening is about the two of them. */
  companion?: number;
  /**
   * Eye positions in world space, evenly spaced in TIME rather than distance.
   * Ten points is nine segments of 1.67 s each.
   */
  eye: readonly (readonly [number, number, number])[];
  /**
   * Where the lens sits relative to the direction of travel, keyed on shot
   * progress: `lead` is how far ahead the aim point sits, `lift` raises or drops
   * it, `swing` pushes it sideways (positive is camera-right). Aiming down the
   * rail rather than at a second rail is what keeps a flight this fast from
   * fighting itself — the camera always looks where it is going, and these three
   * numbers are the only editorial on top of that.
   */
  aim: readonly (readonly [number, number, number, number])[];
  /** Focal length in millimetres, keyed on shot progress. */
  lens: readonly (readonly [number, number])[];
  /** Local-space point in the bath hall the last quarter settles onto. */
  hallLook: readonly [number, number, number];
};

/**
 * Both rails are twelve points, so eleven segments of 1.364 s each, and the
 * distances below are chosen against that clock: ~40 m at the festival, ~100 m
 * at the middle of the beach run, and ~25 m a segment from the moment the glass
 * is in frame. That is 30 m/s among the flyers, 75 m/s over the water, and about
 * 20 m/s inside the building — which crosses the 110 m hall in five seconds.
 *
 * The tail of each rail is checked against the hall in LOCAL space (see
 * `sutroWorldToLocal`): the enclosure is |x| <= 38.7 and |z| <= 76.1, its roof
 * springs at 25.5 m off the side walls and apexes at 43.5 m over the spine. Both
 * flights are deliberately above that apex when they cross the south end and
 * below it two points later, so each passes through the glazing on a shallow
 * diagonal rather than at a wall.
 */
const FLIGHTS: readonly Flight[] = [
  {
    id: "01",
    title: "Ocean Beach Kites · Over the Headland",
    // Twenty minutes before the sun touches the water: still a disc, still
    // throwing shafts down the beach, and high enough to light the west face of
    // the headland the flight is about to cross.
    hour: 19.85,
    exposure: 0.95,
    // 0.45, down from the static set's 0.7. This one opens ACROSS the sun rather
    // than into it — the camera stands due south of the flyer line while the sun
    // is WNW — and marine layer only reads as light when there is a disc behind
    // it. At 0.7 the first second came back as a pink wash with the runners
    // invisible inside it; the mid-flight coast, which is aimed much closer to
    // the sun, barely changes between the two values.
    mist: 0.45,
    shafts: 1.35,
    // The pair at the north end of the flyer line — the closest two to where
    // this opens, and the ones with the highest kites of the seven.
    subject: 6,
    companion: 5,
    // Opens BEHIND the line and inland of it, flies through the middle of the
    // festival (over the runners, under their kites at 18..40 m), and comes out
    // on the waterline heading north. Then a long climb: the headland crests at
    // 30 m, this crosses at 57, which also clears the bath hall's 43.5 m apex —
    // so the arrival is a descent onto glass rather than an approach to a wall.
    eye: [
      [-6136, 4, 1762],
      [-6146, 8, 1720],
      [-6160, 15, 1664],
      [-6173, 25, 1570],
      [-6179, 37, 1468],
      [-6179, 48, 1364],
      [-6175, 57, 1272],
      [-6165, 58, 1206],
      [-6155, 45, 1174],
      // Local x ~ -19 for the last three, which is over the great salt-water
      // plunge rather than the deck spine beside it. The spine is a four-metre
      // strip between two pools with the hall's columns standing along both
      // edges, and a lens flown down it collects a column at the near edge of
      // every frame; the plunge is twenty-one metres of clear water.
      [-6147, 27, 1148],
      [-6145, 18, 1118],
      [-6143, 14, 1090]
    ],
    aim: [
      // The opening keys are mostly notional — the live-kite blend owns the
      // first quarter — but they have to already point where the kites are, or
      // the handover at u = 0.24 is a pan rather than a release.
      [0, 46, 12, -6],
      [0.14, 62, 2, -10],
      [0.3, 95, -6, -6],
      [0.5, 100, -2, 2],
      [0.62, 92, 2, 8],
      [0.72, 74, -6, 10],
      [0.82, 52, -18, 6],
      [0.9, 46, -12, 2],
      [1, 44, -6, 0]
    ],
    lens: [
      [0, 32],
      [0.18, 27],
      [0.5, 24],
      [0.78, 26],
      [1, 28]
    ],
    // Straight down the plunge toward the north end of the room.
    hallLook: [-18, 7, -70]
  },
  {
    id: "02",
    title: "Ocean Beach Kites · In From the Sea",
    // Sun on the water, to the minute — elevation 0.25 degrees. The whole flight
    // is over the sea with the disc off the left shoulder, so the headland and
    // the bath hall arrive as silhouette and rim rather than as lit rock.
    hour: 20.33,
    exposure: 0.9,
    // Heavier air than flight 1, and for the opposite reason: this one opens
    // looking straight down the sun's own bearing, and marine layer in front of
    // a disc on the water is the glow the whole feature is built around. The
    // first cut of this shot stood on the water aimed north-EAST — away from the
    // sun — and no mist setting saved it: at 0.55 it was brown haze, and at 0.32
    // it was a clean but dead grey beach. Turning the camera round was the fix;
    // the fog then became an asset again.
    mist: 0.6,
    shafts: 1.6,
    subject: 5,
    companion: 6,
    // Opens on the dune EAST of the flyer line, fifty metres out along the
    // anti-solar vector (toSun is about (-0.91, 0, -0.41) at this hour), so the
    // pair, their lines and their kites are all between the lens and a disc
    // sitting on the water. Then it crosses the whole festival on the diagonal,
    // goes out over the surf, and runs north past the cliffs at 20..30 m —
    // everything under it out there is water and there is nothing to clear. One
    // climb to 50 m off the western wall, then a steep diagonal through the west
    // roof slope that is already most of the way down by the time it is under
    // the glass: crossing the glazing level, at the haunch, put the roof's own
    // ironwork right on the lens for a second.
    eye: [
      [-6097, 4, 1733],
      [-6118, 7, 1712],
      [-6148, 12, 1672],
      [-6182, 18, 1590],
      [-6202, 22, 1490],
      [-6212, 26, 1388],
      [-6216, 31, 1292],
      [-6214, 38, 1216],
      [-6196, 50, 1170],
      // The glazing is crossed at local x ~ -23, fifteen metres in from the west
      // wall, not at the wall itself. Coming in at the haunch is geometrically
      // the shortest way into the room and visually the worst: the roof there is
      // only 26 m up, so its ribs and the wall's mullions are a metre off the
      // lens and the first second inside is shot through scaffolding. Fifteen
      // metres further on the glass is 33 m up and there is nothing near the
      // camera but air.
      [-6170, 42, 1142],
      [-6148, 28, 1116],
      // Stops at local z ~ -20 rather than -35. The great plunge ends at -55 and
      // the room at -76; finishing deeper than this leaves the lens 30 m from
      // the north deck with the pools already behind it, and the last frame is a
      // planter against a wall. From here there is another forty-five metres of
      // water in front of the camera when the clip cuts.
      [-6146, 15, 1095]
    ],
    aim: [
      // Negative swing over the sea leg — the sun is on the water off the left
      // shoulder and that is the whole reason this flight is out here. The
      // cliffs need no help staying in frame: the camera is flying parallel to
      // them and a 24 mm lens has them along the right edge regardless.
      [0, 42, 10, 4],
      [0.14, 60, 2, -4],
      [0.3, 88, -2, -10],
      [0.5, 92, 0, -10],
      [0.64, 86, 4, -6],
      [0.74, 70, 0, 4],
      [0.84, 48, -14, 6],
      [0.92, 42, -10, 2],
      [1, 40, -6, 0]
    ],
    lens: [
      [0, 32],
      [0.2, 26],
      [0.55, 24],
      [0.8, 26],
      [1, 28]
    ],
    // Along the great salt-water plunge rather than the deck: this one comes in
    // over the water and stays over it.
    hallLook: [-22, 6, -66]
  }
];

/**
 * Piecewise-linear track with a smoothstep inside each span. `scalarTrack` in
 * the cinematic curves does exactly this for one value; these rails carry three
 * and four, and interpolating them together is what keeps lead/lift/swing from
 * drifting apart between keys.
 */
function keyedTrack(keys: readonly (readonly number[])[], width: number) {
  return (t: number, out: number[]) => {
    const first = keys[0];
    const last = keys[keys.length - 1];
    if (t <= first[0]) {
      for (let i = 0; i < width; i++) out[i] = first[i + 1];
      return out;
    }
    if (t >= last[0]) {
      for (let i = 0; i < width; i++) out[i] = last[i + 1];
      return out;
    }
    for (let k = 0; k < keys.length - 1; k++) {
      const a = keys[k];
      const b = keys[k + 1];
      if (t > b[0]) continue;
      const u = smoothstep((t - a[0]) / Math.max(1e-6, b[0] - a[0]));
      for (let i = 0; i < width; i++) out[i] = mix(a[i + 1], b[i + 1], u);
      return out;
    }
    for (let i = 0; i < width; i++) out[i] = last[i + 1];
    return out;
  };
}

type KiteWindow = Window & typeof globalThis & { __sf?: { oceanBeachKite?: OceanBeachKiteEncounter } };

/** How much of the shot the opening kite framing owns before the rail takes it. */
const KITE_HANDOVER = 0.24;
/** Where the hall aim starts winning, and where it owns the frame outright. */
const HALL_HANDOVER_START = 0.72;

function buildFlight(flight: Flight): Demo {
  const name = `kite-to-sutro-${flight.id}`;
  return {
    name,
    run(ctx) {
      const { map, sky } = ctx;
      if (!map || !sky) {
        console.warn(`[demo:${name}] map or sky unavailable`);
        return;
      }

      cleanPlate(ctx.hud);
      sky.cycleEnabled = false;
      sky.setTimeOfDay(flight.hour);
      ctx.setExposure(flight.exposure);
      // Same contract as the static kite set: several of this scene's passes
      // SAMPLE scene depth, and a multisampled depth attachment is not bindable
      // as an ordinary texture in WebGPU — leave MSAA on and every command
      // buffer that frame is rejected. contactShadows is off for the sibling
      // reason (its complement quad samples the beauty pass's own depth), and it
      // contributes nothing to a lens that is never within a metre of anything.
      ctx.setPostFx({ sceneSamples: 0, contactShadows: false });
      OCEAN_KITE_TUNING.values.mistDensity = flight.mist;
      OCEAN_KITE_TUNING.values.shaftStrength = flight.shafts;
      ctx.input.suspended = true;

      const win = window as KiteWindow;
      const site = (window as unknown as { __sf?: { oceanKiteSite?: { x: number; z: number } } })
        .__sf?.oceanKiteSite ?? { x: -6164, z: 1650 };
      freezeAndBuryPlayer(ctx, site.x, site.z);

      const eyeRail = vectorRail(flight.eye, 0.4);
      const aimTrack = keyedTrack(flight.aim, 3);
      const lensTrack = keyedTrack(flight.lens, 1);
      const hallWorld = sutroLocalToWorld(flight.hallLook[0], flight.hallLook[2]);
      const hallTarget = new THREE.Vector3(hallWorld.x, SUTRO_BATHS.deckY + flight.hallLook[1], hallWorld.z);

      const eye = new THREE.Vector3();
      const target = new THREE.Vector3();
      const ahead = new THREE.Vector3();
      const behind = new THREE.Vector3();
      const forward = new THREE.Vector3();
      const right = new THREE.Vector3();
      const kiteAim = new THREE.Vector3();
      const kite = new THREE.Vector3();
      const runner = new THREE.Vector3();
      const aim = [0, 0, 0];
      const lens = [0];

      /**
       * The subject's kite and the person holding it, resolved live. A flyer is
       * 1.8 m and their kite is thirty metres up, so nothing that frames one
       * frames the other: the opening aims at a point a third of the way up the
       * line, which is the only place both fit.
       */
      const readKiteAim = (): boolean => {
        const state = win.__sf?.oceanBeachKite?.debugState();
        if (!state || !state.flyers.length) return false;
        const subject = state.flyers[Math.min(flight.subject, state.flyers.length - 1)];
        kite.set(subject.kite[0], subject.kite[1], subject.kite[2]);
        runner.set(subject.runner[0], subject.runner[1], subject.runner[2]);
        if (flight.companion !== undefined) {
          const partner = state.flyers[flight.companion];
          if (partner) {
            kite.x = (kite.x + partner.kite[0]) * 0.5;
            kite.y = (kite.y + partner.kite[1]) * 0.5;
            kite.z = (kite.z + partner.kite[2]) * 0.5;
            runner.x = (runner.x + partner.runner[0]) * 0.5;
            runner.z = (runner.z + partner.runner[2]) * 0.5;
          }
        }
        kiteAim.set(
          mix(runner.x, kite.x, 0.34),
          map.groundTop(runner.x, runner.z) + 11,
          mix(runner.z, kite.z, 0.34)
        );
        return true;
      };

      // The body is buried so it is never in shot, but its XZ is still the world's
      // streaming focus (terrain tiles ride player.position; the hero shadow
      // cascade and every site's near-effects ride renderPosition). A camera that
      // travels 600 m away from a parked body would fly out of both — no cascade
      // under the hall, no steam on the pools, and terrain topping up around a
      // beach nobody is looking at any more. So the body flies too, 300 m under
      // the camera the whole way.
      const followWorld = (x: number, z: number) => {
        const ground = map.groundTop(x, z);
        repin({ x, y: ground - 300, z }, ctx);
        // Inside the hall the authored ground is the 2 m basin floor, well below
        // the 5.62 m bath deck the bathers and steam actually stand on.
        const deck = inSutroBathsHall(x, z) ? Math.max(ground, SUTRO_BATHS.deckY) : ground;
        ctx.player.renderPosition.set(x, deck + 1.6, z);
      };

      armCinematic(ctx, {
        name,
        duration: KITE_TO_SUTRO_SECONDS,
        frame: (time) => {
          eyeRail(time / KITE_TO_SUTRO_SECONDS, eye);
          followWorld(eye.x, eye.z);
        },
        shots: [
          {
            id: flight.id,
            start: 0,
            end: KITE_TO_SUTRO_SECONDS,
            // A metre and a half. The flight opens at head height on the sand and
            // finishes inside a building; anything larger would lift the opening
            // off the beach it is standing on.
            safety: { floorClearance: 1.5 },
            camera: (sample, out) => {
              const u = sample.u;
              eyeRail(u, eye);

              // Central difference rather than a forward one: at u = 1 a forward
              // difference has nothing left to sample and the aim collapses onto
              // the eye, which reads as the camera snapping to look at its own
              // lens on the last frame.
              eyeRail(Math.min(1, u + 0.035), ahead);
              eyeRail(Math.max(0, u - 0.035), behind);
              forward.copy(ahead).sub(behind);
              forward.y = 0;
              if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
              forward.normalize();
              right.set(-forward.z, 0, forward.x);

              aimTrack(u, aim);
              target.copy(eye)
                .addScaledVector(forward, aim[0])
                .addScaledVector(right, aim[2]);
              target.y = eye.y + aim[1];

              // Hand the frame off to the live kites at the head of the shot and
              // to the hall's long axis at the tail. Both blends are smoothstep
              // into an aim that is already pointing the same way, so neither is
              // a cut — the opening simply stops tracking a kite that is by then
              // four hundred metres behind the lens.
              if (u < KITE_HANDOVER && readKiteAim()) {
                target.lerp(kiteAim, 1 - smoothstep(u / KITE_HANDOVER));
              }
              if (u > HALL_HANDOVER_START) {
                target.lerp(hallTarget, smoothstep((u - HALL_HANDOVER_START) / (1 - HALL_HANDOVER_START)));
              }

              lensTrack(u, lens);
              setPose(out, eye, target, lens[0]);
            }
          }
        ]
      });
    }
  };
}

export const kiteToSutroDemos: readonly Demo[] = FLIGHTS.map(buildFlight);
export const KITE_TO_SUTRO_TITLES: Readonly<Record<string, string>> = Object.fromEntries(
  FLIGHTS.map((flight) => [`kite-to-sutro-${flight.id}`, flight.title])
);
