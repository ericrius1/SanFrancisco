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

function createLodDial(): FoliageToy {
  const html = `
  <div class="ss-interactive" data-ftoy="lodDial">
    <div class="ss-toy-head"><span class="ss-toy-ic">🌲</span>The distance dial
      <span class="ss-toy-hint">drag to walk away from the forest</span></div>
    <svg viewBox="0 0 700 260" class="ss-toysvg" role="img"
         aria-label="A tree dropping through four level-of-detail tiers as it recedes, and a forest collapsing to a couple of draw calls">
      <line x1="34" y1="220" x2="300" y2="220" stroke="rgba(190,225,240,0.16)"/>
      <ellipse cx="150" cy="221" rx="70" ry="7" fill="rgba(18,40,56,0.6)"/>
      <text class="ss-sub" x="150" y="240" text-anchor="middle" data-el="herolabel">up close · every leaf</text>

      <g data-el="hero">
        <g data-el="h-canopy">
          <path d="M-7 0 L-4 -96 L4 -96 L7 0 Z" fill="#6e4f36"/>
          <ellipse cx="0" cy="-116" rx="34" ry="30" fill="#3f9d6a"/>
          <ellipse cx="-26" cy="-104" rx="22" ry="20" fill="#3f9d6a"/>
          <ellipse cx="26" cy="-104" rx="22" ry="20" fill="#3f9d6a"/>
          <ellipse cx="-16" cy="-134" rx="20" ry="19" fill="#3f9d6a"/>
          <ellipse cx="16" cy="-134" rx="20" ry="19" fill="#3f9d6a"/>
          <ellipse cx="0" cy="-146" rx="18" ry="17" fill="#3f9d6a"/>
          <ellipse cx="-30" cy="-118" rx="17" ry="16" fill="#4fb47f"/>
          <ellipse cx="30" cy="-118" rx="17" ry="16" fill="#4fb47f"/>
          <ellipse cx="0" cy="-122" rx="24" ry="21" fill="#4fb47f"/>
          <ellipse cx="-14" cy="-100" rx="18" ry="16" fill="#4fb47f"/>
          <ellipse cx="-10" cy="-128" rx="15" ry="14" fill="#6fd7a2"/>
          <ellipse cx="10" cy="-128" rx="15" ry="14" fill="#6fd7a2"/>
          <ellipse cx="0" cy="-108" rx="18" ry="15" fill="#6fd7a2"/>
          <ellipse cx="14" cy="-100" rx="14" ry="13" fill="#6fd7a2"/>
        </g>
        <g data-el="h-grove">
          <path d="M-7 0 L-4 -96 L4 -96 L7 0 Z" fill="#6e4f36"/>
          <ellipse cx="0" cy="-114" rx="32" ry="28" fill="#3f9d6a"/>
          <ellipse cx="-22" cy="-102" rx="22" ry="20" fill="#3f9d6a"/>
          <ellipse cx="22" cy="-104" rx="22" ry="20" fill="#3f9d6a"/>
          <ellipse cx="0" cy="-132" rx="22" ry="20" fill="#4fb47f"/>
          <ellipse cx="-6" cy="-116" rx="18" ry="16" fill="#6fd7a2"/>
        </g>
        <g data-el="h-land">
          <path d="M-22 -4 L-6 -8 L-2 -116 L-18 -110 Z" fill="rgba(63,157,106,0.32)" stroke="rgba(127,224,205,0.45)"/>
          <path d="M6 -6 L24 -2 L18 -110 L4 -114 Z" fill="rgba(63,157,106,0.32)" stroke="rgba(127,224,205,0.45)"/>
          <path d="M-8 -2 L10 -6 L6 -120 L-10 -114 Z" fill="rgba(63,157,106,0.42)" stroke="rgba(127,224,205,0.45)"/>
          <path d="M0 -120 L18 -6 L-18 -6 Z" fill="#3f9d6a" opacity="0.85"/>
        </g>
        <g data-el="h-horiz">
          <rect x="-18" y="-116" width="36" height="112" fill="rgba(63,157,106,0.13)" stroke="rgba(127,224,205,0.3)"/>
          <path d="M0 -112 L14 -6 L-14 -6 Z" fill="#3f9d6a"/>
        </g>
      </g>

      <line x1="312" y1="30" x2="312" y2="214" stroke="rgba(190,225,240,0.16)" stroke-dasharray="3 5"/>

      <line x1="330" y1="216" x2="672" y2="188" stroke="rgba(190,225,240,0.16)"/>
      <g data-el="row"></g>
      <text class="ss-sub" x="360" y="240" text-anchor="middle">near · lush</text>
      <text class="ss-sub" x="588" y="176" text-anchor="middle">far forest · 1–2 instanced draws</text>
    </svg>
    <div class="ss-controls" data-el="ctl">
      <button class="ss-btn active" type="button" data-el="stag">staggered transitions</button>
    </div>
    <div class="ss-daybar">
      <input type="range" class="ss-slider" data-el="dist" min="0" max="560" step="1" value="40" aria-label="distance from the forest, metres">
      <button class="ss-btn ss-btn-ghost" type="button" data-el="auto">▶ walk</button>
      <span class="ss-readout" data-el="read"></span>
    </div>
  </div>`;

  function mount(pane: HTMLElement): (t: number) => void {
    const root = pane.querySelector<HTMLElement>('[data-ftoy="lodDial"]')!;
    const heroG = root.querySelector<SVGGElement>('[data-el="hero"]')!;
    const hCanopy = root.querySelector<SVGGElement>('[data-el="h-canopy"]')!;
    const hGrove = root.querySelector<SVGGElement>('[data-el="h-grove"]')!;
    const hLand = root.querySelector<SVGGElement>('[data-el="h-land"]')!;
    const hHoriz = root.querySelector<SVGGElement>('[data-el="h-horiz"]')!;
    const rowG = root.querySelector<SVGGElement>('[data-el="row"]')!;
    const slider = root.querySelector<HTMLInputElement>('[data-el="dist"]')!;
    const autoBtn = root.querySelector<HTMLButtonElement>('[data-el="auto"]')!;
    const stagBtn = root.querySelector<HTMLButtonElement>('[data-el="stag"]')!;
    const read = root.querySelector<HTMLElement>('[data-el="read"]')!;
    const heroLabel = root.querySelector<SVGTextElement>('[data-el="herolabel"]')!;
    const HEROLBL = [
      "up close · every leaf",
      "a little out · fewer clusters",
      "farther · flat cards",
      "far off · one silhouette",
      "gone · culled",
    ];

    // tier model — distances/tri magnitudes per the foliage FACTS
    const B0 = 96, B1 = 160, B2 = 220, B3 = 520;
    const TRIS = [1800, 700, 110, 6, 0];
    const TNAME = ["CANOPY", "GROVE", "LANDSCAPE", "HORIZON", "—"];
    const DRAWS = [
      "near pool ≈ 46 draws",
      "near pool ≈ 46 draws",
      "far forest ≈ 2 draws",
      "far forest ≈ 1 draw",
      "culled",
    ];
    const tierAt = (d: number): number => (d < B0 ? 0 : d < B1 ? 1 : d < B2 ? 2 : d < B3 ? 3 : 4);

    // build the receding row of 8 trees (near=lush -> far=silhouette)
    const N = 8;
    const gx: number[] = [];
    const gy: number[] = [];
    const gsc: number[] = [];
    const gbase: number[] = []; // intrinsic world depth of each tree, metres

    const smallVariants = (): string => {
      // local coords: trunk base at (0,0), crown grows upward (negative y)
      const canopy =
        `<g data-el="v0">` +
        `<path d="M-2 0 L-1.2 -19 L1.2 -19 L2 0 Z" fill="#6e4f36"/>` +
        `<ellipse cx="0" cy="-30" rx="12" ry="11" fill="#3f9d6a"/>` +
        `<ellipse cx="-8" cy="-23" rx="8" ry="8" fill="#3f9d6a"/>` +
        `<ellipse cx="8" cy="-24" rx="8" ry="8" fill="#4fb47f"/>` +
        `<ellipse cx="0" cy="-38" rx="8" ry="8" fill="#6fd7a2"/>` +
        `<ellipse cx="-4" cy="-29" rx="7" ry="7" fill="#6fd7a2"/>` +
        `</g>`;
      const grove =
        `<g data-el="v1">` +
        `<path d="M-2 0 L-1.2 -18 L1.2 -18 L2 0 Z" fill="#6e4f36"/>` +
        `<ellipse cx="0" cy="-28" rx="12" ry="11" fill="#3f9d6a"/>` +
        `<ellipse cx="-7" cy="-21" rx="8" ry="8" fill="#3f9d6a"/>` +
        `<ellipse cx="5" cy="-31" rx="7" ry="7" fill="#6fd7a2"/>` +
        `</g>`;
      const land =
        `<g data-el="v2">` +
        `<path d="M-11 -2 L-3 -5 L-1 -30 L-9 -27 Z" fill="rgba(63,157,106,0.32)" stroke="rgba(127,224,205,0.4)"/>` +
        `<path d="M2 -4 L11 -1 L8 -29 L0 -31 Z" fill="rgba(63,157,106,0.4)" stroke="rgba(127,224,205,0.4)"/>` +
        `<path d="M0 -32 L8 -2 L-8 -2 Z" fill="#3f9d6a" opacity="0.85"/>` +
        `</g>`;
      const horiz =
        `<g data-el="v3">` +
        `<rect x="-8" y="-31" width="16" height="29" fill="rgba(63,157,106,0.13)" stroke="rgba(127,224,205,0.3)"/>` +
        `<path d="M0 -30 L7 -2 L-7 -2 Z" fill="#3f9d6a"/>` +
        `</g>`;
      return canopy + grove + land + horiz +
        `<circle data-el="pop" cx="0" cy="-22" r="3" fill="#ff8a7a" opacity="0"/>`;
    };

    let rowHtml = "";
    for (let i = 0; i < N; i++) {
      const frac = i / (N - 1);
      const x = 336 + 320 * Math.pow(frac, 0.82);
      const y = 214 - 34 * frac;
      const sc = lerp(0.92, 0.34, frac);
      gx.push(x); gy.push(y); gsc.push(sc);
      gbase.push(380 * frac);
      rowHtml +=
        `<ellipse cx="${x.toFixed(1)}" cy="${(y + 2).toFixed(1)}" rx="${(11 * sc).toFixed(1)}" ry="${(2.4 * sc).toFixed(1)}" fill="rgba(18,40,56,0.55)"/>` +
        `<g data-el="rtree">${smallVariants()}</g>`;
    }
    rowG.innerHTML = rowHtml;

    const rtrees = Array.from(rowG.querySelectorAll<SVGGElement>('[data-el="rtree"]'));
    const rv: SVGGElement[][] = [];
    const rpop: SVGCircleElement[] = [];
    for (const g of rtrees) {
      rv.push([
        g.querySelector<SVGGElement>('[data-el="v0"]')!,
        g.querySelector<SVGGElement>('[data-el="v1"]')!,
        g.querySelector<SVGGElement>('[data-el="v2"]')!,
        g.querySelector<SVGGElement>('[data-el="v3"]')!,
      ]);
      rpop.push(g.querySelector<SVGCircleElement>('[data-el="pop"]')!);
    }

    // interactive state (closures)
    let dist = 40;
    let staggered = true;
    let auto = false;
    let walkPhase = 0;
    let lastT = 0;
    let lastReadKey = "";
    const heroVis = [1, 0, 0, 0]; // eased per-tier opacity — only one is ever ~1
    let lastHeroTier = 0;

    // staggered -> per-chunk hash bias ±12 m so the grid never flips along one circle
    const biasOf = (i: number): number => (staggered ? hash2(i, 7, 3) * 24 - 12 : 0);

    const prevTier: number[] = [];
    const vis: number[][] = [];
    for (let i = 0; i < N; i++) {
      const tier = tierAt(gbase[i] + (dist - 40) + biasOf(i));
      prevTier.push(tier);
      vis.push([tier === 0 ? 1 : 0, tier === 1 ? 1 : 0, tier === 2 ? 1 : 0, tier === 3 ? 1 : 0]);
    }
    const popStart: number[] = new Array<number>(N).fill(-1);

    slider.addEventListener("input", () => {
      dist = parseFloat(slider.value);
      auto = false;
      autoBtn.classList.remove("active");
    });
    autoBtn.addEventListener("click", () => {
      auto = !auto;
      autoBtn.classList.toggle("active", auto);
    });
    stagBtn.addEventListener("click", () => {
      staggered = !staggered;
      stagBtn.classList.toggle("active", staggered);
    });

    return (t: number): void => {
      const dt = lastT ? Math.min(0.05, t - lastT) : 0.016;
      lastT = t;
      const ease = Math.min(1, dt * 9); // shared time-based crossfade rate

      if (auto) {
        walkPhase += dt * 0.34;
        dist = 20 + 540 * (0.5 - 0.5 * Math.cos(walkPhase));
        slider.value = String(Math.round(dist));
      }

      // hero tree: show exactly ONE tier, eased in time (not blended by distance).
      // Hovering inside a tier lets the opacities settle to a clean 1/0, so two
      // silhouettes never sit ghosted over each other mid-drag — that overlap was the
      // "glitch". Crossing a boundary is a quick clean dissolve. Sways from its base.
      const curTier = tierAt(dist);
      const hTiers = [hCanopy, hGrove, hLand, hHoriz];
      for (let k = 0; k < 4; k++) {
        heroVis[k] += ((curTier === k ? 1 : 0) - heroVis[k]) * ease;
        hTiers[k].setAttribute("opacity", heroVis[k].toFixed(3));
      }
      if (curTier !== lastHeroTier) {
        lastHeroTier = curTier;
        heroLabel.textContent = HEROLBL[curTier];
      }
      const hs = lerp(1.18, 0.36, clamp(dist / 520));
      const hFade = 1 - smoothstep(500, 560, dist);
      const hSway = 1.4 * Math.sin(t * 0.7);
      heroG.setAttribute("opacity", hFade.toFixed(3));
      heroG.setAttribute("transform", `translate(150,216) rotate(${hSway.toFixed(2)}) scale(${hs.toFixed(3)})`);

      // readout (only rebuild the string when it actually changes)
      const hTier = tierAt(dist);
      const key = Math.round(dist) + "|" + hTier;
      if (key !== lastReadKey) {
        lastReadKey = key;
        const tris = hTier < 4 ? `≈${TRIS[hTier]} tris/tree` : "0 tris";
        read.textContent = `${Math.round(dist)} m · ${TNAME[hTier]} · ${tris} · ${DRAWS[hTier]}`;
      }

      // receding row: staggered soft frontier vs synchronized pop
      const off = dist - 40;
      for (let i = 0; i < N; i++) {
        const eff = gbase[i] + off + biasOf(i);
        const tier = tierAt(eff);
        if (tier !== prevTier[i]) {
          if (!staggered) {
            // hard flip: snap variants + fire an ugly pop jolt
            for (let k = 0; k < 4; k++) vis[i][k] = tier === k ? 1 : 0;
            popStart[i] = t;
          }
          prevTier[i] = tier;
        }
        const vr = rv[i];
        for (let k = 0; k < 4; k++) {
          const target = tier === k ? 1 : 0;
          if (staggered) vis[i][k] += (target - vis[i][k]) * ease; // gentle crossfade
          else vis[i][k] = target;
          vr[k].setAttribute("opacity", vis[i][k].toFixed(3));
        }

        // pop jolt is only ever armed when staggering is OFF
        let popScale = 1;
        const ps = popStart[i];
        if (ps >= 0) {
          const p = (t - ps) / 0.42;
          if (p >= 1) {
            popStart[i] = -1;
            rpop[i].setAttribute("opacity", "0");
          } else {
            const e = Math.sin(Math.PI * p);
            popScale = 1 + 0.42 * e;
            rpop[i].setAttribute("opacity", (0.7 * e).toFixed(3));
            rpop[i].setAttribute("r", (3 + 9 * e).toFixed(2));
          }
        }

        const treeO = 1 - smoothstep(505, 565, eff);
        const g = rtrees[i];
        g.setAttribute("opacity", treeO.toFixed(3));
        const a = 1.6 * Math.sin(t * 0.9 + i * 0.7);
        const s = gsc[i] * popScale;
        g.setAttribute("transform", `translate(${gx[i].toFixed(1)},${gy[i].toFixed(1)}) rotate(${a.toFixed(2)}) scale(${s.toFixed(3)})`);
      }
    };
  }

  return { html, mount };
}

