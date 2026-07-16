fn afterlightVolume(
  localSurface: vec3<f32>,
  localCamera: vec3<f32>,
  pixel: vec2<f32>,
  tint: vec3<f32>,
  params: vec4<f32>
) -> vec4<f32> {
  let clock = params.x;
  let energy = clamp(params.y, 0.0, 1.6);
  let seed = params.z;
  let radius = max(params.w, 0.001);
  let camera = localCamera / radius;
  let surface = localSurface / radius;
  var direction = surface - camera;
  let directionLength = length(direction);
  if (directionLength < 0.00001) {
    return vec4<f32>(0.0);
  }
  direction /= directionLength;

  let hit = alIntersectSphere(camera, direction);
  if (hit.y <= 0.0) {
    return vec4<f32>(0.0);
  }
  let enter = max(hit.x, 0.0);
  let exit = hit.y;
  let chord = max(exit - enter, 0.0001);

  // HyperMind's bounded adaptive march: nearby hero orbs get 24 samples,
  // small/distant orbs settle toward 10. The hard ceiling keeps cost stable.
  let footprint = max(fwidth(localSurface.x), max(fwidth(localSurface.y), fwidth(localSurface.z)));
  let pixelRadius = radius / max(footprint, 0.001);
  let lod = smoothstep(5.0, 24.0, pixelRadius);
  let activeSteps = 10u + u32(round(lod * 14.0));
  let stepLength = chord / f32(activeSteps);
  let jitter = alHash21(floor(pixel) + vec2<f32>(seed * 43.1, seed * 71.7));

  let angleXY = seed * 2.17 + clock * 0.085;
  let angleXZ = seed * 1.31 - clock * 0.061;
  let rotationXY = vec2<f32>(sin(angleXY), cos(angleXY));
  let rotationXZ = vec2<f32>(sin(angleXZ), cos(angleXZ));
  let domainOffset = vec3<f32>(seed * 3.1, seed * 1.7 + clock * 0.21, seed * 2.3 - clock * 0.15);

  let deep = mix(vec3<f32>(0.008, 0.018, 0.095), tint * 0.18, 0.52);
  let body = mix(vec3<f32>(0.025, 0.32, 1.45), tint * 1.28, 0.68);
  let scatter = mix(vec3<f32>(0.12, 0.92, 1.75), tint * 1.62 + vec3<f32>(0.08, 0.18, 0.22), 0.55);
  let hot = mix(vec3<f32>(1.28, 1.44, 1.85), tint * 1.25 + vec3<f32>(0.26, 0.2, 0.16), 0.42);
  let breath = 0.9 + 0.1 * sin(clock * 1.55 + seed * 11.0);

  var radiance = vec3<f32>(0.0);
  var transmittance = 1.0;
  var traveled = 0.0;
  for (var i = 0u; i < 24u; i += 1u) {
    if (i >= activeSteps || transmittance < 0.006) {
      break;
    }
    let distance = min(traveled + stepLength * jitter, chord);
    let point = camera + direction * (enter + distance);
    let volume = alVolumeField(point, seed, rotationXY, rotationXZ, domainOffset);
    let segment = min(chord - traveled, stepLength);
    let extinction = volume.x * mix(0.5, 0.72, energy);
    let sampleAlpha = 1.0 - exp(-extinction * segment);
    let filamentHeat = smoothstep(0.06, 0.78, volume.y);
    let coreHeat = smoothstep(0.08, 0.94, volume.z);
    var sampleColor = mix(deep, body, filamentHeat);
    sampleColor = mix(sampleColor, scatter, filamentHeat * filamentHeat * 0.72);
    sampleColor = mix(sampleColor, hot, coreHeat * coreHeat * 0.88);

    // Forward-biased subsurface glow: the back half of the volume contributes
    // warm scattered light without requiring another texture or light pass.
    let forwardScatter = pow(clamp(0.5 + 0.5 * dot(normalize(point), -direction), 0.0, 1.0), 3.0);
    sampleColor = mix(sampleColor, hot, forwardScatter * coreHeat * 0.24);
    radiance += sampleColor * transmittance * volume.x * segment * (2.25 + energy * 1.2) * breath;
    radiance += scatter * transmittance * min(volume.w * volume.w * segment * 0.34, 0.18);
    transmittance *= 1.0 - sampleAlpha;
    traveled += segment;
  }

  let radiusFromCenter = length(surface);
  let silhouette = exp(-11.5 * dot(surface, surface));
  let rim = exp(-34.0 * abs(radiusFromCenter - 0.96));
  let opacity = clamp((1.0 - transmittance) * 0.84 + silhouette * 0.16 + rim * 0.08, 0.0, 0.9);
  let resolvedCore = hot * silhouette * (0.46 + energy * 0.18) + body * rim * energy * 0.12;
  let mapped = alToneMap((radiance + resolvedCore) * (0.8 + energy * 0.34));
  return vec4<f32>(max(mapped, vec3<f32>(0.0)), opacity);
}

