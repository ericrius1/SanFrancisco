# Living score

The non-diegetic score is a set of long, synchronized Suno Studio stems. It is
separate from the procedural world soundscape: wind, grass, wildlife, streams,
waves, vehicles, footsteps, and impacts remain synthesized or spatially
sampled by their existing systems.

## Runtime

`src/audio/livingScore.ts` owns two streaming decks. A deck keeps every stem in
one source set on the same transport, then automates the roles independently:
drums, bass, harmony, melody, texture, and accents. Passages change density and
instrumentation without restarting the music. Region changes and playlist
rotations use a fourteen-second two-deck crossfade.

Long files use `HTMLAudioElement` streaming into the shared Web Audio graph.
Decoding six four-minute stereo WAV files into `AudioBuffer`s would consume
hundreds of megabytes; streaming keeps memory bounded. The director periodically
measures each stem against the transport leader and corrects small drift with a
subtle playback-rate nudge. Large drift is repaired only while that stem is
inaudible.

The score enters the existing `music` bus, so the master mixer, mute, microphone
duck, page suspension, and underwater filter remain authoritative. The director
also ducks itself near authored live performers (Corona buskers, Marshall's
Beach pianist, and Fort Mason ensemble).

## Loading contract

Clean boot imports no living-score code and requests no living-score media. A
first user gesture unlocks the shared `AudioContext`; after the arrival front is
settled, `worldSystemsCore` dynamically imports the director. The director then
requests `public/audio/music/manifest.json` and only the stem set selected for
the player's current region. A new region or scheduled playlist rotation loads
one replacement set and disposes the outgoing deck after its crossfade.

## Musical geography

`src/audio/livingScoreRegions.ts` maps authored places to musical profiles.
Small exhibit circles override broad park/coast rectangles. A seven-second hold
prevents border chatter.

- Golden Gate Park — organic lo-fi canopy
- Japanese Tea Garden — sparse water-and-wood stillness
- Ocean Beach and Lands End — tidal ambient
- Sutro Baths — submerged memory
- Presidio — foggy chamber electronica
- Marin — airborne open-sky post-rock ambient
- Buena Vista Afterlight — nocturnal cosmic synthesis
- Mission and Castro — sun-warmed psychedelic downtempo
- Downtown — daylight California glow or nocturnal neon pulse
- Bay waterfront — glassy light-on-water electronica
- Blue hour — rain-softened city lo-fi

## Asset manifest

The manifest schema is exported from `src/audio/livingScore.ts`. Every set
records its Suno source id, musical profile, authored BPM/key, duration, safe
loop window, and its role-labelled delivery stems. `totalStemSeconds` is the sum of all
individual stem durations—not the duration of the source mixes—and must remain
at least 10,800 seconds (three hours).

Published game assets are compressed delivery files. Original Suno downloads,
review mixes, loudness measurements, and separation archives remain working
material and should not be copied into `public/`.

For each reviewed Studio export, unpack its audio files beneath `.data/` and run
`tools/prepare-living-score-set.mjs` with the set metadata. It creates the
streaming AAC files and a local `set.json`. After all sets are ready,
`npm run build:living-score-manifest` validates every referenced asset, totals
the individual stem duration, enforces the three-hour floor, and writes the
runtime manifest.
