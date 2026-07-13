import * as THREE from "three/webgpu";
import {
  cameraPosition,
  positionLocal,
  positionWorld,
  uniform,
  vec3,
  color,
  float,
  mix,
  smoothstep,
  clamp,
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

// High-res single-wave ribbon. It follows the active rider in both X and Z and
// covers only the immediate playable crest; broad feathered rims blend into the
// continuous bay water below. Keeping the locked camera outside this compact
// patch prevents any displaced carrier triangle from crossing its near plane.
const FACE_WIDTH_X = 52;
const FACE_SHORE_OVERHANG = 10;
const FACE_CENTER_X = OCEAN_BEACH_SURF.entryX - FACE_WIDTH_X * 0.5 + FACE_SHORE_OVERHANG;
const FACE_WINDOW_Z = 180; // compact player-following window down the beach
const FACE_SEG_X = 64; // <1 m — resolves the steep shoreward face crisply
const FACE_SEG_Z = 96; // graded (below): dense at the rider, soft at the rim

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
  #disposed = false;

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
    const xRim = smoothstep(
      float(-FACE_WIDTH_X * 0.5),
      float(-FACE_WIDTH_X * 0.5 + 10),
      positionLocal.x
    ).mul(
      smoothstep(
        float(FACE_WIDTH_X * 0.5 - 8),
        float(FACE_WIDTH_X * 0.5),
        positionLocal.x
      ).oneMinus()
    );

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

    // The continuous bay water owns the broad body. This lazy layer contributes
    // only a restrained crest/face tint; turning the full displaced carrier
    // opaque is what previously made one triangle swallow the arcade camera.
    const alpha = clamp(
      f.lip.mul(0.16)
        .add(f.face.mul(0.015)),
      0,
      0.17
    );
    // The face is a 600 x 520 m player-following sheet. At full opacity its
    // steep triangles can cross the close arcade-camera frustum and turn into
    // screen-sized white wedges even when the centre sightline is clear. Keep a
    // soft visibility bubble around the eye: never punch a hard hole (the bay
    // water is deliberately cut out below this mesh), but let the rider and
    // board read through the local wall before it becomes solid in the distance.
    const eyeDistance = positionWorld.distance(cameraPosition);
    const cameraVisibility = mix(
      float(0),
      float(1),
      smoothstep(float(6), float(18), eyeDistance)
    );
    mat.opacityNode = alpha.mul(stripFade).mul(xRim).mul(zRim).mul(cameraVisibility);
    mat.envMapIntensity = 0.2;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "ocean_beach_surf_face";
    // The update loop moves this local ribbon with the rider. uOrigin receives
    // the same snapped centre so the shader's analytic world coordinates and
    // rendered geometry remain identical.
    mesh.position.x = FACE_CENTER_X;
    mesh.position.y = 0.04; // just above the bay near-patch (0.02) where they meet
    mesh.renderOrder = 12; // after bay water (far 10 / lagoon 10.5 / near 11)
    mesh.frustumCulled = false;
    return mesh;
  }

  update(time: number, focus?: { x: number; z: number }) {
    if (this.#disposed) return;

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

    // Slide the ribbon with the surfer, snapped to its own grids so vertices do
    // not swim under the analytic crest. The default camera stays beyond the
    // shore rim; the distance fade remains a second guard for custom tuning.
    if (focus) {
      const snapX = FACE_WIDTH_X / FACE_SEG_X;
      const snap = FACE_WINDOW_Z / FACE_SEG_Z;
      const x = Math.round(
        (focus.x - FACE_WIDTH_X * 0.5 + FACE_SHORE_OVERHANG) / snapX
      ) * snapX;
      const z = Math.round(THREE.MathUtils.clamp(focus.z, b.minZ, b.maxZ) / snap) * snap;
      this.#face.position.x = x;
      this.#face.position.z = z;
      this.#uOrigin.value.set(x, z);
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

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    this.group.removeFromParent();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    const textures = new Set<THREE.Texture>();
    this.group.traverse((object) => {
      const renderable = object as THREE.Object3D & {
        geometry?: THREE.BufferGeometry;
        material?: THREE.Material | THREE.Material[];
      };
      if (renderable.geometry) geometries.add(renderable.geometry);
      if (renderable.material) {
        const entries = Array.isArray(renderable.material)
          ? renderable.material
          : [renderable.material];
        for (const material of entries) {
          materials.add(material);
          for (const value of Object.values(material)) {
            if (value instanceof THREE.Texture) textures.add(value);
            if (Array.isArray(value)) {
              for (const entry of value) {
                if (entry instanceof THREE.Texture) textures.add(entry);
              }
            }
          }
        }
      }
    });

    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    for (const texture of textures) texture.dispose();
    this.group.clear();
  }
}
