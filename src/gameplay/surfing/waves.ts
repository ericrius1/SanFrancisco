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
  sin,
  mx_noise_float
} from "three/tsl";
import {
  OCEAN_BEACH_SURF,
  oceanBeachCrestX,
  oceanBeachFoamNoise
} from "../../world/oceanBeachWaves";
import { oceanBeachSurfField, bumpNormal } from "../../world/tslUtil";
import { LIGHT_SCALE } from "../../config";
import { waterHeight } from "../../world/heightmap";

const SLOTS = 7;

// High-res green face patch. The strip runs the break in X and follows the
// surfer along the beach (Z). Fine X tessellation resolves the steep ~7.5 m
// shoreward face crisply (the old shared 96-seg bay patch smeared it into a
// low-poly shelf); it only builds/updates near Ocean Beach.
const FACE_CENTER_X = -6045;
const FACE_WIDTH_X = 600; // covers offshoreCrest−30 … maxX+15
const FACE_WINDOW_Z = 520; // player-following window down the beach
const FACE_SEG_X = 340; // ~1.75 m — resolves the steep shoreward face crisply
const FACE_SEG_Z = 168; // graded (below): ~1.4 m at the rider, ~5 m at the rim

/**
 * Player-following face grid with **graded Z resolution**: vertices bunch tight
 * around the rider (window centre) and smoothly spread toward the rim. Because
 * the whole patch re-centres on the surfer every frame, this reads as one
 * continuous sheet that is dense exactly where you look and coarsens with
 * distance — no discrete LOD, no seam. X stays uniform (the break's steep face
 * needs even sampling across its whole width).
 */
