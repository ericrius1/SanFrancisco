// Real-browser contract for the voice-chat receive chain's gain staging
// (src/net/voice.ts #wireAudio).
//
// A DynamicsCompressorNode has no makeup stage, so a leveler there can only ever
// take level away; VOICE_BOOST has to pay it back. When the two disagree the
// whole conversation quietly gets turned down, which is what the -30/6:1 +
// 1.35x pairing used to do (~5 dB of loss end to end on ordinary speech).
//
// Two real peers on a live call. The probe walks the app's own audio graph —
// patching RTCPeerConnection and AudioNode.prototype.connect from an init
// script, so nothing test-only lives in the app — and records every stage:
//   source -> compressor -> peer gain -> voice group
// Pass = a talker leaves the chain at roughly the loudness they arrived at, and
// the leveler is working the peaks rather than sitting on the whole signal.
//
//   SF_PROBE_URL=http://localhost:5240 node tools/voice-gain-staging-probe.mjs
//
// The test signal has to be speech-like — a low fundamental and a real syllable
// envelope — because Chrome's built-in fake capture device is a full-scale tone
// and tells you nothing useful about a compressor meant for voices. One is
// synthesised below; SF_FAKE_WAV overrides it with a real recording.

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const BASE_URL = process.env.SF_PROBE_URL ?? "http://localhost:5240";
const RECORD_MS = Number(process.env.SF_RECORD_MS ?? 8000);

/**
 * A glottal pulse train through three formant resonators with a syllable
 * envelope. Not intelligible, but it has the two properties that matter here:
 * a fundamental low enough to expose a compressor tracking the waveform rather
 * than the envelope, and a crest factor in the range real speech occupies.
 */
function synthesiseSpeechWav(path) {
  const SR = 48000;
  const n = SR * 12;
  const out = new Float64Array(n);
  const reson = (freq, bw) => {
    const r = Math.exp((-Math.PI * bw) / SR);
    const theta = (2 * Math.PI * freq) / SR;
    const a1 = 2 * r * Math.cos(theta);
    const a2 = -r * r;
    const g = (1 - r) * Math.sqrt(1 - 2 * r * Math.cos(2 * theta) + r * r);
    let y1 = 0;
    let y2 = 0;
    return (x) => {
      const y = g * x + a1 * y1 + a2 * y2;
      y2 = y1;
      y1 = y;
      return y;
    };
  };
  const formants = [[520, 70], [1480, 110], [2560, 160]].map(([f, b]) => reson(f, b));
  const weights = [1, 0.55, 0.28];
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const syl = (t * 3.7) % 1;
    const voiced = Math.floor(t / 1.6) % 4 !== 3; // a silent beat every fourth
    let env = 0;
    if (voiced) {
      if (syl < 0.08) env = syl / 0.08;
      else if (syl < 0.62) env = 1 - 0.35 * Math.sin((syl - 0.08) * 9);
      else if (syl < 0.78) env = (0.78 - syl) / 0.16;
    }
    env = Math.max(0, env);
    const f0 = 112 + 9 * Math.sin(t * 1.9) - 6 * (t % 1.6);
    phase = (phase + f0 / SR) % 1;
    let src = 0;
    for (let h = 1; h <= Math.min(Math.floor(SR / 2 / f0), 40); h++) {
      src += Math.sin(2 * Math.PI * phase * h) / (h * h);
    }
    let y = 0;
    for (let k = 0; k < formants.length; k++) y += weights[k] * formants[k](src);
    out[i] = (y + 0.006 * (Math.random() * 2 - 1) * env) * env;
  }
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]));
  const scale = 0.72 / peak; // where a browser AGC tends to land

  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(SR, 24);
  b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * scale * 32767))), 44 + i * 2);
  }
  writeFileSync(path, b);
  return path;
}

const WAV = process.env.SF_FAKE_WAV ?? synthesiseSpeechWav(join(tmpdir(), "sf-voice-probe-speech.wav"));

const chrome = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
].find((c) => c && existsSync(c));
if (!chrome) throw new Error("Chrome not found; set CHROME_BIN");

