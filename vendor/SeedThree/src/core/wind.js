// Shared wind system: one set of uniforms driving TSL vertex sway on the tree
// (bark cylinders via the baked aWind weight, foliage cards via per-anchor
// weights + per-instance flutter) and the ground grass. GUI writes the
// uniforms directly — wind changes never trigger a rebuild.
//
// Not exported to glTF (vertex animation is engine-specific); the aWind
// attribute stays available in the app for future engine-side wind.
//
// PIPELINE VERSION NOTE: the block below records the r184 WebGPU behavior that
// the vendored tree-card attributes were authored against. The host now runs
// r185, whose NodeMaterial.setupPosition applies instancing BEFORE positionNode.
// Do not copy this r184 contract into new r185 code. Ground grass is migrated
// explicitly in grass.js with an anchor-preserving fade and w=0 world offsets;
// the legacy tree paths retain their existing packed-attribute contract.
//
// In r184 (verified from compiled WGSL), for InstancedMeshes the instance
// matrix is composed into the model transform AFTER positionNode runs. Inside
// positionNode, positionLocal is the RAW quad-local vertex and positionWorld
// is modelWorld·(raw local) — NO instance transform. Consequences for any
// instanced wind:
//   phase     — positionWorld is ~the mesh origin for every instance: all
//               leaves share one phase while branch vertices ripple by true
//               position. THE leaf-detachment mechanism. Fix: per-instance
//               aAnchorPos (anchor in the mesh's object space); phase from
//               modelWorld·aAnchorPos — byte-identical to the bark's phase
//               at that point.
//   direction — offsets added here get instance-ROTATED afterward. Fix:
//               per-instance aWindVec = R⁻¹S⁻¹·windDir so the downstream
//               transform maps the offset back onto the true world heading.
//   amplitude — offsets get instance-SCALED afterward; aWindVec's /S folds
//               that away.

import { Vector3 } from 'three/webgpu';
import { uniform, time, sin, mix, normalize, positionLocal, positionWorld, positionGeometry, attribute, float, vec2, vec3, vec4, modelWorldMatrix, mx_noise_float } from 'three/tsl';
import { WIND_DIR, windStrength, windSpeed } from '../../../../src/world/vegetation/wind.ts';

// Transitional exports: the sandbox owns these values while the current tree
// materials continue to consume the SeedThree wind-node helpers below.
export { WIND_DIR, windStrength, windSpeed };
const windDir = uniform(WIND_DIR.clone());

// Shared sun direction (main.js updateSun writes it) — lets far materials that
// sit OUTSIDE the shadow frustum fake their own sun occlusion analytically.
export const sunDirectionUniform = uniform(new Vector3(0.5, 0.7, 0.5));

// Two-octave sway at an explicit phase-driving world position, so the canopy
// ripples instead of rocking as one rigid body.
function swayAt(phaseWorld, phaseScale = 1) {
  const t = time.mul(windSpeed);
  const phase = phaseWorld.x.mul(0.35).add(phaseWorld.z.mul(0.27)).mul(phaseScale);
  return sin(t.mul(1.15).add(phase)).mul(0.72)
    .add(sin(t.mul(2.63).add(phase.mul(1.9))).mul(0.28));
}

// Branch cylinders on the HERO tree (plain Mesh — positionLocal IS tree space
// and positionWorld is true world): amplitude from the baked aWind (0 at trunk
// base → 1 at tips). The sway PHASE is taken from the stem CENTERLINE
// (aStemCenter), not the offset surface vertex — otherwise a thick trunk's
// surface sways on a different phase than the centerline-anchored foliage
// (aAnchorPos) and the skirts clip through it. Both now share the centerline.
export function barkWindPosition() {
  const amp = windStrength.mul(0.35).mul(attribute('aWind', 'float'));
  const centerWorld = modelWorldMatrix.mul(vec4(attribute('aStemCenter', 'vec3'), 1)).xyz;
  return positionLocal.add(windDir.mul(swayAt(centerWorld).mul(amp)));
}

// Branch cylinders on FOREST INSTANCES: same per-vertex aWind amplitude, but
// heading and phase come from per-slot instance attributes (see pipeline note
// at the top). A whole slot shares one phase — the distant copy sways
// coherently, which is exactly what keeps its cards welded to its branches.
export function instancedBarkWindPosition() {
  const amp = windStrength.mul(0.35).mul(attribute('aWind', 'float'));
  const anchorWorld = modelWorldMatrix.mul(vec4(attribute('aAnchorPos', 'vec3'), 1)).xyz;
  return positionLocal.add(attribute('aWindVec', 'vec3').mul(swayAt(anchorWorld).mul(amp)));
}

