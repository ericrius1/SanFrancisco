/**
 * "The soundscape" tab of the Behind-the-scenes panel: a long, unhurried read
 * about the procedural nature-audio engine (src/audio), threaded with animated
 * SVG diagrams and — the fun part — a few things you can actually poke.
 *
 * Three kinds of graphic live here:
 *   • scroll-driven "scrollies" — a graphic pinned beside its captions that
 *     advances through stages as you scroll, then releases and lets you read on;
 *   • idle animations — the day diagram, breathing on its own;
 *   • interactive toys — a synthesis explorer and a build-a-bird playground that
 *     both make real sound through a small Web Audio context.
 *
 * This module owns the tab's inner HTML plus a controller that maps scroll
 * position → diagram stage, runs one gentle rAF while the tab is open, and wires
 * the clickable toys to a lazily-created AudioContext (closed when you leave the
 * tab, so it never sits on one of the browser's scarce audio slots).
 */

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Sample a per-stage value array at a continuous position f (0..len-1). */
function atStage(vals: number[], f: number): number {
  const i = clamp(Math.floor(f), 0, vals.length - 1);
  const j = clamp(i + 1, 0, vals.length - 1);
  return lerp(vals[i], vals[j], clamp(f - i));
}

/* ============================================================ tiny DSP toys */
// A self-contained sound kitchen for the interactive diagrams. Everything is
// synthesised into a Float32 buffer on click, then handed to Web Audio — so the
// waveform you see drawn is the exact one you hear. Mirrors, in miniature, what
// the real engine (src/audio) does a few milliseconds before every bird call.

const SR = 32000; // synth sample rate; the AudioContext resamples to its own

/** mulberry32 — a tiny seedable RNG, so toggling a feature keeps the same bird. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const tri = (ph: number) => {
  const p = ph - Math.floor(ph);
  return 2 * Math.abs(2 * p - 1) - 1;
};
const clampN = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));

type BirdBoolKey = "glide" | "vibrato" | "envelope" | "harmonic" | "echo";
type BirdOpts = { notes: number } & Record<BirdBoolKey, boolean>;
type Clip = { L: Float32Array; R: Float32Array; total: number };

/** Build one bird phrase (and, if asked, an answer) into a stereo buffer. */
function synthBird(o: BirdOpts, seed: number): Clip {
  const r = rng(seed);
  const noteDur = 0.13;
  const gap = 0.055;
  const phrase = o.notes * (noteDur + gap);
  const answerAt = phrase + 0.2;
  const total = (o.echo ? answerAt + phrase : phrase) + 0.16;
  const N = Math.ceil(total * SR);
  const L = new Float32Array(N);
  const R = new Float32Array(N);

  const voice = (startT: number, panPos: number, gainMul: number, rr: () => number) => {
    let f = 2200 * (0.7 + rr() * 0.7);
    const ang = (panPos * 0.5 + 0.5) * (Math.PI / 2); // equal-power pan
    const gl = Math.cos(ang);
    const gr = Math.sin(ang);
    for (let i = 0; i < o.notes; i++) {
      const nf = clampN(f * (1 + (rr() - 0.5) * 0.5), 900, 4800); // random walk
      const bendA = o.glide ? 0.82 + rr() * 0.15 : 1;
      const bendB = o.glide ? 1.05 + rr() * 0.35 : 1;
      const s0 = Math.floor((startT + i * (noteDur + gap)) * SR);
      const sn = Math.floor(noteDur * SR);
      let ph = 0;
      for (let s = 0; s < sn; s++) {
        const u = s / sn;
        let inst = nf * (o.glide ? bendA + (bendB - bendA) * u : 1);
        if (o.vibrato) inst *= 1 + 0.05 * Math.sin(2 * Math.PI * 19 * (s / SR));
        ph += inst / SR;
        let v = tri(ph);
        if (o.harmonic) v += 0.32 * Math.sin(2 * Math.PI * 2 * ph); // second, higher voice
        const env = o.envelope ? Math.min(1, u * 12) * Math.pow(1 - u, 1.5) : Math.sin(Math.PI * u);
        v *= env * 0.5 * gainMul;
        const idx = s0 + s;
        if (idx >= N) break;
        L[idx] += v * gl;
        R[idx] += v * gr;
      }
      f = nf;
    }
  };

  const pan = r() * 1.2 - 0.6;
  voice(0.02, pan, 0.95, r);
  if (o.echo) voice(answerAt, -pan, 0.5, rng((seed ^ 0x9e3779b9) >>> 0));
  return { L, R, total };
}

type MonoClip = { samples: Float32Array; total: number };

/** Demo of one classic synthesis method, ~1s, mono. */
function synthMethod(kind: string): MonoClip {
  const dur = kind === "physical" ? 1.2 : kind === "subtractive" ? 1.1 : 1.0;
  const N = Math.ceil(dur * SR);
  const y = new Float32Array(N);
  if (kind === "additive") {
    const f = 196;
    const parts = [1, 2, 3, 4, 5, 6];
    for (let n = 0; n < N; n++) {
      const t = n / SR;
      let v = 0;
      for (const k of parts) v += Math.sin(2 * Math.PI * f * k * t) / k;
      y[n] = v * 0.28 * Math.min(1, t * 8) * Math.pow(1 - t / dur, 1.2);
    }
  } else if (kind === "subtractive") {
    let lp = 0;
    for (let n = 0; n < N; n++) {
      const t = n / SR;
      const noise = Math.random() * 2 - 1;
      const cut = 0.03 + 0.34 * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / dur)); // filter sweep
      lp += cut * (noise - lp);
      y[n] = lp * 1.6 * Math.min(1, t * 6) * Math.min(1, (dur - t) * 6);
    }
  } else if (kind === "fm") {
    const fc = 440;
    const fm = fc * 1.41; // inharmonic ratio → bell-like
    for (let n = 0; n < N; n++) {
      const t = n / SR;
      const I = 6 * Math.pow(1 - t / dur, 2); // modulation index decays
      const v = Math.sin(2 * Math.PI * fc * t + I * Math.sin(2 * Math.PI * fm * t));
      y[n] = v * 0.32 * Math.min(1, t * 80) * Math.pow(1 - t / dur, 1.4);
    }
  } else {
    // Karplus–Strong: a burst of noise recirculated through a short delay
    const f = 174;
    const Ln = Math.max(2, Math.round(SR / f));
    const buf = new Float32Array(Ln);
    for (let i = 0; i < Ln; i++) buf[i] = Math.random() * 2 - 1;
    let idx = 0;
    for (let n = 0; n < N; n++) {
      const cur = buf[idx];
      buf[idx] = 0.5 * (cur + buf[(idx + 1) % Ln]) * 0.996; // lowpass + slight decay
      y[n] = cur * 0.5;
      idx = (idx + 1) % Ln;
    }
    for (let i = 0; i < 240; i++) y[N - 1 - i] *= i / 240; // clean tail
  }
  return { samples: y, total: dur };
}

