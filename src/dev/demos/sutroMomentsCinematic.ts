import * as THREE from "three/webgpu";
import { armCinematic, mix, setPose, smoothstep } from "../../cinematic";
import type { CinematicDefinition } from "../../cinematic/director";
import { SUTRO_BATHS } from "../../world/sutroBaths/layout";
import type { Demo, DemoContext } from "../demo";
import { cleanPlate, freezePlayerInPlace, repin } from "./shared";

/**
 * Five seconds inside the restored hall, at the height of somebody's eyes.
 *
 * Not a tour and not a crane move. Each look is one person's glance held for
 * five seconds: the camera stands where a visitor would stand, at 1.62 m over
 * whatever it is standing on, and moves about as much as a head does — a slow
 * turn, a half step, a settle. The subjects are the hall's own cast
 * (sutroBaths/bathers.ts) filmed where they already are, so nothing is staged
 * for the lens.
 *
 * THE PLAYER. There is no avatar in any of these. The body stays frozen inside
 * the hall rather than buried, because the pocket's held sunset is latched on
 * the player being inside it — see freezePlayerInPlace in ./shared.
 *
 * LOCAL FRAME. Everything below is written in the hall's own coordinates,
 * matching bathers.ts and parlour.ts: +x runs inland/east, +z runs south, the
 * deck is at 5.62 m and the water sits at 5.18 m. `L()` rotates those onto the
 * site's 4.4-degree skew.
 */

const SITE_YAW = -0.077;
const SITE_X = -6125;
const SITE_Z = 1117;

const DECK = SUTRO_BATHS.deckY;
const WATER = SUTRO_BATHS.waterY;
/** Standing eye height. The cast are blocky and short; 1.62 m reads as adult. */
const EYE = 1.62;

const cosYaw = Math.cos(SITE_YAW);
const sinYaw = Math.sin(SITE_YAW);

/** Hall-local (x, y, z) to world. */
function L(lx: number, y: number, lz: number): [number, number, number] {
  return [SITE_X + cosYaw * lx + sinYaw * lz, y, SITE_Z - sinYaw * lx + cosYaw * lz];
}

/**
 * A held look. Real people do not hold perfectly still, and a locked-off tripod
 * frame reads as a screenshot rather than a moment — but a five-second shot has
 * no room for a move either. So each camera drifts a metre or less and turns a
 * few degrees, on a smoothstep so it eases at both ends.
 */
type Look = {
  id: string;
  /** Eye at u=0 and u=1, hall-local. */
  eye: [readonly [number, number, number], readonly [number, number, number]];
  /** What the look is on, at u=0 and u=1, hall-local. */
  at: [readonly [number, number, number], readonly [number, number, number]];
  /**
   * Focal length in millimetres, start and end.
   *
   * Judge these ONLY from the cinematic stills. tools/sutro-moment-framing-probe
   * drives the free cam, where setting camera.fov has no effect on the rendered
   * projection — every look there renders at the app's own default, so a lens
   * chosen against that probe comes out far too long once ShotCamera applies it
   * for real. The first pass picked 45-105 mm that way and every frame arrived
   * cropped into somebody's ear.
   */
  lens: [number, number];
};

const eyeVec = new THREE.Vector3();
const atVec = new THREE.Vector3();

function holdLook(look: Look, u: number, out: Parameters<typeof setPose>[0]) {
  const t = smoothstep(u);
  const [e0, e1] = look.eye;
  const [a0, a1] = look.at;
  const e = L(mix(e0[0], e1[0], t), mix(e0[1], e1[1], t), mix(e0[2], e1[2], t));
  const a = L(mix(a0[0], a1[0], t), mix(a0[1], a1[1], t), mix(a0[2], a1[2], t));
  eyeVec.set(e[0], e[1], e[2]);
  atVec.set(a[0], a[1], a[2]);
  setPose(out, eyeVec, atVec, mix(look.lens[0], look.lens[1], t));
}

/**
 * The five looks.
 *
 * Subject coordinates are lifted straight from the cast and furniture tables so
 * a camera can never be aimed at an empty chair:
 *   still-water   sutro-swim-3, backFloat in the great plunge at (-26, -8)
 *   long-view     sutro-lounge-3/4 on the window-south bench at (-36.2, 21)
 *   tea-window    sutro-tea-3/4/5 around the west-b table at (-34.2, 6)
 *   hot-bath      sutro-hot-1/2, wadeChat in bath four at (3.5, 3.5)/(5.9, 4.4)
 *   plunge-edge   sutro-sit-1/2, sitEdge on the west coping at (-32.2, -25.4)
 */