const INIT = () => {
  const P = { pcs: [], sources: [], compressors: [], edges: [] };
  window.__probe = P;
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = class extends OrigPC {
    constructor(...a) {
      super(...a);
      P.pcs.push(this);
    }
  };
  const origSrc = AudioContext.prototype.createMediaStreamSource;
  AudioContext.prototype.createMediaStreamSource = function (stream) {
    const node = origSrc.call(this, stream);
    P.sources.push({ node, ctx: this, stream });
    return node;
  };
  const OrigDC = window.DynamicsCompressorNode;
  window.DynamicsCompressorNode = class extends OrigDC {
    constructor(ctx, opts) {
      super(ctx, opts);
      P.compressors.push(this);
    }
  };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (dest, ...rest) {
    P.edges.push({ from: this, to: dest });
    return origConnect.call(this, dest, ...rest);
  };
};

const WORKLET = `
class Rec extends AudioWorkletProcessor {
  constructor(o){ super(); this.max=o.processorOptions.maxFrames; this.buf=new Float32Array(this.max); this.n=0; this.sent=false; }
  process(inputs){
    if (this.n >= this.max) { if (!this.sent){ this.sent=true; this.port.postMessage({done:true, pcm:this.buf.slice(0,this.n)}); } return true; }
    const ch = inputs[0] && inputs[0][0];
    const take = Math.min(128, this.max - this.n);
    if (ch) this.buf.set(ch.subarray(0, take), this.n);
    this.n += take;
    return true;
  }
}
registerProcessor('rec', Rec);
`;

const args = [
  "--enable-unsafe-webgpu",
  "--enable-features=WebGPUDeveloperFeatures",
  "--use-angle=metal",
  "--autoplay-policy=no-user-gesture-required",
  "--use-fake-device-for-media-stream",
  "--use-fake-ui-for-media-stream"
];
if (WAV) args.push(`--use-file-for-fake-audio-capture=${WAV}`);

const browser = await chromium.launch({ executablePath: chrome, headless: true, args });

async function openPage(bctx, label) {
  const page = await bctx.newPage({ viewport: { width: 900, height: 600 } });
  await page.addInitScript(INIT);
  page.on("pageerror", (e) => console.log(`[${label}] pageerror`, e.message));
  await page.goto(`${BASE_URL}/?autostart=1`, { waitUntil: "domcontentloaded", timeout: 180_000 });
  await page.waitForFunction(() => window.__sf?.voice, null, { timeout: 180_000 });
  return page;
}

const ctxA = await browser.newContext({ permissions: ["microphone"] });
const ctxB = await browser.newContext({ permissions: ["microphone"] });