/** Trace a waveform buffer into an SVG path across [x0,x1] around a midline. */
function wavePath(samples: Float32Array, x0: number, x1: number, mid: number, amp: number, n = 300): string {
  let d = "";
  const step = samples.length / n;
  for (let i = 0; i <= n; i++) {
    const s = samples[Math.min(samples.length - 1, Math.floor(i * step))];
    const x = x0 + (x1 - x0) * (i / n);
    const y = mid - clampN(s, -1.4, 1.4) * amp;
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  }
  return d.trim();
}

/* ------------------------------------------------------------ audio output */
// One lazily-created context, resumed on the first click (autoplay policy),
// closed when the tab is left so it doesn't hold a scarce browser audio slot.

let actx: AudioContext | null = null;
function audioCtx(): AudioContext {
  if (!actx || actx.state === "closed") {
    actx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  }
  if (actx.state === "suspended") void actx.resume();
  return actx;
}
function playChannels(chs: Float32Array[]): void {
  const ctx = audioCtx();
  const buf = ctx.createBuffer(chs.length, chs[0].length, SR);
  for (let c = 0; c < chs.length; c++) buf.copyToChannel(chs[c] as Float32Array<ArrayBuffer>, c);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = 0.85;
  src.connect(g).connect(ctx.destination);
  src.start();
}

/* --------------------------------------------------------------- diagrams */
// Hand-drawn SVGs. Element ids are the contract with the painters below; the
// painters only ever set opacity / a few attributes, never rebuild structure.

/** Shared defs — soft glows + gradients — inlined once per diagram that wants them. */
const GLOW_DEFS = `
  <defs>
    <linearGradient id="ss-panel" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="rgba(22,52,72,0.65)"/>
      <stop offset="1" stop-color="rgba(12,30,44,0.65)"/>
    </linearGradient>
    <radialGradient id="ss-node" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0" stop-color="#d6fff4"/>
      <stop offset="1" stop-color="#5bbfa9"/>
    </radialGradient>
    <filter id="ss-glow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2.2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>`;

const DIAGRAM_ARCH = `
  <svg viewBox="0 0 820 320" class="ss-svg" role="img" aria-label="From regions to the audio bus">
    ${GLOW_DEFS}
    <g id="ss-map">
      <rect x="24" y="40" width="212" height="244" rx="20" fill="url(#ss-panel)" stroke="rgba(127,224,205,0.35)"/>
      <ellipse cx="92" cy="92" rx="48" ry="27" fill="rgba(196,164,96,0.20)" stroke="rgba(210,180,110,0.5)"/>
      <ellipse cx="152" cy="152" rx="42" ry="25" fill="rgba(111,215,196,0.14)" stroke="rgba(111,215,196,0.5)"/>
      <ellipse cx="112" cy="228" rx="60" ry="32" fill="rgba(111,215,196,0.16)" stroke="rgba(111,215,196,0.5)"/>
      <ellipse cx="120" cy="228" rx="21" ry="14" fill="rgba(158,242,223,0.24)" stroke="rgba(158,242,223,0.7)"/>
      <text x="92" y="94" class="ss-t ss-tc">Marin</text>
      <text x="152" y="154" class="ss-t ss-tc">Presidio</text>
      <text x="88" y="248" class="ss-t ss-tc">GG&nbsp;Park</text>
      <text x="130" y="205" class="ss-t ss-tc" style="font-size:8px">garden</text>
    </g>
    <circle id="ss-ring" cx="210" cy="250" r="8" fill="none" stroke="rgba(158,242,223,0.7)" stroke-width="1.4"/>
    <circle id="ss-you" cx="210" cy="250" r="5" fill="#8fa9b6"/>

    <g id="ss-arrows" opacity="0" stroke="rgba(127,224,205,0.45)" stroke-width="1.4" fill="none">
      <path d="M250 160 C275 160 280 88 300 88"/>
      <path d="M250 160 L300 160"/>
      <path d="M250 160 C275 160 280 232 300 232"/>
      <path d="M552 88 C575 88 575 160 588 160"/>
      <path d="M552 160 L588 160"/>
      <path d="M552 232 C575 232 575 160 588 160"/>
    </g>

    <g id="ss-beds" opacity="0">
      <rect x="300" y="60" width="252" height="56" rx="10" fill="url(#ss-panel)" stroke="rgba(127,224,205,0.3)"/>
      <text x="312" y="52" class="ss-t ss-lbl">sampled beds</text>
      <rect id="ss-bed0" x="322" y="72" width="20" height="24" rx="3" fill="rgba(127,224,205,0.7)"/>
      <rect id="ss-bed1" x="360" y="72" width="20" height="24" rx="3" fill="rgba(127,224,205,0.7)"/>
      <rect id="ss-bed2" x="398" y="72" width="20" height="24" rx="3" fill="rgba(127,224,205,0.7)"/>
      <rect id="ss-bed3" x="436" y="72" width="20" height="24" rx="3" fill="rgba(127,224,205,0.7)"/>
      <text x="490" y="94" class="ss-t ss-sub">×4 shared</text>
    </g>

    <g id="ss-wind" opacity="0">
      <rect x="300" y="138" width="252" height="46" rx="10" fill="url(#ss-panel)" stroke="rgba(127,224,205,0.3)"/>
      <text x="312" y="132" class="ss-t ss-lbl">wind synth</text>
      <path d="M322 161 q10 -14 20 0 t20 0 t20 0 t20 0 t20 0 t20 0 t20 0" fill="none" stroke="rgba(158,242,223,0.8)" stroke-width="1.6"/>
      <text x="500" y="165" class="ss-t ss-sub">gust-locked</text>
    </g>

    <g id="ss-voices" opacity="0">
      <rect x="300" y="206" width="252" height="56" rx="10" fill="url(#ss-panel)" stroke="rgba(127,224,205,0.3)"/>
      <text x="312" y="200" class="ss-t ss-lbl">procedural calls</text>
      <circle id="ss-spark0" cx="430" cy="232" r="3" fill="#9ef2df"/>
      <circle id="ss-spark1" cx="430" cy="232" r="3" fill="#9ef2df"/>
      <circle id="ss-spark2" cx="430" cy="232" r="3" fill="#9ef2df"/>
      <circle id="ss-spark3" cx="430" cy="232" r="3" fill="#9ef2df"/>
      <text x="500" y="236" class="ss-t ss-sub">spatial</text>
    </g>

    <g id="ss-chain" opacity="0">
      <circle cx="588" cy="160" r="10" fill="rgba(20,46,64,0.8)" stroke="rgba(127,224,205,0.5)"/>
      <text x="588" y="163" class="ss-t ss-tc" style="font-size:8px">mix</text>
      <line x1="598" y1="160" x2="620" y2="160" stroke="rgba(127,224,205,0.5)" stroke-width="1.4"/>
      <rect x="620" y="146" width="46" height="28" rx="6" fill="rgba(18,40,56,0.7)" stroke="rgba(127,224,205,0.4)"/>
      <text x="643" y="163" class="ss-t ss-tc" style="font-size:8px">bus</text>
      <line x1="666" y1="160" x2="688" y2="160" stroke="rgba(127,224,205,0.5)" stroke-width="1.4"/>
      <rect x="688" y="146" width="52" height="28" rx="6" fill="rgba(18,40,56,0.7)" stroke="rgba(127,224,205,0.4)"/>
      <text x="714" y="163" class="ss-t ss-tc" style="font-size:8px">limiter</text>
      <path d="M760 150 l14 -8 v36 l-14 -8 z" fill="rgba(158,242,223,0.5)"/>
      <path d="M780 150 q8 10 0 20" fill="none" stroke="rgba(158,242,223,0.7)" stroke-width="1.4"/>
      <path id="ss-reverb" d="M588 150 C588 120 700 120 700 146" fill="none" stroke="rgba(127,224,205,0.35)" stroke-width="1.2" stroke-dasharray="3 4"/>
      <text x="628" y="118" class="ss-t ss-sub">reverb send</text>
      <circle id="ss-pulse" cx="600" cy="160" r="3.4" fill="#eafff9" opacity="0"/>
    </g>
  </svg>`;

