/**
 * "Behind the scenes" — a full-screen overlay that explains how the city is
 * built: the map-data pipeline, the Blender → three.js geometry path, the
 * WebGPU renderer, Box3D physics (compiled to WASM), and the multiplayer relay.
 * Lives in the top-right HUD stack under Tutorial, next to X/GitHub links.
 *
 * Self-contained: it owns its own DOM and Escape/backdrop close. main.ts only
 * hands it an `onToggle` so it can free the pointer lock while you're reading.
 */

import { SOUNDSCAPE_TAB_HTML, mountSoundscape } from "./btsSoundscape";
import { registerShareable, buildReadUrl, copyText, type ShareableModal } from "./deepLinks";

const X_URL = "https://x.com/EricLevin77";
const REPO_URL = "https://github.com/ericrius1/SanFrancisco";
const BOX3D_URL = "https://github.com/erincatto/box3d";
const BOX3D_WASM_DEMO = "https://box3d-wasm-test.vercel.app/";
const BOX3D_WASM_REPO = "https://github.com/ericrius1/box3d-wasm-test";

const X_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>`;
const GH_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.438 9.61 8.205 11.17.6.11.82-.26.82-.577 0-.285-.01-1.04-.015-2.04-3.338.72-4.042-1.61-4.042-1.61-.546-1.385-1.332-1.755-1.332-1.755-1.09-.744.083-.729.083-.729 1.205.084 1.84 1.236 1.84 1.236 1.07 1.83 2.807 1.302 3.492.996.108-.775.418-1.303.762-1.603-2.665-.303-5.466-1.324-5.466-5.896 0-1.303.47-2.37 1.235-3.203-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.4 3-.405 1.02.005 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.833 1.23 1.9 1.23 3.203 0 4.583-2.805 5.59-5.475 5.887.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.896 24 17.49 24 12.29 24 5.78 18.627.5 12 .5z"/></svg>`;

/** External link that never steals focus from the game canvas. */
function a(href: string, text: string): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;
}

