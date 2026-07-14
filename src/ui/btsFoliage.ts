/**
 * "The living layer" tab of the Behind-the-scenes panel: a long read about how
 * the trees, grass and wildflowers are grown, drawn and kept cheap across a
 * city-sized map — threaded with animated SVG diagrams and a handful of toys you
 * can actually poke.
 *
 * Same shape as btsSoundscape.ts: this module owns the tab's inner HTML plus a
 * controller (`mountFoliage`) that runs one gentle rAF while the tab is open,
 * driving a scroll-linked "how a forest stays cheap" diagram and five little
 * interactive explainers (the LOD dial, the clump field, the following ring, the
 * one-wind meadow, and the streaming-budget bars). Nothing here touches the real
 * renderer — the diagrams are hand-drawn SVG that mirror, in miniature, what the
 * vegetation runtime (src/world/nativeTreeForest, wildlands, groundcover) does.
 */

/* ------------------------------------------------------------- tiny helpers */

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Sample a per-stage value array at a continuous position f (0..len-1). */
function atStage(vals: number[], f: number): number {
  const i = clamp(Math.floor(f), 0, vals.length - 1);
  const j = clamp(i + 1, 0, vals.length - 1);
  return lerp(vals[i], vals[j], clamp(f - i));
}

/* --- deterministic placement math, ported verbatim from world/groundcover/scatter.ts,
   so the clump toy clusters flowers with the exact algorithm the game plants them with. */

/** 32-bit integer hash → [0,1). */
function hash2(ix: number, iz: number, salt: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iz, 668265263) + Math.imul(salt, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h = Math.imul(h ^ (h >>> 13), 3266489917);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
/** Smooth 2D value noise in [0,1] on a `cell`-metre lattice. */
function valueNoise(x: number, z: number, cell: number, salt: number): number {
  const fx = x / cell, fz = z / cell;
  const ix = Math.floor(fx), iz = Math.floor(fz);
  const ax = fx - ix, az = fz - iz;
  const sx = ax * ax * (3 - 2 * ax), sz = az * az * (3 - 2 * az);
  const n00 = hash2(ix, iz, salt), n10 = hash2(ix + 1, iz, salt);
  const n01 = hash2(ix, iz + 1, salt), n11 = hash2(ix + 1, iz + 1, salt);
  return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
}
/** Clamped Hermite smoothstep. */
function smoothstep(a: number, b: number, t: number): number {
  const u = Math.min(1, Math.max(0, (t - a) / (b - a)));
  return u * u * (3 - 2 * u);
}
/** Nearest Voronoi/worley clump centre to (x,z): distance + that centre's seed. */
function worleyClump(x: number, z: number, cell: number, salt: number): { d: number; seed: number } {
  const gx = Math.floor(x / cell);
  const gz = Math.floor(z / cell);
  let best = Infinity;
  let seed = 0;
  for (let jz = -1; jz <= 1; jz++) {
    for (let jx = -1; jx <= 1; jx++) {
      const cxi = gx + jx, czi = gz + jz;
      const px = (cxi + hash2(cxi, czi, salt)) * cell;
      const pz = (czi + hash2(cxi, czi, salt + 101)) * cell;
      const dx = px - x, dz = pz - z;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) {
        best = d2;
        seed = hash2(cxi, czi, salt + 202);
      }
    }
  }
  return { d: Math.sqrt(best), seed };
}

/* -------------------------------------------------------------- toy contract */

/** A self-contained interactive diagram: its own HTML, and a mount() that wires
 *  its listeners once and returns a per-frame update called by the tab's rAF. */
type FoliageToy = { html: string; mount: (pane: HTMLElement) => (t: number) => void };

/* ============================================================ interactive toys
   Each factory below is self-contained (scopes its own DOM by data-ftoy) and was
   built to the shared contract. They are assembled into FOLIAGE_TAB_HTML and
   driven by the one rAF in mountFoliage. */

// __TOY_LOD_DIAL__
function createLodDial(): FoliageToy {
  return { html: '', mount: () => () => {} };
}

// __TOY_CLUMP_DIAL__
function createClumpDial(): FoliageToy {
  return { html: '', mount: () => () => {} };
}

// __TOY_FOLLOW_RING__
function createFollowRing(): FoliageToy {
  return { html: '', mount: () => () => {} };
}