const DIAGRAM_SONG = `
  <svg viewBox="0 0 820 300" class="ss-svg" role="img" aria-label="Building one bird call">
    ${GLOW_DEFS}
    <g id="ss-graph">
      <line x1="60" y1="150" x2="600" y2="150" stroke="rgba(190,225,240,0.18)" stroke-width="1"/>
      <path id="ss-env" d="M60 150 C120 60 160 70 200 150 C240 210 300 150 320 150" fill="none" stroke="rgba(127,224,205,0.4)" stroke-width="1.3" stroke-dasharray="4 4" opacity="0"/>
      <path id="ss-pitch" d="M60 120 q135 -30 270 -6 t270 4" fill="none" stroke="rgba(158,242,223,0.5)" stroke-width="1.2" stroke-dasharray="2 4" opacity="0"/>
      <path id="ss-wave" d="M60 150 L600 150" fill="none" stroke="#9ef2df" stroke-width="1.8" filter="url(#ss-glow)"/>
      <g>
        <rect id="ss-note0" x="150" y="118" width="26" height="10" rx="3" fill="rgba(158,242,223,0.75)" opacity="0"/>
        <rect id="ss-note1" x="230" y="96" width="26" height="10" rx="3" fill="rgba(158,242,223,0.75)" opacity="0"/>
        <rect id="ss-note2" x="315" y="132" width="26" height="10" rx="3" fill="rgba(158,242,223,0.75)" opacity="0"/>
        <rect id="ss-note3" x="405" y="104" width="26" height="10" rx="3" fill="rgba(158,242,223,0.75)" opacity="0"/>
        <rect id="ss-note4" x="490" y="150" width="26" height="10" rx="3" fill="rgba(158,242,223,0.75)" opacity="0"/>
      </g>
      <text x="60" y="205" class="ss-t ss-sub">oscillator → glide → envelope → phrase</text>
    </g>
    <g id="ss-plan" opacity="0">
      <circle cx="410" cy="150" r="96" fill="none" stroke="rgba(190,225,240,0.14)"/>
      <circle cx="410" cy="150" r="60" fill="none" stroke="rgba(190,225,240,0.12)"/>
      <circle cx="410" cy="150" r="28" fill="none" stroke="rgba(190,225,240,0.12)"/>
      <circle cx="410" cy="150" r="7" fill="url(#ss-node)"/>
      <text x="410" y="172" class="ss-t ss-tc" style="font-size:9px">you</text>
      <path id="ss-answerarc" d="M470 120 Q410 90 350 128" fill="none" stroke="rgba(158,242,223,0.35)" stroke-width="1.2" stroke-dasharray="3 4"/>
      <circle id="ss-caller" cx="486" cy="120" r="5" fill="#9ef2df" filter="url(#ss-glow)"/>
      <circle id="ss-answer" cx="338" cy="128" r="4.5" fill="#7fe0cd" opacity="0" filter="url(#ss-glow)"/>
      <text x="410" y="270" class="ss-t ss-sub">placed in 3-D around you — and sometimes answered</text>
    </g>
  </svg>`;

const DIAGRAM_DAY = `
  <svg viewBox="0 0 820 270" class="ss-svg" role="img" aria-label="Call density across a day">
    <defs>
      <linearGradient id="ss-skyg" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0" stop-color="rgba(255,214,140,0.5)"/>
        <stop offset="1" stop-color="rgba(255,214,140,0)"/>
      </linearGradient>
      <radialGradient id="ss-sung" cx="0.5" cy="0.5" r="0.5">
        <stop offset="0" stop-color="#fff0c8"/>
        <stop offset="1" stop-color="rgba(255,214,140,0.7)"/>
      </radialGradient>
    </defs>
    <rect id="ss-daywash" x="0" y="0" width="820" height="210" fill="url(#ss-skyg)" opacity="0"/>
    <line x1="60" y1="200" x2="760" y2="200" stroke="rgba(190,225,240,0.18)"/>
    <path id="ss-daycurvefill" d="" fill="rgba(111,215,196,0.10)" stroke="none"/>
    <path d="${dayCurvePath()}" fill="none" stroke="rgba(127,224,205,0.55)" stroke-width="2"/>
    <line id="ss-now" x1="60" y1="70" x2="60" y2="210" stroke="rgba(158,242,223,0.5)" stroke-width="1.2" stroke-dasharray="3 4"/>
    <circle id="ss-nowdot" cx="60" cy="200" r="4" fill="#eafff9" filter="url(#ss-glow)"/>
    <circle id="ss-sun" cx="60" cy="150" r="10" fill="url(#ss-sung)"/>
    <circle id="ss-moon" cx="400" cy="90" r="8" fill="rgba(200,224,240,0.9)"/>
    <text x="115" y="228" class="ss-t ss-sub">dawn chorus</text>
    <text x="360" y="228" class="ss-t ss-sub">midday</text>
    <text x="560" y="228" class="ss-t ss-sub">dusk</text>
    <text x="690" y="228" class="ss-t ss-sub">night</text>
    <rect id="ss-birds" x="688" y="210" width="18" height="40" rx="3" fill="rgba(158,242,223,0.75)"/>
    <rect id="ss-crickets" x="722" y="210" width="18" height="40" rx="3" fill="rgba(196,164,96,0.7)"/>
    <text x="676" y="264" class="ss-t ss-sub" style="font-size:8px">birds</text>
    <text x="712" y="264" class="ss-t ss-sub" style="font-size:8px">crickets</text>
  </svg>`;