fn alHash21(p: vec2<f32>) -> f32 {
  let q = fract(p * vec2<f32>(0.1031, 0.1030));
  let h = dot(q, q.yx + 33.33);
  return fract((q.x + h) * (q.y + h));
}

fn alRotate2(point: vec2<f32>, sineCosine: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(
    sineCosine.y * point.x - sineCosine.x * point.y,
    sineCosine.x * point.x + sineCosine.y * point.y
  );
}

// x=density, y=filament, z=core, w=field proximity.
fn alVolumeField(
  worldOffset: vec3<f32>,
  seed: f32,
  rotationXY: vec2<f32>,
  rotationXZ: vec2<f32>,
  domainOffset: vec3<f32>
) -> vec4<f32> {
  var q = worldOffset;
  let xy = alRotate2(q.xy, rotationXY);
  q = vec3<f32>(xy, q.z);
  let xz = alRotate2(q.xz, rotationXZ);
  q = vec3<f32>(xz.x, q.y, xz.y);

  let r2 = dot(worldOffset, worldOffset);
  let radial = sqrt(r2);
  let domain = q * 5.1 + domainOffset;
  let warp = 0.2 * vec3<f32>(
    sin(domain.y * 0.73 + domain.z),
    sin(domain.z * 0.81 - domain.x),
    sin(domain.x * 0.67 + domain.y)
  );
  let p = domain + warp;
  let primary = dot(sin(p), cos(p * 0.618).yzx) * (1.0 / 3.0);
  let secondary = dot(sin(p.yzx * 1.27 + seed), cos(p.zxy * 0.79 - seed)) * (1.0 / 3.0);
  let fieldDistance = abs(primary + secondary * 0.22);
  let proximity = exp(-72.0 * fieldDistance * fieldDistance);

  let interior = 1.0 - smoothstep(0.72, 1.0, radial);
  let shell = exp(-19.0 * (radial - 0.58) * (radial - 0.58));
  let corona = exp(-58.0 * (radial - 0.82) * (radial - 0.82));
  let core = exp(-11.5 * r2);
  let filament = proximity * (shell * 0.82 + corona * 0.32) * interior;
  let density = (core * 1.56 + filament * 1.2) * interior;
  return vec4<f32>(density, filament, core, proximity);
}

fn alToneMap(value: vec3<f32>) -> vec3<f32> {
  let positive = max(value, vec3<f32>(0.0));
  let peak = max(positive.x, max(positive.y, positive.z));
  return positive / (1.0 + peak);
}

fn alIntersectSphere(origin: vec3<f32>, direction: vec3<f32>) -> vec2<f32> {
  let a = dot(direction, direction);
  let b = 2.0 * dot(origin, direction);
  let c = dot(origin, origin) - 1.0;
  let discriminant = b * b - 4.0 * a * c;
  if (discriminant < 0.0 || a < 0.00000001) {
    return vec2<f32>(-1.0);
  }
  let root = sqrt(discriminant);
  return vec2<f32>((-b - root) / (2.0 * a), (-b + root) / (2.0 * a));
}