// __TOY_ONE_WIND__
function createOneWind(): FoliageToy {
  return { html: '', mount: () => () => {} };
}

// __TOY_BUDGET_BARS__
function createBudgetBars(): FoliageToy {
  return { html: '', mount: () => () => {} };
}

const lodDial = createLodDial();
const clumpDial = createClumpDial();
const followRing = createFollowRing();
const oneWind = createOneWind();
const budgetBars = createBudgetBars();

/* --------------------------------------------------- scrolly: forest diagram */

// "How a forest stays cheap" — a five-stage plan view. Element ids are the
// contract with renderForest(); the painter only sets opacity / a few attrs.
const DIAGRAM_FOREST = `
  <svg viewBox="0 0 820 330" class="ss-svg" role="img" aria-label="How a forest is drawn cheaply">
    <defs>
      <radialGradient id="fo-you-g" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#eafff9"/>
        <stop offset="1" stop-color="#7fe0cd"/>
      </radialGradient>
      <filter id="fo-glow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="2" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>

    <!-- stage 0: one seed grows one tree -->
    <g id="fo-seed" opacity="0">
      <circle cx="410" cy="250" r="5" fill="#d2b46e"/>
      <path id="fo-sprout" d="M410 250 L410 250" stroke="#6fd7a2" stroke-width="3" fill="none" stroke-linecap="round"/>
      <text x="410" y="284" class="ss-t ss-tc" style="font-size:9px">one seed → one mesh</text>
    </g>

    <!-- stage 1: that one mesh, instanced across a chunk -->
    <g id="fo-chunk" opacity="0">
      <rect x="300" y="120" width="220" height="150" rx="8" fill="rgba(18,40,56,0.4)" stroke="rgba(127,224,205,0.3)"/>
      <g id="fo-instances"></g>
      <text x="410" y="292" class="ss-t ss-tc ss-sub">one buffer, drawn many times (instanced)</text>
    </g>

    <!-- stage 2: four rings of detail around you -->
    <g id="fo-rings" opacity="0">
      <circle id="fo-ring0" cx="410" cy="180" r="46" fill="rgba(111,215,196,0.14)" stroke="rgba(111,215,196,0.5)"/>
      <circle id="fo-ring1" cx="410" cy="180" r="92" fill="rgba(111,215,196,0.09)" stroke="rgba(111,215,196,0.35)"/>
      <circle id="fo-ring2" cx="410" cy="180" r="140" fill="rgba(158,242,223,0.05)" stroke="rgba(158,242,223,0.22)"/>
      <circle id="fo-ring3" cx="410" cy="180" r="190" fill="none" stroke="rgba(190,225,240,0.16)"/>
      <text x="410" y="132" class="ss-t ss-tc ss-lbl" style="font-size:9px">CANOPY</text>
      <text x="410" y="86" class="ss-t ss-tc ss-sub">GROVE</text>
      <text x="410" y="42" class="ss-t ss-tc ss-sub">LANDSCAPE · HORIZON</text>
    </g>

    <!-- stage 3: frustum wedge — only what you can see is drawn -->
    <g id="fo-frustum" opacity="0">
      <path id="fo-wedge" d="M410 180 L150 20 L670 20 Z" fill="rgba(158,242,223,0.08)" stroke="rgba(158,242,223,0.4)" stroke-dasharray="4 4"/>
      <text x="410" y="312" class="ss-t ss-tc ss-sub">chunks outside the view cone never draw</text>
    </g>

    <!-- the trees themselves (planted once in mount, coloured by tier here) -->
    <g id="fo-forest"></g>

    <!-- stage 4: a static shadow layer that never pops -->
    <g id="fo-shadows" opacity="0"></g>

    <circle id="fo-you" cx="410" cy="180" r="7" fill="url(#fo-you-g)" filter="url(#fo-glow)"/>
    <text id="fo-youlbl" x="410" y="200" class="ss-t ss-tc" style="font-size:8px" opacity="0">you</text>
  </svg>`;

/* ---------------------------------------------------------------- the content */