// Interactive #1 — the four classic ways to make a note. Click a tab, hear it.
const DIAGRAM_METHODS = `
  <svg viewBox="0 0 700 130" class="ss-toysvg" role="img" aria-label="Waveform of the selected synthesis method">
    ${GLOW_DEFS}
    <line x1="20" y1="65" x2="680" y2="65" stroke="rgba(190,225,240,0.14)" stroke-width="1"/>
    <path id="mt-wave" d="M20 65 L680 65" fill="none" stroke="#9ef2df" stroke-width="1.7" filter="url(#ss-glow)"/>
    <line id="mt-head" x1="20" y1="14" x2="20" y2="116" stroke="rgba(234,255,249,0.6)" stroke-width="1.2" opacity="0"/>
  </svg>`;

// Interactive #2 — build-a-bird playground. Toggle features, then hear it.
const DIAGRAM_BIRD = `
  <svg viewBox="0 0 700 170" class="ss-toysvg" role="img" aria-label="Waveform of your bird call">
    ${GLOW_DEFS}
    <line x1="20" y1="85" x2="680" y2="85" stroke="rgba(190,225,240,0.14)" stroke-width="1"/>
    <path id="pg-wave" d="M20 85 L680 85" fill="none" stroke="#9ef2df" stroke-width="1.7" filter="url(#ss-glow)"/>
    <line id="pg-head" x1="20" y1="18" x2="20" y2="152" stroke="rgba(234,255,249,0.6)" stroke-width="1.2" opacity="0"/>
  </svg>`;

/* ------------------------------------------------------------------ content */

