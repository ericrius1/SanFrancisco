/**
 * The plume a wave throws when it breaks at Ocean Beach.
 *
 * Shading alone can turn a crest white, and that reads as "there is foam on
 * that wave" — not as "that wave just went off". What sells a break is water
 * leaving the surface: the lip pitches, throws a curtain of spray several
 * metres into the air, and the wind holds it there for a second or two. At
 * sunset, with the sun behind it, that curtain is the brightest thing on the
 * beach.
 *
 * It is FULLY STATELESS on the GPU, and that is the whole design. There is no
 * emitter, no particle pool, no per-frame CPU loop and no buffer upload: every
 * droplet's position is a pure function of (its seed, the clock), evaluated in
 * the vertex stage from the same analytic crest train the water shader and the
 * audio read. A droplet knows which wave threw it because it re-derives that
 * wave from its own birth time. Per frame the CPU writes three uniforms.
 *
 * Spray only exists where a crest is actually crossing the break line, so the
 * field is quiet between sets and bursts along the sections that are going —
 * for free, because "is this wave breaking here, now" is one analytic
 * question, asked at the droplet's birth instant.
 *
 * Repo gotchas honored: SpriteNodeMaterial + instancedArray reads resolve in
 * the vertex stage (terrainScanParticles precedent); no If()/branches — pure
 * mix/step/smoothstep; dead droplets collapse to zero scale, and a degenerate
 * quad rasterizes to nothing.
 */