try {
  const [a, b] = await Promise.all([openPage(ctxA, "A"), openPage(ctxB, "B")]);
  await b.evaluate(() => window.__sf.voice.setMic(true));
  // A stays silent: with its own mic off the open-mic duck is out of the way,
  // so this measures the receive chain alone. It still needs the engine gate
  // open, which a listen-only player would get from their first input.
  await a.evaluate(() => window.__sf.audioEngine.unlock());
  await a.waitForFunction(() => window.__sf.voice.debugState().peers.some((p) => p.hasAudio), null, {
    timeout: 90_000
  });
  await a.waitForTimeout(3000);

  const result = await a.evaluate(
    async ({ workletSrc, ms }) => {
      const P = window.__probe;
      // A retried/dropped peer leaves a closed pc and an orphaned source node
      // behind, and those still match a naive search while emitting silence.
      // Take the newest live one at each step.
      const live = P.pcs.filter(
        (c) =>
          c.connectionState === "connected" &&
          c.getReceivers().some((r) => r.track?.kind === "audio" && r.track.readyState === "live")
      );
      const pc = live[live.length - 1];
      if (!pc) return { error: "no connected peer connection" };
      const track = pc.getReceivers().find((r) => r.track?.kind === "audio").track;
      const matches = P.sources.filter((s) =>
        s.stream.getAudioTracks().some((t) => t.id === track.id)
      );
      const appSrc = matches[matches.length - 1];
      if (!appSrc) return { error: "no source node for the remote stream" };
      const ctx = appSrc.ctx;

      const downstream = (n) => P.edges.filter((e) => e.from === n).map((e) => e.to);
      const comp = downstream(appSrc.node).find((n) => n instanceof DynamicsCompressorNode);
      const peerGain = comp ? downstream(comp).find((n) => n instanceof GainNode) : null;
      const groupGain = peerGain ? downstream(peerGain).find((n) => n instanceof GainNode) : null;

      await ctx.audioWorklet.addModule(
        URL.createObjectURL(new Blob([workletSrc], { type: "text/javascript" }))
      );
      const frames = Math.floor((ms / 1000) * ctx.sampleRate);
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sink.connect(ctx.destination);

      const taps = [
        ["source", appSrc.node],
        ["postCompressor", comp],
        ["postGain", peerGain],
        ["postGroup", groupGain]
      ].filter(([, n]) => !!n);

      const jobs = taps.map(([label, node]) => {
        const rec = new AudioWorkletNode(ctx, "rec", {
          processorOptions: { maxFrames: frames },
          numberOfOutputs: 1
        });
        node.connect(rec);
        rec.connect(sink);
        return new Promise((res) => {
          rec.port.onmessage = (e) => {
            if (!e.data.done) return;
            try { node.disconnect(rec); } catch {}
            rec.disconnect();
            res({ label, sampleRate: ctx.sampleRate, pcm: Array.from(e.data.pcm) });
          };
        });
      });

      const reductions = [];
      const timer = setInterval(() => comp && reductions.push(comp.reduction), 16);
      const recordings = await Promise.all(jobs);
      clearInterval(timer);
      sink.disconnect();

      return {
        params: comp && {
          threshold: comp.threshold.value,
          knee: comp.knee.value,
          ratio: comp.ratio.value,
          attack: +comp.attack.value.toFixed(4),
          release: comp.release.value
        },
        peerGain: peerGain?.gain.value,
        groupGain: groupGain?.gain.value,
        reductions,
        recordings
      };
    },
    { workletSrc: WORKLET, ms: RECORD_MS }
  );

  if (result.error) throw new Error(result.error);

  console.log("compressor:", JSON.stringify(result.params));
  console.log(`peerGain=${result.peerGain?.toFixed(3)} groupGain=${result.groupGain?.toFixed(3)}\n`);

  const stats = {};
  for (const r of result.recordings) {
    let sum = 0;
    let peak = 0;
    let clipped = 0;
    for (const v of r.pcm) {
      sum += v * v;
      const av = Math.abs(v);
      if (av > peak) peak = av;
      if (av >= 0.999) clipped++;
    }
    const s = { rms: Math.sqrt(sum / r.pcm.length), peak, clipped };
    stats[r.label] = s;
    console.log(
      `  ${r.label.padEnd(15)} rms=${s.rms.toFixed(4)} peak=${s.peak.toFixed(3)} clipped=${s.clipped}`
    );
  }

  const active = result.reductions.filter((r) => r < -0.01).sort((x, y) => x - y);
  const medianReduction = active.length ? active[Math.floor(active.length / 2)] : 0;
  const dutyPct = (active.length / Math.max(1, result.reductions.length)) * 100;
  console.log(
    `\n  leveler: median ${medianReduction.toFixed(1)} dB when acting, ` +
      `acting ${dutyPct.toFixed(0)}% of the time`
  );

  const endToEnd = 20 * Math.log10(stats.postGroup.rms / stats.source.rms);
  console.log(`  end to end: ${endToEnd >= 0 ? "+" : ""}${endToEnd.toFixed(1)} dB\n`);

  assert.ok(stats.postGroup, "voice group tap missing — graph shape changed");
  assert.ok(
    endToEnd > -3 && endToEnd < 3,
    `a talker should leave the chain near the loudness they arrived at; got ${endToEnd.toFixed(1)} dB`
  );
  // The group gain feeds the engine master, which has no limiter — whatever
  // leaves here goes to the device, and several talkers sum on top of it.
  assert.equal(stats.postGroup.clipped, 0, "voice chain is clipping");
  assert.ok(
    stats.postGroup.peak < 0.85,
    `no headroom left for other talkers (peak ${stats.postGroup.peak.toFixed(3)})`
  );
  // Levelling closes the gap between a loud and a quiet talker; squashing pins
  // everyone to the same loudness and then needs a big makeup to be heard.
  assert.ok(
    medianReduction > -10,
    `leveler is squashing, not levelling (median ${medianReduction.toFixed(1)} dB)`
  );
  console.log("voice gain staging probe: PASS");
} finally {
  await browser.close();
}