export const SOUNDSCAPE_TAB_HTML = `
  <section>
    <p class="bts-lede">Stand still in the Botanical Garden for a moment. Underneath the wind there are
    birds — not one loop of birds, but a whole morning of them: a warble here, a sparrow answering from
    somewhere off to your left, a dove further out, the wash of leaves rising and falling with a gust you
    can also see moving through the grass. Walk north into the Presidio and it turns coastal and windy,
    gulls and crows over the cypress. Cross the bridge into the Marin headlands and it thins out and goes
    wild — a red-tailed hawk somewhere overhead, quail in the scrub, a great deal of golden-hill wind and
    sky. None of it is a recording of those places. It's an engine, building the sound of a place in real
    time, the same way the city itself is built from data rather than modelled by hand. This chapter is
    the whole trick pulled apart — and, because it's a chapter about sound, a couple of the diagrams
    actually make some. Best read slowly, ideally with the game playing behind it.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌿</span> A soundscape that isn't a loop</h3>
    <p>The easy way to make an area sound alive is to loop a field recording. It works for about ninety
    seconds, and then your ear finds the seam — the same bird in the same place, the same little cough in
    the wind — and it never un-hears it. The whole design here is a reaction to that. There is a bed of
    recordings doing the heavy lifting of <em>body</em> — the general wash of a forest, a meadow, a
    cricket-field at night — but everything in the foreground, every individual call, is
    <strong>synthesised on the spot</strong> from oscillators and filtered noise, with every note
    randomised inside a species' range. No two birdsongs are ever byte-for-byte the same, so there's no
    seam to find. You could leave it running for an hour with your tea and it would never repeat itself.</p>
    <p>That idea — <em>make</em> the sound rather than replay it — is older than games, older than
    computers doing it in real time. It's worth a minute on where it comes from, because the birds here
    are the tail end of a very long lineage.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🎹</span> Four ways to fake an instrument</h3>
    <p>Every synthesiser ever built is really one of a handful of answers to a single question: how do you
    conjure a convincing sound from numbers alone? There are four great families, each roughly a
    generation apart, and this engine borrows from all of them. Click through them — each one plays a
    one-second taste of itself.</p>
    <div class="ss-interactive" data-toy="methods">
      <div class="ss-toy-head"><span class="ss-toy-ic">🎛️</span>Synthesis, the short tour
        <span class="ss-toy-hint">click a name to hear it</span></div>
      <div class="ss-tabrow" data-mtrow>
        <button class="ss-mtab active" type="button" data-m="additive">Additive</button>
        <button class="ss-mtab" type="button" data-m="subtractive">Subtractive</button>
        <button class="ss-mtab" type="button" data-m="fm">FM</button>
        <button class="ss-mtab" type="button" data-m="physical">Karplus–Strong</button>
      </div>
      ${DIAGRAM_METHODS}
      <p class="ss-mtinfo" data-mtinfo></p>
      <div class="ss-toy-actions">
        <button class="ss-btn ss-btn-primary" type="button" data-mtplay>▶ Hear it</button>
      </div>
    </div>
    <p>Our birds are mostly <strong>subtractive and additive</strong>, with a pinch of FM for sparkle: a
    triangle wave (bright, but softer than a square) for the body, a second higher voice stacked on top —
    real birds have a two-sided vocal organ, the <em>syrinx</em>, and can genuinely sing two notes at
    once — a whiff of frequency-modulation glint, and filtered noise for the breathy edge. The wind is
    pure subtractive: noise, shaped by filters, exactly the Moog recipe. Nothing here is new. It's just
    all happening live, in a browser tab, on a hillside that doesn't exist.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌐</span> …and all of it, in a tab</h3>
    <p>The reason any of this can happen while you walk is the <strong>Web Audio API</strong> — the piece
    of the browser, standardised around 2011, that turned every laptop into a modular synth. It hands you
    oscillators, filters, delays, a master limiter, and — crucially for a world you move through — a 3-D
    <em>panner</em> with a proper head-related model, so a sound can genuinely come from behind your left
    shoulder. Twenty years ago this was a rack of hardware; now it's a few dozen lines of code that ship
    with the page. Everything below is built out of those same lego bricks.</p>
  </section>

  <div class="scrolly" data-diagram="arch">
    <div class="scrolly-graphic">
      ${DIAGRAM_ARCH}
    </div>
    <div class="scrolly-steps">
      <div class="scrolly-step"><p><strong>The world knows where its wild places are.</strong> Four
      regions — the Botanical Garden, Golden Gate Park, the Presidio, the Marin headlands — are just
      data: a rectangle, a palette of sounds, and a character (how windy, how foggy, how much echo).
      Everything downstream reads that list; adding a fifth place is one more entry.</p></div>

      <div class="scrolly-step"><p><strong>Presence is a soft field, not a fence.</strong> As you move,
      each region reports how <em>present</em> it is — one right in the middle, fading smoothly to zero
      over its last hundred-odd metres. Where regions overlap, like the garden tucked inside the broader
      park, the denser one leads the mix, so the garden stays lush instead of turning into generic
      park.</p></div>

      <div class="scrolly-step"><p><strong>The bed layer carries the body.</strong> Four looped field
      recordings — forest birds, meadow wind, canopy wind, night crickets — share a single pool of
      players. Their levels are a weighted blend of whichever regions you're standing in, so the same
      four recordings become a garden, a windswept ridge, or a night meadow depending on where you
      are.</p></div>

      <div class="scrolly-step"><p><strong>Then the living layers stack on top.</strong> A procedural
      wind synth — pink noise pushed through two filters — rises and falls locked to the very same gust
      value the grass sways to, so what you hear and what you see are the same weather. And a scheduler
      sprinkles individual animal calls into the space around you, chosen from that region's
      palette.</p></div>

      <div class="scrolly-step"><p><strong>It all pours into one small graph.</strong> Beds, wind and
      calls meet at a master bus, through a gentle limiter, out to your speakers — with a reverb send for
      the open-canyon echo of Marin. Walk back into the city and every region reports zero, the master
      fades, and the whole audio context <em>suspends itself</em>: silent, and free.</p></div>
    </div>
  </div>

  <section>
    <h3><span class="bts-ic">🎛️</span> One context, kept honest</h3>
    <p>There's a quiet engineering reason the whole thing lives in a single audio graph. A browser only
    hands out a handful of audio contexts before it starts refusing, and this game already spends several
    of them — the vehicle hum, the fireworks, the park dogs, proximity voice chat. So the nature engine
    deliberately does <em>not</em> spin up its own listener rig; it borrows one <code>AudioContext</code>,
    routes everything through one master bus and one soft limiter, and — crucially — parks the entire
    context the moment you leave every nature region. Out on Market Street it costs nothing at all. Step
    back onto a park lawn and it wakes, ramps its presence up over a second or two, and the birds return.
    Efficiency here isn't a nice-to-have; it's the thing that lets the soundscape exist at all without
    stealing frames from the renderer. (The little toys in this chapter play by the same rule — they open
    their own context on your first click, and close it again the moment you leave this tab.)</p>
  </section>

  <section>
    <h3><span class="bts-ic">🐦</span> The anatomy of a single call</h3>
    <p>The recordings are the wash; the synthesised calls are the life. Each one is a tiny piece of
    additive synthesis assembled a few milliseconds before you hear it — an oscillator or two, a filtered
    burst of noise for the breathy edge, an envelope to give it a shape. What turns a beep into a bird is
    entirely in the details, and the details are all randomised. Scroll through one being built.</p>
  </section>

  <div class="scrolly" data-diagram="song">
    <div class="scrolly-graphic">
      ${DIAGRAM_SONG}
    </div>
    <div class="scrolly-steps">
      <div class="scrolly-step"><p><strong>It starts as a single tone.</strong> An oscillator at a few
      thousand hertz — a triangle wave, usually, softer than a square. On its own it's a test tone, the
      least bird-like thing imaginable. Everything after this is about hiding that fact.</p></div>

      <div class="scrolly-step"><p><strong>Give it a glide and a wobble.</strong> Slide the pitch up or
      down across the length of the note and add a little vibrato, and the tone stops sounding electronic.
      Birds almost never hold a steady pitch; that fast bend is most of what your ear reads as
      "alive".</p></div>

      <div class="scrolly-step"><p><strong>Shape it with an envelope.</strong> A quick attack and an
      exponential decay wrap the note in a body — the difference between a click and a chirp. A dab of
      frequency-modulation sparkle rides on top, the glint on a songbird's voice.</p></div>

      <div class="scrolly-step"><p><strong>String a few into a phrase.</strong> Three to six of these
      notes, each one randomly walking away from the last in pitch and spacing, become a little song. New
      numbers every time — so the bird is recognisably the same <em>species</em>, and never sings the
      same <em>song</em> twice.</p></div>

      <div class="scrolly-step"><p><strong>Put it somewhere, and let it be answered.</strong> The call is
      placed at a random bearing and distance around you through a 3-D panner, so it comes from a real
      direction in the world. And now and then a second bird answers it a beat later from a different
      direction — the oldest trick in the dawn-chorus book.</p></div>
    </div>
  </div>

  <section>
    <h3><span class="bts-ic">🎚️</span> Build a bird</h3>
    <p>Reading about it only gets you so far — here's the actual recipe, wired to buttons. Each toggle is
    one of the steps from the diagram above; flip them on and off and watch the waveform change, then hit
    <strong>Hear a bird</strong>. Turn the answer on and the reply lands from the other side of the
    stereo field, exactly as the 3-D panner would place it in the world. Every press is a fresh song;
    <em>New bird</em> rolls a new set of random numbers underneath.</p>
    <div class="ss-interactive" data-toy="bird">
      <div class="ss-toy-head"><span class="ss-toy-ic">🐦</span>Your bird
        <span class="ss-toy-hint" data-pgread>triangle + envelope + glide</span></div>
      ${DIAGRAM_BIRD}
      <div class="ss-controls" data-pgopts>
        <button class="ss-btn active" type="button" data-opt="glide">glide</button>
        <button class="ss-btn active" type="button" data-opt="vibrato">vibrato</button>
        <button class="ss-btn active" type="button" data-opt="envelope">envelope</button>
        <button class="ss-btn" type="button" data-opt="harmonic">2nd voice</button>
        <button class="ss-btn" type="button" data-opt="echo">answer</button>
      </div>
      <div class="ss-toy-actions">
        <button class="ss-btn ss-btn-primary" type="button" data-pgplay>▶ Hear a bird</button>
        <button class="ss-btn ss-btn-ghost" type="button" data-pgnew>🎲 New bird</button>
      </div>
    </div>
    <p class="bts-aside">Strip it all the way back — every toggle off — and you get the bare test tone the
    real synth starts from: a flat, buzzy triangle. Every switch you add is one more thing standing
    between that beep and something your ear is willing to believe is alive.</p>
  </section>

  <section>
    <h3><span class="bts-ic">🌅</span> The day breathes</h3>
    <p>A soundscape that sounds identical at 3am and at noon is only half-built, so the whole thing is
    wired to the same sky clock that colours the light. The rate of calls follows the day: it swells into
    a <strong>dawn chorus</strong> around sunrise, eases through the afternoon, lifts a little at dusk, and
    drops to a sparse night. The palette turns over with it — songbirds and sparrows give way to owls,
    frogs and the tight chirp of a single close cricket — and the recorded beds crossfade underneath, the
    forest-birds recording bowing out as the cricket-field comes up. There's weather in it too: when a
    gust picks up, the birds shelter and call less, and the wind synth swells to fill the gap, exactly as
    a real hillside goes quiet in a strong wind. Drag the marker across a full day and watch the mix
    turn over — or leave it on <em>Auto</em> and let the day pass on its own.</p>
    <div class="bts-daygraphic">${DIAGRAM_DAY}</div>
    <div class="ss-daybar">
      <input type="range" class="ss-slider" data-dayslider min="0" max="24" step="0.05" value="6.3" aria-label="Time of day">
      <button class="ss-btn ss-btn-ghost" type="button" data-dayauto>▶ Auto</button>
      <span class="ss-readout" data-dayread></span>
    </div>
  </section>

  <section>
    <h3><span class="bts-ic">🧩</span> Built to be extended</h3>
    <p>Everything above is generic. The engine doesn't know what the Botanical Garden is; it knows how to
    read a list of regions and blend between them. So the interesting part, for anyone who wants to add a
    new wild place later, is how little it takes: one entry in a list — a footprint, a mix of the four
    beds, a day and a night palette of calls, and three numbers for character (wind, fog, echo). The
    footprints even borrow the same bounds the trees and grass are planted from, so the sound of a place
    can never drift out of sync with the look of it. A future redwood grove, a marsh, a rooftop garden:
    each is a paragraph of data, and the engine does the rest.</p>
    <p class="bts-aside">The recordings are public-domain field recordings (Joseph SARDIN / LaSonotheque);
    everything else — the wind, every bird, the owl, the frog, the far-off foghorn on a Marin night — is
    made of nothing but oscillators and noise, decided fresh each time. It stands on the shoulders of a
    lot of people who worked out how to fake a sound: Fourier and the Hammond organ, Bob Moog's filters,
    John Chowning's FM, Karplus and Strong's plucked string, and the browser engineers who put all of it
    behind a few lines of JavaScript. Sit with it a while. It's trying, in its small way, to be a place
    rather than a track.</p>
  </section>
`;

