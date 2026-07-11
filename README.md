# San Francisco

An open-world San Francisco you can **walk, drive, fly, sail, skate and soar**
through — with friends. It's rebuilt from real OpenStreetMap building/road data
and USGS elevation, and everything is a rigid body: cars, boats and bodies all
collide, and the buildings are solid — you bump and stop against them. The bay is
a custom water shader — calm, clear, Caribbean-green.

There's no goal and nothing to win. It's a city-sized sandbox with parks to
wander, sports to play, and a few small worlds tucked inside the big one. Show
up, pick a way to move, and go poke at things.

> **Just want to play?** Jump to [Getting started](#getting-started) to run it
> locally, then [How to play](#how-to-play) and [Things to try](#things-to-try).
> Everything after that is for people hosting or rebuilding the world.

---

## Getting started

```bash
npm install
npm run dev      # http://localhost:5179
```

`npm run dev` starts vite **and** the multiplayer relay (port 8787) in one
process; the dev server proxies `/ws` to it. Open the URL, type a name (or keep
the suggested one), and press Start. Open a second browser window to see
multiplayer working locally.

Sessions default to the **Corona Heights** summit — scenic, cheap to boot, and
a short walk from the dog park and the jammer trio. The world's assets are
already committed to the repo (`public/data` for the heightmap/colliders/metadata,
`public/tiles` for the GLB geometry), so there's nothing to build or download
first — `npm install` and `npm run dev` is the whole setup. You only need the
[asset pipeline](#asset-pipeline) if you want to change the map or regenerate
geometry.

---

## How to play

Pick how you move with the number keys, steer with `W A S D`, and left-click to
use whatever tool is active. That's the whole game.

### Modes

Press `Shift`+`1`–`7` to switch how you get around. Each one has its own feel:

| | Mode | Notes |
| --- | --- | --- |
| `Shift`+`1` | **Walk** | Run with `Shift`, jump with `Space`. Climb anything you can reach. |
| `Shift`+`2` | **Drive** | A sports car. `Space` drifts. |
| `Shift`+`3` | **Fly** | Free flight. Good for getting your bearings over the whole city. |
| `Shift`+`4` | **Boat** | A sailboat on the bay. Heaves and pitches with the swell. |
| `Shift`+`5` | **Drone** | Nimble hover; look straight down at the streets. |
| `Shift`+`6` | **Board** | A hoverboard. `Space` ollies. |
| `Shift`+`7` | **Bird** | A phoenix. `Space` flaps. Dive and soar. |

### Controls

| Key | Action |
| --- | --- |
| `W A S D` | Move / drive / steer (depends on the mode) |
| `Shift` | Run / boost |
| `Space` | Jump / drift / ollie / flap / pickleball swing (depends on the mode) |
| `E` | Mount/dismount a nearby ride, pick up a returned fetch ball, start golf from a glowing tee, or claim/leave a pickleball side |
| `Q` | Cycle the Corona Heights jammer trio to the next song |
| `1`–`9` | Teleport to the numbered player next to you (or pick a golf club while playing) |
| `M` | **Full-city map** — drag/scroll to pan/zoom, click a landmark or spot, press Teleport |
| Left click | Use the current tool; near your golf ball, hold to draw back and release to swing |
| `B` | Fireworks |
| `Z` (hold) | Scrub the time of day with the trackpad |
| `R` | Respawn |
| `P` | Pause |
| `C` | Orbit camera |
| `I` | Immersive (hide the UI chrome) |
| `Tab` | Fade the UI |
| `/` | Live tuning panel (draw distance, fog, foliage, render) |

### The tools

Left-click does something different depending on the tool selected in the
toolbar (cycle it with the arrow keys while the UI is up):

- **Ball** — hold to spot a tennis ball, keep holding to wind up, release to throw.
  At Corona Heights, free dogs chase, carry it back, and wait for you to take it
  with `E`. Two full fetches adopt a dog as a pet.
- **Paint** — sling paintballs. Hits stick to walls, vehicles, and players; friends
  see your shots.
- **Bubbles** — blow soap bubbles that drift on the breeze.

---

## Places worth visiting

Open the map (`M`) and teleport, or just wander. A few of the denser spots:

- **Corona Heights** — default spawn. Red-chert summit, downtown/Mission vista,
  a dog park just below, and a **jammer trio** (ukulele, handpan, flute) perched
  on a boulder. Stand nearby to hear them; press `Q` to cycle songs. Throw the
  ball tool for the dogs.
- **Botanical Garden** — San Francisco Botanical Garden in Golden Gate Park:
  SeedThree trees, blade grass, shrubs, and a shared wind envelope. The nature
  soundscape thickens here.
- **Goldman Tennis & Pickleball** — Golden Gate Park courts. Walk up to a
  pickleball athlete and press `E` to take a side (near/far). `WASD` moves,
  click/`Space` swings, `E` again leaves. Online play is slot-arbitrated so two
  friends can claim opposite sides.
- **Presidio Golf** — full 18 playable holes on the real course footprint.
  Teleport to **Presidio Golf · Hole 1**, or find any glowing tee and press `E`.
  Aim with the camera, clubs with `1`–`9`, hold/release click to swing; `G`
  twice abandons a round. Ball and score state are shared online.
- **Wildlands** — SeedThree groves across Golden Gate Park, the Presidio, Marin
  Headlands, Mount Sutro / Buena Vista, with player-following wildflower and
  grass rings.
- **Skyline landmarks** — Golden Gate, Bay Bridge, Transamerica, Salesforce
  Tower, Coit Tower, the Ferry Building, Sutro Tower, the Palace of Fine Arts,
  Alcatraz — plus floating balloon islands if you can reach them.

---

## Things to try

Nothing here is required — it's a list of things people tend to find fun.

- **Fly up first.** Switch to fly or bird (`Shift`+`3` / `Shift`+`7`) and get
  above the fog. The whole city is easiest to orient from the air.
- **Hang with the jammers.** Spawn is already on Corona Heights — walk to the
  boulder, listen, hit `Q` for another tune, then toss a ball for the dogs.
- **Walk the Botanical Garden.** Map → **Botanical Garden**. Grass tramples under
  you; trees stream in as you arrive.
- **Play pickleball.** Map → **Goldman Tennis & Pickleball**, press `E` on an
  open side. Bring a friend for a two-player rally.
- **Play Presidio Golf.** Map → **Presidio Golf · Hole 1**. Walk the holes, or
  share a round online — friends see your ball and score.
- **Carve the hills.** In the car, chase the grades and drift the intersections.
  Buildings have real colliders, so you bump and stop against them.
- **Hunt the critters.** Crabs scuttle along the waterfront. Catch them — the
  satchel bottom-right keeps score.
- **Sail the bay.** Take the boat (`Shift`+`4`) out past the promenade — the
  water heaves and the boat trims bow-up as it climbs the swell.
- **Chase the light.** Hold `Z` and drag to scrub the time of day. Sunset over
  the bridge, then night with tower beacons and Bay Bridge lights lit.
- **Bring a friend.** Send them your local URL (or the live link). The minimap
  shows everyone as colored dots; the nearest nine get numbered indicators —
  press that number to teleport. Dots on the minimap rim are out of range; press
  `M` to find them.

---

## Multiplayer

Everyone shares one world. No accounts, no login — connect and you're in.

### How it works

- **No accounts, no login.** On connect the server assigns an id and a color.
  The start screen suggests an auto-generated name ("Foggy Otter") as a grayed
  placeholder — type your own to persist it in `localStorage`, or press Start
  to use a fresh suggestion for this session.
- **Client-authoritative movement, dumb relay server.** Each browser runs its
  own Box3D physics world, so the server never simulates anything — it relays
  poses. This is the right trade for a co-op sandbox: there's nothing
  competitive to cheat at, and the server stays tiny (one process, in-memory,
  no database).
- **12 Hz snapshots + interpolation.** Clients send their pose ~12 times/sec
  (only while it changes; a 0.5 Hz keepalive otherwise). The server batches
  everyone into one timestamped snapshot per tick. Remote players render
  **150 ms in the past**, interpolating between the two bracketing snapshots —
  the standard technique for smooth motion over jittery networks. If packets
  stop, avatars hold their last pose instead of extrapolating into walls.
- **Remote avatars are full embodiments** — walker rig, sports car, plane,
  sailboat, drone, hoverboard (with rider), phoenix — with name tags, walk/ride
  animation driven by their reported speed, and *no* extra lights (light-count
  changes rebuild every GPU pipeline in this renderer; emissive materials do
  the glowing instead).
- **Shared toys.** Paintball shots and fireworks volleys relay so friends see
  them. **Golf** shares balls, swings, hole results, and score (striker's sim is
  authoritative; the relay caches state for late joins). **Pickleball** reserves
  two sides, picks one match authority, and relays inputs/state so two players
  can rally together.
- **What stays local:** each client still runs its own Box3D city (buildings,
  ground carpet, park props). Full world-state sync across instances is a much
  bigger project.

Protocol details live at the top of `server/server.mjs` and `src/net/net.ts`.

---

## What's under the hood

- **Physics:** [box3d.js](https://github.com/isaac-mason/box3d.js) — Isaac Mason's
  WebAssembly bindings for [Box3D](https://github.com/erincatto/box3d) (Erin
  Catto's 3D rigid-body engine). The app imports `box3d.js/inline` through
  `src/core/box3dWorld.ts`.
- **Rendering:** three.js (WebGPU). City geometry is authored procedurally in
  Blender, exported as GLB tiles, then quantized + meshopt-compressed (~8x
  smaller) for streaming.
- **Multiplayer:** a tiny WebSocket relay (`server/server.mjs`) — anyone can
  join, no accounts.

### How the pieces fit

- **`tools/prepare-city.mjs`** flood-fills the DEM from the map edges to classify bay water,
  shapes a gentle bay floor, rasterizes parks/sand, extrudes OSM footprints to heights
  (from tags or a size heuristic), fits a min-area oriented box collider per building, and
  buckets everything into 800 m streaming tiles.
- **`src/world/tiles.ts`** streams GLB tiles + JSON colliders in/out by player distance.
- **`src/core/physics.ts`** runs Box3D: a moving "carpet" of static ground boxes follows the
  player (sampling the heightmap + bridge decks), and nearby buildings get static box bodies,
  so a crash is resolved entirely by the contact solver — it just stops you.
- **`src/player/`** + **`src/vehicles/`** implement the seven embodiments (one
  `ModeController` per folder) on capped-speed arcade physics.
- **`src/world/water.ts`** is the bay shader: depth-based turquoise gradient from a bay-floor
  texture, gentle Gerstner-ish swell, fresnel sky reflection, sun sparkle, and shore foam.
- **`src/world/coronaHeights/`** + **`src/gameplay/buskers/`** — summit park, dog park,
  fetch loop, and the jammer trio.
- **`src/world/garden/`** — San Francisco Botanical Garden vegetation module.
- **`src/world/goldenGateTennis/`** + **`src/gameplay/pickleball/`** — Goldman courts and
  the shared pickleball game.
- **`src/gameplay/golf/`** — Presidio Golf Club, 18 holes with shared ball/score state.
- **`src/world/wildlands/`** — SeedThree foliage across GG Park / Presidio / Marin / Sutro.
- **`server/server.mjs`** + **`src/net/`** — multiplayer relay, remote-avatar interpolation,
  and the minimap/full-map UI (`src/ui/minimap.ts`).

---

# Hosting & deployment

Everything below is for running your own server or rebuilding the world. You
don't need any of it just to play.

## Deploying to Railway (this project's host)

Pushing to GitHub no longer deploys automatically. To kick off a production
deploy of the latest pushed commit, open the Railway project/service, press
`Cmd+K` (or `Ctrl+K`), and choose **Deploy Latest Commit**.

To deploy your local checkout instead of the latest GitHub commit:

```bash
railway up
```

## Deploy anywhere else

The whole app is **one Node process listening on `$PORT`** that serves the
built client *and* the WebSocket relay. That makes hosting simple.

### Any VPS / bare metal (simplest)

```bash
npm ci
npm run build          # dist/
PORT=8787 npm start    # = node server/server.mjs
```

Put TLS in front so the socket is `wss://` (browsers require it on https
pages). The server speaks plain HTTP/WS on one port, so any proxy works.

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

- **Fly.io**: `fly launch` (it detects the Dockerfile), set
  `internal_port = 8787`. WebSockets work with no extra config.
- **Railway / Render**: point at the repo, build command `npm ci && npm run build`,
  start command `npm start`. They inject `PORT` themselves — the server reads it.
- Use `/healthz` as the health-check path.

**Don't** deploy the game to a purely static host (GitHub Pages, plain S3) and
expect multiplayer — the relay needs a long-lived Node process. If you *want*
static hosting for the files, deploy the relay separately and build the client
with `VITE_WS_URL=wss://relay.example.com/ws npm run build` (the client
otherwise connects to `/ws` on its own origin).

### Server facts

| Thing | Value |
| --- | --- |
| Process | `node server/server.mjs` — serves `dist/` **and** the WebSocket at `/ws` |
| Runtime dep | `ws` (nothing else; no database; multiplayer state is in memory) |
| Env vars | `PORT` (default `8787`), `HOST` (default `0.0.0.0`), `MAX_PLAYERS` (default `40`) |
| Health check | `GET /healthz` → `{"ok":true,"players":N}` |
| Capacity | one room, everyone shares it; joiners past `MAX_PLAYERS` get a "server full" close |
| Hygiene | 15 s ping/pong heartbeat, 5 min idle kick, per-socket message rate + 2 KB size caps, names sanitized server-side |
| Restart cost | zero persistence — clients auto-reconnect with backoff and just rejoin |

A restart is invisible apart from a brief "connecting" period; positions live
in each client's `localStorage`, not on the server.

### Things worth knowing before you scale

- One process = one world. `MAX_PLAYERS` (default 40) is a politeness cap for
  render cost on low-end clients more than a server limit; the relay itself is
  I/O-bound and tiny (≈90 bytes/player/tick).
- Multiple regions/rooms = run multiple instances behind different hostnames.
  There is deliberately no cross-instance state to migrate.
- Everything a client sends is validated (shape, finiteness, size, rate) and
  names are sanitized before broadcast; name rendering is canvas/textContent
  only, so there is no HTML-injection path.
- WebSocket origin is not checked — anyone who can reach the port can join by
  design. If you ever want a private server, the easy lever is a shared token
  in the `hi` message.

## Asset pipeline

The world is built in four stages. Coordinates use a local meter frame centered
on SF (`tools/geo.mjs`): +X east, +Z south, +Y up (matching three.js).

```bash
npm run fetch:terrain   # AWS terrarium DEM tiles -> data/raw/heightmap-raw.bin
npm run fetch:osm       # Overpass buildings/roads/water/parks -> data/raw/*.json
npm run prepare:city    # -> public/data/{heightmap,surface}.bin, colliders, manifest, meta
                        #    and data/city/city.json (payload for Blender)
```

Then, with Blender open and the MCP add-on connected, run `tools/blender_city.py`:

```python
import sys; sys.path.insert(0, "<repo>/tools")
import blender_city as bc
bc.load_data()          # read city.json + heightmap
bc.build_all_tiles()    # extruded buildings + roads + parks, per 800m tile
bc.build_terrain()      # DEM mesh chunks with vertex-color surface classes
bc.build_water()        # flat WATER_bay marker plane (replaced by the shader at runtime)
bc.build_landmarks()    # Golden Gate + Bay Bridge, Transamerica, Salesforce Tower,
                        # Coit, Ferry Building, Sutro Tower, Palace of Fine Arts, Alcatraz
bc.export_all()         # -> public/tiles/*.glb
```

Then compress the exported tiles in place (quantization + meshopt, ~8x smaller):

```bash
npm run optimize:tiles  # skips already-compressed files, so partial rebakes
                        # stay cheap; --force recompresses everything
```

### Blender → three.js, and why the compress step matters

Blender's glTF exporter (`bpy.ops.export_scene.gltf` in
`tools/blender_city.py`) writes **honest but fat** GLBs: vertex positions,
normals and colors are stored as raw 32-bit floats, one attribute per vertex,
with no entropy coding. That's the correct thing for an exporter to do — it has
no idea how the data will be used — but for a streaming open world it's the
difference between a snappy load and a stall. A raw export of the whole city is
**~474 MB across 232 tiles**, and every one of those tiles gets fetched, parsed
and uploaded to the GPU while the player is standing in the fog waiting to move.

`tools/optimize-tiles.mjs` is a thin post-export pass built on
[glTF-Transform](https://gltf-transform.dev/) that closes that gap without
touching Blender or the geometry's topology. It does two things:

1. **Quantization** (`KHR_mesh_quantization`) — floats become smaller integers.
   Positions drop from float32 to 16-bit, which over an 800 m tile is a ~1.2 cm
   grid: far finer than anything you can see, and finer than the sub-centimeter
   lifts that keep draped roads and parks from z-fighting the terrain. Normals
   and colors shrink to 8-bit.
2. **Meshopt compression** (`EXT_meshopt_compression`) — the quantized buffers
   are run through [meshoptimizer](https://meshoptimizer.org/gltf/)'s vertex/index
   codec, which reorders and delta-encodes them into a form that's both smaller
   on disk *and* far more gzip-friendly.

The runtime cost is one line — `GLTFLoader.setMeshoptDecoder(MeshoptDecoder)` in
`src/world/tiles.ts` (and the bird loader). The decoder ships inside three.js, so
there's no new dependency, and uncompressed GLBs still load through the same
loader — the transition can't break an un-optimized file.

The pass is **idempotent**: it reads each GLB header, skips anything already
carrying `EXT_meshopt_compression`, and validates that every rewritten file
decodes back to the same vertex count before replacing the original. So after a
partial rebake you just run it again — it only pays for the handful of tiles
Blender actually re-exported. `--force` redoes everything.

Two things are deliberately left alone:

- **`_BID` stays exact float32.** Buildings carry a per-vertex building-id
  attribute so the facade shader can tint and light each building independently
  and the runtime can hide a single building (the citygen swap) via the alive
  texture without re-uploading geometry. Quantizing those ids would round
  neighbors into each other; only POSITION/NORMAL/COLOR are quantized.
- **`landmarks.glb` skips quantization entirely** (meshopt-only). The Salesforce
  Tower crown material reads its mesh's bounding box in world meters to place the
  LED display; quantization rescales geometry into the node transform and would
  move that box.

### The savings

Compression is roughly **8x on disk**. The over-the-wire win is larger and
compounds, because meshopt's output gzips a further 2–3x while raw float GLBs
barely compress at all — so end-to-end the player pulls **~17x less for the
whole city, and ~25x less for a dense downtown tile**:

| | Raw Blender export | After `optimize:tiles` (on disk) | Served gzipped (over the wire) |
| --- | --- | --- | --- |
| Whole city (232 tiles) | ~474 MB | ~61 MB | ~27 MB |
| `tile_4_14.glb` (dense downtown) | 16.6 MB | 1.65 MB | 0.59 MB |
| `terrain_0_0.glb` (DEM chunk) | 19.8 MB | 2.27 MB | 0.81 MB |

The right-hand column is the number the player feels. Streaming the tiles around
you pulls tens of megabytes instead of hundreds, so tiles pop in fast enough to
outrun the camera, mobile clients on cellular don't choke, and the committed
`public/tiles` directory stays a reasonable size in git. The disk win feeds GPU
upload too — smaller buffers parse and upload faster, so the hitch when a new
tile streams in shrinks along with the download.
