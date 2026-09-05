fn resolveCloudFrame(history: texture_2d<f32>, inverseProjection: mat4x4f,
    cameraMatrix: mat4x4f, previousViewProjection: mat4x4f, coord: vec2f,
    origin: vec3f, sun: vec3f, phase: f32, coverage: f32, base: f32,
    steps: f32, historyWeight: f32, frame: f32, resolution: vec2f) -> vec4f {
  // WebGPU framebuffers have a top-left origin and zero-to-one clip depth.
  let view = inverseProjection * vec4f(coord.x * 2.0 - 1.0, 1.0 - coord.y * 2.0, 0.5, 1.0);
  let ray = normalize((cameraMatrix * vec4f(normalize(view.xyz / view.w), 0.0)).xyz);
  let current = tidalClouds(origin, ray, sun, coord * resolution + vec2f(frame * 0.754877, frame * 0.569841), phase, coverage, base, steps);
  if (historyWeight <= 0.0 || abs(ray.y) < 0.015) { return current; }
  let distance = clamp((base + 210.0 - origin.y) / ray.y, 1.0, 18000.0);
  let clip = previousViewProjection * vec4f(origin + ray * distance, 1.0);
  let uv = vec2f(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
  if (clip.w <= 0.0 || any(uv < vec2f(0.001)) || any(uv > vec2f(0.999))) { return current; }
  let dims = textureDimensions(history);
  let pixel = uv * vec2f(dims) - vec2f(0.5);
  let cell = vec2i(floor(pixel));
  let f = fract(pixel);
  let hi = vec2i(dims) - vec2i(1);
  let a = textureLoad(history, clamp(cell, vec2i(0), hi), 0);
  let b = textureLoad(history, clamp(cell + vec2i(1,0), vec2i(0), hi), 0);
  let c = textureLoad(history, clamp(cell + vec2i(0,1), vec2i(0), hi), 0);
  let d = textureLoad(history, clamp(cell + vec2i(1,1), vec2i(0), hi), 0);
  let previous = mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
  // Reject newly exposed density boundaries; clamp radiance to the current
  // sample so fast sun/coverage changes cannot drag bright trails through it.
  let confidence = 1.0 - smoothstep(0.04, 0.18, abs(previous.a-current.a));
  let bounded = clamp(previous, max(vec4f(0.0),current-vec4f(0.12)), current+vec4f(0.12));
  return mix(current, bounded, historyWeight * confidence);
}