/* ------------------------------------------------------------- controller */

type ScrollyState = { el: HTMLElement; steps: HTMLElement[]; kind: string; svg: SVGSVGElement | null };

// info blurbs for the synthesis explorer — who found it, and when
const METHOD_INFO: Record<string, string> = {
  additive:
    "<strong>Additive</strong> — stack pure sine tones until they add up to a timbre. The oldest idea in the book (Fourier, 1822); Hammond's 1935 organ built every note this way, from spinning tonewheels.",
  subtractive:
    "<strong>Subtractive</strong> — start with a bright, buzzy wave and <em>carve</em> it down with filters. The sound of the Moog and the whole analog era. The wind in this world is made exactly this way: noise, filtered.",
  fm: "<strong>FM</strong> — wobble one oscillator's pitch with another and the maths turns metallic and complex for almost nothing. John Chowning found it at Stanford around 1967; Yamaha's DX7 (1983) sold it to the planet.",
  physical:
    "<strong>Karplus–Strong</strong> — pluck a string with a burst of noise recirculated through a tiny delay. Published in 1983, it was the seed of physical modelling — and it really does sound plucked."
};

export function mountSoundscape(pane: HTMLElement, scrollEl: HTMLElement) {
  const scrollies: ScrollyState[] = [...pane.querySelectorAll<HTMLElement>(".scrolly")].map((el) => ({
    el,
    steps: [...el.querySelectorAll<HTMLElement>(".scrolly-step")],
    kind: el.dataset.diagram ?? "",
    svg: el.querySelector<SVGSVGElement>("svg")
  }));
  const daySvg = pane.querySelector<SVGSVGElement>(".bts-daygraphic svg");

  /* -------- interactive: day scrubber -------- */
  let dayManual: number | null = null;
  const daySlider = pane.querySelector<HTMLInputElement>("[data-dayslider]");
  const dayRead = pane.querySelector<HTMLElement>("[data-dayread]");
  const dayAuto = pane.querySelector<HTMLButtonElement>("[data-dayauto]");
  daySlider?.addEventListener("input", () => {
    dayManual = parseFloat(daySlider.value);
    dayAuto?.classList.remove("active");
  });
  dayAuto?.addEventListener("click", () => {
    dayManual = null;
    dayAuto.classList.add("active");
  });

  /* -------- interactive: synthesis explorer -------- */
  const mtSvg = pane.querySelector<SVGSVGElement>('[data-toy="methods"] .ss-toysvg');
  const mtInfo = pane.querySelector<HTMLElement>("[data-mtinfo]");
  let mtKind = "additive";
  let mtPlay: { start: number; total: number } | null = null;
  const drawMethod = () => {
    if (!mtSvg) return;
    const clip = synthMethod(mtKind);
    setAttr(mtSvg, "mt-wave", "d", wavePath(clip.samples, 20, 680, 65, 44));
    if (mtInfo) mtInfo.innerHTML = METHOD_INFO[mtKind];
  };
  for (const tab of pane.querySelectorAll<HTMLButtonElement>("[data-mtrow] .ss-mtab")) {
    tab.addEventListener("click", () => {
      mtKind = tab.dataset.m ?? "additive";
      for (const t of pane.querySelectorAll<HTMLButtonElement>("[data-mtrow] .ss-mtab")) t.classList.toggle("active", t === tab);
      drawMethod();
    });
  }
  pane.querySelector<HTMLButtonElement>("[data-mtplay]")?.addEventListener("click", () => {
    const clip = synthMethod(mtKind);
    setAttr(mtSvg!, "mt-wave", "d", wavePath(clip.samples, 20, 680, 65, 44));
    playChannels([clip.samples]);
    mtPlay = { start: performance.now(), total: clip.total };
  });
  drawMethod();

  /* -------- interactive: build-a-bird playground -------- */
  const pgSvg = pane.querySelector<SVGSVGElement>('[data-toy="bird"] .ss-toysvg');
  const pgRead = pane.querySelector<HTMLElement>("[data-pgread]");
  const birdOpts: BirdOpts = { notes: 4, glide: true, vibrato: true, envelope: true, harmonic: false, echo: false };
  let birdSeed = (Math.random() * 1e9) | 0;
  let pgPlay: { start: number; total: number } | null = null;
  const pgLabel = () => {
    const on: string[] = ["triangle"];
    if (birdOpts.envelope) on.push("envelope");
    if (birdOpts.glide) on.push("glide");
    if (birdOpts.vibrato) on.push("vibrato");
    if (birdOpts.harmonic) on.push("2 voices");
    if (birdOpts.echo) on.push("answer");
    return on.join(" + ");
  };
  const drawBird = () => {
    if (!pgSvg) return;
    const clip = synthBird(birdOpts, birdSeed);
    const mix = new Float32Array(clip.L.length);
    for (let i = 0; i < mix.length; i++) mix[i] = (clip.L[i] + clip.R[i]) * 0.5;
    setAttr(pgSvg, "pg-wave", "d", wavePath(mix, 20, 680, 85, 62));
    if (pgRead) pgRead.textContent = pgLabel();
  };
  for (const b of pane.querySelectorAll<HTMLButtonElement>("[data-pgopts] .ss-btn")) {
    b.addEventListener("click", () => {
      const k = b.dataset.opt as BirdBoolKey;
      birdOpts[k] = !birdOpts[k];
      b.classList.toggle("active", birdOpts[k]);
      drawBird();
    });
  }
  pane.querySelector<HTMLButtonElement>("[data-pgnew]")?.addEventListener("click", () => {
    birdSeed = (Math.random() * 1e9) | 0;
    drawBird();
  });
  pane.querySelector<HTMLButtonElement>("[data-pgplay]")?.addEventListener("click", () => {
    const clip = synthBird(birdOpts, birdSeed);
    const mix = new Float32Array(clip.L.length);
    for (let i = 0; i < mix.length; i++) mix[i] = (clip.L[i] + clip.R[i]) * 0.5;
    setAttr(pgSvg!, "pg-wave", "d", wavePath(mix, 20, 680, 85, 62));
    playChannels([clip.L, clip.R]);
    pgPlay = { start: performance.now(), total: clip.total };
  });
  drawBird();

  let raf = 0;
  let t0 = performance.now();
  let running = false;

  // sweep a playhead across a toy's waveform while its clip plays
  function playhead(svg: SVGSVGElement | null, id: string, x0: number, x1: number, st: { start: number; total: number } | null, nowMs: number): { start: number; total: number } | null {
    if (!svg) return st;
    if (!st) {
      setOpacity(svg, id, 0);
      return null;
    }
    const p = (nowMs - st.start) / (st.total * 1000);
    if (p >= 1) {
      setOpacity(svg, id, 0);
      return null;
    }
    setAttr(svg, id, "x1", lerp(x0, x1, p));
    setAttr(svg, id, "x2", lerp(x0, x1, p));
    setOpacity(svg, id, 0.7);
    return st;
  }

  // for each scrolly, work out the active step + fractional progress from the
  // scroll positions, tag the active step, and hand (stage, p, t) to its diagram
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
      if (!s.svg) continue;
      if (s.kind === "arch") renderArch(s.svg, stage, p, t);
      else if (s.kind === "song") renderSong(s.svg, stage, p, t);
    }
    if (daySvg) {
      const hour = dayManual ?? (t * (24 / 48)) % 24;
      renderDay(daySvg, hour);
      if (dayRead) {
        const d = timeDensity(hour);
        const label = hour < 5 || hour >= 20 ? "night" : hour < 8 ? "dawn chorus" : hour < 17 ? "midday" : "dusk";
        dayRead.textContent = `${fmtHour(hour)} · ${label} · calls ${d < 0.9 ? "sparse" : d < 1.6 ? "steady" : "peak"}`;
      }
    }
    // toy playheads
    const now = performance.now();
    mtPlay = playhead(mtSvg, "mt-head", 20, 680, mtPlay, now);
    pgPlay = playhead(pgSvg, "pg-head", 20, 680, pgPlay, now);
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
      // release the audio slot — the toys re-open a context on the next click
      if (actx && actx.state !== "closed") void actx.close();
      actx = null;
    }
  };
}

