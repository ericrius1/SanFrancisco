# Audit: third baked drum stem — "brush kit" for parks

## Files changed

- `tools/music/render_stems.py` — added `render_brush()` and wired it into `main()`
- `src/audio/music/stemManifest.ts` — added `beatBrush` to `StemId` and `STEM_DEFS`
- `public/audio/music/stems/beat-brush.mp3` — new rendered asset (untracked binary, not committed)

## What changed per file

### tools/music/render_stems.py
Added `render_brush(*, bpm=66, bars=8, seed=41, tail=2.5)`, placed just before `render_dust`. Reuses existing helpers only (`place`, `kick`, `rim`, `shaker`, `lowpass`, `saturate`, `env_exp`, `seconds`) — no new low-level primitives.

Per bar:
- Kick: `kick(rng, deep=True)` gain 0.35, beat 1 only, only on bars where `bar % 2 == 0` (0,2,4,6). Bar 0's kick uses the `human(t0, first=True)` fixed 0.002s anchor exactly like `render_groove`.
- Wood clicks: `rim(rng, soft=True)` at beats 1.5, 2.75, 3.25, each independently gated at `rng.random() < 0.5`, gain `0.25 + 0.10*rng.random()` (0.25-0.35 range), pan 0.2.
- Shaker: 16 steps/bar, `rng.random() > 0.85` skip (≈85% hit probability), swung 16ths via `frac = s*0.25 + ((swing-0.5)*0.5 if s%2==1 else 0.0)` — the swing constant `0.585` scaled to the half-length 16th-pair (mirrors `render_groove`'s 8th-pair treatment scaled down by 2x since a 16th pair spans half a beat vs. a full beat for 8ths). Velocity `0.19 + 0.09*sin(s*1.1+bar) + 0.05*rng.random()`, clamped `[0.1, 0.28]`. Pan 0.35.
- Swirl: one `shaker(rng, open_=True)` per bar at a uniformly random beat position (`rng.random()*4*beat`), gain 0.4, same pan 0.35.
- Humanize: identical `human(t, first=False)` closure as `render_groove` — gaussian jitter `N(0, 0.008)` seconds, except the very first event of bar 0 (the kick) which is pinned to `max(0.002, t)`.
- Bus: `saturate(mix, 1.15)` → per-channel `lowpass(..., 3200)` → normalize peak to exactly 0.5.

`main()` now calls `write_mp3("beat-brush", render_brush())` between the `beat-dusk` and `dust` writes, and the final print line was extended with `beat-brush = 8*4*60/66`.

No existing code path (`render_groove`, `render_dust`, the `beat-warm`/`beat-dusk`/`dust` calls, or any helper) was touched — confirmed via `git diff --stat` showing only additive changes, and via the render output below matching the pre-existing peak/rms character for those three files.

### src/audio/music/stemManifest.ts
- `StemId` union extended: `"beatWarm" | "beatDusk" | "beatBrush" | "dust"`.
- New `beatBrush` entry added to `STEM_DEFS` (inserted before the `dust` entry, after `beatDusk`):
  ```ts
  // 66 BPM brushed organic kit — parks
  beatBrush: {
    id: "beatBrush",
    url: "/audio/music/stems/beat-brush.mp3",
    loopSeconds: (8 * 4 * 60) / 66,
    detectLead: true,
    gainTrim: 0.5
  },
  ```
- `STEM_IDS` is derived via `Object.keys(STEM_DEFS)`, so it picks up `beatBrush` automatically — no edit needed there.

No other file touched (director.ts, regions.ts, stems.ts left untouched, per instructions — those are being edited concurrently by someone else).

## Deviations from plan

None. All recipe parameters (kick gain/bars, wood-click positions/probability/pan/gain, shaker density/velocity range/pan, swirl gain, bus processing, humanize approach, manifest fields) match the plan exactly.

## Test results

### Render (`python3 tools/music/render_stems.py`)
```
public/audio/music/stems/beat-warm.mp3   29.17s  peak=0.500 rms=0.0798 size=214KiB
public/audio/music/stems/beat-dusk.mp3   35.60s  peak=0.500 rms=0.0796 size=193KiB
public/audio/music/stems/beat-brush.mp3   31.59s  peak=0.500 rms=0.0481 size=289KiB
public/audio/music/stems/dust.mp3   24.00s  peak=0.500 rms=0.0365 size=437KiB

loopSeconds: beat-warm = 26.666666666666668  beat-dusk = 33.10344827586207  beat-brush = 29.09090909090909  dust = 20.0
```
All four files rendered. `beat-warm`/`beat-dusk`/`dust` durations and peaks are unchanged from their known baseline (same seeds, untouched code paths) — `git status` confirms only `beat-brush.mp3` is a new/untracked file under `public/audio/music/stems/`, the other three are not modified.

### tsc
`npx tsc --noEmit` produces pre-existing errors in files outside scope (concurrent edits to director.ts/regions.ts/stems.ts per the task notice); grepped output for `stemManifest.ts` — zero matches, i.e. no errors in the file this task touched.

### Decode sanity check
```
dur=31.59s lead=2.2ms peak=0.500
```
Matches expectation: dur ≈ 31.6s (29.09 loop + 2.5 tail, actual 31.59), lead 2.2ms (well under ~20ms), peak exactly 0.500.

## Open risks

- `beat-brush.mp3` is a new binary asset left untracked in the working tree (not committed, per instructions not to commit). Whoever finalizes this branch needs to `git add` it alongside the two source files.
- The swing-scaling choice for 16th pairs (`(swing - 0.5) * 0.5`) is a reasonable interpretation of "using the same 0.585 swing constant applied to 16th pairs" but wasn't explicitly pinned to a formula in the task — flagging in case the reviewer wants a different scaling.
- No listening/perceptual QA was done beyond the numeric peak/rms/lead checks — recommend an ear-check before shipping to confirm the "organic, airy, no backbeat" character lands as intended.
