# Cinematic rendering

This is the long-term film layer for the live San Francisco world. Shots use the
real scene, actors, vehicles, physics, lighting, and WebGPU renderer; the
cinematic code only stages those systems, drives a deterministic timeline, and
owns the camera. The current reference productions are a 15-second hoverboard
customization film and an 11-second sunset dog-park film.

## Pipeline at a glance

| Layer | Responsibility |
| --- | --- |
| `src/cinematic/` | Typed shots and cues, curve and rig helpers, physical-lens camera poses, preflight safety checks, and frame-driven titles/letterbox. |
| `src/dev/demos/*Cinematic.ts` | Production-specific world staging, real gameplay actions, shot list, and visual beats. `src/dev/demo.ts` registers browser entry points such as `/?demo=hoverboard`. |
| `tools/cinematic/productions.mjs` | The single current production-settings schema: duration, resolution, frame rate, seed, review times, format, and encode quality. |
| `tools/cinematic/capture.mjs` | Private Vite/Chrome launch, fixed-time replay, WebGPU-safe frame capture, encode, review artifacts, and technical audit. |
| `tools/cinematic/audio.mjs` | Picture-locked, seeded 48 kHz stereo score and sound-design render. |
| `tools/cinematic/transition.mjs` | Deterministic picture/audio transition and final assembly. |
| `tools/render-cinematic.mjs` | CLI orchestration and process cleanup. |

The pipeline has two output tiers. The archival master captures a lossless PNG
sequence and encodes H.264 CRF 15. The fast renderer reads the same final WebGPU
render target through a two-slot staging-buffer ring and streams it to Chrome's
WebCodecs H.264 encoder, avoiding PNG screenshots and intermediate image files.
Both use the same deterministic timeline, offline AAC audio, `yuv420p`, explicit
BT.709 metadata, review artifacts, and technical audit.

The default is 1920x1080 at 60 fps. Requirements are Node dependencies, Chrome
or Chromium with WebGPU, and `ffmpeg`/`ffprobe` on `PATH`; fast capture also
requires browser WebCodecs H.264 support. `CHROME_BIN`, `FFMPEG_BIN`, and
`FFPROBE_BIN` may point to custom executables.

## Commands

```bash
# Fast composition checks; each requested frame is still simulated from frame 0.
npm run render:cinematic -- hoverboard --probe-at 2.8,7.9,13.5
npm run render:cinematic -- dog-park --stills

# Fast, audited review films. These are the normal choice while iterating.
npm run render:hoverboard:fast
npm run render:dog-park:fast
npm run render:cinematics:fast

# Audited individual masters.
npm run render:hoverboard
npm run render:dog-park

# Render both, then create the combined plume-to-play film.
npm run render:cinematics

# Rebuild only the combined film from existing individual masters.
npm run render:cinematic -- --combine
```

Use `--fast` with any production for an audited review render without a PNG
sequence; it implies `--full` and defaults the take name to `fast`. Its default
24 Mbps target can be changed with `--fast-bitrate` or
`SF_CINE_FAST_BITRATE`. If the browser cannot provide the required WebCodecs
H.264/Annex-B path, the command exits with a capability error; rerun without
`--fast` for the portable archival path.

Run `npm run render:cinematic -- --help` for resolution, fps, frame format,
quality, take-name, seed, and settle-frame overrides. Environment equivalents
use the `SF_CINE_*` prefix. Settings intentionally have one current schema; add
new defaults directly to `tools/cinematic/productions.mjs` rather than adding
legacy migrations.

## Authoring a production

1. Create `src/dev/demos/<name>Cinematic.ts`, export a `Demo`, and register it in
   `src/dev/demo.ts`. Call `cleanPlate(ctx.hud)`, stage only the actors and world
   systems the story needs, and use the real gameplay seams for visible actions.
2. Call `armCinematic` with a duration and contiguous `CinematicShot` ranges
   covering exactly `0..duration`. Camera functions should be pure functions of
   `ShotSample`; use `railCamera`, `orbitCamera`, `setPose`, and the curve helpers
   instead of wall-clock motion. Lens values are focal lengths in millimetres.
3. Put one-shot state changes in sorted `CinematicCue`s and continuous staging
   in the frame callback. Do not use CSS animations, timers, or unseeded
   randomness for anything visible. Stateful simulations must be replayable from
   frame zero.
4. Add the production definition to `tools/cinematic/productions.mjs`. If it has
   bespoke audio, add its exact duration, cue plan, and synthesis/mix branch to
   `tools/cinematic/audio.mjs` beside the picture timings.
5. Probe the beginning, end, every cut, every major action, and any macro lens.
   Inspect the contact sheet and individual full-resolution frames before
   starting a master render.

The director exposes `window.__sfCinematicReport()` for the harness. It records
the shot map, final frame state, and camera audit in the frame manifest, making a
render traceable back to its authored timeline.

## Determinism and capture safety

