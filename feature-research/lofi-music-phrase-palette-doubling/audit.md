# Audit: double the baked melodic phrase palette

## Files changed

- `tools/music/render_phrases.py` — appended 8 new tuples to `PHRASES` list.
- `src/audio/music/phraseManifest.ts` — appended 8 matching `PhraseDef` entries to `PHRASE_DEFS`.

(New binary assets `public/audio/music/phrases/{drift-bright,high-bright,step-bright,swell2-bright,fall-dusk,float-dusk,step-dusk,swell2-dusk}.mp3` were also produced by running the renderer, as instructed — these are generated output, not hand-edited files.)

## What changed per file

### tools/music/render_phrases.py
Appended exactly the 8 specified entries (`drift-bright`, `high-bright`, `step-bright`, `swell2-bright`, `fall-dusk`, `float-dusk`, `step-dusk`, `swell2-dusk`) to the end of the `PHRASES` list, preserving the existing `(name, flavor, voice, notes)` tuple format. No other lines in the file were touched.

### src/audio/music/phraseManifest.ts
Appended 8 matching `PhraseDef` entries to `PHRASE_DEFS`, one per new phrase, following the existing style: `url: "/audio/music/phrases/<name>.mp3"`, `flavor` matching the Python entry, `voice: "rhodes"` with `gainTrim: 0.8` for rhodes phrases, `voice: "ks"` with `gainTrim: 0.7` for the two ks swell phrases (`swell2-bright`, `swell2-dusk`). No other lines in the file were touched.

## Deviations from plan

None. Task executed exactly as specified — only the two named files were edited.

## Test results

Ran `python3 tools/music/render_phrases.py`:

```
public/audio/music/phrases/sigh-bright.mp3   7.84s  size=79KiB
public/audio/music/phrases/lift-bright.mp3   7.20s  size=65KiB
public/audio/music/phrases/turn-bright.mp3   8.02s  size=74KiB
public/audio/music/phrases/sigh-dusk.mp3   7.38s  size=67KiB
public/audio/music/phrases/turn-dusk.mp3   7.75s  size=64KiB
public/audio/music/phrases/ask-dusk.mp3   8.11s  size=69KiB
public/audio/music/phrases/swell-bright.mp3   7.41s  size=67KiB
public/audio/music/phrases/swell-dusk.mp3   7.77s  size=69KiB
public/audio/music/phrases/drift-bright.mp3   7.93s  size=79KiB
public/audio/music/phrases/high-bright.mp3   6.84s  size=76KiB
public/audio/music/phrases/step-bright.mp3   8.29s  size=70KiB
public/audio/music/phrases/swell2-bright.mp3   7.95s  size=64KiB
public/audio/music/phrases/fall-dusk.mp3   8.29s  size=80KiB
public/audio/music/phrases/float-dusk.mp3   8.11s  size=81KiB
public/audio/music/phrases/step-dusk.mp3   8.47s  size=70KiB
public/audio/music/phrases/swell2-dusk.mp3   8.32s  size=72KiB
```

16 files rendered (8 pre-existing re-rendered byte-identically from fixed seeds as expected, 8 new). Total palette size: 1176 KiB (~1.1 MiB) across all 16 mp3s.

`ls public/audio/music/phrases/` confirmed 16 files present.

`npx tsc --noEmit 2>&1 | grep -i phraseManifest` returned no output — no TypeScript errors reference `phraseManifest.ts`. (The full `tsc --noEmit` run does show errors elsewhere, in `regions.ts` / `stemManifest.ts` / `render_stems.py`-adjacent TS files, which are being concurrently edited by another agent per the task instructions — out of scope, ignored.)

## Open risks

- None specific to this change. The 8 new phrases were authored strictly from pentatonic tones (slot = pentatonic index + 5*octave) matching the existing convention, so they should stay consonant over diatonic chords like the originals.
- Did not modify `director.ts` or `phrases.ts` per instructions (confirmed via `git status --short`: only `phraseManifest.ts` and `render_phrases.py` show as modified by this session; `regions.ts`, `stemManifest.ts`, `render_stems.py`, and stem mp3 changes belong to the concurrent agent).
- No commit was made, per instructions.