const TAB_WORLD = `
  <section>
    <p class="bts-lede">An open-world San Francisco you can walk, drive, fly, sail, skate and soar
    through — with friends, in a browser tab. It's rebuilt from real OpenStreetMap building and road
    data and USGS elevation, given rigid-body physics so you can ram buildings over, shoot them and
    blow them up, and floated on a custom Caribbean-green bay. No installs, no accounts, no plugins:
    open a URL and you're standing on the Embarcadero. What follows is the whole magic trick, pulled
    apart — how the city gets built, how it's made to look and move, and how it becomes a place you
    can actually play in with other people. It's a lot of moving parts for a browser tab — a physics
    engine, a streaming renderer, a voice network, a dozen little worlds tucked inside the big one — and
    most of the fun, honestly, is in how they fit together.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🗺️</span> From map data to a city</h3>
    <p>None of this is hand-modelled block by block. A build step (<code>tools/prepare-city.mjs</code>)
    pulls real ${a("https://www.openstreetmap.org/", "OpenStreetMap")} footprints, roads and parks
    plus a USGS elevation model, then turns that pile of coordinates into a world. It
    <strong>flood-fills the sea</strong> inward from the map edges to decide what's bay and what's
    land, shapes a gentle floor beneath the water, and rasterizes parks and sand onto the terrain.</p>
    <p>Every building footprint is extruded to a height — from its OSM tags when they exist, from a
    size heuristic when they don't — and fitted with a tight <strong>minimum-area oriented box</strong>
    for physics. Concave footprints (an L-shaped block, a building wrapped around a courtyard) can't be
    one box without making the courtyard solid, so they're split into several boxes that share an id.
    Everything is then bucketed into <strong>800 m tiles</strong> so the city can stream. Throughout,
    positions live in a local metre frame centred on SF — +X east, +Z south, +Y up — matching three.js
    so nothing has to be converted at runtime.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🧊</span> Authoring in Blender, over a bridge</h3>
    <p>The geometry you actually see is authored <em>procedurally in Blender</em> — but not by hand in
    the Blender UI. A Python script (<code>tools/blender_city.py</code>) drives Blender over an MCP
    bridge, reading the prepared city data and building the world in code: extruded buildings, roads
    and parks draped onto the terrain, a DEM mesh for the hills, and a set of hand-detailed landmarks —
    the Golden Gate and Bay Bridge, Transamerica, Salesforce Tower, Coit Tower, the Ferry Building,
    Sutro Tower, the Palace of Fine Arts, Alcatraz. Blender then exports it all as GLB tiles.</p>
    <p>Doing it this way means the entire city is reproducible from data. Change the map extent or
    re-fetch OSM, re-run the script, and the world rebuilds — no thousands of manual edits to keep in
    sync. It's also how the fiddly problems get solved once and apply everywhere: the same pass that
    extrudes a footprint fits its physics box, splits an L-shaped or courtyard block into several boxes
    so the hole stays hollow, and severs the occasional building that a careless merge would otherwise
    weld onto the bridge — decisions that would be maddening to make by hand across an entire city.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🗜️</span> Shrinking a 474 MB city</h3>
    <p>Blender's glTF exporter writes <em>honest but fat</em> files: positions, normals and colours as
    raw 32-bit floats, no compression — the right call for an exporter that can't know how you'll use
    the data. But a raw export of the whole city is <strong>~474 MB across 232 tiles</strong>. Ship
    that and the player stands in the fog waiting while it downloads.</p>
    <p>A post-export pass built on ${a("https://gltf-transform.dev/", "glTF-Transform")} closes the gap
    without touching Blender or the geometry's topology. It does two things: <strong>quantization</strong>
    drops positions from float32 to 16-bit integers — a ~1.2 cm grid over an 800 m tile, far finer than
    anything you can see — and normals and colours to 8-bit; then ${a("https://meshoptimizer.org/gltf/", "meshoptimizer")}'s
    vertex/index codec reorders and delta-encodes the buffers into something both smaller on disk and
    far friendlier to gzip. The result is roughly <strong>8× smaller on disk and ~17× over the
    wire</strong> — a dense downtown tile drops from 16.6 MB to about 0.6 MB served.</p>
    <p>The runtime cost is one line — <code>GLTFLoader.setMeshoptDecoder(...)</code>, and the decoder
    ships inside three.js, so there's no new dependency. Two things are deliberately left uncompressed:
    the per-vertex <strong>building id</strong> stays exact float32 (quantizing it would round
    neighbouring buildings into each other and break single-building demolition), and
    <code>landmarks.glb</code> skips quantization because the Salesforce crown reads its mesh's bounding
    box in world metres to place its LED display.</p>
    <p>The pass is also <strong>idempotent</strong>, which matters more than it sounds: it reads each
    file's header, skips anything already compressed, and verifies the rewritten file still decodes to
    the exact same vertex count before it replaces the original. So after tweaking a single
    neighbourhood in Blender you just run it again — it only pays for the handful of tiles that actually
    changed, and it can't quietly corrupt a file on the way through.</p>
  </section>

  <section>
    <h3><span class="bts-ic">📥</span> Streaming without the stutter</h3>
    <p>The whole city can't live in memory at once, so tiles stream in and out around you by distance.
    The hard part isn't the streaming — it's doing it without a visible hitch <em>every single time</em>
    a tile arrives, because parsing geometry and uploading it to the GPU are exactly the kind of work
    that drops a frame.</p>
    <p>So the work is spread thin and kept off the main thread. The meshopt decode runs on a pool of
    <strong>worker threads</strong>; collider data is parsed on another worker and handed back as
    transferable typed arrays (moved, not copied); a freshly-loaded tile attaches its meshes
    <strong>one per frame</strong> rather than all at once; and facade materials are <strong>pooled and
    reused</strong>, because giving each tile its own material would make the renderer regenerate shader
    code per tile. Climb high above the city and a detail LOD quietly kicks in — the densest park lawns
    (a single one can be hundreds of thousands of vertices) and the trees drop out while you're too far
    up to notice, and stream back in as you descend.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌳</span> A city that grows</h3>
    <p>The greenery is three cooperating systems sharing one small library of hand-shaped low-poly
    trees — conifer and redwood, Monterey cypress, coast live oak, eucalyptus, palm. Their crowns
    aren't blobs: they're airy branch lattices under alpha-tested <strong>leaf cards</strong> drawn from
    a procedural texture atlas, so up close you see actual limbs carrying the foliage.</p>
    <p>A near-field densifier follows you around the Marin headlands, thickening the far forest only
    where you can actually make out trunks; every streamed park tile brings its own merged tree mesh
    that comes and goes with the tile; and a field of wind-blown grass tufts and wildflowers is rebuilt
    around the camera as you move — golden-green over Marin, lush where a park mask says lawn. It's all
    cosmetic (no physics), all deterministic so every player sees the same trees, and all pure
    mix-style shader math with no branches, which this renderer punishes hard.</p>
  </section>

  <section>
    <h3><span class="bts-ic">⛰️</span> Draping a city onto hills</h3>
    <p>San Francisco isn't flat, and neither is any of this. The terrain is a DEM mesh that
    <strong>adaptively refines</strong> — coarse where the ground is smooth, down to a fine grid where
    it bends — with T-junctions snapped so no cracks open between a coarse patch and a fine one. Roads
    and parks are then draped over that surface: densified so they follow the curve of a hill instead of
    cutting a flat ribbon through it, and lifted by a sub-centimetre hair so they don't z-fight the
    ground underneath. (The streets get their look the same careful way — warm-grey patchwork asphalt,
    oily wear, low wet patches that go glossy and mirror the sky, grit that only resolves near the
    camera — and no painted lane lines, because real SF streets curve.)</p>
    <p>The physics "carpet" of ground boxes does the same thing underneath you: where the land steps
    down a terrace it refines into finer slabs with a backstop below, which is why you can walk
    <em>down</em> Lombard's switchbacks instead of dropping through the seams.</p>
  </section>

`;