// Foliage cards (leaves + branch cards; always instanced): aWindVec carries
// R⁻¹S⁻¹·windDir × (fork-continuous twig weight at the anchor) — direction,
// downstream-scale compensation, AND amplitude packed into one vec3, because
// WebGPU allows only 8 vertex buffers and a separate weight attribute blew
// the forest-card pipeline past it. Sway phase comes from modelWorld·
// aAnchorPos — so the card base receives the exact world offset its twig
// surface does. The whole card shares its anchor's phase (a rigid
// translation; losing the sub-30cm phase gradient across one leaf is
// invisible). Flutter scales by leaf-LOCAL height: zero at the anchor.
export function foliageWindPosition(withFlutter = true) {
  const windLocal = attribute('aWindVec', 'vec3'); // heading × weight, instance frame
  const anchorWorld = modelWorldMatrix.mul(vec4(attribute('aAnchorPos', 'vec3'), 1)).xyz;
  const base = windLocal.mul(swayAt(anchorWorld).mul(windStrength.mul(0.35)));
  // withFlutter=false: CROSSED card pairs skip the flutter term entirely. Its
  // phase rides the RANDOM per-instance aThickness and its vector is instance-
  // LOCAL, so the two halves of a cross flutter apart at the shared seam. The
  // base sway alone is world-identical across the pair (aWindVec is per-copy
  // pre-rotated) → the cross stays welded. aThickness itself must stay random —
  // it also drives SSS thickness color (zeroing it shifted the leaf color).
  if (!withFlutter) return positionLocal.add(base);
  const rnd = attribute('aThickness', 'float'); // 0.4..1 per instance
  const local = positionGeometry.y.max(0.0);
  const flutterT = time.mul(windSpeed).mul(5.2).add(rnd.mul(37.7));
  const flutter = vec3(sin(flutterT), sin(flutterT.mul(1.31)).mul(0.6), sin(flutterT.mul(0.77)))
    .mul(windStrength.mul(0.05)).mul(rnd).mul(local);
  return positionLocal.add(base).add(flutter);
}

// Yucca ROSETTE cones (crown + dead skirt). A crown cone is a small tuft —
// base-anchoring (one rigid sway at the apex) is enough, exactly like a leaf.
// A SKIRT cone is different: it drapes a long way DOWN a bending branch, so
// anchoring only its apex makes the whole cone ride ONE sway sample while the
// branch it hangs over ripples along its length — the rim shears through the
// bark. The fix: anchor the cone ALONG its drape, not just at the base. Two
// mechanisms, both keyed off the vertex's local Y (0 at apex, negative down
// the drape for skirt cones, positive up for crown cones):
//
//  PHASE — each drape vertex takes its sway SAMPLE from the branch centerline
//  point it actually hangs over (anchor + tangent·downDistance), so it ripples
//  in lock-step with that bark instead of the apex's phase. This is the term
//  that matters when the wind weight is saturated flat (short thick branches).
//  Crown vertices (local Y ≥ 0) contribute 0 downward walk → they keep the
//  apex sample, i.e. the old rigid base-anchored behavior.
//
//  AMPLITUDE — weight lerps from the apex weight (aPack.x) to the branch point
//  the rim hangs over (aPack.y), so on trees whose wind weight DOES fall off
//  along a branch the rim also throws less. (No-op where the field is flat.)
//
// aWindVec is DIRECTION ONLY (R⁻¹S⁻¹·windDir); weight is applied here.
// aTanSpan = (branch tangent in tree space .xyz, drape scale len·yScale .w).
// aPack = (apexWeight, rimWeight, age, thickness).
export function rosetteWindPosition() {
  const dir = attribute('aWindVec', 'vec3');
  const anchorWorld = modelWorldMatrix.mul(vec4(attribute('aAnchorPos', 'vec3'), 1)).xyz;
  const pack = attribute('aPack', 'vec4');
  const tanSpan = attribute('aTanSpan', 'vec4');
  const ly = positionGeometry.y;
  // amplitude taper: 0 at/above the anchor, →1 at the skirt rim (0.8 ≈ a skirt
  // cone's local Y span). Crown cones (ly ≥ 0) → 0 → weight stays at apex.
  const tNorm = ly.negate().div(0.8).clamp(0, 1);
  const w = mix(pack.x, pack.y, tNorm);
  const amp = windStrength.mul(0.35).mul(w);
  // per-vertex sway sample point: walk DOWN the branch tangent by the vertex's
  // drape depth (only ly<0 walks — crown's ly>0 stays at the anchor sample).
  const tanWorld = normalize(modelWorldMatrix.mul(vec4(tanSpan.xyz, 0)).xyz);
  const branchWorld = anchorWorld.add(tanWorld.mul(ly.min(0.0).mul(tanSpan.w)));
  const base = dir.mul(swayAt(branchWorld).mul(amp));
  // Flutter (crown only — skirt local Y ≤ 0 → local=0 → no flutter).
  const rnd = pack.w;
  const local = ly.max(0.0);
  const flutterT = time.mul(windSpeed).mul(5.2).add(rnd.mul(37.7));
  const flutter = vec3(sin(flutterT), sin(flutterT.mul(1.31)).mul(0.6), sin(flutterT.mul(0.77)))
    .mul(windStrength.mul(0.05)).mul(rnd).mul(local);
  return positionLocal.add(base).add(flutter);
}