export const FOLIAGE_TAB_HTML = `
  <section>
    <p class="bts-lede">Stand in Golden Gate Park and turn a slow circle. There are trees to the horizon,
    grass moving under your feet, wildflowers clumped in the sun and scattered in the shade — and it keeps
    going, over the hills, into the Presidio, across the bridge into the wild Marin headlands. None of it
    is placed by hand, and almost none of it is actually <em>there</em> until you're near it. This chapter
    is about the single hardest trick in a world this size: how to grow a believable amount of living
    green — millions of blades, thousands of trees — and still hold a smooth frame in a browser tab. The
    answer is a stack of old ideas (grow a plant from a seed; cluster like nature clusters; fake the far
    away) bent hard around one modern constraint — a GPU that will forgive you almost anything except doing
    it all at once. A few of the diagrams below you can grab and play with.</p>
  </section>

  <!-- WEB-DEPENDENT: SeedThree lineage / "it started as a seed" -->
  <section>
    <h3><span class="bts-ic">🌱</span> It started with a seed</h3>
    <p data-fill="seedthree">__FILL_SEEDTHREE__</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌳</span> Grow it once, then cheat</h3>
    <p>A tree is expensive to <em>grow</em> — branching, bark, thousands of leaves — but you only pay that
    cost once. Each tree <strong>design</strong> is compiled a single time into an immutable set of
    vertex and index buffers, and from then on every fir on a Marin ridge or oak in the park is the
    <em>same</em> geometry, drawn again at a new position and a new random turn. That's the whole economy
    of it: the moment two things share a buffer, the GPU can draw a thousand of them in one instanced call
    for almost the price of one. So the forest isn't a thousand trees; it's a handful of designs and a very
    long list of where to put them — a list generated deterministically from the terrain, so every player
    walking the same hillside sees the same wood.</p>
    <p>The catch is that a lush tree up close and a green smudge on the horizon can't be the same amount of
    geometry — one needs every leaf, the other needs almost none. So the same design is kept at
    <strong>four levels of detail</strong>, and the runtime spends its polygons where your eye actually is:
    a small, fixed pool of fully-detailed "hero" trees near you, and cheap instanced batches for everything
    receding into the distance. Here's the whole scheme, laid out.</p>
  </section>

  <div class="scrolly" data-diagram="forest">
    <div class="scrolly-graphic">
      ${DIAGRAM_FOREST}
    </div>
    <div class="scrolly-steps">
      <div class="scrolly-step"><p><strong>It begins as one mesh.</strong> A single tree design is grown
      once — trunk, branches, a canopy of leaf cards — and frozen into buffers the GPU can keep. Nothing
      about this tree is special; it's a stamp, and the whole forest is made of stamps.</p></div>

      <div class="scrolly-step"><p><strong>One stamp, drawn many times.</strong> Across an 800-metre chunk,
      that same buffer is instanced into hundreds of trees — each with its own position, scale and yaw, but
      sharing one set of vertices. Hundreds of trees, a single draw call. Add a second design for variety
      and you've a whole believable wood for the cost of two.</p></div>

      <div class="scrolly-step"><p><strong>Four rings of "how much detail."</strong> Detail is spent by
      distance, in concentric bands around you: <em>canopy</em> right here (every leaf), <em>grove</em> a
      little out, flat <em>landscape</em> cards further still, and a single <em>horizon</em> silhouette for
      the far smudge. As you walk, trees slide inward through the rings and gain detail; walk away and they
      shed it.</p></div>

      <div class="scrolly-step"><p><strong>And most of it never draws at all.</strong> Only the chunks
      inside your view cone are considered, and each is culled against its own bounding sphere before a
      single triangle is submitted. The trees behind your head cost nothing. What's left — a few near hero
      trees and a couple of instanced far batches — is a forest that fits in a frame.</p></div>

      <div class="scrolly-step"><p><strong>The shadows sit still.</strong> If tree shadows switched detail
      with the trees, every LOD swap would twitch the shade on the ground. So the shadows are cast by a
      separate, static proxy that never changes tier — the massing on the grass stays put while the trees
      themselves quietly gain and lose leaves in front of it.</p></div>
    </div>
  </div>

  <section>
    <h3><span class="bts-ic">🎚️</span> Four kinds of far-away</h3>
    <p>The four levels are easy to name and hard to switch <em>between</em> — because the moment a tree
    jumps from one to the next, its silhouette changes, and a whole hillside of trees all jumping at the
    same distance reads as an ugly ripple sweeping toward you. Almost all the craft in a LOD system is in
    hiding that seam. Drag the dial below to walk away from a forest and watch a tree shed detail; then
    toggle the staggering off to see the pop the game works to avoid.</p>
    ${lodDial.html}
    <p>Three things soften the swap. Each chunk gets a small <strong>hash-bias</strong> to its transition
    distance — a few metres either way — so the grid never flips as one clean circle. Within a chunk, trees
    convert a <em>few at a time</em> across a wide band rather than all at once. And a band of
    <strong>hysteresis</strong> — a tree that just became a silhouette won't become a card again until you
    step meaningfully closer — stops a camera that's jittering on a boundary from strobing the whole wood
    back and forth. The result is a frontier of detail that dissolves rather than snaps.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌑</span> Shadows that don't flinch</h3>
    <p>Worth its own note, because it's the kind of bug you feel before you see: if the thing casting a
    shadow keeps changing shape, the shadow shimmers. Trees change shape constantly — that's what LOD
    <em>is</em>. So tree shadows here aren't cast by the trees you see at all. They're cast by a separate,
    <strong>static shadow proxy</strong>: coarse stand-in massing, chopped into world-space microcells,
    drawn once through a single shared depth material and left alone. It never switches level, so the shade
    pooled under a stand of redwoods stays rock-steady while the redwoods themselves gain and drop leaves as
    you move. You get the weight of a forest's shadow without paying to re-shadow it every time a tree at
    the edge of view flips to a billboard.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌾</span> A blade is a curve with a plan</h3>
    <p>Grass is the opposite problem. A single tree is a lot of geometry drawn a few hundred times; grass is
    almost no geometry drawn a staggering number of times. Each blade is a little curved ribbon — a few
    vertices tapering to a tip — and the meadow is those ribbons instanced by the hundred thousand, bent in
    the vertex shader so the CPU never touches an individual blade. Density is layered: the ground near your
    feet gets the full count (the closest layer literally doubles the blade count for a lush carpet), and it
    thins outward through <strong>four additive layers</strong>, each reaching farther and fading over its
    own band — 12 metres, 26, 60, out to about 110 — so there's no single distance where the grass visibly
    stops. It just gets sparser until it's gone.</p>
    <p>The trouble with a dense meadow isn't drawing it — the GPU handles that — it's <em>building</em> it:
    sampling the terrain for every blade, allocating buffers, uploading them. Do that in one go for a park's
    worth of grass and you freeze for a third of a second. So the build was cut into slices and handed to
    the game's frame-budget scheduler, which spends about <strong>0.8 milliseconds a frame</strong> on it
    and no more — nearest patches first — until the meadow is quietly, invisibly complete. Watch the
    difference.</p>
    ${budgetBars.html}
    <p>The old synchronous build blocked for around <strong>452 milliseconds</strong> — a visible, jarring
    hitch. The sliced version costs under a millisecond on any given frame and you never catch it working.
    (And when you <em>teleport</em> into a park, the same builder is handed a much bigger budget while the
    loading cover is still up — so the meadow fills fast in the dark, then drops back to its polite trickle
    the instant you can see.)</p>
  </section>

  <!-- WEB-DEPENDENT: False Earth attribution woven into the flower story -->
  <section>
    <h3><span class="bts-ic">🌸</span> Where the flowers decide to grow</h3>
    <p>Real wildflowers don't sprinkle evenly across a field — they clump. A patch of the same species here,
    a lonely single there, bare ground between. Scatter flowers with an even random spray and the eye reads
    it instantly as fake. So placement here borrows an idea from <span data-fill="falseearth-inline">a
    lovely piece of foliage art</span>: <strong>Voronoi clustering</strong>. Every point on the ground asks
    a simple question — "which clump centre owns me, and how deep inside it am I?" Deep in a clump you get a
    dense, single-species patch; far from every centre you get sparse, mixed singles. Drag the knob to take
    the same field of candidate blooms from an even sprinkle to real, clustered patches.</p>
    ${clumpDial.html}
    <p>That's the exact algorithm the game plants with — the toy above runs the same <code>worleyClump</code>
    the flower ring does. On top of the placement, the blooms themselves are real little 3D things:
    layered curved petals with true normals, a translucent subsurface material that lets light bleed through
    the way a petal actually glows, a fresnel rim, and a pale-centre-to-saturated-edge colour ramp — the
    close, hero flowers keep all of that; the far ones fall back to a cheaper material nobody's close enough
    to interrogate.</p>
    <p data-fill="falseearth">__FILL_FALSEEARTH__</p>
  </section>

  <section>
    <h3><span class="bts-ic">🍃</span> One wind, one footprint</h3>
    <p>Here's a small thing that matters more than it should: everything green bends to the
    <strong>same wind</strong>. There isn't a wind for grass and a separate wind for flowers — there's one
    global gust value, and every blade and every petal reads it through one shared function (a couple of
    sine waves plus scrolling noise), so a gust travels across the whole meadow as a single coherent wave
    instead of a thousand things twitching independently. And that same gust value drives the wind you
    <em>hear</em> — so the swell that rolls across the grass is the swell that rises in the audio. Drag the
    gust, or leave it breathing on its own.</p>
    ${oneWind.html}
    <p>Footfalls work the same way. Instead of every layer running its own collision, there's one shared
    <strong>trample field</strong> — a short list of up to a dozen "displacers" (you, and any nearby
    creatures), each just a position, a radius and a strength — and every layer of grass and every flower
    samples that one list to bend away from what's stepping on it. One list, read by everything: a meadow
    that parts around you and springs back, for the cost of twelve numbers.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌍</span> Bounded on a boundless map</h3>
    <p>All of this would still be hopeless if the cost grew with the size of the world — and San Francisco
    is a big world. The trick that makes it tractable is that grass and flowers don't belong to the
    <em>map</em>; they belong to <strong>you</strong>. They live in a ring that follows you around,
    re-sampling the ground as you move, so the amount of green being built and drawn is fixed no matter how
    large the park is or how far you walk. An acre or a hundred acres cost exactly the same. Drag "you"
    across the map below and watch the ring come along — then flip to planting the whole map and watch the
    cost meter panic.</p>
    ${followRing.html}
    <p>Trees do a version of the same thing with their fixed near-pool and distance-culled far chunks, and
    the terrain underneath is a camera-following clipmap (its own story, in <a data-bts-tab="smooth"
    href="#">Making it smooth</a>). The theme is everywhere in this project: <em>make the cost about the
    player, not the world.</em> A world you can't afford to render all at once becomes a world you never
    have to.</p>
  </section>

  <!-- WEB-DEPENDENT partially: this is the SF-specific optimization pass -->
  <section>
    <h3><span class="bts-ic">🛠️</span> What this world did to it</h3>
    <p>The bones above are general — grow once, instance, LOD, cluster, follow the player. The pass that
    made this <em>specific</em> world hold its frame was a long list of un-glamorous, world-specific fixes,
    most of them about smoothness rather than looks. Grass went from a single blocking build to the sliced,
    budgeted streamer you saw above (about 452 ms of hitch, gone). The native-tree LOD transitions got their
    hash-bias, banded conversion and hysteresis so the wood stops flipping in a circle. Distant tree
    silhouettes were re-cut into more, smaller cards holding the same coverage — better outline, no extra
    fill. Close broadleaf crowns gained a little leaflet detail without adding vertices. Flower fields learned
    to dissolve into scattered singles over a staggered band instead of ending on a hard rim. The shadow
    proxy was decoupled so LOD swaps stop twitching the shade. And destination foliage learned to prime
    itself under the teleport cover — compiled and warmed before it's shown — so arriving in a park no longer
    means watching it grow in. Density went <em>up</em> (a good deal denser grass and flowers) while the cost
    of a frame went down; that's the whole scorecard.</p>
  </section>

  <!-- WEB-DEPENDENT: future improvements to try next pass -->
  <section>
    <h3><span class="bts-ic">🔭</span> Next pass — ideas worth trying</h3>
    <p>None of this is finished; it's just where the trade-offs currently sit. If you (or a future agent
    reading this) want to push it further, here are the threads most worth pulling — a mix of well-worn
    graphics techniques this project doesn't yet use and small experiments that fit its WebGPU-only,
    compute-friendly grain.</p>
    <div data-fill="future">__FILL_FUTURE__</div>
    <p class="bts-aside">If you try any of these, the honest test is the same one the whole pass was judged
    by: does it add density or reach or smoothness <em>without</em> costing a frame — measured on an
    ordinary laptop, walking, driving and flying, not just standing still?</p>
  </section>

  <section class="bts-colophon">
    <h3><span class="bts-ic">🔗</span> Lineage &amp; credits</h3>
    <p data-fill="colophon">__FILL_COLOPHON__</p>
  </section>
`;

