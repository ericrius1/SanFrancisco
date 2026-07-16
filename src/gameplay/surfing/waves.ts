import * as THREE from "three/webgpu";
import {
  positionGeometry,
  uniform,
  vec2,
  vec3,
  color,
  float,
  mix,
  smoothstep,
  clamp,
  max,
  sin,
  uv,
  mx_noise_float
} from "three/tsl";
import {
  OCEAN_BEACH_SURF,
  nearestOceanBeachCrest,
  oceanBeachBarrelEnvelope,
  oceanBeachCrestX,
  oceanBeachFoamNoise,
  oceanBeachTubeRoofFraction
} from "../../world/oceanBeachWaves";
import {
  oceanBeachSurfField,
  bumpNormal,
  chopZoneMask,
  swellBase,
  swellChop
} from "../../world/tslUtil";
import { LIGHT_SCALE } from "../../config";
import { waterHeight } from "../../world/heightmap";

// One high-resolution player-owned contact sheet. It covers the offshore
// shoulder, the complete playable face corridor, and a little spent shoulder.
// The old 0..8.6 m ribbon ended under the board's neutral 8.4 m line and faded
// to almost nothing there, exposing the 4.4 m triangles of the generic ocean.
const FACE_MIN_D = -52;
const FACE_MAX_D = 64;
const FACE_SPAN = FACE_MAX_D - FACE_MIN_D;
// The window must outrun the base ocean's displaced near patch (560 m square,
// swell rim-faded to flat by 276 m from the player): the shore-view camera
// looks straight down the line, and a 420 m window ended mid-frame — the crest
// visibly collapsed onto the flat grey far sheet as a glitchy strip. 1080 m
// carries the emerald wall into the marine fog.
const FACE_WINDOW_Z = 1080;
const FACE_SEG_U = 320;
const FACE_SEG_Z = 200;
// Keep the roof local enough that its bright down-line aperture is visible.
// The window follows the player, so 108 m still leaves ample geometry behind
// the 6 m camera trail and beyond the 18 m aim point.
const BARREL_WINDOW_Z = 108;
const BARREL_SEG_U = 36;
const BARREL_SEG_Z = 72;
// Mid-distance swell sheet: the base ocean's displaced near patch flattens by
// ~276 m from the player and the whole-map far sheet is a dead-flat plane, so
// from the elevated surf camera every set beyond ~250 m used to collapse into
// a glitchy grey strip. This coarse player-following grid rolls ALL the sets
// out to the marine fog; it only draws where swell actually stands, so flat
// troughs (and the analytic-masked land) still show the base ocean.
const MID_SPAN_X = 1100;
const MID_SPAN_Z = 2600;
const MID_SEG_X = 44;
const MID_SEG_Z = 104;

/**
 * Player-following face grid with **graded Z resolution**: vertices bunch tight
 * around the rider (window centre) and smoothly spread toward the rim. Because
 * the whole patch re-centres on the surfer every frame, this reads as one
 * continuous sheet that is dense exactly where you look and coarsens with
 * distance — no discrete LOD, no seam. X stays uniform (the break's steep face
 * needs even sampling across its whole width).
 */