// Dev-only probe hook: lets a browser-console harness build tiny meshes that
// run the EXACT wind node graphs and measure their GPU displacement (see the
// wind-weld debugging session). No effect on the app.
if (typeof window !== 'undefined') {
  window.__windProbe = {
    barkWindPosition, foliageWindPosition, instancedBarkWindPosition, windStrength, windSpeed,
    tsl: { uniform, positionWorld, positionGeometry, positionLocal, attribute, vec3, vec4, float },
  };
}

// ---- grass ------------------------------------------------------------------
//
// Grass is authored separately in grass.js for Three r185's post-instancing
// positionNode order: an explicit root anchor drives phase and anchor-preserving
// fade, while a world-space offset is converted through the mesh-world inverse.
//
// On top of the coherent two-octave sine, a SCROLLING SIMPLEX-STYLE noise
// field (MaterialX perlin — same visual family) drifts along the wind heading,
// so gust fronts wander through the meadow instead of the whole field pumping
// on one sine. grassNoiseStrength mixes between pure sine (0) and pure noise
// field (1).

export const grassNoiseStrength = uniform(0.55); // 0 sine … 1 pure gust field
export const grassNoiseScale = uniform(1 / 18);  // 1/gust-cell-size (m⁻¹)
export const grassNoiseSpeed = uniform(1.4);     // gust-front scroll speed (m/s)

// LEGACY shim for desert scrub (scrub.js): the old pre-instance wind path.
// Its offsets get rotated by each instance's yaw (see pipeline note above) —
// acceptable on scrub bushes where chaotic jitter reads fine, wrong for a
// meadow. New code should use grassSway + per-instance wind vectors instead.
export function grassWindPosition(bladeHeight = 1) {
  const k = positionLocal.y.div(float(bladeHeight)).pow(2);
  const amp = windStrength.mul(0.22);
  const gust = swayAt(positionWorld, 2.2).mul(amp);
  const jitterT = time.mul(windSpeed).mul(3.1).add(positionWorld.z.mul(1.7)).add(positionWorld.x.mul(1.3));
  const jitter = sin(jitterT).mul(amp).mul(0.25);
  return positionLocal.add(windDir.mul(gust.add(jitter)).mul(k));
}

/**
 * Scalar sway (± ~windStrength·0.26) at a WORLD-space xz anchor node.
 * Multiply by the canonical world direction, per-instance amplitude, and the
 * blade's height² to displace tips (see grass.js).
 */
export function grassSway(anchorWorldXZ) {
  const t = time.mul(windSpeed);
  // coherent traveling sine, same field the old grass sampled (phaseScale 2.2)
  const sine = swayAt(vec3(anchorWorldXZ.x, 0, anchorWorldXZ.y), 2.2);
  // gust fronts: perlin field scrolled along the wind heading; second octave
  // adds small-scale shimmer so fronts have texture instead of smooth blobs
  const scroll = windDir.xz.mul(t.mul(grassNoiseSpeed).mul(grassNoiseScale));
  const nUv = anchorWorldXZ.mul(grassNoiseScale).sub(scroll);
  const gust = mx_noise_float(nUv).add(mx_noise_float(nUv.mul(3.1).add(vec2(37.7, 17.3))).mul(0.4)).mul(1.25);
  return mix(sine, gust, grassNoiseStrength).mul(windStrength.mul(0.26));
}