/* ------------------------------------------------------------- controller */

type ScrollyState = { el: HTMLElement; steps: HTMLElement[]; svg: SVGSVGElement | null };

function setOpacity(svg: SVGSVGElement, id: string, v: number) {
  const el = svg.getElementById(id) as SVGElement | null;
  if (el) el.style.opacity = String(clamp(v));
}
function setAttr(svg: SVGSVGElement, id: string, name: string, v: string | number) {
  const el = svg.getElementById(id) as SVGElement | null;
  if (el) el.setAttribute(name, String(v));
}

export function mountFoliage(pane: HTMLElement, scrollEl: HTMLElement) {
  // wire the interactive toys — each returns a per-frame update
  const frames = [lodDial, clumpDial, followRing, oneWind, budgetBars].map((toy) => toy.mount(pane));

  // the one scroll-driven diagram
  const scrollies: ScrollyState[] = [...pane.querySelectorAll<HTMLElement>(".scrolly")].map((el) => ({
    el,
    steps: [...el.querySelectorAll<HTMLElement>(".scrolly-step")],
    svg: el.querySelector<SVGSVGElement>("svg")
  }));

  // plant the diagram's trees + shadow proxies once (positions reused each frame)
  for (const s of scrollies) if (s.svg) plantForestDiagram(s.svg);

  let raf = 0;
  let t0 = performance.now();
  let running = false;

  function paint(t: number) {
    const cr = scrollEl.getBoundingClientRect();
    const trigger = cr.top + cr.height * 0.58;
    for (const s of scrollies) {
      let stage = 0;
      let p = 0;
      for (let i = 0; i < s.steps.length; i++) {
        const r = s.steps[i].getBoundingClientRect();
        s.steps[i].classList.toggle("active", false);
        if (r.top <= trigger) {
          stage = i;
          const next = s.steps[i + 1]?.getBoundingClientRect();
          const span = (next ? next.top : r.bottom) - r.top;
          p = clamp((trigger - r.top) / Math.max(1, span));
        }
      }
      s.steps[stage]?.classList.add("active");
      if (s.svg) renderForest(s.svg, stage, p, t);
    }
    for (const f of frames) f(t);
  }

  const onScroll = () => paint((performance.now() - t0) / 1000);
  const loop = (now: number) => {
    paint((now - t0) / 1000);
    if (running) raf = requestAnimationFrame(loop);
  };

  return {
    activate() {
      if (running) return;
      running = true;
      t0 = performance.now();
      scrollEl.addEventListener("scroll", onScroll, { passive: true });
      raf = requestAnimationFrame(loop);
    },
    deactivate() {
      running = false;
      scrollEl.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    }
  };
}