import * as THREE from "three/webgpu";
import {
  cameraPosition,
  float,
  fract,
  floor,
  instancedArray,
  instanceIndex,
  saturate,
  sin,
  smoothstep,
  uniform,
  uv,
  vec3,
  vec4,
  vertexStage
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { OCEAN_BEACH_SURF } from "./oceanBeachWaves";
import { oceanBeachBreakXNode, oceanBeachSurfField } from "./tslUtil";
import { SUN_DIR, SUN_STATE, type Sky } from "./sky";
import { twilightDirection, twilightFoamRadiance } from "./waterShadingTSL";

type N = any;

/**
 * One draw call's worth. Sized against what is actually on screen: only the
 * droplets whose birth instant caught a crest at the break line ever scale
 * above zero, which on a typical frame is a few hundred of these.
 */
const COUNT = 16_000;
/**
 * Metres of beach the field tiles over. Each droplet lives in ONE tile and is
 * wrapped to whichever copy of that tile is nearest the player, so the field
 * follows them along a 3.6 km beach without ever being 3.6 km wide. Droplets
 * fade out well before the tile seam, so the wrap is never visible.
 */
const SPAN = 620;
/** Seconds from the lip throwing a droplet to it landing back in the water. */
const LIFE = 2.1;

/** Per-droplet constants: (alongBeachZ, lifePhase, seedA, seedB). */
function buildSeeds(): Float32Array {
  const data = new Float32Array(COUNT * 4);
  // Deterministic, so the capture harness has nothing to seed. Three coprime
  // irrational strides, but the along-beach coordinate deliberately gets a
  // JITTERED one rather than the bare low-discrepancy sequence: an evenly
  // spread lattice put one droplet every few centimetres of beach and the
  // plume came out as a row of identical puffs at identical spacing. Real
  // spray is clumpy, and the clumps have to come from somewhere.
  for (let i = 0; i < COUNT; i++) {
    const a = (i * 0.618_033_988_75) % 1;
    const b = (i * 0.754_877_666_25) % 1;
    const c = (i * 0.322_757_609_46) % 1;
    const jitter = (Math.sin(i * 12.9898) * 43_758.545_3) % 1;
    data[i * 4] = (((a + jitter * 0.35 + 1) % 1) - 0.5) * SPAN;
    data[i * 4 + 1] = b;
    data[i * 4 + 2] = c;
    data[i * 4 + 3] = (a * 3.71 + c * 7.13) % 1;
  }
  return data;
}

export class OceanBeachSpray {
  readonly group = new THREE.Group();
  #material: THREE.SpriteNodeMaterial;
  #sprite: THREE.Sprite;
  #uTime = uniform(0);
  #uFocusZ = uniform(0);
  #uAmount = uniform(0);
  // The shared live sun vector, exactly as water.ts reads it.
  #uSunDir = uniform(SUN_DIR);
  #uSunRadiance = uniform(new THREE.Color(1, 1, 1));
  // Twilight foam light, mirroring water.ts: the horizon-band afterglow that
  // keeps the plume readable after sunRadiance dies with the disc.
  #uTwilightFoam = uniform(new THREE.Color(0, 0, 0));
  #uTwilightDir = uniform(new THREE.Vector3(-1, 0.06, 0).normalize());
  #amount = 0;
  #sky: Sky;
  #debugTime: number | null = null;

  constructor(sky: Sky) {
    this.#sky = sky;
    this.group.name = "ocean_beach_spray";

    const store = instancedArray(buildSeeds(), "vec4");
    const material = new THREE.SpriteNodeMaterial({
      transparent: true,
      depthWrite: false
    });
    this.#material = material;

    const b = OCEAN_BEACH_SURF;
    const seed = store.element(instanceIndex) as unknown as N;
    const t = this.#uTime as N;

    // --- which stretch of beach, and how old ------------------------------
    // Wrap the droplet's home tile to the copy nearest the player. floor(x+0.5)
    // is round(); at the seam a droplet jumps SPAN metres, which is why the
    // near-fade below closes well inside half a tile.
    const zHome = seed.x as N;
    const z = zHome
      .add(floor(this.#uFocusZ.sub(zHome).div(SPAN).add(0.5)).mul(SPAN))
      .toVar();
    const age = fract(t.div(LIFE).add(seed.y)).mul(LIFE).toVar();
    const born = t.sub(age).toVar();
    const life = age.div(LIFE).toVar();

    // --- the wave that threw it -------------------------------------------
    // Re-derive, at the BIRTH instant, where the break line was and where the
    // nearest crest sat relative to it. This is the whole gate: a droplet is
    // only ever thrown if there was a crest in the act of going, right there,
    // at the moment it left the lip.
    const shore = float(-6323).add(z.mul(0.08504)).add(z.mul(z).mul(0.00000743));
    const breakX = oceanBeachBreakXNode(shore, z, born).toVar();
    const travel = fract(born.mul(b.speed / b.spacing)).mul(b.spacing);
    const peel = sin(z.mul(0.0052).add(born.mul(0.18))).mul(13)
      .add(sin(z.mul(0.0017).sub(born.mul(0.09))).mul(6));
    // Signed distance from the break line to the nearest crest, in metres,
    // wrapped into ±half a wavelength.
    const q = breakX.sub(b.offshoreCrest).sub(travel).sub(peel).div(b.spacing);
    const gap = fract(q.add(0.5)).sub(0.5).mul(-b.spacing).toVar();
    const crestX = breakX.add(gap).toVar();
    // The throwing window, in metres of crest travel. It begins a little
    // before the line (the wave is already standing up and feathering), peaks
    // through the pitch, and then — instead of cutting off — decays into a
    // long spindrift tail that rides the broken roller most of the way to the
    // sand. The first cut ended the window 34 m past the line, which made
    // every crash a two-second event on an otherwise spray-less sea: real
    // onshore-wind surf smokes continuously off the whitewater, and that
    // smoke is half of what "crashing and splashing" means from the beach.
    const throwing = smoothstep(-12, 2, gap)
      .mul(smoothstep(30, 120, gap).oneMinus())
      .mul(smoothstep(60, 14, gap).mul(0.65).add(0.35))
      // Along-crest patchiness. A lip does not pitch evenly down its whole
      // length — it goes in bursts a few tens of metres wide, with quiet
      // shoulders between them — and without this the plume is a uniform
      // hedge the exact length of the visible crest. Two short, coprime
      // wavelengths (~44 m and ~17 m) drifting at different rates keep the
      // bursts from ever settling into a pattern.
      .mul(
        saturate(
          sin(z.mul(0.142).add(born.mul(0.9)))
            .mul(0.6)
            .add(sin(z.mul(0.371).sub(born.mul(1.7))).mul(0.4))
            .add(0.45)
        )
      )
      .toVar();

    // Height and mask straight from the shared field, sampled ON the crest.
    const crest = oceanBeachSurfField(crestX, z, born);
    const top = crest.height.add(0.5).toVar();

    // --- the throw INSTANT --------------------------------------------------
    // `gap` 0…breakThrow(+lipAhead-ish) is the two seconds the crown is
    // actually being pitched. The window above deliberately keeps its long
    // spindrift tail; this burst rides on top of it and is what makes the
    // crash explode on camera — bigger, denser, brighter puffs exactly while
    // the lip is in the air, scaling with the size of the set that threw it.
    const burst = smoothstep(-3, 5, gap)
      .mul(smoothstep(17, 34, gap).oneMinus())
      .toVar();
    // 0 for the small stuff, 1 for a proper set wave — the same amplitude the
    // audio weighs a crash by.
    const ampK = smoothstep(3.0, 7.0, crest.amp.mul(crest.mask)).toVar();
    const burstK = burst.mul(ampK.mul(0.5).add(0.5)).toVar();

    // --- ballistics --------------------------------------------------------
    // Three decorrelated draws from two stored seeds. The cone is mostly
    // vertical with a shoreward lean: a plunging lip throws its water up and
    // forward, and the onshore wind pushes what is left of it up the beach.
    const s1 = seed.z as N;
    const s2 = seed.w as N;
    const s3 = fract(s1.mul(5.17).add(s2.mul(2.39))).toVar();
    // Cubing the speed draw is what gives a plume its silhouette: most of the
    // water barely clears the lip and a thin tail of it goes high, so the
    // curtain is dense at the bottom and wispy at the top. A uniform draw
    // makes a slab with a flat ceiling.
    const fast = s2.mul(s2).mul(s2).toVar();
    const speed = float(3).add(fast.mul(13)).toVar();
    // The burst throws harder: up to +35% launch speed mid-throw on a big set
    // (apex height goes with vy², so the crash plume stands visibly taller),
    // while the spindrift tail keeps its old, subtle ballistics.
    const burstThrow = burstK.mul(0.55).add(1).toVar();
    const vy = speed.mul(float(0.7).add(s1.mul(0.28))).mul(burstThrow).toVar();
    const vx = speed.mul(float(0.14).add(s3.mul(0.34))).mul(burstThrow).toVar();
    const vz = s3.sub(0.5).mul(speed).mul(0.5).toVar();

    // Onshore wind, applied as an ACCELERATION rather than a launch velocity:
    // it barely touches a droplet at the lip and drags the top of the plume
    // visibly inshore, which is the lean a real curtain has.
    // `crest.lean` keeps the launch point ON the pitching crown — the height
    // field leans its peak shoreward through the break now, and a plume rooted
    // at the old crest line would trail the lip by several metres.
    const px = crestX.add(crest.lean).add(1.6).add(vx.mul(age)).add(age.mul(age).mul(1.9));
    const py = top.add(vy.mul(age)).sub(age.mul(age).mul(4.9));
    const pz = z.add(vz.mul(age));
    material.positionNode = vec3(px, py, pz);

    // --- coverage ----------------------------------------------------------
    // Fast in, slow out; gone the moment it falls back through the surface.
    const rise = smoothstep(0, 0.08, life);
    const fade = smoothstep(0.52, 1, life).oneMinus();
    const airborne = smoothstep(-0.6, 1.4, py);
    // Close the tile seam inside half a span, so a wrapping droplet is already
    // at zero scale when it teleports.
    const near = smoothstep(SPAN * 0.5, SPAN * 0.34, z.sub(this.#uFocusZ).abs());
    const alive = throwing
      .mul(rise)
      .mul(fade)
      .mul(airborne)
      .mul(near)
      .mul(crest.mask)
      // Nothing to throw where the swell is small.
      .mul(smoothstep(2.5, 5.5, crest.amp.mul(crest.mask)))
      .mul(this.#uAmount)
      .toVar();

    // Each sprite is a PUFF, not a droplet, and it is nearly transparent: the
    // curtain has to be built out of hundreds of overlapping faint puffs, so
    // that its edge is ragged and its middle is dense. Both failure modes were
    // instructive — big and opaque reads as a row of cotton balls, small and
    // opaque reads as nothing at all at a hundred metres.
    //
    // The far factor is the scan-particle trick: physically sized puffs
    // simply vanish past ~250 m (a two-metre puff is four pixels), so the sea
    // only ever smoked in the foreground while every distant roller broke
    // bone-dry. Growing the sprite up to 2.6× with camera distance keeps a
    // fine mist riding the far walls — it reads as haze blowing off the
    // crest, which is exactly what spindrift is at that range.
    const camDist = vec3(px, py, pz).sub(cameraPosition).length().toVar();
    material.scaleNode = float(0.75)
      .add(s1.mul(1.5))
      .mul(life.mul(1.9).add(1))
      .mul(camDist.div(140).clamp(1, 2.6))
      // Up to ~2.5× puff size through the throw of a big set — the burst is
      // built from the SAME sprites, just swollen, so count and draw stay put.
      .mul(burstK.mul(1.5).add(1))
      .mul(saturate(alive.mul(4)));

    // --- light -------------------------------------------------------------
    // Spray is a cloud of droplets, so it is sky-lit from every side and
    // strongly FORWARD-scattering: looking into a low sun through a plume is
    // the whole reason this feature earns its cost at sunset. The forward lobe
    // is resolved per droplet against its own position, so a plume brightens
    // as the shot swings onto the sun rather than at a fixed rate.
    const viewDirN = (vec3(px, py, pz).sub(cameraPosition) as N).normalize().toVar();
    const forward = saturate(viewDirN.dot(this.#uSunDir as N));
    const glow = forward.mul(forward).mul(forward).toVar();
    // Afterglow lobe, mirroring the water BRDF's twilight foam term: the
    // horizon band spans a wide arc, so it is a BROAD lobe with a floor —
    // every framing keeps its plume readable, brightest looking into the glow.
    // #uTwilightFoam is zero outside the twilight window, so day/night pay
    // nothing but the multiply.
    const twiForward = saturate(viewDirN.dot(this.#uTwilightDir as N));
    const twiGlow = twiForward.mul(twiForward).toVar();
    // instanceIndex-derived values resolve in the vertex stage; anything the
    // fragment needs has to cross explicitly (terrainScanParticles precedent).
    const shaded = vertexStage(
      this.#sky
        .ambientRadiance()
        .mul(0.45)
        .add((this.#uSunRadiance as N).mul(glow.mul(1.35).add(0.05)))
        .add((this.#uTwilightFoam as N).mul(twiGlow.mul(1.1).add(0.4)))
        // A mid-throw plume is denser water, so it scatters brighter.
        .mul(burstK.mul(0.8).add(1))
        .mul(LIGHT_SCALE)
    ) as N;
    // Thinner as it disperses: a big late puff is mist, not water — but the
    // throw instant is dense: up to ~1.8× coverage while the crown is in the
    // air, which with the size/brightness terms is what reads as an explosion.
    const cover = vertexStage(
      alive.mul(float(0.48).sub(life.mul(0.2))).mul(burstK.mul(1.8).add(1))
    ) as N;

    material.colorNode = vec4(shaded, 1);
    // A soft, wide-shouldered puff rather than a disc with an edge — a hard
    // rim on a nearly-transparent sprite is the one thing that makes an
    // overlapping stack read as discrete sprites.
    material.opacityNode = smoothstep(0.5, 0.05, (uv() as N).sub(0.5).length()).mul(cover);
    material.blending = THREE.NormalBlending;

    const sprite = new THREE.Sprite(material);
    sprite.count = COUNT;
    // The field is player-relative and its own near-fade bounds it; a bounding
    // sphere computed from the placeholder geometry would cull the whole thing.
    sprite.frustumCulled = false;
    sprite.renderOrder = 3;
    this.#sprite = sprite;
    this.group.add(sprite);
  }

  /** Harness hook: pin the clock so a still lands on a chosen wave phase. */
  setDebugTime(time: number | null): void {
    this.#debugTime = time;
  }

  update(time: number, dt: number, focus: THREE.Vector3): void {
    this.#uTime.value = this.#debugTime ?? time;
    this.#uFocusZ.value = focus.z;
    this.#amount = Math.min(1, this.#amount + dt / 0.8);
    this.#uAmount.value = this.#amount;
    this.#uSunRadiance.value.copy(this.#sky.sun.color).multiplyScalar(this.#sky.sun.intensity);
    // TRUE solar state — SUN_DIR/sun.* have handed over to the moon by −2°.
    twilightFoamRadiance(SUN_STATE.elevationDeg, this.#uTwilightFoam.value);
    twilightDirection(SUN_STATE.toSun, this.#uTwilightDir.value);
  }

  debugState() {
    return { count: COUNT, span: SPAN, life: LIFE, amount: this.#amount };
  }

  dispose(): void {
    this.group.removeFromParent();
    this.#sprite.geometry.dispose();
    this.#material.dispose();
  }
}