const TAB_LIFE = `
  <section>
    <h3><span class="bts-ic">🎨</span> Rendering on WebGPU</h3>
    <p>${a("https://threejs.org/", "three.js")} on <strong>WebGPU</strong>, with shaders written in
    TSL (three's node shading language) rather than raw WGSL strings — so the same node graph drives
    facades, water, foliage and particles. Sunlight casts <strong>cascaded shadow maps</strong> (three
    depth slices near-to-far) so a crisp shadow under your feet and a soft one across a distant hill can
    share one light. There are optional ink, dream and retro post-processing looks.</p>
    <p>The renderer is aggressively budgeted because whole tiles stream in behind you: device pixel
    ratio is capped, the scene runs a small <strong>fixed pool of lights</strong> (adding or removing a
    real light rebuilds every GPU pipeline in this renderer, so glowing things use emissive materials
    instead of new lamps), and expensive passes run at half resolution. The biggest win is the facades:
    a block of buildings has <em>no window geometry at all</em>. A shader packs the whole
    pattern — window grid, floor lines, a solid parapet band where the roof begins — and reads each
    building's height to lay it out, so an entire block is one draw call and windows never get sliced
    in half at a rooftop.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🪟</span> Making surfaces stop fighting</h3>
    <p>Look at a facade at a grazing angle and nothing shimmers — which is harder than it sounds when
    thousands of buildings share walls and windows are painted on. The renderer uses a
    <strong>reversed-z depth buffer</strong> (far more precise into the distance) and nudges each
    building's depth along the view ray by a hair keyed to its id, so two buildings meeting at a party
    wall don't flicker where their surfaces touch. The window pattern is effectively a tiny raymarch
    into the facade, which can throw sparkle at glancing angles, so a grazing-angle fade quietly dials
    it back exactly where it would misbehave. The payoff is a skyline that stays rock-steady as you
    barrel through it at phoenix speed.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌊</span> The bay &amp; moving water</h3>
    <p>The water is a hand-written shader, not a scrolling texture. Its colour comes from
    <strong>true depth</strong> read from a bay-floor height map — a sandy glow in the shallows, through
    turquoise, to deep teal offshore. A stack of <strong>Gerstner-style waves</strong> lifts and rolls
    the surface, a fresnel term folds in reflection so it always mirrors the actual sky (baked from the
    same sky the sun lives in), and sun sparkle and shore foam finish it. For speed it's split in two: a
    cheap material for the open bay to the horizon, a physically-based one only on a patch that bobs
    around you.</p>
    <p>Boards and boats leave a real <strong>wake</strong>: a ribbon built from shared-vertex triangle
    strips — neighbouring segments share a vertex pair so tight turns stay watertight, where chained
    quads would wedge open a gap — trailing behind the hull and fading as it spreads. And because the
    hoverboard's ride is a spring reading that same wave field, it genuinely rises and banks with the
    swell instead of floating on a flat plane.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌆</span> Real San Francisco light</h3>
    <p>By default the sky runs on <strong>real San-Francisco time and date</strong> — whatever hour and
    season it actually is in SF right now is the light you see, wherever in the world you're playing
    from. The sun follows its true astronomical path for the city's latitude, so a July noon sits high
    and bright while a December afternoon stays low and long. Hold <strong>Z</strong> and drag the
    trackpad to scrub to any hour you like (just for you), or flip on the fast day/night cycle in the
    tuning panel.</p>
    <p>As the light dims, the landmark <strong>light installations</strong> come up, all driven by that
    one sky-brightness value so they fade in together: the Bay Bridge's shimmering Bay Lights (a field
    of instanced sprite LEDs), Sutro Tower's red aviation beacons blinking up its masts, the Salesforce
    Tower crown display, and an uplight wash across the Palace of Fine Arts. They're instanced sprites,
    so thousands of individual points of light cost almost nothing.</p>
  </section>

  <section>
    <h3><span class="bts-ic">💥</span> Physics — Box3D, in your browser</h3>
    <p>Collisions, destruction and every vehicle run on <strong>Box3D</strong>, Erin Catto's rigid-body
    engine, compiled to WebAssembly. Each browser runs its <em>own</em> physics world. Simulating a
    whole city of bodies would be hopeless, so it's an illusion tuned around you: a moving
    <strong>"carpet"</strong> of static ground boxes follows you (sampled live from the heightmap and
    bridge decks), and nearby buildings materialize static box bodies as you approach and release them
    as you leave.</p>
    <p>Destruction stays cheap thanks to one trick baked into the geometry: every building vertex
    carries its building id, so when a wall takes a hard enough hit the runtime can collapse just
    <em>that</em> building's triangles into dynamic debris without re-uploading the tile. Fracture is
    energy-gated — a gentle bump won't shatter anything, a speeding bus will — and explosions are Box3D
    radial impulses. The rope and grab tools are Box3D joints too: rope ties any two bodies together
    (tie a crate to a bus, you know you want to), and grab is a tractor beam that carries and flings.</p>
    <p class="bts-links-inline">
      ${a(BOX3D_URL, "Box3D (Erin Catto)")}
      ${a(BOX3D_WASM_DEMO, "Box3D → WASM live demo")}
      ${a(BOX3D_WASM_REPO, "Box3D WASM port repo")}
    </p>
  </section>

  <section>
    <h3><span class="bts-ic">🛹</span> Seven ways to move</h3>
    <p>Walk, sports car, plane, sailboat, camera drone, hoverboard, phoenix — each is its own controller,
    all on <strong>capped-speed arcade physics</strong> tuned to feel good rather than to be accurate.
    A pattern runs through all of them: attitude is <em>code-owned</em> (the nose pitches into a climb,
    the body banks into a turn) while the physics solver owns translation, so you still bump off walls
    and land on roofs instead of clipping through them.</p>
    <p>The details are where each one comes alive. The hoverboard's hover spring targets whichever
    surface is higher — terrain or water — so you can carve down Lombard and keep going <em>straight out
    across the bay</em> without missing a beat. The sailboat rides a heave spring with a touch of bow-up
    trim so it noses over swells. The plane wears a photovoltaic wing skin that catches a slow
    iridescent sheen and glows faintly at dusk. The camera drone is the pure free-flight rig the
    phoenix borrows its controls from — mouse aims, W flies straight along that aim, four rotors spin in
    the shader with green-front / red-rear nav lights on the tips. And the same "become a vehicle"
    plumbing is what lets you press E to ride along in a friend's car, hop on a bear up in the hills,
    or take the wheel of a boat drifting in the bay.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🚪</span> Every door opens</h3>
    <p>One quiet decision colours the whole game: <strong>every building is enterable</strong>. The city
    isn't a set of facades — walk up to any house or shop, in through the front door, and you're in a
    real interior: rooms to wander, a staircase to the floors above, furniture and pictures on the walls.
    The buildings generate procedurally by neighbourhood, and their insides are built the instant you
    step in and thrown away when you leave, so the whole city can be hollow-and-explorable without a
    hundred thousand rooms ever existing at once.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🔥</span> The phoenix</h3>
    <p>The bird deserves its own note. It's a loaded model whose baked flight animation is
    <em>never played</em> — the controller poses the skeleton by hand every frame from the current
    flight state. Each animated bone is wrapped so the code can think in bird terms ("raise the wing"
    becomes a rotation about the body axis) no matter how the rig's rest pose is twisted underneath.</p>
    <p>The wingbeat is a <strong>travelling wave</strong> down the wing chain: each joint lags the one
    before it and the amplitude is tip-heavy, so the wingtip cracks like a whip instead of flapping like
    a board. Hold Shift and it tucks into a stoop that triples the speed cap. The plumage is fans of
    instanced feather quads parented straight onto the bones, so they ride the procedural pose for
    free — the entire bird is about <strong>11 draw calls</strong> — with the wind flutter a travelling
    wave in the vertex shader, pinned at each feather's quill. Behind it trails a camera-facing light
    ribbon that widens and rises like an ember sheet, cooling from molten gold at the tail through rose
    to a violet afterglow.</p>
  </section>

  <section>
    <h3><span class="bts-ic">⚡</span> Keeping the frame rate up</h3>
    <p>All of this has to stay smooth on an ordinary laptop, so the whole engine is built around a
    budget. Device pixel ratio is capped, the pre-pass runs at half resolution, and the light count is
    kept small and fixed — every extra light taxes every pixel, and in this renderer <em>changing</em>
    the count rebuilds every shader pipeline (a multi-second freeze), which is the real reason glowing
    things are emissive materials and never new lamps. Physics runs a small fixed number of substeps,
    the ground carpet refines a little each frame instead of all at once, and the water is split
    cheap-far / rich-near.</p>
    <p>The traps hide in the details: an anti-aliasing pass silently inherited the renderer's MSAA
    sample count and quietly quadrupled its own cost until it was pinned down; a lighting probe was
    re-baking every frame; a stray branch in a shader once blanked out every distant window light,
    because on this renderer a conditional inside a noise function corrupts the pixels it skips. Hunting
    those down is most of what "make it fast" actually means — and the target is a steady 120 frames a
    second where the hardware allows.</p>
  </section>

`;