/* ---------------------------------------------------- forest diagram painter */

// A stable pseudo-random forest laid out once, then re-tinted per stage. Each
// tree has a world position (metres from you), a screen point, and a base size.
type DiagTree = { wx: number; wz: number; dist: number; sx: number; sy: number; size: number; ph: number };
const diagTrees: DiagTree[] = [];

function plantForestDiagram(svg: SVGSVGElement) {
  const forest = svg.getElementById("fo-forest");
  const shadows = svg.getElementById("fo-shadows");
  const instances = svg.getElementById("fo-instances");
  if (!forest || !shadows) return;
  const cx = 410, cy = 180;
  diagTrees.length = 0;
  // scatter trees on a jittered radial field around "you"
  let seed = 1;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 46; i++) {
    const ang = rnd() * Math.PI * 2;
    const rad = 24 + rnd() * 170;
    const sx = cx + Math.cos(ang) * rad * 1.35;
    const sy = cy + Math.sin(ang) * rad * 0.62;
    if (sy < 14 || sy > 322) continue;
    diagTrees.push({
      wx: Math.cos(ang) * rad,
      wz: Math.sin(ang) * rad,
      dist: rad,
      sx,
      sy,
      size: 1,
      ph: rnd() * Math.PI * 2
    });
  }
  // shadow blobs (static) + tree marks (tinted per stage)
  const shadowSvg = diagTrees
    .map((t) => `<ellipse data-i cx="${t.sx.toFixed(1)}" cy="${(t.sy + 3).toFixed(1)}" rx="7" ry="2.6" fill="rgba(0,10,8,0.35)"/>`)
    .join("");
  shadows.innerHTML = shadowSvg;
  forest.innerHTML = diagTrees
    .map(
      (_t, i) =>
        `<g data-tree="${i}"><path data-trunk stroke="#7a5a3a" stroke-width="1.4" fill="none"/>` +
        `<circle data-crown fill="#4f9d72"/></g>`
    )
    .join("");
  // a small instanced grid for stage 1
  if (instances) {
    let g = "";
    for (let r = 0; r < 4; r++)
      for (let c = 0; c < 6; c++) {
        const x = 320 + c * 36;
        const y = 140 + r * 34;
        g += `<g transform="translate(${x} ${y})"><line x1="0" y1="0" x2="0" y2="-12" stroke="#7a5a3a" stroke-width="1.2"/><circle cx="0" cy="-15" r="7" fill="#4f9d72"/></g>`;
      }
    instances.innerHTML = g;
  }
}