function buildGradedFaceGeometry(): THREE.BufferGeometry {
  const nx = FACE_SEG_X + 1;
  const nz = FACE_SEG_Z + 1;
  const halfZ = FACE_WINDOW_Z / 2;
  const pos = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const idx: number[] = [];
  // centred, symmetric bunching: blend linear + cubic so ~⅓ of the rows sit in
  // the middle ~15 % of the window (dense) while the rim stays gentle (coarse).
  const gradeZ = (t: number) => {
    const u = t * 2 - 1; // [-1,1]
    const s = Math.sign(u);
    const a = Math.abs(u);
    return s * (0.32 * a + 0.68 * a * a * a); // dense centre, coarse rim
  };
  for (let j = 0; j < nz; j++) {
    const z = gradeZ(j / FACE_SEG_Z) * halfZ;
    for (let i = 0; i < nx; i++) {
      const x = (i / FACE_SEG_X - 0.5) * FACE_WIDTH_X;
      const k = (j * nx + i) * 3;
      pos[k] = x;
      pos[k + 1] = 0;
      pos[k + 2] = z;
      const uk = (j * nx + i) * 2;
      uvs[uk] = i / FACE_SEG_X;
      uvs[uk + 1] = j / FACE_SEG_Z;
    }
  }
  for (let j = 0; j < FACE_SEG_Z; j++) {
    for (let i = 0; i < FACE_SEG_X; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

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
  #foam: THREE.Points;
  #foamPositions: Float32Array;
  #foamVelocity: Float32Array;
  #foamLife: Float32Array;
  #lastTime = 0;
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

    // Persistent Lagrangian whitewater. These flecks are born at compressed
    // crest fronts, advect shoreward, curl down the line and slowly dissolve.
    // It is intentionally visual-only: authoritative surf physics remains the
    // deterministic analytic surface, so multiplayer never depends on GPU/FX
    // state or readback.
    const foamCount = 520;
    this.#foamPositions = new Float32Array(foamCount * 3);
    this.#foamVelocity = new Float32Array(foamCount * 2);
    this.#foamLife = new Float32Array(foamCount);
    const foamGeo = new THREE.BufferGeometry();
    foamGeo.setAttribute("position", new THREE.BufferAttribute(this.#foamPositions, 3));
    foamGeo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(FACE_CENTER_X, 2, OCEAN_BEACH_SURF.centerZ),
      2600
    );
    const foamMat = new THREE.PointsMaterial({
      color: 0xd9fff3,
      size: 0.62,
      transparent: true,
      opacity: 0.66,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      sizeAttenuation: true
    });
    this.#foam = new THREE.Points(foamGeo, foamMat);
    this.#foam.name = "ocean_beach_advected_foam";
    this.#foam.renderOrder = 101;
    this.group.add(this.#foam);

    scene.add(this.group);
    this.update(0);
  }

  #buildFaceMesh(): THREE.Mesh {
    const geo = buildGradedFaceGeometry(); // local x → world X (break), local z → world Z (beach)

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
    // A small visual-only orbital/curl displacement makes the lip pitch forward
    // instead of reading as a static Gaussian hill. Fine crossing ripples keep
    // the translucent face breathing between the larger authored sets.
    const faceChop = sin(wz.mul(0.082).sub(t.mul(1.85)))
      .mul(sin(wx.mul(0.19).add(t.mul(1.3))))
      .mul(f.face)
      .mul(0.24);
    // The lip throws SHOREWARD (+X) and slightly up as it pitches — a stronger
    // overhang now that the wall stands taller. curl on X + a small lift.
    const curl = f.lip.mul(2.4);
    mat.positionNode = positionLocal.add(vec3(curl, f.height.add(faceChop).add(f.lip.mul(0.6)), 0));

    // strip + window feathering so the patch melts into the flat bay water
    const stripFade = f.mask; // already 0 outside the break, feathered inside
    const zRim = smoothstep(
      float(FACE_WINDOW_Z * 0.5 - 60),
      float(FACE_WINDOW_Z * 0.5),
      positionLocal.z.abs()
    ).oneMinus();

    // --- colour: chlorophyll green, backlit face, breaking foam ---------------
    // deep trough → mid sea green → bright translucent emerald on the standing
    // face; the pitching lip and spent whitewater go white.
    // Contrast is what makes a wall read as a WALL: a dark emerald trough at the
    // base rising to a vivid, near-opaque green face, with a hot backlit lip. The
    // dark-to-bright vertical gradient (height-driven) gives the standing face
    // real depth instead of a flat pale sheet.
    const bodyGreen = mix(color(0x053626), color(0x12b463), clamp(f.height.mul(0.16).add(0.22), 0, 1));
    const faceGreen = mix(bodyGreen, color(0x4bf0a2), f.face.mul(0.95));
    const foam = clamp(f.lip.mul(1.2).add(f.white.mul(0.9)), 0, 1).toVar();
    mat.colorNode = mix(faceGreen, color(0xf4fff8), foam);

    // SSS backlight: the thin, steep face glows emerald where the sun rakes
    // through it, plus a hot white rim right at the pitching lip (KSPS look).
    const glow = f.face.mul(f.face).mul(0.85 * LIGHT_SCALE);
    mat.emissiveNode = vec3(0.14, 0.72, 0.42).mul(glow)
      .add(vec3(0.85, 1.0, 0.92).mul(f.lip.mul(f.lip).mul(0.5 * LIGHT_SCALE)));

    // ripple bump from the wave height + a little chop so the face isn't glassy
    const chop = mx_noise_float(vec3(wx.mul(0.22), wz.mul(0.22), t.mul(0.6))).mul(0.12);
    mat.normalNode = bumpNormal(f.height.add(chop).mul(0.5));

    // The standing face reads near-opaque (a wall you can't see the sky through);
    // only the thin shallow toe stays a little translucent.
    const alpha = clamp(mix(float(0.86), float(0.99), max(f.face, f.height.mul(0.14))).add(foam.mul(0.15)), 0, 1);
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
    const dt = Math.min(0.05, Math.max(0, time - this.#lastTime));
    this.#lastTime = time;
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

    const fp = this.#foamPositions;
    const fv = this.#foamVelocity;
    const fl = this.#foamLife;
    const foamCount = fl.length;
    for (let i = 0; i < foamCount; i++) {
      const k = i * 3;
      const vk = i * 2;
      fl[i] -= dt;
      if (fl[i] <= 0 || fp[k] > b.maxX - 3 || fp[k + 2] < stripMinZ || fp[k + 2] > stripMaxZ) {
        // Low-discrepancy births avoid obvious rows while remaining deterministic.
        const u = (i * 0.61803398875 + time * 0.013) % 1;
        const z = THREE.MathUtils.lerp(stripMinZ, stripMaxZ, u);
        const slot = (i % SLOTS) - 1;
        const crestX = oceanBeachCrestX(slot, z, time);
        const spent = 2 + ((i * 17) % 31) * 0.72;
        fp[k] = crestX + spent;
        fp[k + 2] = z;
        fp[k + 1] = waterHeight(fp[k], z, time) + 0.12;
        fv[vk] = 3.4 + (i % 9) * 0.31;
        fv[vk + 1] = Math.sin(i * 12.9898) * 0.9;
        fl[i] = 2.8 + (i % 11) * 0.23;
        continue;
      }
      // Semi-Lagrangian-looking surface advection with a cheap curl field.
      const curl = Math.sin(fp[k] * 0.031 + fp[k + 2] * 0.019 + time * 1.15);
      fv[vk] += (1.8 - fv[vk]) * dt * 0.35;
      fv[vk + 1] += (curl * 1.5 - fv[vk + 1]) * dt * 1.6;
      fp[k] += fv[vk] * dt;
      fp[k + 2] += fv[vk + 1] * dt;
      fp[k + 1] = waterHeight(fp[k], fp[k + 2], time) + 0.1;
    }
    (this.#foam.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}
