# People of the city

32 fictional residents inhabit 16 authored pedestrian locations. Approach on foot
and press E (or the controller interaction button), choose with up/down, confirm
with Enter/E, and leave with Escape or by walking away. The People button beside
Share opens a notebook with remembered words and destinations to visit.

Conversations have an everyday branch, a deeper reflection, a connection to
someone elsewhere, and a farewell. Connections can be discovered in either order.
Hearing a linked resident's reflection unlocks a different authored response;
meeting somebody alone does not claim that the player heard their whole story.
There are no mandatory quests, delivered messages, or automatic reconciliations.

## Ownership and loading

- `gameplay/cityStories/places.ts`: boot-safe coordinates and one dynamic chapter
  import per place. Opening the notebook never fetches the resident catalog.
- `gate.ts`: world-ready/proximity admission, lazy notebook, input suspension,
  covered navigation through the existing arrival controller, HMR disposal.
- `runtime.ts`: at most four nearby places; one chapter/rig build in flight;
  enter at 90 m, unload at 155 m, animate only inside 48 m. Conversations choose
  only the nearest available resident, with vertical separation checks. Nearby
  people can load while driving, but conversation requires being on foot.
- Sutro's central deck and the skate plaza require their host sites to be ready.
  Ground follows the live terrain/bridge sampler; Sutro uses its authored 5.62 m
  deck. No optional site is imported by the resident feature to force readiness.
- Characters reuse the shared merged WebGPU avatar rig. Unload disposes owned
  palettes, skeletons, book attachments and dialogue DOM; shared rig geometry
  remains owned by the avatar cache. No external character/media requests.
- `journal.ts` / `journal.css`: imported only when People is clicked. Native modal
  focus handling plus an Input suspension hold prevents gameplay under the journal.

## Evolving lives later

Keep resident IDs and speaker IDs stable. Appearance seeds are separate from
conversation selection. Each place currently resolves to an authored chapter
with a revision; replacing that snapshot does not replace a resident's identity.
`createResidentProvider` selects the dialogue separately from embodiment and
presentation, and implements the existing abortable `DialogueProvider` contract.
A future resolver can select a chapter using a world clock, shared events or
relationship state, or supply a different provider, while keeping the same NPC
runtime, notebook and interaction controls.

Listening history is **the local player's knowledge**, not canonical world state.
`sf.city-stories.v1` stores bounded, versioned entries with revision-qualified beat
IDs and a separate reflection-heard flag. Record only delivered dialogue via the
conversation's action-on-show callback. Cancelling a pending provider must not
record a line that was never delivered. Invalid/unsupported storage falls back
to an empty notebook; denied or full storage keeps session memory usable.

For shared evolving stories, add canonical narrative state separately and pass
an immutable context snapshot into the resolver/provider. Do not infer a change
in another character's feelings from a local notebook entry. Retain old stable
IDs and migrate storage explicitly when its schema changes; incrementing a
chapter revision permits fresh beats without erasing who the player has met.

## Validation

`node --experimental-strip-types tools/city-stories-probe.mjs` validates the
cast, cross references, branching, memory, revisions, persistence and cancellation.

`SF_PROBE_URL=http://localhost:5274 node tools/city-stories-browser-probe.mjs`
uses headless Chrome with WebGPU. It checks a clean boot away from residents,
notebook-only activation, the first place, real dialogue controls, then a second
place: no eager cast, exactly the requested chapter each time, and distant rig
unload. Screenshots and request audits stay under `.data/city-stories/`.