function createClumpDial(): FoliageToy {
  const html = `
  <div class="ss-interactive" data-ftoy="clumpDial">
    <div class="ss-toy-head"><span class="ss-toy-ic">🌸</span>Clump vs scatter
      <span class="ss-toy-hint">drag: even sprinkle → real patches</span></div>
    <svg viewBox="0 0 700 300" class="ss-toysvg" role="img" aria-label="A field of flowers that clusters into same-species patches as the clump knob rises">
      <rect x="6" y="6" width="688" height="288" rx="14" fill="rgba(18,40,56,0.6)" stroke="rgba(190,225,240,0.16)"/>
      <g data-el="cells"></g>
      <g data-el="blooms"></g>
      <text class="ss-sub" x="24" y="284" data-el="lo">even sprinkle</text>
      <text class="ss-sub" x="676" y="284" text-anchor="end" data-el="hi">tight patches</text>
    </svg>
    <div class="ss-daybar">
      <input type="range" class="ss-slider" data-el="knob" min="0" max="1" step="0.01" value="0.15">
      <button class="ss-btn ss-btn-ghost" data-el="auto">▶ Auto</button>
      <span class="ss-readout" data-el="read">clump 0.15 · even sprinkle · 3 species</span>
    </div>
  </div>`;

  function mount(pane: HTMLElement): (t: number) => void {
    const root = pane.querySelector<HTMLElement>('[data-ftoy="clumpDial"]')!;
    const bloomsG = root.querySelector<SVGGElement>('[data-el="blooms"]')!;
    const cellsG = root.querySelector<SVGGElement>('[data-el="cells"]')!;
    const knob = root.querySelector<HTMLInputElement>('[data-el="knob"]')!;
    const auto = root.querySelector<HTMLButtonElement>('[data-el="auto"]')!;
    const read = root.querySelector<HTMLElement>('[data-el="read"]')!;

    const SVGNS = "http://www.w3.org/2000/svg";
    const HUES = ["#ff9ac4", "#d2b46e", "#b9a0ff"]; // rose · gold · violet

    // world → viewBox mapping (uniform scale so worley cells stay circular)
    const MX = 26, MY = 22;
    const PW = 700 - 2 * MX, PH = 300 - 2 * MY;
    const FIELDX = 240;                    // metres across
    const FIELDZ = (FIELDX * PH) / PW;     // metres tall (keeps scale square)
    const S = PW / FIELDX;                 // px per metre
    const CELL = 40, SALT = 7;
    const BIG = CELL, SMALL = CELL * 0.3;  // visibility threshold sweep
    const BAND = CELL * 0.34;              // soft edge — no hard circular rim

    type Pt = {
      el: SVGCircleElement;
      px: number; py: number;
      d: number; seed: number; sp: number;
      rk: number; phase: number;
      vis: boolean; base: number;
    };
    const pts: Pt[] = [];

    // jittered grid of candidate blooms
    const COLS = 36, ROWS = 14;
    for (let iz = 0; iz < ROWS; iz++) {
      for (let ix = 0; ix < COLS; ix++) {
        const jx = (hash2(ix, iz, 11) - 0.5) * (FIELDX / COLS) * 0.9;
        const jz = (hash2(ix, iz, 23) - 0.5) * (FIELDZ / ROWS) * 0.9;
        const wx = ((ix + 0.5) / COLS) * FIELDX + jx;
        const wz = ((iz + 0.5) / ROWS) * FIELDZ + jz;
        const c = worleyClump(wx, wz, CELL, SALT);
        const el = document.createElementNS(SVGNS, "circle") as SVGCircleElement;
        el.setAttribute("cx", (MX + wx * S).toFixed(1));
        el.setAttribute("cy", (MY + wz * S).toFixed(1));
        el.setAttribute("r", "2");
        bloomsG.appendChild(el);
        pts.push({
          el,
          px: MX + wx * S, py: MY + wz * S,
          d: c.d, seed: c.seed, sp: Math.floor(clamp(c.seed, 0, 0.999) * 3),
          rk: hash2(ix, iz, 47),
          phase: hash2(ix, iz, 71) * Math.PI * 2,
          vis: false, base: 1,
        });
      }
    }

    // clump-centre reveal rings (group candidates by shared centre seed).
    // Position ≈ the member sitting deepest in the clump (smallest d).
    type Ctr = { el: SVGCircleElement; cx: number; cy: number; minD: number };
    const centres = new Map<string, Ctr>();
    for (const p of pts) {
      const key = p.seed.toFixed(5);
      const cur = centres.get(key);
      if (!cur) {
        const ring = document.createElementNS(SVGNS, "circle") as SVGCircleElement;
        ring.setAttribute("cx", p.px.toFixed(1));
        ring.setAttribute("cy", p.py.toFixed(1));
        ring.setAttribute("r", (CELL * 0.5 * S).toFixed(1));
        ring.setAttribute("fill", "none");
        ring.setAttribute("stroke", "rgba(127,224,205,0.45)");
        ring.setAttribute("stroke-width", "1");
        ring.setAttribute("opacity", "0");
        cellsG.appendChild(ring);
        centres.set(key, { el: ring, cx: p.px, cy: p.py, minD: p.d });
      } else if (p.d < cur.minD) {
        cur.minD = p.d; cur.cx = p.px; cur.cy = p.py;
        cur.el.setAttribute("cx", p.px.toFixed(1));
        cur.el.setAttribute("cy", p.py.toFixed(1));
      }
    }

    let clump = parseFloat(knob.value);
    const active: Pt[] = []; // visible subset the frame loop twinkles

    function rebuild(): void {
      const thr = lerp(BIG, SMALL, clump);
      active.length = 0;
      const seen = [false, false, false];
      for (const p of pts) {
        // step: ~1 when the point sits within the current threshold (near a
        // clump centre), fading to 0 past it. As `clump` rises the threshold
        // shrinks, so only patch cores survive — the same per-point random
        // keep (rk) makes the clump=0 case an even sprinkle, not a grid.
        const step = smoothstep(thr + BAND, thr - BAND, p.d);
        const show = clamp(0.55 * step + 0.06);
        const vis = p.rk < show;
        p.vis = vis;
        if (!vis) { p.el.setAttribute("display", "none"); continue; }
        p.el.removeAttribute("display");
        const depth = clamp(1 - p.d / (CELL * 0.62)); // deeper ⇒ bigger/brighter
        const r = 1.9 + depth * 2.7;
        p.base = 0.62 + 0.34 * depth;
        p.el.setAttribute("r", r.toFixed(2));
        p.el.setAttribute("fill", HUES[p.sp]);
        seen[p.sp] = true;
        active.push(p);
      }
      // reveal the underlying Voronoi structure only as patches tighten
      const ringOp = (0.09 * smoothstep(0.35, 1, clump)).toFixed(3);
      centres.forEach((c) => c.el.setAttribute("opacity", ringOp));

      const nSp = (seen[0] ? 1 : 0) + (seen[1] ? 1 : 0) + (seen[2] ? 1 : 0);
      const mood = clump < 0.28 ? "even sprinkle" : clump < 0.62 ? "patches forming" : "tight patches";
      read.textContent = `clump ${clump.toFixed(2)} · ${mood} · ${nSp} species`;
    }

    knob.addEventListener("input", () => {
      autoOn = false;
      auto.classList.remove("active");
      auto.textContent = "▶ Auto";
      clump = parseFloat(knob.value);
      rebuild();
    });

    let autoOn = false;
    auto.addEventListener("click", () => {
      autoOn = !autoOn;
      auto.classList.toggle("active", autoOn);
      auto.textContent = autoOn ? "⏸ Auto" : "▶ Auto";
    });

    rebuild();

    let last = 0;
    return (t: number): void => {
      if (autoOn) {
        clump = 0.5 - 0.5 * Math.cos(t * 0.35); // slow sweep 0↔1
        knob.value = clump.toFixed(2);
        if (t - last > 0.06) { rebuild(); last = t; } // throttle costly rebuilds
      }
      // cheap twinkle across the visible blooms
      for (let i = 0; i < active.length; i++) {
        const p = active[i];
        const o = p.base * (0.8 + 0.2 * Math.sin(t * 1.7 + p.phase));
        p.el.setAttribute("opacity", o.toFixed(2));
      }
    };
  }

  return { html, mount };
}