The capture harness injects a seeded `Math.random` before any application code
runs. It then settles the world, advances cinematic time by the exact fixed
`1 / fps` step, and replays every simulation frame in order. Probe and still
modes skip unwanted screenshots, not simulation; there is deliberately no
partial-seek capture API. This keeps stateful physics, particles, dogs, and
vehicle effects consistent with a full render.

The archival path gives every screenshot one authoritative frame barrier:
advance the timeline and app tick, wait for browser composition, await
`WebGPUQueue.onSubmittedWorkDone()`, compose once more, and await the queue again.
The manifest marks captured frames `gpuComplete`. The fast path instead renders
the final post-FX image to an RGBA8 texture, queues an ordered
`copyTextureToBuffer`, and maps the previous frame's staging buffer while the GPU
fills the next. Its canvas overlay mirrors the deterministic DOM film layer so
titles and letterbox bars are included before WebCodecs encoding. Do not replace
either synchronization scheme with a JavaScript-only wait: a tick completing
does not mean WebGPU has finished drawing the pixels being captured.

Camera rails are preflight-sampled before frame zero. The audit reports terrain
clearance, optional line-of-sight occlusion, excessive per-sample travel, and
abrupt view reversals. Runtime correction is limited to a terrain floor clamp;
occlusion is fixed in the authored rig so capture does not acquire collision
jitter. Treat any camera-audit issue as a composition review item even when it
is not a technical failure.

`cleanPlate` removes app/loading chrome. `CinematicOverlay` then adds only the
film layer: safe-area cards, chapter/progress treatment, and letterbox bars. All
overlay transforms and opacity are derived from the current frame time; there
are no CSS animations for the capture clock to race.

## Audio, assembly, and QA

Audio is rendered offline after picture capture as deterministic 48 kHz stereo
PCM. Cue timings live beside the synthesis plan, so customization clicks,
propulsion changes, throws, bounces, paws, and resolves remain picture-locked.
The dog-park mix may layer the repository's CC0 nature beds. The combined film
uses a seeded whoosh/sparkle/impact design and an equal-power crossfade through
the visual transition.

Work files live under `.data/cinematics/<production>/<take>/` and include the
frame manifest, PCM audio, and either master frames or the fast Annex-B H.264
bitstream. Review and delivery artifacts live under `renders/cinematics/`:

```text
renders/cinematics/<production>/<production>-<take>.mp4
renders/cinematics/<production>/<production>-<take>.poster.jpg
renders/cinematics/<production>/<production>-<take>.contact.jpg
renders/cinematics/<production>/<production>-<take>.audit.json
renders/cinematics/<production>/<production>-<take>.frames.json
renders/cinematics/combined/hoverboard-to-dog-park-<take>.*
```

The audit verifies dimensions, fps, duration, exact frame count, codecs, pixel
format, BT.709 tags, and non-silent audio. It fully decodes the film for black
segments and long freezes and measures final-mix RMS/peak. The manifest also
captures the source Git revision/dirty state and browser console, exception, and
network diagnostics. Technical success is necessary but not sufficient: always
review the poster, 12-frame contact sheet, cuts, action peaks, title-safe text,
and transition frames at full resolution.

On the reference development machine, the 15-second hoverboard production at
1080p60 captured in 46.20 seconds with the fast backend versus 253.07 seconds
for the PNG master: 5.48x faster, with all 900 frames and the final audit
passing. This is a workflow benchmark, not a fixed guarantee; scene cost,
resolution, Chrome, and GPU/video-encoder hardware all affect it. Use fast
renders for dailies and iteration, then make a PNG master for final delivery or
archival.

## Eidoverse research and licensing

The architecture was informed by a clean-room review of
[SkyeShark/eidoverse-video](https://github.com/SkyeShark/eidoverse-video), pinned
for research at commit
[`08aa5be82e0315386503f8d3b681772cdb0027dd`](https://github.com/SkyeShark/eidoverse-video/tree/08aa5be82e0315386503f8d3b681772cdb0027dd).
The reusable ideas were deterministic frame-time capture, replay from zero,
camera safety checks, clean plate/overlay separation, GPU completion barriers,
probe-first review, render manifests, and a particle-morph transition grammar.

No Eidoverse source code was imported or copied into this project because that
repository is AGPL-3.0 licensed. The implementation here was written
independently for this world's existing architecture. Research references:

- [Repository guidance (`AGENTS.md`)](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/AGENTS.md)
- [Scene renderer](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/eidoverse/render_scene.mjs)
- [Shared render harness](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/eidoverse/render_common.mjs)
- [Camera safety](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/eidoverse/camera_safety.js)
- [Custom effects](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/eidoverse/effects_tsl/custom_effects_deno.js)
- [Particle morph](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/eidoverse/particle_morph.js)
- [Harness mode](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/docs/HARNESS_MODE.md)
- [Techniques archive](https://github.com/SkyeShark/eidoverse-video/blob/08aa5be82e0315386503f8d3b681772cdb0027dd/techniques_archive.md)