/* -------------------------------------------------------- diagram painters */

function setOpacity(svg: SVGSVGElement, id: string, v: number) {
  const el = svg.getElementById(id) as SVGElement | null;
  if (el) el.style.opacity = String(clamp(v));
}
function setAttr(svg: SVGSVGElement, id: string, name: string, v: string | number) {
  const el = svg.getElementById(id) as SVGElement | null;
  if (el) el.setAttribute(name, String(v));
}

// Diagram 1 — regions → layers → bus. Groups cross-fade as the story advances.
function renderArch(svg: SVGSVGElement, stage: number, p: number, t: number) {
  const f = stage + p; // 0..4 continuous
  setOpacity(svg, "ss-map", atStage([1, 1, 0.9, 0.62, 0.4], f));
  setOpacity(svg, "ss-ring", atStage([0, 0.95, 0.55, 0.25, 0.12], f));
  setOpacity(svg, "ss-beds", atStage([0, 0.05, 1, 1, 0.85], f));
  setOpacity(svg, "ss-wind", atStage([0, 0, 0.3, 1, 0.85], f));
  setOpacity(svg, "ss-voices", atStage([0, 0, 0.1, 1, 0.85], f));
  setOpacity(svg, "ss-chain", atStage([0, 0, 0, 0.35, 1], f));
  setOpacity(svg, "ss-arrows", atStage([0, 0.2, 0.7, 1, 1], f));

  // the "you" dot drifts from the city into the garden as presence rises (0→1)
  const t01 = clamp(f);
  setAttr(svg, "ss-you", "cx", lerp(210, 120, t01));
  setAttr(svg, "ss-you", "cy", lerp(250, 150, t01));
  setAttr(svg, "ss-you", "fill", t01 > 0.5 ? "#7fe0cd" : "#8fa9b6");
  const ring = 6 + 22 * (0.5 + 0.5 * Math.sin(t * 2)) * clamp(atStage([0, 1, 0.6, 0.2, 0], f));
  setAttr(svg, "ss-ring", "r", ring);
  setAttr(svg, "ss-ring", "cx", lerp(210, 120, t01));
  setAttr(svg, "ss-ring", "cy", lerp(250, 150, t01));

  // bed level bars gently breathe so the layers feel live
  const beds = ["ss-bed0", "ss-bed1", "ss-bed2", "ss-bed3"];
  for (let i = 0; i < beds.length; i++) {
    const h = 8 + 20 * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 1.9));
    setAttr(svg, beds[i], "height", h);
    setAttr(svg, beds[i], "y", 96 - h);
  }
  // voice sparks orbit the voices row
  for (let i = 0; i < 4; i++) {
    const a = t * 0.9 + (i * Math.PI) / 2;
    setAttr(svg, `ss-spark${i}`, "cx", 430 + Math.cos(a) * 34);
    setAttr(svg, `ss-spark${i}`, "cy", 232 + Math.sin(a) * 13);
    setAttr(svg, `ss-spark${i}`, "r", 2.2 + 1.6 * (0.5 + 0.5 * Math.sin(t * 3 + i)));
  }
  // pulse the signal flow down the chain
  const flow = (t * 0.4) % 1;
  setAttr(svg, "ss-pulse", "cx", lerp(600, 792, flow));
  setOpacity(svg, "ss-pulse", atStage([0, 0, 0, 0.4, 1], f) * (0.4 + 0.6 * Math.sin(flow * Math.PI)));
}

