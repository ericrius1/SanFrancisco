fn tidalClouds(origin: vec3f, direction: vec3f, sun: vec3f, pixel: vec2f,
              phase: f32, coverage: f32, base: f32, steps: f32, structure: vec4f, thickness: f32, drift: vec2f, morph: f32) -> vec4f {
  let rd = normalize(direction);
  if (coverage < 0.01) { return vec4f(0.0); }
  if (abs(rd.y) < 0.015 || origin.y > 20000.0) { return vec4f(0.0); }
  let a = (base - origin.y) / rd.y;
  let b = (base + thickness - origin.y) / rd.y;
  let start = max(0.0, min(a, b));
  let end = min(18000.0, max(a, b));
  if (end <= start) { return vec4f(0.0); }
  let stepLength = (end - start) / steps;
  let jitter = fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
  var transmittance = 1.0;
  var light = vec3f(0.0);
  let daylight = smoothstep(-0.12, 0.18, sun.y);
  let warm = 1.0 - smoothstep(0.0, 0.35, sun.y);
  let sunTint = mix(vec3f(0.95, 0.97, 1.0), vec3f(1.0, 0.57, 0.29), warm);
  let forward = pow(max(dot(rd, sun), 0.0), 6.0);
  for (var i = 0; i < 16; i++) {
    if (f32(i) >= steps || transmittance < 0.025) { break; }
    let p = origin + rd * (start + (f32(i) + jitter) * stepLength);
    let density = tidalCloudDensity(p, coverage, base, structure, thickness, drift, morph);
    if (density > 0.001) {
      let shade = exp(-tidalCloudDensity(p + sun * 180.0, coverage, base, structure, thickness, drift, morph) * 3.5);
      let height = clamp((p.y - base) / thickness, 0.0, 1.0);
      let ambient = mix(vec3f(0.27, 0.34, 0.44), vec3f(0.61, 0.69, 0.78), height);
      let luminance = mix(vec3f(0.035, 0.05, 0.09), ambient + sunTint * shade * (0.7 + forward * 0.8), daylight);
      let opacity = 1.0 - exp(-density * stepLength * 0.011);
      light += transmittance * opacity * luminance;
      transmittance *= 1.0 - opacity;
    }
  }
  let horizon = smoothstep(0.015, 0.09, abs(rd.y));
  return vec4f(light * horizon, (1.0 - transmittance) * horizon);
}

fn tidalCloudHash(v: vec3f) -> f32 {
  var p = fract(v * 0.1031);
  p += dot(p, p.yzx + vec3f(33.33));
  return fract((p.x + p.y) * p.z);
}

fn tidalCloudNoise(p: vec3f) -> f32 {
  let c = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(tidalCloudHash(c), tidalCloudHash(c + vec3f(1,0,0)), u.x),
        mix(tidalCloudHash(c + vec3f(0,1,0)), tidalCloudHash(c + vec3f(1,1,0)), u.x), u.y),
    mix(mix(tidalCloudHash(c + vec3f(0,0,1)), tidalCloudHash(c + vec3f(1,0,1)), u.x),
        mix(tidalCloudHash(c + vec3f(0,1,1)), tidalCloudHash(c + vec3f(1,1,1)), u.x), u.y), u.z);
}

// Three coherent noise octaves serve both the density and one sun sample.
// Broad fronts carve clear holes; the same field varies cloud type locally.
fn tidalCloudDensity(p: vec3f, coverage: f32, base: f32, structure: vec4f,
                     thickness: f32, drift: vec2f, morph: f32) -> f32 {
  let h = (p.y - base) / thickness;
  let size = max(0.2, structure.y);
  let q = (p + vec3f(drift.x, 0.0, drift.y)) * vec3f(0.0018 / size, 1.5 / thickness, 0.0018 / size);
  let regional = tidalCloudNoise(vec3f(q.x * 0.27, 3.7, q.z * 0.27));
  let billow = clamp(structure.z + (regional - 0.5) * 0.6, 0.0, 1.0);
  let shape = mix(vec3f(0.55, 2.1, 1.6), vec3f(1.0), billow);
  let evolution = vec3f(sin(morph * 0.0017), morph * 0.0012, cos(morph * 0.0013)) * 0.7;
  let broad = tidalCloudNoise(q * shape + evolution);
  let detail = tidalCloudNoise(q * vec3f(2.7, 2.7 + structure.w * 4.0, 2.7) + vec3f(19.2, 7.8, 2.1) - evolution);
  let top = mix(0.55, 0.95, billow) + (broad - 0.5) * 0.25;
  let profile = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(top * 0.55, top, h));
  let localCoverage = coverage + (regional - 0.5) * 0.34;
  let feather = mix(0.12, 0.36, structure.w);
  let field = broad * (1.0 - feather) + detail * feather;
  let mass = clamp((field - (1.0 - localCoverage)) * mix(2.8, 5.0, billow), 0.0, 1.0);
  return mass * profile * structure.x;
}
