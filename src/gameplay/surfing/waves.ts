import * as THREE from "three/webgpu";
import {
  positionLocal,
  uniform,
  vec3,
  color,
  float,
  mix,
  smoothstep,
  clamp,
  max,
  mx_noise_float
} from "three/tsl";
import {
  OCEAN_BEACH_SURF,
  oceanBeachCrestX,
  oceanBeachFoamNoise
} from "../../world/oceanBeachWaves";
import { oceanBeachSurfField, bumpNormal } from "../../world/tslUtil";
import { LIGHT_SCALE } from "../../config";

const SLOTS = 7;

// High-res green face patch. The strip runs the break in X and follows the
// surfer along the beach (Z). Fine X tessellation resolves the steep ~7.5 m
// shoreward face crisply (the old shared 96-seg bay patch smeared it into a
// low-poly shelf); it only builds/updates near Ocean Beach.
const FACE_CENTER_X = -6045;
const FACE_WIDTH_X = 600; // covers offshoreCrest−30 … maxX+15
const FACE_WINDOW_Z = 460; // player-following window down the beach
const FACE_SEG_X = 256; // ~2.3 m — 3 verts across the breaking face
const FACE_SEG_Z = 60;

/**
 * Kelly-Slater-style breaking swell for Ocean Beach: a translucent emerald wall
 * with a pitching white lip and spent whitewater, rendered from the same
 * analytic crest the surf controller rides (oceanBeachSurfField). A localized
 * crest-spray layer sits on top for the breaking silhouette.
 */
export class OceanBeachWaves {
  readonly group = new THREE.Group();
  readonly activeWaveCount = SLOTS;

  #spray: THREE.Points;
  #sprayPositions: Float32Array;
  #sprayVelocity: Float32Array;
  #face: THREE.Mesh;
  #uTime = uniform(0);
  #uOrigin = uniform(new THREE.Vector2(FACE_CENTER_X, OCEAN_BEACH_SURF.centerZ));