// Diagram 2 — one call being built: living waveform, then a spatial plan view.
function renderSong(svg: SVGSVGElement, stage: number, p: number, t: number) {
  const f = stage + p;
  const graph = clamp(atStage([1, 1, 1, 1, 0], f)); // graph fades out at stage 4
  const plan = clamp(atStage([0, 0, 0, 0.2, 1], f));
  setOpacity(svg, "ss-graph", graph);
  setOpacity(svg, "ss-plan", plan);

  // living waveform: amplitude from the envelope stage, pitch bend + vibrato from stage 1+
  const x0 = 60;
  const x1 = 600;
  const midY = 150;
  const N = 120;
  const bend = clamp(atStage([0, 1, 1, 1, 1], f)); // pitch glide amount
  const vib = clamp(atStage([0, 1, 1, 1, 1], f)); // vibrato amount
  const envOn = clamp(atStage([0, 0, 1, 1, 1], f)); // envelope shaping
  let d = "";
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const x = lerp(x0, x1, u);
    const freq = lerp(22, 34, bend * u) + Math.sin(t * 6 + u * 40) * 2 * vib;
    // amplitude: flat, or an attack-decay envelope once "shaped"
    const env = envOn ? Math.pow(Math.min(1, u * 6), 1) * Math.pow(1 - u, 1.1) * 2.2 : 0.7;
    const amp = 30 * lerp(0.7, env, envOn);
    const y = midY - Math.sin(u * freq + t * 7) * amp;
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
  }
  setAttr(svg, "ss-wave", "d", d.trim());

  // envelope guide curve appears at stage 2
  setOpacity(svg, "ss-env", clamp(atStage([0, 0, 0.9, 0.5, 0], f)));
  // pitch contour hint at stage 1
  setOpacity(svg, "ss-pitch", clamp(atStage([0, 0.9, 0.4, 0.2, 0], f)));
  // note blocks of the phrase at stage 3
  const notesOn = clamp(atStage([0, 0, 0, 1, 0], f));
  for (let i = 0; i < 5; i++) {
    setOpacity(svg, `ss-note${i}`, notesOn * (i < 3 + Math.floor(p * 3) ? 1 : 0.15));
  }

  // plan view: a caller spark + an answering spark from another bearing
  if (plan > 0.01) {
    const a1 = 0.6 + Math.sin(t * 0.6) * 0.2;
    setAttr(svg, "ss-caller", "cx", 410 + Math.cos(a1) * 90);
    setAttr(svg, "ss-caller", "cy", 150 + Math.sin(a1) * 48);
    setAttr(svg, "ss-caller", "r", 4 + 2 * (0.5 + 0.5 * Math.sin(t * 4)));
    const answered = stage >= 4 ? clamp((t % 3) - 0.6) : 0; // periodic reply
    setOpacity(svg, "ss-answer", answered);
    const a2 = a1 + Math.PI * 0.8;
    setAttr(svg, "ss-answer", "cx", 410 + Math.cos(a2) * 78);
    setAttr(svg, "ss-answer", "cy", 150 + Math.sin(a2) * 42);
  }
}

// Diagram 3 — a full day passing: sun/moon arc, call-density curve, and the
// bird↔cricket crossfade underneath. Driven either by the idle clock or the
// hand-dragged scrubber (see the controller).
function renderDay(svg: SVGSVGElement, hour: number) {
  const dayNow = daylight(hour);
  const x0 = 60;
  const x1 = 760;
  const x = lerp(x0, x1, hour / 24);
  // sun rides a high arc by day, moon a lower one by night
  const sunY = 150 - Math.sin(clamp((hour - 6) / 12) * Math.PI) * 96;
  setAttr(svg, "ss-sun", "cx", x);
  setAttr(svg, "ss-sun", "cy", sunY);
  setOpacity(svg, "ss-sun", dayNow);
  const moonY = 150 - Math.sin(clamp((((hour + 12) % 24) - 6) / 12) * Math.PI) * 70;
  const moonX = lerp(x0, x1, ((hour + 12) % 24) / 24);
  setAttr(svg, "ss-moon", "cx", moonX);
  setAttr(svg, "ss-moon", "cy", moonY);
  setOpacity(svg, "ss-moon", 1 - dayNow);
  // the "now" marker sweeping the density curve
  setAttr(svg, "ss-now", "x1", x);
  setAttr(svg, "ss-now", "x2", x);
  setAttr(svg, "ss-nowdot", "cx", x);
  setAttr(svg, "ss-nowdot", "cy", densityY(hour));
  // bird vs cricket crossfade bars
  setAttr(svg, "ss-birds", "height", 6 + 40 * dayNow);
  setAttr(svg, "ss-birds", "y", 250 - (6 + 40 * dayNow));
  setAttr(svg, "ss-crickets", "height", 6 + 40 * (1 - dayNow));
  setAttr(svg, "ss-crickets", "y", 250 - (6 + 40 * (1 - dayNow)));
  // sky wash tint
  setOpacity(svg, "ss-daywash", dayNow * 0.5);
}

/* day model, mirrored from the audio engine so the picture matches the sound */
function daylight(h: number): number {
  const up = smooth(5.2, 7.2, h);
  const down = 1 - smooth(18.5, 20.5, h);
  return up * down;
}
function timeDensity(h: number): number {
  const day = daylight(h);
  const dawn = Math.max(0, 1 - Math.abs(h - 6.3) / 1.8);
  const dusk = Math.max(0, 1 - Math.abs(h - 19) / 1.3) * 0.5;
  return (0.45 + 0.55 * day) * (1 + 1.4 * dawn + dusk);
}
function densityY(h: number): number {
  // curve baseline y=200, peak reduces y; normalise density ~0.45..~2.6
  const d = timeDensity(h);
  return 200 - clamp((d - 0.4) / 2.4) * 78;
}
function smooth(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}
function fmtHour(h: number): string {
  const hh = Math.floor(h) % 24;
  const mm = Math.floor((h - Math.floor(h)) * 60);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Precompute the density curve path for the day diagram (static shape). */
function dayCurvePath(): string {
  let d = "";
  for (let i = 0; i <= 96; i++) {
    const h = (i / 96) * 24;
    const x = 60 + (700 * h) / 24;
    d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + densityY(h).toFixed(1) + " ";
  }
  return d.trim();
}
