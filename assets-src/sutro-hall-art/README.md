# Sutro hall art — the plates hanging in the timber gallery

Seventeen chromolithographs filling the seventeen slots of the hang in
`src/world/sutroBaths/timberGallery.ts` — no plate hangs twice. These files are
the SOURCE; the app loads the published 768 px WebP under `public/sutro/art/`.

```bash
node tools/generate-sutro-art.mjs --list          # what exists, what is missing
node tools/generate-sutro-art.mjs <plate> …       # generate into .data/codex-art
node tools/generate-sutro-art.mjs --accept <plate>=<file>   # after LOOKING at it
npm run build:sutro-hall-art                      # source -> aged crop -> public
```

## How they are made

Generated with an image model — the Codex CLI's image tool, driven
non-interactively with the brief on stdin. `tools/generate-sutro-art.mjs`
automates the loop that the first eight plates were produced by hand: it
resolves the Codex binary (it is not on `PATH`; it ships inside the ChatGPT app
and `CODEX_CLI_PATH` in `~/.codex/config.toml` is the authoritative pointer),
composes `briefs/<name>.txt` with `briefs/_shared-style.txt`, and runs a few
children concurrently.

`_shared-style.txt` is appended verbatim and last to every brief: the same
period, the same flat spot-colour chromolithograph language, and the same
palette the hall's timber and ironwork already use. That block is why
independently generated plates read as one collection on one wall — the
collection coheres because the style text is identical, not because the subjects
are similar. To re-generate everything, retune that block rather than the
individual briefs.

## Review is a required step, not a courtesy

Image models get typography wrong, and a misspelled poster hangs on a wall in
front of players. The generator writes only into `.data/codex-art/` and builds a
contact sheet; `--accept` is the one command that writes into this directory,
and it exists so that copying a plate into the repo is a separate, deliberate act
performed after somebody has actually read the words in the picture. There is no
auto-accept flag on purpose. Generate more than one variant when a plate is
type-heavy (`--variants 2`).

## Why WebP sources

Archived at quality 92 rather than as PNG: full authored resolution (1536 px on
the long edge, the model's native output), visually lossless for the one thing a
source is for here — re-cropping to a different plate aspect — at a sixth of the
repo weight. The briefs are committed beside them, so a full regeneration is
always available as the real fallback.

## The drawn fallback

`tools/build-sutro-hall-art.mjs` contains a complete vector implementation of
the original eight plates and uses it for any of those whose source file is
missing. That is what a machine without an image model bakes, and it is the
reference for the house style — delete one of those eight sources and that plate
reverts to it.

The nine plates added since are source-only: they have no vector twin, and the
builder fails loudly naming the file to generate rather than baking a hole in
the wall. That is the deliberate trade — hand-drawing a second implementation of
every new plate costs more than it protects, now that generation is one command.
