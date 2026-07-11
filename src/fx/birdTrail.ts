import * as THREE from "three/webgpu";
import {
  attribute,
  cameraPosition,
  clamp,
  cross,
  mix,
  mx_noise_float,
  normalize,
  positionGeometry,
  positionWorld,
  smoothstep,
  uniform,
  varying,
  vec3
} from "three/tsl";
import { LIGHT_SCALE } from "../config";
import { applyMaterialPolicy, RenderBand, tagTransparency } from "../render/transparency";

type N = any;

const LIFE = 2.4; // seconds a shed point burns before it's gone
const SPACING = 1.7; // metres of tip travel between shed points
const PTS = 130; // max control points per ribbon (stoop-length coverage)
const MIN_SPEED = 2.5; // below this the phoenix is hovering — no trail
const BREAK_DIST = 20; // teleport/big gap: sever the ribbon, don't bridge it

/**
 * One camera-facing light ribbon — the phoenix's tail-streamer trail. Same
 * shared-vertex triangle-strip recipe as the board's WakeRibbon (neighbouring
 * segments share a vertex pair, so curves stay watertight), but free in 3D:
 * instead of seating on the swell, each vertex pair billboards about the
 * trail's own tangent (offset along cross(tangent, view)), so the ribbon
 * always shows its face no matter how the flight path corkscrews. Age drives
 * everything in-shader: the ribbon widens and rises like a lifting ember
 * sheet, the palette cools from molten gold at the tail tip through rose to
 * a violet-pink afterglow, and world-anchored noise glints it into sparks.
 */
