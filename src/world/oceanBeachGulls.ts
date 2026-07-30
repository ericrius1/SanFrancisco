/**
 * Gulls over the Ocean Beach surf.
 *
 * Background life, and deliberately nothing more than that: a couple of dozen
 * faceted silhouettes beating up the beach and wheeling back, a long way out,
 * small in frame. They are there so the air over the water is not empty — a
 * sunset beach with a breaking swell and no birds in it reads as a render.
 *
 * One geometry, one material, one draw call. Every path, heading, bank and
 * wing beat is evaluated in the WebGPU vertex stage from static instance data,
 * so the CPU uploads nothing per frame and never touches a matrix: the same
 * discipline as the Beach Pianist's grove birds (world/beachPianist/birds.ts).
 * That module's material is not reused because its flight is an orbit with a
 * perch cycle onto real tree crowns, and none of that survives contact with a
 * gull — these want long racetracks along the shore, a glide-with-bursts wing
 * beat, and no landing at all.
 *
 * Like the spray field, the flock tiles along the beach and wraps to whichever
 * copy of its tile is nearest the player, so it follows them down three
 * kilometres of coast without ever being three kilometres wide.
 */

import * as THREE from "three/webgpu";
import {
  attribute,
  cos,
  float,
  floor,
  instancedBufferAttribute,
  mix,
  positionLocal,
  saturate,
  sin,
  smoothstep,
  uniform,
  vec3,
  vec4
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { SUN_DIR, type Sky } from "./sky";

type N = any;

/** Small enough to stay background, big enough that the sky is never empty. */
const COUNT = 22;
/**
 * Metres of beach the flock tiles over; see the wrap in the vertex stage.
 *
 * Deliberately tight. The first cut used 760 m and spread the birds over a
 * kilometre of coast once their own circuits were added, which put most of
 * them outside the frame entirely and the rest four to six hundred metres out,
 * where a two-metre bird is three pixels. A flock has to be near the person
 * looking at it.
 */
const SPAN = 420;

type Vertex = { x: number; y: number; z: number; wingSide?: number; wingWeight?: number };

/**
 * A gull silhouette: slim body, long swept wings, a shallow forked tail.
 * Roughly 1.2 m of span at unit scale. Faceted on purpose — these are seen at
 * a hundred metres and up, where a smooth model reads as a smudge and a
 * hard-edged one reads as a bird.
 */
function createGullGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const wingData: number[] = [];
  const push = (v: Vertex) => {
    positions.push(v.x, v.y, v.z);
    wingData.push(v.wingSide ?? 0, v.wingWeight ?? 0);
  };
  const triangle = (a: Vertex, b: Vertex, c: Vertex) => {
    push(a);
    push(b);
    push(c);
  };

  // Body: five 5-gon sections. Fewer sides than the grove birds because a gull
  // is longer and thinner and this one is further away.
  const sections = [
    { z: -0.3, rx: 0.022, ry: 0.02 },
    { z: -0.14, rx: 0.056, ry: 0.048 },
    { z: 0.04, rx: 0.072, ry: 0.062 },
    { z: 0.2, rx: 0.05, ry: 0.046 },
    { z: 0.32, rx: 0.024, ry: 0.024 }
  ] as const;
  const ring = sections.map((section) =>
    Array.from({ length: 5 }, (_, i): Vertex => {
      const a = (i / 5) * Math.PI * 2;
      return { x: Math.cos(a) * section.rx, y: Math.sin(a) * section.ry, z: section.z };
    })
  );
  for (let s = 0; s < ring.length - 1; s++) {
    for (let i = 0; i < 5; i++) {
      const j = (i + 1) % 5;
      triangle(ring[s][i], ring[s + 1][i], ring[s][j]);
      triangle(ring[s][j], ring[s + 1][i], ring[s + 1][j]);
    }
  }

  // Shallow forked tail.
  const tailRoot = { x: 0, y: 0, z: -0.2 };
  triangle(tailRoot, { x: -0.07, y: -0.006, z: -0.44 }, { x: -0.008, y: 0.004, z: -0.33 });
  triangle(tailRoot, { x: 0.008, y: 0.004, z: -0.33 }, { x: 0.07, y: -0.006, z: -0.44 });

  // Head and a short beak — two triangles' worth of forward silhouette.
  triangle(
    { x: 0, y: 0.026, z: 0.3 },
    { x: -0.026, y: -0.008, z: 0.3 },
    { x: 0, y: -0.002, z: 0.44 }
  );
  triangle(
    { x: 0.026, y: -0.008, z: 0.3 },
    { x: 0, y: 0.026, z: 0.3 },
    { x: 0, y: -0.002, z: 0.44 }
  );

  // Wings. Long, swept back, and tapering to a point — the one shape that
  // makes a distant bird read as a gull rather than as a pigeon. `wingSide`
  // lets the GPU rotate each wing rigidly about its root; `wingWeight` runs
  // root-to-tip and is what bends the outer half harder than the inner.
  for (const side of [-1, 1] as const) {
    const rootFront = { x: side * 0.028, y: 0.014, z: 0.1, wingSide: side, wingWeight: 0 };
    const rootRear = { x: side * 0.034, y: -0.002, z: -0.09, wingSide: side, wingWeight: 0 };
    const midFront = { x: side * 0.26, y: 0.01, z: 0.05, wingSide: side, wingWeight: 0.46 };
    const midRear = { x: side * 0.28, y: -0.008, z: -0.15, wingSide: side, wingWeight: 0.54 };
    const tip = { x: side * 0.6, y: 0.004, z: -0.14, wingSide: side, wingWeight: 1 };
    if (side < 0) {
      triangle(rootFront, rootRear, midFront);
      triangle(midFront, rootRear, midRear);
      triangle(midFront, midRear, tip);
    } else {
      triangle(rootFront, midFront, rootRear);
      triangle(midFront, midRear, rootRear);
      triangle(midFront, tip, midRear);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("gullWing", new THREE.Float32BufferAttribute(wingData, 2));
  // No normal attribute: the flat-tinted basic material never shades, and the
  // freed vertex-buffer slot keeps the instanced streams inside WebGPU's
  // 8-buffer limit (exceeding it silently kills the draw).
  geometry.computeBoundingSphere();
  geometry.name = "oceanBeachGulls.geometry";
  return geometry;
}

/** Deterministic 0..1 — no Math.random, so a capture replays identically. */
function hash01(i: number, salt: number): number {
  const s = Math.sin(i * 127.1 + salt * 311.7) * 43_758.5453;
  return s - Math.floor(s);
}

export class OceanBeachGulls {
  readonly group = new THREE.Group();
  #mesh: THREE.InstancedMesh;
  #material: THREE.MeshBasicNodeMaterial;
  #uFocusZ = uniform(0);
  #uAmount = uniform(0);
  #uSunDir = uniform(SUN_DIR);
  #uSunTint = uniform(new THREE.Color(1, 1, 1));
  #uSkyTint = uniform(new THREE.Color(0.5, 0.55, 0.6));
  #amount = 0;
  #sky: Sky;
  #debugTime: number | null = null;
  #uTime = uniform(0);

  constructor(sky: Sky) {
    this.#sky = sky;
    this.group.name = "ocean_beach_gulls";

    const geometry = createGullGeometry();
    // home: z on the tile, metres offshore of the waterline, base altitude
    const home = new Float32Array(COUNT * 3);
    // motion: radius along the beach, radius across it, angular rate, phase
    const motion = new Float32Array(COUNT * 4);
    // style: body scale, vertical wander, wing rate, glide-burst phase
    const style = new Float32Array(COUNT * 4);

    for (let i = 0; i < COUNT; i++) {
      const a = hash01(i, 1);
      const b = hash01(i, 2);
      const c = hash01(i, 3);
      const d = hash01(i, 4);
      home[i * 3] = (i / COUNT - 0.5) * SPAN + (a - 0.5) * 26;
      // Over the break and a little beyond it. The first cut put most of the
      // flock 150-470 m out, where a 1.5 m bird is six pixels and the marine
      // layer has most of those: measurably present, visually absent. These
      // ranges keep them unobtrusive without making them invisible.
      home[i * 3 + 1] = b < 0.35 ? 22 + b * 78 : 55 + b * 130;
      home[i * 3 + 2] = 8 + c * 30;
      motion[i * 4] = 22 + a * 42;
      motion[i * 4 + 1] = 10 + c * 20;
      // Slow. A gull covers its racetrack in a minute, not in five seconds.
      motion[i * 4 + 2] = 0.055 + d * 0.055;
      motion[i * 4 + 3] = (a * 5.31 + c * 2.17) % (Math.PI * 2);
      style[i * 4] = 2.6 + b * 1.4;
      style[i * 4 + 1] = 1.4 + d * 3.6;
      style[i * 4 + 2] = 5.4 + c * 3.2;
      style[i * 4 + 3] = (b * 7.13 + d * 3.71) % (Math.PI * 2);
    }

    const material = new THREE.MeshBasicNodeMaterial({
      side: THREE.DoubleSide,
      depthWrite: true,
      // No scene fog: these are close-range silhouettes and fog lifts them
      // straight back toward sky colour, which is the one thing they must not
      // be. The distance range they live in is short enough that the missing
      // aerial perspective is not visible.
      fog: false,
      toneMapped: true
    });
    this.#material = material;

    const homeN = instancedBufferAttribute(new THREE.InstancedBufferAttribute(home, 3)) as N;
    const motionN = instancedBufferAttribute(new THREE.InstancedBufferAttribute(motion, 4)) as N;
    const styleN = instancedBufferAttribute(new THREE.InstancedBufferAttribute(style, 4)) as N;
    const wing = attribute("gullWing", "vec2") as N;
    const t = this.#uTime as N;

    // Clamp every instanced control before it reaches position math. These
    // buffers are static, but a bad read must never turn a background bird
    // into a screen-spanning triangle.
    const radiusAlong = motionN.x.clamp(4, 160);
    const radiusAcross = motionN.y.clamp(2, 80);
    const rate = motionN.z.clamp(0.005, 0.4);
    const phase = motionN.w.clamp(0, Math.PI * 2);
    const bodyScale = styleN.x.clamp(0.3, 4);
    const wander = styleN.y.clamp(0, 8);
    const wingRate = styleN.z.clamp(1, 12);
    const burstPhase = styleN.w.clamp(0, Math.PI * 2);

    // Wrap the gull's home tile to the copy nearest the player, exactly as the
    // spray field does. floor(x+0.5) is round().
    const zHome = homeN.x as N;
    const zTile = zHome
      .add(floor(this.#uFocusZ.sub(zHome).div(SPAN).add(0.5)).mul(SPAN))
      .toVar();

    /**
     * The racetrack, in metres relative to the gull's home. Long along the
     * beach, narrow across it, with the travel phase warped so the bird eases
     * through the turns instead of running at constant angular speed. The
     * warp's derivative stays positive, so it can never fly backwards.
     */
    const pathAt = (clock: N): { along: N; across: N; lift: N } => {
      const w = clock
        .mul(rate)
        .add(phase)
        .add(sin(clock.mul(rate).add(phase).mul(0.83)).mul(0.22))
        .toVar();
      return {
        along: sin(w).mul(radiusAlong),
        across: cos(w).mul(radiusAcross),
        lift: sin(w.mul(1.37).add(phase)).mul(wander).add(sin(w.mul(0.61)).mul(wander).mul(0.4))
      };
    };

    // Sample the same path a moment ahead to get a true flight frame. Two
    // evaluations of six sines is cheaper than any stored velocity would be.
    const here = pathAt(t);
    const ahead = pathAt(t.add(0.35));

    // Waterline at the gull's own Z — twin of oceanBeachApproxShoreX, so the
    // flock follows the curve of the beach instead of a straight line.
    const zWorld = zTile.add(here.along).toVar();
    const shore = float(-6323).add(zWorld.mul(0.08504)).add(zWorld.mul(zWorld).mul(0.00000743));
    const offshore = homeN.y.clamp(10, 520).add(here.across).toVar();
    const centre = vec3(
      shore.sub(offshore),
      homeN.z.clamp(4, 60).add(here.lift),
      zWorld
    ).toVar();

    // Heading from the look-ahead, in world XZ.
    const dAlong = ahead.along.sub(here.along);
    const dAcross = ahead.across.sub(here.across);
    const dLift = ahead.lift.sub(here.lift);
    const forward = vec3(dAcross.negate(), dLift, dAlong).normalize().toVar();
    const right = vec3(forward.z, 0, forward.x.negate()).normalize().toVar();
    const up = right.cross(forward).toVar();

    // Bank into the turn. The cross product's Y is the signed turn rate, which
    // is exactly the roll a bird uses to make that turn.
    const turn = saturate(dAcross.mul(0.06).add(0.5)).sub(0.5).mul(2);
    const bank = turn.mul(0.9).clamp(-0.85, 0.85).toVar();
    const bankC = cos(bank);
    const bankS = sin(bank);

    /**
     * Wings. A gull glides far more than it flaps: this is a held wing most of
     * the time with occasional bursts of beats, which is most of what makes
     * one recognisable at distance. `burst` is a slow gate on the beat.
     */
    const burst = smoothstep(0.45, 0.8, sin(t.mul(0.19).add(burstPhase)).mul(0.5).add(0.5)).toVar();
    const beat = sin(t.mul(wingRate).add(phase)).mul(burst).toVar();
    // Held wings still carry a dihedral, and a pronounced one: at four pixels
    // across, a flat wing is an ambiguous dash and a shallow V is
    // unmistakably a bird. The outer half moves more than the root —
    // `wingWeight` runs 0 at the shoulder to 1 at the tip.
    const flap = beat.mul(0.55).add(0.26).mul(wing.y).toVar();
    const local = positionLocal.toVar() as N;
    const wingLift = flap.mul(local.x.abs());
    const shaped = vec3(
      local.x,
      local.y.add(wingLift),
      local.z.sub(flap.mul(local.x.abs()).mul(0.16))
    ) as N;

    // Roll about the flight axis, then into the world frame.
    // Close the tile seam well inside half a span, so a bird that wraps to the
    // far copy of its tile is already at zero size when it teleports.
    const near = smoothstep(SPAN * 0.5, SPAN * 0.33, zWorld.sub(this.#uFocusZ).abs()).toVar();
    const rolled = vec3(
      shaped.x.mul(bankC).sub(shaped.y.mul(bankS)),
      shaped.x.mul(bankS).add(shaped.y.mul(bankC)),
      shaped.z
    ).mul(bodyScale).mul(this.#uAmount).mul(near);
    material.positionNode = centre
      .add(right.mul(rolled.x))
      .add(up.mul(rolled.y))
      .add(forward.mul(rolled.z));

    // Flat silhouette, and a genuinely DARK one.
    //
    // The number that matters here is LIGHT_SCALE ≈ 16.7: this is a linear
    // HDR pipeline, and a sunset sky sits somewhere around 1.5-3 in it. The
    // first cut asked for "a dark grey times LIGHT_SCALE", which came out at
    // roughly sky brightness — twenty-two birds rendering perfectly, every one
    // of them the same colour as the background it was in front of. A cut-out
    // against a bright sky has to be well under 1.
    //
    // The sun term is a narrow rim (fourth power of how side-on the bird is)
    // where the low sun rakes a wing, not a body fill.
    const sunLit = saturate(right.dot(this.#uSunDir as N).abs()).toVar();
    const rim = sunLit.mul(sunLit).mul(sunLit).mul(sunLit).toVar();
    material.colorNode = (vec4 as N)(
      mix(
        // A neutral dark, NOT a tinted sky colour: sampling the sky for the
        // body made twenty-two green specks on a pink sky, which reads as
        // dirt on the lens rather than as birds.
        vec3(0.026, 0.024, 0.026),
        (this.#uSunTint as N).mul(0.085),
        rim.mul(0.55)
      ).mul(LIGHT_SCALE),
      1
    );

    // InstancedMesh, not a Mesh with `count` — that shortcut works for Sprite
    // and silently draws nothing here. Instance matrices stay IDENTITY: three
    // applies them to positionLocal BEFORE a custom positionNode runs, so any
    // translation stored there would be re-transformed by the flight frame
    // below and scatter the flock (same trap the grove birds document).
    const mesh = new THREE.InstancedMesh(geometry, material, COUNT);
    mesh.name = "oceanBeachGulls.oneDraw";
    // IDENTITY, explicitly. `new InstancedMesh(...)` allocates instanceMatrix
    // as a ZERO-filled Float32Array, and three applies that matrix to
    // positionLocal before a custom positionNode runs — so without this every
    // vertex arrives at the origin, the flight frame scales a point by a
    // point, and the whole flock renders as nothing at all. It draws, it
    // reports 34 instances, and it is invisible.
    const identity = new THREE.Matrix4();
    for (let i = 0; i < COUNT; i++) mesh.setMatrixAt(i, identity);
    mesh.instanceMatrix.needsUpdate = true;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    // Player-relative, and bounded by its own tile wrap; a bounding sphere off
    // the static geometry would cull the whole flock.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    this.#mesh = mesh;
    this.group.add(mesh);
  }

  /** Harness hook: pin the clock so a still lands on a chosen wing phase. */
  setDebugTime(time: number | null): void {
    this.#debugTime = time;
  }

  update(time: number, dt: number, focus: THREE.Vector3): void {
    this.#uTime.value = this.#debugTime ?? time;
    this.#uFocusZ.value = focus.z;
    this.#amount = Math.min(1, this.#amount + dt / 1.2);
    this.#uAmount.value = this.#amount;
    this.#uSunTint.value.copy(this.#sky.sun.color);
    this.#uSkyTint.value.setRGB(0.46, 0.5, 0.58);
  }

  debugState() {
    return { count: COUNT, span: SPAN, amount: this.#amount };
  }

  dispose(): void {
    this.group.removeFromParent();
    this.#mesh.geometry.dispose();
    this.#material.dispose();
  }
}