const TAB_PLAY = `
  <section>
    <h3><span class="bts-ic">🖌️</span> Paint that sticks</h3>
    <p>The spray can and the paintballs share one <strong>procedural splat shader</strong>. There's no
    texture: for each blob, noise pushes the rim in and out so no two splats share a silhouette, a
    speckle ring adds overspray, and noise along one axis picks which columns drip and how far. A
    per-instance vec4 carries colour plus a random seed, so thousands of unique splats are a single
    instanced draw. Each one sits a couple of centimetres off the surface so the depth buffer keeps it
    from z-fighting the wall.</p>
    <p><strong>Paintballs</strong> actually fly: they're kinematic blobs (no physics body), integrated
    ballistically and swept each step with a raycast against buildings and terrain — plus the moving
    players and vehicles you're aiming at. A wall hit spawns a graffiti burst; a hit on a vehicle or player
    sticks a splat <em>to their mesh</em> via a paint-skin layer that rides the moving object (capped,
    oldest overwritten). Over the network a shot is just origin + velocity + colour, so every client
    re-simulates it and the paint lands exactly where <em>that</em> client sees the wall.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🔊</span> Spatial &amp; procedural sound</h3>
    <p>Proximity voice chat is <strong>WebRTC peer-to-peer</strong> — the audio never touches the
    server, which only forwards the tiny signaling handshake through the same presence relay. The
    classic "who calls whom" race is dodged by a rule: the lower player id always makes the offer. Each
    remote voice runs through a Web Audio <strong>PannerNode with an HRTF model and a linear distance
    falloff</strong> — full volume out to a wide radius, then a long fade to silence — with the listener
    glued to your camera and each panner glued to that player's interpolated avatar, at head height.
    Peers connect from farther away than you can hear, because ICE takes a second or two and the link
    should be live <em>before</em> someone walks into earshot. Turn your mic off and the track actually
    stops, so the browser's mic indicator goes dark — it's off, not just muted.</p>
    <p>Every engine, hum and rush is <strong>synthesised, not sampled</strong>. Each mode has a small
    synth voice — an oscillator stack and/or filtered noise — that idles near-silent and swells and
    pitches up with speed, all on one AudioContext with the voices crossfaded on a mode switch so
    nothing clicks. The hoverboard is the showpiece: root, fifth and octave with a barely-sharp partial
    for a slow shimmering beat, breathing through a slow filter sweep. Even the wind chimes are tuned —
    a C-major pentatonic across three octaves, pitched by where you struck, so tapping your way up the
    skyline plays it like a xylophone.</p>
    <p class="bts-aside">The parks and wild places have a soundscape all their own — a whole procedural
    ecology of birds, wind and weather. It has its own chapter: <a data-bts-tab="sound" href="#">The
    soundscape →</a></p>
  </section>

  <section>
    <h3><span class="bts-ic">🎪</span> A world full of toys</h3>
    <p>The city is stitched with little systems that reward wandering. Golden treasure chests conjure
    themselves on open ground under a light beacon you can spot a block away; walk up and one pops open
    on its own, spraying a fountain of coins and gems that magnet onto you and count into your satchel
    (a lucky few throw a fireworks salvo on top). Crabs skitter along the waterline as one instanced
    mesh with its wiggle done in the vertex shader, so the CPU only steers; catch one and it poofs a
    sparkle ring and respawns somewhere fresh.
    Blow soap bubbles and they drift off on a breeze with real thin-film iridescence — the colours are
    the viewing angle, not a texture — and burst against a wall, the water, or just old age.</p>
    <p>The wildlife is rideable: up in the Marin redwoods, walk up to a bear or raccoon and mount it with
    the same "become a vehicle" plumbing your own car uses, and boats drift out in the bay waiting for you
    to take the wheel. Gulls wheel over the
    landmarks in one draw call, and something big and green circles Alcatraz, surfacing every so often.
    And the fireworks are <strong>entirely GPU-driven</strong>: the whole particle population lives in
    storage buffers integrated by one compute pass, and the CPU only decides when and where — so a burst
    of 10,000 sparks costs it about 20 floats.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🧑‍🎤</span> Who you are</h3>
    <p>You become somebody the instant you connect: the server hands you an id and a colour, and the
    start screen offers a friendly auto-generated name — a "Foggy Otter", say — as a grey placeholder.
    Type over it to keep your own (saved in your browser for next time), or just press Start and run
    with the suggestion. That colour follows you everywhere — your dot on the minimap, the ring on your
    indicator, the tag floating over your head — and a compact avatar editor in the HUD lets you tweak
    your look, emitting whole trait descriptions so the renderer and the save layer stay the only things
    that actually change anything. Name tags are drawn as plain text on a canvas, never as HTML, so
    there's no way to sneak markup onto someone else's screen.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🔗</span> Bring a friend</h3>
    <p>Standing somewhere worth showing off? The <strong>Share spot</strong> button copies an invite
    link that encodes your exact position, which way you're facing, your current mode and ride — even
    the paint you're wearing. A friend opens it and the game drops them <em>right there</em>, in the
    same kind of vehicle, then quietly strips the long query string back out of the address bar so it
    stays tidy. No lobby, no room code: the link <em>is</em> the coordinates.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🧭</span> Finding your way</h3>
    <p>A whole city needs a map, so there are two. A minimap in the corner is always on — painted once
    as flat 2D canvas from the same heightmap and land-class grids the game already ships (water shaded
    by depth, land by type, a cheap hillshade), with every other player drawn as a coloured dot in their
    own hue. The nearest handful get numbered indicators out in the main view; press that number and you
    teleport straight to them. Anyone out of range is clamped to the minimap's rim, so you always know
    which way to head.</p>
    <p>Press M for the <strong>full-city map</strong>: drag and scroll to pan and zoom, click any
    destination, hit Teleport, and you're there. It even adopts the target's altitude and mode — drop
    onto a friend who's mid-flight and you arrive in the air beside them, instead of falling out of the
    sky.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🎓</span> Learning by doing</h3>
    <p>Newcomers get an interactive tutorial that <strong>watches real play</strong> instead of
    narrating over it. It's a chaptered checklist — first steps, stepping inside a building, the vehicle
    roster, the map and teleport — and each step completes only when you actually do the thing: it
    measures how far you've walked, how high you've flown, which mode you're in. The game hands it a thin
    stream of read-only signals and one-shot events, and the tutorial never reaches in to fake progress —
    so finishing it means you can genuinely play, not that you clicked "next" five times.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌐</span> Multiplayer</h3>
    <p>A tiny WebSocket relay ties it together — one Node process, no database, no accounts
    (<code>server/server.mjs</code>). Movement is <strong>client-authoritative</strong>: the server
    never simulates anything, it just relays poses. This is the right trade for a co-op sandbox — there's
    nothing competitive to cheat at, so the server stays tiny. Clients send their pose ~12 times a
    second; the server batches everyone into one timestamped snapshot per tick, and remote players
    render <strong>150 ms in the past</strong>, interpolating between the two bracketing snapshots for
    smooth motion over jittery networks. If packets stop, avatars hold their last pose instead of
    skating into walls.</p>
    <p>Remote players show up as full embodiments — walker, sports car, plane, sailboat, drone,
    hoverboard with rider, phoenix — with name tags and walk/ride animation driven by their reported
    speed. What <em>isn't</em> synced is just as deliberate: building destruction, fireworks and
    paint all stay local, because everyone runs their own copy of the city. That's exactly why you can
    knock a block flat without ruining anyone else's skyline. The relay itself is almost aggressively
    boring by design: no database, everything in memory, a 15-second heartbeat to drop dead sockets,
    per-message size and rate caps, and clients that reconnect on their own with backoff. Restarting it
    is invisible — your position lives in your browser, not on the server — so there's nothing to migrate
    and nothing to lose.</p>
  </section>

  <section class="bts-colophon">
    <h3><span class="bts-ic">🔗</span> Source &amp; credits</h3>
    <p>Built in the open, and it all runs in the tab you're reading this in — no server doing the heavy
    lifting, no native app, no download. Every system here started as a small idea that turned out to be
    more fun than expected, then got built until it earned its place. If any of it was fun to read
    about, the whole thing is right here to poke at, break and rebuild — clone the repo, open two browser
    windows, and you've got local multiplayer running in about a minute.</p>
    <div class="bts-chips">
      ${a(REPO_URL, "This project on GitHub")}
      ${a(BOX3D_URL, "Box3D")}
      ${a(BOX3D_WASM_DEMO, "Box3D WASM demo")}
      ${a("https://threejs.org/", "three.js")}
      ${a("https://gltf-transform.dev/", "glTF-Transform")}
      ${a("https://meshoptimizer.org/", "meshoptimizer")}
      ${a("https://www.openstreetmap.org/", "OpenStreetMap")}
      ${a(X_URL, "@EricLevin77")}
    </div>
  </section>
`;