// tier colours: canopy → grove → landscape → horizon
const TIER_FILL = ["#5fce93", "#4f9d72", "#3c7d5b", "#2f5f47"];

function renderForest(svg: SVGSVGElement, stage: number, p: number, t: number) {
  const f = stage + p; // 0..4 continuous
  setOpacity(svg, "fo-seed", atStage([1, 0.15, 0, 0, 0], f));
  setOpacity(svg, "fo-chunk", atStage([0, 1, 0.2, 0, 0], f));
  setOpacity(svg, "fo-rings", atStage([0, 0.1, 1, 0.7, 0.5], f));
  setOpacity(svg, "fo-frustum", atStage([0, 0, 0.1, 1, 0.7], f));
  setOpacity(svg, "fo-shadows", atStage([0, 0, 0, 0.2, 1], f));
  setOpacity(svg, "fo-forest", atStage([0, 0.2, 1, 1, 1], f));
  setOpacity(svg, "fo-youlbl", atStage([0, 0, 1, 1, 1], f));

  // seed sprout grows in stage 0
  const grow = clamp(atStage([0, 1, 1, 1, 1], f));
  setAttr(svg, "fo-sprout", "d", `M410 250 L410 ${(250 - 22 * grow).toFixed(1)}`);

  // forest trees: size by tier (near = big/detailed), tint by tier, sway idle
  const forest = svg.getElementById("fo-forest");
  const wedge = { apexX: 410, apexY: 180, halfAng: 1.05, dir: -Math.PI / 2 }; // pointing up
  const cullOn = clamp(atStage([0, 0, 0, 1, 1], f));
  if (forest) {
    for (let i = 0; i < diagTrees.length; i++) {
      const tr = diagTrees[i];
      const g = forest.children[i] as SVGGElement | undefined;
      if (!g) continue;
      // tier from distance
      const tier = tr.dist < 46 ? 0 : tr.dist < 92 ? 1 : tr.dist < 140 ? 2 : 3;
      const size = [8, 6.2, 4.4, 2.8][tier];
      const sway = Math.sin(t * 1.6 + tr.ph) * (1.4 - tier * 0.3);
      // in-frustum test (stage 3+): angle from apex toward tree vs wedge dir
      const ang = Math.atan2(tr.sy - wedge.apexY, tr.sx - wedge.apexX);
      let da = ang - wedge.dir;
      while (da > Math.PI) da -= Math.PI * 2;
      while (da < -Math.PI) da += Math.PI * 2;
      const inView = Math.abs(da) < wedge.halfAng;
      const vis = lerp(1, inView ? 1 : 0.12, cullOn);
      g.setAttribute("opacity", String(vis));
      const trunk = g.querySelector("[data-trunk]") as SVGPathElement | null;
      const crown = g.querySelector("[data-crown]") as SVGCircleElement | null;
      if (trunk) trunk.setAttribute("d", `M${tr.sx.toFixed(1)} ${tr.sy.toFixed(1)} L${(tr.sx + sway).toFixed(1)} ${(tr.sy - size * 1.5).toFixed(1)}`);
      if (crown) {
        crown.setAttribute("cx", (tr.sx + sway).toFixed(1));
        crown.setAttribute("cy", (tr.sy - size * 1.7).toFixed(1));
        crown.setAttribute("r", size.toFixed(1));
        crown.setAttribute("fill", TIER_FILL[tier]);
      }
    }
  }

  // you dot breathes
  setAttr(svg, "fo-you", "r", (6 + 1.4 * (0.5 + 0.5 * Math.sin(t * 2))).toFixed(2));
}