function buildActiveFaceGeometry(): THREE.BufferGeometry {
  const nx = FACE_SEG_U + 1;
  const nz = FACE_SEG_Z + 1;
  const halfZ = FACE_WINDOW_Z / 2;
  const pos = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const idx: number[] = [];
  // centred, symmetric bunching: blend linear + cubic so ~⅓ of the rows sit in
  // the middle ~15 % of the window (dense) while the rim stays gentle (coarse).
  // The wider 1080 m window leans harder on the cubic so rider-local rows stay
  // ~1.3 m apart while the far rim (silhouette-only) coarsens to ~8 m.
  const gradeZ = (t: number) => {
    const u = t * 2 - 1; // [-1,1]
    const s = Math.sign(u);
    const a = Math.abs(u);
    return s * (0.24 * a + 0.76 * a * a * a); // dense centre, coarse rim
  };
  for (let j = 0; j < nz; j++) {
    const z = gradeZ(j / FACE_SEG_Z) * halfZ;
    for (let i = 0; i < nx; i++) {
      const x = FACE_MIN_D + (i / FACE_SEG_U) * FACE_SPAN;
      const k = (j * nx + i) * 3;
      pos[k] = x;
      pos[k + 1] = 0;
      pos[k + 2] = z;
      const uk = (j * nx + i) * 2;
      uvs[uk] = i / FACE_SEG_U;
      uvs[uk + 1] = j / FACE_SEG_Z;
    }
  }
  for (let j = 0; j < FACE_SEG_Z; j++) {
    for (let i = 0; i < FACE_SEG_U; i++) {
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
 * Concave crown-to-lip roof. X stores signed crest distance, Y stores the
 * nominal cubic roof profile, and Z is a player-following down-line window.
 * TSL moves every row onto its live bent crest and set amplitude, so this shell
 * and the CPU tube queries stay on the same analytic wave without readback.
 */
function buildBarrelGeometry(): THREE.BufferGeometry {
  const nx = BARREL_SEG_U + 1;
  const nz = BARREL_SEG_Z + 1;
  const pos = new Float32Array(nx * nz * 3);
  const uvs = new Float32Array(nx * nz * 2);
  const idx: number[] = [];
  for (let j = 0; j < nz; j++) {
    const tj = j / BARREL_SEG_Z;
    const signed = tj * 2 - 1;
    const graded = Math.sign(signed) * (0.38 * Math.abs(signed) + 0.62 * Math.abs(signed) ** 3);
    const z = graded * BARREL_WINDOW_Z * 0.5;
    for (let i = 0; i < nx; i++) {
      const u = i / BARREL_SEG_U;
      const k = (j * nx + i) * 3;
      pos[k] = u * OCEAN_BEACH_SURF.tubeSpan;
      pos[k + 1] = oceanBeachTubeRoofFraction(pos[k]) * OCEAN_BEACH_SURF.amplitude;
      pos[k + 2] = z;
      const uk = (j * nx + i) * 2;
      uvs[uk] = u;
      uvs[uk + 1] = tj;
    }
  }
  for (let j = 0; j < BARREL_SEG_Z; j++) {
    for (let i = 0; i < BARREL_SEG_U; i++) {
      const a = j * nx + i;
      const b = a + 1;
      const c = a + nx;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
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
  readonly activeWaveCount = 1;

  #spray: THREE.Points;
  #sprayPositions: Float32Array;
  #sprayVelocity: Float32Array;
  #foam: THREE.Points;
  #foamPositions: Float32Array;
  #foamVelocity: Float32Array;
  #foamLife: Float32Array;
  #lastTime = 0;
  #tubeVisibility = 0;
  #face: THREE.Mesh;
  #barrel: THREE.Mesh;
  #mid: THREE.Mesh;
  #uTime = uniform(0);
  #uMidOrigin = uniform(
    new THREE.Vector2(OCEAN_BEACH_SURF.entryX, OCEAN_BEACH_SURF.centerZ)
  );
  #uOrigin = uniform(
    new THREE.Vector2(OCEAN_BEACH_SURF.entryX, OCEAN_BEACH_SURF.centerZ)
  );
  #uBarrelOrigin = uniform(
    new THREE.Vector2(OCEAN_BEACH_SURF.entryX, OCEAN_BEACH_SURF.entryZ)
  );
  #uTubeVisibility = uniform(0);

  constructor() {
    this.group.name = "ocean_beach_breaking_waves";

    this.#face = this.#buildFaceMesh();
    this.group.add(this.#face);
    this.#barrel = this.#buildBarrelMesh();
    this.group.add(this.#barrel);
    this.#mid = this.#buildMidSwellMesh();
    this.group.add(this.#mid);

    const sprayCount = 220;
    this.#sprayPositions = new Float32Array(sprayCount * 3);
    this.#sprayVelocity = new Float32Array(sprayCount * 3);
    const sprayGeo = new THREE.BufferGeometry();
    sprayGeo.setAttribute("position", new THREE.BufferAttribute(this.#sprayPositions, 3));
    sprayGeo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(OCEAN_BEACH_SURF.entryX, 3, OCEAN_BEACH_SURF.centerZ),
      2400
    );
    const sprayMat = new THREE.PointsMaterial({
      color: 0xc7dedd,
      size: 1.15,
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
      sizeAttenuation: false
    });
    this.#spray = new THREE.Points(sprayGeo, sprayMat);
    // World-space point sprites balloon into cotton-ball billboards at the
    // low surf lens (and bloom compounds it). The analytic lip/whitewater
    // material now carries the break cleanly; keep these buffers dormant until
    // they are replaced by true tangent ribbons.
    this.#spray.visible = false;
    this.#spray.renderOrder = 16;
    this.group.add(this.#spray);

    // Persistent Lagrangian whitewater. These flecks are born at compressed
    // crest fronts, advect shoreward, curl down the line and slowly dissolve.
    // It is intentionally visual-only: authoritative surf physics remains the
    // deterministic analytic surface, so multiplayer never depends on GPU/FX
    // state or readback.
    const foamCount = 280;
    this.#foamPositions = new Float32Array(foamCount * 3);
    this.#foamVelocity = new Float32Array(foamCount * 2);
    this.#foamLife = new Float32Array(foamCount);
    const foamGeo = new THREE.BufferGeometry();
    foamGeo.setAttribute("position", new THREE.BufferAttribute(this.#foamPositions, 3));
    foamGeo.boundingSphere = new THREE.Sphere(
      new THREE.Vector3(OCEAN_BEACH_SURF.entryX, 2, OCEAN_BEACH_SURF.centerZ),
      2600
    );
    const foamMat = new THREE.PointsMaterial({
      color: 0xc3dad7,
      size: 1,
      transparent: true,
      opacity: 0.11,
      depthWrite: false,
      blending: THREE.NormalBlending,
      sizeAttenuation: false
    });
    this.#foam = new THREE.Points(foamGeo, foamMat);
    this.#foam.visible = false;
    this.#foam.name = "ocean_beach_advected_foam";
    this.#foam.renderOrder = 15;
    this.group.add(this.#foam);

    // The caller owns scene attachment: the group is built detached so its
    // heavy TSL pipelines can be compiled via renderer.compileAsync() before
    // the first visible frame (adding it raw stalled entry >1 s).
    this.update(0);
  }

  #buildFaceMesh(): THREE.Mesh {
    const geo = buildActiveFaceGeometry();

    const mat = new THREE.MeshStandardNodeMaterial({
      roughness: 0.5,
      metalness: 0,
      transparent: true,
      depthWrite: false
    });
    const t = this.#uTime;
    // positionGeometry is the immutable grid attribute. positionLocal is
    // overwritten by positionNode in NodeMaterial, so reusing it below would
    // add the world origin twice and zero every strip/mask in the fragment pass.
    const wz = positionGeometry.z.add(this.#uOrigin.y);
    const anchorField = oceanBeachSurfField(this.#uOrigin.x, wz, t);
    const crestX = this.#uOrigin.x.sub(anchorField.crestD);
    const wx = crestX.add(positionGeometry.x);
    const f = oceanBeachSurfField(wx, wz, t);

    // Authoritative contact surface: this is the exact GPU twin of
    // waterHeight(), not a cosmetic shell. The prior +2.4 m curl, +0.6 m lip
    // lift, and separate face chop put visible water inside a correctly
    // supported board. Curl now lives in the roof/spray layers only.
    const contactHeight = swellBase(wx, wz, t)
      .add(swellChop(wx, wz, t).mul(chopZoneMask(wx, wz)))
      .add(f.height)
      .add(0.025);
    mat.positionNode = vec3(wx, contactHeight, wz);

    // strip + window feathering so the patch melts into the flat bay water
    const stripFade = f.mask; // already 0 outside the break, feathered inside
    const zRim = smoothstep(
      float(FACE_WINDOW_Z * 0.5 - 140),
      float(FACE_WINDOW_Z * 0.5),
      positionGeometry.z.abs()
    ).oneMinus();
    const contactEdge = smoothstep(0.0, 0.075, uv().x)
      .mul(smoothstep(1.0, 0.9, uv().x));

    // --- colour: daylight-harmonized. The trough reads as the same bright bay
    // turquoise as the base sheets (the old near-black body was tuned in fog
    // and became a black hole at noon), the standing wall deepens to emerald,
    // and everything shoreward of the break is pale opaque foam wash — the
    // three water layers hand off without visible seams.
    const faceMask = smoothstep(0.12, 0.82, f.face).toVar();
    const wallMask = smoothstep(0.5, 6.0, f.height).toVar();
    const wash = smoothstep(0.12, 0.7, f.white).toVar();
    const bodyTeal = mix(
      color(0x18a08e),
      color(0x0d7f60),
      clamp(f.height.mul(0.16).add(wallMask.mul(0.4)), 0, 1)
    );
    const faceGreen = mix(bodyTeal, color(0x0d8f5c), faceMask);
    // Two scales break the lip longitudinally. A single broad noise sample
    // stayed above threshold for most of a portrait frame and read as a ruler-
    // straight white seam; the shorter ripple opens green gaps along the crown.
    const crestNoise = mx_noise_float(
      vec3(wx.mul(0.2), wz.mul(0.19), t.mul(0.52))
    ).mul(0.5).add(0.5);
    const crestRipple = sin(wz.mul(0.47).sub(t.mul(2.1))).mul(0.5).add(0.5);
    const crestBreakup = smoothstep(
      0.68,
      0.88,
      crestNoise.mul(0.64).add(crestRipple.mul(0.36))
    );
    const foam = clamp(
      smoothstep(0.66, 0.96, f.lip).mul(crestBreakup.mul(0.5)),
      0,
      1
    ).toVar();
    const flowRib = sin(wx.mul(0.72).sub(wz.mul(0.055)).add(t.mul(1.4))).mul(0.5).add(0.5);
    const sunVein = smoothstep(
      0.74,
      0.94,
      crestBreakup.mul(0.48).add(flowRib.mul(0.52))
    ).mul(faceMask).mul(foam.oneMinus());
    const veinedGreen = mix(faceGreen, color(0x2fbd8a), sunVein.mul(0.2));
    // Whitewater is bright broken foam, never dark water: noise keeps it from
    // reading as one flat pale slab across the apron.
    const washNoise = mx_noise_float(
      vec3(wx.mul(0.35), wz.mul(0.35), t.mul(0.7))
    ).mul(0.5).add(0.5);
    const washTone = mix(color(0xbfe2d9), color(0xe9f6f0), washNoise);
    mat.colorNode = mix(
      mix(veinedGreen, color(0xd6ece6), foam.mul(0.55)),
      washTone,
      wash.mul(0.88)
    );

    // SSS backlight: the wall glows emerald where light rakes through it, and
    // a broad wall-wide term keeps the sun-shadowed side luminous green — a
    // 12 m wall with its back to the afternoon sun must never render black.
    const vein = smoothstep(
      0.68,
      0.94,
      mx_noise_float(vec3(wx.mul(0.16), wz.mul(0.08), t.mul(0.32))).mul(0.5).add(0.5)
    );
    const glow = faceMask.mul(faceMask).mul(vein).mul(0.16 * LIGHT_SCALE);
    mat.emissiveNode = vec3(0.05, 0.6, 0.32)
      .mul(glow)
      .add(
        vec3(0.03, 0.42, 0.2).mul(
          max(faceMask, wallMask.mul(0.7)).mul(0.15 * LIGHT_SCALE)
        )
      )
      .add(vec3(0.5, 0.62, 0.58).mul(max(foam, wash).mul(0.05 * LIGHT_SCALE)));

    // ripple bump from the wave height + a little chop so the face isn't glassy
    const chop = mx_noise_float(vec3(wx.mul(0.22), wz.mul(0.22), t.mul(0.6))).mul(0.08);
    mat.normalNode = bumpNormal(contactHeight.add(chop));

    // This is a wave, not a second ocean sheet. Alpha follows semantic face,
    // lip and whitewater bands so the large graded patch disappears completely
    // between sets instead of laying a pale polygon over the rider and horizon.
    const presence = smoothstep(
      0.035,
      0.38,
      max(max(f.face, f.lip), f.white)
    ).toVar();
    const alpha = mix(float(0.88), float(1.0), smoothstep(0.12, 0.62, max(f.face, f.lip)));
    const replacementCore = smoothstep(
      0.12,
      0.38,
      max(max(f.face, f.lip), f.white)
    ).mul(zRim);
    // The whole raised swell is opaque, not just the thin bright face band. The
    // old alpha faded out across the crest, shoulder and back, so you saw the
    // flat ocean and sky straight through the wave. Anywhere the wave stands up
    // more than ~0.6 m it now fully occludes what is behind it.
    // Anything standing more than ~0.3 m is fully opaque — a translucent
    // mid-face let the horizon/base sheets read straight through the wall.
    const waveBody = smoothstep(float(0.3), float(1.4), f.height);
    // Whitewater wash is opaque foam (it must fully replace the base sheet it
    // cut out), not a translucent dark film over the bright bay water.
    mat.opacityNode = max(
      max(mix(alpha, float(1), replacementCore).mul(presence), waveBody),
      wash.mul(0.92)
    )
      .mul(contactEdge)
      .mul(stripFade)
      .mul(zRim);
    mat.envMapIntensity = 0.13;

    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "ocean_beach_surf_face";
    // positionNode emits world coordinates directly; the object transform stays
    // identity while its origin uniform follows the active crest down the beach.
    // Transparent renderOrder is ascending even with a reversed-depth buffer:
    // base ocean 10/11 -> contact sheet 12 -> local hero 13 -> roof 14 -> foam.
    mesh.renderOrder = 12;
    mesh.frustumCulled = false;
    return mesh;
  }

  #buildBarrelMesh(): THREE.Mesh {
    const geo = buildBarrelGeometry();
    // Unlit underside: the roof is an arcade readability layer, and letting
    // the bright sky environment relight it made the tunnel dissolve back into
    // the horizon. The base/face sheets still carry all PBR reflection.
    const mat = new THREE.MeshBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide
    });
    mat.fog = false;
    const t = this.#uTime;
    const wz = positionGeometry.z.add(this.#uBarrelOrigin.y);
    const f = oceanBeachSurfField(this.#uBarrelOrigin.x, wz, t);
    const crestX = this.#uBarrelOrigin.x.sub(f.crestD);
    const liveRoofY = positionGeometry.y
      .mul(f.amp.div(OCEAN_BEACH_SURF.amplitude))
      .mul(f.mask);
    mat.positionNode = vec3(crestX.add(positionGeometry.x), liveRoofY, wz);

    const arc = uv().x.toVar();
    const zRim = smoothstep(
      float(BARREL_WINDOW_Z * 0.5 - 16),
      float(BARREL_WINDOW_Z * 0.5),
      positionGeometry.z.abs()
    ).oneMinus();
    // Gameplay already admits the rider only where the authoritative CPU
    // barrel envelope is active, and #uTubeVisibility is driven directly from
    // that state. Do not gate the same roof a second time with a render-clock
    // envelope: even a small clock/phase disagreement could erase the tunnel
    // while scoring and camera correctly said the rider was inside.
    const section = zRim.toVar();
    const waterNoise = mx_noise_float(
      vec3(
        positionGeometry.x.mul(0.22).add(t.mul(0.18)),
        wz.mul(0.09),
        t.mul(0.38)
      )
    ).toVar();
    const crownLight = smoothstep(0.02, 0.48, arc)
      .mul(smoothstep(0.5, 0.88, arc).oneMinus())
      .toVar();
    const lip = smoothstep(0.68, 0.98, arc).toVar();
    const deep = mix(color(0x031d20), color(0x073a34), waterNoise.mul(0.5).add(0.5));
    const emerald = mix(deep, color(0x126e55), crownLight.mul(0.78));
    const flowRib = sin(
      positionGeometry.x.mul(1.18).sub(wz.mul(0.09)).add(t.mul(1.85))
    ).mul(0.5).add(0.5);
    const sunVein = smoothstep(
      0.72,
      0.96,
      waterNoise.mul(0.56).add(flowRib.mul(0.44))
    ).mul(crownLight).mul(lip.oneMinus());
    const litEmerald = mix(emerald, color(0x48aa84), sunVein.mul(0.2));
    // Cool translucent lip, dark absorptive crown: from inside the bright
    // aperture and the rider silhouette remain readable simultaneously.
    mat.colorNode = mix(litEmerald, color(0x83aaa5), lip.mul(0.68));
    mat.opacityNode = clamp(
      mix(float(0.9), float(0.985), crownLight).add(lip.mul(0.015)),
      0,
      1
    ).mul(section).mul(this.#uTubeVisibility);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "ocean_beach_barrel_roof";
    // Paint after the local hero, so the pitching roof can genuinely close
    // overhead without making the rider unreadable through the base ocean.
    mesh.renderOrder = 14;
    mesh.frustumCulled = false;
    return mesh;
  }

  /**
   * Rolling sets from the near-patch rim out to the marine fog. Vertex height
   * is the same analytic field the rider surfs; opacity gates on standing
   * swell so the sheet vanishes over flat water and the masked shoreline, and
   * a ring around the player yields to the displaced near patch + hero face.
   */
  #buildMidSwellMesh(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(MID_SPAN_X, MID_SPAN_Z, MID_SEG_X, MID_SEG_Z);
    geo.rotateX(-Math.PI / 2);
    const mat = new THREE.MeshStandardNodeMaterial({
      roughness: 0.55,
      metalness: 0,
      transparent: true,
      depthWrite: false
    });
    const t = this.#uTime;
    const wx = positionGeometry.x.add(this.#uMidOrigin.x);
    const wz = positionGeometry.z.add(this.#uMidOrigin.y);
    const f = oceanBeachSurfField(wx, wz, t);
    // Land the rim back on the flat far sheet so the grid never silhouettes.
    const edge = smoothstep(
      float(MID_SPAN_X * 0.5),
      float(MID_SPAN_X * 0.5 - 140),
      positionGeometry.x.abs()
    ).mul(
      smoothstep(
        float(MID_SPAN_Z * 0.5),
        float(MID_SPAN_Z * 0.5 - 200),
        positionGeometry.z.abs()
      )
    );
    const height = f.height.mul(edge);
    mat.positionNode = vec3(wx, height.add(0.012), wz);
    // Displaced walls must shade as walls — a flat normal mirrors the bright
    // sky and reads as the same grey stripe this sheet exists to remove.
    mat.normalNode = bumpNormal(height);
    const faceMask = smoothstep(0.12, 0.82, f.face);
    // Same daylight palette as the hero sheet so distant sets match near ones.
    const body = mix(color(0x12857c), color(0x0d7f60), faceMask);
    const crest = clamp(
      smoothstep(0.7, 0.97, f.lip).mul(0.5).add(f.white.mul(0.25)),
      0,
      1
    );
    mat.colorNode = mix(body, color(0xd6ece6), crest);
    // Sun-shadowed backsides must stay luminous water, not black vinyl.
    mat.emissiveNode = vec3(0.02, 0.3, 0.18)
      .mul(smoothstep(1.2, 6.0, f.height))
      .mul(0.5 * LIGHT_SCALE);
    mat.envMapIntensity = 0.2;
    // Complement the base near patch's fragment opacity feather (210→276 m)
    // exactly: identical analytic height on both sheets crossfades cleanly.
    const playerDist = vec2(
      wx.sub(this.#uOrigin.x),
      wz.sub(this.#uOrigin.y)
    ).length();
    // Reach full opacity while the near patch still carries ~70% alpha — two
    // half-faded sheets let the flat far ocean read through the wave's back.
    const nearHole = smoothstep(float(180), float(240), playerDist);
    mat.opacityNode = smoothstep(0.45, 2.1, height).mul(nearHole).mul(edge);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.name = "ocean_beach_mid_swell";
    // After the base near sheet (11), before the hero contact sheet (12).
    mesh.renderOrder = 11.5;
    mesh.frustumCulled = false;
    return mesh;
  }

  update(time: number, focus?: { x: number; z: number }, tubeVisibility = 0) {
    const dt = Math.min(0.05, Math.max(0, time - this.#lastTime));
    this.#lastTime = time;
    this.#uTime.value = time;
    const requestedTubeVisibility = THREE.MathUtils.clamp(tubeVisibility, 0, 1);
    const tubeResponse = requestedTubeVisibility > this.#tubeVisibility ? 1.15 : 2.4;
    this.#tubeVisibility +=
      (requestedTubeVisibility - this.#tubeVisibility) *
      (1 - Math.exp(-dt * tubeResponse));
    this.#uTubeVisibility.value = this.#tubeVisibility;
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
      this.#uOrigin.value.set(focus.x, z);
      const barrelSnap = BARREL_WINDOW_Z / BARREL_SEG_Z;
      const barrelZ =
        Math.round(THREE.MathUtils.clamp(focus.z, b.minZ, b.maxZ) / barrelSnap) *
        barrelSnap;
      this.#uBarrelOrigin.value.set(focus.x, barrelZ);
      const midSnapX = MID_SPAN_X / MID_SEG_X;
      const midSnapZ = MID_SPAN_Z / MID_SEG_Z;
      this.#uMidOrigin.value.set(
        Math.round(focus.x / midSnapX) * midSnapX,
        Math.round(THREE.MathUtils.clamp(focus.z, b.minZ, b.maxZ) / midSnapZ) * midSnapZ
      );
    }

    const focusZ = focus && focus.z > b.minZ - 600 && focus.z < b.maxZ + 600 ? focus.z : b.entryZ;
    const activeSlot = nearestOceanBeachCrest(focus?.x ?? b.entryX, focusZ, time).slot;
    if (!this.#spray.visible && !this.#foam.visible) return;
    const stripMinZ = Math.max(b.minZ, focusZ - 380);
    const stripMaxZ = Math.min(b.maxZ, focusZ + 380);
    const sp = this.#sprayPositions;
    const sv = this.#sprayVelocity;
    const count = sp.length / 3;
    for (let i = 0; i < count; i++) {
      const k = i * 3;
      const life = (time * (0.42 + (i % 7) * 0.018) + i * 0.137) % 1;
      const z = THREE.MathUtils.lerp(stripMinZ, stripMaxZ, ((i * 0.6180339) % 1 + time * 0.006) % 1);
      const crestX = oceanBeachCrestX(activeSlot, z, time);
      const gust = oceanBeachFoamNoise(z, time, i % 13);
      // Birth on the live surface so spray never reads as mid-air puffs above a
      // flat bay sheet — the crest height comes from waterHeight(), not a free Y.
      // Keep spray short-lived and low so it reads as lip mist, not floating blobs.
      const surfaceY = waterHeight(crestX + 1.2, z, time);
      const barrel = oceanBeachBarrelEnvelope(z, time);
      sv[k] = 1.6 + gust * 1.4;
      sv[k + 1] = 0.9 + gust * 1.2;
      sv[k + 2] = Math.sin(i * 9.17) * 1.1;
      // In barrel sections the breaking lip pitches forward over the pocket;
      // elsewhere this collapses to the compact crest mist used by open faces.
      const throwArc = Math.sin(life * Math.PI * 0.82);
      sp[k] = crestX + 1.4 + sv[k] * life + barrel * throwArc * 6.8;
      sp[k + 1] =
        surfaceY + 0.08 + sv[k + 1] * life - 2.4 * life * life - barrel * life * 1.1;
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
        const crestX = oceanBeachCrestX(activeSlot, z, time);
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
    this.group.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
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
        for (const material of entries) materials.add(material);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.group.clear();
  }
}