type Tab = { id: string; label: string; icon: string; html: string };

// Horizontal tabs across the top of the panel — the reading is long, so it's
// split into chapters you can click between instead of one endless scroll.
const TABS: Tab[] = [
  { id: "world", label: "Building the world", icon: "🏗️", html: TAB_WORLD },
  { id: "life", label: "Bringing it to life", icon: "🌆", html: TAB_LIFE },
  { id: "play", label: "Playing in it", icon: "🎮", html: TAB_PLAY },
  { id: "sound", label: "The soundscape", icon: "🐦", html: SOUNDSCAPE_TAB_HTML }
];

export class BehindTheScenes implements ShareableModal {
  /** Deep-link key: `?read=bts` opens this panel, `?read=bts.sound` a tab. */
  readonly id = "bts";
  #overlay: HTMLDivElement;
  #body!: HTMLDivElement;
  #open = false;
  #activeTab = "world";
  #soundscape: { activate(): void; deactivate(): void } | null = null;
  #onToggle?: (open: boolean) => void;
  #shareBtn!: HTMLButtonElement;
  #shareResetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(onToggle?: (open: boolean) => void) {
    this.#onToggle = onToggle;
    const hud = document.getElementById("hud")!;

    // top-right stack: the wide button, then a row of X / GitHub icon links
    const ui = document.createElement("div");
    ui.className = "links-ui";