class LightRibbon {
  mesh: THREE.Mesh;
  #geo: THREE.BufferGeometry;
  #pos: THREE.BufferAttribute; // control point, duplicated per side
  #dir: THREE.BufferAttribute; // trail tangent at the point
  #t: THREE.BufferAttribute; // spawn time
  #uTime = uniform(0);
  #pts: { x: number; y: number; z: number; dx: number; dy: number; dz: number; t: number }[] = [];

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    const side = new Float32Array(PTS * 2);
    const idx: number[] = [];
    for (let i = 0; i < PTS; i++) {
      side[i * 2] = -0.5;
      side[i * 2 + 1] = 0.5;
      if (i > 0) {
        const a = (i - 1) * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
    this.#pos = new THREE.BufferAttribute(new Float32Array(PTS * 2 * 3), 3);
    this.#pos.setUsage(THREE.DynamicDrawUsage);
    this.#dir = new THREE.BufferAttribute(new Float32Array(PTS * 2 * 3), 3);
    this.#dir.setUsage(THREE.DynamicDrawUsage);
    this.#t = new THREE.BufferAttribute(new Float32Array(PTS * 2), 1);
    this.#t.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.#pos);
    geo.setAttribute("aDir", this.#dir);
    geo.setAttribute("aT", this.#t);
    geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
    geo.setIndex(idx);
    geo.setDrawRange(0, 0);
    this.#geo = geo;

    const mat = new THREE.MeshBasicNodeMaterial();
    const uT = this.#uTime as N;
    const aSide = attribute("aSide", "float") as N;
    const aDir = attribute("aDir", "vec3") as N;
    const aT = attribute("aT", "float") as N;
    const age = clamp(uT.sub(aT).div(LIFE), 0, 1) as N;

    // billboard about the tangent: the epsilon keeps normalize() finite when
    // the view lines up dead along the trail
    const lat = normalize(cross(aDir, cameraPosition.sub(positionGeometry)).add(vec3(0, 1e-4, 0))) as N;
    const width = mix(0.09, 1.0, (age as N).pow(0.7)) as N;
    // the spent trail lifts gently, an ember sheet shedding heat (eased drift,
    // same closed-form integral as the wake ribbons)
    const rise = age.sub(age.mul(age).mul(0.5)).mul(1.1) as N;
    mat.positionNode = positionGeometry.add(lat.mul(aSide.mul(width))).add(vec3(0, rise, 0));

    const vAge = varying(age) as N;
    // signed distance from the centreline, 0 core → 1 edge
    const sd = (varying(aSide.mul(2)) as N).abs() as N;
    const band = smoothstep(1.0, 0.25, sd) as N;
    // palette cools down the trail: molten gold fresh off the tip, rose-violet
    // afterglow at the end; a near-white hot line rides the centre
    const cool = vAge.pow(0.6) as N;
    const bodyC = mix(vec3(1.0, 0.5, 0.16), vec3(0.9, 0.26, 0.62), cool) as N;
    const coreC = mix(vec3(1.0, 0.95, 0.75), vec3(1.0, 0.55, 0.8), cool) as N;
    const col = mix(bodyC, coreC, smoothstep(0.3, 0.0, sd)) as N;
    // world-anchored drifting noise glints the sheet into sparks — multiply
    // only, never a branch (mx_noise inside If corrupts skipped pixels)
    const n = mx_noise_float(vec3(positionWorld.x.mul(1.8), positionWorld.y.mul(1.8), positionWorld.z.mul(1.8).add(uT.mul(2.0))) as N)
      .mul(0.5)
      .add(0.5) as N;
    const sparkle = n.mul(n).mul(n).mul(2.2).add(0.55) as N;
    // quick bloom-in just behind the tip (the trail "ignites"), long fade out
    const fade = (vAge.oneMinus() as N).pow(1.5).mul(smoothstep(0.0, 0.02, vAge)) as N;

    mat.colorNode = col.mul(band.mul(sparkle)).mul(fade).mul(0.14 * LIGHT_SCALE);
    applyMaterialPolicy(mat, "additiveWorld");
    mat.side = THREE.DoubleSide;
    mat.fog = false;

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    tagTransparency(this.mesh, { profile: "additiveWorld", renderBand: RenderBand.WATER_EFFECTS });
    this.mesh.visible = false; // hidden until the strip has ≥2 points to draw
    scene.add(this.mesh);
  }

  shed(p: THREE.Vector3, d: THREE.Vector3, t: number) {
    const last = this.#pts[this.#pts.length - 1];
    if (last && Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z) > BREAK_DIST) this.#pts.length = 0;
    if (this.#pts.length >= PTS - 1) this.#pts.shift();
    this.#pts.push({ x: p.x, y: p.y, z: p.z, dx: d.x, dy: d.y, dz: d.z, t });
  }

  /** Rebuild the strip: shed points oldest→newest, plus a live head vertex
   * pair glued to the streamer tip so the trail never lags the tail. */
  update(elapsed: number, head: { p: THREE.Vector3; d: THREE.Vector3 } | null) {
    this.#uTime.value = elapsed;
    const pts = this.#pts;
    while (pts.length && elapsed - pts[0].t >= LIFE) pts.shift();
    const n = pts.length + (head && pts.length ? 1 : 0);
    if (n < 2) {
      this.#geo.setDrawRange(0, 0);
      this.mesh.visible = false;
      return;
    }
    const posArr = this.#pos.array as Float32Array;
    const dirArr = this.#dir.array as Float32Array;
    const tArr = this.#t.array as Float32Array;
    let vi = 0;
    const put = (x: number, y: number, z: number, dx: number, dy: number, dz: number, t: number) => {
      for (let s = 0; s < 2; s++) {
        posArr[vi * 3] = x;
        posArr[vi * 3 + 1] = y;
        posArr[vi * 3 + 2] = z;
        dirArr[vi * 3] = dx;
        dirArr[vi * 3 + 1] = dy;
        dirArr[vi * 3 + 2] = dz;
        tArr[vi] = t;
        vi++;
      }
    };
    for (const p of pts) put(p.x, p.y, p.z, p.dx, p.dy, p.dz, p.t);
    if (head) put(head.p.x, head.p.y, head.p.z, head.d.x, head.d.y, head.d.z, elapsed);
    this.#pos.needsUpdate = true;
    this.#dir.needsUpdate = true;
    this.#t.needsUpdate = true;
    this.#geo.setDrawRange(0, (n - 1) * 6);
    this.mesh.visible = true;
  }
}

// the trail layer only needs these off the player
type BirdState = { mode: string; speed: number };

// per-tip tracking between frames
type TipState = { prev: THREE.Vector3; dir: THREE.Vector3; acc: number; live: boolean };

const WP = new THREE.Vector3();
const DELTA = new THREE.Vector3();

/**
 * Phoenix tail trails: one LightRibbon per outer tail streamer. The anchors
 * are Object3Ds dressPhoenix parents onto the tail05 bone (they resolve only
 * once the GLB loads), so the emit points ride the full procedural tail dance
 * — flare, ripple, bank-curl — for free. Points shed by distance the tip
 * itself travels, so a tail whip packs the ribbon exactly where the motion
 * was; hovering (below MIN_SPEED) lets the trail burn out.
 */
export class BirdTrails {
  #ribbons: [LightRibbon, LightRibbon];
  #tips: [TipState, TipState];
  #mesh: THREE.Group;

  constructor(scene: THREE.Scene, birdMesh: THREE.Group) {
    this.#mesh = birdMesh;
    this.#ribbons = [new LightRibbon(scene), new LightRibbon(scene)];
    const tip = (): TipState => ({ prev: new THREE.Vector3(), dir: new THREE.Vector3(0, 0, 1), acc: 0, live: false });
    this.#tips = [tip(), tip()];
  }

  update(elapsed: number, bird: BirdState) {
    const anchors = this.#mesh.userData.trailPoints as THREE.Object3D[] | undefined;
    const flying = bird.mode === "bird" && bird.speed >= MIN_SPEED && !!anchors;
    for (let i = 0; i < 2; i++) {
      const rib = this.#ribbons[i];
      const s = this.#tips[i];
      if (!flying) {
        // the shed trail lingers and fades on its own; forget the tip so a
        // mode swap or teleport can't bridge into one long segment
        s.live = false;
        s.acc = 0;
        rib.update(elapsed, null);
        continue;
      }
      anchors![i].getWorldPosition(WP);
      if (!s.live) {
        s.live = true;
        s.prev.copy(WP);
        rib.update(elapsed, null);
        continue;
      }
      DELTA.subVectors(WP, s.prev);
      const len = DELTA.length();
      if (len > 1e-3) s.dir.copy(DELTA).divideScalar(len);
      s.acc += len;
      if (s.acc >= SPACING) {
        s.acc %= SPACING;
        rib.shed(WP, s.dir, elapsed);
      }
      rib.update(elapsed, { p: WP, d: s.dir });
      s.prev.copy(WP);
    }
  }
}
