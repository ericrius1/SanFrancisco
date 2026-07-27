# Sutro hall art — the plates hanging in the timber gallery

Eight chromolithographs, one per bay layout in
`src/world/sutroBaths/timberGallery.ts`. These files are the SOURCE; the app
loads the published 768 px WebP under `public/sutro/art/`.

```bash
npm run build:sutro-hall-art     # source plate -> aged crop -> public/sutro/art
```

## How they were made

Generated with an image model (Codex's image tool, driven non-interactively —
`codex exec` with the brief on stdin), one session per plate. The briefs are in
`briefs/`, and `briefs/_shared-style.txt` is the style block appended to every
one of them: the same period, the same flat spot-colour chromolithograph
language, and the same palette the hall's timber and ironwork already use, so
eight independently generated plates read as one collection on one wall.

To re-generate a plate, feed its brief back through the same tool and drop the
result in beside the others. To re-generate ALL of them, expect to re-tune the
shared style block rather than the individual briefs — the collection reads as a
set because that block is identical, not because the subjects are similar.

## Why WebP sources

Archived at quality 92 rather than as PNG: full authored resolution (1536 px on
the long edge, the model's native output), visually lossless for the one thing a
source is for here — re-cropping to a different plate aspect — at a sixth of the
repo weight. The briefs are committed beside them, so a full regeneration is
always available as the real fallback.

## The drawn fallback

`tools/build-sutro-hall-art.mjs` still contains a complete vector
implementation of all eight plates, and uses it for any plate whose source file
is missing. That is what a machine without an image model bakes, and it is the
reference for the house style. Delete a source and that plate reverts to it.