    const btn = document.createElement("button");
    btn.className = "share-btn";
    btn.type = "button";
    btn.title = "How this city is built — the Blender pipeline, physics and multiplayer";
    btn.innerHTML = `<span class="ic">🎬</span><span>Behind the scenes</span>`;
    btn.addEventListener("click", () => this.setOpen(true));

    const social = document.createElement("div");
    social.className = "social-row";
    social.appendChild(this.#iconLink(X_URL, "Follow on X / Twitter", X_ICON));
    social.appendChild(this.#iconLink(REPO_URL, "Source on GitHub", GH_ICON));

    ui.append(btn, social);
    hud.appendChild(ui);

    // the reading overlay — a tabbed, scrollable modal over a dimming backdrop
    const tabsHtml = TABS.map(
      (t) =>
        `<button class="bts-tab" type="button" role="tab" data-tab="${t.id}">` +
        `<span class="bts-tab-ic">${t.icon}</span><span>${t.label}</span></button>`
    ).join("");
    const panesHtml = TABS.map((t) => `<div class="bts-pane" data-pane="${t.id}">${t.html}</div>`).join("");

    this.#overlay = document.createElement("div");
    this.#overlay.className = "bts-overlay";
    this.#overlay.innerHTML =
      `<div class="bts-modal" role="dialog" aria-modal="true" aria-label="Behind the scenes">` +
      `<button class="bts-close" type="button" title="Close">✕</button>` +
      `<div class="bts-head">` +
      `<div class="bts-title">Behind the scenes</div>` +
      `<div class="bts-subtitle">How this browser-native San Francisco is built</div>` +
      `<div class="bts-socials">` +
      `<button class="bts-share" type="button" title="Copy a link straight to this chapter">` +
      `<span class="ic">🔗</span><span class="bts-share-label">Share this chapter</span></button>` +
      `<a class="social-btn" href="${X_URL}" target="_blank" rel="noopener noreferrer" title="X / Twitter">${X_ICON}</a>` +
      `<a class="social-btn" href="${REPO_URL}" target="_blank" rel="noopener noreferrer" title="GitHub repo">${GH_ICON}</a>` +
      `</div></div>` +
      `<div class="bts-tabs" role="tablist">${tabsHtml}</div>` +
      `<div class="bts-body">${panesHtml}</div>` +
      `</div>`;

    this.#body = this.#overlay.querySelector(".bts-body")!;

    // tab bar: switch chapters
    for (const tab of this.#overlay.querySelectorAll<HTMLButtonElement>(".bts-tab")) {
      tab.addEventListener("click", () => this.#selectTab(tab.dataset.tab!));
    }
    // in-content cross-links ("The soundscape →") jump to a tab
    for (const link of this.#overlay.querySelectorAll<HTMLAnchorElement>("[data-bts-tab]")) {
      link.addEventListener("click", (e) => {
        e.preventDefault();
        this.#selectTab(link.dataset.btsTab!);
      });
    }

    // the soundscape chapter animates its diagrams from scroll + a gentle rAF
    const soundPane = this.#overlay.querySelector<HTMLElement>('[data-pane="sound"]');
    if (soundPane) this.#soundscape = mountSoundscape(soundPane, this.#body);

    // backdrop click (but not clicks inside the modal) closes it
    this.#overlay.addEventListener("click", (e) => {
      if (e.target === this.#overlay) this.setOpen(false);
    });
    this.#overlay.querySelector(".bts-close")!.addEventListener("click", () => this.setOpen(false));
    document.addEventListener("keydown", (e) => {
      if (this.#open && e.key === "Escape") {
        e.stopPropagation();
        this.setOpen(false);
      }
    });

    // "Share this chapter" — copies a deep link to the tab currently on screen
    this.#shareBtn = this.#overlay.querySelector(".bts-share")!;
    this.#shareBtn.addEventListener("click", () => {
      void copyText(buildReadUrl(this.id, this.#activeTab)).then((ok) =>
        this.#flashShare(ok ? "Link copied!" : "Copy failed")
      );
    });

    hud.appendChild(this.#overlay);
    this.#selectTab(this.#activeTab);
    // let a `?read=bts[.tab]` link open this panel straight from a shared URL
    registerShareable(this);
  }

  #flashShare(text: string) {
    const label = this.#shareBtn.querySelector(".bts-share-label");
    if (!label) return;
    label.textContent = text;
    clearTimeout(this.#shareResetTimer);
    this.#shareResetTimer = setTimeout(() => (label.textContent = "Share this chapter"), 1800);
  }

  /** ShareableModal: open the panel, optionally on a specific tab. */
  open(sub?: string) {
    if (sub && TABS.some((t) => t.id === sub)) this.#selectTab(sub);
    this.setOpen(true);
  }

  /** ShareableModal: the tab on screen, so a link points back at it. */
  shareSub(): string | undefined {
    return this.#activeTab;
  }

  #selectTab(id: string) {
    this.#activeTab = id;
    for (const tab of this.#overlay.querySelectorAll<HTMLButtonElement>(".bts-tab")) {
      tab.classList.toggle("active", tab.dataset.tab === id);
    }
    for (const pane of this.#overlay.querySelectorAll<HTMLElement>(".bts-pane")) {
      pane.classList.toggle("active", pane.dataset.pane === id);
    }
    this.#body.scrollTop = 0;
    // only the soundscape tab runs an animation loop, and only while it's shown
    if (id === "sound" && this.#open) this.#soundscape?.activate();
    else this.#soundscape?.deactivate();
  }

  #iconLink(href: string, title: string, svg: string): HTMLAnchorElement {
    const el = document.createElement("a");
    el.className = "social-btn";
    el.href = href;
    el.target = "_blank";
    el.rel = "noopener noreferrer";
    el.title = title;
    el.innerHTML = svg;
    return el;
  }

  setOpen(open: boolean) {
    if (open === this.#open) return;
    this.#open = open;
    this.#overlay.classList.toggle("open", open);
    if (open) {
      this.#body.scrollTop = 0;
      // (re)start the diagram loop if we opened onto the soundscape chapter
      if (this.#activeTab === "sound") this.#soundscape?.activate();
    } else {
      this.#soundscape?.deactivate();
    }
    this.#onToggle?.(open);
  }
}
