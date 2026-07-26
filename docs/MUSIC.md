# The generative score

The soundtrack is composed at runtime, in the browser, with no streamed music.
There is no loop and no playlist: a director schedules chords, bass, melody and
percussion 1.6 s ahead of the audio clock, and **where you are standing decides
what plays**.

Everything lives under `src/audio/music/`. It is deferred behind the first user
gesture (`docs/LAZY_LOADING.md`) — nothing here loads at boot.

## The one rule

**A place's identity is data, not code.** To make somewhere sound different, add
or edit an entry in `regions.ts`. Do not add a bespoke synth voice, a bespoke
sequencer, or a per-place special case in `director.ts` — that is the same class
of regression as hand-rolling foliage instead of using the vegetation runtime.

If a region genuinely needs a sound the palette cannot make, add the *voice* to
the shared registry (`voices/`) and the *id* to `voiceTypes.ts`, so every other
region can reach for it too.

## Layout

| file | owns |
|---|---|
| `regions.ts` | **the map.** 32 places × a full `MusicProfile`. Pure data + blend math, Node-safe. |
| `theory.ts` | modes, voicing styles, voice leading, cadences, bass lines. Pure math, Node-safe. |
| `voiceTypes.ts` | the instrument contract + the four family id unions. |
| `voices/` | 23 WebAudio instruments: 8 keys, 6 pads, 4 bass, 5 sparkle. |
| `groove.ts` | 8 procedural drum kits + the pattern sequencer. |
| `percussionWorker.ts` | synthesizes the 51 drum one-shots off-thread. |
| `director.ts` | the conductor. Schedules everything; owns the master chain. |
| `tuning.ts` | the mix knobs, split out so the debug pane can bind them without pulling the engine into boot. |
| `stems.ts` / `stemManifest.ts` | the one remaining baked asset — the tape-dust bed. |
| `phrases.ts` / `phraseManifest.ts` | 16 baked melodic phrases, transposed into key at playback. |

## A `MusicProfile`

Each region names, in full:

- **harmony** — `root`, `dayMode`, `nightMode` (7 modes incl. phrygian and
  harmonic minor), `chordSeconds`, `cadence` (how often the harmony actually
  resolves rather than drifting), `motion` (root pedal → walking bass).
- **spacing** — `voicing`: `thirds` | `quartal` | `shell` | `cluster` | `open`.
  The same chord spaced four ways is most of why a cathedral and a warehouse
  don't sound alike.
- **timbre** — `keysMix` / `padMix` / `bassMix` / `sparkleMix`, weighted maps
  over the instrument registries. Weights are *relative pick odds*, not gains.
- **rhythm** — `kit` (one of 8, incl. `none`), `bpm`, `swing`.
- **texture** — `sparkle`, `crackle`, `warmth`, `reverb`, `pad`, `keys`, `bass`,
  `groove`, `dust`.

Two things to know when editing:

1. **Every new numeric field must be added to `NUMERIC_KEYS`** or it silently
   never blends. There is a compile-time guard (`NUMERIC_KEYS_COVER_PROFILE`)
   that fails typecheck if you forget.
2. **`priority` layers regions.** 0 = district, 1 = park/shore, 2 = landmark,
   3 = interior. A region is masked by everything on a strictly higher layer, so
   Grace Cathedral wins inside Nob Hill and the Tea Garden wins inside Golden
   Gate Park, without either fading badly at the door.

## How blending works

`blendMusic()` composites influence like coverage, not like a sum:

- the city's share is `Π(1 − influence)` — the odds that no named place covers
  you — so it can never go negative or double-count overlapping neighbours;
- numeric fields and the four voice mixes are influence-weighted and normalised;
- **discrete** fields (`root`, modes, `voicing`, `kit`) can't be averaged, so the
  strongest masked region owns them, with 5 s of hysteresis in the director and
  the switch committed only at a chord boundary.

Because timbre is a weighted *draw* per gesture, standing on a boundary hears the
two ensembles interleave rather than one snapping into the other.

## What makes it not sound generated

- **Cadences.** Every so often the drifting walk is replaced by a scripted
  arrival (plagal, ii–V–I, ♭VII–I, phrygian…). A few resolutions an hour is the
  difference between a bed and a piece.
- **Arrival figures.** When a new region takes the key it plays one rising
  pentatonic gesture in its own instrument — a place saying its own name.
- **Sections.** A slow arrangement brain moves between keys-forward passages,
  beatless pad drifts, groove-led stretches and short near-silent breaths.
- **Unrelated clocks.** Chord duration jitter, Poisson-ish sparkles and the
  section timer never line up, so nothing repeats audibly.
- **Humanized percussion.** σ = 8 ms timing jitter, ±15% velocity, per-bar
  ghost/drop/fill rolls and round-robined sample variants. Two consecutive bars
  are never identical.

## Percussion is procedural

The three baked drum loops are gone. A fixed loop can only ever be the same eight
bars everywhere; `groove.ts` performs 16/32-step pattern tables per region with
per-kit tempo scaling, swing, density and fills. The DSP is ported from
`tools/music/render_stems.py` so the *sound sources* are the hand-tuned ones.

It is also much cheaper: **2.6 MiB** of synthesized buffers versus roughly 28 MB
of decoded stereo `AudioBuffer` for the three MP3s, and 650 KB less to download.

## Working on it

```bash
# render the score offline at every notable location, faster than realtime
node tools/music-render.mjs                      # 17-stop day tour → .data/music-render/*.mp3
node tools/music-render.mjs --only mission,fidi --seconds 60
node tools/music-render.mjs --night

# the lazy-loading + musical-runtime contract probe
node tools/lofi-music-probe.mjs
```

`tools/music-render.mjs` drives the real director against an `OfflineAudioContext`
in headless Chrome — no world boot, no WebGPU. It is the fastest way to actually
hear a change.

In the running app the mix is under **Score · keys / pads / bass / beats / space**
in the debug pane, and `__sf.lofiMusic.debugState` reports the live key owner,
voicing, kit, chosen voices, cadence and per-region influence.
