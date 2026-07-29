# San Francisco

An open-world San Francisco you can **walk, drive, scoot, skate, surf, fly,
sail and soar** through — with friends. It's rebuilt from real OpenStreetMap
building/road data and USGS elevation, and everything is a rigid body: cars,
boats and bodies all collide, and the buildings are solid — you bump and stop
against them. The bay is a spectral-FFT ocean you can swim in.

There's no goal and nothing to win. It's a city-sized sandbox with parks to
wander, sports to play, and a few small worlds tucked inside the big one. Show
up, pick a way to move, and go poke at things.

It runs entirely in the browser on **WebGPU** — three.js/TSL for rendering,
Box3D compiled to WASM for physics, and one small Node process for multiplayer.
There is no game engine, no server-side simulation, and no build step for the
world itself: the city ships as committed data.

> **Just want to play?** [Run it](#run-it), then [How to play](#how-to-play) and
> [Where to go](#where-to-go).
>
> **Here to build on it?** Start at [How it's built](#how-its-built) and
> [Working on it](#working-on-it).

---

## Run it

```bash
npm install
npm run assets:heal   # bakes the gitignored terrain tiles (~1s)
npm run dev           # http://localhost:5179
```

That's the whole setup. The world's assets are committed to the repo
(`public/data` for the heightmap/surface/colliders, `public/tiles` for the GLB
geometry, `public/regions` for authored sites), so there's nothing to download
or generate first. You only need the [asset pipeline](#asset-pipeline) if you
want to change the map itself.

**What `npm run dev` does:** starts vite *and* the multiplayer relay (port 8787)
in one process, and proxies `/ws` to it. Open a second browser window to see
multiplayer working locally. In dev the world auto-enters with a suggested name
once it's ready; production waits for the Start screen.

**You need:**

- **Node 22+** (the Docker image pins `node:22-alpine`).
- **A WebGPU browser.** This project is WebGPU-only by policy — there is no
  WebGL fallback, and boot fails loudly if WebGPU, an adapter, or a device is
  unavailable. Chrome/Edge on desktop is the tested path.
- `git lfs pull` only if you intend to re-bake authored sites from their
  `.blend` sources. Playing and normal feature work don't need it.

### Dev script variants

| Command | What it's for |
| --- | --- |
| `npm run dev` | Normal loop — soft HMR that preserves world state |
| `npm run dev:hmr` | `SF_FULL_RELOAD=1` — full page reload on every edit |
| `npm run dev:play` | `SF_HMR=0` — no HMR at all, for uninterrupted play/QA |
| `npm run build` | Contract tests → `tsc --noEmit` → vite build → precompress |
| `npm start` | Serve `dist/` + the `/ws` relay from one Node process |

### URL flags

| Flag | Effect |
| --- | --- |
| `?startscreen=1` | Keep the Start form in dev (dev otherwise auto-enters) |
| `?autostart=1` | Auto-enter on a preview or production build — use this for browser QA |
| `?spawn=<key>` | Arrive at a named spawn (keys live in `src/world/spawnPoints.ts`) |
| `?zone=<id>` | Boot a **pocket world** around one site only — a fast loop for site work |
| `?read=bts` | Open the "Behind the scenes" reader immediately |
| `?j=…&via=…` | Invite link — the in-game Share button builds these |

Zone ids: `goldman`, `archery`, `pup`, `fort-mason-ensemble`, `palace`,
`afterlight`, `corona`, `lands-end`, `wave-organ`, `beach-pianist`,
`sutro-baths` (`src/app/compose/zoneMode.ts`).

---

## How to play

Pick how you move with the number keys, steer with `W A S D`, and left-click to
use whatever tool is active. That's the whole game. The in-game **Controls**
panel (bottom-right) always shows the live bindings for your current mode and
input device — it's the source of truth; the tables below mirror it.

A fresh session drops you at a **random landmark** from a curated pool — Golden
Gate Bridge, Coit Tower, Corona Heights, Ocean Beach, the Marin redwoods, and a
dozen more. Come back later and you resume where you left off. There's also a
built-in **Tutorial** (top-right) that walks the basics.

### Modes

Press `1`–`8` to switch how you get around.

| | Mode | Notes |
| --- | --- | --- |
| `1` | **Walk** | `Shift` runs, `Space` jumps. Climb anything you can reach; swim where there's water. |
| `2` | **Drive** | A sports car. `Space` is the handbrake, `[` / `]` power-slide, `Shift` boosts. |
| `3` | **Scooter** | Electric scooter — carries a passenger. |
| `4` | **Board** | A hoverboard. `Space` ollies, `A`/`D` carve. |
| `5` | **Plane** | Free flight. Best way to get your bearings over the whole city. |
| `6` | **Boat** | A sailboat on the bay. Heaves and pitches with the swell. |
| `7` | **Drone** | Nimble hover. `U`/`Q` climb and descend; left-click fires fireworks. |
| `8` | **Bird** | Summons a phoenix beside you; `E` mounts its three-person saddle. `Space` flaps, `Shift` tuck-dives, `Q` twirls. |

Two more aren't on the number row — you have to find them. **Surf** unlocks by
pressing `E` on a racked board at the Ocean Beach surf shack, and a bay-only
**speedboat** turns up out on the water.

### Controls

| Key | Action |
| --- | --- |
| `W A S D` | Move / drive / steer (depends on the mode) |
| `Mouse` | Look; left-click uses the current tool |
| `Shift` | Run / boost / tuck |
| `Space` | Jump / handbrake / ollie / flap / air brake |
| `E` | Mount or dismount a ride, pick up a ball, start an activity, talk to someone |
| `1`–`8` | Travel mode. While golfing, picks a club |
| `Ctrl`+`1`–`3` | Jump straight to a click-tool |
| `Shift`+`1`–`9` | Teleport to the numbered player beside you |
| `↑` `↓` / `←` `→` | Toolbar: change row focus / cycle the focused row |
| `Alt`+`←` `→` | Teleport history — back and forward |
| `M` | **Full-city map** — drag/scroll to pan/zoom, click a pin, press Enter to teleport |
| `T` | Text chat |
| `V` | Voice chat mic on/off |
| `J` | Emote wheel (wave, dance, clap, cheer, bow, point, flex, sit) — on foot |
| `C` | Cycle camera: third person → first person → free orbit |
| `Z` (hold) | Scrub the time of day |
| `N` (hold) | Look / speed modifier |
| `P` | Pause (you can still move) |
| `I` | Immersive — every scrap of UI goes away |
| `Tab` | Fade the UI |
| `F` | Fullscreen |
| `Esc` / `⌘` (hold) / `L` | Release the mouse / temporary cursor / toggle pointer lock |

Context keys: `X` flows a surf ride, `G` twice abandons a golf round, `K` opens
the hang-glider customizer, `B` cues the beach pianist's song.

Dev keys: `/` opens the tuning panel and three.js inspector, `R` toggles
wireframe, `H` writes a high-res still to a local folder, `.` resets every tweak
and mixer value to its source default.

### Gamepad

An Xbox-standard controller rides the same rails as the keyboard — `pollPad()`
in `src/core/input.ts` translates it into the key codes the game already reads,
so no mode or camera has a second input path. A = jump, Y = interact/mount
(RDR2 convention), RT = the selected tool on foot, triggers = throttle in
vehicles, Back = map, Start = pause. The HUD swaps its control labels to
whichever device you touched last.

### The tools

Left-click does something different depending on the tool in the toolbar:

- **Ball** — hold to spot a tennis ball, keep holding to wind up, release to
  throw. At Corona Heights, free dogs chase it, carry it back, and wait for you
  to take it with `E`. Two full fetches adopt a dog as a pet.
- **Paint** — sling paintballs. Hits stick to walls, vehicles and players, and
  friends see your shots.
- **Bubbles** — blow soap bubbles that drift on the breeze.

---

## Where to go

Open the map (`M`) and teleport, or just wander. Every pin below is on the map
from the first frame; the heavy content behind it streams in as you approach.

**Parks and vistas**

- **Corona Heights** — red-chert summit with a downtown/Mission vista, a dog
  park just below, and a **jammer trio** (ukulele, handpan, flute) on a boulder
  playing an original songbook. Throw the ball for the dogs.
- **Buena Vista** — a hidden wind observatory in the summit clearing west of
  Corona Heights. Meet Mara and Sol at the loom, press `E`, then gather five
  wandering light-echoes before the fog closes. Restoring the tune calls
  something enormous out of the canopy.
- **Botanical Garden** and the **Japanese Tea Garden** in Golden Gate Park —
  authored landscapes with a drum bridge, pagoda plaza and tea house. The tea
  garden has a rake you can drag through its dry-landscape sand.
- **Lands End · Labyrinth** — cliff-top stone labyrinth, a lantern keeper at its
  mouth, wind-bent cypress on the rim.
- **Wave Organ** — an acoustic sculpture at the tip of the Marina breakwater.
  Stand still beside each of the five pipes to wake its voice; wake all five and
  the organ remembers its song.
- **Marin Redwoods**, **The Presidio**, **Mount Sutro**, **Marin Headlands** —
  four-tier native groves with rideable bears and raccoons in the Marin woods.

**Things to do**

- **Presidio Golf** — 18 playable holes on the real course footprint. Aim with
  the camera, clubs with `1`–`9`, hold and release click to swing. Ball and
  score are shared online.
- **Goldman Tennis & Pickleball** — walk up to an athlete and press `E` to take
  a side. Online play is slot-arbitrated so two friends can rally.
- **Archery Range** — NW corner of Golden Gate Park. `E` for a bow, stand on the
  white shooting line, hold click to draw.
- **Ocean Beach · Surf** — press `E` on a racked board at the shack and paddle
  out into a live wave face. There's a kite festival on the sand too.
- **Sutro Tower · Skyline Glide** — hang gliding off the summit, with its own
  canopy customizer (`K`).
- **Puppy Nursery** (Marina Green) — Biscuit is a live active-ragdoll puppy
  driven by a neural net that an overnight trainer keeps improving. The glowing
  lattice overhead is its actual network. See [`rl/README.md`](rl/README.md).

**Small worlds inside the big one**

- **Sutro Baths · 1896** — the vanished glass bath house, restored: seven pools
  under a barrel vault, swimmable, with a working pavilion clock and a hung
  gallery.
- **Mission Dolores · Saint Francis** — a walk-in basilica museum with exhibits
  and a canticle book.
- **Palace Reverie** — a lantern-lit memory piece in the Palace of Fine Arts
  rotunda and lagoon.
- **Grace Cathedral · Nob Hill** and **Fort Mason · Fisherman's Wharf Hostel** —
  authored landmark interiors, baked from Blender sources and streamed as their
  own regions.
- **Beach Pianist** — a grand piano on Marshall's Beach, framed dead-centre by
  the Golden Gate Bridge. `B` cues the song.
- **Fort Mason Jam** — an ensemble overlook you can play along with (`Space` or
  click to join in).
- **The wandering ghost ship** — a fairy-lit galleon that circles the skyline,
  carries twelve visitors on shared deck stations, and lands at the Presidio
  parade ground once a night. Its hot tub runs a close-range WebGPU fluid
  solver.

**Skyline** — Golden Gate, Bay Bridge, Transamerica, Salesforce Tower, Coit
Tower, the Ferry Building, Sutro Tower, the Palace of Fine Arts, Alcatraz —
plus floating balloon islands if you can reach them.

---

## Multiplayer

Everyone shares one world. No accounts, no login — connect and you're in.

- **Client-authoritative movement, dumb relay server.** Each browser runs its
  own Box3D physics world, so the server never simulates anything — it relays
  poses. This is the right trade for a co-op sandbox: there's nothing
  competitive to cheat at, and the server stays tiny (one process, in-memory,
  no database).
- **12 Hz snapshots + interpolation.** Clients send their pose ~12 times/sec
  (only while it changes; 0.5 Hz keepalive otherwise). The server batches
  everyone into one timestamped snapshot per tick. Remote players render
  **150 ms in the past**, interpolating between the two bracketing snapshots. If
  packets stop, avatars hold their last pose instead of extrapolating into walls.
- **Remote avatars are full embodiments** — walker, car, scooter, plane,
  sailboat, drone, hoverboard, surfboard, phoenix — with name tags, animation
  driven by reported speed, and *no* extra lights (a light-count change rebuilds
  every GPU pipeline in this renderer; emissive materials do the glowing).
- **Voice chat** is WebRTC peer-to-peer, signaled through the relay — the audio
  never touches the server. You hear the closest few players at full volume at
  any distance, and hearing is kept mutual so two friends always hear each
  other. It's the one system that keeps running while the tab is hidden.
- **Text chat** (`T`) and **emotes** (`J`) relay to everyone nearby.
- **Shared toys.** Paintballs, fireworks and thrown balls relay. **Golf** shares
  balls, swings and score (the striker's sim is authoritative). **Pickleball**
  reserves two sides and picks one match authority. The **ghost ship** carries
  passengers as a shared deterministic ride.
- **What stays local:** each client runs its own city (buildings, ground,
  props). Full world-state sync is a much bigger project.

Protocol details are documented at the top of `server/server.mjs` and
[`src/net/net.ts`](src/net/net.ts).

**Webcam mocap** (`src/mocap/`) is an experiment on the side: a LiteRT WebGPU
pose model reads your webcam and drives your avatar's body directly.

---

## How it's built

### Stack

- **Rendering** — three.js WebGPU + TSL. WGSL compute and storage buffers do the
  heavy lifting (grass generation, ocean spectrum, fluid, indirect draws).
  **WebGPU-only by policy**: no WebGL fallback, no compatibility branches, no
  duplicate shader paths. A new fallback renderer is treated as a regression.
- **Physics** — [box3d.js](https://github.com/isaac-mason/box3d.js), Isaac
  Mason's WASM bindings for [Box3D](https://github.com/erincatto/box3d) (Erin
  Catto's 3D rigid-body engine), through `src/core/box3dWorld.ts`.
- **Multiplayer** — a tiny WebSocket relay (`server/server.mjs`), `ws` its only
  runtime dependency.
- **Audio** — everything is synthesized at runtime. The score is composed live
  by a director that schedules chords, bass, melody and percussion 1.6 s ahead
  of the audio clock, and *where you're standing decides what plays*. See
  [`docs/MUSIC.md`](docs/MUSIC.md).

### How the world loads

- **`tools/prepare-city.mjs`** flood-fills the DEM from the map edges to classify
  bay water, shapes a bay floor, rasterizes parks/sand, extrudes OSM footprints
  to heights, fits a min-area oriented box collider per building, and buckets
  everything into 800 m streaming tiles.
- **`src/world/terrainClipmap.ts`** is the runtime terrain authority — a WebGPU
  clipmap built at boot from the canonical `heightmap.bin` + `surface.bin`, with
  streaming detail tiles from `public/data/terrain`. (Blender-exported terrain
  GLBs are legacy and no longer shipped; `test:terrain-runtime` enforces that.)
- **`src/world/tiles.ts`** streams GLB city tiles + JSON colliders in and out by
  player distance.
- **`src/core/physics.ts`** runs Box3D: a moving "carpet" of static ground boxes
  follows the player, and nearby buildings get static box bodies — so a crash is
  resolved entirely by the contact solver. It just stops you.
- **`src/world/authoredRegions.ts`** streams hand-authored sites (Sutro Baths,
  Fort Mason, Grace Cathedral) as their own GLB regions with terrain ownership.
- **`src/app/compose/optionalSites.ts`** is the lazy scheduler for destination
  sites: proximity gates, a serialized load queue, arrival re-prioritization,
  and distance unload.

### Directory map

| Path | Owns |
| --- | --- |
| `src/main.ts`, `src/app/` | Boot, the compose layers, arrival, the frame loop |
| `src/core/` | Input (kb/pad/scripted), Box3D physics, camera, persistence |
| `src/render/` | WebGPU pipeline, post FX, adaptive resolution, occlusion |
| `src/world/` | Terrain, tiles, ocean, sky/fog, citygen, traffic, the sites |
| `src/world/vegetation/`, `groundcover/`, `wildlands/` | The shared plant runtime |
| `src/player/`, `src/vehicles/` | Every embodiment, each a `ModeController` |
| `src/gameplay/` | Activities and quests (golf, pickleball, archery, afterlight…) |
| `src/audio/` | Engine, generative score, nature soundscape, foley |
| `src/net/` | Relay client, remote interpolation, WebRTC voice |
| `src/ui/` | HUD, minimap/map, toolbar, customizers, tutorial, reader |
| `src/cinematic/` | The deterministic film layer |
| `server/` | Relay + static host, Starlink feed, companion push |
| `tools/` | Asset pipeline, contract tests, browser probes, renderers |
| `rl/` | Headless creature RL trainer (trains against the same Box3D build) |

`src/main.ts` was ~5,900 lines and is being decomposed into `src/app/compose/`
modules — see [`docs/MAIN_DECOMPOSITION.md`](docs/MAIN_DECOMPOSITION.md) for the
plan and the rules the extraction follows.

---

## Working on it

### House rules

These are the invariants that keep the project coherent. They're the same rules
in [`AGENTS.md`](AGENTS.md), which is what automated contributors read.

1. **WebGPU only.** Never add a WebGL/WebGL2 fallback, compatibility branch, or
   duplicate shader implementation. Fail clearly when WebGPU is unavailable;
   never silently switch rendering APIs.
2. **Lazy by default.** Treat this as a massive open world. Boot loads only what
   the player's immediate starting space needs; every optional region, activity,
   vehicle, editor and cinematic lazy-loads behind an explicit first-use gate or
   proximity boundary. Constructing an object or opening a hidden panel must not
   fetch that feature's media. Being present under `public/` is not permission to
   preload. The full contract and acceptance checklist:
   [`docs/LAZY_LOADING.md`](docs/LAZY_LOADING.md).
3. **All plants go through the vegetation runtime.** Trees via
   `createAuthoredTreePatch`, shrubs via `createAuthoredShrubPatch`, flowers via
   `createAuthoredFlowerPatch`, grass via `src/world/groundcover/`. Never
   hand-roll primitive foliage (sphere canopies, cone pines, trunk+blob groups) —
   that's a quality *and* performance regression even for a small decorative
   grove. Regions own botanical intent only (positions, archetype, yaw, scale);
   the shared runtime owns compilation, instancing, wind, LOD and culling.
   Exhibit-site foliage streams through `SiteFoliageStreamer`.
4. **Music identity is data, not code.** To make a place sound different, edit
   `src/audio/music/regions.ts` — don't add a bespoke synth or a per-place
   special case in the director.

### Verifying changes

There is no unit-test suite. Verification is **contract tests** (pure Node
assertions over real data) and **probes** (a real headless Chrome driven over
CDP against the actual app). `npm run build` gates on the contract tests plus
`tsc --noEmit` before it will produce a bundle.

```bash
npm run test:lazy-sites        # site scheduler: priority lane, abort, unload
npm run test:terrain-runtime   # GPU clipmap + collision in the real app
npm run test:golf              # golf logic
npm run test:ghost-ship        # ship contract + relay
npm run test:voice:browser     # voice echo + mic persistence
npm run test:shadows:analysis  # shadow temporal + edge contracts
npm run assets:check           # are baked artifacts in sync with their sources?
```

`package.json` has ~70 of these; `npm run` lists them all. Browser probes look
for Chrome at the usual macOS paths — set `CHROME_BIN` otherwise, and
`SF_PROBE_URL` to reuse a running preview instead of starting one.

Run browser testing headlessly or in the background, and open a preview or
production build with `?autostart=1` so it skips the Start gate.

For QA of a lazy feature, inspect the real request waterfall in three phases —
clean boot, first activation, one subsequent choice — and assert zero feature
requests at boot, selected/nearby-only on activation, and exactly the newly
requested asset afterward.

### Docs

| Doc | Subject |
| --- | --- |
| [`docs/LAZY_LOADING.md`](docs/LAZY_LOADING.md) | The loading contract and its checklist |
| [`docs/MAIN_DECOMPOSITION.md`](docs/MAIN_DECOMPOSITION.md) | Breaking up `main.ts` |
| [`docs/TERRAIN.md`](docs/TERRAIN.md) | Runtime terrain authority |
| [`docs/SHADOWS.md`](docs/SHADOWS.md) | Three player-centric projection maps |
| [`docs/FOG_WEATHER.md`](docs/FOG_WEATHER.md) | Coherent, optionally real-weather fog |
| [`docs/MUSIC.md`](docs/MUSIC.md) | The generative score |
| [`docs/CINEMATICS.md`](docs/CINEMATICS.md) | The deterministic film pipeline |
| [`docs/BAKED-ASSETS.md`](docs/BAKED-ASSETS.md) | Keeping baked artifacts in sync |
| [`docs/NATIVE_FOLIAGE_TEXTURES.md`](docs/NATIVE_FOLIAGE_TEXTURES.md) | Procedural foliage textures |
| [`docs/PERF_LEVELUP.md`](docs/PERF_LEVELUP.md) | The performance program |
| [`docs/COMPANION_APP.md`](docs/COMPANION_APP.md) | The SwiftUI iPhone notifier |
| [`rl/README.md`](rl/README.md) | Training the puppy |

### Cinematic rendering

A deterministic WebGPU film pipeline renders shots using the real scene, actors,
physics and lighting — the cinematic code only stages those systems and owns the
camera.

```bash
npm run render:hoverboard:fast
npm run render:dog-park:fast
npm run render:cinematics        # both reference films + their transition
npm run deliver:x -- <video.mp4> # X-ready derivative of a finished film
```

See [`docs/CINEMATICS.md`](docs/CINEMATICS.md) for shot authoring, the fast
WebCodecs review backend, archival capture, camera preflight, audio and QA.

---

# Hosting & deployment

Everything below is for running your own server or rebuilding the world. You
don't need any of it just to play.

## Deploy anywhere

The whole app is **one Node process listening on `$PORT`** that serves the built
client *and* the WebSocket relay. That makes hosting simple.

### Any VPS / bare metal (simplest)

```bash
npm ci
npm run build          # dist/
PORT=8787 npm start    # = node server/server.mjs
```

Put TLS in front so the socket is `wss://` (browsers require it on https pages).
The server speaks plain HTTP/WS on one port, so any proxy works.

**Caddy** (automatic TLS, WebSockets proxied by default):

```
sf.example.com {
    reverse_proxy localhost:8787
}
```

**nginx** — WebSocket upgrade headers are the one thing people forget:

```nginx
server {
    server_name sf.example.com;
    listen 443 ssl http2;
    # ...ssl_certificate lines...
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;    # required for /ws
        proxy_set_header Connection "upgrade";     # required for /ws
        proxy_read_timeout 300s;                   # > the 15s heartbeat
    }
}
```

Keep it alive with systemd (`Restart=always`) or `pm2 start server/server.mjs`.

### Docker

```bash
docker build -t sf-city .
docker run -p 8787:8787 sf-city
```

### Fly.io / Railway / Render

All three work out of the box because the app is "one Node process on `$PORT`":

- **Fly.io**: `fly launch` (it detects the Dockerfile), set `internal_port = 8787`.
  WebSockets work with no extra config.
- **Railway / Render**: point at the repo, build command `npm ci && npm run build`,
  start command `npm start`. They inject `PORT` themselves.
- Use `/healthz` as the health-check path.

**Don't** deploy the game to a purely static host (GitHub Pages, plain S3) and
expect multiplayer — the relay needs a long-lived Node process. If you *want*
static hosting for the files, deploy the relay separately and build the client
with `VITE_WS_URL=wss://relay.example.com/ws npm run build` (the client
otherwise connects to `/ws` on its own origin).

### Railway (this project's host)

Pushing to GitHub does not deploy automatically. To deploy the latest pushed
commit, open the Railway project/service, press `Cmd+K`, and choose **Deploy
Latest Commit**. To deploy your local checkout instead: `railway up`.

### Server facts

| Thing | Value |
| --- | --- |
| Process | `node server/server.mjs` — serves `dist/` **and** the WebSocket at `/ws` |
| Runtime dep | `ws` (nothing else; no database; multiplayer state is in memory) |
| Env vars | `PORT` (default `8787`), `HOST` (default `0.0.0.0`), `MAX_PLAYERS` (default `40`) |
| Health check | `GET /healthz` → `{"ok":true,"players":N}` |
| Capacity | one room, everyone shares it; joiners past `MAX_PLAYERS` get a "server full" close |
| Hygiene | 15 s ping/pong heartbeat, 5 min idle kick, per-socket rate + 2 KB size caps, names sanitized server-side |
| Restart cost | zero persistence — clients auto-reconnect with backoff and rejoin |

A restart is invisible apart from a brief "connecting" period; positions live in
each client's `localStorage`, not on the server.

### Before you scale

- One process = one world. `MAX_PLAYERS` (40) is a politeness cap for render
  cost on low-end clients more than a server limit; the relay itself is
  I/O-bound and tiny (≈90 bytes/player/tick).
- Multiple regions/rooms = multiple instances behind different hostnames. There
  is deliberately no cross-instance state to migrate.
- Everything a client sends is validated (shape, finiteness, size, rate) and
  names are sanitized before broadcast; name rendering is canvas/textContent
  only, so there is no HTML-injection path.
- WebSocket origin is not checked — anyone who can reach the port can join, by
  design. For a private server, the easy lever is a shared token in the `hi`
  message.

## Asset pipeline

The world is built in stages. Coordinates use a local meter frame centered on SF
(`tools/geo.mjs`): +X east, +Z south, +Y up (matching three.js).

```bash
npm run fetch:terrain   # AWS terrarium DEM tiles -> data/raw/heightmap-raw.bin
npm run fetch:osm       # Overpass buildings/roads/water/parks -> data/raw/*.json
npm run prepare:city    # -> public/data/{heightmap,surface}.bin, colliders, manifest, meta
                        #    and data/city/city.json (payload for Blender)
npm run bake:terrain-tiles  # -> public/data/terrain/ (gitignored; the runtime terrain detail)
```

`public/data/terrain` is **derived, gitignored data** — every checkout bakes its
own. `npm run assets:check` tells you when any baked artifact has drifted from
its source, and `assets:heal` rebakes the safe ones (the build runs `--heal`
automatically). Tracked outputs baked from a `.blend` are reported, never
silently rewritten — see [`docs/BAKED-ASSETS.md`](docs/BAKED-ASSETS.md).

### City geometry (Blender)

With Blender open and the MCP add-on connected, run `tools/blender_city.py`:

```python
import sys; sys.path.insert(0, "<repo>/tools")
import blender_city as bc
bc.load_data()          # read data; apply/version the canonical coastal height process
bc.build_all_tiles()    # extruded buildings + roads + parks, per 800m tile
bc.build_water()        # flat WATER_bay marker plane (replaced by the shader at runtime)
bc.build_landmarks()    # baseline procedural landmark set
bc.export_all()         # -> public/tiles/*.glb
```

`sanfrancisco.blend` is the editable master after the baseline bake. The Palace
of Fine Arts and Sutro Tower are authored meshes in their geographic tile
collections, not runtime-generated replacements. To reapply that authored pass
to an open baseline scene and export only its affected tiles:

```python
import sys; sys.path.insert(0, "<repo>/tools")
import blender_landmark_upgrade as landmarks
landmarks.upgrade_scene(export_root="<repo>", save=True)
```

Then destructively remove the superseded Palace OSM records from the committed
CityGen/collider payloads with `npm run landmarks:apply`.

Do not run `bc.clear_city()` on the edited master unless you intentionally want
to return to the generated baseline; it removes all tile and landmark objects.
The original OSM scene can always be rebuilt from `data/raw`.

Finally, compress the exported tiles in place:

```bash
npm run optimize:tiles  # skips already-compressed files, so partial rebakes
                        # stay cheap; --force recompresses everything
```

### Why the compress step matters

Blender's glTF exporter writes **honest but fat** GLBs: positions, normals and
colors as raw 32-bit floats, one attribute per vertex, no entropy coding. That's
correct for an exporter — it has no idea how the data will be used. The runtime
never loads the whole set at once (`src/world/tiles.ts` streams by distance),
but every tile that *does* enter the ring still has to be fetched, decoded,
parsed and uploaded. Fat float32 buffers make those arrivals hitchy.

`tools/optimize-tiles.mjs` is a thin post-export pass on
[glTF-Transform](https://gltf-transform.dev/) that closes the gap without
touching Blender or the geometry's topology:

1. **Quantization** (`KHR_mesh_quantization`) — positions drop from float32 to
   16-bit, which over an 800 m tile is a ~1.2 cm grid: finer than anything you
   can see, and finer than the sub-centimeter lifts that keep draped roads and
   parks from z-fighting the terrain. Normals and colors shrink to 8-bit.
2. **Meshopt compression** (`EXT_meshopt_compression`) — the quantized buffers go
   through [meshoptimizer](https://meshoptimizer.org/gltf/)'s vertex/index codec,
   which reorders and delta-encodes them into a form that's both smaller on disk
   *and* far more gzip-friendly.

The runtime cost is one line — `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` in
`src/world/tiles.ts`. The decoder ships inside three.js, and uncompressed GLBs
still load through the same loader, so the transition can't break an
un-optimized file.

The pass is **idempotent**: it reads each GLB header, skips anything already
carrying `EXT_meshopt_compression`, and validates that every rewritten file
decodes back to the same vertex count before replacing the original. After a
partial rebake, just run it again.

Two things are deliberately left alone:

- **`_BID` stays exact float32.** Buildings carry a per-vertex building-id
  attribute so the facade shader can tint and light each building independently
  and the runtime can hide a single building via the alive texture without
  re-uploading geometry. Quantizing those ids would round neighbors into each
  other; only POSITION/NORMAL/COLOR are quantized.
- **`landmarks.glb` skips quantization** (meshopt only). The Salesforce Tower
  crown material reads its mesh's bounding box in world meters to place the LED
  display; quantization rescales geometry into the node transform and would move
  that box. Landmarks stay always-resident at runtime (~0.8 MB).

**The savings.** The committed corpus is **207 GLBs — 205 city tiles plus
landmarks and water — 28.3 MB on disk, 14.3 MB gzipped over the wire.**
Dequantizing and un-meshopting a tile inflates it about **6.7×** on disk
(a dense downtown tile: 0.20 MB → 1.32 MB), and because meshopt's output gzips
well while raw float buffers barely compress at all, the over-the-wire win is a
further **~2.7×** on top. That's the number that matters per fetch: streaming
the tiles around you pulls tens of megabytes instead of hundreds, arrivals stay
ahead of the camera, and `public/tiles` stays a reasonable size in git.