const LOOKS: readonly (Look & { title: string })[] = [
  {
    id: "still-water",
    title: "Still Water",
    // Standing on the west coping of the great plunge, looking down the length
    // of it at sutro-swim-3 backfloating.
    //
    // The first cut of this put the eye at water + 0.75, which reads as "just
    // above the surface" until you notice the deck is only 0.44 m above the
    // water: that is 0.31 m over the boards the camera is standing on, and the
    // coping filled the bottom half of frame. Standing height, angled down.
    eye: [
      [-31.5, DECK + 1.45, -13.6],
      [-31.6, DECK + 1.4, -11.4]
    ],
    at: [
      [-26.0, WATER + 0.2, -8.8],
      [-25.6, WATER + 0.24, -7.7]
    ],
    lens: [24, 26]
  },
  {
    id: "long-view",
    title: "The Long View",
    // Behind the window-south bench, over two pairs of shoulders and out
    // through the ocean glass at local x -38.7.
    eye: [
      [-33.4, DECK + EYE, 22.9],
      [-34.0, DECK + EYE - 0.03, 21.8]
    ],
    at: [
      [-46, DECK + 1.15, 18.6],
      [-48, DECK + 1.45, 16.8]
    ],
    lens: [35, 35]
  },
  {
    id: "tea-window",
    title: "Tea in the Windows",
    // The west-b table: three chairs on a 0.94 m reach at bearings 0.8, 2.89
    // and 4.98, so the group sits inside about a 2 m circle. Coming at it from
    // the deck side puts the sunset behind them and the table lamp on their
    // near edges.
    eye: [
      [-30.7, DECK + 1.52, 7.9],
      [-31.6, DECK + 1.48, 6.9]
    ],
    at: [
      [-34.3, DECK + 0.98, 6.1],
      [-34.5, DECK + 0.94, 6.0]
    ],
    lens: [28, 30]
  },
  {
    id: "hot-bath",
    title: "The Hot Bath",
    // Across bath four at sutro-hot-1/2 (measured at local [3.5, 3.5] and
    // [5.9, 4.4]) talking chest-deep, steam between lens and subject. Shot from
    // the deck SPINE, local x -10..-4 — the first cut stood the camera at x
    // -2.4, inside the pool's own footprint. Pressed right up to the coping,
    // because a chest-deep person shows only about 0.8 m of themselves and this
    // is the longest sightline of the five.
    eye: [
      [-4.7, DECK + EYE, 5.9],
      [-4.5, DECK + EYE - 0.02, 5.0]
    ],
    at: [
      [4.4, WATER + 0.9, 3.9],
      [4.6, WATER + 0.94, 3.8]
    ],
    lens: [50, 52]
  },
  {
    id: "plunge-edge",
    title: "The Plunge Edge",
    // Down the west coping at sutro-sit-1/2 (measured at local [-32.2, -25.4]
    // and [-32.2, -23.2]), feet in the plunge, candle line at local x -32.4
    // running away behind them. Closer than the first cut, which left the
    // bottom third of frame as bare deck.
    eye: [
      [-33.4, DECK + EYE, -29.9],
      [-33.2, DECK + EYE - 0.02, -28.4]
    ],
    at: [
      [-32.3, DECK + 0.6, -24.8],
      [-32.2, DECK + 0.65, -24.2]
    ],
    lens: [35, 36]
  }
] as const;

export const SUTRO_MOMENT_SECONDS = 5;
export const SUTRO_VISTA_SECONDS = 10;

/**
 * The two wide ones. Ten seconds each, and the subject is the room rather than
 * anybody in it: the whole volume of glass and iron with the Pacific behind it,
 * and the cast reading as a population going about a quiet evening.
 *
 * These are the only cameras here that move meaningfully. A held look works at
 * five seconds because there is one thing to see; ten seconds on a hall this
 * size wants the parallax of a slow drift to say how big it is, so each one
 * travels a few metres and lets the ironwork slide past the sunset.
 *
 * Still nobody's point of view but a person's — both stay at deck level rather
 * than craning, because the hall reads as enormous from down among the pools and
 * merely large from up in the roof.
 */
const VISTAS: readonly (Look & { title: string })[] = [
  {
    id: "vista-hall",
    title: "The Hall",
    // North end of the deck spine, drifting south down the length of the room.
    // The great plunge runs away on the right, the graduated baths on the left,
    // and the ocean glass carries the sunset along the far wall.
    eye: [
      [-7.2, DECK + EYE, -58],
      [-7.4, DECK + EYE + 0.05, -44]
    ],
    at: [
      [-16, DECK + 5.5, 24],
      [-19, DECK + 4.6, 30]
    ],
    lens: [21, 22]
  },
  {
    id: "vista-ocean",
    title: "The Ocean Window",
    // Standing off the west gallery looking down its length: the colonnade and
    // the hung plates on one side, the whole ocean wall and the sun on the
    // other, and the tea tables strung out between them.
    eye: [
      [-27.5, DECK + EYE, -34],
      [-28.6, DECK + EYE + 0.04, -22]
    ],
    at: [
      [-36.5, DECK + 3.2, 26],
      [-37.5, DECK + 2.6, 32]
    ],
    lens: [24, 25]
  }
] as const;

/** Where the frozen body waits: deep inside the hall, off every sightline. */
const PLAYER_HOLD = L(-14, DECK + 0.1, -66);