  constructor(scene: THREE.Scene) {
    this.group.name = "ocean_beach_breaking_waves";

    this.#face = this.#buildFaceMesh();
    this.group.add(this.#face);

    const sprayCount = 640;
    this.#sprayPositions = new Float32Array(sprayCount * 3);
    this.#sprayVelocity = new Float32Array(sprayCount * 3);
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute("position", new THREE.BufferAttribute(this.#sprayPositions, 3));
    sprayGeo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(FACE_CENTER_X, 3, OCEAN_BEACH_SURF.centerZ),
      2400
    );
    const sprayMat = new THREE.PointsMaterial({
      color: 0xf2ffff,
      size: 1.15,
      transparent: true,
      opacity: 0.82,
      depthWrite: false,
      sizeAttenuation: true
    });
    this.#spray = new THREE.Points(sprayGeo, sprayMat);
    this.#spray.renderOrder = 100;
    this.group.add(this.#spray);

    scene.add(this.group);
    this.update(0);
  }

  #buildFaceMesh(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(FACE_WIDTH_X, FACE_WINDOW_Z, FACE_SEG_X, FACE_SEG_Z);
    geo.rotateX(-Math.PI / 2); // local x → world X (across break), local z → world Z (down beach)

    const mat = new THREE.MeshStandardNodeMaterial({
      roughness: 0.24,
      metalness: 0,
      transparent: true,
      depthWrite: false
    });
    const t = this.#uTime;
    const wx = positionLocal.x.add(this.#uOrigin.x);
    const wz = positionLocal.z.add(this.#uOrigin.y);
    const f = oceanBeachSurfField(wx, wz, t);

    // --- vertex: lift by the analytic wave height -----------------------------
    mat.positionNode = positionLocal.add(vec3(0, f.height, 0));

    // strip + window feathering so the patch melts into the flat bay water
    const stripFade = f.mask; // already 0 outside the break, feathered inside
    const zRim = smoothstep(float(FACE_WINDOW_Z * 0.5), float(FACE_WINDOW_Z * 0.5 - 60), positionLocal.z.abs());

    // --- colour: chlorophyll green, backlit face, breaking foam ---------------
    // deep trough → mid sea green → bright translucent emerald on the standing
    // face; the pitching lip and spent whitewater go white.
    const bodyGreen = mix(color(0x0a5a48), color(0x1ba06f), clamp(f.height.mul(0.32).add(0.35), 0, 1));
    const faceGreen = mix(bodyGreen, color(0x3fe08a), f.face.mul(0.9));
    const foam = clamp(f.lip.mul(1.1).add(f.white.mul(0.85)), 0, 1).toVar();
    mat.colorNode = mix(faceGreen, color(0xf3fffa), foam);

    // SSS backlight: the thin, steep face glows emerald where the sun rakes
    // through it (stylized — KSPS look, not a physical transmission model).
    const glow = f.face.mul(f.face).mul(0.5 * LIGHT_SCALE);
    mat.emissiveNode = vec3(0.12, 0.62, 0.34).mul(glow).add(vec3(0.9, 1.0, 0.96).mul(foam.mul(0.06 * LIGHT_SCALE)));

    // ripple bump from the wave height + a little chop so the face isn't glassy
    const chop = mx_noise_float(vec3(wx.mul(0.22), wz.mul(0.22), t.mul(0.6))).mul(0.12);
    mat.normalNode = bumpNormal(f.height.add(chop).mul(0.5));

    // shallow face is translucent (green water you see through), foam opaque
    const alpha = clamp(mix(float(0.7), float(0.95), max(f.face, f.height.mul(0.2))).add(foam.mul(0.3)), 0, 1);
    mat.opacityNode = alpha.mul(stripFade).mul(zRim);
    mat.envMapIntensity = 0.2;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "ocean_beach_surf_face";
    // Fixed strip in X (the break doesn't move), player-following in Z. World X =
    // FACE_CENTER_X + localX, matching the shader's uOrigin.x so geometry and the
    // sampled wave field line up.
    mesh.position.x = FACE_CENTER_X;
    mesh.position.y = 0.04; // just above the bay near-patch (0.02) where they meet
    mesh.renderOrder = 12; // after bay water (far 10 / lagoon 10.5 / near 11)
    mesh.frustumCulled = false;
    return mesh;
  }

  update(time: number, focus?: { x: number; z: number }) {
    this.#uTime.value = time;
    const b = OCEAN_BEACH_SURF;

    const near =
      !focus ||
      (focus.x > b.minX - 1400 &&
        focus.x < b.maxX + 1400 &&
        focus.z > b.minZ - 900 &&
        focus.z < b.maxZ + 900);
    this.group.visible = near;
    if (!near) return;

    // slide the face patch down the beach with the surfer, snapped to its own Z
    // grid so vertices don't swim under the analytic crest
    if (focus) {
      const snap = FACE_WINDOW_Z / FACE_SEG_Z;
      const z = Math.round(THREE.MathUtils.clamp(focus.z, b.minZ, b.maxZ) / snap) * snap;
      this.#face.position.z = z;
      this.#uOrigin.value.set(FACE_CENTER_X, z);
    }

    const focusZ = focus && focus.z > b.minZ - 600 && focus.z < b.maxZ + 600 ? focus.z : b.entryZ;
    const stripMinZ = Math.max(b.minZ, focusZ - 380);
    const stripMaxZ = Math.min(b.maxZ, focusZ + 380);
    const sp = this.#sprayPositions;
    const sv = this.#sprayVelocity;
    const count = sp.length / 3;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      const life = (time * (0.42 + (i % 7) * 0.018) + i * 0.137) % 1;
      const z = THREE.MathUtils.lerp(stripMinZ, stripMaxZ, ((i * 0.6180339) % 1 + time * 0.006) % 1);
      const slot = (i % SLOTS) - 1;
      const crestX = oceanBeachCrestX(slot, z, time);
      const amp = b.amplitude * (0.78 + Math.sin(z * 0.0041 + time * 0.1) * 0.12);
      const gust = oceanBeachFoamNoise(z, time, i % 13);
      sv[k] = 2.3 + gust * 2.2;
      sv[k + 1] = 3.1 + gust * 4.6;
      sv[k + 2] = Math.sin(i * 9.17) * 1.8;
      sp[k] = crestX + 2 + sv[k] * life;
      sp[k + 1] = amp * 0.95 + sv[k + 1] * life - 5.9 * life * life;
      sp[k + 2] = z + sv[k + 2] * life;
    }
    (this.#spray.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}