function createFollowRing(): FoliageToy {
  const uid = 'fr' + Math.random().toString(36).slice(2, 8);
  const FX = 20, FY = 16, FX2 = 680, FY2 = 266;   // viewport frame (window into the world)
  const CX = 350, CY = 141;                         // world centre
  const HW = 280, HH = 100;                         // base half-extent at map ×1
  const R = 70;                                     // follow-ring radius (viewBox units)
  const BARX = 96, BARY = 292, BARW = 414, BARH = 15;
  const BUDGET = BARX + BARW * 0.5;
  const LM: number[][] = [
    [-0.58, -0.42, 34], [0.52, -0.28, 26], [0.16, 0.46, 40],
    [-0.32, 0.5, 22], [0.7, 0.56, 20], [-0.05, -0.08, 18],
  ];

  const html = `
  <div class="ss-interactive" data-ftoy="followRing">
    <div class="ss-toy-head"><span class="ss-toy-ic">🌍</span>Follow the ring
      <span class="ss-toy-hint">drag ‘you’ across the map</span></div>
    <svg viewBox="0 0 700 340" class="ss-toysvg" role="img"
         aria-label="A grass ring that follows you across the map, keeping cost fixed no matter how big the map grows">
      <defs>
        <clipPath id="${uid}"><rect x="${FX}" y="${FY}" width="${FX2 - FX}" height="${FY2 - FY}" rx="10"/></clipPath>
      </defs>
      <rect x="${FX}" y="${FY}" width="${FX2 - FX}" height="${FY2 - FY}" rx="10" fill="rgba(18,40,56,0.6)"/>
      <g clip-path="url(#${uid})">
        <rect data-el="world" x="70" y="41" width="560" height="200" rx="8"
              fill="rgba(18,40,56,0.6)" stroke="rgba(190,225,240,0.16)"/>
        <g data-el="marks"></g>
        <g data-el="whole" style="display:none"></g>
        <g data-el="player">
          <g data-el="ring">
            <circle data-el="ringglow" cx="0" cy="0" r="${R}" fill="none"
                    stroke="rgba(127,224,205,0.45)" stroke-width="7" opacity="0.14"/>
            <circle data-el="ringline" cx="0" cy="0" r="${R}" fill="none"
                    stroke="rgba(127,224,205,0.45)" stroke-width="1.4" stroke-dasharray="3 5"/>
            <text class="ss-sub" x="0" y="${R + 16}" text-anchor="middle">your ring · fixed cost</text>
          </g>
          <circle data-el="youhalo" cx="0" cy="0" r="8" fill="none" stroke="#9ef2df" stroke-width="1.4"/>
          <circle data-el="youdot" cx="0" cy="0" r="4.5" fill="#eafff9"/>
        </g>
      </g>
      <rect x="${FX}" y="${FY}" width="${FX2 - FX}" height="${FY2 - FY}" rx="10" fill="none" stroke="rgba(127,224,205,0.45)"/>
      <text class="ss-sub" x="${FX + 10}" y="${FY + 16}">the whole world →</text>

      <text class="ss-lbl" x="30" y="${BARY + 12}">cost</text>
      <rect x="${BARX}" y="${BARY}" width="${BARW}" height="${BARH}" rx="4"
            fill="rgba(18,40,56,0.6)" stroke="rgba(190,225,240,0.16)"/>
      <rect data-el="fill" x="${BARX}" y="${BARY}" width="50" height="${BARH}" rx="4" fill="#6fd7a2"/>
      <line x1="${BUDGET}" y1="${BARY - 3}" x2="${BUDGET}" y2="${BARY + BARH + 3}"
            stroke="rgba(190,225,240,0.16)" stroke-dasharray="2 3"/>
      <text class="ss-sub" x="${BUDGET}" y="${BARY + BARH + 15}" text-anchor="middle">budget</text>
      <text class="ss-t" data-el="costread" x="684" y="${BARY - 6}" text-anchor="end">ring · cost ≈ constant</text>
    </svg>
    <div class="ss-controls">
      <button class="ss-btn" data-el="all">🗺 plant the whole map</button>
    </div>
    <div class="ss-daybar">
      <input type="range" class="ss-slider" data-el="size" min="0.5" max="3" step="0.01" value="1">
      <span class="ss-readout" data-el="read">map ×1.0</span>
    </div>
  </div>`;

  function mount(pane: HTMLElement): (t: number) => void {
    const root = pane.querySelector<HTMLElement>('[data-ftoy="followRing"]')!;
    const svg = root.querySelector<SVGSVGElement>('svg')!;
    const world = root.querySelector<SVGRectElement>('[data-el="world"]')!;
    const marks = root.querySelector<SVGGElement>('[data-el="marks"]')!;
    const whole = root.querySelector<SVGGElement>('[data-el="whole"]')!;
    const player = root.querySelector<SVGGElement>('[data-el="player"]')!;
    const ring = root.querySelector<SVGGElement>('[data-el="ring"]')!;
    const ringline = root.querySelector<SVGCircleElement>('[data-el="ringline"]')!;
    const ringglow = root.querySelector<SVGCircleElement>('[data-el="ringglow"]')!;
    const fill = root.querySelector<SVGRectElement>('[data-el="fill"]')!;
    const costread = root.querySelector<SVGTextElement>('[data-el="costread"]')!;
    const btnAll = root.querySelector<HTMLButtonElement>('[data-el="all"]')!;
    const size = root.querySelector<HTMLInputElement>('[data-el="size"]')!;
    const read = root.querySelector<HTMLElement>('[data-el="read"]')!;
    const NS = 'http://www.w3.org/2000/svg';

    let youX = 300, youY = 150;
    let mapSize = 1;
    let wholeMap = false;
    let dragging = false;

    // --- follow-ring blades: precompute offsets once, animate cheaply ---
    const N = 120;
    const bx = new Float32Array(N), by = new Float32Array(N);
    const blen = new Float32Array(N), bph = new Float32Array(N);
    const bel: SVGElement[] = [];
    for (let i = 0; i < N; i++) {
      const a = Math.random() * Math.PI * 2;
      const rad = 54 + Math.random() * 24;          // annulus band around R
      const x = Math.cos(a) * rad, y = Math.sin(a) * rad;
      const ln = 5 + Math.random() * 5.5;
      bx[i] = x; by[i] = y; blen[i] = ln; bph[i] = Math.random() * 6.283;
      const el = document.createElementNS(NS, 'line');
      el.setAttribute('x1', x.toFixed(1)); el.setAttribute('y1', y.toFixed(1));
      el.setAttribute('x2', x.toFixed(1)); el.setAttribute('y2', (y - ln).toFixed(1));
      el.setAttribute('stroke', '#7fe0cd'); el.setAttribute('stroke-width', '1.6');
      el.setAttribute('stroke-linecap', 'round'); el.setAttribute('opacity', '0.7');
      ring.appendChild(el); bel.push(el);
    }

    // --- faint landmark blobs (created once, repositioned when the map scales) ---
    const mel: SVGElement[] = [];
    for (let i = 0; i < LM.length; i++) {
      const el = document.createElementNS(NS, 'ellipse');
      el.setAttribute('fill', 'rgba(190,225,240,0.10)');
      marks.appendChild(el); mel.push(el);
    }

    // --- the "plant everything" grid: dense, static, toggled ---
    for (let gy = FY + 8; gy < FY2; gy += 18) {
      for (let gx = FX + 8; gx < FX2; gx += 18) {
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', gx.toFixed(0)); c.setAttribute('cy', gy.toFixed(0));
        c.setAttribute('r', '1.5'); c.setAttribute('fill', '#7fe0cd'); c.setAttribute('opacity', '0.5');
        whole.appendChild(c);
      }
    }

    function layoutWorld(): void {
      const hw = HW * mapSize, hh = HH * mapSize;
      world.setAttribute('x', (CX - hw).toFixed(1));
      world.setAttribute('y', (CY - hh).toFixed(1));
      world.setAttribute('width', (2 * hw).toFixed(1));
      world.setAttribute('height', (2 * hh).toFixed(1));
      for (let i = 0; i < LM.length; i++) {
        const lm = LM[i]!, el = mel[i]!;
        const rr = lm[2]! * mapSize;
        el.setAttribute('cx', (CX + lm[0]! * hw * 0.82).toFixed(1));
        el.setAttribute('cy', (CY + lm[1]! * hh * 0.82).toFixed(1));
        el.setAttribute('rx', rr.toFixed(1));
        el.setAttribute('ry', (rr * 0.62).toFixed(1));
      }
    }

    function clampYou(): void {
      const hw = HW * mapSize, hh = HH * mapSize, pad = 12;
      const lox = Math.max(FX, CX - hw) + pad, hix = Math.min(FX2, CX + hw) - pad;
      const loy = Math.max(FY, CY - hh) + pad, hiy = Math.min(FY2, CY + hh) - pad;
      youX = hix > lox ? clamp(youX, lox, hix) : CX;
      youY = hiy > loy ? clamp(youY, loy, hiy) : CY;
    }

    function placePlayer(): void {
      player.setAttribute('transform', `translate(${youX.toFixed(1)} ${youY.toFixed(1)})`);
    }

    function updateCost(): void {
      if (wholeMap) {
        const n = Math.round(40 * mapSize * mapSize);   // cost scales with map AREA
        fill.setAttribute('width', BARW.toFixed(0));      // pegged
        fill.setAttribute('fill', '#ff8a7a');
        costread.textContent = `whole map · cost ×${n} with map size`;
      } else {
        fill.setAttribute('width', (BARW * 0.12).toFixed(1));
        fill.setAttribute('fill', '#6fd7a2');
        fill.setAttribute('opacity', '1');
        costread.textContent = 'ring · cost ≈ constant';
      }
    }

    function setMode(): void {
      ring.style.display = wholeMap ? 'none' : '';
      whole.style.display = wholeMap ? '' : 'none';
      btnAll.classList.toggle('active', wholeMap);
      updateCost();
    }

    function toVB(e: PointerEvent): void {
      const rect = svg.getBoundingClientRect();
      youX = (e.clientX - rect.left) / rect.width * 700;
      youY = (e.clientY - rect.top) / rect.height * 340;
      clampYou(); placePlayer();
    }

    svg.addEventListener('pointerdown', (e: PointerEvent) => {
      dragging = true;
      try { svg.setPointerCapture(e.pointerId); } catch { /* noop */ }
      toVB(e); e.preventDefault();
    });
    svg.addEventListener('pointermove', (e: PointerEvent) => { if (dragging) toVB(e); });
    const end = (e: PointerEvent): void => {
      dragging = false;
      try { svg.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);

    btnAll.addEventListener('click', () => { wholeMap = !wholeMap; setMode(); });
    size.addEventListener('input', () => {
      mapSize = parseFloat(size.value);
      read.textContent = `map ×${mapSize.toFixed(1)}`;
      layoutWorld(); clampYou(); placePlayer(); updateCost();
    });

    layoutWorld(); clampYou(); placePlayer(); setMode();

    return (t: number): void => {
      // ring reads as a live "active area"
      ringline.setAttribute('r', (R + 1.4 * Math.sin(t * 2)).toFixed(1));
      ringline.setAttribute('stroke-opacity', (0.35 + 0.28 * (0.5 + 0.5 * Math.sin(t * 2))).toFixed(2));
      ringglow.setAttribute('r', (R + 4 + 2.5 * Math.sin(t * 2)).toFixed(1));
      if (wholeMap) {
        fill.setAttribute('opacity', (0.72 + 0.28 * (0.5 + 0.5 * Math.sin(t * 6))).toFixed(2));
      } else {
        for (let i = 0; i < N; i++) {                 // shimmer + sway on the ring blades
          const sw = Math.sin(t * 1.7 + bph[i]!) * 1.3;
          const el = bel[i]!;
          el.setAttribute('x2', (bx[i]! + sw).toFixed(1));
          el.setAttribute('opacity', (0.45 + 0.35 * Math.sin(t * 2.2 + bph[i]!)).toFixed(2));
        }
      }
    };
  }

  return { html, mount };
}

function createOneWind(): FoliageToy {
  const html = `
  <div class="ss-interactive" data-ftoy="oneWind">
    <div class="ss-toy-head"><span class="ss-toy-ic">🍃</span>One wind, everything sways
      <span class="ss-toy-hint">drag the gust — or Auto</span></div>
    <svg viewBox="0 0 700 220" class="ss-toysvg" role="img" aria-label="A meadow of grass blades and wildflowers bending together under one shared gust">
      <line x1="24" y1="188.5" x2="676" y2="188.5" stroke="rgba(190,225,240,0.16)" stroke-width="1"/>
      <g data-el="field"></g>
      <g data-el="blooms"></g>
      <g>
        <path d="M624 54 A24 24 0 0 1 672 54" fill="none" stroke="rgba(127,224,205,0.45)" stroke-width="5" stroke-linecap="round"/>
        <path data-el="gfill" d="M624 54 A24 24 0 0 1 672 54" fill="none" stroke="#9ef2df" stroke-width="5" stroke-linecap="round"/>
        <circle data-el="gdot" cx="624" cy="54" r="3.5" fill="#eafff9"/>
        <text class="ss-tc" x="648" y="52" data-el="gnum">0.35</text>
        <text class="ss-sub" x="648" y="70" text-anchor="middle">gust</text>
      </g>
    </svg>
    <div class="ss-daybar">
      <input type="range" class="ss-slider" data-el="gust" min="0" max="1" step="0.01" value="0.35">
      <button class="ss-btn ss-btn-ghost active" data-el="auto">▶ Auto</button>
      <span class="ss-readout" data-el="read">gust 0.35 · one value → grass + petals + wind audio</span>
    </div>
  </div>`;

  function mount(pane: HTMLElement): (t: number) => void {
    const root = pane.querySelector<HTMLElement>('[data-ftoy="oneWind"]')!;
    const field = root.querySelector<SVGGElement>('[data-el="field"]')!;
    const blooms = root.querySelector<SVGGElement>('[data-el="blooms"]')!;
    const gfill = root.querySelector<SVGPathElement>('[data-el="gfill"]')!;
    const gdot = root.querySelector<SVGCircleElement>('[data-el="gdot"]')!;
    const gnum = root.querySelector<SVGTextElement>('[data-el="gnum"]')!;
    const gustSlider = root.querySelector<HTMLInputElement>('[data-el="gust"]')!;
    const autoBtn = root.querySelector<HTMLButtonElement>('[data-el="auto"]')!;
    const read = root.querySelector<HTMLElement>('[data-el="read"]')!;

    const baseY = 188;
    // wind model — mirrors groundSway: dual-frequency sine + a per-index phase so a gust
    // travels across the row as a wave rather than every blade bending in unison.
    const w1 = 1.7, w2 = 0.95, k = 0.55, k2 = 0.34, A = 15, B = 7;
    const gcx = 648, gcy = 54, gr = 24;
    const gaugeLen = Math.PI * gr;
    gfill.setAttribute('stroke-dasharray', gaugeLen.toFixed(2));

    const rgbLerp = (u: number): string => {
      const r = Math.round(lerp(63, 111, u));
      const g = Math.round(lerp(157, 215, u));
      const b = Math.round(lerp(106, 162, u));
      return `rgb(${r},${g},${b})`;
    };

    const N = 22;
    const x0 = 34, x1 = 666;
    const spacing = (x1 - x0) / (N - 1);

    type Blade = { el: SVGPathElement; x: number; h: number; hn: number; iEff: number; cy: number };
    const blades: Blade[] = [];
    let gmk = '';
    for (let i = 0; i < N; i++) {
      const hn = hash2(i, 7, 3);
      const h = 52 + hn * 62;
      const x = x0 + i * spacing + (hash2(i, 19, 5) - 0.5) * 6;
      const col = rgbLerp(hn);
      const sw = (2.4 + hn * 1.8).toFixed(1);
      gmk += `<path data-el="blade" d="M${x.toFixed(1)} ${baseY} Q${x.toFixed(1)} ${(baseY - h * 0.55).toFixed(1)} ${x.toFixed(1)} ${(baseY - h).toFixed(1)}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" opacity="${(0.8 + hn * 0.2).toFixed(2)}"/>`;
      blades.push({ el: null as unknown as SVGPathElement, x, h, hn, iEff: i, cy: baseY - h * 0.55 });
    }
    field.innerHTML = gmk;
    const bladeEls = Array.from(field.querySelectorAll<SVGPathElement>('[data-el="blade"]'));
    for (let i = 0; i < blades.length; i++) blades[i]!.el = bladeEls[i]!;

    type Flower = { stem: SVGPathElement; head: SVGGElement; x: number; h: number; iEff: number; cy: number };
    const fdata: { x: number; h: number; petal: string; center: string }[] = [
      { x: 110, h: 118, petal: '#ff9ac4', center: '#d2b46e' },
      { x: 250, h: 132, petal: '#b9a0ff', center: '#d2b46e' },
      { x: 398, h: 122, petal: '#d2b46e', center: '#eafff9' },
      { x: 545, h: 128, petal: '#ff9ac4', center: '#b9a0ff' },
    ];
    let stemMk = '';
    let headMk = '';
    for (const f of fdata) {
      const ty = baseY - f.h;
      stemMk += `<path data-el="stem" d="M${f.x} ${baseY} Q${f.x} ${(baseY - f.h * 0.55).toFixed(1)} ${f.x} ${ty.toFixed(1)}" fill="none" stroke="rgb(74,150,110)" stroke-width="2.6" stroke-linecap="round"/>`;
      let petals = `<ellipse cx="0" cy="0" rx="12" ry="12" fill="${f.petal}" opacity="0.26"/>`;
      for (let p = 0; p < 6; p++) petals += `<ellipse cx="0" cy="-8" rx="4.6" ry="9" fill="${f.petal}" opacity="0.92" transform="rotate(${p * 60})"/>`;
      petals += `<circle cx="0" cy="0" r="4" fill="${f.center}"/>`;
      headMk += `<g data-el="head" transform="translate(${f.x},${ty.toFixed(1)})">${petals}</g>`;
    }
    blooms.innerHTML = stemMk + headMk;
    const stemEls = Array.from(blooms.querySelectorAll<SVGPathElement>('[data-el="stem"]'));
    const headEls = Array.from(blooms.querySelectorAll<SVGGElement>('[data-el="head"]'));
    const flowers: Flower[] = fdata.map((f, i) => ({
      stem: stemEls[i]!, head: headEls[i]!, x: f.x, h: f.h,
      iEff: (f.x - x0) / spacing, cy: baseY - f.h * 0.55,
    }));

    let base = parseFloat(gustSlider.value);
    let auto = true;
    let shown = -1;
    gustSlider.addEventListener('input', () => { base = parseFloat(gustSlider.value); });
    autoBtn.addEventListener('click', () => { auto = !auto; autoBtn.classList.toggle('active', auto); });

    const bend = (iEff: number, t: number, g: number, hn: number): number =>
      g * (A * Math.sin(t * w1 + iEff * k) + B * Math.sin(t * w2 - iEff * k2)) * (0.5 + hn * 0.6);

    return (t: number): void => {
      let g: number;
      if (auto) {
        // swell envelope: slow compound sine, occasional stronger gusts; slider is the floor.
        const wave = clamp(0.5 + 0.32 * Math.sin(t * 0.5) + 0.18 * Math.sin(t * 0.19 + 1.7) + 0.12 * Math.sin(t * 1.3 + 0.4));
        g = clamp(base + (1 - base) * wave * 0.85);
      } else {
        g = base;
      }
      for (const bl of blades) {
        const b = bend(bl.iEff, t, g, bl.hn);
        const tipX = bl.x + b;
        const tipY = baseY - bl.h + Math.abs(b) * 0.12;
        const cx = bl.x + b * 0.45;
        bl.el.setAttribute('d', `M${bl.x.toFixed(1)} ${baseY} Q${cx.toFixed(1)} ${bl.cy.toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)}`);
      }
      for (const fl of flowers) {
        const b = bend(fl.iEff, t, g, 1);
        const tipX = fl.x + b;
        const tipY = baseY - fl.h + Math.abs(b) * 0.12;
        const cx = fl.x + b * 0.45;
        fl.stem.setAttribute('d', `M${fl.x.toFixed(1)} ${baseY} Q${cx.toFixed(1)} ${fl.cy.toFixed(1)} ${tipX.toFixed(1)} ${tipY.toFixed(1)}`);
        const bob = Math.sin(t * 2.1 + fl.iEff) * 1.6;
        const lean = clamp(b * 0.55, -22, 22);
        fl.head.setAttribute('transform', `translate(${tipX.toFixed(1)},${(tipY + bob).toFixed(1)}) rotate(${lean.toFixed(1)})`);
      }
      gfill.setAttribute('stroke-dashoffset', (gaugeLen * (1 - g)).toFixed(2));
      const th = Math.PI * (1 - g);
      gdot.setAttribute('cx', (gcx + gr * Math.cos(th)).toFixed(1));
      gdot.setAttribute('cy', (gcy - gr * Math.sin(th)).toFixed(1));
      if (Math.abs(g - shown) > 0.005) {
        shown = g;
        gnum.textContent = g.toFixed(2);
        read.textContent = `gust ${g.toFixed(2)} · one value → grass + petals + wind audio`;
      }
    };
  }

  return { html, mount };
}

function createBudgetBars(): FoliageToy {
  const html = `
  <div class="ss-interactive" data-ftoy="budgetBars">
    <div class="ss-toy-head"><span class="ss-toy-ic">⏱️</span>Build the meadow
      <span class="ss-toy-hint">watch the frame line</span></div>
    <svg viewBox="0 0 700 300" class="ss-toysvg" role="img" aria-label="Two lanes comparing a blocking meadow build to one sliced through the frame budget">
      <!-- lane A : old -->
      <text class="ss-lbl" x="8" y="20">old — one blocking build</text>
      <rect x="8" y="28" width="150" height="104" rx="6" fill="rgba(18,40,56,0.6)" stroke="rgba(190,225,240,0.16)"/>
      <text class="ss-sub" x="83" y="126" text-anchor="middle" data-el="progA">0%</text>
      <g data-el="grassA"></g>
      <rect x="182" y="28" width="506" height="104" rx="6" fill="rgba(18,40,56,0.6)" stroke="rgba(190,225,240,0.16)"/>
      <g data-el="barsA"></g>
      <line x1="182" y1="48.8" x2="688" y2="48.8" stroke="rgba(127,224,205,0.45)" stroke-width="1" stroke-dasharray="5 4"/>
      <text class="ss-sub" x="186" y="45" data-el="budA">16 ms · 60 fps budget</text>
      <line x1="182" y1="132" x2="688" y2="132" stroke="rgba(190,225,240,0.16)" stroke-width="1"/>
      <text x="0" y="0" data-el="spikeA" text-anchor="start" font-size="11" font-weight="600" fill="#ff8a7a" opacity="0">452 ms — one frozen frame</text>
      <!-- lane B : new -->
      <text class="ss-lbl" x="8" y="160">new — sliced through the budget</text>
      <rect x="8" y="168" width="150" height="104" rx="6" fill="rgba(18,40,56,0.6)" stroke="rgba(190,225,240,0.16)"/>
      <text class="ss-sub" x="83" y="266" text-anchor="middle" data-el="progB">0%</text>
      <g data-el="grassB"></g>
      <rect x="182" y="168" width="506" height="104" rx="6" fill="rgba(18,40,56,0.6)" stroke="rgba(190,225,240,0.16)"/>
      <g data-el="barsB"></g>
      <line x1="182" y1="188.8" x2="688" y2="188.8" stroke="rgba(127,224,205,0.45)" stroke-width="1" stroke-dasharray="5 4"/>
      <text class="ss-sub" x="186" y="185" data-el="budB">16 ms · 60 fps budget</text>
      <line x1="182" y1="272" x2="688" y2="272" stroke="rgba(190,225,240,0.16)" stroke-width="1"/>
      <text class="ss-lbl" x="688" y="182" text-anchor="end" data-el="noteB" opacity="0">sliced ~0.8 ms / frame</text>
    </svg>
    <div class="ss-toy-actions">
      <button class="ss-btn ss-btn-primary" data-el="run">▶ Build the meadow</button>
      <button class="ss-btn ss-btn-ghost" data-el="reset">Reset</button>
      <span class="ss-readout" data-el="read">idle — a game running smoothly</span>
    </div>
  </div>`;

  function mount(pane: HTMLElement): (t: number) => void {
    const root = pane.querySelector<HTMLElement>('[data-ftoy="budgetBars"]')!;
    const SVGNS = 'http://www.w3.org/2000/svg';
    const make = <T extends SVGElement>(name: string): T => document.createElementNS(SVGNS, name) as T;

    // --- constants ---
    const N = 42;                 // bars per graph
    const G = 46;                 // grass dots per meadow
    const FPS = 10;               // animation frames/sec
    const HITCH = 6;              // frame the old build blows up
    const BUILD = 40;             // frames the sliced build takes
    const MAXMS = 20;             // top of the graph in ms
    const GX = 182, GW = 506, GH = 104;
    const SLOT = GW / N, BARW = 8;
    const GREEN = '#6fd7a2', RED = '#ff8a7a', GOLD = '#d2b46e';

    interface Lane {
      kind: 'old' | 'new';
      salt: number;
      yBase: number;   // baseline (bottom of graph)
      top: number;     // top of the lane region (for the overflow spike)
      mx: number; my: number; mw: number; mh: number;
      bars: SVGRectElement[];
      grass: SVGCircleElement[];
      prog: SVGTextElement;
      lastReveal: number;
    }

    const buildLane = (kind: 'old' | 'new', salt: number, yBase: number, top: number,
                       barsSel: string, grassSel: string, progSel: string, my: number): Lane => {
      const barsG = root.querySelector<SVGGElement>(barsSel)!;
      const grassG = root.querySelector<SVGGElement>(grassSel)!;
      const prog = root.querySelector<SVGTextElement>(progSel)!;
      const mx = 8, mw = 150, mh = 104;
      const bars: SVGRectElement[] = [];
      for (let i = 0; i < N; i++) {
        const r = make<SVGRectElement>('rect');
        r.setAttribute('x', String(GX + i * SLOT + (SLOT - BARW) / 2));
        r.setAttribute('width', String(BARW));
        r.setAttribute('rx', '1.5');
        r.setAttribute('y', String(yBase));
        r.setAttribute('height', '0');
        r.setAttribute('fill', GREEN);
        r.setAttribute('opacity', '0.9');
        barsG.appendChild(r);
        bars.push(r);
      }
      const grass: SVGCircleElement[] = [];
      for (let k = 0; k < G; k++) {
        const c = make<SVGCircleElement>('circle');
        const cx = mx + 9 + hash2(k, salt, 11) * (mw - 18);
        const cy = my + 11 + hash2(k, salt, 23) * (mh - 22);
        c.setAttribute('cx', String(cx));
        c.setAttribute('cy', String(cy));
        c.setAttribute('r', String(1.7 + hash2(k, salt, 41) * 1.2));
        c.setAttribute('fill', hash2(k, salt, 31) < 0.16 ? GOLD : GREEN);
        c.setAttribute('opacity', '0');
        grassG.appendChild(c);
        grass.push(c);
      }
      return { kind, salt, yBase, top, mx, my, mw, mh, bars, grass, prog, lastReveal: -1 };
    };

    const laneA = buildLane('old', 101, 132, 14, '[data-el="barsA"]', '[data-el="grassA"]', '[data-el="progA"]', 28);
    const laneB = buildLane('new', 202, 272, 154, '[data-el="barsB"]', '[data-el="grassB"]', '[data-el="progB"]', 168);

    const spikeA = root.querySelector<SVGTextElement>('[data-el="spikeA"]')!;
    const noteB = root.querySelector<SVGTextElement>('[data-el="noteB"]')!;
    const read = root.querySelector<HTMLElement>('[data-el="read"]')!;
    const runBtn = root.querySelector<HTMLButtonElement>('[data-el="run"]')!;
    const resetBtn = root.querySelector<HTMLButtonElement>('[data-el="reset"]')!;

    // --- state ---
    let runStart: number | null = null; // global frame the build was launched
    let lastG = 0;
    let lastRead = '';

    runBtn.addEventListener('click', () => { runStart = lastG; });
    resetBtn.addEventListener('click', () => { runStart = null; });

    // ms cost for a lane at an absolute frame index
    const costOf = (lane: Lane, gi: number): { ms: number; spike: boolean } => {
      const idle = 4.6 + 1.9 * hash2(gi, lane.salt, 7);
      if (runStart === null || gi < runStart) return { ms: idle, spike: false };
      const rel = gi - runStart;
      if (lane.kind === 'old') {
        if (rel === HITCH) return { ms: 452, spike: true };
        return { ms: idle, spike: false };
      }
      if (rel >= 0 && rel <= BUILD) return { ms: idle + 0.9, spike: false };
      return { ms: idle, spike: false };
    };

    const drawLane = (lane: Lane, g: number): void => {
      for (let i = 0; i < N; i++) {
        const gi = g - (N - 1 - i);
        const c = costOf(lane, gi);
        const bar = lane.bars[i];
        if (c.spike) {
          bar.setAttribute('y', String(lane.top));
          bar.setAttribute('height', String(lane.yBase - lane.top));
          bar.setAttribute('fill', RED);
        } else {
          const hpx = clamp(c.ms / MAXMS) * GH;
          bar.setAttribute('y', String(lane.yBase - hpx));
          bar.setAttribute('height', String(hpx));
          bar.setAttribute('fill', c.ms >= 16 ? RED : GREEN);
        }
      }
      // meadow fill
      const rel = runStart === null ? null : g - runStart;
      let prog = 0;
      if (rel !== null) prog = lane.kind === 'old' ? (rel >= HITCH ? 1 : 0) : clamp(rel / BUILD);
      const reveal = Math.round(prog * G);
      if (reveal !== lane.lastReveal) {
        for (let k = 0; k < G; k++) lane.grass[k].setAttribute('opacity', k < reveal ? '0.95' : '0');
        lane.prog.textContent = `${Math.round(prog * 100)}%`;
        lane.lastReveal = reveal;
      }
    };

    return (t: number) => {
      const g = Math.floor(t * FPS);
      lastG = g;
      drawLane(laneA, g);
      drawLane(laneB, g);

      // old-lane spike label follows the giant bar as it scrolls left
      if (runStart !== null) {
        const hitchGi = runStart + HITCH;
        const i = N - 1 - (g - hitchGi);
        if (i >= 0 && i < N) {
          const x = GX + i * SLOT + SLOT / 2;
          const anchorEnd = x > 540;
          spikeA.setAttribute('x', String(anchorEnd ? x - 6 : x + 6));
          spikeA.setAttribute('y', String(laneA.top + 11));
          spikeA.setAttribute('text-anchor', anchorEnd ? 'end' : 'start');
          spikeA.setAttribute('opacity', '1');
        } else {
          spikeA.setAttribute('opacity', '0');
        }
      } else {
        spikeA.setAttribute('opacity', '0');
      }

      // new-lane note while it fills
      const relNew = runStart === null ? null : g - runStart;
      noteB.setAttribute('opacity', relNew !== null && relNew >= 0 && relNew <= BUILD ? '1' : '0');

      // readout
      let txt: string;
      if (runStart === null) txt = 'idle — a game running smoothly';
      else if (relNew !== null && relNew <= BUILD) txt = 'old: 1 frame, 452 ms — dropped  ·  new: 40 frames, ~0.8 ms each';
      else txt = 'same meadow — one froze a frame, one didn’t';
      if (txt !== lastRead) { read.textContent = txt; lastRead = txt; }
    };
  }

  return { html, mount };
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
    <p>Nobody modelled these trees. They're <em>grown</em> — the way you'd grow a real one — from a seed and
    a handful of rules, an approach this project grew out of and still calls <strong>SeedThree</strong>:
    hand it a species, a random seed and a spot, and it sprouts a trunk, splits it into branches by a
    stochastic branching rule, and hangs a canopy of leaf cards on the twigs. It's the oldest idea in
    procedural nature — Lindenmayer described plants as simple rewriting rules (L-systems) back in the late
    1960s, and the space-colonization algorithm later grew believable branches by letting them compete for
    light and air — and it's exactly the right idea for a city that needs a forest's worth of trees with no
    artist modelling each one. Change the seed and you get a different tree of the same species; change the
    rules and you get a different species. A whole wood falls out of a little grammar and a lot of seeds.</p>
    <p>Grass and flowers follow the same philosophy from a different starting point — a blade is grown as a
    curved ribbon, a bloom as a stack of curved petals — and everything is placed deterministically, seeded
    from the ground itself, so the planting is identical for every player and free to throw away and regrow
    on demand. Everything below is what it takes to make a <em>generated</em> living layer this dense hold a
    steady frame.</p>
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
    <p>There's a second, quieter tell to a distant tree. Those simplified crowns are really a handful of
    crossed leaf cards, and a flat card lit off its own facing normal shades like cardboard — one side
    catches the sun, the other falls dead black. So the far and horizon crowns now borrow a trick from
    <a href="https://github.com/SkyeShark/SeedThree" target="_blank" rel="noopener noreferrer">SeedThree</a>
    (and SpeedTree before it) called <strong>dome-normal shading</strong>: each leaf is lit not by the card
    it sits on but as if it were a point on a sphere wrapped around the canopy's centre, tilted a little
    toward the sky. The same normal lights both faces, so nothing blacks out, and a stand on a far hillside
    reads as rounded, sunlit masses instead of flat green stamps — for a few extra maths ops and not one
    extra triangle.</p>
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
    it instantly as fake. So placement here borrows an idea from <a href="https://github.com/momentchan"
    target="_blank" rel="noopener noreferrer">momentchan</a>'s generative piece <em>False&nbsp;Earth</em>:
    <strong>Voronoi clustering</strong>. Every point on the ground asks
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
    <p>The look owes the same debt. Chasing the luminous, lit-from-within roses of that same
    <em>False&nbsp;Earth</em> is why the hero blooms glow rather than merely being coloured — light bleeds
    <em>through</em> the petals the way it does in a real flower held up to the sun. It's a small thing, one
    material on the handful of flowers nearest you, but it's the whole difference between a field of stickers
    and a field that looks like it's catching the light.</p>
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
    <p>That shared wind recently gained a twist. Close to you the bend <em>direction</em> no longer points
    the one identical way; it follows a <strong>curl-noise flow field</strong> — the curl of a slowly
    scrolling noise, which is divergence-free by construction, so the meadow swirls in gusting arcs and
    eddies with no tell-tale "everything sucking toward a point". It's still one field, still the same gust
    magnitude you hear, still a single extra noise tap on the near blades only — just a wind with a little
    weather in it instead of a flag-day breeze.</p>
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
    <p>The most recent pass went back to
    <a href="https://github.com/SkyeShark/SeedThree" target="_blank" rel="noopener noreferrer">SeedThree</a>
    itself — the library these trees descend from — to see what it does <em>now</em>, and brought home three
    ideas that raise quality without costing a frame. Distant crowns got the <strong>dome-normal shading</strong>
    above, so far stands finally read as volumes rather than cardboard. The one shared wind became a
    <strong>curl-noise flow field</strong>, so meadows swirl instead of leaning. And the placement jitter under
    the grass and flowers was swapped from a plain hash to a low-discrepancy <strong>R2 (plastic-ratio)
    sequence</strong> — the same in-cell budget, but with about a quarter as many near-touching clumps, so a
    meadow spaces itself the even-yet-random way a real one does. All three are additive and free at the
    triangle level; the only thing they cost was the thinking.</p>
  </section>

  <!-- WEB-DEPENDENT: future improvements to try next pass -->
  <section>
    <h3><span class="bts-ic">🔭</span> Next pass — ideas worth trying</h3>
    <p>None of this is finished; it's just where the trade-offs currently sit. The last pass pulled three of
    these threads all the way through — the dome normals, the wind flow field and blue-noise placement, all
    described above. Here are the ones still worth pulling: a mix of well-worn graphics techniques this
    project doesn't yet use and small experiments that fit its WebGPU-only, compute-friendly grain.</p>
    <div>
      <p><strong>Octahedral impostors for the far tier.</strong> Instead of a flat card, bake each tree
      into a small atlas of views from every angle and blend between them at runtime — a billboard that
      keeps a convincing 3-D silhouette as you circle it, so distant trees stop looking like the cutouts
      they are. A clean WebGPU fit: it's one textured quad sampling an atlas in the fragment shader.</p>
      <p><strong>Move the culling onto the GPU.</strong> Today the CPU decides which chunks and instances
      to draw. A compute pass could frustum- and occlusion-cull every instance and build the draw list
      itself, submitted in a single indirect draw. WebGPU has all the pieces — compute, storage buffers,
      indirect draw — and this is probably the biggest chunk of headroom still on the table.</p>
      <p><strong>Grow the grass on the GPU too.</strong> The blades are sliced across frames but still
      sampled and placed on the CPU. A compute shader could generate the whole ring from a density field
      straight into a buffer each frame — the Ghost of Tsushima / Acerola approach — so the streaming build
      barely touches the main thread at all.</p>
      <p><strong>Drive density from a clipmap.</strong> The terrain is already a camera-following clipmap;
      foliage could ride the same structure — a texture that says how much grass, which species, how tall —
      turning placement into a texture lookup and turning authored gardens into something you paint rather
      than code.</p>
      <p><strong>The one we deliberately did <em>not</em> do: dither the LOD swaps.</strong> A screen-door
      blend between two tiers is the obvious way to hide a single tree's pop — but this world's whole
      grass-and-tree LOD design is built to avoid exactly the crawling, shimmering dither pattern a moving
      camera exposes. A temporal cross-fade would fight the thing it's meant to help, so it's left here as a
      road not taken, on purpose.</p>
      <p><strong>And eventually, continuous LOD.</strong> Unreal's Nanite treats geometry as streamable
      micro-clusters with no discrete levels at all. A full version isn't a browser thing yet, but the
      direction — seamless, continuous detail instead of four steps and a clever way to hide the seams
      between them — is where this whole LOD story quietly wants to end up.</p>
    </div>
    <p class="bts-aside">If you try any of these, the honest test is the same one the whole pass was judged
    by: does it add density or reach or smoothness <em>without</em> costing a frame — measured on an
    ordinary laptop, walking, driving and flying, not just standing still?</p>
  </section>

  <section class="bts-colophon">
    <h3><span class="bts-ic">🔗</span> Lineage &amp; credits</h3>
    <p>Every blade, leaf and petal here is grown from rules and numbers, drawn on WebGPU through three.js,
    and placed so the whole living layer costs about what you can see and no more. It stands on a lot of
    other people's ideas: Lindenmayer's L-systems and the space-colonization algorithm behind procedural
    trees; momentchan's <em>False&nbsp;Earth</em> for the Voronoi clustering and the luminous roses; and the
    SeedThree seed-grown foliage this world's greenery descends from. If any of it made you want to grow
    your own, that was the whole point.</p>
    <div class="bts-chips">
      <a href="https://threejs.org/" target="_blank" rel="noopener noreferrer">three.js</a>
      <a href="https://github.com/momentchan" target="_blank" rel="noopener noreferrer">momentchan · False Earth</a>
      <a href="https://en.wikipedia.org/wiki/L-system" target="_blank" rel="noopener noreferrer">L-systems</a>
      <a href="https://github.com/ericrius1/SanFrancisco" target="_blank" rel="noopener noreferrer">This project on GitHub</a>
    </div>
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