type SutroWindow = {
  __sf?: {
    worldCursor?: { setEnabled(on: boolean): void };
    ensureOptionalWorldSite?: (id: string) => Promise<void>;
    sutroBaths?: {
      stats?: { bathers?: number };
      debugState?: () => { twilight?: { skyBlend?: number; inside?: boolean } };
    };
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Hold off arming until the room is actually the room.
 *
 * `armCinematic` sets `__sfReelArmed`, which is the capture harness's one and
 * only readiness gate — it navigates, waits for that flag, settles a handful of
 * zero-dt frames and starts recording. Arming synchronously therefore starts the
 * take on whatever happens to be on screen, and for this site that is the wrong
 * world twice over: the optional living layer (bathers, tea, steam) is a lazy
 * import that has not landed yet, and the pocket's held sunset ramps over about
 * seven seconds of WALL clock, which the settle frames do not advance.
 *
 * The first attempt at these shots armed immediately and recorded exactly that:
 * a bright blue afternoon, no candles, and an empty pool where the floating
 * bather should have been. So wait here instead — the harness allows it, the
 * ready timeout is generous, and this is the one place that can tell whether the
 * hall is ready to be filmed.
 */
async function waitForTheHall(): Promise<void> {
  const win = window as unknown as SutroWindow;
  await win.__sf?.ensureOptionalWorldSite?.("sutro-baths").catch(() => {});

  const deadline = performance.now() + 90_000;
  while (performance.now() < deadline) {
    const site = win.__sf?.sutroBaths;
    const twilight = site?.debugState?.().twilight;
    const lit = (twilight?.skyBlend ?? 0) > 0.985 && twilight?.inside === true;
    const cast = (site?.stats?.bathers ?? 0) > 0;
    if (site && lit && cast) return;
    await sleep(250);
  }
  console.warn("[demo:sutro-moment] hall never fully settled — filming anyway");
}

function buildMoment(look: Look & { title: string }, index: number): Demo {
  return {
    name: `sutro-moment-${String(index + 1).padStart(2, "0")}`,
    run(ctx) {
      if (!ctx.map || !ctx.sky) {
        console.warn(`[demo:${look.id}] map or sky unavailable`);
        return;
      }
      cleanPlate(ctx.hud);
      ctx.input.suspended = true;

      // The pocket owns the clock in here — it holds its own solved sunset hour
      // and would fight an authored setTimeOfDay. Leave the cycle off and let
      // the site's twilight authority stand.
      ctx.sky.cycleEnabled = false;

      const sf = (window as unknown as SutroWindow).__sf;
      sf?.worldCursor?.setEnabled?.(false);

      // Stand the player inside the hall FIRST and leave them mobile-but-still,
      // because the pocket latches on where the player is: it has to see them
      // in the room before it will start ramping the hour toward sunset.
      const held = { x: PLAYER_HOLD[0], y: PLAYER_HOLD[1], z: PLAYER_HOLD[2] };
      repin(held, ctx);

      void waitForTheHall().then(() => {
        freezePlayerInPlace(ctx, held.x, held.y, held.z);
        armCinematic(ctx, buildDefinition(look, held, ctx, sf));
      });
    }
  };
}

function buildDefinition(
  look: Look & { title: string },
  held: { x: number; y: number; z: number },
  ctx: DemoContext,
  sf: SutroWindow["__sf"]
): CinematicDefinition {
  return {
    name: look.id,
    duration: SUTRO_MOMENT_SECONDS,
    frame: () => {
      // The body still steps; hold it put so it cannot drift out of the
      // pocket's vertical gate and take the sunset with it.
      repin(held, ctx);
      sf?.worldCursor?.setEnabled?.(false);
    },
    shots: [
      {
        id: look.id,
        start: 0,
        end: SUTRO_MOMENT_SECONDS,
        camera: (sample, out) => holdLook(look, sample.u, out),
        // These are interior looks a metre off the furniture; the terrain floor
        // clamp has nothing useful to say, and occlusion is the point here —
        // people are meant to pass in front of the lens.
        safety: { floorClearance: 0, auditOcclusion: false }
      }
    ]
  };
}

function buildVista(look: Look & { title: string }, index: number): Demo {
  return {
    name: `sutro-vista-${String(index + 1).padStart(2, "0")}`,
    run(ctx) {
      if (!ctx.map || !ctx.sky) {
        console.warn(`[demo:${look.id}] map or sky unavailable`);
        return;
      }
      cleanPlate(ctx.hud);
      ctx.input.suspended = true;
      ctx.sky.cycleEnabled = false;

      const sf = (window as unknown as SutroWindow).__sf;
      sf?.worldCursor?.setEnabled?.(false);
      const held = { x: PLAYER_HOLD[0], y: PLAYER_HOLD[1], z: PLAYER_HOLD[2] };
      repin(held, ctx);

      void waitForTheHall().then(() => {
        freezePlayerInPlace(ctx, held.x, held.y, held.z);
        const definition = buildDefinition(look, held, ctx, sf);
        armCinematic(ctx, { ...definition, duration: SUTRO_VISTA_SECONDS, shots: [
          { ...definition.shots[0], end: SUTRO_VISTA_SECONDS }
        ] });
      });
    }
  };
}

export const sutroMomentDemos: readonly Demo[] = [
  ...LOOKS.map(buildMoment),
  ...VISTAS.map(buildVista)
];
